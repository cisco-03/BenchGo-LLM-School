// benchmark-metrics.js — Benchmarking intégré : latence et tokens par modèle.
//
// Plan §2 (Performance / Fiabilité) : mesurer la latence (ms) et le débit
// (tokens/s) de chaque appel API et écrire un récapitulatif dans le rapport
// pour pouvoir prioriser les axes d'optimisation. Centralise la collecte des
// métriques de performance pour qu'elles soient cohérentes entre LM Studio et
// les providers cloud.
//
// Toutes les métriques sont journalisées (INFO) à chaque enregistrement pour
// permettre le diagnostic post-run : si un modèle est lent ou instable, les
// logs permettront de voir à quel tier exact la latence explose.

const logger = require('./logger');

// Registre des métriques par modèle : { modelName: { calls: [], totals } }
const _metrics = new Map();

// Enregistre une mesure pour un appel API.
//   modelName : nom du modèle (ex: "glm-5.2", "gpt-4o")
//   durationMs : durée de l'appel (ms)
//   tokens : nombre de tokens produits (content + reasoning)
//   tierId : identifiant du tier (pour corrélation avec les logs)
//   status : 'OK' | 'ERREUR' | 'TIMEOUT'
function record({ modelName, durationMs, tokens = 0, tierId = '?', status = 'OK' }) {
  if (!modelName) modelName = '(inconnu)';
  if (!_metrics.has(modelName)) {
    _metrics.set(modelName, { calls: [], totals: { count: 0, totalMs: 0, totalTokens: 0, errors: 0, timeouts: 0 } });
  }
  const m = _metrics.get(modelName);
  const entry = { durationMs, tokens, tierId, status, ts: Date.now() };
  m.calls.push(entry);
  m.totals.count++;
  m.totals.totalMs += durationMs || 0;
  m.totals.totalTokens += tokens || 0;
  if (status === 'ERREUR') m.totals.errors++;
  if (status === 'TIMEOUT') m.totals.timeouts++;

  const tps = durationMs > 0 ? ((tokens / (durationMs / 1000)).toFixed(1)) : '0';
  logger.info('Bench[' + modelName + ']: tier=' + tierId + ' durée=' + durationMs + 'ms tokens=' + tokens + ' (' + tps + ' t/s) statut=' + status);
}

// Récupère les métriques agrégées par modèle (pour le récapitulatif du rapport).
function getAggregated() {
  const result = [];
  for (const [modelName, m] of _metrics.entries()) {
    const t = m.totals;
    const avgMs = t.count > 0 ? Math.round(t.totalMs / t.count) : 0;
    const tokensPerSec = t.totalMs > 0 ? Math.round((t.totalTokens / (t.totalMs / 1000)) * 100) / 100 : 0;
    result.push({
      modelName,
      calls: t.count,
      totalMs: t.totalMs,
      avgMs,
      totalTokens: t.totalTokens,
      tokensPerSec,
      errors: t.errors,
      timeouts: t.timeouts,
      errorRate: t.count > 0 ? Math.round((t.errors + t.timeouts) / t.count * 100) : 0
    });
  }
  // Tri par nombre d'appels décroissant (les modèles les plus sollicités d'abord).
  result.sort((a, b) => b.calls - a.calls);
  return result;
}

// Génère une section Markdown récapitulative pour le rapport (§2).
function buildReportSection() {
  const agg = getAggregated();
  if (agg.length === 0) return '';
  let md = '\n---\n\n## Benchmarking intégré — latence et débit par modèle\n\n';
  md += '> Mesures collectées pendant le run pour prioriser les axes d\'optimisation.\n\n';
  md += '| Modèle | Appels | Durée totale | Durée moy. | Tokens | Vitesse moy. | Erreurs | Taux d\'erreur |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  for (const a of agg) {
    const durTot = (a.totalMs / 1000).toFixed(1) + 's';
    const durAvg = a.avgMs + 'ms';
    const tps = a.tokensPerSec > 0 ? a.tokensPerSec + ' t/s' : '—';
    md += '| ' + a.modelName + ' | ' + a.calls + ' | ' + durTot + ' | ' + durAvg + ' | ' + a.totalTokens + ' | ' + tps + ' | ' + (a.errors + a.timeouts) + ' | ' + a.errorRate + '% |\n';
  }
  md += '\n> *Vitesse moy. = tokens/s moyenne sur la durée d\'inférence cumulée.*\n';
  md += '> *Taux d\'erreur = (erreurs + timeouts) / appels. Un taux élevé indique un modèle instable ou un endpoint saturé.*\n';
  return md;
}

// Réinitialise les métriques (utile entre deux écoles d'un même run si on veut
// des stats séparées, sinon on cumule pour le bilan global).
function reset() {
  _metrics.clear();
  logger.info('Bench: métriques réinitialisées');
}

// Affiche un résumé console compact (pour le bilan de fin de run).
function printSummary() {
  const agg = getAggregated();
  if (agg.length === 0) return;
  console.log('  \x1b[1;35m━━━ BENCHMARKING INTÉGRÉ ━━━\x1b[0m');
  for (const a of agg) {
    const tps = a.tokensPerSec > 0 ? a.tokensPerSec + ' t/s' : '—';
    const errTag = a.errorRate > 0 ? ' \x1b[33m(' + a.errorRate + '% erreurs)\x1b[0m' : '';
    console.log('    \x1b[1m' + (a.modelName || '?').padEnd(30) + '\x1b[0m ' + a.calls + ' appels · ' + (a.totalMs / 1000).toFixed(1) + 's · ' + a.avgMs + 'ms moy · ' + tps + errTag);
  }
}

module.exports = {
  record,
  getAggregated,
  buildReportSection,
  printSummary,
  reset
};