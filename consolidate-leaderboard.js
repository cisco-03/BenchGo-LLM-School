// consolidate-leaderboard.js — Construit le classement consolidé communautaire.
//
// Lancé par la GitHub Action (.github/workflows/consolidate.yml) après le merge
// d'une PR de soumission. Il parcourt tous les fichiers submissions/*/*.json du
// dépôt, agrège les carnets, et génère un classement HTML consolidé publié sur
// GitHub Pages (branche gh-pages).
//
// Ce script tourne dans l'environnement CI (Node.js 18+, pas de dépendances npm).
// Il lit les fichiers directement depuis le filesystem du checkout du dépôt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUBMISSIONS_DIR = path.join(__dirname, 'submissions');
const OUTPUT_DIR = path.join(__dirname, 'gh-pages-output');
const OUTPUT_HTML = path.join(OUTPUT_DIR, 'community-leaderboard.html');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'community-leaderboard.json');

// Charge toutes les soumissions depuis submissions/<userId>/<model>.json.
function loadAllSubmissions() {
  const submissions = [];
  if (!fs.existsSync(SUBMISSIONS_DIR)) return submissions;

  const userDirs = fs.readdirSync(SUBMISSIONS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const userDir of userDirs) {
    const userPath = path.join(SUBMISSIONS_DIR, userDir);
    const files = fs.readdirSync(userPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(userPath, file), 'utf8'));
        if (data && data.carnet && data.carnet.ecoles) {
          submissions.push({
            userId: data.userId || userDir,
            pseudo: data.pseudo || null,
            submittedAt: data.submittedAt || null,
            integrityHash: data.integrityHash || null,
            carnet: data.carnet
          });
        }
      } catch (e) {
        // Fichier illisible — on l'ignore
      }
    }
  }
  return submissions;
}

// Agrège un carnet en une entrée de classement (meilleure tentative par école).
function aggregateCarnet(carnet) {
  if (!carnet || !carnet.ecoles) return null;
  const ecoleEntries = Object.values(carnet.ecoles);
  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  let totalTokens = 0, totalElapsedMs = 0;
  let ecoleCount = 0;

  for (const raw of ecoleEntries) {
    // Récupère la meilleure tentative
    let best = null;
    if (raw && raw.best) {
      best = raw.best;
    } else if (raw && raw.attempts && raw.attempts.length > 0) {
      best = raw.attempts.reduce((b, a) => ((a.pct || 0) >= (b.pct || 0)) ? a : b);
    } else if (raw && raw.score != null) {
      best = raw; // ancien format
    }
    if (!best) continue;
    ecoleCount++;
    score += best.score || 0;
    max += best.max || 0;
    globalLifeScore += best.globalLifeScore || 0;
    optionalBonus += best.optionalBonus || 0;
    totalTokens += best.tokens || 0;
    totalElapsedMs += best.elapsedMs || 0;
  }

  if (ecoleCount === 0 || max === 0) return null;

  const pct = Math.round((score / max) * 100);
  const tokensPerSecond = totalElapsedMs > 0
    ? Math.round((totalTokens / (totalElapsedMs / 1000)) * 100) / 100
    : 0;

  return {
    model: carnet.model || carnet.shortName || 'Inconnu',
    shortName: carnet.shortName || (carnet.model || 'inconnu').toLowerCase().replace(/[^a-z0-9]/g, '-'),
    quantization: carnet.quantization || null,
    score, max, pct, globalLifeScore, optionalBonus,
    tokens: totalTokens, elapsedMs: totalElapsedMs, tokensPerSecond,
    ecoleCount,
    pseudo: null, // rempli plus haut
    submittedAt: null
  };
}

// Dédoublonne les entrées : si plusieurs utilisateurs ont soumis le même modèle,
// on garde la meilleure soumission (pct le plus élevé). On marque le nombre de
// contributeurs pour afficher "testé par N personnes".
function deduplicateAndMerge(entries) {
  const byShortName = {};
  for (const entry of entries) {
    const key = entry.shortName;
    if (!byShortName[key]) {
      byShortName[key] = { ...entry, contributors: 1, allPct: [entry.pct] };
    } else {
      const existing = byShortName[key];
      existing.contributors++;
      existing.allPct.push(entry.pct);
      // Garde la meilleure soumission
      if (entry.pct > existing.pct) {
        const contributors = existing.contributors;
        const allPct = existing.allPct;
        Object.assign(existing, entry);
        existing.contributors = contributors;
        existing.allPct = allPct;
      }
    }
  }
  return Object.values(byShortName);
}

