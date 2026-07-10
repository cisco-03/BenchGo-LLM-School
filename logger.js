const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const timestampTag = new Date().toISOString().replace(/[:.]/g, '-');
const logFilePath = path.join(LOG_DIR, `benchgo_${timestampTag}.log`);
const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

function writeLine(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  stream.write(line);
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
  stream.end();
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
  close
};
