
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('./logger');
const { PROFILES, CLASSE_NAMES, parseCliArgs, detectProfileFromModelName, fetchModelNameFromLMStudio, fetchModelMetadataFromLMStudio, OPTIONAL_BONUS_PCT, selfProfiling, TEACHER_CONFIG, PROFILING_TIMEOUT_MS } = require('./config');
const { ProgressBar, Spinner, letterGrade } = require('./progress-bar');
const { extractJSON, extractCodeRegex } = require('./parsing-utils');
const { queryLLM: queryLLMLocal } = require('./lm-studio-client');
const { queryLLM: queryLLMCloud } = require('./cloud-client');
const { askTeacherToCorrectStudentAnalysis } = require('./teacher-client');
const { loadTiers } = require('./tier-loader');
const { evaluateTask } = require('./task-evaluator');
const { buildTierReport, shortenModelName, buildCalibrationReport } = require('./report-generator');
const { updateTiers } = require('./auto-updater');
const scoreLedger = require('./score-ledger');
const { runSelfProfiling, filterTasksByProfile, SKILL_LABELS } = require('./self-profiling');
const leaderboard = require('./leaderboard');
const secrets = require('./secrets');
const { runStartupQuestionnaire } = require('./startup-questionnaire');
const { buildExternalTeacherReport } = require('./report-teacher');

const DEFAULT_CONTEXT_LIMIT_TOKENS = 16384;
const MAX_RATTRAPAGE_ATTEMPTS = 1;
const MAX_TASK_RETRIES = 1; // Une seule nouvelle tentative par exercice échoué

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extrait le code d'un exercice depuis la réponse brute du modèle.
// Priorité : clé JSON "id" → bloc de code après l'id → JSON global → bloc ``` → toute la réponse.
function extractStudentCode(rawResponse, taskId) {
  if (!rawResponse || !taskId) return null;

  let studentCode = extractCodeRegex(rawResponse, taskId);

  if (!studentCode) {
    try {
      const parsedObj = JSON.parse(extractJSON(rawResponse));
      studentCode = parsedObj[taskId];
      if (studentCode && typeof studentCode === 'object') {
        studentCode = studentCode.code || studentCode.solution || studentCode.fonction;
      }
    } catch (e) { }
  }

  if (!studentCode || typeof studentCode !== 'string' || studentCode.trim().startsWith('{')) {
    const codeMatch = rawResponse.match(/```(?:javascript|js|typescript|ts)?\n([\s\S]*?)```/);
    if (codeMatch) {
      studentCode = codeMatch[1];
    } else {
      // Ultime recours : on tente d'utiliser toute la réponse
      studentCode = rawResponse;
    }
  }

  return studentCode;
}

function isRattrapageEligibleProfile(profileArg) {
  return profileArg === 'LIGHT' || profileArg === 'STANDARD';
}

function shouldReplaceBestResult(currentBest, candidate) {
  if (!currentBest) return true;
  if (candidate.tierPassedCount > currentBest.tierPassedCount) return true;
  if (candidate.tierPassedCount < currentBest.tierPassedCount) return false;
  return candidate.tierPct >= currentBest.tierPct;
}

// --- Traduction pédagogique des erreurs techniques brutes du moteur JS ---
// Le sandbox VM renvoie des erreurs cryptiques (ex: "élèves is not defined",
// "Invalid or unexpected token") qui font croire à un bug du benchmark. Cette
// fonction produit une explication humaine compréhensible utilisée comme repli
// si le modèle n'a pas pu fournir sa propre explication.
function explainTechnicalError(errors, task) {
  const e = (errors || '').toLowerCase();
  const taskId = (task && task.id) || 'cet exercice';

  if (/is not defined/.test(e)) {
    const m = (errors || '').match(/([A-Za-z_$][\w$]*)\s+is not defined/i);
    const sym = m ? m[1] : 'une variable';
    return `L'élève a utilisé ${sym} sans l'avoir déclarée. Le moteur d'exécution ne trouve pas cette référence — il s'agit soit d'une variable/fonction oubliée, soit d'une faute de frappe dans le nom. L'élève aurait dû déclarer ${sym} avant de l'utiliser.`;
  }
  if (/invalid or unexpected token/.test(e)) {
    return `Le code contient un caractère invalide ou inattendu (souvent un signe parasite, une mauvaise apostrophe, un caractère copié depuis un traitement de texte, ou un bout d'expression mal collé). Le moteur ne peut pas analyser la syntaxe — l'élève aurait dû relire son code caractère par caractère.`;
  }
  if (/unexpected token/.test(e)) {
    return `La syntaxe du code est incorrecte à un endroit précis (parenthèse, accolade ou opérateur mal placé). L'élève a probablement oublié un séparateur ou mal appairé des symboles.`;
  }
  if (/unexpected end of input|end of script/.test(e)) {
    return `Le code est incomplet : il manque une accolade fermante, une parenthèse ou un point-virgule à la fin. L'élève a interrompu son code trop tôt.`;
  }
  if (/is not a function/.test(e)) {
    const m = (errors || '').match(/([A-Za-z_$][\w$.]*)\s+is not a function/i);
    const sym = m ? m[1] : 'une expression';
    return `L'élève a essayé d'appeler ${sym} comme une fonction, mais ce n'en est pas une. Soit la valeur n'existe pas, soit c'est un nombre/une chaîne/undefined.`;
  }
  if (/cannot read propert(?:y|ies) of (?:undefined|null)/.test(e)) {
    return `L'élève a essayé de lire une propriété sur une valeur undefined ou null. Il n'a pas protégé son accès et a oublié de vérifier que l'objet existait avant d'accéder à un de ses champs.`;
  }
  if (/maximum call stack|rangeerror/.test(e)) {
    return `Récursion infinie détectée : la fonction s'appelle elle-même sans condition d'arrêt. Le moteur a saturé la pile d'exécution.`;
  }
  if (/timeout|temps d'exécution dépassé/.test(e)) {
    return `L'algorithme n'est pas assez efficace ou boucle indéfiniment — il a dépassé le temps d'exécution autorisé. L'élève aurait dû optimiser sa solution.`;
  }
  if (/assertion échouée|assertion echouee/.test(e)) {
    return `Le code s'exécute mais ne produit pas le résultat attendu par le test. La logique de l'élève est incorrecte, même si la syntaxe est valide.`;
  }
  return `L'élève n'a pas réussi à produire un code correct pour ${taskId}. Erreur technique du moteur : ${(errors || 'inconnue').substring(0, 200)}. Une analyse plus poussée du code aurait été nécessaire pour identifier précisément la cause.`;
}

function getClassName(profileArg, tierNum) {
  const fullName = (CLASSE_NAMES[profileArg] && CLASSE_NAMES[profileArg][tierNum]) || `Classe-${tierNum}`;
  const firstDash = fullName.indexOf('-');
  const secondDash = firstDash !== -1 ? fullName.indexOf('-', firstDash + 1) : -1;
  return secondDash !== -1 ? fullName.substring(secondDash + 1) : fullName;
}

function printScorecard(scorecard, ecoleLabel, isFinal, globalLifeScore) {
  const subtitle = isFinal ? 'FINAL' : 'EN COURS';
  console.log('');
  console.log(`  \x1b[1;36m━━━ TABLEAU DES SCORES — ${ecoleLabel} (${subtitle}) ━━━\x1b[0m`);
  console.log(`  \x1b[90m${'Classe'.padEnd(18)}${'Points'.padStart(12)}${'Pct'.padStart(7)}  Note   Statut\x1b[0m`);
  console.log(`  \x1b[90m${'─'.repeat(58)}\x1b[0m`);

  let totalScore = 0;
  let totalMax = 0;
  let totalBonus = 0;

  for (const entry of scorecard) {
    totalScore += entry.score;
    totalMax += entry.max;
    totalBonus += entry.optionalBonus || 0;
    const pct = entry.max > 0 ? Math.round((entry.score / entry.max) * 100) : 0;
    const gradeInfo = letterGrade(pct);
    const optTag = entry.mandatory ? '' : ' (opt.)';
    const statusIcon = entry.passed ? '\x1b[32m✔ Validé\x1b[0m' : '\x1b[31m✘ Échec\x1b[0m';
    const annTag = (entry.annotations && entry.annotations.length > 0) ? ` \x1b[33m[${entry.annotations.join(', ')}]\x1b[0m` : '';
    const bonusTag = (entry.optionalBonus > 0) ? ` \x1b[35m[+${entry.optionalBonus} bonus]\x1b[0m` : '';
    const pointsStr = `${entry.score}/${entry.max}`;
    console.log(
      `  ${entry.className.padEnd(18)}${pointsStr.padStart(12)}${(pct + '%').padStart(7)}  ` +
      `${gradeInfo.color}${gradeInfo.grade}\x1b[0m      ${statusIcon}${optTag}${annTag}${bonusTag}`
    );
  }

  if (scorecard.length > 0) {
    const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    const totalGrade = letterGrade(totalPct);
    console.log(`  \x1b[90m${'─'.repeat(58)}\x1b[0m`);
    const bonusLine = totalBonus > 0 ? ` \x1b[35m(+${totalBonus} bonus opt.)\x1b[0m` : '';
    console.log(
      `  \x1b[1m${'TOTAL ÉCOLE'.padEnd(18)}${`${totalScore}/${totalMax}`.padStart(12)}${(totalPct + '%').padStart(7)}  ` +
      `${totalGrade.color}${totalGrade.grade}\x1b[0m\x1b[1m  (Santé: ${globalLifeScore} PV)${bonusLine}\x1b[0m`
    );
  }
  console.log('');
}

function buildScorecardReport(scorecard, ecoleLabel, globalLifeScore) {
  let report = `\n---\n\n## Tableau Récapitulatif — ${ecoleLabel}\n\n`;
  report += `| Classe | Points | Pct | Note | Statut | Obligatoire | Annotations |\n`;
  report += `|---|---|---|---|---|---|---|\n`;

  let totalScore = 0;
  let totalMax = 0;
  let totalBonus = 0;

  for (const entry of scorecard) {
    totalScore += entry.score;
    totalMax += entry.max;
    totalBonus += entry.optionalBonus || 0;
    const pct = entry.max > 0 ? Math.round((entry.score / entry.max) * 100) : 0;
    const gradeInfo = letterGrade(pct);
    const status = entry.passed ? '✔ Validé' : '✘ Échec';
    const mandatory = entry.mandatory ? 'Oui' : 'Optionnel';
    let ann = (entry.annotations && entry.annotations.length > 0) ? entry.annotations.join(', ') : '—';
    if (entry.optionalBonus > 0) ann += ` (+${entry.optionalBonus} bonus opt.)`;
    report += `| ${entry.className} | ${entry.score}/${entry.max} | ${pct}% | ${gradeInfo.grade} | ${status} | ${mandatory} | ${ann} |\n`;
  }

  if (scorecard.length > 0) {
    const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    const totalGrade = letterGrade(totalPct);
    report += `| **TOTAL ÉCOLE** | **${totalScore}/${totalMax}** | **${totalPct}%** | **${totalGrade.grade}** | | | |\n`;
    report += `\n> **Santé Globale finale :** ${globalLifeScore} PV\n`;
    if (totalBonus > 0) report += `> **Bonus optionnel :** +${totalBonus} points (au-delà du quota)\n`;
  }

  report += `\n---\n`;
  return report;
}

