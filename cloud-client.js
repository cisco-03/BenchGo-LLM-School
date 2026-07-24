const logger = require('./logger');
const { API_TIMEOUT_MS } = require('./config');

// Fournisseurs cloud supportés
// openaiCompat: true  → format OpenAI /v1/chat/completions avec streaming SSE standard
// openaiCompat: false → format Anthropic Messages API avec streaming SSE propre
// requiresAuth: false → clé API non requise (serveurs locaux)
const CLOUD_PROVIDERS = {
  openai:     { url: 'https://api.openai.com/v1/chat/completions',      envKey: 'OPENAI_API_KEY',      openaiCompat: true,  requiresAuth: true  },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY',        openaiCompat: true,  requiresAuth: true  },
  together:   { url: 'https://api.together.xyz/v1/chat/completions',    envKey: 'TOGETHER_API_KEY',    openaiCompat: true,  requiresAuth: true  },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',   envKey: 'OPENROUTER_API_KEY',  openaiCompat: true,  requiresAuth: true  },
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
  if (difficulty === 'EXPERT' || difficulty === 'HARD' || difficulty === 'FRONTIER') {
    return "You are a principal software engineer. Respond exclusively in Markdown. Use the exact conventions requested with code blocks.";
  }
  return "You are a competent developer. Reply in Markdown in a structured way as requested, using code blocks.";
}

async function streamOpenAICompatResponse(response, spinner) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;
  let sseBuffer = '';

  let streamingStarted = false;

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
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;

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

  if (streamingStarted) spinner.endStreaming();

  if (!fullContent.trim() && reasoningContent.trim()) {
    fullContent = reasoningContent;
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
  const { provider, model, apiKey } = providerConfig;

  if (!provider) throw new Error('cloud-client: providerConfig.provider manquant.');
  if (!model)    throw new Error('cloud-client: providerConfig.model manquant.');

  const provKey = provider.toLowerCase();
  const provSpec = CLOUD_PROVIDERS[provKey];
  if (!provSpec) {
    throw new Error(
      `Fournisseur cloud inconnu : '${provider}'.\n  Valeurs valides : ${Object.keys(CLOUD_PROVIDERS).join(', ')}`
    );
  }

  // URL : --endpoint= en priorité (pour 'custom' ou override d'un provider existant)
  const resolvedUrl = options.endpoint || provSpec.url;
  if (!resolvedUrl) {
    throw new Error(
      `Fournisseur '${provider}' nécessite --endpoint=<url>.\n  Exemple : --endpoint=http://localhost:8080/v1/chat/completions`
    );
  }

  // Clé API : optionnelle pour les serveurs locaux (ollama, lmstudio, custom)
  const resolvedKey = apiKey || (provSpec.envKey ? process.env[provSpec.envKey] : null);
  if (provSpec.requiresAuth && !resolvedKey) {
    throw new Error(
      `Clé API manquante pour '${provider}'.\n` +
      `  Définissez : $env:${provSpec.envKey} = "votre-clé"\n` +
      `  Ou passez  : --api-key=votre-clé  (⚠ visible dans le gestionnaire de tâches)`
    );
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

    let response;

    if (provSpec.openaiCompat) {
      const headers = { 'Content-Type': 'application/json' };
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
      throw new Error(`HTTP_${response.status} — ${errorBody.substring(0, 300)}`);
    }

    const streamResult = provSpec.openaiCompat
      ? await streamOpenAICompatResponse(response, spinner)
      : await streamAnthropicResponse(response, spinner);

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    logger.apiRequest(tierId, duration, 'OK');
    logger.info(`Cloud Tier ${tierId} : réponse reçue en ${duration}ms (${streamResult.tokenCount} chunks, ${streamResult.content.length} chars).`);

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

    if (isMandatory) {
      console.error(`\n\x1b[31m[ERREUR CLOUD]\x1b[0m ${reason}`);
      if (isTimeout) {
        // Le timeout utilisé dépend du contexte : auto-profilage (PROFILING_TIMEOUT_MS)
        // ou appel normal (API_TIMEOUT_MS). On indique les deux au cas où.
        const timeoutName = timeoutMs === API_TIMEOUT_MS ? 'API_TIMEOUT_MS' : 'timeoutMs';
        console.error(`  -> Vérifiez votre connexion internet ou augmentez ${timeoutName} dans config.js.`);
      }
      process.exit(1);
    } else {
      console.error(`\n  \x1b[33m[WARN]\x1b[0m Cloud Tier ${tierId} échoué (optionnel) : ${reason}`);
      return null;
    }
  }
}

module.exports = { queryLLM, CLOUD_PROVIDERS };
