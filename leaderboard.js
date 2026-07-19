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

// Normalise une entrée d'école du carnet vers { best, attempts }.
// Gère l'ancien format (résultat unique) et le nouveau format cumul.
function normalizeEcoleEntryLb(raw) {
  if (!raw) return { best: null, attempts: [] };
  if (raw.attempts && Array.isArray(raw.attempts)) {
    let best = raw.best;
    if (!best && raw.attempts.length > 0) {
      best = raw.attempts.reduce((b, a) => (a.pct || 0) >= (b.pct || 0) ? a : b, raw.attempts[0]);
    }
    return { best, attempts: raw.attempts.slice() };
  }
  if (raw.score != null || raw.max != null || raw.pct != null) {
    return { best: raw, attempts: [raw] };
  }
  return { best: null, attempts: [] };
}

// Compacte une tentative d'école pour la sérialisation JSON (modale).
function compactAttempt(a, idx, total) {
  return {
    n: idx + 1,
    date: a.date || '—',
    time: a.time || null,
    score: a.score || 0,
    max: a.max || 0,
    pct: a.max > 0 ? Math.max(0, Math.min(100, Math.round((a.score / a.max) * 100))) : 0,
    grade: letterGrade(a.max > 0 ? Math.round((a.score / a.max) * 100) : 0).grade,
    optionalBonus: a.optionalBonus || 0,
    globalLifeScore: a.globalLifeScore || 0,
    helpCount: a.helpCount || 0,
    retriedCount: a.retriedCount || 0,
    mandatoryPassed: a.mandatoryPassed || 0,
    mandatoryTotal: a.mandatoryTotal || 0,
    calibrationIndex: a.calibrationIndex != null ? a.calibrationIndex : null,
    reportFile: a.reportFile || null
  };
}

// Agrège un carnet en une entrée de classement (utilise la meilleure tentative par école).
function aggregateLedger(ledger) {
  const rawEntries = Object.values(ledger.ecoles || {});
  if (rawEntries.length === 0) return null;

  let score = 0, max = 0, globalLifeScore = 0, optionalBonus = 0;
  let helpCount = 0, retriedCount = 0;
  let mandatoryPassed = 0, mandatoryTotal = 0;
  const ecoles = [];

  for (const raw of rawEntries) {
    const { best, attempts } = normalizeEcoleEntryLb(raw);
    if (!best) continue;
    score += best.score || 0;
    max += best.max || 0;
    globalLifeScore += best.globalLifeScore || 0;
    optionalBonus += best.optionalBonus || 0;
    helpCount += best.helpCount || 0;
    retriedCount += best.retriedCount || 0;
    mandatoryPassed += best.mandatoryPassed || 0;
    mandatoryTotal += best.mandatoryTotal || 0;
    const bPct = best.max > 0 ? Math.max(0, Math.min(100, Math.round((best.score / best.max) * 100))) : 0;
    ecoles.push({
      ecole: best.ecole,
      score: best.score || 0,
      max: best.max || 0,
      pct: bPct,
      optionalBonus: best.optionalBonus || 0,
      globalLifeScore: best.globalLifeScore || 0,
      helpCount: best.helpCount || 0,
      retriedCount: best.retriedCount || 0,
      calibrationIndex: best.calibrationIndex != null ? best.calibrationIndex : null,
      date: best.date || '—',
      reportFile: best.reportFile || null,
      attemptsCount: attempts.length,
      attempts: attempts.map((a, i) => compactAttempt(a, i, attempts.length))
    });
  }

  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0;
  const mandatoryPct = mandatoryTotal > 0 ? Math.max(0, Math.min(100, Math.round((mandatoryPassed / mandatoryTotal) * 100))) : 0;

  return {
    model: ledger.model || ledger.shortName || 'modèle_inconnu',
    shortName: ledger.shortName || shortenModelName(ledger.model || 'inconnu'),
    quantization: ledger.quantization || null,
    score, max, pct,
    mandatoryPassed, mandatoryTotal, mandatoryPct,
    globalLifeScore, optionalBonus, helpCount, retriedCount,
    ecoleCount: ecoles.length,
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

    // Rapport intégral : on charge le carnet original pour accéder aux tiers
    // (réponses brutes + raisonnement + code produit + selfProfile). Ces données
    // sont injectées dans la modale (section repliable "Rapport intégral") pour
    // voir le comportement/raisonnement du modèle sans ouvrir le fichier MD.
    const ledger = loadLedgerByName(e.shortName);

    return {
      shortName: e.shortName,
      model: e.model,
      quantization: e.quantization || null,
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
      ecoles: e.ecoles.map(ec => {
        // Récupère l'entrée école du carnet pour les tiers + selfProfile.
        const ecoleEntry = ledger
          ? normalizeEcoleEntryLb(ledger.ecoles[ec.ecole]).best
          : null;
        const tiers = (ecoleEntry && ecoleEntry.tiers) || [];
        return {
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
          date: ec.date,
          attemptsCount: ec.attemptsCount,
          attempts: ec.attempts,
          selfProfile: (ecoleEntry && ecoleEntry.selfProfile) || null,
          tiers: tiers.map(t => ({
            tierNum: t.tierNum,
            tierTitle: t.tierTitle,
            className: t.className,
            isMandatory: t.isMandatory,
            rawResponse: t.rawResponse || null,
            evalResults: (t.evalResults || []).map(r => ({
              id: r.id,
              taskType: r.taskType || null,
              status: r.status,
              points: r.points || 0,
              maxPoints: r.maxPoints || 0,
              helpUsed: !!r.helpUsed,
              retried: !!r.retried,
              code: r.code || null,
              failureExplanation: r.failureExplanation || null,
              teacherCorrection: r.teacherCorrection || null
            }))
          }))
        };
      })
    };
  });

  let html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Classement BenchGo V3 — ${esc(now)}</title>
