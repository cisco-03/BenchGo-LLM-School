// startup-questionnaire.js — Questionnaire interactif guidé avant l'examen.
//
// Si aucune CLI significative n'est fournie, on interroge l'utilisateur pour
// construire la configuration du run :
//   1. Fournisseur (LM Studio / Ollama / OpenRouter / OpenAI / Anthropic / Groq /
//      Together / Mistral / Custom)
//   2. Modèle (saisie libre, ou auto-détection pour LM Studio / Ollama)
//   3. Clé API (lecture masquée via secrets.js, mise en mémoire de session)
//      — si déjà fournie en CLI ou en variable d'environnement, on ne redemande pas
//   4. Endpoint personnalisé (uniquement pour 'custom')
//   5. Profil (LIGHT / STANDARD / EXPERT / DOCTORAT / FRONTIER)
//   6. Contexte max (tokens)
//   7. Professeur IA (OpenRouter Free Router, clé masquée)
//
// La configuration finale est retournée au runner, qui l'utilise en priorité
// sur les valeurs CLI (CLI reste prioritaire si --provider / --model passés).
//
// La clé API (élève) et la clé OpenRouter (professeur) sont stockées dans
// secrets.js pour la durée de la session : pas de re-saisie entre deux écoles
// du même run. Elles sont oubliées à la fermeture du processus.

const readline = require('readline');
const secrets = require('./secrets');
const { PROFILES } = require('./config');
const { CLOUD_PROVIDERS } = require('./cloud-client');
const logger = require('./logger');

// Catalogue de fournisseurs proposés. Les providers locaux (lmstudio, ollama,
// custom) n'exigent pas de clé API ; les providers cloud en exigent une.
// `requiresAuth` provient de cloud-client.js (source de vérité).
const LOCAL_PROVIDERS = ['lmstudio', 'ollama', 'custom'];
const CLOUD_PROVIDERS_ORDERED = ['openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral'];

function _askYesNo(question, defaultNo = true) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.warn(`Session non-interactive : réponse non assumée.`);
    return false;
  }
  return new Promise((resolve) => {
    const suffix = defaultNo ? '[o/N]' : '[O/n]';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const v = (answer || '').trim().toLowerCase();
      if (!v) return resolve(!defaultNo);
      resolve(['o', 'oui', 'y', 'yes'].includes(v));
    });
  });
}

function _askFreeText(question, { allowEmpty = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      const v = (answer || '').trim();
      if (!v && !allowEmpty) return resolve(null);
      resolve(v);
    });
  });
}

function _askChoice(question, options, defaultValue) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      const v = (answer || '').trim().toLowerCase();
      if (!v) return resolve(defaultValue);
      const found = options.find(o => o.toLowerCase() === v);
      resolve(found || defaultValue);
    });
  });
}

function _printHeader() {
  console.log('');
  console.log('  \x1b[1;36m━━━━━━━━━━━━━ QUESTIONNAIRE DE DÉMARRAGE ━━━━━━━━━━━━━\x1b[0m');
  console.log('  \x1b[90mAucun flag CLI détecté : configurons le run ensemble.\x1b[0m');
  console.log('  \x1b[90m(Les valeurs sont conservées pour toute la session.)\x1b[0m');
  console.log('');
}

function _printSection(title) {
  console.log(`  \x1b[1;33m▸ ${title}\x1b[0m`);
}

// Affiche un menu de fournisseurs lisible.
function _listProviders() {
  console.log('  Fournisseurs disponibles :');
  console.log('  \x1b[90m── Locaux (aucune clé requise) ──\x1b[0m');
  console.log('    • lmstudio   — LM Studio (port 1234)');
  console.log('    • ollama     — Ollama (port 11434)');
  console.log('    • custom     — serveur OpenAI-compat personnalisé (--endpoint)');
  console.log('  \x1b[90m── Cloud (clé API requise) ──\x1b[0m');
  console.log('    • openrouter — OpenRouter (Free Router + modèles payants)');
  console.log('    • openai     — OpenAI (GPT, gpt-oss...)');
  console.log('    • anthropic  — Anthropic (Claude)');
  console.log('    • groq       — Groq (Llama, etc.)');
  console.log('    • together   — Together AI');
  console.log('    • mistral    — Mistral AI');
}

// --- Détection auto du modèle pour les serveurs locaux ---
async function _tryAutoDetectModel(provider) {
  const { fetchModelNameFromLMStudio } = require('./config');
  if (provider === 'lmstudio') {
    try {
      const name = await fetchModelNameFromLMStudio();
      return name;
    } catch (_) { return null; }
  }
  if (provider === 'ollama') {
    try {
      const res = await fetch('http://localhost:11434/api/tags', { method: 'GET' });
      if (!res.ok) return null;
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      if (models.length === 0) return null;
      return models[0];
    } catch (_) { return null; }
  }
  return null;
}

/**
 * Demande une clé API masquée pour un provider.
 * - Si la clé existe déjà en mémoire de session (re-saisie entre écoles), on
 *   la réutilise silencieusement.
 * - Si elle vient d'être fournie en CLI/env, on l'enregistre et on ne redemande pas.
 * - Sinon, on demande interactivement, on la masque à l'écran et on propose un
 *   aperçu de 3 secondes.
 */
