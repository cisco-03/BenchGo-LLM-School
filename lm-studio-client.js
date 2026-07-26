const http = require('http');
const logger = require('./logger');
const { LM_STUDIO_API_URL, API_TIMEOUT_MS } = require('./config');
const { BenchgoError } = require('./cli-help');
const benchMetrics = require('./benchmark-metrics');

// Agent dédié NON keepAlive : chaque requête obtient sa propre socket, qui est
// libérée à la fin. On évite ainsi la réutilisation de socket poolée par
// http.globalAgent (keepAlive=true) qui provoque une fuite de listeners
// EventEmitter (MaxListeners) et des crashes sur Node v24.12.0 quand plusieurs
// requêtes SSE se succèdent (tiers + aide + rattrapage).
const HTTP_AGENT = new http.Agent({ keepAlive: false, maxSockets: 1 });

// --- IMPORTANT : pourquoi node:http au lieu de fetch (undici) ---
// BenchGo streamait les réponses SSE de LM Studio via `fetch` (undici, intégré à
// Node). Sur Node v24.12.0 (undici 7.16.0), un timer interne "socket idle
// timeout" se déclenche pendant le prompt processing long (>300s pour les gros
// modèles) et jette une erreur NON récupérable :
//   TypeError: Cannot assign to read only property 'name' of object 'Error: socket idle timeout'
//     at new UndiciError (node:internal/deps/undici/undici:20:19)
//     at Timeout.onParserTimeout [as _onTimeout] (node:internal/deps/undici/undici:7049:30)
// Cette erreur tue le process Node en plein streaming (uncaughtException) :
// LM Studio voit "Client disconnected. Stopping generation...", décharge le
// modèle, et tous les tiers suivants tombent sur "No models loaded".
// Cf. logs benchgo_2026-07-24T21-22-56 et Memories-BenchGo/Tasks1.md + Tasks2.md.
//
// `node:http` ne passe pas par undici et n'a pas ce bug. On parse le flux SSE
// manuellement. Le timeout applicatif est géré via socket.setTimeout (et non
// AbortController) pour rester sur la pile http native.

