# Carte Mentale — Structure et Débogage du Classement (Leaderboard)

Ce document décrit l'architecture du système de classement et sert de guide visuel pour savoir comment modifier et dépanner l'interface utilisateur.

> **Refonte 2026-07-18** : le HTML est passé d'un affichage volumineux (cartes détaillées
> toujours ouvertes) à un affichage **condensé** (une ligne par modèle) avec **modale de détail**
> au clic, **filtres par catégorie** (Top/Recommandés/Moyenne/Rattrapage/Échec) et **filtres par
> taille de paramètres** (< 3B / 3B-14B / 14B-30B / > 30B / Inconnue), plus recherche texte.

---

## 1. Schéma des flux (Carte Mentale)

```mermaid
graph TD
    subgraph Données sources (Input)
        JSON["📄 Fichiers .json (Carnets de scores)"]
        PathJSON["Dossier : Export-Rapports/.carnet/*.json"]
        JSON --> PathJSON
    end

    subgraph Moteur de traitement (Processing)
        JS["⚙️ leaderboard.js"]
        Fn1["loadAllLedgers() : Charge les JSON"]
        Fn2["aggregateLedger() : Calcule les stats globales"]
        FnCat["getCategory() : Catégorie de performance (5 niveaux)"]
        FnSize["getParamSize() : Taille de params (5 niveaux)"]
        Fn3["buildLeaderboardHTML() : Cartes condensées + modale + filtres"]
        Fn4["buildLeaderboardMarkdown() : Génère classement.md"]
        FnReason["buildReasoningMarkdown() : Génère raisonnement_modeles.md"]
        Fn5["generateLeaderboard() : Écrit les 3 fichiers de sortie"]
        Fn6["startServer() : Serveur web port 3939 + API delete"]

        JS --> Fn1
        JS --> Fn2
        JS --> FnCat
        JS --> FnSize
        JS --> Fn3
        JS --> Fn4
        JS --> FnReason
        JS --> Fn5
        JS --> Fn6
    end

    subgraph Sorties générées (Output)
        HTML["🌐 Export-Rapports/classement.html (condensé + modale)"]
        MD["📝 Export-Rapports/classement.md"]
        REASON["🧠 Export-Rapports/raisonnement_modeles.md"]
    end

    subgraph Visualisation (UI)
        Port["🖥️ Navigateur : http://localhost:3939/"]
        Cards["📋 Cartes condensées (1 ligne/modèle)"]
        Modal["🔍 Modale détail (stats + forces + écoles)"]
        Filters["🎚️ Filtres catégorie + taille + recherche"]
    end

    PathJSON -->|1. Lecture| Fn1
    Fn5 -->|2. Écriture| HTML
    Fn5 -->|2. Écriture| MD
    Fn5 -->|2. Écriture| REASON
    Fn6 -->|3. Lecture & Service| HTML
    HTML -->|4. Rendu| Port
    Port --> Cards
    Cards -->|clic| Modal
    Port --> Filters
    Filters -->|filtrage client| Cards
```

---

## 2. Structure de l'interface HTML (refonte 2026-07-18)

### A. Barre de filtres (toolbar)
- **`#chips`** — Filtres par catégorie de performance (cliquables, avec compteurs) :
  - Tous · 🏆 Top du top (≥90%) · ✅ Recommandés (≥80%) · 📊 Dans la moyenne (≥70%) · ⚠️ En rattrapage (≥50%) · 💥 Échec total (<50%)
- **`#sizeChips`** — Filtres par taille de paramètres (cliquables, avec compteurs) :
  - Toutes tailles · 🐱 < 3B · 📦 3B-14B · 🎓 14B-30B · 🧠 > 30B · ❓ Inconnue
- **`#search`** — Champ de recherche texte (nom intégral ou nom court)
- Les 3 filtres se combinent (ET logique). Compteur `shown/total` en temps réel.

### B. Cartes condensées (`.card`)
Une carte par modèle, une seule ligne :
```
[rang/médaille] [icône cat] nom + [badge taille]  |  % barre  Note  Santé  Oblig.  Aide/Rat.  |  [Détails] [🗑]
```
- Clic sur la carte → ouvre la modale
- Badge taille : `📦 7B`, `🐱 1.5B`, `🎓 22B`, etc. (déduit du nom via `detectProfileFromModelName`)
- Médailles 🥇🥈🥉 sur les 3 premiers

