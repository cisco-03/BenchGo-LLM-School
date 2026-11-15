
const vm = require('vm');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { EVAL_TIMEOUT_MS } = require('./config');
const logger = require('./logger');

// CRITIQUE (sécurité) : le module 'vm' de Node.js n'est PAS une sandbox de
// sécurité. Un code malveillant peut s'échapper via la chaîne de prototypes :
//   this.constructor.constructor('return process')().mainModule.require('child_process')
// Mitigations appliquées (durcissement 2026-11-15c — protocole Admin/Tasks.md,
// feu vert utilisateur pour le plan P0) :
//   1. ISOLATION PAR PROCESSUS JETABLE : execCodeInVM() exécute le code élève
//      dans un ENFANT Node séparé (vm-sandbox-child.js) : env nettoyée (aucune
//      clé/PAT/HOME), cwd vide dans le tempdir, mémoire plafonnée, globals
//      réseau neutralisés, chemins vers les modules natifs fermés, résultat
//      transporté sur fd 3 protégé par nonce. Le processus PRINCIPAL (clés,
//      carnets, secrets en session) ne JAMAIS évaluer du code hostile.
//   2. DEADLINE GLOBAL imposé par le PARENT sur TOUTES les phases (définition +
//      exécution + sérialisation) : un `toJSON` bouclant ne peut plus bloquer
//      le runner/le batch (SEC-VM-02) — l'enfant est tué, l'évaluation échoue.
//   3. PURIFICATION DU REALM : le prototype du global VM est rebranché sur les
//      intrinsics du realm VM (Object.prototype VM au lieu de l'hôte) et le
//      stub console est recréé DANS le realm — les évasions dynamiques via
//      `constructor` reconstruit par concaténation ne donnent plus accès à la
//      Fonction hôte (SEC-VM-01).
//   4. Gel des constructeurs exposés + wrapper de runInContext qui intercepte
//      les patterns d'évasion connus (défense secondaire, signal de diagnostic).
// Note : l'isolation OS réelle (compte restreint/ACL/Job Object) reste la suite
// P1 du protocole ; voir vm-sandbox-child.js pour les limites documentées.

const CHILD_SCRIPT = path.join(__dirname, 'vm-sandbox-child.js');
const CHILD_GRACE_MS = 2500;
const CHILD_MAX_MEMORY_MB = 256;
const RESULT_PREFIX = '__BENCHGO_VM_RESULT__';

// Escape hatch : BENCHGO_VM=in-process force le chemin historique (débogage).
function childModeEnabled() {
  return String(process.env.BENCHGO_VM || '').toLowerCase() !== 'in-process';
}

// Enfant : dossier de travail vide (créé une fois par parent, réutilisé).
let _childWorkDir = null;
function childWorkDir() {
  if (!_childWorkDir) {
    try {
      _childWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgo-vm-'));
    } catch (e) {
      _childWorkDir = os.tmpdir();
    }
  }
  return _childWorkDir;
}

