# Demarrage rapide

## 1. Prerequis

- Windows, macOS ou Linux
- Node.js 18+ installe
- LM Studio lance avec:
  - un modele charge
  - API locale active sur le port 1234

## 2. Ouvrir un terminal dans le bon dossier

Depuis la racine du projet:

Note importante:
- Le projet est bien en version V3.
- Le dossier d execution conserve le nom historique `benchmark-v2` pour compatibilite.

```powershell
cd benchmark-v2
```

## 3. Lancer le benchmark complet

```powershell
node runner.js
```

Cette commande:
- lance tous les tiers applicables
- tente la detection automatique du profil si vous ne forcez pas --profile
- cree un rapport Markdown final
- cree un log persistant

## 4. Verifier les sorties

- Rapport: a la racine du projet, nomme comme:
  - rapport_v3_nom-modele_standard.md
  - rapport_v3_nom-modele_expert.md
- Logs: dossier benchmark-v2/logs

## 5. Lancer un seul tier (exemple)

```powershell
node runner.js 2
```

Utile pour:
- debug rapide
- validation ciblee
- rerun apres correction

## 6. Si vous voulez forcer le profil

```powershell
node runner.js all --profile=STANDARD
```

Profils disponibles:
- LIGHT
- STANDARD
- EXPERT
