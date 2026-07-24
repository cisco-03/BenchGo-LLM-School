// presets.js — Presets de configuration persistants pour les runs répétés.
//
// Problème (log benchgo_2026-07-20T07-31-39) : à chaque `node runner.js` il faut
// re-saisir TOUT le questionnaire (fournisseur, modèle, profil, contexte, cible,
// professeur...). C'est fastidieux quand on relance plusieurs fois le même run
// dans la même fenêtre CMD.
//
// Solution : un fichier `.presets.json` à la racine stocke des configurations
// nommées réutilisables. Sécurité :
//   - Les clés API NE SONT JAMAIS stockées dans le preset. Elles restent en
//     mémoire de session (secrets.js) ou via variables d'environnement.
//   - `.presets.json` est ignoré par .gitignore (règle `*` puis ré-autorisation
//     explicite uniquement des sources JS) : il ne sera jamais commité sur
//     GitHub. De plus on n'écrit jamais de secret dedans.
//
// Utilisation CLI :
//   node runner.js --preset=mon-preset   → charge le preset sans questionnaire
//   node runner.js --save-preset=nom      → sauvegarde la config courante et quitte
//   node runner.js --list-presets        → liste les presets et quitte
//   node runner.js --delete-preset=nom   → supprime un preset et quitte

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const cliTable = require('./cli-table');

const PRESETS_FILE = path.join(__dirname, '.presets.json');

// Champs NON-sensibles qu'on persiste dans un preset. Les clés API sont exclues.
const PRESET_FIELDS = [
  'provider', 'model', 'endpoint', 'profile', 'contextLimitTokens',
  'quantization', 'tier', 'teacherEnabled', 'teacherModel', 'teacherEndpoint'
];

function _loadFile() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
      if (data && typeof data === 'object' && data.presets) return data;
    }
  } catch (e) {
    logger.warn(`Presets : fichier illisible, recréation : ${e.message}`);
  }
  return { presets: {} };
}

function _saveFile(data) {
  try {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.error(`Presets : impossible d'écrire le fichier : ${e.message}`);
  }
}

// Liste les noms de presets disponibles. Retourne [{ name, ...summary }].
function listPresets() {
  const data = _loadFile();
  return Object.keys(data.presets).map(name => {
    const p = data.presets[name];
    return {
      name,
      provider: p.provider || '?',
      model: p.model || '?',
      profile: p.profile || '?',
      tier: p.tier || 'all'
    };
  });
}

// Charge un preset par nom. Retourne null si introuvable.
function loadPreset(name) {
  if (!name) return null;
  const data = _loadFile();
  return data.presets[name] || null;
}

// Sauvegarde un preset. `config` ne doit contenir que des champs non-sensibles
// (les clés API sont filtrées par sécurité même si on les reçoit par erreur).
function savePreset(name, config) {
  if (!name) throw new Error('Nom de preset requis.');
  const clean = {};
  for (const f of PRESET_FIELDS) {
    if (config[f] !== undefined && config[f] !== null && config[f] !== '') {
      clean[f] = config[f];
    }
  }
  // Paranoïa : on ne stocke JAMAIS de clé API même si on la reçoit.
  delete clean.apiKey;
  delete clean.teacherApiKey;
  const data = _loadFile();
  data.presets[name] = clean;
  _saveFile(data);
  logger.info(`Preset '${name}' sauvegardé (clés API non incluses par sécurité).`);
  return clean;
}

function deletePreset(name) {
  if (!name) return false;
  const data = _loadFile();
  if (!data.presets[name]) return false;
  delete data.presets[name];
  _saveFile(data);
  logger.info(`Preset '${name}' supprimé.`);
  return true;
}

// Affiche la liste des presets en console (pour --list-presets).
function printPresets() {
  const presets = listPresets();
  if (presets.length === 0) {
    console.log('  \x1b[90mAucun preset enregistré.\x1b[0m');
    console.log('  \x1b[90mCréez-en un avec : node runner.js --save-preset=nom (après avoir configuré un run).\x1b[0m');
    return;
  }
  console.log('  \x1b[1;36m━━━ PRESETS DISPONIBLES ━━━\x1b[0m');
  const pHeaders = ['Nom', 'Fournisseur', 'Modèle', 'Profil', 'Cible'];
  const pAligns = ['left', 'left', 'left', 'left', 'right'];
  const pRows = presets.map(p => [`\x1b[1m${p.name}\x1b[0m`, p.provider, p.model || '', p.profile, String(p.tier)]);
  const pRes = cliTable.table(pHeaders, pRows, { colAligns: pAligns, separator: '  ' });
  console.log(`  \x1b[90m${pRes.lines[0]}\x1b[0m`);
  console.log(`  \x1b[90m${pRes.sepLine}\x1b[0m`);
  for (let i = 2; i < pRes.lines.length; i++) {
    console.log(`  ${pRes.lines[i]}`);
  }
  console.log('');
  console.log('  \x1b[90mUsage : node runner.js --preset=nom\x1b[0m');
}

module.exports = {
  PRESETS_FILE,
  PRESET_FIELDS,
  listPresets,
  loadPreset,
  savePreset,
  deletePreset,
  printPresets
};