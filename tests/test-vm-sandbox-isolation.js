// tests/test-vm-sandbox-isolation.js — Non-régression SEC-VM-01 / SEC-VM-02
// (protocole Admin/Tasks.md, implémentation P0 session 2026-11-15c).
// Preuves rejouées en test :
//   1. l'évasion directe this.constructor.constructor est bloquée ;
//   2. les évasions DYNAMIQUES (nom reconstruit par concaténation, depuis le
//      global ou depuis console.log) deviennent impossibles : la Function
//      délivrée est celle du REALM VM purifié — `process` n'existe pas dedans ;
//   3. un code bouclant est tué par le délai global (enfant jetable) ;
//   4. un résultat au `toJSON` bouclant (blocage HORS timeout VM, ex-preuve
//      SEC-VM-02) est interrompu : sérialisation DANS le realm sous timeout V8
//      + verdict d'échec borné ;
//   5. les solutions canoniques restent fonctionnelles (aucun faux positif).
const assert = require('assert');
const { execCodeInVM, execCodeInVMInProcess, childModeEnabled, detectSandboxEscape } = require('../vm-sandbox');

const cases = [
  { name: 'vm: solution canonique exécutée (enfant jetable)' },
  { name: 'vm: évasion constructor directe BLOQUÉE (regex)' },
  { name: 'vm: évasion par concaténation depuis le global fermée' },
  { name: 'vm: évasion par concaténation depuis console.log fermée' },
  { name: 'vm: accès process reconstruit = ReferenceError (pas de process)' },
  { name: 'vm: boucle infinie tuée dans le délai global' },
  { name: 'vm: toJSON poison (SEC-VM-02) interrompu SANS bloquer' },
  { name: 'vm: résultat géant plafonné (64 Ko)' },
  { name: 'vm: fallback in-process = mêmes garanties (realm purifié)' },
  { name: 'vm: childModeEnabled défaut = isolation enfant active' },
  { name: 'vm: detectSandboxEscape signale les formes connues' }
];

// La Function du realm VM ne connaît PAS process : le payload dynamique ne
// peut ni l'atteindre (ReferenceError) ni passer la chaîne de prototypes hôte.
const EVA_GLOBAL = "var k = 'con' + 'structor'; var p = 'pro' + 'cess'; var g = (function(){ return this })()[k][k]('return ' + p)()";
const EVA_CONSOLE = "var k = 'con' + 'structor'; var p = 'pro' + 'cess'; var g = console.log[k]('return ' + p)()";

function isBoundedFailure(r) {
  if (r.passed !== false) return false;
  const err = String(r.error || '');
  return err.length > 0;
}

