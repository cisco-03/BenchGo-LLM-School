#!/usr/bin/env node
// frontier-batch.js - Mode batch pour modeles frontiere (cloud)
//
// Enchaine automatiquement le test de plusieurs modeles cloud (frontiere) a la
// suite, sans intervention humaine. Equivalent de night-batch.js mais pour les
// modeles cloud (OpenRouter, OpenAI, Groq, Together, Mistral, Anthropic, etc.)
// au lieu des modeles locaux LM Studio.
//
// Principe :
//   1. Selection du provider cloud (openrouter par defaut).
//   2. Saisie de la cle API (recuperee depuis .api-keys.json si memorisee).
//   3. Saisie interactive de la liste des modeles a tester (un par ligne, ou
//      liste separateur par virgules).
//   4. Pour chaque modele :
//        node runner.js all --force --provider=<provider> --model=<model> --profile=FRONTIER
//      (--force neutralise les confirmations de re-test en mode non-TTY ;
//       --profile=FRONTIER force le plus haut niveau, pas de Primaire/Collège).
//   5. A la fin : resume horodate + generation du classement.
//
// Usage :
//   node frontier-batch.js                          # interactif (provider + modeles)
//   node frontier-batch.js --provider=openrouter    # provider fixe
//   node frontier-batch.js --models=m1,m2,m3        # modeles sans saisie
//   node frontier-batch.js --provider=openrouter --models=m1,m2
//   node frontier-batch.js --no-teacher             # desactive le professeur IA
//   node frontier-batch.js --profile=STANDARD        # test niveau Collège/Lycée (petits modèles)
//   node frontier-batch.js --profile=LIGHT            # test niveau Primaire (très petits modèles)

const { spawnSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;
const RUNNER = path.join(PROJECT_ROOT, 'runner.js');

// Importe PROFILES et detectProfileFromModelName pour proposer le bon niveau
// d'école selon la taille du modèle cloud (un petit 12B ne passera jamais le
// Post-Doctorat — il faut le tester en Collège/Lycée, voire Primaire).
const { PROFILES, detectProfileFromModelName } = require('./config');
const { printEntryHelp, wantsHelp } = require('./cli-help');

// Détection des modèles cloud non-LLM (embeddings, OCR, rerank, vision-only).
// Les slugs cloud (ex: "liquid/lfm-2.5-embedding-350m:free") ne sont pas des
// objets LM Studio : on applique directement NON_LLM_PATTERNS (exporté depuis
// night-batch.js, qui les définit de façon centralisée). Un modèle détecté
// comme non-LLM est refusé et non testé : BenchGo évalue des LLM génératifs,
// pas des vectoriseurs/détecteurs. On évite ainsi le bug où un modèle
// d'embeddings obtenait "TOP DU TOP" à 0/0 (toutes tâches bypassées).
const { NON_LLM_PATTERNS } = require('./night-batch');
const { resolveOpenRouterSlug, resolveKiloSlug } = require('./model-resolver');

function isNonLlmCloudModel(slug) {
  if (!slug) return false;
  const s = String(slug);
  for (const re of NON_LLM_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}

// Profils d'école sélectionnables pour les modèles cloud. FRONTIER (Post-Doctorat)
// reste le défaut pour les gros modèles, mais les petits modèles cloud (< 15B)
// peuvent être testés à un niveau adapté à leur capacité.
// L'ordre correspond à la difficulté croissante.
const CLOUD_PROFILES = [
  { key: 'LIGHT',    label: 'LIGHT — Primaire (< 3B)',          ecole: 'Primaire' },
  { key: 'STANDARD', label: 'STANDARD — Collège/Lycée (3B-15B)', ecole: 'Collège-Lycée' },
  { key: 'EXPERT',   label: 'EXPERT — Université (15B-30B)',     ecole: 'Université' },
  { key: 'DOCTORAT', label: 'DOCTORAT — Thèse (> 30B)',         ecole: 'Thèse' },
  { key: 'FRONTIER', label: 'FRONTIER — Post-Doctorat (cloud, tous niveaux)', ecole: 'Post-Doctorat' },
  // AUTO : chaque modèle reçoit le profil adapté à SA taille (détection via
  // detectProfileFromModelName). Taille indétectable → FRONTIER (défaut cloud).
  // Résout le problème d'une liste mélangée : un 2.6B finit en LIGHT, un 550B
  // en DOCTORAT — sans choisir manuellement pour chacun.
  { key: 'AUTO',     label: 'AUTO — profil selon la taille de chaque modèle', ecole: '(auto)' }
];

// Résout le profil d'UN modèle en mode AUTO : profil détecté depuis le nom du
// slug (ex: "liquid/lfm-2.5-2.6b:free" → LIGHT, "nemotron-3-ultra-550b" →
// DOCTORAT). Taille indétectable → FRONTIER (comportement historique cloud).
function profileForModel(model) {
  const { detected } = detectProfileFromModelName(model);
  if (detected && CLOUD_PROFILES.find(p => p.key === detected)) return detected;
  return 'FRONTIER';
}

// Providers cloud supportes (reprend la liste de cloud-client.js).
// On inclut aussi les serveurs OpenAI-compatibles (ollama, lmstudio, custom) :
// Ollama propose un service cloud payant (cle + base URL) en plus du local ;
// le runner les traite via cloud-client.js. Pour le local, pas de cle requise.
const CLOUD_PROVIDERS = [
  { key: 'openrouter', label: 'OpenRouter (agregateur, modeles gratuits dispo)' },
  { key: 'kilo',       label: 'Kilo Gateway (api.kilo.ai, modeles gratuits dispo, cle optionnelle)' },
  { key: 'openai',     label: 'OpenAI (GPT-4o, o1, etc.)' },
  { key: 'anthropic',  label: 'Anthropic (Claude)' },
  { key: 'groq',       label: 'Groq (inference ultra-rapide)' },
  { key: 'together',   label: 'Together AI' },
  { key: 'mistral',    label: 'Mistral AI' },
  { key: 'deepseek',   label: 'DeepSeek' },
  { key: 'cohere',     label: 'Cohere' },
  { key: 'ollama',     label: 'Ollama (cloud payant: --endpoint + --api-key ; ou local)' },
  { key: 'lmstudio',   label: 'LM Studio (local, serveur OpenAI-compat, pas de cle)' },
  { key: 'custom',     label: 'Personnalise (--endpoint= requis, OpenAI-compat)' }
];

// --- Couleurs ANSI ---
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function nowClock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function nowDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Parse les arguments CLI : --provider=, --models=, --no-teacher, --api-key=,
// --profile= (niveau d'école : LIGHT, STANDARD, EXPERT, DOCTORAT, FRONTIER, AUTO),
// --yes (mode non-interactif : jamais demander, garder les modèles non résolus).
function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = { provider: null, models: null, noTeacher: false, apiKey: null, endpoint: null, profile: null, yes: false };
  for (const a of args) {
    if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else if (a.startsWith('--models=')) opts.models = a.slice('--models='.length);
    else if (a.startsWith('--api-key=')) opts.apiKey = a.slice('--api-key='.length);
    else if (a.startsWith('--endpoint=')) opts.endpoint = a.slice('--endpoint='.length);
    else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length).toUpperCase();
    else if (a === '--no-teacher') opts.noTeacher = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (wantsHelp([a])) {
      printFrontierHelp();
      process.exit(0);
    }
  }
  // Mode non-interactif (redirection, CI, planificateur de nuit) : --yes implicite.
  // Sans ça, les prompts « Garder ce modèle ? » bloqueraient le batch à l'infini
  // alors que l'utilisateur dort — c'est le bug « le mode nuit s'arrête en chemin ».
  if (!process.stdin.isTTY || !process.stdout.isTTY) opts.yes = true;
  return opts;
}

