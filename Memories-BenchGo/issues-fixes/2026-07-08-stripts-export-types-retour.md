# 2026-07-08 — stripTS ne supprimait pas export/import/types de retour (cause n°1 des échecs)

## Symptôme
Tous les modèles LLM retournant du TypeScript avec export function... échouaient systématiquement
avec l erreur Unexpected token export dans le VM sandbox. Les codes étaient parfaitement
corrects mais l évaluateur ne pouvait pas les exécuter. Ce bug affectait ~80% des évaluations.

## Cause racine
La fonction stripTS() dans parsing-utils.js avait 3 lacunes critiques :
1. export/import non supprimés (le VM exécute du JS pur, pas des modules ES)
2. Types de retour avec génériques d accolades non gérés (Promise<{...}> confondu avec corps de fonction)
3. Assertions non-null (!) non supprimées (stack.pop()! causait des erreurs de syntaxe)

## Solution
Réécriture complète de stripTS() avec :
1. Suppression des imports ES modules via regex multiline
2. Suppression du mot-clé export
3. Nouvelle fonction stripReturnTypeAnnotation() : parser par compteur de profondeur pour {} et <>
4. Suppression des assertions non-null
5. Suppression des types de fonction en paramètre

Fix supplémentaire : conversion const/let vers var au niveau top-level dans vm-sandbox.js et custom-evaluators.js

## Fichiers modifiés
- parsing-utils.js (stripTS réécrit + nouvelle fonction stripReturnTypeAnnotation)
- vm-sandbox.js (conversion const/let vers var)
- custom-evaluators.js (conversion const/let vers var + noms de fonctions alignés)

## Validation
- Script de test test-strip.js avec 6 cas couvrant export, types génériques, async, imports, non-null
- Tous les évaluateurs custom testés avec codes de référence TypeScript
- Tests dintégration : evaluateAsyncPartialErrors, evaluateFloodFill, evaluateCloudflareMiddleware, etc.

## Leçons apprises
- Le stripping TypeScript ne peut pas se faire uniquement avec des regex pour les types complexes contenant des accolades. Un parser par compteur de profondeur est nécessaire.
- Le VM sandbox de Node.js utilise du JavaScript CommonJS : les const/let au top-level ne s attachent pas au global du contexte (contrairement à var).
- Un bug dans l évaluateur peut faire échouer tous les modèles même si leurs réponses sont correctes — toujours tester l évaluateur avec un code de référence avant de blâmer le modèle.