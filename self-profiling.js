const logger = require('./logger');
const { extractJSON } = require('./parsing-utils');

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

const PROFILE_PROMPT = `Tu es un évaluateur technique objectif, lucide et honnête. Ta tâche est d'auto-évaluer TES PROPRES capacités en programmation et analyse JavaScript, de façon réaliste (ni surévaluée ni sous-évaluée).

AVANT DE RÉPONDRE — réfléchis en silence à ces questions pour chaque compétence :
  • "Si on me donnait 3 exercices de difficulté croissante dans ce domaine, lesquels réussirais-je du premier coup ?"
  • "Quels pièges (syntaxe, async, structures de données, sécurité) m'ont déjà fait échouer par le passé ?"
  • "Est-ce que je sais PRODUIRE le code (pas seulement le reconnaître) ?"

Échelle de niveau (1 à 5) :
  - 1 = aucune connaissance : je ne peux pas produire de code fonctionnel dans ce domaine.
  - 2 = débutant : code approximatif, erreurs fréquentes, j'ai besoin d'aide pour la syntaxe de base.
  - 3 = intermédiaire : je produis un code correct sur les cas simples, mais je bute sur les cas atypiques et l'optimisation.
  - 4 = avancé : je produis un code robuste, lisible et optimisé sur des cas complexes, sans erreur courante.
  - 5 = expert senior : je produis un code de production, idiomatique, sans bug, en anticipant les cas limites.

Compétences à évaluer (sois précis sur chaque) :
  - "javascript_basics" : Bases du langage (fonctions, portée, fermetures, tableaux, chaînes, objets, déstructuration) et algorithmique simple (parité, comptage, tris de base, recherche linéaire).
  - "javascript_async" : Programmation asynchrone (Promises, async/await, Promise.all/allSettled/race, concurrence limitée, retry avec backoff exponentiel, gestion fine des erreurs asynchrones).
  - "algorithms_advanced" : Structures de données avancées (LRU Cache, Trie, arbres binaires, tas/heap, graphes) et algorithmes complexes (Dijkstra, parcours BFS/DFS, divide & conquer, exponentiation rapide, programmation dynamique simple).
  - "code_debugging" : Débogage de code asynchrone (race conditions), sécurité (injection SQL, prototype pollution, XSS, CSRF), scripts spécialisés (PowerShell, middleware, parseurs robustes).

Sois STRICT et LUCIDE : ne te surévalue pas "pour faire plaisir", ne te sous-évalue pas par fausse modestie. Un niveau 5 est rare — ne l'attribue que si tu es VRAIMENT capable de production sans bug.

Réponds UNIQUEMENT avec un objet JSON respectant STRICTEMENT ce schéma (aucun texte avant ou après, aucun Markdown, aucun bloc de code) :
{
  "skills": {
    "javascript_basics": { "level": <1-5>, "examples": "<1-2 exemples concrets de ce que tu sais faire>" },
    "javascript_async": { "level": <1-5>, "examples": "<idem>" },
    "algorithms_advanced": { "level": <1-5>, "examples": "<idem>" },
    "code_debugging": { "level": <1-5>, "examples": "<idem>" }
  },
  "justification": "<phrase courte et honnête expliquant ton auto-évaluation globale>"
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
// Cherche des motifs "javascript_basics" ... "level": 3
function parseProfileFallback(text) {
  if (!text) return null;
  const result = { skills: {}, justification: 'Extrait via fallback regex' };
  const skills = ['javascript_basics', 'javascript_async', 'algorithms_advanced', 'code_debugging'];
  let found = 0;
  for (const skill of skills) {
    const re = new RegExp('"' + skill + '"\\s*:\\s*\\{[^}]*?"level"\\s*:\\s*(\\d+)', 'i');
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
  return result;
}

// Exécute l'interview d'auto-profilage auprès du modèle.
// queryFn : fonction queryLLM (locale ou cloud) — même signature que lm-studio-client.queryLLM.
// Retourne le profil validé { skills, justification } ou null en cas d'échec (graceful).
async function runSelfProfiling(queryFn, providerConfig, contextLimitTokens) {
  if (!queryFn) return null;

  // Spinner factice : l'appelant gère le spinner réel. On passe un objet minimal
  // compatible avec l'interface attendue par queryFn (updateTokens, start/stop no-op).
  const noopSpinner = {
    start() {}, stop() {}, fail() {}, updateTokens() {}, _modelName: null,
    beginStreaming() {}, appendStreamChunk() {}, endStreaming() {}
  };

  // Le prompt impose déjà le format JSON, et un fallback regex gère les modèles non-JSON.
  // On n'envoie PAS response_format : LM Studio n'accepte que 'json_schema'/'text' (pas
  // 'json_object' propre à OpenAI), et Anthropic ne le supporte pas du tout. Le schéma
  // strict + le fallback regex couvrent tous les cas sans dépendre du format natif.
  const options = {
    contextLimitTokens,
    providerConfig
  };

  let response;
  try {
    response = await queryFn(
      PROFILE_PROMPT,
      'EASY',
      'PROFILAGE',
      true,            // isMandatory=true pour récupérer l'erreur plutôt que process.exit
      noopSpinner,
      options
    );
  } catch (e) {
    logger.warn(`Auto-profilage : échec de l'appel API (${e.message}).`);
    return null;
  }

  if (!response || !response.content) {
    logger.warn('Auto-profilage : réponse vide du modèle.');
    return null;
  }

  const content = response.content;

  // Tentative 1 : JSON strict
  let parsed = null;
  try {
    parsed = JSON.parse(extractJSON(content));
  } catch (_) { }

  // Tentative 2 : fallback regex si le JSON échoue (modèle non-JSON natif)
  if (!validateProfile(parsed)) {
    logger.warn('Auto-profilage : JSON invalide, tentative de fallback regex.');
    parsed = parseProfileFallback(content);
  }

  if (!validateProfile(parsed)) {
    logger.warn('Auto-profilage : impossible d extraire un profil valide. Filtrage désactivé.');
    return null;
  }

  logger.info('Auto-profilage réussi : ' + JSON.stringify(parsed.skills));
  if (parsed.justification) {
    logger.info('Auto-profilage justification : ' + parsed.justification);
  }

  return parsed;
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
  getTaskSkill
};