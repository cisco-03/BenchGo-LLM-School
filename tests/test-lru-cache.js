// tests/test-lru-cache.js — Tests du cache LRU (§2).
const assert = require('assert');
const { LRUCache } = require('../lru-cache');

const cases = [
  { name: 'set/get basique' },
  { name: 'miss sur clé absente' },
  { name: 'éviction LRU (capacité 3)' },
  { name: 'move-to-end rafraîchit lordre' },
  { name: 'TTL expire lentrée' },
  { name: 'stats hit/miss' },
];

function run(c) {
  switch (c.name) {
    case 'set/get basique': {
      const cache = new LRUCache(10);
      cache.set('a', 1);
      assert.strictEqual(cache.get('a'), 1);
      break;
    }
    case 'miss sur clé absente': {
      const cache = new LRUCache(10);
      assert.strictEqual(cache.get('z'), undefined);
      break;
    }
    case 'éviction LRU (capacité 3)': {
      const cache = new LRUCache(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // 'a' doit être évicté (le moins récemment utilisé)
      assert.strictEqual(cache.get('a'), undefined, 'a doit être évicté');
      assert.strictEqual(cache.get('b'), 2, 'b doit survivre');
      assert.strictEqual(cache.get('d'), 4, 'd doit être présent');
      break;
    }
    case 'move-to-end rafraîchit lordre': {
      const cache = new LRUCache(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // 'a' devient le plus récent
      cache.set('c', 3);
      cache.set('d', 4); // 'b' doit être évicté (a a été accédé)
      assert.strictEqual(cache.get('b'), undefined, 'b doit être évité après accès à a');
      assert.strictEqual(cache.get('a'), 1, 'a doit survivre');
      break;
    }
    case 'TTL expire lentrée': {
      const cache = new LRUCache(10);
      cache.set('a', 1, 10); // TTL 10ms
      assert.strictEqual(cache.getWithTTL('a'), 1, 'avant expiration');
      // Attendre l'expiration (on attend 30ms pour être sûr).
      const start = Date.now();
      while (Date.now() - start < 30) { /* spin */ }
      assert.strictEqual(cache.getWithTTL('a'), undefined, 'après expiration TTL');
      break;
    }
    case 'stats hit/miss': {
      const cache = new LRUCache(10);
      cache.set('a', 1);
      cache.get('a'); // hit
      cache.get('z'); // miss
      const s = cache.getStats();
      assert.strictEqual(s.hits, 1);
      assert.strictEqual(s.misses, 1);
      assert.ok(s.hitRate > 0, 'hitRate doit être > 0');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };