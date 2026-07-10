# Memories-BenchGo - Centre de Mémoire du Projet

Ce dossier sert de mémoire persistante pour le projet Local-LLM-Benchmark-V3 (BenchGo V3).

Les fichiers sources sont à la racine de `benchmark-v3/` (chemin historique `benchmark-v2` abandonné).

## Structure

```
Memories-BenchGo/
├── README.md              ← Ce fichier (index principal)
├── INSTRUCTIONS.md        ← Fichier d'instructions opérationnelles pour l'agent IA
├── CHANGELOG.md           ← Carnet de notes chronologique
├── architecture/          ← Documentation de l'architecture du projet
│   └── benchmark-v2.md    ← Architecture complète du moteur
├── refactorisations/      ← Historique des refactorisations
│   ├── 2026-07-07-runner-modularisation.md
│   ├── 2026-07-07-runner-rattrapage-interactif.md
│   └── 2026-07-08-retravail-tiers-export-rapports.md
├── issues-fixes/          ← Problèmes corrigés et solutions
│   ├── 2026-07-07-barre-progression-figee.md
│   ├── 2026-07-07-test-async-middleware-toujours-echec.md
│   ├── 2026-07-07-risque-depassement-contexte-16384.md
│   └── 2026-07-08-stripts-export-types-retour.md
└── conventions/           ← Conventions de code et patterns
```

## Architecture Scolaire (2026-07-08)

BenchGo V3 adopte une **métaphore scolaire** : chaque profil est une école, chaque tier est une
classe, avec des exercices distincts à chaque croisement.

| Profil | École | Classe 0 | Classe 1 | Classe 2 | Classe 3 |
|---|---|---|---|---|---|
| LIGHT | 🏫 Maternelle | Maternelle | CP | CE1 (opt) | CE2 (opt) |
| STANDARD | 🏫 Collège/Lycée | 6ème | 4ème | 2nde/Term | BTS/Prépa (opt) |
| EXPERT | 🎓 Université | Licence 1 | Licence 2 | L3/M1 | Master 2 |
| DOCTORAT | 🔬 Thèse | D1 | D2 | D3 | Soutenance |

### Fichiers de tiers (16 fichiers, exercices distincts par croisement)

```
tiers/
├── tier0_light.json      ← Maternelle   : addition, parité, inverser...
├── tier1_light.json      ← CP           : filtrer pairs, capitaliser...
├── tier2_light.json      ← CE1          : parenthèses, debounce, async...
├── tier3_light.json      ← CE2          : PowerShell, FloodFill...
├── tier0_standard.json   ← 6ème         : FizzBuzz, Fibonacci, palindrome...
├── tier1_standard.json   ← 4ème         : groupBy, memoize, chunk...
├── tier2_standard.json   ← 2nde         : pipeline, throttle, binary search...
├── tier3_standard.json   ← BTS/Prépa    : rate limiter, JWT, Observable...
├── tier0_expert.json     ← Licence 1    : curry, deep equal, BST...
├── tier1_expert.json     ← Licence 2    : priority queue, EventEmitter, BFS...
├── tier2_expert.json     ← L3/M1        : pool async, Subject, circuit breaker...
└── tier3_expert.json     ← Master 2     : FloodFill, middleware, SQL...
```

DOCTORAT utilise les fichiers EXPERT par fallback automatique (tier4/5 à créer).

## Navigation Rapide

- **Instructions pour l'agent IA** : Voir [INSTRUCTIONS.md](./INSTRUCTIONS.md)
- **Dernières modifications** : Voir [CHANGELOG.md](./CHANGELOG.md)
- **Architecture actuelle** : Voir [architecture/benchmark-v2.md](./architecture/benchmark-v2.md) (BenchGo V3, dossier technique `benchmark-v2`)
- **Refactorisations récentes** : Voir [refactorisations/](./refactorisations/)
- **Issues/fix récentes** : Voir [issues-fixes/](./issues-fixes/)

## Objectif de ce dossier

Cette mémoire permet de :
1. Retracer l'historique des modifications et décisions
2. Documenter l'architecture évolutive du projet
3. Noter les problèmes rencontrés et leurs solutions
4. Maintenir une cohérence dans les conventions de code
5. Faciliter le débogage en retrouvant rapidement le contexte

## Convention de nommage

- Fichiers de refactorisation : `{date}-{description-courte}.md` (ex: `2026-07-07-runner-modularisation.md`)
- Fichiers d'issues : `{date}-{issue-label}.md` (ex: `2026-07-07-fix-flood-fill-recursion.md`)
- Dates au format ISO : YYYY-MM-DD
