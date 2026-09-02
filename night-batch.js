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
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PROFILES, detectProfileFromModelName } = require('./config');
const { printEntryHelp, wantsHelp } = require('./cli-help');

const PROJECT_ROOT = __dirname;
const RUNNER = path.join(PROJECT_ROOT, 'runner.js');
const LMSTUDIO_HOST = 'http://localhost:1234';
const HTTP_TIMEOUT_MS = 4000;
const LEDGER_DIR = path.join(PROJECT_ROOT, 'Export-Rapports', '.carnet');

// --- Skip du modèle en cours (commande one-shot `--skip`) ---
// Ctrl+C reste réservé à l'arrêt COMPLET du batch (décharge des modèles + arrêt
// du serveur LM Studio) — comportement historique qu'il ne faut pas casser.
// Pour passer au modèle suivant SANS tout arrêter (modèle lent, verbeux,
// conversation sans intérêt), on écrit un fichier sentinelle depuis un
// SECOND terminal : `node night-batch.js --skip`. Le batch détecte la
// sentinelle (poll toutes les SKIP_POLL_MS), tue le runner en cours (kill de
// l'arbre du process enfant), consigne un résultat 'skipped' et enchaîne sur
// le modèle suivant. Aucune interaction stdin : le runner enfant tourne avec
// stdio 'inherit' et monopoliserait le clavier — la sentinelle fichier est le
// seul canal fiable cross-process sous Windows/PowerShell.
const SKIP_FILE = path.join(PROJECT_ROOT, '.benchgo-skip');
const SKIP_POLL_MS = 3000;
let _activeRunner = null; // child_process du runner en cours (null si aucun)

function skipRequested() {
  try { return fs.existsSync(SKIP_FILE); }
  catch (_) { return false; }
}

function consumeSkip() {
  try { fs.unlinkSync(SKIP_FILE); } catch (_) {}
}

// Kill de l'arbre du runner enfant (Windows : taskkill /T /F sinon SIGTERM).
function killActiveRunner() {
  if (!_activeRunner || _activeRunner.killed || _activeRunner.exitCode !== null) return false;
  const pid = _activeRunner.pid;
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    } else {
      try { _activeRunner.kill('SIGTERM'); } catch (_) {}
    }
  } catch (_) {}
  return true;
}

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
  { key: 'STANDARD', label: 'College-Lycee (3B - <15B)',  cli: 'STANDARD' },
  { key: 'EXPERT',   label: 'Universite (15B - 30B)',     cli: 'EXPERT' },
  { key: 'DOCTORAT', label: 'These (> 30B)',               cli: 'DOCTORAT' },
  { key: 'auto',     label: 'Auto-detection (1 ecole)',   cli: null },
  // Mode auto-par-modele : chaque modele passe UNIQUEMENT l'ecole adaptee a
  // sa taille de parametres (detectee via detectProfileFromModelName). Permet de
  // melanger des modeles de tailles differentes dans une meme session de nuit
  // (un 3B fait Primaire, un 15B fait College-Lycee, etc.) sans selectionner
  // manuellement l'ecole de chacun. cli=null : l'ecole est calculee par modele.
  { key: 'auto-per-model', label: 'Auto par modele (ecole selon la taille)', cli: null },
  // Mode manuel-par-modele : l'utilisateur choisit individuellement l'ecole de
  // chaque modele, un par un. Permet de melanger des modeles aux besoins
  // differents dans une meme session (ex: re-tester Kai Os Grug 12B en auto,
  // mais faire passer Phi 4 uniquement en Primaire). cli=null : les ecoles sont
  // choisies interactivement pour chaque modele.
  { key: 'manual-per-model', label: 'Manuel par modele (ecole choisie pour chacun)', cli: null },
  // Mode exercice-par-exercice (classe-par-classe) : l'utilisateur choisit
  // une école PUIS les exercices (tiers) qu'il veut faire passer.
  // Utile pour un filtre rapide : faire passer seulement le tier 0 à plusieurs
  // modèles pour éliminer les plus faibles avant un test complet.
  { key: 'tier-by-tier', label: 'Exercice par exercice (choisir les tiers)', cli: null }
];

// Détecte si la sélection d'écoles correspond au mode « auto par modèle »
// (option 6, key 'auto-per-model'). Dans ce mode, l'école de chaque modèle
// est calculée individuellement via schoolForModel() au lieu d'utiliser une
// liste globale d'écoles identique pour tous.
function isAutoPerModel(schools) {
  if (!schools) return false;
  return schools.some(s => s && s.key === 'auto-per-model');
}

