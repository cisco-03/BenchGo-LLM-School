
const logger = require('./logger');
const { LM_STUDIO_API_URL, API_TIMEOUT_MS } = require('./config');

function getSystemPrompt(difficulty) {
  if (difficulty === "EXPERT" || difficulty === "HARD") {
    return "Tu es un ingénieur logiciel principal. Réponds exclusivement en Markdown. Utilise les conventions exactes demandées avec les blocs de code.";
  }
  return "Tu es un développeur compétent. Réponds en Markdown de manière structurée comme demandé, avec les titres et les blocs de code.";
}

function estimateTokens(text) {
  if (!text) return 0;
  // Approximation simple et stable: ~4 caractères par token.
  return Math.ceil(text.length / 4);
}

async function streamLLMResponse(response, spinner) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;
  let sseBuffer = '';

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
        const modelName = chunk.model;
        if (delta) {
          fullContent += delta;
          tokenCount++;
          spinner.updateTokens(tokenCount, fullContent.length);
        }
        // Certains modèles de raisonnement (MiniCPM5, Qwen3, DeepSeek-R1, GLM...)
        // diffusent leur réponse dans `reasoning_content` et laissent `content` vide.
        // On le capture pour ne pas perdre la réponse.
        if (reasoning) {
          reasoningContent += reasoning;
        }
        if (modelName && !spinner._modelName) {
          spinner._modelName = modelName;
        }
      } catch (_) {}
    }
  }

  // Repli : si le modèle n'a produit aucun `content` (modèle de raisonnement),
  // on utilise le `reasoning_content` comme contenu exploitable.
  if (!fullContent.trim() && reasoningContent.trim()) {
    fullContent = reasoningContent;
  }

  return { content: fullContent, tokenCount, modelName: spinner._modelName };
}

async function queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options = {}) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const contextLimitTokens = Number.isInteger(options.contextLimitTokens) && options.contextLimitTokens > 0
    ? options.contextLimitTokens
    : 16384;
  const systemPrompt = getSystemPrompt(difficulty);

  // Réserve un peu de marge pour les métadonnées/messages système.
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(prompt) + 128;
  const availableForOutput = contextLimitTokens - estimatedInputTokens;
  const maxTokens = Math.max(256, Math.min(4096, availableForOutput));

  try {
    if (estimatedInputTokens >= (contextLimitTokens - 256)) {
      throw new Error(`Prompt trop long pour le budget contexte (${estimatedInputTokens}/${contextLimitTokens} tokens estimés). Réduisez le prompt ou augmentez --context-limit.`);
    }

    logger.promptHash(tierId, prompt);
    logger.info(`Tier ${tierId} — Budget contexte: limite=${contextLimitTokens}, entrée~${estimatedInputTokens}, sortie max=${maxTokens} tokens.`);

    const requestBody = {
      model: "local-model",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: true
    };
    // response_format optionnel (auto-profilage JSON) — supporté par LM Studio (OpenAI-compat)
    if (options.responseFormat) {
      requestBody.response_format = options.responseFormat;
    }

    const response = await fetch(LM_STUDIO_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      let errorBody = '';
      try { errorBody = await response.text(); } catch(_) {}
      const detail = errorBody ? ` — ${errorBody.substring(0, 200)}` : '';
      throw new Error(`HTTP_${response.status}${detail}`);
    }

    const streamResult = await streamLLMResponse(response, spinner);
    clearTimeout(timeoutId);

    const duration = Date.now() - startTime;
    logger.apiRequest(tierId, duration, 'OK');
    logger.info(`API Tier ${tierId} : réponse reçue en ${duration}ms (${streamResult.tokenCount} chunks, ${streamResult.content.length} chars).`);

    return {
      content: streamResult.content.trim(),
      modelName: streamResult.modelName || "Modele_Local"
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    const isTimeout = error.name === 'AbortError';
    const reason = isTimeout
      ? `Timeout après ${API_TIMEOUT_MS / 1000}s — le modèle n'a pas répondu dans le délai imparti`
      : error.message;

    logger.apiRequest(tierId || '?', duration, 'ERREUR');
    logger.error(`API Tier ${tierId} — ${reason}`);

    if (isMandatory) {
      console.error(`\n\x1b[31m[ERREUR API]\x1b[0m ${reason}`);
      console.error(`  -> Vérifiez que LM Studio tourne sur le port 1234.`);
      if (isTimeout) {
        console.error(`  -> Le modèle a mis plus de ${API_TIMEOUT_MS / 1000}s à répondre. Augmenter API_TIMEOUT_MS ou utiliser un profil inférieur.`);
      }
      process.exit(1);
    } else {
      console.error(`\n  \x1b[33m[WARN]\x1b[0m API Tier ${tierId} échoué (optionnel) : ${reason}`);
      return null;
    }
  }
}

module.exports = { queryLLM };
