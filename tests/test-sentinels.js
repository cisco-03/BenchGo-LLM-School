// tests/test-sentinels.js — Tests des sentinelles sanitaires (§4).
const assert = require('assert');
const { checkNoNaN, checkPointsConsistency, checkGlobalCoherence, runSentinels } = require('../health-sentinels');

const cases = [
  { name: 'S1: NaN dans points → échec' },
  { name: 'S1: points valides → ok' },
  { name: 'S2: points > maxPoints → échec' },
  { name: 'S2: somme cohérente → ok' },
  { name: 'S3: pct hors plage → échec' },
  { name: 'S3: pct valide → ok' },
  { name: 'runSentinels: mode non-strict passe toujours' },
  { name: 'runSentinels: mode strict échoue sur S1 error' },
];

function run(c) {
  switch (c.name) {
    case 'S1: NaN dans points → échec': {
      const r = checkNoNaN({ points: NaN, maxPoints: 10 }, { id: 't1' });
      assert.strictEqual(r.ok, false, 'doit détecter NaN');
      assert.strictEqual(r.code, 'S1_NAN_DETECTED');
      break;
    }
    case 'S1: points valides → ok': {
      const r = checkNoNaN({ points: 5, maxPoints: 10 }, { id: 't1' });
      assert.strictEqual(r.ok, true, 'points valides doivent passer');
      break;
    }
    case 'S2: points > maxPoints → échec': {
      const r = checkPointsConsistency(
        [{ id: 't1', points: 15, maxPoints: 10, status: 'success' }],
        1, 10
      );
      assert.strictEqual(r.ok, false, 'points > max doit échouer');
      assert.strictEqual(r.code, 'S2_POINTS_INCONSISTENCY');
      break;
    }
    case 'S2: somme cohérente → ok': {
      const r = checkPointsConsistency(
        [{ id: 't1', points: 5, maxPoints: 10, status: 'success' }, { id: 't2', points: 3, maxPoints: 5, status: 'success' }],
        2, 15
      );
      assert.strictEqual(r.ok, true, 'somme cohérente doit passer');
      break;
    }
    case 'S3: pct hors plage → échec': {
      const r = checkGlobalCoherence(150, 10);
      assert.strictEqual(r.ok, false, 'pct > 100 doit échouer');
      assert.strictEqual(r.code, 'S3_GLOBAL_INCOHERENCE');
      break;
    }
    case 'S3: pct valide → ok': {
      const r = checkGlobalCoherence(75, 10);
      assert.strictEqual(r.ok, true, 'pct valide doit passer');
      break;
    }
    case 'runSentinels: mode non-strict passe toujours': {
      const r = runSentinels({
        evalResults: [{ id: 't1', points: NaN, maxPoints: 10, status: 'success' }],
        tierPassedCount: 1, tierTotalCount: 10,
        strict: false
      });
      assert.strictEqual(r.passed, true, 'mode non-strict passe même avec erreurs');
      assert.ok(r.errors.length > 0, 'doit collecter les erreurs');
      break;
    }
    case 'runSentinels: mode strict échoue sur S1 error': {
      const r = runSentinels({
        evalResults: [{ id: 't1', points: NaN, maxPoints: 10, status: 'success' }],
        tierPassedCount: 1, tierTotalCount: 10,
        strict: true
      });
      assert.strictEqual(r.passed, false, 'mode strict doit échouer sur NaN');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };