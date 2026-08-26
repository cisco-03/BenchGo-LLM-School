// cli-help.js — Aide contextuelle, status, dry-run et codes d'erreur lisibles.
//
// Plan d'amélioration §1 (CLI / UX) :
//   • help contextuel (par commande + exemples) → printHelp()
//   • `node runner.js status` (dernière école, modèle, tier) → printStatus()
//   • `node runner.js --dry-run` (valide la config sans exécuter) → dry-run flag
//   • Erreurs lisibles avec code court (E502_LM_TIMEOUT...) → BenchgoError
//
// Toutes ces fonctions sont des actions uniques (side-effect puis exit) sauf
// BenchgoError qui est levée/attrapée par le runner pour afficher un message
// propre sans stack par défaut.

const fs = require('fs');
const path = require('path');
const { PROFILES, parseCliArgs } = require('./config');
const logger = require('./logger');

// Toute cette section CLI/UX journalise ses décisions dans le fichier de log
// courant (logs/benchgo_<timestamp>.log). Cela permet de retracer chaque
// action unique (help, status, version, dry-run) et chaque erreur code-court
// (E502_..., E601_...) si un bug est remonté plus tard par l'utilisateur.

// --- Fichier de résumé du dernier run (pour `status` et reprise) ---
const LAST_RUN_FILE = path.join(__dirname, 'Export-Rapports', 'dernier-run.json');

// ============================================================
// Aide contextuelle (par commande + exemples)
// ============================================================

const HELP_TEXT = `
\x1b[1;36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1;36m  BENCHGO V3 — Benchmark comportemental des modèles de langage\x1b[0m
\x1b[1;36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m

\x1b[1mUSAGE\x1b[0m
  node runner.js [commande] [options] [tier]

\x1b[1mCOMMANDES (actions uniques, puis exit)\x1b[0m
  \x1b[1mhelp\x1b[0m, \x1b[1m--help\x1b[0m, \x1b[1m-h\x1b[0m   Affiche cette aide.
  \x1b[1mstatus\x1b[0m                Affiche le résumé du dernier run (école, modèle, points, santé).
  \x1b[1mversion\x1b[0m, \x1b[1m--version\x1b[0m  Affiche la version courante.
  \x1b[1m--dry-run\x1b[0m              Valide la configuration (profil, provider, modèle, clés)
                          sans exécuter le benchmark.

\x1b[1mOPTIONS\x1b[0m
  \x1b[1m--profile=\x1b[0m<N>           Profil/école : LIGHT, STANDARD, EXPERT, DOCTORAT, FRONTIER.
  \x1b[1m--provider=\x1b[0m<N>         Fournisseur cloud (openai, anthropic, openrouter, mistral, custom...).
  \x1b[1m--model=\x1b[0m<N>            Modèle à tester (mode cloud) ou id modèle LM Studio.
  \x1b[1m--api-key=\x1b[0m<N>          Clé API du provider (préférer --no-save-keys sur machine partagée).
  \x1b[1m--endpoint=\x1b[0m<N>          Endpoint API custom (rare).
  \x1b[1m--context-limit=\x1b[0m<N>     Budget contexte en tokens (défaut 16384).
  \x1b[1m--quantization=\x1b[0m<N>      Force la quantification (Q4_K_M, Q5_K_S...).
  \x1b[1m--force\x1b[0m                Mode batch : neutralise les askYesNo (re-test, pénalité).
  \x1b[1m--no-teacher\x1b[0m           Désactive le professeur IA (auto-analyse classique).
  \x1b[1m--teacher-provider=\x1b[0m<N>  Provider du professeur (openrouter, openai, groq, ollama, lmstudio...).
  \x1b[1m--teacher-model=\x1b[0m<N>     Override du modèle professeur (requis si provider != openrouter).
  \x1b[1m--teacher-api-key=\x1b[0m<N>    Clé API du professeur (OpenRouter par défaut, sinon le provider choisi).
  \x1b[1m--teacher-endpoint=\x1b[0m<N>   Endpoint custom du professeur (pour custom/ollama/lmstudio).
  \x1b[1m--submit\x1b[0m              Force la soumission communautaire (PR GitHub).
  \x1b[1m--no-telemetry\x1b[0m        Désactive le ping anonyme (compteur d'utilisateurs).
  \x1b[1m--github-token=\x1b[0m<N>       PAT GitHub pour la soumission (évite la saisie interactive).
  \x1b[1m--preset=\x1b[0m<N>           Charge un preset de configuration (fichier local).
  \x1b[1m--save-preset=\x1b[0m<N>        Sauvegarde la config courante comme preset, puis exit.
  \x1b[1m--delete-preset=\x1b[0m<N>      Supprime un preset, puis exit.
  \x1b[1m--list-presets\x1b[0m        Liste les presets, puis exit.
  \x1b[1m--forget-key=\x1b[0m<N>        Efface une clé API mémorisée, puis exit.
  \x1b[1m--list-keys\x1b[0m          Liste les clés API mémorisées, puis exit.
  \x1b[1m--no-save-keys\x1b[0m        Désactive la mémorisation des clés ce run.
  \x1b[1m--restore-carnets\x1b[0m      Restaure les carnets disparus depuis .carnet-backup/, puis exit.
  \x1b[1m--no-update-check\x1b[0m      Désactive l'avis de mise à jour au démarrage.
  \x1b[1m--hybrid\x1b[0m             Mode nuit hybride : CLI + auto-soumission GitHub si seuil atteint.

\x1b[1mEXEMPLES\x1b[0m
  \x1b[90m# Benchmark local complet (LM Studio) en auto-détection\x1b[0m
  node runner.js all
  \x1b[90m# Benchmark cloud sur un modèle précis\x1b[0m
  node runner.js all --provider=openai --model=gpt-4o --api-key=sk-...
  \x1b[90m# Classe unique (tier 2) sur LIGHT\x1b[0m
  node runner.js 2 --profile=LIGHT
  \x1b[90m# Mode nuit batch (force, pas de questions, soumission auto)\x1b[0m
  node runner.js all --force --submit --github-token=ghp_...
  \x1b[90m# Charger un preset existant\x1b[0m
  node runner.js --preset=mon-modele
  \x1b[90m# Voir le dernier run\x1b[0m
  node runner.js status
  \x1b[90m# Valider la config sans lancer le benchmark\x1b[0m
  node runner.js all --profile=STANDARD --dry-run

\x1b[1mPROFILES DISPONIBLES\x1b[0m
${Object.entries(PROFILES).map(([k, p]) => `  \x1b[1m${k.padEnd(10)}\x1b[0m ${p.label}`).join('\n')}

\x1b[1mCLASSEMENT\x1b[0m
  \x1b[1mnode leaderboard.js\x1b[0m            Génère classement.html + classement.md.
  \x1b[1mnode leaderboard.js --serve\x1b[0m     Lance le serveur interactif (port 3939 par défaut).
  \x1b[1mnode leaderboard.js --cloud\x1b[0m     Classement des modèles frontière cloud uniquement.
  \x1b[1mnode leaderboard.js --lmstudio\x1b[0m
                           Rapport de suivi complet LM Studio : modèles testés
                           (tri chrono, tests de la nuit en tête) + modèles non
                           testés [NON TESTÉ] dans une vue unifiée.
  \x1b[1mnode night-batch.js\x1b[0m             Mode nuit : enchaîne plusieurs modèles.

\x1b[90mDocumentation : Docs/Manuel-utilisateur/ (chapitres 01 à 07)\x1b[0m
\x1b[90mJournal de versions : Docs/CHANGELOG.md\x1b[0m
`;

// Affiche l'aide complète et quitte. `topic` permet une aide ciblée.
function printHelp(topic) {
  logger.info('CLI: commande unique "help" demandée' + (topic ? ' (topic=' + topic + ')' : ''));
  if (topic && topic !== 'help' && topic !== '--help' && topic !== '-h') {
    const t = topic.toLowerCase();
    const sections = {
      provider: 'OPTIONS',
      cloud: 'EXEMPLES',
      preset: 'OPTIONS',
      teacher: 'OPTIONS',
      community: 'OPTIONS',
      submit: 'OPTIONS',
      night: 'EXEMPLES',
      tier: 'USAGE',
    };
    const anchor = sections[t];
    if (anchor) {
      const idx = HELP_TEXT.indexOf(anchor);
      if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        console.log(HELP_TEXT.slice(start, Math.min(HELP_TEXT.length, idx + 800)));
        process.exit(0);
      }
    }
  }
  console.log(HELP_TEXT);
  process.exit(0);
}

// ============================================================
// status — résumé du dernier run (depuis Export-Rapports/dernier-run.json)
// ============================================================

function printStatus() {
  logger.info('CLI: commande unique "status" demandée');
  if (!fs.existsSync(LAST_RUN_FILE)) {
    logger.warn('CLI: aucun dernier-run.json trouvé — status vide.');
    console.log('\n  \x1b[33mAucun run précédent enregistré.\x1b[0m');
    console.log('  \x1b[90mLancez un benchmark : node runner.js all --profile=LIGHT\x1b[0m');
    console.log('  \x1b[90mLe résumé sera sauvegardé automatiquement dans Export-Rapports/dernier-run.json\x1b[0m\n');
    process.exit(0);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'));
  } catch (e) {
    logger.error('CLI: dernier-run.json illisible — ' + e.message);
    console.log('\n  \x1b[31mFichier dernier-run.json illisible : ' + e.message + '\x1b[0m\n');
    process.exit(1);
  }
  const ts = data.timestamp ? new Date(data.timestamp).toLocaleString('fr-FR') : '?';
  console.log('\n  \x1b[1;36m━━━ DERNIER RUN BENCHGO ━━━\x1b[0m');
  console.log('  \x1b[90mGénéré : ' + ts + '\x1b[0m\n');
  if (data.model) console.log('  \x1b[1mModèle       :\x1b[0m ' + data.model);
  if (data.provider) console.log('  \x1b[1mFournisseur  :\x1b[0m ' + (data.provider === 'local' ? 'LOCAL (LM Studio)' : data.provider.toUpperCase()));
  if (data.profile) console.log('  \x1b[1mProfil/École  :\x1b[0m ' + (PROFILES[data.profile] ? PROFILES[data.profile].label : data.profile));
  if (data.tier) console.log('  \x1b[1mCible         :\x1b[0m ' + String(data.tier).toUpperCase());
  if (typeof data.points === 'number' && typeof data.maxPoints === 'number') {
    const pct = data.maxPoints > 0 ? Math.round((data.points / data.maxPoints) * 100) : 0;
    console.log('  \x1b[1mPoints        :\x1b[0m ' + data.points + '/' + data.maxPoints + ' (' + pct + '%)');
  }
  if (typeof data.mandatoryPassed === 'number' && typeof data.mandatoryTotal === 'number' && data.mandatoryTotal > 0) {
    const mpct = Math.round((data.mandatoryPassed / data.mandatoryTotal) * 100);
    console.log('  \x1b[1mObligatoire   :\x1b[0m ' + data.mandatoryPassed + '/' + data.mandatoryTotal + ' (' + mpct + '%)');
  }
  if (typeof data.health === 'number') {
    const hc = data.health >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log('  \x1b[1mSanté         :\x1b[0m ' + hc + data.health + ' PV\x1b[0m');
  }
  if (typeof data.durationMs === 'number') {
    console.log('  \x1b[1mDurée         :\x1b[0m ' + (data.durationMs / 1000).toFixed(1) + 's');
  }
  if (data.tierReached != null) console.log('  \x1b[1mClasse atteinte:\x1b[0m ' + data.tierReached);
  if (data.reportFile) {
    console.log('  \x1b[1mRapport       :\x1b[0m ' + data.reportFile);
  }
  if (data.verdict) {
    const vc = data.verdict === 'RECOMMANDÉ' ? '\x1b[32m' : (data.verdict === 'PARTIEL' ? '\x1b[33m' : '\x1b[31m');
    console.log('  \x1b[1mVerdict       :\x1b[0m ' + vc + data.verdict + '\x1b[0m');
  }
  if (Array.isArray(data.ecoles) && data.ecoles.length > 0) {
    console.log('\n  \x1b[1mÉcoles évaluées :\x1b[0m');
    for (const e of data.ecoles) {
      const epct = e.maxPoints > 0 ? Math.round((e.points / e.maxPoints) * 100) : 0;
      console.log('    • ' + (e.ecole || '?').padEnd(20) + ' ' + e.points + '/' + e.maxPoints + ' (' + epct + '%)');
    }
  }
  console.log('');
  process.exit(0);
}

// ============================================================
// version
// ============================================================

function readVersion() {
  try {
    const p = path.join(__dirname, 'Docs', 'CHANGELOG.md');
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/v?(\d+\.\d+(?:\.\d+)?)\b/);
      if (m) return m[1];
    }
  } catch (_) {}
  return '3.x (développement)';
}

