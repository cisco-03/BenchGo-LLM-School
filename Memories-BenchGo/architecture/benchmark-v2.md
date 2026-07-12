# Architecture — BenchGo V3

## Vue d'ensemble

BenchGo V3 est un système de benchmark comportemental pour modèles LLM locaux (via LM Studio)
**et cloud** (OpenAI, Anthropic, Groq, Together, OpenRouter, Mistral). Il évalue la capacité d'un
modèle à générer du code correct à travers 7 niveaux de difficulté (Tiers 0-6).

## Schéma d'architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        runner.js                                 │
│           (Orchestrateur — routing Local / Cloud)                │
│                  + Self-Profiling & Calibration                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│  config.js  │  │tier-loader.js│  │progress-bar.js│
│             │  │              │  │              │
│ - URLs API  │  │ Charge les   │  │ UI console   │
│ - Profils   │  │ tiers JSON   │  │ ProgressBar  │
│   (LIGHT →  │  │ par profil   │  │ Spinner      │
│   FRONTIER) │  │ + fallback   │  │ letterGrade  │
│ - CLI args  │  │   chain      │  │              │
│ - Détection │  │              │  │              │
│   profil    │  │              │  │              │
│ - selfProfil│  │              │  │              │
│   ing flags │  │              │  │              │
└─────────────┘  └──────────────┘  └──────────────┘

    ┌────────────────────┬─────────────────────┐
    ▼                    ▼                     ▼
┌──────────────┐  ┌──────────────┐   ┌──────────────┐
│lm-studio-    │  │cloud-        │   │parsing-utils │
│  client.js   │  │  client.js   │   │              │
│              │  │              │   │ extractJSON  │
│ LM Studio    │  │ 6 providers  │   │ extractRegex │
│ streaming    │  │ OpenAI/Groq  │   │ stripTS()    │
│ context      │  │ Anthropic    │   │              │
│ budget       │  │ OpenRouter   │   └──────────────┘
│ response_fmt │  │ Mistral/etc. │
└──────────────┘  └──────────────┘

           ┌───────────────────────┐
           ▼                       ▼
┌──────────────┐          ┌────────────────────┐
│vm-sandbox.js │          │ self-profiling.js   │
│              │          │   (NOUVEAU 2026-07-12)│
│ buildSandbox │          │ SKILL_TASK_MAP      │
│ execCodeInVM │          │ runSelfProfiling()  │
│              │          │ filterTasksByProfile│
└──────────────┘          └────────────────────┘

           ┌───────────────────────────┐
           ▼                           ▼
┌──────────────┐              ┌────────────────┐
│task-evaluator│              │score-ledger.js  │
│              │              │  + Calibration   │
│ Orchestre les│              │ calculateCalibIdx│
│ évaluations  │              │ interpretCalib   │
└───────┬──────┘              └────────────────┘
        │
        ▼
┌──────────────────────────────┐
│    custom-evaluators.js       │
│ GeoJSON RFC7946              │
│ React Hook / Flood Fill      │
│ PowerShell / Python Limiter  │
│ Async PartialErrors/Retry/   │
│ ConcurrencyLimit             │
│ Cloudflare Middleware        │
└──────────────────────────────┘