function printFrontierHelp() {
  printEntryHelp('frontier-batch.js', 'Mode batch pour modèles cloud (frontière)', [
    { cmd: 'node frontier-batch.js', desc: 'Interactif (provider + modèles + niveau).' },
    { cmd: 'node frontier-batch.js --provider=openrouter', desc: 'Provider cloud fixe.' },
    { cmd: 'node frontier-batch.js --models=m1,m2,m3', desc: 'Modèles à tester sans saisie.' },
    { cmd: 'node frontier-batch.js --provider=openrouter --models=m1,m2', desc: 'Provider + modèles combinés.' },
    { cmd: 'node frontier-batch.js --profile=STANDARD', desc: 'Niveau Collège/Lycée (petits modèles < 15B).' },
    { cmd: 'node frontier-batch.js --profile=LIGHT', desc: 'Niveau Primaire (très petits modèles < 3B).' },
    { cmd: 'node frontier-batch.js --profile=AUTO', desc: 'Profil individuel selon la taille de CHAQUE modèle (listes mélangées).' },
    { cmd: 'node frontier-batch.js --yes', desc: 'Mode non-interactif : aucun prompt (garder les slugs non résolus, batch de nuit).' },
    { cmd: 'node frontier-batch.js --no-teacher', desc: 'Désactive le professeur IA (correcteur externe).' },
    { cmd: 'node frontier-batch.js --api-key=sk-...', desc: 'Clé API fournie (sinon .api-keys.json ou saisie).' },
    { cmd: 'node frontier-batch.js --provider=ollama --endpoint=https://...', desc: 'Endpoint custom (ollama/lmstudio/custom).' },
    { cmd: 'node frontier-batch.js --help  |  help  |  -h', desc: 'Affiche cette aide.' }
  ], [
    'Défaut : --profile=FRONTIER (Post-Doctorat). Pour un petit modèle cloud (< 15B), utiliser STANDARD, LIGHT ou AUTO.',
    '--profile=AUTO : chaque modèle reçoit le profil adapté à sa taille (détection depuis le slug). Taille inconnue → FRONTIER.',
    '--yes (ou non-TTY) : aucun prompt interactif — les slugs non reconnus sont gardés tels quels, la file continue (mode nuit).',
    '--force est transmis au runner (neutralise les confirmations en mode non-TTY).',
    '--submit, --github-token et --hybrid sont transmis au runner (cf. node runner.js --help).',
    'Classement communautaire : soumettez vos carnets avec : node runner.js --submit'
  ]);
}

