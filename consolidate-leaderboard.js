// consolidate-leaderboard.js — Construit le classement consolidé communautaire.
//
// Lancé par la GitHub Action (.github/workflows/consolidate.yml) après le merge
// d'une PR de soumission. Il parcourt tous les fichiers submissions/*/*.json du
// dépôt, agrège les carnets, et génère un classement HTML consolidé publié sur
// GitHub Pages (branche gh-pages).
//
// Ce script tourne dans l'environnement CI (Node.js 18+, pas de dépendances npm).
// Il lit les fichiers directement depuis le filesystem du checkout du dépôt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUBMISSIONS_DIR = path.join(__dirname, 'submissions');
const OUTPUT_DIR = path.join(__dirname, 'gh-pages-output');
const OUTPUT_HTML = path.join(OUTPUT_DIR, 'community-leaderboard.html');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'community-leaderboard.json');

// Devine l'URL Hugging Face d'un modèle à partir de son nom.
// Si le nom contient un "/" (ex: "unsloth/gemma-4-12b-it-qat"), on construit
// directement l'URL. Sinon, on essaie avec le publisher du carnet.
function guessModelUrl(modelName, publisher) {
  if (!modelName) return null;
  const name = String(modelName).trim();
  if (name.includes('/')) {
    const parts = name.split('/');
    if (parts.length >= 2) {
      return 'https://huggingface.co/' + parts.slice(0, 2).join('/');
    }
  }
  if (publisher) {
    const baseName = name.split('/').pop().replace(/\.gguf$/i, '');
    return 'https://huggingface.co/' + publisher + '/' + baseName;
  }
  return null;
}

// Charge toutes les soumissions depuis submissions/<userId>/<model>.json.
function loadAllSubmissions() {
  const submissions = [];
  if (!fs.existsSync(SUBMISSIONS_DIR)) return submissions;

  const userDirs = fs.readdirSync(SUBMISSIONS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const userDir of userDirs) {
    const userPath = path.join(SUBMISSIONS_DIR, userDir);
    const files = fs.readdirSync(userPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(userPath, file), 'utf8'));
        if (data && data.carnet && data.carnet.ecoles) {
          submissions.push({
            userId: data.userId || userDir,
            pseudo: data.pseudo || null,
            submittedAt: data.submittedAt || null,
            integrityHash: data.integrityHash || null,
            carnet: data.carnet
          });
        }
      } catch (e) {
        // Fichier illisible — on l'ignore
      }
    }
  }
  return submissions;
}

// Labels et couleurs par provider cloud, pour le badge d'origine dans le
// classement communautaire. Permet de différencier OpenRouter, OpenAI, Ollama,
// etc. au lieu d'un "Cloud" générique. Synchronisé avec leaderboard.js.
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

function providerDisplay(provider, isCloud) {
  if (provider && PROVIDER_DISPLAY[provider]) return PROVIDER_DISPLAY[provider];
  if (provider && provider !== 'local') {
    return { label: provider, icon: '☁️', color: '#d29922' };
  }
  if (isCloud) return { label: 'Cloud', icon: '☁️', color: '#d29922' };
  return { label: 'Local', icon: '🏠', color: '#3fb950' };
}

// Heuristique de détection de l'origine (cloud vs local) pour les carnets
// soumis qui ne stockent pas provider/isCloud. Réplique detectIsCloudFromLedger
// de leaderboard.js. Signaux forts uniquement :
//   1. Slug OpenRouter ":free" (exclusif aux modèles cloud gratuits).
//   2. Présence du profil FRONTIER dans les attempts (réservé au cloud).
// Conservatrice : en cas de doute, on classe en local.
function detectIsCloudFromCarnet(carnet) {
  const model = (carnet.model || '').trim();
  if (!model) return false;
  if (/:free$/i.test(model)) return true;
  const ecoles = Object.values(carnet.ecoles || {});
  for (const ec of ecoles) {
    const attempts = (ec && ec.attempts) || [];
    for (const a of attempts) {
      if (a && a.profile === 'FRONTIER') return true;
    }
  }
  return false;
}

// Agrège un carnet en une entrée de classement (meilleure tentative par école).
function aggregateCarnet(carnet) {
  if (!carnet || !carnet.ecoles) return null;
  const ecoleEntries = Object.entries(carnet.ecoles);
  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  let totalTokens = 0, totalElapsedMs = 0, totalWallMs = 0;
  let mandatoryPassed = 0, mandatoryTotal = 0;
  let helpCount = 0, retriedCount = 0;
  let ecoleCount = 0;
  const ecoles = [];

  for (const [ecoleName, raw] of ecoleEntries) {
    let best = null;
    if (raw && raw.best) {
      best = raw.best;
    } else if (raw && raw.attempts && raw.attempts.length > 0) {
      best = raw.attempts.reduce((b, a) => ((a.pct || 0) >= (b.pct || 0)) ? a : b);
    } else if (raw && raw.score != null) {
      best = raw;
    }
    if (!best) continue;
    ecoleCount++;
    score += best.score || 0;
    max += best.max || 0;
    globalLifeScore += best.globalLifeScore || 0;
    optionalBonus += best.optionalBonus || 0;
    totalTokens += best.tokens || 0;
    totalElapsedMs += best.elapsedMs || 0;
    totalWallMs += best.wallMs || 0;
    mandatoryPassed += best.mandatoryPassed || 0;
    mandatoryTotal += best.mandatoryTotal || 0;
    helpCount += best.helpCount || 0;
    retriedCount += best.retriedCount || 0;

    const ePct = best.max > 0 ? Math.round((best.score / best.max) * 100) : 0;
    ecoles.push({
      ecole: best.ecole || ecoleName,
      score: best.score || 0,
      max: best.max || 0,
      pct: ePct,
      optionalBonus: best.optionalBonus || 0,
      globalLifeScore: best.globalLifeScore || 0,
      helpCount: best.helpCount || 0,
      retriedCount: best.retriedCount || 0,
      date: best.date || '—',
      elapsedMs: best.elapsedMs || 0,
      tokens: best.tokens || 0,
      tokensPerSecond: best.tokensPerSecond || 0,
      tiers: (best.tiers || []).map(t => ({
        tierNum: t.tierNum,
        tierTitle: t.tierTitle || '',
        className: t.className || '',
        isMandatory: !!t.isMandatory,
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
      })),
      selfProfile: best.selfProfile || null
    });
  }

  if (ecoleCount === 0 || max === 0) return null;

  const pct = Math.round((score / max) * 100);
  const tokensPerSecond = totalElapsedMs > 0
    ? Math.round((totalTokens / (totalElapsedMs / 1000)) * 100) / 100
    : 0;
  const mandatoryPct = mandatoryTotal > 0 ? Math.round((mandatoryPassed / mandatoryTotal) * 100) : 0;

  // Détection de l'origine (cloud vs local) : priorité aux champs explicites du
  // carnet (provider/isCloud). Pour les carnets soumis sans ces champs, on
  // utilise l'heuristique (slug :free, profil FRONTIER) pour départager.
  const isCloud = Boolean(carnet.isCloud || (carnet.provider && carnet.provider !== 'local') || detectIsCloudFromCarnet(carnet));

  return {
    model: carnet.model || carnet.shortName || 'Inconnu',
    shortName: carnet.shortName || (carnet.model || 'inconnu').toLowerCase().replace(/[^a-z0-9]/g, '-'),
    quantization: carnet.quantization || null,
    modelUrl: carnet.modelUrl || guessModelUrl(carnet.model, carnet.publisher) || null,
    note: carnet.note || null,
    publisher: carnet.publisher || null,
    provider: carnet.provider || null,
    isCloud,
    score, max, pct, globalLifeScore, optionalBonus,
    mandatoryPassed, mandatoryTotal, mandatoryPct,
    helpCount, retriedCount,
    tokens: totalTokens, elapsedMs: totalElapsedMs, wallMs: totalWallMs, tokensPerSecond,
    ecoleCount,
    ecoles,
    ecoleNames: ecoles.map(e => e.ecole),
    pseudo: null,
    submittedAt: null
  };
}