<style>
  :root {
    /* Palette GitHub-dark raffinée */
    --bg-0: #0a0e14;
    --bg-1: #11161d;
    --bg-2: #161b22;
    --bg-3: #1c2128;
    --bg-elev: #22272e;
    --border: #2d333b;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-dim: #6e7681;
    --accent: #58a6ff;
    --accent-2: #1f6feb;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --gold: #ffd700;
    --silver: #c9d1d4;
    --bronze: #e3b341;

    /* Espacements fluides (Living With Pixels) */
    --space-xs: clamp(0.375rem, 0.3462rem + 0.1282vw, 0.5rem);
    --space-s:  clamp(0.75rem, 0.6923rem + 0.2564vw, 1rem);
    --space-m:  clamp(1rem, 0.8846rem + 0.5128vw, 1.5rem);
    --space-l:  clamp(1.5rem, 1.3077rem + 1.0256vw, 2.5rem);
    --space-xl: clamp(2.5rem, 2.1154rem + 1.6667vw, 4rem);

    /* Typographie fluide (clamp) */
    --fs-display: clamp(1.9rem, 1.5538rem + 1.5385vw, 2.75rem);
    --fs-h1:      clamp(1.5rem, 1.3615rem + 0.6154vw, 1.85rem);
    --fs-h2:      clamp(1.15rem, 1.0808rem + 0.3077vw, 1.3rem);
    --fs-h3:      clamp(0.95rem, 0.9115rem + 0.1667vw, 1.05rem);
    --fs-body:    clamp(0.9rem, 0.8808rem + 0.0833vw, 0.97rem);
    --fs-small:   clamp(0.78rem, 0.7654rem + 0.0641vw, 0.83rem);
    --fs-tiny:    clamp(0.68rem, 0.6692rem + 0.0449vw, 0.71rem);

    /* Rayons & ombres */
    --r-sm: 8px;
    --r-md: 12px;
    --r-lg: 16px;
    --r-pill: 999px;
    --shadow-card: 0 1px 0 rgba(255,255,255,0.03), 0 2px 8px rgba(0,0,0,0.25);
    --shadow-elev: 0 8px 32px rgba(0,0,0,0.45);

    /* Container boxed intelligent */
    --container-max: 1120px;
    --container-pad: clamp(0.75rem, 4vw, 2rem);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background:
      radial-gradient(1200px 600px at 50% -200px, rgba(31,111,235,0.10), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, rgba(188,140,255,0.06), transparent 55%),
      var(--bg-0);
    color: var(--text);
    font-size: var(--fs-body);
    line-height: 1.5;
    min-height: 100vh;
    padding-block: var(--space-m);
    -webkit-font-smoothing: antialiased;
  }

  /* Container boxed intelligent — centré, largeur fluide, padding inline clamp */
  .wrap {
    width: 100%;
    max-width: var(--container-max);
    margin-inline: auto;
    padding-inline: var(--container-pad);
  }

  /* En-tête */
  header.hero { text-align: center; padding-block: var(--space-m) var(--space-l); }
  header.hero .badge-top {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: 1px solid var(--border);
    background: var(--bg-2); border-radius: var(--r-pill);
    color: var(--text-muted); font-size: var(--fs-tiny);
    text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: var(--space-s);
  }
  header.hero h1 {
    font-size: var(--fs-display); font-weight: 800; line-height: 1.05;
    background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; letter-spacing: -0.02em;
  }
  header.hero .subtitle { color: var(--text-muted); margin-top: 6px; font-size: var(--fs-small); }

  /* Toolbars (flexbox, wrap fluide) */
  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs);
    margin-block: var(--space-s);
  }

  /* Barre sticky — reste collée en haut au scroll (effet WordPress/admin).
     Regroupe les filtres catégorie + taille + recherche. Fond semi-transparent
     + backdrop blur pour lisibilité par-dessus les cartes qui défilent. */
  .sticky-bar {
    position: sticky; top: 0; z-index: 100;
    background: rgba(10, 14, 20, 0.82);
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
    border-bottom: 1px solid var(--border);
    margin-inline: calc(-1 * var(--container-pad));
    padding-inline: var(--container-pad);
    padding-block: var(--space-xs);
    transition: box-shadow 0.2s ease, background 0.2s ease;
  }
  .sticky-bar .toolbar { margin-block: 4px; }
  .sticky-bar .toolbar:first-child { margin-top: 6px; }
  .sticky-bar .toolbar:last-child { margin-bottom: 6px; }
  /* Ombre quand on scrolle (la barre "se détache" du fond) — géré via JS .stuck */
  .sticky-bar.stuck {
    background: rgba(10, 14, 20, 0.94);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }
  .chip {
    padding: 6px 12px; border: 1px solid var(--border); background: var(--bg-2);
    color: var(--text-muted); border-radius: var(--r-pill);
    font-size: var(--fs-small); cursor: pointer; white-space: nowrap;
    transition: all 0.18s ease; user-select: none;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .chip:hover { border-color: var(--accent); color: var(--text); transform: translateY(-1px); }
  .chip.active {
    background: linear-gradient(135deg, var(--accent-2), var(--accent));
    border-color: transparent; color: #fff; font-weight: 600;
    box-shadow: 0 2px 10px rgba(31,111,235,0.35);
  }
  .chip .count {
    opacity: 0.75; margin-left: 2px; font-size: 0.85em;
    background: rgba(255,255,255,0.08); padding: 0 6px; border-radius: var(--r-pill);
  }

  .search-wrap { display: flex; align-items: center; gap: var(--space-xs); flex: 0 0 auto; }
  .search {
    padding: 8px 14px; background: var(--bg-2); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--r-sm);
    font-size: var(--fs-small); width: clamp(140px, 22vw, 240px);
    transition: all 0.18s ease;
  }
  .search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,0.18); }
  .result-count { font-size: var(--fs-tiny); color: var(--text-muted); }

  /* Boutons */
  .btn {
    border: 1px solid transparent; border-radius: var(--r-sm);
    cursor: pointer; font-weight: 600; transition: all 0.18s ease;
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .btn-primary {
    padding: 8px 16px; border-color: var(--accent-2);
    background: linear-gradient(135deg, rgba(56,139,253,0.18), rgba(31,111,235,0.12));
    color: var(--accent); font-size: var(--fs-small);
  }
  .btn-primary:hover { background: linear-gradient(135deg, var(--accent-2), var(--accent)); color: #fff; box-shadow: 0 3px 12px rgba(31,111,235,0.4); }
  .btn-primary:active { transform: scale(0.97); }
  .btn-primary.done { background: var(--green); border-color: var(--green); color: #fff; }

  .btn-icon {
    padding: 5px 9px; background: var(--bg-3); border-color: var(--border);
    color: var(--text-muted); font-size: var(--fs-tiny);
  }
  .btn-icon:hover { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
  .btn-icon:active { transform: scale(0.92); }

  .btn-danger {
    padding: 6px 10px; border-color: rgba(248,81,73,0.4);
    background: rgba(248,81,73,0.08); color: var(--red); font-size: var(--fs-tiny);
  }
  .btn-danger:hover { background: var(--red); color: #fff; }
  .btn-danger:disabled { opacity: 0.5; cursor: default; }

  /* Conteneur des cartes */
  .cards { display: flex; flex-direction: column; gap: var(--space-s); margin-block: var(--space-m); }

  /* Carte modèle — flexbox, structure claire */
  .card {
    background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
    border: 1px solid var(--border); border-radius: var(--r-md);
    box-shadow: var(--shadow-card); transition: all 0.2s ease; overflow: hidden;
    position: relative;
  }
  .card::before {
    content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
    background: transparent; transition: background 0.2s ease;
  }
  .card:hover { border-color: var(--border-soft); transform: translateY(-1px); box-shadow: var(--shadow-elev); }
  .card.gold::before   { background: linear-gradient(180deg, var(--gold), transparent); }
  .card.silver::before { background: linear-gradient(180deg, var(--silver), transparent); }
  .card.bronze::before { background: linear-gradient(180deg, var(--bronze), transparent); }
  .card.gold   { border-color: rgba(255,215,0,0.4); box-shadow: 0 0 24px rgba(255,215,0,0.10), var(--shadow-card); }
  .card.silver { border-color: rgba(201,209,212,0.3); }
  .card.bronze { border-color: rgba(227,179,65,0.35); }

  .card-row { display: flex; align-items: center; gap: var(--space-s); padding: var(--space-s) var(--space-m); cursor: pointer; }

  .rank {
    flex: 0 0 auto; width: 44px; height: 44px;
    display: flex; align-items: center; justify-content: center;
    font-size: var(--fs-h3); font-weight: 800; color: var(--accent);
    background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--r-sm);
  }
  .rank .medal { font-size: 1.5em; line-height: 1; }
  .card.gold .rank   { background: linear-gradient(135deg, rgba(255,215,0,0.18), transparent); border-color: rgba(255,215,0,0.4); }
  .card.silver .rank { background: linear-gradient(135deg, rgba(201,209,212,0.14), transparent); border-color: rgba(201,209,212,0.3); }
  .card.bronze .rank { background: linear-gradient(135deg, rgba(227,179,65,0.14), transparent); border-color: rgba(227,179,65,0.3); }

  .model-name {
    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  }
  .model-name .name-line {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    color: var(--accent); font-weight: 700; font-size: var(--fs-body);
    word-break: break-all; line-height: 1.3;
  }
  .model-name .cat-icon { margin-right: 2px; }
  .model-name .badges { display: flex; flex-wrap: wrap; gap: 5px; }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: var(--fs-tiny); padding: 2px 8px; border-radius: var(--r-pill);
    background: var(--bg-3); color: var(--text-muted); border: 1px solid var(--border);
    white-space: nowrap; font-weight: 600;
  }
  .badge.quant { color: var(--purple); border-color: rgba(188,140,255,0.35); background: rgba(188,140,255,0.10); }

  /* Mini-stats — flexbox grow */
  .mini-stats { display: flex; align-items: center; gap: var(--space-m); flex: 0 0 auto; flex-wrap: wrap; }
  .mini-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
  .mini-stat .lbl {
    font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase;
    letter-spacing: 0.6px; font-weight: 600;
  }
  .mini-stat .val { font-size: var(--fs-body); font-weight: 700; }
  .mini-stat .val.grade { font-size: var(--fs-h3); }
  .pct-bar-wrap { width: 64px; height: 5px; background: var(--bg-3); border-radius: var(--r-pill); margin-top: 3px; overflow: hidden; }
  .pct-bar-fill { height: 100%; border-radius: var(--r-pill); transition: width 0.3s ease; }

  .card-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }

  .empty-msg {
    text-align: center; color: var(--text-muted); padding: var(--space-xl);
    font-style: italic; display: none; font-size: var(--fs-body);
  }

  /* Responsive fluide : mini-stats passe sous le nom sur écrans étroits */
  @media (max-width: 720px) {
    .card-row { flex-wrap: wrap; }
    .mini-stats { width: 100%; justify-content: space-between; padding-top: var(--space-s); border-top: 1px solid var(--border-soft); }
  }

  /* Modale de détail */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(1,4,9,0.78);
    backdrop-filter: blur(4px); display: none; align-items: flex-start; justify-content: center;
    z-index: 1000; padding: var(--space-m) var(--space-s); overflow-y: auto;
    scrollbar-width: none; -ms-overflow-style: none;
  }
  .modal-overlay::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .modal-overlay.show { display: flex; }
  .modal {
    background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
    border: 1px solid var(--border); border-radius: var(--r-lg);
    max-width: 860px; width: 100%; margin: auto; overflow: hidden;
    box-shadow: var(--shadow-elev);
  }
  .modal-head { display: flex; align-items: flex-start; gap: var(--space-s); padding: var(--space-m) var(--space-l); background: var(--bg-3); border-bottom: 1px solid var(--border); }
  .modal-head .rank { flex: 0 0 auto; width: 52px; height: 52px; font-size: var(--fs-h2); }
  .modal-head .title { flex: 1 1 auto; min-width: 0; }
  .modal-head .title h2 { color: var(--accent); font-size: var(--fs-h1); word-break: break-all; margin-bottom: 6px; font-weight: 800; }
  .modal-head .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .verdict-badge {
    display: inline-block; padding: 4px 12px; border-radius: var(--r-sm);
    font-size: var(--fs-tiny); font-weight: 700; color: #fff;
  }
  .cat-tag { font-size: var(--fs-small); color: var(--text-muted); }
  .modal-close {
    flex: 0 0 auto; background: none; border: none; color: var(--text-muted);
    font-size: 1.6em; cursor: pointer; padding: 0 4px; line-height: 1; transition: color 0.15s;
  }
  .modal-close:hover { color: var(--red); }
  .modal-body { padding: var(--space-m) var(--space-l); max-height: calc(100vh - 220px); overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; }
  .modal-body::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .modal-body h3 {
    color: var(--accent); font-size: var(--fs-small); text-transform: uppercase;
    letter-spacing: 0.8px; margin: var(--space-m) 0 var(--space-s);
    padding-bottom: 6px; border-bottom: 1px solid var(--border-soft); font-weight: 700;
  }
  .modal-body h3:first-child { margin-top: 0; }

  /* Stats complètes — flexbox grow (préféré à grid) */
  .full-stats { display: flex; flex-wrap: wrap; gap: var(--space-s); }
  .full-stat {
    flex: 1 1 110px; min-width: 100px;
    background: var(--bg-1); border: 1px solid var(--border-soft);
    border-radius: var(--r-sm); padding: var(--space-s); text-align: center;
  }
  .full-stat .lbl { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .full-stat .val { font-size: var(--fs-h3); font-weight: 800; margin-top: 4px; }
  .full-stat .bar { width: 100%; height: 5px; background: var(--bg-3); border-radius: var(--r-pill); margin-top: 6px; overflow: hidden; }
  .full-stat .bar > div { height: 100%; border-radius: var(--r-pill); }

  /* Forces / Faiblesses — flexbox 2 colonnes */
  .args-grid { display: flex; flex-wrap: wrap; gap: var(--space-m); }
  .args-block { flex: 1 1 280px; min-width: 0; }
  .args-block .args-title {
    font-size: var(--fs-small); text-transform: uppercase; letter-spacing: 0.6px;
    margin-bottom: var(--space-xs); font-weight: 700;
  }
  .args-forces .args-title { color: var(--green); }
  .args-weak .args-title   { color: var(--red); }
  .args-notes .args-title  { color: var(--text-muted); }
  .args-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .args-list li { font-size: var(--fs-small); line-height: 1.5; padding-left: 16px; position: relative; }
  .args-list li::before { content: "•"; position: absolute; left: 4px; color: var(--text-dim); }
  .args-empty { font-size: var(--fs-small); color: var(--text-dim); font-style: italic; }

  .ecoles-table { width: 100%; border-collapse: collapse; font-size: var(--fs-small); }
  .ecoles-table th, .ecoles-table td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--border-soft); }
  .ecoles-table th { color: var(--text-dim); font-size: var(--fs-tiny); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .ecoles-table td.num { text-align: right; }
  .ecoles-table .grade { font-weight: 800; text-align: center; }
  .ecoles-table tr:hover { background: var(--bg-2); }

  .hist-toggle {
    display: inline-block; font-size: var(--fs-tiny); color: var(--accent); cursor: pointer;
    padding: 2px 8px; border: 1px solid var(--border); border-radius: var(--r-pill);
    margin-left: 6px; user-select: none; transition: all 0.15s;
  }
  .hist-toggle:hover { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
  .hist-row > td { padding: 0 !important; }
  .hist-block { padding: var(--space-s) var(--space-m); background: var(--bg-1); border-top: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft); }
  .hist-title { font-size: var(--fs-tiny); color: var(--text-dim); margin-bottom: var(--space-xs); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .hist-table { width: 100%; border-collapse: collapse; font-size: var(--fs-small); }
  .hist-table th, .hist-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border-soft); }
  .hist-table th { color: var(--text-dim); font-size: var(--fs-tiny); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
  .hist-table td.num { text-align: right; }
  .hist-best { background: rgba(56,139,253,0.08); }
  .best-tag { color: var(--gold); font-size: 0.9em; }

  .meta-line {
    font-size: var(--fs-tiny); color: var(--text-muted); margin-top: var(--space-m);
    padding-top: var(--space-s); border-top: 1px solid var(--border-soft);
  }
  .meta-line code { background: var(--bg-3); padding: 1px 6px; border-radius: 4px; font-family: 'Cascadia Code', 'Consolas', monospace; color: var(--purple); }

  /* Rapport intégral (modale) — sections repliables par école/tier */
  .report-block { margin-top: var(--space-s); }
  .report-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); }
  .report-actions-hint { font-size: var(--fs-tiny); color: var(--text-dim); font-style: italic; }
  .report-school { margin-bottom: var(--space-m); border: 1px solid var(--border-soft); border-radius: var(--r-sm); overflow: hidden; }
  .report-school-head, .report-tier-head {
    display: flex; align-items: center; gap: var(--space-xs); cursor: pointer;
    padding: var(--space-xs) var(--space-s); background: var(--bg-3);
    font-weight: 700; font-size: var(--fs-small); user-select: none;
    transition: background 0.15s;
  }
  .report-school-head:hover, .report-tier-head:hover { background: var(--bg-elev); }
  .report-school-head .caret, .report-tier-head .caret { color: var(--text-dim); transition: transform 0.18s; }
  .report-school-head.open .caret, .report-tier-head.open .caret { transform: rotate(90deg); }
  .report-school-head .sch-title { flex: 1; min-width: 0; color: var(--accent); }
  .report-tier-head .th-title { flex: 1; min-width: 0; color: var(--text); }
  .report-tier-head .th-badge { font-size: var(--fs-tiny); padding: 1px 7px; border-radius: var(--r-pill); font-weight: 600; }
  .report-tier-head .th-badge.mand { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
  .report-tier-head .th-badge.opt  { background: rgba(210,153,34,0.15); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }
  .report-school-body, .report-tier-body { display: none; padding: var(--space-s); background: var(--bg-1); }
  .report-school-body.open, .report-tier-body.open { display: block; }
  .report-tier { margin-bottom: var(--space-xs); border: 1px solid var(--border-soft); border-radius: var(--r-sm); overflow: hidden; }
  .report-exo { margin-block: var(--space-s); padding: var(--space-s); background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); }
  .report-exo-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-bottom: var(--space-xs); font-size: var(--fs-small); }
  .report-exo-head .exo-id { font-weight: 700; color: var(--accent); }
  .report-exo-head .exo-status { padding: 1px 8px; border-radius: var(--r-pill); font-size: var(--fs-tiny); font-weight: 700; }
  .report-exo-head .exo-status.success { background: rgba(63,185,80,0.15); color: var(--green); }
  .report-exo-head .exo-status.fail    { background: rgba(248,81,73,0.15); color: var(--red); }
  .report-exo-head .exo-status.bypass  { background: rgba(139,148,158,0.15); color: var(--text-muted); }
  .report-exo-head .exo-pts { margin-left: auto; color: var(--text-muted); font-size: var(--fs-tiny); }
  .report-exo-label { font-size: var(--fs-tiny); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-top: var(--space-xs); margin-bottom: 4px; font-weight: 700; }
  .report-code {
    background: var(--bg-0); border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--space-s); margin-block: 4px; overflow-x: auto;
    font-family: 'Cascadia Code', 'Consolas', 'Courier New', monospace;
    font-size: var(--fs-tiny); color: var(--text); line-height: 1.5;
    white-space: pre; scrollbar-width: none; -ms-overflow-style: none;
  }
  .report-code::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .report-expl { font-size: var(--fs-small); color: var(--text); margin-block: 4px; padding: var(--space-xs) var(--space-s); background: rgba(248,81,73,0.06); border-left: 3px solid var(--red); border-radius: 4px; }
  .report-teacher { font-size: var(--fs-small); color: var(--text); margin-block: 4px; padding: var(--space-xs) var(--space-s); background: rgba(188,140,255,0.08); border-left: 3px solid var(--purple); border-radius: 4px; }
  .report-teacher b { color: var(--purple); }
  .report-raw {
    background: var(--bg-0); border: 1px dashed var(--border); border-radius: var(--r-sm);
    padding: var(--space-s); margin-top: var(--space-xs);
    font-family: 'Cascadia Code', 'Consolas', monospace; font-size: var(--fs-tiny);
    color: var(--text-muted); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    max-height: 400px; overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;
  }
  .report-raw::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .report-selfprofile { font-size: var(--fs-small); color: var(--text); margin-block: var(--space-xs); padding: var(--space-s); background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); }
  .report-selfprofile .sp-title { font-weight: 700; color: var(--accent); margin-bottom: var(--space-xs); font-size: var(--fs-small); }
  .report-selfprofile ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .report-selfprofile li { padding-left: 14px; position: relative; }
  .report-selfprofile li::before { content: "•"; position: absolute; left: 2px; color: var(--text-dim); }
  .report-empty { color: var(--text-dim); font-style: italic; font-size: var(--fs-small); padding: var(--space-s); }

  footer.footer {
    text-align: center; color: var(--text-dim); font-size: var(--fs-tiny);
    margin-top: var(--space-l); padding-block: var(--space-m);
  }

  .toast {
    position: fixed; bottom: var(--space-m); left: 50%; transform: translateX(-50%);
    padding: 10px 22px; border-radius: var(--r-pill); font-size: var(--fs-small);
    color: #fff; opacity: 0; transition: opacity 0.3s, transform 0.3s;
    pointer-events: none; z-index: 9999; box-shadow: var(--shadow-elev);
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
  .toast.ok { background: var(--green); }
  .toast.err { background: var(--red); }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <span class="badge-top">🏇 BenchGo V3 · Classement comportemental</span>
    <h1>Classement BenchGo V3</h1>
    <p class="subtitle">Généré le ${esc(now)} — ${entries.length} modèle${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} du meilleur au pire</p>
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
        <span class="chip" data-size="inconnu">❓ Inconnue <span class="count">${sizeCounts.inconnu}</span></span>
      </div>
      <div class="search-wrap">
        <input type="text" class="search" id="search" placeholder="🔍 Rechercher un modèle…" />
        <span class="result-count" id="resultCount"></span>
        <button class="btn btn-primary" id="btnCopyAll" title="Copier tout le classement (texte brut) pour le partager">⧉ Copier le classement</button>
      </div>
    </div>
  </div>

  <div class="cards" id="cards"></div>
  <p class="empty-msg" id="emptyMsg">Aucun modèle ne correspond à ce filtre.</p>

  <footer class="footer">Généré par BenchGo V3 — leaderboard.js · Cliquez sur une carte pour le détail complet.</footer>
</div>

<div id="modal" class="modal-overlay">
  <div class="modal">
    <div class="modal-head">
      <div class="rank" id="mRank"></div>
      <div class="title">
        <h2 id="mTitle"></h2>
        <div class="tags">
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
  var m = { A:'#3fb950', B:'#58a6ff', C:'#d29922', D:'#bc8cff', F:'#f85149' };
  return m[g] || '#8b949e';
}
function pctColor(p) {
  var pct = Math.max(0, Math.min(100, p));
  // Dégradé fluide vert → rouge : 100% = vert (hue 120), 0% = rouge (hue 0).
  // Interpolation linéaire dans l'espace HSL (saturation/lightness constantses
  // pour un rendu vif et lisible sur fond sombre). Évite les 3 paliers discrets
  // (vert/jaune/rouge) au profit d'un dégradé continu où chaque % a sa teinte.
  var hue = pct * 1.2;
  return 'hsl(' + hue.toFixed(0) + ', 72%, 48%)';
}
// Affichage du % : borne à [0, 100] pour éviter les valeurs négatives absurdes
// (ex: -100% si un carnet ancien stocke un pct négatif pour un modèle éliminé).
function dispPct(p) { return Math.max(0, Math.min(100, p)); }
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
    var rankDisp = i < 3
      ? '<span class="medal">' + (i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉') + '</span>'
      : (i + 1);
    var pc = pctColor(m.pct);
    var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
    var gc = gradeColor(m.grade);
    var helpStr = (m.helpCount > 0 || m.retriedCount > 0)
      ? (m.helpCount > 0 ? 'aide:' + m.helpCount : '') + (m.retriedCount > 0 ? (m.helpCount > 0 ? ' ' : '') + 'rat.:' + m.retriedCount : '')
      : '—';
    var szBadge = '<span class="badge" title="' + esc(m.paramSize.label) + '">' + m.paramSize.icon + ' ' + esc(m.paramSize.short) + '</span>';
    var quantBadge = m.quantization
      ? '<span class="badge quant" title="Quantification du modèle (récupérée via LM Studio /api/v0/models ou saisie manuelle)">🧩 ' + esc(m.quantization) + '</span>'
      : '';

    var html = '<div class="card ' + cardClass + '" onclick="openModal(' + i + ')">' +
      '<div class="card-row">' +
        '<div class="rank">' + rankDisp + '</div>' +
        '<div class="model-name">' +
          '<div class="name-line"><span class="cat-icon">' + m.cat.icon + '</span>' + esc(m.model) + '</div>' +
          '<div class="badges">' + szBadge + ' ' + quantBadge + ' <button class="btn btn-icon" onclick="event.stopPropagation();copyModelName(' + i + ')" title="Copier le nom du modèle">⧉ Nom</button></div>' +
        '</div>' +
        '<div class="mini-stats">' +
          '<div class="mini-stat"><span class="lbl">%</span><span class="val" style="color:' + pc + '">' + dispPct(m.pct) + '%</span><div class="pct-bar-wrap"><div class="pct-bar-fill" style="width:' + Math.max(2,dispPct(m.pct)) + '%;background:' + pc + '"></div></div></div>' +
          '<div class="mini-stat"><span class="lbl">Note</span><span class="val grade" style="color:' + gc + '">' + m.grade + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Santé</span><span class="val" style="color:' + sc + '">' + m.globalLifeScore + ' PV</span></div>' +
          '<div class="mini-stat"><span class="lbl">Oblig.</span><span class="val">' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + '</span></div>' +
          '<div class="mini-stat"><span class="lbl">Aide/Rat.</span><span class="val" style="font-size:var(--fs-tiny)">' + esc(helpStr) + '</span></div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-primary" onclick="event.stopPropagation();openModal(' + i + ')">Détails</button>' +
          '<button class="btn btn-danger" onclick="event.stopPropagation();deleteModel(' + i + ', this)" title="Supprimer du classement">🗑</button>' +
        '</div>' +
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
  var sc = m.globalLifeScore < 0 ? '#f85149' : '#3fb950';
  var gc = gradeColor(m.grade);
  var oc = m.mandatoryTotal > 0 ? pctColor(m.mandatoryPct) : '#8b949e';

  var body = '';
  body += '<h3>Statistiques</h3>';
  body += '<div class="full-stats">';
  body += statBox('Points', m.score + ' / ' + m.max);
  body += statBoxBar('% global', dispPct(m.pct) + '%', pc, dispPct(m.pct));
  body += statBox('Note', '<span style="color:' + gc + ';font-size:1.4em">' + m.grade + '</span>');
  body += statBoxBar('Obligatoire', m.mandatoryTotal > 0 ? m.mandatoryPct + '% (' + m.mandatoryPassed + '/' + m.mandatoryTotal + ')' : '—', oc, m.mandatoryPct);
  body += statBox('Santé', '<span style="color:' + sc + '">' + m.globalLifeScore + ' PV</span>');
  body += statBox('Bonus', m.optionalBonus > 0 ? '+' + m.optionalBonus : '—');
  body += statBox('Aide prof.', m.helpCount > 0 ? m.helpCount + 'x' : '—');
  body += statBox('Rattrapage', m.retriedCount > 0 ? m.retriedCount + 'x' : '—');
  body += statBox('Écoles', m.ecoleCount);
  body += statBox('Quantif.', m.quantization ? '<span style="color:#bc8cff">' + esc(m.quantization) + '</span>' : '—');
  body += '</div>';

  body += '<h3>Forces & Faiblesses</h3>';
  body += '<div class="args-grid">';
  body += argsCol('args-forces', '✅ Forces', m.args.forces);
  body += argsCol('args-weak', '❌ Faiblesses', m.args.faiblesses);
  body += '</div>';
  if (m.args.notes.length > 0) {
    body += '<div class="args-block args-notes" style="margin-top:var(--space-s);">';
    body += '<div class="args-title">ℹ Notes</div><ul class="args-list">';
    for (var n of m.args.notes) body += '<li>' + esc(n) + '</li>';
    body += '</ul></div>';
  }

  body += '<h3>Détail par école</h3>';
  body += '<table class="ecoles-table"><thead><tr>' +
    '<th>École</th><th class="num">Points</th><th>%</th><th>Note</th>' +
    '<th class="num">Bonus</th><th class="num">Santé</th><th class="num">Aide</th><th class="num">Rat.</th><th class="num">Calib.</th><th>Date</th><th>Tent.</th>' +
    '</tr></thead><tbody>';
  for (var e of m.ecoles) {
    var egc = gradeColor(e.grade);
    var epc = pctColor(e.pct);
    var attempts = e.attempts || [];
    var hasHistory = attempts.length > 1;
    var ecoleCell = esc(e.ecole);
    if (hasHistory) {
      ecoleCell += ' <span class="hist-toggle" onclick="toggleHistory(this)" title="Voir l&#39;historique des re-tests">▸ ' + attempts.length + ' tentatives</span>';
    }
    body += '<tr' + (hasHistory ? ' class="ecole-main"' : '') + '>' +
      '<td>' + ecoleCell + '</td>' +
      '<td class="num">' + e.score + '/' + e.max + '</td>' +
      '<td style="color:' + epc + '">' + e.pct + '%</td>' +
      '<td class="grade" style="color:' + egc + '">' + e.grade + '</td>' +
      '<td class="num">' + (e.optionalBonus > 0 ? '+' + e.optionalBonus : '—') + '</td>' +
      '<td class="num">' + e.globalLifeScore + '</td>' +
      '<td class="num">' + (e.helpCount > 0 ? e.helpCount : '—') + '</td>' +
      '<td class="num">' + (e.retriedCount > 0 ? e.retriedCount : '—') + '</td>' +
      '<td class="num">' + (e.calibrationIndex != null ? 'C=' + e.calibrationIndex.toFixed(2) : '—') + '</td>' +
      '<td>' + esc(e.date) + '</td>' +
      '<td class="num">' + attempts.length + '</td>' +
      '</tr>';
    if (hasHistory) {
      body += '<tr class="hist-row" style="display:none;"><td colspan="11">' +
        '<div class="hist-block">' +
        '<div class="hist-title">Historique des ' + attempts.length + ' tentatives (chronologique) :</div>' +
        '<table class="hist-table"><thead><tr>' +
        '<th>#</th><th class="num">Points</th><th>%</th><th>Note</th>' +
        '<th class="num">Bonus</th><th class="num">Santé</th><th class="num">Aide</th><th class="num">Rat.</th><th class="num">Calib.</th><th>Date</th>' +
        '</tr></thead><tbody>';
      for (var a of attempts) {
        var agc = gradeColor(a.grade);
        var apc = pctColor(a.pct);
        var isBest = (a.pct === e.pct && a.score === e.score);
        var bestTag = isBest ? ' <span class="best-tag" title="Meilleure tentative">★</span>' : '';
        body += '<tr' + (isBest ? ' class="hist-best"' : '') + '>' +
          '<td class="num">' + a.n + bestTag + '</td>' +
          '<td class="num">' + a.score + '/' + a.max + '</td>' +
          '<td style="color:' + apc + '">' + a.pct + '%</td>' +
          '<td class="grade" style="color:' + agc + '">' + a.grade + '</td>' +
          '<td class="num">' + (a.optionalBonus > 0 ? '+' + a.optionalBonus : '—') + '</td>' +
          '<td class="num">' + a.globalLifeScore + '</td>' +
          '<td class="num">' + (a.helpCount > 0 ? a.helpCount : '—') + '</td>' +
          '<td class="num">' + (a.retriedCount > 0 ? a.retriedCount : '—') + '</td>' +
          '<td class="num">' + (a.calibrationIndex != null ? 'C=' + a.calibrationIndex.toFixed(2) : '—') + '</td>' +
          '<td>' + esc(a.date) + (a.time ? ' ' + esc(a.time).replace('-', 'h') : '') + '</td>' +
          '</tr>';
      }
      body += '</tbody></table></div></td></tr>';
    }
  }
  body += '</tbody></table>';

  // --- Rapport intégral : tiers, exercices, code, raisonnement, corrections
  body += '<h3>📋 Rapport intégral (comportement & raisonnement)</h3>';
  body += '<div class="report-actions">';
  body += '<button class="btn btn-primary" id="btnExportReport" onclick="exportReport(' + idx + ')" title="Télécharger le rapport intégral (Markdown) prêt à transmettre à Gemini/ChatGPT pour analyse → NotebookLM">⬇ Exporter le rapport intégral</button>';
  body += '<span class="report-actions-hint">Télécharge un fichier .md à envoyer à un modèle cloud (Gemini, ChatGPT…) pour analyse → verdict → NotebookLM.</span>';
  body += '</div>';
  body += '<div class="report-block">';
  var hasAnyTier = false;
  for (var e of m.ecoles) {
    var tiers = e.tiers || [];
    var sp = e.selfProfile;
    if (tiers.length === 0 && !sp) continue;
    hasAnyTier = true;
    body += '<div class="report-school">';
    body += '<div class="report-school-head" onclick="toggleReport(this)"><span class="caret">▶</span><span class="sch-title">🏫 ' + esc(e.ecole) + '</span><span class="exo-pts">' + tiers.length + ' tier(s)</span></div>';
    body += '<div class="report-school-body">';
    if (sp && sp.skills) {
      body += '<div class="report-selfprofile">';
      body += '<div class="sp-title">🧠 Auto-profilage déclaré par le modèle</div><ul>';
      var spLabels = {
        javascript_basics: 'JavaScript — Bases & Algorithmique simple',
        javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
        algorithms_advanced: 'Algorithmes & Structures de données avancées',
        code_debugging: 'Débogage & Sécurité applicative'
      };
      for (var sk in spLabels) {
        var lvl = sp.skills[sk] ? sp.skills[sk].level : '?';
        body += '<li><b>' + esc(spLabels[sk]) + '</b> : niveau ' + lvl + '/5</li>';
      }
      if (sp.justification) body += '<li><i>Justification :</i> ' + esc(sp.justification) + '</li>';
      body += '</ul></div>';
    }
    for (var t of tiers) {
      body += '<div class="report-tier">';
      var mandBadge = t.isMandatory
        ? '<span class="th-badge mand">Obligatoire</span>'
        : '<span class="th-badge opt">Optionnel</span>';
      body += '<div class="report-tier-head" onclick="toggleReport(this)"><span class="caret">▶</span><span class="th-title">Tier ' + esc(String(t.tierNum)) + ' — ' + esc(t.tierTitle || '') + ' (' + esc(t.className || '') + ')</span>' + mandBadge + '</div>';
      body += '<div class="report-tier-body">';
      var evals = t.evalResults || [];
      if (evals.length > 0) {
        body += '<div class="report-exo-label">Exercices tentés (' + evals.length + ')</div>';
        for (var r of evals) {
          var stCls = r.status === 'success' ? 'success' : (r.status === 'bypassed' ? 'bypass' : 'fail');
          var stTxt = r.status === 'success' ? '✔ Validé' : (r.status === 'bypassed' ? '⊘ Bypassé' : '✘ Échec');
          body += '<div class="report-exo">';
          body += '<div class="report-exo-head"><span class="exo-id">' + esc(r.id) + '</span>' + (r.taskType ? '<span class="badge">' + esc(r.taskType) + '</span>' : '') + '<span class="exo-status ' + stCls + '">' + stTxt + '</span><span class="exo-pts">' + r.points + '/' + r.maxPoints + ' pts' + (r.helpUsed ? ' · aide' : '') + (r.retried ? ' · rattrapage' : '') + '</span></div>';
          if (r.status === 'bypassed') { body += '<div class="report-empty">Exercice bypassé (non exécuté).</div>'; body += '</div>'; continue; }
          if (r.code && String(r.code).trim()) {
            body += '<div class="report-exo-label">Code proposé</div>';
            body += '<pre class="report-code">' + esc(String(r.code).trim()) + '</pre>';
          } else {
            body += '<div class="report-empty">Aucun code exploitable produit.</div>';
          }
          if (r.failureExplanation) {
            body += '<div class="report-exo-label">Explication de l\\'échec (par l\\'élève)</div>';
            body += '<div class="report-expl">' + esc(r.failureExplanation) + '</div>';
          }
          if (r.teacherCorrection) {
            body += '<div class="report-exo-label">🎓 Correction du professeur IA</div>';
            body += '<div class="report-teacher">' + esc(r.teacherCorrection) + '</div>';
          }
          body += '</div>';
        }
      } else {
        body += '<div class="report-empty">Aucun exercice enregistré pour ce tier.</div>';
      }
      if (t.rawResponse && String(t.rawResponse).trim()) {
        body += '<div class="report-exo-label">💭 Réponse brute complète du modèle (raisonnement + code)</div>';
        body += '<pre class="report-raw">' + esc(String(t.rawResponse).trim()) + '</pre>';
      }
      body += '</div></div>';
    }
    body += '</div></div>';
  }
  if (!hasAnyTier) {
    body += '<div class="report-empty">Aucun rapport intégral disponible pour ce modèle (données antérieures à l\\'export du raisonnement, ou carnet introuvable).</div>';
  }
  body += '</div>';

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
  return '<div class="full-stat"><div class="lbl">' + lbl + '</div><div class="val" style="color:' + color + '">' + val + '</div><div class="bar"><div style="width:' + Math.max(2,pct) + '%;background:' + color + '"></div></div></div>';
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
function toggleHistory(el) {
  var mainRow = el.closest('tr.ecole-main');
  if (!mainRow) return;
  var histRow = mainRow.nextElementSibling;
  if (!histRow || !histRow.classList.contains('hist-row')) return;
  var shown = histRow.style.display !== 'none';
  histRow.style.display = shown ? 'none' : 'table-row';
  el.textContent = (shown ? '▸' : '▾') + ' ' + (el.getAttribute('data-n') || (el.textContent.match(/(\d+)/) || [,''])[1]) + ' tentatives';
  el.setAttribute('data-n', el.textContent.match(/(\d+)/) ? el.textContent.match(/(\d+)/)[1] : '');
}
// Plier/déplier les sections du rapport intégral (école + tier) dans la modale.
// el = en-tête cliqué (.report-school-head ou .report-tier-head) ; le body est
// le prochain sibling. La classe .open fait pivoter le caret et affiche le body.
function toggleReport(el) {
  var body = el.nextElementSibling;
  if (!body) return;
  var isOpen = body.classList.toggle('open');
  el.classList.toggle('open', isOpen);
}
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

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

function showToast(msg, ok) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(function(){ t.className = 'toast ' + (ok ? 'ok' : 'err'); }, 2500);
}
function deleteModel(idx, btn) {
  var shortName = MODELS[idx].shortName;
  if (!confirm('Supprimer le modèle "' + shortName + '" du classement ?\\nLe carnet de scores sera définitivement supprimé.')) return;
  btn.disabled = true;
  btn.textContent = '…';
  fetch('/api/delete?shortName=' + encodeURIComponent(shortName), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { showToast('Modèle supprimé — classement régénéré', true); setTimeout(function(){ location.reload(); }, 800); }
      else { showToast('Erreur : ' + (data.error || 'inconnue'), false); btn.disabled = false; btn.textContent = '🗑'; }
    })
    .catch(function(err) {
      // Erreur réseau = le HTML a été ouvert en file:// (double-clic) sans serveur.
      // Le fetch vers /api/delete ne peut pas résoudre sans serveur HTTP local.
      var isFileProtocol = (location.protocol === 'file:');
      var msg = isFileProtocol
        ? 'Suppression impossible : ouvrez le classement via le serveur (node leaderboard.js --serve) — le bouton 🗑 nécessite un serveur local.'
        : 'Erreur réseau : serveur injoignable. Relancez node leaderboard.js --serve.';
      showToast(msg, false);
      btn.disabled = false;
      btn.textContent = '🗑';
    });
}

function copyModelName(idx) {
  var name = MODELS[idx].model;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(name).then(function() { showToast('Nom copié : ' + name, true); }, function() { fallbackCopy(name); });
  } else { fallbackCopy(name); }
}

// Exporte le rapport intégral d'un modèle : déclenche le téléchargement d'un
// fichier Markdown généré à la volée par le serveur (/api/report?shortName=...).
// Le fichier contient l'auto-profilage, toutes les écoles, tous les tiers, tous
// les exercices avec code + explications + corrections + réponses brutes.
// Il est conçu pour être transmis à un modèle cloud (Gemini, ChatGPT, Claude…)
// qui l'analysera puis produira un verdict à injecter dans NotebookLM.
function exportReport(idx) {
  var m = MODELS[idx];
  var shortName = encodeURIComponent(m.shortName);
  var btn = document.getElementById('btnExportReport');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération…'; }
  // Désactive le mode serveur (ouverture locale du HTML) : on construit le MD
  // côté client à partir des données déjà présentes dans MODELS, puis on
  // déclenche le téléchargement via un Blob. En mode --serve, on fetch le
  // serveur qui génère le MD complet (idem raisonnement_modeles.md par modèle).
  function downloadBlob(md, filename) {
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    showToast('Rapport téléchargé : ' + filename, true);
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Exporter le rapport intégral'; }
  }
  function clientFallback() {
    // Repli : génère un MD minimal côté client (les données MODELS contiennent
    // déjà les tiers/exercices/code/rawResponse). Moins riche que la version
    // serveur mais fonctionnel si on ouvre le HTML sans serveur.
    var md = '# Rapport intégral — ' + m.model + '\\n\\n';
    md += '**Nom court :** ' + m.shortName + '\\n';
    md += '- Score global : ' + m.score + '/' + m.max + ' (' + m.pct + '%) — Note ' + m.grade + '\\n';
    md += '- Quantification : ' + (m.quantization || '—') + '\\n\\n';
    for (var i = 0; i < m.ecoles.length; i++) {
      var ec = m.ecoles[i];
      md += '### École : ' + ec.ecole + '\\n\\n';
      if (ec.selfProfile && ec.selfProfile.skills) {
        md += '#### Auto-profilage déclaré\\n';
        var sp = ec.selfProfile.skills;
        md += '- javascript_basics : ' + (sp.javascript_basics ? sp.javascript_basics.level : '?') + '/5\\n';
        md += '- javascript_async : ' + (sp.javascript_async ? sp.javascript_async.level : '?') + '/5\\n';
        md += '- algorithms_advanced : ' + (sp.algorithms_advanced ? sp.algorithms_advanced.level : '?') + '/5\\n';
        md += '- code_debugging : ' + (sp.code_debugging ? sp.code_debugging.level : '?') + '/5\\n';
        if (ec.selfProfile.justification) md += '- Justification : ' + ec.selfProfile.justification + '\\n';
        md += '\\n';
      }
      for (var j = 0; j < (ec.tiers || []).length; j++) {
        var t = ec.tiers[j];
        md += '#### Tier ' + t.tierNum + ' — ' + (t.tierTitle || '') + ' (' + (t.className || '') + ')\\n\\n';
        md += '- Statut : ' + (t.isMandatory ? 'Obligatoire' : 'Optionnel') + '\\n\\n';
        var evals = t.evalResults || [];
        if (evals.length > 0) {
          md += '| Exercice | Type | Points | Max | Statut |\\n|---|---|---:|---:|---|\\n';
          for (var k = 0; k < evals.length; k++) {
            var r = evals[k];
            var st = r.status === 'success' ? '✔ Validé' : (r.status === 'bypassed' ? '⊘ Bypassé' : '✘ Échec');
            md += '| ' + r.id + ' | ' + (r.taskType || '—') + ' | ' + r.points + ' | ' + r.maxPoints + ' | ' + st + ' |\\n';
          }
          md += '\\n';
          for (var k2 = 0; k2 < evals.length; k2++) {
            var r2 = evals[k2];
            if (r2.status === 'bypassed') continue;
            md += '**Exercice ' + r2.id + '** (' + (r2.status === 'success' ? 'validé' : 'échec') + ')\\n\\n';
            if (r2.code && String(r2.code).trim()) md += '\`\`\`javascript\\n' + String(r2.code).trim() + '\\n\`\`\`\\n\\n';
            if (r2.failureExplanation) md += '**Explication échec :** ' + r2.failureExplanation + '\\n\\n';
            if (r2.teacherCorrection) md += '**🎓 Correction professeur :** ' + r2.teacherCorrection + '\\n\\n';
          }
        }
        if (t.rawResponse && String(t.rawResponse).trim()) md += '##### Réponse brute\\n\\n\`\`\`text\\n' + String(t.rawResponse).trim() + '\\n\`\`\`\\n\\n';
      }
      md += '---\\n\\n';
    }
    var safe = String(m.shortName || 'modele').replace(/[^a-zA-Z0-9._-]/g, '_');
    var d = new Date();
    var p = function(n){ return String(n).padStart(2,'0'); };
    var fn = 'rapport_integral_' + safe + '_' + d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '.md';
    downloadBlob(md, fn);
  }
  // Tente d'abord le serveur (rapport complet identique à raisonnement_modeles.md).
  fetch('/api/report?shortName=' + shortName)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var cd = r.headers.get('Content-Disposition') || '';
      var mFn = cd.match(/filename="([^"]+)"/);
      var filename = mFn ? mFn[1] : ('rapport_integral_' + m.shortName + '.md');
      return r.text().then(function(txt) { downloadBlob(txt, filename); });
    })
    .catch(function(err) {
      // Hors serveur (ouverture locale du fichier HTML) ou serveur injoignable.
      clientFallback();
    });
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('Nom copié : ' + text, true); }
  catch (e) { showToast('Copie impossible', false); }
  document.body.removeChild(ta);
}

