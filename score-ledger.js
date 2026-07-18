const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { letterGrade } = require('./progress-bar');

const LEDGER_DIR = path.join(__dirname, 'Export-Rapports', '.carnet');

function ledgerPath(shortName) {
  return path.join(LEDGER_DIR, shortName + '.json');
}

function loadLedger(shortName) {
  const file = ledgerPath(shortName);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data.ecoles) data.ecoles = {};
      return data;
    }
  } catch (e) {
    logger.warn('Carnet de scores illisible, recréation : ' + e.message);
  }
  return { model: null, shortName: shortName, ecoles: {}, lastUpdated: null };
}

function saveLedger(ledger) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    ledger.lastUpdated = new Date().toISOString();
    fs.writeFileSync(ledgerPath(ledger.shortName), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.error('Impossible de sauvegarder le carnet de scores : ' + e.message);
  }
}

// Normalise une entrée d'école du carnet vers le format cumul { best, attempts }.
// Gère l'ancien format (entrée = résultat unique) et le nouveau format cumul.
function normalizeEcoleEntry(raw) {
  if (!raw) return { best: null, attempts: [] };
  // Nouveau format cumul
  if (raw.attempts && Array.isArray(raw.attempts)) {
    let best = raw.best;
    if (!best && raw.attempts.length > 0) best = pickBest(raw.attempts);
    return { best: best, attempts: raw.attempts.slice() };
  }
  // Ancien format (résultat unique) — migration
  if (raw.score != null || raw.max != null || raw.pct != null) {
    return { best: raw, attempts: [raw] };
  }
  // Inattendu
  return { best: null, attempts: [] };
}

// Sélectionne la meilleure tentative d'une liste (pct le plus élevé ; égalité -> dernière).
function pickBest(attempts) {
  if (!attempts || attempts.length === 0) return null;
  let best = attempts[0];
  for (let i = 1; i < attempts.length; i++) {
    if ((attempts[i].pct || 0) >= (best.pct || 0)) best = attempts[i];
  }
  return best;
}

// Conserve TOUTES les tentatives par école (historique des re-tests), la meilleure
// est référencée par `best` pour le classement global. Migration auto des anciens carnets.
function saveResult(shortName, modelName, result) {
  const ledger = loadLedger(shortName);
  ledger.model = modelName;
  ledger.shortName = shortName;
  const entry = normalizeEcoleEntry(ledger.ecoles[result.ecole]);
  entry.attempts.push(result);
  const newBest = pickBest(entry.attempts);
  const prevBest = entry.best;
  entry.best = newBest;
  ledger.ecoles[result.ecole] = entry;
  if (prevBest && newBest && newBest !== prevBest) {
    logger.info('Carnet : ' + result.ecole + ' nouvelle meilleure tentative (' + newBest.pct + '%, ' + entry.attempts.length + ' tentative(s) cumulée(s)).');
  } else {
    logger.info('Carnet : ' + result.ecole + ' tentative #' + entry.attempts.length + ' enregistrée (meilleure : ' + (newBest ? newBest.pct : '?') + '%).');
  }
  saveLedger(ledger);
  return ledger;
}

// Renvoie la meilleure tentative d'une entrée d'école (gère ancien et nouveau format).
function getEcoleBest(raw) {
  return normalizeEcoleEntry(raw).best;
}

// Renvoie la liste des tentatives (chronologique) d'une entrée d'école.
function getEcoleAttempts(raw) {
  return normalizeEcoleEntry(raw).attempts;
}

function computeGrandTotal(ledger) {
  const entries = Object.values(ledger.ecoles || {}).map(getEcoleBest).filter(Boolean);
  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  for (const e of entries) {
    score += e.score || 0;
    max += e.max || 0;
    globalLifeScore += e.globalLifeScore || 0;
    optionalBonus += e.optionalBonus || 0;
  }
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  return { score, max, pct, globalLifeScore, optionalBonus, ecoleCount: entries.length };
}

function printBilanGlobal(shortName, modelName) {
  const ledger = loadLedger(shortName);
  const rawEntries = Object.values(ledger.ecoles || {});
  const entries = rawEntries.map(getEcoleBest).filter(Boolean);
  if (entries.length === 0) return;

  console.log('');
  console.log('  \x1b[1;35m━━━ BILAN GLOBAL — ' + (modelName || shortName) + ' (cumul multi-écoles) ━━━\x1b[0m');
  console.log('  \x1b[90m' + 'École'.padEnd(20) + 'Points'.padStart(12) + 'Pct'.padStart(7) + '  Note   Statut' + '\x1b[0m');
  console.log('  \x1b[90m' + '─'.repeat(60) + '\x1b[0m');

  let totalScore = 0, totalMax = 0, totalBonus = 0, totalSante = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const raw = rawEntries[i];
    const attempts = getEcoleAttempts(raw);
    totalScore += e.score || 0;
    totalMax += e.max || 0;
    totalBonus += e.optionalBonus || 0;
    totalSante += e.globalLifeScore || 0;
    const pct = e.max > 0 ? Math.round((e.score / e.max) * 100) : 0;
    const g = letterGrade(pct);
    const status = e.mandatoryTotal > 0 ? (pct >= 70 ? '\x1b[32m✔ Validé\x1b[0m' : '\x1b[31m✘ Échec\x1b[0m') : '\x1b[36m(évaluée)\x1b[0m';
    const bonusTag = (e.optionalBonus > 0) ? ' \x1b[35m[+' + e.optionalBonus + ' bonus opt.]\x1b[0m' : '';
    const pts = (e.score || 0) + '/' + (e.max || 0);
    const histTag = attempts.length > 1 ? ' \x1b[90m(' + attempts.length + ' tentatives)\x1b[0m' : '';
    console.log('  ' + (e.ecole || '?').padEnd(20) + pts.padStart(12) + (pct + '%').padStart(7) + '  ' + g.color + g.grade + '\x1b[0m      ' + status + bonusTag + histTag);
  }

  const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  const totalGrade = letterGrade(totalPct);
  console.log('  \x1b[90m' + '─'.repeat(60) + '\x1b[0m');
  console.log('  \x1b[1m' + 'TOTAL CUMULÉ'.padEnd(20) + (totalScore + '/' + totalMax).padStart(12) + (totalPct + '%').padStart(7) + '  ' + totalGrade.color + totalGrade.grade + '\x1b[0m\x1b[1m  (Santé cumulée: ' + totalSante + ' PV)\x1b[0m');
  if (totalBonus > 0) {
    console.log('  \x1b[35m+ Bonus optionnel cumulé : ' + totalBonus + ' points\x1b[0m');
  }
  console.log('  \x1b[90mCarnet : ' + path.relative(process.cwd(), ledgerPath(shortName)) + '\x1b[0m');
  console.log('');
}

