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

// Conserve la meilleure tentative par école (pct le plus élevé ; égalité -> remplace par la plus récente).
function saveResult(shortName, modelName, result) {
  const ledger = loadLedger(shortName);
  ledger.model = modelName;
  ledger.shortName = shortName;
  const existing = ledger.ecoles[result.ecole];
  if (!existing || (result.pct >= existing.pct)) {
    ledger.ecoles[result.ecole] = result;
  } else {
    logger.info('Carnet : ' + result.ecole + ' conserve sa meilleure tentative (' + existing.pct + '% > ' + result.pct + '%).');
  }
  saveLedger(ledger);
  return ledger;
}

function computeGrandTotal(ledger) {
  const entries = Object.values(ledger.ecoles || {});
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
  const entries = Object.values(ledger.ecoles || {});
  if (entries.length === 0) return;

  console.log('');
  console.log('  \x1b[1;35m━━━ BILAN GLOBAL — ' + (modelName || shortName) + ' (cumul multi-écoles) ━━━\x1b[0m');
  console.log('  \x1b[90m' + 'École'.padEnd(20) + 'Points'.padStart(12) + 'Pct'.padStart(7) + '  Note   Statut' + '\x1b[0m');
  console.log('  \x1b[90m' + '─'.repeat(60) + '\x1b[0m');

  let totalScore = 0, totalMax = 0, totalBonus = 0, totalSante = 0;
  for (const e of entries) {
    totalScore += e.score || 0;
    totalMax += e.max || 0;
    totalBonus += e.optionalBonus || 0;
    totalSante += e.globalLifeScore || 0;
    const pct = e.max > 0 ? Math.round((e.score / e.max) * 100) : 0;
    const g = letterGrade(pct);
    const status = e.mandatoryTotal > 0 ? (pct >= 70 ? '\x1b[32m✔ Validé\x1b[0m' : '\x1b[31m✘ Échec\x1b[0m') : '\x1b[36m(évaluée)\x1b[0m';
    const bonusTag = (e.optionalBonus > 0) ? ' \x1b[35m[+' + e.optionalBonus + ' bonus opt.]\x1b[0m' : '';
    const pts = (e.score || 0) + '/' + (e.max || 0);
    console.log('  ' + (e.ecole || '?').padEnd(20) + pts.padStart(12) + (pct + '%').padStart(7) + '  ' + g.color + g.grade + '\x1b[0m      ' + status + bonusTag);
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
  const entries = Object.values(ledger.ecoles || {});
  if (entries.length === 0) return '';
  const t = computeGrandTotal(ledger);

  let md = '\n---\n\n## Bilan Global Cumulé — ' + (modelName || shortName) + '\n\n';
  md += '> Cumul des écoles évaluées (meilleure tentative conservée par école).\n\n';
  md += '| École | Points | Quota | Pct | Note | Bonus opt. | Santé |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const e of entries) {
    const pct = e.max > 0 ? Math.round((e.score / e.max) * 100) : 0;
    const g = letterGrade(pct);
    md += '| ' + e.ecole + ' | ' + e.score + ' | ' + e.max + ' | ' + pct + '% | ' + g.grade + ' | +' + (e.optionalBonus || 0) + ' | ' + (e.globalLifeScore || 0) + ' PV |\n';
  }
  md += '| **TOTAL CUMULÉ** | **' + t.score + '** | **' + t.max + '** | **' + t.pct + '%** | **' + letterGrade(t.pct).grade + '** | **+' + t.optionalBonus + '** | **' + t.globalLifeScore + ' PV** |\n';
  md += '\n> *Bonus optionnel cumulé : +' + t.optionalBonus + ' points (récompense pour les exercices optionnels réussis, au-delà du quota).*\n';
  return md;
}

// Sauvegarde le résultat courant puis renvoie le markdown du bilan (pour l'ajouter au rapport).
function saveAndBuildBilan(shortName, modelName, result) {
  saveResult(shortName, modelName, result);
  return buildBilanMarkdown(shortName, modelName);
}

module.exports = {
  loadLedger,
  saveResult,
  computeGrandTotal,
  printBilanGlobal,
  buildBilanMarkdown,
  saveAndBuildBilan
};
