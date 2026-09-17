// tests/test-gguf-tracker.js — Tests du GGUF Tracker (tâche 2026-09-17).
//
// Trois niveaux :
// - Tests UNITAIRES : fonctions de filtrage/rapprochement/tri extraites du
//   tracker (isLLMGGUFModel, normalizeModelName, isModelTested, parseParamsB,
//   sortRawModels, applyFilters) évaluées sur des objets HF factices.
// - Tests d'INTEGRATION : appels réels à l'API Hugging Face (pagination curseur,
//   paramètre filter=gguf, recherche search=+filter=gguf, tri lastModified) —
//   réseau requis, sinon échec avec mention (le framework est synchrone : les
//   vérifications réseau sont lancées au chargement du module, AVANT run()).
// - Tests SYSTEME : validation du fichier scripts/gguf-tracker.html lui-même
//   (syntaxe JS inline via vm.Script, absence de paramètres API cassés type
//   offset/library=, présence du sélecteur de tri et de la recherche serveur).
//
// Usage : node tests/run-tests.js  (ce fichier est auto-découvert par le lanceur)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Extraction du JS inline du tracker pour les tests unitaires (fonctions pures).
// ---------------------------------------------------------------------------
const TRACKER_PATH = path.join(__dirname, '..', 'scripts', 'gguf-tracker.html');

function extractInlineJs() {
  const html = fs.readFileSync(TRACKER_PATH, 'utf8');
  const s = html.indexOf('<script>') + '<script>'.length;
  const e = html.lastIndexOf('</script>');
  return html.substring(s, e);
}

// Contexte minimal : localStorage + window + document factices.
function makeSandboxContext() {
  const store = {};
  const els = {};
  function fakeEl(id) {
    if (!els[id]) {
      els[id] = {
        id,
        value: '',
        checked: false,
        innerText: '',
        innerHTML: '',
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener() {},
        setAttribute() {},
        appendChild() {},
      };
    }
    return els[id];
  }
  const ctx = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    window: { addEventListener() {} },
    document: {
      getElementById: fakeEl,
      addEventListener() {},
      createDocumentFragment() { return { appendChild(el) { (this.children = this.children || []).push(el); } }; },
      createElement() { return fakeEl('_tmp'); },
      body: { appendChild() {}, removeChild() {} },
    },
    navigator: {},
    fetch: () => Promise.resolve({ ok: false, status: 0, headers: { get() { return null; } }, json: () => Promise.resolve([]) }),
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  ctx.window.localStorage = ctx.localStorage;
  return ctx;
}

function loadTrackerFunctions() {
  let src = extractInlineJs();
  // Les variables d'état sont déclarées avec `let` (binding lexical invisible
  // depuis le global du contexte vm) : on les convertit en `var` pour que les
  // tests puissent les lire/écrire via ctx.<nom>. Seul l'état mutable est
  // concerné ; les const de config restent inchangées.
  src = src.replace(/\blet (rawModels|newModelsSet|testedModels|filteredCache)\b/g, 'var $1');
  const ctx = makeSandboxContext();
  vm.createContext(ctx);
  try {
    // timeout : tue l'évaluation si le script extrait boucle (regex
    // catastrophique, parsing infini) — protection validée (addendum Gemini).
    vm.runInContext(src, ctx, { timeout: 5000 });
  } catch (e) {
    // Le script de démarrage appelle loadModels() (fetch factice) : les erreurs
    // asynchrones n'entravent pas l'extraction des fonctions déclarées.
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Vérifications réseau (intégration). Le framework run-tests.js est synchrone
// (run(c) sans await) : les appels réels à l'API HF sont exécutés dans un
// process enfant (spawnSync sur un script node inline) au premier cas réseau,
// puis relu depuis un fichier temporaire. Réseau indisponible → cas marqué
// échec avec mention (jamais faux vert).
// ---------------------------------------------------------------------------
const NETWORK_FILE = path.join(require('os').tmpdir(), 'benchgo-tracker-network.json');
let NETWORK = null;

function runNetworkChecksOnce() {
  if (NETWORK) return NETWORK;
  const script = `
    const fs = require('fs');
    const BASE = 'https://huggingface.co/api/models';
    const out = { done: true, filterGguf: null, cursorPaging: null, searchServer: null, lastModifiedSort: null, errors: [] };
    (async () => {
      try {
        const r = await fetch(BASE + '?filter=gguf&sort=lastModified&direction=-1&limit=30');
        const d = await r.json();
        out.filterGguf = d.length > 0 && d.every(m => (m.tags || []).includes('gguf') || m.library_name === 'gguf');
        const link = r.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\\s*rel="next"/);
        if (m) {
          const r2 = await fetch(m[1]);
          const p2 = await r2.json();
          out.cursorPaging = p2.length > 0 && d[0].id !== p2[0].id;
        } else {
          out.cursorPaging = null;
        }
        out.lastModifiedSort = d.every((mm, i) => i === 0 || new Date(d[i - 1].lastModified) >= new Date(mm.lastModified));
        const rs = await fetch(BASE + '?filter=gguf&search=' + encodeURIComponent('gemma') + '&sort=lastModified&direction=-1&limit=10');
        const ds = await rs.json();
        out.searchServer = ds.length > 0 && ds.every(mm => (mm.tags || []).includes('gguf') || mm.library_name === 'gguf');
      } catch (e) {
        out.errors.push(e.message);
      }
      fs.writeFileSync(process.argv[2], JSON.stringify(out));
    })();
  `;
  const tmpScript = path.join(require('os').tmpdir(), 'benchgo-tracker-network-check.js');
  fs.writeFileSync(tmpScript, script);
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [tmpScript, NETWORK_FILE], { timeout: 60000, encoding: 'utf8' });
  try {
    NETWORK = JSON.parse(fs.readFileSync(NETWORK_FILE, 'utf8'));
  } catch (e) {
    NETWORK = { done: true, filterGguf: null, cursorPaging: null, searchServer: null, lastModifiedSort: null, errors: ['process enfant échec : ' + (res.error ? res.error.message : (res.stderr || 'sortie vide'))] };
  }
  return NETWORK;
}

function expectNetwork(key, label) {
  const net = runNetworkChecksOnce();
  if (net.errors.length && net[key] === null) {
    throw new Error(label + ' : réseau indisponible (' + net.errors.join('; ') + ')');
  }
  assert.strictEqual(net[key], true, label + ' : échec (voir details ci-dessous)');
}

// ---------------------------------------------------------------------------
// Cas de test
// ---------------------------------------------------------------------------
const cases = [
  {
    name: 'unitaire : isLLMGGUFModel rejette les repos non-GGUF (library safetensors, pipeline vision)',
    fn() {
      const ctx = loadTrackerFunctions();
      const f = ctx.isLLMGGUFModel;
      assert.strictEqual(f({ id: 'a/b', tags: ['safetensors'], pipeline_tag: 'object-detection' }), false);
      assert.strictEqual(f({ id: 'a/b', tags: ['safetensors', 'region:us'], library_name: 'safetensors' }), false);
      assert.strictEqual(f({ id: 'a/b', tags: [], library_name: null }), false);
    },
  },
  {
    name: 'unitaire : isLLMGGUFModel accepte les vrais GGUF LLM',
    fn() {
      const ctx = loadTrackerFunctions();
      const f = ctx.isLLMGGUFModel;
      assert.strictEqual(f({ id: 'a/b-GGUF', tags: ['gguf', 'text-generation'], pipeline_tag: 'text-generation' }), true);
      assert.strictEqual(f({ id: 'a/b', tags: ['gguf', 'conversational'], pipeline_tag: null, library_name: 'gguf' }), true);
      assert.strictEqual(f({ id: 'a/b', tags: ['gguf', 'llama.cpp'], pipeline_tag: '' }), true);
    },
  },
  {
    name: 'unitaire : normalizeModelName enleve quantification et separateurs',
    fn() {
      const ctx = loadTrackerFunctions();
      const f = ctx.normalizeModelName;
      // Le strip des tokens (gguf, instruct, q4_k_m...) doit FONCTIONNER :
      // il s'exécute AVANT la suppression des séparateurs.
      assert.strictEqual(f('bartowski/Qwen2.5-7B-Instruct-GGUF'), 'bartowskiqwen257b');
      assert.strictEqual(f('Llama-3-8B-Q4_K_M-GGUF'), 'llama38b');
      assert.strictEqual(f('Modèle ÉéÀ GGUF'), 'modeleeea');
      assert.ok(!f('Llama-3-8B-Q4_K_M').includes('q4km'));
    },
  },
  {
    name: 'unitaire : isModelTested rapproche repo HF et nom de carnet',
    fn() {
      const ctx = loadTrackerFunctions();
      ctx.testedModels = new Set([ctx.normalizeModelName('Qwen2.5-7B-Instruct')]);
      assert.strictEqual(ctx.isModelTested('bartowski/Qwen2.5-7B-Instruct-GGUF'), true);
      assert.strictEqual(ctx.isModelTested('autor/Modele-Jamais-Vu-GGUF'), false);
    },
  },
  {
    name: 'unitaire : isModelTested retourne false quand aucun modele teste',
    fn() {
      const ctx = loadTrackerFunctions();
      ctx.testedModels = new Set();
      assert.strictEqual(ctx.isModelTested('bartowski/Qwen2.5-7B-Instruct-GGUF'), false);
    },
  },
  {
    name: 'unitaire : parseParamsB extrait les milliards de params',
    fn() {
      const ctx = loadTrackerFunctions();
      const f = ctx.parseParamsB;
      assert.strictEqual(f('Qwen2.5-7B-Instruct-GGUF'), 7);
      assert.strictEqual(f('gemma-4-12.5B-it'), 12.5);
      assert.strictEqual(f('mini-500M-v2'), 0.5);
      assert.strictEqual(f('sans-taille'), null);
    },
  },
  {
    name: 'unitaire : sortRawModels trie recent d abord puis ancien d abord',
    fn() {
      const ctx = loadTrackerFunctions();
      const sel = ctx.document.getElementById('sortSelect');
      const mk = (id, lm, dl) => ({ id, lastModified: lm, downloads: dl });
      ctx.rawModels = [
        mk('a/vieux', '2026-01-01T00:00:00Z', 10),
        mk('b/recent', '2026-09-17T00:00:00Z', 1),
        mk('c/moyen', '2026-05-05T00:00:00Z', 100),
      ];
      sel.value = 'recent';
      ctx.sortRawModels();
      assert.deepStrictEqual(ctx.rawModels.map(m => m.id), ['b/recent', 'c/moyen', 'a/vieux']);
      sel.value = 'ancien';
      ctx.sortRawModels();
      assert.deepStrictEqual(ctx.rawModels.map(m => m.id), ['a/vieux', 'c/moyen', 'b/recent']);
      sel.value = 'downloads';
      ctx.sortRawModels();
      assert.deepStrictEqual(ctx.rawModels.map(m => m.id), ['c/moyen', 'a/vieux', 'b/recent']);
    },
  },
  {
    name: 'unitaire : applyFilters applique newOnly et testedOnly',
    fn() {
      const ctx = loadTrackerFunctions();
      const mk = (id, lm) => ({ id, lastModified: lm, downloads: 5, tags: ['gguf', 'text-generation'], pipeline_tag: 'text-generation' });
      ctx.rawModels = [
        mk('aut/AAA-7B-GGUF', '2026-09-17T00:00:00Z'),
        mk('aut/BBB-3B-GGUF', '2026-09-16T00:00:00Z'),
      ];
      ctx.newModelsSet = new Set(['aut/AAA-7B-GGUF']);
      ctx.testedModels = new Set([ctx.normalizeModelName('BBB-3B')]);
      ctx.document.getElementById('sizeRange').value = '80';
      ctx.document.getElementById('searchInput').value = '';
      ctx.document.getElementById('newOnly').checked = true;
      ctx.applyFilters();
      assert.deepStrictEqual(ctx.filteredCache.map(m => m.id), ['aut/AAA-7B-GGUF']);
      ctx.document.getElementById('newOnly').checked = false;
      ctx.document.getElementById('testedOnly').checked = true;
      ctx.applyFilters();
      assert.deepStrictEqual(ctx.filteredCache.map(m => m.id), ['aut/BBB-3B-GGUF']);
    },
  },
  {
    name: 'systeme : le tracker n utilise plus le parametre offset (pagination curseur)',
    fn() {
      const src = extractInlineJs();
      assert.ok(!/offset=/.test(src), 'le paramètre offset ne fonctionne plus sur l\'API HF');
      assert.ok(/rel="next"/.test(src) && /cursor/i.test(src), 'pagination par curseur (header Link) attendue');
    },
  },
  {
    name: 'systeme : le tracker utilise filter=gguf (library= est ignore par l API)',
    fn() {
      const src = extractInlineJs();
      assert.ok(!/library=gguf/.test(src), 'library=gguf est ignoré par l\'API HF');
      assert.ok(/filter=gguf/.test(src), 'filter=gguf attendu dans les URL API');
    },
  },
  {
    name: 'systeme : le selecteur de tri et la recherche serveur existent',
    fn() {
      const src = extractInlineJs();
      assert.ok(/sortSelect/.test(src), 'selecteur de tri #sortSelect attendu');
      assert.ok(/lastModified/.test(src), 'tri par lastModified attendu');
      assert.ok(/fetchSearchPage/.test(src) && /search=/.test(src), 'recherche serveur (search= + filter=gguf) attendue');
      assert.ok(/serverSearchBtn/.test(src) && /onSearchInput/.test(src), 'bouton recherche serveur + gestionnaire de saisie attendus');
    },
  },
  {
    name: 'systeme : syntaxe JS inline valide (vm.Script)',
    fn() {
      const src = extractInlineJs();
      assert.doesNotThrow(() => new vm.Script(src), 'SyntaxError dans le JS inline du tracker');
    },
  },
  {
    name: 'integration : API HF filter=gguf renvoie uniquement des GGUF',
    fn() { expectNetwork('filterGguf', 'filter=gguf'); },
  },
  {
    name: 'integration : pagination curseur avance reellement (page 1 != page 2)',
    fn() { expectNetwork('cursorPaging', 'pagination curseur'); },
  },
  {
    name: 'integration : recherche serveur search=+filter=gguf renvoie des GGUF',
    fn() { expectNetwork('searchServer', 'recherche serveur'); },
  },
  {
    name: 'integration : tri lastModified descendant de l API respecte',
    fn() { expectNetwork('lastModifiedSort', 'tri lastModified'); },
  },
];

function run(c) {
  if (c.name.startsWith('integration')) {
    c.fn();
    return;
  }
  c.fn();
}

module.exports = { run, cases };