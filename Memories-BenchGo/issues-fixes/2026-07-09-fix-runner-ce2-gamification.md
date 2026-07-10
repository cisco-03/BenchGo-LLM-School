## 2026-07-09 — Correction du blocage au CE2 et ajout de l'Algorithme de Libre Choix et Gamification

### Contexte
Le runner s'arrêtait de manière inattendue lors de l'exécution du Tier 3 (CE2) si celui-ci échouait, sans continuer vers les niveaux CM1 (Tier 4) et CM2 (Tier 5). L'erreur affichait "ERREUR FATALE : TEST ECHOUE - Score : 0".
De plus, il fallait intégrer un tout nouveau système de gamification et d'interactivité où le LLM peut choisir librement l'ordre des exercices, gagner des points (pour atteindre 100 points), et obtenir des micro-récompenses ou trophées.

### Action entreprise

**1. Résolution de l'arrêt inattendu et mise en place du seuil de validation**
- Modification de `runner.js` dans la boucle d'exécution (`runTierAttempt`).
- L'arrêt prématuré était causé par un `break` direct lorsqu'un exercice optionnel n'était pas "skip" mais échouait.
- Le runner implémente dorénavant une validation sur base d'un seuil de points (70 points / 100 pour passer un niveau).
- Simulation de l'erreur fatale souhaitée uniquement si un tier *obligatoire* est en échec. Le programme s'arrête proprement.

**2. Ajout de 5 nouveaux exercices (Auto-updater)**
- Au lieu de forcer l'utilisateur à lancer une commande Bash, création d'un module `auto-updater.js`.
- Celui-ci est importé et appelé dynamiquement au démarrage de `runner.js`. Il scanne `tiers/` et injecte automatiquement 5 exercices d'algorithmique et attribue une propriété `points` à chaque exercice (8, 10 ou 15 points selon la difficulté) pour s'assurer que le total d'un Tier fasse ~100 points ou plus.

**3. Moteur interactif de Libre Choix**
- La fonction `runTierAttempt` a été totalement réécrite.
- Elle procède désormais à une boucle asynchrone qui propose le catalogue complet des exercices restants avec leurs valeurs en points.
- Le LLM répond obligatoirement avec `SELECTION: ID_EXERCICE` ou `SELECTION: STOP`.
- L'exercice choisi est retiré du catalogue, exécuté, et le score est ajusté (micro-récompense Niveau 1).

**4. Gamification (Niveaux 1, 2, 3)**
- Niveau 1 : Le runner félicite le modèle à chaque succès ("Succès ! +X Points...").
- Niveau 2 : Au moment de valider le Tier, mention "Classe Validée avec Mention" si score >= 70 points.
- Niveau 3 : Trophée d'école (ex: "Diplôme de l'école Primaire...") attribué tout à la fin dans le rapport global si le score est parfait.

### Fichiers modifiés
- `runner.js` (refactorisation de `runTierAttempt` + appel à `auto-updater.js` + gamification niveau 3).
- `auto-updater.js` (nouveau fichier d'injection dynamique).
- `report-generator.js` (prise en compte des points au lieu des pourcentages bruts).

### Résultat
- Le bug de blocage est corrigé, le modèle est désormais maître de sa progression.
- Les exercices d'algorithmique sont automatiquement ajoutés aux 16 JSONs au démarrage sans effort utilisateur.
- Le système de points et de trophées dynamise l'évaluation.
