// tests/test-teacher-menu.js — Menu interactif du professeur correcteur
// (demande 2026-11-15 : le professeur n'est plus limité à OpenRouter — menu
// numéroté partagé par TOUS les modes CLI, cf. AGENTS.md).
// Tests PUREMENT hors-TTY : catalogue + chargement des modules. Les prompts
// interactifs (questionnaire étape 7, menus night-batch/frontier-batch) ne
// peuvent pas être testés ici sans TTY — les module-loads vérifient au moins
// qu'aucun side-effect ne casse au require.
const assert = require('assert');
const { TEACHER_PROVIDERS_MENU, askTeacherSelection } = require('../startup-questionnaire');

const cases = [
  { name: 'menu professeur : 14 entrées, openrouter premier, aucun dernier' },
  { name: 'menu professeur : locaux et kilo présents (demande « Ollama ou d_autres »)' },
  { name: 'menu professeur : non-openrouter doté d_un modèle par défaut + example' },
  { name: 'menu professeur : option aucun (none) → pas de modèle par défaut' },
  { name: 'ollama-cloud (abonnement) distinct du local : clé requise, pas local' },
  { name: 'askTeacherSelection exportée et async (menus night-batch/frontier-batch)' },
  { name: 'module questionnaire se charge sans side-effect (require OK)' },
];

function run(c) {
  switch (c.name) {
    case 'menu professeur : 14 entrées, openrouter premier, aucun dernier': {
      assert.strictEqual(TEACHER_PROVIDERS_MENU.length, 14);
      assert.strictEqual(TEACHER_PROVIDERS_MENU[0].value, 'openrouter');
      assert.strictEqual(TEACHER_PROVIDERS_MENU[0].none, false);
      const last = TEACHER_PROVIDERS_MENU[TEACHER_PROVIDERS_MENU.length - 1];
      assert.strictEqual(last.value, 'aucun');
      assert.strictEqual(last.none, true);
      break;
    }
    case 'menu professeur : locaux et kilo présents (demande « Ollama ou d_autres »)': {
      const values = TEACHER_PROVIDERS_MENU.map(p => p.value);
      for (const v of ['groq', 'openai', 'anthropic', 'together', 'mistral', 'deepseek', 'cohere', 'kilo', 'ollama-cloud', 'ollama', 'lmstudio', 'custom', 'aucun']) {
        assert.ok(values.includes(v), `fournisseur manquant au menu : ${v}`);
      }
      for (const local of ['ollama', 'lmstudio', 'custom']) {
        const spec = TEACHER_PROVIDERS_MENU.find(p => p.value === local);
        assert.strictEqual(spec.local, true, `${local} doit être marqué local (sans clé)`);
      }
      const cloud = TEACHER_PROVIDERS_MENU.filter(p => p.value !== 'aucun' && !['ollama', 'lmstudio', 'custom'].includes(p.value));
      assert.ok(cloud.every(p => p.local === false), 'tout fournisseur cloud doit exiger une clé');
      break;
    }
    case 'menu professeur : non-openrouter doté d_un modèle par défaut + example': {
      // Pour tout provider != openrouter, teacher-client.js EXIGE un modèle :
      // le menu doit donc proposer un défaut (cloud) ou un exemple (locaux).
      for (const p of TEACHER_PROVIDERS_MENU) {
        if (p.value === 'aucun') continue;
        if (p.value === 'openrouter') continue; // Free Router : pas de choix de modèle
        assert.ok(String(p.example).length > 0, `${p.value} doit avoir un example`);
        if (p.local) {
          assert.strictEqual(p.defaultModel, '', `${p.value} (local) : le nom de modèle est spécifique à la machine → pas de defaultModel`);
        } else {
          assert.ok(String(p.defaultModel).length > 0, `${p.value} (cloud) doit avoir un defaultModel`);
        }
      }
      break;
    }
    case 'menu professeur : option aucun (none) → pas de modèle par défaut': {
      const none = TEACHER_PROVIDERS_MENU.find(p => p.none === true);
      assert.strictEqual(none.value, 'aucun');
      assert.strictEqual(none.defaultModel, '');
      assert.strictEqual(none.local, false);
      break;
    }
    case 'ollama-cloud (abonnement) distinct du local : clé requise, pas local': {
      // Demande utilisateur 2026-11-15 : « Ollama en abonnement avec une clé
      // API, ça existe » — le menu distingue ollama (LOCAL, sans clé) et
      // ollama-cloud (ABONNEMENT, clé API), et cloud-client route le POST
      // vers https://ollama.com (pas localhost:11434).
      const oc = TEACHER_PROVIDERS_MENU.find(p => p.value === 'ollama-cloud');
      assert.ok(oc, 'ollama-cloud doit exister au menu');
      assert.strictEqual(oc.local, false);
      const { CLOUD_PROVIDERS } = require('../cloud-client');
      const spec = CLOUD_PROVIDERS['ollama-cloud'];
      assert.ok(spec, 'ollama-cloud doit exister dans CLOUD_PROVIDERS (routing professeur + élève)');
      assert.strictEqual(spec.requiresAuth, true);
      assert.strictEqual(spec.openaiCompat, true);
      assert.ok(spec.url.startsWith('https://ollama.com'), spec.url);
      assert.notStrictEqual(spec.url, CLOUD_PROVIDERS.ollama.url);
      break;
    }
    case 'askTeacherSelection exportée et async (menus night-batch/frontier-batch)': {
      assert.strictEqual(typeof askTeacherSelection, 'function');
      assert.strictEqual(askTeacherSelection.constructor.name, 'AsyncFunction');
      break;
    }
    case 'module questionnaire se charge sans side-effect (require OK)': {
      const sq = require('../startup-questionnaire');
      assert.strictEqual(typeof sq.runStartupQuestionnaire, 'function');
      assert.strictEqual(typeof sq.askTeacherSelection, 'function');
      assert.ok(Array.isArray(sq.TEACHER_PROVIDERS_MENU) && sq.TEACHER_PROVIDERS_MENU.length > 0);
      break;
    }
    default:
      throw new Error(`Cas inconnu : ${c.name}`);
  }
}

module.exports = { run, cases };
