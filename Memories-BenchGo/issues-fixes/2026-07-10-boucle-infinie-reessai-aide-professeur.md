# 2026-07-10 — Boucle infinie de réessai + Système d'aide du professeur

## Symptôme
- Lors d'un test `node runner.js all --profile=STANDARD` sur le Tier 3 (Collège), le modèle échouait sur l'exercice `info` (erreur `élèves is not defined`).
- Le runner relançait indéfiniment le même exercice (jusqu'à 12 itérations via `attemptsLeft`), gaspillant des heures de calcul GPU.
- Le modèle n'avait aucun mécanisme pour demander de l'aide ou abandonner proprement.
- L'utilisateur ne pouvait pas valider manuellement si les points de pénalité devaient être comptabilisés.

## Cause racine
Dans `runner.js`, la fonction `runTierAttempt` utilise une boucle `while(attemptsLeft > 0 && availableTasks.length > 0)` avec `attemptsLeft = 12`. Les exercices échoués restaient indéfiniment dans `availableTasks` (seuls les exercices réussis étaient retirés). Ainsi, un exercice systématiquement échoué provoquait jusqu'à 12 réessais, chacun consommant un appel LLM complet (100+ secondes par appel).

Il n'existait aucun mécanisme de :
1. Limite de réessai par exercice (le compteur `attemptsLeft` est global au tier, pas par exercice).
2. Aide du professeur (indice) pour guider le modèle en rattrapage.
3. Validation manuelle des points par l'utilisateur après un échec définitif.

## Solution

### 1. Limite de réessai par exercice (`MAX_TASK_RETRIES = 1`)
- Ajout de la constante `MAX_TASK_RETRIES = 1` dans `runner.js`.
- Suivi par exercice via `taskRetryMap[taskId]` (incrémenté à chaque échec).
- Premier échec (`retryCount = 1`) : pénalité appliquée, exercice conservé pour un réessai.
- Deuxième échec (`retryCount > MAX_TASK_RETRIES`, soit `retryCount = 2`) : échec définitif, l'exercice est retiré de `availableTasks` via `permanentlyFailedIds`.
- L'élève déclare abandonner : `🏳️ L'élève déclare avoir terminé`.

### 2. Validation manuelle des points
- Après un échec définitif, `askYesNo()` demande à l'utilisateur : `Comptabiliser la pénalité de -X points pour l'exercice Y ?`
- Si refus : la pénalité du premier échec est annulée (`tierScore += pts`).
- En mode non-TTY : la pénalité est automatiquement annulée (sécurité).

### 3. Système d'aide du professeur
- Au début de chaque itération de rattrapage, le runner envoie un prompt séparé au modèle :
  `Voulez-vous recevoir cet indice ? (AIDE_OUI / AIDE_NON)`
- Parsing de la réponse : `AIDE_OUI` détecté, ou `oui`/`yes` sans `AIDE_NON`.
- Si accepté : un indice est inclus dans le prompt de réessai (champ `hint` du JSON du tier, ou indice généré depuis l'erreur précédente via `taskLastError`).
- L'aide n'est proposée qu'une seule fois par exercice (`taskHelpOffered`).

### 4. Annotations de score « avec aide et rattrapage »
- `evalResultsMap` remplace le tableau `evalResults` : une entrée finale par exercice avec `helpUsed` et `retried` booléens.
- `buildTierReport` (report-generator.js) affiche `*(avec aide)*` et `*(rattrapage)*` par exercice et `(avec aide (N), avec rattrapage (N))` au niveau du tier.
- `printScorecard` et `buildScorecardReport` affichent les annotations par tier dans le tableau récapitulatif.
- Le score global CLI et Markdown stipule `⚠ Score obtenu avec aide (N) et rattrapage (N)`.

### 5. Champs `hint` dans les tiers JSON
- Ajout d'indices pour les 10 exercices de `tier3_standard.json` (math, français, histoire, SVT, info + 5 algo).
- Les indices guident sans donner la réponse (ex: « Utilisez .filter() puis .map() »).
- Pour les tiers sans champ `hint`, un indice générique est créé depuis l'erreur précédente.

## Fichiers modifiés
- `runner.js` — constante `MAX_TASK_RETRIES`, `evalResultsMap`, `taskRetryMap`, `taskNetPoints`, `taskHelpUsed`, `taskHelpOffered`, `taskLastError`, logique d'aide du professeur, validation des points, annotations CLI
- `report-generator.js` — paramètre `stats` dans `buildTierReport`, annotations `(avec aide)` / `(rattrapage)`
- `tiers/tier3_standard.json` — champs `hint` pour les 10 exercices

## Validation
- `node -c runner.js` : SYNTAX OK
- `node -c report-generator.js` : SYNTAX OK
- `JSON.parse(tier3_standard.json)` : JSON valide
- Vérification du flux logique : 1er échec → réessai → 2ème échec → abandon + askYesNo → retrait de l'exercice

## Leçons apprises
- Un compteur global d'essais (`attemptsLeft`) ne suffit pas : il faut un suivi par exercice pour éviter les boucles infinies sur un exercice récalcitrant.
- Le professeur (système) doit pouvoir interagir avec l'élève (modèle) de manière pédagogique : proposer une aide avant de laisser échouer définitivement.
- L'utilisateur doit garder le contrôle final sur la validation des points : le modèle peut échouer, mais c'est le professeur humain qui décide de la sanction.
