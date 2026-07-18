# Contribuer à BenchGo V3

Merci de votre intérêt pour BenchGo ! Ce guide explique comment proposer
améliorations et corrections. Le projet est personnel mais **ouvert aux
contributions** via le flux classique fork → pull request.

## 🧭 Philosophie du projet

BenchGo est un benchmark **comportemental** de modèles LLM, avec une métaphore
scolaire (écoles = profils, classes = tiers). Quelques principes à respecter :

- **Zéro dépendance externe** : BenchGo n'utilise que les modules intégrés à
  Node.js (`fs`, `http`, `vm`, `crypto`…). N'ajoutez **pas** de package npm.
- **Node.js ≥ 18** : cible minimale. Pas de syntaxe nécessitant une version
  plus récente sans justification.
- **Style de code** : pas de point-virgule en fin d'instruction (convention
  existante), indentation 2 espaces, guillemets simples pour les chaînes.
- **Pas de transpilation** : le code source est exécuté tel quel par Node.
- **Pas de commentaires décoratifs** : les commentaires ne sont ajoutés que
  s'ils expliquent un *pourquoi* non évident.

## 🛠️ Prérequis

- [Node.js](https://nodejs.org/) ≥ 18
- [Git](https://git-scm.com/)
- [LM Studio](https://lmstudio.ai/) (pour tester en mode local) ou une clé API
  cloud (OpenAI, Anthropic, Groq, OpenRouter…)

## 🔄 Flux de contribution

1. **Forkez** le dépôt sur GitHub.
2. Clonez **votre fork** en local :
   ```bash
   git clone https://github.com/VOTRE-COMPTE/benchgo.git
   cd benchgo
   ```
3. Créez une branche descriptive :
   ```bash
   git checkout -b fix/typo-leaderboard
   # ou : feat/nouveau-profil, docs/manuel-xyz...
   ```
4. Faites vos modifications. Vérifiez que :
   - `node runner.js all` fonctionne toujours (au moins un tier).
   - `node leaderboard.js` génère bien `classement.html` sans erreur.
5. Commitez avec un message clair, idéalement en préfixant par un type :
   ```bash
   git commit -m "fix: corrige le calcul de calibration pour EXPERT"
   ```
   Types courants : `feat`, `fix`, `docs`, `refactor`, `perf`, `chore`.
6. Poussez vers votre fork :
   ```bash
   git push origin fix/typo-leaderboard
   ```
7. Ouvrez une **Pull Request** vers la branche `main` du dépôt `cisco-03/benchgo`.
   Remplissez le template fourni.

## ✅ Revue & fusion

- Chaque PR est **revue** avant fusion.
- Les modifications qui cassent un comportement existant doivent être
  justifiées et documentées.
- Si votre PR ajoute un nouveau tier ou modifie la structure des exercices,
  expliquez la **pédagogie** derrière.
- Le mainteneur peut demander des ajustements ; c'est normal, soyez réactif.

## 🐛 Signaler un bug

Ouvrez une **Issue** en utilisant le template « Bug report ». Décrivez :
- Ce que vous vouliez faire.
- Ce qui s'est passé (message d'erreur exact, comportement observé).
- Votre environnement (OS, version de Node, modèle testé, mode local/cloud).

## 💡 Proposer une fonctionnalité

Ouvrez une **Issue** avec le template « Feature request ». Expliquez le cas
d'usage concret avant la solution technique.

## 📜 Code de conduite

En participant, vous acceptez le [Code de conduite](./CODE_OF_CONDUCT.md).
Soyez respectueux, constructif et pédagogue — BenchGo est un projet
éducatif avant tout.

Merci ! 🏇