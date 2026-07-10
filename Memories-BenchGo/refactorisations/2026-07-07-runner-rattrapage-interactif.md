# Refactorisation — 2026-07-07

## Probleme initial
Le flux d'execution de `runner.js` ne permettait qu'une seule tentative par tier et ne separait pas
clairement l'execution d'un tier de l'orchestration globale.

## Motivation
Ajouter une seance de rattrapage interactive (LIGHT/STANDARD) sans dupliquer la logique et en
conservant un controle clair du score retenu.

## Solution
Refactorisation de `benchmark-v2/runner.js`:
- extraction de l'execution d'un tier dans `runTierAttempt(...)`
- ajout de `askYesNo(...)` pour l'interaction console
- ajout de `shouldReplaceBestResult(...)` pour retenir le meilleur score des tentatives
- orchestration des tentatives dans la boucle principale avec un maximum de 1 rattrapage

## Resultats
| Metrique | Avant | Apres |
|----------|-------|-------|
| Tentatives par tier | 1 fixe | 1 + 1 rattrapage (LIGHT/STANDARD) |
| Interaction utilisateur | Aucune | Question oui/non en cas d'echec |
| Selection du score final | N/A | Meilleure tentative retenue |

## Validation
- Verification syntaxique Node (`node --check`) sur `runner.js`
- Verification static errors VS Code: aucune erreur sur les fichiers modifies

## Risques
- En mode non interactif (CI), le rattrapage ne peut pas etre propose (comportement volontaire)
- L'heuristique tokens (~4 chars/token) reste une approximation
