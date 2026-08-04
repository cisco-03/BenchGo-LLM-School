const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// --- Tarification des modèles cloud (estimation de coût) ---
// Affiche une estimation du coût d'un benchmark (par école et total) pour les
// modèles cloud payants. Les modèles gratuits (prix = 0) coûtent 0$.
//
// APPROCHE HYBRIDE :
//   1. Récupère les prix depuis l'endpoint PUBLIC OpenRouter /api/v1/models
//      (champ pricing.prompt / pricing.completion, en $/token).
//   2. Fallback sur une table locale (PRICING_FALLBACK) pour les providers
//      non couverts par OpenRouter (OpenAI direct, Anthropic, Groq...).
//
// IMPORTANT : il s'agit d'une ESTIMATION. Les valeurs réelles dépendent du
// découpage du tokenizer du modèle, du nombre exact de tokens (prompt +
// raisonnement + completion) et des tarifs en vigueur au moment du run.
// Les prix évoluent : cette table est une approximation indicative.

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_FILE = path.join(__dirname, '.pricing-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Taux de conversion approximatif $ -> €. Peut être ajusté manuellement.
const USD_TO_EUR = 0.92;

// Table de fallback locale : { modelId (lowercase substring match): { prompt: $/1M tokens, completion: $/1M tokens } }
// Sources : pages de pricing officielles (valeurs approximatives, à vérifier).
// Ne couvre que les modèles les plus courants hors OpenRouter.
const PRICING_FALLBACK = {
  // OpenAI (api.openai.com)
  'gpt-4o':           { prompt: 2.5,   completion: 10 },
  'gpt-4o-mini':      { prompt: 0.15,  completion: 0.6 },
  'gpt-4-turbo':      { prompt: 10,    completion: 30 },
  'gpt-4.1':          { prompt: 2,     completion: 8 },
  'gpt-4.1-mini':     { prompt: 0.4,   completion: 1.6 },
  'gpt-4.1-nano':     { prompt: 0.1,   completion: 0.4 },
  'o1':               { prompt: 15,    completion: 60 },
  'o1-mini':          { prompt: 3,     completion: 12 },
  'o3':               { prompt: 10,    completion: 40 },
  'o3-mini':          { prompt: 3,     completion: 12 },
  'o4-mini':          { prompt: 1.5,   completion: 6 },
  'gpt-5':            { prompt: 5,     completion: 15 },
  'gpt-5-mini':       { prompt: 0.25,  completion: 2 },
  // Anthropic
  'claude-3-5-sonnet':{ prompt: 3,     completion: 15 },
  'claude-3-5-haiku': { prompt: 0.8,   completion: 4 },
  'claude-3-opus':    { prompt: 15,    completion: 75 },
  'claude-sonnet-4':  { prompt: 3,     completion: 15 },
  'claude-opus-4':    { prompt: 15,    completion: 75 },
  'claude-haiku-4':   { prompt: 1,    completion: 5 },
  // Groq (modèles open-source accélérés)
  'llama-3.3-70b':    { prompt: 0.59,  completion: 0.79 },
  'llama-3.1-70b':    { prompt: 0.59,  completion: 0.79 },
  'llama-3.1-8b':     { prompt: 0.05,  completion: 0.08 },
  'gemma2-9b':        { prompt: 0.2,   completion: 0.2 },
  // DeepSeek (api.deepseek.com)
  'deepseek-chat':    { prompt: 0.27,  completion: 1.1 },
  'deepseek-reasoner':{ prompt: 0.55,  completion: 2.19 },
  // Together
  'qwen-2.5-72b':     { prompt: 0.88,  completion: 0.88 },
  'qwen-2.5-7b':      { prompt: 0.18,  completion: 0.18 },
  // Mistral (api.mistral.ai)
  'mistral-large':    { prompt: 2,     completion: 6 },
  'mistral-small':    { prompt: 0.2,   completion: 0.6 },
  'codestral':        { prompt: 0.3,   completion: 0.9 },
  // Cohere
  'command-r':        { prompt: 0.5,   completion: 1.5 },
  'command-r-plus':   { prompt: 2.5,   completion: 10 },
};

// Cache en mémoire (chargement paresseux)
let _openRouterCache = null;
let _openRouterCacheAt = 0;
let _openRouterLoaded = false;

// Charge le cache disque au démarrage (pour un usage hors-ligne / CI).
function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (raw && raw.savedAt && (Date.now() - raw.savedAt) < CACHE_TTL_MS && raw.models) {
        return raw.models;
      }
    }
  } catch (e) {
    logger.warn('pricing: cache disque illisible — ' + e.message);
  }
  return null;
}

