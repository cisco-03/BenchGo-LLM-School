# Système de Points — Calcul, Classes, Écoles et Cumul (BenchGo V3)

Ce document décrit **précisément** comment BenchGo V3 calcule les points : par exercice,
par classe (tier), par école, et le cumul multi-écoles. Il répond aux questions :
combien de points par classe, par école, que devient un « sans-faute », et comment
s'additionnent plusieurs écoles.

> **Sources de vérité (code) :** `runner.js` (attribution, validation), `config.js`
> (`PROFILES`, `CLASSE_NAMES`, `OPTIONAL_BONUS_PCT`), `score-ledger.js` (carnet, cumul),
> `progress-bar.js` (`letterGrade`), `tiers/tier{N}_{profil}.json` (exercices).

---

## 1. Points par exercice

À chaque lancement d'un tier, **chaque exercice reçoit un nombre de points aléatoire
entre 30 et 60** (inclus), tiré uniformément :

```js
t.points = Math.floor(Math.random() * 31) + 30;   // 30 ≤ points ≤ 60
```

Conséquence : **deux runs du même modèle sur le même tier n'auront pas le même
total de points possibles**. Le nombre d'exercices est fixe, mais la valeur de
chaque exercice varie. C'est volontaire — cela évite qu'un modèle apprenne le
barème par cœur et reflète la « difficulté ressentie ».

| Issue d'un exercice | Effet sur `tierScore` | Effet sur la Santé Globale (PV) |
|---|---|---|
| **Succès** (exercice obligatoire) | `+points` | `+points` |
| **Succès** (exercice optionnel) | `+points` | `+points` **+ bonus de 20 %** (voir §4) |
| **Échec** (1ʳᵉ tentative) | `−points` | `−points` — un rattrapage est proposé |
| **Échec définitif** (après rattrapage) | `−points` validé par l'utilisateur | `−points` |
| **Réponse inexploitable** (pas de code) | `−35` (pénalité forfaitaire) | `−35` |

- `MAX_TASK_RETRIES = 1` : **un seul** rattrapage par exercice échoué.
- `MAX_RATTRAPAGE_ATTEMPTS = 1` : **un seul** rattrapage global par tier obligatoire
  échoué (profils LIGHT/STANDARD uniquement).

---

## 2. Points par classe (Tier)

Le **Score de Tier** repart de `0` à chaque tier (et à chaque rattrapage).

### Total possible d'un tier
```
totalPossiblePoints = somme des `points` de tous les exercices NON bypassés
```
Les exercices **bypassés par l'auto-profilage** (trop difficiles selon le niveau
déclaré) sont retirés du numérateur **et** du dénominateur : ils ne comptent ni
pour ni contre.

### Seuil de validation de la classe
```js
validationThreshold = Math.floor(totalPossiblePoints * 0.7)   // 70 %
```
- **`tierScore >= 70 %`** → Classe **Validée** (✓ « Tier N RÉUSSI »).
- **`tierScore < 70 %`** → Classe **Échouée** (✘ « Tier N ÉCHEC »).

### Obligatoire vs Optionnel
- **Tier obligatoire** échoué → arrêt immédiat du benchmark (Erreur Fatale), sauf
  élimination santé (voir §5).
- **Tier optionnel** échoué → on passe simplement à la classe suivante, sans
  pénalité sur le score obligatoire.

### Sans-faute sur une classe
Si le modèle valide **tous** les exercices d'un tier, `tierScore == totalPossiblePoints`
donc `tierPct = 100 %`. Il n'y a **pas de surplus au-delà de 100 % sur le score
de tier** : le plafond est le total possible. Le « sans-faute » se traduit donc
par **100 %** et la note **A**.

---

## 3. Points par école

Une **école** = un profil complet. Le **Score Global** d'une école est la somme
des scores des tiers **réellement exécutés** (obligatoires + optionnels tentés) :

```
Score Global (école)   = Σ tierScore      (sur tous les tiers exécutés)
Total Global (école)   = Σ totalPossiblePoints (sur les mêmes tiers)
Pct Global (école)     = round(Score Global / Total Global × 100)
```

Parallèlement, le **Score Obligatoire** ne somme que les tiers obligatoires du profil :

```
Score Obligatoire (école)  = Σ tierScore      (tiers obligatoires uniquement)
Total Obligatoire (école)  = Σ totalPossiblePoints (tiers obligatoires)
Pct Obligatoire (école)    = round(Score Obligatoire / Total Obligatoire × 100)
```

> Le **score obligatoire** est la référence principale pour juger un modèle :
> un modèle peut rater un optionnel sans que cela entame son score de fond.

### Nombre d'exercices par école (effectif, hors bypass)

