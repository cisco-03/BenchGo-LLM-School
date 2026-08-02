
const { stripTS, stripComments } = require('./parsing-utils');
const { execCodeInVM } = require('./vm-sandbox');
const { EVAL_TIMEOUT_MS } = require('./config');
const customEvaluators = require('./custom-evaluators');
const crypto = require('crypto');
const logger = require('./logger');
const { LRUCache } = require('./lru-cache');

// Cache LRU des résultats d'évaluation par (taskId, hash du code étudiant).
// Plan §2 : si le même élève propose EXACTEMENT le même code pour le même
// exercice (ex: rattrapage qui renvoie la même solution, ou re-run sans
// changement), on évite de réexécuter le sandbox VM — gain de temps et
// cohérence garantie (même code → même verdict). Le hash SHA-256 du code
// (stripped TS + comments) garantit qu'on ne cache que les codes identiques.
// TTL : 30 min (un run complet dure rarement plus, on évite les faux positifs
// si le tiers est modifié entre deux runs).
const EVAL_CACHE = new LRUCache(512);
const EVAL_CACHE_TTL_MS = 30 * 60 * 1000;

function evalCacheKey(taskId, studentCode) {
  const normalized = stripComments(stripTS(studentCode || ''));
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return taskId + '::' + hash;
}

// Serialise un resultat VM de facon sure : tronque les objets volumineux et
// evite les crashs sur les valeurs non-serialisables (fonctions, cycles).
function safeStringify(value) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }).substring(0, 1000);
  } catch (_) {
    return String(value).substring(0, 500);
  }
}

async function evaluateTask(taskDef, studentCode) {
  // Lookup cache : si ce code exact a déjà été évalué pour cet exercice, on
  // renvoie le résultat mis en cache (même verdict, mêmes erreurs). Évite le
  // re-exécution sandbox coûteuse et garantit la cohérence.
  const cacheKey = evalCacheKey(taskDef.id, studentCode);
  const cached = EVAL_CACHE.getWithTTL(cacheKey);
  if (cached) {
    logger.info('TaskEval: cache HIT pour ' + taskDef.id + ' (code identique)');
    return cached;
  }

  const results = [];

  logger.exercise('eval', {
    taskId: taskDef.id,
    label: taskDef.label,
    evaluationsCount: taskDef.evaluations.length,
    codeLength: (studentCode || '').length,
    codePreview: (studentCode || '').substring(0, 500)
  });

  for (let i = 0; i < taskDef.evaluations.length; i++) {
    const evalDef = taskDef.evaluations[i];
    let passed = false;
    let errorMsg = null;

    logger.exercise('eval', {
      taskId: taskDef.id,
      evalIndex: i,
      type: evalDef.type,
      description: evalDef.description,
      call: evalDef.call || null,
      assert: evalDef.assert || null,
      method: evalDef.method || null,
      required: evalDef.required || null,
      forbidden: evalDef.forbidden || null
    });

    try {
      if (evalDef.type === "exec") {
        const stripped = stripTS(studentCode || '');
        const execResult = execCodeInVM(stripped, evalDef.setup || '', evalDef.call, evalDef.assert, EVAL_TIMEOUT_MS);
        passed = execResult.passed;
        if (!passed && execResult.error) errorMsg = execResult.error;
        if (!passed && !errorMsg) errorMsg = `Assertion échouée : ${evalDef.assert}`;

        logger.exercise('vm', {
          taskId: taskDef.id,
          evalIndex: i,
          passed,
          result: safeStringify(execResult.result),
          error: execResult.error || null,
          executionTimeMs: execResult.executionTimeMs,
          expected: evalDef.assert
        });

        if (passed && evalDef.maxTimeMs && execResult.executionTimeMs != null) {
          if (execResult.executionTimeMs > evalDef.maxTimeMs) {
            passed = false;
            errorMsg = `Temps d'exécution dépassé (${Math.round(execResult.executionTimeMs)}ms > ${evalDef.maxTimeMs}ms). L'algorithme n'est pas assez optimisé.`;
          }
        }
      }
      else if (evalDef.type === "pattern") {
        const codeText = stripComments(studentCode || '').toLowerCase();
        if (evalDef.required) {
          for (const req of evalDef.required) {
            if (!codeText.includes(req.toLowerCase())) {
              throw new Error(`Motif requis absent : '${req}'`);
            }
          }
        }
        if (evalDef.forbidden) {
          for (const forb of evalDef.forbidden) {
            if (codeText.includes(forb.toLowerCase())) {
              throw new Error(`Motif interdit détecté : '${forb}'`);
            }
          }
        }
        passed = true;
        logger.exercise('eval', {
          taskId: taskDef.id,
          evalIndex: i,
          type: 'pattern',
          passed: true
        });
      }
      else if (evalDef.type === "custom") {
        const evaluator = customEvaluators[evalDef.method];
        if (!evaluator) throw new Error(`Évaluateur '${evalDef.method}' introuvable.`);
        logger.exercise('custom', {
          taskId: taskDef.id,
          evalIndex: i,
          method: evalDef.method,
          starting: true
        });
        await evaluator(studentCode || '');
        passed = true;
        logger.exercise('custom', {
          taskId: taskDef.id,
          evalIndex: i,
          method: evalDef.method,
          passed: true
        });
      }
    } catch (e) {
      passed = false;
      errorMsg = e.message;
      logger.exercise('eval', {
        taskId: taskDef.id,
        evalIndex: i,
        type: evalDef.type,
        passed: false,
        error: e.message,
        stack: e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : null
      });
    }

    results.push({
      passed,
      description: evalDef.description,
      error: errorMsg
    });
  }

  const allPassed = results.every(r => r.passed);
  logger.exercise('eval', {
    taskId: taskDef.id,
    final: true,
    allPassed,
    resultsCount: results.length
  });

  // Stockage dans le cache LRU (avec TTL) pour les prochaines évaluations du
  // même code. Journalisé pour le diagnostic du hit-rate en fin de run.
  EVAL_CACHE.set(cacheKey, results, EVAL_CACHE_TTL_MS);
  logger.info('TaskEval: cache MISS pour ' + taskDef.id + ' — résultat stocké (taille cache=' + EVAL_CACHE.size + ')');

  return results;
}

// Expose le cache pour le benchmarking intégré (§2) et les stats de fin de run.
function getEvalCacheStats() {
  return EVAL_CACHE.getStats();
}

function logEvalCacheStats() {
  EVAL_CACHE.logStats('task-evaluator');
}

module.exports = { evaluateTask, getEvalCacheStats, logEvalCacheStats };
