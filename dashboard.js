'use strict'

const http = require('http')

const CDN_CHARTJS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
const CDN_CHARTJS_FALLBACK = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'

function getLedgerFns() {
  const lb = require('./leaderboard')
  return { loadAllLedgers: lb.loadAllLedgers, aggregateLedger: lb.aggregateLedger }
}

function buildDashboardData() {
  const { loadAllLedgers, aggregateLedger } = getLedgerFns()
  const ledgers = loadAllLedgers()
  const models = ledgers.map(aggregateLedger).filter(Boolean).map(e => ({
    shortName: e.shortName,
    model: e.model,
    pct: e.pct,
    score: e.score,
    max: e.max,
    globalLifeScore: e.globalLifeScore,
    optionalBonus: e.optionalBonus,
    ecoleCount: e.ecoleCount,
    tokensPerSecond: e.tokensPerSecond || 0,
    lastUpdated: e.lastUpdated,
    ecoles: (e.ecoles || []).map(ec => ({
      ecole: ec.ecole,
      pct: ec.pct,
      score: ec.score,
      max: ec.max,
      globalLifeScore: ec.globalLifeScore,
      tokensPerSecond: ec.tokensPerSecond || 0
    }))
  }))
  return { ok: true, models, generatedAt: new Date().toISOString() }
}

function handleDashboardApi(req, res) {
  const data = buildDashboardData()
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data), 'utf8')
}

function buildDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BenchGo V3 — Comparateur</title>
<script src="${CDN_CHARTJS}"><\/script>
<script>
  if (typeof Chart === 'undefined') {
    document.write('<script src="${CDN_CHARTJS_FALLBACK}"><\\/script>');
  }
