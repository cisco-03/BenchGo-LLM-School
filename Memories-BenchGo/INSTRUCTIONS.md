# INSTRUCTIONS PERSONNELLES — Agent IA BenchGo

**Ce fichier est ma mémoire opérationnelle. À relire au début de chaque session.**

---

## RÈGLES D'OR — À appliquer systématiquement

### 1. APRÈS CHAQUE MODIFICATION DE CODE

- [ ] **Mettre à jour `CHANGELOG.md`** avec :
  - Date au format ISO (YYYY-MM-DD)
  - Contexte du changement
  - Fichiers modifiés
  - Résultat obtenu

- [ ] **Vérifier `README.md`** du dossier Memories-BenchGo :
  - La structure est-elle toujours à jour ?
  - Faut-il ajouter un nouveau sous-dossier ?
  - Les liens de navigation fonctionnent-ils ?

- [ ] **Mettre à jour l'architecture** (`architecture/benchmark-v2.md`) si :
  - Un nouveau module est créé
  - Un module est supprimé
  - Les dépendances changent
  - Le flux d'exécution est modifié

### 2. APRÈS UN BUG CORRIGÉ

- [ ] **Créer un fichier dans `issues-fixes/`** :
  - Nom : `{date}-{description-courte}.md`
  - Contenu :
    - Symptôme observé
    - Cause racine identifiée
    - Solution appliquée
    - Fichiers modifiés
    - Leçons apprises

### 3. APRÈS UNE REFACTORISATION

- [ ] **Créer un fichier dans `refactorisations/`** :
  - Nom : `{date}-{description-courte}.md`
  - Contenu :
    - Problème initial (métriques avant)
    - Solution appliquée
    - Résultats (métriques après)
    - Validation effectuée
    - Risques identifiés
    - Prochaines étapes possibles

### 4. LORSQU'UNE CONVENTION EST ÉTABLIE

- [ ] **Documenter dans `conventions/`** :
  - Conventions de nommage
  - Patterns de code récurrents
  - Styles adoptés
  - Règles spécifiques au projet

---

## CHECKLIST DE FIN DE SESSION

Avant de terminer une session de travail, vérifier :

- [ ] Tous les changements sont-ils documentés dans Memories-BenchGo ?
- [ ] Le CHANGELOG reflète-t-il l'état actuel du projet ?
- [ ] L'architecture documentée correspond-elle au code réel ?
- [ ] Les problèmes rencontrés sont-ils tracés dans issues-fixes ?
- [ ] Les décisions importantes sont-elles notées quelque part ?

---

## NOTES PERSONNELLES

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

## RAPPELS IMPORTANTS

> **"Si ce n'est pas documenté, ça n'a pas été fait."**

Chaque modification = mise à jour de la mémoire.
La mémoire est la clé pour maintenir la cohérence sur le long terme.
Un futur moi (ou un autre agent) dépendra de la qualité de cette documentation.

---

## STRUCTURE DE FICHIERS TYPES

### Template pour issue-fix
```markdown
# {Date} — {Titre Court}

## Symptôme
[Description du problème observé]

## Cause racine
[Analyse de l'origine du bug]

## Solution
[Description de la correction appliquée]

## Fichiers modifiés
- fichier1.js
- fichier2.js

## Validation
[Comment la correction a été testée]

## Leçons apprises
[Ce qu'on retient pour l'avenir]
```

### Template pour refactorisation
```markdown
# Refactorisation — {Date}

## Problème initial
[Métriques et description]

## Motivation
[Pourquoi cette refactorisation]

## Solution
[Principes appliqués, structure]

## Résultats
| Métrique | Avant | Après |
|----------|-------|-------|

## Validation
[Tests effectués]

## Risques
[Points de vigilance]
```

---

**Fin des instructions. Ce fichier est vivant : à enrichir avec l'expérience.**
