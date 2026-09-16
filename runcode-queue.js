// runcode-queue.js - Liste d'attente RunCode (tâche 2026-09-16)
//
// Après un examen RunCode (tremplin), l'utilisateur peut « mettre le modèle en
// réserve » : le modèle rejoint une LISTE D'ATTENTE persistante (.benchgo-
// runcode-queue.json). Au démarrage d'un batch de nuit (night-batch.js), cette
// liste est lue et les modèles inscrits passent EN PRIORITÉ (tête de file) :
// c'est le pont entre le pré-examen RunCode et la grande école.
//
// Principe :
//   - Fichier plat JSON à la racine : { "entries": [ { modelKey, addedAt, ... } ] }
//   - Dédupliqué par modelKey (un modèle ne peut pas y figurer deux fois).
//   - L'inscription depuis le runner ne dépend PAS du TTY (one-shot possible
//     via --queue-runcode), la proposition interactive n'apparaît qu'en TTY.
//   - La consommation par night-batch retire les entrées dont le modèle n'est
//     plus présent dans lms ls (GGUF supprimé = entrée obsolète).
//   - Rétention 30 jours (comme .benchgo-progress.json) : une entrée trop
//     ancienne n'a plus de sens, le tremplin sera simplement repassé.

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '.benchgo-runcode-queue.json');
const RETENTION_MS = 30 * 24 * 3600 * 1000; // 30 jours

function loadQueue() {
  try {
    const d = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!d || !Array.isArray(d.entries)) return { entries: [] };
    // Purge des entrées périmées (> 30 jours).
    const cutoff = Date.now() - RETENTION_MS;
    d.entries = d.entries.filter(e => {
      const t = e && e.addedAt ? Date.parse(e.addedAt) : 0;
      return t > 0 && t >= cutoff;
    });
    return d;
  } catch (_) {
    return { entries: [] };
  }
}

function saveQueue(queue) {
  const tmp = QUEUE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
  fs.renameSync(tmp, QUEUE_FILE);
}

// Inscrit un modèle dans la liste d'attente. Non-doublonné par modelKey.
// metadata : { displayName, quantization, parcours, pct, specialite, diplome }
// (tout est optionnel, sert à l'affichage de la file dans night-batch).
function enqueue(modelKey, metadata = {}) {
  if (!modelKey) return false;
  const q = loadQueue();
  const existing = q.entries.find(e => e.modelKey === modelKey);
  if (existing) {
    // Rafraîchit les métadonnées (le tremplin a pu être repassé) mais garde
    // l'ordre historique d'inscription (addedAt d'origine).
    existing.displayName = metadata.displayName || existing.displayName || null;
    existing.quantization = metadata.quantization || existing.quantization || null;
    existing.parcours = metadata.parcours || existing.parcours || null;
    existing.pct = metadata.pct != null ? metadata.pct : (existing.pct != null ? existing.pct : null);
    existing.specialite = metadata.specialite || existing.specialite || null;
    existing.diplome = metadata.diplome || existing.diplome || null;
    existing.updatedAt = new Date().toISOString();
  } else {
    q.entries.push({
      modelKey,
      addedAt: new Date().toISOString(),
      displayName: metadata.displayName || null,
      quantization: metadata.quantization || null,
      parcours: metadata.parcours || null,
      pct: metadata.pct != null ? metadata.pct : null,
      specialite: metadata.specialite || null,
      diplome: metadata.diplome || null
    });
  }
  saveQueue(q);
  return true;
}

// Retire un modèle de la liste (utilisé après passage à la grande école, ou
// demande explicite de l'utilisateur). Renvoie true si l'entrée a été retirée.
function dequeue(modelKey) {
  const q = loadQueue();
  const before = q.entries.length;
  q.entries = q.entries.filter(e => e.modelKey !== modelKey);
  if (q.entries.length < before) {
    saveQueue(q);
    return true;
  }
  return false;
}

// Liste les entrées courantes (purge incluse).
function listQueue() {
  return loadQueue().entries;
}

// Vérifie la présence d'un modèle dans la file.
function isQueued(modelKey) {
  return loadQueue().entries.some(e => e.modelKey === modelKey);
}

module.exports = { enqueue, dequeue, listQueue, isQueued, QUEUE_FILE, RETENTION_MS };