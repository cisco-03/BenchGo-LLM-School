# AGENTS.md — BenchGo V3

OS : Windows, PowerShell 5.1. Projet Node.js 18+ **sans `package.json`** (modules built-ins uniquement : `fs`, `path`, `child_process`, `readline`, `vm`). Pas de `npm install`.

---

## Commandes essentielles

| Usage | Commande |
|---|---|
| Benchmark interactif | `node runner.js all` |
| Mode nuit (batch local) | `node night-batch.js` |
| Mode nuit classe-par-classe (robustesse anti-hang) | `node night-batch.js --class-by-class` (ou `--cbc`) |
| Écourter le modèle en cours sans tuer le batch | `node night-batch.js --skip` (second terminal, sentinelle ≤3 s) |
| Reprendre une session interrompue (écoles au carnet + tiers passés sautés) | `node night-batch.js --resume` |
| Mode batch cloud (frontière) | `node frontier-batch.js` |
| Mode batch cloud (petits modèles) | `node frontier-batch.js --profile=STANDARD` (ou `LIGHT`) |
| Mode batch cloud (profil par modèle) | `node frontier-batch.js --profile=AUTO` |
| Mode batch cloud non-interactif | `node frontier-batch.js --yes` (aucun prompt, mode nuit/CI) |
| Valider config sans exécuter | `node runner.js all --dry-run` |
| Tests unitaires | `node tests/run-tests.js` |
| Classement HTML/MD | `node leaderboard.js` |
| Classement modèles cloud uniquement | `node leaderboard.js --cloud` |
| Rapport LM Studio (testés + non testés) | `node leaderboard.js --lmstudio` |
| Marquer un carnet comme cloud | `node leaderboard.js --mark-cloud=<shortName>` |
| Serveur classement interactif | `node leaderboard.js --serve` |
| Serveur classement (port custom) | `node leaderboard.js --serve --port=3940` |
| Classement communautaire en ligne (GitHub Pages) | `gh workflow run consolidate.yml -R cisco-03/BenchGo-LLM-School` puis `gh run watch -R cisco-03/BenchGo-LLM-School` |
| Classement communautaire local (test) | `node consolidate-leaderboard.js` (→ `gh-pages-output/`) |
| Aide CLI (runner) | `node runner.js --help` (ou `help` / `-h`) |
| Aide CLI (leaderboard) | `node leaderboard.js --help` |
| Aide CLI (night-batch) | `node night-batch.js --help` |
| Aide CLI (frontier-batch) | `node frontier-batch.js --help` |
| Aide CLI (community-stats) | `node community-stats.js --help` |
| Aide CLI (consolidate-leaderboard) | `node consolidate-leaderboard.js --help` |
| Version | `node runner.js version` |
| Dernier run & état | `node runner.js status` |
| Liste des presets | `node runner.js --list-presets` |
| Effacer une clé API mémorisée | `node runner.js --forget-key=<provider>` |
| Lister les clés API mémorisées | `node runner.js --list-keys` |
| Restaurer les carnets disparus depuis le backup | `node runner.js --restore-carnets` |
| Soumettre un carnet existant (sans run) | `node runner.js --submit` (dernier carnet) / `--submit --model=<nom>` (ciblé) |
| Professeur IA avec provider custom | `node runner.js --teacher-provider=<provider> --teacher-model=<model>` |
| RunCode code natif | `node runner.js --provider=<provider> --model=<model> --exam-code` (flag `--exam-code` = mode **RunCode**) |
| Mode FLASH (grande école accélérée) | `node runner.js all --flash --profile=STANDARD` (1 exercice/classe, petites RAM) |
| Liste LM Studio triée par score local | `node night-batch.js --list-only` |
| Forcer la détection (réindexer les GGUF orphelins) | `node night-batch.js --force-detect` |
| Isoler/désisoler un modèle LM Studio | `node night-batch.js --isoler=!<num>` (isoler) / `--isoler=!!<num>` (désisoler) — numéro = position dans `--list-only`. Ou interaction `!<num>` / `!!<num>` pendant la sélection `night-batch.js` |
| Forcer la détection pendant la sélection | Taper `detect` (ou `force-detect`) à l'invite de sélection `night-batch.js` |
| Stats communautaires (propriétaire) | `node community-stats.js --token=ghp_...` (ou `GITHUB_TOKEN` env) |
| Vérifier syntaxe JS | `node --check <fichier>.js` |
| Vérifier JS inline des classements | `node scripts/check-inline-js.js` |
| Vérifier tiers | `node verify_tiers.js` |

Options fréquentes : `--profile=`, `--provider=`, `--model=`, `--quantization=`, `--force` (non-TTY), `--dry-run`, `--preset=`, `--save-preset=`, `--hybrid`.

---

## Tests

Tous dans `tests/test-*.js`. Framework maison : chaque fichier exporte `run(c)` + `cases[]`. Lanceur : `node tests/run-tests.js` (code de sortie 0 = tout OK). 5 fichiers de test (parsing, scoring-utils, sentinelles, lru-cache).

---

## PowerShell 5.1 — pièges

L'outil `bash` est routé sur PowerShell 5.1. Ça change tout :

