# 2026-07-10 — stripTS cassait les opérateurs ternaires et les littéraux objet

## Symptôme
- Tier 0 (`operationsDeBase`) : échec avec `Unexpected token '}'` sur un code JavaScript parfaitement valide.
- Tier 3 (`remplacerLettre`) : échec systématique avec `Unexpected token ')'` sur 3 tentatives consécutives.
- Le code affiché dans le rapport Markdown était correct, mais l'évaluation échouait.

## Cause racine
La fonction `stripTS()` dans `parsing-utils.js` utilisait une **règle 8 regex** pour supprimer les annotations de type TypeScript `: Type` :

```js
result = result.replace(/([)\w\]])\s*:\s*[a-zA-Z_$][\w.<>\[\]|&\s]*(?=[,)=;\n])/g, '$1');
```

Cette regex ne distinguait pas les annotations de type des constructions JavaScript valides utilisant le même motif `identifiant : identifiant` :

1. **Opérateurs ternaires** : `cond ? a : valeur` → la regex matchait `a : valeur` et supprimait `: valeur`, laissant un ternaire incomplet `cond ? a` → `SyntaxError`.

   Exemple concret :
   - `b !== 0 ? a / b : null` → `b !== 0 ? a / b` (manque `: null`) → `Unexpected token '}'`
   - `mot[i] === ancienne ? nouvelle : mot[i]` → `... ? nouvelle` (manque `: mot[i]`) → `Unexpected token ')'`

2. **Littéraux objet** : `{ key: value }` → la regex pouvait supprimer `: value` quand `value` était un identifiant simple suivi d'un terminator (`,`, `)`, `;`, `=`, `\n`).

   Exemple : `{ a: foo, b: bar }` → `{ a, b: bar }` (le `: foo` était supprimé car `foo` est suivi de `,`).

3. **Labels de switch** : `case x: break;` → `case x break;` (le `: break` était supprimé).

Le rapport Markdown affichait le code **avant** `stripTS` (correct), masquant la cause racine. Le code **réellement exécuté** dans la VM était le code **après** `stripTS` (cassé).

## Solution
Remplacement de la règle 8 regex par un **scanner contextuel** (`stripTypeAnnotations()`) qui parcourt le code caractère par caractère en suivant :

- L'état des chaînes de caractères (`"`, `'`, `` ` `` avec template literals `${}`)
- Les commentaires (`//` et `/* */`)
- La profondeur des crochets `()`, `[]`, `{}`
- Le compteur d'opérateurs ternaires `?` non appairés

**Règles de stripping** :
| Contexte | `: Type` | Action |
|---|---|---|
| Dans une liste de paramètres `(...)` | `function f(a: string)` | **Strip** |
| Après `let`/`const`/`var identificateur` | `let x: number` | **Strip** |
| Après un `?` ternaire non appairé | `cond ? a : b` | **Ne pas strip** |
| Dans un littéral objet `{...}` | `{ key: value }` | **Ne pas strip** |
| Après `case`/`default` | `case x:` | **Ne pas strip** |

## Fichiers modifiés
- `parsing-utils.js` : nouvelle fonction `stripTypeAnnotations()`, règle 8 regex supprimée

## Validation
13 tests de régression couvrant :
- Les 4 cas de bug (ternaires `: null`, `: mot[i]`, avec/sans parenthèses, `split/join`)
- Les littéraux objet (valeurs identiques et différentes)
- Les annotations TypeScript qui doivent **toujours** être strippées (params, return, var, interface, export, génériques)

Tous les tests passent. Voir le script de test (supprimé après validation) pour le détail.

## Leçons apprises
1. **Ne jamais utiliser une regex seule pour distinguer les annotations de type TS des constructions JS valides** : les motifs `identifiant: identifiant` sont syntaxiquement identiques entre TS (`param: Type`) et JS (`key: value`, `? a : b`).
2. **Le code affiché dans les rapports n'est pas le code exécuté** : `buildTierReport` affiche le code brut extrait, mais `evaluateTask` applique `stripTS` avant l'exécution VM. Pour le débogage, il faut inspecter le code **après** `stripTS`.
3. **Un scanner contextuel est plus fiable qu'une regex** pour les transformations qui dépendent du contexte syntaxique (profondeur de crochets, état ternaire, présence de mots-clés).
