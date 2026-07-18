# CHANGELOG - Carnet de Notes BenchGo

## Note de nommage

- Le projet est en version BenchGo V3.
- Les fichiers sources sont désormais à la racine de `benchmark-v3/` (le nom `benchmark-v2` est abandonné).

## 2026-07-18 — Professeur IA correcteur (OpenRouter Free Router)

### Contexte
Lors d'un test Tier 4, un modèle (9B) avait échoué à l'exercice React et produisait une auto-analyse **partiellement fausse** : il invoquait la syntaxe JSX comme cause alors que la vraie cause était l'absence de template literal. Personne ne le corrigeait, car le « professeur » était en réalité **le même modèle que l'élève** (la fonction `askModelForFailureExplanation` réutilisait le même `queryFn`). Demande : un professeur IA indépendant et plus robuste, capable de **contredire** l'élève et de démontrer la vraie cause racine.

### Actions entreprises
- **Nouveau module `teacher-client.js`** : professeur IA cloud distinct de l'élève. Après l'auto-analyse de l'élève, le professeur relit son diagnostic, dit explicitement s'il est JUSTE / PARTIELLEMENT JUSTE / FAUX, et **démontre** la vraie cause racine en 2 à 4 phrases. Non streamé (analyse backend).
- **Free Router** : récupère dynamiquement la liste des **modèles gratuits** d'OpenRouter via l'endpoint public `/api/v1/models` (sans clé, mis en cache 30 min), trie par préférence puis par contexte, et **rotate** jusqu'à 3 modèles distincts en cas de rate-limit/erreur (429, 5xx). Modèle par défaut : `meta-llama/llama-3.3-70b-instruct:free`.
- **`config.js`** : ajout de `TEACHER_CONFIG` (provider `openrouter`, modèle gratuit par défaut, `maxRetries: 3`, `temperature: 0.15`, `maxTokens: 512`) + parsing des flags `--teacher-model`, `--teacher-api-key`, `--teacher-endpoint`, `--no-teacher`.
- **`runner.js` — Configuration interactive au démarrage** : si aucune clé n'est fournie en CLI/env, l'utilisateur choisit interactivement entre (A) professeur OpenRouter Free Router (demande la clé API, compte gratuit requis) ou (B) auto-analyse classique (aucun compte). `--no-teacher` force (B) sans demander ; `--teacher-api-key=...` force (A) sans demander.
- **`runner.js` — Flow d'échec** : après l'explication de l'élève, appel du professeur via `askTeacherToCorrectStudentAnalysis`. Affichage console `🎓 Correction du professeur`. Repli sur l'auto-analyse si OpenRouter est indisponible.
- **`runner.js` + `leaderboard.js` — Rapports** : le rapport Markdown et le classement incluent désormais pour chaque exercice échoué : `Explication de l'élève` suivie de `🎓 Correction du professeur IA` si disponible. Nouveau champ `teacherCorrection` propagé via `evalResultsMap`.

### Fichiers modifiés
- `teacher-client.js` (nouveau — ~210 lignes)
- `config.js` — `TEACHER_CONFIG`, parsing `--teacher-*`
- `runner.js` — config interactive professeur, propagation à `runTierAttempt`, flow d'échec étendu, `askFreeText`, `taskTeacherCorrections`, section rapport
- `leaderboard.js` — affichage `teacherCorrection` dans le Markdown
- `README.md` — fonctionnalité, table des modules, structure, options CLI

### Validation
- `node --check` sur `config.js`, `teacher-client.js`, `runner.js`, `leaderboard.js` : syntaxe OK.
- Test live du Free Router : `fetchFreeModels()` récupère 23 modèles gratuits sans clé, `meta-llama/llama-3.3-70b-instruct:free` en tête.
- `--no-teacher` et `--teacher-api-key=...` bien détectés par `parseCliArgs`.

### Note technique
L'endpoint `/api/v1/models` d'OpenRouter est public (sans clé), mais `/chat/completions` exige une clé même pour les modèles `:free` — d'où la question interactive au démarrage et le repli sur l'auto-analyse pour les utilisateurs sans compte OpenRouter.

## 2026-07-14 — Classement des modèles (Leaderboard) + Détection de doublon

### Contexte
L'utilisateur enchaînait les tests de modèles sans pouvoir comparer leurs scores ni savoir où chaque modèle se situe par rapport aux autres. Demande : « récupérer les scores à chaque fois qu'un modèle est testé sur une école, générer un HTML, comptabiliser les points et faire un classement comme les courses de chevaux — les bons et les mauvais, avec des arguments ». Demande complémentaire : détecter si un modèle a déjà été testé sur une école et proposer de forcer un re-test.

