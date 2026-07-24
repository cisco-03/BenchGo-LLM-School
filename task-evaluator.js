
const { stripTS } = require('./parsing-utils');
const { execCodeInVM } = require('./vm-sandbox');
const { EVAL_TIMEOUT_MS } = require('./config');
const customEvaluators = require('./custom-evaluators');

async function evaluateTask(taskDef, studentCode) {
  const results = [];

  for (const evalDef of taskDef.evaluations) {
    let passed = false;
    let errorMsg = null;

    try {
      if (evalDef.type === "exec") {
        const stripped = stripTS(studentCode || '');
        const execResult = execCodeInVM(stripped, evalDef.setup || '', evalDef.call, evalDef.assert, EVAL_TIMEOUT_MS);
        passed = execResult.passed;
        if (!passed && execResult.error) errorMsg = execResult.error;
        if (!passed && !errorMsg) errorMsg = `Assertion échouée : ${evalDef.assert}`;
        
        if (passed && evalDef.maxTimeMs && execResult.executionTimeMs != null) {
          if (execResult.executionTimeMs > evalDef.maxTimeMs) {
            passed = false;
            errorMsg = `Temps d'exécution dépassé (${Math.round(execResult.executionTimeMs)}ms > ${evalDef.maxTimeMs}ms). L'algorithme n'est pas assez optimisé.`;
          }
        }
      }
      else if (evalDef.type === "pattern") {
        const codeText = (studentCode || '').toLowerCase();
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
      }
      else if (evalDef.type === "custom") {
        const evaluator = customEvaluators[evalDef.method];
        if (!evaluator) throw new Error(`Évaluateur '${evalDef.method}' introuvable.`);
        await evaluator(studentCode || '');
        passed = true;
      }
    } catch (e) {
      passed = false;
      errorMsg = e.message;
    }

    results.push({
      passed,
      description: evalDef.description,
      error: errorMsg
    });
  }

  return results;
}

module.exports = { evaluateTask };
