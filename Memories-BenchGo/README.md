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
├── carte-mentale/         ← Cartes mentales et guides visuels de la structure
│   └── classement-leaderboard.md  ← Fonctionnement et débogage du classement HTML/CSS
├── refactorisations/      ← Historique des refactorisations
│   ├── 2026-07-07-runner-modularisation.md
│   ├── 2026-07-07-runner-rattrapage-interactif.md
│   ├── 2026-07-08-retravail-tiers-export-rapports.md
│   └── 2026-07-18-classement-html-condense-modale-filtres.md
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

## Auto-Profilage & Calibration (2026-07-12)

BenchGo interroge le modèle au démarrage pour qu'il s'auto-évalue sur 4 compétences clés
(niveau 1 à 5), puis filtre les tâches trop difficiles selon cette déclaration. En fin de run,
un **Indice de Calibration** C = 1 - |D - P| mesure l'écart entre les capacités déclarées (D)
et la performance réelle (P) dans le bac à sable.

| Compétence | Tâches associées |
|---|---|
| `javascript_basics` | Tâches algo simples + exec de base (par défaut) |
| `javascript_async` | Tâches custom async (tache_2a, tache_3e, tache_4c) |
| `algorithms_advanced` | Tier 4 frontier + algo_difficile/defi + tier 6 |
| `code_debugging` | Débogage/sécurité (tache_1d, 2d, 2e, 3a-f) |

**Interprétation de C** : ≥0.85 « Modèle Hautement Fiable / Lucide » · 0.65-0.85 « Modérément
Calibré » · <0.65 « Biais de Surconfiance ou Sous-confiance Majeur ».

Configuration : `config.js → selfProfiling` (`enabled`, `minLevelToTest`, `bypassFilter`).
Échec non fatal (graceful degradation) : si le modèle ne supporte pas le JSON, le benchmark
se déroule normalement avec toutes les tâches.

## Navigation Rapide

- **README GitHub (racine projet)** : Voir [../README.md](../README.md) — présentation du projet pour GitHub
- **Instructions pour l'agent IA** : Voir [INSTRUCTIONS.md](./INSTRUCTIONS.md)
- **Dernières modifications** : Voir [CHANGELOG.md](./CHANGELOG.md)
- **Architecture actuelle** : Voir [architecture/benchmark-v2.md](./architecture/benchmark-v2.md) (BenchGo V3, dossier technique `benchmark-v2`)
- **Carte mentale du classement** : Voir [carte-mentale/classement-leaderboard.md](./carte-mentale/classement-leaderboard.md) (structure & débogage du HTML)
- **Refactorisations récentes** : Voir [refactorisations/](./refactorisations/)
- **Issues/fix récentes** : Voir [issues-fixes/](./issues-fixes/)

## Classement des modèles (Leaderboard)

BenchGo génère un **classement global** de tous les modèles testés, du meilleur au pire,
à la fin de chaque run complet (`tierArg === "all"`). Le classement peut aussi être
régénéré manuellement via `node leaderboard.js`.

### Fichiers produits (à la racine de `Export-Rapports/`, écrasés à chaque génération)
- `classement.html` — classement visuel **interactif et condensé** (une ligne par modèle, modale de détail au clic, filtres, recherche)
- `classement.md` — classement Markdown tabulaire + détail par modèle
- `raisonnement_modeles.md` — raisonnements & réponses détaillés par modèle (destiné à NotebookLM via Gemini)

### Interface HTML (refonte 2026-07-18)
- **Cartes condensées** : une ligne compacte par modèle — rang/médaille, nom, icône catégorie, badge taille, mini-stats (% avec barre, Note, Santé, Oblig., Aide/Rat.), boutons « Détails » et « 🗑 ».
- **Modale de détail** : au clic sur une carte ou sur « Détails », ouverture d'une modale avec statistiques complètes, forces/faiblesses/notes, tableau détaillé par école (avec calibration et date), et méta (dernière mise à jour, nom court). Fermeture par clic overlay, bouton × ou touche Échap.
- **Filtres par catégorie** (5 niveaux de performance) : 🏆 Top du top (≥90%) · ✅ Recommandés (≥80%) · 📊 Dans la moyenne (≥70%) · ⚠️ En rattrapage (≥50%) · 💥 Échec total (<50%).
- **Filtres par taille de paramètres** (5 catégories, mêmes seuils que les profils d'école) : 🐱 < 3B · 📦 3B-14B · 🎓 14B-30B · 🧠 > 30B · ❓ Inconnue.
- **Recherche texte** : filtre par nom intégral ou nom court. Combinable avec les deux filtres (ET logique).
- **Données côté client** : les données complètes de chaque modèle sont sérialisées en JSON dans `var MODELS` — le fichier HTML est autonome et ouvrable hors-ligne (aucune dépendance externe, CSS+JS embarqués).

### Caractéristiques techniques
- **Source des données** : carnets de scores persistants `Export-Rapports/.carnet/<modele>.json`
- **Tri** : % décroissant, puis score, puis santé globale
- **Détection de taille** : `getParamSize()` réutilise `detectProfileFromModelName` de `config.js` (déduction depuis le nom du modèle)
- **Arguments qualitatifs** : forces et faiblesses générés automatiquement (maîtrise, obligatoire, bonus, aide, rattrapage, santé, calibration)
- **Détection de doublon** : si un modèle a déjà été testé sur la même école, le runner alerte l'utilisateur et propose de forcer un re-test (le nouveau score remplace l'ancien)
- **Mode interactif** : `node leaderboard.js --serve` démarre un serveur sur http://localhost:3939 avec boutons de suppression actifs dans le navigateur

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
