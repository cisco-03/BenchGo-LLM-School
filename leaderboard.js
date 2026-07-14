const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { letterGrade } = require('./progress-bar');
const { shortenModelName } = require('./report-generator');

const LEDGER_DIR = path.join(__dirname, 'Export-Rapports', '.carnet');
const EXPORT_DIR = path.join(__dirname, 'Export-Rapports');

// Charge tous les carnets de scores depuis Export-Rapports/.carnet/*.json
function loadAllLedgers() {
  const ledgers = [];
  if (!fs.existsSync(LEDGER_DIR)) return ledgers;
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8'));
      if (data && data.ecoles) ledgers.push(data);
    } catch (e) {
      logger.warn('Carnet illisible ignoré (' + file + ') : ' + e.message);
    }
  }
  return ledgers;
}

// Agrège un carnet en une entrée de classement.
function aggregateLedger(ledger) {
  const entries = Object.values(ledger.ecoles || {});
  if (entries.length === 0) return null;

  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  let helpCount = 0, retriedCount = 0;
  let mandatoryPassed = 0, mandatoryTotal = 0;
  const ecoles = [];

  for (const e of entries) {
    score += e.score || 0;
    max += e.max || 0;
    globalLifeScore += e.globalLifeScore || 0;
    optionalBonus += e.optionalBonus || 0;
    helpCount += e.helpCount || 0;
    retriedCount += e.retriedCount || 0;
    mandatoryPassed += e.mandatoryPassed || 0;
    mandatoryTotal += e.mandatoryTotal || 0;
    ecoles.push({
      ecole: e.ecole,
      score: e.score || 0,
      max: e.max || 0,
      pct: e.max > 0 ? Math.round((e.score / e.max) * 100) : 0,
      optionalBonus: e.optionalBonus || 0,
      globalLifeScore: e.globalLifeScore || 0,
      helpCount: e.helpCount || 0,
      retriedCount: e.retriedCount || 0,
      calibrationIndex: e.calibrationIndex != null ? e.calibrationIndex : null,
      date: e.date || '—',
      reportFile: e.reportFile || null
    });
  }

  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  const mandatoryPct = mandatoryTotal > 0 ? Math.round((mandatoryPassed / mandatoryTotal) * 100) : 0;

  return {
    model: ledger.model || ledger.shortName || 'modèle_inconnu',
    shortName: ledger.shortName || shortenModelName(ledger.model || 'inconnu'),
    score, max, pct,
    mandatoryPassed, mandatoryTotal, mandatoryPct,
    globalLifeScore, optionalBonus, helpCount, retriedCount,
    ecoleCount: entries.length,
    ecoles,
    lastUpdated: ledger.lastUpdated || null
  };
}

// Génère des arguments qualitatifs (forces / faiblesses) selon les métriques.
function buildArguments(entry) {
  const forces = [];
  const faiblesses = [];
  const notes = [];

  if (entry.pct >= 95) forces.push('maîtrise quasi-parfaite des exercices');
  else if (entry.pct >= 80) forces.push('bonne maîtrise globale des exercices');
  else if (entry.pct >= 70) forces.push('niveau acceptable, validation du seuil obligatoire');

  if (entry.mandatoryPct === 100) forces.push('100% du contenu obligatoire validé');
  else if (entry.mandatoryPct >= 80) forces.push('contenu obligatoire largement validé');
  else if (entry.mandatoryPct < 50 && entry.mandatoryTotal > 0) faiblesses.push('échec sur le contenu obligatoire de base');

  if (entry.optionalBonus > 0) forces.push('exercices optionnels réussis (+' + entry.optionalBonus + ' bonus)');
  if (entry.helpCount > 0) faiblesses.push('a eu besoin d\'aide du professeur (' + entry.helpCount + 'x)');
  if (entry.retriedCount > 0) faiblesses.push('exercices en rattrapage (' + entry.retriedCount + 'x)');

  if (entry.globalLifeScore > 0 && entry.pct >= 80) forces.push('santé robuste (' + entry.globalLifeScore + ' PV)');
  else if (entry.globalLifeScore < 0) faiblesses.push('santé critique (' + entry.globalLifeScore + ' PV)');

  const calib = entry.ecoles.find(e => e.calibrationIndex != null);
  if (calib) {
    const c = calib.calibrationIndex;
    if (c >= 0.85) forces.push('excellente lucidité (C=' + c.toFixed(2) + ')');
    else if (c >= 0.65) notes.push('calibration modérée (C=' + c.toFixed(2) + ')');
    else faiblesses.push('biais de calibration majeur (C=' + c.toFixed(2) + ')');
  }

  if (entry.pct < 50) faiblesses.push('plus de la moitié des exercices échoués');
  if (entry.ecoleCount > 1) notes.push('évalué sur ' + entry.ecoleCount + ' écoles');

  return { forces, faiblesses, notes };
}

