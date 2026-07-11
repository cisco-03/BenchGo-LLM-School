const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TIERS_DIR = path.join(__dirname, 'tiers');

const ALGO_HEADER = '\n\n[ALGORITHMIC EXERCISES — code pur, sans culture générale]\n' +
  'Return each function using a Markdown header (### <exercise id>) followed by a ```javascript code block.';

const E = (type, description, call, assert, setup = '') => ({ type, description, setup, call, assert });

const EXERCISE_BANK = {
  0: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Parité",
      hint: "Un nombre est pair si le reste de sa division par 2 vaut 0 : n % 2 === 0.",
      prompt: 'Write a JavaScript function "estPair(n)" that returns true if n is even, false otherwise.',
      evaluations: [
        E('exec', 'Pair', 'estPair(4)', 'result === true'),
        E('exec', 'Impair', 'estPair(7)', 'result === false')
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — Carré",
      hint: "Le carré d'un nombre est le nombre multiplié par lui-même : n * n.",
      prompt: 'Write a JavaScript function "carre(n)" that returns n multiplied by itself.',
      evaluations: [
        E('exec', 'Positif', 'carre(6)', 'result === 36'),
        E('exec', 'Zéro', 'carre(0)', 'result === 0')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Somme 1..N",
      hint: "Boucle de 1 à n en accumulant, ou formule n * (n + 1) / 2.",
      prompt: 'Write a JavaScript function "somme1aN(n)" that returns the sum of all integers from 1 to n (n >= 1).',
      evaluations: [
        E('exec', 'Somme 5', 'somme1aN(5)', 'result === 15'),
        E('exec', 'Somme 1', 'somme1aN(1)', 'result === 1')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Inversion de chaîne",
      hint: "s.split(\"\").reverse().join(\"\") inverse les caractères d'une chaîne.",
      prompt: 'Write a JavaScript function "inverserChaine(s)" that returns the string reversed (e.g. "abc" -> "cba").',
      evaluations: [
        E('exec', 'Mot', "inverserChaine('abc')", "result === 'cba'"),
        E('exec', 'Un caractère', "inverserChaine('x')", "result === 'x'")
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Maximum d'un tableau",
      hint: "Parcourez en gardant la plus grande valeur, ou Math.max(...tab).",
      prompt: 'Write a JavaScript function "valeurMax(tab)" that returns the largest number in a non-empty array.',
      evaluations: [
        E('exec', 'Positifs', 'valeurMax([3, 9, 2])', 'result === 9'),
        E('exec', 'Négatifs', 'valeurMax([-1, -5, -3])', 'result === -1')
      ]
    }
  ],

  1: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Multiplicité",
      hint: "n est multiple de m si n % m === 0 (et m !== 0).",
      prompt: 'Write a JavaScript function "estMultipleDe(n, m)" that returns true if n is a multiple of m (m !== 0), false otherwise.',
      evaluations: [
        E('exec', 'Multiple', 'estMultipleDe(10, 5)', 'result === true'),
        E('exec', 'Non multiple', 'estMultipleDe(7, 3)', 'result === false')
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — Puissance",
      hint: "Multipliez base par lui-même exp fois, ou utilisez l'opérateur **.",
      prompt: 'Write a JavaScript function "puissance(base, exp)" that returns base raised to the power exp (exp >= 0).',
      evaluations: [
        E('exec', '2^3', 'puissance(2, 3)', 'result === 8'),
        E('exec', '5^0', 'puissance(5, 0)', 'result === 1')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Comptage de pairs",
      hint: "Filtrez les éléments pairs (x % 2 === 0) et comptez-les.",
      prompt: 'Write a JavaScript function "compterPairs(tab)" that returns the count of even numbers in the array.',
      evaluations: [
        E('exec', 'Mixte', 'compterPairs([1, 2, 3, 4])', 'result === 2'),
        E('exec', 'Aucun pair', 'compterPairs([1, 3, 5])', 'result === 0')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Suppression de doublons",
      hint: "Gardez la première occurrence : Set ou filter((v, i) => tab.indexOf(v) === i).",
      prompt: 'Write a JavaScript function "supprimerDoublons(tab)" that returns a new array with duplicates removed, preserving first occurrence order.',
      evaluations: [
        E('exec', 'Avec doublons', 'supprimerDoublons([1, 2, 2, 3])', "JSON.stringify(result) === '[1,2,3]'"),
        E('exec', 'Tous identiques', 'supprimerDoublons([5, 5, 5])', "JSON.stringify(result) === '[5]'")
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Somme des pairs",
      hint: "Filtrez les pairs puis réduisez par somme (ou boucle accumulatrice).",
      prompt: 'Write a JavaScript function "sommePaires(tab)" that returns the sum of all even numbers in the array.',
      evaluations: [
        E('exec', 'Mixte', 'sommePaires([1, 2, 3, 4])', 'result === 6'),
        E('exec', 'Aucun pair', 'sommePaires([1, 3])', 'result === 0')
      ]
    }
  ],

  2: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Palindrome",
      hint: "Comparez s à son inverse : s.split(\"\").reverse().join(\"\").",
      prompt: 'Write a JavaScript function "estPalindrome(s)" that returns true if the string reads the same backward (case-sensitive).',
      evaluations: [
        E('exec', 'Palindrome', "estPalindrome('kayak')", 'result === true'),
        E('exec', 'Non palindrome', "estPalindrome('chat')", 'result === false')
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — PGCD",
      hint: "Algorithme d'Euclide : tant que b !== 0, [a, b] = [b, a % b] ; renvoyez a.",
      prompt: 'Write a JavaScript function "pgcd(a, b)" that returns the greatest common divisor of a and b (both > 0).',
      evaluations: [
        E('exec', '48 et 18', 'pgcd(48, 18)', 'result === 6'),
        E('exec', 'Premiers entre eux', 'pgcd(7, 5)', 'result === 1')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Nombre de mots",
      hint: "s.trim().split(/\\s+/).filter(Boolean).length donne le nombre de mots.",
      prompt: 'Write a JavaScript function "nombreMots(s)" that returns the number of words separated by whitespace. Ignore leading/trailing spaces.',
      evaluations: [
        E('exec', '3 mots', "nombreMots('le chat noir')", 'result === 3'),
        E('exec', '1 mot', "nombreMots('un')", 'result === 1')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Fusion triée",
      hint: "Deux pointeurs : comparez les têtes et prenez la plus petite à chaque pas.",
      prompt: 'Write a JavaScript function "fusionTriee(a, b)" that merges two already-sorted arrays into one sorted array.',
      evaluations: [
        E('exec', 'Deux tableaux', 'fusionTriee([1, 3], [2, 4])', "JSON.stringify(result) === '[1,2,3,4]'"),
        E('exec', 'Un vide', 'fusionTriee([], [1])', "JSON.stringify(result) === '[1]'")
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Anagrammes",
      hint: "Triez les caractères des deux chaînes et comparez-les.",
      prompt: 'Write a JavaScript function "sontAnagrammes(a, b)" that returns true if a and b are anagrams (same letters rearranged, case-sensitive).',
      evaluations: [
        E('exec', 'Anagrammes', "sontAnagrammes('chien', 'niche')", 'result === true'),
        E('exec', 'Pas anagrammes', "sontAnagrammes('a', 'b')", 'result === false')
      ]
    }
  ],

  3: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Parenthèses valides",
      hint: "Compteur +1 pour '(' et -1 pour ')' ; invalide si négatif ou non nul à la fin.",
      prompt: 'Write a JavaScript function "validerParentheses(s)" that returns true if the parentheses in s are balanced (only "(" and ")" are considered).',
      evaluations: [
        E('exec', 'Balancées', "validerParentheses('()')", 'result === true'),
        E('exec', 'Non fermée', "validerParentheses('(')", 'result === false'),
        E('exec', 'Inversées', "validerParentheses(')(')", 'result === false')
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — Fibonacci",
      hint: "fib(0)=0, fib(1)=1, fib(n)=fib(n-1)+fib(n-2). Itérez pour éviter la complexité exponentielle.",
      prompt: 'Write a JavaScript function "fibonacci(n)" that returns the n-th Fibonacci number, with fibonacci(0)=0 and fibonacci(1)=1.',
      evaluations: [
        E('exec', 'fib(7)', 'fibonacci(7)', 'result === 13'),
        E('exec', 'fib(0)', 'fibonacci(0)', 'result === 0')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Mots uniques",
      hint: "Construisez un Set des mots (split sur les espaces) et renvoyez sa taille.",
      prompt: 'Write a JavaScript function "motsUniques(s)" that returns the number of distinct words (separated by whitespace) in the string.',
      evaluations: [
        E('exec', 'Répétition', "motsUniques('a a b')", 'result === 2'),
        E('exec', 'Un seul', "motsUniques('hello')", 'result === 1')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Aplatir un tableau",
      hint: "Utilisez .flat(1), ou concaténez chaque sous-tableau avec .concat / spread.",
      prompt: 'Write a JavaScript function "aplatirTableau(tab)" that flattens an array of arrays by one level (e.g. [[1,2],[3]] -> [1,2,3]).',
      evaluations: [
        E('exec', 'Imbriqué', 'aplatirTableau([[1, 2], [3]])', "JSON.stringify(result) === '[1,2,3]'"),
        E('exec', 'Vide', 'aplatirTableau([])', "JSON.stringify(result) === '[]'")
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Rotation à droite",
      hint: "tab.slice(-k).concat(tab.slice(0, -k)) effectue une rotation droite de k.",
      prompt: 'Write a JavaScript function "rotationDroite(tab, k)" that returns the array rotated right by k positions (e.g. [1,2,3,4], 1 -> [4,1,2,3]).',
      evaluations: [
        E('exec', 'Rotation 1', 'rotationDroite([1, 2, 3, 4], 1)', "JSON.stringify(result) === '[4,1,2,3]'"),
        E('exec', 'Pas de rotation', 'rotationDroite([1, 2, 3], 0)', "JSON.stringify(result) === '[1,2,3]'")
      ]
    }
  ],

  4: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Capitaliser les mots",
      hint: "Pour chaque mot : charAt(0).toUpperCase() + slice(1).toLowerCase(), puis join(' ').",
      prompt: 'Write a JavaScript function "capitaliserMots(s)" that capitalizes the first letter of each word and lowercases the rest (words separated by single spaces).',
      evaluations: [
        E('exec', 'Deux mots', "capitaliserMots('bonjour monde')", "result === 'Bonjour Monde'"),
        E('exec', 'Majuscules', "capitaliserMots('HELLO')", "result === 'Hello'")
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — Somme des chiffres",
      hint: "Convertir en chaîne et additionner Number(c) de chaque caractère, ou modulo 10 et division.",
      prompt: 'Write a JavaScript function "sommeChiffres(n)" that returns the sum of the decimal digits of n (n >= 0).',
      evaluations: [
        E('exec', '1234', 'sommeChiffres(1234)', 'result === 10'),
        E('exec', 'Zéro', 'sommeChiffres(0)', 'result === 0')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Grouper par parité",
      hint: "Retournez { pairs: tab.filter(x => x % 2 === 0), impairs: tab.filter(x => x % 2 !== 0) }.",
      prompt: 'Write a JavaScript function "grouperParParite(tab)" that returns an object { pairs: [even numbers], impairs: [odd numbers] } preserving order.',
      evaluations: [
        E('exec', 'Mixte', 'grouperParParite([2, 4, 5])', 'result.pairs.length === 2 && result.impairs.length === 1'),
        E('exec', 'Tous pairs', 'grouperParParite([2, 4, 6])', 'result.pairs.length === 3 && result.impairs.length === 0')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Mot le plus long",
      hint: "Split par espaces, gardez le mot de longueur maximale (premier en cas d'égalité).",
      prompt: 'Write a JavaScript function "plusLongMot(s)" that returns the longest word (separated by spaces). On a tie, return the first one. Return "" for an empty string.',
      evaluations: [
        E('exec', 'Phrase', "plusLongMot('le chat noir superbe')", "result === 'superbe'"),
        E('exec', 'Égalité', "plusLongMot('aa bb')", "result === 'aa'")
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Médiane",
      hint: "Triez d'abord, puis prenez le milieu (ou moyenne des deux milieux pour longueur paire).",
      prompt: 'Write a JavaScript function "mediane(tab)" that returns the median of an array of numbers. Odd length: the middle value; even length: the average of the two middle values.',
      evaluations: [
        E('exec', 'Impair', 'mediane([1, 2, 3])', 'result === 2'),
        E('exec', 'Pair', 'mediane([1, 2, 3, 4])', 'result === 2.5')
      ]
    }
  ],

  5: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Conversion de base",
      hint: "n.toString(base) renvoie la représentation en base donnée (lettres minuscules au-delà de 9).",
      prompt: 'Write a JavaScript function "convertirBase(n, base)" that converts a non-negative integer n to its string representation in the given base (2-16). Use lowercase letters for digits above 9.',
      evaluations: [
        E('exec', 'Base 16', 'convertirBase(255, 16)', "result === 'ff'"),
        E('exec', 'Base 2', 'convertirBase(10, 2)', "result === '1010'")
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — K-ième plus grand",
      hint: "Valeurs distinctes triées décroissant, indice k-1.",
      prompt: 'Write a JavaScript function "kemePlusGrand(tab, k)" that returns the k-th largest distinct value (1-indexed). Assume valid k.',
      evaluations: [
        E('exec', '2e plus grand', 'kemePlusGrand([3, 1, 4, 1, 5], 2)', 'result === 4'),
        E('exec', '1er plus grand', 'kemePlusGrand([10, 20, 30], 1)', 'result === 30')
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Fréquence des éléments",
      hint: "Boucle for...of avec un objet accumulant les comptes : obj[v] = (obj[v] || 0) + 1.",
      prompt: 'Write a JavaScript function "compteurFrequence(tab)" that returns an object mapping each element to its count in the array.',
      evaluations: [
        E('exec', 'Chaînes', "compteurFrequence(['a', 'b', 'a'])", "result['a'] === 2 && result['b'] === 1"),
        E('exec', 'Nombres', 'compteurFrequence([1, 1, 2, 2, 2])', 'result[1] === 2 && result[2] === 3')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Exponentiation rapide",
      hint: "Si n pair : (x*x)^(n/2) ; si n impair : x * x^(n-1) ; cas n=0 -> 1.",
      prompt: 'Write a JavaScript function "exponentiationRapide(x, n)" that returns x raised to n (n >= 0) using fast exponentiation (exponentiation by squaring).',
      evaluations: [
        E('exec', '2^10', 'exponentiationRapide(2, 10)', 'result === 1024'),
        E('exec', '5^0', 'exponentiationRapide(5, 0)', 'result === 1')
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Sous-tableau de somme max",
      hint: "Algorithme de Kadane : max global et max se terminant à l'indice courant.",
      prompt: 'Write a JavaScript function "sousTableauMax(tab)" that returns the maximum sum of any contiguous subarray (Kadane algorithm).',
      evaluations: [
        E('exec', 'Classique', 'sousTableauMax([-2, 1, -3, 4, -1, 2, 1, -5, 4])', 'result === 6'),
        E('exec', 'Tous positifs', 'sousTableauMax([1, 2, 3])', 'result === 6')
      ]
    }
  ],

  6: [
    {
      id: 'algo_facile_1', points: 10,
      label: "Algorithmique — Fusion d'intervalles",
      hint: "Triez par début, puis fusionnez quand début courant <= fin précédente.",
      prompt: 'Write a JavaScript function "fusionnerIntervalles(tab)" that takes an array of [start, end] intervals and merges overlapping ones. Return the merged array sorted by start (e.g. [[1,3],[2,6]] -> [[1,6]]).',
      evaluations: [
        E('exec', 'Chevauchants', 'fusionnerIntervalles([[1, 3], [2, 6]])', "JSON.stringify(result) === '[[1,6]]'"),
        E('exec', 'Séparés', 'fusionnerIntervalles([[1, 4], [5, 6]])', "JSON.stringify(result) === '[[1,4],[5,6]]'")
      ]
    },
    {
      id: 'algo_facile_2', points: 10,
      label: "Algorithmique — Plus long préfixe commun",
      hint: "Comparez caractère par caractère à travers toutes les chaînes.",
      prompt: 'Write a JavaScript function "prefixeCommun(tab)" that returns the longest common prefix string among all strings in the array.',
      evaluations: [
        E('exec', 'Préfixe "fl"', "prefixeCommun(['flottant', 'fleur', 'fleuve'])", "result === 'fl'"),
        E('exec', 'Aucun', "prefixeCommun(['a', 'b'])", "result === ''")
      ]
    },
    {
      id: 'algo_moyen_1', points: 10,
      label: "Algorithmique — Nombre de bits à 1",
      hint: "n.toString(2) puis compter les '1', ou boucle n &= (n - 1).",
      prompt: 'Write a JavaScript function "nombreDeBits1(n)" that returns the number of 1 bits in the binary representation of a non-negative integer n.',
      evaluations: [
        E('exec', '7 = 111', 'nombreDeBits1(7)', 'result === 3'),
        E('exec', '0', 'nombreDeBits1(0)', 'result === 0')
      ]
    },
    {
      id: 'algo_difficile_1', points: 15,
      label: "Algorithmique — Médiane de deux tableaux triés",
      hint: "Recherche binaire sur le plus petit tableau pour couper en O(log(min(n, m))).",
      prompt: 'Write a JavaScript function "medianeDeuxTries(a, b)" that returns the median of two sorted arrays combined.',
      evaluations: [
        E('exec', 'Impair total', 'medianeDeuxTries([1, 3], [2])', 'result === 2'),
        E('exec', 'Pair total', 'medianeDeuxTries([1, 2], [3, 4])', 'result === 2.5')
      ]
    },
    {
      id: 'algo_defi', points: 15,
      label: "Algorithmique — Plus longue sous-suite croissante",
      hint: "Programmation dynamique O(n^2) ou patience sorting O(n log n).",
      prompt: 'Write a JavaScript function "plusLongueSousSuiteCroissante(tab)" that returns the LENGTH of the longest strictly increasing subsequence.',
      evaluations: [
        E('exec', 'Classique', 'plusLongueSousSuiteCroissante([10, 9, 2, 5, 3, 7, 101, 18])', 'result === 4'),
        E('exec', 'Déjà trié', 'plusLongueSousSuiteCroissante([1, 2, 3])', 'result === 3')
      ]
    }
  ]
};

function buildAlgoTasks(tierNum) {
  const bank = EXERCISE_BANK[tierNum];
  if (!bank) return [];
  return bank.map(ex => ({
    id: ex.id,
    label: ex.label,
    points: ex.points,
    hint: ex.hint,
    evaluations: ex.evaluations
  }));
}

function buildAlgoPromptBlock(tierNum) {
  const bank = EXERCISE_BANK[tierNum];
  if (!bank) return '';
  let block = ALGO_HEADER;
  for (const ex of bank) {
    block += '\n\n[EXERCISE ' + ex.id + ']\n' + ex.prompt;
  }
  return block;
}

function updateTiers() {
  const files = fs.readdirSync(TIERS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(TIERS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let modified = false;

      if (!data.tasks) { data.tasks = []; modified = true; }

      data.tasks.forEach(task => {
        if (task.points === undefined) { task.points = 8; modified = true; }
      });

      const tierNum = data.tier !== undefined ? data.tier : null;
      const algoTasks = buildAlgoTasks(tierNum);
      const algoPrompt = buildAlgoPromptBlock(tierNum);

      if (algoTasks.length > 0) {
        const oldAlgo = data.tasks.filter(t => String(t.id).startsWith('algo_'));
        const nonAlgo = data.tasks.filter(t => !String(t.id).startsWith('algo_'));
        if (JSON.stringify(oldAlgo) !== JSON.stringify(algoTasks)) {
          data.tasks = nonAlgo.concat(algoTasks);
          modified = true;
        }
      }

      if (algoPrompt) {
        let basePrompt = data.prompt || '';
        const idx = basePrompt.indexOf(ALGO_HEADER);
        if (idx !== -1) basePrompt = basePrompt.slice(0, idx);
        const newPrompt = basePrompt + algoPrompt;
        if (newPrompt !== (data.prompt || '')) {
          data.prompt = newPrompt;
          modified = true;
        }
      }

      if (modified) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        logger.info("Tiers mis à jour (exercices d'algorithmique réels) : " + file);
      }
    } catch (e) {
      logger.error('Erreur lors de la mise à jour de ' + file + ' : ' + e.message);
    }
  }
}

module.exports = { updateTiers };
