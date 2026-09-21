# Reference des tiers et epreuves

Cette page donne une vue utilisateur des competences testees.

## Exercices de specialite

Chaque tier (a partir du Tier 0) embarque des **exercices de specialite** en
plus des taches classiques. Chacun est rattache a un langage du pre-examen
RunCode via un champ interne : le mode `--flash` s'en sert pour cibler la
specialite declaree par le professeur (voir
[03-fonctionnement-benchmark.md](03-fonctionnement-benchmark.md#exercices-de-specialite-grande-ecole)).

Tier 0 (Primaire) : 8 exercices de specialite — FizzBuzz (divisibilite),
comptage de voyelles, palindrome, factorielle, anagrammes, nombre premier,
Fibonacci iteratif, fusion de tableaux tries.

Tier 0 (6eme, STANDARD) : 8 exercices — somme des chiffres, capitalisation
de mots, puissance sans operateur, annee bissextile, frequence des mots,
inversion de mots, deuxieme plus grand, chaine la plus longue.

Tier 1 (5eme, STANDARD) : 8 exercices — racine numerique, inversion sans
reverse(), jointure simplifiee, moyenne avec reduce(), tri de mots, filtrage
des valeurs nulles, deux-nombres-qui-somment, tri par selection.

Tier 2 (4eme, STANDARD) : 8 exercices — conversion binaire, groupage par
parite, doublons consecutifs, compression RLE, aplatissement recursif, mots
uniques, PGCD (Euclide), inversion d'entier.

Ce sont des classiques publics (documentes sur des sources web officielles).
Les corriges ne sont JAMAIS envoyes au modele : seul le professeur les connait
(coffre-fort secret).

## Tier 0 - Integration DOM et syntaxe JS

Objectif:
- valider les bases JS/DOM et hygiene securite minimale

Epreuves:
- structure HTML5 semantique
- basculement de classe CSS active
- parsing JSON robuste avec try/catch
- debogage: correction recherche de maximum
- securite: insertion anti-XSS via textContent

## Tier 1 - Structures de donnees et typage

Objectif:
- valider transformation de donnees et typage

Epreuves:
- GeoJSON conforme RFC 7946
- interface TypeScript NetworkDeviceConfig
- limiteur Python de consecutifs
- debogage: dedoublonnage correct
- securite: echappement HTML anti-XSS

## Tier 2 - Frameworks et logique avancee

Objectif:
- valider React, logique par pile et async intermediaire

Epreuves:
- hook React avec cleanup et exposition propre de l instance
- validation parentheses/crochets/accolades par pile
- composant React conditionnel (NotificationBanner)
- async avance: Promise.allSettled et erreurs partielles
- debogage async: correction forEach + async

## Tier 3 - Securite systeme et algorithmes complexes

Objectif:
- valider scenarios experts securite + algo + middleware

Epreuves:
- script PowerShell avec rollback
- flood fill robuste (matrices non carrees + cas limite)
- middleware Cloudflare Worker avec authorization
- prevention injection SQL par requete parametree
- logique de retry async avec abandon propre
- debogage securite: protection contre prototype pollution

## Épreuve Finale - Expertise et résistance

Objectif:
- valider la résistance ultime (logique, optimisation, mémoire, robustesse)

Cette épreuve est partagée par plusieurs écoles (STANDARD en optionnel, EXPERT en
optionnel, DOCTORAT et FRONTIER en obligatoire). Elle correspond au fichier
`tiers/tier6_master.json` (tier physique 6).

Epreuves:
- tri imposé sans utiliser Array.prototype.sort()
- memoire longue (rappel d'une variable cachee dans un long texte)
- robustesse face aux cas limites et aux contraintes strictes

## Numérotation des classes

Chaque école répartit ses épreuves en classes numérotées de 0 à N de façon **continue**
(0, 1, 2, 3, 4...). Le numéro affiché dans le CLI, les rapports et les dossiers d'export
est le numéro de classe logique, pas le numéro du fichier de tier sous-jacent.

Les fichiers de tiers (`tiers/tier{N}_*.json`) portent un numéro physique qui peut
présenter des trous (le tier 6 est l'épreuve finale partagée). Ces trous sont masqués
à l'utilisateur : EXPERT utilise les tiers 0,1,2,3 puis 6, affichés comme classes
0, 1, 2, 3, 4.

## Correspondance classes selon profil

- LIGHT: classes 0 et 1 obligatoires (2 a 5 optionnelles)
- STANDARD: classes 0, 1, 2 obligatoires (3 a 6 optionnelles)
- EXPERT: classes 0, 1, 2, 3 obligatoires (classe 4 = Épreuve Finale optionnelle)
- DOCTORAT: classes 0, 1, 2, 3, 4 obligatoires (classe 4 = Épreuve Finale)
- FRONTIER: classes 0, 1, 2, 3, 4 obligatoires (classe 5 = Épreuve Finale)

Les classes optionnelles peuvent etre bypasses sans penaliser le score obligatoire.
