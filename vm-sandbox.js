
const vm = require('vm');
const { EVAL_TIMEOUT_MS } = require('./config');

function buildSandbox() {
  return {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    Math, JSON, Array, Object, String, Number, Boolean,
    Date, RegExp, Error, TypeError, RangeError,
    Map, Set, WeakMap, WeakSet,
    Promise, Symbol,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    undefined, NaN, Infinity
  };
}

function execCodeInVM(code, setup, callExpr, assertExpr, timeout = EVAL_TIMEOUT_MS) {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);

  try {
    const t0 = performance.now();
    // Convertir const/let top-level en var pour qu'ils s'attachent au global du VM
    const varCode = code.replace(/^\s*(const|let)\s+/gm, 'var ');
    const fullCode = `
      ${setup || ''}
      ${varCode}
      this.__result__ = (function() { return ${callExpr}; })();
      this.__passed__ = (function(result) { return (${assertExpr}); })(this.__result__);
    `;
    vm.runInContext(fullCode, ctx, { timeout });
    const t1 = performance.now();

    return {
      passed: Boolean(ctx.__passed__),
      result: ctx.__result__,
      error: null,
      executionTimeMs: t1 - t0
    };
  } catch (e) {
    return {
      passed: false,
      result: null,
      error: e.message,
      executionTimeMs: null
    };
  }
}

module.exports = {
  buildSandbox,
  execCodeInVM
};