async function askYesNo(question, defaultNo = true) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.warn(`Session non-interactive: rattrapage ignoré.`);
    return false;
  }

  const suffix = defaultNo ? '[o/N]' : '[O/n]';

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${suffix} `, answer => {
      rl.close();
      const value = (answer || '').trim().toLowerCase();
      if (!value) {
        resolve(!defaultNo);
        return;
      }
      resolve(['o', 'oui', 'y', 'yes'].includes(value));
    });
  });
}

// Demande une saisie texte libre à l'utilisateur (non-TTY → retourne '').
async function askFreeText(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return '';
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, answer => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

// --- Explication d'échec exigée par le professeur ---
// Après un échec définitif sur un exercice, le professeur (le runner) interroge le
// modèle une dernière fois pour exiger qu'il EXPLIQUE la cause de son échec. On
// lui fournit l'erreur technique renvoyée par le sandbox VM (ex: "élèves is not
// defined", "Invalid or unexpected token") et le code qu'il a produit, puis on lui
// demande une analyse pédagogique de la cause racine.
//
// Objectif : éviter à l'utilisateur les erreurs brutes et cryptiques du moteur JS
// (qui font croire à un bug du benchmark). Le modèle doit justifier pourquoi il
// n'y arrive pas — ce n'est PAS négociable, une erreur brute sans explication est
// interdite dans le CLI. L'explication est affichée à l'utilisateur et enregistrée
// dans le rapport.
//
// Retourne une chaîne explicative (français) ou null si l'appel a échoué.
async function askModelForFailureExplanation({ queryFn, providerConfig, contextLimitTokens, tierNum, isMandatory, task, errors, studentCode }) {
  if (!queryFn) return null;

  const codePreview = (studentCode || '').trim().substring(0, 1200);
  const explanationPrompt =
    `CONTEXTE : Vous étiez en train de résoudre l'exercice ${task.id} (${task.label}) ` +
    `en classe de Tier ${tierNum}. Vous avez échoué définitivement après plusieurs tentatives.\n\n` +
    `Le professeur a corrigé votre copie et le moteur d'évaluation a renvoyé l'erreur technique suivante :\n` +
    `"${(errors || 'erreur inconnue').substring(0, 400)}"\n\n` +
    `Voici le code que vous aviez proposé :\n` +
    "```javascript\n" + codePreview + "\n```\n\n" +
    `INSTRUCTION : En tant qu'élève, vous devez EXPLIQUER précisément POURQUOI vous n'avez ` +
    `pas réussi à résoudre cet exercice. Analysez l'erreur technique ci-dessus et votre code, ` +
    `puis expliquez la cause racine en 2 à 4 phrases claires, en français. Ne vous contentez ` +
    `PAS de recopier l'erreur brute : décrivez ce qui ne va pas dans votre code (variable non ` +
    `définie, syntaxe invalide, parenthèse manquante, mauvaise approche algorithmique, etc.) ` +
    `et ce qu'il aurait fallu faire. Une réponse vide ou une simple répétition de l'erreur ` +
    `technique n'est PAS acceptable.\n` +
    `Répondez UNIQUEMENT par votre explication, sans balise de code.`;

  const explainSpinner = new Spinner(`Tier ${tierNum} — Professeur : demande d'explication pour l'échec ${task.id}...`);
  explainSpinner.start();
  try {
    const response = await queryFn(
      explanationPrompt,
      'EASY',
      tierNum,
      isMandatory,
      explainSpinner,
      { contextLimitTokens, providerConfig }
    );
    explainSpinner.stop(`Tier ${tierNum} — Explication reçue`);
    const content = (response && response.content || '').trim();
    if (!content) return null;
    // Nettoyage : retire d'éventuels blocs de code pour ne garder que l'explication textuelle.
    return content.replace(/```[\s\S]*?```/g, '').trim();
  } catch (e) {
    explainSpinner.fail(`Tier ${tierNum} — Explication impossible (erreur API)`);
    logger.warn(`Explication d'échec impossible pour ${task.id} : ${e.message}`);
    return null;
  }
}

