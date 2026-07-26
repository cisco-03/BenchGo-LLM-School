// lru-cache.js — Cache LRU (Least Recently Used) sans dépendance externe.
//
// Plan §2 (Performance / Fiabilité) : stocker en mémoire locale les embeddings
// et résultats d'évaluation fréquents de task-evaluator.js pour éviter des
// appels LLM redondants quand le même prompt a déjà été vu.
//
// Implémentation : Map JavaScript préserve l'ordre d'insertion, donc on obtient
// un LRU en supprimant puis réinsérant la clé à chaque accès (move-to-end).
// Éviction : on supprime l'entrée la plus ancienne quand maxEntries est atteint.
//
// Toutes les opérations sont journalisées (hit/miss/éviction) au niveau DEBUG
// via le logger pour permettre le diagnostic des problèmes de cohérence du cache.

const logger = require('./logger');

class LRUCache {
  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this._map = new Map();
    // Statistiques d'usage pour diagnostic (hits/misses/évictions).
    this._stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
  }

  // Récupère une valeur par clé. Renvoie undefined si absente (miss).
  // Un accès réussi déplace l'entrée en fin de Map (most-recently-used).
  get(key) {
    if (!this._map.has(key)) {
      this._stats.misses++;
      return undefined;
    }
    const entry = this._map.get(key);
    // Move-to-end : supprime puis réinsère pour rafraîchir l'ordre LRU.
    this._map.delete(key);
    this._map.set(key, entry);
    this._stats.hits++;
    return entry.value;
  }

  // Insère ou met à jour une valeur. Évique l'entrée la plus ancienne si
  // maxEntries est dépassé. `ttlMs` optionnel : l'entrée expire après ce délai.
  set(key, value, ttlMs) {
    const expiresAt = (typeof ttlMs === 'number' && ttlMs > 0)
      ? Date.now() + ttlMs
      : null;
    const entry = { value, expiresAt };
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.maxEntries) {
      // Éviction : la 1re clé de la Map est la moins récemment utilisée.
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
      this._stats.evictions++;
      logger.info('LRU: éviction de la clé la plus ancienne (taille max=' + this.maxEntries + ')');
    }
    this._map.set(key, entry);
    this._stats.sets++;
  }

  // Variante de get qui renvoie undefined si l'entrée a expiré (TTL).
  // Une entrée expirée est supprimée à l'accès (lazy eviction).
  getWithTTL(key) {
    if (!this._map.has(key)) {
      this._stats.misses++;
      return undefined;
    }
    const entry = this._map.get(key);
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._map.delete(key);
      this._stats.misses++;
      logger.info('LRU: entrée expirée supprimée (clé TTL atteinte)');
      return undefined;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this._stats.hits++;
    return entry.value;
  }

  has(key) {
    return this._map.has(key);
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
    this._stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
  }

  get size() {
    return this._map.size;
  }

  // Statistiques d'usage pour le benchmarking intégré (§2) et le diagnostic.
  getStats() {
    const total = this._stats.hits + this._stats.misses;
    const hitRate = total > 0 ? (this._stats.hits / total) : 0;
    return { ...this._stats, size: this._map.size, maxEntries: this.maxEntries, hitRate };
  }

  // Affiche un résumé des stats dans le logger (utile en fin de run).
  logStats(label) {
    const s = this.getStats();
    logger.info('LRU[' + (label || 'cache') + ']: taille=' + s.size + '/' + s.maxEntries +
      ' hits=' + s.hits + ' misses=' + s.misses + ' évictions=' + s.evictions +
      ' hitRate=' + (s.hitRate * 100).toFixed(1) + '%');
  }
}

module.exports = { LRUCache };