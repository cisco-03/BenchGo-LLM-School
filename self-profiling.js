const logger = require('./logger');
const { extractJSON } = require('./parsing-utils');
const { PROFILING_TIMEOUT_MS, PROFILING_MAX_TOKENS, PROFILING_RETRY_MAX } = require('./config');

// Carte statique compétence -> IDs de tâches associées (construite à partir des 18 fichiers
// tiers/*.json). Une tâche non listée ici est classée par défaut en `javascript_basics`
// (prudence : on l'exécute plutôt que de la bypasser).
// Sources : grep des IDs + méthodes d'évaluateurs custom async dans tiers/*.json.
const SKILL_TASK_MAP = {
  // Tâches asynchrones (évaluateurs custom async : evaluateAsync*)
  javascript_async: [
    'tache_2a',   // Pool de concurrence async (evaluateAsyncPartialErrors)
    'tache_3e',   // Retry async (evaluateAsyncRetryLogic)
    'tache_4c'    // Pool async concurrence limitée (evaluateAsyncConcurrencyLimit) — frontier
  ],

  // Algorithmes avancés : structures de données complexes + algorithmes difficiles
  algorithms_advanced: [
    // Tier 4 frontier (LRUCache, DeepClone, Parser, Trie, Dijkstra)
    'tache_4a', 'tache_4b', 'tache_4d', 'tache_4e', 'tache_4f',
    // Tier 1 expert (min-heap, EventEmitter, Zip, Proxy)
    'tache_1a', 'tache_1b', 'tache_1c', 'tache_1e',
    // Tier 0 expert (Curry, Equal, Compose, BST, Debounce)
    'tache_0a', 'tache_0b', 'tache_0c', 'tache_0d', 'tache_0e',
    // Exercices algorithmiques difficiles (algo_difficile_1 + algo_defi) — tous tiers
    'algo_difficile_1', 'algo_defi',
    // Tier 6 (master) — tous complexes
    'trier_tableau', 'memoire_longue', 'calcul_robuste', 'optimisation_extreme',
    'algo_facile_1', 'algo_facile_2', 'algo_moyen_1'  // Tier 6 : même les "faciles" sont hard
  ],

  // Débogage & sécurité : tâches de correction/debug, architecture spécialisée
  code_debugging: [
    'tache_1d',   // BFS debug
    'tache_2d',   // Race condition async
    'tache_2e',   // Circuit Breaker
    'tache_3a',   // PowerShell rollback
    'tache_3b',   // Flood Fill
    'tache_3c',   // Cloudflare middleware
    'tache_3d',   // SQL paramétrée
    'tache_3f',   // Prototype pollution
    'tache_2b',   // Subject réactif
    'tache_2c'    // Mémoïsation async
  ]

  // javascript_basics : tout le reste (tâches "matières" : math, francais, svt, etc.
  // + algo_facile_* + algo_moyen_1 des tiers 0-5) — classement par défaut.
};

// Mapping inverse (taskId -> skill) calculé une fois pour le filtrage.
const TASK_TO_SKILL = {};
for (const [skill, ids] of Object.entries(SKILL_TASK_MAP)) {
  for (const id of ids) TASK_TO_SKILL[id] = skill;
}

const SKILL_LABELS = {
  javascript_basics: 'JavaScript — Bases & Algorithmique simple',
  javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
  algorithms_advanced: 'Algorithmes & Structures de données avancées',
  code_debugging: 'Débogage & Sécurité applicative'
};

const PROFILE_PROMPT = `Auto-évalue TES capacités en JavaScript de façon réaliste (1 à 5). Réponds UNIQUEMENT en JSON, sans texte avant/après, sans Markdown, sans bloc de code.

Échelle : 1=aucune, 2=débutant, 3=intermédiaire, 4=avancé, 5=expert senior sans bug.

Compétences :
- javascript_basics : bases du langage + algorithmique simple
- javascript_async : Promises, async/await, concurrence limitée, retry/backoff
- algorithms_advanced : LRU/Trie/arbres/heap/graphes, Dijkstra, BFS/DFS, DP simple
- code_debugging : race conditions async, injection SQL, prototype pollution, XSS

Sois strict et lucide ; niveau 5 rare.

Format JSON exact :
{
  "skills": {
    "javascript_basics": { "level": <1-5>, "examples": "<1-2 exemples concrets>" },
    "javascript_async": { "level": <1-5>, "examples": "<idem>" },
    "algorithms_advanced": { "level": <1-5>, "examples": "<idem>" },
    "code_debugging": { "level": <1-5>, "examples": "<idem>" }
  },
  "justification": "<phrase courte et honnête>"
}`;

