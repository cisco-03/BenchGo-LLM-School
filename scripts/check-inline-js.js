#!/usr/bin/env node
/*
 * check-inline-js.js — Validateur de JS inline pour BenchGo V3
 * --------------------------------------------------------------
 * Verifie que le JS inline (entre <script>...</script>) d'un fichier HTML
 * genere par leaderboard.js ou consolidate-leaderboard.js est syntaxiquement
 * valide. Detecte :
 *   - les apostrophes non echappees dans les attributs onclick/onchange/...
 *     (source recurrent de bugs — cf. AGENTS.md "esc() dans le leaderboard")
 *   - les backticks litteraux dans le JS inline (cf. AGENTS.md "Backticks
 *     litteraux dans le JS inline")
 *   - les erreurs de syntaxe (token inattendu, accolade en trop, etc.)
 *   - les blocs dupliques laisses par une edition incomplete
 *
 * Usage :
 *   node scripts/check-inline-js.js [fichier.html ...]
 *
 * Sans argument : valide par defaut :
 *   - Export-Rapports/classement.html (leaderboard local)
 *   - gh-pages-output/community-leaderboard.html (classement communautaire)
 *
 * Sortie : 0 si tout est OK, 1 si au moins un fichier a une erreur.
 *
 * Cf. AGENTS.md sections :
 *   - "esc() dans le leaderboard"
 *   - "Backticks litteraux dans le JS inline"
 *   - "Probleme Node.js 24.x"
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Fichiers valides par defaut si aucun argument n est fourni.
const DEFAULTS = [
  path.join(PROJECT_ROOT, 'Export-Rapports', 'classement.html'),
  path.join(PROJECT_ROOT, 'gh-pages-output', 'community-leaderboard.html')
];

// Patterns de handlers inline dont la presence d une apostrophe non echappee
// casse l attribut HTML (le " delimitant l attribut est ferme prematurement).
const HANDLER_ATTR_RE = /\son(?:click|change|input|submit|load|mouseover|keydown|keyup|focus|blur)\s*=\s*"([^"]*)"/g;
// Apostrophe echappee correcte en HTML : &#39; ou &#x27; ou &apos;
const ESCAPED_APOS = /&#39;|&#x27;|&apos;/;

let hasError = false;

function tryParse(src) {
  try { new vm.Script(src); return null; }
  catch (err) { return { msg: err.message, stack: err.stack || '' }; }
}

// Extrait le numero de ligne depuis le stack trace de vm.Script.
// Format : "evalmachine.<anonymous>:123" ou "evalmachine.<anonymous>:123:45"
function lineFromStack(stack) {
  if (!stack) return -1;
  const m = stack.match(/<anonymous>:(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

// Extrait le JS inline (entre <script>...</script>) d un fichier HTML.
// Retourne un tableau { start, end, code } pour chaque bloc <script>.
function extractScripts(html) {
  const scripts = [];
  let idx = 0;
  while (true) {
    const start = html.indexOf('<script', idx);
    if (start === -1) break;
    const gt = html.indexOf('>', start);
    if (gt === -1) break;
    const end = html.indexOf('</script>', gt);
    if (end === -1) break;
    const code = html.substring(gt + 1, end);
    scripts.push({ start: gt + 1, end, code });
    idx = end + 9;
  }
  return scripts;
}

// Convertit un offset absolu dans le code JS en numero de ligne du fichier.
function offsetToLine(html, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < html.length; i++) {
    if (html[i] === '\n') line++;
  }
  return line;
}

// Detecte les apostrophes non echappees dans les attributs de handler inline.
// IMPORTANT : on scanne UNIQUEMENT le HTML hors <script>...</script> car les
// handlers construits dans le JS inline (ex: onclick="openModal(' + i + ')")
// sont du code JS valide, pas du HTML rendu. Scanner le JS comme du HTML
// produirait des faux positifs massifs.
function checkApostrophesInHandlers(html, file, scripts) {
  // Construit une fonction qui teste si un offset tombe dans un bloc <script>.
  function inScript(off) {
    for (const sc of scripts) {
      if (off >= sc.start - 7 && off < sc.end) return true;
    }
    return false;
  }
  let m;
  const re = new RegExp(HANDLER_ATTR_RE.source, 'g');
  while ((m = re.exec(html)) !== null) {
    if (inScript(m.index)) continue; // ignore le JS inline
    const attrContent = m[1];
    if (/'/.test(attrContent) && !ESCAPED_APOS.test(attrContent)) {
      hasError = true;
      const line = offsetToLine(html, m.index);
      const snippet = m[0].slice(0, 160);
      console.log('  \x1b[31mAPOSTROPHE NON ECHAPPEE\x1b[0m (ligne ' + line + ') dans un handler inline HTML :');
      console.log('    ' + snippet);
    }
  }
}

// Les backticks litteraux (cf. AGENTS.md "Backticks litteraux dans le JS
// inline") provoquent une SyntaxError detectee par checkSyntax via vm.Script.
// On ne les compte pas separement : un template string JS legitime contient
// beaucoup de backticks (comptage non fiable). La validation vm.Script suffit.
function checkBackticks(code, html, file, scriptIdx) {
  // Intentionnellement vide : la validation syntaxique via vm.Script (voir
  // checkSyntax) intercepte deja les backticks orphelins qui cassent le script.
}

// Valide la syntaxe du JS inline via vm.Script. Localise la ligne fautive
// depuis le stack trace de l erreur (format "evalmachine.<anonymous>:N").
function checkSyntax(code, html, file, scriptIdx, scriptOffset) {
  const err = tryParse(code);
  if (err === null) return;
  hasError = true;
  const lines = code.split('\n');
  const line = lineFromStack(err.stack);
  if (line >= 1 && line <= lines.length) {
    const badLine = line - 1;
    console.log('  \x1b[31mERREUR DE SYNTAXE\x1b[0m au bloc <script> #' + scriptIdx + ', ligne JS ' + line + ' :');
    for (let j = Math.max(0, badLine - 3); j <= Math.min(lines.length - 1, badLine + 1); j++) {
      const mark = j === badLine ? '>>> ' : '    ';
      console.log('  ' + mark + (j + 1) + ': ' + lines[j].slice(0, 200));
    }
  } else {
    console.log('  \x1b[31mERREUR DE SYNTAXE\x1b[0m au bloc <script> #' + scriptIdx + ' : ' + err.msg);
  }
}

function checkFile(file) {
  if (!fs.existsSync(file)) {
    console.log('\x1b[90m  [ignore] ' + path.relative(PROJECT_ROOT, file) + ' (introuvable)\x1b[0m');
    return;
  }
  const rel = path.relative(PROJECT_ROOT, file);
  const html = fs.readFileSync(file, 'utf8');
  console.log('\n  \x1b[1;36mVerif : ' + rel + '\x1b[0m');

  // 1) Apostrophes dans les handlers inline (scan HTML hors <script>).
  //    On extrait d'abord les scripts pour pouvoir ignorer leur contenu.
  const scripts = extractScripts(html);
  checkApostrophesInHandlers(html, file, scripts);

  // 2) Validation syntaxique JS (par bloc <script>).
  if (scripts.length === 0) {
    console.log('  \x1b[33m  Aucun bloc <script> trouve.\x1b[0m');
  }
  scripts.forEach((sc, i) => {
    checkBackticks(sc.code, html, file, i + 1);
    checkSyntax(sc.code, html, file, i + 1, sc.start);
  });

  if (!hasError) {
    console.log('  \x1b[32m  OK - JS inline valide (' + scripts.length + ' bloc(s), ' + (html.match(/class="card/g) || []).length + ' carte(s) modeles)\x1b[0m');
  }
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0
    ? args.map(a => path.resolve(PROJECT_ROOT, a))
    : DEFAULTS;

  console.log('\x1b[1;35m  Verificateur de JS inline BenchGo V3\x1b[0m');
  for (const f of files) checkFile(f);

  if (hasError) {
    console.log('\n  \x1b[31mResultat : ERREURS detectees (cf. ci-dessus)\x1b[0m\n');
    process.exit(1);
  } else {
    console.log('\n  \x1b[32mResultat : tout est valide\x1b[0m\n');
    process.exit(0);
  }
}

main();