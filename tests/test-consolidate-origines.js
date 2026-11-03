// tests/test-consolidate-origines.js — Tests de la détection d'origine
// (cloud vs local) du classement communautaire + corrections admin.
//
// Contexte (bug rapporté 2026-11-03) : le sélecteur Local/Cloud du classement
// communautaire montrait des modèles FRONTIER (école Post-Doctorat, testés via
// Ollama distant, provider stocké 'ollama' ∈ LOCAL_PROVIDERS) avec un badge
// local — 12 modèles concernés. Cause : consolidate-leaderboard.js avalait les
// signaux FRONTIER derrière le test provider, contrairement à leaderboard.js
// (tâche 2026-08-31e). Ces tests verrouillent la PARITÉ entre les deux
// classements et l'ordre de priorité des corrections (ADMIN > MANUEL > AUTO).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cl = require('../consolidate-leaderboard');
// leaderboard.js est requirable sans effet de bord (gated require.main) :
// on teste la PARITÉ réelle entre les deux classements, pas une réplique.
const lb = require('../leaderboard');

// Carnet FRONTIER réel (copie réduite de submissions/.../kimi-k2.7-code.json) :
// provider 'ollama' (dans LOCAL_PROVIDERS), école Post-Doctorat, tentative
// profil FRONTIER, isCloud stocké false (ancien champ non fiable).
function carnetKimiK27Code(overrides) {
  return Object.assign({
    model: 'kimi-k2.7-code',
    shortName: 'kimi_k2_7_code',
    provider: 'ollama',
    publisher: 'ollama',
    isCloud: false,
    quantization: null,
    ecoles: {
      'Post-Doctorat': {
        attempts: [{
          ecole: 'Post-Doctorat',
          profile: 'FRONTIER',
          score: 372, max: 900,
          tokens: 5000, elapsedMs: 60000,
          date: '2026-09-11'
        }],
        best: {
          ecole: 'Post-Doctorat',
          profile: 'FRONTIER',
          score: 372, max: 900,
          tokens: 5000, elapsedMs: 60000,
          date: '2026-09-11'
        }
      }
    }
  }, overrides || {});
}

// Carnet local classique (GGUF LM Studio) pour vérifier qu'on n'inverse pas
// le monde local : provider local, aucune école FRONTIER, aucun suffixe.
function carnetLocalClassique(overrides) {
  return Object.assign({
    model: 'gemma-4-12b-it-qat',
    shortName: 'gemma_4_12b_it_qat',
    provider: 'lmstudio',
    quantization: 'Q4_K_XL',
    ecoles: {
      'Primaire': {
        attempts: [{ ecole: 'Primaire', score: 55, max: 100, tokens: 900, elapsedMs: 12000, date: '2026-08-01' }],
        best: { ecole: 'Primaire', score: 55, max: 100, tokens: 900, elapsedMs: 12000, date: '2026-08-01' }
      }
    }
  }, overrides || {});
}

// Ledger équivalent pour leaderboard.js (même structure de carnet local).
function ledgerDeCarnet(carnet) {
  return {
    model: carnet.model,
    shortName: carnet.shortName,
    displayName: carnet.displayName,
    provider: carnet.provider,
    isCloud: carnet.isCloud,
    originManual: carnet.originManual,
    ecoles: carnet.ecoles
  };
}

const cases = [
  { name: 'BUG 2026-11-03 : FRONTIER via Ollama distant → CLOUD (kimi-k2.7-code)' },
  { name: 'PARITÉ : aggregateLedger (local) et aggregateCarnet (communautaire) classent pareil' },
  { name: 'école Post-Doctorat par clé seule (ancien carnet sans champ profile)' },
  { name: 'école Post-Doctorat par attempts[].ecole (clé école différente)' },
  { name: 'modèle local classique reste LOCAL (même avec isCloud pollué à true)' },
  { name: 'provider cloud hors LOCAL_PROVIDERS → CLOUD' },
  { name: 'detectIsCloudFromCarnet : suffixe :free' },
  { name: 'detectIsCloudFromCarnet : suffixe -cloud (Ollama Cloud)' },
  { name: 'detectIsCloudFromCarnet : suffixe -cloud dans displayName' },
  { name: 'detectIsCloudFromCarnet : tentative FRONTIER' },
  { name: 'detectIsCloudFromCarnet : carnet local sans signal → false' },
  { name: 'originManual du testeur : cloud force, local force (même slug :free)' },
  { name: 'admin override : cloud gagne sur originManual local (autorité max)' },
  { name: 'admin override : local gagne sur slug :free' },
  { name: 'admin override : rematch par clé normalisée (nom collé tel quel)' },
  { name: 'admin override : rematch par displayName en repli' },
  { name: 'admin override : override inconnu → chaîne auto' },
  { name: 'loadAdminOverrides : fichier absent → null' },
  { name: 'loadAdminOverrides : JSON malformé → null (pas de crash)' },
  { name: 'loadAdminOverrides : origins invalides filtrées, clés normalisées' },
  { name: 'carnetOriginSignals : liste les preuves' },
  { name: 'normalizeModelKey : clé de dédoublonnage stable' },
];