function copyLeaderboard() {
  var btn = document.getElementById('btnCopyAll');
  var activeCat = document.querySelector('#chips .chip.active').getAttribute('data-cat');
  var activeSize = document.querySelector('#sizeChips .chip.active').getAttribute('data-size');
  var q = document.getElementById('search').value.trim().toLowerCase();

  var lines = [];
  lines.push('🏇 Classement BenchGo V3 — ' + new Date().toLocaleString('fr-FR'));
  lines.push('Filtre catégorie : ' + (activeCat === 'all' ? 'tous' : activeCat) + ' | Taille : ' + (activeSize === 'all' ? 'toutes' : activeSize) + (q ? ' | Recherche : ' + q : ''));
  lines.push('');
  lines.push('Rang | Modèle | Quantif. | Points | % | Note | Oblig. | Santé | Écoles | Verdict');
  lines.push('---|---|---|---|---|---|---|---|---|---');
  var copied = 0;
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    if (activeCat !== 'all' && m.cat.key !== activeCat) continue;
    if (activeSize !== 'all' && m.paramSize.key !== activeSize) continue;
    if (q && m.model.toLowerCase().indexOf(q) === -1 && m.shortName.toLowerCase().indexOf(q) === -1) continue;
    var rank = copied < 3 ? ['🥇','🥈','🥉'][copied] : ('' + (copied + 1));
    lines.push(rank + ' | ' + m.model + ' | ' + (m.quantization || '—') + ' | ' + m.score + '/' + m.max + ' | ' + m.pct + '% | ' + m.grade + ' | ' + (m.mandatoryTotal > 0 ? m.mandatoryPct + '%' : '—') + ' | ' + m.globalLifeScore + ' PV | ' + m.ecoleCount + ' | ' + m.verdict.label);
    copied++;
  }
  lines.push('');
  lines.push('Total : ' + copied + ' modèle(s) — généré par BenchGo V3');

  var text = lines.join('\\n');
  var finish = function(ok) {
    if (ok) {
      showToast('Classement copié (' + copied + ' modèle' + (copied > 1 ? 's' : '') + ')', true);
      if (btn) { btn.classList.add('done'); btn.textContent = '✓ Copié !'; setTimeout(function(){ btn.classList.remove('done'); btn.textContent = '⧉ Copier le classement'; }, 2000); }
    } else {
      showToast('Copie impossible', false);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){ finish(true); }, function(){ fallbackCopy(text); finish(true); });
  } else {
    fallbackCopy(text); finish(true);
  }
}
document.getElementById('btnCopyAll').addEventListener('click', copyLeaderboard);

