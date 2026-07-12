
const LM_STUDIO_API_URL = "http://localhost:1234/v1/chat/completions";
const LM_STUDIO_MODELS_URL = "http://localhost:1234/v1/models";
const EVAL_TIMEOUT_MS = 5000;
const API_TIMEOUT_MS = 900000;
const OPTIONAL_BONUS_PCT = 0.20; // Bonus appliqué aux exercices optionnels réussis (20% des points de base)

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
  // --model, --api-key et --endpoint peuvent contenir des '=' (tokens base64, URLs) → on rejoint tout après le premier '='
  const modelArgRaw    = (() => { const a = rawArgs.find(r => r.startsWith('--model='));    return a ? a.split('=').slice(1).join('=') : null; })();
  const apiKeyArgRaw   = (() => { const a = rawArgs.find(r => r.startsWith('--api-key='));  return a ? a.split('=').slice(1).join('=') : null; })();
  const endpointArgRaw = (() => { const a = rawArgs.find(r => r.startsWith('--endpoint=')); return a ? a.split('=').slice(1).join('=') : null; })();

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

  return { tierArg, profileArg, profileArgExplicit, contextLimitTokens, provider, model, apiKey, endpoint };
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

module.exports = {
  LM_STUDIO_API_URL,
  LM_STUDIO_MODELS_URL,
  EVAL_TIMEOUT_MS,
  API_TIMEOUT_MS,
  OPTIONAL_BONUS_PCT,
  PROFILES,
  CLASSE_NAMES,
  SPINNER_FRAMES,
  SPINNER_CHARS,
  WAITING_MESSAGES,
  parseCliArgs,
  detectProfileFromModelName,
  fetchModelNameFromLMStudio,
  selfProfiling
};
