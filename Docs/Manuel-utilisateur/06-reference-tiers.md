# Reference des tiers et epreuves

Cette page donne une vue utilisateur des competences testees.

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

## Correspondance tiers selon profil

- LIGHT: tiers 0 et 1 obligatoires
- STANDARD: tiers 0, 1, 2 obligatoires
- EXPERT: tiers 0, 1, 2, 3 obligatoires

Les tiers optionnels peuvent etre bypasses sans penaliser le score obligatoire.
