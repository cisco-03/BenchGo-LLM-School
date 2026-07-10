# 2026-07-07 — Dossier `benchmark-v2/` entièrement disparu du disque

## Symptôme

```
node benchmark-v2/runner.js all --profile=STANDARD
Error: Cannot find module 'C:\Users\Flexodiv\Desktop\Local-LLM-Benchmark-V3\benchmark-v2\runner.js'
```

Le dossier `benchmark-v2/` (moteur complet : `runner.js` + 10 modules + `tiers/*.json`) était
**totalement absent** du dossier `Local-LLM-Benchmark-V3/`, alors que toute la documentation
dans `Memories-BenchGo/` (architecture, changelog, refactorisations) le décrivait comme existant
et à jour.

## Cause racine

- Le projet a été renommé/déplacé de `Desktop\Local-LLM-Benchmark` vers
  `Desktop\Local-LLM-Benchmark-V3` (confirmé par l'historique local VS Code qui référence les deux
  chemins). Le dossier technique `benchmark-v2/` ne s'est pas retrouvé dans le nouveau dossier lors
  de cette opération — probablement une copie/déplacement partiel ayant oublié ce sous-dossier.
- Aucun dépôt Git n'était initialisé dans `Local-LLM-Benchmark-V3` (`git status` → "not a git
  repository"), donc aucune récupération possible par cette voie.
- L'utilisateur a indiqué avoir publié ce dossier publiquement sans avoir remarqué l'absence du
  moteur : **le dépôt public est probablement incomplet lui aussi** et doit être resynchronisé
  après cette correction.

## Solution appliquée

Récupération via l'**historique local de VS Code** (`%APPDATA%\Code\User\History\`), qui conserve
des snapshots horodatés de chaque fichier sauvegardé via l'éditeur/Copilot, indépendamment de Git :

1. Recherche de tous les `entries.json` référençant `benchmark-v2` dans leur chemin `resource`.
2. Identification de la version la plus récente (timestamp le plus élevé) pour chaque fichier.
3. Copie directe (`Copy-Item`, pas de relecture/réécriture via l'agent) des snapshots vers
   `benchmark-v2/` pour préserver le contenu exact (notamment les prompts JSON très longs).

Fichiers **restaurés à l'identique** depuis l'historique :
- `runner.js`, `config.js`, `task-evaluator.js`, `vm-sandbox.js`, `custom-evaluators.js`,
  `lm-studio-client.js`
- `tiers/tier0_easy.json`, `tiers/tier1_medium.json`, `tiers/tier2_hard.json`,
  `tiers/tier3_expert.json`

Fichiers **reconstruits manuellement** (aucun snapshot trouvé dans l'historique — probablement
créés une seule fois sans modification ultérieure, donc jamais capturés) :
- `logger.js`, `progress-bar.js`, `parsing-utils.js`, `tier-loader.js`, `report-generator.js`

Reconstruction basée sur : la documentation `architecture/benchmark-v2.md`, les appels observés
dans les fichiers récupérés (signatures exactes des fonctions/classes utilisées), et les
conventions de style déjà en place (couleurs ANSI, structure des logs, etc.).

## Validation

- `node --check` sur les 11 fichiers `.js` → tous OK.
- Validation JSON (`ConvertFrom-Json`) sur les 4 fichiers `tiers/*.json` → tous OK.
- Exécution réelle `node benchmark-v2/runner.js 0 --profile=STANDARD` → démarrage correct,
  chargement des tiers OK, appel API LM Studio lancé (attente normale, LM Studio non démarré dans
  cet environnement de test). Plus aucune erreur `MODULE_NOT_FOUND`.

## Fichiers modifiés / créés

- `benchmark-v2/*.js` (11 fichiers), `benchmark-v2/tiers/*.json` (4 fichiers) — dossier recréé
  intégralement.

## Leçons apprises

- **Toujours initialiser un dépôt Git dès la création d'un projet**, même local — c'est le seul
  filet de sécurité fiable en cas de suppression/déplacement accidentel.
- L'historique local VS Code (`%APPDATA%\Code\User\History\`) est un filet de secours précieux
  mais **partiel** : il ne capture que les fichiers sauvegardés au moins une fois après leur
  création initiale. Les fichiers créés puis jamais réédités peuvent ne laisser aucune trace.
- Avant de renommer/déplacer un dossier de projet entier, vérifier explicitement qu'aucun
  sous-dossier n'a été oublié (`Get-ChildItem -Recurse` avant/après comparaison).
- **Action de suivi requise par l'utilisateur** : puisque ce dossier a été publié en public sans
  `benchmark-v2/`, il faut committer et repousser le dépôt public avec les fichiers restaurés.
