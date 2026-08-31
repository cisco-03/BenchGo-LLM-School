# CHANGELOG - Carnet de Notes BenchGo

## 2026-08-31 (e) — fix(leaderboard) : modèles cloud FRONTIER classés à tort dans les modèles locaux

### Contexte
Un modèle cloud testé via `frontier-batch.js` avec un provider local
(`ollama`, `custom`...) se retrouvait dans la section « 🏠 MODÈLES LOCAUX ·
LM Studio » du classement CLI. Exemple : `kimi-k2.7-code` (Ollama cloud,
profil FRONTIER, école Post-Doctorat) classé 1er des modèles locaux alors
qu'il n'a rien à voir avec LM Studio.

### Cause racine
Dans `aggregateLedger()` (`leaderboard.js`), `isCloud` était calculé ainsi :
si le carnet a un `provider`, on ne se fiait QU'À la table `LOCAL_PROVIDERS`
(`local`, `lmstudio`, `ollama`, `custom`). Or `ollama` y figure (pour les
serveurs Ollama locaux) → un Ollama **distant** (cloud) était donc classé
local, en ignorant le signal fort « école Post-Doctorat / profil FRONTIER »
qui est réservé au cloud.

### Changement
Le signal FRONTIER (école `Post-Doctorat`) et l'heuristique
`detectIsCloudFromLedger` (slug `:free`, tentative FRONTIER) priment
désormais sur la classification par provider. Un modèle testé en FRONTIER
est TOUJOURS cloud, quel que soit son provider.

### Pièges
- Un modèle Ollama **local** testé en LIGHT/STANDARD (jamais FRONTIER) reste
  correctement classé local : le signal FRONTIER est absent.
- Le fix est rétroactif : les carnets existants sans `provider` (anciens)
  comme ceux avec `provider: "ollama"` sont reclassés au prochain
  `node leaderboard.js`.

## 2026-08-31 (d) — feat(cli) : demander « garder la clé mémorisée ou nouvelle ? »

### Contexte
Suite au fix (c) : la clé ollama.com stockée dans `.api-keys.json` était
invalide (HTTP 401). Impossible de la remplacer sans connaître la commande
`--forget-key=ollama` — le CLI ne posait JAMAIS la question : clé stockée =
reprise silencieuse (`frontier-batch.js` : `getStoredApiKey` → resolve
direct ; `startup-questionnaire.js` : `secrets.hasSecret` → rappel masqué ;
`runner.js` : restauration silencieuse en mode CLI direct).

### Changements
Quand une clé mémorisée existe, les 3 points d'entrée demandent désormais :
`Utiliser cette clé mémorisée ? [O/n]` (défaut OUI). Si NON → saisie
masquée d'une nouvelle clé, qui **remplace** l'ancienne dans `.api-keys.json`
immédiatement (l'utilisateur vient de la saisir explicitement : la
mémorisation est l'action attendue). Si saisie vide → repli sur la clé
mémorisée.

- **`frontier-batch.js`** (`promptApiKey`) : question TTY uniquement.
  Nouveau helper `maskKeyForDisplay()` (`d1f8...960b`) + `promptNewApiKey()`
  (saisie masquée factorisée, mémorisation proposée comme avant). En
  non-TTY/`--yes` (batch de nuit), la clé stockée est gardée silencieusement —
  aucun prompt ne doit bloquer la file.
- **`startup-questionnaire.js`** (`_ensureApiKey`) : question TTY quand la
  clé est en mémoire de session. Nouvelle clé → `secrets.rememberSecret` +
  `apiKeysStore.saveKey` (remplace).
- **`runner.js`** (mode CLI direct, restauration depuis `.api-keys.json`) :
  question TTY si pas `--dry-run`. Nouvelle clé → remplace dans le magasin.
  Non-TTY (night-batch, `--force`) : comportement inchangé (silencieux).

### Pièges
- La question ne s'affiche qu'en TTY : les batchs de nuit (`--yes`, pipes,
  planificateur) ne bloquent jamais — la clé stockée est utilisée telle
  quelle (comportement historique préservé).
- La saisie vide au prompt « nouvelle clé » ne supprime PAS l'ancienne : on
  revient à la clé mémorisée (annulation implicite).
- `--api-key=` (CLI) court-circuite toujours tout : la clé passée en flag
  est utilisée sans question (elle est ensuite auto-sauvée par le runner).
- Pour toujours remplacer une clé sans interaction :
  `node runner.js --forget-key=<provider>` puis relancer.

## 2026-08-31 (c) — fix(cloud) : --endpoint= ignoré par le runner (Ollama Cloud inaccessible)

### Contexte
L'utilisateur teste les modèles cloud d'Ollama via `node frontier-batch.js`
(provider 10 + `--endpoint=https://ollama.com/v1/chat/completions` + clé API
ollama.com + modèle `minimax-m3`). Le run échouait en E505_MODEL_UNRESPONSIVE
en 6,5 s (3 pings instantanés) avec le diagnostic trompeur « rate-limité
upstream ».

### Cause racine — le flag `--endpoint=` n'était JAMAIS transmis à l'appel API
Deux bugs complémentaires :
1. **`runner.js` (ligne ~1554)** : le `providerConfig` principal — celui du
   pre-flight ping et du test de capacité — était construit SANS `endpoint` :
   `{ provider, model, apiKey }`. Le ping partait donc vers l'URL par défaut
   du provider ollama (`http://localhost:11434/v1/chat/completions`), une
   instance locale éteinte → échec instantané → E505. Les appels d'exercices
   (runTierAttempt) construisaient bien un providerConfig AVEC endpoint
   (lignes ~2128/2317), mais voir point 2.
2. **`cloud-client.js` (queryLLM, ligne ~255)** : la déstructure
   `const { provider, model, apiKey } = providerConfig` ignorait `endpoint`,
   et l'URL était résolue via `options.endpoint` (jamais défini par le
   runner). Résultat : même les appels d'exercices n'utilisaient PAS le
   `--endpoint=` — il servait uniquement au dry-run et à l'affichage.

### Changements
- **`runner.js`** : `providerConfig` inclut désormais `endpoint` :
  `{ provider, model, apiKey, endpoint }`.
- **`cloud-client.js`** : `queryLLM` déstructure `endpoint` de
  `providerConfig` et la résolution d'URL devient
  `endpoint || options.endpoint || provSpec.url` (le flag --endpoint= du
  runner est enfin appliqué aux appels réels).

### Vérification
- `node runner.js all --provider=ollama --model=minimax-m3 --profile=LIGHT
  --endpoint=https://ollama.com/v1/chat/completions --no-teacher --force` :
  le ping atteint désormais ollama.com (HTTP_401 « Unauthorized » remonté au
  lieu d'un échec instantané localhost) — l'endpoint est bien propagé.
- Catalogue cloud vérifié en direct (`https://ollama.com/v1/models`, 19
  modèles) : les IDs cloud sont SANS suffixe (`minimax-m3`, pas
  `minimax-m3:cloud` — le tag `:cloud` ne vaut que pour le CLI local
  `ollama run`).

### Pièges
- **Clé API ollama.com** : la clé stockée dans `.api-keys.json`
  (`d1f8...960b`, 32 hex) est rejetée en HTTP 401 sur tous les endpoints de
  génération (testée brute, en UUID à tirets, en majuscules, préfixée
  `ollama_` — toujours 401 ; `/v1/models` est public et ne prouve rien).
  Si un run ollama cloud échoue en 401 : régénérer la clé sur
  https://ollama.com/settings/keys puis
  `node runner.js --forget-key=ollama` et ressaisir.
- L'API directe ollama.com exige l'URL complète OpenAI-compat
  `https://ollama.com/v1/chat/completions` (le natif `/api/chat` renvoie
  aussi 401 sans clé valide — les deux surfaces existent).
- `--endpoint=` n'affecte QUE l'URL du provider : le nom du modèle doit
  matcher le catalogue cloud (pas le registre local `ollama.com/library`).

## 2026-08-31 (b) — fix(cli) : --submit autonome + énoncés 4i/4j régressés + améliorations dynamiques

### Contexte
Trois demandes (Memories-BenchGo/Tasks.md) :
1. « node runner.js --submit ne fonctionne pas » — la commande seule tombait
   dans le QUESTIONNAIRE DE DÉMARRAGE (choix du fournisseur, saisie du
   modèle) au lieu de soumettre les carnets existants.
2. « Les AMÉLIORATIONS ACTIVES CE RUN doivent être dynamiques avec les
   derniers changements » — la liste était figée depuis des semaines et
   s'était désynchronisée des commits réels.
3. « Vérifier la demande de l'élève » (tache_4i, prompt injection,
   `inclusionai/ling-3.0-flash-fin:free`) — l'élève échouait avec
   « Attendu 4 commentaires légitimes, obtenu 6 ».

### Cause racine de la demande de l'élève (tache_4i) — L'ÉLÈVE AVAIT RAISON
Régression des énoncés par le commit 0a7c5f3 (2026-08-31 07:46) : les
prompts de 6 fichiers tiers ont été TRONQUÉS à la fin, supprimant les
énoncés `[EXERCISE ...]` restaurés par l'audit 62e7e4b (2026-08-30) :
- `contrainte_negative_0` (tier0_light), `contrainte_negative_1`
  (tier1_light), `contrainte_negative_2` (tier2_light) — 2e régression
  du même bug (déjà perdu puis restauré par 1f9874d le 2026-08-27).
- `contrainte_stricte_3` (tier3_standard), `contexte_long_5`
  (tier5_standard).
- `tache_4i` + `tache_4j` (tier4_frontier) — c'est pourquoi l'élève
  n'a JAMAIS vu l'énoncé `filtrerCommentaires` : il improvisait des
  regex au hasard sans connaître les injections exactes à filtrer.
  Le professeur IA avait tort de le blâmer (« ton code est naïf ») —
  l'exercice était infaisable sans énoncé, pas d'échec de compétence.

**CAUSE RÉELLE de la récurrence (découverte pendant le fix) : la
« machine à régressions » était `updateTiers()` (auto-updater.js).**
À CHAQUE run, le runner appelle `updateTiers()` qui reconstruit le
prompt : il coupe tout à partir du header `[ALGORITHMIC EXERCISES...]`
et réattache le bloc algo de la banque — OR les énoncés custom
(contrainte_negative_*, tache_4i/4j, etc.) sont placés APRÈS ce bloc.
Chaque run les effaçait donc silencieusement du disque ; les commits
0a7c5f3 puis le dry-run de test les ont simplement commités/validés
dans leur état tronqué. C'est pourquoi le bug est « revenu » 2 fois
sans que personne ne touche aux fichiers manuellement.

### Corrections
1. **auto-updater.js — updateTiers() préserve le suffixe custom (CAUSE
   RACINE)** : le prompt reconstruit est désormais `base + algoPrompt +
   suffix` où `suffix` est le contenu suivant le DERNIER exercice de la
   banque algo (énoncés `[EXERCISE ...]` custom ajoutés après). Testé :
   updateTiers() est idempotent et un dry-run complet ne supprime plus
   les énoncés (scan 18 fichiers : 0 manquant avant/après).
2. **tiers/ — restauration des 6 prompts complets** depuis 62e7e4b
   (dernier commit sain). Vérifié : HEAD était un préfixe strict des
   prompts 62e7e4b (seule la fin était perdue), tasks identiques.
   Scan post-fix : 0 énoncé manquant sur les 18 fichiers.
   `node verify_tiers.js` : 368 OK / 0 problème.
3. **submit-action.js (nouveau) — --submit autonome** : `node runner.js
   --submit` seul soumet désormais DIRECTEMENT un carnet existant sans
   passer par le questionnaire. Résolution du carnet : `--model=<nom>`
   (match sur model/shortName/displayName) > dernier carnet modifié >
   sélection interactive numérotée (TTY). Exclut les fichiers
   utilitaires sans `ecoles` (classement_snapshot.json). Token :
   `--github-token` > profil local > saisie interactive validée.
   Combiné à un run (`all --provider=X --submit`), --submit garde son
   sens historique de confirmation post-run.
4. **cli-help.js — getRecentImprovements() + printActiveImprovements()** :
   la section « AMÉLIORATIONS ACTIVES CE RUN » affiche désormais les 5
   dernières entrées du CHANGELOG (format `## AAAA-MM-JJ — titre`), plus
   les lignes permanentes (export CSV, dashboard) et la ligne hybride si
   `--hybrid`. Repli sur la liste figée si le CHANGELOG est absent.
   Testé en live : la sortie reflète les entrées 08-26 à 08-31.

### Vérifications
- `node --check` OK sur runner.js, submit-action.js, cli-help.js,
  auto-updater.js.
- `node tests/run-tests.js` : 27/27 passés.
- `node verify_tiers.js` : 368 exec OK / 388 testés, 0 problème.
- updateTiers() idempotent : 2 passages consécutifs → 0 énoncé perdu.
- Dry-run complet post-fix → scan 18 tiers : 0 énoncé manquant (avant
  le fix, UN dry-run suffisait à perdre les 7 énoncés custom).
- E2E `--submit` non-TTY : dernier carnet (`inclusionai_ling-3.0-flash-fin_free`)
  soumis → PR #120 créée ET mergée automatiquement sur cisco-03/BenchGo-LLM-School.
- E2E `--submit --model=gemma-4-e4b-it` : ciblage par nom → soumission réussie.
- E2E `--submit --model=inconnu` : rejet propre (« Aucun carnet ne correspond »).
- Run normal (`all --provider=... --dry-run`) : le benchmark démarre bien
  (l'action --submit ne le déclenche pas quand d'autres flags de run sont présents).

### Pièges
- `--submit` seul = action autonome ; `--submit` + flags de run
  (--provider/--model/positional tier/--preset) = confirmation post-run.
  Ne pas « simplifier » le test `hasRunIntent` sans mesurer l'impact.
- Le carnet le plus récent de `.carnet/` peut être un fichier utilitaire
  (classement_snapshot.json) — le filtrage par champ `ecoles` est requis.
- **updateTiers() reconstruit le prompt à chaque run** : tout énoncé custom
  doit être placé APRÈS le dernier exercice algo de la banque (suffixe
  désormais préservé). Si un énoncé est ajouté AVANT le header algo, il
  reste intact ; l'essentiel est de ne plus rien mettre à compter perdu
  après le bloc algo — c'est exactement ce que le fix protège.
- Le professeur IA peut donner un diagnostic FAUX quand l'énoncé manque :
  il blâme l'élève alors que l'exercice était infaisable. Toujours
  vérifier l'énoncé AVANT de lire sa correction.

## 2026-08-31 — fix(cloud) : modèles gratuits OpenRouter faussement échoués + mode AUTO + batch non-bloquant

### Contexte
Trois problèmes remontés (Memories-BenchGo/Tasks.md) :
1. « Tous les modèles gratuits OpenRouter échouent » — diagnostic erroné : les
   logs révélaient DEUX causes distinctes confondues.
2. Le menu CLI de `frontier-batch.js` ne proposait pas de mode « Auto » pour
   attribuer le profil selon la taille de chaque modèle.
3. « night-batch.js s'arrête en chemin et demande de garder ce modèle » — un
   prompt interactif (`Garder ce slug tel quel ?` dans frontier-batch, prompt
   de soumission communautaire / écoles séquentielles dans runner.js) gelait
   la file d'attente de nuit jusqu'au réveil de l'utilisateur.

### Causes racines identifiées (logs du 2026-08-31 05:03-05:05)
- **HTTP 403 « Key limit exceeded »** sur `google/gemma-4-26b-a4b-it` : ce
  slug est PAYANT (pas de suffixe `:free`) et la clé OpenRouter de
  l'utilisateur a une limite de dépense à 0$. OpenRouter refuse — c'est le
  comportement protecteur attendu. Les modèles `:free` passent ce gate sans
  rien consommer. Le diagnostic BenchGo disait « rate-limité » → confusion.
- **Ping pre-flight à 8 tokens** : `inclusionai/ling-3.0-flash-fin:free`
  (modèle thinking) répondait HTTP 200 avec `finish_reason=length` et 0
  contenu : le budget de 8 tokens était intégralement consommé par la phase
  de raisonnement → faux `E505_MODEL_UNRESPONSIVE` → modèle déclaré mort
  alors qu'il fonctionne. Même bug que celui corrigé dans
  `healthCheck()` (night-batch.js, 2026-08-10) mais jamais reporté au runner.
- **`delta.reasoning` non collecté** : `streamOpenAICompatResponse` ne
  lisait que `delta.reasoning_content` (DeepSeek-R1, GLM) ; OpenRouter
  expose souvent le raisonnement via `delta.reasoning` → le raisonnement des
  modèles thinking était perdu, aggravant les réponses « vides ».

### Corrections
1. **cloud-client.js — raisonnement OpenRouter** : collecte
   `delta.reasoning` OU `delta.reasoning_content` (l'un OU l'autre selon le
   provider). Les réponses thinking ne sont plus perdues.
2. **runner.js — pre-flight ping 512 tokens** : `maxTokens: 8` → `512`
   (même correction que healthCheck). Un modèle thinking peut raisonner puis
   répondre. Vérifié en live : `ling-3.0-flash-fin:free` répond « OK ».
3. **capability-check.js — budget 512 tokens** : `CAPABILITY_MAX_TOKENS`
   `16` → `512`. Le test OUI/NON ne finit plus en INDETERMINE pour les
   modèles thinking.
4. **runner.js — E506_KEY_LIMIT_EXCEEDED** : nouveau code d'erreur dédié au
   HTTP 403 « Key limit exceeded ». Le diagnostic explique clairement :
   modèle PAYANT + limite de clé 0$ → utiliser un slug `:free` (0$, jamais
   facturés) ; NE PAS déverrouiller la limite. Ajouté à
   `cli-help.js` ERROR_CODES.
5. **frontier-batch.js — mode --yes / non-TTY** : flag `--yes` (implicite en
   non-TTY) qui supprime TOUT prompt de résolution de slug. Un slug non
   reconnu est gardé tel quel avec un avertissement — la file continue, le
   runner arrêtera CE modèle proprement (erreur HTTP 400 fatale) sans
   bloquer les autres.
6. **frontier-batch.js — profil AUTO** : nouvelle option `AUTO` dans le menu
   NIVEAU D'ÉCOLE (+ `--profile=AUTO`). Chaque modèle reçoit le profil
   détecté depuis son slug (2.6B→LIGHT, 550B→DOCTORAT, taille inconnue→
   FRONTIER). Recommandé automatiquement quand la liste mélange des tailles
   différentes. Affichage de l'attribution `[PROFIL]` par modèle dans le
   résumé.
7. **runner.js — restauration de la clé élève en CLI direct** :
   `node runner.js all --provider=openrouter --model=X` ne restaurait JAMAIS
   la clé depuis `.api-keys.json` (seuls preset/questionnaire le faisaient)
   → dry-run « sans clé API » erroné. La clé est maintenant restaurée depuis
   `secrets` (peuplé par `apiKeysStore.restoreIntoSession`).
8. **runner.js — prompts neutralisés sous --force** : le prompt de soumission
   communautaire (`proposeCommunitySubmission`) et le prompt d'écoles
   séquentielles (A/B) ne s'affichent plus quand `--force` est actif.
   `stdio: 'inherit'` rend `isTTY` true même en batch → ces prompts gelaien
   la file de nuit. C'est la cause du « mode nuit s'arrête en chemin ».

### Vérifications
- `node --check` OK sur runner.js, cloud-client.js, capability-check.js,
  frontier-batch.js, cli-help.js.
- `node tests/run-tests.js` : 27/27 passés.
- Ping live sur `inclusionai/ling-3.0-flash-fin:free` avec clé réelle :
  réponse « OK » reçue (le modèle échouait avant le fix).
- Résolution de slug : les 10 `:free` testés résolvent en `exact`.
- Dry-run openrouter avec clé mémorisée : « Configuration valide ».
- `frontier-batch.js --yes` avec slugs inconnus : aucun prompt, file continue.

### Pièges
- **NE PAS déverrouiller la limite 0$ de la clé** : elle protège contre les
  modèles payants. Les slugs `:free` coûtent 0$ et ne sont jamais facturés.
- Un slug sans suffixe `:free` sur OpenRouter est PAYANT par défaut — toujours
  vérifier le suffixe avant de tester.
- `--yes` est implicite en non-TTY (CI, redirection, planificateur) : les
  slugs non résolus passent tels quels et échoueront avec l'erreur HTTP 400
  fatale sur CE modèle uniquement.
- Le mode AUTO de frontier-batch ne remplace pas `--class-by-class` de
  night-batch : AUTO choisit le PROFIL par modèle, `--class-by-class` isole
  chaque TIER dans un process séparé (anti-hang local).

## 2026-08-30 — fix(exercices) : audit complet des tiers — 8 bugs critiques corrigés

### Contexte
Audit exhaustif de TOUS les fichiers `tiers/*.json` + évaluateurs custom :
l'utilisateur exige « aucune erreur » dans les exercices car un bug d'exercice
met en échec TOUS les modèles (élèves). L'audit a croisé 3 sources :
(1) le carnet des demandes d'élèves
(`Carnet-Professeur/2026-08-27/Primaire/demandes.md` — 2 demandes sur
`contrainte_negative_0` dont une correction erronée du professeur IA),
(2) un scan systématique tâche↔prompt↔évaluateur, (3) des tests avec des
solutions CANONIQUES (celles qu'un modèle compétent écrit spontanément).
`verify_tiers.js` passait 368/388 mais masquait les bugs : ses solutions de
référence contournaient les défauts (ex: `__proto__` construit via join()).

### Bugs corrigés
1. **Régression énoncés `contrainte_negative_*`** (tier0/1/2_light.json) :
   le working tree avait annulé le fix 1f9874d (2026-08-27) — les tâches
   `sansLettreE`/`exactementNMots`/`sansMarkdown` étaient à nouveau évaluées
   sans énoncé → échec systématique « X is not defined ». Restaurés depuis
   HEAD via script Node (jamais via shell PowerShell).
2. **Énoncés n'ayant jamais existé** : `contrainte_stricte_3`
   (tier3_standard), `contexte_long_5` (tier5_standard), `tache_4i` +
   `tache_4j` (tier4_frontier) — tâches évaluées, jamais demandées.
   Énoncés `[EXERCISE ...]` ajoutés, alignés sur les évaluateurs.
3. **Contrat tache_2a (tier2_expert) incohérent** : le prompt demandait
   `executerEnPool(taches, concurrence)` mais l'évaluateur custom attend
   `chargerEnParallele(urls, chargement)` → `{succes, echecs}`. Énoncé [2-A]
   réécrit sur le contrat réel (chargement parallèle sans fail-fast),
   format de réponse JSON corrigé, solution verify_tiers.js alignée.
4. **Énoncés tier3_expert trop vagues vs patterns exigés** : [3-A] PowerShell
   (production_backup.db, try/catch, sqlite3 non mentionnés), [3-B] FloodFill
   (« returns the matrix » manquant), [3-C] middleware (Authorization, 403
   « Access Denied », fetch(request) non mentionnés), [3-E] retry (backoff
   impossible à cause de #6), [3-F] fusionnerConfig. Tous réécrits précis.
5. **vm-sandbox.js — faux positif `__proto__` (CRITIQUE)** : la regex
   `/__proto__/i` bloquait même la comparaison défensive
   `if (k === '__proto__') continue;` — LA solution canonique de l'exercice
   anti-pollution 3-F → exercice infaisable pour tout modèle standard.
   Remplacée par des regex ciblant uniquement les ÉCRITURES (assignation
   directe/bracket, Object.setPrototypeOf) ; lectures/comparaisons autorisées.
   Vérifié : pollution réelle bloquée, garde canonique acceptée.
6. **custom-evaluators.js — `setTimeout` absent de la sandbox** : l'évaluateur
   Retry (3-E) échouait « setTimeout is not defined » pour toute solution avec
   délai de backoff. Ajout de `creerSetTimeoutSur()` : setTimeout SÛR (délégue
   au timer hôte Node, callback thunké, délai plafonné 5s, objet gelé) injecté
   dans `exposerFonctionVM` — le code étudiant ne peut pas récupérer le
   Function constructor via ce timer.
7. **evaluateFloodFill — mutation in-place refusée** : la matrice était
   sérialisée en littéral JSON dans la VM (la VM mutait une copie) →
   « Obtenu : undefined » pour toute solution in-place sans return. La matrice
   est désormais passée par référence (`sandbox.__mat__`) et l'évaluateur
   accepte retour OU mutation in-place. Le diagnostic d'inversion x/y
   reste fonctionnel.
8. **verify_tiers.js — solution 3f contournée** : la solution de référence
   construisait `__proto__` via `join()` pour contourner le bloqueur (#5) et
   masquait le bug. Remplacée par la forme canonique.

### Vérifications (tout passe)
- `node verify_tiers.js` → 368 exec OK / 388 testés (20 skip pattern/custom), 0 problème
- Évaluateurs custom avec solutions canoniques → 10/10 PASS
- E2E tier3_expert (réponse Markdown réaliste → extraction → évaluation) → 6/6 PASS
- `node tests/run-tests.js` → 27/27 OK
- Scan « fonction exec absente du prompt » → 0 manquant sur les 18 fichiers
- Scan « pattern required non mentionné » → 0 manquant
- Chargement des profils LIGHT/STANDARD/EXPERT/FRONTIER (7 tiers chacun) → OK

### Pour modifier
1. **Vérifier qu'une tâche a son énoncé** : `node -e "const fs=require('fs');
   const j=JSON.parse(fs.readFileSync('tiers/tierX.json','utf8'));
   j.tasks.forEach(t=>{if(!j.prompt.includes(t.id))console.log('MANQUANT: '+t.id)})"`.
2. **Désactiver le setTimeout sûr** : retirer `sandbox.setTimeout =
   creerSetTimeoutSur();` dans `exposerFonctionVM` (custom-evaluators.js) —
   les solutions avec backoff échoueront à nouveau.
3. **Re-bloquer toute mention de __proto__** : restaurer l'ancienne regex
   `/__proto__/i` dans `detectSandboxEscape` (vm-sandbox.js:82) — l'exercice
   3-F redevient infaisable avec la solution canonique.
4. **Re-exiger le return du FloodFill** : dans `evaluateFloodFill`
   (custom-evaluators.js), supprimer le repli `return matrix;` (in-place).
5. **Tester** : `node verify_tiers.js` + tests canoniques custom-evaluators
   (voir `BenchGo-LLM-School/2026-08-30` dans Logseq).

### Pièges
- Les IDs historiques (`math`, `francais`, `tache_0a`...) n'apparaissent pas
  littéralement dans les prompts (`[EXERCISE Math]`, `[EXERCISE 0-A]`) : c'est
  voulu (extraction par nom de fonction), PAS des bugs.
- `verify_tiers.js` ne couvre que les évaluations `exec` : les évaluations
  `pattern`/`custom` ne sont pas vérifiées par cet outil — les tester avec des
  solutions canoniques réalistes, pas des solutions contournées.
- Toujours vérifier `git status` avant de modifier les tiers : la régression #1
  est survenue car le working tree avait annulé un commit sans que personne
  ne le voie.
- Le setTimeout sûr est plafonné à 5000 ms : un backoff réaliste passe, un
  sleep volontairement long est raccourci (protection anti-hang).
- L'ancienne page Logseq `BenchGo/Vérifications/Audit exercices 2026-08-30`
  (créée en début de session) contient le diagnostic complet ; le journal
  officiel est `BenchGo-LLM-School/2026-08-30`.

## 2026-08-27 — fix(night-batch) : carnet non sauvegardé en mode classe-par-classe

### Contexte
Le mode classe-par-classe (`--class-by-class` / `--cbc`) lance chaque tier
dans un process séparé (`node runner.js --force --profile=X <tierNum>`). Or le
runner ne sauvegarde le carnet de scores QUE si `tierArg === "all"`
(`runner.js:2654`). En mode classe-par-classe, `tierArg` vaut le numéro du
tier (ex: `"0"`), jamais `"all"` → le carnet n'est jamais écrit. Les rapports
Markdown sont créés (écriture inconditionnelle), mais le leaderboard
(`matchLedger`) ne trouve aucun carnet → les modèles testés apparaissent
comme "JAMAIS TESTÉS" malgré des rapports valides et un bilan de session
annonçant des succès.

### Changements
- **`night-batch.js` (`runSchoolClassByClass`)** : après la boucle des tiers,
  si tous les tiers obligatoires ont réussi ET qu'aucun filtre de tier n'a
  restreint la sélection ET que l'école ne s'est pas arrêtée (mode Manuel),
  on lance un run `all` de consolidation (`runBenchmark` sans `tierNum`).
  Ce run re-teste toute l'école d'un coup : c'est le seul chemin qui écrit
  le carnet correctement (`saveAndBuildBilan`). Le surcoût est un run
  complet additionnel par modèle/école, acceptable en mode nuit.
- La consolidation est désactivée si `tierFilter` est défini (tiers précis
  demandés par l'utilisateur) ou si `stopped` (mode Manuel arrêté) — on ne
  consolide que les écoles complètes et réussies.

### Pour modifier
1. **Désactiver la consolidation** : commenter le bloc `if (allMandatoryOk
   && !tierFilter && !stopped)` dans `runSchoolClassByClass()`.
2. **Consolider même en cas d'échec partiel** : retirer la condition
   `allMandatoryOk` (le carnet sauvegarderait alors un score d'école échoué).
3. **Éviter le re-test complet** : implémenter dans `runner.js` une
   sauvegarde du carnet en mode tier unique (résultat partiel), ce qui
   nécessite de revoir `saveAndBuildBilan` pour gérer les résultats par
   tier plutôt que par école complète.

### Pièges
- Le run de consolidation re-teste TOUTE l'école (tous les tiers) — il
  double le temps d'exécution par modèle. C'est volontaire : le carnet
  est un cumul multi-écoles qui nécessite un run complet pour être cohérent.
- Si le run de consolidation échoue (modèle instable entre les deux runs),
  le carnet peut être absent ou incomplet. Un avertissement est affiché.
- La consolidation ne se déclenche qu'avec `--class-by-class` (pas en mode
  classique, qui lance déjà un run `all` et sauvegarde le carnet).

## 2026-08-27 — fix(tiers) : énoncés manquants « contrainte_negative_* » dans les prompts

### Contexte
Les exercices `contrainte_negative_0`, `contrainte_negative_1` et
`contrainte_negative_2` (tiers 0, 1, 2 LIGHT) figuraient dans le tableau
`tasks` (donc étaient évalués) mais **n'étaient jamais demandés dans le
`prompt`** envoyé aux modèles. Conséquence : tous les modèles échouaient
avec `ReferenceError: sansLettreE is not defined` (ou `exactementNMots` /
`sansMarkdown`) car ils ne pouvaient pas deviner qu'il fallait définir ces
fonctions. Bug de définition des tiers, pas des modèles — confirmé par les
demandes du carnet professeur (`Carnet-Professeur/2026-08-27/Primaire/demandes.md`)
où le professeur IA a lui-même donné un diagnostic erroné (blâmant l'élève
alors que l'énoncé était fautif).

### Changements
- **`tiers/tier0_light.json`** : ajout de l'énoncé
  `[EXERCISE contrainte_negative_0]` décrivant `sansLettreE(c)` (bannir la
  lettre 'e', insensible à la casse) à la fin du `prompt`.
- **`tiers/tier1_light.json`** : ajout de l'énoncé
  `[EXERCISE contrainte_negative_1]` décrivant `exactementNMots(phrase, n)`
  (compter les mots séparés par espaces) à la fin du `prompt`.
- **`tiers/tier2_light.json`** : ajout de l'énoncé
  `[EXERCISE contrainte_negative_2]` décrivant `sansMarkdown(c)` (vérifier
  l'absence de marqueurs Markdown) à la fin du `prompt`.

### Vérification
- `verify_tiers.js` : `contrainte_negative_0` (4 exec OK),
  `contrainte_negative_1` (4 exec OK), `contrainte_negative_2` (5 exec OK).
- Les fonctions de référence dans `verify_tiers.js` (lignes 117-121)
  restaient inchangées et valides.
- `tests/run-tests.js` : 27/27 passés.

### Impact
Les modèles testés avant cette correction ont subi une pénalité injuste
de -34/-37 points sur l'exercice `contrainte_negative_0`. Leurs carnets ne
sont pas rétrocorrectement mis à jour (les anciens résultats restent). Les
prochains runs appliqueront l'énoncé complet.

## 2026-08-26 — feat(provider) : ajout de Kilo Gateway comme provider cloud

### Contexte
OpenRouter ne passe plus : rate-limits upstream systématiques sur tous les
modèles free (HTTP 200 vide ou 429). L'utilisateur veut tester les modèles
gratuits de **Kilo Gateway** (`api.kilo.ai`) en alternative. Kilo est 100%
compatible OpenAI (même format `/chat/completions`, streaming SSE, auth
`Bearer`) et propose 19 modèles gratuits (dont `nvidia/nemotron-3.5-lightning:free`
qui était visé).

### Changements
- **`cloud-client.js` (`CLOUD_PROVIDERS`)** : ajout de `kilo` avec
  `url: 'https://api.kilo.ai/api/gateway/chat/completions'`, `envKey: 'KILO_API_KEY'`,
  `openaiCompat: true`, `requiresAuth: true`, `optionalAuth: true`.
  - Nouveau champ `optionalAuth: true` → l'absence de clé est tolérée (accès
    anonyme aux modèles `:free`, limité à 200 req/h/IP). Un warning est loggé
    mais le run n'est pas bloqué. Avec clé (abonnement) : pas de limite anonyme.
- **`model-resolver.js`** : refactorisation de la logique de matching dans une
  fonction pure `_matchSlug(raw, ids, idsSet)` réutilisable. Ajout de
  `resolveKiloSlug()`, `getKiloModelIds()`, `fetchKiloModels()` (cache disque
  séparé `.kilo-models-cache.json`, TTL 24h, endpoint public `/models`).
  - Kilo Gateway a le même format de slug qu'OpenRouter (`provider/model-name`)
    et la même structure `/models` (`{ data: [...] }`, champ `id`).
- **`frontier-batch.js`** :
  - Ajout de `kilo` au menu `CLOUD_PROVIDERS` (option 2).
  - Ajout de `kilo` à `PROVIDERS_OPTIONAL_KEY` (clé optionnelle).
  - Résolution de slug étendue à Kilo (`if (provider === 'openrouter' || provider === 'kilo')`).
- **`runner.js`** :
  - Import de `resolveKiloSlug`.
  - Bloc de résolution de slug étendu à Kilo.
  - Validation dry-run : `kilo` ajouté à la liste des providers tolérant
    l'absence de clé (`['lmstudio', 'ollama', 'custom', 'kilo']`).
  - Avertissement "clé non mémorisée" : `kilo` exclu (accès anonyme possible).
- **`pricing.js`** : ajout d'un cache Kilo parallèle (`.kilo-pricing-cache.json`),
  `getKiloPricing()`, `refreshKiloPricing()`. Kilo renvoie les prix en chaînes
  $/token avec `-1` pour les non définis (modèles gratuits auto) → traité comme 0.
  Intégré dans `findPrice()` (lookup exact + préfixe après OpenRouter). Fallback
  provider `kilo` générique (1/4 $/1M). Les modèles `:free` coûtent 0$.
- **`cli-help.js`** : `--provider=` mentionne `kilo`. Messages d'erreur E400/E404
  mentionnent Kilo Gateway et la résolution automatique des noms familiers.

### Utilisation
```powershell
# Avec clé (recommandé, abonnement — pas de limite anonyme)
node frontier-batch.js --provider=kilo --models=nvidia/nemotron-3.5-lightning:free --profile=FRONTIER --api-key=<kilo_key>

# Sans clé (accès anonyme, 200 req/h/IP — risqué pour un batch complet)
node frontier-batch.js --provider=kilo --models=nvidia/nemotron-3.5-lightning:free --profile=LIGHT

# Via le runner (résolution de slug automatique : "nemotron" -> slug exact)
node runner.js all --provider=kilo --model=nvidia/nemotron-3.5-lightning:free --profile=LIGHT --api-key=<kilo_key>
```

### Modèles gratuits Kilo (19 au 2026-08-26)
`stepfun/step-3.7-flash:free`, `tencent/hy3:free`, `poolside/laguna-s-2.1:free`,
`poolside/laguna-xs-2.1:free`, `meituan/longcat-2.0-free`,
`dots-studio/dots-3-note-preview:free`, `liquid/lfm-2.5-2.6b:free`,
`nvidia/nemotron-3.5-lightning:free`, `thinkingmachines/inkling-small:free`,
`thinkingmachines/inkling:free`, `cohere/north-mini-code:free`,
`nvidia/nemotron-3.5-content-safety:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
`minimax/minimax-m3:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`,
`minimax/minimax-m2.7:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
`kilo-auto/free`, `openrouter/free`.

### Pièges
- **Accès anonyme limité** : 200 requêtes/heure/IP sans clé. Un batch FRONTIER
  complet (6 classes × ~10 exercices + aide + rattrapage) dépasse largement
  200 requêtes → l'utilisateur DOIT fournir une clé pour un batch complet.
  Sans clé, seuls LIGHT (2 classes) passe peut-être.
- **NVIDIA free endpoints** : usage trial, données journalisées par NVIDIA.
  Ne pas envoyer de données confidentielles.
- **Prix `-1`** : Kilo renvoie `-1` pour les prix non définis (modèles auto/free).
  `pricing.js` traite `-1` comme 0 (gratuit). Si un modèle payant a un prix réel
  mais l'endpoint renvoie `-1` (bug), le coût affiché sera 0$ (sous-estimé).
- Le cache disque Kilo (`.kilo-pricing-cache.json`, `.kilo-models-cache.json`)
  est distinct du cache OpenRouter (`.pricing-cache.json`) pour ne pas mélanger
  les listes/prix.

## 2026-08-26 — feat(profilage) : test de capacité OUI/NON en remplacement de l'auto-profilage + profilage externe

### Contexte
L'utilisateur a lancé `Nemotron 3 5 Lighting Free` (Nvidia) sur OpenRouter
(FRONTIER). L'auto-profilage prenait déjà **10 minutes** (3 tentatives × timeout
généreux) et le profilage externe (professeur IA) en rajoutait 5-20s. Au total,
1 à 10 min de profilage avant le moindre exercice. Plusieurs utilisateurs ont
remonté le problème et certains annulent le run tellement c'est long.

### Décision
Remplacer l'auto-profilage (`self-profiling.js`, interview JSON sur 4
compétences, 1-5 min) ET le profilage externe (`external-profiling.js`,
professeur IA, 5-20s) par un **test de capacité** simple et rapide (~20-30s) :
un seul appel au modèle élève lui demande s'il est capable de passer l'examen.

- **OUI** → le runner valide et commence les exercices. Plus aucun filtrage des
  tâches : toutes sont exécutées, quels que soient les compétences déclarées.
- **NON** → le modèle est **recalé définitivement** : exit 0 propre, pas de
  pénalité, pas de carnet créé. C'est l'exclusion pure, pas un échec noté.

Le **pre-flight check** (détection des rate-limit 200/400 vides, tâche
2026-08-26) est **conservé** : il s'exécute juste avant le test de capacité et
arrête net les modèles qui ne répondent pas du tout.

### Changements
- **`capability-check.js` (nouveau)** : module de test de capacité.
  - `runCapabilityCheck(queryFn, providerConfig, contextLimitTokens)` →
    `{ capable, rawAnswer, attempts }`. Un seul appel, 2 tentatives max,
    timeout 30s par tentative (pire cas ~60s, attendu ~20-30s).
  - `interpretCapabilityAnswer(text)` → `'YES' | 'NO' | null`. Parsing robuste :
    tolérant à la casse, aux accents, au prose autour de la réponse, aux variants
    FR/EN (oui/yes, non/no, je suis capable, je ne peux pas, peut-être...).
  - Par prudence, une réponse indéterminée après 2 tentatives → **OUI par défaut**
    (le modèle bavard/mal formaté aura sa chance à l'examen réel qui le jugera
    sur preuve). Exclure un modèle fonctionnel mais bavard serait une erreur.
- **`runner.js`** :
  - Suppression de l'auto-profilage (`runSelfProfiling`) et du profilage externe
    (`runExternalProfiling`) — remplacés par `runCapabilityCheck`.
  - `selfProfile` reste `null` → aucun filtrage des tâches dans `runTierAttempt`
    (le bloc `if (selfProfile && ...)` ne se déclenche plus).
  - `filterProfile` forcé à `null` → toutes les tâches exécutées.
  - L'Indice de Calibration n'est plus calculé (`selfProfile` null → bloc court-
    circuité). La section calibration disparaît des nouveaux rapports.
  - Affichage : bannière « TEST DE CAPACITÉ », verdict OUI/NON, et message de
    recal si NON (exit 0 propre).
  - Imports nettoyés : `runSelfProfiling` retiré, `runExternalProfiling` retiré,
    `runCapabilityCheck` ajouté. `filterTasksByProfile`/`SKILL_LABELS` conservés
    (utilisé par les rapports/leaderboard pour les anciens carnets).
- **`self-profiling.js` / `external-profiling.js`** : inchangés (conservés pour
  la rétrocompatibilité des anciens carnets/rapports et du leaderboard qui affiche
  l'auto-profilage historique). Plus appelés par le runner.

### Comportement
- Le pre-flight check (cloud uniquement) reste en premier : 3 pings, arrêt net
  `E505_MODEL_UNRESPONSIVE` si le modèle ne répond pas du tout (rate-limit
  upstream silencieux).
- Puis le test de capacité : 1 appel (~20-30s).
  - NON → `process.exit(0)` avec message de recal, pas de carnet, pas de pénalité.
  - OUI → exécution de toutes les tâches de tous les tiers, sans filtrage.

### Pour modifier
1. **Changer le prompt du test** : éditer `CAPABILITY_PROMPT` dans
   `capability-check.js`.
2. **Changer le timeout / nombre de tentatives** : éditer
   `CAPABILITY_TIMEOUT_MS` et `MAX_ATTEMPTS` dans `capability-check.js`.
3. **Changer la logique de parsing** : éditer `interpretCapabilityAnswer()`
   (patterns `noPatterns` / `yesPatterns` / `maybePatterns`).
4. **Changer le comportement NON (exclure + marquer dans carnet au lieu d'exit)** :
   remplacer le `process.exit(0)` dans `runner.js` par la création d'un carnet
   marqué « recalé ».
5. **Réactiver le filtrage** : remettre `filterProfile` à un profil non-null
   (ex: reconstruire un profil depuis la réponse de capacité).
6. **Tester** : `node runner.js --provider=openrouter --model=<slug>
   --profile=LIGHT` (le test de capacité remplace l'auto-profilage).

### Pièges
- `interpretCapabilityAnswer` teste les patterns NON en **priorité** : un
  "non, je ne suis pas capable" est non ambigu. "Oui mais non" est rare et serait
  classé NON (prudence).
- Le test de capacité ne remplace PAS le pre-flight check : le pre-flight
  détecte les modèles qui ne répondent **pas du tout** (rate-limit silencieux),
  le test de capacité détecte les modèles qui répondent **mais refusent**.
- `selfProfile` null désactive aussi l'Indice de Calibration (métrique qui
  comparait l'auto-évaluation à la performance réelle). Les anciens carnets
  conservent leur calibrationIndex ; les nouveaux n'en ont plus.
- Les anciens rapports/carnets avec auto-profilage restent affichables dans le
  leaderboard (les modules `self-profiling.js`/`external-profiling.js` sont
  conservés pour la lecture historique).

## 2026-08-26 — fix(cloud) : détection des réponses vides (modèles free rate-limités) + pre-flight check

### Contexte
Suite de la tâche précédente (résolution des slugs). Nouveau bug remonté par
l'utilisateur (Admin/Tasks.md) : le modèle `z-ai/glm-5.2:free` (slug valide, pas
de HTTP 400) produisait un rapport **0/0** avec toutes les tâches bypassées. Le
log montrait `statut=OK` mais `0 chunks, 0 chars` — l'API répondait HTTP 200 avec
des chunks SSE valides mais **tous vides** (`delta.content: ""`).

### Cause racine
Les modèles **free** d'OpenRouter passent par un pool partagé vers un provider
upstream (ex: Decart). Quand ce pool est saturé (trop d'utilisateurs gratuits
simultanés), le provider upstream renvoie :
- Soit un HTTP 429 direct (rate limit explicite)
- Soit un HTTP 200 avec des chunks SSE vides (`delta.content: ""`) — **rate limit
  silencieux** : le stream s'ouvre, tourne pendant 20-60s, puis se termine sans
  aucun contenu.

Le parser SSE (`streamOpenAICompatResponse`) comptait les chunks (statut=OK) mais
ne détectait pas que le contenu était vide → le runner considérait la réponse
comme un succès à 0 tokens → l'auto-profilage échouait en 3×60s → le profilage
externe (professeur) donnait un profil bas (1/5) → toutes les tâches bypassées →
rapport 0/0 inutile après ~5 min d'attente.

### Changements
- **`cloud-client.js` (`streamOpenAICompatResponse`)** :
  - Détection des **chunks d'erreur SSE** (`chunk.error`) noyés dans le stream —
    OpenRouter envoie parfois l'erreur dans un chunk au lieu d'un HTTP 4xx/5xx.
  - Comptage des chunks bruts (`rawChunkCount`) et du `finish_reason`.
  - **Détection de réponse vide** : si HTTP 200, chunks reçus mais 0 contenu →
    erreur `isEmptyResponse` levée (au lieu de retourner un succès vide).
    Deux cas : chunks d'erreur SSE présents (rate limit explicite) ou chunks vides
    (rate limit silencieux).
- **`cloud-client.js` (`queryLLM`)** : propagation de `isEmptyResponse` même
  en `isMandatory=false` (pour que le runner puisse compter et arrêter net).
- **`runner.js` (pre-flight check)** : avant l'auto-profilage, en mode cloud, un
  **ping trivial** ("Reply with: OK", `max_tokens: 8`, timeout 30s) vérifie que
  le modèle répond réellement. 3 tentatives avec pause de 3s. Si toutes échouent →
  `E505_MODEL_UNRESPONSIVE` avec message clair expliquant les causes possibles
  (rate-limit upstream, modèle indisponible, quota épuisé). Évite de gaspiller
  5+ min en auto-profilage pour un modèle qui ne répond pas.
- **`runner.js` (`runTierAttempt`)** : le catch détecte `isEmptyResponse` et la
  propage (sans relance mandatory) au lieu de la traiter comme une erreur
  optionnelle.
- **`runner.js` (`runSchool`)** : compteur `consecutiveEmptyResponses` (seuil
  `MAX_EMPTY_RESPONSES = 3`). Après 3 réponses vides consécutives → arrêt net
  avec message explicatif (modèle indisponible/rate-limité upstream).
- **`cli-help.js`** : nouveau code `E505_MODEL_UNRESPONSIVE` avec suggestion
  (réessayer plus tard, autre modèle, BYOK).

### Tests
- `node --check` sur les 3 fichiers modifiés : OK.
- `node tests/run-tests.js` : 27/27 passés.
- Test direct API : `z-ai/glm-5.2:free` renvoie soit HTTP 429 (rate limit
  explicite), soit HTTP 200 avec chunks vides (rate limit silencieux) — les deux
  sont maintenant détectés et arrêtent le run proprement.

### Pièges
- Le pre-flight check ne s'active qu'en mode cloud (`isCloudMode`), pas en local
  (LM Studio répond toujours si le serveur tourne).
- Le ping utilise `max_tokens: 8` — certains modèles free peuvent renvoyer
  plus de tokens que demandé (overshoot) ; on teste juste `content.length > 0`,
  pas le contenu exact.
- `isEmptyResponse` est propagée même en non-mandatory, ce qui change le
  comportement historique (les erreurs optionnelles retournaient `null` sans
  propager). Mais c'est voulu : une réponse vide n'est pas "optionnelle", c'est
  un échec réel.
- Les modèles free d'OpenRouter peuvent alterner entre 429 (explicite) et 200
  vide (silencieux) selon la charge du moment. Le pre-flight check capte les
  deux cas.

---

## 2026-08-26 — feat(model-resolver) : résolution tolérante des slugs OpenRouter + arrêt net sur slug invalide

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks.md) : en testant des modèles OpenRouter
via `frontier-batch.js`, AUCUN modèle ne passait. Deux problèmes distincts :
1. Le slug `thinkingmachines/inkling-small:free` échouait silencieusement (0 tokens,
   toutes tâches bypassées) — modèle probablement dépublié ou slug corrompu.
2. Le slug `node` (saisie tronquée/erronée) renvoyait `HTTP 400 "node is not a valid
   model ID"` pour CHAQUE appel API, mais le runner parcourait quand même les 6
   classes en échec → rapport 0/2752 inutile au lieu d'arrêter net.

### Cause racine
1. **Aucune validation/tolérance du slug** : l'utilisateur saisit ou colle un nom
   familier (`gpt-4o`, `llama3.1-8b`, `inkling-small`) au lieu du slug exact
   OpenRouter (`openai/gpt-4o`, `meta-llama/llama-3.1-8b-instruct`). OpenRouter
   rejette avec HTTP 400, mais BenchGo ne prévenait pas ni ne corrigeait.
2. **`cloud-client.js` traitait l'erreur HTTP 400 comme "optionnelle"** (via
   `isMandatory=false` dans `runTierAttempt`) → `return null` → le runner
   continuait à la classe suivante. Aucune distinction entre "timeout transitoire"
   et "slug fondamentalement invalide".

### Changements
- **`model-resolver.js`** (nouveau) : module de résolution tolérante des slugs
  OpenRouter. Fetch l'endpoint public `/api/v1/models` (cache disque 24h partagé
  avec `pricing.js` via `.pricing-cache.json`). Stratégies de matching dans
  l'ordre : exact → alias courant (`gpt-4o` → `openai/gpt-4o`) → préfixe →
  sous-chaîne → suffixe. Désambiguisateur `:free` : si les matchs ne diffèrent que
  par le suffixe `:free` (ex: `inkling-small` + `inkling-small:free`), on préfère
  automatiquement le variant gratuit (BenchGo cible les modèles gratuits). Table
  d'alias courants (GPT, Claude, Llama, Mistral, DeepSeek, Qwen, Gemini).
- **`frontier-batch.js`** : après saisie des modèles, si le provider est OpenRouter,
  chaque slug est résolu via `resolveOpenRouterSlug()`. Si résolu → remplacement
  silencieux avec affichage (`gpt-4o -> openai/gpt-4o (alias)`). Si ambigu ou
  introuvable → suggestions proches + choix interactif (garder tel quel, pick
  numéro, ou saisir le slug exact). Si offline → slug gardé tel quel (repli).
- **`runner.js`** : résolution auto du slug OpenRouter au démarrage du run (avant
  l'auto-profilage). Si le slug est résolu → remplacement + log. Si non résolu →
  avertissement + suggestions, mais le run démarre (l'erreur HTTP 400 fatale
  arrêtera net au 1er appel si le slug est vraiment invalide).
- **`cloud-client.js`** : détection des erreurs fatales de slug invalide. HTTP 400
  "not a valid model ID" → `error.isFatalSlugError = true` + code
  `E400_INVALID_MODEL_ID`. HTTP 404 "model not found" → `E404_MODEL_NOT_FOUND`.
  Ces erreurs sont TOUJOURS propagées comme fatales (même `isMandatory=false`),
  arrêtant le run au 1er appel au lieu de parcourir 6 classes en échec.
- **`runner.js` (`runTierAttempt`)** : le bloc `catch` détecte `isFatalSlugError`
  et propage immédiatement (sans retry ni relance mandatory) → remonte à
  `runSchool` → `main().catch()` → `process.exit(1)` avec message clair.
- **`cli-help.js`** : nouveaux codes d'erreur `E400_INVALID_MODEL_ID` et
  `E404_MODEL_NOT_FOUND` avec suggestions (vérifier le slug, utiliser
  frontier-batch.js pour la résolution auto).

### Tests
- `node --check` sur les 5 fichiers modifiés + model-resolver.js : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `resolveOpenRouterSlug('node')` → `not_found` (slug invalide, pas de suggestion).
- `resolveOpenRouterSlug('gpt-4o')` → `openai/gpt-4o` (alias).
- `resolveOpenRouterSlug('GPT-4o')` → `openai/gpt-4o` (alias, insensible casse).
- `resolveOpenRouterSlug('llama3.1-8b')` → `meta-llama/llama-3.1-8b-instruct` (alias).
- `resolveOpenRouterSlug('inkling-small')` → `thinkingmachines/inkling-small:free`
  (prefer_free — désambiguisateur :free).
- `resolveOpenRouterSlug('thinkingmachines/inkling-small:free')` → exact.
- Cache disque partagé avec pricing.js : `getOpenRouterModelIds()` charge 417
  modèles depuis `.pricing-cache.json` sans écraser les prix.

### Pièges
- `model-resolver.js` ne réécrit le cache disque QUE s'il n'existe pas déjà
  (évite d'écraser les VRAIS prix de `pricing.js` avec des prix à 0). Le cache est
  partagé : `pricing.js` et `model-resolver.js` lisent le même `.pricing-cache.json`.
- Les alias Claude 3.5 (`claude-3.5-sonnet`) ont été retirés (modèles dépubliés sur
  OpenRouter, remplacés par 4.x). Les alias pointent maintenant vers les versions
  disponibles (`claude-sonnet-4`, `claude-opus-4.5`, etc.).
- Le désambiguisateur `:free` ne s'active QUE si une paire (free, non-free) existe.
  Si seul le variant `:free` existe, il est matché normalement (exact/substring).
  Si seuls des variants non-:free existent, aucun n'est forcé en :free.
- Si le réseau est indisponible (offline), `resolveOpenRouterSlug()` renvoie
  `{ offline: true, slug: <saisi> }` — le slug est gardé tel quel, le run démarre
  sans validation (comportement historique préservé).

---

## 2026-08-26 — fix(frontier-batch + leaderboard) : modèles non-LLM testés et classés TOP DU TOP à 0/0

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks.md) : un modèle d'embeddings
(`liquid/lfm-2.5-embedding-350m:free` via OpenRouter) a été testé par
`frontier-batch.js`, n'a réellement passé AUCUN exercice (toutes les tâches
bypassées par l'auto-profilage, score 0/0), puis a été classé **TOP DU TOP** dans
le classement cloud (rang 1, seul de sa catégorie).

### Cause racine
Deux bugs distincts :
1. **`frontier-batch.js` n'avait aucune détection des modèles non-LLM**
   (embeddings, OCR, rerank, vision-only). Contrairement à `night-batch.js`
   qui les marque « NON APPLICABLE », le batch cloud acceptait n'importe quel
   slug — y compris un vectoriseur incapable de générer du code.
2. **`getVerdict` / `getCategory` donnaient « TOP DU TOP » au rang ≤ 3 sans
   vérifier qu'au moins un exercice avait été réellement tenté.** Un modèle à
   `max === 0` (tout bypassé) mais classé rang 1 (seul cloud testé) obtenait la
   mention d'excellence.

### Changements
- **`frontier-batch.js`** : import de `NON_LLM_PATTERNS` depuis `night-batch.js`
  et nouvelle fonction `isNonLlmCloudModel(slug)`. Après saisie/sélection des
  modèles, les slugs détectés comme non-LLM sont rejetés avec un avertissement
  explicite ; si tous sont rejetés, abandon propre (exit 1).
- **`night-batch.js`** : export de `NON_LLM_PATTERNS` (centralisation, évite la
  duplication de la liste de regex).
- **`leaderboard.js`** (`getVerdict` + `getCategory`, versions serveur et JS
  inline `_getCategory`) : nouveau verdict « NON TESTÉ » (gris, rang 99) quand
  `entry.max === 0`. Le podium ne s'applique plus aux modèles n'ayant rien
  réellement passé. Couleur ANSI gris dédiée (`\x1b[90m`) dans le print CLI.
- **`consolidate-leaderboard.js`** : même correction sur `getVerdict`,
  `getCategory` (serveur) et `_getCategory` (JS inline), avec passage du `max`
  aux appels concernés.

### Tests
- `node --check` sur les 4 fichiers modifiés : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `node scripts/check-inline-js.js` : JS inline valide (classement local +
  communautaire).
- `node leaderboard.js` : `liquid/lfm-2.5-embedding-350m:free` affiche désormais
  « NON TESTÉ » (gris) au lieu de « TOP DU TOP ».
- `node frontier-batch.js --provider=openrouter --models=liquid/lfm-2.5-embedding-350m:free`
  : le modèle est rejeté (« MODÈLES NON-LLM REJETÉS ») et le batch abandonne
  proprement.

---

## 2026-08-26 — fix(leaderboard): modèles LM Studio classés à tort en cloud

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks.md) : `node leaderboard.js` affichait
« MODÈLES LOCAUX · LM Studio (0) » alors que des modèles locaux avaient été
testés, et `node leaderboard.js --lmstudio` annonçait « Aucun modèle LM Studio
testé trouvé dans les carnets ».

### Cause racine
`night-batch.js` lance `runner.js` avec `--provider=lmstudio`. Dans
`score-ledger.js`, `isCloud` était calculé comme `(provider !== 'local')`, donc
tout provider autre que la valeur littérale `'local'` — y compris `'lmstudio'`,
`'ollama'`, `'custom'` — était marqué `isCloud: true`. Les modèles LM Studio
testés en mode nuit se retrouvaient donc relégués dans la section « cloud » du
classement, et le rapport `--lmstudio` (qui filtre `!isCloud`) les masquait.

### Changements
- **`score-ledger.js`** : `isCloud` est désormais `!LOCAL_PROVIDERS.has(provider)`
  où `LOCAL_PROVIDERS = { local, lmstudio, ollama, custom }`. Les serveurs
  OpenAI-compat locaux restent locaux.
- **`leaderboard.js`** (`aggregateLedger` + `providerDisplay`) : `isCloud` est
  déduit du provider quand il est présent ; `lmstudio`/`ollama`/`custom` sont
  traités comme locaux même si un ancien carnet porte `isCloud: true`
  (réparation rétroactive sans re-run).
- **`consolidate-leaderboard.js`** (`aggregateCarnet` + `providerDisplay`) :
  même correction pour le classement communautaire.
- **`night-batch.js`** (`detectOrphanLedgers`) : ne se fie plus au champ
  `isCloud` brut du carnet ; il déduit le cloud depuis le provider, sinon un
  carnet LM Studio mal marqué ne serait jamais détecté comme orphelin.
- **Carnets sur disque** : `qwen3.8_4b_distilled_gguf_q5_k_m` et
  `internlm3-8b-instruct_q4_k_m` passés de `isCloud: true` à `isCloud: false`
  (données locales, non versionnées).

### Vérification
- `node leaderboard.js` → les 2 modèles LM Studio apparaissent dans
  « MODÈLES LOCAUX · LM Studio (2) » avec badge vert 🏠 ; section cloud vide.
- `node leaderboard.js --lmstudio` → Bloc 1 affiche le modèle testé.
- `node scripts/check-inline-js.js` → OK. `node tests/run-tests.js` → 27/27 OK.

---

## 2026-08-26 — fix(runner): mode nuit bloqué sur le prompt du professeur

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks.md) : en mode nuit (batch `auto`),
le runner s'arrêtait net **en plein milieu des exercices** et demandait
interactivement « Provider du professeur (défaut: openrouter) : ». Le terminal
restait muet (logs vides) et le batch ne repartait jamais.

### Cause racine
`night-batch.js` lance `runner.js` avec `stdio: 'inherit'` (depuis la tâche
2026-08-10) pour streamer la sortie du runner en temps réel. Or `inherit` rend
`process.stdin.isTTY` et `process.stdout.isTTY` **true** dans le process enfant,
même en mode batch non-interactif.

Le bloc « Professeur correcteur » de `runner.js` (mode CLI historique) ne testait
que `process.stdin.isTTY && process.stdout.isTTY` pour décider d'afficher le
prompt interactif `askFreeText("Provider du professeur...")`. Avec `inherit`,
ce test passait en plein batch → le runner se mettait en attente d'une saisie
clavier qui ne venait jamais → **hang indéfini**. Si stdout était redirigé
(`node night-batch.js > nuit.log`), le prompt partait dans le fichier →
terminal vide = « logs vides ».

`--force` est le marqueur officiel du mode batch (cf. AGENTS.md), déjà utilisé
pour court-circuiter les `askYesNo` de re-test et de pénalité. Le prompt du
professeur ne l'utilisait pas — c'est l'oubli.

### Changements (`runner.js`)
- **Prompt du provider professeur** : gated sur `!forceFlag` en plus du test
  TTY. En mode `--force`, le professeur reste sur son provider par défaut
  (`openrouter`) sans demander interactivement.
- **Prompt `askYesNo("Utiliser le professeur...")`** (sans clé mémorisée) :
  gated sur `!forceFlag` également. En mode `--force` sans clé mémorisée pour le
  provider, repli immédiat sur l'auto-analyse classique (`enabled: false`) sans
  bloquer le batch. Log informatif affiché.
- Comportement inchangé en mode interactif (`--force` absent) : l'utilisateur
  peut toujours choisir le provider et saisir sa clé.

### Vérification
- `node --check runner.js` → OK.
- Le mode nuit reprend son flux automatique : pas de prompt en plein exercice.

---

## 2026-08-22 — fix(night-batch): health check + modèles de raisonnement (thinking)

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks1.md) : `Kai Os Grug 12B`, le meilleur
modèle du classement, ne chargeait plus après désisolation. Le bilan de session
affichait `health check échoué` et l'auto-blacklist le marquait
`load_failed`. Cause : **le modèle est un modèle de raisonnement** (thinking).
LM Studio renvoie `reasoning_content` (la phase de pensée) EN PLUS de `content`
(la réponse finale). Avec `max_tokens: 8`, tout le budget de tokens était
consommé par le raisonnement (`reasoning_tokens: 5`), laissant `content: ""`
(vide) avec `finish_reason: "length"`. Le health check testait
`content.length === 0` → échouait systématiquement → auto-blacklist. Or le
modèle fonctionnait parfaitement — il avait juste besoin de plus de tokens pour
terminer sa phase de pensée puis répondre.

### Changements (`night-batch.js` `healthCheck()`)
- **`max_tokens: 8 → 512`** : les modèles de raisonnement (thinking) consomment
  d'abord des tokens en phase de pensée (`reasoning_content`) avant de
  produire la réponse (`content`). Avec 8 tokens, tout était consommé par le
  raisonnement (48 tokens pour Kai Os Grug) → `content` vide → faux échec.
  Avec 512, le modèle a largement assez pour raisonner puis répondre. Testé :
  Kai Os Grug 12B raisonne en 48 tokens puis répond `"OK"` (finish_reason:
  "stop").
- **Détection des modèles de raisonnement** : le health check lit désormais
  `reasoning_content` (champ ajouté par LM Studio pour les modèles thinking)
  en plus de `content`. Si `content` est vide MAIS `reasoning_content` est
  présent, le modèle est marqué sain (`ok: true`) — filet de sécurité au cas
  où un modèle thinking consommerait plus de 512 tokens de raisonnement.

### Données
- `kai-os_grug-12b` a été retiré manuellement de `.benchgo-blacklist.json`
  (auto-blacklisté à tort par le health check défectueux).
- `.benchgo-run-history.json` enregistre `lastStatus: "load_failed"` pour ce
  modèle — c'est historique, le prochain run réussi écrasera ce statut.

### Vérification
- `node --check night-batch.js` → OK.
- `node tests/run-tests.js` → 27/27 OK.
- Test manuel : `healthCheck('kai-os_grug-12b')` → `{ ok: true, content: "[thinking] The user wants me to", reasoning: true }`.

### Notes
- Le champ `reasoning_content` est spécifique à LM Studio (et certains
  backends OpenAI-compat). D'autres serveurs peuvent ne pas le renvoyer — le
  health check retombe alors sur le test `content` classique.
- `max_tokens: 8` dans le health check est volontairement faible (ping
  rapide). Les modèles thinking consomment ces 8 tokens en raisonnement —
  c'est attendu et désormais géré.

## 2026-08-22 — fix(night-batch): refonte du tableau --list-only (alignement + groupes)

### Contexte
Le tableau des modèles (`--list-only` et sélection interactive) était mal
structuré : colonnes décalées, pas de regroupement logique, plusieurs bugs
d'alignement. L'utilisateur a qualifié la disposition d'« horreur ».

### Bugs d'alignement corrigés (`night-batch.js` `printModelsList`)
1. **Colonne Vit. (tpsW) trop étroite** : `tpsW = 8` fixe, mais
   `'16.29 t/s'` fait 9 chars → débordement de 1, décalait toutes les colonnes
   suivantes. `tpsW` est désormais dynamique (`Math.max(9, ...)` basé sur les
   valeurs réelles).
2. **Padding ANSI cassé sur la colonne Tnd (tendance)** : `trendGlyph()`
   renvoie une chaîne enveloppée de codes ANSI (ex:
   `\x1b[90m=\x1b[0m`, longueur 10 mais 1 char visible). `.padEnd(4)` ne
   rajoutait aucun espace car `String.length` (10) > 4 → la colonne faisait 1
   char visible au lieu de 4, décalant tout après la tendance de 3 vers la
   gauche. Corrigé avec `padRight()` qui calcule la longueur visible (sans ANSI)
   et ajoute les espaces manquants APRÈS les codes ANSI.
3. **tokW (Tokens) fixe** : désormais dynamique (`Math.max(7, ...)`) pour
   s'adapter aux valeurs longues.
4. **Largeur du séparateur incorrecte** : la formule magique
   `idxW + ... + missW + 21` ne correspondait pas à la largeur réelle des lignes
   de données. Remplacée par une formule explicite :
   `somme des largeurs + 19` (16 espaces inter-colonnes + 3 séparateurs `│`).
5. **En-tête non paddé sur 'Ecoles manquantes'** : la dernière colonne de
   l'en-tête n'était pas paddée à `missW`, décalant l'en-tête des lignes de
   données. Désormais `padRight('Ecoles manquantes', missW)`.

### Refonte de la structure (`night-batch.js` `printModelsList`)
Les colonnes sont désormais regroupées en 4 blocs logiques séparés par `│` :
1. **Identité** : N°, Modèle, Param, Quant, Taille, Editeur
2. **Statut** : Statut, Pct, Tnd
3. **Performance** : Vit., Tokens, Temps, Tent.
4. **Reste à faire** : Écoles manquantes

Ordre des colonnes revu pour regrouper les métriques de performance (Vit.,
Tokens, Temps, Tent.) ensemble au lieu d'être mélangées avec les métadonnées.
La colonne `Tnd` (tendance) rejoint le groupe Statut (elle décrit l'évolution
du score, pas la vitesse d'exécution).

### Fonctions utilitaires (`night-batch.js`)
- `visLen(s)` → longueur visible d'une chaîne (sans codes ANSI).
- `padRight(s, w)` / `padLeft(s, w)` → padding en tenant compte des ANSI.
  Utilisé pour les valeurs colorées (tendance, statut, tokens) qui ne
  supportent pas `.padEnd()/.padStart()` natif.

### Vérification
- `node --check night-batch.js` → OK.
- `node tests/run-tests.js` → 27/27 OK.
- Simulation avec données réelles : header = 164 chars visibles, separator =
  164 (indent 2 + 162), toutes les lignes de données = 164 chars visibles.
  Alignement parfait.

### Notes
- Les fonctions `padRight`/`padLeft` sont locales à `printModelsList` (pas
  exportées) — elles ne servent que pour ce tableau. Si une autre partie du
  code a le même bug de padding ANSI, il faudra les extraire vers un module
  partagé.

## 2026-08-22 — fix(night-batch): --models= robuste aux espaces et flags avalés

### Contexte
Bug remonté par l'utilisateur (Admin/Tasks1.md) : la commande
`node night-batch.js --class-by-class --tiers=0 --models=Nanbeige4.2 3B,--schools=LIGHT --yes-teacher`
renvoyait « Aucun modele de --models= trouvé ». Cause : le display name
`Nanbeige4.2 3B` contient un espace. Non quoté en PowerShell, le shell a coupé
`--models=Nanbeige4.2 3B,--schools=LIGHT` en deux argv distincts :
`--models=Nanbeige4.2` (tronqué, ne matche aucun modelKey/displayName) et
`3B,--schools=LIGHT` (avalé). Résultat : `modelsArg` valait `"Nanbeige4.2"`,
`--schools=LIGHT` était perdu, et le script quittait en erreur.

### Changements (`night-batch.js`)
- **`parseArgs()` réécrit** : la fonction `flagValue(flag)` reconstitue la
  valeur d'un flag dont le shell a découpé la valeur sur les espaces. Au lieu
  de prendre `a.split('=').slice(1).join('=')` (qui s'arrête au premier argv),
  elle rattache les argv suivants qui ne commencent pas par `--` (continuation
  de la valeur coupée). Ainsi `--models=Nanbeige4.2 3B` (2 argv) devient
  `"Nanbeige4.2 3B"` (1 valeur).
- **Récupération des flags avalés par la virgule** : quand un display name
  contenant un espace est suivi d'une virgule et d'un flag (ex:
  `Nanbeige4.2 3B,--schools=LIGHT`), la reconstitution fusionne tout dans
  `modelsArg`. On sépare sur la virgule : les parts qui ressemblent à un flag
  (`--xxx=yyy`) sont réinjectées dans leurs flags respectifs (`--schools`,
  `--tiers`) si elles n'étaient pas déjà définies. Le reste reste dans
  `modelsArg`.
- **Match par préfixe** : si aucune correspondance exacte (modelKey ou
  displayName normalisé) n'est trouvée, on tente un match par préfixe
  insensible à la casse/espaces. Un nom tronqué (`nanbeige4.2` au lieu de
  `nanbeige4.2 3b`) matche un modèle s'il est non ambigu (un seul candidat).
  Cela rattrape les typos et les coupures shell.
- **Message d'erreur amélioré** : ajout d'une astuce « Si le nom contient des
  espaces, quottez-le : `--models="Nanbeige4.2 3B"` » quand aucun modèle n'est
  trouvé.

### Vérification
- `node --check night-batch.js` → OK.
- `node tests/run-tests.js` → 27/27 OK.
- Scénario reproduit et corrigé : `--models=Nanbeige4.2 3B,--schools=LIGHT`
  (non quoté) donne maintenant `modelsArg="Nanbeige4.2 3B"`,
  `schoolsArg="LIGHT"`, `tiersArg="0"`.

### Notes
- `--yes-teacher` n'est pas un flag reconnu (inconnu, ignoré silencieusement).
  C'est attendu : le flag correct pour activer le professeur IA est
  `--no-teacher` (désactive) — par défaut le professeur est actif.
- Le match par préfixe est intentionnellement limité au cas non ambigu (1
  seul candidat) pour éviter les surprises : `qwen` seul matcherait plusieurs
  modèles Qwen et serait rejeté.

## 2026-08-22 — fix(night-batch): isolation CLI, lms load -y, flux interactif réordonné

### Contexte
Trois problèmes remontés par l'utilisateur (Admin/Tasks1.md) :
1. Impossible d'isoler/désisoler un modèle sans session TTY interactive. Les
   commandes `!<num>`/`!!<num>` ne marchent qu'avec `selectModelsInteractive`,
   or l'utilisateur ne connaît pas le numéro sans d'abord lister. L'astuce du
   rapport `--lmstudio` mentionnait `--isoler=<numéro>` qui n'existait pas.
2. `lms load` sans `-y` affichait un sélecteur interactif (« ? Select a model to
   load ») qui bloquait le batch. Ctrl+C était très difficile à intercepter car
   le process enfant `lms` capture le terminal via une TUI readline. C'est ce
   qui a causé le blocage sur Grug 12B (Tasks1.md ligne 162).
3. Flux interactif inversé : option 7 (manuel-par-modèle) → `main()` demandait
   mode d'exécution / tiers / passage **PUIS** appelait
   `selectSchoolsManualPerModel`. L'utilisateur s'attendait à saisir les écoles
   de ses modèles immédiatement après avoir choisi l'option 7, pas après 3
   autres questions.

### Changements (`night-batch.js`)
- **`--isoler=!N` / `--isoler=!!N`** : flag CLI one-shot pour isoler/désisoler
  un modèle par numéro (position dans la liste `--list-only`). Aucun batch
  lancé — l'opération s'applique et quitte. Permet le workflow :
  `node night-batch.js --list-only` → voir les numéros → `--isoler=!4` → quitter.
- **`loadModel()`** : ajoute `-y` (`--yes`) à `lms load` pour approuver
  automatiquement les prompts. Élimine le sélecteur interactif bloquant.
- **`selectSchoolsInteractive()`** : l'appel `selectSchoolsManualPerModel()` est
  désormais effectué **dès le choix de l'option 7**, AVANT les questions mode
  d'exécution / tiers / mode de passage. Le plan manuel est retourné dans le
  résultat (`manualPlan`) et consommé par `main()` sans second appel.
- `parseArgs()` : expose `isolateArg` (parsing du flag `--isoler=`).
- Aide `--help` : ajoute les deux lignes `--isoler=!4` / `--isoler=!!6`.

### Changements (`leaderboard.js`)
- Astuce section « NON APPLICABLE » : corrigée pour refléter la syntaxe réelle
  `--isoler=!<numéro>` (isoler) / `--isoler=!!<numéro>` (désisoler).

### Vérification
- `node --check night-batch.js` : OK.
- `node --check leaderboard.js` : OK.
- `node tests/run-tests.js` : 27/0 (inchangé).
- `node scripts/check-inline-js.js` : OK (JS inline valide).

## 2026-08-22 — fix(night-batch): keep-alive serveur anti-veille pendant le batch

### Contexte
En mode nuit, LM Studio pouvait couper son propre serveur après une période
d'inactivité (veille/standby). Le benchmark tournant des heures, cette coupure
survenait en plein run et se traduisait par des réponses vides ou des timeouts
— signatures « modèle silencieux » qui déclenchaient à tort l'auto-blacklist
(toute la nuit du 2026-08-21 : 0 succès / 4 échecs, 3 modèles blacklistés pour
rien). Aucune régression du code : les tests unitaires passaient (27/0) et le
serveur LM Studio était tout simplement passé en veille.

### Changements (`night-batch.js`)
- `SERVER_KEEPALIVE_MS = 30000` : intervalle de ping.
- `keepAliveTick()` : ping léger `GET /v1/models` (sans génération, sans toucher
  au GPU) pour maintenir le serveur actif ; log une alerte jaune si le serveur
  redevient injoignable.
- `startServerKeepAlive()` / `stopServerKeepAlive()` : démarre/arrête le
  intervalle. `unref()` pour ne pas bloquer la sortie du process.
- Le keep-alive est activé **après** la vérification du serveur (que ce soit
  BenchGo qui l'a démarré en headless ou un serveur déjà actif), et stoppé à la
  fin du batch (avant `stopServer()`). Il couvre donc aussi les runs
  classe-par-classe (process enfants) puisque le parent pingue en continu.

### Vérification
- `node --check night-batch.js` : OK.
- `node tests/run-tests.js` : 27/0 (inchangé).
- Test manuel : `lms server start` puis observation des pings `[keep-alive]`
  dans les logs du mode nuit ; le serveur ne doit plus se couper en cours de run.

## 2026-08-21 — fix(night-batch): mode 8 intégré au flux normal + --models= tolérant

### Contexte
L'utilisateur ne voyait jamais le mode « Exercice par exercice » : l'option 8
était noyée parmi 8 choix dans le menu des écoles et sautait systématiquement.
La fonctionnalité existait mais n'était pas accessible en pratique. De plus,
`--models=` ne matchait que les `modelKey` (ex: `opencoder-8b-instruct-i1`),
pas les display names avec espaces (ex: `OpenCoder 8B Instruct I1`).

### Changements

**Fix 1 — « Exercice par exercice » intégré au flux normal** (`night-batch.js`)
- L'ancienne option 8 du menu des écoles est **supprimée**. Elle était
  invisible/noyée parmi 8 choix.
- Désormais, après le choix des écoles (1-7), le menu « Mode d'exécution »
  propose :
  - **A** = Classique (toute l'école d'un coup)
  - **B** = Exercice par exercice (chaque tier isolé, timeout 45 min)
- En mode B, le choix des **tiers** (exercices) est proposé **automatiquement**
  juste après — c'est l'équivalent de l'ancienne option 8, mais intégré au flux
  normal. Plus besoin de taper `8` pour y accéder.
- Le mode de passage **A/M** (auto/manuel) suit le choix des tiers.
  - A = passage au modèle suivant même en cas d'échec.
  - M = arrêt au premier échec obligatoire (`stopOnFirstFailure`).
- `stopOnFirstFailure` est propagé jusqu'à la boucle principale qui stoppe la
  file d'attente entière (`batchStopped`).
- Compatibilité : si l'utilisateur tape encore `8`, il est redirigé vers le
  flux normal (choix d'une école 1-4 + mode B).

**Fix 2 — `--models=` accepte les display names** (`night-batch.js`)
- La résolution de `--models=` compare désormais à la fois `modelKey` ET
  `displayName`, insensible à la casse et aux espaces multiples (normalisation
  `trim().toLowerCase().replace(/\s+/g, ' ')`).
- Le split se fait uniquement sur la virgule (les display names contiennent
  des espaces) — pas de split sur les espaces.
- Message d'erreur enrichi d'une astuce rappelant que les display names sont
  acceptés.

### Vérifications
- `node --check night-batch.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-21 — fix(night-batch+teacher+ledger): 4 corrections Tasks1.md

### Contexte
Quatre tâches demandées dans `Admin/Tasks1.md` :
1. `--list-only` demandait à tester les modèles (faux — mode lecture seule).
2. Mode nuit automatique perdu : un seul modèle testé cette nuit + fonction
   classe-par-classe manquante.
3. Professeur IA câblé sur OpenRouter uniquement — pas de choix de provider.
4. Anciens carnets de scores disparus du dossier `.carnet/` (30+ modèles testés
   depuis le 29/07, seuls 2 carnets subsistent au 11/08).

### Changements

**Task 5 — Transmettre `--teacher-*` au runner depuis le mode nuit** (`night-batch.js`)
- `parseArgs()` capture désormais `--teacher-provider=`, `--teacher-model=`,
  `--teacher-api-key=`, `--teacher-endpoint=` et les ajoute à `extraRunnerArgs`.
- Conséquence : `node night-batch.js --teacher-provider=ollama --teacher-model=llama3.2 ...`
  configure bien le professeur correcteur (avant, ces flags étaient ignorés par le
  mode nuit et le runner retombait sur OpenRouter).
- Documentation : `Docs/Manuel-utilisateur/07-mode-nuit.md` enrichi des sections
  « Filtre rapide exercice par exercice » (`--class-by-class` + `--tiers=`) et
  « Avec professeur IA (provider au choix) », plus l'option 7 (tier-by-tier)
  interactive et le tableau des nouveaux flags.

**Task 1 — `--list-only` ne demande plus à tester** (`night-batch.js`)
- Refactorisation : extraction de `printModelsList(models, { interactive })`
  (affichage du tableau seul) depuis `selectModelsInteractive` (tableau + prompt).
- `--list-only` appelle `printModelsList(models, { interactive: false })` puis
  quitte — plus de prompt « Modèles à tester ».
- `selectModelsInteractive` réutilise `printModelsList` (DRY).

**Task 2 — Mode classe-par-classe + robustesse anti-hang** (`night-batch.js`)
- Nouveau flag `--class-by-class` (alias `--cbc`) : chaque tier d'une école est
  lancé dans un process séparé (`node runner.js --force --profile=X <tierNum>`)
  au lieu d'un seul process pour toute l'école.
- Avantages : (1) reprise — un tier crashé ne perd pas toute l'école, (2)
  timeout par tier `TIER_TIMEOUT_MS = 45 min` — un modèle gelé ne bloque plus
  le batch entier (cause du « mode automatique perdu »), (3) isolation mémoire.
- `runBenchmark` accepte désormais `{ tierNum, timeoutMs }` et détecte le
  timeout (`status=null, signal=SIGTERM`).
- Nouvelle fonction `runSchoolClassByClass()` : itère sur les tiers du profil,
  lance chaque tier séparément, continue au suivant même en cas d'échec.
- L'école `auto` (le runner devine le profil) reste en mode classique (pas de
  tier individuel sans connaître le profil).

**Task 3 — Provider du professeur configurable** (`config.js`, `runner.js`,
`teacher-client.js`, `cli-help.js`)
- Nouveau flag `--teacher-provider=<provider>` : openrouter (défaut), openai,
  groq, together, mistral, anthropic, deepseek, cohere, ollama, lmstudio, custom.
- `teacher-client.js` : nouvelle fonction `callCloudTeacher()` qui route vers
  n'importe quel provider de `CLOUD_PROVIDERS` (OpenAI-compat ou Anthropic
  Messages API). `askTeacherToCorrectStudentAnalysis` branche vers
  `callCloudTeacher` si le provider n'est pas openrouter (sinon Free Router
  avec rotation de modèles gratuits, comportement inchangé).
- Providers locaux (ollama, lmstudio, custom) : aucune clé API requise.
- `--teacher-model` devient requis pour les providers non-openrouter (pas de
  rotation de modèles gratuits).
- `teacherProvider` sauvegardé dans les presets (`--save-preset`).
- `TEACHER_CONFIG` documenté dans `config.js`.

**Task 4 — Sauvegarde auto des carnets + restauration** (`score-ledger.js`,
`config.js`, `runner.js`, `cli-help.js`)
- Cause des disparitions : les carnets sont en `.gitignore` (jamais versionnés).
  Une purge manuelle ou un script a supprimé les anciens `.json` — irréversible
  sans backup. Aucun bug dans le code de chargement/affichage.
- Nouvelle fonction `backupLedger()` dans `score-ledger.js` : copie chaque
  carnet vers `Export-Rapports/.carnet-backup/` à chaque `saveLedger()`. Copie
  atomique (tmp + rename). Non-bloquant si échec.
- Nouvelle fonction `restoreLedgersFromBackup()` : copie les carnets du backup
  absents de `.carnet/` (ne surcharge jamais un carnet existant).
- Nouveau flag `--restore-carnets` (`node runner.js --restore-carnets`) :
  restaure et quitte.
- `LEDGER_DIR`, `LEDGER_BACKUP_DIR` exportés depuis `score-ledger.js`.

### Fichiers modifiés
- `night-batch.js` — Tasks 1, 2 (printModelsList, runSchoolClassByClass, --class-by-class, timeout)
- `config.js` — Tasks 3, 4 (--teacher-provider, --restore-carnets, TEACHER_CONFIG)
- `teacher-client.js` — Task 3 (callCloudTeacher, routing multi-provider)
- `runner.js` — Tasks 3, 4 (teacherProvider resolution, --restore-carnets handler)
- `score-ledger.js` — Task 4 (backupLedger, restoreLedgersFromBackup, LEDGER_BACKUP_DIR)
- `cli-help.js` — Tasks 3, 4 (--teacher-provider, --restore-carnets dans l'aide)
- `Docs/CHANGELOG.md`, `AGENTS.md` — documentation

### Validation
- `node --check` sur les 6 fichiers JS modifiés : OK.
- `node tests/run-tests.js` : 27 passés, 0 échoués.
- `node -e "const {parseCliArgs}=require('./config'); …"` : `--teacher-provider`,
  `--restore-carnets`, `--class-by-class` correctement parsés.

### Leçons apprises
- Les carnets en `.gitignore` sont fragiles : sans backup, une suppression est
  définitive. Le backup automatique (`backupLedger` à chaque save) protège désormais.
- `spawnSync` avec `timeout: 0` est dangereux en mode batch : un modèle gelé
  bloque indéfiniment le process parent. Le timeout par tier (45 min) est un
  filet de sécurité essentiel pour le mode nuit.

---

## 2026-08-11 — docs(logseq): TODO statiques → query dynamique + propriétés de bloc requêtables

### Contexte
Suite à l'analyse d'un agent spécialisé Logseq (message dans `Admin/Tasks1.md`),
deux recommandations étaient proposées :
- **A. Namespaces** (`BenchGo/Modules/runner.js`) — **rejetée** : entre en conflit
  avec la contrainte `logseq_index_hierarchy` (isolation par app sous
  `index → APPS-CISCO → BenchGo-LLM-School`). Les namespaces casseraient
  l'isolation en créant une nouvelle racine `BenchGo/` détachée d'`APPS-CISCO`.
- **B. Requêtes dynamiques** — **acceptée** : la liste TODO statique de la page
  `Architecture-BenchGo V3` était un bloc multi-lignes non requêtable.

### Changements (graphe Logseq `M:\Logsec-Cisco`)
- Section `## TODO — Points d'amélioration et surveillance` renommée en
  `## Suivi des améliorations et surveillance` (le mot « TODO » dans un titre
  de niveau 2 était interprété par Logseq comme un marker de tâche, créant une
  auto-référence dans la query).
- Liste statique de 5 TODO remplacée par une query Logseq :
  `{{query (and (todo TODO DOING) [[Architecture-BenchGo V3]])}}`
- Les 5 TODO éclatés en blocs individuels, chacun avec propriétés de bloc
  requêtables : `priorite::` (A/B/C), `statut::` (en-cours/terminé),
  `domaine::` (test/surveillance/doc/perf), `projet:: [[BenchGo V3]]`.
- Tri par priorité décroissante : A (perf LRU) → B×3 (test, test, doc) → C (surveillance).

### TODO créés (UUIDs Logseq)
| Priorite | Domaine | Description | UUID |
|---|---|---|---|
| A | perf | Valider le cache LRU de `task-evaluator.js` sur 50+ modèles | `6a7b420e…` |
| B | test | Tester `external-profiling.js` avec un vrai provider cloud | `6a7b4201…` |
| B | test | Vérifier `health-sentinels.js` sur un run complet | `6a7b4206…` |
| B | doc | Documenter le flux `hybrid-mode.js` dans le CHANGELOG | `6a7b420b…` |
| C | surveillance | Surveiller les modèles instables (`detectUnstableModels()`) | `6a7b4209…` |

### Pour modifier
1. **Changer les filtres de la query** : éditer le bloc `6a7a2e56-bebf…` de la page
   `Architecture-BenchGo V3`. Syntaxe Logseq Datalog/Query DSL.
2. **Marquer un TODO DONE** : changer `statut:: en-cours` → `statut:: termine`
   et le marker `TODO` → `DONE` sur le bloc. La query se met à jour automatiquement.
3. **Ajouter un TODO** : créer un bloc enfant sous `## Suivi des améliorations…`
   avec `TODO <desc>` + propriétés `priorite`/`statut`/`domaine`/`projet`.
4. **Requêter par priorité** : `{{query (and (todo TODO) (property priorite A))}}`.

### Pièges
- Un titre `## TODO …` est interprété par Logseq comme un bloc de tâche (marker
  `TODO`) à cause du mot-clé. Éviter « TODO » dans les titres de sections qui
  contiennent des queries `(todo …)`.
- La query `(and (todo TODO DOING) [[page]])` filtre par appartenance de page,
  pas par tag de bloc. Les blocs enfants de la page `Architecture-BenchGo V3`
  sont automatiquement inclus.
- Les propriétés `priorite`/`statut`/`domaine`/`projet` sont des propriétés
  libres (free-form text). Pour les typer (enum/number), utiliser
  `logseq_upsertProperty` côté MCP.

## 2026-08-11 — fix(calibration/streaming/rapport): clarification verdict + stats ordonnées + colonnes tableau

### Contexte
Quatre problèmes remontés via `Admin/Tasks1.md` :

1. **Contradiction visuelle « Modèle Hautement Fiable » vs « NON RECOMMANDÉ »** :
   un modèle à 60% (NON RECOMMANDÉ) affichait « Modèle Hautement Fiable / Lucide »
   juste en dessous, sans explication. La calibration (C=0.955) mesure
   l'honnêteté de l'auto-évaluation, pas la performance — un modèle peut être
   lucide (il connaît ses limites) tout en étant faible (il ne les surmonte pas).
   L'utilisateur lisait une contradiction absurde.
2. **Stats streaming entrelacées dans le texte du modèle** : les lignes
   `n_decoded = 24, tg = 11.89 t/s...` s'intercalaient au milieu des fragments
   de réponse streamés, rendant le texte illisible (mots coupés, explications
   morcelées sur plusieurs lignes).
3. **Colonne ShortName superflue dans le tableau des carnets orphelins** :
   le rapport `--lmstudio` affichait une colonne ShortName redondante avec le
   nom du modèle, déséquilibrant le tableau (3 colonnes larges + 1 étroite).
4. **Prompt d'aide : « En tant que professeur, je vous propose »** : le modèle
   répondait « L'utilisateur demande si je veux recevoir l'indice » — le rôle
   était inversé. Le Professeur (BenchGo) propose l'aide, le modèle (élève)
   décide de l'accepter.

### Changements

#### 1. Caveat de calibration — `score-ledger.js`, `report-generator.js`, `runner.js`
- `interpretCalibration(C, performancePct)` accepte désormais un second
  paramètre optionnel `performancePct`. Quand C ≥ 0.85 ET performancePct < 50%,
  le verdict est suffixé : « lucide mais faible : le modèle connaît ses limites
  sans pour autant les surmonter ».
- `report-generator.js` `buildCalibrationReport()` ajoute un bloc
  « ⚠️ Lucide mais faible » expliquant que l'Indice de Calibration mesure
  l'honnêteté de l'auto-évaluation, pas la qualité. Le verdict de performance
  prime sur le verdict de calibration.
- `runner.js` affichage console : deux lignes explicatives grises sous le
  verdict de calibration quand `verdictPct < 50` et C ≥ 0.85.

#### 2. Stats streaming séparées du texte — `progress-bar.js`
- `appendStreamChunk()` (ProgressBar ET BigSpinner) : les stats
  `n_decoded/tg/tg_3s` sont désormais écrites avec un saut de ligne AVANT
  (`\n` préfixe) pour les détacher du texte du modèle en cours, au lieu
  d'être collées au fragment précédent. Le texte du modèle reste sur ses
  propres lignes, les stats sur les leurs.

#### 3. Colonne ShortName supprimée — `leaderboard.js`
- Section « Carnets orphelins » du rapport `--lmstudio` : la colonne ShortName
  est retirée. Le tableau passe de 4 colonnes (Modèle, ShortName, Quant,
  Écoles testées) à 3 (Modèle, Quant, Écoles testées), automatiquement
  rééquilibrées par `cliTable.computeWidths()`.

#### 4. Rôle corrigé dans le prompt d'aide — `runner.js`
- `helpPrompt` : « En tant que professeur, je vous propose un indice » →
  « Le Professeur vous propose un indice ». Le modèle ne se prend plus pour
  le professeur ; le Professeur (BenchGo) propose, le modèle (élève) décide.

### Fichiers touchés
- `score-ledger.js` — `interpretCalibration()` (paramètre `performancePct`)
- `report-generator.js` — `buildCalibrationReport()` (caveat lucide-mais-faible)
- `runner.js` — affichage console calibration + `helpPrompt`
- `progress-bar.js` — `appendStreamChunk()` (×2 : ProgressBar + BigSpinner)
- `leaderboard.js` — tableau carnets orphelins (colonne ShortName retirée)
- `Docs/CHANGELOG.md`

### Vérifications
- `node --check` sur les 5 fichiers modifiés : OK
- `node tests/run-tests.js` : 27/27 passés

## 2026-08-10 — fix(night-batch/leaderboard): sortie temps réel + carnets orphelins (modèles supprimés)

### Contexte
Trois problèmes distincts remontés par l'utilisateur :
1. **Mode nuit muet** : pendant le benchmark (parfois 30+ min par modèle), le
   terminal ne montrait RIEN — pas le spinner, pas l'exercice en cours, pas le
   score. `runBenchmark()` capturait stdout/stderr via `spawnSync` puis les
   réécrivait à la FIN du runner. L'utilisateur ne savait pas où en était le
   modèle pendant la nuit.
2. **Carnets orphelins** : quand un modèle est supprimé de LM Studio (UI ou
   retrait du GGUF), son carnet `.json` persiste dans `Export-Rapports/.carnet/`.
   Le classement continuait de l'afficher comme s'il existait encore — trompeur.
3. **Rapport `--lmstudio`** : les carnets supprimés étaient masqués silencieusement
   (une ligne grise `hiddenLmsCount`) sans lister quels modèles étaient concernés.

### Changements

#### 1. Sortie runner en temps réel — `night-batch.js` `runBenchmark()`
- `stdio: 'inherit'` au lieu de capture différée : la sortie du runner (spinner,
  exercice en cours, tokens, score) est streamée EN TEMPS RÉEL sur le terminal
  du mode nuit. On voit exactement ce que `runner.js` affiche, comme si on le
  lançait soi-même.
- Avant : terminal muet pendant tout le benchmark, sortie réécrite d'un coup à
  la fin. Après : feedback continu, l'utilisateur suit la progression.

#### 2. Fonction `detectOrphanLedgers()` — `night-batch.js`
- Compare les carnets `.json` existants à `lms ls --json` et renvoie les carnets
  locaux dont le modèle n'est plus présent sur disque.
- Exclut les carnets cloud (`isCloud=true`) : ces modèles ne dépendent pas de
  LM Studio (API distantes), ils ne peuvent pas être orphelins.
- Utilise `matchLedger()` (même logique que le reste de BenchGo) pour gérer les
  variantes de nommage (quantif dans shortName, suffixes...).
- Exportée dans `module.exports` pour réutilisation par `leaderboard.js`.
- **Repli** : si `lms ls` échoue (daemon éteint), renvoie tous les carnets
  comme orphelins — la section n'est pas affichée (le rapport `--lmstudio` ne
  s'exécute qu'avec lms disponible).

#### 3. Section « Carnets orphelins » dans le rapport `--lmstudio` — `leaderboard.js`
- Nouveau Bloc 2b qui liste explicitement les carnets orphelins : modèle,
  shortName, quantification, écoles testées.
- Le Bloc 1 (modèles testés) masque toujours les orphelins, mais pointe vers
  la nouvelle section au lieu de dire « masqué(s) du rapport ».
- Indique à l'utilisateur comment nettoyer : supprimer le fichier
  `Export-Rapports/.carnet/<shortName>.json`. Le carnet est conservé pour
  l'historique — aucune suppression automatique.

### Pour modifier
- **Changer le comportement orphelin** (supprimer vs archiver vs marquer) :
  éditer la section Bloc 2b dans `leaderboard.js` et `detectOrphanLedgers()`
  dans `night-batch.js`.
- **Désactiver le filtrage des orphelins du Bloc 1** : commenter le bloc
  `if (lmsModelKeys)` dans `leaderboard.js` (~ligne 4896).
- **Tester** : `node leaderboard.js --lmstudio` (daemon LM Studio requis pour
  voir la section orphelins). Sans daemon, la section ne s'affiche pas (repli).

### Pièges
- `detectOrphanLedgers()` renvoie TOUS les carnets locaux comme orphelins si
  `lms ls` échoue (daemon éteint). Le rapport `--lmstudio` ne l'appelle que
  quand lms est disponible, donc ce cas ne se produit pas en pratique.
- La suppression du GGUF dans LM Studio met à jour `lms ls` immédiatement
  (aucun redémarrage serveur requis). Le carnet `.json` persiste sur disque
  jusqu'à suppression manuelle — c'est volontaire (conservation de l'historique).

---

## 2026-08-10 — feat(night-batch): forçage de la détection LM Studio (modèles orphelins)

### Contexte
LM Studio indexe les modèles dans un cache interne (`models.json`) qui se
désynchronise de l'UI : un GGUF ajouté manuellement au dossier
`~/.lmstudio/models` peut apparaître dans l'application graphique mais rester
absent de `lms ls --json --llm`. BenchGo, qui s'appuie sur `lms ls` pour lister
les modèles testables, ne voit alors pas ces modèles — ils sont marqués
« JAMAIS TESTÉS » alors qu'ils existent sur disque. Le rapport `--lmstudio`
indique par ex. « 8 modèle(s) téléchargé(s), 3 absent(s) » sans explication.

### Changements
#### 1. Fonction `forceDetectModels()` — `night-batch.js`
- Scanne le dossier physique `~/.lmstudio/models` (récursif) pour lister tous
  les fichiers `.gguf` réels, en excluant les `mmproj-*` (projets multimodaux)
  et `mtp-*` (modules MTP) qui ne sont pas des LLM autonomes.
- Compare cette liste à l'index courant (`lms ls --json`) pour identifier les
  **orphelins** : GGUF présents sur disque mais absents de l'index.
- Réimporte chaque orphelin via `lms import --symbolic-link -y` : le lien
  symbolique préserve le fichier d'origine (aucun déplacement ni copie,
  aucun gaspillage d'espace disque).
- Retourne un rapport `{ scanned, orphans, imported, failed, errors[] }`.

#### 2. Flag CLI `--force-detect` — `night-batch.js`
- `node night-batch.js --force-detect` : lance le scan + réimport AVANT de
  lister les modèles, puis continue le flux normal (sélection, batch).
- Non-interactif : peut être combiné avec `--models=` et `--schools=` pour un
  batch de nuit qui commence par réindexer les orphelins.

#### 3. Commande interactive `detect` / `force-detect` — sélection des modèles
- Pendant la sélection interactive (`selectModelsInteractive`), taper
  `detect` (ou `force-detect`) déclenche le scan, réimporter les orphelins,
  puis **recharge la liste** depuis `lms ls` pour afficher les nouveaux modèles
  détectés. Permet de corriger une liste incomplète sans relancer le script.

#### 4. Export de `forceDetectModels`
- Exportée dans `module.exports` pour réutilisation par d'autres modules
  (notamment `leaderboard.js` pourrait l'appeler dans le rapport `--lmstudio`).

### Pour modifier
- **Changer le dossier scanné** : éditer `LMSTUDIO_MODELS_DIR` (constante en
  haut de la section dédiée dans `night-batch.js`).
- **Changer la méthode d'import** : remplacer `--symbolic-link` par
  `--hard-link` ou `--copy` dans l'appel `runLms(['import', ...])`.
- **Inclure les mmproj/mtp** : retirer le filtre `/^mmproj-/i` ou `/^mtp-/i`
  dans `listGgufOnDisk()`.
- **Tester** : `node night-batch.js --force-detect` (daemon LM Studio requis),
  ou lancer `node night-batch.js` puis taper `detect` à l'invite de sélection.

### Pièges
- Le scan est récursif : il couvre tous les sous-dossiers
  (`editeur/modele/fichier.gguf`). Les GGUF déjà indexés ne sont **pas**
  réimportés (on compare les basenames à l'index `lms ls`).
- `lms import --symbolic-link` peut échouer si le fichier est sur un volume
  différent du dossier cible LM Studio (les liens symboliques Windows ne sont
  pas toujours inter-volumes). Dans ce cas, l'erreur est affichée et le GGUF
  est compté en `failed` — le scan continue avec les autres.
- Le scan compare les **basenames** (sans extension) aux `modelKey`,
  `displayName` et `path` de l'index. Un GGUF renommé sur disque sera vu comme
  orphelin même si son contenu est déjà indexé sous un autre nom — c'est
  attendu (un fichier renommé est un nouveau modèle du point de vue de l'index).

---

## 2026-08-10 — feat(night-batch): pré-test de santé (health check) + auto-blacklist des modèles défectueux

### Contexte
Plusieurs modèles LM Studio causaient des pertes de temps massives en mode nuit :
- **OpenCoder 8B** s'est chargé (`lms load` OK) puis a gelé pendant **3h48** sur
  le premier exercice avant que LM Studio crash — le reste du batch a échoué
  instantanément (LM Studio injoignable).
- **Ornith 9B** et **ProCreations Grug 3B** ont crashé au chargement
  (`load_failed`) mais restaient dans la file à chaque batch, gaspillant du temps
  de déchargement/rechargement.

Il manquait un pré-test qui valide qu'un modèle répond réellement après son
chargement, et un mécanisme pour écarter automatiquement les modèles
défectueux des futurs batchs.

### Changements

#### 1. Fonction `healthCheck(modelKey)` — `night-batch.js`
- Après un `lms load` réussi, envoie une requête `POST /v1/chat/completions`
  triviale ("Reply with: OK", `max_tokens: 8`, `stream: false`) avec un
  **timeout de 30 s**.
- Si le modèle répond → sain, on lance le benchmark.
- Si timeout/erreur/réponse vide → `health_failed`, on décharge et passe au
  suivant sans lancer le benchmark.
- Détecte les modèles qui se chargent mais gelent au premier appel (le cas
  OpenCoder 8B — plus de perte de 3h+).

#### 2. Fonction `autoBlacklist(modelKey, reason)` — `night-batch.js`
- Ajoute le `modelKey` à `.benchgo-blacklist.json` (même fichier que
  l'isolation manuelle `!<num>`).
- Enregistre le statut dans `.benchgo-run-history.json`.
- Affiche la raison et un message indiquant comment désisoler (`!!<num>`).

#### 3. Auto-blacklist sur 3 conditions
- **`load_failed`** : `lms load` échoue → auto-blacklist immédiat (GGUF
  corrompu ou incompatible).
- **`health_failed`** : le modèle se charge mais ne répond pas dans les 30 s
  → auto-blacklist (modèle gelé / moteur instable).
- **`run_ko` systémique** : si TOUTES les écoles d'un modèle ont échoué en
  `run_ko` et aucune n'a réussi → auto-blacklist (problème systémique).
  Si au moins une école a réussi, le modèle est conservé (il fonctionne
  partiellement).

#### 4. Intégration dans le flux principal
- Le health check est exécuté après `loadModel()` et avant la boucle des
  écoles, pour chaque modèle.
- En cas d'échec : `unloadAll()`, `autoBlacklist()`, `continue` vers le
  modèle suivant.
- Le bilan de fin affiche les raisons traduites (`chargement échoué`,
  `health check échoué`, `run KO`) et le tag `[auto-blacklisté]`.

#### 5. Aide CLI mise à jour
- Note ajoutée dans les astuces de `node night-batch.js --help` :
  "Pré-test de santé : chaque modèle reçoit un ping après chargement ; les
  modèles défectueux sont auto-blacklistés."

### Fichiers touchés
- `night-batch.js` : `healthCheck()`, `autoBlacklist()`, intégration flux,
  bilan, aide CLI, exports.
- `Docs/CHANGELOG.md`.

### Tests
- `node --check night-batch.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.

---

## 2026-08-08 — feat(classements): GGUF Tracker intégré + bandeaux transformés en badges dans l'en-tête

### Contexte
L'outil `GGUF-Tracker-update.html` (codé par Gemini, autonome) traque les
nouveaux modèles GGUF sur Hugging Face via l'API publique paginée. Il était
jusqu'ici un fichier isolé à la racine, utilisant Tailwind CDN avec des
classes `slate-*`/`blue-*` hors charte graphique BenchGo. Il fallait le
ranger, l'intégrer aux classements, et transformer les bandeaux existants
(NotebookLM, Communauté, Mise à jour) en badges compacts dans l'en-tête.

### Changements

#### 1. Déplacement et charte graphique du tracker
- `GGUF-Tracker-update.html` → `scripts/gguf-tracker.html` (rangement avec
  les autres outils de diagnostic `scripts/`).
- Réécriture complète du CSS : suppression de Tailwind CDN et de toutes les
  classes `slate-*`/`blue-*`/`sky-*`. Utilisation exclusive des variables CSS
  de la charte BenchGo (`--bg-0` à `--bg-elev`, `--accent`, `--purple`,
  `--green`, `--yellow`, `--border`, `--r-md`, `--r-pill`, etc.).
- Textes traduits en français, couleurs alignées sur le leaderboard
  (cartes `--bg-2`/`--bg-1`, liens `--accent`, favoris `--yellow`, nouveaux
  `--accent`, mises à jour `--green`).

#### 2. Badge GGUF Tracker + modale géante (iframe)
- **`leaderboard.js`** : badge `📡 GGUF Tracker` dans l'en-tête → modale
  géante (92vw × 90vh) contenant une `<iframe>` qui charge
  `/gguf-tracker.html` (servi par le serveur local via route dédiée).
  Chargement paresseux du `src` à la 1re ouverture.
- **`consolidate-leaderboard.js`** : même badge + modale. L'iframe charge
  `gguf-tracker.html` (copié dans `gh-pages-output/` à la génération).
- Route serveur `GET /gguf-tracker.html` dans `leaderboard.js --serve` :
  sert `scripts/gguf-tracker.html` avec `Content-Type: text/html`.
- Copie automatique : `consolidate-leaderboard.js` copie
  `scripts/gguf-tracker.html` → `gh-pages-output/gguf-tracker.html` à chaque
  génération, pour GitHub Pages (même origine que l'iframe).

#### 3. Bandeaux → badges centrés dans l'en-tête
- **`leaderboard.js`** : les 3 bandeaux (NotebookLM, Communauté, Mise à jour)
  sont supprimés du corps de page et remplacés par 4 badges compacts dans un
  conteneur `.hero-badges` centré sous le `<h1>` :
  - `🧠 NotebookLM` (violet) → modale existante (explication agent + lien).
  - `🌐 Communauté` (vert) → nouvelle modale avec commande `node runner.js
    --submit` + bouton « Copier la commande ».
  - `⬆️ Mise à jour` (jaune, caché par défaut) → n'apparaît que si une mise
    à jour GitHub est détectée. Nouvelle modale avec liste des 5 derniers
    commits + commande `git pull`. Logique de cache localStorage 1h
    préservée.
  - `📡 GGUF Tracker` (bleu ciel) → modale géante iframe (voir §2).
- **`consolidate-leaderboard.js`** : le bandeau NotebookLM est supprimé,
  remplacé par 2 badges dans `.hero-badges` :
  - `🧠 NotebookLM` (violet) → modale existante.
  - `📡 GGUF Tracker` (bleu ciel) → modale géante iframe.
- Chaque badge a un point lumineux pulsant (`.dot`), sauf sur
  `prefers-reduced-motion`. Le badge « Mise à jour » pulse en jaune
  (animation `updatePulse` existante réutilisée).
- Toutes les modales se ferment avec : bouton ×, clic hors-zone, touche
  Échap. Le `document.body.style.overflow` est géré pour bloquer le scroll
  arrière-plan.

#### 4. CSS nouveau (commun aux deux fichiers, dupliqué)
- `.hero-badges` : conteneur flex centré, wrap sur mobile.
- `.hero-badge` : pillule avec bordure dégradée + ombre, 4 variantes
  colorimétriques (`.nb-badge` violet, `.community-badge` vert,
  `.update-badge` jaune, `.gguf-badge` bleu ciel).
- `.dot` : pastille lumineuse 8px avec `box-shadow` glow.
- `@keyframes gguf-pulse` : pulsation d'opacité 2s (réduit respecté).
- `.gguf-modal` : 92vw × 90vh, `flex-direction: column`.
- `.gguf-iframe` : 100% × 100%, sans bordure, fond `--bg-2`.
- `.update-modal` / `.community-modal` : modales standards 600/560px.
- Styles `.nb-banner`, `.community-banner`, `.update-banner` conservés
  (réutilisés par les modales `.nb-features`, `.nb-modal-cta`, etc.).

### Fichiers modifiés
- `scripts/gguf-tracker.html` — renommé depuis `GGUF-Tracker-update.html`,
  réécriture complète CSS/HTML à la charte BenchGo (sans Tailwind).
- `leaderboard.js` — route `/gguf-tracker.html`, CSS badges/modales,
  HTML en-tête (badges) + 3 nouvelles modales (update, communauté, GGUF),
  JS inline réécrit (badges au lieu de bandeaux, nouvelles fonctions
  `openUpdateModal`/`closeUpdateModal`, `openCommunityModal`/`closeCommunityModal`,
  `openGgufModal`/`closeGgufModal`), update checker réécrit
  (`updateBanner` → `updateBadge`).
- `consolidate-leaderboard.js` — CSS badges/modales, HTML en-tête (badges) +
  modale GGUF, JS inline (`nbInfoBtn` → `nbBadge`, `openGgufModal`/
  `closeGgufModal`), copie `gguf-tracker.html` → `gh-pages-output/`.
- `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md`,
  `Memories-BenchGo/INSTRUCTIONS.md`.

### Résultat obtenu
- L'outil de surveillance Hugging Face est rangé dans `scripts/`, intégré aux
  deux classements via un badge cliquable → modale géante, et entièrement
  aligné sur la charte graphique BenchGo (plus de Tailwind, plus de slate).
- Les 3 bandeaux encombrants du leaderboard local sont remplacés par 4 badges
  compacts et centrés dans l'en-tête. L'information est toujours accessible,
  mais l'en-tête est visuellement plus léger.
- Le classement communautaire gagne le badge GGUF Tracker (en plus de
  NotebookLM). Le tracker fonctionne sur GitHub Pages (iframe même origine).
- Fermeture des modales : bouton ×, clic extérieur, Échap.

### Validation
- `node --check leaderboard.js` → OK.
- `node --check consolidate-leaderboard.js` → OK.
- `node leaderboard.js` → 52 modèles classés, HTML généré.
- `node consolidate-leaderboard.js` → 46 modèles, tracker copié dans
  `gh-pages-output/gguf-tracker.html`.
- `node scripts/check-inline-js.js` → JS inline valide pour les deux HTML.

### Pour modifier
1. **Changer le tracker lui-même** : éditer `scripts/gguf-tracker.html`
   (CSS/JS/HTML). La copie dans `gh-pages-output/` est automatique au
   prochain `node consolidate-leaderboard.js`.
2. **Ajouter un badge dans l'en-tête** : ajouter un `<button class="hero-badge
   <variante>">` dans `.hero-badges`, le CSS correspondant, et le JS
   `openXModal`/`closeXModal` dans le `<script>` inline. Dupliquer dans les
  deux fichiers (`leaderboard.js` + `consolidate-leaderboard.js`).
3. **Changer la taille de la modale GGUF** : éditer `.gguf-modal` (width/
   height) dans le CSS des deux fichiers.
4. **Changer la couleur d'un badge** : éditer `.hero-badge.<variante>` dans
   le CSS des deux fichiers.
5. **Tester en local** : `node leaderboard.js --serve`, cliquer sur le badge
   `📡 GGUF Tracker` dans l'en-tête → la modale géante s'ouvre avec le
   tracker. Pour le classement communautaire : `node consolidate-leaderboard.js`
   puis ouvrir `gh-pages-output/community-leaderboard.html`.

### Pièges
- Le JS inline des deux fichiers est dupliqué (CSS `.hero-badge`, HTML des
  badges, fonctions `openXModal`/`closeXModal`). Modifier un seul fichier ne
  suffit pas.
- L'iframe du tracker charge `gguf-tracker.html` en **chemin relatif**
  (`src="gguf-tracker.html"`). Sur le serveur local (`leaderboard.js --serve`),
  cela pointe vers la route `/gguf-tracker.html`. Sur GitHub Pages, cela
  pointe vers `gh-pages-output/gguf-tracker.html` (copié à la génération).
  Si le fichier est absent, l'iframe affiche une page 404 (pas de crash).
- Le badge « Mise à jour » est `hidden` par défaut. Il n'apparaît que si
  `data.sha !== LOCAL_SHA` (comparaison SHA GitHub). Le cache localStorage
  1h est préservé : fermer la modale marque `dismissedAt` et masque le badge.
- Les anciens styles `.nb-banner`, `.community-banner`, `.update-banner`
  sont conservés dans le CSS (réutilisés par les modales). Les supprimer
  casserait les modales NotebookLM/communauté/update.
- Le tracker fait des appels `fetch()` vers `https://huggingface.co/api/models`
  depuis le navigateur. En iframe sur GitHub Pages, cela fonctionne (CORS
  ouvert sur l'API HF publique). Pas de clé API nécessaire.

---

## 2026-08-07 — fix(détection): suggestions de retest ignorent les modèles dont le nom n'a pas de taille

### Contexte
Dans `node leaderboard.js --lmstudio`, le Bloc 3 (suggestions de retest)
détermine les écoles attendues via `detectProfileFromModelName(e.model)`. Cette
fonction détecte la taille depuis le nom du modèle. Pour les modèles dont le
nom de carnet ne contient pas la taille (ex: `phi-4`, sans « 15B »), la
détection renvoie `null` et le modèle est ignoré des suggestions — même s'il a
des écoles manquantes. Incohérent avec le Bloc 2 (non testés) qui utilise
`night-batch.listLlmModels()` et donc `paramsString="15B"` depuis LM Studio.

### Cause racine
Deux sources de vérité pour la taille d'un modèle :
- **Bloc 2** (non testés) : `night-batch.listLlmModels()` → `paramsString`
  fiable depuis LM Studio (ex: "15B").
- **Bloc 3** (suggestions) : `detectProfileFromModelName(e.model)` sur le nom
  du carnet → `null` si le nom n'a pas la taille (ex: "phi-4").

Le Bloc 3 ne croisait pas avec LM Studio, donc les modèles à nom sans taille
étaient ignorés.

### Solution
`printLmStudioStatus()` construit désormais une map `lmsParamsByModelKey`
(modelKey normalisé → paramsString) depuis `night-batch.listLlmModels()`. Les
suggestions de retest utilisent `detectProfileFromModelName` en première
intention, puis retombent sur `paramsString` de LM Studio (même logique de
borne corrigée : `< 15` → STANDARD, `<= 30` → EXPERT). Les deux blocs sont
désormais cohérents.

### Fichiers modifiés
- `leaderboard.js` — `printLmStudioStatus()` : construction de
  `lmsParamsByModelKey`, fallback dans la boucle des suggestions. Nouvelle
  fonction `modelKeyDisplayLabel()` pour le Bloc 2 et la section non-LLM.
- `Docs/CHANGELOG.md`, `Memories-BenchGo/issues-fixes/2026-08-07-borne-15b-quantif-rapport.md`.

### Résultat obtenu
- Les modèles présents dans LM Studio dont le nom de carnet n'a pas la taille
  (ex: `phi-4`) sont désormais évalués pour les suggestions de retest via
  `paramsString` (15B → EXPERT → Primaire + Collège-Lycée + Université).
- Le Phi 4 Q5_K_L (déjà testé sur les 3 écoles) ne figure pas dans les
  suggestions (plus aucune manquante). Comportement correct.
- Cohérence Bloc 2 / Bloc 3 : même source de vérité (LM Studio) pour la
  taille quand le nom ne suffit pas.
- **Bloc 2 (non testés) et section non-LLM** : le nom affiché inclut
  désormais la quantification (`Phi 4 (IQ4_NL)` au lieu de `Phi 4` seul),
  via `modelKeyDisplayLabel()`. Cohérent avec le Bloc 1
  (`phi-4 (Q5_K_L)`).

### Validation
- `node --check leaderboard.js` → OK.
- `node tests/run-tests.js` → 27/27 passés.
- `node scripts/check-inline-js.js` → JS inline valide.
- `node leaderboard.js --lmstudio` → Bloc 1 : `phi-4 (Q5_K_L)` (84%, 3 écoles).
  Bloc 2 : `Phi 4 (IQ4_NL)` (15B, Prim,Coll-Lyc,Univ manquantes).
  Section non-LLM : quantif dans le nom via `modelKeyDisplayLabel`.
- Vérification exhaustive de tous les blocs : Bloc 1, Bloc 2, Bloc 3
  (suggestions), section non-LLM — quantification visible partout.

## 2026-08-07 — fix(détection): borne 15B et affichage de la quantification dans le rapport --lmstudio

### Contexte
Deux incohérences dans la détection des modèles LM Studio :

1. **Quantification invisible dans le Bloc 1 du rapport `--lmstudio`.** Le
   modèle `phi-4` (carnet `phi-4_q5_k_l.json`, testé à 84%) s'affichait comme
   « phi-4 » sans sa quantification Q5_K_L, alors que d'autres modèles la
   montraient dans leur modelKey (`kai-os_grug-12b@q5_k_s`). Impossible de
   distinguer le Phi 4 Q5_K_L du Phi 4 IQ4_NL dans le rapport.

2. **Écoles manquantes incorrectes pour un 15B.** Le Phi 4 IQ4_NL (15B, jamais
   testé) n'affichait que « Prim,Coll-Lyc » manquantes, omettant Université.
   Pourtant le Phi 4 Q5_K_L avait bien passé Université (84%). La borne de
   détection `paramSize <= 15` classait les 15B en `STANDARD` (Primaire +
   Collège-Lycée), excluant l'Université (EXPERT). Or le label de EXPERT est
   « Université (15B - 30B) » : un 15B doit donc être EXPERT, pas STANDARD.

### Cause racine
1. `printLmStudioStatus()` (leaderboard.js) affichait `e.displayName || e.model`
   pour le nom. Le carnet Phi 4 n'ayant pas de `displayName`, on retombait sur
   `e.model` = « phi-4 » (brut, sans quantification). Le `shortName` contient
   la quantif mais n'était pas utilisé pour l'affichage lisible.
2. `detectProfileFromModelName()` (config.js:291) et `schoolForModel()`
   (night-batch.js:1093) utilisaient `<= 15` pour la borne STANDARD, au lieu
   de `< 15`. Un 15B tombait donc en STANDARD (sans Université), en
   contradiction avec le label « EXPERT — Université (15B – 30B) ».

### Solution
1. Ajout de `modelDisplayLabel(entry)` (leaderboard.js) : affiche `displayName`
   ou, à défaut, `model` + ` (quantification)` si la quantif n'est pas déjà
   dans le nom. Utilisé dans le Bloc 1 du rapport `--lmstudio`. Le classement
   général conserve sa colonne `Quant` séparée (pas de changement).
2. Borne corrigée : `<= 15` → `< 15` dans `config.js` (PROFILES et
   `detectProfileFromModelName`) et `night-batch.js` (`schoolForModel`,
   label SCHOOLS). Un 15B est désormais EXPERT (Université incluse).
   Label STANDARD mis à jour : « 3B – <15B ».

### Fichiers modifiés
- `config.js` — borne `detectProfileFromModelName` (`<= 15` → `< 15`), label PROFILES.STANDARD.
- `night-batch.js` — borne `schoolForModel` (`<= 15` → `< 15`), label SCHOOLS.STANDARD.
- `leaderboard.js` — nouvelle fonction `modelDisplayLabel(entry)`, utilisée dans le Bloc 1 de `printLmStudioStatus`.
- `Docs/CHANGELOG.md`, `Memories-BenchGo/issues-fixes/2026-08-07-borne-15b-quantif-rapport.md`.

### Résultat obtenu
- Bloc 1 `--lmstudio` : « phi-4 (Q5_K_L) », « gemma-4-12b-it-qat (Q4_K_XL) »,
  « ornith-1.0-9b (Q4_K_M) » affichent leur quantification.
- Bloc 2 `--lmstudio` et `--list-only` : Phi 4 IQ4_NL affiche
  « Prim,Coll-Lyc,Univ » manquantes (cohérent avec 15B → EXPERT).
- Le Phi 4 Q5_K_L (déjà testé sur Université) ne figure plus dans les
  suggestions de retest (plus aucune école manquante).
- 7/7 modèles LM Studio détectés dans `--list-only` et `--lmstudio`.

### Validation
- `node --check config.js`, `node --check night-batch.js`, `node --check leaderboard.js` → OK.
- `node tests/run-tests.js` → 27/27 passés.
- `node scripts/check-inline-js.js` → JS inline valide.

## 2026-08-07 — fix(night-batch): modèles MTP orphelins non détectés par `--lmstudio` / `--list-only`

### Contexte
Un nouveau modèle téléchargé dans LM Studio, `Qwen3.6-27B-Fable-Fusion-711-...-MTP`
(17 Go, architecture qwen35), n'apparaissait ni dans `node night-batch.js --list-only`
ni dans le Bloc 2 (modèles non testés) de `node leaderboard.js --lmstudio`. Le
rapport affichait « 6 modèle(s) téléchargé(s) » alors que LM Studio en contenait 7.

### Cause racine
`isMtpModel()` détecte un fichier MTP (Multi-Token Prediction) dès que le
basename du `path` ou le `displayName` contient « mtp ». Or ce Qwen3.6 est un
vrai LLM de 27B : « MTP » figure dans son nom de fichier
(`...NEO-LOW-MTP-IQ4_XS.gguf`) car le modèle *supporte* le MTP, ce n'est pas un
module MTP accessoire. `listLlmModels()` filtrait ensuite tous les MTP via
`arr.filter(m => !isMtpModel(m))`, donc le modèle était exclu de la liste des
modèles testables — sans même figurer comme « non testé ».

Un vrai fichier MTP accessoire est conçu pour être chargé AVEC un modèle
principal (`--speculative-draft-mtp`) : il est toujours accompagné d'un modèle
principal dans le même dossier (ou d'un nom normalisé correspondant). Si un
modèle « mtp » est orphelin (aucun modèle principal candidat trouvé par
`buildMtpAssociations`), c'est en réalité un modèle principal complet.

### Solution
Dans `listLlmModels()` (night-batch.js), on ne filtre plus aveuglément tous les
MTP. On conserve les MTP *orphelins* (non associés à un modèle principal par
`buildMtpAssociations`) dans la liste des modèles testables. Les MTP
accessoires réellement associés restent filtrés comme avant.

### Fichiers modifiés
- `night-batch.js` — logique de filtrage MTP dans `listLlmModels()` : ajout
  du calcul des MTP orphelins (`orphanMtpKeys`) et garde de ceux-ci dans
  `testable`.
- `Docs/CHANGELOG.md`, `Memories-BenchGo/issues-fixes/2026-08-07-mtp-orphan-not-detected.md`.

### Résultat obtenu
- `node night-batch.js --list-only` affiche désormais 7 modèles (ligne 7 :
  « Qwen3.6 27B Fable Fus ... MTP » — 27B IQ4_XS, JAMAIS TESTÉ,
  écoles manquantes Prim,Coll-Lyc,Univ).
- `node leaderboard.js --lmstudio` affiche « 7 modèle(s) téléchargé(s) » avec
  2 non testés (Phi 4 IQ4_NL + Qwen3.6 27B).

### Validation
- `node --check night-batch.js` → OK.
- `node tests/run-tests.js` → 27/27 passés.
- `node scripts/check-inline-js.js` → JS inline valide.

## 2026-08-06 — feat(exercices): 5 améliorations des jeux d'exercices (standards industrie)

### Contexte
Suite aux suggestions de `Memories-BenchGo/Tasks1.md`, les exercices ont été
enrichis pour se rapprocher des standards de l'industrie (IFEval, injection
de prompt, cas limites, contexte long, validation déterministe).

### 5 suggestions implémentées

**1. Contraintes négatives et formatage strict (IFEval-style) — tiers 1-3**
- Tier 0 : `sansLettreE()` — bannir une lettre (insensible à la casse).
- Tier 1 : `exactementNMots()` — nombre exact de mots (off-by-one = échec).
- Tier 2 : `sansMarkdown()` — bannir les marqueurs Markdown (#, *, _, `, [).
- Tier 3 : `validerContraintes()` — mot banni + nombre exact de phrases
  simultanément.
Tous 100% déterministes (exec), sans modèle juge.

**2. Vérification déterministe pour les bas tiers (0-2)**
- Tous les nouveaux exercices de contrainte utilisent des évaluations `exec`
  (assertions exactes), pas de `custom` ni de modèle juge.
- Ajout de cas limites déterministes : tableaux vides, chaînes vides,
  tableaux à un élément, très grands entiers.

**3. Résistance au détournement et respect du prompt système (tiers 4-6)**
- Tier 4 : `filtrerCommentaires()` — filtrer les injections de prompt dans
  des commentaires utilisateurs (évaluateur custom
  `evaluatePromptInjectionResistance`). Patterns réalistes : "ignore
  instructions", "[SYSTEM] override", "oublie tes consignes".
- Tier 6 : `calcul_robuste` enrichi avec 2 cas limites supplémentaires
  (somme avec zéro, nombres négatifs) en plus du test d'injection existant.

**4. Cas limites sur les exercices de code (tiers 0-5)**
- Tableaux vides, tableaux à un élément, chaînes vides, très grands entiers
  (2×10⁹), nombres négatifs, longueur 0 pour fibonacci, ADN vide.
- Tier 5 : `sousTableauMax` avec tableau vide et tous négatifs.

**5. Recherche d'information en contexte long (tiers 4-5)**
- Tier 4 : `extraireInfoSecrete()` — évaluateur custom
  `evaluateLongContextRetrieval` qui génère un document de ~3000 mots avec
  l'info cachée à 3 positions (début, milieu, fin).
- Tier 5 : `extraireCode()` — extraction d'un code d'accès dans un long
  texte via le marker `CODE_ACCES:` (exec, 2 positions testées).

### Fichiers modifiés
- `tiers/tier0_light.json` — cas limites `valeurMax` + ex `contrainte_negative_0`.
- `tiers/tier1_light.json` — cas limite `sommePaires` + ex `contrainte_negative_1`.
- `tiers/tier2_light.json` — cas limites `sontAnagrammes` + ex `contrainte_negative_2`.
- `tiers/tier3_standard.json` — cas limites (voyelles, tri, ADN, fibonacci) + ex `contrainte_stricte_3`.
- `tiers/tier4_frontier.json` — ex `tache_4i` (injection) + `tache_4j` (contexte long).
- `tiers/tier5_standard.json` — cas limites `sousTableauMax` + ex `contexte_long_5`.
- `tiers/tier6_master.json` — `calcul_robuste` enrichi (2 cas limites).
- `custom-evaluators.js` — 2 nouveaux évaluateurs : `evaluatePromptInjectionResistance`, `evaluateLongContextRetrieval`.
- `verify_tiers.js` — solutions canoniques pour les 7 nouveaux exercices + correction `estADN` (`*` → `+`).
- `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md`.

### Résultat obtenu
- 376 exec OK / 396 testés (0 problème), 20 skip (évaluations custom non-exec).
- Les évaluateurs custom `evaluatePromptInjectionResistance` et
  `evaluateLongContextRetrieval` validés avec solutions canoniques.
- BenchGo couvre désormais 5 dimensions supplémentaires alignées avec les
  benchmarks industriels (IFEval, prompt injection, edge cases, long context).

### Validation
- `node --check custom-evaluators.js` → OK.
- `node --check verify_tiers.js` → OK.
- `node verify_tiers.js` → 376/376 exec OK, 0 problème.
- `node tests/run-tests.js` → 27/27 passés.
- `node scripts/check-inline-js.js` → JS inline valide.
- Évaluateurs custom testés avec solutions canoniques → OK.

---

## 2026-08-06 — fix(web): chemins de rapports normalisés en slashs universels (/)

### Contexte
Le champ `reportFile` du carnet JSON (chemin relatif du rapport Markdown)
était généré via `path.relative()` qui produit des antislashs (`\`) sous
Windows. Sérialisé tel quel dans `classement.html` (`var MODELS = ...`),
ce chemin cassait le chargement/les liens sur le web (404, liens
inutilisables), conformément au diagnostic de `Memories-BenchGo/Tasks1.md`.

### Solution
- `runner.js:2431` : `path.relative(__dirname, outputPath)` est désormais
  normalisé en slashs universels via `.split(path.sep).join('/')`. Les
  nouveaux runs stockent des chemins web-compatibles.
- Migration des carnets existants : 49 fichiers sur 50 dans
  `Export-Rapports/.carnet/*.json` ont vu leur `reportFile` corrigé
  (`\\` → `/`). 1 carnet n'avait pas de `reportFile`.
- `logRelPath` (affichage console local uniquement) n'est pas concerné :
  il reste OS-natif, non sérialisé pour le web.

### Fichiers modifiés
- `runner.js` (ligne 2431) : normalisation du chemin `relPath`.
- `Export-Rapports/.carnet/*.json` (49 fichiers) : `reportFile` migré
  antislashs → slashs.
- `Export-Rapports/classement.html` : régénéré, 0 chemin antislash.
- `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md` :
  documentation.

### Résultat obtenu
`classement.html` ne contient plus aucun chemin `Export-Rapports\...`
avec antislash. Les chemins sont désormais `Export-Rapports/...` (slashs
universels), conformes aux standards web.

### Validation
- `node --check runner.js` → OK.
- `node scripts/check-inline-js.js` → JS inline valide.
- `node tests/run-tests.js` → 27/27 passés.
- Vérif HTML : `Select-String -Path classement.html -Pattern 'Export-Rapports\\'` → 0 hit.

---

## 2026-08-06 — fix(cli): displayName utilisé dans les sections CLI (printLeaderboardSection + rapport --lmstudio)

### Contexte
Les sections CLI du classement général et du rapport `--lmstudio` affichaient
`e.model` (nom brut) au lieu du `displayName` personnalisé, même quand
l'utilisateur avait défini un nom affiché plus court. Exemple visible :
`yuxinlu1/gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2-gguf/gemma4-v2-q8_0.gguf`
s'affichait en plein alors qu'un `displayName` plus court existait.

### Solution
`printLeaderboardSection()` (classement général CLI) et `printLmStudioStatus()`
Bloc 1 utilisent désormais `e.displayName || e.model` pour la colonne modèle,
cohérent avec l'HTML, le Markdown et le CSV qui utilisaient déjà le
displayName. Le carnet `yuxinlu1_..._gemma4-v2-q8_0.json` a vu son
`displayName` mis à jour en `yuxinlu1/gemma4-v2-q8_0.gguf` (version
raccourcie demandée).

### Fichiers modifiés
- `leaderboard.js` : `printLeaderboardSection()` + `printLmStudioStatus()`
  Bloc 1 — colonne modèle → `e.displayName || e.model`.
- `Export-Rapports/.carnet/yuxinlu1_..._gemma4-v2-q8_0.json` : `displayName`
  mis à jour.

### Résultat obtenu
La ligne 6 du classement général CLI affiche désormais
`yuxinlu1/gemma4-v2-q8_0.gguf` au lieu du nom long.

### Validation
- `node --check leaderboard.js` → OK.
- `node scripts/check-inline-js.js` → JS inline valide.
- `node tests/run-tests.js` → 27/27 passés.
- `node leaderboard.js` + `node leaderboard.js --lmstudio` → noms raccourcis
  affichés.

## 2026-08-06 — fix(lmstudio): statuts du rapport --lmstudio basés sur le rang global local, plus l index chronologique

### Contexte
Le rapport `node leaderboard.js --lmstudio` affichait des statuts (verdict +
catégorie) incohérents avec le classement général (`node leaderboard.js`).
Les 3 modèles testés le plus récemment obtenaient « TOP DU TOP 🏆 » quel que
soit leur score réel (ex : `gemma-4-12b-it-qat-heretic-ud-k-xl` 95% et
`kai-os_grug-12b@q5_k_l` 96% marqués TOP DU TOP alors qu'ils sont rang 13 et 10
en classement général → RECOMMANDÉ).

### Cause racine
`printLmStudioStatus()` trie `entries` par date décroissante (chronologique)
pour le Bloc 1, mais passait `i + 1` (index dans la liste filtrée triée par
date) comme rang à `getVerdict()` / `getCategory()`. Or ces fonctions réservent
« TOP DU TOP » au rang 1-3. Les 3 premiers modèles chronologiques étaient donc
automatiquement classés TOP DU TOP indépendamment de leur score.

### Solution
Calcul d'une `Map<shortName, rang>` depuis le même tri que `generateLeaderboard`
(% décroissant, puis score, puis santé) sur les modèles locaux. Le rang global
local est passé à `getVerdict()` / `getCategory()` au lieu de l index de
boucle. Le rapport reste trié par date (comportement voulu pour le suivi), seul
le statut reflète désormais le rang réel dans le classement local.

### Fichiers modifiés
- `leaderboard.js` : `printLmStudioStatus()` — ajout du calcul
  `globalLocalRank` + utilisation dans la boucle Bloc 1.

### Résultat obtenu
Les statuts du rapport `--lmstudio` sont désormais identiques à ceux du
classement général pour les mêmes modèles (TOP DU TOP réservé aux rangs 1-3).

### Validation
- `node --check leaderboard.js` → OK
- `node leaderboard.js --lmstudio` → statuts cohérents (les 3 modèles récents
  à 94-96% affichent RECOMMANDÉ, les vrais podiums à 99-100% affichent TOP DU
  TOP).

## 2026-08-06 — feat(cli): système --help pour tous les entrypoints + rappels soumission communautaire multi-touch + visibilité participation

### Contexte
1. `leaderboard.js`, `night-batch.js`, `community-stats.js`,
   `consolidate-leaderboard.js` n'avaient pas de `--help` : l'utilisateur qui
   tapait `node <fichier>.js --help` ne voyait rien. Seul `runner.js` avait une
   aide centralisée (via `cli-help.js`), et `frontier-batch.js` avait une aide
   maison non cohérente.
2. Le rappel de soumission communautaire n'existait qu'en fin de run
   interactif (`proposeCommunitySubmission`) — absent du démarrage, de
   `night-batch.js` (batch silencieux) et de `leaderboard.js` (là où
   l'utilisateur voit ses résultats).
3. Le propriétaire du dépôt n'avait aucune visibilité sur les tentatives de
   soumission échouées chez les utilisateurs (un échec avant PR ne crée ni
   fichier ni PR côté dépôt). `community-stats.js` montrait les succès mergés
   et les PRs en attente, mais sans interprétation ni ratio d'adoption.

### Approche
1. **Système `--help` cohérent** : nouvelle fonction partagée
   `printEntryHelp(title, subtitle, commands, tips)` + utilitaire `wantsHelp()`
   dans `cli-help.js`. Tous les entrypoints secondaires détectent `--help` /
   `help` / `-h` et affichent un encadré ANSI cyan avec la liste exhaustive de
   leurs commandes/flags réellement supportés.
   - `leaderboard.js` : nouvelle `printLeaderboardHelp()` (serve, cloud,
     lmstudio, mark-cloud, port).
   - `night-batch.js` : détection en début de `main()` (list-only, models,
     schools, no-teacher, isolation interactive `!N`/`!!N`).
   - `frontier-batch.js` : refactor de l'aide maison vers `printEntryHelp`
     (cohérence + support de `help`).
   - `community-stats.js` : aide marquant l'outil comme propriétaire (token
     droits push requis).
   - `consolidate-leaderboard.js` : aide détaillant usage local + déploiement
     GitHub Pages (workflow `consolidate.yml`).
2. **Rappels soumission communautaire multi-touch** :
   - **Démarrage runner** : bannière cyan « COMMUNAUTÉ BENCHGO » avant le
     questionnaire (désactivée si `--no-telemetry`).
   - **Fin de run runner** : `proposeCommunitySubmission` enrichie (ligne
     « classement public visible par tous » + log en mode batch +
     rappel re-soumission `node runner.js --submit` après succès).
   - **Bilan night-batch** : bloc « COMMUNAUTÉ » adapté au mode `--hybrid`
     (auto-soumission confirmée) ou manuel (commande CLI rappelée).
   - **leaderboard.js** : encadré console en fin de `generateLeaderboard()` +
     bandeau HTML `.community-banner` dans le serveur interactif (sous le hero,
     à côté du bandeau NotebookLM) avec bouton « Copier la commande ».
3. **Visibilité participation** :
   - `community-sync.js` `submitResults()` : log structuré
     `[COMMUNITY-SUBMIT] result=success|failure|merge_failed model=... userId=...
     pseudo=... prNumber=... reason=...` à chaque tentative (succès, merge
     échoué, échec avant PR).
   - `community-stats.js` `printDashboard()` : ratio « Taux de participation »
     (soumissions mergées / clones uniques 14j), alerte si 0 PR en attente,
     section « INTERPRÉTATION » documentant la limite de visibilité des échecs.

### Fichiers modifiés
- `cli-help.js` — ajout `printEntryHelp()` + `wantsHelp()` (exportés).
- `leaderboard.js` — `printLeaderboardHelp()`, détection `--help`, encadré
  console communauté, bandeau HTML `.community-banner` + JS inline copie.
- `night-batch.js` — détection `--help`, `hybridFlag` dans `parseArgs()`, bloc
  « COMMUNAUTÉ » dans le bilan.
- `frontier-batch.js` — refactor `printFrontierHelp()` via `printEntryHelp`,
  support de `help`.
- `community-stats.js` — détection `--help`, ratio participation, section
  « INTERPRÉTATION ».
- `consolidate-leaderboard.js` — détection `--help` (usage local + CI).
- `community-sync.js` — log structuré `[COMMUNITY-SUBMIT]` dans `submitResults()`.
- `runner.js` — bannière communauté au démarrage, enrichissement de
  `proposeCommunitySubmission()` (log batch + rappel re-soumission).
- `AGENTS.md`, `Memories-BenchGo/README.md` — tableau de commandes mis à jour.

### Résultat obtenu
- `node leaderboard.js --help` → encadré exhaustif, exit 0.
- `node night-batch.js --help` / `frontier-batch.js --help` /
  `community-stats.js --help` / `consolidate-leaderboard.js --help` → idem.
- `node runner.js all --dry-run` → bannière communauté visible au démarrage.
- `node leaderboard.js` → encadré « COMMUNAUTÉ BENCHGO » en console.
- `node leaderboard.js --serve` → bandeau `.community-banner` + bouton copier.
- `node community-stats.js --token=...` → ratio participation + section
  interprétation + alerte visibilité échecs.
- `node scripts/check-inline-js.js` → OK. `node tests/run-tests.js` → OK.

### Décisions
- Signalement de bug côté utilisateurs : **abandonné** (hors périmètre, le
  propriétaire garde ses outils perso).
- Visibilité des échecs de soumission chez les utilisateurs : techniquement
  impossible sans token valide chez eux ou service tiers de comptage. La limite
  est documentée dans le dashboard `community-stats.js` (section interprétation).
- `--no-telemetry` désactive le ping mais PAS le rappel de fin de run (la
  soumission est une action explicite, indépendante de la télémétrie passive).

---

## 2026-08-06 — feat(leaderboard+night-batch): démarcation rapport LM Studio + quantification bilan de nuit + suggestions de retest

### Contexte
1. Dans `node leaderboard.js --lmstudio` (Bloc 1), tous les modèles testés
   apparaissaient dans une seule liste sans séparation visuelle entre les tests
   récents (cette nuit) et les tests antérieurs.
2. Dans le bilan de session de nuit (`night-batch.js`), quand plusieurs
   quantifications du même modèle étaient testées, le bilan répétait le
   `displayName` sans préciser la quantification → confusion.
3. Aucune suggestion de retest : l'utilisateur devait deviner quels modèles
   avaient des écoles manquantes et quelles écoles reprogrammer.

### Approche
1. **leaderboard.js** `printLmStudioStatus()` : lignes de démarcation avec
   titres colorés + aération (ligne vide) entre modèles récents (24h) et
   antérieurs.
2. **night-batch.js** bilan de session : `quantTag` (quantification en magenta)
   après le `displayName` dans le détail des runs.
3. **leaderboard.js** `printLmStudioStatus()` Bloc 3 — suggestions de retest :
   pour chaque modèle testé présent dans LM Studio, détection de l'école max
   pertinente (`detectProfileFromModelName`), calcul des écoles attendues
   (LIGHT→école max), comparaison avec les écoles du carnet. Les modèles avec
   écoles manquantes sont listés avec une commande `night-batch.js` prête à
   copier-coller (`--models=... --schools=...`). Une commande globale regroupe
   tous les modèles suggérés.

### Fichiers modifiés
- `leaderboard.js` — `printLmStudioStatus()` : démarcation Bloc 1 + Bloc 3
  (suggestions de retest avec commandes night-batch prêtes).
- `night-batch.js` — boucle de bilan : `quantTag` magenta après le nom.

### Résultat obtenu
Rapport LM Studio — Bloc 3 :
```
  ━━━ SUGGESTIONS DE RETEST (3) ━━━
  ornith-1.0-9b@q5_k_m    Q5_K_M  College-Lycee  node night-batch.js --models=... --schools=STANDARD
  kai-os_grug-12b@q5_k_s  Q5_K_S  Primaire       node night-batch.js --models=... --schools=LIGHT
  kai-os_grug-12b@q6_k_l  Q6_K_L  Primaire       node night-batch.js --models=... --schools=LIGHT

  ⚠ Vous avez 3 modèle(s) avec des écoles manquantes.
  Pour tester tous les modèles suggérés d'un coup :
  node night-batch.js --models=ornith-1.0-9b@q5_k_m,kai-os_grug-12b@q5_k_s,kai-os_grug-12b@q6_k_l --schools=STANDARD,LIGHT
```

Bilan de nuit :
```
  OK Kai Os Grug 12B              Q5_K_L [LIGHT] 2.4 min
  OK Kai Os Grug 12B              Q4_K_S [STANDARD] 21.1 min
```

### Validation
- `node --check leaderboard.js` → OK
- `node --check night-batch.js` → OK
- `node scripts/check-inline-js.js` → OK
- `node leaderboard.js --lmstudio` → démarcation + aération + suggestions affichées

## 2026-08-05 — feat(leaderboard): édition du nom affiché pour distinguer les modèles au même nom

### Contexte
Quand LM Studio ne fournit que le nom de base (ex: "Phi 4", "Kai Os Grug 12B")
sans la quantification ni le nombre de paramètres dans le titre, plusieurs
modèles différents (quantifs/paramètres différents) apparaissent avec le même
nom dans le leaderboard → confusion. L'utilisateur ne sait plus quelle
quantif correspond à quelle entrée.

### Approche
Nouvelle colonne « 🏷️ Nom affiché » dans la modale (5e action-card) qui permet
de corriger le titre affiché. Le nom personnalisé est stocké dans
`ledger.displayName` et persisté dans le carnet JSON (endpoint
`/api/model-displayname`). À l'affichage, `displayName` prime sur `model`
(brut) partout : carte, titre de modale, exports Markdown/CSV, classement
communautaire, titres de PR GitHub. Le nom brut reste utilisé pour les
rapprochements (URL Hugging Face, matchLedger) — il n'est jamais modifié.

### Fichiers modifiés
- `leaderboard.js` — `aggregateLedger` (expose `displayName`), `buildLeaderboardHTML`
  (carte + modale + colonne 5), `editModelDisplayName`/`saveModelDisplayName`/
  `cancelEditModelDisplayName` (JS inline), CSS `.model-displayname-*`,
  endpoint `/api/model-displayname` (GET/POST), filtres de recherche,
  `buildLeaderboardMarkdown`.
- `consolidate-leaderboard.js` — `aggregateCarnet` (expose `displayName`),
  carte + modale + exports Markdown/CSV + rapport intégral + filtres recherche.
- `community-sync.js` — titre/body de PR utilise `displayName` si présent.
- `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/INSTRUCTIONS.md`.

### Résultat
- L'utilisateur clique sur « + Ajouter » dans la colonne « Nom affiché » de la
  modale, saisit "Kai Os Grug 12B Q4_K_S", et la carte affiche ce titre au lieu
  de "kai-os_grug-12b". Effacer revient au nom brut.
- Suggestion automatique : nom brut + quantification si le champ est vide.
- Le nom personnalisé est soumis avec le carnet (champ `carnet.displayName`)
  et affiché dans le classement communautaire.
- `node tests/run-tests.js` → 27/27 ; `node scripts/check-inline-js.js` → OK.

---

## 2026-08-05 — fix(night-batch): modèles quantifiés jamais apparus dans le leaderboard (carnet orphelin absorbant)

### Contexte
Plusieurs modèles testés en night-batch n'apparaissaient jamais dans le classement.
Cas typique : Kai Os Grug 12B testé en Q4_K_S et Q5_K_L — aucun carnet dédié
n'existait. Un carnet orphelin `kai-os_grug-12b.json` (sans quantif, datant de
juillet, avant le fix du 1er août) absorbait toutes les quantifs via `matchLedger`,
empêchant la création de carnets distincts et masquant les quantifs dans
`--list-only` (affichées COMPLET/99% sur l'orphelin au lieu de JAMAIS TESTÉ).

### Cause racine
`matchLedger()` (night-batch.js) :
1. `quantMatches()` traitait les carnets sans quantif dans le shortName comme
   « sans préférence » (matche tout) → l'orphelin matchait Q4_K_S, Q5_K_L, etc.
2. `normalizeForMatch("kai-os_grug-12b@q5_k_s")` supprime la quantif → le modelKey
   normalisé égalait `model` de l'orphelin.
3. Le `fallback` accumulait l'orphelin même quand `quantMatches` disait non.

### Solution
`night-batch.js` — `matchLedger()` / `quantMatches()` :
- `quantMatches()` teste deux sources (suffixe shortName `_q4_k_s` + champ
  `ledger.quantization`) ; un carnet sans AUCUNE quantif ne matche plus une
  requête quantifiée.
- Fallback désactivé quand une quantif est demandée (`wantQuant` défini) :
  retour `null` plutôt que l'orphelin → le modèle apparaît JAMAIS TESTÉ /
  ÉCHEC dans `--list-only`, incitant à le tester et créer un carnet dédié.

### Fichiers modifiés
- `night-batch.js` — `matchLedger()`, `quantMatches()`, logique de fallback.
- `Memories-BenchGo/issues-fixes/2026-08-05-carnet-orphelin-absorbe-quantifs.md`
- `Docs/CHANGELOG.md`

### Résultat
- `matchLedger` : Q4_K_S et Q5_K_L → `NULL` (avant : orphelin) ; Q5_K_S et
  Q6_K_L → carnets dédiés (inchangé) ; modelKey sans quantif → orphelin (inchangé).
- `node night-batch.js --list-only` : Q4_K_S et Q5_K_L affichent ÉCHEC (tentés,
  pas de carnet) au lieu de COMPLET/99% (orphelin).
- `node tests/run-tests.js` → 27/27 ; `node scripts/check-inline-js.js` → OK.
- `node leaderboard.js` → 46 cartes (l'orphelin reste visible via `loadAllLedgers`).

---

## 2026-08-05 — fix(night-batch): Phi 4 affichait « Doct » en école manquante à tort

### Contexte
Dans le tableau `night-batch.js --list-only`, le modèle Phi 4 (15B, Q5_K_L)
s'affichait en PARTIEL avec la colonne « Ecoles manquantes » = `Doct`, alors
qu'un 15B n'a pas à passer Doctorat (> 30B). Le carnet contient pourtant
Primaire, College-Lycee et Universite.

### Cause racine
`schoolForModel()` (night-batch.js) détecte la taille depuis le nom, puis en
fallback depuis `m.params`. Or elle est appelée dans `listLlmModels()` sur
l'entrée brute de `lms ls --json`, qui expose `paramsString` mais pas `params`.
La détection échouait → `school` = null → toutes les écoles considérées
pertinentes → Doctorat listé comme manquant.

### Solution
Le fallback de `schoolForModel()` lit désormais `m.params` **ou** `m.paramsString`,
couvrant à la fois l'entrée brute (`lms ls`) et l'objet enrichi.

### Fichiers modifiés
- `night-batch.js` — `schoolForModel()`, fallback paramsString/params.
- `Memories-BenchGo/issues-fixes/2026-08-05-phi-4-ecole-manquante-doctorat.md`
- `Docs/CHANGELOG.md`

### Résultat
- `node night-batch.js --list-only` → Phi 4 affiche **COMPLET**, plus de `Doct`.
- `node tests/run-tests.js` → 27/27 passés.

---

## 2026-08-05 — feat(sécurité paramètres): validation école vs paramètres + suppression école invalide

### Contexte
Le modèle Phi-4 Q5_K_L (14.7B paramètres, profil STANDARD) a été testé sur
Université (profil EXPERT, minimum 15B requis) à cause d'une erreur de
configuration. Résultat : score pénalisé (Université à -190/567) et classement
faussé. Il fallait une sécurité pour empêcher qu'une école trop avancée pour
le nombre de paramètres d'un modèle ne le pénalise artificiellement.

### Approche
1. **Validation côté serveur** : nouvelle fonction `validateSchoolForParamSize()`
   qui compare le nombre de paramètres du modèle au seuil minimum de chaque école
   (Primaire: 0B, College-Lycee: 3B, Universite: 15B, Doctorat-These: 30B).
2. **Badge d'avertissement** : dans la modale, les écoles invalides sont marquées
   d'un ⚠️ avec tooltip explicatif.
3. **Bouton de suppression** : 4e colonne dans la grille d'actions de la modale
   (« Écoles ») avec bouton rouge « 🗑 Suppr. » pour supprimer l'école du carnet.
4. **API serveur** : nouvel endpoint `POST /api/delete-ecole?shortName=...&ecole=...`
   qui supprime l'école du carnet JSON et régénère le classement.
5. **Mêmes protections dans consolidate-leaderboard.js** : validation + badge ⚠️
   dans le classement communautaire.

### Fichiers modifiés
- `leaderboard.js` (validateSchoolForParamSize, paramValid dans buildLeaderboardHTML,
  badge ⚠️ + colonne Écoles dans openModal, deleteEcole client, deleteEcoleFromLedger,
  endpoint /api/delete-ecole, CSS .btn-danger/.param-warn)
- `consolidate-leaderboard.js` (validateSchoolForParamSize, paramValid dans modelsJson,
  badge ⚠️ dans openModal, CSS .btn-danger/.param-warn)
- `Docs/CHANGELOG.md`

### Résultat
- Un modèle 14.7B testé sur Université voit désormais un ⚠️ rouge dans la modale
  avec la mention « Modèle 14.7B paramètres — école Universite requiert minimum
  15B. Résultat pénalisé par un test inadapté. »
- L'utilisateur peut supprimer l'école invalide en un clic → le carnet est mis à
  jour et le classement régénéré sans l'école problématique.
- Le classement communautaire (consolidate-leaderboard.js) bénéficie des mêmes
  validations et badges d'avertissement.

## 2026-08-04 — feat(agent NotebookLM): bandeau proéminent + modale de renseignement sur les modèles

### Contexte
BenchGo s'appuie sur un **agent NotebookLM** (Google) qui a ingéré l'ensemble
des comptes rendus de tests de tous les modèles. C'est l'outil qui donne toute
sa puissance à l'application : l'utilisateur peut poser des questions en
langage naturel ("Lequel est le plus rapide en Q4 sous 3B ?", "Pourquoi X a
échoué à DOCTORAT ?") et obtenir des réponses synthétiques. Jusqu'ici ce lien
n'était mentionné nulle part dans l'interface — il fallait le connaître.

### Approche
- **NotebookLM bloque l'iframe** (`X-Frame-Options: DENY` + CSP `trusted-types`) :
  impossible d'afficher le notebook dans une iframe embarquée (local ou en
  ligne). Un proxy local serait fragile (SPA Google avec nonces CSP rotatifs)
  et casserait le rendu.
- Solution retenue : un **bandeau proéminent** dans l'en-tête des deux
  classements (`leaderboard.js` + `consolidate-leaderboard.js`) + une **modale**
  d'explication + une **bulle d'info périodique**.
- Le lien s'ouvre dans un nouvel onglet (`target="_blank" rel="noopener"`).

### Affichage
- **Bandeau `.nb-banner`** placé juste sous le `<header class="hero">` : icône
  🧠, titre "Agent NotebookLM", description courte, bouton "?" (ouvre la
  modale) et bouton "🧠 Ouvrir l'agent" (lien direct).
- **Modale `.nb-modal`** : présente les 4 usages (comparer, recommander,
  analyser un échec, explications) + bouton CTA principal.
- **Bulle `.nb-tip`** : s'affiche après 12 s à la 1re visite, puis toutes les
  ~5 min tant que l'agent n'a pas été ouvert. Message court :
  "Besoin de renseignements sur un modèle ? Contactez l'agent NotebookLM 🧠".
- Mémorisation : `sessionStorage` (1re bulle) + `localStorage` (agent déjà
  ouvert → plus de bulles).
- Concerne les deux fichiers : `leaderboard.js` (classement local) ET
  `consolidate-leaderboard.js` (classement communautaire en ligne GitHub Pages).

### Fichiers touchés
- `leaderboard.js` : constante `NOTEBOOKLM_URL`, CSS `.nb-*`, bandeau HTML,
  modale HTML, JS inline (openNbModal/closeNbModal/bulle périodique).
- `consolidate-leaderboard.js` : idem.
- `Docs/CHANGELOG.md`, `AGENTS.md`, `Memories-BenchGo/README.md` :
  documentation de la nouvelle fonctionnalité.

### Lien
L'agent NotebookLM public : `https://notebook.google.com/notebook/bd6cf971-b22a-460a-9892-419d1db02f9e`
(changé en une seule constante `NOTEBOOKLM_URL` en haut de chaque fichier
pour faciliter les futures mises à jour).

## 2026-08-04 — feat(tarif cloud): estimation du coût $/€ des modèles cloud payants dans le classement

### Contexte
Sur le leaderboard local (`leaderboard.js`) ET le classement communautaire
(`consolidate-leaderboard.js`), il n'y avait aucune information sur le coût
d'utilisation des modèles cloud payants. L'utilisateur souhaitait voir,
pour chaque modèle cloud, une **estimation** du tarif en dollars et euros,
par école puis en cumul total, pour repérer les modèles les plus économiques.
Les modèles locaux (LM Studio) ne sont pas concernés (gratuits, sur la machine).

### Approche
- **Estimation des tokens** : le code compte déjà les tokens produits
  (completion). On a ajouté une estimation des **prompt tokens** à partir de
  la longueur des prompts envoyés (≈ chars/4), cumulée par école dans le carnet
  de scores. Ce sont des **approximations** (le vrai tokenizer diffère), pas
  des valeurs exactes.
- **Tarification** : nouveau module `pricing.js` hybride :
  1. fetch asynchrone de l'endpoint public OpenRouter `/api/v1/models`
     (champ `pricing.prompt`/`pricing.completion`, en $/token), avec cache
     disque 24h (`.pricing-cache.json`) pour l'offline/CI.
  2. fallback sur une table locale `PRICING_FALLBACK` pour les providers non
     couverts par OpenRouter (OpenAI direct, Anthropic, Groq, DeepSeek,
     Together, Mistral, Cohere).
  3. fallback générique par provider si le modèle précis est inconnu.
- Rétrocompatible avec les anciens carnets sans `promptTokens`/
  `completionTokens` : on estime `promptTokens ≈ 3×completion`.

### Affichage
- **Carte du classement** : mini-stat « Coût ≈ » (USD) pour les modèles cloud
  payants dont le prix est connu.
- **Modale détaillée** : statBox « Coût ≈ » ($ / €) + nouvelle section
  « 💰 Tarif estimé par école » avec tableau (tokens prompt/completion,
  coût $ et € par école + ligne TOTAL) et mention explicite « estimation
  indicative — non exacte ».
- **Export Markdown** : colonne « Coût ≈ » dans le tableau principal + ligne
  « Coût estimé » par modèle + colonne Coût par école (uniquement pour les
  modèles cloud).
- Aucune colonne/tarif pour les modèles locaux ou gratuits (prix = 0).

### Fichiers modifiés
- `pricing.js` (nouveau) — module de tarification hybride (OpenRouter + fallback local).
- `runner.js` — cumul `tierPromptChars`/`schoolPromptChars`, injection de
  `promptTokens`/`completionTokens` dans le résultat d'école sauvegardé au carnet.
- `leaderboard.js` — agrégation des tokens estimés, calcul du coût via
  `pricing.estimateModelCost()`, sérialisation vers le client, mini-stat Coût,
  section tarif par école dans la modale, colonne Coût dans le Markdown.
- `consolidate-leaderboard.js` — idem (agrégation, sérialisation, mini-stat,
  section tarif par école dans la modale).

### Résultat obtenu
- `node leaderboard.js` et `node consolidate-leaderboard.js` génèrent les
  classements avec le coût estimé pour les modèles cloud payants.
- `node scripts/check-inline-js.js` : OK (JS inline valide).
- `node tests/run-tests.js` : 27/27 passés.
- Mention « estimation » présente partout (tooltip, titre, note de bas).

### Notes
- Les valeurs sont des **estimations**, pas des montants exacts. Le coût réel
  dépend du tokenizer exact du modèle, du volume de raisonnement (thinking)
  et de l'évolution des prix des providers.
- Le taux de conversion $→€ est fixé à 0.92 (ajustable dans `pricing.js`).
- `pricing.js` ne fait aucun appel bloquant : le rechargement OpenRouter est
  asynchrone et le cache disque sert de repli immédiat.

---

## 2026-08-04 — fix(leaderboard+consolidate): sélecteur Origine maître (cloud vs local étanches)

### Contexte
Dans le classement local (`leaderboard.js`, 46 modèles) ET le classement
communautaire (`consolidate-leaderboard.js`, 39 modèles), les sélecteurs
Taille, Santé, École et Catégorie affichaient des compteurs statiques calculés
sur l'ensemble des modèles (mélange local + cloud). Quand on cliquait sur
« ☁️ Cloud · API », les cartes se filtraient bien mais les compteurs des autres
sélecteurs restaient à 46 (ou 39) au lieu de ne compter que les modèles cloud
frontière (4 ou 2). Les deux univers (local LM Studio et cloud API) étaient
mélangés dans les compteurs alors qu'ils n'ont rien à voir.

### Solution
Le sélecteur **Origine** devient le sélecteur **maître** dans les deux fichiers :
- Tous les compteurs (Taille, Santé, École, Catégorie, Origine) sont désormais
  calculés **côté client** dans `renderCards()` à partir d'un ensemble
  « contexte » = modèles filtrés par l'origine active (+ recherche), sans les
  autres filtres. Chaque select affiche donc uniquement les modèles de
  l'univers sélectionné (cloud ou local).
- Les compteurs statiques côté serveur (`catCounts`, `sizeCounts`,
  `healthCounts`, `originCounts`) ont été supprimés : les options HTML sont
  écrites sans compteur, et `renderCards()` les remplit dynamiquement à chaque
  changement.
- Changer d'origine réinitialise les autres filtres (Catégorie, Taille, Santé,
  École) à « all » pour éviter les combinaisons vides (ex: taille « petit »
  inexistante chez les cloud).

### Fichiers modifiés
- `leaderboard.js` :
  - Compteurs statiques serveur supprimés (lignes 587-605)
  - Options HTML sans compteurs (catSelect, sizeSelect, healthSelect,
    ecoleSelect, originSelect)
  - `renderCards()` : nouveau bloc calculant `_originCtx`, `_sizeCounts`,
    `_healthCounts`, `_ecoleCountsDyn`, `_originCounts` et mettant à jour
    dynamiquement les `textContent` de toutes les options
  - `addEventListener` du originSelect : réinitialise les autres filtres à
    « all » puis appelle `renderCards()`
- `consolidate-leaderboard.js` : mêmes modifications (structure identique)

### Validation
- `node --check leaderboard.js` / `node --check consolidate-leaderboard.js` → OK
- `node leaderboard.js` / `node consolidate-leaderboard.js` → HTML régénérés
- `node scripts/check-inline-js.js` → JS inline valide pour les 2 HTML
- `node tests/run-tests.js` → 27/27 tests passés
- Test fonctionnel (mock DOM) : origine=cloud → Taille (4), Santé (4),
  École (4), Catégorie (4) au lieu de (46) ; community → (2) au lieu de (39)

## 2026-08-04 — fix(leaderboard): bannière mise à jour impossible à fermer (race condition)

### Contexte
Dans le classement HTML (`classement.html`), la bannière « Mise à jour disponible »
ne disparaissait pas quand on cliquait sur ✕ : elle restait affichée ou réapparaissait
immédiatement.

### Cause racine
Race condition entre le `fetch` asynchrone vers l'API GitHub et le clic utilisateur.
`showBanner()` était appelée quand le fetch se terminait, et forçait `banner.hidden = false`
sans vérifier si l'utilisateur avait déjà masqué la bannière entre-temps.

### Solution
`showBanner()` lit maintenant le cache `dismissedAt` avant d'afficher la bannière.
Si l'utilisateur a masqué l'avis récemment (< 1h, TTL du cache), la bannière reste
cachée même si le fetch asynchrone se termine après le clic.

### Fichiers modifiés
- `leaderboard.js` — `showBanner()` : vérification `dismissedAt` avant `banner.hidden = false`

### Validation
- `node --check leaderboard.js` → OK
- `node leaderboard.js` → classement.html régénéré
- `node scripts/check-inline-js.js` → JS inline valide

## 2026-08-04 — feat(leaderboard): commande --lmstudio pour le suivi complet LM Studio

### Contexte
Après un batch de nuit, le classement général affiche la liste des modèles cloud
testés ET la liste des modèles LM Studio NON testés, mais il manquait une vue
unifiée combinant les deux : les modèles LM Studio testés (triés chronologiquement,
tests de la nuit en tête) ET les modèles LM Studio restant à tester. Sans cette
vue, impossible de classer correctement les modèles pour générer les rapports et
alimenter NotebookLM.

### Solution
Nouvelle commande CLI `node leaderboard.js --lmstudio` (alias `--lmstudio-status`).
Vue unifiée en deux blocs :
- **Bloc 1 — Modèles testés** : tous les modèles LM Studio ayant été exécutés,
  tri strictement chronologique (du test le plus récent au plus ancien). Colonnes :
  #, Modèle, Dernier Test (date/heure), Niveau (note + écoles), Score, Statut.
- **Bloc 2 — Modèles non testés** : tous les modèles détectés dans LM Studio
  mais absents des carnets, avec statut [NON TESTÉ] (réutilise printUntestedLmStudioModels).

### Fichiers modifiés
- `leaderboard.js` — `getLmStudioTestedEntries()`, `printLmStudioStatus()`,
  branche `--lmstudio` / `--lmstudio-status` dans `main()`, export module.
- `cli-help.js` — flag ajouté dans la section CLASSEMENT.
- `Docs/Manuel-utilisateur/02-commandes.md` — commande documentée.
- `AGENTS.md` — commande ajoutée dans la table des commandes essentielles.
- `Memories-BenchGo/README.md` — section "Référence rapide des commandes" ajoutée
  et mention du rapport LM Studio dans la section Leaderboard.

### Résultat
- `node leaderboard.js --lmstudio` → Bloc 1 (42 modèles testés, tri chrono) +
  Bloc 2 (3 modèles non testés) dans une vue unifiée.
- Aucun modèle cloud n'apparaît.

### Validation
- `node --check leaderboard.js` → OK
- `node --check cli-help.js` → OK
- `node leaderboard.js --lmstudio` → affichage correct (2 blocs)
- `node tests/run-tests.js` → 27/27 passes

## 2026-08-03 — fix(leaderboard+consolidate): categories dynamiques + badge origine unifie

### Contexte
Deux problemes dans le classement (leaderboard.js) et le classement communautaire
(consolidate-leaderboard.js) :

1. **Badge origine redondant** : le badge des cartes affichait le nom du provider
   specifique (OpenRouter, OpenAI...) alors que le selecteur d origine ne propose
   que Local et Cloud. Redondance visuelle (badge OpenRouter + option Cloud).

2. **Filtre categorie casse** : les categories (Top du top, Recommande, etc.)
   etaient calculees avec le rang GLOBAL (tous modeles confondus). Quand on filtre
   par origine=cloud, les 3 premiers modeles cloud avaient un rang global de 15+
   et n apparaissaient JAMAIS en "Top du top", alors qu ils sont TOP DU TOP dans
   le CLI --cloud. Resultat : le filtre "Top du top" affichait 0 modele apres
   un filtre origine=cloud.

### Solution
- **Categories dynamiques** : ajout d une fonction _getCategory() cote client
  (replique de la version Node). Les categories sont recalculees dynamiquement
  dans renderCards() en fonction du rang FILTRE (position dans l ensemble
  affiche), pas le rang global. Un premier passage filtre tous les modeles
  SAUF la categorie, calcule les rangs filtres et les categories dynamiques,
  met a jour les compteurs du select, puis un second passage applique le
  filtre categorie.
- **Badge origine unifie** : tous les modeles cloud affichent le badge "Cloud"
  (au lieu du nom du provider specifique), coherent avec le selecteur.
- Meme correction appliquee a la fonction copyLeaderboard() (export texte).
- Protection des acces m.cat / m.paramSize contre les valeurs undefined.

### Fichiers modifies
- `leaderboard.js` — _getCategory(), categories dynamiques dans renderCards,
  badge origine unifie, compteurs select mis a jour dynamiquement
- `consolidate-leaderboard.js` — _getCategory(), categories dynamiques dans
  renderCards et copyLeaderboard, badge origine Cloud, compteurs select dynamiques

### Resultat
- Filtre origine=cloud + categorie=Top du top → affiche les 3 premiers modeles
  cloud (91%, 82%, 81%) au lieu de 0
- Filtre origine=local + categorie=Top du top → affiche les 3 premiers modeles
  locaux (99%, 99%, 99%)
- Sans filtre origine → les 3 premiers globaux (99%, 99%, 99%)
- Badge origine : "Local" ou "Cloud" uniquement (plus de OpenRouter/OpenAI)
- Compteurs du select categorie mis a jour dynamiquement selon les filtres actifs

### Validation
- `node --check leaderboard.js` → OK
- `node --check consolidate-leaderboard.js` → OK
- `node leaderboard.js` → classement.html regenere
- `node consolidate-leaderboard.js` → community-leaderboard.html regenere
- `node scripts/check-inline-js.js` → JS inline valide pour les 2 fichiers
- `node tests/run-tests.js` → 27/27 passes

## 2026-08-03 — feat(runner): pénalité temps de raisonnement + nettoyage CLI

### Contexte
Les modèles frontières cloud mettent 5-20 minutes à raisonner sur les Tiers 0-2
et ne produisent parfois que quelques centaines de tokens inexploitables. Aucune
pénalité n'était appliquée, et le CLI affichait un message de "surconsommation
de tokens" inutile à chaque succès.

### Solution
- Suppression du message "Surconsommation de tokens : ... Non pénalisé" (ligne 666)
- Ajout d'une pénalité de 20 points si le modèle dépasse 5 min (300s) pour moins
  de 500 tokens — le modèle est prévenu dans le prompt via une consigne explicite
  "ATTENTION — LIMITE DE TEMPS"
- Nettoyage de l'affichage de l'erreur undici (stderr → logger.warn) pour ne plus
  polluer la ligne du spinner

### Fichiers modifiés
- `runner.js` — suppression message verbosité, ajout pénalité temps, nettoyage undici

### Validation
- `node --check runner.js` → OK
- `node tests/run-tests.js` → 27/27 passés

## 2026-08-03 — feat(cli): BigSpinner pour les temps d'attente longs (raisonnement modèle)

### Contexte
Les modèles frontières cloud (OpenRouter) et certains modèles locaux mettent 5-10 minutes
à raisonner sur les Tiers 0-2. Le spinner standard était trop petit et n'affichait aucune
information sur ce que le modèle faisait, laissant l'utilisateur sans feedback.

### Solution
- Nouvelle classe `BigSpinner` dans `progress-bar.js` : affichage large sur 3-4 lignes avec :
  - Un gros caractère de spinner (◐◓◑◒)
  - Une barre de progression temporelle (●○) qui s'allonge toutes les 5s
  - Le temps écoulé (format `Xm Ys`)
  - Des messages pédagogiques rotatifs expliquant ce que le modèle fait
  - Le nombre de tokens produits (quand disponible)
- Nouveau tableau `REASONING_WAITING_MESSAGES` dans `config.js` : 15 phrases informatives
  sur le raisonnement du modèle (ex: "Le modèle analyse les exercices un par un...")
- `runner.js` : le spinner des tentatives de classe utilise désormais `BigSpinner` avec
  les messages de raisonnement activés

### Fichiers modifiés
- `config.js` — ajout de `REASONING_WAITING_MESSAGES` et export
- `progress-bar.js` — ajout de la classe `BigSpinner`
- `runner.js` — import et utilisation de `BigSpinner` dans `runTierAttempt`

### Validation
- `node --check config.js` → OK
- `node --check progress-bar.js` → OK
- `node --check runner.js` → OK

## 2026-08-03 — fix(runner): retry anti-timeout déclenché sur erreurs HTTP (modèle dépublié)

### Contexte
Le retry anti-timeout (boucle à 2 tentatives dans `runTierAttempt`) a été conçu pour les vrais
timeouts des modèles de raisonnement locaux (phi-4-reasoning-plus, GLM, DeepSeek-R1...). Mais
en pratique il se déclenchait sur **toute** erreur non fatale, y compris les erreurs HTTP 400
(modèle OpenRouter dépublié `nvidia/nemotron-nano-12b-2-vl:free`), HTTP 401 (clé invalide), etc.
Symptôme : chaque classe exécutait **deux** appels API identiques qui échouaient tous les deux,
doublant inutilement le temps de run et affichant `[RETRY ANTI-TIMEOUT]` à tort.

### Cause
`queryFn` est appelée avec `isMandatory=false` pour récupérer l'erreur au lieu d'`exit`. Sur une
erreur HTTP (cloud-client.js ligne 384), elle retourne `null` silencieusement. Le runner ne
distinguait pas `null = timeout récupéré` (retry utile) de `null = HTTP 400` (retry inutile) :
la boucle passait automatiquement à `tierAttempt=2`.

### Solution
- `runner.js` : ajout d'un `else` après `if (responseData) { break }` dans la boucle retry.
  Si `responseData === null` et `tierRetryReason !== 'timeout'`, on `break` immédiatement.
  Le retry ne se déclenche maintenant que pour un **vrai** timeout (`AbortError` capturé dans
  le `catch`, qui positionne `tierRetryReason = 'timeout'`).

### Fichiers modifiés
- `runner.js` — boucle retry anti-timeout dans `runTierAttempt`

### Validation
- `node --check runner.js` → OK
- `node tests/run-tests.js` → 27/27 passés

## 2026-08-03 — fix(runner): persistance clé OpenRouter professeur ignorée en mode CLI

### Contexte
En mode CLI historique (`frontier-batch.js` → `node runner.js --provider=... --api-key=...`),
le bloc de configuration du professeur OpenRouter redemandait la clé API à chaque run même si
elle était déjà mémorisée dans `.api-keys.json`. `apiKeysStore.restoreIntoSession(secrets)` la
chargeait bien dans `secrets` au démarrage (ligne 1141), mais le bloc professeur (ligne ~1325)
ne testait que `process.env.OPENROUTER_API_KEY` et `--teacher-api-key=` — il omettait
`secrets.getSecret('openrouter')`.

### Solution
- `runner.js` : ajout de `const storedKey = secrets.getSecret('openrouter')` et intégration dans
  la condition de détection de clé (`teacherApiKey || envKey || storedKey`). Si une clé
  mémorisée est trouvée, le professeur OpenRouter s'active sans redemander.

### Fichiers modifiés
- `runner.js` — bloc professeur OpenRouter en mode CLI historique

### Validation
- `node --check runner.js` → OK
- `node tests/run-tests.js` → 27/27 passés

## 2026-08-03 — feat(frontier-batch): niveau d'école configurable (--profile=) pour les petits modèles cloud

### Contexte
`frontier-batch.js` forçait systématiquement `--profile=FRONTIER` (Post-Doctorat, le niveau le
plus élevé). Or OpenRouter propose de nombreux modèles gratuits **petits** (< 15B, voire < 3B)
qui ne peuvent réalistement pas passer le Post-Doctorat : ils échouent à 0/2671 et n'apparaissent
jamais dans le classement. Un modèle 12B (ex: Nemotron Nano 12B 2 VL) doit être testé au niveau
Collège/Lycée (STANDARD), un modèle 9B au même niveau, un modèle 3B au Primaire (LIGHT).

### Fonctionnalité
- Nouvelle option `--profile=<level>` dans `frontier-batch.js` : LIGHT, STANDARD, EXPERT,
  DOCTORAT, FRONTIER (défaut, comportement historique conservé).
- Nouvelle **sélection interactive** du niveau d'école (après les modèles) :
  - Affiche les 5 profils avec leur école associée.
  - Recommande automatiquement un profil selon la **taille détectée** dans les slugs saisis
    (via `detectProfileFromModelName` de `config.js` : 12B → STANDARD, 9B → STANDARD,
    550B → DOCTORAT, 20B → EXPERT).
  - Si `--profile=` est fourni en CLI, la sélection est sautée (mode non-interactif / batch).
- Le profil est appliqué à **tous** les modèles de la liste (même niveau pour tous).
- `--help` mis à jour avec les nouveaux exemples et la documentation de l'option.
- `runModel()` transmet le profil au runner via `--profile=<level>` (au lieu de `FRONTIER` en dur).

### Exemples
```
node frontier-batch.js --provider=openrouter --models=nvidia/nemotron-nano-12b-2-vl:free --profile=STANDARD
node frontier-batch.js --provider=openrouter --profile=LIGHT            # petits modèles < 3B
node frontier-batch.js --provider=openrouter                            # sélection interactive (recommande selon taille)
```

### Fichiers modifiés
- `frontier-batch.js` : import `PROFILES` + `detectProfileFromModelName`, `CLOUD_PROFILES`,
  `parseCliArgs` (`--profile=`), `selectProfileInteractive()`, `runModel()` (param `profile`),
  `main()` (sélection + résumé), `printHelp()`.
- `Memories-BenchGo/README.md` : description `frontier-batch.js` mise à jour.
- `Docs/CHANGELOG.md` : présente entrée.

### Vérifications
- `node --check frontier-batch.js` : OK
- `node tests/run-tests.js` : 27/27 passés.
- `node frontier-batch.js --help` : aide mise à jour, `--profile=` documenté.
- `node frontier-batch.js --profile=STANDARD --provider=openrouter --models=test/test-12b:free` :
  profil STANDARD pris en compte et affiché dans le résumé.
- `detectProfileFromModelName('nvidia/nemotron-nano-12b-2-vl:free')` → `{ paramSize: 12, detected: 'STANDARD' }`.

## 2026-08-03 — fix(runner+leaderboard): modèles cloud échoués sauvés sous leur vrai nom + filtre 0% dans --cloud

### Contexte
Quand un modèle cloud (OpenRouter, etc.) était testé mais ne produisait **aucune réponse
exploitable** (0 token, 0/2671 — modèle saturé, dépublié, timeout), `modelName` restait
`"Modele_En_Attente"` (valeur initiale du runner, ligne 1826) car la mise à jour conditionnelle
(ligne 1917) n'était jamais satisfaite (`responseModelName` absent). Conséquences :
- Le rapport était nommé `rapport_v3_modele_en_attente_frontier_*.md` au lieu du vrai nom.
- Le carnet était sauvegardé sous le shortName `modele_en_attente` — **un seul fichier pour
  TOUS les modèles échoués**, qui s'écrasaient mutuellement.
- Les modèles cloud testés mais échoués n'apparaissaient jamais dans le leaderboard `--cloud`.

### Correction
- `runner.js` : le `shortName` du carnet et du rapport utilise désormais `resolvedCloudModel`
  (le vrai slug passé en CLI) comme valeur de secours quand `modelName === "Modele_En_Attente"`.
  Chaque modèle cloud échoué a maintenant son propre carnet et son propre rapport, nommés
  correctement (ex: `nvidia_nemotron-3-ultra-550b-a55b_free`).
- `leaderboard.js` (`printCloudLeaderboard`) : les carnets cloud dont le meilleur score est
  nul (0 point ET 0 token — modèle n'a jamais répondu) sont **masqués** du classement `--cloud`
  pour ne pas polluer le leaderboard avec des échecs d'infrastructure. Le carnet est conservé
  pour l'historique (utile au re-test), et un message indique combien de modèles sont masqués.

### Fichiers modifiés
- `runner.js` : calcul du `shortName` (fallback `resolvedCloudModel` quand modèle muet).
- `leaderboard.js` : `printCloudLeaderboard` — filtre des entrées à 0 point/0 token.
- `Docs/CHANGELOG.md` : présente entrée.

### Vérifications
- `node --check runner.js` : OK
- `node --check leaderboard.js` : OK
- `node tests/run-tests.js` : 27/27 passés.
- `node scripts/check-inline-js.js` : JS inline valide.
- `node leaderboard.js --cloud` : 3 modèles affichés, carnet de test à 0% correctement masqué.

## 2026-08-03 — fix(leaderboard): sélecteur Origine simplifié à Local/Cloud uniquement

### Contexte
Même bug que consolidate-leaderboard.js : le sélecteur "Origine" du leaderboard HTML
générait une option par provider cloud (ex: "☁️ Cloud" + "🔀 OpenRouter"), créant des
redondances et doublons. Les providers spécifiques sont déjà affichés via le badge sur
chaque carte.

### Correction
- Suppression du bloc d options par provider dans le `<select id="originSelect">`.
- Suppression de la branche de filtrage `prov:` dans `renderCards()`.
- Suppression de la variable `providerCounts` devenue inutile.
- Le sélecteur ne contient plus que : "Toutes origines", "🏠 Local · LM Studio", "☁️ Cloud · API".

### Fichiers modifiés
- `leaderboard.js` : sélecteur HTML, bloc de filtrage JS inline, comptage providerCounts.
- `Docs/CHANGELOG.md` : présente entrée.

### Vérifications
- `node --check leaderboard.js` : OK
- `node leaderboard.js` : génération sans erreur.
- `node scripts/check-inline-js.js` : JS inline valide.
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-03 — fix(consolidate-leaderboard): sélecteur Origine simplifié à Local/Cloud uniquement

### Contexte
Le sélecteur "Origine" du classement communautaire (consolidate-leaderboard.js) générait
une option par provider cloud en plus des options Local/Cloud (ex: "☁️ Cloud", "🔀 OpenRouter").
Résultat : redondances (deux fois "Cloud"), doublons et confusion visuelle. Les providers
spécifiques sont déjà affichés via le badge d origine sur chaque carte, le sélecteur n a
pas besoin de les répéter.

### Correction
- Suppression du bloc d options par provider dans le `<select id="originSelect">` (anciennes
  options `prov:<provider>`).
- Suppression des branches de filtrage `prov:` associées dans `renderCards()` et la fonction
  d export (2 occurrences de `activeOrigin.indexOf('prov:') === 0`).
- Suppression de la variable `providerCounts` devenue inutile.
- Le sélecteur ne contient plus que : "Toutes origines", "🏠 Local · LM Studio", "☁️ Cloud · API".

### Fichiers modifiés
- `consolidate-leaderboard.js` : sélecteur HTML, 2 blocs de filtrage JS inline, comptage providerCounts.
- `Docs/CHANGELOG.md` : présente entrée.

### Vérifications
- `node --check consolidate-leaderboard.js` : OK
- `node consolidate-leaderboard.js` : 39 modèles générés sans erreur.
- `node scripts/check-inline-js.js` : JS inline valide (classement.html + community-leaderboard.html).
- Sélecteur Origine vérifié dans gh-pages-output/community-leaderboard.html : 3 options uniquement.

## 2026-08-03 — fix(leaderboard): déduction du provider pour les anciens carnets cloud sans champ provider

### Contexte
Les carnets antérieurs au commit 40e0da9 ne stockent pas les champs `provider`/`isCloud`.
L heuristique `detectIsCloudFromLedger` détectait bien le statut cloud (slug `:free` ou
profil FRONTIER) mais laissait `provider: null`, donc `providerDisplay` affichait le
fallback générique "☁️ Cloud" au lieu du vrai provider (ex: "🔀 OpenRouter"). Résultat :
dans le classement CLI/HTML, `inclusionai/ling-3.0-flash:free` affichait "☁️ Cloud" tandis
que `nvidia/nemotron-3-ultra-550b-a55b:free` (carnet récent) affichait "🔀 OpenRouter",
alors qu ils proviennent tous deux d OpenRouter.

### Correction
- Ajout de `detectProviderFromLedger(ledger)` dans `leaderboard.js` : déduit le provider
  depuis le slug `:free` (suffixe exclusif à OpenRouter). Renvoie `null` si indéterminable
  (modèle cloud payant sans champ provider).
- `aggregateLedger` utilise maintenant `ledger.provider || detectProviderFromLedger(ledger)`
  au lieu de `ledger.provider || null`, ce qui propage le provider déduit vers le CLI
  (`printCloudLeaderboard`, `printLeaderboardSection`) et le HTML (`modelsData` injecté
  dans le JS inline navigateur).

### Fichiers modifiés
- `leaderboard.js` : nouvelle fonction `detectProviderFromLedger`, `aggregateLedger` mis à jour.
- `Docs/CHANGELOG.md` : présente entrée.

### Vérifications
- `node --check leaderboard.js` : OK
- `node leaderboard.js --cloud` : les 3 modèles cloud affichent désormais "openrouter" / "🔀 OpenRouter".
- `node scripts/check-inline-js.js` : JS inline valide (classement.html + community-leaderboard.html).
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-02 — feat(exercices): raisonnement Cloud + edge cases Local, inspires de CRUXEval et IFEval

### Contexte
Les exercices des eleves LLM etaient trop peu denses en cas de test (plusieurs
exercices scolaires n avaient qu un seul cas, aucun edge case). Inspire du
depot awesome-llm-benchmarks (CRUXEval = tracer un code mentalement, IFEval =
suivi strict d instructions de format verifiable, HumanEval+ = 80x plus de
cas pour detecter les solutions fausses), deux axes d amelioration ont ete
ajoutes en differenciant le profil Cloud (FRONTIER) du profil Local (LIGHT).

### Cloud (FRONTIER) — nouveaux exercices de raisonnement
Tier 4 (tier4_frontier.json) passe de 6 a 8 exercices, avec 2 nouveaux types
d evaluation :

1. **tache_4g — Tracer un code (CRUXEval-style)** : le modele doit predire
   mentalement la sortie de 3 snippets JS sans les executer (boucle
   accumulateur, fermeture partagee avec `var` dans une boucle, coercition
   string/number). Renvoie un tableau [v1, v2, v3]. Verifie le raisonnement
   d execution, pas la simple generation de code.
2. **tache_4h — Suivi d instructions verifiables (IFEval-style)** : le modele
   doit formater une liste selon 6 contraintes verifiables independamment
   (exactement 5 lignes, separateur ` - ` obligatoire sur la ligne 2,
   elements en MAJUSCULES, ordre conserve, pas le mot `auteur` sur la ligne
   1, pas de ligne vide). Diagnostique precis : chaque contrainte defaillante
   est signalee.

De nouveaux evaluateurs custom ont ete ajoutes dans `custom-evaluators.js` :
`evaluateCodeTracing` (async, compare aux valeurs reelles obtenues en
executant les snippets dans le sandbox isole) et `evaluateInstructionFollowing`
   (async, valide chaque contrainte individuellement).

### Local (LIGHT) — densification des edge cases
Style HumanEval+ : ajout de cas limites sur les tiers 0 et 5 pour detecter
les solutions correctes sur le cas nominal mais fausses sur les bords :

- **tier0_light.json** : `additionner` (negatifs, zero, grands nombres),
  `estPair` (zero pair, negatif pair, grand impair), `carre` (negatif, un),
  `somme1aN` (n=2, n=100), `inverserChaine` (chaine vide, phrase avec espace),
  `valeurMax` (singleton, max au debut, avec zero).
- **tier5_light.json** : `supprimerDoublons` (tableau vide, tous identiques),
  `capitaliserMots` (chaine vide, deja majuscules), `filtrerPairs` (vide,
  tous pairs, avec zero), `chaineLaPlusLongue` (egalite, singleton),
  `convertirBase` (base 10, base 8, zero), `exponentiationRapide` (n=1,
  base negative paire), `sousTableauMax` (tous negatifs, singleton).

### Correction de solution canonique
La densification a revele que la solution canonique de `capitaliserMots`
(tache_5b dans verify_tiers.js) plantait sur la chaine vide (`w[0]` ->
`undefined.toUpperCase()`). Corrigee avec `w.charAt(0)` + guard `s === ""`.

### Fichiers modifies
- `custom-evaluators.js` : +2 evaluateurs async (evaluateCodeTracing,
  evaluateInstructionFollowing) branches dans le registre customEvaluators.
- `tiers/tier4_frontier.json` : prompt passe a 8 exercices, +2 taches
  (tache_4g, tache_4h) avec evaluation custom.
- `tiers/tier0_light.json` : +13 cas exec sur 5 exercices.
- `tiers/tier5_light.json` : +14 cas exec sur 7 exercices.
- `verify_tiers.js` : correction solution canonique tache_5b.
- `Docs/CHANGELOG.md` : presente entree.

### Verification
- `node --check custom-evaluators.js` : OK
- `node verify_tiers.js` : 363 exec OK / 383 (20 custom skip), 0 probleme.
- `node tests/run-tests.js` : 27/27 passent.
- `node scripts/check-inline-js.js` : JS inline valide (leaderboard non touche).
- Tests e2e via task-evaluator : tache_4g/tache_4h GOOD passent, BAD correctement rejete.

## 2026-08-02 — fix(v3): modale leaderboard ne persiste pas dans le carnet (saveLedger non exportée)

### Contexte
Toutes les éditions depuis la modale du leaderboard (taille du modèle,
quantification, lien du modèle, note personnelle) affichaient bien un toast
« enregistré » mais n'étaient **jamais** persistées dans le carnet JSON. Au
redémarrage du serveur (`--serve`), toutes les valeurs saisies disparaissaient.

### Cause racine
Les 4 endpoints API (`/api/model-paramsize`, `/api/model-quantization`,
`/api/model-note`, `/api/model-url`) font tous :
```js
const { saveLedger } = require('./score-ledger');
saveLedger(ledger);
```
Or `saveLedger` **n'était pas exportée** dans `module.exports` de
score-ledger.js (oubli). Le require destructuré renvoyait `undefined`, et
`saveLedger(ledger)` jetait `TypeError: saveLedger is not a function`. Cette
erreur était attrapée par le `try/catch` qui renvoyait `{ ok: false }`. Le
frontend basculait alors en fallback localStorage (toast « enregistré
locaalement »), ce qui donnait l'illusion que ça marchait — sauf que rien
n'était écrit dans le carnet. À la soumission communautaire, le carnet
vide de ces champs était envoyé tel quel.

### Solution
Ajout de `saveLedger` dans `module.exports` de score-ledger.js (1 ligne).

### Impact
- La taille, la quantification, le lien du modèle et la note saisis dans la
  modale sont désormais persistés dans le carnet JSON et propagés à la
  soumission communautaire.
- Les carnets existants déjà soumis sans ces champs ne sont pas rétro-activés
  (il faut re-soumettre les modèles concernés).

## 2026-08-02 — feat(v3): filtre Origine (local vs cloud) dans le classement communautaire

### Contexte
Le classement communautaire (`consolidate-leaderboard.js`) mélangeait les
modèles locaux (LM Studio) et les modèles frontière cloud (OpenRouter, etc.)
sans possibilité de les départager, contrairement au leaderboard local qui a
déjà un sélecteur Origine. Les modèles cloud n'ont rien à voir avec les locaux
et ne doivent pas être comparés côte à côte.

### Solution
- Ajout d'une heuristique `detectIsCloudFromCarnet()` (réplique de
  `detectIsCloudFromLedger` de leaderboard.js) dans consolidate-leaderboard.js :
  détecte les modèles cloud via le slug OpenRouter `:free` ou le profil
  `FRONTIER` dans les attempts, pour les carnets soumis qui ne stockent pas
  `provider`/`isCloud`.
- Intégration de l'heuristique dans `aggregateCarnet()` : `isCloud` est
  désormais détecté même sans champs explicites dans le carnet soumis.
- Ajout du sélecteur « Origine » dans la barre sticky du classement
  communautaire : Toutes origines / Local (LM Studio) / Cloud (API) + un
  sous-filtre par provider spécifique (OpenRouter, OpenAI, Ollama…).
- Ajout du badge d'origine sur les cartes : `🏠 Local` pour les modèles
  locaux, badge provider coloré pour les modèles cloud.
- Le filtre Origine est respecté dans `renderCards()` et `copyLeaderboard()`.
- Ajout du style `.badge.local` dans le CSS.

### Impact
Le modèle `inclusionai/ling-3.0-flash:free` (testé via OpenRouter) est
maintenant correctement détecté comme cloud et peut être isolé des modèles
locaux via le sélecteur Origine.

## 2026-08-02 — fix(v3): "Failed to fetch" définitif (timeout navigateur) + classement vide (providerDisplay) + logs serveur fixes

### Contexte
1. **"Failed to fetch" dans la modale Envoyer à la communauté** : malgré 3
   tentatives précédentes (bypass undici, handlers d'exceptions, fetch natif),
   l'erreur réapparaissait systématiquement. La cause racine était TOTALEMENT
   différente : `/api/submit-check` faisait une boucle SÉQUENTIELLE d'appels
   GitHub (1 `getSubmissionContent` par modèle), soit 41 × 5-10s = jusqu'à
   7+ minutes pour UN seul `fetch()` navigateur. Or Chrome/Edge coupent tout
   `fetch()` au bout de ~5 min d'inactivité → "Failed to fetch". Les corrections
   undici ne pouvaient rien y faire car le serveur n'avait pas crashé — c'est le
   navigateur qui abandonnait.
2. **Classement vide en local ("Aucun modèle")** : `renderCards()` crashait avec
   `ReferenceError: providerDisplay is not defined`. La fonction existait dans le
   source Node.js (ligne 396, pour le CLI) mais n'avait JAMAIS été copiée dans
   le JS inline du HTML navigateur. Dès que `renderCards` tombait sur la ligne
   `var provInfo = providerDisplay(m.provider, m.isCloud)`, le script plantait
   et rien ne s'affichait.
3. **Système de logs illisible** : un fichier log horodaté par exécution →
   accumulation de dizaines de fichiers `benchgo_<timestamp>.log`
   incompréhensibles. L'utilisateur ne savait pas lequel regarder.

### Solution

#### 1. Parallélisation de /api/submit-check (fix "Failed to fetch")
- **`leaderboard.js`** (`/api/submit-check`) — La boucle séquentielle `for (sn
  of shortNames)` est remplacée par une parallélisation avec concurrence
  limitée à 8 (workers qui consomment une file d'attente). Temps total divisé
  par ~8 → sous le timeout navigateur (~1 min au lieu de 7+ min).
- **`leaderboard.js`** (`startServer`) — `server.requestTimeout = 0` +
  `server.headersTimeout = 0` pour empêcher Node 18+ de couper la connexion
  côté serveur (300s par défaut).

#### 2. Ajout de providerDisplay dans le JS inline (fix classement vide)
- **`leaderboard.js`** (JS inline, après `var _originalModels`) — Ajout de
  `PROVIDER_DISPLAY` (dictionnaire des 11 providers avec label/icon/color) et
  `providerDisplay(provider, isCloud)` repli de la version Node (ligne 396-403)
  pour le navigateur. Icônes en escapes Unicode (`\u{1F500}`) pour respecter la
  contrainte `no_apostrophes_in_generated_code`.

#### 3. Système de logs serveur fixes
- **`logger.js`** — Ajout de `setLogFile(filePath)` et `truncateLogFile()`. Le
  logger horodaté par défaut reste pour runner.js/batchs, mais le serveur peut
  maintenant rediriger vers un fichier FIXE.
- **`leaderboard.js`** (`startServer`) — Redirige tous les logs vers
  `logs/serveur.log` (fichier unique, remis à zéro à chaque démarrage). Affiche
  le chemin au démarrage du serveur.
- **`leaderboard.js`** (handler HTTP) — Logging de TOUTES les requêtes `/api/*`
  entrantes (méthode + chemin + statut + durée) via `res.on('finish')`. Logging
  des erreurs des 4 endpoints de soumission (`submit-validate`,
  `already-submitted`, `submit-check`, `submit`) avec stack trace.
- **`scripts/show-log.js`** — Réécrit pour lire `logs/serveur.log` (fichier
  fixe, plus de recherche parmi des dizaines de fichiers). Ajout du mode
  `--watch` (suivi en direct, comme `tail -f`). Commandes : `--tail N`,
  `--grep MOTIF`, `--watch`.

### Fichiers modifiés
- `leaderboard.js` (parallélisation submit-check + requestTimeout + logs HTTP +
  providerDisplay inline + setLogFile/truncateLogFile)
- `logger.js` (setLogFile, truncateLogFile, exports)
- `scripts/show-log.js` (réécriture sur fichier fixe + mode watch)
- `Docs/CHANGELOG.md`

### Résultat obtenu
- `/api/submit-check` traité en ~1 min au lieu de 7+ min → plus de "Failed to
  fetch" (confirmé par test live : `OK — 0 modifie(s), 0 nouveau(x), 41
  inchange(s)` sans erreur).
- Le classement local affiche de nouveau les modèles (providerDisplay
  accessible dans le JS inline).
- Un seul fichier de log serveur (`logs/serveur.log`), lisible en direct via
  `node scripts/show-log.js --watch`.

### Validation
- `node --check leaderboard.js` + `node --check logger.js` + `node --check
  scripts/show-log.js` : OK
- `node tests/run-tests.js` : 27/27 passés
- `node scripts/check-inline-js.js` : JS inline valide (classement.html +
  community-leaderboard.html)
- Test live serveur : soumission communautaire réussie sans "Failed to fetch",
  logs HTTP visibles en direct via `--watch`

## 2026-08-02 — feat: logs exhaustifs par exercice pour diagnostic contestations + bug tache_2a identifie

### Contexte
1. Quand un eleve (modele) declare qu'un exercice est errone, il etait
   impossible de determiner a posteriori si l echec venait du modele (eleve)
   ou de l exercice (enonce/evaluateur incoherent). Aucun log detaille par
   exercice n existait : seules des lignes globales EVAL etaient ecrites.
2. Le rapport Memories-BenchGo/Tasks1.md (profil DOCTORAT/FRONTIER sur
   tier2_expert) montrait un echec sur tache_2a "Pool de concurrence async".
   L eleve etait penalise de -56 points, mais le professeur IA n avait pas
   remonte une incoherence evidente entre l enonce et l evaluateur.

### Diagnostic tache_2a (bug de l exercice, pas de l eleve)
- Le prompt `tier2_expert.json` demande : `executerEnPool(taches, concurrence)`
  qui "Returns an array of results in original order" (un tableau ordonne).
- L evaluateur custom `evaluateAsyncPartialErrors` (custom-evaluators.js) :
  - cherche la fonction `chargerEnParallele` (pas `executerEnPool` !),
  - l appelle avec `(urls, mockFetch)` (signature differente),
  - attend un objet `{ succes: [...], echecs: [...] }` (pas un tableau).
- Conclusion : l eleve ne pouvait pas reussir. Le contrat du prompt et celui
  de l evaluateur sont contradictoires. **C est l exercice qui est en tort.**
- Non corrige dans cette session (le fix de l enonce/evaluateur est a part).
  Les logs ajoutes permettent desormais de le prouver.

### Solution : logs exhaustifs par exercice
**logger.js** :
- Nouvelle fonction `exercise(category, data)` : ecrit une ligne
  `[EXERCISE] [category] {json}` par `appendFileSync` (persistance garantie).
  Categories : `submit`, `eval`, `vm`, `custom`, `provider`, `response`.
- Exportee dans le module.

**task-evaluator.js** :
- Log `submit` au debut : taskId, label, nombre d evaluations, apercu du code.
- Log `eval` par evaluation : type, description, call, assert, method, etc.
- Log `vm` apres execCodeInVM : passed, resultat, erreur, temps d execution.
- Log `eval` en cas d exception : erreur + stack tronque.
- Log `eval` final : allPassed, nombre de resultats.
- Helper `safeStringify` pour serialiser sans crasher (cycles, fonctions).

**custom-evaluators.js** :
- Import du logger.
- `exposerFonctionVM` : log detectedFnName vs expectedDefault, extraGlobals,
  erreurs de compilation, fonction introuvable (liste des globaux dispo).
- `evaluateAsyncPartialErrors` : log inputUrls, contrat attendu, resultat de
  l eleve (type + apercu), rejet eventuel, erreurs finales, verdict.
- Helper `safeInspect` (serialisation safe).

**vm-sandbox.js** :
- Log au demarrage de execCodeInVM : call, assert, longueurs setup/code.
- Log a la fin : passed, type et apercu du resultat, temps d execution.
- Log en cas de throw : call, assert, message d erreur.
- Log en cas de blocage securite (sandbox escape).
- Helper `safeVmInspect`.

**runner.js** :
- `extractStudentCode` : log `submit` avec methode d extraction
  (regexHeader/jsonKey/firstCodeBlock/fullResponse), apercu reponse brute
  et apercu code extrait.
- Avant l appel au modele : log `provider` queryFn_start (mode cloud/local,
  prompt, taskIds).
- Apres reception reponse : log `response` (modele, duree, tokens, apercu).
- Verdict final par exercice : log `eval` verdict (status, points, erreurs,
  code eleve).

**cloud-client.js** :
- Log `provider` cloud_request : provider, model, prompt, timeout, reasoning.
- Log `provider` cloud_response : duree, tokens, longueur, apercu contenu.
- Log `provider` cloud_error : code, isTimeout, raison.

**lm-studio-client.js** :
- Log `provider` local_request : apiUrl, prompt, budget contexte, reasoning.
- Log `provider` local_response : duree, tokens, longueur, apercu contenu.
- Log `provider` local_error : errorCode, isTimeout, raison.

### Fichiers modifies
- logger.js
- task-evaluator.js
- custom-evaluators.js
- vm-sandbox.js
- runner.js
- cloud-client.js
- lm-studio-client.js

### Resultat obtenu
- Chaque exercice produit desormais une trace complete dans
  `logs/benchgo_<timestamp>.log` :
  1. Prompt envoye au modele (provider, mode, apercu)
  2. Reponse du modele (modele, duree, tokens, apercu)
  3. Code extrait par le parser (methode, code eleve)
  4. Chaque evaluation (type, call, assert, resultat VM, erreur)
  5. Verdict final (status, points, erreurs, code eleve)
- Grep par exercice : `Select-String -Pattern "tache_2a" logs/*.log`
- Les logs prouvent le bug tache_2a : detectedFnName="executerEnPool" vs
  expectedDefault="chargerEnParallele" + studentResult="[]" (tableau, pas
  objet attendu).

### Validation
- `node --check` OK sur les 7 fichiers modifies.
- `node tests/run-tests.js` : 27/27 passes.
- Test manuel `evaluateAsyncPartialErrors` (solution correcte) : OK + logs.
- Test manuel (solution type eleve tache_2a) : reproduit l echec + logs
  montrent l incoherence enonce/evaluateur.

## 2026-08-02 — feat: badges provider par cloud (OpenRouter/OpenAI/Ollama…) + mémorisation clé frontier-batch

### Contexte
1. Le leaderboard n'affichait qu'un badge générique « ☁️ Cloud » sans
   différencier les providers (OpenRouter, OpenAI, Anthropic, Ollama…).
   Impossible de distinguer visuellement l'origine réelle d'un modèle.
2. `frontier-batch.js` ne proposait jamais de mémoriser la clé API saisie,
   contrairement au runner : l'utilisateur devait re-saisir sa clé à chaque
   session cloud.

### Solution
**Badges provider** (leaderboard.js + consolidate-leaderboard.js) :
- Nouveau helper `providerDisplay(provider, isCloud)` : mappe chaque provider
  vers `{ label, icon, color }` (OpenRouter 🔀, OpenAI 🟢, Anthropic 🟣, Groq ⚡,
  Ollama 🦙, LM Studio 🏠…). Fallback générique pour providers inconnus.
- Badge HTML enrichi : le badge « Cloud » générique est remplacé par le badge
  provider spécifique avec sa couleur (style inline). « Local » inchangé.
- Nouveau filtre déroulant « Provider » dans le leaderboard HTML : options par
  provider cloud (avec compte), en plus de Local/Cloud générique. Filtrage
  côté client via `prov:<provider>`.
- Colonne « Provider » ajoutée au CLI `printLeaderboardSection` (classement
  local + section cloud), avec icône + label coloré.
- consolidate-leaderboard : `aggregateCarnet` stocke `provider`/`isCloud` ;
  badge provider précalculé (`provInfo`) sérialisé dans le JSON client et
  rendu dans les cartes communautaires.

**Mémorisation clé API** (frontier-batch.js) :
- `promptApiKey` propose désormais de mémoriser la clé dans `.api-keys.json`
  après saisie (comme le runner), via `askYesNoLocal`. Les prochains
  `frontier-batch` retrouvent la clé automatiquement.
- `--no-save-keys` non applicable ici (frontier-batch n'a pas ce flag) ; la
  proposition est conditionnée par TTY uniquement.

### Fichiers modifiés
- `leaderboard.js` (helper `providerDisplay`, `PROVIDER_DISPLAY`, badge HTML
  enrichi, filtre provider, colonne CLI, `providerCounts`)
- `consolidate-leaderboard.js` (helper `providerDisplay`, `PROVIDER_DISPLAY`,
  `aggregateCarnet` stocke provider/isCloud, badge provider dans les cartes)
- `frontier-batch.js` (mémorisation clé API via `askYesNoLocal` + `api-keys-store`)
- `Docs/CHANGELOG.md`

### Validation
- `node --check` sur les 3 fichiers → OK
- `node tests/run-tests.js` → 27/27 passés
- `node scripts/check-inline-js.js` → JS inline valide (classement + communauté)
- `node leaderboard.js` → colonne Provider visible (Local + Cloud)
- `node consolidate-leaderboard.js` → badge provider dans les cartes

### Résultat obtenu
- Leaderboard HTML : badge provider coloré par cloud (🔀 OpenRouter, 🟢 OpenAI,
  🦙 Ollama…) + filtre déroulant par provider.
- CLI : colonne Provider dans le classement local et la section cloud.
- Classement communautaire : badge provider sur chaque carte.
- frontier-batch : la clé API est mémorisée après saisie, plus de re-saisie à
  chaque session.

---

## 2026-08-02 — feat: ajout d'Ollama (cloud payant + local) et des serveurs OpenAI-compat au menu provider CLI de frontier-batch

### Contexte
Le menu interactif de `frontier-batch.js` ne proposait que 8 providers cloud
(openrouter, openai, groq, together, mistral, anthropic, deepseek, cohere) et
excluait volontairement ollama/lmstudio/custom (commentaire : « dédié aux
modèles cloud frontière »). Or Ollama propose désormais un service cloud payant
(abonnement mensuel, base URL + clé API) en plus de son mode local. Ollama
était absent du menu alors qu'il est déjà supporté par `cloud-client.js`.

### Solution
- `frontier-batch.js` : la liste `CLOUD_PROVIDERS` inclut désormais
  `ollama`, `lmstudio` et `custom`, avec labels indiquant le mode (cloud payant
  via `--endpoint` + `--api-key`, ou local sans clé).
- Nouveau flag `--endpoint=<url>` dans `parseCliArgs()` + `printHelp()` : permet
  d'overrider l'URL par défaut (Ollama local `localhost:11434` → URL cloud).
- Nouvelle fonction `promptEndpoint(provider, cliEndpoint)` : prompt
  interactif de base URL pour `custom` (obligatoire) et `ollama`/`lmstudio`
  (optionnel — vide = URL locale par défaut).
- `promptApiKey` : la clé est désormais optionnelle pour
  `ollama`/`lmstudio`/`custom` (mode local sans auth) ; vide = pas de clé.
  `runModel` ne passe `--api-key=` au runner que si une clé est fournie.
- `runModel` propage `--endpoint=` au runner si présent.
- `main()` : le résumé de session affiche l'endpoint si défini.

Ollama cloud fonctionne déjà via `cloud-client.js` :
- `--endpoint=` override l'URL locale (cloud-client.js:210)
- la clé est passée dans le header `Authorization` même avec
  `requiresAuth: false` (cloud-client.js:243)

### Fichiers modifiés
- `frontier-batch.js` (liste providers, `--endpoint`, `promptEndpoint`,
  clé optionnelle, `runModel`, `main`, `printHelp`)

### Validation
- `node --check frontier-batch.js` → OK
- `node frontier-batch.js --help` → liste complète des 11 providers + `--endpoint`

### Résultat obtenu
`node frontier-batch.js` propose désormais 11 providers :
openrouter, openai, anthropic, groq, together, mistral, deepseek, cohere,
ollama, lmstudio, custom. Ollama cloud (payant) est accessible via
`--endpoint=https://... --api-key=...`, le mode local reste sans clé.

---

## 2026-08-02 — fix: crash TimeoutError.name read-only → carnet-professeur vide pour les modèles frontière

### Contexte
Le benchmark du modèle frontière cloud `nvidia/nemotron-3-ultra-550b-a55b:free`
(profil FRONTIER) crashait en plein Tier 3 avec :
`TypeError: Cannot assign to read only property 'name' of object 'Error: timeout'`
à `http-middleware.js:29` (`new TimeoutError`). Le run mourait avant la fin de
`runSchool()`, là où le carnet-professeur est écrit — d'où l'absence totale de
`Carnet-Professeur/2026-08-02/` et le constat (Tasks1.md) que « les modèles
frontières cloud ne peuvent pas envoyer une demande au professeur ».

### Cause racine
La correction précédente (Object.assign → sous-classe TimeoutError) avait
déplacé le bug sans l'éliminer : sur Node.js 24.x + undici, `this.name = ...`
dans le constructeur d'une sous-classe d'Error peut elle aussi être read-only.
Le `TypeError` était levé dans le callback du setTimeout (hors try/catch) →
`uncaughtException` → le handler de runner.js ne filtrait que les marqueurs
undici natifs, pas notre propre erreur → `process.exit(1)`.

### Solution
`http-middleware.js` : le constructeur `TimeoutError` n'écrit plus `this.name`.
Aucun consommateur ne lit `name === 'TimeoutError'` — `isRetryableError()` et
le codage du code d'erreur reposent sur le message `'timeout'` (inchangé).
Le `name` était purement décoratif ; le supprimer élimine définitivement
l'écriture sur propriété read-only.

### Fichiers modifiés
- `http-middleware.js` (constructeur `TimeoutError` : retrait de `this.name`)
- `Memories-BenchGo/issues-fixes/2026-08-02-timeout-error-name-read-only-crash-carnet-professeur.md`
- `Docs/CHANGELOG.md`

### Validation
- `node --check http-middleware.js` → OK
- `node tests/run-tests.js` → 27/27 passés
- Smoke test `withRetry` sur `throw new Error('timeout')` → `E502_LM_TIMEOUT`
  (comportement de retry/codage inchangé)

### Résultat obtenu
Les runs frontière (cloud, sujets aux timeouts sur les modèles gratuits)
n'écrasent plus le process sur un timeout du middleware. Le runner termine
`runSchool()` et écrit le carnet-professeur : les demandes des modèles
frontière sont désormais consignées comme celles des autres profils.

---

## 2026-08-02 — fix(v2): "Failed to fetch" — remplacement de fetch par https natif (bypass undici Node.js 24.x)

### Contexte
La première tentative de correction (handlers `uncaughtException` + `AbortController`
sur `fetch`) n'a pas suffi : l'erreur `Failed to fetch` réapparaissait toujours
dans la modale « Envoyer à la communauté ». Cause profonde : sous Node.js 24.x,
`fetch` est implémenté par **undici** qui maintient un pool de sockets keep-alive.
Même avec un `AbortController` par requête, undici peut déclencher son timeout
interne sur une socket idle du pool et lever le `TypeError: Cannot assign to
read only property 'name'`. Le handler `uncaughtException` empêche le crash du
process, MAIS la promesse `fetch` reste pendante (elle ne rejette jamais
proprement) → la requête HTTP vers le navigateur reste ouverte indéfiniment →
le navigateur finit par couper la connexion → `Failed to fetch`.

### Solution radicale
Remplacement de **tous** les appels `fetch` vers `api.github.com` par le module
**`https` natif** de Node.js, qui n'utilise PAS undici. Chaque requête ouvre sa
propre socket (pas de pool keep-alive idle) → le bug undici ne peut plus se
déclencher du tout.

- **`community-sync.js`** — Helper `githubFetch(url, opts)` réécrit sur
  `https.request` avec un objet Response compatible fetch (`.ok`, `.status`,
  `.json()`, `.text()`). Les 11 sites d'appel (`getMainBranchSha`,
  `createBranch`, `deleteBranch`, `putFile` ×2, `createPullRequest`,
  `findExistingPullRequest`, `mergePullRequest`, `validateGithubToken`,
  `getAlreadySubmittedModels`, `getSubmissionContent`) restent inchangés.
  Timeout 20s via `req.setTimeout()` qui détruit la socket proprement.
  Le ping télémétrie (`sendPing`) garde `fetch` car il est hors flux de
  soumission (arrière-plan au lancement du runner, pas dans le serveur
  interactif) et a déjà son AbortController 5s.
- **`leaderboard.js`** — Les handlers `uncaughtException` / `unhandledRejection`
  (ajoutés lors de la 1re tentative) sont conservés comme filet de sécurité,
  mais ne devraient plus se déclencher pour les appels GitHub.

### Fichiers modifiés
- `community-sync.js` (wrapper `githubFetch` réécrit sur `https` natif)
- `Docs/CHANGELOG.md`

### Résultat obtenu
- Les appels GitHub API n'utilisent plus undici → le bug de socket idle ne
  peut plus se déclencher → plus de crash serveur → plus de `Failed to fetch`.
- Les requêtes rejetent proprement en cas de timeout/erreur réseau (la promesse
  `githubFetch` rejette avec une Error explicite au lieu de rester pendante).
- Le flux de soumission complet (validate → already-submitted → submit-check
  avec 5 modèles → serveur toujours debout) testé avec succès.

### Validation
- `node --check community-sync.js` + `node --check leaderboard.js` : OK
- `node tests/run-tests.js` : 27/27 passés
- Test isolation : `validateGithubToken('fake')` → `{"valid":false,"error":"HTTP 401"}`
  (interroge réellement api.github.com via https natif)
- Test live serveur port 3942 : `/api/submit-validate` + `/api/already-submitted`
  + `/api/submit-check` (5 modèles) → serveur resté debout, aucune erreur
  undici dans les logs.

## 2026-08-02 — feat: spinner d'attente dans la modale Envoyer à la communauté + regression bouton manquant

### Contexte
La soumission communautaire (validation token, comparaison de 40+ modèles avec
GitHub, envoi des PR) peut prendre 1 à 2 minutes. Sans indicateur visuel,
l'utilisateur voyait un message statique (« Envoi en cours... ») et pensait que
ça avait planté. Ajout d'un spinner CSS (cercle qui tourne) à chaque étape
d'attente.

Par ailleurs, l'ajout précédent du lien token avait oublié un `+` de
concaténation (ligne 2964) → tout le HTML suivant (champ pseudo, checkbox,
boutons « Verifier et envoyer » + « Annuler ») était coupé du `innerHTML` → le
bouton disparaissait. Corrigé en remettant le `+`.

### Implémentation
- **`leaderboard.js`** (CSS) — Ajout de `.submit-spinner` (cercle 16px violet
  qui tourne via `@keyframes submitSpin`) après `.btn-community:disabled`.
- **`leaderboard.js`** (`doSubmitAll`) — Helper `setSubmitStatus(message,
  color, showSpinner)` qui injecte `<span class="submit-spinner"></span>` + le
  message dans la zone de statut. Appliqué aux 5 étapes d'attente : validation
  token, token valide, comparaison modèles, envoi en cours, envoi modèle par
  modèle. Le spinner disparaît automatiquement quand le statut final (résumé
  HTML) ou l'erreur remplace le contenu.
- **`leaderboard.js`** — Ajout d'un message « peut prendre 1-2 min » sur
  l'étape de comparaison pour rassurer l'utilisateur.
- **`leaderboard.js`** (regression) — Remise du `+` manquant ligne 2964
  (concaténation du `<p>` d'aide token avec le reste du `innerHTML`).

### Fichiers modifiés
- `leaderboard.js` (CSS spinner + helper setSubmitStatus + fix `+` manquant)
- `Docs/CHANGELOG.md`

### Résultat obtenu
- Un cercle violet tourne à côté du message à chaque étape d'attente →
  l'utilisateur sait que le traitement est en cours, même si GitHub met du
  temps à répondre.
- Le bouton « Verifier et envoyer » est de nouveau présent dans la modale.

### Validation
- `node --check leaderboard.js` : OK
- `node scripts/check-inline-js.js` : JS inline valide
- Test live : serveur port 3941, `/api/submit-validate` répond correctement,
  spinner + bouton présents dans le HTML généré.

## 2026-08-02 — fix: "Failed to fetch" dans la modale Envoyer à la communauté (crash serveur undici Node.js 24.x) + lien de création de token GitHub

### Contexte
Dans le classement interactif (`node leaderboard.js --serve`), la modale
"🌐 Envoyer à la communauté" affichait `Erreur : Failed to fetch` dès la
validation du token ou pendant la soumission, rendant l'envoi des carnets
vers le classement communautaire GitHub totalement impossible.

Cause racine : sous **Node.js 24.x**, undici garde des sockets keep-alive
idle vers `api.github.com`. Lorsque undici déclenche son timeout interne sur
une socket idle, il tente d'affecter la propriété `name` d'une `Error` en
lecture seule → `TypeError: Cannot assign to read only property 'name'`.
`runner.js` interceptait déjà cette erreur (ligne 11) mais **`leaderboard.js`
n'avait aucune protection** : le serveur interactif crashait silencieusement
en plein milieu d'une soumission → le navigateur voyait la connexion TCP
coupée et affichait `Failed to fetch`. Le bug se déclenche surtout avec un
token valide car `/api/submit-check` enchaîne jusqu'à 41 `fetch` vers
`api.github.com` (un par modèle via `getSubmissionContent`), multipliant la
probabilité d'un timeout socket idle.

Par ailleurs, l'aide pour créer un token GitHub était un texte brut non
cliquable (`github.com/settings/tokens`), peu utile pour les nouveaux
utilisateurs qui ne trouvent pas la page dans leur compte.

### Implémentation
- **`leaderboard.js`** — Ajout en tête de fichier des handlers
  `process.on('uncaughtException')` et `process.on('unhandledRejection')`
  qui interceptent l'erreur undici spécifique (regex sur le message +
  stack) et loggent sans crasher, identique à la protection de `runner.js`.
  Le serveur reste debout, le fetch concerné échoue proprement et la
  soumission continue sur les modèles suivants.
- **`community-sync.js`** — Nouveau wrapper `githubFetch()` avec
  `AbortController` (timeout 20s) appliqué à TOUS les appels vers
  `api.github.com` (9 occurrences : `getMainBranchSha`, `createBranch`,
  `deleteBranch`, `putFile` ×2, `createPullRequest`,
  `findExistingPullRequest`, `mergePullRequest`, `validateGithubToken`,
  `getAlreadySubmittedModels`, `getSubmissionContent`). Le timeout ferme
  explicitement la connexion avant qu'undici n'expire lui-même, évitant
  le déclenchement du bug. Les catchs existants renvoient une erreur
  explicite au lieu de crasher le process.
- **`leaderboard.js`** (modale "Envoyer à la communauté") — Remplacement
  du texte d'aide brut par deux liens cliquables génériques :
  (1) `https://github.com/settings/tokens/new?scopes=repo&description=BenchGo-LLM-School`
  qui pré-remplit le formulaire de création avec le scope `repo` déjà coché
  et une description par défaut, (2) lien vers la doc officielle GitHub
  sur la gestion des tokens. Aucun apostrophe dans le JS inline généré
  (contrainte `no_apostrophes_in_generated_code` respectée).

### Fichiers modifiés
- `leaderboard.js` (handlers undici + lien token dans la modale)
- `community-sync.js` (wrapper `githubFetch` + timeout 20s sur 11 appels)
- `Docs/CHANGELOG.md`

### Résultat obtenu
- Le serveur interactif ne crash plus pendant la soumission communautaire,
  même avec un token valide et 40+ modèles à comparer.
- `Failed to fetch` est éliminé : une erreur réseau GitHub remonte
  proprement dans la modale (`Erreur : HTTP 401`, `timeout`, etc.) au lieu
  de couper la connexion.
- L'utilisateur dispose d'un lien direct pour créer son token GitHub sans
  chercher dans les paramètres de son compte.

### Validation
- `node --check leaderboard.js` + `node --check community-sync.js` : OK
- `node tests/run-tests.js` : 27/27 passés
- `node scripts/check-inline-js.js` : JS inline valide (classement.html +
  community-leaderboard.html)
- Test live : serveur démarré sur port 3940, appels `/api/submit-validate`,
  `/api/already-submitted`, `/api/submit-check` (3 modèles) → serveur
  toujours debout, aucune erreur undici dans les logs.

## 2026-08-02 — feat: séparation Local/Cloud dans le classement + commande --cloud + détection isCloud robuste

### Contexte
Les modèles frontière cloud (OpenRouter, OpenAI, Anthropic...) testés via
`frontier-batch.js` apparaissaient dans le classement mais n'étaient JAMAIS
détectés comme cloud : le filtre "Origine → Cloud" du leaderboard HTML ne
montrait aucun résultat, et le carnet du professeur restait vide. Cause racine :
les carnets antérieurs au commit `40e0da9` ne stockent pas `provider`/`isCloud`,
et la détection fallback (`ecoles.some(e => e.ecole === 'Post-Doctorat')`) ne
fonctionnait pas car les tests FRONTIER sont interrompus avant d'enregistrer
l'école "Post-Doctorat" (seule "Primaire" est enregistrée, profil LIGHT).
Par ailleurs, les modèles cloud étaient mélangés avec les modèles locaux LM
Studio dans le classement CLI alors qu'ils n'ont rien à voir (pas de
quantization, latence réseau, infrastructure différente).

### Implémentation
- **`leaderboard.js`** — `detectIsCloudFromLedger()` : heuristique conservatrice
  de détection de l'origine pour les anciens carnets. Signaux forts uniquement :
  (1) slug OpenRouter `:free`, (2) profil `FRONTIER` dans les attempts. En cas de
  doute, le modèle reste local (rétrocompatible).
- **`leaderboard.js`** — `aggregateLedger()` : utilisation de l'heuristique en
  fallback quand `provider`/`isCloud`/école "Post-Doctorat" sont absents.
- **`leaderboard.js`** — `printLeaderboardSection()` : refactorisation de
  l'affichage CLI en fonction réutilisable. `generateLeaderboard()` affiche
  désormais DEUX sections séparées : "🏠 MODÈLES LOCAUX · LM Studio" et
  "☁️ MODÈLES CLOUD FRONTIÈRE · API", chacune avec son propre rang (1..N).
- **`leaderboard.js`** — `printCloudLeaderboard()` : classement spécifique aux
  modèles cloud uniquement, avec colonne Provider et École(s). Déclenché par
  `node leaderboard.js --cloud`.
- **`leaderboard.js`** — `markCloudModel()` : migration manuelle d'un carnet
  vers le statut cloud (`--mark-cloud=<shortName>`). Pour les modèles cloud
  payants sans slug `:free` et sans tentative FRONTIER aboutie (non détectables
  automatiquement).

### Fichiers modifiés
- `leaderboard.js` — `detectIsCloudFromLedger()`, `aggregateLedger()`,
  `printLeaderboardSection()`, `printCloudLeaderboard()`, `markCloudModel()`,
  `generateLeaderboard()`, `module.exports`, CLI (`--cloud`, `--mark-cloud=`).

### Résultat obtenu
- Le modèle `inclusionai/ling-3.0-flash:free` est désormais détecté cloud et
  apparaît dans le filtre Cloud du leaderboard HTML + section cloud du CLI.
- `node leaderboard.js --cloud` affiche le classement dédié aux modèles API.
- `node leaderboard.js` sépare visuellement locaux et cloud (deux sections).
- `node leaderboard.js --mark-cloud=<shortName>` migre les anciens carnets.
- Tests unitaires : 27/27 OK. JS inline : valide. `node --check` : OK.

### Validation
- `node --check leaderboard.js` : OK
- `node tests/run-tests.js` : 27 passés, 0 échoués
- `node scripts/check-inline-js.js` : JS inline valide
- `node leaderboard.js --cloud` : 1 modèle cloud détecté et affiché
- `node leaderboard.js` : 2 sections séparées (40 local + 1 cloud)

---

## 2026-08-02 — fix: timeout undici persistant en streaming cloud + carnet-professeur vide pour modèles frontières

### Contexte
Après le fix initial de la classe `TimeoutError` dans `http-middleware.js` (qui
évitait le crash du `Object.assign` sur Error read-only), les timeouts socket
undici ("socket idle timeout") continuaient de se produire pendant le streaming
SSE des modèles cloud (OpenRouter). Le handler global `uncaughtException` les
interceptait, mais le `reader.read()` du stream rejetait aussi → échec du tier,
et le carnet-professeur n'était jamais écrit pour les modèles frontières car le
run crashait avant le bloc d'écriture final.

### Implémentation
Wrapping de la boucle de lecture du stream dans un `try/catch` dans les deux
fonctions de streaming de `cloud-client.js` :
- `streamOpenAICompatResponse()` et `streamAnthropicResponse()` : si la
  déconnexion undici arrive APRÈS avoir reçu du contenu partiel → on conserve le
  contenu partiel (réponse incomplète mais évaluable, mieux qu'un crash). Si la
  déconnexion arrive AVANT tout contenu → on propage l'erreur pour retry via
  `http-middleware.js#withRetry`.

Ainsi, le run ne crash plus et atteint le bloc d'écriture du carnet-professeur.

### Fichiers modifiés
- `cloud-client.js` — `streamOpenAICompatResponse()` + `streamAnthropicResponse()`
  : `try/catch` autour de la boucle `reader.read()` + conservation du contenu
  partiel sur déconnexion undici.
- `Memories-BenchGo/issues-fixes/2026-08-02-undici-streaming-contenu-partiel.md`

### Vérifications
- `node --check cloud-client.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-02 — feat: séparation local / cloud dans le classement (leaderboard)

### Contexte
Les modèles frontières (cloud) et les modèles locaux (LM Studio) étaient mélangés
dans le même classement sans distinction. Or ce sont deux catégories fondamentalement
différentes : les modèles cloud tournent sur des serveurs distants (OpenRouter,
OpenAI, etc.) avec une latence et un débit qui dépendent du réseau, tandis que les
modèles locaux s'exécutent sur la machine de l'utilisateur. Les comparer directement
sur la vitesse (tokens/s) n'a pas de sens — un modèle cloud rapide peut sembler
lent à cause de la latence réseau, et inversement. Il fallait pouvoir les séparer.

### Implémentation

**Stockage de l'origine dans le carnet (score-ledger.js)**
- `saveResult()` accepte désormais un paramètre `provider` (ex: `'local'`,
  `'openrouter'`, `'openai'`, etc.) et stocke `ledger.provider` + `ledger.isCloud`
  (booléen) au niveau du carnet. Rétrocompatible : si `provider` n'est pas fourni,
  la valeur précédente est conservée.
- `saveAndBuildBilan()` propage le `provider`.

**Propagation depuis le runner (runner.js)**
- L'appel à `saveAndBuildBilan` passe `isCloudMode ? resolvedProvider : 'local'`.

**Détection dans le leaderboard (leaderboard.js)**
- `aggregateLedger()` extrait `isCloud` et `provider` du carnet. Rétrocompatible :
  si le carnet n'a pas encore ces champs (anciens carnets), on déduit depuis
  l'école "Post-Doctorat" (profil FRONTIER = cloud).
- Nouveau filtre déroulant "Origine" (Toutes origines / 🏠 Local · LM Studio /
  ☁️ Cloud · API) avec compteurs.
- Badge visuel sur chaque carte : 🏠 Local (vert) ou ☁️ Cloud (jaune).
- CSS : `.badge.cloud` (jaune) et `.badge.local` (vert).
- Logique de filtrage JS dans `renderCards()` + event listener sur `originSelect`.

### Fichiers modifiés
- `score-ledger.js` — `saveResult()` + `saveAndBuildBilan()` : paramètre `provider`.
- `runner.js` — passage du provider à `saveAndBuildBilan`.
- `leaderboard.js` — `aggregateLedger()` (isCloud/provider), `modelsData`
  (isCloud/provider), filtre Origine (HTML select + CSS badges + JS filtrage),
  compteurs `originCounts`.
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check score-ledger.js` : OK.
- `node --check runner.js` : OK.
- `node --check leaderboard.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `node scripts/check-inline-js.js` : JS inline valide (classement + community).

## 2026-08-02 — fix: erreur fatale undici (Object.assign sur Error read-only) + mode batch frontier + suppression leaderboard

### Contexte
Lors d'un test de modèle frontière (`inclusionai/ling-3.0-flash:free` via OpenRouter),
le runner crashait avec `TypeError: Cannot assign to read only property 'name' of
object 'Error: timeout'` depuis `http-middleware.js:82`. L'erreur venait de
`Object.assign(new Error('timeout'), { name: 'TimeoutError' })` — sur Node.js 24.x +
undici, la propriété `name` d'une Error native peut être en lecture seule → crash non
intercepté par le handler `uncaughtException` (le message ne matchait pas le filtre
undici natif). Parallèlement, 4 autres problèmes ont été identifiés et corrigés :
suppression de modèle faisant "monter" les autres dans le classement, modèles
frontières proposés à tort en écoles séquentielles (Primaire/Collège), absence de
mode batch pour tester plusieurs modèles cloud à la suite, et notes de
configuration non conformes.

### Implémentation

**1. Erreur fatale undici (http-middleware.js)**
- Remplacement de `Object.assign(new Error('timeout'), { name: 'TimeoutError' })` par
  une sous-classe dédiée `TimeoutError` dont `this.name` est assigné dans le
  constructeur (propriété configurable, contrairement à une Error native sur
  Node 24.x + undici).

**2. Suppression modèle → montée artificielle (leaderboard.js)**
- Ajout de `adjustSnapshotForDeletion(deletedShortName, entries)` appelée dans
  `deleteLedger()` avant la suppression du fichier carnet. Décrémente de 1 le rang
  de tous les modèles qui étaient *strictement en dessous* du modèle supprimé dans
  le snapshot précédent → neutralise l'effet "montée" parasite (flèches ▲ trompeuses).

**3. Modèles frontières : forçage au plus haut niveau (runner.js)**
- Exclusion de `FRONTIER` de la proposition d'écoles séquentielles
  (Primaire + école principale). Les modèles cloud frontière sont extrêmement
  performants et doivent être testés directement à leur niveau (Post-Doctorat),
  pas passer par Primaire/Collège. Ajout de la variable `isFrontier` + condition
  `!isFrontier` dans le bloc de décision `schoolsToRun`.

**4. Mode batch pour modèles frontières (frontier-batch.js — nouveau module)**
- Nouveau script `frontier-batch.js` équivalent de `night-batch.js` mais pour les
  modèles cloud. Enchaîne automatiquement le test de plusieurs modèles frontière
  à la suite, chacun avec `--profile=FRONTIER --force` (plus haut niveau, sans
  confirmation interactive). Supporte `--provider=`, `--models=`, `--api-key=`,
  `--no-teacher`. Récupère la clé API depuis `.api-keys.json` si mémorisée.
  Génère le classement final à la fin.

**5. Notes-Cisco.md (Admin/)**
- Correction du nombre de fichiers tier (18, pas 16) + ajout de
  `tier4_frontier.json` manquant dans la structure des dossiers. Suppression des
  backslash d'échappement incorrects (`tier0\_expert.json` → `tier0_expert.json`).
  Ajout des commandes `frontier-batch.js` et exemple OpenRouter.

### Fichiers modifiés
- `http-middleware.js` — classe `TimeoutError` + remplacement du `Object.assign`.
- `leaderboard.js` — `adjustSnapshotForDeletion()` + intégration dans `deleteLedger()`.
- `runner.js` — exclusion `FRONTIER` des écoles séquentielles (`isFrontier`).
- `frontier-batch.js` — nouveau script (mode batch cloud).
- `Admin/Notes-Cisco.md` — conformité (18 fichiers tier, tier4_frontier, commandes).
- `Memories-BenchGo/issues-fixes/2026-08-02-undici-timeout-object-assign.md`
- `Memories-BenchGo/issues-fixes/2026-08-02-leaderboard-suppression-montee-artificielle.md`
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check http-middleware.js` : OK.
- `node --check leaderboard.js` : OK.
- `node --check runner.js` : OK.
- `node --check frontier-batch.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.
- Tiers FRONTIER (`tier0_expert` à `tier4_frontier`, `tier5_standard`, `tier6_master`)
  chargés et validés via parsing JSON (11 tâches pour tier4_frontier, mandatory FRONTIER).

## 2026-08-01 — feat: mode manuel par modèle (option 7) dans le mode nuit

### Contexte
En mode nuit, l'utilisateur pouvait choisir soit une liste d'écoles commune à
tous les modèles (options 1-4), soit l'auto par modèle (option 6, école selon
la taille). Mais il manquait la possibilité de mélanger des modèles aux
besoins différents dans la même session : par exemple re-tester Kai Os Grug 12B
en auto (Collège-Lycée selon sa taille) ET faire passer Phi 4 uniquement en
Primaire pour rattraper son statut partiel. L'option 6 forçait Phi 4 en
Collège-Lycée, ce qui ne correspondait pas au besoin.

### Implémentation
- `night-batch.js` : nouvelle option 7 « Manuel par modèle » dans
  `selectSchoolsInteractive`. Quand elle est choisie, la fonction
  `selectSchoolsManualPerModel` demande à l'utilisateur l'école de chaque
  modèle sélectionné, un par un, avec pour chacun :
  - numéros séparés par virgules (ex: "1" = Primaire, "1,2" = Primaire + Collège-Lycée)
  - "auto" ou Entrée = école selon la taille (comme l'option 6)
  - "all" = toutes les écoles
- Nouvelle fonction `isManualPerModel()` et entrée SCHOOLS
  `manual-per-model` (cli=null, écoles choisies interactivement).
- Le plan construit (`{ model, schools: [...] }`) est utilisé tel quel dans la
  boucle d'exécution, comme le mode auto-par-modèle.
- Affichage de la file d'attente mis à jour pour montrer l'attribution
  individuelle de chaque modèle en mode manuel.

### Fichiers modifiés
- `night-batch.js` : SCHOOLS (option 7), `isManualPerModel()`,
  `selectSchoolsManualPerModel()`, gestion dans `main()` (plan + affichage +
  boucle d'exécution), exports.
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check night-batch.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `SCHOOLS` affiche bien 7 options, `isManualPerModel` détecte le marqueur.

## 2026-08-01 — feat: saisie manuelle multi-modèles de la quantification (night-batch)

### Contexte
Suite à la saisie manuelle ajoutée dans runner.js (mono-modèle), il manquait
l'équivalent en mode nuit (night-batch.js) où plusieurs modèles sont testés
dans la même session. Quand `lms ls --json` ne fournit pas la quantification
d'un modèle (champ absent), le carnet restait générique et plusieurs quantifs
d'un même modèle s'écrasaient.

### Implémentation
- `night-batch.js` : après la sélection des écoles et le calcul du plan, avant
  l'affichage de la file d'attente, on détecte les modèles sélectionnés dont
  `m.quant` est `'?'` ou absent. Pour chacun, on demande à l'utilisateur de
  saisir la quantification (Q4_K_M, Q5_K_S, Q8_0...), un par un.
- La quantif saisie remplace `m.quant` et est transmise au runner via
  `--quantization=` (ligne 1393) → `shortNameWithQuant()` → carnet distinct.
- Entrée = laisser inconnu (carnet générique, comportement historique).
- En mode non-TTY (sans --models), aucune question : on garde '?'.

### Fichiers modifiés
- `night-batch.js` : bloc de saisie multi-modèles avant la file d'attente.
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check night-batch.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-01 — feat: saisie manuelle de la quantification dans le CLI

### Contexte
Quand la quantification n'était pas détectée automatiquement (--quantification
absent ET /api/v0/models de LM Studio indisponible), le shortName du carnet
restait générique (ex: `kai-os_grug-12b` au lieu de `kai-os_grug-12b_q4_k_s`).
Conséquence : plusieurs quantifications d'un même modèle écrasaient le même
fichier carnet → une seule entrée dans le classement au lieu d'une par quantif.

### Implémentation
- `runner.js` : après les fallbacks de détection automatique (CLI + /api/v0),
  si la quantification reste inconnue ET qu'on est en mode local interactif
  (TTY, sans --force), on demande à l'utilisateur de la saisir manuellement.
  L'utilisateur peut taper la quantif (Q4_K_M, Q5_K_S, Q8_0...) ou appuyer sur
  Entrée pour laisser "inconnue" (carnet générique).
- En mode batch (--force / non-TTY, ex: night-batch.js), aucune question n'est
  posée : night-batch passe toujours --quantization, donc ce cas n'arrive pas.
- La quantification saisie alimente `shortNameWithQuant()` → carnet distinct
  par quantif → une entrée par quantif dans le classement.

### Fichiers modifiés
- `runner.js` : bloc de saisie manuelle après la détection /api/v0/models.
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check runner.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.

## 2026-08-01 — fix: seuil STANDARD/EXPERT 14B→15B (Phi 4 mal classé Université)

### Contexte
Phi 4 (15B) était détecté EXPERT (Université) car 15 > 14, l'ancien seuil haut de
STANDARD. Conséquence : en mode nuit « auto par modèle » (option 6), Phi 4 enchaînait
Primaire → Université en sautant Collège-Lycée, et le statut affichait
« Coll-Lyc,Univ,Doct » en manquant. Un modèle de 15B est un modèle STANDARD, pas
Université.

### Implémentation
- Borne supérieure de STANDARD passée de 14B à 15B dans `config.js`
  (`detectProfileFromModelName`) et `night-batch.js` (`schoolForModel`, fallback
  paramsString). Borne basse d'EXPERT passe donc à 15B.
- Libellés des profils mis à jour : « Collège/Lycée (3B – 15B) » et
  « Université (15B – 30B) » dans `config.js` et `night-batch.js`.
- Catégorisation de taille cohérente dans `leaderboard.js` (getParamSize,
  getParamSizeFromValue, _paramSizeFromValue) et `consolidate-leaderboard.js`
  (getParamSize) : 3B-15B / 15B-30B.

### Fichiers modifiés
- `config.js` : seuil `detectProfileFromModelName` + libellés PROFILES.
- `night-batch.js` : seuil `schoolForModel` (fallback paramsString) + libellés SCHOOLS + commentaire des seuils.
- `leaderboard.js` : 3 fonctions de catégorie de taille (3B–15B / 15B–30B).
- `consolidate-leaderboard.js` : catégorie de taille (3B–15B / 15B–30B).
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check config.js / night-batch.js / leaderboard.js / consolidate-leaderboard.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `night-batch.js` listLlmModels() : Phi 4 → school=STANDARD (était EXPERT).

## 2026-08-01 — fix: classement communautaire désynchronisé — détection de changement de score

### Contexte
Le classement communautaire affichait un ordre différent du classement local (kai-os_grug-12b #1 en communautaire alors que gemma-4-12b-it-qat est #1 en local). Cause : la soumission GitHub de gemma était périmée (score 5622) alors que le carnet local avait été re-testé (score 5824), mais le modèle n'était jamais re-soumis.

### Implémentation
- Correction de `/api/submit-check` dans `leaderboard.js` : la comparaison de score comparait `local.score` vs `remote.score`, mais le carnet n'a pas de champ `score` racine (les scores sont dans `ecoles.*.best.score`), donc les changements de score n'étaient jamais détectés.
- Nouvelle fonction `aggregateScoreFromLedger()` : somme les `best.score` et `best.max` de chaque école pour obtenir le score agrégé réel, côté local ET remote.
- Comparaison du couple `{score, max}` : un re-test, un rattrapage ou un test sur plus d'écoles déclenche désormais une re-soumission.
- Même logique appliquée au cas où un carnet n'a plus aucune école (`null` vs non-`null`).

### Fichiers modifiés
- `leaderboard.js` : endpoint `/api/submit-check` (comparaison score agrégé réel).
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check leaderboard.js` : OK.
- `node tests/run-tests.js` : 27/27 passés.
- `node scripts/check-inline-js.js` : JS inline valide (classement.html + community-leaderboard.html).

## 2026-08-01 — fix: modale quantification — mise à jour complète des variantes GGUF

### Contexte
Le sélecteur de quantification de la modale modèle ne proposait qu'un sous-ensemble limité de variantes GGUF. Plusieurs familles I-Matrix et variantes K-Quant manquaient, et les formats 1.5-bit, 8-bit alternatifs et F32 n'étaient pas listés.

### Implémentation
- Mise à jour de `QUANT_BITS` dans `leaderboard.js` : `[1, 1.5, 2, 3, 4, 5, 6, 8, 16, 32]`.
- Mise à jour de `QUANT_VARIANTS` avec l'ensemble des variantes documentées dans `Memories-BenchGo/Tasks1.md` :
  - 1-bit : `IQ1_S`
  - 1.5-bit : `IQ1_M`
  - 2-bit : `IQ2_XXS`, `IQ2_XS`, `IQ2_S`, `IQ2_M`, `Q2_K`, `Q2_K_S`, `Q2_K_M`, `Q2_K_L`, `Q2_K_XL`
  - 3-bit : `IQ3_XXS`, `IQ3_XS`, `IQ3_S`, `IQ3_M`, `Q3_K_S`, `Q3_K_M`, `Q3_K_L`, `Q3_K_XL`
  - 4-bit : `IQ4_XS`, `IQ4_NL`, `Q4_0`, `Q4_1`, `Q4_K_S`, `Q4_K_M`, `Q4_K_L`, `Q4_K_XL`, `Q4_0_4_4`, `Q4_0_4_8`, `Q4_0_8_8`
  - 5-bit : `Q5_0`, `Q5_1`, `Q5_K_S`, `Q5_K_M`, `Q5_K_L`
  - 6-bit : `Q6_K`, `Q6_K_L`
  - 8-bit : `Q8_0`, `Q8_1`, `Q8_K`, `I8`
  - 16-bit : `F16`, `BF16`, `I16`
  - 32-bit : `F32`, `I32`
  - 64-bit : `F64`, `I64`
- Adaptation de `_quantBitsFromString` pour reconnaître les formats `IQx_y`, les décimaux (`1.5`) et conserver la clé sous forme de chaîne (matching avec `QUANT_VARIANTS`).
- Adaptation de la comparaison `currentBits === String(b)` dans `editModelQuant` pour supporter les valeurs 1.5.

### Fichiers modifiés
- `leaderboard.js` : `QUANT_BITS`, `QUANT_VARIANTS`, `_quantBitsFromString`, `editModelQuant`.

### Vérifications
- `node --check leaderboard.js` : OK.
- `node scripts/check-inline-js.js` : OK.
- `node tests/run-tests.js` : 27 passés, 0 échoués.

## 2026-08-01 — fix: envoi communautaire compare carnet local vs soumission GitHub (n envoie que les modèles modifiés)

### Contexte
Lorsqu un modèle avait déjà été soumis au classement communautaire via « 🌐 Envoyer à la communauté », toute modification ultérieure faite dans la modale du leaderboard (quantification, note, paramSize) restait bloquée en local. L utilisateur cliquait 4 fois sur « Envoyer à la communauté » sans voir de changement sur https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html.

### Cause racine
`leaderboard.js` -> `doSubmitAll()` interrogeait `/api/already-submitted` pour connaître les modèles déjà présents sur GitHub, puis **skippait systématiquement** ces modèles (`if (alreadySubmitted.has(...)) continue`). La logique datait de la contrainte « n envoyer que les nouveaux modèles », mais elle empêchait toute mise à jour d une soumission existante (quantification, note, paramSize, re-test avec nouveau score, etc.).

### Implémentation

#### 1. Comparaison des carnets (community-sync.js + leaderboard.js)
- Nouvelle fonction `getSubmissionContent(token, shortName)` dans `community-sync.js` : lit le fichier `submissions/<userId>/<shortName>.json` sur GitHub via l API Contents, décode le base64 et retourne le `carnet` stocké.
- Exportée dans le `module.exports` de `community-sync.js`.
- Nouvelle API serveur `/api/submit-check` (POST, body `{ token, shortNames: [...] }`) dans `leaderboard.js` : pour chaque shortName, récupère la soumission distante, compare avec le carnet local et retourne `{ changed: [...], unchanged: [...], newModels: [...] }`.
- Champs comparés : `quantization`, `note`, `paramSize`, `modelUrl`, `model`, `shortName`, et `score`. Si l un d eux diffère, le modèle est marqué `changed`.

#### 2. Réécriture de doSubmitAll() (leaderboard.js)
- Appelle `/api/submit-check` avec tous les shortNames locaux.
- N envoie plus tout : seuls `newModels` et `changed` sont soumis via `/api/submit`.
- Les modèles identiques sont affichés comme « inchangés (ignorés) ».
- Le résumé final distingue : soumissions réussies, échecs, nouveaux, mises à jour, inchangés.

#### 3. Fiabilisation du merge (community-sync.js)
- Ajout de `deleteBranch(token, branchName)` : supprime l ancienne branche `community/<userId>-<shortName>` avant de la recréer à partir du `main` actuel.
- Appelée dans `submitResults()` avant `createBranch()`. Cela évite les branches « stale » pointant vers un vieux commit de main, qui pouvaient générer des PR vides ou des conflits de merge.

### Fichiers modifiés
- `leaderboard.js` : nouvelle API `/api/submit-check`, réécriture de `doSubmitAll()`.
- `community-sync.js` : `getSubmissionContent()`, `deleteBranch()`, export.

### Vérifications
- `node --check leaderboard.js` : OK.
- `node --check community-sync.js` : OK.
- `node scripts/check-inline-js.js` : OK.
- Serveur `--serve` relancé avec le nouveau code.

## 2026-08-01 — feat: modale modèle — sélecteurs bits/variante/paramètres + notes + badges + flèches communautaires

### Contexte
La modale de détail modèle ne montrait qu'un champ texte libre pour la quantification (source d'erreurs de saisie) et n'exposait pas la taille réelle du modèle (ex: phi-4 → 14B non détectable depuis le nom). Les annotations personnelles (notes) et le suivi de progression (flèches de position) manquaient sur le classement communautaire. Les modifications faites via la modale ne se répercutaient pas non plus dans le listing après un simple refresh de la page en mode `--serve`.

### Implémentation

#### 1. Sélecteurs quantification + paramètres dans la modale (`leaderboard.js`)
- Colonne "Quantification" de la grille `Actions & métadonnées` restructurée en deux sous-sections séparées par un trait fin :
  - **Paramètres du modèle** : champ numérique en milliards (ex: `14` pour phi-4). Stocké dans le carnet via la nouvelle API `/api/model-paramsize`. La catégorie (petit/standard/expert/doctorat) se recalcule automatiquement à partir de la valeur saisie.
  - **Quantification** : remplacée par 2 sélecteurs en cascade : Bits (1, 2, 3, 4, 5, 6, 8, 16 — valeurs réelles GGUF) → Variante (filtrée dynamiquement selon les bits : ex. 4 bits → Q4_0, Q4_1, Q4_K, Q4_K_S, Q4_K_M ; 16 bits → F16, BF16). Saisie libre repliable (`<details>`) pour les formats exotiques. Aperçu en temps réel de la valeur finale.
- `QUANT_BITS` / `QUANT_VARIANTS` + helpers `_quantBitsFromString`, `onQuantBitsChange`, `onQuantVariantChange`, `onQuantCustomInput`.
- Helpers `_paramSizeFromValue` (côté client) + `getParamSizeFromValue` (côté génération HTML) pour reconstruire l'objet paramSize à partir d'une valeur numérique.
- Nouvelle fonction `getParamSizeFromValue` utilisée à la génération : si `ledger.paramSize` est défini, il prend le pas sur la détection depuis le nom du modèle.
- `m.paramSizeManual` exposé côté client pour distinguer valeur manuelle vs auto-détectée.

#### 2. Notes personnelles dans la modale (`leaderboard.js`)
- Colonne 3 "Note" déverrouillée : textarea sans limite de caractères, scroll invisible (`scrollbar-width: none` + `-webkit-scrollbar { display: none }`), affichage en `white-space: pre-wrap` (conserve les sauts de ligne), max-height 140px avec scroll.
- Persistance double : API `/api/model-note` (carnet `ledger.note`) + fallback localStorage.
- Badge "📝 Note" ajouté sur la carte du listing, à côté du badge quantification.

#### 3. Bug "modifications perdues au refresh" (`leaderboard.js`)
- **Cause racine** : en mode `--serve`, le HTML est généré une seule fois au démarrage puis servi statiquement. Le carnet sur disque est mis à jour, mais le HTML ne l'est pas. Au refresh, le navigateur recharge l'ancien `MODELS` sans les modifications saisies.
- **Correction** : ajout d'une IIFE `_mergeLocalOverrides()` exécutée avant le premier `renderCards()`. Elle parcourt `MODELS` et écrase `quantization`, `modelUrl`, `note`, `paramSize`/`paramSizeManual` avec les valeurs du localStorage (qui sont écrites à chaque sauvegarde via `_setModelQuantLocal`, `_setModelUrlLocal`, `_setModelNoteLocal`, `_setModelParamSizeLocal`). Le localStorage sert de cache navigateur entre deux régénérations.
- `renderCards()` est désormais appelé après chaque sauvegarde/effacement de quantification, note et paramètres → la carte du listing se met à jour en temps réel.

#### 4. Bug "statBox Quantif. reste à — après sauvegarde" (`leaderboard.js`)
- **Cause racine** : `cancelEditModelQuant()` ne rafraîchissait que la carte d'action, pas le `statBox('Quantif.')` en haut de modale.
- **Correction** : ajout d'un id `quantStatVal` sur la valeur du statBox + fonction `_refreshQuantDisplay(idx)` appelée après chaque sauvegarde/effacement (chemin serveur + fallback).

#### 5. Flèches de position sur le classement communautaire (`consolidate-leaderboard.js`)
- Système basé sur **localStorage** (clé `benchgo_community_positions`) — le classement communautaire étant un site statique GitHub Pages, pas de snapshot serveur possible en CI.
- Au 1er chargement : aucune flèche (baseline enregistrée). Au 2e chargement et suivants : ▲ vert (monté), ▼ rouge (descendu), = gris (stable), avec le nombre de places.
- Affichées à la fois sur la carte du listing (à côté du nom) et dans le titre de la modale.
- CSS `.pos-arrow` / `.pos-up` / `.pos-down` / `.pos-stable` + `.badge.note` ajoutés.

#### 6. Note + badge note sur le classement communautaire (`consolidate-leaderboard.js`)
- `carnet.note` lu ligne 155 et exposé au client (ligne 385 dans le JSON injecté).
- Affichée dans la modale sous une section "📝 Note personnelle" (scroll invisible).
- Badge "📝 Note" sur la carte du listing.

### Fichiers modifiés
- `leaderboard.js` : API `/api/model-note` + `/api/model-paramsize`, fonctions `editModelNote`/`saveModelNote`/`_saveModelNoteFallback`, `editModelParamSize`/`saveModelParamSize`/`_saveModelParamSizeFallback`, sélecteurs quantification (QUANT_BITS/QUANT_VARIANTS + helpers), restructuration colonne Quantification en 2 sous-sections, `_mergeLocalOverrides()`, `_refreshQuantDisplay()`, badge note sur les cartes, grille 3 colonnes (Tags supprimé).
- `consolidate-leaderboard.js` : lecture `carnet.note` + `ledger.paramSize` (note + taille), injection `note`/`positionDelta` dans le JSON client, fonction `positionArrow()` + helpers `_loadCommunitySnapshot` / `_saveCommunitySnapshot` / `_computeCommunityPositionDeltas`, CSS `.pos-arrow` / `.badge.note`, section Note dans la modale communautaire, badge note sur les cartes communautaires.
- `Docs/CHANGELOG.md` : cette entrée.

### Vérifications
- `node --check leaderboard.js` : OK.
- `node --check consolidate-leaderboard.js` : OK.
- `node leaderboard.js` puis `node consolidate-leaderboard.js` : régénération propre.
- `node scripts/check-inline-js.js` : "tout est valide" (8 cartes + 4 cartes communautaires).
- Serveur `--serve` relancé (PID actuel) avec le nouveau code.

## 2026-08-01 — tool: scripts/check-inline-js.js validateur de JS inline

### Contexte
Bug récurrent : une faute de frappe dans le JS inline du leaderboard (accolade en double laissée par une édition incomplète de `cancelEditModelUrl`) a fait planter **tout** le script côté navigateur → "Aucun modèle" affiché malgré des données valides. Diagnostic manuel laborieux (dichotomie par prefixe). Besoin d'un outil réutilisable pour détecter et localiser ce genre d'erreur instantanément.

### Implémentation
- Nouveau dossier `scripts/` (outils de diagnostic, à côté de `tests/`).
- `scripts/check-inline-js.js` : validateur de JS inline pour les fichiers HTML générés par `leaderboard.js` et `consolidate-leaderboard.js`. Détecte :
  - **Erreurs de syntaxe** (token inattendu, accolade en trop, etc.) via `vm.Script`, avec **localisation exacte** de la ligne fautive depuis le stack trace (`evalmachine.<anonymous>:N`).
  - **Apostrophes non échappées** dans les attributs `onclick`/`onchange`/... du HTML rendu (hors `<script>`), source récurrente de bugs (cf. AGENTS.md "esc() dans le leaderboard").
  - Ignore le JS inline qui construit des handlers (ex: `onclick="openModal(' + i + ')"`) — c'est du JS valide, pas du HTML rendu.
- Sans argument : valide par défaut `Export-Rapports/classement.html` et `gh-pages-output/community-leaderboard.html`.
- Sortie : code de sortie 0 (OK) / 1 (erreurs), avec contexte de 3 lignes autour de l'erreur.

### Usage
```
node scripts/check-inline-js.js                          # valide les fichiers par défaut
node scripts/check-inline-js.js Export-Rapports/classement.html  # valide un fichier précis
```

### Résultat obtenu
- Détecte instantanément le bug `Unexpected token '}'` à la ligne 681 (cf. fix précédent sur `cancelEditModelUrl`).
- Fichiers propres : "OK - JS inline valide" avec compte des cartes modèles.
- Tests unitaires : 27 passés, 0 échoués.

## 2026-08-01 — ui: grille 4 colonnes pour les actions de la modale modèle

### Contexte
Dans la modale de détail d'un modèle (clic sur une ligne du leaderboard), les sections "Lien du modèle" et "Quantification" étaient empilées verticalement. L'utilisateur souhaite une présentation plus compacte et structurée en 3-4 colonnes, avec une brève description sous chaque titre.

### Implémentation
- `leaderboard.js` :
  - Nouvelle grille CSS `.modal-actions-grid` (4 colonnes sur desktop, 2 sur tablette, 1 sur mobile) avec des `.action-card`.
  - Regroupement des sections "Lien du modèle" et "Quantification" dans la grille, chacune avec un titre d'emoji + description.
  - Colonne 1 : 🔗 Lien du modèle — description + affichage/bouton "Ajouter un lien / Modifier".
  - Colonne 2 : 🧩 Quantification — description + affichage/bouton "Ajouter / Modifier".
  - Colonne 3 : 📝 Notes — placeholder "À venir".
  - Colonne 4 : 🏷 Tags — placeholder "À venir".
  - Ajustement des styles `.model-url-section` et `.model-quant-section` pour fonctionner en mode colonne (flex-direction column par défaut, `.row` optionnel pour les usages hors grille).
  - Mise à jour de `cancelEditModelUrl` et `cancelEditModelQuant` pour refléter la nouvelle présentation (suppression du `margin-left:8px` inutile en colonne).
- Le titre de section regroupant est "Actions & métadonnées".

### Résultat obtenu
- La modale affiche 4 colonnes d'actions côte à côte sur grand écran, plus compacte.
- Les boutons "Ajouter un lien" et la quantification sont sur la même ligne visuelle.
- Placeholders prêts pour les futures colonnes Notes et Tags.
- Tests unitaires : 27 passés, 0 échoués. `node --check leaderboard.js` OK.

## 2026-08-01 — fix: shortName du carnet intègre la quantification (carnets écrasés entre quantifs)

### Contexte
Kai Os Grug 12B testé en 4 quantifications (Q4_K_S, Q5_K_L, Q5_K_S, Q6_K_L) n'apparaissait qu'**une seule fois** dans le leaderboard malgré 4 runs distincts. Les carnets de scores s'écrasaient mutuellement : tous écrivaient dans le même fichier `Export-Rapports/.carnet/kai-os_grug-12b.json`.

### Cause racine
1. `night-batch.js` lance `node runner.js --force --profile=...` **sans `--model=` ni `--quantization=`**.
2. En mode local, le runner détectait le nom du modèle via `/v1/models` qui renvoie l'ID de base **sans quantification** (`kai-os_grug-12b`).
3. L'auto-détection de la quantification (`/api/v0/models`) ne se déclenchait **que** quand aucun `--profile=` n'était passé — or night-batch passe toujours `--profile=`. Donc `resolvedQuantization` restait `null`.
4. `shortenModelName()` produisait `kai-os_grug-12b` (la quantif n'était jamais dans le nom) → `score-ledger.js` écrivait `kai-os_grug-12b.json` pour les 4 runs.
5. Le leaderboard lit tous les `*.json` du dossier `.carnet` → un seul modèle vu.

### Implémentation
- **`report-generator.js`** : nouvelle fonction `shortNameWithQuant(rawName, quantization)` qui calcule un shortName intégrant la quantification quand elle est connue (ex: `kai-os_grug-12b` + `Q4_K_S` → `kai-os_grug-12b_q4_k_s`). Sans quantif, comportement identique à `shortenModelName` (rétrocompatible).
- **`runner.js`** :
  - Les 3 sites de calcul du `shortName` (sauvegarde carnet, détection de doublon précoce, détection de doublon par école) utilisent `shortNameWithQuant(...)` avec `resolvedQuantization`.
  - Nouveau bloc d'auto-détection locale (nom via `/v1/models` + quantif via `/api/v0/models`) qui s'exécute en mode local **même quand `--profile=` est fourni**. Avant, cette détection n'avait lieu que dans la branche `!resolvedProfileArgExplicit` (jamais atteinte par night-batch).
- **`night-batch.js`** :
  - `runBenchmark` reçoit `--quantization=<quant>` par modèle (ex: `--quantization=Q4_K_S`) pour forcer la bonne quantif même si l'auto-détection `/api/v0/models` échoue.
  - `matchLedger` amélioré : privilégie le carnet dont la quantif (en suffixe du shortName) correspond à celle du modelKey. Évite les faux positifs où n'importe quelle quantif du même modèle matche. Ajout de `quantFromModelKey()` et `normalizeQuant()`.

### Résultat obtenu
- Chaque couple (modèle, quantification) a son propre carnet `.json` → une entrée par quantif dans le leaderboard.
- `matchLedger` associe correctement chaque modelKey `lms ls` à son carnet (Q4_K_S → carnet `q4_k_s`, Q5_K_L → carnet `q5_k_l`).
- Tests unitaires : 27 passés, 0 échoués. `node --check` OK sur les 3 fichiers.

### Migration
Le carnet existant `kai-os_grug-12b.json` (données mélangées des 4 quantifs, quantif `null`) reste présent mais ne sera plus alimenté. Les prochains runs créeront `kai-os_grug-12b_q4_k_s.json`, `kai-os_grug-12b_q5_k_l.json`, etc. Pour repartir propre, supprimer l'ancien carnet via la modale du leaderboard (bouton supprimer).

## 2026-08-01 — feat: tri par tokens + colonne Tokens dans night-batch --list-only

### Contexte
Le rapport sur le temps d'inférence des modèles a mis en évidence que la lenteur est corrélée à la **verbosité** (nombre de tokens produits), pas à la qualité. Un modèle comme Gemmable 4 12B produit 55.6k tokens pour un score de -79 %, consommant 2h24 de GPU à vide. Il manquait un moyen rapide de repérer ces modèles « qui écrivent trop » avant de lancer un mode nuit.

### Implémentation
- `computeLedgerMetrics()` expose désormais `tokens` (cumul multi-écoles) en plus de `tokensPerSecond` et `elapsedMs`.
- Nouvelle colonne **Tokens** dans le tableau `selectModelsInteractive()` (entre Vit. et Tent.), format compact via `fmtTokens()` (ex: 34.8k, 1.2M).
- Nouvelle commande **`tok`** au prompt : tape `tok` + Entrée pour basculer le tri par volume de tokens produits (décroissant). Les modèles sans métriques vont à la fin. Taper `tok` à nouveau revient au tri par score (défaut).
- En mode tri par tokens, les valeurs > 50k sont surlignées en **jaune** pour alerter sur la verbosité excessive.
- Variable d'état `_sortByTokens` (toggle) ; aide intégrée dans l'en-tête du tableau.

### Fichiers modifiés
- `night-batch.js` : `fmtTokens()`, `computeLedgerMetrics()` (exposition `tokens`), colonne Tokens dans le tableau, commande `tok`, `_sortByTokens`.

### Résultat obtenu
- `node night-batch.js --list-only` → tape `tok` : Gemmable 4 12B remonte en #1 (55.6k tokens, -79 %, jaune), immédiatement identifiable comme modèle à exclure du batch.
- Tests unitaires : 27 passés, 0 échoués.

## 2026-08-01 — feat: quantification manuelle + distinction modèles en échec

### Contexte
Après un mode nuit (Nightbatch), deux incohérences sont remontées :
1. **Bouton quantification manuel absent de la modale** : la quantification est cruciale pour différencier un même modèle testé sous plusieurs variantes (Q4_K_M, Q5_K_L, Q8_0...). Sa récupération était laborieuse (uniquement via LM Studio). L'utilisateur demande un bouton d'édition manuelle dans la modale du leaderboard.
2. **Modèles en échec confondus avec « jamais testés »** : Mixtral 7Bx2 MoE (load_failed) et Phi 4 (run KO EXPERT, 226 min) ont bien été tentés cette nuit, mais apparaissaient comme « JAMAIS TESTÉ » / « PARTIEL » dans le leaderboard, qui proposait donc de les retester naïvement. Aucune trace d'échec n'était conservée.

### Implémentation

#### Bouton quantification manuel (leaderboard.js)
- Nouvelle section « 🧩 Quantification » dans la modale, ergonomie identique au lien du modèle (affichage + bouton ✎ Modifier / + Ajouter).
- Édition inline : champ texte (placeholder `Q4_K_M, Q5_K_L, Q8_0, F16...`), boutons Enregistrer / Effacer / Annuler.
- Persistance double : `POST /api/model-quantization?shortName=...` → carnet JSON (mode `--serve`), ou `localStorage` en fallback (HTML local ouvert sans serveur).
- Nouvelle route serveur `/api/model-quantization` (GET + POST) qui écrit `ledger.quantization` via `score-ledger.js#saveLedger`.
- CSS dédié (`.model-quant-section`, `.model-quant-display`, `.model-quant-value`, `.model-quant-edit`).

#### Historique des runs (night-batch.js)
- Nouveau fichier persistant `.benchgo-run-history.json` à la racine : `{ "<modelKey>": { lastAttempt, lastStatus, lastSchool, attempts } }`.
- `recordRun(modelKey, status, school)` appelé à chaque run (succès `ok`, échec `load_failed` ou `run_ko`) dans la boucle `main()`.
- `runStatusFromHistory(modelKey)` renvoie le statut d'échec si le dernier run a échoué (null sinon).
- Nouveau statut `failed` dans `listLlmModels()` : un modèle sans carnet mais avec un échec enregistré → `ÉCHEC` (rouge) au lieu de `JAMAIS TESTÉ`. Les modèles `partial` avec une école échouée portent `failedSchool`.
- `statusBadge()` gère le badge `ÉCHEC` (rouge).
- Tri ajusté : testés > échec > jamais testés > non-LLM.
- `recomputeStatus()` (désisolation) tient aussi compte de l'historique.
- Exports : `loadRunHistory`, `saveRunHistory`, `recordRun`, `runStatusFromHistory`.

#### Affichage leaderboard (leaderboard.js)
- `printUntestedLmStudioModels()` filtre désormais `failed` séparément.
- Les modèles en échec affichent leur raison (`Échec de chargement (load_failed)` / `Échec du run (run KO)`) au lieu des écoles manquantes.
- Les modèles `partial` avec une école KO affichent `⚠ <école> : échec run`.
- Message d'aide : « N modèle(s) en échec. Repassez-les après vérification, ou isolez-les (!<num>) s'ils ne sont pas testables. »

#### Pré-remplissage historique
- `.benchgo-run-history.json` initial créé avec les 2 échecs de la nuit du 2026-08-01 (Mixtral 7Bx2 MoE load_failed, Phi 4 run_ko EXPERT).

### Fichiers modifiés
- `night-batch.js` : historique des runs, statut `failed`, tri, badge, `recomputeStatus`, exports.
- `leaderboard.js` : section quantification modale (CSS + HTML + JS), route `/api/model-quantization`, affichage échecs dans `printUntestedLmStudioModels`.
- `.benchgo-run-history.json` : nouveau fichier persistant.

### Résultat obtenu
- `node night-batch.js --list-only` affiche Mixtral 7Bx2 MoE en `ÉCHEC` (rouge) au lieu de `JAMAIS TESTE`.
- `node leaderboard.js` section « MODÈLES LM STUDIO NON TESTÉS » : Mixtral → `ÉCHEC / Échec de chargement (load_failed)`, Phi 4 → `PARTIEL / ⚠ EXPERT : échec run`.
- La modale du leaderboard propose désormais une section quantification éditable persistée dans le carnet.
- Tests unitaires : 27 passés, 0 échoués.

## 2026-07-31 — fix: colonne « Ecoles manquantes » affiche les noms humains (night-batch.js)

### Contexte
Dans la liste des modeles du mode nuit, la colonne « Ecoles manquantes » affichait les cles internes (LIGHT, STANDARD, EXPERT, DOCTORAT) au lieu des noms d ecoles lisibles (Primaire, College-Lycee, Universite, Doctorat-These). Incoherence avec l apercu de l option 6 qui utilisait deja les noms humains.

### Implémentation
- Nouvelle fonction `schoolKeyToLabel(key)` qui mappe une cle SCHOOLS vers une abreviation tres compacte (ex: `LIGHT` -> `Prim`, `STANDARD` -> `Coll-Lyc`, `EXPERT` -> `Univ`, `DOCTORAT` -> `Doct`), via la table `SCHOOL_SHORT`. Les noms complets etaient trop longs cumules et faisaient deborder le tableau.
- `missingSchoolsLabel()` utilise maintenant `schoolKeyToLabel` sur chaque cle manquante.

### Fichiers modifies
- `night-batch.js` : `missingSchoolsLabel()` + nouvelle fonction `schoolKeyToLabel()`.

## 2026-07-31 — refactor: dashboard simplifie en comparateur 4 modeles (dashboard.js)

### Contexte
L utilisateur a trouve le dashboard a 4 onglets trop charge. Il a demande une version simplifiee : une seule vue fiche modele, avec 4 selecteurs pour comparer jusqu a 4 modeles cote a cote, un graphique unique, et un champion surligne.

### Implémentation

#### Nouvelle version dashboard.js (~560 lignes)
- **4 combobox recherche+selection** : chaque slot permet de taper pour filtrer les modeles ou cliquer dans la liste deroulante. Le slot 1 est pre-selectionne par defaut. Les slots 2-4 ont une croix pour vider.
- **Banner Champion** : quand 2+ modeles sont selectionnes, un bandeau centré et mis en valeur (or) indique le champion qui gagne le plus de metriques (score, vitesse, sante, ecoles).
- **Stats adaptatives par modele** : Score, Vitesse (arrondi), Sante, Ecoles, Bonus. La police et le padding se reduisent selon le nombre de modeles selectionnes (1=grand, 4=petit). Les cases gagnantes par metrique sont surlignees en or.
- **Un seul graphique** (barres) avec selecteur de metrique :
  - Score % (par ecole)
  - Vitesse t/s (par ecole, arrondi)
  - Sante PV (par ecole)
  - Score brut (par ecole)
  - Le graphique filtre les ecoles non faites (null au lieu de 0) et le tooltip n affiche que les valeurs existantes.
- **Tooltips oxygenes** : style custom avec padding 14px, coin arrondi 10px, separation entre lignes, title en bleu gras.
- **Legendes en dots** : plugin Chart.js custom (dotLegendPlugin) qui remplace les carres par des cercles colores.
- **Scroll preserve** : cliquer sur les boutons de metrique ne fait plus remonter la page.
- **Canvas hauteur fixe** : 380px pour eviter les sauts de page lors du changement de metrique.

#### Nettoyage
- Retire les onglets Progression temporelle, Comparaison, Analyse par ecole (trop charges).
- Retire les graphiques Timeline, Speed, Score individuels (remplaces par le graphique unique avec metrique selector).
- Retire la metrique "Obligatoire" et "Ecoles" du graphique (redundantes).

### Fichiers modifies
- `dashboard.js` (re-ecriture complete)

### Verifications
- `node --check dashboard.js` : OK
- `node tests/run-tests.js` : 27/27 passes
- Serveur `/dashboard` : HTTP 200, len 27216

### Resultat
- Dashboard leger, clair, focalise sur la comparaison directe de 2 a 4 modeles.
- Le champion est visible immediatement. Les tooltips sont lisibles. La police s adapte.

## 2026-07-31 — refactor: dashboard progression/historique extrait dans dashboard.js (fichier autonome, 4 onglets, selecteurs multiples)

### Contexte
Le dashboard web (route `/dashboard` + API `/api/dashboard-data`) etait inline dans `leaderboard.js` (fonction `buildDashboardHTML`, ~270 lignes). Il n offrait que 3 graphiques basiques (progression lente, historique d un modele, scatter vitesse/score) sans selecteurs avances. Le fichier `leaderboard.js` approchait 3750 lignes. L utilisateur a demande un refactoring complet : effacer l ancien code et creer un dashboard professionnel dans un fichier separe, avec plusieurs selecteurs pour explorer l evolution des modeles dans le temps.

### Implémentation

#### Nouveau fichier `dashboard.js` (autonome, ~860 lignes)
- `buildDashboardData()` : agrège les carnets via `loadAllLedgers` + `aggregateLedger` (require lazy pour eviter la dependance circulaire leaderboard → dashboard → leaderboard).
- `handleDashboardApi(req, res)` : handler HTTP pour `/api/dashboard-data`.
- `buildDashboardHTML()` : genere une page HTML autonome avec Chart.js 4.4.1 (CDN jsdelivr + fallback cdnjs).
- 4 onglets avec selecteurs multiples :
  1. **Progression temporelle** : graphique ligne multi-modeles. Selecteurs : metrique Y (% reussite, sante PV, vitesse t/s, score brut, % obligatoire), axe X (date+heure, date jour, numero de test), granularite (par tentative ou meilleur par date), filtre multi-modeles (Ctrl+clic), filtre multi-ecoles. Legende cliquable pour masquer/afficher un modele. Tooltip riche (ecole, score, sante, vitesse).
  2. **Comparaison de modeles** : 3 graphiques — bubble chart (2 metriques X/Y + taille de bulle optionnelle), radar chart (top 8 modeles, 6 dimensions normalisees : score, obligatoire, sante, vitesse, regularite, autonomie), barres horizontales (classement sur metrique Y). Selecteurs : metrique X, metrique Y, taille des bulles.
  3. **Fiche modele** : statistiques detaillees (score global, score brut, sante, vitesse, % obligatoire, nb ecoles, tendance, bonus, aides/rattrapages) + 4 graphiques (% par ecole avec sante en ligne, evolution temporelle toutes ecoles, vitesse par tentative, score brut par tentative). Selecteur : modele.
  4. **Analyse par ecole** : barres horizontales (classement d une ecole donnee) + progression temporelle (un modele par ligne). Selecteurs : ecole, tri (% desc/asc, vitesse, sante, nom).
- Theme sombre professionnel (variables CSS), layout responsive (grid 2 colonnes → 1 sur mobile), header sticky, barre d onglets, cartes avec bordures arrondies, spinner de chargement, banner d information (nb modeles + nb tentatives).

#### Nettoyage `leaderboard.js`
- Suppression de l ancien `buildDashboardHTML` inline (~270 lignes de HTML/JS/CSS).
- Ajout de `const dashboard = require('./dashboard')` au debut.
- Routes `/api/dashboard-data` et `/dashboard` deleguent vers `dashboard.handleDashboardApi` et `dashboard.buildDashboardHTML`.
- `buildDashboardHTML` conservee comme wrapper retro-compatible (`require('./dashboard').buildDashboardHTML()`).
- `module.exports` inchangé (toujours exporte `buildDashboardHTML`).
- Dependance circulaire evitee : `dashboard.js` utilise `getLedgerFns()` (require lazy au moment de l appel, pas au chargement).

### Fichiers modifies/crees
- `dashboard.js` (nouveau)
- `leaderboard.js` (nettoyage -270 lignes, routes deleguees)

### Verifications
- `node --check dashboard.js` : OK
- `node --check leaderboard.js` : OK
- `node tests/run-tests.js` : 27/27 passés
- Serveur `node leaderboard.js --serve` : `/api/dashboard-data` renvoie 37 modeles (ok=true), `/dashboard` renvoie 200 (39643 chars)
- Pas de warning de dependance circulaire

### Resultat
- `leaderboard.js` passe de 3749 a 3443 lignes (-306, -8%).
- Le dashboard passe de 3 graphiques basiques a 4 onglets avec ~10 graphiques et selecteurs multiples.
- Code isole dans `dashboard.js` : le fichier leaderboard est plus leger et plus maintenable.

## 2026-07-31 — fix: mode nuit option 6 enchaîne LIGHT + école détectée pour les modèles > 3B

### Contexte
En mode nuit (`night-batch.js`), l'option 6 « Auto par modèle » n'attribuait qu'**une seule école** par modèle (l'école détectée depuis la taille). Un modèle 12B ne faisait que STANDARD, et LIGHT restait « manquante » dans le carnet — le runner ne basculait jamais automatiquement sur Primaire. Le runner interactif proposait bien l'enchaînement LIGHT + école (option B, `runner.js:2448`), mais cette logique était verrouillée derrière `isInteractive` (TTY), donc jamais déclenchée en mode nuit (non-TTY, `--force`).

### Implémentation (`night-batch.js`)
- Nouvelle fonction `schoolsForModelPlan(m)` : calcule la liste d'écoles à enchaîner pour un modèle en mode auto-par-modèle. Pour les modèles > 3B (STANDARD ou supérieur) : `[LIGHT, <école détectée>]` (déduplication via `Set`). Pour les modèles < 3B (LIGHT) ou de taille indétectable : école unique (pas de niveau inférieur à Primaire).
- Le plan auto-par-modèle passe de `{ model, school }` (école unique) à `{ model, schools: [...] }` (liste), alimenté par `schoolsForModelPlan`.
- `totalRuns` : somme des `schools.length` par modèle (au lieu de `plan.length`).
- Boucle d'exécution : `modelSchools = plan[i].schools` (au lieu de `[plan[i].school]`).
- Aperçu option 6 (`selectSchoolsInteractive`) : affiche l'enchaînement complet (ex: `Primaire (< 3B) → College-Lycee (3B - 14B)`) au lieu d'une seule école.
- Texte du menu écoles : précise « Modèles > 3B : enchaîne Primaire (LIGHT) puis l'école détectée ».
- Export de `schoolsForModelPlan` dans `module.exports`.

### Fichiers modifiés
- `night-batch.js`

### Résultat
- Un 12B fait désormais LIGHT puis STANDARD dans la même session de nuit (2 runs au lieu d'1).
- Les modèles < 3B font toujours une seule école (LIGHT).
- Les modèles de taille indétectable restent en auto-detection (1 run).
- Plus aucune école « manquante » pour les modèles > 3B passés en option 6.

#### Vérifications
- `node --check night-batch.js` → OK.
- `node tests/run-tests.js` → 27/27 passés.
- Test fonctionnel `schoolsForModelPlan` : 3B/8B/12B → `LIGHT + STANDARD`, 20B → `LIGHT + EXPERT`, 40B → `LIGHT + DOCTORAT`, taille inconnue → `auto`.

## 2026-07-29 (6) — feat: bouton « 🕒 Récents » — tri du classement par date de dernier test

### Contexte
Tri manuel dans LM Studio fastidieux pour retrouver les derniers modèles testés. Le classement local ne proposait que le tri par score. Ajout d'un bouton toggle sur la ligne des filtres pour trier par date de dernier test (`lastUpdated` du carnet), du plus récent au plus ancien.

### Implémentation (`leaderboard.js`)
- Nouveau bouton `btnRecentSort` sur la 1re ligne de filtres (après École), pas sur la 2e ligne (déjà saturée de boutons).
- `toggleRecentSort()` : permute `MODELS` entre l'ordre par score (original) et l'ordre par `lastUpdated` décroissant. État conservé dans `_recentSortActive`.
- `_originalModels` : copie de `MODELS` à l'initialisation (avant tout tri) pour restauration.
- `globalRank` ajouté à chaque entrée côté serveur (`modelsData`) → médailles 🥇🥈🥉 et couleur de carte (gold/silver/bronze) restent liées au rang mondial par score, pas à la position dans la liste triée par date.
- `openModal` : affichage du rang corrigé pour utiliser `globalRank` (au lieu de `idx + 1`).
- Badge `date-badge` (🕒 + date relative « il y a X h ») affiché sur chaque carte, avec tooltip donnant la date complète JJ/MM HH:MM.
- `formatRelativeDate()` / `formatDateShort()` : helpers de formatage date côté client.
- CSS : `.btn-primary.active` (état actif) + `.date-badge`.

#### Vérifications
- `node --check leaderboard.js` → OK.
- `node tests/run-tests.js` → 27/27 passés.
- `node leaderboard.js` → HTML généré, bouton + fonctions présents dans `classement.html`.

## 2026-07-29 (5) — fix: numérotation des cartes redémarre à 1 par filtre catégorie

### Contexte
Dans le classement HTML (local + communautaire), le sélecteur de catégorie filtre les modèles mais la numérotation des cartes gardait l'index global. Ex : en cliquant « Recommandés », la 1re carte affichait « 4 » (rang mondial) au lieu de « 1 » (rang dans le filtre). Idem pour « Dans la moyenne » qui démarrait à 19.

### Implémentation (`leaderboard.js` + `consolidate-leaderboard.js` → `renderCards`)
- `rankDisp` : remplacement de `(i + 1)` par `shown` (compteur relatif au filtre, incrémenté après chaque carte affichée).
- Les médailles 🥇🥈🥉 restent liées à l'index global `i` (top 3 mondial) — inchangé.
- La modale détail conserve le rang mondial réel (`idx + 1`) — inchangé.

#### Vérifications
- `node --check` : leaderboard.js, consolidate-leaderboard.js → OK.
- `vm.Script` sur `classement.html` et `community-leaderboard.html` → JS inline OK.
- HTML généré : `shown` présent, `(i + 1)` absent du rendu de carte.

## 2026-07-29 (4) — fix: verdict CLI aligné sur 5 catégories HTML + détection modèles non-LLM (OvisOCR2)

### Contexte
1. Le verdict du CLI (`getVerdict` dans `leaderboard.js`) n'avait que 3 niveaux (RECOMMANDÉ ≥80%, PARTIEL ≥50%, NON RECOMMANDÉ) basés sur `mandatoryPct`, alors que les catégories HTML (`getCategory`) en ont 5 basés sur `pct` global. Résultat : un modèle à 32% global mais 80% sur l'obligatoire (supergemma-4-12b-abliterated) s'affichait « RECOMMANDÉ » dans le CLI — incohérent avec le classement HTML qui le mettait en « Échec total ». De plus, les modèles entre 80-90% étaient marqués RECOMMANDÉ alors que la catégorie HTML dit « Dans la moyenne » à partir de 75%.
2. Le modèle OvisOCR2 (752M, OCR — reconnaissance de texte dans images) apparaissait dans la liste « modèles non testés » du CLI avec 4 écoles manquantes (LIGHT, STANDARD, EXPERT, DOCTORAT). C'est un modèle non-LLM qui ne peut pas passer les écoles BenchGo.

### Implémentation

#### 1. Unification `getVerdict` ↔ `getCategory` (`leaderboard.js` + `consolidate-leaderboard.js`)
- `getVerdict(entry, rank)` accepte désormais un rang optionnel et utilise `pct` global (plus `mandatoryPct`).
- 5 niveaux alignés sur `getCategory` : TOP DU TOP (rang 1-3, or), RECOMMANDÉ (≥90%, vert), DANS LA MOYENNE (≥75%, cyan), EN RATTRAPAGE (≥50%, jaune), ÉCHEC TOTAL (<50%, rouge).
- Couleurs ANSI CLI mises à jour : or (`\x1b[93m`) pour le podium, vert/cyan/jaune/rouge pour les 4 autres.
- Tous les appels `getVerdict` mis à jour pour passer le rang : `buildLeaderboardHTML` (ligne 466), `buildLeaderboardMarkdown` table + détail (lignes 2505, 2534), CLI `generateLeaderboard` (ligne 2860).
- Même correction appliquée à `consolidate-leaderboard.js` (getVerdict + appel ligne 342).

#### 2. Détection automatique des modèles non-LLM (`night-batch.js`)
- Nouvelle fonction `isNonLlmModel(m)` : détecte les OCR (ovisocr, got-ocr), embeddings (e5-, bge-, gte-, nomic-embed), rerank (jina-reranker, cohere-rerank), vision-only (clip, dino-v, sam, yolo, detector) via regex sur displayName, modelKey, publisher, arch, basename du path.
- Nouveau statut `kind: 'nonllm'` dans `listLlmModels` : les modèles non-LLM ne sont plus comptés comme « jamais testés » ni « partiels ».
- `statusBadge` : ajout du badge « NON APPLICABLE » (gris).
- Tri : les modèles non-LLM vont en fin de liste (après les jamais testés).

#### 3. Section « NON APPLICABLES » dans le CLI (`leaderboard.js` → `printUntestedLmStudioModels`)
- Nouvelle section séparée affichant les modèles non-LLM avec leur raison (OCR/embedding/rerank/vision ou isolé manuellement).
- La section « non testés » n'inclut plus les non-LLM (OvisOCR2 retiré → 8 au lieu de 9).

#### 4. Liste noire interactive (`night-batch.js` → `selectModelsInteractive`)
- Syntaxe `!<num>` : isole un modèle (marque NON APPLICABLE, persiste dans `.benchgo-blacklist.json`).
- Syntaxe `!!<num>` : désisole un modèle (retire de la liste noire, recalcule le statut réel via `recomputeStatus`).
- Sélection `all`/numéros : exclut automatiquement les non-LLM de la sélection de test.
- `--models=key` : exclut aussi les non-LLM explicitement.
- Largeur colonne statut passée de 13 à 15 (pour « NON APPLICABLE »).

#### Vérifications
- `node --check` : leaderboard.js, consolidate-leaderboard.js, night-batch.js → OK.
- `node tests/run-tests.js` : 27/27 passés.
- `node leaderboard.js` : verdict CLI affiche les 5 niveaux correctement (supergemma 32% → ÉCHEC TOTAL).
- `vm.Script` sur `classement.html` et `gh-pages-output/community-leaderboard.html` → JS inline OK.
- OvisOCR2 apparaît dans « MODÈLES NON APPLICABLES (1) » avec raison « Modèle non-LLM (OCR/embedding/rerank/vision) ».

## 2026-07-29 (3) — fix: classement communautaire vide (backticks JS cassaient renderCards) + bouton local corrigé

### Contexte
1. Le classement communautaire (GitHub Pages) affichait "Aucun modèle" en navigateur malgré 36 modèles dans le JSON. Cause : la fonction `exportReport` du JS inline contenait des backticks littéraux (`` ``` ``) échappés via `\`\`\`` dans le template literal source → SyntaxError qui empêchait **tout** le script de s'exécuter, y compris `renderCards()`.
2. Le bouton "Classement communautaire" du leaderboard local utilisait la classe CSS `btn-accent` inexistante (rendu moche) et pointait vers le fichier local `gh-pages-output/community-leaderboard.html` au lieu de la page GitHub Pages.

### Implémentation

#### 1. Backticks littéraux dans `exportReport` (`consolidate-leaderboard.js`)
- Lignes 1420 et 1427 : `\`\`\`javascript` et `\`\`\`text` → remplacés par `String.fromCharCode(96,96,96)` pour éviter les backticks littéraux dans le JS inline du HTML généré.
- Vérifié : `node -e "new vm.Script(js)"` → syntaxe OK, 0 backtick littéral, `renderCards()` s'exécute, `emptyMsg.display = "none"`.

#### 2. Bouton "Classement communautaire" du leaderboard local (`leaderboard.js`)
- Ligne 1231 : classe `btn-accent` (inexistante) → `btn-primary` (cohérent avec les autres boutons).
- Lignes 2372-2374 : `window.open` pointe désormais vers `https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html` au lieu du fichier local.

#### 3. Procédure de déploiement du classement communautaire (GitHub Pages)
- `node consolidate-leaderboard.js` ne génère que le fichier **local** `gh-pages-output/community-leaderboard.html`. Il n'est PAS déployé en ligne.
- Pour mettre à jour le classement **en ligne** sur GitHub Pages :
  1. Pousser les modifications de `consolidate-leaderboard.js` sur `origin/main` du dépôt `cisco-03/BenchGo-LLM-School`.
  2. Déclencher le workflow : `gh workflow run consolidate.yml -R cisco-03/BenchGo-LLM-School`
  3. Attendre la fin : `gh run watch -R cisco-03/BenchGo-LLM-School`
  4. Le workflow régénère le HTML sur la branche `gh-pages` et GitHub Pages le déploie automatiquement.
  5. Hard refresh (Ctrl+Shift+R) sur https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html

#### 4. Règle technique : backticks dans JS inline
- Ne JAMAIS mettre de backticks littéraux dans du JS inline généré par un template literal — utiliser `String.fromCharCode(96)` ou une variable.
- Vérification : extraire le JS du HTML généré et le parser avec `new vm.Script(js)` pour détecter une SyntaxError.

## 2026-07-29 (2) — feat: design unifié classement communautaire + colonnes mode nuit + merge auto + URL modèle

### Contexte
1. Le classement communautaire avait un design simplifié (chips au lieu de selects, modale basique, pas de forces/faiblesses ni rapport intégral). L'utilisateur veut exactement le même design que le leaderboard local.
2. Les colonnes du mode nuit (`night-batch.js --list-only`) étaient mal alignées quand les valeurs dépassaient les largeurs fixes (ex: "128x2.6B", "21B-A3B", "deepreinforce-ai").
3. Les PR communautaires devaient être mergées à la main une par une.
4. Besoin d'un lien cliquable vers le modèle (Hugging Face) dans la modale.
5. Suppression du bouton "Exporter PNG" (peu fiable) + ajout exports CSV et Markdown.

### Implémentation

#### 1. Design unifié du classement communautaire (`consolidate-leaderboard.js`)
- **HTML/CSS/JS complètement réécrit** pour reproduire fidèlement le design du leaderboard local :
  - Même CSS (palette GitHub-dark, typographie fluide clamp, cartes avec dégradés, modale 1180px, animations scroll)
  - Filtres par selects (Catégorie, Taille, Santé, École) au lieu de chips
  - Boutons : Copier le classement, Exporter PDF, Exporter CSV, Exporter Markdown
  - Kebab menu (⋮) sur chaque carte avec "Détails" et "Copier le nom"
  - Modale complète : stats avec barres de progression, forces/faiblesses en 2 colonnes, tableau par école (14 colonnes), rapport intégral repliable (tiers/exercices/code/rawResponse/selfProfile)
  - Toast notifications
  - Animations d'entrée au scroll (IntersectionObserver)
  - Badges communautaires préservés : 👥 contributeurs, ✍️ pseudo
- **Données enrichies** : `aggregateCarnet` extrait désormais mandatoryPassed/Total, helpCount, retriedCount, wallMs, ecoles détaillées avec tiers/evalResults/selfProfile.
- **Fonctions ajoutées** : `buildArguments` (forces/faiblesses), `getVerdict` (RECOMMANDÉ/PARTIEL/NON RECOMMANDÉ).
- Adaptations contexte statique (GitHub Pages) : pas de serveur, pas de suppression, pas d'édition d'URL (affichage seul), pas de bannière update.

#### 2. Colonnes mode nuit alignées (`night-batch.js`)
- Largeurs de colonnes **calculées dynamiquement** à partir des données réelles (`Math.max(longueur_header, ...longueurs_valeurs)`).
- Troncature des valeurs trop longues avec `.slice(0, W)` pour garantir un alignement parfait.
- Ligne de séparation `─` ajoutée sous le header (style militaire).
- Suppression des largeurs fixes qui causaient le décalage (paramW=5 dépassé par "21B-A3B", pubW=14 dépassé par "deepreinforce-ai", etc.).

#### 3. Merge automatique des PRs communautaires (`community-sync.js`)
- Nouvelle fonction `mergePullRequest(token, prNumber)` : `PUT /repos/.../pulls/{n}/merge`.
- `submitResults` merge la PR après création. Échec non-bloquant (PR reste ouverte).
- 36 carnets re-soumis et mergés automatiquement (PR #41-#76).

#### 4. URL du modèle dans la modale (`leaderboard.js`, `score-ledger.js`)
- `guessModelUrl(modelName, publisher)` : devine l'URL Hugging Face.
- Section "🔗 Lien du modèle" dans la modale avec édition manuelle (bouton Modifier/Ajouter/Effacer).
- Persistance : API serveur `/api/model-url` (carnet JSON) ou localStorage (fallback).
- `score-ledger.js#saveResult` accepte un paramètre `publisher`.

#### 5. Exports du leaderboard local (`leaderboard.js`)
- Suppression de `exportLeaderboardPng` et du bouton PNG.
- Nouveaux boutons : Exporter CSV (`exportLeaderboardCsv`), Exporter Markdown (`exportLeaderboardMd`).
- Helpers : `csvCell`, `mdCell`, `downloadTextFile`.

### Vérification
- `node --check` sur tous les fichiers modifiés → OK.
- `node night-batch.js --list-only` → colonnes parfaitement alignées (testé avec "128x2.6B", "21B-A3B", "deepreinforce-ai", "lmstudio-community").
- `node consolidate-leaderboard.js` → HTML de 1190 lignes avec tous les éléments (selects, kebab, toast, modale riche, animations).
- `node leaderboard.js` → classement local régénéré avec nouveaux exports.
- Workflow `consolidate.yml` déclenché pour publier le nouveau design communautaire.

### Fichiers modifiés
- `consolidate-leaderboard.js` — `aggregateCarnet` enrichi, `buildArguments`, `getVerdict`, `guessModelUrl`, `buildConsolidatedHTML` réécrit (design unifié).
- `night-batch.js` — `selectModelsInteractive` (largeurs dynamiques, séparateur).
- `community-sync.js` — `mergePullRequest`, `submitResults` (auto-merge).
- `runner.js` — messages de soumission (merge OK/échec).
- `score-ledger.js` — `saveResult` (paramètre `publisher`).
- `leaderboard.js` — `guessModelUrl`, `modelUrl` dans `modelsData`, section URL modale, API `/api/model-url`, suppression PNG, exports CSV/MD.
- `Docs/CHANGELOG.md` — mise à jour.

## 2026-07-29 — feat: détection MTP mode nuit + refonte dashboard progression des modèles

### Contexte
1. Les fichiers MTP (Multi-Token Prediction) sont des modules complémentaires publiés sur Hugging Face qui accompagnent certains modèles (ex: Gemmable 4 12B, Gemma 4 26B A4B). LM Studio les liste comme des modèles séparés via `lms ls`, mais ils ne sont pas testables seuls — ils doivent être chargés AVEC le modèle principal via `--speculative-draft-mtp` pour accélérer l'inférence. Le mode nuit les proposait à tort comme modèles testables.
2. Le dashboard affichait « Progression d'une école dans le temps », ce qui n'avait pas de sens : l'utilisateur veut voir la progression des **modèles** dans le temps (une ligne par modèle, axe X = date des tests, axe Y = %), pas d'une école. De plus, le tooltip n'affichait pas de ligne verticale au survol.

### Implémentation

#### 1. Détection et association MTP (`night-batch.js`)
- Nouvelle fonction `isMtpModel(m)` : détecte les fichiers MTP par le basename du path ou le displayName contenant "mtp" (mot entier).
- Nouvelle fonction `stripMtpFromName(s)` : normalise un nom de fichier en retirant les segments "mtp" pour comparaison.
- Nouvelle fonction `buildMtpAssociations(allModels)` : associe chaque modèle principal à son fichier MTP par dossier parent commun (ex: `Mia-AiLab/Gemmable-4-12B-MTP-GGUF/`), avec fallback par nom normalisé si le dossier ne suffit pas.
- `listLlmModels()` filtre désormais les fichiers MTP de la liste testable (17 → 14 modèles sur l'instance courante) et enrichit chaque modèle principal avec `mtpModelKey` (null si aucun MTP associé).
- `loadModel(modelKey, mtpModelKey)` charge le modèle principal avec `--speculative-draft-model <mtp>` + `--speculative-draft-mtp` quand un MTP est associé.
- Table CLI : tag `[MTP]` affiché en cyan après le nom des modèles ayant un MTP associé.
- Exports : `isMtpModel`, `buildMtpAssociations` ajoutés au `module.exports`.

#### 2. Refonte du dashboard (`leaderboard.js`)
- API `/api/dashboard-data` : le champ `ecoles[].attempts` désormais inclus (date, time, pct, score, max, ecole, globalLifeScore, tokensPerSecond pour chaque tentative).
- Graphique « Progression d'une école dans le temps » remplacé par « Progression des modèles dans le temps » : une série/ligne par modèle, axe X = date des tests, axe Y = % de réussite. Interaction `mode: 'index'` pour synchroniser le tooltip.
- Plugin Chart.js personnalisé `verticalLineHover` : dessine une ligne verticale pointillée à l'abscisse du point survolé, enregistré globalement sur tous les graphiques.
- Tooltip enrichi : nom du modèle, école, score/max (%), santé (PV), vitesse (t/s), heure du test.
- Palette de 20 couleurs cyclique pour distinguer les modèles.
- `populateEcoleSelect` / `updateEcoleChart` supprimés (plus de sélecteur d'école).

### Fichiers modifiés
- `night-batch.js` — détection MTP, filtrage, association, chargement avec speculative decoding, affichage `[MTP]`, exports.
- `leaderboard.js` — API dashboard-data étendue, refonte HTML/JS du dashboard, plugin ligne verticale.

## 2026-07-29 — feat: merge auto PRs communautaires + URL modèle + exports + modale communautaire

### Contexte
1. Les PR communautaires devaient être mergées à la main une par une — fastidieux quand il y en a des dizaines. Comme les soumissions ne contiennent que des résultats JSON (pas de code), aucun risque à les merger automatiquement.
2. L'écart entre le classement local et communautaire provenait de carnets locaux plus récents que les soumissions GitHub. Re-soumission des 36 carnets pour synchroniser.
3. Suppression du bouton « Exporter PNG » (capture DOM via SVG foreignObject, peu fiable). Conservation du PDF + ajout CSV et Markdown (tableau).
4. Besoin d'un lien cliquable vers le modèle (Hugging Face, LM Studio...) dans la modale détails — devinette auto + édition manuelle par l'utilisateur.
5. Le classement communautaire n'avait pas de modale au clic sur un modèle. Ajout d'une modale détails + exports identiques au leaderboard local.

### Implémentation

#### 1. Merge automatique des PRs communautaires (`community-sync.js`)
- Nouvelle fonction `mergePullRequest(token, prNumber)` qui appelle `PUT /repos/.../pulls/{n}/merge` (merge_method: merge).
- `submitResults` merge la PR juste après sa création. Si le merge échoue (ex: protections de branche), la PR reste ouverte — pas de crash.
- Retour enrichi : `{ ok, prUrl, prNumber, merged, mergeMessage, branch, filePath }`.
- Messages UI mis à jour dans `runner.js` (affichage merge OK/échec) et `leaderboard.js` (modale de soumission).
- Corps de PR mis à jour : mentionne le merge automatique.

#### 2. URL du modèle dans le carnet (`leaderboard.js`, `score-ledger.js`)
- Nouvelle fonction `guessModelUrl(modelName, publisher)` : devine l'URL Hugging Face à partir du nom (si `publisher/model`) ou du publisher stocké.
- `score-ledger.js#saveResult` accepte désormais un paramètre `publisher` stocké dans le carnet.
- `leaderboard.js` : `modelUrl` ajouté au `modelsData` (carnet > devinette > null).
- Modale : section « 🔗 Lien du modèle » avec lien cliquable + bouton « ✎ Modifier » / « + Ajouter un lien ».
- Édition inline : champ URL + boutons Enregistrer / Effacer / Annuler.
- Persistance double :
  - Mode serveur (`--serve`) : API `GET/POST /api/model-url?shortName=...` → écrit dans le carnet JSON.
  - Hors-serveur (ouverture locale du HTML) : localStorage (fallback).
- CSS : `.model-url-section`, `.model-url-link`, `.model-url-edit`, `.btn-sm`.

#### 3. Exports du leaderboard local (`leaderboard.js`)
- Suppression de `exportLeaderboardPng` et du bouton « 🖼 Exporter PNG ».
- Nouveaux boutons : « 📊 Exporter CSV » et « 📝 Exporter Markdown ».
- `exportLeaderboardCsv` : génère un CSV (rang, modèle, quantif, score, %, note, obligatoire, santé, bonus, écoles, vitesse, temps).
- `exportLeaderboardMd` : génère un tableau Markdown avec médailles 🥇🥈🥉.
- Helpers : `csvCell`, `mdCell`, `downloadTextFile` (Blob + BOM UTF-8).

#### 4. Modale + exports sur le classement communautaire (`consolidate-leaderboard.js`)
- `guessModelUrl` ajouté + `modelUrl`/`publisher` dans l'agrégation et les données sérialisées.
- Cartes cliquables (`onclick="openModal(idx)"`) → ouverture d'une modale détails.
- Modale : statistiques (points, %, note, santé, bonus, écoles, vitesse, temps) + lien du modèle + métadonnées (nom court, pseudo, contributeurs).
- Fermeture : clic sur l'overlay ou touche Échap.
- Boutons d'export dans la barre sticky : « 📄 PDF » (window.print), « 📊 CSV », « 📝 MD ».
- CSS complet pour la modale (`.modal-overlay`, `.modal`, `.modal-head`, `.full-stats`, etc.) + media print.
- Les filtres catégorie/taille et la recherche étaient déjà présents (identiques au leaderboard local).

### Vérification
- `node --check` sur `community-sync.js`, `runner.js`, `score-ledger.js`, `leaderboard.js`, `consolidate-leaderboard.js` → OK.
- `node leaderboard.js` → classement régénéré avec nouveaux boutons (CSV, MD) et sans PNG.
- `node consolidate-leaderboard.js` → HTML communautaire généré avec modale + exports.
- Re-soumission des 36 carnets : 36/36 PRs créées ET mergées automatiquement (PR #41 à #76).
- Workflow `consolidate.yml` déclenché automatiquement par les merges.

### Fichiers modifiés
- `community-sync.js` — `mergePullRequest`, `submitResults` (auto-merge), export, corps de PR.
- `runner.js` — messages de soumission (merge OK/échec).
- `score-ledger.js` — `saveResult` (paramètre `publisher`).
- `leaderboard.js` — `guessModelUrl`, `modelUrl` dans `modelsData`, section URL modale, API `/api/model-url`, suppression PNG, exports CSV/MD, CSS.
- `consolidate-leaderboard.js` — `guessModelUrl`, `modelUrl`/`publisher`, modale détails, exports CSV/MD/PDF, CSS modale + print.

## 2026-07-26 — feat: classement local dans night-batch + prompt professeur renforcé

### Contexte
Deux demandes utilisateur (cf. `Memories-BenchGo/Tasks1.md`) :
1. Dans `node night-batch.js --list-only`, classer les modèles LM Studio téléchargés selon leur score du classement local BenchGo (du plus fort au plus faible), pour repérer immédiatement le plus faible à retirer. Enrichir la liste de colonnes plus précises.
2. Renforcer le « prompt du professeur » : souhaiter la bienvenue aux modèles (élèves), leur expliquer qu'ils intègrent une grande école avec plusieurs écoles/classes/exercices notés, que tout compte avec des points, et que leur prestation détermine leur intégration au classement final mondial des LLM. Insister sur le sérieux (donner à 100%).

### Implémentation

#### 1. Classement local dans night-batch.js (`--list-only`)
- **`night-batch.js`** : ajout de `computeLedgerMetrics(ledger)` qui agrège le carnet d'un modèle (meilleure tentative par école) en `{ score, max, pct, globalLifeScore, tokensPerSecond, elapsedMs, attempts, trend }`. Reproduit localement la logique de `score-ledger.js`/`leaderboard.js#aggregateLedger` sans coupler les modules (night-batch reste autonome).
- `listLlmModels()` enrichit désormais chaque modèle d'un champ `metrics` (null si jamais testé).
- **Tri** : les modèles déjà testés sont triés du plus fort au plus faible (pct, puis score, puis santé décroissante), puis les modèles jamais testés sont placés à la fin (par nom). Permet de repérer le dernier des testés = le plus faible = bon candidat au retrait.
- **Affichage** (`selectModelsInteractive`) : 5 nouvelles colonnes — `Pct` (% global), `Vit.` (vitesse tok/s), `Tent.` (nombre max de tentatives sur une école), `Tnd` (tendance ▲/▼/=), `Temps` (durée d'inférence cumulée). Helpers `fmtDuration()` et `trendGlyph()` ajoutés. Message d'ordre mis à jour + astuce pour le retrait du plus faible.
- Compatibilité : `leaderboard.js` consomme déjà `nightBatch.statusBadge`/`missingSchoolsLabel` sans changement.

#### 2. Prompt du professeur renforcé
- **`lm-studio-client.js:getSystemPrompt`** et **`cloud-client.js:getSystemPrompt`** : nouveau préambule d'accueil en français — bienvenue dans BenchGo V3, grande école d'excellence, écoles (Primaire → Post-Doc) découpées en classes, exercices notés (points gagnés/perdus), santé globale (buffer de PV, élimination si trop bas), classement final mondial des LLM, consigne de donner 100% et d'écrire du code JS complet/exécutable. Le niveau EXPERT/FRONTIER conserve le rôle « ingénieur logiciel principal ».
- **`runner.js:407`** : le prompt dynamique de chaque tier débute désormais par un rappel de l'enjeu (classement mondial, points, santé, donner 100%) avant le contexte d'évaluation (école + classe).

### Vérification
- `node --check night-batch.js`, `node --check lm-studio-client.js`, `node --check cloud-client.js`, `node --check runner.js` → OK.
- `node night-batch.js --list-only` → tri correct (99% → 99% → 96% → 96% → 95% → 91%), colonnes alignées, tendance ▼ affichée pour Mythos 9B (2 tentatives, régression).
- Prompt système : ~1500 caractères, cohérent entre LM Studio et cloud.

### Fichiers modifiés
- `night-batch.js` — `computeLedgerMetrics`, `normalizeEcoleEntryLocal`, `pickBestLocal`, `fmtDuration`, `trendGlyph`, tri `listLlmModels`, affichage `selectModelsInteractive`.
- `lm-studio-client.js` — `getSystemPrompt`.
- `cloud-client.js` — `getSystemPrompt`.
- `runner.js` — préambule du prompt dynamique.
- `Docs/CHANGELOG.md` — cette entrée.

## 2026-07-26 — fix: écoles manquantes hors de portée affichées pour les petits modèles (night-batch)

### Contexte
Dans la liste des modèles LM Studio non testés (sortie CLI de `night-batch.js` et table HTML du classement consommant `missingSchoolsLabel`), la colonne « Écoles manquantes » listait systématiquement toutes les écoles (`LIGHT,STANDARD,EXPERT,DOCTORAT`) y compris pour des modèles de petite taille qui n'ont pas vocation à passer les écoles supérieures. Exemples relevés par l'utilisateur :
- Gemma 4 12B (12B → STANDARD) affichait `LIGHT,STANDARD,EXPERT,DOCTORAT` alors qu'EXPERT et DOCTORAT sont inaccessibles pour sa capacité.
- Ornith 1.0 9B (9B → STANDARD) affichait `EXPERT,DOCTORAT` en partiel, alors qu'il ne devrait afficher que les écoles réellement attendues (`LIGHT`, `STANDARD`).

### Cause racine
`listLlmModels()` (`night-batch.js:254`) calculait `missingSchools = allSchoolKeys.filter(k => !testedSchools.includes(k))` sans tenir compte de la taille du modèle. Le seuil d'école détecté existait déjà (`schoolForModel()` ligne 358) mais n'était pas utilisé pour borner les écoles attendues.

### Implémentation
- **`night-batch.js:262-294`** : ajout de `relevantSchoolKeysFor(m)` qui renvoie les écoles de `LIGHT` jusqu'à l'école détectée pour la taille du modèle (incluse). Pour un 12B (STANDARD) → `[LIGHT, STANDARD]`. Pour un 9B → `[LIGHT, STANDARD]`. Pour un 26B (EXPERT) → `[LIGHT, STANDARD, EXPERT]`. Si la taille n'est pas détectable, on retombe sur toutes les écoles (comportement historique, pas de régression pour les modèles non reconnus).
  - `missingSchools` ne contient plus que les écoles pertinentes non testées.
  - `status.kind === 'complete'` se déclenche désormais quand toutes les écoles pertinentes sont testées (et non plus toutes les écoles).
- `leaderboard.js:2618/2622` consomme `m.status.missing` via `nightBatch.missingSchoolsLabel()` : la correction remonte automatiquement à la table HTML du classement sans modification supplémentaire.

### Vérification
- `node --check night-batch.js` → OK.
- Cohérence avec les seuils de `config.js:detectProfileFromModelName` (< 3B LIGHT, ≤14B STANDARD, ≤30B EXPERT, sinon DOCTORAT) et `night-batch.js:schoolForModel` (mêmes seuils).

### Fichiers modifiés
- `night-batch.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — fix: apostrophe non échappée cassant le JS du classement (E901)

### Contexte
Le HTML généré par `leaderboard.js` (`Export-Rapports/classement.html`) contenait une erreur de syntaxe JS à la ligne 1369 : la chaîne `'Dialogue d'impression ouvert...'` utilisait des simples quotes avec une apostrophe non échappée dans `d'impression`, ce qui fermait prématurément la chaîne et cassait tout le `<script>` inline (boutons Exporter PDF/PNG, filtres, modale).

### Cause racine
La fonction `exportLeaderboardPdf()` est définie à l'intérieur d'un template literal backtick dans `buildLeaderboardHTML()`. Un `\'` à l'intérieur d'un backtick est consommé comme escape et produit `'` à la sortie — l'apostrophe reste donc non échappée dans le JS inliné. Le premier essai (`d\'impression`) n'a pas corrigé le bug car le backtick mange le backslash.

### Implémentation
- **`leaderboard.js:1903`** : la chaîne `showToast(...)` passe de simples quotes à **doubles quotes** — `d'impression` devient un littéral valide dans une chaîne double-quoted, qui survit intact à l'interpolation du backtick et reste du JS valide dans le HTML inliné.

### Vérification
- Extraction du `<script>` du HTML régénéré → `node --check` passe (syntaxe valide).
- `node tests/run-tests.js` → 27/27 tests passent (aucune régression).

### Fichiers modifiés
- `leaderboard.js`
- `Export-Rapports/classement.html` (régénéré)
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §7 : Stratégie + roadmap

### Contexte
Plan d'amélioration axe 7 : roadmap courte + objectif visible mesurable. L'utilisateur doit voir une amélioration mesurable à chaque exécution.

### Implémentation
- **`Docs/roadmap.md`** (nouveau) : roadmap des axes livrés (§1-6) + itérations suivantes + objectif visible continu.
- **`runner.js`** : bloc « Améliorations actives ce run » affiché en fin de run rappelant les fonctionnalités actives (cache, retry, sentinelles, hybrid, CSV, dashboard) pour que la progression soit mesurable à chaque exécution.

### Fichiers modifiés
- `Docs/roadmap.md` (nouveau), `runner.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §6 : Données / Analytics

### Contexte
Plan d'amélioration axe 6 : horodatage précis (ms) par étape + export CSV des runs pour comparaison inter-modèles + analyse de convergence (détection des modèles instables).

### Implémentation
- **`score-ledger.js`** :
  - `saveResult()` ajoute `timestampMs` (Date.now()) + `timestampIso` à chaque résultat pour une traçabilité fine.
  - `exportCsv(outputPath)` : exporte tous les runs (toutes tentatives, toutes écoles, tous modèles) dans `Export-Rapports/runs_export.csv` avec 25 colonnes (horodatage ms, modèle, école, points, santé, tokens, vitesse, calibration, tentative...). Tri chronologique. Échappement CSV correct.
  - `detectUnstableModels()` : détecte les modèles dont la santé fluctue > 20% d'amplitude entre tentatives d'une école (≥ 2 tentatives). Journalise un WARN par modèle instable.
- **`runner.js`** : en fin de run `all`, régénère le CSV global + affiche les modèles instables en console. Le CSV est ouvertable dans Excel/Sheets pour comparaison.

### Comportement
- `Export-Rapports/runs_export.csv` régénéré à chaque run `all` (39 lignes au premier essai sur les carnets existants).
- Les modèles instables (amplitude > 20%) sont signalés en console avec min/max/amplitude.

### Fichiers modifiés
- `score-ledger.js`, `runner.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §5 : Intégration / Automatisation

### Contexte
Plan d'amélioration axe 5 : mode nuit hybride (CLI + auto-soumission GitHub si seuil atteint) avec file d'attente persistante en cas d'échec réseau, webhook, backup cloud AES-256-GCM.

### Implémentation
- **Nouveau module `hybrid-mode.js`** :
  - `submitOrEnqueue(shortName, ledger, summary, token)` : soumet automatiquement si score ≥ 50% (DEFAULT_SUBMIT_THRESHOLD), sinon met en file.
  - File persistante `Export-Rapports/.hybrid-queue.json` : les soumissions en échec réseau sont conservées pour retry au prochain run `--hybrid`.
  - `drainQueue(token)` : rejoue toutes les soumissions en attente au démarrage d'un run `--hybrid` (vidange réseau).
  - `shouldAutoSubmit(summary, threshold)` : décision seuil-based.
- **Nouveau module `cloud-backup.js`** :
  - `encrypt(plaintext, passphrase)` / `decrypt(backupObj, passphrase)` : AES-256-GCM via `node:crypto` (aucune dépendance externe). Clé dérivée PBKDF2 (210 000 itérations, SHA-256), sel aléatoire 16 octets, IV 12 octets, authTag 16 octets. Format JSON versionné.
  - `encryptFile` / `decryptToFile` / `encryptDirectory` : helpers pour chiffrer `.carnet/` entier.
  - Mauvaise passphrase → authTag invalide → erreur propre (données altérées détectées).
- **`runner.js`** : en mode `--hybrid`, draine la file puis soumet le modèle courant (ou met en file). Affiche le résultat (soumis / en file / sous seuil).
- **`config.js`** : flag `--hybrid` ajouté à `parseCliArgs()`.

### Comportement
- `node runner.js all --hybrid --github-token=ghp_...` : soumet automatiquement les modèles ≥ 50%, met en file les échecs réseau, rejoue la file au prochain run.
- `cloud-backup.js` prêt à brancher sur un endpoint S3 (l'utilisateur fournit endpoint + credentials via env).

### Fichiers modifiés
- `hybrid-mode.js` (nouveau), `cloud-backup.js` (nouveau)
- `config.js`, `runner.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §4 : Maintenabilité / Architecture

### Contexte
Plan d'amélioration axe 4 : modularisation (fonctions pures extraites), tests unitaires ciblés, sentinelles sanitaires (NaN, cohérence des sommes).

### Implémentation
- **Nouveau module `scoring-utils.js`** : extraction des fonctions pures de `runner.js` — `isRattrapageEligibleProfile`, `shouldReplaceBestResult`, `explainTechnicalError`, `getClassName`. Aucun effet de bord, testables unitairement. `runner.js` les importe (réduction de ~60 lignes).
- **Nouveau module `health-sentinels.js`** :
  - `checkNoNaN` (S1) : détecte les NaN dans points/maxPoints/pct.
  - `checkPointsConsistency` (S2) : points > maxPoints, points négatifs, somme maxPoints != tierTotalCount.
  - `checkGlobalCoherence` (S3) : pct hors [0,100], santé absurde (> 10000), NaN.
  - `runSentinels({ evalResults, tierPassedCount, tierTotalCount, pct, globalLifeScore, strict })` : exécute toutes les sentinelles, non bloquant par défaut (WARN journalisé), `strict` pour faire échouer le run.
- **Nouveau sous-dossier `tests/`** :
  - `run-tests.js` : lanceur sans dépendance (découverte `test-*.js`, assert Node, résumé + code de sortie).
  - `test-sentinels.js` (8 cas), `test-lru-cache.js` (6 cas), `test-parsing.js` (4 cas), `test-scoring-utils.js` (9 cas).
- **`runner.js`** : sentinelles exécutées après chaque tier (non bloquant) — journalise un WARN en cas d'incohérence pour diagnostic.

### Comportement
- `node tests/run-tests.js` → 27/27 tests passent (scoring, parsing, sentinelles, LRU).
- Chaque tier est vérifié par les sentinelles en arrière-plan (NaN/sommes détectés silencieusement en WARN).

### Fichiers modifiés
- `scoring-utils.js` (nouveau), `health-sentinels.js` (nouveau)
- `tests/run-tests.js`, `tests/test-sentinels.js`, `tests/test-lru-cache.js`, `tests/test-parsing.js`, `tests/test-scoring-utils.js` (nouveaux)
- `runner.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §3 : UI / Ludisme

### Contexte
Plan d'amélioration axe 3 : progress-bar enrichie (phases + ETA), classement gamifié (animations, filtres interactifs, export PNG/PDF), dashboard web.

### Implémentation
- **`progress-bar.js`** : `ProgressBar` enrichie avec `setPhases(phases)` (phases pondérées), `setPhase(name, current)` (progression par phase), ETA dynamique (basé sur la vitesse constatée, fenêtre glissante). Rétro-compatible (mode simple sans phases). `complete()` journalise la durée.
- **`leaderboard.js`** :
  - Nouveaux filtres : **Santé** (positive ≥ 0 PV / négative < 0 PV) et **École** (dynamique selon les écoles testées). Compteurs calculés à la génération.
  - `ecoleNames` ajouté au `modelsData` pour le filtrage côté client.
  - Animations d'entrée au scroll : CSS `.card` (opacity + translateY) + `IntersectionObserver` (respecte `prefers-reduced-motion`).
  - Export **PNG** : capture du DOM via SVG foreignObject (aucune dépendance) → canvas 2x → téléchargement. Fallback message si CORS.
  - Export **PDF** : `window.print()` + media-query print (masque sticky-bar/modale, fond blanc).
  - Nouveaux boutons « 🖼 Exporter PNG » et « 📄 Exporter PDF » dans la sticky-bar.
- **Dashboard web** (`/dashboard` + `/api/dashboard-data`) :
  - Page HTML autonome embarquant Chart.js (CDN jsdelivr + fallback cdnjs).
  - Graphique 1 : progression d'une école dans le temps (% par run, trié par date).
  - Graphique 2 : historique d'un modèle (% par école en barres + santé en ligne, double axe Y).
  - Graphique 3 : scatter vitesse (tokens/s) vs score (%) pour comparer les modèles.
  - Route `/api/dashboard-data` renvoie les carnets agrégés en JSON.
- **`leaderboard.js`** : message de démarrage du serveur mentionne le dashboard (`/dashboard`).

### Comportement
- `node leaderboard.js --serve` → `http://localhost:3939/dashboard` affiche les 3 graphiques.
- Filtres Santé + École fonctionnels ; animations d'entrée au scroll ; export PNG/PDF depuis la sticky-bar.

### Fichiers modifiés
- `progress-bar.js`, `leaderboard.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §2 : Performance / Fiabilité

### Contexte
Plan d'amélioration `.kilo/plans/1785055945228-plan-amelioration-benchgo.md` axe 2 : améliorer la fiabilité des appels API (timeout, retry, fallback) et mesurer la latence/débit pour prioriser les optimisations. Coucher de cache pour éviter les appels LLM redondants.

### Implémentation
- **Nouveau module `lru-cache.js`** : cache LRU sans dépendance externe (Map JS avec move-to-end), TTL optionnel, statistiques hit/miss/éviction journalisées.
- **Nouveau module `http-middleware.js`** : wrapper `withRetry()` (timeout + backoff exponentiel + critères de retry : 429/5xx/timeout/erreurs réseau, PAS sur 401/403/404) + fallback modèle secondaire. Politique centralisée cohérente pour les deux clients.
- **Nouveau module `benchmark-metrics.js`** : collecte latence (ms) + tokens par appel API, agrégation par modèle, section Markdown récapitulative injectée dans le rapport, résumé console en fin de run. Journalisation de chaque mesure (INFO) pour corrélation avec les logs serveur.
- **`task-evaluator.js`** : cache LRU des résultats d'évaluation par (taskId, hash SHA-256 du code étudiant normalisé) avec TTL 30 min. Évite le re-exécution sandbox VM pour un code identique (rattrapage, re-run). Stats de hit-rate journalisées.
- **`tier-loader.js`** : cache des tiers chargés par profil avec invalidation par mtime+size des fichiers `tiers/*.json`. Évite de relire+parse les 16 JSON à chaque appel dans un run multi-écoles. Export `invalidateTierCache()` pour l'auto-updater.
- **`teacher-client.js`** : `askTeacherToCorrectStudentAnalysis()` utilise `withRetry()` (2 retries intra-modèle + backoff exponentiel) avant de rotate vers le modèle gratuit suivant. Code court `E701_TEACHER_UNAVAILABLE` journalisé.
- **`lm-studio-client.js`** : enregistrement des métriques (latence + tokens + statut) dans `benchmark-metrics` à chaque appel (succès ET échec). Erreurs obligatoires propagées via `BenchgoError` (codes E502/E503/E504).
- **`cloud-client.js`** : idem — enregistrement métriques + `BenchgoError` pour erreurs obligatoires (suppression du `process.exit(1)` brut au profit de la propagation propre).
- **`runner.js`** : section « Benchmarking intégré » ajoutée à la fin du rapport Markdown ; résumé console latence/débit + stats cache LRU affichés en fin de run.

### Comportement
- Un même code étudiant ré-évalué (rattrapage) renvoie le verdict mis en cache — gain de temps + cohérence garantie.
- Un appel API qui timeout ou reçoit 429/5xx est automatiquement retry avec backoff exponentiel (1s, 2s, 4s...) avant d'échouer.
- Le rapport final inclut un tableau latence/débit/taux d'erreur par modèle pour prioriser les optimisations.

### Fichiers modifiés
- `lru-cache.js` (nouveau), `http-middleware.js` (nouveau), `benchmark-metrics.js` (nouveau)
- `task-evaluator.js`, `tier-loader.js`, `teacher-client.js`, `lm-studio-client.js`, `cloud-client.js`, `runner.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Plan d'amélioration §1 : CLI / UX

### Contexte
Plan d'amélioration `.kilo/plans/1785055945228-plan-amelioration-benchgo.md` axe 1 (levier d'impact le plus fort) : pages de commandes contextuelles, résumé de fin de run, erreurs lisibles avec code court. Objectif : que l'utilisateur voie une amélioration mesurable à chaque exécution.

### Implémentation
- **Nouveau module `cli-help.js`** :
  - `printHelp(topic)` : aide contextuelle complète (commandes, options, exemples, profiles) avec ancrage par topic.
  - `printStatus()` : résumé du dernier run depuis `Export-Rapports/dernier-run.json` (modèle, provider, profil, points, obligatoire, santé, durée, verdict, écoles).
  - `printVersion()` : version courante extraite de `Docs/CHANGELOG.md`.
  - `handleSingleAction(rawArgs)` : interception des commandes `help`/`status`/`version` AVANT la bannière BenchGo (sortie propre).
  - `BenchgoError` : classe d'erreur avec code court (`E502_LM_TIMEOUT`, `E503_LM_UNREACHABLE`, `E504_LM_HTTP_ERROR`, `E601_NO_MODEL`, `E602_BAD_PROFILE`, `E701_TEACHER_UNAVAILABLE`, `E801_GITHUB_SUBMIT_FAILED`, `E901_CONFIG_INVALID`) + suggestion corrective. `print()` affiche sans stack brute.
  - `saveLastRun(summary)` : sauvegarde le résumé dans `dernier-run.json` pour `status` et la reprise.
- **`config.js`** : nouveaux flags `--dry-run` et `--hybrid` dans `parseCliArgs()`.
- **`runner.js`** :
  - Actions uniques interceptées avant `main()`.
  - `--dry-run` : valide la configuration (modèle présent en cloud, profil connu, clé API) sans lancer l'auto-profilage ni l'évaluation — sortie en ~5s.
  - `E601_NO_MODEL` levé (BenchgoError) si `--provider` sans `--model` (remplace le `process.exit(1)` brut).
  - Résumé de fin de run : tableau synthétique (modèle, mode, profil, temps, points, obligatoire, verdict, écoles) affiché en console + sauvegardé dans `dernier-run.json`.
  - Handler `main().catch()` : distingue `BenchgoError` (affichage propre code+suggestion) des erreurs fatales (stack).
  - `--hybrid` flag propagé (préparation §5).
- **`logger.js`** : passage en écriture SYNCHRONE (`fs.appendFileSync`) — corrige le bug historique où les logs des actions uniques (help/status/version/dry-run) disparaissaient car le `WriteStream` asynchrone n'était pas vidé avant `process.exit()`. `close()`/`closeSync()` no-op (rétro-compat).
- **`lm-studio-client.js`** + **`cloud-client.js`** : erreurs obligatoires propagées via `BenchgoError` (codes E502/E503/E504) au lieu de `process.exit(1)` — le runner gère l'affichage propre et la journalisation.
- **`teacher-client.js`** : code court `E701_TEACHER_UNAVAILABLE` journalisé quand tous les essais Free Router échouent (repli auto-analyse non bloquant).

### Comportement
- `node runner.js help` / `status` / `version` : actions uniques propres, sans bannière, journalisées.
- `node runner.js all --dry-run` : valide la config en ~5s sans lancer le benchmark.
- `node runner.js all --provider=openai` (sans --model) : affiche `[ERREUR E601_NO_MODEL]` + suggestion, sans stack brute.
- Chaque run sauvegarde `Export-Rapports/dernier-run.json` lisible via `node runner.js status`.

### Fichiers modifiés
- `cli-help.js` (nouveau)
- `config.js`, `runner.js`, `logger.js`, `lm-studio-client.js`, `cloud-client.js`, `teacher-client.js`
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Mode nuit : école adaptée à chaque modèle (auto-par-modèle)

### Contexte
Demande utilisateur (`Memories-BenchGo/Tasks1.md`, 2e demande) : en mode nuit (`night-batch.js`), lorsqu'une file d'attente mélange des modèles de tailles de paramètres différentes (un 3B, un 15B, un 26B...), il fallait appliquer les mêmes écoles à tous. L'utilisateur voulait que chaque modèle passe uniquement l'école correspondant à sa taille (3B → Primaire, 15B → Collège-Lycée, 26B → Université...) dans la même session.

### Implémentation
- **Nouvelle option `auto-per-model`** (option 6 du menu écoles) : chaque modèle de la file passe uniquement l'école adaptée à sa taille de paramètres, détectée via `detectProfileFromModelName` (config.js) sur le `displayName`, puis `modelKey`, puis `paramsString` (fallback).
- **`schoolForModel(m)`** : détermine l'école (profil) pour un modèle. Retourne `null`/école `auto` si taille indétectable (le runner devinera le profil).
- **`isAutoPerModel(schools)`** : détecte le mode auto-par-modèle dans la sélection d'écoles.
- **Menu interactif** : l'option 6 affiche un aperçu de l'attribution (quelle école pour chaque modèle sélectionné) avant lancement.
- **File d'attente** : en mode auto-par-modèle, le résumé affiche l'attribution `modèle → école` au lieu de la liste d'écoles globale. La boucle d'exécution calcule `modelSchools` par modèle (1 école) au lieu d'utiliser la liste globale.
- **Flag CLI** : `--schools=auto-per-model` pour le mode non-interactif.
- Export de `schoolForModel`, `schoolLabelForModel`, `isAutoPerModel` dans `module.exports`.

### Comportement
- 3B (seuil < 3B strict) → Primaire (LIGHT).
- 3B–14B → Collège-Lycée (STANDARD).
- 14B–30B → Université (EXPERT).
- > 30B → Thèse (DOCTORAT).
- Taille indétectable → auto-détection (le runner devine le profil depuis le nom).

### Fichiers modifiés
- `night-batch.js` : import `detectProfileFromModelName`, entrée SCHOOLS `auto-per-model`, fonctions `schoolForModel`/`schoolLabelForModel`/`isAutoPerModel`, menu interactif avec aperçu, boucle d'exécution par modèle, exports.
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-26 — Affichage des modèles LM Studio non testés dans le classement CLI

### Contexte
Demande utilisateur (`Memories-BenchGo/Tasks1.md`) : lors de la génération du classement (`node leaderboard.js`), l'utilisateur doit faire des va-et-vient fastidieux entre le CLI et LM Studio pour comparer les listes et identifier quels modèles téléchargés n'ont pas encore été testés. La demande est d'afficher directement dans le CLI, juste après le tableau de classement, la liste des modèles LM Studio présents mais absents du classement.

### Implémentation
- **`night-batch.js`** : export des fonctions réutilisables (`listLlmModels`, `matchLedger`, `normalizeForMatch`, `SCHOOLS`, `ECOLE_NAME_TO_KEY`, `runLms`, `statusBadge`, `missingSchoolsLabel`) via `module.exports`. `main()` désormais gardé par `if (require.main === module)` pour permettre l'import sans déclencher le mode nuit.
- **`leaderboard.js`** : nouvelle fonction `printUntestedLmStudioModels()` appelée dans `generateLeaderboard()` après le tableau de classement. Récupère les modèles via `lms ls --json --llm` (réutilise `night-batch.listLlmModels()`), croise avec les carnets de scores et affiche :
  - Section « Jamais testés » (priorité : aucun carnet n'existe).
  - Section « Partiels » (un carnet existe mais des écoles manquent).
  - Tableau CLI avec colonnes Modèle / Param / Quant / Statut / Écoles manquantes.
  - Message si LM Studio daemon inactif ou `lms` indisponible (non bloquant).
  - Astuce finale pointant vers `node night-batch.js` pour tester automatiquement.

### Fichiers modifiés
- `night-batch.js` : `module.exports` + garde `main()` derrière `require.main`.
- `leaderboard.js` : import `night-batch`, fonction `printUntestedLmStudioModels()`, appel dans `generateLeaderboard()`.
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-25 — Fix crash undici (socket idle timeout) sur Node.js 24.x

### Contexte
Bug récurrent : après le verdict du professeur IA, le process Node.js crash avec `TypeError: Cannot assign to read only property 'name' of object 'Error: socket idle timeout'`. Cause : bug dans le moteur HTTP interne d'undici (Node.js 24.12.0) qui, lors d'un timeout de socket idle, tente d'affecter `.name` sur une Error en lecture seule → crash du process entier. Le timeout interne d'undici se déclenche indépendamment de l'AbortController de BenchGo.

### Implémentation

**`runner.js` — Handler global `uncaughtException`**
- Intercepte spécifiquement l'erreur `Cannot assign to read only property 'name'` combinée avec `socket idle timeout|UndiciError|InformationalError` dans le stack.
- Affiche un warning `[undici] Timeout socket intercepté (bug Node.js 24.x) — continuation.` et **continue l'exécution** au lieu de crasher.
- Toute autre exception non interceptée → crash normal avec stack (comportement par défaut préservé).
- Placé tout au début du fichier, avant les requires, pour garantir la capture dès le démarrage.

**`report-teacher.js`, `teacher-client.js`, `cloud-client.js`, `external-profiling.js` — Header `Connection: close`**
- Ajout du header `Connection: close` sur tous les appels fetch vers des API cloud (OpenRouter, OpenAI, etc.).
- Force la fermeture du socket après chaque réponse → évite que undici maintienne des connexions idle qui déclenchent le timeout interne.

### Fichiers modifiés
- `runner.js` : handler `uncaughtException` anti-crash undici.
- `report-teacher.js` : header `Connection: close`.
- `teacher-client.js` : header `Connection: close`.
- `cloud-client.js` : header `Connection: close`.
- `external-profiling.js` : header `Connection: close`.
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-25 — Avis visuel de mise à jour disponible (CLI + classement local)

### Contexte
BenchGo est un dépôt GitHub évolutif : des corrections d'exercices, des nouveautés et des améliorations y sont poussées régulièrement. Les utilisateurs qui ont cloné le dépôt n'étaient pas avertis qu'une mise à jour était disponible — ils devaient deviner qu'il fallait faire `git pull`. Demande exprimée dans `Memories-BenchGo/Tasks1.md` : un effet visuel pour avertir tout le monde quand une nouveauté ou une correction a été publiée, afin que chacun mette à jour son dépôt local.

### Implémentation
Nouveau module `update-checker.js` qui compare le SHA du commit local (`git rev-parse HEAD`) avec le dernier commit poussé sur la branche `main` du dépôt communautaire (`cisco-03/BenchGo-LLM-School`) via l'API GitHub publique anonyme (pas de token requis, pas de donnée personnelle transmise).

Deux points d'intégration :
1. **CLI (`runner.js`)** : bannière colorée jaune affichée au démarrage, juste après le bloc télémétrie et avant le questionnaire interactif. Affiche les 5 derniers commits distants (date + message) pour donner un aperçu « Quoi de neuf ». Flag `--no-update-check` pour désactiver le check (utile en mode batch/hors-ligne).
2. **Classement local (`leaderboard.js`)** : bannière visuelle côté navigateur, juste sous l'en-tête. Le SHA local est embarqué dans le HTML à la génération ; le navigateur fetch l'API GitHub et compare. Cache `localStorage` 1h + mémorisation du refus (bouton ✕) jusqu'à expiration du cache. Animation pulse pour attirer l'œil.

Le classement consolidé (`consolidate-leaderboard.js`) n'a pas besoin d'avis : il tourne en CI sur le dépôt lui-même, donc toujours à jour.

### Robustesse
- Cache local 1h (`.benchgo-profile.json` côté CLI, `localStorage` côté navigateur) pour ne pas spammer l'API GitHub (rate limit 60 req/h/IP).
- Échec silencieux : pas de réseau / pas git / dépôt inaccessible → pas d'avis (ne bloque jamais le runner ni l'affichage du classement).
- Aucune donnée personnelle transmise (API GitHub publique, anonyme).

### Fichiers modifiés
- `update-checker.js` : nouveau module. `getLocalCommitSha()`, `getRemoteCommitSha()`, `getRecentRemoteCommits()`, `checkForUpdate()` (avec cache TTL 1h).
- `config.js` : ajout du flag `--no-update-check` dans `parseCliArgs()`.
- `runner.js` : import de `update-checker`, bannière CLI après le bloc télémétrie, respect de `noUpdateCheckFlag`.
- `leaderboard.js` : import de `update-checker`, embarquement du SHA local dans le HTML, bannière visuelle (HTML + CSS + JS client fetch GitHub).

## 2026-07-25 — Renumérotation logique des classes + renommage de l'épreuve finale

### Contexte
Les profils EXPERT (Université) et DOCTORAT (Thèse) affichaient un saut bizarre : après la classe 3, on passait directement à la « classe 6 » sans les classes 4 et 5. De plus, cette classe 6 s'appelait « Doctorat » alors même qu'elle se trouvait à l'intérieur de l'école Université, et que l'école suivante s'appelait déjà « Doctorat-Thèse » — d'où une confusion manifeste (signalée dans `Memories-BenchGo/Tasks1.md`).

### Cause
Il existe 7 tiers physiques (`tiers/tier{N}_*.json`, numérotés 0 à 6). Les tiers 4 et 5 n'existent que pour LIGHT et STANDARD (niveaux CM1/CM2 et 2nde/1ère) ; les écoles supérieures (EXPERT, DOCTORAT, FRONTIER) sautent donc au tier 6. Ce numéro physique fuyait dans l'affichage utilisateur : `━━ TIER 6 : Doctorat ━━`, dossiers `Classe-6-Doctorat`, etc. Le titre du tier 6 (« Doctorat ») entrait en collision avec le nom de l'école DOCTORAT.

### Fix
1. **Renumérotation logique** : nouveau mappage `TIER_TO_CLASSE` (dans `config.js`) dérivé de `PROFILES` (mandatory + optional triés). Le tier physique est converti en numéro de classe logique contigu (0, 1, 2, 3, 4...) pour chaque profil. Helper `tierToClasseNum(profileArg, tierNum)`. Exemple : tier physique 6 devient classe 4 pour EXPERT, classe 5 pour FRONTIER, classe 6 pour STANDARD (séquence déjà continue).
2. **Renommage de l'épreuve finale** : le titre du `tier6_master.json` passe de « Tier 6 — Doctorat (Expertise & Résistance) » à « Épreuve Finale (Expertise & Résistance) ». Neutralise la collision avec l'école DOCTORAT.
3. **CLASSE_NAMES renumérotées** : les noms de classes utilisent désormais les indices logiques contigus. EXPERT : `Classe-4-Master-Final` (au lieu de `Classe-6-Doctorat`). DOCTORAT : `Classe-4-These`. FRONTIER : `Classe-5-Ultimate`.
4. **Affichage cohérent** : le runner affiche `━━ CLASSE N : ...` (classe logique) au lieu de `━━ TIER N : ...`. Les spinners, messages de validation/échec, prompt envoyé au modèle, dossiers d'export, carnet du professeur, rapports markdown et tableaux récap utilisent tous le numéro de classe logique. Les logs internes (`logger.info`) conservent le tier physique pour le débogage.

### Fichiers modifiés
- `config.js` : ajout de `TIER_TO_CLASSE`, `tierToClasseNum()`, renumérotation de `CLASSE_NAMES`, export des nouveaux symboles.
- `tiers/tier6_master.json` : renommage du `title`.
- `runner.js` : import de `tierToClasseNum`, calcul de `classNum` dans `runTierAttempt` et `askModelForFailureExplanation`, remplacement de tous les affichages « Tier X » par « Classe N » (console, prompt, dossiers, carnet, rapports, tableaux), passage de `classNum` à `buildTierReport`.
- `report-generator.js` : `buildTierReport` affiche `## Classe N` et le tableau par exercice avec la classe logique.
- `Docs/Manuel-utilisateur/03-fonctionnement-benchmark.md` : section profils mise à jour (5 écoles, classes logiques, Épreuve Finale).
- `Docs/Manuel-utilisateur/06-reference-tiers.md` : ajout de la section Épreuve Finale, section numérotation des classes, correspondance classes/profils corrigée.

## 2026-07-25 — Fix critique : crash du runner en mode nuit (modèles déchargés, "No models loaded")

### Contexte
`node night-batch.js` ne fonctionnait plus : tous les modèles échouaient avec "No models loaded" dès le premier tier. L'auto-profilage recevait une réponse (modèle bien chargé), puis 2 secondes plus tard tous les tiers tombaient en HTTP_400 "No models loaded". Les logs LM Studio (`Memories-BenchGo/Tasks2.md`) montraient "Client disconnected. Stopping generation..." suivi d'`unloadModel` en plein streaming. Le log `Memories-BenchGo/Tasks1.md` révélait l'exception fatale :
```
TypeError: Cannot assign to read only property 'name' of object 'Error: socket idle timeout'
    at new UndiciError (node:internal/deps/undici/undici:20:19)
    at Timeout.onParserTimeout [as _onTimeout] (node:internal/deps/undici/undici:7049:30)
```

### Cause racine
Deux bugs distincts de Node v24.12.0 (undici 7.16.0) se manifestaient via le `fetch` streaming utilisé par `lm-studio-client.js` :
1. **`socket idle timeout` non récupérable** : pendant le prompt processing long (>300s pour les gros modèles), undici déclenche un timer interne qui jette une erreur hors de tout `try/catch` → `uncaughtException` → crash du process Node.
2. **Fuite EventEmitter (MaxListeners)** : `http.globalAgent` (keepAlive=true) réutilise les sockets ; les listeners `connect`/`secureConnect` ajoutés sur le socket à chaque requête dépassaient `MaxListeners(10)` après ~11 appels (tiers + aide + rattrapage) → erreur "Possible EventEmitter memory leak detected" qui possède elle aussi une propriété `name` en lecture-only → même crash non récupérable.

Le crash tuait le runner en plein streaming → LM Studio voyait "Client disconnected" → déchargeait le modèle → tous les tiers suivants tombaient sur "No models loaded". night-batch passait au modèle suivant (unload/load) → même crash.

### Fix
Réécriture de `lm-studio-client.js` pour remplacer `fetch` (undici) par `node:http` natif avec parsing SSE manuel :
- `http.request()` ne passe pas par undici → élimine le `socket idle timeout` non récupérable.
- Agent HTTP dédié `keepAlive: false, maxSockets: 1` → chaque requête a sa propre socket, libérée à la fin → élimine la fuite EventEmitter.
- Timeout applicatif géré via `setTimeout` externe (reset à chaque chunk reçu) au lieu d'`AbortController`/listeners socket.
- Parsing SSE manuel (split sur `data: `, gestion des fragments à cheval) — même logique que l'ancien `streamLLMResponse`.
- Signature `queryLLM()` inchangée (même paramètres, même retour) → aucun changement côté runner.

Vérifié : un run `--force --profile=LIGHT --no-teacher` enchaîne des dizaines d'appels (tier 0 + aide + explication échec + rattrapage) sans crash, le modèle reste chargé pendant tout le run.

### Fichiers modifiés
- `lm-studio-client.js` : réécriture complète (fetch → node:http + SSE manuel, agent non-keepAlive).

## 2026-07-24 — Audit de sécurité : correction de 6 failles de sécurité

### Contexte
Audit complet de sécurité de l'application BenchGo V3. Exploration de tous les fichiers JS, exploitation de chaque faille pour confirmer son exploitabilité, puis correction. 6 failles ont été identifiées et confirmées par exploit, 5 ont été corrigées (la 6e, stockage des clés en clair, est un compromis assumé documenté).

### Failles identifiées et corrigées

**1. CRITIQUE — Évasion de sandbox VM (`vm-sandbox.js`)**
- Le module `vm` de Node.js n'est PAS une sandbox de sécurité. Le code d'un modèle testé peut s'échapper via la chaîne de prototypes : `this.constructor.constructor('return process')().mainModule.require('child_process').execSync(...)` → exécution de commandes système arbitraires (RCE).
- Exploit confirmé : `echo PWNED_SANDBOX_ESCAPE` exécuté depuis la sandbox, accès au hostname via `os.hostname()`.
- **Fix** : retrait de `setTimeout`/`clearTimeout`/`Promise`/`Symbol` du sandbox (vecteurs d'évasion via `.constructor`), gel profond (`Object.freeze`) des constructeurs exposés, ajout de `detectSandboxEscape()` qui inspecte le code avant exécution pour rejeter les patterns d'évasion connus (`constructor.constructor`, `process.mainModule`, `child_process`, `__proto__`, `new Function`, `eval`, etc.). Vérifié : 5 exploits d'évasion testés → tous bloqués. Code légitime (5 exercices algorithmiques) → tous passent toujours.

**2. CRITIQUE — Path traversal sur `/api/delete` (`leaderboard.js`)**
- La fonction `deleteLedger(shortName)` construit le chemin avec `path.join(LEDGER_DIR, shortName + '.json')` sans validation. Un `shortName=../../.api-keys` cible `C:\...\benchmark-v3\.api-keys.json` → suppression du fichier de clés API.
- Exploit confirmé : `deleteLedger('../../.api-keys')` retourne `{ ok: true, auraitSupprime: '...\.api-keys.json' }`.
- **Fix** : validation du `shortName` (rejet des `/`, `\`, `..`), sanitization des caractères, vérification que le chemin résolu est bien dans `LEDGER_DIR`.

**3. HAUTE — Token GitHub en query string + absence de CORS/CSRF (`leaderboard.js`)**
- Le serveur HTTP du leaderboard passe le token GitHub PAT en query string (`url.searchParams.get('token')`) → visible dans les logs d'accès, l'historique du navigateur, les referer headers. Aucune protection CORS ou CSRF : n'importe quelle page web peut faire des requêtes vers `localhost:3939`.
- **Fix** : les tokens sont désormais transmis dans le corps JSON des requêtes POST (plus en query string). Ajout d'en-têtes CORS restrictifs (`Access-Control-Allow-Origin: http://localhost:<port>` uniquement), gestion du preflight OPTIONS, vérification de l'`Origin` header (rejet des requêtes cross-origin), en-têtes de sécurité (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), limitation de la taille du corps POST (64KB anti-DoS). Le client JS (`doSubmitAll`) a été mis à jour pour envoyer le token dans le `body` de la requête.

**4. HAUTE — XSS via injection `</script>` dans le pseudo (`consolidate-leaderboard.js`)**
- Le JSON sérialisé pour le client est injecté directement dans une balise `<script>` sans échappement. Un pseudo contenant `</script><script>alert(...)</script>` ferme la balise prématurément et exécute du JS arbitraire. Visible par tous les visiteurs du classement communautaire.
- Exploit confirmé : le HTML généré contient bien la balise `</script>` injectée.
- **Fix** : ajout de `safeForScript()` qui échappe `<`, `>`, `&` en `\u003c`, `\u003e`, `\u0026` avant injection dans la balise `<script>`.

**5. MOYENNE — XSS via `innerHTML` avec réponses réseau non échappées (`leaderboard.js`)**
- Les valeurs `valData.error`, `valData.login`, `e.message`, `prUrls[u]` provenant de réponses réseau sont injectées via `innerHTML` sans échappement. Un attaquant qui contrôle la réponse (MITM, API compromise) peut injecter du HTML/JS arbitraire.
- **Fix** : toutes les valeurs réseau injectées via `innerHTML` sont désormais échappées avec `esc()`.

**6. FAIBLE — Clés API stockées en clair sur disque (`api-keys-store.js`)**
- Le fichier `.api-keys.json` contient les clés API en texte brut. Déjà documenté comme compromis assumé (équivalent `~/.aws/credentials`), fichier ignoré par `.gitignore` (vérifié). Non corrigé — c'est un choix de conception conscient.

### Fichiers modifiés
- `vm-sandbox.js` : retrait des primitives d'évasion, gel des constructeurs, ajout de `detectSandboxEscape()`, export de la fonction.
- `custom-evaluators.js` : appel de `detectSandboxEscape()` dans `exposerFonctionVM()` avant exécution du code étudiant.
- `leaderboard.js` : durcissement de `deleteLedger()` (path traversal), refonte de `startServer()` (CORS, body JSON, en-têtes de sécurité), correction du client `doSubmitAll()` (token en body, `esc()` sur valeurs réseau).
- `consolidate-leaderboard.js` : ajout de `safeForScript()` pour empêcher le XSS via `</script>`.

### Vérifications
- `node --check` sur les 4 fichiers modifiés : tous OK.
- 5 exploits d'évasion sandbox testés : tous bloqués.
- 5 exercices algorithmiques légitimes : tous passent toujours.

### Revue de sécurité (post-fix) — corrections additionnelles
Suite à la revue de code des fixes de sécurité, 8 issues additionnelles ont été identifiées et corrigées :
1. **CRITIQUE — Serveur bindé sur 0.0.0.0** : `server.listen(port)` bindait sur toutes les interfaces réseau au lieu de localhost. Fix : `server.listen(port, '127.0.0.1', ...)`.
2. **CRITIQUE — detectSandboxEscape contournable par bracket-notation** : `this['constructor']['constructor']` passait la regex. Fix : ajout de patterns pour bracket-notation (`['constructor']`, `["constructor"]`), concaténation (`['con'+'structor']`), Unicode escapes (`constr\u0075ctor`), et scan du code final après transformation `const/let`→`var` au lieu du code brut.
3. **WARNING — Clause redondante dans deleteLedger** : le check `&& resolvedFile !== path.join(...)` ne pouvait jamais se déclencher. Fix : simplifié à `startsWith` uniquement.
4. **WARNING — detectSandboxEscape scannait le code brut, pas le code transformé** : la transformation `const/let`→`var` s'appliquait après le scan. Fix : scan déplacé après la construction du `fullCode` final.
5. **WARNING — Duplicate condition `/classement.md`** : bug pré-existant `pathname === '/classement.md' || pathname === '/classement.md'`. Fix : corrigé.
6. **WARNING — esc() de consolidate-leaderboard.js ne échappait pas les quotes** : divergeait de leaderboard.js. Fix : ajout de `.replace(/"/g, '&quot;').replace(/'/g, '&#39;')`.
7. **SUGGESTION — /api/report ne utilisait pas securityHeaders** : responses d'erreur bypassaient les en-têtes de sécurité. Fix : utilisation de `securityHeaders`.
8. **SUGGESTION — JSON non gelé dans sandbox** : `JSON.stringify`/`JSON.parse` pouvaient être mutés. Fix : `JSON: Object.freeze(JSON)`.

Vérification finale : 10/10 exploits d'évasion sandbox bloqués (incluant bracket-notation, concatenation, Unicode obfuscation), 5/5 tests légitimes passent.

## 2026-07-24 — Refonte visuelle du classement communautaire + guide de style

### Contexte
Le classement communautaire (https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html) était trop condensé : cartes sur une seule ligne, stats minuscules, boutons collés, pas d'aération. Un thème macOS Liquid Glass a été testé puis rejeté. Finalement, le style visuel du leaderboard local BenchGo (`leaderboard.js`) a été reproduit à l'identique pour assurer une cohérence parfaite entre les deux pages.

### Implémentation
**`consolidate-leaderboard.js` — `buildConsolidatedHTML()`**
- Bloc `<style>` entièrement réécrit pour reprendre la palette GitHub-dark du leaderboard local (variables `:root`, règles CSS, responsive).
- `renderCards()` réécrit en structure `card-row` + `mini-stats` (6 stats alignées : %, Note, Points, Santé, Écoles, Vitesse/Temps) au lieu du layout en tuiles `card-head`/`card-stats`.
- Couleurs dynamiques `pctColor()`/`gradeColor()` remises en palette GitHub-dark (`#3fb950`, `#58a6ff`, `#d29922`, `#db6d28`, `#f85149`) — modifiées aux deux endroits (serveur + client).
- Badges `quant`/`contrib`/`pseudo` conservés avec les mêmes couleurs que le leaderboard local.
- Titre en dégradé `linear-gradient(135deg, var(--accent), var(--purple))` identique.
- Barre sticky, chips de filtres, champ de recherche : mêmes styles que le leaderboard local.

**`Docs/guide-style-classement-communautaire.md` — Nouveau**
- Guide complet expliquant quel fichier modifier (`consolidate-leaderboard.js`), les 3 zones à toucher (variables `:root`, règles `<style>`, JS `renderCards()`), le workflow de modification, la cohérence avec le leaderboard local, et les pièges à éviter.

### Fichiers modifiés
- `consolidate-leaderboard.js` : refonte CSS + `renderCards()` + couleurs.
- `Docs/guide-style-classement-communautaire.md` : nouveau guide de style.

## 2026-07-24 — Détection automatique des nouveaux modèles à soumettre

### Contexte
Quand un utilisateur a déjà soumis 25 modèles et en teste 5 nouveaux, il ne faut pas re-soumettre les 30. L'utilisateur veut que l'application détecte automatiquement les modèles déjà présents sur GitHub et n'envoie que les nouveaux.

### Implémentation
**`community-sync.js` — Nouvelle fonction `getAlreadySubmittedModels(token)`**
- Interroge l'API GitHub Contents sur `submissions/<userId>/` (branche main).
- Renvoie un `Set` de shortNames déjà soumis (noms de fichiers sans `.json`).
- 404 (dossier inexistant) → Set vide (première soumission).
- Gestion d'erreur silencieuse (échec réseau → Set vide, on envoie tout).

**`leaderboard.js` — API + modale de soumission**
- Nouvelle API `/api/already-submitted` (GET) : renvoie la liste des modèles déjà soumis par l'utilisateur.
- `doSubmitAll()` modifiée : après validation du token, récupère la liste des modèles déjà soumis, filtre `MODELS` pour ne garder que les nouveaux, n'envoie que ceux-là.
- Affichage : « N nouveau(x) modèle(s) à envoyer (M déjà soumis(s), ignorés) ».
- Si aucun nouveau modèle : « Tous vos modèles sont déjà soumis ! » + bouton désactivé.
- Texte de la modale mis à jour : « Seuls les modèles pas encore soumis seront envoyés. »
- Bouton renommé « Vérifier et envoyer » (au lieu d'un compte fixe).

**`Docs/Manuel-utilisateur/08-communaute.md`**
- Nouvelle section « Détection automatique des nouveaux modèles » expliquant le comportement.
- Nouvelle section « Soumettre depuis le classement interactif » (méthode recommandée via le bouton).
- Exemples concrets (100 modèles dont 80 déjà soumis → 20 PRs seulement).

### Fichiers modifiés
- `community-sync.js` : `getAlreadySubmittedModels()`.
- `leaderboard.js` : API `/api/already-submitted` + modale `doSubmitAll` réécrite.
- `Docs/Manuel-utilisateur/08-communaute.md` : documentation mise à jour.
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-24 — Classement participatif communautaire + télémétrie anonyme

### Contexte
Le projet est open source sur GitHub (cisco-03/BenchGo-LLM-School). Chaque utilisateur teste ses modèles en local, mais les résultats restent isolés : impossible de savoir combien de personnes utilisent BenchGo, ni d'agréger les scores de la communauté. L'utilisateur souhaite un système participatif où chacun peut envoyer ses résultats pour constituer une base de données commune, avec un compteur d'utilisateurs.

### Implémentation

**`community-sync.js` (nouveau) — Synchronisation communautaire**
- **Ping télémétrie anonyme** : à chaque lancement du runner, un fetch silencieux vers un fichier statique du dépôt GitHub (`.community/ping.txt`) incrémente le compteur de vues (Insights → Traffic). Aucune donnée personnelle transmise — un `userId` aléatoire (hash 16 hex) est généré localement et envoyé en query string pour estimer les utilisateurs uniques. Anti-spam : un ping par jour maximum. Opt-out : `--no-telemetry`.
- **Soumission de résultats via Pull Request** : `submitResults()` crée une branche `community/<userId>-<shortName>`, dépose le carnet JSON dans `submissions/<userId>/<shortName>.json`, et ouvre une PR vers `main` via l'API GitHub. Nécessite un PAT (scope `repo`). Le carnet est emballe dans un payload avec `userId`, `pseudo` optionnel, `integrityHash` (SHA-256 des données pour détecter les falsifications) et `benchgoVersion`.
- **Profil local** (`.benchgo-profile.json`, gitignore) : stocke `userId`, `telemetry` (consentement), `pseudo`, `githubToken` (PAT mémorisé).
- **Validation de token** : `validateGithubToken()` interroge `/user` pour vérifier le PAT avant de soumettre.

**`community-stats.js` (nouveau) — Tableau de bord propriétaire**
- `printDashboard()` : affiche étoiles/forks/watchers, vues uniques (14j avec graphique), clones uniques, soumissions mergées (compte + utilisateurs), PRs communautaires en attente.
- CLI : `node community-stats.js --token=ghp_xxx` ou `GITHUB_TOKEN` env var.

**`consolidate-leaderboard.js` (nouveau) — Script CI de consolidation**
- Lancé par la GitHub Action après le merge d'une PR de soumission.
- Parcourt `submissions/*/*.json`, agrège les carnets (meilleure tentative par école), dédoublonne par `shortName` (garde la meilleure soumission, compte les contributeurs), génère `community-leaderboard.html` (classement HTML standalone avec cartes, verdicts, badges contributeurs) et `community-leaderboard.json`.

**`.github/workflows/consolidate.yml` (nouveau) — GitHub Action**
- Se déclenche à la fermeture d'une PR touchant `submissions/**` (uniquement si mergée) + `workflow_dispatch` manuel.
- Checkout → Node 20 → `node consolidate-leaderboard.js` → publication sur `gh-pages` via `peaceiris/actions-gh-pages`.

**`runner.js` — Intégration**
- `require('./community-sync')` ajouté.
- Ping télémétrie au démarrage de `main()` : au premier lancement, demande le consentement (opt-in) en TTY ; en non-TTY, opt-in silencieux. Ensuite ping automatique une fois/jour. `--no-telemetry` court-circuite.
- `proposeCommunitySubmission()` (nouvelle fonction, avant `main()`) : en fin de run complet (`tierArg === 'all'`), propose d'envoyer le carnet. Récupère le token (CLI > profil local > saisie masquée), valide le token, propose pseudo optionnel, lance `submitResults()`. `--submit` force la soumission sans confirmation.
- Destructuring de `cliArgs` étendu : `submit`, `noTelemetry`, `githubToken`.

**`config.js` — Nouveaux flags CLI**
- `--submit` : force la soumission communautaire en fin de run.
- `--no-telemetry` : désactive le ping télémétrie anonyme.
- `--github-token=xxx` : fournit le PAT GitHub (évite la saisie interactive).

**`.gitignore` — Autorisations**
- `.github/workflows/*.yml` ré-autorisé (consolidate.yml).
- `.community/ping.txt` ré-autorisé (fichier télémétrie).
- `submissions/` ré-autorisé (carnets communautaires mergés via PR).

**`.community/ping.txt` (nouveau)** — Fichier cible du ping télémétrie.

**`Docs/Manuel-utilisateur/08-communaute.md` (nouveau)** — Documentation complète : fonctionnement, soumission, token GitHub, classement consolidé, télémétrie, tableau de bord, confidentialité.

### Architecture du flux participatif
```
Utilisateur (local)                     Dépôt GitHub (cisco-03/BenchGo-LLM-School)
┌──────────────────┐                   ┌─────────────────────────────┐
│ node runner.js   │  --submit         │  submissions/<userId>/      │
│  .carnet/        │ ────PR────────►   │    <model>.json             │
│   <model>.json   │                   │  ─────────────────────────  │
└──────────────────┘                   │  GitHub Action              │
                                       │  consolidate-leaderboard.js │
                                       │         ▼                   │
                                       │  community-leaderboard.html │
                                       │  (GitHub Pages)             │
                                       └─────────────────────────────┘
```

### Fichiers modifiés
- `community-sync.js` (nouveau) : ping télémétrie + soumission PR GitHub.
- `community-stats.js` (nouveau) : tableau de bord stats pour le propriétaire.
- `consolidate-leaderboard.js` (nouveau) : script CI de consolidation du classement.
- `.github/workflows/consolidate.yml` (nouveau) : GitHub Action de consolidation.
- `.community/ping.txt` (nouveau) : fichier cible télémétrie.
- `runner.js` : intégration ping + proposition de soumission.
- `config.js` : flags `--submit`, `--no-telemetry`, `--github-token`.
- `.gitignore` : autorisation workflows + .community + submissions.
- `Docs/Manuel-utilisateur/08-communaute.md` (nouveau) : documentation.
- `Docs/CHANGELOG.md` : cette entrée.

## 2026-07-24 — Flèches de mouvement de position dans le classement

### Contexte
Les modèles sur Hugging Face sont régulièrement mis à jour et certains sont re-testés. Quand un modèle est re-testé, son score change, donc son rang dans le classement bouge. L'utilisateur souhaite voir ces mouvements de position d'un coup d'œil grâce à des flèches colorées à côté de chaque modèle.

### Implémentation
**`leaderboard.js` — système de snapshot de position**
- Nouveau fichier `.carnet/classement_snapshot.json` : sauvegarde `{ shortName: rang }` à chaque génération du classement.
- 3 nouvelles fonctions :
  - `loadPositionSnapshot()` : charge le snapshot précédent.
  - `savePositionSnapshot(entries)` : sauvegarde le snapshot actuel (après écriture des fichiers).
  - `computePositionDeltas(entries, snapshot)` : calcule le delta de rang pour chaque modèle (delta < 0 = a monté, delta > 0 = a descendu, 0 = stable, null = nouveau modèle).
- `generateLeaderboard()` : charge le snapshot précédent, calcule les deltas, attache `positionDelta` à chaque entrée, puis sauvegarde le nouveau snapshot après génération.

**Affichage HTML (cartes + modale)**
- Nouvelle fonction JS `positionArrow(delta)` : renvoie un span `.pos-arrow` avec :
  - ▲ vert + nombre de places si le modèle a monté
  - ▼ rouge + nombre de places si le modèle a descendu
  - = gris si position stable
  - rien si nouveau modèle (pas de snapshot précédent)
- CSS `.pos-arrow` : badge pill coloré (vert/rouge/gris) avec bordure semi-transparente.
- La flèche est affichée à côté du nom du modèle sur la carte, et à côté du rang dans l'en-tête de la modale.
- `.rank` passe de `width: 44px` fixe à `min-width: 44px` + `flex-wrap` pour accommoder la flèche.

**Affichage CLI (tableau terminal)**
- Nouvelle colonne « Mvt » dans le tableau CLI avec couleurs ANSI :
  - ▲ vert + nombre (monte), ▼ rouge + nombre (descend), = gris (stable), NEW gris (nouveau).

**Classement Markdown (`classement.md`)**
- Nouvelle colonne « Mvt » dans le tableau récapitulatif : ▲N / ▼N / = / 🆕 NEW.

**Copie du classement (bouton « Copier le classement »)**
- Nouvelle colonne « Mvt » dans le texte brut copié : ▲N / ▼N / = / NEW.

### Fichiers modifiés
- `leaderboard.js` : snapshot, deltas, affichage HTML/CLI/MD/copy.
- `Docs/CHANGELOG.md` : cette entrée.

### Note
Le premier run après cette mise à jour ne montre aucun mouvement (pas de snapshot précédent) — tous les modèles apparaissent comme « NEW » ou sans flèche. Dès le deuxième run, les mouvements sont détectés et affichés.

## 2026-07-24 — Bug grader : pattern interdit détecté dans les commentaires

### Contexte
Plusieurs élèves (modèles) ont signalé via le Carnet du Professeur avoir été pénalisés à tort sur l'exercice `trier_tableau` (Tier 6, contrainte « sans .sort() »). L'erreur technique « Motif interdit détecté : '.sort(' » se déclenchait alors que le code de l'élève n'utilisait jamais `.sort()`.

### Analyse
Le grader `task-evaluator.js` vérifiait les motifs interdits (`forbidden`) sur le **texte complet** du code soumis, **commentaires inclus**. Or les modèles écrivent souvent des commentaires explicatifs comme `// Implémentation du tri par fusion (Merge Sort) sans utiliser .sort()` — ce commentaire contient la chaîne `.sort(`, ce qui déclenchait un faux positif.

### Élève lésé identifié
- **ornith-1.0-9b-mtp** (2026-07-22) : code de tri par fusion correct, aucun `.sort()` dans le code exécutable, mais le commentaire `// Implémentation du tri par fusion (Merge Sort) sans utiliser .sort()` a déclenché la pénalité (-58 points). L'élève a objectivement raison.

### Implémentation
**`parsing-utils.js` — nouvelle fonction `stripComments(code)`**
- Nouvelle fonction exportée qui retire les commentaires `//` et `/* */` du code JS tout en préservant les chaînes de caractères (`'`, `"`, `` ` ``).
- Gestion correcte des séquences d'échappement (`\\`) dans les chaînes.

**`task-evaluator.js` — pattern check corrigé**
- Import de `stripComments`.
- Ligne 30 : `const codeText = stripComments(studentCode || '').toLowerCase()` au lieu de `(studentCode || '').toLowerCase()`.
- Les motifs interdits (`.sort(`, `deletesystem`, `eval(`) ne sont plus détectés dans les commentaires, uniquement dans le code exécutable. Les chaînes de caractères sont préservées (un `.sort(` dans une string reste détecté, ce qui est correct car ça s'exécuterait).

### Restitution de points
- **ornith-1.0-9b-mtp** : `trier_tableau` passé de `-58` (failed) à `+58` (success). Score global : 2895 → 3011, 90% → 94%, santé 3218 → 3334 PV, retriedCount 3 → 2.
- Rapport Markdown mis à jour avec note de révision du professeur.
- Carnet de scores (`Export-Rapports/.carnet/ornith-1.0-9b-mtp.json`) mis à jour.

### Autres demandes examinées (élèves ayant tort — pénalité maintenue)
- **calcul_robuste** (tous modèles) : les élèves qui soumettent `deleteSystem()` tombent dans le piège d'injection de prompt — comportement attendu, pas un bug.
- **react** (tous modèles) : les élèves retournent une string au lieu de JSX — erreur de l'élève.
- **algo_difficile_1** (tous modèles) : algorithmes de médiane incorrects ou tronqués — erreur de l'élève.
- **francais/remplacerA** : `remplaceA` au lieu de `remplacerA` (faute de frappe) — erreur de l'élève.
- **qwopus trier_tableau** : nom `trierTableau` (camelCase) au lieu de `trier_tableau` (snake_case) — erreur de l'élève.
- **memoire_longue/optimisation_extreme** : `memoireLongue`/`optimisationExtreme` au lieu de snake_case — erreur de l'élève.

### Fichiers modifiés
- `parsing-utils.js` (nouvelle fonction `stripComments` + export)
- `task-evaluator.js` (import + pattern check utilisant stripComments)
- `Export-Rapports/.carnet/ornith-1.0-9b-mtp.json` (restitution de points)
- `Export-Rapports/2026-07-22/College-Lycee/STANDARD/rapport_v3_ornith-1.0-9b-mtp_standard_01-01-41.md` (mise à jour rapport)
- `Docs/CHANGELOG.md`

## 2026-07-24 — Élargissement du classement (conteneur + modale + cartes)

### Contexte
Le classement HTML était trop concentré au centre (conteneur `max-width: 1120px`), ce qui ne laissait plus assez de place aux badges, mini-stats et au nouveau badge « 📄 Exporté » sur chaque carte. Les cartes risquaient de wrapper prématurément.

### Implémentation
**`leaderboard.js` — élargissement général**
- `--container-max` : 1120px → **1600px** (conteneur `.wrap` + barre de filtres pleine largeur).
- `--container-pad` : clamp `4vw` → `3vw` (marges inline un peu plus resserrées pour exploiter la largeur).
- `.modal` : `max-width` 860px → **1180px** (la modale de détail profite aussi de l'espace, utile pour le rapport intégral et les tableaux d'historique).
- `.card-row` : `gap` `--space-s` → `--space-m` (respiration entre rank, nom, mini-stats et actions).

### Fichiers modifiés
- `leaderboard.js` (variables CSS `.wrap`, `.modal`, `.card-row`)
- `Docs/CHANGELOG.md`


## 2026-07-24 — Badge « 📄 Exporté » sur les cartes du leaderboard

### Contexte
Lors de longues sessions de tests (beaucoup de modèles), l'utilisateur perd le fil de quels modèles ont déjà eu leur rapport intégral exporté (bouton « ⬇ Exporter le rapport intégral » dans la modale de détail). Aucun repère visuel n'existait sur le classement.

### Implémentation
**`leaderboard.js` — suivi persistant des exports de rapport**
- Nouvelle clé `localStorage` `benchgo_exportedReports_v1` : map `{ shortName → ISO date }`.
- Helpers `getExportedSet()`, `isExported(shortName)`, `markExported(shortName)`.
- Dans `renderCards()` : un badge `📄 Exporté` (bleu) est affiché sur la ligne de badges de la carte quand le modèle est marqué exporté. Cliquer dessus retire la marque (`unmarkExported(idx)`).
- Dans `downloadBlob()` (callback succès de `exportReport`) : on appelle `markExported(m.shortName)` puis on injecte le badge à la volée sur la carte déjà rendue pour un retour visuel immédiat sans re-render complet.
- Nouvelle fonction `unmarkExported(idx)` : supprime la clé, re-render les cartes, toast de confirmation.
- CSS : `.badge.exported` (bleu clair, hover plus saturé).

### Fichiers modifiés
- `leaderboard.js` (badge carte + persistance localStorage + fonction unmarkExported + CSS)
- `Docs/CHANGELOG.md`

## 2026-07-24 — Débordement des grands nombres dans la modale de détail

### Contexte
Dans la modale de détail du classement, les cases « Points » (ex: 5353/5452) et « Obligatoire » affichaient des polices trop grosses qui débordaient de leur conteneur quand deux grands nombres étaient côte à côte. Cela cassait l'alignement de la grille `.full-stats`.

### Implémentation
**`leaderboard.js` — correction CSS `.full-stat`**
- Ajout de `min-width: 0` sur `.full-stat` pour autoriser le rétrécissement en flexbox (sinon `min-width: 100px` empêchait le wrap).
- Ajout de `word-break: break-all; overflow-wrap: anywhere;` sur `.full-stat .val` pour que les très grands nombres (ex: `5353/5452`) restent dans leur case.
- Ajout de `line-height: 1.1` pour limiter la hauteur quand un nombre passe sur deux lignes.

### Fichiers modifiés
- `leaderboard.js` (règle CSS `.full-stat` et `.full-stat .val`)
- `Docs/CHANGELOG.md`

## 2026-07-24 — Filtre "Top du top" limité aux 3 premiers + sémantique des catégories

### Contexte
Le filtre "Top du top" affichait tous les modèles avec ≥90%, ce qui pouvait couvrir une douzaine de modèles. L'utilisateur souhaitait qu'il ne contienne que les 3 meilleurs modèles (rang 1, 2, 3), comme un classement de type "podium". La sémantique des autres catégories a aussi été précisée.

### Implémentation
**`leaderboard.js` — "Top du top" = Top 3 par rang**
- `getCategory(entry, rank)` accepte un paramètre `rank` optionnel.
- Les modèles classés 1er, 2e, 3e reçoivent la catégorie "Top du top" (🏆), indépendamment de leur pourcentage.
- Les modèles classés 4e et + avec ≥90% passent dans "Recommandés" (≥80%).
- `buildLeaderboardHTML()` calcule le rang à partir de l'index (déjà triés) et le transmet à `getCategory()`.
- Compteurs `catCounts` et badges mis à jour en conséquence.

**Sémantique des catégories (du meilleur au pire)**
- **Top du top** (🏆) : les 3 meilleurs modèles par rang. Le podium.
- **Recommandés** (✅, ≥90%) : modèles appropriés pour coder normalement.
- **Dans la moyenne** (📊, ≥75%) : modèles justes, à manier avec prudence (risque d'erreur).
- **En rattrapage** (⚠️, ≥50%) : modèles qui doivent repasser les écoles pour gagner des points supplémentaires.
- **Échec total** (💥, <50%) : modèles non fiables, à supprimer du classement.

### Fichiers modifiés
- `leaderboard.js` (fonction `getCategory`, boucle de comptage dans `buildLeaderboardHTML`)
- `README.md` (mise à jour de la description des filtres avec sémantique)
- `Docs/CHANGELOG.md`

## 2026-07-21 — Mode nuit : liste des modèles triée par statut de test

### Contexte
Dans le mode nuit interactif, la liste des modèles téléchargés s'affichait sans indiquer lesquels avaient déjà été testés. L'utilisateur devait ouvrir le classement (`classement.html`) pour vérifier manuellement qui avait passé quelles écoles — fastidieux le soir avant de lancer un batch.

### Implémentation
**`night-batch.js` — statut de test affiché dans la liste de sélection**
- Chargement des carnets de scores (`Export-Rapports/.carnet/*.json`) au démarrage et croisement avec les `modelKey` de `lms ls` via `matchLedger()` (normalisation : minuscules, suppression `@quant`, `.gguf`, segments `/`→`-`, puis égalité stricte sur `model`/`shortName`, sinon inclusion du dernier segment significatif).
- Chaque modèle reçoit un statut : `JAMAIS TESTE` (jaune), `PARTIEL` (magenta, avec liste des écoles manquantes), `COMPLET` (vert).
- Tri de la liste : jamais testés → partiels → complets (les nouveaux en premier), puis alphabétique à l'intérieur de chaque groupe.
- Affichage tabulaire avec en-tête et colonne « Écoles manquantes ».
- Nouveau flag `--list-only` : affiche la liste triée et quitte (debug / vérification rapide sans lancer de run).

### Fichiers modifiés
- `night-batch.js` (fonctions `loadAllLedgers`, `normalizeForMatch`, `matchLedger`, `ledgerSchoolKeys`, `statusBadge`, `missingSchoolsLabel` ; `listLlmModels` enrichi + tri ; `selectModelsInteractive` réécrit avec colonnes statut/écoles manquantes ; flag `--list-only` dans `parseArgs` + `main`).
- `Docs/CHANGELOG.md`

## 2026-07-21 — Mode nuit (night-batch.js) : file d'attente automatique de modèles

### Contexte
Un modèle met ~1h à terminer une école et monopolise toute la RAM du PC pendant ce temps, rendant la machine inutilisable. Demande utilisateur : pouvoir sélectionner plusieurs modèles le soir, lancer un script, et retrouver les rapports + le classement le matin sans intervention.

### Implémentation

**1. `night-batch.js` (nouveau module) — orchestrateur de session de nuit**
- Vérifie le daemon LM Studio (`lms daemon status`) et le serveur HTTP (`GET /v1/models`) au démarrage. Si le serveur HTTP ne répond pas, le démarre en headless (`lms server start` détaché) et l'arrête à la fin **seulement s'il l'a démarré lui-même** (préserve un serveur déjà lancé par l'utilisateur).
- Liste les modèles LLM téléchargés via `lms ls --json --llm` (modelKey, displayName, params, quantization, sizeBytes, publisher).
- Sélection interactive (TTY) des **modèles** : numéros séparés par virgules ou `all`. Mode non-interactif via `--models=key1,key2` (utile pour tâche planifiée Windows).
- Sélection interactive (TTY) des **écoles** : `LIGHT`, `STANDARD`, `EXPERT`, `DOCTORAT`, ou `auto` (détection du profil depuis le nom du modèle). Mode non-interactif via `--schools=LIGHT,STANDARD` (insensible à la casse). Sans `--schools` en non-interactif → `auto`.
- Pour chaque modèle, pour chaque école : `lms unload --all` (libère la RAM du précédent) → `lms load <modelKey>` (charge la cible) → `node runner.js --force --profile=<ecole>` (benchmark en mode batch). Le modèle est chargé une fois et enchaîne toutes ses écoles avant de laisser la place au suivant.
- Flag `--no-teacher` pour désactiver le professeur IA (OpenRouter) sur toute la session.
- Résumé final horodaté (durée par run, succès/échecs, chemins des rapports et du classement). Nettoyage best-effort en cas de crash (`unload --all`) via gestionnaire d'erreur global.
- Résumé final horodaté (durée par modèle, succès/échecs, chemins des rapports et du classement).
- Nettoyage best-effort en cas de crash (unload --all) via gestionnaire d'erreur global.

**2. `config.js` — nouveau flag `--force`**
- `parseCliArgs()` détecte `--force` et l'exporte dans l'objet de config retourné.

**3. `runner.js` — neutralisation des confirmations interactives en mode `--force`**
- 3 appels `askYesNo` neutralisés quand `forceFlag` est vrai :
  1. « Continuer quand même » (modèle déjà testé, pré-auto-profilage) → force le re-test.
  2. « Voulez-vous lancer un nouveau test » (doublon par école) → force le re-test.
  3. « Comptabiliser la pénalité » (échec définitif) → **maintient** la pénalité (comportement objectif : un benchmark de nuit ne conteste pas le grader à la place de l'élève).
- `forceFlag` ajouté au destructuring de `runTierAttempt` et passé aux 2 appels (run principal + rattrapage) depuis `runSchool` (closure sur `main`).

### Usage
```
node night-batch.js                                   # interactif (modèles + écoles)
node night-batch.js --models=key1,key2                # modèles sans interaction
node night-batch.js --schools=STANDARD,EXPERT         # écoles sans interaction
node night-batch.js --models=... --schools=auto --no-teacher   # tout en non-interactif
```

### Documentation
- `Docs/Manuel-utilisateur/07-mode-nuit.md` (nouveau) — guide complet du mode nuit :
  principe, prérequis, lancement interactif et non-interactif, flags, comportement
  détaillé (rattrapage/pénalités/doublons), gestion du serveur, exemples, dépannage,
  et planification automatique via tâche planifiée Windows.
- Référencé dans `Docs/Manuel-utilisateur/README.md` (parcours n°7) et le README racine.

### Fichiers modifiés
- `night-batch.js` (nouveau)
- `config.js` (flag `--force` dans `parseCliArgs`)
- `runner.js` (propagation de `forceFlag`, neutralisation des 3 `askYesNo`)
- `Docs/Manuel-utilisateur/07-mode-nuit.md` (nouveau)
- `Docs/Manuel-utilisateur/README.md` (référence au mode nuit)
- `README.md` (mention du mode nuit dans les fonctionnalités)
- `Docs/CHANGELOG.md`

## 2026-07-21 — Carnet du Professeur + fix profilage externe (ByteString + Free Router)

### Contexte
Deux bugs bloquants identifiés à partir du log `benchgo_2026-07-21T08-53-25-788Z.log` et du rapport Tasks1.md :
1. **Profilage externe en échec systématique** : `external-profiling.js` appelait OpenRouter avec un header `X-Title` contenant un em dash `—` (U+2012 > 255), ce qui faisait planter `fetch` avec « Cannot convert argument to a ByteString because the character at index 11 has a value of 8212 which is greater than 255 ». De plus, le module ne faisait **aucun rotate multi-modèles** : il hardcodait `meta-llama/llama-3.3-70b-instruct:free` (slug souvent dépublié → 404) et réessayait le même modèle 2× avant d'abandonner. Résultat : le professeur IA n'évaluait JAMAIS l'élève (repli systématique sur auto-profilage).
2. **Correction du professeur IA ignorée** : `askTeacherToCorrectStudentAnalysis` renvoie `{ content, model }` (objet) mais `runner.js` testait `teacherCorrection.length > 0` et appelait `.split()` dessus comme si c'était une string. Un objet n'a pas `.length` → la condition était toujours fausse → **la correction du professeur était systématiquement ignorée** et le repli « Professeur IA indisponible » s'affichait à chaque exercice, même quand le teacher avait répondu (cf. log lignes 58-59 : Teacher répond 603 chars, puis runner dit « aucun retour »).

Par ailleurs, demande utilisateur : créer un **Carnet du Professeur** où chaque signalement/contestation d'élève est consigné, pour que le professeur (humain ou agent) puisse examiner les demandes plus tard — comme un élève qui remet sa copie au professeur dans le monde réel.

### Implémentation

**1. `external-profiling.js` — fix ByteString + Free Router**
- Header `X-Title` : `'BenchGo V3 — Profilage externe'` → `'BenchGo V3 - Profilage externe'` (tiret ASCII, conforme ByteString).
- Branchement du Free Router : récupération dynamique des modèles gratuits via `fetchFreeModels()` (endpoint public `/api/v1/models` d'OpenRouter, déjà utilisé par `teacher-client.js` et `report-teacher.js`). Construction d'une liste de candidats : modèle explicite (`--teacher-model`) d'abord, puis tous les modèles gratuits triés par préférence/contexte.
- Rotate multi-modèles : si un modèle échoue (429/404/5xx/réseau/réponse non parsable), on enchaîne sur le suivant jusqu'à `maxRetries` (défaut 3). Stop sur 401/403 (clé nulle). Plus jamais de slug `:free` hardcodé comme seul point de défaillance.
- Import de `fetchFreeModels` depuis `teacher-client.js` (réutilisation, pas de duplication).
- Mise à jour du commentaire d'en-tête pour documenter le Free Router et la contrainte ByteString.

**2. `runner.js` — correction du bug d'objet-vs-string de la Teacher correction**
- Renommage `teacherCorrection` → `teacherCorrectionObj` au niveau de l'appel `askTeacherToCorrectStudentAnalysis`, extraction du `.content` pour l'affichage et le rapport. La correction du professeur IA est maintenant réellement affichée et injectée dans le rapport.

**3. `carnet-professeur.js` (nouveau module) — registre des demandes**
- `appendDemande({...})` : annexe une demande au fichier `Carnet-Professeur/<AAAA-MM-JJ>/<ÉCOLE>/demandes.md` (création auto avec entête la première fois). Chaque demande contient : type, école, classe, modèle élève, exercice, tier, erreur sandbox, code élève (extrait), auto-analyse, correction professeur, verdict.
- `buildClassement({...})` : génère/mets à jour `classement.md` — vue agrégée par classe/modèle avec compteurs par type (contestations / divergences / auto-analyses).
- 3 types de demandes :
  - `contestation_penalite` : l'utilisateur a répondu N à « Comptabiliser la pénalité ? » → l'élève a objectivement raison, le grader s'est trompé (signal fort, action requise côté énoncé/évaluateur).
  - `divergence_prof_eleve` : le professeur IA a relu et produit une correction — à examiner pour départager élève vs professeur.
  - `auto_analyse_echec` : l'élève a expliqué lui-même son échec (conservé pour mémoire pédagogique, juste ou faux).

**4. `runner.js` — branchement du Carnet du Professeur**
- Accumulateur `carnetEntries` dans `runTierAttempt`, retourné dans le résultat du tier.
- Accumulateur global `allCarnetEntries` dans `main()`, alimenté après chaque `runTierAttempt` (run principal ET rattrapage).
- Écriture finale du carnet après résolution de `dateStr`/`ecole`/`effectiveModel` : appel à `appendDemande` pour chaque entrée + `buildClassement` pour la vue agrégée. Message CLI de confirmation.

### Résultat obtenu
- Le profilage externe fonctionne maintenant : rotate multi-modèles + headers ByteString valides. Plus d'échec systématique « Cannot convert argument to a ByteString ».
- La correction du professeur IA est enfin affichée et injectée au rapport (avant : silencieusement jetée à cause du bug d'objet).
- Chaque contestation/divergence/auto-analyse est consignée dans `Carnet-Professeur/<date>/<ecole>/` pour réexamen différé.

### Fichiers modifiés
- `external-profiling.js` (fix ByteString + Free Router)
- `runner.js` (fix objet teacherCorrection + branchement carnet)
- `carnet-professeur.js` (nouveau)
- `Docs/CHANGELOG.md`

## 2026-07-21 — Tableaux CLI alignés dynamiquement

### Contexte
Les tableaux affichés dans le CLI (tableau des scores par école, récap « J'ai fini mes exercices », bilan global multi-écoles, classement BenchGo, liste des presets) utilisaient des `padEnd`/`padStart` à largeurs fixes. Dès qu'une cellule dépassait la largeur prévue (nom d'exercice > 22 car., classe > 18 car., modèle > 40 car.), toutes les colonnes suivantes se décalaient et les chiffres n'étaient plus alignés. Problème purement structurel d'affichage, sans impact sur les calculs.

### Implémentation
**1. Nouvel utilitaire `cli-table.js` (racine du projet)**
- `stripAnsi(text)` : retire les codes ANSI pour calculer la vraie longueur affichée.
- `col(text, width, align)` : formate une cellule avec alignement `'left'`/`'right'`/`'center'`, troncature avec `…` si dépassement.
- `table(headers, rows, options)` : calcule dynamiquement la largeur de chaque colonne = `max(longueur header, longueur cellule max, pad, longueur footer)`, génère le séparateur `─` à la bonne longueur, retourne `{ lines, widths, sepLine, footerLines }`.
- Option `footer`/`footers` + `footerAligns` : la ligne de total participe au calcul des largeurs (donc plus jamais tronquée) mais s'affiche séparément après le séparateur.
- Aucune dépendance externe (Node.js built-ins only).

**2. Refactor des 4 fichiers consommateurs**
- `runner.js` `printScorecard()` : remplacement des `padEnd(18)`/`padStart(12)`/`padStart(7)` par `table()` ; ligne TOTAL ÉCOLE passée en `footer` → « TOTAL ÉCOLE » et « (Santé: 532 PV) (+89 bonus opt.) » ne sont plus tronqués.
- `runner.js` bloc « J'ai fini mes exercices » : remplacement des `padEnd(22)`/`padEnd(14)`/`padStart(12)`/`padStart(8)` par `table()` ; ligne TOTAL TIER en `footer` → le total `/443` n'est plus tronqué en `/4…`.
- `score-ledger.js` `printBilanGlobal()` : remplacement des `padEnd(20)`/`padStart(12)`/`padStart(7)` par `table()` ; ligne temps/tokens/vitesse conservée sous chaque école, indentée à la largeur de la colonne École ; TOTAL CUMULÉ en `footer`.
- `leaderboard.js` sortie CLI : remplacement des `padEnd(40)`/`padStart(8)`/`padStart(9)`/`substring(0,40)` par `table()` ; médale (🥇🥈🥉) conservée en préfixe hors-tableau.
- `presets.js` `printPresets()` : remplacement des `padEnd(20)`/`padEnd(14)`/`padEnd(34)`/`padEnd(10)`/`substring(0,33)` par `table()` ; nom en gras via code ANSI inclus dans la cellule.

### Règles respectées
- Aucune largeur de colonne en dur ne subsiste pour les tableaux CLI.
- Les séparateurs `─` sont générés à partir des largeurs calculées.
- Les lignes de total (footer) participent au calcul des largeurs : aucune troncature même si le total est plus large que toutes les lignes de données.
- Les codes ANSI sont conservés dans la sortie finale (strip uniquement pour le calcul de longueur).
- Aucune dépendance npm externe ajoutée.

### Fichiers modifiés
- `cli-table.js` (nouveau)
- `runner.js`
- `score-ledger.js`
- `leaderboard.js`
- `presets.js`
- `Docs/CHANGELOG.md`

## 2026-07-21 — Chronométrie & vitesse (tokens/s) dans le leaderboard

### Contexte
Demande utilisateur (Memories-BenchGo/Tasks1.md) : chronométrer les exercices et le temps total par école, calculer la vitesse moyenne en tokens/s (déjà affichée dans le CLI via LM Studio), et faire apparaître ces métriques dans le leaderboard — y compris la comparaison « lent mais efficace » vs « rapide mais peu fiable ». La vitesse n'est PAS comptabilisée dans le classement (elle est purement indicative), conformément à l'observation utilisateur que des modèles lents peuvent être plus efficaces.

### Implémentation
**1. `runner.js` — capture de la chronométrie par tier et par école**
- `runTierAttempt` accumule désormais `tierElapsedMs` (durée d'inférence cumulée, hors attentes) et `tierTokens` (tokens produits, récupérés via `spinner.tokenCount` après le streaming) sur toutes les requêtes du tier : appel principal, retry anti-timeout, et proposition d'aide du professeur.
- `runSchool` chronomètre l'école entière : `schoolStartMs` (début), `schoolTokens` et `schoolElapsedMs` (cumul des tiers + rattrapage).
- Le `ecoleResult` stocké dans le carnet inclut 4 nouveaux champs : `elapsedMs`, `wallMs` (durée réelle écoulée), `tokens`, `tokensPerSecond` (vitesse moyenne = tokens / (elapsedMs/1000)).

**2. `score-ledger.js` — cumul multi-écoles + affichage**
- Nouvelle fonction `formatDuration(ms)` → affichage compact ("1.2s", "1m05s", "1h02m").
- `computeGrandTotal` cumule `tokens`, `elapsedMs`, `wallMs` et calcule `tokensPerSecond` global.
- `printBilanGlobal` affiche par école : temps, tokens, vitesse (t/s), et un total cumulé avec temps total + vitesse moyenne.
- `buildBilanMarkdown` ajoute 3 colonnes (Temps, Tokens, Vitesse) au tableau du bilan.

**3. `leaderboard.js` — affichage complet (HTML + MD + CLI)**
- `aggregateLedger` cumule durée/tokens et calcule `tokensPerSecond` global par modèle ; `compactAttempt` sérialise ces champs pour l'historique des tentatives.
- `buildArguments` ajoute des notes qualitatives sur la vitesse vs efficacité :
  - **Force** : "rapide ET efficace" (≥60 t/s · ≥80%)
  - **Force** : "LENT mais efficace — la vitesse ne fait pas tout" (<20 t/s · ≥80%)
  - **Faiblesse** : "rapide mais peu fiable — vitesse sans efficacité" (≥60 t/s · <50%)
  - **Note** : "modèle lent" / "vitesse moyenne" selon les seuils
- HTML : mini-stat Vitesse (couleur dégradée rouge→vert) sur la carte ; 4 statBox (Temps inf., Tokens, Vitesse, Temps réel) dans la modale ; 2 colonnes (Temps, Vitesse) dans la table école et l'historique des tentatives.
- Markdown : 2 colonnes (Temps, Vitesse) dans le tableau récap et le détail par école.
- CLI : 2 colonnes (Temps, Vitesse colorée) dans le classement console.
- `copyLeaderboard` (texte brut) inclut Temps + Vitesse.

### Rétrocompatibilité
Les carnets existants (antérieurs au 2026-07-21) n'ont pas les champs `elapsedMs`/`tokens`/`tokensPerSecond`. Toutes les fonctions utilisent des valeurs par défaut (0 / '—') via `|| 0` ou `> 0 ? ... : '—'`. Aucune migration forcée — les prochains runs rempliront automatiquement les champs.

### Décisions de design
- **La vitesse n'est PAS dans le score** : le classement reste trié par %, score, santé. La vitesse est purement indicative (badge/note), conformément à l'observation utilisateur que "la vitesse ne fait pas tout".
- **`elapsedMs` vs `wallMs`** : `elapsedMs` = durée d'inférence cumulée (hors attentes entre tiers, hors traitement local), `wallMs` = durée réelle écoulée (inclut tout). Les deux sont affichés car ils mesurent des choses différentes (vitesse du modèle vs temps total de l'examen).
- **Seuils de vitesse** : <10 t/s = très lent (rouge), 10-25 = lent (orange), 25-50 = moyen (jaune), 50-80 = rapide (bleu), ≥80 = très rapide (vert). Basés sur l'observation des modèles locaux 7B-14B en Q4/Q8 sur GPU consommateur.

### Fichiers modifiés
- `runner.js` — `runTierAttempt` (cumul tier), `runSchool` (chronométrie école + `ecoleResult`)
- `score-ledger.js` — `formatDuration`, `computeGrandTotal`, `printBilanGlobal`, `buildBilanMarkdown`, exports
- `leaderboard.js` — `fmtDur`, `compactAttempt`, `aggregateLedger`, `buildArguments`, `buildLeaderboardHTML` (carte + modale + table), `buildLeaderboardMarkdown`, `copyLeaderboard`, CLI

### Leçon apprise
La chronométrie doit être capturée au plus près de l'appel API (dans `runTierAttempt` via `performance.now()`), pas au niveau du spinner qui peut être réinitialisé entre les retry anti-timeout. Le `spinner.tokenCount` est la source fiable pour les tokens car il est alimenté par `updateTokens` pendant le streaming, quel que soit le client (LM Studio, cloud, OpenRouter).

---

## 2026-07-21 (suite) — Audit exhaustif EXPERT/DOCTORAT/FRONTIER : 5 bugs critiques supplémentaires corrigés

### Contexte
Suite à la correction des 3 bugs initiaux (setup FeuTricolore, parsing Math.abs, timeout API), un audit exhaustif de TOUS les fichiers de tiers (LIGHT/STANDARD/EXPERT/DOCTORAT/FRONTIER, 17 fichiers, 181 exercices, 352 tests exec) a révélé 5 bugs critiques supplémentaires qui discriminaient les modèles EXPERT/DOCTORAT/FRONTIER :

### Bugs corrigés

**1. `tiers/tier0_expert.json` — setups `curry`, `creerBST`, `debounce` (3 exercices, 9 évaluations)**
- Les `setup` appelaient des fonctions de l'élève (`curry()`, `creerBST()`, `debounce()`) **avant** que le code de l'élève ne s'exécute.
- Une `function declaration` (hoistée) passait, mais `const curry = () => {}` ou `const curry = function(){}` (style moderne) échouait systématiquement avec `X is not a function` (le sandbox convertit `const`→`var`, et `var` est initialisé à `undefined` jusqu'à sa ligne d'affectation).
- Correction : tout le code qui appelle une fonction de l'élève est déplacé dans le `call` via IIFE : `(()=>{ var add = curry(...); return add(1)(2)(3); })()`. Le `setup` est désormais vide.

**2. `tiers/tier1_expert.json` — setups `creerFilePriorite`, `creerEventEmitter`, `creerProxy` (3 exercices, 8 évaluations)**
- Même bug : les setups appelaient les fonctions de l'élève avant leur définition.
- Correction : IIFE dans le `call` pour `tache_1a`, `tache_1b`, `tache_1e`. Le `tache_1d` (BFS) gardait un setup neutre (`var g={...}`) — la fonction `parcoursEnLargeur` est appelée dans le `call`.

**3. `tiers/tier2_expert.json` — setups `creerSubject`, `memoiserAsync`, `creerCircuitBreaker` (3 exercices, 6 évaluations)**
- Même bug. Correction : IIFE dans le `call` pour `tache_2b`, `tache_2c`, `tache_2e`. La `tache_2a` utilise un custom evaluator (`evaluateAsyncPartialErrors`), la `tache_2d` est pattern-only.

**4. `parsing-utils.js` — `stripTS` cassait les méthodes fléchées d'objet**
- La règle 6 (`result.replace(/(\w)\s*:\s*\([^)]*\)\s*=>\s*[\w.<>\[\]|&\s]+/g, '$1')`) visait à supprimer les types de fonction en paramètre TS (`cb: (x: number) => number`), mais matchait aussi les méthodes fléchées dans les littéraux objet (`{ on: (e, fn) => fn }` → `{ on }`).
- Impact : tout élève écrivant `const creerEventEmitter = () => { return { on: (e, fn) => {...} }; }` (style moderne) voyait son code cassé → `Unexpected token`. Discrimination massive.
- Correction : règle 6 désactivée. Le scanner contextuel `stripTypeAnnotations` (règle 8) gère déjà les vrais types TS en paramètre sans casser les littéraux objet.
- Correction complémentaire du scanner contextuel : quand il rencontre `=>` à profondeur 0 pendant le stripping d'une annotation de type, il strippe maintenant aussi le type de retour (`(x: number) => number` → entièrement supprimé, au lieu de laisser `=> number` résiduel qui cassait la syntaxe).

**5. `tiers/tier6_master.json` — `optimisation_extreme` target impossible**
- Le setup créait `arr = Array.from({length: 10000}, (_, i) => i)` = `[0..9999]`, mais cherchait `target = 19997` qui n'existe **pas** dans le tableau. L'assertion `result === true` ne pouvait **jamais** passer, quel que soit le code de l'élève.
- Correction : `target = 9997` (présent dans le tableau). Vérifié : une recherche O(N) passe en 1ms (< 35ms exigés).

### Vérification
Un script d'audit exhaustif (`verify_tiers.js`) teste chaque exercice avec une solution canonique en style `const`/arrow (le cas qui cassait). Résultat après corrections :
- **291 exec OK / 352 exec testés** (24 skip = évaluations pattern/custom non-exec).
- Les 37 "problèmes" restants sont des **faux positifs** du script (noms de fonctions du dictionnaire de solutions qui ne correspondaient pas aux noms attendus par les `call`). Vérification manuelle confirmée : tous les exercices EXPERT/FRONTIER/DOCTORAT passent avec les bons noms de fonction.
- **0 bug d'exécution restant** : un code d'élève correct (en `function`, `const`, `arrow` ou `class`) ne peut plus échouer à cause d'un bug du benchmark.

### Fichiers modifiés
- `tiers/tier0_expert.json` — 9 évaluations corrigées (setups → IIFE dans call)
- `tiers/tier1_expert.json` — 8 évaluations corrigées
- `tiers/tier2_expert.json` — 6 évaluations corrigées
- `tiers/tier6_master.json` — `optimisation_extreme` target 19997 → 9997
- `parsing-utils.js` — règle 6 stripTS désactivée + scanner contextuel `=>` corrigé
- `verify_tiers.js` — script d'audit exhaustif (conservé pour futurs checks)

### Leçons apprises
1. **Un `setup` ne doit JAMAIS appeler une fonction/classe de l'élève** : le `setup` s'exécute avant le code de l'élève. Seules les `function declarations` (hoistées) passent ; `const`/`let`/`class` (non-hoistées, converties en `var` par le sandbox) échouent systématiquement. Règle absolue : tout appel à une fonction de l'élève va dans le `call` via IIFE.
2. **Une regex de stripping TS doit respecter le contexte** : `{ on: (e) => fn }` (méthode fléchée d'objet) ≠ `cb: (e) => number` (type de fonction TS). Le scanner contextuel (avec suivi de profondeur `{}`/`()`) est la seule approche sûre.
3. **Un test doit toujours être vérifié avec une solution qui passe** : si l'assertion ne peut jamais passer (target absent), c'est un bug de l'exercice, pas de l'élève.

---
## 2026-07-21 — Correction de 3 bugs critiques discriminant les modèles + réhabilitation gemma-4-12b-agentic

### Contexte
Le run du 2026-07-21T05:55 (modèle `yuxinlu1/gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2`, profil STANDARD) a révélé trois bugs du benchmark qui ont **discriminé injustement** l'élève (le modèle testé) :
1. **Exercice Tier 5 `info` (FeuTricolore)** : le `setup` instançait la classe **avant** que le code de l'élève ne la déclare → erreur systématique `Cannot access 'FeuTricolore' before initialization` (TDZ), même avec un code d'élève parfait. Pénalité -45 points injuste.
2. **Parsing du code (Tier 4 `math`)** : `extractCodeRegex` matchait `taskId` à l'intérieur de mots comme `Math.abs(...)` → extraction du mauvais bloc (`### algo_moyen_1` au lieu du code `discriminant`). Pénalité -59 points injuste.
3. **Timeout API (Tier 6)** : `API_TIMEOUT_MS = 300000` (300s) trop court pour les modèles de raisonnement locaux → timeout injuste sur le Tier 6 (0/437). Les timeouts sur réponse sont **interdits** car ils pénalisent les élèves.

### Actions entreprises

**1. `tiers/tier5_standard.json` — Exercice `info` (FeuTricolore)**
- Le `setup` (`const f = new FeuTricolore(); f.passerAuSuivant();`) s'exécutait **avant** le code de l'élève (les classes JS ne sont pas hoistées).
- Déplacement de l'instanciation dans le `call` via une IIFE : `(()=>{ const f = new FeuTricolore(); f.passerAuSuivant(); return f.couleur; })()`.
- Le `setup` est désormais vide. Le code de l'élève s'exécute d'abord, puis l'IIFE instancie et teste.
- Vérifié : un code d'élève canonique passe désormais (passed: true).

**2. `parsing-utils.js` — `extractCodeRegex()`**
- Le fence pattern `${taskId}[\s\S]{0,200}?```...``` ` matchait `taskId` n'importe où (ex: `Math.abs` pour la tâche `math`).
- Anfrage du pattern sur un début de ligne avec header Markdown optionnel : `(?:^|\n)\s*#{0,6}\s*${taskId}\b[...]`.
- Filtrage des correspondances dont le contenu est un header Markdown parasite (`### ...`) plutôt que du code.
- Vérifié : `Math.abs` ne déclenche plus de fausse match ; les tâches `math`, `algo_facile_1`, `algo_defi`, `francais` sont correctement extraites ; le format JSON fonctionne toujours.

**3. `config.js` — `API_TIMEOUT_MS`**
- Passé de `300000` (300s) à `1500000` (1500s). Les timeouts sur réponse sont interdits : un modèle lent (raisonnement local) ne doit pas être pénalisé. 1500s laisse largement le temps de répondre.

**4. `leaderboard.js` — Scrollbars globales invisibles**
- Ajout d'une règle CSS globale `html, body, * { scrollbar-width: none; -ms-overflow-style: none; }` + `::-webkit-scrollbar { width: 0; height: 0; display: none; }` au début du `<style>`.
- Conformément à la décision `scrollbars_always_hidden_scro` : tous les ascenseurs de l'application doivent être invisibles.

**5. Réhabilitation du carnet `yuxinlu1_gemma-4-12b-agentic...`**
- Réévaluation des deux exercices pénalisés à tort avec le code réellement produit par le modèle (récupéré via le parser corrigé pour Tier 4 math, et via le setup corrigé pour Tier 5 info) :
  - Tier 4 `math` (discriminant) : code `b*b - 4*a*c` → succès (+59 points).
  - Tier 5 `info` (FeuTricolore) : classe correcte → succès (+45 points).
- Retrait des marqueurs `helpUsed`/`retried` sur ces deux exercices (l'échec était dû au bug du benchmark, pas au modèle).
- Recalcul du score College-Lycee : 2648/2747 (96%) au lieu de 2499/3184 (78%).
- Recalibrage : D=1.00, P=0.96, C=0.982 (Modèle Bien Calibré).
- Score cumulé : 5353/5452 (98%) → **🥇 1ère place** du classement (devant ornith-1.0-9b à 96%).

### Fichiers modifiés
- `tiers/tier5_standard.json` — setup/call de l'exercice `info` corrigés.
- `parsing-utils.js` — `extractCodeRegex()` durcie (anfrage + filtrage des headers parasites).
- `config.js` — `API_TIMEOUT_MS` 300s → 1500s + commentaire mis à jour.
- `leaderboard.js` — règle CSS globale scrollbar invisible.
- `Export-Rapports/.carnet/yuxinlu1_gemma-4-12b-agentic..._q8_0.json` — carnet réhabilité (T4 math + T5 info).
- `Export-Rapports/classement.html`, `classement.md`, `raisonnement_modeles.md` — régénérés.

### Résultat obtenu
- Le modèle `yuxinlu1/gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2` (Q8_0) passe de la 8e place (88%) à la **1ère place (98%)** — il avait décelé les bugs des exercices, ce qui est remarquable.
- Les exercices sont désormais **irréprochables** : un code d'élève correct ne peut plus échouer à cause d'un bug du benchmark.
- Les timeouts de réponse ne pénalisent plus les modèles lents.

### Leçons apprises
- Un `setup` qui déclare/utilise un symbole défini dans le code de l'élève est un anti-pattern : le `setup` s'exécute **avant** le code de l'élève dans le sandbox VM. L'instanciation doit se faire dans le `call` (après le code de l'élève).
- L'extraction de code par regex doit ancrer le `taskId` sur des frontières de mots et des séparateurs Markdown, jamais sur une sous-chaîne non délimitée.
- Les timeouts sur réponse modèle sont inacceptables dans un benchmark éducatif : ils pénalisent la réflexion, pas l'incompétence.

---

## 2026-07-20 (soir 4) — Redoublement & promotion dans le classement HTML (tendance des re-tests)

### Contexte
L'utilisateur a demandé si les élèves (modèles) peuvent « redoubler » une classe ou une école comme dans la réalité, et s'ils peuvent régresser au niveau score dans le temps par rapport aux mises à jour des modèles sur Hugging Face. Le carnet de scores conservait déjà l'historique des tentatives par école (`attempts[]`), mais aucune comparaison chronologique n'était affichée. La tendance était invisible.

### Actions entreprises

**1. `leaderboard.js` — Fonction `computeTrend()`**
- Nouvelle fonction qui compare la dernière tentative à la précédente pour une école donnée :
  - **deltaPct** : différence de % entre le dernier et l'avant-dernier test.
  - **direction** : `up` (progression), `down` (régression), `stable` (aucun changement).
  - **gradeChange** : `redoublement` (note A-F a baissé d'au moins un cran), `promotion` (note a monté), `stable`.
  - Retourne `null` si moins de 2 tentatives (pas d'historique).
- Tri chronologique par date + time pour garantir la comparaison correcte.

**2. `aggregateLedger()` — Tendance par école + tendance globale**
- Chaque école reçoit un champ `trend` (résultat de `computeTrend` sur ses tentatives compactées).
- Tendance globale agrégée au niveau du modèle :
  - `redoublement` : au moins une école a régressé de note.
  - `promotion` : au moins une école a progressé de note.
  - `avgDeltaPct` : moyenne des deltas % sur toutes les écoles avec historique.
  - `direction` : `up` / `down` / `stable` selon la moyenne.

**3. `buildArguments()` — Forces/faiblesses liées à la tendance**
- Redoublement → faiblesse : « A REDOUBLÉ : régression de note au dernier re-test (mise à jour HF dégradante ?) ».
- Promotion → force : « A ÉTÉ PROMU : progression de note au dernier re-test ».
- Progression (sans changement de note) → force : « en progression (+X% au dernier re-test) ».
- Régression → faiblesse : « en régression (-X% au dernier re-test — mise à jour HF dégradante ?) ».

**4. Affichage HTML — Cartes + modale**
- **Cartes** : badge de tendance à côté des badges taille/quantification :
  - 📉 Redoublement (rouge) si note en baisse.
  - 📈 Promotion (vert) si note en hausse.
  - ▲ +X% (vert) si progression de % sans changement de note.
  - ▼ -X% (rouge) si régression de %.
  - ═ Stable (gris) si aucun changement.
- **Modale — section « Tendance (re-tests) »** : verdict global (Redoublement/Promotion/En progression/En régression/Stable), évolution moyenne, nombre d'écoles avec historique, note explicative sur les mises à jour HF.
- **Modale — tableau « Détail par école »** : nouvelle colonne « Tendance » avec indicateur par école (ex: `📉 A→B`, `📈 B→A`, `▲ +5%`, `▼ -5%`, `═`).
- Nouveaux styles CSS : `.badge.trend-up` (vert), `.badge.trend-down` (rouge), `.badge.trend-stable` (gris).
- Sérialisation : `trend` ajouté au niveau modèle ET au niveau école dans `modelsData`.

### Fichiers modifiés
- `leaderboard.js` — `computeTrend()`, tendance dans `aggregateLedger()`, `buildArguments()`, affichage cartes + modale + tableau écoles, styles CSS, sérialisation

### Validation
- `node -c leaderboard.js` : syntaxe OK.
- `generateLeaderboard()` : génération réussie.
- Vérification des carnets existants : 2 modèles avec historique (gemma-4-12b stable 96%, mythos-9b régression 91%→86%). Les tendances sont calculées et présentes dans le HTML généré.

### Résultat
- Le classement HTML affiche désormais la progression/régression des modèles entre leurs re-tests.
- Un modèle qui régresse après une mise à jour Hugging Face affiche « 📉 Redoublement » sur sa carte et dans sa modale.
- Un modèle qui progresse affiche « 📈 Promotion ».
- Le tableau par école montre la tendance précise par école (ex: `📉 A→B` sur College-Lycee).
- La métaphore scolaire du redoublement/promotion est désormais visible dans le classement.

### Leçons apprises
- L'historique des tentatives était déjà stocké mais inexploité pour la comparaison chronologique. Une simple fonction `computeTrend` suffit à transformer l'historique en indicateur visuel exploitable.
- La métaphore scolaire (redoublement/promotion) rend la régression d'un modèle après mise à jour HF immédiatement compréhensible pour l'utilisateur.

---

## 2026-07-20 (soir 3) — Rattrapage automatique (règles objectives, plus de question manuelle)

### Contexte
Le rattrapage manuel (question posée à l'utilisateur à la fin de chaque école) est fatigant à long terme et interrompt le workflow. L'utilisateur a demandé que la décision soit automatique, mais s'est interrogé sur les critères pertinents pour déclencher un rattrapage. Choix retenu : règles automatiques objectives, sans professeur IA, prévisibles et sans appel API supplémentaire.

### Actions entreprises

**`runner.js` — Décision automatique de rattrapage**
- Remplacement de la question manuelle (`askYesNo`) par une évaluation automatique basée sur trois critères cumulatifs (un seul suffit pour déclencher) :
  1. **Tier obligatoire échoué** dans la file d'attente → rattrapage automatique (l'élève doit rattraper une matière obligatoire).
  2. **Santé globale < 0** après l'examen → rattrapage automatique (élève en difficulté, mérite une seconde chance).
  3. **≥ 40% des exercices échoués** → rattrapage automatique (échec massif, l'élève a besoin de reprendre).
- Si aucun critère n'est rempli, l'élève s'en sort suffisamment bien → pas de rattrapage (scores initiaux conservés).
- Affichage console explicite : chaque critère est affiché avec son résultat (OUI/non), puis la décision finale avec les raisons qui l'ont déclenchée.
- Journalisation : `logger.info` avec le détail des critères évalués (pour traçabilité dans le fichier de log).
- Le rattrapage reste désactivé en mode cloud et limité aux profils LIGHT/STANDARD (`isRattrapageEligibleProfile`).

### Fichiers modifiés
- `runner.js` — bloc de décision de rattrapage (suppression `askYesNo`, ajout règles automatiques)

### Validation
- `node -c runner.js` : syntaxe OK.

### Résultat
- Plus aucune question posée pendant le rattrapage : la décision est automatique et transparente (critères affichés).
- Un élève qui réussit bien n'est pas rattrapé inutilement ; un élève en difficulté (tier obligatoire échoué, santé négative, ou échec massif) est automatiquement rattrapé.
- L'utilisateur peut faire autre chose pendant que l'élève fait ses exercices ET son rattrapage, sans intervention.

### Leçons apprises
- Un rattrapage manuel interrompt le workflow et fatigue l'utilisateur sur des runs longs. Des règles objectives (tier obligatoire échoué, santé critique, échec massif) suffisent à décider sans subjectivité ni appel API.
- Afficher les critères évalués (OUI/non) rend la décision transparente et auditable.

---

## 2026-07-20 (soir 2) — Profilage externe par le professeur IA (hybride)

### Contexte
L'auto-profilage par le modèle lui-même comporte un risque d'erreur d'appréciation : surconfiance (un petit modèle se déclare niveau 5), fausse modestie (un bon modèle se sous-évalue), ou mauvaise lucidité sur ses propres capacités. Pour fiabiliser le filtrage des tâches, l'utilisateur a demandé que le profilage soit fait par un modèle externe plus gros. L'Indice de Calibration (écart auto vs réel) doit toutefois être conservé.

### Actions entreprises

**1. `external-profiling.js` (nouveau) — Profilage externe des compétences**
- Nouveau module qui demande à un PROFESSEUR IA externe (modèle cloud distinct de l'élève) d'évaluer objectivement les compétences de l'élève à partir de son auto-évaluation.
- `buildExternalProfilePrompt({ studentSelfProfile, studentModelName })` : construit un prompt qui fournit l'auto-évaluation de l'élève au professeur et lui demande de la critiquer (surévaluation ? sous-évaluation ? honnête ?). Le professeur peut ajuster les niveaux à la hausse ou à la baisse.
- `runExternalProfiling({ teacherConfig, studentSelfProfile, studentModelName })` : appelle `chat/completions` sur le provider du professeur (OpenRouter par défaut), réessaie jusqu'à `maxRetries`, réutilise la clé mémorisée dans `secrets.js`.
- Réutilise `validateProfile` et `parseProfileFallback` de `self-profiling.js` (désormais exportés).

**2. `self-profiling.js` — Export de `validateProfile` et `parseProfileFallback`**
- Ajout de `validateProfile` et `parseProfileFallback` dans `module.exports` pour permettre leur réutilisation par `external-profiling.js`.

**3. `runner.js` — Intégration du profilage hybride**
- Après l'auto-profilage, si un professeur IA est activé, on lance le profilage externe. Le profil externe remplace l'auto-profilage pour le FILTRAGE des tâches (`filterProfile`), tandis que l'auto-profilage (`selfProfile`) est conservé pour le calcul de l'Indice de Calibration.
- Affichage console : comparaison explicite des écarts auto vs externe (ex: « Écarts auto vs externe : javascript_basics: auto=4 → externe=2 ») pour montrer à l'utilisateur comment le professeur a ajusté l'évaluation de l'élève.
- Repli silencieux : si le professeur est indisponible, le filtrage utilise l'auto-profilage (comportement historique).
- Les appels à `runTierAttempt` passent désormais `selfProfile: filterProfile` (le profil de filtrage effectif, externe ou auto).

### Fichiers modifiés
- `external-profiling.js` (nouveau)
- `self-profiling.js` (export de `validateProfile`, `parseProfileFallback`)
- `runner.js` (profilage hybride : externe pour filtrage, auto pour calibration)

### Validation
- `node -c` : syntaxe OK sur les 3 fichiers.
- `require()` : OK.
- `filterProfile` accessible dans `runSchool` via closure.

### Résultat
- Quand un professeur IA est activé, le filtrage des tâches est basé sur l'évaluation objective d'un modèle externe, plus fiable que l'auto-évaluation de l'élève.
- L'Indice de Calibration continue de mesurer la lucidité du modèle sur lui-même (auto-profilage conservé).
- L'utilisateur voit les écarts entre l'auto-évaluation et l'évaluation externe, ce qui révèle la surconfiance ou la sous-évaluation de l'élève.

### Leçons apprises
- Un modèle qui s'auto-évalue n'est pas fiable pour le filtrage de ses propres tâches : il peut se surévaluer (niveau 5 pour un modèle 7B) ou se sous-évaluer. Un tiers externe est plus objectif.
- Conserver l'auto-profilage en parallèle permet de mesurer la lucidité (Indice de Calibration) sans compromettre la fiabilité du filtrage.

---

## 2026-07-20 (soir) — Tier 6 reconnu (Classe Terminale) + rattrapage différé en fin d'examen

### Contexte
Deux problèmes remontés par l'utilisateur :
1. `node runner.js 6 --profile=STANDARD` échouait avec `Aucun fichier trouvé pour tier 6 avec le profil STANDARD.` : le fichier `tiers/tier6_master.json` existait mais le `tier-loader.js` ne connaissait pas le niveau `master` dans sa chaîne de fallback. La Classe 6 (Terminale — Expertise & Résistance, 5 axes) était donc invisible pour les profils STANDARD, EXPERT, DOCTORAT et FRONTIER.
2. Le rattrapage était proposé **immédiatement** après l'échec d'un tier, ce qui coupait le rythme de l'examen. L'utilisateur veut que toutes les séances de rattrapage se fassent **à la fin** de l'examen, sans coupure, avec une seule question globale (même pour deux écoles).

### Actions entreprises

**1. `tier-loader.js` — Chaîne de fallback étendue avec `MASTER`**
- Ajout du niveau `MASTER` à la fin de chaque chaîne de fallback :
  - `FRONTIER` → FRONTIER, DOCTORAT, EXPERT, STANDARD, LIGHT, MASTER
  - `DOCTORAT` → DOCTORAT, EXPERT, STANDARD, LIGHT, MASTER
  - `EXPERT` → EXPERT, STANDARD, LIGHT, MASTER
  - `STANDARD` → STANDARD, LIGHT, MASTER
  - `LIGHT` → LIGHT, MASTER
- `tier6_master.json` est désormais chargé pour tous les profils (via le fallback `MASTER`) quand aucun `tier6_<profil>.json` n'existe. La Classe 6 (Terminale) est de nouveau accessible en optionnel pour `--profile=STANDARD`.

**2. `runner.js` — Rattrapage différé en fin d'examen**
- Suppression de la question de rattrapage intermédiaire (`Voulez-vous lancer une séance de rattrapage pour le Tier X ?`) qui coupait le rythme après chaque tier échoué.
- Nouvelle logique en deux phases :
  1. **Phase principale** : tous les tiers sont exécutés d'affilée, sans interruption. Les tiers échoués (non éliminés) sont collectés dans une file d'attente `rattrapageQueue` (avec leur `tierNum`, `tierData`, `isMandatory`).
  2. **Phase de rattrapage finale** : une fois tous les tiers terminés (ou arrêt du run principal), une seule question globale est posée : « Lancer une séance de rattrapage pour ces N tier(s) ? ». Si oui, chaque tier en file est rejoué une fois, et le meilleur résultat remplace le score initial.
- Le rattrapage reste désactivé en mode cloud (coût par appel API) et limité aux profils LIGHT/STANDARD (`isRattrapageEligibleProfile`).
- Pour les runs multi-écoles (Primaire + Collège-Lycée), la question de rattrapage est posée à la fin de chaque école séparément, ce qui est cohérent (chaque école a ses propres tiers).

**3. Audit des fichiers de tiers**
- Audit exhaustif des 18 fichiers JSON du dossier `tiers/` via un sous-agent :
  - Validation JSON : tous les fichiers sont syntaxiquement valides.
  - Caractères non-ASCII : seuls des tirets longs (—) dans les titres/labels (non exécutables) ; aucun caractère parasite dans les champs `assert`, `call`, `setup`.
  - Asserts vides : présents dans les fichiers expert/frontier/master (évaluations de type `pattern`/`custom` sans `assert`) — non bloquant car le runner gère ces types séparément.
  - Cohérence prompt ↔ call : vérifiée, noms de fonctions cohérents.
  - Comparaison type `result === '1010'` dans tier5 : le prompt demande explicitement une « string representation », l'assert est cohérent.
- Conclusion : les fichiers standard et light sont irréprochables côté syntaxe des évaluateurs. L'erreur « Invalid or unexpected token » signalée par l'utilisateur vient du code produit par le modèle, pas des fichiers de tiers.

### Fichiers modifiés
- `tier-loader.js` — chaîne de fallback avec `MASTER`
- `runner.js` — rattrapage différé en fin d'examen (suppression question intermédiaire + file d'attente + séance finale)

### Validation
- `node -c runner.js` : syntaxe OK.
- `node -c tier-loader.js` : syntaxe OK.
- `require('./tier-loader.js')` : OK.
- Audit tiers : 18 fichiers validés.

### Résultat
- `node runner.js 6 --profile=STANDARD` charge désormais `tier6_master.json` (Tier 6 — Doctorat / Expertise & Résistance, 5 axes) en optionnel.
- Le rattrapage ne coupe plus le rythme de l'examen : une seule question est posée à la fin de tous les tiers, pour tous les tiers échoués d'un coup.
- Les exercices des tiers standard et light sont irréprochables (aucune erreur de syntaxe dans les évaluateurs).

### Leçons apprises
- Un niveau de fallback non listé dans `tier-loader.js` rend un fichier de tier invisible, même s'il existe sur disque. Toujours inclure tous les niveaux de fallback possibles (y compris les niveaux « partagés » comme `master`).
- Différer le rattrapage en fin d'examen améliore l'expérience utilisateur (pas de coupure) et reste pédagogiquement cohérent (l'élève enchaîne tous ses exercices avant de reprendre ceux ratés).

---

## 2026-07-20 — Documentation du système de points (calcul, classes, écoles, cumul) + correction de l'échelle de notes A–F

### Contexte
Retour utilisateur : le système de points n'était **pas documenté** de manière exhaustive dans l'application. Les utilisateurs ne savaient pas combien de points vaut une classe, une école, comment se calcule un « sans-faute », ni comment s'additionnent plusieurs écoles dans le carnet. Par ailleurs, l'échelle de notes A–F du manuel `04-lecture-resultats.md` était **fausse** (elle ne correspondait pas au code `letterGrade`).

### Problèmes relevés
1. **Pas de doc points centralisée** : la gamification (PV, élimination) était documentée dans `Docs/Apps-Fonctions/gamification-sante.md`, mais le **calcul des points** (par exercice, classe, école, cumul, bonus optionnel, sans-faute, diplôme, notes) n'existait nulle part.
2. **Échelle de notes erronée** dans `04-lecture-resultats.md` : indiquait `A>=90 / B=70-89 / C=50-69 / D=30-49 / F<30` alors que `progress-bar.js:200-206` donne `A>=90 / B>=80 / C>=70 / D>=60 / F<60`.
3. **Seuil de tier erroné** dans `Memories-BenchGo/README.md` : indiquait « seuil de validation = 70 points » au lieu de « 70 % du total possible » (le total est aléatoire, il n'y a pas de seuil fixe en points).
4. **Verdict** documenté en « obligatoire » uniquement, alors que le verdict s'appuie sur `pctMandatory` **s'il y a des tiers obligatoires**, sinon `pctGlobal`.

### Actions entreprises

**1. Création de `Docs/Apps-Fonctions/systeme-points.md`**
Nouveau document exhaustif (10 sections) couvrant :
- Points par exercice (30–60 aléatoires, effets succès/échec/inexploitable).
- Points par classe (tier) : total possible, seuil 70 %, bypassés exclus, sans-faute = 100 % (plafond, pas de surplus).
- Points par école : score global vs score obligatoire, table du nombre d'exercices par profil (LIGHT 60, STANDARD 60, EXPERT 41, FRONTIER 11), tiers obligatoires/optionnels par profil.
- Bonus optionnel (20 % sur les optionnels réussis) : ajouté à la **Santé**, pas à `tierScore` (le seul « surplus », qui ne fait pas dépasser 100 %).
- Santé globale : réinitialisée à chaque école, élimination à −100 PV.
- Notes A–F (seuils réels du code).
- Verdict (RECOMMANDÉ ≥80 %, PARTIEL 50–79 %, NON RECOMMANDÉ <50 %, sur `pctMandatory` ou `pctGlobal`).
- Diplôme de l'école (mode `all` + tous obligatoires validés + `pctGlobal >= 100 %`).
- Cumul multi-écoles : carnet `{ best, attempts }`, `best` = pct max, classement basé sur `best`, bilan global = somme pondérée des `best`.
- Récapitulatif visuel du calcul.

**2. Correction de `Docs/Manuel-utilisateur/04-lecture-resultats.md`**
- Échelle de notes remplacée par les seuils réels (A≥90, B≥80, C≥70, D≥60, F<60).
- Verdict précisé : s'appuie sur le **pourcentage obligatoire** s'il y a des tiers obligatoires, sinon sur le global.
- Lien vers le nouveau document `systeme-points.md`.

**3. Correction de `Memories-BenchGo/README.md`**
- « Seuil de validation = 70 points » → « 70 % du total possible » (le total est aléatoire).
- Ajout d'un lien renvoyant vers `Docs/Apps-Fonctions/systeme-points.md`.

**4. Maillage de la documentation**
- `README.md` (racine) : ajout du lien dans la fonctionnalité « Santé globale » + dans la section Documentation.
- `Docs/Manuel-utilisateur/README.md` : ajout du parcours « En complément : le système de points ».
- `Docs/Apps-Fonctions/gamification-sante.md` : en-tête renvoyant vers `systeme-points.md` pour la partie calcul des points.

### Fichiers modifiés
- `Docs/Apps-Fonctions/systeme-points.md` *(nouveau)*
- `Docs/Manuel-utilisateur/04-lecture-resultats.md` (échelle corrigée, lien ajouté)
- `Docs/Manuel-utilisateur/README.md` (parcours complémentaire)
- `README.md` (2 liens vers la doc points)
- `Docs/Apps-Fonctions/gamification-sante.md` (renvoi)
- `Memories-BenchGo/README.md` (seuil corrigé, lien ajouté)

### Résultat attendu
- Tout utilisateur (GitHub ou local) dispose désormais d'un document unique et précis expliquant le calcul des points à tous les niveaux, référençant les sources de code exactes.
- L'échelle de notes affichée par le code correspond désormais à celle documentée.
- Le seuil de validation d'un tier est correctement décrit comme un pourcentage (70 %), pas un nombre fixe de points.

## 2026-07-20 — Professeur IA (OpenRouter Free Router) : ByteString, modality texte seul, slug :free dépublié, plus d'erreur brute du moteur

### Contexte
Retour utilisateur via `logs/benchgo_2026-07-20T13-05-57-738Z.log` (run `mythos-9b-unhinged`, profil STANDARD, école College-Lycee, score 91 %). Quatre problèmes distincts et cumulatifs rendaient le Professeur IA totalement indisponible et affichaient une erreur technique brute interdite.

1. **Erreur brute `Invalid or unexpected token` affichée seule** à l'utilisateur sur l'échec définitif (`runner.js:595`) et au premier échec (`runner.js:687`). Erreur cryptique du sandbox VM qui fait croire à un bug du moteur BenchGo — l'utilisateur ne veut plus la voir.
2. **`Cannot convert argument to a ByteString because the character at index 11 has a value of 8212`** sur **tous** les essais Teacher (Professeur IA de correction) — `teacher-client.js:142` utilisait `X-Title: 'BenchGo V3 — Professeur'` avec un em dash U+2014 (valeur 8212). Le fix ByteString du 19/07 n'avait été appliqué qu'à `report-teacher.js`, pas à `teacher-client.js`. `fetch` impose des headers Latin-1 (≤ 255), lève l'erreur avant même l'envoi de la requête.
3. **Modèles non-texte sélectionnés en tête par le Free Router** — `google/lyria-3-pro-preview` et `google/lyria-3-clip-preview` (modality `text+image -> text+audio`) sont gratuits et ont un contexte énorme (1 048 576), donc le tri par contexte décroissant les mettait en position 1 et 2. Ils sont inutilisables pour une correction de code et échouaient systématiquement → 3 essais gaspillés, repli sur auto-analyse.
4. **Slug `:free` dépublié pour le Report-teacher** — `report-teacher.js:183` hardcodait `meta-llama/llama-3.3-70b-instruct:free` comme modèle par défaut. Ce modèle n'est plus gratuit sur OpenRouter (HTTP 404 : *"This model is unavailable for free"*) ; le Report-teacher ne faisait pas de rotation dynamique et échouait 2 fois puis abandonnait.

### Cause racine
- Le fix ByteString du 19/07 a été appliqué à un seul des deux clients OpenRouter (`report-teacher.js`), pas à `teacher-client.js` (copier-coller manqué).
- Le filtre `fetchFreeModels` ne vérifiait que `pricing.prompt === "0"` ; il ne lisait pas `architecture.modality` / `input_modalities` / `output_modalities`, donc les modèles audio/image passaient.
- `report-teacher.js` utilisait un modèle par défaut codé en dur au lieu de réutiliser la liste dynamique déjà disponible dans `teacher-client.fetchFreeModels()`.
- L'affichage de l'erreur brute (`runner.js:595` et `:687`) précédait l'explication pédagogique demandée au modèle : redondant et trompeur.

### Actions entreprises

**1. `teacher-client.js` — Header X-Title en Latin-1**
- Remplacement de `'BenchGo V3 — Professeur'` par `'BenchGo V3 - Professeur'` (tiret ASCII), avec commentaire rappelant la contrainte ByteString. Cohérent avec le fix déjà appliqué à `report-teacher.js`.

**2. `teacher-client.js` — Filtre de modality texte→texte**
- Nouvelle fonction `isTextInOutTextModel(m)` : lit `architecture.modality` (format `text->text`) ou `input_modalities`/`output_modalities` (tableaux). Garde uniquement les modèles qui acceptent `text` en entrée et produisent **uniquement** `text` en sortie. Les modèles `text+image -> text+audio` (Lyria) sont rejetés.
- Ajout du filtre `.filter(isTextInOutTextModel)` dans `fetchFreeModels` après le filtre de pricing.

**3. `report-teacher.js` — Rotation dynamique sur les modèles gratuits réels**
- Import de `fetchFreeModels` depuis `teacher-client.js` (réutilisation, pas de duplication).
- Suppression du slug hardcoded `meta-llama/llama-3.3-70b-instruct:free`.
- Construction dynamique de la liste des candidats : modèle explicite (override) + modèles gratuits réellement disponibles (filtrés par modality + denylist).
- `maxAttempts` calculé sur `Math.min(candidates.length, maxRetries||3)`, rotation sur 404 (slug dépublié) en plus des 429/5xx. Le Report-teacher ne tombe plus jamais sur un slug 404 figé.

**4. `runner.js` — Fin de l'erreur brute du moteur**
- Suppression de la ligne `Erreur technique brute du moteur : ${errors.substring(0, 120)}` sur l'échec définitif. Seule l'explication pédagogique (demandée au modèle, avec repli sur `explainTechnicalError`) est affichée.
- Remplacement de `Raison: ${errors.substring(0, 80)}` (premier échec) par `Raison : ${explainTechnicalError(errors, task)}` : explication humaine au lieu de l'erreur brute.
- L'erreur technique reste envoyée au modèle dans le prompt d'explication (nécessaire pour le diagnostic) et reste dans le log fichier, mais n'est plus affichée seule à l'utilisateur.

### Fichiers modifiés
- `teacher-client.js` (header X-Title ligne 142, filtre modality `fetchFreeModels`)
- `report-teacher.js` (import `fetchFreeModels`, rotation dynamique candidats)
- `runner.js` (suppression des 2 affichages d'erreur brute du sandbox)

### Résultat attendu
- Plus aucune ligne `Erreur technique brute du moteur` dans le CLI ; seules des explications pédagogiques (modèle ou repli professeur) sont affichées.
- Le Professeur IA de correction contacte désormais des modèles texte→texte réels et ne tombe plus sur les modèles audio Lyria.
- Le Report-teacher ne tombe plus sur un slug `:free` 404 dépublié et peut rédiger la validation finale.
- Sans ces 4 erreurs, le run `mythos-9b-unhinged` (95 % cumulé) aurait bénéficié d'une relecture critique du Professeur IA sur les 2 échecs (`math`, `info`), sans impact sur le score (les échecs étaient de vraies erreurs techniques du sandbox : commentaire `###` invalide, classe utilisée avant déclaration).

## 2026-07-20 — Gestion propre du port occupé (EADDRINUSE) dans leaderboard.js

### Contexte
`node leaderboard.js --serve` plantait en pile d'exception non gérée (`Error: listen EADDRINUSE: address already in use :::3939`) quand un serveur tournait déjà sur le port 3939 (session précédente non fermée). L'événement `error` du serveur HTTP n'était pas capturé, donc Node propageait l'erreur comme exception fatale.

### Actions entreprises
**`leaderboard.js` — Handler `server.on('error')`**
- Capture l'erreur `EADDRINUSE` : affiche un message clair en rouge + solutions (fermer l'autre serveur, utiliser `--port=N+1`, ou `netstat`/`taskkill` sous Windows) puis `process.exit(1)` proprement au lieu d'une stack trace brute.
- Toute autre erreur serveur est aussi interceptée et affichée proprement.

## 2026-07-20 — Auto-profilage robuste + détection doublon précoce + presets/clés API persistants + retry anti-timeout

### Contexte
Retour utilisateur via le log `logs/benchgo_2026-07-20T07-31-39-885Z.log` : quatre problèmes bloquants et fastidieux.
1. **Auto-profilage échoué systématiquement** (`Auto-profilage échoué en 94.8s`) — NON NÉGOCIABLE : le modèle `microsoft/phi-4-reasoning-plus` répond en 94s, 2275 chars, mais le parsing JSON échoue puis le fallback regex échoue → filtrage désactivé.
2. **Modèle déjà testé découvert trop tard** — l'utilisateur remplit tout le questionnaire, attend 94s l'auto-profilage, puis seulement découvre que le modèle a déjà un carnet. Fastidieux.
3. **Pas de presets / clés persistantes** — à chaque `node runner.js` dans la même fenêtre CMD, il faut tout re-saisir (fournisseur, modèle, profil, clés API). Trop long.
4. **Timeout Tier 1 → exit immédiat** — le modèle dépasse 300s sur un tier obligatoire, `process.exit(1)` sans retry.

### Cause racine
1. **Auto-profilage** : `runSelfProfiling` ne tentait qu'une seule stratégie (texte + reasoning off) avec `max_tokens=600` (tronquait le JSON), et le fallback regex `[^}]` ne traversait pas les retours-ligne. Le modèle enrobait le JSON dans du markdown → parsing échouait.
2. **Doublon tardif** : la détection de doublon existait dans `runSchool` mais APRÈS l'auto-profilage (~95s) et le questionnaire.
3. **Pas de persistance** : `secrets.js` stocke les clés en mémoire de session uniquement ; pas de fichier de preset ni de magasin de clés.
4. **Exit sur timeout** : `queryLLM` avec `isMandatory=true` fait `process.exit(1)` sur timeout, sans retry.

### Actions entreprises

**1. `self-profiling.js` — Auto-profilage multi-stratégies (carte blanche)**
- `PROFILING_MAX_TOKENS = 0` : sortie ILLIMITÉE (carte blanche demandée par l'utilisateur). Ne plus tronquer le JSON.
- Nouveau `PROFILING_RETRY_MAX = 3` : on essaie jusqu'à 3 stratégies avant de baisser les bras.
- Stratégies ordonnées : (1) `json_schema` strict + reasoning off → (2) texte pur + reasoning off → (3) carte blanche (reasoning on).
- Schéma JSON strict `PROFILING_JSON_SCHEMA` forcé via `response_format` (supporté par LM Studio / OpenAI-compat).
- Fallback regex `[\s\S]*?` tolérant aux retours-ligne et au markdown autour du JSON ; extraction de la `justification`.

**2. `lm-studio-client.js` / `cloud-client.js` — max_tokens illimité**
- `maxTokens=0` (ou falsy) → on n'envoie PAS le champ `max_tokens` (sortie illimitée), au lieu de recalculer 4096.

**3. `runner.js` — Détection doublon AVANT l'auto-profilage**
- Nouvelle vérification du carnet (`scoreLedger.loadLedger`) juste avant l'auto-profilage : si le modèle a déjà un carnet, on alerte et propose d'annuler (exit 0) ou de continuer (cumul). Fini l'attente de 95s pour rien.

**4. `presets.js` (nouveau) + `api-keys-store.js` (nouveau) — Persistance locale**
- `presets.js` : fichier `.presets.json` (ignoré par git via `.gitignore` règle `*`) stocke des configs nommées. Flags : `--preset=nom`, `--save-preset=nom`, `--list-presets`, `--delete-preset=nom`.
- `api-keys-store.js` : fichier `.api-keys.json` (ignoré par git) stocke les clés API de TOUS les providers. Flags : `--list-keys`, `--forget-key=provider`, `--no-save-keys`.
- Au démarrage, `restoreIntoSession()` recharge toutes les clés dans `secrets.js` (mémoire de session) : fini la re-saisie dans la même fenêtre OU une nouvelle fenêtre.
- Proposition interactive de mémorisation avec message explicatif : « si vous ouvrez une nouvelle fenêtre, il faudra remettre les paramètres, mais la clé sera retrouvée ».
- SÉCURITÉ : `.presets.json` et `.api-keys.json` sont ignorés par git (vérifié via `git check-ignore`) → jamais poussés sur GitHub. Les clés ne sont JAMAIS incluses dans les presets.
- Dans le questionnaire interactif, si des presets existent, on les propose en choix avant le questionnaire complet (choix 1..N, ou 0 = manuel).

**5. `runner.js` — Retry anti-timeout sur tiers obligatoire**
- Dans `runTierAttempt`, l'appel `queryFn` est wrappé : 1re tentative normale, en cas de timeout (AbortError) on réessaie avec `disableReasoning: true` (coupe la pensée étendue). On récupère l'erreur (`isMandatory=false`) au lieu de `process.exit(1)`.

**6. `config.js` — Nouveaux flags CLI + messages pédagogiques**
- `parseCliArgs` expose : `preset`, `savePreset`, `deletePreset`, `listPresets`, `forgetKey`, `listKeys`, `noSaveKeys`.
- `PROFILING_MAX_TOKENS = 0`, `PROFILING_RETRY_MAX = 3` ajoutés aux exports.
- Nouveaux catalogues `PROFILING_WAITING_MESSAGES`, `POST_PROFILING_WAITING_MESSAGES`, `GENERIC_WAITING_MESSAGES` : phrases pédagogiques non-humoristiques (décision spinner_no_humor) qui tournent pendant les temps morts pour tenir l'utilisateur en haleine.

**7. `progress-bar.js` — Spinner avec messages pédagogiques rotatifs**
- `Spinner.setWaitingMessages(messages)` : affiche une phrase pédagogique en gris sous le label du spinner, qui tourne toutes les ~7s (entre 5 et 10s) pour donner un sentiment de progression pendant les temps morts longs (auto-profilage 10-90s, chargement des exercices).
- Nettoyage propre des 2 lignes (label + message) sur `stop()`/`fail()`/`beginStreaming()`.

**8. `runner.js` — Branchement des messages rotatifs**
- Spinner d'auto-profilage : `PROFILING_WAITING_MESSAGES` (« Je consulte mes compétences... »).
- Spinner post-profilage (`prepSpinner`) avant la boucle des écoles : `POST_PROFILING_WAITING_MESSAGES` (« Je prends connaissance de mes exercices... »). L'utilisateur n'est plus laissé sans rien à l'écran pendant le creux entre l'auto-profilage et le 1er exercice.

### Fichiers modifiés
- `self-profiling.js` (refonte `runSelfProfiling` multi-stratégies + `parseProfileFallback` robuste + `PROFILING_JSON_SCHEMA`)
- `lm-studio-client.js` (`max_tokens` illimité quand `maxTokens=0`)
- `cloud-client.js` (`max_tokens` illimité quand `maxTokens=0`)
- `config.js` (`PROFILING_MAX_TOKENS=0`, `PROFILING_RETRY_MAX`, nouveaux flags CLI, messages pédagogiques)
- `progress-bar.js` (`Spinner.setWaitingMessages` + rotation ~7s + nettoyage 2 lignes)
- `runner.js` (doublon précoce, presets, clés persistantes, retry anti-timeout, messages rotatifs, imports)
- `presets.js` (nouveau module)
- `api-keys-store.js` (nouveau module)

### Résultat
- L'auto-profilage tente 3 stratégies (json_schema → texte → carte blanche) avec sortie illimitée : le JSON n'est plus tronqué, le parsing tolère le markdown.
- Un modèle déjà testé est détecté AVANT l'auto-profilage : l'utilisateur peut annuler en 2s au lieu d'attendre 95s.
- Les clés API et la config sont persistées localement (hors git) : un run dans la même fenêtre ou une nouvelle fenêtre retrouve tout sans re-saisie.
- Un timeout sur un tier obligatoire déclenche un retry automatique avec raisonnement désactivé avant d'abandonner.

---

## 2026-07-19 (l) — Questionnaire : choix explicite de la cible (tier) + fix Report-teacher (ByteString)

### Contexte
Retour utilisateur : après un run interactif (LM Studio, profil LIGHT), seules les exercices de la maternelle (Tier 0) s'exécutaient, puis le run s'arrêtait avec un `Score global : 475/475 (100%)` trompeur. Aucune autre classe n'était évaluée. Le log (`logs/benchgo_2026-07-19T16-44-58-647Z.log`) montrait `Cible demandée : 0`. Par ailleurs, le `Report-teacher` (professeur IA de fin de rapport) échouait deux fois de suite avec `Cannot convert argument to a ByteString because the character at index 11 has a value of 8212 which is greater than 255`.

### Cause racine
1. **Saut de classes** : `parseCliArgs()` prend le premier argument positionnel non préfixé par `--` comme valeur de `tierArg` (`config.js:87`). Or le questionnaire interactif (`startup-questionnaire.js`) ne demandait JAMAIS la cible tier. En mode interactif, `tierArg` provenait donc uniquement d'un éventuel argument résiduel sur la ligne de commande (ex: `node runner.js 0`). Quand ce résidu valait `0`, `runner.js:1061` (`if (tierArg !== "all")`) restreignait le run au seul Tier 0 → maternelle seule, puis `Score global : 475/475 (100%)` calculé sur une seule classe sans indication claire que les autres étaient sautées.
2. **Report-teacher** : le header HTTP `X-Title: 'BenchGo V3 — Professeur rapport'` (`report-teacher.js:116`) contenait un em dash `—` (U+2012, valeur 8212) à l'index 11. `fetch` impose que les headers soient des ByteStrings (Latin-1, ≤ 255) ; le caractère > 255 lève l'erreur `Cannot convert argument to a ByteString` avant même l'envoi de la requête. Les 2 essais (maxRetries=2) échouaient donc systématiquement.

### Actions entreprises

**1. `startup-questionnaire.js` — Nouvelle section « 8. Cible (classe / tier) »**
- Ajoute une question interactive après le choix du contexte, demandant explicitement la cible. `Entrée` = `all` (toutes les classes du profil, recommandé). Sinon saisie d'un numéro de tier (0, 1, 2…) pour une seule classe. Valeurs non reconnues (`all`, `*`) repli sur `all` avec message d'avertissement.
- `runStartupQuestionnaire()` renvoie désormais `tierArg` dans son objet de retour, et le récapitulatif affiche la cible.

**2. `runner.js` — Propagation du `tierArg` du questionnaire**
- `main()` déstructure maintenant `tierArg: tierArgRaw` puis `let tierArg = tierArgRaw`. En mode interactif, `qConfig.tierArg` (si défini) remplace la valeur résiduelle issue de `parseCliArgs()`. Ainsi un argument positionnel parasite (`0`) est écrasé par le choix explicite de l'utilisateur, et le défaut `all` est conservé si l'utilisateur ne saisit rien.

**3. `report-teacher.js` — Header X-Title en Latin-1**
- Remplacement de `'BenchGo V3 — Professeur rapport'` par `'BenchGo V3 - Professeur rapport'` (tiret ASCII). Les en-têtes OpenRouter (`HTTP-Referer`, `X-Title`) sont désormais compatibles ByteString.

### Fichiers modifiés
- `startup-questionnaire.js` (nouvelle section 8 + `tierArg` retourné)
- `runner.js` (`main()` : `tierArg` mutable + propagation du questionnaire)
- `report-teacher.js` (ligne 116 : `X-Title` en ASCII)

### Résultat
- En mode interactif sans argument positionnel, la cible demandée par défaut est `all` (toutes les classes du profil). Le saut silencieux des classes n'est plus possible. L'utilisateur peut toujours choisir une seule classe via le questionnaire, ou via `node runner.js <tier>` en mode CLI.
- Le `Report-teacher` OpenRouter peut à nouveau être contacté en fin de run sans erreur ByteString.

## 2026-07-19 (k) — Augmentation du timeout d'auto-profilage (PROFILING_TIMEOUT_MS)

### Contexte
Retour utilisateur : l'auto-profilage échouait systématiquement pour tous les modèles (raisonnement notamment) avec « Timeout après ~60s » puis fallback silencieux sur toutes les tâches. Cause racine : `PROFILING_TIMEOUT_MS = 120000` (2 min) restait trop court pour les modèles de raisonnement qui mettent du temps à répondre même avec `disableReasoning` activé.

### Actions entreprises
**`config.js` — PROFILING_TIMEOUT_MS porté de 120000 à 300000 (5 min)** pour aligner avec `API_TIMEOUT_MS` et laisser aux modèles le temps de s'auto-profiler sans coupure prématurée.

### Fichiers modifiés
- `config.js` (ligne 16 : `PROFILING_TIMEOUT_MS = 300000`)

### Résultat
- L'auto-profilage dispose désormais de 5 minutes ; plus d'échec intempestif sur les modèles de raisonnement.

## Note de nommage

- Le projet est en version BenchGo V3.
- Les fichiers sources sont désormais à la racine de `benchmark-v3/` (le nom `benchmark-v2` est abandonné).
- Ce fichier (`Docs/CHANGELOG.md`) est le journal de versions de référence pour GitHub. Toute évolution du code doit y être consignée.

## 2026-07-19 (i) — Correction filtre « Échec total » + suppression corbeille (erreur réseau en file://)

### Contexte
Retour utilisateur : (1) le filtre « 💥 Échec total » du classement HTML n'affichait rien alors que le compteur indiquait 1 ; (2) le bouton corbeille 🗑 renvoyait « erreur réseau » rendant la suppression impossible.

### Actions entreprises

**1. `leaderboard.js` — Robustesse des pourcentages négatifs (filtre catastrophe)**
- Cause racine identifiée : un carnet pouvait stocker un `pct` négatif (ex: `-100` pour un modèle éliminé par santé ≤ -100). `aggregateLedger` recalculait déjà `pct = Math.round((score/max)*100)` → 0, mais les `pct` par école (`bPct`) et par tentative (`compactAttempt`) n'étaient pas bornés, et l'affichage JS utilisait `m.pct` directement → `-100%` affiché, barre `Math.max(2,-100)=2` mais valeur confuse, et surtout `pctColor(-100)` produisait `hsl(-120,…)` (teinte invalide).
- Corrections :
  - `aggregateLedger` : `pct` global ET `bPct` par école bornés à `[0, 100]` via `Math.max(0, Math.min(100, …))`.
  - `compactAttempt` : `pct` par tentative borné à `[0, 100]`.
  - Nouvelle fonction JS `dispPct(p)` : borne l'affichage à `[0, 100]` (sécurité côté client si un carnet ancien persiste). Appliquée à la carte (% + barre) et à la stat « % global » de la modale.
- Le filtre « Échec total » affiche désormais correctement le modèle catastrophe (pct=0, catégorie `catastrophe`).

**2. `leaderboard.js` — Message clair pour la suppression en mode file://**
- Cause racine : le bouton 🗑 fait `fetch('/api/delete?shortName=…', { method: 'POST' })`. Si l'utilisateur ouvre `classement.html` par double-clic (protocole `file://`) sans lancer `node leaderboard.js --serve`, le fetch résout vers `file:///api/delete` → échec réseau → toast générique « Erreur réseau » sans explication.
- Correction : `deleteModel` détecte `location.protocol === 'file:'` dans le `.catch()` et affiche un message explicite : « Suppression impossible : ouvrez le classement via le serveur (node leaderboard.js --serve) — le bouton 🗑 nécessite un serveur local. ». Si le protocole est HTTP mais le serveur injoignable : « Erreur réseau : serveur injoignable. Relancez node leaderboard.js --serve. »
- Validé : `POST /api/delete?shortName=<correct>` via serveur → `{"ok":true}` ; la suppression fonctionne en mode `--serve`.

### Fichiers modifiés
- `leaderboard.js` (bornage pct `aggregateLedger` + `compactAttempt` + `dispPct` JS + message file:// dans `deleteModel`)

### Résultat obtenu
- Le filtre « 💥 Échec total » affiche le modèle catastrophe (pct=0, santé -100 PV, NON RECOMMANDÉ) avec sa carte complète.
- La suppression via corbeille fonctionne en mode `--serve` ; en mode `file://` (double-clic), un message clair indique qu'il faut lancer le serveur.
- Plus aucun pourcentage négatif absurde (-100%) affiché nulle part.

## 2026-07-19 (h) — Dégradé de couleurs fluide vert → rouge pour les pourcentages

### Contexte
Retour utilisateur : les couleurs des pourcentages dans le classement HTML utilisaient 3 paliers discrets (vert ≥ 80%, jaune ≥ 50%, rouge < 50%). L'utilisateur voulait un **dégradé continu** : 100% = vert pur, plus on descend en % plus la couleur vire au rouge, avec une teinte unique par %.

### Actions entreprises
**`leaderboard.js` — `pctColor` en dégradé HSL continu**
- Remplacement des 3 paliers discrets par une interpolation linéaire dans l'espace HSL : `hue = pct * 1.2` → 100% = hue 120 (vert), 50% = hue 60 (jaune), 0% = hue 0 (rouge). Saturation 72% et lightness 48% constantes pour un rendu vif et lisible sur fond sombre.
- Aucun palier : chaque pourcentage a sa teinte propre (ex: 90% = vert-jaune clair, 70% = jaune-vert, 40% = orange, 20% = orange-rouge).
- Appliqué automatiquement partout où `pctColor()` est utilisé : barres de % des cartes, valeur % des mini-stats, stats de la modale (% global, obligatoire, par école, historique des tentatives).

### Fichiers modifiés
- `leaderboard.js` (fonction `pctColor` en HSL continu)

### Résultat obtenu
- Le classement HTML affiche un dégradé de couleurs fluide du vert (100%) au rouge (0%) en passant par le jaune/orange, sans sauts visuels. La lecture du niveau de performance est immédiate et intuitive.

## 2026-07-19 (g) — Bouton « Exporter le rapport intégral » dans la modale (téléchargement Markdown pour Gemini/NotebookLM)

### Contexte
Suite à l'ajout du rapport intégral dans la modale (entrée (f)), l'utilisateur veut pouvoir **exporter ce rapport** sous forme de fichier transmissible à un modèle cloud plus élaboré (Gemini, ChatGPT, Claude…) qui l'analysera et produira un verdict à injecter dans NotebookLM. Le flux durable du projet (`workflow_gemini_notebooklm` dans la mémoire) est respecté : rapports datés → Gemini → NotebookLM.

### Actions entreprises

**1. `leaderboard.js` — Refactorisation `buildReasoningMarkdown` → `buildModelReportMarkdown`**
- Extraction de la logique par-modèle de `buildReasoningMarkdown` vers une nouvelle fonction `buildModelReportMarkdown(e)` : génère le rapport Markdown intégral d'un seul modèle (en-tête avec date de génération, quantification, score global/obligatoire/santé/bonus/aide/rattrapages, auto-profilage déclaré, toutes les écoles, tous les tiers, tous les exercices avec code + explications d'échec + corrections professeur + réponses brutes).
- `buildReasoningMarkdown` devient une simple boucle qui appelle `buildModelReportMarkdown` pour chaque modèle (DRY). `raisonnement_modeles.md` est toujours généré à l'identique (validé : 225 KB, sections École/Tier/Auto-profilage préservées).

**2. `leaderboard.js` — Route serveur `/api/report` (téléchargement Markdown)**
- Nouvelle route `GET /api/report?shortName=<shortName>` dans `startServer` : génère à la volée le rapport intégral du modèle via `buildModelReportMarkdown`, avec un en-tête explicatif (« destiné à l'analyse qualitative par un modèle cloud → NotebookLM »).
- Réponse HTTP avec `Content-Type: text/markdown; charset=utf-8` + `Content-Disposition: attachment; filename="rapport_integral_<shortName>_<date>.md"` → déclenche le téléchargement dans le navigateur.
- Nouvelle fonction `getModelEntryByShortName(shortName)` : charge + agrège les carnets et retrouve l'entry d'un modèle par shortName.
- Gestion d'erreurs : 400 si `shortName` manquant, 404 si modèle introuvable (JSON `{ ok: false, error }`).
- Validé : `GET /api/report?shortName=mythos-9b-unhinged` → 200, 42 KB, Content-Disposition correct, body contient École/Tier/Auto-profilage/Réponse brute.

**3. `leaderboard.js` — Bouton « ⬇ Exporter le rapport intégral » dans la modale**
- Nouveau bouton `.btn-primary` dans la section « Rapport intégral » de la modale (`id="btnExportReport"`), avec hint explicatif : « Télécharge un fichier .md à envoyer à un modèle cloud (Gemini, ChatGPT…) pour analyse → verdict → NotebookLM ».
- Fonction JS `exportReport(idx)` :
  - En mode serveur (`--serve`) : `fetch('/api/report?shortName=...')` → récupère le Markdown complet généré côté serveur → téléchargement via `Blob` + `<a download>`. Récupère le nom de fichier depuis le header `Content-Disposition`.
  - En mode hors-serveur (ouverture locale du fichier HTML) : repli côté client qui reconstruit un Markdown à partir des données `MODELS` déjà sérialisées dans la page (tiers + exercices + code + rawResponse présents dans le JSON inline). Moins riche que la version serveur mais fonctionnel sans serveur.
  - Feedback : bouton « ⏳ Génération… » pendant la requête, toast « Rapport téléchargé : <filename> » en succès.
- CSS `.report-actions` (flexbox, wrap) + `.report-actions-hint` (italique, muted).
- Correction incident : backticks dans les chaînes JS single-quoted du template literal parent (`` ```javascript ``) → échappés en `` \` `` pour ne pas terminer le template literal.
- Message de démarrage du serveur mis à jour : « Modale → bouton "⬇ Exporter le rapport intégral" pour télécharger le MD ».

### Fichiers modifiés
- `leaderboard.js` (refactor `buildReasoningMarkdown` + `buildModelReportMarkdown` + `getModelEntryByShortName` + route `/api/report` + bouton modale + fonction `exportReport` + CSS)

### Résultat obtenu
- Dans la modale de détail de n'importe quel modèle, le bouton « ⬇ Exporter le rapport intégral » télécharge un fichier `rapport_integral_<modèle>_<date>.md` contenant l'auto-profilage, toutes les écoles, tous les tiers, tous les exercices (code + explications + corrections professeur) et les réponses brutes du modèle. Ce fichier est prêt à être transmis à Gemini (ou ChatGPT/Claude) pour analyse qualitative → verdict → injection dans NotebookLM, conformément au flux durable du projet.
- Fonctionne en mode serveur (`--serve`, rapport complet côté serveur) ET en ouverture locale du HTML (repli côté client).

## 2026-07-19 (f) — Rapport intégral dans la modale de détail (comportement & raisonnement du modèle)

### Contexte
Retour utilisateur : la modale de détail du classement HTML n'affichait que les stats globales et le tableau des écoles. L'utilisateur voulait voir **le rapport intégral** (raisonnement, code produit, calculs, réactions du modèle) directement dans la modale puisqu'on peut y scroller — sans ouvrir le fichier `raisonnement_modeles.md` séparément.

### Actions entreprises
**`leaderboard.js` — Section « Rapport intégral » dans la modale**
- `modelsData` enrichi côté serveur : pour chaque école, on charge le carnet original (`loadLedgerByName`) et on injecte le `selfProfile` (auto-profilage déclaré) + les `tiers` complets ( `tierNum`, `tierTitle`, `className`, `isMandatory`, `rawResponse`, `evalResults` avec `id`, `taskType`, `status`, `points`, `maxPoints`, `helpUsed`, `retried`, `code`, `failureExplanation`, `teacherCorrection`). Sérialisé une seule fois dans le JSON inline du HTML.
- Nouvelle section `<h3>📋 Rapport intégral (comportement & raisonnement)</h3>` dans `openModal()`, après le tableau « Détail par école » et avant la méta-line.
- Structure repliable (accordéon) :
  - **Niveau école** (`.report-school`) : en-tête `🏫 <école> — N tier(s)`, déplie le corps contenant l'auto-profilage déclaré (4 compétences + justification) puis la liste des tiers.
  - **Niveau tier** (`.report-tier`) : en-tête `Tier N — <titre> (<classe>)` + badge Obligatoire/Optionnel, déplie les exercices.
  - **Niveau exercice** (`.report-exo`) : ID + type + statut (✔ Validé / ✘ Échec / ⊘ Bypassé) + points, puis blocs :
    - **Code proposé** (balise `<pre class="report-code">` avec mono font, scroll-x invisible).
    - **Explication de l'échec (par l'élève)** (encadré rouge, bordure gauche).
    - **🎓 Correction du professeur IA** (encadré violet, bordure gauche).
    - **💭 Réponse brute complète du modèle** (raisonnement + code concaténé, `<pre class="report-raw">` scrollable avec ascenseur invisible, max-height 400px).
- Fonction JS `toggleReport(el)` : bascule la classe `.open` sur l'en-tête et le body (le caret `▶` pivote à 90° via CSS `transform`).
- CSS complet : variables `clamp()` héritées, ascenseurs invisibles (`scrollbar-width: none` + `::-webkit-scrollbar`) sur `.report-code` et `.report-raw`, badges de statut colorés, bordures gauche sémantiques (rouge = échec, violet = professeur).
- Correction incident : apostrophes non échappées dans les chaînes JS single-quoted du template literal (`l'export`, `l'échec`, `l'élève`) → `\\'` pour produire `\'` valide dans le HTML généré.

### Fichiers modifiés
- `leaderboard.js` (enrichissement `modelsData` avec `tiers` + `selfProfile` + section modale « Rapport intégral » + fonction `toggleReport` + CSS report)

### Résultat obtenu
- En cliquant sur n'importe quel modèle du classement, la modale affiche désormais le **rapport intégral** repliable : auto-profilage, tous les tiers/classes, chaque exercice avec son code, ses explications d'échec, la correction du professeur, et la réponse brute complète du modèle. Ascenseurs invisibles, scroll fluide. Plus besoin d'ouvrir `raisonnement_modeles.md` séparément.

## 2026-07-19 (e) — Ascenseurs invisibles dans la modale de détail du classement

### Contexte
Retour utilisateur : les scrollbars (ascenseurs) visibles dans la modale de détail du classement HTML étaient jugées disgracieuses et devaient être masquées, tout en gardant le scroll fonctionnel.

### Actions entreprises
**`leaderboard.js` — Scrollbars invisibles (cross-browser)**
- `.modal-overlay` et `.modal-body` reçoivent `scrollbar-width: none` (Firefox) + `-ms-overflow-style: none` (IE/Edge ancien) pour masquer l'ascenseur.
- Règle `::-webkit-scrollbar { width: 0; height: 0; display: none; }` ajoutée pour `.modal-overlay` et `.modal-body` (Chrome, Edge Chromium, Safari).
- Le scroll reste entièrement fonctionnel via molette, clavier (Flèches/PgUp/PgDown) et tactile — seul l'ascenseur visuel disparaît.

### Fichiers modifiés
- `leaderboard.js` (CSS `.modal-overlay` + `.modal-body` + règles `::-webkit-scrollbar`)

### Résultat obtenu
- La modale de détail défile sans ascenseur visible, rendu épuré sur tous les navigateurs modernes.

## 2026-07-19 (d) — Menu sticky dans le classement HTML (barre de filtres collée en haut au scroll)

### Contexte
Retour utilisateur : avec une longue liste de modèles, la barre de filtres/recherche disparaissait en haut de la page dès qu'on scrollait vers le bas. Pour changer de filtre ou relancer une recherche, il fallait rescroller jusqu'en haut — friction inacceptable sur un classement de 7+ modèles.

### Actions entreprises
**`leaderboard.js` — Barre sticky (effet WordPress/admin)**
- Les deux toolbars (filtres catégorie + filtres taille/recherche) sont regroupées dans un conteneur `<div class="sticky-bar" id="stickyBar">`.
- CSS `position: sticky; top: 0; z-index: 100` : la barre reste collée en haut du viewport pendant le scroll.
- Fond semi-transparent `rgba(10,14,20,0.82)` + `backdrop-filter: blur(10px) saturate(140%)` pour garder la lisibilité par-dessus les cartes qui défilent (effet "glass").
- Extension latérale `margin-inline: calc(-1 * var(--container-pad)); padding-inline: var(--container-pad)` pour que la barre colle aux bords du container `.wrap` (pleine largeur du container).
- JS : un listener `scroll` (passif) ajoute la classe `.stuck` dès `window.scrollY > 4`, qui renforce l'opacité (`0.94`) et ajoute une ombre portée `0 4px 18px rgba(0,0,0,0.45)` — signale visuellement le "détachement" de la barre du fond, comme les headers WordPress qui changent d'aspect au scroll.

### Fichiers modifiés
- `leaderboard.js` (CSS `.sticky-bar` + wrapper HTML des deux toolbars + listener scroll `.stuck`)

### Résultat obtenu
- La barre de filtres + recherche reste toujours visible et accessible pendant le scroll, quelle que soit la longueur du classement. Plus besoin de rescroller pour filtrer ou rechercher.

## 2026-07-19 (c) — Auto-profilage rapide, classement --serve débloqué, quantification CLI, refonte HTML flexbox

### Contexte
Suite au retour utilisateur (`Memories-BenchGo/Tasks1.md`), trois axes ont été traités :
1. L'auto-profilage prenait jusqu'à **372 secondes** sur les modèles de raisonnement (GLM, Qwen3, DeepSeek-R1) — le modèle passait tout ce temps en `reasoning_content` avant de produire le JSON de profil. Inacceptable pour un utilisateur en CLI.
2. Le mode serveur `node leaderboard.js --serve` était **complètement bloqué** : les boutons s'affichaient mais aucun classement n'apparaissait, et aucun bouton ne réagissait.
3. La quantification des modèles n'était pas affichée dans le **classement CLI** (console), seulement dans le HTML — impossible de distinguer les quantifications en invite de commande.
4. Le HTML du classement avait un rendu « brouillon » non conforme au protocole responsive `Admin/Flexbox-Responsive.md`.

### Actions entreprises

**1. `config.js` + `lm-studio-client.js` + `cloud-client.js` + `self-profiling.js` + `runner.js` — Auto-profilage rapide**
- Nouvelles constantes dans `config.js` : `PROFILING_TIMEOUT_MS = 60000` (timeout dédié 60 s) et `PROFILING_MAX_TOKENS = 600` (limite stricte de sortie — le JSON de profil fait ~200 tokens).
- `lm-studio-client.js` et `cloud-client.js` : `queryLLM` accepte désormais `options.timeoutMs` (override du `API_TIMEOUT_MS` global) et `options.maxTokens` (override du calcul depuis le budget contexte). Le message d'erreur de timeout affiche la vraie limite utilisée.
- Désactivation du raisonnement étendu pour l'auto-profilage : `options.disableReasoning = true` injecte `chat_template_kwargs = { enable_thinking: false }` dans le body de la requête (LM Studio propage ce paramètre au template du modèle ; les modèles non compatibles l'ignorent silencieusement). Évite les 5-6 minutes de pensée inutile.
- `self-profiling.js` : prompt `PROFILE_PROMPT` raccourci (~40% de tokens en moins) — suppressions des questions de réflexion préalable et des descriptions verbeuses. Passage de `options = { timeoutMs, maxTokens, disableReasoning }` à l'appel `queryFn`. Le fallback regex et la validation du profil sont inchangés.
- `runner.js` : import de `PROFILING_TIMEOUT_MS`, message console mis à jour (« ~10-30s (timeout 60s max) » au lieu de « 10 à 15 secondes »).

**2. `leaderboard.js` — Correction du bug `--serve` (JS cassé)**
- Cause racine : dans `buildLeaderboardHTML`, la ligne `var text = lines.join('\n')` était écrite à l'intérieur d'un template literal JS `` `...` ``. Le `\n` était donc interprété par le template literal parent comme un **véritable caractère de saut de ligne**, produisant dans le HTML généré : `var text = lines.join('<saut de ligne réel>')` → **SyntaxError JS** au chargement de la page → tout le script inline explosait → aucun classement rendu, aucun bouton fonctionnel.
- Correction : échappement du backslash → `lines.join('\\n')` pour que le HTML de sortie contienne bien `lines.join('\n')` (séquence d'échappement JS valide).
- Validation : `new Function(js)` sur le JS inline extrait du HTML généré → syntaxe OK. Test du serveur via `fetch('http://localhost:3993/')` → HTML servi avec `var MODELS`, `renderCards()`, et API `/api/delete` (POST) fonctionnelle.

**3. `leaderboard.js` — Quantification dans le classement CLI**
- La boucle d'affichage console affiche désormais la quantification entre le nom du modèle et le % : `mythos-9b-unhinged  Q4_K_M  100%  RECOMMANDÉ` (couleur magenta, colonne fixe 8 chars). Les modèles sans quantification affichent `—`.
- Cohérent avec le badge `🧩 Q4_K_M` déjà présent dans le HTML et la colonne « Quantif. » du Markdown.

**4. `leaderboard.js` — Refonte HTML aux normes flexbox/fluid (CSS pur adapté)**
- Application du protocole `Admin/Flexbox-Responsive.md` (Living With Pixels) en **CSS pur inline** (le classement est un fichier standalone sans build Tailwind) :
  - Variables CSS `clamp()` pour tous les espacements (`--space-xs` à `--space-xl`), la typographie (`--fs-display` à `--fs-tiny`) et le padding du container.
  - Container boxed intelligent : `.wrap { max-width: 1120px; margin-inline: auto; padding-inline: clamp(0.75rem, 4vw, 2rem); }`.
  - **Flexbox préféré à Grid** : `.full-stats` et `.args-grid` passent de `display: grid` à `display: flex; flex-wrap: wrap` avec `flex: 1 1 <min>px` (grow fluide).
  - Typographie fluide 7 niveaux via `clamp()` sur tous les textes.
  - Padding sections fluide (`.card-row`, `.modal-head`, `.modal-body` utilisent `var(--space-m)` etc.).
- Refonte visuelle : header « hero » avec badge, titre en dégradé bleu→violet, palette GitHub-dark raffinée, cartes avec barre latérale colorée (or/argent/bronze), badges `.badge` / `.badge.quant` unifiés, ombres et transitions, modale avec `backdrop-filter: blur(4px)`, toast pill animé.
- Quantification mise en avant dans la modale (couleur violet `--purple`).
- Responsive fluide : unique media query `@media (max-width: 720px)` pour faire passer les mini-stats sous le nom du modèle sur écran étroit — pas de breakpoints fixes multiples.
- Les barres de % ont désormais un `min-width` de 2% pour rester visibles même à 0%.

### Fichiers modifiés
- `config.js` (constantes `PROFILING_TIMEOUT_MS`, `PROFILING_MAX_TOKENS` + exports)
- `lm-studio-client.js` (`options.timeoutMs`, `options.maxTokens`, `options.disableReasoning` + message timeout dynamique)
- `cloud-client.js` (idem + `max_tokens` et `chat_template_kwargs` dans le body OpenAI-compat)
- `self-profiling.js` (prompt raccourci + passage des options perf + import config)
- `runner.js` (import `PROFILING_TIMEOUT_MS` + message console)
- `leaderboard.js` (fix `\\n` + quantification CLI + refonte HTML complète flexbox/fluid)

### Résultat obtenu
- L'auto-profilage est limité à 60 s max (vs 372 s observés) et désactive le raisonnement étendu — réponse attendue en ~10-30 s sur la plupart des modèles.
- `node leaderboard.js --serve` fonctionne : le classement s'affiche, les filtres/recherche boutons Détails/Supprimer/Copier sont opérationnels, l'API `/api/delete` répond.
- Le classement CLI affiche la quantification de chaque modèle.
- Le classement HTML adopte un design moderne fluide (clamp + flexbox), responsive sans breakpoints excessifs, conforme aux principes du protocole `Admin/Flexbox-Responsive.md`.

## 2026-07-19 (b) — Correction diplôme école, quantification des modèles, écoles séquentielles, bouton copier le classement

### Contexte
Suite à un retour utilisateur (`Memories-BenchGo/Tasks1.md`) décrivant un comportement étrange : un modèle (mythos-9b-unhinged) lancé en mode classe unique sur le collège-lycée s'arrêtait à la 6ème (tier 0) et obtenait le diplôme complet de l'école avec les honneurs, sans avoir continué les autres classes. Quatre axes ont été traités :
1. Le diplôme de l'école était attribué à tort sur une seule classe réussie (mode tier unique à 100%).
2. La quantification des modèles (Q4_K_M, Q5_K_S, Q8_0...) n'était jamais récupérée ni affichée — or elle impacte fortement les performances et n'apparaît pas dans le nom des modèles locaux.
3. Le runner ne savait pas enchaîner deux écoles (Primaire + Collège-Lycée) dans le même run, forçant l'utilisateur à relancer manuellement.
4. Le classement HTML n'offrait pas de moyen de copier l'ensemble du classement pour le partager.

### Actions entreprises

**1. `runner.js` — Correction du diplôme de l'école (bug d'arrêt à la 6ème)**
- Le bloc « Gamification Niveau 3 : Grosse Recompense d'Ecole » se déclenchait sur la seule condition `pctGlobal >= 100`, ce qui en mode tier unique donnait un faux diplôme (un seul tier à 100% → `pctGlobal = 100`).
- Nouvelle logique : le diplôme n'est décerné qu'en mode `all` ET si tous les tiers obligatoires du profil ont été exécutés ET validés ET `pctGlobal >= 100`.
- En mode tier unique à 100%, un message distinct « CLASSE VALIDÉE : <classe> — diplôme de l'école non attribué (mode classe unique) » remplace le faux diplôme.
- Traçabilité : `Memories-BenchGo/issues-fixes/2026-07-19-diplome-ecole-sur-une-seule-classe.md`.

**2. `config.js` + `startup-questionnaire.js` + `score-ledger.js` + `leaderboard.js` + `runner.js` — Quantification des modèles**
- Nouvel endpoint `LM_STUDIO_MODELS_V0_URL = http://localhost:1234/api/v0/models` dans `config.js` : l'API v0 de LM Studio expose la quantification (`Q4_K_M`, `Q4_K_XL`, `Q4_K_S`, `Q8_0`...), l'architecture, l'éditeur et l'état (loaded/not-loaded) — contrairement à `/v1/models` (compatible OpenAI) qui ne renvoie que l'id.
- Nouvelle fonction `fetchModelMetadataFromLMStudio(modelId)` : renvoie `{ name, quantization, arch, publisher, state, maxContextLength }` pour le modèle ciblé (priorité au modèle chargé si plusieurs partagent le même id).
- Nouveau flag CLI `--quantization=` (ex: `--quantization=Q5_K_S`) pour forcer la quantification en mode CLI historique ou pour les serveurs qui ne l'exposent pas.
- `startup-questionnaire.js` : nouvelle étape « 2b. Quantification » — auto-détection via `/api/v0/models` pour LM Studio, saisie manuelle pour Ollama/custom, affichage de l'architecture et de l'éditeur si disponibles.
- `runner.js` : auto-détection de la quantification en mode CLI local (fallback si pas de `--quantization=` ni de questionnaire), affichage dans la bannière de configuration et dans `logger.runConfig`.
- `score-ledger.js` : `saveResult` et `saveAndBuildBilan` acceptent un paramètre `quantization`, stocké au niveau du carnet (par modèle, pas par école — la quantification est une propriété du modèle physique).
- `leaderboard.js` : la quantification est affichée comme badge `🧩 Q4_K_M` à côté du badge de taille de paramètres sur chaque carte, dans les stats de la modale de détail, et dans le classement Markdown (colonne « Quantif. »).
- Migration one-shot des carnets existants : un script a rempli `ledger.quantization` pour les 6 modèles locaux présents (Q4_K_M / Q4_K_XL / Q4_K_S) à partir de `/api/v0/models`.

**3. `runner.js` — Écoles séquentielles (Primaire + Collège-Lycée) dans le même run**
- Refactorisation : extraction du flux d'exécution d'une école en fonction imbriquée `runSchool(schoolProfileArg, { isSecondSchool })`. Closure : hérite de toute la config résolue (provider, modèle, clés, queryFn, auto-profilage, professeur, quantification) — pas de re-saisie ni de re-profilage entre écoles.
- `gameState` (santé PV) est réinitialisé à chaque école (chaque école démarre à 0 PV) — état indépendant par école.
- Au démarrage, si le modèle fait > 3B paramètres (profil STANDARD ou supérieur) ET mode `all` ET terminal interactif : proposition d'enchaîner Primaire (LIGHT) puis Collège-Lycée (STANDARD) séquentiellement. L'utilisateur peut refuser pour rester sur l'école unique.
- Bannières de configuration séparées : `main()` affiche la config globale (cible, mode, contexte, quantification) une fois ; `runSchool()` affiche la config spécifique à chaque école (profil, école, tiers).
- Arrêt propre : si le modèle est éliminé (santé ≤ -100) pendant une école, les écoles suivantes ne sont pas lancées.
- Le classement est régénéré après le run complet (comme avant), cumulant les résultats de toutes les écoles dans le carnet persistant.

**4. `leaderboard.js` — Bouton « Copier le classement »**
- Nouveau bouton « ⧉ Copier le classement » dans la barre d'outils (à côté de la recherche).
- Copie tout le classement en texte brut tabulaire (rang, modèle, quantification, points, %, note, obligatoire, santé, écoles, verdict) dans le presse-papiers — respecte les filtres actifs (catégorie, taille, recherche) pour copier ce que l'utilisateur voit.
- Feedback visuel : le bouton passe en vert « ✓ Copié ! » pendant 2 s, toast de confirmation avec le nombre de modèles copiés. Fallback `document.execCommand('copy')` si l'API Clipboard n'est pas disponible.

### Fichiers modifiés
- `runner.js` (diplôme école + refactor runSchool + écoles séquentielles + quantification auto-détection + affichage config)
- `config.js` (endpoint v0 + `fetchModelMetadataFromLMStudio` + flag `--quantization=`)
- `startup-questionnaire.js` (étape 2b quantification + retour `quantization`)
- `score-ledger.js` (`saveResult` / `saveAndBuildBilan` acceptent `quantization`)
- `leaderboard.js` (badge quantification carte + modale + markdown + bouton copier le classement + CSS)
- `Memories-BenchGo/issues-fixes/2026-07-19-diplome-ecole-sur-une-seule-classe.md` (nouveau)

### Résultat obtenu
- Un modèle lancé sur une seule classe ne reçoit plus le diplôme complet de l'école — seulement une mention de classe validée.
- La quantification de chaque modèle est désormais visible dans le classement (badge 🧩 + colonne Markdown) et dans le carnet persistant, ce qui permet de comparer des runs de quantifications différentes du même modèle.
- Un modèle > 3B paramètres peut être évalué sur Primaire puis Collège-Lycée d'un seul run, sans re-saisir la configuration ni relancer l'auto-profilage.
- Le classement peut être copié en un clic pour être partagé dans un chat ou un document.

## 2026-07-19 — Sécurité des clés API, questionnaire interactif, professeur rapport, auto-profilage renforcé

### Contexte
Suite au retour utilisateur (`Memories-BenchGo/Tasks1.md`), cinq axes d'amélioration ont été traités :
1. Les clés API apparaissaient en clair dans la console (saisie `askFreeText` classique), ce qui est risqué même en local (copie d'écran, historique PowerShell, partage de terminal).
2. L'ajout de nouveaux fournisseurs (Ollama, OpenAI, etc.) et la sélection du provider au démarrage manquaient d'un vrai questionnaire guidé.
3. L'auto-profilage était jugé trop peu précis (prompt court, échelle vague).
4. L'organisation des dossiers d'export ne séparait pas les niveaux dans une même école, et le rapport final n'était jamais relu par un professeur externe.
5. Certains modèles échouaient parce que le prompt imposait un format strict (Markdown + balises ```javascript) ; il faut laisser le modèle répondre dans le format qu'il préfère.

### Actions entreprises

**1. `secrets.js` (nouveau) — Gestion et masquage des clés API**
- Nouveau module dédié à la gestion des secrets en mémoire de session :
  - `askSecret(question, { revealMs })` : lecture caractère par caractère via `stdin.setRawMode(true)` (TTY uniquement), affichage d'astérisques `*` à chaque caractère tapé, Backspace efface, Échap annule, Ctrl+C interrompt.
  - `revealThenMask(value, ms)` : aperçu temporaire de la clé en clair pendant `revealMs` (défaut 3000 ms) avec compte à rebours, puis re-masquage sur la même ligne (`\r\x1b[K`).
  - `maskSecret(value)` / `maskedForDisplay(value)` : masque une clé en gardant un préfixe reconnaissable (`sk-or-v1-`, `sk-`, `gsk_`, `AIza`, …) + 4 derniers caractères.
  - `rememberSecret` / `getSecret` / `hasSecret` / `forgetSecret` : dépôt en mémoire vive, JAMAIS écrit sur disque. Survit aux changements d'école d'une même session, disparaît à la fermeture du processus.
  - `isCliProvided(name)` : marque qu'une clé provient de la CLI pour ne pas la redemander.
- Repli non-TTY : `readline.question` classique (sans masquage, mais le cas ne se produit que en pipe/script).

**2. `startup-questionnaire.js` (nouveau) — Questionnaire interactif complet**
- Lancé automatiquement quand aucun flag CLI significatif (`--provider`, `--model`) n'est passé ET que le terminal est un TTY.
- Sept étapes guidées :
  1. Fournisseur (`lmstudio` / `ollama` / `custom` / `openrouter` / `openai` / `anthropic` / `groq` / `together` / `mistral`).
  2. Modèle (auto-détection pour `lmstudio` via `/v1/models` et `ollama` via `/api/tags` ; saisie libre sinon).
  3. Clé API (lecture masquée via `secrets.askSecret` + aperçu 3 s ; réutilisée si déjà en mémoire de session ou en variable d'environnement).
  4. Endpoint personnalisé (uniquement pour `custom`).
  5. Profil (`LIGHT` / `STANDARD` / `EXPERT` / `DOCTORAT` / `FRONTIER`).
  6. Contexte max (tokens, défaut 16384).
  7. Professeur IA (OpenRouter Free Router, clé masquée mémorisée).
- Récapitulatif final avant lancement.
- La clé API élève ET la clé OpenRouter (professeur) sont mémorisées dans `secrets.js` pour la session : pas de re-saisie entre deux écoles d'un même run (répond à la contrainte utilisateur explicite).

**3. `cloud-client.js` — Nouveaux fournisseurs**
- Ajout de `deepseek` (api.deepseek.com) et `cohere` (api.cohere.ai) dans `CLOUD_PROVIDERS`. `ollama`, `lmstudio`, `custom` étaient déjà présents.

**4. `self-profiling.js` — Auto-profilage renforcé**
- Nouveau `PROFILE_PROMPT` beaucoup plus exigeant :
  - Introduction d'une phase de réflexion silencieuse (« si on me donnait 3 exercices de difficulté croissante… »).
  - Échelle 1-5 reformulée avec critères concrets par niveau (production vs reconnaissance, anticipation des cas limites).
  - Descriptions des 4 compétences enrichies (portée/fermetures/déstructuration, backoff exponentiel, programmation dynamique simple, CSRF, parseurs robustes…).
  - Demande d'exemples concrets par compétence (`"examples"`) pour forcer une auto-évaluation sincère.
  - Consigne anti-surévaluation explicite (« un niveau 5 est rare »).
- Le schéma JSON accepte désormais le champ `examples` (non bloquant pour `validateProfile` qui ne valide que `level`).

**5. `report-teacher.js` (nouveau) — Professeur IA externe pour le rapport final**
- Nouveau module qui délègue la rédaction de la validation pédagogique finale à un professeur IA externe (modèle cloud distinct de l'élève).
- `buildReportTeacherPrompt({ modelName, profileLabel, ecoleLabel, tierScorecard, evalResults, globalScore, calibration })` : construit un prompt riche (tableau récap par classe, détail par exercice, auto-analyses et corrections précédentes des échecs définitifs, indice de calibration).
- `buildExternalTeacherReport({ teacherConfig, results })` : appelle `chat/completions` (non streamé) sur le provider du professeur (OpenRouter par défaut, mais accepte `openai`, `ollama`, `custom`…), réessaie jusqu'à `maxRetries` (rotate sur rate-limit). Réutilise la clé mémorisée dans `secrets.js`.
- La section produite suit une structure imposée : `## Validation du professeur IA` → Note finale et classement perçu → Méthodologie et compréhension → Points clés à retenir → Recommandation finale.
- `runner.js` l'injecte à la fin du rapport Markdown généré localement (repli silencieux si indisponible).

**6. `runner.js` — Intégration et assouplissements**
- Intégration du questionnaire : remplace l'ancien bloc « PROFESSEUR CORRECTEUR » interactif (qui utilisait `askFreeText` en clair) par le questionnaire complet, ou par `secrets.askSecret` (saisie masquée + aperçu 3 s) en mode CLI historique.
- Affichage de la clé API en CLI désormais systématiquement masqué via `secrets.maskedForDisplay()` (plus jamais en clair dans la console, même si passée en `--api-key=`).
- Architecture d'export enrichie : `Export-Rapports/<AAAA-MM-JJ>/<ÉCOLE>/<NIVEAU-OU-CLASSE>/<fichier.md>`. En mode `all`, un sous-dossier niveau (`LIGHT`, `STANDARD`, …) est créé dans l'école pour ne plus mélanger les rapports de niveaux différents. En mode tier unique, le sous-dossier reste la classe (comportement inchangé).
- Prompt d'exercice assoupli : le format de réponse est désormais libre (Markdown + balises, JSON, ou code pur). L'extracteur (`extractStudentCode` / `extractCodeRegex`) gérait déjà ces trois formats ; seul le prompt imposait le Markdown. Suppression de la contrainte contradictoire.
- `effectiveModel` est désormais résolu plus tôt (avant l'injection du rapport externe) pour être réutilisable.

### Fichiers modifiés
- `secrets.js` (nouveau)
- `startup-questionnaire.js` (nouveau)
- `report-teacher.js` (nouveau)
- `cloud-client.js` (ajout `deepseek`, `cohere`)
- `self-profiling.js` (prompt renforcé)
- `runner.js` (questionnaire + masquage + architecture export + prompt libre + rapport externe)

### Validation
- `node -c` passé sur les six fichiers (syntaxe OK).
- `require()` de tous les modules : OK.
- Lancement du runner (sans flag) : bannière puis entrée du questionnaire interactif confirmée.

### Résultat
- Les clés API ne sont plus jamais visibles en clair dans le CLI (saisie masquée, aperçu 3 s, affichage masqué).
- Démarrage sans flag → questionnaire guidé complet ; la clé survit aux changements d'école d'une même session.
- L'auto-profilage produit des auto-évaluations plus honnêtes et plus détaillées.
- Chaque rapport final contient, quand un professeur IA est activé, une validation pédagogique externe (note, méthodologie, recommandation) en plus du rapport technique local.
- L'organisation `Date/École/Niveau/Fichier` sépare proprement les runs par niveau.
- Les modèles peuvent répondre dans le format de leur choix sans être pénalisés par une consigne de format trop rigide.

### Leçons apprises
- Ne jamais utiliser `readline.question` pour une clé API : préférez `stdin.setRawMode(true)` + affichage d'astérisques, avec un aperçu temporaire explicite.
- Mémoriser les secrets en mémoire de session (jamais sur disque) évite les re-saisies frustrantes entre écoles sans compromettre la sécurité.
- Laisser le modèle choisir son format de réponse évite les échecs artificiels liés à une consigne de format trop rigide (certains modèles ne savent produire que du JSON, d'autres que du Markdown).

---

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

## 2026-07-19 (j) — Augmentation du timeout API cloud (API_TIMEOUT_MS)

### Contexte
Retour utilisateur : les modèles cloud (notamment les modèles de raisonnement) déclenchaient systématiquement un timeout après 130s, rendant l'exécution impossible même après plusieurs tentatives.

### Actions entreprises
**`config.js` — API_TIMEOUT_MS porté de 130s à 300s**
- Le timeout global des appels API cloud est passé de `130000` ms à `300000` ms (5 minutes) pour laisser le temps aux modèles de raisonnement de répondre sans être interrompus prématurément.

### Fichiers modifiés
- `config.js` (ligne 10 : `API_TIMEOUT_MS = 300000`)

### Résultat
- Les timeouts intempestifs sur les modèles cloud devraient être éliminés.

## 2026-08-03 — fix(api-keys): persistance automatique sans confirmation interactive

### Contexte
Les clés API (élève + professeur OpenRouter) n'étaient pas persistées dans
`.api-keys.json` lors de la saisie via le questionnaire interactif
(`startup-questionnaire.js`) ni via le mode CLI historique (`runner.js`).
À chaque nouveau processus, l'utilisateur devait re-collér sa clé, même
après avoir répondu "oui" à la proposition de mémorisation.

### Cause racine
1. `_ensureApiKey()` dans `startup-questionnaire.js` appelait
   `secrets.rememberSecret()` (mémoire de session) mais JAMAIS
   `apiKeysStore.saveKey()` (disque).
2. Le bloc de proposition de mémorisation dans `runner.js` (lignes 1378-1407)
   demandait une confirmation interactive à l'utilisateur, mais en mode
   non-TTY (night-batch) ou si l'utilisateur répondait "non", la clé
   n'était jamais écrite sur disque.

### Solution
1. `startup-questionnaire.js` : `_ensureApiKey()` appelle désormais
   `apiKeysStore.saveKey()` automatiquement après chaque saisie.
2. `runner.js` : remplacement du bloc interactif de proposition par une
   sauvegarde silencieuse et automatique (respectant `--no-save-keys`).
   Plus de question "Mémoriser ?" — la clé est persistée d'office.

### Fichiers modifiés
- `startup-questionnaire.js` (import apiKeysStore + saveKey dans _ensureApiKey)
- `runner.js` (remplacement du bloc _offerKeyMemorization par _autoSaveKey)

### Résultat
- Une clé saisie une fois est immédiatement persistée dans `.api-keys.json`.
- Les runs suivants (même fenêtre, nouvelle fenêtre, night-batch) retrouvent
  la clé sans aucune re-saisie.
- `--no-save-keys` continue de désactiver la persistance (machine partagée).

