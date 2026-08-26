// model-resolver.js — Résolution tolérante des slugs de modèles cloud.
//
// Problème résolu (tâche 2026-08-26) :
//   L'utilisateur saisit ou colle un nom de modèle OpenRouter qui n'est pas un
//   slug exact (ex: "node" au lieu de "meta-llama/llama-3.1-8b-instruct:free",
//   ou "GPT-4o" au lieu de "openai/gpt-4o"). OpenRouter renvoie alors un
//   HTTP 400 "X is not a valid model ID" pour CHAQUE appel API, mais le runner
//   parcourt quand même les 6 classes en échec (0/2752, rapport inutile).
//
//   Ce module :
//     1. Fetch la liste publique OpenRouter /api/v1/models (cache disque 24h,
//        partagé avec pricing.js via .pricing-cache.json pour éviter un 2e fetch).
//     2. Normalise le slug saisi (lowercase, espaces/points/tirets ignorés).
//     3. Tente un matching EXACT → PREFIXE → SOUS-CHAÎNE → ALIAS courant.
//     4. Renvoie le slug canonique à utiliser, ou null + suggestions si ambigu.
//
//   Utilisé par frontier-batch.js (validation avant lancement du batch) et par
//   runner.js (résolution auto si le slug n'est pas exact + arrêt net sur 400).

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_FILE = path.join(__dirname, '.pricing-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h (partagé avec pricing.js)

// Cache en mémoire (id -> true). Rechargé paresseusement.
let _modelsCache = null;       // Set des ids exacts (lowercase)
let _modelsList = null;        // Tableau original [{ id, name }]
let _modelsLoadedAt = 0;

// Alias courants : nom familier -> slug OpenRouter canonique.
// Insensible à la casse. Complété au fil de l'eau.
const COMMON_ALIASES = {
  'gpt4o': 'openai/gpt-4o',
  'gpt-4o': 'openai/gpt-4o',
  'gpt4omini': 'openai/gpt-4o-mini',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt4': 'openai/gpt-4',
  'gpt-4': 'openai/gpt-4',
  'gpt4turbo': 'openai/gpt-4-turbo',
  'gpt-4-turbo': 'openai/gpt-4-turbo',
  'o1': 'openai/o1',
  'o1-mini': 'openai/o1-mini',
  'o3': 'openai/o3',
  'o3-mini': 'openai/o3-mini',
  'o4-mini': 'openai/o4-mini',
  'claude3opus': 'anthropic/claude-3-opus',
  'claude-3-opus': 'anthropic/claude-3-opus',
  'claude3sonnet': 'anthropic/claude-3-7-sonnet',
  'claude-3-sonnet': 'anthropic/claude-3-7-sonnet',
  'claude3haiku': 'anthropic/claude-3-haiku',
  'claude-3-haiku': 'anthropic/claude-3-haiku',
  'claude4sonnet': 'anthropic/claude-sonnet-4',
  'claude-sonnet-4': 'anthropic/claude-sonnet-4',
  'claude4opus': 'anthropic/claude-opus-4',
  'claude-opus-4': 'anthropic/claude-opus-4',
  'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  'claude-opus-4.5': 'anthropic/claude-opus-4.5',
  'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-opus-5': 'anthropic/claude-opus-5',
  'llama3.1-8b': 'meta-llama/llama-3.1-8b-instruct',
  'llama-3.1-8b': 'meta-llama/llama-3.1-8b-instruct',
  'llama3.1-70b': 'meta-llama/llama-3.1-70b-instruct',
  'llama-3.1-70b': 'meta-llama/llama-3.1-70b-instruct',
  'llama3.1-405b': 'meta-llama/llama-3.1-405b-instruct',
  'mistral-large': 'mistralai/mistral-large',
  'mistral-small': 'mistralai/mistral-small',
  'mixtral': 'mistralai/mixtral-8x7b-instruct',
  'deepseek-r1': 'deepseek/deepseek-r1',
  'deepseek-v3': 'deepseek/deepseek-v3',
  'deepseek-chat': 'deepseek/deepseek-chat',
  'qwen2.5-72b': 'qwen/qwen-2.5-72b-instruct',
  'qwen-2.5-72b': 'qwen/qwen-2.5-72b-instruct',
  'gemini-pro': 'google/gemini-pro-1.5',
  'gemini-1.5-pro': 'google/gemini-pro-1.5',
  'gemini-1.5-flash': 'google/gemini-flash-1.5',
  'gemini-flash': 'google/gemini-flash-1.5'
};

// Normalise un slug/nom pour la comparaison : lowercase, retire espaces,
// points, underscores, deux-points (ex: ":free"). Permet de matcher
// "GPT-4o" avec "openai/gpt-4o" et "gpt4o" avec "gpt-4o".
function normalizeSlug(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[\s._:-]/g, '')
    .replace(/\/+/g, '/');
}

