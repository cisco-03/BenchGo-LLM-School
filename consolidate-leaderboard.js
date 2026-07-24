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
    if (pct >= 80) return '#30d158';
    if (pct >= 70) return '#ffd60a';
    if (pct >= 50) return '#ff9f0a';
    return '#ff453a';
  }

  function gradeColor(g) {
    if (g === 'A') return '#30d158';
    if (g === 'B') return '#0a84ff';
    if (g === 'C') return '#ffd60a';
    if (g === 'D') return '#ff9f0a';
    return '#ff453a';
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
    /* Palette macOS Sequoia (dark) — fond très noir ambre, accents système */
    --bg-0: #000000; --bg-1: #0a0a0c; --bg-2: #141416; --bg-3: #1e1e22; --bg-elev: #2a2a2e;
    --glass: rgba(40,40,46,0.55); --glass-strong: rgba(48,48,54,0.72); --glass-light: rgba(255,255,255,0.06);
    --hairline: rgba(255,255,255,0.08); --hairline-strong: rgba(255,255,255,0.14);
    --text: #f5f5f7; --text-muted: #a1a1a6; --text-dim: #6e6e73;
    --accent: #0a84ff; --accent-2: #409cff; --accent-glow: rgba(10,132,255,0.35);
    --green: #30d158; --yellow: #ffd60a; --orange: #ff9f0a; --red: #ff453a; --purple: #bf5af2;
    --pink: #ff375f; --teal: #64d2ff;
    --gold: #ffd60a; --silver: #d6d6d6; --bronze: #ff9f0a;
    --fs-display: clamp(2rem,1.6rem+1.8vw,3rem);
    --fs-h1: clamp(1.5rem,1.3615rem+0.6154vw,1.85rem);
    --fs-h2: clamp(1.2rem,1.1262rem+0.3385vw,1.4rem);
    --fs-h3: clamp(1rem,0.9538rem+0.2051vw,1.1rem);
    --fs-body: clamp(0.92rem,0.9rem+0.0897vw,1rem);
    --fs-small: clamp(0.8rem,0.7846rem+0.0692vw,0.86rem);
    --fs-tiny: clamp(0.7rem,0.6897rem+0.0449vw,0.74rem);
    --r-sm: 10px; --r-md: 14px; --r-lg: 20px; --r-xl: 24px; --r-pill: 999px;
    --shadow-card: 0 1px 2px rgba(0,0,0,0.40), 0 4px 16px rgba(0,0,0,0.30);
    --shadow-elev: 0 2px 8px rgba(0,0,0,0.50), 0 16px 48px rgba(0,0,0,0.55);
    --shadow-glass: 0 8px 32px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.08);
    --container-max: 1500px;
    --container-pad: clamp(1rem,3.5vw,2.5rem);
    --space-xs: clamp(0.4rem,0.3692rem+0.1368vw,0.55rem);
    --space-s: clamp(0.8rem,0.7385rem+0.2735vw,1.1rem);
    --space-m: clamp(1.1rem,0.9769rem+0.5470vw,1.6rem);
    --space-l: clamp(1.6rem,1.3846rem+1.0940vw,2.6rem);
    --ease: cubic-bezier(0.4,0,0.2,1);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, * { scrollbar-width: none; -ms-overflow-style: none; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background:
      radial-gradient(900px 500px at 15% -5%, rgba(10,132,255,0.14), transparent 55%),
      radial-gradient(800px 600px at 90% 10%, rgba(191,90,242,0.10), transparent 50%),
      radial-gradient(700px 400px at 50% 100%, rgba(48,209,88,0.05), transparent 60%),
      var(--bg-0);
    background-attachment: fixed;
    color: var(--text); font-size: var(--fs-body); line-height: 1.5; min-height: 100vh;
    padding-block: var(--space-m); -webkit-font-smoothing: antialiased; letter-spacing: -0.01em;
  }
  .wrap { width: 100%; max-width: var(--container-max); margin-inline: auto; padding-inline: var(--container-pad); }
  header.hero { text-align: center; padding-block: var(--space-l) var(--space-l); }
  header.hero .badge-top {
    display: inline-flex; align-items: center; gap: 7px; padding: 6px 14px;
    border: 1px solid var(--hairline); background: var(--glass); backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%); border-radius: var(--r-pill);
    color: var(--text-muted); font-size: var(--fs-tiny); text-transform: uppercase;
    letter-spacing: 1.4px; margin-bottom: var(--space-s); font-weight: 600;
    box-shadow: var(--shadow-glass);
  }
  header.hero h1 {
    font-size: var(--fs-display); font-weight: 700; line-height: 1.04;
    background: linear-gradient(135deg, #fff 0%, var(--accent-2) 60%, var(--purple) 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    letter-spacing: -0.03em;
  }
  header.hero .subtitle { color: var(--text-muted); margin-top: 10px; font-size: var(--fs-small); font-weight: 400; }
  .sticky-bar {
    position: sticky; top: 0; z-index: 100;
    background: var(--glass-strong); backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%); border-bottom: 1px solid var(--hairline);
    margin-inline: calc(-1 * var(--container-pad)); padding-inline: var(--container-pad);
    padding-block: var(--space-s); transition: box-shadow 0.3s var(--ease), background 0.3s var(--ease);
  }
  .sticky-bar.stuck { background: rgba(10,10,12,0.85); box-shadow: 0 6px 24px rgba(0,0,0,0.50); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); margin-block: var(--space-xs); }
  .toolbar + .toolbar { margin-top: var(--space-s); }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 10px; flex: 1 1 auto; min-width: 0; }
  .chip {
    padding: 9px 17px; border: 1px solid var(--hairline); background: var(--glass);
    backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%);
    color: var(--text-muted); border-radius: var(--r-pill); font-size: var(--fs-small);
    cursor: pointer; white-space: nowrap; transition: all 0.25s var(--ease); user-select: none;
    display: inline-flex; align-items: center; gap: 7px; font-weight: 600;
    box-shadow: 0 1px 3px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .chip:hover { border-color: var(--hairline-strong); color: var(--text); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.08); }
  .chip:active { transform: translateY(0) scale(0.98); transition-duration: 0.08s; }
  .chip.active {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    border-color: transparent; color: #fff; font-weight: 700;
    box-shadow: 0 4px 16px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.25);
  }
  .chip .count {
    opacity: 0.8; margin-left: 3px; font-size: 0.82em; font-weight: 700;
    background: rgba(255,255,255,0.10); padding: 1px 7px; border-radius: var(--r-pill);
    min-width: 18px; text-align: center;
  }
  .chip.active .count { background: rgba(255,255,255,0.25); opacity: 1; }
  .search-wrap { display: flex; align-items: center; gap: var(--space-s); flex: 0 0 auto; }
  .search {
    padding: 10px 16px; background: var(--glass); backdrop-filter: blur(16px) saturate(150%);
    -webkit-backdrop-filter: blur(16px) saturate(150%); border: 1px solid var(--hairline);
    color: var(--text); border-radius: var(--r-pill); font-size: var(--fs-small);
    width: clamp(160px,24vw,260px); transition: all 0.25s var(--ease);
    box-shadow: 0 1px 3px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .search::placeholder { color: var(--text-dim); }
  .search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow), 0 1px 3px rgba(0,0,0,0.30); }
  .result-count { font-size: var(--fs-tiny); color: var(--text-muted); white-space: nowrap; font-weight: 600; }
  .cards { display: flex; flex-direction: column; gap: var(--space-m); margin-block: var(--space-l); }
  .card {
    background: var(--glass); backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border: 1px solid var(--hairline); border-radius: var(--r-lg);
    box-shadow: var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.06);
    transition: all 0.28s var(--ease); overflow: hidden; position: relative;
  }
  .card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: transparent; transition: background 0.25s var(--ease); border-radius: 4px; }
  .card:hover { border-color: var(--hairline-strong); transform: translateY(-3px); box-shadow: var(--shadow-elev), inset 0 1px 0 rgba(255,255,255,0.10); }
  .card.gold::before { background: linear-gradient(180deg, var(--gold), transparent); }
  .card.silver::before { background: linear-gradient(180deg, var(--silver), transparent); }
  .card.bronze::before { background: linear-gradient(180deg, var(--bronze), transparent); }
  .card.gold { border-color: rgba(255,214,10,0.35); box-shadow: 0 0 32px rgba(255,214,10,0.10), var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.08); }
  .card.silver { border-color: rgba(214,214,214,0.25); }
  .card.bronze { border-color: rgba(255,159,10,0.30); }
  .card-head {
    display: flex; align-items: center; gap: var(--space-m);
    padding: var(--space-m) var(--space-l); flex-wrap: wrap;
    border-bottom: 1px solid var(--hairline);
  }
  .rank {
    flex: 0 0 auto; min-width: 58px; height: 58px; display: flex; align-items: center;
    justify-content: center; flex-wrap: wrap; gap: 2px; padding-inline: 10px;
    font-size: var(--fs-h2); font-weight: 700; color: var(--accent);
    background: var(--glass-light); border: 1px solid var(--hairline); border-radius: var(--r-md);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
  }
  .rank .medal { font-size: 1.7em; line-height: 1; }
  .card.gold .rank { background: linear-gradient(135deg, rgba(255,214,10,0.22), transparent); border-color: rgba(255,214,10,0.40); }
  .card.silver .rank { background: linear-gradient(135deg, rgba(214,214,214,0.18), transparent); border-color: rgba(214,214,214,0.30); }
  .card.bronze .rank { background: linear-gradient(135deg, rgba(255,159,10,0.18), transparent); border-color: rgba(255,159,10,0.30); }
  .model-name { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
  .model-name .name-line {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    color: var(--text); font-weight: 600; font-size: var(--fs-h3);
    word-break: break-all; line-height: 1.3; letter-spacing: -0.01em;
  }
  .model-name .name-line .cat-icon { font-size: 1.15em; }
  .model-name .badges { display: flex; flex-wrap: wrap; gap: 7px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-tiny);
    padding: 4px 11px; border-radius: var(--r-pill); background: var(--glass-light);
    color: var(--text-muted); border: 1px solid var(--hairline); white-space: nowrap; font-weight: 600;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  .badge.quant { color: var(--purple); border-color: rgba(191,90,242,0.35); background: rgba(191,90,242,0.12); }
  .badge.contrib { color: #d8a8ff; border-color: rgba(191,90,242,0.30); background: rgba(191,90,242,0.10); }
  .badge.pseudo { color: var(--green); border-color: rgba(48,209,88,0.30); background: rgba(48,209,88,0.10); }
  .verdict-badge {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 7px;
    padding: 8px 18px; border-radius: var(--r-pill); font-size: var(--fs-small);
    font-weight: 700; color: #fff; white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .verdict-badge .v-icon { font-size: 1.1em; }
  .card-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; padding: var(--space-m) var(--space-l) var(--space-l);
  }
  .stat-tile {
    display: flex; flex-direction: column; gap: 7px; padding: 15px 17px;
    background: var(--glass-light); border: 1px solid var(--hairline); border-radius: var(--r-md);
    backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);
    transition: all 0.2s var(--ease); min-width: 0;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  }
  .stat-tile:hover { border-color: var(--hairline-strong); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.08); }
  .stat-tile .tile-top { display: flex; align-items: center; gap: 6px; }
  .stat-tile .icon { font-size: 1.05em; line-height: 1; }
  .stat-tile .lbl {
    font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase;
    letter-spacing: 0.8px; font-weight: 600;
  }
  .stat-tile .val {
    font-size: clamp(1.1rem,1.0077rem+0.4103vw,1.45rem); font-weight: 700;
    line-height: 1.1; font-variant-numeric: tabular-nums; word-break: break-word; letter-spacing: -0.02em;
  }
  .stat-tile .val.grade { font-size: clamp(1.4rem,1.2615rem+0.6154vw,1.9rem); }
  .stat-tile .val-sub { font-size: 0.58em; font-weight: 600; color: var(--text-dim); margin-left: 3px; }
  .stat-tile.pct-tile { grid-column: span 2; }
  .pct-bar-wrap { width: 100%; height: 8px; background: rgba(0,0,0,0.35); border-radius: var(--r-pill); margin-top: 5px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.40); }
  .pct-bar-fill { height: 100%; border-radius: var(--r-pill); transition: width 0.5s var(--ease); box-shadow: 0 0 8px currentColor; }
  .empty-msg { text-align: center; color: var(--text-muted); padding: var(--space-l); font-style: italic; display: none; font-size: var(--fs-body); }
  footer.footer { text-align: center; color: var(--text-dim); font-size: var(--fs-tiny); margin-top: var(--space-l); padding-block: var(--space-m); }
  footer.footer a { color: var(--accent); text-decoration: none; }
  footer.footer a:hover { text-decoration: underline; }
  footer.footer code { background: var(--glass-light); padding: 2px 7px; border-radius: 6px; color: var(--purple); border: 1px solid var(--hairline); }
  @keyframes cardIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .card { animation: cardIn 0.5s var(--ease) both; }
  @media (max-width: 720px) {
    .card-head { padding: var(--space-s); }
    .card-stats { grid-template-columns: repeat(2, 1fr); padding: var(--space-s); }
    .stat-tile.pct-tile { grid-column: span 2; }
    .verdict-badge { width: 100%; justify-content: center; }
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
function pctColor(p) { return p>=80?'#30d158':p>=70?'#ffd60a':p>=50?'#ff9f0a':'#ff453a'; }
function gradeColor(g) { return g==='A'?'#30d158':g==='B'?'#0a84ff':g==='C'?'#ffd60a':g==='D'?'#ff9f0a':'#ff453a'; }
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
    var vitesseIcon = m.tokensPerSecond > 0 ? '⚡' : '⏱️';
    var healthIcon = m.globalLifeScore < 0 ? '💔' : '❤️';
    var healthVal = m.globalLifeScore + ' PV';
    var verdictBg = pc;
    var verdictIcon = m.cat.icon;
    var verdictLabel = m.cat.label;
    var html = '<div class="card ' + cardClass + '" style="animation-delay:' + (shown * 45) + 'ms">' +
      '<div class="card-head">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name">' +
          '<div class="name-line"><span class="cat-icon">' + m.cat.icon + '</span>' + esc(m.model) + '</div>' +
          '<div class="badges">' + quantBadge + contribBadge + pseudoBadge + '<span class="badge">' + m.paramSize.icon + ' ' + esc(m.paramSize.label) + '</span></div>' +
        '</div>' +
        '<span class="verdict-badge" style="background:' + verdictBg + '"><span class="v-icon">' + verdictIcon + '</span>' + esc(verdictLabel) + '</span>' +
      '</div>' +
      '<div class="card-stats">' +
        '<div class="stat-tile pct-tile"><div class="tile-top"><span class="icon">🎯</span><span class="lbl">Réussite</span></div><span class="val" style="color:' + pc + '">' + m.pct + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + Math.max(2,m.pct) + '%;background:' + pc + '"></div></div></div>' +
        '<div class="stat-tile"><div class="tile-top"><span class="icon">🎓</span><span class="lbl">Note</span></div><span class="val grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
        '<div class="stat-tile"><div class="tile-top"><span class="icon">⭐</span><span class="lbl">Points</span></div><span class="val">' + m.score + '<span class="val-sub">/' + m.max + '</span></span></div>' +
        '<div class="stat-tile"><div class="tile-top"><span class="icon">' + healthIcon + '</span><span class="lbl">Santé</span></div><span class="val" style="color:' + sc + '">' + healthVal + '</span></div>' +
        '<div class="stat-tile"><div class="tile-top"><span class="icon">🏫</span><span class="lbl">Écoles</span></div><span class="val">' + m.ecoleCount + '</span></div>' +
        '<div class="stat-tile"><div class="tile-top"><span class="icon">' + vitesseIcon + '</span><span class="lbl">' + vitesseLbl + '</span></div><span class="val" style="color:' + tpsC + '">' + esc(vitesseVal) + '</span></div>' +
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