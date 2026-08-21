const logger = require('./logger');
const { TEACHER_CONFIG } = require('./config');
const { BenchgoError } = require('./cli-help');
const { withRetry, isRetryableError } = require('./http-middleware');
const { CLOUD_PROVIDERS } = require('./cloud-client');

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

/**
 * Filtre de modality : ne garde que les modèles qui acceptent du texte en
 * entrée ET produisent du texte en sortie. Les modèles audio/image (ex:
 * google/lyria-3-*, qui émettent de l'audio) sont inutilisables pour une
 * correction de code et échouent systématiquement, même s'ils sont gratuits.
 */
function isTextInOutTextModel(m) {
  // architecture.input_modalities / output_modalities (format courant OpenRouter)
  const inMod = m?.architecture?.input_modalities || m?.architecture?.modality;
  const outMod = m?.architecture?.output_modalities;
  const modalityStr = m?.architecture?.modality || '';

  // Modality au format "text->text" : on accepte si l'entrée contient text
  // et la sortie est text. Les modality "text+image->text+audio" sont rejetées
  // car elles émettent de l'audio (inutilisable en chat/completions texte).
  if (typeof modalityStr === 'string' && modalityStr.includes('->')) {
    const [_in, out] = modalityStr.split('->');
    const hasTextInput = (_in || '').split('+').includes('text');
    const outputs = (out || '').split('+');
    const isTextOnlyOut = outputs.length === 1 && outputs[0] === 'text';
    return hasTextInput && isTextOnlyOut;
  }
  // Repli : tableaux input_modalities / output_modalities.
  const ins = Array.isArray(inMod) ? inMod : [];
  const outs = Array.isArray(outMod) ? outMod : [];
  const hasTextInput = ins.includes('text');
  const isTextOnlyOut = outs.length > 0 && outs.every(x => x === 'text');
  return hasTextInput && isTextOnlyOut;
}

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
      // Ne garder que les modèles texte->texte : les modèles audio/image
      // (ex: google/lyria-3-*) sont gratuits mais inutilisables pour une
      // correction de code et échouent à chaque appel.
      .filter(isTextInOutTextModel)
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
  const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  headers['HTTP-Referer'] = 'https://benchgo-v3';
  // X-Title doit être un ByteString (Latin-1) : pas d'em dash ni d'accent.
  // On utilise un tiret ASCII simple pour rester compatible avec fetch.
  headers['X-Title'] = 'BenchGo V3 - Professeur';

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
 * Appelle un provider cloud NON-OpenRouter pour la correction du professeur.
 * Supporte tous les providers de CLOUD_PROVIDERS (openai, groq, together, mistral,
 * anthropic, deepseek, cohere, ollama, lmstudio, custom). Non streamé, appel
 * simple chat/completions (ou Messages API pour Anthropic).
 *
 * Contrairement à OpenRouter, il n'y a pas de rotation de modèles gratuits :
 * l'utilisateur a choisi UN provider et UN modèle (--teacher-model). On fait un
 * seul appel avec retry intra-modèle (withRetry).
 *
 * Retourne le contenu texte ou lance une erreur (attrapée par l'appelant).
 */
async function callCloudTeacher({ provider, model, apiKey, endpoint, prompt, temperature, maxTokens }) {
  const provKey = (provider || '').toLowerCase();
  const provSpec = CLOUD_PROVIDERS[provKey];
  if (!provSpec) {
    throw new Error(`Teacher: provider inconnu '${provider}'. Valides: ${Object.keys(CLOUD_PROVIDERS).join(', ')}`);
  }
  if (!model) throw new Error('Teacher: modèle manquant pour le provider ' + provider);

  // URL : --teacher-endpoint en priorité, sinon l'URL du provider.
  const url = endpoint || provSpec.url;
  if (!url) throw new Error(`Teacher: provider '${provider}' nécessite --teacher-endpoint=<url>`);

  // Clé API : pour les providers locaux (ollama, lmstudio, custom), pas requise.
  const resolvedKey = apiKey || (provSpec.envKey ? process.env[provSpec.envKey] : null);
  if (provSpec.requiresAuth && !resolvedKey) {
    throw new Error(`Teacher: clé API manquante pour '${provider}' (env ${provSpec.envKey})`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
    if (resolvedKey) headers['Authorization'] = `Bearer ${resolvedKey}`;
    // Anthropic utilise x-api-key au lieu de Bearer.
    if (provKey === 'anthropic' && resolvedKey) {
      headers['x-api-key'] = resolvedKey;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];
    }

    let body;
    if (provSpec.openaiCompat) {
      // Format OpenAI-compat (tous sauf Anthropic).
      body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TEACHER_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: temperature ?? 0.15,
        max_tokens: maxTokens ?? 512,
        stream: false
      });
    } else {
      // Format Anthropic Messages API.
      body = JSON.stringify({
        model,
        system: TEACHER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        temperature: temperature ?? 0.15,
        max_tokens: maxTokens ?? 512,
        stream: false
      });
    }

    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`HTTP_${res.status} — ${errText.substring(0, 200)}`);
      err.httpStatus = res.status;
      throw err;
    }
    const data = await res.json();
    // Format OpenAI-compat : data.choices[0].message.content
    // Format Anthropic : data.content[0].text
    let content;
    if (provSpec.openaiCompat) {
      content = (data?.choices?.[0]?.message?.content || '').trim();
    } else {
      content = (data?.content?.[0]?.text || '').trim();
    }
    if (!content) throw new Error('Réponse vide du professeur (' + provider + ')');
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

  const prompt = buildTeacherPrompt({ task, errors, studentCode, studentAnalysis, tierNum });
  const tProvider = (teacherConfig.provider || 'openrouter').toLowerCase();
  const localProviders = ['ollama', 'lmstudio', 'custom'];

  // --- Provider non-OpenRouter : appel direct via callCloudTeacher ---
  // Pas de rotation de modèles gratuits (logique propre à OpenRouter). On fait
  // un seul appel au modèle spécifié par --teacher-model (ou défaut du provider).
  // Pour les providers locaux (ollama, lmstudio, custom), aucune clé n'est requise.
  if (tProvider !== 'openrouter') {
    if (!localProviders.includes(tProvider) && !teacherConfig.apiKey) {
      logger.warn(`Teacher: aucune clé pour ${tProvider} — professeur désactivé, repli sur auto-analyse.`);
      return null;
    }
    if (!teacherConfig.model) {
      logger.warn(`Teacher: --teacher-model requis pour le provider ${tProvider}. Professeur désactivé.`);
      return null;
    }
    try {
      logger.info(`Teacher: appel ${tProvider}/${teacherConfig.model} (avec retry intra-modèle)`);
      const content = await withRetry({
        label: 'Teacher/' + tProvider + '/' + teacherConfig.model,
        timeoutMs: 60000,
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        fn: () => callCloudTeacher({
          provider: tProvider,
          model: teacherConfig.model,
          apiKey: teacherConfig.apiKey,
          endpoint: teacherConfig.endpoint,
          prompt,
          temperature: teacherConfig.temperature,
          maxTokens: teacherConfig.maxTokens
        })
      });
      if (content) {
        logger.info(`Teacher: ${tProvider}/${teacherConfig.model} a répondu (${content.length} chars).`);
        return { content, model: teacherConfig.model };
      }
    } catch (e) {
      logger.warn(`Teacher: ${tProvider}/${teacherConfig.model} a échoué — ${e.message}. Repli sur auto-analyse.`);
    }
    return null;
  }

  // --- Provider OpenRouter : Free Router avec rotation de modèles gratuits ---
  if (!teacherConfig.apiKey) {
    logger.warn('Teacher: aucune clé OpenRouter — professeur désactivé, repli sur auto-analyse.');
    return null;
  }

  // Construit la liste des modèles à essayer.
  // 1. Modèle explicite de teacherConfig.model (si override --teacher-model)
  // 2. Puis modèles gratuits récupérés dynamiquement (Free Router)
  let candidates = [];
  if (teacherConfig.model && teacherConfig.model !== 'openrouter/free') candidates.push(teacherConfig.model);
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

  const maxAttempts = Math.min(candidates.length, Math.max(1, teacherConfig.maxRetries || 3));

  // Politique de retry (Plan §2) : pour chaque modèle, on tente avec timeout +
  // backoff exponentiel (2 retries intra-modèle). Si le modèle échoue définitivement
  // (401/403 ou tous retries épuisés), on rotate vers le suivant. On ne throw PAS
  // au niveau global : le professeur est un confort, l'élève se replie sur
  // l'auto-analyse. Chaque tentative et rotation est journalisée pour diagnostic.
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const model = candidates[i];
    const attemptStart = Date.now();
    try {
      logger.info(`Teacher: essai ${i + 1}/${maxAttempts} avec ${model} (avec retry intra-modèle)`);
      // withRetry gère timeout + backoff exponentiel + isRetryableError.
      const content = await withRetry({
        label: 'Teacher/' + model,
        timeoutMs: 60000,
        maxRetries: 2,           // 2 retries intra-modèle (3 tentatives au total)
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        fn: () => callOpenRouter({
          model,
          apiKey: teacherConfig.apiKey,
          prompt,
          temperature: teacherConfig.temperature,
          maxTokens: teacherConfig.maxTokens
        })
      });
      if (content) {
        const dur = Date.now() - attemptStart;
        logger.info(`Teacher: ${model} a répondu (${content.length} chars, ${dur}ms).`);
        return { content, model };
      }
    } catch (e) {
      lastError = e.message;
      const dur = Date.now() - attemptStart;
      logger.warn(`Teacher: ${model} a échoué définitivement (${dur}ms) — ${lastError}`);
      // 401/403 (clé invalide) → pas la peine de rotate, on sort immédiatement.
      if (e.httpStatus === 401 || e.httpStatus === 403 || (e.code && /401|403/.test(e.code))) {
        logger.error('Teacher: clé OpenRouter invalide (401/403) — arrêt du rotate');
        break;
      }
      // Backoff léger avant de rotate vers le modèle suivant (Free Router).
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 800));
    }
  }
  // Pas de throw ici : le professeur est un confort, l'élève se replie sur
  // l'auto-analyse. On journalise avec le code court E701 pour le diagnostic.
  logger.warn('Teacher: E701_TEACHER_UNAVAILABLE — tous les essais ont échoué. Dernier : ' + lastError);
  return null;
}

module.exports = {
  askTeacherToCorrectStudentAnalysis,
  buildTeacherPrompt,
  fetchFreeModels,
  callCloudTeacher,
  TEACHER_SYSTEM_PROMPT
};