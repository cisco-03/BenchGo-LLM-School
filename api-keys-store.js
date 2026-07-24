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

// Tous les providers gérés + le professeur OpenRouter (clé séparée).
const SUPPORTED_PROVIDERS = [
  'openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral',
  'deepseek', 'cohere', 'lmstudio', 'ollama', 'custom', 'teacher-openrouter'
];

function _loadFile() {
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
  try {
    data.savedAt = new Date().toISOString();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
  restoreIntoSession
};