// --- Protection contre le bug undici de Node.js 24.x ---
// Bug : TypeError: Cannot assign to read only property 'name' of object
//   'Error: socket idle timeout'. Se produit quand une connexion HTTP (fetch
//   vers l'API GitHub lors de la soumission communautaire) reste idle et qu'
//   undici déclenche son timeout interne. Sans cette interception, le serveur
//   interactif crash → le navigateur affiche "Failed to fetch" dans la modale
//   "Envoyer à la communauté" et la soumission devient impossible.
// Même protection que runner.js (ligne 11) : on log et on ignore l'erreur
// undici spécifique. Le fetch concerné a déjà aborté et son catch prend le
// relais (la soumission échoue proprement sur ce modèle, les autres continuent).
process.on('uncaughtException', (err) => {
  if (err && /Cannot assign to read only property 'name'/.test(err.message)
      && /socket idle timeout|UndiciError|InformationalError/.test(err.stack || '')) {
    logger.warn('[undici] Timeout socket intercepté (bug Node.js 24.x) — continuation du serveur.');
    return;
  }
  logger.error('[ERREUR FATALE non interceptée] ' + (err && err.stack || err));
  process.exit(1);
});

// Rejet de promesse non géré : on log sans crasher (une soumission peut
// rejeter si GitHub coupe la connexion au milieu d'une PR — le serveur doit
// rester debout pour les soumissions suivantes).
process.on('unhandledRejection', (reason) => {
  if (reason && /Cannot assign to read only property 'name'/.test(reason.message || '')
      && /socket idle timeout|UndiciError|InformationalError/.test(reason.stack || '')) {
    logger.warn('[undici] Rejet de promesse intercepté (bug Node.js 24.x) — continuation.');
    return;
  }
  logger.error('[Promesse rejetée non gérée] ' + (reason && (reason.stack || reason.message || reason) || reason));
});

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { letterGrade } = require('./progress-bar');
const { shortenModelName } = require('./report-generator');
const { detectProfileFromModelName } = require('./config');
const { formatDuration } = require('./score-ledger');
const cliTable = require('./cli-table');
const communitySync = require('./community-sync');
const updateChecker = require('./update-checker');
const nightBatch = require('./night-batch');
const NOTEBOOKLM_URL = 'https://notebook.google.com/notebook/bd6cf971-b22a-460a-9892-419d1db02f9e';
const dashboard = require('./dashboard');
// Tarification cloud (tâche 2026-08-04) : estimation du coût $/€ des modèles
// cloud payants d'après les tokens consommés (estimation) et les prix OpenRouter.
const pricing = require('./pricing');

const LEDGER_DIR = path.join(__dirname, 'Export-Rapports', '.carnet');
const EXPORT_DIR = path.join(__dirname, 'Export-Rapports');
const SNAPSHOT_FILE = path.join(LEDGER_DIR, 'classement_snapshot.json');

// Charge tous les carnets de scores depuis Export-Rapports/.carnet/*.json
function loadAllLedgers() {
  const ledgers = [];
  if (!fs.existsSync(LEDGER_DIR)) return ledgers;
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8'));
      if (data && data.ecoles) ledgers.push(data);
    } catch (e) {
      logger.warn('Carnet illisible ignoré (' + file + ') : ' + e.message);
    }
  }
  return ledgers;
}

// --- Snapshots de position (détection de mouvement entre générations) ---
// À chaque génération du classement, on sauvegarde un snapshot { shortName: rang }
// dans .carnet/classement_snapshot.json. Au run suivant, on compare les rangs
// pour détecter si un modèle a monté (▲ vert), descendu (▼ rouge) ou est resté
// stable (= neutre). Utile pour suivre l'impact des mises à jour Hugging Face
// quand on re-teste certains modèles : leur score change, donc leur rang bouge.
function loadPositionSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn('Snapshot de position illisible ignoré : ' + e.message);
  }
  return {};
}

function savePositionSnapshot(entries) {
  const snapshot = {};
  for (let i = 0; i < entries.length; i++) {
    snapshot[entries[i].shortName] = i + 1;
  }
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    logger.warn('Impossible de sauvegarder le snapshot de position : ' + e.message);
  }
  return snapshot;
}

// Devine l'URL Hugging Face d'un modèle à partir de son nom.
// Si le nom contient un "/" (ex: "unsloth/gemma-4-12b-it-qat"), on construit
// directement l'URL https://huggingface.co/<publisher>/<model>. Sinon, on
// essaie avec le publisher stocké dans le carnet (s'il existe).
// @returns {string|null} URL Hugging Face ou null si non déterminable.
function guessModelUrl(modelName, publisher) {
  if (!modelName) return null;
  const name = String(modelName).trim();
  // Si le nom contient déjà un chemin publisher/model → URL directe
  if (name.includes('/')) {
    // Nettoie les éventuels sous-paths GGUF (ex: "yuxinlu1/.../gemma4-v2-q8_0.gguf")
    const parts = name.split('/');
    if (parts.length >= 2) {
      return 'https://huggingface.co/' + parts.slice(0, 2).join('/');
    }
  }
  // Si on a un publisher stocké, on construit publisher/model
  if (publisher) {
    const baseName = name.split('/').pop().replace(/\.gguf$/i, '');
    return 'https://huggingface.co/' + publisher + '/' + baseName;
  }
  return null;
}

// Calcule le delta de position pour chaque entrée en comparant le rang actuel
// au rang stocké dans le snapshot précédent. Retourne une map { shortName: delta }.
//   delta > 0 : le modèle a DESCENDU (son rang a augmenté, ex: 3 → 5, delta = +2).
//   delta < 0 : le modèle a MONTÉ (son rang a diminué, ex: 5 → 3, delta = -2).
//   delta = 0 : position stable.
//   null      : modèle nouveau (pas dans le snapshot précédent).
function computePositionDeltas(entries, snapshot) {
  const deltas = {};
  for (let i = 0; i < entries.length; i++) {
    const sn = entries[i].shortName;
    const oldRank = snapshot[sn];
    if (oldRank == null) {
      deltas[sn] = null;
    } else {
      deltas[sn] = (i + 1) - oldRank;
    }
  }
  return deltas;
}

// Normalise une entrée d'école du carnet vers { best, attempts }.
// Gère l'ancien format (résultat unique) et le nouveau format cumul.
function normalizeEcoleEntryLb(raw) {
  if (!raw) return { best: null, attempts: [] };
  if (raw.attempts && Array.isArray(raw.attempts)) {
    let best = raw.best;
    if (!best && raw.attempts.length > 0) {
      best = raw.attempts.reduce((b, a) => (a.pct || 0) >= (b.pct || 0) ? a : b, raw.attempts[0]);
    }
    return { best, attempts: raw.attempts.slice() };
  }
  if (raw.score != null || raw.max != null || raw.pct != null) {
    return { best: raw, attempts: [raw] };
  }
  return { best: null, attempts: [] };
}

// Compacte une tentative d'école pour la sérialisation JSON (modale).
function compactAttempt(a, idx, total) {
  return {
    n: idx + 1,
    date: a.date || '—',
    time: a.time || null,
    score: a.score || 0,
    max: a.max || 0,
    pct: a.max > 0 ? Math.max(0, Math.min(100, Math.round((a.score / a.max) * 100))) : 0,
    grade: letterGrade(a.max > 0 ? Math.round((a.score / a.max) * 100) : 0).grade,
    optionalBonus: a.optionalBonus || 0,
    globalLifeScore: a.globalLifeScore || 0,
    helpCount: a.helpCount || 0,
    retriedCount: a.retriedCount || 0,
    mandatoryPassed: a.mandatoryPassed || 0,
    mandatoryTotal: a.mandatoryTotal || 0,
    calibrationIndex: a.calibrationIndex != null ? a.calibrationIndex : null,
    reportFile: a.reportFile || null,
    // Chronométrie de la tentative (pour l'historique dans la modale).
    elapsedMs: a.elapsedMs || 0,
    wallMs: a.wallMs || 0,
    tokens: a.tokens || 0,
    tokensPerSecond: a.tokensPerSecond || 0
  };
}

// --- Tendance (progression / régression / redoublement) ---
// Compare la dernière tentative à la précédente pour une école ou au niveau
// global. Détecte :
//   - progression (▲) : le % a augmenté entre l'avant-dernier et le dernier test.
//   - régression (▼) : le % a baissé (modèle régressé après une mise à jour HF).
//   - stable (═) : aucun changement.
//   - redoublement : la note A-F a baissé d'au moins un cran (A→B, B→C, etc.).
//   - promotion : la note a monté d'au moins un cran.
// Retourne null si moins de 2 tentatives (pas assez d'historique).
function computeTrend(attempts) {
  if (!attempts || attempts.length < 2) return null;
  const sorted = attempts.slice().sort((a, b) => {
    // Tri chronologique : date + time.
    const da = (a.date || '') + (a.time || '');
    const db = (b.date || '') + (b.time || '');
    return da.localeCompare(db);
  });
  const prev = sorted[sorted.length - 2];
  const last = sorted[sorted.length - 1];
  const deltaPct = (last.pct || 0) - (prev.pct || 0);
  const prevGrade = prev.grade || letterGrade(prev.pct || 0).grade;
  const lastGrade = last.grade || letterGrade(last.pct || 0).grade;
  const gradeOrder = ['A', 'B', 'C', 'D', 'F'];
  const prevIdx = gradeOrder.indexOf(prevGrade);
  const lastIdx = gradeOrder.indexOf(lastGrade);
  let direction = 'stable';
  if (deltaPct > 0) direction = 'up';
  else if (deltaPct < 0) direction = 'down';
  let gradeChange = 'stable';
  if (prevIdx !== -1 && lastIdx !== -1) {
    if (lastIdx > prevIdx) gradeChange = 'redoublement'; // A→B = index augmente = note baisse
    else if (lastIdx < prevIdx) gradeChange = 'promotion'; // B→A = index diminue = note monte
  }
  return {
    deltaPct,
    direction,
    gradeChange,
    prevPct: prev.pct || 0,
    lastPct: last.pct || 0,
    prevGrade,
    lastGrade,
    prevDate: prev.date || '—',
    lastDate: last.date || '—'
  };
}

// Agrège un carnet en une entrée de classement (utilise la meilleure tentative par école).
function aggregateLedger(ledger) {
  const rawEntries = Object.values(ledger.ecoles || {});
  if (rawEntries.length === 0) return null;

  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  let helpCount = 0, retriedCount = 0;
  let mandatoryPassed = 0, mandatoryTotal = 0;
  let totalTokens = 0, totalElapsedMs = 0, totalWallMs = 0;
  const ecoles = [];

  for (const raw of rawEntries) {
    const { best, attempts } = normalizeEcoleEntryLb(raw);
    if (!best) continue;
    score += best.score || 0;
    max += best.max || 0;
    globalLifeScore += best.globalLifeScore || 0;
    optionalBonus += best.optionalBonus || 0;
    helpCount += best.helpCount || 0;
    retriedCount += best.retriedCount || 0;
    mandatoryPassed += best.mandatoryPassed || 0;
    mandatoryTotal += best.mandatoryTotal || 0;
    // Cumul chronométrie (durée d'inférence + tokens) pour la vitesse globale.
    totalTokens += best.tokens || 0;
    totalElapsedMs += best.elapsedMs || 0;
    totalWallMs += best.wallMs || 0;
    const bPct = best.max > 0 ? Math.max(0, Math.min(100, Math.round((best.score / best.max) * 100))) : 0;
    const compacted = attempts.map((a, i) => compactAttempt(a, i, attempts.length));
    ecoles.push({
      ecole: best.ecole,
      score: best.score || 0,
      max: best.max || 0,
      pct: bPct,
      optionalBonus: best.optionalBonus || 0,
      globalLifeScore: best.globalLifeScore || 0,
      helpCount: best.helpCount || 0,
      retriedCount: best.retriedCount || 0,
      calibrationIndex: best.calibrationIndex != null ? best.calibrationIndex : null,
      date: best.date || '—',
      reportFile: best.reportFile || null,
      attemptsCount: attempts.length,
      attempts: compacted,
      trend: computeTrend(compacted),
      // Chronométrie de l'école (meilleure tentative).
      elapsedMs: best.elapsedMs || 0,
      wallMs: best.wallMs || 0,
      tokens: best.tokens || 0,
      tokensPerSecond: best.tokensPerSecond || 0,
      // --- Estimation tokens pour le tarif cloud (tâche 2026-08-04) ---
      // Rétrocompatible : si les champs manquent (anciens carnets), on
      // estime promptTokens à 0 et completionTokens = tokens.
      promptTokens: best.promptTokens || 0,
      completionTokens: best.completionTokens || best.tokens || 0
    });
  }

  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0;
  const mandatoryPct = mandatoryTotal > 0 ? Math.max(0, Math.min(100, Math.round((mandatoryPassed / mandatoryTotal) * 100))) : 0;
  // Vitesse globale (tokens/s) sur la durée d'inférence cumulée. Mesure la
  // rapidité moyenne du modèle à produire des tokens (content + reasoning).
  const tokensPerSecond = totalElapsedMs > 0
    ? Math.round((totalTokens / (totalElapsedMs / 1000)) * 100) / 100
    : 0;

  // --- Tendance globale : synthèse des tendances par école ---
  // Si au moins une école a un trend, on agrège : redoublement si au moins une
  // école a régressé de note, promotion si au moins une a progressé de note.
  const ecoleTrends = ecoles.map(e => e.trend).filter(Boolean);
  let globalTrend = null;
  if (ecoleTrends.length > 0) {
    const anyRedoublement = ecoleTrends.some(t => t.gradeChange === 'redoublement');
    const anyPromotion = ecoleTrends.some(t => t.gradeChange === 'promotion');
    const avgDelta = ecoleTrends.reduce((s, t) => s + t.deltaPct, 0) / ecoleTrends.length;
    let direction = 'stable';
    if (avgDelta > 0) direction = 'up';
    else if (avgDelta < 0) direction = 'down';
    globalTrend = {
      direction,
      avgDeltaPct: Math.round(avgDelta * 10) / 10,
      redoublement: anyRedoublement,
      promotion: anyPromotion,
      ecoleCount: ecoleTrends.length
    };
  }

  // --- Tarif cloud estimé (tâche 2026-08-04) ---
  // On calcule le coût total ($/€) et par école pour les modèles cloud payants.
  // Pour les modèles locaux ou gratuits, le coût est nul. Les valeurs sont des
  // ESTIMATIONS (cf. pricing.js). Rétrocompatible avec les anciens carnets sans
  // promptTokens/completionTokens : on estime promptTokens ≈ 3×completion.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  for (const ec of ecoles) {
    totalPromptTokens += ec.promptTokens || 0;
    totalCompletionTokens += ec.completionTokens || 0;
  }
  const agg = {
    model: ledger.model || ledger.shortName || 'modèle_inconnu',
    // Nom d affichage personnalise (corrige par l utilisateur dans la modale).
    // Priorite : displayName manuel > model brute > shortName. Permet de
    // distinguer deux modeles au meme nom mais quantifications differentes
    // (ex: "Kai Os Grug 12B Q4_K_S" vs "Kai Os Grug 12B Q5_K_L") quand LM
    // Studio ne fournit que le nom de base sans quantif ni taille.
    displayName: ledger.displayName || null,
    shortName: ledger.shortName || shortenModelName(ledger.model || 'inconnu'),
    quantization: ledger.quantization || null,
    score, max, pct,
    mandatoryPassed, mandatoryTotal, mandatoryPct,
    globalLifeScore, optionalBonus, helpCount, retriedCount,
    ecoleCount: ecoles.length,
    ecoles,
    trend: globalTrend,
    lastUpdated: ledger.lastUpdated || null,
    // Chronométrie globale (cumul multi-écoles).
    elapsedMs: totalElapsedMs,
    wallMs: totalWallMs,
    tokens: totalTokens,
    tokensPerSecond,
    // --- Origine du modèle (local vs cloud) ---
    // Permet de séparer les modèles locaux (LM Studio) des modèles cloud
    // (OpenRouter, OpenAI, Groq...) dans le classement. Rétrocompatible :
    // si le carnet n'a pas encore provider/isCloud (anciens carnets), on
    // déduit depuis l'école "Post-Doctorat" (profil FRONTIER = cloud) puis
    // via l'heuristique detectIsCloudFromLedger (slug :free, profil FRONTIER
    // dans les attempts, format org/model sans quantization).
    provider: ledger.provider || detectProviderFromLedger(ledger) || null,
    isCloud: (ledger.isCloud === true)
      || (ledger.provider && ledger.provider !== 'local')
      || ecoles.some(e => e.ecole === 'Post-Doctorat')
      || (ledger.provider ? false : detectIsCloudFromLedger(ledger)),
    // --- Tarif cloud estimé (tâche 2026-08-04) ---
    // Les tokens estimés servent au calcul du coût. Si les champs détaillés
    // sont absents (anciens carnets), on estime promptTokens ≈ 3×completion
    // (les prompts BenchGo sont longs, les réponses plus courtes).
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens
  };
  // Calcul du coût via pricing.js. Pour les anciens carnets sans tokens
  // détaillés, estimateModelCost gère le fallback (promptTokens ≈ 3×completion).
  agg.cost = pricing.estimateModelCost(agg) || null;
  return agg;
}

// Heuristique de detection de l origine (cloud vs local) d un modele, pour
// les carnets anterieurs au commit 40e0da9 qui ne stockent pas provider/isCloud.
// On ne peut pas se fier a la presence d un "/" dans le nom (LM Studio nomme
// aussi les modeles locaux avec "org/name"), ni a l absence de quantization
// (beaucoup de modeles locaux n ont pas de quantization enregistree). On utilise
// donc uniquement des signaux FORTS et sans ambiguite :
//   1. Slug OpenRouter ":free" (marqueur exclusif aux modeles cloud gratuits —
//      les modeles locaux n utilisent jamais ce suffixe).
//   2. Presence du profil FRONTIER dans les attempts (seuls les modeles cloud
//      sont testes en FRONTIER — cf. config.js, profil reserve au cloud).
// Conservative : en cas de doute, on considere le modele comme local. Les
// modeles cloud payants sans suffixe :free et sans tentative FRONTIER aboutie
// restent classes en local jusqu a une migration manuelle (--mark-cloud).
function detectIsCloudFromLedger(ledger) {
  const model = (ledger.model || '').trim();
  if (!model) return false;
  // Signal 1 : suffixe OpenRouter ":free".
  if (/:free$/i.test(model)) return true;
  // Signal 2 : au moins une tentative enregistree avec le profil FRONTIER.
  const ecoles = Object.values(ledger.ecoles || {});
  for (const ec of ecoles) {
    const attempts = (ec && ec.attempts) || [];
    for (const a of attempts) {
      if (a && a.profile === 'FRONTIER') return true;
    }
  }
  return false;
}

// Heuristique de deduction du provider cloud pour les anciens carnets (antérieurs
// au commit 40e0da9) qui ne stockent pas le champ provider. On utilise le meme
// signal fort que detectIsCloudFromLedger : le suffixe OpenRouter ":free" est
// exclusif aux modeles gratuits d OpenRouter (aucun autre provider ne l utilise).
// Pour les modeles cloud payants sans suffixe :free et sans champ provider, on
// ne peut pas deviner le provider de facon fiable -> on renvoie null (affichage
// du fallback generique "Cloud").
function detectProviderFromLedger(ledger) {
  if (ledger.provider) return ledger.provider;
  const model = (ledger.model || '').trim();
  if (!model) return null;
  if (/:free$/i.test(model)) return 'openrouter';
  return null;
}

// Labels et métadonnées d'affichage par provider, pour le badge d'origine.
// Permet de différencier visuellement OpenRouter, OpenAI, Anthropic, Ollama,
// etc. dans le leaderboard HTML/CLI et le classement communautaire, au lieu du
// badge générique "Cloud" qui mélange tous les providers.
//
// Chaque entrée : { label, icon, color } où color est une teinte CSS (utilisé
// pour le badge HTML). Les providers non listés retournent un fallback générique.
const PROVIDER_DISPLAY = {
  openrouter: { label: 'OpenRouter', icon: '🔀', color: '#d29922' },
  openai:      { label: 'OpenAI',     icon: '🟢', color: '#10a37f' },
  anthropic:   { label: 'Anthropic', icon: '🟣', color: '#a855f7' },
  groq:        { label: 'Groq',      icon: '⚡', color: '#f55036' },
  together:    { label: 'Together',  icon: '🤝', color: '#0f6fff' },
  mistral:     { label: 'Mistral',   icon: '🌬️', color: '#ff7000' },
  deepseek:    { label: 'DeepSeek',  icon: '🐋', color: '#4d6bfe' },
  cohere:      { label: 'Cohere',    icon: '🔗', color: '#39594d' },
  ollama:      { label: 'Ollama',    icon: '🦙', color: '#d29922' },
  lmstudio:    { label: 'LM Studio', icon: '🏠', color: '#3fb950' },
  custom:      { label: 'Custom',    icon: '⚙️', color: '#8b949e' },
};

// Retourne les infos d'affichage d'un provider depuis son nom.
// Fallbacks : 'local' (LM Studio local sans provider explicite) et
// 'cloud' (provider inconnu mais isCloud=true).
function providerDisplay(provider, isCloud) {
  if (provider && PROVIDER_DISPLAY[provider]) return PROVIDER_DISPLAY[provider];
  if (provider && provider !== 'local') {
    return { label: provider, icon: '☁️', color: '#d29922' };
  }
  if (isCloud) return { label: 'Cloud', icon: '☁️', color: '#d29922' };
  return { label: 'Local', icon: '🏠', color: '#3fb950' };
}

// Génère des arguments qualitatifs (forces / faiblesses) selon les métriques.
function buildArguments(entry) {
  const forces = [];
  const faiblesses = [];
  const notes = [];

  if (entry.pct >= 95) forces.push('maîtrise quasi-parfaite des exercices');
  else if (entry.pct >= 80) forces.push('bonne maîtrise globale des exercices');
  else if (entry.pct >= 70) forces.push('niveau acceptable, validation du seuil obligatoire');

  if (entry.mandatoryPct === 100) forces.push('100% du contenu obligatoire validé');
  else if (entry.mandatoryPct >= 80) forces.push('contenu obligatoire largement validé');
  else if (entry.mandatoryPct < 50 && entry.mandatoryTotal > 0) faiblesses.push('échec sur le contenu obligatoire de base');

  if (entry.optionalBonus > 0) forces.push('exercices optionnels réussis (+' + entry.optionalBonus + ' bonus)');
  if (entry.helpCount > 0) faiblesses.push('a eu besoin d\'aide du professeur (' + entry.helpCount + 'x)');
  if (entry.retriedCount > 0) faiblesses.push('exercices en rattrapage (' + entry.retriedCount + 'x)');

  if (entry.globalLifeScore > 0 && entry.pct >= 80) forces.push('santé robuste (' + entry.globalLifeScore + ' PV)');
  else if (entry.globalLifeScore < 0) faiblesses.push('santé critique (' + entry.globalLifeScore + ' PV)');

  const calib = entry.ecoles.find(e => e.calibrationIndex != null);
  if (calib) {
    const c = calib.calibrationIndex;
    if (c >= 0.85) forces.push('excellente lucidité (C=' + c.toFixed(2) + ')');
    else if (c >= 0.65) notes.push('calibration modérée (C=' + c.toFixed(2) + ')');
    else faiblesses.push('biais de calibration majeur (C=' + c.toFixed(2) + ')');
  }

  if (entry.pct < 50) faiblesses.push('plus de la moitié des exercices échoués');
  if (entry.ecoleCount > 1) notes.push('évalué sur ' + entry.ecoleCount + ' écoles');

  // --- Vitesse (tokens/s) vs efficacité ---
  // La vitesse ne fait pas tout : un modèle lent peut être très efficace (bon
  // ratio points/temps), et un modèle rapide peut être médiocre. On signale
  // explicitement les cas intéressants sans les pénaliser dans le classement.
  if (entry.tokensPerSecond > 0) {
    if (entry.tokensPerSecond >= 60 && entry.pct >= 80) {
      forces.push('rapide ET efficace (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)');
    } else if (entry.tokensPerSecond < 20 && entry.pct >= 80) {
      forces.push('LENT mais efficace — la vitesse ne fait pas tout (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)');
    } else if (entry.tokensPerSecond >= 60 && entry.pct < 50) {
      faiblesses.push('rapide mais peu fiable — vitesse sans efficacité (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)');
    } else if (entry.tokensPerSecond < 20) {
      notes.push('modèle lent (' + entry.tokensPerSecond + ' t/s — ' + fmtDur(entry.elapsedMs) + ' d\'inférence)');
    } else {
      notes.push('vitesse moyenne (' + entry.tokensPerSecond + ' t/s)');
    }
  }

  // --- Tendance (progression / régression / redoublement) ---
  // Détectée à partir de l'historique des re-tests du carnet.
  if (entry.trend) {
    const t = entry.trend;
    if (t.redoublement) {
      faiblesses.push('A REDOUBLÉ : régression de note au dernier re-test (mise à jour HF dégradante ?)');
    } else if (t.promotion) {
      forces.push('A ÉTÉ PROMU : progression de note au dernier re-test');
    } else if (t.direction === 'up') {
      forces.push('en progression (' + (t.avgDeltaPct >= 0 ? '+' : '') + t.avgDeltaPct + '% au dernier re-test)');
    } else if (t.direction === 'down') {
      faiblesses.push('en régression (' + t.avgDeltaPct + '% au dernier re-test — mise à jour HF dégradante ?)');
    }
  }

  return { forces, faiblesses, notes };
}

// Détermine le verdict du modèle — aligné sur les 5 catégories de getCategory.
// Utilise le % global (pct), comme getCategory, et non mandatoryPct qui
// pouvait afficher "RECOMMANDÉ" pour un modèle faible globalement (ex: 32%
// mais 80% sur l'obligatoire). Le rang n'est connu qu'en contexte trié ; on
// l'accepte optionnellement pour marquer le podium.
function getVerdict(entry, rank) {
  const p = entry.pct;
  if (typeof rank === 'number' && rank <= 3) return { label: 'TOP DU TOP', color: '#ffd700', rank: 0 };
  if (p >= 90) return { label: 'RECOMMANDÉ', color: '#28a745', rank: 1 };
  if (p >= 75) return { label: 'DANS LA MOYENNE', color: '#17a2b8', rank: 2 };
  if (p >= 50) return { label: 'EN RATTRAPAGE', color: '#ffc107', rank: 3 };
  return { label: 'ÉCHEC TOTAL', color: '#dc3545', rank: 4 };
}

// Catégorie de filtrage (plus fine que le verdict) basée sur le % global.
// "Top du top" n'est réservé qu'aux 3 meilleurs modèles (rang 1, 2, 3).
// Sémantique des autres catégories (du meilleur au pire) :
//   - Recommandés   : modèles appropriés pour coder normalement (>= 90%).
//   - Dans la moyenne : modèles justes, à manier avec prudence (>= 75%).
//   - En rattrapage : modèles qui doivent repasser les écoles pour gagner
//                     des points supplémentaires (>= 50%).
//   - Échec total   : modèles non fiables, à supprimer du classement (< 50%).
// Seuils identiques à getVerdict (synchroniser les deux si modification).
function getCategory(entry, rank = null) {
  const p = entry.pct;
  if (rank && rank <= 3) return { key: 'top', label: 'Top du top', icon: '🏆', color: '#ffd700' };
  if (p >= 90) return { key: 'recommande', label: 'Recommandés', icon: '✅', color: '#28a745' };
  if (p >= 75) return { key: 'moyenne', label: 'Dans la moyenne', icon: '📊', color: '#17a2b8' };
  if (p >= 50) return { key: 'rattrapage', label: 'En rattrapage', icon: '⚠️', color: '#ffc107' };
  return { key: 'catastrophe', label: 'Échec total', icon: '💥', color: '#dc3545' };
}

// Taille de paramètres détectée depuis le nom du modèle.
// Retourne { key, label, short, icon } pour le filtrage et l'affichage.
//   - petit   : < 3B  (profil LIGHT)
//   - standard: 3B – 14B (profil STANDARD)
//   - expert  : 14B – 30B (profil EXPERT)
//   - doctorat: > 30B (profil DOCTORAT)
//   - inconnu : taille non détectable dans le nom
function getParamSize(modelName) {
  const { paramSize, detected } = detectProfileFromModelName(modelName || '');
  if (paramSize === null) {
    return { key: 'inconnu', label: 'Taille inconnue', short: '?B', icon: '❓', paramSize: null, detected: null };
  }
  if (paramSize < 3)   return { key: 'petit',    label: 'Petit (< 3B)',    short: paramSize + 'B', icon: '🐱', paramSize, detected };
  if (paramSize <= 15) return { key: 'standard', label: 'Standard (3B–15B)', short: paramSize + 'B', icon: '📦', paramSize, detected };
  if (paramSize <= 30) return { key: 'expert',   label: 'Expert (15B–30B)',  short: paramSize + 'B', icon: '🎓', paramSize, detected };
  return                 { key: 'doctorat', label: 'Doctorat (> 30B)',   short: paramSize + 'B', icon: '🧠', paramSize, detected };
}

// Valide qu'une école est adaptée au nombre de paramètres d'un modèle.
// Chaque école correspond à un profil avec un seuil minimum de paramètres :
//   - Primaire      : LIGHT     (< 3B)  → pas de minimum
//   - College-Lycee : STANDARD  (3B–15B) → min 3B
//   - Universite    : EXPERT    (15B–30B) → min 15B
//   - Doctorat-These: DOCTORAT  (> 30B)  → min 30B
//   - Post-Doctorat : FRONTIER  (cloud)  → pas de validation param
// Retourne { valid: bool, reason: string|null }.
// Si paramSize est null (inconnu), on considère valide (pas de faux positif).
function validateSchoolForParamSize(paramSize, ecoleName) {
  if (paramSize == null) return { valid: true, reason: null };
  const thresholds = {
    'Primaire': 0,
    'College-Lycee': 3,
    'Universite': 15,
    'Doctorat-These': 30,
    'Post-Doctorat': 0
  };
  const minParams = thresholds[ecoleName];
  if (minParams == null) return { valid: true, reason: null };
  if (paramSize < minParams) {
    return { valid: false, reason: 'Modèle ' + paramSize + 'B paramètres — école ' + ecoleName + ' requiert minimum ' + minParams + 'B. Résultat pénalisé par un test inadapté.' };
  }
  return { valid: true, reason: null };
}

// Construit un objet paramSize à partir d'une valeur numérique explicite
// (saisie manuelle stockée dans le carnet via ledger.paramSize).
function getParamSizeFromValue(val) {
  const paramSize = parseFloat(val);
  if (!isFinite(paramSize) || paramSize <= 0) {
    return { key: 'inconnu', label: 'Taille inconnue', short: '?B', icon: '❓', paramSize: null, detected: 'manual' };
  }
  if (paramSize < 3)   return { key: 'petit',    label: 'Petit (< 3B)',    short: paramSize + 'B', icon: '🐱', paramSize, detected: 'manual' };
  if (paramSize <= 15) return { key: 'standard', label: 'Standard (3B–15B)', short: paramSize + 'B', icon: '📦', paramSize, detected: 'manual' };
  if (paramSize <= 30) return { key: 'expert',   label: 'Expert (15B–30B)',  short: paramSize + 'B', icon: '🎓', paramSize, detected: 'manual' };
  return                 { key: 'doctorat', label: 'Doctorat (> 30B)',   short: paramSize + 'B', icon: '🧠', paramSize, detected: 'manual' };
}

function gradeColor(grade) {
  const map = { 'A': '#28a745', 'B': '#17a2b8', 'C': '#ffc107', 'D': '#e83e8c', 'F': '#dc3545' };
  return map[grade] || '#6c757d';
}

// Échappe du texte pour HTML.
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Formate une durée en millisecondes vers un affichage humain compact.
// Identique à score-ledger.js#formatDuration (dupliqué pour éviter une
// dépendance circulaire côté navigateur où ce module n'est pas chargé).
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (m < 60) return m + 'm' + String(sec).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h + 'h' + String(min).padStart(2, '0') + 'm';
}

