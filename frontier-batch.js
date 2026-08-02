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
// On exclut les serveurs locaux (ollama, lmstudio, custom) : ce script est
// dedie aux modeles cloud frontiere.
const CLOUD_PROVIDERS = [
  { key: 'openrouter', label: 'OpenRouter (agregateur, modeles gratuits dispo)' },
  { key: 'openai',     label: 'OpenAI (GPT-4o, o1, etc.)' },
  { key: 'groq',       label: 'Groq (inference ultra-rapide)' },
  { key: 'together',   label: 'Together AI' },
  { key: 'mistral',    label: 'Mistral AI' },
  { key: 'anthropic',  label: 'Anthropic (Claude)' },
  { key: 'deepseek',   label: 'DeepSeek' },
  { key: 'cohere',     label: 'Cohere' }
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
  const opts = { provider: null, models: null, noTeacher: false, apiKey: null };
  for (const a of args) {
    if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else if (a.startsWith('--models=')) opts.models = a.slice('--models='.length);
    else if (a.startsWith('--api-key=')) opts.apiKey = a.slice('--api-key='.length);
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

${C.bold}Options :${C.reset}
  --provider=<name>   Provider cloud (openrouter, openai, groq, together, mistral, anthropic, deepseek, cohere)
  --models=<list>     Liste de modeles separes par virgules
  --api-key=<key>     Cle API pour le provider (sinon recuperee depuis .api-keys.json ou saisie)
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
function promptApiKey(provider, cliApiKey) {
  return new Promise(resolve => {
    if (cliApiKey) { resolve(cliApiKey); return; }
    const stored = getStoredApiKey(provider);
    if (stored) {
      console.log(`  ${C.gray}Cle API ${provider} recuperee depuis .api-keys.json.${C.reset}`);
      resolve(stored);
      return;
    }
    console.log(`\n  ${C.bold}${C.cyan}=== CLE API ${provider.toUpperCase()} ===${C.reset}`);
    console.log(`  ${C.gray}Aucune cle memorisee pour ${provider}.${C.reset}`);
    console.log(`  ${C.gray}Saisissez votre cle API (elle restera en memoire pour cette session).${C.reset}`);
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
    rl.question(`  ${C.cyan}Cle API :${C.reset} `, answer => {
      rl.close();
      const key = (answer || '').trim();
      if (!key) {
        console.log(`  ${C.red}Cle API manquante. Abandon.${C.reset}`);
        process.exit(1);
      }
      resolve(key);
    });
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
function runModel(provider, model, apiKey, noTeacher) {
  const args = [
    RUNNER, 'all',
    '--force',
    '--provider=' + provider,
    '--model=' + model,
    '--profile=FRONTIER',
    '--api-key=' + apiKey
  ];
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
  const apiKey = await promptApiKey(provider, opts.apiKey);
  const models = await selectModelsInteractive(opts.models);

  console.log(`\n  ${C.bold}${C.green}=== RESUME DE LA SESSION ===${C.reset}`);
  console.log(`  ${C.bold}Provider  :${C.reset} ${provider}`);
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
    const res = runModel(provider, model, apiKey, opts.noTeacher);
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