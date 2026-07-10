function unescapeJSONString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch (e) {
    return raw
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function extractJSON(text) {
  if (!text) throw new Error('Réponse vide, impossible d\'extraire du JSON.');
  let candidate = text.trim();

  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Aucun objet JSON détecté dans la réponse.');
  }

  const jsonSlice = candidate.substring(firstBrace, lastBrace + 1);
  JSON.parse(jsonSlice); // Lève une erreur si invalide, valide donc l'extraction.
  return jsonSlice;
}

function extractCodeRegex(text, taskId) {
  if (!text || !taskId) return null;

  const keyPattern = new RegExp(`"${taskId}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'gi');
  const keyMatches = [...text.matchAll(keyPattern)];
  if (keyMatches.length > 0) {
    return unescapeJSONString(keyMatches[keyMatches.length - 1][1]);
  }

  const fencePattern = new RegExp(`${taskId}[\\s\\S]{0,200}?\`\`\`(?:\\w+)?\\s*([\\s\\S]*?)\`\`\``, 'gi');
  const fenceMatches = [...text.matchAll(fencePattern)];
  if (fenceMatches.length > 0) {
    return fenceMatches[fenceMatches.length - 1][1].trim();
  }

  return null;
}

/**
 * Scanner contextuel qui supprime les annotations de type TypeScript
 * (": Type") SANS casser le JavaScript valide.
 *
 * Règles de contexte :
 *  - À l'intérieur des parenthèses ()     → paramètre de fonction → STRIP
 *  - Après let/const/var identificateur    → déclaration de variable  → STRIP
 *  - Après un '?' non appairé               → opérateur ternaire      → NE PAS STRIP
 *  - À l'intérieur des accolades {}        → littéral objet / label   → NE PAS STRIP
 *  - Après case/default                     → label de switch         → NE PAS STRIP
 *
 * Remplace l'ancienne règle 8 regex qui cassait les ternaires
 * (ex: `cond ? a : null` → `cond ? a` → SyntaxError) et les littéraux objet.
 */
function stripTypeAnnotations(code) {
  let result = '';
  let i = 0;
  const len = code.length;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let ternaryDepth = 0;

  function isAfterVarDeclaration() {
    const trimmed = result.replace(/\s+$/, '');
    return /\b(?:let|const|var)\s+\w+(?:\s*,\s*\w+)*$/.test(trimmed);
  }

  function isAfterCaseOrDefault() {
    const trimmed = result.replace(/\s+$/, '');
    return /\b(?:case|default)\s*$/.test(trimmed);
  }

  while (i < len) {
    const ch = code[i];

    // --- Sauter les chaînes ---
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result += ch; i++;
      while (i < len) {
        if (code[i] === '\\') {
          result += code[i]; i++;
          if (i < len) { result += code[i]; i++; }
          continue;
        }
        if (quote === '`' && code[i] === '$' && i + 1 < len && code[i + 1] === '{') {
          result += code[i]; i++;
          result += code[i]; i++;
          let d = 1;
          while (i < len && d > 0) {
            if (code[i] === '{') d++;
            else if (code[i] === '}') d--;
            result += code[i]; i++;
          }
          continue;
        }
        if (code[i] === quote) { result += code[i]; i++; break; }
        result += code[i]; i++;
      }
      continue;
    }

    // --- Sauter les commentaires ligne ---
    if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
      while (i < len && code[i] !== '\n') { result += code[i]; i++; }
      continue;
    }

    // --- Sauter les commentaires bloc ---
    if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
      result += code[i]; i++;
      result += code[i]; i++;
      while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) {
        result += code[i]; i++;
      }
      if (i < len) { result += code[i]; i++; }
      if (i < len) { result += code[i]; i++; }
      continue;
    }

    // --- Suivi des crochets et reset ternaire aux frontières ---
    if (ch === '(') { parenDepth++; ternaryDepth = 0; result += ch; i++; continue; }
    if (ch === ')') { parenDepth--; ternaryDepth = 0; result += ch; i++; continue; }
    if (ch === '[') { bracketDepth++; result += ch; i++; continue; }
    if (ch === ']') { bracketDepth--; result += ch; i++; continue; }
    if (ch === '{') { braceDepth++; ternaryDepth = 0; result += ch; i++; continue; }
    if (ch === '}') { braceDepth--; ternaryDepth = 0; result += ch; i++; continue; }
    if (ch === ';') { ternaryDepth = 0; result += ch; i++; continue; }

    // --- Suivi de l'opérateur ternaire '?' (mais pas '?.', '?=', '?<') ---
    if (ch === '?' && i + 1 < len && code[i + 1] !== '.' && code[i + 1] !== '=' && code[i + 1] !== '<') {
      ternaryDepth++;
      result += ch; i++; continue;
    }

    // --- Traitement du ':' ---
    if (ch === ':') {
      // Ternaire ':' — ne pas stripper
      if (ternaryDepth > 0) {
        ternaryDepth--;
        result += ch; i++; continue;
      }

      // Label de switch ou label nommé — ne pas stripper
      if (isAfterCaseOrDefault()) {
        result += ch; i++; continue;
      }

      // Annotation de type : seulement dans les listes de paramètres (entre parenthèses)
      // ou après une déclaration de variable (let/const/var)
      const isParamType = parenDepth > 0 && braceDepth === 0;
      const isVarType = isAfterVarDeclaration();

      if (isParamType || isVarType) {
        // Stripper l'annotation : avancer du ':' jusqu'au prochain terminator
        i++; // skip ':'
        while (i < len && /\s/.test(code[i])) i++;
        let tParen = 0, tBracket = 0, tBrace = 0, tAngle = 0;
        while (i < len) {
          const tc = code[i];
          if (tParen === 0 && tBracket === 0 && tBrace === 0 && tAngle === 0) {
            if (tc === ',' || tc === ')' || tc === ';' || tc === '=' || tc === '\n') break;
            if (tc === '{') break;
            if (tc === '=' && i + 1 < len && code[i + 1] === '>') {
              tAngle++; i++; result += tc; i++; continue;
            }
          }
          if (tc === '(') tParen++;
          else if (tc === ')') tParen--;
          else if (tc === '[') tBracket++;
          else if (tc === ']') tBracket--;
          else if (tc === '{') tBrace++;
          else if (tc === '}') tBrace--;
          else if (tc === '<') tAngle++;
          else if (tc === '>') tAngle--;
          i++;
        }
        continue; // type supprimé
      }

      // Littéral objet, label, etc. — ne pas stripper
      result += ch; i++; continue;
    }

    result += ch; i++;
  }

  return result;
}

