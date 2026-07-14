# Carte Mentale — Structure et Débogage du Classement (Leaderboard)

Ce document décrit l'architecture du système de classement et sert de guide visuel pour savoir comment modifier et dépanner l'interface utilisateur.

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
        Fn3["buildLeaderboardHTML() : Assemble HTML & CSS"]
        Fn4["buildLeaderboardMarkdown() : Génère classement.md"]
        Fn5["generateLeaderboard() : Écrit les fichiers de sortie"]
        Fn6["startServer() : Lance le serveur web sur le port 3939"]

        JS --> Fn1
        JS --> Fn2
        JS --> Fn3
        JS --> Fn4
        JS --> Fn5
        JS --> Fn6
    end

    subgraph Sorties générées (Output)
        HTML["🌐 Export-Rapports/classement.html"]
        MD["📝 Export-Rapports/classement.md"]
    end

    subgraph Visualisation (UI)
        Port["🖥️ Navigateur : http://localhost:3939/"]
    end

    PathJSON -->|1. Lecture| Fn1
    Fn5 -->|2. Écriture| HTML
    Fn5 -->|2. Écriture| MD
    Fn6 -->|3. Lecture & Service| HTML
    HTML -->|4. Rendu visuel| Port
```

---

## 2. Responsabilités des composants & Fichiers clés

### A. Les Données (Input)
- **Fichiers source** : Les résultats bruts de chaque évaluation de modèle sont stockés dans [Export-Rapports/.carnet/](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/.carnet/).
- Chaque fichier porte le nom abrégé du modèle (ex: `mistralai_mistral-7b-instruct-v0.3.json`).

### B. Le Générateur (Processing)
- **Fichier à modifier pour des changements permanents** : [leaderboard.js](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/leaderboard.js).
  - **Mise en page & Styles** : Les styles CSS de la page se trouvent dans la constante HTML générée par `buildLeaderboardHTML(entries)` (rechercher la balise `<style>`).
  - **Structure HTML** : Les blocs de chaque modèle (forces, faiblesses, détails d'école) sont construits à l'intérieur de la boucle de `buildLeaderboardHTML`.

### C. La Vue active (Output & UI)
- **Fichier de production à modifier pour des tests rapides** : [Export-Rapports/classement.html](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/classement.html).
  - Modifier directement ce fichier permet de tester immédiatement des ajustements CSS/HTML sur le serveur local sans avoir à régénérer le classement.
- **Port d'écoute** : Le serveur interne sert la page sur `http://localhost:3939/`.

---

## 3. Guide de Débogage & Réparation (Pas à Pas)

Si le classement présente un défaut visuel (layout cassé, texte tronqué, mauvaise couleur, etc.) :

1. **Inspecter l'erreur dans le navigateur** :
   - Ouvrez la console de développement (F12 ou clic droit -> *Inspecter*) sur `http://localhost:3939/`.
   - Repérez la classe CSS fautive et ajustez-la directement en direct dans le navigateur pour valider la correction.

2. **Appliquer le correctif rapide** :
   - Ouvrez [classement.html](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/Export-Rapports/classement.html) et modifiez la règle dans la balise `<style>` pour corriger l'affichage immédiat.

3. **Reporter la correction dans le code source** :
   - Ouvrez [leaderboard.js](file:///c:/Users/Flexodiv/Desktop/benchmark-v3/leaderboard.js) et reportez les modifications dans la fonction `buildLeaderboardHTML`.

4. **Régénérer le classement** :
   - Pour s'assurer que vos changements seront appliqués lors de toutes les futures exécutions du benchmark, relancez la régénération statique depuis le terminal de travail :
     ```bash
     node leaderboard.js
     ```
   - Rafraîchissez la page du navigateur pour vérifier que les modifications sont correctement persistées.
