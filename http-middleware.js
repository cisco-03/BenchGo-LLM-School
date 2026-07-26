// http-middleware.js — Middleware « clinique » de résilience HTTP.
//
// Plan §2 (Performance / Fiabilité) : wrapper timeout + retry (backoff
// exponentiel) + fallback modèle secondaire, applicable à lm-studio-client.js
// et teacher-client.js. Centralise la politique de retry pour qu'elle soit
// cohérente entre les deux clients et qu'on puisse l'ajuster en un seul endroit.
//
// Politique :
//   • Timeout par requête (configurable, défaut API_TIMEOUT_MS).
//   • Retry avec backoff exponentiel : 1s, 2s, 4s... (capé à 30s).
//   • Critères de retry : timeout, 429 (rate limit), 5xx (serveur). On NE
//     retry PAS sur 401/403 (clé invalide) ni 404 (modèle inexistant).
//   • Fallback : si tous les retries échouent et qu'un modèle secondaire est
//     fourni, on réessaie UNE fois avec le fallback (utile pour le Free Router
//     OpenRouter : rotate vers un autre modèle gratuit).
//
// Tout est journalisé : chaque tentative, chaque retry, chaque fallback, avec
// le code d'erreur et la durée — pour corréler les échecs aux logs serveur.

const logger = require('./logger');
const { BenchgoError } = require('./cli-help');

// Attend ms millisecondes (utilisé pour le backoff).
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Détermine si une erreur justifie un retry.
//   true  → timeout, 429, 5xx, erreurs réseau (ECONNRESET, ECONNREFUSED...)
//   false → 401/403 (clé), 404 (modèle inexistant), erreurs logiques
function isRetryableError(err) {
  if (!err) return false;
  const msg = err.message || '';
  const status = err.httpStatus;
  // Timeout (notre wrapper ou AbortController)
  if (msg === 'timeout' || err.name === 'AbortError') return true;
  // Erreurs réseau
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  // HTTP status : 429 (rate limit) et 5xx (serveur) → retry
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Erreur HTTP_ générique (ex: LM Studio renvoie HTTP_500 dans le message)
  if (/HTTP_5\d\d/.test(msg)) return true;
  if (/HTTP_429/.test(msg)) return true;
  // 401/403/404 → pas de retry (clé invalide ou modèle inexistant)
  return false;
}

/**
 * Exécute une fonction async avec timeout, retry et fallback optionnel.
 *
 * @param {object} opts
 * @param {function} opts.fn - Fonction async à exécuter. Reçoit { attempt }.
 * @param {number} [opts.timeoutMs] - Timeout par tentative (défaut 60000).
 * @param {number} [opts.maxRetries] - Nombre max de retries (défaut 3).
 * @param {number} [opts.baseDelayMs] - Délai de base du backoff (défaut 1000).
 * @param {number} [opts.maxDelayMs] - Cap du backoff (défaut 30000).
 * @param {function} [opts.fallback] - Fonction async de repli (reçoit { attempt }).
 * @param {string} [opts.label] - Étiquette pour le logging (ex: "Teacher", "LM Studio").
 * @returns {Promise<*>} Résultat de fn ou de fallback.
 * @throws {BenchgoError} Si toutes les tentatives et le fallback échouent.
 */
async function withRetry(opts) {
  const {
    fn,
    timeoutMs = 60000,
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    fallback = null,
    label = 'HTTP'
  } = opts;

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      // Wrapper timeout : si fn ne résout pas avant timeoutMs, on rejette.
      const result = await Promise.race([
        fn({ attempt }),
        new Promise((_, reject) => setTimeout(
          () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
          timeoutMs
        ))
      ]);
      const dur = Date.now() - t0;
      if (attempt > 0) {
        logger.info('Middleware[' + label + ']: tentative ' + (attempt + 1) + ' réussie après retry (' + dur + 'ms)');
      }
      return result;
    } catch (err) {
      lastError = err;
      const dur = Date.now() - t0;
      logger.warn('Middleware[' + label + ']: tentative ' + (attempt + 1) + '/' + (maxRetries + 1) +
        ' échouée (' + dur + 'ms) — ' + (err.message || err));

      if (attempt < maxRetries && isRetryableError(err)) {
        // Backoff exponentiel : baseDelayMs * 2^attempt, capé à maxDelayMs.
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.info('Middleware[' + label + ']: retry dans ' + delay + 'ms (backoff exponentiel)');
        await sleep(delay);
        continue;
      }
      // Plus de retry ou erreur non retryable : on tente le fallback si dispo.
      break;
    }
  }

  // Fallback modèle secondaire (une seule tentative, sans retry supplémentaire).
  if (fallback) {
    logger.info('Middleware[' + label + ']: activation du fallback après ' + (maxRetries + 1) + ' tentative(s)');
    try {
      const result = await fallback({ attempt: 0 });
      logger.info('Middleware[' + label + ']: fallback réussi');
      return result;
    } catch (fbErr) {
      logger.error('Middleware[' + label + ']: fallback échoué — ' + (fbErr.message || fbErr));
      lastError = fbErr;
    }
  }

  // Toutes les tentatives ont échoué : on lève une BenchgoError propre.
  // Le code dépend de la nature de la dernière erreur.
  const code = (lastError && lastError.message === 'timeout')
    ? 'E502_LM_TIMEOUT'
    : (lastError && lastError.httpStatus)
      ? 'E504_LM_HTTP_ERROR'
      : 'E503_LM_UNREACHABLE';
  throw new BenchgoError(code, label + ' — ' + (lastError && lastError.message || 'échec inconnu'));
}

module.exports = {
  withRetry,
  isRetryableError,
  sleep
};