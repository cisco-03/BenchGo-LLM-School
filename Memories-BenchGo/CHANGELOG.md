# CHANGELOG - Carnet de Notes BenchGo

## 2026-07-18 — Cumul de l'historique des re-tests par école (carnet persistant)

### Contexte
Le carnet de scores (`Export-Rapports/.carnet/<modele>.json`) ne conservait que la **meilleure
tentative** par école (`score-ledger.js saveResult` : écrasement si `result.pct >= existing.pct`).
Quand un créateur de modèle publie une mise à jour et qu'on relance un benchmark sur la même
école, l'ancien score était écrasé : impossible de comparer l'avant/après.

L'utilisateur a demandé de **cumuler toutes les tentatives** par école dans le carnet, de façon à
pouvoir retracer l'historique des re-tests dans la modale de détail du classement HTML. Le
**classement global** continue d'utiliser la **meilleure tentative** par école (comportement
inchangé).

### Actions entreprises

**1. `score-ledger.js` — Format cumul `{ best, attempts }` par école**
- Nouveaux helpers :
  - `normalizeEcoleEntry(raw)` : normalise une entrée d'école vers `{ best, attempts }`. Gère l'ancien format (résultat unique) et le nouveau format cumul — **migration automatique à la lecture**, aucun script de migration nécessaire.
  - `pickBest(attempts)` : sélectionne la tentative au % le plus élevé (égalité → dernière).
  - `getEcoleBest(raw)` / `getEcoleAttempts(raw)` : accesseurs publics pour la meilleure tentative et la liste chronologique.