async function _ensureApiKey(providerName, { label = 'API', revealMs = 3000 } = {}) {
  const secretKey = providerName;
  if (secrets.hasSecret(secretKey)) {
    // Déjà mémorisée pour la session — on n'affiche qu'un rappel masqué.
    console.log(`  \x1b[32mClé ${label} déjà mémorisée pour cette session :\x1b[0m ${secrets.maskedForDisplay(secrets.getSecret(secretKey))}`);
    return secrets.getSecret(secretKey);
  }

  // Variable d'environnement ?
  const envKeyNames = _envKeyForProvider(providerName);
  for (const envName of envKeyNames) {
    if (process.env[envName]) {
      secrets.rememberSecret(secretKey, process.env[envName]);
      console.log(`  \x1b[32mClé ${label} détectée via ${envName} :\x1b[0m ${secrets.maskedForDisplay(process.env[envName])}`);
      return process.env[envName];
    }
  }

  const key = await secrets.askSecret(`  Collez votre clé ${label} (saisie masquée) :`, { revealMs });
  if (!key) {
    console.log(`  \x1b[33mPas de clé ${label} — fonctionnalités associées désactivées.\x1b[0m`);
    return null;
  }
  secrets.rememberSecret(secretKey, key);
  console.log(`  \x1b[32mClé ${label} mémorisée pour la session :\x1b[0m ${secrets.maskedForDisplay(key)}`);
  return key;
}

function _envKeyForProvider(providerName) {
  const spec = CLOUD_PROVIDERS[providerName];
  if (spec && spec.envKey) return [spec.envKey];
  // Alias usuels
  if (providerName === 'openrouter') return ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'];
  return [];
}

/**
 * Exécute le questionnaire interactif complet.
 * @param {object} cliArgs - arguments déjà parsés par config.parseCliArgs (fallback)
 * @returns {Promise<object>} config résolue {
 *   provider, model, apiKey, endpoint, profile, contextLimitTokens,
 *   teacherConfig, isInteractive
 * }
 */