function printVersion() {
  logger.info('CLI: commande unique "version" demandée — version=' + readVersion());
  console.log('BenchGo V3 v' + readVersion());
  process.exit(0);
}

// ============================================================
// Détection des commandes uniques au démarrage
// Renvoie true si une commande a été traitée (et exit), false sinon.
// ============================================================

function handleSingleAction(rawArgs) {
  const positional = rawArgs.filter(a => !a.startsWith('--'));
  const first = (positional[0] || '').toLowerCase();
  if (first === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    logger.info('CLI: action unique détectée — help' + (positional[1] ? ' topic=' + positional[1] : ''));
    logger.close();
    printHelp(positional[1]);
    return true;
  }
  if (first === 'status') {
    logger.info('CLI: action unique détectée — status');
    logger.close();
    printStatus();
    return true;
  }
  if (first === 'version' || rawArgs.includes('--version') || rawArgs.includes('-v')) {
    logger.info('CLI: action unique détectée — version');
    logger.close();
    printVersion();
    return true;
  }
  return false;
}

// ============================================================
// Erreurs lisibles avec code court (E502_LM_TIMEOUT, etc.)
// ============================================================

const ERROR_CODES = {
  E502_LM_TIMEOUT: {
    label: 'Timeout LM Studio',
    suggestion: 'Le modèle n\'a pas répondu dans le délai imparti. Vérifiez que LM Studio tourne, que le modèle est chargé, ou augmentez API_TIMEOUT_MS dans config.js.'
  },
  E503_LM_UNREACHABLE: {
    label: 'LM Studio injoignable',
    suggestion: 'Le serveur LM Studio ne répond pas sur localhost:1234. Lancez LM Studio et démarrez le serveur local.'
  },
  E504_LM_HTTP_ERROR: {
    label: 'Erreur HTTP LM Studio',
    suggestion: 'LM Studio a renvoyé une erreur HTTP. Vérifiez les logs LM Studio, la quantification du modèle et le budget contexte.'
  },
  E601_NO_MODEL: {
    label: 'Modèle manquant',
    suggestion: '--provider est spécifié sans --model. Ajoutez --model=<nom> (ex: gpt-4o).'
  },
  E602_BAD_PROFILE: {
    label: 'Profil inconnu',
    suggestion: 'Le profil passé n\'existe pas. Choisissez parmi : LIGHT, STANDARD, EXPERT, DOCTORAT, FRONTIER.'
  },
  E603_PROMPT_TOO_LONG: {
    label: 'Prompt trop long',
    suggestion: 'Le prompt dépasse le budget contexte. Réduisez le prompt ou augmentez --context-limit.'
  },
  E701_TEACHER_UNAVAILABLE: {
    label: 'Professeur IA indisponible',
    suggestion: 'Le professeur OpenRouter n\'a pas pu corriger l\'analyse. Repli automatique sur l\'auto-analyse de l\'élève.'
  },
  E801_GITHUB_SUBMIT_FAILED: {
    label: 'Soumission GitHub échouée',
    suggestion: 'La PR GitHub n\'a pas pu être créée. Vérifiez votre PAT (scope repo) et votre connexion réseau.'
  },
  E901_CONFIG_INVALID: {
    label: 'Configuration invalide',
    suggestion: 'La configuration passée en CLI est incohérente. Lancez node runner.js help pour voir les options.'
  },
  E400_INVALID_MODEL_ID: {
    label: 'Slug modèle invalide',
    suggestion: 'Le slug du modèle n\'est pas reconnu par le provider (ex: "node" au lieu de "openai/gpt-4o"). Vérifiez le slug exact sur la page du provider, ou utilisez frontier-batch.js qui résout automatiquement les noms familiers (gpt-4o, llama-3.1-8b...) vers le slug canonique.'
  },
  E404_MODEL_NOT_FOUND: {
    label: 'Modèle introuvable',
    suggestion: 'Le modèle n\'existe pas ou a été dépublié. Vérifiez la liste des modèles disponibles sur le provider (ex: OpenRouter /api/v1/models), ou utilisez frontier-batch.js pour la résolution automatique.'
  },
  E505_MODEL_UNRESPONSIVE: {
    label: 'Modèle ne répond pas',
    suggestion: 'Le modèle ne renvoie aucun contenu (HTTP 200 mais 0 tokens). Probablement rate-limité upstream (modèle free surchargé) ou temporairement indisponible. Réessayez plus tard ou utilisez un autre modèle.'
  }
};

