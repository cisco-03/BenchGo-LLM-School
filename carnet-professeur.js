// carnet-professeur.js — Carnet du Professeur : registre des demandes/signalements.
//
// Rôle : chaque fois qu'un élève (le modèle testé) détecte ou conteste quelque
// chose — pénalité injuste, erreur du grader, divergence avec la correction du
// professeur IA, ou simplement une auto-analyse d'échec — on enregistre une
// « demande » dans un dossier dédié, organisé par date puis par école :
//
//   Carnet-Professeur/<AAAA-MM-JJ>/<ÉCOLE>/demandes.md          (annexé au fil de l'eau)
//   Carnet-Professeur/<AAAA-MM-JJ>/<ÉCOLE>/classement.md        (vue agrégée par classe/modèle)
//
// L'objectif, comme dans le monde réel : l'élève « remet sa copie » au
// professeur (le moteur BenchGo), qui consigne chaque remarque. Plus tard, le
// professeur (l'utilisateur humain, ou un agent) peut rouvrir ce carnet et
// examiner les demandes pour agir en conséquence : corriger un énoncé bancal,
// ajuster un grader trop strict, revoir une pénalité, etc.
//
// Trois types de demandes sont tracés :
//   - 'contestation_penalite' : l'utilisateur a annulé une pénalité (réponse N
//     à « Comptabiliser la pénalité ? »). L'élève a objectivement raison, le
//     grader s'est trompé. C'est le signal le plus fort : action requise côté
//     énoncé/évaluateur.
//   - 'divergence_prof_eleve' : le professeur IA a contredit l'auto-analyse de
//     l'élève (le professeur dit « FAUX » là où l'élève se croyait juste).
//   - 'auto_analyse_echec' : l'élève a produit une auto-analyse d'échec (à
//     conserver même si elle est juste — pour mémoire pédagogique).
//
// Format Markdown lisible par un humain, annexe au fil de l'eau (append), avec
// un entête résumé à chaque run pour regrouper les demandes d'une même session.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CARNET_ROOT = path.join(__dirname, 'Carnet-Professeur');

const TYPE_LABELS = {
  'contestation_penalite': 'Contestation de pénalité (élève a raison / grader en tort)',
  'divergence_prof_eleve': 'Divergence professeur IA vs élève',
  'auto_analyse_echec':    'Auto-analyse d\'échec (élève)'
};

function _pad(n) { return String(n).padStart(2, '0'); }

function _timestamp(now = new Date()) {
  return `${_pad(now.getHours())}:${_pad(now.getMinutes())}:${_pad(now.getSeconds())}`;
}

/**
 * Construit le chemin du dossier du carnet pour une date/école données et le
 * crée s'il n'existe pas. Retourne { dir, demandesPath, classementPath }.
 */
function _ensureCarnetDir({ dateStr, ecole }) {
  const ecoleDir = path.join(CARNET_ROOT, dateStr, ecole || 'Ecole');
  fs.mkdirSync(ecoleDir, { recursive: true });
  return {
    dir: ecoleDir,
    demandesPath: path.join(ecoleDir, 'demandes.md'),
    classementPath: path.join(ecoleDir, 'classement.md')
  };
}

/**
 * Annexe une demande au carnet du jour pour l'école donnée.
 *
 * @param {object} args
 * @param {string} args.dateStr       - AAAA-MM-JJ (cohérent avec Export-Rapports)
 * @param {string} args.ecole         - nom de l'école (ex: 'College-Lycee')
 * @param {string} args.classe        - label de la classe (ex: 'Classe-6-Terminale')
 * @param {string} args.modelName     - nom du modèle élève
 * @param {string} args.type          - 'contestation_penalite' | 'divergence_prof_eleve' | 'auto_analyse_echec'
 * @param {object} args.task          - { id, label, points, ... }
 * @param {string} [args.tierNum]     - numéro de tier/classe
 * @param {string} [args.errors]      - erreur technique du sandbox (rappel)
 * @param {string} [args.studentCode] - code proposé par l'élève (extrait court)
 * @param {string} [args.studentAnalysis] - auto-analyse de l'élève
 * @param {string} [args.teacherCorrection] - correction du professeur IA (si divergence)
 * @param {string} [args.verdict]     - pour les contestations : 'penalite_annulee' etc.
 */
