// tests/test-path-traversal.js — Non-régression SEC-FILE-01 (protocole
// Admin/Tasks.md §4.3), implémentation P0 session 2026-11-15c.
// Preuves rejouées en test :
//   - la validation centralisée shortName ferme TOUTES les formes de traversée ;
//   - loadLedger n'a plus AUCUN accès disque hors .carnet (preuve historique :
//     shortName = ../../submissions/admin-overrides ne lit plus le fichier) ;
//   - saveLedger refuse d'écrire hors de .carnet (sonde sur un nom inexistant,
//     aucune écriture réelle, cf. §2.2 du protocole : tests non destructifs).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isValidShortName, loadLedger, saveLedger, ledgerPath } = require('../score-ledger');

const cases = [
  { name: 'shortName: les formats réels des carnets restent acceptés' },
  { name: 'shortName: traversées refusées (../ , ..\\ , mélangés, encodés)' },
  { name: 'shortName: absolus, disques, ADS NTFS, NUL, contrôle refusés' },
  { name: 'shortName: noms réservés Windows + point/espace final refusés' },
  { name: 'shortName: unicode/espaces refusés (identifiant strict)' },
  { name: 'ledgerPath: null hors domaine + confinement de la résolution' },
  { name: 'loadLedger: traversée = AUCUN accès disque (preuve admin-overrides)' },
  { name: 'loadLedger: carnet réel du projet reste lisible' },
  { name: 'saveLedger: traversée = écriture REFUSÉE hors .carnet' }
];

function run(c) {
  switch (c.name) {
    case 'shortName: les formats réels des carnets restent acceptés': {
      for (const okName of [
        'kimi-k2.7-code', 'glm-5.3-flash', 'inclusionai_ling-3.0-flash_free',
        'bartowski_minicpm5-2b_q8_0', 'qwen_qwen3.8-max-0902', 'gemma4',
        'deepseek-v4-pro', 'A-upper1_Case'
      ]) {
        assert.ok(isValidShortName(okName), 'doit être accepté : ' + okName);
      }
      break;
    }
    case 'shortName: traversées refusées (../ , ..\\ , mélangés, encodés)': {
      for (const bad of [
        '..', '../evil', '..\\evil', 'a/../b', 'a/../..\\b', '../../submissions/admin-overrides',
        'a%2eb', 'a%2fevil', 'a%5cevil', 'sub/dir', 'sub\\dir'
      ]) {
        assert.ok(!isValidShortName(bad), 'doit être refusé : ' + bad);
      }
      break;
    }
    case 'shortName: absolus, disques, ADS NTFS, NUL, contrôle refusés': {
      for (const bad of [
        'M:\\x', 'M:/x', '/etc/passwd', 'C:', 'CON:x', 'fichier:ads', 'nul',
        'a\u0000b', 'line\nbreak', 'tab\there'
      ]) {
        assert.ok(!isValidShortName(bad), 'doit être refusé : ' + JSON.stringify(bad));
      }
      break;
    }
    case 'shortName: noms réservés Windows + point/espace final refusés': {
      for (const bad of ['CON', 'con', 'NUL.json', 'COM1', 'LPT2', 'carnet.', 'carnet ', 'carnet.\.x']) {
        assert.ok(!isValidShortName(bad), 'doit être refusé : ' + JSON.stringify(bad));
      }
      break;
    }
    case 'shortName: unicode/espaces refusés (identifiant strict)': {
      for (const bad of ['modèle accentué', 'modelé', 'a b', 'électronique']) {
        assert.ok(!isValidShortName(bad), 'doit être refusé : ' + bad);
      }
      assert.ok(!isValidShortName(''));
      assert.ok(!isValidShortName(null));
      assert.ok(!isValidShortName(42));
      assert.ok(!isValidShortName('x'.repeat(121)), 'trop long refusé');
      assert.ok(isValidShortName('x'.repeat(120)), 'longueur max acceptée');
      break;
    }
    case 'ledgerPath: null hors domaine + confinement de la résolution': {
      assert.strictEqual(ledgerPath('../evil'), null);
      assert.strictEqual(ledgerPath('..\\evil'), null);
      assert.strictEqual(ledgerPath('a/../b'), null);
      const good = ledgerPath('kimi-k2.7-code');
      assert.ok(good, 'chemin valide attendu');
      // Ceinture : la résolution finale DOIT rester dans .carnet
      assert.ok(path.resolve(good).indexOf(path.resolve(require('../score-ledger').LEDGER_DIR)) === 0, 'chemin confiné');
      break;
    }
    case 'loadLedger: traversée = AUCUN accès disque (preuve admin-overrides)': {
      // Preuve P0 de l'audit (§4.3) : ce shortName chargeait le JSON neutre
      // hors .carnet (champ _doc). Désormais : aucun accès, struct vide.
      const data = loadLedger('../../submissions/admin-overrides');
      assert.ok(data && data.invalidShortName === true, 'refus explicite attendu');
      assert.ok(!data._doc, 'le contenu hors .carnet ne doit PAS être chargé');
      assert.deepStrictEqual(data.ecoles, {});
      break;
    }
    case 'loadLedger: carnet réel du projet reste lisible': {
      // Auto-lecture d'un carnet existant quelconque (le projet local a des carnets).
      const dir = require('../score-ledger').LEDGER_DIR;
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'classement_snapshot.json') : [];
      if (files.length === 0) return; // rien à vérifier sur un projet vierge
      const baseName = path.basename(files[0], '.json');
      const data = loadLedger(baseName);
      assert.ok(data && data.ecoles, 'carnet réel doit rester lisible (rétro-compat)');
      break;
    }
    case 'saveLedger: traversée = écriture REFUSÉE hors .carnet': {
      // Sonde non destructive (§2.2) : cible INEXISTANTE en dehors de .carnet.
      const target = path.join(__dirname, '..', 'Export-Rapports', 'security-probe-inexistant.json');
      const ledger = { shortName: '../security-probe-inexistant', model: 'sonde', ecoles: {} };
      saveLedger(ledger);
      assert.ok(!fs.existsSync(target), 'AUCUNE écriture hors .carnet ne doit aboutir');
      // Et le backup non plus.
      assert.ok(!fs.existsSync(path.join(__dirname, '..', 'Export-Rapports', '.carnet-backup', 'security-probe-inexistant.json')));
      break;
    }
    default:
      throw new Error('Cas inconnu : ' + c.name);
  }
}

module.exports = { run, cases };