- Interdits : `grep`, `head`, `tail`, `cat`, `/dev/null` (cmdlets POSIX inconnus), `&&`, `||` comme séparateur, here-strings (`@"..."@`).
- À la place : `; if ($?) { ... }` pour enchaîner, `Select-String` pour filtrer.
- **`${` dans une chaîne PowerShell** est interprété comme une variable — ne jamais écrire de template literal JS `${}` via le shell. Toujours utiliser l'outil `write`.
- `Set-Content -Encoding UTF8` ajoute un BOM — toujours UTF-8 **sans BOM** (l'outil `write` le garantit).

---

## Architecture & modules

Tous les modules sont à la racine (pas de sous-dossiers pour les sources). Les points d'entrée importants :

- **`runner.js`** — orchestrateur (2689 lignes). Contient `main()`, `runSchool()`, `runTierAttempt()`, `askYesNo()`.
- **`config.js`** — profils, parse CLI, timeout, test de capacité.
- **`cloud-client.js`** — 12 providers cloud (OpenAI compat + Anthropic natif) : openrouter, kilo, openai, anthropic, groq, together, mistral, deepseek, cohere, ollama, lmstudio, custom.
- **`lm-studio-client.js`** — client local LM Studio (streaming SSE).
- **`teacher-client.js`** — professeur IA (correction via OpenRouter Free Router).
- **`capability-check.js`** — test de capacité OUI/NON (~20-30s) en remplacement de l'auto-profilage. 1 appel, 2 tentatives max, parsing robuste FR/EN.
- **`self-profiling.js`** / **`external-profiling.js`** — auto-profilage & profilage externe historiques. **Conservés** (leaderboard lit l'auto-profilage des anciens carnets) mais **plus appelés** par le runner (remplacés par `capability-check.js`).
- **`score-ledger.js`** — carnets persistants dans `Export-Rapports/.carnet/<shortName>.json`.
- **`leaderboard.js`** — génération HTML/MD, serveur web (~4950 lignes, JS inline côté client).
- **`tier-loader.js`** — charge les tiers JSON avec fallback : `FRONTIER → DOCTORAT → EXPERT → STANDARD → LIGHT`.
- **`task-evaluator.js`** — moteur d'évaluation (exec/pattern/custom). Cache LRU intégré.
- **`custom-evaluators.js`** — 14 évaluateurs custom pour exercices avancés : GeoJSON RFC 7946, React Hook, Flood Fill, PowerShell rollback, Python limiter, async (partial errors, sequential, retry, concurrency), Cloudflare middleware, code tracing, instruction following (IFEval), prompt injection resistance, long context retrieval.
- **`secrets.js`** — clés API en mémoire vive (session), jamais sur disque.
- **`presets.js`** — `.presets.json` pour rejouer une config (ne stocke JAMAIS de clé API).
- **`api-keys-store.js`** — stockage persistant optionnel dans `.api-keys.json`.
- **`http-middleware.js`** — timeout + retry backoff + fallback pour appels HTTP.
- **`health-sentinels.js`** — vérifications sanitaires.
- **`hybrid-mode.js`** — auto-soumission GitHub avec file d'attente persistante, seuil à 50%.
- **`pricing.js`** — tarification cloud estimée (tâche 2026-08-04) : fetch OpenRouter `/api/v1/models` + fetch Kilo Gateway `/api/gateway/models` + table fallback locale, calcule coût $/€ des modèles cloud payants d'après les tokens consommés. Cache disque 24h (`.pricing-cache.json` pour OpenRouter, `.kilo-pricing-cache.json` pour Kilo).
- **`consolidate-leaderboard.js`** — génère le HTML du classement communautaire. Lancé en local pour tester (`node consolidate-leaderboard.js` → `gh-pages-output/`), et en CI via GitHub Actions pour déployer sur `gh-pages`. Le workflow `consolidate.yml` lit les soumissions, régénère le HTML, commit sur `gh-pages`, GitHub Pages déploie.
- **`tiers/`** — 18 fichiers `tier{N}_{profile}.json`.

Timeouts clés (`config.js`) : `EVAL_TIMEOUT_MS` = 10s (sandbox VM), `API_TIMEOUT_MS` = 1500s (25 min). Le test de capacité (`capability-check.js`) a son propre timeout (30s/tentative, 2 tentatives max, ~20-30s attendu). `PROFILING_TIMEOUT_MS` (600s) reste défini pour rétrocompatibilité mais n'est plus appelé par le runner.

---

## Conventions de code

- Langue : **français** (code, commentaires, messages CLI).
- Style : indentation 2 espaces, pas de `;`, guillemets simples, backticks pour template literals.
- Pas d'emojis dans le code. Les emojis existants dans le CLI et les rapports sont volontaires (✔ ✘ ⚠).
- Pas de commentaires sauf demande explicite. Commentaires existants détaillés et pédagogiques.
- `Docs/CHANGELOG.md` est le **seul** journal de versions. À mettre à jour à chaque modification.

---

## Gotchas critiques (bugs passés)

### forceFlag
`forceFlag` est extrait dans `main()` puis passé à `runSchool()` et enfin à `runTierAttempt()`. Si oublié dans un des deux appels depuis `runSchool`, il est `undefined` dans `runTierAttempt` et les `askYesNo` ne sont pas court-circuités en mode batch. Les 3 `askYesNo` concernés sont : re-test (×2) et pénalité.

### Rattrapage automatique
Déclenché si : (1) tier obligatoire échoué, (2) santé < 0 PV, (3) ≥ 40% des exercices échoués. `MAX_RATTRAPAGE_ATTEMPTS = 1`. Seuil de validation d'un tier : `Math.floor(totalPossiblePoints * 0.7)` (70% du total possible, pas 70 points fixes).

### askYesNo en non-TTY
Retourne `false` (pas de blocage). Utiliser `--force` pour court-circuiter les confirmations en mode nuit.

### askTeacherToCorrectStudentAnalysis
Renvoie `{ content, model }` (objet), pas une string. Tester `.content` et `.length` sur `.content`, pas sur l'objet.

### response_format (LM Studio)
N'accepte que `{ type: 'json_schema' }` ou `{ type: 'text' }`. `json_object` (OpenAI) → HTTP 400.

### Headers ByteString (OpenRouter)
`HTTP-Referer`, `X-Title` : caractères > 255 (em dash `—` U+2014, accents types) → crash `fetch`. Toujours utiliser des tirets ASCII et caractères Latin-1.

### Modèles gratuits OpenRouter
Ne jamais hardcoder un slug `:free`. Toujours récupérer la liste dynamique via `/api/v1/models` (endpoint public). Les modèles gratuits sont dépubliés sans préavis (HTTP 404).

### esc() dans le leaderboard
`esc()` convertit `'` en `&#39;` (entité HTML). Ne pas l'utiliser pour injecter des chaînes dans des attributs `onclick="..."` (JS inline cassé). Utiliser `data-*` + `addEventListener`.

### Backticks littéraux dans le JS inline (consolidate-leaderboard.js)
Ne JAMAIS mettre de backticks littéraux (`` ``` ``) dans du JS inline généré par un template literal — ils créent une `SyntaxError` qui empêche **tout** le script de s'exécuter (y compris `renderCards()`). Symptôme : le classement communautaire affiche "Aucun modèle" malgré des données valides dans le JSON. Utiliser `String.fromCharCode(96,96,96)` à la place. Vérifier avec : `node -e "const vm=require('vm'); const fs=require('fs'); const h=fs.readFileSync('gh-pages-output/community-leaderboard.html','utf8'); const s=h.indexOf('<script>')+8; const e=h.indexOf('</script>'); new vm.Script(h.substring(s,e)); console.log('OK')"`.

### Déploiement du classement communautaire (GitHub Pages)
`node consolidate-leaderboard.js` ne génère que le fichier **local** `gh-pages-output/`. Pour déployer en ligne : (1) pousser sur `origin/main`, (2) `gh workflow run consolidate.yml -R cisco-03/BenchGo-LLM-School`, (3) `gh run watch -R cisco-03/BenchGo-LLM-School`. Le workflow commit sur la branche `gh-pages` et GitHub Pages déploie. Hard refresh (Ctrl+Shift+R) sur la page en ligne.

### Erreurs brutes du sandbox VM
Ne jamais afficher seules ("Invalid token", "X is not defined"). Toujours les accompagner de `explainTechnicalError()` ou d'une explication du modèle.

### Profils non soumis au rattrapage
Seuls LIGHT et STANDARD sont éligibles. EXPERT, DOCTORAT, FRONTIER ne le sont pas (`isRattrapageEligibleProfile`).

### Échelle letterGrade
`A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60`. Seuils `>=` descendants (A prime sur B).

### Path des exports
Rapports : `Export-Rapports/<AAAA-MM-JJ>/<ÉCOLE>/<CLASSE>/rapport_v3_*.md` (timestamp local, pas UTC). `Export-Rapports/.carnet/` : carnets JSON. Classement : `Export-Rapports/classement.html` et `classement.md` (écrasés à chaque run).

### Chemins web-compatibles dans le carnet (reportFile)
Le champ `reportFile` du carnet JSON est sérialisé dans `classement.html` (`var MODELS = ...`) et consulté sur le web. Il DOIT utiliser des slashs universels (`/`), jamais d'antislashs Windows (`\`). `runner.js` (ligne ~2431) normalise via `.split(path.sep).join('/')`. Les carnets existants ont été migrés (2026-08-06). Pour réparer d'anciens carnets : remplacer `Export-Rapports\\` par `Export-Rapports/` dans `Export-Rapports/.carnet/*.json`.

### Problème Node.js 24.x
Bug undici : `TypeError: Cannot assign to read only property 'name' of object 'Error: socket idle timeout'`. Intercepté globalement dans `runner.js` (ligne 11). L'erreur est loggée, le fetch échoue proprement, le runner continue.

### Écoles séquentielles
Si modèle > 3B paramètres, le runner peut enchaîner LIGHT puis STANDARD dans le même run (même clé, test de capacité partagé, santé réinitialisée).

### Mode FLASH — grande école accélérée (tâche 2026-09-16c)

**Fichiers touchés :** `config.js`, `runner.js`, `startup-questionnaire.js`, `cli-help.js`, `night-batch.js`, `leaderboard.js`, `consolidate-leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Le mode `--flash` exécute la grande école avec **1 exercice par classe** (au lieu de 10-15), tiré en PRIORITÉ parmi les compétences découvertes au tremplin RunCode (bilan `languageStats` du carnet). Pensé pour les machines à PEU DE RAM : la VRAM/RAM est sollicitée ~10x moins longtemps. Le nom FLASH veut dire les deux : flash memory (petite RAM) + interrogation flash (interro éclair scolaire). C'est une OPTION EN SUPPLÉMENT : le score FLASH est enregistré au carnet (école `Flash-<École>`) mais n'est JAMAIS comptabilisé dans le classement général ni dans les statuts night-batch (non comparable à un examen complet).

**Fonctions :**
- `buildFlashTaskSelection(tierData, flashStats)` (dans `runner.js`) → `{ tasks: [1 exercice], picked, basis }`. `flashStats` = `languageStats` du carnet RunCode (majeure du professeur pèse +5, langages réussis +3, tentés +1). Sans stats → tirage aléatoire pur.
- `runSchool()` : résout `isFlashSchool` (flashFlag + tierArg='all'), école du carnet `Flash-<École>`, lit le bilan RunCode du carnet (`flashStats`), injecte `tierData._flashTasks` avant chaque tier.
- `runTierAttempt()` : consomme `tierData._flashTasks` (copie JSON) puis `delete tierData._flashTasks` (hygiène du cache tiers).
- `--flash` (config.js `parseCliArgs`) → `flash: true`. Questionnaire étape 9 : choix `C/F` (défaut Classique). `flashFlag` est un `let` (levé par le questionnaire, jamais abaissé).

**Pour modifier :**
1. **Changer la pondération du tirage** : éditer `scoreTask()` + `keywordToLang` dans `buildFlashTaskSelection()` (runner.js) — la carte langage→exercice se base sur les IDs/labels des tiers.
2. **Changer le nombre d'exercices par classe** (ex: 2) : modifier `buildFlashTaskSelection()` pour renvoyer `scored.slice(0, K)` et la bannière.
3. **Recompter FLASH dans le classement** (NON recommandé) : retirer le filtre `flash === true || /^Flash-/i` dans `aggregateLedger()` (leaderboard.js), `aggregateCarnet()` (consolidate-leaderboard.js), `ledgerSchoolKeys()` + `computeLedgerMetrics()` (night-batch.js).
4. **Réactiver les soumissions en FLASH** : retirer le test `!isFlashRun` sur `proposeCommunitySubmission` et `hybridFlag` (runner.js).
5. **Désactiver la propostion interactive** : retirer la section 9 du questionnaire (startup-questionnaire.js) — le flag CLI `--flash` reste actif.
6. **Tester** : `node runner.js all --flash --profile=STANDARD --dry-run` (bannière ⚡ + config valide), puis un vrai run LIGHT (courant).

**Pièges :**
- `tierData._flashTasks` est SUPPRIMÉ après consumption (`delete`) : le cache tiers (`tier-loader.js`, objets partagés) ne doit JAMAIS garder la sélection — sinon le prochain run non-FLASH n'aurait qu'1 exercice par classe.
- Le tirage FLASH n'a accès qu'aux métadonnées `id`/`label` des tâches : les `keywordToLang` doivent refléter les IDs réellement présents dans les tiers (`react`, `geojson`, `powershell`, `python`, `async`, `sql`...). Un tier sans correspondance retombe sur l'aléatoire (poids 0, `+ Math.random()` départage).
- Les écoles `Flash-*` sont IGNORÉES par `ledgerSchoolKeys` (comme les `RunCode-*`) : un modèle qui n'a passé QUE Flash reste « à tester » pour la grande école — c'est voulu.
- Le rattrapage, la pénalité de raisonnement excessif et la sentinelles fonctionnent normalement en FLASH : seul le tirage change.
- `--flash` avec une cible tier unique (`node runner.js 2 --flash`) : le mode est DÉSACTIVÉ silencieusement (le flag ne s'applique qu'à `all`) — le questionnaire log cette correction.
- Le classement est quand même régénéré après un run FLASH (`generateLeaderboard`) : le carnet a changé, le HTML/MD doit être à jour même si l'école Flash n'y apparaît pas.
- LOGS : chaque sélection FLASH est journalisée (`logger.info`) — classe, exercice choisi, total disponibles, base du tirage. Toujours conserver ces logs (règle d'or debug).

### Sortie temps réel du mode nuit + carnets orphelins (tâche 2026-08-10)

**Fichiers touchés :** `night-batch.js`, `leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois corrections distinctes :
1. **Mode nuit muet** : `runBenchmark()` capturait stdout/stderr puis les réécrivait à la fin — le terminal restait muet pendant tout le benchmark. Corrigé avec `stdio: 'inherit'` : la sortie du runner (spinner, exercice, score) est streamée en temps réel.
2. **Carnets orphelins** : `detectOrphanLedgers()` compare les carnets `.json` à `lms ls` et renvoie les carnets locaux dont le modèle n'est plus sur disque. Les carnets cloud sont exclus (API distantes, pas liées à LM Studio).
3. **Rapport `--lmstudio`** : nouvelle section « Carnets orphelins » qui liste explicitement les carnets obsolètes (modèle supprimé) au lieu de les masquer silencieusement.

**Fonctions :**
- `detectOrphanLedgers()` (dans `night-batch.js`) → `{ orphanLedgers: [{file, model, shortName, quantization}], lmsKeys: Set }`. Compare les carnets à `lms ls --json` via `matchLedger()`. Exclut les carnets cloud. Repli : si `lms ls` échoue, tous les carnets locaux sont vus comme orphelins (le rapport `--lmstudio` ne l'appelle qu'avec lms disponible).
- `runBenchmark()` (dans `night-batch.js`) → `stdio: 'inherit'` au lieu de capture différée. La sortie du runner apparaît en temps réel sur le terminal du mode nuit.

**Pour modifier :**
1. **Changer le comportement orphelin** (supprimer vs archiver vs marquer) : éditer la section Bloc 2b dans `leaderboard.js` et `detectOrphanLedgers()` dans `night-batch.js`.
2. **Revenir à la capture différée** (mode nuit silencieux) : remplacer `stdio: 'inherit'` par `encoding: 'utf8'` + réécriture différée dans `runBenchmark()` de `night-batch.js`.
3. **Désactiver le filtrage des orphelins du Bloc 1** : commenter le bloc `if (lmsModelKeys)` dans `leaderboard.js` (~ligne 4896).
4. **Tester** : `node leaderboard.js --lmstudio` (daemon LM Studio requis pour voir la section orphelins). Sans daemon, la section ne s'affiche pas (repli).

**Pièges :**
- `detectOrphanLedgers()` renvoie TOUS les carnets locaux comme orphelins si `lms ls` échoue (daemon éteint). Le rapport `--lmstudio` ne l'appelle que quand lms est disponible.
- La suppression d'un GGUF dans LM Studio met à jour `lms ls` immédiatement (aucun redémarrage serveur requis). Le carnet `.json` persiste sur disque jusqu'à suppression manuelle — c'est volontaire (conservation de l'historique).
- `stdio: 'inherit'` ne permet pas de capturer stdout/stderr du runner pour un log fichier. Si on veut loguer la sortie du mode nuit, il faudra rediriger le stdout du process parent (`node night-batch.js > nuit.log`).

### Forçage de la détection LM Studio (tâche 2026-08-10)

**Fichiers touchés :** `night-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** LM Studio indexe les GGUF dans un cache interne (`models.json`) qui se désynchronise de l'UI : un GGUF ajouté manuellement à `~/.lmstudio/models` peut être visible dans l'app graphique mais absent de `lms ls --json --llm`. BenchGo, qui s'appuie sur `lms ls`, ne voit alors pas ces modèles. La fonction `forceDetectModels()` scanne le dossier physique, repère les GGUF **orphelins** (présents sur disque mais absents de l'index) et les réimporter via `lms import --symbolic-link -y` (lien symbolique : le fichier d'origine n'est pas déplacé ni copié).

**Fonctions :**
- `listGgufOnDisk()` → liste les `.gguf` de `~/.lmstudio/models` (récursif), exclut `mmproj-*` et `mtp-*` (pas des LLM autonomes).
- `ggufAlreadyIndexed(ggufPath, lmsEntries)` → compare le basename du fichier aux `modelKey`/`displayName`/`path` de l'index `lms ls`.
- `forceDetectModels()` → scan + réimport des orphelins, retourne `{ scanned, orphans, imported, failed, errors[] }`.

**Deux modes d'utilisation :**
1. **Flag CLI `--force-detect`** : `node night-batch.js --force-detect` réindexe les orphelins AVANT de lister les modèles, puis continue le flux normal (sélection + batch). Non-interactif, combinable avec `--models=` et `--schools=`.
2. **Commande interactive `detect`** : pendant la sélection des modèles (`selectModelsInteractive`), taper `detect` (ou `force-detect`) déclenche le scan + réimport, puis **recharge la liste** depuis `lms ls` pour afficher les nouveaux modèles détectés sans relancer le script.

**Pour modifier :**
1. **Changer le dossier scanné** : éditer `LMSTUDIO_MODELS_DIR` (constante dans `night-batch.js`).
2. **Changer la méthode d'import** : remplacer `--symbolic-link` par `--hard-link` ou `--copy` dans l'appel `runLms(['import', ...])`.
3. **Inclure les mmproj/mtp** : retirer le filtre `/^mmproj-/i` ou `/^mtp-/i` dans `listGgufOnDisk()`.
4. **Consulter les orphelins sans réimporter** : `forceDetectModels()` est exportée dans `module.exports` — un autre module peut l'appeler et inspecter `report.orphans`.

**Pièges :**
- `lms import --symbolic-link` peut échouer si le fichier est sur un volume différent du dossier cible LM Studio (liens symboliques Windows pas toujours inter-volumes). L'erreur est affichée, le GGUF est compté en `failed` — le scan continue.
- Le scan compare les **basenames** (sans extension) à l'index. Un GGUF renommé sur disque est vu comme orphelin même si son contenu est déjà indexé sous un autre nom — c'est attendu (un fichier renommé est un nouveau modèle du point de vue de l'index).
- Les modèles déjà indexés ne sont **pas** réimportés (comparaison basenames). Pour une réindexation complète, il faudrait modifier la fonction pour ignorer la comparaison.
- Le daemon LM Studio doit être actif : `lms import` échoue si le daemon est éteint. Le flag `--force-detect` s'exécute après la vérification du daemon dans `main()`.

### Pré-test de santé + auto-blacklist (tâche 2026-08-10)

**Fichiers touchés :** `night-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Après `lms load` (réussi), `night-batch.js` envoie un ping `POST /v1/chat/completions` trivial ("Reply with: OK", `max_tokens: 8`, timeout 30 s) pour vérifier que le modèle répond réellement. Si le ping échoue (timeout, erreur, réponse vide), le modèle est déchargé et **auto-blacklisté** dans `.benchgo-blacklist.json`. L'auto-blacklist se déclenche aussi sur `load_failed` et sur `run_ko` systémique (toutes les écoles échouées).

**Fonctions :**
- `healthCheck(modelKey)` → `{ ok, content }` ou `{ ok: false, reason }`. Timeout `HEALTH_CHECK_TIMEOUT_MS` = 30 s.
- `autoBlacklist(modelKey, reason)` → ajoute à `.benchgo-blacklist.json` + enregistre `load_failed` dans l'historique. Non-bloquant si déjà blacklisté.

**Conditions d'auto-blacklist :**
1. **`load_failed`** : `lms load` échoue → blacklisting immédiat.
2. **`health_failed`** : modèle chargé mais health check KO → blacklisting après déchargement.
3. **`run_ko` systémique** : toutes les écoles du modèle ont échoué en `run_ko`, aucune réussie → blacklisting en fin de traitement du modèle.

**Désisolation :** `!!<num>` dans la sélection interactive `night-batch.js` retire le modèle de la blacklist (pour retester après correction du GGUF ou mise à jour llama.cpp).

**Pour modifier :**
1. **Changer le timeout du health check** : éditer `HEALTH_CHECK_TIMEOUT_MS` dans `night-batch.js`.
2. **Changer le prompt du ping** : éditer le `messages[0].content` dans `healthCheck()`.
3. **Désactiver l'auto-blacklist** : commenter les appels `autoBlacklist()` (3 sites) — le health check tournera toujours mais ne blacklitera pas.
4. **Consulter les modèles blacklists** : `cat .benchgo-blacklist.json` ou `node night-batch.js --list-only` (statut "Isolé manuellement" / "Échec de chargement").

**Pièges :**
- Le health check utilise le même `modelKey` que `lms load`. Si LM Studio nomme différemment le modèle dans `/v1/models`, le health check peut échouer à tort — vérifier avec `lms ls --json`.
- Un modèle peut réussir le health check mais échouer le benchmark (run_ko) si le problème ne se manifeste qu'avec des prompts longs ou du streaming. Le health check est un filet de sécurité, pas une garantie absolue.
- L'auto-blacklist sur `run_ko` systémique ne se déclenche que si **toutes** les écoles ont échoué. Un modèle qui réussit LIGHT mais échoue EXPERT n'est **pas** blacklisté (il fonctionne partiellement).

### Tarif cloud estimé (pricing.js — tâche 2026-08-04)

**Fichiers touchés :** `pricing.js` (nouveau), `runner.js`, `leaderboard.js`, `consolidate-leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md`.

**Principe :** `pricing.js` est un module autonome qui calcule un coût ESTIMATIF ($/€) pour les modèles cloud payants. Il ne fait **aucun appel bloquant** : le fetch OpenRouter `/api/v1/models` est asynchrone, le cache disque `.pricing-cache.json` (TTL 24h) sert de repli immédiat. Si le cache est périmé et le fetch échoue, la table locale `PRICING_FALLBACK` prend le relais.

**Source des prix :**
1. OpenRouter `/api/v1/models` (endpoint public, sans clé) → champ `pricing.prompt` / `pricing.completion` en $/token, converti en $/1M tokens.
2. Table locale `PRICING_FALLBACK` dans `pricing.js` (OpenAI, Anthropic, Groq, DeepSeek, Together, Mistral, Cohere).
3. Fallback générique par provider (moyenne approximative).

**Estimation des tokens :**
- `completionTokens` = `schoolTokens` (chunks SSE streamés, ≈ tokens produits).
- `promptTokens` = `Math.round(schoolPromptChars / 4)` (chars du prompt / 4).
- `schoolPromptChars` est cumulé dans `runner.js` via `tierPromptChars` (ajouté dans `runTierAttempt` : `dynamicPrompt.length` + `helpPrompt.length`), puis `schoolPromptChars` dans `runSchool`.
- Les champs `promptTokens`/`completionTokens` sont stockés dans le carnet via `saveResult` (le `result` est poussé tel quel dans `entry.attempts`).
- **Rétrocompatibilité :** si les champs sont absents (anciens carnets), `estimateModelCost()` estime `promptTokens ≈ 3 × completionTokens` (ratio moyen prompts longs / réponses courtes).

**Affichage (leaderboard.js + consolidate-leaderboard.js) :**
- Mini-stat « Coût ≈ » (USD) sur la carte → condition : `m.isCloud && m.cost`.
- StatBox « Coût ≈ » ($ / €) dans la modale → idem.
- Section « 💰 Tarif estimé par école » dans la modale → tableau tokens prompt/completion + $/€ par école + TOTAL.
- Colonne « Coût ≈ » dans l'export Markdown.
- **Toujours** mentionner « estimation indicative — non exacte » (tooltip, titre, note de bas).
- Les modèles locaux (`isCloud === false`) ou sans prix connu (`cost === null`) n'affichent rien.

**Données sérialisées vers le client :**
- `cost` : `{ usd, eur, perEcole: [{ ecole, usd, eur }], isEstimate: true, pricePerMTok: { prompt, completion } }` ou `null`.
- `promptTokens` / `completionTokens` : totaux cumulés.
- Chaque école a `promptTokens` / `completionTokens` individuels.

**Pour modifier/ajouter/corriger :**
1. **Ajouter un provider** : éditer `PRICING_FALLBACK` dans `pricing.js` (format `{ prompt: $/1M, completion: $/1M }`).
2. **Changer le taux $→€** : modifier `USD_TO_EUR` dans `pricing.js` (côté serveur) et `USD_TO_EUR_JS` dans le JS inline de `leaderboard.js` et `consolidate-leaderboard.js`.
3. **Améliorer l'estimation des prompt tokens** : modifier le calcul `Math.round(schoolPromptChars / 4)` dans `runner.js` (ligne ~2520) ou le ratio de fallback `promptTokens ≈ 3×completion` dans `pricing.js` (`estimateModelCost`).
4. **Capturer les vrais tokens API** (prompt_tokens/completion_tokens depuis le chunk `usage` du streaming) : modifier `cloud-client.js` pour activer `stream_options: { include_usage: true }` et parser le dernier chunk, puis stocker dans le résultat. C'est le seul moyen d'avoir des valeurs exactes.
5. **Changer l'affichage** : modifier le JS inline dans `leaderboard.js` (fonctions `openModal`, `renderCards`, `buildLeaderboardMarkdown`) et `consolidate-leaderboard.js` (idem). Les fonctions `fmtCost`/`fmtCostEur` sont définies dans le JS inline des deux fichiers.
6. **Tester** : `node leaderboard.js --cloud` puis `node scripts/check-inline-js.js` pour valider le JS inline. Vérifier qu'un modèle cloud payant affiche bien le coût (ex: `openai/gpt-4o-mini`).

**Pièges :**
- `pricing.estimateModelCost()` attend un objet avec `{ model, provider, isCloud, tokens, promptTokens, completionTokens, ecoles: [{ ecole, promptTokens, completionTokens, tokens }] }`. Si `ecoles` est vide ou sans tokens, le coût sera 0.
- Le cache disque `.pricing-cache.json` peut être corrompu (écriture interrompue) → `pricing.js` le détecte et recharge depuis OpenRouter.
- En CI (GitHub Actions), le fetch OpenRouter peut échouer (réseau) → le cache disque du dépôt doit être à jour. Si aucun cache et pas de réseau, `estimateModelCost()` retourne `null` (pas de coût affiché, pas de crash).
- Les fonctions `fmtCost`/`fmtCostEur` existent en **deux exemplaires** : une fois côté serveur dans `pricing.js` (exportées), une fois côté client dans le JS inline de `leaderboard.js` et `consolidate-leaderboard.js`. Les modifier dans un seul fichier ne suffit pas.
- Le taux `USD_TO_EUR_JS` (0.92) est dupliqué dans le JS inline des deux fichiers leaderboard. Si on change le taux serveur, il faut aussi changer les deux copies client.

### Agent NotebookLM (tâche 2026-08-04)

**Fichiers touchés :** `leaderboard.js`, `consolidate-leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md`.

**Principe :** BenchGo s'appuie sur un agent **NotebookLM** (Google) qui a ingéré tous les comptes rendus de tests. C'est l'outil de renseignement central de l'application. Le lien est intégré dans les en-têtes des deux classements via un badge compact + modale + bulle d'info périodique.

**Lien public :** `https://notebook.google.com/notebook/bd6cf971-b22a-460a-9892-419d1db02f9e`. Défini en une seule constante `NOTEBOOKLM_URL` en haut de `leaderboard.js` et `consolidate-leaderboard.js`. Pour le changer, modifier ces deux constantes.

**Pourquoi pas d'iframe :** NotebookLM renvoie `X-Frame-Options: DENY` + CSP `trusted-types` → l'intégration en iframe est bloquée par Google (public ou non). Un proxy local serait fragile (SPA Google avec nonces CSP rotatifs). Solution retenue : ouverture dans un nouvel onglet (`target="_blank" rel="noopener"`).

**Affichage (depuis 2026-08-08 : bandeaux → badges) :**
- `.hero-badge.nb-badge` (`#nbBadge`) : badge violet compact dans le conteneur `.hero-badges` centré sous le `<h1>` (cliquable → modale).
- `.nb-modal` (`#nbModal`) : modale d'explication des 4 usages + CTA principal.
- `.nb-tip` (`#nbTip`) : bulle d'info fixe en bas, affichée après 12 s puis toutes les ~5 min.
- JS inline : `openNbModal()`/`closeNbModal()` (bind sur `#nbBadge`) + bulle périodique + mémorisation `sessionStorage`/`localStorage`.

**Pour modifier :**
1. **Changer le lien NotebookLM** : éditer la constante `NOTEBOOKLM_URL` dans les deux fichiers (`leaderboard.js` + `consolidate-leaderboard.js`).
2. **Changer le texte du badge/modale** : éditer le HTML dans le template literal (bouton `.hero-badge.nb-badge` et `<div id="nbModal">` des deux fichiers).
3. **Changer le timing de la bulle** : modifier les valeurs `12000` (1re apparition) et `300000` (récurrence) dans le JS inline des deux fichiers.
4. **Tester** : `node leaderboard.js` puis `node scripts/check-inline-js.js`.

**Pièges :**
- Le JS inline des deux fichiers est dupliqué (constante `NOTEBOOKLM_URL`, CSS `.nb-*`/`.hero-badge`, HTML du badge/modale, fonctions `openNbModal`/`closeNbModal`). Modifier un seul fichier ne suffit pas.
- `leaderboard.js` et `consolidate-leaderboard.js` ont des styles d'insertion légèrement différents (template literal `${NOTEBOOKLM_URL}` côté serveur, pas de backticks littéraux dans le JS inline de consolidate — contrainte existante).

### GGUF Tracker — Surveillance Hugging Face (tâche 2026-08-08)

**Fichiers touchés :** `scripts/gguf-tracker.html` (nouveau), `leaderboard.js`, `consolidate-leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md`, `Memories-BenchGo/INSTRUCTIONS.md`.

**Principe :** Outil de surveillance temps réel des nouveaux modèles GGUF sur Hugging Face. Interroge l'API publique paginée `https://huggingface.co/api/models?library=gguf&sort=lastModified`, détecte les nouveautés (persisté en `localStorage`), alerte sonore (Web Audio API) + notification navigateur. Filtres : recherche, taille max (slider B), favoris ⭐, nouveaux 🆕, éditeurs vérifiés. Favoris avec détection de mise à jour.

**Charte graphique :** entièrement aligné sur BenchGo (variables CSS `--bg-*`, `--accent`, `--purple`, etc.). Pas de Tailwind. Le tracker est un fichier HTML autonome (CSS + JS inline, pas de framework).

**Emplacement :** `scripts/gguf-tracker.html` (rangé avec les autres outils de diagnostic). Anciennement `GGUF-Tracker-update.html` à la racine.

**Intégration aux classements :** badge `📡 GGUF Tracker` (bleu ciel, `.hero-badge.gguf-badge`) dans `.hero-badges` → modale géante (92vw × 90vh) contenant une `<iframe>` qui charge le tracker.

- **`leaderboard.js --serve`** : route `GET /gguf-tracker.html` sert `scripts/gguf-tracker.html`.
- **`consolidate-leaderboard.js`** : copie `scripts/gguf-tracker.html` → `gh-pages-output/gguf-tracker.html` à chaque génération. L'iframe charge `gguf-tracker.html` en chemin relatif (même origine GitHub Pages).
- Chargement paresseux : `src` de l'iframe n'est défini qu'à la 1re ouverture (`GGUF_IFRAME_LOADED`).

**Affichage :**
- `.hero-badge.gguf-badge` (`#ggufBadge`) : badge bleu ciel avec point pulsant.
- `.gguf-modal` (`#ggufModal`) : modale géante `width: 92vw; height: 90vh`.
- `.gguf-iframe` (`#ggufIframe`) : iframe 100% × 100% sans bordure.
- JS inline : `openGgufModal()`/`closeGgufModal()` (chargement paresseux + Échap + clic hors-zone).

**Pour modifier :**
1. **Changer le tracker lui-même** : éditer `scripts/gguf-tracker.html` (CSS/JS/HTML). La copie dans `gh-pages-output/` est automatique au prochain `node consolidate-leaderboard.js`.
2. **Changer la taille de la modale** : éditer `.gguf-modal` (width/height/max-width/max-height) dans le CSS des deux fichiers.
3. **Changer la couleur du badge** : éditer `.hero-badge.gguf-badge` dans le CSS des deux fichiers.
4. **Tester en local** : `node leaderboard.js --serve`, cliquer sur `📡 GGUF Tracker`. Pour le communautaire : `node consolidate-leaderboard.js` puis ouvrir `gh-pages-output/community-leaderboard.html`.
5. **Valider le JS inline** : `node scripts/check-inline-js.js`.

**Pièges :**
- Le JS inline des deux fichiers est dupliqué (CSS `.hero-badge.gguf-badge`, HTML du badge + modale, fonctions `openGgufModal`/`closeGgufModal`). Modifier un seul fichier ne suffit pas.
- L'iframe charge `gguf-tracker.html` en **chemin relatif**. Sur le serveur local, cela pointe vers la route `/gguf-tracker.html`. Sur GitHub Pages, vers `gh-pages-output/gguf-tracker.html`. Si le fichier est absent → iframe 404 (pas de crash).
- Le tracker fait des `fetch()` vers `huggingface.co` depuis le navigateur (CORS ouvert sur l'API HF publique, pas de clé nécessaire).
- `consolidate-leaderboard.js` copie le tracker avec `fs.copyFileSync`. Si `scripts/gguf-tracker.html` est absent, un avertissement est loggé mais la génération continue.
- **Le fichier DOIT être versionné dans git** (exception `.gitignore` `!scripts/gguf-tracker.html`, section 4bis). La CI fait un checkout du dépôt AVANT de lancer `consolidate-leaderboard.js` : un fichier non-commité n'existe pas en CI → copie silencieusement sautée → **404 GitHub Pages** (bug 2026-09-02). Après toute modification du tracker : commit + push + `gh workflow run consolidate.yml -R cisco-03/BenchGo-LLM-School`.

### GGUF Tracker — API HF par curseur + filtres/tri/recherche réparés (tâche 2026-09-17c)

**Fichiers touchés :** `scripts/gguf-tracker.html`, `tests/test-gguf-tracker.js` (nouveau), `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Audit expérimental de l'API HF : `library=gguf` et `offset` sont silencieusement IGNORÉS (repos non-GGUF renvoyés, toutes les pages identiques). La pagination officielle = header `Link: <url>; rel="next"` (curseur, exposé CORS). Le tracker fetchait donc des repos aléatoires → « Nouveaux » ne détectait rien, « Charger plus » re-fetchait la même page, et la recherche ne filtrait que localement. Corrections : fetch par curseur + `filter=gguf`, recherche serveur (`search=` + `filter=gguf`) déclenchée par Entrée, sélecteur de tri (récent/ancien/téléchargements/nom), strip des tokens de quantification dans `normalizeModelName()` déplacé AVANT la suppression des séparateurs (les `\b` étaient du code mort), récepteur postMessage qui réapplique toujours les filtres (le parent envoie après le rendu), messages de liste vide contextuels, notifications durcies (garde `'Notification' in window`, try/catch sur `new Notification`, `.catch()` sur `requestPermission`).

**Fonctions :**
- `extractNextCursor(linkHeader)` / `fetchPage(cursor)` / `fetchSearchPage(query, cursor)` (dans `scripts/gguf-tracker.html`) → pagination et recherche serveur par curseur.
- `sortRawModels()` → tri de `rawModels` selon `#sortSelect` (recent/ancien/downloads/nom), appelé après chaque fusion et dans `applyFilters()`.
- `searchServer()` / `onSearchInput()` → recherche serveur HF (Entrée) + retour au filtrage local dès nouvelle saisie.
- `updateEmptyMessage()` → message explicatif quand `filteredCache` est vide (nouveaux/testés/favoris/éditeurs/recherche).
- `tests/test-gguf-tracker.js` → 16 cas (unitaires via vm + DOM factice, système sur le source, intégration réseau via `spawnSync` — 60s timeout, pas de faux verts).

**Pour modifier :**
1. **Changer la taille de page / le tri API** : `fetchPage()` / `fetchSearchPage()` (`limit=250`).
2. **Changer les modes de tri** : `sortRawModels()` + `<option>` de `#sortSelect`.
3. **Désactiver la recherche serveur** : retirer listener `keydown` + `#serverSearchBtn` + `searchServer()`/`onSearchInput()`.
4. **Modifier la normalisation** : `normalizeModelName()` — ordre critique : strip tokens AVANT suppression séparateurs.
5. **Tester** : `node tests/run-tests.js` ; `node leaderboard.js` + `node consolidate-leaderboard.js` + `node scripts/check-inline-js.js`.

**Pièges :**
- `offset` ne renvoie PAS d'erreur (ignoré silencieusement) : un test visuel « ça marche » passe à côté du bug.
- `library=gguf` ≠ `filter=gguf` : seul `filter=gguf` filtre réellement (matche le tag).
- Le header `Link` est bien exposé CORS par HF — le navigateur peut suivre le curseur directement.
- La recherche serveur `search=` est stricte : un nom complet avec quantification peut ne rien renvoyer (message vide conseille un terme plus court).
- Les tests d'intégration réseau sont synchrones via `spawnSync` : sans réseau, échec affiché (jamais de faux verts).
- Commit du tracker OBLIGATOIRE après modification (cf. bug 2026-09-02, 404 GitHub Pages).

### Bandeaux → Badges dans l'en-tête (tâche 2026-08-08)

**Fichiers touchés :** `leaderboard.js`, `consolidate-leaderboard.js`.

**Principe :** Les bandeaux pleine largeur (NotebookLM, Communauté, Mise à jour) sont remplacés par des badges compacts centrés dans l'en-tête `<header class="hero">`, sous le `<h1>`. Conteneur `.hero-badges` (flex, `justify-content: center`, wrap sur mobile).

**`leaderboard.js` (4 badges) :**
- `🧠 NotebookLM` (`.nb-badge`, violet) → `#nbModal`.
- `🌐 Communauté` (`.community-badge`, vert) → `#communityModal` (commande `node runner.js --submit` + bouton « Copier »).
- `⬆️ Mise à jour` (`.update-badge`, jaune, `hidden` par défaut) → `#updateModal` (liste des 5 derniers commits + `git pull`). N'apparaît que si `data.sha !== LOCAL_SHA`. Cache localStorage 1h préservé.
- `📡 GGUF Tracker` (`.gguf-badge`, bleu ciel) → `#ggufModal` (modale géante iframe).

**`consolidate-leaderboard.js` (2 badges) :**
- `🧠 NotebookLM` (`.nb-badge`, violet) → `#nbModal`.
- `📡 GGUF Tracker` (`.gguf-badge`, bleu ciel) → `#ggufModal`.

**CSS commun (dupliqué dans les deux fichiers) :**
- `.hero-badges` : conteneur flex centré, `flex-direction: column` sur mobile.
- `.hero-badge` : pillule `border-radius: var(--r-pill)`, bordure + ombre, 4 variantes.
- `.hero-badge .dot` : pastille 8px avec `box-shadow` glow, `gguf-pulse` 2s (sauf `prefers-reduced-motion`).

**JS inline (dupliqué) :** `openXModal()`/`closeXModal()` pour chaque badge. Fermeture : bouton ×, clic hors-zone, Échap. `document.body.style.overflow` géré.

**Pour modifier :**
1. **Ajouter un badge** : ajouter `<button class="hero-badge <variante>" id="x">` dans `.hero-badges`, le CSS `.hero-badge.<variante>`, et le JS `openXModal`/`closeXModal` + la modale HTML. Dupliquer dans les deux fichiers.
2. **Supprimer un badge** : retirer le bouton + la modale + le JS + le CSS. Vérifier qu'aucun autre JS ne référence l'ID.
3. **Tester** : `node leaderboard.js` + `node consolidate-leaderboard.js` + `node scripts/check-inline-js.js`.

**Pièges :**
- L'ancien CSS des bandeaux (`.nb-banner`, `.community-banner`, `.update-banner`) est conservé car les modales réutilisent `.nb-features`, `.nb-modal-cta`, `.update-commits`, etc. Les supprimer casserait les modales.
- L'update checker (`showBadge`) fait `UPDATE_BADGE.hidden = false` pour révéler le badge. Fermer la modale fait `UPDATE_BADGE.hidden = true` + cache `dismissedAt`.
- Le badge « Mise à jour » n'existe que dans `leaderboard.js` (le consolidate n'a pas de vérification SHA locale).

### Nom d'affichage personnalisé (tâche 2026-08-05)

**Fichiers touchés :** `leaderboard.js`, `consolidate-leaderboard.js`, `community-sync.js`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/INSTRUCTIONS.md`.

**Principe :** Permet à l'utilisateur de corriger le titre affiché d'un modèle dans la modale du leaderboard, pour distinguer plusieurs modèles au même nom de base mais quantifications/paramètres différents (ex: LM Studio fournit "Phi 4" au lieu de "Phi 4 15B Q5_K_L"). Le nom personnalisé est stocké dans `ledger.displayName`, persisté dans le carnet JSON, et affiché partout à la place de `ledger.model` (brut).

**Affichage :** 5e colonne « 🏷️ Nom affiché » dans la grille d'actions de la modale (`leaderboard.js` uniquement — le consolidate est en lecture seule). Bouton « + Ajouter » si vide, « ✎ Modifier » sinon. Suggestion automatique : nom brut + quantification si le champ est vide.

**Données :**
- `ledger.displayName` : string ou absent (null = comportement historique, affiche `model`).
- Endpoint `/api/model-displayname?shortName=...` (GET/POST) dans `leaderboard.js`.
- Fallback localStorage (`benchgo_model_displaynames`) hors-serveur.
- Soumis avec le carnet (`carnet.displayName`) via `community-sync.js`.

**Pour modifier :**
1. **Changer le comportement d'affichage** : éditer `m.displayName || m.model` dans `leaderboard.js` (carte, modale, Markdown) et `consolidate-leaderboard.js` (carte, modale, exports Markdown/CSV, rapport intégral, copyLeaderboard).
2. **Changer la suggestion automatique** : éditer la logique dans `editModelDisplayName()` (JS inline de `leaderboard.js`).
3. **Changer le CSS** : éditer `.model-displayname-*` dans `leaderboard.js`.
4. **Tester** : `node leaderboard.js --serve`, ouvrir la modale, cliquer « + Ajouter » dans « Nom affiché », saisir un titre, vérifier la carte. Puis `node scripts/check-inline-js.js`.

**Pièges :**
- `displayName` est affiché mais `model` (brut) reste utilisé pour les rapprochements (`matchLedger`, `guessModelUrl`) — ne jamais éditer `model`.
- `displayName` est exposé au client via `aggregateLedger` (leaderboard.js) ET `aggregateCarnet` (consolidate-leaderboard.js). Les deux doivent l'inclure.
- Les filtres de recherche testent désormais `displayName` en plus de `model`/`shortName`/`quantization` dans les deux fichiers.
- Le `displayName` est soumis avec le carnet (`carnet: ledger` dans `buildSubmissionPayload`) — aucune modification spécifique needed côté community-sync pour la soumission, mais le titre/body de PR l'utilise.

### Mode classe-par-classe + robustesse anti-hang (tâche 2026-08-21)

**Fichiers touchés :** `night-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois corrections distinctes :
1. **`--list-only` ne demande plus à tester** : `printModelsList(models, { interactive })` extraite de `selectModelsInteractive`. `--list-only` affiche le tableau et quitte sans prompt.
2. **Mode classe-par-classe** (`--class-by-class` / `--cbc`) : chaque tier d'une école est lancé dans un process séparé (`node runner.js --force --profile=X <tierNum>`) avec un timeout de 45 min (`TIER_TIMEOUT_MS`). Un tier gelé ne bloque plus le batch — passage automatique au tier suivant. Cause du « mode automatique perdu » : `spawnSync` avec `timeout: 0` sur toute l'école → un modèle gelé hangait indéfiniment.
3. **Fonction `runSchoolClassByClass()`** : itère sur les tiers du profil (obligatoires + optionnels), lance chaque tier séparément, continue au suivant même en cas d'échec. `ok` = tous les tiers obligatoires réussis.

**Fonctions :**
- `printModelsList(models, { interactive })` (dans `night-batch.js`) → affiche le tableau des modèles. `interactive: false` = mode `--list-only` (pas d'aide sur les commandes !/!!/tok/detect).
- `runSchoolClassByClass(modelKey, schoolKey, schoolCli, extraArgs, tierFilter, stopOnFirstFailure)` → `{ ok, durationMs, tierResults, stopped }`. Lance chaque tier dans un process séparé. `stopOnFirstFailure=true` → un tier obligatoire échoué stoppe l'école (`stopped: true`) et la file entière.
- `runBenchmark(modelKey, schoolCli, extraArgs, { tierNum, timeoutMs })` → accepte un tier optionnel et un timeout. `timedOut: true` si `status=null, signal=SIGTERM`.

**Pour modifier :**
1. **Changer le timeout par tier** : éditer `TIER_TIMEOUT_MS` dans `night-batch.js`.
2. **Désactiver le mode classe-par-classe** : ne pas passer `--class-by-class` (le mode classique `runBenchmark` sans tier reste le défaut).
3. **Changer le comportement de reprise** : éditer `runSchoolClassByClass()` — `stopOnFirstFailure=false` (défaut) continue au tier suivant même si un obligatoire échoue ; `true` (mode 8 Manuel) stoppe l'école et la file.
4. **Tester** : `node night-batch.js --class-by-class --models=<key> --schools=STANDARD`.

**Pièges :**
- L'école `auto` (le runner devine le profil) reste en mode classique — on ne peut pas lancer un tier individuel sans connaître le profil.
- Le test de capacité (OUI/NON) est relancé à chaque tier en mode classe-par-classe (overhead ~30s/tier) — compromis acceptable en mode nuit.
- `spawnSync` avec `timeout` tue le process via SIGTERM. Le runner peut ne pas avoir le temps de flusher ses rapports. C'est un compromis : mieux vaut un tier incomplet qu'un batch entier bloqué.
- `runBenchmark` retourne `timedOut: true` mais `status: null` — tester `bench.timedOut` ET `bench.ok` séparément.
- **Mode 8 (exercice par exercice) est TOUJOURS en classe-par-classe**, même si l'utilisateur choisit « M » (Manuel). Le mode Manuel active `stopOnFirstFailure` (arrêt au premier échec obligatoire), pas le mode classique sans timeout. Avant ce fix, choisir M désactivait `classByClass` → le `tierFilter` était ignoré et toute l'école tournait d'un coup.
- **L'ancienne option 8 du menu des écoles est supprimée** : elle était noyée parmi 8 choix et l'utilisateur la sautait systématiquement. Désormais, le choix des tiers (exercices) est proposé **automatiquement** à l'étape suivante, après le choix des écoles et le mode d'exécution « B = Exercice par exercice ». Plus besoin de taper `8` pour y accéder. Si l'utilisateur tape encore `8`, il est redirigé vers le flux normal (choix d'une école 1-4 + mode B).
- **`--models=` accepte les display names** (ex: `OpenCoder 8B Instruct I1`) en plus des `modelKey` (ex: `opencoder-8b-instruct-i1`). Comparaison insensible à la casse/espaces. Le split se fait sur la virgule uniquement (les display names contiennent des espaces). Voir aussi la section dédiée sur la robustesse aux espaces/flags avalés.

### Provider du professeur configurable (tâche 2026-08-21)

**Fichiers touchés :** `config.js`, `runner.js`, `teacher-client.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Le professeur IA (correcteur des auto-analyses d'élève) n'était câblé que sur OpenRouter. `--teacher-provider=<provider>` permet de choisir n'importe quel provider de `CLOUD_PROVIDERS` (openai, groq, together, mistral, anthropic, deepseek, cohere, ollama, lmstudio, custom).

**Fonctions :**
- `callCloudTeacher({ provider, model, apiKey, endpoint, prompt, temperature, maxTokens })` (dans `teacher-client.js`) → appel non-streamé vers n'importe quel provider. Gère OpenAI-compat (tous sauf Anthropic) et Anthropic Messages API (`x-api-key` + `anthropic-version`).
- `askTeacherToCorrectStudentAnalysis` (dans `teacher-client.js`) → route vers `callCloudTeacher` si `provider !== 'openrouter'`, sinon Free Router avec rotation (comportement inchangé).

**Pour modifier :**
1. **Ajouter un provider** : éditer `CLOUD_PROVIDERS` dans `cloud-client.js` (le professeur réutilise la même table).
2. **Changer le provider par défaut** : éditer `TEACHER_CONFIG.provider` dans `config.js`.
3. **Changer le timeout** : éditer le `60000` dans `callCloudTeacher()` et `callOpenRouter()`.
4. **Tester** : `node runner.js --teacher-provider=groq --teacher-model=llama-3.3-70b-versatile --teacher-api-key=<key>`.

**Pièges :**
- `--teacher-model` est REQUIS pour les providers non-openrouter (pas de rotation de modèles gratuits). Sans modèle, le professeur se désactive et repli sur auto-analyse.
- Les providers locaux (ollama, lmstudio, custom) n'ont pas besoin de clé — `teacherConfig.apiKey = null` est valide.
- Anthropic utilise `x-api-key` (pas `Bearer`) + header `anthropic-version: 2023-06-01` + format Messages API (`system` séparé, `content[0].text`). `callCloudTeacher` gère les deux formats via `provSpec.openaiCompat`.
- La clé est mémorisée dans `secrets` sous le nom du provider (`secrets.rememberSecret(tProvider, key)`), pas sous 'openrouter'.
- `teacherProvider` est sauvegardé dans les presets (`--save-preset`).

### Sauvegarde auto des carnets + restauration (tâche 2026-08-21)

**Fichiers touchés :** `score-ledger.js`, `config.js`, `runner.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Les carnets de scores sont en `.gitignore` (jamais versionnés). Une suppression accidentelle du dossier `.carnet/` est irréversible. Deux mécanismes de protection :
1. **Backup automatique** : à chaque `saveLedger()`, le carnet est copié vers `Export-Rapports/.carnet-backup/`. Copie atomique (tmp + rename). Non-bloquant si échec.
2. **Restauration** : `node runner.js --restore-carnets` copie les carnets du backup absents de `.carnet/` (ne surcharge jamais un carnet existant).

**Fonctions :**
- `backupLedger(shortName)` (dans `score-ledger.js`) → copie `LEDGER_DIR/<shortName>.json` vers `LEDGER_BACKUP_DIR/<shortName>.json`. Appelée automatiquement par `saveLedger()`.
- `restoreLedgersFromBackup()` (dans `score-ledger.js`) → `{ restored, skipped, errors[] }`. Copie les carnets du backup absents de `.carnet/`.

**Pour modifier :**
1. **Changer le dossier de backup** : éditer `LEDGER_BACKUP_DIR` dans `score-ledger.js`.
2. **Désactiver le backup auto** : commenter l'appel `backupLedger(ledger.shortName)` dans `saveLedger()`.
3. **Forcer la restauration (écraser)** : modifier `restoreLedgersFromBackup()` pour retirer le check `fs.existsSync(dst)`.
4. **Tester** : `node runner.js --restore-carnets` (affiche le nombre de carnets restaurés).

**Pièges :**
- Le backup ne contient que la DERNIÈRE version de chaque carnet (écrasée à chaque save). Si un carnet est corrompu puis sauvegardé, le backup est aussi corrompu. Pour un historique versionné, il faudrait git ou des snapshots datés.
- `restoreLedgersFromBackup()` ne restaure QUE les carnets absents — elle ne répare pas un carnet existant mais corrompu.
- Le dossier `.carnet-backup/` est aussi en `.gitignore` (sous `Export-Rapports/`). Il est purement local.
- Les anciens carnets disparus (avant le 2026-08-21) ne peuvent PAS être restaurés — le backup n'existait pas encore. Seuls les carnets créés après cette date sont protégés.

### Isolation CLI + lms load -y + flux interactif réordonné (tâche 2026-08-22)

**Fichiers touchés :** `night-batch.js`, `leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois corrections distinctes :
1. **`--isoler=!N` / `--isoler=!!N`** : flag CLI one-shot pour isoler/désisoler un modèle par numéro sans session TTY. Le numéro N = position dans la liste `--list-only`. Aucun batch lancé — applique et quitte. Workflow : `--list-only` → voir les numéros → `--isoler=!4` → quitter.
2. **`lms load -y`** : `loadModel()` ajoute `-y` (`--yes`) pour approuver les prompts automatiquement. Sans ça, `lms load` affichait un sélecteur interactif (« ? Select a model to load ») qui bloquait le batch en mode non-TTY. Ctrl+C était quasi impossible car le process enfant `lms` capture le terminal via une TUI readline.
3. **Flux interactif réordonné** : `selectSchoolsManualPerModel()` est désormais appelé **dès le choix de l'option 7**, AVANT les questions mode d'exécution / tiers / passage. Le plan manuel est retourné dans le résultat (`manualPlan`) et consommé par `main()` sans second appel.

**Fonctions :**
- `parseArgs()` (dans `night-batch.js`) → expose `isolateArg` (parsing `--isoler=`).
- `loadModel()` (dans `night-batch.js`) → ajoute `-y` à `lms load`.
- `selectSchoolsInteractive()` (dans `night-batch.js`) → appelle `selectSchoolsManualPerModel()` juste après le choix de l'option 7, retourne `manualPlan` dans le résultat.

**Pour modifier :**
1. **Changer la syntaxe du flag** : éditer le regex `isolateArg.match(/^!(\d+)$/)` et `/^!!(\d+)$/` dans `main()` de `night-batch.js`.
2. **Désactiver le -y de lms load** : retirer `'-y'` du tableau `args` dans `loadModel()` de `night-batch.js`.
3. **Revenir à l'ancien flux** (manuel après questions) : retirer le bloc `if (isManualPerModel(schools))` de `selectSchoolsInteractive()` et remettre l'appel `selectSchoolsManualPerModel(selected)` dans `main()` après `selectSchoolsInteractive`.
4. **Tester** : `node night-batch.js --list-only` (voir les numéros), `node night-batch.js --isoler=!4` (isoler), `node night-batch.js --isoler=!!4` (désisoler).

**Pièges :**
- `--isoler` est one-shot : aucun batch n'est lancé. Le script applique l'isolation et quitte immédiatement.
- Le numéro N dépend de l'ordre de la liste au moment de l'appel. Si des modèles ont été ajoutés/supprimés entre `--list-only` et `--isoler`, les numéros peuvent changer.
- `-y` sur `lms load` charge le modèle sur le device préféré (ou le premier matching). Si plusieurs GGUF matchent le même modelKey, `-y` choisit automatiquement — c'est le comportement voulu en mode batch.
- `manualPlan` est retourné par `selectSchoolsInteractive` ET consommé par `main()`. Ne pas appeler `selectSchoolsManualPerModel` deux fois (double saisie).

### `--models=` robuste aux espaces et flags avalés (tâche 2026-08-22)

**Fichiers touchés :** `night-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Les display names de LM Studio contiennent souvent des espaces (ex: `Nanbeige4.2 3B`). En PowerShell, un flag non quoté `--models=Nanbeige4.2 3B,--schools=LIGHT` est coupé sur l'espace en deux argv : `--models=Nanbeige4.2` (tronqué) et `3B,--schools=LIGHT` (avalé). L'ancien `parseArgs()` ne capturait que le premier argv → `modelsArg` valait `"Nanbeige4.2"` (ne matche rien) et `--schools=LIGHT` était perdu. Deux mécanismes de récupération :

1. **Reconstitution des argv coupés** : `flagValue(flag)` prend la valeur après `=`, puis rattache les argv suivants qui ne commencent pas par `--` (continuation de la valeur coupée sur les espaces). `--models=Nanbeige4.2 3B` (2 argv) → `"Nanbeige4.2 3B"` (1 valeur).
2. **Récupération des flags avalés par la virgule** : quand un display name avec espace est suivi d'une virgule et d'un flag (ex: `Nanbeige4.2 3B,--schools=LIGHT`), la reconstitution fusionne tout dans `modelsArg`. On sépare sur la virgule : les parts qui ressemblent à un flag (`--xxx=yyy`) sont réinjectées dans leurs flags (`--schools`, `--tiers`) si non déjà définies.
3. **Match par préfixe** : si aucune correspondance exacte n'est trouvée, on tente un match par préfixe insensible à la casse/espaces. Un nom tronqué (`nanbeige4.2`) matche un modèle s'il est non ambigu (un seul candidat). Rattrape les typos et coupures shell.

**Fonctions :**
- `flagValue(flag)` (dans `parseArgs()` de `night-batch.js`) → reconstitue la valeur d'un flag coupée sur les espaces par le shell. Rattache les argv de continuation (sans `--`) jusqu'au prochain vrai flag.
- Logique de récupération des flags avalés : après reconstitution, `modelsArg` est splitée sur la virgule ; les parts `--xxx=yyy` sont réinjectées dans `schoolsArg`/`tiersArg` (si non déjà définies).
- Match par préfixe : activé uniquement si `selected.length === 0` après le match exact, et uniquement si non ambigu (1 seul candidat par clé).

**Pour modifier :**
1. **Désactiver la reconstitution** : remplacer `flagValue` par l'ancien `a.split('=').slice(1).join('=')` dans `parseArgs()`.
2. **Désactiver la récupération des flags avalés** : commenter le bloc `if (modelsArg) { ... parts = modelsArg.split(',') ... }` dans `parseArgs()`.
3. **Désactiver le match par préfixe** : commenter le bloc `if (selected.length === 0) { ... prefixMatches ... }` dans `main()` (~ligne 2003).
4. **Tester** : `node night-batch.js --list-only` (voir les modèles), puis `node night-batch.js --models=Nanbeige4.2 3B,--schools=LIGHT` (non quoté — doit maintenant fonctionner).

**Pièges :**
- `flagValue` rattache TOUT argv qui ne commence pas par `--`. Si un display name contient une valeur qui ressemble à un flag (ex: `--models=Qwen3-4B`), le `-4B` est vu comme continuation (correct). Mais `--models=Qwen3 --tiers=0` couperait la reconstitution à `--tiers=0` (commence par `--`) — c'est voulu.
- Le match par préfixe est non ambigu uniquement : `qwen` seul matcherait plusieurs modèles Qwen et serait rejeté (le script quitterait en erreur « Aucun modele »). C'est voulu pour éviter les surprises.
- `--yes-teacher` n'est pas un flag reconnu (ignoré silencieusement). Le flag correct est `--no-teacher` (désactive) ; par défaut le professeur est actif.
- La reconstitution s'applique à TOUS les flags (`--teacher-model=`, `--teacher-api-key=`, etc.), pas seulement `--models=`. Un `--teacher-model=Llama 3 70B` non quoté sera aussi reconstitué correctement.

### Résolution tolérante des slugs (OpenRouter + Kilo Gateway) + arrêt net sur slug invalide (tâche 2026-08-26)

**Fichiers touchés :** `model-resolver.js` (nouveau), `frontier-batch.js`, `runner.js`, `cloud-client.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** L'utilisateur saisit ou colle un nom familier (`gpt-4o`, `llama3.1-8b`, `nemotron 3.5 lightning`) au lieu du slug exact (`openai/gpt-4o`, `nvidia/nemotron-3.5-lightning:free`). Sans résolution, le provider renvoie HTTP 400 "X is not a valid model ID" pour chaque appel et le runner produit un rapport 0/2752 inutile. Deux mécanismes :
1. **`model-resolver.js`** : résout un slug saisi vers le slug canonique via 5 stratégies (exact → alias → préfixe → sous-chaîne → suffixe). Désambiguisateur `:free` : si les matchs ne diffèrent que par `:free`, on préfère le variant gratuit. Fonctionne pour OpenRouter (`/api/v1/models`) ET Kilo Gateway (`/api/gateway/models`) — même format de slug `provider/model-name`. La logique de matching est extraite dans `_matchSlug(raw, ids, idsSet)` réutilisable. Cache disque 24h séparé (`.pricing-cache.json` pour OpenRouter, partagé avec `pricing.js` ; `.kilo-models-cache.json` pour Kilo).
2. **Arrêt net sur slug invalide** : `cloud-client.js` détecte HTTP 400 "not a valid model ID" et HTTP 404 "model not found", marque l'erreur comme fatale (`isFatalSlugError`), et la propage quel que soit `isMandatory`. Le runner s'arrête au 1er appel au lieu de parcourir 6 classes en échec.

**Fonctions :**
- `resolveOpenRouterSlug(input)` / `resolveKiloSlug(input)` (dans `model-resolver.js`) → `{ resolved, slug, matchedBy, suggestions }` ou `{ offline: true, slug }`. Stratégies : exact, alias (COMMON_ALIASES), prefix, substring, suffix, prefer_free.
- `_matchSlug(raw, ids, idsSet)` (dans `model-resolver.js`) → logique de matching pure, réutilisée par les deux resolveurs.
- `getOpenRouterModelIds()` / `getKiloModelIds()` (dans `model-resolver.js`) → liste des slugs (cache disque 24h, sinon fetch réseau).
- `preferFreeVariant(matches)` (dans `model-resolver.js`) → si une paire (free, non-free) existe, renvoie le `:free`.
- `isFatalSlugError` (flag sur l'erreur dans `cloud-client.js`) → HTTP 400/404 de slug → propagation fatale.

**Pour modifier :**
1. **Ajouter un alias** : éditer `COMMON_ALIASES` dans `model-resolver.js` (format `'gpt4o': 'openai/gpt-4o'`).
2. **Changer la préférence `:free`** : éditer `preferFreeVariant()` dans `model-resolver.js` (retourner `null` pour désactiver).
3. **Désactiver la résolution dans frontier-batch** : commenter le bloc `if (provider === 'openrouter' || provider === 'kilo')` dans `main()` de `frontier-batch.js`.
4. **Désactiver la résolution dans runner** : commenter le bloc `if (resolvedProvider === 'openrouter' || resolvedProvider === 'kilo')` dans `main()` de `runner.js`.
5. **Revenir au comportement historique (parcourir 6 classes en échec)** : retirer `error.isFatalSlugError` du bloc `catch` dans `cloud-client.js` et `runTierAttempt` dans `runner.js`.
6. **Tester** : `node -e "const {resolveOpenRouterSlug}=require('./model-resolver'); resolveOpenRouterSlug('gpt-4o').then(r=>console.log(r))"` ou `node -e "const {resolveKiloSlug}=require('./model-resolver'); resolveKiloSlug('nemotron').then(r=>console.log(r))"` (daemon réseau requis pour le fetch).

**Pièges :**
- `model-resolver.js` ne réécrit le cache disque OpenRouter QUE s'il n'existe pas déjà (évite d'écraser les VRAIS prix de `pricing.js` avec des prix à 0). Le cache `.pricing-cache.json` est partagé entre les deux modules. Le cache Kilo (`.kilo-models-cache.json`) est indépendant.
- Si le réseau est indisponible, `resolveOpenRouterSlug()`/`resolveKiloSlug()` renvoient `{ offline: true, slug: <saisi> }` — le slug est gardé tel quel, le run démarre sans validation (comportement historique préservé).
- Les alias Claude 3.5 ont été retirés (modèles dépubliés sur OpenRouter). Les alias pointent vers les versions 4.x disponibles.
- Le désambiguisateur `:free` ne s'active QUE si une paire (free, non-free) existe. Si seul le variant `:free` existe, il est matché normalement (exact/substring).
- `isFatalSlugError` s'applique à TOUS les providers OpenAI-compat (pas seulement OpenRouter/Kilo) — tout HTTP 400 "not a valid model ID" est fatal. Pour un provider custom qui renvoie un 400 pour une autre raison, l'erreur sera aussi fatale (c'est voulu : un 400 sur le slug est toujours irrécupérable).

### Provider Kilo Gateway — accès anonyme + clé optionnelle (tâche 2026-08-26)

**Fichiers touchés :** `cloud-client.js`, `model-resolver.js`, `frontier-batch.js`, `runner.js`, `pricing.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Kilo Gateway (`api.kilo.ai`) est un agrégateur 100% compatible OpenAI (même format `/chat/completions`, streaming SSE, auth `Bearer`, slugs `provider/model-name`). Ajouté comme provider cloud pour tester les modèles gratuits en alternative à OpenRouter (rate-limits upstream systématiques). 19 modèles gratuits disponibles (dont `nvidia/nemotron-3.5-lightning:free`, `tencent/hy3:free`, `kilo-auto/free`).

**Authentification :**
- **Avec clé** (abonnement, JWT récupéré sur https://app.kilo.ai) : pas de limite, recommandé.
- **Sans clé** (accès anonyme) : toléré via `optionalAuth: true`, limité à 200 req/h/IP. Un batch FRONTIER complet dépasse largement 200 req → une clé est quasi obligatoire pour un run complet. LIGHT (2 classes) passe peut-être.
- Le header `Authorization` n'est envoyé QUE si une clé est présente (`if (resolvedKey)`).

**Fonctions :**
- `kilo` dans `CLOUD_PROVIDERS` (`cloud-client.js`) : `url: 'https://api.kilo.ai/api/gateway/chat/completions'`, `envKey: 'KILO_API_KEY'`, `optionalAuth: true`.
- `resolveKiloSlug()` / `getKiloModelIds()` / `fetchKiloModels()` (dans `model-resolver.js`) : cache disque `.kilo-models-cache.json` (TTL 24h), endpoint public `/models`.
- `getKiloPricing()` / `refreshKiloPricing()` (dans `pricing.js`) : cache disque `.kilo-pricing-cache.json`. Prix en chaînes $/token, `-1` = non défini → traité comme 0. Intégré dans `findPrice()` après OpenRouter.

**Pour modifier :**
1. **Changer l'URL de base** : éditer `url` de `kilo` dans `CLOUD_PROVIDERS` (`cloud-client.js`) et `KILO_MODELS_URL` dans `model-resolver.js` + `pricing.js`.
2. **Rendre la clé obligatoire** (désactiver accès anonyme) : retirer `optionalAuth: true` de `kilo` dans `CLOUD_PROVIDERS` + retirer `kilo` des listes d'exclusion dans `runner.js` (dry-run + avertissement clé) + retirer de `PROVIDERS_OPTIONAL_KEY` dans `frontier-batch.js`.
3. **Changer le TTL du cache Kilo** : éditer `CACHE_TTL_MS` dans `model-resolver.js`/`pricing.js` (partagé avec OpenRouter).
4. **Tester** : `node runner.js all --provider=kilo --model=nvidia/nemotron-3.5-lightning:free --profile=LIGHT --dry-run` (valide sans clé). `node -e "const {resolveKiloSlug}=require('./model-resolver'); resolveKiloSlug('nemotron').then(r=>console.log(r))"`.

**Pièges :**
- L'accès anonyme (sans clé) est limité à 200 req/h/IP. Un batch FRONTIER complet (6 classes × ~10 exercices + aide + rattrapage) dépasse largement ce quota → l'utilisateur DOIT fournir une clé pour un run complet. Sans clé, seul LIGHT passe peut-être.
- **NVIDIA free endpoints** : usage trial, données journalisées par NVIDIA. Ne pas envoyer de données confidentielles (voir NVIDIA API Trial Terms of Service).
- Les prix `-1` (non définis, modèles auto/free) sont traités comme 0 par `pricing.js`. Si un modèle payant a un prix réel mais l'endpoint renvoie `-1` (bug), le coût affiché sera 0$ (sous-estimé).
- Le cache disque Kilo (`.kilo-pricing-cache.json`, `.kilo-models-cache.json`) est distinct du cache OpenRouter (`.pricing-cache.json`) pour ne pas mélanger les listes/prix.
- Kilo Gateway propose des modèles `kilo-auto/*` (frontier, efficient, free, small) qui routent automatiquement vers un modèle sous-jacent — le modèle résolu peut changer côté serveur sans préavis.

### Test de capacité OUI/NON en remplacement de l'auto-profilage (tâche 2026-08-26)

**Fichiers touchés :** `capability-check.js` (nouveau), `runner.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** L'auto-profilage (`self-profiling.js`, interview JSON sur 4 compétences, 1-5 min) et le profilage externe (`external-profiling.js`, professeur IA, 5-20s) prenaient 1 à 10 min avant le moindre exercice. Plusieurs utilisateurs annulaient le run tellement c'était long. Remplacés par un **test de capacité** simple (~20-30s) : un seul appel au modèle élève lui demande s'il est capable de passer l'examen.

- **OUI** → le runner valide et commence les exercices. **Plus aucun filtrage** : toutes les tâches de tous les tiers sont exécutées.
- **NON** → modèle **recalé définitivement** : `process.exit(0)` propre, pas de pénalité, pas de carnet créé.

Le **pre-flight check** (détection rate-limit 200/400 vide, section ci-dessous) est **conservé** et s'exécute juste avant le test de capacité.

**Fonctions :**
- `runCapabilityCheck(queryFn, providerConfig, contextLimitTokens)` (dans `capability-check.js`) → `{ capable, rawAnswer, attempts }`. 1 appel, 2 tentatives max, timeout 30s/tentative (pire cas ~60s, attendu ~20-30s).
- `interpretCapabilityAnswer(text)` (dans `capability-check.js`) → `'YES' | 'NO' | null`. Parsing robuste : casse, accents, prose, variants FR/EN. Patterns NON testés en priorité. Réponse indéterminée après 2 tentatives → **OUI par défaut** (prudence : ne pas exclure un modèle bavard/mal formaté).

**Conséquences dans `runner.js` :**
- `selfProfile` reste `null` → le bloc de filtrage `if (selfProfile && selfProfiling.enabled && !selfProfiling.bypassFilter)` dans `runTierAttempt` ne se déclenche plus (aucune tâche bypassée).
- `filterProfile` forcé à `null` → toutes les tâches exécutées.
- L'**Indice de Calibration** n'est plus calculé (`selfProfile` null → bloc `if (selfProfile && allEvalResults.length > 0)` court-circuité). La section calibration disparaît des nouveaux rapports ; les anciens carnets conservent leur `calibrationIndex`.
- Imports : `runSelfProfiling` et `runExternalProfiling` retirés du runner ; `runCapabilityCheck` ajouté. `filterTasksByProfile`/`SKILL_LABELS` conservés (leaderboard/rapports historiques).

**Pour modifier :**
1. **Changer le prompt du test** : éditer `CAPABILITY_PROMPT` dans `capability-check.js`.
2. **Changer le timeout / tentatives** : éditer `CAPABILITY_TIMEOUT_MS` et `MAX_ATTEMPTS` dans `capability-check.js`.
3. **Changer la logique de parsing** : éditer `interpretCapabilityAnswer()` (`noPatterns` / `yesPatterns` / `maybePatterns`).
4. **Changer le comportement NON** (exclure + marquer dans carnet au lieu d'exit 0) : remplacer le `process.exit(0)` dans `runner.js` (bloc `if (!capabilityResult.capable)`) par la création d'un carnet marqué « recalé ».
5. **Réactiver le filtrage** : remettre `filterProfile` à un profil non-null dans `runner.js` (reconstruire un profil depuis la réponse de capacité, ou réimporter `runSelfProfiling`).
6. **Réactiver l'auto-profilage complet** : restaurer les imports `runSelfProfiling`/`runExternalProfiling` et le bloc historique (cf. git history avant cette tâche).
7. **Tester** : `node runner.js --provider=openrouter --model=<slug> --profile=LIGHT`. Le test de capacité remplace l'auto-profilage (bannière « TEST DE CAPACITÉ »).

**Pièges :**
- `interpretCapabilityAnswer` teste les patterns NON en **priorité** : "non, je ne suis pas capable" → NO ; "Oui mais non" (rare) → NO (prudence).
- Le test de capacité ne remplace PAS le pre-flight check : le pre-flight détecte les modèles qui ne répondent **pas du tout** (rate-limit silencieux 200/400 vide), le test de capacité détecte les modèles qui répondent **mais refusent**.
- `selfProfile` null désactive l'Indice de Calibration (métrique auto-évaluation vs performance). Les anciens carnets gardent leur calibrationIndex ; les nouveaux n'en ont plus.
- `self-profiling.js` et `external-profiling.js` sont **conservés** (pas supprimés) : le leaderboard les lit encore pour afficher l'auto-profilage des anciens carnets. Ils ne sont simplement plus appelés par le runner.
- Une réponse indéterminée (modèle bavard qui ne dit ni OUI ni NON clairement) → OUI par défaut. Le modèle aura sa chance à l'examen réel qui le jugera sur preuve. C'est voulu : exclure un modèle fonctionnel mais mal formaté serait une erreur.

### Détection des réponses vides (modèles free rate-limités) + pre-flight check (tâche 2026-08-26)

**Fichiers touchés :** `cloud-client.js`, `runner.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Les modèles **free** d'OpenRouter passent par un pool partagé vers un provider upstream (ex: Decart). Quand ce pool est saturé, le provider renvoie soit un HTTP 429 (explicite), soit un HTTP 200 avec des chunks SSE **vides** (`delta.content: ""`) — rate limit silencieux. Le parser SSE voyait ça comme un succès (statut=OK, 0 tokens) → le runner continuait → rapport 0/0 après ~5 min d'attente. Trois mécanismes de protection :

1. **Détection SSE** : `streamOpenAICompatResponse` détecte les chunks d'erreur (`chunk.error`) et les réponses vides (chunks reçus mais 0 contenu) → lève `isEmptyResponse`.
2. **Pre-flight check** : avant le test de capacité, un ping trivial ("Reply with: OK", 8 tokens) vérifie que le modèle répond. 3 tentatives → arrêt net `E505_MODEL_UNRESPONSIVE`.
3. **Compteur de réponses vides** : `runSchool` compte les `isEmptyResponse` consécutives → arrêt après 3.

**Fonctions :**
- `isEmptyResponse` (flag sur l'erreur dans `cloud-client.js`) → réponse vide HTTP 200 → propagation au runner.
- Pre-flight check (dans `main()` de `runner.js`) → ping `queryFn('Reply with: OK')` × 3 → `E505_MODEL_UNRESPONSIVE` si toutes échouent.
- `consecutiveEmptyResponses` / `MAX_EMPTY_RESPONSES = 3` (dans `runSchool`) → arrêt net après 3 réponses vides consécutives.

**Pour modifier :**
1. **Changer le seuil de réponses vides** : éditer `MAX_EMPTY_RESPONSES` dans `runSchool()` de `runner.js`.
2. **Changer le nombre de tentatives du pre-flight** : éditer `MAX_PING_ATTEMPTS` dans `main()` de `runner.js`.
3. **Changer le prompt du ping** : éditer `'Reply with: OK'` dans le pre-flight check de `runner.js`.
4. **Désactiver le pre-flight** : commenter le bloc `if (isCloudMode) { ... pre-flight ... }` dans `main()` de `runner.js`.
5. **Désactiver la détection de réponse vide** : retirer le bloc `if (!fullContent.trim() && !reasoningContent.trim())` dans `streamOpenAICompatResponse` de `cloud-client.js`.
6. **Tester** : `node runner.js --provider=openrouter --model=z-ai/glm-5.2:free --profile=LIGHT` (si le modèle est rate-limité, le pre-flight arrête en <30s avec un message clair).

**Pièges :**
- Le pre-flight check ne s'active qu'en mode cloud (`isCloudMode`), pas en local.
- Les modèles free peuvent alterner entre 429 (explicite) et 200 vide (silencieux) selon la charge. Le pre-flight capte les deux.
- `isEmptyResponse` est propagée même en `isMandatory=false` — comportement différent de l'historique (les erreurs optionnelles retournaient `null`). Mais une réponse vide n'est pas "optionnelle", c'est un échec réel.
- Le rate-limit upstream est **passager** (minutes à heures), pas permanent. Un modèle qui échoue maintenant peut fonctionner dans 10 min. Ce n'est PAS un bug de BenchGo ni un modèle défectueux — c'est la nature des pools gratuits partagés.

### Énoncés manquants « contrainte_negative_* » dans les prompts (tâche 2026-08-27)

**Fichiers touchés :** `tiers/tier0_light.json`, `tiers/tier1_light.json`, `tiers/tier2_light.json`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Les exercices `contrainte_negative_0/1/2` figuraient dans le tableau `tasks` des tiers LIGHT (donc étaient évalués) mais **n'étaient jamais demandés dans le `prompt`** envoyé aux modèles. Tous les modèles échouaient avec `ReferenceError: sansLettreE is not defined` (ou `exactementNMots` / `sansMarkdown`) car ils ne pouvaient pas deviner qu'il fallait définir ces fonctions. Bug de définition des tiers, pas des modèles — le professeur IA lui-même a donné un diagnostic erroné (blâmant l'élève).

**Changements :**
- `tier0_light.json` : ajout de `[EXERCISE contrainte_negative_0]` décrivant `sansLettreE(c)`.
- `tier1_light.json` : ajout de `[EXERCISE contrainte_negative_1]` décrivant `exactementNMots(phrase, n)`.
- `tier2_light.json` : ajout de `[EXERCISE contrainte_negative_2]` décrivant `sansMarkdown(c)`.

**Pour modifier :**
1. **Vérifier qu'un exercice du tableau `tasks` a bien son énoncé dans le `prompt`** : `node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('tiers/tier0_light.json','utf8')); j.tasks.forEach(t=>{if(!j.prompt.includes(t.id))console.log('MANQUANT: '+t.id)})"`. Tous les IDs de `tasks` doivent apparaître dans le `prompt`.
2. **Ajouter un énoncé** : ajouter `[EXERCISE <id>]` + description dans le `prompt`, à la fin (après les exercices algorithmiques).

**Pièges :**
- Les exercices de base (`tache_0a` etc.) utilisent des IDs différents dans le prompt (`0-A`, `0-B`) — c'est historique, le parser extrait les fonctions par nom (`direBonjour`), pas par ID. Seuls les exercices algorithmiques et `contrainte_negative_*` utilisent leur ID dans le prompt.
- Les fonctions de référence dans `verify_tiers.js` (lignes 117-121) doivent rester cohérentes avec les évaluateurs `exec` des tiers.

### Carnet non sauvegardé en mode classe-par-classe (tâche 2026-08-27, renforcée 2026-09-02)

**Fichiers touchés :** `night-batch.js`, `leaderboard.js`, `.gitignore`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Le mode classe-par-classe (`--class-by-class` / `--cbc`) lance chaque tier dans un process séparé avec `tierArg = numéro du tier`. Or le runner ne sauvegarde le carnet QUE si `tierArg === "all"` (`runner.js:2654`). En mode classe-par-classe, le carnet n'est jamais écrit → le leaderboard affiche les modèles comme "JAMAIS TESTÉS" malgré des rapports valides.

**Changement :** `runSchoolClassByClass()` lance un run `all` de consolidation après les tiers, si : (1) la sélection (filtre compris) couvre TOUS les tiers obligatoires du profil — `mandatoryCovered` (renfort 2026-09-02 : avant, un filtre de tiers bloquait la consolidation même quand tous les obligatoires étaient couverts → HarnessLLM/Grug/Ornith passés par tiers puis affichés « JAMAIS TESTÉ »), (2) l'école ne s'est pas arrêtée (mode Manuel). Un tier obligatoire échoué ne bloque plus la consolidation : parité avec le mode classique (un échec d'école laisse quand même une tentative dans le carnet). Timeout de sécurité : `TIER_TIMEOUT_MS × (mandatory + optional)` pour ne pas réintroduire le hang infini.

**Statut PARTIEL « sans carnet » (2026-09-02) :** `listLlmModels()` classe désormais en `partial` (raison « Tiers testés, carnet absent », flag `noCarnet: true`) un modèle sans carnet mais (a) ayant une entrée `ok` dans `.benchgo-run-history.json`, OU (b) ayant des rapports de tiers sur disque — `scanTierReportShortNames()` scanne les NOMS de fichiers `rapport_v3_<shortName>_<profil>_tier<N>_*.md` sous `Export-Rapports/` (cache module, noms seuls). La colonne « Écoles manquantes » de `--list-only` et du leaderboard affiche la raison au lieu de la liste brute.

**Avertissement carnet si filtre incomplet (2026-09-07c) :** un filtre de tiers (`--tiers=` ou sélection interactive) qui ne couvre pas TOUS les tiers obligatoires d'une école provoque `mandatoryCovered = false` → la consolidation est annulée → AUCUN carnet écrit pour cette école. Le modèle reste « Tiers testés, carnet absent » indéfiniment aussi longtemps que le même filtre incomplet est rejoué. Cas réel : `kai-os_grug-12b@q6_k_l` STANDARD testé sur tiers [1,3] mais obligatoires [0,1,2] → 3-4 sessions perdues sans carnet. Désormais, `selectSchoolsInteractive()` (après le choix des tiers) et le chemin CLI `--tiers=` + `--schools=` affichent un `⚠ ATTENTION` listant les écoles et tiers obligatoires manquants AVANT le batch. L'avertissement ne bloque pas (un test partiel reste utile pour le tri rapide), mais prévient la perte de sessions. Pour récupérer un carnet manquant : relancer sans `--tiers=` (tous les tiers → consolidation auto) ou avec `--tiers=` couvrant les obligatoires manquants + `--resume`.

**Pour modifier :**
1. **Désactiver la consolidation** : commenter le bloc `if (mandatoryCovered && !stopped)` dans `runSchoolClassByClass()`.
2. **Revenir à l'ancienne condition** : remplacer `mandatoryCovered` par `allMandatoryOk && !tierFilter` (consolidation seulement si tous les obligatoires réussissent ET pas de filtre).
3. **Éviter le re-test complet** : implémenter la sauvegarde du carnet en mode tier unique dans `runner.js` (modifier `saveAndBuildBilan` pour gérer les résultats partiels par tier).
4. **Changer la raison affichée** : éditer la chaîne `'Tiers testés, carnet absent'` dans `listLlmModels()` (night-batch.js) — largeur de colonne recalculée dessus.
5. **Désactiver le scan des rapports** : commenter l'appel `modelHasTierReports(modelKey)` dans `listLlmModels()` (le statut retombe sur l'historique des runs seul).

**Pièges :**
- Le run de consolidation double le temps par modèle (re-test complet). C'est volontaire : le carnet est un cumul multi-écoles qui nécessite un run complet.
- Si la consolidation échoue ou timeout (kill SIGTERM), le carnet est possiblement absent pour cette école. Un avertissement est affiché.
- La consolidation ne se déclen qu'avec `--class-by-class`. Le mode classique lance déjà un run `all`.
- Le scan des rapports ne détecte que les fichiers `*_tier<N>_*` NON renommés ; un rapport supprimé n'est plus une preuve de test.
- Un modèle dont la sélection ne couvre PAS les obligatoires reste volontairement sans carnet (test rapide) — le statut PARTIEL « sans carnet » l'indique honnêtement.
- GGUF Tracker : `scripts/gguf-tracker.html` DOIT être versionné (exception `.gitignore` `!scripts/gguf-tracker.html`). Sans commit du fichier, la CI ne le copie pas dans `gh-pages-output/` → 404 GitHub Pages (bug 2026-09-02).

### --skip (passer au modèle suivant) + --resume (reprise à l'exercice près) (tâche 2026-09-02b)

**Fichiers touchés :** `night-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Ctrl+C reste l'arrêt COMPLET (décharge + serveur) — comportement historique préservé, ne pas le détourner. Deux nouveaux mécanismes :

1. **`--skip`** (one-shot, second terminal) : écrit la sentinelle `.benchgo-skip`. Le batch la détecte en ≤3 s (`SKIP_POLL_MS`), kill l'arbre du runner (`taskkill /T /F` sous Windows — pas de signal SIGTERM exploitable), consigne « passé avec --skip » (PAS de run_ko, PAS d'auto-blacklist — un modèle écourté n'est pas défaillant) et passe au modèle suivant. Fonctionne en mode classique ET classe-par-classe, pendant un tier OU pendant la consolidation (dans ce cas la progression est préservée).

2. **`--resume`** : (a) ignore les écoles déjà au carnet (`matchLedger` + `ledgerSchoolKeys`), (b) en classe-par-classe, saute les tiers mémorisés dans `.benchgo-progress.json` — chaque tier réellement passé (réussi OU échoué) est enregistré par `recordProgressTier()` après chaque run non-killé. Le batch reprend à l'exercice près, puis la consolidation « all » écrit le carnet et purge la progression (`clearProgress()`).

**Fonctions :**
- `skipRequested()` / `consumeSkip()` / `killActiveRunner()` → sentinelle fichier `.benchgo-skip` (cross-process, aucun stdin — le runner enfant monopolise le clavier via stdio inherit).
- `runBenchmark(modelKey, schoolCli, extraArgs, { tierNum, timeoutMs })` → **async depuis cette tâche** (spawn + poll sentinelle/timeout). Retourne `{ ok, status, durationMs, timedOut, skipped, signal }`. La cause du kill est déterminée par le poll (`killReason`), pas par le signal.
- `runSchoolClassByClass(..., resumeTiersDone)` → async, 7e paramètre = tiers déjà passés (--resume). Retour ajoute `skippedByUser`.
- `loadProgress()/saveProgress()/getProgressTiers()/recordProgressTier()/clearProgress()` → `.benchgo-progress.json`, clé `<modelKey>|<schoolKey>`, purge auto > 30 jours.

**Pour modifier :**
1. **Changer le délai de réaction du --skip** : éditer `SKIP_POLL_MS` (night-batch.js, const en haut).
2. **Désactiver la reprise par tier** : commenter l'appel `getProgressTiers()` dans main() et le paramètre `resumeTiersDone` (la reprise écoles-au-carnet fonctionne toujours).
3. **Désactiver la mémorisation des tiers passés** : commenter `recordProgressTier()` dans `runSchoolClassByClass()`.
4. **Changer la rétention de la progression** : éditer le cutoff `30 * 24 * 3600 * 1000` dans `loadProgress()`.
5. **Revenir au spawnSync (pas de --skip possible)** : réécrire `runBenchmark()` avec `spawnSync` — les appelants devront retirer les `await`.
6. **Tester** : `--skip` → lancer un batch, `node night-batch.js --skip` dans un autre terminal, vérifier « écourté — passage au modèle suivant » + bilan « passé avec --skip ». `--resume` → relancer le même modèle/école : « N tier(s) déjà passé(s) ignoré(s) » et 0.0 min si tout était fait.

**Pièges :**
- `--skip` pendant la consolidation : `skippedByUser` est remonté APRÈS la consolidation → pas de recordRun mensonger, progression préservée (pas de clearProgress).
- Un tier killé (timeout OU --skip) n'est PAS mémorisé dans `.benchgo-progress.json` — interrompu ≠ passé, il sera rejoué.
- `--resume` sans `--class-by-class` ne fait que sauter les écoles du carnet (le runner ne sauvegarde rien par tier en mode classique).
- Un `--skip` tapé sans batch en cours reste sur disque → consommé au prochain batch (démarrage ≤3 s après le lancement du 1er run). Supprimer `.benchgo-skip` pour l'annuler.
- `runBenchmark` est ASYNC : tout nouvel appelant doit `await` (les 3 sites actuels : tiers cbc, consolidation, mode classique).
- La sentinelle ne traverse PAS `--list-only`/`--isoler` (one-shot quittent avant tout run) — seul un batch avec runs actifs la consomme.
- Ne PAS utiliser Ctrl+C pour « passer au suivant » : le handler SIGINT décharge les modèles et quitte le process entier (c'est son rôle).

### Audit complet des exercices — 8 bugs corrigés (tâche 2026-08-30)

**Fichiers touchés :** `tiers/tier0_light.json`, `tiers/tier1_light.json`, `tiers/tier2_light.json`, `tiers/tier3_standard.json`, `tiers/tier5_standard.json`, `tiers/tier4_frontier.json`, `tiers/tier2_expert.json`, `tiers/tier3_expert.json`, `vm-sandbox.js`, `custom-evaluators.js`, `verify_tiers.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Audit exhaustif des 18 fichiers de tiers + évaluateurs. Un bug d'exercice met en échec TOUS les modèles (élèves) — les exercices doivent être irréprochables. 3 sources croisées : demandes d'élèves (`Carnet-Professeur/`), scan systématique tâche↔prompt↔évaluateur, tests avec solutions canoniques. `verify_tiers.js` passait 368/388 mais MASQUAIT les bugs car ses solutions de référence contournaient les défauts (ex: `__proto__` construit via `join()`).

**Corrections :**
1. **Régression énoncés `contrainte_negative_*`** : le working tree avait annulé le fix 1f9874d — `sansLettreE`/`exactementNMots`/`sansMarkdown` étaient évalués sans énoncé dans les 3 tiers light. Restaurés depuis HEAD.
2. **Énoncés jamais existé** : ajout de `contrainte_stricte_3` (tier3_standard), `contexte_long_5` (tier5_standard), `tache_4i` + `tache_4j` (tier4_frontier).
3. **Contrat tache_2a (tier2_expert)** : le prompt demandait `executerEnPool(taches, concurrence)` mais l'évaluateur attend `chargerEnParallele(urls, chargement)` → `{succes, echecs}`. Énoncé [2-A] réécrit sur le contrat réel.
4. **Énoncés tier3_expert précisés** : [3-A] PowerShell (backup `production_backup.db`, try/catch, sqlite3), [3-B] FloodFill (doit retourner la matrice), [3-C] middleware (Authorization, 403 « Access Denied », `fetch(request)`), [3-E] retry (délai optionnel), [3-F] anti-pollution (`__proto__` ignoré).
5. **`vm-sandbox.js` faux positif `__proto__`** : la regex `/__proto__/i` bloquait même la garde défensive `if (k === '__proto__') continue;` → exercice 3-F infaisable. Désormais seules les ÉCRITURES sont bloquées (assignation directe/bracket, `Object.setPrototypeOf`) ; lectures/comparaisons autorisées.
6. **`custom-evaluators.js` setTimeout sûr** : `creerSetTimeoutSur()` (délégation timer hôte, callback thunké, délai ≤ 5s, objet gelé) injecté dans `exposerFonctionVM` — les solutions avec backoff passent (« setTimeout is not defined » résolu) sans exposer le Function constructor.
7. **`evaluateFloodFill` in-place** : la matrice est passée par référence (`sandbox.__mat__`) ; l'évaluateur accepte retour OU mutation in-place.
8. **`verify_tiers.js` solution 3f canonique** : `if (k === "__proto__") continue;` remplace le contournement `join()`.

**Pour modifier :**
1. **Vérifier qu'une tâche a son énoncé** : `node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('tiers/tierX.json','utf8')); j.tasks.forEach(t=>{if(!j.prompt.includes(t.id))console.log('MANQUANT: '+t.id)})"`.
2. **Désactiver le setTimeout sûr** : retirer `sandbox.setTimeout = creerSetTimeoutSur();` dans `exposerFonctionVM` (custom-evaluators.js).
3. **Re-bloquer toute mention `__proto__`** : restaurer la regex `/__proto__/i` dans `detectSandboxEscape` (vm-sandbox.js ~ligne 82) — l'exercice 3-F redevient infaisable avec la solution canonique.
4. **Re-exiger le return du FloodFill** : supprimer le repli `return matrix;` dans `runFloodFill` (custom-evaluators.js).
5. **Tester** : `node verify_tiers.js` + tests canoniques des évaluateurs custom (le verify ne couvre QUE les `exec`, pas les `pattern`/`custom`).

**Pièges :**
- Toujours vérifier `git status` avant de toucher aux tiers : la régression #1 est passée inaperçue parce que le working tree avait annulé un commit.
- Les IDs historiques (`math`, `francais`, `tache_0a`) n'apparaissent pas littéralement dans les prompts (`[EXERCISE Math]`) — voulu (extraction par nom de fonction), PAS des bugs.
- `verify_tiers.js` ne couvre que les évaluations `exec` : les `pattern`/`custom` doivent être testées avec des solutions canoniques réalistes.
- Le setTimeout sûr est plafonné 5000 ms : backoff réaliste OK, sleep long volontaire raccourci.
- L'anti-pollution 3-F teste `({}).pollued` APRÈS l'appel : une solution qui recopie `{...base}` sans filtrer `__proto__` pollue réellement le prototype → l'échec est légitime.

### Modèles gratuits : faux échecs + mode AUTO + batch non-bloquant (tâche 2026-08-31)

**Fichiers touchés :** `cloud-client.js`, `runner.js`, `capability-check.js`, `cli-help.js`, `frontier-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois corrections distinctes :
1. **Faux E505 sur les modèles thinking free** : le pre-flight ping (8 tokens) et le test de capacité (16 tokens) étaient intégralement consommés par la phase de raisonnement (`delta.reasoning`) → réponse vide → modèle déclaré mort. Budgets passés à 512 tokens, et `streamOpenAICompatResponse` collecte maintenant `delta.reasoning` (OpenRouter) en plus de `delta.reasoning_content` (DeepSeek/GLM). Vérifié en live : `ling-3.0-flash-fin:free` répond « OK ».
2. **HTTP 403 « Key limit exceeded »** : un slug SANS suffixe `:free` est PAYANT sur OpenRouter — la limite de dépense de la clé (0$ configurée par l'utilisateur) le rejette. C'est un comportement protecteur : les `:free` passent ce gate et ne consomment RIEN. Nouveau code `E506_KEY_LIMIT_EXCEEDED` avec diagnostic explicite (« modèle payant + clé limitée, utilisez un slug :free, NE déverrouillez PAS la limite »).
3. **Batch de nuit gelé par des prompts** : `stdio: 'inherit'` rend `isTTY` true même en batch → les prompts de résolution de slug (frontier-batch), de soumission communautaire et d'écoles séquentielles (runner) bloquaient la file jusqu'au matin. Neutralisés sous `--force` / `--yes` / non-TTY.

**Fonctions :**
- `profileForModel(model)` (dans `frontier-batch.js`) → profil détecté depuis le slug (`detectProfileFromModelName`), FRONTIER si taille inconnue. Utilisé par le mode `--profile=AUTO`.
- E506 : détection `/Key limit exceeded/i` sur l'erreur du ping → `keyLimitExceeded=true` → message E506 au lieu de E505 (dans `main()` de `runner.js`).
- `--yes` (frontier-batch) : `opts.yes` + implicite en non-TTY → aucun prompt de résolution de slug, slug gardé tel quel avec avertissement.

**Pour modifier :**
1. **Changer le budget du ping** : éditer `maxTokens: 512` dans le pre-flight de `runner.js` (~ligne 1860).
2. **Changer le budget capacité** : éditer `CAPABILITY_MAX_TOKENS` dans `capability-check.js`.
3. **Désactiver le mode AUTO** : retirer l'entrée `AUTO` de `CLOUD_PROFILES` (frontier-batch.js) — `profileForModel` ne sera plus appelée.
4. **Réactiver les prompts en batch** : retirer les tests `!forceFlag` sur `proposeCommunitySubmission` et les écoles séquentielles dans `runner.js` ; retirer le bloc `nonInteractive` dans la résolution de slug de `frontier-batch.js`.
5. **Tester** : `node runner.js all --provider=openrouter --model=<slug:free> --profile=LIGHT --dry-run` (clé restaurée depuis .api-keys.json), puis ping live via cloud-client.

**Pièges :**
- **Un slug sans `:free` sur OpenRouter est PAYANT par défaut.** Toujours vérifier le suffixe. La limite 0$ de la clé protège — ne JAMAIS demander de la déverrouiller pour un modèle payant.
- `delta.reasoning` et `delta.reasoning_content` : selon le provider, l'UN ou l'AUTRE est présent par chunk. Le code collecte les deux avec `||` — un seul est non-nul.
- `--yes` est implicite en non-TTY : un slug non résolu est gardé tel quel et échouera avec l'erreur HTTP 400 fatale sur CE modèle uniquement (la file continue).
- La clé élève est restaurée depuis `.api-keys.json` en mode CLI direct (`node runner.js --provider=X --model=Y`) depuis cette tâche — avant, seul le questionnaire/preset la restaurait → dry-run « sans clé » erroné.
- Le mode AUTO de frontier-batch choisit le PROFIL par modèle ; il ne remplace pas `--class-by-class` de night-batch (isolation par TIER, anti-hang local).

### --submit autonome + régression énoncés 4i/4j + améliorations dynamiques (tâche 2026-08-31b)

**Fichiers touchés :** `submit-action.js` (nouveau), `runner.js`, `cli-help.js`, `auto-updater.js`, `tiers/tier{0,1,2}_light.json`, `tiers/tier3_standard.json`, `tiers/tier4_frontier.json`, `tiers/tier5_standard.json`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Quatre corrections distinctes :
1. **`node runner.js --submit` seul tombait dans le questionnaire** : --submit n'était qu'un flag de confirmation post-run, jamais une action unitaire. Nouveau module `submit-action.js` : soumission directe d'un carnet existant (PR GitHub + merge auto) sans benchmark.
2. **Machine à régressions `updateTiers()` (auto-updater.js) — CAUSE RACINE des énoncés perdus** : à chaque run, `updateTiers()` reconstruisait le prompt en coupant tout à partir du header `[ALGORITHMIC EXERCISES...]` et en réattachant le bloc algo de la banque — les énoncés custom placés APRÈS ce bloc (`contrainte_negative_0/1/2`, `contrainte_stricte_3`, `contexte_long_5`, `tache_4i/4j`) étaient effacés du disque à CHAQUE run. C'est pourquoi le bug « revenait » après chaque restauration (1f9874d puis 62e7e4b) sans que personne ne touche aux fichiers. Le prompt reconstruit est désormais `base + algoPrompt + suffix` où `suffix` = contenu suivant le dernier exercice de la banque algo.
3. **Régression des énoncés par le commit 0a7c5f3** : les prompts de 6 tiers ont été tronqués à la fin (perdant les énoncés restaurés par 62e7e4b). Cause de la demande de l'élève `inclusionai/ling-3.0-flash-fin:free` sur tache_4i : l'énoncé `filtrerCommentaires` n'existait pas, l'exercice était infaisable — le professeur IA a eu tort de le blâmer.
4. **Section « AMÉLIORATIONS ACTIVES CE RUN » figée** : désormais dynamique — les 5 dernières entrées de `Docs/CHANGELOG.md` (regex `^## (date) — (titre)$`) sont affichées à chaque run.

**Fonctions :**
- `runSubmitAction(cliArgs)` (dans `submit-action.js`) → action autonome : liste les carnets avec `ecoles` non vides, cible via `--model=` (match model/shortName/displayName) > dernier modifié > choix interactif (TTY), soumet via `communitySync.submitResults`.
- `listLocalLedgers()` / `findLedgerByName(ledgers, name)` (dans `submit-action.js`) → scan `.carnet/*.json` (exclut les utilitaires comme `classement_snapshot.json` via le champ `ecoles`) et résolution de nom tolérante (casse, tirets/underscores).
- `getRecentImprovements(n)` / `printActiveImprovements(n, {hybrid})` (dans `cli-help.js`) → parse le CHANGELOG, affiche le bloc dynamique avec repli sur la liste figée si absent.
- Déclencheur dans `main()` de `runner.js` : `--submit` SANS autre flag de run (`--provider=`, `--preset=`, argument positionnel tier) → action autonome + exit. Avec flags de run → sens historique (confirmation post-run).

**Pour modifier :**
1. **Changer le nombre d'entrées affichées** : `cliHelp.printActiveImprovements(5, ...)` dans `runner.js` (fin de run).
2. **Changer la résolution du carnet** : `findLedgerByName()` dans `submit-action.js` (insensible casse/espaces, repli non ambigu par sous-chaîne).
3. **Désactiver l'action autonome** : retirer le bloc `if (rawCli.includes('--submit') && !hasRunIntent)` dans `main()` de `runner.js` — `--submit` redevient purement post-run.
4. **Revenir à l'ancien updateTiers() (destructeur)** : remplacer le bloc `suffix` dans `updateTiers()` de `auto-updater.js` par l'ancien `basePrompt.slice(0, idx)` — les énoncés custom seront de nouveau effacés à chaque run.
5. **Ajouter un énoncé custom** : l'ajouter APRÈS le dernier exercice algo de la banque dans le `prompt` du tier JSON — il sera préservé par le suffixe. Vérifier avec `node -e "const j=require('./tiers/tierX.json'); j.tasks.forEach(t=>{if(!j.prompt.includes(t.id))console.log('MANQUANT: '+t.id)})"` après un run.
6. **Tester** : `node runner.js --submit` (non-TTY : dernier carnet modifié), `node runner.js --submit --model=<nom>`, `node runner.js --submit --model=inconnu` (rejet propre).

**Pièges :**
- `--submit` combiné à des flags de run (`all --provider=X --submit`) reste une CONFIRMATION post-run — ne pas retirer le test `hasRunIntent`.
- Le carnet le plus récent de `.carnet/` peut être un utilitaire sans `ecoles` (`classement_snapshot.json`) — le filtrage par `ecoles` est obligatoire.
- **updateTiers() réécrit les fichiers tiers à chaque run** : le suffixe après le bloc algo est désormais préservé, mais tout énoncé placé à un autre endroit non conventionnel pourrait être réorganisé. Après ajout d'énoncé, relancer un dry-run puis le scan des manquants.
- Le professeur IA donne des diagnostics FAUX quand l'énoncé manque (blâme l'élève pour un exercice infaisable) — toujours vérifier l'énoncé AVANT de lire sa correction.

### Modèles cloud FRONTIER classés à tort dans les modèles locaux (tâche 2026-08-31e)

**Fichiers touchés :** `leaderboard.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Un modèle cloud testé via `frontier-batch.js` avec un provider local (`ollama`, `custom`...) se retrouvait dans la section « 🏠 MODÈLES LOCAUX · LM Studio » du classement CLI. Exemple : `kimi-k2.7-code` (Ollama cloud, profil FRONTIER, école Post-Doctorat) classé 1er des locaux. Cause : dans `aggregateLedger()`, `isCloud` ne se fiait QU'À `LOCAL_PROVIDERS` quand le carnet a un `provider` — or `ollama` y figure (serveurs locaux) → un Ollama distant était classé local, en ignorant le signal FRONTIER.

**Changement :** Le signal FRONTIER (école `Post-Doctorat`) et `detectIsCloudFromLedger` (slug `:free`, tentative FRONTIER) priment désormais sur la classification par provider. Un modèle testé en FRONTIER est TOUJOURS cloud, quel que soit son provider.

**Pour modifier :**
1. **Revenir à la classification par provider seul** : remplacer le bloc `isCloud` dans `aggregateLedger()` (`leaderboard.js`) par l'ancien `ledger.provider ? !LOCAL_PROVIDERS.has(...) : (...)`.
2. **Tester** : `node leaderboard.js` — un modèle cloud FRONTIER avec provider `ollama`/`custom` doit apparaître dans la section cloud, jamais dans les locaux.

**Pièges :**
- Un modèle Ollama **local** testé en LIGHT/STANDARD (jamais FRONTIER) reste correctement classé local : le signal FRONTIER est absent.
- Le fix est rétroactif : les carnets existants (avec ou sans `provider`) sont reclassés au prochain `node leaderboard.js`.
- `LOCAL_PROVIDERS` (`local`, `lmstudio`, `ollama`, `custom`) sert à distinguer les serveurs OpenAI-compat locaux des API distantes — mais un provider local peut être utilisé en mode cloud (Ollama distant). Le signal FRONTIER est le seul discriminant fiable.

### Suffixe -cloud (Ollama Cloud) + colonne Orig. dans le MD + message suppression E507 (tâche 2026-09-11b)

**Fichiers touchés :** `leaderboard.js`, `consolidate-leaderboard.js`, `lm-studio-client.js`, `cloud-client.js`, `runner.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Suite au signalement `gemma4:31b-cloud` (Ollama Cloud, daemon local proxyant ollama.com) : (1) nouveau signal fort de détection cloud — suffixe `-cloud`/`:cloud` dans `model` OU `displayName`, indépendant de l'école FRONTIER (un modèle Ollama cloud testé hors FRONTIER ne sera plus jamais classé local) ; (2) colonne `Orig.` (☁️/🏠) ajoutée au `classement.md` + ligne `**Origine :**` dans le détail par modèle ; (3) le diagnostic E507 (échec de chargement LM Studio) conseille explicitement la SUPPRESSION du modèle (« vous pouvez le supprimer de LM Studio (UI → poubelle) »).

**Audit effectué :** les 33 carnets croisés avec `lms ls` : 13 locaux (tous GGUF LM Studio légitimes), 20 cloud (toutes API distantes). `gemma4:31b-cloud` était déjà correctement classé cloud via le signal FRONTIER ; le suffixe `-cloud` est une ceinture de sécurité pour les futurs carnets sans FRONTIER.

**Pour modifier :**
1. **Changer le regex du suffixe cloud** : éditer `detectIsCloudFromLedger` (`leaderboard.js`) et `detectIsCloudFromCarnet` (`consolidate-leaderboard.js`) — les deux doivent rester synchronisés.
2. **Retirer la colonne Orig. du MD** : éditer `buildLeaderboardMarkdown` dans `leaderboard.js` (header + cellule `origTag`).
3. **Retirer le message de suppression E507** : éditer `friendlyReason` dans `lm-studio-client.js`/`cloud-client.js` + la ligne « vous pouvez le SUPPRIMER » du pre-flight dans `runner.js`.
4. **Tester** : `node leaderboard.js` puis vérifier `Export-Rapports/classement.md` (colonne Orig., section détail) + `node scripts/check-inline-js.js`.

**Pièges :**
- Le classement HTML interactif mélange par design local+cloud dans un rang global (badge ☁️/🏠 sur chaque carte + filtre Origine) — ce n'est PAS un bug. Le CLI sépare en sections ; le MD a maintenant la colonne `Orig.`
- Un carnet Ollama **local légitime** (GGUF téléchargé dans LM Studio) sans suffixe `-cloud` reste classé local : seul le suffixe (ou FRONTIER/`:free`) bascule en cloud.
- Le `displayName` est éditable via la modale (`/api/model-displayname`) : la détection teste le displayName AUSSI — un utilisateur qui renomme « gemma4 » en « gemma4:31b-cloud » bascule le modèle en cloud. C'est voulu (le nom reflète la réalité du modèle).

### Kilo :free route vers OpenRouter upstream + retry 429 + message « kilo local » (tâche 2026-09-03)

**Fichiers touchés :** `cloud-client.js`, `frontier-batch.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Le soupçon utilisateur est CONFIRMÉ par les logs : les modèles `:free` de Kilo Gateway routent vers les pools OpenRouter upstream (mêmes slugs, mêmes rate-limits partagés ~60 req/min). Preuve dans `benchgo_2026-09-03T12-14-28.log` : le 429 renvoyé par `api.kilo.ai` dit « High demand for minimax/minimax-m3:free **on OpenRouter** - limited to 60 requests per minute ». Trois corrections :

1. **Retry HTTP 429** : `queryLLM` retente désormais un 429 jusqu'à 3 fois avec backoff linéaire (5 s, 10 s, 15 s). Avant, un 429 transitoire (~300 ms après le début de l'appel) tuait le tier obligatoire → rattrapage → élimination, alors que le Tier 0 venait de passer 10/10. Après épuisement : comportement historique (E504).
2. **Message « Pour kilo en local : laissez vide » était FAUX** : Kilo n'a pas de mode local (contrairement à ollama/lmstudio). Prompt de clé API de `frontier-batch.js` avec branche dédiée kilo : agrégateur cloud, anonyme = 200 req/h/IP + rate-limits upstream, clé recommandée (https://app.kilo.ai).
3. **Avertissement anonyme clarifié** (cloud-client.js) : précise le routage upstream et le risque 429 ; affiché UNE fois par session (`_anonWarned`) au lieu de chaque requête.

**Pour modifier :**
1. **Changer le nombre/délai de retries 429** : éditer `MAX_RATE_LIMIT_RETRIES` et `RATE_LIMIT_DELAY_MS` (cloud-client.js, const en haut de queryLLM).
2. **Désactiver le retry 429** : mettre `MAX_RATE_LIMIT_RETRIES = 0` — retour au comportement historique (429 = échec immédiat).
3. **Revenir au message générique de clé API kilo** : retirer la branche `if (provider === 'kilo')` dans `promptApiKey()` de `frontier-batch.js`.
4. **Changer l'avertissement anonyme** : éditer le bloc `_anonWarned` dans `queryLLM` (cloud-client.js).
5. **Tester** : `node --check cloud-client.js` ; mock fetch 429 puis 200 → vérifier les logs `[429] Rate limit upstream — nouvelle tentative N/3 dans Xs...`.

**Pièges :**
- Le retry 429 s'applique à TOUS les providers cloud (openai, groq, mistral...) — un 429 est toujours transitoire par définition.
- Les `:free` de Kilo partagent les pools OpenRouter : si un slug échoue en 429 sur OpenRouter, il échouera pareillement via Kilo. Changer de gateway ne contourne PAS le rate-limit upstream.
- Le compteur de retry traverse les récursions via le paramètre privé `_rateLimitRetries` — ne pas le supprimer en refactorant la signature de `queryLLM`.
- Un 429 peut aussi arriver en chunk SSE noyé dans un HTTP 200 (`chunk.error`) → géré par `isEmptyResponse` (pas par le retry 429, le statut HTTP est 200).
- L'accès anonyme kilo (200 req/h/IP) + FRONTIER complet (~60+ requêtes) : la clé reste quasi indispensable même avec le retry.

### RunCode — Examen Pur Code Natif (`--exam-code`) (tâche 2026-09-07)

**Fichiers touchés :** `runner.js`, `adaptive-exam.js`, `teacher-client.js`, `.teacher-vault/vault_polyglot.json`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Mode d'évaluation alternatif au benchmark standard, nommé **RunCode** dans l'UI. Un « Professeur Maître Absolu » (modèle cloud) fait passer un examen de débugging code natif (zéro JSON, zéro sandbox VM) à l'élève. L'examen suit un parcours scolaire (CP → CE1 → CE2 → CM1 → CM2 → COLLEGE) avec tirage aléatoire d'exercices par langage. La **règle d'or** : si un modèle se déclare « expert » dans un langage mais échoue à un exercice de niveau CP/CE1 dans ce langage, il est **expulsé immédiatement** (carton rouge).

**Architecture :**
- `.teacher-vault/vault_polyglot.json` : coffre-fort secret (`.gitignore`) contenant les exercices validés (source officielle + code snippet + regex de validation). 13 langages, 6 classes, 16 exercices.
- `teacher-client.js` : adaptateur multi-provider (Groq, OpenAI, Anthropic, Mistral, Ollama, LM Studio) pour le professeur. Supporte OpenAI-compat + Anthropic Messages API natif.
- `adaptive-exam.js` : moteur d'examen. `runAdaptiveSchoolExam(studentModelName, studentClient, options)` → entretien de vérité (déclaration compétences) → tirage aléatoire → validation regex stricte → log détaillé dans `Export-Rapports/exam_*.log`.
- `runner.js` : flag `--exam-code` déclenche l'examen après résolution du provider/modèle (questionnaire interactif ou CLI).

**Intégration dans runner.js (critical) :**
- Le bloc `--exam-code` est placé **après** `updateTiers()`, une fois `queryFn`, `providerConfig` et `teacherConfigResolved` résolus.
- Un **adaptateur** `studentClient` (objet avec méthode `.generate(model, prompt, opts)`) wrap `queryFn` (signature runner : `queryFn(prompt, difficulty, tierId, isMandatory, spinner, options)`). L'adaptateur extrait `maxTokens` et `temperature` d'`opts` et les passe à `queryFn` via `options.maxTokens` / `options.temperature`.
- En TTY : `node runner.js --exam-code` seul → questionnaire interactif → choix provider/modèle → examen.
- En non-TTY (batch/CI) : `node runner.js --provider=X --model=Y --exam-code`.

**Pour modifier :**
1. **Ajouter un exercice** : éditer `.teacher-vault/vault_polyglot.json` → ajouter une entrée dans `catalog[langage][classe]` avec `id`, `title`, `official_source`, `code_snippet`, `prompt`, `expected_regex`, `max_tokens`. Valider : `node -e "JSON.parse(require('fs').readFileSync('.teacher-vault/vault_polyglot.json','utf8'))"`.
2. **Ajouter un langage** : ajouter une clé dans `catalog` + ajouter le langage à la liste `knownTechs` dans `parseStudentDeclaration()` (`adaptive-exam.js`).
3. **Changer le provider du professeur** : `--teacher-provider=groq --teacher-model=llama-3.3-70b-versatile --teacher-api-key=...` (ou via le questionnaire interactif).
4. **Changer la règle du carton rouge** : éditer la condition `if (['CP', 'CE1'].includes(gradeClass) && ...)` dans `runAdaptiveSchoolExam()` (`adaptive-exam.js`).
5. **Tester** : `node runner.js --provider=openrouter --model=<slug:free> --exam-code` (daemon réseau requis). Valider le JSON du vault avant.

**Pièges :**
- `adaptive-exam.js` appelle `studentClient.generate(model, prompt, opts)` — l'adaptateur dans `runner.js` traduit vers `queryFn(prompt, 'EASY', -1, true, spinner, { maxTokens, temperature, contextLimitTokens, providerConfig })`. Ne pas appeler `queryFn` directement dans `adaptive-exam.js`.
- Les regex du vault sont en **chaînes JSON doublement échappées** : `\\s` dans le JSON = `\s` dans la regex. Une erreur d'escaping (`\]` au lieu de `]`) casse `JSON.parse` → l'examen entier échoue. Valider systématiquement avec `JSON.parse` + `new RegExp`.
- Le professeur (`teacher-client.js`) est indépendant du runner : il fait ses propres appels `fetch` directement (pas via `queryFn`). C'est voulu — le professeur doit être cognitivement supérieur à l'élève.
- `.teacher-vault/` est dans `.gitignore` — les corrigés ne sont JAMAIS versionnés. Si le fichier est absent, `loadSecretVault()` lève une erreur `[SÉCURITÉ] Coffre-fort introuvable`.
- Les modèles « thinking » (Nemotron, etc.) renvoient souvent leur raisonnement au lieu du code pur → échec légitime (le prompt demande « UNIQUEMENT la ligne corrigée »). Ce n'est pas un bug de l'évaluateur.
- `--exam-code` court-circuite avant le benchmark standard (`process.exit(0)` après l'examen). Aucun carnet n'est créé, aucun rapport V3 n'est généré — c'est un mode d'évaluation séparé.

### Faux rejet des modèles thinking au test de capacité (tâche 2026-09-07b)

**Fichiers touchés :** `capability-check.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Le test de capacité (`runCapabilityCheck`) demande au modèle « Es-tu capable ? Réponds UNIQUEMENT par OUI ou NON » avec `maxTokens = 512`. Les **modèles de raisonnement** (thinking : Grug 12B, DeepSeek R1, Qwen QwQ) délibèrent en streaming avant de produire la réponse finale. Avec 512 tokens, le budget est **entièrement consommé par la phase de raisonnement** (`delta.reasoning_content` / `delta.reasoning`) avant que le modèle n'ait pu écrire « OUI » ou « NON ».

Le client LM Studio (`lm-studio-client.js`, `res.on('end')` ligne 224-225) détecte alors `fullContent` vide mais `reasoningContent` non vide → **injecte la trace de raisonnement dans `content`**. `interpretCapabilityAnswer` scannait **toute la trace** à la recherche de patterns de négation → une négation contextuelle au milieu de la délibération (« je ne suis pas sûr », « not able to determine », « no clear answer ») était interprétée comme un verdict NON définitif → **modèle recalé à tort**.

Cas réel : `kai-os_grug-12b@q6_k_l` (excellent modèle local, famille KaiOS/Grug) a été recalé en déclarant « NON » alors qu'il n'avait fait que commencer à délibérer (`* Role: ... * Context: ... * Task: Wr`). Le `30.0s` affiché n'était PAS un timeout : le timer d'inactivité (reset à chaque chunk) n'a jamais fuié — le modèle a produit 512 tokens de raisonnement en 30 s puis le stream s'est arrêté (max_tokens atteint), `res.on('end')` a résolu avec la trace partielle, et le parser a vu une négation dans la délibération.

**Fix (parser seul, sans toucher à maxTokens) :** `interpretCapabilityAnswer` n'examine plus toute la réponse mais **isole la réponse finale** avant d'appliquer les patterns :
1. **Strip d'un bloc de raisonnement fermé** : si un bloc ```...``` (DeepSeek R1 / Qwen QwQ style) est présent, on garde uniquement ce qui suit la **dernière** balise fermante. Les modèles qui balisent leur raisonnement voient leur trace ignorée.
2. **Trace multi-lignes sans balise** : si le texte restant est long (> 150 chars) et multi-lignes (délibération structurée en puces `* Role/Context/Task`, ou long paragraphe), on ne garde que la **dernière ligne non vide** comme réponse finale. Une trace coupée par max_tokens n'a pas de verdict final sur sa dernière ligne → aucun pattern ne matche → verdict **INDETERMINE** → **OUI par défaut** (prudence) → le modèle passe l'examen réel qui le jugera sur preuve.
3. Les patterns NON/OUI/peut-être sont ensuite appliqués **uniquement sur la réponse finale isolée**, pas sur toute la trace.

Les modèles non-thinking (qui répondent en 1 ligne « OUI »/« Non. ») sont **inchangés** : réponse courte sans `\n` → `answerText` reste la réponse entière → patterns appliqués comme avant.

**Pour modifier :**
1. **Changer le seuil de détection de trace multi-lignes** : éditer `150` (longueur) dans `interpretCapabilityAnswer()` (`capability-check.js`) — en dessous, on considère que la réponse est une vraie réponse (pas une trace).
2. **Garder toute la trace au lieu de la dernière ligne** : retirer le bloc `if (answerText.length > 150 && answerText.includes('\n'))` (retour au bug : scanner toute la délibération).
3. **Désactiver le strip de bloc ```** : retirer le bloc `const thinkClose = answerText.lastIndexOf(...)` (les modèles qui balisent verront leur trace scannée).
4. **Augmenter le budget de tokens (optionnel, NON appliqué par défaut)** : passer `CAPABILITY_MAX_TOKENS` de 512 à 1024 ou 2048 dans `capability-check.js` pour que les thinking models finissent leur délibération et produisent un vrai verdict. Inconvénient : le check de capacité passe à 2-4 min sur les modèles thinking lents. Le fix du parser rend ceci **non nécessaire** : une trace coupée reste INDÉTERMINE → OUI par défaut.
5. **Tester** : `node -e "const {interpretCapabilityAnswer}=require('./capability-check'); const t='*   Role: Language model candidate for a serious exam by BenchGo V3.\n*   Context: High-stakes academic setting (Primary to Post-Doc), points system, health buffer, global ranking.\n*   Task: Wr'; console.log(interpretCapabilityAnswer(t))"` → doit afficher `null` (INDETERMINE → OUI par défaut). Puis `node -e "console.log(require('./capability-check').interpretCapabilityAnswer('Non, je ne peux pas.'))"` → `NO`. Et `node -e "console.log(require('./capability-check').interpretCapabilityAnswer('OUI'))"` → `YES`.

**Pièges :**
- Le timer d'inactivité du client LM Studio (30 s) est **reset à chaque chunk reçu** (`resetInactivityTimer()` dans `res.on('data')`) : un modèle qui streame activement ne sera JAMAIS tué par ce timer, même après 5 min de streaming. L'augmenter à 60 s ne sert à **rien** tant que `maxTokens` plafonne la génération.
- Le `30.0s` affiché par le spinner du test de capacité n'est PAS le timeout d'inactivité : c'est le temps réel mis par le modèle pour produire ses 512 tokens. Le spinner du runner (`capSpinner`) affiche « 0 tokens » parce que `runCapabilityCheck` utilise un `noopSpinner` interne qui ne remonte pas les tokens au spinner externe — c'est un artefact d'affichage, pas un signe de réponse vide.
- Une trace de raisonnement coupée par max_tokens n'a **pas** de verdict final : sa dernière ligne est un fragment de phrase (`Task: Wr`), pas « Non ». Le parser retourne `null` → OUI par défaut. C'est voulu : un modèle coupé en pleine délibération n'a pas dit NON, il n'a pas fini de penser.
- Si un modèle thinking répond réellement NON (il a fini de raisonner ET écrit « Non, je ne suis pas capable » sur sa dernière ligne), le parser le détecte correctement : la dernière ligne est une vraie négation → NO → recalé légitime. Le fix ne **sauve** que les modèles coupés en pleine délibération, pas ceux qui concluent vraiment par NON.
- Les patterns NON restent testés en **priorité** sur la réponse finale isolée : « Oui mais non » (rare) sur la dernière ligne → NO (prudence conservée).
- `CAPABILITY_MAX_TOKENS = 512` est conservé : le fix du parser rend l'augmentation inutile. Si tu monttes à 2048, vérifie que le pire cas (~2-4 min) reste acceptable pour un mode nuit batch (il l'est, mais ça rallonge le délai avant le 1er exercice de chaque modèle thinking).

### Profil auto FRONTIER pour modèles locaux + restauration teacher-client + import fs (tâche 2026-09-07e)

**Fichiers touchés :** `runner.js`, `teacher-client.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois bugs distincts apparus avec l'intégration de l'RunCode (`--exam-code`, tâche 2026-09-07) :

1. **Mode auto → FRONTIER pour modèle local** : `runner.js` choisissait `FRONTIER` (Post-Doctorat) par défaut pour TOUT provider passé en CLI (`isCloudMode = Boolean(resolvedProvider)` est vrai même pour `lmstudio`/`ollama`/`custom`). Un modèle LM Studio de 12B lancé via `--provider=lmstudio --model=...` (sans `--profile=`) se retrouvait en Post-Doctorat — le niveau le plus dur, conçu pour les modèles cloud frontier. Maintenant les providers locaux détectent le profil depuis le nom du modèle (`12b` → STANDARD, `2.6b` → LIGHT) avec repli STANDARD. FRONTIER reste le défaut des providers cloud distants.

2. **`teacher-client.js` réécrit → `askTeacherToCorrectStudentAnalysis` perdue** : la classe `TeacherClient` (RunCode) a remplacé l'ancien module qui exportait les fonctions du Free Router. `runner.js` importait `askTeacherToCorrectStudentAnalysis` → `undefined` → `TypeError` avalée par try/catch → le professeur de benchmark ne corrigeait plus l'analyse de l'élève, silencieusement. Le fichier est désormais **fusionné** : ancien module (Free Router) + classe `TeacherClient`, les deux exports coexistent.

3. **`fs` non importé** : le diff de l'examen a supprimé `const fs = require('fs')` sans le réimporter. `fs.mkdirSync`/`fs.writeFileSync` (sauvegarde du rapport) levaient `ReferenceError`. La session 2026-09-07d avait corrigé `path` mais oublié `fs` (supprimé dans le même diff).

**Fonctions :**
- `defaultProfileForCloud(provider, modelName)` (dans `main()` de `runner.js`) → pour `LOCAL_CLOUD_PROVIDERS` (lmstudio/ollama/custom) : `detectProfileFromModelName(modelName).detected || 'STANDARD'` ; sinon `'FRONTIER'`. Utilisée à la place de l'ancien `isCloudMode ? 'FRONTIER' : 'STANDARD'`.
- `LOCAL_CLOUD_PROVIDERS` (const dans `main()` de `runner.js`) → `new Set(['lmstudio', 'ollama', 'custom'])`.

**Pour modifier :**
1. **Changer la liste des providers locaux** : éditer `LOCAL_CLOUD_PROVIDERS` dans `main()` de `runner.js`. Ajouter un provider ici → il hérite de la détection auto (pas FRONTIER par défaut).
2. **Changer le repli local** : éditer `defaultProfileForCloud()` → remplacer le `'STANDARD'` de repli par un autre profil.
3. **Revenir au comportement historique (FRONTIER pour tout provider)** : remplacer l'appel `defaultProfileForCloud(resolvedProvider, resolvedCloudModel)` par `'FRONTIER'` dans `runner.js`.
4. **Désactiver la correction professeur du benchmark** : commenter l'appel `askTeacherToCorrectStudentAnalysis` dans `runner.js` (≈ ligne 764) — repli sur auto-analyse classique.
5. **Tester** : `node -e "const {detectProfileFromModelName}=require('./config'); console.log(detectProfileFromModelName('kai-os_grug-12b@q6_k_l'))"` → `{ paramSize: 12, detected: 'STANDARD' }`. Puis `node -e "const t=require('./teacher-client'); console.log(typeof t.askTeacherToCorrectStudentAnalysis, typeof t.TeacherClient)"` → `function function`.

**Pièges :**
- `isCloudMode = Boolean(resolvedProvider)` reste vrai pour les providers locaux : `lmstudio` via `--provider=` utilise le client cloud (OpenAI-compat sur localhost:1234), pas le client `lm-studio-client.js` local natif. La distinction local/cloud se fait désormais au niveau du **choix du profil**, pas du mode.
- Le **questionnaire interactif** (`startup-questionnaire.js`) gère déjà correctement les providers locaux (`isLocal` → profil défaut STANDARD). Le bug ne concernait que le **mode CLI direct** (`--provider=lmstudio --model=...` sans `--profile=`).
- `teacher-client.js` fusionne deux paradigmes distincts : (1) Free Router OpenRouter avec rotation de modèles gratuits (benchmark), (2) classe `TeacherClient` avec un provider/modèle fixe (RunCode). Les deux coexistent — ne pas supprimer l'un pour l'autre.
- Le professeur de l'RunCode (`TeacherClient`) fait ses **propres** appels `fetch` (pas via `queryFn`) : il doit rester cognitivement supérieur à l'élève. C'est voulu.
- La commande `--exam-code` court-circuite le benchmark standard (`process.exit(0)`). Aucun carnet, aucun rapport V3 — c'est un mode d'évaluation séparé.

### RunCode interactif + faux échec thinking + questionnaire numéroté + déchargement auto (tâche 2026-09-09)

**Fichiers touchés :** `config.js`, `startup-questionnaire.js`, `adaptive-exam.js`, `runner.js`, `teacher-client.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Six corrections sur le mode RunCode (`--exam-code`) et le questionnaire de démarrage :

1. **Questionnaire numéroté** : fournisseur, modèle et profil se choisissent par NUMÉRO au lieu d'être retapés à la main. Nouveau helper `_askNumberedChoice()` (`startup-questionnaire.js`) — le nom exact reste accepté en repli (rétrocompatibilité).
2. **Liste des modèles LM Studio** : `fetchAllModelsFromLMStudio()` (`config.js`, endpoint `/api/v0/models`) liste TOUS les modèles avec état (`loaded`/`not-loaded`). Le questionnaire affiche un menu numéroté avec badges (`chargé · Q5_K_M · gemma4 · bartowski`) ; le défaut est le premier modèle **chargé**. Plus jamais `data.data[0]` imposé silencieusement. Ollama aussi (via `/api/tags`).
3. **Clé professeur : double affichage corrigé** — `_ensureApiKey()` (`startup-questionnaire.js`) n'affichait qu'une seule fois la ligne « déjà mémorisée » (le double `console.log` — un dans le bloc TTY, un inconditionnel après — est supprimé).
4. **Examen interactif** : chaque question de l'examen démarre/arrête un Spinner (`runner.js` adaptateur `studentClient.generate`) avec un label d'étape (`Classe CP — l'élève corrige le bug…`). Le raisonnement et la réponse de l'élève sont streamés en DIRECT (💭 tokens/s, ✍ texte). Le professeur affiche sa question (`📝 [PROFESSEUR] « … »`) + le code à corriger AVANT l'appel élève, puis le verdict APRÈS. Progression `📚 [CLASSE CP] (1/6)`. Plus d'écran figé.
5. **Faux échec des modèles thinking** : les budgets `max_tokens` du coffre-fort (25-50 tokens) étaient entièrement consommés par la phase de délibération (`delta.reasoning_content`) → le client LLM injectait la trace tronquée dans `content` → la regex échouait sur un fragment de phrase (`*   Context: LLM candidate…`). Fix : `adaptive-exam.js` fait une **tentative 2** avec un budget de réflexion étendu (512 tokens) + instruction renforcée quand la réponse ressemble à une trace (`looksLikeReasoningTrace()`). `parseStudentDeclaration()` priorise la dernière ligne non vide et matche les langages par mot entier (`\bgo\b`). L'entretien passe à 512 tokens (au lieu de 30).
6. **Déchargement automatique** : `runner.js` décharge le modèle local dans le `finally` de l'examen — `lms unload --all` pour LM Studio, `ollama stop <modèle>` pour Ollama (silencieux si le daemon est injoignable). Cloud/custom : rien à décharger. Le modèle ne reste plus en VRAM après l'examen.

**Fonctions :**
- `fetchAllModelsFromLMStudio()` (dans `config.js`) → `[{name, quantization, arch, publisher, state}]` ou `[]`. Endpoint `/api/v0/models`. Exportée.
- `_askNumberedChoice(question, entries, defaultIndex)` (dans `startup-questionnaire.js`) → lit un numéro (Entrée = défaut) ou le nom exact en repli. Affiche la liste numérotée côté appelant.
- `_fetchOllamaModels()` (dans `startup-questionnaire.js`) → `[{name, …}]` via `/api/tags`.
- `looksLikeReasoningTrace(text)` (dans `adaptive-exam.js`) → `true` si la réponse est une trace de délibération tronquée (marqueurs `Role:`/`Context:`/`Task:`, délibération multi-lignes > 250 chars, réponse vide). Déclenche la tentative 2.
- `parseStudentDeclaration(rawText)` (dans `adaptive-exam.js`, réécrite) → priorise la dernière ligne non vide, matche `\bgo\b` au lieu de `includes('go')`.
- `studentClient.generate()` adaptateur (dans `runner.js`) → cycle Spinner `start()` → `queryFn` (streaming live) → `stop('Réponse reçue')` / `fail()`. Reset `tokenCount`/`charCount` par appel.

**Pour modifier :**
1. **Changer le budget de réflexion étendu** : éditer `EXTENDED_THINKING_BUDGET` (`adaptive-exam.js`, 512 par défaut).
2. **Changer les marqueurs de trace de délibération** : éditer `looksLikeReasoningTrace()` (`adaptive-exam.js`).
3. **Désactiver la tentative 2** : commenter le bloc `if (!isSuccess && looksLikeReasoningTrace(raw))` (`adaptive-exam.js`) — retour au faux échec sur les modèles thinking.
4. **Désactiver le déchargement auto** : commenter le bloc `if (prov === 'lmstudio')` / `else if (prov === 'ollama')` dans le `finally` de `runner.js` (bloc `--exam-code`).
5. **Changer le menu fournisseur/modèle/profil** : éditer `providerEntries` / les sections 2/5 dans `startup-questionnaire.js`.
6. **Revenir au questionnaire textuel (sans numéros)** : remplacer `_askNumberedChoice` par `_askChoice` dans les sections 1/2/5 (`startup-questionnaire.js`).
7. **Tester** : `node runner.js --exam-code` (LM Studio requis) ou `node -e "const m=require('./adaptive-exam'); console.log(m.parseStudentDeclaration('python, react, expert'), m.looksLikeReasoningTrace('* Context: test'))"`.

**Pièges :**
- `looksLikeReasoningTrace()` peut faire un faux positif sur une réponse bavarde multi-lignes (explication + code faux) → la tentative 2 s'exécute (budget plus grand, instruction renforcée) et échoue aussi → RECALÉ après 2 tentatives. Acceptable : 2 appels max par exercice.
- `\bgo\b` ne matche PAS `golang` ni `Golang`. Si un élève répond « golang » au lieu de « go », la déclaration ne le détecte pas → défaut `python`. Le prompt de déclaration liste explicitement `go`, donc le modèle répond `go`.
- Le déchargement `lms unload --all` décharge TOUS les modèles LM Studio (pas seulement celui testé). En usage interactif du runner, c'est voulu (l'utilisateur veut libérer la VRAM à la fin de l'examen). Pour un déchargement ciblé, il faudrait `lms unload <modelKey>` — mais le `modelKey` lms diffère parfois de l'id `/v1/models`.
- Le Spinner de l'examen n'utilise PAS `setWaitingMessages()` : les messages rotatifs déclenchent `\x1b[1A` (remontée d'une ligne) au premier tick, ce qui effacerait le dernier message de l'exam loggué juste avant. Sans waiting messages, le tick n'efface que la ligne courante (`\r\x1b[K`) — les logs restent visibles.
- `TeacherClient` n'est PAS appelé pendant l'examen (les questions viennent du coffre-fort statique) : `teacher.provider` sert uniquement à l'affichage `[LE PROFESSEUR (…)]`. L'ajout d'`openrouter` dans la table d'URLs est préventif (cohérence), pas fonctionnel pour l'examen actuel.

### Badge RunCode mort dans le classement communautaire + compartiments de modèles + E507 k2-horizon (tâche 2026-09-11)

**Fichiers touchés :** `consolidate-leaderboard.js`, `startup-questionnaire.js`, `night-batch.js`, `lm-studio-client.js`, `cloud-client.js`, `runner.js`, `Docs/CHANGELOG.md`, `AGENTS.md`.

**Principe :** Trois corrections distinctes :

1. **Badge ⚡ RunCode absent du classement communautaire** (visible en local mais pas en ligne). DEUX causes cumulées : (a) dans `aggregateCarnet()` de `consolidate-leaderboard.js`, le calcul RunCode était placé APRÈS le `return { ... }` — code mort, `result.runCode` jamais sérialisé ; (b) les 7 carnets contenant une école RunCode n'ont jamais été soumis (`submissions/` sans aucune école RunCode).
2. **Menu RunCode sans mémoire** : le questionnaire (section 2, providers locaux) annote chaque modèle avec un glyphe de statut (✓ testé / ~ partiel / ✘ échec / · à tester / ⊘ isolé) et une commande `list` affiche le tableau détaillé night-batch avec compartiments.
3. **k2-horizon HTTP_400 illisible** : nouveau code `E507_LM_LOAD_FAILED` dans les deux clients HTTP + pre-flight qui détecte l'échec de chargement dès le ping (break immédiat, diagnostic dédié). Cause confirmée : `general.architecture = k2-horizon` inconnue de llama.cpp (issue #28361 ouverte) — le modèle est prématuré, pas défectueux.

**Fonctions :**
- `groupModelsByStatus(listResult)` (dans `night-batch.js`, exportée) → `{ ok, error?, groups: {tested, partial, failed, never, isolated}, flat }`. Regroupe les modèles `listLlmModels()` par compartiment.
- `printModelsList` + `loadAllLedgers` (dans `night-batch.js`, désormais exportées) → réutilisables par le questionnaire.
- `_statusMapForModels(models)` (dans `startup-questionnaire.js`) → Map normalisée (sans `@quant`/`.gguf`) `modelKey` → `{ kind, badge, detail }` depuis `listLlmModels()`. Repli silencieux si lms injoignable.
- `E507_LM_LOAD_FAILED` (dans `lm-studio-client.js` + `cloud-client.js`) → HTTP 400 « Failed to load model » reconnu, message explicite (runtimes llama.cpp à jour / autre GGUF) au lieu du JSON brut.
- Pre-flight (dans `runner.js`) : flag `loadFailure` + break immédiat + section diagnostic E507 (vérifier via `lms load`, mettre LM Studio à jour, isoler via `--isoler=!<num>`).

**Pour modifier :**
1. **Changer les glyphes de statut** : éditer `STATUS_GLYPHS` dans `startup-questionnaire.js` (et `STATUS_BADGE_COLORS` si la constante devient utilisée).
2. **Changer les compartiments** : éditer `groupModelsByStatus()` dans `night-batch.js` (mapping kind → bucket).
3. **Désactiver l'annotation du menu** : commenter `const statusMap = provider === 'lmstudio' ? _statusMapForModels(models) : new Map();` dans la section 2 du questionnaire.
4. **Désactiver la commande `list`** : supprimer la boucle `while (picked === 'list' || picked === 'liste')` dans le questionnaire.
5. **Revenir au message HTTP_400 brut** : retirer `isLoadFailure`/`isLoadFail` de `lm-studio-client.js` (~ligne 275) et `cloud-client.js` (~ligne 499) + la section `loadFailure` du pre-flight dans `runner.js`.
6. **Tester** : `node -e "const nb=require('./night-batch'); const l=nb.listLlmModels(); const g=nb.groupModelsByStatus(l); console.log(g.groups.tested.length, g.groups.failed.length, g.groups.isolated.length)"`, `node consolidate-leaderboard.js` + `node scripts/check-inline-js.js`, `node runner.js all --provider=lmstudio --model=k2-horizon-7b@q4_k_m --exam-code --force` (doit afficher E507 avec diagnostic).

**Pièges :**
- `aggregateCarnet()` (consolidate) calcule désormais `rcAgg` AVANT le return : ne jamais replacer de code après un `return {...}` dans cette fonction (le bug revenait parce que l'objet résultat était un return direct).
- Le badge ⚡ du classement communautaire n'apparaît qu'après soumission du carnet (`node runner.js --submit --model=<nom>`) + régénération CI (`gh workflow run consolidate.yml`). Fix du code + soumissions manquantes = les deux nécessaires.
- Le matching statut du questionnaire est BASENAME (sans `@quant`) : deux quantifications du même modèle partagent le même statut du carnet le plus récent. Suffisant pour l'annotation (le tableau `list` affiche le détail par quantification).
- `E507` est FATAL dans le pre-flight (break sans retry) : un 400 « Failed to load model » ne guérit pas en 3 secondes. Ne PAS le confondre avec E505 (réponses vides, transitoire).
- k2-horizon : AUCUN runtime llama.cpp actuel ne charge ce GGUF (arch absente, issue #28361). Ni CPU, ni CUDA, ni Vulkan. Ne PAS réessayer sans mise à jour du support llama.cpp ; l'isolation est la bonne réponse en attendant.
- Les carnets RunCode « sans carnet » sont uniquement : throw pendant l'examen (E507 etc.), `examMax === 0` (coffre vide), Ctrl+C. Tous les carnets écrits sont cohérents (score = tiers passés).
- **Commande `list` du questionnaire** (tâche 2026-09-11b) : `_askNumberedChoice()` renvoie le DÉFAUT pour toute saisie qui ne matche ni numéro ni nom. Sans `opts.commands`, `list`/`liste` tombait sur le modèle par défaut → boucle `while (picked === 'list')` jamais atteinte → tableau jamais affiché. Les deux appels du choix du modèle passent `{ commands: ['list', 'liste'] }` ; les autres saisies inconnues (typos) tombent toujours sur le défaut. Si un jour une autre commande doit être interceptée dans un autre choix numéroté, lui passer aussi `opts.commands` — sinon elle sera avalée par le défaut.

### Commande pour RunCode (Examen Pur Code Natif) — récapitulatif

```
# Interactif (questionnaire de démarrage : choisit provider + modèle) :
node runner.js --exam-code

# CLI direct — modèle local LM Studio :
node runner.js --provider=lmstudio --model=<modèle> --exam-code

# CLI direct — modèle cloud :
node runner.js --provider=<provider> --model=<slug> --exam-code

# Parcours forcé (défaut : déduit du profil/du nom du modèle) :
node runner.js --exam-code --parcours=Universite   (Primaire | College-Lycee | Universite)

# Professeur custom pour l'examen (défaut : groq/llama-3.3-70b-versatile) :
node runner.js --provider=openrouter --model=<slug:free> --exam-code \
  --teacher-provider=groq --teacher-model=llama-3.3-70b-versatile --teacher-api-key=<clé>
```

---

### Tremplin RunCode → grande école (tâche 2026-09-11c)

**Fichiers touchés :** `adaptive-exam.js`, `runner.js`, `night-batch.js`, `leaderboard.js`, `consolidate-leaderboard.js`, `.teacher-vault/vault_polyglot.json`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/Tasks.md`.

**Principe :** RunCode Turbo est le PRÉ-EXAMEN (tremplin) de la grande école : tout modèle sans examen RunCode au carnet passe d'abord RunCode (mesure des aptitudes par langage), puis la grande école. Le tremplin est JAMAIS éliminatoire (demande utilisateur : ton doux, « recalé » pas « échec en gros », seuil souple). La grande école gagne du temps avec l'option « obli » (tiers obligatoires seuls, carnet écrit quand même).

**Fonctions :**
- `DIAG_EXERCICES_PAR_CLASSE = 2` / `DIAG_CONSECUTIVE_FAILS_TO_STOP = 2` / `DIAG_MAX_EXERCICES = 15` (adaptive-exam.js) → mode diagnostic : 2 exercices distincts par classe (tirage sans remise), arrêt après 2 échecs consécutifs (échec isolé toléré : « ℹ️ Un raté isolé — on continue »), plafond 15 exercices (~10-20 min).
- `computeSpecialtyStats(details)` : la spécialité exige ≥ 2 tentatives sur le langage (sinon « pas encore assez d'exercices »). `languageStats` enrichi avec `avgLatencyMs`.
- `runCodeBestOf(ledger)` / `runCodeGateInfo(ledger)` / `runRunCodeExam()` / `RUNCODE_GATE_DEFAULT_PCT = 40` (night-batch.js) → tremplin : lecture de la meilleure tentative RunCode, lancement de `runner.js --exam-code` AVANT la grande école (parcours = même scolarité que la 1re école : LIGHT→Primaire, STANDARD→College-Lycee, EXPERT/DOCTORAT→Universite), avertissement souple sous le seuil.
- File d'attente night-batch réordonnée : modèles AVEC tremplin d'abord (tri pct RunCode décroissant), sans pré-examen ensuite.
- `runBenchmark(modelKey, schoolCli, extraArgs, { examCodeArgs })` → lance l'examen RunCode depuis night-batch (timeout 2× TIER_TIMEOUT_MS).
- Option `obli` (choix des tiers, mode Exercice par exercice) → `tierFilter` = union des tiers OBLIGATOIRES des écoles sélectionnées ; la consolidation "all" se déclenche quand même (obligatoires couverts) → carnet écrit pour ~60-70 % du temps.
- `examResult.languageStats` (runner.js) → bilan par langage stocké dans le carnet → barres par langage dans les modales (leaderboard.js + consolidate-leaderboard.js).

**Pour modifier :**
1. **Changer le seuil du tremplin** : éditer `RUNCODE_GATE_DEFAULT_PCT` dans night-batch.js.
2. **Rendre le tremplin éliminatoire** (NON recommandé) : remplacer l'avertissement ambre du bloc `if (under)` par un `continue` dans main() de night-batch.js.
3. **Changer K (exercices par classe)** : éditer `DIAG_EXERCICES_PAR_CLASSE` dans adaptive-exam.js (2 → 1 = ancien comportement, 3 = diagnostic plus fin mais plus long).
4. **Changer la tolérance d'échecs** : éditer `DIAG_CONSECUTIVE_FAILS_TO_STOP` (2 → 1 = arrêt au 1er échec, ancien comportement).
5. **Changer le plafond** : éditer `DIAG_MAX_EXERCICES` (15).
6. **Désactiver le tremplin automatique** : commenter le bloc `if (!gateInfo.done)` dans main() de night-batch.js — RunCode ne sera plus lancé automatiquement, la grande école démarre direct.
7. **Retirer les barres par langage** : supprimer le bloc `rcLangs` dans les deux modales (leaderboard.js + consolidate-leaderboard.js, dupliqués).

**Pièges :**
- Les anciens carnets RunCode (avant 2026-09-11c) n'ont PAS de `languageStats` → 0 barre, pas de crash (rétrocompatible). Repasser RunCode pour remplir les barres.
- La spécialité d'un carnet ancien (1 exercice) reste affichée mais n'est pas fiable — la mesure fiable exige le mode diagnostic (2/classe).
- Le tremplin night-batch lance le parcours depuis la PREMIÈRE école planifiée : en mode auto-par-modèle, un modèle >3B passe Primaire puis STANDARD → le pré-examen est pris sur Primaire (LIGHT). Voulu (progression du plus simple au plus dur).
- Le tri de la file (avec tremplin d'abord) s'applique à `selected` APRÈS la sélection : les numéros affichés par `--list-only` ne correspondent plus à l'ordre de passage du batch (normal : --list-only est un tri par score d'école).
- `obli` ne couvre que les écoles sélectionnées avec un profil PROFILES connu (pas `auto`) : en auto, le runner devine le profil et tous les tiers tournent.
- Un modèle sous le seuil 40 % n'est PAS blacklisté ni exclu : il tourne avec un avertissement. L'auto-blacklist existant (run_ko systémique) est inchangé.

### RunCode : 3 parcours + spécialité + classement général + badge ⚡ (tâche 2026-09-10b)

**Fichiers touchés :** `.teacher-vault/vault_polyglot.json` (1.1.0), `adaptive-exam.js`, `runner.js`, `leaderboard.js`, `consolidate-leaderboard.js`, `cli-help.js`, `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/Tasks.md`.

**Principe :** Quatre extensions du RunCode : (1) 3 parcours scolaires complets (Primaire CP→CM2, Collège-Lycée 6ème→Terminale, Université Licence1→Doctorat) avec 68 exercices / 16 langages ; (2) 1 exercice ALÉATOIRE par classe tiré parmi TOUS les langages du coffre (plus la restriction majeure/mineure) ; (3) verdict final du professeur déterminant la SPÉCIALITÉ du modèle (langage d'excellence) ; (4) carnet RunCode écrit dans `.carnet` (école `RunCode-Primaire` / `RunCode-College-Lycee` / `RunCode-Universite`) → les résultats comptent pour le CLASSEMENT GÉNÉRAL, avec badge `⚡ RunCode · Turbo` sur les cartes des deux classements (local + communautaire).

**Fonctions :**
- `computeSpecialtyStats(details)` (adaptive-exam.js) → stats par langage (réussites, taux, score de spécialité = réussites×2 + volume). Spécialité = meilleur score, min. 1 tenté.
- `determineSpecialty(teacher, modelName, stats, reportCard, logFileOnly)` (adaptive-exam.js) → le professeur cloud rédige le verdict (« Spécialité : PYTHON — … »). Repli mécanique si erreur/vide. Réponse brute + erreurs tracées dans le journal.
- `agg.runCode` (leaderboard.js `aggregateLedger`) / `result.runCode` (consolidate-leaderboard.js `aggregateCarnet`) → `{ ecoles[], parcours, diplome, specialite, specialiteVerdict, pct, score, max, date }`.
- Flag `--parcours=` (runner.js) → `RunCode-Primaire` / `RunCode-College-Lycee` / `RunCode-Universite` dans le carnet.
- Badge carte : `rcBadge` dans `renderCards()` (les 2 fichiers) — bleu ciel `⚡ RunCode · Turbo`, tooltip spécialité/diplôme/pct.
- Modale : section `⚡ RunCode · Turbo` + tiers RunCode (`t.runCode` → badge ✔ Réussi / ✘ Échoué + classe + langage + id).
- Markdown : `⚡` préfixé au nom + ligne `**⚡ RunCode (turbo) :** Diplôme | Réussite | Spécialité`.

**Pour modifier :**
1. **Ajouter une classe/parcours** : éditer `classes` + `parcours` dans le vault JSON + ajouter ≥ 1 exercice pour la classe. Une classe sans exercice est SAUTÉE (trace `[pool vide]`).
2. **Ajouter un exercice** : `add(lang, classe, exo)` avec `id`, `title`, `official_source`, `code_snippet`, `prompt`, `expected_regex`, `max_tokens`. Valider : `JSON.parse` + `new RegExp` sur toutes les regex.
3. **Changer le calcul de spécialité** : éditer `computeSpecialtyStats()` (pondération `passed*2 + total`).
4. **Changer le verdict professeur** : éditer le prompt dans `determineSpecialty()` ; le repli mécanique est le bloc `if (!verdictText)`.
5. **Changer la détection RunCode (badge)** : regex `/^RunCode-/i` dans `aggregateLedger()` (leaderboard.js), `aggregateCarnet()` (consolidate-leaderboard.js).
6. **Désactiver l'écriture du carnet** : commenter le bloc `if (examMax > 0)` dans `runner.js` (bloc `--exam-code`).
7. **Tester** : `node runner.js --exam-code` (LM Studio requis), puis `node leaderboard.js` (badge visible) + `node scripts/check-inline-js.js`.

**Pièges :**
- Le carton rouge ne s'applique qu'aux 3 PREMIÈRES classes du parcours ET si l'exercice tiré est dans le langage déclaré « expert » — un expert-Python qui échoue un exercice CSS CP n'est PAS expulsé.
- Le `best` d'une entrée d'école n'est recalculé que par `saveResult` : éditer un carnet à la main sans mettre à jour `best` → le leaderboard lit `best` (champs périmés).
- Le pourcentage RunCode = réussis / JOUÉS (l'examen s'arrête au 1er échec) : 3/4 signifie « échec en classe 4, classes suivantes non jouées ».
- Les écoles `RunCode-*` sont IGNORÉES par `ledgerSchoolKeys` (night-batch) : elles ne font pas croire à un benchmark complet (« JAMAIS TESTÉ » reste honnête pour les écoles classiques).
- Le badge ⚡ apparaît dès la 1re école RunCode (parcours partiel inclus) — le tooltip montre la spécialité réelle.
- En classe communautaire : le badge en ligne n'apparaît qu'après soumission du carnet (`node runner.js --submit`).
- Logs de diagnostic RunCode (journal `Export-Rapports/exam_*.log`) : `[déclaration brute]`, `[inventaire coffre]`, `[pool classe X]`, `[tirage classe X]`, `[réponse complète]`, `[verdict professeur brut/ERREUR]`, `[verdict mécanique (repli)]`, `[pool vide]` — NE JAMAIS les retirer (indispensables pour dépanner).

---

## Vérifications après modification

1. `node --check <fichier_modifié.js>` pour chaque fichier modifié.
2. `node tests/run-tests.js` pour les tests unitaires.
3. **Si `leaderboard.js` ou `consolidate-leaderboard.js` modifié** : `node scripts/check-inline-js.js` pour valider le JS inline généré. Ce script détecte les erreurs de syntaxe (accolade en double, apostrophe mal échappée, etc.) qui font planter tout le script côté navigateur → "Aucun modèle" affiché. Localise la ligne fautive exacte.
4. Vérifier `parseCliArgs()` expose bien les nouveaux flags : `node -e "const {parseCliArgs}=require('./config'); process.argv=['node','runner.js','--force']; console.log(parseCliArgs().force)"`.
5. Mettre à jour `Docs/CHANGELOG.md`. Ne pas committer sans demande explicite.
6. **Rapport final en format Logseq dans `Memories-BenchGo/Tasks.md`** : à CHAQUE fin de session de tâches, ajouter le bilan en bas du fichier (après le contenu existant), avec ce format EXACT :
   - **Titres Logseq SANS tiret (correction 2026-09-16, remplace la règle 2026-09-15)** : une ligne de titre Logseq ne porte JAMAIS de tiret (`-`) avant les dièses. La forme `	- ### T1 — titre` (tab + tiret + dièses) est INTERDITE : Logseq ne supporte pas un tiret collé à un titre (rendu cassé). Les formes valides sont :
     - `	## <Jour> <N> <mois> <année>` (tab + dièses, SANS tiret) pour le titre de date.
     - `		### T1 — <titre court>` (2 tabs + dièses, SANS tiret) pour le sous-titre de tâche.
     - `			- <fait>` (3 tabs + tiret + texte) pour les puces du corps (le tiret reste légitime sur les puces, jamais sur les titres).
   - Chaque fait/clé de correction en `- ...` (indentation 3 niveaux), une idée par puce, **gras** pour les causes/constats importants, `code` pour les chemins/fonctions/commandes.
   - La DERNIÈRE puce de chaque tâche porte les vérifications passées (tests, syntaxe, inline-JS...).
   - Exemple concret (référence, session 2026-09-11) : lignes 118-138 de ce même fichier `Memories-BenchGo/Tasks.md` (T1 badge RunCode, T2 compartiments, T3 k2-horizon, T4 modèles cloud). Ce format est la demande EXPLICITE de l'utilisateur : toujours y répondre ainsi à la fin des tâches, avec le résumé du raisonnement/énoncé par tâche.
   - **INTERDITS Logseq (bugs générés)** : JAMAIS d'astérisques (gras `**`) dans les titres/sous-titres (`##`/`###`) — la hiérarchie vient des dièses uniquement, les astérisques dans les titres cassent Logseq. Le gras est autorisé UNIQUEMENT dans le CORPS des puces (énoncé sous un titre). JAMAIS de markup imbriqué/mélangé (`****`, `*__*`, `__**`, `code dans gras`-imbriqué) : un seul niveau de style par fragment. JAMAIS de puce doublée (`- - `). Si le texte porte un nom de fichier, l'écrire tel quel ou en `code` inline, pas en gras+code superposés.
   - **Position de l'astérisque vs dièse (bug réel 2026-09-11)** : si jamais un astérisque apparaît sur une ligne de titre, il doit TOUJOURS être APRÈS les dièses (`### **Titre**`) et JAMAIS AVANT (`***Titre###`, `**### Titre` ou astérisques en tout début de ligne avant le dièse). Un astérisque placé avant le dièse déclenche des rendus Logseq erronés (bloc de gras englobant la hiérarchie). Règle simple : la ligne commence par le dièse (ou la puce + tab + dièse), JAMAIS par un astérisque. À vérifier systématiquement après toute écriture du fichier : scan `'^\s*\*|#\*'` et `'^\s*-?\s*#{1,6}\s*\*'` sur le fichier complet.
   - **Indentation Logseq des lignes de titre (demande utilisateur 2026-09-15)** : les 3 formes à connaître :
     - `**### texte ou titre**` =>> INTERDIT (astérisques autour de toute la ligne titre, avant le dièse).
     - `### **titre ou texte**` =>> AUTORISÉ (dièses d'abord, gras ensuite sur le seul texte).
     - `-** ### titre ou texte**` =>> INTERDIT SURTOUT avec les tirets + titre (puce + astérisques avant le dièse : rendu Logseq cassé).
      - Règle simple : une ligne de titre commence TOUJOURS par son dièse (`###`), jamais par un astérisque ni par une puce suivie d'astérisques. Pour les sous-titres de tâches dans `Memories-BenchGo/Tasks.md`, la forme valide est `		### T1 — titre` (2 tabs + dièses, SANS tiret ni astérisques — cf. correction 2026-09-16).
   - **JAMAIS de tirets collés à un astérisque (demande utilisateur 2026-09-15, valable AUSSI dans les réponses du chat)** : la forme `-**` (tiret suivi immédiatement d'astérisques) n'est pas compatible Logseq. Ne JAMAIS écrire de ligne commençant par `-**` ni coller des astérisques juste après un tiret (dans `Memories-BenchGo/Tasks.md` comme dans toute réponse affichée au chat qui pourrait être copiée dans Logseq). Le tiret de puce et le gras sont toujours séparés : puce seule pour le corps (`- texte`), dièses seuls pour les titres (`### titre`), et si du gras est nécessaire dans le corps, il commence APRÈS un espace (`- **texte**`, jamais `- **texte` collé à la puce sans espace).
   - **Réponses du chat en TEXTE NORMAL compatible Logseq (demande utilisateur 2026-09-16)** : le résumé final de session s'écrit SANS markdown de structure (pas de `##`/`###` en titres, pas de tables, pas de blocs de code). Forme attendue : un texte plat — une phrase d'introduction courte, puis une puce par fait (`- ...`) avec **gras** pour les points importants et `code` pour les chemins/fonctions/commandes, une idée par puce, la dernière puce portant les vérifications passées. Exemple : « 4 corrections pour RunCode Turbo (demandes du Tasks.md) : » suivi de puces `- **Cause** : ...`. Jamais de tiret collé à du gras (`-**`), jamais de titres `#` dans le chat.

## Outils de diagnostic (`scripts/`)

| Outil | Usage |
|---|---|
| `node scripts/check-inline-js.js [fichier.html ...]` | Valide le JS inline des HTML générés par `leaderboard.js` et `consolidate-leaderboard.js`. Sans argument : valide `Export-Rapports/classement.html` et `gh-pages-output/community-leaderboard.html`. Code sortie 0 = OK, 1 = erreurs. |
