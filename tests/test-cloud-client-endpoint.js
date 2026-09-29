// tests/test-cloud-client-endpoint.js — Tests de normalizeCompletionsUrl (tâche 2026-09-29).
// Cas déclencheur : base URL "https://ollama.com/v1" collée verbatim → POST
// sur /v1 → HTTP 405 "Method Not Allowed" (logs benchgo_2026-09-29T13-00/13-02).
const assert = require('assert');
const { normalizeCompletionsUrl } = require('../cloud-client');

const cases = [
  { name: 'base /v1 → /v1/chat/completions' },
  { name: 'base /v1 déjà complète → inchangée' },
  { name: 'base /v1/chat → complétée' },
  { name: 'Kilo gateway complet → inchangé' },
  { name: 'Anthropic /v1/messages → inchangé' },
  { name: 'slash final → normalisé' },
  { name: 'chemin arbitraire → complété' },
  { name: 'non-string → renvoyé tel quel' },
];

function run(c) {
  switch (c.name) {
    case 'base /v1 → /v1/chat/completions':
      assert.strictEqual(normalizeCompletionsUrl('https://ollama.com/v1'), 'https://ollama.com/v1/chat/completions');
      break;
    case 'base /v1 déjà complète → inchangée':
      assert.strictEqual(normalizeCompletionsUrl('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');
      break;
    case 'base /v1/chat → complétée':
      assert.strictEqual(normalizeCompletionsUrl('https://api.exemple.com/v1/chat'), 'https://api.exemple.com/v1/chat/completions');
      break;
    case 'Kilo gateway complet → inchangé':
      assert.strictEqual(normalizeCompletionsUrl('https://api.kilo.ai/api/gateway/chat/completions'), 'https://api.kilo.ai/api/gateway/chat/completions');
      break;
    case 'Anthropic /v1/messages → inchangé':
      assert.strictEqual(normalizeCompletionsUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/messages');
      break;
    case 'slash final → normalisé':
      assert.strictEqual(normalizeCompletionsUrl('https://ollama.com/v1/'), 'https://ollama.com/v1/chat/completions');
      break;
    case 'chemin arbitraire → complété':
      assert.strictEqual(normalizeCompletionsUrl('https://host.tld/api/gateway'), 'https://host.tld/api/gateway/chat/completions');
      break;
    case 'non-string → renvoyé tel quel':
      assert.strictEqual(normalizeCompletionsUrl(null), null);
      break;
  }
}

module.exports = { run, cases };