// Détermine le rang/verdict du modèle.
function getVerdict(entry) {
  const v = entry.mandatoryTotal > 0 ? entry.mandatoryPct : entry.pct;
  if (v >= 80) return { label: 'RECOMMANDÉ', color: '#28a745', rank: 1 };
  if (v >= 50) return { label: 'PARTIEL — RÉSERVES', color: '#ffc107', rank: 2 };
  return { label: 'NON RECOMMANDÉ', color: '#dc3545', rank: 3 };
}

function gradeColor(grade) {
  const map = { 'A': '#28a745', 'B': '#17a2b8', 'C': '#ffc107', 'D': '#e83e8c', 'F': '#dc3545' };
  return map[grade] || '#6c757d';
}

// Échappe du texte pour HTML.
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildLeaderboardHTML(entries) {
  const now = new Date().toLocaleString('fr-FR');
  let html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement BenchGo V3 — ${esc(now)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { text-align: center; color: #58a6ff; margin-bottom: 5px; }
  .subtitle { text-align: center; color: #8b949e; margin-bottom: 25px; font-size: 0.9em; }
  .container { max-width: 1000px; margin: 0 auto; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
  .card.gold { border-color: #ffd700; box-shadow: 0 0 12px rgba(255,215,0,0.15); }
  .card.silver { border-color: #c0c0c0; }
  .card.bronze { border-color: #cd7f32; }
  .card-top { display: flex; align-items: center; padding: 14px 18px; gap: 14px; background: #1c2128; border-bottom: 1px solid #30363d; }
  .medal { font-size: 1.8em; flex-shrink: 0; width: 40px; text-align: center; }
  .medal-num { font-size: 1.4em; font-weight: 700; color: #58a6ff; flex-shrink: 0; width: 40px; text-align: center; }
  .model-name { color: #58a6ff; font-weight: 600; font-size: 1.05em; word-break: break-all; flex: 1; }
  .verdict-badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-size: 0.75em; font-weight: 700; white-space: nowrap; }
  .stats-row { display: flex; flex-wrap: wrap; gap: 0; padding: 12px 18px; border-bottom: 1px solid #21262d; }
  .stat { flex: 1; min-width: 110px; text-align: center; padding: 4px 6px; }
  .stat:not(:last-child) { border-right: 1px solid #21262d; }
  .stat-label { font-size: 0.68em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 3px; }
  .stat-value { font-size: 1.05em; font-weight: 700; }
  .stat-grade { font-size: 1.4em; font-weight: 700; }
  .pct-bar-wrap { width: 100%; max-width: 90px; height: 7px; background: #30363d; border-radius: 4px; margin: 4px auto 0; }
  .pct-bar-fill { height: 100%; border-radius: 4px; }
  .args-section { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 12px 18px 14px; }
  @media (max-width: 768px) {
    .args-section { grid-template-columns: 1fr; gap: 12px; }
  }
  .args-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .args-forces { color: #28a745; }
  .args-weak { color: #f85149; }
  .args-notes { color: #8b949e; font-style: italic; }
  .args-list { list-style: none; padding-left: 14px; }
  .args-list li { font-size: 0.82em; margin-bottom: 2px; line-height: 1.3; }
  .args-list li::before { content: "• "; }
  .ecoles-toggle summary { cursor: pointer; color: #58a6ff; font-size: 0.72em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; outline: none; }
  .ecoles-list { font-size: 0.78em; color: #8b949e; margin-top: 6px; list-style: none; padding-left: 14px; }
  .ecoles-list li { margin-bottom: 2px; }
  .footer { text-align: center; color: #484f58; font-size: 0.75em; margin-top: 20px; }
  .btn-delete { flex-shrink: 0; padding: 5px 14px; border: 1px solid #f85149; background: rgba(248,81,73,0.1); color: #f85149; border-radius: 6px; cursor: pointer; font-size: 0.78em; font-weight: 600; transition: all 0.15s; }
  .btn-delete:hover { background: #f85149; color: #fff; }
  .btn-delete:disabled { opacity: 0.5; cursor: default; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 8px; font-size: 0.85em; color: #fff; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 999; }
  .toast.show { opacity: 1; }
  .toast.ok { background: #28a745; }
  .toast.err { background: #dc3545; }
</style>
</head>
<body>
<h1>🏇 Classement BenchGo V3</h1>
<p class="subtitle">Généré le ${esc(now)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} du meilleur au pire</p>
<div class="container">
`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    const cardClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    const rankDisplay = medal ? `<div class="medal">${medal}</div>` : `<div class="medal-num">${i + 1}</div>`;

    const pctColor = e.pct >= 80 ? '#28a745' : e.pct >= 50 ? '#ffc107' : '#dc3545';
    const santeColor = e.globalLifeScore < 0 ? '#f85149' : '#28a745';
    const helpStr = (e.helpCount > 0 || e.retriedCount > 0)
      ? (e.helpCount > 0 ? 'aide:' + e.helpCount : '') + (e.retriedCount > 0 ? (e.helpCount > 0 ? ' ' : '') + 'rat.:' + e.retriedCount : '')
      : '—';

    html += `<div class="card ${cardClass}" data-shortname="${esc(e.shortName)}">\n`;
    html += `  <div class="card-top">${rankDisplay}<div class="model-name">${esc(e.model)}</div><span class="verdict-badge" style="background:${verdict.color};color:#fff">${verdict.label}</span><button class="btn-delete" onclick="deleteModel('${esc(e.shortName)}', this)">🗑 Supprimer</button></div>\n`;
    html += `  <div class="stats-row">\n`;
    html += `    <div class="stat"><div class="stat-label">Points</div><div class="stat-value">${e.score}/${e.max}</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">%</div><div class="stat-value" style="color:${pctColor}">${e.pct}%</div><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:${e.pct}%;background:${pctColor}"></div></div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Note</div><div class="stat-grade" style="color:${gradeColor(grade.grade)}">${grade.grade}</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Obligatoire</div><div class="stat-value">${e.mandatoryTotal > 0 ? e.mandatoryPct + '%' : '—'}</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Santé</div><div class="stat-value" style="color:${santeColor}">${e.globalLifeScore} PV</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Bonus</div><div class="stat-value">${e.optionalBonus > 0 ? '+' + e.optionalBonus : '—'}</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Aide / Rat.</div><div class="stat-value" style="font-size:0.85em">${esc(helpStr)}</div></div>\n`;
    html += `    <div class="stat"><div class="stat-label">Écoles</div><div class="stat-value">${e.ecoleCount}</div></div>\n`;
    html += `  </div>\n`;
    html += `  <div class="args-section">\n`;
    
    // Colonne 1 : Forces
    html += `    <div class="args-forces">\n`;
    html += `      <div class="args-title">✅ Forces</div>\n`;
    if (args.forces.length > 0) {
      html += `      <ul class="args-list">\n`;
      for (const f of args.forces) html += `        <li>${esc(f)}</li>\n`;
      html += `      </ul>\n`;
    } else {
      html += `      <span style="font-size:0.82em;color:#8b949e;font-style:italic;padding-left:14px;">Aucune force particulière</span>\n`;
    }
    html += `    </div>\n`;

    // Colonne 2 : Faiblesses (et Notes)
    html += `    <div class="args-weak">\n`;
    html += `      <div class="args-title">❌ Faiblesses</div>\n`;
    if (args.faiblesses.length > 0) {
      html += `      <ul class="args-list">\n`;
      for (const w of args.faiblesses) html += `        <li>${esc(w)}</li>\n`;
      html += `      </ul>\n`;
    } else {
      html += `      <span style="font-size:0.82em;color:#8b949e;font-style:italic;padding-left:14px;">Aucune faiblesse particulière</span>\n`;
    }
    if (args.notes.length > 0) {
      html += `      <div class="args-notes" style="margin-top:8px;">\n`;
      html += `        <div class="args-title" style="color:#8b949e;font-size:0.9em;margin-bottom:2px;">ℹ Notes</div>\n`;
      html += `        <ul class="args-list">\n`;
      for (const n of args.notes) html += `          <li>${esc(n)}</li>\n`;
      html += `        </ul>\n`;
      html += `      </div>\n`;
    }
    html += `    </div>\n`;

    // Colonne 3 : Détail par école
    html += `    <details class="ecoles-toggle" open>\n`;
    html += `      <summary>Détail par école</summary>\n`;
    html += `      <ul class="ecoles-list">\n`;
    for (const ecole of e.ecoles) {
      const g = letterGrade(ecole.pct);
      html += `        <li>${esc(ecole.ecole)} : ${ecole.score}/${ecole.max} (${ecole.pct}%) — Note ${g.grade} | +${ecole.optionalBonus} bonus | ${ecole.globalLifeScore} PV</li>\n`;
    }
    html += `      </ul>\n`;
    html += `    </details>\n`;
    html += `  </div>\n`;
    html += `</div>\n`;
  }

  html += `</div>
<p class="footer">Généré par BenchGo V3 — leaderboard.js | ${entries.length} modèle(s) classé(s) du meilleur au pire</p>
<div id="toast" class="toast"></div>
<script>
function showToast(msg, ok) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(function(){ t.className = 'toast ' + (ok ? 'ok' : 'err'); }, 2500);
}
function deleteModel(shortName, btn) {
  if (!confirm('Supprimer le modèle "' + shortName + '" du classement ?\\nLe carnet de scores sera définitivement supprimé.')) return;
  btn.disabled = true;
  btn.textContent = '...';
  fetch('/api/delete?shortName=' + encodeURIComponent(shortName), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        showToast('Modèle supprimé — classement régénéré', true);
        setTimeout(function(){ location.reload(); }, 800);
      } else {
        showToast('Erreur : ' + (data.error || 'inconnue'), false);
        btn.disabled = false;
        btn.textContent = '🗑 Supprimer';
      }
    })
    .catch(function(err) {
      showToast('Erreur réseau', false);
      btn.disabled = false;
      btn.textContent = '🗑 Supprimer';
    });
}
</script>
</body>
</html>`;

  return html;
}

function buildLeaderboardMarkdown(entries) {
  let md = `# 🏇 Classement BenchGo V3\n\n`;
  md += `> Généré le ${new Date().toLocaleString('fr-FR')} — ${entries.length} modèle(s) classé(s)\n\n`;
  md += `| Rang | Modèle | Points | % | Note | Oblig. | Santé | Bonus | Aide | Rat. | Écoles | Verdict | Forces & Faiblesses |\n`;
  md += `|---:|---|---|---:|:---:|---:|---:|---:|---:|---:|---:|---|---|\n`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);

    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    const argsText = [];
    if (args.forces.length > 0) argsText.push('**Forces :** ' + args.forces.join(', '));
    if (args.faiblesses.length > 0) argsText.push('**Faiblesses :** ' + args.faiblesses.join(', '));
    if (args.notes.length > 0) argsText.push('*' + args.notes.join(', ') + '*');

    md += `| ${medal} | ${e.model} | ${e.score}/${e.max} | ${e.pct}% | ${grade.grade} | ${e.mandatoryTotal > 0 ? e.mandatoryPct + '%' : '—'} | ${e.globalLifeScore} | ${e.optionalBonus > 0 ? '+' + e.optionalBonus : '—'} | ${e.helpCount || '—'} | ${e.retriedCount || '—'} | ${e.ecoleCount} | ${verdict.label} | ${argsText.join(' · ')} |\n`;
  }

  md += `\n---\n\n## Détail par modèle\n\n`;
  for (const e of entries) {
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    md += `### ${e.model}\n\n`;
    md += `- **Score global :** ${e.score}/${e.max} (${e.pct}%) — Note ${grade.grade}\n`;
    md += `- **Obligatoire :** ${e.mandatoryTotal > 0 ? e.mandatoryPassed + '/' + e.mandatoryTotal + ' (' + e.mandatoryPct + '%)' : 'N/A'}\n`;
    md += `- **Santé :** ${e.globalLifeScore} PV | **Bonus :** +${e.optionalBonus}\n`;
    md += `- **Aide :** ${e.helpCount}x | **Rattrapage :** ${e.retriedCount}x | **Écoles :** ${e.ecoleCount}\n`;
    md += `- **Verdict :** ${verdict.label}\n`;
    if (args.forces.length > 0) md += `- **Forces :** ${args.forces.join(', ')}\n`;
    if (args.faiblesses.length > 0) md += `- **Faiblesses :** ${args.faiblesses.join(', ')}\n`;
    if (args.notes.length > 0) md += `- *${args.notes.join(', ')}*\n`;
    md += `\n| École | Points | % | Note | Bonus | Santé |\n`;
    md += `|---|---|---:|:---:|---:|---:|\n`;
    for (const ecole of e.ecoles) {
      const g = letterGrade(ecole.pct);
      md += `| ${ecole.ecole} | ${ecole.score}/${ecole.max} | ${ecole.pct}% | ${g.grade} | +${ecole.optionalBonus} | ${ecole.globalLifeScore} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// Génère le classement complet (HTML + Markdown) et le sauvegarde.
function generateLeaderboard() {
  const ledgers = loadAllLedgers();
  if (ledgers.length === 0) {
    logger.warn('Aucun carnet de scores trouvé — classement vide.');
    return null;
  }

  const entries = ledgers.map(aggregateLedger).filter(Boolean);
  if (entries.length === 0) {
    logger.warn('Aucune donnée exploitable dans les carnets — classement vide.');
    return null;
  }

  // Tri : % décroissant, puis score décroissant, puis santé décroissante
  entries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  const html = buildLeaderboardHTML(entries);
  const md = buildLeaderboardMarkdown(entries);

  // Le classement est global (tous modèles confondus) → un seul fichier à la
  // racine de Export-Rapports/, écrasé à chaque génération. Pas de sous-dossier date.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const htmlPath = path.join(EXPORT_DIR, 'classement.html');
  const mdPath = path.join(EXPORT_DIR, 'classement.md');

  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');

  const relHtml = path.relative(__dirname, htmlPath);
  const relMd = path.relative(__dirname, mdPath);

  console.log('');
  console.log('  \x1b[1;35m━━━ CLASSEMENT BENCHGO V3 ━━━\x1b[0m');
  console.log(`  \x1b[90m${entries.length} modèle(s) classé(s) du meilleur au pire\x1b[0m`);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const verdict = getVerdict(e);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const vColor = verdict.rank === 1 ? '\x1b[32m' : verdict.rank === 2 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${medal} \x1b[1m${(i + 1 + '.').padEnd(4)}\x1b[0m ${e.model.substring(0, 45).padEnd(45)} ${String(e.pct + '%').padStart(5)}  ${vColor}${verdict.label}\x1b[0m`);
  }
  console.log('');
  console.log(`  \x1b[32mClassement HTML : ${relHtml}\x1b[0m`);
  console.log(`  \x1b[90mClassement MD   : ${relMd}\x1b[0m`);
  console.log('');

  return { htmlPath, mdPath, entries };
}

// Supprime un carnet de scores par shortName, puis régénère le classement.
function deleteLedger(shortName) {
  const file = path.join(LEDGER_DIR, shortName + '.json');
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'Carnet introuvable : ' + shortName };
  }
  fs.unlinkSync(file);
  logger.info('Carnet supprimé : ' + shortName + '.json');
  generateLeaderboard();
  return { ok: true };
}

// Démarre un mini-serveur HTTP servant le classement HTML + l'API de suppression.
function startServer(port) {
  port = port || 3939;
  const htmlPath = path.join(EXPORT_DIR, 'classement.html');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // API : suppression d'un modèle
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const result = deleteLedger(shortName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Page par défaut : sert le classement HTML
    let content, type;
    if (url.pathname === '/classement.md' || url.pathname === '/classement.md') {
      const mdPath = path.join(EXPORT_DIR, 'classement.md');
      content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '# Classement vide';
      type = 'text/plain; charset=utf-8';
    } else {
      content = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '<h1>Aucun classement. Lancez node leaderboard.js</h1>';
      type = 'text/html; charset=utf-8';
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });

  server.listen(port, () => {
    const url = 'http://localhost:' + port;
    console.log('');
    console.log('  \x1b[1;35m━━━ CLASSEMENT INTERACTIF — BenchGo V3 ━━━\x1b[0m');
    console.log(`  \x1b[32mServeur démarré : ${url}\x1b[0m`);
    console.log('  \x1b[90mOuvrez le navigateur. Cliquez sur "🗑 Supprimer" pour retirer un modèle.\x1b[0m');
    console.log('  \x1b[90mCtrl+C pour arrêter le serveur.\x1b[0m\n');

    // Ouvre le navigateur par défaut
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd, () => {});
  });
}

module.exports = {
  loadAllLedgers,
  aggregateLedger,
  buildArguments,
  getVerdict,
  buildLeaderboardHTML,
  buildLeaderboardMarkdown,
  generateLeaderboard,
  deleteLedger,
  startServer
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const serveMode = args.includes('--serve') || args.includes('-s');
  const portArg = args.find(a => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 3939;

  if (serveMode) {
    generateLeaderboard();
    startServer(port);
  } else {
    const result = generateLeaderboard();
    if (!result) {
      console.log('\x1b[33mAucun carnet de scores trouvé. Lancez d\'abord un benchmark (node runner.js all --profile=LIGHT).\x1b[0m');
      console.log('\x1b[90mAstuce : node leaderboard.js --serve pour le mode interactif (boutons supprimer).\x1b[0m');
      process.exit(0);
    }
    console.log('\x1b[90mAstuce : node leaderboard.js --serve pour le mode interactif (boutons supprimer dans le navigateur).\x1b[0m');
  }
}