// Normalisation plus légère (garde les /) pour le matching par préfixe de slug.
function normalizeKeepSlash(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[\s._]/g, '');
}

// Charge le cache disque (partagé avec pricing.js). Retourne la map id->true
// ou null si indisponible.
function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    // Format pricing.js : { savedAt, models: { idLower: { prompt, completion } } }
    // On extrait les ids depuis obj.models. Compatibilité : si l'ancien format
    // (map plate id->{prompt,completion}) est rencontré, on prend les clés directes.
    if (obj && obj.models && typeof obj.models === 'object') {
      return Object.keys(obj.models);
    }
    if (obj && typeof obj === 'object' && !obj.savedAt) {
      return Object.keys(obj);
    }
  } catch (_) { /* cache corrompu */ }
  return null;
}

// Fetch la liste OpenRouter et met à jour le cache disque (format compatible
// pricing.js : { idLower: { prompt: 0, completion: 0 } }). On ne stocke PAS
// de prix ici (0,0) — pricing.js rechargera les vrais prix si besoin. L'objectif
// est juste d'avoir la liste des ids valides.
async function fetchOpenRouterModels() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      logger.warn('model-resolver: OpenRouter /models HTTP_' + res.status);
      return null;
    }
    const data = await res.json();
    const all = Array.isArray(data?.data) ? data.data : [];
    const ids = [];
    const diskMap = {};
    for (const m of all) {
      if (!m || !m.id) continue;
      ids.push(m.id);
      // Format compatible pricing.js (prix placeholder 0 — sera rafraîchi).
      const p = m.pricing || {};
      const promptPerTok = parseFloat(p.prompt) || 0;
      const completionPerTok = parseFloat(p.completion) || 0;
      diskMap[m.id.toLowerCase()] = {
        prompt: promptPerTok * 1e6,
        completion: completionPerTok * 1e6
      };
    }
    // Sauvegarde le cache disque UNIQUEMENT s'il n'existe pas déjà.
    // On ne veut PAS écraser le cache de pricing.js (qui contient les VRAIS prix).
    // pricing.js et model-resolver partagent le même fichier .pricing-cache.json :
    // si on réécrivait avec des prix à 0, pricing.js verrait un cache "frais" avec
    // prix 0 et n'afficherait plus les coûts. On ne crée le cache que s'il manque.
    const cacheExists = fs.existsSync(CACHE_FILE);
    if (!cacheExists) {
      try {
        const cachePayload = { savedAt: Date.now(), models: diskMap };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cachePayload, null, 2) + '\n', 'utf8');
      } catch (_) { /* disque non inscriptible */ }
    }
    logger.info('model-resolver: ' + ids.length + ' modèles chargés depuis OpenRouter.');
    return ids;
  } catch (e) {
    clearTimeout(timeoutId);
    logger.warn('model-resolver: impossible de contacter OpenRouter — ' + e.message);
    return null;
  }
}

// Charge la liste des modèles OpenRouter (cache disque 24h, sinon fetch réseau).
// Retourne un tableau d'ids (slugs exacts, casse d'origine).
async function getOpenRouterModelIds() {
  // Cache en mémoire valide ?
  if (_modelsCache && (Date.now() - _modelsLoadedAt) < CACHE_TTL_MS) {
    return _modelsList.slice();
  }
  // Cache disque valide ?
  const diskIds = loadDiskCache();
  if (diskIds && diskIds.length > 0) {
    _modelsList = diskIds;
    _modelsCache = new Set(diskIds.map(id => id.toLowerCase()));
    _modelsLoadedAt = Date.now();
    // Recharge en arrière-plan si le cache est vieux.
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs >= CACHE_TTL_MS) {
      fetchOpenRouterModels().then(fresh => {
        if (fresh && fresh.length > 0) {
          _modelsList = fresh;
          _modelsCache = new Set(fresh.map(id => id.toLowerCase()));
          _modelsLoadedAt = Date.now();
        }
      }).catch(() => {});
    }
    return _modelsList.slice();
  }
  // Pas de cache : fetch réseau (bloquant).
  const fresh = await fetchOpenRouterModels();
  if (fresh && fresh.length > 0) {
    _modelsList = fresh;
    _modelsCache = new Set(fresh.map(id => id.toLowerCase()));
    _modelsLoadedAt = Date.now();
    return fresh.slice();
  }
  // Échec total (offline) : on n'a rien.
  return [];
}