┌────────────────────────────────────────┐
│       report-generator.js              │
│ buildTierReport()                      │
│ buildCalibrationReport() (NOUVEAU)      │
│ sanitizeFilename() / shortenModelName() │
└────────────────────────────────────────┘
```

## Modules

### config.js
- **Rôle** : Configuration centralisée
- **Contenu** : URLs API LM Studio, timeouts, définition des profils (LIGHT/STANDARD/EXPERT/DOCTORAT/FRONTIER), parsing des arguments CLI (`--profile`, `--context-limit`, `--provider`, `--model`, `--api-key`), détection automatique du profil selon la taille du modèle, CLASSE_NAMES pour l'export, **`selfProfiling`** (flags d'auto-profilage : `enabled`, `minLevelToTest`, `bypassFilter`)
- **Dépendances** : Aucune

### self-profiling.js *(nouveau 2026-07-12)*
- **Rôle** : Auto-profilage du modèle et filtrage dynamique des tâches
- **Contenu** :
  - `SKILL_TASK_MAP` — carte statique compétence → IDs de tâches (construite à partir des 18 fichiers tier)
  - `SKILL_LABELS` — libellés humains des 4 compétences (javascript_basics, javascript_async, algorithms_advanced, code_debugging)
  - `PROFILE_PROMPT` — mega-prompt d'interview (français, schéma JSON strict)
  - `runSelfProfiling(queryFn, providerConfig, contextLimitTokens)` — exécute l'interview JSON, fallback regex si le modèle ne supporte pas le JSON natif, retourne `null` en cas d'échec (graceful degradation)
  - `filterTasksByProfile(tasks, profile, minLevelToTest, bypassFilter)` — filtre les tâches d'un tier selon le profil auto-déclaré, retourne `{ kept, bypassed, decisions }`
  - `getTaskSkill(task)` — retourne la skill associée à une tâche (`javascript_basics` par défaut)
- **Dépendances** : `logger.js`, `parsing-utils.js` (`extractJSON`)

### lm-studio-client.js
- **Rôle** : Client API LM Studio (local)
- **Contenu** : `queryLLM()`, streaming SSE, estimation du budget contexte, gestion timeout/erreur, support optionnel `response_format` (JSON) via `options.responseFormat`
- **Dépendances** : `config.js`, `logger.js`

### cloud-client.js *(nouveau)*
- **Rôle** : Client API pour modèles cloud
- **Contenu** : `queryLLM()` avec même interface que lm-studio-client ; supporte OpenAI, Groq, Together, OpenRouter, Mistral (format OpenAI-compatible) et Anthropic (format natif Messages API) ; résolution de la clé API depuis env var ou `--api-key` ; support optionnel `response_format` (JSON) pour OpenAI-compat (ignoré pour Anthropic)
- **Dépendances** : `config.js`, `logger.js`

### runner.js
- **Rôle** : Orchestrateur principal
- **Contenu** : `main()`, `runTierAttempt()`, routing dual Local/Cloud (`queryFn` + `providerConfig`), rattrapage interactif (désactivé en mode cloud), export des rapports classés. **Auto-profilage** : interview du modèle au démarrage via `self-profiling.js`, filtrage amont des tâches selon le profil auto-déclaré, agrégation des résultats (status success/failed/bypassed), calcul de l'Indice de Calibration en fin de run, injection de la section rapport.
- **Dépendances** : tous les modules + `self-profiling.js`

### tier-loader.js
- **Rôle** : Chargement des fichiers tier JSON par profil
- **Contenu** : `loadTiers(profileArg)` avec chaîne de fallback `FRONTIER→DOCTORAT→EXPERT→STANDARD→LIGHT`
- **Dépendances** : `logger.js`

### progress-bar.js
- **Rôle** : Interface utilisateur console
- **Contenu** : Classes `ProgressBar` et `Spinner`, `letterGrade()`
- **Dépendances** : `config.js`

### parsing-utils.js
- **Rôle** : Parsing et nettoyage du code
- **Contenu** : `extractJSON()`, `extractCodeRegex()`, `stripTS()`
- **Dépendances** : Aucune

### vm-sandbox.js
- **Rôle** : Moteur d'exécution sécurisé
- **Contenu** : `buildSandbox()` (inclut `setTimeout`/`clearTimeout`), `execCodeInVM()` avec calcul et retour de `executionTimeMs` via `performance.now()`
- **Dépendances** : `config.js`

### custom-evaluators.js
- **Rôle** : Évaluateurs comportementaux spécialisés
- **Contenu** : 10 évaluateurs dont `evaluateAsyncConcurrencyLimit` (Tier 4), helpers `exposerFonctionVM()` et `avecTimeout()`
- **Dépendances** : `vm-sandbox.js`, `parsing-utils.js`, `config.js`

### task-evaluator.js
- **Rôle** : Moteur d'évaluation des tâches
- **Contenu** : `evaluateTask()` — dispatch vers exec/pattern/custom avec vérification optionnelle de `maxTimeMs` (limite de temps d'exécution algorithmique)
- **Dépendances** : `vm-sandbox.js`, `custom-evaluators.js`, `parsing-utils.js`

### report-generator.js
- **Rôle** : Génération des rapports Markdown
- **Contenu** : `buildTierReport()`, `sanitizeFilename()`, `shortenModelName()` (raccourcit le nom de modèle LM Studio en supprimant la répétition du nom de base, ex. `org/repo-gguf/repo-mtp-q4_k_m.gguf` → `org_repo-mtp-q4_k_m`), **`buildCalibrationReport()`** (section « Auto-Profilage & Calibration » : tableau des compétences déclarées + ratios, justification, Indice de Calibration C avec interprétation, liste des tâches bypassées)
- **Dépendances** : Aucune

### logger.js
- **Rôle** : Journalisation dans logs/
- **Dépendances** : Aucune

### score-ledger.js
- **Rôle** : Grand livre des scores persistant (cumul multi-écoles) + calcul de calibration
- **Contenu** : `loadLedger`/`saveResult`/`saveAndBuildBilan` (carnet JSON par modèle), `computeGrandTotal`, `printBilanGlobal`, `buildBilanMarkdown`, **`calculateCalibrationIndex(declaredProfile, testResults)`** (D = niveau moyen déclaré /5, P = réussite des tâches exécutées, C = 1 - |D-P|), **`interpretCalibration(C)`** (≥0.85 Lucide / 0.65-0.85 Modérément Calibré / <0.65 Biais majeur)
- **Dépendances** : `logger.js`, `progress-bar.js`

## Profils d'évaluation

| Profil   | Taille modèle | Tiers obligatoires | École          | Tiers optionnels |
|----------|--------------|-------------------|----------------|-------------------|
| LIGHT    | < 3B         | 0, 1              | Maternelle     | 2, 3, 4, 5        |
| STANDARD | 3B – 14B     | 0, 1, 2           | Collège-Lycée  | 3, 4, 5, 6        |
| EXPERT   | 14B – 30B    | 0, 1, 2, 3        | Université     | 6                 |
| DOCTORAT | > 30B        | 0, 1, 2, 3, 6     | Thèse          | -                 |
| FRONTIER | Cloud        | 0, 1, 2, 3, 4, 6  | Post-Doctorat  | -                 |

## Flux d'exécution (mode cloud)

```
node runner.js all --provider=openai --model=gpt-4o
    ↓