// Barre sticky : ajoute la classe .stuck dès qu'on scrolle pour renforcer le
// contraste (fond + opaque + ombre) et signaler visuellement le "détachement".
(function() {
  var bar = document.getElementById('stickyBar');
  if (!bar) return;
  function onScroll() {
    if (window.scrollY > 4) bar.classList.add('stuck');
    else bar.classList.remove('stuck');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

renderCards();
</script>
</body>
</html>`;

  return html;
}

function buildLeaderboardMarkdown(entries) {
  let md = `# 🏇 Classement BenchGo V3\n\n`;
  md += `> Généré le ${new Date().toLocaleString('fr-FR')} — ${entries.length} modèle(s) classé(s)\n\n`;
  md += `| Rang | Modèle | Quantif. | Points | % | Note | Oblig. | Santé | Bonus | Aide | Rat. | Écoles | Verdict | Forces & Faiblesses |\n`;
  md += `|---:|---|:---:|---|---:|:---:|---:|---:|---:|---:|---:|---:|---|---|\n`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);

    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    const quant = e.quantization || '—';
    const argsText = [];
    if (args.forces.length > 0) argsText.push('**Forces :** ' + args.forces.join(', '));
    if (args.faiblesses.length > 0) argsText.push('**Faiblesses :** ' + args.faiblesses.join(', '));
    if (args.notes.length > 0) argsText.push('*' + args.notes.join(', ') + '*');

    md += `| ${medal} | ${e.model} | ${quant} | ${e.score}/${e.max} | ${e.pct}% | ${grade.grade} | ${e.mandatoryTotal > 0 ? e.mandatoryPct + '%' : '—'} | ${e.globalLifeScore} | ${e.optionalBonus > 0 ? '+' + e.optionalBonus : '—'} | ${e.helpCount || '—'} | ${e.retriedCount || '—'} | ${e.ecoleCount} | ${verdict.label} | ${argsText.join(' · ')} |\n`;
  }

  md += `\n---\n\n## Détail par modèle\n\n`;
  for (const e of entries) {
    const verdict = getVerdict(e);
    const grade = letterGrade(e.pct);
    const args = buildArguments(e);
    md += `### ${e.model}\n\n`;
    md += `- **Quantification :** ${e.quantization || '—'}\n`;
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
    md += buildModelReportMarkdown(e);
    md += `\n`;
  }

  return md;
}

