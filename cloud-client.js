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

async function streamOpenAICompatResponse(response, spinner) {
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
      const { done, value } = await reader.read();
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
        }
      } catch (_) {}
    }
  }
  } catch (streamErr) {
    // Bug undici Node.js 24.x : "socket idle timeout" ou "Cannot assign to
    // read only property 'name'". On a déjà intercepté l'uncaughtException
    // au niveau global (runner.js), mais le reader.read() rejette aussi.
    // On garde le contenu PARTIEL déjà reçu (mieux que rien pour l'évaluation).
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

async function streamAnthropicResponse(response, spinner) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;
  let sseBuffer = '';

  let streamingStarted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
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
          }
        } catch (_) {}
      }
    }
  } catch (streamErr) {
    // Bug undici Node.js 24.x (cf. streamOpenAICompatResponse).
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

/**
 * Interface identique à lm-studio-client.js#queryLLM.
 * options.providerConfig = { provider, model, apiKey? }
 * La clé API est lue depuis options.providerConfig.apiKey en priorité,
 * sinon depuis la variable d'environnement correspondante au fournisseur.
 */
async function queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options = {}) {
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
  const resolvedUrl = endpoint || options.endpoint || provSpec.url;
  if (!resolvedUrl) {
    throw new Error(
      `Fournisseur '${provider}' nécessite --endpoint=<url>.\n  Exemple : --endpoint=http://localhost:8080/v1/chat/completions`
    );
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
    logger.warn(`${provider} : pas de clé API — accès anonyme (modèles gratuits, 200 req/h/IP).`);
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
      if (isInvalidModelId || isInvalidModel) {
        const err = new Error(msg);
        err.isFatalSlugError = true;
        err.code = isInvalidModelId ? 'E400_INVALID_MODEL_ID' : 'E404_MODEL_NOT_FOUND';
        throw err;
      }
      throw new Error(msg);
    }

    const streamResult = provSpec.openaiCompat
      ? await streamOpenAICompatResponse(response, spinner)
      : await streamAnthropicResponse(response, spinner);

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
      const code = error.isFatalSlugError
        ? (error.code || 'E400_INVALID_MODEL_ID')
        : isTimeout ? 'E502_LM_TIMEOUT'
        : /ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(error.code || reason) ? 'E503_LM_UNREACHABLE'
        : 'E504_LM_HTTP_ERROR';
      throw new BenchgoError(code, `Cloud Tier ${tierId} — ${reason}`);
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

module.exports = { queryLLM, CLOUD_PROVIDERS };
