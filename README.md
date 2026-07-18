# 🏇 BenchGo V3 — Benchmark Comportemental de Modèles LLM

BenchGo V3 est un **benchmark comportemental** pour modèles de langage (LLM), locaux (via
[LM Studio](https://lmstudio.ai/)) ou cloud (OpenAI, Anthropic, Groq, Together, OpenRouter,
Mistral). Il évalue la capacité d'un modèle à **générer du code JavaScript correct** à travers
une métaphore scolaire : chaque profil est une école, chaque niveau est une classe, avec des
exercices distincts à chaque croisement.

Le benchmark s'articule autour de 5 axes : **vitesse d'inférence**, **mémoire longue**,
**optimisation d'exécution**, **robustesse aux injections** et **respect des contraintes**,
le tout dans un bac à sable VM isolé.

---

## ✨ Fonctionnalités principales

- 🎓 **Métaphore scolaire** : 5 profils = 5 écoles (Primaire → Collège/Lycée → Université → Thèse → Post-Doc), chaque tier = une classe avec ses propres exercices.
- 🧠 **Auto-profilage & calibration** : le modèle s'auto-évalue sur 4 compétences au démarrage ; les tâches trop difficiles sont filtrées ; un Indice de Calibration C = 1 − |D − P| mesure la lucidité du modèle.
- ❤️ **Santé globale (gamification)** : le modèle accumule des PV (succès) ou en perd (échecs). En dessous de −100 PV, élimination définitive (Game Over).
- 🆘 **Aide du professeur & rattrapage** : un indice peut être proposé au modèle en rattrapage ; un seul réessai par exercice (`MAX_TASK_RETRIES = 1`).
- 📊 **Classement global interactif** : HTML condensé avec modale de détail, filtres par catégorie de performance et par taille de modèle, recherche texte.
- 📝 **Exports** : rapport Markdown par run, classement HTML/Markdown global, export raisonnement consolidé (destiné à NotebookLM via Gemini).
- ☁️ **Mode cloud** : 6 fournisseurs supportés (OpenAI, Anthropic, Groq, Together, OpenRouter, Mistral).
- 🧪 **Évaluateurs custom asynchrones** : Promise.allSettled, retry/backoff, concurrence limitée, middleware Cloudflare, etc.

---

## 🚀 Démarrage rapide

### Prérequis
- [Node.js](https://nodejs.org/) 18+
- [LM Studio](https://lmstudio.ai/) (pour les modèles locaux) OU une clé API cloud

### Mode local (LM Studio)

```bash
# 1. Charger un modèle dans LM Studio et démarrer le serveur local (port 1234)

# 2. Lancer un benchmark complet (détection auto du profil selon la taille du modèle)
node runner.js all

# 3. Ou forcer un profil
node runner.js all --profile=LIGHT      # < 3B
node runner.js all --profile=STANDARD   # 3B – 14B
node runner.js all --profile=EXPERT     # 14B – 30B
```

### Mode cloud

```bash
# OpenAI
$env:OPENAI_API_KEY = "sk-..."
node runner.js all --provider=openai --model=gpt-4o

# Anthropic
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node runner.js all --provider=anthropic --model=claude-opus-4-5

# Groq (gratuit, très rapide)
$env:GROQ_API_KEY = "gsk_..."
node runner.js all --provider=groq --model=llama-3.1-70b-versatile

# OpenRouter (accès universel)
$env:OPENROUTER_API_KEY = "sk-or-..."
node runner.js all --provider=openrouter --model=anthropic/claude-opus-4 --profile=FRONTIER
```

### Gérer le classement

```bash
# Régénérer les 3 fichiers de classement (HTML + MD + raisonnement)
node leaderboard.js

# Mode interactif (serveur web sur http://localhost:3939, boutons de suppression actifs)
node leaderboard.js --serve
```

---

## 🏫 Architecture scolaire

| Profil | École | Taille modèle | Tiers obligatoires | Tiers optionnels |
|---|---|---|---|---|
| LIGHT | 🏫 Primaire | < 3B | 0, 1 | 2, 3, 4, 5 |
| STANDARD | 🏫 Collège/Lycée | 3B – 14B | 0, 1, 2 | 3, 4, 5, 6 |
| EXPERT | 🎓 Université | 14B – 30B | 0, 1, 2, 3 | 6 |
| DOCTORAT | 🔬 Thèse | > 30B | 0, 1, 2, 3, 6 | — |
| FRONTIER | 🔬 Post-Doc | Cloud | 0, 1, 2, 3, 4, 6 | — |

Chaque croisement (profil × tier) possède ses propres exercices dans `tiers/tier{N}_{profile}.json`,
avec une chaîne de fallback automatique (`FRONTIER → DOCTORAT → EXPERT → STANDARD → LIGHT`).

### Axes d'évaluation (Tier 6 — Expertise & Résistance)
1. **Vitesse d'inférence** — chronométrage du temps de génération de l'API
2. **Mémoire longue** — retrouver une « aiguille » au milieu d'un long texte
3. **Optimisation VM** — limite de temps d'exécution stricte (ex : 35 ms)
4. **Robustesse injection** — immunité face à des ordres contraires injectés
5. **Respect des contraintes** — interdiction de certaines instructions (ex : tri sans `.sort()`)

---

## 📊 Classement interactif (Leaderboard)

Le classement HTML (généré dans `Export-Rapports/classement.html`) est **condensé et interactif** :

- **Cartes condensées** : une ligne par modèle avec rang, nom, badge de catégorie, badge de taille (ex : `📦 7B`), et mini-stats (% avec barre, Note, Santé, Obligatoire, Aide/Rattrapage).
- **Modale de détail** : clic sur une carte ou sur « Détails » → ouvre une modale avec statistiques complètes, forces/faiblesses, tableau détaillé par école (avec calibration), et métadonnées.
- **Filtres par catégorie** : 🏆 Top du top (≥90%) · ✅ Recommandés (≥80%) · 📊 Dans la moyenne (≥70%) · ⚠️ En rattrapage (≥50%) · 💥 Échec total (<50%).
- **Filtres par taille de paramètres** : 🐱 < 3B · 📦 3B–14B · 🎓 14B–30B · 🧠 > 30B · ❓ Inconnue.
- **Recherche texte** : par nom de modèle. Combinable avec les filtres (ET logique).
- **Fichier autonome** : CSS + JS embarqués, ouvrable hors-ligne en double-clic, aucune dépendance externe.

### Exports produits (racine de `Export-Rapports/`)
| Fichier | Description |
|---|---|
| `classement.html` | Classement visuel interactif (condensé + modale + filtres) |
| `classement.md` | Classement Markdown tabulaire + détail par modèle |
| `raisonnement_modeles.md` | Raisonnements & réponses détaillés par modèle (destiné à NotebookLM via Gemini) |

---

## 🧩 Modules

| Module | Rôle |
|---|---|
| `runner.js` | Orchestrateur principal (routing Local/Cloud, auto-profilage, calibration, gamification) |
| `config.js` | Configuration centralisée (profils, CLI args, détection de profil, `selfProfiling`) |
| `self-profiling.js` | Auto-profilage du modèle + filtrage dynamique des tâches |
| `lm-studio-client.js` | Client API LM Studio (streaming SSE, budget contexte) |
| `cloud-client.js` | Client API cloud (6 fournisseurs, OpenAI-compat + Anthropic natif) |
| `tier-loader.js` | Chargement des tiers JSON par profil (fallback chain) |
| `task-evaluator.js` | Moteur d'évaluation des tâches (exec/pattern/custom) |
| `custom-evaluators.js` | Évaluateurs comportementaux spécialisés (async, sécurité, algos) |
| `vm-sandbox.js` | Bac à sable VM isolé (`setTimeout`/`clearTimeout` inclus) |
| `parsing-utils.js` | Extraction JSON/regex + stripping TypeScript |
| `score-ledger.js` | Carnet de scores persistant + calcul de calibration |
| `report-generator.js` | Génération des rapports Markdown |
| `leaderboard.js` | Classement global (HTML condensé + modale + filtres, MD, raisonnement) |
| `progress-bar.js` | UI console (ProgressBar, Spinner, `letterGrade`) |
| `logger.js` | Journalisation dans `logs/` |

---

## 📁 Structure du projet

```
benchmark-v3/
├── runner.js                  ← Orchestrateur principal
├── config.js                  ← Configuration & profils
├── leaderboard.js             ← Classement global (HTML + MD + raisonnement)
├── self-profiling.js          ← Auto-profilage & calibration
├── score-ledger.js            ← Carnet de scores persistant
├── cloud-client.js            ← Client API cloud (6 fournisseurs)
├── lm-studio-client.js        ← Client API LM Studio
├── tier-loader.js             ← Chargement des tiers par profil
├── task-evaluator.js          ← Moteur d'évaluation
├── custom-evaluators.js       ← Évaluateurs spécialisés
├── vm-sandbox.js              ← Bac à sable VM
├── parsing-utils.js           ← Parsing & stripping TypeScript
├── report-generator.js        ← Génération rapports Markdown
├── progress-bar.js            ← UI console
├── logger.js                  ← Journalisation
├── tiers/                     ← 16 fichiers JSON d'exercices (par profil × tier)
├── Docs/                      ← Documentation utilisateur
├── Memories-BenchGo/          ← Mémoire du projet (CHANGELOG, architecture, issues-fixes)
└── Export-Rapports/           ← Rapports générés (gitignored)
    ├── .carnet/<modele>.json  ← Carnets de scores persistants
    ├── classement.html        ← Classement interactif
    ├── classement.md          ← Classement Markdown
    └── raisonnement_modeles.md ← Export raisonnement (NotebookLM)
```

---

## 📖 Documentation

- [Memories-BenchGo/README.md](./Memories-BenchGo/README.md) — Index de la mémoire du projet
- [Memories-BenchGo/CHANGELOG.md](./Memories-BenchGo/CHANGELOG.md) — Historique chronologique des modifications
- [Memories-BenchGo/architecture/benchmark-v2.md](./Memories-BenchGo/architecture/benchmark-v2.md) — Architecture détaillée du moteur
- [Memories-BenchGo/carte-mentale/classement-leaderboard.md](./Memories-BenchGo/carte-mentale/classement-leaderboard.md) — Carte mentale du classement HTML
- [Docs/](./Docs/) — Documentation utilisateur (démarrage, commandes, fonctionnement, dépannage)

---

## ⚙️ Options CLI

| Option | Description |
|---|---|
| `all` ou `N` | Lance tous les tiers ou un tier spécifique (0-6) |
| `--profile=<PROFIL>` | Force le profil (LIGHT / STANDARD / EXPERT / DOCTORAT / FRONTIER) |
| `--context-limit=<N>` | Limite de tokens de contexte (défaut : 16384) |
| `--provider=<NOM>` | Mode cloud (openai / anthropic / groq / together / openrouter / mistral) |
| `--model=<NOM>` | Nom du modèle cloud |
| `--api-key=<CLÉ>` | Clé API cloud (⚠️ visible dans le terminal — préférer les variables d'env) |

---

## 📜 Licence

Projet personnel — voir les conditions d'utilisation dans le dépôt.

---

**BenchGo V3** — *Si ce n'est pas documenté, ça n'a pas été fait.* 🏇