parseCliArgs() → isCloudMode=true, queryFn=queryLLMCloud
    ↓
profileArg = profileArgExplicit || 'FRONTIER'
    ↓
[Auto-profilage] runSelfProfiling(queryFn) → interview JSON du modèle sur 4 compétences
    ↓ (graceful : null si échec)
loadTiers('FRONTIER') → tiers 0,1,2,3,4
    ↓
pour chaque tier :
  filterTasksByProfile(tâches, selfProfile, minLevelToTest) → kept / bypassed
    ↓ (les tâches bypassées ne sont pas envoyées au modèle)
  queryLLMCloud(prompt, ..., { providerConfig: {provider, model, apiKey} })
    ↓ POST https://api.openai.com/v1/chat/completions avec streaming SSE
  evaluateTask(tache, codeEtudiant) → status: success/failed (+ bypassed pour filtrées)
    ↓
  buildTierReport() + agrégation allEvalResults/allFilterDecisions
    ↓
[Fin de run] calculateCalibrationIndex(selfProfile, allEvalResults) → C = 1 - |D-P|
    ↓
  buildCalibrationReport() → section injectée en haut du rapport
    ↓
  Export-Rapports/<date-locale>/Post-Doctorat/rapport_v3_<modeleCourt>_<profil>[_tierN]_<HH-MM-SS>.md
