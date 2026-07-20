# Système de Gamification et de Santé Globale (BenchGo V3)

> Ce document couvre la **Santé Globale (PV)** et l'**élimination**. Pour le calcul
> complet des **points** (par exercice, classe, école, cumul multi-écoles, bonus
> optionnel, sans-faute, diplôme, notes A–F), voir
> [`systeme-points.md`](./systeme-points.md).

Le système de notation de BenchGo V3 est conçu pour émuler un "Professeur" évaluant ses élèves de manière humaine, équitable, mais exigeante.

## 1. La Santé Globale (Le Buffer de Survie)
Chaque modèle commence l'évaluation avec un score de **Santé Globale** de `0`.
Ce score est persistant à travers tous les "Tiers" (classes).

- **Gain de points :** Lorsqu'un modèle réussit un exercice, il gagne entre **30 et 60 points** (attribués aléatoirement selon la difficulté ressentie de l'exercice). Ces points s'ajoutent à sa Santé Globale.
- **Perte de points :** Lorsqu'il échoue à un exercice ou produit un code syntaxiquement incorrect, les points de cet exercice sont **soustraits** de sa Santé Globale. Une pénalité forfaitaire de `-35 points` s'applique également s'il répond de manière inexploitable.
- **Le Couperet (-100) :** Si, au fil de ses échecs, la Santé Globale du modèle atteint ou descend en dessous de `-100`, **le test s'arrête immédiatement**. Le modèle est éliminé définitivement pour "trop d'échecs répétés".

### Pourquoi ce système ?
L'objectif est d'être clément envers les modèles qui démarrent bien : si un modèle excelle au Tier 0 et accumule +250 points de Santé, il s'achète le droit à l'erreur pour les Tiers supérieurs. Il pourra rater 3 ou 4 exercices difficiles sans être éliminé, reflétant son mérite initial. À l'inverse, un modèle qui échoue en boucle dès la première classe sera très vite expulsé.

## 2. Score de Tier et Validation de Classe
Contrairement à la Santé Globale qui persiste, le **Score de Tier** est réinitialisé à `0` au début de chaque Tier (ou à chaque rattrapage).

Pour qu'un Tier (Classe) soit considéré comme **Validé**, le modèle doit obtenir au moins **70% des points totaux mis en jeu** dans cette classe. S'il n'atteint pas ce seuil, le Tier est considéré comme "Échoué".

### Modes Obligatoire vs Optionnel
- Si un Tier est défini comme **OBLIGATOIRE** pour le profil du modèle et qu'il échoue, l'évaluation complète s'arrête (Erreur Fatale).
- Si le Tier est **OPTIONNEL**, l'évaluation passe simplement à la classe suivante, sans arrêter le benchmark complet.

## 3. Axes d'Évaluation Avancés (Tier 6 - Doctorat)
En plus du système de points classique, l'évaluation intègre désormais de nouveaux critères stricts :
- **Vitesse & Verbosité :** Un modèle lent ou bavard (ratio code / blabla trop faible) recevra des pénalités sur son score.
- **Optimisation (Exécution) :** Les algorithmes sont chronométrés. S'ils dépassent un temps limite d'exécution dans la Sandbox, ils sont considérés en échec (ex: boucle `O(n²)` sur une consigne de recherche optimisée).
- **Contraintes et Robustesse :** Certains exercices intègrent des "Prompt Injections" ou l'interdiction de méthodes natives (ex: `Array.prototype.sort`). Un modèle qui ne respecte pas les consignes à la lettre sera sanctionné sévèrement.