function buildLeaderboardHTML(entries) {
  const now = new Date().toLocaleString('fr-FR');

  // SHA du commit local embarqué dans le HTML : permet à la bannière de mise à
  // jour (côté navigateur) de comparer avec le dernier commit poussé sur GitHub
  // main. Si git n'est pas disponible, localSha est null et la bannière ne
  // s'affiche pas (comparaison impossible).
  const localSha = updateChecker.getLocalCommitSha();

  // Liste des écoles disponibles (pour générer les options du select École).
  // Les compteurs sont désormais calculés côté client (renderCards) en fonction
  // du sélecteur Origine actif : on ne garde ici que la liste triée des noms.
  const ecoleCounts = {};
  entries.forEach((e) => {
    for (const ec of (e.ecoles || [])) {
      ecoleCounts[ec.ecole] = (ecoleCounts[ec.ecole] || 0) + 1;
    }
  });

  // Les données complètes de chaque modèle sont sérialisées en JSON pour la modale
  // (forces/faiblesses, détail par école, etc. — calculés une seule fois côté serveur).
  const modelsData = entries.map((e, idx) => {
    const rank = idx + 1;
    const verdict = getVerdict(e, rank);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    const cat = getCategory(e, rank);
    const psizeDetected = getParamSize(e.model);

    // Rapport intégral : on charge le carnet original pour accéder aux tiers
    // (réponses brutes + raisonnement + code produit + selfProfile). Ces données
    // sont injectées dans la modale (section repliable "Rapport intégral") pour
    // voir le comportement/raisonnement du modèle sans ouvrir le fichier MD.
    const ledger = loadLedgerByName(e.shortName);

    // Si le carnet contient une taille manuelle (ledger.paramSize), on l'utilise
    // à la place de la détection depuis le nom (ex: phi-4 → 14B non détectable).
    const psize = (ledger && ledger.paramSize)
      ? getParamSizeFromValue(ledger.paramSize)
      : psizeDetected;

    return {
      shortName: e.shortName,
      // model reste le nom brute (pour les URL/rapprochements) ; displayName est
      // le nom personnalise affiche sur la carte et dans la modale. S il n y a
      // pas de displayName manuel, on retombe sur model (comportement historique).
      model: e.model,
      displayName: ledger.displayName || e.model,
      quantization: e.quantization || null,
      modelUrl: ledger.modelUrl || guessModelUrl(e.model, ledger.publisher) || null,
      note: ledger.note || null,
      globalRank: rank,
      pct: e.pct,
      score: e.score,
      max: e.max,
      grade: grade.grade,
      mandatoryPct: e.mandatoryPct,
      mandatoryPassed: e.mandatoryPassed,
      mandatoryTotal: e.mandatoryTotal,
      globalLifeScore: e.globalLifeScore,
      optionalBonus: e.optionalBonus,
      helpCount: e.helpCount,
      retriedCount: e.retriedCount,
      ecoleCount: e.ecoleCount,
      lastUpdated: e.lastUpdated,
      trend: e.trend || null,
      positionDelta: e.positionDelta != null ? e.positionDelta : null,
      // Chronométrie globale (cumul multi-écoles) pour la modale.
      elapsedMs: e.elapsedMs || 0,
      wallMs: e.wallMs || 0,
      tokens: e.tokens || 0,
      tokensPerSecond: e.tokensPerSecond || 0,
      // Origine du modèle (local vs cloud) pour le filtre d'origine.
      isCloud: !!e.isCloud,
      provider: e.provider || (e.isCloud ? 'cloud' : 'local'),
      // --- Tarif cloud estimé (tâche 2026-08-04) ---
      // Coût total ($/€) et détail par école. NULL pour les modèles locaux
      // ou dont le prix est introuvable. Voir pricing.js.
      cost: e.cost || null,
      promptTokens: e.promptTokens || 0,
      completionTokens: e.completionTokens || 0,
      verdict,
      cat,
      paramSize: psize,
      paramSizeManual: (ledger && ledger.paramSize) ? ledger.paramSize : null,
      args,
      ecoles: e.ecoles.map(ec => {
        // Récupère l'entrée école du carnet pour les tiers + selfProfile.
        const ecoleEntry = ledger
          ? normalizeEcoleEntryLb(ledger.ecoles[ec.ecole]).best
          : null;
        const tiers = (ecoleEntry && ecoleEntry.tiers) || [];
        const paramValidity = validateSchoolForParamSize(psize.paramSize, ec.ecole);
        return {
          ecole: ec.ecole,
          score: ec.score,
          max: ec.max,
          pct: ec.pct,
          grade: letterGrade(ec.pct).grade,
          optionalBonus: ec.optionalBonus,
          globalLifeScore: ec.globalLifeScore,
          helpCount: ec.helpCount,
          retriedCount: ec.retriedCount,
          calibrationIndex: ec.calibrationIndex,
          date: ec.date,
          attemptsCount: ec.attemptsCount,
          attempts: ec.attempts,
          trend: ec.trend || null,
          selfProfile: (ecoleEntry && ecoleEntry.selfProfile) || null,
          paramValid: paramValidity.valid,
          paramValidReason: paramValidity.reason,
          // Chronométrie par école.
          elapsedMs: ec.elapsedMs || 0,
          wallMs: ec.wallMs || 0,
          tokens: ec.tokens || 0,
          tokensPerSecond: ec.tokensPerSecond || 0,
          // Estimation tokens pour le tarif cloud (tâche 2026-08-04).
          promptTokens: ec.promptTokens || 0,
          completionTokens: ec.completionTokens || ec.tokens || 0,
          tiers: tiers.map(t => ({
            tierNum: t.tierNum,
            tierTitle: t.tierTitle,
            className: t.className,
            isMandatory: t.isMandatory,
            rawResponse: t.rawResponse || null,
            evalResults: (t.evalResults || []).map(r => ({
              id: r.id,
              taskType: r.taskType || null,
              status: r.status,
              points: r.points || 0,
              maxPoints: r.maxPoints || 0,
              helpUsed: !!r.helpUsed,
              retried: !!r.retried,
              code: r.code || null,
              failureExplanation: r.failureExplanation || null,
              teacherCorrection: r.teacherCorrection || null
            }))
          }))
        };
      }),
      // Liste simple des noms d'écoles testées (pour le filtre École côté client).
      ecoleNames: (e.ecoles || []).map(ec => ec.ecole)
    };
  });

  let html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement BenchGo V3 — ${esc(now)}</title>
<style>
  :root {
    /* Palette GitHub-dark raffinée */
    --bg-0: #0a0e14;
    --bg-1: #11161d;
    --bg-2: #161b22;
    --bg-3: #1c2128;
    --bg-elev: #22272e;
    --border: #2d333b;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-dim: #6e7681;
    --accent: #58a6ff;
    --accent-2: #1f6feb;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --gold: #ffd700;
    --silver: #c9d1d4;
    --bronze: #e3b341;

    /* Espacements fluides (Living With Pixels) */
    --space-xs: clamp(0.375rem, 0.3462rem + 0.1282vw, 0.5rem);
    --space-s:  clamp(0.75rem, 0.6923rem + 0.2564vw, 1rem);
    --space-m:  clamp(1rem, 0.8846rem + 0.5128vw, 1.5rem);
    --space-l:  clamp(1.5rem, 1.3077rem + 1.0256vw, 2.5rem);
    --space-xl: clamp(2.5rem, 2.1154rem + 1.6667vw, 4rem);

    /* Typographie fluide (clamp) */
    --fs-display: clamp(1.9rem, 1.5538rem + 1.5385vw, 2.75rem);
    --fs-h1:      clamp(1.5rem, 1.3615rem + 0.6154vw, 1.85rem);
    --fs-h2:      clamp(1.15rem, 1.0808rem + 0.3077vw, 1.3rem);
    --fs-h3:      clamp(0.95rem, 0.9115rem + 0.1667vw, 1.05rem);
    --fs-body:    clamp(0.9rem, 0.8808rem + 0.0833vw, 0.97rem);
    --fs-small:   clamp(0.78rem, 0.7654rem + 0.0641vw, 0.83rem);
    --fs-tiny:    clamp(0.68rem, 0.6692rem + 0.0449vw, 0.71rem);

    /* Rayons & ombres */
    --r-sm: 8px;
    --r-md: 12px;
    --r-lg: 16px;
    --r-pill: 999px;
    --shadow-card: 0 1px 0 rgba(255,255,255,0.03), 0 2px 8px rgba(0,0,0,0.25);
    --shadow-elev: 0 8px 32px rgba(0,0,0,0.45);

    /* Container boxed intelligent */
    --container-max: 1600px;
    --container-pad: clamp(0.75rem, 3vw, 2rem);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  /* Scrollbars TOUJOURS invisibles partout dans l'application */
  html, body, * {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }

  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background:
      radial-gradient(1200px 600px at 50% -200px, rgba(31,111,235,0.10), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, rgba(188,140,255,0.06), transparent 55%),
      var(--bg-0);
    color: var(--text);
    font-size: var(--fs-body);
    line-height: 1.5;
    min-height: 100vh;
    padding-block: var(--space-m);
    -webkit-font-smoothing: antialiased;
  }

  /* Container boxed intelligent — centré, largeur fluide, padding inline clamp */
  .wrap {
    width: 100%;
    max-width: var(--container-max);
    margin-inline: auto;
    padding-inline: var(--container-pad);
  }

  /* En-tête */
  header.hero { text-align: center; padding-block: var(--space-m) var(--space-l); }
  header.hero .badge-top {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: 1px solid var(--border);
    background: var(--bg-2); border-radius: var(--r-pill);
    color: var(--text-muted); font-size: var(--fs-tiny);
    text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: var(--space-s);
  }
  header.hero h1 {
    font-size: var(--fs-display); font-weight: 800; line-height: 1.05;
    background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; letter-spacing: -0.02em;
  }
  header.hero .subtitle { color: var(--text-muted); margin-top: 6px; font-size: var(--fs-small); }

  /* Toolbars (flexbox, wrap fluide) */
  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs);
    margin-block: var(--space-s);
  }

  /* Barre sticky — reste collée en haut au scroll (effet WordPress/admin).
     Regroupe les filtres catégorie + taille + recherche. Fond semi-transparent
     + backdrop blur pour lisibilité par-dessus les cartes qui défilent. */
  .sticky-bar {
    position: sticky; top: 0; z-index: 100;
    background: rgba(10, 14, 20, 0.82);
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
    border-bottom: 1px solid var(--border);
    margin-inline: calc(-1 * var(--container-pad));
    padding-inline: var(--container-pad);
    padding-block: var(--space-xs);
    transition: box-shadow 0.2s ease, background 0.2s ease;
  }
  .sticky-bar .toolbar { margin-block: 4px; }
  .sticky-bar .toolbar:first-child { margin-top: 6px; }
  .sticky-bar .toolbar:last-child { margin-bottom: 6px; }
  /* Ombre quand on scrolle (la barre "se détache" du fond) — géré via JS .stuck */
  .sticky-bar.stuck {
    background: rgba(10, 14, 20, 0.94);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }
  .chip {
    padding: 6px 12px; border: 1px solid var(--border); background: var(--bg-2);
    color: var(--text-muted); border-radius: var(--r-pill);
    font-size: var(--fs-small); cursor: pointer; white-space: nowrap;
    transition: all 0.18s ease; user-select: none;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .chip:hover { border-color: var(--accent); color: var(--text); transform: translateY(-1px); }
  .chip.active {
    background: linear-gradient(135deg, var(--accent-2), var(--accent));
    border-color: transparent; color: #fff; font-weight: 600;
    box-shadow: 0 2px 10px rgba(31,111,235,0.35);
  }
  .chip .count {
    opacity: 0.75; margin-left: 2px; font-size: 0.85em;
    background: rgba(255,255,255,0.08); padding: 0 6px; border-radius: var(--r-pill);
  }

  .search-wrap { display: flex; align-items: center; gap: var(--space-xs); flex: 0 0 auto; }
  .search {
    padding: 8px 14px; background: var(--bg-2); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--r-sm);
    font-size: var(--fs-small); width: clamp(140px, 22vw, 240px);
    transition: all 0.18s ease;
  }
  .search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,0.18); }
  .result-count { font-size: var(--fs-tiny); color: var(--text-muted); }

  /* Select custom minimalistes */
  .select-wrap { position: relative; display: inline-flex; align-items: center; }
  .select-wrap::after {
    content: '▾'; position: absolute; right: 10px; pointer-events: none;
    color: var(--text-muted); font-size: 0.75em;
  }
  .select {
    appearance: none; -webkit-appearance: none;
    padding: 8px 28px 8px 12px; background: var(--bg-2); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--r-sm); cursor: pointer;
    font-size: var(--fs-small); font-weight: 600;
    transition: all 0.18s ease;
  }
  .select:hover { border-color: var(--accent); color: var(--text); }
  .select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,0.18); }
  .select option { background: var(--bg-2); color: var(--text); }
  .filter-label { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }

  /* Boutons */
  .btn {
    border: 1px solid transparent; border-radius: var(--r-sm);
    cursor: pointer; font-weight: 600; transition: all 0.18s ease;
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .btn-primary {
    padding: 8px 16px; border-color: var(--accent-2);
    background: linear-gradient(135deg, rgba(56,139,253,0.18), rgba(31,111,235,0.12));
    color: var(--accent); font-size: var(--fs-small);
  }
  .btn-primary:hover { background: linear-gradient(135deg, var(--accent-2), var(--accent)); color: #fff; box-shadow: 0 3px 12px rgba(31,111,235,0.4); }
  .btn-primary:active { transform: scale(0.97); }
  .btn-primary.done { background: var(--green); border-color: var(--green); color: #fff; }
  .btn-primary.active { background: linear-gradient(135deg, var(--accent-2), var(--accent)); color: #fff; box-shadow: 0 3px 12px rgba(31,111,235,0.4); }
  .btn-danger {
    padding: 6px 12px; border-color: var(--red);
    background: linear-gradient(135deg, rgba(248,81,73,0.18), rgba(248,81,73,0.10));
    color: var(--red); font-size: var(--fs-tiny); cursor: pointer;
    border-radius: var(--r-sm); border: 1px solid; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  }
  .btn-danger:hover { background: linear-gradient(135deg, var(--red), #da3633); color: #fff; box-shadow: 0 3px 12px rgba(248,81,73,0.4); }
  .btn-danger:active { transform: scale(0.97); }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
  .param-warn { cursor: help; font-size: 1.1em; vertical-align: middle; }
  .date-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: var(--r-sm); background: rgba(56,139,253,0.12); color: var(--accent-2); font-size: var(--fs-tiny); border: 1px solid rgba(56,139,253,0.25); }

  .btn-community {
    padding: 8px 16px; border-color: rgba(210,168,255,0.5);
    background: linear-gradient(135deg, rgba(210,168,255,0.18), rgba(163,113,247,0.12));
    color: #d2a8ff; font-size: var(--fs-small);
  }
  .btn-community:hover { background: linear-gradient(135deg, #a373fb, #d2a8ff); color: #fff; box-shadow: 0 3px 12px rgba(163,113,247,0.4); }
  .btn-community:active { transform: scale(0.97); }
  .btn-community:disabled { opacity: 0.5; cursor: default; }

  .submit-spinner {
    display: inline-block;
    width: 16px; height: 16px;
    margin-right: 8px;
    border: 2px solid rgba(210,168,255,0.25);
    border-top-color: #d2a8ff;
    border-radius: 50%;
    vertical-align: middle;
    animation: submitSpin 0.7s linear infinite;
  }
  @keyframes submitSpin { to { transform: rotate(360deg); } }
  .submit-spinner[hidden] { display: none; }

  .btn-icon {
    padding: 5px 9px; background: var(--bg-3); border-color: var(--border);
    color: var(--text-muted); font-size: var(--fs-tiny);
  }
  .btn-icon:hover { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
  .btn-icon:active { transform: scale(0.92); }

  .btn-danger {
    padding: 6px 10px; border-color: rgba(248,81,73,0.4);
    background: rgba(248,81,73,0.08); color: var(--red); font-size: var(--fs-tiny);
  }
  .btn-danger:hover { background: var(--red); color: #fff; }
  .btn-danger:disabled { opacity: 0.5; cursor: default; }

  /* Conteneur des cartes */
  .cards { display: flex; flex-direction: column; gap: var(--space-s); margin-block: var(--space-m); }

  /* Carte modèle — flexbox, structure claire */
  .card {
    background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
    border: 1px solid var(--border); border-radius: var(--r-md);
    box-shadow: var(--shadow-card); transition: all 0.2s ease;
    position: relative; z-index: 1;
  }
  .card::before {
    content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
    background: transparent; transition: background 0.2s ease;
  }
  .card:hover { border-color: var(--border-soft); transform: translateY(-1px); box-shadow: var(--shadow-elev); z-index: 2; }
  /* Quand le menu ⋮ est ouvert, cette carte doit passer au-dessus des suivantes
     pour que le menu ne soit pas recouvert par une carte survolée. */
  .card.menu-open { z-index: 50; }
  .card.gold::before   { background: linear-gradient(180deg, var(--gold), transparent); }
  .card.silver::before { background: linear-gradient(180deg, var(--silver), transparent); }
  .card.bronze::before { background: linear-gradient(180deg, var(--bronze), transparent); }
  .card.gold   { border-color: rgba(255,215,0,0.4); box-shadow: 0 0 24px rgba(255,215,0,0.10), var(--shadow-card); }
  .card.silver { border-color: rgba(201,209,212,0.3); }
  .card.bronze { border-color: rgba(227,179,65,0.35); }

  .card-row { display: flex; align-items: center; gap: var(--space-m); padding: var(--space-s) var(--space-m); cursor: pointer; }

  .rank {
    flex: 0 0 auto; min-width: 44px; height: 44px;
    display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 2px;
    padding-inline: 6px;
    font-size: var(--fs-h3); font-weight: 800; color: var(--accent);
    background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--r-sm);
  }
  .rank .medal { font-size: 1.5em; line-height: 1; }
  .card.gold .rank   { background: linear-gradient(135deg, rgba(255,215,0,0.18), transparent); border-color: rgba(255,215,0,0.4); }
  .card.silver .rank { background: linear-gradient(135deg, rgba(201,209,212,0.14), transparent); border-color: rgba(201,209,212,0.3); }
  .card.bronze .rank { background: linear-gradient(135deg, rgba(227,179,65,0.14), transparent); border-color: rgba(227,179,65,0.3); }

  .model-name {
    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  }
  .model-name .name-line {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    color: var(--accent); font-weight: 700; font-size: var(--fs-body);
    word-break: break-all; line-height: 1.3;
  }
  .model-name .cat-icon { margin-right: 2px; }
  .model-name .badges { display: flex; flex-wrap: wrap; gap: 5px; }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: var(--fs-tiny); padding: 2px 8px; border-radius: var(--r-pill);
    background: var(--bg-3); color: var(--text-muted); border: 1px solid var(--border);
    white-space: nowrap; font-weight: 600;
  }
  .badge.quant { color: var(--purple); border-color: rgba(188,140,255,0.35); background: rgba(188,140,255,0.10); }
  .badge.note { color: var(--accent); border-color: rgba(88,166,255,0.35); background: rgba(88,166,255,0.10); }
  .badge.cloud { color: #d29922; border-color: rgba(210,153,34,0.35); background: rgba(210,153,34,0.10); }
  .badge.local { color: #3fb950; border-color: rgba(63,185,80,0.35); background: rgba(63,185,80,0.10); }
  .badge.provider { border-style: dashed; }
  .badge.trend-up   { color: #3fb950; border-color: rgba(63,185,80,0.35); background: rgba(63,185,80,0.10); }
  .badge.trend-down { color: #f85149; border-color: rgba(248,81,73,0.35); background: rgba(248,81,73,0.10); }
  .badge.trend-stable { color: #8b949e; border-color: var(--border); background: var(--bg-3); }
  .badge.exported { color: #58a6ff; border-color: rgba(88,166,255,0.45); background: rgba(88,166,255,0.12); }
  .badge.exported:hover { background: rgba(88,166,255,0.22); }

  /* Flèche de mouvement de position (delta de rang) */
  .pos-arrow {
    display: inline-flex; align-items: center; gap: 1px;
    font-size: var(--fs-tiny); font-weight: 800; padding: 1px 5px;
    border-radius: var(--r-pill); margin-left: 4px; white-space: nowrap;
    border: 1px solid transparent;
  }
  .pos-arrow.pos-up     { color: #3fb950; background: rgba(63,185,80,0.12); border-color: rgba(63,185,80,0.30); }
  .pos-arrow.pos-down   { color: #f85149; background: rgba(248,81,73,0.12); border-color: rgba(248,81,73,0.30); }
  .pos-arrow.pos-stable { color: #8b949e; background: var(--bg-3); border-color: var(--border); }

  /* Mini-stats — flexbox grow */
  .mini-stats { display: flex; align-items: center; gap: var(--space-m); flex: 0 0 auto; flex-wrap: wrap; }
  .mini-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
  .mini-stat .lbl {
    font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase;
    letter-spacing: 0.6px; font-weight: 600;
  }
  .mini-stat .val { font-size: var(--fs-body); font-weight: 700; }
  .mini-stat .val.grade { font-size: var(--fs-h3); }
  .pct-bar-wrap { width: 64px; height: 5px; background: var(--bg-3); border-radius: var(--r-pill); margin-top: 3px; overflow: hidden; }
  .pct-bar-fill { height: 100%; border-radius: var(--r-pill); transition: width 0.3s ease; }

  .card-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; position: relative; }

  /* Menu ⋮ minimaliste sur chaque carte */
  .kebab {
    width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
    background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--r-sm);
    color: var(--text-muted); font-size: 1.1em; cursor: pointer;
    transition: all 0.18s ease; user-select: none;
  }
  .kebab:hover { border-color: var(--accent); color: var(--text); background: var(--bg-elev); }
  .kebab.active { border-color: var(--accent); color: var(--accent); background: var(--bg-elev); }
  .kebab-menu {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 50;
    min-width: 180px; background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r-sm); box-shadow: var(--shadow-elev);
    display: none; flex-direction: column; overflow: hidden;
  }
  .kebab-menu.show { display: flex; }
  .kebab-item {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px;
    font-size: var(--fs-small); color: var(--text); cursor: pointer; white-space: nowrap;
    border-bottom: 1px solid var(--border-soft); transition: background 0.15s;
  }
  .kebab-item:last-child { border-bottom: none; }
  .kebab-item:hover { background: var(--bg-elev); }
  .kebab-item.danger { color: var(--red); }
  .kebab-item.danger:hover { background: rgba(248,81,73,0.12); }

  .empty-msg {
    text-align: center; color: var(--text-muted); padding: var(--space-xl);
    font-style: italic; display: none; font-size: var(--fs-body);
  }

  /* Responsive fluide : mini-stats passe sous le nom sur écrans étroits */
  @media (max-width: 720px) {
    .card-row { flex-wrap: wrap; }
    .mini-stats { width: 100%; justify-content: space-between; padding-top: var(--space-s); border-top: 1px solid var(--border-soft); }
  }

  /* Modale de détail */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(1,4,9,0.78);
    backdrop-filter: blur(4px); display: none; align-items: flex-start; justify-content: center;
    z-index: 1000; padding: var(--space-m) var(--space-s); overflow-y: auto;
    scrollbar-width: none; -ms-overflow-style: none;
  }
  .modal-overlay::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .modal-overlay.show { display: flex; }
  .modal {
    background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
    border: 1px solid var(--border); border-radius: var(--r-lg);
    max-width: 1180px; width: 100%; margin: auto; overflow: hidden;
    box-shadow: var(--shadow-elev);
  }
  .modal-head { display: flex; align-items: flex-start; gap: var(--space-s); padding: var(--space-m) var(--space-l); background: var(--bg-3); border-bottom: 1px solid var(--border); }
  .modal-head .rank { flex: 0 0 auto; width: 52px; height: 52px; font-size: var(--fs-h2); }
  .modal-head .title { flex: 1 1 auto; min-width: 0; }
  .modal-head .title h2 { color: var(--accent); font-size: var(--fs-h1); word-break: break-all; margin-bottom: 6px; font-weight: 800; }
  .modal-head .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .verdict-badge {
    display: inline-block; padding: 4px 12px; border-radius: var(--r-sm);
    font-size: var(--fs-tiny); font-weight: 700; color: #fff;
  }
  .cat-tag { font-size: var(--fs-small); color: var(--text-muted); }
  .modal-close {
    flex: 0 0 auto; background: none; border: none; color: var(--text-muted);
    font-size: 1.6em; cursor: pointer; padding: 0 4px; line-height: 1; transition: color 0.15s;
  }
  .modal-close:hover { color: var(--red); }
  .modal-body { padding: var(--space-m) var(--space-l); max-height: calc(100vh - 220px); overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; }
  .modal-body::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .modal-body h3 {
    color: var(--accent); font-size: var(--fs-small); text-transform: uppercase;
    letter-spacing: 0.8px; margin: var(--space-m) 0 var(--space-s);
    padding-bottom: 6px; border-bottom: 1px solid var(--border-soft); font-weight: 700;
  }
  .modal-body h3:first-child { margin-top: 0; }

  /* Stats complètes — flexbox grow (préféré à grid) */
  .full-stats { display: flex; flex-wrap: wrap; gap: var(--space-s); }
  .full-stat {
    flex: 1 1 110px; min-width: 0;
    background: var(--bg-1); border: 1px solid var(--border-soft);
    border-radius: var(--r-sm); padding: var(--space-s); text-align: center;
  }
  .full-stat .lbl { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .full-stat .val { font-size: clamp(0.72rem, 0.68rem + 0.2vw, 0.88rem); font-weight: 800; margin-top: 4px; word-break: break-all; overflow-wrap: anywhere; line-height: 1.15; }
  .full-stat .bar { width: 100%; height: 5px; background: var(--bg-3); border-radius: var(--r-pill); margin-top: 6px; overflow: hidden; }
  .full-stat .bar > div { height: 100%; border-radius: var(--r-pill); }

  /* Forces / Faiblesses — flexbox 2 colonnes */
  .args-grid { display: flex; flex-wrap: wrap; gap: var(--space-m); }
  .args-block { flex: 1 1 280px; min-width: 0; }
  .args-block .args-title {
    font-size: var(--fs-small); text-transform: uppercase; letter-spacing: 0.6px;
    margin-bottom: var(--space-xs); font-weight: 700;
  }
  .args-forces .args-title { color: var(--green); }
  .args-weak .args-title   { color: var(--red); }
  .args-notes .args-title  { color: var(--text-muted); }
  .args-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .args-list li { font-size: var(--fs-small); line-height: 1.5; padding-left: 16px; position: relative; }
  .args-list li::before { content: "•"; position: absolute; left: 4px; color: var(--text-dim); }
  .args-empty { font-size: var(--fs-small); color: var(--text-dim); font-style: italic; }

  .ecoles-table { width: 100%; border-collapse: collapse; font-size: var(--fs-small); }
  .ecoles-table th, .ecoles-table td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--border-soft); }
  .ecoles-table th { color: var(--text-dim); font-size: var(--fs-tiny); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .ecoles-table td.num { text-align: right; }
  .ecoles-table .grade { font-weight: 800; text-align: center; }
  .ecoles-table tr:hover { background: var(--bg-2); }

  .hist-toggle {
    display: inline-block; font-size: var(--fs-tiny); color: var(--accent); cursor: pointer;
    padding: 2px 8px; border: 1px solid var(--border); border-radius: var(--r-pill);
    margin-left: 6px; user-select: none; transition: all 0.15s;
  }
  .hist-toggle:hover { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
  .hist-row > td { padding: 0 !important; }
  .hist-block { padding: var(--space-s) var(--space-m); background: var(--bg-1); border-top: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft); }
  .hist-title { font-size: var(--fs-tiny); color: var(--text-dim); margin-bottom: var(--space-xs); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .hist-table { width: 100%; border-collapse: collapse; font-size: var(--fs-small); }
  .hist-table th, .hist-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border-soft); }
  .hist-table th { color: var(--text-dim); font-size: var(--fs-tiny); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .hist-table td.num { text-align: right; }
  .hist-best { background: rgba(56,139,253,0.08); }
  .best-tag { color: var(--gold); font-size: 0.9em; }

  .meta-line {
    font-size: var(--fs-tiny); color: var(--text-muted); margin-top: var(--space-m);
    padding-top: var(--space-s); border-top: 1px solid var(--border-soft);
  }
  .meta-line code { background: var(--bg-3); padding: 1px 6px; border-radius: 4px; font-family: 'Cascadia Code', 'Consolas', monospace; color: var(--purple); }

  /* Grille d'actions dans la modale (lien, quantification, placeholders futurs) */
  .modal-actions-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-m);
    margin-bottom: var(--space-m);
  }
  .action-card {
    background: var(--bg-3);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    padding: var(--space-s);
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 0;
  }
  .action-card h4 {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .action-card p {
    margin: 0;
    font-size: var(--fs-small);
    color: var(--text-muted);
    line-height: 1.4;
  }
  .action-card .card-content { min-height: 42px; }
  @media (max-width: 1100px) { .modal-actions-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .modal-actions-grid { grid-template-columns: 1fr; } }

  /* Section lien du modèle (modale) */
  .model-url-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-url-section.row { display: flex; flex-direction: row; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
  .model-url-display { display: inline-flex; align-items: center; gap: 6px; }
  .model-url-link {
    color: var(--accent); text-decoration: none; font-size: var(--fs-small);
    word-break: break-all; border-bottom: 1px dashed transparent; transition: border-color 0.15s;
  }
  .model-url-link:hover { border-bottom-color: var(--accent); }
  .model-url-edit { display: flex; flex-direction: column; gap: var(--space-xs); }
  /* Section quantification manuelle (modale) — même ergonomie que le lien */
  .model-quant-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-quant-section.row { display: flex; flex-direction: row; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
  .model-quant-display { display: inline-flex; align-items: center; gap: 6px; }
  .model-quant-value { font-weight: 700; color: var(--purple); font-size: var(--fs-small); }
  .model-quant-edit { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-params-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-params-display { display: inline-flex; align-items: center; gap: 6px; }
  .model-params-value { font-weight: 700; color: var(--accent); font-size: var(--fs-small); }
  .model-params-edit { display: flex; flex-direction: column; gap: var(--space-xs); }
  .quant-field { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-small); }
  .quant-field span { color: var(--text-muted); font-size: var(--fs-tiny); }
  .quant-field select { width: 100%; }
  .quant-custom summary { cursor: pointer; font-size: var(--fs-tiny); color: var(--text-muted); }
  .quant-custom[open] summary { margin-bottom: 4px; }
  /* Section note personnelle (modale) — même ergonomie que le lien/quantification */
  .model-note-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-note-display { font-size: var(--fs-small); color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 140px; overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; line-height: 1.4; }
  .model-note-display::-webkit-scrollbar { display: none; }
  .model-note-value { display: block; }
  .model-note-edit { display: flex; flex-direction: column; gap: var(--space-xs); }
  /* Section nom affiché (modale) — même ergonomie que les autres sections */
  .model-displayname-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-displayname-display { display: inline-flex; align-items: center; gap: 6px; }
  .model-displayname-value { font-weight: 700; color: var(--accent); font-size: var(--fs-small); word-break: break-word; }
  .model-displayname-edit { display: flex; flex-direction: column; gap: var(--space-xs); }
  .model-displayname-edit input { width: 100%; }
  .btn-sm { padding: 4px 12px; font-size: var(--fs-small); border-radius: var(--r-sm); }

  /* Rapport intégral (modale) — sections repliables par école/tier */
  .report-block { margin-top: var(--space-s); }
  .report-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); }
  .report-actions-hint { font-size: var(--fs-tiny); color: var(--text-dim); font-style: italic; }
  .report-school { margin-bottom: var(--space-m); border: 1px solid var(--border-soft); border-radius: var(--r-sm); overflow: hidden; }
  .report-school-head, .report-tier-head {
    display: flex; align-items: center; gap: var(--space-xs); cursor: pointer;
    padding: var(--space-xs) var(--space-s); background: var(--bg-3);
    font-weight: 700; font-size: var(--fs-small); user-select: none;
    transition: background 0.15s;
  }
  .report-school-head:hover, .report-tier-head:hover { background: var(--bg-elev); }
  .report-school-head .caret, .report-tier-head .caret { color: var(--text-dim); transition: transform 0.18s; }
  .report-school-head.open .caret, .report-tier-head.open .caret { transform: rotate(90deg); }
  .report-school-head .sch-title { flex: 1; min-width: 0; color: var(--accent); }
  .report-tier-head .th-title { flex: 1; min-width: 0; color: var(--text); }
  .report-tier-head .th-badge { font-size: var(--fs-tiny); padding: 1px 7px; border-radius: var(--r-pill); font-weight: 600; }
  .report-tier-head .th-badge.mand { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
  .report-tier-head .th-badge.opt  { background: rgba(210,153,34,0.15); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }
  .report-school-body, .report-tier-body { display: none; padding: var(--space-s); background: var(--bg-1); }
  .report-school-body.open, .report-tier-body.open { display: block; }
  .report-tier { margin-bottom: var(--space-xs); border: 1px solid var(--border-soft); border-radius: var(--r-sm); overflow: hidden; }
  .report-exo { margin-block: var(--space-s); padding: var(--space-s); background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); }
  .report-exo-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-bottom: var(--space-xs); font-size: var(--fs-small); }
  .report-exo-head .exo-id { font-weight: 700; color: var(--accent); }
  .report-exo-head .exo-status { padding: 1px 8px; border-radius: var(--r-pill); font-size: var(--fs-tiny); font-weight: 700; }
  .report-exo-head .exo-status.success { background: rgba(63,185,80,0.15); color: var(--green); }
  .report-exo-head .exo-status.fail    { background: rgba(248,81,73,0.15); color: var(--red); }
  .report-exo-head .exo-status.bypass  { background: rgba(139,148,158,0.15); color: var(--text-muted); }
  .report-exo-head .exo-pts { margin-left: auto; color: var(--text-muted); font-size: var(--fs-tiny); }
  .report-exo-label { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-top: var(--space-xs); margin-bottom: 4px; font-weight: 700; }
  .report-code {
    background: var(--bg-0); border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--space-s); margin-block: 4px; overflow-x: auto;
    font-family: 'Cascadia Code', 'Consolas', 'Courier New', monospace;
    font-size: var(--fs-tiny); color: var(--text); line-height: 1.5;
    white-space: pre; scrollbar-width: none; -ms-overflow-style: none;
  }
  .report-code::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .report-expl { font-size: var(--fs-small); color: var(--text); margin-block: 4px; padding: var(--space-xs) var(--space-s); background: rgba(248,81,73,0.06); border-left: 3px solid var(--red); border-radius: 4px; }
  .report-teacher { font-size: var(--fs-small); color: var(--text); margin-block: 4px; padding: var(--space-xs) var(--space-s); background: rgba(188,140,255,0.08); border-left: 3px solid var(--purple); border-radius: 4px; }
  .report-teacher b { color: var(--purple); }
  .report-raw {
    background: var(--bg-0); border: 1px dashed var(--border); border-radius: var(--r-sm);
    padding: var(--space-s); margin-top: var(--space-xs);
    font-family: 'Cascadia Code', 'Consolas', monospace; font-size: var(--fs-tiny);
    color: var(--text-muted); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    max-height: 400px; overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;
  }
  .report-raw::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .report-selfprofile { font-size: var(--fs-small); color: var(--text); margin-block: var(--space-xs); padding: var(--space-s); background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); }
  .report-selfprofile .sp-title { font-weight: 700; color: var(--accent); margin-bottom: var(--space-xs); font-size: var(--fs-small); }
  .report-selfprofile ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .report-selfprofile li { padding-left: 14px; position: relative; }
  .report-selfprofile li::before { content: "•"; position: absolute; left: 2px; color: var(--text-dim); }
  .report-empty { color: var(--text-dim); font-style: italic; font-size: var(--fs-small); padding: var(--space-s); }

  footer.footer {
    text-align: center; color: var(--text-dim); font-size: var(--fs-tiny);
    margin-top: var(--space-l); padding-block: var(--space-m);
  }

  .toast {
    position: fixed; bottom: var(--space-m); left: 50%; transform: translateX(-50%);
    padding: 10px 22px; border-radius: var(--r-pill); font-size: var(--fs-small);
    color: #fff; opacity: 0; transition: opacity 0.3s, transform 0.3s;
    pointer-events: none; z-index: 9999; box-shadow: var(--shadow-elev);
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
  .toast.ok { background: var(--green); }
  .toast.err { background: var(--red); }

  /* Bannière de mise à jour disponible (comparaison SHA local vs GitHub main) */
  .update-banner {
    margin-block: var(--space-s) var(--space-m);
    border: 1px solid rgba(210, 153, 34, 0.45);
    border-radius: var(--r-md);
    background: linear-gradient(135deg, rgba(210, 153, 34, 0.12), rgba(188, 140, 255, 0.06));
    box-shadow: 0 2px 14px rgba(210, 153, 34, 0.18), var(--shadow-card);
    overflow: hidden;
    animation: updatePulse 2.4s ease-in-out infinite;
  }
  @keyframes updatePulse {
    0%, 100% { box-shadow: 0 2px 14px rgba(210, 153, 34, 0.18), var(--shadow-card); }
    50% { box-shadow: 0 2px 22px rgba(210, 153, 34, 0.38), var(--shadow-card); }
  }
  .update-banner[hidden] { display: none; }
  .update-banner-inner {
    display: flex; align-items: flex-start; gap: var(--space-s);
    padding: var(--space-s) var(--space-m);
  }
  .update-icon { font-size: 1.6em; line-height: 1.2; flex: 0 0 auto; }
  .update-content { flex: 1 1 auto; min-width: 0; }
  .update-title {
    font-weight: 800; font-size: var(--fs-h3); color: var(--yellow);
    margin-bottom: 4px; letter-spacing: 0.2px;
  }
  .update-desc { color: var(--text); font-size: var(--fs-small); line-height: 1.45; }
  .update-commits {
    list-style: none; margin: var(--space-xs) 0; padding: 0;
    display: flex; flex-direction: column; gap: 4px;
  }
  .update-commits li {
    font-size: var(--fs-tiny); color: var(--text-muted);
    display: flex; gap: 8px; align-items: baseline;
  }
  .update-commits li .cdate { color: var(--accent); font-weight: 600; flex: 0 0 auto; }
  .update-action {
    margin-top: var(--space-xs); font-size: var(--fs-small); color: var(--text);
  }
  .update-action code, .update-desc code {
    background: var(--bg-3); padding: 1px 6px; border-radius: 4px;
    color: var(--purple); font-weight: 600;
  }
  .update-close {
    flex: 0 0 auto; background: transparent; border: 1px solid var(--border);
    color: var(--text-muted); width: 28px; height: 28px; border-radius: var(--r-sm);
    cursor: pointer; font-size: 14px; line-height: 1; transition: all 0.18s ease;
  }
  .update-close:hover { color: var(--text); border-color: var(--accent); }
  @media (max-width: 560px) {
    .update-banner-inner { flex-wrap: wrap; }
    .update-close { margin-left: auto; }
  }

  /* Bannière NotebookLM — agent IA de renseignement sur les modèles */
  .nb-banner {
    margin-block: var(--space-s) var(--space-m);
    border: 1px solid rgba(188, 140, 255, 0.45);
    border-radius: var(--r-md);
    background: linear-gradient(135deg, rgba(188, 140, 255, 0.14), rgba(88, 166, 255, 0.06));
    box-shadow: 0 2px 16px rgba(188, 140, 255, 0.20), var(--shadow-card);
  }
  .nb-banner-inner {
    display: flex; align-items: center; gap: var(--space-s);
    padding: var(--space-s) var(--space-m);
  }
  .nb-icon {
    flex: 0 0 auto; width: 42px; height: 42px; border-radius: var(--r-md);
    background: linear-gradient(135deg, var(--purple), var(--accent));
    display: flex; align-items: center; justify-content: center;
    font-size: 1.4em; box-shadow: 0 0 0 1px rgba(188,140,255,0.4), 0 4px 12px rgba(188,140,255,0.35);
  }
  .nb-content { flex: 1 1 auto; min-width: 0; }
  .nb-title {
    font-weight: 800; font-size: var(--fs-h3); color: var(--purple);
    margin-bottom: 2px; letter-spacing: 0.2px;
  }
  .nb-desc { color: var(--text); font-size: var(--fs-small); line-height: 1.4; }
  .nb-desc b { color: var(--accent); }
  .nb-actions { flex: 0 0 auto; display: flex; gap: var(--space-xs); align-items: center; }
  .nb-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: var(--r-pill);
    border: 1px solid var(--purple); background: var(--purple);
    color: #fff; font-weight: 700; font-size: var(--fs-small);
    cursor: pointer; transition: all 0.18s ease; text-decoration: none;
  }
  .nb-btn:hover { background: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
  .nb-btn-info {
    width: 26px; height: 26px; padding: 0; border-radius: 50%;
    border: 1px solid var(--border); background: var(--bg-3);
    color: var(--text-muted); font-weight: 700; font-size: 13px;
    cursor: pointer; transition: all 0.18s ease;
  }
  .nb-btn-info:hover { color: var(--purple); border-color: var(--purple); }
  .nb-tip {
    position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%) translateY(8px);
    padding: 10px 18px; border-radius: var(--r-pill);
    background: var(--purple); color: #fff; font-size: var(--fs-small); font-weight: 600;
    box-shadow: var(--shadow-elev); opacity: 0; pointer-events: none;
    transition: opacity 0.4s ease, transform 0.4s ease; z-index: 9998;
  }
  .nb-tip.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .nb-tip::after {
    content: ''; position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%);
    border: 6px solid transparent; border-top-color: var(--purple); border-bottom: 0;
  }
  @media (max-width: 560px) {
    .nb-banner-inner { flex-wrap: wrap; }
    .nb-actions { width: 100%; justify-content: flex-end; }
  }

  /* Modale NotebookLM */
  .nb-modal { max-width: 640px; }
  .nb-modal .modal-head { background: linear-gradient(135deg, rgba(188,140,255,0.18), rgba(88,166,255,0.10)); }
  .nb-modal h2 { color: var(--purple) !important; }
  .nb-modal-body { padding: var(--space-l); }
  .nb-modal-body p { color: var(--text); font-size: var(--fs-small); line-height: 1.6; margin-bottom: var(--space-s); }
  .nb-features { list-style: none; padding: 0; margin: var(--space-s) 0; display: grid; gap: var(--space-xs); }
  .nb-features li {
    display: flex; align-items: flex-start; gap: 10px;
    padding: var(--space-xs) var(--space-s); border-radius: var(--r-sm);
    background: var(--bg-3); font-size: var(--fs-small); color: var(--text);
  }
  .nb-features li .f-icon { flex: 0 0 auto; font-size: 1.1em; }
  .nb-features li b { color: var(--accent); }
  .nb-modal-cta {
    display: flex; gap: var(--space-s); margin-top: var(--space-m); flex-wrap: wrap;
  }

  /* --- Animations d'entrée au scroll (§3 UI/Ludisme) --- */
  /* Les cartes apparaissent avec un fondu + translation quand elles entrent
     dans le viewport. Géré par IntersectionObserver qui ajoute .visible. */
  .card {
    opacity: 0;
    transform: translateY(16px);
    transition: opacity 0.5s ease, transform 0.5s ease;
  }
  .card.visible {
    opacity: 1;
    transform: translateY(0);
  }
  @media (prefers-reduced-motion: reduce) {
    .card { opacity: 1; transform: none; transition: none; }
  }

  /* --- Media print : masque la sticky-bar et la modale pour Exporter PDF --- */
  @media print {
    .sticky-bar, .search-wrap, .toolbar, .modal-overlay, .update-banner, .footer { display: none !important; }
    .card { opacity: 1 !important; transform: none !important; break-inside: avoid; }
    body { background: white !important; color: black !important; }
    .cards { padding: 0 !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <span class="badge-top">🏇 BenchGo V3 · Classement comportemental</span>
    <h1>Classement BenchGo V3</h1>
    <p class="subtitle">Généré le ${esc(now)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} du meilleur au pire</p>
  </header>

  <div class="nb-banner">
    <div class="nb-banner-inner">
      <div class="nb-icon" title="Agent NotebookLM">🧠</div>
      <div class="nb-content">
        <div class="nb-title">Agent NotebookLM</div>
        <div class="nb-desc">Posez vos questions sur les modèles testés à l'<b>agent IA</b> — analyses, comparaisons, recommandations.</div>
      </div>
      <div class="nb-actions">
        <button class="nb-btn-info" id="nbInfoBtn" title="Qu'est-ce que c'est ?">?</button>
        <a class="nb-btn" href="${NOTEBOOKLM_URL}" target="_blank" rel="noopener noreferrer">🧠 Ouvrir l'agent</a>
      </div>
    </div>
  </div>
  <div class="nb-tip" id="nbTip">Besoin de renseignements sur un modèle ? Contactez l'agent NotebookLM 🧠</div>

  <div id="updateBanner" class="update-banner" hidden>
    <div class="update-banner-inner">
      <span class="update-icon">⬆️</span>
      <div class="update-content">
        <div class="update-title">Mise à jour disponible</div>
        <div class="update-desc">Une nouvelle version de BenchGo a été publiée sur GitHub (nouveautés, corrections d'exercices, améliorations). Vous êtes en retard sur la branche <code>main</code>.</div>
        <ul class="update-commits" id="updateCommits"></ul>
        <div class="update-action">Pour mettre à jour : <code>git pull</code> puis relancez <code>node runner.js</code></div>
      </div>
      <button class="update-close" id="updateClose" title="Masquer cet avis (reviendra dans 1h)">✕</button>
    </div>
  </div>

  <div class="sticky-bar" id="stickyBar">
    <div class="toolbar" style="justify-content: space-between;">
      <div class="toolbar" style="margin-block: 0;">
        <label class="filter-label" for="catSelect">Catégorie</label>
        <div class="select-wrap">
          <select class="select" id="catSelect">
            <option value="all" selected>Tous</option>
            <option value="top">🏆 Top du top</option>
            <option value="recommande">✅ Recommandés</option>
            <option value="moyenne">📊 Dans la moyenne</option>
            <option value="rattrapage">⚠️ En rattrapage</option>
            <option value="catastrophe">💥 Échec total</option>
          </select>
        </div>

        <label class="filter-label" for="sizeSelect" style="margin-left: var(--space-xs);">Taille</label>
        <div class="select-wrap">
          <select class="select" id="sizeSelect">
            <option value="all" selected>Toutes tailles</option>
            <option value="petit">🐱 &lt; 3B</option>
            <option value="standard">📦 3B–14B</option>
            <option value="expert">🎓 14B–30B</option>
            <option value="doctorat">🧠 &gt; 30B</option>
            <option value="inconnu">❓ Inconnue</option>
          </select>
        </div>

        <label class="filter-label" for="healthSelect" style="margin-left: var(--space-xs);">Santé</label>
        <div class="select-wrap">
          <select class="select" id="healthSelect">
            <option value="all" selected>Toutes</option>
            <option value="positif">💚 Saine (≥ 0 PV)</option>
            <option value="negatif">❤️‍🩹 En difficulté (&lt; 0 PV)</option>
          </select>
        </div>

        <label class="filter-label" for="ecoleSelect" style="margin-left: var(--space-xs);">École</label>
        <div class="select-wrap">
          <select class="select" id="ecoleSelect">
            <option value="all" selected>Toutes écoles</option>
            ${Object.keys(ecoleCounts).sort().map(ec => `<option value="${esc(ec)}">🏫 ${esc(ec)}</option>`).join('')}
          </select>
        </div>

        <label class="filter-label" for="originSelect" style="margin-left: var(--space-xs);">Origine</label>
        <div class="select-wrap">
          <select class="select" id="originSelect">
            <option value="all" selected>Toutes origines</option>
            <option value="local">🏠 Local · LM Studio</option>
            <option value="cloud">☁️ Cloud · API</option>
          </select>
        </div>

        <button class="btn btn-primary" id="btnRecentSort" title="Trier les modèles par date de dernier test (du plus récent au plus ancien)" style="margin-left: var(--space-xs);">🕒 Récents</button>
      </div>

      <div class="search-wrap">
        <input type="text" class="search" id="search" placeholder="🔍 Rechercher un modèle…" />
        <span class="result-count" id="resultCount"></span>
        <button class="btn btn-primary" id="btnCopyAll" title="Copier tout le classement (texte brut) pour le partager">⧉ Copier le classement</button>
        <button class="btn btn-community" id="btnSubmitCommunity" title="Envoyer vos résultats sur le classement communautaire GitHub">🌐 Envoyer à la communauté</button>
        <button class="btn btn-primary" id="btnCommunityRanking" title="Ouvrir le classement communautaire en ligne">🌍 Classement communautaire</button>
        <button class="btn btn-primary" id="btnExportPdf" title="Imprimer / Exporter en PDF (dialogue navigateur)">📄 Exporter PDF</button>
        <button class="btn btn-primary" id="btnExportCsv" title="Exporter le classement en CSV (tableur)">📊 Exporter CSV</button>
        <button class="btn btn-primary" id="btnExportMd" title="Exporter le classement en tableau Markdown">📝 Exporter Markdown</button>
      </div>
    </div>
  </div>

  <div class="cards" id="cards"></div>
  <p class="empty-msg" id="emptyMsg">Aucun modèle ne correspond à ce filtre.</p>

  <footer class="footer">Généré par BenchGo V3 — leaderboard.js · Cliquez sur une carte pour le détail complet.</footer>
</div>

<div id="modal" class="modal-overlay">
  <div class="modal">
    <div class="modal-head">
      <div class="rank" id="mRank"></div>
      <div class="title">
        <h2 id="mTitle"></h2>
        <div class="tags">
          <span class="verdict-badge" id="mVerdict"></span>
          <span class="cat-tag" id="mCat"></span>
        </div>
      </div>
      <button class="modal-close" onclick="closeModal()" aria-label="Fermer">×</button>
    </div>
    <div class="modal-body" id="mBody"></div>
  </div>
</div>

<div id="nbModal" class="modal-overlay">
  <div class="modal nb-modal">
    <div class="modal-head">
      <div class="rank" style="background:linear-gradient(135deg,var(--purple),var(--accent))">🧠</div>
      <div class="title">
        <h2>Agent NotebookLM</h2>
        <div class="tags"><span class="cat-tag">Renseignement sur les modèles</span></div>
      </div>
      <button class="modal-close" onclick="closeNbModal()" aria-label="Fermer">×</button>
    </div>
    <div class="modal-body nb-modal-body">
      <p>L'<b>Agent NotebookLM</b> est un assistant IA Google qui connaît l'intégralité des résultats BenchGo. Posez-lui vos questions en langage naturel :</p>
      <ul class="nb-features">
        <li><span class="f-icon">📊</span><span><b>Comparer des modèles</b> — "Lequel est le plus rapide en Q4 sous 3B ?"</span></li>
        <li><span class="f-icon">🎯</span><span><b>Recommandations</b> — "Quel modèle recommandes-tu pour la programmation ?"</span></li>
        <li><span class="f-icon">🔍</span><span><b>Analyser un échec</b> — "Pourquoi X a échoué à l'école DOCTORAT ?"</span></li>
        <li><span class="f-icon">💡</span><span><b>Explications</b> — synthèse des comptes rendus de chaque test</span></li>
      </ul>
      <p>Cliquez sur <b>"Ouvrir l'agent"</b> : il s'ouvre dans un nouvel onglet. Aucune installation, gratuit, accessible à tous.</p>
      <div class="nb-modal-cta">
        <a class="nb-btn" href="${NOTEBOOKLM_URL}" target="_blank" rel="noopener noreferrer">🧠 Ouvrir l'agent NotebookLM</a>
        <button class="nb-btn-info" style="width:auto;padding:8px 16px;border-radius:var(--r-pill)" onclick="closeNbModal()">Fermer</button>
      </div>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
var MODELS = ${JSON.stringify(modelsData)};
var LOCAL_SHA = ${JSON.stringify(localSha)};
var REMOTE_REPO = ${JSON.stringify(updateChecker.COMMUNITY_REPO)};

// --- Agent NotebookLM (bandeau + modale + bulle d'info périodique) ---
var NB_SEEN_KEY = 'benchgo_nb_seen';
var NB_TIP = document.getElementById('nbTip');
var NB_MODAL = document.getElementById('nbModal');
function openNbModal() { NB_MODAL.classList.add('show'); document.body.style.overflow = 'hidden'; }
function closeNbModal() { NB_MODAL.classList.remove('show'); document.body.style.overflow = ''; }
document.getElementById('nbInfoBtn').addEventListener('click', openNbModal);
NB_MODAL.addEventListener('click', function(e) { if (e.target === NB_MODAL) closeNbModal(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && NB_MODAL.classList.contains('show')) closeNbModal(); });
// Bulle d'info périodique : s'affiche après 12s la 1re visite, puis toutes les ~5 min
// si l'utilisateur n'a jamais cliqué. Disparait après 6 s.
(function nbBubble() {
  try {
    var seen = sessionStorage.getItem(NB_SEEN_KEY);
    if (seen) return;
  } catch (e) {}
  setTimeout(function() {
    try {
      NB_TIP.classList.add('show');
      setTimeout(function() { NB_TIP.classList.remove('show'); }, 6000);
      try { sessionStorage.setItem(NB_SEEN_KEY, '1'); } catch (e) {}
    } catch (e) {}
  }, 12000);
})();
// Re-affiche la bulle toutes les 5 min tant que l'agent n'a pas été ouvert
setInterval(function() {
  try { if (localStorage.getItem('benchgo_nb_opened')) return; } catch (e) {}
  try {
    NB_TIP.classList.add('show');
    setTimeout(function() { NB_TIP.classList.remove('show'); }, 6000);
  } catch (e) {}
}, 300000);
// Marque l'agent comme "ouvert" quand on clique sur le bouton principal
document.querySelectorAll('.nb-btn[href]').forEach(function(a) {
  a.addEventListener('click', function() { try { localStorage.setItem('benchgo_nb_opened', '1'); } catch (e) {} });
});

// --- Tri par date de dernier test (toggle "🕒 Récents") ---
// MODELS_SORTED_BY_DATE = copie de MODELS triée par lastUpdated décroissant.
// _originalModels = ordre d'origine (par score). Quand le tri récent est actif,
// on permute MODELS pour pointer sur l'ordre trié par date, tout en conservant
// les index via globalRank pour que les opérations (modale, kebab, etc.) restent valides.
var _originalModels = MODELS.slice();
var _recentSortActive = false;

// --- Badge provider (origine du modele : Local / Cloud / provider specifique) ---
// Repli de la version Node (ligne 379-403) pour le JS inline navigateur.
// Affiche un badge colore selon le provider (OpenRouter, OpenAI, Anthropic...)
// au lieu d un "Cloud" generique. Aucun apostrophe (contrainte du projet).
var PROVIDER_DISPLAY = {
  openrouter: { label: 'OpenRouter', icon: '\u{1F500}', color: '#d29922' },
  openai:      { label: 'OpenAI',     icon: '\u{1F7E2}', color: '#10a37f' },
  anthropic:   { label: 'Anthropic', icon: '\u{1F7E3}', color: '#a855f7' },
  groq:        { label: 'Groq',      icon: '\u26A1',    color: '#f55036' },
  together:    { label: 'Together',  icon: '\u{1F91D}', color: '#0f6fff' },
  mistral:     { label: 'Mistral',   icon: '\u{1F32C}', color: '#ff7000' },
  deepseek:    { label: 'DeepSeek',  icon: '\u{1F40B}', color: '#4d6bfe' },
  cohere:      { label: 'Cohere',    icon: '\u{1F517}', color: '#39594d' },
  ollama:      { label: 'Ollama',    icon: '\u{1F999}', color: '#d29922' },
  lmstudio:    { label: 'LM Studio', icon: '\u{1F3E0}', color: '#3fb950' },
  custom:      { label: 'Custom',    icon: '\u2699\uFE0F', color: '#8b949e' }
};
function providerDisplay(provider, isCloud) {
  if (provider && PROVIDER_DISPLAY[provider]) return PROVIDER_DISPLAY[provider];
  if (provider && provider !== 'local') {
    return { label: provider, icon: '\u2601\uFE0F', color: '#d29922' };
  }
  if (isCloud) return { label: 'Cloud', icon: '\u2601\uFE0F', color: '#d29922' };
  return { label: 'Local', icon: '\u{1F3E0}', color: '#3fb950' };
}

// getCategory (replique de la version Node ligne 511) : calcule la categorie
// d un modele en fonction de son rang (position) dans l ensemble affiche.
// Le rang est celui de l ensemble filtre (pas le rang global), pour que
// Top du top = les 3 premiers du filtre actif (ex: 3 premiers cloud).
function _getCategory(pct, rank) {
  if (rank && rank <= 3) return { key: 'top', label: 'Top du top', icon: '\u{1F3C6}' };
  if (pct >= 90) return { key: 'recommande', label: 'Recommandes', icon: '\u2705' };
  if (pct >= 75) return { key: 'moyenne', label: 'Dans la moyenne', icon: '\u{1F4CA}' };
  if (pct >= 50) return { key: 'rattrapage', label: 'En rattrapage', icon: '\u26A0\uFE0F' };
  return { key: 'catastrophe', label: 'Echec total', icon: '\u{1F4A5}' };
}

function formatRelativeDate(isoStr) {
  if (!isoStr) return '—';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return '—';
  var now = new Date();
  var diffMs = now - d;
  var diffMin = Math.floor(diffMs / 60000);
  var diffH = Math.floor(diffMin / 60);
  var diffD = Math.floor(diffH / 24);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return 'il y a ' + diffMin + ' min';
  if (diffH < 24) return 'il y a ' + diffH + ' h';
  if (diffD === 1) return 'hier';
  if (diffD < 7) return 'il y a ' + diffD + ' j';
  // Au-delà d'une semaine : date courte JJ/MM
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '/' + mm;
}

function formatDateShort(isoStr) {
  if (!isoStr) return null;
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var hh = String(d.getHours()).padStart(2, '0');
  var mi = String(d.getMinutes()).padStart(2, '0');
  return dd + '/' + mm + ' ' + hh + ':' + mi;
}

function toggleRecentSort() {
  _recentSortActive = !_recentSortActive;
  var btn = document.getElementById('btnRecentSort');
  if (_recentSortActive) {
    btn.classList.add('active');
    btn.textContent = '🕒 Récents ✓';
    // Trie par lastUpdated décroissant (modèles sans date → à la fin).
    MODELS.sort(function(a, b) {
      var da = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      var db = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return db - da;
    });
  } else {
    btn.classList.remove('active');
    btn.textContent = '🕒 Récents';
    // Restaure l'ordre original (par score).
    MODELS = _originalModels.slice();
  }
  renderCards();
}

function gradeColor(g) {
  var m = { A:'#3fb950', B:'#58a6ff', C:'#d29922', D:'#bc8cff', F:'#f85149' };
  return m[g] || '#8b949e';
}
function pctColor(p) {
  var pct = Math.max(0, Math.min(100, p));
  // Dégradé fluide vert → rouge : 100% = vert (hue 120), 0% = rouge (hue 0).
  // Interpolation linéaire dans l'espace HSL (saturation/lightness constantses
  // pour un rendu vif et lisible sur fond sombre). Évite les 3 paliers discrets
  // (vert/jaune/rouge) au profit d'un dégradé continu où chaque % a sa teinte.
  var hue = pct * 1.2;
  return 'hsl(' + hue.toFixed(0) + ', 72%, 48%)';
}
// Affichage du % : borne à [0, 100] pour éviter les valeurs négatives absurdes
// (ex: -100% si un carnet ancien stocke un pct négatif pour un modèle éliminé).
function dispPct(p) { return Math.max(0, Math.min(100, p)); }
// Formate une durée (ms) en affichage humain compact (identique à fmtDur côté serveur).
function fmtDurJS(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  var s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  var totalSec = Math.round(s);
  var m = Math.floor(totalSec / 60);
  var sec = totalSec % 60;
  if (m < 60) return m + 'm' + String(sec).padStart(2,'0') + 's';
  var h = Math.floor(m / 60);
  var min = m % 60;
  return h + 'h' + String(min).padStart(2,'0') + 'm';
}
// Couleur de la vitesse (tokens/s) : dégradé rouge → jaune → vert.
// Seuils : <10 t/s = rouge (très lent), 10-25 = orange, 25-50 = jaune,
// 50-80 = vert clair, >80 = vert vif. La vitesse ne fait pas tout mais permet
// de comparer la rapidité brute des modèles sur un même matériel.
function tpsColor(tps) {
  if (tps <= 0) return '#8b949e';
  if (tps >= 80) return '#3fb950';
  if (tps >= 50) return '#58a6ff';
  if (tps >= 25) return '#d29922';
  if (tps >= 10) return '#e3b341';
  return '#f85149';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// --- Formatage du tarif cloud estimé (tâche 2026-08-04) ---
// Affichage compact : $0.0012 / $12.34. Pour les très petits montants (<0.01),
// on garde 4 décimales pour rester lisible. IMPORTANT : ce sont des estimations.
var USD_TO_EUR_JS = 0.92;
function fmtCost(usd) {
  if (usd == null || !isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(4);
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}
function fmtCostEur(usd) {
  if (usd == null || !isFinite(usd)) return '—';
  var eur = usd * USD_TO_EUR_JS;
  if (eur === 0) return '€0.00';
  if (eur < 0.01) return '€' + eur.toFixed(4);
  if (eur < 1) return '€' + eur.toFixed(3);
  return '€' + eur.toFixed(2);
}

// --- Flèche de mouvement de position (delta de rang entre 2 générations) ---
//   delta < 0 : le modèle a MONTÉ (rang diminué) → ▲ vert
//   delta > 0 : le modèle a DESCENDU (rang augmenté) → ▼ rouge
//   delta = 0 : position stable → = gris
//   null      : nouveau modèle (pas d'historique) → pas de flèche
function positionArrow(delta) {
  if (delta == null) return '';
  if (delta < 0) return '<span class="pos-arrow pos-up" title="A monté de ' + Math.abs(delta) + ' place(s) depuis la dernière génération">▲' + Math.abs(delta) + '</span>';
  if (delta > 0) return '<span class="pos-arrow pos-down" title="A descendu de ' + delta + ' place(s) depuis la dernière génération">▼' + delta + '</span>';
  return '<span class="pos-arrow pos-stable" title="Position stable">=</span>';
}

// --- Suivi des rapports intégraux déjà exportés ---
// Persiste en localStorage (clé par shortName) pour savoir quels modèles ont
// déjà eu leur rapport .md téléchargé. Survit aux régénérations du classement
// et permet de visualiser d'un coup d'œil où l'on en est dans une session de
// tests longue (beaucoup de modèles, on perd le fil).
var EXPORTED_KEY = 'benchgo_exportedReports_v1';
function getExportedSet() {
  try {
    var raw = localStorage.getItem(EXPORTED_KEY);
    if (!raw) return {};
    var o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) { return {}; }
}
function isExported(shortName) {
  if (!shortName) return false;
  return !!getExportedSet()[shortName];
}
function markExported(shortName) {
  if (!shortName) return;
  try {
    var s = getExportedSet();
    if (s[shortName]) return; // déjà marqué
    s[shortName] = new Date().toISOString();
    localStorage.setItem(EXPORTED_KEY, JSON.stringify(s));
  } catch (e) { /* localStorage indisponible (mode privé) : on ignore */ }
}

function renderCards() {
  console.log('[renderCards] début — MODELS.length=' + (typeof MODELS !== 'undefined' ? MODELS.length : 'UNDEFINED'));
  var catSel = document.getElementById('catSelect');
  var sizeSel = document.getElementById('sizeSelect');
  var healthSel = document.getElementById('healthSelect');
  var ecoleSel = document.getElementById('ecoleSelect');
  var originSel = document.getElementById('originSelect');
  if (!catSel) { console.error('[renderCards] ERREUR : select de catégorie introuvable — le DOM n’est pas prêt.'); return; }
  if (!sizeSel) { console.error('[renderCards] ERREUR : select de taille introuvable.'); return; }
  var activeCat = catSel.value;
  var activeSize = sizeSel.value;
  var activeHealth = healthSel ? healthSel.value : 'all';
  var activeEcole = ecoleSel ? ecoleSel.value : 'all';
  var activeOrigin = originSel ? originSel.value : 'all';
  var searchEl = document.getElementById('search');
  var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  var container = document.getElementById('cards');
  if (!container) { console.error('[renderCards] ERREUR : conteneur #cards introuvable.'); return; }
  container.innerHTML = '';
  var shown = 0;
  var skippedCat = 0, skippedSize = 0, skippedSearch = 0, skippedHealth = 0, skippedEcole = 0;

  // Premier passage : on filtre par TOUS les filtres SAUF la categorie.
  // On calcule le rang filtred (position dans l ensemble affiche) pour chaque
  // modele restant, puis on en deduit sa categorie dynamique. Cela permet
  // a "Top du top" de designer les 3 premiers du filtre actif (ex: 3 premiers
  // cloud) et non les 3 premiers du classement global.
  var _preFiltered = [];
  for (var pi = 0; pi < MODELS.length; pi++) {
    var pm = MODELS[pi];
    var pSizeKey = (pm.paramSize && pm.paramSize.key) ? pm.paramSize.key : '';
    if (activeSize !== 'all' && pSizeKey !== activeSize) continue;
    if (activeHealth !== 'all') {
      var pIsPositif = (pm.globalLifeScore || 0) >= 0;
      if (activeHealth === 'positif' && !pIsPositif) continue;
      if (activeHealth === 'negatif' && pIsPositif) continue;
    }
    if (activeEcole !== 'all') {
      var pHasEcole = (pm.ecoleNames || []).indexOf(activeEcole) !== -1;
      if (!pHasEcole) continue;
    }
    if (activeOrigin !== 'all') {
      if (activeOrigin === 'cloud' && !pm.isCloud) continue;
      if (activeOrigin === 'local' && pm.isCloud) continue;
    }
    if (q && pm.model.toLowerCase().indexOf(q) === -1 && (pm.displayName || '').toLowerCase().indexOf(q) === -1 && pm.shortName.toLowerCase().indexOf(q) === -1 && (pm.quantization || '').toLowerCase().indexOf(q) === -1) continue;
    _preFiltered.push(pm);
  }

  // Calcul des categories dynamiques + compteurs pour le select.
  var _dynamicCats = {};
  var _modelCat = {};
  for (var fi = 0; fi < _preFiltered.length; fi++) {
    var fm = _preFiltered[fi];
    var fRank = fi + 1;
    var dCat = _getCategory(fm.pct, fRank);
    _modelCat[fm.shortName] = dCat;
    _dynamicCats[dCat.key] = (_dynamicCats[dCat.key] || 0) + 1;
  }

  // Mise a jour dynamique des compteurs affiches dans le select categorie.
  // Les labels de base sont stockes en dur (sans compteurs) pour eviter toute
  // accumulation de compteurs (44 (44 (4...)) quelque soit le nombre d appels.
  var _catLabels = {
    all: 'Tous',
    top: '🏆 Top du top',
    recommande: '✅ Recommandés',
    moyenne: '📊 Dans la moyenne',
    rattrapage: '⚠️ En rattrapage',
    catastrophe: '💥 Échec total'
  };
  var _catOpts = catSel.querySelectorAll('option');
  var _catCountTotal = _preFiltered.length;
  for (var ci = 0; ci < _catOpts.length; ci++) {
    var opt = _catOpts[ci];
    var val = opt.value;
    var cnt = val === 'all' ? _catCountTotal : (_dynamicCats[val] || 0);
    opt.textContent = _catLabels[val] + ' (' + cnt + ')';
  }

  // --- Sélecteur Origine = MAÎTRE ---
  // L origine détermine le sous-ensemble de modèles visible : quand on choisit
  // Cloud API, TOUS les autres sélecteurs (Taille, Santé, École, Catégorie) ne
  // doivent compter que les modèles cloud frontière, jamais les locaux, et
  // inversement pour Local. Les deux univers sont étanches.
  // On calcule un ensemble « contexte » = modèles filtrés par l origine active
  // (+ recherche), SANS appliquer les autres filtres, pour remplir les
  // compteurs de chaque select indépendamment.
  var _originCtx = [];
  for (var oi = 0; oi < MODELS.length; oi++) {
    var om = MODELS[oi];
    if (activeOrigin !== 'all') {
      if (activeOrigin === 'cloud' && !om.isCloud) continue;
      if (activeOrigin === 'local' && om.isCloud) continue;
    }
    if (q && om.model.toLowerCase().indexOf(q) === -1 && (om.displayName || '').toLowerCase().indexOf(q) === -1 && om.shortName.toLowerCase().indexOf(q) === -1 && (om.quantization || '').toLowerCase().indexOf(q) === -1) continue;
    _originCtx.push(om);
  }

  // Compteurs Taille / Santé / École calculés sur le contexte d origine.
  var _sizeCounts = { petit: 0, standard: 0, expert: 0, doctorat: 0, inconnu: 0 };
  var _healthCounts = { positif: 0, negatif: 0 };
  var _ecoleCountsDyn = {};
  for (var ci2 = 0; ci2 < _originCtx.length; ci2++) {
    var cm = _originCtx[ci2];
    var cmSizeKey = (cm.paramSize && cm.paramSize.key) ? cm.paramSize.key : 'inconnu';
    _sizeCounts[cmSizeKey] = (_sizeCounts[cmSizeKey] || 0) + 1;
    if ((cm.globalLifeScore || 0) >= 0) _healthCounts.positif++; else _healthCounts.negatif++;
    for (var ei = 0; ei < (cm.ecoleNames || []).length; ei++) {
      var ecName = cm.ecoleNames[ei];
      _ecoleCountsDyn[ecName] = (_ecoleCountsDyn[ecName] || 0) + 1;
    }
  }

  // Compteurs Origine : calculés sur l ensemble complet (filtré par recherche
  // uniquement) pour montrer le total local vs cloud disponibles.
  var _originCounts = { local: 0, cloud: 0 };
  for (var ri = 0; ri < MODELS.length; ri++) {
    var rm = MODELS[ri];
    if (q && rm.model.toLowerCase().indexOf(q) === -1 && (rm.displayName || '').toLowerCase().indexOf(q) === -1 && rm.shortName.toLowerCase().indexOf(q) === -1 && (rm.quantization || '').toLowerCase().indexOf(q) === -1) continue;
    if (rm.isCloud) _originCounts.cloud++; else _originCounts.local++;
  }

  // Mise a jour dynamique du select Taille (compteurs limites au contexte
  // d origine active).
  var _sizeLabels = {
    all: 'Toutes tailles',
    petit: '🐱 < 3B',
    standard: '📦 3B–14B',
    expert: '🎓 14B–30B',
    doctorat: '🧠 > 30B',
    inconnu: '❓ Inconnue'
  };
  var _sizeOpts = sizeSel.querySelectorAll('option');
  for (var si = 0; si < _sizeOpts.length; si++) {
    var sOpt = _sizeOpts[si];
    var sVal = sOpt.value;
    var sCnt = sVal === 'all' ? _originCtx.length : (_sizeCounts[sVal] || 0);
    sOpt.textContent = _sizeLabels[sVal] + ' (' + sCnt + ')';
  }

  // Mise a jour dynamique du select Santé (compteurs limites au contexte
  // d origine active).
  if (healthSel) {
    var _healthLabels = {
      all: 'Toutes',
      positif: '💚 Saine (≥ 0 PV)',
      negatif: '❤️\u200d🩹 En difficulté (< 0 PV)'
    };
    var _healthOpts = healthSel.querySelectorAll('option');
    for (var hi = 0; hi < _healthOpts.length; hi++) {
      var hOpt = _healthOpts[hi];
      var hVal = hOpt.value;
      var hCnt = hVal === 'all' ? _originCtx.length : (_healthCounts[hVal] || 0);
      hOpt.textContent = _healthLabels[hVal] + ' (' + hCnt + ')';
    }
  }

  // Mise a jour dynamique du select École (compteurs limites au contexte
  // d origine active). Les écoles sans modèle dans le contexte sont marquées
  // (0) mais conservées pour éviter de perdre l option selectionnee.
  if (ecoleSel) {
    var _ecoleOpts = ecoleSel.querySelectorAll('option');
    for (var ei2 = 0; ei2 < _ecoleOpts.length; ei2++) {
      var eOpt = _ecoleOpts[ei2];
      var eVal = eOpt.value;
      if (eVal === 'all') {
        eOpt.textContent = 'Toutes écoles (' + _originCtx.length + ')';
      } else {
        var eCnt = _ecoleCountsDyn[eVal] || 0;
        eOpt.textContent = '🏫 ' + eVal + ' (' + eCnt + ')';
      }
    }
  }

  // Mise a jour dynamique du select Origine (compteurs globaux local vs cloud).
  if (originSel) {
    var _originLabels = {
      all: 'Toutes origines',
      local: '🏠 Local · LM Studio',
      cloud: '☁️ Cloud · API'
    };
    var _originOpts = originSel.querySelectorAll('option');
    var _originTotal = _originCounts.local + _originCounts.cloud;
    for (var oi2 = 0; oi2 < _originOpts.length; oi2++) {
      var oOpt = _originOpts[oi2];
      var oVal = oOpt.value;
      var oCnt = oVal === 'all' ? _originTotal : (_originCounts[oVal] || 0);
      oOpt.textContent = _originLabels[oVal] + ' (' + oCnt + ')';
    }
  }

  for (var fi = 0; fi < _preFiltered.length; fi++) {
    var m = _preFiltered[fi];
    var i = MODELS.indexOf(m);
    var dynCat = _modelCat[m.shortName] || m.cat;
    if (activeCat !== 'all' && dynCat.key !== activeCat) { skippedCat++; continue; }
    shown++;

    var globalRank = m.globalRank || (i + 1);
    // En mode tri récent, les médailles/couleurs restent liées au rang global (score).
    var cardClass = globalRank === 1 ? 'gold' : globalRank === 2 ? 'silver' : globalRank === 3 ? 'bronze' : '';
    var rankDisp = globalRank <= 3
      ? '<span class="medal">' + (globalRank === 1 ? '🥇' : globalRank === 2 ? '🥈' : '🥉') + '</span>'
      : shown;
    var posArrow = positionArrow(m.positionDelta);
    var pc = pctColor(m.pct);
    var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
    var gc = gradeColor(m.grade);
    var helpStr = (m.helpCount > 0 || m.retriedCount > 0)
      ? (m.helpCount > 0 ? 'aide:' + m.helpCount : '') + (m.retriedCount > 0 ? (m.helpCount > 0 ? ' ' : '') + 'rat.:' + m.retriedCount : '')
      : '—';
    // Mini-stat vitesse (tokens/s) : affichée seulement si des données de
    // chronométrie existent (carnets récents). Sinon on affiche le temps total.
    var tpsC = tpsColor(m.tokensPerSecond);
    var vitesseVal = m.tokensPerSecond > 0
      ? m.tokensPerSecond + ' t/s'
      : (m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—');
    var vitesseLbl = m.tokensPerSecond > 0 ? 'Vitesse' : 'Temps';
    var szBadge = '<span class="badge" title="' + esc(m.paramSize.label) + '">' + m.paramSize.icon + ' ' + esc(m.paramSize.short) + '</span>';
    // Badge d origine : Local (LM Studio) ou Cloud (API). Cohérent avec le
    // sélecteur d origine qui ne propose que Local/Cloud — pas de label provider
    // spécifique (OpenRouter...) pour éviter la redondance visuelle.
    var originBadge;
    if (m.isCloud) {
      originBadge = ' <span class="badge provider" title="Modèle cloud (API)" style="color:#d29922;border-color:#d2992255;background:#d2992218">☁️ Cloud</span>';
    } else {
      originBadge = ' <span class="badge local" title="Modèle local (LM Studio)">🏠 Local</span>';
    }
    // Badge 📄 : apparaît quand le rapport intégral de ce modèle a déjà été
    // exporté (téléchargé) au moins une fois. Persistance via localStorage
    // (clé par shortName) pour garder le suivi entre deux générations du
    // classement. Cliquez pour retirer la marque (reset).
    var exportedBadge = isExported(m.shortName)
      ? ' <span class="badge exported" title="Rapport intégral déjà exporté (cliquez pour effacer la marque)" onclick="event.stopPropagation();unmarkExported(' + i + ')" style="cursor:pointer">📄 Exporté</span>'
      : '';
    var quantBadge = m.quantization
      ? '<span class="badge quant" title="Quantification du modèle (récupérée via LM Studio /api/v0/models ou saisie manuelle)">🧩 ' + esc(m.quantization) + '</span>'
      : '';
    var noteBadge = m.note
      ? '<span class="badge note" title="Note personnelle — cliquez pour voir">📝 Note</span>'
      : '';
    // Badge de date de dernier test (toujours visible, surtout utile en mode récent).
    var relDate = formatRelativeDate(m.lastUpdated);
    var fullDate = formatDateShort(m.lastUpdated);
    var dateBadge = fullDate
      ? ' <span class="date-badge" title="Dernier test : ' + esc(fullDate) + '">🕒 ' + esc(relDate) + '</span>'
      : '';
    // l'historique des re-tests du carnet. Ne s'affiche que si au moins 2 tentatives.
    var trendBadge = '';
    if (m.trend) {
      var t = m.trend;
      if (t.redoublement) {
        trendBadge = '<span class="badge trend-down" title="Régression de note entre le dernier test et le précédent (mise à jour HF ?)">📉 Redoublement</span>';
      } else if (t.promotion) {
        trendBadge = '<span class="badge trend-up" title="Progression de note entre le dernier test et le précédent">📈 Promotion</span>';
      } else if (t.direction === 'up') {
        trendBadge = '<span class="badge trend-up" title="Progression de ' + t.avgDeltaPct + '% entre le dernier test et le précédent">▲ +' + t.avgDeltaPct + '%</span>';
      } else if (t.direction === 'down') {
        trendBadge = '<span class="badge trend-down" title="Régression de ' + Math.abs(t.avgDeltaPct) + '% entre le dernier test et le précédent (mise à jour HF ?)">▼ ' + t.avgDeltaPct + '%</span>';
      } else {
        trendBadge = '<span class="badge trend-stable" title="Score stable entre les deux derniers tests">═ Stable</span>';
      }
    }

    // Nom affiché : displayName (personnalisé) sinon model (brut). Permet à
    // l utilisateur de corriger le titre quand LM Studio ne donne que le nom
    // de base, pour distinguer les quantifications/paramètres différents.
    var shownName = m.displayName || m.model;
    var html = '<div class="card ' + cardClass + '" onclick="openModal(' + i + ')">' +
      '<div class="card-row">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name">' +
          '<div class="name-line"><span class="cat-icon">' + dynCat.icon + '</span>' + esc(shownName) + posArrow + '</div>' +
          '<div class="badges">' + szBadge + originBadge + ' ' + quantBadge + ' ' + noteBadge + ' ' + trendBadge + exportedBadge + dateBadge + '</div>' +
        '</div>' +
        '<div class="mini-stats">' +
          '<div class="mini-stat"><span class="lbl">%</span><span class="val" style="color:' + pc + '">' + dispPct(m.pct) + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + Math.max(2,dispPct(m.pct)) + '%;background:' + pc + '"></div></div></div>' +
          '<div class="mini-stat"><span class="lbl">Note</span><span class="val grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Santé</span><span class="val" style="color:' + sc + '">' + m.globalLifeScore + ' PV</span></div>' +
          '<div class="mini-stat"><span class="lbl">Oblig.</span><span class="val">' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Aide/Rat.</span><span class="val" style="font-size:var(--fs-tiny)">' + esc(helpStr) + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">' + vitesseLbl + '</span><span class="val" style="color:' + tpsC + ';font-size:var(--fs-tiny)">' + esc(vitesseVal) + '</span></div>' +
          (m.isCloud && m.cost
            ? '<div class="mini-stat" title="Coût estimé (non exact) — voir détail dans la modale"><span class="lbl">Coût ≈</span><span class="val" style="color:#bc8cff;font-size:var(--fs-tiny)">' + fmtCost(m.cost.usd) + '</span></div>'
            : '') +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="kebab" onclick="event.stopPropagation();toggleKebab(this,' + i + ')" aria-label="Actions">⋮</button>' +
          '<div class="kebab-menu" id="kebabMenu' + i + '" data-idx="' + i + '" onclick="event.stopPropagation()">' +
            '<div class="kebab-item" onclick="openModal(' + i + ')">🔍 Détails</div>' +
            '<div class="kebab-item" onclick="copyModelName(' + i + ')">⧉ Copier le nom</div>' +
            '<div class="kebab-item" onclick="exportReport(' + i + ')">⬇ Exporter le rapport intégral</div>' +
            '<div class="kebab-item danger" onclick="deleteModel(' + i + ', this)">🗑 Supprimer du classement</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
    container.insertAdjacentHTML('beforeend', html);
  }
  console.log('[renderCards] fini — affichés=' + shown + '/' + MODELS.length + ' | skip cat=' + skippedCat + ' skip size=' + skippedSize + ' skip health=' + skippedHealth + ' skip ecole=' + skippedEcole + ' skip search=' + skippedSearch);
  document.getElementById('resultCount').textContent = shown + '/' + MODELS.length;
  document.getElementById('emptyMsg').style.display = shown === 0 ? 'block' : 'none';
  // --- Animations d'entrée au scroll (§3 UI/Ludisme) ---
  // Attache un IntersectionObserver aux cartes fraîchement rendues pour déclencher
  // le fondu + translation quand elles entrent dans le viewport. Recréé à chaque
  // renderCards car innerHTML est vidé. Respecte prefers-reduced-motion.
  attachScrollAnimations();
}

// Attache l'IntersectionObserver aux cartes visibles (animations d'entrée §3).
// Les cartes déjà visibles au chargement reçoivent .visible immédiatement.
function attachScrollAnimations() {
  var cards = document.querySelectorAll('#cards .card');
  if (!cards.length) return;
  if (!('IntersectionObserver' in window)) {
    // Repli : tout visible immédiatement (navigateur ancien).
    cards.forEach(function(c) { c.classList.add('visible'); });
    return;
  }
  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { root: null, rootMargin: '0px', threshold: 0.05 });
  cards.forEach(function(c) { io.observe(c); });
}

function openModal(idx) {
  var m = MODELS[idx];
  var posArrowHtml = positionArrow(m.positionDelta);
  var gr = m.globalRank || (idx + 1);
  document.getElementById('mRank').innerHTML = (gr <= 3 ? '<span class="medal">' + (gr === 1 ? '🥇' : gr === 2 ? '🥈' : '🥉') + '</span>' : gr) + posArrowHtml;
  document.getElementById('mTitle').textContent = m.displayName || m.model;
  var vb = document.getElementById('mVerdict');
  vb.textContent = m.verdict.label;
  vb.style.background = m.verdict.color;
  document.getElementById('mCat').innerHTML = m.cat.icon + ' ' + esc(m.cat.label) + ' · ' + m.paramSize.icon + ' ' + esc(m.paramSize.label);

  var pc = pctColor(m.pct);
  var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
  var gc = gradeColor(m.grade);
  var oc = m.mandatoryTotal > 0 ? pctColor(m.mandatoryPct) : '#8b949e';

  var body = '';
  body += '<h3>Statistiques</h3>';
  body += '<div class="full-stats">';
  body += statBox('Points', m.score + ' / ' + m.max);
  body += statBoxBar('% global', dispPct(m.pct) + '%', pc, dispPct(m.pct));
  body += statBox('Note', '<span style="color:' + gc + ';font-size:1.4em">' + m.grade + '</span>');
  body += statBoxBar('Obligatoire', m.mandatoryTotal > 0 ? m.mandatoryPct + '% (' + m.mandatoryPassed + '/' + m.mandatoryTotal + ')' : '—', oc, m.mandatoryPct);
  body += statBox('Santé', '<span style="color:' + sc + '">' + m.globalLifeScore + ' PV</span>');
  body += statBox('Bonus', m.optionalBonus > 0 ? '+' + m.optionalBonus : '—');
  body += statBox('Aide prof.', m.helpCount > 0 ? m.helpCount + 'x' : '—');
  body += statBox('Rattrapage', m.retriedCount > 0 ? m.retriedCount + 'x' : '—');
  body += statBox('Écoles', m.ecoleCount);
  body += statBox('Quantif.', m.quantization ? '<span id="quantStatVal" style="color:#bc8cff">' + esc(m.quantization) + '</span>' : '<span id="quantStatVal">—</span>');
  // --- Chronométrie : durée d'inférence, tokens produits, vitesse moyenne ---
  // Affichés seulement si des données existent (carnets récents post-2026-07-21).
  if (m.elapsedMs > 0 || m.tokens > 0) {
    body += statBox('Temps inf.', fmtDurJS(m.elapsedMs));
    body += statBox('Tokens', m.tokens > 0 ? m.tokens : '—');
    body += statBox('Vitesse', m.tokensPerSecond > 0
      ? '<span style="color:' + tpsColor(m.tokensPerSecond) + '">' + m.tokensPerSecond + ' t/s</span>'
      : '—');
    body += statBox('Temps réel', fmtDurJS(m.wallMs));
  }
  // --- Tarif cloud estimé (tâche 2026-08-04) ---
  // Affiché uniquement pour les modèles cloud payants dont le prix est connu.
  // Les valeurs sont des ESTIMATIONS (cf. mention "≈" et tooltip).
  if (m.isCloud && m.cost) {
    body += statBox('Coût ≈', '<span style="color:#bc8cff" title="Estimation indicative (non exacte). Le coût réel dépend du tokenizer et des tarifs en vigueur.">' + fmtCost(m.cost.usd) + ' / ' + fmtCostEur(m.cost.eur) + '</span>');
  }
  body += '</div>';

  // --- Grille d'actions dans la modale (lien, quantification, placeholders futurs) ---
  // Remplace les sections verticales empilees par 4 colonnes, avec une breve
  // description en dessous de chaque titre. Les colonnes 3 et 4 sont reservees
  // pour des fonctionnalites futures (notes, tags).
  var currentUrl = m.modelUrl || _getModelUrlLocal(m.shortName);
  var currentQuant = m.quantization || _getModelQuantLocal(m.shortName);
  body += '<h3>Actions & métadonnées</h3>';
  body += '<div class="modal-actions-grid">';
  // Colonne 1 : Lien du modèle
  body += '<div class="action-card">';
  body += '<h4>🔗 Lien du modèle</h4>';
  body += '<p>Lien Hugging Face ou LM Studio vers le modèle.</p>';
  body += '<div class="card-content"><div class="model-url-section" id="modelUrlSection">';
  if (currentUrl) {
    body += '<div class="model-url-display"><a href="' + esc(currentUrl) + '" target="_blank" rel="noopener noreferrer" class="model-url-link">🌐 ' + esc(currentUrl) + '</a></div>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelUrl(' + idx + ')">✎ Modifier</button>';
  } else {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucun lien défini. Cliquez sur « Ajouter » pour renseigner l&#39;URL Hugging Face ou LM Studio du modèle.</p>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelUrl(' + idx + ')">+ Ajouter un lien</button>';
  }
  body += '</div></div></div>';
  // Colonne 2 : Quantification (paramètres + sélecteurs bits + variante)
  var currentParamSize = m.paramSizeManual || _getModelParamSizeLocal(m.shortName);
  body += '<div class="action-card">';
  body += '<h4>🧩 Quantification</h4>';
  body += '<p>Paramètres du modèle + variante de compression du GGUF.</p>';
  body += '<div class="card-content">';
  // Sous-section : nombre de paramètres
  body += '<div class="model-params-section" id="modelParamSizeSection" style="margin-bottom:var(--space-xs);padding-bottom:var(--space-xs);border-bottom:1px solid var(--border-soft);">';
  if (currentParamSize) {
    var psDisp = _paramSizeFromValue(currentParamSize);
    body += '<div class="model-params-display"><span class="model-params-value">' + psDisp.icon + ' ' + esc(psDisp.short) + '</span></div>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelParamSize(' + idx + ')">✎ Modifier</button>';
  } else {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Taille non détectée. Cliquez pour la saisir (en B).</p>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelParamSize(' + idx + ')">+ Ajouter</button>';
  }
  body += '</div>';
  // Sous-section : quantification (bits + variante)
  body += '<div class="model-quant-section" id="modelQuantSection">';
  if (currentQuant) {
    body += '<div class="model-quant-display"><span class="model-quant-value">🧩 ' + esc(currentQuant) + '</span></div>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelQuant(' + idx + ')">✎ Modifier</button>';
  } else {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucune quantification renseignée. Cliquez sur « Ajouter » pour la saisir.</p>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelQuant(' + idx + ')">+ Ajouter</button>';
  }
  body += '</div></div></div>';
  // Colonne 3 : Note (annotations personnelles persistantes)
  var currentNote = m.note || _getModelNoteLocal(m.shortName);
  body += '<div class="action-card">';
  body += '<h4>📝 Note</h4>';
  body += '<p>Annotations personnelles sur le modèle.</p>';
  body += '<div class="card-content"><div class="model-note-section" id="modelNoteSection">';
  if (currentNote) {
    body += '<div class="model-note-display"><span class="model-note-value">' + esc(currentNote) + '</span></div>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelNote(' + idx + ')">✎ Modifier</button>';
  } else {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucune note. Cliquez sur « Ajouter » pour annoter ce modèle.</p>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelNote(' + idx + ')">+ Ajouter</button>';
  }
  body += '</div></div></div>';
  // Colonne 4 : Écoles (supprimer une école invalide)
  body += '<div class="action-card">';
  body += '<h4>🏫 Écoles</h4>';
  body += '<p>Supprimer une école inadaptée au nombre de paramètres du modèle.</p>';
  body += '<div class="card-content"><div class="model-ecoles-section" id="modelEcolesSection">';
  var hasInvalid = false;
  for (var ei = 0; ei < m.ecoles.length; ei++) {
    var ec = m.ecoles[ei];
    if (ec.paramValid === false) {
      hasInvalid = true;
      body += '<div class="ecole-delete-item" style="margin-bottom:var(--space-xs);padding:var(--space-xs);background:var(--bg-3);border-radius:var(--r-sm);border:1px solid var(--red);">';
      body += '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-xs);">';
      body += '<span style="color:var(--red);font-size:var(--fs-small);">⚠️ ' + esc(ec.ecole) + ' — ' + esc(ec.paramValidReason || 'Trop avancée') + '</span>';
      body += '<button class="btn btn-danger btn-sm" onclick="deleteEcole(' + idx + ',' + ei + ',this)" title="Supprimer cette école du carnet">🗑 Suppr.</button>';
      body += '</div></div>';
    }
  }
  if (!hasInvalid) {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Toutes les écoles sont adaptées au nombre de paramètres du modèle.</p>';
  }
  body += '</div></div></div>';
  // Colonne 5 : Nom affiché (corriger le titre quand LM Studio ne donne que
  // le nom de base). Permet de distinguer deux modèles au même nom mais
  // quantifications/paramètres différents (ex: "Kai Os Grug 12B Q4_K_S").
  body += '<div class="action-card">';
  body += '<h4>🏷️ Nom affiché</h4>';
  body += '<p>Corriger le titre pour distinguer les modèles au même nom (quantif/paramètres différents).</p>';
  body += '<div class="card-content"><div class="model-displayname-section" id="modelDisplayNameSection">';
  var currentDisplayName = m.displayName && m.displayName !== m.model ? m.displayName : '';
  if (currentDisplayName) {
    body += '<div class="model-displayname-display"><span class="model-displayname-value">🏷️ ' + esc(currentDisplayName) + '</span></div>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelDisplayName(' + idx + ')">✎ Modifier</button>';
  } else {
    body += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Nom brut : <code>' + esc(m.model) + '</code>. Cliquez sur « Ajouter » pour personnaliser le titre affiché.</p>';
    body += '<button class="btn btn-primary btn-sm" onclick="editModelDisplayName(' + idx + ')">+ Ajouter</button>';
  }
  body += '</div></div></div>';
  body += '</div>';

  // --- Section Tendance (progression / régression / redoublement) ---
  // Affichée uniquement si au moins une école a un historique de re-tests.
  if (m.trend) {
    var t = m.trend;
    body += '<h3>📈 Tendance (re-tests)</h3>';
    body += '<div class="full-stats">';
    if (t.redoublement) {
      body += statBox('Verdict', '<span style="color:#f85149;font-weight:700">📉 Redoublement</span>');
    } else if (t.promotion) {
      body += statBox('Verdict', '<span style="color:#3fb950;font-weight:700">📈 Promotion</span>');
    } else if (t.direction === 'up') {
      body += statBox('Verdict', '<span style="color:#3fb950">▲ En progression</span>');
    } else if (t.direction === 'down') {
      body += statBox('Verdict', '<span style="color:#f85149">▼ En régression</span>');
    } else {
      body += statBox('Verdict', '<span style="color:#8b949e">═ Stable</span>');
    }
    body += statBox('Évolution moyenne', (t.avgDeltaPct >= 0 ? '+' : '') + t.avgDeltaPct + '%');
    body += statBox('Écoles avec historique', t.ecoleCount + '/' + m.ecoleCount);
    body += '</div>';
    body += '<p style="color:var(--text-dim);font-size:var(--fs-small);margin-top:var(--space-s);">Comparaison entre le dernier test et le précédent. Une régression peut indiquer qu&#39;une mise à jour du modèle sur Hugging Face a dégradé ses performances.</p>';
  }

  body += '<h3>Forces & Faiblesses</h3>';
  body += '<div class="args-grid">';
  body += argsCol('args-forces', '✅ Forces', m.args.forces);
  body += argsCol('args-weak', '❌ Faiblesses', m.args.faiblesses);
  body += '</div>';
  if (m.args.notes.length > 0) {
    body += '<div class="args-block args-notes" style="margin-top:var(--space-s);">';
    body += '<div class="args-title">ℹ Notes</div><ul class="args-list">';
    for (var n of m.args.notes) body += '<li>' + esc(n) + '</li>';
    body += '</ul></div>';
  }

  body += '<h3>Détail par école</h3>';
  body += '<table class="ecoles-table"><thead><tr>' +
    '<th>École</th><th class="num">Points</th><th>%</th><th>Note</th>' +
    '<th class="num">Bonus</th><th class="num">Santé</th><th class="num">Aide</th><th class="num">Rat.</th><th class="num">Calib.</th>' +
    '<th class="num">Temps</th><th class="num">Vitesse</th><th>Date</th><th>Tent.</th><th>Tendance</th>' +
    '</tr></thead><tbody>';
  for (var e of m.ecoles) {
    var egc = gradeColor(e.grade);
    var epc = pctColor(e.pct);
    var attempts = e.attempts || [];
    var hasHistory = attempts.length > 1;
    var ecoleCell = esc(e.ecole);
    if (hasHistory) {
      ecoleCell += ' <span class="hist-toggle" onclick="toggleHistory(this)" title="Voir l&#39;historique des re-tests">▸ ' + attempts.length + ' tentatives</span>';
    }
    // Vitesse (tokens/s) par école avec couleur selon le dégradé de rapidité.
    var eTpsC = tpsColor(e.tokensPerSecond);
    var eTemps = e.elapsedMs > 0 ? fmtDurJS(e.elapsedMs) : '—';
    var eVitesse = e.tokensPerSecond > 0
      ? '<span style="color:' + eTpsC + '">' + e.tokensPerSecond + ' t/s</span>'
      : '—';
    // Badge de tendance par école (comparaison dernier vs précédent test).
    var trendCell = '—';
    if (e.trend) {
      var et = e.trend;
      if (et.gradeChange === 'redoublement') {
        trendCell = '<span style="color:#f85149" title="Régression de note (' + et.prevGrade + '→' + et.lastGrade + ') le ' + esc(et.lastDate) + '">📉 ' + esc(et.prevGrade) + '→' + esc(et.lastGrade) + '</span>';
      } else if (et.gradeChange === 'promotion') {
        trendCell = '<span style="color:#3fb950" title="Progression de note (' + et.prevGrade + '→' + et.lastGrade + ') le ' + esc(et.lastDate) + '">📈 ' + esc(et.prevGrade) + '→' + esc(et.lastGrade) + '</span>';
      } else if (et.direction === 'up') {
        trendCell = '<span style="color:#3fb950" title="+' + et.deltaPct + '% le ' + esc(et.lastDate) + '">▲ +' + et.deltaPct + '%</span>';
      } else if (et.direction === 'down') {
        trendCell = '<span style="color:#f85149" title="' + et.deltaPct + '% le ' + esc(et.lastDate) + '">▼ ' + et.deltaPct + '%</span>';
      } else {
        trendCell = '<span style="color:#8b949e" title="Stable">═</span>';
      }
    }
    var paramWarn = '';
    if (e.paramValid === false) {
      paramWarn = ' <span class="param-warn" title="' + esc(e.paramValidReason || 'École trop avancée pour ce modèle') + '">⚠️</span>';
    }
    body += '<tr' + (hasHistory ? ' class="ecole-main"' : '') + '>' +
      '<td>' + ecoleCell + paramWarn + '</td>' +
      '<td class="num">' + e.score + '/' + e.max + '</td>' +
      '<td style="color:' + epc + '">' + e.pct + '%</td>' +
      '<td class="grade" style="color:' + egc + '">' + e.grade + '</td>' +
      '<td class="num">' + (e.optionalBonus > 0 ? '+' + e.optionalBonus : '—') + '</td>' +
      '<td class="num">' + e.globalLifeScore + '</td>' +
      '<td class="num">' + (e.helpCount > 0 ? e.helpCount : '—') + '</td>' +
      '<td class="num">' + (e.retriedCount > 0 ? e.retriedCount : '—') + '</td>' +
      '<td class="num">' + (e.calibrationIndex != null ? 'C=' + e.calibrationIndex.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + eTemps + '</td>' +
      '<td class="num">' + eVitesse + '</td>' +
      '<td>' + esc(e.date) + '</td>' +
      '<td class="num">' + attempts.length + '</td>' +
      '<td>' + trendCell + '</td>' +
      '</tr>';
    if (hasHistory) {
      body += '<tr class="hist-row" style="display:none;"><td colspan="14">' +
        '<div class="hist-block">' +
        '<div class="hist-title">Historique des ' + attempts.length + ' tentatives (chronologique) :</div>' +
        '<table class="hist-table"><thead><tr>' +
        '<th>#</th><th class="num">Points</th><th>%</th><th>Note</th>' +
        '<th class="num">Bonus</th><th class="num">Santé</th><th class="num">Aide</th><th class="num">Rat.</th><th class="num">Calib.</th>' +
        '<th class="num">Temps</th><th class="num">Vitesse</th><th>Date</th>' +
        '</tr></thead><tbody>';
      for (var a of attempts) {
        var agc = gradeColor(a.grade);
        var apc = pctColor(a.pct);
        var isBest = (a.pct === e.pct && a.score === e.score);
        var bestTag = isBest ? ' <span class="best-tag" title="Meilleure tentative">★</span>' : '';
        var aTpsC = tpsColor(a.tokensPerSecond);
        var aTemps = a.elapsedMs > 0 ? fmtDurJS(a.elapsedMs) : '—';
        var aVitesse = a.tokensPerSecond > 0
          ? '<span style="color:' + aTpsC + '">' + a.tokensPerSecond + ' t/s</span>'
          : '—';
        body += '<tr' + (isBest ? ' class="hist-best"' : '') + '>' +
          '<td class="num">' + a.n + bestTag + '</td>' +
          '<td class="num">' + a.score + '/' + a.max + '</td>' +
          '<td style="color:' + apc + '">' + a.pct + '%</td>' +
          '<td class="grade" style="color:' + agc + '">' + a.grade + '</td>' +
          '<td class="num">' + (a.optionalBonus > 0 ? '+' + a.optionalBonus : '—') + '</td>' +
          '<td class="num">' + a.globalLifeScore + '</td>' +
          '<td class="num">' + (a.helpCount > 0 ? a.helpCount : '—') + '</td>' +
          '<td class="num">' + (a.retriedCount > 0 ? a.retriedCount : '—') + '</td>' +
          '<td class="num">' + (a.calibrationIndex != null ? 'C=' + a.calibrationIndex.toFixed(2) : '—') + '</td>' +
          '<td class="num">' + aTemps + '</td>' +
          '<td class="num">' + aVitesse + '</td>' +
          '<td>' + esc(a.date) + (a.time ? ' ' + esc(a.time).replace('-', 'h') : '') + '</td>' +
          '</tr>';
      }
      body += '</tbody></table></div></td></tr>';
    }
  }
  body += '</tbody></table>';

  // --- Tarif cloud estimé par école (tâche 2026-08-04) ---
  // Affiché uniquement pour les modèles cloud payants. Les valeurs sont des
  // ESTIMATIONS (cf. pricing.js) : le coût réel dépend du tokenizer et des
  // tarifs en vigueur. On affiche $ et € par école + le total.
  if (m.isCloud && m.cost) {
    body += '<h3>💰 Tarif estimé par école <span style="font-size:var(--fs-small);color:var(--text-dim);font-weight:400">(estimation indicative — non exacte)</span></h3>';
    body += '<table class="ecoles-table"><thead><tr>' +
      '<th>École</th><th class="num">Tokens prompt ≈</th><th class="num">Tokens compl. ≈</th>' +
      '<th class="num">Coût ≈ ($)</th><th class="num">Coût ≈ (€)</th>' +
      '</tr></thead><tbody>';
    for (var e of m.ecoles) {
      var ecCost = null;
      // Calcule le coût par école avec le même prix que le modèle.
      if (m.cost.pricePerMTok && (e.promptTokens || e.completionTokens)) {
        var p = e.promptTokens || 0;
        var c = e.completionTokens || 0;
        var u = (p / 1e6) * m.cost.pricePerMTok.prompt + (c / 1e6) * m.cost.pricePerMTok.completion;
        ecCost = u;
      }
      body += '<tr>' +
        '<td>' + esc(e.ecole) + '</td>' +
        '<td class="num">' + (e.promptTokens || 0).toLocaleString('fr-FR') + '</td>' +
        '<td class="num">' + (e.completionTokens || 0).toLocaleString('fr-FR') + '</td>' +
        '<td class="num">' + (ecCost != null ? fmtCost(ecCost) : '—') + '</td>' +
        '<td class="num">' + (ecCost != null ? fmtCostEur(ecCost) : '—') + '</td>' +
        '</tr>';
    }
    body += '<tr style="font-weight:700;border-top:2px solid var(--border)">' +
      '<td>TOTAL</td>' +
      '<td class="num">' + (m.promptTokens || 0).toLocaleString('fr-FR') + '</td>' +
      '<td class="num">' + (m.completionTokens || 0).toLocaleString('fr-FR') + '</td>' +
      '<td class="num">' + fmtCost(m.cost.usd) + '</td>' +
      '<td class="num">' + fmtCostEur(m.cost.eur) + '</td>' +
      '</tr>';
    body += '</tbody></table>';
    body += '<p style="color:var(--text-dim);font-size:var(--fs-small);margin-top:var(--space-s);">⚠ Estimation indicative basée sur les tokens produits (approximation) et les tarifs publics OpenRouter ou une table locale de fallback. Le coût réel varie selon le tokenizer exact du modèle, le volume de raisonnement et l&#39;évolution des prix. Modèle ' + esc(m.provider) + ' — tarif ≈ ' + fmtCost(m.cost.pricePerMTok ? m.cost.pricePerMTok.prompt : 0) + ' / ' + fmtCost(m.cost.pricePerMTok ? m.cost.pricePerMTok.completion : 0) + ' par million de tokens (prompt / completion).</p>';
  }

  // --- Rapport intégral : tiers, exercices, code, raisonnement, corrections
  body += '<h3>📋 Rapport intégral (comportement & raisonnement)</h3>';
  body += '<div class="report-actions">';
  body += '<button class="btn btn-primary" id="btnExportReport" onclick="exportReport(' + idx + ')" title="Télécharger le rapport intégral (Markdown) prêt à transmettre à Gemini/ChatGPT pour analyse → NotebookLM">⬇ Exporter le rapport intégral</button>';
  body += '<span class="report-actions-hint">Télécharge un fichier .md à envoyer à un modèle cloud (Gemini, ChatGPT…) pour analyse → verdict → NotebookLM.</span>';
  body += '</div>';
  body += '<div class="report-block">';
  var hasAnyTier = false;
  for (var e of m.ecoles) {
    var tiers = e.tiers || [];
    var sp = e.selfProfile;
    if (tiers.length === 0 && !sp) continue;
    hasAnyTier = true;
    body += '<div class="report-school">';
    body += '<div class="report-school-head" onclick="toggleReport(this)"><span class="caret">▶</span><span class="sch-title">🏫 ' + esc(e.ecole) + '</span><span class="exo-pts">' + tiers.length + ' tier(s)</span></div>';
    body += '<div class="report-school-body">';
    if (sp && sp.skills) {
      body += '<div class="report-selfprofile">';
      body += '<div class="sp-title">🧠 Auto-profilage déclaré par le modèle</div><ul>';
      var spLabels = {
        javascript_basics: 'JavaScript — Bases & Algorithmique simple',
        javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
        algorithms_advanced: 'Algorithmes & Structures de données avancées',
        code_debugging: 'Débogage & Sécurité applicative'
      };
      for (var sk in spLabels) {
        var lvl = sp.skills[sk] ? sp.skills[sk].level : '?';
        body += '<li><b>' + esc(spLabels[sk]) + '</b> : niveau ' + lvl + '/5</li>';
      }
      if (sp.justification) body += '<li><i>Justification :</i> ' + esc(sp.justification) + '</li>';
      body += '</ul></div>';
    }
    for (var t of tiers) {
      body += '<div class="report-tier">';
      var mandBadge = t.isMandatory
        ? '<span class="th-badge mand">Obligatoire</span>'
        : '<span class="th-badge opt">Optionnel</span>';
      body += '<div class="report-tier-head" onclick="toggleReport(this)"><span class="caret">▶</span><span class="th-title">Tier ' + esc(String(t.tierNum)) + ' — ' + esc(t.tierTitle || '') + ' (' + esc(t.className || '') + ')</span>' + mandBadge + '</div>';
      body += '<div class="report-tier-body">';
      var evals = t.evalResults || [];
      if (evals.length > 0) {
        body += '<div class="report-exo-label">Exercices tentés (' + evals.length + ')</div>';
        for (var r of evals) {
          var stCls = r.status === 'success' ? 'success' : (r.status === 'bypassed' ? 'bypass' : 'fail');
          var stTxt = r.status === 'success' ? '✔ Validé' : (r.status === 'bypassed' ? '⊘ Bypassé' : '✘ Échec');
          body += '<div class="report-exo">';
          body += '<div class="report-exo-head"><span class="exo-id">' + esc(r.id) + '</span>' + (r.taskType ? '<span class="badge">' + esc(r.taskType) + '</span>' : '') + '<span class="exo-status ' + stCls + '">' + stTxt + '</span><span class="exo-pts">' + r.points + '/' + r.maxPoints + ' pts' + (r.helpUsed ? ' · aide' : '') + (r.retried ? ' · rattrapage' : '') + '</span></div>';
          if (r.status === 'bypassed') { body += '<div class="report-empty">Exercice bypassé (non exécuté).</div>'; body += '</div>'; continue; }
          if (r.code && String(r.code).trim()) {
            body += '<div class="report-exo-label">Code proposé</div>';
            body += '<pre class="report-code">' + esc(String(r.code).trim()) + '</pre>';
          } else {
            body += '<div class="report-empty">Aucun code exploitable produit.</div>';
          }
          if (r.failureExplanation) {
            body += '<div class="report-exo-label">Explication de l\\'échec (par l\\'élève)</div>';
            body += '<div class="report-expl">' + esc(r.failureExplanation) + '</div>';
          }
          if (r.teacherCorrection) {
            body += '<div class="report-exo-label">🎓 Correction du professeur IA</div>';
            body += '<div class="report-teacher">' + esc(r.teacherCorrection) + '</div>';
          }
          body += '</div>';
        }
      } else {
        body += '<div class="report-empty">Aucun exercice enregistré pour ce tier.</div>';
      }
      if (t.rawResponse && String(t.rawResponse).trim()) {
        body += '<div class="report-exo-label">💭 Réponse brute complète du modèle (raisonnement + code)</div>';
        body += '<pre class="report-raw">' + esc(String(t.rawResponse).trim()) + '</pre>';
      }
      body += '</div></div>';
    }
    body += '</div></div>';
  }
  if (!hasAnyTier) {
    body += '<div class="report-empty">Aucun rapport intégral disponible pour ce modèle (données antérieures à l\\'export du raisonnement, ou carnet introuvable).</div>';
  }
  body += '</div>';

  body += '<div class="meta-line">';
  body += 'Dernière mise à jour : ' + esc(m.lastUpdated || '—') + ' · ';
  body += 'Nom court : <code>' + esc(m.shortName) + '</code>';
  body += '</div>';

  document.getElementById('mBody').innerHTML = body;
  document.getElementById('modal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function statBox(lbl, val) {
  return '<div class="full-stat"><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div>';
}
function statBoxBar(lbl, val, color, pct) {
  return '<div class="full-stat"><div class="lbl">' + lbl + '</div><div class="val" style="color:' + color + '">' + val + '</div><div class="bar"><div style="width:' + Math.max(2,pct) + '%;background:' + color + '"></div></div></div>';
}
function argsCol(cls, title, items) {
  var h = '<div class="args-block ' + cls + '"><div class="args-title">' + title + '</div>';
  if (items.length > 0) { h += '<ul class="args-list">'; for (var it of items) h += '<li>' + esc(it) + '</li>'; h += '</ul>'; }
  else h += '<div class="args-empty">Aucun</div>';
  h += '</div>';
  return h;
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
  document.body.style.overflow = '';
}

// --- Gestion du lien du modèle (URL Hugging Face / LM Studio) ---
// Persistance double :
//   - En mode serveur (--serve) : POST /api/model-url → écrit dans le carnet JSON.
//   - En hors-serveur (ouverture locale du HTML) : localStorage (fallback).
// L'URL devinée automatiquement (guessModelUrl) est pré-remplie si l'utilisateur
// n'a rien défini manuellement.
var MODEL_URL_LS_KEY = 'benchgo_model_urls';
function _getModelUrlLocal(shortName) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_URL_LS_KEY) || '{}');
    return map[shortName] || null;
  } catch (e) { return null; }
}
function _setModelUrlLocal(shortName, url) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_URL_LS_KEY) || '{}');
    if (url) map[shortName] = url; else delete map[shortName];
    localStorage.setItem(MODEL_URL_LS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// Ouvre un champ d'édition inline pour l'URL du modèle.
function editModelUrl(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelUrlSection');
  if (!section) return;
  var currentUrl = m.modelUrl || _getModelUrlLocal(m.shortName) || '';
  var html = '<div class="model-url-edit">';
  html += '<input type="url" id="modelUrlInput" class="search" style="width:min(100%,420px)" value="' + esc(currentUrl) + '" placeholder="https://huggingface.co/… ou https://… (URL du modèle)" />';
  html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">';
  html += '<button class="btn btn-primary btn-sm" onclick="saveModelUrl(' + idx + ')">💾 Enregistrer</button>';
  if (currentUrl) html += '<button class="btn btn-sm" onclick="saveModelUrl(' + idx + ',true)" style="background:var(--bg-3);color:var(--red);">🗑 Effacer</button>';
  html += '<button class="btn btn-sm" onclick="cancelEditModelUrl(' + idx + ')" style="background:var(--bg-3);color:var(--text-muted);">Annuler</button>';
  html += '</div></div>';
  section.innerHTML = html;
  var input = document.getElementById('modelUrlInput');
  if (input) { input.focus(); input.select(); }
}

// Annule l'édition et restaure l'affichage normal.
function cancelEditModelUrl(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelUrlSection');
  if (!section) return;
  var url = m.modelUrl || _getModelUrlLocal(m.shortName);
  var html = '';
  if (url) {
    html += '<div class="model-url-display"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="model-url-link">🌐 ' + esc(url) + '</a></div>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelUrl(' + idx + ')">✎ Modifier</button>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucun lien défini. Cliquez sur « Ajouter » pour renseigner l\u0026#39;URL Hugging Face ou LM Studio du modèle.</p>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelUrl(' + idx + ')">+ Ajouter un lien</button>';
  }
  section.innerHTML = html;
}

// Sauvegarde l'URL du modèle (serveur → carnet JSON, ou localStorage en fallback).
function saveModelUrl(idx, erase) {
  var m = MODELS[idx];
  var input = document.getElementById('modelUrlInput');
  var url = erase ? '' : (input ? input.value.trim() : '');
  // Tente d'abord l'API serveur (mode --serve).
  fetch('/api/model-url?shortName=' + encodeURIComponent(m.shortName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelUrl: url })
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (data && data.ok) {
      m.modelUrl = url || null;
      _setModelUrlLocal(m.shortName, url || null);
      cancelEditModelUrl(idx);
      showToast(url ? 'Lien du modèle enregistré (carnet)' : 'Lien du modèle effacé', true);
    } else {
      _saveModelUrlFallback(idx, url);
    }
  }).catch(function() {
    _saveModelUrlFallback(idx, url);
  });
}

// Fallback hors-serveur : localStorage uniquement (pas d'accès au carnet JSON).
function _saveModelUrlFallback(idx, url) {
  var m = MODELS[idx];
  _setModelUrlLocal(m.shortName, url || null);
  m.modelUrl = url || null;
  cancelEditModelUrl(idx);
  showToast(url ? 'Lien enregistré localement (localStorage — lancez --serve pour persister dans le carnet)' : 'Lien effacé (local)', true);
}

// --- Gestion de la quantification manuelle (modale) ---
// Même architecture que le lien du modèle : persistance double (serveur → carnet
// JSON, ou localStorage en fallback). La quantification est essentielle pour
// différencier un même modèle testé sous plusieurs variantes de compression.
var MODEL_QUANT_LS_KEY = 'benchgo_model_quants';
function _getModelQuantLocal(shortName) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_QUANT_LS_KEY) || '{}');
    return map[shortName] || null;
  } catch (e) { return null; }
}
function _setModelQuantLocal(shortName, quant) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_QUANT_LS_KEY) || '{}');
    if (quant) map[shortName] = quant; else delete map[shortName];
    localStorage.setItem(MODEL_QUANT_LS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// Ouvre un champ d'édition inline pour la quantification du modèle.
// Deux sélecteurs en cascade (bits → variante) + fallback texte libre repliable.
var QUANT_BITS = [1, 1.5, 2, 3, 4, 5, 6, 8, 16, 32, 64]
var QUANT_VARIANTS = {
  '1': ['IQ1_S'],
  '1.5': ['IQ1_M'],
  '2': ['IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M', 'Q2_K', 'Q2_K_S', 'Q2_K_M', 'Q2_K_L', 'Q2_K_XL'],
  '3': ['IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q3_K_XL'],
  '4': ['IQ4_XS', 'IQ4_NL', 'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M', 'Q4_K_L', 'Q4_K_XL', 'Q4_0_4_4', 'Q4_0_4_8', 'Q4_0_8_8'],
  '5': ['Q5_0', 'Q5_1', 'Q5_K_S', 'Q5_K_M', 'Q5_K_L'],
  '6': ['Q6_K', 'Q6_K_L'],
  '8': ['Q8_0', 'Q8_1', 'Q8_K', 'I8'],
  '16': ['F16', 'BF16', 'I16'],
  '32': ['F32', 'I32'],
  '64': ['F64', 'I64']
}
// Table inverse variante -> bits, construite depuis QUANT_VARIANTS.
var QUANT_VARIANT_TO_BITS = {}
for (var _bk in QUANT_VARIANTS) {
  for (var _vi = 0; _vi < QUANT_VARIANTS[_bk].length; _vi++) {
    QUANT_VARIANT_TO_BITS[QUANT_VARIANTS[_bk][_vi]] = String(_bk)
  }
}
// Devine le nombre de bits depuis une chaîne de quantification existante.
function _quantBitsFromString(q) {
  if (!q) return ''
  if (QUANT_VARIANT_TO_BITS[q]) return QUANT_VARIANT_TO_BITS[q]
  var m = q.match(/(\d+(?:\.\d+)?)/)
  return m ? m[1] : ''
}
function editModelQuant(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelQuantSection');
  if (!section) return;
  var current = m.quantization || _getModelQuantLocal(m.shortName) || '';
  var currentBits = _quantBitsFromString(current);
  var currentVariant = current || '';
  var html = '<div class="model-quant-edit">';
  // Sélecteur de bits
  html += '<label class="quant-field"><span>Bits</span>';
  html += '<select id="quantBitsSelect" class="search" onchange="onQuantBitsChange(' + idx + ')">';
  html += '<option value="">—</option>';
  for (var b of QUANT_BITS) {
    html += '<option value="' + b + '"' + (currentBits === String(b) ? ' selected' : '') + '>' + b + ' bits</option>'
  }
  html += '</select></label>';
  // Sélecteur de variante (rempli dynamiquement selon les bits)
  html += '<label class="quant-field"><span>Variante</span>';
  html += '<select id="quantVariantSelect" class="search" onchange="onQuantVariantChange(' + idx + ')">';
  html += '<option value="">—</option>';
  if (currentBits && QUANT_VARIANTS[currentBits]) {
    for (var v of QUANT_VARIANTS[currentBits]) {
      html += '<option value="' + esc(v) + '"' + (currentVariant === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    }
  }
  html += '</select></label>';
  // Fallback texte libre (repliable)
  html += '<details class="quant-custom"><summary>Saisie libre</summary>';
  html += '<input type="text" id="modelQuantInput" class="search" style="width:min(100%,280px);margin-top:6px;" value="' + esc(current) + '" placeholder="Format exotique non listé..." oninput="onQuantCustomInput(' + idx + ')" />';
  html += '</details>';
  // Aperçu de la valeur finale
  html += '<div class="quant-preview" id="quantPreview" style="margin-top:6px;font-size:var(--fs-small);color:var(--text-muted);">Valeur : <strong style="color:var(--purple)">' + esc(current || '—') + '</strong></div>';
  // Boutons
  html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">';
  html += '<button class="btn btn-primary btn-sm" onclick="saveModelQuant(' + idx + ')">💾 Enregistrer</button>';
  if (current) html += '<button class="btn btn-sm" onclick="saveModelQuant(' + idx + ',true)" style="background:var(--bg-3);color:var(--red);">🗑 Effacer</button>';
  html += '<button class="btn btn-sm" onclick="cancelEditModelQuant(' + idx + ')" style="background:var(--bg-3);color:var(--text-muted);">Annuler</button>';
  html += '</div></div>';
  section.innerHTML = html;
}
// Remplit le sélecteur de variantes quand l'utilisateur change le nombre de bits.
function onQuantBitsChange(idx) {
  var bitsSel = document.getElementById('quantBitsSelect');
  var varSel = document.getElementById('quantVariantSelect');
  var preview = document.getElementById('quantPreview');
  var bits = bitsSel ? String(bitsSel.value) : ''
  if (varSel) {
    var opts = '<option value="">—</option>'
    if (bits && QUANT_VARIANTS[bits]) {
      for (var v of QUANT_VARIANTS[bits]) {
        opts += '<option value="' + esc(v) + '">' + esc(v) + '</option>'
      }
    }
    varSel.innerHTML = opts
  }
  if (preview) {
    var val = (varSel && varSel.value) ? varSel.value : '—';
    preview.innerHTML = 'Valeur : <strong style="color:var(--purple)">' + esc(val) + '</strong>';
  }
}
// Met à jour l'aperçu quand la variante change.
function onQuantVariantChange(idx) {
  var varSel = document.getElementById('quantVariantSelect');
  var preview = document.getElementById('quantPreview');
  var input = document.getElementById('modelQuantInput');
  var val = varSel ? varSel.value : '';
  if (input && val) input.value = val;
  if (preview) preview.innerHTML = 'Valeur : <strong style="color:var(--purple)">' + esc(val || '—') + '</strong>';
}
// Met à jour l'aperçu (et désélectionne les sélecteurs) en cas de saisie libre.
function onQuantCustomInput(idx) {
  var input = document.getElementById('modelQuantInput');
  var preview = document.getElementById('quantPreview');
  var val = input ? input.value.trim() : '';
  if (preview) preview.innerHTML = 'Valeur : <strong style="color:var(--purple)">' + esc(val || '—') + '</strong>';
}

// Annule l'édition et restaure l'affichage normal de la quantification.
function cancelEditModelQuant(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelQuantSection');
  if (!section) return;
  var quant = m.quantization || _getModelQuantLocal(m.shortName);
  var html = '';
  if (quant) {
    html += '<div class="model-quant-display"><span class="model-quant-value">🧩 ' + esc(quant) + '</span></div>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelQuant(' + idx + ')">✎ Modifier</button>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucune quantification renseignée. Cliquez sur « Ajouter » pour la saisir (ex : Q4_K_M, Q5_K_L, Q8_0, F16...).</p>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelQuant(' + idx + ')">+ Ajouter</button>';
  }
  section.innerHTML = html;
}

// Sauvegarde la quantification (serveur → carnet JSON, ou localStorage en fallback).
// La valeur provient du sélecteur de variante, ou à défaut du champ texte libre.
function saveModelQuant(idx, erase) {
  var m = MODELS[idx];
  var varSel = document.getElementById('quantVariantSelect');
  var input = document.getElementById('modelQuantInput');
  var quant = '';
  if (!erase) {
    if (varSel && varSel.value) {
      quant = varSel.value.trim();
    } else if (input) {
      quant = input.value.trim();
    }
  }
  fetch('/api/model-quantization?shortName=' + encodeURIComponent(m.shortName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantization: quant })
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (data && data.ok) {
      m.quantization = quant || null;
      _setModelQuantLocal(m.shortName, quant || null);
      cancelEditModelQuant(idx);
      _refreshQuantDisplay(idx);
      renderCards();
      showToast(quant ? 'Quantification enregistrée (carnet)' : 'Quantification effacée', true);
    } else {
      _saveModelQuantFallback(idx, quant);
    }
  }).catch(function() {
    _saveModelQuantFallback(idx, quant);
  });
}

// Rafraîchit toutes les zones d'affichage de la quantification dans la modale
// (statBox en haut + carte d'action) après une sauvegarde/effacement.
function _refreshQuantDisplay(idx) {
  var m = MODELS[idx];
  var stat = document.getElementById('quantStatVal');
  if (stat) {
    stat.innerHTML = m.quantization ? esc(m.quantization) : '—';
    stat.style.color = m.quantization ? '#bc8cff' : '';
  }
}

// Fallback hors-serveur : localStorage uniquement.
function _saveModelQuantFallback(idx, quant) {
  var m = MODELS[idx];
  _setModelQuantLocal(m.shortName, quant || null);
  m.quantization = quant || null;
  cancelEditModelQuant(idx);
  _refreshQuantDisplay(idx);
  renderCards();
  showToast(quant ? 'Quantification enregistrée localement (localStorage — lancez --serve pour persister dans le carnet)' : 'Quantification effacée (local)', true);
}

// --- Gestion de la note personnelle (modale) ---
// Même architecture que le lien et la quantification : persistance double
// (serveur → carnet JSON, ou localStorage en fallback).
var MODEL_NOTE_LS_KEY = 'benchgo_model_notes';
function _getModelNoteLocal(shortName) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_NOTE_LS_KEY) || '{}');
    return map[shortName] || null;
  } catch (e) { return null; }
}
function _setModelNoteLocal(shortName, note) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_NOTE_LS_KEY) || '{}');
    if (note) map[shortName] = note; else delete map[shortName];
    localStorage.setItem(MODEL_NOTE_LS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// Ouvre un champ d'édition inline (textarea) pour la note du modèle.
function editModelNote(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelNoteSection');
  if (!section) return;
  var current = m.note || _getModelNoteLocal(m.shortName) || '';
  var html = '<div class="model-note-edit">';
  html += '<textarea id="modelNoteInput" class="search" style="width:100%;min-height:80px;resize:vertical;font-family:inherit;" placeholder="Note personnelle sur ce modèle...">' + esc(current) + '</textarea>';
  html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">';
  html += '<button class="btn btn-primary btn-sm" onclick="saveModelNote(' + idx + ')">💾 Enregistrer</button>';
  if (current) html += '<button class="btn btn-sm" onclick="saveModelNote(' + idx + ',true)" style="background:var(--bg-3);color:var(--red);">🗑 Effacer</button>';
  html += '<button class="btn btn-sm" onclick="cancelEditModelNote(' + idx + ')" style="background:var(--bg-3);color:var(--text-muted);">Annuler</button>';
  html += '</div></div>';
  section.innerHTML = html;
  var ta = document.getElementById('modelNoteInput');
  if (ta) {
    ta.focus();
  }
}

// Annule l'édition et restaure l'affichage normal de la note.
function cancelEditModelNote(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelNoteSection');
  if (!section) return;
  var note = m.note || _getModelNoteLocal(m.shortName);
  var html = '';
  if (note) {
    html += '<div class="model-note-display"><span class="model-note-value">' + esc(note) + '</span></div>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelNote(' + idx + ')">✎ Modifier</button>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Aucune note. Cliquez sur « Ajouter » pour annoter ce modèle.</p>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelNote(' + idx + ')">+ Ajouter</button>';
  }
  section.innerHTML = html;
}

// Sauvegarde la note (serveur → carnet JSON, ou localStorage en fallback).
function saveModelNote(idx, erase) {
  var m = MODELS[idx];
  var ta = document.getElementById('modelNoteInput');
  var note = erase ? '' : (ta ? ta.value.trim() : '');
  fetch('/api/model-note?shortName=' + encodeURIComponent(m.shortName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note })
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (data && data.ok) {
      m.note = note || null;
      _setModelNoteLocal(m.shortName, note || null);
      cancelEditModelNote(idx);
      renderCards();
      showToast(note ? 'Note enregistrée (carnet)' : 'Note effacée', true);
    } else {
      _saveModelNoteFallback(idx, note);
    }
  }).catch(function() {
    _saveModelNoteFallback(idx, note);
  });
}