// Détecte la skill associée à une tâche. Retourne 'javascript_basics' par défaut
// (prudence : on exécute plutôt que de bypasser si la tâche est inconnue).
function getTaskSkill(task) {
  const id = task && task.id;
  if (id && TASK_TO_SKILL[id]) return TASK_TO_SKILL[id];
  return 'javascript_basics';
}

// Valide un profil parsé : présence des 4 compétences + levels entre 1 et 5.
function validateProfile(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!parsed.skills || typeof parsed.skills !== 'object') return false;
  const required = ['javascript_basics', 'javascript_async', 'algorithms_advanced', 'code_debugging'];
  for (const key of required) {
    const entry = parsed.skills[key];
    if (!entry || typeof entry.level !== 'number') return false;
    if (entry.level < 1 || entry.level > 5) return false;
  }
  return true;
}

// Fallback regex : extrait les niveaux déclarés si JSON.parse échoue.
// Cherche des motifs "javascript_basics" ... "level": 3 en tolérant du texte
// (raisononnement, markdown, commentaires) autour du JSON. Robuste aux modèles
// qui enrobent le JSON dans du prose (phi-4-reasoning-plus, DeepSeek-R1...).
function parseProfileFallback(text) {
  if (!text) return null;
  const result = { skills: {}, justification: 'Extrait via fallback regex' };
  const skills = ['javascript_basics', 'javascript_async', 'algorithms_advanced', 'code_debugging'];
  let found = 0;
  for (const skill of skills) {
    // Tolérant aux espaces, retours ligne, et tout caractère non-accolade entre
    // la clé et "level". [\s\S] = tout y compris \n ; [^}] = jusqu'à l'accolade.
    const re = new RegExp('"' + skill + '"\\s*:\\s*\\{[\\s\\S]*?"level"\\s*:\\s*(\\d+)', 'i');
    const m = text.match(re);
    if (m) {
      const level = parseInt(m[1], 10);
      if (level >= 1 && level <= 5) {
        result.skills[skill] = { level };
        found++;
      }
    }
  }
  if (found === 0) return null;
  // Complète les skills manquantes avec un niveau neutre (3 = intermédiaire).
  for (const skill of skills) {
    if (!result.skills[skill]) result.skills[skill] = { level: 3 };
  }
  // Tente d'extraire la justification si présente.
  const justMatch = text.match(/"justification"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (justMatch && justMatch[1]) {
    try { result.justification = JSON.parse('"' + justMatch[1] + '"'); }
    catch (_) { result.justification = justMatch[1]; }
  }
  return result;
}

// Schéma JSON strict pour l'auto-profilage (LM Studio / OpenAI-compat acceptent
// response_format: { type: 'json_schema' }). Force la sortie en JSON valide,
// évite le prose/markdown qui faisait échouer le parsing (phi-4-reasoning-plus).
const PROFILING_JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'self_profiling',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['skills', 'justification'],
      properties: {
        skills: {
          type: 'object',
          additionalProperties: false,
          required: ['javascript_basics', 'javascript_async', 'algorithms_advanced', 'code_debugging'],
          properties: {
            javascript_basics: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'examples'],
              properties: {
                level: { type: 'integer', minimum: 1, maximum: 5 },
                examples: { type: 'string' }
              }
            },
            javascript_async: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'examples'],
              properties: {
                level: { type: 'integer', minimum: 1, maximum: 5 },
                examples: { type: 'string' }
              }
            },
            algorithms_advanced: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'examples'],
              properties: {
                level: { type: 'integer', minimum: 1, maximum: 5 },
                examples: { type: 'string' }
              }
            },
            code_debugging: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'examples'],
              properties: {
                level: { type: 'integer', minimum: 1, maximum: 5 },
                examples: { type: 'string' }
              }
            }
          }
        },
        justification: { type: 'string' }
      }
    }
  }
};