// Liste blanche d'environnement pour l'enfant : AUCUNE clé API, PAT, HOME ou
// variable cloud ne traverse la frontière. NODE_OPTIONS exclu volontairement
// (anti-injection). SystemRoot/COMSPEC requis par node.exe sous Windows.
const CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
];
function childEnv() {
  const env = {};
  for (const k of CHILD_ENV_KEYS) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

// Construit une version gelée d'un constructeur : on freeze le constructeur
// lui-même et son prototype pour empêcher la modification de .constructor.
// (Conservé pour rétro-compatibilité : les évaluateurs custom qui recopaient
// ce pattern peuvent continuer à l'appeler sans comportement différent.)
function frozenCtor(ctor) {
  if (!ctor) return ctor
  try {
    Object.freeze(ctor)
    if (ctor.prototype) Object.freeze(ctor.prototype)
  } catch (_) {}
  return ctor
}

function buildSandbox() {
  // SANDBOX MINIMALE (durcissement 2026-11-15c) : le realm VM fournit DÉJÀ ses
  // propres intrinsics (Math, JSON, Object, Array, String, Number, Boolean,
  // Date, RegExp, Error, Map, Set, parseInt, encodeURIComponent...). Injecter
  // les versions HÔTES de ces objets était le vecteur d'évasion principal
  // (une fonction hôte expose sa .constructor = Function HÔTE). On ne passe
  // plus rien du tout : seul le stub console est recréé, DANS le realm, par
  // createPurifiedContext(). Retrait de setTimeout/Promise du host sandbox :
  // le retrait était symbolique (le realm les fournit lui-même) — le vrai
  // correctif est l'isolation processus + la purification.
  return {}
}

// Purification du realm : exécutée dans chaque contexte AVANT le code élève.
// 1. Recrée le stub console DANS le realm (l'ancien était une fonction hôte,
//    donc console.log.constructor donnait la Function hôte).
// 2. Pose un `constructor` PROPRE au sandbox dont la valeur est un objet NÉ
//    DANS LE REALM : la chaîne this.constructor.constructor délivre alors la
//    Function du realm VM — où `process` n'existe pas — au lieu de la Fonction
//    hôte. Sondé empiriquement (Node 26) : la chaîne d'évasion échoue en
//    TypeError, la Function hôte n'est plus joignable par construction.
const REALM_PURIFY_CODE = [
  '(function () {',
  '  this.console = Object.freeze({ log: function () {}, error: function () {}, warn: function () {}, info: function () {} });',
  '  try { this.constructor = ({}); } catch (e) {}',
  '  try { Object.freeze(Object); } catch (e) {}',
  '  try { Object.freeze(Function.prototype); } catch (e) {}',
  '})()'
].join('\n')

// Crée un contexte VM purifié (prototype rebranché + console realm-natif).
// Utilisé par execCodeInVM (in-process fallback) ET par les évaluateurs custom
// (custom-evaluators.js) — même frontière partout.
function createPurifiedContext(sandbox) {
  const ctx = vm.createContext(sandbox || {})
  vm.runInContext(REALM_PURIFY_CODE, ctx, { timeout: 500 })
  return ctx
}

// Détecte les patterns d'évasion de sandbox connus dans le code avant exécution.
// Retourne un message d'erreur si un pattern suspect est détecté, null sinon.
function detectSandboxEscape(code) {
  if (!code) return null
  // Patterns d'évasion classiques via la chaîne de prototypes.
  // On détecte aussi les variantes en bracket notation : ['constructor'],
  // ["constructor"], ['con'+'structor'], et les escapes Unicode \u0075 etc.
  // Note : ces regex ne sont pas exhaustives — c'est une defense-in-depth.
  // Depuis le durcissement 2026-11-15c, la barrière PRINCIPALE est l'isolation
  // par processus jetable + la purification du realm ; ces regex restent le
  // signal de diagnostic rapide.
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
    // Exfiltration réseau (aucun réseau n'existe dans la sandbox : défense en
    // profondeur contre une évaporation future du moteur — tâche 2026-11-15b).
    { re: /\bfetch\s*\(/i, msg: 'tentative d\'appel réseau (fetch) interdite dans la sandbox' },
    { re: /\bXMLHttpRequest\b/i, msg: 'tentative d\'appel réseau (XHR) interdite dans la sandbox' },
    { re: /\bWebSocket\b/i, msg: 'tentative d\'appel réseau (WebSocket) interdite dans la sandbox' },
    { re: /\bnew\s+Worker\s*\(/i, msg: 'Workers interdits dans la sandbox' },
    { re: /\bBuffer\b/i, msg: 'accès à Buffer interdit dans la sandbox' },
    // Globals de l'hôte / Node jamais exposés.
    { re: /\bchild_process\b/i, msg: 'tentative d\'accès à child_process' },
    { re: /\bmodule\b\s*[\[.\s]*\s*exports/i, msg: 'accès à module.exports interdit dans la sandbox' },
    { re: /\bglobal\s*\./i, msg: 'accès au global de l\'hôte interdit dans la sandbox' },
    { re: /\bwindow\b/i, msg: 'accès au global navigateur (window) interdit dans la sandbox' },
    { re: /\bdocument\b/i, msg: 'accès au DOM (document) interdit dans la sandbox' },
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

// Sérialise le résultat d'une évaluation en données PLAINES transposables
// entre le processus enfant et le parent (fonctions -> '[Function]',
// cycles -> '[Circular]', volume plafonné à 64 Ko).
function serializeVmResult(value) {
  const MAX = 65000;
  try {
    if (value === undefined) return { type: 'undefined', value: null };
    const seen = new WeakSet();
    const json = JSON.stringify(value, (k, v) => {
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'symbol') return '[Symbol]';
      if (typeof v === 'bigint') return String(v) + 'n';
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    if (json === undefined || json === null) return { type: 'undefined', value: null };
    if (json.length > MAX) return { type: 'string', value: '[Résultat tronqué : ' + json.length + ' chars (plafond 64 Ko)]' };
    return { type: 'json', value: JSON.parse(json) };
  } catch (e) {
    return { type: 'string', value: [safeVmInspect(value)] };
  }
}

// Chemin HISTORIQUE (in-process) — garde comme fallback si le spawn de l'enfant
// est impossible (environnement restreint) ou si BENCHGO_VM=in-process. Il
// bénèficie quand même de la purification du realm (barrière principal retirée :
// le code hostile tourne hors du processus principal quand l'enfant est actif).
function execCodeInVMInProcess(code, setup, callExpr, assertExpr, timeout = EVAL_TIMEOUT_MS) {
  const sandbox = buildSandbox();
  logger.exercise('vm', {
    stage: 'execCodeInVM',
    starting: true,
    call: callExpr,
    assert: assertExpr,
    setupLength: (setup || '').length,
    codeLength: (code || '').length
  });
  let ctx;
  try {
    ctx = createPurifiedContext(sandbox);
  } catch (e) {
    return { passed: false, result: null, error: 'Purification du realm impossible : ' + e.message, executionTimeMs: null };
  }

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
    // SEC-VM-02 : la sérialisation du résultat se fait DANS LE REALM, sous la
    // protection du timeout V8. Un `toJSON` bouclant est interrompu au lieu de
    // bloquer (le JSON.stringify hôte reste interdit sur les objets du realm).
    let resultOut = null;
    let resultErr = null;
    try {
      const snap = vm.runInContext('JSON.stringify(this.__result__)', ctx, { timeout: Math.max(250, Math.min(timeout || EVAL_TIMEOUT_MS, 2000)) });
      resultOut = (typeof snap === 'string' && snap !== 'undefined') ? JSON.parse(snap) : null;
    } catch (e) {
      resultErr = 'Sécurité : résultat non sérialisable dans le realm (sérialisation interrompue par le délai)';
      logger.exercise('vm', { stage: 'execCodeInVM', serializeBlocked: true, call: callExpr, error: e.message });
    }

    // Verdict : un résultat qui ne peut pas être transporté (toJSON toxique)
    // n'est pas une réussite prouvée — l'évaluation échoue.
    const finalPassed = passedNow && !resultErr;

    logger.exercise('vm', {
      stage: 'execCodeInVM',
      passed: finalPassed,
      call: callExpr,
      assert: assertExpr,
      resultType: typeof resultOut,
      resultPreview: safeVmInspect(resultOut),
      executionTimeMs: t1 - t0
    });

    return {
      passed: finalPassed,
      result: resultOut,
      error: resultErr,
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

// Chemin PAR DÉFAUT : enfant jetable. Retourne le MÊME format que
// execCodeInVMInProcess (sync via spawnSync : l'évaluation était déjà une
// phase bloquante du runner).
let _childWarned = false;
function execCodeInVMChild(code, setup, callExpr, assertExpr, timeout) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const request = JSON.stringify({ v: 1, nonce, code, setup, callExpr, assertExpr, timeout });
  const res = cp.spawnSync(process.execPath, [CHILD_SCRIPT], {
    cwd: childWorkDir(),
    env: childEnv(),
    input: request + '\n',
    timeout: (timeout || EVAL_TIMEOUT_MS) + CHILD_GRACE_MS,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  // Balayage best-effort de l'arbre si l'enfant a été tué par le délai (sur
  // Windows, spawnSync ne tue que le processus direct).
  if (res.error || res.status === null || res.signal) {
    const pid = res.pid;
    if (pid) {
      try {
        if (process.platform === 'win32') {
          cp.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  if (res.error) {
    // SEC-VM-02 : un ETIMEDOUT/SIGTERM prouve un code TOXIQUE pour la phase de
    // sérialisation (ex: toJSON bouclant) — on ne le re-exécute JAMAIS dans le
    // parent. Le repli in-process est réservé à l'impossibilité de DÉMARRER
    // l'enfant (ENOENT/EACCES), où le code n'a pas tourné du tout.
    if (res.error.code === 'ETIMEDOUT') {
      return {
        passed: false,
        result: null,
        error: "Sandbox : délai global dépassé — l'enfant jetable a été tué (toutes les phases plafonnées)",
        executionTimeMs: null
      };
    }
    const cannotStart = (res.error.code === 'ENOENT' || res.error.code === 'EACCES') && !res.signal;
    if (cannotStart) {
      if (!_childWarned) {
        _childWarned = true;
        logger.warn('Sandbox VM : enfant jetable injoignable (' + res.error.message + ') — repli in-process (moins isolé). BENCHGO_VM=in-process pour forcer.');
      }
      return execCodeInVMInProcess(code, setup, callExpr, assertExpr, timeout);
    }
    return {
      passed: false,
      result: null,
      error: 'Sandbox : échec enfant jetable — ' + res.error.message,
      executionTimeMs: null
    };
  }

  // Résultat : DERNIÈRE ligne valide portant le nonce (protège contre une
  // pollution de stdout par un code qui aurait réussi à fuir dans l'enfant).
  const channels = [res.output && res.output[3], res.stdout];
  let parsed = null;
  for (const ch of channels) {
    if (!ch) continue;
    const text = ch.toString('utf8');
    const idx = text.lastIndexOf(RESULT_PREFIX);
    if (idx === -1) continue;
    const lineStart = text.indexOf('{', idx);
    if (lineStart === -1) continue;
    try {
      const candidate = JSON.parse(text.slice(lineStart).split('\n')[0]);
      if (candidate && candidate.nonce === nonce) parsed = candidate;
    } catch (_) { /* ligne incomplète — on continue */ }
  }

  if (!parsed) {
    const timedOut = res.status === null || res.signal === 'SIGTERM' || res.signal === 'SIGKILL';
    const stderrPreview = (res.stderr ? String(res.stderr) : '').substring(0, 200);
    return {
      passed: false,
      result: null,
      error: timedOut
        ? "Sandbox : délai global dépassé — l'enfant jetable a été tué (toutes les phases plafonnées)"
        : "Sandbox : réponse enfant invalide" + (stderrPreview ? ' — ' + stderrPreview : ''),
      executionTimeMs: null
    };
  }

  // Champ dédié + nonce : un code qui aurait réussi à fuir dans l'enfant et
  // à polluer les flux ne peut pas forger un verdict sans le nonce.
  const serializedResult = parsed.serializedResult || { type: 'string', value: null };

  logger.exercise('vm', {
    stage: 'execCodeInVM-child',
    passed: Boolean(parsed.passed),
    call: callExpr,
    assert: assertExpr,
    resultPreview: safeVmInspect(serializedResult.value),
    executionTimeMs: parsed.executionTimeMs
  });

  return {
    passed: Boolean(parsed.passed),
    result: serializedResult.value,
    error: parsed.error,
    executionTimeMs: parsed.executionTimeMs
  };
}

function execCodeInVM(code, setup, callExpr, assertExpr, timeout = EVAL_TIMEOUT_MS) {
  // Inspection PRÉ-ENFANT : on ne spawn même pas pour un pattern connu (le
  // spawn coûte ~100 ms ; le filtrage reste le premier rempart).
  const pre = (setup && detectSandboxEscape(setup)) || null;
  const preCode = pre || detectSandboxEscape(code) || null;
  if (pre) {
    return { passed: false, result: null, error: 'Sécurité : ' + pre, executionTimeMs: null };
  }
  if (preCode) {
    return { passed: false, result: null, error: 'Sécurité : ' + preCode, executionTimeMs: null };
  }
  if (childModeEnabled()) {
    return execCodeInVMChild(code, setup, callExpr, assertExpr, timeout);
  }
  return execCodeInVMInProcess(code, setup, callExpr, assertExpr, timeout);
}

module.exports = {
  buildSandbox,
  createPurifiedContext,
  execCodeInVM,
  execCodeInVMInProcess,
  serializeVmResult,
  detectSandboxEscape,
  childModeEnabled
};