### C. Modale de détail (`#modal`)
Ouverte au clic, contient :
- **En-tête** : rang, nom intégral, badge verdict coloré, catégorie + taille
- **Statistiques** : 9 cartes (Points, % global + barre, Note, Obligatoire + barre, Santé, Bonus, Aide, Rattrapage, Écoles)
- **Forces & Faiblesses** : grid 2 colonnes + Notes
- **Détail par école** : tableau (École, Points, %, Note, Bonus, Santé, Aide, Rat., Calib., Date)
- **Méta** : dernière mise à jour, nom court
- Fermeture : clic overlay · bouton × · touche Échap

### D. Données côté client
Les données complètes de chaque modèle sont sérialisées en JSON dans `var MODELS = [...]`
directement dans le HTML. La modale et le filtrage sont rendus en JS pur depuis cette variable —
pas de re-fetch serveur. Le fichier HTML est donc autonome et ouvrable hors-ligne.

---

## 3. Responsabilités des composants & Fichiers clés

### A. Les Données (Input)
- **Fichiers source** : Les résultats bruts de chaque évaluation de modèle sont stockés dans [Export-Rapports/.carnet/](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/.carnet/).
- Chaque fichier porte le nom abrégé du modèle (ex: `mistralai_mistral-7b-instruct-v0.3.json`).

### B. Le Générateur (Processing)
- **Fichier à modifier pour des changements permanents** : [leaderboard.js](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/leaderboard.js).
  - **Catégorisation** : `getCategory(entry)` (5 catégories par % global) et `getParamSize(modelName)` (5 catégories par taille, réutilise `detectProfileFromModelName` de `config.js`).
  - **Mise en page & Styles** : Les styles CSS de la page se trouvent dans la constante HTML générée par `buildLeaderboardHTML(entries)` (rechercher la balise `<style>`).
  - **Structure HTML** : Les cartes condensées, la modale et les filtres sont construits dans `buildLeaderboardHTML`. Les données complètes sont sérialisées dans `var MODELS`.
  - **JS embarqué** : Le filtrage, la modale et la suppression sont dans le bloc `<script>` à la fin de `buildLeaderboardHTML`.

### C. La Vue active (Output & UI)
- **Fichier de production à modifier pour des tests rapides** : [Export-Rapports/classement.html](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/classement.html).
  - Modifier directement ce fichier permet de tester immédiatement des ajustements CSS/HTML/JS sur le serveur local sans avoir à régénérer le classement.
- **Port d'écoute** : Le serveur interne sert la page sur `http://localhost:3939/`.

---

## 4. Guide de Débogage & Réparation (Pas à Pas)

Si le classement présente un défaut visuel (layout cassé, texte tronqué, mauvaise couleur, modale qui ne s'ouvre pas, filtre inactif, etc.) :

1. **Inspecter l'erreur dans le navigateur** :
   - Ouvrez la console de développement (F12 ou clic droit -> *Inspecter*) sur `http://localhost:3939/`.
   - Pour un défaut CSS : repérez la classe fautive et ajustez-la directement en direct dans le navigateur.
   - Pour un défaut JS (modale/filtre) : consultez la console pour d'éventuelles erreurs, puis inspectez `var MODELS` dans la console pour vérifier les données sérialisées.

2. **Appliquer le correctif rapide** :
   - Ouvrez [classement.html](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/classement.html) et modifiez la règle CSS ou le JS dans la balise `<style>`/`<script>` pour corriger immédiatement.

3. **Reporter la correction dans le code source** :
   - Ouvrez [leaderboard.js](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/leaderboard.js) et reportez les modifications dans la fonction `buildLeaderboardHTML` (CSS dans le template `<style>`, JS dans le template `<script>`).

4. **Régénérer le classement** :
   - Pour s'assurer que vos changements seront appliqués lors de toutes les futures exécutions du benchmark, relancez la régénération statique depuis le terminal :
     ```bash
     node leaderboard.js
     ```
   - Rafraîchissez la page du navigateur pour vérifier que les modifications sont correctement persistées.
