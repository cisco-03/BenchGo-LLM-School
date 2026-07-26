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
  { key: 'STANDARD', label: 'College-Lycee (3B - 14B)',   cli: 'STANDARD' },
  { key: 'EXPERT',   label: 'Universite (14B - 30B)',     cli: 'EXPERT' },
  { key: 'DOCTORAT', label: 'These (> 30B)',               cli: 'DOCTORAT' },
  { key: 'auto',     label: 'Auto-detection (1 ecole)',   cli: null },
  // Mode auto-par-modele : chaque modele passe UNIQUEMENT l'ecole adaptee a
  // sa taille de parametres (detectee via detectProfileFromModelName). Permet de
  // melanger des modeles de tailles differentes dans la meme session de nuit
  // (un 3B fait Primaire, un 15B fait College-Lycee, etc.) sans selectionner
  // manuellement l'ecole de chacun. cli=null : l'ecole est calculee par modele.
  { key: 'auto-per-model', label: 'Auto par modele (ecole selon la taille)', cli: null }
];

// Détecte si la sélection d'écoles correspond au mode « auto par modèle »
// (option 6, key 'auto-per-model'). Dans ce mode, l'école de chaque modèle
// est calculée individuellement via schoolForModel() au lieu d'utiliser une
// liste globale d'écoles identique pour tous.
function isAutoPerModel(schools) {
  if (!schools) return false;
  return schools.some(s => s && s.key === 'auto-per-model');
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

// Tente de faire correspondre un modelKey (lms ls) a un carnet de scores.
// Strategie : on normalise le modelKey et le champ model du carnet ; si egalite
// exacte -> match. Sinon, on extrait le dernier segment significatif du modelKey
// (ex: "mythos-9b-unhinged" depuis "mythos-9b-unhinged@q4_k_m") et on cherche
// une inclusion dans model ou shortName du carnet (dans les deux sens).
function matchLedger(modelKey, ledgers) {
  if (!modelKey) return null;
  const nk = normalizeForMatch(modelKey);
  if (!nk) return null;
  // 1) Egalite normalisee stricte sur model.
  for (const l of ledgers) {
    if (normalizeForMatch(l.model) === nk) return l;
  }
  // 2) Egalite normalisee stricte sur shortName.
  for (const l of ledgers) {
    if (normalizeForMatch(l.shortName) === nk) return l;
  }
  // 3) Dernier segment du modelKey inclus dans model/shortName (et reciproque).
  const seg = nk.split('-').filter(Boolean).pop() || nk;
  if (seg.length >= 4) {
    for (const l of ledgers) {
      const nm = normalizeForMatch(l.model);
      const ns = normalizeForMatch(l.shortName);
      if ((nm && (nm.includes(seg) || seg.includes(nm))) ||
          (ns && (ns.includes(seg) || seg.includes(ns)))) return l;
    }
  }
  return null;
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
    tokensPerSecond, elapsedMs: totalElapsedMs,
    attempts: maxAttempts, trend
  };
}

