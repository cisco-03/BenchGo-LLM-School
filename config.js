
const LM_STUDIO_API_URL = "http://localhost:1234/v1/chat/completions";
const LM_STUDIO_MODELS_URL = "http://localhost:1234/v1/models";
// Endpoint v0 de LM Studio : expose des métadonnées plus riches que /v1/models,
// notamment la quantification (Q4_K_M, Q5_K_S, Q8_0...), l'architecture, l'éditeur
// et l'état (loaded / not-loaded). /v1/models (compatible OpenAI) ne renvoie que
// l'id du modèle, sans la quantification — d'où l'usage de /api/v0/models ici.
const LM_STUDIO_MODELS_V0_URL = "http://localhost:1234/api/v0/models";
const EVAL_TIMEOUT_MS = 10000;
const API_TIMEOUT_MS = 300000;
// Auto-profilage : budget temps/tokens. Le profil JSON attendu est court
// (~200 tokens), mais les modèles de raisonnement (GLM, Qwen3, DeepSeek-R1) mettent
// du temps à répondre même avec reasoning désactivé. Le timeout de 60s était trop
// court et provoquait un échec systématique ("Timeout après 60s"). On le porte à 120s
// pour laisser au modèle le temps de réfléchir, tout en restant raisonnable.
const PROFILING_TIMEOUT_MS = 120000;
const PROFILING_MAX_TOKENS = 600;
const OPTIONAL_BONUS_PCT = 0.20; // Bonus appliqué aux exercices optionnels réussis (20% des points de base)

// --- Professeur (correcteur IA distinct de l'élève) ---
// Après un échec définitif, l'élève (le modèle testé) s'auto-analyse. Puis un
// PROFESSEUR indépendant — un modèle cloud plus robuste — relit cette analyse,
// identifie ce qui est juste/faux et DÉMONTRE la vraie cause racine. Cela évite
// qu'un modèle faible se contredise lui-même ou valide une analyse erronée.
//
// Par défaut : OpenRouter gratuit (aucune clé requise pour les modèles :free).
// Override possible via --teacher-model / --teacher-api-key / --teacher-endpoint.
const TEACHER_CONFIG = {
  enabled: true,
  provider: 'openrouter',
  // Modèle gratuit par défaut (clean, bon en français, robuste pour la critique).
  model: 'meta-llama/llama-3.3-70b-instruct:free',
  apiKey: null,         // Surcharge via --teacher-api-key ou OPENROUTER_API_KEY
  endpoint: null,      // Surcharge via --teacher-endpoint (rare)
  maxRetries: 3,       // Tentatives avant repli sur l'auto-analyse de l'élève
  temperature: 0.15,    // Déterministe mais pas rigide pour l'analyse pédagogique
  maxTokens: 512        // Limite stricte : l'analyse prof doit rester concise
};

const PROFILES = {
  LIGHT:    { mandatory: [0, 1],          optional: [2, 3, 4, 5],    label: "LIGHT — Primaire (< 3B paramètres)",                      ecole: "Primaire"    },
  STANDARD: { mandatory: [0, 1, 2],       optional: [3, 4, 5, 6],    label: "STANDARD — Collège/Lycée (3B – 14B paramètres)",         ecole: "College-Lycee" },
  EXPERT:   { mandatory: [0, 1, 2, 3],    optional: [6],             label: "EXPERT — Université (14B – 30B paramètres)",               ecole: "Universite"    },
  DOCTORAT: { mandatory: [0, 1, 2, 3, 6], optional: [],              label: "DOCTORAT — Thèse (> 30B paramètres)",                     ecole: "Doctorat-These" },
  FRONTIER: { mandatory: [0, 1, 2, 3, 4, 6], optional: [],           label: "FRONTIER — Post-Doctorat (modèles cloud frontier)",        ecole: "Post-Doctorat" }
};

