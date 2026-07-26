// tests/run-tests.js — Lanceur de tests unitaires sans dépendance externe.
//
// Plan §4 (Maintenabilité) : ajouter un sous-dossier tests/ avec vérifieurs
// purement fonctionnels (scoring, parsing, sentinelles sanitaires) sans
// infrastructure lourde. Ce lanceur découvre tous les fichiers test-*.js et
// exécute leurs cas. Aucune librairie de test : on utilise assert de Node.
//
// Usage : node tests/run-tests.js
// Sortie : résumé des tests passés/échoués + code de sortie (0 si tout OK).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
let passed = 0, failed = 0, skipped = 0;
const failures = [];

function discoverTests() {
  return fs.readdirSync(TESTS_DIR)
    .filter(f => f.startsWith('test-') && f.endsWith('.js'))
    .sort();
}

function runFile(file) {
  const filePath = path.join(TESTS_DIR, file);
  let mod;
  try {
    mod = require(filePath);
  } catch (e) {
    console.log('  \x1b[31m✘ ÉCHEC chargement ' + file + ' : ' + e.message + '\x1b[0m');
    failed++;
    failures.push({ file, name: '(chargement)', err: e });
    return;
  }
  if (typeof mod.run !== 'function') {
    console.log('  \x1b[90m⊝ ' + file + ' : pas de fonction run() — ignoré\x1b[0m');
    skipped++;
    return;
  }
  const cases = typeof mod.cases === 'function' ? mod.cases() : (mod.cases || []);
  for (const c of cases) {
    try {
      mod.run(c);
      console.log('  \x1b[32m✔ ' + file + ' :: ' + c.name + '\x1b[0m');
      passed++;
    } catch (e) {
      console.log('  \x1b[31m✘ ' + file + ' :: ' + c.name + ' — ' + e.message + '\x1b[0m');
      failed++;
      failures.push({ file, name: c.name, err: e });
    }
  }
}

console.log('\n\x1b[1;36m━━━ TESTS UNITAIRES BENCHGO V3 ━━━\x1b[0m\n');
const files = discoverTests();
if (files.length === 0) {
  console.log('  \x1b[33mAucun fichier test-*.js trouvé dans ' + TESTS_DIR + '\x1b[0m');
} else {
  for (const f of files) runFile(f);
}

console.log('\n\x1b[1;36m━━━ RÉSUMÉ ━━━\x1b[0m');
console.log('  \x1b[32mPassés : ' + passed + '\x1b[0m');
console.log('  \x1b[31mÉchoués : ' + failed + '\x1b[0m');
console.log('  \x1b[90mIgnorés : ' + skipped + '\x1b[0m');
if (failures.length > 0) {
  console.log('\n\x1b[31mDétail des échecs :\x1b[0m');
  for (const f of failures) {
    console.log('  • ' + f.file + ' :: ' + f.name);
    console.log('    ' + f.err.message);
    if (f.err.stack) console.log('    ' + f.err.stack.split('\n').slice(1, 3).join('\n    '));
  }
}
console.log('');
process.exit(failed === 0 ? 0 : 1);