# Commandes BenchGo V3

Ce chapitre liste toutes les commandes utiles pour l utilisateur.

## Syntaxe generale

```powershell
node runner.js [tier|all] [--profile=LIGHT|STANDARD|EXPERT] [--context-limit=N]
```

- tier: 0, 1, 2, 3
- all: execute tous les tiers applicables au profil
- --profile: force un profil
- --context-limit: fixe la fenetre de contexte estimee (tokens)

## Commandes principales

### Lancer tous les tiers (auto-detection profil)

```powershell
node runner.js
```

ou

```powershell
node runner.js all
```

### Lancer un tier precis

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
```

### Combiner tier + profil

```powershell
node runner.js 2 --profile=EXPERT
```

### Definir un budget contexte

```powershell
node runner.js all --context-limit=16384
node runner.js all --profile=STANDARD --context-limit=32768
```

## Comment choisir les commandes

- Vous debutez: utilisez node runner.js
- Vous comparez des modeles: utilisez node runner.js all --profile=STANDARD
- Vous testez un correctif sur une zone precise: utilisez node runner.js 2
- Vous avez un grand modele: utilisez node runner.js all --profile=EXPERT

## Comportements automatiques importants

- Si --profile est absent: detection automatique via l API LM Studio /v1/models
- Si detection impossible: fallback sur STANDARD
- Si profil inconnu passe en CLI: fallback sur STANDARD avec warning
- Si session non interactive: pas de rattrapage (question utilisateur desactivee)

## Rattrapage interactif

Pour LIGHT et STANDARD, si un tier echoue, le systeme peut proposer:

- Voulez-vous lancer une seance de rattrapage pour le Tier X ? [o/N]

Regles:
- au maximum 1 rattrapage par tier
- le meilleur score entre tentative 1 et tentative 2 est conserve

## Exemple de session complete

Note:
- BenchGo est en V3.
- Le dossier d execution garde le nom `benchmark-v2` (nom technique historique).

```powershell
cd benchmark-v2
node runner.js all --profile=STANDARD --context-limit=16384
```

Resultat attendu:
- progression par tier
- score final global + obligatoire
- verdict
- rapport Markdown sauvegarde

## Reference complete (copier-coller direct)

> Les commandes ci-dessous utilisent le chemin complet `benchmark-v2/runner.js`
> et sont executees depuis la racine du projet (`Local-LLM-Benchmark-V3`).
> Si vous etes deja dans le dossier `benchmark-v2`, retirez le prefixe `benchmark-v2/`
> (ex: `node runner.js all --profile=STANDARD`).

### Sans profil = auto-detection LM Studio (fallback STANDARD)

```powershell
node benchmark-v2/runner.js
node benchmark-v2/runner.js all
node benchmark-v2/runner.js 0
node benchmark-v2/runner.js 1
node benchmark-v2/runner.js 2
node benchmark-v2/runner.js 3
```

### Profil LIGHT (modeles < 3B)

```powershell
node benchmark-v2/runner.js all --profile=LIGHT
node benchmark-v2/runner.js 0 --profile=LIGHT
node benchmark-v2/runner.js 1 --profile=LIGHT
node benchmark-v2/runner.js 2 --profile=LIGHT
node benchmark-v2/runner.js 3 --profile=LIGHT
```

### Profil STANDARD (modeles 3B - 14B)

```powershell
node benchmark-v2/runner.js all --profile=STANDARD
node benchmark-v2/runner.js 0 --profile=STANDARD
node benchmark-v2/runner.js 1 --profile=STANDARD
node benchmark-v2/runner.js 2 --profile=STANDARD
node benchmark-v2/runner.js 3 --profile=STANDARD
```

### Profil EXPERT (modeles > 14B)

```powershell
node benchmark-v2/runner.js all --profile=EXPERT
node benchmark-v2/runner.js 0 --profile=EXPERT
node benchmark-v2/runner.js 1 --profile=EXPERT
node benchmark-v2/runner.js 2 --profile=EXPERT
node benchmark-v2/runner.js 3 --profile=EXPERT
```
