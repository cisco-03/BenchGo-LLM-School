# 2026-07-07 — Barre de progression CLI figée pendant l'évaluation

## Symptôme
Pendant la phase d'évaluation (après réception de la réponse LLM), la barre de progression
(`ProgressBar` dans `progress-bar.js`) restait visuellement immobile puis sautait directement
à 100% au lieu d'animer en temps réel comme le Spinner (utilisé pendant la génération LLM).

## Cause racine
`evaluateTask()` (dans `task-evaluator.js`) est entièrement synchrone et très rapide (VM sandbox,
quelques millisecondes par tâche). La boucle `for (const task of tierData.tasks)` dans `runner.js`
appelait `progressBar.update()` plusieurs fois de suite sans jamais rendre la main à l'event loop.
Résultat : toutes les écritures `process.stdout.write('\r...')` s'enchaînaient dans le même tick
JS, plus vite que le terminal ne peut repeindre son buffer d'affichage (~16ms/frame). Le terminal
ne montre alors que la dernière frame écrite, donnant l'impression que la barre est figée puis
saute instantanément à la fin.

Le Spinner, lui, anime correctement car son rendu est piloté par un `setInterval` qui tourne
pendant l'attente **asynchrone** de la réponse LLM (I/O réseau réel, l'event loop est libre).

## Solution
Ajout d'un yield explicite vers l'event loop entre chaque mise à jour de la barre, via un helper
`sleep(ms)` (`setTimeout` enveloppé dans une Promise) et des `await sleep(40)` /
`await sleep(50)` intercalés dans la boucle de `runner.js`, après chaque `progressBar.update(...)`.
Cela laisse le temps au terminal de repeindre chaque frame avant l'update suivante.

Effet de bord positif : cela a aussi nécessité de rendre `evaluateTask()` async (voir
`2026-07-07-async-middleware-toujours-echec.md`), ce qui a permis d'introduire des évaluateurs
`custom` réellement asynchrones pour les nouvelles épreuves.

## Fichiers modifiés
- `benchmark-v2/runner.js` (ajout de `sleep()`, `await` intercalés dans la boucle des tâches)

## Validation
Vérification manuelle du flux (`node --check`) + relecture du timing : le surcoût ajouté est
d'environ 80ms par tâche (2 × 40ms), soit quelques centaines de ms au total par tier — négligeable
comparé au temps de génération LLM (secondes à dizaines de secondes), mais suffisant pour que le
terminal ait le temps de repeindre chaque frame de la barre.

## Leçons apprises
- Une barre de progression pilotée uniquement par des écritures synchrones rapprochées ne s'anime
  pas visuellement : il faut soit un timer (`setInterval`, comme le Spinner), soit des yields
  explicites vers l'event loop entre les updates.
- Toujours vérifier si le "consommateur" (le terminal) a le temps de rendre chaque frame avant
  d'enchaîner l'update suivante.