| Profil (école) | Tiers | Exercices par tier | Total exercices |
|---|---|---|---|
| **LIGHT — Primaire** | 0 à 5 (6 tiers) | 10 | **60** |
| **STANDARD — Collège/Lycée** | 0 à 5 (6 tiers) | 10 | **60** |
| **EXPERT — Université** | 0 à 3 (4 tiers) | 10–11 | **41** |
| **FRONTIER — Post-Doc** | 4 (1 tier) | 11 | **11** |

> ⚠ Ce tableau est valable à la date de rédaction. Le nombre exact d'exercices
> par tier peut évoluer avec les fichiers `tiers/tier{N}_{profil}.json`. Le
> total de **points possibles** est, lui, **toujours aléatoire** (30–60 par
> exercice), il n'a donc pas de valeur fixe. Pour connaître le total exact
> d'un run précis, voir le rapport ou le log de ce run.

### Seuils obligatoires par profil (`config.js`)

| Profil | Tiers **obligatoires** | Tiers **optionnels** |
|---|---|---|
| LIGHT | 0, 1 | 2, 3, 4, 5 |
| STANDARD | 0, 1, 2 | 3, 4, 5, 6 |
| EXPERT | 0, 1, 2, 3 | 6 |
| DOCTORAT | 0, 1, 2, 3, 6 | — |
| FRONTIER | 0, 1, 2, 3, 4, 6 | — |

---

## 4. Bonus optionnel (le « surplus » des optionnels)

Quand un exercice **optionnel** est réussi, un **bonus de 20 %** de ses points
est ajouté :

```js
OPTIONAL_BONUS_PCT = 0.20
bonus = round(points_exercice × 0.20)
```

- Le bonus s'ajoute à la **Santé Globale (PV)** — il gonfle le buffer de survie.
- Le bonus est cumulé dans `optionalBonusTotal` et affiché à part
  (`+ N bonus opt.`).
- **Le bonus n'entre PAS dans `tierScore`** : le pct d'un tier ne dépasse jamais
  100 % via le bonus. C'est un **surplus de Santé**, pas un surplus de note.

C'est l'unique forme de « surplus » : un modèle qui réussit les optionnels se
constitue un coussin de PV supplémentaire, mais sa note de classe reste plafonnée
à 100 %.

---

## 5. Santé Globale (gamification PV)

La **Santé Globale** (`gameState.globalLifeScore`) cumule les gains/pertes à
travers **tous les tiers d'une même école**, mais elle est **réinitialisée à 0**
au passage à une nouvelle école.

- Démarre à **0** (pas à un nombre positif — le modèle « gagne » ses PV).
- +points à chaque succès, −points à chaque échec.
- **Élimination** dès que `Santé ≤ −100 PV` → arrêt immédiat, Game Over.
- Le bonus optionnel (§4) gonfle la Santé.

> Voir [`gamification-sante.md`](./gamification-sante.md) pour le détail du
> système de PV et de l'élimination.

---

## 6. Notes (A–F)

La note est calculée par `letterGrade(pct)` (`progress-bar.js`) à partir du
**pourcentage**, pas du brut de points :

```js
pct >= 90  →  A
pct >= 80  →  B
pct >= 70  →  C
pct >= 60  →  D
pct <  60  →  F
```

Deux notes sont affichées en fin de run :
- **Note globale** → basée sur `pctGlobal` (tous les tiers exécutés).
- **Note obligatoire** → basée sur `pctMandatory` (tiers obligatoires seuls),
  affichée `N/A (Optionnel)` s'il n'y a pas de tiers obligatoire.

### Verdict final (`runner.js:1602-1609`)

Le verdict s'appuie sur `verdictPct` = **`pctMandatory`** s'il y a des tiers
obligatoires, sinon `pctGlobal` :

| Verdict | Condition |
|---|---|
| **MODÈLE RECOMMANDÉ** | `verdictPct >= 80 %` |
| **MODÈLE PARTIEL — RÉSERVES** | `50 % ≤ verdictPct < 80 %` |
| **MODÈLE NON RECOMMANDÉ** | `verdictPct < 50 %` |

> ⚠ L'ancien manuel utilisateur donnait une **échelle de notes erronée**. Les
> seuils ci-dessus sont les seuils réels du code (corrigés le 2026-07-20).

---

## 7. Diplôme de l'école (gamification Niveau 3)

Le **diplôme** ne se décerne **que** si **toutes** ces conditions sont réunies :

1. Mode `all` (toutes les classes de l'école traversées, pas un tier unique) ;
2. **Tous** les tiers obligatoires du profil ont été **exécutés** ;
3. **Tous** ces tiers obligatoires sont **validés** (≥ 70 % chacun) ;
4. `pctGlobal >= 100 %`.

```js
diplomaEligible = isAllMode && mandatoryTiersAttempted && allMandatoryPassed && (pctGlobal >= 100)
```

En mode **tier unique** avec 100 % sur la classe ciblée, BenchGo affiche une
mention **« Classe Validée »** mais **n'attribue pas** le diplôme complet de
l'école (sinon un modèle ne faisant que la 6ᵉ à 100 % recevrait le diplôme du
Collège-Lycée).

