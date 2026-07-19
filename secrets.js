// secrets.js — Gestion et masquage des clés API dans le CLI.
//
// Objectifs :
//  1. Ne JAMAIS laisser une clé API visible en clair de façon persistante dans
//     l'invite de commande. Le risque principal : copie d'écran, logs de shell,
//     partage de terminal, ou historique PowerShell visible par un tiers.
//  2. Pendant la saisie, on masque caractère par caractère (affichage d'un
//     astérisque '*' au lieu du caractère réel) — lecture via écoute bas niveau
//     de stdin pour ne pas dépendre d'une librairie externe.
//  3. On autorise un aperçu temporaire (affichage clair pendant quelques secondes
//     puis re-masquage) pour vérifier ce qu'on a tapé. Le délai est configurable.
//  4. Les clés saisies sont stockées en mémoire vive (this.runSecrets), jamais
//     écrites sur disque. Elles survivent aux changements d'école au cours
//     d'une même session CLI, mais disparaissent quand le processus s'arrête.

const readline = require('readline');

// Dépôt en mémoire des clés saisies pendant la session courante.
// Clé : nom logique (ex: 'openrouter', 'openai', 'ollama', 'teacher-openrouter').
// Valeur : clé API en clair.
const _runSecrets = {};

// Retient si une clé a été fournie via la ligne de commande pour ne pas la
// redemander interactivement.
const _cliProvided = new Set();

function rememberSecret(name, value, fromCli = false) {
  if (!name || !value) return;
  _runSecrets[name] = value;
  if (fromCli) _cliProvided.add(name);
}

function getSecret(name) {
  return _runSecrets[name] || null;
}

function hasSecret(name) {
  return Boolean(_runSecrets[name]);
}

function isCliProvided(name) {
  return _cliProvided.has(name);
}

function forgetSecret(name) {
  delete _runSecrets[name];
  _cliProvided.delete(name);
}

function clearAll() {
  for (const k of Object.keys(_runSecrets)) delete _runSecrets[k];
  _cliProvided.clear();
}

// --- Masquage pour affichage / logs ---

// Masque une clé en ne laissant que des indices visibles :
//  - Préfixe reconnaissable (sk-, sk-or-v1-, sk-proj-, Bearer, ...) si détectable
//  - 4 premiers + 4 derniers caractères sinon
//  - Le reste remplacé par des astérisques.
function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (v.length <= 8) return '*'.repeat(v.length);

  // Préfixes d'identification connus — on les garde visibles pour aider
  // l'utilisateur à reconnaître le type de clé.
  const knownPrefixes = [
    'sk-or-v1-',
    'sk-or-',
    'sk-proj-',
    'sk-ant-',
    'sk-',
    'gsk_',
    'AIza',
    'cr_',
    'Bearer ',
    'xai-',
    'tok-'
  ];
  let prefix = '';
  for (const p of knownPrefixes) {
    if (v.startsWith(p)) { prefix = p; break; }
  }

  if (prefix) {
    const tail = v.slice(prefix.length);
    if (tail.length <= 6) return prefix + '*'.repeat(tail.length);
    const head = tail.slice(0, 2);
    const foot = tail.slice(-3);
    return prefix + head + '*'.repeat(Math.max(4, tail.length - 5)) + foot;
  }

  // Pas de préfixe connu : 4 premiers + 4 derniers.
  return v.slice(0, 4) + '*'.repeat(Math.max(4, v.length - 8)) + v.slice(-4);
}

// Raccourci pour le rendu console : retourne une chaîne déjà colorée.
function maskedForDisplay(value) {
  return `\x1b[33m${maskSecret(value)}\x1b[0m`;
}

// --- Lecture d'une clé depuis stdin, masquée à l'écran ---

// Lit une ligne de stdin caractère par caractère en n'affichant que des '*'.
// On désactive l'écho du TTY pendant la lecture pour éviter qu'un caractère
// frappé s'affiche en clair. La touche Entrée valide, Échap annule, Backspace
// efface le dernier caractère, Ctrl+C interrompt normalement.
//
// Si le terminal n'est pas un TTY (ex: pipe), on repasse sur readline classique.
//
// `revealMs` : si > 0, on propose (après validation) un aperçu clair pendant
// `revealMs` millisecondes avant de re-masquer. 0 = pas d'aperçu.
function askSecret(question, { revealMs = 3000, allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} `, (answer) => {
        rl.close();
        const v = (answer || '').trim();
        if (!v && !allowEmpty) return resolve(null);
        resolve(v);
      });
      return;
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    let buffer = '';

    stdout.write(question + ' ');
    // Bascule en mode raw (caractère par caractère) sans écho.
    const wasRaw = stdin.isRaw;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        // Ctrl+C (0x03) : on laisse le signal se propager naturellement.
        if (ch === 0x03) { cleanup(); process.exit(0); }
        // Entrée (\r ou \n) : fin de saisie.
        else if (ch === 0x0d || ch === 0x0a) {
          stdout.write('\n');
          cleanup();
          const v = buffer.trim();
          if (!v && !allowEmpty) {
            // On réaffiche un prompt d'erreur discret.
            stdout.write('  \x1b[33mSaisie vide — clé ignorée.\x1b[0m\n');
            return resolve(null);
          }
          // Aperçu temporaire ?
          if (revealMs > 0 && v) {
            revealThenMask(v, revealMs).then(() => resolve(v));
          } else {
            resolve(v);
          }
          return;
        }
        // Échap (0x1b) : annule.
        else if (ch === 0x1b) {
          stdout.write('\n');
          cleanup();
          stdout.write('  \x1b[33mSaisie annulée.\x1b[0m\n');
          return resolve(null);
        }
        // Backspace (0x7f ou 0x08) : efface le dernier caractère.
        else if (ch === 0x7f || ch === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write('\b \b');
          }
        }
        // Caractère normal : on l'ajoute au buffer et on affiche '*'.
        else if (ch >= 0x20 && ch < 0x7f) {
          buffer += String.fromCharCode(ch);
          stdout.write('*');
        }
        // Les autres (séquences d'échappement, etc.) sont ignorées.
      }
    };

    stdin.on('data', onData);
  });
}

// Affiche la clé en clair pendant `ms` millisecondes, avec un compte à rebours,
// puis la remplace par sa version masquée sur la même ligne.
function revealThenMask(value, ms) {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    stdout.write(`  \x1b[2m↓ Aperçu (${Math.round(ms / 1000)}s) :\x1b[0m \x1b[33m${value}\x1b[0m`);
    // Clignotement discret : à chaque seconde on met à jour le compteur.
    let remaining = Math.round(ms / 1000);
    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(interval);
        // Efface la ligne d'aperçu (carriage return + espace) et remplace.
        stdout.write('\r\x1b[K');
        stdout.write(`  \x1b[2mClé masquée :\x1b[0m ${maskedForDisplay(value)}\n`);
        resolve();
      } else {
        // Réécrit la ligne avec le nouveau décompte.
        stdout.write('\r\x1b[K');
        stdout.write(`  \x1b[2m↓ Aperçu (${remaining}s) :\x1b[0m \x1b[33m${value}\x1b[0m`);
      }
    }, 1000);
  });
}

module.exports = {
  rememberSecret,
  getSecret,
  hasSecret,
  isCliProvided,
  forgetSecret,
  clearAll,
  maskSecret,
  maskedForDisplay,
  askSecret
};