// Génère le rapport intégral Markdown d'UN SEUL modèle (auto-profilage, toutes
// écoles, tous tiers, tous exercices avec code + explications + corrections +
// réponses brutes). Réutilisé par :
//   - buildReasoningMarkdown (consolidation globale)
//   - la route /api/report du serveur (téléchargement par modèle depuis la modale)
// Le rapport est conçu pour être transmis à un modèle cloud (Gemini, ChatGPT…)
// qui l'analysera puis produira un verdict à injecter dans NotebookLM.
function buildModelReportMarkdown(e) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const genTime = `${pad(now.getHours())}h${pad(now.getMinutes())}`;

  let md = `## ${e.model}\n\n`;
  md += `**Nom intégral du modèle :** ${e.model}\n\n`;
  md += `**Nom court :** ${e.shortName}\n\n`;
  md += `**Rapport généré le :** ${genDate} à ${genTime}\n\n`;
  md += `- **Quantification :** ${e.quantization || '—'}\n`;
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
    return md;
  }

  for (const ecole of e.ecoles) {
    const ecoleEntry = normalizeEcoleEntryLb(ledger.ecoles[ecole.ecole]).best;
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
            md += `**Explication de l'échec (par l'élève) :** ${r.failureExplanation}\n\n`;
          }
          if (r.teacherCorrection) {
            md += `**🎓 Correction du professeur IA :** ${r.teacherCorrection}\n\n`;
          }
        }
      }

      if (t.rawResponse && String(t.rawResponse).trim()) {
        md += `##### Réponse brute complète du modèle pour ce tier\n\n`;
        md += `> Contient le raisonnement et les réponses du modèle tels que produits\n`;
        md += `> pendant le run (concaténation des tentatives successives).\n\n`;
        md += `\`\`\`text\n${String(t.rawResponse).trim()}\n\`\`\`\n\n`;
      }
    }

    md += `\n---\n\n`;
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
    const quant = e.quantization ? `\x1b[35m${e.quantization.padEnd(8)}\x1b[0m ` : '\x1b[90m—       \x1b[0m ';
    console.log(`  ${medal} \x1b[1m${(i + 1 + '.').padEnd(4)}\x1b[0m ${e.model.substring(0, 45).padEnd(45)} ${quant}${String(e.pct + '%').padStart(5)}  ${vColor}${verdict.label}\x1b[0m`);
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