// Teste si un slug est un id OpenRouter EXACT (insensible à la casse).
async function isOpenRouterExactSlug(slug) {
  if (!slug) return false;
  const ids = await getOpenRouterModelIds();
  if (ids.length === 0) return true; // offline : on ne bloque pas, on fait confiance
  return _modelsCache.has(slug.toLowerCase());
}

// Désambiguisateur : si une liste de matchs ne diffère que par le suffixe
// ":free" (ex: ["inkling-small", "inkling-small:free"]), on préfère ":free"
// (BenchGo cible les modèles gratuits OpenRouter par défaut). Retourne le slug
// :free si la paire existe, sinon null.
function preferFreeVariant(matches) {
  if (!matches || matches.length < 2) return null;
  const freeSet = new Set(matches.filter(m => /:free$/i.test(m)).map(m => m.toLowerCase()));
  if (freeSet.size === 0) return null;
  // Pour chaque variant :free, cherche s'il existe un variant non-:free identique.
  for (const m of matches) {
    if (/:free$/i.test(m)) {
      const base = m.replace(/:free$/i, '').toLowerCase();
      const hasNonFree = matches.some(other =>
        other.toLowerCase() === base && !/:free$/i.test(other)
      );
      if (hasNonFree) {
        // Paire (free, non-free) trouvée : on préfère le :free.
        return matches.find(x => x.toLowerCase() === m.toLowerCase());
      }
    }
  }
  return null;
}

// Résout un slug saisi vers un slug canonique OpenRouter.
// Stratégies (dans l'ordre) :
//   1. Match exact (insensible casse).
//   2. Alias courant (gpt4o -> openai/gpt-4o).
//   3. Préfixe de slug (ex: "meta-llama/llama" -> premier slug qui commence par ça).
//   4. Sous-chaîne normalisée (ex: "llama3.18b" -> "meta-llama/llama-3.1-8b-instruct").
//   5. Suffixe (ex: "llama-3.1-8b-instruct" sans le préfixe "meta-llama/").
//
// Retourne :
//   { resolved: true,  slug, matchedBy, suggestions: [] }   → slug canonique trouvé
//   { resolved: false, slug: null, suggestions: [...] }     → ambigu ou introuvable
//   { offline: true,   slug: <saisi>, suggestions: [] }     — réseau indisponible, on passe le slug tel quel
// Logique de matching pure : résout un slug saisi contre une liste d'ids.
// Réutilisée par resolveOpenRouterSlug ET resolveKiloSlug (même format
// provider/model-name). ids = tableau de slugs (casse d'origine), idsSet =
// Set des slugs en lowercase pour le lookup O(1).
//
// Stratégies (dans l'ordre) :
//   1. Match exact (insensible casse).
//   2. Alias courant (gpt4o -> openai/gpt-4o) — seulement si l'id existe.
//   3. Préfixe de slug.
//   4. Sous-chaîne normalisée (+ désambiguisateur :free).
//   5. Suffixe (après le /).
function _matchSlug(raw, ids, idsSet) {
  const lower = raw.toLowerCase();

  // 1. Match exact
  if (idsSet.has(lower)) {
    return { resolved: true, slug: raw, matchedBy: 'exact', suggestions: [] };
  }
  // Certains slugs ont une casse précise (ex: "openai/gpt-4o"). On renvoie la
  // casse d'origine de la liste.
  const exactOrig = ids.find(id => id.toLowerCase() === lower);
  if (exactOrig) {
    return { resolved: true, slug: exactOrig, matchedBy: 'exact', suggestions: [] };
  }

  // 2. Alias courant
  const aliasKey = normalizeSlug(raw);
  if (COMMON_ALIASES[aliasKey]) {
    const candidate = COMMON_ALIASES[aliasKey];
    if (idsSet.has(candidate.toLowerCase())) {
      return { resolved: true, slug: candidate, matchedBy: 'alias', suggestions: [] };
    }
  }
  // Alias matching normalisé (gpt4o -> openai/gpt-4o)
  for (const [alias, slug] of Object.entries(COMMON_ALIASES)) {
    if (normalizeSlug(alias) === aliasKey && idsSet.has(slug.toLowerCase())) {
      return { resolved: true, slug, matchedBy: 'alias', suggestions: [] };
    }
  }

  // 3. Préfixe de slug (garde les /)
  const normKeepSlash = normalizeKeepSlash(raw);
  const prefixMatches = ids.filter(id =>
    normalizeKeepSlash(id).startsWith(normKeepSlash)
  );
  if (prefixMatches.length === 1) {
    return { resolved: true, slug: prefixMatches[0], matchedBy: 'prefix', suggestions: [] };
  }

  // 4. Sous-chaîne normalisée (retire tout : espaces, points, /, : etc.)
  const normInput = normalizeSlug(raw);
  if (normInput.length >= 3) { // évite les matchs triviaux (ex: "gp" trop court)
    const subMatches = ids.filter(id => {
      const normId = normalizeSlug(id);
      return normId.includes(normInput);
    });
    if (subMatches.length === 1) {
      return { resolved: true, slug: subMatches[0], matchedBy: 'substring', suggestions: [] };
    }
    // Désambiguisateur :free — si les matchs ne diffèrent que par :free, on
    // préfère le variant gratuit (BenchGo cible les modèles gratuits par défaut).
    const freePick = preferFreeVariant(subMatches);
    if (freePick) {
      return { resolved: true, slug: freePick, matchedBy: 'prefer_free', suggestions: [] };
    }
    // 5. Suffixe : l'utilisateur a tapé "llama-3.1-8b-instruct" sans le préfixe "meta-llama/"
    // On cherche les ids dont la partie après "/" matche l'entrée normalisée.
    if (!raw.includes('/')) {
      const suffixMatches = ids.filter(id => {
        const afterSlash = id.split('/').pop() || id;
        return normalizeSlug(afterSlash) === normInput
          || normalizeSlug(afterSlash).startsWith(normInput);
      });
      if (suffixMatches.length === 1) {
        return { resolved: true, slug: suffixMatches[0], matchedBy: 'suffix', suggestions: [] };
      }
      const freePickSuffix = preferFreeVariant(suffixMatches);
      if (freePickSuffix) {
        return { resolved: true, slug: freePickSuffix, matchedBy: 'prefer_free', suggestions: [] };
      }
    }
    // Si plusieurs matchs, on collecte les suggestions.
    if (subMatches.length > 1 && prefixMatches.length === 0) {
      return {
        resolved: false,
        slug: null,
        suggestions: subMatches.slice(0, 8),
        matchedBy: 'ambiguous'
      };
    }
  }

  if (prefixMatches.length > 1) {
    const freePickPrefix = preferFreeVariant(prefixMatches);
    if (freePickPrefix) {
      return { resolved: true, slug: freePickPrefix, matchedBy: 'prefer_free', suggestions: [] };
    }
    return {
      resolved: false,
      slug: null,
      suggestions: prefixMatches.slice(0, 8),
      matchedBy: 'ambiguous'
    };
  }

  // Aucun match : on suggère quand même les slugs les plus proches (préfixe partiel).
  const partialMatches = ids.filter(id => {
    const normId = normalizeSlug(id);
    // Match sur n'importe quel token du slug (ex: "llama" -> tous les llama).
    return normId.includes(normInput.substring(0, Math.min(normInput.length, 6)));
  }).slice(0, 8);

  return {
    resolved: false,
    slug: null,
    suggestions: partialMatches,
    matchedBy: 'not_found'
  };
}

// === Kilo Gateway (api.kilo.ai) ===
// Même format de slug que OpenRouter (provider/model-name), même structure
// /models ({ data: [...] }, champ id). Endpoint public sans auth. Les prix
// sont en $/token (chaînes, "-1" = non défini). On garde un cache séparé pour
// ne pas mélanger les listes OpenRouter et Kilo.
const KILO_MODELS_URL = 'https://api.kilo.ai/api/gateway/models';
const KILO_CACHE_FILE = path.join(__dirname, '.kilo-models-cache.json');

let _kiloCache = null;       // Set des ids (lowercase)
let _kiloList = null;        // Tableau [{ id }]
let _kiloLoadedAt = 0;

function loadKiloDiskCache() {
  try {
    if (!fs.existsSync(KILO_CACHE_FILE)) return null;
    const raw = fs.readFileSync(KILO_CACHE_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    if (arr && Array.isArray(arr.ids)) return arr.ids;
  } catch (_) { /* cache corrompu */ }
  return null;
}

async function fetchKiloModels() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(KILO_MODELS_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      logger.warn('model-resolver: Kilo /models HTTP_' + res.status);
      return null;
    }
    const data = await res.json();
    const all = Array.isArray(data?.data) ? data.data : [];
    const ids = [];
    for (const m of all) {
      if (m && m.id) ids.push(m.id);
    }
    // Sauvegarde un cache disque simple (liste d'ids). TTL 24h vérifié à la lecture.
    try {
      const cachePayload = { savedAt: Date.now(), ids };
      fs.writeFileSync(KILO_CACHE_FILE, JSON.stringify(cachePayload, null, 2) + '\n', 'utf8');
    } catch (_) { /* disque non inscriptible */ }
    logger.info('model-resolver: ' + ids.length + ' modèles chargés depuis Kilo Gateway.');
    return ids;
  } catch (e) {
    clearTimeout(timeoutId);
    logger.warn('model-resolver: impossible de contacter Kilo Gateway — ' + e.message);
    return null;
  }
}

async function getKiloModelIds() {
  // Cache en mémoire valide ?
  if (_kiloCache && (Date.now() - _kiloLoadedAt) < CACHE_TTL_MS) {
    return _kiloList.slice();
  }
  // Cache disque valide ?
  const diskIds = loadKiloDiskCache();
  if (diskIds && diskIds.length > 0) {
    _kiloList = diskIds;
    _kiloCache = new Set(diskIds.map(id => id.toLowerCase()));
    _kiloLoadedAt = Date.now();
    // Recharge en arrière-plan si le cache est vieux.
    try {
      const stat = fs.statSync(KILO_CACHE_FILE);
      if (Date.now() - stat.mtimeMs >= CACHE_TTL_MS) {
        fetchKiloModels().then(fresh => {
          if (fresh && fresh.length > 0) {
            _kiloList = fresh;
            _kiloCache = new Set(fresh.map(id => id.toLowerCase()));
            _kiloLoadedAt = Date.now();
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return _kiloList.slice();
  }
  // Pas de cache : fetch réseau (bloquant).
  const fresh = await fetchKiloModels();
  if (fresh && fresh.length > 0) {
    _kiloList = fresh;
    _kiloCache = new Set(fresh.map(id => id.toLowerCase()));
    _kiloLoadedAt = Date.now();
    return fresh.slice();
  }
  return [];
}

async function isOpenRouterExactSlug(slug) {
  if (!slug) return false;
  const ids = await getOpenRouterModelIds();
  if (ids.length === 0) return true; // offline : on ne bloque pas, on fait confiance
  return _modelsCache.has(slug.toLowerCase());
}

// Résout un slug saisi vers un slug canonique OpenRouter.
// Voir _matchSlug pour les stratégies.
async function resolveOpenRouterSlug(input) {
  if (!input || !String(input).trim()) {
    return { resolved: false, slug: null, suggestions: [], matchedBy: 'empty' };
  }
  const raw = String(input).trim();
  const ids = await getOpenRouterModelIds();
  if (ids.length === 0) {
    return { offline: true, slug: raw, suggestions: [], matchedBy: 'offline' };
  }
  return _matchSlug(raw, ids, _modelsCache);
}

// Résout un slug saisi vers un slug canonique Kilo Gateway.
// Même format que OpenRouter (provider/model-name). Réutilise _matchSlug.
async function resolveKiloSlug(input) {
  if (!input || !String(input).trim()) {
    return { resolved: false, slug: null, suggestions: [], matchedBy: 'empty' };
  }
  const raw = String(input).trim();
  const ids = await getKiloModelIds();
  if (ids.length === 0) {
    return { offline: true, slug: raw, suggestions: [], matchedBy: 'offline' };
  }
  return _matchSlug(raw, ids, _kiloCache);
}

module.exports = {
  resolveOpenRouterSlug,
  resolveKiloSlug,
  isOpenRouterExactSlug,
  getOpenRouterModelIds,
  getKiloModelIds,
  normalizeSlug,
  COMMON_ALIASES
};