// Fallback hors-serveur : localStorage uniquement.
function _saveModelNoteFallback(idx, note) {
  var m = MODELS[idx];
  _setModelNoteLocal(m.shortName, note || null);
  m.note = note || null;
  cancelEditModelNote(idx);
  renderCards();
  showToast(note ? 'Note enregistrée localement (localStorage — lancez --serve pour persister dans le carnet)' : 'Note effacée (local)', true);
}

// --- Gestion du nombre de paramètres manuel (modale) ---
// Même architecture : persistance double (serveur → carnet, ou localStorage).
var MODEL_PARAMSIZE_LS_KEY = 'benchgo_model_paramsizes';
function _getModelParamSizeLocal(shortName) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_PARAMSIZE_LS_KEY) || '{}');
    return map[shortName] || null;
  } catch (e) { return null; }
}
function _setModelParamSizeLocal(shortName, val) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_PARAMSIZE_LS_KEY) || '{}');
    if (val) map[shortName] = val; else delete map[shortName];
    localStorage.setItem(MODEL_PARAMSIZE_LS_KEY, JSON.stringify(map));
  } catch (e) {}
}
// Reconstruit l'objet paramSize côté client à partir d'une valeur numérique.
function _paramSizeFromValue(val) {
  var n = parseFloat(val);
  if (!isFinite(n) || n <= 0) return { key: 'inconnu', label: 'Taille inconnue', short: '?B', icon: '❓', paramSize: null };
  if (n < 3)   return { key: 'petit',    label: 'Petit (< 3B)',    short: n + 'B', icon: '🐱', paramSize: n };
  if (n <= 15) return { key: 'standard', label: 'Standard (3B–15B)', short: n + 'B', icon: '📦', paramSize: n };
  if (n <= 30) return { key: 'expert',   label: 'Expert (15B–30B)',  short: n + 'B', icon: '🎓', paramSize: n };
  return             { key: 'doctorat', label: 'Doctorat (> 30B)',   short: n + 'B', icon: '🧠', paramSize: n };
}
function editModelParamSize(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelParamSizeSection');
  if (!section) return;
  var current = m.paramSizeManual || _getModelParamSizeLocal(m.shortName) || '';
  var html = '<div class="model-params-edit">';
  html += '<input type="number" id="modelParamSizeInput" class="search" style="width:min(100%,200px)" value="' + esc(current) + '" placeholder="14" min="0.5" max="500" step="0.5" />';
  html += '<span style="font-size:var(--fs-small);color:var(--text-muted);">milliards de paramètres (B)</span>';
  html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">';
  html += '<button class="btn btn-primary btn-sm" onclick="saveModelParamSize(' + idx + ')">💾 Enregistrer</button>';
  if (current) html += '<button class="btn btn-sm" onclick="saveModelParamSize(' + idx + ',true)" style="background:var(--bg-3);color:var(--red);">🗑 Effacer</button>';
  html += '<button class="btn btn-sm" onclick="cancelEditModelParamSize(' + idx + ')" style="background:var(--bg-3);color:var(--text-muted);">Annuler</button>';
  html += '</div></div>';
  section.innerHTML = html;
  var input = document.getElementById('modelParamSizeInput');
  if (input) { input.focus(); input.select(); }
}
function cancelEditModelParamSize(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelParamSizeSection');
  if (!section) return;
  var val = m.paramSizeManual || _getModelParamSizeLocal(m.shortName);
  var html = '';
  if (val) {
    var ps = _paramSizeFromValue(val);
    html += '<div class="model-params-display"><span class="model-params-value">' + ps.icon + ' ' + esc(ps.short) + '</span></div>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelParamSize(' + idx + ')">✎ Modifier</button>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Taille non détectée. Cliquez pour la saisir (en milliards de paramètres).</p>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelParamSize(' + idx + ')">+ Ajouter</button>';
  }
  section.innerHTML = html;
}
function saveModelParamSize(idx, erase) {
  var m = MODELS[idx];
  var input = document.getElementById('modelParamSizeInput');
  var val = erase ? '' : (input ? input.value.trim() : '');
  fetch('/api/model-paramsize?shortName=' + encodeURIComponent(m.shortName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paramSize: val })
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (data && data.ok) {
      m.paramSizeManual = val || null;
      _setModelParamSizeLocal(m.shortName, val || null);
      if (val) m.paramSize = _paramSizeFromValue(val);
      cancelEditModelParamSize(idx);
      renderCards();
      showToast(val ? 'Paramètres enregistrés (carnet)' : 'Paramètres effacés', true);
    } else {
      _saveModelParamSizeFallback(idx, val);
    }
  }).catch(function() {
    _saveModelParamSizeFallback(idx, val);
  });
}
function _saveModelParamSizeFallback(idx, val) {
  var m = MODELS[idx];
  _setModelParamSizeLocal(m.shortName, val || null);
  m.paramSizeManual = val || null;
  if (val) m.paramSize = _paramSizeFromValue(val);
  cancelEditModelParamSize(idx);
  renderCards();
  showToast(val ? 'Paramètres enregistrés localement (localStorage — lancez --serve pour persister dans le carnet)' : 'Paramètres effacés (local)', true);
}