function getSystemPrompt(difficulty) {
  if (difficulty === "EXPERT" || difficulty === "HARD") {
    return "Tu es un ingénieur logiciel principal. Réponds exclusivement en Markdown. Utilise les conventions exactes demandées avec les blocs de code.";
  }
  return "Tu es un développeur compétent. Réponds en Markdown de manière structurée comme demandé, avec les titres et les blocs de code.";
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Décompose LM_STUDIO_API_URL ("http://localhost:1234/v1/chat/completions")
// en { hostname, port, path } pour node:http.
function parseApiUrl(url) {
  const m = url.match(/^https?:\/\/([^:/]+):(\d+)(\/.*)$/i);
  if (!m) throw new Error(`URL API LM Studio invalide : ${url}`);
  return { hostname: m[1], port: parseInt(m[2], 10), path: m[3] };
}

async function queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options = {}) {
  const startTime = Date.now();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : API_TIMEOUT_MS;
  const contextLimitTokens = Number.isInteger(options.contextLimitTokens) && options.contextLimitTokens > 0
    ? options.contextLimitTokens
    : 16384;
  const systemPrompt = getSystemPrompt(difficulty);

  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(prompt) + 128;
  const availableForOutput = contextLimitTokens - estimatedInputTokens;
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
    if (maxTokensExplicit != null) {
      requestBody.max_tokens = maxTokensExplicit;
    }
    if (options.responseFormat) {
      requestBody.response_format = options.responseFormat;
    }
    if (options.disableReasoning) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }

    const { hostname, port, path } = parseApiUrl(LM_STUDIO_API_URL);

    let aborted = false;
    let timeoutFired = false;
    let fullContent = '';
    let reasoningContent = '';
    let tokenCount = 0;
    let responseModelName = null;
    let streamingStarted = false;

    const bodyStr = JSON.stringify(requestBody);

    const request = http.request({
      hostname,
      port,
      path,
      method: 'POST',
      agent: HTTP_AGENT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'text/event-stream'
      }
    });

    // Timeout applicatif : on démarre le timer d'inactivité IMMÉDIATEMENT (pas
    // via socket listeners, pour éviter une fuite EventEmitter sur les sockets
    // keepAlive réutilisés — cf. memory leak MaxListeners qui crash Node v24).
    // Le timer est reset à chaque chunk reçu (resetInactivityTimer dans res 'data').
    let inactivityTimer = null;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (aborted) return;
      inactivityTimer = setTimeout(() => {
        if (aborted) return;
        timeoutFired = true;
        try { request.destroy(new Error('timeout')); } catch (_) { request.destroy(); }
      }, timeoutMs);
    };
    resetInactivityTimer();

    request.on('error', (err) => {
      aborted = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      // On ne relance pas l'erreur ici (elle serait non catchée) ; le reject se
      // fait via _reject dans le wrapper Promise plus bas.
      const e = timeoutFired ? new Error('timeout') : err;
      if (request._reject) request._reject(e);
    });

    request.on('response', (res) => {
      if (res.statusCode && res.statusCode !== 200) {
        let errorBody = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { errorBody += c; });
        res.on('end', () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          aborted = true;
          const detail = errorBody ? ` — ${errorBody.substring(0, 200)}` : '';
          request.emit('error', new Error(`HTTP_${res.statusCode}${detail}`));
        });
        return;
      }
      res.setEncoding('utf8');
      let sseBuffer = '';
      res.on('data', (chunk) => {
        resetInactivityTimer();
        if (!streamingStarted) {
          spinner.beginStreaming();
          streamingStarted = true;
        }
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content;
            const reasoning = j.choices?.[0]?.delta?.reasoning_content;
            const modelName = j.model;
            if (delta) {
              fullContent += delta;
              tokenCount++;
              spinner.updateTokens(tokenCount, fullContent.length);
              spinner.appendStreamChunk(delta, 'content');
            }
            if (reasoning) {
              reasoningContent += reasoning;
              tokenCount++;
              spinner.updateTokens(tokenCount, reasoningContent.length);
              spinner.appendStreamChunk(reasoning, 'reasoning');
            }
            if (modelName && !spinner._modelName) {
              spinner._modelName = modelName;
              responseModelName = modelName;
            }
          } catch (_) {}
        }
      });
      res.on('end', () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (streamingStarted) spinner.endStreaming();
        if (!fullContent.trim() && reasoningContent.trim()) {
          fullContent = reasoningContent;
        }
        const duration = Date.now() - startTime;
        logger.apiRequest(tierId, duration, 'OK');
        logger.info(`API Tier ${tierId} : réponse reçue en ${duration}ms (${tokenCount} chunks, ${fullContent.length} chars).`);
        // Benchmarking intégré (§2) : enregistre latence + tokens pour ce modèle.
        benchMetrics.record({
          modelName: responseModelName || 'Modele_Local',
          durationMs: duration,
          tokens: tokenCount,
          tierId,
          status: 'OK'
        });
        request._resolve({ content: fullContent.trim(), tokenCount, modelName: responseModelName || "Modele_Local" });
      });
      res.on('error', (e) => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        request._reject(timeoutFired ? new Error('timeout') : e);
      });
    });

    // Promise wrapper : on attend la fin du streaming (res 'end') ou une erreur.
    const result = await new Promise((resolve, reject) => {
      request._resolve = resolve;
      request._reject = reject;
      request.write(bodyStr);
      request.end();
    });

    return { content: result.content, modelName: result.modelName };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isTimeout = error.message === 'timeout' || error.name === 'AbortError';
    const reason = isTimeout
      ? `Timeout après ${timeoutMs / 1000}s — le modèle n'a pas répondu dans le délai imparti`
      : error.message;

    // Journalisation détaillée pour diagnostic futur (chaque échec API est tracé
    // avec son code, sa durée et le tier concerné — permet de corréler les bugs
    // aux logs LM Studio et aux timeouts undici).
    const isUnreachable = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/.test(error.code || error.message || '');
    const isHttpErr = /^HTTP_\d+/.test(error.message || '');
    const code = isTimeout ? 'E502_LM_TIMEOUT'
      : isUnreachable ? 'E503_LM_UNREACHABLE'
      : isHttpErr ? 'E504_LM_HTTP_ERROR'
      : 'E504_LM_HTTP_ERROR';
    logger.apiRequest(tierId || '?', duration, 'ERREUR');
    logger.error(`API Tier ${tierId} — code=${code} — raison=${reason}`);
    // Benchmarking intégré (§2) : enregistre l'échec pour le taux d'erreur.
    benchMetrics.record({
      modelName: (spinner && spinner._modelName) || 'Modele_Local',
      durationMs: duration,
      tokens: 0,
      tierId,
      status: isTimeout ? 'TIMEOUT' : 'ERREUR'
    });

    if (isMandatory) {
      // Erreur code-court : propagée au runner qui l'affichera proprement (sans
      // stack brute par défaut) et la journalisera. On ne fait plus process.exit
      // ici — le handler global de main() gère la sortie.
      throw new BenchgoError(code, `Tier ${tierId} (obligatoire) — ${reason}`);
    } else {
      console.error(`\n  \x1b[33m[WARN ${code}]\x1b[0m API Tier ${tierId} échoué (optionnel) : ${reason}`);
      logger.warn(`API Tier ${tierId} (optionnel) ignoré — ${code} — ${reason}`);
      return null;
    }
  }
}

module.exports = { queryLLM };