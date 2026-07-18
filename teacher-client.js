const logger = require('./logger');
const { TEACHER_CONFIG } = require('./config');

// --- Professeur IA (correcteur indépendant) — Free Router ---
// Le professeur est un modèle cloud distinct de l'élève testé. Après un échec
// définitif, l'élève produit une auto-analyse de la cause racine. Le professeur
// la RELIT, identifie ce qui est juste et ce qui est FAUX, puis DÉMONTRE la vraie
// cause racine. Objectif : éviter qu'un modèle faible se valide lui-même ou
// embarre l'utilisateur dans une explication erronée.
//
// Free Router : OpenRouter expose `/api/v1/models` (PUBLIC, sans clé) qui liste
// tous les modèles avec leur pricing. Les modèles gratuits ont
// pricing.prompt === "0" et pricing.completion === "0". On récupère cette liste,
// on la trie par qualité (contexte décroissant, id alphabétique pour la stabilité),
// puis on ROTATE à travers les meilleurs jusqu'à en trouver un qui répond.
// Les modèles gratuits ont des limites de débit strictes : si l'un rate (429/4xx),
// on passe au suivant. La clé API reste OBLIGATOIRE pour appeler /chat/completions,
// même sur les modèles gratuits — c'est la politique d'OpenRouter.

const TEACHER_SYSTEM_PROMPT =
  "Vous êtes un professeur de programmation JavaScript expérimenté et bienveillant mais rigoureux. " +
  "Vous corrigez l'analyse d'un élève qui vient d'échouer à un exercice. " +
  "Vous parlez français. Vous êtes précis, technique, et vous ne flattez pas l'élève : " +
  "s'il se trompe dans son diagnostic, vous le lui dites clairement et vous démontrez la VRAIE cause. " +
  "Répondez de façon concise (2 à 5 phrases), sans bloc de code sauf si strictement nécessaire.";

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Cache en mémoire des modèles gratuits (évite de rappeler /models à chaque échec)
let _freeModelsCache = null;
let _freeModelsCacheAt = 0;
const FREE_MODELS_TTL_MS = 30 * 60 * 1000; // 30 min

// Liste noire de modèles gratuits connus pour être peu fiables ou mal adaptés
// à une tâche de correction technique en français.
const FREE_MODELS_DENYLIST = new Set([
  // vision-only, audio, image — inutilisables pour du texte
  'openai/chatgpt-4o-2024-08-06:free', // très limité en débit
]);

// Préférence : modèles connus robustes en français + raisonnement technique.
// Si présents dans la liste free, on les met en tête avant le tri générique.
const FREE_MODELS_PREFERRED = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'mistralai/mistral-7b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free'
];

/**
 * Récupère la liste des modèles gratuits d'OpenRouter (endpoint public, sans clé).
 * Retourne un tableau d'ids triés : préférences d'abord, puis par contexte décroissant.
 * Retourne [] si l'endpoint est injoignable.
 */
async function fetchFreeModels() {
  if (_freeModelsCache && (Date.now() - _freeModelsCacheAt) < FREE_MODELS_TTL_MS) {
    return _freeModelsCache;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      logger.warn(`Teacher: /models a répondu HTTP_${res.status} — cache vide.`);
      return [];
    }
    const data = await res.json();
    const all = Array.isArray(data?.data) ? data.data : [];
    // Un modèle est gratuit si prompt ET completion sont à "0".
    const free = all
      .filter(m => m?.id && m?.pricing?.prompt === '0' && m?.pricing?.completion === '0')
      .filter(m => !FREE_MODELS_DENYLIST.has(m.id))
      .map(m => ({
        id: m.id,
        context: m.context_length || m.top_provider?.context_length || 0
      }));
    // Tri : préférences d'abord (ordre conservé), puis par contexte décroissant.
    free.sort((a, b) => {
      const ai = FREE_MODELS_PREFERRED.indexOf(a.id);
      const bi = FREE_MODELS_PREFERRED.indexOf(b.id);
      const aPref = ai === -1 ? 999 : ai;
      const bPref = bi === -1 ? 999 : bi;
      if (aPref !== bPref) return aPref - bPref;
      return (b.context || 0) - (a.context || 0);
    });
    const result = free.map(m => m.id);
    _freeModelsCache = result;
    _freeModelsCacheAt = Date.now();
    logger.info(`Teacher: ${result.length} modèles gratuits disponibles (top: ${result.slice(0, 3).join(', ')})`);
    return result;
  } catch (e) {
    logger.warn(`Teacher: impossible de récupérer /models : ${e.message}`);
    return [];
  }
}

/**
 * Construit le prompt de correction envoyé au professeur.
 */
