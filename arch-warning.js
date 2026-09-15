// --- Registre des modèles INCOMPATIBLES (architecture GGUF non supportée) ---
// Un GGUF dont l'architecture n'est pas connue du runtime llama.cpp de LM
// Studio (ex: k2-horizon, issue #28361) ne peut pas être chargé. Ce n'est NI
// un bug BenchGo NI un GGUF corrompu : le modèle est simplement trop récent
// pour le runtime installé, et le support llama.cpp peut mettre 2-3 semaines
// à arriver. Ce module :
//   1. mémorise les modèles détectés incompatibles dans
//      .benchgo-incompatible.json (modelKey, architecture, date, raison) ;
//   2. affiche un AVERTISSEMENT clair (⚠ MODÈLE NON COMPATIBLE) au lieu du
//      JSON brut, partout : grande école, RunCode (tremplin + interactif),
//      mode nuit ;
//   3. fournit une liste de rappel (--incompatible-list) pour retester le
//      modèle plus tard, quand une mise à jour de LM Studio/llama.cpp aura
//      ajouté le support de l'architecture.
//
// Le modèle est mis de côté (isolé auto) pour ne plus bloquer les batchs,
// mais on CONSERVE la trace pour rappeler de retélécharger sur Hugging Face
// quand le runtime sera à jour.
const fs = require('fs');
const path = require('path');

const INCOMPATIBLE_FILE = path.join(__dirname, '.benchgo-incompatible.json');

// Charge le registre : { "<modelKey>": { model, architecture, firstSeen, lastSeen, reason, attempts } }
function loadIncompatible() {
  try {
    if (fs.existsSync(INCOMPATIBLE_FILE)) {
      const d = JSON.parse(fs.readFileSync(INCOMPATIBLE_FILE, 'utf8'));
      if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    }
  } catch (e) { /* ignore fichier corrompu */ }
  return {};
}