// Recupere la cle API memorisee pour un provider depuis .api-keys.json.
function getStoredApiKey(provider) {
  try {
    const store = require('./api-keys-store');
    return store.getKey(provider) || null;
  } catch (_) {
    return null;
  }
}

// Selection interactive du provider cloud.
function selectProviderInteractive(defaultProvider) {
  return new Promise(resolve => {
    if (defaultProvider) {
      const found = CLOUD_PROVIDERS.find(p => p.key === defaultProvider);
      if (found) {
        console.log(`  ${C.gray}Provider fixe par CLI : ${found.label}${C.reset}\n`);
        resolve(found.key);
        return;
      }
      console.log(`  ${C.yellow}Provider inconnu : ${defaultProvider}. Selection interactive.${C.reset}`);
    }
    console.log(`\n  ${C.bold}${C.cyan}=== PROVIDER CLOUD ===${C.reset}`);
    console.log(`  ${C.gray}Selectionnez le fournisseur cloud pour les modeles a tester.${C.reset}\n`);
    CLOUD_PROVIDERS.forEach((p, i) => {
      const idx = String(i + 1).padStart(2);
      console.log(`  ${C.bold}${idx}.${C.reset} ${p.label}`);
    });
    console.log('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${C.cyan}Provider (numero ou nom) [defaut: openrouter] :${C.reset} `, answer => {
      rl.close();
      const raw = (answer || '').trim().toLowerCase();
      if (!raw) { resolve('openrouter'); return; }
      // Par numero
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= CLOUD_PROVIDERS.length) {
        resolve(CLOUD_PROVIDERS[n - 1].key);
        return;
      }
      // Par nom
      const found = CLOUD_PROVIDERS.find(p => p.key === raw);
      if (found) { resolve(found.key); return; }
      console.log(`  ${C.red}Provider inconnu : ${raw}. Utilisation de openrouter.${C.reset}`);
      resolve('openrouter');
    });
  });
}

// Saisie interactive de la cle API (masquee) si non memorisee et non fournie.
// Pour ollama/lmstudio/custom (requiresAuth: false cote cloud-client), la cle
// est optionnelle : vide = pas de cle (mode local sans auth). Pour les autres
// providers, une cle vide = abandon.
// Apres saisie d une NOUVELLE cle (non deja memorisee dans .api-keys.json), on
// propose de la memoriser localement pour les prochains runs (comme le runner).
// kilo : cle optionnelle (acces anonyme aux modeles :free, 200 req/h/IP).
const PROVIDERS_OPTIONAL_KEY = new Set(['ollama', 'lmstudio', 'custom', 'kilo']);

// askYesNo local (le runner ne l exporte pas). Retourne true pour Oui.
function askYesNoLocal(question, defaultYes) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultYes ? 'O/n' : 'o/N';
    rl.question(`  ${C.cyan}${question} [${hint}] :${C.reset} `, answer => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (!a) { resolve(Boolean(defaultYes)); return; }
      resolve(a === 'o' || a === 'oui' || a === 'y' || a === 'yes');
    });
  });
}

