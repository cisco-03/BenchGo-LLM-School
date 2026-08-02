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

const { spawnSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;
const RUNNER = path.join(PROJECT_ROOT, 'runner.js');

// Providers cloud supportes (reprend la liste de cloud-client.js).
// On inclut aussi les serveurs OpenAI-compatibles (ollama, lmstudio, custom) :
// Ollama propose un service cloud payant (cle + base URL) en plus du local ;
// le runner les traite via cloud-client.js. Pour le local, pas de cle requise.
const CLOUD_PROVIDERS = [
  { key: 'openrouter', label: 'OpenRouter (agregateur, modeles gratuits dispo)' },
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

// Parse les arguments CLI : --provider=, --models=, --no-teacher, --api-key=
function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = { provider: null, models: null, noTeacher: false, apiKey: null, endpoint: null };
  for (const a of args) {
    if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else if (a.startsWith('--models=')) opts.models = a.slice('--models='.length);
    else if (a.startsWith('--api-key=')) opts.apiKey = a.slice('--api-key='.length);
    else if (a.startsWith('--endpoint=')) opts.endpoint = a.slice('--endpoint='.length);
    else if (a === '--no-teacher') opts.noTeacher = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${C.bold}frontier-batch.js${C.reset} - Mode batch pour modeles cloud (frontiere)

${C.bold}Usage :${C.reset}
  node frontier-batch.js                              # interactif (provider + modeles)
  node frontier-batch.js --provider=openrouter        # provider fixe
  node frontier-batch.js --models=m1,m2,m3            # modeles sans saisie
  node frontier-batch.js --provider=openrouter --models=m1,m2
  node frontier-batch.js --no-teacher                 # desactive le professeur IA
  node frontier-batch.js --api-key=sk-...             # cle API fournie
  node frontier-batch.js --provider=ollama --endpoint=https://...  # endpoint custom

${C.bold}Options :${C.reset}
  --provider=<name>   Provider cloud (openrouter, openai, anthropic, groq, together,
                      mistral, deepseek, cohere, ollama, lmstudio, custom)
  --models=<list>     Liste de modeles separes par virgules
  --api-key=<key>     Cle API pour le provider (sinon recuperee depuis .api-keys.json ou saisie)
  --endpoint=<url>    Base URL du provider (ollama/lmstudio/custom, ou override d un provider)
  --no-teacher        Desactive le professeur IA (correcteur externe)
  --help, -h          Affiche cette aide

${C.bold}Comportement :${C.reset}
  - Chaque modele est teste avec --profile=FRONTIER (Post-Doctorat, le plus haut niveau).
  - --force est passe au runner pour neutraliser les confirmations en mode non-TTY.
  - Aucune proposition d_écoles séquentielles (Primaire/Collège) : les modeles
    frontier vont directement au plus haut niveau.
`);
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
const PROVIDERS_OPTIONAL_KEY = new Set(['ollama', 'lmstudio', 'custom']);

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

// Execute le runner pour un modele cloud frontiere.
// Renvoie { ok, exitCode, durationMs }.
function runModel(provider, model, apiKey, noTeacher, endpoint) {
  const args = [
    RUNNER, 'all',
    '--force',
    '--provider=' + provider,
    '--model=' + model,
    '--profile=FRONTIER'
  ];
  if (apiKey) args.push('--api-key=' + apiKey);
  if (endpoint) args.push('--endpoint=' + endpoint);
  if (noTeacher) args.push('--no-teacher');

  console.log(`\n  ${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`  ${C.bold}${C.magenta}  TEST FRONTIERE : ${model}${C.reset}`);
  console.log(`  ${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`  ${C.gray}Heure de debut : ${nowClock()}${C.reset}`);
  console.log(`  ${C.gray}Commande : node runner.js all --force --provider=${provider} --model=<...> --profile=FRONTIER${C.reset}\n`);

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
  console.log(`  ${C.bold}${C.cyan}       FRONTIER BATCH - Modeles cloud (Post-Doctorat)    ${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}\n`);

  console.log(`  ${C.gray}Ce script enchaine le test de plusieurs modeles cloud frontiere${C.reset}`);
  console.log(`  ${C.gray}a la suite. Chaque modele passe le niveau FRONTIER (Post-Doctorat)${C.reset}`);
  console.log(`  ${C.gray}directement, sans passer par Primaire/Collège.${C.reset}\n`);

  const provider = await selectProviderInteractive(opts.provider);
  const endpoint = await promptEndpoint(provider, opts.endpoint);
  const apiKey = await promptApiKey(provider, opts.apiKey);
  const models = await selectModelsInteractive(opts.models);

  console.log(`\n  ${C.bold}${C.green}=== RESUME DE LA SESSION ===${C.reset}`);
  console.log(`  ${C.bold}Provider  :${C.reset} ${provider}`);
  if (endpoint) console.log(`  ${C.bold}Endpoint  :${C.reset} ${endpoint}`);
  console.log(`  ${C.bold}Modeles  :${C.reset} ${models.length} modele(s)`);
  models.forEach((m, i) => console.log(`    ${C.gray}${i + 1}.${C.reset} ${m}`));
  console.log(`  ${C.bold}Profil    :${C.reset} FRONTIER (Post-Doctorat)`);
  console.log(`  ${C.bold}Professeur:${C.reset} ${opts.noTeacher ? 'desactive' : 'active'}`);
  console.log(`  ${C.bold}Heure     :${C.reset} ${nowClock()}\n`);

  console.log(`  ${C.gray}Lancement dans 3 secondes (Ctrl+C pour annuler)...${C.reset}`);
  await new Promise(r => setTimeout(r, 3000));

  const results = [];
  const sessionStart = Date.now();

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    console.log(`\n  ${C.cyan}━━━ Modele ${i + 1}/${models.length} ━━━${C.reset}`);
    const res = runModel(provider, model, apiKey, opts.noTeacher, endpoint);
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