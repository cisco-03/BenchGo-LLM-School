function sanitizeFilename(name) {
  if (!name) return 'modele_inconnu';
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

function shortenModelName(rawName) {
  if (!rawName) return 'modele_inconnu';
  const cleaned = rawName.toString().trim().toLowerCase();

  let segs = cleaned.split(/[\\/]/).map(s => s.trim()).filter(Boolean);
  if (segs.length === 0) return 'modele_inconnu';

  segs = segs.map(seg => seg.replace(/\.gguf$/i, '').replace(/-gguf$/i, ''));

  const kept = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const estPrefixe = segs.slice(i + 1).some(later =>
      later === seg || later.startsWith(seg + '-') || later.startsWith(seg + '_')
    );
    if (!estPrefixe) kept.push(seg);
  }

  return sanitizeFilename(kept.join('_'));
}

function buildTierReport(tierData, evalResults, rawResponse, stats = {}) {
  let report = `## Tier ${tierData.tier} — ${tierData.title}\n\n`;
  report += `**Difficulté :** ${tierData.difficulty}\n\n`;

  let totalPassed = 0;
  let totalCount = 0;

  for (const taskResult of evalResults) {
    const passedCount = taskResult.evaluations.filter(e => e.passed).length;
    const taskPassed = passedCount === taskResult.evaluations.length;
    totalPassed += passedCount;
    totalCount += taskResult.evaluations.length;

    let tags = '';
    if (taskResult.helpUsed) tags += ' *(avec aide)*';
    if (taskResult.retried) tags += ' *(rattrapage)*';
    report += `### ${taskResult.id} — ${taskResult.label} ${taskPassed ? '✔' : '✘'}${tags}\n\n`;
    report += `Score : ${passedCount}/${taskResult.evaluations.length}\n\n`;

    for (const ev of taskResult.evaluations) {
      const icon = ev.passed ? '✔' : '✘';
      report += `- ${icon} ${ev.description}`;
      if (!ev.passed && ev.error) {
        report += ` — *${ev.error}*`;
      }
      report += '\n';
    }
    report += '\n';

    if (taskResult.code) {
      report += '```\n' + taskResult.code + '\n```\n\n';
    }
  }

  const pct = totalCount > 0 ? Math.round((totalPassed / totalCount) * 100) : 0;
  
  // Calculate points
  const points = evalResults.reduce((sum, tr) => sum + tr.points, 0);
  
  const annotation = (stats.tierAnnotations && stats.tierAnnotations.length > 0)
    ? ` (${stats.tierAnnotations.join(', ')})`
    : '';
  report += `**Score du tier : ${points}/100 Points${annotation}**\n`;
  if (points >= 70) {
    report += `> 🏆 **Classe Validée avec Mention**\n\n`;
  } else {
    report += `> ❌ **Classe Non Validée (Seuil de 70 points non atteint)**\n\n`;
  }

  report += `<details>\n<summary>Réponse brute du modèle</summary>\n\n`;
  report += '```\n' + (rawResponse || 'N/A') + '\n```\n\n</details>\n\n---\n\n';

  const allPassed = totalCount > 0 && totalPassed === totalCount;

  return { report, allPassed };
}

module.exports = { buildTierReport, sanitizeFilename, shortenModelName };
