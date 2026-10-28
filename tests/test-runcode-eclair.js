// tests/test-runcode-eclair.js — Tests du scan Éclair (tremplin accéléré).
// Couvre la sélection pure eclairSelection() (1 exercice langage × classe la
// plus simple), l'ordre front-loaded et la tolérance aux entrées défectueuses
// du coffre. Fonctions pures : aucun coffre-fort ni modèle requis.
const assert = require('assert');
const { eclairSelection, ECLAIR_CLASS_ORDER, ECLAIR_LANG_ORDER } = require('../adaptive-exam');

// Mini-coffre de test : chaque langage a ses exercices dans quelques classes,
// l'exercice de la classe la plus simple doit toujours être retenu.
const MINI_VAULT = {
  vault_version: 'test',
  catalog: {
    // La classe la plus simple (CP) est en fin d'objet : l'ordre des clés du
    // JSON ne doit PAS influencer le choix (c'est ECLAIR_CLASS_ORDER qui décide).
    python: { CM2: [makeExo('py_cm2')], CP: [makeExo('py_cp')], CE1: [makeExo('py_ce1')] },
    javascript: { CP: [makeExo('js_cp_1'), makeExo('js_cp_2')], '6eme': [makeExo('js_6e')] },
    // Langage sans exercice du tout : ignoré (pas de crash).
    css: {},
    kotlin: [ /* structure invalide (tableau) : ignorée sans crash */ ],
    // Regex invalide : l'exercice fait sauter le langage (jamais tout le scan).
    rust: { '6eme': [{ id: 'rust_bad', title: 'Bad regex', official_source: 'x', code_snippet: 'x', prompt: 'x', expected_regex: '([', max_tokens: 32 }] },
    react: { CM1: [makeExo('react_cm1')] },
    sql: { CE2: [makeExo('sql_ce2')] }
  }
};

function makeExo(id) {
  return {
    id,
    title: 'Exercice ' + id,
    official_source: 'https://exemple.test/' + id,
    code_snippet: 'let a = 1',
    prompt: 'Corrige le bug',
    expected_regex: '^let a = 2$',
    max_tokens: 32
  };
}

const cases = [
  { name: 'eclairSelection: 1 exercice par langage doté (4 dotés sur 6)' },
  { name: 'eclairSelection: classe la plus simple (python→CP, javascript→CP, react→CM1, sql→CE2)' },
  { name: 'eclairSelection: premier exercice de la classe (déterministe)' },
  { name: 'eclairSelection: langage vide/regex invalide ignoré (css, kotlin, rust)' },
  { name: 'eclairSelection: coffre absent → liste vide (pas de crash)' },
  { name: 'ECLAIR_CLASS_ORDER: ordre scolaire croissant complet' },
  { name: 'ECLAIR_LANG_ORDER: front-loaded (python, javascript, typescript, sql, react en tête)' }
];

function run(c) {
  switch (c.name) {
    case 'eclairSelection: 1 exercice par langage doté (4 dotés sur 6)': {
      const picks = eclairSelection(MINI_VAULT);
      assert.strictEqual(picks.length, 4);
      const langs = picks.map(p => p.language).sort();
      assert.deepStrictEqual(langs, ['javascript', 'python', 'react', 'sql']);
      break;
    }
    case 'eclairSelection: classe la plus simple (python→CP, javascript→CP, react→CM1, sql→CE2)': {
      const picks = eclairSelection(MINI_VAULT);
      const byLang = {};
      for (const p of picks) byLang[p.language] = p.class;
      assert.strictEqual(byLang.python, 'CP');
      assert.strictEqual(byLang.javascript, 'CP');
      assert.strictEqual(byLang.react, 'CM1');
      assert.strictEqual(byLang.sql, 'CE2');
      break;
    }
    case 'eclairSelection: premier exercice de la classe (déterministe)': {
      const a = eclairSelection(MINI_VAULT).find(p => p.language === 'python');
      const b = eclairSelection(MINI_VAULT).find(p => p.language === 'python');
      assert.strictEqual(a.id, 'py_cp');
      assert.strictEqual(b.id, 'py_cp');
      break;
    }
    case 'eclairSelection: langage vide/regex invalide ignoré (css, kotlin, rust)': {
      const picks = eclairSelection(MINI_VAULT);
      const langs = picks.map(p => p.language);
      assert.ok(!langs.includes('css'));
      assert.ok(!langs.includes('kotlin'));
      assert.ok(!langs.includes('rust'));
      break;
    }
    case 'eclairSelection: coffre absent → liste vide (pas de crash)': {
      assert.deepStrictEqual(eclairSelection(null), []);
      assert.deepStrictEqual(eclairSelection({}), []);
      break;
    }
    case 'ECLAIR_CLASS_ORDER: ordre scolaire croissant complet': {
      assert.deepStrictEqual(
        ECLAIR_CLASS_ORDER,
        ['CP', 'CE1', 'CE2', 'CM1', 'CM2', '6eme', '5eme', '4eme', '3eme', '2nde', '1ere', 'Terminale', 'Licence1', 'Licence2', 'Licence3', 'Master1', 'Master2', 'Doctorat']
      );
      break;
    }
    case 'ECLAIR_LANG_ORDER: front-loaded (python, javascript, typescript, sql, react en tête)': {
      assert.strictEqual(ECLAIR_LANG_ORDER.length, 20);
      assert.deepStrictEqual(
        ECLAIR_LANG_ORDER.slice(0, 5),
        ['python', 'javascript', 'typescript', 'sql', 'react']
      );
      break;
    }
  }
}

module.exports = { run, cases };