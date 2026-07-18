# Commandes BenchGo V3

Ce chapitre liste toutes les commandes utiles pour l'utilisateur.

## Syntaxe générale

```powershell
node runner.js [tier|all] [--profile=LIGHT|STANDARD|EXPERT|DOCTORAT|FRONTIER] [--context-limit=N]
```

- `tier` : 0, 1, 2, 3 (ou plus selon le profil)
- `all` : exécute tous les tiers applicables au profil
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
```

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

## Rattrapage interactif

Pour LIGHT et STANDARD, si un tier échoue, le système peut proposer :

- `Voulez-vous lancer une séance de rattrapage pour le Tier X ? [o/N]`

Règles :
- au maximum 1 rattrapage par tier
- le meilleur score entre tentative 1 et tentative 2 est conservé

## Exemple de session complète

Depuis la racine du projet (le dossier qui contient `runner.js`) :

```powershell
node runner.js all --profile=STANDARD --context-limit=16384
```

Résultat attendu :
- progression par tier
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