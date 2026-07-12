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

// Section "Auto-Profilage & Calibration" injectée en haut du rapport global.
// declaredProfile : { skills: { skill: { level } }, justification }
// calibration : { declaredLevel, actualPerformance, calibrationIndex, executedCount, successCount }
// filterDecisions : [{ taskId, taskLabel, skill, declaredLevel, action }]
// skillLabels : map skill -> libellé (SKILL_LABELS de self-profiling.js)
function buildCalibrationReport(declaredProfile, calibration, filterDecisions, skillLabels) {
  if (!declaredProfile || !calibration) return '';

  let report = `## Auto-Profilage & Calibration\n\n`;
  report += `Le modèle a été interrogé au démarrage pour s'auto-évaluer sur 4 compétences clés (niveau 1 à 5). BenchGo a ensuite filtré les tâches jugées trop difficiles selon cette déclaration, puis calculé l'Indice de Calibration (C) mesurant l'écart entre les capacités déclarées et la performance réelle.\n\n`;

  // Tableau des compétences déclarées
  report += `### Compétences déclarées\n\n`;
  report += `| Compétence | Niveau déclaré (1-5) | Ratio (D) |\n`;
  report += `|---|---|---|\n`;
  const skills = declaredProfile.skills || {};
  for (const [skill, label] of Object.entries(skillLabels || {})) {
    const level = skills[skill] ? skills[skill].level : '—';
    const ratio = (level !== '—') ? (level / 5).toFixed(2) : '—';
    report += `| ${label} | ${level} | ${ratio} |\n`;
  }

  if (declaredProfile.justification) {
    report += `\n> **Justification du modèle :** ${declaredProfile.justification}\n`;
  }

  // Indice de calibration
  report += `\n### Indice de Calibration (C)\n\n`;
  report += `| Métrique | Valeur |\n`;
  report += `|---|---|\n`;
  report += `| Capacité déclarée moyenne (D) | ${(calibration.declaredLevel * 100).toFixed(1)}% |\n`;
  report += `| Performance réelle (P) | ${(calibration.actualPerformance * 100).toFixed(1)}% (${calibration.successCount}/${calibration.executedCount} tâches réussies) |\n`;
  report += `| Écart | ${Math.abs(calibration.declaredLevel - calibration.actualPerformance * 1).toFixed(3)} |\n`;
  report += `| **Indice de Calibration (C)** | **${calibration.calibrationIndex.toFixed(3)}** |\n`;

  // Interprétation
  let verdict = 'Biais de Surconfiance ou Sous-confiance Majeur';
  if (calibration.calibrationIndex >= 0.85) verdict = 'Modèle Hautement Fiable / Lucide';
  else if (calibration.calibrationIndex >= 0.65) verdict = 'Modèle Modérément Calibré';
  report += `\n> **Verdict :** ${verdict}\n`;
  if (calibration.calibrationIndex < 0.65) {
    report += `> Le modèle se surévalue ou se sous-évalue drastiquement par rapport à ses performances réelles.\n`;
  }

  // Décisions de filtrage
  if (filterDecisions && filterDecisions.length > 0) {
    const bypassed = filterDecisions.filter(d => d.action === 'bypassed');
    if (bypassed.length > 0) {
      report += `\n### Tâches bypassées par filtrage (${bypassed.length})\n\n`;
      report += `| Exercice | Compétence | Niveau déclaré | Statut |\n`;
      report += `|---|---|---|---|\n`;
      for (const d of bypassed) {
        const skillLabel = (skillLabels && skillLabels[d.skill]) || d.skill;
        report += `| ${d.taskId} — ${d.taskLabel || ''} | ${skillLabel} | ${d.declaredLevel} | Bypassée (Non déclarée) |\n`;
      }
    }
  }

  report += `\n---\n\n`;
  return report;
}

module.exports = { buildTierReport, sanitizeFilename, shortenModelName, buildCalibrationReport };
