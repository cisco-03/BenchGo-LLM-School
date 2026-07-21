// cli-table.js — Utilitaire d'affichage de tableaux CLI alignés dynamiquement.
//
// Problème : runner.js, score-ledger.js, leaderboard.js et presets.js
// utilisaient des padEnd/padStart à largeurs fixes. Dès qu'une cellule dépassait
// la largeur prévue (nom d'exercice > 22 car., classe > 18 car., modèle > 40
// car.), toutes les colonnes suivantes se décalaient et les chiffres n'étaient
// plus alignés.
//
// Solution : largeurs calculées dynamiquement en fonction du contenu réel,
// détection automatique des codes ANSI (la longueur affichée diffère de la
// longueur de la chaîne), troncature propre avec ellipsis, et alignements
// left/right/center. Aucune dépendance externe (Node.js built-ins only).

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  if (text == null) return '';
  return String(text).replace(ANSI_RE, '');
}

function visibleLen(text) {
  return stripAnsi(text).length;
}

function col(text, width, align) {
  const s = text == null ? '' : String(text);
  const vlen = visibleLen(s);
  if (vlen > width) {
    if (width <= 1) return s.substring(0, width);
    const cut = stripAnsi(s).substring(0, Math.max(0, width - 1));
    return cut + '…';
  }
  const pad = width - vlen;
  if (align === 'right') {
    return ' '.repeat(pad) + s;
  }
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  }
  return s + ' '.repeat(pad);
}

function computeWidths(headers, rows, pad, footers) {
  const ncol = headers.length;
  const widths = new Array(ncol).fill(0);
  for (let i = 0; i < ncol; i++) {
    widths[i] = Math.max(widths[i], visibleLen(headers[i]));
  }
  for (const row of rows) {
    for (let i = 0; i < ncol; i++) {
      if (row[i] != null) {
        widths[i] = Math.max(widths[i], visibleLen(row[i]));
      }
    }
  }
  if (footers) {
    const arr = Array.isArray(footers[0]) ? footers : [footers];
    for (const row of arr) {
      for (let i = 0; i < ncol; i++) {
        if (row[i] != null) {
          widths[i] = Math.max(widths[i], visibleLen(row[i]));
        }
      }
    }
  }
  if (pad) {
    for (let i = 0; i < ncol; i++) {
      widths[i] = Math.max(widths[i], pad[i] != null ? pad[i] : 0);
    }
  }
  return widths;
}

function table(headers, rows, options) {
  const opts = options || {};
  const aligns = opts.colAligns || headers.map(() => 'left');
  const pad = opts.pad || null;
  const footers = opts.footer || opts.footers || null;
  const footerAligns = opts.footerAligns || aligns;
  const separator = opts.separator != null ? opts.separator : '  ';
  const widths = computeWidths(headers, rows || [], pad, footers);
  const sepLine = widths.map(w => '─'.repeat(w)).join(separator);

  const lines = [];
  lines.push(headers.map((h, i) => col(h, widths[i], 'left')).join(separator));
  lines.push(sepLine);
  for (const row of rows || []) {
    lines.push(row.map((c, i) => col(c, widths[i], aligns[i] || 'left')).join(separator));
  }
  const footerLines = [];
  if (footers) {
    const arr = Array.isArray(footers[0]) ? footers : [footers];
    for (let fi = 0; fi < arr.length; fi++) {
      footerLines.push(arr[fi].map((c, i) => col(c, widths[i], footerAligns[i] || 'left')).join(separator));
    }
  }
  return { lines, widths, sepLine, footerLines };
}

module.exports = { stripAnsi, visibleLen, col, table, computeWidths };