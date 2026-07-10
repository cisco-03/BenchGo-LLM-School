# Manuel utilisateur BenchGo V3

Ce dossier contient la documentation utilisateur complete pour lancer et exploiter le benchmark local des LLM.

Note de compatibilite:
- BenchGo est en version V3.
- Le dossier d execution conserve le nom historique `benchmark-v2`.

## Parcours recommande

1. Commencer par [01-demarrage-rapide.md](01-demarrage-rapide.md)
2. Consulter [02-commandes.md](02-commandes.md)
3. Comprendre le moteur dans [03-fonctionnement-benchmark.md](03-fonctionnement-benchmark.md)
4. Lire les scores et verdicts dans [04-lecture-resultats.md](04-lecture-resultats.md)
5. Resoudre les incidents avec [05-depannage.md](05-depannage.md)
6. Voir le detail des epreuves dans [06-reference-tiers.md](06-reference-tiers.md)

## Public cible

- Utilisateurs qui veulent evaluer un modele local via LM Studio
- Equipes qui veulent comparer plusieurs modeles sur une base comportementale
- Utilisateurs non developpeurs qui ont besoin de comprendre le verdict final

## Ce que vous obtenez a la fin d un run

- Un rapport Markdown complet en racine du projet
- Un fichier de logs horodate dans benchmark-v2/logs
- Un score global, un score obligatoire, une note A-F, et un verdict
