# Démarrage rapide

## 1. Prérequis

- Windows, macOS ou Linux
- Node.js 18+ installé (voir le [README racine](../../README.md) pour l'installation pas-à-pas)
- LM Studio lancé avec :
  - un modèle chargé
  - API locale active sur le port 1234

## 2. Ouvrir un terminal dans le dossier du projet

Depuis le dossier racine de BenchGo (celui qui contient `runner.js`) :

```powershell
# Si vous n'êtes pas encore dans le dossier :
cd chemin\vers\benchgo
```

Vérifiez que vous êtes au bon endroit :

```powershell
dir runner.js
```
Doit afficher le fichier `runner.js`.

## 3. Lancer le benchmark complet

```powershell
node runner.js all
```

Cette commande :
- lance tous les tiers applicables
- tente la détection automatique du profil si vous ne forcez pas `--profile`
- crée un rapport Markdown final
- crée un log persistant

## 4. Vérifier les sorties

- **Rapport Markdown** : dans `Export-Rapports/`, organisé par date et profil
- **Logs** : dossier `logs/` à la racine du projet, un fichier horodaté par run

## 5. Lancer un seul tier (exemple)

```powershell
node runner.js 2
```

Utile pour :
- debug rapide
- validation ciblée
- rerun après correction

## 6. Si vous voulez forcer le profil

```powershell
node runner.js all --profile=STANDARD
```

Profils disponibles :
- LIGHT      (< 3B)
- STANDARD   (3B – 14B)
- EXPERT     (14B – 30B)
- DOCTORAT   (> 30B)
- FRONTIER   (modèles cloud)