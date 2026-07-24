# AGENTS.md — Conventions et règles pour les agents travaillant sur BenchGo V3

Ce fichier guide les agents IA (et les développeurs) qui interviennent sur le code de
BenchGo V3. Il consigne les conventions du projet, les pièges connus et les règles à
respecter pour ne pas reproduire les erreurs passées.

---

## 1. Environnement d'exécution

- **OS** : Windows. Shell système par défaut : PowerShell 5.1.
- **Node.js** : version 18+ requise (projet sans `package.json`, aucune dépendance npm —
  Node.js built-ins uniquement).
- **Lancement** : `node runner.js` (mode interactif) ou `node night-batch.js` (mode nuit).
- **LM Studio** : la CLI `lms` est livrée avec l'application LM Studio et doit être dans
  le PATH. Le serveur HTTP tourne sur `http://localhost:1234`.

### Outils à privilégier selon l'opération

| Opération | Outil à utiliser | Pourquoi |
|---|---|---|
| Lire un fichier | `read` | Pas de shell, pas de problème d'encodage |
| Écrire/créer un fichier | `write` ou `edit` | Pas de shell, encodage UTF-8 sans BOM garanti |
| Rechercher dans des fichiers | `grep` (outil dédié) | Pas de shell, pas de quoting |
| Lister des fichiers | `glob` (outil dédié) | Pas de shell |
| Vérifier la syntaxe JS | `bash` avec `node --check <fichier>` | Commande simple, sûre |
| Lancer `lms`, `git`, `node` | `bash` | Ces commandes n'ont pas de problème d'accent |

### Pièges PowerShell 5.1 à ÉVITER absolument

L'outil `bash` reste routé sur PowerShell 5.1 sur ce Windows (le profil VS Code Git Bash
n'affecte que le terminal intégré, pas l'outil de commande). Conséquences :

1. **NE PAS utiliser de here-strings PowerShell** (`@"..."@` ou `@'...'@`) pour écrire des
   fichiers contenant des accents ou des `${}`. PowerShell 5.1 corrompt l'encodage
   (mojibake `é` → `Ã©`, BOM UTF-8 involontaire). **Utiliser l'outil `write` à la place.**

2. **NE PAS utiliser `grep`, `head`, `tail`, `cat`, `/dev/null`** dans les commandes bash —
   PowerShell ne les reconnaît pas. Pour filtrer la sortie, utiliser `Select-String` ou
   `Select-Object` côté PowerShell, ou mieux : traiter la sortie dans un script Node.

3. **NE PAS utiliser `||` comme séparateur** — PowerShell 5.1 ne le supporte pas. Utiliser
   `; if ($?) { ... }` à la place, ou `try/catch`.

4. **NE PAS utiliser `&&`** — PowerShell 5.1 ne le supporte pas. Utiliser `; if ($?) { ... }`.

5. **`${` dans les chaînes PowerShell** est interprété comme une variable. Pour écrire du
   code JS contenant des template literals `${...}`, passer par l'outil `write` (pas de
   shell) ou par un script Node externe écrit en ASCII pur.

6. **Encodage des fichiers** : toujours UTF-8 **sans BOM**. L'outil `write` garantit ça.
  `Set-Content -Encoding UTF8` (PowerShell 5.1) ajoute un BOM — à éviter.

---

## 2. Conventions de code

- **Langue** : le code, les commentaires et les messages CLI sont en **français**.
- **Commentaires** : NE PAS ajouter de commentaires sauf demande explicite. Les
  commentaires existants sont détaillés et pédagogiques — les imiter si on en ajoute.
- **Style** : indentation 2 espaces, pas de `;` en fin d'instruction (style Node.js),
  guillemets simples pour les chaînes, backticks pour les template literals.
- **Pas de dépendances externes** : Node.js built-ins uniquement (`fs`, `path`, `child_process`,
  `readline`, `vm`, etc.). Pas de `package.json`, pas de `npm install`.
- **Pas d'emojis dans le code** sauf demande explicite (les emojis existants dans le CLI
  et les rapports sont volontaires : ✔ ✘ ⚠ 👨‍🏫 etc.).

---

## 3. Vérifications obligatoires après modification de code

Après TOUTE modification d'un fichier `.js`, lancer **avant de déclarer le travail fini** :

```powershell
node --check <fichier_modifié.js>
```

Répéter pour chaque fichier modifié. Si une erreur de syntaxe apparaît, la corriger avant
de continuer. Ne JAMAIS livrer un fichier qui ne passe pas `node --check`.

Pour le runner complet, vérifier en plus que `parseCliArgs()` expose bien les nouveaux
flags (test rapide) :
```powershell
node -e "const {parseCliArgs}=require('./config'); process.argv=['node','runner.js','--force']; console.log(require('./config').parseCliArgs().force)"
```

---

## 4. Conventions critiques du projet (mémoire durable)

Ces règles sont issues de bugs passés et de décisions prises. Les respecter évite les
régressions.

### LM Studio
- **`response_format`** : LM Studio n'accepte que `{ type: 'json_schema' }` ou
  `{ type: 'text' }`. Le type `json_object` (spécifique OpenAI) est rejeté (HTTP 400).
- **Quantification** : récupérée via `/api/v0/models` (pas via `/v1/models` qui ne donne
  que l'id). Le flag `--quantization=` permet de forcer la saisie manuelle.
- **JIT loading** : si activé, `/v1/models` retourne tous les modèles téléchargés et
  l'inférence charge le modèle à la demande. Sinon, il faut `lms load` explicitement.

### OpenRouter (professeur IA + profilage externe)
- **Headers ByteString** : les headers HTTP OpenRouter (`HTTP-Referer`, `X-Title`) doivent
  être en Latin-1 (ByteString ≤ 255). Un caractère > 255 (ex: em dash `—` U+2014) fait
  planter `fetch` avec « Cannot convert argument to a ByteString ». Utiliser des tirets
  ASCII `-` dans les headers. Valable pour TOUS les clients fetch (`teacher-client.js`,
  `external-profiling.js`, `report-teacher.js`).
- **Ne jamais hardcoder un slug `:free`** : les modèles gratuits sont dépubliés sans
  préavis (ex: `meta-llama/llama-3.3-70b-instruct:free` → HTTP 404). Toujours récupérer
  la liste dynamique via `/api/v1/models` (endpoint public) et rotate sur les modèles
  gratuits disponibles.
- **`askTeacherToCorrectStudentAnalysis`** renvoie `{ content, model }` (objet), PAS une
  string. Tester `.content` et `.length` sur la bonne propriété pour ne pas ignorer la
  correction (bug historique : `teacherCorrection.length` sur un objet → toujours faux).

### Runner (runner.js)
- **`forceFlag`** : ajouté au destructuring de `runTierAttempt` (fonction top-level, PAS
  dans `main`). Doit être passé explicitement aux 2 appels (run principal + rattrapage)
  depuis `runSchool` (closure sur `main`). Si on l'oublie, `forceFlag` est `undefined`
  dans `runTierAttempt` et les `askYesNo` ne sont pas neutralisés en mode batch.
- **Seuil de validation d'un tier** : 70% DU TOTAL POSSIBLE
  (`validationThreshold = Math.floor(totalPossiblePoints * 0.7)`), PAS 70 points fixes.
  `totalPossiblePoints` = somme des points des tâches conservées après filtrage.
- **Rattrapage** : AUTOMATIQUE (plus de question manuelle). Déclenché si l'un de ces 3
  critères est rempli : (1) tier obligatoire échoué, (2) santé globale < 0 PV,
  (3) ≥ 40% des exercices échoués. `MAX_RATTRAPAGE_ATTEMPTS = 1`.
- **Erreurs brutes du sandbox VM** : JAMAIS afficher seules (ex: "Invalid or unexpected
  token", "X is not defined"). Toujours les accompagner d'une explication pédagogique
  (`explainTechnicalError()` ou explication exigée du modèle via
  `askModelForFailureExplanation()`).
- **`askYesNo` en non-TTY** : retourne `false` (pas de blocage). `--force` court-circuite
  les 3 confirmations de re-test/pénalité pour le mode nuit.

### Échelle de notes A-F (progress-bar.js `letterGrade`)
- A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60 (seuils `>=` descendants, A prime sur B).

### Classement (leaderboard.js)
- **Layout en carte** : stats (modèle, points, obligatoire, santé, bonus...) en ligne,
  arguments (forces/faiblesses) juste en dessous, PAS dans une colonne séparée.
- **Fichiers de sortie** : `Export-Rapports/classement.html` et `classement.md` (noms
  fixes, sans horodatage, écrasés à chaque génération).
- **JS inline** : ne pas utiliser `esc()` pour injecter des valeurs dans des littéraux JS
  inline (`onclick` etc.) — `esc()` convertit `'` en `&#39;` (entité HTML invalide en JS),
  ce qui casse tout le script inline. Échapper manuellement ou utiliser `data-*` + addEventListener.
- **Ascenseurs** : toujours cachés (CSS `scrollbar-width: none`, `::-webkit-scrollbar`).

### Rapports Markdown
- **Timestamp local** : le dossier jour et l'horodatage des noms de fichiers utilisent la
  date/heure locales (pas UTC), pour rester cohérents.
- **Tableau par exercice** : chaque exercice inclut un tableau
  `Exercice | Type | Points obtenus | Points max | Statut` + tableau récapitulatif global.
- **Architecture d'export** : `Export-Rapports/<AAAA-MM-JJ>/<ÉCOLE>/<NIVEAU-OU-CLASSE>/rapport_v3_*.md`.
- **Section « Validation du professeur IA »** : rédigée par un modèle externe
  (`report-teacher.js`), ajoutée à la fin du rapport si le professeur est activé.

### Spinner
- **Pas d'humour** : le Spinner n'utilise plus `WAITING_MESSAGES`. Avant le streaming il
  affiche uniquement `⠋ <label>...` sans phrase humoristique. Les messages pédagogiques
  rotatifs (`PROFILING_WAITING_MESSAGES`, `POST_PROFILING_WAITING_MESSAGES`) restent
  autorisés pendant les temps morts longs (auto-profilage, préparation).

### Articles externes (LinkedIn, Tasks1.md...)
- **Texte brut, pas de Markdown** : les articles destinés à LinkedIn ou à des plateformes
  externes doivent être en texte brut sans aucune syntaxe Markdown (pas de `#`, `**`,
  `---`, `-`), car les symboles se reproduisent tels quels sur ces plateformes.

---

## 5. Journal de versions

- **Le SEUL journal de versions de référence est `Docs/CHANGELOG.md`** (à la racine du dépôt).
  Il DOIT être tenu à jour à chaque modification de code.
- `Memories-BenchGo/CHANGELOG.md` a été supprimé et ne doit plus être utilisé ni mentionné.

---

## 6. Documentation

- **Manuel utilisateur** : `Docs/Manuel-utilisateur/` (01 à 07).
  - `07-mode-nuit.md` documente le mode batch nocturne (`night-batch.js`).
- **README racine** : lister les fonctionnalités principales avec un emoji + lien vers la
  doc détaillée.
- **README du manuel** : parcourir les chapitres dans l'ordre (1 à 7).

---

## 7. Mode nuit (night-batch.js) — rappels spécifiques

- **Ne pas toucher au serveur déjà lancé** : le script démarre le serveur en headless
  seulement s'il ne répond pas, et l'arrête seulement s'il l'a démarré.
- **`--force` au runner** : neutralise les 3 `askYesNo` (re-test modèle déjà testé ×2,
  comptabilisation pénalité → maintenue). NE PAS oublier de passer `forceFlag` à
  `runTierAttempt` (cf. §4 Runner).
- **Écoles** : `LIGHT`, `STANDARD`, `EXPERT`, `DOCTORAT`, `auto`. Comparaison insensible à
  la casse dans `resolveSchoolsFromArg` (`x.key.toUpperCase() === k`).
- **ModelKeys** : récupérés via `lms ls --json --llm` (champ `modelKey`). Sensibles à la
  casse, incluent parfois la quantification (`@q4_k_m`).

---

## 8. Workflow recommandé pour une tâche de code

1. **Lire** le ou les fichiers concernés avec l'outil `read` (pas de shell).
2. **Modifier** avec `edit` (modification ciblée) ou `write` (réécriture complète).
3. **Vérifier la syntaxe** : `node --check <fichier>` via l'outil `bash`.
4. **Tester le comportement** : si possible, lancer un test rapide (ex: dry-run,
   `parseCliArgs()`, vérification d'un endpoint).
5. **Mettre à jour `Docs/CHANGELOG.md`** avec contexte + implémentation + fichiers modifiés.
6. **Mettre à jour la doc utilisateur** si la fonctionnalité est visible par l'utilisateur.
7. **Ne JAMAIS committer** sans demande explicite de l'utilisateur.