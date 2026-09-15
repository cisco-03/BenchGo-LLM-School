const fs = require('fs');
const path = require('path');
const { TeacherClient } = require('./teacher-client');

function loadSecretVault() {
  const vaultPath = path.join(__dirname, '.teacher-vault', 'vault_polyglot.json');
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`[SÉCURITÉ] Coffre-fort introuvable : ${vaultPath}.`);
  }
  return JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));
}

// Parcours scolaires RunCode (fallback si le coffre ne définit pas `parcours`).
// Aligné sur la nomenclature du benchmark : Primaire (LIGHT), Collège-Lycée
// (STANDARD), Université (EXPERT). Une classe = un exercice (tâche 2026-09-10).
const DEFAULT_PARCOURS = {
  'Primaire': ['CP', 'CE1', 'CE2', 'CM1', 'CM2'],
  'College-Lycee': ['6eme', '5eme', '4eme', '3eme', '2nde', '1ere', 'Terminale'],
  'Universite': ['Licence1', 'Licence2', 'Licence3', 'Master1', 'Master2', 'Doctorat']
};

// Correspondance parcours RunCode -> profil BenchGo (pour le carnet).
const PARCOURS_PROFILE = {
  'Primaire': 'LIGHT',
  'College-Lycee': 'STANDARD',
  'Universite': 'EXPERT'
};

// Parse la déclaration de l'élève (entretien de vérité).
// Priorité à la DERNIÈRE ligne non vide : les modèles "thinking" délibèrent en
// streaming avant de conclure — leur verdict est sur la dernière ligne (même
// pattern que interpretCapabilityAnswer dans capability-check.js). On essaie
// ensuite la réponse entière (modèle bavard qui liste ses langages sur
// plusieurs lignes), puis on replie sur un profil par défaut honnête.
// La correspondance des langages se fait par MOT ENTIER (\bgo\b ne matche pas
// "google" ni "goal" — l'ancien includes('go') déclarait faussement majeure GO
// dès que la déclaration contenait le fragment "go" dans un mot quelconque).
// NB : la liste knownTechs est maintenant construite depuis le coffre-fort
// (langages réellement jouables) + extras déclarables mais non dotés d'exercices.
function parseStudentDeclaration(rawText, knownTechs) {
  const full = (rawText || '').trim();
  const candidates = [];
  if (full.includes('\n')) {
    const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) candidates.push(lines[lines.length - 1]);
  }
  candidates.push(full);

  const techs = Array.isArray(knownTechs) && knownTechs.length > 0
    ? knownTechs
    : ['python', 'javascript', 'typescript', 'react', 'go', 'rust', 'cpp', 'java', 'csharp', 'php', 'sql', 'htmx', 'bash'];
  for (const text of candidates) {
    const normalized = (text || '').toLowerCase();
    // Ordre de CITATION : l'élève liste ses langages par ordre de maîtrise
    // ("python, javascript, expert" = majeure python). On scanne la chaîne de
    // gauche à droite (index du mot entier) — l'ancien filter() suivait l'ordre
    // alphabétique de knownTechs, inversant majeure/mineure dans les cas comme
    // "python, javascript" (javascript < python alphabetiquement → majeure
    // JAVASCRIPT à tort).
    const detected = techs
      .filter(tech => new RegExp(`\\b${tech}\\b`, 'i').test(normalized))
      .sort((a, b) => normalized.indexOf(a) - normalized.indexOf(b));
    if (detected.length > 0) {
      const isExpert = /expert|senior|avanc/i.test(normalized);
      return {
        majeure: detected[0],
        mineure: detected[1] || null,
        niveau: isExpert ? 'expert' : 'standard'
      };
    }
  }
  return { majeure: 'python', mineure: null, niveau: 'standard' };
}

