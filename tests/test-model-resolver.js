// tests/test-model-resolver.js — Tests de résolution de modèles cloud et filtrage batch (§4).
const assert = require('assert');
const { _matchSlug, resolveOpenRouterSlug } = require('../model-resolver');

const cases = [
  { name: '_matchSlug résout exactement un modèle réel' },
  { name: '_matchSlug retire le suffixe :batch et résout vers le modèle temps réel' },
  { name: '_matchSlug évite lambiguïté quand une version :batch existait' },
  { name: '_matchSlug avec alias et :batch résout vers le slug canonique' }
];

function run(c) {
  const ids = [
    'openai/gpt-4o',
    'anthropic/claude-3-haiku',
    'qwen/qwen3.8-2.4t-a95b',
    'anthropic/claude-opus-5'
  ];
  const idsSet = new Set(ids.map(x => x.toLowerCase()));

  switch (c.name) {
    case '_matchSlug résout exactement un modèle réel': {
      const res = _matchSlug('qwen/qwen3.8-2.4t-a95b', ids, idsSet);
      assert.strictEqual(res.resolved, true);
      assert.strictEqual(res.slug, 'qwen/qwen3.8-2.4t-a95b');
      assert.strictEqual(res.matchedBy, 'exact');
      break;
    }
    case '_matchSlug retire le suffixe :batch et résout vers le modèle temps réel': {
      const res = _matchSlug('qwen/qwen3.8-2.4t-a95b:batch', ids, idsSet);
      assert.strictEqual(res.resolved, true);
      assert.strictEqual(res.slug, 'qwen/qwen3.8-2.4t-a95b');
      assert.strictEqual(res.matchedBy, 'stripped_batch');
      break;
    }
    case '_matchSlug évite lambiguïté quand une version :batch existait': {
      // Si la liste ne contient que les versions chat (pas de :batch),
      // la recherche partielle "qwen3.8-2.4t-a95b" doit matcher de manière unique.
      const res = _matchSlug('qwen3.8-2.4t-a95b', ids, idsSet);
      assert.strictEqual(res.resolved, true);
      assert.strictEqual(res.slug, 'qwen/qwen3.8-2.4t-a95b');
      assert.strictEqual(res.matchedBy, 'substring');
      break;
    }
    case '_matchSlug avec alias et :batch résout vers le slug canonique': {
      const res = _matchSlug('gpt-4o:batch', ids, idsSet);
      assert.strictEqual(res.resolved, true);
      assert.strictEqual(res.slug, 'openai/gpt-4o');
      assert.strictEqual(res.matchedBy, 'stripped_batch');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };
