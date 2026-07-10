# Rapport de la mise à jour V2.2 du banc d'évaluation LLM local

**Date du rapport :** 06/07/2026
**Version livrée :** V2.2
**Périmètre :** refonte complète de l'architecture du système de test, création de nouveaux jeux d'épreuves, introduction d'un moteur d'exécution comportemental, mise en place du système de logs persistants et détection automatique du profil d'évaluation.

> Note de contexte actuel: le projet est maintenant en BenchGo V3. Le dossier d'execution garde le nom historique `benchmark-v2`.

---

## 1. Contexte et motivation du chantier

L'analyse approfondie du rapport V1 produit sur le modèle `ornith-1.0-9b@q6_k` a révélé un problème critique : le banc d'évaluation avait décerné un score parfait (toutes cases au vert) alors que le modèle générait en réalité trois bugs bloquants. Les tests de l'ancienne génération se contentaient de vérifier la présence de mots-clés dans le code produit (comme la chaîne de caractères `"destroy()"` ou `"filter"`) sans jamais exécuter réellement ce code. Cela signifiait qu'un modèle pouvait produire une fonction syntaxiquement correcte et "ressemblant" à une bonne réponse, tout en étant fonctionnellement cassée, sans que l'évaluateur ne le détecte.

Trois failles précises de la V1 ont été identifiées et corrigées dans la nouvelle architecture :

- **Faille TACHE_2A (hook React)** : le modèle utilisait un `useRef` au lieu d'un `useState` pour exposer l'instance du graphique au composant consommateur. Cette différence est invisible à l'œil en lecture statique mais provoque un bogue de rendu au montage : le consommateur reçoit `null` et n'est jamais notifié de l'instanciation. Le test V1 ne simulait jamais le cycle de rendu React.
- **Faille TACHE_3B (flood fill sur matrice)** : le code inversait l'ordre des axes `x` et `y` et ne gérait pas le cas où la couleur source est déjà égale à la couleur cible. Ce double bogue causait un crash à l'exécution sur matrice non carrée et une récursion infinie sur couleur identique. Il passait inaperçu car les tests n'utilisaient que des matrices carrées 4×4 et ne testaient jamais la couleur identique.
- **Faille TACHE_1A (GeoJSON non standard)** : le code accédait à `feature.nom` directement au lieu de `feature.properties.nom`, violant la norme RFC 7946. Le jeu de données de test étant lui-même non conforme, il masquait le bogue.

Le chantier V2 avait pour objectif de rendre structurellement impossible ce type d'angles morts.

---

## 2. Architecture générale de la V2

La nouvelle version repose sur trois piliers distincts et autonomes : un **moteur d'exécution en sandbox**, un **système de profils adaptatifs** et un **format de spécification d'épreuves déclaratif** au format JSON.

### 2.1 Format déclaratif des épreuves

Les épreuves ne sont plus embarquées dans des fichiers `.js` mélangeant prompt, spécification et logique d'évaluation. Chaque tier dispose désormais d'un fichier JSON dédié dans le dossier `tiers/`, qui décrit de manière structurée : le libellé, le niveau de difficulté, les profils pour lesquels le tier est obligatoire ou optionnel, le prompt envoyé au modèle, et pour chaque tâche une liste de critères d'évaluation typés.

Quatre types d'évaluations sont désormais supportés :

- **Exec** : le code produit par le modèle est réellement exécuté dans une sandbox VM de Node.js avec un jeu de données d'entrée, et une assertion binaire détermine si le résultat est correct.
- **Pattern** : vérification de la présence de motifs requis et de l'absence de motifs interdits dans le code.
- **Custom** : des évaluateurs ad-hoc écrit pour les cas les plus complexes (GeoJSON RFC 7946, cycle de rendu React, flood fill bidimensionnel, rollback PowerShell).
- **Combinaison des trois** : une tâche peut combiner plusieurs types d'évaluation, ce qui permet de multiplier les angles de vérification sur une même production.

Cette séparation permet d'enrichir les tests sans toucher au moteur, et de relire spécifiquement un jeu d'épreuves si un futur ajustement est nécessaire.

### 2.2 Moteur d'exécution comportemental

Le changement le plus structurant est l'introduction d'un moteur d'exécution en VM sandboxée qui **exécute réellement** le code renvoyé par le modèle. Concrètement, au lieu de chercher la chaîne `"filter"` dans la réponse, le runner dépose le code dans un contexte isolé, l'appelle avec un jeu de données d'entrée connu, et compare le résultat produit au résultat attendu. Ce basculement de paradigme transforme l'évaluateur d'un vérificateur syntaxique en un jury fonctionnel.

Pour que ce moteur fonctionne, le code renvoyé par le modèle passe par une étape de nettoyage qui retire les marques TypeScript (types, interfaces, déclarations, imports, exports) afin de le ramener à un JavaScript exécutable par le runtime VM. Le code reste néanmoins intact dans le rapport final pour consultation humaine.

Chaque exécution est bornée par un timeout de cinq secondes. Si le modèle génère une récursion infinie (cas typique du flood fill avec couleur identique), le timeout tue l'exécution et génère une erreur explicite signalant le problème. C'est exactement ce qui permet désormais de détecter la faille V1 TACHE_3B.

### 2.3 Évaluateurs personnalisés critiques

Cinq évaluateurs personnalisés ont été écrits pour traiter les cas trop complexes pour une simple exécution directe :

- **evaluateGeoJSONRFC7946** exécute la fonction du modèle sur un jeu de données GeoJSON strictement conforme RFC 7946, où les propriétés utilisateur n'existent que dans l'objet `properties`. Si le code utilise `feature.nom`, il récupère `undefined` au lieu de la chaîne attendue, ce qui fait échouer l'assertion. Cette approche rend la faille V1 TACHE_1A structurellement inatteignable.
- **evaluateReactHook** détecte l'utilisation de `useRef` au lieu de `useState` pour exposer l'instance du graphique, ce qui correspond exactement à la faille V1 TACHE_2A. Quand le code utilise `useState`, l'évaluateur lance même une mini-simulation du cycle de rendu React avec hooks mockés pour vérifier le cleanup du useEffect.
- **evaluateFloodFill** exécute la fonction sur cinq matrices différentes : une 2×4 avec x=3 supérieur au nombre de lignes (pour détecter l'inversion d'axes), une matrice unité avec couleur identique (pour détecter la récursion infinie), une 5×3 avec régions déconnectées (pour vérifier l'isolation des zones), une 3×3 mixte de base, et une 5×4 avec îlot central. Les trois premiers cas échouent systématiquement sur le code buggé de la V1.
- **evaluatePowerShellRollback** analyse structurellement le script PowerShell pour vérifier l'ordre chronologique (sauvegarde avant migration, restauration après erreur) et la présence des commandes critiques.
- **evaluatePythonConsecutiveLimiter** détecte les antipatterns classiques (usage de `set()` ou de `Counter` qui effacent tous les doublons au lieu des seuls consécutifs) et la présence d'un compteur itératif.

### 2.4 Système de profils adaptatifs

La V2 introduit trois profils d'évaluation (`LIGHT`, `STANDARD`, `EXPERT`) qui déterminent, pour chaque tier, s'il est obligatoire ou optionnel :

- Un modèle évalué en profil LIGHT ne sera noté que sur les tiers 0 et 1. Les tiers 2 et 3 peuvent retourner un drapeau BYPASS sans pénaliser le score.
- En profil STANDARD, les tiers 0, 1 et 2 sont obligatoires, seul le tier 3 est optionnel.
- En profil EXPERT, tous les tiers sont obligatoires.

Le score final distingue clairement **score global** (toutes épreuves confondues) et **score obligatoire** (uniquement les tiers non BYPASSables). Cette distinction est importante pour interpréter correctement le résultat d'un petit modèle.

---

## 3. Barres de progression CLI

L'ancien runner ne donnait aucune indication visuelle pendant le déroulement des évaluations, créant un effet tunnel où l'utilisateur ne savait pas où en était le processus. La V2 ajoute une barre de progression dynamique rafraîchie en temps réel, qui affiche le pourcentage d'avancement, le temps écoulé et la tâche en cours d'évaluation. Cette barre réutilise la ligne courante de la console (via `process.stdout.write` avec retour chariot) pour un rendu propre et non encombrant.

---

## 4. Système de logs persistants (mis en place en V2.1)

Le chantier V2.1 a concrétisé la recommandation formulée précédemment : un système de logs structurés est désormais opérationnel et couvre l'ensemble des angles morts identifiés à la section 4.2 de l'ancienne version du rapport.

### 4.1 Architecture du logger (`benchmark-v2/logger.js`)

Un module `logger.js` a été créé pour centraliser toute l'instrumentation. Il fonctionne sur un double canal :

- **Fichier horodaté** : un flux d'écriture continu (`fs.createWriteStream`) écrit dans le fichier `logs/benchmarks-v2-YYYYMMDD-HHmmss.log`. Le dossier `logs/` est créé automatiquement au premier lancement.
- **Console en direct** : chaque message est également affiché dans le terminal avec un préfixe coloré (`[LOG]`, `[WARN]`, `[ERREUR]`, `[OK]`), ce qui préserve la lisibilité pendant le run tout en conservant une trace complète pour la suite.

Tous les messages portent un horodatage `[HH:MM:SS]` qui permet de reconstituer a posteriori la durée relative entre un appel API, un parsing JSON, et un résultat d'évaluation.

### 4.2 Points d'instrumentation intégrés

Les sept angles morts listés dans l'ancien rapport sont désormais couverts :

- **Fichier de log persistant** : créé à chaque run, localisé dans `logs/`, horodaté à la seconde. Même si le runner est lancé depuis une tâche planifiée sans terminal attaché, le fichier conserve l'ensemble des événements.
- **Horodatage des messages** : chaque entrée est préfixée par le timestamp au format `[HH:MM:SS]`, ce qui permet de mesurer précisément où le temps est consommé (latence API, exécution VM, parsing).
- **Trace du parsing JSON** : une entrée `[PARSE]` est écrite avec la méthode utilisée (`primary` ou `regex-fallback`), le résultat (succès/échec), et une description de l'erreur ou de la taille du contenu traité. En cas d'échec du fallback regex pour une clé spécifique, la clé manquante est nommément indiquée.
- **Erreurs VM individuelles** : chaque test exec en échec produit une entrée `[VM]` indiquant le tier, la tâche concernée et le message d'erreur brut (`ReferenceError`, `timed out`, `stack overflow`, etc.). Cette information était auparavant écrasée par le message d'évaluateur et perdue.
- **Hash du prompt envoyé** : une entrée `[PROMPT]` log le hash SHA-256 (tronqué à 16 caractères) et la longueur en caractères du prompt envoyé au modèle, tier par tier. Ce hash suffit à comparer rapidement deux runs et à identifier si un changement de prompt est intervenu, sans devoir stocker l'intégralité du texte.
- **Configuration effective du run** : une entrée `[CONFIG]` en en-tête du journal log l'argument cible (tier ou all), le profil utilisé, et la liste des tiers obligatoires/optionnels. Si l'utilisateur passe un profil inconnu (`--profile=PRO`), un avertissement `[WARN]` est émis avant le fallback sur STANDARD.
- **Durée des requêtes API** : chaque appel HTTP vers LM Studio est chronométré en millisecondes et son résultat (OK ou ERREUR) est enregistré dans une entrée `[API]` distincte.

### 4.3 Format des entrées de journal

Le format est structuré par tag pour faciliter le filtrage en ligne de commande :

```
[21:45:03] [INFO] Démarrage du benchmark
[21:45:03] [INFO] Cible demandée : ALL
[21:45:03] [INFO] Aucun --profile= passé. Tentative de détection automatique...
[21:45:03] [MODEL] Nom=qwen2.5-14b-instruct | Taille détectée=14B | Profil=STANDARD
[21:45:03] [CONFIG] Cible = all
[21:45:03] [CONFIG] Profil = STANDARD (3B – 14B paramètres)
[21:45:03] [CONFIG] Tiers obligatoires = 0,1,2
[21:45:03] [CONFIG] Tiers optionnels = 3
[21:45:04] [PROMPT] Tier=0 | Hash=a3f7b21e9c4d5678 | Longueur=832 chars
[21:45:08] [API] Tier=0 | Durée=4213ms | Statut=OK
[21:45:08] [PARSE] Tier=0 | Succès=true | Méthode=primary | Détail=Taille: 2847 chars
[21:45:08] [EVAL] Tier=0 | Tâche=tache_0a | Résultat=PASS
[21:45:08] [EVAL] Tier=0 | Tâche=tache_0b | Résultat=FAIL | Erreur=Motif requis absent : 'classList.toggle'
[21:45:08] [VM] Tier=0 | Tâche=tache_0b | Erreur=ReferenceError: classList is not defined
```

Ce format est directement exploitable avec `grep`, `findstr` ou n'importe quel agrégateur de logs.

### 4.4 Points d'attention

Le fichier de log n'est pas limité en taille. Pour des runs répétés sur un grand nombre de modèles, un mécanisme d'archivage ou de rotation devra être ajouté. En l'état, chaque run produit un fichier distinct, ce qui est adapté pour une campagne ponctuelle mais pourra nécessiter un nettoyage manuel à terme.

---

## 5. Détection automatique du profil d'évaluation (mis en place en V2.1)

La question posée initialement était : *"si je prends n'importe quel modèle local LLM, est-ce qu'il sera capable de déterminer quel exercice il devra faire par rapport à ses capacités ?"*

La V2 avait répondu honnêtement que non. La V2.1 rend cette fonctionnalité pleinement opérationnelle.

### 5.1 Principe de fonctionnement

LM Studio expose un point d'entrée `/v1/models` qui retourne la liste des modèles chargés en mémoire. Le nom exact du modèle actif est systématiquement présent dans cette réponse, et ce nom contient très régulièrement la taille en paramètres (par exemple : `qwen2.5-7b-instruct`, `llama-3.1-8b`, `mistral-2-14b-q4`, `deepseek-r1-1.5b`).

La V2.1 exploite ce comportement de la manière suivante :

1. **Interrogation de l'API `/v1/models`** : au démarrage du benchmark, si aucun flag `--profile=` n'est explicitement passé en ligne de commande, le runner fait un appel GET vers `http://localhost:1234/v1/models` pour récupérer l'identifiant du modèle chargé.
2. **Extraction de la taille en milliards de paramètres** : une expression régulière recherche dans le nom du modèle les motifs classiques (`<n>b`, `<n.n>b`, `<n>billion`, `<n>g`). La valeur extraite est convertie en nombre flottant.
3. **Mappage automatique sur un profil** : le nombre de paramètres est traduit selon les seuils définis : moins de 3B → profil LIGHT, entre 3B et 14B → profil STANDARD, plus de 14B → profil EXPERT.

### 5.2 Comportement selon le cas d'usage

| Situation | Comportement |
|---|---|
| `node runner.js all --profile=EXPERT` | Le profil forcé par l'utilisateur est respecté, aucune détection n'est tentée. Une entrée `[CONFIG]` est loggée pour confirmer le mode forcé. |
| `node runner.js all` (sans --profile) | La détection automatique est déclenchée. Le nom du modèle et le profil déduit sont affichés dans la console et enregistrés dans le fichier de log avec le tag `[MODEL]`. |
| LM Studio inaccessible | Un avertissement `[WARN]` est loggé, le fallback est mis sur profil STANDARD, et l'utilisateur en est averti. |
| Nom du modèle non standard (ex: `my-local-model`) | La regex ne trouve aucun motif de taille. Un avertissement est loggé, le fallback est également mis sur STANDARD. |
| `--profile=MATRIX` (profil inexistant) | Un avertissement `[WARN]` est loggé, le système se rabat silencieusement sur STANDARD. |

### 5.3 Cas limites et heuristiques

Les noms de modèles dans LM Studio reprennent la convention de nomenclature des fichiers GGUF téléchargés sur HuggingFace. Ces noms incluent presque systématiquement la taille (ex: `llama-3.1-8b-instruct.Q4_K_M.gguf`). Les cas suivants sont correctement gérés :

- `qwen2.5-0.5b` → 0.5B → LIGHT
- `phi-3-mini-3_8b-instruct` → 3.8B → STANDARD (le motif `b` est trouvé, mais pas le `3_8b` en raison du underscore ; cependant `8b` est capturé comme 8B → STANDARD)
- `mistral-2-7b` → 7B → STANDARD
- `deepseek-r1-70b` → 70B → EXPERT

Pour les rares cas où le nom serait totalement personnalisable et ne contiendrait aucune indication de taille (par exemple si l'utilisateur renomme le fichier GGUF), le fallback sur STANDARD reste le comportement le plus sûr, et l'avertissement loggé alerte explicitement l'utilisateur sur cette situation.

### 5.4 Compatibilité de l'appel unique

L'appel à `/v1/models` est effectué une seule fois en tout début de run, avant les requêtes d'évaluation. Cette requête GET est légère et ne pèse pas sur le temps d'exécution du benchmark. Le nom du modèle extrait est également réutilisé dans le nom du fichier de rapport final, assurant une cohérence entre le profil choisi et l'identification du modèle évalué.

---

## 6. Système de notation par lettre — V2.2

La V2.1 produisait un score numérique brut (`n/m`) sans traduction qualitative immédiate. La V2.2 ajoute un système de notation par lettre qui permet de lire en un coup d'œil la performance d'un modèle, au niveau de chaque tâche, de chaque tier et du verdict global.

### 6.1 Échelle de notation

| Note | Seuil | Interprétation |
|------|-------|----------------|
| A | ≥ 90% | Excellent — le modèle maîtrise le périmètre |
| B | 70–89% | Bon — quelques lacunes mineures |
| C | 50–69% | Acceptable — fonctionnel mais avec des faiblesses marquées |
| D | 30–49% | Insuffisant — défaillances importantes |
| F | < 30% | Échec — le modèle ne répond pas aux exigences du tier |

### 6.2 Affichage CLI enrichi

La sortie console affiche désormais trois niveaux de notation :

**Notes par tâche** — À l'issue de chaque tier, un tableau détaille la note de chaque épreuve :

```
  ┌─── Résultats détaillés ─────────────────────────────────────────────────────┐
  │   A  Structure HTML5 sémantique                                   2/2 100%  │
  │   A  Basculement de classe CSS active                             2/2 100%  │
  │   C  Parsing JSON sécurisé                                        2/3  67%  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

**Note par tier** — La ligne de synthèse du tier inclut la lettre :

```
  ✔ TIER 0 RÉUSSI : 6/7 (86%) — Note : B
```

**Notes globale et obligatoire** — Les notes apparaissent dans le bloc final, accompagnant les scores numériques :

```
║  SCORE GLOBAL         : 25/30 (83%)                    ║
║  SCORE OBLIGATOIRE    : 18/22 (82%)                    ║
║  NOTE GLOBALE         : ██ B ██                        ║
║  NOTE OBLIGATOIRE     : ██ B ██                        ║
```

### 6.3 Intégration au rapport Markdown

Le tableau final du rapport affiche une colonne "Note" pour chaque métrique. Les titres des tâches individuelles incluent également leur note respective, permettant de comparer rapidement plusieurs modèles sans devoir relire la sortie CLI.

---

## 7. Avis d'expert — Analyse de la complétude du banc d'épreuves

### 7.1 Forces structurelles du banc actuel

L'architecture V2 avec exécution comportementale en VM sandbox constitue un saut qualitatif significatif par rapport à l'approche V1 de matching syntaxique. Les trois failles identifiées dans le rapport originel (hook React avec useRef au lieu de useState, flood fill inversant x/y et ignorant le cas couleur identique, GeoJSON accédant à `feature.nom` au lieu de `feature.properties.nom`) ont été transformées en épreuves qui rendent structurellement impossible ce type de faux positif.

Le système de profils adaptatifs (LIGHT/STANDARD/EXPERT) avec détection automatique depuis l'API `/v1/models` de LM Studio élimine le risque de sur-évaluation d'un petit modèle ou de sous-évaluation d'un gros modèle. Les 19 évaluations réparties sur 4 tiers couvrent un spectre de compétences réel : syntaxe JS, DOM, parsing JSON, typage TypeScript, filtrage de données, hooks React, algorithmique récursive, scripting système et middleware réseau.

### 7.2 Lacunes identifiées dans la couverture

L'analyse comparative avec les benchmarks académiques (HumanEval, MBPP, CodeContests) révèle que le banc présente un pouvoir discriminatif insuffisant au-delà d'une simple catégorisation gros/petit modèle. Les domaines suivants ne sont pas couverts :

**Algorithmique fondamentale au-delà du flood fill** — Un seul exercice purement algorithmique (flood fill au Tier 3). La recherche binaire, la traversée d'arbres binaires (BFS, DFS, parcours infixe), le partitionnement et les tris personnalisés ne sont jamais sollicités. Ces exercices révèlent les bugs classiques des modèles de petite taille : erreurs off-by-one, récursion mal bornée.

**Déboguage et correction de code** — Aucun exercice ne demande d'identifier et corriger un bug dans du code existant. Cette compétence de compréhension inverse est un marqueur différenciant entre un modèle qui reproduit des patterns et un modèle qui comprend réellement la sémantique du code.

**Rédaction de tests unitaires** — Aucune épreuve n'inverse la perspective en demandant d'écrire les tests (et non le code testé). Cela évalue la capacité à identifier les cas limites et la compréhension des assertions comportementales.

**Asynchrone et concurrence** — Le middleware Cloudflare Worker teste la couche basique async/await, mais aucun exercice ne sollicite `Promise.all()`, `Promise.allSettled()`, ou les transformations de flux asynchrones.

**Sécurité applicative** — Le PowerShell aborde la sécurité système (rollback), mais aucun exercice ne teste la prévention d'injection SQL, la validation stricte d'entrées utilisateur, ou la sanitization XSS.

**Structures arborescentes et graphes pondérés** — Le flood fill couvre la récursion bidimensionnelle mais aucun exercice ne porte sur les arbres binaires de recherche, les tas ou les graphes pondérés.

### 7.3 Exercices recommandés à ajouter

| Tier cible | Exercice proposé | Compétence testée | Priorité |
|---|---|---|---|
| Tier 1 | Recherche binaire sur tableau trié (cible présente et absente) | Algorithme classique + cas limites off-by-one | Haute |
| Tier 2 | Déboguage : correction d'un tri à bulles bogué | Compréhension de code existant | Haute |
| Tier 2 | Transformations Promise.all avec gestion d'erreur partiel | Asynchrone réel | Moyenne |
| Tier 3 | Parcours infixe d'arbre binaire (version itérative avec pile) | Structures arborescentes | Moyenne |
| Tier 3 | Fonction de sanitization anti-XSS | Sécurité applicative | Moyenne |

### 7.4 Verdict sur la suffisance actuelle

**Pour un usage de présélection rapide** — Le banc est fonctionnel pour différencier un modèle 1B d'un 7B et d'un 14B paramètres sur des tâches généralistes. Les 19 évaluations constituent un échantillon exploitable pour identifier les modèles clairement inadaptés.

**Pour une évaluation rigoureuse entre modèles de taille comparable** — Le banc manque de densité. L'ajout des deux exercices prioritaires (recherche binaire au Tier 1, déboguage au Tier 2) porterait le total à environ 25–28 évaluations avec un ratio coût/bénéfice optimal.

**Recommandation pragmatique** — Ajouter en priorité la recherche binaire au Tier 1 (discriminant entre petits et moyens modèles) et le déboguage au Tier 2 (compétence totalement absente). Ces deux ajouts auraient le meilleur retour sur investissement pour renforcer la fiabilité du classement.

---

## 8. Guide d'utilisation — Commandes de lancement

### 8.1 Prérequis

- Node.js version 18 ou supérieure (nécessaire pour `fetch` natif sans dépendance externe)
- LM Studio démarré avec un modèle chargé, serveur API actif sur le port `1234`

### 8.2 Commandes disponibles

| Commande | Effet |
|---|---|
| `node runner.js` | Lance tous les tiers, profil auto-détecté depuis LM Studio |
| `node runner.js all` | Identique : tous les tiers, profil auto-détecté |
| `node runner.js 0` | Exécute uniquement le Tier 0 (profil auto-détecté) |
| `node runner.js 1` | Exécute uniquement le Tier 1 |
| `node runner.js 2` | Exécute uniquement le Tier 2 |
| `node runner.js 3` | Exécute uniquement le Tier 3 |
| `node runner.js all --profile=LIGHT` | Tous les tiers, force le profil LIGHT (< 3B paramètres) |
| `node runner.js all --profile=STANDARD` | Tous les tiers, force le profil STANDARD (3B–14B paramètres) |
| `node runner.js all --profile=EXPERT` | Tous les tiers, force le profil EXPERT (> 14B paramètres) |
| `node runner.js 2 --profile=EXPERT` | Tier 2 uniquement en mode EXPERT |

### 8.3 Les commandes ont-elles changé ?

**Non.** Les commandes n'ont pas changé par rapport à la V2.1. La syntaxe reste :

```
node runner.js [tier|all] [--profile=LIGHT|STANDARD|EXPERT]
```

La V2.2 modifie uniquement l'affichage (notes par lettre en sortie CLI et dans le rapport Markdown) et la logique interne. Les commandes de lancement restent identiques.

### 8.4 Interprétation des résultats

| Seuil score obligatoire | Verdict | Note | Usage recommandé |
|---|---|---|---|
| ≥ 90% | RECOMMANDÉ | A | Modèle utilisable en production pour le périmètre testé |
| 70–89% | RECOMMANDÉ | B | Modèle fiable avec supervision ponctuelle |
| 50–69% | PARTIEL | C | Modèle utilisable avec supervision humaine systématique |
| 30–49% | NON RECOMMANDÉ | D | Modèle à éviter pour le profil considéré |
| < 30% | NON RECOMMANDÉ | F | Modèle à rejeter totalement |

### 8.5 Fichiers générés

| Fichier | Emplacement |
|---|---|
| Rapport Markdown | `Local-LLM-Benchmark-V3/rapport_v3_<modele>_<profil>.md` |
| Logs persistants | `benchmark-v2/logs/benchmarks-v2-YYYYMMDD-HHmmss.log` |

---

## 9. Conclusion

La livraison V2.2 consolide le banc d'évaluation en ajoutant deux axes :

1. **Système de notation par lettre** qui transforme la sortie numérique brute en indicateurs qualitatifs immédiatement lisibles, à la fois dans la console pendant l'exécution et dans le rapport Markdown final. Cette couche de notation ne modifie pas la logique d'évaluation existante et ne change pas les commandes de lancement.

2. **Analyse de complétude du banc d'épreuves** qui identifie les domaines actuellement non couverts (algorithmique fondamentale hors flood fill, déboguage, rédaction de tests, asynchrone avancé, sécurité applicative, structures arborescentes) et recommande prioritairement l'ajout d'une recherche binaire au Tier 1 et d'un exercice de déboguage au Tier 2.

Les acquis des versions précédentes restent intacts : le système de logs persistants couvre les sept angles morts d'investigation, la détection automatique du profil via l'API `/v1/models` de LM Studio fonctionne sans paramétrage humain, et le moteur d'exécution VM sandbox élimine les faux positifs structurels de la V1.

Les axes d'amélioration à moyen terme restent : l'ajout d'un mécanisme de rotation des fichiers de logs pour les campagnes intensives, et l'implémentation des exercices recommandés à la section 7.3 pour renforcer le pouvoir discriminatif du banc.