// Détecte si la sélection d'écoles correspond au mode « exercice par exercice »
// (option 8, key 'tier-by-tier'). Dans ce mode, l'utilisateur choisit une école
// puis les exercices (tiers) qu'il veut tester. Utile pour un filtre rapide :
// faire passer seulement le tier 0 à plusieurs modèles, éliminer les faibles.
function isTierByTier(schools) {
  if (!schools) return false;
  return schools.some(s => s && s.key === 'tier-by-tier');
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

// Keep-alive : LM Studio peut passer en veille / couper le serveur apres une
// periode d'inactivite. En mode nuit (runs de plusieurs heures), cette coupure
// survient en plein benchmark et se traduit par des reponses vides ou des
// timeouts — signatures "modele silencieux" qui declenchent a tort
// l'auto-blacklist. On maintient le serveur actif en envoyant un ping leger
// (GET /v1/models, sans generation, donc sans toucher au GPU ni aux modeles
// charges) a intervalle regulier pendant toute la duree du batch.
const SERVER_KEEPALIVE_MS = 30000;
let keepAliveTimer = null;

async function keepAliveTick() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${LMSTUDIO_HOST}/v1/models`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) {
      console.log(`  ${C.yellow}[keep-alive] Attention : /v1/models a repondu HTTP ${res.status}.${C.reset}`);
    }
  } catch (e) {
    const label = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message ? e.message : 'injoignable');
    console.log(`  ${C.yellow}[keep-alive] Serveur LM Studio ${label} — verifiez qu'il n'est pas en veille.${C.reset}`);
  }
}

function startServerKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(keepAliveTick, SERVER_KEEPALIVE_MS);
  if (keepAliveTimer.unref) keepAliveTimer.unref();
  console.log(`  ${C.gray}Keep-alive serveur actif (ping /v1/models toutes les ${SERVER_KEEPALIVE_MS / 1000}s).${C.reset}`);
}

function stopServerKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
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

// --- Forçage de l'index LM Studio (détection des modèles non indexés) ---
// Quand lms ls ne renvoie pas tous les GGUF présents sur disque (indexation en
// cache désynchronisée de l'UI), cette fonction scanne le dossier physique des
// modèles, repère les GGUF orphelins (présents sur disque mais absents de lms
// ls) et les réimporter via `lms import --symbolic-link -y`. Le lien symbolique
// préserve le fichier d'origine (aucun déplacement ni copie).
//
// Dossier scanné : ~/.lmstudio/models (chemin standard de LM Studio). Les
// fichiers mmproj-*.gguf (projets multimodaux) et mtp-* sont exclus du scan :
// ils ne sont pas des modèles testables seuls (dépendances accessoires d'un
// modèle principal déjà indexé avec lui).
const LMSTUDIO_MODELS_DIR = path.join(os.homedir(), '.lmstudio', 'models');

// Liste les fichiers .gguf présents sur disque dans le dossier des modèles LM
// Studio. Retourne un tableau de chemins absolus vers des GGUF candidats à
// l'import (on exclut les mmproj et mtp qui ne sont pas des LLM autonomes).
function listGgufOnDisk() {
  const out = [];
  if (!fs.existsSync(LMSTUDIO_MODELS_DIR)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(LMSTUDIO_MODELS_DIR, { withFileTypes: true, recursive: true });
  } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name || '';
    if (!/\.gguf$/i.test(name)) continue;
    // Exclut les projets multimodaux (mmproj-*) et les modules MTP (mtp-*).
    // Ce ne sont pas des LLM autonomes : les importer seuls polluerait l'index.
    if (/^mmproj-/i.test(name) || /^mtp-/i.test(name)) continue;
    out.push(path.join(e.parentPath || '', name));
  }
  return out;
}

// Détermine si un fichier GGUF sur disque est déjà indexé par lms ls. Compare
// le basename (sans extension) du fichier aux modelKeys et displayNames déjà
// connus. Retourne true si un indice de correspondance est trouvé.
function ggufAlreadyIndexed(ggufPath, lmsEntries) {
  const base = path.basename(ggufPath, '.gguf').toLowerCase();
  if (!base) return false;
  for (const e of lmsEntries) {
    const cands = [e.modelKey, e.displayName, e.path].filter(Boolean).map(s => s.toLowerCase());
    for (const c of cands) {
      if (!c) continue;
      const cBase = path.basename(c.replace(/\\/g, '/').split('/').pop() || c, '.gguf');
      if (cBase === base) return true;
      if (c.includes(base) || base.includes(cBase)) return true;
    }
  }
  return false;
}

// Force la réindexation des modèles GGUF orphelins : scanne le dossier physique,
// repère les GGUF absents de lms ls, et les réimporte via lms import (lien
// symbolique, -y pour confirmer automatiquement). Retourne un rapport
// { scanned, orphans, imported, failed, errors[] }.
//
// Cette fonction est appelée explicitement par l'utilisateur (flag
// --force-detect ou commande "detect" dans la sélection interactive). Elle ne
// réimporter QUE les orphelins — les modèles déjà indexés ne sont pas touchés.
function forceDetectModels() {
  const report = { scanned: 0, orphans: 0, imported: 0, failed: 0, errors: [] };
  // Récupère l'index courant via lms ls --json --llm (tous les modèles, pas
  // seulement les LLM : on veut comparer aussi les éventuels embeddings déjà
  // indexés pour ne pas les réimporter inutilement).
  const raw = runLms(['ls', '--json'], { timeoutMs: 30000 });
  let lmsEntries = [];
  if (raw.status === 0 && raw.stdout) {
    try {
      const arr = JSON.parse(raw.stdout);
      if (Array.isArray(arr)) lmsEntries = arr;
    } catch (_) { /* index illisible : on considère tout comme orphelin */ }
  }
  const onDisk = listGgufOnDisk();
  report.scanned = onDisk.length;
  const orphans = onDisk.filter(p => !ggufAlreadyIndexed(p, lmsEntries));
  report.orphans = orphans.length;
  if (orphans.length === 0) return report;
  // Réimporter chaque orphelin via lms import --symbolic-link -y. Le lien
  // symbolique ne déplace pas le fichier : l'original reste intact.
  for (const p of orphans) {
    const baseName = path.basename(p);
    const r = runLms(['import', '--symbolic-link', '-y', p], { timeoutMs: 60000 });
    if (r.status === 0) {
      report.imported++;
      console.log(`  ${C.green}→ ${baseName} importé (lien symbolique)${C.reset}`);
    } else {
      report.failed++;
      const msg = `${baseName}: ${(r.stderr || 'import échoué').slice(0, 120)}`;
      report.errors.push(msg);
      console.log(`  ${C.red}✘ ${msg}${C.reset}`);
    }
  }
  return report;
}

// --- Détection des carnets orphelins (modèles supprimés de LM Studio) ---
// Quand un modèle est supprimé de LM Studio (UI ou suppression du GGUF), son
// carnet .json persiste dans Export-Rapports/.carnet/. Le classement continue
// alors de l'afficher comme s'il existait encore — trompeur pour l'utilisateur
// qui croit que le modèle est toujours disponible.
//
// Cette fonction compare les carnets existants à la liste lms ls et renvoie
// les modelKeys de carnets dont le modèle n'est plus présent sur disque.
//
// On exclut les carnets cloud (isCloud=true) : ces modèles ne dépendent pas de
// LM Studio, ils sont testés via des API distantes (OpenRouter, OpenAI...).
// Un carnet cloud reste valide même si le modèle n'est pas dans lms ls.
//
// @returns { orphanLedgers: [{file, model, shortName}], lmsKeys: Set<string> }
//   orphanLedgers : carnets locaux sans modèle correspondant dans lms ls.
//   lmsKeys       : ensemble des modelKeys connus de lms ls (pour d'autres usages).
function detectOrphanLedgers() {
  const ledgers = loadAllLedgers();
  const r = runLms(['ls', '--json'], { timeoutMs: 30000 });
  let lmsEntries = [];
  if (r.status === 0 && r.stdout) {
    try {
      const arr = JSON.parse(r.stdout);
      if (Array.isArray(arr)) lmsEntries = arr;
    } catch (_) { /* index illisible : on ne peut pas détecter les orphelins */ }
  }
  // Construit un set de modelKeys normalisés + displayNames connus de lms ls.
  const lmsKeys = new Set();
  const lmsDisplayNames = new Set();
  for (const e of lmsEntries) {
    if (e.modelKey) lmsKeys.add(e.modelKey);
    if (e.displayName) lmsDisplayNames.add(String(e.displayName).toLowerCase());
  }
  const orphanLedgers = [];
  for (const l of ledgers) {
    // Les carnets cloud ne dépendent pas de LM Studio → jamais orphelins.
    // On NE se fie PAS au champ isCloud brut du carnet : les carnets écrits par
    // night-batch (--provider=lmstudio) portent isCloud=true à tort (bug
    // 2026-08-26). On déduit le cloud depuis le provider : local, lmstudio,
    // ollama et custom sont LOCAUX ; tout autre provider est cloud.
    const prov = (l.raw && l.raw.provider ? String(l.raw.provider).toLowerCase() : null);
    const isLocalProvider = !prov || ['local', 'lmstudio', 'ollama', 'custom'].includes(prov);
    if (!isLocalProvider) continue;
    // Si le carnet matche un modelKey connu de lms ls, il n'est pas orphelin.
    // On teste via matchLedger (même logique que le reste de BenchGo) pour
    // gérer les variantes de nommage (quantif dans shortName, suffixes...).
    const matched = lmsEntries.some(e => {
      if (!e.modelKey) return false;
      const ml = matchLedger(e.modelKey, [l]);
      return ml !== null;
    });
    if (matched) continue;
    // Sinon, c'est un orphelin (modèle supprimé ou GGUF retiré du dossier).
    orphanLedgers.push({
      file: l.shortName || l.model || '?',
      model: l.model,
      shortName: l.shortName,
      quantization: l.quantization
    });
  }
  return { orphanLedgers, lmsKeys };
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

// Scan les NOMS de fichiers des rapports tier-by-tier (mode classe-par-classe)
// dans Export-Rapports/ et collecte les shortNames normalisés des modèles
// ayant au moins un rapport de tier. Seuls les noms de fichiers sont lus (pas
// le contenu) : le scan reste rapide même avec des semaines de rapports.
//
// But : distinguer un modèle « JAMAIS TESTÉ » réel d'un modèle testé par tiers
// mais sans carnet d'école complet. Les sessions tier-by-tier interrompues
// (Ctrl+C, timeout, tiers filtrés) ne passent jamais par le run "all" qui
// seul écrit le carnet → le modèle apparaissait à tort comme jamais testé
// (bug 2026-09-02). Les rapports de tiers sont la seule trace restante.
//
// Format des fichiers : rapport_v3_<shortName>_<profil>_tier<N>_<hh-mm-ss>.md
// ex: rapport_v3_ornith-1.5-9b_q4_k_m_standard_tier0_07-33-10.md
// Le shortName extrait contient le suffixe de quantification (ex: _q4_k_m).
const EXPORTS_ROOT = path.join(PROJECT_ROOT, 'Export-Rapports');
let _tierReportShortNamesCache = null;

function scanTierReportShortNames() {
  if (_tierReportShortNamesCache) return _tierReportShortNamesCache;
  const seen = new Set();
  try {
    if (fs.existsSync(EXPORTS_ROOT)) {
      for (const dateDir of fs.readdirSync(EXPORTS_ROOT)) {
        const datePath = path.join(EXPORTS_ROOT, dateDir);
        let stat;
        try { stat = fs.statSync(datePath); } catch (_) { continue; }
        if (!stat.isDirectory()) continue;
        if (dateDir.startsWith('.') || dateDir === '.carnet' || dateDir === '.carnet-backup') continue;
        for (const ecoleDir of fs.readdirSync(datePath)) {
          const ecolePath = path.join(datePath, ecoleDir);
          let st2;
          try { st2 = fs.statSync(ecolePath); } catch (_) { continue; }
          if (!st2.isDirectory()) continue;
          for (const classeDir of fs.readdirSync(ecolePath)) {
            const classePath = path.join(ecolePath, classeDir);
            let st3;
            try { st3 = fs.statSync(classePath); } catch (_) { continue; }
            if (!st3.isDirectory()) continue;
            for (const f of fs.readdirSync(classePath)) {
              const m = f.match(/^rapport_v3_(.+)_tier(\d+)_\d{2}-\d{2}-\d{2}\.md$/);
              if (!m) continue;
              // Le shortName capturé inclut le token de profil final
              // (ex: "..._standard") : on le retire.
              const sn = m[1].replace(/_(light|standard|expert|doctorat|frontier)$/i, '');
              if (sn) seen.add(normalizeForMatch(sn));
            }
          }
        }
      }
    }
  } catch (_) { /* Export-Rapports illisible : pas de repli, ensemble vide */ }
  _tierReportShortNamesCache = seen;
  return seen;
}

// Indique si des rapports de tiers existent pour un modelKey lms ls donné.
// Stratégie : égalité normalisée stricte (le shortName des rapports embarque
// la quantification, comme le modelKey) ; à défaut, inclusion du nom de base
// sans quantif (pour les modelKey lms sans @quant — le shortName du rapport
// porte alors un suffixe _quant que le modelKey n'a pas).
function modelHasTierReports(modelKey) {
  const seen = scanTierReportShortNames();
  if (seen.size === 0) return false;
  const nk = normalizeForMatch(modelKey);
  if (nk && seen.has(nk)) return true;
  const base = normalizeForMatch(String(modelKey || '').split('@')[0]);
  if (base && base.length >= 4) {
    for (const sn of seen) {
      if (sn.includes(base)) return true;
    }
  }
  return false;
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
    // Un fichier MTP n'a de sens que s'il peut etre associe a un modele
    // principal (via --speculative-draft-mtp). Si un modele "mtp" est orphelin
    // (seul dans son dossier, aucun modele principal candidat), c'est en
    // realite un modele principal complet (ex: Qwen3.6-27B-...-MTP qui est un
    // LLM de 17 Go, pas un module MTP accessoire). On garde donc les MTP
    // orphelins dans la liste des modeles testables.
    const associatedMtpKeys = new Set(mtpAssociations.values());
    const orphanMtpKeys = new Set(
      arr.filter(m => isMtpModel(m))
         .map(m => m.modelKey)
         .filter(k => !associatedMtpKeys.has(k))
    );
    const testable = arr.filter(m => !isMtpModel(m) || orphanMtpKeys.has(m.modelKey));
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
          // Bug 2026-09-02 : un modèle peut avoir été réellement testé (run
          // historique OK, ou rapports de tiers sur disque) sans qu'aucun
          // carnet d'école n'ait été écrit — sessions tier-by-tier avec
          // filtre, interruption Ctrl+C, ou tiers obligatoire échoué avant
          // le fix de consolidation. L'afficher « JAMAIS TESTÉ » est faux et
          // pousse à retester un modèle déjà passé. On le classe PARTIEL
          // sans école validée, avec la raison explicite.
          const histEntry = runHistory[modelKey] || null;
          const hasTierReports = modelHasTierReports(modelKey);
          if (histEntry || hasTierReports) {
            status = {
              kind: 'partial', tested: [], missing: relevantKeys.slice(),
              quant: ledger ? ledger.quantization : null,
              // Raison compacte : affichée telle quelle dans la colonne
              // « Écoles manquantes » (largeur calculée sur ces labels).
              reason: 'Tiers testés, carnet absent',
              lastAttempt: histEntry ? histEntry.lastAttempt : null,
              noCarnet: true
            };
          } else {
            status = { kind: 'never', tested: [], missing: relevantKeys.slice(), quant: ledger ? ledger.quantization : null };
          }
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

// Affiche le tableau des modèles (en-têtes + lignes). Fonction utilitaire
// partagée entre le mode interactif (selectModelsInteractive) et le mode
// --list-only (affichage seul, sans prompt). Le paramètre `interactive` ajoute
// les lignes d'aide (syntaxe de sélection, commandes !/!!/tok/detect) qui n'ont
// pas de sens en mode --list-only.
function printModelsList(models, { interactive = true } = {}) {
  console.log(`\n  ${C.bold}${C.cyan}=== MODELES LLM TELECHARGES ===${C.reset}`);
  if (interactive) {
    console.log(`  ${C.gray}Selectionnez les modeles a tester cette nuit.${C.reset}`);
    console.log(`  ${C.gray}Syntaxe : numeros separes par les virgules (ex: 1,3,5) ou "all".${C.reset}`);
    console.log(`  ${C.gray}Ordre : modeles testes du plus fort au plus faible, puis jamais testes, puis non-LLM a la fin.${C.reset}`);
    console.log(`  ${C.gray}Astuce : le dernier des testes est le plus faible — un bon candidat au retrait.${C.reset}`);
    console.log(`  ${C.gray}Isoler un modele non-LLM : !<num> (ex: !7) — le marque NON APPLICABLE et l'exclut.${C.reset}`);
    console.log(`  ${C.gray}Désisoler : !!<num> — retire un modele de la liste noire manuelle.${C.reset}`);
    console.log(`  ${C.gray}Tri par tokens (verbeux en haut) : tape "tok" puis Entrée — repère les modèles qui écrivent trop.${C.reset}`);
    console.log(`  ${C.gray}Forcer la détection (modèles manquants) : tape "detect" — réindexe les GGUF orphelins via lms import.${C.reset}\n`);
  } else {
    console.log(`  ${C.gray}Mode --list-only : affichage seul (aucun test lancé).${C.reset}`);
    console.log(`  ${C.gray}Ordre : modeles testes du plus fort au plus faible, puis jamais testes, puis non-LLM a la fin.${C.reset}\n`);
  }

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
  //
  // IMPORTANT sur le padding : certaines valeurs sont enveloppees de codes ANSI
  // (couleur). On ne peut PAS faire .padEnd/.padStart sur la chaine coloree car
  // String.length compte les codes ANSI invisibles (ex: '\x1b[90m=\x1b[0m' a
  // une longueur de 10 mais 1 seul caractere visible). La regle : toujours
  // padder le TEXTE SIMPLE puis appliquer la couleur autour, ou utiliser la
  // fonction pad() qui calcule la longueur visible et ajoute les espaces
  // manquants APRES les codes ANSI.
  const visLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  // padRight/padLeft : remplissent a largeur fixe en tenant compte des ANSI.
  const padRight = (s, w) => { const v = visLen(s); return v >= w ? s : s + ' '.repeat(w - v); };
  const padLeft = (s, w) => { const v = visLen(s); return v >= w ? s : ' '.repeat(w - v) + s; };

  const colIdx = String(models.length) + '.';
  const idxW = Math.max(4, colIdx.length + 1);
  const nameW = Math.max(30, ...models.map(m => (m.displayName || '').length));
  const paramW = Math.max(5, ...models.map(m => (m.params || '?').length));
  const quantW = Math.max(7, ...models.map(m => (m.quant || '?').length));
  const sizeW = Math.max(8, ...models.map(m => fmtBytes(m.size).length));
  const pubW = Math.max(14, ...models.map(m => (m.publisher || '?').length));
  const statusW = 15; // COMPLET / PARTIEL / JAMAIS TESTE / NON APPLICABLE — fixe
  const pctW = 5;
  // Largeur de la colonne vitesse : dynamique pour ne pas deborder sur les
  // valeurs longues (ex: '16.29 t/s' = 9 chars). On inclut l'unite 't/s' et
  // jusqu'a 2 decimales. Header 'Vit.' = 4.
  const tpsW = Math.max(9, ...models.map(m => {
    const mt = m.metrics;
    return mt && mt.tokensPerSecond > 0 ? (mt.tokensPerSecond + ' t/s').length : 0;
  }));
  const tokW = Math.max(7, ...models.map(m => {
    const mt = m.metrics;
    return mt && (mt.tokens || 0) > 0 ? fmtTokens(mt.tokens).length : 0;
  }));
  const attW = 5;
  const trendW = 4;
  const timeW = Math.max(8, ...models.map(m => {
    const mt = m.metrics;
    return mt && mt.elapsedMs > 0 ? fmtDuration(mt.elapsedMs).length : 0;
  }));
  const missW = Math.max(22, ...models.map(m => (m.status.noCarnet && m.status.reason)
    ? m.status.reason.length
    : (missingSchoolsLabel(m.status) || '').length));

  // Séparateurs visuels entre groupes de colonnes. '│' delimite les groupes
  // logiques : Identité | Statut | Performance | Reste à faire.
  const SEP = '│';
  // En-tête : groupes de colonnes separes par '│' pour structurer visuellement.
  //   Groupe Identité : idx, Modèle, Param, Quant, Taille, Editeur
  //   Groupe Statut   : Statut, Pct, Tnd
  //   Groupe Perf     : Vit., Tokens, Temps, Tent.
  //   Groupe Reste    : Écoles manquantes
  const hdrIdx = ' '.repeat(idxW);
  const header =
    `  ${hdrIdx} ` +
    `${padRight('Modèle', nameW)} ` +
    `${padRight('Param', paramW)} ` +
    `${padRight('Quant', quantW)} ` +
    `${padLeft('Taille', sizeW)} ` +
    `${padRight('Editeur', pubW)} ${SEP} ` +
    `${padRight('Statut', statusW)} ` +
    `${padLeft('Pct', pctW)} ` +
    `${padRight('Tnd', trendW)} ${SEP} ` +
    `${padLeft('Vit.', tpsW)} ` +
    `${padLeft('Tokens', tokW)} ` +
    `${padLeft('Temps', timeW)} ` +
    `${padLeft('Tent.', attW)} ${SEP} ` +
    `${padRight('Ecoles manquantes', missW)}`;
  console.log(`${C.gray}${header}${C.reset}`);
  // Largeur du séparateur = largeur visible d'une ligne de données SANS les 2
  // espaces d'indentation initiaux (le sep est imprimé préfixé de '  ').
  // Somme des colonnes + 19 (16 espaces inter-colonnes + 3 séparateurs '│').
  const sepLen = idxW + nameW + paramW + quantW + sizeW + pubW +
                 statusW + pctW + trendW + tpsW + tokW + timeW + attW +
                 missW + 19;
  const sep = '─'.repeat(sepLen);
  console.log(`${C.gray}  ${sep}${C.reset}`);
  models.forEach((m, i) => {
    const idx = String(i + 1).padStart(Math.max(2, idxW - 1)) + '.';
    const sz = padLeft(fmtBytes(m.size), sizeW);
    const badge = statusBadge(m.status);
    // Statut : padEnd sur le label SIMPLE puis couleur autour → largeur visible stable.
    const statusStr = `${badge.color}${badge.label.padEnd(statusW)}${C.reset}`;
    const missing = missingSchoolsLabel(m.status);
    // Modèles « PARTIEL sans carnet » (bug 2026-09-02) : la liste des écoles
    // manquantes liste TOUTES les écoles (aucune validée) — on affiche plutôt
    // la raison compacte pour expliquer le PARTIEL.
    const missStr = missing && !m.status.noCarnet
      ? `${C.gray}${missing.padEnd(missW)}${C.reset}`
      : m.status.reason
        ? `${C.gray}${m.status.reason.slice(0, missW).padEnd(missW)}${C.reset}`
        : ' '.repeat(missW);
    const mtpTag = m.mtpModelKey ? `${C.cyan}[MTP]${C.reset} ` : '';
    const namePad = nameW - (mtpTag ? 6 : 0);
    const nameRaw = (m.displayName || '').slice(0, namePad);
    const name = padRight(`${nameRaw.padEnd(namePad)}${mtpTag}`, nameW);
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
    // Tendance : la glyphe est colore. On padde en tenant compte des ANSI via
    // padRight, sinon .padEnd(trendW) ne ferait rien (la longueur avec ANSI > trendW).
    const trendStr = mt ? padRight(trendGlyph(mt.trend), trendW) : `${C.gray}${padRight('\u2014', trendW)}${C.reset}`;
    const timeStr = mt && mt.elapsedMs > 0
      ? `${fmtDuration(mt.elapsedMs).padStart(timeW)}`
      : `${C.gray}${'\u2014'.padStart(timeW)}${C.reset}`;
    // Ligne de données : mêmes séparateurs '│' que l'en-tête, même espacement.
    console.log(
      `  ${C.bold}${idx}${C.reset} ` +
      `${name} ` +
      `${C.gray}${params} ${quant}${C.reset} ` +
      `${sz} ` +
      `${C.gray}${pub}${C.reset} ${SEP} ` +
      `${statusStr} ` +
      `${pctStr} ` +
      `${trendStr} ${SEP} ` +
      `${tpsStr} ` +
      `${tokStr} ` +
      `${timeStr} ` +
      `${attStr} ${SEP} ` +
      `${missStr}`
    );
  });
  console.log('');
}

