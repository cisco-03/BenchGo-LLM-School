// report-teacher.js — Professeur IA externe pour la rédaction du rapport final.
//
// Rôle : après qu'un modèle (élève) a terminé ses examens, un PROFESSEUR IA
// externe (modèle cloud distinct de l'élève) prend en charge la validation
// pédagogique :
//   - relit l'ensemble des résultats (exercices réussis/échoués, points,
//     auto-analyses de l'élève, corrections déjà produites) ;
//   - rédige une section de validation : note finale, classement perçu,
//     méthodologie, compréhension des exercices, points clés à retenir.
//
// Cette section est INJECTÉE dans le rapport Markdown final, en plus du
// rapport technique généré localement. Le rapport reste écrit par le moteur
// BenchGo (pour la traçabilité technique), mais le professeur externe
// apporte la lecture pédagogique "humaine" demandée par l'utilisateur.
//
// Fournisseurs supportés : OpenRouter (par défaut), OpenAI, Ollama, custom.
// On réutilise les clés mémorisées par secrets.js pour la session courante.

const logger = require('./logger');
const secrets = require('./secrets');
const { CLOUD_PROVIDERS } = require('./cloud-client');

const TEACHER_REPORT_SYSTEM_PROMPT =
  "Vous êtes un professeur principal expérimenté, bienveillant mais rigoureux. " +
  "Vous rédigez la validation pédagogique finale d'un examen de programmation JavaScript " +
  "passé par un modèle de langage (l'élève). Vous parlez français. " +
  "Vous ne flattez pas l'élève : vous jugez honnêtement. " +
  "Vous rédigez en Markdown structuré (titres ##, listes, tableaux), sans blocs de code sauf nécessité absolue.";

// Construit le prompt envoyé au professeur externe à partir des résultats agrégés.
function buildReportTeacherPrompt({ modelName, profileLabel, ecoleLabel, tierScorecard, evalResults, globalScore, calibration, failureExplanations, teacherCorrections }) {
  const lines = [];

  lines.push(`CONTEXTE : Le modèle « ${modelName || '(inconnu)'} » a terminé son examen.`);
  lines.push(`Profil : ${profileLabel} — École : ${ecoleLabel}.`);
  lines.push('');
  lines.push('RÉSULTATS BRUTS (fournis par le moteur BenchGo) :');
  lines.push('');
  lines.push('Tableau récapitulatif par classe (tier) :');
  lines.push('| Classe | Points | Max | Pct | Statut |');
  lines.push('|---|---|---|---|---|');
  for (const t of (tierScorecard || [])) {
    const pct = t.max > 0 ? Math.round((t.score / t.max) * 100) : 0;
    const status = t.passed ? 'Validé' : 'Échec';
    lines.push(`| ${t.className} | ${t.score} | ${t.max} | ${pct}% | ${status} |`);
  }
  const totalScore = globalScore?.passed ?? 0;
  const totalMax = globalScore?.total ?? 0;
  const totalPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  lines.push(`| **TOTAL** | **${totalScore}** | **${totalMax}** | **${totalPct}%** | |`);
  lines.push('');

  // Détail par exercice
  const withDetail = (evalResults || []).filter(r => r.status !== 'bypassed');
  if (withDetail.length > 0) {
    lines.push('Détail par exercice :');
    lines.push('| Exercice | Type | Points | Max | Statut | Aide | Rattrapage |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of withDetail) {
      const st = r.status === 'success' ? 'Validé' : 'Échec';
      const help = r.helpUsed ? 'Oui' : 'Non';
      const retry = r.retried ? 'Oui' : 'Non';
      lines.push(`| ${r.id} | ${r.taskType || '—'} | ${r.points || 0} | ${r.maxPoints || 0} | ${st} | ${help} | ${retry} |`);
    }
    lines.push('');
  }

  // Échecs définitifs + auto-analyses + corrections précédentes
  const failures = (evalResults || []).filter(r => r.status === 'failed' && (r.failureExplanation || r.teacherCorrection));
  if (failures.length > 0) {
    lines.push('Échecs définitifs (avec auto-analyse de l\'élève et correction déjà produite) :');
    for (const r of failures) {
      lines.push('');
      lines.push(`### ${r.id} (${r.taskType || 'Exercice'}) — ${r.maxPoints || 0} pts`);
      if (r.failureExplanation) {
        lines.push(`**Auto-analyse de l'élève :** ${r.failureExplanation}`);
      }
      if (r.teacherCorrection) {
        lines.push(`**Correction précédente du professeur :** ${r.teacherCorrection}`);
      }
    }
    lines.push('');
  }

  if (calibration) {
    lines.push(`Indice de calibration : C = ${calibration.calibrationIndex.toFixed(3)} (D=${(calibration.declaredLevel * 100).toFixed(0)}%, P=${(calibration.actualPerformance * 100).toFixed(0)}%).`);
    lines.push('');
  }

  lines.push('VOTRE RÔLE : En tant que professeur principal, rédigez la validation pédagogique finale de cet examen. Cette validation sera intégrée au rapport Markdown remis à l\'utilisateur.');
  lines.push('Structure OBLIGATOIRE de votre réponse :');
  lines.push('## Validation du professeur IA');
  lines.push('### Note finale et classement perçu');
  lines.push('(Note globale sur 100, appréciation globale en 2-3 phrases, positionnement qualitatif du modèle.)');
  lines.push('### Méthodologie et compréhension des exercices');
  lines.push('(Analyse de la démarche : le modèle a-t-il compris les énoncés ? A-t-il su choisir ses exercices ? A-t-il gaspillé des tokens ?etc.)');
  lines.push('### Points clés à retenir');
  lines.push('(Liste à puces des forces et faiblesses marquantes, avec au moins 3 forces et 3 faiblesses.)');
  lines.push('### Recommandation finale');
  lines.push('(RECOMMANDÉ / PARTIEL / NON RECOMMANDÉ + justification en 1-2 phrases.)');
  lines.push('');
  lines.push('Soyez direct, technique et honnête. Pas de flatterie. Répondez UNIQUEMENT en Markdown.');

  return lines.join('\n');
}

