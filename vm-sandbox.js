
const vm = require('vm');
const { EVAL_TIMEOUT_MS } = require('./config');
const logger = require('./logger');

// CRITIQUE (sécurité) : le module 'vm' de Node.js n'est PAS une sandbox de
// sécurité. Un code malveillant peut s'échapper via la chaîne de prototypes :
//   this.constructor.constructor('return process')().mainModule.require('child_process')
// Mitigations appliquées :
//   1. Retrait de setTimeout/clearTimeout du sandbox — leur .constructor donne
//      accès au Function constructor natif qui permet de récupérer 'process'.
//   2. Retrait de Promise et Symbol du sandbox global (même raison).
//   3. Gel profond (Object.freeze) des constructeurs exposés pour empêcher la
//      modification de leur .prototype ou .constructor.
//   4. Wrapper de runInContext qui intercepte les patterns d'évasion connus.
// Note : ces mitigations réduisent considablement la surface d'attaque mais ne
// rendent pas la sandbox inviolable. Pour une isolation forte, il faudrait
// utiliser un vrai worker_thread isolé ou un processus enfant dédié.

// Construit une version gelée d'un constructeur : on freeze le constructeur
// lui-même et son prototype pour empêcher la modification de .constructor.
function frozenCtor(ctor) {
  if (!ctor) return ctor
  try {
    Object.freeze(ctor)
    if (ctor.prototype) Object.freeze(ctor.prototype)
  } catch (_) {}
  return ctor
}

function buildSandbox() {
  const sb = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    Math: frozenCtor(Math), JSON: Object.freeze(JSON), Array: frozenCtor(Array), Object: frozenCtor(Object),
    String: frozenCtor(String), Number: frozenCtor(Number), Boolean: frozenCtor(Boolean),
    Date: frozenCtor(Date), RegExp: frozenCtor(RegExp),
    Error: frozenCtor(Error), TypeError: frozenCtor(TypeError), RangeError: frozenCtor(RangeError),
    Map: frozenCtor(Map), Set: frozenCtor(Set), WeakMap: frozenCtor(WeakMap), WeakSet: frozenCtor(WeakSet),
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    undefined, NaN, Infinity
  }
  // Gel du console object pour empêcher la modification de ses propriétés
  try { Object.freeze(sb.console) } catch (_) {}
  return sb
}