function run(c) {
  switch (c.name) {
    case 'BUG 2026-11-03 : FRONTIER via Ollama distant → CLOUD (kimi-k2.7-code)': {
      const agg = cl.aggregateCarnet(carnetKimiK27Code());
      assert.ok(agg, 'le carnet doit produire une entrée');
      assert.strictEqual(agg.isCloud, true, 'un modèle testé en FRONTIER est toujours cloud, malgré provider ollama + isCloud=false stocké');
      break;
    }
    case 'PARITÉ : aggregateLedger (local) et aggregateCarnet (communautaire) classent pareil': {
      // Trois scénarios exactement identiques dans les deux moteur :
      // FRONTIER ollama, local lmstudio, cloud openrouter.
      const scenarii = [
        carnetKimiK27Code(),
        carnetLocalClassique(),
        Object.assign(carnetLocalClassique(), {
          model: 'z-ai/glm-5.2', provider: 'openrouter', quantization: null, isCloud: undefined,
          ecoles: {
            'Université': {
              attempts: [{ ecole: 'Université', score: 70, max: 100, date: '2026-08-01' }],
              best: { ecole: 'Université', score: 70, max: 100, date: '2026-08-01' }
            }
          }
        })
      ];
      for (const carnet of scenarii) {
        const lbAgg = lb.aggregateLedger(ledgerDeCarnet(carnet));
        const clAgg = cl.aggregateCarnet(JSON.parse(JSON.stringify(carnet)));
        assert.ok(lbAgg && clAgg, 'les deux agrégations doivent aboutir pour ' + carnet.model);
        assert.strictEqual(
          clAgg.isCloud, lbAgg.isCloud,
          'parité origine cassée pour ' + carnet.model + ' (communautaire=' + clAgg.isCloud + ', local=' + lbAgg.isCloud + ')'
        );
        // provider aussi : mêmes entrées → même provider affiché
        assert.strictEqual(clAgg.provider || null, lbAgg.provider || null, 'parité provider pour ' + carnet.model);
      }
      break;
    }
    case 'école Post-Doctorat par clé seule (ancien carnet sans champ profile)': {
      const carnet = carnetLocalClassique({
        provider: 'lmstudio',
        ecoles: { 'Post-Doctorat': { best: { ecole: 'Post-Doctorat', score: 10, max: 20, date: '2026-01-01' } } }
      });
      const agg = cl.aggregateCarnet(carnet);
      assert.strictEqual(agg.isCloud, true, 'la clé d école Post-Doctorat suffit (école réservée au cloud)');
      break;
    }
    case 'école Post-Doctorat par attempts[].ecole (clé école différente)': {
      const carnet = carnetLocalClassique({
        provider: 'ollama',
        ecoles: {
          'ÉcoleInconnue': {
            attempts: [{ ecole: 'Post-Doctorat', score: 5, max: 10, date: '2026-01-01' }],
            best: { ecole: 'Post-Doctorat', score: 5, max: 10, date: '2026-01-01' }
          }
        }
      });
      const agg = cl.aggregateCarnet(carnet);
      assert.strictEqual(agg.isCloud, true);
      break;
    }
    case 'modèle local classique reste LOCAL (même avec isCloud pollué à true)': {
      const carnet = carnetLocalClassique({ isCloud: true });
      const agg = cl.aggregateCarnet(carnet);
      assert.strictEqual(agg.isCloud, false, 'provider local sans signal fort → local (bug 2026-08-26 : isCloud pollué ignoré)');
      break;
    }
    case 'provider cloud hors LOCAL_PROVIDERS → CLOUD': {
      const carnet = carnetLocalClassique({ provider: 'groq', isCloud: undefined });
      const agg = cl.aggregateCarnet(carnet);
      assert.strictEqual(agg.isCloud, true);
      break;
    }
    case 'detectIsCloudFromCarnet : suffixe :free': {
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'z-ai/glm-5.2:free', ecoles: {} }), true);
      break;
    }
    case 'detectIsCloudFromCarnet : suffixe -cloud (Ollama Cloud)': {
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'gemma4:31b-cloud', ecoles: {} }), true);
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'gemma4:31b', displayName: 'gemma4:31b-cloud', ecoles: {} }), true);
      break;
    }
    case 'detectIsCloudFromCarnet : suffixe -cloud dans displayName': {
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'gemma4', displayName: 'gemma4:31b-cloud', ecoles: {} }), true);
      break;
    }
    case 'detectIsCloudFromCarnet : tentative FRONTIER': {
      const carnet = { model: 'mon-modele', ecoles: { 'Université': { attempts: [{ profile: 'FRONTIER' }] } } };
      assert.strictEqual(cl.detectIsCloudFromCarnet(carnet), true);
      break;
    }
    case 'detectIsCloudFromCarnet : carnet local sans signal → false': {
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'gemma-4-12b-it-qat', ecoles: {} }), false);
      assert.strictEqual(cl.detectIsCloudFromCarnet({ model: 'kimi-k2.7-code', ecoles: {} }), false, 'le NAME seul sans suffixe ne suffit pas — c était le bug cloudByName');
      break;
    }
    case 'originManual du testeur : cloud force, local force (même slug :free)': {
      const forceCloud = cl.aggregateCarnet(carnetLocalClassique({ originManual: 'cloud' }));
      assert.strictEqual(forceCloud.isCloud, true, 'choix manuel cloud prime sur l heuristique');
      const forceLocal = cl.aggregateCarnet({
        model: 'z-ai/glm-5.2:free', provider: undefined, originManual: 'local',
        ecoles: { 'Université': { best: { ecole: 'Université', score: 5, max: 10, date: 'd' } } }
      });
      assert.strictEqual(forceLocal.isCloud, false, 'choix manuel local prime même sur un slug :free');
      break;
    }
    case 'admin override : cloud gagne sur originManual local (autorité max)': {
      const overrides = { 'gemma-4-12b-it-qat': { origin: 'cloud' } };
      const res = cl.resolveCarnetOrigin(carnetLocalClassique({ originManual: 'local' }), overrides);
      assert.strictEqual(res.isCloud, true);
      assert.strictEqual(res.originAdmin, 'cloud');
      assert.strictEqual(res.source, 'admin');
      break;
    }
    case 'admin override : local gagne sur slug :free': {
      const overrides = { 'glm-5-2-free': { origin: 'local' } };
      const carnet = {
        model: 'z-ai/glm-5.2:free', provider: undefined,
        ecoles: { 'Université': { best: { ecole: 'Université', score: 5, max: 10, date: 'd' } } }
      };
      const res = cl.resolveCarnetOrigin(carnet, overrides);
      assert.strictEqual(res.isCloud, false, 'la correction admin prime sur les signaux nom');
      assert.strictEqual(res.source, 'admin');
      break;
    }
    case 'admin override : rematch par clé normalisée (nom collé tel quel)': {
      const overrides = { 'Z-AI/Glm_5.2:free': { origin: 'cloud' } };
      const carnet = {
        model: 'z-ai/glm-5.2:free',
        ecoles: { 'Université': { best: { ecole: 'Université', score: 5, max: 10, date: 'd' } } }
      };
      const res = cl.resolveCarnetOrigin(carnet, overrides);
      assert.strictEqual(res.isCloud, true, 'la clé de l override est normalisée à la lecture — le nom peut être collé tel quel');
      break;
    }
    case 'admin override : rematch par displayName en repli': {
      // Modèle local auto (lmstudio, aucun signal) + override key sur le
      // displayName normalisé → la correction admin doit gagner (source admin).
      const overrides = { 'kimi-k2-7-code': { origin: 'cloud' } };
      const carnet = {
        model: 'inconnu-x', displayName: 'Kimi K2.7 Code', provider: 'lmstudio',
        ecoles: { 'Primaire': { best: { ecole: 'Primaire', score: 5, max: 10, date: 'd' } } }
      };
      const res = cl.resolveCarnetOrigin(carnet, overrides);
      assert.strictEqual(res.source, 'admin', 'la clé override doit matcher via le displayName normalisé');
      assert.strictEqual(res.isCloud, true);
      break;
    }
    case 'admin override : override inconnu → chaîne auto': {
      const res = cl.resolveCarnetOrigin(carnetKimiK27Code(), { 'autre-modele': { origin: 'local' } });
      assert.strictEqual(res.isCloud, true, 'sans override, la chaîne auto s applique (Post-Doctorat → cloud)');
      assert.strictEqual(res.source, 'auto');
      assert.strictEqual(res.originAdmin, null);
      break;
    }
    case 'loadAdminOverrides : fichier absent → null': {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgo-ovr-'));
      try {
        assert.strictEqual(cl.loadAdminOverrides(path.join(dir, 'aucun.json')), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      break;
    }
    case 'loadAdminOverrides : JSON malformé → null (pas de crash)': {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgo-ovr-'));
      try {
        const p = path.join(dir, 'admin-overrides.json');
        fs.writeFileSync(p, '{ overrides: { ceci est du JSON invalide ]', 'utf8');
        assert.strictEqual(cl.loadAdminOverrides(p), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      break;
    }
    case 'loadAdminOverrides : origins invalides filtrées, clés normalisées': {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgo-ovr-'));
      try {
        const p = path.join(dir, 'admin-overrides.json');
        fs.writeFileSync(p, JSON.stringify({
          version: 1,
          overrides: {
            'kimi-k2.7-code': { origin: 'CLOUD', note: 'Ollama distant' },
            'mauvais': { origin: 'gauche' },
            'aucun-origine': { note: 'sans champ origin' }
          }
        }, null, 2), 'utf8');
        const map = cl.loadAdminOverrides(p);
        assert.ok(map, 'la map doit être renvoyée');
        assert.ok(map['kimi-k2-7-code'], 'la clé est normalisée');
        assert.strictEqual(map['kimi-k2-7-code'].origin, 'cloud', 'origine normalisée en minuscules');
        assert.strictEqual(map['kimi-k2-7-code'].note, 'Ollama distant', 'note conservée');
        assert.strictEqual(map['mauvais'], undefined, 'origine invalide filtrée');
        assert.strictEqual(map['aucun-origine'], undefined, 'entrée sans origin filtrée');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      break;
    }
    case 'carnetOriginSignals : liste les preuves': {
      const sig = cl.carnetOriginSignals(carnetKimiK27Code());
      assert.ok(sig.some(s => /Post-Doctorat/.test(s)), 'signal école Post-Doctorat présent');
      assert.ok(sig.some(s => /FRONTIER/.test(s)), 'signal tentative FRONTIER présent');
      const none = cl.carnetOriginSignals(carnetLocalClassique());
      assert.strictEqual(none.length, 0, 'aucun signal pour un modèle local');
      const slug = cl.carnetOriginSignals({ model: 'z-ai/glm-5.2:free', ecoles: {} });
      assert.ok(slug.some(s => /:free/.test(s)));
      break;
    }
    case 'normalizeModelKey : clé de dédoublonnage stable': {
      assert.strictEqual(cl.normalizeModelKey('kimi-k2.7-code'), 'kimi-k2-7-code');
      // Le segment publisher (avant le /) est retiré : Z-AI/ disparait de la clé.
      assert.strictEqual(cl.normalizeModelKey('Z-AI/Glm_5.2:free'), 'glm-5-2-free');
      assert.strictEqual(cl.normalizeModelKey('unsloth/gemma-4-12b-it-qat'), 'gemma-4-12b-it-qat', 'préfixe publisher retiré');
      // Le même modèle trouvé par le carnet doit matcher la clé écrite par l admin.
      const carnetKey = cl.normalizeModelKey('kimi-k2.7-code', 'kimi_k2_7_code');
      assert.strictEqual(carnetKey, cl.normalizeModelKey('kimi-k2.7-code'));
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

// Agrégation d'un carnet sans token : pricing envoie tout au fallback local —
// pas de réseau en test. On s'assure une seule fois que estimateModelCost ne
// lève pas sur un carnet FRONTIER (coût null accepté hors ligne).
{
  const agg = cl.aggregateCarnet(carnetKimiK27Code({ provider: 'openai', model: 'gpt-5.2' }));
  assert.ok(agg, 'estimateModelCost ne doit pas faire lever aggregateCarnet');
}

module.exports = { cases, run };