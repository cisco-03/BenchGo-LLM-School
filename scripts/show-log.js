// scripts/show-log.js — Affiche le log du serveur interactif BenchGo.
//
// Usage :
//   node scripts/show-log.js                → affiche logs/serveur.log en entier
//   node scripts/show-log.js --tail 50     → affiche les 50 dernières lignes
//   node scripts/show-log.js --grep ERROR  → filtre les lignes contenant ERROR
//   node scripts/show-log.js --watch        → suit le log en direct (live)
//
// Le serveur interactif (node leaderboard.js --serve) écrit TOUS ses logs dans
// un fichier FIXE : logs/serveur.log, remis à zéro à chaque démarrage.
// Pas d'accumulation de fichiers timestamp — un seul fichier, toujours là.
// Ouvrez un second terminal pendant que le serveur tourne pour voir les erreurs.

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'serveur.log');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { tail: 0, grep: null, watch: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tail' || args[i] === '-t') {
      opts.tail = parseInt(args[i + 1], 10) || 0;
      i++;
    } else if (args[i] === '--grep' || args[i] === '-g') {
      opts.grep = args[i + 1] || null;
      i++;
    } else if (args[i] === '--watch' || args[i] === '-w') {
      opts.watch = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

const opts = parseArgs();

if (opts.help) {
  console.log('Usage: node scripts/show-log.js [--tail N] [--grep MOTIF] [--watch]');
  console.log('');
  console.log('  (sans argument)   Affiche logs/serveur.log en entier');
  console.log('  --tail N, -t N    Affiche les N dernieres lignes');
  console.log('  --grep M, -g M    Filtre les lignes contenant M (ex: ERROR, /api)');
  console.log('  --watch, -w       Suit le log en direct (comme tail -f)');
  console.log('  --help, -h        Affiche cette aide');
  console.log('');
  console.log('Le fichier surveille est toujours : logs/serveur.log');
  process.exit(0);
}

if (!fs.existsSync(LOG_FILE)) {
  console.log('Aucun log serveur trouve : ' + LOG_FILE);
  console.log('Lancez dabord le serveur : node leaderboard.js --serve');
  process.exit(1);
}

function readLines() {
  return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(l => l.length > 0);
}

function display(lines) {
  console.log('=== logs/serveur.log ===');
  console.log('=== ' + lines.length + ' ligne(s) ===');
  console.log('');
  lines.forEach(l => console.log(l));
}

if (opts.watch) {
  // Mode suivi en direct : affiche d'abord le contenu actuel, puis surveille
  // les ajouts via fs.watchFile (polling, portable Windows).
  let lines = readLines();
  let lastCount = lines.length;
  display(lines);
  console.log('\n--- (en attente de nouvelles lignes, Ctrl+C pour quitter) ---\n');
  fs.watchFile(LOG_FILE, { interval: 1000 }, () => {
    const fresh = readLines();
    if (fresh.length > lastCount) {
      for (let i = lastCount; i < fresh.length; i++) {
        console.log(fresh[i]);
      }
      lastCount = fresh.length;
    }
  });
  process.on('SIGINT', () => { fs.unwatchFile(LOG_FILE); process.exit(0); });
  return;
}

let lines = readLines();
if (opts.grep) {
  const g = opts.grep.toUpperCase();
  lines = lines.filter(l => l.toUpperCase().indexOf(g) !== -1);
}
if (opts.tail > 0 && opts.tail < lines.length) {
  lines = lines.slice(lines.length - opts.tail);
}
display(lines);