```

**Auto-profilage & Calibration (2026-07-12)** : si `selfProfiling.enabled=true`, le runner interroge
le modèle au démarrage pour qu'il s'auto-évalue sur 4 compétences (javascript_basics,
javascript_async, algorithms_advanced, code_debugging) avec un niveau 1-5. Les tâches dont la
compétence associée est déclarée sous `minLevelToTest` sont marquées « Bypassée (Non déclarée) »
et retirées de l'évaluation (filtrage amont). En fin de run, l'Indice de Calibration
C = 1 - |D - P| (D = capacité déclarée moyenne, P = performance réelle) est calculé et affiché
dans la console + une section dédiée du rapport Markdown. Échec non fatal (graceful degradation).


## Vue d'ensemble

BenchGo V3 est un système de benchmark comportemental pour modèles LLM locaux via LM Studio. Il évalue la capacité d'un modèle à générer du code correct à travers 7 niveaux de difficulté (Tiers 0-6).

Le dossier d'execution conserve le nom historique `benchmark-v2` pour compatibilite.

## Schéma d'architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        runner.js                                 │
│                  (Orchestrateur principal)                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│  config.js  │  │tier-loader.js│  │progress-bar.js│
│             │  │              │  │              │
│ - URLs API  │  │ Charge les   │  │ UI console   │
│ - Profils   │  │ tiers JSON   │  │ ProgressBar  │
│ - CLI args  │  │              │  │ Spinner      │
│ - Détection │  │              │  │ letterGrade  │
│   profil    │  │              │  │              │
└─────────────┘  └──────────────┘  └──────────────┘

          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────┐
│lm-studio-    │  │parsing-utils │  │task-evaluator  │
│  client.js   │  │              │  │                │
│              │  │ extractJSON  │  │ Orchestre les  │
│ queryLLM()   │  │ extractRegex │  │ évaluations    │
│ streamLLM()  │  │ stripTS()    │  │ par tâche      │
│              │  │              │  │                │
└──────────────┘  └──────────────┘  └───────┬────────┘
                                            │
                    ┌───────────────────────┼────────────────┐
                    ▼                       ▼                ▼
            ┌──────────────┐       ┌──────────────┐  ┌──────────────┐
            │vm-sandbox.js │       │custom-       │  │parsing-utils │
            │              │       │evaluators.js │  │(pour stripTS)│
            │ buildSandbox │       │              │  │              │
            │ execCodeInVM │       │ GeoJSON RFC  │  └──────────────┘
            │              │       │ React Hook   │
            └──────────────┘       │ Flood Fill   │
                                   │ PowerShell   │
                                   │ Python Limit │
                                   └──────────────┘

                    ┌────────────────────────────┐
                    │    report-generator.js     │
                    │                            │
                    │ buildTierReport()          │
                    │ sanitizeFilename()         │
                    │ shortenModelName()         │
                    └────────────────────────────┘
```

## Modules

### config.js
- **Rôle** : Configuration centralisée
- **Contenu** : URLs API LM Studio, timeouts, définition des profils (LIGHT/STANDARD/EXPERT), parsing des arguments CLI (`--profile`, `--context-limit`), détection automatique du profil selon la taille du modèle
- **Dépendances** : Aucune

### progress-bar.js
- **Rôle** : Interface utilisateur console
- **Contenu** : Classes `ProgressBar` (barre de progression avec %) et `Spinner` (indicateur de chargement avec compteur de tokens), fonction `letterGrade()` pour les notes A-F
- **Dépendances** : `config.js` (SPINNER_CHARS)

### parsing-utils.js
- **Rôle** : Parsing et nettoyage du code
- **Contenu** : `extractJSON()` extrait le premier objet JSON d'une réponse, `extractCodeRegex()` fallback regex, `stripTS()` supprime les annotations TypeScript pour l'exécution VM
- **Dépendances** : Aucune

### vm-sandbox.js
- **Rôle** : Moteur d'exécution sécurisé
- **Contenu** : `buildSandbox()` crée un contexte VM restreint (inclut `setTimeout`/`clearTimeout` référençant les timers réels de l'hôte, nécessaire aux tests async retry/backoff), `execCodeInVM()` exécute du code avec timeout et retourne le résultat d'assertion
- **Dépendances** : `config.js` (EVAL_TIMEOUT_MS)
- **Limite connue** : `execCodeInVM` est strictement SYNCHRONE — ne jamais l'utiliser pour tester du code asynchrone (une Promise retournée par `call` ne peut jamais se résoudre avant la lecture d'`assert`). Pour l'async, utiliser un évaluateur `custom` (voir `custom-evaluators.js`).