async function runStartupQuestionnaire(cliArgs) {
  _printHeader();

  // --- 1. Fournisseur ---
  _printSection('1. Fournisseur du modèle à tester');
  _listProviders();
  let provider = cliArgs.provider;
  if (!provider) {
    const all = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS_ORDERED];
    provider = await _askChoice(
      '  Choix du fournisseur :',
      all,
      'lmstudio'
    );
  } else {
    console.log(`  \x1b[90mFournisseur passé en CLI : ${provider}\x1b[0m`);
  }
  const isLocal = LOCAL_PROVIDERS.includes(provider);
  console.log(`  \x1b[1;35m→ Fournisseur : ${provider}${isLocal ? ' (local)' : ' (cloud)'}\x1b[0m`);
  console.log('');

  // --- 2. Modèle ---
  _printSection('2. Modèle à évaluer');
  let model = cliArgs.model;
  if (!model) {
    if (isLocal) {
      const auto = await _tryAutoDetectModel(provider);
      if (auto) {
        console.log(`  \x1b[32mModèle détecté automatiquement : ${auto}\x1b[0m`);
        const keep = await _askYesNo('  Garder ce modèle ?', false);
        if (keep) {
          model = auto;
        } else {
          model = await _askFreeText('  Saisissez le nom du modèle :', { allowEmpty: false });
        }
      } else {
        console.log('  \x1b[33mAucun modèle détecté automatiquement.\x1b[0m');
        model = await _askFreeText('  Saisissez le nom du modèle :', { allowEmpty: false });
      }
    } else {
      model = await _askFreeText('  Saisissez le nom du modèle (ex: gpt-4o, claude-3-5-sonnet, deepseek/deepseek-chat) :', { allowEmpty: false });
    }
  } else {
    console.log(`  \x1b[90mModèle passé en CLI : ${model}\x1b[0m`);
  }
  console.log('');

  // --- 3. Clé API ---
  let apiKey = cliArgs.apiKey;
  if (apiKey) {
    secrets.rememberSecret(provider, apiKey, true);
    console.log(`  \x1b[1;33m3. Clé API\x1b[0m`);
    console.log(`  \x1b[90mClé passée en CLI (visible dans le gestionnaire de tâches) :\x1b[0m ${secrets.maskedForDisplay(apiKey)}`);
    console.log('  \x1b[33mAstuce : préférez le questionnaire interactif (sans flag) pour une saisie masquée.\x1b[0m');
    console.log('');
  } else if (!isLocal) {
    _printSection('3. Clé API');
    apiKey = await _ensureApiKey(provider, { label: `API (${provider})`, revealMs: 3000 });
    console.log('');
  } else {
    console.log('  \x1b[1;33m3. Clé API\x1b[0m \x1b[90m— non requise pour les serveurs locaux.\x1b[0m');
    console.log('');
  }

  // --- 4. Endpoint personnalisé (custom uniquement) ---
  let endpoint = cliArgs.endpoint;
  if (provider === 'custom' && !endpoint) {
    _printSection('4. Endpoint personnalisé');
    endpoint = await _askFreeText('  URL complète du endpoint OpenAI-compat (ex: http://localhost:8080/v1/chat/completions) :', { allowEmpty: false });
    console.log('');
  } else if (endpoint) {
    console.log('  \x1b[1;33m4. Endpoint\x1b[0m');
    console.log(`  \x1b[90mEndpoint passé en CLI : ${endpoint}\x1b[0m`);
    console.log('');
  } else {
    console.log('  \x1b[1;33m4. Endpoint\x1b[0m \x1b[90m— par défaut pour ce fournisseur.\x1b[0m');
    console.log('');
  }

  // --- 5. Profil ---
  _printSection('5. Profil d\'évaluation');
  console.log('  Profils :');
  for (const [key, p] of Object.entries(PROFILES)) {
    console.log(`    \x1b[90m• ${key.padEnd(10)}\x1b[0m ${p.label}`);
  }
  let profileArg = cliArgs.profileArgExplicit;
  if (!profileArg) {
    // Default heuristic : local provider → STANDARD, cloud → FRONTIER.
    const defaultProfile = isLocal ? 'STANDARD' : 'FRONTIER';
    profileArg = await _askChoice(
      '  Choix du profil :',
      Object.keys(PROFILES),
      defaultProfile
    );
  } else {
    console.log(`  \x1b[90mProfil passé en CLI : ${profileArg}\x1b[0m`);
  }
  console.log(`  \x1b[1;35m→ Profil : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}\x1b[0m`);
  console.log('');

  // --- 6. Contexte max ---
  _printSection('6. Contexte max (tokens)');
  let contextLimitTokens = cliArgs.contextLimitTokens;
  if (!contextLimitTokens) {
    const raw = await _askFreeText('  Limite de contexte en tokens (Entrée = défaut 16384) :', { allowEmpty: true });
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0) contextLimitTokens = n;
    }
  }
  if (!contextLimitTokens) contextLimitTokens = 16384;
  console.log(`  \x1b[1;35m→ Contexte max : ${contextLimitTokens} tokens\x1b[0m`);
  console.log('');

  // --- 7. Professeur IA ---
  _printSection('7. Professeur correcteur (IA externe)');
  console.log("  \x1b[90mAprès chaque échec définitif, un professeur IA indépendant relit l'auto-analyse de l'élève\x1b[0m");
  console.log("  \x1b[90met démontre la vraie cause racine. (A) OpenRouter Free Router — (B) Auto-analyse classique.\x1b[0m");

  const teacherConfig = { enabled: false };
  // --no-teacher force B sans demander.
  if (cliArgs.teacherDisabled) {
    console.log('  \x1b[90mProfesseur : auto-analyse classique (--no-teacher).\x1b[0m');
  } else {
    const wantsOpenRouter = await _askYesNo('  Activer le professeur OpenRouter (Free Router) ?', true);
    if (wantsOpenRouter) {
      const teacherApiKey = await _ensureApiKey('openrouter', { label: 'OpenRouter (professeur)', revealMs: 3000 });
      teacherConfig.enabled = Boolean(teacherApiKey);
      teacherConfig.apiKey = teacherApiKey || null;
      teacherConfig.provider = 'openrouter';
      if (cliArgs.teacherModel)    teacherConfig.model    = cliArgs.teacherModel;
      if (cliArgs.teacherEndpoint) teacherConfig.endpoint = cliArgs.teacherEndpoint;
      console.log(`  \x1b[35mProfesseur OpenRouter ${teacherConfig.enabled ? 'activé' : 'désactivé (clé manquante)'}.\x1b[0m`);
    } else {
      console.log('  \x1b[90mProfesseur : auto-analyse classique.\x1b[0m');
    }
  }
  console.log('');

  // --- Récapitulatif ---
  console.log('  \x1b[1;36m━━━━━━━━━━━━━ RÉCAPITULATIF ━━━━━━━━━━━━━\x1b[0m');
  console.log(`  Fournisseur   : ${provider}`);
  console.log(`  Modèle        : ${model || '(non précisé)'}`);
  console.log(`  Clé API élève : ${apiKey ? secrets.maskedForDisplay(apiKey) : '\x1b[90m—\x1b[0m'}`);
  console.log(`  Endpoint      : ${endpoint || '\x1b[90m(par défaut)\x1b[0m'}`);
  console.log(`  Profil        : ${profileArg}`);
  console.log(`  Contexte max  : ${contextLimitTokens} tokens`);
  console.log(`  Professeur    : ${teacherConfig.enabled ? 'OpenRouter (Free Router)' : 'auto-analyse classique'}`);
  console.log('');

  return {
    provider,
    model,
    apiKey,
    endpoint,
    profileArg,
    contextLimitTokens,
    teacherConfig,
    isInteractive: true
  };
}

module.exports = {
  runStartupQuestionnaire,
  LOCAL_PROVIDERS,
  CLOUD_PROVIDERS_ORDERED
};