function saveDiskCache(models) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: Date.now(), models }, null, 2) + '\n', 'utf8');
  } catch (e) {
    // Non bloquant : on garde juste le cache en mémoire.
    logger.warn('pricing: impossible de sauvegarder le cache — ' + e.message);
  }
}

// Récupère la table OpenRouter (prompt/completion en $/1M tokens). Synchrone :
// tente d'abord le cache disque, puis déclenche un rechargement asynchrone en
// arrière-plan si le cache est périmé. Renvoie toujours un objet (éventuellement
// vide) pour ne jamais bloquer l'affichage du classement.
function getOpenRouterPricing() {
  if (_openRouterLoaded && _openRouterCache && (Date.now() - _openRouterCacheAt) < CACHE_TTL_MS) {
    return _openRouterCache;
  }
  // Tente le cache disque d'abord (synchrone).
  const disk = loadDiskCache();
  if (disk) {
    _openRouterCache = disk;
    _openRouterCacheAt = Date.now();
    _openRouterLoaded = true;
  }
  // Recharge en arrière-plan si pas déjà fait récemment.
  if (!_openRouterLoaded || (Date.now() - _openRouterCacheAt) >= CACHE_TTL_MS) {
    _openRouterLoaded = true;
    refreshOpenRouterPricing().catch(() => {});
  }
  return _openRouterCache || {};
}

// Recharge la table OpenRouter depuis le réseau (asynchrone). Stocke en cache
// disque pour les prochains runs (utile en CI/offline).
async function refreshOpenRouterPricing() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      logger.warn('pricing: OpenRouter /models HTTP_' + res.status + ' — fallback local uniquement.');
      return null;
    }
    const data = await res.json();
    const all = Array.isArray(data?.data) ? data.data : [];
    const map = {};
    for (const m of all) {
      if (!m || !m.id) continue;
      const p = m.pricing || {};
      // OpenRouter renvoie les prix en $/TOKEN (format string). On convertit
      // en $/1M tokens pour lisibilité et cohérence avec la table locale.
      const promptPerTok = parseFloat(p.prompt);
      const completionPerTok = parseFloat(p.completion);
      if (!Number.isFinite(promptPerTok) || !Number.isFinite(completionPerTok)) continue;
      map[m.id.toLowerCase()] = {
        prompt: promptPerTok * 1e6,
        completion: completionPerTok * 1e6
      };
    }
    _openRouterCache = map;
    _openRouterCacheAt = Date.now();
    saveDiskCache(map);
    logger.info('pricing: ' + Object.keys(map).length + ' modèles chargés depuis OpenRouter.');
    return map;
  } catch (e) {
    logger.warn('pricing: impossible de contacter OpenRouter — ' + e.message);
    return null;
  }
}

// Recherche un prix pour un modèle donné (id ou nom) en essayant OpenRouter
// puis la table de fallback locale. Renvoie { prompt, completion } en $/1M
// tokens, ou null si introuvable.
function findPrice(modelId, provider) {
  if (!modelId) return null;
  const id = String(modelId).toLowerCase().trim();

  // 1. OpenRouter : lookup exact (l'id OpenRouter est souvent "org/model" ou
  // "org/model:free"). On accepte aussi une correspondance de préfixe.
  const orMap = getOpenRouterPricing();
  if (orMap && orMap[id]) return orMap[id];
  if (orMap) {
    // Correspondance de préfixe (ex: "openai/gpt-4o-2024-11-20" -> "openai/gpt-4o")
    let best = null;
    let bestLen = 0;
    for (const key of Object.keys(orMap)) {
      if (id.startsWith(key) && key.length > bestLen) {
        best = orMap[key];
        bestLen = key.length;
      }
    }
    if (best) return best;
  }

  // 2. Table de fallback locale : correspondance par sous-chaîne (le nom du
  // modèle apparaît dans l'id). On teste la clé la plus longue d'abord.
  const fbKeys = Object.keys(PRICING_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of fbKeys) {
    if (id.includes(key)) return PRICING_FALLBACK[key];
  }

  // 3. Fallback par provider : un prix moyen générique si on connaît le
  // provider mais pas le modèle précis. Très approximatif.
  if (provider === 'anthropic') return { prompt: 3, completion: 15 };
  if (provider === 'openai') return { prompt: 2, completion: 8 };
  if (provider === 'deepseek') return { prompt: 0.3, completion: 1.1 };
  if (provider === 'groq') return { prompt: 0.3, completion: 0.5 };
  if (provider === 'mistral') return { prompt: 0.5, completion: 1.5 };
  if (provider === 'cohere') return { prompt: 1, completion: 3 };

  return null;
}

