const logger = require('./logger');
const { API_TIMEOUT_MS } = require('./config');
const { BenchgoError } = require('./cli-help');
const benchMetrics = require('./benchmark-metrics');

// Fournisseurs cloud supportés
// openaiCompat: true  → format OpenAI /v1/chat/completions avec streaming SSE standard
// openaiCompat: false → format Anthropic Messages API avec streaming SSE propre
// requiresAuth: false → clé API non requise (serveurs locaux)
// optionalAuth: true  → clé API recommandée mais tolérée absente (accès anonyme
//                       limité). Ex: Kilo Gateway (modèles :free anonymes, 200 req/h/IP).
const CLOUD_PROVIDERS = {
  openai:     { url: 'https://api.openai.com/v1/chat/completions',      envKey: 'OPENAI_API_KEY',      openaiCompat: true,  requiresAuth: true  },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY',        openaiCompat: true,  requiresAuth: true  },
  together:   { url: 'https://api.together.xyz/v1/chat/completions',    envKey: 'TOGETHER_API_KEY',    openaiCompat: true,  requiresAuth: true  },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',   envKey: 'OPENROUTER_API_KEY',  openaiCompat: true,  requiresAuth: true  },
  kilo:       { url: 'https://api.kilo.ai/api/gateway/chat/completions', envKey: 'KILO_API_KEY',        openaiCompat: true,  requiresAuth: true, optionalAuth: true },
  mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',      envKey: 'MISTRAL_API_KEY',     openaiCompat: true,  requiresAuth: true  },
  anthropic:  { url: 'https://api.anthropic.com/v1/messages',           envKey: 'ANTHROPIC_API_KEY',   openaiCompat: false, requiresAuth: true  },
  deepseek:   { url: 'https://api.deepseek.com/v1/chat/completions',    envKey: 'DEEPSEEK_API_KEY',    openaiCompat: true,  requiresAuth: true  },
  cohere:     { url: 'https://api.cohere.ai/v1/chat/completions',       envKey: 'COHERE_API_KEY',      openaiCompat: true,  requiresAuth: true  },
  // Serveurs locaux OpenAI-compatibles — clé API non requise
  ollama:     { url: 'http://localhost:11434/v1/chat/completions',       envKey: null,                  openaiCompat: true,  requiresAuth: false },
  lmstudio:   { url: 'http://localhost:1234/v1/chat/completions',        envKey: null,                  openaiCompat: true,  requiresAuth: false },
  custom:     { url: null, /* override via --endpoint= */               envKey: null,                  openaiCompat: true,  requiresAuth: false },
};

// --- Garde-fous anti-boucle / anti-blocage du streaming cloud (2026-09-20) ---
// Constat (logs benchgo_2026-09-20T21-49 / 22-00, deepseek-v4.1-flash via
// Ollama cloud) : un modèle de raisonnement peut streamer sa délibération EN
// BOUCLE sans fin (mêmes réflexions qui reviennent cycliquement) — 2h de stream
// actif sans jamais produire de réponse exploitable. Le client local
// (lm-studio-client.js) a un timer d'inactivité, le client cloud n'en avait
// AUCUN : seul le timeout global (API_TIMEOUT_MS, 25 min) bornait chaque appel,
// et un tier de rattrapage enchaîne plusieurs appels → des heures de « sans fin ».
// Trois garde-fous :
//   1. Inactivité : aucun chunk pendant CLOUD_STREAM_IDLE_TIMEOUT_MS → coupure.
//      Valeur alignée sur les autres timeouts du projet (ping 90s, health check
//      90s) : les modèles thinking lents produisent leur 1er chunk en 40-60s.
//   2. Plafond de raisonnement : au-delà de CLOUD_REASONING_MAX_CHARS, c'est
//      une boucle — coupure, contenu partiel conservé (l'évaluation échouera
//      proprement, le run avance au lieu de geler).
//   3. Plafond de réponse : idem pour un content qui ne finit jamais.
// Le timeout global (25 min) reste le filet ultime pour tout le reste.
const CLOUD_STREAM_IDLE_TIMEOUT_MS = 90000;
const CLOUD_REASONING_MAX_CHARS = 60000;
const CLOUD_CONTENT_MAX_CHARS = 120000;

