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
