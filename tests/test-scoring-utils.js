// tests/test-scoring-utils.js — Tests des fonctions pures extraites (§4).
const assert = require('assert');
const { isRattrapageEligibleProfile, shouldReplaceBestResult, explainTechnicalError, getClassName } = require('../scoring-utils');

const cases = [
  { name: 'isRattrapageEligibleProfile: LIGHT ok' },
  { name: 'isRattrapageEligibleProfile: STANDARD ok' },
  { name: 'isRattrapageEligibleProfile: EXPERT non' },
  { name: 'shouldReplaceBestResult: null current → true' },
  { name: 'shouldReplaceBestResult: plus de classes passées → true' },
  { name: 'shouldReplaceBestResult: égalité + pct supérieur → true' },
  { name: 'explainTechnicalError: is not defined' },
  { name: 'explainTechnicalError: assertion échouée' },
  { name: 'getClassName: STANDARD tier 0' },
];

function run(c) {
  switch (c.name) {
    case 'isRattrapageEligibleProfile: LIGHT ok': {
      assert.strictEqual(isRattrapageEligibleProfile('LIGHT'), true);
      break;
    }
    case 'isRattrapageEligibleProfile: STANDARD ok': {
      assert.strictEqual(isRattrapageEligibleProfile('STANDARD'), true);
      break;
    }
    case 'isRattrapageEligibleProfile: EXPERT non': {
      assert.strictEqual(isRattrapageEligibleProfile('EXPERT'), false);
      break;
    }
    case 'shouldReplaceBestResult: null current → true': {
      assert.strictEqual(shouldReplaceBestResult(null, { tierPassedCount: 1, tierPct: 50 }), true);
      break;
    }
    case 'shouldReplaceBestResult: plus de classes passées → true': {
      assert.strictEqual(
        shouldReplaceBestResult({ tierPassedCount: 2, tierPct: 50 }, { tierPassedCount: 3, tierPct: 40 }),
        true
      );
      break;
    }
    case 'shouldReplaceBestResult: égalité + pct supérieur → true': {
      assert.strictEqual(
        shouldReplaceBestResult({ tierPassedCount: 3, tierPct: 50 }, { tierPassedCount: 3, tierPct: 60 }),
        true
      );
      break;
    }
    case 'explainTechnicalError: is not defined': {
      const msg = explainTechnicalError('foo is not defined', { id: 't1' });
      assert.ok(msg.includes('foo'), 'doit mentionner le symbole');
      assert.ok(msg.includes('déclarée'), 'doit expliquer la déclaration');
      break;
    }
    case 'explainTechnicalError: assertion échouée': {
      const msg = explainTechnicalError('Assertion échouée : expected 5 got 3', { id: 't1' });
      assert.ok(msg.includes('résultat attendu'), 'doit expliquer le résultat attendu');
      break;
    }
    case 'getClassName: STANDARD tier 0': {
      const name = getClassName('STANDARD', 0);
      assert.ok(typeof name === 'string' && name.length > 0, 'doit renvoyer un nom non vide');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };