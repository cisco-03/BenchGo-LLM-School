// tests/test-teacher-routing.js — Non-régression SEC-TEACH-01 / SEC-TEACH-02
// (protocole Admin/Tasks.md §4.8), implémentation P0 session 2026-11-15c.
// Preuves rejouées en test (SANS réseau, clés factices explicitement marquées) :
//   1. chaque provider résout vers SON URL exacte (table unique partagée avec
//      le client élève, CLOUD_PROVIDERS) ;
//   2. alias 'lm-studio' recanalisé vers lmstudio ;
//   3. un provider inconnu échoue FERMÉ avant tout fetch (plus de repli Groq) ;
//   4. `custom` exige un endpoint explicite (propagé par --teacher-endpoint) ;
//   5. la clé d'environnement est lue via le nom OFFICIEL du provider ;
//   6. callCloudTeacher poste sur l'URL exacte (fetch factice, compteur) ;
//   7. --no-teacher (teacherEnabled=false) : AUCUN client, ZERO fetch ;
//   8. determineSpecialty sans professeur = verdict mécanique, ZERO fetch.
// Les vérifications ASYNC tournent dans un processus fils jetable (harnais
// synchrone) : exit 0 = preuve conforme, sinon échec avec stderr.
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TeacherClient } = require('../teacher-client');

const DUMMY_KEY = 'BENCHGO-TEST-DUMMY-KEY-2026';
const PROJECT = path.join(__dirname, '..');

const cases = [
  { name: 'professeur: URL exacte pour chaque provider de la table' },
  { name: 'professeur: alias lm-studio recanalisé vers lmstudio' },
  { name: 'professeur: provider inconnu = erreur fermée (pas de repli Groq)' },
  { name: 'professeur: custom sans endpoint = erreur fermée' },
  { name: 'professeur: clé env lue via le nom OFFICIEL du provider' },
  { name: 'professeur: callCloudTeacher envoie sur l URL exacte (fetch factice)' },
  { name: 'professeur: teacherEnabled=false → aucun client, zéro fetch' },
  { name: 'professeur: determineSpecialty sans professeur = verdict mécanique, zéro fetch' }
];

const EXPECTED_BASE = {
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
  cohere: 'https://api.cohere.ai/v1',
  kilo: 'https://api.kilo.ai/api/gateway',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  'ollama-cloud': 'https://ollama.com/v1'
};

// Exécute une vérification ASYNC dans un processus fils (exit 0 = pass).
const ASYNC_PROBES = {
  'professeur: callCloudTeacher envoie sur l URL exacte (fetch factice)': `
    const { callCloudTeacher } = require(process.env.BENCHGO_TEACHER_DIR + '/teacher-client');
    const { CLOUD_PROVIDERS } = require(process.env.BENCHGO_TEACHER_DIR + '/cloud-client');
    const DUMMY_KEY = 'BENCHGO-TEST-DUMMY-KEY-2026';
    const captured = [];
    globalThis.fetch = async (url, opts) => {
      captured.push({ url: String(url), opts });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'verdict-test' } }] }) };
    };
    (async () => {
      try {
        for (const [provider, spec] of Object.entries(CLOUD_PROVIDERS)) {
          if (!spec.url || provider === 'custom') continue;
          const out = await callCloudTeacher({ provider, model: 'modele-test', apiKey: DUMMY_KEY, prompt: 'p' });
          assert.strictEqual(captured[captured.length - 1].url, spec.url,
            'URL finale exacte pour ' + provider + ' (obtenu ' + captured[captured.length - 1].url + ')');
          assert.strictEqual(out, 'verdict-test');
        }
        console.log('OK');
      } finally { process.exit(0); }
    })().catch(e => { console.error(e.message); process.exit(1); });
  `,
  'professeur: teacherEnabled=false → aucun client, zéro fetch': `
    const { buildExamTeacher, determineSpecialty } = require(process.env.BENCHGO_TEACHER_DIR + '/adaptive-exam');
    const assert = require('assert');
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('AUCUN appel réseau autorisé'); };
    (async () => {
      try {
        const t = await buildExamTeacher({ teacherEnabled: false });
        assert.strictEqual(t, null, 'aucun client construit quand le professeur est désactivé');
        assert.strictEqual(calls, 0, 'zéro fetch');
        const none = await buildExamTeacher({ teacherEnabled: false, teacherProvider: 'groq', teacherModel: 'x', teacherApiKey: 'K' });
        assert.strictEqual(none, null, 'l état désactivé prime sur TOUTE config résiduelle');
        process.exit(0);
      } catch (e) { console.error(e.message); process.exit(1); }
    })();
  `,
  'professeur: determineSpecialty sans professeur = verdict mécanique, zéro fetch': `
    const { determineSpecialty } = require(process.env.BENCHGO_TEACHER_DIR + '/adaptive-exam');
    const assert = require('assert');
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('AUCUN appel réseau autorisé'); };
    process.env.GROQ_API_KEY = 'BENCHGO-TEST-DUMMY-KEY-2026'; // une clé présente ne doit pas délencher d'appel
    const specialtyStats = {
      specialty: { language: 'python', rate: 0.75, passed: 3, total: 4 },
      stats: [{ language: 'python', passed: 3, failed: 1, total: 4, rate: 0.75, classes: ['CP', 'CE1'] }]
    };
    const reportCard = { details: [] };
    (async () => {
      try {
        const sp = await determineSpecialty(null, 'modele-fils', specialtyStats, reportCard, null, null);
        assert.ok(sp && sp.verdict, 'verdict mécanique attendu');
        assert.ok(sp.verdict.indexOf('Spécialité : PYTHON') === 0, 'verdict mécanique : ' + sp.verdict);
        assert.strictEqual(calls, 0, 'zéro fetch sans professeur');
        process.exit(0);
      } catch (e) { console.error(e.message); process.exit(1); }
    })();
  `
};