// Normalise un nom de modèle pour la clé de dédoublonnage.
// Retire le préfixe publisher (ex: "unsloth/gemma-4-12b-it-qat" -> "gemma-4-12b-it-qat")
// et normalise la casse + séparateurs pour que deux soumissions du même modèle
// sous des publishers différents (unsloth/, lmstudio-community/, etc.) soient
// reconnues comme un seul modèle.
function normalizeModelKey(modelName, shortName) {
  let base = modelName || shortName || 'inconnu';
  base = String(base).trim().toLowerCase();
  if (base.includes('/')) {
    base = base.split('/').pop();
  }
  return base.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Dédoublonne les entrées : si plusieurs utilisateurs ont soumis le même modèle,
// on garde la meilleure soumission (pct le plus élevé). On marque le nombre de
// contributeurs pour afficher "testé par N personnes".
// La clé de dédoublonnage est normalisée (sans préfixe publisher) pour éviter
// les doublons quand le même modèle est soumis sous différents publishers
// (ex: "unsloth/gemma-4-12b-it-qat" vs "gemma-4-12b-it-qat").
function deduplicateAndMerge(entries) {
  const byKey = {};
  for (const entry of entries) {
    const key = normalizeModelKey(entry.model, entry.shortName);
    if (!byKey[key]) {
      byKey[key] = { ...entry, contributors: 1, allPct: [entry.pct] };
    } else {
      const existing = byKey[key];
      existing.contributors++;
      existing.allPct.push(entry.pct);
      // Garde la meilleure soumission (pct le plus élevé)
      if (entry.pct > existing.pct) {
        const contributors = existing.contributors;
        const allPct = existing.allPct;
        Object.assign(existing, entry);
        existing.contributors = contributors;
        existing.allPct = allPct;
      } else if (entry.pct === existing.pct) {
        // En cas d'égalité de pct, on préfère le nom de modèle le plus propre
        // (sans préfixe publisher) pour l'affichage
        const existingHasPrefix = (existing.model || '').includes('/');
        const entryHasPrefix = (entry.model || '').includes('/');
        if (existingHasPrefix && !entryHasPrefix) {
          const contributors = existing.contributors;
          const allPct = existing.allPct;
          Object.assign(existing, entry);
          existing.contributors = contributors;
          existing.allPct = allPct;
        }
        // Si les deux ont un préfixe ou aucun, on garde l'existant (premier arrivé)
      }
    }
  }
  // Normalise le shortName de chaque entrée fusionnée pour l'affichage
  // (retire le préfixe publisher du shortName, ex: "unsloth_gemma-4-12b-it-qat" -> "gemma-4-12b-it-qat")
  const result = Object.values(byKey);
  for (const entry of result) {
    entry.shortName = normalizeModelKey(entry.model, entry.shortName);
  }
  return result;
}

// Génère le HTML du classement consolidé — même style que le leaderboard principal.
function buildConsolidatedHTML(entries) {
  entries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  const generatedAt = new Date().toLocaleString('fr-FR');

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Catégories (identiques au leaderboard principal — leaderboard.js#getCategory)
  function getCategory(pct, rank) {
    if (rank <= 3) return { key: 'top', icon: '🏆', label: 'Top du top' };
    if (pct >= 90) return { key: 'recommande', icon: '✅', label: 'Recommandé' };
    if (pct >= 75) return { key: 'moyenne', icon: '📊', label: 'Dans la moyenne' };
    if (pct >= 50) return { key: 'rattrapage', icon: '⚠️', label: 'En rattrapage' };
    return { key: 'catastrophe', icon: '💥', label: 'Échec total' };
  }

  // Taille du modèle par nom
  function getParamSize(modelName) {
    const m = (modelName || '').match(/([\d]+[.,]?[\d]*)\s*b/i);
    if (!m) return { key: 'inconnu', icon: '❓', label: 'Taille inconnue', short: '?' };
    const size = parseFloat(m[1].replace(',', '.'));
    if (size < 3) return { key: 'petit', icon: '🐱', label: '< 3B', short: size + 'B' };
    if (size <= 15) return { key: 'standard', icon: '📦', label: '3B-15B', short: size + 'B' };
    if (size <= 30) return { key: 'expert', icon: '🎓', label: '15B-30B', short: size + 'B' };
    return { key: 'doctorat', icon: '🧠', label: '> 30B', short: size + 'B' };
  }

  function gradeLetter(pct) {
    if (pct >= 90) return 'A';
    if (pct >= 80) return 'B';
    if (pct >= 70) return 'C';
    if (pct >= 60) return 'D';
    return 'F';
  }

  function pctColor(pct) {
    if (pct >= 80) return '#3fb950';
    if (pct >= 70) return '#d29922';
    if (pct >= 50) return '#db6d28';
    return '#f85149';
  }

  function gradeColor(g) {
    if (g === 'A') return '#3fb950';
    if (g === 'B') return '#58a6ff';
    if (g === 'C') return '#d29922';
    if (g === 'D') return '#db6d28';
    return '#f85149';
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const total = Math.round(s);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    if (m < 60) return m + 'm' + String(sec).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return h + 'h' + String(min).padStart(2, '0') + 'm';
  }

  // Compteurs par catégorie pour les filtres
  const catCounts = { top: 0, recommande: 0, moyenne: 0, rattrapage: 0, catastrophe: 0 }
  const sizeCounts = { petit: 0, standard: 0, expert: 0, doctorat: 0, inconnu: 0 }
  const healthCounts = { positif: 0, negatif: 0 }
  const ecoleCounts = {}
  // Filtre Origine : départage les modèles locaux (LM Studio) des modèles cloud
  // (frontière API : OpenRouter, OpenAI, etc.). Les deux catégories n'ont rien à
  // voir et ne doivent pas être mélangées dans le classement communautaire.
  const originCounts = { local: 0, cloud: 0 }
  entries.forEach((e, idx) => {
    catCounts[getCategory(e.pct, idx + 1).key]++
    sizeCounts[getParamSize(e.model).key]++
    if ((e.globalLifeScore || 0) >= 0) healthCounts.positif++; else healthCounts.negatif++
    if (e.isCloud) originCounts.cloud++; else originCounts.local++
    for (const ec of (e.ecoles || [])) {
      ecoleCounts[ec.ecole] = (ecoleCounts[ec.ecole] || 0) + 1
    }
  })

  const totalSubmissions = entries.reduce((s, e) => s + (e.contributors || 1), 0)

  function safeForScript(json) {
    return String(json)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\`/g, '\\u0060')
      .replace(/\$\{/g, '\\u0024\\u007b')
  }

  function buildArguments(entry) {
    const forces = []
    const faiblesses = []
    const notes = []

    if (entry.pct >= 95) forces.push('maîtrise quasi-parfaite des exercices')
    else if (entry.pct >= 80) forces.push('bonne maîtrise globale des exercices')
    else if (entry.pct >= 70) forces.push('niveau acceptable, validation du seuil obligatoire')

    if (entry.mandatoryPct === 100) forces.push('100% du contenu obligatoire validé')
    else if (entry.mandatoryPct >= 80) forces.push('contenu obligatoire largement validé')
    else if (entry.mandatoryPct < 50 && entry.mandatoryTotal > 0) faiblesses.push('échec sur le contenu obligatoire de base')

    if (entry.optionalBonus > 0) forces.push('exercices optionnels réussis (+' + entry.optionalBonus + ' bonus)')
    if (entry.helpCount > 0) faiblesses.push('a eu besoin d\'aide du professeur (' + entry.helpCount + 'x)')
    if (entry.retriedCount > 0) faiblesses.push('exercices en rattrapage (' + entry.retriedCount + 'x)')

    if (entry.globalLifeScore > 0 && entry.pct >= 80) forces.push('santé robuste (' + entry.globalLifeScore + ' PV)')
    else if (entry.globalLifeScore < 0) faiblesses.push('santé critique (' + entry.globalLifeScore + ' PV)')

    if (entry.pct < 50) faiblesses.push('plus de la moitié des exercices échoués')

    if (entry.tokensPerSecond > 0) {
      if (entry.tokensPerSecond >= 60 && entry.pct >= 80) {
        forces.push('rapide ET efficace (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)')
      } else if (entry.tokensPerSecond < 20 && entry.pct >= 80) {
        forces.push('LENT mais efficace — la vitesse ne fait pas tout (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)')
      } else if (entry.tokensPerSecond >= 60 && entry.pct < 50) {
        faiblesses.push('rapide mais peu fiable — vitesse sans efficacité (' + entry.tokensPerSecond + ' t/s · ' + entry.pct + '%)')
      } else {
        notes.push('vitesse moyenne (' + entry.tokensPerSecond + ' t/s)')
      }
    }

    notes.push('évalué sur ' + entry.ecoleCount + ' école' + (entry.ecoleCount > 1 ? 's' : ''))
    if (entry.contributors > 1) notes.push('testé par ' + entry.contributors + ' contributeurs')

    return { forces, faiblesses, notes }
  }

  function getVerdict(entry, rank) {
    const p = entry.pct;
    if (typeof rank === 'number' && rank <= 3) return { label: 'TOP DU TOP', color: '#ffd700', rank: 0 }
    if (p >= 90) return { label: 'RECOMMANDÉ', color: '#28a745', rank: 1 }
    if (p >= 75) return { label: 'DANS LA MOYENNE', color: '#17a2b8', rank: 2 }
    if (p >= 50) return { label: 'EN RATTRAPAGE', color: '#ffc107', rank: 3 }
    return { label: 'ÉCHEC TOTAL', color: '#dc3545', rank: 4 }
  }

  const modelsJson = safeForScript(JSON.stringify(entries.map((e, idx) => {
    const rank = idx + 1
    const cat = getCategory(e.pct, rank)
    const psize = getParamSize(e.model)
    const verdict = getVerdict(e, idx + 1)
    const grade = gradeLetter(e.pct)
    const args = buildArguments(e)
    const provInfo = providerDisplay(e.provider, e.isCloud)
    return {
      rank, model: e.model, shortName: e.shortName,
      quantization: e.quantization, modelUrl: e.modelUrl || null,
      note: e.note || null,
      provider: e.provider || null, isCloud: Boolean(e.isCloud),
      provInfo,
      pct: e.pct, score: e.score, max: e.max,
      grade, globalLifeScore: e.globalLifeScore,
      mandatoryPct: e.mandatoryPct, mandatoryPassed: e.mandatoryPassed, mandatoryTotal: e.mandatoryTotal,
      optionalBonus: e.optionalBonus || 0, ecoleCount: e.ecoleCount,
      helpCount: e.helpCount || 0, retriedCount: e.retriedCount || 0,
      elapsedMs: e.elapsedMs || 0, wallMs: e.wallMs || 0,
      tokens: e.tokens || 0, tokensPerSecond: e.tokensPerSecond || 0,
      contributors: e.contributors || 1, pseudo: e.pseudo,
      submittedAt: e.submittedAt || null,
      cat, paramSize: psize, verdict, args,
      ecoles: (e.ecoles || []).map(ec => ({
        ecole: ec.ecole,
        score: ec.score, max: ec.max, pct: ec.pct, grade: gradeLetter(ec.pct),
        optionalBonus: ec.optionalBonus || 0, globalLifeScore: ec.globalLifeScore || 0,
        helpCount: ec.helpCount || 0, retriedCount: ec.retriedCount || 0,
        calibrationIndex: ec.calibrationIndex != null ? ec.calibrationIndex : null,
        date: ec.date || '—',
        elapsedMs: ec.elapsedMs || 0, tokens: ec.tokens || 0, tokensPerSecond: ec.tokensPerSecond || 0,
        attempts: [{
          n: 1, date: ec.date || '—', time: null, score: ec.score || 0, max: ec.max || 0,
          pct: ec.pct || 0, grade: gradeLetter(ec.pct || 0), optionalBonus: ec.optionalBonus || 0,
          globalLifeScore: ec.globalLifeScore || 0, helpCount: ec.helpCount || 0, retriedCount: ec.retriedCount || 0,
          calibrationIndex: ec.calibrationIndex != null ? ec.calibrationIndex : null,
          elapsedMs: ec.elapsedMs || 0, tokens: ec.tokens || 0, tokensPerSecond: ec.tokensPerSecond || 0
        }],
        selfProfile: ec.selfProfile || null,
        tiers: (ec.tiers || []).map(t => ({
          tierNum: t.tierNum, tierTitle: t.tierTitle || '', className: t.className || '',
          isMandatory: !!t.isMandatory, rawResponse: t.rawResponse || null,
          evalResults: (t.evalResults || []).map(r => ({
            id: r.id, taskType: r.taskType || null, status: r.status,
            points: r.points || 0, maxPoints: r.maxPoints || 0,
            helpUsed: !!r.helpUsed, retried: !!r.retried,
            code: r.code || null, failureExplanation: r.failureExplanation || null,
            teacherCorrection: r.teacherCorrection || null
          }))
        }))
      })),
      ecoleNames: e.ecoleNames || []
    }
  })))

  const ecoleOptions = Object.keys(ecoleCounts).sort().map(ec => `<option value="${esc(ec)}">🏫 ${esc(ec)} (${ecoleCounts[ec]})</option>`).join('')

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement Communautaire — BenchGo V3</title>
<style>
  :root {
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

    --space-xs: clamp(0.375rem, 0.3462rem + 0.1282vw, 0.5rem);
    --space-s:  clamp(0.75rem, 0.6923rem + 0.2564vw, 1rem);
    --space-m:  clamp(1rem, 0.8846rem + 0.5128vw, 1.5rem);
    --space-l:  clamp(1.5rem, 1.3077rem + 1.0256vw, 2.5rem);
    --space-xl: clamp(2.5rem, 2.1154rem + 1.6667vw, 4rem);

    --fs-display: clamp(1.9rem, 1.5538rem + 1.5385vw, 2.75rem);
    --fs-h1:      clamp(1.5rem, 1.3615rem + 0.6154vw, 1.85rem);
    --fs-h2:      clamp(1.15rem, 1.0808rem + 0.3077vw, 1.3rem);
    --fs-h3:      clamp(0.95rem, 0.9115rem + 0.1667vw, 1.05rem);
    --fs-body:    clamp(0.9rem, 0.8808rem + 0.0833vw, 0.97rem);
    --fs-small:   clamp(0.78rem, 0.7654rem + 0.0641vw, 0.83rem);
    --fs-tiny:    clamp(0.68rem, 0.6692rem + 0.0449vw, 0.71rem);

    --r-sm: 8px;
    --r-md: 12px;
    --r-lg: 16px;
    --r-pill: 999px;
    --shadow-card: 0 1px 0 rgba(255,255,255,0.03), 0 2px 8px rgba(0,0,0,0.25);
    --shadow-elev: 0 8px 32px rgba(0,0,0,0.45);

    --container-max: 1600px;
    --container-pad: clamp(0.75rem, 3vw, 2rem);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

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

  .wrap {
    width: 100%;
    max-width: var(--container-max);
    margin-inline: auto;
    padding-inline: var(--container-pad);
  }

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

  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs);
    margin-block: var(--space-s);
  }

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
  .sticky-bar.stuck {
    background: rgba(10, 14, 20, 0.94);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  }

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

  .search-wrap { display: flex; align-items: center; gap: var(--space-xs); flex: 0 0 auto; }
  .search {
    padding: 8px 14px; background: var(--bg-2); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--r-sm);
    font-size: var(--fs-small); width: clamp(140px, 22vw, 240px);
    transition: all 0.18s ease;
  }
  .search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,0.18); }
  .result-count { font-size: var(--fs-tiny); color: var(--text-muted); }

  .cards { display: flex; flex-direction: column; gap: var(--space-s); margin-block: var(--space-m); }

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
  .card.menu-open { z-index: 50; }
  .card.gold::before   { background: linear-gradient(180deg, var(--gold), transparent); }
  .card.silver::before { background: linear-gradient(180deg, var(--silver), transparent); }
  .card.bronze::before { background: linear-gradient(180deg, var(--bronze), transparent); }
  .card.gold   { border-color: rgba(255,215,0,0.4); box-shadow: 0 0 24px rgba(255,215,0,0.10), var(--shadow-card); }
  .card.silver { border-color: rgba(201,209,212,0.3); }
  .card.bronze { border-color: rgba(227,179,65,0.35); }

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
  .badge.provider { border-style: dashed; }
  .badge.local { color: #3fb950; border-color: rgba(63,185,80,0.35); background: rgba(63,185,80,0.10); }
  .pos-arrow { font-size: var(--fs-tiny); font-weight: 700; margin-left: 6px; vertical-align: middle; }
  .pos-arrow.pos-up { color: #3fb950; }
  .pos-arrow.pos-down { color: #f85149; }
  .pos-arrow.pos-stable { color: #8b949e; }
  .badge.contrib { color: #d2a8ff; border-color: rgba(188,140,255,0.30); background: rgba(188,140,255,0.08); }
  .badge.pseudo { color: var(--green); border-color: rgba(63,185,80,0.30); background: rgba(63,185,80,0.08); }

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

  .empty-msg {
    text-align: center; color: var(--text-muted); padding: var(--space-xl);
    font-style: italic; display: none; font-size: var(--fs-body);
  }

  @media (max-width: 720px) {
    .card-row { flex-wrap: wrap; }
    .mini-stats { width: 100%; justify-content: space-between; padding-top: var(--space-s); border-top: 1px solid var(--border-soft); }
  }

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

  .model-url-section { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); margin-bottom: var(--space-s); }
  .model-url-display { display: inline-flex; align-items: center; gap: 6px; }
  .model-url-link {
    color: var(--accent); text-decoration: none; font-size: var(--fs-small);
    word-break: break-all; border-bottom: 1px dashed transparent; transition: border-color 0.15s;
  }
  .model-url-link:hover { border-bottom-color: var(--accent); }

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

  @media print {
    .sticky-bar, .search-wrap, .toolbar, .modal-overlay, .footer { display: none !important; }
    .card { opacity: 1 !important; transform: none !important; break-inside: avoid; }
    body { background: white !important; color: black !important; }
    .cards { padding: 0 !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <span class="badge-top">🌐 BenchGo V3 · Classement Communautaire</span>
    <h1>Classement Communautaire BenchGo V3</h1>
    <p class="subtitle">Généré le ${esc(generatedAt)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} · ${totalSubmissions} soumission${totalSubmissions > 1 ? 's' : ''} de la communauté</p>
  </header>

  <div class="sticky-bar" id="stickyBar">
    <div class="toolbar" style="justify-content: space-between;">
      <div class="toolbar" style="margin-block: 0;">
        <label class="filter-label" for="catSelect">Catégorie</label>
        <div class="select-wrap">
          <select class="select" id="catSelect">
            <option value="all" selected>Tous (${entries.length})</option>
            <option value="top">🏆 Top du top (${catCounts.top})</option>
            <option value="recommande">✅ Recommandés (${catCounts.recommande})</option>
            <option value="moyenne">📊 Dans la moyenne (${catCounts.moyenne})</option>
            <option value="rattrapage">⚠️ En rattrapage (${catCounts.rattrapage})</option>
            <option value="catastrophe">💥 Échec total (${catCounts.catastrophe})</option>
          </select>
        </div>

        <label class="filter-label" for="sizeSelect" style="margin-left: var(--space-xs);">Taille</label>
        <div class="select-wrap">
          <select class="select" id="sizeSelect">
            <option value="all" selected>Toutes tailles (${entries.length})</option>
            <option value="petit">🐱 &lt; 3B (${sizeCounts.petit})</option>
            <option value="standard">📦 3B–14B (${sizeCounts.standard})</option>
            <option value="expert">🎓 14B–30B (${sizeCounts.expert})</option>
            <option value="doctorat">🧠 &gt; 30B (${sizeCounts.doctorat})</option>
            <option value="inconnu">❓ Inconnue (${sizeCounts.inconnu})</option>
          </select>
        </div>

        <label class="filter-label" for="healthSelect" style="margin-left: var(--space-xs);">Santé</label>
        <div class="select-wrap">
          <select class="select" id="healthSelect">
            <option value="all" selected>Toutes (${entries.length})</option>
            <option value="positif">💚 Saine (≥ 0 PV) (${healthCounts.positif})</option>
            <option value="negatif">❤️‍🩹 En difficulté (&lt; 0 PV) (${healthCounts.negatif})</option>
          </select>
        </div>

        <label class="filter-label" for="ecoleSelect" style="margin-left: var(--space-xs);">École</label>
        <div class="select-wrap">
          <select class="select" id="ecoleSelect">
            <option value="all" selected>Toutes écoles</option>
            ${ecoleOptions}
          </select>
        </div>

        <label class="filter-label" for="originSelect" style="margin-left: var(--space-xs);">Origine</label>
        <div class="select-wrap">
          <select class="select" id="originSelect">
            <option value="all" selected>Toutes origines (${entries.length})</option>
            <option value="local">🏠 Local · LM Studio (${originCounts.local})</option>
            <option value="cloud">☁️ Cloud · API (${originCounts.cloud})</option>
          </select>
        </div>
      </div>

      <div class="search-wrap">
        <input type="text" class="search" id="search" placeholder="🔍 Rechercher un modèle…" />
        <span class="result-count" id="resultCount"></span>
        <button class="btn btn-primary" id="btnCopyAll" title="Copier tout le classement (texte brut) pour le partager">⧉ Copier le classement</button>
        <button class="btn btn-primary" id="btnExportPdf" title="Imprimer / Exporter en PDF (dialogue navigateur)">📄 Exporter PDF</button>
        <button class="btn btn-primary" id="btnExportCsv" title="Exporter le classement en CSV (tableur)">📊 Exporter CSV</button>
        <button class="btn btn-primary" id="btnExportMd" title="Exporter le classement en tableau Markdown">📝 Exporter Markdown</button>
      </div>
    </div>
  </div>

  <div class="cards" id="cards"></div>
  <p class="empty-msg" id="emptyMsg">Aucun modèle ne correspond à ce filtre.</p>

  <footer class="footer">
    <p>Classement communautaire généré par <a href="https://github.com/cisco-03/BenchGo-LLM-School">BenchGo V3</a> — participatif et open source</p>
    <p>Pour soumettre vos résultats : <code>node runner.js --submit</code> ou le bouton "🌐 Envoyer à la communauté" dans le classement local</p>
  </footer>
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

<div id="toast" class="toast"></div>

<script>
var MODELS = ${modelsJson};

// --- Suivi de position (flèches ▲▼=) via localStorage ---
// Le classement communautaire est un site statique (GitHub Pages) : impossible
// de stocker un snapshot côté serveur. On utilise donc localStorage : au 1er
// chargement, on enregistre le rang de chaque modèle. Au chargement suivant,
// on compare les rangs pour afficher si le modèle a monté, descendu ou est
// resté stable. La première visite n affiche aucune flèche (baseline).
var COMMUNITY_SNAPSHOT_KEY = 'benchgo_community_positions';
function _loadCommunitySnapshot() {
  try { return JSON.parse(localStorage.getItem(COMMUNITY_SNAPSHOT_KEY) || '{}'); }
  catch (e) { return {}; }
}
function _saveCommunitySnapshot(snap) {
  try { localStorage.setItem(COMMUNITY_SNAPSHOT_KEY, JSON.stringify(snap)); }
  catch (e) {}
}
function _computeCommunityPositionDeltas() {
  var prev = _loadCommunitySnapshot();
  var hasPrev = Object.keys(prev).length > 0;
  var next = {};
  for (var i = 0; i < MODELS.length; i++) {
    var sn = MODELS[i].shortName;
    next[sn] = i + 1;
    if (hasPrev && prev[sn] != null) {
      MODELS[i].positionDelta = (i + 1) - prev[sn];
    } else {
      MODELS[i].positionDelta = null;
    }
  }
  _saveCommunitySnapshot(next);
}
function positionArrow(delta) {
  if (delta == null) return '';
  if (delta < 0) return '<span class="pos-arrow pos-up" title="A monté de ' + Math.abs(delta) + ' place(s) depuis la dernière visite">▲' + Math.abs(delta) + '</span>';
  if (delta > 0) return '<span class="pos-arrow pos-down" title="A descendu de ' + delta + ' place(s) depuis la dernière visite">▼' + delta + '</span>';
  return '<span class="pos-arrow pos-stable" title="Position stable">=</span>';
}
_computeCommunityPositionDeltas();

function gradeColor(g) {
  var m = { A:'#3fb950', B:'#58a6ff', C:'#d29922', D:'#bc8cff', F:'#f85149' };
  return m[g] || '#8b949e';
}
function pctColor(p) {
  var pct = Math.max(0, Math.min(100, p));
  var hue = pct * 1.2;
  return 'hsl(' + hue.toFixed(0) + ', 72%, 48%)';
}
function dispPct(p) { return Math.max(0, Math.min(100, p)); }
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

// getCategory (replique de la version Node ligne 299) : calcule la categorie
// d un modele en fonction de son rang (position) dans l ensemble affiche.
// Le rang est celui de l ensemble filtre (pas le rang global), pour que
// Top du top = les 3 premiers du filtre actif (ex: 3 premiers cloud).
function _getCategory(pct, rank) {
  if (rank && rank <= 3) return { key: 'top', icon: '\u{1F3C6}', label: 'Top du top' };
  if (pct >= 90) return { key: 'recommande', icon: '\u2705', label: 'Recommande' };
  if (pct >= 75) return { key: 'moyenne', icon: '\u{1F4CA}', label: 'Dans la moyenne' };
  if (pct >= 50) return { key: 'rattrapage', icon: '\u26A0\uFE0F', label: 'En rattrapage' };
  return { key: 'catastrophe', icon: '\u{1F4A5}', label: 'Echec total' };
}

function renderCards() {
  var catSel = document.getElementById('catSelect');
  var sizeSel = document.getElementById('sizeSelect');
  var healthSel = document.getElementById('healthSelect');
  var ecoleSel = document.getElementById('ecoleSelect');
  var originSel = document.getElementById('originSelect');
  if (!catSel || !sizeSel) return;
  var activeCat = catSel.value;
  var activeSize = sizeSel.value;
  var activeHealth = healthSel ? healthSel.value : 'all';
  var activeEcole = ecoleSel ? ecoleSel.value : 'all';
  var activeOrigin = originSel ? originSel.value : 'all';
  var searchEl = document.getElementById('search');
  var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  var container = document.getElementById('cards');
  if (!container) return;
  container.innerHTML = '';
  var shown = 0;

  // Premier passage : on filtre par TOUS les filtres SAUF la categorie.
  // On calcule le rang filtred (position dans l ensemble affiche) pour chaque
  // modele restant, puis on en deduit sa categorie dynamique. Cela permet
  // a Top du top de designer les 3 premiers du filtre actif (ex: 3 premiers
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
    if (q && pm.model.toLowerCase().indexOf(q) === -1 && pm.shortName.toLowerCase().indexOf(q) === -1) continue;
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

  for (var fi = 0; fi < _preFiltered.length; fi++) {
    var m = _preFiltered[fi];
    var dynCat = _modelCat[m.shortName] || m.cat;
    if (activeCat !== 'all' && dynCat.key !== activeCat) continue;
    var i = MODELS.indexOf(m);
    shown++;

    var cardClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    var rankDisp = i < 3
      ? '<span class="medal">' + (i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉') + '</span>'
      : shown;
    var pc = pctColor(m.pct);
    var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
    var gc = gradeColor(m.grade);
    var helpStr = (m.helpCount > 0 || m.retriedCount > 0)
      ? (m.helpCount > 0 ? 'aide:' + m.helpCount : '') + (m.retriedCount > 0 ? (m.helpCount > 0 ? ' ' : '') + 'rat.:' + m.retriedCount : '')
      : '—';
    var tpsC = tpsColor(m.tokensPerSecond);
    var vitesseVal = m.tokensPerSecond > 0 ? m.tokensPerSecond + ' t/s' : (m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—');
    var vitesseLbl = m.tokensPerSecond > 0 ? 'Vitesse' : 'Temps';
    var szBadge = '<span class="badge" title="' + esc(m.paramSize ? m.paramSize.label : '') + '">' + (m.paramSize ? m.paramSize.icon : '?') + ' ' + esc(m.paramSize ? m.paramSize.short : '?') + '</span>';
    var quantBadge = m.quantization ? '<span class="badge quant" title="Quantification">🧩 ' + esc(m.quantization) + '</span>' : '';
    var noteBadge = m.note ? '<span class="badge note" title="Note personnelle disponible">📝 Note</span>' : '';
    var contribBadge = m.contributors > 1 ? '<span class="badge contrib">👥 ' + m.contributors + ' testeurs</span>' : '';
    var pseudoBadge = m.pseudo ? '<span class="badge pseudo">✍️ ' + esc(m.pseudo) + '</span>' : '';
    // Badge d origine : départage local (LM Studio) vs cloud (frontière API).
    // Cohérent avec le sélecteur d origine (Local / Cloud uniquement) : le badge
    // affiche « Cloud » et non le provider spécifique pour éviter la redondance.
    var originBadge = '';
    if (m.isCloud) {
      originBadge = '<span class="badge provider" title="Modèle cloud (API)" style="color:#d29922;border-color:#d2992255;background:#d2992218">☁️ Cloud</span>';
    } else {
      originBadge = '<span class="badge local" title="Modèle local (LM Studio)">🏠 Local</span>';
    }
    var posArrow = positionArrow(m.positionDelta);

    var html = '<div class="card ' + cardClass + '" onclick="openModal(' + i + ')">' +
      '<div class="card-row">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name">' +
          '<div class="name-line"><span class="cat-icon">' + dynCat.icon + '</span>' + esc(m.model) + posArrow + '</div>' +
          '<div class="badges">' + szBadge + ' ' + originBadge + ' ' + quantBadge + ' ' + noteBadge + ' ' + contribBadge + ' ' + pseudoBadge + '</div>' +
        '</div>' +
        '<div class="mini-stats">' +
          '<div class="mini-stat"><span class="lbl">%</span><span class="val" style="color:' + pc + '">' + dispPct(m.pct) + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + Math.max(2,dispPct(m.pct)) + '%;background:' + pc + '"></div></div></div>' +
          '<div class="mini-stat"><span class="lbl">Note</span><span class="val grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Santé</span><span class="val" style="color:' + sc + '">' + m.globalLifeScore + ' PV</span></div>' +
          '<div class="mini-stat"><span class="lbl">Oblig.</span><span class="val">' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Aide/Rat.</span><span class="val" style="font-size:var(--fs-tiny)">' + esc(helpStr) + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">' + vitesseLbl + '</span><span class="val" style="color:' + tpsC + ';font-size:var(--fs-tiny)">' + esc(vitesseVal) + '</span></div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="kebab" onclick="event.stopPropagation();toggleKebab(this,' + i + ')" aria-label="Actions">⋮</button>' +
          '<div class="kebab-menu" id="kebabMenu' + i + '" data-idx="' + i + '" onclick="event.stopPropagation()">' +
            '<div class="kebab-item" onclick="openModal(' + i + ')">🔍 Détails</div>' +
            '<div class="kebab-item" onclick="copyModelName(' + i + ')">⧉ Copier le nom</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
    container.insertAdjacentHTML('beforeend', html);
  }
  document.getElementById('resultCount').textContent = shown + '/' + MODELS.length;
  document.getElementById('emptyMsg').style.display = shown === 0 ? 'block' : 'none';
  attachScrollAnimations();
}

function attachScrollAnimations() {
  var cards = document.querySelectorAll('#cards .card');
  if (!cards.length) return;
  if (!('IntersectionObserver' in window)) {
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
  if (!m) return;
  document.getElementById('mRank').innerHTML = (idx < 3 ? '<span class="medal">' + (idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉') + '</span>' : (idx + 1));
  document.getElementById('mTitle').innerHTML = esc(m.model) + positionArrow(m.positionDelta);
  var vb = document.getElementById('mVerdict');
  vb.textContent = m.verdict.label;
  vb.style.background = m.verdict.color;
  document.getElementById('mCat').innerHTML = (m.cat ? m.cat.icon + ' ' + esc(m.cat.label) : '') + ' · ' + (m.paramSize ? m.paramSize.icon + ' ' + esc(m.paramSize.label) : '');

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
  body += statBox('Quantif.', m.quantization ? '<span style="color:#bc8cff">' + esc(m.quantization) + '</span>' : '—');
  if (m.elapsedMs > 0 || m.tokens > 0) {
    body += statBox('Temps inf.', fmtDurJS(m.elapsedMs));
    body += statBox('Tokens', m.tokens > 0 ? m.tokens : '—');
    body += statBox('Vitesse', m.tokensPerSecond > 0 ? '<span style="color:' + tpsColor(m.tokensPerSecond) + '">' + m.tokensPerSecond + ' t/s</span>' : '—');
    body += statBox('Temps réel', fmtDurJS(m.wallMs));
  }
  body += '</div>';

  if (m.modelUrl) {
    body += '<h3>🔗 Lien du modèle</h3>';
    body += '<div class="model-url-section"><a href="' + esc(m.modelUrl) + '" target="_blank" rel="noopener noreferrer" class="model-url-link">🌐 ' + esc(m.modelUrl) + '</a></div>';
  }

  if (m.note) {
    body += '<h3>📝 Note personnelle</h3>';
    body += '<div class="model-note-display" style="max-height:200px;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none;font-size:var(--fs-small);color:var(--text);white-space:pre-wrap;word-break:break-word;line-height:1.5;">' + esc(m.note) + '</div>';
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
    '<th class="num">Temps</th><th class="num">Vitesse</th><th>Date</th><th>Tent.</th>' +
    '</tr></thead><tbody>';
  for (var e of m.ecoles) {
    var egc = gradeColor(e.grade);
    var epc = pctColor(e.pct);
    var attempts = e.attempts || [];
    var hasHistory = attempts.length > 1;
    var ecoleCell = esc(e.ecole);
    var eTpsC = tpsColor(e.tokensPerSecond);
    var eTemps = e.elapsedMs > 0 ? fmtDurJS(e.elapsedMs) : '—';
    var eVitesse = e.tokensPerSecond > 0 ? '<span style="color:' + eTpsC + '">' + e.tokensPerSecond + ' t/s</span>' : '—';
    if (hasHistory) {
      ecoleCell += ' <span class="hist-toggle" onclick="toggleHistory(this)" title="Voir l\\'historique des re-tests">▸ ' + attempts.length + ' tentatives</span>';
    }
    body += '<tr' + (hasHistory ? ' class="ecole-main"' : '') + '>' +
      '<td>' + ecoleCell + '</td>' +
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
      '</tr>';
    if (hasHistory) {
      body += '<tr class="hist-row" style="display:none;"><td colspan="13">' +
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
        var aVitesse = a.tokensPerSecond > 0 ? '<span style="color:' + aTpsC + '">' + a.tokensPerSecond + ' t/s</span>' : '—';
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
      var mandBadge = t.isMandatory ? '<span class="th-badge mand">Obligatoire</span>' : '<span class="th-badge opt">Optionnel</span>';
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
    body += '<div class="report-empty">Aucun rapport intégral disponible pour ce modèle.</div>';
  }
  body += '</div>';

  body += '<div class="meta-line">';
  body += 'Dernière mise à jour : ' + esc(m.submittedAt || '—') + ' · ';
  body += 'Nom court : <code>' + esc(m.shortName) + '</code>';
  if (m.pseudo) body += ' · Soumis par ' + esc(m.pseudo);
  if (m.contributors > 1) body += ' · Testé par ' + m.contributors + ' personnes';
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
function toggleHistory(el) {
  var mainRow = el.closest('tr.ecole-main');
  if (!mainRow) return;
  var histRow = mainRow.nextElementSibling;
  if (!histRow || !histRow.classList.contains('hist-row')) return;
  var shown = histRow.style.display !== 'none';
  histRow.style.display = shown ? 'none' : 'table-row';
  var match = el.textContent.match(/(\d+)/);
  var n = match ? match[1] : '';
  el.setAttribute('data-n', n);
  el.textContent = (shown ? '▸' : '▾') + ' ' + n + ' tentatives';
}
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
if (_originSel) _originSel.addEventListener('change', renderCards);

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

function copyModelName(idx) {
  var name = MODELS[idx].model;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(name).then(function() { showToast('Nom copié : ' + name, true); }, function() { fallbackCopy(name); });
  } else { fallbackCopy(name); }
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('Nom copié : ' + text, true); }
  catch (e) { showToast('Copie impossible', false); }
  document.body.removeChild(ta);
}

function exportReport(idx) {
  var m = MODELS[idx];
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
           if (r2.code && String(r2.code).trim()) {
              md += String.fromCharCode(96,96,96) + 'javascript\\n' + String(r2.code).trim() + '\\n' + String.fromCharCode(96,96,96) + '\\n\\n';
           }
           if (r2.failureExplanation) md += '**Explication échec :** ' + r2.failureExplanation + '\\n\\n';
           if (r2.teacherCorrection) md += '**🎓 Correction professeur :** ' + r2.teacherCorrection + '\\n\\n';
         }
       }
       if (t.rawResponse && String(t.rawResponse).trim()) {
          md += '##### Réponse brute\\n\\n' + String.fromCharCode(96,96,96) + 'text\\n' + String(t.rawResponse).trim() + '\\n' + String.fromCharCode(96,96,96) + '\\n\\n';
       }
    }
    md += '---\\n\\n';
  }
  var safe = String(m.shortName || 'modele').replace(/[^a-zA-Z0-9._-]/g, '_');
  var d = new Date();
  var p = function(n){ return String(n).padStart(2,'0'); };
  var fn = 'rapport_integral_' + safe + '_' + d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '.md';
  var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = fn;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
  showToast('Rapport téléchargé : ' + fn, true);
}

function downloadTextFile(content, filename, mimeType) {
  var blob = new Blob(['\\ufeff' + content], { type: mimeType || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
}
function csvCell(s) {
  s = String(s == null ? '' : s);
  if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\\n') >= 0) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function mdCell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\\\|'); }

function exportCsv() {
  var rows = [['Rang','Modèle','Quantification','Score','Max','%','Note','Obligatoire %','Obligatoire (passé/total)','Santé (PV)','Bonus','Écoles','Vitesse (t/s)','Temps inf.','Temps réel','Lien']];
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
      m.wallMs > 0 ? fmtDurJS(m.wallMs) : '',
      csvCell(m.modelUrl || '')
    ]);
  }
  downloadTextFile(rows.map(function(r){ return r.join(','); }).join('\\n'), 'classement_communautaire_' + new Date().toISOString().slice(0,10) + '.csv', 'text/csv;charset=utf-8');
  showToast('CSV exporté (' + MODELS.length + ' modèles)', true);
}
function exportMd() {
  var lines = [];
  lines.push('# Classement Communautaire BenchGo V3 — ' + new Date().toLocaleDateString('fr-FR'));
  lines.push('');
  lines.push('| Rang | Modèle | Quantif. | Score | % | Note | Oblig. | Santé | Bonus | Écoles | Vitesse | Temps | Lien |');
  lines.push('|------|--------|----------|-------|---|------|--------|-------|-------|--------|---------|-------|------|');
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    var vit = m.tokensPerSecond > 0 ? (m.tokensPerSecond + ' t/s') : (m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—');
    var temps = m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—';
    var oblig = m.mandatoryTotal > 0 ? (m.mandatoryPct + '%') : '—';
    var lien = m.modelUrl ? '[Voir](' + m.modelUrl + ')' : '—';
    lines.push('| ' + medal + ' | ' + mdCell(m.model) + ' | ' + mdCell(m.quantization || '—') + ' | ' + m.score + '/' + m.max + ' | ' + dispPct(m.pct) + '% | ' + m.grade + ' | ' + oblig + ' | ' + m.globalLifeScore + ' PV | ' + (m.optionalBonus > 0 ? '+' + m.optionalBonus : '—') + ' | ' + m.ecoleCount + ' | ' + vit + ' | ' + temps + ' | ' + lien + ' |');
  }
  downloadTextFile(lines.join('\\n'), 'classement_communautaire_' + new Date().toISOString().slice(0,10) + '.md', 'text/markdown;charset=utf-8');
  showToast('Markdown exporté (' + MODELS.length + ' modèles)', true);
}
function exportPdf() {
  showToast("Dialogue d'impression ouvert — choisissez « Enregistrer en PDF »", true);
  window.print();
}
function copyLeaderboard() {
  var btn = document.getElementById('btnCopyAll');
  var activeCat = document.getElementById('catSelect').value;
  var activeSize = document.getElementById('sizeSelect').value;
  var activeHealth = document.getElementById('healthSelect') ? document.getElementById('healthSelect').value : 'all';
  var activeEcole = document.getElementById('ecoleSelect') ? document.getElementById('ecoleSelect').value : 'all';
  var activeOrigin = document.getElementById('originSelect') ? document.getElementById('originSelect').value : 'all';
  var q = document.getElementById('search').value.trim().toLowerCase();

  var lines = [];
  lines.push('🌐 Classement Communautaire BenchGo V3 — ' + new Date().toLocaleString('fr-FR'));
  lines.push('Filtre catégorie : ' + (activeCat === 'all' ? 'tous' : activeCat) + ' | Taille : ' + (activeSize === 'all' ? 'toutes' : activeSize) + ' | Santé : ' + (activeHealth === 'all' ? 'toutes' : activeHealth) + ' | École : ' + (activeEcole === 'all' ? 'toutes' : activeEcole) + ' | Origine : ' + (activeOrigin === 'all' ? 'toutes' : activeOrigin) + (q ? ' | Recherche : ' + q : ''));
  lines.push('');
  lines.push('Rang | Modèle | Quantif. | Points | % | Note | Oblig. | Santé | Écoles | Temps | Vitesse | Verdict');
  lines.push('---|---|---|---|---|---|---|---|---|---|---|---');
  var copied = 0;
  // Premier passage : filtre sans la categorie pour calculer les rangs filtres.
  var _preF = [];
  for (var pi = 0; pi < MODELS.length; pi++) {
    var pm = MODELS[pi];
    var pSK = (pm.paramSize && pm.paramSize.key) ? pm.paramSize.key : '';
    if (activeSize !== 'all' && pSK !== activeSize) continue;
    if (activeHealth !== 'all') {
      var pIP = (pm.globalLifeScore || 0) >= 0;
      if (activeHealth === 'positif' && !pIP) continue;
      if (activeHealth === 'negatif' && pIP) continue;
    }
    if (activeEcole !== 'all') {
      if ((pm.ecoleNames || []).indexOf(activeEcole) === -1) continue;
    }
    if (activeOrigin !== 'all') {
      if (activeOrigin === 'cloud' && !pm.isCloud) continue;
      if (activeOrigin === 'local' && pm.isCloud) continue;
    }
    if (q && pm.model.toLowerCase().indexOf(q) === -1 && pm.shortName.toLowerCase().indexOf(q) === -1) continue;
    _preF.push(pm);
  }
  var _mc = {};
  for (var fi = 0; fi < _preF.length; fi++) {
    _mc[_preF[fi].shortName] = _getCategory(_preF[fi].pct, fi + 1);
  }

  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    var dynCat = _mc[m.shortName] || m.cat;
    if (activeCat !== 'all' && dynCat.key !== activeCat) continue;
    var sizeKey = (m.paramSize && m.paramSize.key) ? m.paramSize.key : '';
    if (activeSize !== 'all' && sizeKey !== activeSize) continue;
    if (activeHealth !== 'all') {
      var isPositif = (m.globalLifeScore || 0) >= 0;
      if (activeHealth === 'positif' && !isPositif) continue;
      if (activeHealth === 'negatif' && isPositif) continue;
    }
    if (activeEcole !== 'all') {
      var hasEcole = (m.ecoleNames || []).indexOf(activeEcole) !== -1;
      if (!hasEcole) continue;
    }
    if (activeOrigin !== 'all') {
      if (activeOrigin === 'cloud' && !m.isCloud) continue;
      if (activeOrigin === 'local' && m.isCloud) continue;
    }
    if (q && m.model.toLowerCase().indexOf(q) === -1 && m.shortName.toLowerCase().indexOf(q) === -1) continue;
    var rank = copied < 3 ? ['🥇','🥈','🥉'][copied] : ('' + (copied + 1));
    var temps = m.elapsedMs > 0 ? fmtDurJS(m.elapsedMs) : '—';
    var vit = m.tokensPerSecond > 0 ? (m.tokensPerSecond + ' t/s') : '—';
    var oblig = m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—';
    lines.push(rank + ' | ' + m.model + ' | ' + (m.quantization || '—') + ' | ' + m.score + '/' + m.max + ' | ' + m.pct + '% | ' + m.grade + ' | ' + oblig + ' | ' + m.globalLifeScore + ' PV | ' + m.ecoleCount + ' | ' + temps + ' | ' + vit + ' | ' + m.verdict.label);
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
document.getElementById('btnExportPdf').addEventListener('click', exportPdf);
document.getElementById('btnExportCsv').addEventListener('click', exportCsv);
document.getElementById('btnExportMd').addEventListener('click', exportMd);

(function() {
  var bar = document.getElementById('stickyBar');
  function onScroll() { if (window.scrollY > 4) bar.classList.add('stuck'); else bar.classList.remove('stuck'); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

renderCards();
</script>
</body>
</html>`;
}

function main() {
  const submissions = loadAllSubmissions();
  if (submissions.length === 0) {
    console.log('Aucune soumission trouvée dans submissions/.');
    // On génère quand même un HTML vide pour que gh-pages existe
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_HTML, buildConsolidatedHTML([]), 'utf8');
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ entries: [], generatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return;
  }

  console.log(`${submissions.length} soumission(s) trouvée(s).`);

  // Agrège chaque soumission
  const entries = [];
  for (const sub of submissions) {
    const agg = aggregateCarnet(sub.carnet);
    if (agg) {
      agg.pseudo = sub.pseudo;
      agg.submittedAt = sub.submittedAt;
      entries.push(agg);
    }
  }

  // Dédoublonne et fusionne
  const merged = deduplicateAndMerge(entries);
  console.log(`${merged.length} modèle(s) unique(s) après fusion.`);

  // Génère les fichiers
  const html = buildConsolidatedHTML(merged);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify({
    entries: merged,
    generatedAt: new Date().toISOString(),
    totalSubmissions: submissions.length
  }, null, 2), 'utf8');

  console.log(`Classement consolidé généré : ${path.basename(OUTPUT_HTML)}`);
}

main();