// Exécute une seule tentative d'auto-profilage avec une stratégie donnée.
// strategy = { name, responseFormat, disableReasoning, maxTokens }
// Retourne le profil validé ou null.
async function _profilingAttempt(queryFn, providerConfig, contextLimitTokens, strategy, attemptNum) {
  const options = {
    contextLimitTokens,
    providerConfig,
    timeoutMs: PROFILING_TIMEOUT_MS,
    disableReasoning: strategy.disableReasoning,
  };
  // maxTokens : 0 = illimité (carte blanche). On ne limite JAMAIS la sortie de
  // l'auto-profilage (sinon le JSON est tronqué → parsing échoue → échec systématique).
  options.maxTokens = PROFILING_MAX_TOKENS;
  if (strategy.responseFormat) {
    options.responseFormat = strategy.responseFormat;
  }

  logger.info(`Auto-profilage tentative ${attemptNum}/${PROFILING_RETRY_MAX} — stratégie: ${strategy.name}.`);

  let response;
  try {
    response = await queryFn(
      PROFILE_PROMPT,
      'EASY',
      'PROFILAGE',
      true,
      { start(){}, stop(){}, fail(){}, updateTokens(){}, _modelName: null,
        beginStreaming(){}, appendStreamChunk(){}, endStreaming(){} },
      options
    );
  } catch (e) {
    logger.warn(`Auto-profilage tentative ${attemptNum} : échec de l'appel API (${e.message}).`);
    return null;
  }

  if (!response || !response.content) {
    logger.warn(`Auto-profilage tentative ${attemptNum} : réponse vide.`);
    return null;
  }

  const content = response.content;
  logger.info(`Auto-profilage tentative ${attemptNum} : ${content.length} chars reçus.`);

  // Tentative 1 : JSON strict
  let parsed = null;
  try {
    parsed = JSON.parse(extractJSON(content));
  } catch (_) { }

  // Tentative 2 : fallback regex si le JSON échoue
  if (!validateProfile(parsed)) {
    logger.info(`Auto-profilage tentative ${attemptNum} : JSON strict échoué, fallback regex.`);
    parsed = parseProfileFallback(content);
  }

  if (!validateProfile(parsed)) {
    logger.warn(`Auto-profilage tentative ${attemptNum} : profil toujours invalide.`);
    return null;
  }

  logger.info(`Auto-profilage tentative ${attemptNum} RÉUSSI : ${JSON.stringify(parsed.skills)}`);
  if (parsed.justification) {
    logger.info(`Auto-profilage justification : ${parsed.justification}`);
  }
  return parsed;
}

// Exécute l'interview d'auto-profilage auprès du modèle.
// queryFn : fonction queryLLM (locale ou cloud) — même signature que lm-studio-client.queryLLM.
// Retourne le profil validé { skills, justification } ou null en cas d'échec (graceful).
//
// NON NÉGOCIABLE : on essaie jusqu'à PROFILING_RETRY_MAX stratégies différentes
// avant de baisser les bras. Le log benchgo_2026-07-20T07-31-39 montrait un échec
// systématique car une seule stratégie était tentée et le parsing ne tolérait pas
// le markdown autour du JSON.
async function runSelfProfiling(queryFn, providerConfig, contextLimitTokens) {
  if (!queryFn) return null;

  // Stratégies ordonnées : de la plus contrainte à la plus permissive.
  // 1. json_schema + reasoning off : force le JSON, coupe la pensée (rapide).
  // 2. texte pur + reasoning off : pas de contrainte de format mais coupe la pensée.
  // 3. texte pur + reasoning on (carte blanche) : le modèle réfléchit librement.
  const strategies = [
    { name: 'json_schema + reasoning off', responseFormat: PROFILING_JSON_SCHEMA, disableReasoning: true },
    { name: 'texte + reasoning off', responseFormat: null, disableReasoning: true },
    { name: 'carte blanche (reasoning on)', responseFormat: null, disableReasoning: false },
  ];

  for (let i = 0; i < strategies.length && i < PROFILING_RETRY_MAX; i++) {
    const parsed = await _profilingAttempt(queryFn, providerConfig, contextLimitTokens, strategies[i], i + 1);
    if (parsed) return parsed;
  }

  logger.warn(`Auto-profilage : échec après ${Math.min(strategies.length, PROFILING_RETRY_MAX)} tentatives. Filtrage désactivé.`);
  return null;
}

// Filtre les tâches d'un tier selon le profil auto-déclaré.
// Retourne { kept: [...], bypassed: [...], decisions: [...] }.
// bypassFilter=true (config) : toutes les tâches sont conservées (kept) mais les
// décisions sont quand même calculées pour le rapport.
function filterTasksByProfile(tasks, profile, minLevelToTest, bypassFilter = false) {
  const kept = [];
  const bypassed = [];
  const decisions = [];

  if (!profile || !profile.skills) {
    return { kept: tasks, bypassed: [], decisions: [] };
  }

  for (const task of tasks) {
    const skill = getTaskSkill(task);
    const declaredLevel = profile.skills[skill] ? profile.skills[skill].level : 5;
    const shouldBypass = declaredLevel < minLevelToTest && !bypassFilter;

    const decision = {
      taskId: task.id,
      taskLabel: task.label,
      skill,
      declaredLevel,
      action: shouldBypass ? 'bypassed' : 'kept'
    };
    decisions.push(decision);

    if (shouldBypass) {
      bypassed.push(task);
      logger.info(`Filtrage : ${task.id} (${skill} lvl ${declaredLevel}) < ${minLevelToTest} → Bypassée (Non déclarée)`);
    } else {
      kept.push(task);
    }
  }

  return { kept, bypassed, decisions };
}

module.exports = {
  SKILL_TASK_MAP,
  SKILL_LABELS,
  PROFILE_PROMPT,
  runSelfProfiling,
  filterTasksByProfile,
  getTaskSkill,
  validateProfile,
  parseProfileFallback
};