// Détecte les patterns d'évasion de sandbox connus dans le code avant exécution.
// Retourne un message d'erreur si un pattern suspect est détecté, null sinon.
function detectSandboxEscape(code) {
  if (!code) return null
  // Patterns d'évasion classiques via la chaîne de prototypes.
  // On détecte aussi les variantes en bracket notation : ['constructor'],
  // ["constructor"], ['con'+'structor'], et les escapes Unicode \u0075 etc.
  // Note : ces regex ne sont pas exhaustives — c'est une defense-in-depth.
  // Le gel des constructeurs et le retrait des primitives dangereuses
  // (setTimeout, Promise, Symbol) sont la barrière principale.
  const patterns = [
    // Constructor chain via dot ou bracket notation
    { re: /constructor\s*[\[.\s]*\s*constructor/i, msg: 'tentative d\'évasion de sandbox via constructor chain' },
    { re: /\[['"]constructor['"]\]/i, msg: 'tentative d\'évasion via bracket-notation constructor' },
    { re: /\[['"]con['"]\s*\+\s*['"]structor['"]\]/i, msg: 'tentative d\'évasion via concatenation constructor' },
    // process
    { re: /\bprocess\b\s*[\[.\s]*\s*mainModule/i, msg: 'tentative d\'accès à process.mainModule' },
    { re: /\bprocess\b\s*[\[.\s]*\s*env/i, msg: 'tentative d\'accès à process.env' },
    { re: /\bprocess\b\s*[\[.\s]*\s*binding/i, msg: 'tentative d\'accès à process.binding' },
    { re: /\bprocess\b/i, msg: 'tentative d\'accès à process' },
    // require de modules dangereux
    { re: /\brequire\s*\(\s*['"]child_process['"]\s*\)/i, msg: 'tentative d\'import de child_process' },
    { re: /\brequire\s*\(\s*['"]fs['"]\s*\)/i, msg: 'tentative d\'import de fs' },
    { re: /\brequire\s*\(\s*['"]os['"]\s*\)/i, msg: 'tentative d\'import de os' },
    { re: /\brequire\s*\(\s*['"]/i, msg: 'tentative d\'appel à require' },
    // globalThis
    { re: /\bglobalThis\b/i, msg: 'tentative d\'accès à globalThis' },
    // Function constructor
    { re: /Function\s*[\[.\s]*\s*prototype\s*[\[.\s]*\s*constructor/i, msg: 'tentative d\'évasion via Function.prototype.constructor' },
    { re: /\bnew\s+Function\s*\(/i, msg: 'utilisation de new Function interdite dans la sandbox' },
    // eval et import dynamique
    { re: /\beval\s*\(/i, msg: 'utilisation d\'eval interdite dans la sandbox' },
    { re: /\bimport\s*\(/i, msg: 'utilisation d\'import dynamique interdite dans la sandbox' },
    // proto et prototype.constructor
    // Écritures sur __proto__ (assignation, bracket-set, Object.setPrototypeOf).
    // Les LECTURES/COMPARAISONS (k === '__proto__' pour se PROTÉGER de la
    // pollution de prototype) sont légitimes et ne doivent pas être bloquées —
    // sinon un exercice de sécurité (fusionnerConfig anti-pollution) devient
    // infaisable avec la solution canonique.
    { re: /(\.|[\["'`]\s*)__proto__\s*=/i, msg: 'assignation interdite sur __proto__' },
    { re: /\[\s*['"`]__proto__['"`]\s*\]\s*=/i, msg: 'assignation interdite sur __proto__ (bracket)' },
    { re: /Object\.setPrototypeOf/i, msg: 'Object.setPrototypeOf interdit dans la sandbox' },
    { re: /prototype\s*[\[.\s]*\s*constructor/i, msg: 'tentative d\'évasion via prototype.constructor' },
    // .constructor() appel direct
    { re: /\.constructor\s*\(/i, msg: 'tentative d\'évasion via .constructor()' },
    // Unicode escape pour constructor (ex: constr\u0075ctor)
    { re: /constr\\u[0-9a-f]{4}ctor/i, msg: 'tentative d\'obfuscation du mot-clé constructor' }
  ]
  for (const p of patterns) {
    if (p.re.test(code)) return p.msg
  }
  return null
}

// Inspection securisee d'un resultat VM pour le log : tronque les objets
// volumineux et evite les crashs sur valeurs non-serialisables (cycles, fonctions).
function safeVmInspect(value) {
  try {
    if (value === undefined) return 'undefined';
    const seen = new WeakSet();
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }).substring(0, 500);
  } catch (_) {
    return String(value).substring(0, 300);
  }
}

function execCodeInVM(code, setup, callExpr, assertExpr, timeout = EVAL_TIMEOUT_MS) {
  const sandbox = buildSandbox();
  logger.exercise('vm', {
    stage: 'execCodeInVM',
    starting: true,
    call: callExpr,
    assert: assertExpr,
    setupLength: (setup || '').length,
    codeLength: (code || '').length
  });
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
    // Inspection pré-exécution : détecter les patterns d'évasion sur le code
    // FINAL (après transformation const/let → var) qui sera réellement exécuté.
    const escapeAttempt = detectSandboxEscape(fullCode)
    if (escapeAttempt) {
      logger.exercise('vm', {
        stage: 'execCodeInVM',
        blocked: true,
        reason: escapeAttempt,
        call: callExpr,
        assert: assertExpr
      })
      return {
        passed: false,
        result: null,
        error: 'Sécurité : ' + escapeAttempt,
        executionTimeMs: null
      }
    }
    vm.runInContext(fullCode, ctx, { timeout });
    const t1 = performance.now();

    const passedNow = Boolean(ctx.__passed__);
    logger.exercise('vm', {
      stage: 'execCodeInVM',
      passed: passedNow,
      call: callExpr,
      assert: assertExpr,
      resultType: typeof ctx.__result__,
      resultPreview: safeVmInspect(ctx.__result__),
      executionTimeMs: t1 - t0
    });

    return {
      passed: passedNow,
      result: ctx.__result__,
      error: null,
      executionTimeMs: t1 - t0
    };
  } catch (e) {
    logger.exercise('vm', {
      stage: 'execCodeInVM',
      threw: true,
      call: callExpr,
      assert: assertExpr,
      error: e.message
    });
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
  execCodeInVM,
  detectSandboxEscape
};
