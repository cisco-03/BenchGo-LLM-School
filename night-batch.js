#!/usr/bin/env node
// night-batch.js - Mode nuit BenchGo
//
// Enchaine automatiquement le test de plusieurs modeles LM Studio pendant la
// nuit, sans intervention humaine. L'utilisateur selectionne les modeles et
// les ecoles a tester le soir, lance le script, et retrouve les rapports + le
// classement le matin dans Export-Rapports/.
//
// Principe :
//   1. Verifie que le daemon LM Studio tourne (sinon alerte et quitte).
//   2. Verifie que le serveur HTTP repond sur localhost:1234 ; sinon le demarre
//      en arriere-plan (headless) et l'arrete a la fin seulement s'il l'a demarre.
//   3. Liste les modeles LLM telecharges via lms ls --json --llm.
//   4. Selection interactive des modeles (numeros separes par virgules, ou "all").
//   5. Selection interactive des ecoles (Primaire, College-Lycee, ... ou auto).
//   6. Pour chaque modele, pour chaque ecole :
//        a. lms unload --all  (libere la RAM du modele precedent)
//        b. lms load <modelKey> (charge le modele cible en memoire)
//        c. node runner.js --force --profile=<ecole> (execute le benchmark en
//           mode non-TTY ; --force neutralise les confirmations de re-test et
//           maintient les penalites d'echec sans intervention)
//   7. A la fin : lms unload --all, arret du serveur si demarre par le script,
//      resume horodate.
//
// Le runner genere lui-meme le classement (classement.html / classement.md) a
// chaque run "all", donc le classement final reflete tous les modeles testes.
//
// Usage :
//   node night-batch.js              # selection interactive (modeles + ecoles)
//   node night-batch.js --models=a,b # modeles sans selection (modelKeys)
//   node night-batch.js --schools=STANDARD,EXPERT  # ecoles sans selection
//   node night-batch.js --no-teacher # desactive explicitement le professeur IA