// Liste les modeles LLM telecharges via lms ls --json --llm. Chaque modele est
// enrichi d'un statut de test (deja teste / partiel / jamais teste) calcule en
// croisant son modelKey avec les carnets de scores existants.
function listLlmModels() {
  const r = runLms(['ls', '--json', '--llm'], { timeoutMs: 30000 });
  if (r.status !== 0 || !r.stdout) {
    return { ok: false, models: [], error: r.stderr || `lms ls echoue (status=${r.status})` };
  }
  try {
    const arr = JSON.parse(r.stdout);
    if (!Array.isArray(arr)) return { ok: false, models: [], error: 'Reponse JSON inattendue' };
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
    const models = arr.map(m => {
      const modelKey = m.modelKey;
      const ledger = matchLedger(modelKey, ledgers);
      const testedSchools = ledgerSchoolKeys(ledger);
      const relevantKeys = relevantSchoolKeysFor(m);
      // On ne considere comme "manquantes" que les ecoles pertinents pour la
      // taille du modele (LIGHT..son ecole). Les ecoles au-dela (trop difficiles)
      // sont ignorees : elles ne seront jamais demandees a ce modele.
      const relevantTested = testedSchools.filter(k => relevantKeys.includes(k));
      const missingSchools = relevantKeys.filter(k => !relevantTested.includes(k));
      let status;
      if (!ledger || testedSchools.length === 0) {
        status = { kind: 'never', tested: [], missing: relevantKeys.slice(), quant: ledger ? ledger.quantization : null };
      } else if (missingSchools.length === 0) {
        status = { kind: 'complete', tested: relevantTested, missing: [], quant: ledger.quantization };
      } else {
        status = { kind: 'partial', tested: relevantTested, missing: missingSchools, quant: ledger.quantization };
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
        // Metriques agreggees depuis le carnet (meilleure tentative par ecole).
        // Absentes si le modele n'a jamais ete teste (kind === 'never').
        metrics: computeLedgerMetrics(ledger)
      };
    });
    // Tri : modeles deja testes du plus fort au plus faible (pct, puis score,
    // puis sante), puis les modeles jamais testes a la fin (par nom). Permet
    // de repérer immédiatement le modele le plus faible (dernier des testes)
    // pour le retirer, et de privilegier le test des nouveaux d'abord.
    models.sort((a, b) => {
      const aTested = a.status.kind !== 'never' && a.metrics;
      const bTested = b.status.kind !== 'never' && b.metrics;
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
  if (status.kind === 'never')   return { label: 'JAMAIS TESTE', color: C.yellow };
  if (status.kind === 'partial') return { label: 'PARTIEL',      color: C.magenta };
  return { label: 'COMPLET', color: C.green };
}

function missingSchoolsLabel(status) {
  if (!status || !status.missing || status.missing.length === 0) return '';
  return status.missing.join(',');
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

// Renvoie le glyphe + couleur ANSI d'une tendance (up/down/stable/null).
function trendGlyph(trend) {
  if (trend === 'up') return `${C.green}\u25B2${C.reset}`;
  if (trend === 'down') return `${C.red}\u25BC${C.reset}`;
  if (trend === 'stable') return `${C.gray}=${C.reset}`;
  return `${C.gray}\u2014${C.reset}`;
}

// Selection interactive des modeles.
async function selectModelsInteractive(models) {
  console.log(`\n  ${C.bold}${C.cyan}=== MODELES LLM TELECHARGES ===${C.reset}`);
  console.log(`  ${C.gray}Selectionnez les modeles a tester cette nuit.${C.reset}`);
  console.log(`  ${C.gray}Syntaxe : numeros separes par les virgules (ex: 1,3,5) ou "all".${C.reset}`);
  console.log(`  ${C.gray}Ordre : modeles testes du plus fort au plus faible, puis jamais testes a la fin.${C.reset}`);
  console.log(`  ${C.gray}Astuce : le dernier des testes est le plus faible — un bon candidat au retrait.${C.reset}\n`);

  const idxW = 4, nameW = 30, paramW = 5, quantW = 7, sizeW = 8, pubW = 14, statusW = 13;
  const pctW = 5, tpsW = 8, attW = 5, trendW = 4, timeW = 8, missW = 22;
  const header = `  ${' '.padEnd(idxW)}${'Modèle'.padEnd(nameW)}${'Param'.padStart(paramW)} ${'Quant'.padEnd(quantW)} ${'Taille'.padStart(sizeW)}  ${'Editeur'.padEnd(pubW)} ${'Statut'.padEnd(statusW)} ${'Pct'.padStart(pctW)} ${'Vit.'.padStart(tpsW)} ${'Tent.'.padStart(attW)} ${'Tnd'.padStart(trendW)} ${'Temps'.padStart(timeW)}  ${'Ecoles manquantes'}`;
  console.log(`${C.gray}${header}${C.reset}`);
  models.forEach((m, i) => {
    const idx = String(i + 1).padStart(2) + '.';
    const sz = fmtBytes(m.size).padStart(7);
    const badge = statusBadge(m.status);
    const statusStr = `${badge.color}${badge.label.padEnd(statusW)}${C.reset}`;
    const missing = missingSchoolsLabel(m.status);
    const missStr = missing ? `${C.gray}${missing.padEnd(missW)}${C.reset}` : ''.padEnd(missW);
    const name = (m.displayName || '').padEnd(nameW).slice(0, nameW);
    const pub = (m.publisher || '?').padEnd(pubW).slice(0, pubW);
    // Metriques de classement local (absentes si jamais teste).
    const mt = m.metrics;
    const pctStr = mt ? `${String(mt.pct + '%').padStart(pctW)}` : `${C.gray}${'?'.padStart(pctW)}${C.reset}`;
    const tpsStr = mt && mt.tokensPerSecond > 0
      ? `${C.gray}${(mt.tokensPerSecond + ' t/s').padStart(tpsW)}${C.reset}`
      : `${C.gray}${'\u2014'.padStart(tpsW)}${C.reset}`;
    const attStr = mt ? `${String(mt.attempts).padStart(attW)}` : `${C.gray}${'?'.padStart(attW)}${C.reset}`;
    const trendStr = mt ? `${trendGlyph(mt.trend).padEnd(trendW)}` : `${C.gray}${'\u2014'.padEnd(trendW)}${C.reset}`;
    const timeStr = mt && mt.elapsedMs > 0
      ? `${C.gray}${fmtDuration(mt.elapsedMs).padStart(timeW)}${C.reset}`
      : `${C.gray}${'\u2014'.padStart(timeW)}${C.reset}`;
    console.log(`  ${C.bold}${idx.padEnd(idxW)}${C.reset} ${name} ${C.gray}${(m.params || '?').padEnd(paramW)} ${(m.quant || '?').padEnd(quantW)} ${sz}  ${pub}${C.reset} ${statusStr} ${pctStr} ${tpsStr} ${attStr} ${trendStr} ${timeStr}  ${missStr}`);
  });
  console.log('');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${C.cyan}Modeles a tester :${C.reset} `, answer => {
      rl.close();
      const raw = (answer || '').trim().toLowerCase();
      if (raw === 'all' || raw === '*') { resolve(models); return; }
      const indices = raw.split(/[\s,;]+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= models.length);
      const uniq = [...new Set(indices.map(n => n - 1))];
      resolve(uniq.map(i => models[i]));
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
//   3-14B  → STANDARD (College-Lycee)
//   14-30B → EXPERT   (Universite)
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
  // 3) Fallback : depuis paramsString (ex: "14B", "3B", "26B-A4B"). Le runner LM
  //    Studio fournit une taille fiable ici même quand le nom ne l'indique pas.
  if (!detected && m.params) {
    const sizeMatch = String(m.params).match(/([\d]+[.,]?[\d]*)\s*b/i);
    if (sizeMatch) {
      const sz = parseFloat(sizeMatch[1].replace(',', '.'));
      if (sz < 3) detected = 'LIGHT';
      else if (sz <= 14) detected = 'STANDARD';
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

// Selection interactive des ecoles.
async function selectSchoolsInteractive(selectedModels) {
  console.log(`\n  ${C.bold}${C.cyan}=== ECOLES A TESTER ===${C.reset}`);
  console.log(`  ${C.gray}Selectionnez les ecoles (niveaux) a faire passer a chaque modele.${C.reset}`);
  console.log(`  ${C.gray}Syntaxe : numeros separes par les virgules (ex: 1,2) ou "all".${C.reset}`);
  console.log(`  ${C.gray}Option 6 = AUTO PAR MODELE : chaque modele passe uniquement l'ecole${C.reset}`);
  console.log(`  ${C.gray}adaptee a sa taille de parametres (3B->Primaire, 15B->College-Lycee, etc.).${C.reset}`);
  console.log(`  ${C.gray}Ideal quand la file melange des modeles de tailles differentes.${C.reset}\n`);
  SCHOOLS.forEach((s, i) => {
    const idx = String(i + 1).padStart(2);
    // Pour l'option 'auto', on précise que c'est l'auto-détection classique
    // (1 école par modèle, le runner devine le profil).
    let extra = '';
    if (s.key === 'auto') extra = ' (auto-detection runner)';
    console.log(`  ${C.bold}${idx}.${C.reset} ${s.label}${C.gray}${extra}${C.reset}`);
  });

  // Aperçu de l'attribution auto-par-modèle (option 6) pour aider l'utilisateur
  // à anticiper : montre quelle école chaque modèle sélectionné ferait.
  if (selectedModels && selectedModels.length > 0) {
    console.log(`\n  ${C.gray}Aperçu option 6 (auto par modèle) :${C.reset}`);
    for (const m of selectedModels) {
      const lbl = schoolLabelForModel(m);
      console.log(`  ${C.gray}  ${m.displayName.padEnd(30)} → ${lbl}${C.reset}`);
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

function loadModel(modelKey) {
  const r = runLms(['load', modelKey], { timeoutMs: 180000 });
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
    }
  }

  // Mode auto-par-modele : on calcule l'ecole de chaque modele individuellement.
  // Un modele dont la taille n'est pas detectable est envoye en auto-detection
  // (le runner devinera le profil depuis le nom). On construit un plan
  // { model, school } par modele pour l'affichage et l'execution.
  const autoPerModel = isAutoPerModel(schools);
  let plan;
  if (autoPerModel) {
    plan = selected.map(m => {
      const school = schoolForModel(m) || SCHOOLS.find(s => s.key === 'auto');
      return { model: m, school };
    });
    // Vérifie qu'au moins un modèle a une école détectée (sinon tout est en auto).
    const detectedCount = plan.filter(p => p.school.key !== 'auto').length;
    if (detectedCount === 0) {
      console.log(`  ${C.yellow}Aucun modele n'a une taille de parametres detectable.${C.reset}`);
      console.log(`  ${C.gray}Le runner utilisera l'auto-detection pour chacun.${C.reset}`);
    }
  } else {
    plan = null;
  }

  const totalRuns = autoPerModel ? plan.length : selected.length * schools.length;
  console.log(`\n  ${C.bold}${C.cyan}=== FILE D'ATTENTE DE NUIT ===${C.reset}`);
  console.log(`  ${C.bold}Modeles :${C.reset} ${selected.length}  |  ${C.bold}Ecoles :${C.reset} ${schools.map(s => s.key).join(', ')}  |  ${C.bold}Runs totaux :${C.reset} ${totalRuns}`);
  if (autoPerModel) {
    console.log(`  ${C.gray}Mode auto-par-modele : chaque modele passe l'ecole adaptee a sa taille.${C.reset}`);
    console.log(`  ${C.gray}Attribution :${C.reset}`);
    for (const p of plan) {
      console.log(`  ${C.bold}  ${p.model.displayName.padEnd(28)}${C.reset} ${C.gray}→ ${p.school.label}${C.reset}`);
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

    // Détermine la liste d'écoles pour CE modèle. En mode auto-par-modèle,
    // c'est une seule école (calculée depuis la taille du modèle). Sinon,
    // ce sont toutes les écoles sélectionnées globalement.
    let modelSchools;
    if (autoPerModel) {
      modelSchools = [plan[i].school];
    } else {
      modelSchools = schools;
    }

    console.log(`  ${C.gray}[${nowClock()}] Dechargement des modeles precedents...${C.reset}`);
    unloadAll();

    console.log(`  ${C.gray}[${nowClock()}] Chargement du modele ${m.modelKey}...${C.reset}`);
    if (!loadModel(m.modelKey)) {
      console.log(`  ${C.yellow}Modele ${m.modelKey} non chargeable - ignore.${C.reset}`);
      results.push({ model: m, ok: false, reason: 'load_failed', durationMs: 0 });
      continue;
    }
    console.log(`  ${C.green}Modele charge.${C.reset}`);

    let modelOk = true;
    for (let j = 0; j < modelSchools.length; j++) {
      const school = modelSchools[j];
      console.log(`\n  ${C.bold}${C.cyan}=== ECOLE ${j + 1}/${modelSchools.length} - ${school.label} ===${C.reset}`);

      const bench = runBenchmark(m.modelKey, school.cli, extraRunnerArgs);
      const mins = (bench.durationMs / 60000).toFixed(1);
      if (!bench.ok) modelOk = false;
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
  isAutoPerModel
};

if (require.main === module) {
  main().catch(e => {
    console.error(`\n${C.red}[ERREUR FATALE night-batch]${C.reset} ${e.message}`);
    console.error(e.stack);
    try { unloadAll(); } catch (_) {}
    process.exit(1);
  });
}