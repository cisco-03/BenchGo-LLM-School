# Refactorisation du runner.js — 2026-07-07

## Problème initial

Le fichier `benchmark-v2/runner.js` contenait **1243 lignes** avec une accumulation de responsabilités variées :
- Configuration et constantes
- Parsing CLI
- UI console (barres, spinners)
- Parsing JSON/regex
- Moteur VM sandbox
- 5 évaluateurs personnalisés complexes
- Client API LM Studio
- Chargement de fichiers
- Génération de rapports
- Orchestration principale

## Motivation

- Difficile de trouver du code spécifique (trop de défilement)
- Risque de régressions lors de modifications
- Pas de séparation claire des responsabilités
- Temps de chargement mental pour chaque intervention

## Solution

### Principe appliqué : Single Responsibility Principle (SRP)
Chaque module a **une seule responsabilité** clairement définie par son nom.

### Nommage explicite
Les noms de fichiers décrivent exactement leur contenu :
- `config.js` → configuration
- `progress-bar.js` → barres de progression
- `parsing-utils.js` → utilitaires de parsing
- `vm-sandbox.js` → sandbox VM
- `custom-evaluators.js` → évaluateurs personnalisés
- `task-evaluator.js` → évaluateur de tâches
- `lm-studio-client.js` → client LM Studio
- `tier-loader.js` → chargeur de tiers
- `report-generator.js` → générateur de rapports

### Graphique de dépendances (simplifié)

```
runner.js (orchestrateur)
    ├── config.js (aucune dépendance)
    ├── progress-bar.js → config.js
    ├── parsing-utils.js (aucune dépendance)
    ├── vm-sandbox.js → config.js
    ├── custom-evaluators.js → vm-sandbox.js, parsing-utils.js, config.js
    ├── task-evaluator.js → parsing-utils.js, vm-sandbox.js, custom-evaluators.js, config.js
    ├── lm-studio-client.js → config.js, logger.js
    ├── tier-loader.js → logger.js
    └── report-generator.js → progress-bar.js (letterGrade)
```

Aucune dépendance circulaire. Le graphe est un DAG (Directed Acyclic Graph).

## Résultats

| Métrique | Avant | Après |
|----------|-------|-------|
| Lignes runner.js | 1243 | 225 |
| Nombre de fichiers | 3 (runner + logger + tiers/*.json) | 12 (9 modules + runner + logger + tiers/*.json) |
| Lignes max par fichier | 1243 | 318 (custom-evaluators.js) |
| Réduction runner.js | - | **82%** |

## Validation

Tous les fichiers ont passé la vérification syntaxique (`node --check`) sans erreur.

## Risques identifiés

1. **`custom-evaluators.js`** reste volumineux (318 lignes) car la logique métier des évaluations est intrinsèquement complexe. Une sous-décomposition supplémentaire est possible si ce fichier grossit.

2. **`report-generator.js`** importe `letterGrade` depuis `progress-bar.js`. Si le besoin de séparer les utilitaires UI des utilitaires de rapport apparaît, créer un fichier `grade-utils.js`.

## Prochaines étapes possibles

- Ajouter des tests unitaires par module
- Extraire `letterGrade()` dans un module utilitaire partagé si d'autres modules en ont besoin
- Documenter les évaluateurs custom avec des exemples JSDoc
