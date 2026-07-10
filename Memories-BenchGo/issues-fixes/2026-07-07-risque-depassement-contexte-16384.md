# 2026-07-07 — Risque de depassement de contexte (16384)

## Symptome
Risque de depassement de fenetre de contexte quand la combinaison prompt + reponse potentielle
s'approche ou depasse la limite LM Studio (16384 tokens).

## Cause racine
Le client API n'appliquait pas de budget de contexte explicite:
- pas de limite de sortie dynamique (`max_tokens`)
- pas de verification prealable du volume d'entree estime

## Solution
Mise en place d'un garde-fou dans `benchmark-v2/lm-studio-client.js`:
- estimation des tokens d'entree (heuristique stable: ~4 caracteres/token)
- calcul du budget de sortie maximal autorise
- envoi de `max_tokens` au serveur
- erreur explicite si l'entree est deja trop proche de la limite

Ajout du parametre CLI `--context-limit` dans `benchmark-v2/config.js`, relaye dans
`benchmark-v2/runner.js` (defaut: 16384).

## Fichiers modifies
- benchmark-v2/lm-studio-client.js
- benchmark-v2/config.js
- benchmark-v2/runner.js

## Validation
- `node --check benchmark-v2/runner.js`
- `node --check benchmark-v2/lm-studio-client.js`
- `node --check benchmark-v2/config.js`
- Verification des erreurs VS Code: aucune erreur sur les fichiers modifies.

## Lecons apprises
Les limites de contexte doivent etre traquees explicitement dans les appels LLM. Le budget de
sortie ne doit jamais etre laisse implicite lorsque la fenetre du modele est contrainte.
