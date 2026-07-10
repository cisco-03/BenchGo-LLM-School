# Lire les resultats

## Ecran final

A la fin du run, vous obtenez:
- Score global
- Score obligatoire
- Note globale (A a F)
- Note obligatoire (A a F)
- Verdict

## Difference entre score global et score obligatoire

- Score global: toutes les evaluations executees
- Score obligatoire: uniquement les tiers obligatoires pour le profil

Le score obligatoire est la reference principale pour juger le modele.

## Echelle de notes

- A: >= 90%
- B: 70-89%
- C: 50-69%
- D: 30-49%
- F: < 30%

## Regle du verdict

- >= 80% obligatoire: MODELE RECOMMANDE
- 50-79% obligatoire: MODELE PARTIEL - RESERVES
- < 50% obligatoire: MODELE NON RECOMMANDE

## Lecture des resultats par tier

Chaque tier affiche:
- un tableau des taches
- score tache par tache
- note tache
- etat du tier (reussi/echecs)

## Rapport Markdown genere

Le rapport contient:
- recap profil/date/modele
- detail de chaque tache
- code produit par le modele
- details des evaluations pass/fail
- sortie brute API (section repliable)
- tableau final score + note + verdict

## Nommage des rapports

Format:

- rapport_v3_nommodele_profil.md
- rapport_v3_nommodele_profil_tierX.md (si vous ciblez un tier unique)

Le nom du modele est nettoye automatiquement pour rester compatible fichier.

## Logs: a quoi ils servent

Le fichier de logs enregistre notamment:
- config effective du run
- hash du prompt par tier
- duree API
- statut parsing
- resultats d evaluation
- erreurs VM detaillees

Utilisation pratique:
- comparer 2 runs
- diagnostiquer un echec
- auditer un comportement inattendu