const { spawnSync, spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { PROFILES, detectProfileFromModelName } = require('./config');

const PROJECT_ROOT = __dirname;
const RUNNER = path.join(PROJECT_ROOT, 'runner.js');
const LMSTUDIO_HOST = 'http://localhost:1234';
const HTTP_TIMEOUT_MS = 4000;
const LEDGER_DIR = path.join(PROJECT_ROOT, 'Export-Rapports', '.carnet');

// Mappe un nom d'ecole humain (ex: "Primaire", "College-Lycee") vers la cle
// SCHOOLS correspondante (ex: "LIGHT", "STANDARD"). Sert a afficher quelles
// ecoles ont deja ete passees par un modele depuis son carnet de scores.
const ECOLE_NAME_TO_KEY = {};
for (const k of Object.keys(PROFILES)) {
  ECOLE_NAME_TO_KEY[PROFILES[k].ecole] = k;
}

// Ecoles locales testables en mode nuit (LM Studio). FRONTIER (cloud) exclu :
// ces modeles ne tournent pas en local, ils necessitent un provider cloud.
// 'auto' = laisser le runner detecter le profil depuis le nom du modele (1 ecole).
const SCHOOLS = [
  { key: 'LIGHT',    label: 'Primaire (< 3B)',            cli: 'LIGHT' },
  { key: 'STANDARD', label: 'College-Lycee (3B - 15B)',   cli: 'STANDARD' },
  { key: 'EXPERT',   label: 'Universite (15B - 30B)',     cli: 'EXPERT' },
  { key: 'DOCTORAT', label: 'These (> 30B)',               cli: 'DOCTORAT' },
  { key: 'auto',     label: 'Auto-detection (1 ecole)',   cli: null },
  // Mode auto-par-modele : chaque modele passe UNIQUEMENT l'ecole adaptee a
  // sa taille de parametres (detectee via detectProfileFromModelName). Permet de
  // melanger des modeles de tailles differentes dans la meme session de nuit
  // (un 3B fait Primaire, un 15B fait College-Lycee, etc.) sans selectionner
  // manuellement l'ecole de chacun. cli=null : l'ecole est calculee par modele.
  { key: 'auto-per-model', label: 'Auto par modele (ecole selon la taille)', cli: null },
  // Mode manuel-par-modele : l'utilisateur choisit individuellement l'ecole de
  // chaque modele, un par un. Permet de melanger des modèles aux besoins
  // differents dans la meme session (ex: re-tester Kai Os Grug 12B en auto,
  // mais faire passer Phi 4 uniquement en Primaire). cli=null : les ecoles sont
  // choisies interactivement pour chaque modele.
  { key: 'manual-per-model', label: 'Manuel par modele (ecole choisie pour chacun)', cli: null }
];

// Détecte si la sélection d'écoles correspond au mode « auto par modèle »
// (option 6, key 'auto-per-model'). Dans ce mode, l'école de chaque modèle
// est calculée individuellement via schoolForModel() au lieu d'utiliser une
// liste globale d'écoles identique pour tous.
function isAutoPerModel(schools) {
  if (!schools) return false;
  return schools.some(s => s && s.key === 'auto-per-model');
}

// Détecte si la sélection d'écoles correspond au mode « manuel par modèle »
// (option 7, key 'manual-per-model'). Dans ce mode, l'utilisateur choisit
// individuellement l'école (ou les écoles) de chaque modèle, un par un, au
// lieu d'appliquer la même liste d'écoles à toute la file. Permet de mélanger
// des modèles nécessitant des écoles différentes dans la même session (ex:
// Kai Os Grug 12B en auto, Phi 4 en Primaire uniquement).
function isManualPerModel(schools) {
  if (!schools) return false;
  return schools.some(s => s && s.key === 'manual-per-model');
}

// --- Couleurs ANSI (constantes pour lisibilite CLI) ---
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowClock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (!n || n <= 0) return '?';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

// Execute une commande lms et renvoie { status, stdout, stderr }.
function runLms(args, { timeoutMs = 60000 } = {}) {
  const r = spawnSync('lms', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    cwd: PROJECT_ROOT
  });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

// Verifie si le serveur HTTP LM Studio repond sur /v1/models.
async function isServerUp() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${LMSTUDIO_HOST}/v1/models`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.data);
  } catch (_) {
    clearTimeout(t);
    return false;
  }
}

// Verifie si le daemon LM Studio tourne (prerequis pour lms load/unload).
function isDaemonUp() {
  const r = runLms(['daemon', 'status'], { timeoutMs: 8000 });
  return r.status === 0 && /is running/i.test(r.stdout || r.stderr || '');
}

// Demarre le serveur HTTP LM Studio en arriere-plan (headless).
async function startServer() {
  console.log(`  ${C.gray}Demarrage du serveur LM Studio en mode headless...${C.reset}`);
  const child = spawn('lms', ['server', 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PROJECT_ROOT
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isServerUp()) {
      console.log(`  ${C.green}Serveur LM Studio demarre (headless).${C.reset}`);
      return { startedByUs: true };
    }
  }
  console.log(`  ${C.red}Le serveur ne repond pas apres 30s.${C.reset}`);
  return { startedByUs: false };
}

function stopServer() {
  console.log(`  ${C.gray}Arret du serveur LM Studio (demarre par ce script)...${C.reset}`);
  runLms(['server', 'stop'], { timeoutMs: 15000 });
}

// Charge tous les carnets de scores depuis Export-Rapports/.carnet/*.json.
// Renvoie un tableau d'objets { model, shortName, quantization, ecoles, raw }.
function loadAllLedgers() {
  const out = [];
  if (!fs.existsSync(LEDGER_DIR)) return out;
  let files;
  try { files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.json')); }
  catch (_) { return out; }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'));
      if (!data || !data.ecoles) continue;
      out.push({
        model: data.model || null,
        shortName: data.shortName || null,
        quantization: data.quantization || null,
        ecoles: data.ecoles,
        raw: data
      });
    } catch (_) {}
  }
  return out;
}

// Normalise une cle de modele pour le matching : minuscules, sans quantification
// (@q4_k_m...), sans extension .gguf, segments separes par / ou _ ramenes a -.
function normalizeForMatch(s) {
  if (!s) return '';
  let v = String(s).toLowerCase().trim();
  v = v.replace(/\.gguf$/i, '').replace(/-gguf$/i, '');
  v = v.split('@')[0];
  v = v.replace(/[/_]/g, '-');
  v = v.replace(/[^a-z0-9.-]/g, '');
  v = v.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return v;
}

// Extrait la quantification d'un modelKey lms ls (ex: "kai-os_grug-12b@q4_k_s/...")
// -> "q4_k_s". Retourne null si aucune quantification detectable.
function quantFromModelKey(modelKey) {
  if (!modelKey) return null;
  const m = String(modelKey).toLowerCase().match(/@([a-z0-9_]+)/);
  return m ? m[1] : null;
}

// Normalise une quantification pour comparaison (minuscules, sans separateurs
// non alphanumeriques). Ex: "Q4_K_S", "q4-k-s" -> "q4ks".
function normalizeQuant(q) {
  if (!q) return '';
  return String(q).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Tente de faire correspondre un modelKey (lms ls) a un carnet de scores.
// Strategie : on normalise le modelKey et le champ model du carnet ; si egalite
// exacte -> match. Sinon, on extrait le dernier segment significatif du modelKey
// (ex: "mythos-9b-unhinged" depuis "mythos-9b-unhinged@q4_k_m") et on cherche
// une inclusion dans model ou shortName du carnet (dans les deux sens).
//
// IMPORTANT : depuis que le shortName du carnet integre la quantification (ex:
// "kai-os_grug-12b_q4_k_s"), on doit privilegier le carnet dont la quantif
// correspond a celle du modelKey. Sans cela, le 3e critere (inclusion du dernier
// segment) matcherait n'importe quelle quantif du meme modele (faux positif).
function matchLedger(modelKey, ledgers) {
  if (!modelKey) return null;
  const nk = normalizeForMatch(modelKey);
  if (!nk) return null;
  const wantQuant = normalizeQuant(quantFromModelKey(modelKey));
  // Indique si la quantification d'un carnet correspond a celle demandee par le
  // modelKey. On teste deux sources : le suffixe du shortName (format recent,
  // ex: "kai-os_grug-12b_q4_k_s") ET le champ quantification du carnet (ex:
  // "Q4_K_M"). Les anciens carnets sans AUCUNE quantif connue (ni dans le
  // shortName ni dans le champ) ne matchent PAS une requete quantifiee : sinon un
  // carnet orphelin pre-fix absorbe toutes les quantifs d'un meme modele et
  // empeche la creation de carnets distincts (Q4_K_S, Q5_K_L... n'apparaissent
  // jamais dans le leaderboard). Si aucune quantif n'est demandee (modelKey sans
  // @quant), tout carnet matche (comportement historique).
  function quantMatches(l) {
    if (!wantQuant) return true;
    // Source 1 : suffixe du shortName (ex: "..._q4_k_s").
    const sn = String(l.shortName || '').toLowerCase();
    const mSn = sn.match(/_?(q[0-9][a-z0-9_]*)$/);
    // Source 2 : champ quantization du carnet (ex: "Q4_K_M").
    const qField = l.quantization ? normalizeQuant(l.quantization) : '';
    if (!mSn && !qField) return false; // carnet sans aucune quantif connue
    const snQuant = mSn ? normalizeQuant(mSn[1]) : '';
    // Match si l'une des deux sources correspond a la quantif demandee.
    if (snQuant && snQuant === wantQuant) return true;
    if (qField && qField === wantQuant) return true;
    // Si le carnet porte une quantif mais differente, pas de match.
    return false;
  }
  // 1) Egalite normalisee stricte sur model (avec preference quantif).
  // Quand une quantif est demandee (wantQuant), on ne retient AUCUN fallback :
  // un carnet orphelin NO-QUANT ne doit pas absorber une requete quantifiee
  // (Q4_K_S, Q5_K_L...) sinon ces quantifs n'ont jamais de carnet propre et
  // n'apparaissent jamais dans le leaderboard. Le modele sera affiche JAMAIS
  // TESTE, ce qui incite a le tester et cree un carnet dedie.
  let fallback = null;
  const allowFallback = !wantQuant;
  for (const l of ledgers) {
    if (normalizeForMatch(l.model) === nk) {
      if (quantMatches(l)) return l;
      if (allowFallback && !fallback) fallback = l;
    }
  }
  // 2) Egalite normalisee stricte sur shortName.
  for (const l of ledgers) {
    if (normalizeForMatch(l.shortName) === nk) {
      if (quantMatches(l)) return l;
      if (allowFallback && !fallback) fallback = l;
    }
  }
  // 3) Dernier segment du modelKey inclus dans model/shortName (et reciproque).
  const seg = nk.split('-').filter(Boolean).pop() || nk;
  if (seg.length >= 4) {
    for (const l of ledgers) {
      const nm = normalizeForMatch(l.model);
      const ns = normalizeForMatch(l.shortName);
      if ((nm && (nm.includes(seg) || seg.includes(nm))) ||
          (ns && (ns.includes(seg) || seg.includes(ns)))) {
        if (quantMatches(l)) return l;
        if (allowFallback && !fallback) fallback = l;
      }
    }
  }
  return fallback;
}

// Renvoie la liste des cles SCHOOLS effectivement testees par un carnet
// (convertit les noms d'ecoles humains -> cles SCHOOLS).
function ledgerSchoolKeys(ledger) {
  if (!ledger || !ledger.ecoles) return [];
  const keys = [];
  for (const humain of Object.keys(ledger.ecoles)) {
    const k = ECOLE_NAME_TO_KEY[humain];
    if (k) keys.push(k);
  }
  return keys;
}

// Normalise une entree d'ecole d'un carnet vers { best, attempts }.
// Reproduit la logique de score-ledger.js#normalizeEcoleEntry sans dependre
// du module (night-batch reste autonome : pas de couplage inutile entre les
// gestionnaires de carnets).
function normalizeEcoleEntryLocal(raw) {
  if (!raw) return { best: null, attempts: [] };
  if (raw.attempts && Array.isArray(raw.attempts)) {
    let best = raw.best;
    if (!best && raw.attempts.length > 0) best = pickBestLocal(raw.attempts);
    return { best, attempts: raw.attempts.slice() };
  }
  if (raw.score != null || raw.max != null || raw.pct != null) {
    return { best: raw, attempts: [raw] };
  }
  return { best: null, attempts: [] };
}

// Selectionne la meilleure tentative d'une liste (pct le plus eleve ; egalite ->
// derniere). Meme convention que score-ledger.js#pickBest.
function pickBestLocal(attempts) {
  if (!attempts || attempts.length === 0) return null;
  let best = attempts[0];
  for (let i = 1; i < attempts.length; i++) {
    if ((attempts[i].pct || 0) >= (best.pct || 0)) best = attempts[i];
  }
  return best;
}

// Calcule les metriques agregees d'un carnet (meilleure tentative par ecole) :
// pct global, score, sante, vitesse (tok/s), tentatives (max sur une ecole),
// tendance (delta de pct entre les 2 dernieres tentatives globales), temps
// total d'inference. Renvoie null si le carnet est vide / absent.
// Ces metriques alimentent les nouvelles colonnes de --list-only et le tri
// du plus fort au plus faible.
function computeLedgerMetrics(ledger) {
  if (!ledger || !ledger.ecoles) return null;
  const entries = Object.values(ledger.ecoles).map(normalizeEcoleEntryLocal).filter(e => e.best);
  if (entries.length === 0) return null;
  let score = 0, max = 0, globalLifeScore = 0;
  let totalTokens = 0, totalElapsedMs = 0;
  let maxAttempts = 0;
  let trendSumPrev = 0, trendSumLast = 0, trendCount = 0;
  for (const e of entries) {
    score += e.best.score || 0;
    max += e.best.max || 0;
    globalLifeScore += e.best.globalLifeScore || 0;
    totalTokens += e.best.tokens || 0;
    totalElapsedMs += e.best.elapsedMs || 0;
    maxAttempts = Math.max(maxAttempts, e.attempts.length);
    // Tendance : moyenne des deltas de pct entre les 2 dernieres tentatives
    // de chaque ecole ayant au moins 2 tentatives.
    if (e.attempts.length >= 2) {
      const sorted = e.attempts.slice().sort((a, b) => {
        const da = (a.date || '') + (a.time || '');
        const db = (b.date || '') + (b.time || '');
        return da.localeCompare(db);
      });
      const aPrev = sorted[sorted.length - 2];
      const aLast = sorted[sorted.length - 1];
      const pPrev = aPrev.max > 0 ? Math.round((aPrev.score / aPrev.max) * 100) : 0;
      const pLast = aLast.max > 0 ? Math.round((aLast.score / aLast.max) * 100) : 0;
      trendSumPrev += pPrev;
      trendSumLast += pLast;
      trendCount++;
    }
  }
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  const tokensPerSecond = totalElapsedMs > 0
    ? Math.round((totalTokens / (totalElapsedMs / 1000)) * 100) / 100
    : 0;
  // Tendance : 'up' (monte), 'down' (descend), 'stable' ou null (pas assez d'historique).
  let trend = null;
  if (trendCount > 0) {
    const avgPrev = Math.round(trendSumPrev / trendCount);
    const avgLast = Math.round(trendSumLast / trendCount);
    const delta = avgLast - avgPrev;
    trend = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'stable');
  }
  return {
    score, max, pct, globalLifeScore,
    tokensPerSecond, elapsedMs: totalElapsedMs, tokens: totalTokens,
    attempts: maxAttempts, trend
  };
}

// Detecte si un modele est un fichier MTP (Multi-Token Prediction). Les fichiers
// MTP sont des modules complementaires destines a etre charges AVEC un modele
// principal (via --speculative-draft-mtp) pour accelerer l'inference. Ils ne
// doivent JAMAIS etre testes seuls : ils n'ont pas de capacite de generation
// autonome. On les detecte par le nom de fichier (basename du path) qui
// contient "mtp", ou par le displayName qui contient le mot "mtp".
//
// Exemples concrets (2026-07) :
//   - Mia-AiLab/Gemmable-4-12B-MTP-GGUF/gemmable-4-12b-Q4_K_M-mtp.gguf  (MTP)
//   - unsloth/gemma-4-26B-A4B-it-GGUF/mtp-gemma-4-26B-A4B-it-Q8_0.gguf  (MTP)
//   - TapTheDevvv/Qwythos-9B-Claude-Mythos-5-1M-GGUF/...-MTP-Q6_K.gguf  (MTP)
function isMtpModel(m) {
  if (!m) return false;
  // Critere 1 : le nom de fichier (basename du path) contient "mtp".
  const p = m.path || '';
  const basename = p.split('/').pop() || '';
  if (/mtp/i.test(basename)) return true;
  // Critere 2 : le displayName contient le mot "mtp" (mot entier).
  if (m.displayName && /\bmtp\b/i.test(m.displayName)) return true;
  return false;
}

// Détecte les modèles NON-LLM : modèles qui ne génèrent pas de texte de façon
// autonome et ne peuvent donc pas passer les écoles BenchGo (exercices de code,
// raisonnement, etc.). Sont concernés :
//   - OCR : reconnaissance de texte dans des images (ex: OvisOCR2, GOT-OCR2).
//   - Embedding : modèles qui produisent des vecteurs, pas du texte.
//   - Rerank : modèles de réordonnancement de similarité.
//   - Vision-only : modèles purement visuels sans capacité de génération texte
//     (on exclut les VLM type Qwen-VL / LFM-VL qui génèrent du texte — ils
//     restent testables car ils ont une tête de langage).
//
// Stratégie : on regarde le displayName, le modelKey, le publisher, l'arch
// et le basename du path. On évite les faux positifs : "vl" seul n'est pas
// suffisant (un VLM texte reste testable) ; on exige un marqueur explicite
// d'OCR / embedding / rerank / vision-only.
//
// Liste noire manuelle : l'utilisateur peut aussi isoler un modèle depuis le
// CLI interactif (voir selectModelsInteractive). La liste noire persistante
// est stockée dans .benchgo-blacklist.json à la racine du projet.
const NON_LLM_PATTERNS = [
  /\bocr\b/i, /\bocr2\b/i, /got-ocr/i, /ovisocr/i,
  /\bembed/i, /\bembedding\b/i, /e5-/i, /bge-/i, /gte-/i, /nomic-embed/i, /mxbai/i,
  /\brerank/i, /\breranking\b/i, /jina-reranker/i, /cohere-rerank/i,
  /\bvision[-_ ]?only\b/i, /\bimage[-_ ]?cls\b/i, /\bclip\b/i, /\bdino[-_]?v/i,
  /\bsam\b/i, /florence/i, /\bdetector\b/i, /yolo/i, /grounding/i
];

function isNonLlmModel(m) {
  if (!m) return false;
  const candidates = [
    m.displayName || '',
    m.modelKey || '',
    (m.publisher || '') + '/' + (m.displayName || ''),
    m.architecture || m.arch || '',
    (m.path || '').split('/').pop() || ''
  ];
  for (const c of candidates) {
    const s = String(c);
    for (const re of NON_LLM_PATTERNS) {
      if (re.test(s)) return true;
    }
  }
  return false;
}

// Charge la liste noire persistante des modèles isolés manuellement par
// l'utilisateur depuis le CLI interactif. Retourne un Set de modelKeys.
function loadBlacklist() {
  const p = path.join(__dirname, '.benchgo-blacklist.json');
  try {
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr.map(s => String(s)));
    }
  } catch (e) { /* ignore fichier corrompu */ }
  return new Set();
}

// Sauvegarde la liste noire persistante (modelKeys isolés manuellement).
function saveBlacklist(set) {
  const p = path.join(__dirname, '.benchgo-blacklist.json');
  try {
    fs.writeFileSync(p, JSON.stringify([...set], null, 2), 'utf8');
  } catch (e) { /* ignore erreur disque */ }
}

// --- Historique des runs (succès ET échecs) ---
// Permet de distinguer un modèle "jamais testé" d'un modèle "testé mais échec"
// (load_failed, run KO). Sans cet historique, un modèle dont le chargement ou le
// run a échoué apparaît comme JAMAIS TESTE alors qu'on l'a bien tenté — d'où le
// bug constaté (Mixtral 7Bx2 MoE KO load_failed, Phi 4 KO EXPERT 226 min).
//
// Fichier : .benchgo-run-history.json à la racine.
// Structure : { "<modelKey>": { "lastAttempt": "ISO", "lastStatus": "ok"|"load_failed"|"run_ko", "lastSchool": "<key>", "attempts": <nb> } }
const RUN_HISTORY_FILE = path.join(__dirname, '.benchgo-run-history.json');

function loadRunHistory() {
  try {
    if (fs.existsSync(RUN_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(RUN_HISTORY_FILE, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch (e) { /* fichier corrompu : repart de zéro */ }
  return {};
}

function saveRunHistory(history) {
  try {
    fs.writeFileSync(RUN_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) { /* ignore erreur disque */ }
}

// Enregistre le résultat d'un run dans l'historique. status = 'ok' | 'load_failed' | 'run_ko'.
// school = clé SCHOOLS ou null (load_failed n'a pas d'école).
function recordRun(modelKey, status, school) {
  if (!modelKey) return;
  const history = loadRunHistory();
  const entry = history[modelKey] || { attempts: 0 };
  entry.lastAttempt = new Date().toISOString();
  entry.lastStatus = status;
  entry.lastSchool = school || null;
  entry.attempts = (entry.attempts || 0) + 1;
  history[modelKey] = entry;
  saveRunHistory(history);
}

// Renvoie le statut d'échec d'un modèle depuis l'historique, ou null si jamais
// tenté ou si le dernier run a réussi. Utilisé pour distinguer ECHEC de JAMAIS TESTE.
function runStatusFromHistory(modelKey) {
  if (!modelKey) return null;
  const history = loadRunHistory();
  const entry = history[modelKey];
  if (!entry) return null;
  if (entry.lastStatus === 'ok') return null; // dernier run OK → pas un échec
  return entry; // load_failed ou run_ko
}

// retire tout segment "mtp" (prefixe, suffixe, milieu) et les separateurs
// resultant. Ex : "gmmable-4-12b-Q4_K_M-mtp.gguf" -> "gmmable-4-12b-q4_k_m"
function stripMtpFromName(s) {
  let v = String(s).toLowerCase().replace(/\.gguf$/i, '').replace(/-gguf$/i, '');
  // Retire "mtp" ou il apparait (debut, fin, milieu) entoure de separateurs.
  v = v.replace(/^mtp[-_]/, '').replace(/[-_]mtp$/, '').replace(/[-_]mtp[-_]/, '-');
  return v.replace(/[-_]+/g, '-').replace(/^-|-$/g, '');
}

// Associe chaque modele principal a son eventuel fichier MTP. Strategie :
//   1. Regroupe les modeles par dossier parent (segment avant le dernier / du path).
//   2. Dans un meme dossier, si on trouve un MTP + un modele principal, on les
//      associe. Un dossier peut contenir plusieurs MTP (quantizations differentes)
//      mais on prend le premier qui n'est pas deja associe.
//   3. Fallback : si aucun MTP dans le meme dossier, on normalise le nom du
//      modele principal et on cherche un MTP dont le nom normalise correspond
//      (apres retrait du segment "mtp").
//
// Renvoie une Map: modelKey du modele principal -> modelKey du MTP associe.
function buildMtpAssociations(allModels) {
  const mtpModels = allModels.filter(isMtpModel);
  const mainModels = allModels.filter(m => !isMtpModel(m));
  if (mtpModels.length === 0) return new Map();

  const assoc = new Map();
  const usedMtp = new Set();

  // 1) Association par dossier parent commun.
  const byDir = {};
  for (const m of allModels) {
    const dir = (m.path || '').split('/').slice(0, -1).join('/');
    if (!dir) continue;
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push(m);
  }
  for (const dir of Object.keys(byDir)) {
    const group = byDir[dir];
    const mtpsInDir = group.filter(isMtpModel);
    const mainsInDir = group.filter(m => !isMtpModel(m));
    if (mtpsInDir.length === 0 || mainsInDir.length === 0) continue;
    // Associe chaque modele principal du dossier au premier MTP non utilise.
    for (const main of mainsInDir) {
      if (assoc.has(main.modelKey)) continue;
      const mtp = mtpsInDir.find(m => !usedMtp.has(m.modelKey));
      if (mtp) {
        assoc.set(main.modelKey, mtp.modelKey);
        usedMtp.add(mtp.modelKey);
      }
    }
  }

  // 2) Fallback par nom normalise.
  for (const main of mainModels) {
    if (assoc.has(main.modelKey)) continue;
    const base = (main.path || '').split('/').pop() || main.modelKey;
    const normMain = stripMtpFromName(base);
    for (const mtp of mtpModels) {
      if (usedMtp.has(mtp.modelKey)) continue;
      const mtpBase = (mtp.path || '').split('/').pop() || mtp.modelKey;
      const normMtp = stripMtpFromName(mtpBase);
      if (normMain === normMtp || normMain.includes(normMtp) || normMtp.includes(normMain)) {
        assoc.set(main.modelKey, mtp.modelKey);
        usedMtp.add(mtp.modelKey);
        break;
      }
    }
  }

  return assoc;
}

// Liste les modeles LLM telecharges via lms ls --json --llm. Chaque modele est
// enrichi d'un statut de test (deja teste / partiel / jamais teste) calcule en
// croisant son modelKey avec les carnets de scores existants. Les fichiers MTP
// (Multi-Token Prediction) sont filtres : ils ne sont pas des modeles testables
// seuls, mais sont associes a leur modele principal pour le chargement avec
// --speculative-draft-mtp (acceleration d'inference).
function listLlmModels() {
  const r = runLms(['ls', '--json', '--llm'], { timeoutMs: 30000 });
  if (r.status !== 0 || !r.stdout) {
    return { ok: false, models: [], error: r.stderr || `lms ls echoue (status=${r.status})` };
  }
  try {
    const arr = JSON.parse(r.stdout);
    if (!Array.isArray(arr)) return { ok: false, models: [], error: 'Reponse JSON inattendue' };
    // Construit les associations MTP avant de filtrer les fichiers MTP.
    const mtpAssociations = buildMtpAssociations(arr);
    const ledgers = loadAllLedgers();
    const allSchoolKeys = SCHOOLS.filter(s => s.cli !== null).map(s => s.key);
    // Renvoie les cles d'ecoles "accessibles" a un modele, c'est-a-dire toutes
    // les ecoles de LIGHT jusqu'a l'ecole detectee pour sa taille (incluse).
    // Raison : un modele de 12B (STANDARD) n'a pas vocation a passer EXPERT ou
    // DOCTORAT (trop difficiles pour sa capacite). Les lister comme "manquantes"
    // est trompeur : on n'attend de lui que LIGHT + STANDARD. Si la taille n'est
    // pas detectable, on retombe sur toutes les ecoles (comportement historique).
    function relevantSchoolKeysFor(m) {
      const s = schoolForModel(m);
      if (!s) return allSchoolKeys.slice();
      const idx = allSchoolKeys.indexOf(s.key);
      if (idx < 0) return allSchoolKeys.slice();
      return allSchoolKeys.slice(0, idx + 1);
    }
    // Filtre les fichiers MTP : ils ne sont pas des modeles testables seuls.
    const testable = arr.filter(m => !isMtpModel(m));
    // Charge la liste noire persistante (modèles isolés manuellement).
    const blacklist = loadBlacklist();
    // Charge l'historique des runs pour distinguer JAMAIS TESTE d'un échec réel.
    const runHistory = loadRunHistory();
    const models = testable.map(m => {
      const modelKey = m.modelKey;
      const ledger = matchLedger(modelKey, ledgers);
      const testedSchools = ledgerSchoolKeys(ledger);
      const relevantKeys = relevantSchoolKeysFor(m);
      // On ne considere comme "manquantes" que les ecoles pertinents pour la
      // taille du modele (LIGHT..son ecole). Les ecoles au-dela (trop difficiles)
      // sont ignorees : elles ne seront jamais demandees a ce modele.
      const relevantTested = testedSchools.filter(k => relevantKeys.includes(k));
      const missingSchools = relevantKeys.filter(k => !relevantTested.includes(k));
      // Détection des modèles non-LLM (OCR, embedding, rerank, vision-only).
      // Ils ne peuvent pas passer les écoles BenchGo → statut 'nonllm'.
      const nonLlm = isNonLlmModel(m);
      const blacklisted = blacklist.has(modelKey);
      // Statut d'échec depuis l'historique des runs (load_failed / run_ko).
      // Permet de distinguer un modèle jamais tenté d'un modèle tenté mais KO.
      const failedRun = runStatusFromHistory(modelKey);
      let status;
      if (nonLlm || blacklisted) {
        status = { kind: 'nonllm', tested: [], missing: [], quant: ledger ? ledger.quantization : null, reason: nonLlm ? 'Modèle non-LLM (OCR/embedding/rerank/vision)' : 'Isolé manuellement' };
      } else if (!ledger || testedSchools.length === 0) {
        // Pas de carnet : jamais testé avec succès. Mais a-t-on déjà tenté ?
        if (failedRun) {
          status = {
            kind: 'failed', tested: [], missing: relevantKeys.slice(),
            quant: ledger ? ledger.quantization : null,
            reason: failedRun.lastStatus === 'load_failed'
              ? 'Échec de chargement (load_failed)'
              : 'Échec du run (run KO)',
            lastAttempt: failedRun.lastAttempt,
            lastSchool: failedRun.lastSchool,
            attempts: failedRun.attempts || 1
          };
        } else {
          status = { kind: 'never', tested: [], missing: relevantKeys.slice(), quant: ledger ? ledger.quantization : null };
        }
      } else if (missingSchools.length === 0) {
        status = { kind: 'complete', tested: relevantTested, missing: [], quant: ledger.quantization };
      } else {
        // Partiel : certaines écoles manquent. Si l'une d'elles a échoué
        // (run KO), on le note pour ne pas proposer bêtement de retester.
        const failedSchool = failedRun && failedRun.lastStatus === 'run_ko' && failedRun.lastSchool
          ? failedRun.lastSchool : null;
        status = {
          kind: 'partial', tested: relevantTested, missing: missingSchools,
          quant: ledger.quantization,
          failedSchool: failedSchool,
          lastAttempt: failedRun ? failedRun.lastAttempt : null
        };
      }
      return {
        modelKey,
        displayName: m.displayName || m.modelKey,
        publisher: m.publisher || '?',
        params: m.paramsString || '?',
        quant: (m.quantization && m.quantization.name) || '?',
        size: m.sizeBytes || 0,
        arch: m.architecture || '?',
        status,
        nonLlm,
        blacklisted,
        // Cle du fichier MTP associe (null si aucun). Charge avec le modele
        // via --speculative-draft-mtp pour accelerer l'inference.
        mtpModelKey: mtpAssociations.get(modelKey) || null,
        // Metriques agreggees depuis le carnet (meilleure tentative par ecole).
        // Absentes si le modele n'a jamais ete teste (kind === 'never').
        metrics: computeLedgerMetrics(ledger)
      };
    });
    // Tri : modeles deja testes du plus fort au plus faible (pct, puis score,
    // puis sante), puis les modeles en echec (tentés mais KO), puis les modeles
    // jamais testes a la fin (par nom). Les non-LLM vont tout a la fin.
    models.sort((a, b) => {
      // Les modèles non-LLM (OCR/embedding/rerank/iso) vont tout à la fin.
      const aNonLlm = a.status.kind === 'nonllm';
      const bNonLlm = b.status.kind === 'nonllm';
      if (aNonLlm && !bNonLlm) return 1;
      if (!aNonLlm && bNonLlm) return -1;
      if (aNonLlm && bNonLlm) return (a.displayName || '').localeCompare(b.displayName || '');
      // Ordre de priorité : testés (complete/partial avec metrics) > échec > jamais.
      const rankKind = k => {
        if (k === 'complete' || k === 'partial') return 0;
        if (k === 'failed') return 1;
        return 2; // never
      };
      const ra = rankKind(a.status.kind);
      const rb = rankKind(b.status.kind);
      if (ra !== rb) return ra - rb;
      const aTested = a.metrics;
      const bTested = b.metrics;
      if (aTested && !bTested) return -1;
      if (!aTested && bTested) return 1;
      if (aTested && bTested) {
        const ma = a.metrics, mb = b.metrics;
        if (mb.pct !== ma.pct) return mb.pct - ma.pct;
        if (mb.score !== ma.score) return mb.score - ma.score;
        return (mb.globalLifeScore || 0) - (ma.globalLifeScore || 0);
      }
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: `Parse JSON echoue : ${e.message}` };
  }
}

function statusBadge(status) {
  if (!status) return { label: '?', color: C.gray };
  if (status.kind === 'nonllm')   return { label: 'NON APPLICABLE', color: C.gray };
  if (status.kind === 'failed')   return { label: 'ÉCHEC',          color: C.red };
  if (status.kind === 'never')   return { label: 'JAMAIS TESTE', color: C.yellow };
  if (status.kind === 'partial') return { label: 'PARTIEL',      color: C.magenta };
  return { label: 'COMPLET', color: C.green };
}

// Renvoie le label lisible ABRÉGÉ d'une cle SCHOOLS pour la colonne
// « Ecoles manquantes » du tableau. Les noms complets (Primaire, College-Lycee,
// Universite, Doctorat-These) sont trop longs cumulés et font deborder le
// terminal. On utilise des abreviations compactes mais reconnaissables.
// Ex : 'STANDARD' -> 'Coll-Lyc', 'DOCTORAT' -> 'Doctorat'.
// Fallback sur la cle brute si la cle est inconnue.
const SCHOOL_SHORT = {
  LIGHT: 'Prim',
  STANDARD: 'Coll-Lyc',
  EXPERT: 'Univ',
  DOCTORAT: 'Doct',
  auto: 'Auto',
  'auto-per-model': 'Auto/mod'
};

function schoolKeyToLabel(key) {
  return SCHOOL_SHORT[key] || key;
}

function missingSchoolsLabel(status) {
  if (!status || !status.missing || status.missing.length === 0) return '';
  return status.missing.map(schoolKeyToLabel).join(',');
}

// Formate une duree en ms vers un affichage compact (ex: 1.2s, 1m05s, 1h02m).
// Reprise minimale de score-ledger.js#formatDuration (sans coupler les modules).
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '\u2014';
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

// Formate un nombre de tokens en affichage compact (ex: 1234 -> 1.2k, 1234567 -> 1.2M).
// Utilisé dans la colonne Tokens du tableau --list-only pour repérer les modèles
// verbeux (qui produisent beaucoup de tokens et consomment donc beaucoup de temps).
function fmtTokens(n) {
  if (!n || n <= 0) return '\u2014';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// Renvoie le glyphe + couleur ANSI d'une tendance (up/down/stable/null).
function trendGlyph(trend) {
  if (trend === 'up') return `${C.green}\u25B2${C.reset}`;
  if (trend === 'down') return `${C.red}\u25BC${C.reset}`;
  if (trend === 'stable') return `${C.gray}=${C.reset}`;
  return `${C.gray}\u2014${C.reset}`;
}

// Recalcule le statut réel d'un modèle depuis son carnet de scores, sans
// tenir compte du marquage nonllm/blacklist. Utilisé après une désisolation
// (!!) pour restaurer le statut véritable (never/partial/complete) ou
// confirmer qu'il reste non-LLM par détection heuristique.
function recomputeStatus(m) {
  const nonLlm = isNonLlmModel(m);
  if (nonLlm) {
    return { nonLlm, status: { kind: 'nonllm', tested: [], missing: [], quant: null, reason: 'Non-LLM détecté (OCR/embedding/rerank/vision)' } };
  }
  const ledgers = loadAllLedgers();
  const ledger = matchLedger(m.modelKey, ledgers);
  const testedSchools = ledgerSchoolKeys(ledger);
  const allSchoolKeys = SCHOOLS.filter(s => s.cli !== null).map(s => s.key);
  const school = schoolForModel(m);
  let relevantKeys = allSchoolKeys.slice();
  if (school) {
    const idx = allSchoolKeys.indexOf(school.key);
    if (idx >= 0) relevantKeys = allSchoolKeys.slice(0, idx + 1);
  }
  const relevantTested = testedSchools.filter(k => relevantKeys.includes(k));
  const missingSchools = relevantKeys.filter(k => !relevantTested.includes(k));
  const failedRun = runStatusFromHistory(m.modelKey);
  let status;
  if (!ledger || testedSchools.length === 0) {
    if (failedRun) {
      status = {
        kind: 'failed', tested: [], missing: relevantKeys.slice(),
        quant: ledger ? ledger.quantization : null,
        reason: failedRun.lastStatus === 'load_failed'
          ? 'Échec de chargement (load_failed)'
          : 'Échec du run (run KO)',
        lastAttempt: failedRun.lastAttempt,
        lastSchool: failedRun.lastSchool,
        attempts: failedRun.attempts || 1
      };
    } else {
      status = { kind: 'never', tested: [], missing: relevantKeys.slice(), quant: ledger ? ledger.quantization : null };
    }
  } else if (missingSchools.length === 0) {
    status = { kind: 'complete', tested: relevantTested, missing: [], quant: ledger.quantization };
  } else {
    status = {
      kind: 'partial', tested: relevantTested, missing: missingSchools, quant: ledger.quantization,
      failedSchool: (failedRun && failedRun.lastStatus === 'run_ko' && failedRun.lastSchool) ? failedRun.lastSchool : null,
      lastAttempt: failedRun ? failedRun.lastAttempt : null
    };
  }
  return { nonLlm, status };
}

// Etat de tri par tokens (commande "tok" dans selectModelsInteractive).
// Permet de basculer entre le tri par score (defaut) et le tri par volume de
// tokens produits (decroissant) pour repérer les modèles verbeux qui consomment
// trop de temps d inference pour des scores parfois catastrophiques.
var _sortByTokens = false;

// Selection interactive des modeles.
async function selectModelsInteractive(models) {
  console.log(`\n  ${C.bold}${C.cyan}=== MODELES LLM TELECHARGES ===${C.reset}`);
  console.log(`  ${C.gray}Selectionnez les modeles a tester cette nuit.${C.reset}`);
  console.log(`  ${C.gray}Syntaxe : numeros separes par les virgules (ex: 1,3,5) ou "all".${C.reset}`);
  console.log(`  ${C.gray}Ordre : modeles testes du plus fort au plus faible, puis jamais testes, puis non-LLM a la fin.${C.reset}`);
  console.log(`  ${C.gray}Astuce : le dernier des testes est le plus faible — un bon candidat au retrait.${C.reset}`);
  console.log(`  ${C.gray}Isoler un modele non-LLM : !<num> (ex: !7) — le marque NON APPLICABLE et l'exclut.${C.reset}`);
  console.log(`  ${C.gray}Désisoler : !!<num> — retire un modele de la liste noire manuelle.${C.reset}`);
  console.log(`  ${C.gray}Tri par tokens (verbeux en haut) : tape "tok" puis Entrée — repère les modèles qui écrivent trop.${C.reset}\n`);

  // Tri par tokens produits (décroissant) si demandé. Les modèles jamais testés
  // (sans metrics) vont à la fin. Permet de repérer les modèles « verbeux » qui
  // consomment 1h30+ de GPU pour des scores catastrophiques (Gemmable, nanbeige).
  if (_sortByTokens) {
    models = models.slice().sort((a, b) => {
      const ta = (a.metrics && a.metrics.tokens) || 0;
      const tb = (b.metrics && b.metrics.tokens) || 0;
      if (tb !== ta) return tb - ta;
      // Egalité : on garde l'ordre par score (le plus fort d'abord).
      const pa = (a.metrics && a.metrics.pct) || 0;
      const pb = (b.metrics && b.metrics.pct) || 0;
      return pb - pa;
    });
  }

  // Largeurs de colonnes calculees dynamiquement a partir des donnees reelles.
  // Chaque largeur = max(longueur du header, longueur de la plus longue valeur).
  // Les valeurs trop longues sont tronquees avec .slice(0, W) pour garantir
  // un alignement parfait (style militaire — tout est carre).
  const colIdx = String(models.length) + '.';
  const idxW = Math.max(4, colIdx.length + 1);
  const nameW = Math.max(30, ...models.map(m => (m.displayName || '').length));
  const paramW = Math.max(5, ...models.map(m => (m.params || '?').length));
  const quantW = Math.max(7, ...models.map(m => (m.quant || '?').length));
  const sizeW = Math.max(8, ...models.map(m => fmtBytes(m.size).length));
  const pubW = Math.max(14, ...models.map(m => (m.publisher || '?').length));
  const statusW = 15; // COMPLET / PARTIEL / JAMAIS TESTE / NON APPLICABLE — fixe
  const pctW = 5;
  const tpsW = 8;
  const tokW = 7;
  const attW = 5;
  const trendW = 4;
  const timeW = Math.max(8, ...models.map(m => {
    const mt = m.metrics;
    return mt && mt.elapsedMs > 0 ? fmtDuration(mt.elapsedMs).length : 0;
  }));
  const missW = Math.max(22, ...models.map(m => (missingSchoolsLabel(m.status) || '').length));

  const hdrIdx = ' '.repeat(idxW);
  const header = `  ${hdrIdx}${'Modèle'.padEnd(nameW)} ${'Param'.padEnd(paramW)} ${'Quant'.padEnd(quantW)} ${'Taille'.padStart(sizeW)}  ${'Editeur'.padEnd(pubW)} ${'Statut'.padEnd(statusW)} ${'Pct'.padStart(pctW)} ${'Vit.'.padStart(tpsW)} ${'Tokens'.padStart(tokW)} ${'Tent.'.padStart(attW)} ${'Tnd'.padStart(trendW)} ${'Temps'.padStart(timeW)}  ${'Ecoles manquantes'}`;
  console.log(`${C.gray}${header}${C.reset}`);
  const sep = '─'.repeat(idxW + nameW + paramW + quantW + sizeW + pubW + statusW + pctW + tpsW + tokW + attW + trendW + timeW + missW + 21);
  console.log(`${C.gray}  ${sep}${C.reset}`);
  models.forEach((m, i) => {
    const idx = String(i + 1).padStart(Math.max(2, idxW - 1)) + '.';
    const sz = fmtBytes(m.size).padStart(sizeW);
    const badge = statusBadge(m.status);
    const statusStr = `${badge.color}${badge.label.padEnd(statusW)}${C.reset}`;
    const missing = missingSchoolsLabel(m.status);
    const missStr = missing
      ? `${C.gray}${missing.padEnd(missW)}${C.reset}`
      : (m.status.kind === 'nonllm' && m.status.reason)
        ? `${C.gray}${m.status.reason.slice(0, missW).padEnd(missW)}${C.reset}`
        : ' '.repeat(missW);
    const mtpTag = m.mtpModelKey ? `${C.cyan}[MTP]${C.reset} ` : '';
    const namePad = nameW - (mtpTag ? 6 : 0);
    const nameRaw = (m.displayName || '').slice(0, namePad);
    const name = `${nameRaw.padEnd(namePad)}${mtpTag}`;
    const pub = (m.publisher || '?').slice(0, pubW).padEnd(pubW);
    const params = (m.params || '?').slice(0, paramW).padEnd(paramW);
    const quant = (m.quant || '?').slice(0, quantW).padEnd(quantW);
    const mt = m.metrics;
    const pctStr = mt ? `${String(mt.pct + '%').padStart(pctW)}` : `${C.gray}${'?'.padStart(pctW)}${C.reset}`;
    const tpsStr = mt && mt.tokensPerSecond > 0
      ? `${(mt.tokensPerSecond + ' t/s').padStart(tpsW)}`
      : `${C.gray}${'\u2014'.padStart(tpsW)}${C.reset}`;
    // Affichage des tokens produits (cumul multi-ecoles). En mode tri par tokens,
    // on surligne en jaune les valeurs elevees (>50k) pour alerter sur la verbosite.
    const tokVal = mt ? (mt.tokens || 0) : 0;
    const tokStr = tokVal > 0
      ? (_sortByTokens && tokVal > 50000
          ? `${C.yellow}${fmtTokens(tokVal).padStart(tokW)}${C.reset}`
          : fmtTokens(tokVal).padStart(tokW))
      : `${C.gray}${'\u2014'.padStart(tokW)}${C.reset}`;
    const attStr = mt ? `${String(mt.attempts).padStart(attW)}` : `${C.gray}${'?'.padStart(attW)}${C.reset}`;
    const trendStr = mt ? `${trendGlyph(mt.trend).padEnd(trendW)}` : `${C.gray}${'\u2014'.padEnd(trendW)}${C.reset}`;
    const timeStr = mt && mt.elapsedMs > 0
      ? `${fmtDuration(mt.elapsedMs).padStart(timeW)}`
      : `${C.gray}${'\u2014'.padStart(timeW)}${C.reset}`;
    console.log(`  ${C.bold}${idx}${C.reset} ${name} ${C.gray}${params} ${quant}${C.reset} ${sz}  ${C.gray}${pub}${C.reset} ${statusStr} ${pctStr} ${tpsStr} ${tokStr} ${attStr} ${trendStr} ${timeStr}  ${missStr}`);
  });
  console.log('');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${C.cyan}Modeles a tester :${C.reset} `, answer => {
      rl.close();
      const raw = (answer || '').trim().toLowerCase();
      if (raw === 'all' || raw === '*') { resolve(models); return; }
      // Commande de tri par tokens : "tok" bascule le tri par volume de tokens
      // produits (décroissant) pour repérer les modèles verbeux. Taper "tok" à
      // nouveau revient au tri par score (défaut).
      if (raw === 'tok' || raw === 'tokens') {
        _sortByTokens = !_sortByTokens;
        console.log(`  ${C.cyan}Tri par tokens : ${_sortByTokens ? 'ACTIVÉ (verbeux en haut)' : 'désactivé (tri par score)'}${C.reset}`);
        resolve(selectModelsInteractive(models));
        return;
      }
      // Commandes d'isolation : !<num> isole (liste noire), !!<num> désisole.
      const isolateMatch = raw.match(/^!(\d+)$/);
      const unisolateMatch = raw.match(/^!!(\d+)$/);
      if (isolateMatch) {
        const n = parseInt(isolateMatch[1], 10);
        if (n >= 1 && n <= models.length) {
          const target = models[n - 1];
          const bl = loadBlacklist();
          bl.add(target.modelKey);
          saveBlacklist(bl);
          target.status = { kind: 'nonllm', tested: [], missing: [], quant: target.status.quant, reason: 'Isolé manuellement' };
          target.blacklisted = true;
          console.log(`  ${C.yellow}${target.displayName} → isolé (NON APPLICABLE). Ne sera plus testé.${C.reset}`);
        } else {
          console.log(`  ${C.red}Numéro invalide.${C.reset}`);
        }
        // Relance l'affichage + le prompt (async) sans bloquer.
        resolve(selectModelsInteractive(models));
        return;
      }
      if (unisolateMatch) {
        const n = parseInt(unisolateMatch[1], 10);
        if (n >= 1 && n <= models.length) {
          const target = models[n - 1];
          const bl = loadBlacklist();
          bl.delete(target.modelKey);
          saveBlacklist(bl);
          // Recalcule le statut réel depuis le carnet (perte du marquage nonllm manuel).
          const re = recomputeStatus(target);
          target.status = re.status;
          target.blacklisted = false;
          target.nonLlm = re.nonLlm;
          console.log(`  ${C.green}${target.displayName} → désisolé.${C.reset}`);
        } else {
          console.log(`  ${C.red}Numéro invalide.${C.reset}`);
        }
        resolve(selectModelsInteractive(models));
        return;
      }
      const indices = raw.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= models.length);
      const uniq = [...new Set(indices.map(n => n - 1))];
      // Exclut automatiquement les modèles non-LLM de la sélection de test.
      const testable = uniq.map(i => models[i]).filter(m => m.status.kind !== 'nonllm');
      if (testable.length < uniq.length) {
        const excluded = uniq.length - testable.length;
        console.log(`  ${C.yellow}${excluded} modèle(s) non-LLM exclus automatiquement de la sélection.${C.reset}`);
      }
      resolve(testable);
    });
  });
}

// Détermine l'école (profil) adaptée à un modèle depuis sa taille de paramètres.
// Utilise detectProfileFromModelName (config.js) sur le displayName puis le
// modelKey (fallback). Retourne l'objet SCHOOLS correspondant au profil détecté,
// ou null si la taille n'est pas détectable (modèle non reconnu).
//
// Seuils (alignés sur config.js) :
//   < 3B   → LIGHT    (Primaire)
//   3-15B  → STANDARD (College-Lycee)
//   15-30B → EXPERT   (Universite)
//   > 30B  → DOCTORAT (These)
function schoolForModel(m) {
  if (!m) return null;
  let detected = null;
  // 1) Détecte depuis le displayName (nom lisible, souvent avec la taille).
  if (m.displayName) {
    detected = detectProfileFromModelName(m.displayName).detected;
  }
  // 2) Fallback : depuis le modelKey (ex: "deepseek-r1-distill-qwen-14b@q4_k_s").
  if (!detected && m.modelKey) {
    detected = detectProfileFromModelName(m.modelKey).detected;
  }
  // 3) Fallback : depuis paramsString/params (ex: "14B", "3B", "26B-A4B"). Le
  //    runner LM Studio fournit une taille fiable ici même quand le nom ne
  //    l'indique pas. On teste m.params (objet enrichi) ET m.paramsString
  //    (entrée brute de lms ls --json) car schoolForModel est appelé sur les
  //    deux types d'objets (listLlmModels travaille sur l'entrée brute avant
  //    de l'enrichir).
  if (!detected && (m.params || m.paramsString)) {
    const sizeMatch = String(m.params || m.paramsString).match(/([\d]+[.,]?[\d]*)\s*b/i);
    if (sizeMatch) {
      const sz = parseFloat(sizeMatch[1].replace(',', '.'));
      if (sz < 3) detected = 'LIGHT';
      else if (sz <= 15) detected = 'STANDARD';
      else if (sz <= 30) detected = 'EXPERT';
      else detected = 'DOCTORAT';
    }
  }
  if (!detected) return null;
  return SCHOOLS.find(s => s.key === detected) || null;
}

// Label lisible du profil détecté pour un modèle (ex: "Primaire (< 3B)").
// Retourne '— (taille inconnue)' si non détectable.
function schoolLabelForModel(m) {
  const s = schoolForModel(m);
  return s ? s.label : '— (taille inconnue)';
}

// Liste des écoles à enchaîner pour un modèle en mode auto-par-modèle (option 6).
// Pour les modèles > 3B (STANDARD ou supérieur) : Primaire (LIGHT) puis l'école
// détectée — exactement comme le runner interactif (option B). Pour les modèles
// < 3B (LIGHT) ou de taille indétectable : école unique (pas de niveau inférieur
// à Primaire). Renvoie un tableau d'objets SCHOOLS (jamais vide).
function schoolsForModelPlan(m) {
  const school = schoolForModel(m) || SCHOOLS.find(s => s.key === 'auto');
  if (school.key !== 'auto' && school.key !== 'LIGHT') {
    return [...new Set(['LIGHT', school.key])]
      .map(k => SCHOOLS.find(s => s.key === k))
      .filter(Boolean);
  }
  return [school];
}

// Selection interactive des ecoles.
async function selectSchoolsInteractive(selectedModels) {
  console.log(`\n  ${C.bold}${C.cyan}=== ECOLES A TESTER ===${C.reset}`);
  console.log(`  ${C.gray}Selectionnez les ecoles (niveaux) a faire passer a chaque modele.${C.reset}`);
  console.log(`  ${C.gray}Syntaxe : numeros separes par les virgules (ex: 1,2) ou "all".${C.reset}`);
  console.log(`  ${C.gray}Option 6 = AUTO PAR MODELE : chaque modele passe l'ecole${C.reset}`);
  console.log(`  ${C.gray}adaptee a sa taille de parametres (3B->Primaire, 15B->College-Lycee, etc.).${C.reset}`);
  console.log(`  ${C.gray}Modeles > 3B : enchaîne Primaire (LIGHT) puis l'ecole detectee.${C.reset}`);
  console.log(`  ${C.gray}Ideal quand la file melange des modeles de tailles differentes.${C.reset}`);
  console.log(`  ${C.gray}Option 7 = MANUEL PAR MODELE : choisissez l'ecole de chaque modele${C.reset}`);
  console.log(`  ${C.gray}individuellement. Permet de melanger auto + manuel dans la meme session.${C.reset}\n`);
  SCHOOLS.forEach((s, i) => {
    const idx = String(i + 1).padStart(2);
    // Pour l'option 'auto', on précise que c'est l'auto-détection classique
    // (1 école par modèle, le runner devine le profil).
    let extra = '';
    if (s.key === 'auto') extra = ' (auto-detection runner)';
    console.log(`  ${C.bold}${idx}.${C.reset} ${s.label}${C.gray}${extra}${C.reset}`);
  });

  // Aperçu de l'attribution auto-par-modèle (option 6) pour aider l'utilisateur
  // à anticiper : montre quelles écoles chaque modèle sélectionné ferait.
  // Les modèles > 3B enchaînent Primaire (LIGHT) puis l'école détectée.
  if (selectedModels && selectedModels.length > 0) {
    console.log(`\n  ${C.gray}Aperçu option 6 (auto par modèle) :${C.reset}`);
    for (const m of selectedModels) {
      const schoolsList = schoolsForModelPlan(m);
      const labels = schoolsList.map(s => s.label).join(' → ');
      console.log(`  ${C.gray}  ${m.displayName.padEnd(30)} → ${labels}${C.reset}`);
    }
    console.log('');
  }

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${C.cyan}Ecoles a tester :${C.reset} `, answer => {
      rl.close();
      const raw = (answer || '').trim().toLowerCase();
      if (raw === 'all' || raw === '*') { resolve(SCHOOLS.filter(s => s.cli !== null)); return; }
      const indices = raw.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= SCHOOLS.length);
      const uniq = [...new Set(indices.map(n => n - 1))];
      resolve(uniq.map(i => SCHOOLS[i]));
    });
  });
}

// Sélection manuelle de l'école pour chaque modèle, un par un.
// L'utilisateur choisit individuellement quelle(s) école(s) chaque modèle
// doit passer. Permet de mélanger des modèles aux besoins différents dans la
// même session (ex: Kai Os Grug 12B en auto selon la taille, Phi 4 en Primaire
// uniquement pour rattraper son statut partiel).
//
// Pour chaque modèle, l'utilisateur tape :
//   - "auto" → école(s) détectée(s) selon la taille (LIGHT + école détectée)
//   - numéros séparés par virgules (ex: "1" = Primaire, "1,2" = Primaire + Collège-Lycée)
//   - "all" → toutes les écoles
//   - Entrée → auto par modèle (défaut, école selon la taille)
//
// Retourne un plan { model, schools: [...] } par modèle, comme le mode auto-par-modèle.
async function selectSchoolsManualPerModel(selectedModels) {
  console.log(`\n  ${C.bold}${C.cyan}=== MANUEL PAR MODÈLE ===${C.reset}`);
  console.log(`  ${C.gray}Choisissez l'ecole de chaque modele individuellement.${C.reset}`);
  console.log(`  ${C.gray}Options par modele :${C.reset}`);
  console.log(`  ${C.gray}  1=Primaire  2=College-Lycee  3=Universite  4=These  (ex: "1,2" = Primaire puis College-Lycee)${C.reset}`);
  console.log(`  ${C.gray}  "auto"=ecole selon la taille  |  "all"=toutes  |  Entree=auto${C.reset}\n`);

  const plan = [];
  const realSchools = SCHOOLS.filter(s => s.cli !== null);
  for (const m of selectedModels) {
    // Affiche l'école détectée par défaut pour aider l'utilisateur.
    const defaultSchool = schoolForModel(m);
    const defaultLabel = defaultSchool ? defaultSchool.label : 'taille inconnue';
    const answer = await new Promise(resolve => {
      const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl3.question(`  ${C.cyan}${C.bold}${m.displayName}${C.reset}${C.cyan} [${m.params} ${m.quant}] (defaut: ${defaultLabel}) ?${C.reset} `, a => {
        rl3.close();
        resolve((a || '').trim().toLowerCase());
      });
    });
    let chosen;
    if (!answer || answer === 'auto') {
      // Auto selon la taille (comme l'option 6).
      chosen = schoolsForModelPlan(m);
    } else if (answer === 'all' || answer === '*') {
      chosen = realSchools.slice();
    } else {
      const indices = answer.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= realSchools.length);
      chosen = [...new Set(indices.map(n => realSchools[n - 1]))];
    }
    if (chosen.length === 0) {
      console.log(`  ${C.yellow}Aucune ecole valide pour ${m.displayName} -> auto par defaut.${C.reset}`);
      chosen = schoolsForModelPlan(m);
    }
    const labels = chosen.map(s => s.label).join(' → ');
    console.log(`  ${C.green}  → ${m.displayName} : ${labels}${C.reset}\n`);
    plan.push({ model: m, schools: chosen });
  }
  return plan;
}

