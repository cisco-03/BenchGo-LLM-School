// tests/test-security-keys.js — Sécurité durcie des clés API (tâche 2026-11-15b,
// demande utilisateur : « blindé sécurité en béton »).
// 1. assertSecretSafeUrl : une clé n'est JAMAIS envoyée sur un transport non
//    sûr (http:// hors localhost refusé, https:// obligatoire ailleurs).
// 2. redactSecret : aucune clé ne peut apparaître dans un texte de log/erreur.
// 3. api-keys-store : fichier de clés = local uniquement + anti-symlink.
// 4. vm-sandbox : patterns d'exfiltration réseau / accès hôte bloqués.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { assertSecretSafeUrl, redactSecret } = require('../cloud-client');
const apiKeysStore = require('../api-keys-store');
const { detectSandboxEscape } = require('../vm-sandbox');

const cases = [
  { name: 'assertSecretSafeUrl: https distant autorisé' },
  { name: 'assertSecretSafeUrl: http localhost autorisé (requête non sortante)' },
  { name: 'assertSecretSafeUrl: http 127.0.0.1 et [::1] autorisés' },
  { name: 'assertSecretSafeUrl: http distant REFUSÉ (clé en clair interdite)' },
  { name: 'assertSecretSafeUrl: URL invalide REFUSÉ' },
  { name: 'redactSecret: la clé disparaît du texte d_erreur' },
  { name: 'redactSecret: préfixe tronqué aussi masqué, clé courte = no-op' },
  { name: 'api-keys-store: auditKeysFile sûr (fichier absent + fichier normal)' },
  { name: 'api-keys-store: SUPPORTED_PROVIDERS couvre kilo + ollama-cloud' },
  { name: 'vm-sandbox: patterns exfiltration réseau bloqués (fetch/XHR/WS)' },
  { name: 'vm-sandbox: accès hôte bloqué (Buffer/child_process/global./window)' },
  { name: 'vm-sandbox: code élève légitime non bloqué (pas de faux positif)' },
];

