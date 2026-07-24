# 08 — Communauté & Classement Participatif

BenchGo V3 inclut un système participatif qui permet à tous les utilisateurs de
contribuer au classement consolidé. Si vous clonez le projet et testez des modèles,
vous pouvez envoyer vos résultats pour enrichir la base de données communautaire.

---

## Sommaire

1. [Comment ça marche](#comment-ça-marche)
2. [Envoyer ses résultats](#envoyer-ses-résultats)
3. [Token GitHub (PAT)](#token-github-pat)
4. [Classement consolidé](#classement-consolidé)
5. [Télémétrie anonyme](#télémétrie-anonyme)
6. [Tableau de bord (propriétaire)](#tableau-de-bord-propriétaire)
7. [Confidentialité](#confidentialité)

---

## Comment ça marche

```
Votre machine                          Dépôt GitHub (cisco-03/BenchGo-LLM-School)
┌─────────────┐                       ┌──────────────────────────────┐
│ node runner │  --submit             │  submissions/                │
│   .carnet/  │ ──────────────────►   │    <userId>/                 │
│  modele.json │   Pull Request       │      modele.json             │
└─────────────┘                       │  ──────────────────────────  │
                                      │  GitHub Action               │
                                      │  consolidate-leaderboard.js  │
                                      │         ▼                    │
                                      │  community-leaderboard.html  │
                                      │  (publié sur GitHub Pages)   │
                                      └──────────────────────────────┘
```

1. Vous testez un modèle avec `node runner.js`.
2. À la fin du run, BenchGo vous propose d'envoyer votre carnet de scores.
3. Une **Pull Request** est créée automatiquement sur le dépôt communautaire.
4. Le propriétaire du dépôt **valide (merge)** la PR.
5. Une **GitHub Action** reconstruit automatiquement le classement consolidé.
6. Le classement consolidé est publié sur **GitHub Pages**, visible par tous.

---

## Envoyer ses résultats

### Méthode interactive (recommandée)

### Soumettre depuis le classement interactif (recommandé)

Le moyen le plus simple : ouvrez le classement local dans le navigateur, puis
cliquez sur le bouton violet **« 🌐 Envoyer à la communauté »**.

```bash
node leaderboard.js --serve
```

Le navigateur s'ouvre → cliquez sur **« 🌐 Envoyer à la communauté »** →
collez votre token GitHub → entrez un pseudo (optionnel) → cliquez
**« Vérifier et envoyer »**.

### Détection automatique des nouveaux modèles

**BenchGo ne soumet que les modèles pas encore envoyés sur GitHub.** Au moment
de la soumission, l'application interroge le dépôt pour connaître la liste des
modèles déjà présents sous votre identifiant. Les modèles déjà soumis sont
**ignorés automatiquement** — seuls les nouveaux sont envoyés.

Exemple :
- Vous avez 100 modèles en local, 80 déjà soumis sur GitHub → seuls 20 PRs seront créées.
- Vous testez 5 nouveaux modèles → relancez la soumission → seules 5 PRs seront créées.
- Vous n'avez aucun nouveau modèle → le bouton affiche « Aucun nouveau modèle ».

**Il n'est donc pas nécessaire de se souvenir de ce qui a déjà été envoyé.**
Cliquez simplement sur « Envoyer à la communauté » à chaque fois que vous voulez
partager de nouveaux résultats : l'application fait le tri toute seule.

### Méthode interactive (en fin de run)

Lancez simplement un benchmark complet :

```bash
node runner.js
```

À la fin du run, BenchGo vous demandera si vous souhaitez envoyer vos résultats.
Répondez « o » et suivez les instructions (token GitHub + pseudo optionnel).

### Méthode forcée (non-interactive)

```bash
node runner.js --submit --github-token=ghp_xxxxxxxxxxxx
```

Avec `--submit`, la proposition de soumission est automatique (sans confirmation).
Le token peut être fourni via `--github-token=` ou mémorisé localement (voir ci-dessous).

### Soumettre sans relancer un benchmark

Si vous avez déjà testé un modèle et voulez juste soumettre le carnet existant :

```bash
node runner.js --submit --model=<nom_du_modele>
```

> Note : le carnet doit exister dans `Export-Rapports/.carnet/<modele>.json`.

---

## Token GitHub (PAT)

Pour créer une Pull Request via l'API GitHub, BenchGo a besoin d'un **Personal
Access Token (PAT)** avec le scope `repo`.

### Créer un token

1. Allez sur https://github.com/settings/tokens
2. Cliquez « Generate new token (classic) »
3. Cochez uniquement le scope **`repo`** (accès lecture/écriture aux dépôts)
4. Donnez un nom (ex: « BenchGo Community Submit ») et une expiration
5. Copiez le token (il commence par `ghp_`)

### Mémorisation

À la première soumission, BenchGo propose de mémoriser le token localement dans
`.benchgo-profile.json` (fichier ignoré par git, jamais commité). Ainsi, les
prochaines soumissions se feront sans re-saisir le token.

Pour effacer le token mémorisé :

```bash
# Supprimer manuellement le fichier, ou éditer .benchgo-profile.json
# et supprimer la clé "githubToken".
```

---

## Classement consolidé

Le classement consolidé est la fusion des résultats de tous les contributeurs.
Il est disponible sur GitHub Pages à l'adresse :

```
https://cisco-03.github.io/BenchGo-LLM-School/community-leaderboard.html
```

Si plusieurs utilisateurs ont testé le même modèle, le classement consolidé :

- Garde la **meilleure soumission** (pourcentage le plus élevé)
- Affiche le **nombre de contributeurs** (« testé par N personnes »)
- Attribue les résultats au **pseudo** (si renseigné) ou reste anonyme

---

## Télémétrie anonyme

Pour permettre au propriétaire du projet de savoir combien de personnes utilisent
BenchGo, une requête anonyme est envoyée **une fois par jour** vers le dépôt GitHub.

- **Aucune donnée personnelle** n'est transmise (pas d'IP, pas de nom, pas de modèle).
- Le seul identifiant envoyé est un **hash aléatoire** généré localement, permettant
  d'estimer le nombre d'utilisateurs uniques.
- Cette requête incrémente le compteur de vues du dépôt (GitHub Insights → Traffic).

### Désactiver la télémétrie

```bash
node runner.js --no-telemetry
```

Cette commande désactive la télémétrie **définitivement** (enregistrée dans
`.benchgo-profile.json`). Pour la réactiver, supprimez la clé `telemetry` du
fichier de profil ou passez `--no-telemetry` inverse (relancez sans le flag après
avoir édité `.benchgo-profile.json`).

---

## Tableau de bord (propriétaire)

Le propriétaire du dépôt peut consulter les statistiques d'utilisation avec :

```bash
node community-stats.js --token=ghp_xxxxx
```

Ou via une variable d'environnement :

```bash
set GITHUB_TOKEN=ghp_xxxxx
node community-stats.js
```

Cela affiche :

- ⭐ Étoiles, forks, watchers
- 👁 Vues uniques (14 derniers jours) avec graphique
- 📥 Clones uniques (14 derniers jours)
- 📦 Soumissions mergées (nombre de carnets + d'utilisateurs)
- ⏳ Pull Requests communautaires en attente de validation

---

## Confidentialité

| Donnée | Stockée où | Commitée sur GitHub ? |
|---|---|---|
| Carnet de scores | `Export-Rapports/.carnet/` | Non (gitignore) |
| Token GitHub | `.benchgo-profile.json` | Non (gitignore) |
| Pseudo public | `.benchgo-profile.json` | Non (gitignore) |
| userId anonyme | `.benchgo-profile.json` | Non (gitignore) |
| Carnet soumis | `submissions/<userId>/` | Oui (via PR) |
| Pseudo (si soumis) | Dans le fichier de soumission | Oui (via PR) |

Le `userId` est un hash aléatoire de 16 caractères hexadécimaux, généré une seule
fois et stocké localement. Il permet de regrouper vos soumissions sous un même
dossier mais **ne permet pas de vous identifier**.

Si vous souhaitez soumettre de façon **totalement anonyme**, ne renseignez pas de
pseudo — seul le `userId` (hash aléatoire) apparaîtra dans le classement consolidé.