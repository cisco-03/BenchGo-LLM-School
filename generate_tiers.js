const fs = require('fs');
const path = require('path');

const tiers = [
  {
    tier: 0,
    title: "Tier 0 — Maternelle",
    difficulty: "EASY",
    mandatory_for: ["LIGHT"],
    optional_for: [],
    prompt: `You are taking a TIER 0 technical evaluation — the simplest level.

Solve 5 basic JavaScript exercises (no TypeScript, no frameworks). Write each requested function.

Return your answers as a SINGLE JSON object with keys "tache_0a", "tache_0b", "tache_0c", "tache_0d" and "tache_0e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 0-A: Return text]
Write a JavaScript function "direBonjour()" that takes no parameters and returns the string "Bonjour".

[EXERCISE 0-B: Return boolean]
Write a JavaScript function "retournerVrai()" that takes no parameters and returns the boolean true.

[EXERCISE 0-C: Return number]
Write a JavaScript function "retourner42()" that takes no parameters and returns the number 42.

[EXERCISE 0-D: Addition]
Write a JavaScript function "additionner(a, b)" that takes two numbers and returns their sum.

[EXERCISE 0-E: Identity function]
Write a JavaScript function "identite(x)" that takes one parameter and returns it exactly as it is.

Expected strict response format:
{
  "tache_0a": "function direBonjour() { ... }",
  "tache_0b": "function retournerVrai() { ... }",
  "tache_0c": "function retourner42() { ... }",
  "tache_0d": "function additionner(a, b) { ... }",
  "tache_0e": "function identite(x) { ... }"
}`,
    tasks: [
      {
        id: "tache_0a", label: "Retourner 'Bonjour'",
        evaluations: [
          { type: "exec", description: "Retourne Bonjour", setup: "", call: "direBonjour()", assert: "result === 'Bonjour'" }
        ]
      },
      {
        id: "tache_0b", label: "Retourner true",
        evaluations: [
          { type: "exec", description: "Retourne true", setup: "", call: "retournerVrai()", assert: "result === true" }
        ]
      },
      {
        id: "tache_0c", label: "Retourner 42",
        evaluations: [
          { type: "exec", description: "Retourne 42", setup: "", call: "retourner42()", assert: "result === 42" }
        ]
      },
      {
        id: "tache_0d", label: "Additionner a et b",
        evaluations: [
          { type: "exec", description: "Addition positive", setup: "", call: "additionner(2, 3)", assert: "result === 5" },
          { type: "exec", description: "Addition négative", setup: "", call: "additionner(-1, 1)", assert: "result === 0" }
        ]
      },
      {
        id: "tache_0e", label: "Identité",
        evaluations: [
          { type: "exec", description: "Identité string", setup: "", call: "identite('test')", assert: "result === 'test'" },
          { type: "exec", description: "Identité number", setup: "", call: "identite(99)", assert: "result === 99" }
        ]
      }
    ]
  },
  {
    tier: 1,
    title: "Tier 1 — CP",
    difficulty: "EASY",
    mandatory_for: ["LIGHT"],
    optional_for: [],
    prompt: `You are taking a TIER 1 technical evaluation.

Solve 5 basic JavaScript exercises.

Return your answers as a SINGLE JSON object with keys "tache_1a", "tache_1b", "tache_1c", "tache_1d" and "tache_1e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 1-A: Subtraction]
Write a JavaScript function "soustraire(a, b)" that subtracts b from a and returns the result.

[EXERCISE 1-B: Greater than 10]
Write a JavaScript function "superieurA10(n)" that returns true if n is strictly greater than 10, false otherwise.

[EXERCISE 1-C: Concatenate]
Write a JavaScript function "concatener(mot1, mot2)" that returns the two words separated by a single space.

[EXERCISE 1-D: Is empty string]
Write a JavaScript function "estVide(chaine)" that returns true if the string is empty (""), false otherwise.

[EXERCISE 1-E: Multiply by 2]
Write a JavaScript function "multiplierPar2(n)" that multiplies the given number by 2 and returns it.

Expected strict response format:
{
  "tache_1a": "function soustraire(a, b) { ... }",
  "tache_1b": "function superieurA10(n) { ... }",
  "tache_1c": "function concatener(mot1, mot2) { ... }",
  "tache_1d": "function estVide(chaine) { ... }",
  "tache_1e": "function multiplierPar2(n) { ... }"
}`,
    tasks: [
      {
        id: "tache_1a", label: "Soustraire b de a",
        evaluations: [
          { type: "exec", description: "Soustraction simple", setup: "", call: "soustraire(5, 3)", assert: "result === 2" },
          { type: "exec", description: "Soustraction négative", setup: "", call: "soustraire(3, 5)", assert: "result === -2" }
        ]
      },
      {
        id: "tache_1b", label: "Supérieur à 10",
        evaluations: [
          { type: "exec", description: "Plus grand que 10", setup: "", call: "superieurA10(15)", assert: "result === true" },
          { type: "exec", description: "Égal à 10", setup: "", call: "superieurA10(10)", assert: "result === false" },
          { type: "exec", description: "Plus petit que 10", setup: "", call: "superieurA10(5)", assert: "result === false" }
        ]
      },
      {
        id: "tache_1c", label: "Concaténer mots",
        evaluations: [
          { type: "exec", description: "Deux mots normaux", setup: "", call: "concatener('Hello', 'World')", assert: "result === 'Hello World'" }
        ]
      },
      {
        id: "tache_1d", label: "Chaîne vide",
        evaluations: [
          { type: "exec", description: "Chaîne vide", setup: "", call: "estVide('')", assert: "result === true" },
          { type: "exec", description: "Chaîne avec espace", setup: "", call: "estVide(' ')", assert: "result === false" },
          { type: "exec", description: "Chaîne normale", setup: "", call: "estVide('abc')", assert: "result === false" }
        ]
      },
      {
        id: "tache_1e", label: "Multiplier par 2",
        evaluations: [
          { type: "exec", description: "Positif", setup: "", call: "multiplierPar2(4)", assert: "result === 8" },
          { type: "exec", description: "Zéro", setup: "", call: "multiplierPar2(0)", assert: "result === 0" },
          { type: "exec", description: "Négatif", setup: "", call: "multiplierPar2(-3)", assert: "result === -6" }
        ]
      }
    ]
  },
  {
    tier: 2,
    title: "Tier 2 — CE1",
    difficulty: "EASY",
    mandatory_for: [],
    optional_for: ["LIGHT"],
    prompt: `You are taking a TIER 2 technical evaluation.

Solve 5 basic JavaScript exercises.

Return your answers as a SINGLE JSON object with keys "tache_2a", "tache_2b", "tache_2c", "tache_2d" and "tache_2e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 2-A: String length]
Write a JavaScript function "longueurChaine(chaine)" that returns the length of the string.

[EXERCISE 2-B: First element]
Write a JavaScript function "premierElement(tableau)" that returns the first element of the array. Return undefined if the array is empty.

[EXERCISE 2-C: Is even]
Write a JavaScript function "estPair(n)" that returns true if the number is even, false otherwise. Use the modulo operator.

[EXERCISE 2-D: Uppercase]
Write a JavaScript function "enMajuscules(chaine)" that converts the string to uppercase and returns it.

[EXERCISE 2-E: Push element]
Write a JavaScript function "ajouterALaFin(tableau, element)" that adds the element to the end of the array and returns the modified array.

Expected strict response format:
{
  "tache_2a": "function longueurChaine(chaine) { ... }",
  "tache_2b": "function premierElement(tableau) { ... }",
  "tache_2c": "function estPair(n) { ... }",
  "tache_2d": "function enMajuscules(chaine) { ... }",
  "tache_2e": "function ajouterALaFin(tableau, element) { ... }"
}`,
    tasks: [
      {
        id: "tache_2a", label: "Longueur chaîne",
        evaluations: [
          { type: "exec", description: "Chaîne normale", setup: "", call: "longueurChaine('test')", assert: "result === 4" },
          { type: "exec", description: "Chaîne vide", setup: "", call: "longueurChaine('')", assert: "result === 0" }
        ]
      },
      {
        id: "tache_2b", label: "Premier élément",
        evaluations: [
          { type: "exec", description: "Tableau non vide", setup: "", call: "premierElement([5, 6, 7])", assert: "result === 5" },
          { type: "exec", description: "Tableau vide", setup: "", call: "premierElement([])", assert: "result === undefined" }
        ]
      },
      {
        id: "tache_2c", label: "Est pair",
        evaluations: [
          { type: "exec", description: "Pair", setup: "", call: "estPair(8)", assert: "result === true" },
          { type: "exec", description: "Impair", setup: "", call: "estPair(3)", assert: "result === false" },
          { type: "exec", description: "Zéro", setup: "", call: "estPair(0)", assert: "result === true" }
        ]
      },
      {
        id: "tache_2d", label: "En majuscules",
        evaluations: [
          { type: "exec", description: "Minuscules", setup: "", call: "enMajuscules('hello')", assert: "result === 'HELLO'" },
          { type: "exec", description: "Déjà majuscules", setup: "", call: "enMajuscules('WORLD')", assert: "result === 'WORLD'" },
          { type: "exec", description: "Vide", setup: "", call: "enMajuscules('')", assert: "result === ''" }
        ]
      },
      {
        id: "tache_2e", label: "Ajouter à la fin",
        evaluations: [
          { type: "exec", description: "Tableau non vide", setup: "", call: "ajouterALaFin([1, 2], 3)", assert: "Array.isArray(result) && result.length === 3 && result[2] === 3" },
          { type: "exec", description: "Tableau vide", setup: "", call: "ajouterALaFin([], 'a')", assert: "Array.isArray(result) && result.length === 1 && result[0] === 'a'" }
        ]
      }
    ]
  },
  {
    tier: 3,
    title: "Tier 3 — CE2",
    difficulty: "EASY",
    mandatory_for: [],
    optional_for: ["LIGHT"],
    prompt: `You are taking a TIER 3 technical evaluation.

Solve 5 basic JavaScript exercises.

Return your answers as a SINGLE JSON object with keys "tache_3a", "tache_3b", "tache_3c", "tache_3d" and "tache_3e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 3-A: Last element]
Write a JavaScript function "dernierElement(tableau)" that returns the last element of the array. Return undefined if the array is empty.

[EXERCISE 3-B: Count to N]
Write a JavaScript function "compterJusqua(n)" that returns an array of numbers from 1 to n. If n < 1, return an empty array.

[EXERCISE 3-C: Replace letter]
Write a JavaScript function "remplacerLettre(mot, ancienne, nouvelle)" that replaces all occurrences of 'ancienne' letter with 'nouvelle' in the word and returns the new word.

[EXERCISE 3-D: Sum array]
Write a JavaScript function "sommeTableau(tableau)" that returns the sum of all numbers in the array. Return 0 if the array is empty.

[EXERCISE 3-E: Contains 'a']
Write a JavaScript function "contientA(mot)" that returns true if the word contains the letter 'a' (case-insensitive), false otherwise.

Expected strict response format:
{
  "tache_3a": "function dernierElement(tableau) { ... }",
  "tache_3b": "function compterJusqua(n) { ... }",
  "tache_3c": "function remplacerLettre(mot, ancienne, nouvelle) { ... }",
  "tache_3d": "function sommeTableau(tableau) { ... }",
  "tache_3e": "function contientA(mot) { ... }"
}`,
    tasks: [
      {
        id: "tache_3a", label: "Dernier élément",
        evaluations: [
          { type: "exec", description: "Tableau", setup: "", call: "dernierElement([1, 2, 3])", assert: "result === 3" },
          { type: "exec", description: "Tableau 1 élém", setup: "", call: "dernierElement([5])", assert: "result === 5" },
          { type: "exec", description: "Tableau vide", setup: "", call: "dernierElement([])", assert: "result === undefined" }
        ]
      },
      {
        id: "tache_3b", label: "Compter jusqu'à N",
        evaluations: [
          { type: "exec", description: "N=3", setup: "", call: "compterJusqua(3)", assert: "JSON.stringify(result) === '[1,2,3]'" },
          { type: "exec", description: "N=0", setup: "", call: "compterJusqua(0)", assert: "JSON.stringify(result) === '[]'" }
        ]
      },
      {
        id: "tache_3c", label: "Remplacer lettre",
        evaluations: [
          { type: "exec", description: "Remplacement normal", setup: "", call: "remplacerLettre('papa', 'p', 'm')", assert: "result === 'mama'" },
          { type: "exec", description: "Pas de match", setup: "", call: "remplacerLettre('test', 'z', 'a')", assert: "result === 'test'" }
        ]
      },
      {
        id: "tache_3d", label: "Somme tableau",
        evaluations: [
          { type: "exec", description: "Nombres", setup: "", call: "sommeTableau([1, 2, 3, 4])", assert: "result === 10" },
          { type: "exec", description: "Vide", setup: "", call: "sommeTableau([])", assert: "result === 0" }
        ]
      },
      {
        id: "tache_3e", label: "Contient 'a'",
        evaluations: [
          { type: "exec", description: "Avec a minuscule", setup: "", call: "contientA('chat')", assert: "result === true" },
          { type: "exec", description: "Avec A majuscule", setup: "", call: "contientA('Arbre')", assert: "result === true" },
          { type: "exec", description: "Sans a", setup: "", call: "contientA('chien')", assert: "result === false" }
        ]
      }
    ]
  },
  {
    tier: 4,
    title: "Tier 4 — CM1",
    difficulty: "EASY",
    mandatory_for: [],
    optional_for: ["LIGHT"],
    prompt: `You are taking a TIER 4 technical evaluation.

Solve 5 basic JavaScript exercises.

Return your answers as a SINGLE JSON object with keys "tache_4a", "tache_4b", "tache_4c", "tache_4d" and "tache_4e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 4-A: Max in array]
Write a JavaScript function "trouverMaximum(tableau)" that takes an array of numbers and returns the largest.

[EXERCISE 4-B: Reverse string]
Write a JavaScript function "inverserChaine(chaine)" that returns the reversed string.

[EXERCISE 4-C: Count vowels]
Write a JavaScript function "compterVoyelles(chaine)" that counts the number of vowels (a, e, i, o, u) in a string. Case-insensitive. Do not count 'y'.

[EXERCISE 4-D: Filter positive]
Write a JavaScript function "filtrerPositifs(tableau)" that returns a new array containing only the strictly positive numbers (> 0) from the input array.

[EXERCISE 4-E: Repeat string]
Write a JavaScript function "repeterChaine(chaine, n)" that repeats the string n times and returns the result. If n <= 0, return an empty string.

Expected strict response format:
{
  "tache_4a": "function trouverMaximum(tableau) { ... }",
  "tache_4b": "function inverserChaine(chaine) { ... }",
  "tache_4c": "function compterVoyelles(chaine) { ... }",
  "tache_4d": "function filtrerPositifs(tableau) { ... }",
  "tache_4e": "function repeterChaine(chaine, n) { ... }"
}`,
    tasks: [
      {
        id: "tache_4a", label: "Maximum",
        evaluations: [
          { type: "exec", description: "Tableau positif", setup: "", call: "trouverMaximum([3, 7, 2])", assert: "result === 7" },
          { type: "exec", description: "Tableau négatif", setup: "", call: "trouverMaximum([-5, -2, -8])", assert: "result === -2" }
        ]
      },
      {
        id: "tache_4b", label: "Inverser",
        evaluations: [
          { type: "exec", description: "Mot normal", setup: "", call: "inverserChaine('abc')", assert: "result === 'cba'" },
          { type: "exec", description: "Vide", setup: "", call: "inverserChaine('')", assert: "result === ''" }
        ]
      },
      {
        id: "tache_4c", label: "Voyelles",
        evaluations: [
          { type: "exec", description: "Avec voyelles", setup: "", call: "compterVoyelles('bonjour')", assert: "result === 3" },
          { type: "exec", description: "Majuscules", setup: "", call: "compterVoyelles('AEIOU')", assert: "result === 5" },
          { type: "exec", description: "Sans voyelles", setup: "", call: "compterVoyelles('xyz')", assert: "result === 0" }
        ]
      },
      {
        id: "tache_4d", label: "Filtrer positifs",
        evaluations: [
          { type: "exec", description: "Mixte", setup: "", call: "filtrerPositifs([-1, 0, 1, 2])", assert: "JSON.stringify(result) === '[1,2]'" },
          { type: "exec", description: "Que négatifs", setup: "", call: "filtrerPositifs([-1, -2])", assert: "JSON.stringify(result) === '[]'" }
        ]
      },
      {
        id: "tache_4e", label: "Répéter",
        evaluations: [
          { type: "exec", description: "Répète 3", setup: "", call: "repeterChaine('a', 3)", assert: "result === 'aaa'" },
          { type: "exec", description: "Répète 0", setup: "", call: "repeterChaine('a', 0)", assert: "result === ''" }
        ]
      }
    ]
  },
  {
    tier: 5,
    title: "Tier 5 — CM2",
    difficulty: "EASY",
    mandatory_for: [],
    optional_for: ["LIGHT"],
    prompt: `You are taking a TIER 5 technical evaluation.

Solve 5 JavaScript exercises.

Return your answers as a SINGLE JSON object with keys "tache_5a", "tache_5b", "tache_5c", "tache_5d" and "tache_5e". Each value must be a plain code string. No explanatory text outside the JSON.

[EXERCISE 5-A: Remove duplicates]
Write a JavaScript function "supprimerDoublons(tableau)" that removes duplicate elements from an array and returns the new array.

[EXERCISE 5-B: Capitalize words]
Write a JavaScript function "capitaliserMots(phrase)" that capitalizes the first letter of each word in a string and returns the new string. Assume words are separated by single spaces.

[EXERCISE 5-C: Character frequency]
Write a JavaScript function "frequenceCaracteres(chaine)" that returns an object where keys are characters and values are the number of times they appear in the string.

[EXERCISE 5-D: Filter even numbers]
Write a JavaScript function "filtrerPairs(tableau)" that returns a new array containing only the even numbers from the input array.

[EXERCISE 5-E: Longest string]
Write a JavaScript function "chaineLaPlusLongue(tableau)" that takes an array of strings and returns the longest string. If the array is empty, return an empty string.

Expected strict response format:
{
  "tache_5a": "function supprimerDoublons(tableau) { ... }",
  "tache_5b": "function capitaliserMots(phrase) { ... }",
  "tache_5c": "function frequenceCaracteres(chaine) { ... }",
  "tache_5d": "function filtrerPairs(tableau) { ... }",
  "tache_5e": "function chaineLaPlusLongue(tableau) { ... }"
}`,
    tasks: [
      {
        id: "tache_5a", label: "Doublons",
        evaluations: [
          { type: "exec", description: "Avec doublons", setup: "", call: "supprimerDoublons([1, 2, 2, 3])", assert: "JSON.stringify(result) === '[1,2,3]'" },
          { type: "exec", description: "Sans doublons", setup: "", call: "supprimerDoublons([1, 2])", assert: "JSON.stringify(result) === '[1,2]'" }
        ]
      },
      {
        id: "tache_5b", label: "Capitaliser",
        evaluations: [
          { type: "exec", description: "Phrase normale", setup: "", call: "capitaliserMots('bonjour le monde')", assert: "result === 'Bonjour Le Monde'" },
          { type: "exec", description: "Un mot", setup: "", call: "capitaliserMots('test')", assert: "result === 'Test'" }
        ]
      },
      {
        id: "tache_5c", label: "Fréquence",
        evaluations: [
          { type: "exec", description: "Mot simple", setup: "", call: "frequenceCaracteres('aba')", assert: "result['a'] === 2 && result['b'] === 1" },
          { type: "exec", description: "Vide", setup: "", call: "frequenceCaracteres('')", assert: "Object.keys(result).length === 0" }
        ]
      },
      {
        id: "tache_5d", label: "Filtrer pairs",
        evaluations: [
          { type: "exec", description: "Mixte", setup: "", call: "filtrerPairs([1, 2, 3, 4])", assert: "JSON.stringify(result) === '[2,4]'" },
          { type: "exec", description: "Que impairs", setup: "", call: "filtrerPairs([1, 3])", assert: "JSON.stringify(result) === '[]'" }
        ]
      },
      {
        id: "tache_5e", label: "Plus longue",
        evaluations: [
          { type: "exec", description: "Tableau normal", setup: "", call: "chaineLaPlusLongue(['a', 'abc', 'ab'])", assert: "result === 'abc'" },
          { type: "exec", description: "Vide", setup: "", call: "chaineLaPlusLongue([])", assert: "result === ''" }
        ]
      }
    ]
  }
];

tiers.forEach(t => {
  const filepath = path.join('c:/Users/Flexodiv/Desktop/benchmark-v3/tiers', `tier${t.tier}_light.json`);
  fs.writeFileSync(filepath, JSON.stringify(t, null, 2), 'utf-8');
  console.log('Created ' + filepath);
});