// Normalisation d'endpoint (tâche 2026-09-29). Retourne une URL complète de
// chat/completions :
//   http(s)://host/v1                      → http(s)://host/v1/chat/completions
//   http(s)://host/v1/chat                 → http(s)://host/v1/chat/completions
//   http(s)://host/api/gateway             → .../api/gateway/chat/completions (Kilo)
//   toute URL finissant par /chat/completions ou /messages → inchangée
// Cas déclencheur : base URL "https://ollama.com/v1" collée verbatim depuis la
// doc Ollama Cloud → POST sur /v1 → HTTP 405 "Method Not Allowed" (logs
// benchgo_2026-09-29T13-00 / 13-02). La détection repose sur l'ABSENCE de
// segment "chat/completions" ou "messages" en fin de chemin.
function normalizeCompletionsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return rawUrl;
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (/\/(chat\/completions|messages)$/i.test(url)) return url;
  if (/\/chat$/i.test(url)) return `${url}/completions`;
  return `${url}/chat/completions`;
}

function getSystemPrompt(difficulty) {
  const welcome =
    "Vous etes un modele de langage candidat a un examen serieux organise par BenchGo V3. " +
    "Bienvenue dans cette grande ecole. Vous allez integrer une institution d'excellence ou chaque epreuve compte. " +
    "Le programme se compose de plusieurs ecoles (Primaire, College-Lycee, Universite, These, Post-Doc), chacune " +
    "decoupee en classes. Chaque classe contient des exercices notes : chaque exercice reussi vous rapporte des points, " +
    "chaque echec vous en fait perdre. Votre sante globale (un buffer de points de vie) diminue a chaque erreur et peut " +
    "vous eliminer si elle descend trop bas. Donnez-vous a 100% : ces exercices sont exigeants et leur resolution " +
    "rigoureuse determine votre integration au classement final mondial des modeles de langage (LLM). " +
    "Vous devez ecrire du code JavaScript complet, executable et correct - pas de pseudo-code, pas de placeholders. " +
    "Prenez chaque exercice au serieux, lisez attentivement l'enonce et verifiez votre solution.";
  if (difficulty === 'EXPERT' || difficulty === 'HARD' || difficulty === 'FRONTIER') {
    return welcome + " Vous agissez ici en tant qu'ingenieur logiciel principal. Repondez exclusivement en Markdown, avec les conventions exactes demandees et des blocs de code.";
  }
  return welcome + " Vous agissez en tant que developpeur competent. Repondez en Markdown de maniere structuree, avec des titres et des blocs de code.";
}