// Noms de classes par profil et numéro de tier (pour les dossiers d'export)
const CLASSE_NAMES = {
  LIGHT:    { 0: "Classe-0-Maternelle", 1: "Classe-1-CP",        2: "Classe-2-CE1",          3: "Classe-3-CE2",        4: "Classe-4-CM1",         5: "Classe-5-CM2" },
  STANDARD: { 0: "Classe-0-6eme",       1: "Classe-1-5eme",      2: "Classe-2-4eme",         3: "Classe-3-3eme",       4: "Classe-4-2nde",        5: "Classe-5-1ere", 6: "Classe-6-Terminale" },
  EXPERT:   { 0: "Classe-0-Licence1",   1: "Classe-1-Licence2",  2: "Classe-2-L3-Master1",   3: "Classe-3-Master2",    6: "Classe-6-Doctorat" },
  DOCTORAT: { 0: "Classe-0-Doctorat1",  1: "Classe-1-Doctorat2", 2: "Classe-2-Doctorat3",    3: "Classe-3-Soutenance", 6: "Classe-6-Expertise" },
  FRONTIER: { 0: "Classe-0-PostDoc1",   1: "Classe-1-PostDoc2",  2: "Classe-2-PostDoc3",     3: "Classe-3-PostDoc4",   4: "Classe-4-Frontier", 6: "Classe-6-Ultimate" }
};

// Auto-profilage & Calibration : le runner interroge le modèle au démarrage pour
// qu'il s'auto-évalue sur 4 compétences clés, puis filtre les tâches trop difficiles
// selon le niveau déclaré. bypassFilter=true garde le profilage mais exécute tout.
const selfProfiling = {
  enabled: true,
  minLevelToTest: 2,     // Niveau minimum déclaré (1 à 5) pour lancer les tests associés
  bypassFilter: false    // true = profilage conservé mais exécution de TOUS les tests
};

const SPINNER_FRAMES = '\u2588';

const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const WAITING_MESSAGES = [
  "Veuillez patienter, je réfléchis très fort...",
  "Consultation des circuits neuronaux en cours...",
  "Le modèle rassemble ses idées (et son courage)...",
  "Chargement de l'inspiration artificielle...",
  "Ça mouline sec dans les GPU...",
  "Chut, ça réfléchit...",
  "Le modèle pèse le pour et le contre...",
  "Encore un peu de patience, le génie prend son temps...",
  "Recherche de la réponse parfaite en cours...",
  "Ne débranchez surtout rien, ça pense fort là-dedans...",
  "Le modèle fait chauffer ses neurones artificiels...",
  "Analyse en cours, merci de ne pas réveiller le modèle..."
];

function parseCliArgs() {
  const rawArgs = process.argv.slice(2);
  const tierArg = rawArgs.find(a => !a.startsWith('--')) || "all";
  const profileArgRaw    = ((rawArgs.find(a => a.startsWith('--profile='))       || '').split('=')[1]);
  const contextLimitRaw  = ((rawArgs.find(a => a.startsWith('--context-limit=')) || '').split('=')[1]);
  const providerArgRaw   = ((rawArgs.find(a => a.startsWith('--provider='))      || '').split('=')[1]);
  // --model, --api-key et --endpoint peuvent contenir des '=' (tokens base64, URLs) → on joint tout après le premier '='
  const modelArgRaw    = (() => { const a = rawArgs.find(r => r.startsWith('--model='));    return a ? a.split('=').slice(1).join('=') : null; })();
  const apiKeyArgRaw   = (() => { const a = rawArgs.find(r => r.startsWith('--api-key='));  return a ? a.split('=').slice(1).join('=') : null; })();
  const endpointArgRaw = (() => { const a = rawArgs.find(r => r.startsWith('--endpoint=')); return a ? a.split('=').slice(1).join('=') : null; })();

  // --- Override du professeur (modèle cloud indépendant qui corrige l'élève) ---
  const teacherModelRaw    = (() => { const a = rawArgs.find(r => r.startsWith('--teacher-model='));    return a ? a.split('=').slice(1).join('=') : null; })();
  const teacherApiKeyRaw   = (() => { const a = rawArgs.find(r => r.startsWith('--teacher-api-key='));  return a ? a.split('=').slice(1).join('=') : null; })();
  const teacherEndpointRaw = (() => { const a = rawArgs.find(r => r.startsWith('--teacher-endpoint=')); return a ? a.split('=').slice(1).join('=') : null; })();
  const teacherDisabledRaw = rawArgs.includes('--no-teacher');

  // Quantification du modèle (ex: Q4_K_M, Q5_K_S, Q8_0...). Les serveurs locaux
  // (LM Studio, Ollama) ne l'exposent pas toujours dans le nom du modèle, et
  // /v1/models (OpenAI-compat) ne la renvoie pas non plus. On la récupère via
  // /api/v0/models (LM Studio) ou on la prend depuis ce flag CLI / le questionnaire.
  const quantizationRaw = (() => { const a = rawArgs.find(r => r.startsWith('--quantization=')); return a ? a.split('=').slice(1).join('=') : null; })();

  const profileArgExplicit = profileArgRaw ? profileArgRaw.toUpperCase() : null;
  const parsedContextLimit = contextLimitRaw ? parseInt(contextLimitRaw, 10) : null;
  const contextLimitTokens = Number.isInteger(parsedContextLimit) && parsedContextLimit > 0
    ? parsedContextLimit
    : null;
  const provider = providerArgRaw ? providerArgRaw.toLowerCase() : null;
  const model    = modelArgRaw  || null;
  const apiKey   = apiKeyArgRaw || null;
  const endpoint = endpointArgRaw || null;

  // Si --provider est spécifié sans --profile, on présume un modèle frontier
  let profileArg = profileArgExplicit || (provider ? 'FRONTIER' : 'STANDARD');

  return { tierArg, profileArg, profileArgExplicit, contextLimitTokens, provider, model, apiKey, endpoint,
           teacherModel: teacherModelRaw, teacherApiKey: teacherApiKeyRaw, teacherEndpoint: teacherEndpointRaw,
           teacherDisabled: teacherDisabledRaw, quantization: quantizationRaw };
}