// Démarre un mini-serveur HTTP servant le classement HTML + l'API de suppression
// + l'API d'export du rapport intégral d'un modèle (téléchargement Markdown).
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

    // API : export du rapport intégral d'un modèle (téléchargement Markdown).
    // Génère à la volée le rapport complet (auto-profilage, toutes écoles, tous
    // tiers, exercices, code, raisonnement brut) prêt à transmettre à un modèle
    // cloud (Gemini, ChatGPT…) pour analyse → verdict → NotebookLM.
    if (url.pathname === '/api/report' && req.method === 'GET') {
      const shortName = url.searchParams.get('shortName');
      if (!shortName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'shortName manquant' }));
        return;
      }
      const entry = getModelEntryByShortName(shortName);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Modèle introuvable : ' + shortName }));
        return;
      }
      // En-tête Markdown global + rapport du modèle
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const genDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const genTime = `${pad(now.getHours())}h${pad(now.getMinutes())}`;
      let md = `# 🧠 Rapport intégral — ${entry.model}\n\n`;
      md += `> Fichier généré le ${genDate} à ${genTime} — destiné à l'analyse qualitative\n`;
      md += `> par un modèle cloud (Gemini, ChatGPT, Claude…) puis injection dans NotebookLM.\n`;
      md += `> Transmettez ce fichier au modèle et demandez une analyse du raisonnement,\n`;
      md += `> des échecs, du code produit et un verdict qualitatif global.\n\n`;
      md += `---\n\n`;
      md += buildModelReportMarkdown(entry);

      const safeName = String(entry.shortName || 'modele').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `rapport_integral_${safeName}_${genDate}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(md, 'utf8');
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
    console.log('  \x1b[90mModale → bouton "⬇ Exporter le rapport intégral" pour télécharger le MD.\x1b[0m');
    console.log('  \x1b[90mCtrl+C pour arrêter le serveur.\x1b[0m\n');

    // Ouvre le navigateur par défaut
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd, () => {});
  });
}

// Retrouve l'entry agrégée d'un modèle par shortName (charge + agrège les carnets).
// Utilisé par la route /api/report pour générer le rapport intégral d'un modèle.
function getModelEntryByShortName(shortName) {
  const ledgers = loadAllLedgers();
  const entry = ledgers.map(aggregateLedger).filter(Boolean).find(e => e.shortName === shortName);
  return entry || null;
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