// --- Gestion du nom d'affichage personnalisé (modale) ---
// Même architecture que le lien/quantification/note : persistance double
// (serveur → carnet JSON, ou localStorage en fallback). Permet de corriger
// le titre affiché quand LM Studio ne fournit que le nom de base (ex: "Phi 4"
// au lieu de "Phi 4 15B Q5_K_L"), pour distinguer plusieurs modèles au même
// nom mais quantifications/paramètres différents dans le leaderboard.
var MODEL_DISPLAYNAME_LS_KEY = 'benchgo_model_displaynames';
function _getModelDisplayNameLocal(shortName) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_DISPLAYNAME_LS_KEY) || '{}');
    return map[shortName] || null;
  } catch (e) { return null; }
}
function _setModelDisplayNameLocal(shortName, name) {
  try {
    var map = JSON.parse(localStorage.getItem(MODEL_DISPLAYNAME_LS_KEY) || '{}');
    if (name) map[shortName] = name; else delete map[shortName];
    localStorage.setItem(MODEL_DISPLAYNAME_LS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// Ouvre un champ d'édition inline (input) pour le nom affiché du modèle.
// Pré-rempli avec le displayName actuel, ou une suggestion basée sur le nom
// brute + quantification si disponible.
function editModelDisplayName(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelDisplayNameSection');
  if (!section) return;
  var current = m.displayName || _getModelDisplayNameLocal(m.shortName) || '';
  // Suggestion : nom brute + quantification si pas déjà présent.
  var suggestion = '';
  if (!current) {
    var base = m.model || '';
    var q = m.quantization || '';
    if (q && base.toLowerCase().indexOf(q.toLowerCase()) === -1) {
      suggestion = base + ' ' + q;
    } else {
      suggestion = base;
    }
  }
  var html = '<div class="model-displayname-edit">';
  html += '<input type="text" id="modelDisplayNameInput" class="search" style="width:100%" value="' + esc(current || suggestion) + '" placeholder="Ex: Kai Os Grug 12B Q4_K_S" maxlength="120" />';
  html += '<span style="font-size:var(--fs-tiny);color:var(--text-muted);">Nom brut : <code>' + esc(m.model) + '</code> — laisser vide pour revenir au nom brut.</span>';
  html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">';
  html += '<button class="btn btn-primary btn-sm" onclick="saveModelDisplayName(' + idx + ')">💾 Enregistrer</button>';
  if (current) html += '<button class="btn btn-sm" onclick="saveModelDisplayName(' + idx + ',true)" style="background:var(--bg-3);color:var(--red);">🗑 Effacer</button>';
  html += '<button class="btn btn-sm" onclick="cancelEditModelDisplayName(' + idx + ')" style="background:var(--bg-3);color:var(--text-muted);">Annuler</button>';
  html += '</div></div>';
  section.innerHTML = html;
  var input = document.getElementById('modelDisplayNameInput');
  if (input) { input.focus(); input.select(); }
}

// Annule l'édition et restaure l'affichage normal du nom.
function cancelEditModelDisplayName(idx) {
  var m = MODELS[idx];
  var section = document.getElementById('modelDisplayNameSection');
  if (!section) return;
  var name = m.displayName || _getModelDisplayNameLocal(m.shortName);
  var html = '';
  if (name && name !== m.model) {
    html += '<div class="model-displayname-display"><span class="model-displayname-value">🏷️ ' + esc(name) + '</span></div>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelDisplayName(' + idx + ')">✎ Modifier</button>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:var(--fs-small);">Nom brut : <code>' + esc(m.model) + '</code>. Cliquez sur « Ajouter » pour personnaliser le titre affiché.</p>';
    html += '<button class="btn btn-primary btn-sm" onclick="editModelDisplayName(' + idx + ')">+ Ajouter</button>';
  }
  section.innerHTML = html;
}

// Sauvegarde le nom affiché (serveur → carnet JSON, ou localStorage en fallback).
// Met à jour m.displayName et le titre de la modale + la carte immédiatement.
function saveModelDisplayName(idx, erase) {
  var m = MODELS[idx];
  var input = document.getElementById('modelDisplayNameInput');
  var name = erase ? '' : (input ? input.value.trim() : '');
  fetch('/api/model-displayname?shortName=' + encodeURIComponent(m.shortName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: name })
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (data && data.ok) {
      m.displayName = name || null;
      _setModelDisplayNameLocal(m.shortName, name || null);
      var titleEl = document.getElementById('mTitle');
      if (titleEl) titleEl.textContent = name || m.model;
      cancelEditModelDisplayName(idx);
      renderCards();
      showToast(name ? 'Nom affichage enregistré (carnet)' : 'Nom réinitialisé au nom brut', true);
    } else {
      _saveModelDisplayNameFallback(idx, name);
    }
  }).catch(function() {
    _saveModelDisplayNameFallback(idx, name);
  });
}

// Fallback hors-serveur : localStorage uniquement.
function _saveModelDisplayNameFallback(idx, name) {
  var m = MODELS[idx];
  _setModelDisplayNameLocal(m.shortName, name || null);
  m.displayName = name || null;
  var titleEl = document.getElementById('mTitle');
  if (titleEl) titleEl.textContent = name || m.model;
  cancelEditModelDisplayName(idx);
  renderCards();
  showToast(name ? 'Nom affichage enregistré localement (localStorage — lancez --serve pour persister dans le carnet)' : 'Nom réinitialisé (local)', true);
}
function toggleHistory(el) {
  var mainRow = el.closest('tr.ecole-main');
  if (!mainRow) return;
  var histRow = mainRow.nextElementSibling;
  if (!histRow || !histRow.classList.contains('hist-row')) return;
  var shown = histRow.style.display !== 'none';
  histRow.style.display = shown ? 'none' : 'table-row';
  el.textContent = (shown ? '▸' : '▾') + ' ' + (el.getAttribute('data-n') || (el.textContent.match(/(\d+)/) || [,''])[1]) + ' tentatives';
  el.setAttribute('data-n', el.textContent.match(/(\d+)/) ? el.textContent.match(/(\d+)/)[1] : '');
}
// Plier/déplier les sections du rapport intégral (école + tier) dans la modale.
// el = en-tête cliqué (.report-school-head ou .report-tier-head) ; le body est
// le prochain sibling. La classe .open fait pivoter le caret et affiche le body.
function toggleReport(el) {
  var body = el.nextElementSibling;
  if (!body) return;
  var isOpen = body.classList.toggle('open');
  el.classList.toggle('open', isOpen);
}
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

document.getElementById('catSelect').addEventListener('change', renderCards);
document.getElementById('sizeSelect').addEventListener('change', renderCards);
document.getElementById('search').addEventListener('input', renderCards);
var _healthSel = document.getElementById('healthSelect');
if (_healthSel) _healthSel.addEventListener('change', renderCards);
var _ecoleSel = document.getElementById('ecoleSelect');
if (_ecoleSel) _ecoleSel.addEventListener('change', renderCards);
var _originSel = document.getElementById('originSelect');
if (_originSel) _originSel.addEventListener('change', function() {
  // Origine = sélecteur maître : changer d origine réinitialise les autres
  // filtres (Catégorie, Taille, Santé, École) à « all » pour éviter les
  // combinaisons vides (ex: taille « petit » inexistante chez les cloud).
  // L utilisateur repart de l ensemble complet du nouvel univers et affine.
  var _c = document.getElementById('catSelect'); if (_c) _c.value = 'all';
  var _s = document.getElementById('sizeSelect'); if (_s) _s.value = 'all';
  var _h = document.getElementById('healthSelect'); if (_h) _h.value = 'all';
  var _e = document.getElementById('ecoleSelect'); if (_e) _e.value = 'all';
  renderCards();
});
var _recentBtn = document.getElementById('btnRecentSort');
if (_recentBtn) _recentBtn.addEventListener('click', toggleRecentSort);

// Ferme les menus ⋮ ouverts quand on clique ailleurs.
document.addEventListener('click', function(e) {
  var openMenu = document.querySelector('.kebab-menu.show');
  if (!openMenu) return;
  var btn = document.querySelector('.kebab.active');
  if (btn && (e.target === btn || btn.contains(e.target))) return;
  openMenu.classList.remove('show');
  if (btn) btn.classList.remove('active');
  document.querySelectorAll('.card.menu-open').forEach(function(c) { c.classList.remove('menu-open'); });
});

function toggleKebab(btn, idx) {
  var menu = document.getElementById('kebabMenu' + idx);
  if (!menu) return;
  var isOpen = menu.classList.contains('show');
  // Ferme tous les autres
  document.querySelectorAll('.kebab-menu.show').forEach(function(m) { m.classList.remove('show'); });
  document.querySelectorAll('.kebab.active').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.card.menu-open').forEach(function(c) { c.classList.remove('menu-open'); });
  if (!isOpen) {
    menu.classList.add('show');
    btn.classList.add('active');
    var card = btn.closest('.card');
    if (card) card.classList.add('menu-open');
  }
}

function showToast(msg, ok) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(function(){ t.className = 'toast ' + (ok ? 'ok' : 'err'); }, 2500);
}
function deleteModel(idx, btn) {
  var shortName = MODELS[idx].shortName;
  if (!confirm('Supprimer le modèle "' + shortName + '" du classement ?\\nLe carnet de scores sera définitivement supprimé.')) return;
  btn.disabled = true;
  btn.textContent = '…';
  fetch('/api/delete?shortName=' + encodeURIComponent(shortName), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { showToast('Modèle supprimé — classement régénéré', true); setTimeout(function(){ location.reload(); }, 800); }
      else { showToast('Erreur : ' + (data.error || 'inconnue'), false); btn.disabled = false; btn.textContent = '🗑'; }
    })
    .catch(function(err) {
      // Erreur réseau = le HTML a été ouvert en file:// (double-clic) sans serveur.
      // Le fetch vers /api/delete ne peut pas résoudre sans serveur HTTP local.
      var isFileProtocol = (location.protocol === 'file:');
      var msg = isFileProtocol
        ? 'Suppression impossible : ouvrez le classement via le serveur (node leaderboard.js --serve) — le bouton 🗑 nécessite un serveur local.'
        : 'Erreur réseau : serveur injoignable. Relancez node leaderboard.js --serve.';
      showToast(msg, false);
      btn.disabled = false;
      btn.textContent = '🗑';
    });
}