// Génère le HTML du classement consolidé — même style que le leaderboard principal.
function buildConsolidatedHTML(entries) {
  entries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  const generatedAt = new Date().toLocaleString('fr-FR');

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Catégories (identiques au leaderboard principal)
  function getCategory(pct, rank) {
    if (rank <= 3) return { key: 'top', icon: '🏆', label: 'Top du top' };
    if (pct >= 80) return { key: 'recommande', icon: '✅', label: 'Recommandé' };
    if (pct >= 70) return { key: 'moyenne', icon: '📊', label: 'Dans la moyenne' };
    if (pct >= 50) return { key: 'rattrapage', icon: '⚠️', label: 'En rattrapage' };
    return { key: 'catastrophe', icon: '💥', label: 'Échec total' };
  }

  // Taille du modèle par nom
  function getParamSize(modelName) {
    const m = (modelName || '').match(/([\d]+[.,]?[\d]*)\s*b/i);
    if (!m) return { key: 'inconnu', icon: '❓', label: 'Taille inconnue' };
    const size = parseFloat(m[1].replace(',', '.'));
    if (size < 3) return { key: 'petit', icon: '🐱', label: '< 3B' };
    if (size <= 14) return { key: 'standard', icon: '📦', label: '3B-14B' };
    if (size <= 30) return { key: 'expert', icon: '🎓', label: '14B-30B' };
    return { key: 'doctorat', icon: '🧠', label: '> 30B' };
  }

  function gradeLetter(pct) {
    if (pct >= 90) return 'A';
    if (pct >= 80) return 'B';
    if (pct >= 70) return 'C';
    if (pct >= 60) return 'D';
    return 'F';
  }

  function pctColor(pct) {
    if (pct >= 80) return '#3fb950';
    if (pct >= 70) return '#d29922';
    if (pct >= 50) return '#db6d28';
    return '#f85149';
  }

  function gradeColor(g) {
    if (g === 'A') return '#3fb950';
    if (g === 'B') return '#58a6ff';
    if (g === 'C') return '#d29922';
    if (g === 'D') return '#db6d28';
    return '#f85149';
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const total = Math.round(s);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    if (m < 60) return m + 'm' + String(sec).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return h + 'h' + String(min).padStart(2, '0') + 'm';
  }

  // Compteurs par catégorie pour les filtres
  const catCounts = { top: 0, recommande: 0, moyenne: 0, rattrapage: 0, catastrophe: 0 };
  const sizeCounts = { petit: 0, standard: 0, expert: 0, doctorat: 0, inconnu: 0 };
  entries.forEach((e, idx) => {
    catCounts[getCategory(e.pct, idx + 1).key]++;
    sizeCounts[getParamSize(e.model).key]++;
  });

  const totalSubmissions = entries.reduce((s, e) => s + (e.contributors || 1), 0);

  // Sérialise les données pour le JS côté client
  const modelsJson = JSON.stringify(entries.map((e, idx) => {
    const rank = idx + 1;
    const cat = getCategory(e.pct, rank);
    const psize = getParamSize(e.model);
    return {
      rank, model: e.model, shortName: e.shortName,
      quantization: e.quantization, pct: e.pct, score: e.score, max: e.max,
      grade: gradeLetter(e.pct), globalLifeScore: e.globalLifeScore,
      optionalBonus: e.optionalBonus || 0, ecoleCount: e.ecoleCount,
      elapsedMs: e.elapsedMs || 0, tokens: e.tokens || 0,
      tokensPerSecond: e.tokensPerSecond || 0,
      contributors: e.contributors || 1, pseudo: e.pseudo,
      cat, paramSize: psize
    };
  }));

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement Communautaire — BenchGo V3</title>
<style>
  :root {
    --bg-0: #0a0e14; --bg-1: #11161d; --bg-2: #161b22; --bg-3: #1c2128; --bg-elev: #22272e;
    --border: #2d333b; --border-soft: #21262d;
    --text: #e6edf3; --text-muted: #8b949e; --text-dim: #6e7681;
    --accent: #58a6ff; --accent-2: #1f6feb;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --purple: #bc8cff;
    --gold: #ffd700; --silver: #c9d1d4; --bronze: #e3b341;
    --fs-display: clamp(1.9rem,1.5538rem+1.5385vw,2.75rem);
    --fs-h1: clamp(1.5rem,1.3615rem+0.6154vw,1.85rem);
    --fs-h2: clamp(1.15rem,1.0808rem+0.3077vw,1.3rem);
    --fs-h3: clamp(0.95rem,0.9115rem+0.1667vw,1.05rem);
    --fs-body: clamp(0.9rem,0.8808rem+0.0833vw,0.97rem);
    --fs-small: clamp(0.78rem,0.7654rem+0.0641vw,0.83rem);
    --fs-tiny: clamp(0.68rem,0.6692rem+0.0449vw,0.71rem);
    --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-pill: 999px;
    --shadow-card: 0 1px 0 rgba(255,255,255,0.03),0 2px 8px rgba(0,0,0,0.25);
    --shadow-elev: 0 8px 32px rgba(0,0,0,0.45);
    --container-max: 1600px;
    --container-pad: clamp(0.75rem,3vw,2rem);
    --space-xs: clamp(0.375rem,0.3462rem+0.1282vw,0.5rem);
    --space-s: clamp(0.75rem,0.6923rem+0.2564vw,1rem);
    --space-m: clamp(1rem,0.8846rem+0.5128vw,1.5rem);
    --space-l: clamp(1.5rem,1.3077rem+1.0256vw,2.5rem);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, * { scrollbar-width: none; -ms-overflow-style: none; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: radial-gradient(1200px 600px at 50% -200px,rgba(31,111,235,0.10),transparent 60%),
                radial-gradient(900px 500px at 100% 0%,rgba(188,140,255,0.06),transparent 55%),var(--bg-0);
    color: var(--text); font-size: var(--fs-body); line-height: 1.5; min-height: 100vh;
    padding-block: var(--space-m); -webkit-font-smoothing: antialiased;
  }
  .wrap { width: 100%; max-width: var(--container-max); margin-inline: auto; padding-inline: var(--container-pad); }
  header.hero { text-align: center; padding-block: var(--space-m) var(--space-l); }
  header.hero .badge-top {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px;
    border: 1px solid var(--border); background: var(--bg-2); border-radius: var(--r-pill);
    color: var(--text-muted); font-size: var(--fs-tiny); text-transform: uppercase;
    letter-spacing: 1.2px; margin-bottom: var(--space-s);
  }
  header.hero h1 {
    font-size: var(--fs-display); font-weight: 800; line-height: 1.05;
    background: linear-gradient(135deg,var(--accent) 0%,var(--purple) 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    letter-spacing: -0.02em;
  }
  header.hero .subtitle { color: var(--text-muted); margin-top: 6px; font-size: var(--fs-small); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-block: var(--space-s); }
  .sticky-bar {
    position: sticky; top: 0; z-index: 100;
    background: rgba(10,14,20,0.82); backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%); border-bottom: 1px solid var(--border);
    margin-inline: calc(-1 * var(--container-pad)); padding-inline: var(--container-pad);
    padding-block: var(--space-xs); transition: box-shadow 0.2s ease, background 0.2s ease;
  }
  .sticky-bar.stuck { background: rgba(10,14,20,0.94); box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }
  .chip {
    padding: 6px 12px; border: 1px solid var(--border); background: var(--bg-2);
    color: var(--text-muted); border-radius: var(--r-pill); font-size: var(--fs-small);
    cursor: pointer; white-space: nowrap; transition: all 0.18s ease; user-select: none;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .chip:hover { border-color: var(--accent); color: var(--text); transform: translateY(-1px); }
  .chip.active {
    background: linear-gradient(135deg,var(--accent-2),var(--accent));
    border-color: transparent; color: #fff; font-weight: 600;
    box-shadow: 0 2px 10px rgba(31,111,235,0.35);
  }
  .chip .count { opacity: 0.75; margin-left: 2px; font-size: 0.85em; background: rgba(255,255,255,0.08); padding: 0 6px; border-radius: var(--r-pill); }
  .search-wrap { display: flex; align-items: center; gap: var(--space-xs); flex: 0 0 auto; }
  .search {
    padding: 8px 14px; background: var(--bg-2); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--r-sm); font-size: var(--fs-small);
    width: clamp(140px,22vw,240px); transition: all 0.18s ease;
  }
  .search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,0.18); }
  .result-count { font-size: var(--fs-tiny); color: var(--text-muted); }
  .cards { display: flex; flex-direction: column; gap: var(--space-s); margin-block: var(--space-m); }
  .card {
    background: linear-gradient(180deg,var(--bg-2),var(--bg-1));
    border: 1px solid var(--border); border-radius: var(--r-md);
    box-shadow: var(--shadow-card); transition: all 0.2s ease; overflow: hidden; position: relative;
  }
  .card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: transparent; transition: background 0.2s ease; }
  .card:hover { border-color: var(--border-soft); transform: translateY(-1px); box-shadow: var(--shadow-elev); }
  .card.gold::before { background: linear-gradient(180deg,var(--gold),transparent); }
  .card.silver::before { background: linear-gradient(180deg,var(--silver),transparent); }
  .card.bronze::before { background: linear-gradient(180deg,var(--bronze),transparent); }
  .card.gold { border-color: rgba(255,215,0,0.4); box-shadow: 0 0 24px rgba(255,215,0,0.10),var(--shadow-card); }
  .card.silver { border-color: rgba(201,209,212,0.3); }
  .card.bronze { border-color: rgba(227,179,65,0.35); }
  .card-row { display: flex; align-items: center; gap: var(--space-m); padding: var(--space-s) var(--space-m); }
  .rank {
    flex: 0 0 auto; min-width: 44px; height: 44px; display: flex; align-items: center;
    justify-content: center; flex-wrap: wrap; gap: 2px; padding-inline: 6px;
    font-size: var(--fs-h3); font-weight: 800; color: var(--accent);
    background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--r-sm);
  }
  .rank .medal { font-size: 1.5em; line-height: 1; }
  .card.gold .rank { background: linear-gradient(135deg,rgba(255,215,0,0.18),transparent); border-color: rgba(255,215,0,0.4); }
  .card.silver .rank { background: linear-gradient(135deg,rgba(201,209,212,0.14),transparent); border-color: rgba(201,209,212,0.3); }
  .card.bronze .rank { background: linear-gradient(135deg,rgba(227,179,65,0.14),transparent); border-color: rgba(227,179,65,0.3); }
  .model-name { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .model-name .name-line {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    color: var(--accent); font-weight: 700; font-size: var(--fs-body);
    word-break: break-all; line-height: 1.3;
  }
  .model-name .badges { display: flex; flex-wrap: wrap; gap: 5px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-tiny);
    padding: 2px 8px; border-radius: var(--r-pill); background: var(--bg-3);
    color: var(--text-muted); border: 1px solid var(--border); white-space: nowrap; font-weight: 600;
  }
  .badge.quant { color: var(--purple); border-color: rgba(188,140,255,0.35); background: rgba(188,140,255,0.10); }
  .badge.contrib { color: #d2a8ff; border-color: rgba(188,140,255,0.30); background: rgba(188,140,255,0.08); }
  .badge.pseudo { color: var(--green); border-color: rgba(63,185,80,0.30); background: rgba(63,185,80,0.08); }
  .verdict-badge { display: inline-block; padding: 4px 12px; border-radius: var(--r-sm); font-size: var(--fs-tiny); font-weight: 700; color: #fff; }
  .mini-stats { display: flex; align-items: center; gap: var(--space-m); flex: 0 0 auto; flex-wrap: wrap; }
  .mini-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
  .mini-stat .lbl { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
  .mini-stat .val { font-size: var(--fs-body); font-weight: 700; }
  .mini-stat .val.grade { font-size: var(--fs-h3); }
  .pct-bar-wrap { width: 64px; height: 5px; background: var(--bg-3); border-radius: var(--r-pill); margin-top: 3px; overflow: hidden; }
  .pct-bar-fill { height: 100%; border-radius: var(--r-pill); transition: width 0.3s ease; }
  .empty-msg { text-align: center; color: var(--text-muted); padding: var(--space-l); font-style: italic; display: none; font-size: var(--fs-body); }
  footer.footer { text-align: center; color: var(--text-dim); font-size: var(--fs-tiny); margin-top: var(--space-l); padding-block: var(--space-m); }
  footer.footer a { color: var(--accent); }
  footer.footer code { background: var(--bg-3); padding: 1px 6px; border-radius: 4px; color: var(--purple); }
  @media (max-width: 720px) {
    .card-row { flex-wrap: wrap; }
    .mini-stats { width: 100%; justify-content: space-between; padding-top: var(--space-s); border-top: 1px solid var(--border-soft); }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <span class="badge-top">🌐 BenchGo V3 · Classement Communautaire</span>
    <h1>Classement Communautaire BenchGo V3</h1>
    <p class="subtitle">Généré le ${esc(generatedAt)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} · ${totalSubmissions} soumission${totalSubmissions > 1 ? 's' : ''} de la communauté</p>
  </header>

  <div class="sticky-bar" id="stickyBar">
    <div class="toolbar">
      <div class="filter-chips" id="chips">
        <span class="chip active" data-cat="all">Tous <span class="count">${entries.length}</span></span>
        <span class="chip" data-cat="top">🏆 Top du top <span class="count">${catCounts.top}</span></span>
        <span class="chip" data-cat="recommande">✅ Recommandés <span class="count">${catCounts.recommande}</span></span>
        <span class="chip" data-cat="moyenne">📊 Dans la moyenne <span class="count">${catCounts.moyenne}</span></span>
        <span class="chip" data-cat="rattrapage">⚠️ En rattrapage <span class="count">${catCounts.rattrapage}</span></span>
        <span class="chip" data-cat="catastrophe">💥 Échec total <span class="count">${catCounts.catastrophe}</span></span>
      </div>
    </div>
    <div class="toolbar">
      <div class="filter-chips" id="sizeChips">
        <span class="chip active" data-size="all">Toutes tailles <span class="count">${entries.length}</span></span>
        <span class="chip" data-size="petit">🐱 &lt; 3B <span class="count">${sizeCounts.petit}</span></span>
        <span class="chip" data-size="standard">📦 3B–14B <span class="count">${sizeCounts.standard}</span></span>
        <span class="chip" data-size="expert">🎓 14B–30B <span class="count">${sizeCounts.expert}</span></span>
        <span class="chip" data-size="doctorat">🧠 &gt; 30B <span class="count">${sizeCounts.doctorat}</span></span>
      </div>
      <div class="search-wrap">
        <input type="text" class="search" id="search" placeholder="🔍 Rechercher un modèle…" />
        <span class="result-count" id="resultCount"></span>
      </div>
    </div>
  </div>

  <div class="cards" id="cards"></div>
  <p class="empty-msg" id="emptyMsg">Aucun modèle ne correspond à ce filtre.</p>

  <footer class="footer">
    <p>Classement communautaire généré par <a href="https://github.com/cisco-03/BenchGo-LLM-School">BenchGo V3</a> — participatif et open source</p>
    <p>Pour soumettre vos résultats : <code>node runner.js --submit</code> ou bouton "🌐 Envoyer à la communauté" dans le classement local</p>
  </footer>
</div>
<script>
var MODELS = ${modelsJson};
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function pctColor(p) { return p>=80?'#3fb950':p>=70?'#d29922':p>=50?'#db6d28':'#f85149'; }
function gradeColor(g) { return g==='A'?'#3fb950':g==='B'?'#58a6ff':g==='C'?'#d29922':g==='D'?'#db6d28':'#f85149'; }
function fmtDur(ms) { if(!ms||ms<=0) return '—'; var s=ms/1000; if(s<60) return s.toFixed(1)+'s'; var t=Math.round(s),m=Math.floor(t/60),sec=t%60; if(m<60) return m+'m'+String(sec).padStart(2,'0')+'s'; var h=Math.floor(m/60),mn=m%60; return h+'h'+String(mn).padStart(2,'0')+'m'; }

var activeCat = 'all', activeSize = 'all', searchQ = '';
function renderCards() {
  var container = document.getElementById('cards');
  container.innerHTML = '';
  var shown = 0;
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    if (activeCat !== 'all' && m.cat.key !== activeCat) continue;
    if (activeSize !== 'all' && m.paramSize.key !== activeSize) continue;
    if (searchQ && m.model.toLowerCase().indexOf(searchQ) === -1 && m.shortName.toLowerCase().indexOf(searchQ) === -1) continue;
    shown++;
    var cardClass = m.rank === 1 ? 'gold' : m.rank === 2 ? 'silver' : m.rank === 3 ? 'bronze' : '';
    var rankDisp = m.rank <= 3 ? '<span class="medal">' + ['🥇','🥈','🥉'][m.rank-1] + '</span>' : m.rank;
    var pc = pctColor(m.pct), gc = gradeColor(m.grade);
    var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
    var tpsC = m.tokensPerSecond >= 50 ? '#3fb950' : m.tokensPerSecond >= 25 ? '#d29922' : m.tokensPerSecond > 0 ? '#f85149' : '#8b949e';
    var quantBadge = m.quantization ? '<span class="badge quant">🧩 ' + esc(m.quantization) + '</span>' : '';
    var contribBadge = m.contributors > 1 ? '<span class="badge contrib">👥 testé par ' + m.contributors + ' personnes</span>' : '';
    var pseudoBadge = m.pseudo ? '<span class="badge pseudo">✍️ ' + esc(m.pseudo) + '</span>' : '';
    var vitesseVal = m.tokensPerSecond > 0 ? (m.tokensPerSecond + ' t/s') : (m.elapsedMs > 0 ? fmtDur(m.elapsedMs) : '—');
    var vitesseLbl = m.tokensPerSecond > 0 ? 'Vitesse' : 'Temps';
    var html = '<div class="card ' + cardClass + '">' +
      '<div class="card-row">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name">' +
          '<div class="name-line"><span>' + m.cat.icon + '</span>' + esc(m.model) + '</div>' +
          '<div class="badges">' + quantBadge + ' ' + contribBadge + ' ' + pseudoBadge + ' <span class="badge">' + m.paramSize.icon + ' ' + esc(m.paramSize.label) + '</span></div>' +
        '</div>' +
        '<div class="mini-stats">' +
          '<div class="mini-stat"><span class="lbl">%</span><span class="val" style="color:' + pc + '">' + m.pct + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + Math.max(2,m.pct) + '%;background:' + pc + '"></div></div></div>' +
          '<div class="mini-stat"><span class="lbl">Note</span><span class="val grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Points</span><span class="val">' + m.score + '/' + m.max + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Santé</span><span class="val" style="color:' + sc + '">' + m.globalLifeScore + ' PV</span></div>' +
          '<div class="mini-stat"><span class="lbl">Écoles</span><span class="val">' + m.ecoleCount + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">' + vitesseLbl + '</span><span class="val" style="color:' + tpsC + ';font-size:var(--fs-tiny)">' + esc(vitesseVal) + '</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';
    container.insertAdjacentHTML('beforeend', html);
  }
  document.getElementById('resultCount').textContent = shown + '/' + MODELS.length;
  document.getElementById('emptyMsg').style.display = shown === 0 ? 'block' : 'none';
}

// Filtres catégorie
document.querySelectorAll('#chips .chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    document.querySelectorAll('#chips .chip').forEach(function(c) { c.classList.remove('active'); });
    chip.classList.add('active');
    activeCat = chip.dataset.cat;
    renderCards();
  });
});
// Filtres taille
document.querySelectorAll('#sizeChips .chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    document.querySelectorAll('#sizeChips .chip').forEach(function(c) { c.classList.remove('active'); });
    chip.classList.add('active');
    activeSize = chip.dataset.size;
    renderCards();
  });
});
// Recherche
document.getElementById('search').addEventListener('input', function(e) {
  searchQ = e.target.value.toLowerCase().trim();
  renderCards();
});
// Barre sticky
(function() {
  var bar = document.getElementById('stickyBar');
  function onScroll() { if (window.scrollY > 4) bar.classList.add('stuck'); else bar.classList.remove('stuck'); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
renderCards();
</script>
</body>
</html>`;
}

function main() {
  const submissions = loadAllSubmissions();
  if (submissions.length === 0) {
    console.log('Aucune soumission trouvée dans submissions/.');
    // On génère quand même un HTML vide pour que gh-pages existe
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_HTML, buildConsolidatedHTML([]), 'utf8');
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ entries: [], generatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return;
  }

  console.log(`${submissions.length} soumission(s) trouvée(s).`);

  // Agrège chaque soumission
  const entries = [];
  for (const sub of submissions) {
    const agg = aggregateCarnet(sub.carnet);
    if (agg) {
      agg.pseudo = sub.pseudo;
      agg.submittedAt = sub.submittedAt;
      entries.push(agg);
    }
  }

  // Dédoublonne et fusionne
  const merged = deduplicateAndMerge(entries);
  console.log(`${merged.length} modèle(s) unique(s) après fusion.`);

  // Génère les fichiers
  const html = buildConsolidatedHTML(merged);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify({
    entries: merged,
    generatedAt: new Date().toISOString(),
    totalSubmissions: submissions.length
  }, null, 2), 'utf8');

  console.log(`Classement consolidé généré : ${path.basename(OUTPUT_HTML)}`);
}

main();