// Selection interactive des modeles. Affiche le tableau via printModelsList puis
// attend la saisie de l'utilisateur (numéros, "all", commandes !/!!/tok/detect).
async function selectModelsInteractive(models) {
  printModelsList(models, { interactive: true });
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
      // Commande "detect" : force la réindexation des GGUF orphelins (présents
      // sur disque mais absents de lms ls) via lms import. Recharge ensuite la
      // liste depuis lms ls pour refléter les nouveaux modèles.
      if (raw === 'detect' || raw === 'force-detect') {
        console.log(`\n  ${C.bold}${C.yellow}=== FORÇAGE DE LA DÉTECTION LM STUDIO ===${C.reset}`);
        console.log(`  ${C.gray}Scan du dossier ${LMSTUDIO_MODELS_DIR}${C.reset}`);
        const rep = forceDetectModels();
        console.log(`  ${C.gray}${rep.scanned} GGUF scanné(s), ${rep.orphans} orphelin(s), ${rep.imported} importé(s), ${rep.failed} échec(s).${C.reset}`);
        if (rep.imported > 0) {
          console.log(`  ${C.green}${rep.imported} modèle(s) réindexé(s). Rechargement de la liste...${C.reset}`);
          const { ok, models: fresh, error } = listLlmModels();
          if (ok && fresh.length > 0) {
            console.log(`  ${C.green}Nouvelle liste : ${fresh.length} modèle(s) LLM détecté(s).${C.reset}\n`);
            resolve(selectModelsInteractive(fresh));
            return;
          }
          console.log(`  ${C.yellow}Rechargement impossible (${error || 'lms indisponible'}). La liste courante reste affichée.${C.reset}`);
        } else if (rep.orphans === 0) {
          console.log(`  ${C.green}Aucun GGUF orphelin : tous les modèles sont déjà indexés par lms ls.${C.reset}`);
        }
        console.log('');
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
      else if (sz < 15) detected = 'STANDARD';
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
// Helper interactif : pose une question sur stdin, attend la réponse, ferme.
// Évite les problèmes de readline multiples sur Windows.
function ask(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function selectSchoolsInteractive(selectedModels) {
  console.log(`\n  ${C.bold}${C.cyan}=== ÉCOLES À TESTER ===${C.reset}`);
  console.log(`  ${C.gray}Sélectionnez les écoles à faire passer à chaque modèle.${C.reset}`);
  console.log(`  ${C.gray}Syntaxe : numéros séparés par des virgules (ex: 1,2) ou "all".${C.reset}\n`);

  // --- Écoles (1-4) : un niveau scolaire appliqué identiquement à TOUS les modèles ---
  console.log(`  ${C.bold}── Écoles (un niveau fixe pour toute la file) ──${C.reset}`);
  console.log(`  ${C.gray}Tous les modèles passent le(s) même(s) niveau(x).${C.reset}\n`);
  SCHOOLS.slice(0, 4).forEach((s, i) => {
    const idx = String(i + 1).padStart(2);
    console.log(`  ${C.bold}${idx}.${C.reset} ${s.label}`);
  });

  // --- Modes d'attribution (5-7) : le niveau est déterminé par modèle ---
  console.log(`\n  ${C.bold}── Modes d'attribution (le niveau dépend du modèle) ──${C.reset}`);
  console.log(`  ${C.gray}Au lieu d'imposer le même niveau à tous, chaque modèle${C.reset}`);
  console.log(`  ${C.gray}reçoit le sien selon la stratégie choisie ci-dessous.${C.reset}\n`);

  console.log(`  ${C.bold} 5.${C.reset} ${C.bold}Auto-detection${C.reset} ${C.gray}— 1 école par modèle${C.reset}`);
  console.log(`      ${C.gray}Le runner devine le profil depuis le nom du modèle.${C.reset}`);
  console.log(`      ${C.gray}Ex: «Qwen3 4B» → Collège-Lycée. Pas d'enchaînement.${C.reset}\n`);

  console.log(`  ${C.bold} 6.${C.reset} ${C.bold}Auto par modèle${C.reset} ${C.gray}— école selon la taille${C.reset}`);
  console.log(`      ${C.gray}Chaque modèle passe l'école adaptée à ses paramètres.${C.reset}`);
  console.log(`      ${C.gray}< 3B → Primaire  |  3B–15B → Collège-Lycée  |  etc.${C.reset}`);
  console.log(`      ${C.gray}Modèles > 3B : enchaîne Primaire puis l'école détectée.${C.reset}`);
  console.log(`      ${C.gray}Idéal quand la file mélange des tailles différentes.${C.reset}\n`);

  console.log(`  ${C.bold} 7.${C.reset} ${C.bold}Manuel par modèle${C.reset} ${C.gray}— vous choisissez pour chacun${C.reset}`);
  console.log(`      ${C.gray}L'école de chaque modèle est saisie individuellement.${C.reset}`);
  console.log(`      ${C.gray}Ex: un 12B en Collège-Lycée, un 4B en Primaire seulement.${C.reset}`);
  console.log(`      ${C.gray}Permet de mélanger des stratégies dans la même session.${C.reset}\n`);

  // NOTE : l'ancienne option 8 (« Exercice par exercice ») a été supprimée du menu
  // car elle était noyée parmi 8 choix et l'utilisateur la sautait systématiquement.
  // Désormais, le choix des exercices (tiers) est proposé AUTOMATIQUEMENT à l'étape
  // suivante, juste après le choix des écoles — voir « Exercices à exécuter » plus
  // bas. C'est l'équivalent de l'ancienne option 8, mais intégré au flux normal.

  // Aperçu de l'attribution auto-par-modèle (option 6) pour aider l'utilisateur
  // à anticiper : montre quelles écoles chaque modèle sélectionné ferait.
  // Les modèles > 3B enchaînent Primaire (LIGHT) puis l'école détectée.
  if (selectedModels && selectedModels.length > 0) {
    console.log(`  ${C.gray}Aperçu option 6 :${C.reset}`);
    for (const m of selectedModels) {
      const schoolsList = schoolsForModelPlan(m);
      const labels = schoolsList.map(s => s.label).join(' → ');
      console.log(`  ${C.gray}  ${m.displayName.padEnd(30)} → ${labels}${C.reset}`);
    }
    console.log('');
  }

  const rawSchools = await ask(`  ${C.cyan}Écoles à tester :${C.reset} `);
  let schools;
  if (rawSchools.toLowerCase() === 'all' || rawSchools === '*') {
    schools = SCHOOLS.filter(s => s.cli !== null);
  } else {
    const indices = rawSchools.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= SCHOOLS.length);
    const uniq = [...new Set(indices.map(n => n - 1))];
    schools = uniq.map(i => SCHOOLS[i]);
  }

  // --- Compatibilité : si l'utilisateur tape 8 (ancien mode tier-by-tier),
  // on le redirige vers le flux normal ci-dessous (mode classe-par-classe +
  // choix des tiers). L'ancien bloc isTierByTier est supprimé.
  if (isTierByTier(schools)) {
    // On retire le marqueur tier-by-tier de schools pour éviter qu'il ne
    // pollue la suite (isTierByTier ne sera plus vrai). L'utilisateur devra
    // choisir une école réelle (1-4) dans le flux normal.
    schools = schools.filter(s => s.key !== 'tier-by-tier');
    if (schools.length === 0) {
      console.log(`  ${C.yellow}L'option 8 a été intégrée au flux normal. Choisissez une école (1-4) ci-dessous.${C.reset}`);
      return selectSchoolsInteractive(selectedModels);
    }
  }

  // --- Option 7 : manuel par modèle ---
  // On demande l'école de chaque modèle INDIVIDUELLEMENT dès maintenant, AVANT
  // les questions de mode d'exécution / tiers / passage. Logique : l'utilisateur
  // a choisi l'option 7 → il s'attend à saisir les écoles de ses modèles
  // immédiatement, pas après 3 autres questions. Le plan manuel est retourné
  // dans le résultat pour que main() l'utilise tel quel (sans le redemander).
  let manualPlan = null;
  if (isManualPerModel(schools)) {
    manualPlan = await selectSchoolsManualPerModel(selectedModels);
  }

  // --- Mode d'exécution : classique ou classe-par-classe ---
  console.log(`\n  ${C.bold}── Mode d'exécution ──${C.reset}`);
  console.log(`  ${C.gray}Comment lancer chaque école ?${C.reset}\n`);
  console.log(`  ${C.bold} A.${C.reset} ${C.bold}Classique${C.reset} ${C.gray}— toute l'école d'un coup${C.reset}`);
  console.log(`      ${C.gray}Un seul process pour toute l'école. Plus rapide.${C.reset}`);
  console.log(`      ${C.gray}Inconvénient : si le modèle gèle, tout le batch bloque.${C.reset}\n`);
  console.log(`  ${C.bold} B.${C.reset} ${C.bold}Exercice par exercice${C.reset} ${C.gray}— un exercice à la fois${C.reset}`);
  console.log(`      ${C.gray}Chaque exercice (tier) dans un process séparé, timeout 45 min.${C.reset}`);
  console.log(`      ${C.gray}Si un exercice gèle : kill auto, passage au suivant.${C.reset}`);
  console.log(`      ${C.gray}Vous pourrez choisir quels exercices (tiers) tester.${C.reset}`);
  console.log(`      ${C.gray}Recommandé pour le mode nuit (robustesse maximale).${C.reset}\n`);
  const modeAnswer = (await ask(`  ${C.cyan}Mode d'exécution [A/B] (défaut B) :${C.reset} `)).toLowerCase();
  const cbc = modeAnswer !== 'a';

  // --- Sélection des tiers (exercices) à exécuter ---
  // En mode classe-par-classe (B), on propose SYSTÉMATIQUEMENT le choix des
  // exercices (tiers). C'est l'équivalent de l'ancienne option 8, mais intégré
  // au flux normal : l'utilisateur n'a plus à taper « 8 » pour y accéder.
  let tierFilter = null;
  if (cbc) {
    console.log(`  ${C.gray}→ Exercice par exercice : chaque tier isolé (timeout ${TIER_TIMEOUT_MS / 60000} min/tier).${C.reset}`);
    console.log(`\n  ${C.bold}── Exercices à exécuter ──${C.reset}`);
    console.log(`  ${C.gray}Quels exercices (tiers) lancer ?${C.reset}`);
    console.log(`  ${C.gray}Entrée = tous les exercices (défaut).${C.reset}`);
    console.log(`  ${C.gray}Numéros séparés par virgules (ex: "0" = 1er exercice, "0,1" = 2 premiers).${C.reset}`);
    console.log(`  ${C.gray}Idéal pour trier les modèles faibles : si un modèle échoue${C.reset}`);
    console.log(`  ${C.gray}au 1er exercice, il part à la poubelle sans perdre de temps.${C.reset}`);
    const tierAnswer = await ask(`  ${C.cyan}Tiers à exécuter (défaut = tous) :${C.reset} `);
    if (tierAnswer) {
      const nums = tierAnswer.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 0);
      if (nums.length > 0) {
        tierFilter = [...new Set(nums)];
        console.log(`  ${C.gray}→ Tiers sélectionnés : ${tierFilter.join(', ')}${C.reset}`);
      }
    }
    if (!tierFilter) {
      console.log(`  ${C.gray}→ Tous les tiers seront exécutés.${C.reset}`);
    }

    // --- Mode de passage (auto/manuel) ---
    console.log(`\n  ${C.bold}── Mode de passage ──${C.reset}`);
    console.log(`  ${C.gray}A = Auto : passage au modèle suivant même si un modèle échoue ou gèle.${C.reset}`);
    console.log(`      ${C.gray}Chaque exercice a un timeout de 45 min (kill auto si gel).${C.reset}`);
    console.log(`  ${C.gray}M = Manuel : arrêt au premier modèle qui échoue (contrôle strict).${C.reset}`);
    console.log(`      ${C.gray}Un échec sur un tier obligatoire stoppe la file (pas de passage auto).${C.reset}\n`);
    const autoAnswer = (await ask(`  ${C.cyan}Mode de passage [A/M] (défaut A) :${C.reset} `)).toLowerCase();
    const stopOnFirstFailure = autoAnswer === 'm';
    if (!stopOnFirstFailure) {
      console.log(`  ${C.gray}→ Mode auto : passage au modèle suivant même en cas d'échec.${C.reset}`);
    } else {
      console.log(`  ${C.gray}→ Mode manuel : arrêt au premier échec obligatoire.${C.reset}`);
    }
    return { schools, classByClass: cbc, tierFilter, stopOnFirstFailure, manualPlan };
  } else {
    console.log(`  ${C.gray}→ Mode classique : école entière en un process.${C.reset}`);
  }

  return { schools, classByClass: cbc, tierFilter, manualPlan };
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
  // -y (--yes) : approuve automatiquement les prompts de lms load. Sans ce
  // flag, lms peut afficher un sélecteur interactif (« ? Select a model to
  // load ») qui bloque le batch en mode non-TTY (spawnSync hérite du stdin du
  // parent, mais lms utilise une TUI readline qui capture le terminal et
  // rend Ctrl+C très difficile à intercepter — l'utilisateur doit tuer le
  // process à la main). Avec -y, lms charge le modèle sans aucune interaction.
  const args = ['load', '-y', modelKey];
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

// --- Pré-test de santé (health check) ---
// Après un lms load réussi, le modèle est en mémoire mais on ne sait pas s'il
// est réellement capable de répondre. Un GGUF corrompu ou une architecture
// non supportée peut faire planter le moteur silencieusement : lms load
// renvoie status=0, mais le serveur HTTP ne répond plus (ou hang
// indéfiniment). C'est ce qui a causé le hang de 3h48 d'OpenCoder 8B : le
// modèle s'est chargé, puis a gelé sur le premier exercice.
//
// Le health check envoie une requête /v1/chat/completions triviale ("Reply
// with: OK") avec un timeout court (30 s). Si le modèle répond dans les
// temps, il est sain. Sinon, on le marque health_failed et on l'auto-
// blackliste pour éviter de retenter un modèle défectueux nuit après nuit.
const HEALTH_CHECK_TIMEOUT_MS = 30000;

async function healthCheck(modelKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    // max_tokens large (512) : les modèles de raisonnement (thinking)
    // consomment d'abord des tokens en phase de pensée (reasoning_content)
    // avant de produire la réponse (content). Avec un budget faible (ex: 8),
    // tout est consommé par le raisonnement → content vide → faux échec.
    // 512 tokens laisse largement assez pour raisonner puis répondre.
    const body = JSON.stringify({
      model: modelKey,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 512,
      temperature: 0,
      stream: false
    });
    const res = await fetch(`${LMSTUDIO_HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const data = await res.json();
    const choice = data && data.choices && data.choices[0];
    const msg = choice ? choice.message : null;
    const content = msg ? (msg.content || '') : '';
    // Modèles de raisonnement (thinking) : le modèle pense d'abord dans
    // reasoning_content, puis produit la réponse dans content. Avec un
    // max_tokens faible (8), tout le budget est consommé par le raisonnement
    // → content est vide mais reasoning_content est présent → finish_reason
    // = "length". Ce n'est PAS un gel : le modèle fonctionne, il a juste
    // besoin de plus de tokens. On accepte donc aussi reasoning_content non
    // vide comme preuve que le modèle est vivant.
    const reasoning = msg ? (msg.reasoning_content || '') : '';
    const finishReason = choice ? choice.finish_reason : null;
    if (!content && !reasoning) {
      return { ok: false, reason: 'Réponse vide (modèle silencieux)' };
    }
    // Si content est vide MAIS reasoning_content est présent, le modèle
    // pense activement (thinking). On le marque sain mais on note que la
    // réponse n'est pas encore produite (le runner donnera un budget plus
    // large).
    if (!content && reasoning) {
      return { ok: true, content: `[thinking] ${reasoning.slice(0, 40)}`, reasoning: true };
    }
    return { ok: true, content };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    return { ok: false, reason: aborted ? `Timeout (${HEALTH_CHECK_TIMEOUT_MS / 1000}s) — modèle gelé` : (e.message || 'erreur réseau') };
  }
}

// Auto-blacklist : ajoute le modelKey à .benchgo-blacklist.json et enregistre
// le statut dans l'historique des runs. L'utilisateur peut désisoler le modèle
// manuellement avec !!<num> dans la sélection interactive s'il pense que le
// problème est temporaire (ex: mise à jour du GGUF, nouvelle version llama.cpp).
function autoBlacklist(modelKey, reason) {
  const bl = loadBlacklist();
  if (bl.has(modelKey)) return false;
  bl.add(modelKey);
  saveBlacklist(bl);
  recordRun(modelKey, 'load_failed', null);
  console.log(`  ${C.yellow}Modèle ${modelKey} auto-blacklisté : ${reason}${C.reset}`);
  console.log(`  ${C.gray}Il sera ignoré dans les futurs batchs. Désisolez-le avec !!<num> si le GGUF a été corrigé.${C.reset}`);
  return true;
}

async function runBenchmark(modelKey, schoolCli, extraArgs, opts = {}) {
  // opts.tierNum : si défini, lance uniquement CE tier (mode classe-par-classe).
  //   Le runner supporte un argument positionnel = numéro de tier. On l'insère
  //   juste après --force et --profile. Ex : runner.js --force --profile=STANDARD 2
  // opts.timeoutMs : timeout global du spawn. 0 = pas de timeout (défaut).
  //   En mode classe-par-classe, on met un timeout par tier pour éviter qu'un
  //   modèle gelé bloque toute la nuit (bug constaté : un hang infini sur un
  //   tier arrêtait tout le batch sans jamais passer au modèle suivant).
  const { tierNum = null, timeoutMs = 0 } = opts;
  const args = ['runner.js', '--force', '--provider=lmstudio', `--model=${modelKey}`];
  if (schoolCli) args.push(`--profile=${schoolCli}`);
  if (tierNum !== null && tierNum !== undefined) args.push(String(tierNum));
  for (const a of extraArgs) args.push(a);
  const start = Date.now();
  const tierLabel = tierNum !== null && tierNum !== undefined ? ` (tier ${tierNum})` : '';
  console.log(`\n  ${C.magenta}> Lancement : node ${args.join(' ')}${tierLabel}${C.reset}\n`);
  // stdio: 'inherit' : la sortie du runner (spinner, exercice en cours, tokens,
  // score) est streamée EN TEMPS RÉEL sur le terminal du mode nuit. Avant, on
  // capturait stdout/stderr via spawnSync pour les réécrire à la fin — le
  // terminal restait muet pendant tout le benchmark (parfois 30+ min), sans
  // aucun feedback sur l'exercice en cours. L'utilisateur ne savait pas où en
  // était le modèle. Avec inherit, on voit exactement ce que runner.js affiche.
  //
  // spawn ASYNC (depuis 2026-09-02) : le batch doit rester réactif pendant le
  // run — poll de la sentinelle --skip (passage au modèle suivant) ET du
  // timeout global. L'ancien spawnSync bloquait l'event loop : impossible
  // d'interrompre un run sans tuer tout le batch (Ctrl+C historique).
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    windowsHide: false
  });
  _activeRunner = child;
  const result = await new Promise(resolve => {
    let settled = false;
    let killReason = null; // 'skip' | 'timeout' — déterministe (sur Windows,
    // taskkill /F ne produit PAS de signal SIGTERM visible : la détection du
    // timeout via signal==='SIGTERM' de l'ancien spawnSync ne marche pas ici).
    const finish = (r) => { if (!settled) { settled = true; clearInterval(pollTimer); resolve(r); } };
    // Poll : sentinelle --skip (kill arbre enfant) + timeout (kill aussi).
    // Interval (et non setTimeout) : la sentinelle doit être vérifiée
    // périodiquement PENDANT le run, pas seulement à son expiration.
    const pollTimer = setInterval(() => {
      if (skipRequested()) {
        killReason = 'skip';
        console.log(`\n  ${C.yellow}[--skip] Sentinelle détectée — interruption du run en cours...${C.reset}`);
        killActiveRunner();
        // finish() est déclenché par le handler 'exit' du child (kill async).
        return;
      }
      if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
        killReason = 'timeout';
        console.log(`\n  ${C.red}[TIMEOUT] ${Math.round(timeoutMs / 60000)} min atteintes — kill du run.${C.reset}`);
        killActiveRunner();
      }
    }, SKIP_POLL_MS);
    child.on('error', (err) => finish({ ok: false, status: null, durationMs: Date.now() - start, timedOut: false, skipped: false, error: err.message }));
    child.on('exit', (code, signal) => {
      const durationMs = Date.now() - start;
      finish({
        ok: code === 0, status: code, durationMs,
        timedOut: killReason === 'timeout',
        skipped: killReason === 'skip',
        signal
      });
    });
  });
  _activeRunner = null;
  // Consomme la sentinelle APRÈS le run pour ne pas la propager au modèle
  // suivant (le kill vient d'être consommé).
  consumeSkip();
  return result;
}

// --- Mode classe-par-classe (tâche 2026-08-11, Tasks1.md #2a) ---
// Au lieu de lancer toute une école d'un coup (node runner.js --profile=STANDARD
// --force, qui fait tous les tiers en séquence dans le même process), ce mode
// lance CHAQUE tier dans un process séparé : node runner.js --force
// --profile=STANDARD <tierNum>. Avantages :
//
//   1. REPRISE : si un tier crash ou timeout, on peut continuer le suivant au
//      lieu de perdre toute l'école. Le carnet conserve déjà les meilleurs
//      scores par école (pas par tier), mais en mode classe-par-classe chaque
//      tier réussi est sauvegardé individuellement dans le rapport.
//
//   2. TIMEOUT : chaque tier a son propre timeout (TIER_TIMEOUT_MS). Avant,
//      timeout=0 sur toute l'école → un modèle gelé (hang infini) bloquait le
//      batch entier nuit après nuit sans jamais passer au modèle suivant. C'est
//      la cause du « mode automatique perdu » : un tier gelé → spawnSync hang
//      indéfiniment → le script ne revient jamais à la boucle des modèles.
//
//   3. ISOLATION : un crash sur un tier n'empêche pas les autres tiers de
//      s'exécuter (process séparé = mémoire isolée).
//
// Inconvénient : l'auto-profilage est relancé à chaque tier (overhead de ~30s
// par tier). C'est un compromis acceptable en mode nuit (le temps n'est pas
// critique, la robustesse l'est).
//
// Retourne { ok, durationMs, tierResults: [{ tierNum, ok, timedOut, durationMs }] }.
// ok = true si tous les tiers obligatoires ont réussi (les optionnels échoués
// ne comptent pas comme échec global).
const TIER_TIMEOUT_MS = 45 * 60 * 1000; // 45 min par tier (sécurité anti-hang)

// --- Progression de reprise (--resume, tâche 2026-09-02) ---
// Fichier .benchgo-progress.json : mémorise, par modèle+école, les tiers déjà
// PASSÉS lors des sessions précédentes (mode classe-par-classe). Avec --resume,
// ces tiers sont ignorés et le batch reprend exactement là où il s'était
// arrêté (Ctrl+C, plantage, nuit trop courte) — puis la consolidation "all"
// écrit le carnet complet de l'école.
//
// Structure : { "<modelKey>|<schoolKey>": { "done": [<tiers>], "updatedAt": iso } }
const PROGRESS_FILE = path.join(PROJECT_ROOT, '.benchgo-progress.json');

function loadProgress() {
  try {
    const d = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    if (!d || typeof d !== 'object') return {};
    // Purge des entrées périmées (> 30 jours) : une progression ancienne n'a
    // plus de sens (tiers probablement modifiés depuis) et le fichier ne doit
    // pas croître indéfiniment avec des couples modèle|école obsolètes.
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    let purged = false;
    for (const k of Object.keys(d)) {
      const t = Date.parse(d[k] && d[k].updatedAt);
      if (!Number.isFinite(t) || t < cutoff) { delete d[k]; purged = true; }
    }
    if (purged) saveProgress(d);
    return d;
  } catch (_) { return {}; }
}

function saveProgress(progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8'); }
  catch (_) { /* non bloquant : la reprise est un confort, pas une garantie */ }
}

function progressKey(modelKey, schoolKey) {
  return `${modelKey}|${schoolKey}`;
}

function getProgressTiers(modelKey, schoolKey) {
  const p = loadProgress();
  const e = p[progressKey(modelKey, schoolKey)];
  return (e && Array.isArray(e.done)) ? e.done : [];
}

// Enregistre qu'un tier vient d'être exécuté (réussi OU échoué — dans les deux
// cas l'exercice a été passé et n'a pas à être rejoué en --resume). `failed`
// (timeout/kill) n'est PAS enregistré : un tier interrompu doit être rejoué.
function recordProgressTier(modelKey, schoolKey, tierNum) {
  const p = loadProgress();
  const k = progressKey(modelKey, schoolKey);
  const e = p[k] || { done: [] };
  if (!e.done.includes(tierNum)) e.done.push(tierNum);
  e.done.sort((a, b) => a - b);
  e.updatedAt = new Date().toISOString();
  p[k] = e;
  saveProgress(p);
}

// Nettoie l'entrée de progression quand l'école est FINIE (consolidation
// écrite ou stop) : une prochaine session --resume repartira de zéro si
// l'utilisateur RETESTE ce modèle/école (les carnets gardent l'historique).
function clearProgress(modelKey, schoolKey) {
  const p = loadProgress();
  const k = progressKey(modelKey, schoolKey);
  if (p[k]) { delete p[k]; saveProgress(p); }
}

async function runSchoolClassByClass(modelKey, schoolKey, schoolCli, extraArgs, tierFilter = null, stopOnFirstFailure = false, resumeTiersDone = null) {
  const profile = PROFILES[schoolKey];
  if (!profile) {
    console.log(`  ${C.red}Profil inconnu : ${schoolKey}${C.reset}`);
    return { ok: false, durationMs: 0, tierResults: [], stopped: false };
  }
  // Tous les tiers du profil (obligatoires + optionnels), triés.
  let tierNums = [...profile.mandatory, ...profile.optional].sort((a, b) => a - b);
  // Si l'utilisateur a demandé des tiers précis, on ne garde que ceux-là.
  // Permet de tester un seul exercice (ex: tier 0) pour un test rapide.
  if (tierFilter && Array.isArray(tierFilter) && tierFilter.length > 0) {
    tierNums = tierNums.filter(t => tierFilter.includes(t));
  }
  // --resume : saute les tiers déjà passés lors des sessions précédentes.
  // Si TOUT est déjà passé (remaining vide), la boucle ne fait rien et c'est
  // la consolidation qui prend le relais (si les obligatoires sont couverts
  // par l'union selection∪déjà-passés) — le carnet est enfin écrit.
  let skippedByResume = [];
  if (resumeTiersDone && Array.isArray(resumeTiersDone) && resumeTiersDone.length > 0) {
    skippedByResume = tierNums.filter(t => resumeTiersDone.includes(t));
    tierNums = tierNums.filter(t => !resumeTiersDone.includes(t));
  }
  const tierResults = [];
  const startMs = Date.now();
  let allMandatoryOk = true;
  let stopped = false;
  let skippedByUser = false;

  if (skippedByResume.length > 0) {
    console.log(`  ${C.green}[--resume] ${skippedByResume.length} tier(s) déjà passé(s) ignoré(s) : ${skippedByResume.join(', ')}${C.reset}`);
  }

  for (const tierNum of tierNums) {
    const isMandatory = profile.mandatory.includes(tierNum);
    const tierLabel = isMandatory ? `${C.bold}obligatoire${C.reset}` : `${C.gray}optionnel${C.reset}`;
    console.log(`\n  ${C.bold}${C.cyan}--- Classe tier ${tierNum} (${tierLabel}) ---${C.reset}`);
    const bench = await runBenchmark(modelKey, schoolCli, extraArgs, {
      tierNum,
      timeoutMs: TIER_TIMEOUT_MS
    });
    const mins = (bench.durationMs / 60000).toFixed(1);
    tierResults.push({ tierNum, ok: bench.ok, timedOut: bench.timedOut, durationMs: bench.durationMs });
    if (bench.timedOut) {
      console.log(`  ${C.red}[TIMEOUT] Tier ${tierNum} a dépassé ${TIER_TIMEOUT_MS / 60000} min — killé, passage au tier suivant.${C.reset}`);
    }
    console.log(`  ${bench.ok ? C.green : C.red}[${nowClock()}] Tier ${tierNum} terminé en ${mins} min (status=${bench.status}).${C.reset}`);
    // Progression de reprise : le tier a été passé (même échoué) → on le
    // mémorise pour qu'un --resume futur ne le rejoue pas. Un tier killé
    // (timeout OU --skip) n'est PAS mémorisé : interrompu ≠ passé, il doit
    // être rejoué à la reprise.
    if (!bench.timedOut && !bench.skipped) {
      recordProgressTier(modelKey, schoolKey, tierNum);
    }
    // Un tier obligatoire échoué marque l'école comme échouée. En mode
    // stopOnFirstFailure (mode 8 Manuel), on s'arrête IMMÉDIATEMENT ici : on
    // ne lance pas les tiers suivants et on remonte le flag stopped pour que
    // la boucle principale des modèles stoppe la file entière. En mode auto
    // (défaut), on continue les tiers suivants pour collecter un max de données.
    if (isMandatory && !bench.ok) {
      allMandatoryOk = false;
      if (stopOnFirstFailure) {
        console.log(`  ${C.red}[STOP] Mode manuel : tier obligatoire ${tierNum} échoué — arrêt de l'école et de la file.${C.reset}`);
        stopped = true;
        break;
      }
    }
    // --skip demandé pendant ce tier : on n'envoie PAS les tiers restants ni
    // la consolidation — on rend la main à la boucle des modèles.
    // NB : la sentinelle est déjà consommée par runBenchmark (après le kill),
    // c'est donc le flag bench.skipped qui fait foi, pas un 2e test fichier.
    if (bench.skipped) {
      console.log(`  ${C.yellow}[--skip] Passage au modèle suivant demandé — tiers restants de ${schoolKey} ignorés.${C.reset}`);
      skippedByUser = true;
      break;
    }
  }

  const durationMs = Date.now() - startMs;
  const okCount = tierResults.filter(t => t.ok).length;
  const tiersLabel = tierFilter && tierFilter.length > 0 ? `tiers ${tierFilter.join(',')}` : `${tierResults.length} tiers`;
  console.log(`\n  ${allMandatoryOk ? C.green : C.red}[${nowClock()}] École ${schoolKey} terminée : ${okCount}/${tierResults.length} tiers réussis (${tiersLabel}) en ${(durationMs / 60000).toFixed(1)} min.${C.reset}`);

  // --- Consolidation du carnet (run "all") ---
  // Le carnet de scores n'est sauvegardé par le runner QUE si tierArg === "all"
  // (runner.js ~ligne 2654). En mode classe-par-classe, chaque tier tourne dans
  // un process séparé avec tierArg = numéro du tier → le carnet n'est JAMAIS
  // écrit, et le leaderboard affiche le modèle comme "JAMAIS TESTÉ" bien que
  // les rapports existent (bug 2026-09-02 : HarnessLLM, Grug 12B ×2, Ornith
  // testés par tiers puis affichés jamais testés).
  //
  // On lance donc un run "all" de consolidation après les tiers si :
  //   (1) TOUS les tiers obligatoires du profil sont dans la sélection (sans
  //       filtre, c'est toujours vrai ; avec un filtre, on consolide quand
  //       même dès que les obligatoires sont couverts — c'est le cas qui
  //       produisait des sessions tier-by-tier complètes sans aucun carnet) ;
  //   (2) l'école ne s'est pas arrêtée (mode Manuel).
  // Un tier obligatoire échoué ne bloque PLUS la consolidation : le run "all"
  // ré-enregistre une tentative (même échouée) dans le carnet, exactement
  // comme le ferait un run classique non-classe-par-classe. Parité de
  // comportement : un échec d'école doit quand même laisser une trace.
  //
  // Ce run re-teste toute l'école d'un coup : c'est le seul chemin qui écrit
  // le carnet. Le surcoût est un run complet additionnel, acceptable en mode
  // nuit. Timeout de sécurité : un run "all" peut être 7× plus long qu'un
  // tier seul → cap à TIER_TIMEOUT_MS × nb tiers pour ne pas réintroduire le
  // hang infini que le mode classe-par-classe est censé prévenir.
  const mandatoryCovered = profile.mandatory.every(t => tierNums.includes(t) || skippedByResume.includes(t));
  if (mandatoryCovered && !stopped && !skippedByUser) {
    console.log(`\n  ${C.cyan}--- Consolidation du carnet (run all) ---${C.reset}`);
    console.log(`  ${C.gray}Sauvegarde du carnet de scores via un run complet (tierArg=all).${C.reset}`);
    const consolBench = await runBenchmark(modelKey, schoolCli, extraArgs, {
      tierNum: null,
      timeoutMs: TIER_TIMEOUT_MS * Math.max(1, profile.mandatory.length + profile.optional.length)
    });
    const consolMins = (consolBench.durationMs / 60000).toFixed(1);
    console.log(`  ${consolBench.ok ? C.green : C.red}[${nowClock()}] Consolidation terminée en ${consolMins} min (status=${consolBench.status}).${C.reset}`);
    if (consolBench.skipped) {
      // --skip pendant la consolidation : on préserve la progression (les
      // tiers passés ne doivent PAS être rejoués à la reprise) et on remonte
      // skippedByUser pour que la boucle des modèles passe au suivant SANS
      // enregistrer de run_ko mensonger dans l'historique.
      console.log(`  ${C.yellow}[--skip] Consolidation interrompue — la progression des tiers est conservée pour une reprise --resume.${C.reset}`);
      skippedByUser = true;
    } else if (consolBench.timedOut) {
      console.log(`  ${C.yellow}TIMEOUT consolidation : le run complet a été killé — le carnet est possiblement absent pour cette école.${C.reset}`);
    } else if (!consolBench.ok) {
      console.log(`  ${C.yellow}Attention : la consolidation a échoué — le carnet enregistre tout de même la tentative.${C.reset}`);
    }
    // L'école est consolidée (carnet écrit ou tentative échouée enregistrée) :
    // la progression de reprise n'a plus de raison d'être pour ce couple.
    // Un kill --skip/timedOut laisse la progression en place (reprise future).
    if (!consolBench.timedOut && !consolBench.skipped) {
      clearProgress(modelKey, schoolKey);
    }
  } else if (!mandatoryCovered) {
    console.log(`  ${C.yellow}Pas de consolidation du carnet : la sélection ne couvre pas tous les tiers obligatoires (${profile.mandatory.join(',')}) — le modèle restera sans carnet pour ${schoolKey}.${C.reset}`);
  }

  return { ok: allMandatoryOk, durationMs, tierResults, stopped, skippedByUser };
}