function deleteEcole(idx, ecoleIdx, btn) {
  var m = MODELS[idx];
  var ecoleName = m.ecoles[ecoleIdx].ecole;
  if (!confirm('Supprimer l\u2019\u00e9cole "' + ecoleName + '" du carnet de "' + m.shortName + '" ?\\nLes r\u00e9sultats de cette \u00e9cole seront d\u00e9finitivement supprim\u00e9s.')) return;
  btn.disabled = true;
  btn.textContent = '…';
  fetch('/api/delete-ecole?shortName=' + encodeURIComponent(m.shortName) + '&ecole=' + encodeURIComponent(ecoleName), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { showToast('École "' + ecoleName + '" supprimée — classement régénéré', true); setTimeout(function(){ location.reload(); }, 800); }
      else { showToast('Erreur : ' + (data.error || 'inconnue'), false); btn.disabled = false; btn.textContent = '🗑 Suppr.'; }
    })
    .catch(function(err) {
      var isFileProtocol = (location.protocol === 'file:');
      var msg = isFileProtocol
        ? 'Suppression impossible : ouvrez le classement via le serveur (node leaderboard.js --serve).'
        : 'Erreur réseau : serveur injoignable. Relancez node leaderboard.js --serve.';
      showToast(msg, false);
      btn.disabled = false;
      btn.textContent = '🗑 Suppr.';
    });
}

function copyModelName(idx) {
  var name = MODELS[idx].model;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(name).then(function() { showToast('Nom copié : ' + name, true); }, function() { fallbackCopy(name); });
  } else { fallbackCopy(name); }
}

