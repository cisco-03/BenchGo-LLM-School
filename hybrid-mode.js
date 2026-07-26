// hybrid-mode.js — Mode nuit hybride : auto-soumission GitHub avec file persistante.
//
// Plan §5 (Intégration / Automatisation) : variante --hybrid qui soumet
// automatiquement les résultats vers GitHub SI le seuil de qualité est atteint,
// avec une file d'attente persistante en cas d'échec réseau. Les soumissions
// en attente sont rejouées au prochain run.
//
// Seuil par défaut : un modèle est soumis si son score global ≥ 50% (PARTIEL ou
// RECOMMANDÉ). Configurable via HYBRID_SUBMIT_THRESHOLD (pourcentage).
//
// La file persistante est stockée dans Export-Rapports/.hybrid-queue.json. Chaque
// entrée contient le shortName, le modèle, le score, et la date de la tentative.
// Les entrées réussies sont supprimées ; les échouées sont conservées pour retry.
//
// Tout est journalisé pour diagnostic : chaque décision (soumission / mise en
// file / retry / succès / échec) est tracée avec le code court approprié.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const communitySync = require('./community-sync');
const { BenchgoError } = require('./cli-help');

const QUEUE_FILE = path.join(__dirname, 'Export-Rapports', '.hybrid-queue.json');
const DEFAULT_SUBMIT_THRESHOLD = 50; // % minimum pour soumettre (PARTIEL ou +)

// Charge la file d'attente persistante (ou crée une file vide).
function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      if (Array.isArray(data.pending)) return data;
    }
  } catch (e) {
    logger.warn('Hybrid: file d\'attente illisible — ' + e.message + ' (recréation)');
  }
  return { pending: [], lastRetry: null };
}

// Sauvegarde la file d'attente persistante.
function saveQueue(queue) {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn('Hybrid: échec sauvegarde file d\'attente — ' + e.message);
  }
}

// Ajoute un modèle à la file d'attente (en cas d\'échec réseau).
function enqueue(entry) {
  const queue = loadQueue();
  // Évite les doublons (même shortName).
  const exists = queue.pending.some(e => e.shortName === entry.shortName);
  if (!exists) {
    queue.pending.push({ ...entry, enqueuedAt: new Date().toISOString() });
    saveQueue(queue);
    logger.info('Hybrid: modèle mis en file d\'attente — ' + entry.shortName + ' (file=' + queue.pending.length + ')');
  }
}

// Retire un modèle de la file (après succès de soumission).
function dequeue(shortName) {
  const queue = loadQueue();
  const before = queue.pending.length;
  queue.pending = queue.pending.filter(e => e.shortName !== shortName);
  if (queue.pending.length < before) {
    saveQueue(queue);
    logger.info('Hybrid: modèle retiré de la file — ' + shortName + ' (file=' + queue.pending.length + ')');
  }
}

// Tente de soumettre un modèle. Renvoie true si succès, false sinon.
async function trySubmit(shortName, ledger, token, options) {
  try {
    const result = await communitySync.submitResults(shortName, ledger, token, options);
    if (result && result.ok !== false) {
      logger.info('Hybrid: soumission réussie pour ' + shortName);
      return true;
    }
    logger.warn('Hybrid: soumission échouée pour ' + shortName + ' — ' + (result && result.error ? result.error : 'réponse inattendue'));
    return false;
  } catch (e) {
    logger.warn('Hybrid: exception soumission ' + shortName + ' — ' + e.message);
    return false;
  }
}

// Décide si un modèle doit être soumis automatiquement (seuil atteint).
function shouldAutoSubmit(summary, threshold) {
  const t = typeof threshold === 'number' ? threshold : DEFAULT_SUBMIT_THRESHOLD;
  const pct = summary && typeof summary.pct === 'number' ? summary.pct : 0;
  return pct >= t;
}

// Traite la file d\'attente : rejoue toutes les soumissions en attente.
// Appelé au démarrage d\'un run --hybrid pour vider la file réseau.
async function drainQueue(token) {
  const queue = loadQueue();
  if (queue.pending.length === 0) return { drained: 0, succeeded: 0, failed: 0 };
  logger.info('Hybrid: traitement de la file d\'attente — ' + queue.pending.length + ' modèle(s) en attente');
  const { loadLedger } = require('./score-ledger');
  let succeeded = 0, failed = 0;
  const stillPending = [];
  for (const entry of queue.pending) {
    const ledger = loadLedger(entry.shortName);
    if (!ledger || !ledger.ecoles || Object.keys(ledger.ecoles).length === 0) {
      logger.warn('Hybrid: carnet vide pour ' + entry.shortName + ' — retiré de la file');
      continue;
    }
    const ok = await trySubmit(entry.shortName, ledger, token, { pseudo: null, benchgoVersion: 'V3' });
    if (ok) succeeded++;
    else { failed++; stillPending.push(entry); }
  }
  queue.pending = stillPending;
  queue.lastRetry = new Date().toISOString();
  saveQueue(queue);
  logger.info('Hybrid: file drainée — succès=' + succeeded + ' échecs=' + failed + ' restant=' + stillPending.length);
  return { drained: succeeded + failed, succeeded, failed };
}

// Soumet un modèle (ou le met en file si échec). Fonction principale appelée
// par le runner en mode --hybrid après un run réussi.
async function submitOrEnqueue(shortName, ledger, summary, token) {
  if (!token) {
    logger.warn('Hybrid: pas de token GitHub — mise en file d\'attente (sera soumis au prochain run --hybrid avec token)');
    enqueue({ shortName, model: ledger.model, pct: summary && summary.pct });
    return { submitted: false, queued: true, reason: 'no_token' };
  }
  if (!shouldAutoSubmit(summary)) {
    logger.info('Hybrid: ' + shortName + ' sous le seuil de soumission (' + (summary && summary.pct) + '% < ' + DEFAULT_SUBMIT_THRESHOLD + '%) — non soumis');
    return { submitted: false, queued: false, reason: 'below_threshold' };
  }
  const ok = await trySubmit(shortName, ledger, token, { pseudo: communitySync.getPublicPseudo(), benchgoVersion: 'V3' });
  if (ok) {
    dequeue(shortName);
    return { submitted: true, queued: false };
  }
  enqueue({ shortName, model: ledger.model, pct: summary && summary.pct });
  return { submitted: false, queued: true, reason: 'submit_failed' };
}

module.exports = {
  loadQueue,
  saveQueue,
  enqueue,
  dequeue,
  trySubmit,
  shouldAutoSubmit,
  drainQueue,
  submitOrEnqueue,
  DEFAULT_SUBMIT_THRESHOLD,
  QUEUE_FILE
};