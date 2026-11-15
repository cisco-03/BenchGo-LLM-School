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
const apiKeysStore = require('./api-keys-store');
const { PROFILES, fetchModelMetadataFromLMStudio, fetchAllModelsFromLMStudio } = require('./config');
const { CLOUD_PROVIDERS } = require('./cloud-client');
const logger = require('./logger');
const nightBatch = require('./night-batch');
const archWarning = require('./arch-warning');

// Constante couleur (reset ANSI) — évite la répétition des escapes.
const C_RESET = '\x1b[0m';

// Catalogue de fournisseurs proposés. Les providers locaux (lmstudio, ollama,
// custom) n'exigent pas de clé API ; les providers cloud en exigent une.
// `requiresAuth` provient de cloud-client.js (source de vérité).
const LOCAL_PROVIDERS = ['lmstudio', 'ollama', 'custom'];
const CLOUD_PROVIDERS_ORDERED = ['openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral'];

// Catalogue des fournisseurs du PROFESSEUR CORRECTEUR (étape 7, demande
// utilisateur 2026-11-15 : « une petite liste interactive où l'on choisit chez
// qui on veut aller pour le professeur »). Le professeur n'est plus limité à
// OpenRouter : le même menu couvre le cloud (clé API), les serveurs locaux
// (aucune clé) et l'option « aucun » (auto-analyse classique).
// - `defaultModel` : modèle proposé par Entrée pour tout provider non-openrouter
//   (teacher-client.js EXIGE un modèle pour un provider != openrouter — il
//   désactive le professeur sinon). Pour lmstudio/ollama/custom, le modèle est
//   spécifique à la MACHINE (liste numérotée des modèles installés), donc
//   defaultModel = null : saisie libre + exemple.
// - `local: true` → pas de clé API demandée.
// - `none: true` → option « aucun professeur » (auto-analyse classique).
// Partagé avec runner.js (prompt professeur du chemin CLI direct).
const TEACHER_PROVIDERS_MENU = [
  { value: 'openrouter', local: false, none: false, defaultModel: '',                          example: '',                                detail: 'OpenRouter (Free Router :free, rotation auto) — défaut' },
  { value: 'groq',       local: false, none: false, defaultModel: 'llama-3.3-70b-versatile',  example: 'llama-3.3-70b-versatile',         detail: 'Groq (très rapide, clé gratuite)' },
  { value: 'openai',     local: false, none: false, defaultModel: 'gpt-4o-mini',              example: 'gpt-4o-mini',                     detail: 'OpenAI (GPT)' },
  { value: 'anthropic',  local: false, none: false, defaultModel: 'claude-sonnet-4-5',        example: 'claude-sonnet-4-5',               detail: 'Anthropic (Claude)' },
  { value: 'together',   local: false, none: false, defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', example: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', detail: 'Together AI (OpenAI-compat)' },
  { value: 'mistral',    local: false, none: false, defaultModel: 'mistral-large-latest',     example: 'mistral-large-latest',            detail: 'Mistral AI (La Plateforme)' },
  { value: 'deepseek',   local: false, none: false, defaultModel: 'deepseek-chat',            example: 'deepseek-chat',                   detail: 'DeepSeek (OpenAI-compat)' },
  { value: 'cohere',     local: false, none: false, defaultModel: 'command-r-plus',           example: 'command-r-plus',                  detail: 'Cohere (Command R+)' },
  { value: 'kilo',       local: false, none: false, defaultModel: 'kilo-auto/free',           example: 'kilo-auto/free',                  detail: 'Kilo Gateway (modèles :free, alternative OpenRouter)' },
  { value: 'ollama',     local: true,  none: false, defaultModel: '',                         example: 'llama3.3:8b',                     detail: 'Ollama local (sans clé, port 11434)' },
  { value: 'lmstudio',   local: true,  none: false, defaultModel: '',                         example: 'nom du modèle chargé',            detail: 'LM Studio local (sans clé, port 1234)' },
  { value: 'custom',     local: true,  none: false, defaultModel: '',                         example: 'gpt-4o-mini',                     detail: 'serveur OpenAI-compat personnalisé (--teacher-endpoint)' },
  { value: 'aucun',      local: false, none: true,  defaultModel: '',                         example: '',                                detail: 'Auto-analyse classique (pas de professeur)' }
];

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

// Question à choix numéroté : affiche les entrées "1. lmstudio — ..." et lit un
// NUMÉRO (Entrée = défaut). Repli : le nom exact reste accepté (rétrocompat des
// habitudes "lmstudio", "light"...). Plus rapide que de retaper le nom à la main.
//
// opts.commands : saisies spéciales renvoyées BRUTES à l'appelant quand rien ne
// matche (ex: "list"/"liste" = commande interceptée par l'appelant). Les autres
// saisies inconnues tombent toujours sur le défaut (une typo ne doit pas
// sélectionner un modèle inexistant).
function _askNumberedChoice(question, entries, defaultIndex = 0, opts = {}) {
  const commands = opts.commands || [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return entries[defaultIndex] ? entries[defaultIndex].value : undefined;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      const v = (answer || '').trim().toLowerCase();
      if (!v) return resolve(entries[defaultIndex].value);
      const n = parseInt(v, 10);
      if (Number.isInteger(n) && n >= 1 && n <= entries.length) {
        return resolve(entries[n - 1].value);
      }
      const found = entries.find(e => String(e.value).toLowerCase() === v);
      if (found) return resolve(found.value);
      if (commands.includes(v)) return resolve(v);
      resolve(entries[defaultIndex].value);
    });
  });
}

