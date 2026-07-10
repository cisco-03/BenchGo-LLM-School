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
│   ├── 2026-07-08-stripts-export-types-retour.md
│   ├── 2026-07-09-fix-runner-ce2-gamification.md
│   ├── 2026-07-09-sante-globale-tier6-5-axes.md
│   ├── 2026-07-10-stripts-casse-ternaires.md
│   └── 2026-07-10-boucle-infinie-reessai-aide-professeur.md
└── conventions/           ← Conventions de code et patterns
    └── 2026-07-10-nommage-rapports.md
```

## Architecture Scolaire (2026-07-08)

BenchGo V3 adopte une **métaphore scolaire** : chaque profil est une école, chaque tier est une
classe, avec des exercices distincts à chaque croisement.

| Profil | École | Classe 0 | Classe 1 | Classe 2 | Classe 3 | Classe 4 | Classe 5 | Classe 6 |
|---|---|---|---|---|---|---|---|---|
| LIGHT | 🏫 Primaire | Maternelle | CP | CE1 (opt) | CE2 (opt) | CM1 (opt) | CM2 (opt) | - |
| STANDARD | 🏫 Collège/Lycée | 6ème | 5ème | 4ème | 3ème (opt) | 2nde (opt) | 1ère (opt) | Terminale (opt) |
| EXPERT | 🎓 Université | Licence 1 | Licence 2 | L3/M1 | Master 2 | - | - | Doctorat (opt) |
| DOCTORAT | 🔬 Thèse | D1 | D2 | D3 | Soutenance | - | - | Expertise (obli) |
| FRONTIER | 🔬 Post-Doc | PostDoc1 | PostDoc2 | PostDoc3 | PostDoc4 | Frontier | - | Ultimate (obli) |

### Fichiers de tiers (16 fichiers, exercices distincts par croisement)

```
tiers/
├── tier0_light.json      ← Maternelle   : syntaxe basique...
├── tier1_light.json      ← CP           : logique élémentaire...
├── tier2_light.json      ← CE1          : variables...
├── tier3_light.json      ← CE2          : boucles/conditions...
├── tier4_light.json      ← CM1          : algorithmique simple...
├── tier5_light.json      ← CM2          : données...
├── tier0_standard.json   ← 6ème         : Math, Français, Géo, Histoire, Info...
├── tier1_standard.json   ← 5ème         : Math, Français, Physique, Anglais...
├── tier2_standard.json   ← 4ème         : Math, Français, Chimie, Géo, React...
├── tier3_standard.json   ← 3ème         : Math, Français, Histoire, SVT, Info...
├── tier4_standard.json   ← 2nde         : Math, Français, Physique, Langues, React...
├── tier5_standard.json   ← 1ère         : Math, Français, SVT, Histoire, Info...
├── tier0_expert.json     ← Licence 1    : curry, deep equal, BST...
├── tier1_expert.json     ← Licence 2    : priority queue, EventEmitter, BFS...
├── tier2_expert.json     ← L3/M1        : pool async, Subject, circuit breaker...
├── tier3_expert.json     ← Master 2     : FloodFill, middleware, SQL...
└── tier6_master.json     ← Master/Doc   : Needle in a Haystack, Contraintes, Robustesse, Optimisation...
```

DOCTORAT utilise les fichiers EXPERT par fallback automatique (tier4/5 à créer).

## Moteur Interactif & Gamification (Juillet 2026)

BenchGo V3 introduit une rupture majeure dans l'évaluation des modèles de langage en passant d'une exécution linéaire séquentielle à un **moteur de choix stratégique interactif**. 

### 1. Algorithme de Libre Choix Stratégique
Le runner n'impose plus l'ordre des tâches. Il présente un catalogue dynamique des exercices restants avec leurs valeurs respectives. Le modèle évalue lui-même ses forces et faiblesses pour décider quel exercice tenter en premier en formulant sa décision via la syntaxe `SELECTION: ID_EXERCICE`.

### 2. Attribution Aléatoire & Imprévisibilité
Pour tester la capacité d'adaptation et de discernement stratégique en temps réel :
- Chaque exercice reçoit une valeur de points **aléatoire comprise entre 30 et 60 points** au démarrage d'une session.
- Le seuil de validation d'un niveau (Tier) est de **70 points**.
- Les modèles performants peuvent ainsi valider une classe en seulement 2 ou 3 exercices bien ciblés.

### 3. Système de Santé Globale (Le Buffer d'Endurance)
Pour éviter qu'un bon modèle ne soit éliminé dès sa première erreur dans un niveau difficile :
- **Santé Globale (Persistante)** : Le modèle commence à 0 PV. Les succès lui font gagner des points (buffer). Les échecs ou réponses non exploitables déduisent des points.
- **Seuil d'Élimination** : Si la Santé Globale descend en dessous de **-100**, le modèle est exclu définitivement du banc de test (Game Over).

### 4. Trophées de Gamification
- **Niveau 1** : Micro-récompenses en console après chaque validation de tâche.
- **Niveau 2** : Mention "Classe Validée avec Mention" pour tout Tier validé (>= 70% des points de la classe).
- **Niveau 3** : Trophée d'école majeur ("Diplôme de l'école") octroyé en fin d'évaluation globale en cas de score parfait (100%).

### 5. Les 5 Axes d'Évaluation du Directeur
- **Axe 1 - Vitesse Inférence :** Mesure et affichage du temps de génération de l'API.
- **Axe 2 - Mémoire longue :** Capacité à retrouver une "aiguille" d'instruction au milieu d'un grand volume de texte.
- **Axe 3 - Optimisation VM :** Chronométrage de l'exécution du code dans la Sandbox VM avec limite de temps stricte (ex: max 35ms).
- **Axe 4 - Robustesse Injection :** Test d'immunité face à des ordres contraires injectés au milieu de l'énoncé.
- **Axe 5 - Respect des Contraintes :** Vérification par motif d'interdictions algorithmiques (ex: résoudre un tri sans `.sort()`).

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
