// tests/test-parsing.js — Tests de parsing-utils (§4).
const assert = require('assert');
const { stripTS, stripComments, extractJSON, extractCodeRegex } = require('../parsing-utils');

const cases = [
  { name: 'stripTS retire les annotations TypeScript' },
  { name: 'stripComments retire les commentaires ligne' },
  { name: 'stripComments retire les commentaires bloc' },
  { name: 'extractJSON extrait un objet JSON dune réponse bavarde' },
];

function run(c) {
  switch (c.name) {
    case 'stripTS retire les annotations TypeScript': {
      const code = 'function foo(a: number): string { return a.toString(); }';
      const stripped = stripTS(code);
      assert.ok(!stripped.includes(': number'), 'annotation param doit être retirée');
      assert.ok(!stripped.includes(': string'), 'annotation retour doit être retirée');
      break;
    }
    case 'stripComments retire les commentaires ligne': {
      const code = 'const a = 1; // un commentaire\nconst b = 2;';
      const stripped = stripComments(code);
      assert.ok(!stripped.includes('// un commentaire'), 'commentaire ligne doit être retiré');
      assert.ok(stripped.includes('const a = 1'), 'code doit être préservé');
      break;
    }
    case 'stripComments retire les commentaires bloc': {
      const code = 'const a = 1; /* bloc */ const b = 2;';
      const stripped = stripComments(code);
      assert.ok(!stripped.includes('/* bloc */'), 'commentaire bloc doit être retiré');
      break;
    }
    case 'extractJSON extrait un objet JSON dune réponse bavarde': {
      const raw = 'Voici ma réponse:\n```json\n{"id": "t1", "code": "function f(){ return 1; }"}\n```\nFin.';
      const json = extractJSON(raw);
      const obj = JSON.parse(json);
      assert.strictEqual(obj.id, 't1');
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { cases, run };