// --- Sélection MULTI de modèles (demande 2026-11-11) ---
// Parseur PUR (testable via tests/test-runcode-batch-menu.js) : transforme une
// saisie du menu « Choix du modèle » en sélection structurée.
//   ''        → { type: 'single', … } défaut (rétrocompat)
//   auto/all  → { type: 'auto' } : TOUS les modèles candidats (les incompatibles,
//               non-LLM et isolés sont écartés par l'APPELANT, pas ici)
//   1,2,3     → { type: 'multi', indexes, values } — virgules, plages "1-4",
//               noms exacts acceptés en mélange
//   list      → { type: 'commands' } passthrough (commande interceptée par l'appelant)
//   numéro/nom unique → { type: 'single' } (comportement historique)
//   saisie inconnue multi-partie invalide → { type: 'unknown' } : l'appelant
//               REPOSE la question (une typo ne doit jamais avaler une sélection).
//               Une saisie inconnue à une seule partie retombe sur le défaut
//               (habitude 2026-09-11b conservée : typo = modèle par défaut).
function _parseMultiSelection(raw, entries, defaultIndex = 0, opts = {}) {
  const commands = opts.commands || [];
  const v = String(raw || '').trim().toLowerCase();
  if (!v) {
    return { type: 'single', indexes: [defaultIndex], values: [entries[defaultIndex] ? entries[defaultIndex].value : null] };
  }
  if (commands.includes(v)) return { type: 'commands', values: [v] };
  if (['auto', 'all', 'tous', 'tout'].includes(v)) return { type: 'auto', values: [] };
  const parts = v.split(',').map(p => p.trim()).filter(p => p.length > 0);
  // Une PLAGE seule ("1-3", sans virgule) est aussi une sélection multiple.
  const rangeOnly = parts.length === 1 && /^\d+\s*-\s*\d+$/.test(parts[0]);
  if (parts.length > 1 || rangeOnly) {
    const indexes = [];
    for (const t of parts) {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
      if (range) {
        const a = parseInt(range[1], 10);
        const b = parseInt(range[2], 10);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) {
          if (i >= 1 && i <= entries.length && !indexes.includes(i - 1)) indexes.push(i - 1);
        }
        continue;
      }
      const n = parseInt(t, 10);
      if (Number.isInteger(n) && String(n) === t && n >= 1 && n <= entries.length) {
        if (!indexes.includes(n - 1)) indexes.push(n - 1);
        continue;
      }
      const bi = entries.findIndex(e => String(e.value).toLowerCase() === t);
      if (bi >= 0) {
        if (!indexes.includes(bi)) indexes.push(bi);
        continue;
      }
      return { type: 'unknown', values: [raw] };
    }
    if (indexes.length > 0) {
      return { type: 'multi', indexes, values: indexes.map(i => entries[i].value) };
    }
    return { type: 'unknown', values: [raw] };
  }
  const n = parseInt(v, 10);
  if (Number.isInteger(n) && String(n) === v && n >= 1 && n <= entries.length) {
    return { type: 'single', indexes: [n - 1], values: [entries[n - 1].value] };
  }
  const found = entries.find(e => String(e.value).toLowerCase() === v);
  if (found) {
    const idx = entries.indexOf(found);
    return { type: 'single', indexes: [idx], values: [found.value] };
  }
  return { type: 'single', indexes: [defaultIndex], values: [entries[defaultIndex] ? entries[defaultIndex].value : null] };
}

// Wrapper TTY : pose la question et renvoie la sélection parsée. Non-TTY →
// défaut unique (le batch de nuit ne doit jamais bloquer sur la saisie).
async function _askModelSelection(question, entries, defaultIndex = 0, opts = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { type: 'single', indexes: [defaultIndex], values: [entries[defaultIndex] ? entries[defaultIndex].value : null] };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const raw = await new Promise(resolve => {
    rl.question(`${question} `, answer => { rl.close(); resolve(answer); });
  });
  return _parseMultiSelection(raw, entries, defaultIndex, opts);
}

// Liste les modèles Ollama via /api/tags (nom uniquement — pas d'état/quantif).
async function _fetchOllamaModels() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { method: 'GET' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({
      name: m.name,
      quantization: null,
      arch: null,
      publisher: null,
      state: null
    }));
  } catch (_) {
    return [];
  }
}

// --- Statut des modèles locaux (compartiments) — tâche 2026-09-11 ---
// Enrichit le menu « Choix du modèle » avec le statut de test de chaque modèle
// (déjà testé + score, partiel, en échec, isolé, jamais testé), exactement
// comme `night-batch.js --list-only`. Source : listLlmModels() de night-batch
// (lms ls + carnets .carnet + historique .benchgo-run-history.json + blacklist).
//
// Renvoie une Map normalizedName -> { label, badge, colored } pour annoter la
// liste affichée. Vide si lms/carnets indisponibles (dégradation silencieuse).
const STATUS_BADGE_COLORS = {
  tested:   { glyph: '✓', color: '\x1b[32m', label: 'TESTÉ' },
  partial:  { glyph: '~', color: '\x1b[35m', label: 'PARTIEL' },
  failed:   { glyph: '✘', color: '\x1b[31m', label: 'ÉCHEC' },
  never:    { glyph: '·', color: '\x1b[33m', label: 'À TESTER' },
  isolated: { glyph: '⊘', color: '\x1b[90m', label: 'ISOLÉ' }
};

// Glyphe ANSI par statut (kind) : compact, lisible dans le menu numéroté.
// runcode : tremplin RunCode passé (écoles RunCode-* au carnet), grande école
// à venir (fix 2026-09-16 : la liste ne se mettait pas à jour après un examen
// RunCode réussi — les écoles RunCode-* étaient ignorées par ledgerSchoolKeys).
const STATUS_GLYPHS = {
  complete: { glyph: '✓', color: '\x1b[32m' },
  runcode:  { glyph: '⚡', color: '\x1b[35m' },
  partial:  { glyph: '~', color: '\x1b[35m' },
  failed:   { glyph: '✘', color: '\x1b[31m' },
  never:    { glyph: '·', color: '\x1b[33m' },
  nonllm:   { glyph: '⊘', color: '\x1b[90m' }
};