function promptApiKey(provider, cliApiKey) {
  return new Promise(resolve => {
    if (cliApiKey) { resolve(cliApiKey); return; }
    const stored = getStoredApiKey(provider);
    if (stored) {
      console.log(`  ${C.gray}Cle API ${provider} recuperee depuis .api-keys.json.${C.reset}`);
      resolve(stored);
      return;
    }
    const optionalKey = PROVIDERS_OPTIONAL_KEY.has(provider);
    console.log(`\n  ${C.bold}${C.cyan}=== CLE API ${provider.toUpperCase()} ===${C.reset}`);
    console.log(`  ${C.gray}Aucune cle memorisee pour ${provider}.${C.reset}`);
    if (optionalKey) {
      console.log(`  ${C.gray}Pour ${provider} en local : laissez vide (pas d'authentification).${C.reset}`);
      console.log(`  ${C.gray}Pour ${provider} en mode cloud payant : saisissez votre cle.${C.reset}`);
    } else {
      console.log(`  ${C.gray}Saisissez votre cle API (elle restera en memoire pour cette session).${C.reset}`);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Masque la saisie pour eviter que la cle s_affiche en clair.
    const stdin = process.stdin;
    const origWrite = process.stdout.write.bind(process.stdout);
    const maskedChars = [];
    stdin.on('data', (char) => {
      const c = char.toString();
      if (c === '\r' || c === '\n') return;
      if (c === '\u007f' || c === '\b') { maskedChars.pop(); return; }
      maskedChars.push(c);
    });
    rl.question(`  ${C.cyan}Cle API${optionalKey ? ' (vide = sans cle)' : ''} :${C.reset} `, async answer => {
      rl.close();
      const key = (answer || '').trim();
      if (!key && !optionalKey) {
        console.log(`  ${C.red}Cle API manquante. Abandon.${C.reset}`);
        process.exit(1);
      }
      // Proposition de mémorisation pour les prochains runs (comme le runner).
      // On ne propose QUE pour une clé non vide, non déjà mémorisée, et en TTY.
      if (key && process.stdin.isTTY && process.stdout.isTTY) {
        try {
          const store = require('./api-keys-store');
          if (!store.getKey(provider)) {
            console.log(`\n  ${C.bold}${C.cyan}━━ MÉMORISATION DE LA CLÉ ${provider.toUpperCase()} ━━${C.reset}`);
            console.log(`  ${C.gray}Si vous la mémorisez : les prochains frontier-batch retrouveront la clé automatiquement.${C.reset}`);
            console.log(`  ${C.gray}Sécurité : stockée dans .api-keys.json (local, ignoré par git). Effaçable via node runner.js --forget-key=${provider}.${C.reset}`);
            const memorize = await askYesNoLocal(`  Mémoriser cette clé localement ?`, false);
            if (memorize) {
              store.saveKey(provider, key);
              console.log(`  ${C.green}Clé mémorisée dans .api-keys.json.${C.reset}\n`);
            } else {
              console.log(`  ${C.gray}Clé non mémorisée — session uniquement.${C.reset}\n`);
            }
          }
        } catch (_) { /* store indisponible : on continue sans mémoriser */ }
      }
      resolve(key || null);
    });
  });
}

// Saisie interactive du point de terminaison (base URL) pour les providers qui
// en ont besoin : custom (obligatoire), ollama/lmstudio en mode cloud payant
// (override de l'URL locale par defaut). Pour ollama/lmstudio en local, on
// garde l'URL par defaut (localhost) si rien n'est saisi.
const PROVIDERS_NEEDING_ENDPOINT = new Set(['custom']);
const PROVIDERS_OPTIONAL_ENDPOINT = new Set(['ollama', 'lmstudio']);
function promptEndpoint(provider, cliEndpoint) {
  return new Promise(resolve => {
    if (cliEndpoint) { resolve(cliEndpoint); return; }
    if (PROVIDERS_NEEDING_ENDPOINT.has(provider)) {
      console.log(`\n  ${C.bold}${C.cyan}=== BASE URL ${provider.toUpperCase()} ===${C.reset}`);
      console.log(`  ${C.gray}Ce provider ne possede pas d'URL par defaut.${C.reset}`);
      console.log(`  ${C.gray}Saisissez la base URL du serveur (ex: https://api.exemple.com/v1/chat/completions).${C.reset}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`  ${C.cyan}Endpoint :${C.reset} `, answer => {
        rl.close();
        const url = (answer || '').trim();
        if (!url) {
          console.log(`  ${C.red}Endpoint manquant pour ${provider}. Abandon.${C.reset}`);
          process.exit(1);
        }
        resolve(url);
      });
      return;
    }
    if (PROVIDERS_OPTIONAL_ENDPOINT.has(provider)) {
      console.log(`\n  ${C.bold}${C.cyan}=== BASE URL ${provider.toUpperCase()} ===${C.reset}`);
      console.log(`  ${C.gray}Par defaut : serveur local (localhost).${C.reset}`);
      console.log(`  ${C.gray}Pour utiliser ${provider} en mode cloud payant, saisissez la base URL fournie.${C.reset}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`  ${C.cyan}Endpoint (vide = local par defaut) :${C.reset} `, answer => {
        rl.close();
        resolve((answer || '').trim() || null);
      });
      return;
    }
    resolve(null);
  });
}

// Saisie interactive des modeles a tester.
function selectModelsInteractive(cliModels) {
  return new Promise(resolve => {
    if (cliModels) {
      const list = cliModels.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      if (list.length > 0) {
        console.log(`  ${C.gray}Modeles fixes par CLI : ${list.length} modele(s)${C.reset}\n`);
        resolve(list);
        return;
      }
    }
    console.log(`\n  ${C.bold}${C.cyan}=== MODELES A TESTER ===${C.reset}`);
    console.log(`  ${C.gray}Saisissez les modeles a tester, un par ligne.${C.reset}`);
    console.log(`  ${C.gray}Tapez une ligne vide (ou "done") pour terminer la saisie.${C.reset}`);
    console.log(`  ${C.gray}Astuce : vous pouvez aussi coller une liste separee par virgules.${C.reset}\n`);
    const models = [];
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    function prompt() {
      rl.question(`  ${C.cyan}Modele ${models.length + 1} (ou vide pour terminer) :${C.reset} `, answer => {
        const raw = (answer || '').trim();
        if (!raw || raw.toLowerCase() === 'done') {
          rl.close();
          if (models.length === 0) {
            console.log(`  ${C.red}Aucun modele saisi. Abandon.${C.reset}`);
            process.exit(1);
          }
          resolve(models);
          return;
        }
        // Si la ligne contient des virgules, on split (liste collee).
        const parts = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
        for (const p of parts) models.push(p);
        prompt();
      });
    }
    prompt();
  });
}

// Selection interactive du niveau d ecole (profil) pour les modeles cloud.
// FRONTIER (Post-Doctorat) reste le defaut, mais les petits modeles cloud
// (< 15B) ne peuvent pas realistiquement passer le Post-Doctorat : on propose
// donc de les tester a un niveau adapte (LIGHT/STANDARD/EXPERT/DOCTORAT).
//
// Si --profile= est fourni en CLI, on l utilise directement (pas de saisie).
// Sinon, on tente de detecter la taille des modeles saisis pour recommander
// un profil. Si aucun signal de taille n est detecte, on propose FRONTIER par
// defaut (comportement historique) avec un avertissement pour les petits modeles.
function selectProfileInteractive(cliProfile, models) {
  return new Promise(resolve => {
    const validKeys = CLOUD_PROFILES.map(p => p.key);
    // Profil fixe par CLI : on valide et on l accepte tel quel.
    if (cliProfile) {
      const upper = cliProfile.toUpperCase();
      if (validKeys.includes(upper)) {
        const p = CLOUD_PROFILES.find(x => x.key === upper);
        console.log(`  ${C.gray}Profil fixe par CLI : ${p.label}${C.reset}\n`);
        resolve(upper);
        return;
      }
      console.log(`  ${C.yellow}Profil inconnu : ${cliProfile}. Selection interactive.${C.reset}`);
    }

    // Detection de la taille des modeles pour recommander un profil.
    // On prend le modele avec la plus grande taille detectee (le plus exigeant)
    // pour eviter de sous-estimer si un grand modele est melange avec des petits.
    let maxParamSize = null;
    let detectedProfile = null;
    for (const m of models) {
      const { paramSize, detected } = detectProfileFromModelName(m);
      if (paramSize !== null) {
        if (maxParamSize === null || paramSize > maxParamSize) {
          maxParamSize = paramSize;
          detectedProfile = detected;
        }
      }
    }

    // Profil recommande : celui detecte, sinon FRONTIER par defaut.
    // FRONTIER n est jamais renvoye par detectProfileFromModelName (reserve au
    // cloud manuel), donc un modele cloud de taille inconnue reste en FRONTIER.
    // AUTO est recommande des que la liste melange des tailles differentes :
    // chaque modele aura son profil individuel au lieu d'un niveau uniforme.
    const recommended = detectedProfile || 'FRONTIER';
    const sizes = models.map(m => detectProfileFromModelName(m)).filter(r => r.paramSize !== null);
    const distinctProfiles = [...new Set(sizes.map(r => r.detected))];
    const autoIsBetter = distinctProfiles.length > 1
      || (distinctProfiles.length === 1 && detectedProfile !== null && distinctProfiles[0] !== 'FRONTIER');
    const autoRecommended = autoIsBetter ? 'AUTO' : recommended;
    const recIdx = CLOUD_PROFILES.findIndex(p => p.key === recommended);
    const autoIdx = CLOUD_PROFILES.findIndex(p => p.key === 'AUTO');

    console.log(`\n  ${C.bold}${C.cyan}=== NIVEAU D ECOLE (PROFIL) ===${C.reset}`);
    console.log(`  ${C.gray}Choisissez le niveau d examen. FRONTIER = Post-Doctorat (le plus dur).${C.reset}`);
    console.log(`  ${C.gray}AUTO = profil individuel selon la taille de CHAQUE modèle (mélanges de tailles).${C.reset}`);
    if (maxParamSize !== null) {
      console.log(`  ${C.gray}Taille max detectee : ~${maxParamSize}B parametres -> profil recommande : ${autoRecommended === 'AUTO' ? 'AUTO (tailles mixtes)' : recommended}${C.reset}`);
    } else {
      console.log(`  ${C.gray}Taille non detectee. Pour un petit modele cloud (< 15B), preferer STANDARD, LIGHT ou AUTO.${C.reset}`);
    }
    console.log('');
    CLOUD_PROFILES.forEach((p, i) => {
      const idx = String(i + 1).padStart(2);
      const marker = (i === autoIdx && autoRecommended === 'AUTO') ? `${C.green}[recommande]${C.reset} `
        : (i === recIdx && autoRecommended !== 'AUTO') ? `${C.green}[recommande]${C.reset} `
        : '  ';
      console.log(`  ${C.bold}${idx}.${C.reset} ${marker} ${p.label}`);
    });
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const defaultKey = autoRecommended === 'AUTO' ? 'AUTO' : recommended;
    rl.question(`  ${C.cyan}Niveau (numero ou nom) [defaut: ${defaultKey}] :${C.reset} `, answer => {
      rl.close();
      const raw = (answer || '').trim().toLowerCase();
      if (!raw) { resolve(defaultKey); return; }
      // Par numero
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= CLOUD_PROFILES.length) {
        resolve(CLOUD_PROFILES[n - 1].key);
        return;
      }
      // Par nom
      const upper = raw.toUpperCase();
      if (validKeys.includes(upper)) {
        resolve(upper);
        return;
      }
      console.log(`  ${C.red}Niveau inconnu : ${raw}. Utilisation de ${defaultKey}.${C.reset}`);
      resolve(defaultKey);
    });
  });
}