async function streamOpenAICompatResponse(response, spinner, controller = null) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;
  let sseBuffer = '';
  // Suivi des chunks reçus (pour diagnostic si réponse vide) et des erreurs
  // SSE noyées dans le stream (OpenRouter envoie parfois l'erreur dans un
  // chunk data: {"error":...} au lieu d'un HTTP 4xx/5xx).
  let rawChunkCount = 0;
  let lastFinishReason = null;
  let streamErrors = [];

  let streamingStarted = false;
  // Flag de coupure : les plafonds anti-boucle (raisonnement/réponse) doivent
  // sortir de la boucle while EXTERNE — un simple break ne casse que le for
  // interne (bug constaté au test de simulation : stream infini jamais coupé).
  let stopStreaming = false;

  // --- Timer d'inactivité (garde-fou anti-blocage) ---
  // Un modèle thinking qui streame activement en boucle ne déclenche PAS le
  // timeout global (il produit des chunks en continu). Le garde-fou ci-dessous
  // ne cible que le silence : aucun chunk pendant CLOUD_STREAM_IDLE_TIMEOUT_MS
  // → coupure + erreur d'inactivité (miroir de lm-studio-client.js côté local).
  //
  // IMPORTANT (testé 2026-09-20, Node 26/undici récent) : sur un flux
  // silencieux, reader.cancel() ET controller.abort() ne rejettent PAS un
  // reader.read() en attente — le process reste figé dans le await. La seule
  // stratégie fiable est une COURSE : read() contre un timer. Si le timer
  // gagne, on cancel le reader (nettoyage) et on lève l'erreur idle. La course
  // est re-créée à chaque itération (reset du délai après chaque chunk reçu).
  const makeIdleError = () => {
    const e = new Error('Réponse vide — aucun chunk reçu pendant ' + (CLOUD_STREAM_IDLE_TIMEOUT_MS / 1000) + 's (inactivité du modèle cloud)');
    e.isEmptyResponse = true;
    e.isIdleTimeout = true;
    return e;
  };
  const readWithIdleGuard = async () => {
    let idleFired = false;
    let idleTimer = null;
    const idlePromise = new Promise((resolve) => {
      idleTimer = setTimeout(() => { idleFired = true; resolve(null); }, CLOUD_STREAM_IDLE_TIMEOUT_MS);
    });
    try {
      const chunk = await Promise.race([reader.read(), idlePromise]);
      if (idleFired) {
        // Inactivité : coupe le flux (nettoyage socket) et lève l'erreur idle.
        try { reader.cancel(); } catch (_) {}
        if (controller) { try { controller.abort(); } catch (_) {} }
        throw makeIdleError();
      }
      return chunk;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  // --- Gestion du bug undici Node.js 24.x ---
  // Pendant le streaming SSE, undici peut fermer la socket (idle timeout)
  // et lancer une erreur "socket idle timeout" qui n'est PAS propagée dans
  // la chaîne Promise (uncaughtException). Le handler global de runner.js
  // l'intercepte et continue, MAIS le reader.read() rejette quand même.
  // On capture cette erreur ici pour retourner le contenu PARTIEL déjà reçu
  // plutôt que de perdre toute la réponse. C'est mieux d'avoir une réponse
  // incomplète (que le moteur peut évaluer) que de crasher le run entier.
  try {
    while (true) {
      if (stopStreaming) break;
      const { done, value } = await readWithIdleGuard();
      if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') continue;
      rawChunkCount++;
      try {
        const chunk = JSON.parse(payload);

        // --- Détection des erreurs SSE noyées dans le stream ---
        // OpenRouter peut renvoyer HTTP 200 puis envoyer un chunk d'erreur
        // (rate limit upstream, modèle indisponible, etc.) au lieu d'un
        // HTTP 4xx. Sans cette détection, le runner voit une "réponse OK"
        // avec 0 contenu et continue comme si tout allait bien.
        if (chunk.error) {
          const errMsg = chunk.error.message || chunk.error.error || JSON.stringify(chunk.error);
          streamErrors.push(errMsg);
          logger.warn('Cloud SSE : chunk d erreur reçu — ' + String(errMsg).substring(0, 300));
          continue;
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        // Modèles de raisonnement : OpenRouter expose le raisonnement via
        // delta.reasoning (majorité des :free thinking) OU delta.reasoning_content
        // (DeepSeek-R1, GLM...). On collecte les DEUX — un seul est présent par
        // chunk selon le provider, l'autre est undefined.
        const reasoning = chunk.choices?.[0]?.delta?.reasoning
          || chunk.choices?.[0]?.delta?.reasoning_content
          || null;
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason) lastFinishReason = finishReason;

        if (!streamingStarted && (delta || reasoning)) {
          spinner.beginStreaming();
          streamingStarted = true;
        }

        if (delta) {
          fullContent += delta;
          tokenCount++;
          spinner.updateTokens(tokenCount, fullContent.length);
          spinner.appendStreamChunk(delta, 'content');
        }
        // Modèles de raisonnement (DeepSeek-R1, Qwen3, GLM...) en cloud
        if (reasoning) {
          reasoningContent += reasoning;
          tokenCount++;
          spinner.updateTokens(tokenCount, reasoningContent.length);
          spinner.appendStreamChunk(reasoning, 'reasoning');
          // Plafond anti-boucle : un raisonnement qui dépasse le plafond est
          // une délibération sans fin (boucle). On coupe le stream : le contenu
          // partiel sera retourné (ou remplacera une réponse vide), l'évaluation
          // échouera proprement et le run avancera au lieu de geler des heures.
          if (reasoningContent.length > CLOUD_REASONING_MAX_CHARS) {
            logger.warn('Cloud streaming : plafond de raisonnement atteint (' + reasoningContent.length + ' chars > ' + CLOUD_REASONING_MAX_CHARS + ') — boucle de délibération probable, coupure du stream.');
            stopStreaming = true;
            break;
          }
        }
        // Plafond de réponse : un content qui ne finit jamais (répétitions).
        if (fullContent.length > CLOUD_CONTENT_MAX_CHARS) {
          logger.warn('Cloud streaming : plafond de réponse atteint (' + fullContent.length + ' chars > ' + CLOUD_CONTENT_MAX_CHARS + ') — coupure du stream.');
          stopStreaming = true;
          break;
        }
      } catch (_) {}
    }
  }
  } catch (streamErr) {
    // Bug undici Node.js 24.x : "socket idle timeout" ou "Cannot assign to
    // read only property 'name'". On a déjà intercepté l'uncaughtException
    // au niveau global (runner.js), mais le reader.read() rejette aussi.
    // On garde le contenu PARTIEL déjà reçu (mieux que rien pour l'évaluation).
    // Inactivité : readWithIdleGuard lève NOTRE erreur (flags
    // isIdleTimeout/isEmptyResponse) — on la propage telle quelle.
    if (streamErr && streamErr.isIdleTimeout) throw streamErr;
    if (fullContent.trim() || reasoningContent.trim()) {
      logger.warn('Cloud streaming : déconnexion socket interceptée (bug undici 24.x) — contenu partiel conservé (' + (fullContent.length + reasoningContent.length) + ' chars).');
    } else {
      // Aucun contenu reçu avant la déconnexion : on propage pour retry.
      throw streamErr;
    }
  }

  if (streamingStarted) spinner.endStreaming();

  if (!fullContent.trim() && reasoningContent.trim()) {
    fullContent = reasoningContent;
  }

  // --- Détection des réponses vides (tâche 2026-08-26) ---
  // Le modèle free renvoie HTTP 200 avec N chunks valides mais chaque chunk a
  // delta.content = "" (vide). Le stream se termine sans erreur, mais il n'y a
  // AUCUN contenu exploitable. Sans cette détection, le runner considère la
  // réponse comme un succès (statut=OK, 0 tokens) et continue → toutes les
  // tâches bypassées, rapport 0/0.
  if (!fullContent.trim() && !reasoningContent.trim()) {
    // Cas inactivité : la course a détecté le silence sans aucun contenu.
    if (rawChunkCount === 0) {
      throw makeIdleError();
    }
    if (streamErrors.length > 0) {
      // Erreur SSE explicite dans le stream (rate limit, modèle indisponible...)
      const msg = streamErrors.join(' | ');
      const err = new Error('Réponse vide — erreur SSE : ' + msg.substring(0, 500));
      err.isEmptyResponse = true;
      err.streamErrors = streamErrors;
      throw err;
    }
    if (rawChunkCount > 0) {
      // Chunks reçus mais tous vides : modèle probablement rate-limité upstream
      // ou incapable de générer (modèle free surchargé). On lève une erreur pour
      // que le runner puisse retry ou arrêter net au lieu de produire un 0/0.
      logger.warn('Cloud streaming : ' + rawChunkCount + ' chunks reçus mais contenu vide (0 chars). finish_reason=' + (lastFinishReason || 'null') + '. Modèle probablement rate-limité ou indisponible upstream.');
      const err = new Error('Réponse vide — ' + rawChunkCount + ' chunks SSE reçus mais 0 contenu généré (modèle probablement rate-limité upstream sur OpenRouter Free)');
      err.isEmptyResponse = true;
      err.rawChunkCount = rawChunkCount;
      err.finishReason = lastFinishReason;
      throw err;
    }
  }

  return { content: fullContent, tokenCount };
}

