
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

  // Active le mode streaming live du spinner dès la première donnée reçue.
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
        const modelName = chunk.model;

        if (!streamingStarted && (delta || reasoning)) {
          spinner.beginStreaming();
          streamingStarted = true;
        }

        if (delta) {
          fullContent += delta;
          tokenCount++;
          spinner.updateTokens(tokenCount, fullContent.length);
          // Affiche le fragment de réponse finale en live (flux brut, sans filtre)
          spinner.appendStreamChunk(delta, 'content');
        }
        // Certains modèles de raisonnement (MiniCPM5, Qwen3, DeepSeek-R1, GLM...)
        // diffusent leur réponse dans `reasoning_content` et laissent `content` vide.
        // On le capture pour ne pas perdre la réponse ET l'afficher en live.
        if (reasoning) {
          reasoningContent += reasoning;
          tokenCount++;
          spinner.updateTokens(tokenCount, reasoningContent.length);
          // Affiche le raisonnement (pensée) en live, comme les logs LM Studio
          spinner.appendStreamChunk(reasoning, 'reasoning');
        }
        if (modelName && !spinner._modelName) {
          spinner._modelName = modelName;
        }
      } catch (_) {}
    }
  }

  // Termine l'affichage streaming (relance le spinner proprement)
  if (streamingStarted) {
    spinner.endStreaming();
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
  // Timeout dédié (auto-profilage) sinon timeout global API. Permet de couper
  // court aux modèles de raisonnement qui passent plusieurs minutes en pensée.
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : API_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const contextLimitTokens = Number.isInteger(options.contextLimitTokens) && options.contextLimitTokens > 0
    ? options.contextLimitTokens
    : 16384;
  const systemPrompt = getSystemPrompt(difficulty);

  // Réserve un peu de marge pour les métadonnées/messages système.
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(prompt) + 128;
  const availableForOutput = contextLimitTokens - estimatedInputTokens;
  // maxTokens explicite (auto-profilage) sinon calculé depuis le budget contexte.
  // maxTokens=0 (ou falsy) = sortie ILLIMITÉE (carte blanche auto-profilage) :
  // on n'envoie pas le champ max_tokens pour ne pas tronquer le JSON du modèle.
  const maxTokensExplicit = Number.isInteger(options.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : null;
  const maxTokens = maxTokensExplicit != null
    ? maxTokensExplicit
    : Math.max(256, Math.min(4096, availableForOutput));

  try {
    if (estimatedInputTokens >= (contextLimitTokens - 256)) {
      throw new Error(`Prompt trop long pour le budget contexte (${estimatedInputTokens}/${contextLimitTokens} tokens estimés). Réduisez le prompt ou augmentez --context-limit.`);
    }

    logger.promptHash(tierId, prompt);
    logger.info(`Tier ${tierId} — Budget contexte: limite=${contextLimitTokens}, entrée~${estimatedInputTokens}, sortie max=${maxTokensExplicit == null ? maxTokens + ' (auto)' : 'illimitée (carte blanche)'} tokens.`);

    const requestBody = {
      model: "local-model",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      stream: true
    };
    // max_tokens : uniquement si on a une limite explicite. maxTokens=0 = pas de
    // champ (sortie illimitée, auto-profilage carte blanche).
    if (maxTokensExplicit != null) {
      requestBody.max_tokens = maxTokensExplicit;
    }
    // response_format optionnel (auto-profilage JSON) — supporté par LM Studio (OpenAI-compat)
    if (options.responseFormat) {
      requestBody.response_format = options.responseFormat;
    }
    // Désactivation du raisonnement étendu (auto-profilage) pour les modèles
    // de raisonnement (GLM, Qwen3, DeepSeek-R1...) via chat_template_kwargs.
    // LM Studio propage ce paramètre au template du modèle ; les modèles non
    // compatibles l'ignorent silencieusement. Évite les 372s de pensée inutile.
    if (options.disableReasoning) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
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
      ? `Timeout après ${timeoutMs / 1000}s — le modèle n'a pas répondu dans le délai imparti`
      : error.message;

    logger.apiRequest(tierId || '?', duration, 'ERREUR');
    logger.error(`API Tier ${tierId} — ${reason}`);

    if (isMandatory) {
      console.error(`\n\x1b[31m[ERREUR API]\x1b[0m ${reason}`);
      console.error(`  -> Vérifiez que LM Studio tourne sur le port 1234.`);
      if (isTimeout) {
        console.error(`  -> Le modèle a mis plus de ${timeoutMs / 1000}s à répondre. Augmenter API_TIMEOUT_MS ou utiliser un profil inférieur.`);
      }
      process.exit(1);
    } else {
      console.error(`\n  \x1b[33m[WARN]\x1b[0m API Tier ${tierId} échoué (optionnel) : ${reason}`);
      return null;
    }
  }
}

module.exports = { queryLLM };