class BenchgoError extends Error {
  constructor(code, detail) {
    const meta = ERROR_CODES[code] || { label: code, suggestion: '' };
    const msg = detail ? `${meta.label} : ${detail}` : meta.label;
    super(`[${code}] ${msg}`);
    this.code = code;
    this.detail = detail || '';
    this.suggestion = meta.suggestion || '';
    this.isBenchgo = true;
  }

  // Affichage console propre : code + message + suggestion, sans stack.
  print() {
    logger.error('CLI: BenchgoError levée — code=' + this.code + ' — détail=' + (this.detail || '(aucun)'));
    console.error('');
    console.error(`\x1b[31m[ERREUR ${this.code}]\x1b[0m ${this.detail || ''}`);
    if (this.suggestion) {
      console.error(`\x1b[33m→ Suggestion :\x1b[0m ${this.suggestion}`);
    }
    console.error('');
  }
}

// Sauvegarde le résumé du dernier run pour `status` et la reprise.
function saveLastRun(summary) {
  try {
    fs.mkdirSync(path.dirname(LAST_RUN_FILE), { recursive: true });
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      ...summary
    }, null, 2) + '\n', 'utf8');
    logger.info('CLI: résumé du dernier run sauvegardé — ' + LAST_RUN_FILE);
  } catch (e) {
    // Non bloquant : le résumé est un confort, pas une nécessité.
    logger.warn('CLI: échec sauvegarde dernier-run.json — ' + e.message);
  }
}