async function streamAnthropicResponse(response, spinner, controller = null) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;
  let sseBuffer = '';

  let streamingStarted = false;

  // Timer d'inactivité (garde-fou anti-blocage, cf. streamOpenAICompatResponse
  // et readWithIdleGuard : stratégie COURSE — reader.cancel() ET
  // controller.abort() ne rejettent PAS un read() en attente sur undici).
  const readWithIdleGuard = async () => {
    let idleFired = false;
    let idleTimer = null;
    const idlePromise = new Promise((resolve) => {
      idleTimer = setTimeout(() => { idleFired = true; resolve(null); }, CLOUD_STREAM_IDLE_TIMEOUT_MS);
    });
    try {
      const chunk = await Promise.race([reader.read(), idlePromise]);
      if (idleFired) {
        try { reader.cancel(); } catch (_) {}
        if (controller) { try { controller.abort(); } catch (_) {} }
        const e = new Error('Réponse vide — aucun chunk reçu pendant ' + (CLOUD_STREAM_IDLE_TIMEOUT_MS / 1000) + 's (inactivité du modèle cloud)');
        e.isEmptyResponse = true;
        e.isIdleTimeout = true;
        throw e;
      }
      return chunk;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };
  // Flag de coupure anti-boucle (cf. streamOpenAICompatResponse : un break
  // simple ne casse que le for interne, pas le while externe).
  let stopStreaming = false;

  try {
    while (true) {
      if (stopStreaming) break;
      const { done, value } = await readWithIdleGuard();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (!payload) continue;
        try {
          const chunk = JSON.parse(payload);
          // Anthropic "thinking" deltas (extended thinking)
          if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'thinking_delta') {
            const thinkText = chunk.delta.thinking || '';
            if (!streamingStarted && thinkText) { spinner.beginStreaming(); streamingStarted = true; }
            reasoningContent += thinkText;
            tokenCount++;
            spinner.updateTokens(tokenCount, reasoningContent.length);
            spinner.appendStreamChunk(thinkText, 'reasoning');
            continue;
          }
          if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
            const text = chunk.delta.text || '';
            if (!streamingStarted && text) { spinner.beginStreaming(); streamingStarted = true; }
            fullContent += text;
            tokenCount++;
            spinner.updateTokens(tokenCount, fullContent.length);
            spinner.appendStreamChunk(text, 'content');
            // Plafond de réponse (anti-boucle, cf. streamOpenAICompatResponse).
            if (fullContent.length > CLOUD_CONTENT_MAX_CHARS) {
              logger.warn('Cloud streaming (Anthropic) : plafond de réponse atteint (' + fullContent.length + ' chars) — coupure du stream.');
              stopStreaming = true;
              break;
            }
          }
        } catch (_) {}
      }
    }
  } catch (streamErr) {
    // Bug undici Node.js 24.x (cf. streamOpenAICompatResponse).
    // Inactivité : propage notre erreur (flags isIdleTimeout/isEmptyResponse).
    if (streamErr && streamErr.isIdleTimeout) throw streamErr;
    if (fullContent.trim() || reasoningContent.trim()) {
      logger.warn('Cloud streaming (Anthropic) : déconnexion socket interceptée (bug undici 24.x) — contenu partiel conservé (' + (fullContent.length + reasoningContent.length) + ' chars).');
    } else {
      throw streamErr;
    }
  }

  if (streamingStarted) spinner.endStreaming();

  if (!fullContent.trim() && reasoningContent.trim()) {
    fullContent = reasoningContent;
  }

  return { content: fullContent, tokenCount };
}