> La condition `pctGlobal >= 100 %` implique que **tous** les exercices tentés
> (obligatoires **et** optionnels tentés) sont réussis : un sans-faute intégral
> sur le run. C'est extrêmement rare — c'est la récompense ultime.

---

## 8. Cumul multi-écoles (re-test, carnet)

### Enchaînement séquentiel
Si le modèle fait > 3B paramètres et que le run est en mode `all`, BenchGo
propose d'enchaîner **Primaire (LIGHT)** puis **Collège-Lycée (STANDARD)** dans
le **même run** :

- Même clé API, même auto-profilage, même professeur IA (conservés).
- `gameState` (Santé PV) **réinitialisé à 0** à chaque école.
- Chaque école produit son **propre** score / note / verdict / rapport.

### Carnet de scores (`score-ledger.js`, `Export-Rapports/.carnet/<modèle>.json`)
Le carnet **cumule toutes les tentatives par école**, pas seulement la dernière :

- Chaque école a une entrée `{ best, attempts: [...] }`.
- `attempts` = historique **chronologique** de tous les re-tests de cette école.
- `best` = la tentative au **pourcentage le plus élevé** (égalité → la dernière).
- Le **classement global** se base sur `best` par école (jamais sur la moyenne
  ni sur la dernière tentative).

### Bilan global cumulé (`computeGrandTotal`, affiché en fin de run multi-écoles)

```
Score cumulé   = Σ best.score       (meilleure tentative de chaque école)
Total cumulé   = Σ best.max
Pct cumulé     = round(Score cumulé / Total cumulé × 100)
Santé cumulée  = Σ best.globalLifeScore
Bonus cumulé   = Σ best.optionalBonus
```

**Exemple réel** (run `mythos-9b-unhinged`, 2026-07-20) :

| École | Points | Pct | Note | Bonus opt. |
|---|---|---|---|---|
| Primaire | 2596/2596 | 100 % | A | +343 |
| College-Lycee | 2536/2784 | 91 % | A | +248 |
| **TOTAL CUMULÉ** | **5132/5380** | **95 %** | **A** | **+591** |

### Que devient le « sans-faute » dans le cumul ?
- **Sans-faute sur une classe** → 100 % sur ce tier (note A), pas de surplus
  au-delà de 100 % pour ce tier.
- **Sans-faute sur une école** (tous exercices réussis) → 100 % sur l'école +
  éligibilité au **diplôme** (§7) + le **bonus optionnel** cumulé (§4) gonfle
  la Santé.
- **Sans-faute sur plusieurs écoles** → chaque école contribue à son `pct` max
  (100 %) au cumul ; le `pct cumulé` est une moyenne **pondérée** par le total
  de points de chaque école (pas une moyenne arithmétique des pourcentages).

### Re-test d'une même école
Re-lancer le même modèle sur la même école **ajoute une tentative** au carnet.
Si le nouveau `pct` ≥ meilleur `pct` actuel, il devient le nouveau `best` et
peut **améliorer** le classement global. Sinon, il est conservé dans
l'historique (`attempts`) sans dégrader le `best`.

---

## 9. Récapitulatif visuel du calcul

```
Exercice  →  +30 à +60 pts (aléatoire)        succès oblig. : +pts (tier + santé)
                                             succès option. : +pts + 20 % bonus (santé seule)
                                             échec          : -pts (tier + santé)

Tier      →  tierScore / totalPossiblePoints  seuil validation = 70 %
                                             bypassés exclus du calcul
                                             sans-faute = 100 % (plafond, pas de surplus)

École     →  Σ tiers exécutés                pctGlobal (tous) + pctMandatory (obligatoires)
                                             note A-F sur chaque pct
                                             diplôme si all + tous oblig. validés + 100 %

Cumul     →  Σ best par école                pct cumulé = moyenne pondérée par les totaux
                                             carnet conserve l'historique complet
```

---

## 10. Points clés à retenir

1. **Les points par exercice sont aléatoires (30–60)** : aucun total fixe par
   école. Le `pct` est la métrique de comparaison, pas le score brut.
2. **Plafond 100 % par tier et par école** : un sans-faute = 100 %, jamais plus.
3. **Le bonus optionnel (20 %) est un surplus de Santé, pas de note** : il
   renforce le buffer de survie, il ne gonfle pas le pourcentage.
4. **Le score obligatoire prime** pour le verdict et le jugement du modèle.
5. **Le cumul multi-écoles somme les `best`**, pas les dernières tentatives.
6. **Le diplôme exige un sans-faute intégral** en mode `all` (100 % global +
   tous les obligatoires validés).
7. **La Santé est réinitialisée à chaque école** : pas de report de PV entre
   écoles, mais conservation de la clé, de l'auto-profilage et du professeur IA.