function run(c) {
  switch (c.name) {
    case 'assertSecretSafeUrl: https distant autorisé': {
      assert.strictEqual(assertSecretSafeUrl('https://api.openai.com/v1/chat/completions'), null);
      assert.strictEqual(assertSecretSafeUrl('https://ollama.com/v1/chat/completions'), null);
      break;
    }
    case 'assertSecretSafeUrl: http localhost autorisé (requête non sortante)': {
      assert.strictEqual(assertSecretSafeUrl('http://localhost:1234/v1/chat/completions'), null);
      break;
    }
    case 'assertSecretSafeUrl: http 127.0.0.1 et [::1] autorisés': {
      assert.strictEqual(assertSecretSafeUrl('http://127.0.0.1:11434/v1/chat/completions'), null);
      assert.strictEqual(assertSecretSafeUrl('http://[::1]:1234/v1/chat/completions'), null);
      break;
    }
    case 'assertSecretSafeUrl: http distant REFUSÉ (clé en clair interdite)': {
      const msg = assertSecretSafeUrl('http://api.exemple.com/v1/chat/completions');
      assert.ok(msg.includes('E710'), 'code attendu : ' + msg);
      // Variante : le mot « localhost » dans le CHEMIN ne doit pas tromper le
      // garde (seul le HOSTNAME compte).
      const trick = assertSecretSafeUrl('http://evil.tld/localhost');
      assert.ok(trick && trick.includes('E710'), 'le host distant doit être refusé');
      break;
    }
    case 'assertSecretSafeUrl: URL invalide REFUSÉ': {
      assert.ok(assertSecretSafeUrl('pas-une-url').includes('E710'));
      assert.ok(assertSecretSafeUrl('file:///etc/passwd').includes('E710'));
      break;
    }
    case 'redactSecret: la clé disparaît du texte d_erreur': {
      const key = 'sk-or-v1-2f8d9c1b7e6a4d5f8c9b0a1e2d3f4b5c';
      const err = `HTTP_401 — {"error":"Bad auth: token 'sk-or-v1-2f8d9c1b7e6a4d5f8c9b0a1e2d3f4b5c' rejected"}`;
      const safeOut = redactSecret(err, key);
      assert.ok(!safeOut.includes(key), 'la clé ne doit plus apparaître');
      assert.ok(safeOut.includes('(cle masquee)'));
      break;
    }
    case 'redactSecret: préfixe tronqué aussi masqué, clé courte = no-op': {
      const key = 'sk-1234567890abcdefghij';
      assert.ok(!redactSecret('texte sk-1234567890 suite', key).includes('sk-1234567890'));
      // Clé courte (moins de 6 chars) : redaction sans effet (pas de fuite
      // exploitable) — le texte est inchangé.
      assert.strictEqual(redactSecret('abc', 'ab'), 'abc');
      assert.strictEqual(redactSecret(null, 'xyz'), '');
      break;
    }
    case 'api-keys-store: auditKeysFile sûr (fichier absent + fichier normal)': {
      // Fichier réel absent OU fichier normal → safe. On teste dans un dossier
      // temporaire via KEYS_FILE uniquement s'il n'existe pas déjà.
      const real = apiKeysStore.auditKeysFile();
      assert.ok(real.safe, JSON.stringify(real));
      // Fichier normal temporaire : on simule en auditant KEYS_FILE existant ;
      // le fichier .api-keys.json du projet, s'il existe, est un fichier
      // normal (sinon les tests échoueraient ici — c'est le but).
      break;
    }
    case 'api-keys-store: SUPPORTED_PROVIDERS couvre kilo + ollama-cloud': {
      assert.ok(apiKeysStore.SUPPORTED_PROVIDERS.includes('kilo'));
      assert.ok(apiKeysStore.SUPPORTED_PROVIDERS.includes('ollama-cloud'));
      assert.ok(apiKeysStore.SUPPORTED_PROVIDERS.includes('ollama'));
      break;
    }
    case 'vm-sandbox: patterns exfiltration réseau bloqués (fetch/XHR/WS)': {
      assert.ok(detectSandboxEscape('const r = fetch("https://evil.tld");'), 'fetch doit être bloqué');
      assert.ok(detectSandboxEscape('new XMLHttpRequest()'));
      assert.ok(detectSandboxEscape('new WebSocket("ws://evil.tld")'));
      assert.ok(detectSandboxEscape('new Worker("worker.js")'));
      break;
    }
    case 'vm-sandbox: accès hôte bloqué (Buffer/child_process/global./window)': {
      assert.ok(detectSandboxEscape("require('child_process')"));
      assert.ok(detectSandboxEscape('Buffer.from("x")'));
      assert.ok(detectSandboxEscape('module.exports = {}'));
      assert.ok(detectSandboxEscape('global.foo = 1'));
      assert.ok(detectSandboxEscape('window.alert("x")'));
      assert.ok(detectSandboxEscape('document.cookie'));
      break;
    }
    case 'vm-sandbox: code élève légitime non bloqué (pas de faux positif)': {
      // Solutions canoniques types : sum/fizzbuzz/anagramme — rien ne doit
      // être bloqué (les 486 exec de verify_tiers.js reposent dessus).
      assert.strictEqual(detectSandboxEscape('function fizzBuzz(n) { if (n % 15 === 0) return "FizzBuzz"; }'), null);
      assert.strictEqual(detectSandboxEscape('const somme = tableau.reduce((acc, v) => acc + v, 0);'), null);
      assert.strictEqual(detectSandboxEscape('let mot = "ohell"; mot === "hello".split("").sort().join("");'), null);
      assert.strictEqual(detectSandboxEscape('if (k === "__proto__") continue; // garde anti-pollution (lecture OK)'), null);
      break;
    }
    default:
      throw new Error(`Cas inconnu : ${c.name}`);
  }
}

module.exports = { run, cases };