- `saveResult(shortName, modelName, result)` : pousse désormais `result` dans `attempts[]` et recalcule `best` via `pickBest`. Log indique le numéro de la tentative et la meilleure performance.
- `computeGrandTotal` / `printBilanGlobal` / `buildBilanMarkdown` : itèrent désormais sur `getEcoleBest()` (et non plus sur l'entrée brute). Le bilan CLI et Markdown affichent le nombre de tentatives par école et une colonne « Tentatives » dans le tableau.
- Tous les helpers ajoutés à `module.exports`.

**2. `leaderboard.js` — Agrégation + sérialisation de l'historique**
- `aggregateLedger(ledger)` : utilise `normalizeEcoleEntryLb` (équivalent local) pour agréger sur `best`. Chaque école sérialisée inclut désormais `attemptsCount` et `attempts[]` (compactées via `compactAttempt` : n°, date, time, score, max, pct, grade, bonus, santé, aide, rat., calibration, mandatory, reportFile).
- `buildReasoningMarkdown` : `ecoleEntry` pointe sur `best` (via `normalizeEcoleEntryLb`) pour préserver l'accès à `selfProfile` et `tiers`.
- Sérialisation `modelsData` (modale) : chaque école inclut `attemptsCount` et `attempts`.

**3. Modale de détail — Affichage de l'historique des tentatives**
- Tableau « Détail par école » : nouvelle colonne « Tent. » (nombre de tentatives).
- Quand une école a > 1 tentative, un toggle cliquable `▸ N tentatives` apparaît à côté du nom de l'école.
- Au clic, une sous-table repliable s'affiche listant **toutes les tentatives chronologiquement** (n°, points, %, note, bonus, santé, aide, rat., calibration, date+heure). La meilleure tentative est marquée d'une étoile ★ et surlignée.
- Nouveaux styles CSS : `.hist-toggle`, `.hist-block`, `.hist-table`, `.hist-best`, `.best-tag`.
- Nouvelle fonction JS `toggleHistory(el)` : bascule l'affichage de la ligne d'historique.

**4. `runner.js` — Détection de doublon adaptée**
- La détection de doublon utilisait `dupLedger.ecoles[ecoleLabel]` directement (ancien format = résultat). Désormais utilise `scoreLedger.getEcoleBest()` et `getEcoleAttempts()`.
- Message adapté : « Meilleur score précédent », « Tentatives cumulées : N », et propose « un nouveau test (sera cumulé à l'historique, le meilleur score est conservé) » au lieu d'« écrasera le score précédent ».

### Compatibilité descendante
- Les carnets existants (ancien format = résultat unique par école) sont **migrés à la volée** à la lecture par `normalizeEcoleEntry` : une entrée `resultat` devient `{ best: resultat, attempts: [resultat] }`. Aucun script de migration à exécuter.
- Au prochain `saveResult` sur une école existante, le carnet est réécrit au nouveau format cumul.
- Le classement global est **strictement inchangé** (meilleure tentative par école, comme avant).

### Résultat
- Re-tester un modèle après une mise à jour du créateur ajoute une tentative à l'historique sans écraser l'ancien score.
- La modale de détail du classement HTML affiche l'historique complet des tentatives par école (repliable), avec la meilleure mise en évidence.
- Le bilan CLI et Markdown mentionnent le nombre de tentatives par école.
- Le classement global reste basé sur la meilleure tentative (comportement préservé).

### Fichiers modifiés
- `score-ledger.js` (format cumul, helpers, migration auto, bilan CLI/MD)
- `leaderboard.js` (agrégation, sérialisation, modale historique, CSS, JS `toggleHistory`)
- `runner.js` (détection doublon adaptée)

### Validation
- `node --check` sur `score-ledger.js`, `leaderboard.js`, `runner.js` → OK
- Test cumul : `saveResult` avec un faux résultat sur `College-Lycee` d'un carnet existant → `attempts.length = 2`, `best.pct` correct (restauration du carnet effectuée après test).
- `node leaderboard.js` → génère les 3 fichiers, JS inline valide (`vm.Script` OK).
- `aggregateLedger` sur un carnet existant → `attemptsCount = 1`, `attempts[0]` correctement compacté.

### Voir aussi
- `refactorisations/2026-07-18-cumul-historique-retests-ecole.md`
- `architecture/benchmark-v2.md` (section score-ledger.js + leaderboard.js)

---

## 2026-07-18 — Refonte HTML du classement : cartes condensées, modale de détail, filtres par catégorie et par taille

### Contexte
Le classement HTML précédent affichait chaque modèle sous forme d'une carte volumineuse (stats en ligne + 3 colonnes forces/faiblesses/détail-école toujours ouvertes), ce qui devenait fastidieux à parcourir avec des dizaines de modèles. L'utilisateur a demandé :
1. Un affichage **condensé** (une ligne compacte par modèle avec les stats principales).
2. Un **bouton « Détails »** ouvrant une **modale** avec TOUT le détail (forces/faiblesses, détail par école, calibration, méta).
3. Un **système de filtres par catégorie** : Top du top, Recommandés, Dans la moyenne, En rattrapage, Échec total.
4. Un **filtre par taille de paramètres** (comme pour les écoles) : < 3B (petit), 3B–14B (standard), 14B–30B (expert), > 30B (doctorat), inconnue.
5. Une **recherche texte** par nom de modèle.

### Actions entreprises

**1. `leaderboard.js` — Nouvelles fonctions de catégorisation**
- `getCategory(entry)` : catégorise un modèle selon son % global en 5 catégories affinables :
  - 🏆 `top` (≥ 90%) — Top du top
  - ✅ `recommande` (≥ 80%) — Recommandés
  - 📊 `moyenne` (≥ 70%) — Dans la moyenne
  - ⚠️ `rattrapage` (≥ 50%) — En rattrapage
  - 💥 `catastrophe` (< 50%) — Échec total
- `getParamSize(modelName)` : détecte la taille de paramètres depuis le nom du modèle en réutilisant `detectProfileFromModelName` de `config.js` (mêmes seuils que les profils d'école) :
  - 🐱 `petit` (< 3B) — profil LIGHT
  - 📦 `standard` (3B–14B) — profil STANDARD
  - 🎓 `expert` (14B–30B) — profil EXPERT
  - 🧠 `doctorat` (> 30B) — profil DOCTORAT
  - ❓ `inconnu` — taille non détectable dans le nom
- Nouvel import : `const { detectProfileFromModelName } = require('./config');`

**2. `leaderboard.js` — Refonte complète de `buildLeaderboardHTML`**
- **Cartes condensées** : une carte compacte par modèle, affichant sur une seule ligne : rang/médaille + nom + icône catégorie + badge taille (ex : `📦 7B`) + mini-stats (% avec barre, Note, Santé, Obligatoire, Aide/Rat.) + boutons « Détails » et « 🗑 ».
- **Modale de détail** : ouverture au clic sur la carte ou sur « Détails ». Contient :
  - En-tête : rang/médaille, nom intégral, badge verdict, catégorie + taille
  - Statistiques complètes (Points, % global avec barre, Note, Obligatoire avec barre, Santé, Bonus, Aide, Rattrapage, Écoles)
  - Forces & Faiblesses (grid 2 colonnes) + Notes
  - Tableau détaillé par école (École, Points, %, Note, Bonus, Santé, Aide, Rat., Calib., Date)
  - Ligne méta (dernière mise à jour, nom court)
  - Fermeture : clic sur overlay, bouton ×, ou touche Échap
- **Barre de filtres par catégorie** (`#chips`) : chips cliquables avec compteurs par catégorie.
- **Barre de filtres par taille** (`#sizeChips`) : chips cliquables avec compteurs par taille, indépendante du filtre catégorie (combinable).
- **Recherche texte** (`#search`) : filtre par nom de modèle ou nom court, combinable avec les deux filtres.
- **Compteur de résultats** : affiche `shown/total` en temps réel.
- **Message « Aucun modèle ne correspond »** quand les filtres excluent tout.
- Les données complètes de chaque modèle (forces/faiblesses, écoles, catégorie, taille, verdict) sont sérialisées en JSON dans une variable `MODELS` côté client pour alimenter la modale sans re-fetch serveur.
- Les styles CSS et le JS sont entièrement embarqués dans le HTML généré (fichier autonome, ouvrable hors-ligne).

**3. Exports du module**
- `getCategory` et `getParamSize` ajoutés à `module.exports` de `leaderboard.js`.

### Résultat
- Le classement HTML passe d'un affichage volumineux (cartes détaillées toujours ouvertes) à un affichage **condensé et navigable** : on voit d'un coup d'œil tous les modèles avec leurs stats clés, et on ouvre la modale pour le détail complet.
- Les filtres par catégorie et par taille permettent de segmenter rapidement des dizaines de modèles (ex : « montrer uniquement les modèles < 3B qui sont recommandés »).
- La recherche texte permet de retrouver un modèle par son nom.
- Le bouton de suppression reste fonctionnel en mode `--serve`.
- Le HTML reste un fichier autonome (CSS + JS embarqués), ouvrable hors-ligne en double-clic.

### Fichiers modifiés
- `leaderboard.js` (import config, `getCategory`, `getParamSize`, refonte `buildLeaderboardHTML`, exports)
- `Export-Rapports/classement.html` (régénéré automatiquement par `node leaderboard.js`)

### Validation
- `node --check leaderboard.js` → OK
- `node leaderboard.js` → génère les 3 fichiers (HTML condensé + MD + raisonnement), affichage console correct
- Vérification du HTML généré : présence des barres de filtres `#chips` et `#sizeChips`, badge `.size-badge` sur les cartes, variable `MODELS` sérialisée avec `paramSize` et `cat`, détection correcte (7B → standard 📦, 12B → standard 📦, 9B → standard 📦)
- Compatibilité : les carnets existants (sans champ taille) sont gérés — la taille est déduite du nom du modèle, pas du carnet

### Voir aussi
- `refactorisations/2026-07-18-classement-html-condense-modale-filtres.md`
- `carte-mentale/classement-leaderboard.md` (mise à jour)
- `README.md` racine du projet (README GitHub, créé)

---

## 2026-07-18 — Export raisonnement consolidé (NotebookLM via Gemini)

### Contexte
Le classement Markdown existant (`classement.md`) ne contient que les scores agrégés et les arguments qualitatifs automatiques (forces/faiblesses). Pour analyser finement le **raisonnement** et les **réponses** de chaque modèle LLM, l'utilisateur a besoin d'un fichier Markdown détaillé consolidant, par modèle :
- le nom **intégral** du modèle
- la date (et heure si possible) du run
- l'auto-profilage déclaré (4 compétences + justification)
- pour chaque école et chaque classe (tier) traversée : les exercices tentés, le code produit, le statut, les explications d'échec
- la **réponse brute complète** (raisonnement + code) du modèle pour chaque tier

Ce fichier est destiné à être ingéré par **Gemini** puis à alimenter une base **NotebookLM** pour analyse qualitative.

### Actions entreprises

**1. `runner.js` — Enrichissement du carnet JSON**
- Nouvelle variable `allTierResponses` dans `main()` : collecte, pour chaque tier complété, `{ tierNum, tierTitle, isMandatory, className, rawResponse, evalResults }`.
- `ecoleResult` (sauvegardé dans le carnet) enrichi avec :
  - `time` : heure locale `HH-MM-SS` du run
  - `selfProfile` : profil auto-déclaré complet (4 compétences + justification)
  - `tiers` : tableau des réponses brutes + évaluations par tier
- Les anciens carnets restent compatibles (les champs manquants sont gérés gracieusement).

**2. `leaderboard.js` — Nouveau 3ème export**
- Nouvelle fonction `buildReasoningMarkdown(entries)` : génère un Markdown détaillé par modèle avec :
  - Nom intégral + nom court + score global + score obligatoire + santé + bonus + aide/rattrapage
  - Par école : date (et heure si disponible), profil, scores, calibration, auto-profilage déclaré
  - Par tier (classe) : titre, statut obligatoire/optionnel, nom de classe
  - Tableau des exercices tentés (ID, type, points, max, statut, aide, rattrapage)
  - Code produit par le modèle pour chaque exercice (bloc ```javascript)
  - Explications d'échec fournies par le modèle (`failureExplanation`)
  - Réponse brute complète du modèle (raisonnement + code) dans un bloc ```text
- Nouvelle fonction utilitaire `loadLedgerByName(shortName)` : recharge le carnet original pour accéder aux données détaillées.
- `generateLeaderboard()` sauvegarde désormais un 3ème fichier `Export-Rapports/raisonnement_modeles.md` (écrasé à chaque génération).
- Affichage console mis à jour : 3 lignes (HTML, MD, raisonnement) avec mention « destiné à NotebookLM via Gemini ».
- `buildReasoningMarkdown` exportée dans `module.exports`.

**3. Compatibilité descendante**
- Les carnets antérieurs à cette version n'ont pas `tiers` ni `selfProfile` : le fichier raisonnement affiche un message gracieux « *Aucun détail de tier disponible pour cette école (données antérieures à l'export raisonnement).* »
- Les nouveaux runs incluront automatiquement toutes les données détaillées.

### Résultat
- 3 fichiers générés à chaque run complet ou `node leaderboard.js` :
  1. `classement.html` — classement visuel interactif
  2. `classement.md` — classement Markdown tabulaire
  3. `raisonnement_modeles.md` — raisonnements & réponses détaillés par modèle (NotebookLM)
- Le fichier raisonnement contient toujours le nom **intégral** du modèle et la date du run (heure incluse si disponible).
- Chaque classe traversée, chaque exercice tenté, le code produit et le raisonnement brut sont restitués.

### Fichiers modifiés
- `runner.js` (collecte `allTierResponses` + enrichissement `ecoleResult`)
- `leaderboard.js` (`buildReasoningMarkdown`, `loadLedgerByName`, `generateLeaderboard` 3ème fichier, exports)

### Validation
- `node --check leaderboard.js` → OK
- `node --check runner.js` → OK
- `node leaderboard.js` → génère les 3 fichiers, affichage console correct
- Vérification du contenu de `raisonnement_modeles.md` : structure correcte, nom intégral présent, message gracieux pour les carnets antérieurs sans données de tier

### Voir aussi
- `issues-fixes/2026-07-18-auto-profilage-silencieux-erreurs-brutes.md` (session précédente)

---

## 2026-07-18 — Affichage immédiat de la config + explications pédagogiques des échecs

### Contexte
Deux problèmes utilisateurs identifiés en CLI :
1. Au lancement d'un run, l'auto-profilage prend 10-15s pendant lesquelles **rien n'est affiché** : l'utilisateur croit que le CLI a planté.
2. Les échecs définitifs d'exercices affichent des **erreurs techniques brutes** du moteur JS (`is not defined`, `Invalid or unexpected token`) qui font croire à un bug du benchmark. Aucune explication de la cause racine n'est fournie.

### Actions entreprises

**1. `runner.js` — Affichage immédiat de la configuration (priorité absolue)**
- Réorganisation de `main()` : la configuration (cible, profil, école, tokens, tiers, mode) est affichée **avant** l'auto-profilage.
- Bloc `━━━ CONFIGURATION DU RUN ━━━` avec toutes les infos essentielles.
- Bloc `━━━ AUTO-PROFILAGE DU MODÈLE ━━━` annonçant explicitement que l'auto-profilage va commencer et peut prendre 10-15s, avec la liste des 4 compétences évaluées.
- Bloc `━━━ RÉSULTAT DE L'AUTO-PROFILAGE ━━━` après l'interview : chaque compétence avec barre visuelle `[███░░] 3/5`, niveau moyen déclaré, justification du modèle, politique de filtrage.
- Chronométrage de l'auto-profilage (durée affichée dans le stop du spinner).

**2. `runner.js` — Explication exigée par le professeur après chaque échec définitif**
- Nouvelle fonction `askModelForFailureExplanation()` : interroge le modèle avec un prompt pédagogique qui fournit l'erreur technique brute + le code produit, et exige une analyse de la cause racine en 2-4 phrases (français). Interdit les réponses vides ou la recopie de l'erreur brute.
- Nouvelle fonction `explainTechnicalError(errors, task)` (repli) : traduit les erreurs courantes du moteur JS en explication humaine compréhensible (`is not defined`, `Invalid or unexpected token`, `Unexpected token`, `Unexpected end of input`, `is not a function`, `Cannot read properties of undefined/null`, `Maximum call stack`, `Timeout`, `Assertion échouée`).
- Intégration dans `runTierAttempt()` : variable `taskFailureExplanations`, appel à l'explication après échec définitif, champ `failureExplanation` dans `evalResultsMap`, retour `failureExplanations` dans le résultat du tier.
- En CLI : l'erreur technique brute est renommée `Erreur technique brute du moteur` (distincte de l'explication pédagogique). L'explication est affichée sous `💬 Explication de l'élève pour {task.id}` ou `👨‍🏫 Professeur (explication à la place de l'élève)` en cas de repli.

**3. `runner.js` — Section dédiée dans le rapport Markdown**
- Nouvelle section `## Explications des échecs définitifs` après le tableau récapitulatif des points par exercice.
- Restitue l'explication de chaque exercice définitivement échoué (status `failed` + `failureExplanation`).
- Note pédagogique : les erreurs techniques brutes ne sont jamais affichées seules.

### Résultat
- L'utilisateur sait **immédiatement** ce qui se passe au lancement (cible, tokens, profil, école) et est prévenu de l'attente de l'auto-profilage.
- Les erreurs brutes `is not defined` et `Invalid or unexpected token` ne sont plus jamais affichées seules : elles sont toujours accompagnées d'une explication pédagogique (du modèle ou du professeur en repli).
- Le benchmark gagne en intelligibilité et se rapproche de la métaphore scolaire (le professeur exige que l'élève justifie ses échecs).

### Fichiers modifiés
- `runner.js`

### Validation
- `node --check runner.js` → OK
- `node --check config.js` → OK

### Voir aussi
- `issues-fixes/2026-07-18-auto-profilage-silencieux-erreurs-brutes.md`

---

## 2026-07-14 — Mise en page responsive sur 3 colonnes du Classement

### Contexte
La mise en page des forces, faiblesses et détails par école s'affichait sur une seule colonne verticale, créant un espace vide inesthétique et allongeant inutilement les cartes des modèles. L'utilisateur a demandé de les répartir sur 3 colonnes horizontales.

### Actions entreprises

**1. `leaderboard.js` — Générateur de classement**
- Ajout d'une mise en page CSS Grid `.args-section { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; ... }` avec media query `@media (max-width: 768px)` pour la compatibilité mobile.
- Restructuration de la fonction `buildLeaderboardHTML` pour générer systématiquement les 3 colonnes (Forces, Faiblesses + Notes, Détails par école).
- Ajout de l'attribut `open` par défaut sur le `<details class="ecoles-toggle">` pour occuper l'espace harmonieusement.

**2. `Export-Rapports/classement.html` — Rapport statique actif**
- Application des mêmes modifications CSS Grid et restructuration HTML pour que les changements soient visibles immédiatement sans régénération complète obligatoire.

### Résultat
- Un affichage plus compact, esthétique et équilibré avec les trois sections disposées côte à côte sur grand écran.
- Une transition fluide en colonne unique sur petit écran grâce au design responsive.

### Fichiers modifiés
- `leaderboard.js`
- `Export-Rapports/classement.html`

## 2026-07-12 — Auto-Profilage & Calibration (Self-Profiling)

### Contexte
Implémentation d'un système d'Auto-Profilage et d'Étalonnage (Calibration) dans BenchGo.
Le fichier `Memories-BenchGo/Tasks1.md` (rédigé par Gemini) décrivait le besoin en 4 étapes
(interview initiale → filtrage dynamique → calcul de calibration → rapport). Une analyse du
code réel a révélé plusieurs incohérences entre les instructions de Gemini et le code existant
(voir « Écarts avec Tasks1.md » ci-dessous). L'implémentation a été adaptée aux structures
réelles après validation avec l'utilisateur.

### Workflow implémenté
1. **Interview initiale (Self-Profiling)** : le runner interroge le modèle au démarrage via un
   mega-prompt JSON pour qu'il s'auto-évalue sur 4 compétences clés (niveau 1 à 5).
2. **Filtrage dynamique amont** : les tâches trop difficiles selon le profil auto-déclaré sont
   marquées « Bypassée (Non déclarée) » et retirées de l'évaluation (non envoyées au modèle).
3. **Calcul de la Calibration** : à la fin du run, calcul de l'Indice de Calibration C = 1 - |D - P|
   où D = capacité déclarée moyenne, P = performance réelle (ratio de réussite des tâches exécutées).
4. **Section rapport** : une section « Auto-Profilage & Calibration » est injectée en haut du
   rapport Markdown, avec tableau des compétences déclarées, indice C, interprétation et
   liste des tâches bypassées.

### Compétences évaluées (alignées sur BenchGo réel)
- `javascript_basics` — tâches algo simples + exec de base (par défaut)
- `javascript_async` — tâches custom async (tache_2a, tache_3e, tache_4c frontier)
- `algorithms_advanced` — tier 4 frontier + algo_difficile_1/defi + tier 6
- `code_debugging` — tâches de débogage/sécurité (tache_1d, 2d, 2e, 2b, 2c, 3a-f)

### Actions entreprises

**1. `config.js` — flags de configuration**
- Ajout de l'objet `selfProfiling` : `{ enabled: true, minLevelToTest: 2, bypassFilter: false }`.
- `minLevelToTest` : niveau minimum déclaré (1-5) pour lancer les tests associés.
- `bypassFilter` : si true, garde le profilage mais exécute TOUS les tests quand même.

**2. Nouveau module `self-profiling.js`**
- `SKILL_TASK_MAP` : carte statique compétence → IDs de tâches (construite via inventaire des
  18 fichiers tier). Mapping inverse `TASK_TO_SKILL` pour le filtrage.
- `SKILL_LABELS` : libellés humains des 4 compétences.
- `PROFILE_PROMPT` : mega-prompt d'interview (français, schéma JSON strict, 4 compétences).
- `runSelfProfiling(queryFn, providerConfig, contextLimitTokens)` : exécute l'interview,
  tente `JSON.parse` puis fallback regex, valide le schéma, retourne le profil ou `null`
  (graceful degradation si le modèle ne supporte pas le JSON).
- `filterTasksByProfile(tasks, profile, minLevelToTest, bypassFilter)` : filtre les tâches
  d'un tier, retourne `{ kept, bypassed, decisions }`. Logger chaque décision.
- `getTaskSkill(task)` : retourne la skill d'une tâche (`javascript_basics` par défaut).

**3. `lm-studio-client.js` — support `response_format` JSON**
- Ajout du paramètre optionnel `options.responseFormat` dans le payload du fetch.
- Si fourni (`{ type: "json_object" }`), inclus dans le body — supporté par LM Studio (OpenAI-compat).
- Ne casse pas les appelants existants (valeur absente = comportement inchangé).

**4. `cloud-client.js` — support `response_format` (OpenAI-compat uniquement)**
- OpenAI-compat (openai, groq, together, openrouter, mistral, ollama, lmstudio, custom) :
  ajout de `response_format` au body si fourni.
- Anthropic (format natif Messages API) : `response_format` NON envoyé (non supporté) —
  le prompt impose le JSON et le fallback regex côté `self-profiling.js` gère l'échec.

**5. `runner.js` — orchestration**
- Imports : `selfProfiling` de config, `runSelfProfiling`/`filterTasksByProfile`/`SKILL_LABELS`
  de self-profiling, `buildCalibrationReport` de report-generator.
- `main()` : après détermination de `queryFn`/`providerConfig`/`contextLimitTokens`, lance
  l'interview d'auto-profilage (spinner + try/catch non fatal). Affiche les compétences
  déclarées en console.
- `runTierAttempt()` : reçoit `selfProfile`, filtre les tâches via `filterTasksByProfile` après
  l'attribution des points aléatoires. Les tâches bypassées sont retirées de `availableTasks`
  (le seuil de validation 70% porte automatiquement sur les points restants).
- `evalResultsMap` : ajout du champ `status` (`success`/`failed`) sur chaque tâche évaluée.
  Les tâches bypassées sont enregistrées avec `status: 'bypassed'`.
- `runTierAttempt` retourne `bypassedCount` et `filterDecisions`.
- `main()` agrège `allEvalResults` + `allFilterDecisions` tout au long de la boucle des tiers.
- En fin de run : calcul de `calculateCalibrationIndex(selfProfile, allEvalResults)`, affichage
  console (D, P, C + verdict coloré), et injection de la section rapport via
  `buildCalibrationReport` (insérée après le premier `---` de l'en-tête du rapport).
- `ecoleResult` (carnet persistant) : ajout de `calibrationIndex` et `declaredLevel`.

**6. `score-ledger.js` — calcul de calibration**
- `calculateCalibrationIndex(declaredProfile, testResults)` : D = moyenne des levels / 5,
  P = réussites / tâches exécutées (status !== 'bypassed'), C = 1 - |D - P|. Retourne aussi
  `executedCount` et `successCount`.
- `interpretCalibration(C)` : ≥0.85 « Hautement Fiable / Lucide » ; 0.65-0.85 « Modérément
  Calibré » ; <0.65 « Biais de Surconfiance ou Sous-confiance Majeur ».

**7. `report-generator.js` — section rapport calibration**
- `buildCalibrationReport(declaredProfile, calibration, filterDecisions, skillLabels)` :
  génère la section Markdown « Auto-Profilage & Calibration » avec tableau des compétences
  déclarées + ratio, justification, tableau D/P/C/écart, verdict, et tableau des tâches
  bypassées. Exportée dans `module.exports`.

### Décisions de conception (validées avec l'utilisateur)
1. **Adapter au code réel** plutôt que suivre Tasks1.md à la lettre.
2. **4 compétences réelles** (pas html_css/python_apis fictifs de Gemini).
3. **Filtrage amont par le runner** (pas d'auto-sélection par le modèle via SELECTION).
4. **Carte statique par ID** (pas de modification des 18 fichiers tier, pas de tags).
5. **Seuil de validation** : tâches bypassées non comptées (ni numérateur ni dénominateur) —
   neutre vis-à-vis de la sous/sur-confidence.
6. **Graceful degradation** : si l'interview échoue, le benchmark se déroule normalement.
7. **Rapports Markdown uniquement** (pas de PDF/JSON — BenchGo ne produit que du MD).

### Écarts avec Tasks1.md (Gemini)
| Point Tasks1 | Code réel | Décision |
|---|---|---|
| Tags/dossiers de tests | Aucun tag dans les tiers | Carte statique par ID |
| `html_css_frontend`, `python_apis/can_use_fastapi` | Non testés par BenchGo | Remplacés par 4 skills réelles |
| `response_format: json_object` forcé | Clients n'ont pas le paramètre ; Anthropic ne le supporte pas | Ajout optionnel + fallback regex |
| Rapports PDF/JSON | Seulement Markdown | Markdown uniquement |
| `Docs/Rapports.md` | Rapports dans `Export-Rapports/...` | Emplacement existant conservé |
| Tests unitaires « à ne pas casser » | Aucun test dans le projet | Critère nul — vérif via `node -c` |
| Champ `status` dans testResults | N'existe pas | Ajouté (success/failed/bypassed) |
| « Initialisation de connexion » | Pas de connexion persistante | Insertion dans `main()` après `queryFn` |

### Fichiers modifiés
- `config.js` (ajout `selfProfiling`)
- `self-profiling.js` (nouveau module)
- `lm-studio-client.js` (support `response_format`)
- `cloud-client.js` (support `response_format` OpenAI-compat)
- `runner.js` (orchestration complète)
- `score-ledger.js` (`calculateCalibrationIndex`, `interpretCalibration`)
- `report-generator.js` (`buildCalibrationReport`)

### Validation
- `node -c` sur tous les modules modifiés : OK
- Test fonctionnel : imports résolus, `calculateCalibrationIndex` correct (D=0.6, P=0.75 → C=0.85),
  `filterTasksByProfile` filtre correctement (tache_2a async lvl 1 < 2 → bypassed), `getTaskSkill`
  catégorise correctement, `buildCalibrationReport` génère le Markdown attendu.
- `node runner.js` démarre sans erreur d'import (tente ensuite de joindre LM Studio).
- `selfProfiling.enabled = false` : comportement strictement identique à l'actuel (pas de filtrage,
  pas d'interview).

### Voir aussi
- Plan détaillé : `.kilo/plans/1783886722254-self-profiling-calibration.md`

## 2026-07-10 — Fix boucle infinie de réessai + Système d'aide du professeur + Validation des points

### Contexte
Lors d'un test `node runner.js all --profile=STANDARD` sur le Tier 3 (Collège), le modèle échouait sur l'exercice `info` (erreur `élèves is not defined`) et le runner relançait indéfiniment le même exercice (jusqu'à 12 itérations). L'utilisateur a demandé : (1) limiter à un seul réessai par exercice, (2) qu'après l'échec définitif le système demande à l'utilisateur s'il faut comptabiliser les points, (3) qu'un système d'aide du professeur propose un indice au modèle en rattrapage, et (4) que le score final stipule « avec aide et rattrapage ».

### Actions entreprises

**1. `runner.js` — Limite de réessai par exercice (`MAX_TASK_RETRIES = 1`)**
- Remplacement du tableau `evalResults` par `evalResultsMap` (objet indexé par `taskId`).
- Suivi par exercice : `taskRetryMap` (compteur de réessais), `taskNetPoints` (points nets), `taskLastError` (erreur précédente).
- 1er échec : pénalité appliquée, exercice conservé pour un réessai.
- 2ème échec (`retryCount > MAX_TASK_RETRIES`) : abandon de l'élève (`🏳️ L'élève déclare avoir terminé`), exercice retiré de la file (`permanentlyFailedIds`).
- La boucle `while` se termine dès que tous les exercices sont résolus ou définitivement échoués.

**2. `runner.js` — Système d'aide du professeur**
- Au début de chaque itération de rattrapage, prompt séparé au modèle : `Voulez-vous un indice ? (AIDE_OUI/AIDE_NON)`.
- Si accepté : un indice (champ `hint` du JSON du tier, ou indice généré depuis l'erreur) est inclus dans le prompt de réessai.
- Suivi via `taskHelpUsed` et `taskHelpOffered` (proposé une seule fois par exercice).

**3. `runner.js` — Validation manuelle des points**
- Après un échec définitif, `askYesNo()` demande : `Comptabiliser la pénalité de -X points pour l'exercice Y ?`
- Si refus : la pénalité est annulée (`tierScore += pts`).
- En mode non-TTY : annulation automatique (sécurité).

**4. Annotations de score « avec aide et rattrapage »**
- `runner.js` : `printScorecard` et `buildScorecardReport` affichent `[avec aide (N), avec rattrapage (N)]` par tier.
- Score global CLI et Markdown : `⚠ Score obtenu avec aide (N) et rattrapage (N)`.
- `report-generator.js` : `buildTierReport` accepte un paramètre `stats` et annote `*(avec aide)*` / `*(rattrapage)*` par exercice et `(avec aide (N), avec rattrapage (N))` au niveau du tier.

**5. `tiers/tier3_standard.json` — Champs `hint`**
- Ajout d'indices pour les 10 exercices (math, français, histoire, SVT, info + 5 algo).
- Les indices guident sans donner la réponse.

### Fichiers modifiés
- `runner.js`
- `report-generator.js`
- `tiers/tier3_standard.json`

### Voir aussi
- `issues-fixes/2026-07-10-boucle-infinie-reessai-aide-professeur.md`

## 2026-07-10 — Raccourcissement des noms de rapports + heure explicite dans le fichier

### Contexte
Les noms de rapports exportés devenaient très longs et illisibles : le nom complet du modèle
renvoyé par LM Studio (chemin style HuggingFace `org/repo/fichier.gguf`) était recopié tel quel,
avec le nom de base répété (ex. `empero-ai/qwythos-9b-claude-mythos-5-1m-gguf/qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m.gguf`).
De plus, le nom de fichier ne portait aucune heure, rendant impossible de distinguer plusieurs runs
d'une même journée ni de retrouver le fichier de log associé.

### Actions entreprises

**1. `report-generator.js` — nouvelle fonction `shortenModelName()`**
- Découpe le chemin HF/LM Studio (`org/repo/fichier.gguf`) en segments.
- Retire l'extension `.gguf` et le suffixe de dépôt `-gguf` (convention HF).
- Supprime un segment s'il est un préfixe (aligné sur un séparateur) d'un segment plus précis
  qui le suit, ce qui élimine la répétition du nom de base :
  - `empero-ai/qwythos-9b-claude-mythos-5-1m-gguf/qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m.gguf`
    → `empero-ai_qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m`
  - `deepseek/deepseek-r1-distill-qwen-14b` → `deepseek-r1-distill-qwen-14b`
- Laisse intact les noms sans répétition (`mistralai/ministral-3-14b-reasoning`
  → `mistralai_ministral-3-14b-reasoning`) et les noms simples (`gpt-4o`).
- `runner.js` importe désormais `shortenModelName` au lieu de `sanitizeFilename` pour le nom de fichier.

**2. `runner.js` — heure explicite + ancrage du log**
- Le nom de fichier inclut désormais l'heure locale `HH-MM-SS` :
  `rapport_v3_<modeleCourt>_<profil>[_tierN]_<HH-MM-SS>.md`.
- Le dossier jour utilise la **date locale** (au lieu de l'UTC via `toISOString`) pour rester
  cohérent avec l'heure du fichier et l'en-tête du rapport (évite un décalage d'un jour près de minuit).
- L'en-tête Markdown du rapport indique désormais `**Log :** <nom_du_log>` (basename du fichier de
  log), et la console affiche côte à côte le chemin du rapport et celui du log à la sauvegarde —
  on retrouve ainsi le log associé à chaque rapport.

### Fichiers modifiés
- `report-generator.js` (nouvelle fonction `shortenModelName`, export mis à jour)
- `runner.js` (import, génération du nom de fichier + date locale, en-tête log, affichage log)

### Validation
- `node --check` sur `report-generator.js` et `runner.js` → OK
- Test `shortenModelName()` sur 8 cas réels (doublon `empero-ai/...gguf/...gguf`, `deepseek/deepseek-...`,
  noms sans répétition, `gpt-4o`, `null`) → tous PASS
- Le nom complet du modèle reste conservé dans l'en-tête H1 du rapport
  (`# Rapport d'Évaluation V3 — <nomComplet>`), donc aucune information perdue.

---

## 2026-07-10 — Fix stripTS cassant les ternaires + Tableau des Scores CLI

### Contexte
Deux problèmes identifiés lors d'un test du modèle `qwythos-9b` (profil LIGHT) :
1. **Tableau des scores absent du CLI** : lors du passage d'un tier au suivant, les points du tier précédent disparaissaient de l'affichage. Aucun récapitulatif persistant ni total d'école n'était présenté.
2. **`stripTS` cassait les ternaires** : la règle 8 (regex) supprimait par erreur la branche `: valeur` des opérateurs ternaires (`cond ? a : b` → `cond ? a`), provoquant des `SyntaxError: Unexpected token`. Ce bug affectait tous les tiers — confirmé sur `operationsDeBase` (tier 0, `: null` → `Unexpected token '}'`) et `remplacerLettre` (tier 3, `: mot[i]` → `Unexpected token ')'`).

### Actions entreprises

**1. Fix `parsing-utils.js` — remplacement de la règle 8 regex par un scanner contextuel**
- Nouvelle fonction `stripTypeAnnotations()` qui parcourt le code caractère par caractère en suivant :
  - L'état des chaînes (`"`, `'`, `` ` ``) et commentaires (`//`, `/* */`)
  - La profondeur des crochets `()`, `[]`, `{}`
  - Le compteur d'opérateurs ternaires `?` non appairés
- **Stripping conditionnel** : ne supprime `: Type` que dans les listes de paramètres (entre `()`) et après `let`/`const`/`var`
- **Protection explicite** : ne touche PAS aux ternaires (`?` non appairé → `:`), littéraux objet (`{ key: value }`), labels `case`/`default`
- L'ancienne regex `/([)\w\]])\s*:\s*[a-zA-Z_$]...(?=[,)=;\n])/g` supprimée

**2. Tableau des Scores persistant dans le CLI (`runner.js`)**
- Ajout d'un `tierScorecard[]` accumulant les résultats de chaque tier complété
- Après chaque tier : affichage d'un **tableau de score en cours** (EN COURS) montrant toutes les classes passées avec leurs points, pourcentage, note et statut
- En fin de run : affichage d'un **tableau final** (FINAL) avec le total de l'école
- Le tableau final est également ajouté au rapport Markdown exporté (`buildScorecardReport()`)
- Fonctions utilitaires : `getClassName()` (extrait le nom de classe depuis `CLASSE_NAMES`), `printScorecard()` (rendu CLI), `buildScorecardReport()` (rendu Markdown)

### Fichiers modifiés
- `parsing-utils.js` (nouvelle fonction `stripTypeAnnotations` + règle 8 remplacée)
- `runner.js` (scorecard CLI + rapport Markdown + fonctions utilitaires)

### Validation
- 13 tests de régression : ternaires (`: null`, `: mot[i]`, avec/sans parenthèses), littéraux objet, annotations TS (params, return, var, interface, export, génériques) — **tous OK**
- `node --check` sur `parsing-utils.js` et `runner.js` — **OK**
- Test visuel du tableau des scores (4 tiers simulés) — rendu correct
- Voir `issues-fixes/2026-07-10-stripts-casse-ternaires.md` pour le détail du bug

---

## 2026-07-09 — Santé Globale, Évaluation 5 Axes et Classe 6 (Doctorat)

### Contexte
Le benchmark manquait d'une gestion plus humaine des échecs (un modèle faisant de légères erreurs après un excellent départ était éliminé immédiatement). De plus, l'évaluation se limitait à la correction fonctionnelle simple. L'objectif était d'intégrer des tests d'endurance de contexte (mémoire), de rapidité d'exécution, de robustesse face aux injections de prompts, et de respect strict des contraintes.

### Actions entreprises

**1. Système de Santé Globale (Global Life Score)**
- Remplacement du score local d'élimination par une Santé Globale accumulée sur tous les Tiers.
- Le modèle commence à 0 PV. Ses succès lui accordent des points (créant un buffer protecteur), et ses échecs en retirent.
- Une valeur inférieure ou égale à `-100` PV provoque l'arrêt immédiat et l'élimination définitive du benchmark.

**2. Mesures Inférence, Exécution et Verbosité (Axes 1 & 3)**
- Intégration de `performance.now()` dans `runner.js` pour chronométrer et afficher le temps d'inférence de l'API.
- Ajout d'une pénalité de verbosité (`-15 pts`) si le modèle produit un texte bavard non technique plus long que 4x le code utile.
- Ajout de `performance.now()` dans `vm-sandbox.js` pour mesurer la durée d'exécution.
- Implémentation du mot-clé `maxTimeMs` dans `task-evaluator.js` : si le code met trop de temps (ex: algorithme sous-optimal), la validation échoue.

**3. Classe 6 / Tier 6 "Expertise & Résistance" (Axes 2, 4, 5)**
- Création de `tiers/tier6_master.json` contenant 4 tâches avancées :
  - `trier_tableau` (Axe 5) : Tri d'éléments sans l'instruction native `.sort()`.
  - `memoire_longue` (Axe 2) : Restitution d'un mot de passe planqué dans un long Lorem Ipsum (Needle in a Haystack).
  - `calcul_robuste` (Axe 4) : Détecter et ignorer une tentative d'injection de prompt hostile.
  - `optimisation_extreme` (Axe 3) : Résoudre un problème algorithmique sous une limite stricte de 35 millisecondes.
- Configuration du Tier 6 dans `config.js` pour les profils `STANDARD`, `EXPERT`, `DOCTORAT`, et `FRONTIER`.

**4. Documentation de la Gamification**
- Création de `Docs/Apps-Fonctions/gamification-sante.md` décrivant les règles du système (seuil de validation à 70%, Santé Globale, mode élimination).

### Fichiers modifiés
- `runner.js`
- `config.js`
- `vm-sandbox.js`
- `task-evaluator.js`
- `tiers/tier6_master.json` (nouveau)
- `Docs/Apps-Fonctions/gamification-sante.md` (nouveau)
- `Memories-BenchGo/issues-fixes/2026-07-09-sante-globale-tier6-5-axes.md` (nouveau)

---

## 2026-07-08 — Support modèles cloud + profil FRONTIER + Tier 4

### Contexte
L'utilisateur souhaitait benchmarker des modèles cloud frontier (GPT-4o, Claude, Gemini, Llama 405B…)
avec des exercices beaucoup plus difficiles que les tiers existants. Le système ne supportait jusqu'ici
que LM Studio en local.

### Actions entreprises

**1. `cloud-client.js` — nouveau module client cloud (6 fournisseurs)**
- Supporte 6 providers : `openai`, `groq`, `together`, `openrouter`, `mistral` (OpenAI-compatible) + `anthropic` (format natif Messages API)
- Même interface que `lm-studio-client.js` : `queryLLM(prompt, difficulty, tierId, isMandatory, spinner, options)`
- Clé API lue depuis `process.env.<PROVIDER>_API_KEY` ou `--api-key=...`
- Streaming SSE géré pour les deux formats (OpenAI delta + Anthropic text_delta)
- Avertissement si la clé est passée en argument CLI (visible dans le gestionnaire de tâches)

**2. `config.js` — profil FRONTIER + 3 nouveaux args CLI**
- Nouveau profil `FRONTIER` : tiers 0-4 tous obligatoires, label "Post-Doctorat"
- `CLASSE_NAMES.FRONTIER` : Classe-0-PostDoc1 … Classe-4-Frontier
- Nouveaux args CLI : `--provider=<nom>`, `--model=<nom>`, `--api-key=<clé>`
- Si `--provider` est passé sans `--profile` → défaut automatique sur FRONTIER

**3. `runner.js` — routing LM Studio / Cloud**
- Import dual : `queryLLMLocal` (LM Studio) + `queryLLMCloud` (cloud)
- `isCloudMode` détecté depuis `--provider`
- En mode cloud : pas d'auto-détection via `/v1/models`, rattrapage désactivé (coût par appel)
- Affichage dédié : Mode CLOUD, fournisseur, modèle
- `runTierAttempt` reçoit `queryFn` + `providerConfig` (routing transparent)

**4. `tiers/tier4_frontier.json` — Tier 4 pour modèles frontier**
- 6 exercices de niveau doctoral/recherche, 25 évaluations au total
- [4-A] LRU Cache O(1) avec éviction (Map + doubly linked list)
- [4-B] Deep Clone sécurisé — références circulaires (WeakMap), Date, tableaux imbriqués
- [4-C] Async pool avec concurrence limitée — custom evaluator avec mesure réelle de concurrence
- [4-D] Parser d'expressions arithmétiques — précédence + parenthèses, eval() interdit
- [4-E] Trie (arbre de préfixes) — inserer/chercher/commencePar/suggestions
- [4-F] Dijkstra — plus court chemin pondéré, Infinity pour nœuds déconnectés

**5. `custom-evaluators.js` — evaluateAsyncConcurrencyLimit**
- 2 scénarios : 5 tâches / max 2 (vérifie ordre + maxObserved ≤ 2), 1 tâche / max 3

**6. `tier-loader.js` — chaîne de fallback FRONTIER**
- `FRONTIER → DOCTORAT → EXPERT → STANDARD → LIGHT`

### Commandes (voir README pour le détail complet)
```bash
# OpenAI
$env:OPENAI_API_KEY = "sk-..."
node runner.js all --provider=openai --model=gpt-4o

# Anthropic
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node runner.js all --provider=anthropic --model=claude-opus-4-5

# Groq (gratuit, très rapide)
$env:GROQ_API_KEY = "gsk_..."
node runner.js all --provider=groq --model=llama-3.1-70b-versatile

# OpenRouter (accès universel, facturation centralisée)
$env:OPENROUTER_API_KEY = "sk-or-..."
node runner.js all --provider=openrouter --model=anthropic/claude-opus-4 --profile=FRONTIER
```

### Fichiers modifiés
- `cloud-client.js` (nouveau)
- `tiers/tier4_frontier.json` (nouveau)
- `config.js` (profil FRONTIER + CLASSE_NAMES + parseCliArgs)
- `runner.js` (routing dual + mode cloud)
- `custom-evaluators.js` (evaluateAsyncConcurrencyLimit)
- `tier-loader.js` (fallback FRONTIER)

### Validation
- `node --check` : cloud-client.js, config.js, runner.js, custom-evaluators.js, tier-loader.js → OK
- `loadTiers('FRONTIER')` : charge tiers 0,1,2,3,4 → OK (tier4 via tier4_frontier.json)
- `PROFILES.FRONTIER.mandatory` : [0,1,2,3,4] → OK
- tier4_frontier.json : 6 tâches, 25 évaluations → OK

---

## Note de nommage

- Le projet est en version BenchGo V3.
- Les fichiers sources sont désormais à la racine de `benchmark-v3/` (le nom `benchmark-v2` est abandonné).

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