// --- Export PNG du classement (§3 UI/Ludisme) ---
// --- Export CSV du classement ---
// Génère un CSV à partir des données MODELS côté client (aucune dépendance
// externe). Inclut toutes les colonnes visibles : rang, modèle, quantif, %,
// note, points, obligatoire, santé, bonus, écoles, vitesse, temps.
function exportLeaderboardCsv() {
  var rows = [['Rang','Modèle','Quantification','Score','Max','%','Note','Obligatoire %','Obligatoire (passé/total)','Santé (PV)','Bonus','Écoles','Vitesse (t/s)','Temps inf.','Temps réel']];
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    rows.push([
      String(i + 1),
      csvCell(m.model),
      csvCell(m.quantization || ''),
      String(m.score),
      String(m.max),
      String(dispPct(m.pct)),
      m.grade,
      m.mandatoryTotal > 0 ? String(m.mandatoryPct) : '',
      m.mandatoryTotal > 0 ? (m.mandatoryPassed + '/' + m.mandatoryTotal) : '',
      String(m.globalLifeScore),
      m.optionalBonus > 0 ? String(m.optionalBonus) : '0',
      String(m.ecoleCount),
      m.tokensPerSecond > 0 ? String(m.tokensPerSecond) : '',
      m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '',
      m.wallMs > 0 ? fmtDurJS(m.wallMs) : ''
    ]);
  }
  var csv = rows.map(function(r) { return r.join(','); }).join('\\n');
  downloadTextFile(csv, 'classement_benchgo_' + new Date().toISOString().slice(0,10) + '.csv', 'text/csv;charset=utf-8');
  showToast('CSV exporté (' + MODELS.length + ' modèles)', true);
}

// --- Export Markdown (tableau) du classement ---
// Génère un tableau Markdown formaté à partir des données MODELS.
function exportLeaderboardMd() {
  var lines = [];
  lines.push('# Classement BenchGo V3 — ' + new Date().toLocaleDateString('fr-FR'));
  lines.push('');
  lines.push('| Rang | Modèle | Quantif. | Score | % | Note | Oblig. | Santé | Bonus | Écoles | Vitesse | Temps |');
  lines.push('|------|--------|----------|-------|---|------|--------|-------|-------|--------|---------|-------|');
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    var vit = m.tokensPerSecond > 0 ? (m.tokensPerSecond + ' t/s') : (m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—');
    var temps = m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—';
    var oblig = m.mandatoryTotal > 0 ? (m.mandatoryPct + '%') : '—';
    lines.push('| ' + medal + ' | ' + mdCell(m.model) + ' | ' + mdCell(m.quantization || '—') + ' | ' + m.score + '/' + m.max + ' | ' + dispPct(m.pct) + '% | ' + m.grade + ' | ' + oblig + ' | ' + m.globalLifeScore + ' PV | ' + (m.optionalBonus > 0 ? '+' + m.optionalBonus : '—') + ' | ' + m.ecoleCount + ' | ' + vit + ' | ' + temps + ' |');
  }
  lines.push('');
  downloadTextFile(lines.join('\\n'), 'classement_benchgo_' + new Date().toISOString().slice(0,10) + '.md', 'text/markdown;charset=utf-8');
  showToast('Markdown exporté (' + MODELS.length + ' modèles)', true);
}

// Échappe une cellule CSV (guillemets doubles si virgule ou guillemet).
function csvCell(s) {
  s = String(s == null ? '' : s);
  if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\\n') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
// Échappe une cellule Markdown (pipe → \|).
function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}
// Télécharge un texte en fichier (Blob).
function downloadTextFile(content, filename, mimeType) {
  var blob = new Blob(['\ufeff' + content], { type: mimeType || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
}

// --- Export PDF du classement (§3 UI/Ludisme) ---
// Utilise window.print() : le navigateur propose l'enregistrement en PDF. On
// ajoute une media-query print pour masquer la sticky-bar et la modale et
// n'imprimer que les cartes. Simple, fiable, sans dépendance.
function exportLeaderboardPdf() {
  showToast("Dialogue d'impression ouvert — choisissez « Enregistrer en PDF »", true);
  window.print();
}

// Exporte le rapport intégral d'un modèle : déclenche le téléchargement d'un
// fichier Markdown généré à la volée par le serveur (/api/report?shortName=...).
// Le fichier contient l'auto-profilage, toutes les écoles, tous les tiers, tous
// les exercices avec code + explications + corrections + réponses brutes.
// Il est conçu pour être transmis à un modèle cloud (Gemini, ChatGPT, Claude…)
// qui l'analysera puis produira un verdict à injecter dans NotebookLM.
function exportReport(idx) {
  var m = MODELS[idx];
  var shortName = encodeURIComponent(m.shortName);
  var btn = document.getElementById('btnExportReport');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération…'; }
  // Désactive le mode serveur (ouverture locale du HTML) : on construit le MD
  // côté client à partir des données déjà présentes dans MODELS, puis on
  // déclenche le téléchargement via un Blob. En mode --serve, on fetch le
  // serveur qui génère le MD complet (idem raisonnement_modeles.md par modèle).
  function downloadBlob(md, filename) {
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    showToast('Rapport téléchargé : ' + filename, true);
    // Marque ce modèle comme « rapport déjà exporté » (persistance localStorage)
    // pour faire apparaître le badge 📄 sur sa carte du leaderboard.
    markExported(m.shortName);
    // Rafraîchit la carte correspondante si elle est visible pour faire
    // apparaître le badge immédiatement, sans tout re-rendre.
    var card = document.querySelector('.card[onclick*="openModal(' + idx + ')"]');
    if (card && !card.querySelector('.badge.exported')) {
      var badgesEl = card.querySelector('.badges');
      if (badgesEl) {
        var b = document.createElement('span');
        b.className = 'badge exported';
        b.title = 'Rapport intégral déjà exporté (cliquez pour effacer la marque)';
        b.style.cursor = 'pointer';
        b.setAttribute('onclick', 'event.stopPropagation();unmarkExported(' + idx + ')');
        b.textContent = '📄 Exporté';
        // Inséré avant le bouton "⧉ Nom" pour rester avec les badges.
        var nomBtn = badgesEl.querySelector('.btn-icon');
        if (nomBtn) badgesEl.insertBefore(b, nomBtn);
        else badgesEl.appendChild(b);
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Exporter le rapport intégral'; }
  }
  function clientFallback() {
    // Repli : génère un MD minimal côté client (les données MODELS contiennent
    // déjà les tiers/exercices/code/rawResponse). Moins riche que la version
    // serveur mais fonctionnel si on ouvre le HTML sans serveur.
    var md = '# Rapport intégral — ' + m.model + '\\n\\n';
    md += '**Nom court :** ' + m.shortName + '\\n';
    md += '- Score global : ' + m.score + '/' + m.max + ' (' + m.pct + '%) — Note ' + m.grade + '\\n';
    md += '- Quantification : ' + (m.quantization || '—') + '\\n\\n';
    for (var i = 0; i < m.ecoles.length; i++) {
      var ec = m.ecoles[i];
      md += '### École : ' + ec.ecole + '\\n\\n';
      if (ec.selfProfile && ec.selfProfile.skills) {
        md += '#### Auto-profilage déclaré\\n';
        var sp = ec.selfProfile.skills;
        md += '- javascript_basics : ' + (sp.javascript_basics ? sp.javascript_basics.level : '?') + '/5\\n';
        md += '- javascript_async : ' + (sp.javascript_async ? sp.javascript_async.level : '?') + '/5\\n';
        md += '- algorithms_advanced : ' + (sp.algorithms_advanced ? sp.algorithms_advanced.level : '?') + '/5\\n';
        md += '- code_debugging : ' + (sp.code_debugging ? sp.code_debugging.level : '?') + '/5\\n';
        if (ec.selfProfile.justification) md += '- Justification : ' + ec.selfProfile.justification + '\\n';
        md += '\\n';
      }
      for (var j = 0; j < (ec.tiers || []).length; j++) {
        var t = ec.tiers[j];
        md += '#### Tier ' + t.tierNum + ' — ' + (t.tierTitle || '') + ' (' + (t.className || '') + ')\\n\\n';
        md += '- Statut : ' + (t.isMandatory ? 'Obligatoire' : 'Optionnel') + '\\n\\n';
        var evals = t.evalResults || [];
        if (evals.length > 0) {
          md += '| Exercice | Type | Points | Max | Statut |\\n|---|---|---:|---:|---|\\n';
          for (var k = 0; k < evals.length; k++) {
            var r = evals[k];
            var st = r.status === 'success' ? '✔ Validé' : (r.status === 'bypassed' ? '⊘ Bypassé' : '✘ Échec');
            md += '| ' + r.id + ' | ' + (r.taskType || '—') + ' | ' + r.points + ' | ' + r.maxPoints + ' | ' + st + ' |\\n';
          }
          md += '\\n';
          for (var k2 = 0; k2 < evals.length; k2++) {
            var r2 = evals[k2];
            if (r2.status === 'bypassed') continue;
            md += '**Exercice ' + r2.id + '** (' + (r2.status === 'success' ? 'validé' : 'échec') + ')\\n\\n';
            if (r2.code && String(r2.code).trim()) md += '\`\`\`javascript\\n' + String(r2.code).trim() + '\\n\`\`\`\\n\\n';
            if (r2.failureExplanation) md += '**Explication échec :** ' + r2.failureExplanation + '\\n\\n';
            if (r2.teacherCorrection) md += '**🎓 Correction professeur :** ' + r2.teacherCorrection + '\\n\\n';
          }
        }
        if (t.rawResponse && String(t.rawResponse).trim()) md += '##### Réponse brute\\n\\n\`\`\`text\\n' + String(t.rawResponse).trim() + '\\n\`\`\`\\n\\n';
      }
      md += '---\\n\\n';
    }
    var safe = String(m.shortName || 'modele').replace(/[^a-zA-Z0-9._-]/g, '_');
    var d = new Date();
    var p = function(n){ return String(n).padStart(2,'0'); };
    var fn = 'rapport_integral_' + safe + '_' + d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '.md';
    downloadBlob(md, fn);
  }
  // Tente d'abord le serveur (rapport complet identique à raisonnement_modeles.md).
  fetch('/api/report?shortName=' + shortName)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var cd = r.headers.get('Content-Disposition') || '';
      var mFn = cd.match(/filename="([^"]+)"/);
      var filename = mFn ? mFn[1] : ('rapport_integral_' + m.shortName + '.md');
      return r.text().then(function(txt) { downloadBlob(txt, filename); });
    })
    .catch(function(err) {
      // Hors serveur (ouverture locale du fichier HTML) ou serveur injoignable.
      clientFallback();
    });
}
// Retire la marque « rapport exporté » pour un modèle (clic sur le badge 📄
// de la carte). Permet de repartir à zéro si on veut re-tester/re-exporter.
function unmarkExported(idx) {
  var m = MODELS[idx];
  if (!m || !m.shortName) return;
  try {
    var s = getExportedSet();
    delete s[m.shortName];
    localStorage.setItem(EXPORTED_KEY, JSON.stringify(s));
  } catch (e) {}
  renderCards();
  showToast('Marque d\u2019export effacée pour ' + m.shortName, true);
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('Nom copié : ' + text, true); }
  catch (e) { showToast('Copie impossible', false); }
  document.body.removeChild(ta);
}

function copyLeaderboard() {
  var btn = document.getElementById('btnCopyAll');
  var activeCat = document.getElementById('catSelect').value;
  var activeSize = document.getElementById('sizeSelect').value;
  var q = document.getElementById('search').value.trim().toLowerCase();

  var lines = [];
  lines.push('🏇 Classement BenchGo V3 — ' + new Date().toLocaleString('fr-FR'));
  lines.push('Filtre catégorie : ' + (activeCat === 'all' ? 'tous' : activeCat) + ' | Taille : ' + (activeSize === 'all' ? 'toutes' : activeSize) + (q ? ' | Recherche : ' + q : ''));
  lines.push('');
  lines.push('Rang | Modèle | Quantif. | Points | % | Note | Mvt | Oblig. | Santé | Écoles | Temps | Vitesse | Verdict');
  lines.push('---|---|---|---|---|---|---|---|---|---|---|---|---');
  var copied = 0;
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    if (activeCat !== 'all' && m.cat.key !== activeCat) continue;
    if (activeSize !== 'all' && m.paramSize.key !== activeSize) continue;
    if (q && m.model.toLowerCase().indexOf(q) === -1 && (m.displayName || '').toLowerCase().indexOf(q) === -1 && m.shortName.toLowerCase().indexOf(q) === -1 && (m.quantization || '').toLowerCase().indexOf(q) === -1) continue;
    var rank = copied < 3 ? ['🥇','🥈','🥉'][copied] : ('' + (copied + 1));
    var temps = m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—';
    var vit = m.tokensPerSecond > 0 ? (m.tokensPerSecond + ' t/s') : '—';
    // Flèche de mouvement de position (delta de rang vs snapshot précédent).
    var mvt;
    if (m.positionDelta == null) { mvt = 'NEW'; }
    else if (m.positionDelta < 0) { mvt = '▲' + Math.abs(m.positionDelta); }
    else if (m.positionDelta > 0) { mvt = '▼' + m.positionDelta; }
    else { mvt = '='; }
    lines.push(rank + ' | ' + m.model + ' | ' + (m.quantization || '—') + ' | ' + m.score + '/' + m.max + ' | ' + m.pct + '% | ' + m.grade + ' | ' + mvt + ' | ' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + ' | ' + m.globalLifeScore + ' PV | ' + m.ecoleCount + ' | ' + temps + ' | ' + vit + ' | ' + m.verdict.label);
    copied++;
  }
  lines.push('');
  lines.push('Total : ' + copied + ' modèle(s) — généré par BenchGo V3');

  var text = lines.join('\\n');
  var finish = function(ok) {
    if (ok) {
      showToast('Classement copié (' + copied + ' modèle' + (copied > 1 ? 's' : '') + ')', true);
      if (btn) { btn.classList.add('done'); btn.textContent = '✓ Copié !'; setTimeout(function(){ btn.classList.remove('done'); btn.textContent = '⧉ Copier le classement'; }, 2000); }
    } else {
      showToast('Copie impossible', false);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){ finish(true); }, function(){ fallbackCopy(text); finish(true); });
  } else {
    fallbackCopy(text); finish(true);
  }
}
document.getElementById('btnCopyAll').addEventListener('click', copyLeaderboard);

// --- Bouton "Envoyer à la communauté" ---
// Ouvre une modale permettant de soumettre tous les carnets de scores du classement
// vers le dépôt communautaire GitHub via une Pull Request. Nécessite un token GitHub.
var submitModal = null;
function openSubmitModal() {
  if (submitModal) { document.body.removeChild(submitModal); submitModal = null; return; }
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.id = 'submitOverlay';
  overlay.innerHTML = ''
    + '<div class="modal" style="max-width: 600px;">'
    + '  <div class="modal-head">'
    + '    <h2>🌐 Envoyer à la communauté</h2>'
    + '    <button class="modal-close" onclick="closeSubmitModal()" aria-label="Fermer">x</button>'
    + '  </div>'
    + '  <div class="modal-body" style="padding: 24px;">'
    + '    <p style="color: var(--text-muted); margin-bottom: 16px;">'
    + '      Soumettez vos carnets de scores au classement communautaire sur GitHub.<br>'
    + '      Une Pull Request sera creee automatiquement. Le proprietaire validera votre contribution.<br>'
    + '      <strong style="color: var(--accent);">Seuls les modeles pas encore soumis seront envoyes.</strong>'
    + '    </p>'
    + '    <div style="margin-bottom: 16px;">'
    + '      <label style="display: block; margin-bottom: 6px; font-weight: 600;">Token GitHub (PAT, scope repo)</label>'
    + '      <input type="password" id="submitToken" placeholder="ghp_xxxxxxxxxxxx" style="width: 100%; padding: 10px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: monospace;" />'
    + '      <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">'
    + '        Pas encore de token ? '
    + '        <a href="https://github.com/settings/tokens/new?scopes=repo&description=BenchGo-LLM-School" target="_blank" '
    + '           style="color: var(--accent); text-decoration: underline;">Creez-en un ici</a> '
    + '        (connectez-vous a votre compte GitHub, cochez le scope "repo", puis Generate token). '
    + '        <a href="https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" target="_blank" '
    + '           style="color: var(--text-muted); text-decoration: underline;">Aide GitHub</a>'
    + '      </p>'
    + '    </div>'
    + '    <div style="margin-bottom: 16px;">'
    + '      <label style="display: block; margin-bottom: 6px; font-weight: 600;">Pseudo public (optionnel)</label>'
    + '      <input type="text" id="submitPseudo" placeholder="Votre pseudo (ou laissez vide pour anonyme)" style="width: 100%; padding: 10px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px; color: var(--text);" />'
    + '    </div>'
    + '    <div style="margin-bottom: 16px;">'
    + '      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">'
    + '        <input type="checkbox" id="submitRemember" checked style="accent-color: var(--accent);" />'
    + '        <span>Memoriser le token pour les prochaines fois</span>'
    + '      </label>'
    + '    </div>'
    + '    <div id="submitStatus" style="margin-bottom: 12px;"></div>'
    + '    <div style="display: flex; gap: 12px;">'
    + '      <button class="btn btn-community" id="btnDoSubmit" onclick="doSubmitAll()" style="flex: 1; justify-content: center;">Verifier et envoyer</button>'
    + '      <button class="btn" onclick="closeSubmitModal()" style="padding: 8px 16px;">Annuler</button>'
    + '    </div>'
    + '  </div>'
    + '</div>';
  document.body.appendChild(overlay);
  submitModal = overlay;
}
function closeSubmitModal() {
  if (submitModal) { document.body.removeChild(submitModal); submitModal = null; }
}
async function doSubmitAll() {
  var token = document.getElementById('submitToken').value.trim();
  var pseudo = document.getElementById('submitPseudo').value.trim();
  var remember = document.getElementById('submitRemember').checked;
  var statusEl = document.getElementById('submitStatus');
  var btn = document.getElementById('btnDoSubmit');
  // Helper : affiche un spinner (cercle qui tourne) + un message dans la zone
  // de statut. Utilise une icone CSS (.submit-spinner definie plus haut dans
  // la feuille de style). show=false pour cacher le spinner (message final).
  // IMPORTANT : pas d apostrophe dans ces chaines (contrainte du projet) —
  // on reste en guillemets simples pour le HTML, doubles pour les attributs.
  function setSubmitStatus(message, color, showSpinner) {
    var sp = showSpinner ? '<span class="submit-spinner"></span>' : '';
    var col = color || 'var(--accent)';
    statusEl.innerHTML = '<p style="color: ' + col + '; display: flex; align-items: center; gap: 0;">' + sp + '<span>' + message + '</span></p>';
  }
  if (!token) { statusEl.innerHTML = '<p style="color: var(--red);">Token GitHub requis.</p>'; return; }
  btn.disabled = true; btn.textContent = 'Verification...';
  setSubmitStatus('Validation du token...', 'var(--accent)', true);
  try {
    var valRes = await fetch('/api/submit-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    });
    var valData = await valRes.json();
    if (!valData.valid) { statusEl.innerHTML = '<p style="color: var(--red);">Token invalide : ' + esc(valData.error || 'verifiez les permissions') + '</p>'; btn.disabled = false; btn.textContent = 'Reessayer'; return; }
    setSubmitStatus('Token valide (' + esc(valData.login || '') + '). Comparaison des carnets locaux avec GitHub...', 'var(--green)', true);
    // Étape 1 : récupère la liste des modèles déjà soumis (pour distinguer nouveaux vs mises à jour).
    var subRes = await fetch('/api/already-submitted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    });
    var subData = await subRes.json();
    var alreadySubmitted = new Set(subData.ok ? (subData.submitted || []) : []);
    // Étape 2 : compare chaque carnet local avec sa soumission GitHub.
    // /api/submit-check renvoie { changed: [...], unchanged: [...], newModels: [...] }.
    var allShortNames = MODELS.map(function(m) { return m.shortName; });
    setSubmitStatus('Comparaison de ' + allShortNames.length + ' modele(s) avec GitHub (peut prendre 1-2 min)...', 'var(--accent)', true);
    var checkRes = await fetch('/api/submit-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, shortNames: allShortNames })
    });
    var checkData = await checkRes.json();
    var changedSet = new Set(checkData.ok ? (checkData.changed || []) : []);
    var newSet = new Set(checkData.ok ? (checkData.newModels || []) : []);
    var unchangedCount = checkData.ok ? (checkData.unchanged || []).length : 0;
    // On n'envoie que les modèles nouveaux ou modifiés.
    var toSubmit = [];
    for (var i = 0; i < MODELS.length; i++) {
      var sn = MODELS[i].shortName;
      if (newSet.has(sn) || changedSet.has(sn)) {
        toSubmit.push(MODELS[i]);
      }
    }
    if (toSubmit.length === 0) {
      statusEl.innerHTML = '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--bg-3);">'
        + '<p style="color: var(--green); font-weight: 600;">Tout est à jour !</p>'
        + '<p style="margin-top: 8px; font-size: 13px; color: var(--text-muted);">' + unchangedCount + ' modèle(s) déjà soumis et identique(s) au carnet local.</p>'
        + '<p style="margin-top: 4px; font-size: 13px; color: var(--text-muted);">Aucune modification à envoyer. Modifiez un modèle (quantification, note...) ou testez un nouveau modèle, puis revenez soumettre.</p>'
        + '</div>';
      btn.textContent = 'Terminé'; btn.disabled = false;
      btn.onclick = closeSubmitModal;
      return;
    }
    var newCount = toSubmit.filter(function(m) { return newSet.has(m.shortName); }).length;
    var updateCount = toSubmit.filter(function(m) { return changedSet.has(m.shortName); }).length;
    setSubmitStatus(toSubmit.length + ' modele(s) a envoyer (' + newCount + ' nouveau(x), ' + updateCount + ' mise(s) a jour, ' + unchangedCount + ' inchange(s)). Envoi en cours...', 'var(--accent)', true);
    var okCount = 0, failCount = 0, prUrls = [];
    for (var j = 0; j < toSubmit.length; j++) {
      var m = toSubmit[j];
      var isUpdate = changedSet.has(m.shortName);
      setSubmitStatus('Envoi ' + (j + 1) + '/' + toSubmit.length + ' : ' + esc(m.shortName) + (isUpdate ? ' (mise a jour)' : ' (nouveau)') + '...', 'var(--accent)', true);
      try {
        var res = await fetch('/api/submit?shortName=' + encodeURIComponent(m.shortName), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pseudo: pseudo, token: token })
        });
        var data = await res.json();
        if (data.ok) { okCount++; if (data.prUrl) prUrls.push(data.prUrl); }
        else { failCount++; }
      } catch (e) { failCount++; }
    }
    if (remember) { /* le serveur a déjà mémorisé le token si demandé */ }
    var html = '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--bg-3);">';
    html += '<p style="color: var(--green); font-weight: 600;">' + okCount + ' soumission(s) réussie(s)';
    if (failCount > 0) html += ', ' + failCount + ' échec(s)';
    if (newCount > 0) html += ', ' + newCount + ' nouveau(x)';
    if (updateCount > 0) html += ', ' + updateCount + ' mise(s) à jour';
    if (unchangedCount > 0) html += ', ' + unchangedCount + ' inchangé(s) (ignorés)';
    html += '</p>';
    if (prUrls.length > 0) {
      html += '<p style="margin-top: 8px; font-size: 13px; color: var(--text-muted);">Pull Requests creees :</p>';
      for (var u = 0; u < prUrls.length; u++) {
        html += '<p style="margin: 4px 0;"><a href="' + esc(prUrls[u]) + '" target="_blank" style="color: var(--accent);">' + esc(prUrls[u]) + '</a></p>';
      }
    }
    html += '<p style="margin-top: 8px; font-size: 13px; color: var(--text-muted);">Les PR sont mergées automatiquement (résultats JSON, pas de code à valider).</p>';
    html += '</div>';
    statusEl.innerHTML = html;
    btn.textContent = 'Termine'; btn.disabled = false;
    btn.onclick = closeSubmitModal;
  } catch (e) {
    statusEl.innerHTML = '<p style="color: var(--red);">Erreur : ' + esc(e.message) + '</p>';
    btn.disabled = false; btn.textContent = 'Reessayer';
  }
}
document.getElementById('btnSubmitCommunity').addEventListener('click', openSubmitModal);
document.getElementById('btnCommunityRanking').addEventListener('click', function() {
  window.open('https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html', '_blank');
});
var _btnPdf = document.getElementById('btnExportPdf');
if (_btnPdf) _btnPdf.addEventListener('click', exportLeaderboardPdf);
var _btnCsv = document.getElementById('btnExportCsv');
if (_btnCsv) _btnCsv.addEventListener('click', exportLeaderboardCsv);
var _btnMd = document.getElementById('btnExportMd');
if (_btnMd) _btnMd.addEventListener('click', exportLeaderboardMd);

// Barre sticky : ajoute la classe .stuck dès qu'on scrolle pour renforcer le
// contraste (fond + opaque + ombre) et signaler visuellement le "détachement".
(function() {
  var bar = document.getElementById('stickyBar');
  if (!bar) return;
  function onScroll() {
    if (window.scrollY > 4) bar.classList.add('stuck');
    else bar.classList.remove('stuck');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// Au chargement de la page, on fusionne les valeurs du localStorage
// (quantification, lien, note) dans le tableau MODELS. Sans cette étape, un
// simple refresh de la page recharge le HTML statique (généré au démarrage du
// serveur) qui ne contient pas les modifications saisies via la modale depuis.
// Le localStorage sert de cache côté navigateur entre deux régénérations.
(function _mergeLocalOverrides() {
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    var lsQuant = _getModelQuantLocal(m.shortName);
    var lsUrl = _getModelUrlLocal(m.shortName);
    var lsNote = _getModelNoteLocal(m.shortName);
    var lsParam = _getModelParamSizeLocal(m.shortName);
    if (lsQuant) m.quantization = lsQuant;
    if (lsUrl) m.modelUrl = lsUrl;
    if (lsNote) m.note = lsNote;
    if (lsParam) {
      m.paramSizeManual = lsParam;
      m.paramSize = _paramSizeFromValue(lsParam);
    }
  }
})();

renderCards();

// --- Bannière de mise à jour disponible ---
// Compare le SHA du commit local (embarqué à la génération) avec le dernier
// commit poussé sur la branche main du dépôt GitHub. Si différent, affiche une
// bannière visuelle pour inciter l'utilisateur a faire 'git pull'.
// Cache localStorage 1h pour ne pas spammer l'API GitHub a chaque ouverture.
(function() {
  if (!LOCAL_SHA || !REMOTE_REPO) return;
  var banner = document.getElementById('updateBanner');
  if (!banner) return;
  var closeBtn = document.getElementById('updateClose');
  var commitsList = document.getElementById('updateCommits');

  // Cache localStorage : évite de re-vérifier pendant 1h et mémorise le
  // refus de l'utilisateur (bouton ✕) jusqu'à expiration du cache.
  var CACHE_KEY = 'benchgo_update_check';
  var TTL_MS = 60 * 60 * 1000;
  function readCache() {
    try { var v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return v; }
    catch (e) { return null; }
  }
  function writeCache(v) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (e) {} }

  var cached = readCache();
  if (cached && cached.dismissedAt && (Date.now() - cached.dismissedAt) < TTL_MS) {
    // L'utilisateur a masqué l'avis récemment → on ne réaffiche pas.
    return;
  }
  if (cached && cached.checkedAt && (Date.now() - cached.checkedAt) < TTL_MS && cached.result) {
    if (cached.result.updateAvailable) showBanner(cached.result.commits || []);
    return;
  }

  // Requête API GitHub publique (anonyme, pas de token).
  fetch('https://api.github.com/repos/' + REMOTE_REPO.owner + '/' + REMOTE_REPO.repo + '/commits/main', {
    headers: { 'Accept': 'application/vnd.github+json' }
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
    if (!data || !data.sha) { writeCache({ checkedAt: Date.now(), result: { updateAvailable: false } }); return; }
    var updateAvailable = data.sha !== LOCAL_SHA;
    var result = { updateAvailable: updateAvailable, remoteSha: data.sha, commits: [] };
    if (!updateAvailable) { writeCache({ checkedAt: Date.now(), result: result }); return; }
    // Récupère les 5 derniers commits pour l'aperçu « Quoi de neuf ».
    fetch('https://api.github.com/repos/' + REMOTE_REPO.owner + '/' + REMOTE_REPO.repo + '/commits?per_page=5', {
      headers: { 'Accept': 'application/vnd.github+json' }
    }).then(function(r) { return r.ok ? r.json() : []; }).then(function(list) {
      result.commits = (list || []).map(function(c) {
        return {
          message: (c.commit && c.commit.message || '').split('\\n')[0].slice(0, 120),
          date: c.commit && c.commit.author ? c.commit.author.date : null
        };
      });
      writeCache({ checkedAt: Date.now(), result: result });
      showBanner(result.commits);
    }).catch(function() {
      writeCache({ checkedAt: Date.now(), result: result });
      showBanner([]);
    });
  }).catch(function() {
    // Pas de réseau → on n'affiche rien (échec silencieux).
  });

  function showBanner(commits) {
    var c = readCache();
    if (c && c.dismissedAt && (Date.now() - c.dismissedAt) < TTL_MS) return;
    if (commits && commits.length && commitsList) {
      commitsList.innerHTML = '';
      commits.forEach(function(c) {
        var li = document.createElement('li');
        var d = c.date ? c.date.slice(0, 10) : '';
        var spanD = document.createElement('span');
        spanD.className = 'cdate'; spanD.textContent = d;
        var spanM = document.createElement('span');
        spanM.textContent = c.message || '(sans message)';
        li.appendChild(spanD); li.appendChild(spanM);
        commitsList.appendChild(li);
      });
    }
    banner.hidden = false;
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      banner.hidden = true;
      var c = readCache() || {};
      c.dismissedAt = Date.now();
      writeCache(c);
    });
  }
})();
</script>
</body>
</html>`;

  return html;
}

function buildLeaderboardMarkdown(entries) {
  let md = `# 🏇 Classement BenchGo V3\n\n`;
  md += `> Généré le ${new Date().toLocaleString('fr-FR')} — ${entries.length} modèle(s) classé(s)\n\n`;
  md += `| Rang | Modèle | Quantif. | Points | % | Note | Mvt | Oblig. | Santé | Bonus | Aide | Rat. | Écoles | Temps | Vitesse | Coût ≈ | Verdict | Forces & Faiblesses |\n`;
  md += `|---:|---|:---:|---|---:|:---:|:---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|---|\n`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const verdict = getVerdict(e, i + 1);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);

    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    const quant = e.quantization || '—';
    const temps = e.elapsedMs > 0 ? formatDuration(e.elapsedMs) : '—';
    const vit = e.tokensPerSecond > 0 ? (e.tokensPerSecond + ' t/s') : '—';
    // Tarif cloud estimé (tâche 2026-08-04). "—" pour les modèles locaux ou
    // dont le prix est introuvable.
    const cout = (e.isCloud && e.cost) ? (pricing.formatUsd(e.cost.usd) + ' / ' + pricing.formatEur(e.cost.usd)) : '—';
    // Flèche de mouvement de position (delta de rang vs snapshot précédent).
    let mvt;
    if (e.positionDelta == null) {
      mvt = '🆕 NEW';
    } else if (e.positionDelta < 0) {
      mvt = '▲' + Math.abs(e.positionDelta);
    } else if (e.positionDelta > 0) {
      mvt = '▼' + e.positionDelta;
    } else {
      mvt = '=';
    }
    const argsText = [];
    if (args.forces.length > 0) argsText.push('**Forces :** ' + args.forces.join(', '));
    if (args.faiblesses.length > 0) argsText.push('**Faiblesses :** ' + args.faiblesses.join(', '));
    if (args.notes.length > 0) argsText.push('*' + args.notes.join(', ') + '*');

    md += `| ${medal} | ${e.displayName || e.model} | ${quant} | ${e.score}/${e.max} | ${e.pct}% | ${grade.grade} | ${mvt} | ${e.mandatoryTotal > 0 ? e.mandatoryPct + '%' : '—'} | ${e.globalLifeScore} | ${e.optionalBonus > 0 ? '+' + e.optionalBonus : '—'} | ${e.helpCount || '—'} | ${e.retriedCount || '—'} | ${e.ecoleCount} | ${temps} | ${vit} | ${cout} | ${verdict.label} | ${argsText.join(' · ')} |\n`;
  }

  md += `\n---\n\n## Détail par modèle\n\n`;
  entries.forEach((e, idx) => {
    const verdict = getVerdict(e, idx + 1);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    md += `### ${e.displayName || e.model}\n\n`;
    md += `- **Quantification :** ${e.quantization || '—'}\n`;
    md += `- **Score global :** ${e.score}/${e.max} (${e.pct}%) — Note ${grade.grade}\n`;
    md += `- **Obligatoire :** ${e.mandatoryTotal > 0 ? e.mandatoryPassed + '/' + e.mandatoryTotal + ' (' + e.mandatoryPct + '%)' : 'N/A'}\n`;
    md += `- **Santé :** ${e.globalLifeScore} PV | **Bonus :** +${e.optionalBonus}\n`;
    md += `- **Aide :** ${e.helpCount}x | **Rattrapage :** ${e.retriedCount}x | **Écoles :** ${e.ecoleCount}\n`;
    md += `- **Verdict :** ${verdict.label}\n`;
    if (e.elapsedMs > 0 || e.tokens > 0) {
      md += `- **Temps d'inférence :** ${formatDuration(e.elapsedMs)} | **Tokens :** ${e.tokens} | **Vitesse :** ${e.tokensPerSecond > 0 ? e.tokensPerSecond + ' t/s' : '—'} | **Temps réel :** ${formatDuration(e.wallMs)}\n`;
    }
    // --- Tarif cloud estimé (tâche 2026-08-04) ---
    if (e.isCloud && e.cost) {
      md += `- **Coût estimé :** ${pricing.formatUsd(e.cost.usd)} / ${pricing.formatEur(e.cost.usd)} (≈ ${(e.promptTokens || 0).toLocaleString('fr-FR')} prompt + ${(e.completionTokens || 0).toLocaleString('fr-FR')} completion tokens) — *estimation indicative, non exacte*\n`;
    }
    if (args.forces.length > 0) md += `- **Forces :** ${args.forces.join(', ')}\n`;
    if (args.faiblesses.length > 0) md += `- **Faiblesses :** ${args.faiblesses.join(', ')}\n`;
    if (args.notes.length > 0) md += `- *${args.notes.join(', ')}*\n`;
    if (e.isCloud && e.cost) {
      md += `\n| École | Points | % | Note | Bonus | Santé | Temps | Vitesse | Coût ≈ |\n`;
      md += `|---|---|---:|:---:|---:|---:|---|---|---:|\n`;
      for (const ecole of e.ecoles) {
        const g = letterGrade(ecole.pct);
        const temps = ecole.elapsedMs > 0 ? formatDuration(ecole.elapsedMs) : '—';
        const vit = ecole.tokensPerSecond > 0 ? (ecole.tokensPerSecond + ' t/s') : '—';
        let ecCostStr = '—';
        if (e.cost.pricePerMTok && (ecole.promptTokens || ecole.completionTokens)) {
          const p = ecole.promptTokens || 0;
          const c = ecole.completionTokens || 0;
          const u = (p / 1e6) * e.cost.pricePerMTok.prompt + (c / 1e6) * e.cost.pricePerMTok.completion;
          ecCostStr = pricing.formatUsd(u) + ' / ' + pricing.formatEur(u);
        }
        md += `| ${ecole.ecole} | ${ecole.score}/${ecole.max} | ${ecole.pct}% | ${g.grade} | +${ecole.optionalBonus} | ${ecole.globalLifeScore} | ${temps} | ${vit} | ${ecCostStr} |\n`;
      }
    } else {
      md += `\n| École | Points | % | Note | Bonus | Santé | Temps | Vitesse |\n`;
      md += `|---|---|---:|:---:|---:|---:|---|---|\n`;
      for (const ecole of e.ecoles) {
        const g = letterGrade(ecole.pct);
        const temps = ecole.elapsedMs > 0 ? formatDuration(ecole.elapsedMs) : '—';
        const vit = ecole.tokensPerSecond > 0 ? (ecole.tokensPerSecond + ' t/s') : '—';
        md += `| ${ecole.ecole} | ${ecole.score}/${ecole.max} | ${ecole.pct}% | ${g.grade} | +${ecole.optionalBonus} | ${ecole.globalLifeScore} | ${temps} | ${vit} |\n`;
      }
    }
    md += `\n`;
  });

  return md;
}