async function runTierAttempt({ tierNum, tierData, isMandatory, profileArg, contextLimitTokens, attemptNumber, queryFn, providerConfig, gameState, selfProfile, teacherConfig }) {
  const attemptTag = attemptNumber > 1 ? ` (RATTRAPAGE ${attemptNumber - 1}/${MAX_RATTRAPAGE_ATTEMPTS})` : '';

  console.log(`\x1b[33m━━ TIER ${tierNum} : ${tierData.title}${attemptTag} ━━\x1b[0m`);
  console.log(`  Statut : ${isMandatory ? `\x1b[32mOBLIGATOIRE [profil ${profileArg}]\x1b[0m` : `\x1b[36mOPTIONNEL pour ${profileArg} (BYPASS autorisé)\x1b[0m`}`);

  let tierScore = 0;
  let attemptsLeft = 12;
  let availableTasks = JSON.parse(JSON.stringify(tierData.tasks));
  
  // Attribution complètement aléatoire des points (entre 30 et 60) pour chaque exercice
  availableTasks.forEach(t => {
    t.points = Math.floor(Math.random() * 31) + 30; // Random entre 30 et 60
  });

  // --- Filtrage amont par auto-profilage ---
  // Les tâches trop difficiles selon le profil auto-déclaré sont marquées "Bypassée"
  // et retirées de availableTasks. Elles ne sont pas envoyées au modèle et ne comptent
  // ni au numérateur ni au dénominateur du seuil de validation.
  let bypassedTasks = [];
  let filterDecisions = [];
  if (selfProfile && selfProfiling.enabled && !selfProfiling.bypassFilter) {
    const filtered = filterTasksByProfile(availableTasks, selfProfile, selfProfiling.minLevelToTest, selfProfiling.bypassFilter);
    availableTasks = filtered.kept;
    bypassedTasks = filtered.bypassed;
    filterDecisions = filtered.decisions;
    if (bypassedTasks.length > 0) {
      console.log(`  \x1b[36mAuto-profilage : ${bypassedTasks.length} tâche(s) bypassée(s) selon le profil déclaré (niveau < ${selfProfiling.minLevelToTest}).\x1b[0m`);
    }
  }

  let evalResultsMap = {};
  const taskRetryMap = {};
  const taskNetPoints = {};
  const taskHelpUsed = {};
  const taskHelpOffered = {};
  const taskLastError = {};
  let taskFailureExplanations = {};   // taskId -> explication pédagogique de l'échec définitif
  let taskTeacherCorrections = {};   // taskId -> correction du professeur IA (OpenRouter)
  let optionalBonusTotal = 0;
  let responseModelName = null;
  let rawResponseAll = '';
  
  // The total possible points based on randomized values
  const totalPossiblePoints = availableTasks.reduce((sum, t) => sum + t.points, 0);
  
  // 70% of total possible points to pass the tier
  const validationThreshold = Math.floor(totalPossiblePoints * 0.7);

  while(attemptsLeft > 0 && availableTasks.length > 0) {
    // --- Proposition d'aide du professeur (exercices en rattrapage avec indice) ---
    const retryTasksNeedingHelp = availableTasks.filter(t =>
      (taskRetryMap[t.id] || 0) >= 1 && !taskHelpOffered[t.id]
    );
    for (const rtask of retryTasksNeedingHelp) {
      taskHelpOffered[rtask.id] = true;
      const generatedHint = rtask.hint || `Erreur précédente : ${taskLastError[rtask.id] || 'inconnue'}. Vérifiez la syntaxe, les noms de variables et le nom exact de la fonction demandée.`;
      const helpPrompt = `CONTEXTE : L'exercice ${rtask.id} (${rtask.label}) a échoué lors de votre première tentative.\n` +
        `En tant que professeur, je vous propose un indice pour vous aider à le résoudre.\n` +
        `Voulez-vous recevoir cet indice ? Répondez UNIQUEMENT par "AIDE_OUI" ou "AIDE_NON".`;
      const helpSpinner = new Spinner(`Tier ${tierNum} — Professeur : proposition d'aide pour ${rtask.id}...`);
      helpSpinner.start();
      try {
        const helpResponse = await queryFn(
          helpPrompt, tierData.difficulty, tierNum, isMandatory, helpSpinner,
          { contextLimitTokens, providerConfig }
        );
        helpSpinner.stop(`Tier ${tierNum} — Réponse du modèle reçue`);
        const helpContent = (helpResponse && helpResponse.content) || '';
        const wantsHelp = /AIDE_OUI/i.test(helpContent) ||
          (!/AIDE_NON/i.test(helpContent) && /\b(?:oui|yes)\b/i.test(helpContent));
        if (wantsHelp) {
          taskHelpUsed[rtask.id] = true;
          rtask._providedHint = generatedHint;
          console.log(`  \x1b[36m👨‍🏫 Professeur : Le modèle accepte l'aide pour l'exercice ${rtask.id}. Un indice sera fourni.\x1b[0m`);
        } else {
          console.log(`  \x1b[90m👨‍🏫 Professeur : Le modèle décline l'aide pour l'exercice ${rtask.id}.\x1b[0m`);
        }
      } catch (helpErr) {
        helpSpinner.fail(`Tier ${tierNum} — Erreur lors de la proposition d'aide`);
        console.log(`  \x1b[90m👨‍🏫 Professeur : Impossible de contacter le modèle. Rattrapage sans indice.\x1b[0m`);
      }
    }

    const spinner = new Spinner(`Tier ${tierNum} — Essais restants: ${attemptsLeft} | Score Tier: ${tierScore}/${totalPossiblePoints} | Santé: ${gameState.globalLifeScore}`);
    spinner.start();

    // Génération du Prompt Stratégique (Section 4)
    // Prompt cohérent : on demande au modèle de renvoyer ses solutions sous forme
    // de Markdown structuré, sans consigne contradictoire.
    let dynamicPrompt = `CONTEXTE D'EVALUATION : Vous êtes dans l'école ${PROFILES[profileArg]?.ecole || profileArg}, classe de Tier ${tierNum} (${tierData.title}).\n\n`;
    dynamicPrompt += `EXERCICES À RÉSOUDRE (Score Tier: ${tierScore}, Santé Globale: ${gameState.globalLifeScore}):\n`;
    for (let t of availableTasks) {
      dynamicPrompt += `- ID: ${t.id} | Desc: ${t.label} | Valeur: ${t.points} points\n`;
    }
    dynamicPrompt += `\nINSTRUCTIONS : Résolvez les exercices listés ci-dessus. Pour chaque exercice, écrivez la fonction JavaScript demandée.\n`;
    dynamicPrompt += `FORMAT DE RÉPONSE — LIBRE : Vous pouvez répondre dans le format que vous préférez, tant que le code JavaScript de chaque exercice est clairement identifiable et associé à son ID. Formats acceptés :\n`;
    dynamicPrompt += `  • Markdown : un titre avec l'ID de l'exercice (ex: "### ${availableTasks[0]?.id || 'tache_0a'}") suivi d'un bloc \`\`\`javascript ... \`\`\`.\n`;
    dynamicPrompt += `  • JSON : un objet { "<id>": "<code>" } (le code peut être une chaîne, ou un objet { "code": "..." }).\n`;
    dynamicPrompt += `  • Code pur : un bloc \`\`\`javascript ... \`\`\` par exercice, précédé d'une ligne mentionnant l'ID.\n`;
    dynamicPrompt += `Exemple Markdown attendu :\n### ${availableTasks[0]?.id || 'tache_0a'}\n\`\`\`javascript\nfunction solution() { return true; }\n\`\`\`\n`;
    dynamicPrompt += `Vous pouvez résoudre un ou plusieurs exercices en une seule réponse.\n`;
    dynamicPrompt += `IMPORTANT : Vous devez écrire le code COMPLET et EXÉCUTABLE de chaque fonction (avec son corps complet entre accolades et l'instruction de retour). Ne renvoyez PAS uniquement la signature de la fonction ou des placeholders comme "...".\n`;
    dynamicPrompt += `Rappel des règles de l'exercice : ` + tierData.prompt;

    // Instructions spécifiques au rattrapage (exercices en seconde tentative)
    const retryTaskIds = availableTasks.filter(t => (taskRetryMap[t.id] || 0) >= 1).map(t => t.id);
    if (retryTaskIds.length > 0) {
      dynamicPrompt += `\n\n⚠️ RATTRAPAGE : Les exercices suivants n'ont pas été résolus lors de la première tentative : ${retryTaskIds.join(', ')}.\n`;
      dynamicPrompt += `Ceci est votre DERNIÈRE chance pour ces exercices. Si vous ne parvenez toujours pas à résoudre un exercice, expliquez brièvement pourquoi dans votre réponse.\n`;
      for (const tid of retryTaskIds) {
        const rtask = availableTasks.find(t => t.id === tid);
        if (rtask && taskHelpUsed[tid] && rtask._providedHint) {
          dynamicPrompt += `\n📌 Indice du professeur pour ${tid} : ${rtask._providedHint}\n`;
        }
      }
    }

    try {
      const startTime = performance.now();
      const responseData = await queryFn(
        dynamicPrompt,
        tierData.difficulty,
        tierNum,
        isMandatory,
        spinner,
        { contextLimitTokens, providerConfig }
      );
      const endTime = performance.now();
      const inferenceTimeMs = Math.round(endTime - startTime);

      if (!responseData) {
        spinner.fail(`Tier ${tierNum} ignoré (optionnel ou erreur API)`);
        break; // API err
      }
      
      spinner.stop(`Tier ${tierNum} — Réponse reçue en ${inferenceTimeMs}ms`);
      const rawResponse = responseData.content;
      rawResponseAll += '\n\n---\n' + rawResponse;
      if (!responseModelName) responseModelName = responseData.modelName;

      // Extraction de la sélection (optionnelle — les modèles capables peuvent
      // utiliser SELECTION; les petits modèles renvoient directement le JSON).
      let selectedId = null;
      const stopMatch = rawResponse.match(/SELECTION\s*:\s*STOP/i);
      if (stopMatch || rawResponse.trim().endsWith("STOP")) {
         console.log(`  \x1b[36mLe modèle a décidé d'arrêter la session de test pour ce tier.\x1b[0m`);
         break;
      }

      const selMatch = rawResponse.match(/SELECTION\s*:\s*([a-zA-Z0-9_.-]+)/i);
      if (selMatch) {
         selectedId = selMatch[1];
      }

      // Construction du lot d'exercices à évaluer pour cette tentative.
      const evalBatch = []; // { task, studentCode, index }

      if (selectedId) {
         const taskIndex = availableTasks.findIndex(t => t.id === selectedId);
         if (taskIndex === -1) {
            console.log(`  \x1b[33m[WARN]\x1b[0m L'exercice sélectionné est invalide ou déjà accompli: ${selectedId}. Essai perdu.`);
            attemptsLeft--;
            continue;
         }
         const task = availableTasks[taskIndex];
         const studentCode = extractStudentCode(rawResponse, task.id);
         evalBatch.push({ task, studentCode, index: taskIndex });
      } else {
         // Mode "lot" : on parse le JSON global et on évalue tous les exercices
         // présents dans la réponse. Cela permet aux modèles qui renvoient
         // toutes les solutions d'un coup (format attendu par les tiers) d'être
         // correctement évalués.
         let parsed = null;
         try { parsed = JSON.parse(extractJSON(rawResponse)); } catch (e) { }
         if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (let i = 0; i < availableTasks.length; i++) {
               const t = availableTasks[i];
               if (Object.prototype.hasOwnProperty.call(parsed, t.id)) {
                  let code = parsed[t.id];
                  if (code && typeof code === 'object') {
                     code = code.code || code.solution || code.fonction;
                  }
                  if (typeof code === 'string' && code.trim()) {
                     evalBatch.push({ task: t, studentCode: code, index: i });
                  }
               }
            }
         }
         // Repli : si le JSON global n'a rien donné, on tente l'extraction
         // au coup par coup (clé JSON, bloc de code, texte présent).
         if (evalBatch.length === 0) {
            for (let i = 0; i < availableTasks.length; i++) {
               const t = availableTasks[i];
               const code = extractStudentCode(rawResponse, t.id);
               if (code && !code.trim().startsWith('{') && code !== rawResponse) {
                  evalBatch.push({ task: t, studentCode: code, index: i });
               }
            }
         }
      }

      if (evalBatch.length === 0) {
         console.log(`  \x1b[33m[WARN]\x1b[0m Aucune réponse exploitable trouvée dans la réponse du modèle. Essai perdu.`);
         console.log(`  \x1b[90m(Réponse: ${rawResponse.substring(0, 80).replace(/\n/g, ' ')}...)\x1b[0m`);
         
         const penalty = 35; // Pénalité pour réponse vide ou non pertinente
         tierScore -= penalty;
         gameState.globalLifeScore -= penalty;
         console.log(`  \x1b[31m✘ Pénalité pour réponse non exploitable : -${penalty} Points (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);

         if (gameState.globalLifeScore <= -100) break; // Sortie immédiate si le score est trop bas

         attemptsLeft--;
         continue;
      }

      const passedInBatch = [];
      const permanentlyFailedIds = [];

      for (const item of evalBatch) {
          const { task, studentCode, index } = item;
          console.log(`  \x1b[36m▶ Évaluation de l'exercice : ${task.id} - ${task.label}\x1b[0m`);
          await sleep(40);

          const taskResults = await evaluateTask(task, studentCode || '');
          const taskPassed = taskResults.every(r => r.passed);
          const errors = taskResults.filter(r => !r.passed).map(r => r.error).join('; ');
          const pts = task.points || 8;

          if (taskPassed) {
             tierScore += pts;
             gameState.globalLifeScore += pts;
             taskNetPoints[task.id] = (taskNetPoints[task.id] || 0) + pts;
             let _bonusTag = '';
             if (!isMandatory) {
               const bonus = Math.round(pts * OPTIONAL_BONUS_PCT);
               gameState.globalLifeScore += bonus;
               optionalBonusTotal += bonus;
               _bonusTag = ` (+${bonus} bonus opt.)`;
             }
             console.log(`  \x1b[32m✔ Succès ! +${pts}${_bonusTag} Points (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);

             // Verbosité logic
             if (studentCode && studentCode.length > 0 && rawResponse.length > studentCode.length * 4) {
                 console.log(`  \x1b[33m⚠️ Surconsommation de tokens : Le modèle a produit une réponse ${Math.round(rawResponse.length/studentCode.length)}x plus longue que la solution attendue (gaspillage de tokens) - Non pénalisé\x1b[0m`);
             }
             passedInBatch.push(task.id);
          } else {
             taskRetryMap[task.id] = (taskRetryMap[task.id] || 0) + 1;
             const retryCount = taskRetryMap[task.id];
             taskLastError[task.id] = errors;

              if (retryCount > MAX_TASK_RETRIES) {
                 // Échec définitif après réessai — le modèle abandonne
                 console.log(`  \x1b[31m✘ Échec définitif sur l'exercice ${task.id} après ${retryCount} tentatives !\x1b[0m`);
                 console.log(`    \x1b[90mErreur technique brute du moteur : ${errors.substring(0, 120)}\x1b[0m`);
                 console.log(`  \x1b[33m🏳️ L'élève déclare avoir terminé : impossible de résoudre l'exercice ${task.id}.\x1b[0m`);

                 // --- Le professeur exige une explication pédagogique de l'échec ---
                 // Interdit : afficher une erreur brute sans explication (l'utilisateur
                 // croirait que le benchmark a planté). Le modèle doit justifier lui-même
                 // pourquoi il n'y arrive pas. Le professeur relaie l'erreur technique au
                 // modèle et exige une analyse de la cause racine.
                 console.log(`  \x1b[36m👨‍🏫 Professeur : le modèle doit expliquer la cause de son échec sur ${task.id}.\x1b[0m`);
                 let failureExplanation = null;
                 try {
                   failureExplanation = await askModelForFailureExplanation({
                     queryFn, providerConfig, contextLimitTokens,
                     tierNum, isMandatory, task,
                     errors, studentCode
                   });
                 } catch (e) {
                   logger.warn(`Explication d'échec échouée pour ${task.id} : ${e.message}`);
                 }

                  if (failureExplanation && failureExplanation.length > 0) {
                    console.log(`  \x1b[36m💬 Explication de l'élève pour ${task.id} :\x1b[0m`);
                    // Découpe l'explication en lignes pour un rendu CLI propre.
                    const explainLines = failureExplanation.split(/\r?\n/).filter(l => l.trim()).slice(0, 6);
                    for (const line of explainLines) {
                      console.log(`    \x1b[90m${line.substring(0, 140)}\x1b[0m`);
                    }
                  } else {
                    // Repli : si le modèle n'a pas pu répondre, le professeur fournit
                    // lui-même une explication de l'erreur technique pour l'utilisateur.
                    const profExplanation = explainTechnicalError(errors, task);
                    console.log(`  \x1b[33m👨‍🏫 Professeur (explication à la place de l'élève) :\x1b[0m`);
                    console.log(`    \x1b[90m${profExplanation}\x1b[0m`);
                    failureExplanation = profExplanation;
                  }

                  // --- Le professeur IA corrige l'analyse de l'élève ---
                  // Modèle cloud indépendant (OpenRouter gratuit par défaut) qui relit
                  // l'auto-analyse de l'élève, dit si elle est juste/fausse, et DÉMONTRE la
                  // vraie cause racine. Évite qu'un modèle faible se valide lui-même.
                  let teacherCorrection = null;
                  if (teacherConfig && teacherConfig.enabled) {
                    console.log(`  \x1b[35m👨‍🏫 Professeur IA : relecture critique de l'analyse de l'élève pour ${task.id}...\x1b[0m`);
                    try {
                      teacherCorrection = await askTeacherToCorrectStudentAnalysis({
                        teacherConfig,
                        task, errors, studentCode,
                        studentAnalysis: failureExplanation,
                        tierNum
                      });
                    } catch (e) {
                      logger.warn(`Teacher: exception pour ${task.id} : ${e.message}`);
                    }
                    if (teacherCorrection && teacherCorrection.length > 0) {
                      console.log(`  \x1b[35m🎓 Correction du professeur pour ${task.id} :\x1b[0m`);
                      const teachLines = teacherCorrection.split(/\r?\n/).filter(l => l.trim()).slice(0, 8);
                      for (const line of teachLines) {
                        console.log(`    \x1b[90m${line.substring(0, 140)}\x1b[0m`);
                      }
                    } else {
                      console.log(`  \x1b[33m👨‍🏫 Professeur IA : indisponible (repli sur l'auto-analyse de l'élève).\x1b[0m`);
                      logger.info(`Teacher: aucun retour pour ${task.id} — repli sur auto-analyse.`);
                    }
                  }

                  // Le professeur (utilisateur) décide si la pénalité est comptabilisée
                  const countPoints = await askYesNo(`  Comptabiliser la pénalité de -${pts} points pour l'exercice ${task.id} ?`, true);
                  if (!countPoints) {
                     tierScore += pts;
                     gameState.globalLifeScore += pts;
                     taskNetPoints[task.id] = (taskNetPoints[task.id] || 0) + pts;
                     console.log(`  \x1b[32m✅ Pénalité annulée pour ${task.id} (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);
                  } else {
                     console.log(`  \x1b[31m✘ Pénalité maintenue : -${pts} Points (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);
                  }
                  permanentlyFailedIds.push(task.id);

                  // Mémorise l'explication (élève) ET la correction (professeur) pour le rapport
                  if (!taskFailureExplanations) taskFailureExplanations = {};
                  taskFailureExplanations[task.id] = failureExplanation || '';
                  if (teacherCorrection && teacherCorrection.length > 0) {
                    if (!taskTeacherCorrections) taskTeacherCorrections = {};
                    taskTeacherCorrections[task.id] = teacherCorrection;
                  }
              } else {
                // Premier échec — pénalité appliquée, une nouvelle tentative sera proposée
                tierScore -= pts;
                gameState.globalLifeScore -= pts;
                taskNetPoints[task.id] = (taskNetPoints[task.id] || 0) - pts;
                console.log(`  \x1b[31m✘ Échec sur l'exercice ${task.id} ! Pénalité : -${pts} Points (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);
                console.log(`    \x1b[90mRaison: ${errors.substring(0, 80)}\x1b[0m`);
                console.log(`  \x1b[33m⚡ Une nouvelle tentative sera proposée pour l'exercice ${task.id} (${MAX_TASK_RETRIES} réessai restant).\x1b[0m`);
             }
          }

          evalResultsMap[task.id] = {
            id: task.id,
            label: task.label,
            code: studentCode,
            evaluations: taskResults,
            points: taskNetPoints[task.id] || 0,
            maxPoints: task.points || 8,
            taskType: task.label ? task.label.split(':')[0].trim() : 'Exercice',
            helpUsed: Boolean(taskHelpUsed[task.id]),
            retried: (taskRetryMap[task.id] || 0) >= 1,
            status: taskPassed ? 'success' : 'failed',
            failureExplanation: taskFailureExplanations[task.id] || null,
            teacherCorrection: taskTeacherCorrections[task.id] || null
          };
       }

       // Retire les exercices réussis de la liste restante.
       for (const id of passedInBatch) {
          const idx = availableTasks.findIndex(t => t.id === id);
          if (idx !== -1) availableTasks.splice(idx, 1);
       }
       // Retire les exercices définitivement échoués (après réessai).
       for (const id of permanentlyFailedIds) {
          const idx = availableTasks.findIndex(t => t.id === id);
          if (idx !== -1) availableTasks.splice(idx, 1);
       }
      attemptsLeft--;
      
      if (gameState.globalLifeScore <= -100) {
         break; // Élimination du modèle
      }
      
    } catch(e) {
      spinner.fail(`Tier ${tierNum} — Erreur inattendue`);
      console.error(`  \x1b[31m[ERREUR]\x1b[0m ${e.message}`);
      break;
    }
  }
  
  // --- Enregistrement des tâches bypassées par auto-profilage ---
  // Elles portent le status 'bypassed' (exclues du calcul de calibration P).
  for (const task of bypassedTasks) {
    evalResultsMap[task.id] = {
      id: task.id,
      label: task.label,
      code: null,
      evaluations: [],
      points: 0,
      maxPoints: task.points || 8,
      taskType: task.label ? task.label.split(':')[0].trim() : 'Exercice',
      helpUsed: false,
      retried: false,
      status: 'bypassed'
    };
  }

  // Validation of the Tier
  const tierPassed = tierScore >= validationThreshold;
  const tierPassedCount = tierScore; // Using points as passed count logic for broader system compatibility
  const tierTotalCount = totalPossiblePoints;
  const tierPct = totalPossiblePoints > 0 ? Math.round((tierScore / totalPossiblePoints) * 100) : 0;

  // Gamification Niveau 2 : Recompense de Tier
  if (gameState.globalLifeScore <= -100) {
    console.log(`\n  \x1b[41m\x1b[37m ✘ ÉLIMINATION : Santé critique atteinte (${gameState.globalLifeScore}) \x1b[0m`);
    console.log(`  \x1b[31mLe modèle est définitivement exclu du test (trop d'échecs/erreurs).\x1b[0m`);
  } else if (tierPassed) {
    console.log(`\n  \x1b[42m\x1b[30m ✔ TIER ${tierNum} RÉUSSI : ${tierScore}/${totalPossiblePoints} Points — Classe Validée avec Mention ! \x1b[0m`);
  } else {
    console.log(`\n  \x1b[41m\x1b[37m ✘ TIER ${tierNum} ÉCHEC : ${tierScore}/${totalPossiblePoints} Points (Seuil requis: ${validationThreshold}) \x1b[0m`);
    // Simulating the exact fatal error reported in user issue if mandatory
    if (isMandatory) {
      console.log(`\n  \x1b[31mERREUR FATALE : TEST ECHOUE - Score Tier : ${tierScore}\x1b[0m`);
      console.log(`  \x1b[31mNon-validation ! Niveau non atteint de validation pour le tier ${tierNum} : Echec.\x1b[0m`);
    } else {
      console.log(`  \x1b[36mℹ Tier optionnel pour le profil ${profileArg} — non pénalisé dans le score obligatoire.\x1b[0m`);
    }
  }

  // --- Message de fin + récapitulatif des points par exercice ---
  // Le modèle annonce qu'il a terminé, puis on affiche le détail des points
  // obtenus pour chaque exercice (ce qui s'affichait dans l'invite de commande).
  console.log(`\n  \x1b[1;36m━━━ J'ai fini mes exercices, veuillez consulter mes points ━━━\x1b[0m\n`);
  const evalResultsForDisplay = Object.values(evalResultsMap);
  console.log(`  \x1b[90m${'Exercice'.padEnd(22)}${'Type'.padEnd(14)}${'Points'.padStart(12)}${'Max'.padStart(8)}  Statut\x1b[0m`);
  console.log(`  \x1b[90m${'─'.repeat(70)}\x1b[0m`);
  for (const r of evalResultsForDisplay) {
    const statusLabel = r.status === 'success' ? '\x1b[32m✔ Validé\x1b[0m'
      : r.status === 'bypassed' ? '\x1b[90m⊘ Bypassé\x1b[0m'
      : '\x1b[31m✘ Échec\x1b[0m';
    const idStr = (r.id || '').padEnd(22);
    const typeStr = (r.taskType || '—').padEnd(14);
    const ptsStr = String(r.points || 0).padStart(12);
    const maxStr = ('/' + (r.maxPoints || 0)).padStart(8);
    console.log(`  ${idStr}${typeStr}${ptsStr}${maxStr}  ${statusLabel}`);
  }
  console.log(`  \x1b[90m${'─'.repeat(70)}\x1b[0m`);
  console.log(`  \x1b[1m${'TOTAL TIER'.padEnd(22)}${''.padEnd(14)}${String(tierScore).padStart(12)}${('/' + totalPossiblePoints).padStart(8)}\x1b[0m\n`);

  const evalResults = Object.values(evalResultsMap);
  const helpUsedCount = Object.values(taskHelpUsed).filter(Boolean).length;
  const retriedCount = Object.values(taskRetryMap).filter(c => c >= 1).length;
  const tierAnnotations = [];
  if (helpUsedCount > 0) tierAnnotations.push(`avec aide (${helpUsedCount})`);
  if (retriedCount > 0) tierAnnotations.push(`avec rattrapage (${retriedCount})`);

  const { report } = buildTierReport(tierData, evalResults, rawResponseAll, { helpUsedCount, retriedCount, tierAnnotations });

  return {
    eliminated: gameState.globalLifeScore <= -100,
    skippedOptional: false,
    report,
    rawResponse: rawResponseAll,
    evalResults,
    allPassed: tierPassed, // boolean
    tierPassedCount: tierScore, // points
    tierTotalCount: totalPossiblePoints, // max points
    tierPct,
    helpUsedCount,
    retriedCount,
    tierAnnotations,
    responseModelName,
    optionalBonus: optionalBonusTotal,
    bypassedCount: bypassedTasks.length,
    filterDecisions,
    failureExplanations: taskFailureExplanations,
    teacherCorrections: taskTeacherCorrections
  };
}

async function main() {
  console.clear();

  console.log('\n\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m');
  console.log('\x1b[36m\u2551         BENCHGO V3 — EXÉCUTION COMPORTEMENTALE           \u2551\x1b[0m');
  console.log('\x1b[36m\u2551   (VM Sandbox + Tests RFC 7946 + Flood Fill + React Sim)  \u2551\x1b[0m');
  console.log('\x1b[36m\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1b[0m\n');

  const cliArgs = parseCliArgs();
  const { tierArg: tierArgRaw, profileArgExplicit, contextLimitTokens: contextLimitFromCli, provider, model: cloudModel, apiKey, endpoint,
           teacherModel, teacherApiKey, teacherEndpoint, teacherDisabled, quantization: cliQuantization } = cliArgs;
  let tierArg = tierArgRaw;

  // --- Questionnaire interactif au démarrage ---
  // Si AUCUN flag significatif n'est passé (--provider, --model), on lance le
  // questionnaire guidé. Sinon on garde le comportement CLI historique. La clé
  // API est stockée en mémoire de session (secrets.js) pour ne pas avoir à la
  // redemander entre deux écoles d'un même run.
  const hasCliProvider = Boolean(provider);
  const hasCliModel = Boolean(cloudModel);
  let resolvedProvider = provider;
  let resolvedCloudModel = cloudModel;
  let resolvedApiKey = apiKey;
  let resolvedEndpoint = endpoint;
  let resolvedProfileArgExplicit = profileArgExplicit;
  let resolvedContextLimit = contextLimitFromCli;
  let resolvedQuantization = cliQuantization || null;
  let teacherConfigResolved;

  if (!hasCliProvider && !hasCliModel && process.stdin.isTTY && process.stdout.isTTY) {
    logger.info('Aucun flag CLI détecté — lancement du questionnaire interactif.');
    const qConfig = await runStartupQuestionnaire(cliArgs);
    resolvedProvider = qConfig.provider;
    resolvedCloudModel = qConfig.model;
    resolvedApiKey = qConfig.apiKey;
    resolvedEndpoint = qConfig.endpoint;
    resolvedProfileArgExplicit = qConfig.profileArg;
    resolvedContextLimit = qConfig.contextLimitTokens;
    if (qConfig.quantization) resolvedQuantization = qConfig.quantization;
    // teacherConfig construit par le questionnaire (clé mémorisée dans secrets.js)
    teacherConfigResolved = qConfig.teacherConfig;
    // Cible (tier) explicite issue du questionnaire. Prioritaire sur la valeur
    // résiduelle de parseCliArgs() pour éviter qu'un argument positionnel
    // parasite (ex: "node runner.js 0") ne restreigne silencieusement le run à
    // une seule classe. En interactif, seul un choix explicite de l'utilisateur
    // restreint la cible ; sinon on reste sur "all".
    if (qConfig.tierArg) tierArg = qConfig.tierArg;
    // Mémorise aussi la clé élève dans secrets pour réutilisation cross-école.
    if (resolvedApiKey) secrets.rememberSecret(resolvedProvider, resolvedApiKey, true);
  } else {
    // --- Mode CLI historique : professeur OpenRouter (Free Router) ---
    const teacherConfig = (() => {
      const base = { ...TEACHER_CONFIG, enabled: false };
      if (teacherDisabled) {
        console.log(`  \x1b[90mProfesseur : auto-analyse classique (--no-teacher).\x1b[0m`);
        return base;
      }

      // Clé fournie en CLI ou en env → mode OpenRouter sans demander.
      const envKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
      if (teacherApiKey || envKey) {
        const resolved = { ...TEACHER_CONFIG, enabled: true };
        if (teacherModel)    resolved.model    = teacherModel;
        if (teacherApiKey)   resolved.apiKey   = teacherApiKey;
        else if (envKey)     resolved.apiKey   = envKey;
        if (teacherEndpoint) resolved.endpoint = teacherEndpoint;
        secrets.rememberSecret('openrouter', resolved.apiKey, true);
        console.log(`  \x1b[35mProfesseur : OpenRouter (Free Router) activé — clé détectée.\x1b[0m`);
        return resolved;
      }

      // Sinon : on demande interactivement à l'utilisateur (saisie masquée).
      console.log(`\n  \x1b[36m━━ PROFESSEUR CORRECTEUR ━━\x1b[0m`);
      console.log(`  \x1b[90mAprès chaque échec définitif, l'élève s'auto-analyse. Un professeur IA indépendant peut relire cette analyse et démontrer la vraie cause racine.\x1b[0m`);
      console.log(`  \x1b[90m(A) Professeur OpenRouter (Free Router, modèles gratuits) — nécessite une clé API (création de compte gratuite sur https://openrouter.ai).\x1b[0m`);
      console.log(`  \x1b[90m(B) Auto-analyse classique (aucun compte requis) — le modèle testé s'analyse lui-même.\x1b[0m`);
      return (async () => {
        const wantsOpenRouter = await askYesNo(`  Utiliser le professeur OpenRouter (Free Router) ?`, true);
        if (!wantsOpenRouter) {
          console.log(`  \x1b[90mProfesseur : auto-analyse classique.\x1b[0m`);
          return base;
        }
        // Saisie masquée + aperçu temporaire (repli sur askFreeText si non-TTY).
        let key = null;
        if (process.stdin.isTTY && process.stdout.isTTY) {
          key = await secrets.askSecret(`  Collez votre clé API OpenRouter (saisie masquée)`, { revealMs: 3000 });
        } else {
          key = await askFreeText(`  Collez votre clé API OpenRouter (sk-or-v1-...) :`);
        }
        if (!key) {
          console.log(`  \x1b[33mAucune clé saisie — repli sur l'auto-analyse classique.\x1b[0m`);
          return base;
        }
        secrets.rememberSecret('openrouter', key);
        console.log(`  \x1b[35mProfesseur : OpenRouter (Free Router) activé — clé mémorisée :\x1b[0m ${secrets.maskedForDisplay(key)}`);
        const resolved = { ...TEACHER_CONFIG, enabled: true, apiKey: key };
        if (teacherModel)    resolved.model    = teacherModel;
        if (teacherEndpoint) resolved.endpoint = teacherEndpoint;
        return resolved;
      })();
    })();
    teacherConfigResolved = (teacherConfig && teacherConfig.then) ? await teacherConfig : teacherConfig;
    if (resolvedApiKey) secrets.rememberSecret(resolvedProvider, resolvedApiKey, true);
  }

  const isCloudMode = Boolean(resolvedProvider);
  const providerConfig = isCloudMode ? { provider: resolvedProvider, model: resolvedCloudModel, apiKey: resolvedApiKey } : null;
  const queryFn = isCloudMode ? queryLLMCloud : queryLLMLocal;
  let profileArg = resolvedProfileArgExplicit || (isCloudMode ? 'FRONTIER' : 'STANDARD');
  const contextLimitTokens = resolvedContextLimit || DEFAULT_CONTEXT_LIMIT_TOKENS;
  let preKnownModelName = isCloudMode ? resolvedCloudModel : null;
  logger.info(`Professeur : ${teacherConfigResolved && teacherConfigResolved.enabled ? `activé (${teacherConfigResolved.provider || 'openrouter'})` : 'désactivé (auto-analyse classique)'}`);

  // Lance l'auto-updater pour ajouter les exercices manquants et les points
  updateTiers();

  logger.info(`Démarrage du benchmark`);
  logger.info(`Cible demandée : ${tierArg.toUpperCase()}`);
  logger.info(`Profil explicite CLI : ${resolvedProfileArgExplicit || 'AUCUN (auto-détection)'}`);
  logger.info(`Budget contexte : ${contextLimitTokens} tokens`);
  logger.info(`Fichier de log : ${logger.getFilePath()}`);

  if (isCloudMode) {
    // Mode cloud : pas d'auto-détection LM Studio, le modèle est fourni explicitement
    if (!resolvedCloudModel) {
      console.error('\x1b[31m[ERREUR]\x1b[0m --provider spécifié sans --model. Ex: --model=gpt-4o');
      process.exit(1);
    }
    logger.info(`Mode cloud : provider=${resolvedProvider}, modèle=${resolvedCloudModel}`);
    console.log(`  Mode              : \x1b[1;35mCLOUD\x1b[0m`);
    console.log(`  Fournisseur       : \x1b[1;35m${resolvedProvider.toUpperCase()}\x1b[0m`);
    console.log(`  Modèle            : \x1b[1;35m${resolvedCloudModel}\x1b[0m`);
    if (resolvedApiKey) {
      // Affichage masqué systématique — plus jamais la clé en clair dans le CLI.
      const source = secrets.isCliProvided(resolvedProvider) ? 'argument CLI' : 'session';
      console.log(`  Clé API           : ${secrets.maskedForDisplay(resolvedApiKey)} \x1b[90m(${source})\x1b[0m`);
    }
    if (resolvedProfileArgExplicit) {
      logger.info(`Profil forcé par l'utilisateur : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}`);
    } else {
      logger.info(`Profil cloud auto : FRONTIER`);
    }
  } else if (!resolvedProfileArgExplicit) {
    logger.info(`Aucun --profile= passé. Tentative de détection automatique via LM Studio...`);
    const detectedModelName = await fetchModelNameFromLMStudio();
    preKnownModelName = detectedModelName;
    if (detectedModelName) {
      const { paramSize, detected } = detectProfileFromModelName(detectedModelName);
      logger.modelDetection(detectedModelName, paramSize ? paramSize + 'B' : null, detected || 'inconnu');
      if (detected) {
        profileArg = detected;
        logger.info(`Profil détecté automatiquement : ${PROFILES[detected].label}`);
        console.log(`  Profil détecté automatiquement : \x1b[1;33m${PROFILES[detected].label}\x1b[0m`);
      } else {
        logger.warn(`Taille du modèle non détectée. Fallback sur STANDARD.`);
        profileArg = 'STANDARD';
      }
    } else {
      logger.warn(`Impossible de joindre /v1/models. Fallback sur STANDARD.`);
      profileArg = 'STANDARD';
    }
    // --- Auto-détection de la quantification (LM Studio /api/v0/models) ---
    // En mode CLI local sans --quantization=, on interroge l'endpoint v0 de LM
    // Studio pour récupérer la quantification du modèle chargé. Elle n'est pas
    // dans le nom du modèle ni dans /v1/models, donc sans ça deux runs du même
    // modèle avec des quantifications différentes seraient indiscernables.
    if (!resolvedQuantization && preKnownModelName) {
      try {
        const meta = await fetchModelMetadataFromLMStudio(preKnownModelName);
        if (meta && meta.quantization) {
          resolvedQuantization = meta.quantization;
          logger.info(`Quantification détectée via /api/v0/models : ${resolvedQuantization}${meta.arch ? ' (arch=' + meta.arch + ')' : ''}`);
          console.log(`  Quantification détectée : \x1b[1;35m${resolvedQuantization}\x1b[0m \x1b[90m(${meta.publisher || '?'} · ${meta.arch || '?'})\x1b[0m`);
        }
      } catch (e) {
        logger.warn(`Quantification non récupérable : ${e.message}`);
      }
    }
  } else {
    logger.info(`Profil forcé par l'utilisateur : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}`);
  }

  if (!PROFILES[profileArg]) {
    logger.warn(`Profil inconnu '${profileArg}', remplacement par STANDARD.`);
    profileArg = 'STANDARD';
  }

  const profile = PROFILES[profileArg];

  // --- Affichage IMMÉDIAT de la configuration globale (priorité absolue) ---
  // Avant toute chose (et surtout avant l'auto-profilage qui peut prendre 10-15s),
  // on affiche à l'utilisateur les infos GLOBALES du run : cible, mode, contexte,
  // quantification. Les infos spécifiques à chaque école (profil, école, tiers)
  // sont affichées par runSchool() au début de chaque école — ainsi un run
  // multi-écoles affiche la bonne école pour chaque phase.
  logger.runConfig({
    'Cible': tierArg,
    'Profil principal': profile.label,
    'Budget contexte': `${contextLimitTokens} tokens`,
    'Quantification': resolvedQuantization || 'inconnue'
  });

  console.log(`  \x1b[1;36m━━━ CONFIGURATION DU RUN ━━━\x1b[0m`);
  console.log(`  \x1b[1;33mCible demandée      :\x1b[0m \x1b[1;33m${tierArg.toUpperCase()}\x1b[0m`);
  console.log(`  \x1b[1;33mMode                :\x1b[0m \x1b[1;33m${isCloudMode ? `CLOUD (${resolvedProvider.toUpperCase()})` : 'LOCAL (LM Studio)'}\x1b[0m`);
  if (isCloudMode && resolvedCloudModel) {
    console.log(`  \x1b[1;33mModèle              :\x1b[0m \x1b[1;33m${resolvedCloudModel}\x1b[0m`);
  }
  console.log(`  \x1b[1;33mContexte max        :\x1b[0m \x1b[1;33m${contextLimitTokens} tokens\x1b[0m`);
  console.log(`  \x1b[1;33mQuantification      :\x1b[0m ${resolvedQuantization ? `\x1b[1;35m${resolvedQuantization}\x1b[0m` : '\x1b[90m— (inconnue)\x1b[0m'}`);
  console.log('');

  // --- Auto-profilage (Self-Profiling) ---
  // Interroge le modèle au démarrage pour qu'il s'auto-évalue sur 4 compétences clés.
  // Le profil obtenu sert ensuite à filtrer les tâches trop difficiles et à calculer
  // l'Indice de Calibration en fin de run. Échec non fatal (graceful degradation).
  //
  // IMPORTANT : on annonce explicitement à l'utilisateur que l'auto-profilage va
  // commencer et peut prendre 10-15s. Sans cela, l'utilisateur croit que le CLI a
  // planté pendant que le modèle réfléchit en silence.
  let selfProfile = null;
  if (selfProfiling.enabled) {
    console.log(`  \x1b[1;35m━━━ AUTO-PROFILAGE DU MODÈLE ━━━\x1b[0m`);
    console.log(`  \x1b[35mLe modèle va s'auto-évaluer sur 4 compétences (niveau 1 à 5).\x1b[0m`);
    console.log(`  \x1b[35mCette étape prend ~10-30s (timeout ${PROFILING_TIMEOUT_MS / 1000}s max) — merci de patienter.\x1b[0m`);
    console.log(`  \x1b[90mCompétences évaluées : JavaScript Bases, Async, Algorithmes avancés, Débogage/Sécurité.\x1b[0m\n`);

    const profileSpinner = new Spinner('Auto-profilage : interview JSON du modèle en cours');
    profileSpinner.start();
    const profileStartTime = Date.now();
    try {
      selfProfile = await runSelfProfiling(queryFn, providerConfig, contextLimitTokens);
    } catch (e) {
      logger.warn(`Auto-profilage échoué : ${e.message}. Continuation sans filtrage.`);
    }
    const profileDurationMs = Date.now() - profileStartTime;
    const profileDurationSec = (profileDurationMs / 1000).toFixed(1);

    if (selfProfile) {
      profileSpinner.stop(`Auto-profilage réussi en ${profileDurationSec}s`);
      const skills = selfProfile.skills || {};
      console.log('');
      console.log(`  \x1b[1;36m━━━ RÉSULTAT DE L'AUTO-PROFILAGE ━━━\x1b[0m`);
      console.log(`  \x1b[36mCompétences déclarées par le modèle :\x1b[0m`);
      let levelSum = 0;
      let levelCount = 0;
      for (const [skill, label] of Object.entries(SKILL_LABELS)) {
        const lvl = skills[skill] ? skills[skill].level : '?';
        if (typeof lvl === 'number') { levelSum += lvl; levelCount++; }
        const bar = typeof lvl === 'number' ? '█'.repeat(lvl) + '░'.repeat(5 - lvl) : '░░░░░';
        const lvlStr = typeof lvl === 'number' ? String(lvl) : '?';
        console.log(`    \x1b[90m${label.padEnd(48)}\x1b[0m \x1b[1;33m[${bar}] ${lvlStr}/5\x1b[0m`);
      }
      if (levelCount > 0) {
        const avg = (levelSum / levelCount).toFixed(2);
        console.log(`    \x1b[90m${'Niveau moyen déclaré'.padEnd(48)}\x1b[0m \x1b[1;33m${avg}/5\x1b[0m`);
      }
      if (selfProfile.justification) {
        console.log(`  \x1b[36mJustification du modèle :\x1b[0m \x1b[90m${selfProfile.justification}\x1b[0m`);
      }
      const bypassedNote = selfProfiling.bypassFilter
        ? `Filtrage DÉSACTIVÉ (bypassFilter=true) — toutes les tâches seront exécutées malgré le profil.`
        : `Les tâches dont la compétence est déclarée < ${selfProfiling.minLevelToTest}/5 seront bypassées.`;
      console.log(`  \x1b[90mFiltrage : ${bypassedNote}\x1b[0m`);
      console.log('');
    } else {
      profileSpinner.stop(`Auto-profilage échoué en ${profileDurationSec}s (fallback : toutes les tâches seront exécutées)`);
      console.log(`  \x1b[90mLe modèle n'a pas pu s'auto-évaluer — continuons sans filtrage ni calibration.\x1b[0m\n`);
    }
  }

  // --- runSchool : exécute UNE école (un profil) de bout en bout.
  // Fonction imbriquée dans main() pour hériter (closure) de toute la config
  // résolue : provider, modèle, clés, queryFn, auto-profilage, professeur,
  // quantification. On passe juste le profil/école à exécuter. Permet d'enchaîner
  // plusieurs écoles (ex: Primaire puis Collège-Lycée) dans le même run, sans
  // re-saisir la configuration ni relancer l'auto-profilage.
  async function runSchool(schoolProfileArg, { isSecondSchool = false } = {}) {
    // Ombre locale : toutes les références `profileArg` dans ce bloc désignent
    // l'école courante, pas l'école principale du run.
    let profileArg = schoolProfileArg;
    const profile = PROFILES[profileArg];
    const ecoleLabel = PROFILES[profileArg]?.ecole || profileArg;

    // Bannière de configuration de l'école. Affichée pour CHAQUE école (1re
    // comprise) : profil, école et tiers de l'école courante. La config globale
    // (mode, contexte, quantification) a déjà été affichée par main() une fois.
    console.log(`  \x1b[1;36m━━━ CONFIGURATION DE L'ÉCOLE ━━━\x1b[0m`);
    console.log(`  \x1b[1;33mÉcole              :\x1b[0m \x1b[1;33m${profile.ecole}\x1b[0m`);
    console.log(`  \x1b[1;33mProfil             :\x1b[0m \x1b[1;33m${profile.label}\x1b[0m`);
    console.log(`  \x1b[1;33mTiers obligatoires  :\x1b[0m \x1b[1;33m${profile.mandatory.join(', ')}\x1b[0m`);
    if (profile.optional.length > 0) {
      console.log(`  \x1b[1;33mTiers optionnels    :\x1b[0m \x1b[1;33m${profile.optional.join(', ')}\x1b[0m`);
    }
    console.log('');

  const tiers = loadTiers(profileArg);
  let tierKeys = Object.keys(tiers).map(Number).sort();

  if (tierArg !== "all") {
    const target = parseInt(tierArg);
    tierKeys = tierKeys.filter(t => t === target);
  }

  tierKeys = tierKeys.filter(t =>
    profile.mandatory.includes(t) || profile.optional.includes(t)
  );

  if (tierKeys.length === 0) {
    console.log(`\x1b[31mAucun tier applicable pour la cible '${tierArg}' avec le profil ${profileArg}.\x1b[0m`);
    return { ecoleLabel, profileArg, skipped: true };
  }

  let globalReport = `# Rapport d'Évaluation V3\n\n`;
  globalReport += `**Date :** ${new Date().toLocaleString('fr-FR')}\n`;
  globalReport += `**Log :** ${path.basename(logger.getFilePath())}\n`;
  globalReport += `**Profil :** ${profile.label}\n\n---\n\n`;

  let modelName = "Modele_En_Attente";
  let globalScore = { passed: 0, total: 0, mandatoryPassed: 0, mandatoryTotal: 0 };
  let globalHelpCount = 0;
  let globalRetriedCount = 0;
  let globalOptionalBonus = 0;
  // Le rattrapage est désactivé en mode cloud (coût par appel API)
  const rattrapageEnabled = !isCloudMode && isRattrapageEligibleProfile(profileArg);

  if (rattrapageEnabled) {
    logger.info(`Mode rattrapage activé pour le profil ${profileArg}.`);
    console.log(`  \x1b[36mMode rattrapage actif : une seconde tentative est proposée en cas d'échec de tier.\x1b[0m\n`);
  }

  let stopGlobalEval = false;
  let gameState = { globalLifeScore: 0 };
  let tierScorecard = [];
  let allEvalResults = [];      // Agrégation pour le calcul de calibration (status: success/failed/bypassed)
  let allFilterDecisions = [];  // Décisions de filtrage pour la section rapport calibration
  let allTierResponses = [];    // Réponses brutes + raisonnement par tier (pour l'export raisonnement NotebookLM)

  // --- Détection de doublon (modèle déjà testé sur cette école) ---
  // Vérifie le carnet de scores persistant : si une entrée existe déjà pour ce
  // modèle sur cette école, on alerte l'utilisateur et on lui propose de forcer.
  if (tierArg === "all" && preKnownModelName) {
    const dupShortName = shortenModelName(preKnownModelName);
    const dupLedger = scoreLedger.loadLedger(dupShortName);
    const rawExisting = dupLedger.ecoles[ecoleLabel];
    const existing = scoreLedger.getEcoleBest(rawExisting);
    const existingAttempts = scoreLedger.getEcoleAttempts(rawExisting);
    if (existing) {
      console.log('');
      console.log(`  \x1b[33m⚠ ATTENTION : Ce modèle a déjà été testé sur l'école ${ecoleLabel} !\x1b[0m`);
      console.log(`  \x1b[90m  Meilleur score précédent : ${existing.score}/${existing.max} (${existing.pct}%) — ${existing.date}\x1b[0m`);
      console.log(`  \x1b[90m  Tentatives cumulées : ${existingAttempts.length} | Rapport : ${existing.reportFile || 'N/A'}\x1b[0m`);
      const forceRetest = await askYesNo(`  Voulez-vous lancer un nouveau test (sera cumulé à l'historique, le meilleur score est conservé) ?`, true);
      if (!forceRetest) {
        console.log(`  \x1b[36mTest annulé : le score existant est conservé.\x1b[0m`);
        console.log(`  \x1b[90mAstuce : relancez avec un autre modèle ou profil pour comparer.\x1b[0m\n`);
        logger.info(`Test annulé : doublon détecté pour ${preKnownModelName} sur ${ecoleLabel}, utilisateur a refusé de forcer.`);
        // On ne ferme PAS le logger (d'autres écoles peuvent suivre). On renvoie
        // null pour skipper cette école sans interrompre le run multi-écoles.
        return { ecoleLabel, profileArg, skipped: true };
      }
      logger.info(`Re-test demandé pour ${preKnownModelName} sur ${ecoleLabel} (tentative #${existingAttempts.length + 1}).`);
      console.log(`  \x1b[33mRe-test lancé — tentative #${existingAttempts.length + 1} (le meilleur score est conservé pour le classement).\x1b[0m\n`);
    }
  }

  for (const tierNum of tierKeys) {
    const tierData = tiers[tierNum];
    const isMandatory = profile.mandatory.includes(tierNum);

    let attemptNumber = 1;
    let bestResult = null;

    while (true) {
      const attemptResult = await runTierAttempt({
        tierNum,
        tierData,
        isMandatory,
        profileArg,
        contextLimitTokens,
        attemptNumber,
        queryFn,
        providerConfig: isCloudMode ? { provider: resolvedProvider, model: resolvedCloudModel, apiKey: resolvedApiKey, endpoint: resolvedEndpoint } : null,
        gameState,
        selfProfile,
        teacherConfig: teacherConfigResolved
      });

      if (attemptResult.responseModelName && modelName === "Modele_En_Attente") {
        modelName = attemptResult.responseModelName;
        globalReport = `# Rapport d'Évaluation V3 — ${modelName}\n\n` +
          `**Date :** ${new Date().toLocaleString('fr-FR')}\n` +
          `**Log :** ${path.basename(logger.getFilePath())}\n` +
          `**Profil :** ${profile.label}\n\n---\n\n`;
      }

      if (!attemptResult.skippedOptional && shouldReplaceBestResult(bestResult, attemptResult)) {
        bestResult = attemptResult;
      }
      
      if (attemptResult.eliminated) {
        console.log(`\n  \x1b[31m[ARRET FATAL] Le test complet est stoppé car le modèle a été éliminé (score <= -100).\x1b[0m\n`);
        stopGlobalEval = true;
        break;
      }

      if (attemptResult.skippedOptional || attemptResult.allPassed) {
        break;
      }

      // Simulation de l'arrêt complet (ERREUR FATALE constatée par l'utilisateur au niveau CE2 / Tier 3)
      // Si on échoue un tier obligatoire, on stoppe l'exécution globale plutôt que de continuer aveuglément !
      if (isMandatory) {
        console.log(`\n  \x1b[31m[ARRET] L'évaluation s'arrête ici car le tier obligatoire ${tierNum} a échoué.\x1b[0m\n`);
        stopGlobalEval = true;
        break;
      }

      if (!rattrapageEnabled || attemptNumber > MAX_RATTRAPAGE_ATTEMPTS) {
        break;
      }

      const wantsRetry = await askYesNo(`  Voulez-vous lancer une séance de rattrapage pour le Tier ${tierNum} ?`, true);
      logger.info(`Tier ${tierNum} — rattrapage demandé: ${wantsRetry ? 'oui' : 'non'}`);
      if (!wantsRetry) {
        break;
      }

      attemptNumber += 1;
      logger.info(`Tier ${tierNum} — lancement du rattrapage ${attemptNumber - 1}/${MAX_RATTRAPAGE_ATTEMPTS}.`);
      console.log('');
    }

    if (!bestResult || bestResult.skippedOptional) {
      if (stopGlobalEval) break;
      continue;
    }

    if (attemptNumber > 1) {
      console.log(`  \x1b[36mScore retenu (meilleure tentative) : ${bestResult.tierPassedCount}/${bestResult.tierTotalCount} (${bestResult.tierPct}%).\x1b[0m\n`);
    }

    globalReport += bestResult.report;

    globalScore.passed += bestResult.tierPassedCount;
    globalScore.total += bestResult.tierTotalCount;

    if (isMandatory) {
      globalScore.mandatoryPassed += bestResult.tierPassedCount;
      globalScore.mandatoryTotal += bestResult.tierTotalCount;
    }

    tierScorecard.push({
      tierNum,
      className: getClassName(profileArg, tierNum),
      score: bestResult.tierPassedCount,
      max: bestResult.tierTotalCount,
      pct: bestResult.tierPct,
      passed: bestResult.allPassed,
      mandatory: isMandatory,
      helpUsedCount: bestResult.helpUsedCount || 0,
      retriedCount: bestResult.retriedCount || 0,
      optionalBonus: bestResult.optionalBonus || 0,
      annotations: bestResult.tierAnnotations || []
    });
    globalHelpCount += bestResult.helpUsedCount || 0;
    globalRetriedCount += bestResult.retriedCount || 0;
    globalOptionalBonus += bestResult.optionalBonus || 0;

    // Agrégation pour la calibration (status: success/failed/bypassed)
    if (bestResult.evalResults && bestResult.evalResults.length > 0) {
      for (const er of bestResult.evalResults) {
        er._tierNum = tierNum;
      }
      allEvalResults = allEvalResults.concat(bestResult.evalResults);
    }
    if (bestResult.filterDecisions && bestResult.filterDecisions.length > 0) {
      allFilterDecisions = allFilterDecisions.concat(bestResult.filterDecisions);
    }

    // Agrégation des réponses brutes + raisonnement par tier (pour l'export
    // raisonnement consolidé destiné à NotebookLM via Gemini).
    if (bestResult.rawResponse) {
      allTierResponses.push({
        tierNum,
        tierTitle: tierData.title,
        isMandatory,
        className: getClassName(profileArg, tierNum),
        rawResponse: bestResult.rawResponse,
        evalResults: bestResult.evalResults || []
      });
    }

    printScorecard(tierScorecard, ecoleLabel, false, gameState.globalLifeScore);

    if (stopGlobalEval) {
      globalReport += `\n> **⚠️ ARRÊT PRÉMATURÉ :** L'évaluation a été stoppée (Modèle éliminé ou Tier obligatoire échoué).\n`;
      break;
    }
  }

  // Tableau récapitulatif final de l'école
  if (tierScorecard.length > 0) {
    printScorecard(tierScorecard, ecoleLabel, true, gameState.globalLifeScore);
    globalReport += buildScorecardReport(tierScorecard, ecoleLabel, gameState.globalLifeScore);
  }

  // --- Section Auto-Profilage & Calibration (injectée en haut du rapport) ---
  // Injectée plus loin, après le calcul de `calibration` (cf. ci-dessous).

  const hasMandatory = globalScore.mandatoryTotal > 0;
  const pctMandatory = hasMandatory
    ? Math.round((globalScore.mandatoryPassed / globalScore.mandatoryTotal) * 100)
    : 0;
  const pctGlobal = globalScore.total > 0
    ? Math.round((globalScore.passed / globalScore.total) * 100)
    : 0;

  const globalGradeInfo = letterGrade(pctGlobal);
  const mandatoryGradeInfo = hasMandatory ? letterGrade(pctMandatory) : { grade: 'N/A', color: '\x1b[90m' };
  const mandatoryScoreStr = hasMandatory ? `${globalScore.mandatoryPassed}/${globalScore.mandatoryTotal} (${pctMandatory}%)` : "N/A (Optionnel)";

  // --- Calcul de l'Indice de Calibration (Self-Profiling) ---
  let calibration = null;
  if (selfProfile && allEvalResults.length > 0) {
    calibration = scoreLedger.calculateCalibrationIndex(selfProfile, allEvalResults);
    const verdict = scoreLedger.interpretCalibration(calibration.calibrationIndex);
    logger.info(`Calibration : D=${calibration.declaredLevel.toFixed(3)}, P=${calibration.actualPerformance.toFixed(3)}, C=${calibration.calibrationIndex.toFixed(3)} — ${verdict}`);
  }

  // --- Injection de la section Calibration dans le rapport (après calcul) ---
  if (selfProfile && calibration) {
    const calibrationSection = buildCalibrationReport(selfProfile, calibration, allFilterDecisions, SKILL_LABELS);
    const firstSep = globalReport.indexOf('\n---\n');
    if (firstSep !== -1) {
      globalReport = globalReport.slice(0, firstSep + 5) + '\n' + calibrationSection + globalReport.slice(firstSep + 5);
    } else {
      globalReport = calibrationSection + globalReport;
    }
  }

  console.log('\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m');
  console.log(`\x1b[36m\u2551  SCORE GLOBAL (Points) : ${globalScore.passed}/${globalScore.total} (${pctGlobal}%)                    \x1b[0m`);
  console.log(`\x1b[36m\u2551  SCORE OBLIGATOIRE    : ${mandatoryScoreStr.padEnd(25)} \x1b[0m`);
  console.log(`\x1b[36m\u2551  NOTE GLOBALE         : ${globalGradeInfo.color}\x1b[1m\u2588\u2588 ${globalGradeInfo.grade.padEnd(3)} \u2588\u2588\x1b[0m\x1b[36m                          \x1b[0m`);
  console.log(`\x1b[36m\u2551  NOTE OBLIGATOIRE     : ${mandatoryGradeInfo.color}\x1b[1m\u2588\u2588 ${mandatoryGradeInfo.grade.padEnd(3)} \u2588\u2588\x1b[0m\x1b[36m                          \x1b[0m`);

  if (globalOptionalBonus > 0) {
    console.log(`\x1b[36m\u2551  \x1b[35m+ Bonus optionnel : ${globalOptionalBonus} points (exercices optionnels réussis)\x1b[0m`);
  }

  if (globalHelpCount > 0 || globalRetriedCount > 0) {
    const parts = [];
    if (globalHelpCount > 0) parts.push(`aide (${globalHelpCount})`);
    if (globalRetriedCount > 0) parts.push(`rattrapage (${globalRetriedCount})`);
    console.log(`\x1b[36m\u2551  \x1b[33m⚠ Score obtenu avec ${parts.join(' et ')}\x1b[0m`);
  }

  const verdictPct = hasMandatory ? pctMandatory : pctGlobal;

  if (verdictPct >= 80) {
    console.log(`\x1b[36m\u2551  \x1b[32m\u2588\u2588\u2588 VERDICT : MODÈLE RECOMMANDÉ \u2588\u2588\u2588\x1b[0m\x1b[36m                  \u2551\x1b[0m`);
  } else if (verdictPct >= 50) {
    console.log(`\x1b[36m\u2551  \x1b[33m\u2588\u2588\u2588 VERDICT : MODÈLE PARTIEL — RÉSERVES \u2588\u2588\u2588\x1b[0m\x1b[36m           \u2551\x1b[0m`);
  } else {
    console.log(`\x1b[36m\u2551  \x1b[31m\u2588\u2588\u2588 VERDICT : MODÈLE NON RECOMMANDÉ \u2588\u2588\u2588\x1b[0m\x1b[36m             \u2551\x1b[0m`);
  }

  // Affichage console de l'Indice de Calibration
  if (calibration) {
    const verdict = scoreLedger.interpretCalibration(calibration.calibrationIndex);
    const cColor = calibration.calibrationIndex >= 0.85 ? '\x1b[32m' : (calibration.calibrationIndex >= 0.65 ? '\x1b[33m' : '\x1b[31m');
    console.log(`\x1b[36m\u2551  ${cColor}Indice de Calibration : C = ${calibration.calibrationIndex.toFixed(3)} (D=${(calibration.declaredLevel*100).toFixed(0)}%, P=${(calibration.actualPerformance*100).toFixed(0)}%)\x1b[0m`);
    console.log(`\x1b[36m\u2551  ${cColor}${verdict}\x1b[0m`);
  }

  // Gamification Niveau 3 : Grosse Recompense d'Ecole
  // Le diplôme de l'école ne s'obtient qu'en mode "all" (toutes les classes de
  // l'école traversées) ET si TOUS les tiers obligatoires du profil ont été
  // validés. En mode tier unique (ex: --tier=0), on ne décerne qu'une mention
  // « classe validée » — jamais le diplôme complet de l'école, sinon un modèle
  // qui ne ferait que la 6ème (tier 0) à 100% recevrait le diplôme du Collège-Lycée.
  const isAllMode = (tierArg === "all");
  const mandatoryTiersAttempted = profile.mandatory.every(t => tierKeys.includes(t));
  const allMandatoryPassed = tierScorecard
    .filter(e => e.mandatory)
    .every(e => e.passed);
  const diplomaEligible = isAllMode && mandatoryTiersAttempted && allMandatoryPassed && (pctGlobal >= 100);

  if (diplomaEligible) {
    const recompense = `Diplôme de l'école ${PROFILES[profileArg]?.ecole || profileArg} décerné au modèle avec les honneurs !`;
    console.log(`\x1b[36m\u2551  \x1b[35m\u2588\u2588\u2588 TROPHÉE OBTENU : ${recompense} \u2588\u2588\u2588\x1b[0m\x1b[36m \u2551\x1b[0m`);
    globalReport += `\n> **🏆 Trophée Majeur :** ${recompense}\n`;
  } else if (pctGlobal >= 100 && !isAllMode) {
    // En mode tier unique avec 100% sur la classe ciblée : on félicite pour la
    // classe, sans attribuer le diplôme complet de l'école (pour éviter un
    // faux diplôme sur une seule classe).
    const classeLabel = getClassName(profileArg, parseInt(tierArg));
    console.log(`\x1b[36m\u2551  \x1b[35m\u2588\u2588\u2588 CLASSE VALIDÉE : ${classeLabel} (100%) — diplôme de l'école non attribué (mode classe unique) \u2588\u2588\u2588\x1b[0m\x1b[36m \u2551\x1b[0m`);
    globalReport += `\n> **✔ Classe validée :** ${classeLabel} (100%). Le diplôme complet de l'école ${PROFILES[profileArg]?.ecole || profileArg} n'est attribué qu'en mode "all" (toutes les classes obligatoires réussies).\n`;
  }

  console.log('\x1b[36m\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1b[0m\n');

  globalReport += `\n---\n\n## Tableau récapitulatif des points par exercice\n\n`;
  globalReport += `| Tier | Exercice | Type | Points obtenus | Points max | Statut | Aide | Rattrapage |\n`;
  globalReport += `|---|---|---|---|---|---|---|---|\n`;
  for (const r of allEvalResults) {
    const tierNumMatch = (r._tierNum != null) ? r._tierNum : '';
    const st = r.status === 'bypassed' ? '⊘ Bypassé' : (r.status === 'success' ? '✔ Validé' : '✘ Échec');
    const help = r.helpUsed ? 'Oui' : 'Non';
    const retry = r.retried ? 'Oui' : 'Non';
    globalReport += `| ${tierNumMatch} | ${r.id} | ${r.taskType || '—'} | ${r.points || 0} | ${r.maxPoints || 0} | ${st} | ${help} | ${retry} |\n`;
  }
  const grandTotalPts = allEvalResults.reduce((s, r) => s + (r.points || 0), 0);
  const grandTotalMax = allEvalResults.reduce((s, r) => s + (r.maxPoints || 0), 0);
  globalReport += `| **TOTAL** | | | **${grandTotalPts}** | **${grandTotalMax}** | | | |\n\n`;
  globalReport += `---\n\n`;

  // --- Section : explications pédagogiques des échecs définitifs ---
  // Pour chaque exercice définitivement échoué, on restitue l'explication fournie
  // par le modèle (ou par le professeur en cas de repli). Interdit d'afficher une
  // erreur brute sans explication : cette section garantit que l'utilisateur
  // dispose toujours d'une analyse compréhensible de chaque échec.
  const failedWithExplanations = allEvalResults.filter(r => r.status === 'failed' && r.failureExplanation);
  if (failedWithExplanations.length > 0) {
    globalReport += `\n## Explications des échecs définitifs\n\n`;
    globalReport += `> Le professeur a exigé du modèle qu'il explique la cause de chaque échec définitif. `;
    globalReport += `Les erreurs techniques brutes du moteur d'exécution ne sont jamais affichées seules : `;
    globalReport += `elles sont systématiquement accompagnées d'une analyse pédagogique.\n\n`;
    for (const r of failedWithExplanations) {
      const tierNumMatch = (r._tierNum != null) ? `Tier ${r._tierNum} — ` : '';
      globalReport += `### ${tierNumMatch}${r.id} — ${r.taskType || 'Exercice'}\n\n`;
      globalReport += `**Explication de l'élève :** ${r.failureExplanation}\n\n`;
      if (r.teacherCorrection) {
        globalReport += `**🎓 Correction du professeur IA :** ${r.teacherCorrection}\n\n`;
      }
    }
    globalReport += `---\n\n`;
  }

  globalReport += `\n---\n\n## Score Global\n\n`;
  globalReport += `| Métrique | Valeur | Note |\n|---|---|---|\n`;
  globalReport += `| Score global | ${globalScore.passed}/${globalScore.total} (${pctGlobal}%) | ${globalGradeInfo.grade} |\n`;
  globalReport += `| Score obligatoire | ${mandatoryScoreStr} | ${mandatoryGradeInfo.grade} |\n`;
  globalReport += `| Verdict | ${verdictPct >= 80 ? 'RECOMMANDÉ' : verdictPct >= 50 ? 'PARTIEL' : 'NON RECOMMANDÉ'} | ${hasMandatory ? mandatoryGradeInfo.grade : globalGradeInfo.grade} |\n`;

  if (globalOptionalBonus > 0) {
    globalReport += `| Bonus optionnel | +${globalOptionalBonus} points | — |\n`;
  }

  if (globalHelpCount > 0 || globalRetriedCount > 0) {
    const parts = [];
    if (globalHelpCount > 0) parts.push(`**avec aide** (${globalHelpCount} exercice${globalHelpCount > 1 ? 's' : ''})`);
    if (globalRetriedCount > 0) parts.push(`**avec rattrapage** (${globalRetriedCount} exercice${globalRetriedCount > 1 ? 's' : ''})`);
    globalReport += `\n> ⚠️ **Score obtenu ${parts.join(' et ')}.**\n`;
  }

  const shortName = shortenModelName(modelName);
  const tierTag = (tierArg && tierArg !== "all") ? `_tier${tierArg}` : "";
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `rapport_v3_${shortName}_${profileArg.toLowerCase()}${tierTag}_${timeStr}.md`;

  // Classification : Export-Rapports/<AAAA-MM-JJ>/<ÉCOLE>/<NIVEAU-OU-CLASSE>/<fichier>
  // Le dossier intermédiaire sous l'école représente soit la classe (en mode tier
  // unique) soit le niveau/profil (en mode "all"). Le nom du fichier porte l'heure
  // (HH-MM-SS) pour distinguer plusieurs runs d'une même journée et faire le lien
  // avec le fichier de log associé.
  const ecole = (PROFILES[profileArg] && PROFILES[profileArg].ecole) || profileArg;
  const exportDir = path.join(__dirname, 'Export-Rapports');
  const dateDir = path.join(exportDir, dateStr);
  const ecoleDir = path.join(dateDir, ecole);

  let targetDir = ecoleDir;
  if (tierArg && tierArg !== "all") {
    const tierNum = parseInt(tierArg);
    const classeLabel = (CLASSE_NAMES[profileArg] && CLASSE_NAMES[profileArg][tierNum]) || `Classe-${tierNum}`;
    targetDir = path.join(ecoleDir, classeLabel);
  } else {
    // Mode "all" : on range dans un sous-dossier représentant le niveau/profil
    // (ex: "STANDARD", "LIGHT") pour ne jamais mélanger les rapports de niveaux
    // différents dans le même dossier école.
    const niveauLabel = profileArg || 'STANDARD';
    targetDir = path.join(ecoleDir, niveauLabel);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, filename);
  const relPath = path.relative(__dirname, outputPath);

  // --- Modèle effectif (résolu dès maintenant pour usage aval : rapport externe + carnet) ---
  const effectiveModel = (modelName !== "Modele_En_Attente") ? modelName : (resolvedCloudModel || null);

  // --- Section « Validation du professeur IA » (rédigée par un modèle externe) ---
  // Le professeur externe prend en charge la lecture pédagogique finale : note,
  // classement perçu, méthodologie, compréhension des exercices, recommandation.
  // Cette section est ajoutée à la fin du rapport Markdown généré localement.
  // Indisponible (pas de clé / provider) → repli silencieux, le rapport reste
  // complet techniquement.
  if (teacherConfigResolved && teacherConfigResolved.enabled) {
    console.log(`  \x1b[35m👨‍🏫 Professeur IA : rédaction de la validation finale du rapport...\x1b[0m`);
    try {
      const teacherReportSection = await buildExternalTeacherReport({
        teacherConfig: teacherConfigResolved,
        results: {
          modelName: effectiveModel || modelName,
          profileLabel: profile.label,
          ecoleLabel: ecole,
          tierScorecard,
          evalResults: allEvalResults,
          globalScore,
          calibration,
          failureExplanations: null,
          teacherCorrections: null
        }
      });
      if (teacherReportSection) {
        globalReport += `\n---\n\n${teacherReportSection}\n`;
        console.log(`  \x1b[32m👨‍🏫 Validation du professeur IA ajoutée au rapport.\x1b[0m`);
      } else {
        console.log(`  \x1b[33m👨‍🏫 Professeur IA indisponible — rapport sans validation externe.\x1b[0m`);
      }
    } catch (e) {
      logger.warn(`Validation externe du rapport échouée : ${e.message}`);
      console.log(`  \x1b[33m👨‍🏫 Professeur IA en erreur — rapport sans validation externe.\x1b[0m`);
    }
  }

  // --- Carnet de scores persistant (cumul multi-écoles) ---
  if (effectiveModel && tierArg === "all") {
    const ecoleResult = {
      profile: profileArg,
      ecole: ecole,
      score: globalScore.passed,
      max: globalScore.total,
      pct: pctGlobal,
      mandatoryPassed: globalScore.mandatoryPassed,
      mandatoryTotal: globalScore.mandatoryTotal,
      globalLifeScore: gameState.globalLifeScore,
      optionalBonus: globalOptionalBonus,
      helpCount: globalHelpCount,
      retriedCount: globalRetriedCount,
      calibrationIndex: calibration ? calibration.calibrationIndex : null,
      declaredLevel: calibration ? calibration.declaredLevel : null,
      date: dateStr,
      time: timeStr,
      reportFile: relPath,
      selfProfile: selfProfile || null,
      tiers: allTierResponses,
      quantization: resolvedQuantization || null
    };
    const bilanMd = scoreLedger.saveAndBuildBilan(shortName, effectiveModel, ecoleResult, resolvedQuantization || null);
    if (bilanMd) globalReport += bilanMd;
  }

  fs.writeFileSync(outputPath, globalReport, 'utf8');
  const logRelPath = path.relative(__dirname, logger.getFilePath());
  console.log(`  \x1b[32mRapport sauvegardé : ${relPath}\x1b[0m`);
  console.log(`  \x1b[90mFichier de log    : ${logRelPath}\x1b[0m\n`);

  // --- Bilan global multi-écoles (console) ---
  if (effectiveModel && tierArg === "all") {
    scoreLedger.printBilanGlobal(shortName, effectiveModel);
  }

  // --- Génération du classement global (HTML + Markdown) ---
  // Après chaque run complet, on régénère le classement de tous les modèles testés.
  if (tierArg === "all") {
    console.log(`  \x1b[35mGénération du classement...\x1b[0m`);
    leaderboard.generateLeaderboard();
  }

  logger.info(`Benchmark terminé (${ecoleLabel}). Score global : ${globalScore.passed}/${globalScore.total} (${pctGlobal}%). Score obligatoire : ${globalScore.mandatoryPassed}/${globalScore.mandatoryTotal} (${pctMandatory}%).`);

  // --- Fin de runSchool : on renvoie un résumé à main() ---
  // On NE ferme PAS le logger ici (plusieurs écoles peuvent s'enchaîner).
  return {
    ecoleLabel,
    profileArg,
    pctGlobal,
    pctMandatory,
    globalScore: { ...globalScore },
    effectiveModel,
    shortName: shortName || null,
    eliminated: stopGlobalEval
  };
  } // fin de runSchool

  // --- Décision : quelles écoles lancer ? ---
  // Par défaut, une seule école (le profil résolu). Mais si le modèle fait > 3B
  // paramètres (profil STANDARD ou supérieur), on propose d'enchaîner Primaire
  // (LIGHT) puis Collège-Lycée (STANDARD) dans le même run — même clé, même
  // auto-profilage, gameState réinitialisé entre écoles. Utile pour benchmarker
  // un modèle sur deux niveaux scolaires d'un coup.
  let schoolsToRun = [profileArg];
  const modelIsBigEnough = (profileArg !== 'LIGHT'); // > 3B → STANDARD ou plus
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (tierArg === "all" && modelIsBigEnough && isInteractive) {
    console.log(`\n  \x1b[1;36m━━━ ÉCOLES À ÉVALUER ━━━\x1b[0m`);
    console.log(`  \x1b[90mLe modèle (${profile.label}) est supérieur à 3B paramètres : il peut être évalué sur plusieurs écoles.\x1b[0m`);
    console.log(`  \x1b[90m(A) ${profile.label} uniquement (école courante)\x1b[0m`);
    console.log(`  \x1b[90m(B) Primaire (LIGHT) puis ${profile.label} — évaluation séquentielle des deux écoles\x1b[0m`);
    const wantsTwoSchools = await askYesNo(`  Lancer les deux écoles (Primaire + ${profile.ecole}) séquentiellement dans ce run ?`, true);
    if (wantsTwoSchools) {
      // On exécute d'abord Primaire (LIGHT), puis l'école principale (profileArg).
      // Set() évite tout doublon si profileArg était déjà LIGHT (impossible ici
      // car modelIsBigEnough exclut LIGHT, mais on garde la sécurité).
      schoolsToRun = [...new Set(['LIGHT', profileArg])];
      console.log(`  \x1b[1;35m→ ${schoolsToRun.length} écoles seront évaluées : ${schoolsToRun.map(p => PROFILES[p].ecole).join(' → ')}\x1b[0m\n`);
    } else {
      console.log(`  \x1b[90m→ École unique : ${profile.ecole}\x1b[0m\n`);
    }
  }

  // --- Exécution séquentielle des écoles ---
  let lastResult = null;
  for (let si = 0; si < schoolsToRun.length; si++) {
    const schoolProfile = schoolsToRun[si];
    const isSecondSchool = (si > 0);
    if (schoolsToRun.length > 1) {
      console.log(`\n  \x1b[1;35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
      console.log(`  \x1b[1;35m  ÉCOLE ${si + 1}/${schoolsToRun.length} — ${PROFILES[schoolProfile].ecole}\x1b[0m`);
      console.log(`  \x1b[1;35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
      if (isSecondSchool) {
        console.log(`  \x1b[90m gameState réinitialisé pour cette école. Clé, auto-profilage et professeur conservés.\x1b[0m`);
      }
    }
    try {
      lastResult = await runSchool(schoolProfile, { isSecondSchool });
      // Si le modèle a été éliminé pendant cette école, on n'enchaîne pas la suite.
      if (lastResult && lastResult.eliminated) {
        console.log(`  \x1b[31mModèle éliminé sur ${lastResult.ecoleLabel} — arrêt des écoles suivantes.\x1b[0m`);
        break;
      }
    } catch (e) {
      logger.error(`Erreur fatale sur l'école ${PROFILES[schoolProfile].ecole} : ${e.message}`);
      console.error(`\x1b[31m[ERREUR]\x1b[0m École ${PROFILES[schoolProfile].ecole} : ${e.message}`);
      break;
    }
  }

  logger.close();
}

main().catch(e => {
  logger.error(`ERREUR FATALE : ${e.message}`);
  logger.error(`Stack : ${e.stack}`);
  logger.close();
  console.error(`\x1b[31m[ERREUR FATALE]\x1b[0m ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