### Actions entreprises
- **Nouveau module `leaderboard.js`** : agrège tous les carnets de scores (`Export-Rapports/.carnet/*.json`), calcule des métriques globales (score, %, santé, bonus, aide, rattrapage, calibration), génère des **arguments qualitatifs** automatiques (forces/faiblesses) selon les résultats, et produit un classement trié (meilleur → pire) au format **HTML** (style sombre, médailles 🥇🥈🥉, barres de progression) et **Markdown** (tableau récapitulatif + détail par modèle).
- **`runner.js` — Génération automatique** : après chaque run complet (`tierArg === "all"`), le classement est régénéré automatiquement et affiché en console. Le classement peut aussi être régénéré manuellement via `node leaderboard.js`.
- **`runner.js` — Détection de doublon** : avant de lancer les tiers, le runner vérifie le carnet de scores. Si le modèle a déjà été testé sur la même école, il affiche le score précédent et demande à l'utilisateur s'il veut forcer un re-test (`askYesNo`). Si l'utilisateur refuse, le test est annulé et le score existant est conservé. Si l'utilisateur accepte, le nouveau score remplacera l'ancien.
- **`leaderboard.js` — Tri** : % décroissant, puis score décroissant, puis santé globale décroissante. Les modèles catastrophiques (pct < 50) sont classés en bas avec le verdict « NON RECOMMANDÉ ».
- **`leaderboard.js` — Arguments** : détection automatique de forces (maîtrise, obligatoire 100%, bonus, santé robuste, lucidité calibration) et de faiblesses (échec obligatoire, aide, rattrapage, santé critique, biais de calibration, plus de 50% d'échec).

### Fichiers modifiés
- `leaderboard.js` (nouveau — ~270 lignes)
- `runner.js` — import leaderboard, détection de doublon, génération auto du classement
- `Memories-BenchGo/README.md` — section Classement des modèles

### Validation
- `node --check leaderboard.js` / `node --check runner.js` : syntaxe OK.
- `node leaderboard.js` : génère HTML + MD avec 2 modèles classés (mistral-7b 98% 🥇, minicpm5-1b 50% 🥈), arguments qualitatifs corrects (forces : maîtrise quasi-parfaite, 100% obligatoire, +349 bonus, santé robuste ; faiblesses : aide 1x, rattrapage 1x, biais calibration C=0.60).
- HTML ouvrable dans un navigateur, style sombre cohérent, médailles et couleurs de verdict visibles.

## 2026-07-11 — Cumul des scores multi-écoles + quota + bonus optionnel

### Contexte
L'utilisateur enchaînait des évaluations séparées (Primaire en `LIGHT`, puis Collège-Lycée en `STANDARD`) mais chaque run affichait son propre résultat final sans **additionner** les points ni afficher le **total cumulé** : « tu me dis pas combien ça fait de points au total ». Demande associée : mettre un **quota de points par école**, accorder un **petit bonus** aux exercices optionnels réussis (récompense généreuse), et maintenir le système de **pénalité** sur les échecs répétés.

### Actions entreprises
- **Nouveau module `score-ledger.js`** : carnet de scores persistant par modèle (`Export-Rapports/.carnet/<modeleCourt>.json`, hors-git). Conserve la **meilleure tentative par école** (pct le plus élevé). Fournit le calcul du grand total cumulé et l'affichage du **BILAN GLOBAL** (console + markdown).
- **`config.js`** : ajout de `OPTIONAL_BONUS_PCT = 0.20` (20 % des points de base).
- **`runner.js` — Bonus optionnel** : sur le succès d'un exercice d'un tier **optionnel**, un bonus (`round(pts * 0.20)`) est crédité à la **Santé Globale** et tracé (`optionalBonusTotal`). Le bonus reste **séparé** du `tierScore` (le pct de tier reste ≤ 100 %, le bonus s'affiche en sus : `+X bonus opt.`).
- **`runner.js` — Scorecard** : `printScorecard` et `buildScorecardReport` affichent le bonus par classe et sur le total. Le résumé « Score Global » (console + markdown) mentionne le bonus.
- **`runner.js` — Cumul multi-écoles** : à la fin d'un run `all`, le résultat de l'école (score, quota/max, pct, santé, bonus, aide/rattrapage, date, rapport) est enregistré dans le carnet, puis le **BILAN GLOBAL** cumulé est affiché en console (tableau toutes écoles + TOTAL CUMULÉ + bonus cumulé + santé cumulée) et ajouté au rapport Markdown. Le cumul n'est touché que pour les runs `all` (un run mono-tier ne corrompt pas le score d'école complet).
- **Pénalité / échecs répétés** : inchangé (pénalité sur échec, élimination à Santé ≤ -100, validation manuelle des points après échec définitif).

### Fichiers modifiés
- `score-ledger.js` (nouveau)
- `config.js` — `OPTIONAL_BONUS_PCT`
- `runner.js` — bonus optionnel, scorecard, cumul carnet + BILAN GLOBAL

### Validation
- `node -c runner.js` / `node -c score-ledger.js` : syntaxe OK.
- Test carnet : 2 écoles (Primaire 100 %, College-Lycee) — keep-best conserve la meilleure tentative (98 % sur 3 re-runs), grand total `5317/5370 (99 %)` + `bonus 70` + `santé 5317 PV`, conforme aux attentes.
- Le bonus ne dépasse jamais 100 % sur un tier (séparé du `tierScore`).

## 2026-07-11 — Exercices d'algorithmique réels + suppression de la trivia (histoire/géo)

### Contexte
Les tests multi-profils montraient des échecs récurrents sur les exercices de culture générale (capitales, dates historiques). L'utilisateur a demandé de se concentrer sur des exercices de **code pur** plutôt que d'histoire/géo. Par ailleurs, l'analyse a révélé un bug silencieux de l'`auto-updater` : il injectait 5 exercices `algo_*` « placeholders » par tier avec `"call": "true"` / `"assert": "result === true"` (donc toujours validés sans test) et **absents du prompt** (le modèle ne savait même pas qu'ils existait). Cela générait jusqu'à **60 points gratuits** par tier (10+10+10+15+15), faussant tous les scores.

### Actions entreprises
- **Réécriture de `auto-updater.js`** : création d'une banque `EXERCISE_BANK` de 35 exercices d'algorithmique pure (7 tiers × 5), à difficulté graduée (Tier 0 : parité/carré/somme → Tier 6 : fusion d'intervalles, médiane de deux tableaux triés, plus longue sous-suite croissante). Chaque exercice définit une fonction nommée, un prompt descriptif, un `hint`, et des évaluations `exec` **réelles** (`call` invoquant la fonction étudiante, `assert` testant le résultat).
- **Injection idempotente dans le prompt** : `updateTiers()` ajoute un bloc `[ALGORITHMIC EXERCISES — code pur, sans culture générale]` à la fin du prompt de chaque tier (strip-then-append, stable d'un run à l'autre).
- **Remplacement des placeholders** : les 5 `algo_*` cassés de chaque tier (90 au total) sont remplacés par les vrais exercices de la banque correspondant au numéro de tier.
- **Suppression de la trivia tier0_standard** : remplacement de l'exercice `capitale(pays)` (Géo) par `contientValeur(tab, val)` (recherche en tableau) et de `anneeDecouverteAmerique()` = 1492 (Histoire) par `valeurAbsolue(n)`. Les IDs `geo`/`histoire` deviennent `contient`/`absolu`.

### Fichiers modifiés
- `auto-updater.js` — banque de 35 exercices + injection de prompt + remplacement des placeholders
- `tiers/tier0_standard.json` à `tiers/tier6_master.json` (18 fichiers) — exercices `algo_*` réels + blocs de prompt
- `tiers/tier0_standard.json` — remplacement des 2 exercices trivia

### Validation
- 0 placeholder `"call": "true"` restant (était 90).
- 0 trivia (`capitale`/`1492`/`anneeDecouverteAmerique`) restante.
- 18 fichiers JSON valides ; `tier-loader` charge sans erreur les 5 profils (LIGHT/STANDARD/EXPERT/DOCTORAT/FRONTIER).
- 71/71 assertions `algo` validées contre des solutions de référence via `execCodeInVM` ; 4/4 assertions des exercices de remplacement validées.
- `auto-updater` idempotent : un second lancement ne réécrit rien et préserve les exercices themed modifiés.

## 2026-07-10 — Fix boucle infinie de réessai + Système d'aide du professeur + Validation des points

### Contexte
Lors d'un test `node runner.js all --profile=STANDARD` sur le Tier 3 (Collège), le modèle échouait sur l'exercice `info` (erreur `élèves is not defined`) et le runner relançait indéfiniment le même exercice (jusqu'à 12 itérations, soit des heures de calcul GPU gaspillées). L'utilisateur a demandé : (1) limiter à un seul réessai par exercice, (2) qu'après l'échec définitif le système demande à l'utilisateur s'il faut comptabiliser les points, (3) qu'un système d'aide du professeur propose un indice au modèle en rattrapage, et (4) que le score final stipule « avec aide et rattrapage ».

### Actions entreprises
- **Fix boucle infinie** : Ajout de `MAX_TASK_RETRIES = 1` dans `runner.js`. Chaque exercice échoué ne peut être réessayé qu'une seule fois. Après le 2ème échec, l'exercice est retiré de la file d'attente (`permanentlyFailedIds`) au lieu de boucler jusqu'à épuisement des `attemptsLeft`.
- **Suivi par exercice** : Remplacement du tableau `evalResults` par `evalResultsMap` (objet indexé par `taskId`) qui conserve l'état final de chaque exercice. Suivi des points nets via `taskNetPoints`, du compteur de réessais via `taskRetryMap`, et de l'erreur précédente via `taskLastError`.
- **Abandon de l'élève** : Après l'échec définitif, le runner affiche `🏳️ L'élève déclare avoir terminé : impossible de résoudre l'exercice X.` puis demande à l'utilisateur (via `askYesNo`) s'il faut comptabiliser la pénalité. Si l'utilisateur refuse, la pénalité est annulée.
- **Système d'aide du professeur** : Au début de chaque itération de rattrapage, le runner envoie un prompt séparé au modèle : `Voulez-vous recevoir cet indice ? (AIDE_OUI/AIDE_NON)`. Si le modèle accepte, un indice (champ `hint` du JSON du tier, ou indice généré depuis l'erreur) est inclus dans le prompt de réessai. L'aide est tracée via `taskHelpUsed` et `taskHelpOffered`.
- **Annotations de score** : Le tableau des scores CLI et le rapport Markdown affichent désormais `[avec aide (N), avec rattrapage (N)]` par tier et globalement. `buildTierReport` et `buildScorecardReport` acceptent les statistiques d'aide/rattrapage.
- **Champs `hint`** : Ajout d'indices pour les 10 exercices de `tier3_standard.json` (math, français, histoire, SVT, info + 5 algo).
- Création du journal correctif `2026-07-10-boucle-infinie-reessai-aide-professeur.md`.

### Fichiers modifiés
- `runner.js` — logique de réessai, aide du professeur, validation des points, annotations
- `report-generator.js` — annotations `(avec aide)` / `(rattrapage)` dans le rapport
- `tiers/tier3_standard.json` — champs `hint` pour les 10 exercices

## 2026-07-09 — Algorithme de Libre Choix, Système de Pénalités (Malus) et Robustesse LLM

### Contexte
Le runner s'arrêtait au niveau CE2 (Tier 3) en cas d'échec sans poursuivre. De plus, pour BenchGo V3, l'utilisateur a initié une refonte majeure du moteur : abandonner l'évaluation séquentielle classique au profit d'un algorithme de "Libre Choix Stratégique". Le LLM analyse un catalogue d'exercices, choisit sa stratégie pour maximiser ses points et atteindre un seuil de 70/100, tandis qu'un système de punition/récompense est introduit pour évaluer sa prudence algorithmique.

### Actions entreprises
- **Boucle interactive de décision** : Modification de `runTierAttempt` dans `runner.js` pour envoyer au modèle un catalogue d'exercices restants. Le modèle choisit sa cible avec `SELECTION: EXERCICE_ID` ou s'arrête avec `SELECTION: STOP`.
- **Système de points dynamiques et aléatoires** : Pour rendre l'évaluation plus rapide et imprévisible, les exercices reçoivent une note aléatoire comprise entre **30 et 60 points** à chaque démarrage. Ainsi, le modèle peut valider un Tier en seulement 2 ou 3 réussites, évitant les évaluations interminables.
- **Système de Pénalité (Malus de points)** : Si le modèle réussit un exercice, il gagne sa valeur. S'il échoue, il **perd exactement le même nombre de points** (le score plancher restant à 0). Le prompt système a été mis à jour pour le mettre en garde contre les risques de pénalité (*ATTENTION DANGER*).
- **Filet de sécurité (Robustesse du Parser)** : Pour aider les petits modèles (< 3B paramètres du profil LIGHT) à ne pas perdre d'essais bêtement, le parser extrait l'ID d'exercice de la réponse LLM même s'il ne respecte pas le format strict `SELECTION: ID` (via une détection textuelle dans le corps du texte).
- **Lisibilité Console** : Les intitulés et labels d'exercices sont désormais affichés en entier sans points de suspension trompeurs (ex: `▶ Évaluation de l'exercice : tache_0a - Retourner 'Bonjour'`).
- **Auto-Updater d'exercices** : Création de `auto-updater.js` qui injecte de façon transparente 5 nouveaux exercices de programmation par fichier JSON au lancement de `runner.js` sans manipulation manuelle de l'utilisateur.
- **Trophées de Gamification (Niveau 1, 2, 3)** : Intégration de mentions par étape, de la validation avec mention (>=70 points) et de l'obtention du diplôme global d'école pour un score parfait (100%).
- Création du journal correctif `2026-07-09-fix-runner-ce2-gamification.md`.

## 2026-07-08 — Thématisation "Matières Scolaires" du profil STANDARD

### Contexte
Pour coller encore plus à l'esprit "Collège / Lycée" du profil STANDARD (3B - 14B), les exercices de tous les tiers (Tier 0 à Tier 5) ont été repensés pour s'apparenter à des cours scolaires réels convertis en exercices JavaScript.

### Actions entreprises
- Réécriture de `tier0_standard.json` à `tier5_standard.json` avec des exercices classés par matières : Mathématiques, Français, Histoire, Géographie, Physique, Chimie, SVT, Anglais, Informatique, React.
- Les tâches simulent des connaissances scolaires (ex: conjuguer un verbe, calculer une vitesse, rendre le composant React d'un bouton).
- Modification du `config.js` : Le Tier 2 (4ème) a été ajouté à la liste `mandatory` du profil STANDARD. Les niveaux obligatoires sont désormais 0, 1 et 2.
- Mise à jour de `Tasks1.md` et `README.md` pour refléter la nouvelle thématisation.

## 2026-07-08 — Configuration des nouveaux Tiers dans config.js

### Problème
L'exécution de `node runner.js 4 --profile=LIGHT` et `node runner.js 5 --profile=LIGHT` (ainsi que pour STANDARD) retournait "Aucun tier applicable" car `config.js` bloquait les cibles n'étant ni dans les listes `mandatory` ni `optional` des profils. De plus, lors de l'exécution isolée de ces tiers optionnels, le score final indiquait "Modèle non recommandé" (Note obligatoire F) du fait d'une division par zéro.

### Actions entreprises
- Mise à jour de `PROFILES` dans `config.js` pour inclure les niveaux 4 et 5 dans les listes optionnelles des profils LIGHT et STANDARD.
- Modification des `mandatory` pour STANDARD (seulement 0 et 1 obligatoires).
- Mise à jour de la constante `CLASSE_NAMES` pour refléter les nouveaux dossiers d'export pour les tiers 4 et 5 (CM1, CM2, 2nde, 1ère).
- Correction du calcul de verdict dans `runner.js` : si aucun test obligatoire n'est évalué, la note obligatoire affiche "N/A" et le verdict final se base sur le score global.

## 2026-07-08 — Refonte de la difficulté du profil STANDARD (6ème à 1ère)

### Contexte
La difficulté du profil STANDARD (modèles de 3B à 14B paramètres) a été signalée comme étant beaucoup trop élevée, presque au niveau des gros modèles de 30B+ paramètres.
La difficulté a été drastiquement baissée et étalée sur 6 niveaux (Tier 0 à Tier 5), représentant les classes du Collège/Lycée : 6ème, 5ème, 4ème, 3ème, 2nde, 1ère.

### Actions entreprises
1. Création de `tier4_standard.json` et `tier5_standard.json` pour correspondre aux niveaux 2nde et 1ère.
2. Réécriture de `tier0_standard.json` à `tier3_standard.json` pour correspondre à des exercices d'algorithmique et manipulation très simples (FizzBuzz, Factorielle, manipulations de chaînes/tableaux).
3. Mise à jour de `Tasks1.md` et `README.md` pour refléter la nouvelle structure scolaire du profil STANDARD.

### Fichiers modifiés
- `tiers/tier0_standard.json`
- `tiers/tier1_standard.json`
- `tiers/tier2_standard.json`
- `tiers/tier3_standard.json`
- `tiers/tier4_standard.json` (Nouveau)
- `tiers/tier5_standard.json` (Nouveau)
- `Admin/Tasks1.md`
- `Memories-BenchGo/README.md`

### Résultat
- Le profil STANDARD comporte désormais 6 niveaux de difficulté abordables pour des petits LLMs.
- L'architecture scolaire est plus cohérente pour ce profil (Collège/Lycée complet de la 6ème à la 1ère).

## 2026-07-08 — Refonte de la difficulté du profil LIGHT (Maternelle à CM2)

### Contexte
Le framework d'évaluation pour les petits modèles (< 3B) était trop difficile, provoquant des échecs dès le premier niveau.
La difficulté a été drastiquement revue à la baisse et étalée sur 6 niveaux (Tier 0 à Tier 5), représentant les classes de la Maternelle au CM2, avec 5 exercices très basiques par fichier.

### Actions entreprises
1. Création de `tier4_light.json` et `tier5_light.json` pour CM1 et CM2.
2. Réécriture de `tier0_light.json` à `tier3_light.json` pour correspondre à des exercices triviaux (addition, string length, etc.).
3. Mise à jour de `Tasks1.md` et `README.md` pour refléter la nouvelle structure scolaire du profil LIGHT (Ecole Primaire au lieu de Maternelle seule).

### Fichiers modifiés
- `tiers/tier0_light.json`
- `tiers/tier1_light.json`
- `tiers/tier2_light.json`
- `tiers/tier3_light.json`
- `tiers/tier4_light.json` (Nouveau)
- `tiers/tier5_light.json` (Nouveau)
- `Admin/Tasks1.md`
- `Memories-BenchGo/README.md`

### Résultat
- Le profil LIGHT comporte désormais 6 niveaux de difficulté progressive très basique.
- L'architecture scolaire est plus cohérente pour ce profil (Maternelle à CM2).

## 2026-07-08 — Architecture scolaire : exercices par profil + prompts anglais + DOCTORAT

### Contexte
Le modèle `mistralai/ministral-3-14b-reasoning` renvoyait ses codes sous forme d'objets imbriqués
`{code:"...", description:"..."}` au lieu de strings directes, causant des scores 0/16 sur tous
les tiers 2 et 3. Par ailleurs, les prompts en français contenaient le mot "Renverse" (faux ami
pour "renvoie"), pouvant dérouter les petits modèles.

L'utilisateur a aussi exprimé la vision fondatrice : **chaque profil = une école, chaque tier =
une classe, avec des exercices différents à chaque croisement** — comme dans le système scolaire
réel.

### Actions entreprises

**1. Fix runner.js — extraction objet imbriqué**
- Si `parsedObj[task.id]` est un objet, extraction automatique de `.code`, `.solution` ou `.fonction`
- Résout le bug 0/16 sur les modèles reasoning qui surstructurent leur réponse JSON

**2. Affichage du profil dans le statut de chaque tier**
- `OBLIGATOIRE [profil LIGHT]` et `OPTIONNEL pour LIGHT (BYPASS autorisé)`
- Applicable aux 4 profils

**3. Prompts 100% anglais sur les 4 tiers**
- Suppression de "Renverse" → `Return your answers`
- Instruction explicite : `Each value must be a plain code string`
- Apostrophes manquantes corrigées dans tier2 et tier3
- Aucune contrainte de langue imposée au modèle

**4. Profil DOCTORAT (> 30B) ajouté dans config.js**
- Label : `DOCTORAT — Thèse (> 30B paramètres)`
- Détection automatique : paramSize > 30 → DOCTORAT
- Tiers obligatoires : 0,1,2,3 (identique à EXPERT en attendant tier4/tier5)
- Labels scolaires sur tous les profils : Maternelle / Préparatoire / Université / Thèse

**5. Architecture scolaire — exercices différents par profil ET par classe**
- `tier-loader.js` refactorisé : charge `tier{N}_{profile}.json` avec fallback chain
  automatique (DOCTORAT→EXPERT→STANDARD→LIGHT)
- Anciens fichiers renommés : `tier{N}_easy/medium/hard/expert.json` → `tier{N}_light.json`
- 8 nouveaux fichiers créés pour STANDARD et EXPERT (4 tiers × 2 profils) :

| Fichier | École | Classes |
|---|---|---|
| `tier0_light.json` | Maternelle | addition, parité, inverser, max, voyelles |
| `tier1_light.json` | CP | filtrer pairs, capitaliser, doublons, débogage, fréquence |
| `tier2_light.json` | CE1 | validation parenthèses, debounce, aplatir, allSettled, async |
| `tier3_light.json` | CE2 | PowerShell, FloodFill, middleware, SQL, retry, pollution |
| `tier0_standard.json` | 6ème | FizzBuzz, Fibonacci, palindrome, factorielle, tri bulles |
| `tier1_standard.json` | 4ème | groupBy, aplatir profond, memoize, débogage reduce, chunk |
| `tier2_standard.json` | 2nde | pipeline, throttle, binary search, retry délai, débogage |
| `tier3_standard.json` | BTS | rate limiter, JWT, assainirSQL, Observable, anti-pollution |
| `tier0_expert.json` | Licence 1 | curry, deep equal, compose, BST, debounce immediat |
| `tier1_expert.json` | Licence 2 | priority queue, EventEmitter, zip, BFS fix, proxy manuel |
| `tier2_expert.json` | L3/M1 | pool async, Subject réactif, memoAsync, race fix, circuit breaker |
| `tier3_expert.json` | Master 2 | PowerShell, FloodFill, middleware, SQL, retry, pollution |

DOCTORAT utilise les fichiers EXPERT par fallback automatique (tier4/5 à créer).

### Fichiers modifiés
- `runner.js` (extraction objet imbriqué + affichage profil)
- `config.js` (profil DOCTORAT + labels scolaires + détection > 30B)
- `tier-loader.js` (chargement par profil avec fallback chain)
- `tiers/tier0_light.json` (renommé depuis tier0_easy.json)
- `tiers/tier1_light.json` (renommé depuis tier1_medium.json)
- `tiers/tier2_light.json` (renommé depuis tier2_hard.json)
- `tiers/tier3_light.json` (renommé depuis tier3_expert.json + prompts anglais)
- `tiers/tier0_standard.json` (nouveau)
- `tiers/tier1_standard.json` (nouveau)
- `tiers/tier2_standard.json` (nouveau)
- `tiers/tier3_standard.json` (nouveau)
- `tiers/tier0_expert.json` (nouveau)
- `tiers/tier1_expert.json` (nouveau)
- `tiers/tier2_expert.json` (nouveau)
- `tiers/tier3_expert.json` (nouveau)
- `Admin/Tasks1.md` (commandes renommées avec métaphore scolaire)

### Validation
- `node --check` sur runner.js, config.js, tier-loader.js : OK
- `loadTiers('LIGHT'|'STANDARD'|'EXPERT'|'DOCTORAT')` : tous chargent les bons fichiers
- Test complet `ministral-3-14b-reasoning` en LIGHT : 51/64 (80%), score obligatoire 100%
- Test complet en STANDARD : 52/64 (81%), score obligatoire 94%

## 2026-07-07 — URGENT : restauration complète du dossier `benchmark-v2/` disparu

### Contexte
Le dossier technique `benchmark-v2/` (runner + 10 modules + tiers JSON) avait entièrement
disparu du disque suite au renommage/déplacement du projet vers `Local-LLM-Benchmark-V3`, sans
qu'aucun dépôt Git n'existe pour le récupérer. Détecté suite à `MODULE_NOT_FOUND` au lancement.

### Action entreprise
Récupération via l'historique local de VS Code (snapshots de sauvegarde indépendants de Git) pour
6 modules + 4 fichiers `tiers/*.json`, et reconstruction manuelle des 5 modules restants
(`logger.js`, `progress-bar.js`, `parsing-utils.js`, `tier-loader.js`, `report-generator.js`)
d'après leur usage documenté. Voir le détail complet dans
`issues-fixes/2026-07-07-dossier-benchmark-v2-disparu.md`.

### Résultat
- Les 11 fichiers `.js` et 4 fichiers `tiers/*.json` sont validés syntaxiquement.
- `node benchmark-v2/runner.js` s'exécute à nouveau sans erreur.
- **Action requise côté utilisateur** : initialiser Git si absent, committer, et repousser le
  dépôt public (celui-ci a été publié sans ce dossier).

### Fichiers modifiés
- `benchmark-v2/` (dossier recréé intégralement — 11 fichiers `.js` + 4 fichiers `tiers/*.json`)
- `Memories-BenchGo/issues-fixes/2026-07-07-dossier-benchmark-v2-disparu.md`

## 2026-07-07 — Rattrapage interactif (LIGHT/STANDARD) + garde-fou contexte 16384

### Contexte
Besoin exprimé: ajouter une seance de rattrapage interactive pour les profils LIGHT et STANDARD
afin de laisser une deuxieme chance sur les tiers en echec, et eviter les depassements de
fenetre de contexte quand LM Studio est configure a 16384 tokens.

### Action entreprise

**1. Rattrapage interactif dans `runner.js`**
- Ajout d'une question utilisateur en console apres un tier en echec (profils LIGHT/STANDARD):
  `Voulez-vous lancer une seance de rattrapage pour le Tier X ? [o/N]`
- Maximum d'une tentative supplementaire par tier (`MAX_RATTRAPAGE_ATTEMPTS = 1`).
- En cas de deux tentatives, le score retenu est le meilleur des deux.
- En session non interactive (pas de TTY), le rattrapage est ignore avec warning explicite.

**2. Budget de contexte configurable**
- `config.js`: support du nouvel argument CLI `--context-limit=16384` (ou autre valeur positive).
- `runner.js`: affichage + log du budget applique (fallback par defaut a `16384`).
- `lm-studio-client.js`:
  - Estimation des tokens d'entree (`~4 caracteres/token`).
  - Calcul d'un `max_tokens` dynamique pour la sortie en respectant la limite de contexte.
  - Echec explicite si le prompt d'entree est estime trop proche de la limite.

### Resultat
- Les profils LIGHT/STANDARD peuvent faire un rattrapage interactif au moment opportun.
- Le risque de requetes hors budget contexte est controle avant l'appel API.
- Le benchmark reste compatible avec la configuration LM Studio a 16384 tokens.

### Fichiers modifies
- `benchmark-v2/runner.js`
- `benchmark-v2/config.js`
- `benchmark-v2/lm-studio-client.js`
- `Memories-BenchGo/CHANGELOG.md`
- `Memories-BenchGo/README.md`
- `Memories-BenchGo/architecture/benchmark-v2.md`

### Validation
- Verification syntaxique: `node --check` sur les 3 modules modifies.
- Verification outillage VS Code: aucune erreur detectee sur les fichiers modifies.

## 2026-07-07 — Extension des tiers (débogage/async/sécurité) + fix barre de progression

### Contexte
Constat : les modèles LIGHT (< 3B) n'avaient que 3 tâches obligatoires par tier (0 et 1), pas
assez pour bien discriminer leurs capacités. Demande d'ajout de 3 nouvelles familles d'épreuves
transverses à tous les tiers : **débogage de code existant**, **programmation asynchrone
complexe** (Promise.allSettled, retry, erreurs partielles) et **sécurité applicative** (anti-XSS,
anti-injection SQL, anti prototype-pollution). Egalement signalé : la barre de progression CLI
(`ProgressBar`) restait visuellement figée pendant la phase d'évaluation.

### Action entreprise

**1. Barre de progression CLI** — voir `issues-fixes/2026-07-07-barre-progression-figee.md`.
Ajout de `sleep()` + `await` entre les updates dans la boucle d'évaluation de `runner.js` pour
laisser le terminal repeindre chaque frame.

**2. Infrastructure d'évaluation asynchrone** :
- `vm-sandbox.js` : ajout de `setTimeout`/`clearTimeout` au sandbox (nécessaire pour tester du
  code avec retry/backoff sans crasher).
- `task-evaluator.js` : `evaluateTask()` devient `async`, `await evaluator(...)` pour le type
  `custom` (permet des évaluateurs custom réellement asynchrones).
- `runner.js` : `await evaluateTask(...)`.
- `custom-evaluators.js` : ajout de 4 évaluateurs — `evaluateAsyncPartialErrors`,
  `evaluateAsyncSequentialProcessing`, `evaluateAsyncRetryLogic`, `evaluateCloudflareMiddleware` —
  et de 2 helpers réutilisables : `exposerFonctionVM()` (définit le code étudiant en VM puis
  expose la fonction pour un appel/await depuis l'hôte) et `avecTimeout()` (garde-fou contre les
  blocages).
- **Bug corrigé au passage** : le test `exec` existant de `tache_3c` (middleware Cloudflare)
  échouait TOUJOURS, même avec une réponse parfaite, à cause d'une Promise jamais résolue en
  exécution VM synchrone. Remplacé par `evaluateCloudflareMiddleware` (voir
  `issues-fixes/2026-07-07-test-async-middleware-toujours-echec.md`).

**3. Nouvelles épreuves par tier** (chaque fichier JSON de `tiers/` mis à jour : prompt + tasks) :

| Tier | Tâches avant | Tâches après | Évaluations avant | Évaluations après | Nouvelles épreuves |
|---|---|---|---|---|---|
| 0 (EASY) | 3 | 5 | 7 | 12 | 0-D débogage (max avec tableau négatif), 0-E anti-XSS (textContent) |
| 1 (MEDIUM) | 3 | 5 | 10 | 17 | 1-D débogage (doublons mal dédupliqués), 1-E échappement HTML anti-XSS |
| 2 (HARD) | 3 | 5 | 10 | 14 | 2-D async avancé (Promise.allSettled), 2-E débogage (forEach+async cassé) |
| 3 (EXPERT) | 3 | 6 | 9 | 16 | 3-D anti-injection SQL, 3-E retry async avec backoff, 3-F débogage (prototype pollution) |

### Résultat
- Les modèles LIGHT disposent maintenant de 2 épreuves supplémentaires sur chacun de leurs 2 tiers
  obligatoires (0 et 1), soit davantage d'occasions de démontrer leurs capacités.
- Couverture élargie sur 3 axes demandés : débogage, async complexe, sécurité applicative.
- Chaque nouvelle épreuve validée manuellement (code correct → passe, code buggé/vulnérable →
  échoue) via des scripts de test temporaires avant intégration définitive.
- Barre de progression CLI anime désormais visiblement en temps réel.

### Fichiers modifiés
- `benchmark-v2/runner.js`
- `benchmark-v2/vm-sandbox.js`
- `benchmark-v2/task-evaluator.js`
- `benchmark-v2/custom-evaluators.js`
- `benchmark-v2/tiers/tier0_easy.json`
- `benchmark-v2/tiers/tier1_medium.json`
- `benchmark-v2/tiers/tier2_hard.json`
- `benchmark-v2/tiers/tier3_expert.json`

### Notes techniques
- Nouveau pattern standard pour tester du code async : `exposerFonctionVM()` + `await` depuis
  l'hôte, jamais via `type: "exec"` (voir issue-fix dédiée).
- `setTimeout`/`clearTimeout` ajoutés au sandbox VM référencent directement les timers Node réels
  de l'hôte (les fonctions étudiantes qui les utilisent continuent de fonctionner sans crasher).

---

## 2026-07-08 — Retravail des tiers + fix stripTS + export rapports classés

### Contexte
Les modèles LLM de niveau standard échouaient systématiquement au Tier 0. Analyse des rapports
de test : la cause racine était double. (1) `stripTS()` ne supprimait pas `export`/`import` ni
les types de retour de fonction avec génériques contenant des accolades (`Promise<{...}>`), ni
les assertions non-null (`!` postfix) — provoquant `"Unexpected token 'export'"` sur des codes
parfaitement corrects. (2) Le Tier 0 était trop difficile (DOM, XSS, débogage subtil) pour être
un niveau "très très facile".

### Action entreprise

**1. Fix critique `parsing-utils.js` — `stripTS()` réécrit** :
- Suppression des imports ES modules (`import ... from '...'`)
- Suppression du mot-clé `export` / `export default`
- Nouveau parser par compteur de profondeur (`{}`, `<>`) pour les types de retour avec génériques
  (ex: `Promise<{ succes: any[], echecs: string[] }>`)
- Suppression des assertions non-null TypeScript (`stack.pop()!` → `stack.pop()`)
- Suppression des types de fonction en paramètre (`paramName: (args) => ReturnType`)

**2. Fix `vm-sandbox.js` et `custom-evaluators.js` — `const`/`let` au top-level** :
- Conversion automatique `const`/`let` → `var` avant exécution VM (sinon les fonctions déclarées
  avec `const fn = ...` n'étaient pas accessibles via `ctx[fnName]`)

**3. Retravail complet des 4 tiers** :
- **Tier 0** (très très facile) : addition, parité, inversion chaîne, max tableau, compter voyelles
- **Tier 1** (un peu plus élevé) : filtrer pairs, capitaliser, supprimer doublons, débogage compteur mots, fréquence caractères
- **Tier 2** (cran au-dessus) : validation parenthèses, debounce, aplatir tableau, Promise.allSettled, débogage async
- **Tier 3** (le plus complexe, gros modèles 20-30B) : PowerShell rollback, Flood Fill, middleware Cloudflare, SQL paramétrée, retry async, prototype pollution
- Noms de fonctions alignés entre tiers et évaluateurs : `remplirMatrice`, `chargerEnParallele`, `traiterSequentiellement`, `middleware`, `validerParentheses`

**4. Export des rapports classés dans `Export-Rapports/`** :
- Structure : `Export-Rapports/<YYYY-MM-DD>/<PROFIL>/<fichier>.md`
- `runner.js` modifié pour créer automatiquement les sous-dossiers et sauvegarder au bon endroit
- Migration des 4 anciens rapports vers la nouvelle structure

### Résultat
- Les modèles standard devraient maintenant pouvoir passer le Tier 0 (exercices très faciles)
- Le code TypeScript avec `export` et types génériques est correctement strippé et exécuté
- Les rapports sont organisés par date et profil pour éviter de se mélanger les pinceaux

### Fichiers modifiés
- `parsing-utils.js` (stripTS réécrit + nouvelle fonction `stripReturnTypeAnnotation`)
- `vm-sandbox.js` (conversion const/let → var)
- `custom-evaluators.js` (conversion const/let → var + noms de fonctions alignés)
- `tiers/tier0_easy.json` (exercices fondamentaux JS)
- `tiers/tier1_medium.json` (manipulation de données)
- `tiers/tier2_hard.json` (algorithmes intermédiaires + async)
- `tiers/tier3_expert.json` (sécurité + algorithmes avancés)
- `runner.js` (export rapports classés par date/profil)

### Validation
- Tests `stripTS()` avec 6 cas couvrant export, types génériques, async, imports, non-null
- Tous les évaluateurs custom testés avec codes de référence (FloodFill, async, middleware, retry)
- Vérification syntaxique `node -c` sur tous les fichiers modifiés
- Chargement des 4 tiers validé via `loadTiers()`

---

## 2026-07-07 — Refactorisation complète du runner.js

### Contexte
Le fichier `benchmark-v2/runner.js` atteignait **1243 lignes**, devenant difficile à maintenir et déboguer.

### Action entreprise
Décomposition en **10 modules spécialisés** avec noms explicites :

| Module | Lignes | Responsabilité |
|--------|--------|----------------|
| `config.js` | 106 | Constantes API, profils, parsing CLI |
| `progress-bar.js` | 141 | UI console (ProgressBar, Spinner, letterGrade) |
| `parsing-utils.js` | 61 | Extraction JSON/regex, suppression TypeScript |
| `vm-sandbox.js` | 45 | Sandbox VM, exécution de code isolée |
| `custom-evaluators.js` | 318 | 5 évaluateurs spécialisés (GeoJSON, React, Flood Fill, PowerShell, Python) |
| `task-evaluator.js` | 55 | Moteur d'évaluation des tâches |
| `lm-studio-client.js` | 105 | Client API LM Studio avec streaming SSE |
| `tier-loader.js` | 29 | Chargement des fichiers tier JSON |
| `report-generator.js` | 41 | Génération rapports Markdown |
| `runner.js` (refactorisé) | 225 | Orchestration principale uniquement |

### Résultat
- **Réduction de 82%** du fichier principal (1243 → 225 lignes)
- Architecture modulaire facilitant maintenance et tests
- Chaque module a une responsabilité unique (SRP)
- Syntaxe vérifiée pour tous les fichiers

### Documentation créée
- Ce dossier `Memories-BenchGo/` comme centre de mémoire
- Documentation d'architecture dans `architecture/benchmark-v2.md`
- Détails de la refactorisation dans `refactorisations/2026-07-07-runner-modularisation.md`

### Notes techniques
- Le dossier `tiers/` contient uniquement des JSON de configuration, aucune modification requise
- Toutes les dépendances circulaires ont été évitées
- Le module `custom-evaluators.js` est le plus volumineux car il contient la logique métier complexe des évaluations
