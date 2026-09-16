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

// Constante couleur (reset ANSI) — évite la répétition des escapes.
const C_RESET = '\x1b[0m';

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
  if (!model) {
    if (isLocal) {
      const models = provider === 'lmstudio'
        ? await fetchAllModelsFromLMStudio()
        : await _fetchOllamaModels();
      if (models.length > 0) {
        // Statut de test (compartiments night-batch) annoté sur chaque modèle :
        // ✓ TESTÉ (pct) · ~ PARTIEL · ✘ ÉCHEC · · À TESTER · ⊘ ISOLÉ.
        // Repli silencieux : si lms/carnets indisponibles, liste simple.
        const statusMap = provider === 'lmstudio' ? _statusMapForModels(models) : new Map();
        if (statusMap.size > 0) {
          console.log('  \x1b[90mStatuts : ✓ testé (score) · ⚡ RunCode (tremplin passé) · ~ partiel · ✘ échec · · à tester · ⊘ isolé. Tapez "list" pour le tableau détaillé.\x1b[0m');
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
          if (statusMap.size > 0) {
            const st = statusMap.get(String(m.name || '').toLowerCase().replace(/\s+/g, ' ').replace(/\.gguf$/i, '').split('@')[0]);
            if (st) {
              const g = STATUS_GLYPHS[st.kind] || STATUS_GLYPHS.never;
              statusTag = `${g.color}${g.glyph}${C_RESET} `;
            }
          }
          console.log(`    \x1b[1m${i + 1}.\x1b[0m ${statusTag}${m.name}${suffix}`);
        });
        // Défaut : le premier modèle CHARGÉ (state === 'loaded'), sinon le 1er.
        const loadedIdx = models.findIndex(m => m.state === 'loaded');
        const defaultIdx = loadedIdx >= 0 ? loadedIdx : 0;
        if (loadedIdx >= 0) {
          console.log(`  \x1b[90m(« chargé » = modèle déjà en VRAM — Entrée = ${defaultIdx + 1})\x1b[0m`);
        } else {
          console.log('  \x1b[90m(Aucun modèle chargé — Entrée = 1)\x1b[0m');
        }
        const entries = models.map(m => ({ value: m.name }));
        // commands : "list"/"liste" est une COMMANDE, pas un nom de modèle —
        // la saisie est renvoyée brute pour être interceptée par la boucle
        // while ci-dessous. Sans elle, la saisie tombait sur le défaut.
        const modelChoices = { commands: ['list', 'liste'] };
        let picked = await _askNumberedChoice('  Choix du modèle (numéro ou nom, "list" = tableau détaillé) :', entries, defaultIdx, modelChoices);
        // Commande "list" : affiche le tableau complet night-batch (--list-only)
        // avec compartiments (testés triés par score, puis échecs, à tester,
        // isolés). Recharge la liste LM Studio (un GGUF ajouté entre-temps est
        // détecté) puis relance le choix. Boucle tant que l'utilisateur tape "list".
        while (picked === 'list' || picked === 'liste') {
          const list = nightBatch.listLlmModels();
          if (list.ok && list.models.length > 0) {
            nightBatch.printModelsList(list.models, { interactive: false });
            const grouped = nightBatch.groupModelsByStatus(list);
            console.log(`  \x1b[90mCompartiments : ${grouped.groups.tested.length} testé(s) · ${grouped.groups.partial.length} partiel(s) · ${grouped.groups.failed.length} échec(s) · ${grouped.groups.never.length} à tester · ${grouped.groups.isolated.length} isolé(s).${C_RESET}`);
          } else {
            console.log(`  \x1b[33mlms indisponible (${(list && list.error) || 'daemon éteint ?'}) — tableau détaillé impossible.\x1b[0m`);
          }
          picked = await _askNumberedChoice('  Choix du modèle (numéro ou nom, "list" = tableau détaillé) :', entries, defaultIdx, modelChoices);
        }
        model = picked;
        modelMeta = models.find(m => m.name === model) || null;
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
  if (quantization) {
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
  let tierArg = 'all';
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
  let flashMode = cliArgs.flash === true;
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

  // --- Récapitulatif ---
  console.log('  \x1b[1;36m━━━━━━━━━━━━━ RÉCAPITULATIF ━━━━━━━━━━━━━\x1b[0m');
  console.log(`  Fournisseur   : ${provider}`);
  console.log(`  Modèle        : ${model || '(non précisé)'}`);
  console.log(`  Quantification: ${quantization || '\x1b[90m— (inconnue)\x1b[0m'}`);
  console.log(`  Clé API élève : ${apiKey ? secrets.maskedForDisplay(apiKey) : '\x1b[90m—\x1b[0m'}`);
  console.log(`  Endpoint      : ${endpoint || '\x1b[90m(par défaut)\x1b[0m'}`);
  console.log(`  Profil        : ${profileArg}`);
  console.log(`  Contexte max  : ${contextLimitTokens} tokens`);
  console.log(`  Cible         : ${tierArg}`);
  console.log(`  Mode d'examen : ${flashMode ? '\x1b[1;35m⚡ FLASH (accéléré)\x1b[0m' : 'Classique (complet)'}`);
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
    quantization,
    tierArg,
    flash: flashMode,
    isInteractive: true
  };
}

module.exports = {
  runStartupQuestionnaire,
  LOCAL_PROVIDERS,
  CLOUD_PROVIDERS_ORDERED
};