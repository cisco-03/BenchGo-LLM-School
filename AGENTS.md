# AGENTS.md — BenchGo V3

OS : Windows, PowerShell 5.1. Projet Node.js 18+ **sans `package.json`** (modules built-ins uniquement : `fs`, `path`, `child_process`, `readline`, `vm`). Pas de `npm install`.

---

## Commandes essentielles

| Usage | Commande |
|---|---|
| Benchmark interactif | `node runner.js all` |
| Mode nuit (batch) | `node night-batch.js` |
| Valider config sans exécuter | `node runner.js all --dry-run` |
| Tests unitaires | `node tests/run-tests.js` |
| Classement HTML/MD | `node leaderboard.js` |
| Serveur classement interactif | `node leaderboard.js --serve` |
| Classement communautaire en ligne (GitHub Pages) | `gh workflow run consolidate.yml -R cisco-03/BenchGo-LLM-School` puis `gh run watch -R cisco-03/BenchGo-LLM-School` |
| Aide CLI | `node runner.js --help` |
| Dernier run & état | `node runner.js status` |
| Vérifier syntaxe JS | `node --check <fichier>.js` |
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
- **`cloud-client.js`** — 6 providers cloud (OpenAI compat + Anthropic natif).
- **`lm-studio-client.js`** — client local LM Studio (streaming SSE).
- **`teacher-client.js`** — professeur IA (correction via OpenRouter Free Router).
- **`score-ledger.js`** — carnets persistants dans `Export-Rapports/.carnet/<shortName>.json`.
- **`leaderboard.js`** — génération HTML/MD, serveur web (3622 lignes, JS inline côté client).
- **`tier-loader.js`** — charge les tiers JSON avec fallback : `FRONTIER → DOCTORAT → EXPERT → STANDARD → LIGHT`.
- **`task-evaluator.js`** — moteur d'évaluation (exec/pattern/custom). Cache LRU intégré.
- **`secrets.js`** — clés API en mémoire vive (session), jamais sur disque.
- **`presets.js`** — `.presets.json` pour rejouer une config (ne stocke JAMAIS de clé API).
- **`api-keys-store.js`** — stockage persistant optionnel dans `.api-keys.json`.
- **`http-middleware.js`** — timeout + retry backoff + fallback pour appels HTTP.
- **`health-sentinels.js`** — vérifications sanitaires.
- **`hybrid-mode.js`** — auto-soumission GitHub avec file d'attente persistante, seuil à 50%.
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

### Problème Node.js 24.x
Bug undici : `TypeError: Cannot assign to read only property 'name' of object 'Error: socket idle timeout'`. Intercepté globalement dans `runner.js` (ligne 11). L'erreur est loggée, le fetch échoue proprement, le runner continue.

### Écoles séquentielles
Si modèle > 3B paramètres, le runner peut enchaîner LIGHT puis STANDARD dans le même run (même clé, auto-profilage partagé, santé réinitialisée).

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