// Execute le runner pour un modele cloud frontiere.
// Renvoie { ok, exitCode, durationMs }.
function runModel(provider, model, apiKey, noTeacher, endpoint, profile) {
  const args = [
    RUNNER, 'all',
    '--force',
    '--provider=' + provider,
    '--model=' + model,
    '--profile=' + (profile || 'FRONTIER')
  ];
  if (apiKey) args.push('--api-key=' + apiKey);
  if (endpoint) args.push('--endpoint=' + endpoint);
  if (noTeacher) args.push('--no-teacher');

  console.log(`\n  ${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`  ${C.bold}${C.magenta}  TEST FRONTIERE : ${model}${C.reset}`);
  console.log(`  ${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`  ${C.gray}Heure de debut : ${nowClock()}${C.reset}`);
  console.log(`  ${C.gray}Profil : ${profile || 'FRONTIER'}${C.reset}`);
  console.log(`  ${C.gray}Commande : node runner.js all --force --provider=${provider} --model=<...> --profile=${profile || 'FRONTIER'}${C.reset}\n`);

  const t0 = Date.now();
  const r = spawnSync('node', args, {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    windowsHide: false
  });
  const durationMs = Date.now() - t0;

  return {
    ok: r.status === 0,
    exitCode: r.status,
    durationMs
  };
}

// Formate une duree en ms vers un affichage compact (ex: 1.2s, 1m05s, 1h02m).
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (m < 60) return m + 'm' + String(sec).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h + 'h' + String(min).padStart(2, '0') + 'm';
}

