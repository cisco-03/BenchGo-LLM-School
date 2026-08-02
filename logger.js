const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Par défaut : un fichier de log horodaté par exécution (pour runner.js, les
// batchs, etc.). Le serveur interactif (leaderboard.js --serve) override ce
// chemin via setLogFile() pour utiliser un fichier FIXE (logs/serveur.log)
// remis a zéro a chaque démarrage — evite l'accumulation de dizaines de
// fichiers timestamp incomprehensibles pour l'utilisateur.
const DEFAULT_LOG_FILE = path.join(LOG_DIR, `benchgo_${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
let logFilePath = DEFAULT_LOG_FILE;

// Permet de rediriger tous les logs vers un fichier fixe (nom stable). Utilisé
// par le serveur interactif (leaderboard.js --serve) pour avoir un seul
// fichier de log connu, truncat a chaque démarrage.
function setLogFile(filePath) {
  logFilePath = filePath;
}

// Remet a zéro (vide) le fichier de log courant. Appelé au démarrage du serveur
// pour partir d'un log propre a chaque session.
function truncateLogFile() {
  try {
    fs.writeFileSync(logFilePath, '', 'utf8');
  } catch (_) {
    // Disque plein ou lecture seule : on ne fait pas crasher.
  }
}

function getFilePath() {
  return logFilePath;
}

// On écrit les logs de façon SYNCHRONE (fs.appendFileSync). Au détriment d'une
// légère perte de perf (les logs sont peu nombreux : ~1-10 lignes par exécution),
// on garantit que TOUTE ligne journalisée est persistée sur disque avant un
// éventuel process.exit(). Cela corrige le bug historique où les logs des
// actions uniques (help, status, version, dry-run) disparaissaient silencieusement
// car le WriteStream asynchrone n'était pas vidé à temps par process.exit().
function writeLine(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch (_) {
    // Si le disque est plein ou en lecture seule, on ne fait pas crasher le run.
  }
}

function info(message) {
  writeLine('INFO', message);
}

function warn(message) {
  writeLine('WARN', message);
}

function error(message) {
  writeLine('ERROR', message);
}

function promptHash(tierId, prompt) {
  const hash = crypto.createHash('sha256').update(prompt || '').digest('hex').substring(0, 12);
  writeLine('PROMPT', `Tier ${tierId} — hash=${hash} — longueur=${(prompt || '').length} caractères`);
}

function apiRequest(tierId, duration, status) {
  writeLine('API', `Tier ${tierId} — durée=${duration}ms — statut=${status}`);
}

function jsonParsing(tierNum, success, method, detail) {
  writeLine('PARSING', `Tier ${tierNum} — méthode=${method} — succès=${success}${detail ? ' — ' + detail : ''}`);
}

function evalResult(tierNum, taskId, passed, errors) {
  writeLine('EVAL', `Tier ${tierNum} — ${taskId} — ${passed ? 'PASS' : 'FAIL'}${errors ? ' — ' + errors : ''}`);
}

function vmError(tierNum, taskId, errMessage) {
  writeLine('VM_ERROR', `Tier ${tierNum} — ${taskId} — ${errMessage}`);
}

// Trace exhaustive d'un exercice pour diagnostic quand un eleve conteste une
// penalite. Capture TOUT ce qui permet de determiner si l erreur vient du
// modele (eleve) ou de l exercice (enonce/evaluateur). Les donnees sont loggees
// en JSON sur une seule ligne pour faciliter le grep et le parsing ulterieur.
// category : 'submit' | 'eval' | 'vm' | 'custom' | 'provider' | 'response'
function exercise(category, data) {
  try {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    writeLine('EXERCISE', `[${category}] ${payload}`);
  } catch (_) {
    writeLine('EXERCISE', `[${category}] (serialisation echouee)`);
  }
}

function modelDetection(modelName, paramSize, detected) {
  writeLine('MODEL_DETECTION', `modèle="${modelName}" — taille=${paramSize || 'inconnue'} — profil détecté=${detected}`);
}

function runConfig(configObj) {
  const summary = Object.entries(configObj || {}).map(([k, v]) => `${k}=${v}`).join(' | ');
  writeLine('CONFIG', summary);
}

function getFilePath() {
  return logFilePath;
}

function close() {
  // Avec appendFileSync, il n'y a pas de stream à fermer — no-op. On garde la
  // fonction pour rétro-compatibilité avec les appelants existants.
}

function closeSync() {
  // Idem : pas de stream asynchrone à vider. No-op (rétro-compat).
}

module.exports = {
  info,
  warn,
  error,
  promptHash,
  apiRequest,
  jsonParsing,
  evalResult,
  vmError,
  modelDetection,
  runConfig,
  exercise,
  getFilePath,
  setLogFile,
  truncateLogFile,
  close,
  closeSync
};
