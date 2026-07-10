# 2026-07-09 — Santé Globale, 5 Axes du Directeur et Classe 6 (Terminale/Master/Doctorat)

## Symptômes
1. Des petits modèles de raisonnement (comme `minicpm5-1b-agentic-tooluse`) provoquaient des erreurs de syntaxe inattendues (ex: `Unexpected token 'else'`) dans la Sandbox VM lors de la résolution de tâches d'algorithmique et subissaient une élimination immédiate.
2. Le système de gamification manquait de robustesse : une mauvaise note sur un exercice difficile pouvait pénaliser à tort un modèle ayant très bien débuté le benchmark.
3. Volonté d'étendre le banc d'évaluation à 100% avec des mesures de vitesse, d'optimisation, de respect des contraintes absolues, d'injection de prompt et de mémoire longue.

## Cause racine
1. Les modèles compacts peinaient à suivre le format de sortie attendu, générant du code partiel ou mal structuré (par exemple, des blocs conditionnels tronqués), ce qui provoquait des plantages syntaxiques directs dans le VM Sandbox.
2. Le score d'élimination de `-100` était calculé au niveau du Tier (réinitialisé à 0). Ainsi, un modèle subissant des erreurs consécutives dans un Tier difficile était stoppé net, sans valoriser son bon score accumulé dans les Tiers précédents.
3. Il manquait des tâches spécifiques pour tester le "temps d'inférence" (vitesse), le "temps d'exécution du code" (optimisation), les instructions de sécurité, la non-utilisation de certaines fonctions natives, et la rétention de contexte long.

## Solution
1. **Implémentation de la "Santé Globale" (Global Life Score) :**
   - Remplacement de la variable `score` unique par `tierScore` (propre à chaque niveau) et `gameState.globalLifeScore` (persistant sur l'ensemble du benchmark).
   - Le modèle commence à 0 PV. Ses réussites augmentent sa Santé Globale (lui créant un buffer), tandis que ses échecs la diminuent.
   - S'il atteint ou descend sous `-100` de Santé Globale (cumulée), il est définitivement exclu. Ainsi, un modèle performant au début survit plus longtemps aux échecs ultérieurs.
   
2. **Mesure de l'Inférence et de la Verbosité (Axe 1) :**
   - Mesure du temps de génération de l'API avec `performance.now()` dans `runner.js`.
   - Pénalité de verbosité (`-15 pts`) si le modèle produit un texte bavard disproportionné par rapport au code utile extrait.

3. **Mesure de l'Exécution VM (Axe 3) :**
   - Intégration de `performance.now()` autour de l'exécution dans `vm-sandbox.js` pour renvoyer `executionTimeMs`.
   - `task-evaluator.js` vérifie désormais la propriété `maxTimeMs` sur les tests `exec`. Si le code de l'élève met trop de temps (ex: algorithme `O(N^2)` non optimisé), l'exercice échoue.

4. **Création du Tier 6 (Doctorat/Expertise/Résistance) (Axes 2, 4, 5) :**
   - Création de `tiers/tier6_master.json` :
     - `trier_tableau` : Contrainte de ne pas utiliser la méthode native `.sort()` (vérifié avec un évaluateur de motif `forbidden`).
     - `memoire_longue` : Test "Needle in a Haystack" consistant à chercher et restituer une phrase secrète au milieu d'un grand texte.
     - `calcul_robuste` : Test d'injection de prompt visant à piéger le modèle en lui demandant de coder une fonction interdite.
     - `optimisation_extreme` : Test de rapidité avec un tableau géant (limite stricte à 35ms).
   - Enregistrement du Tier 6 dans `config.js` (profils STANDARD, EXPERT, DOCTORAT, FRONTIER).

## Fichiers modifiés
- `runner.js`
- `config.js`
- `vm-sandbox.js`
- `task-evaluator.js`
- `tiers/tier6_master.json` (nouveau)
- `Docs/Apps-Fonctions/gamification-sante.md` (nouveau)

## Validation
- L'auto-détection et le ciblage direct (`node runner.js 6 --profile=STANDARD`) fonctionnent parfaitement.
- Les logs en console affichent le temps d'inférence en ms, la Santé Globale, et la pénalité de verbosité le cas échéant.
- Les tests d'optimisation (temps de VM) et de contraintes d'exclusion (regex) s'appliquent correctement.