// Appel chat/completions (non-streamé) sur un provider OpenAI-compat.
async function _callChatCompletion({ url, apiKey, model, systemPrompt, userPrompt, maxTokens = 1500, temperature = 0.3 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (url.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://benchgo-v3';
      // X-Title doit être un ByteString (Latin-1) : pas d'em dash ni d'accent.
      // On utilise un tiret ASCII simple pour rester compatible avec fetch.
      headers['X-Title'] = 'BenchGo V3 - Professeur rapport';
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
    if (!content) throw new Error('Réponse vide du professeur de rapport');
    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * Demande à un professeur IA externe de rédiger la section "Validation du
 * professeur IA" pour le rapport final.
 *
 * @param {object} args
 * @param {object} args.teacherConfig - { enabled, provider, model, apiKey, endpoint, maxRetries }
 *   provider peut être 'openrouter', 'openai', 'ollama', 'custom', etc.
 * @param {object} args.results - { modelName, profileLabel, ecoleLabel, tierScorecard, evalResults, globalScore, calibration }
 * @returns {Promise<string|null>} Section Markdown à injecter, ou null si indisponible.
 */
async function buildExternalTeacherReport({ teacherConfig, results }) {
  if (!teacherConfig || !teacherConfig.enabled) return null;

  const provider = (teacherConfig.provider || 'openrouter').toLowerCase();
  const spec = CLOUD_PROVIDERS[provider];
  if (!spec) {
    logger.warn(`Report-teacher : provider inconnu '${provider}'.`);
    return null;
  }

  // Clé : priorité teacherConfig.apiKey, puis secrets.js (session), puis env.
  let apiKey = teacherConfig.apiKey || secrets.getSecret(provider) || secrets.getSecret('openrouter') || null;
  if (spec.requiresAuth && !apiKey) {
    const envKey = spec.envKey ? process.env[spec.envKey] : null;
    if (envKey) apiKey = envKey;
  }
  if (spec.requiresAuth && !apiKey) {
    logger.warn('Report-teacher : aucune clé API — section externe désactivée.');
    return null;
  }

  const model = teacherConfig.model || (provider === 'openrouter' ? 'meta-llama/llama-3.3-70b-instruct:free' : null);
  if (!model) {
    logger.warn('Report-teacher : aucun modèle spécifié.');
    return null;
  }

  const url = teacherConfig.endpoint || spec.url;
  if (!url) {
    logger.warn(`Report-teacher : provider '${provider}' sans URL.`);
    return null;
  }

  const prompt = buildReportTeacherPrompt(results);

  const maxAttempts = Math.max(1, teacherConfig.maxRetries || 2);
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    try {
      logger.info(`Report-teacher : essai ${i + 1}/${maxAttempts} avec ${model} sur ${provider}.`);
      const content = await _callChatCompletion({
        url, apiKey, model,
        systemPrompt: TEACHER_REPORT_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 1800,
        temperature: 0.3
      });
      logger.info(`Report-teacher : ${model} a répondu (${content.length} chars).`);
      // S'assure que la section commence bien par le bon titre.
      if (!/^#\s*Validation du professeur/i.test(content)) {
        return `## Validation du professeur IA\n\n${content.trim()}\n`;
      }
      return content.trim() + '\n';
    } catch (e) {
      lastError = e.message;
      logger.warn(`Report-teacher : ${model} a échoué : ${lastError}`);
      if (e.httpStatus === 401 || e.httpStatus === 403) break;
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 800));
    }
  }
  logger.warn(`Report-teacher : tous les essais ont échoué. Dernier : ${lastError}`);
  return null;
}

module.exports = {
  buildExternalTeacherReport,
  buildReportTeacherPrompt,
  TEACHER_REPORT_SYSTEM_PROMPT
};