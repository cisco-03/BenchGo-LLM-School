
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('./logger');
const { PROFILES, CLASSE_NAMES, parseCliArgs, detectProfileFromModelName, fetchModelNameFromLMStudio } = require('./config');
const { ProgressBar, Spinner, letterGrade } = require('./progress-bar');
const { extractJSON, extractCodeRegex } = require('./parsing-utils');
const { queryLLM: queryLLMLocal } = require('./lm-studio-client');
const { queryLLM: queryLLMCloud } = require('./cloud-client');
const { loadTiers } = require('./tier-loader');
const { evaluateTask } = require('./task-evaluator');
const { buildTierReport, shortenModelName } = require('./report-generator');
const { updateTiers } = require('./auto-updater');

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

  for (const entry of scorecard) {
    totalScore += entry.score;
    totalMax += entry.max;
    const pct = entry.max > 0 ? Math.round((entry.score / entry.max) * 100) : 0;
    const gradeInfo = letterGrade(pct);
    const optTag = entry.mandatory ? '' : ' (opt.)';
    const statusIcon = entry.passed ? '\x1b[32m✔ Validé\x1b[0m' : '\x1b[31m✘ Échec\x1b[0m';
    const annTag = (entry.annotations && entry.annotations.length > 0) ? ` \x1b[33m[${entry.annotations.join(', ')}]\x1b[0m` : '';
    const pointsStr = `${entry.score}/${entry.max}`;
    console.log(
      `  ${entry.className.padEnd(18)}${pointsStr.padStart(12)}${(pct + '%').padStart(7)}  ` +
      `${gradeInfo.color}${gradeInfo.grade}\x1b[0m      ${statusIcon}${optTag}${annTag}`
    );
  }

  if (scorecard.length > 0) {
    const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    const totalGrade = letterGrade(totalPct);
    console.log(`  \x1b[90m${'─'.repeat(58)}\x1b[0m`);
    console.log(
      `  \x1b[1m${'TOTAL ÉCOLE'.padEnd(18)}${`${totalScore}/${totalMax}`.padStart(12)}${(totalPct + '%').padStart(7)}  ` +
      `${totalGrade.color}${totalGrade.grade}\x1b[0m\x1b[1m  (Santé: ${globalLifeScore} PV)\x1b[0m`
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

  for (const entry of scorecard) {
    totalScore += entry.score;
    totalMax += entry.max;
    const pct = entry.max > 0 ? Math.round((entry.score / entry.max) * 100) : 0;
    const gradeInfo = letterGrade(pct);
    const status = entry.passed ? '✔ Validé' : '✘ Échec';
    const mandatory = entry.mandatory ? 'Oui' : 'Optionnel';
    const ann = (entry.annotations && entry.annotations.length > 0) ? entry.annotations.join(', ') : '—';
    report += `| ${entry.className} | ${entry.score}/${entry.max} | ${pct}% | ${gradeInfo.grade} | ${status} | ${mandatory} | ${ann} |\n`;
  }

  if (scorecard.length > 0) {
    const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    const totalGrade = letterGrade(totalPct);
    report += `| **TOTAL ÉCOLE** | **${totalScore}/${totalMax}** | **${totalPct}%** | **${totalGrade.grade}** | | | |\n`;
    report += `\n> **Santé Globale finale :** ${globalLifeScore} PV\n`;
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

async function runTierAttempt({ tierNum, tierData, isMandatory, profileArg, contextLimitTokens, attemptNumber, queryFn, providerConfig, gameState }) {
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

  let evalResultsMap = {};
  const taskRetryMap = {};
  const taskNetPoints = {};
  const taskHelpUsed = {};
  const taskHelpOffered = {};
  const taskLastError = {};
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
    dynamicPrompt += `Renvoyez vos réponses en Markdown. Pour chaque exercice, utilisez un titre avec l'ID de l'exercice (par exemple "### ${availableTasks[0]?.id || 'tache_0a'}"), suivi du code de la fonction encadré par des balises \`\`\`javascript et \`\`\`.\n`;
    dynamicPrompt += `Exemple attendu :\n### ${availableTasks[0]?.id || 'tache_0a'}\n\`\`\`javascript\nfunction solution() { return true; }\n\`\`\`\n`;
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
             console.log(`  \x1b[32m✔ Succès ! +${pts} Points (Tier: ${tierScore}, Santé: ${gameState.globalLifeScore})\x1b[0m`);

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
                console.log(`    \x1b[90mRaison: ${errors.substring(0, 80)}\x1b[0m`);
                console.log(`  \x1b[33m🏳️ L'élève déclare avoir terminé : impossible de résoudre l'exercice ${task.id}.\x1b[0m`);

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
            helpUsed: Boolean(taskHelpUsed[task.id]),
            retried: (taskRetryMap[task.id] || 0) >= 1
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
    responseModelName
  };
}

async function main() {
  console.clear();

  console.log('\n\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m');
  console.log('\x1b[36m\u2551         BENCHGO V3 — EXÉCUTION COMPORTEMENTALE           \u2551\x1b[0m');
  console.log('\x1b[36m\u2551   (VM Sandbox + Tests RFC 7946 + Flood Fill + React Sim)  \u2551\x1b[0m');
  console.log('\x1b[36m\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1b[0m\n');

  const { tierArg, profileArgExplicit, contextLimitTokens: contextLimitFromCli, provider, model: cloudModel, apiKey, endpoint } = parseCliArgs();
  const isCloudMode = Boolean(provider);
  const providerConfig = isCloudMode ? { provider, model: cloudModel, apiKey } : null;
  const queryFn = isCloudMode ? queryLLMCloud : queryLLMLocal;
  let profileArg = profileArgExplicit || (isCloudMode ? 'FRONTIER' : 'STANDARD');
  const contextLimitTokens = contextLimitFromCli || DEFAULT_CONTEXT_LIMIT_TOKENS;

  // Lance l'auto-updater pour ajouter les exercices manquants et les points
  updateTiers();

  logger.info(`Démarrage du benchmark`);
  logger.info(`Cible demandée : ${tierArg.toUpperCase()}`);
  logger.info(`Profil explicite CLI : ${profileArgExplicit || 'AUCUN (auto-détection)'}`);
  logger.info(`Budget contexte : ${contextLimitTokens} tokens`);
  logger.info(`Fichier de log : ${logger.getFilePath()}`);

  if (isCloudMode) {
    // Mode cloud : pas d'auto-détection LM Studio, le modèle est fourni explicitement
    if (!cloudModel) {
      console.error('\x1b[31m[ERREUR]\x1b[0m --provider spécifié sans --model. Ex: --model=gpt-4o');
      process.exit(1);
    }
    logger.info(`Mode cloud : provider=${provider}, modèle=${cloudModel}`);
    console.log(`  Mode              : \x1b[1;35mCLOUD\x1b[0m`);
    console.log(`  Fournisseur       : \x1b[1;35m${provider.toUpperCase()}\x1b[0m`);
    console.log(`  Modèle            : \x1b[1;35m${cloudModel}\x1b[0m`);
    if (apiKey) {
      console.log(`  Clé API           : \x1b[33m passée en argument (visible dans le gestionnaire de tâches)\x1b[0m`);
    }
    if (profileArgExplicit) {
      logger.info(`Profil forcé par l'utilisateur : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}`);
    } else {
      logger.info(`Profil cloud auto : FRONTIER`);
    }
  } else if (!profileArgExplicit) {
    logger.info(`Aucun --profile= passé. Tentative de détection automatique via LM Studio...`);
    const detectedModelName = await fetchModelNameFromLMStudio();
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
  } else {
    logger.info(`Profil forcé par l'utilisateur : ${PROFILES[profileArg] ? PROFILES[profileArg].label : profileArg}`);
  }

  if (!PROFILES[profileArg]) {
    logger.warn(`Profil inconnu '${profileArg}', remplacement par STANDARD.`);
    profileArg = 'STANDARD';
  }

  const profile = PROFILES[profileArg];
  logger.runConfig({ 
    'Cible': tierArg, 
    'Profil': profile.label, 
    'Budget contexte': `${contextLimitTokens} tokens`,
    'Tiers obligatoires': profile.mandatory.join(','), 
    'Tiers optionnels': profile.optional.join(',') || 'aucun' 
  });

  console.log(`  Profil d'évaluation : \x1b[1;33m${profile.label}\x1b[0m`);
  console.log(`  Cible demandée      : \x1b[1;33m${tierArg.toUpperCase()}\x1b[0m\n`);
  console.log(`  Contexte max        : \x1b[1;33m${contextLimitTokens} tokens\x1b[0m\n`);

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
    return;
  }

  let globalReport = `# Rapport d'Évaluation V3\n\n`;
  globalReport += `**Date :** ${new Date().toLocaleString('fr-FR')}\n`;
  globalReport += `**Log :** ${path.basename(logger.getFilePath())}\n`;
  globalReport += `**Profil :** ${profile.label}\n\n---\n\n`;

  let modelName = "Modele_En_Attente";
  let globalScore = { passed: 0, total: 0, mandatoryPassed: 0, mandatoryTotal: 0 };
  let globalHelpCount = 0;
  let globalRetriedCount = 0;
  // Le rattrapage est désactivé en mode cloud (coût par appel API)
  const rattrapageEnabled = !isCloudMode && isRattrapageEligibleProfile(profileArg);

  if (rattrapageEnabled) {
    logger.info(`Mode rattrapage activé pour le profil ${profileArg}.`);
    console.log(`  \x1b[36mMode rattrapage actif : une seconde tentative est proposée en cas d'échec de tier.\x1b[0m\n`);
  }

  let stopGlobalEval = false;
  let gameState = { globalLifeScore: 0 };
  let tierScorecard = [];
  const ecoleLabel = PROFILES[profileArg]?.ecole || profileArg;

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
        providerConfig: isCloudMode ? { provider, model: cloudModel, apiKey, endpoint } : null,
        gameState
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
      annotations: bestResult.tierAnnotations || []
    });
    globalHelpCount += bestResult.helpUsedCount || 0;
    globalRetriedCount += bestResult.retriedCount || 0;
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

  console.log('\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m');
  console.log(`\x1b[36m\u2551  SCORE GLOBAL (Points) : ${globalScore.passed}/${globalScore.total} (${pctGlobal}%)                    \x1b[0m`);
  console.log(`\x1b[36m\u2551  SCORE OBLIGATOIRE    : ${mandatoryScoreStr.padEnd(25)} \x1b[0m`);
  console.log(`\x1b[36m\u2551  NOTE GLOBALE         : ${globalGradeInfo.color}\x1b[1m\u2588\u2588 ${globalGradeInfo.grade.padEnd(3)} \u2588\u2588\x1b[0m\x1b[36m                          \x1b[0m`);
  console.log(`\x1b[36m\u2551  NOTE OBLIGATOIRE     : ${mandatoryGradeInfo.color}\x1b[1m\u2588\u2588 ${mandatoryGradeInfo.grade.padEnd(3)} \u2588\u2588\x1b[0m\x1b[36m                          \x1b[0m`);

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

  // Gamification Niveau 3 : Grosse Recompense d'Ecole
  if (pctGlobal >= 100) {
    const recompense = `Diplôme de l'école ${PROFILES[profileArg]?.ecole || profileArg} décerné au modèle avec les honneurs !`;
    console.log(`\x1b[36m\u2551  \x1b[35m\u2588\u2588\u2588 TROPHÉE OBTENU : ${recompense} \u2588\u2588\u2588\x1b[0m\x1b[36m \u2551\x1b[0m`);
    globalReport += `\n> **🏆 Trophée Majeur :** ${recompense}\n`;
  }

  console.log('\x1b[36m\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1b[0m\n');

  globalReport += `\n---\n\n## Score Global\n\n`;
  globalReport += `| Métrique | Valeur | Note |\n|---|---|---|\n`;
  globalReport += `| Score global | ${globalScore.passed}/${globalScore.total} (${pctGlobal}%) | ${globalGradeInfo.grade} |\n`;
  globalReport += `| Score obligatoire | ${mandatoryScoreStr} | ${mandatoryGradeInfo.grade} |\n`;
  globalReport += `| Verdict | ${verdictPct >= 80 ? 'RECOMMANDÉ' : verdictPct >= 50 ? 'PARTIEL' : 'NON RECOMMANDÉ'} | ${hasMandatory ? mandatoryGradeInfo.grade : globalGradeInfo.grade} |\n`;

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

  // Classification : Export-Rapports/<AAAA-MM-JJ>/<ÉCOLE>/<CLASSE?>/<fichier>
  // Le nom du fichier porte l'heure (HH-MM-SS) pour distinguer plusieurs runs
  // d'une même journée et faire le lien avec le fichier de log associé.
  const ecole = (PROFILES[profileArg] && PROFILES[profileArg].ecole) || profileArg;
  const exportDir = path.join(__dirname, 'Export-Rapports');
  const dateDir = path.join(exportDir, dateStr);
  const ecoleDir = path.join(dateDir, ecole);

  let targetDir = ecoleDir;
  if (tierArg && tierArg !== "all") {
    const tierNum = parseInt(tierArg);
    const classeLabel = (CLASSE_NAMES[profileArg] && CLASSE_NAMES[profileArg][tierNum]) || `Classe-${tierNum}`;
    targetDir = path.join(ecoleDir, classeLabel);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, filename);
  fs.writeFileSync(outputPath, globalReport, 'utf8');
  const relPath = path.relative(__dirname, outputPath);
  const logRelPath = path.relative(__dirname, logger.getFilePath());
  console.log(`  \x1b[32mRapport sauvegardé : ${relPath}\x1b[0m`);
  console.log(`  \x1b[90mFichier de log    : ${logRelPath}\x1b[0m\n`);

  logger.info(`Benchmark terminé. Score global : ${globalScore.passed}/${globalScore.total} (${pctGlobal}%). Score obligatoire : ${globalScore.mandatoryPassed}/${globalScore.mandatoryTotal} (${pctMandatory}%).`);
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