function loadModel(modelKey, mtpModelKey) {
  const args = ['load', modelKey];
  if (mtpModelKey) {
    args.push('--speculative-draft-model', mtpModelKey, '--speculative-draft-mtp');
  }
  const r = runLms(args, { timeoutMs: 180000 });
  if (r.status !== 0) {
    console.log(`  ${C.red}lms load echoue : ${r.stderr || r.stdout || 'erreur inconnue'}${C.reset}`);
    return false;
  }
  return true;
}

function unloadAll() {
  runLms(['unload', '--all'], { timeoutMs: 60000 });
}

function runBenchmark(modelKey, schoolCli, extraArgs) {
  const args = ['runner.js', '--force'];
  if (schoolCli) args.push(`--profile=${schoolCli}`);
  for (const a of extraArgs) args.push(a);
  const start = Date.now();
  console.log(`\n  ${C.magenta}> Lancement : node ${args.join(' ')}${C.reset}\n`);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    windowsHide: false,
    timeout: 0
  });
  const durationMs = Date.now() - start;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, status: r.status, durationMs };
}

function parseArgs() {
  const raw = process.argv.slice(2);
  const modelsArg = (() => { const a = raw.find(r => r.startsWith('--models=')); return a ? a.split('=').slice(1).join('=') : null; })();
  const schoolsArg = (() => { const a = raw.find(r => r.startsWith('--schools=')); return a ? a.split('=').slice(1).join('=') : null; })();
  const noTeacher = raw.includes('--no-teacher');
  const listOnly = raw.includes('--list-only');
  const extraRunnerArgs = [];
  if (noTeacher) extraRunnerArgs.push('--no-teacher');
  return { modelsArg, schoolsArg, noTeacher, listOnly, extraRunnerArgs };
}

