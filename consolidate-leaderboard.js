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
const OUTPUT_HTML = path.join(__dirname, 'community-leaderboard.html');
const OUTPUT_JSON = path.join(__dirname, 'community-leaderboard.json');

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

// Génère le HTML du classement consolidé.
function buildConsolidatedHTML(entries) {
  entries.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.score !== a.score) return b.score - a.score;
    return b.globalLifeScore - a.globalLifeScore;
  });

  const generatedAt = new Date().toISOString();

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function verdictLabel(pct) {
    if (pct >= 90) return { label: 'Top du top', class: 'top' };
    if (pct >= 80) return { label: 'Recommandé', class: 'rec' };
    if (pct >= 70) return { label: 'Dans la moyenne', class: 'mid' };
    if (pct >= 50) return { label: 'En rattrapage', class: 'rattr' };
    return { label: 'Éliminé', class: 'elim' };
  }

  let cards = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rank = i + 1;
    const medal = i === 0 ? '🏆' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    const v = verdictLabel(e.pct);
    const contributorTag = e.contributors > 1
      ? `<span class="contributors">testé par ${e.contributors} personnes</span>`
      : '';
    const pseudoTag = e.pseudo ? `<span class="pseudo">par ${escapeHtml(e.pseudo)}</span>` : '';
    const quantTag = e.quantization ? `<span class="quant">${escapeHtml(e.quantization)}</span>` : '';

    cards += `
    <div class="card ${v.class}" data-rank="${rank}">
      <div class="rank">${medal || '#' + rank}</div>
      <div class="info">
        <div class="model-name">${escapeHtml(e.model)}</div>
        <div class="meta">${quantTag} ${contributorTag} ${pseudoTag}</div>
      </div>
      <div class="stats">
        <div class="stat"><span class="val">${e.pct}%</span><span class="lbl">Score</span></div>
        <div class="stat"><span class="val">${e.score}/${e.max}</span><span class="lbl">Points</span></div>
        <div class="stat"><span class="val">${e.globalLifeScore} PV</span><span class="lbl">Santé</span></div>
        <div class="stat"><span class="val">${e.ecoleCount}</span><span class="lbl">Écoles</span></div>
        <div class="stat verdict ${v.class}">${v.label}</div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement Communautaire — BenchGo V3</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
h1 { text-align: center; color: #58a6ff; margin-bottom: 8px; }
.subtitle { text-align: center; color: #8b949e; margin-bottom: 24px; font-size: 14px; }
.stats-bar { display: flex; justify-content: center; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
.stats-bar .pill { background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 8px 16px; font-size: 14px; }
.stats-bar .pill strong { color: #58a6ff; }
.leaderboard { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.card { display: flex; align-items: center; gap: 16px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px 20px; transition: border-color 0.2s; }
.card:hover { border-color: #58a6ff; }
.card.top { border-left: 4px solid #3fb950; }
.card.rec { border-left: 4px solid #58a6ff; }
.card.mid { border-left: 4px solid #d29922; }
.card.rattr { border-left: 4px solid #db6d28; }
.card.elim { border-left: 4px solid #f85149; }
.rank { font-size: 24px; font-weight: bold; min-width: 60px; text-align: center; color: #8b949e; }
.info { flex: 1; min-width: 0; }
.model-name { font-size: 18px; font-weight: 600; color: #f0f6fc; word-break: break-word; }
.meta { font-size: 12px; color: #8b949e; margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
.meta .quant { background: #1f6feb22; padding: 2px 8px; border-radius: 4px; }
.meta .contributors { color: #d2a8ff; }
.meta .pseudo { color: #7ee787; }
.stats { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; align-items: center; }
.stat .val { font-size: 16px; font-weight: 600; color: #f0f6fc; }
.stat .lbl { font-size: 11px; color: #8b949e; }
.verdict { padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }
.verdict.top { background: #238636; color: #fff; }
.verdict.rec { background: #1f6feb; color: #fff; }
.verdict.mid { background: #4d2d00; color: #d29922; }
.verdict.rattr { background: #3d1f00; color: #db6d28; }
.verdict.elim { background: #4a0e0e; color: #f85149; }
footer { text-align: center; margin-top: 32px; color: #8b949e; font-size: 12px; }
footer a { color: #58a6ff; }
</style>
</head>
<body>
<h1>🏆 Classement Communautaire BenchGo V3</h1>
<p class="subtitle">Classement consolidé des soumissions de la communauté — généré automatiquement</p>
<div class="stats-bar">
  <div class="pill"><strong>${entries.length}</strong> modèle(s) classé(s)</div>
  <div class="pill"><strong>${entries.reduce((s, e) => s + e.contributors, 0)}</strong> soumission(s)</div>
  <div class="pill">Généré le <strong>${generatedAt.slice(0, 10)}</strong></div>
</div>
<div class="leaderboard">
${cards}
</div>
<footer>
  <p>Classement généré par <a href="https://github.com/cisco-03/BenchGo-LLM-School">BenchGo V3</a> — participatif et open source</p>
  <p>Pour soumettre vos résultats : <code>node runner.js --submit</code></p>
</footer>
</body>
</html>`;
}

function main() {
  const submissions = loadAllSubmissions();
  if (submissions.length === 0) {
    console.log('Aucune soumission trouvée dans submissions/.');
    // On génère quand même un HTML vide pour que gh-pages existe
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
  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify({
    entries: merged,
    generatedAt: new Date().toISOString(),
    totalSubmissions: submissions.length
  }, null, 2), 'utf8');

  console.log(`Classement consolidé généré : ${path.basename(OUTPUT_HTML)}`);
}

main();