function _statusMapForModels(models) {
  const map = new Map();
  try {
    const list = nightBatch.listLlmModels();
    if (!list.ok) return map;
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\.gguf$/i, '').split('@')[0];
    // listLlmModels renvoie des modelKey lms (ex: "kai-os_grug-12b@q4_k_s").
    // Le questionnaire renvoie des ids /v1/models (souvent le même basename).
    // Matching : normalisé (sans @quant, sans .gguf) — suffisant pour annoter.
    for (const m of list.models) {
      const kind = (m.status && m.status.kind) || 'never';
      const badge = nightBatch.statusBadge(m.status);
      const mt = m.metrics;
      let detail = badge.label;
      if (mt) detail += ` · ${mt.pct}%${mt.tokensPerSecond > 0 ? ` · ${mt.tokensPerSecond} t/s` : ''}`;
      // Statut runcode : le pct du tremplin est dans m.status.runCode (pas de
      // metrics classiques) — l'afficher pour que le menu montre le score.
      else if (kind === 'runcode' && m.status.runCode && m.status.runCode.pct != null) {
        detail += ` · ${m.status.runCode.pct}%${m.status.runCode.specialite ? ` · ${String(m.status.runCode.specialite).toUpperCase()}` : ''}`;
      }
      else if (m.status.reason) detail += ` (${m.status.reason})`;
      map.set(norm(m.modelKey), { kind, badge, detail });
    }
  } catch (e) { /* lms absent : liste simple sans statuts */ }
  return map;
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
    // Clé déjà mémorisée pour la session (restaurée de .api-keys.json au
    // démarrage, ou saisie plus tôt). On propose de la garder OU d'en saisir
    // une nouvelle : une clé révoquée/invalide ne doit pas piéger
    // l'utilisateur (sinon il doit connaître --forget-key pour s'en sortir).
    // ATTENTION : ne JAMAIS ré-afficher la ligne « déjà mémorisée » deux fois
    // (bug historique : un console.log dans le if TTY + un console.log après
    // le bloc → la clé s'affichait en double après « Utiliser cette clé ? o »).
    const display = `  \x1b[32mClé ${label} déjà mémorisée pour cette session :\x1b[0m ${secrets.maskedForDisplay(secrets.getSecret(secretKey))}`;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log(display);
      const keep = await _askYesNo('  Utiliser cette clé mémorisée ?', true);
      if (!keep) {
        const newKey = await secrets.askSecret(`  Collez votre NOUVELLE clé ${label} (saisie masquée) :`, { revealMs });
        if (newKey) {
          secrets.rememberSecret(secretKey, newKey);
          apiKeysStore.saveKey(secretKey, newKey);
          console.log(`  \x1b[32mNouvelle clé ${label} mémorisée :\x1b[0m ${secrets.maskedForDisplay(newKey)}`);
          return newKey;
        }
        console.log(`  \x1b[33mNouvelle clé vide — utilisation de la clé précédente.\x1b[0m`);
        return secrets.getSecret(secretKey);
      }
      return secrets.getSecret(secretKey);
    }
    console.log(display);
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
  apiKeysStore.saveKey(secretKey, key);
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
 * Affiche le catalogue numéroté des fournisseurs du professeur (partagé par
 * l'étape 7 du questionnaire ET les menus compacts des batchers).
 */
function _printTeacherMenu() {
  console.log('  \x1b[90mChez qui le professeur correcteur tourne-t-il ?\x1b[0m');
  const localIdx = TEACHER_PROVIDERS_MENU.findIndex(p => p.local);
  const noneIdx  = TEACHER_PROVIDERS_MENU.findIndex(p => p.none);
  TEACHER_PROVIDERS_MENU.forEach((p, i) => {
    if (i === 0)        console.log('  \x1b[90m── Cloud (clé API requise) ──\x1b[0m');
    if (i === localIdx) console.log('  \x1b[90m── Locaux (sans clé) ──\x1b[0m');
    if (i === noneIdx)  console.log('  \x1b[90m── Sans professeur ──\x1b[0m');
    const modelHint = p.defaultModel ? ` · défaut : ${p.defaultModel}` : '';
    console.log(`    \x1b[1m${i + 1}.\x1b[0m ${p.value.padEnd(10)} — ${p.detail}${modelHint}`);
  });
}

/**
 * Menu COMPACT du professeur, réutilisable par les batchers (night-batch,
 * frontier-batch) dont le runner enfant est lancé avec --force : sans flags
 * transmis, il garderait openrouter sans jamais proposer la liste (demande
 * utilisateur 2026-11-15 : « tous les modes CLI »).
 * N'affiche NI clé NI endpoint : les runners enfants les résolvent depuis
 * .api-keys.json (restoreIntoSession) et --teacher-endpoint. L'appelant
 * traduit le choix en --teacher-provider= / --teacher-model=.
 * Retourne { provider, model } — provider null = « aucun professeur »
 * (auto-analyse classique), model null = Free Router (openrouter).
 */
async function askTeacherSelection() {
  _printTeacherMenu();
  const choices = TEACHER_PROVIDERS_MENU.map(p => ({ value: p.value }));
  const provider = await _askNumberedChoice('  Choix du fournisseur (numéro ou nom, Entrée = 1) :', choices, 0);
  if (provider === 'aucun') {
    console.log('  \x1b[90mProfesseur : auto-analyse classique.\x1b[0m');
    return { provider: null, model: null };
  }
  if (provider === 'openrouter') {
    console.log('  \x1b[90mProfesseur openrouter : Free Router (rotation des modèles :free).\x1b[0m');
    return { provider, model: null };
  }
  const spec = TEACHER_PROVIDERS_MENU.find(p => p.value === provider) || null;
  const defaultModel = spec && spec.defaultModel ? spec.defaultModel : null;
  const example = spec && spec.example ? spec.example : 'nom du modèle';
  const raw = await _askFreeText(`  Modèle du professeur (ex: ${example}${defaultModel ? `, Entrée = ${defaultModel}` : ''}) :`, { allowEmpty: true });
  const model = raw || defaultModel;
  if (!model) {
    console.log('  \x1b[33mAucun modèle fourni — le professeur repliera sur l\'auto-analyse.\x1b[0m');
    return { provider, model: null };
  }
  console.log(`  \x1b[90mProfesseur ${provider} (${model}).\x1b[0m`);
  return { provider, model };
}

/**
 * Étape 7b : modèle du professeur correcteur.
 * Pour tout provider non-openrouter, teacher-client.js EXIGE un modèle précis
 * (sans --teacher-model le professeur se désactive à l'appel et replie sur
 * l'auto-analyse). La question est donc posée ici :
 * - serveurs locaux (ollama/lmstudio) : liste numérotée des modèles RÉELLEMENT
 *   installés (le professeur doit être PLUS capable que l'élève — le menu le
 *   rappelle) ; serveur injoignable → repli sur saisie libre ;
 * - cloud : saisie libre avec Entrée = modèle par défaut du catalogue.
 * Renvoie le nom du modèle, ou null (professeur à désactiver).
 */
async function _askTeacherModel(provider, spec) {
  if (provider === 'ollama' || provider === 'lmstudio') {
    try {
      const models = provider === 'lmstudio'
        ? await fetchAllModelsFromLMStudio()
        : await _fetchOllamaModels();
      if (models && models.length > 0) {
        console.log(`  \x1b[32m${models.length} modèle(s) ${provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} installé(s) :\x1b[0m`);
        models.forEach((m, i) => {
          const badges = [];
          if (m.state === 'loaded') badges.push('chargé');
          if (m.quantization) badges.push(m.quantization);
          if (m.publisher)    badges.push(m.publisher);
          const suffix = badges.length > 0 ? ` \x1b[90m(${badges.join(' · ')})\x1b[0m` : '';
          console.log(`    \x1b[1m${i + 1}.\x1b[0m ${m.name}${suffix}`);
        });
        console.log('  \x1b[90mLe professeur doit être PLUS capable que l\'élève — prenez le modèle le plus fort.\x1b[0m');
        const picked = await _askNumberedChoice('  Modèle du professeur (numéro ou nom, Entrée = 1) :', models.map(m => ({ value: m.name })), 0);
        return picked || null;
      }
      console.log(`  \x1b[33mAucun modèle ${provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} détecté — saisie libre.\x1b[0m`);
    } catch (e) { /* serveur local injoignable : repli sur saisie libre */ }
  }
  const defaultModel = spec && spec.defaultModel ? spec.defaultModel : '';
  const example = spec && spec.example ? spec.example : 'nom du modèle';
  const raw = await _askFreeText(`  Modèle du professeur (ex: ${example}${defaultModel ? `, Entrée = ${defaultModel}` : ''}) :`, { allowEmpty: true });
  if (raw) return raw;
  if (defaultModel) {
    console.log(`  \x1b[90mModèle du professeur par défaut : ${defaultModel}\x1b[0m`);
    return defaultModel;
  }
  return null;
}

/**
 * Étape 7 : configuration interactive du professeur correcteur.
 * Menu numéroté de fournisseurs (cloud + locaux + « aucun ») — l'utilisateur
 * choisit CHEZ QUI tourne le correcteur IA (OpenRouter Free Router n'est plus
 * la seule option, demande utilisateur 2026-11-15). Priorités : CLI
 * (--teacher-provider / --teacher-model / --teacher-api-key) > interactif.
 * Retourne { enabled, provider, model, apiKey, endpoint } (enabled=false =
 * auto-analyse classique).
 */
async function _configureTeacher(cliArgs) {
  // --- Fournisseur ---
  let provider = 'openrouter';
  if (cliArgs.teacherProvider) {
    const cliProv = String(cliArgs.teacherProvider).toLowerCase();
    if (TEACHER_PROVIDERS_MENU.some(p => p.value === cliProv)) {
      provider = cliProv;
      console.log(`  \x1b[90mFournisseur passé en CLI : ${provider}.\x1b[0m`);
    } else {
      console.log(`  \x1b[33mFournisseur professeur « ${cliProv} » inconnu — repli sur openrouter (Free Router).\x1b[0m`);
    }
  } else {
    _printTeacherMenu();
    const choices = TEACHER_PROVIDERS_MENU.map(p => ({ value: p.value }));
    provider = await _askNumberedChoice('  Choix du fournisseur (numéro ou nom, Entrée = 1) :', choices, 0);
    if (provider === 'aucun') {
      console.log('  \x1b[90mProfesseur : auto-analyse classique.\x1b[0m');
      return { enabled: false };
    }
  }
  const spec = TEACHER_PROVIDERS_MENU.find(p => p.value === provider) || null;
  const isLocal = Boolean(spec && spec.local);
  console.log(`  \x1b[1;35m→ Professeur : ${provider}${isLocal ? ' (local)' : ' (cloud)'}\x1b[0m`);

  const teacherConfig = { enabled: true, provider, apiKey: null };

  // --- Clé API (cloud uniquement) ---
  if (!isLocal) {
    let teacherApiKey = null;
    if (cliArgs.teacherApiKey) {
      teacherApiKey = cliArgs.teacherApiKey;
      secrets.rememberSecret(provider, teacherApiKey);
      console.log(`  \x1b[90mClé ${provider} (professeur) passée en CLI : ${secrets.maskedForDisplay(teacherApiKey)}\x1b[0m`);
    } else {
      teacherApiKey = await _ensureApiKey(provider, { label: `${provider} (professeur)`, revealMs: 3000 });
    }
    if (!teacherApiKey) {
      console.log(`  \x1b[33mProfesseur désactivé (clé ${provider} manquante) — auto-analyse classique.\x1b[0m`);
      return { enabled: false };
    }
    teacherConfig.apiKey = teacherApiKey;
  }

  // --- Endpoint (custom uniquement : serveur à désigner explicitement) ---
  if (cliArgs.teacherEndpoint) {
    teacherConfig.endpoint = cliArgs.teacherEndpoint;
  } else if (provider === 'custom') {
    const ep = await _askFreeText('  Endpoint du serveur OpenAI-compat (ex: http://localhost:8000/v1/chat/completions) :', { allowEmpty: true });
    if (!ep) {
      console.log('  \x1b[33mProfesseur désactivé (endpoint custom manquant) — auto-analyse classique.\x1b[0m');
      return { enabled: false };
    }
    teacherConfig.endpoint = ep;
  }

  // --- Modèle ---
  // openrouter : rien à demander (Free Router choisit un modèle :free, défaut
  // 'openrouter/free'). Tous les autres : le modèle est REQUIS (cf.
  // _askTeacherModel) — sans lui le professeur se désactiverait à l'appel.
  let teacherModel = cliArgs.teacherModel || null;
  if (provider === 'openrouter') {
    if (teacherModel) console.log(`  \x1b[90mModèle professeur passé en CLI : ${teacherModel} (sinon Free Router).\x1b[0m`);
  } else if (teacherModel) {
    console.log(`  \x1b[90mModèle professeur passé en CLI : ${teacherModel}.\x1b[0m`);
  } else {
    teacherModel = await _askTeacherModel(provider, spec);
  }
  if (!teacherModel) {
    console.log(`  \x1b[33mModèle du professeur requis pour ${provider} — professeur désactivé, auto-analyse classique.\x1b[0m`);
    return { enabled: false };
  }
  teacherConfig.model = teacherModel;
  console.log(`  \x1b[35mProfesseur : ${provider}${teacherModel ? ` (${teacherModel})` : ''} activé.\x1b[0m`);
  return teacherConfig;
}

/**
 * Exécute le questionnaire interactif complet.
 * @param {object} cliArgs - arguments déjà parsés par config.parseCliArgs (fallback)
 * @param {object} opts - { examCode: true } quand le run cible est RunCode
 *   (--exam-code) : le menu modèle gagne la multi-sélection/auto et les étapes
 *   grande école (8 cible, 9 FLASH) laissent place au mode Turbo/ÉCLAIR.
 * @returns {Promise<object>} config résolue {
 *   provider, model, apiKey, endpoint, profile, contextLimitTokens,
 *   teacherConfig, isInteractive, models, eclair
 * }
 */
async function runStartupQuestionnaire(cliArgs, opts = {}) {
  const examCode = Boolean(opts && opts.examCode);
  _printHeader();

  // --- 1. Fournisseur ---
  _printSection('1. Fournisseur du modèle à tester');
  const providerEntries = [
    { value: 'lmstudio',   detail: 'LM Studio (port 1234)' },
    { value: 'ollama',     detail: 'Ollama (port 11434)' },
    { value: 'custom',     detail: 'serveur OpenAI-compat personnalisé (--endpoint)' },
    { value: 'openrouter', detail: 'OpenRouter (Free Router + modèles payants)' },
    { value: 'openai',     detail: 'OpenAI (GPT, gpt-oss...)' },
    { value: 'anthropic',  detail: 'Anthropic (Claude)' },
    { value: 'groq',       detail: 'Groq (Llama, etc.)' },
    { value: 'together',   detail: 'Together AI' },
    { value: 'mistral',    detail: 'Mistral AI' }
  ];
  let provider = cliArgs.provider;
  if (!provider) {
    console.log('  Fournisseurs disponibles :');
    console.log('  \x1b[90m── Locaux (aucune clé requise) ──\x1b[0m');
    providerEntries.slice(0, 3).forEach((e, i) => {
      console.log(`    \x1b[1m${i + 1}.\x1b[0m ${e.value.padEnd(11)} — ${e.detail}`);
    });
    console.log('  \x1b[90m── Cloud (clé API requise) ──\x1b[0m');
    providerEntries.slice(3).forEach((e, i) => {
      console.log(`    \x1b[1m${i + 4}.\x1b[0m ${e.value.padEnd(11)} — ${e.detail}`);
    });
    provider = await _askNumberedChoice('  Choix du fournisseur (numéro, Entrée = 1) :', providerEntries, 0);
  } else {
    console.log(`  \x1b[90mFournisseur passé en CLI : ${provider}\x1b[0m`);
  }
  const isLocal = LOCAL_PROVIDERS.includes(provider);
  console.log(`  \x1b[1;35m→ Fournisseur : ${provider}${isLocal ? ' (local)' : ' (cloud)'}\x1b[0m`);
  console.log('');

  // --- 2. Modèle ---
  _printSection('2. Modèle à évaluer');
  let model = cliArgs.model;
  let modelMeta = null;
  // Multi-sélection (demande 2026-11-11) : file d'élèves RunCode. Rempli quand
  // l'utilisateur tape "auto" ou des numéros séparés par des virgules. Chaque
  // entrée porte ses métadonnées (quantification/arch/éditeur/état) pour que le
  // runner évite un re-fetch par modèle.
  let multiModels = null;
  const normKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\.gguf$/i, '').split('@')[0];
  if (!model) {
    if (isLocal) {
      const models = provider === 'lmstudio'
        ? await fetchAllModelsFromLMStudio()
        : await _fetchOllamaModels();
      if (models.length > 0) {
        // Statut de test (compartiments night-batch) annoté sur chaque modèle :
        // ✓ TESTÉ (pct) · ⚡ RUNCODE · ~ PARTIEL · ✘ ÉCHEC · · À TESTER · ⊘ ISOLÉ.
        // Repli silencieux : si lms/carnets indisponibles, liste simple.
        const statusMap = provider === 'lmstudio' ? _statusMapForModels(models) : new Map();
        if (statusMap.size > 0) {
          console.log('  \x1b[90mStatuts : ✓ testé (score) · ⚡ RunCode (tremplin passé) · ~ partiel · ✘ échec · · à tester · ⊘ isolé. Tapez "list" pour le tableau détaillé.\x1b[0m');
        }
        // Registre des incompatibles (arch GGUF non supportée, ex: k2-horizon) :
        // badge rouge immédiat pour repérer en un clin d'œil ce qui ne passera
        // pas (demande 2026-11-11 : « on voit tout de suite les modèles pas
        // compatibles »). Marche même sans daemon (lecture fichier plat).
        const incompatRegistry = archWarning.loadIncompatible();
        const incompatFor = m => {
          const found = Object.entries(incompatRegistry).find(([k]) => normKey(k) === normKey(m.name));
          return found ? found[1] : null;
        };
        const blockedReason = (m, st) => {
          const rec = incompatFor(m);
          if (rec) return 'incompatible (arch ' + (rec.architecture || '?') + ')';
          if (st && st.badge && st.badge.label === 'INCOMPATIBLE') return 'incompatible';
          if (st && st.kind === 'nonllm') return 'non-LLM (embedding/OCR/rerank)';
          if (st && st.kind === 'isolated') return 'isolé manuellement';
          return null;
        };
        if (statusMap.size > 0 || Object.keys(incompatRegistry).length > 0) {
          console.log('  \x1b[90m⚠ INCOMPATIBLE = arch GGUF refusée par votre runtime LM Studio (mise à jour = re-testable).\x1b[0m');
        }
        console.log(`  \x1b[32m${models.length} modèle(s) ${provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} détecté(s) :\x1b[0m`);
        models.forEach((m, i) => {
          const badges = [];
          if (m.state === 'loaded') badges.push('chargé');
          if (m.quantization)      badges.push(m.quantization);
          if (m.arch)              badges.push(m.arch);
          if (m.publisher)         badges.push(m.publisher);
          const suffix = badges.length > 0 ? ` \x1b[90m(${badges.join(' · ')})\x1b[0m` : '';
          // Statut night-batch : glyphe coloré en tête de ligne (visible immédiatement).
          let statusTag = '';
          const st = statusMap.get(normKey(m.name)) || null;
          if (st) {
            const g = STATUS_GLYPHS[st.kind] || STATUS_GLYPHS.never;
            statusTag = `${g.color}${g.glyph}${C_RESET} `;
          }
          // Badge incompatible / non-LLM en rouge : ce qui ne passe pas est
          // lisible SANS lire les parenthèses grises.
          let blockTag = '';
          const reason = blockedReason(m, st);
          if (reason) blockTag = ` \x1b[1;31m⚠ ${reason.toUpperCase()}${C_RESET}`;
          console.log(`    \x1b[1m${i + 1}.\x1b[0m ${statusTag}${m.name}${suffix}${blockTag}`);
        });
        // Défaut : le premier modèle CHARGÉ (state === 'loaded'), sinon le 1er.
        const loadedIdx = models.findIndex(m => m.state === 'loaded');
        const defaultIdx = loadedIdx >= 0 ? loadedIdx : 0;
        if (loadedIdx >= 0) {
          console.log(`  \x1b[90m(« chargé » = modèle déjà en VRAM — Entrée = ${defaultIdx + 1})\x1b[0m`);
        } else {
          console.log('  \x1b[90m(Aucun modèle chargé — Entrée = 1)\x1b[0m');
        }
        if (examCode) {
          console.log('  \x1b[1;35mFile d\'élèves RunCode : tapez "auto" (TOUS les modèles passables) ou des numéros séparés par des virgules\x1b[0m');
          console.log('  \x1b[90m(ex: 1,2,3,4-6 · un modèle en échec ne bloque jamais la file — passage automatique au suivant).\x1b[0m');
        }
        const entries = models.map(m => ({ value: m.name }));
        // commands : "list"/"liste" est une COMMANDE, pas un nom de modèle —
        // la saisie est renvoyée brute pour être interceptée par la boucle
        // while ci-dessous. Sans elle, la saisie tombait sur le défaut.
        const modelChoices = { commands: ['list', 'liste'] };
        let selection = await _askModelSelection('  Choix du modèle (numéro(s), "auto", nom, "list" = tableau détaillé) :', entries, defaultIdx, modelChoices);
        // Commande "list" : affiche le tableau complet night-batch (--list-only)
        // avec compartiments (testés triés par score, puis échecs, à tester,
        // isolés). Recharge la liste LM Studio (un GGUF ajouté entre-temps est
        // détecté) puis relance le choix. Boucle tant que l'utilisateur tape "list".
        while (selection.type === 'commands') {
          const list = nightBatch.listLlmModels();
          if (list.ok && list.models.length > 0) {
            nightBatch.printModelsList(list.models, { interactive: false });
            const grouped = nightBatch.groupModelsByStatus(list);
            console.log(`  \x1b[90mCompartiments : ${grouped.groups.tested.length} testé(s) · ${grouped.groups.partial.length} partiel(s) · ${grouped.groups.failed.length} échec(s) · ${grouped.groups.never.length} à tester · ${grouped.groups.isolated.length} isolé(s).${C_RESET}`);
          } else {
            console.log(`  \x1b[33mlms indisponible (${(list && list.error) || 'daemon éteint ?'}) — tableau détaillé impossible.\x1b[0m`);
          }
          selection = await _askModelSelection('  Choix du modèle (numéro(s), "auto", nom, "list" = tableau détaillé) :', entries, defaultIdx, modelChoices);
        }
        while (selection.type === 'unknown') {
          console.log('  \x1b[33mSaisie non reconnue dans la sélection multiple — re-choix.\x1b[0m');
          selection = await _askModelSelection('  Choix du modèle (numéro(s), "auto", nom, "list" = tableau détaillé) :', entries, defaultIdx, modelChoices);
        }
        if (selection.type === 'auto') {
          // MODE AUTOMATIQUE : tous les modèles passables, dans l'ordre de la
          // liste. Les incompatibles / non-LLM / isolés sont écartés là, tout
          // de suite — pas de run voué à l'échec (demande 2026-11-11).
          multiModels = [];
          const excluded = [];
          for (const m of models) {
            const st = statusMap.get(normKey(m.name)) || null;
            const reason = blockedReason(m, st);
            if (reason) excluded.push({ m, reason });
            else multiModels.push({ name: m.name, quantization: m.quantization || null, arch: m.arch || null, publisher: m.publisher || null, state: m.state || null });
          }
          console.log(`  \x1b[1;35m→ Mode auto : ${multiModels.length} modèle(s) inscrit(s) dans la file.${C_RESET}`);
          if (excluded.length > 0) {
            for (const e of excluded) console.log(`  \x1b[90m   écarté : ${e.m.name} — ${e.reason}${C_RESET}`);
          }
          if (multiModels.length === 0) {
            // Tous écartés (ex: que des incompatibles) : repli honnête sur le
            // défaut plutôt qu'une file vide.
            console.log('  \x1b[33mAucun modèle passable en auto — repli sur le modèle par défaut (sélection manuelle possible).\x1b[0m');
            model = entries[defaultIdx] ? entries[defaultIdx].value : null;
            modelMeta = model ? (models.find(m => m.name === model) || null) : null;
            multiModels = null;
          }
        } else if (selection.type === 'multi') {
          const pickedMeta = selection.indexes.map(i => models[i]).filter(Boolean);
          for (const m of pickedMeta) {
            const st = statusMap.get(normKey(m.name)) || null;
            const reason = blockedReason(m, st);
            if (reason) console.log(`  \x1b[33m⚠ ${m.name} : ${reason} — il reste dans la file mais l'échec est attendu (runtime à jour = re-testable).${C_RESET}`);
          }
          multiModels = pickedMeta.map(m => ({ name: m.name, quantization: m.quantization || null, arch: m.arch || null, publisher: m.publisher || null, state: m.state || null }));
        }
        // Sélection unique (historique) OU multi réduite à 1 : flux simple.
        if (multiModels && multiModels.length === 1) {
          model = multiModels[0].name;
          modelMeta = models.find(m => m.name === model) || null;
          multiModels = null;
        } else if (!multiModels) {
          model = selection.values[0];
          modelMeta = models.find(m => m.name === model) || null;
        }
        if (examCode && multiModels) {
          logger.info(`Questionnaire RunCode : file de ${multiModels.length} modèle(s) — ${multiModels.map(m => m.name).join(', ')}`);
        }
        if (!examCode && multiModels && multiModels.length > 1) {
          // La grande école interactive ne boucle pas : un seul modèle par
          // process (night-batch.js est le mode batch de la grande école).
          console.log('  \x1b[33mMulti-sélection : le benchmark classique ne passe qu\'UN modèle par run — seul le premier sera joué.\x1b[0m');
          console.log('  \x1b[90mPour une file : node runner.js --exam-code (RunCode) ou node night-batch.js (grande école).\x1b[0m');
          model = multiModels[0].name;
          modelMeta = models.find(m => m.name === model) || null;
          multiModels = null;
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

  // --- 2b. Quantification ---
  // La quantification (Q4_K_M, Q5_K_S, Q8_0...) n'est JAMAIS dans le nom du modèle
  // pour les serveurs locaux, et /v1/models (OpenAI-compat) ne l'expose pas non
  // plus. On la récupère automatiquement via /api/v0/models (LM Studio) ; pour
  // Ollama / custom, on demande la saisie manuelle (l'utilisateur peut lire la
  // valeur dans l'UI de son serveur). La quantification est importante car elle
  // impacte fortement les performances : un Q4_K_M n'a pas le même comportement
  // qu'un Q8_0, et deux runs du même modèle avec deux quantifications différentes
  // ne sont pas comparables.
  let quantization = cliArgs.quantization || null;
  if (multiModels) {
    // File d'élèves : la quantification de CHAQUE modèle vient des métadonnées
    // de la liste (étape 2) — un prompt interactif par modèle serait une
    // re-saisie fastidieuse et sans valeur ajoutée.
    console.log('  \x1b[1;33m2b. Quantification\x1b[0m');
    console.log('  \x1b[90mFile de plusieurs modèles — quantification lue automatiquement dans les métadonnées de chacun.\x1b[0m');
    console.log('');
  } else if (quantization) {
    console.log('  \x1b[1;33m2b. Quantification\x1b[0m');
    console.log(`  \x1b[90mQuantification passée en CLI : ${quantization}\x1b[0m`);
    console.log('');
  } else if (provider === 'lmstudio') {
    console.log('  \x1b[1;33m2b. Quantification\x1b[0m');
    // Si le modèle a été choisi dans la liste LM Studio, on a déjà ses métadonnées
    // (quantif/arch/éditeur/état) — on évite un re-fetch de /api/v0/models.
    if (modelMeta && (modelMeta.quantization || modelMeta.arch || modelMeta.publisher)) {
      if (modelMeta.quantization) {
        quantization = modelMeta.quantization;
        console.log(`  \x1b[32mQuantification (LM Studio /api/v0/models) : ${quantization}\x1b[0m`);
      } else {
        console.log('  \x1b[33mQuantification non exposée par LM Studio pour ce modèle.\x1b[0m');
      }
      if (modelMeta.arch)      console.log(`  \x1b[90m  Architecture : ${modelMeta.arch}\x1b[0m`);
      if (modelMeta.publisher) console.log(`  \x1b[90m  Éditeur      : ${modelMeta.publisher}\x1b[0m`);
      if (modelMeta.state)     console.log(`  \x1b[90m  État         : ${modelMeta.state}\x1b[0m`);
      if (!quantization) {
        const q = await _askFreeText('  Saisissez la quantification (ex: Q4_K_M, Q5_K_S, Q8_0) — laissez vide si inconnue :', { allowEmpty: true });
        if (q) quantization = q;
      }
    } else {
      const meta = await fetchModelMetadataFromLMStudio(model);
      if (meta && meta.quantization) {
        quantization = meta.quantization;
        console.log(`  \x1b[32mQuantification détectée automatiquement (LM Studio /api/v0/models) : ${quantization}\x1b[0m`);
        if (meta.arch)       console.log(`  \x1b[90m  Architecture : ${meta.arch}\x1b[0m`);
        if (meta.publisher)  console.log(`  \x1b[90m  Éditeur      : ${meta.publisher}\x1b[0m`);
        if (meta.state)      console.log(`  \x1b[90m  État         : ${meta.state}\x1b[0m`);
      } else {
        console.log('  \x1b[33mQuantification non détectable automatiquement (LM Studio injoignable ou endpoint /api/v0 absent).\x1b[0m');
        const q = await _askFreeText('  Saisissez la quantification (ex: Q4_K_M, Q5_K_S, Q8_0) — laissez vide si inconnue :', { allowEmpty: true });
        if (q) quantization = q;
      }
    }
    console.log('');
  } else if (provider === 'ollama' || provider === 'custom') {
    console.log('  \x1b[1;33m2b. Quantification\x1b[0m');
    console.log('  \x1b[90mLa quantification n\'est pas lisible dans le nom du modèle ni via l\'API OpenAI-compat.\x1b[0m');
    console.log('  \x1b[90mVous pouvez la lire dans l\'interface de votre serveur (LM Studio : panneau de droite ; Ollama : nom du fichier).\x1b[0m');
    const q = await _askFreeText('  Saisissez la quantification (ex: Q4_K_M, Q5_K_S, Q8_0) — laissez vide si inconnue :', { allowEmpty: true });
    if (q) quantization = q;
    console.log('');
  }

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
  // profileArg conservé pour la compatibilité des habitudes ; en file il reste
  // null (le runner déduit le parcours par modèle).
  let profileChoice = cliArgs.profileArgExplicit || null;
  if (multiModels) {
    // File d'élèves : le profil (donc le parcours RunCode) est déduit du NOM de
    // chaque modèle (12b → College-Lycee, 2.6b → Primaire). Un profil unique
    // forcerait le même parcours à un 2B et à un 12B — faux.
    console.log('  \x1b[1;33m5. Profil d\'évaluation\x1b[0m \x1b[90m— déduit du nom de chaque modèle de la file (2.6b → Primaire, 12b → College-Lycee...).\x1b[0m');
    console.log('');
  } else {
    _printSection('5. Profil d\'évaluation');
    const profileKeys = Object.keys(PROFILES);
    console.log('  Profils :');
    profileKeys.forEach((key, i) => {
      console.log(`    \x1b[1m${i + 1}.\x1b[0m ${key.padEnd(10)} ${PROFILES[key].label}`);
    });
    let profileArg = cliArgs.profileArgExplicit;
    if (!profileArg) {
      // Default heuristic : local provider → STANDARD, cloud → FRONTIER.
      const defaultProfile = isLocal ? 'STANDARD' : 'FRONTIER';
      const defaultIdx = Math.max(0, profileKeys.indexOf(defaultProfile));
      const entries = profileKeys.map(k => ({ value: k }));
      profileArg = await _askNumberedChoice('  Choix du profil (numéro ou nom, Entrée = défaut) :', entries, defaultIdx);
    } else {
      console.log(`  \x1b[90mProfil passé en CLI : ${profileArg}\x1b[0m`);
    }
    console.log(`  \x1b[1;35m→ Profil : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}\x1b[0m`);
    console.log('');
    profileChoice = profileArg;
  }

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
  console.log("  \x1b[90met démontre la vraie cause racine. Menu interactif : choisissez CHEZ QUI il tourne.\x1b[0m");

  // --no-teacher force l'auto-analyse classique sans demander.
  const teacherConfig = cliArgs.teacherDisabled
    ? { enabled: false }
    : await _configureTeacher(cliArgs);
  if (cliArgs.teacherDisabled) {
    console.log('  \x1b[90mProfesseur : auto-analyse classique (--no-teacher).\x1b[0m');
  }
  console.log('');

  // --- 8/9 Grande école OU 8/9 RunCode ---
  // En RunCode (--exam-code), les étapes grande école (cible tier, FLASH) sont
  // SANS EFFET (l'examen court-circuite le benchmark) : elles cèdent la place à
  // une véritable étape RunCode — Turbo (parcours complet) ou ÉCLAIR (scan
  // spécialité accéléré). Demande 2026-11-11 : « le menu du RunCode ne propose
  // rien » — désormais il propose les VRAIES options du mode.
  let tierArg = 'all';
  let flashMode = cliArgs.flash === true;
  let eclairMode = false;
  if (examCode) {
    _printSection('8. Mode de RunCode');
    console.log('  \x1b[90mT = Turbo : parcours complet de classes (2 exercices par classe, ~10-20 min).\x1b[0m');
    console.log('  \x1b[90mE = ÉCLAIR : scan de spécialité accéléré — 1 exercice par LANGAGE, classe la plus simple (20 appels courts).\x1b[0m');
    const modeRaw = await _askFreeText('  Mode RunCode (Entrée = Turbo, T/E) :', { allowEmpty: true });
    const mv = (modeRaw || '').trim().toLowerCase();
    if (mv === 'e' || mv === 'eclair') {
      eclairMode = true;
      console.log('  \x1b[1;35m⚡ → Mode ÉCLAIR : scan de spécialité accéléré.\x1b[0m');
      logger.info('Questionnaire RunCode : mode ÉCLAIR choisi (interactif).');
    } else {
      console.log('  \x1b[90m→ Mode Turbo (parcours complet).\x1b[0m');
    }
    console.log('');
  } else {
    // --- 8. Cible (classe / tier) ---
    // En mode interactif, on demande explicitement quelle classe cibler. Par
    // défaut on reste sur "all" (toutes les classes obligatoires + optionnelles
    // du profil). Si l'utilisateur tape un numéro de tier, on restreint le run à
    // cette seule classe. Cela évite le piège d'un argument positionnel résiduel
    // (ex: "node runner.js 0") qui silencieusement ne lance qu'une seule classe
    // et fait croire à un 100% trompeur.
    _printSection('8. Cible (classe / tier)');
    console.log("  \x1b[90m« all » = toutes les classes du profil (recommandé). Sinon un numéro de tier (0, 1, 2…) pour une seule classe.\x1b[0m");
    const tierRaw = await _askFreeText('  Cible (Entrée = all) :', { allowEmpty: true });
    if (tierRaw) {
      const v = tierRaw.trim().toLowerCase();
      if (v === 'all' || v === '*') {
        tierArg = 'all';
      } else {
        const n = parseInt(v, 10);
        if (Number.isInteger(n) && n >= 0) {
          tierArg = String(n);
        } else {
          console.log(`  \x1b[33mValeur '${v}' non reconnue — fallback sur « all ».\x1b[0m`);
          tierArg = 'all';
        }
      }
    }
    console.log(`  \x1b[1;35m→ Cible : ${tierArg}\x1b[0m`);
    console.log('');

    // --- 9. MODE FLASH (tâche 2026-09-16c) : examen accéléré ---
    // Proposé quand la cible est « all » (le mode FLASH est un mode de grande
    // école, pas un mode de classe unique). L'utilisateur à PEU DE RAM choisit
    // FLASH : 1 exercice par classe au lieu de 10-15 → l'examen dure ~10x
    // moins longtemps (la VRAM/RAM est sollicitée beaucoup moins longtemps).
    // Tirage orienté par le tremplin RunCode si disponible.
    if (tierArg === 'all') {
      _printSection('9. Mode d\'examen');
      console.log('  \x1b[90mC = Classique : examen complet (10-15 exercices par classe) — mesure de référence.\x1b[0m');
      console.log('  \x1b[90mF = FLASH ⚡ : examen accéléré (1 exercice par classe, tiré des compétences RunCode).\x1b[0m');
      console.log('  \x1b[90m    Pensé pour les machines à PEU DE RAM : l\'examen dure ~10x moins longtemps.\x1b[0m');
      console.log('  \x1b[90m    Score au carnet (école Flash-<École>) mais NON compté dans le classement.\x1b[0m');
      const flashRaw = await _askFreeText('  Mode (Entrée = Classique, C/F) :', { allowEmpty: true });
      const fv = (flashRaw || '').trim().toLowerCase();
      if (fv === 'f' || fv === 'flash') {
        flashMode = true;
        console.log('  \x1b[1;35m⚡ → Mode FLASH activé : 1 exercice par classe.\x1b[0m');
        logger.info('Questionnaire : mode FLASH choisi par l\'utilisateur (interactif).');
      } else {
        console.log('  \x1b[90m→ Mode Classique (examen complet).\x1b[0m');
      }
      console.log('');
    }
    if (flashMode && tierArg !== 'all') {
      // FLASH n'a de sens qu'en grande école complète (les tiers individuels
      // restent tels quels). Cohérence CLI : on désactive silencieusement + log.
      console.log('  \x1b[33m⚡ Mode FLASH ignoré (cible = classe unique — FLASH ne s\'applique qu\'à « all »).\x1b[0m');
      logger.info('Questionnaire : FLASH demandé mais cible != all — désactivé.');
      flashMode = false;
    }
  }

  // --- Récapitulatif ---
  console.log('  \x1b[1;36m━━━━━━━━━━━━━ RÉCAPITULATIF ━━━━━━━━━━━━━\x1b[0m');
  if (multiModels) {
    console.log(`  File d'élèves : ${multiModels.length} modèle(s)`);
    multiModels.forEach((m, i) => console.log(`    \x1b[1m${i + 1}.\x1b[0m ${m.name}${m.quantization ? ` \x1b[90m(${m.quantization})\x1b[0m` : ''}`));
    console.log('  \x1b[90mUn modèle en échec ne bloque pas la file — passage automatique au suivant.\x1b[0m');
  }
  console.log(`  Fournisseur   : ${provider}`);
  console.log(`  Modèle        : ${model || '(non précisé)'}`);
  console.log(`  Quantification: ${quantization || '\x1b[90m— (inconnue)\x1b[0m'}`);
  console.log(`  Clé API élève : ${apiKey ? secrets.maskedForDisplay(apiKey) : '\x1b[90m—\x1b[0m'}`);
  console.log(`  Endpoint      : ${endpoint || '\x1b[90m(par défaut)\x1b[0m'}`);
  console.log(`  Profil        : ${profileChoice || '\x1b[90mauto (par modèle)\x1b[0m'}`);
  console.log(`  Contexte max  : ${contextLimitTokens} tokens`);
  if (!examCode) {
    console.log(`  Cible         : ${tierArg}`);
    console.log(`  Mode d'examen : ${flashMode ? '\x1b[1;35m⚡ FLASH (accéléré)\x1b[0m' : 'Classique (complet)'}`);
  } else {
    console.log(`  Mode RunCode  : ${eclairMode ? '\x1b[1;35m⚡ ÉCLAIR (scan spécialité)\x1b[0m' : 'Turbo (parcours complet)'}`);
  }
  const profLabel = teacherConfig.enabled
    ? `${teacherConfig.provider || 'openrouter'}${teacherConfig.model && teacherConfig.provider !== 'openrouter' ? ` (${teacherConfig.model})` : ' (Free Router)'}`
    : 'auto-analyse classique';
  console.log(`  Professeur    : ${profLabel}`);
  console.log('');

  return {
    provider,
    model,
    apiKey,
    endpoint,
    profileArg: profileChoice,
    contextLimitTokens,
    teacherConfig,
    quantization,
    tierArg,
    flash: flashMode,
    isInteractive: true,
    // File d'élèves RunCode (null = run à modèle unique, historique).
    models: multiModels ? multiModels.slice() : null,
    eclair: eclairMode,
    examCodeMode: examCode
  };
}

module.exports = {
  runStartupQuestionnaire,
  _parseMultiSelection,
  LOCAL_PROVIDERS,
  CLOUD_PROVIDERS_ORDERED,
  TEACHER_PROVIDERS_MENU,
  askTeacherSelection
};