/**
 * Supprime l'annotation de type de retour d'une fonction en gérant les types
 * contenant des accolades imbriquées (ex: Promise<{ x: number }>).
 * Cherche le pattern ): ...suivi de terminator ('{' ou '=>') et supprime
 * tout ce qui est entre ) et le terminator, en respectant la profondeur des {}.
 */
function stripReturnTypeAnnotation(code, terminator) {
  let result = '';
  let i = 0;
  while (i < code.length) {
    // Cherche le pattern ): avec possiblement des espaces
    if (code[i] === ')' && i + 1 < code.length && code[i + 1] === ':') {
      // Vérifie qu'on est bien dans un contexte de type de retour de fonction
      // (pas un objet littéral). On regarde en arrière pour voir si on a une
      // fermeture de parenthèse de paramètres de fonction.
      let j = i + 2;
      // Skip espaces après les deux-points
      while (j < code.length && (code[j] === ' ' || code[j] === '\t')) j++;

      // Maintenant on doit scanner le type en gérant la profondeur des accolades
      let depth = 0;
      let angleDepth = 0;
      let foundTerminator = false;
      let typeStart = j;

      while (j < code.length) {
        const ch = code[j];

        // Vérifie le terminator à profondeur 0 AVANT de modifier la profondeur
        if (depth === 0 && angleDepth === 0) {
          if (terminator === '{' && ch === '{') {
            foundTerminator = true;
            break;
          }
          if (terminator === '=>' && ch === '=' && j + 1 < code.length && code[j + 1] === '>') {
            foundTerminator = true;
            j++; // Skip le '>'
            break;
          }
        }

        // Modifie la profondeur APRÈS la vérification du terminator
        // Tracke les {} pour les types d'objet et les <> pour les génériques
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '<') angleDepth++;
        else if (ch === '>') angleDepth--;

        j++;
      }

      if (foundTerminator) {
        // Garde la ')' et le terminator mais supprime le type entre les deux
        result += ')';
        if (terminator === '{') {
          // Remet l'espace avant l'accolade si nécessaire
          result += ' ';
          i = j; // Position sur le '{'
        } else {
          result += ' =>';
          i = j + 1; // Après le '>'
        }
        continue;
      }
    }
    result += code[i];
    i++;
  }
  return result;
}

function stripTS(code) {
  if (!code) return '';
  let result = code;

  // 1. Supprime les imports ES modules (mono et multi-lignes)
  result = result.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]*['"]\s*;?\s*$/gm, '');
  result = result.replace(/^\s*import\s+['"][^'"]*['"]\s*;?\s*$/gm, '');

  // 2. Supprime le mot-clé "export" (et "export default")
  result = result.replace(/\bexport\s+(default\s+)?/g, '');

  // 3. Supprime les blocs "interface Nom { ... }" (avec accolades imbriquées)
  result = result.replace(/interface\s+\w+\s*(?:extends\s+[\w\s,]+)?\{[^}]*\}/g, '');

  // 4. Supprime les alias de type "type X = ...;"
  result = result.replace(/^\s*type\s+\w+(?:<[^>]*>)?\s*=\s*[^;]+;/gm, '');

  // 5. Supprime les assertions "as Type"
  result = result.replace(/\bas\s+[\w.<>\[\]|&\s]+(?=[\s,;)\]}])/g, '');

  // 6. Supprime les types de fonction en paramètre : paramName: (args) => ReturnType
  result = result.replace(/(\w)\s*:\s*\([^)]*\)\s*=>\s*[\w.<>\[\]|&\s]+/g, '$1');

  // 7. Supprime les annotations de type de retour de fonction ): Type {  ou  ): Type =>
  //    Utilise un compteur de profondeur pour gérer les types avec accolades (ex: Promise<{...}>)
  result = stripReturnTypeAnnotation(result, '{');
  result = stripReturnTypeAnnotation(result, '=>');

  // 8. Supprime les annotations de type ": Type" après un identifiant/paramètre.
  //    Utilise un scanner contextuel (pas une regex) pour éviter de casser les
  //    opérateurs ternaires (? a : b) et les littéraux objet ({ key: value }).
  result = stripTypeAnnotations(result);

  // 9. Supprime les génériques "<T>" accolés à un identifiant suivi d'une parenthèse
  result = result.replace(/(\w)<[\w\s,]+>(\s*\()/g, '$1$2');

  // 10. Supprime les modificateurs d'accès TypeScript
  result = result.replace(/\b(public|private|protected|readonly)\s+/g, '');

  // 11. Supprime les assertions non-null TypeScript (! postfix après ) ou ])
  result = result.replace(/(\)|\])\s*!(?!=)/g, '$1');

  return result;
}

module.exports = {
  extractJSON,
  extractCodeRegex,
  stripTS
};