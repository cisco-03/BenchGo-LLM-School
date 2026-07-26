// health-sentinels.js — Sentinelles sanitaires exécutables avant chaque run.
//
// Plan §4 (Maintenabilité / Architecture) : garanties de non-régression
// exécutables en amont de chaque run. Détecte :
//   1. Valeurs NaN dans les résultats parsés (sortie de modèle corrompue).
//   2. Incohérence des sommes de points (points > maxPoints, somme inégale).
//   3. Seuils de cohérence (pct hors [0,100], santé absurde, etc.)
//
// Ces sentinelles sont NON BLOQUANTES par défaut (elles journalisent un WARN)
// mais peuvent être activées en mode strict (--strict-sentinels) pour faire
// échouer le run dès qu'une incohérence est détectée. Cela évite de produire
// des rapports/carnets avec des données corrompues silencieusement.

const logger = require('./logger');

// Résultat d'une sentinelle : { ok, code, detail, severity }
//   ok : true si la sentinelle est passée, false si une incohérence est détectée.
//   severity : 'warn' (non bloquant) ou 'error' (bloquant en mode strict).

// Sentinelle 1 : détection de NaN dans un résultat d'évaluation.
function checkNoNaN(evalResult, task) {
  const problems = [];
  const check = (v, label) => {
    if (typeof v === 'number' && Number.isNaN(v)) problems.push(label + ' = NaN');
  };
  check(evalResult.points, 'points');
  check(evalResult.maxPoints, 'maxPoints');
  if (evalResult.points != null && evalResult.maxPoints != null) {
    const pct = (evalResult.points / evalResult.maxPoints) * 100;
    check(pct, 'pct calculé');
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'S1_NAN_DETECTED',
      detail: `Tâche ${task ? task.id : '?'} — ${problems.join(', ')}`,
      severity: 'error'
    };
  }
  return { ok: true, code: 'S1', detail: '', severity: 'warn' };
}

// Sentinelle 2 : cohérence des sommes de points.
// Vérifie que la somme des points par exercice = score global du tier, et que
// points <= maxPoints pour chaque exercice.
function checkPointsConsistency(evalResults, tierPassedCount, tierTotalCount) {
  const problems = [];
  let sumPoints = 0, sumMax = 0;
  for (const r of evalResults) {
    const pts = r.points || 0;
    const max = r.maxPoints || 0;
    sumPoints += pts;
    sumMax += max;
    if (pts > max) {
      problems.push(`${r.id}: points (${pts}) > maxPoints (${max})`);
    }
    if (pts < 0) {
      problems.push(`${r.id}: points négatifs (${pts})`);
    }
  }
  // La somme des exercices réussis doit correspondre au tierPassedCount (sauf si
  // des exercices ont été bypassés — on tolère un écart dans ce cas).
  const successCount = evalResults.filter(r => r.status === 'success').length;
  if (successCount !== tierPassedCount) {
    // Tolérance : les exercices bypassés ne comptent pas dans le tierPassedCount
    // mais peuvent être dans successCount si mal étiquetés. On WARN seulement.
    problems.push(`successCount (${successCount}) != tierPassedCount (${tierPassedCount})`);
  }
  if (sumMax !== tierTotalCount && tierTotalCount > 0) {
    problems.push(`somme maxPoints (${sumMax}) != tierTotalCount (${tierTotalCount})`);
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'S2_POINTS_INCONSISTENCY',
      detail: problems.join(' | '),
      severity: 'error'
    };
  }
  return { ok: true, code: 'S2', detail: '', severity: 'warn' };
}

// Sentinelle 3 : seuils de cohérence globaux (pct, santé).
function checkGlobalCoherence(pct, globalLifeScore) {
  const problems = [];
  if (typeof pct === 'number' && (pct < 0 || pct > 100)) {
    problems.push(`pct hors [0,100] : ${pct}`);
  }
  if (typeof pct === 'number' && Number.isNaN(pct)) {
    problems.push('pct = NaN');
  }
  if (typeof globalLifeScore === 'number' && Number.isNaN(globalLifeScore)) {
    problems.push('globalLifeScore = NaN');
  }
  if (typeof globalLifeScore === 'number' && Math.abs(globalLifeScore) > 10000) {
    problems.push(`globalLifeScore absurde : ${globalLifeScore}`);
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'S3_GLOBAL_INCOHERENCE',
      detail: problems.join(' | '),
      severity: 'error'
    };
  }
  return { ok: true, code: 'S3', detail: '', severity: 'warn' };
}

// Exécute toutes les sentinelles sur un ensemble de résultats d'évaluation.
// Renvoie { passed, results, errors }.
// En mode strict, `passed` est false si une sentinelle error est détectée.
function runSentinels({ evalResults = [], tierPassedCount = 0, tierTotalCount = 0, pct = null, globalLifeScore = null, strict = false }) {
  const results = [];
  const errors = [];

  for (const r of evalResults) {
    const s1 = checkNoNaN(r, { id: r.id });
    results.push(s1);
    if (!s1.ok) errors.push(s1);
  }

  if (evalResults.length > 0) {
    const s2 = checkPointsConsistency(evalResults, tierPassedCount, tierTotalCount);
    results.push(s2);
    if (!s2.ok) errors.push(s2);
  }

  if (pct != null || globalLifeScore != null) {
    const s3 = checkGlobalCoherence(pct, globalLifeScore);
    results.push(s3);
    if (!s3.ok) errors.push(s3);
  }

  // Journalisation : chaque sentinelle échouée est tracée pour diagnostic.
  for (const e of errors) {
    logger.warn('Sentinelle[' + e.code + ']: ' + e.detail);
  }

  const passed = strict ? errors.filter(e => e.severity === 'error').length === 0 : true;
  return { passed, results, errors };
}

module.exports = {
  checkNoNaN,
  checkPointsConsistency,
  checkGlobalCoherence,
  runSentinels
};