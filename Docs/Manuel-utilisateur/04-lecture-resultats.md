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
- Score obligatoire: uniquement les classes obligatoires pour le profil

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

Le verdict s'appuie sur le **pourcentage obligatoire** s'il y a des classes
obligatoires pour le profil, sinon sur le pourcentage global :

- >= 80% : MODELE RECOMMANDE
- 50-79% : MODELE PARTIEL - RESERVES
- < 50% : MODELE NON RECOMMANDE

## Lecture des resultats par classe

Chaque classe affiche:
- un tableau des taches
- score tache par tache
- note tache
- etat de la classe (reussi/echecs)

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
- rapport_v3_nommodele_profil_classeN.md (si vous ciblez une classe unique ; N est le numéro de tier physique)

Le nom du modele est nettoye automatiquement pour rester compatible fichier.

## Logs: a quoi ils servent

Le fichier de logs enregistre notamment:
- config effective du run
- hash du prompt par classe
- duree API
- statut parsing
- resultats d evaluation
- erreurs VM detaillees

Utilisation pratique:
- comparer 2 runs
- diagnostiquer un echec
- auditer un comportement inattendu

## RunCode : lire le bilan turbo

À la fin d'un examen RunCode (`node runner.js --exam-code`), l'écran affiche :

```
🏆 BILAN FINAL : <modèle>
🎓 Diplôme : CM2 (Primaire)
✅ STATUT : TERMINÉ (4/5 exercices réussis)
🌟 SPÉCIALITÉ : PYTHON (3/4 réussis, 75%)
   Verdict du professeur : Spécialité : PYTHON — ...
--- Détails par classe ---
  CP       PYTHON       ✅ (4441 ms)
  CE1      JAVASCRIPT   ✅ (6683 ms)
  ...
```

- **Diplôme** : la dernière classe validée du parcours (le parcours s'arrête au
  1er échec — un 4/5 signifie « échec en classe 5, classes suivantes non jouées »).
- **SPÉCIALITÉ** : le langage d'excellence du modèle, déterminé par le professeur
  à partir du bilan factuel (réussites par langage sur tous les tirages).
- **STATUT : EXPULSÉ** (carton rouge) : le modèle s'est déclaré « expert » dans
  un langage mais a échoué à un exercice basique dans ce langage.
- **Carnet** : « 📓 Carnet RunCode mis à jour » confirme l'enregistrement (école
  `RunCode-<parcours>`) qui compte pour le classement général. Le badge
  `⚡ RunCode · Turbo` apparaît alors sur la carte du modèle (classement HTML),
  avec la section RunCode dans la modale (parcours, diplôme, spécialité, verdict).