function parseArgs() {
  const raw = process.argv.slice(2);

  // Reconstitue la valeur d'un flag "--xxx=" dont la valeur a été découpée par
  // le shell sur les espaces. C'est le cas des display names non quotés qui
  // contiennent des espaces (ex: --models=Nanbeige4.2 3B sans guillemets → le
  // shell coupe en "--models=Nanbeige4.2" + "3B,..."). On prend la valeur après
  // '=', puis on rattache les tokens suivants qui ne commencent pas par '--'
  // (continuation de la valeur coupée), en les rejoignant par une espace. On
  // s'arrête au prochain vrai flag.
  function flagValue(flag) {
    const idx = raw.findIndex(r => r.startsWith(flag));
    if (idx < 0) return null;
    let val = raw[idx].slice(flag.length);
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].startsWith('--')) break;
      val += ' ' + raw[j];
    }
    return val;
  }

  let modelsArg = flagValue('--models=');
  let schoolsArg = flagValue('--schools=');
  let tiersArg = flagValue('--tiers=');
  const noTeacher = raw.includes('--no-teacher');
  const hybridFlag = raw.includes('--hybrid');
  const listOnly = raw.includes('--list-only');
  const classByClass = raw.includes('--class-by-class') || raw.includes('--cbc');
  const forceDetect = raw.includes('--force-detect');
  const skipFlag = raw.includes('--skip');
  const resumeFlag = raw.includes('--resume');
  const teacherProviderArg = flagValue('--teacher-provider=');
  const teacherModelArg = flagValue('--teacher-model=');
  let teacherApiKeyArg = flagValue('--teacher-api-key=');
  const teacherEndpointArg = flagValue('--teacher-endpoint=');
  // --isoler=!N : isole le modèle n° N (le marque NON APPLICABLE + l'exclut
  // des futurs batchs via .benchgo-blacklist.json). --isoler=!!N : désisole le
  // modèle n° N (retire de la liste noire). Le numéro N correspond à la position
  // dans la liste affichée par --list-only. Cette opération est one-shot : elle
  // applique l'isolation puis quitte (aucun batch lancé). Permet d'isoler ou
  // désisoler un modèle sans session interactive TTY — utile depuis un rapport
  // --lmstudio qui affiche les numéros.
  const isolateArg = flagValue('--isoler=');

  // Récupère les flags avalés par la virgule dans --models=. Quand l'utilisateur
  // écrit --models=Nanbeige4.2 3B,--schools=LIGHT sans guillemets, le shell
  // découpe sur l'espace et la virgule fusionne le modèle et le flag suivant.
  // Après reconstitution (flagValue), modelsArg = "Nanbeige4.2 3B,--schools=LIGHT".
  // On sépare sur la virgule : les parts qui ressemblent à un flag (--xxx=yyy)
  // sont récupérées comme flags (si pas déjà définies), pas comme modèles.
  if (modelsArg) {
    const parts = modelsArg.split(',');
    const modelParts = [];
    for (const p of parts) {
      const fm = p.match(/^--([a-z][\w-]*)=(.*)$/);
      if (fm) {
        const name = fm[1], value = fm[2];
        if (name === 'schools' && !schoolsArg) schoolsArg = value;
        else if (name === 'tiers' && !tiersArg) tiersArg = value;
        else if (name === 'teacher-provider' && !teacherProviderArg) {} // déjà capturé
      } else {
        modelParts.push(p);
      }
    }
    modelsArg = modelParts.join(',').trim() || null;
  }

  const extraRunnerArgs = [];
  if (noTeacher) extraRunnerArgs.push('--no-teacher');
  if (hybridFlag) extraRunnerArgs.push('--hybrid');
  if (teacherProviderArg) extraRunnerArgs.push(`--teacher-provider=${teacherProviderArg}`);
  if (teacherModelArg) extraRunnerArgs.push(`--teacher-model=${teacherModelArg}`);
  if (teacherApiKeyArg) extraRunnerArgs.push(`--teacher-api-key=${teacherApiKeyArg}`);
  if (teacherEndpointArg) extraRunnerArgs.push(`--teacher-endpoint=${teacherEndpointArg}`);
  return { modelsArg, schoolsArg, tiersArg, noTeacher, listOnly, hybridFlag, forceDetect, classByClass, isolateArg, skipFlag, resumeFlag, teacherProviderArg, teacherModelArg, extraRunnerArgs };
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
  // --help / help / -h : affiche l aide exhaustive puis quitte (avant la
  // verification du daemon LM Studio). Non bloquant en mode batch.
  if (wantsHelp(process.argv.slice(2))) {
    printEntryHelp('night-batch.js', 'Mode nuit (batch) — enchaîne les modèles LM Studio', [
      { cmd: 'node night-batch.js', desc: 'Mode interactif : sélection des modèles et écoles (TTY).' },
      { cmd: 'node night-batch.js --list-only', desc: 'Liste les modèles LM Studio triés par score local, puis quitte (debug).' },
      { cmd: 'node night-batch.js --models=key1,key2', desc: 'Modèles à tester sans sélection interactive (modelKeys).' },
      { cmd: 'node night-batch.js --schools=STANDARD,EXPERT', desc: 'Écoles à tester sans sélection interactive (clés SCHOOLS).' },
      { cmd: 'node night-batch.js --isoler=!4', desc: 'Isole le modèle n° 4 (marque NON APPLICABLE + exclut des batchs). Numéro = position dans --list-only.' },
      { cmd: 'node night-batch.js --isoler=!!6', desc: 'Désisole le modèle n° 6 (retire de la liste noire). Rétablit le statut réel.' },
      { cmd: 'node night-batch.js --no-teacher', desc: 'Désactive le professeur IA (correcteur externe).' },
      { cmd: 'node night-batch.js --force-detect', desc: 'Réindexe les GGUF orphelins (modèles sur disque absents de lms ls) puis liste.' },
      { cmd: 'node night-batch.js --class-by-class', desc: 'Mode classe-par-classe : chaque tier dans un process séparé avec timeout (robustesse anti-hang).' },
      { cmd: 'node night-batch.js --class-by-class --tiers=0', desc: 'Filtre rapide : ne teste que le 1er exercice (tier 0) de chaque école. Virer les modèles qui échouent.' },
      { cmd: 'node night-batch.js --resume', desc: 'Reprise : ignore les écoles déjà au carnet et, en classe-par-classe, les tiers déjà passés (reprend où la session s\'était arrêtée).' },
      { cmd: 'node night-batch.js --skip', desc: 'Pendant un batch EN COURS (autre terminal) : interrompt le modèle en cours (≤3s) et passe au suivant. Ne quitte PAS le batch.' },
      { cmd: 'Pendant la sélection : !<num>  /  !!<num>', desc: 'Isoler (!) ou désisoler (!!) un modèle de la liste noire.' },
      { cmd: 'Pendant la sélection : detect  /  force-detect', desc: 'Force la détection des modèles manquants (scan + lms import).' },
      { cmd: 'node night-batch.js --help  |  help  |  -h', desc: 'Affiche cette aide.' }
    ], [
      '--force, --profile= et --hybrid sont transmis au runner sous-jacent (cf. node runner.js --help).',
      '--class-by-class (ou --cbc) : isole chaque tier dans un process séparé avec timeout de 45 min. Un tier gelé ne bloque plus le batch — passage automatique au tier suivant.',
      '--tiers=0,1 : ne teste que les tiers indiqués (filtre rapide pour trier les modèles faibles). Combine avec --class-by-class et --schools=LIGHT.',
      '--isoler=!N / !!N : opérations one-shot. Affichez d\'abord --list-only pour connaître le numéro N, puis isolez/désisolez. Aucun batch lancé.',
      'Mode interactif : après le choix des écoles, le mode « Exercice par exercice » (B) propose automatiquement de choisir les tiers et le mode de passage (A=auto / M=manuel).',
      'Les rapports vont dans Export-Rapports/<date>/<ecole>/<niveau>/rapport_v3_*.md',
      'Classement communautaire : soumettez vos carnets avec : node runner.js --submit',
      'Pré-test de santé : chaque modèle reçoit un ping après chargement ; les modèles défectueux (load_failed, health check KO, run KO systémique) sont auto-blacklistés.',
      'Ctrl+C reste l\'arrêt COMPLET (décharge + serveur). Pour ÉCOURTER un modèle sans tout arrêter : node night-batch.js --skip dans un second terminal.',
      '--skip est consommé par le batch (≤3s) : le run en cours est killé, le modèle est consigné « passé avec --skip » (ni échec ni blacklist), et la file continue.',
      '--resume se combine avec --models/--schools/--class-by-class : les tiers déjà passés sont mémorisés dans .benchgo-progress.json et sautés.'
    ]);
    process.exit(0);
  }

  console.log(`\n${C.bold}${C.cyan}==================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}          BENCHGO V3 - MODE NUIT (BATCH)           ${C.reset}`);
  console.log(`${C.bold}${C.cyan}   File d'attente automatique de modeles LM Studio   ${C.reset}`);
  console.log(`${C.bold}${C.cyan}==================================================${C.reset}\n`);

  const { modelsArg, schoolsArg, tiersArg, listOnly, hybridFlag, forceDetect, isolateArg, classByClass: cbcFromCli, skipFlag, resumeFlag, extraRunnerArgs } = parseArgs();
  let classByClass = cbcFromCli;
  let tierFilter = null;
  // Mode 8 Manuel : stoppe la file au premier tier obligatoire échoué.
  // Faux par défaut (comportement historique : passage auto au suivant).
  let stopOnFirstFailure = false;
  if (tiersArg) {
    const nums = tiersArg.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 0);
    if (nums.length > 0) tierFilter = [...new Set(nums)];
  }

  console.log(`  ${C.gray}[${nowClock()}] Verification du daemon LM Studio...${C.reset}`);
  if (!isDaemonUp()) {
    console.log(`  ${C.red}Le daemon LM Studio ne repond pas.${C.reset}`);
    console.log(`  ${C.gray}Lancez LM Studio (l'application, ou 'lms daemon up') puis relancez ce script.${C.reset}`);
    process.exit(1);
  }
  console.log(`  ${C.green}Daemon LM Studio actif.${C.reset}`);

  // --- Action one-shot : --skip (passage au modèle suivant) ---
  // Écrit la sentinelle .benchgo-skip et quitte. Le batch en cours (autre
  // terminal) la détecte en ≤3s (SKIP_POLL_MS), kill le runner, consigne un
  // résultat 'skipped' et enchaîne sur le modèle suivant. Ctrl+C reste réservé
  // à l'arrêt COMPLET (décharge + serveur) — ne pas confondre les deux.
  if (skipFlag) {
    try {
      fs.writeFileSync(SKIP_FILE, String(Date.now()), 'utf8');
      console.log(`  ${C.green}Sentinelle --skip écrite (.benchgo-skip).${C.reset}`);
      console.log(`  ${C.gray}Le batch en cours interrompra le modèle en cours en ≤ ${SKIP_POLL_MS / 1000}s et passera au suivant.${C.reset}`);
      console.log(`  ${C.gray}(Ctrl+C reste l'arrêt complet : décharge des modèles + arrêt du serveur.)${C.reset}`);
    } catch (e) {
      console.log(`  ${C.red}Impossible d'écrire la sentinelle : ${e.message}${C.reset}`);
      process.exit(1);
    }
    process.exit(0);
  }

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
  // Maintient le serveur actif pendant tout le batch (anti-veille) : le serveur
  // peut se couper tout seul en cas d'inactivite, meme s'il etait deja actif.
  startServerKeepAlive();

  console.log(`\n  ${C.gray}[${nowClock()}] Recuperation de la liste des modeles...${C.reset}`);
  // Flag --force-detect : réindexe les GGUF orphelins (présents sur disque mais
  // absents de lms ls) AVANT de lister les modèles. Utile quand l'indexation de
  // LM Studio est désynchronisée de l'UI (modèles ajoutés manuellement, cache
  // périmé). Le scan lit le dossier physique ~/.lmstudio/models et réimporte
  // chaque orphelin via `lms import --symbolic-link -y` (aucun déplacement).
  if (forceDetect) {
    console.log(`  ${C.bold}${C.yellow}Forçage de la détection (scan du dossier physique)...${C.reset}`);
    const rep = forceDetectModels();
    console.log(`  ${C.gray}${rep.scanned} GGUF scanné(s), ${rep.orphans} orphelin(s), ${rep.imported} importé(s), ${rep.failed} échec(s).${C.reset}`);
    if (rep.orphans === 0) {
      console.log(`  ${C.green}Aucun GGUF orphelin : tous les modèles sont déjà indexés par lms ls.${C.reset}`);
    } else if (rep.imported > 0) {
      console.log(`  ${C.green}${rep.imported} modèle(s) réindexé(s).${C.reset}`);
    }
    console.log('');
  }
  const { ok: listOk, models, error: listErr } = listLlmModels();
  if (!listOk || models.length === 0) {
    console.log(`  ${C.red}Aucun modele LLM trouve : ${listErr}${C.reset}`);
    if (serverHandle.startedByUs) stopServer();
    process.exit(1);
  }

  // --- Opération one-shot : --isoler=!N ou --isoler=!!N ---
  // Permet d'isoler/désisoler un modèle depuis la ligne de commande sans
  // session interactive. Le numéro N correspond à la position dans la liste
  // affichée par --list-only (ou par le menu interactif). L'utilisateur peut
  // donc : (1) node night-batch.js --list-only pour voir les numéros, puis
  // (2) node night-batch.js --isoler=!4 pour isoler le n° 4. Aucun batch
  // n'est lancé — l'opération applique l'isolation et quitte.
  if (isolateArg) {
    const isoMatch = isolateArg.match(/^!(\d+)$/);
    const uniMatch = isolateArg.match(/^!!(\d+)$/);
    if (!isoMatch && !uniMatch) {
      console.log(`  ${C.red}Syntaxe invalide pour --isoler. Utilisez : --isoler=!N (isoler) ou --isoler=!!N (désisoler).${C.reset}`);
      console.log(`  ${C.gray}Exemple : --isoler=!4  (isole le modèle n° 4 affiché par --list-only).${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(1);
    }
    const isIsolate = Boolean(isoMatch);
    const n = parseInt((isoMatch || uniMatch)[1], 10);
    if (n < 1 || n > models.length) {
      console.log(`  ${C.red}Numéro invalide : ${n}. La liste contient ${models.length} modèle(s) (numéros 1 à ${models.length}).${C.reset}`);
      console.log(`  ${C.gray}Astuce : lancez 'node night-batch.js --list-only' pour voir les numéros.${C.reset}`);
      if (serverHandle.startedByUs) stopServer();
      process.exit(1);
    }
    const target = models[n - 1];
    if (isIsolate) {
      const bl = loadBlacklist();
      bl.add(target.modelKey);
      saveBlacklist(bl);
      console.log(`  ${C.yellow}✓ ${target.displayName} [${target.modelKey}] → isolé (NON APPLICABLE).${C.reset}`);
      console.log(`  ${C.gray}Ne sera plus testé dans les futurs batchs. Désisolez avec : node night-batch.js --isoler=!!${n}${C.reset}`);
    } else {
      const bl = loadBlacklist();
      if (!bl.has(target.modelKey)) {
        console.log(`  ${C.yellow}${target.displayName} n'est pas isolé — rien à désisoler.${C.reset}`);
        if (serverHandle.startedByUs) stopServer();
        process.exit(0);
      }
      bl.delete(target.modelKey);
      saveBlacklist(bl);
      console.log(`  ${C.green}✓ ${target.displayName} [${target.modelKey}] → désisolé.${C.reset}`);
      console.log(`  ${C.gray}Le modèle sera retesté dans les prochains batchs.${C.reset}`);
    }
    if (serverHandle.startedByUs) stopServer();
    process.exit(0);
  }

  // Mode --list-only : affiche la liste triee par statut et quitte (debug).
  // On n'appelle PAS selectModelsInteractive : elle afficherait le prompt
  // « Modèles à tester » qui n'a aucun sens en mode lecture seule. Avant, ce
  // bug faisait croire à l'utilisateur qu'il allait lancer un test alors que
  // --list-only est censé juste lister et quitter.
  if (listOnly) {
    printModelsList(models, { interactive: false });
    if (serverHandle.startedByUs) stopServer();
    process.exit(0);
  }

  let selected;
  if (modelsArg) {
    // Tolérance : --models= accepte indifféremment des modelKeys (ex:
    // "opencoder-8b-instruct-i1") OU des display names (ex: "OpenCoder 8B
    // Instruct I1"). La comparaison est insensible à la casse et aux espaces
    // multiples. Important : les display names contiennent des espaces, donc
    // on NE splitte PAS sur les espaces — uniquement sur la virgule. Chaque
    // élément de la liste est normalisé (trim + lower + collapse spaces).
    const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const keys = modelsArg.split(',').map(s => s.trim()).filter(Boolean);
    const normKeys = keys.map(normalize);
    // Match exact (modelKey OU displayName), insensible à la casse/espaces.
    selected = models.filter(m => {
      const k = normalize(m.modelKey);
      const d = normalize(m.displayName);
      return normKeys.includes(k) || normKeys.includes(d);
    });
    // Repli par préfixe : un nom tronqué (ex: "nanbeige4.2" car l'utilisateur a
    // oublié de quoter l'espace) matche un seul modèle. On ne l'active QUE si la
    // correspondance est non ambiguë (un seul candidat).
    if (selected.length === 0) {
      const prefixMatches = new Map();
      for (const m of models) {
        const cands = [normalize(m.modelKey), normalize(m.displayName)];
        for (const nk of normKeys) {
          for (const c of cands) {
            if (c && c.startsWith(nk)) {
              if (!prefixMatches.has(nk)) prefixMatches.set(nk, []);
              prefixMatches.get(nk).push(m);
            }
          }
        }
      }
      const unambiguous = [...prefixMatches.values()].filter(arr => arr.length === 1).flat();
      selected = [...new Set(unambiguous)];
    }
    if (selected.length === 0) {
      console.log(`  ${C.red}Aucun modele de --models= trouve dans la liste.${C.reset}`);
      console.log(`  ${C.gray}ModelKeys disponibles : ${models.map(m => m.modelKey).join(', ')}${C.reset}`);
      console.log(`  ${C.gray}Astuce : --models= accepte aussi les display names (ex: "OpenCoder 8B Instruct I1").${C.reset}`);
      console.log(`  ${C.gray}Si le nom contient des espaces, quottez-le : --models="Nanbeige4.2 3B".${C.reset}`);
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
      const interactiveResult = await selectSchoolsInteractive(selected);
      schools = interactiveResult.schools;
      if (!classByClass) classByClass = interactiveResult.classByClass;
      if (interactiveResult.tierFilter) tierFilter = interactiveResult.tierFilter;
      // Mode 8 Manuel : stoppe la file au premier tier obligatoire échoué.
      if (interactiveResult.stopOnFirstFailure) stopOnFirstFailure = true;
      // Option 7 = manuel par modèle : le plan a été construit DANS
      // selectSchoolsInteractive (juste après le choix de l'option 7, AVANT les
      // questions mode/tiers/passage). On le récupère tel quel — pas de second
      // appel à selectSchoolsManualPerModel.
      if (interactiveResult.manualPlan) manualPlan = interactiveResult.manualPlan;
      if (schools.length === 0) {
        console.log(`  ${C.yellow}Aucune ecole selectionnee. Abandon.${C.reset}`);
        if (serverHandle.startedByUs) stopServer();
        process.exit(0);
      }
    }
  }

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
  if (classByClass) {
    console.log(`  ${C.yellow}Mode classe-par-classe ACTIVÉ : chaque tier dans un process séparé (timeout ${TIER_TIMEOUT_MS / 60000} min/tier, reprise auto au tier suivant).${C.reset}`);
  }
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
  console.log(`  ${C.gray}Ctrl+C = arrêt complet (décharge + serveur). Pour passer au modèle suivant : node night-batch.js --skip dans un autre terminal.${C.reset}`);
  if (resumeFlag) {
    console.log(`  ${C.green}Mode --resume ACTIVÉ : écoles déjà au carnet ignorées, tiers déjà passés sautés (reprise à l'exercice près).${C.reset}`);
  }
  console.log('');

  const results = [];
  const batchStart = Date.now();
  let batchStopped = false;
  for (let i = 0; i < selected.length; i++) {
    const m = selected[i];
    try {
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

    // --resume (1/2) : ignore les écoles DÉJÀ au carnet. Un modèle dont
    // l'école a un run complet enregistré (tentative écrite par une
    // consolidation) n'a rien à reprendre sur cette école — la reprendre
    // ferait double emploi et doublerait le temps de nuit.
    if (resumeFlag) {
      const ledgers = loadAllLedgers();
      const ledger = matchLedger(m.modelKey, ledgers);
      const doneSchools = ledgerSchoolKeys(ledger);
      const remainingSchools = modelSchools.filter(s => !doneSchools.includes(s.key));
      if (remainingSchools.length < modelSchools.length) {
        const doneLabels = modelSchools.filter(s => doneSchools.includes(s.key)).map(s => s.key).join(', ');
        console.log(`  ${C.green}[--resume] École(s) déjà au carnet ignorée(s) pour ${m.displayName} : ${doneLabels}${C.reset}`);
        modelSchools = remainingSchools;
      }
      if (modelSchools.length === 0) {
        console.log(`  ${C.green}[--resume] ${m.displayName} : toutes les écoles demandées sont déjà au carnet — modèle ignoré.${C.reset}`);
        continue;
      }
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
      autoBlacklist(m.modelKey, 'lms load échoué (GGUF corrompu ou incompatible)');
      results.push({ model: m, ok: false, reason: 'load_failed', durationMs: 0 });
      continue;
    }
    console.log(`  ${C.green}Modele charge.${C.reset}`);

    // Pré-test de santé : vérifie que le modèle répond réellement avant de
    // lancer le benchmark complet. Détecte les modèles qui se chargent mais
    // gelent au premier appel (hang infini, comme OpenCoder 8B — 3h48 perdues).
    // Si le health check échoue, on décharge, auto-blackliste et passe au suivant.
    console.log(`  ${C.gray}[${nowClock()}] Pré-test de santé (health check)...${C.reset}`);
    const health = await healthCheck(m.modelKey);
    if (!health.ok) {
      console.log(`  ${C.red}Health check ÉCHEC : ${health.reason}${C.reset}`);
      console.log(`  ${C.gray}Déchargement et passage au modèle suivant.${C.reset}`);
      unloadAll();
      autoBlacklist(m.modelKey, `health check échoué — ${health.reason}`);
      results.push({ model: m, ok: false, reason: 'health_failed', durationMs: 0 });
      continue;
    }
    console.log(`  ${C.green}Health check OK — le modèle répond (${String(health.content).slice(0, 40).trim()}).${C.reset}`);

    let modelOk = true;
    let modelSkipped = false;
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

      let bench;
      let stopBatch = false;
      if (classByClass && school.key !== 'auto') {
        // Mode classe-par-classe : chaque tier dans un process séparé avec
        // timeout. Robustesse accrue : un tier gelé n'arrête pas l'école
        // entière et ne bloque pas le batch. Reprend au tier suivant.
        // En mode 8 Manuel (stopOnFirstFailure), un tier obligatoire échoué
        // stoppe l'école ET la file entière (bench.stopped = true).
        console.log(`  ${C.gray}Mode classe-par-classe : chaque tier dans un process séparé (timeout ${TIER_TIMEOUT_MS / 60000} min/tier).${C.reset}`);
        // --resume (2/2) : en mode classe-par-classe, on reprend AU TIER près.
        // Les tiers mémorisés dans .benchgo-progress.json (passés lors d'une
        // session interrompue) sont sautés ; le batch reprend exactement là où
        // il s'était arrêté, puis la consolidation écrit le carnet complet.
        const resumeTiersDone = resumeFlag ? getProgressTiers(m.modelKey, school.key) : null;
        bench = await runSchoolClassByClass(m.modelKey, school.key, school.cli, modelExtraArgs, tierFilter, stopOnFirstFailure, resumeTiersDone);
        if (bench.stopped) { stopBatch = true; batchStopped = true; }
        if (bench.skippedByUser) {
          results.push({ model: m, school: school.key, ok: false, reason: 'skipped', durationMs: bench.durationMs });
          modelSkipped = true;
          break;
        }
      } else {
        // Mode classique : toute l'école dans un seul process (comportement
        // historique). Pas de timeout (timeout=0) — un modèle gelé peut
        // bloquer indéfiniment. En mode --class-by-class, on n'utilise cette
        // branche que pour l'école 'auto' (le runner devine le profil).
        bench = await runBenchmark(m.modelKey, school.cli, modelExtraArgs);
      }
      const mins = (bench.durationMs / 60000).toFixed(1);
      if (!bench.ok) modelOk = false;
      // Skip demandé PENDANT ce run (mode classique) : on n'enchaîne pas sur
      // l'école suivante du même modèle.
      if (bench.skipped) {
        console.log(`\n  ${C.yellow}[--skip] ${m.displayName} / ${school.label} interrompu après ${mins} min — passage au modèle suivant.${C.reset}`);
        results.push({ model: m, school: school.key, ok: false, reason: 'skipped', durationMs: bench.durationMs });
        modelSkipped = true;
        break;
      }
      // Enregistre le résultat (succès OU échec) dans l'historique des runs
      // pour distinguer JAMAIS TESTE d'un échec réel (load_failed / run KO).
      recordRun(m.modelKey, bench.ok ? 'ok' : 'run_ko', school.key);
      console.log(`\n  ${bench.ok ? C.green : C.red}[${nowClock()}] ${m.displayName} / ${school.label} termine en ${mins} min (status=${bench.status}).${C.reset}`);
      results.push({ model: m, school: school.key, ok: bench.ok, status: bench.status, durationMs: bench.durationMs });
      // Mode 8 Manuel : arrêt immédiat de la file au premier échec obligatoire.
      if (stopBatch) break;
    }
    if (modelSkipped) {
      console.log(`\n  ${C.yellow}[--skip] Modele ${m.displayName} écourté — passage au modèle suivant.${C.reset}`);
      continue;
    }
    console.log(`\n  ${modelOk ? C.green : C.red}[${nowClock()}] Modele ${m.displayName} termine (${modelSchools.length} ecole(s)).${C.reset}`);

    // Auto-blacklist si TOUTES les écoles ont échoué en run_ko (et aucune n'a
    // réussi). Un modèle qui rate toutes ses écoles a un problème systémique
    // (crash moteur, instabilité) : on le blackliste pour épargner les nuits
    // futures. Si au moins une école a réussi, on garde le modèle (il fonctionne
    // partiellement). L'utilisateur peut toujours désisoler avec !!<num>.
    // Un modèle SKIPPÉ n'est PAS un échec : il n'a pas fini son examen, on ne
    // tire aucune conclusion sur sa santé.
    if (!modelOk && !modelSkipped) {
      const allFailed = results.filter(r => r.model && r.model.modelKey === m.modelKey && r.reason !== 'load_failed' && r.reason !== 'health_failed' && r.reason !== 'skipped')
                               .every(r => !r.ok);
      if (allFailed && results.some(r => r.model && r.model.modelKey === m.modelKey && r.reason !== 'load_failed' && r.reason !== 'health_failed' && r.reason !== 'skipped')) {
        autoBlacklist(m.modelKey, 'toutes les écoles ont échoué (run KO systémique)');
      }
    }
    // Mode 8 Manuel : un tier obligatoire échoué a déclenché stopBatch → on
    // sort de la file d'attente entière (plus aucun modèle n'est lancé).
    if (batchStopped) {
      console.log(`\n  ${C.red}[STOP] Mode manuel : arrêt de la file d'attente après l'échec de ${m.displayName}.${C.reset}`);
      break;
    }
    } catch (err) {
      // Filet de sécurité : une exception inattendue sur UN modèle ne doit
      // jamais interrompre toute la file de nuit. On log, on trace l'échec et
      // on passe au modèle suivant (comportement identique à un run_ko).
      console.log(`\n  ${C.red}[ERREUR] Exception sur ${m.displayName} : ${err && err.message ? err.message : err}. Passage au modèle suivant.${C.reset}`);
      recordRun(m.modelKey, 'exception', null);
      results.push({ model: m, ok: false, reason: 'exception', durationMs: 0 });
    }
  }

  console.log(`\n  ${C.gray}[${nowClock()}] Dechargement de tous les modeles...${C.reset}`);
  unloadAll();
  stopServerKeepAlive();
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
    const reasonMap = { 'load_failed': 'chargement échoué', 'health_failed': 'health check échoué', 'run_ko': 'run KO', 'skipped': 'passé avec --skip' };
    const reason = r.reason ? ` ${C.gray}(${reasonMap[r.reason] || r.reason})${C.reset}` : '';
    const schoolTag = r.school ? ` ${C.gray}[${r.school}]${C.reset}` : '';
    // Quantification affichée si disponible (ex: Q5_K_L). Indispensable quand
    // plusieurs quantifs du même modèle sont testées : sans elle, le bilan
    // répète le même displayName sans préciser quelle quantif a été évaluée.
    const quantTag = r.model.quant && r.model.quant !== '?' ? ` ${C.magenta}${r.model.quant}${C.reset}` : '';
    const blacklisted = r.reason === 'load_failed' || r.reason === 'health_failed' || (r.reason === 'run_ko' && !results.some(x => x.model && x.model.modelKey === r.model.modelKey && x.ok));
    const blTag = blacklisted && !r.ok ? ` ${C.yellow}[auto-blacklisté]${C.reset}` : '';
    console.log(`  ${icon} ${r.model.displayName.padEnd(28)}${quantTag}${schoolTag} ${C.gray}${mins} min${C.reset}${reason}${blTag}`);
  }

  console.log(`\n  ${C.gray}Rapports : Export-Rapports/<date>/<ecole>/<niveau>/rapport_v3_*.md${C.reset}`);
  console.log(`  ${C.gray}Classement : Export-Rapports/classement.html (et classement.md)${C.reset}`);
  console.log(`  ${C.gray}Logs : logs/benchgo_*.log${C.reset}\n`);

  // --- Rappel soumission communautaire (multi-touch) ---
  // Les carnets générés pendant la nuit peuvent alimenter le classement public.
  // En mode --hybrid, l'auto-soumission est déjà gérée par hybrid-mode.js via le
  // runner sous-jacent : on ne duplique pas, on confirme juste le principe.
  console.log(`  ${C.bold}${C.cyan}COMMUNAUTÉ${C.reset}`);
  if (hybridFlag) {
    console.log(`  ${C.gray}Mode --hybrid actif : l'auto-soumission GitHub a été tentée par le runner${C.reset}`);
    console.log(`  ${C.gray}pour chaque modèle dont le seuil a été atteint. Consultez les logs ci-dessus${C.reset}`);
    console.log(`  ${C.gray}pour le détail des soumissions réussies/échouées.${C.reset}`);
  } else {
    console.log(`  ${C.gray}Les carnets générés cette nuit peuvent alimenter le classement public.${C.reset}`);
    console.log(`  ${C.gray}Soumission manuelle post-batch :${C.reset} ${C.cyan}node runner.js --submit${C.reset}`);
  }
  console.log('');

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
  forceDetectModels,
  detectOrphanLedgers,
  loadBlacklist,
  saveBlacklist,
  loadRunHistory,
  saveRunHistory,
  recordRun,
  runStatusFromHistory,
  healthCheck,
  autoBlacklist,
  NON_LLM_PATTERNS
};

if (require.main === module) {
  // Ctrl+C : décharge tous les modèles LM Studio avant de quitter pour libérer
  // la RAM. Sans ça, les modèles restent chargés en mémoire après l'arrêt.
  process.on('SIGINT', () => {
    console.log(`\n  ${C.yellow}[Ctrl+C] Déchargement des modèles LM Studio...${C.reset}`);
    try { unloadAll(); } catch (_) {}
    try { stopServer(); } catch (_) {}
    console.log(`  ${C.green}Modèles déchargés. Au revoir.${C.reset}`);
    process.exit(0);
  });
  main().catch(e => {
    console.error(`\n${C.red}[ERREUR FATALE night-batch]${C.reset} ${e.message}`);
    console.error(e.stack);
    try { unloadAll(); } catch (_) {}
    process.exit(1);
  });
}