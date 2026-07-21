// external-profiling.js — Profilage externe des compétences d'un modèle élève.
//
// L'auto-profilage par le modèle lui-même comporte un risque d'erreur
// d'appréciation (surconfiance, fausse modestie, mauvaise lucidité sur ses
// propres capacités). Pour fiabiliser le filtrage des tâches, on demande à un
// PROFESSEUR IA externe (modèle cloud distinct, plus robuste) d'évaluer les
// compétences de l'élève à partir d'un échantillon de son comportement.
//
// Approche hybride :
//  - L'auto-profilage (self-profiling.js) est conservé : il sert à calculer
//    l'Indice de Calibration (écart entre la perception du modèle sur lui-même
//    et sa performance réelle). C'est une métrique précieuse pour le classement.
//  - Le profilage externe (ce module) produit le profil utilisé pour le FILTRAGE
//    des tâches : il est plus fiable car produit par un tiers.
//
// Sans professeur activé → repli sur l'auto-profilage pour le filtrage
// (comportement historique).
//
// Free Router : sur OpenRouter, on ne hardcode plus un slug ':free' unique
// (souvent dépublié → 404, et un seul point de défaillance). On récupère
// dynamiquement la liste des modèles gratuits via fetchFreeModels() (endpoint
// public /api/v1/models) et on ROTATE à travers les meilleurs jusqu'à en
// trouver un qui répond et produit un profil parsable. Si un modèle échoue
// (429/404/5xx/réseau/réponse vide), on enchaîne sur le suivant.
//
// ByteString : les headers HTTP OpenRouter (HTTP-Referer, X-Title) doivent être
// en Latin-1 (valeur ≤ 255). On utilise un tiret ASCII '-' et jamais d'em dash
// '—' (U+2012) ni d'accent — sinon fetch lève "Cannot convert argument to a
// ByteString" et le profilage externe échoue systématiquement.

const logger = require('./logger');
const secrets = require('./secrets');
const { CLOUD_PROVIDERS } = require('./cloud-client');
const { fetchFreeModels } = require('./teacher-client');

const EXTERNAL_PROFILE_SYSTEM_PROMPT =
  "Vous êtes un évaluateur technique senior et rigoureux. " +
  "Vous devez évaluer les compétences JavaScript d'un modèle de langage (l'élève) " +
  "à partir de son auto-évaluation ET de votre propre jugement expert. " +
  "Vous parlez français. Vous êtes objectif, ni bienveillant ni sévère : juste juste. " +
  "Répondez UNIQUEMENT avec un objet JSON valide, sans texte avant ou après.";

function buildExternalProfilePrompt({ studentSelfProfile, studentModelName }) {
  const lines = [];
  lines.push(`CONTEXTE : Un modèle de langage (« ${studentModelName || '(inconnu)'} », l'élève) va passer un examen de programmation JavaScript composé d'exercices de difficulté variable.`);
  lines.push(`Avant l'examen, il a produit une auto-évaluation de ses compétences. Votre rôle est d'évaluer OBJECTIVEMENT ses compétences pour décider quels exercices sont trop difficiles pour lui.`);

  if (studentSelfProfile && studentSelfProfile.skills) {
    lines.push('');
    lines.push('AUTO-ÉVALUATION DE L\'ÉLÈVE (à critiquer, ne pas recopier aveuglément) :');
    const skills = studentSelfProfile.skills;
    const labels = {
      javascript_basics: 'JavaScript Bases & Algorithmique simple',
      javascript_async: 'JavaScript Asynchrone (Promises, concurrence, retry)',
      algorithms_advanced: 'Algorithmes & Structures de données avancées',
      code_debugging: 'Débogage & Sécurité applicative'
    };
    for (const [key, label] of Object.entries(labels)) {
      const lvl = skills[key] ? skills[key].level : '?';
      const ex = skills[key] ? (skills[key].examples || '') : '';
      lines.push(`  • ${label} : niveau ${lvl}/5${ex ? ` — exemples : ${ex}` : ''}`);
    }
    if (studentSelfProfile.justification) {
      lines.push(`  Justification de l'élève : ${studentSelfProfile.justification}`);
    }
    lines.push('');
    lines.push('ATTENTION : les modèles ont tendance à se surévaluer ou à se sous-évaluer. Critiquez l\'auto-évaluation de l\'élève :');
    lines.push('  - Si l\'élève se surévalue (ex: niveau 5 alors qu\'un modèle de cette taille ne peut pas atteindre ce niveau), abaissez le niveau.');
    lines.push('  - Si l\'élève se sous-évalue (ex: niveau 1 alors que le contexte du modèle suggère des capacités), augmentez le niveau.');
    lines.push('  - Si l\'auto-évaluation vous semble honnête, conservez le niveau.');
  } else {
    lines.push('');
    lines.push('L\'élève n\'a pas pu produire d\'auto-évaluation. Évaluez-le vous-même à partir du nom du modèle et de votre expérience.');
  }

  lines.push('');
  lines.push('Compétences à évaluer (échelle 1 à 5) :');
  lines.push('  - "javascript_basics" : Bases du langage (fonctions, tableaux, chaînes, objets) et algorithmique simple.');
  lines.push('  - "javascript_async" : Programmation asynchrone (Promises, async/await, concurrence, retry).');
  lines.push('  - "algorithms_advanced" : Structures de données avancées et algorithmes complexes.');
  lines.push('  - "code_debugging" : Débogage et sécurité applicative.');
  lines.push('');
  lines.push('Échelle : 1 = aucune connaissance, 2 = débutant, 3 = intermédiaire, 4 = avancé, 5 = expert senior.');
  lines.push('');
  lines.push('Répondez UNIQUEMENT avec un objet JSON strictement conforme à ce schéma :');
  lines.push('{');
  lines.push('  "skills": {');
  lines.push('    "javascript_basics": { "level": <1-5> },');
  lines.push('    "javascript_async": { "level": <1-5> },');
  lines.push('    "algorithms_advanced": { "level": <1-5> },');
  lines.push('    "code_debugging": { "level": <1-5> }');
  lines.push('  },');
  lines.push('  "justification": "<phrase courte expliquant votre évaluation et pourquoi vous avez ajusté ou conservé l\'auto-évaluation>"');
  lines.push('}');
  return lines.join('\n');
}

