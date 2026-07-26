# Commandes BenchGo V3

Ce chapitre liste toutes les commandes utiles pour l'utilisateur.

## Syntaxe générale

```powershell
node runner.js [tier|all] [--profile=LIGHT|STANDARD|EXPERT|DOCTORAT|FRONTIER] [--context-limit=N]
```

- `tier` : numéro de tier physique (0, 1, 2, 3, et 6 pour l'Épreuve Finale partagée). Le runner affiche ensuite le numéro de classe logique correspondant au profil (ex: le tier 6 s'affiche comme classe 4 en EXPERT). Voir `06-reference-tiers.md` pour la correspondance.
- `all` : exécute toutes les classes applicables au profil
- `--profile` : force un profil
- `--context-limit` : fixe la fenêtre de contexte estimée (tokens)

## Commandes principales

### Lancer tous les tiers (auto-détection profil)

```powershell
node runner.js
```

ou

```powershell
node runner.js all
```

### Lancer un tier précis

```powershell
node runner.js 0
node runner.js 1
node runner.js 2
node runner.js 3
node runner.js 6
```

> Le numéro passé correspond au fichier de tier (`tiers/tier{N}_*.json`). L'affichage
> montre la classe logique (continue) du profil.

### Forcer un profil

```powershell
node runner.js all --profile=LIGHT
node runner.js all --profile=STANDARD
node runner.js all --profile=EXPERT
node runner.js all --profile=DOCTORAT
```

### Combiner tier + profil

```powershell
node runner.js 2 --profile=EXPERT
```

### Définir un budget contexte

```powershell
node runner.js all --context-limit=16384
node runner.js all --profile=STANDARD --context-limit=32768
```

## Comment choisir les commandes

- Vous débutez : `node runner.js`
- Vous comparez des modèles : `node runner.js all --profile=STANDARD`
- Vous testez un correctif sur une zone précise : `node runner.js 2`
- Vous avez un grand modèle : `node runner.js all --profile=EXPERT`
- Vous avez un modèle cloud : `node runner.js all --provider=openai --model=gpt-4o`

## Comportements automatiques importants

- Si `--profile` est absent : détection automatique via l'API LM Studio `/v1/models`
- Si la détection est impossible : fallback sur `STANDARD`
- Si un profil inconnu est passé en CLI : fallback sur `STANDARD` avec warning
- Si la session n'est pas interactive : pas de rattrapage (question utilisateur désactivée)

## Rattrapage automatique

Pour LIGHT, STANDARD et EXPERT (profils éligibles), une séance de rattrapage
automatique est proposée en fin d'examen si l'un de ces critères est rempli :

1. une classe **obligatoire** a échoué
2. la santé globale de l'élève est négative (< 0)
3. au moins 40 % des exercices ont échoué

Règles :
- au maximum 1 rattrapage par classe
- le meilleur score entre tentative 1 et tentative 2 est conservé
- aucune question manuelle : le rattrapage est déclenché automatiquement

## Exemple de session complète

Depuis la racine du projet (le dossier qui contient `runner.js`) :

```powershell
node runner.js all --profile=STANDARD --context-limit=16384
```

Résultat attendu :
- progression par classe
- score final global + obligatoire
- verdict
- rapport Markdown sauvegardé dans `Export-Rapports/`

## Référence complète (copier-coller direct)

> Les commandes ci-dessous sont exécutées depuis la racine du projet
> (le dossier contenant `runner.js`).

### Sans profil = auto-détection LM Studio (fallback STANDARD)

```powershell
node runner.js
node runner.js all
node runner.js 0
node runner.js 1
node runner.js 2
node runner.js 3
```

### Profil LIGHT (modèles < 3B)

```powershell
node runner.js all --profile=LIGHT
node runner.js 0 --profile=LIGHT
node runner.js 1 --profile=LIGHT
node runner.js 2 --profile=LIGHT
node runner.js 3 --profile=LIGHT
```

### Profil STANDARD (modèles 3B – 14B)

```powershell
node runner.js all --profile=STANDARD
node runner.js 0 --profile=STANDARD
node runner.js 1 --profile=STANDARD
node runner.js 2 --profile=STANDARD
node runner.js 3 --profile=STANDARD
```

### Profil EXPERT (modèles 14B – 30B)

```powershell
node runner.js all --profile=EXPERT
node runner.js 0 --profile=EXPERT
node runner.js 1 --profile=EXPERT
node runner.js 2 --profile=EXPERT
node runner.js 3 --profile=EXPERT
```

### Classement (leaderboard)

```powershell
# Régénérer les 3 fichiers de classement (HTML + MD + raisonnement)
node leaderboard.js

# Mode interactif (serveur web sur http://localhost:3939)
node leaderboard.js --serve
```

À chaque génération, le CLI affiche aussi la **liste des modèles LM Studio non
testés** (jamais testés + partiels) juste après le tableau de classement. Cela
évite de faire des va-et-vient entre le CLI et LM Studio pour savoir quels
modèles restent à tester. Colonne « Écoles manquantes » : les niveaux scolaires
encore à passer pour ce modèle. Astuce finale pointe vers `node night-batch.js`.

### Communauté & soumission de résultats

```powershell
# Soumettre ses résultats au classement communautaire (en fin de run)
node runner.js --submit

# Soumettre avec un token GitHub fourni (non-interactif)
node runner.js --submit --github-token=ghp_xxxxxxxxxxxx

# Désactiver la télémétrie anonyme (ping compteur d'utilisateurs)
node runner.js --no-telemetry

# Désactiver l'avis de mise à jour disponible au démarrage (comparaison SHA local vs GitHub)
node runner.js --no-update-check
```

> 📖 Voir le [chapitre 8 — Communauté & classement participatif](./08-communaute.md)
> pour le détail complet (token GitHub, détection des nouveaux modèles, etc.)

---

## Avis de mise à jour disponible

Au démarrage du runner et dans le classement local (`classement.html`), BenchGo
compare automatiquement le SHA de votre commit local avec le dernier commit
poussé sur la branche `main` du dépôt GitHub. Si une nouveauté ou une correction
a été publiée, une **bannière visuelle** s'affiche :

- **CLI** : bannière jaune avec les 5 derniers commits distants (date + message)
  et la commande à exécuter (`git pull`).
- **Classement local** : bannière animée (pulse) sous l'en-tête, avec aperçu des
  changements et bouton ✕ pour masquer 1h.

Cette vérification est **anonyme** (API GitHub publique, aucun token requis,
aucune donnée personnelle transmise) et **mise en cache 1h** pour ne pas spammer
l'API. En cas d'échec réseau, aucun avis ne s'affiche (échec silencieux).