async function main() {
  const opts = parseCliArgs();

  console.log(`\n  ${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}       FRONTIER BATCH - Modeles cloud (frontiere)       ${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}\n`);

  console.log(`  ${C.gray}Ce script enchaine le test de plusieurs modeles cloud${C.reset}`);
  console.log(`  ${C.gray}a la suite. Le niveau d ecole est configurable (FRONTIER par defaut,${C.reset}`);
  console.log(`  ${C.gray}mais les petits modeles peuvent etre testes en STANDARD/LIGHT/EXPERT).${C.reset}\n`);

  const provider = await selectProviderInteractive(opts.provider);
  const endpoint = await promptEndpoint(provider, opts.endpoint);
  const apiKey = await promptApiKey(provider, opts.apiKey);
  const models = await selectModelsInteractive(opts.models);
  const profile = await selectProfileInteractive(opts.profile, models);

  // --- Résolution tolérante des slugs (OpenRouter + Kilo Gateway) ---
  // L'utilisateur peut saisir un nom familier ("gpt-4o", "nemotron 3.5 lightning")
  // au lieu du slug exact ("openai/gpt-4o", "nvidia/nemotron-3.5-lightning:free").
  // Sans résolution, le provider renvoie HTTP 400 "X is not a valid model ID" pour
  // chaque appel et le run produit un rapport 0/2752 inutile.
  // On résout chaque slug avant de lancer le batch : exact → alias → préfixe →
  // sous-chaîne. Si ambigu ou introuvable, on propose des suggestions.
  // OpenRouter et Kilo Gateway partagent le même format de slug (provider/model).
  if (provider === 'openrouter' || provider === 'kilo') {
    const resolver = provider === 'openrouter' ? resolveOpenRouterSlug : resolveKiloSlug;
    const resolvedModels = [];
    const nonInteractive = opts.yes || !process.stdin.isTTY || !process.stdout.isTTY;
    for (let i = 0; i < models.length; i++) {
      const input = models[i];
      const r = await resolver(input);
      if (r.offline) {
        // Réseau indisponible : on garde le slug tel quel (comportement historique).
        resolvedModels.push(input);
        continue;
      }
      if (r.resolved) {
        if (r.slug !== input) {
          console.log(`  ${C.green}✔${C.reset} ${C.bold}${input}${C.reset} ${C.gray}->${C.reset} ${C.bold}${r.slug}${C.reset} ${C.gray}(${r.matchedBy})${C.reset}`);
        }
        resolvedModels.push(r.slug);
        continue;
      }
      // Non résolu : en mode --yes / non-TTY (batch de nuit), on NE DEMANDE RIEN.
      // On garde le slug tel quel et on continue — le runner affichera un
      // avertissement puis l'erreur HTTP 400 fatale arrêtera CE modèle proprement,
      // sans bloquer toute la file d'attente. Un prompt en mode nuit = batch figé
      // jusqu'au réveil de l'utilisateur (bug signalé : « il s'arrête en chemin »).
      if (nonInteractive) {
        console.log(`  ${C.yellow}⚠ MODÈLE NON RECONNU : ${input} — gardé tel quel (mode --yes, aucune interaction).${C.reset}`);
        if (r.suggestions && r.suggestions.length > 0) {
          console.log(`  ${C.gray}Suggestions proches : ${r.suggestions.slice(0, 3).join(', ')}${C.reset}`);
        }
        resolvedModels.push(input);
        continue;
      }
      // Interactif (TTY sans --yes) : on affiche les suggestions et demande quoi faire.
      console.log(`\n  ${C.yellow}━━━ MODÈLE NON RECONNU : ${input} ━━━${C.reset}`);
      if (r.suggestions && r.suggestions.length > 0) {
        console.log(`  ${C.gray}Suggestions proches :${C.reset}`);
        r.suggestions.forEach((s, j) => console.log(`    ${C.gray}${j + 1}.${C.reset} ${s}`));
        const choice = await askYesNoLocal(`  Garder "${input}" tel quel ? (sinon tapez le slug exact)`, false);
        if (choice) {
          resolvedModels.push(input);
        } else {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const picked = await new Promise(resolve => {
            rl.question(`  ${C.cyan}Slug à utiliser (ou numéro de suggestion, ou vide pour ignorer) :${C.reset} `, ans => {
              rl.close();
              resolve((ans || '').trim());
            });
          });
          if (!picked) {
            console.log(`  ${C.gray}Modèle "${input}" ignoré.${C.reset}`);
            continue;
          }
          const n = parseInt(picked, 10);
          if (Number.isInteger(n) && n >= 1 && n <= r.suggestions.length) {
            resolvedModels.push(r.suggestions[n - 1]);
          } else {
            resolvedModels.push(picked);
          }
        }
      } else {
        console.log(`  ${C.red}Aucune suggestion trouvée.${C.reset}`);
        const choice = await askYesNoLocal(`  Garder "${input}" tel quel ?`, false);
        if (choice) {
          resolvedModels.push(input);
        } else {
          console.log(`  ${C.gray}Modèle "${input}" ignoré.${C.reset}`);
        }
      }
    }
    if (resolvedModels.length === 0) {
      console.log(`\n  ${C.red}Aucun modèle valide après résolution. Abandon.${C.reset}`);
      process.exit(1);
    }
    models.length = 0;
    for (const m of resolvedModels) models.push(m);
  }

  // --- Filtrage des modèles non-LLM (embeddings, OCR, rerank, vision-only) ---
  // BenchGo évalue des LLM génératifs : un modèle d'embeddings (ex:
  // liquid/lfm-2.5-embedding-350m) ne produit pas de code et échoue toutes les
  // tâches (bypassées par le profilage) → score 0/0, classé à tort "TOP DU TOP".
  // On les détecte via NON_LLM_PATTERNS et on les exclut du batch.
  const rejected = [];
  const filteredModels = [];
  for (const m of models) {
    if (isNonLlmCloudModel(m)) rejected.push(m);
    else filteredModels.push(m);
  }
  if (rejected.length > 0) {
    console.log(`\n  ${C.yellow}━━━ MODÈLES NON-LLM REJETÉS (${rejected.length}) ━━━${C.reset}`);
    console.log(`  ${C.gray}Modèles d'embeddings / OCR / rerank / vision-only — non testables par BenchGo.${C.reset}`);
    rejected.forEach(m => console.log(`  ${C.red}✘${C.reset} ${m}`));
    console.log(`  ${C.gray}Astuce : si le modèle est bien un LLM génératif, le slug contient un mot-clé${C.reset}`);
    console.log(`  ${C.gray}        qui déclenche le filtre (ex: 'embed', 'ocr', 'rerank'). Renommez le slug.${C.reset}\n`);
    if (filteredModels.length === 0) {
      console.log(`  ${C.red}Aucun modèle LLM à tester après filtrage. Abandon.${C.reset}`);
      process.exit(1);
    }
  }
  // On remplace la liste par la version filtrée pour la suite du batch.
  models.length = 0;
  for (const m of filteredModels) models.push(m);

  const profileLabel = (CLOUD_PROFILES.find(p => p.key === profile) || {}).label || profile;
  // En mode AUTO, chaque modèle reçoit son profil individuel (résolu au moment
  // du run). On affiche l'attribution dès le résumé pour validation visuelle.
  const isAutoProfile = profile === 'AUTO';
  const modelProfiles = models.map(m => isAutoProfile ? profileForModel(m) : profile);

  console.log(`\n  ${C.bold}${C.green}=== RESUME DE LA SESSION ===${C.reset}`);
  console.log(`  ${C.bold}Provider  :${C.reset} ${provider}`);
  if (endpoint) console.log(`  ${C.bold}Endpoint  :${C.reset} ${endpoint}`);
  console.log(`  ${C.bold}Modeles  :${C.reset} ${models.length} modele(s)`);
  models.forEach((m, i) => {
    const profTag = isAutoProfile ? ` ${C.magenta}[${modelProfiles[i]}]${C.reset}` : '';
    console.log(`    ${C.gray}${i + 1}.${C.reset} ${m}${profTag}`);
  });
  console.log(`  ${C.bold}Profil    :${C.reset} ${profileLabel}`);
  console.log(`  ${C.bold}Professeur:${C.reset} ${opts.noTeacher ? 'desactive' : 'active'}`);
  console.log(`  ${C.bold}Heure     :${C.reset} ${nowClock()}\n`);

  console.log(`  ${C.gray}Lancement dans 3 secondes (Ctrl+C pour annuler)...${C.reset}`);
  await new Promise(r => setTimeout(r, 3000));

  const results = [];
  const sessionStart = Date.now();

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const runProfile = modelProfiles[i];
    console.log(`\n  ${C.cyan}━━━ Modele ${i + 1}/${models.length} ━━━${C.reset}`);
    if (isAutoProfile) {
      console.log(`  ${C.gray}Profil AUTO pour ${model} : ${runProfile}${C.reset}`);
    }
    const res = runModel(provider, model, apiKey, opts.noTeacher, endpoint, runProfile);
    results.push({ model, ...res });
    console.log(`  ${C.gray}Heure de fin : ${nowClock()} — duree : ${fmtDuration(res.durationMs)}${C.reset}`);
    if (!res.ok) {
      console.log(`  ${C.yellow}Modele ${model} : run termine avec code ${res.exitCode} (non zero).${C.reset}`);
    } else {
      console.log(`  ${C.green}Modele ${model} : run OK.${C.reset}`);
    }
    // Petite pause entre les modeles pour eviter le rate limiting.
    if (i < models.length - 1) {
      console.log(`  ${C.gray}Pause de 5s avant le modele suivant (anti rate-limit)...${C.reset}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // --- Resume final ---
  const sessionDuration = Date.now() - sessionStart;
  console.log(`\n  ${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}           RESUME DE LA SESSION FRONTIERE              ${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(`  ${C.bold}Date      :${C.reset} ${nowDate()} ${nowClock()}`);
  console.log(`  ${C.bold}Provider  :${C.reset} ${provider}`);
  console.log(`  ${C.bold}Profil    :${C.reset} ${profileLabel}`);
  console.log(`  ${C.bold}Duree     :${C.reset} ${fmtDuration(sessionDuration)}`);
  console.log(`  ${C.bold}Modeles   :${C.reset} ${results.length} teste(s)`);
  const okCount = results.filter(r => r.ok).length;
  console.log(`  ${C.bold}Succes    :${C.reset} ${C.green}${okCount}${C.reset}/${results.length}`);
  console.log('');
  results.forEach((r, i) => {
    const status = r.ok ? `${C.green}OK${C.reset}` : `${C.red}ECHEC${C.reset}`;
    console.log(`    ${String(i + 1).padStart(2)}. ${status}  ${r.model}  ${C.gray}(${fmtDuration(r.durationMs)})${C.reset}`);
  });
  console.log('');

  // Genere le classement final (classement.html / classement.md).
  console.log(`  ${C.gray}Generation du classement final...${C.reset}`);
  try {
    const { generateLeaderboard } = require('./leaderboard');
    generateLeaderboard();
    console.log(`  ${C.green}Classement regenere.${C.reset}`);
  } catch (e) {
    console.log(`  ${C.yellow}Classement : ${e.message}${C.reset}`);
  }

  console.log(`\n  ${C.bold}${C.green}Session terminee. Rapports dans Export-Rapports/.${C.reset}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error(`\n  ${C.red}[ERREUR FATALE]${C.reset} ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});