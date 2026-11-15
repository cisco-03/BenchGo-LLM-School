// tests/test-xss-serialization.js — Non-régression SEC-XSS-01 (protocole
// Admin/Tasks.md §4.4), implémentation P0 session 2026-11-15c.
// Preuves rejouées en test :
//   1. la charge `</script>` ne peut plus fermer le bloc <script> du classement
//      local (safeForScript neutralise <, >, &, backticks, ${, U+2028/2029) ;
//   2. la sérialisation reste ROND-FIABLE : les données neutralisées reprennent
//      EXACTEMENT leurs valeurs après parsing (aucune corruption du classement) ;
//   3. le HTML généré (buildLeaderboardHTML, intégration) ne contient plus la
//      balise script injectée ni le marqueur d'exécution.
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { safeForScript, isValidShortName } = require('../score-ledger');

const PAYLOAD = '</script><script>globalThis.__BENCHGO_XSS__=true</script>';

const cases = [
  { name: 'sérialisation: la fermeture </script> est neutralisée' },
  { name: 'sérialisation: backticks et ${} neutralisés (template literal)' },
  { name: 'sérialisation: U+2028/U+2029 neutralisés' },
  { name: 'sérialisation: rond-fiable (aucune corruption du classement)' },
  { name: 'intégration: buildLeaderboardHTML ne contient plus la balise injectée' },
  { name: 'intégration: le marqueur __BENCHGO_XSS__ reste inerte dans le HTML' }
];

function injectScriptPayload(entry) {
  // Utilise le MÊME site d'injection que classement.html :
  //   var MODELS = ${safeForScript(JSON.stringify(modelsData))};
  const line = 'var MODELS = ' + safeForScript(JSON.stringify(entry)) + ';';
  return line;
}

// Crée un carnet de sonde jetable (nom unique, supprimé ensuite — cf. §2.2 du
// protocole : aucun carnet réel n'est touché) pour que buildLeaderboardHTML
// trouve le ledger "rapport intégral" comme dans un run réel.
const PROBE_SHORTNAME = 'security-probe-xss';
function withProbeCarnet(fn) {
  const { LEDGER_DIR } = require('../score-ledger');
  const probeFile = path.join(LEDGER_DIR, PROBE_SHORTNAME + '.json');
  const existed = fs.existsSync(probeFile);
  if (!existed) {
    fs.writeFileSync(probeFile, JSON.stringify({
      model: 'Probe Model', shortName: PROBE_SHORTNAME,
      displayName: PAYLOAD, note: 'sonde non destructive',
      ecoles: {}, lastUpdated: null
    }), 'utf8');
  }
  try {
    return fn();
  } finally {
    if (!existed) {
      try { fs.unlinkSync(probeFile); } catch (_) {}
    }
  }
}

function buildHostileEntry() {
  return {
    shortName: PROBE_SHORTNAME, model: 'Probe Model',
    displayName: null, // la donnée hostile vit dans le carnet de la sonde
    quantization: null, provider: null, isCloud: false,
    pct: 50, score: 5, max: 10, mandatoryPct: 50, mandatoryTotal: 2,
    optionalBonus: 0, globalLifeScore: 0,
    tokens: 100, elapsedMs: 1000, tokensPerSecond: 100,
    ecoleCount: 1, lastUpdated: null,
    ecoles: [{ ecole: 'Primaire (LIGHT)', pct: 50, score: 5, max: 10,
               calibrationIndex: null, tokens: 100, elapsedMs: 1000,
               tokensPerSecond: 100, promptTokens: 0, completionTokens: 0,
               helpCount: 0, retriedCount: 0, date: '2026-11-15', tiers: [] }],
    trend: null, runCode: null
  };
}

