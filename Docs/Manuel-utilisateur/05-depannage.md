# Depannage

## Probleme 1: erreur API LM Studio

Symptomes:
- message erreur API
- echec immediat sur classe obligatoire

Actions:
1. Verifier que LM Studio est lance
2. Verifier qu un modele est charge
3. Verifier que l API locale ecoute sur le port 1234
4. Relancer la commande

## Probleme 2: timeout trop long

Symptomes:
- timeout apres delai

Actions:
1. Tester un profil inferieur (LIGHT ou STANDARD)
2. Reduire la charge en lancant une seule classe
3. Verifier les performances machine

Commandes utiles:

```powershell
node runner.js 0
node runner.js all --profile=LIGHT
```

## Probleme 3: prompt trop long pour le contexte

Symptome:
- erreur indiquant prompt trop long pour le budget contexte

Action:
- augmenter --context-limit si votre runtime le supporte

Exemple:

```powershell
node runner.js all --context-limit=32768
```

## Probleme 4: pas de rattrapage declenche

Le rattrapage est **automatique** (plus de confirmation manuelle). Il se déclenche
si l'un de ces 3 critères est rempli à la fin de l'examen :
1. une classe **obligatoire** a échoué
2. la santé globale de l'élève est < 0 PV
3. ≥ 40 % des exercices ont échoué

Si aucun critère n'est rempli, l'élève s'en sort bien et aucun rattrapage n'a lieu
(comportement normal). Le rattrapage est aussi désactivé en mode cloud (coût par appel)
et pour les profils FRONTIER.

## Probleme 5: profil inattendu

Cas:
- nom du modele non standard
- detection de taille impossible

Comportement normal:
- fallback automatique sur STANDARD

Solution:
- forcer explicitement le profil

```powershell
node runner.js all --profile=EXPERT
```

## Probleme 6: rapport introuvable

Rappel:
- le rapport est généré dans `Export-Rapports/` (organisé par date et profil)

Chercher les fichiers dans :
- `Export-Rapports/<AAAA-MM-JJ>/<PROFIL>/rapport_*.md`

## Probleme 7: comprendre un echec de tache

Methode recommandee:
1. Lire la tache concernee dans le rapport Markdown
2. Lire le message d erreur dans la section evaluation
3. Ouvrir le dernier fichier de `logs/` pour le detail VM/PARSE/API

## Bonnes pratiques

- lancer depuis la racine du projet (le dossier contenant `runner.js`)
- garder LM Studio stable pendant tout le run
- eviter de changer le modele en cours d execution
- archiver rapport + log ensemble pour chaque campagne