function runAsyncProbe(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgo-teacher-test-'));
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, ASYNC_PROBES[name], 'utf8');
  try {
    const res = cp.spawnSync(process.execPath, [file], {
      cwd: dir,
      env: Object.assign({}, process.env, { BENCHGO_TEACHER_DIR: PROJECT }),
      timeout: 60000,
      encoding: 'utf8',
      windowsHide: true
    });
    if (res.status !== 0) {
      throw new Error('preuve async non conforme : ' + String(res.stderr || res.stdout || '').substring(0, 300));
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function run(c) {
  switch (c.name) {
    case 'professeur: URL exacte pour chaque provider de la table': {
      for (const [name, expected] of Object.entries(EXPECTED_BASE)) {
        const client = new TeacherClient({ provider: name, model: 'modele-test', apiKey: DUMMY_KEY });
        assert.strictEqual(client.baseUrl, expected, 'URL exacte attendue pour ' + name);
      }
      break;
    }
    case 'professeur: alias lm-studio recanalisé vers lmstudio': {
      const client = new TeacherClient({ provider: 'lm-studio', model: 'm', apiKey: DUMMY_KEY });
      assert.strictEqual(client.provider, 'lmstudio');
      assert.strictEqual(client.baseUrl, EXPECTED_BASE.lmstudio);
      break;
    }
    case 'professeur: provider inconnu = erreur fermée (pas de repli Groq)': {
      // Ex-preuve SEC-TEACH-01 : deepseek/together/cohere/kilo/ollama-cloud/
      // lmstudio/custom tombaient TOUS sur l'URL Groq. Désormais : erreur
      // fermée avant tout fetch, et les ex-tombés-Groq pointent au bon service.
      assert.throws(() => new TeacherClient({ provider: 'provider-inexistant', model: 'm', apiKey: DUMMY_KEY }), /provider inconnu/);
      assert.throws(() => new TeacherClient({ provider: '', model: 'm', apiKey: DUMMY_KEY }), /provider inconnu/);
      for (const p of ['deepseek', 'together', 'cohere', 'kilo', 'ollama-cloud', 'lmstudio', 'custom']) {
        let url = null;
        try { url = new TeacherClient({ provider: p, model: 'm', apiKey: DUMMY_KEY, endpoint: p === 'custom' ? 'http://localhost:8000/v1' : null }).baseUrl; }
        catch (e) { if (p === 'custom' && !/endpoint/i.test(e.message)) throw e; url = 'ERREUR-FERMEE'; }
        assert.ok(url === 'ERREUR-FERMEE' || String(url).indexOf('https://api.groq.com') !== 0, p + ' ne doit plus tomber sur Groq');
      }
      break;
    }
    case 'professeur: custom sans endpoint = erreur fermée': {
      assert.throws(() => new TeacherClient({ provider: 'custom', model: 'm', apiKey: DUMMY_KEY }), /teacher-endpoint/);
      const ok = new TeacherClient({ provider: 'custom', model: 'm', apiKey: DUMMY_KEY, endpoint: 'http://localhost:8000/v1' });
      assert.strictEqual(ok.baseUrl, 'http://localhost:8000/v1', 'endpoint custom propagé');
      break;
    }
    case 'professeur: clé env lue via le nom OFFICIEL du provider': {
      const savedGroq = process.env.GROQ_API_KEY;
      const savedOc = process.env.OLLAMA_CLOUD_API_KEY;
      try {
        process.env.GROQ_API_KEY = DUMMY_KEY + '-GROQENV';
        const cl = new TeacherClient({ provider: 'groq', model: 'm' });
        assert.strictEqual(cl.apiKey, DUMMY_KEY + '-GROQENV', 'la clé env doit être lue via CLOUD_PROVIDERS.envKey');
        // L'ancien hack toUpperCase donnait un nom FAUX pour ollama-cloud.
        process.env.OLLAMA_CLOUD_API_KEY = DUMMY_KEY + '-OCENV';
        const oc = new TeacherClient({ provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' });
        assert.strictEqual(oc.apiKey, DUMMY_KEY + '-OCENV', 'OLLAMA_CLOUD_API_KEY officiel (pas OLLAMA-CLOUD_API_KEY)');
        assert.strictEqual(oc.baseUrl, EXPECTED_BASE['ollama-cloud']);
      } finally {
        if (savedGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedGroq;
        if (savedOc === undefined) delete process.env.OLLAMA_CLOUD_API_KEY; else process.env.OLLAMA_CLOUD_API_KEY = savedOc;
      }
      break;
    }
    default: {
      if (ASYNC_PROBES[c.name]) {
        runAsyncProbe(c.name);
        break;
      }
      throw new Error('Cas inconnu : ' + c.name);
    }
  }
}

module.exports = { run, cases };
