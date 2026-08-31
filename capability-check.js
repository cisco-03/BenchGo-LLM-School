// capability-check.js — Test de capacité rapide (~20-30s max) d'un modèle élève.
//
// Remplace l'auto-profilage (self-profiling.js) et le profilage externe
// (external-profiling.js) qui prenaient 1-10 min et bloquaient les utilisateurs.
// Ici, un SEUL appel au modèle élève lui demande s'il est capable de faire des
// exercices de programmation JavaScript. La réponse est OUI ou NON.
//
//   - OUI  → le runner valide et commence les exercices (toutes les tâches, aucun filtrage).
//   - NON  → le modèle est recalé définitivement (exit 0 propre, pas de pénalité, pas de carnet).
//
// Parsing infaillible : tolérant à la casse, aux accents, au prose autour de la
// réponse, aux variants (oui/yes/o/affirmatif/peut-être...). Si le modèle ne
// répond pas clairement après MAX_ATTEMPTS, on considère par prudence qu'il EST
// capable (OUI par défaut) pour ne pas exclure un modèle fonctionnel mais bavard.
// L'utilisateur peut relancer si le modèle a été mal jugé.

const logger = require('./logger');

// Prompt du test de capacité. Court et directif : on veut OUI ou NON.
// On décrit brièvement ce qui attend le modèle (sans détails, sans spoiler) pour
// qu'il puisse juger lucidement s'il est capable.
const CAPABILITY_PROMPT =
  "Tu vas passer un examen de programmation JavaScript compose d'exercices de difficulté variable " +
  "(bases du langage, algorithmique, programmation asynchrone, structures de donnees, debogage, securite). " +
  "Pour chaque exercice, tu devras ecrire du code JavaScript et l'evaluer.\n\n" +
  "Es-tu capable de realiser cet examen ? Reponds UNIQUEMENT par OUI ou par NON.";

// Budget temps : on veut ~20-30s maximum. Timeout par tentative court.
const CAPABILITY_TIMEOUT_MS = 30000;
// max_tokens 512 (pas 16) : les modèles de raisonnement (:free thinking)
// consomment d'abord le budget en phase de pensée (delta.reasoning) avant de
// produire la réponse. Avec 16 tokens, tout est mangé par le raisonnement →
// content vide → verdict INDETERMINE systématique (OUI par défaut au bout de
// 2 tentatives gaspillées). 512 laisse raisonner puis répondre OUI/NON.
const CAPABILITY_MAX_TOKENS = 512;
const MAX_ATTEMPTS = 2;              // 2 tentatives max (déjà ~30s pire cas)

// Détecte si la réponse exprime une capacité (OUI) ou une incapacité (NON).
// Ordre de priorité : NON est testé en premier car un "non, je ne suis pas
// capable" est non ambigu. On accepte de nombreux variants.
//
// Retourne : 'YES' | 'NO' | null (indéterminé)
function interpretCapabilityAnswer(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().trim();

  // Patterns d'incapacité (NON). Testés en priorité.
  const noPatterns = [
    /\bnon\b/, /\bno\b/, /\bn\b(?=\s|$|[,.;!?])/, /je ne suis pas capable/,
    /je ne peux pas/, /incapable/, /impossib/, /je refuse/, /non[,\s]/,
    /\bnope\b/, /\bno way\b/, /not able/, /cannot/, /can'?t\b/
  ];
  for (const re of noPatterns) {
    if (re.test(t)) return 'NO';
  }

  // Patterns de capacité (OUI).
  const yesPatterns = [
    /\boui\b/, /\byes\b/, /\bo\b(?=\s|$|[,.;!?])/, /je suis capable/,
    /je peux/, /capable/, /pret\b/, /je le peux/, /affirmatif/, /tout a fait/,
    /bien sur/, /bien sur/, /absolument/, /certainement/, /with pleasure/
  ];
  for (const re of yesPatterns) {
    if (re.test(t)) return 'YES';
  }

  // Cas ambigu : "peut-être", "partiellement", "je vais essayer" → on tente OUI
  // (le modèle est prudent mais probablement capable ; il aura sa chance à
  // l'examen qui le jugera réellement). Tolérant aux accents (être/etre).
  const maybePatterns = [/\bpeut[- ]?[eèêé]tre\b/, /partiellement/, /je vais essayer/, /je vais tenter/, /je vais faire/, /essayer/, /tentative/];
  for (const re of maybePatterns) {
    if (re.test(t)) return 'YES';
  }

  return null;
}

/**
 * Lance le test de capacité auprès du modèle élève.
 *
 * @param {function} queryFn - fonction queryLLM (même signature que lm-studio-client / cloud-client).
 * @param {object} providerConfig - config du provider (cloud ou local).
 * @param {number} contextLimitTokens - limite de contexte.
 * @returns {Promise<{ capable: boolean, rawAnswer: string, attempts: number }>}
 *   capable=true  → le modèle a répondu OUI (ou a été jugé capable par défaut).
 *   capable=false → le modèle a explicitement répondu NON.
 */
async function runCapabilityCheck(queryFn, providerConfig, contextLimitTokens) {
  if (!queryFn) return { capable: true, rawAnswer: '', attempts: 0 };

  // Spinner factice : le runner gère déjà l'affichage, on passe un mock minimal.
  const noopSpinner = {
    start() {}, stop() {}, fail() {}, updateTokens() {}, _modelName: null,
    beginStreaming() {}, appendStreamChunk() {}, endStreaming() {}
  };

  let lastAnswer = '';
  let attempts = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts = i + 1;
    logger.info(`Capability-check : tentative ${attempts}/${MAX_ATTEMPTS}.`);
    try {
      const response = await queryFn(
        CAPABILITY_PROMPT,
        'EASY',
        'CAPABILITY',
        false,
        noopSpinner,
        { contextLimitTokens, providerConfig, timeoutMs: CAPABILITY_TIMEOUT_MS, maxTokens: CAPABILITY_MAX_TOKENS }
      );
      lastAnswer = (response && response.content) || '';
      const verdict = interpretCapabilityAnswer(lastAnswer);
      logger.info(`Capability-check tentative ${attempts} : reponse="${lastAnswer.trim().substring(0, 80)}" → ${verdict || 'INDETERMINE'}.`);
      if (verdict === 'YES') {
        return { capable: true, rawAnswer: lastAnswer, attempts };
      }
      if (verdict === 'NO') {
        return { capable: false, rawAnswer: lastAnswer, attempts };
      }
      // Indéterminé : on retente avec une relance plus directrice.
    } catch (e) {
      logger.warn(`Capability-check tentative ${attempts} : echec appel (${e.message}).`);
      // On retente : un timeout/erreur réseau n'est pas un NON du modèle.
    }
    if (i < MAX_ATTEMPTS - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Après MAX_ATTEMPTS sans réponse claire : par prudence, on considère le modèle
  // capable (OUI par défaut). Il aura sa chance à l'examen réel, qui le jugera sur
  // preuve. Exclure un modèle bavard/mal formaté serait une erreur.
  logger.warn(`Capability-check : reponse indeterminee apres ${attempts} tentatives. OUI par defaut (prudence).`);
  return { capable: true, rawAnswer: lastAnswer, attempts };
}

module.exports = {
  runCapabilityCheck,
  interpretCapabilityAnswer,
  CAPABILITY_PROMPT,
  CAPABILITY_TIMEOUT_MS,
  MAX_ATTEMPTS
};