




# Instruction pour cette tâche



Mission de Codage : Implémentation du Self-Profiling & Calibration dans BenchGo

1. Contexte & Objectif

L'objectif est d'implémenter un système d'Auto-Profilage et d'Étalonnage (Calibration) dans BenchGo.
Actuellement, BenchGo exécute les tests de manière séquentielle sur les modèles sans s'adapter à leurs compétences déclarées.

Nous voulons introduire un workflow en 4 étapes :

Interview Initiale (Self-Profiling) : Le runner interroge le modèle en mode JSON au démarrage avec un Mega-Prompt pour lui demander de s'évaluer sur différentes compétences clés.

Filtrage Dynamique : BenchGo utilise les compétences déclarées pour filtrer et désactiver certains tests jugés trop complexes (pour gagner du temps et des tokens).

Calcul de la Calibration : À la fin de l'évaluation, BenchGo calcule l'écart absolu entre ce que le modèle affirmait savoir faire et ses performances réelles dans le bac à sable.

Génération du Rapport : Inclusion de la performance, de l'évaluation déclarée, et de l'Indice de Calibration final.

2. Fichiers Cibles à Modifier

config.js : Ajouter les flags et options de configuration.

runner.js : Orchestrer l'interview, stocker le profil et filtrer les tâches.

score-ledger.js : Adapter le grand livre des scores pour calculer l'indice de calibration.

report-generator.js : Mettre à jour l'affichage des rapports JSON/Markdown/PDF.

3. Guide d'Implémentation Étape par Étape

Étape 3.1 : Configuration dans config.js

Ajouter les propriétés suivantes dans l'objet de configuration global de config.js pour permettre à l'utilisateur d'activer ou de désactiver cette fonctionnalité :

// Dans config.js, ajouter :
module.exports = {
  // ... configurations existantes
  selfProfiling: {
    enabled: true,         // Active ou désactive l'auto-profilage au démarrage
    minLevelToTest: 2,     // Niveau minimum déclaré (1 à 5) pour lancer les tests associés
    bypassFilter: false    // Si true, garde le profilage mais exécute TOUS les tests quand même
  }
};


Étape 3.2 : Le Prompt d'Interview dans runner.js

Au démarrage du script principal runner.js, juste après l'initialisation de la connexion avec le client de modèle (Ollama / LM Studio), si selfProfiling.enabled est à true, exécuter une requête système.

Le Prompt de Profilage (Mega-Prompt) :

Tu es un évaluateur technique objectif et lucide. Tu dois évaluer tes propres capacités de programmation et d'analyse.
Évalue ton niveau sur une échelle de 1 (aucune connaissance) à 5 (expert senior capable d'écrire du code de production optimisé et sans bug) pour les compétences suivantes.

Réponds UNIQUEMENT sous la forme d'un objet JSON respectant strictement le schéma suivant :
{
  "skills": {
    "html_css_frontend": { "level": <number_1_to_5>, "can_build_responsive": <boolean> },
    "javascript_async": { "level": <number_1_to_5>, "can_handle_promises": <boolean> },
    "python_apis": { "level": <number_1_to_5>, "can_use_fastapi": <boolean> },
    "logic_and_algorithms": { "level": <number_1_to_5>, "can_solve_complex_puzzles": <boolean> }
  },
  "justification": "<brief_sentence_explaining_your_calibration>"
}


Note : Assure-toi de configurer l'appel API (dans lm-studio-client.js ou dans ton appel natif) pour forcer le response_format: { type: "json_object" }.

Étape 3.3 : Filtrage Dynamique des Tiers dans runner.js

Une fois le profil JSON du modèle récupéré, parse-le.

Associe chaque compétence déclarée à des tags ou des dossiers de tests existants dans BenchGo (ex: html_css_frontend correspond aux tâches de frontend de Tier 1 ou 2).

Lors du chargement des tâches via tier-loader.js ou dans la boucle de sélection des tâches de runner.js, filtre les tâches :

Si la tâche requiert du JavaScript asynchrone complexe et que le modèle a déclaré javascript_async.level < config.selfProfiling.minLevelToTest, marque la tâche comme "Bypassée (Non déclarée)" au lieu de l'exécuter.

Enregistre ces décisions de filtrage dans les logs de logger.js.

Étape 3.4 : Calcul Mathématique de la Calibration ($C$)

Dans score-ledger.js, nous devons implémenter le calcul de la calibration.

Calcul de la Capacité Déclarée ($D$) :
Convertir le niveau auto-évalué moyen des compétences testées en pourcentage. Si $N$ est le nombre de compétences évaluées :

$$D = \frac{\sum_{i=1}^{N} \text{level}_i}{5 \times N}$$

Calcul de la Performance Réelle ($P$) :
Le ratio de réussite des tâches qui ont effectivement été exécutées :

$$P = \frac{\text{Nombre de Tâches Réussies}}{\text{Nombre de Tâches Lancées}}$$

Calcul de l'Indice de Calibration ($C$) :
Il s'agit de la mesure de la justesse du modèle par rapport à ses propres limites. Plus l'écart absolu est proche de 0, plus $C$ est proche de 1 (calibration parfaite) :

$$C = 1 - \vert D - P \vert$$

Ajoute cette méthode de calcul dans score-ledger.js :

function calculateCalibrationIndex(declaredProfile, testResults) {
  // Calculer D (Déclaré moyen entre 0 et 1)
  const levels = Object.values(declaredProfile.skills).map(s => s.level);
  const D = levels.reduce((sum, lvl) => sum + lvl, 0) / (levels.length * 5);

  // Calculer P (Performance réelle entre 0 et 1)
  const totalExecuted = testResults.filter(t => t.status !== 'bypassed').length;
  if (totalExecuted === 0) return 1.0;
  const totalSuccess = testResults.filter(t => t.status === 'success').length;
  const P = totalSuccess / totalExecuted;

  // Calculer C
  const C = 1 - Math.abs(D - P);
  return {
    declaredLevel: D,
    actualPerformance: P,
    calibrationIndex: C
  };
}


Étape 3.5 : Mise à Jour de report-generator.js

Le module de génération de rapport doit intégrer ces nouvelles données dans le rendu final des fichiers Markdown et PDF :

Ajouter une section "Auto-Profilage & Calibration" au début du rapport.

Afficher un tableau comparatif entre compétences déclarées et réussite réelle.

Mettre en valeur l'Indice de Calibration ($C$) avec une interprétation :

$C \ge 0.85$ : "Modèle Hautement Fiable / Lucide" (Connaît parfaitement ses forces et ses limites).

$0.65 \le C < 0.85$ : "Modèle Modérément Calibré".

$C < 0.65$ : "Biais de Surconfiance ou Sous-confiance Majeur" (Le modèle ment ou se sous-évalue drastiquement).

4. Critères d'Acceptation (Definition of Done)

Pour considérer cette tâche comme terminée, l'agent devra s'assurer que :

L'application BenchGo démarre normalement sans erreur de syntaxe ou d'importation.

Si un modèle ne supporte pas le format JSON natif, un mécanisme de repli (fallback) permet de parser la réponse via une regex ou d'ignorer l'auto-profilage en toute sécurité (graceful degradation).

Les rapports générés (Docs/Rapports.md ou JSON correspondants) contiennent la clé "calibration_index" ainsi que les détails du profil déclaré.

Aucun test unitaire existant de BenchGo n'est cassé.





