function run(c) {
  switch (c.name) {
    case 'sérialisation: la fermeture </script> est neutralisée': {
      const hostile = [{ displayName: PAYLOAD, model: '<img src=x onerror=alert(1)>', note: 'a & b' }];
      const line = injectScriptPayload(hostile);
      // Du point de vue du parseur HTML : AUCUNE fermeture de bloc + AUCUNE
      // nouvelle balise <script> ouverte par une donnée.
      assert.ok(!line.includes('</script>'), 'la charge brute ne doit plus apparaître');
      assert.ok(!line.includes('<script>') || line.indexOf('var MODELS') > line.indexOf('<script>'), 'la donnée ne doit pas ouvrir de balise');
      assert.ok(line.includes('\\u003c/script\\u003e\\u003cscript\\u003e'), 'neutralisation unicode attendue : ' + line.substring(0, 200));
      break;
    }
    case 'sérialisation: backticks et ${} neutralisés (template literal)': {
      const hostile = [{ note: 'a`b${malicious}c', model: 'x' }];
      const line = injectScriptPayload(hostile);
      assert.ok(!line.includes('`'), 'backtick brut interdit');
      assert.ok(!line.includes('${'), 'template-expression interdite');
      break;
    }
    case 'sérialisation: U+2028/U+2029 neutralisés': {
      const hostile = [{ note: 'a\u2028b\u2029c', model: 'x' }];
      const line = injectScriptPayload(hostile);
      assert.ok(!line.includes('\u2028') && !line.includes('\u2029'), 'séparateurs de ligne neutralisés');
      break;
    }
    case 'sérialisation: rond-fiable (aucune corruption du classement)': {
      // La donnée neutralisée doit EXACTEMENT revenir après parsing : le
      // classement reste fidèle (aucune corruption des noms/notes).
      const original = [{ displayName: PAYLOAD, note: 'a & b`c${d}e\u2028f', model: 'model-1', pct: 42 }];
      const line = injectScriptPayload(original);
      // Exécute la ligne au TOP-LEVEL du contexte vm : simule <script> consommé
      // par un navigateur (sans DOM, le marqueur est simplement assigné).
      const sandbox = {};
      vm.createContext(sandbox);
      vm.runInContext(line, sandbox);
      const back = vm.runInContext('MODELS', sandbox);
      assert.strictEqual(back[0].displayName, PAYLOAD, 'rond-fiable exact');
      assert.strictEqual(back[0].note, 'a & b`c${d}e\u2028f');
      assert.strictEqual(back[0].pct, 42);
      break;
    }
    case 'intégration: buildLeaderboardHTML ne contient plus la balise injectée': {
      // buildLeaderboardHTML est exportée — entrée hostile réelle, HTML fini.
      const lb = require('../leaderboard');
      const entry = buildHostileEntry();
      let html;
      try {
        html = withProbeCarnet(() => lb.buildLeaderboardHTML([entry]));
      } catch (e) {
        throw new Error('buildLeaderboardHTML doit accepter une entrée hostile : ' + e.message);
      }
      assert.ok(html.includes('var MODELS'), 'sanity : les données sont bien sérialisées');
      // La séquence fatale — fermer le bloc script + en rouvrir un — est morte.
      assert.ok(!html.includes('</script><script>globalThis.__BENCHGO_XSS__'),
        'la charge doit être neutralisée dans le HTML final');
      // La LIGNE de sérialisation (une seule ligne du template) : aucune
      // fermeture de bloc possible depuis une donnée.
      const modelesLineStart = html.indexOf('var MODELS');
      const modelesLine = html.substring(modelesLineStart, html.indexOf('\n', modelesLineStart));
      assert.ok(!modelesLine.includes('</script>'), 'aucune donnée ne peut fermer le bloc MODELS : ' + modelesLine.substring(0, 200));
      break;
    }
    case 'intégration: le marqueur __BENCHGO_XSS__ reste inerte dans le HTML': {
      const lb = require('../leaderboard');
      const html = withProbeCarnet(() => lb.buildLeaderboardHTML([buildHostileEntry()]));
      // Même si un navigateur exécutait les autres blocs, la charge ne peut pas
      // émerger sous forme de balise : elle n'existe qu'en données échappées.
      const execStart = html.indexOf('<script>globalThis.__BENCHGO_XSS__');
      assert.strictEqual(execStart, -1, 'aucune balise exécutable générée par la charge');
      // La donnée n'est présente que sous forme unicode-échappée.
      assert.ok(html.includes('\\u003c/script\\u003e'), 'la donnée reste une DATA échappée');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { run, cases };