// --- Export raisonnement consolidé (destiné à NotebookLM via Gemini) ---
// Fichier Markdown détaillé par modèle : pour chaque modèle, on restitue
//   - le nom INTÉGRAL du modèle
//   - la date et l'heure du run
//   - l'auto-profilage déclaré (4 compétences + justification)
//   - pour chaque école évaluée et chaque classe (tier) traversée :
//       * le titre du tier, le statut obligatoire/optionnel, le nom de la classe
//       * pour chaque exercice : ID, type, points, statut, code produit par le modèle,
//         explication d'échec le cas échéant
//       * la réponse brute complète du modèle (raisonnement + code) pour ce tier
//
// Ce fichier est conçu pour être ingéré par Gemini puis alimente une base NotebookLM
// afin d'analyser qualitativement le raisonnement de chaque LLM. Le nom du modèle
// est toujours le nom intégral (non raccourci), la date est obligatoire, l'heure
// est incluse quand elle est disponible.
function buildReasoningMarkdown(entries) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const genTime = `${pad(now.getHours())}-${pad(now.getMinutes())}`;

  let md = `# 🧠 Raisonnements & Réponses des Modèles — BenchGo V3\n\n`;
  md += `> Fichier consolidé destiné à l'analyse qualitative (NotebookLM via Gemini).\n`;
  md += `> Généré le ${genDate} à ${genTime.replace('-', 'h')} — ${entries.length} modèle(s)\n\n`;
  md += `> Chaque section décrit, pour un modèle LLM donné, l'ensemble des classes `;
  md += `traversées, les exercices tentés, le code produit, le raisonnement brut et les `;
  md += `explications d'échec fournies par le modèle lui-même.\n\n`;
  md += `---\n\n`;

  for (const e of entries) {
    md += buildModelReportMarkdown(e);
    md += `\n`;
  }

  return md;
}

// Génère le rapport intégral Markdown d'UN SEUL modèle (auto-profilage, toutes
// écoles, tous tiers, tous exercices avec code + explications + corrections +
// réponses brutes). Réutilisé par :
//   - buildReasoningMarkdown (consolidation globale)
//   - la route /api/report du serveur (téléchargement par modèle depuis la modale)
// Le rapport est conçu pour être transmis à un modèle cloud (Gemini, ChatGPT…)
// qui l'analysera puis produira un verdict à injecter dans NotebookLM.
function buildModelReportMarkdown(e) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const genTime = `${pad(now.getHours())}h${pad(now.getMinutes())}`;

  let md = `## ${e.model}\n\n`;
  md += `**Nom intégral du modèle :** ${e.model}\n\n`;
  md += `**Nom court :** ${e.shortName}\n\n`;
  md += `**Rapport généré le :** ${genDate} à ${genTime}\n\n`;
  md += `- **Quantification :** ${e.quantization || '—'}\n`;
  md += `- **Score global :** ${e.score}/${e.max} (${e.pct}%) — Note ${letterGrade(e.pct).grade}\n`;
  md += `- **Score obligatoire :** ${e.mandatoryTotal > 0 ? e.mandatoryPassed + '/' + e.mandatoryTotal + ' (' + e.mandatoryPct + '%)' : 'N/A'}\n`;
  md += `- **Santé globale :** ${e.globalLifeScore} PV\n`;
  md += `- **Bonus optionnel :** +${e.optionalBonus}\n`;
  md += `- **Aide du professeur :** ${e.helpCount}x | **Rattrapages :** ${e.retriedCount}x\n`;
  md += `- **Écoles évaluées :** ${e.ecoleCount}\n\n`;

  // Détail par école : on retrouve le carnet original pour accéder aux tiers
  // (réponses brutes + raisonnement + selfProfile).
  const ledger = loadLedgerByName(e.shortName);
  if (!ledger) {
    md += `> *Carnet de scores introuvable — détail des raisonnements indisponible.*\n\n---\n\n`;
    return md;
  }

  for (const ecole of e.ecoles) {
    const ecoleEntry = normalizeEcoleEntryLb(ledger.ecoles[ecole.ecole]).best;
    if (!ecoleEntry) continue;

    const runDate = ecoleEntry.date || '—';
    const runTime = ecoleEntry.time ? ecoleEntry.time.replace(/-/g, ':') : null;
    md += `### École : ${ecole.ecole}\n\n`;
    md += `**Date du run :** ${runDate}${runTime ? ' à ' + runTime : ''}\n\n`;
    md += `- **Profil :** ${ecoleEntry.profile || '—'}\n`;
    md += `- **Score école :** ${ecole.score}/${ecole.max} (${ecole.pct}%) — Note ${letterGrade(ecole.pct).grade}\n`;
    md += `- **Santé école :** ${ecole.globalLifeScore} PV | **Bonus :** +${ecole.optionalBonus}\n`;
    md += `- **Aide :** ${ecole.helpCount}x | **Rattrapage :** ${ecole.retriedCount}x\n`;
    if (ecoleEntry.calibrationIndex != null) {
      md += `- **Indice de Calibration :** C=${ecoleEntry.calibrationIndex.toFixed(3)} (D=${((ecoleEntry.declaredLevel || 0) * 100).toFixed(0)}%)\n`;
    }

    // Auto-profilage déclaré par le modèle pour cette école
    if (ecoleEntry.selfProfile && ecoleEntry.selfProfile.skills) {
      md += `\n#### Auto-profilage déclaré par le modèle\n\n`;
      const skills = ecoleEntry.selfProfile.skills;
      for (const [skill, label] of Object.entries({
        javascript_basics: 'JavaScript — Bases & Algorithmique simple',
        javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
        algorithms_advanced: 'Algorithmes & Structures de données avancées',
        code_debugging: 'Débogage & Sécurité applicative'
      })) {
        const lvl = skills[skill] ? skills[skill].level : '?';
        md += `- **${label} :** niveau ${lvl}/5\n`;
      }
      if (ecoleEntry.selfProfile.justification) {
        md += `- **Justification du modèle :** ${ecoleEntry.selfProfile.justification}\n`;
      }
    }

    // Détail par tier (classe traversée)
    const tiers = ecoleEntry.tiers || [];
    if (tiers.length === 0) {
      md += `\n> *Aucun détail de tier disponible pour cette école (données antérieures à l'export raisonnement).*\n`;
    }
    for (const t of tiers) {
      md += `\n#### Tier ${t.tierNum} — ${t.tierTitle}\n\n`;
      md += `- **Classe :** ${t.className}\n`;
      md += `- **Statut :** ${t.isMandatory ? 'Obligatoire' : 'Optionnel'}\n\n`;

      const evals = t.evalResults || [];
      if (evals.length > 0) {
        md += `##### Exercices tentés\n\n`;
        md += `| Exercice | Type | Points | Max | Statut | Aide | Rattrapage |\n`;
        md += `|---|---|---:|---:|---|---|---|\n`;
        for (const r of evals) {
          const st = r.status === 'bypassed' ? '⊘ Bypassé' : (r.status === 'success' ? '✔ Validé' : '✘ Échec');
          md += `| ${r.id} | ${r.taskType || '—'} | ${r.points || 0} | ${r.maxPoints || 0} | ${st} | ${r.helpUsed ? 'Oui' : 'Non'} | ${r.retried ? 'Oui' : 'Non'} |\n`;
        }
        md += `\n`;

        md += `##### Code produit par le modèle et explications\n\n`;
        for (const r of evals) {
          if (r.status === 'bypassed') continue;
          md += `**Exercice ${r.id} — ${r.taskType || '—'}** (${r.status === 'success' ? 'validé' : 'échec'})\n\n`;
          if (r.code && String(r.code).trim()) {
            md += `Code proposé :\n\`\`\`javascript\n${String(r.code).trim()}\n\`\`\`\n\n`;
          } else {
            md += `*Aucun code exploitable produit.*\n\n`;
          }
          if (r.failureExplanation) {
            md += `**Explication de l'échec (par l'élève) :** ${r.failureExplanation}\n\n`;
          }
          if (r.teacherCorrection) {
            md += `**🎓 Correction du professeur IA :** ${r.teacherCorrection}\n\n`;
          }
        }
      }

      if (t.rawResponse && String(t.rawResponse).trim()) {
        md += `##### Réponse brute complète du modèle pour ce tier\n\n`;
        md += `> Contient le raisonnement et les réponses du modèle tels que produits\n`;
        md += `> pendant le run (concaténation des tentatives successives).\n\n`;
        md += `\`\`\`text\n${String(t.rawResponse).trim()}\n\`\`\`\n\n`;
      }
    }

    md += `\n---\n\n`;
  }

  return md;
}

// Charge un carnet par shortName (recherche directe du fichier .json).
function loadLedgerByName(shortName) {
  const file = path.join(LEDGER_DIR, shortName + '.json');
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    logger.warn('Carnet illisible pour export raisonnement (' + shortName + ') : ' + e.message);
  }
  return null;
}

// Affiche les modèles LM Studio téléchargés qui ne sont PAS (ou partiellement)
// testés dans le classement. Récupère la liste via lms ls --json --llm (réutilise
// la logique de night-batch.js) et la compare aux carnets de scores existants.
// Permet de voir d'un coup d'œil quels modèles restent à tester, sans basculer
// entre le CLI et LM Studio.
//
// Affichage en 2 sections :
//   1. Jamais testés (priorité : aucun carnet n'existe pour ce modèle).
//   2. Partiels (un carnet existe mais des écoles manquent).
//
// Tolérant : si lms n'est pas installé / daemon inactif, affiche un avertissement
// discret et n'interrompt pas la génération du classement.
function printUntestedLmStudioModels() {
  let result;
  try {
    result = nightBatch.listLlmModels();
  } catch (e) {
    logger.warn('listLlmModels indisponible : ' + e.message);
    return;
  }
  if (!result.ok) {
    console.log(`  \x1b[33m━━━ MODÈLES LM STUDIO NON TESTÉS ━━━\x1b[0m`);
    console.log(`  \x1b[90mImpossible de lister les modèles LM Studio (${result.error || 'lms indisponible'}).\x1b[0m`);
    console.log(`  \x1b[90mLancez LM Studio (ou 'lms daemon up') puis relancez le classement.\x1b[0m`);
    return;
  }

  const neverTested = result.models.filter(m => m.status.kind === 'never');
  const partial = result.models.filter(m => m.status.kind === 'partial');
  const failed = result.models.filter(m => m.status.kind === 'failed');
  const nonLlm = result.models.filter(m => m.status.kind === 'nonllm');
  const total = neverTested.length + partial.length + failed.length;

  if (total === 0 && nonLlm.length === 0) {
    console.log(`  \x1b[32m━━━ MODÈLES LM STUDIO — TOUS TESTÉS ━━━\x1b[0m`);
    console.log(`  \x1b[90m${result.models.length} modèle(s) LM Studio détecté(s), tous présents dans le classement.\x1b[0m`);
    return;
  }

  if (total > 0) {
    console.log(`  \x1b[33m━━━ MODÈLES LM STUDIO NON TESTÉS (${total}) ━━━\x1b[0m`);
    console.log(`  \x1b[90m${result.models.length} modèle(s) téléchargé(s) dans LM Studio, ${total} absent(s) du classement.\x1b[0m`);

    const headers = ['Modèle', 'Param', 'Quant', 'Statut', 'Écoles manquantes'];
    const aligns = ['left', 'right', 'left', 'left', 'left'];
    const rows = [];

    for (const m of neverTested) {
      const badge = nightBatch.statusBadge(m.status);
      rows.push([m.displayName || m.modelKey, m.params || '?', m.quant || '?', badge.label, nightBatch.missingSchoolsLabel(m.status) || '—']);
    }
    for (const m of failed) {
      const badge = nightBatch.statusBadge(m.status);
      // Affiche la raison d'échec plutôt que les écoles manquantes (on les a tentées).
      const reason = m.status.reason || 'Échec';
      rows.push([m.displayName || m.modelKey, m.params || '?', m.quant || '?', badge.label, reason]);
    }
    for (const m of partial) {
      const badge = nightBatch.statusBadge(m.status);
      // Si une école a échoué (run KO), on l'indique explicitement.
      let missing = nightBatch.missingSchoolsLabel(m.status) || '—';
      if (m.status.failedSchool) {
        missing = '⚠ ' + m.status.failedSchool + ' : échec run';
      }
      rows.push([m.displayName || m.modelKey, m.params || '?', m.quant || '?', badge.label, missing]);
    }

    const res = cliTable.table(headers, rows, { colAligns: aligns, separator: '  ' });
    console.log(`  \x1b[90m    ${res.lines[0]}\x1b[0m`);
    console.log(`  \x1b[90m    ${res.sepLine}\x1b[0m`);
    for (let i = 0; i < rows.length; i++) {
      console.log(`  \x1b[90m${res.lines[i + 2]}\x1b[0m`);
    }
    if (failed.length > 0) {
      console.log(`  \x1b[90m${failed.length} modèle(s) en échec (load_failed / run KO). Repassez-les après vérification, ou isolez-les (!<num>) s'ils ne sont pas testables.\x1b[0m`);
    }
    console.log(`  \x1b[90mAstuce : node night-batch.js pour tester ces modèles automatiquement.\x1b[0m`);
  }

  // --- Modèles non-LLM (OCR, embedding, rerank, vision-only, isolés) ---
  // Affichés séparément avec le badge NON APPLICABLE pour indiquer qu'ils ne
  // peuvent pas passer les écoles BenchGo (pas des LLM textuels).
  if (nonLlm.length > 0) {
    console.log('');
    console.log(`  \x1b[90m━━━ MODÈLES NON APPLICABLES (${nonLlm.length}) ━━━\x1b[0m`);
    console.log(`  \x1b[90mModèles non-LLM (OCR, embedding, rerank, vision) ou isolés manuellement — non testables par BenchGo.\x1b[0m`);
    const headers = ['Modèle', 'Param', 'Quant', 'Statut', 'Raison'];
    const aligns = ['left', 'right', 'left', 'left', 'left'];
    const rows = [];
    for (const m of nonLlm) {
      const badge = nightBatch.statusBadge(m.status);
      const reason = m.status.reason || (m.nonLlm ? 'Non-LLM détecté' : (m.blacklisted ? 'Isolé manuellement' : '—'));
      rows.push([m.displayName || m.modelKey, m.params || '?', m.quant || '?', badge.label, reason]);
    }
    const res = cliTable.table(headers, rows, { colAligns: aligns, separator: '  ' });
    console.log(`  \x1b[90m    ${res.lines[0]}\x1b[0m`);
    console.log(`  \x1b[90m    ${res.sepLine}\x1b[0m`);
    for (let i = 0; i < rows.length; i++) {
      console.log(`  \x1b[90m${res.lines[i + 2]}\x1b[0m`);
    }
    console.log(`  \x1b[90mAstuce : node night-batch.js --isoler=<numéro> pour isoler/désisoler un modèle depuis le CLI interactif.\x1b[0m`);
  }
}

// Affiche le classement SPECIFIQUE aux modèles frontière cloud (API distantes :
// OpenRouter, OpenAI, Anthropic, Groq...). Contrairement au classement général
// qui mélange tout, cette vue isole les modèles cloud car ils n'ont rien à voir
// avec les modèles locaux LM Studio (pas de quantization, latence réseau,
// infrastructure différente, pas de limite de RAM GPU). Utile pour comparer
// uniquement entre eux les modèles cloud testés via frontier-batch.js.
//
// Affichage enrichi : provider (openrouter, openai...), école(s) testée(s),
// score, vitesse. Les modèles sont triés par % décroissant (comme le classement
// général) mais le rang est local à cette section cloud.
function printCloudLeaderboard() {
  const ledgers = loadAllLedgers();
  if (ledgers.length === 0) {
    console.log('\x1b[33mAucun carnet de scores trouvé. Lancez d\'abord un benchmark cloud (node frontier-batch.js).\x1b[0m');
    return;
  }

  const entries = ledgers.map(aggregateLedger).filter(Boolean).filter(e => e.isCloud);
  if (entries.length === 0) {
    console.log('\x1b[33mAucun modèle cloud frontière trouvé dans les carnets.\x1b[0m');
    console.log('\x1b[90mPour tester un modèle cloud : node frontier-batch.js --provider=openrouter\x1b[0m');
    console.log('\x1b[90mSi un carnet cloud n est pas détecté : node leaderboard.js --mark-cloud=<shortName>\x1b[0m');
    return;
  }

  // On exclut les carnets dont le meilleur score est nul (score === 0 ET
  // tokens === 0) : ces entrées correspondent a un modele cloud qui n a jamais
  // repondu (modele saturé, dépublié, timeout, 0 tokens produits). Les afficher
  // a 0% polluerait le classement avec des échecs d infrastructure (pas des
  // résultats de benchmark). Le carnet est conservé pour l historique (utile au
  // re-test), mais masqué du leaderboard tant qu aucune tentative reussie n a
  // été enregistrée.
  const visibleEntries = entries.filter(e => !(e.score === 0 && e.tokens === 0));
  const hiddenCount = entries.length - visibleEntries.length;
  if (visibleEntries.length === 0) {
    console.log('\x1b[33mAucun modèle cloud frontière avec un résultat exploitable trouvé dans les carnets.\x1b[0m');
    if (hiddenCount > 0) {
      console.log(`\x1b[90m${hiddenCount} modèle(s) cloud présent(s) dans les carnets mais sans réponse exploitable (0 point, 0 token) — masqué(s).\x1b[0m`);
    }
    console.log('\x1b[90mPour tester un modèle cloud : node frontier-batch.js --provider=openrouter\x1b[0m');
    console.log('\x1b[90mSi un carnet cloud n est pas détecté : node leaderboard.js --mark-cloud=<shortName>\x1b[0m');
    return;
  }

  // Tri : % décroissant, puis score, puis santé.
  visibleEntries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  console.log('');
  console.log('  \x1b[1;36m━━━ CLASSEMENT CLOUD FRONTIÈRE · MODÈLES API ━━━\x1b[0m');
  console.log(`  \x1b[90m${visibleEntries.length} modèle(s) cloud classé(s) — séparé(s) des modèles locaux LM Studio\x1b[0m`);
  if (hiddenCount > 0) {
    console.log(`  \x1b[90m${hiddenCount} modèle(s) cloud sans réponse exploitable (0 point / 0 token) masqué(s) du classement.\x1b[0m`);
  }

  const headers = ['Rang', 'Modèle', 'Provider', 'École(s)', 'Vitesse', 'Pct', 'Verdict'];
  const aligns = ['left', 'left', 'left', 'left', 'right', 'right', 'left'];
  const rows = [];
  const medals = [];
  for (let i = 0; i < visibleEntries.length; i++) {
    const e = visibleEntries[i];
    const verdict = getVerdict(e, i + 1);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const vColor = verdict.rank === 0 ? '\x1b[93m' : verdict.rank === 1 ? '\x1b[32m' : verdict.rank === 2 ? '\x1b[36m' : verdict.rank === 3 ? '\x1b[33m' : '\x1b[31m';
    const providerLabel = e.provider && e.provider !== 'cloud'
      ? `\x1b[33m${e.provider}\x1b[0m`
      : '\x1b[90mcloud\x1b[0m';
    const ecoleLabel = (e.ecoles || []).map(ec => ec.ecole).join(', ') || '\x1b[90m—\x1b[0m';
    const tpsC = e.tokensPerSecond >= 50 ? '\x1b[32m' : e.tokensPerSecond >= 25 ? '\x1b[33m' : e.tokensPerSecond > 0 ? '\x1b[31m' : '\x1b[90m';
    const vit = e.tokensPerSecond > 0 ? `${tpsC}${e.tokensPerSecond + ' t/s'}\x1b[0m` : '\x1b[90m—\x1b[0m';
    rows.push([
      (i + 1) + '.',
      e.model,
      providerLabel,
      ecoleLabel,
      vit,
      e.pct + '%',
      `${vColor}${verdict.label}\x1b[0m`,
    ]);
    medals.push(medal);
  }

  const res = cliTable.table(headers, rows, { colAligns: aligns, separator: '  ' });
  console.log(`  \x1b[90m    ${res.lines[0]}\x1b[0m`);
  console.log(`  \x1b[90m    ${res.sepLine}\x1b[0m`);
  for (let i = 0; i < rows.length; i++) {
    console.log(`  ${medals[i]} ${res.lines[i + 2]}`);
  }
  console.log('');
  console.log('  \x1b[90mAstuce : node frontier-batch.js --provider=openrouter pour tester de nouveaux modèles cloud.\x1b[0m');
  console.log('  \x1b[90mAstuce : node leaderboard.js (sans --cloud) pour le classement complet (local + cloud séparés).\x1b[0m');
  console.log('');
}

// Rapport de suivi complet pour LM Studio : combine en une vue unifiée les
// modèles LM Studio déjà testés (Bloc 1, tri chronologique inversé) et les
// modèles LM Studio détectés mais non encore testés (Bloc 2, avec statut
// [NON TESTÉ]). Appelé par le flag --lmstudio / --lmstudio-status.
//
// Bloc 1 — Modèles testés :
//   Filtre isCloud = false + au moins une école avec max > 0.
//   Tri strictement chronologique : du test le plus récent au plus ancien
//   (les tests de la nuit en tête de liste). Le timestamp du dernier test
//   est le plus récent parmi toutes les tentatives de toutes les écoles
//   (timestampMs → timestampIso → date+time → lastUpdated du carnet).
//
// Bloc 2 — Modèles non testés :
//   Appelle printUntestedLmStudioModels() qui interroge LM Studio (lms ls)
//   et croise avec les carnets existants pour lister les modèles jamais
//   testés, partiels ou en échec.
function getLmStudioTestedEntries() {
  const ledgers = loadAllLedgers();
  if (ledgers.length === 0) return [];
  const entries = ledgers
    .map(aggregateLedger)
    .filter(Boolean)
    .filter(e => !e.isCloud)
    .filter(e => e.ecoles.some(ec => ec.max > 0));
  for (const e of entries) {
    let bestTs = 0;
    for (const ec of e.ecoles) {
      for (const a of (ec.attempts || [])) {
        let ts = 0;
        if (a.timestampMs) ts = Number(a.timestampMs);
        else if (a.timestampIso) ts = Date.parse(a.timestampIso);
        else if (a.date) {
          const ds = (a.date || '') + ' ' + (a.time || '');
          const parsed = Date.parse(ds.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
          if (!isNaN(parsed)) ts = parsed;
        }
        if (ts > bestTs) bestTs = ts;
      }
    }
    if (bestTs === 0 && e.lastUpdated) bestTs = Date.parse(e.lastUpdated) || 0;
    e.lastTestTs = bestTs;
  }
  return entries;
}

function printLmStudioStatus() {
  const allEntries = getLmStudioTestedEntries();

  // Croise les carnets avec la liste réelle des modèles présents dans LM Studio.
  // Sans ce croisement, le Bloc 1 afficherait aussi les carnets des modèles
  // supprimés de LM Studio depuis (42 carnets vs 12 modèles réellement présents).
  // On n affiche donc dans le Bloc 1 que les modèles testés ENCORE présents
  // dans LM Studio. Si lms est indisponible (daemon inactif), on garde tous
  // les carnets (repli, comme pour printUntestedLmStudioModels).
  let lmsModelKeys = null;
  try {
    const result = nightBatch.listLlmModels();
    if (result.ok && Array.isArray(result.models)) {
      lmsModelKeys = new Set(
        result.models
          .map(m => nightBatch.normalizeForMatch(m.modelKey))
          .filter(Boolean)
      );
    }
  } catch (e) {
    logger.warn('listLlmModels indisponible pour --lmstudio : ' + e.message);
  }

  let entries;
  let hiddenLmsCount = 0;
  if (lmsModelKeys) {
    entries = allEntries.filter(e => {
      const nm = nightBatch.normalizeForMatch(e.model);
      const ns = nightBatch.normalizeForMatch(e.shortName);
      // Un carnet correspond si son model OU son shortName normalisé matche
      // un modelKey de LM Studio.
      return (nm && lmsModelKeys.has(nm)) || (ns && lmsModelKeys.has(ns));
    });
    hiddenLmsCount = allEntries.length - entries.length;
  } else {
    // lms indisponible : on garde tous les carnets (repli).
    entries = allEntries.slice();
  }

  entries.sort((a, b) => (b.lastTestTs || 0) - (a.lastTestTs || 0));

  console.log('');
  console.log('  \x1b[1;36m━━━ RAPPORT LM STUDIO · SUIVI COMPLET ━━━\x1b[0m');

  // --- Bloc 1 : Modèles testés ET présents dans LM Studio (tri chrono inversé) ---
  if (entries.length === 0) {
    console.log('  \x1b[33mAucun modèle LM Studio testé trouvé dans les carnets.\x1b[0m');
    console.log('  \x1b[90mLancez d abord un benchmark local : node runner.js all --profile=LIGHT\x1b[0m');
  } else {
    console.log(`  \x1b[1;32mBLOC 1 — MODÈLES TESTÉS (${entries.length})\x1b[0m`);
    console.log(`  \x1b[90mModèles présents dans LM Studio et déjà évalués — tri du test le plus récent au plus ancien.\x1b[0m`);

    const headers = ['#', 'Modèle LM Studio', 'Dernier Test', 'Niveau', 'Score', 'Statut'];
    const aligns = ['left', 'left', 'left', 'center', 'right', 'left'];
    const rows = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const verdict = getVerdict(e, i + 1);
      const cat = getCategory(e, i + 1);
      const grade = letterGrade(e.pct);
      const vColor = verdict.rank === 0 ? '\x1b[93m' : verdict.rank === 1 ? '\x1b[32m' : verdict.rank === 2 ? '\x1b[36m' : verdict.rank === 3 ? '\x1b[33m' : '\x1b[31m';
      let dateLabel = '\x1b[90m—\x1b[0m';
      if (e.lastTestTs > 0) {
        try {
          const d = new Date(e.lastTestTs);
          dateLabel = d.toLocaleString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) {
          dateLabel = '\x1b[90m?\x1b[0m';
        }
      }
      const niveauLabel = (e.ecoles || []).map(ec => ec.ecole).join(', ') || '\x1b[90m—\x1b[0m';
      const scoreLabel = `${e.score}/${e.max} (${e.pct}%)`;
      rows.push([
        (i + 1) + '.',
        e.model,
        dateLabel,
        `${grade.color}${grade.grade}\x1b[0m ${niveauLabel}`,
        scoreLabel,
        `${vColor}${verdict.label}\x1b[0m \x1b[90m${cat.icon}\x1b[0m`,
      ]);
    }

    const res = cliTable.table(headers, rows, { colAligns: aligns, separator: '  ' });
    console.log(`  \x1b[90m    ${res.lines[0]}\x1b[0m`);
    console.log(`  \x1b[90m    ${res.sepLine}\x1b[0m`);
    for (let i = 0; i < rows.length; i++) {
      console.log(`  ${res.lines[i + 2]}`);
    }
    if (hiddenLmsCount > 0) {
      console.log(`  \x1b[90m${hiddenLmsCount} carnet(s) de modèles testés mais supprimés de LM Studio (masqué(s) du rapport).\x1b[0m`);
    }
  }

  // --- Bloc 2 : Modèles non testés (détectés dans LM Studio, absents des carnets) ---
  console.log('');
  printUntestedLmStudioModels();

  console.log('');
  console.log('  \x1b[90mAstuce : node leaderboard.js pour le classement complet (local + cloud).\x1b[0m');
  console.log('  \x1b[90mAstuce : node leaderboard.js --cloud pour le classement des modèles frontière cloud.\x1b[0m');
  console.log('');
}

// Marque manuellement un carnet comme étant un modèle cloud frontière. Utilisé
// pour migrer les anciens carnets (antérieurs au commit 40e0da9) qui ne stockent
// pas provider/isCloud et dont le modèle n'a pas de slug :free détectable
// automatiquement. Écrit provider='cloud' et isCloud=true dans le carnet JSON.
//
// @param {string} shortName - Le shortName du modèle à marquer (ex:
//        "inclusionai_ling-3.0-flash_free"). Accepte aussi un nom de fichier
//        carnet (avec ou sans .json).
// @returns {boolean} true si la migration a réussi.
function markCloudModel(shortName) {
  if (!shortName) {
    console.log('\x1b[31mUsage : node leaderboard.js --mark-cloud=<shortName>\x1b[0m');
    console.log('\x1b[90mExemple : node leaderboard.js --mark-cloud=inclusionai_ling-3.0-flash_free\x1b[0m');
    return false;
  }
  // Normalise : retire l extension .json si presente.
  const cleanShort = shortName.replace(/\.json$/i, '');
  const ledgerPath = path.join(LEDGER_DIR, cleanShort + '.json');
  if (!fs.existsSync(ledgerPath)) {
    console.log(`\x1b[31mCarnet introuvable : ${cleanShort}.json (dans ${LEDGER_DIR})\x1b[0m`);
    // Affiche les carnets disponibles pour aider l utilisateur.
    const files = fs.existsSync(LEDGER_DIR)
      ? fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.json') && f !== 'classement_snapshot.json')
      : [];
    if (files.length > 0) {
      console.log('\x1b[90mCarnets disponibles :\x1b[0m');
      for (const f of files) console.log(`  \x1b[90m${f.replace(/\.json$/, '')}\x1b[0m`);
    }
    return false;
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (e) {
    console.log(`\x1b[31mCarnet illisible : ${e.message}\x1b[0m`);
    return false;
  }
  const wasCloud = ledger.isCloud === true || (ledger.provider && ledger.provider !== 'local');
  ledger.provider = ledger.provider && ledger.provider !== 'local' ? ledger.provider : 'cloud';
  ledger.isCloud = true;
  try {
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
    if (wasCloud) {
      console.log(`\x1b[33m${cleanShort} était déjà marqué cloud (provider=${ledger.provider}). Confirmé.\x1b[0m`);
    } else {
      console.log(`\x1b[32m${cleanShort} marqué comme modèle cloud frontière (provider=${ledger.provider}).\x1b[0m`);
      console.log('\x1b[90mIl apparaîtra maintenant dans le filtre Cloud du classement et dans --cloud.\x1b[0m');
    }
    return true;
  } catch (e) {
    console.log(`\x1b[31mErreur écriture carnet : ${e.message}\x1b[0m`);
    return false;
  }
}

// Affiche une section du classement CLI (soit "Modèles locaux", soit "Modèles
// cloud frontière"). Les deux sections sont totalement séparées car les modèles
// cloud (OpenRouter, OpenAI...) n'ont rien à voir avec les modèles locaux : pas
// de quantization, latence réseau, infrastructure différente. Le rang affiché
// est local à chaque section (1..N), pas global.
function printLeaderboardSection(title, sectionEntries) {
  console.log('');
  if (sectionEntries.length === 0) {
    console.log(`  \x1b[1;36m━━━ ${title} (0) ━━━\x1b[0m`);
    console.log(`  \x1b[90m  Aucun modèle dans cette section.\x1b[0m`);
    return;
  }
  console.log(`  \x1b[1;36m━━━ ${title} (${sectionEntries.length}) ━━━\x1b[0m`);

  const lbHeaders = ['Rang', 'Modèle', 'Provider', 'Quant', 'Temps', 'Vitesse', 'Pct', 'Mvt', 'Verdict'];
  const lbAligns = ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'center', 'left'];
  const lbRows = [];
  const lbMedals = [];
  for (let i = 0; i < sectionEntries.length; i++) {
    const e = sectionEntries[i];
    const verdict = getVerdict(e, i + 1);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const vColor = verdict.rank === 0 ? '\x1b[93m' : verdict.rank === 1 ? '\x1b[32m' : verdict.rank === 2 ? '\x1b[36m' : verdict.rank === 3 ? '\x1b[33m' : '\x1b[31m';
    const quant = e.quantization ? `\x1b[35m${e.quantization}\x1b[0m` : '\x1b[90m—\x1b[0m';
    // Colonne Provider : label coloré par provider (openrouter, openai, ollama...)
    // pour différencier les origines au lieu de tout mélanger sous "cloud".
    const provInfo = providerDisplay(e.provider, e.isCloud);
    const provCell = e.isCloud
      ? `\x1b[33m${provInfo.icon} ${provInfo.label}\x1b[0m`
      : `\x1b[32m${provInfo.icon} ${provInfo.label}\x1b[0m`;
    const temps = e.elapsedMs > 0 ? `\x1b[90m${formatDuration(e.elapsedMs)}\x1b[0m` : '\x1b[90m—\x1b[0m';
    const tpsC = e.tokensPerSecond >= 50 ? '\x1b[32m' : e.tokensPerSecond >= 25 ? '\x1b[33m' : e.tokensPerSecond > 0 ? '\x1b[31m' : '\x1b[90m';
    const vit = e.tokensPerSecond > 0 ? `${tpsC}${e.tokensPerSecond + ' t/s'}\x1b[0m` : '\x1b[90m—\x1b[0m';
    // Flèche de mouvement de position (delta de rang vs snapshot précédent).
    //   delta < 0 → ▲ vert (monte)  |  delta > 0 → ▼ rouge (descend)  |  0 → = gris  |  null → nouveau
    let mvt;
    if (e.positionDelta == null) {
      mvt = '\x1b[90mNEW\x1b[0m';
    } else if (e.positionDelta < 0) {
      mvt = `\x1b[32m▲${Math.abs(e.positionDelta)}\x1b[0m`;
    } else if (e.positionDelta > 0) {
      mvt = `\x1b[31m▼${e.positionDelta}\x1b[0m`;
    } else {
      mvt = '\x1b[90m=\x1b[0m';
    }
    lbRows.push([
      (i + 1) + '.',
      e.model,
      provCell,
      quant,
      temps,
      vit,
      e.pct + '%',
      mvt,
      `${vColor}${verdict.label}\x1b[0m`,
    ]);
    lbMedals.push(medal);
  }

  const lbRes = cliTable.table(lbHeaders, lbRows, { colAligns: lbAligns, separator: '  ' });
  console.log(`  \x1b[90m    ${lbRes.lines[0]}\x1b[0m`);
  console.log(`  \x1b[90m    ${lbRes.sepLine}\x1b[0m`);
  for (let i = 0; i < lbRows.length; i++) {
    console.log(`  ${lbMedals[i]} ${lbRes.lines[i + 2]}`);
  }
}

