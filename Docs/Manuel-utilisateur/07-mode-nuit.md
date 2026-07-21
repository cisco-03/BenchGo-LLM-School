# Mode nuit (batch automatique)

Le **mode nuit** permet de tester plusieurs modèles automatiquement, l'un après l'autre,
sans aucune intervention humaine. Vous sélectionnez vos modèles et vos écoles le soir,
vous lancez le script, et le matin vous retrouvez tous les rapports et le classement
à jour dans `Export-Rapports/`.

C'est la solution idéale quand un modèle met ~1 heure à terminer une école et monopolise
toute la mémoire de la machine : vous lancez le batch avant d'aller dormir, et votre PC
travaille seul pendant la nuit.

---

## Sommaire

1. [Principe](#1-principe)
2. [Prérequis](#2-prérequis)
3. [Lancer le mode nuit (interactif)](#3-lancer-le-mode-nuit-interactif)
4. [Lancer le mode nuit (non-interactif)](#4-lancer-le-mode-nuit-non-interactif)
5. [Flags disponibles](#5-flags-disponibles)
6. [Ce qui se passe pendant la nuit](#6-ce-qui-se-passe-pendant-la-nuit)
7. [Récupérer les résultats le matin](#7-récupérer-les-résultats-le-matin)
8. [Comportement détaillé : rattrapage, pénalités, doublons](#8-comportement-détaillé--rattrapage-pénalités-doublons)
9. [Gestion du serveur LM Studio](#9-gestion-du-serveur-lm-studio)
10. [Exemples complets](#10-exemples-complets)
11. [Dépannage](#11-dépannage)
12. [Planification automatique (tâche planifiée Windows)](#12-planification-automatique-tâche-planifiée-windows)

---

## 1. Principe

Le mode nuit est un **orchestrateur** (`night-batch.js`) qui enchaîne le runner BenchGo
(`runner.js`) sur plusieurs modèles, sans interaction :

```
Pour chaque modèle sélectionné :
    1. lms unload --all        → libère la RAM du modèle précédent
    2. lms load <modèle>       → charge le modèle cible en mémoire
    3. node runner.js --force  → exécute le benchmark en mode non-interactif
                                 (pour chaque école sélectionnée)
```

L'ordre d'exécution est : **pour chaque modèle, on enchaîne toutes les écoles sélectionnées**.
Ainsi, un modèle est chargé une seule fois en mémoire et passe toutes ses écoles à la suite,
avant de laisser la place au modèle suivant.

Le runner génère lui-même le classement (`classement.html` / `classement.md`) à la fin de
chaque run complet (mode `all`), donc le classement final reflète **tous les modèles testés**
pendant la nuit.

---

## 2. Prérequis

- **LM Studio installé** avec sa CLI `lms` (livrée avec l'application).
  Vérifiez qu'elle est accessible :
  ```powershell
  lms --help
  ```
  Si la commande n'est pas reconnue, ouvrez LM Studio au moins une fois (la CLI s'enregistre
  automatiquement), ou relancez l'installateur LM Studio.

- **Le daemon LM Studio doit tourner**. Le script le vérifie au démarrage.
  - Soit LM Studio (l'application) est ouvert,
  - Soit vous avez lancé `lms daemon up` en arrière-plan.

- **Au moins un modèle LLM téléchargé** dans LM Studio (onglet « My Models »).

- **Node.js 18+** (déjà requis pour BenchGo).

> Le mode nuit ne fonctionne **qu'avec des modèles locaux** (LM Studio). Les modèles cloud
> (OpenAI, Anthropic, etc.) ne sont pas concernés car ils ne se chargent pas en mémoire via
> `lms load`.

---

## 3. Lancer le mode nuit (interactif)

C'est l'usage le plus simple : vous choisissez vos modèles et vos écoles à l'écran, puis
le script tourne seul.

```powershell
node night-batch.js
```

Le script vous guide en 2 étapes :

### Étape A — Sélection des modèles

Le script affiche la liste de tous vos modèles LLM téléchargés :

```
  === MODELES LLM TELECHARGES ===
  Selectionnez les modeles a tester cette nuit.
  Syntaxe : numeros separes par des virgules (ex: 1,3,5) ou "all".

   1. Ornith 1.0 9B            9B   Q4_K_M    5.2 Go  deepreinforce-ai
   2. Ornith 1.0 9B            9B   Q5_K_M    6.0 Go  deepreinforce-ai
   3. Gemma4 v2                12B  Q8_0     11.8 Go  yuxinlu1
   4. Mythos 9B Unhinged       9B   Q4_K_M    4.7 Go  fableforge-ai
   ...

  Modeles a tester :
```

Tapez :
- `1,3,4` pour tester les modèles 1, 3 et 4,
- `all` (ou `*`) pour tous les tester,
- `Entrée` vide annule.

### Étape B — Sélection des écoles

Le script propose ensuite les écoles (niveaux) à faire passer :

```
  === ECOLES A TESTER ===
  Selectionnez les ecoles (niveaux) a faire passer a chaque modele.
  Syntaxe : numeros separes par des virgules (ex: 1,2) ou "all".
  "auto" laisse le runner deviner le profil depuis le nom du modele.

   1. Primaire (< 3B)
   2. College-Lycee (3B - 14B)
   3. Universite (14B - 30B)
   4. These (> 30B)
   5. Auto-detection (1 ecole)

  Ecoles a tester :
```

Tapez :
- `2` pour tester uniquement le Collège-Lycée,
- `1,2` pour Primaire + Collège-Lycée,
- `all` pour toutes les écoles réelles (Primaire → Thèse),
- `5` (ou `auto`) pour laisser le runner détecter le profil depuis le nom du modèle
  (1 seule école par modèle, adaptée à sa taille).

> **Astuce** : `auto` est le choix le plus simple — chaque modèle passe l'école
> correspondant à sa taille (un 9B → Collège-Lycée, un 1B → Primaire, etc.).

Le script affiche alors la file d'attente complète et démarre :

```
  === FILE D'ATTENTE DE NUIT ===
  Modeles : 3  |  Ecoles : auto  |  Runs totaux : 3
  Ordre : pour chaque modele, on enchaine toutes les ecoles selectionnees.
   1. Ornith 1.0 9B [ornith-1.0-9b@q4_k_m] 9B Q4_K_M
   2. Mythos 9B Unhinged [mythos-9b-unhinged] 9B Q4_K_M
   3. Qwen3.5 9B [qwen/qwen3.5-9b] 9B Q4_K_M

  Debut a 23:15:42. Laissez tourner, les rapports seront dans Export-Rapports/.
  Ctrl+C pour interrompre (le modele en cours finira son tier en cours).
```

Vous pouvez alors aller dormir. Le script s'occupe de tout.

---

## 4. Lancer le mode nuit (non-interactif)

Si vous voulez scripter le lancement (ex : tâche planifiée Windows), utilisez les flags
`--models` et `--schools` pour tout spécifier sans interaction :

```powershell
node night-batch.js --models=mythos-9b-unhinged,qwen/qwen3.5-9b --schools=STANDARD
```

- `--models=` : liste de **modelKeys** séparés par virgules (voir `lms ls` pour les connaître).
- `--schools=` : liste d'écoles séparées par virgules parmi `LIGHT, STANDARD, EXPERT, DOCTORAT, auto`.

Les modelKeys sont les identifiants internes de LM Studio (colonne de gauche de `lms ls`).
Exemple :
```
LLMs ...                                        PARAMS  ARCHITECTURE  SIZE
ornith-1.0-9b@q4_k_m                            9B      qwen35        4.92 GB
mythos-9b-unhinged                              9B      qwen3         4.68 GB
qwen/qwen3.5-9b                                 9B      qwen35        5.24 GB
```
Ici les modelKeys sont `ornith-1.0-9b@q4_k_m`, `mythos-9b-unhinged`, `qwen/qwen3.5-9b`.

> **Sans `--schools`** en mode non-interactif, le script utilise `auto` par défaut
> (détection du profil par modèle).

---

## 5. Flags disponibles

| Flag | Description |
|---|---|
| `--models=key1,key2` | Modèles à tester (modelKeys séparés par virgules). Sans ce flag en session non-interactive, le script s'arrête. |
| `--schools=LIGHT,STANDARD` | Écoles à tester (séparées par virgules). Valeurs : `LIGHT`, `STANDARD`, `EXPERT`, `DOCTORAT`, `auto`. Sans ce flag en non-interactif → `auto`. |
| `--no-teacher` | Désactive le professeur IA correcteur (OpenRouter) pour toute la session. Utile si vous n'avez pas de clé OpenRouter ou voulez aller plus vite. |

### Exemples

```powershell
# Tout interactif (choix à l'écran)
node night-batch.js

# 2 modèles, école Collège-Lycée uniquement, sans professeur IA
node night-batch.js --models=mythos-9b-unhinged,qwen/qwen3.5-9b --schools=STANDARD --no-teacher

# Tous les modèles, auto-détection du profil pour chacun
node night-batch.js --models=all
# (note : "all" comme modelKey n'existe pas — il faut lister les clés ou utiliser le mode interactif)

# 1 modèle, Primaire + Collège-Lycée
node night-batch.js --models=ornith-1.0-9b@q4_k_m --schools=LIGHT,STANDARD
```

---

## 6. Ce qui se passe pendant la nuit

Pour **chaque modèle** de la file d'attente, et pour **chaque école** sélectionnée :

1. **Déchargement** : `lms unload --all` libère la RAM du modèle précédent.
2. **Chargement** : `lms load <modelKey>` charge le modèle cible en mémoire.
3. **Benchmark** : `node runner.js --force --profile=<ecole>` exécute le benchmark complet :
   - auto-profilage du modèle (auto-évaluation sur 4 compétences),
   - filtrage des tâches trop difficiles selon le profil,
   - exécution de tous les tiers applicables,
   - rattrapage automatique si nécessaire (voir §8),
   - génération du rapport Markdown dans `Export-Rapports/`,
   - mise à jour du carnet de scores persistant,
   - régénération du classement global (`classement.html` + `classement.md`).

À la fin de chaque modèle, le script affiche un résumé horodaté. À la toute fin, un
**bilan global** récapitule tous les runs (durée, succès/échecs, chemins des rapports).

---

## 7. Récupérer les résultats le matin

Au réveil, ouvrez ces emplacements :

### Rapports détaillés (un par modèle × école)
```
Export-Rapports/<AAAA-MM-JJ>/<école>/<niveau>/rapport_v3_<modèle>_<niveau>_<HH-MM-SS>.md
```
Exemple :
```
Export-Rapports/2026-07-21/College-Lycee/STANDARD/rapport_v3_mythos-9b-unhinged_standard_03-14-22.md
```

### Classement global (mis à jour après chaque run)
```
Export-Rapports/classement.html   ← ouvrir dans un navigateur
Export-Rapports/classement.md     ← version texte
```
Le classement cumule **tous les modèles testés** (y compris ceux des nuits précédentes).
Le meilleur score par école est conservé.

### Logs horodatés
```
logs/benchgo_<AAAA-MM-JJ>T<HH-MM-SS>Z.log
```
Un log par run, pour diagnostiquer un éventuel échec.

### Bilan affiché dans le terminal
À la fin, le script affiche un tableau récapitulatif :
```
  Detail :
  OK Mythos 9B Unhinged              [STANDARD] 42.3 min
  OK Qwen3.5 9B                      [STANDARD] 38.1 min
  KO Ornith 1.0 9B                   [STANDARD] 5.2 min (load_failed)
```

---

## 8. Comportement détaillé : rattrapage, pénalités, doublons

Le mode nuit utilise le flag `--force` du runner, qui adapte 3 comportements normalement
interactifs pour qu'ils fonctionnent sans intervention :

### Rattrapage automatique
Le rattrapage est **toujours automatique** (déjà le cas en interactif). Il se déclenche si
l'un de ces 3 critères est rempli à la fin des tiers :
1. Au moins un tier **obligatoire** a échoué,
2. La santé globale de l'élève est **< 0 PV**,
3. **≥ 40 %** des exercices ont échoué (échec massif).

Aucune question n'est posée : le rattrapage s'enchaîne tout seul, ce qui est parfaitement
compatible avec un run de nuit sans surveillance.

### Pénalités d'échec
En interactif, après un échec définitif, le professeur (vous) peut décider d'annuler la
pénalité si le grader s'est trompé. En mode nuit (`--force`), **la pénalité est maintenue
systématiquement** : un benchmark objectif de nuit ne conteste pas le grader à la place
de l'élève. L'échec s'applique normalement.

> Si un exercice est mal noté par le grader, vous le découvrirez le matin dans le rapport
> et pourrez le corriger à la main (le carnet de scores est mis à jour au prochain run).

### Doublons (modèle déjà testé)
Si un modèle a déjà été testé sur une école (carnet de scores existant), le runner propose
normalement de forcer le re-test. En mode nuit (`--force`), **le re-test est automatiquement
accepté** : le nouveau score est cumulé à l'historique, et le meilleur score est conservé
pour le classement.

---

## 9. Gestion du serveur LM Studio

Le script adopte une stratégie **non-destructive** pour le serveur HTTP LM Studio :

1. **Si le serveur répond déjà** sur `http://localhost:1234` (votre cas habituel, serveur
   toujours allumé) → le script l'utilise tel quel et **ne l'arrête pas** à la fin.
2. **Si le serveur ne répond pas** → le script le démarre en mode headless
   (`lms server start` en arrière-plan) et **l'arrête à la fin**, seulement s'il l'a démarré.

Ainsi, votre serveur déjà lancé n'est jamais touché. Le script ne fait que charger/décharger
les modèles en mémoire via `lms load` / `lms unload`.

> **Recommandation** : laissez votre serveur LM Studio allumé comme d'habitude. Le script
> le détectera et s'en servira sans le redémarrer.

---

## 10. Exemples complets

### Exemple 1 — Session simple (1 modèle, auto-détection)
```powershell
node night-batch.js --models=mythos-9b-unhinged --schools=auto
```
Teste `mythos-9b-unhinged` sur l'école correspondant à sa taille (9B → Collège-Lycée).

### Exemple 2 — Comparaison de 3 modèles sur le Collège-Lycée
```powershell
node night-batch.js --models=mythos-9b-unhinged,qwen/qwen3.5-9b,ornith-1.0-9b@q4_k_m --schools=STANDARD
```
Charge chaque modèle à tour de rôle, fait passer le Collège-Lycée, décharge, passe au suivant.

### Exemple 3 — Un modèle sur 2 écoles (Primaire + Collège-Lycée)
```powershell
node night-batch.js --models=qwen/qwen3.5-9b --schools=LIGHT,STANDARD
```
Le modèle est chargé une fois, passe Primaire puis Collège-Lycée (2 runs, 2 rapports).

### Exemple 4 — Session complète sans professeur IA
```powershell
node night-batch.js --models=mythos-9b-unhinged --schools=STANDARD --no-teacher
```
Désactive le professeur OpenRouter (gain de temps, pas d'appel cloud). L'élève s'auto-analyse
seul en cas d'échec.

### Exemple 5 — Tout interactif
```powershell
node night-batch.js
```
Choisissez modèles et écoles à l'écran, puis laissez tourner.

---

## 11. Dépannage

### « Le daemon LM Studio ne répond pas »
Le daemon n'est pas lancé. Solutions :
- Ouvrez l'application LM Studio (elle démarre le daemon), **ou**
- Lancez `lms daemon up` dans un terminal séparé, **ou**
- Relancez l'installateur LM Studio (`irm https://lmstudio.ai/install.ps1 | iex`).

### « Aucun modèle LLM trouvé »
Aucun modèle n'est téléchargé dans LM Studio. Téléchargez-en au moins un
(onglet « My Models » → loupe → `lms get <modèle>`).

### « Aucun modèle de --models= trouvé dans la liste »
Un modelKey que vous avez passé n'existe pas. Le script affiche la liste des modelKeys
valides. Copiez-collez l'un d'eux. Note : les modelKeys sont sensibles à la casse et
incluent parfois le `@q4_k_m` (quantification).

### « Aucune école de --schools= reconnue »
Vérifiez l'orthographe : `LIGHT`, `STANDARD`, `EXPERT`, `DOCTORAT`, `auto`
(insensible à la casse).

### « lms load échoué »
Le modèle n'a pas pu être chargé en mémoire (souvent un problème de RAM disponible).
Le script ignore ce modèle et passe au suivant (marqué `KO load_failed` dans le bilan).
Libérez de la RAM ou choisissez un modèle plus petit.

### Un modèle reste chargé après un Ctrl+C
Si vous interrompez brutalement le script (Ctrl+C en plein chargement), le modèle en cours
peut rester en mémoire. Déchargez-le manuellement :
```powershell
lms unload --all
```

### Le serveur HTTP ne répond pas après un crash
Si le script a démarré le serveur lui-même et a planté, il peut rester un processus orphelin.
Arrêtez-le puis relancez :
```powershell
lms server stop
lms server start
```

---

## 12. Planification automatique (tâche planifiée Windows)

Pour lancer le mode nuit à heure fixe sans même taper la commande, créez une tâche
planifiée Windows :

### Étape 1 — Créer un script de lancement
Créez un fichier `lancer-nuit.bat` à la racine de BenchGo :
```bat
@echo off
cd /d C:\chemin\vers\benchmark-v3
node night-batch.js --models=mythos-9b-unhinged,qwen/qwen3.5-9b --schools=STANDARD --no-teacher
```

### Étape 2 — Créer la tâche planifiée
1. Ouvrez le **Planificateur de tâches** (taskschd.msc).
2. **Créer une tâche de base**.
3. Nom : `BenchGo Nuit`.
4. **Déclencheur** : Quotidien, à 02:00 (par exemple).
5. **Action** : Démarrer un programme → `C:\chemin\vers\lancer-nuit.bat`.
6. **Conditions** : décochez « Ne démarrer que sur alimentation secteur »
   (sinon la tâche ne se lance pas sur un PC portable sur batterie).
7. Validez.

Ainsi, chaque nuit à 02:00, Windows lance automatiquement le batch. Vous n'avez plus qu'à
consulter `Export-Rapports/` le matin.

> **Note** : pour que le daemon LM Studio soit disponible à 02:00, assurez-vous que
> LM Studio est configuré pour démarrer avec Windows (paramètres de l'app), **ou** lancez
> `lms daemon up` au démarrage via une autre tâche planifiée.

---

## Récapitulatif express

| Action | Commande |
|---|---|
| Lancer interactif (choix à l'écran) | `node night-batch.js` |
| Lancer avec modèles + écoles fixés | `node night-batch.js --models=... --schools=...` |
| Sans professeur IA | ajouter `--no-teacher` |
| Connaître les modelKeys | `lms ls` |
| Décharger un modèle resté en mémoire | `lms unload --all` |
| Voir les résultats le matin | `Export-Rapports/classement.html` |

---

## Voir aussi

- [01-demarrage-rapide.md](01-demarrage-rapide.md) — lancer un run unique (mode interactif classique)
- [02-commandes.md](02-commandes.md) — toutes les commandes du runner
- [04-lecture-resultats.md](04-lecture-resultats.md) — comprendre les rapports et le classement
- [05-depannage.md](05-depannage.md) — résoudre les incidents du runner