function buildTeacherPrompt({ task, errors, studentCode, studentAnalysis, tierNum }) {
  const codePreview = (studentCode || '').trim().substring(0, 1200);
  const errPreview = (errors || 'erreur inconnue').substring(0, 400);
  const analysisBlock = studentAnalysis && studentAnalysis.trim()
    ? `Voici l'analyse que l'élève a produite lui-même pour expliquer son échec :\n"""\n${studentAnalysis.trim().substring(0, 1200)}\n"""`
    : "L'élève n'a pas réussi à produire une auto-analyse.";

  return (
    `CONTEXTE : Un élève vient d'échouer définitivement à l'exercice ${task.id} ` +
    `(${task.label}) en classe de Tier ${tierNum}.\n\n` +
    `Le moteur d'évaluation (sandbox JavaScript) a renvoyé cette erreur technique :\n` +
    `"${errPreview}"\n\n` +
    `Voici le code que l'élève avait proposé :\n` +
    "```javascript\n" + codePreview + "\n```\n\n" +
    analysisBlock + "\n\n" +
    `VOTRE RÔLE : Vous êtes le PROFESSEUR. Relisez l'analyse de l'élève de façon critique.\n` +
    `1. Dites explicitement si son diagnostic est JUSTE, PARTIELLEMENT JUSTE ou FAUX.\n` +
    `2. S'il se trompe, DÉMONTREZ pourquoi (ne vous contentez pas de dire « tu as tort »).\n` +
    `3. Expliquez en 2 à 4 phrases la VRAIE cause racine de l'échec, en français clair.\n` +
    `N'inventez pas d'erreurs absentes du code. Ne récitez pas l'erreur brute. ` +
    `Soyez direct : l'objectif est que l'élève comprenne précisément ce qui n'allait pas.\n` +
    `Répondez UNIQUEMENT par votre correction, sans préambule.`
  );
}

/**
 * Tente UN appel chat/completions sur un modèle donné. Retourne le contenu ou null.
 * Lance une erreur portant le code HTTP si la requête échoue (pour décider du rotate).
 */
async function callOpenRouter({ model, apiKey, prompt, temperature, maxTokens }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  headers['HTTP-Referer'] = 'https://benchgo-v3';
  headers['X-Title'] = 'BenchGo V3 — Professeur';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TEACHER_SYSTEM_PROMPT },
          { role: 'user',   content: prompt }
        ],
        temperature: temperature ?? 0.15,
        max_tokens: maxTokens ?? 512,
        stream: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`HTTP_${res.status} — ${errText.substring(0, 200)}`);
      err.httpStatus = res.status;
      throw err;
    }
    const data = await res.json();
    const content = (data?.choices?.[0]?.message?.content || '').trim();
    if (!content) throw new Error('Réponse vide du professeur');
    return content.replace(/```[\s\S]*?```/g, '').trim() || content.trim();
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * Appelle le professeur (Free Router OpenRouter) pour qu'il corrige l'analyse de l'élève.
 * Non streamé. Récupère les modèles gratuits, rotate jusqu'à maxRetries modèles
 * distincts. Retourne le texte de correction ou null (repli sur auto-analyse).
 *
 * @param {object} args
 * @param {object} args.teacherConfig - config résolue { enabled, provider, model, apiKey, endpoint, maxRetries, temperature, maxTokens }
 * @param {object} args.task
 * @param {string} args.errors
 * @param {string} args.studentCode
 * @param {string} args.studentAnalysis
 * @param {number} args.tierNum
 */
async function askTeacherToCorrectStudentAnalysis({ teacherConfig, task, errors, studentCode, studentAnalysis, tierNum }) {
  if (!teacherConfig || !teacherConfig.enabled) return null;
  if (!teacherConfig.apiKey) {
    logger.warn('Teacher: aucune clé OpenRouter — professeur désactivé, repli sur auto-analyse.');
    return null;
  }

  // Construit la liste des modèles à essayer.
  // 1. Modèle explicite de teacherConfig.model (si override --teacher-model)
  // 2. Puis modèles gratuits récupérés dynamiquement (Free Router)
  let candidates = [];
  if (teacherConfig.model) candidates.push(teacherConfig.model);
  try {
    const free = await fetchFreeModels();
    for (const id of free) {
      if (!candidates.includes(id)) candidates.push(id);
    }
  } catch (e) {
    logger.warn(`Teacher: Free Router indisponible (${e.message}) — seul le modèle par défaut sera essayé.`);
  }
  if (candidates.length === 0) {
    logger.warn('Teacher: aucune liste de modèles disponible.');
    return null;
  }

  const prompt = buildTeacherPrompt({ task, errors, studentCode, studentAnalysis, tierNum });
  const maxAttempts = Math.min(candidates.length, Math.max(1, teacherConfig.maxRetries || 3));

  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const model = candidates[i];
    try {
      logger.info(`Teacher: essai ${i + 1}/${maxAttempts} avec ${model}`);
      const content = await callOpenRouter({
        model,
        apiKey: teacherConfig.apiKey,
        prompt,
        temperature: teacherConfig.temperature,
        maxTokens: teacherConfig.maxTokens
      });
      if (content) {
        logger.info(`Teacher: ${model} a répondu (${content.length} chars).`);
        return { content, model };
      }
    } catch (e) {
      lastError = e.message;
      logger.warn(`Teacher: ${model} a échoué : ${lastError}`);
      // 429 (rate limit) ou 5xx → on rotate vers le modèle suivant.
      // 401/403 (clé invalide) → pas la peine de rotate, on sort.
      if (e.httpStatus === 401 || e.httpStatus === 403) break;
      // Backoff léger avant le modèle suivant
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 800));
    }
  }
  logger.warn(`Teacher: tous les essais ont échoué. Dernier : ${lastError}`);
  return null;
}

module.exports = {
  askTeacherToCorrectStudentAnalysis,
  buildTeacherPrompt,
  fetchFreeModels,
  TEACHER_SYSTEM_PROMPT
};