function buildBilanMarkdown(shortName, modelName) {
  const ledger = loadLedger(shortName);
  const rawEntries = Object.entries(ledger.ecoles || {});
  const entries = rawEntries.map(([k, v]) => getEcoleBest(v)).filter(Boolean);
  if (entries.length === 0) return '';
  const t = computeGrandTotal(ledger);

  let md = '\n---\n\n## Bilan Global Cumulé — ' + (modelName || shortName) + '\n\n';
  md += '> Cumul des écoles évaluées (meilleure tentative conservée par école).\n\n';
  md += '| École | Points | Quota | Pct | Note | Bonus opt. | Santé | Tentatives |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const raw = rawEntries[i][1];
    const attempts = getEcoleAttempts(raw);
    const pct = e.max > 0 ? Math.round((e.score / e.max) * 100) : 0;
    const g = letterGrade(pct);
    md += '| ' + e.ecole + ' | ' + e.score + ' | ' + e.max + ' | ' + pct + '% | ' + g.grade + ' | +' + (e.optionalBonus || 0) + ' | ' + (e.globalLifeScore || 0) + ' PV | ' + attempts.length + ' |\n';
  }
  md += '| **TOTAL CUMULÉ** | **' + t.score + '** | **' + t.max + '** | **' + t.pct + '%** | **' + letterGrade(t.pct).grade + '** | **+' + t.optionalBonus + '** | **' + t.globalLifeScore + ' PV** | — |\n';
  md += '\n> *Bonus optionnel cumulé : +' + t.optionalBonus + ' points (récompense pour les exercices optionnels réussis, au-delà du quota).*\n';
  return md;
}

// Sauvegarde le résultat courant puis renvoie le markdown du bilan (pour l'ajouter au rapport).
function saveAndBuildBilan(shortName, modelName, result) {
  saveResult(shortName, modelName, result);
  return buildBilanMarkdown(shortName, modelName);
}

// Calcule l'Indice de Calibration (C) entre le profil auto-déclaré du modèle et ses
// performances réelles dans le bac à sable.
//   D = niveau moyen déclaré (somme des levels / (5 * nbSkills))   -> [0, 1]
//   P = ratio de réussite des tâches réellement exécutées           -> [0, 1]
//   C = 1 - |D - P|                                                 -> [0, 1]
// testResults : [{ status: 'success' | 'failed' | 'bypassed' }]
function calculateCalibrationIndex(declaredProfile, testResults) {
  if (!declaredProfile || !declaredProfile.skills) {
    return { declaredLevel: 0, actualPerformance: 0, calibrationIndex: 1.0, executedCount: 0, successCount: 0 };
  }

  // D : niveau moyen déclaré sur 5, ramené à [0, 1]
  const levels = Object.values(declaredProfile.skills).map(s => s.level);
  const D = levels.length > 0 ? levels.reduce((sum, lvl) => sum + lvl, 0) / (levels.length * 5) : 0;

  // P : ratio de réussite des tâches réellement exécutées (status !== 'bypassed')
  const executed = (testResults || []).filter(t => t.status !== 'bypassed');
  const totalExecuted = executed.length;
  if (totalExecuted === 0) {
    return { declaredLevel: D, actualPerformance: 0, calibrationIndex: 1.0, executedCount: 0, successCount: 0 };
  }
  const totalSuccess = executed.filter(t => t.status === 'success').length;
  const P = totalSuccess / totalExecuted;

  const C = 1 - Math.abs(D - P);
  return {
    declaredLevel: D,
    actualPerformance: P,
    calibrationIndex: C,
    executedCount: totalExecuted,
    successCount: totalSuccess
  };
}

// Interprète l'Indice de Calibration en catégorie qualitative.
function interpretCalibration(C) {
  if (C >= 0.85) return 'Modèle Hautement Fiable / Lucide (connaît ses forces et ses limites)';
  if (C >= 0.65) return 'Modèle Modérément Calibré';
  return 'Biais de Surconfiance ou Sous-confiance Majeur (le modèle se surévalue ou se sous-évalue)';
}

module.exports = {
  loadLedger,
  saveResult,
  computeGrandTotal,
  printBilanGlobal,
  buildBilanMarkdown,
  saveAndBuildBilan,
  calculateCalibrationIndex,
  interpretCalibration,
  normalizeEcoleEntry,
  getEcoleBest,
  getEcoleAttempts,
  pickBest
};