async function _callChatCompletion({ url, apiKey, model, systemPrompt, userPrompt, maxTokens = 800, temperature = 0.2 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (url.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://benchgo-v3';
      // X-Title doit être un ByteString (Latin-1) : pas d'em dash ni d'accent.
      // On utilise un tiret ASCII simple pour rester compatible avec fetch.
      headers['X-Title'] = 'BenchGo V3 - Profilage externe';
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens,
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
    if (!content) throw new Error('Réponse vide du profilage externe');
    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * Demande à un professeur IA externe d'évaluer les compétences de l'élève.
 * Réutilise la clé mémorisée dans secrets.js (session) pour le provider du
 * professeur.
 *
 * @param {object} args
 * @param {object} args.teacherConfig - { enabled, provider, model, apiKey, endpoint, maxRetries }
 * @param {object|null} args.studentSelfProfile - auto-profilage de l'élève (à critiquer)
 * @param {string} args.studentModelName - nom du modèle élève
 * @returns {Promise<object|null>} profil externe { skills, justification } ou null
 */
async function runExternalProfiling({ teacherConfig, studentSelfProfile, studentModelName }) {
  if (!teacherConfig || !teacherConfig.enabled) return null;

  const provider = (teacherConfig.provider || 'openrouter').toLowerCase();
  const spec = CLOUD_PROVIDERS[provider];
  if (!spec) {
    logger.warn(`External-profile : provider inconnu '${provider}'.`);
    return null;
  }

  let apiKey = teacherConfig.apiKey || secrets.getSecret(provider) || secrets.getSecret('openrouter') || null;
  if (spec.requiresAuth && !apiKey) {
    const envKey = spec.envKey ? process.env[spec.envKey] : null;
    if (envKey) apiKey = envKey;
  }
  if (spec.requiresAuth && !apiKey) {
    logger.warn('External-profile : aucune clé API — profilage externe désactivé, repli sur auto-profilage.');
    return null;
  }

  // Construction de la liste des modèles à essayer (Free Router OpenRouter).
  // Ne plus jamais hardcoder un slug ':free' (souvent dépublié → 404) :
  // on récupère dynamiquement les modèles gratuits réellement disponibles via
  // fetchFreeModels(), qui filtre déjà la modality texte->texte et la denylist.
  const explicitModel = teacherConfig.model || null;
  let candidates = [];
  if (explicitModel) candidates.push(explicitModel);
  if (provider === 'openrouter') {
    try {
      const free = await fetchFreeModels();
      for (const id of free) {
        if (!candidates.includes(id)) candidates.push(id);
      }
    } catch (e) {
      logger.warn(`External-profile : Free Router indisponible (${e.message}) — seuls les modèles explicites seront essayés.`);
    }
  }
  if (candidates.length === 0) {
    logger.warn('External-profile : aucun modèle disponible.');
    return null;
  }

  const url = teacherConfig.endpoint || spec.url;
  if (!url) {
    logger.warn(`External-profile : provider '${provider}' sans URL.`);
    return null;
  }

  const prompt = buildExternalProfilePrompt({ studentSelfProfile, studentModelName });
  const { extractJSON } = require('./parsing-utils');
  const { validateProfile, parseProfileFallback } = require('./self-profiling');

  // On rotate à travers les candidats : si un modèle échoue (429/5xx/404/réseau
  // ou réponse non parsable), on passe au suivant. Stop sur 401/403 (clé nulle).
  const maxAttempts = Math.min(candidates.length, Math.max(1, teacherConfig.maxRetries || 3));
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const model = candidates[i];
    try {
      logger.info(`External-profile : essai ${i + 1}/${maxAttempts} avec ${model} sur ${provider}.`);
      const content = await _callChatCompletion({
        url, apiKey, model,
        systemPrompt: EXTERNAL_PROFILE_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 800,
        temperature: 0.2
      });

      let parsed = null;
      try { parsed = JSON.parse(extractJSON(content)); } catch (_) {}
      if (!validateProfile(parsed)) {
        parsed = parseProfileFallback(content);
      }
      if (!validateProfile(parsed)) {
        logger.warn(`External-profile : ${model} — réponse non parsable, modèle suivant.`);
        lastError = 'réponse non parsable';
        continue;
      }
      logger.info(`External-profile : ${model} a répondu — ${JSON.stringify(parsed.skills)}`);
      return parsed;
    } catch (e) {
      lastError = e.message;
      logger.warn(`External-profile : ${model} a échoué : ${lastError}`);
      if (e.httpStatus === 401 || e.httpStatus === 403) break;
      // 404 = slug :free dépublié → rotate vers le suivant sans backoff.
      if (e.httpStatus === 404) continue;
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 800));
    }
  }
  logger.warn(`External-profile : tous les essais ont échoué. Dernier : ${lastError}`);
  return null;
}

module.exports = {
  runExternalProfiling,
  buildExternalProfilePrompt,
  EXTERNAL_PROFILE_SYSTEM_PROMPT
};