// Calcule le coût estimé (USD) d'un nombre de tokens prompt + completion,
// pour un modèle donné. Renvoie null si le prix est introuvable.
// price = { prompt: $/1M, completion: $/1M } (résultat de findPrice).
function computeCostUsd(promptTokens, completionTokens, price) {
  if (!price) return null;
  const usd = (promptTokens / 1e6) * price.prompt + (completionTokens / 1e6) * price.completion;
  return usd;
}

// Formatage monétaire compact : $0.0012 -> "$0.0012", $12.34 -> "$12.34".
// Pour les très petits montants (< 0.01), on affiche jusqu'à 4 décimales.
function formatUsd(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(4);
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}

function formatEur(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  const eur = usd * USD_TO_EUR;
  if (eur === 0) return '€0.00';
  if (eur < 0.01) return '€' + eur.toFixed(4);
  if (eur < 1) return '€' + eur.toFixed(3);
  return '€' + eur.toFixed(2);
}

// Calcule le coût estimé pour un modèle sur l'ensemble de ses écoles.
// Prend en entrée l'objet agrégé du leaderboard (totalTokens, écoles avec
// promptTokens/completionTokens) et renvoie :
//   { usd, eur, perEcole: [{ ecole, usd, eur }], isEstimate: true, found: bool }
function estimateModelCost(entry) {
  if (!entry || !entry.isCloud) return null;
  const price = findPrice(entry.model, entry.provider);
  if (!price) return null;

  let totalUsd = 0;
  const perEcole = [];
  const ecoles = entry.ecoles || [];
  for (const ec of ecoles) {
    const p = ec.promptTokens || 0;
    const c = ec.completionTokens || 0;
    if (p === 0 && c === 0) {
      perEcole.push({ ecole: ec.ecole, usd: 0, eur: 0 });
      continue;
    }
    const u = computeCostUsd(p, c, price) || 0;
    totalUsd += u;
    perEcole.push({ ecole: ec.ecole, usd: u, eur: u * USD_TO_EUR });
  }

  // Si les tokens détaillés ne sont pas disponibles (anciens carnets), on
  // utilise le totalTokens cumulé comme estimation des completion tokens et
  // on estime les prompt tokens (ratio moyen 3:1 prompt:completion sur ce
  // benchmark — les prompts sont longs, les réponses plus courtes).
  if (totalUsd === 0 && entry.tokens > 0) {
    const estCompletion = entry.tokens;
    const estPrompt = Math.round(entry.tokens * 3);
    totalUsd = computeCostUsd(estPrompt, estCompletion, price) || 0;
    for (const ec of ecoles) {
      const c = ec.tokens || 0;
      const p = Math.round(c * 3);
      const u = computeCostUsd(p, c, price) || 0;
      perEcole.push({ ecole: ec.ecole, usd: u, eur: u * USD_TO_EUR });
    }
  }

  return {
    usd: totalUsd,
    eur: totalUsd * USD_TO_EUR,
    perEcole,
    isEstimate: true,
    pricePerMTok: { prompt: price.prompt, completion: price.completion }
  };
}

module.exports = {
  findPrice,
  computeCostUsd,
  estimateModelCost,
  formatUsd,
  formatEur,
  refreshOpenRouterPricing,
  getOpenRouterPricing,
  USD_TO_EUR,
  PRICING_FALLBACK
};