// ============================================================
// printEntryHelp — aide normalisée pour les entrypoints CLI secondaires
// ============================================================
//
// Affiche un encadré ANSI façon « /help » d un bot : titre du fichier + liste
// exhaustive des commandes/flags réellement supportés. Utilisé par
// leaderboard.js, night-batch.js, frontier-batch.js, community-stats.js et
// consolidate-leaderboard.js pour offrir une aide cohérente sans dupliquer la
// mise en forme (encadré cyan, sections USAGE / COMMANDES / ASTUCES).
//
// @param {string} title  - Titre court affiché dans l encadré (ex: "leaderboard.js").
// @param {string} subtitle - Sous-titre descriptif (ex: "Génération du classement").
// @param {Array<{cmd:string, desc:string}>} commands - Liste des commandes/flags.
// @param {Array<string>} [tips] - Section astuces optionnelle (lignes libres).
function printEntryHelp(title, subtitle, commands, tips) {
  const line = '\x1b[1;36m' + '━'.repeat(73) + '\x1b[0m';
  console.log('');
  console.log(line);
  console.log('\x1b[1;36m  ' + title + '\x1b[0m' + (subtitle ? ' — ' + subtitle : ''));
  console.log(line);
  console.log('');
  console.log('\x1b[1mUSAGE\x1b[0m');
  console.log('  node ' + title + ' [options]');
  console.log('');
  console.log('\x1b[1mCOMMANDES & OPTIONS\x1b[0m');
  for (const c of commands) {
    console.log('  \x1b[1m' + c.cmd + '\x1b[0m');
    if (c.desc) console.log('      \x1b[90m' + c.desc + '\x1b[0m');
  }
  if (Array.isArray(tips) && tips.length > 0) {
    console.log('');
    console.log('\x1b[1mASTUCES\x1b[0m');
    for (const t of tips) console.log('  \x1b[90m' + t + '\x1b[0m');
  }
  console.log('');
  console.log('\x1b[90mAide aussi disponible : node runner.js --help\x1b[0m');
  console.log('');
}

// Détecte --help / help / -h dans les argv bruts. Renvoie true si l aide a été
// demandée (l appelant doit alors afficher son aide puis exit). Utilitaire
// partagé pour les entrypoints secondaires qui ne passent pas par
// handleSingleAction (réservé à runner.js).
function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h') ||
    args.some(a => a === 'help');
}

module.exports = {
  printHelp,
  printStatus,
  printVersion,
  handleSingleAction,
  printEntryHelp,
  wantsHelp,
  BenchgoError,
  ERROR_CODES,
  saveLastRun,
  LAST_RUN_FILE,
  readVersion
};