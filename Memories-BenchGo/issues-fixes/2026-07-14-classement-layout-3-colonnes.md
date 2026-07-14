# Déplacé

Ce document a été intégré et étendu sous forme de carte mentale dans la section dédiée :
👉 [classement-leaderboard.md](../carte-mentale/classement-leaderboard.md)




## NOTES PERSONNELLES

### 2026-07-14 — Session : Nouvelle disposition sur 3 colonnes du Classement
- Réorganisation de la section `.args-section` (forces, faiblesses, détails par école) en une grille CSS Grid à 3 colonnes responsives.
- Création d'une carte mentale décrivant la structure et le débogage du classement sous [carte-mentale/classement-leaderboard.md](./carte-mentale/classement-leaderboard.md).


### 2026-07-07 — Session initiale
- **Projet** : Local-LLM-Benchmark-V3 (BenchGo V3)
- **Langage** : JavaScript (Node.js)
- **API cible** : LM Studio (localhost:1234)
- **Structure** : benchmark-v2/ (nom technique historique) contient 9 modules + runner.js
- **Dossier memoire** : Memories-BenchGo/ créé ce jour
- **État** : Refactorisation complète du runner.js terminée (1243 → 225 lignes)
- **À surveiller** : custom-evaluators.js (318 lignes) pourrait nécessiter sous-décomposition future

### 2026-07-07 — Session 2 : extension des tiers + fix barre de progression
- Ajout de 8 nouvelles tâches réparties sur les 4 tiers (débogage, async avancé, sécurité XSS/injection)
- `task-evaluator.js` et `custom-evaluators.js` supportent désormais des évaluateurs `custom` async
- Bug corrigé : test `exec` de tache_3c toujours en échec (Promise jamais résolue en VM synchrone)
- Bug corrigé : barre de progression CLI figée (yield manquant vers l'event loop)
- Voir `CHANGELOG.md` et `issues-fixes/` pour le détail complet
- **À surveiller** : custom-evaluators.js a grossi avec les 4 nouveaux évaluateurs async + helpers ; envisager une sous-décomposition (ex: `async-evaluators.js`) si le fichier continue de croître

### 2026-07-10 — Session : fix stripTS ternaires + tableau des scores CLI
- Bug critique `stripTS` : la règle 8 (regex) cassait les opérateurs ternaires (`? a : b` → `? a`) et les littéraux objet. Remplacée par un scanner contextuel `stripTypeAnnotations()`.
- Ajout d'un tableau des scores persistant dans le CLI : récapitulatif après chaque tier + total d'école en fin de run (CLI + rapport Markdown).
- **Leçon clé** : le code affiché dans les rapports n'est PAS le code exécuté en VM (stripTS est appliqué entre les deux). Pour déboguer une `SyntaxError`, inspecter le code après `stripTS`.
- Voir `issues-fixes/2026-07-10-stripts-casse-ternaires.md` pour le détail complet.

### Patterns à retenir
- Le projet utilise un système de profils (LIGHT/STANDARD/EXPERT) basé sur la taille du modèle
- Les évaluateurs custom sont complexes par nature (simulation React, RFC 7946, etc.)
- Le dossier tiers/ est purement déclaratif (JSON de configuration)
- Architecture modulaire avec dépendances en DAG (pas de cycles)

---
