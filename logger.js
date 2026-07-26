const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const timestampTag = new Date().toISOString().replace(/[:.]/g, '-');
const logFilePath = path.join(LOG_DIR, `benchgo_${timestampTag}.log`);

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
  getFilePath,
  close,
  closeSync
};