function run(c) {
  switch (c.name) {
    case 'vm: solution canonique exécutée (enfant jetable)': {
      const r = execCodeInVM('function somme(tab) { return tab.reduce((a, v) => a + v, 0) }', '', 'somme([1,2,3,4])', 'result === 10', 5000);
      assert.strictEqual(r.passed, true, 'canonique doit passer : ' + (r.error || ''));
      assert.strictEqual(r.result, 10);
      break;
    }
    case 'vm: évasion constructor directe BLOQUÉE (regex)': {
      const r = execCodeInVM('var g = this.constructor.constructor("return process")()', '', 'typeof g', 'true', 5000);
      assert.strictEqual(r.passed, false);
      assert.ok(String(r.error).startsWith('Sécurité'), 'erreur explicite attendue');
      break;
    }
    case 'vm: évasion par concaténation depuis le global fermée': {
      const r = execCodeInVM(EVA_GLOBAL, '', 'g', 'true', 5000);
      assert.strictEqual(r.passed, false, 'la chaîne dynamique ne doit plus déboucher sur la Function hôte');
      assert.ok(isBoundedFailure(r));
      break;
    }
    case 'vm: évasion par concaténation depuis console.log fermée': {
      const r = execCodeInVM(EVA_CONSOLE, '', 'g', 'true', 5000);
      assert.strictEqual(r.passed, false, 'console est un stub realm-natif : pas de Function hôte');
      break;
    }
    case 'vm: accès process reconstruit = ReferenceError (pas de process)': {
      // 'typeof process' évalué DANS le realm via la chaîne reconstruite : la
      // valeur observée ne peut être ni 'object' (process hôte) ni un accès.
      const r = execCodeInVM("var k = 'con' + 'structor'; var p = 'pro' + 'cess'; try { var t = (function(){ return this })()[k][k]('return typeof ' + p)() } catch (e) { var t = 'BLOQUE' }", '', 't', 'true', 5000);
      assert.strictEqual(r.passed, true, 'le payload lui-même est inoffensif : ' + (r.error || ''));
      assert.ok(r.result === 'BLOQUE' || r.result === 'undefined', 'process doit être inaccessible dans le realm, obtenu : ' + String(r.result));
      break;
    }
    case 'vm: boucle infinie tuée dans le délai global': {
      const t0 = Date.now();
      const r = execCodeInVM('while (true) {}', '', '1', 'true', 1500);
      const wall = Date.now() - t0;
      assert.strictEqual(r.passed, false);
      assert.ok(wall < 8000, 'l enfance doit être tuée vite (obtenu ' + wall + 'ms)');
      assert.ok(String(r.error).length > 0);
      break;
    }
    case 'vm: toJSON poison (SEC-VM-02) interrompu SANS bloquer': {
      // Ex-preuve SEC-VM-02 : le résultat au toJSON bouclant bloquait l'hôte
      // APRÈS le timeout VM (sérialisation hors frontière). Désormais :
      // sérialisation DANS le realm (timeout V8) + échec borné. La chaine
      // complète (définition + appel + sérialisation) reste plafonnée.
      const t0 = Date.now();
      const r = execCodeInVM('function poison() { return { toJSON: function () { while (true) {} } } }', '', 'poison()', 'true', 1500);
      const wall = Date.now() - t0;
      assert.strictEqual(r.passed, false, 'un verdict non transportable = échec');
      assert.ok(wall < 8000, 'sérialisation must être bornée (obtenu ' + wall + 'ms)');
      break;
    }
    case 'vm: résultat géant plafonné (64 Ko)': {
      const r = execCodeInVM('function gros() { var a = []; for (var i = 0; i < 60000; i++) a.push("0123456789abcdef"); return a }', '', 'gros()', 'true', 5000);
      assert.strictEqual(r.passed, true, 'le code lui-même est légitime : ' + (r.error || ''));
      // Sérialisation du VERDICT plafonnée (marker texte), pas d'allocation hôte folle.
      const size = JSON.stringify(r.result).length;
      assert.ok(size < 200000, 'résultat transporté doit rester borné (obtenu ' + size + ' chars)');
      break;
    }
    case 'vm: fallback in-process = mêmes garanties (realm purifié)': {
      // Le chemin historique (BENCHGO_VM=in-process) bénéficie de la même
      // purification : le payload dynamique reste fermé in-process.
      const r = execCodeInVMInProcess(EVA_GLOBAL, '', 'g', 'true', 5000);
      assert.strictEqual(r.passed, false, 'la purification doit fermer l évasion même in-process');
      break;
    }
    case 'vm: childModeEnabled défaut = isolation enfant active': {
      assert.strictEqual(childModeEnabled(), true, 'défaut : exécution dans le processus jetable');
      break;
    }
    case 'vm: detectSandboxEscape signale les formes connues': {
      assert.ok(detectSandboxEscape('this.constructor.constructor("return process")'), 'forma directe');
      assert.ok(detectSandboxEscape("x['constructor']"));
      assert.ok(detectSandboxEscape('new Function("x")'), 'Function constructor');
      assert.strictEqual(detectSandboxEscape('var k = "__proto__"; if (k === "__proto__") {}'), null, 'garde anti-pollution (lecture) légitime');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { run, cases };
