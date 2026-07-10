# 2026-07-07 — Le test async de tache_3c (middleware Cloudflare) échouait toujours, même avec une réponse correcte

## Symptôme
Découvert en construisant l'infrastructure d'évaluation asynchrone pour les nouvelles épreuves
(Tier 2/3, async avancé). Le test `exec` existant de `tache_3c` (Tier 3, middleware Cloudflare
Worker) échouait systématiquement (`passed: false`), **même en fournissant une implémentation
100% correcte** du middleware. Un modèle produisant un code parfait perdait des points sur ce
test précis sans raison légitime — un faux négatif silencieux.

## Cause racine
Le test utilisait `type: "exec"`, qui exécute `setup + code + call + assert` en **un seul
appel synchrone** à `vm.runInContext(...)` (voir `execCodeInVM` dans `vm-sandbox.js`). Le `call`
invoquait une IIFE async : `(async () => { return await _middleware(...) })()`.

Or, appeler une fonction `async` retourne **toujours** une Promise, et cette Promise ne se résout
qu'à la prochaine passe de microtâches — après la fin de l'exécution synchrone du script complet.
Comme `__result__` (la Promise, encore *pending*) était lu immédiatement par `__passed__` dans la
même exécution synchrone, `result.status` valait `undefined`, jamais `403`. Le test ne pouvait
donc **jamais** passer, peu importe la qualité du code produit.

## Solution
Remplacement du test `exec` par un évaluateur `custom` asynchrone : `evaluateCloudflareMiddleware`
(nouveau, dans `custom-evaluators.js`). Principe : le code étudiant est défini dans un contexte VM
isolé (`vm.runInContext`) sans l'appeler directement dans ce script ; la fonction exposée est
ensuite **appelée et attendue (`await`) depuis le contexte hôte Node.js réel**, où les Promises se
résolvent normalement. Un timeout de sécurité (`Promise.race`) évite tout blocage.

Cette approche (`exposerFonctionVM` + `avecTimeout`, factorisées et réutilisées par tous les
nouveaux évaluateurs async) est désormais le pattern standard pour tester du code asynchrone dans
BenchGo — le pattern `exec` synchrone reste réservé aux fonctions purement synchrones.

## Fichiers modifiés
- `benchmark-v2/custom-evaluators.js` (ajout de `evaluateCloudflareMiddleware`, `exposerFonctionVM`,
  `avecTimeout`, `detecterNomFonction`)
- `benchmark-v2/task-evaluator.js` (`evaluateTask` devient `async`, `await evaluator(...)` pour le
  type `custom`)
- `benchmark-v2/runner.js` (`await evaluateTask(...)`)
- `benchmark-v2/tiers/tier3_expert.json` (tache_3c : eval `exec` remplacée par `custom`)

## Validation
Test manuel : `evaluateTask(tache_3c, implémentationCorrecte)` retournait `[true, true, true,
false]` avant le fix, et `[true, true, true, true]` après. Confirmé avec un script temporaire
(`node`) supprimé après vérification.

## Leçons apprises
- **Ne jamais tester du code asynchrone via `type: "exec"`** dans ce projet : l'exécution VM est
  strictement synchrone et ne laisse aucune chance aux Promises de se résoudre avant la lecture du
  résultat. Toujours utiliser un évaluateur `custom` async qui appelle/attend la fonction depuis le
  contexte hôte.
- Ce genre de bug est particulièrement sournois car il ne casse rien visiblement : il pénalise
  silencieusement TOUS les modèles sur ce test précis, faussant les scores sans jamais lever
  d'erreur explicite. À surveiller sur d'éventuels autres tests `exec` impliquant des fonctions
  `async`/Promise dans les tiers existants.