// Retry sur HTTP 429 (rate limit) : les pools :free partages (OpenRouter direct
// ou Kilo Gateway routant vers OpenRouter upstream) limitent a ~60 req/min par
// modele. Un run FRONTIER (7 classes + aide + rattrapage) depasse ce quota sur
// des rafales — les 429 sont TRANSITOIRES. Backoff lineaire : 5s, 10s, 15s.
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 5000;
let _anonWarned = false; // n'affiche l'avertissement anonyme qu'une fois par session

/**
 * Interface identique à lm-studio-client.js#queryLLM.
 * options.providerConfig = { provider, model, apiKey? }
 * La clé API est lue depuis options.providerConfig.apiKey en priorité,
 * sinon depuis la variable d'environnement correspondante au fournisseur.
 */
async function queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options = {}, _rateLimitRetries = 0) {
  const startTime = Date.now();
  const { providerConfig = {} } = options;
  const { provider, model, apiKey, endpoint } = providerConfig;

  if (!provider) throw new Error('cloud-client: providerConfig.provider manquant.');
  if (!model)    throw new Error('cloud-client: providerConfig.model manquant.');

  const provKey = provider.toLowerCase();
  const provSpec = CLOUD_PROVIDERS[provKey];
  if (!provSpec) {
    throw new Error(
      `Fournisseur cloud inconnu : '${provider}'.\n  Valeurs valides : ${Object.keys(CLOUD_PROVIDERS).join(', ')}`
    );
  }

  // URL : providerConfig.endpoint (flag --endpoint=) en priorité, sinon options.endpoint
  // (compatibilité), sinon l'URL par défaut du provider.
  const rawEndpoint = endpoint || options.endpoint || provSpec.url;
  if (!rawEndpoint) {
    throw new Error(
      `Fournisseur '${provider}' nécessite --endpoint=<url>.\n  Exemple : --endpoint=http://localhost:8080/v1/chat/completions`
    );
  }
  // Normalisation de l'endpoint (tâche 2026-09-29) : les fournisseurs de "base
  // URL" (Ollama Cloud https://ollama.com/v1, OpenAI SDK style, passerelles
  // vLLM...) documentent une URL SANS /chat/completions. L'utilisateur la colle
  // telle quelle → BenchGo POSTait la racine verbatim → HTTP 405 "Method Not
  // Allowed" (logs 2026-09-29T13-00 / 13-02) : le serveur refuse POST / ou
  // POST /v1. On complète l'URL : /v1 → /v1/chat/completions, .../v1/chat →
  // .../v1/chat/completions. Une URL déjà en /chat/completions (ou /messages
  // Anthropic, /api/gateway/chat/completions Kilo) reste INCHANGÉE.
  const resolvedUrl = normalizeCompletionsUrl(rawEndpoint);
  // Signal d'incohérence provider local vs mode cloud (tâche 2026-09-29) :
  // une clé API mémorisée + endpoint par défaut LOCAL = config cloud incomplète
  // (l'utilisateur a mémorisé une clé Ollama/LM Studio cloud mais a oublié
  // --endpoint=). Le ping échouerait en ECONNREFUSED ou en 401/405 sur un
  // serveur local erroné. On avertit AVANT le premier appel.
  if (provKey === 'ollama' || provKey === 'lmstudio') {
    const isLocalUrl = /^http:\/\/(localhost|127\.0\.0\.1|(\[::1\]))(:|$)/i.test(resolvedUrl);
    if (!isLocalUrl && rawEndpoint === provSpec.url && apiKey) {
      logger.warn(`${provider} : clé API fournie mais endpoint PAR DÉFAUT local (${resolvedUrl}). Si la clé est une clé CLOUD (${provKey === 'ollama' ? 'ollama.com' : 'LM Studio distant'}), ajoutez --endpoint=<base URL>.`);
    }
  }

  // Clé API : optionnelle pour les serveurs locaux (ollama, lmstudio, custom).
  // Pour Kilo (optionalAuth: true), l'absence de clé est tolérée (accès anonyme
  // aux modèles :free, limité à 200 req/h/IP) — on avertit mais on ne bloque pas.
  const resolvedKey = apiKey || (provSpec.envKey ? process.env[provSpec.envKey] : null);
  if (provSpec.requiresAuth && !resolvedKey && !provSpec.optionalAuth) {
    throw new Error(
      `Clé API manquante pour '${provider}'.\n` +
      `  Définissez : $env:${provSpec.envKey} = "votre-clé"\n` +
      `  Ou passez  : --api-key=votre-clé  (⚠ visible dans le gestionnaire de tâches)`
    );
  }
  if (!resolvedKey && provSpec.optionalAuth) {
    // Avertissement une seule fois par session (pas a chaque requete).
    if (!_anonWarned) {
      _anonWarned = true;
      logger.warn(`${provider} : pas de clé API — accès anonyme (modèles :free uniquement, ~200 req/h/IP).`);
      console.log(`  \x1b[33m[${provider}] Sans clé : accès anonyme limité. Les :free routent vers les pools OpenRouter\x1b[0m`);
      console.log(`  \x1b[33mupstream (rate-limits partagés, ~60 req/min) — un run complet risque des HTTP 429. Clé recommandée.\x1b[0m`);
    }
  }

  const systemPrompt = getSystemPrompt(difficulty);
  // Timeout dédié (auto-profilage) sinon timeout global API.
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : API_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.promptHash(tierId, prompt);
    logger.info(`Cloud Tier ${tierId} — provider=${provider}, model=${model}`);
    logger.exercise('provider', {
      stage: 'cloud_request',
      tierId,
      provider,
      model,
      promptLength: (prompt || '').length,
      promptPreview: (prompt || '').substring(0, 600),
      timeoutMs,
      disableReasoning: Boolean(options.disableReasoning)
    });

    let response;

    if (provSpec.openaiCompat) {
      const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
      if (resolvedKey) headers['Authorization'] = `Bearer ${resolvedKey}`;
      // OpenRouter impose des en-têtes de traçabilité
      if (provKey === 'openrouter') {
        headers['HTTP-Referer'] = 'https://benchgo-v3';
        headers['X-Title'] = 'BenchGo V3';
      }
      const requestBody = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: prompt }
        ],
        temperature: 0.1,
        stream: true
      };
      // max_tokens explicite (auto-profilage) — limite la sortie pour forcer une
      // réponse concise. maxTokens=0 (ou non entier >0) = sortie ILLIMITÉE
      // (carte blanche auto-profilage) : on n'envoie pas le champ.
      if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) {
        requestBody.max_tokens = options.maxTokens;
      }
      // Désactivation du raisonnement étendu (auto-profilage) pour les modèles
      // de raisonnement (GLM, Qwen3, DeepSeek-R1...) via chat_template_kwargs.
      if (options.disableReasoning) {
        requestBody.chat_template_kwargs = { enable_thinking: false };
      }
      // response_format optionnel (auto-profilage JSON) — supporté par les APIs OpenAI-compat
      if (options.responseFormat) {
        requestBody.response_format = options.responseFormat;
      }
      response = await fetch(resolvedUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } else {
      // Anthropic Messages API (format natif) — response_format non supporté,
      // le prompt doit imposer le format JSON (fallback regex côté self-profiling).
      response = await fetch(resolvedUrl, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       resolvedKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
          stream: true
        }),
        signal: controller.signal
      });
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      let errorBody = '';
      try { errorBody = await response.text(); } catch (_) {}
      const status = response.status;
      const msg = `HTTP_${status} — ${errorBody.substring(0, 300)}`;
      // Erreur de slug invalide (ex: "node is not a valid model ID") : FATALE.
      // Sans ça, le runner parcours les 6 classes en échec (0/2752, rapport
      // inutile) au lieu d'arrêter net. On marque l'erreur pour que le runner
      // l'interprète comme un arrêt immédiat (isFatalSlugError).
      const isInvalidModelId = status === 400 && /not a valid model/i.test(errorBody);
      const isInvalidModel = status === 404 && /model.*not found|does not exist|no such model/i.test(errorBody);
      const isBatchOnlyModel = status === 404 && /only available through the Batch API|Filter Batch-Only Endpoints/i.test(errorBody);
      // HTTP 405 "Method Not Allowed" (tâche 2026-09-29) : le POST touche une
      // URL qui n'accepte pas POST → endpoint mal formé (base URL collée
      // verbatim sans /chat/completions, ou mauvais chemin). Définitif : un
      // endpoint n'accepte JAMAIS le POST par hasard. On marque l'erreur pour
      // que le pre-flight (runner.js) arrête net avec un diagnostic dédié au
      // lieu du générique E505 « rate-limité upstream ».
      const isMethodNotAllowed = status === 405;
      if (isInvalidModelId || isInvalidModel || isBatchOnlyModel || isMethodNotAllowed) {
        const err = new Error(msg);
        err.isFatalSlugError = true;
        err.isBatchOnlyError = isBatchOnlyModel;
        err.isMethodNotAllowedError = isMethodNotAllowed;
        err.code = isInvalidModelId ? 'E400_INVALID_MODEL_ID'
          : (isBatchOnlyModel ? 'E404_BATCH_ONLY_MODEL'
          : (isMethodNotAllowed ? 'E405_ENDPOINT_NOT_CHAT' : 'E404_MODEL_NOT_FOUND'));
        throw err;
      }
      throw new Error(msg);
    }

    const streamResult = provSpec.openaiCompat
      ? await streamOpenAICompatResponse(response, spinner, controller)
      : await streamAnthropicResponse(response, spinner, controller);

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    logger.apiRequest(tierId, duration, 'OK');
    logger.info(`Cloud Tier ${tierId} : réponse reçue en ${duration}ms (${streamResult.tokenCount} chunks, ${streamResult.content.length} chars).`);
    logger.exercise('provider', {
      stage: 'cloud_response',
      tierId,
      provider,
      model,
      durationMs: duration,
      tokenCount: streamResult.tokenCount,
      contentLength: streamResult.content.length,
      contentPreview: streamResult.content.substring(0, 800)
    });
    // Benchmarking intégré (§2) : enregistre latence + tokens pour ce modèle cloud.
    benchMetrics.record({
      modelName: model,
      durationMs: duration,
      tokens: streamResult.tokenCount,
      tierId,
      status: 'OK'
    });

    return {
      content:   streamResult.content.trim(),
      modelName: model
    };

  } catch (error) {
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    // HTTP 429 (rate limit) : RETRY avec backoff. Les pools :free partages
    // (OpenRouter direct, ou Kilo Gateway qui route vers OpenRouter upstream)
    // renvoient des 429 TRANSITOIRES — le corps dit explicitement « Please
    // retry shortly » et les headers X-RateLimit indiquent la limite
    // (60 req/min constate en 2026-09-03). Sans retry, un run FRONTIER perd
    // des classes entieres sur un simple rate-limit passager : le runner
    // marque le tier obligatoire ECCHOUE et elime un modele qui repondait
    // parfaitement (cf. log benchgo_2026-09-03T12-14-28 : Tier 0 OK 10/10,
    // puis Tiers 1/2/4 tues par 429 a ~300ms). On retente avec un backoff
    // lineaire (5s, 10s, 15s) — le rate-limit upstream est une fenetre
    // glissante d'une minute, quelques secondes suffisent generalement a la
    // franchir. Le compteur traverse les recursions via _rateLimitRetries.
    const isRateLimit = /HTTP_429/.test(error.message || '') && !error.isFatalSlugError && !error.isEmptyResponse;
    if (isRateLimit && _rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      const attempt = _rateLimitRetries + 1;
      const delay = RATE_LIMIT_DELAY_MS * attempt; // 5s, 10s, 15s
      logger.warn(`Cloud Tier ${tierId} — HTTP 429 (rate limit ${attempt}/${MAX_RATE_LIMIT_RETRIES}) — retry dans ${delay / 1000}s`);
      console.log(`  \x1b[33m[429] Rate limit upstream — nouvelle tentative ${attempt}/${MAX_RATE_LIMIT_RETRIES} dans ${delay / 1000}s...\x1b[0m`);
      await new Promise(r => setTimeout(r, delay));
      return queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options, attempt);
    }

    const isTimeout = error.name === 'AbortError';
    const reason = isTimeout
      ? `Timeout après ${timeoutMs / 1000}s — le modèle cloud n'a pas répondu dans le délai imparti`
      : error.message;

    logger.apiRequest(tierId || '?', duration, 'ERREUR');
    logger.error(`Cloud Tier ${tierId} — ${reason}`);
    logger.exercise('provider', {
      stage: 'cloud_error',
      tierId,
      provider,
      model,
      durationMs: duration,
      isTimeout,
      error: reason
    });
    // Benchmarking intégré (§2) : enregistre l'échec pour le taux d'erreur.
    benchMetrics.record({
      modelName: model,
      durationMs: duration,
      tokens: 0,
      tierId,
      status: isTimeout ? 'TIMEOUT' : 'ERREUR'
    });

    if (error.isFatalSlugError || isMandatory) {
      // Erreur code-court propagée au runner (affichage propre + log).
      // isFatalSlugError (slug invalide) : TOUJOURS fatale, même en
      // isMandatory=false, pour arrêter net au lieu de parcourir 6 classes.
      // HTTP_400 "Failed to load model" (provider local via --provider=lmstudio
      // en RunCode) : arch GGUF inconnue du runtime llama.cpp de LM Studio
      // (ex: k2-horizon). Code E507 + message explicite au lieu du JSON brut
      // (tâche 2026-09-11).
      const isLoadFailure = /HTTP_400/.test(reason) && /failed to load model/i.test(reason);
      const code = error.isFatalSlugError
        ? (error.code || 'E400_INVALID_MODEL_ID')
        : isLoadFailure ? 'E507_LM_LOAD_FAILED'
        : error.isIdleTimeout ? 'E508_LM_IDLE_TIMEOUT'
        : isTimeout ? 'E502_LM_TIMEOUT'
        : /ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(error.code || reason) ? 'E503_LM_UNREACHABLE'
        : 'E504_LM_HTTP_ERROR';
      const friendlyReason = code === 'E507_LM_LOAD_FAILED'
        ? `Le modèle ne peut pas être chargé par LM Studio : architecture GGUF non supportée par le runtime llama.cpp actuel (modèle trop récent pour le runtime installé). Mettez LM Studio à jour (runtimes), ou testez un autre GGUF. Ce modèle est inutilisable en l'état : vous pouvez le supprimer de LM Studio (UI → poubelle) pour libérer de l'espace disque. Détail : ${reason}`
        : code === 'E508_LM_IDLE_TIMEOUT'
        ? `Le modèle cloud n'a envoyé AUCUN chunk pendant ${CLOUD_STREAM_IDLE_TIMEOUT_MS / 1000}s (inactivité totale). Le serveur est probablement surchargé ou le modèle indisponible — réessayez plus tard ou changez de modèle. Détail : ${reason}`
        : `Cloud Tier ${tierId} — ${reason}`;
      throw new BenchgoError(code, friendlyReason);
    } else {
      // isEmptyResponse (réponse vide 200 OK) : on propage l'erreur avec le
      // flag pour que le runner puisse compter les réponses vides consécutives
      // et arrêter net après un seuil (modèle free systématiquement vide).
      if (error.isEmptyResponse) {
        console.error(`\n  \x1b[33m[WARN]\x1b[0m Cloud Tier ${tierId} : ${reason}`);
        error.isEmptyResponse = true; // préservé pour le caller
        throw error;
      }
      console.error(`\n  \x1b[33m[WARN]\x1b[0m Cloud Tier ${tierId} échoué (optionnel) : ${reason}`);
      return null;
    }
  }
}

module.exports = { queryLLM, CLOUD_PROVIDERS, normalizeCompletionsUrl };