### custom-evaluators.js
- **Rôle** : Évaluateurs complexes que l'exécution VM simple ne peut pas gérer
- **Contenu** :
  - `evaluateGeoJSONRFC7946` — Vérifie conformité RFC 7946 (feature.properties.nom)
  - `evaluateReactHook` — Simule cycle de rendu React (useEffect + useState vs useRef)
  - `evaluateFloodFill` — 5 cas de test critiques (matrices non-carrées, couleur identique, inversion x/y)
  - `evaluatePowerShellRollback` — Analyse structurelle backup/restore
  - `evaluatePythonConsecutiveLimiter` — Analyse statique algorithme Python
  - `evaluateAsyncPartialErrors` *(async)* — Vérifie l'usage de Promise.allSettled + gestion d'échecs partiels
  - `evaluateAsyncSequentialProcessing` *(async)* — Détecte le bug classique `forEach` + callback async
  - `evaluateAsyncRetryLogic` *(async)* — 3 scénarios réels : succès après échecs, échec permanent, succès immédiat
  - `evaluateCloudflareMiddleware` *(async)* — Test réel (awaité) du middleware Cloudflare Worker (remplace un ancien test `exec` cassé)
  - Helpers internes : `exposerFonctionVM()` (définit le code étudiant en VM, expose la fonction pour appel/await depuis l'hôte), `avecTimeout()` (garde-fou anti-blocage), `detecterNomFonction()`
- **Dépendances** : `vm-sandbox.js`, `parsing-utils.js`, `config.js`
- **Convention** : tout évaluateur testant du code `async` DOIT être une fonction `async` utilisant `exposerFonctionVM()` + `await` — jamais `type: "exec"` pour de l'asynchrone (voir `issues-fixes/2026-07-07-test-async-middleware-toujours-echec.md`).

### task-evaluator.js
- **Rôle** : Orchestrateur d'évaluations par tâche
- **Contenu** : `evaluateTask()` (async) itère sur les évaluations d'une tâche (types: exec, pattern, custom) et `await` les évaluateurs custom asynchrones
- **Dépendances** : `parsing-utils.js`, `vm-sandbox.js`, `custom-evaluators.js`, `config.js`
- **Appelant** : `runner.js` doit faire `await evaluateTask(...)`

### lm-studio-client.js
- **Rôle** : Communication avec LM Studio
- **Contenu** : `queryLLM()` envoie les prompts et reçoit les réponses en streaming SSE, gestion des timeouts et erreurs, estimation du volume de tokens d'entrée, calcul dynamique de `max_tokens` selon la limite de contexte
- **Dépendances** : `config.js`, `logger.js`

### runner.js (orchestration)
- **Rôle** : Pilotage des tiers, scoring global et interaction utilisateur
- **Contenu** : orchestration des tentatives par tier, mode rattrapage interactif pour profils LIGHT/STANDARD (maximum 1 rattrapage), sélection du meilleur score entre tentatives. Réessai limité à 1 par exercice (`MAX_TASK_RETRIES = 1`) avec suivi via `taskRetryMap`. Système d'aide du professeur : proposition d'indice au modèle en rattrapage (`taskHelpUsed`), validation manuelle des points par l'utilisateur après échec définitif (`askYesNo`), annotations « avec aide et rattrapage » dans le scorecard CLI et le rapport Markdown.
- **Dépendances** : tous les modules coeur (`config`, `lm-studio-client`, `task-evaluator`, `report-generator`, etc.)

### tier-loader.js
- **Rôle** : Chargement des configurations de tiers
- **Contenu** : `loadTiers()` lit et parse les fichiers JSON du dossier `tiers/`
- **Dépendances** : `logger.js`

### report-generator.js
- **Rôle** : Génération de rapports Markdown
- **Contenu** : `buildTierReport()` génère le markdown par tier (avec annotations `*(avec aide)*` / `*(rattrapage)*`), `sanitizeFilename()` pour les noms de fichiers, `shortenModelName()` raccourcit le nom de modèle LM Studio (suppression de la répétition du nom de base)
- **Dépendances** : `progress-bar.js` (letterGrade)

## Flux d'exécution

1. **Initialisation** : parsing CLI → détection profil → chargement tiers
2. **Boucle par tier** :
   - Créer Spinner + ProgressBar
   - Proposition d'aide du professeur (si rattrapage) : prompt séparé `AIDE_OUI/AIDE_NON` → indice inclus si accepté
  - `queryLLM()` → réponse streaming (budget contexte appliqué)
   - `extractJSON()` → parsing primaire
   - `extractCodeRegex()` → fallback si parsing échoue
   - `evaluateTask()` pour chaque tâche du tier
   - 1er échec : pénalité + exercice conservé pour 1 réessai (`MAX_TASK_RETRIES = 1`)
   - 2ème échec : abandon de l'élève + `askYesNo` validation des points par l'utilisateur
   - Si échec du tier et profil LIGHT/STANDARD : proposition de rattrapage interactif
   - `buildTierReport()` → ajout au rapport global (avec annotations aide/rattrapage)
3. **Finalisation** : calcul scores globaux → affichage verdict → sauvegarde rapport `.md`
   dans `Export-Rapports/<AAAA-MM-JJ locale>/<PROFIL>/[<CLASSE>/]` — le nom de fichier porte
   l'heure locale `HH-MM-SS` et un nom de modèle raccourci (`shortenModelName`) ; l'en-tête
   du rapport référence le fichier de log associé.

## Dossier tiers/

Chaque fichier JSON (`tier0_easy.json` ... `tier3_expert.json`) définit :
- Un prompt système pour le LLM
- Des tâches avec ID et label
- Des évaluations par tâche (type exec/pattern/custom)

Le dossier est purement déclaratif, aucun code exécutable.

### État au 2026-07-08 (après retravail complet des tiers)

| Tier | Tâches | Évaluations | Niveau | Catégories couvertes |
|---|---|---|---|---|
| 0 (EASY) | 5 (a-e) | 16 | Très très facile | Addition, parité, inversion chaîne, max tableau, compter voyelles |
| 1 (MEDIUM) | 5 (a-e) | 16 | Un peu plus élevé | Filtrer pairs, capitaliser, supprimer doublons, débogage, fréquence caractères |
| 2 (HARD) | 5 (a-e) | 16 | Cran au-dessus | Validation parenthèses, debounce, aplatir tableau, async allSettled, débogage async |
| 3 (EXPERT) | 6 (a-f) | 15 | Le plus complexe (20-30B) | PowerShell, Flood Fill, Cloudflare, SQL, retry, prototype pollution |

Le Tier 0 a été volontairement simplifié pour permettre aux modèles standard de réussir.
Voir `CHANGELOG.md` du 2026-07-08 et `refactorisations/2026-07-08-retravail-tiers-export-rapports.md`.

### État au 2026-07-07 (avant retravail — archivé)

| Tier | Tâches | Évaluations | Catégories couvertes |
|---|---|---|---|
| 0 (EASY) | 5 (a-e) | 12 | DOM/HTML, CSS, parsing JSON, **débogage**, **sécurité anti-XSS** |
| 1 (MEDIUM) | 5 (a-e) | 17 | GeoJSON RFC 7946, TypeScript, Python, **débogage**, **sécurité anti-XSS** |
| 2 (HARD) | 5 (a-e) | 14 | React hooks, algo pile, composant React, **async avancé**, **débogage async** |
| 3 (EXPERT) | 6 (a-f) | 16 | PowerShell rollback, Flood Fill, Cloudflare middleware, **anti-injection SQL**, **async retry**, **débogage sécurité (prototype pollution)** |

Chaque tier couvre désormais systématiquement au moins une épreuve de débogage de code existant,
et la plupart couvrent aussi la sécurité applicative et/ou l'asynchrone avancé, répartis selon la
difficulté du tier (voir `CHANGELOG.md` du 2026-07-07 pour le détail des épreuves ajoutées).
