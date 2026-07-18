const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { letterGrade } = require('./progress-bar');
const { shortenModelName } = require('./report-generator');
const { detectProfileFromModelName } = require('./config');

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

// Catégorie de filtrage (plus fine que le verdict) basée sur le % global.
function getCategory(entry) {
  const p = entry.pct;
  if (p >= 90) return { key: 'top', label: 'Top du top', icon: '🏆', color: '#ffd700' };
  if (p >= 80) return { key: 'recommande', label: 'Recommandés', icon: '✅', color: '#28a745' };
  if (p >= 70) return { key: 'moyenne', label: 'Dans la moyenne', icon: '📊', color: '#17a2b8' };
  if (p >= 50) return { key: 'rattrapage', label: 'En rattrapage', icon: '⚠️', color: '#ffc107' };
  return { key: 'catastrophe', label: 'Échec total', icon: '💥', color: '#dc3545' };
}

// Taille de paramètres détectée depuis le nom du modèle.
// Retourne { key, label, short, icon } pour le filtrage et l'affichage.
//   - petit   : < 3B  (profil LIGHT)
//   - standard: 3B – 14B (profil STANDARD)
//   - expert  : 14B – 30B (profil EXPERT)
//   - doctorat: > 30B (profil DOCTORAT)
//   - inconnu : taille non détectable dans le nom
function getParamSize(modelName) {
  const { paramSize, detected } = detectProfileFromModelName(modelName || '');
  if (paramSize === null) {
    return { key: 'inconnu', label: 'Taille inconnue', short: '?B', icon: '❓', paramSize: null, detected: null };
  }
  if (paramSize < 3)   return { key: 'petit',    label: 'Petit (< 3B)',    short: paramSize + 'B', icon: '🐱', paramSize, detected };
  if (paramSize <= 14) return { key: 'standard', label: 'Standard (3B–14B)', short: paramSize + 'B', icon: '📦', paramSize, detected };
  if (paramSize <= 30) return { key: 'expert',   label: 'Expert (14B–30B)',  short: paramSize + 'B', icon: '🎓', paramSize, detected };
  return                 { key: 'doctorat', label: 'Doctorat (> 30B)',   short: paramSize + 'B', icon: '🧠', paramSize, detected };
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

  // Compteurs par catégorie pour les filtres
  const catCounts = { top: 0, recommande: 0, moyenne: 0, rattrapage: 0, catastrophe: 0 };
  const sizeCounts = { petit: 0, standard: 0, expert: 0, doctorat: 0, inconnu: 0 };
  for (const e of entries) {
    catCounts[getCategory(e).key]++;
    sizeCounts[getParamSize(e.model).key]++;
  }

  // Les données complètes de chaque modèle sont sérialisées en JSON pour la modale
  // (forces/faiblesses, détail par école, etc. — calculés une seule fois côté serveur).
  const modelsData = entries.map(e => {
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    const cat = getCategory(e);
    const psize = getParamSize(e.model);
    return {
      shortName: e.shortName,
      model: e.model,
      pct: e.pct,
      score: e.score,
      max: e.max,
      grade: grade.grade,
      mandatoryPct: e.mandatoryPct,
      mandatoryPassed: e.mandatoryPassed,
      mandatoryTotal: e.mandatoryTotal,
      globalLifeScore: e.globalLifeScore,
      optionalBonus: e.optionalBonus,
      helpCount: e.helpCount,
      retriedCount: e.retriedCount,
      ecoleCount: e.ecoleCount,
      lastUpdated: e.lastUpdated,
      verdict,
      cat,
      paramSize: psize,
      args,
      ecoles: e.ecoles.map(ec => ({
        ecole: ec.ecole,
        score: ec.score,
        max: ec.max,
        pct: ec.pct,
        grade: letterGrade(ec.pct).grade,
        optionalBonus: ec.optionalBonus,
        globalLifeScore: ec.globalLifeScore,
        helpCount: ec.helpCount,
        retriedCount: ec.retriedCount,
        calibrationIndex: ec.calibrationIndex,
        date: ec.date
      }))
    };
  });

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
  .subtitle { text-align: center; color: #8b949e; margin-bottom: 18px; font-size: 0.9em; }

  /* Barre de filtres + recherche */
  .toolbar { max-width: 1100px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
  .chip { padding: 6px 12px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 20px; font-size: 0.8em; cursor: pointer; white-space: nowrap; transition: all 0.15s; user-select: none; }
  .chip:hover { border-color: #58a6ff; }
  .chip.active { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
  .chip .count { opacity: 0.7; margin-left: 4px; font-size: 0.85em; }
  .search-wrap { flex: 0 0 auto; }
  .search { padding: 7px 12px; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 8px; font-size: 0.85em; width: 220px; }
  .search:focus { outline: none; border-color: #58a6ff; }
  .result-count { font-size: 0.78em; color: #8b949e; margin-left: 8px; }

  .container { max-width: 1100px; margin: 0 auto; }
  .empty-msg { text-align: center; color: #8b949e; padding: 40px; font-style: italic; display: none; }

  /* Carte condensée — une ligne par modèle */
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 8px; transition: border-color 0.15s; }
  .card:hover { border-color: #484f58; }
  .card.gold { border-color: #ffd700; box-shadow: 0 0 10px rgba(255,215,0,0.12); }
  .card.silver { border-color: #c0c0c0; }
  .card.bronze { border-color: #cd7f32; }
  .card-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; }
  .rank { flex: 0 0 38px; text-align: center; font-size: 1.3em; font-weight: 700; color: #58a6ff; }
  .medal { font-size: 1.5em; }
  .model-name { flex: 1; min-width: 0; color: #58a6ff; font-weight: 600; font-size: 0.95em; word-break: break-all; line-height: 1.3; }
  .model-name .cat-icon { margin-right: 5px; }
  .mini-stats { display: flex; gap: 18px; align-items: center; flex: 0 0 auto; flex-wrap: wrap; }
  .mini-stat { text-align: center; white-space: nowrap; }
  .mini-stat .lbl { font-size: 0.62em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; display: block; }
  .mini-stat .val { font-size: 0.95em; font-weight: 700; }
  .mini-stat .grade { font-size: 1.2em; font-weight: 700; }
  .size-badge { display: inline-block; font-size: 0.72em; padding: 1px 7px; border-radius: 10px; background: #21262d; color: #8b949e; border: 1px solid #30363d; vertical-align: middle; margin-left: 4px; white-space: nowrap; }
  .pct-bar-wrap { width: 70px; height: 6px; background: #30363d; border-radius: 4px; margin-top: 3px; overflow: hidden; }
  .pct-bar-fill { height: 100%; border-radius: 4px; }
  .btn-detail { flex: 0 0 auto; padding: 6px 14px; border: 1px solid #388bfd; background: rgba(56,139,253,0.1); color: #58a6ff; border-radius: 6px; cursor: pointer; font-size: 0.78em; font-weight: 600; transition: all 0.15s; }
  .btn-detail:hover { background: #1f6feb; color: #fff; }
  .btn-delete { flex: 0 0 auto; padding: 6px 12px; border: 1px solid #f85149; background: rgba(248,81,73,0.1); color: #f85149; border-radius: 6px; cursor: pointer; font-size: 0.78em; font-weight: 600; transition: all 0.15s; }
  .btn-delete:hover { background: #f85149; color: #fff; }
  .btn-delete:disabled { opacity: 0.5; cursor: default; }

  @media (max-width: 768px) {
    .card-row { flex-wrap: wrap; }
    .mini-stats { gap: 12px; width: 100%; justify-content: space-between; padding-top: 6px; border-top: 1px solid #21262d; margin-top: 4px; }
    .search { width: 140px; }
  }

  /* Modale de détail */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: flex-start; justify-content: center; z-index: 1000; padding: 30px 16px; overflow-y: auto; }
  .modal-overlay.show { display: flex; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 820px; width: 100%; margin: auto; overflow: hidden; }
  .modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 22px; background: #1c2128; border-bottom: 1px solid #30363d; }
  .modal-head .rank { font-size: 1.6em; }
  .modal-head .title { flex: 1; min-width: 0; }
  .modal-head .title h2 { color: #58a6ff; font-size: 1.1em; word-break: break-all; margin-bottom: 4px; }
  .modal-head .title .verdict-badge { display: inline-block; padding: 3px 10px; border-radius: 5px; font-size: 0.72em; font-weight: 700; color: #fff; }
  .modal-head .title .cat-tag { display: inline-block; margin-left: 8px; font-size: 0.78em; opacity: 0.85; }
  .modal-close { flex: 0 0 auto; background: none; border: none; color: #8b949e; font-size: 1.6em; cursor: pointer; padding: 0 4px; line-height: 1; }
  .modal-close:hover { color: #f85149; }
  .modal-body { padding: 18px 22px; max-height: calc(100vh - 220px); overflow-y: auto; }
  .modal-body h3 { color: #58a6ff; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #21262d; }
  .modal-body h3:first-child { margin-top: 0; }

  .full-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
  .full-stat { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px; text-align: center; }
  .full-stat .lbl { font-size: 0.65em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; }
  .full-stat .val { font-size: 1.1em; font-weight: 700; margin-top: 2px; }
  .full-stat .bar { width: 100%; height: 5px; background: #30363d; border-radius: 3px; margin-top: 4px; overflow: hidden; }
  .full-stat .bar > div { height: 100%; border-radius: 3px; }

  .args-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  @media (max-width: 600px) { .args-grid { grid-template-columns: 1fr; } }
  .args-block { }
  .args-block .args-title { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600; }
  .args-forces .args-title { color: #28a745; }
  .args-weak .args-title { color: #f85149; }
  .args-notes .args-title { color: #8b949e; }
  .args-list { list-style: none; padding-left: 16px; }
  .args-list li { font-size: 0.85em; margin-bottom: 3px; line-height: 1.4; }
  .args-list li::before { content: "• "; }
  .args-empty { font-size: 0.82em; color: #8b949e; font-style: italic; padding-left: 16px; }

  .ecoles-table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  .ecoles-table th, .ecoles-table td { padding: 7px 8px; text-align: left; border-bottom: 1px solid #21262d; }
  .ecoles-table th { color: #8b949e; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .ecoles-table td.num { text-align: right; }
  .ecoles-table .grade { font-weight: 700; text-align: center; }
  .ecoles-table tr:hover { background: #161b22; }

  .meta-line { font-size: 0.78em; color: #8b949e; margin-top: 10px; padding-top: 8px; border-top: 1px solid #21262d; }

  .footer { text-align: center; color: #484f58; font-size: 0.75em; margin-top: 20px; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 8px; font-size: 0.85em; color: #fff; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 9999; }
  .toast.show { opacity: 1; }
  .toast.ok { background: #28a745; }
  .toast.err { background: #dc3545; }
</style>
</head>
<body>
<h1>🏇 Classement BenchGo V3</h1>
<p class="subtitle">Généré le ${esc(now)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} du meilleur au pire</p>

<div class="toolbar">
  <div class="filter-chips" id="chips">
    <span class="chip active" data-cat="all">Tous <span class="count">${entries.length}</span></span>
    <span class="chip" data-cat="top">🏆 Top du top <span class="count">${catCounts.top}</span></span>
    <span class="chip" data-cat="recommande">✅ Recommandés <span class="count">${catCounts.recommande}</span></span>
    <span class="chip" data-cat="moyenne">📊 Dans la moyenne <span class="count">${catCounts.moyenne}</span></span>
    <span class="chip" data-cat="rattrapage">⚠️ En rattrapage <span class="count">${catCounts.rattrapage}</span></span>
    <span class="chip" data-cat="catastrophe">💥 Échec total <span class="count">${catCounts.catastrophe}</span></span>
  </div>
  <div class="search-wrap">
    <input type="text" class="search" id="search" placeholder="🔍 Rechercher un modèle…" />
    <span class="result-count" id="resultCount"></span>
  </div>
</div>

<div class="toolbar" style="margin-bottom:14px;">
  <div class="filter-chips" id="sizeChips">
    <span class="chip active" data-size="all">Toutes tailles <span class="count">${entries.length}</span></span>
    <span class="chip" data-size="petit">🐱 &lt; 3B <span class="count">${sizeCounts.petit}</span></span>
    <span class="chip" data-size="standard">📦 3B–14B <span class="count">${sizeCounts.standard}</span></span>
    <span class="chip" data-size="expert">🎓 14B–30B <span class="count">${sizeCounts.expert}</span></span>
    <span class="chip" data-size="doctorat">🧠 &gt; 30B <span class="count">${sizeCounts.doctorat}</span></span>
    <span class="chip" data-size="inconnu">❓ Inconnue <span class="count">${sizeCounts.inconnu}</span></span>
  </div>
</div>

<div class="container" id="cards"></div>
<p class="empty-msg" id="emptyMsg">Aucun modèle ne correspond à ce filtre.</p>

<p class="footer">Généré par BenchGo V3 — leaderboard.js | Cliquez sur une carte ou le bouton « Détails » pour ouvrir le détail complet.</p>

<div id="modal" class="modal-overlay">
  <div class="modal">
    <div class="modal-head">
      <div class="rank" id="mRank"></div>
      <div class="title">
        <h2 id="mTitle"></h2>
        <div>
          <span class="verdict-badge" id="mVerdict"></span>
          <span class="cat-tag" id="mCat"></span>
        </div>
      </div>
      <button class="modal-close" onclick="closeModal()" aria-label="Fermer">×</button>
    </div>
    <div class="modal-body" id="mBody"></div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
var MODELS = ${JSON.stringify(modelsData)};

function gradeColor(g) {
  var m = { A:'#28a745', B:'#17a2b8', C:'#ffc107', D:'#e83e8c', F:'#dc3545' };
  return m[g] || '#6c757d';
}
function pctColor(p) {
  return p >= 80 ? '#28a745' : p >= 50 ? '#ffc107' : '#dc3545';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderCards() {
  var activeCat = document.querySelector('#chips .chip.active').getAttribute('data-cat');
  var activeSize = document.querySelector('#sizeChips .chip.active').getAttribute('data-size');
  var q = document.getElementById('search').value.trim().toLowerCase();
  var container = document.getElementById('cards');
  container.innerHTML = '';
  var shown = 0;
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    if (activeCat !== 'all' && m.cat.key !== activeCat) continue;
    if (activeSize !== 'all' && m.paramSize.key !== activeSize) continue;
    if (q && m.model.toLowerCase().indexOf(q) === -1 && m.shortName.toLowerCase().indexOf(q) === -1) continue;
    shown++;

    var cardClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    var rankDisp = i < 3 ? '<span class="medal">' + (i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉') + '</span>'
                              : (i + 1);
    var pc = pctColor(m.pct);
    var sc = m.globalLifeScore < 0 ? '#f85149' : '#28a745';
    var gc = gradeColor(m.grade);
    var helpStr = (m.helpCount > 0 || m.retriedCount > 0)
      ? (m.helpCount > 0 ? 'aide:' + m.helpCount : '') + (m.retriedCount > 0 ? (m.helpCount > 0 ? ' ' : '') + 'rat.:' + m.retriedCount : '')
      : '—';
    var szBadge = '<span class="size-badge" title="' + esc(m.paramSize.label) + '">' + m.paramSize.icon + ' ' + esc(m.paramSize.short) + '</span>';

    var html = '<div class="card ' + cardClass + '" onclick="openModal(' + i + ')">' +
      '<div class="card-row">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name"><span class="cat-icon">' + m.cat.icon + '</span>' + esc(m.model) + ' ' + szBadge + '</div>' +
        '<div class="mini-stats">' +
          '<div class="mini-stat"><span class="lbl">%</span><span class="val" style="color:' + pc + '">' + m.pct + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + m.pct + '%;background:' + pc + '"></div></div></div>' +
          '<div class="mini-stat"><span class="lbl">Note</span><span class="grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Santé</span><span class="val" style="color:' + sc + '">' + m.globalLifeScore + ' PV</span></div>' +
          '<div class="mini-stat"><span class="lbl">Oblig.</span><span class="val">' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Aide/Rat.</span><span class="val" style="font-size:0.8em">' + esc(helpStr) + '</span></div>' +
        '</div>' +
        '<button class="btn-detail" onclick="event.stopPropagation();openModal(' + i + ')">Détails</button>' +
        '<button class="btn-delete" onclick="event.stopPropagation();deleteModel(\'' + esc(m.shortName) + '\', this)">🗑</button>' +
      '</div>' +
    '</div>';
    container.insertAdjacentHTML('beforeend', html);
  }
  document.getElementById('resultCount').textContent = shown + '/' + MODELS.length;
  document.getElementById('emptyMsg').style.display = shown === 0 ? 'block' : 'none';
}

function openModal(idx) {
  var m = MODELS[idx];
  document.getElementById('mRank').innerHTML = idx < 3 ? '<span class="medal">' + (idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉') + '</span>' : (idx + 1);
  document.getElementById('mTitle').textContent = m.model;
  var vb = document.getElementById('mVerdict');
  vb.textContent = m.verdict.label;
  vb.style.background = m.verdict.color;
  document.getElementById('mCat').innerHTML = m.cat.icon + ' ' + esc(m.cat.label) + ' · ' + m.paramSize.icon + ' ' + esc(m.paramSize.label);

  var pc = pctColor(m.pct);
  var sc = m.globalLifeScore < 0 ? '#f85149' : '#28a745';
  var gc = gradeColor(m.grade);
  var oc = m.mandatoryTotal > 0 ? pctColor(m.mandatoryPct) : '#6c757d';

  var body = '';
  // --- Stats complètes
  body += '<h3>Statistiques</h3>';
  body += '<div class="full-stats">';
  body += statBox('Points', m.score + ' / ' + m.max);
  body += statBoxBar('% global', m.pct + '%', pc, m.pct);
  body += statBox('Note', '<span style="color:' + gc + ';font-size:1.4em">' + m.grade + '</span>');
  body += statBoxBar('Obligatoire', m.mandatoryTotal > 0 ? m.mandatoryPct + '% (' + m.mandatoryPassed + '/' + m.mandatoryTotal + ')' : '—', oc, m.mandatoryPct);
  body += statBox('Santé', '<span style="color:' + sc + '">' + m.globalLifeScore + ' PV</span>');
  body += statBox('Bonus', m.optionalBonus > 0 ? '+' + m.optionalBonus : '—');
  body += statBox('Aide prof.', m.helpCount > 0 ? m.helpCount + 'x' : '—');
  body += statBox('Rattrapage', m.retriedCount > 0 ? m.retriedCount + 'x' : '—');
  body += statBox('Écoles', m.ecoleCount);
  body += '</div>';

  // --- Forces / Faiblesses / Notes
  body += '<h3>Forces & Faiblesses</h3>';
  body += '<div class="args-grid">';
  body += argsCol('args-forces', '✅ Forces', m.args.forces);
  body += argsCol('args-weak', '❌ Faiblesses', m.args.faiblesses);
  body += '</div>';
  if (m.args.notes.length > 0) {
    body += '<div class="args-block args-notes" style="margin-top:12px;">';
    body += '<div class="args-title">ℹ Notes</div><ul class="args-list">';
    for (var n of m.args.notes) body += '<li>' + esc(n) + '</li>';
    body += '</ul></div>';
  }

  // --- Détail par école
  body += '<h3>Détail par école</h3>';
  body += '<table class="ecoles-table"><thead><tr>' +
    '<th>École</th><th class="num">Points</th><th>%</th><th>Note</th>' +
    '<th class="num">Bonus</th><th class="num">Santé</th><th class="num">Aide</th><th class="num">Rat.</th><th class="num">Calib.</th><th>Date</th>' +
    '</tr></thead><tbody>';
  for (var e of m.ecoles) {
    var egc = gradeColor(e.grade);
    var epc = pctColor(e.pct);
    body += '<tr>' +
      '<td>' + esc(e.ecole) + '</td>' +
      '<td class="num">' + e.score + '/' + e.max + '</td>' +
      '<td style="color:' + epc + '">' + e.pct + '%</td>' +
      '<td class="grade" style="color:' + egc + '">' + e.grade + '</td>' +
      '<td class="num">' + (e.optionalBonus > 0 ? '+' + e.optionalBonus : '—') + '</td>' +
      '<td class="num">' + e.globalLifeScore + '</td>' +
      '<td class="num">' + (e.helpCount > 0 ? e.helpCount : '—') + '</td>' +
      '<td class="num">' + (e.retriedCount > 0 ? e.retriedCount : '—') + '</td>' +
      '<td class="num">' + (e.calibrationIndex != null ? 'C=' + e.calibrationIndex.toFixed(2) : '—') + '</td>' +
      '<td>' + esc(e.date) + '</td>' +
      '</tr>';
  }
  body += '</tbody></table>';

  // --- Méta
  body += '<div class="meta-line">';
  body += 'Dernière mise à jour : ' + esc(m.lastUpdated || '—') + ' · ';
  body += 'Nom court : <code>' + esc(m.shortName) + '</code>';
  body += '</div>';

  document.getElementById('mBody').innerHTML = body;
  document.getElementById('modal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function statBox(lbl, val) {
  return '<div class="full-stat"><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div>';
}
function statBoxBar(lbl, val, color, pct) {
  return '<div class="full-stat"><div class="lbl">' + lbl + '</div><div class="val" style="color:' + color + '">' + val + '</div><div class="bar"><div style="width:' + pct + '%;background:' + color + '"></div></div></div>';
}
function argsCol(cls, title, items) {
  var h = '<div class="args-block ' + cls + '"><div class="args-title">' + title + '</div>';
  if (items.length > 0) { h += '<ul class="args-list">'; for (var it of items) h += '<li>' + esc(it) + '</li>'; h += '</ul>'; }
  else h += '<div class="args-empty">Aucun</div>';
  h += '</div>';
  return h;
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
  document.body.style.overflow = '';
}
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

// Filtres
document.getElementById('chips').addEventListener('click', function(e) {
  var t = e.target.closest('.chip'); if (!t) return;
  var chips = document.querySelectorAll('#chips .chip');
  for (var c of chips) c.classList.remove('active');
  t.classList.add('active');
  renderCards();
});
document.getElementById('sizeChips').addEventListener('click', function(e) {
  var t = e.target.closest('.chip'); if (!t) return;
  var chips = document.querySelectorAll('#sizeChips .chip');
  for (var c of chips) c.classList.remove('active');
  t.classList.add('active');
  renderCards();
});
document.getElementById('search').addEventListener('input', renderCards);

// Toast + suppression
function showToast(msg, ok) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(function(){ t.className = 'toast ' + (ok ? 'ok' : 'err'); }, 2500);
}
function deleteModel(shortName, btn) {
  if (!confirm('Supprimer le modèle "' + shortName + '" du classement ?\\nLe carnet de scores sera définitivement supprimé.')) return;
  btn.disabled = true;
  btn.textContent = '…';
  fetch('/api/delete?shortName=' + encodeURIComponent(shortName), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { showToast('Modèle supprimé — classement régénéré', true); setTimeout(function(){ location.reload(); }, 800); }
      else { showToast('Erreur : ' + (data.error || 'inconnue'), false); btn.disabled = false; btn.textContent = '🗑'; }
    })
    .catch(function() { showToast('Erreur réseau', false); btn.disabled = false; btn.textContent = '🗑'; });
}

renderCards();
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

// --- Export raisonnement consolidé (destiné à NotebookLM via Gemini) ---
// Fichier Markdown détaillé par modèle : pour chaque modèle, on restitue
//   - le nom INTÉGRAL du modèle
//   - la date et l'heure du run
//   - l'auto-profilage déclaré (4 compétences + justification)
//   - pour chaque école évaluée et chaque classe (tier) traversée :
//       * le titre du tier, le statut obligatoire/optionnel, le nom de la classe
//       * pour chaque exercice : ID, type, points, statut, code produit par le modèle,
//         explication d'échec le cas échéant
//       * la réponse brute complète du modèle (raisonnement + code) pour ce tier
//
// Ce fichier est conçu pour être ingéré par Gemini puis alimente une base NotebookLM
// afin d'analyser qualitativement le raisonnement de chaque LLM. Le nom du modèle
// est toujours le nom intégral (non raccourci), la date est obligatoire, l'heure
// est incluse quand elle est disponible.
function buildReasoningMarkdown(entries) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const genTime = `${pad(now.getHours())}-${pad(now.getMinutes())}`;

  let md = `# 🧠 Raisonnements & Réponses des Modèles — BenchGo V3\n\n`;
  md += `> Fichier consolidé destiné à l'analyse qualitative (NotebookLM via Gemini).\n`;
  md += `> Généré le ${genDate} à ${genTime.replace('-', 'h')} — ${entries.length} modèle(s)\n\n`;
  md += `> Chaque section décrit, pour un modèle LLM donné, l'ensemble des classes `;
  md += `traversées, les exercices tentés, le code produit, le raisonnement brut et les `;
  md += `explications d'échec fournies par le modèle lui-même.\n\n`;
  md += `---\n\n`;

  for (const e of entries) {
    // e.model = nom intégral du modèle (jamais raccourci dans ce fichier)
    md += `## ${e.model}\n\n`;
    md += `**Nom intégral du modèle :** ${e.model}\n\n`;
    md += `**Nom court :** ${e.shortName}\n\n`;
    md += `- **Score global :** ${e.score}/${e.max} (${e.pct}%) — Note ${letterGrade(e.pct).grade}\n`;
    md += `- **Score obligatoire :** ${e.mandatoryTotal > 0 ? e.mandatoryPassed + '/' + e.mandatoryTotal + ' (' + e.mandatoryPct + '%)' : 'N/A'}\n`;
    md += `- **Santé globale :** ${e.globalLifeScore} PV\n`;
    md += `- **Bonus optionnel :** +${e.optionalBonus}\n`;
    md += `- **Aide du professeur :** ${e.helpCount}x | **Rattrapages :** ${e.retriedCount}x\n`;
    md += `- **Écoles évaluées :** ${e.ecoleCount}\n\n`;

    // Détail par école : on retrouve le carnet original pour accéder aux tiers
    // (réponses brutes + raisonnement + selfProfile).
    const ledger = loadLedgerByName(e.shortName);
    if (!ledger) {
      md += `> *Carnet de scores introuvable — détail des raisonnements indisponible.*\n\n---\n\n`;
      continue;
    }

    for (const ecole of e.ecoles) {
      const ecoleEntry = ledger.ecoles[ecole.ecole];
      if (!ecoleEntry) continue;

      const runDate = ecoleEntry.date || '—';
      const runTime = ecoleEntry.time ? ecoleEntry.time.replace(/-/g, ':') : null;
      md += `### École : ${ecole.ecole}\n\n`;
      md += `**Date du run :** ${runDate}${runTime ? ' à ' + runTime : ''}\n\n`;
      md += `- **Profil :** ${ecoleEntry.profile || '—'}\n`;
      md += `- **Score école :** ${ecole.score}/${ecole.max} (${ecole.pct}%) — Note ${letterGrade(ecole.pct).grade}\n`;
      md += `- **Santé école :** ${ecole.globalLifeScore} PV | **Bonus :** +${ecole.optionalBonus}\n`;
      md += `- **Aide :** ${ecole.helpCount}x | **Rattrapage :** ${ecole.retriedCount}x\n`;
      if (ecoleEntry.calibrationIndex != null) {
        md += `- **Indice de Calibration :** C=${ecoleEntry.calibrationIndex.toFixed(3)} (D=${((ecoleEntry.declaredLevel || 0) * 100).toFixed(0)}%)\n`;
      }

      // Auto-profilage déclaré par le modèle pour cette école
      if (ecoleEntry.selfProfile && ecoleEntry.selfProfile.skills) {
        md += `\n#### Auto-profilage déclaré par le modèle\n\n`;
        const skills = ecoleEntry.selfProfile.skills;
        for (const [skill, label] of Object.entries({
          javascript_basics: 'JavaScript — Bases & Algorithmique simple',
          javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
          algorithms_advanced: 'Algorithmes & Structures de données avancées',
          code_debugging: 'Débogage & Sécurité applicative'
        })) {
          const lvl = skills[skill] ? skills[skill].level : '?';
          md += `- **${label} :** niveau ${lvl}/5\n`;
        }
        if (ecoleEntry.selfProfile.justification) {
          md += `- **Justification du modèle :** ${ecoleEntry.selfProfile.justification}\n`;
        }
      }

      // Détail par tier (classe traversée)
      const tiers = ecoleEntry.tiers || [];
      if (tiers.length === 0) {
        md += `\n> *Aucun détail de tier disponible pour cette école (données antérieures à l'export raisonnement).*\n`;
      }
      for (const t of tiers) {
        md += `\n#### Tier ${t.tierNum} — ${t.tierTitle}\n\n`;
        md += `- **Classe :** ${t.className}\n`;
        md += `- **Statut :** ${t.isMandatory ? 'Obligatoire' : 'Optionnel'}\n\n`;

        // Tableau des exercices
        const evals = t.evalResults || [];
        if (evals.length > 0) {
          md += `##### Exercices tentés\n\n`;
          md += `| Exercice | Type | Points | Max | Statut | Aide | Rattrapage |\n`;
          md += `|---|---|---:|---:|---|---|---|\n`;
          for (const r of evals) {
            const st = r.status === 'bypassed' ? '⊘ Bypassé' : (r.status === 'success' ? '✔ Validé' : '✘ Échec');
            md += `| ${r.id} | ${r.taskType || '—'} | ${r.points || 0} | ${r.maxPoints || 0} | ${st} | ${r.helpUsed ? 'Oui' : 'Non'} | ${r.retried ? 'Oui' : 'Non'} |\n`;
          }
          md += `\n`;

          // Code produit + explications d'échec pour chaque exercice
          md += `##### Code produit par le modèle et explications\n\n`;
          for (const r of evals) {
            if (r.status === 'bypassed') continue;
            md += `**Exercice ${r.id} — ${r.taskType || '—'}** (${r.status === 'success' ? 'validé' : 'échec'})\n\n`;
            if (r.code && String(r.code).trim()) {
              md += `Code proposé :\n\`\`\`javascript\n${String(r.code).trim()}\n\`\`\`\n\n`;
            } else {
              md += `*Aucun code exploitable produit.*\n\n`;
            }
            if (r.failureExplanation) {
              md += `**Explication de l'échec (par le modèle) :** ${r.failureExplanation}\n\n`;
            }
          }
        }

        // Réponse brute complète (raisonnement + code) du modèle pour ce tier
        if (t.rawResponse && String(t.rawResponse).trim()) {
          md += `##### Réponse brute complète du modèle pour ce tier\n\n`;
          md += `> Contient le raisonnement et les réponses du modèle tels que produits\n`;
          md += `> pendant le run (concaténation des tentatives successives).\n\n`;
          md += `\`\`\`text\n${String(t.rawResponse).trim()}\n\`\`\`\n\n`;
        }
      }

      md += `\n---\n\n`;
    }

    md += `\n`;
  }

  return md;
}

// Charge un carnet par shortName (recherche directe du fichier .json).
function loadLedgerByName(shortName) {
  const file = path.join(LEDGER_DIR, shortName + '.json');
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    logger.warn('Carnet illisible pour export raisonnement (' + shortName + ') : ' + e.message);
  }
  return null;
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
  const reasoningMd = buildReasoningMarkdown(entries);

  // Le classement est global (tous modèles confondus) → un seul fichier à la
  // racine de Export-Rapports/, écrasé à chaque génération. Pas de sous-dossier date.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const htmlPath = path.join(EXPORT_DIR, 'classement.html');
  const mdPath = path.join(EXPORT_DIR, 'classement.md');
  const reasoningPath = path.join(EXPORT_DIR, 'raisonnement_modeles.md');

  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(reasoningPath, reasoningMd, 'utf8');

  const relHtml = path.relative(__dirname, htmlPath);
  const relMd = path.relative(__dirname, mdPath);
  const relReasoning = path.relative(__dirname, reasoningPath);

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
  console.log(`  \x1b[32mClassement HTML       : ${relHtml}\x1b[0m`);
  console.log(`  \x1b[90mClassement MD         : ${relMd}\x1b[0m`);
  console.log(`  \x1b[36mRaisonnement modèles  : ${relReasoning}\x1b[0m`);
  console.log(`  \x1b[90m  (destiné à NotebookLM via Gemini)\x1b[0m`);
  console.log('');

  return { htmlPath, mdPath, reasoningPath, entries };
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
  getCategory,
  getParamSize,
  buildLeaderboardHTML,
  buildLeaderboardMarkdown,
  buildReasoningMarkdown,
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