// Génère le classement complet (HTML + Markdown) et le sauvegarde.
function generateLeaderboard() {
  const ledgers = loadAllLedgers();
  if (ledgers.length === 0) {
    logger.warn('Aucun carnet de scores trouvé — classement vide.');
    return null;
  }

  const entries = ledgers.map(aggregateLedger).filter(Boolean);
  if (entries.length === 0) {
    logger.warn('Aucune donnée exploitable dans les carnets — classement vide.');
    return null;
  }

  // Tri : % décroissant, puis score décroissant, puis santé décroissante
  entries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  // --- Détection de mouvement de position ---
  // Compare le rang actuel de chaque modèle à celui du snapshot précédent
  // (génération antérieure du classement). Permet d'afficher des flèches
  // ▲ (monte, vert) / ▼ (descend, rouge) / = (stable) sur les cartes.
  const prevSnapshot = loadPositionSnapshot();
  const positionDeltas = computePositionDeltas(entries, prevSnapshot);
  for (let i = 0; i < entries.length; i++) {
    entries[i].positionDelta = positionDeltas[entries[i].shortName] ?? null;
  }

  const html = buildLeaderboardHTML(entries);
  const md = buildLeaderboardMarkdown(entries);
  const reasoningMd = buildReasoningMarkdown(entries);

  // Le classement est global (tous modèles confondus) → un seul fichier à la
  // racine de Export-Rapports/, écrasé à chaque génération. Pas de sous-dossier date.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const htmlPath = path.join(EXPORT_DIR, 'classement.html');
  const mdPath = path.join(EXPORT_DIR, 'classement.md');
  const reasoningPath = path.join(EXPORT_DIR, 'raisonnement_modeles.md');

  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(reasoningPath, reasoningMd, 'utf8');

  // Sauvegarde le snapshot des positions pour la prochaine génération
  // (permet de détecter les mouvements ▲/▼/= au prochain run).
  savePositionSnapshot(entries);

  const relHtml = path.relative(__dirname, htmlPath);
  const relMd = path.relative(__dirname, mdPath);
  const relReasoning = path.relative(__dirname, reasoningPath);

  console.log('');
  console.log('  \x1b[1;35m━━━ CLASSEMENT BENCHGO V3 ━━━\x1b[0m');
  console.log(`  \x1b[90m${entries.length} modèle(s) classé(s) du meilleur au pire\x1b[0m`);

  // --- Séparation Local (LM Studio) vs Cloud frontière (API) ---
  // Les modèles cloud (OpenRouter, OpenAI...) n'ont rien à voir avec les
  // modèles locaux : infrastructure différente, pas de quantization, pas de
  // limite de RAM, latence réseau... On les départage donc en deux sections
  // distinctes dans le CLI pour ne pas mélanger des oranges et des pommes.
  const localEntries = entries.filter(e => !e.isCloud);
  const cloudEntries = entries.filter(e => e.isCloud);

  printLeaderboardSection('🏠 MODÈLES LOCAUX · LM Studio', localEntries);
  printLeaderboardSection('☁️ MODÈLES CLOUD FRONTIÈRE · API', cloudEntries);

  // --- Modèles LM Studio présents mais non testés ---
  // Compare les modelKeys de lms ls avec les carnets de scores existants pour
  // afficher les modèles téléchargés dans LM Studio mais jamais (ou partiellement)
  // testés par BenchGo. Évite les va-et-vient fastidieux entre LM Studio et le CLI.
  printUntestedLmStudioModels();

  console.log('');
  console.log(`  \x1b[32mClassement HTML       : ${relHtml}\x1b[0m`);
  console.log(`  \x1b[90mClassement MD         : ${relMd}\x1b[0m`);
  console.log(`  \x1b[36mRaisonnement modèles  : ${relReasoning}\x1b[0m`);
  console.log(`  \x1b[90m  (destiné à NotebookLM via Gemini)\x1b[0m`);
  console.log('');

  return { htmlPath, mdPath, reasoningPath, entries };
}

// Ajuste le snapshot de position après suppression d'un modèle pour neutraliser
// l'effet de "montée artificielle" des autres modèles. En effet, supprimer le
// modèle classé N fait remonter tous ceux en dessous d'un cran (N+1→N, N+2→N+1...)
// ce qui déclenche à tort des flèches ▲ sur la prochaine génération.
//
// Pour corriger : on décrémente de 1 le rang de chaque modèle qui était *strictement
// en dessous* du modèle supprimé dans l'ancien snapshot. Ainsi, à la régénération,
// les rangs recalculés coïncident avec les rangs ajustés du snapshot → delta = 0
// (stable) pour les modèles qui n'ont pas bougé de score, et aucune flèche parasite.
//
// @param {string} deletedShortName - Le shortName du modèle supprimé.
// @param {Array}  entries          - Les entries triées AVANT suppression (pour
//                                    retrouver le rang du modèle supprimé).
function adjustSnapshotForDeletion(deletedShortName, entries) {
  if (!deletedShortName) return;
  const snapshot = loadPositionSnapshot();
  // Rang (1-based) du modèle supprimé dans le snapshot précédent.
  const deletedRank = snapshot[deletedShortName];
  if (deletedRank == null) return;
  // Retire le modèle supprimé du snapshot.
  delete snapshot[deletedShortName];
  // Décrémente de 1 le rang de tous les modèles qui étaient strictement en dessous
  // du modèle supprimé (rang > deletedRank) : leur rang baisse de 1, ce qui compense
  // exactement la remontée due à la suppression.
  for (const sn of Object.keys(snapshot)) {
    if (snapshot[sn] > deletedRank) {
      snapshot[sn] = snapshot[sn] - 1;
    }
  }
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    logger.info('Snapshot de position ajusté après suppression de ' + deletedShortName +
      ' (rang ' + deletedRank + ') : ' + (Object.keys(snapshot).length) + ' modèles restants.');
  } catch (e) {
    logger.warn('Impossible d_ajuster le snapshot de position : ' + e.message);
  }
}

// Supprime un carnet de scores par shortName, puis régénère le classement.
function deleteLedger(shortName) {
  // Sécurité : valider le shortName pour empêcher le path traversal.
  // Un shortName ne contient que des caractères alphanumériques, tirets, underscores et points.
  // On rejette tout ce qui contient des séparateurs de chemin (/, \, ..) pour
  // empêcher la suppression de fichiers hors du dossier .carnet (ex: .api-keys.json).
  if (!shortName || typeof shortName !== 'string') {
    return { ok: false, error: 'shortName manquant ou invalide' };
  }
  if (/[\/\\]/.test(shortName) || shortName === '..' || shortName.includes('..')) {
    return { ok: false, error: 'shortName invalide (caractères interdits)' };
  }
  const safeName = shortName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(LEDGER_DIR, safeName + '.json');
  // Vérification finale : le chemin résolu doit bien être dans LEDGER_DIR
  const resolvedFile = path.resolve(file);
  const resolvedDir = path.resolve(LEDGER_DIR);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    return { ok: false, error: 'Chemin de fichier hors du dossier autorisé' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'Carnet introuvable : ' + shortName };
  }
  // Récupère le rang du modèle à supprimer dans le classement actuel, pour
  // ajuster le snapshot de position (cf. adjustSnapshotForDeletion).
  let deletedRank = null;
  try {
    const ledgers = loadAllLedgers();
    const entries = ledgers.map(aggregateLedger).filter(Boolean);
    entries.sort((a, b) => {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.score !== a.score) return b.score - a.score;
      return b.globalLifeScore - a.globalLifeScore;
    });
    deletedRank = entries.findIndex(e => e.shortName === safeName);
    if (deletedRank >= 0) {
      adjustSnapshotForDeletion(safeName, entries);
    }
  } catch (e) {
    logger.warn('Impossible de calculer le rang du modèle supprimé : ' + e.message);
  }
  fs.unlinkSync(file);
  logger.info('Carnet supprimé : ' + safeName + '.json');
  generateLeaderboard();
  return { ok: true };
}

// Supprime une école spécifique du carnet d'un modèle, puis régénère le classement.
// Utile quand un modèle a été testé sur une école trop avancée pour son nombre
// de paramètres (ex: Phi-4 14.7B testé sur Université qui requiert 15B min).
function deleteEcoleFromLedger(shortName, ecoleName) {
  if (!shortName || typeof shortName !== 'string') {
    return { ok: false, error: 'shortName manquant ou invalide' };
  }
  if (!ecoleName || typeof ecoleName !== 'string') {
    return { ok: false, error: 'ecoleName manquant ou invalide' };
  }
  if (/[\/\\]/.test(shortName) || shortName === '..' || shortName.includes('..')) {
    return { ok: false, error: 'shortName invalide (caractères interdits)' };
  }
  const safeName = shortName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(LEDGER_DIR, safeName + '.json');
  const resolvedFile = path.resolve(file);
  const resolvedDir = path.resolve(LEDGER_DIR);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    return { ok: false, error: 'Chemin de fichier hors du dossier autorisé' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'Carnet introuvable : ' + shortName };
  }
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ledger.ecoles || !ledger.ecoles[ecoleName]) {
      return { ok: false, error: 'École "' + ecoleName + '" introuvable dans le carnet de ' + shortName };
    }
    delete ledger.ecoles[ecoleName];
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    logger.info('École "' + ecoleName + '" supprimée du carnet de ' + safeName);
    generateLeaderboard();
    return { ok: true };
  } catch (e) {
    logger.error('Erreur lors de la suppression de l\'école : ' + e.message);
    return { ok: false, error: e.message };
  }
}

// Démarre un mini-serveur HTTP servant le classement HTML + l'API de suppression
// + l'API d'export du rapport intégral d'un modèle (téléchargement Markdown).
//
// SÉCURITÉ :
//   - Le serveur n'écoute que sur localhost (pas d'exposition réseau externe).
//   - Les en-têtes CORS restreignent l'origine à localhost uniquement pour
//     empêcher les attaques CSRF depuis des sites web malveillants.
//   - Les tokens GitHub (PAT) sont transmis via le corps de la requête POST
//     (JSON), JAMAIS en query string (visible dans les logs/access logs).
//   - Le paramètre shortName est validé (sanitization) pour empêcher le path
//     traversal (cf. deleteLedger).
function startServer(port) {
  port = port || 3939;
  const htmlPath = path.join(EXPORT_DIR, 'classement.html');

  // Redirige TOUS les logs vers un fichier FIXE (logs/serveur.log), remis a
  // zéro a chaque démarrage. Cela evite l'accumulation de dizaines de fichiers
  // timestamp incomprehensibles : l'utilisateur sait toujours ou regarder.
  // Vider avec : node scripts/show-log.js
  const SERVER_LOG = path.join(__dirname, 'logs', 'serveur.log');
  logger.setLogFile(SERVER_LOG);
  logger.truncateLogFile();
  logger.info('[serveur] Démarrage du classement interactif sur le port ' + port);
  console.log('  \x1b[90mLogs serveur : ' + SERVER_LOG + '\x1b[0m');
  console.log('  \x1b[90mPour afficher les logs : node scripts/show-log.js\x1b[0m');

  // En-têtes de sécurité appliqués à toutes les réponses API JSON.
  // CORS strict : seul localhost est autorisé (pas de page web externe).
  const securityHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://localhost:' + port,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  };

  // Lit le corps JSON d'une requête POST (limité à 64KB pour éviter le DoS).
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) { reject(new Error('Corps de requête trop volumineux')); req.destroy(); return; }
        body += chunk;
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (_) { reject(new Error('JSON invalide')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Log de TOUTES les requêtes API entrantes (méthode + chemin + durée).
    // Permet de diagnostiquer les soumissions communautaires : si aucune
    // ligne n'apparaît pendant un clic "Envoyer à la communauté", c'est que
    // le navigateur n'arrive pas à joindre le serveur (port, origine, etc.).
    const _reqStart = Date.now();
    res.on('finish', () => {
      if (url.pathname.indexOf('/api/') === 0) {
        logger.info('[HTTP] ' + req.method + ' ' + url.pathname + ' → ' + res.statusCode + ' (' + (Date.now() - _reqStart) + 'ms)');
      }
    });
    res.on('error', (e) => {
      if (url.pathname.indexOf('/api/') === 0) {
        logger.error('[HTTP] ' + req.method + ' ' + url.pathname + ' — erreur socket : ' + e.message);
      }
    });

    // Requête OPTIONS (CORS preflight) : répondre avec les en-têtes CORS
    if (req.method === 'OPTIONS') {
      res.writeHead(204, securityHeaders);
      res.end();
      return;
    }

    // Vérification de l'origine : rejeter les requêtes venant d'autres sites
    // (protection CSRF). En localhost, l'Origin peut être absente (même origine).
    const origin = req.headers.origin;
    if (origin && origin !== 'http://localhost:' + port) {
      res.writeHead(403, securityHeaders);
      res.end(JSON.stringify({ ok: false, error: 'Origine non autorisée' }));
      return;
    }

    // API : suppression d'un modèle
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const result = deleteLedger(shortName);
      res.writeHead(200, securityHeaders);
      res.end(JSON.stringify(result));
      return;
    }

    // API : suppression d'une école spécifique d'un carnet
    // POST /api/delete-ecole?shortName=...&ecole=... → supprime l'école du carnet.
    // Permet de retirer une école trop avancée pour le nombre de paramètres du modèle.
    if (url.pathname === '/api/delete-ecole' && req.method === 'POST') {
      const shortName = url.searchParams.get('shortName');
      const ecole = url.searchParams.get('ecole');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      if (!ecole) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'ecole manquant' }));
        return;
      }
      const result = deleteEcoleFromLedger(shortName, ecole);
      res.writeHead(200, securityHeaders);
      res.end(JSON.stringify(result));
      return;
    }

    // API : quantification manuelle d'un modèle (saisie depuis la modale).
    // GET  /api/model-quantization?shortName=... → { ok, quantization }
    // POST /api/model-quantization?shortName=... (body: { quantization }) → carnet.
    // Permet de corriger/compléter la quantification quand LM Studio ne la fournit
    // pas ou quand le modèle a été testé hors LM Studio.
    if (url.pathname === '/api/model-quantization') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const { loadLedger } = require('./score-ledger');
      if (req.method === 'GET') {
        const ledger = loadLedger(shortName);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, quantization: ledger.quantization || null }));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const quant = (body.quantization || '').trim();
        try {
          const ledger = loadLedger(shortName);
          if (quant) {
            ledger.quantization = quant;
          } else {
            delete ledger.quantization;
          }
          const { saveLedger } = require('./score-ledger');
          saveLedger(ledger);
          logger.info('API: Quantification de ' + shortName + ' mise à jour — ' + (quant || '(effacée)'));
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: true, quantization: quant || null }));
        } catch (e) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // API : note personnelle d'un modèle (saisie depuis la modale).
    // GET  /api/model-note?shortName=... → { ok, note }
    // POST /api/model-note?shortName=... (body: { note }) → carnet.
    // Permet d'ajouter des annotations personnelles persistantes par modèle.
    if (url.pathname === '/api/model-note') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const { loadLedger } = require('./score-ledger');
      if (req.method === 'GET') {
        const ledger = loadLedger(shortName);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, note: ledger.note || null }));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const note = (body.note || '').trim();
        try {
          const ledger = loadLedger(shortName);
          if (note) {
            ledger.note = note;
          } else {
            delete ledger.note;
          }
          const { saveLedger } = require('./score-ledger');
          saveLedger(ledger);
          logger.info('API: Note de ' + shortName + ' mise à jour — ' + (note ? '(' + note.length + ' caractères)' : '(effacée)'));
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: true, note: note || null }));
        } catch (e) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // API : nombre de paramètres manuel d'un modèle (saisie depuis la modale).
    // GET  /api/model-paramsize?shortName=... → { ok, paramSize }
    // POST /api/model-paramsize?shortName=... (body: { paramSize }) → carnet.
    // Permet de corriger la taille quand elle n est pas détectable depuis le nom.
    if (url.pathname === '/api/model-paramsize') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const { loadLedger } = require('./score-ledger');
      if (req.method === 'GET') {
        const ledger = loadLedger(shortName);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, paramSize: ledger.paramSize || null }));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const raw = parseFloat(body.paramSize);
        const paramSize = isFinite(raw) && raw > 0 ? raw : null;
        try {
          const ledger = loadLedger(shortName);
          if (paramSize) {
            ledger.paramSize = paramSize;
          } else {
            delete ledger.paramSize;
          }
          const { saveLedger } = require('./score-ledger');
          saveLedger(ledger);
          logger.info('API: Paramètres de ' + shortName + ' mis à jour — ' + (paramSize || '(effacé)'));
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: true, paramSize: paramSize || null }));
        } catch (e) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // API : nom d'affichage personnalisé d'un modèle (saisie depuis la modale).
    // GET  /api/model-displayname?shortName=... → { ok, displayName }
    // POST /api/model-displayname?shortName=... (body: { displayName }) → carnet.
    // Permet de corriger le titre affiché quand LM Studio ne fournit que le nom
    // de base (ex: "Phi 4" au lieu de "Phi 4 15B Q5_K_L"). Indispensable pour
    // distinguer plusieurs modèles au même nom mais quantifications/paramètres
    // différents dans le leaderboard.
    if (url.pathname === '/api/model-displayname') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const { loadLedger } = require('./score-ledger');
      if (req.method === 'GET') {
        const ledger = loadLedger(shortName);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, displayName: ledger.displayName || null, model: ledger.model || null }));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const name = (body.displayName || '').trim();
        try {
          const ledger = loadLedger(shortName);
          if (name) {
            ledger.displayName = name;
          } else {
            delete ledger.displayName;
          }
          const { saveLedger } = require('./score-ledger');
          saveLedger(ledger);
          logger.info('API: Nom d affichage de ' + shortName + ' mis à jour — ' + (name || '(effacé, retour au nom brute)'));
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: true, displayName: name || null }));
        } catch (e) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // API : validation d'un token GitHub (vérifie /user).
    // Le token est lu depuis le corps JSON de la requête POST (plus en query string).
    if (url.pathname === '/api/submit-validate' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      const token = body.token;
      if (!token) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'token manquant' }));
        return;
      }
      try {
        const validation = await communitySync.validateGithubToken(token);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify(validation));
      } catch (e) {
        logger.error('[/api/submit-validate] ' + (e && e.stack || e));
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // API : liste des modèles déjà soumis sur GitHub par cet utilisateur.
    // Renvoie un tableau de shortNames déjà présents dans submissions/<userId>/.
    // Permet à la modale de n'afficher que les nouveaux modèles à soumettre.
    if (url.pathname === '/api/already-submitted' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      const token = body.token;
      if (!token) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'token manquant' }));
        return;
      }
      try {
        const submitted = await communitySync.getAlreadySubmittedModels(token);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, submitted: Array.from(submitted) }));
      } catch (e) {
        logger.error('[/api/already-submitted] ' + (e && e.stack || e));
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // API : vérifie quels carnets locaux ont été modifiés par rapport à leur
    // soumission sur GitHub. Reçoit { token, shortNames: [...] } et retourne
    // { ok, changed: [...], unchanged: [...] }. Permet à doSubmitAll() de ne
    // renvoyer que les modèles réellement modifiés (quantification, note,
    // paramSize, score, etc.) au lieu de tout renvoyer à chaque fois.
    if (url.pathname === '/api/submit-check' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      const token = body.token;
      const shortNames = Array.isArray(body.shortNames) ? body.shortNames : [];
      if (!token) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'token manquant' }));
        return;
      }
      try {
        const { loadLedger } = require('./score-ledger');
        // Calcule le score agrégé réel d un carnet en sommant les best.score
        // de chaque ecole. Le carnet n a pas de champ score racine, donc la
        // comparaison precedente comparait undefined vs undefined et ne
        // detectait jamais un changement de score (re-test, rattrapage...).
        function aggregateScoreFromLedger(ledger) {
          if (!ledger || !ledger.ecoles) return null;
          let score = 0, max = 0;
          let hasAny = false;
          for (const raw of Object.values(ledger.ecoles)) {
            const best = (raw && raw.best) ? raw.best
              : (Array.isArray(raw && raw.attempts) && raw.attempts.length
                  ? raw.attempts.reduce((b, a) => ((a.pct || 0) >= (b.pct || 0) ? a : b), raw.attempts[0])
                  : null);
            if (!best) continue;
            score += best.score || 0;
            max += best.max || 0;
            hasAny = true;
          }
          if (!hasAny) return null;
          return { score, max };
        }
        const changed = [];
        const unchanged = [];
        const newModels = [];
        // Parallélisation avec concurrence limitée (8) pour éviter que la
        // réponse HTTP dépasse le timeout réseau du navigateur (Chrome/Edge
        // coupent les fetch au bout de ~5 min d'inactivité → "Failed to fetch").
        // Version séquentielle : 41 modèles × 5-10s = jusqu'à 7 min → timeout.
        // Version parallèle (8) : ~1 min → sous le timeout navigateur.
        // L'API GitHub accepte bien la concurrence (rate limit 5000 req/h auth).
        const SUBMIT_CHECK_CONCURRENCY = 8;
        const checkQueue = shortNames.slice();
        async function processCheckOne(sn) {
          const remote = await communitySync.getSubmissionContent(token, sn);
          if (!remote) { newModels.push(sn); return; }
          const local = loadLedger(sn);
          if (!local) { unchanged.push(sn); return; }
          // Comparaison des champs pertinents (pas tout le carnet — juste les
          // champs qui justifient une mise a jour de la soumission).
          const fields = ['quantization', 'note', 'paramSize', 'modelUrl', 'model', 'shortName'];
          let isChanged = false;
          for (const f of fields) {
            const localVal = local[f] != null ? String(local[f]) : '';
            const remoteVal = remote[f] != null ? String(remote[f]) : '';
            if (localVal !== remoteVal) { isChanged = true; break; }
          }
          // Comparaison du score agrégé (le carnet peut avoir été re-testé).
          // On compare score ET max car le total possible peut evoluer si le
          // modele a ete teste sur plus d ecoles.
          if (!isChanged) {
            const localAgg = aggregateScoreFromLedger(local);
            const remoteAgg = aggregateScoreFromLedger(remote);
            if (!localAgg || !remoteAgg) {
              if (!!localAgg !== !!remoteAgg) isChanged = true;
            } else if (localAgg.score !== remoteAgg.score || localAgg.max !== remoteAgg.max) {
              isChanged = true;
            }
          }
          if (isChanged) changed.push(sn);
          else unchanged.push(sn);
        }
        const checkWorkers = [];
        for (let w = 0; w < Math.min(SUBMIT_CHECK_CONCURRENCY, checkQueue.length); w++) {
          checkWorkers.push((async () => {
            while (checkQueue.length > 0) {
              const sn = checkQueue.shift();
              if (sn === undefined) break;
              await processCheckOne(sn);
            }
          })());
        }
        await Promise.all(checkWorkers);
        logger.info('[/api/submit-check] OK — ' + changed.length + ' modifie(s), ' + newModels.length + ' nouveau(x), ' + unchanged.length + ' inchange(s)');
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, changed, unchanged, newModels }));
      } catch (e) {
        logger.error('[/api/submit-check] ' + (e && e.stack || e));
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // API : lecture / modification de l'URL du modèle (lien Hugging Face, LM Studio...).
    // GET  /api/model-url?shortName=... → renvoie { ok, modelUrl }
    // POST /api/model-url?shortName=... (body: { modelUrl }) → sauvegarde dans le carnet.
    // Permet à l'utilisateur d'ajouter/modifier le lien du modèle depuis la modale.
    if (url.pathname === '/api/model-url') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const { loadLedger } = require('./score-ledger');
      if (req.method === 'GET') {
        const ledger = loadLedger(shortName);
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: true, modelUrl: ledger.modelUrl || guessModelUrl(ledger.model, ledger.publisher) || null }));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const modelUrl = (body.modelUrl || '').trim();
        try {
          const ledger = loadLedger(shortName);
          if (modelUrl) {
            ledger.modelUrl = modelUrl;
          } else {
            delete ledger.modelUrl;
          }
          const { saveLedger } = require('./score-ledger');
          saveLedger(ledger);
          logger.info('API: URL du modèle ' + shortName + ' mise à jour — ' + (modelUrl || '(effacée)'));
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: true, modelUrl: modelUrl || null }));
        } catch (e) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // API : soumission d'un carnet vers le dépôt communautaire (Pull Request GitHub).
    // Lit le carnet local, le soumet via community-sync.js (crée branche + fichier + PR).
    // Le token et le pseudo sont lus depuis le corps JSON de la requête POST.
    if (url.pathname === '/api/submit' && req.method === 'POST') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      const pseudo = body.pseudo || null;
      const token = body.token;
      if (!token) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'token GitHub manquant' }));
        return;
      }
      try {
        const { loadLedger } = require('./score-ledger');
        const ledger = loadLedger(shortName);
        if (!ledger || !ledger.ecoles || Object.keys(ledger.ecoles).length === 0) {
          res.writeHead(200, securityHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Carnet vide ou introuvable : ' + shortName }));
          return;
        }
        const result = await communitySync.submitResults(shortName, ledger, token, {
          pseudo: pseudo || null,
          benchgoVersion: 'V3'
        });
        logger.info('[/api/submit] OK — ' + shortName + ' — PR #' + result.prNumber + (result.merged ? ' (mergee)' : ' (non mergee)'));
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify(result));
      } catch (e) {
        logger.error('[/api/submit] ' + shortName + ' — ' + (e && e.stack || e));
        res.writeHead(200, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // API : export du rapport intégral d'un modèle (téléchargement Markdown).
    // Génère à la volée le rapport complet (auto-profilage, toutes écoles, tous
    // tiers, exercices, code, raisonnement brut) prêt à transmettre à un modèle
    // cloud (Gemini, ChatGPT…) pour analyse → verdict → NotebookLM.
    if (url.pathname === '/api/report' && req.method === 'GET') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const entry = getModelEntryByShortName(shortName);
      if (!entry) {
        res.writeHead(404, securityHeaders);
        res.end(JSON.stringify({ ok: false, error: 'Modèle introuvable : ' + shortName }));
        return;
      }
      // En-tête Markdown global + rapport du modèle
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const genTime = `${pad(now.getHours())}h${pad(now.getMinutes())}`;
      let md = `# 🧠 Rapport intégral — ${entry.model}\n\n`;
      md += `> Fichier généré le ${genDate} à ${genTime} — destiné à l'analyse qualitative\n`;
      md += `> par un modèle cloud (Gemini, ChatGPT, Claude…) puis injection dans NotebookLM.\n`;
      md += `> Transmettez ce fichier au modèle et demandez une analyse du raisonnement,\n`;
      md += `> des échecs, du code produit et un verdict qualitatif global.\n\n`;
      md += `---\n\n`;
      md += buildModelReportMarkdown(entry);

      const safeName = String(entry.shortName || 'modele').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `rapport_integral_${safeName}_${genDate}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(md, 'utf8');
      return;
    }

    // --- Dashboard web (§3 UI/Ludisme) ---
    // /api/dashboard-data : delegue vers dashboard.js (fichier autonome).
    if (url.pathname === '/api/dashboard-data' && req.method === 'GET') {
      dashboard.handleDashboardApi(req, res);
      return;
    }

    // /dashboard : page HTML autonome (dashboard.js) avec Chart.js + selecteurs multi-graphiques.
    if (url.pathname === '/dashboard') {
      const dash = dashboard.buildDashboardHTML();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dash, 'utf8');
      return;
    }

    // /api/community-ranking : sert le classement communautaire consolidé
    if (url.pathname === '/api/community-ranking') {
      const communityPath = path.join(__dirname, 'gh-pages-output', 'community-leaderboard.html');
      try {
        const communityHtml = fs.readFileSync(communityPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(communityHtml, 'utf8');
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Classement communautaire non trouvé</h1><p>Génère-le d\'abord avec <code>node consolidate-leaderboard.js</code>.</p>', 'utf8');
      }
      return;
    }

    // Page par défaut : sert le classement HTML (ou le Markdown si demandé)
    let content, type;
    if (url.pathname === '/classement.md') {
      const mdPath = path.join(EXPORT_DIR, 'classement.md');
      content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '# Classement vide';
      type = 'text/plain; charset=utf-8';
    } else {
      content = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '<h1>Aucun classement. Lancez node leaderboard.js</h1>';
      type = 'text/html; charset=utf-8';
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('');
      console.log(`  \x1b[31mErreur : le port ${port} est déjà utilisé.\x1b[0m`);
      console.log('  \x1b[33mUn serveur occupe déjà ce port (peut-être une session précédente non fermée).\x1b[0m');
      console.log(`  \x1b[90mSolutions :\x1b[0m`);
      console.log(`  \x1b[90m  • Fermez l'autre serveur (Ctrl+C dans son terminal) puis relancez.\x1b[0m`);
      console.log(`  \x1b[90m  • Ou utilisez un autre port : node leaderboard.js --serve --port=${port + 1}\x1b[0m`);
      console.log(`  \x1b[90m  • Sous Windows : netstat -ano | findstr :${port}  puis  taskkill /PID <pid> /F\x1b[0m\n`);
      process.exit(1);
    } else {
      console.error(`  \x1b[31mErreur serveur : ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port;
    console.log('');
    console.log('  \x1b[1;35m━━━ CLASSEMENT INTERACTIF — BenchGo V3 ━━━\x1b[0m');
    console.log(`  \x1b[32mServeur démarré : ${url}\x1b[0m`);
    console.log('  \x1b[90mOuvrez le navigateur. Cliquez sur "🗑 Supprimer" pour retirer un modèle.\x1b[0m');
    console.log('  \x1b[90mBouton "🌐 Envoyer à la communauté" pour soumettre vos résultats sur GitHub.\x1b[0m');
    console.log('  \x1b[90mModale → bouton "⬇ Exporter le rapport intégral" pour télécharger le MD.\x1b[0m');
    console.log('  \x1b[90mBoutons "📄 Exporter PDF" / "📊 Exporter CSV" / "📝 Exporter Markdown" : export du classement.\x1b[0m');
    console.log(`  \x1b[1;36mDashboard progression/historique : ${url}/dashboard\x1b[0m`);
    console.log('  \x1b[90mCtrl+C pour arrêter le serveur.\x1b[0m\n');

    // Désactive les timeouts HTTP de Node 18+ qui coupent les longues requêtes
    // (la soumission communautaire peut prendre plusieurs minutes). Sans cela,
    // server.requestTimeout (300s par défaut) ferme la connexion → "Failed to fetch".
    server.requestTimeout = 0;
    server.headersTimeout = 0;

    // Ouvre le navigateur par défaut
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd, () => {});
  });
}

// Retrouve l'entry agrégée d'un modèle par shortName (charge + agrège les carnets).
// Utilisé par la route /api/report pour générer le rapport intégral d'un modèle.
function getModelEntryByShortName(shortName) {
  const ledgers = loadAllLedgers();
  const entry = ledgers.map(aggregateLedger).filter(Boolean).find(e => e.shortName === shortName);
  return entry || null;
}

// Le dashboard web (page HTML + API /api/dashboard-data) est desormais gere par
// le module autonome dashboard.js (buildDashboardHTML, buildDashboardData,
// handleDashboardApi). Il embarque Chart.js + selecteurs multi-graphiques
// (progression temporelle, comparaison, fiche modele, analyse par ecole).
// Voir dashboard.js pour le code source du dashboard.

// --- (ancien buildDashboardHTML supprime : code deplace vers dashboard.js) ---
// Fonction vide conservee pour compatibilite retroactive (appel direct externe).
function buildDashboardHTML() {
  return require('./dashboard').buildDashboardHTML();
}


module.exports = {
  loadAllLedgers,
  aggregateLedger,
  buildArguments,
  getVerdict,
  getCategory,
  getParamSize,
  buildLeaderboardHTML,
  buildLeaderboardMarkdown,
  buildReasoningMarkdown,
  generateLeaderboard,
  deleteLedger,
  startServer,
  buildDashboardHTML,
  printCloudLeaderboard,
  markCloudModel,
  detectIsCloudFromLedger,
  printLmStudioStatus
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const serveMode = args.includes('--serve') || args.includes('-s');
  const cloudMode = args.includes('--cloud');
  const lmstudioMode = args.includes('--lmstudio') || args.includes('--lmstudio-status');
  const markCloudArg = args.find(a => a.startsWith('--mark-cloud='));
  const portArg = args.find(a => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 3939;

  // --mark-cloud=<shortName> : migration manuelle d un carnet vers le statut
  // cloud frontière. Sort immédiatement après la migration (pas de génération).
  if (markCloudArg) {
    const shortName = markCloudArg.slice('--mark-cloud='.length);
    markCloudModel(shortName);
    process.exit(0);
  }

  // --lmstudio / --lmstudio-status : rapport de suivi complet pour LM Studio.
  // Combine en une vue unifiée les modèles LM Studio déjà testés (Bloc 1, tri
  // chronologique inversé) et les modèles LM Studio détectés mais non encore
  // testés (Bloc 2, statut [NON TESTÉ]). Sort après affichage (pas de génération HTML).
  if (lmstudioMode) {
    printLmStudioStatus();
    process.exit(0);
  }

  // --cloud : classement spécifique aux modèles frontière cloud (API). Séparé
  // du classement général pour ne pas mélanger oranges (cloud) et pommes
  // (local LM Studio). Sort après affichage (pas de génération HTML).
  if (cloudMode) {
    printCloudLeaderboard();
    process.exit(0);
  }

  if (serveMode) {
    generateLeaderboard();
    startServer(port);
  } else {
    const result = generateLeaderboard();
    if (!result) {
      console.log('\x1b[33mAucun carnet de scores trouvé. Lancez d\'abord un benchmark (node runner.js all --profile=LIGHT).\x1b[0m');
      console.log('\x1b[90mAstuce : node leaderboard.js --serve pour le mode interactif (boutons supprimer).\x1b[0m');
      console.log('\x1b[90mAstuce : node leaderboard.js --cloud pour le classement des modèles frontière cloud uniquement.\x1b[0m');
      process.exit(0);
    }
    console.log('\x1b[90mAstuce : node leaderboard.js --serve pour le mode interactif (boutons supprimer dans le navigateur).\x1b[0m');
    console.log('\x1b[90mAstuce : node leaderboard.js --cloud pour le classement des modèles frontière cloud uniquement.\x1b[0m');
    console.log('\x1b[90mAstuce : node leaderboard.js --lmstudio pour le rapport LM Studio (testés + non testés).\x1b[0m');
  }
}