function saveIncompatible(obj) {
  try {
    fs.writeFileSync(INCOMPATIBLE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* ignore erreur disque */ }
}

// Détecte une erreur de chargement liée à l'architecture. True si le message
// ressemble à « unknown model architecture: 'xxx' » ou « Failed to load model ».
function isArchitectureError(message) {
  const m = String(message || '');
  return /unknown model architecture/i.test(m)
    || (/failed to load model/i.test(m) && /HTTP_400/i.test(m));
}

// Extrait le nom d'architecture depuis le message (ex: 'k2-horizon'). La
// quote est optionnelle : llama.cpp l'affiche généralement, mais les wrappers
// (lms, LM Studio) peuvent l'omettre.
function extractArchitecture(message) {
  const m = /unknown model architecture:\s*'?"?([a-z0-9_.-]+)'?"?/i.exec(String(message || ''));
  return m ? m[1] : null;
}

// Enregistre un modèle comme incompatible (met à jour lastSeen si déjà présent).
// Si l'architecture n'est ni dans opts ni dans le message (cas HTTP_400 JSON
// de LM Studio qui ne dit pas la cause), on tente de la lire depuis l'index
// `lms ls --json` (le champ architecture du modèle y est toujours présent).
function recordIncompatible(modelKey, opts = {}) {
  if (!modelKey) return false;
  const reg = loadIncompatible();
  const prev = reg[modelKey];
  let architecture = opts.architecture || extractArchitecture(opts.reason) || (prev && prev.architecture) || null;
  if (!architecture) {
    architecture = archFromLmsLs(modelKey);
  }
  reg[modelKey] = {
    model: modelKey,
    displayName: opts.displayName || prev?.displayName || null,
    publisher: opts.publisher || prev?.publisher || null,
    quantization: opts.quantization || prev?.quantization || null,
    architecture,
    firstSeen: prev?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    reason: opts.reason || prev?.reason || 'Architecture GGUF non supportée par le runtime llama.cpp de LM Studio',
    attempts: (prev?.attempts || 0) + 1
  };
  saveIncompatible(reg);
  return !prev; // true si première détection
}

// Lit l'architecture d'un modelKey depuis l'index LM Studio (lms ls --json).
// Fallback silencieux : lms absent ou modèle absent → null. Permet d'afficher
// l'arch exacte (ex: k2-horizon) même quand le message HTTP_400 ne la mentionne
// pas (le JSON d'erreur de LM Studio dit juste « Failed to load model »).
function archFromLmsLs(modelKey) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('lms', ['ls', '--json', '--llm'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const arr = JSON.parse(r.stdout);
    if (!Array.isArray(arr)) return null;
    const found = arr.find(m => m && m.modelKey === modelKey);
    return (found && found.architecture) || null;
  } catch (_) { return null; }
}

// Retire un modèle du registre (support de l'arch ajouté = GGUF chargeable à nouveau).
function clearIncompatible(modelKey) {
  const reg = loadIncompatible();
  if (!reg[modelKey]) return false;
  delete reg[modelKey];
  saveIncompatible(reg);
  return true;
}

// Liste triée (plus récents d'abord).
function listIncompatible() {
  const reg = loadIncompatible();
  return Object.values(reg).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// Message d'avertissement complet, à afficher dès la détection.
function incompatibleWarningText(modelKey, opts = {}) {
  const arch = opts.architecture || extractArchitecture(opts.reason) || 'inconnue';
  const lines = [
    '',
    '  \x1b[1;33m⚠⚠⚠  MODÈLE NON COMPATIBLE — ARCHITECTURE GGUF NON SUPPORTÉE  ⚠⚠⚠\x1b[0m',
    `  \x1b[33mLe modèle « ${modelKey} » a un PROBLÈME DE STRUCTURE :\x1b[0m`,
    `  \x1b[33mson architecture GGUF « ${arch} » n'est PAS connue du runtime llama.cpp\x1b[0m`,
    `  \x1b[33minstallé dans LM Studio (trop récent pour le runtime actuel).\x1b[0m`,
    '  \x1b[90mCe n\'est NI un bug BenchGo NI un modèle défectueux : le support llama.cpp\x1b[0m',
    '  \x1b[90mpeut mettre 2-3 semaines à arriver (ex: k2-horizon — issue #28361).\x1b[0m',
    '  \x1b[33m→ Il est mis de côté dans le registre des incompatibles\x1b[0m',
    '  \x1b[33m  (.benchgo-incompatible.json) pour rappeler de le retélécharger plus tard.\x1b[0m',
    '  \x1b[90m→ Solution : mettre à jour LM Studio + runtimes llama.cpp, ou retélécharger\x1b[0m',
    '  \x1b[90m  le GGUF sur Hugging Face quand l\'éditeur/support aura évolué.\x1b[0m',
    '  \x1b[90m→ Rappel de la liste : node night-batch.js --incompatible-list\x1b[0m',
    ''
  ];
  return lines.join('\n');
}

// Affiche le registre des modèles mis de côté.
function printIncompatibleList() {
  const items = listIncompatible();
  if (items.length === 0) {
    console.log('\n  \x1b[32mAucun modèle incompatible dans le registre (.benchgo-incompatible.json est vide).\x1b[0m');
    console.log('  \x1b[90mLes modèles détectés avec une architecture non supportée par llama.cpp y seront ajoutés automatiquement.\x1b[0m');
    return;
  }
  console.log(`\n  \x1b[1;33m=== MODÈLES MIS DE CÔTÉ — INCOMPATIBLES AVEC LE RUNTIME LLAMA.CPP ACTUEL (${items.length}) ===\x1b[0m`);
  console.log('  \x1b[90mCes modèles ont une architecture GGUF inconnue de LM Studio. Ils sont exclus des batchs.\x1b[0m');
  console.log('  \x1b[90mRAPPEL : retéléchargez-les sur Hugging Face (ou mettez LM Studio à jour) quand le support sera ajouté.\x1b[0m\n');
  for (const it of items) {
    const name = (it.displayName || it.model).padEnd(30);
    const arch = (it.architecture || '?').padEnd(14);
    const quant = (it.quantization || '—').padEnd(8);
    const pub = (it.publisher || '—').padEnd(14);
    const date = (it.firstSeen || '—').slice(0, 10);
    const seen = it.lastSeen ? it.lastSeen.slice(0, 10) : '—';
    console.log(`  \x1b[31m⊘\x1b[0m ${name} arch=${arch} ${quant} ${pub} détecté: ${date} dernier échec: ${seen}`);
    if (it.reason) console.log(`    \x1b[90mRaison : ${it.reason}\x1b[0m`);
  }
  console.log('');
}

module.exports = {
  INCOMPATIBLE_FILE,
  loadIncompatible,
  saveIncompatible,
  isArchitectureError,
  extractArchitecture,
  recordIncompatible,
  clearIncompatible,
  listIncompatible,
  incompatibleWarningText,
  printIncompatibleList
};