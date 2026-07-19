# CHANGELOG - Carnet de Notes BenchGo

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