function resolveSchoolsFromArg(schoolsArg) {
  const keys = schoolsArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const found = [];
  for (const k of keys) {
    const s = SCHOOLS.find(x => x.key.toUpperCase() === k);
    if (s) found.push(s);
  }
  return found;
}

async function main() {
  console.log(`\n${C.bold}${C.cyan}==================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}          BENCHGO V3 - MODE NUIT (BATCH)           ${C.reset}`);
  console.log(`${C.bold}${C.cyan}   File d'attente automatique de modeles LM Studio   ${C.reset}`);
  console.log(`${C.bold}${C.cyan}==================================================${C.reset}\n`);

  const { modelsArg, schoolsArg, listOnly, extraRunnerArgs } = parseArgs();

  console.log(`  ${C.gray}[${nowClock()}] Verification du daemon LM Studio...${C.reset}`);
  if (!isDaemonUp()) {
    console.log(`  ${C.red}Le daemon LM Studio ne repond pas.${C.reset}`);
    console.log(`  ${C.gray}Lancez LM Studio (l'application, ou 'lms daemon up') puis relancez ce script.${C.reset}`);
    process.exit(1);
  }
  console.log(`  ${C.green}Daemon LM Studio actif.${C.reset}`);

  let serverHandle = { startedByUs: false };
  if (await isServerUp()) {
    console.log(`  ${C.green}Serveur HTTP LM Studio deja actif sur ${LMSTUDIO_HOST}.${C.reset}`);
  } else {
    serverHandle = await startServer();
    if (!serverHandle.startedByUs) {
      console.log(`  ${C.red}Impossible de demarrer le serveur HTTP LM Studio. Abandon.${C.reset}`);
      process.exit(1);
    }
  }

  console.log(`\n  ${C.gray}[${nowClock()}] Recuperation de la liste des modeles...${C.reset}`);
  const { ok: listOk, models, error: listErr } = listLlmModels();
  if (!listOk || models.length === 0) {
    console.log(`  ${C.red}Aucun modele LLM trouve : ${listErr}${C.reset}`);
    if (serverHandle.startedByUs) stopServer();
    process.exit(1);
  }

  // Mode --list-only : affiche la liste triee par statut et quitte (debug).
  if (listOnly) {
    await selectModelsInteractive(models);
    if (serverHandle.startedByUs) stopServer();
    process.exit(0);
  }

  let selected;
  if (modelsArg) {
    const keys = modelsArg.split(',').map(s => s.trim()).filter(Boolean);
    selected = models.filter(m => keys.includes(m.modelKey));
    if (selected.length === 0) {
      console.log(`  ${C.red}Aucun modele de --models= trouve dans la liste.${C.reset}`);
      console.log(`  ${C.gray}ModelKeys disponibles : ${models.map(m => m.modelKey).join(', ')}${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(1);
    }
    // Exclut les modèles non-LLM de la sélection explicite par --models.
    const before = selected.length;
    selected = selected.filter(m => m.status.kind !== 'nonllm');
    if (selected.length < before) {
      console.log(`  ${C.yellow}${before - selected.length} modèle(s) non-LLM exclus automatiquement.${C.reset}`);
    }
    console.log(`  ${C.gray}Selection via --models : ${selected.length} modele(s).${C.reset}`);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(`  ${C.red}Session non-interactive : utilisez --models=key1,key2 pour specifier les modeles.${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(1);
    }
    selected = await selectModelsInteractive(models);
    if (selected.length === 0) {
      console.log(`  ${C.yellow}Aucun modele selectionne. Abandon.${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(0);
    }
  }

  let schools;
  let manualPlan = null;
  if (schoolsArg) {
    schools = resolveSchoolsFromArg(schoolsArg);
    if (schools.length === 0) {
      console.log(`  ${C.red}Aucune ecole de --schools= reconnue.${C.reset}`);
      console.log(`  ${C.gray}Ecoles valides : ${SCHOOLS.map(s => s.key).join(', ')}${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(1);
    }
    console.log(`  ${C.gray}Selection via --schools : ${schools.map(s => s.key).join(', ')}${C.reset}`);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      schools = [SCHOOLS.find(s => s.key === 'auto')];
      console.log(`  ${C.gray}Non-interactif sans --schools : auto-detection du profil par modele.${C.reset}`);
    } else {
      schools = await selectSchoolsInteractive(selected);
      if (schools.length === 0) {
        console.log(`  ${C.yellow}Aucune ecole selectionnee. Abandon.${C.reset}`);
        if (serverHandle.startedByUs) stopServer();
        process.exit(0);
      }
      // Option 7 = manuel par modèle : on demande l'école de chaque modèle
      // individuellement, puis on construit le plan manuel. schools contient
      // uniquement le marqueur 'manual-per-model' qui active la branche manuelle.
      if (isManualPerModel(schools)) {
        manualPlan = await selectSchoolsManualPerModel(selected);
      }
    }
  }

  // Mode auto-par-modele : on calcule l'ecole de chaque modele individuellement.
  // Un modele dont la taille n'est pas detectable est envoye en auto-detection
  // (le runner devinera le profil depuis le nom). On construit un plan
  // { model, schools: [...] } par modele pour l'affichage et l'execution.
  //
  // IMPORTANT : pour les modeles > 3B (STANDARD ou superieur), on enchaîne
  // Primaire (LIGHT) PUIS l'ecole detectee — exactement comme le runner
  // interactif (runner.js option B). Sinon un 12B ne ferait que STANDARD et
  // LIGHT resterait "manquante" dans le carnet. Les modeles < 3B (LIGHT)
  // ne font qu'une seule ecole (pas de niveau inferieur a Primaire).
  //
  // Mode manuel-par-modele : l'utilisateur a choisi l'ecole de chaque modele
  // individuellement (option 7). Le plan est deja construit par
  // selectSchoolsManualPerModel(). On l'utilise tel quel.
  const autoPerModel = isAutoPerModel(schools);
  const manualPerModel = isManualPerModel(schools);
  let plan;
  if (manualPerModel) {
    // Le plan est construit par selectSchoolsManualPerModel (saisie individuelle).
    // schools contient uniquement le marqueur 'manual-per-model'.
    plan = manualPlan;
  } else if (autoPerModel) {
    plan = selected.map(m => ({ model: m, schools: schoolsForModelPlan(m) }));
    // Vérifie qu'au moins un modèle a une école détectée (sinon tout est en auto).
    const detectedCount = plan.filter(p => p.schools.some(s => s.key !== 'auto')).length;
    if (detectedCount === 0) {
      console.log(`  ${C.yellow}Aucun modele n'a une taille de parametres detectable.${C.reset}`);
      console.log(`  ${C.gray}Le runner utilisera l'auto-detection pour chacun.${C.reset}`);
    }
  } else {
    plan = null;
  }

  // --- Saisie manuelle des quantifications non détectées ---
  // lms ls --json fournit normalement la quantification de chaque modèle. Mais
  // certains modèles n'ont pas de champ quantization (fichiers exotiques, anciens
  // GGUF...). Sans quantif, le runner crée un carnet générique (sans quantif dans
  // le shortName) et plusieurs quantifs du même modèle s'écrasent → une seule
  // entrée dans le classement.
  // On demande donc à l'utilisateur de saisir la quantif pour chaque modèle
  // concerné, un par un, AVANT de lancer la file d'attente.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const missingQuant = selected.filter(m => !m.quant || m.quant === '?');
    if (missingQuant.length > 0) {
      console.log(`\n  ${C.bold}${C.yellow}=== QUANTIFICATION NON DÉTECTÉE ===${C.reset}`);
      console.log(`  ${C.gray}${missingQuant.length} modèle(s) sans quantification détectée par lms ls.${C.reset}`);
      console.log(`  ${C.gray}Sans quantif, les carnets ne distinguent pas Q4/Q5/Q6... → écrasement du même carnet.${C.reset}`);
      console.log(`  ${C.gray}Exemples : Q4_K_M, Q4_K_S, Q5_K_M, Q5_K_S, Q6_K, Q8_0, F16...${C.reset}`);
      console.log(`  ${C.gray}(Entrée = laisser inconnu — carnet générique)${C.reset}\n`);
      for (const m of missingQuant) {
        const qInput = await new Promise(resolve => {
          const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl2.question(`  ${C.cyan}Quantification de ${C.bold}${m.displayName}${C.reset}${C.cyan} [${m.modelKey}] ?${C.reset} `, answer => {
            rl2.close();
            resolve((answer || '').trim());
          });
        });
        if (qInput) {
          m.quant = qInput;
          console.log(`  ${C.green}→ ${m.displayName} : ${qInput}${C.reset}`);
        } else {
          console.log(`  ${C.gray}→ ${m.displayName} : inconnue (carnet générique)${C.reset}`);
        }
      }
      console.log('');
    }
  }

  const totalRuns = (autoPerModel || manualPerModel)
    ? plan.reduce((sum, p) => sum + p.schools.length, 0)
    : selected.length * schools.length;
  console.log(`\n  ${C.bold}${C.cyan}=== FILE D'ATTENTE DE NUIT ===${C.reset}`);
  console.log(`  ${C.bold}Modeles :${C.reset} ${selected.length}  |  ${C.bold}Ecoles :${C.reset} ${schools.map(s => s.key).join(', ')}  |  ${C.bold}Runs totaux :${C.reset} ${totalRuns}`);
  if (manualPerModel) {
    console.log(`  ${C.gray}Mode manuel-par-modele : ecole choisie individuellement pour chaque modele.${C.reset}`);
    console.log(`  ${C.gray}Attribution :${C.reset}`);
    for (const p of plan) {
      const labels = p.schools.map(s => s.label).join(' → ');
      console.log(`  ${C.bold}  ${p.model.displayName.padEnd(28)}${C.reset} ${C.gray}→ ${labels}${C.reset}`);
    }
  } else if (autoPerModel) {
    console.log(`  ${C.gray}Mode auto-par-modele : chaque modele passe l'ecole adaptee a sa taille.${C.reset}`);
    console.log(`  ${C.gray}Modeles > 3B : enchaînement Primaire (LIGHT) puis ecole detectee.${C.reset}`);
    console.log(`  ${C.gray}Attribution :${C.reset}`);
    for (const p of plan) {
      const labels = p.schools.map(s => s.label).join(' → ');
      console.log(`  ${C.bold}  ${p.model.displayName.padEnd(28)}${C.reset} ${C.gray}→ ${labels}${C.reset}`);
    }
  } else {
    console.log(`  ${C.gray}Ordre : pour chaque modele, on enchaine toutes les ecoles selectionnees.${C.reset}`);
    selected.forEach((m, i) => {
      console.log(`  ${C.bold}${String(i + 1).padStart(2)}.${C.reset} ${m.displayName} ${C.gray}[${m.modelKey}] ${m.params} ${m.quant}${C.reset}`);
    });
  }
  console.log(`\n  ${C.gray}Debut a ${nowClock()}. Laissez tourner, les rapports seront dans Export-Rapports/.${C.reset}`);
  console.log(`  ${C.gray}Ctrl+C pour interrompre (le modele en cours finira son tier en cours).${C.reset}\n`);

  const results = [];
  const batchStart = Date.now();
  for (let i = 0; i < selected.length; i++) {
    const m = selected[i];
    console.log(`\n${C.bold}${C.magenta}==================================================${C.reset}`);
    console.log(`${C.bold}${C.magenta}  MODELE ${i + 1}/${selected.length} - ${m.displayName} ${C.gray}[${m.modelKey}]${C.reset}`);
    console.log(`${C.bold}${C.magenta}  ${m.params} - ${m.quant} - ${fmtBytes(m.size)} - ${m.publisher}${C.reset}`);
    console.log(`${C.bold}${C.magenta}==================================================${C.reset}`);

    // Détermine la liste d'écoles pour CE modèle. En mode auto-par-modèle ou
    // manuel-par-modèle, c'est la liste d'écoles du plan (calculée depuis la
    // taille ou choisie individuellement). Sinon, ce sont toutes les écoles
    // sélectionnées globalement.
    let modelSchools;
    if (autoPerModel || manualPerModel) {
      modelSchools = plan[i].schools;
    } else {
      modelSchools = schools;
    }

    console.log(`  ${C.gray}[${nowClock()}] Dechargement des modeles precedents...${C.reset}`);
    unloadAll();

    console.log(`  ${C.gray}[${nowClock()}] Chargement du modele ${m.modelKey}...${C.reset}`);
    if (m.mtpModelKey) {
      console.log(`  ${C.gray}[${nowClock()}] Fichier MTP associe detecte : ${m.mtpModelKey} (speculative decoding MTP active).${C.reset}`);
    }
    if (!loadModel(m.modelKey, m.mtpModelKey)) {
      console.log(`  ${C.yellow}Modele ${m.modelKey} non chargeable - ignore.${C.reset}`);
      recordRun(m.modelKey, 'load_failed', null);
      results.push({ model: m, ok: false, reason: 'load_failed', durationMs: 0 });
      continue;
    }
    console.log(`  ${C.green}Modele charge.${C.reset}`);

    let modelOk = true;
    // Arguments runner supplementaires propres a CE modele : on passe la
    // quantification explicitement pour que le shortName du carnet l'integre.
    // Sans cela, deux quantifications du meme modele ecrasent le meme carnet
    // (ex: kai-os_grug-12b Q4_K_S et Q5_K_L -> meme fichier .json).
    const modelExtraArgs = extraRunnerArgs.slice();
    if (m.quant && m.quant !== '?') {
      modelExtraArgs.push(`--quantization=${m.quant}`);
    }
    for (let j = 0; j < modelSchools.length; j++) {
      const school = modelSchools[j];
      console.log(`\n  ${C.bold}${C.cyan}=== ECOLE ${j + 1}/${modelSchools.length} - ${school.label} ===${C.reset}`);

      const bench = runBenchmark(m.modelKey, school.cli, modelExtraArgs);
      const mins = (bench.durationMs / 60000).toFixed(1);
      if (!bench.ok) modelOk = false;
      // Enregistre le résultat (succès OU échec) dans l'historique des runs
      // pour distinguer JAMAIS TESTE d'un échec réel (load_failed / run KO).
      recordRun(m.modelKey, bench.ok ? 'ok' : 'run_ko', school.key);
      console.log(`\n  ${bench.ok ? C.green : C.red}[${nowClock()}] ${m.displayName} / ${school.label} termine en ${mins} min (status=${bench.status}).${C.reset}`);
      results.push({ model: m, school: school.key, ok: bench.ok, status: bench.status, durationMs: bench.durationMs });
    }
    console.log(`\n  ${modelOk ? C.green : C.red}[${nowClock()}] Modele ${m.displayName} termine (${modelSchools.length} ecole(s)).${C.reset}`);
  }

  console.log(`\n  ${C.gray}[${nowClock()}] Dechargement de tous les modeles...${C.reset}`);
  unloadAll();
  if (serverHandle.startedByUs) stopServer();

  const totalMin = ((Date.now() - batchStart) / 60000).toFixed(1);
  const okCount = results.filter(r => r.ok).length;
  console.log(`\n${C.bold}${C.cyan}==================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}            BILAN DE LA SESSION DE NUIT            ${C.reset}`);
  console.log(`${C.bold}${C.cyan}==================================================${C.reset}`);
  console.log(`  ${C.bold}Duree totale :${C.reset} ${totalMin} min`);
  console.log(`  ${C.bold}Runs executes :${C.reset} ${results.length}`);
  console.log(`  ${C.bold}Succes :${C.reset} ${okCount}   ${C.bold}Echecs :${C.reset} ${results.length - okCount}\n`);

  console.log(`  ${C.bold}Detail :${C.reset}`);
  for (const r of results) {
    const mins = (r.durationMs / 60000).toFixed(1);
    const icon = r.ok ? `${C.green}OK${C.reset}` : `${C.red}KO${C.reset}`;
    const reason = r.reason ? ` ${C.gray}(${r.reason})${C.reset}` : '';
    const schoolTag = r.school ? ` ${C.gray}[${r.school}]${C.reset}` : '';
    console.log(`  ${icon} ${r.model.displayName.padEnd(28)}${schoolTag} ${C.gray}${mins} min${C.reset}${reason}`);
  }

  console.log(`\n  ${C.gray}Rapports : Export-Rapports/<date>/<ecole>/<niveau>/rapport_v3_*.md${C.reset}`);
  console.log(`  ${C.gray}Classement : Export-Rapports/classement.html (et classement.md)${C.reset}`);
  console.log(`  ${C.gray}Logs : logs/benchgo_*.log${C.reset}\n`);

  process.exit(0);
}

// Export des fonctions réutilisables par d'autres modules (notamment
// leaderboard.js affiche les modèles LM Studio non testés dans le CLI).
// main() n'est lancé que lorsqu'on exécute ce script directement.
module.exports = {
  listLlmModels,
  matchLedger,
  normalizeForMatch,
  SCHOOLS,
  ECOLE_NAME_TO_KEY,
  runLms,
  statusBadge,
  missingSchoolsLabel,
  schoolForModel,
  schoolLabelForModel,
  schoolsForModelPlan,
  isAutoPerModel,
  isManualPerModel,
  isMtpModel,
  buildMtpAssociations,
  isNonLlmModel,
  loadBlacklist,
  saveBlacklist,
  loadRunHistory,
  saveRunHistory,
  recordRun,
  runStatusFromHistory
};

if (require.main === module) {
  main().catch(e => {
    console.error(`\n${C.red}[ERREUR FATALE night-batch]${C.reset} ${e.message}`);
    console.error(e.stack);
    try { unloadAll(); } catch (_) {}
    process.exit(1);
  });
}