function detectProfileFromModelName(modelName) {
  const sizePatterns = [
    /([\d]+[.,]?[\d]*)\s*b/i,
    /([\d]+[.,]?[\d]*)\s*billion/i,
    /([\d]+[.,]?[\d]*)\s*g/
  ];

  let paramSize = null;
  for (const pattern of sizePatterns) {
    const match = modelName.match(pattern);
    if (match) {
      paramSize = parseFloat(match[1].replace(',', '.'));
      break;
    }
  }

  let detected = null;
  if (paramSize !== null) {
    if (paramSize < 3)   detected = 'LIGHT';
    else if (paramSize <= 14) detected = 'STANDARD';
    else if (paramSize <= 30) detected = 'EXPERT';
    else detected = 'DOCTORAT';
  }

  return { paramSize, detected };
}

async function fetchModelNameFromLMStudio() {
  try {
    const response = await fetch(LM_STUDIO_MODELS_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.data && data.data.length > 0) {
      return data.data[0].id || data.data[0].name || null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Récupère les métadonnées riches d'un modèle depuis l'endpoint v0 de LM Studio.
// Contrairement à /v1/models (qui ne donne que l'id), /api/v0/models renvoie la
// quantification (Q4_K_M, Q5_K_S, Q8_0...), l'architecture, l'éditeur et l'état.
//
// @param {string|null} modelId - id du modèle à cibler (ex: "mythos-9b-unhinged").
//   Si null/undefined : renvoie le premier modèle "loaded", sinon le premier tout
//   court.
// @returns {Promise<object|null>} { name, quantization, arch, publisher, state,
//   maxContextLength } ou null si indisponible (LM Studio éteint, endpoint absent,
//   modèle introuvable).
async function fetchModelMetadataFromLMStudio(modelId) {
  try {
    const response = await fetch(LM_STUDIO_MODELS_V0_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.data || data.data.length === 0) return null;

    // Cherche l'entrée correspondant à modelId (priorité au modèle chargé si
    // plusieurs partagent le même id). Si modelId est absent, on prend le premier
    // modèle "loaded", sinon le premier de la liste.
    let entry = null;
    if (modelId) {
      const matches = data.data.filter(m => m.id === modelId);
      if (matches.length > 0) {
        entry = matches.find(m => m.state === 'loaded') || matches[0];
      }
    }
    if (!entry) {
      entry = data.data.find(m => m.state === 'loaded') || data.data[0];
    }

    return {
      name: entry.id || null,
      quantization: entry.quantization || null,
      arch: entry.arch || null,
      publisher: entry.publisher || null,
      state: entry.state || null,
      maxContextLength: entry.max_context_length || null
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  LM_STUDIO_API_URL,
  LM_STUDIO_MODELS_URL,
  LM_STUDIO_MODELS_V0_URL,
  EVAL_TIMEOUT_MS,
  API_TIMEOUT_MS,
  PROFILING_TIMEOUT_MS,
  PROFILING_MAX_TOKENS,
  OPTIONAL_BONUS_PCT,
  PROFILES,
  CLASSE_NAMES,
  SPINNER_FRAMES,
  SPINNER_CHARS,
  WAITING_MESSAGES,
  TEACHER_CONFIG,
  parseCliArgs,
  detectProfileFromModelName,
  fetchModelNameFromLMStudio,
  fetchModelMetadataFromLMStudio,
  selfProfiling
};