<\/script>
<style>
  :root {
    --bg: #0a0e14; --bg1: #11161d; --bg2: #161b22; --bg3: #1c2230;
    --border: #2d333b; --text: #c9d1d9; --muted: #8b949e; --dim: #6e7681;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --purple: #bc8cff; --gold: #ffd700;
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; }
  .header {
    background: linear-gradient(135deg, var(--bg1), var(--bg2));
    border-bottom: 1px solid var(--border);
    padding: 14px 28px; position: sticky; top: 0; z-index: 100;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  }
  .header h1 { margin: 0; font-size: 1.2rem; color: var(--accent); }
  .header .subtitle { color: var(--muted); font-size: 0.75rem; margin-top: 2px; }
  .header a { color: var(--muted); text-decoration: none; font-size: 0.8rem; }
  .header a:hover { color: var(--accent); }
  .container { max-width: 1500px; margin: 0 auto; padding: 20px 28px; }
  .toolbar {
    background: var(--bg1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 16px; margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;
  }
  .toolbar-group { display: flex; flex-direction: column; gap: 4px; }
  .toolbar label { font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .selector-row { display: flex; align-items: center; gap: 6px; }
  .selector-color { width: 4px; min-height: 32px; border-radius: 4px; }
  .combobox { position: relative; min-width: 240px; }
  .combobox-input {
    background: var(--bg3); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; font-size: 0.82rem; width: 100%;
    transition: border-color 0.15s;
  }
  .combobox-input:focus { outline: none; border-color: var(--accent); }
  .combobox-input.placeholder { color: var(--dim); }
  .combobox-clear {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    cursor: pointer; color: var(--dim); font-size: 1rem; line-height: 1;
    padding: 2px 4px; border-radius: 3px; display: none;
  }
  .combobox-clear:hover { color: var(--red); }
  .combobox-list {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 200;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
    max-height: 240px; overflow-y: auto; display: none; margin-top: 2px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .combobox-list.open { display: block; }
  .combobox-opt {
    padding: 7px 12px; font-size: 0.8rem; color: var(--text); cursor: pointer;
    display: flex; align-items: center; gap: 8px;
  }
  .combobox-opt:hover, .combobox-opt.highlighted { background: var(--bg3); }
  .combobox-opt .opt-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .combobox-opt.selected { color: var(--gold); }
  .combobox-opt.empty-opt { color: var(--dim); font-style: italic; }
  .combobox-noresults { padding: 10px 12px; font-size: 0.78rem; color: var(--dim); text-align: center; }
  .gap-banner {
    background: var(--bg1); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 18px; margin-bottom: 16px; text-align: center;
  }
  .gap-banner h2 { margin: 0 0 10px 0; font-size: 0.9rem; color: var(--accent); }
  .gap-list { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
  .gap-item {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 8px;
  }
  .gap-item.gap-champion {
    border-color: var(--gold); background: rgba(255,215,0,0.1);
    padding: 10px 24px; font-size: 0.95rem; box-shadow: 0 0 16px rgba(255,215,0,0.15);
  }
  .gap-champion .gap-winner { font-size: 1.05rem; }
  .gap-champion .gap-delta { font-size: 0.85rem; }
  .gap-item .gap-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .gap-item .gap-label { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .gap-item .gap-winner { color: var(--gold); font-weight: 700; }
  .gap-item .gap-delta { color: var(--text); font-weight: 600; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .model-block {
    background: var(--bg1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 16px; border-left: 4px solid var(--accent);
  }
  .model-block h3 { margin: 0 0 8px 0; color: var(--text); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .badge-best {
    display: inline-block; background: var(--gold); color: #000;
    font-size: 0.58rem; font-weight: 800; padding: 2px 6px; border-radius: 4px;
    letter-spacing: 0.03em; text-transform: uppercase;
  }
  .badge-metric {
    display: inline-block; border-radius: 4px; padding: 2px 5px;
    font-size: 0.56rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
    background: rgba(255,215,0,0.12); color: var(--gold); border: 1px solid rgba(255,215,0,0.3);
  }
  .stat-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .stat-mini {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 10px; flex: 1; min-width: 72px;
  }
  .stat-mini.winner { border-color: var(--gold); border-width: 2px; background: rgba(255,215,0,0.06); }
  .stat-mini .label { font-size: 0.6rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .stat-mini .value { font-weight: 700; color: var(--text); margin-top: 1px; }
  .stat-mini .value.green { color: var(--green); }
  .stat-mini .value.red { color: var(--red); }
  .card { background: var(--bg1); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .card-title { font-size: 0.82rem; font-weight: 600; color: var(--text); margin: 0 0 3px 0; }
  .card-desc { font-size: 0.72rem; color: var(--muted); margin: 0 0 12px 0; }
  .card canvas { height: 380px !important; max-height: 380px !important; }
  .chart-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .chart-toolbar label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .metric-select {
    background: var(--bg3); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer;
  }
  .metric-select:focus { outline: none; border-color: var(--accent); }
  .metric-pill { display: inline-flex; gap: 4px; }
  .metric-pill-btn {
    background: var(--bg3); border: 1px solid var(--border); border-radius: 16px;
    padding: 4px 12px; font-size: 0.75rem; cursor: pointer; color: var(--muted);
    transition: all 0.15s; user-select: none;
  }
  .metric-pill-btn:hover { border-color: var(--accent); color: var(--text); }
  .metric-pill-btn.active { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); }
  .empty-state { text-align: center; padding: 40px 20px; color: var(--dim); font-size: 0.85rem; }
  .loading-overlay { text-align: center; padding: 50px; color: var(--muted); font-size: 0.9rem; }
  .loading-overlay .spinner {
    display: inline-block; width: 28px; height: 28px; border: 3px solid var(--bg3);
    border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 10px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer { text-align: center; padding: 20px; color: var(--dim); font-size: 0.72rem; border-top: 1px solid var(--border); margin-top: 24px; }
  .info-banner {
    background: rgba(88,166,255,0.08); border: 1px solid rgba(88,166,255,0.2);
    border-radius: 8px; padding: 8px 14px; margin-bottom: 16px; font-size: 0.78rem; color: var(--accent);
  }
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--bg3); border-radius: 4px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>BenchGo V3 — Comparateur</h1>
    <div class="subtitle">Selectionnez jusqu a 4 modeles · le meilleur de chaque metrique est surligne en or</div>
  </div>
  <a href="/">Retour</a>
</div>

<div class="container">
  <div class="info-banner" id="infoBanner" style="display:none"></div>

  <div class="toolbar" id="toolbar">
    <div class="toolbar-group"><label>Modele 1</label><div class="selector-row"><div class="selector-color" style="background:#58a6ff"></div><div class="combobox" id="cb0"></div></div></div>
    <div class="toolbar-group"><label>Modele 2</label><div class="selector-row"><div class="selector-color" style="background:#3fb950"></div><div class="combobox" id="cb1"></div></div></div>
    <div class="toolbar-group"><label>Modele 3</label><div class="selector-row"><div class="selector-color" style="background:#d29922"></div><div class="combobox" id="cb2"></div></div></div>
    <div class="toolbar-group"><label>Modele 4</label><div class="selector-row"><div class="selector-color" style="background:#bc8cff"></div><div class="combobox" id="cb3"></div></div></div>
  </div>

  <div class="gap-banner" id="gapBanner" style="display:none">
    <h2>Champion — departage des modeles</h2>
    <div class="gap-list" id="gapList"></div>
  </div>

  <div class="stats-grid" id="statsGrid"></div>

  <div class="card">
    <div class="chart-toolbar">
      <label>Metrique</label>
      <div class="metric-pill" id="metricPills">
        <span class="metric-pill-btn active" data-metric="pct">Score %</span>
        <span class="metric-pill-btn" data-metric="tokensPerSecond">Vitesse</span>
        <span class="metric-pill-btn" data-metric="globalLifeScore">Sante</span>
        <span class="metric-pill-btn" data-metric="score">Score brut</span>
      </div>
    </div>
    <div class="card-title" id="chartTitle">Comparaison — % de reussite par ecole</div>
    <div class="card-desc" id="chartDesc">Chaque groupe de barres = une ecole. Chaque couleur = un modele. Survolez pour le detail.</div>
    <canvas id="mainChart"></canvas>
  </div>

  <div class="empty-state" id="emptyState" style="display:none">Selectionnez au moins un modele.</div>
  <div class="footer">BenchGo V3 · Chart.js 4.4.1</div>
</div>

<div class="loading-overlay" id="loading"><div class="spinner"></div><br>Chargement…</div>

<script>
var MODELS = [];
var charts = {};
var SEL_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff'];

function $(id) { return document.getElementById(id); }
function fmtPct(n) { return (n == null) ? '—' : n + '%'; }
function roundTok(n) { return Math.round(n || 0); }

function getSelected() {
  var result = [];
  for (var i = 0; i < 4; i++) {
    var sn = cbState[i].selectedSN;
    if (sn) { var m = MODELS.find(function(x) { return x.shortName === sn; }); if (m) result.push({ model: m, color: SEL_COLORS[i], slot: i }); }
  }
  return result;
}
function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

// --- Combobox : recherche + selection ---
var cbState = [
  { selectedSN: null, filterText: '', open: false, highlightedIdx: -1 },
  { selectedSN: null, filterText: '', open: false, highlightedIdx: -1 },
  { selectedSN: null, filterText: '', open: false, highlightedIdx: -1 },
  { selectedSN: null, filterText: '', open: false, highlightedIdx: -1 }
];

function buildCombobox(slot) {
  var container = $('cb' + slot);
  container.innerHTML =
    '<input type="text" class="combobox-input placeholder" id="cbInput' + slot + '" placeholder="Rechercher ou cliquer" autocomplete="off">' +
    '<span class="combobox-clear" id="cbClear' + slot + '" title="Vider">&times;</span>' +
    '<div class="combobox-list" id="cbList' + slot + '"></div>';
  var input = $('cbInput' + slot);
  var clear = $('cbClear' + slot);

  input.addEventListener('focus', function() { openList(slot); });
  input.addEventListener('input', function() {
    cbState[slot].filterText = input.value.toLowerCase();
    cbState[slot].highlightedIdx = -1;
    openList(slot);
  });
  input.addEventListener('keydown', function(e) {
    var opts = getFilteredModels(slot);
    if (e.key === 'ArrowDown') { e.preventDefault(); if (cbState[slot].highlightedIdx < opts.length - 1) cbState[slot].highlightedIdx++; renderList(slot, opts); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (cbState[slot].highlightedIdx > 0) cbState[slot].highlightedIdx--; renderList(slot, opts); }
    else if (e.key === 'Enter') { e.preventDefault(); if (cbState[slot].highlightedIdx >= 0 && cbState[slot].highlightedIdx < opts.length) selectModel(slot, opts[cbState[slot].highlightedIdx].shortName); else if (opts.length > 0) selectModel(slot, opts[0].shortName); }
    else if (e.key === 'Escape') { closeList(slot); input.blur(); }
  });
  input.addEventListener('blur', function() { setTimeout(function() { closeList(slot); }, 150); });
  clear.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); clearSelection(slot); });
}

function getFilteredModels(slot) {
  var filter = cbState[slot].filterText;
  return MODELS.filter(function(m) { if (!filter) return true; return (m.model || '').toLowerCase().indexOf(filter) !== -1 || (m.shortName || '').toLowerCase().indexOf(filter) !== -1; });
}

function renderList(slot, opts) {
  var list = $('cbList' + slot);
  var html = '';
  if (slot > 0) {
    var selClass = cbState[slot].selectedSN === '' ? ' selected' : '';
    html += '<div class="combobox-opt empty-opt' + selClass + '" data-sn=""><span class="opt-dot" style="background:#6e7681"></span>— Aucun —</div>';
  }
  if (opts.length === 0) {
    html += '<div class="combobox-noresults">Aucun modele trouve</div>';
  } else {
    opts.forEach(function(m, idx) {
      var sel = cbState[slot].selectedSN === m.shortName ? ' selected' : '';
      var hl = idx === cbState[slot].highlightedIdx ? ' highlighted' : '';
      html += '<div class="combobox-opt' + sel + hl + '" data-sn="' + m.shortName + '"><span class="opt-dot" style="background:' + SEL_COLORS[slot] + '"></span>' + m.model + '</div>';
    });
  }
  list.innerHTML = html;
  list.querySelectorAll('.combobox-opt').forEach(function(el) {
    el.addEventListener('mousedown', function(e) { e.preventDefault(); selectModel(slot, el.getAttribute('data-sn')); });
  });
}

function openList(slot) {
  cbState[slot].open = true;
  renderList(slot, getFilteredModels(slot));
  $('cbList' + slot).classList.add('open');
}
function closeList(slot) {
  cbState[slot].open = false;
  $('cbList' + slot).classList.remove('open');
  restoreInputText(slot);
}
function restoreInputText(slot) {
  var input = $('cbInput' + slot);
  var sn = cbState[slot].selectedSN;
  if (sn) { var m = MODELS.find(function(x) { return x.shortName === sn; }); input.value = m ? m.model : ''; input.classList.remove('placeholder'); }
  else { input.value = ''; input.classList.add('placeholder'); }
  cbState[slot].filterText = '';
}
function selectModel(slot, shortName) {
  cbState[slot].selectedSN = shortName || null;
  closeList(slot);
  restoreInputText(slot);
  $('cbClear' + slot).style.display = cbState[slot].selectedSN ? 'block' : 'none';
  redrawAll();
}
function clearSelection(slot) {
  if (slot === 0) return;
  cbState[slot].selectedSN = null;
  restoreInputText(slot);
  $('cbClear' + slot).style.display = 'none';
  redrawAll();
}

// --- Winners + gaps : score, vitesse, sante, ecoles ---
function computeWinners(selected) {
  if (selected.length === 0) return null;
  var metrics = [
    { key: 'pct', label: 'Score', unit: '%', accessor: function(m){ return m.pct||0; } },
    { key: 'tokensPerSecond', label: 'Vitesse', unit: ' t/s', accessor: function(m){ return roundTok(m.tokensPerSecond); } },
    { key: 'globalLifeScore', label: 'Sante', unit: ' PV', accessor: function(m){ return m.globalLifeScore||0; } },
    { key: 'ecoleCount', label: 'Ecoles', unit: '', accessor: function(m){ return m.ecoleCount||0; } }
  ];
  var results = [];
  metrics.forEach(function(metric) {
    var sorted = selected.map(function(s) { return { sn: s.model.shortName, model: s.model.model, color: s.color, val: metric.accessor(s.model) }; }).sort(function(a, b) { return b.val - a.val; });
    var best = sorted[0]; var second = sorted.length > 1 ? sorted[1] : null; var delta = second ? (best.val - second.val) : 0;
    var allEqual = sorted.length > 1 && sorted.every(function(s) { return s.val === best.val; });
    results.push({ metric: metric, best: best, second: second, delta: delta, allEqual: allEqual, sorted: sorted });
  });
  var winCount = {};
  results.forEach(function(r) { winCount[r.best.sn] = (winCount[r.best.sn] || 0) + 1; });
  var bestModel = null;
  Object.keys(winCount).forEach(function(sn) { if (!bestModel || winCount[sn] > winCount[bestModel]) bestModel = sn; });
  return { results: results, winCount: winCount, bestModel: bestModel };
}

function renderGapBanner(selected) {
  var w = computeWinners(selected);
  if (!w || selected.length <= 1) { $('gapBanner').style.display = 'none'; return; }
  $('gapBanner').style.display = 'block';
  var summaryModel = selected.find(function(s){ return s.model.shortName === w.bestModel; });
  if (!summaryModel) { $('gapBanner').style.display = 'none'; return; }
  var wins = w.winCount[w.bestModel];
  $('gapList').innerHTML = '<div class="gap-item gap-champion"><span class="gap-dot" style="background:' + summaryModel.color + '"></span><span class="gap-label">Champion</span><span class="gap-winner">' + summaryModel.model.model + '</span><span class="gap-delta">gagne ' + wins + '/4 metriques</span></div>';
}

// --- Police adaptative ---
function getAdaptiveFont(n) { return n <= 1 ? '1.1rem' : n === 2 ? '0.95rem' : n === 3 ? '0.82rem' : '0.7rem'; }
function getAdaptiveVal(n) { return n <= 1 ? '1.15rem' : n === 2 ? '1rem' : n === 3 ? '0.88rem' : '0.78rem'; }
function getAdaptivePad(n) { return n <= 1 ? '16px 20px' : n === 2 ? '12px 16px' : n === 3 ? '10px 14px' : '8px 12px'; }

function renderStats(selected) {
  var w = computeWinners(selected);
  var fs = getAdaptiveFont(selected.length);
  var vs = getAdaptiveVal(selected.length);
  var pad = getAdaptivePad(selected.length);
  var html = '';
  selected.forEach(function(s) {
    var m = s.model;
    var healthClass = m.globalLifeScore > 0 ? 'green' : (m.globalLifeScore < 0 ? 'red' : '');
    var badges = '';
    if (w && selected.length > 1) {
      w.results.forEach(function(r) { if (r.best.sn === m.shortName && !r.allEqual) badges += '<span class="badge-metric">' + r.metric.label + '</span>'; });
      if (w.bestModel === m.shortName) badges = '<span class="badge-best">MEILLEUR</span>' + badges;
    }
    var statDefs = [
      { key: 'pct', label: 'Score', val: fmtPct(m.pct) },
      { key: 'tokensPerSecond', label: 'Vitesse', val: roundTok(m.tokensPerSecond) + ' t/s' },
      { key: 'globalLifeScore', label: 'Sante', val: (m.globalLifeScore||0) + ' PV', cls: healthClass },
      { key: 'ecoleCount', label: 'Ecoles', val: m.ecoleCount },
      { key: 'optionalBonus', label: 'Bonus', val: (m.optionalBonus > 0 ? '+' + m.optionalBonus : '—') }
    ];
    html += '<div class="model-block" style="border-left-color:' + s.color + ';padding:' + pad + '"><h3 style="font-size:' + fs + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s.color + ';flex-shrink:0"></span><span>' + m.model + '</span>' + badges + '</h3><div class="stat-row">';
    statDefs.forEach(function(sd) {
      var isWinner = w && selected.length > 1 && w.results.find(function(r) { return r.metric.key === sd.key && r.best.sn === m.shortName && !r.allEqual; });
      html += '<div class="stat-mini' + (isWinner ? ' winner' : '') + '"><div class="label">' + sd.label + '</div><div class="value' + (sd.cls ? ' ' + sd.cls : '') + '" style="font-size:' + vs + '">' + sd.val + '</div></div>';
    });
    html += '</div></div>';
  });
  $('statsGrid').innerHTML = html;
}

// --- Un seul gros graphique : % par ecole ---
var currentMetric = 'pct';
var METRIC_DEFS = {
  pct: { label: 'Score', unit: '%', axisLabel: '% de reussite', max: 100, accessor: function(ec) { return ec ? ec.pct : 0; }, fmt: function(v) { return v + '%'; } },
  tokensPerSecond: { label: 'Vitesse', unit: ' t/s', axisLabel: 'Vitesse (tokens/s)', max: null, accessor: function(ec) { return ec ? roundTok(ec.tokensPerSecond) : 0; }, fmt: function(v) { return v + ' t/s'; } },
  globalLifeScore: { label: 'Sante', unit: ' PV', axisLabel: 'Sante (PV)', max: null, accessor: function(ec) { return ec ? (ec.globalLifeScore||0) : 0; }, fmt: function(v) { return v + ' PV'; } },
  ecoleCount: { label: 'Ecoles', unit: '', axisLabel: 'Nombre d ecoles', max: null, accessor: function(ec, m) { return m.ecoleCount || 0; }, fmt: function(v) { return v; }, perModel: true },
  score: { label: 'Score brut', unit: '', axisLabel: 'Score brut', max: null, accessor: function(ec) { return ec ? ec.score : 0; }, fmt: function(v) { return v; } }
};

function drawMainChart(selected) {
  destroyChart('mainChart');
  var def = METRIC_DEFS[currentMetric];
  var allEcoles = [];
  if (def.perModel) {
    allEcoles = ['Global'];
  } else {
    selected.forEach(function(s) { (s.model.ecoles||[]).forEach(function(ec) { if (allEcoles.indexOf(ec.ecole) === -1) allEcoles.push(ec.ecole); }); });
    allEcoles.sort();
  }
  var legendFontSize = Math.max(8, Math.round(parseFloat(getAdaptiveVal(selected.length)) * 12));
  var chartExtra = [];
  var datasets = selected.map(function(s) {
    var m = s.model;
    var values = []; var extras = [];
    if (def.perModel) {
      values.push(def.accessor(null, m));
      extras.push({ _pct: m.pct, _health: m.globalLifeScore||0, _tps: roundTok(m.tokensPerSecond), _has: true });
    } else {
      allEcoles.forEach(function(n) {
        var ec = (m.ecoles||[]).find(function(e){ return e.ecole === n; });
        if (ec) {
          values.push(def.accessor(ec));
          extras.push({ _pct: ec.pct, _health: ec.globalLifeScore||0, _tps: roundTok(ec.tokensPerSecond), _has: true });
        } else {
          values.push(null);
          extras.push({ _has: false });
        }
      });
    }
    chartExtra.push(extras);
    return { label: m.model, data: values, backgroundColor: s.color + '80', borderColor: s.color, borderWidth: 1, spanGaps: true };
  });
  $('chartTitle').textContent = 'Comparaison — ' + def.axisLabel + (def.perModel ? ' (global)' : ' par ecole');
  $('chartDesc').textContent = def.perModel ? 'Valeur globale de chaque modele. Survolez pour le detail.' : 'Chaque groupe de barres = une ecole. Chaque couleur = un modele. Survolez pour le detail.';
  charts.mainChart = new Chart($('mainChart'), {
    type: 'bar',
    data: { labels: allEcoles, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'point', intersect: true },
      plugins: {
        legend: { labels: { color: '#c9d1d9', font: { size: legendFontSize }, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(10,14,20,0.97)',
          borderColor: '#30363d', borderWidth: 1, cornerRadius: 10,
          padding: 14, titleColor: '#58a6ff', titleFont: { size: 13, weight: 700 },
          bodyColor: '#c9d1d9', bodyFont: { size: 11 }, bodySpacing: 6,
          displayColors: true, boxPadding: 4,
          filter: function(item) { return item.parsed.y !== null; },
          callbacks: {
            title: function(items) { return items.length ? allEcoles[items[0].dataIndex] : ''; },
            label: function(c) {
              if (c.parsed.y === null) return null;
              var m = selected[c.datasetIndex].model;
              return '  ' + m.model + ' : ' + def.fmt(c.parsed.y);
            },
            afterLabel: function(c) {
              if (c.parsed.y === null) return null;
              var ex = chartExtra[c.datasetIndex][c.dataIndex];
              if (!ex._has) return null;
              return ['    Score : ' + ex._pct + '%', '    Sante : ' + ex._health + ' PV', '    Vitesse : ' + ex._tps + ' t/s'];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: '#21262d' } },
        y: { beginAtZero: true, max: def.max, title: { display: true, text: def.axisLabel, color: '#8b949e', font: { size: 11 } }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      }
    }
  });
}

function setupMetricPills() {
  var pills = document.querySelectorAll('.metric-pill-btn');
  pills.forEach(function(pill) {
    pill.addEventListener('click', function(e) {
      e.preventDefault();
      var scrollY = window.scrollY;
      pills.forEach(function(p) { p.classList.remove('active'); });
      pill.classList.add('active');
      currentMetric = pill.getAttribute('data-metric');
      redrawAll();
      window.scrollTo(0, scrollY);
    });
  });
}

function redrawAll() {
  var selected = getSelected();
  if (selected.length === 0) {
    $('emptyState').style.display = 'block';
    destroyChart('mainChart');
    $('statsGrid').innerHTML = '';
    $('gapBanner').style.display = 'none';
    return;
  }
  $('emptyState').style.display = 'none';
  renderGapBanner(selected);
  renderStats(selected);
  drawMainChart(selected);
}

function populateSelectors() {
  for (var i = 0; i < 4; i++) buildCombobox(i);
  if (MODELS.length > 0) selectModel(0, MODELS[0].shortName);
}

function init() {
  fetch('/api/dashboard-data').then(function(r){ return r.json(); }).then(function(data) {
    $('loading').style.display = 'none';
    if (!data.ok || !data.models) { $('infoBanner').textContent = 'Erreur : ' + (data.error || 'indisponible'); $('infoBanner').style.display = 'block'; return; }
    MODELS = data.models;
    if (MODELS.length === 0) { $('infoBanner').textContent = 'Aucun carnet. Lancez un benchmark.'; $('infoBanner').style.display = 'block'; return; }
    var t = 0; MODELS.forEach(function(m){ m.ecoles.forEach(function(ec){ t += (ec.attempts||[]).length; }); });
    $('infoBanner').textContent = MODELS.length + ' modele(s) · ' + t + ' tentative(s)';
    $('infoBanner').style.display = 'block';
    populateSelectors();
    setupMetricPills();
    redrawAll();
  }).catch(function(err) { $('loading').style.display = 'none'; $('infoBanner').textContent = 'Erreur reseau : ' + err.message; $('infoBanner').style.display = 'block'; });
}
init();
<\/script>
</body>
</html>`
}

module.exports = { buildDashboardHTML, buildDashboardData, handleDashboardApi }