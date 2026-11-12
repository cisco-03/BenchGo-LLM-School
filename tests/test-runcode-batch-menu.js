// tests/test-runcode-batch-menu.js — Tests du parseur de sélection MULTI du
// questionnaire RunCode (file d'élèves : "auto", "1,2,3,4-6", plage, noms).
// Tâche 2026-11-11 : multi-sélection + mode automatique + continue-sur-échec.
const assert = require('assert');
const { _parseMultiSelection } = require('../startup-questionnaire');

const ENTRIES = ['sharp-spark-x2.5-4b', 'ornith-1.5-9b-obliterated', 'spark-x2.6-4b', 'gemma4-cpu-moe', 'minicpm5-2b'];

const cases = [
  { name: 'saisie vide retombe sur le modèle par défaut (single)' },
  { name: 'numéro unique = sélection single historique' },
  { name: '"auto" active le mode automatique (tous les modèles)' },
  { name: '"all" et "tous" sont des synonymes de auto' },
  { name: 'numéros séparés par des virgules = multi avec ordre préservé' },
  { name: 'doublons dans la multi-sélection dédupliqués' },
  { name: 'plage 1-3 développée' },
  { name: 'plage inversée 3-1 développée en ordre croissant' },
  { name: 'mélange plage + numéros + nom exact' },
  { name: 'nom exact en multi matché insensible à la casse' },
  { name: 'terme invalide dans une multi-partie = unknown (re-pose la question)' },
  { name: 'saisie single inconnue retombe sur le défaut (habitude 2026-09-11b)' },
  { name: 'commande "list" passée brute à l\'appelant' }
];

function run(c) {
  const entries = ENTRIES.map(v => ({ value: v }));
  switch (c.name) {
    case 'saisie vide retombe sur le modèle par défaut (single)': {
      const r = _parseMultiSelection('', entries, 1, {});
      assert.strictEqual(r.type, 'single');
      assert.strictEqual(r.values[0], 'ornith-1.5-9b-obliterated');
      break;
    }
    case 'numéro unique = sélection single historique': {
      const r = _parseMultiSelection('3', entries, 0, {});
      assert.strictEqual(r.type, 'single');
      assert.strictEqual(r.values[0], 'spark-x2.6-4b');
      break;
    }
    case '"auto" active le mode automatique (tous les modèles)': {
      const r = _parseMultiSelection('auto', entries, 0, {});
      assert.strictEqual(r.type, 'auto');
      break;
    }
    case '"all" et "tous" sont des synonymes de auto': {
      assert.strictEqual(_parseMultiSelection('all', entries, 0, {}).type, 'auto');
      assert.strictEqual(_parseMultiSelection('tous', entries, 0, {}).type, 'auto');
      assert.strictEqual(_parseMultiSelection('tout', entries, 0, {}).type, 'auto');
      break;
    }
    case 'numéros séparés par des virgules = multi avec ordre préservé': {
      const r = _parseMultiSelection('1,2,3,5', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['sharp-spark-x2.5-4b', 'ornith-1.5-9b-obliterated', 'spark-x2.6-4b', 'minicpm5-2b']);
      break;
    }
    case 'doublons dans la multi-sélection dédupliqués': {
      const r = _parseMultiSelection('2,2,3,2', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['ornith-1.5-9b-obliterated', 'spark-x2.6-4b']);
      break;
    }
    case 'plage 1-3 développée': {
      const r = _parseMultiSelection('1-3', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['sharp-spark-x2.5-4b', 'ornith-1.5-9b-obliterated', 'spark-x2.6-4b']);
      break;
    }
    case 'plage inversée 3-1 développée en ordre croissant': {
      const r = _parseMultiSelection('3-1', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['sharp-spark-x2.5-4b', 'ornith-1.5-9b-obliterated', 'spark-x2.6-4b']);
      break;
    }
    case 'mélange plage + numéros + nom exact': {
      const r = _parseMultiSelection('4,1-2,gemma4-cpu-moe', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['gemma4-cpu-moe', 'sharp-spark-x2.5-4b', 'ornith-1.5-9b-obliterated']);
      break;
    }
    case 'nom exact en multi matché insensible à la casse': {
      const r = _parseMultiSelection('SPARK-X2.6-4B,5', entries, 0, {});
      assert.strictEqual(r.type, 'multi');
      assert.deepStrictEqual(r.values, ['spark-x2.6-4b', 'minicpm5-2b']);
      break;
    }
    case 'terme invalide dans une multi-partie = unknown (re-pose la question)': {
      const r = _parseMultiSelection('1,modele-inexistant', entries, 0, {});
      assert.strictEqual(r.type, 'unknown');
      break;
    }
    case 'saisie single inconnue retombe sur le défaut (habitude 2026-09-11b)': {
      const r = _parseMultiSelection('zzz', entries, 0, {});
      assert.strictEqual(r.type, 'single');
      assert.strictEqual(r.values[0], 'sharp-spark-x2.5-4b');
      break;
    }
    case 'commande "list" passée brute à l\'appelant': {
      const r = _parseMultiSelection('list', entries, 0, { commands: ['list', 'liste'] });
      assert.strictEqual(r.type, 'commands');
      assert.strictEqual(r.values[0], 'list');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };
