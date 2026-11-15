// api-keys-store.js — Stockage persistant local des clés API par provider.
//
// Problème (log benchgo_2026-07-20T07-31-39) : à chaque `node runner.js` il faut
// re-coller les clés API (élève + professeur OpenRouter) à chaque provider.
// C'est fastidieux. Les clés sont actuellement en mémoire de session
// (secrets.js) — elles disparaissent à la fermeture du processus.
//
// Solution : stocker les clés dans `.api-keys.json` à la racine du projet.
// SÉCURITÉ :
//   - `.api-keys.json` est ignoré par .gitignore (règle `*` qui ignore tout par
//     défaut, puis ré-autorisation explicite uniquement des sources `.js`).
//     Vérifié via `git check-ignore` : jamais poussé sur GitHub.
//   - Le fichier est stocké en clair LOCALEMENT uniquement (sur la machine de
//     l'utilisateur). C'est le même compromis que ~/.aws/credentials ou
//     ~/.npmrc : pratique pour l'usage local, jamais commité.
//   - L'utilisateur peut à tout moment effacer le fichier ou une clé via
//     `node runner.js --forget-key=provider`.
//
// Comportement interactif :
//   - À la 1re saisie d'une clé pour un provider, on propose de la mémoriser
//     localement (message explicatif : "si vous ouvrez une nouvelle fenêtre,
//     il faudra remettre les paramètres, mais la clé sera retrouvée").
//   - Au démarrage d'un run, on recharge toutes les clés mémorisées dans
//     secrets.js (mémoire de session) pour la durée du processus.
//   - Si l'utilisateur refuse la mémorisation, on garde le comportement
//     historique (mémoire de session uniquement, perdu à la fermeture).

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const KEYS_FILE = path.join(__dirname, '.api-keys.json');

// ─────────────────────────────────────────────────────────────────────────
// SÉCURITÉ DU FICHIER DE CLÉS (tâche 2026-11-15b, « sécurité en béton »)
// ─────────────────────────────────────────────────────────────────────────
// 1. auditKeysFile() : REFUSE un fichier qui n'est PAS un fichier normal
//    (symlink = attaque de redirection : une clé écrite partirait dans un
//    fichier choisi par un attaquant local ; FIFO/socket = idem). En cas de
//    fichier suspect : lecture vide + écriture refusée (jamais de crash).
// 2. hardenKeysFile() : permissions resserrées après CHAQUE écriture —
//    POSIX chmod 0600 ; Windows : icacls désactive l'héritage et limite aux
//    comptes de la session courante. Best-effort : un échec n'est JAMAIS
//    bloquant (une écriture de clé ne crashe pas un benchmark).
function auditKeysFile() {
  try {
    const st = fs.lstatSync(KEYS_FILE);
    if (st.isSymbolicLink()) return { safe: false, reason: 'symlink' };
    if (!st.isFile()) return { safe: false, reason: 'pas un fichier régulier' };
    return { safe: true, reason: null };
  } catch (_) {
    // Fichier absent : cas normal (création sûre par écriture directe).
    return { safe: true, reason: null };
  }
}

function hardenKeysFile() {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const user = process.env.USERNAME || process.env.USER || '';
      if (!user) return;
      execFileSync('icacls', [KEYS_FILE, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } catch (_) { /* best-effort : jamais bloquant */ }
  } else {
    try { fs.chmodSync(KEYS_FILE, 0o600); } catch (_) { /* best-effort */ }
  }
}

// Tous les providers gérés (élève + professeur). Informatif : saveKey accepte
// tout nom de provider (une clé cloud est stockée sous le nom du provider qui
// l'utilise, ex: 'ollama-cloud' pour l'abonnement, 'kilo' pour la Gateway).
const SUPPORTED_PROVIDERS = [
  'openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral',
  'deepseek', 'cohere', 'kilo', 'lmstudio', 'ollama', 'ollama-cloud', 'custom',
  'teacher-openrouter'
];

function _loadFile() {
  // Sécurité : fichier suspect (symlink, non-régulier) → traité comme ABSENT.
  // On ne lit JAMAIS une cible contrôlée par un tiers, et on ignore le contenu
  // suspect pour la session (un avertissement explicite guide l'utilisateur).
  const audit = auditKeysFile();
  if (!audit.safe) {
    logger.warn(`api-keys-store : fichier suspect (${audit.reason}) — clés ignorées pour cette session. Supprimez ${KEYS_FILE} et resaisissez vos clés.`);
    return { keys: {}, savedAt: null };
  }
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      if (data && typeof data === 'object' && data.keys) return data;
    }
  } catch (e) {
    logger.warn(`api-keys-store : fichier illisible, recréation : ${e.message}`);
  }
  return { keys: {}, savedAt: null };
}

function _saveFile(data) {
  // Sécurité : jamais d'écriture dans un fichier suspect (symlink de
  // redirection = une clé partirait dans un fichier tiers contrôlé).
  const audit = auditKeysFile();
  if (!audit.safe) {
    logger.error(`api-keys-store : écriture REFUSÉE (fichier suspect : ${audit.reason}). Clé non persistée.`);
    return;
  }
  try {
    data.savedAt = new Date().toISOString();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    hardenKeysFile();
  } catch (e) {
    logger.error(`api-keys-store : impossible d'écrire le fichier : ${e.message}`);
  }
}

// Renvoie toutes les clés stockées { provider: key } (objet vide si aucune).
function loadAllKeys() {
  const data = _loadFile();
  return data.keys || {};
}

// Renvoie la clé pour un provider, ou null.
function getKey(provider) {
  if (!provider) return null;
  const data = _loadFile();
  return data.keys[provider] || null;
}

// Stocke (ou écrase) une clé pour un provider. Valeur vide/falsy = suppression.
function saveKey(provider, value) {
  if (!provider) return false;
  const data = _loadFile();
  if (!value) {
    delete data.keys[provider];
  } else {
    data.keys[provider] = value;
  }
  _saveFile(data);
  return Boolean(value);
}

// Supprime une clé pour un provider.
function forgetKey(provider) {
  if (!provider) return false;
  const data = _loadFile();
  const existed = Boolean(data.keys[provider]);
  delete data.keys[provider];
  if (existed) _saveFile(data);
  return existed;
}

// Charge toutes les clés mémorisées dans secrets.js (mémoire de session) au
// démarrage d'un run. Appelé avant le questionnaire : les clés retrouvées
// évitent la re-saisie. Les clés de provider non-stockées restent null et
// seront demandées interactivement.
function restoreIntoSession(secrets) {
  if (!secrets) return;
  const stored = loadAllKeys();
  let restored = 0;
  for (const [provider, key] of Object.entries(stored)) {
    if (key && !secrets.hasSecret(provider)) {
      secrets.rememberSecret(provider, key);
      restored++;
    }
  }
  if (restored > 0) {
    logger.info(`api-keys-store : ${restored} clé(s) rechargée(s) depuis .api-keys.json (mémoire de session restaurée).`);
  }
  return restored;
}

module.exports = {
  KEYS_FILE,
  SUPPORTED_PROVIDERS,
  loadAllKeys,
  getKey,
  saveKey,
  forgetKey,
  restoreIntoSession,
  auditKeysFile,
  hardenKeysFile
};