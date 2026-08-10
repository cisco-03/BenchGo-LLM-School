# AGENTS.md — BenchGo V3

OS : Windows, PowerShell 5.1. Projet Node.js 18+ **sans `package.json`** (modules built-ins uniquement : `fs`, `path`, `child_process`, `readline`, `vm`). Pas de `npm install`.

---

## Commandes essentielles

| Usage | Commande |
|---|---|
| Benchmark interactif | `node runner.js all` |
| Mode nuit (batch local) | `node night-batch.js` |
| Mode batch cloud (frontière) | `node frontier-batch.js` |
| Mode batch cloud (petits modèles) | `node frontier-batch.js --profile=STANDARD` (ou `LIGHT`) |
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
| Liste LM Studio triée par score local | `node night-batch.js --list-only` |
| Forcer la détection (réindexer les GGUF orphelins) | `node night-batch.js --force-detect` |
| Isoler/désisoler un modèle LM Studio | Interaction `!<num>` / `!!<num>` pendant la sélection `night-batch.js` |
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
- **`config.js`** — profils, parse CLI, timeout, auto-profilage.
- **`cloud-client.js`** — 11 providers cloud (OpenAI compat + Anthropic natif) : openrouter, openai, anthropic, groq, together, mistral, deepseek, cohere, ollama, lmstudio, custom.
- **`lm-studio-client.js`** — client local LM Studio (streaming SSE).
- **`teacher-client.js`** — professeur IA (correction via OpenRouter Free Router).
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
- **`pricing.js`** — tarification cloud estimée (tâche 2026-08-04) : fetch OpenRouter `/api/v1/models` + table fallback locale, calcule coût $/€ des modèles cloud payants d'après les tokens consommés. Cache disque 24h (`.pricing-cache.json`).
- **`consolidate-leaderboard.js`** — génère le HTML du classement communautaire. Lancé en local pour tester (`node consolidate-leaderboard.js` → `gh-pages-output/`), et en CI via GitHub Actions pour déployer sur `gh-pages`. Le workflow `consolidate.yml` lit les soumissions, régénère le HTML, commit sur `gh-pages`, GitHub Pages déploie.
- **`tiers/`** — 18 fichiers `tier{N}_{profile}.json`.

Timeouts clés (`config.js`) : `EVAL_TIMEOUT_MS` = 10s (sandbox VM), `API_TIMEOUT_MS` = 1500s (25 min), `PROFILING_TIMEOUT_MS` = 600s (10 min).

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
Si modèle > 3B paramètres, le runner peut enchaîner LIGHT puis STANDARD dans le même run (même clé, auto-profilage partagé, santé réinitialisée).

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

---

## Vérifications après modification

1. `node --check <fichier_modifié.js>` pour chaque fichier modifié.
2. `node tests/run-tests.js` pour les tests unitaires.
3. **Si `leaderboard.js` ou `consolidate-leaderboard.js` modifié** : `node scripts/check-inline-js.js` pour valider le JS inline généré. Ce script détecte les erreurs de syntaxe (accolade en double, apostrophe mal échappée, etc.) qui font planter tout le script côté navigateur → "Aucun modèle" affiché. Localise la ligne fautive exacte.
4. Vérifier `parseCliArgs()` expose bien les nouveaux flags : `node -e "const {parseCliArgs}=require('./config'); process.argv=['node','runner.js','--force']; console.log(parseCliArgs().force)"`.
5. Mettre à jour `Docs/CHANGELOG.md`. Ne pas committer sans demande explicite.

## Outils de diagnostic (`scripts/`)

| Outil | Usage |
|---|---|
| `node scripts/check-inline-js.js [fichier.html ...]` | Valide le JS inline des HTML générés par `leaderboard.js` et `consolidate-leaderboard.js`. Sans argument : valide `Export-Rapports/classement.html` et `gh-pages-output/community-leaderboard.html`. Code sortie 0 = OK, 1 = erreurs. |