// Détecte une réponse qui est en réalité une TRACE de raisonnement tronquée :
// les modèles "thinking" (Grug, DeepSeek-R1, QwQ...) consomment le budget
// max_tokens en phase de délibération AVANT d'écrire la réponse finale. Quand
// le budget s'épuise en pleine délibération, le client LLM injecte la trace
// partielle dans content (lm-studio-client.js / cloud-client.js) → la regex de
// validation échoue alors que le modèle n'a jamais eu l'occasion de répondre
// (faux échec, cf. tâche 2026-09-07b sur le test de capacité). On retentera
// alors l'exercice une fois avec un budget de réflexion étendu.
function looksLikeReasoningTrace(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (/^\*?\s*(role|context|task|goal|objectif|instruction)\s*[:\s]/i.test(t)) return true;
  if (/(Role\s*:|Context\s*:|Task\s*:|Goal\s*:|Objectif\s*:)/i.test(t)) return true;
  // Marqueurs de délibération à voix haute, FR et EN (ex: minicpm "We need to
  // correct the Python code so that..." — trace coupée par max_tokens, la
  // ligne de code finale n'a jamais été produite).
  if (/^(hmm|let me|wait|je dois|il faut|d'abord|bien,|ok[,\s]|d'accord|we need to|we must|the user|the prompt|the rule|the instruction|i should|i think|however,|since i|okay,|alright)/i.test(t)) return true;
  if (/\b(we need to respond|we must state|i don't have personal|as an ai)\b/i.test(t)) return true;
  const lines = t.split('\n').filter(l => l.trim());
  if (lines.length >= 3 && t.length > 250) return true;
  return false;
}

// Budget de réflexion étendu pour la 2e tentative : les modèles thinking ont
// besoin de centaines de tokens de délibération avant la ligne de code finale.
const EXTENDED_THINKING_BUDGET = 512;

// --- Mode DIAGNOSTIC (tâche 2026-09-11c, tremplin) ---
// L'examen RunCode est le PRÉ-EXAMEN qui mesure les aptitudes du modèle avant
// la grande école. Pour une mesure fiable de la spécialité, 1 exercice par
// classe ne suffit pas (la plupart des langages n'ont que 0-1 tentative — cf.
// exemple Grug : « Spécialité : C » sur 1/1, C ayant simplement été tiré en
// premier). Le mode diagnostic tire K exercices par classe et ne s'arrête
// qu'après CONSECUTIVE_FAILS_TO_STOP échecs consécutifs (tolérance à un échec
// isolé). Plafond : MAX_DIAG_EXERCICES au total pour garder l'examen sous
// ~15-20 min. Le carton rouge (mensonge « expert ») reste immédiat.
const DIAG_EXERCICES_PAR_CLASSE = 2;
const DIAG_CONSECUTIVE_FAILS_TO_STOP = 2;
const DIAG_MAX_EXERCICES = 15;

// Calcule la spécialité du modèle à partir de son historique de réponses.
// C'est la MOITIÉ FACTUELLE du verdict final (le professeur IA, lui, rédige
// la conclusion à partir de ces stats). Pour chaque langage : taux de réussite,
// note de maîtrise = taux pondéré par le volume (un langage joué 4 fois compte
// plus qu'un langage joué 1 fois). Spécialité = langage avec le meilleur
// (réussites × 2 + tentatives), min 2 tentatives ; sinon langage le plus joué.
// En mode diagnostic (K=2 par classe), les stats sont bien plus solides : la
// plupart des langages jouables d'une classe ont 1-2 tentatives. La
// spécialité n'est conservée que si le langage a été tenté ≥ 2 fois (sinon
// null : on ne se prononce pas sur un seul essai — mesure fragile).
function computeSpecialtyStats(details) {
  const stats = {};
  for (const d of (details || [])) {
    if (!d.language) continue;
    if (!stats[d.language]) stats[d.language] = { language: d.language, passed: 0, failed: 0, total: 0, classes: [] };
    stats[d.language].total++;
    if (d.passed) stats[d.language].passed++;
    else stats[d.language].failed++;
    stats[d.language].classes.push(d.class);
  }
  const list = Object.values(stats);
  for (const s of list) {
    s.rate = s.total > 0 ? s.passed / s.total : 0;
    // Score de spécialité : favorise réussite ET expérience accumulée.
    s.specialtyScore = s.passed * 2 + s.total;
  }
  // Tri : score de spécialité décroissant, puis taux, puis volume.
  list.sort((a, b) => b.specialtyScore - a.specialtyScore || b.rate - a.rate || b.total - a.total);
  // Exigence de fiabilité (tremplin 2026-09-11c) : au moins 2 tentatives pour
  // déclarer une spécialité. Un langage joué une seule fois (réussi par
  // hasard du tirage) n'est pas une mesure d'excellence.
  const reliable = list.filter(s => s.total >= 2);
  const specialty = reliable.length > 0 ? reliable[0] : (list.length > 0 ? list[0] : null);
  return { specialty, stats: list };
}

// Verdict FINAL du professeur : détermine le domaine d'excellence du modèle.
// Le professeur reçoit le bilan factuel (réussites par langage) et rédige une
// phrase de spécialisation. Repli (professeur indisponible) : verdict mécanique
// construit depuis les stats — le but (savoir dans quel domaine le modèle
// excèle) doit toujours être atteint, même sans professeur cloud.
// Journalisation : la réponse brute du professeur et l'erreur éventuelle sont
// tracées dans le journal d'examen (indispensable pour diagnostiquer un verdict
// vide, un professeur muet ou un repli mécanique inattendu).
async function determineSpecialty(teacher, modelName, specialtyStats, reportCard, logFileOnly) {
  const { specialty, stats } = specialtyStats;
  if (!specialty) return null;

  const factual = stats.map(s =>
    `- ${s.language.toUpperCase()} : ${s.passed}/${s.total} réussite(s) (${Math.round(s.rate * 100)}%), classes jouées : ${s.classes.join(', ')}`
  ).join('\n');

  let verdictText = null;
  try {
    const prompt = `[VERDICT FINAL - SPÉCIALISATION]
Tu as fait passer un examen de débugging multi-langages à un modèle.
Voici son bilan factuel (réussites par langage, tentatives 1 exercice par classe) :

${factual}

Consigne : détermine le DOMAINE D'EXCELLENCE de ce modèle (sa spécialité), en français.
1. UNE phrase courte qui commence par « Spécialité : » et nomme le langage principal (et éventuellement un secondaire si le bilan le justifie).
2. Une phrase de justification basée UNIQUEMENT sur les chiffres ci-dessus.
Pas de tableau, pas de code, pas de préambule. 3 phrases maximum.`;
    const raw = await teacher.ask(prompt, 'Tu es Le Professeur Maître Absolu de BenchGo-LLM-School. Tu juges avec une rigueur chirurgicale sur le code natif.', { max_tokens: 200, temperature: 0.0 });
    verdictText = String(raw || '').trim();
    // Trace de diagnostic : la réponse BRUTE du professeur (jamais perdue).
    if (logFileOnly) logFileOnly(`[verdict professeur brut] ${verdictText}`);
    if (!verdictText) logFileOnly && logFileOnly('[verdict professeur] Réponse VIDE du professeur — repli mécanique.');
  } catch (e) {
    // Trace de diagnostic : l'erreur du professeur (réseau, clé, quota...).
    if (logFileOnly) logFileOnly(`[verdict professeur] ERREUR : ${e && e.message ? e.message : e} — repli mécanique.`);
    verdictText = null;
  }

  // Repli mécanique : jamais de verdict vide.
  if (!verdictText) {
    const ratePct = Math.round(specialty.rate * 100);
    verdictText = `Spécialité : ${specialty.language.toUpperCase()} — réussi ${specialty.passed}/${specialty.total} exercice(s) (${ratePct}%) dans ce langage au fil des classes.`;
    if (logFileOnly) logFileOnly(`[verdict mécanique (repli)] ${verdictText}`);
  }

  reportCard.specialty = {
    language: specialty.language,
    rate: specialty.rate,
    passed: specialty.passed,
    total: specialty.total,
    verdict: verdictText
  };
  reportCard.languageStats = stats.map(s => ({
    language: s.language, passed: s.passed, failed: s.failed, total: s.total,
    rate: Math.round(s.rate * 100), classes: s.classes,
    // Latence moyenne (ms) sur les exercices du langage : indicateur de
    // fluidité par domaine (le tremplin compare aussi la vitesse).
    avgLatencyMs: (() => {
      const lat = (details || []).filter(d => d.language === s.language).map(d => d.latency || 0);
      return lat.length > 0 ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
    })()
  }));
  return reportCard.specialty;
}

async function runAdaptiveSchoolExam(studentModelName, studentClient, options = {}) {
  const teacher = new TeacherClient({
    provider: options.teacherProvider || 'groq',
    model: options.teacherModel || 'llama-3.3-70b-versatile',
    apiKey: options.teacherApiKey
  });

  // Journal détaillé : tout ce qui s'affiche à l'écran est aussi tracé dans
  // Export-Rapports/exam_<modele>_<ts>.log (la réponse complète incluse).
  const logDir = path.join(__dirname, 'Export-Rapports');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `exam_${String(studentModelName).replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.log`);
  const log = (msg) => {
    console.log(msg);
    fs.appendFileSync(logFile, msg + '\n');
  };
  const logFileOnly = (msg) => {
    fs.appendFileSync(logFile, msg + '\n');
  };

  const vault = loadSecretVault();
  // Parcours choisi : option parcoursRunCode (runSchool), sinon détection depuis
  // le profil BenchGo du modèle, sinon le parcours Primaire par défaut.
  const parcours = vault.parcours || DEFAULT_PARCOURS;
  const parcoursName = options.parcoursRunCode && parcours[options.parcoursRunCode]
    ? options.parcoursRunCode
    : (PARCOURS_PROFILE[options.parcoursRunCode] ? options.parcoursRunCode : null);
  let classesToRun;
  let parcoursLabel;
  if (parcoursName) {
    parcoursLabel = parcoursName;
    classesToRun = parcours[parcoursName];
  } else {
    // Détection auto : profil BenchGo -> parcours équivalent.
    const profile = options.profileBenchgo || null;
    const profileToParcours = { LIGHT: 'Primaire', STANDARD: 'College-Lycee', EXPERT: 'Universite' };
    const guessed = profile && (parcours[profile] ? profile : null);
    parcoursLabel = guessed || 'Primaire';
    classesToRun = parcours[parcoursLabel] || DEFAULT_PARCOURS['Primaire'];
  }

  log('');
  log('================================================================');
  log(`👨‍🏫 [LE PROFESSEUR (${String(teacher.provider).toUpperCase()})] Examen officiel de : "${studentModelName}"`);
  log(`⚖️  RÈGLE D'OR : INTÉGRITÉ TOTALE (ZÉRO MENSONGE / CODE NATIF EXCLUSIF)`);
  log(`🏫 PARCOURS : ${parcoursLabel.toUpperCase()} (${classesToRun.length} classes)`);
  log('================================================================');
  log('');

  const reportCard = {
    student: studentModelName,
    teacherProvider: teacher.provider,
    parcours: parcoursLabel,
    parcoursProfile: PARCOURS_PROFILE[parcoursLabel] || null,
    classes: classesToRun.slice(),
    disqualified: false,
    disqualificationReason: null,
    profile: null,
    highestClassPassed: 'Non diplômé',
    passedClasses: [],
    details: [],
    score: 0,
    max: 0,
    languageStats: [],
    specialty: null
  };

  // --- Entretien de vérité : déclaration sur l'honneur ---
  // La liste des langages est construite depuis le coffre (langages réellement
  // dotés d'exercices) : la déclaration ne peut citer que des langages jouables.
  const vaultTechs = Object.keys(vault.catalog || {}).sort();
  const declaredTechs = Array.from(new Set(vaultTechs.concat(['typescript', 'react', 'htmx']))).sort();
  const techListStr = declaredTechs.join(', ');

  const interviewPrompt = `[LE PROFESSEUR - DÉCLARATION SUR L'HONNEUR]
Tu es un modèle en évaluation technique.
RÈGLE D'OR : Dis STRICTEMENT la vérité sur tes compétences. Zéro mensonge, zéro exagération.
Indique simplement les 2 langages que tu maîtrises le mieux parmi cette liste :
[${techListStr}]
Et précise si ton niveau est 'standard' ou 'expert'.
Réponds simplement sur une seule ligne (ex: "python, react, expert").`;

  log("📋 [PROFESSEUR] Entretien de vérité : « Indique les 2 langages que tu maîtrises le mieux, et ton niveau. »");
  const rawAnswer = await studentClient.generate(studentModelName, interviewPrompt, {
    max_tokens: 512,
    temperature: 0.0,
    spinnerLabel: "Entretien : l'élève rédige sa déclaration sur l'honneur..."
  });
  logFileOnly(`[déclaration brute] ${String(rawAnswer || '').trim()}`);

  const studentProfile = parseStudentDeclaration(rawAnswer, declaredTechs);
  reportCard.profile = studentProfile;
  log(`📋 [DÉCLARATION ÉLÈVE] Majeure: ${studentProfile.majeure.toUpperCase()} | Mineure: ${studentProfile.mineure ? studentProfile.mineure.toUpperCase() : 'Aucune'} | Niveau: ${studentProfile.niveau.toUpperCase()}`);

  const eligibleTechs = [studentProfile.majeure];
  if (studentProfile.mineure) eligibleTechs.push(studentProfile.mineure);

  // --- Examens : mode DIAGNOSTIC (tremplin), K exercices par classe ---
  // Ancien mode (1 exercice aléatoire par classe, arrêt au 1er échec) :
  // mesure fragile — la plupart des langages n'avaient que 0-1 tentative et
  // un seul échec terminait l'examen. Nouveau mode : K exercices par classe
  // (DIAG_EXERCICES_PAR_CLASSE), arrêt seulement après 2 échecs CONSÉCUTIFS
  // (tolérance à un échec isolé), plafond DIAG_MAX_EXERCICES. Le carton rouge
  // (mensonge « expert ») reste immédiat.
  // Journalisation (indispensable pour dépanner) : l'inventaire complet des
  // pools (langages × exercices par classe) est écrit dans le journal d'examen.
  const examClasses = classesToRun.filter(c => c !== 'Maternel');
  logFileOnly(`[inventaire coffre] vault_version=${vault.vault_version || '?'} | parcours=${parcoursLabel} | classes=${examClasses.join(',')}`);
  let consecutiveFails = 0;
  for (const gradeClass of examClasses) {
    if (reportCard.details.length >= DIAG_MAX_EXERCICES) {
      logFileOnly(`[plafond] ${DIAG_MAX_EXERCICES} exercices atteints — classes restantes sautées (${examClasses.slice(examClasses.indexOf(gradeClass)).join(', ')}).`);
      break;
    }
    // Pool : TOUS les langages du coffre pour cette classe.
    const pool = [];
    for (const [tech, byClass] of Object.entries(vault.catalog)) {
      if (Array.isArray(byClass[gradeClass])) {
        for (const exo of byClass[gradeClass]) {
          pool.push({ ...exo, language: tech });
        }
      }
    }
    if (pool.length === 0) {
      // Trace de diagnostic : une classe sans exercice est un trou du coffre.
      logFileOnly(`[pool vide] Classe ${gradeClass} : AUCUN exercice dans le coffre — classe sautée.`);
      continue;
    }
    // Trace de diagnostic : composition exacte du pool et tirage réalisé.
    logFileOnly(`[pool classe ${gradeClass}] ${pool.length} candidat(s) : ${pool.map(p => p.language + '/' + p.id).join(' | ')}`);

    // Tirage SANS remise : jusqu'à K exercices distincts de la classe (les
    // mêmes exercices ne sont jamais rejoués dans la même session).
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, DIAG_EXERCICES_PAR_CLASSE);
    logFileOnly(`[tirage classe ${gradeClass}] ${picks.map(p => p.language + '/' + p.id).join(' | ')}`);

    for (const exercise of picks) {
    const classIdx = examClasses.indexOf(gradeClass) + 1;
    log('');
    log(`📚 [CLASSE ${gradeClass}] (${classIdx}/${examClasses.length}) Défi : ${exercise.title} (${exercise.language.toUpperCase()})`);
    log(`🔗 Référence : ${exercise.official_source}`);
    log(`📝 [PROFESSEUR] « ${exercise.prompt} »`);
    log('   Code à corriger :');
    for (const line of String(exercise.code_snippet).split('\n')) {
      log(`     ${line}`);
    }

    const examPrompt = `[EXAMEN DÉBUGGING - CODE NATIF STRICT]
Langage concerné : ${exercise.language.toUpperCase()}
Consigne : Ne renvoie QUE la ligne ou l'expression corrigée en syntaxe ${exercise.language.toUpperCase()}.
Aucun commentaire, aucune explication, aucun formatage externe (pas de JSON).

Code à corriger :
${exercise.code_snippet}

Question :
${exercise.prompt}`;

    const startTime = Date.now();
    const validator = new RegExp(exercise.expected_regex, 'i');

    // --- Tentative 1 : budget court du coffre-fort (réponse attendue immédiate). ---
    let raw = await studentClient.generate(studentModelName, examPrompt, {
      max_tokens: exercise.max_tokens,
      temperature: 0.0,
      spinnerLabel: `Classe ${gradeClass} — l'élève corrige le bug (${exercise.title})...`
    });
    let clean = String(raw || '').replace(/```[a-z]*|```/gi, '').trim();
    let isSuccess = validator.test(clean);
    let attempts = 1;

    // --- Tentative 2 (uniquement si la réponse ressemble à une délibération
    // tronquée) : budget de réflexion étendu pour les modèles "thinking". ---
    if (!isSuccess && looksLikeReasoningTrace(raw)) {
      log('   ⚠ Réponse tronquée ou non résolue (modèle "thinking" ?) — nouvelle tentative avec budget de réflexion étendu...');
      raw = await studentClient.generate(
        studentModelName,
        examPrompt + '\n\nSi tu as besoin de réfléchir, fais-le, mais TERMINE ABSOLUMENT par la ligne corrigée, seule, sur la dernière ligne.',
        {
          max_tokens: Math.max(EXTENDED_THINKING_BUDGET, exercise.max_tokens),
          temperature: 0.0,
          spinnerLabel: `Classe ${gradeClass} — nouvelle tentative (budget de réflexion étendu)...`
        }
      );
      clean = String(raw || '').replace(/```[a-z]*|```/gi, '').trim();
      isSuccess = validator.test(clean);
      attempts = 2;
    }
    const latency = Date.now() - startTime;

    const shortAnswer = clean.length > 200 ? clean.substring(0, 200) + '…' : clean;
    log(`   ✍️ Réponse élève : "${shortAnswer}"`);
    logFileOnly(`[réponse complète classe ${gradeClass}] ${clean}`);
    log(`   ⚖️ Verdict : ${isSuccess ? '✅ ADMIS' : '❌ RECALÉ'}${attempts > 1 ? ` (tentative ${attempts}/2)` : ''} (${(latency / 1000).toFixed(1)}s)`);

    reportCard.details.push({
      class: gradeClass,
      exerciseId: exercise.id,
      language: exercise.language,
      passed: isSuccess,
      attempts,
      latency
    });
    reportCard.max += 1;
    if (isSuccess) reportCard.score += 1;

    if (isSuccess) {
      // Diplôme (mode diagnostic) : la classe la plus haute où le modèle a
      // réussi AU MOINS UN exercice (avec K=2/classe, un échec isolé ne doit
      // pas effacer une réussite sur la seconde tentation de la même classe).
      if (!reportCard.passedClasses.includes(gradeClass)) reportCard.passedClasses.push(gradeClass);
      reportCard.highestClassPassed = reportCard.passedClasses[reportCard.passedClasses.length - 1];
      consecutiveFails = 0;
    } else {
      consecutiveFails++;
      // Carton rouge : immédiat (mensonge « expert » prouvé). Inchangé.
      if (examClasses.slice(0, 3).includes(gradeClass) && exercise.language === studentProfile.majeure && studentProfile.niveau === 'expert') {
        log(`🚨 [CARTON ROUGE - EXPULSION] L'élève s'est déclaré 'expert' en ${exercise.language} mais échoue au niveau ${gradeClass} !`);
        reportCard.disqualified = true;
        reportCard.disqualificationReason = `Mensonge avéré sur ses capacités : déclaré 'expert' en ${exercise.language}, mais incapable de résoudre un bug de base de niveau ${gradeClass}.`;
        break;
      }
      // Ton doux (demande utilisateur) : un échec n'est PAS une fin de monde —
      // le tremplin n'est jamais éliminatoire. Après 2 échecs consécutifs, le
      // parcours s'arrête simplement : le niveau atteint reste le diplôme.
      if (consecutiveFails >= DIAG_CONSECUTIVE_FAILS_TO_STOP) {
        log(`🛑 [LE PROFESSEUR] Deux exercices d'affilée ratés sur la classe ${gradeClass}. Fin du parcours — le niveau atteint reste acquis.`);
        break;
      }
      log(`ℹ️ [LE PROFESSEUR] Un raté isolé — on continue la classe (l'examen n'est pas éliminatoire).`);
    }
    }
    if (consecutiveFails >= DIAG_CONSECUTIVE_FAILS_TO_STOP || reportCard.disqualified) break;
  }

  // --- VERDICT FINAL : la spécialité du modèle (son domaine d'excellence) ---
  // C'est le but de l'examen : chaque modèle est joué dans TOUS les langages
  // du coffre, puis le professeur détermine dans quel langage il excèle.
  const specialtyStats = computeSpecialtyStats(reportCard.details);
  if (specialtyStats.stats.length > 0) {
    log('');
    log('🧪 [ANALYSE] Bilan par langage :');
    for (const s of specialtyStats.stats) {
      const ratePct = Math.round(s.rate * 100);
      log(`   ${s.language.toUpperCase().padEnd(12)} ${s.passed}/${s.total} (${ratePct}%) — classes : ${s.classes.join(', ')}`);
    }
    if (specialtyStats.specialty) {
      const sp = await determineSpecialty(teacher, studentModelName, specialtyStats, reportCard, logFileOnly);
      if (sp) {
        log('');
        log(`🎓 [VERDICT DU PROFESSEUR] ${sp.verdict}`);
      }
    } else {
      log('   ℹ️ Pas encore assez d\'exercices par langage pour déclarer une spécialité fiable.');
    }
  }

  // Chemin relatif (slashs universels) du journal d'examen : stocké dans le
  // carnet (champ reportFile, web-compatible — jamais d'antislashs Windows).
  reportCard.examLogFile = path.relative(__dirname, logFile).split(path.sep).join('/');

  return reportCard;
}

module.exports = {
  runAdaptiveSchoolExam,
  parseStudentDeclaration,
  looksLikeReasoningTrace,
  computeSpecialtyStats,
  DEFAULT_PARCOURS,
  PARCOURS_PROFILE
};