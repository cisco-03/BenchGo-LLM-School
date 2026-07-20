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

L'echelle est calculee sur le pourcentage (code `letterGrade` dans `progress-bar.js`).
C'est un seuillage descendant : chaque palier est >= sa valeur, donc A prime sur B, etc.

- A : >= 90%
- B : >= 80%
- C : >= 70%
- D : >= 60%
- F : < 60%

> Note : une ancienne version de ce manuel donnait une echelle incorrecte
> (A>=90 / B=70-89 / C=50-69 / D=30-49 / F<30). Les seuils ci-dessus sont les
> seuils reels du code (corriges le 2026-07-20). Voir aussi
> [Système de points](../Apps-Fonctions/systeme-points.md) pour le calcul
> complet (points par exercice, classe, ecole et cumul multi-ecoles).

## Regle du verdict

Le verdict s'appuie sur le **pourcentage obligatoire** s'il y a des tiers
obligatoires pour le profil, sinon sur le pourcentage global :

- >= 80% : MODELE RECOMMANDE
- 50-79% : MODELE PARTIEL - RESERVES
- < 50% : MODELE NON RECOMMANDE

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
