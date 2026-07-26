// scoring-utils.js — Fonctions pures de scoring et utilitaires de traduction.
//
// Plan §4 (Maintenabilité) : extraire les fonctions pures (sans effet de bord,
// sans closure sur l'état du runner) de runner.js dans un module séparé pour
// les rendre testables unitairement et réduire la taille de runner.js.
//
// Fonctions extraites :
//   • isRattrapageEligibleProfile — détermine si un profil est éligible au rattrapage.
//   • shouldReplaceBestResult — compare deux résultats de tier (meilleur garde).
//   • explainTechnicalError — traduit une erreur brute du sandbox VM en message
//     pédagogique compréhensible.
//   • getClassName — calcule le nom d'affichage d'une classe depuis le profil+tier.
//
// Toutes ces fonctions sont pures : mêmes entrées → mêmes sorties, aucun effet
// de bord. Elles sont réexportées par runner.js pour rétro-compatibilité.

const { CLASSE_NAMES, tierToClasseNum } = require('./config');
const logger = require('./logger');

// Détermine si un profil est éligible au mode rattrapage (LIGHT + STANDARD).
// Les profils supérieurs (EXPERT, DOCTORAT, FRONTIER) ne proposent pas de
// rattrapage car le coût par appel API est trop élevé en mode cloud.
function isRattrapageEligibleProfile(profileArg) {
  return profileArg === 'LIGHT' || profileArg === 'STANDARD';
}

// Décide si un résultat candidat doit remplacer le meilleur résultat courant
// d'un tier. Règle : plus de classes passées gagne ; égalité → pourcentage le
// plus élevé gagne (>= pour favoriser la tentative la plus récente).
function shouldReplaceBestResult(currentBest, candidate) {
  if (!currentBest) return true;
  if (candidate.tierPassedCount > currentBest.tierPassedCount) return true;
  if (candidate.tierPassedCount < currentBest.tierPassedCount) return false;
  return candidate.tierPct >= currentBest.tierPct;
}

// Traduction pédagogique des erreurs techniques brutes du moteur JS.
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

// Calcule le nom d'affichage d'une classe depuis le profil et le numéro de tier.
// Ex: getClassName('STANDARD', 0) → "6eme" (Classe-0-6eme → on garde après le 2e tiret).
function getClassName(profileArg, tierNum) {
  const classNum = tierToClasseNum(profileArg, tierNum);
  const fullName = (CLASSE_NAMES[profileArg] && CLASSE_NAMES[profileArg][classNum]) || `Classe-${classNum}`;
  const firstDash = fullName.indexOf('-');
  const secondDash = firstDash !== -1 ? fullName.indexOf('-', firstDash + 1) : -1;
  return secondDash !== -1 ? fullName.substring(secondDash + 1) : fullName;
}

module.exports = {
  isRattrapageEligibleProfile,
  shouldReplaceBestResult,
  explainTechnicalError,
  getClassName
};