function appendDemande(args) {
  try {
    const { dateStr, ecole, classe, modelName, type, task, tierNum,
            errors, studentCode, studentAnalysis, teacherCorrection, verdict } = args;
    if (!dateStr || !ecole || !type || !task) return null;
    const { demandesPath } = _ensureCarnetDir({ dateStr, ecole });

    const typeLabel = TYPE_LABELS[type] || type;
    const time = _timestamp();
    const codePreview = (studentCode || '').trim().substring(0, 600);
    const errPreview = (errors || '').trim().substring(0, 300);
    const analysisText = (studentAnalysis || '').trim().substring(0, 800);
    const teacherText = (teacherCorrection || '').trim().substring(0, 800);

    const block = [
      '',
      `## ${time} — ${task.id} (${typeLabel})`,
      '',
      `- **École** : ${ecole}`,
      `- **Classe** : ${classe || 'N/A'}${tierNum != null ? ` (Tier ${tierNum})` : ''}`,
      `- **Modèle élève** : ${modelName || '(inconnu)'}`,
      `- **Exercice** : ${task.id} — ${task.label || '—'} (${task.points || '?'} pts)`,
      verdict ? `- **Verdict** : ${verdict}` : null,
      '',
      errPreview ? `**Erreur technique du sandbox :**\n\`\`\`\n${errPreview}\n\`\`\`` : null,
      codePreview ? `**Code de l'élève (extrait) :**\n\`\`\`javascript\n${codePreview}\n\`\`\`` : null,
      analysisText ? `**Auto-analyse de l'élève :**\n${analysisText}` : null,
      teacherText ? `**Correction du professeur IA :**\n${teacherText}` : null,
      '',
      '---'
    ].filter(l => l !== null).join('\n');

    // Crée le fichier avec un entête s'il n'existe pas encore.
    if (!fs.existsSync(demandesPath)) {
      const header = `# Carnet du Professeur — ${ecole} — ${dateStr}\n\n` +
        `Registre des demandes/signalements émis par les élèves (modèles testés) ` +
        `lors des examens du ${dateStr}. Le professeur (utilisateur humain ou agent) ` +
        `peut rouvrir ce carnet plus tard pour examiner chaque demande et agir en ` +
        `conséquence (corriger un énoncé, ajuster un grader, revoir une pénalité).\n\n` +
        `Types de demandes :\n` +
        `- **Contestation de pénalité** : l'utilisateur a annulé une pénalité — l'élève ` +
        `a objectivement raison, le grader s'est trompé. Action requise côté énoncé/évaluateur.\n` +
        `- **Divergence professeur IA vs élève** : le professeur IA contredit l'auto-analyse ` +
        `de l'élève. À examiner pour départager.\n` +
        `- **Auto-analyse d'échec** : l'élève a expliqué lui-même son échec. Conserve pour ` +
        `mémoire pédagogique.\n`;
      fs.writeFileSync(demandesPath, header, 'utf8');
    }
    fs.appendFileSync(demandesPath, block + '\n', 'utf8');
    logger.info(`Carnet-Professeur : demande '${type}' enregistrée pour ${task.id} (${demandesPath}).`);
    return demandesPath;
  } catch (e) {
    logger.warn(`Carnet-Professeur : échec écriture demande (${e.message}).`);
    return null;
  }
}

/**
 * Construit/mets à jour la vue agrégée par classe/modèle pour le jour/école.
 * À appeler en fin de run pour refléter les demandes du run courant.
 *
 * @param {object} args
 * @param {string} args.dateStr
 * @param {string} args.ecole
 * @param {Array}  args.entries - tableau des demandes du run : { classe, modelName, type, taskId, taskLabel, tierNum }
 */
function buildClassement({ dateStr, ecole, entries }) {
  try {
    if (!dateStr || !ecole || !Array.isArray(entries) || entries.length === 0) return null;
    const { classementPath } = _ensureCarnetDir({ dateStr, ecole });

    const byKey = {};
    for (const e of entries) {
      const key = `${e.classe || 'N/A'}|${e.modelName || '(inconnu)'}`;
      if (!byKey[key]) {
        byKey[key] = { classe: e.classe || 'N/A', modelName: e.modelName || '(inconnu)', total: 0, byType: {} };
      }
      byKey[key].total++;
      byKey[key].byType[e.type] = (byKey[key].byType[e.type] || 0) + 1;
    }
    const rows = Object.values(byKey).sort((a, b) => b.total - a.total);

    const md = [
      `# Classement des demandes — ${ecole} — ${dateStr}`,
      '',
      'Synthèse agrégée par classe et modèle élève, générée à la fin du run.',
      '',
      '| Classe | Modèle élève | Total demandes | Contestations | Divergences | Auto-analyses |',
      '|---|---|---|---|---|---|'
    ];
    for (const r of rows) {
      md.push(`| ${r.classe} | ${r.modelName} | ${r.total} ` +
        `| ${r.byType['contestation_penalite'] || 0} ` +
        `| ${r.byType['divergence_prof_eleve'] || 0} ` +
        `| ${r.byType['auto_analyse_echec'] || 0} |`);
    }
    md.push('');
    fs.writeFileSync(classementPath, md.join('\n'), 'utf8');
    logger.info(`Carnet-Professeur : classement mis à jour (${rows.length} ligne(s)).`);
    return classementPath;
  } catch (e) {
    logger.warn(`Carnet-Professeur : échec classement (${e.message}).`);
    return null;
  }
}

module.exports = {
  CARNET_ROOT,
  appendDemande,
  buildClassement,
  TYPE_LABELS
};