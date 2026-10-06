// tests/test-arch-warning.js — Tests du registre des incompatibles et de
// l'exception temp-fs (tâche 2026-10-06). Vérifie qu'une erreur TEMPORAIRE de
// fichiers internes LM Studio (ENOENT mkdtemp '.internal\temp\...') n'est
// JAMAIS classée « architecture incompatible » (les modèles sains déjà testés
// au carnet étaient exclus à tort) et que le dossier temp est auto-réparé.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const archWarning = require('../arch-warning');

const cases = [
  { name: 'isArchitectureError: unknown architecture (k2-horizon) → true' },
  { name: 'isArchitectureError: HTTP_400 Failed to load model sans ENOENT → true' },
  { name: 'isArchitectureError: ENOENT mkdtemp (antislashs) → false' },
  { name: 'isArchitectureError: ENOENT mkdtemp (slashs unix) → false' },
  { name: 'isTempFsError: ENOENT mkdtemp chat-template (erreur réelle 2026-10-06) → true' },
  { name: 'isTempFsError: ENOSPC → true' },
  { name: 'isTempFsError: timeout réseau → false' },
  { name: 'isTempFsError: ECONNREFUSED → false' },
  { name: 'ensureLmStudioTempDir: recrée le dossier absent' },
  { name: 'ensureLmStudioTempDir: no-op quand le dossier existe' },
];

function run(c) {
  switch (c.name) {
    case 'isArchitectureError: unknown architecture (k2-horizon) → true': {
      const m = "Failed to load model 'x' — HTTP_400 — unknown model architecture: 'k2-horizon'";
      assert.strictEqual(archWarning.isArchitectureError(m), true, 'k2-horizon est une vraie incompatibilité');
      break;
    }
    case 'isArchitectureError: HTTP_400 Failed to load model sans ENOENT → true': {
      const m = 'HTTP_400 — {"error":{"message":"Failed to load model \'x\'"}}';
      assert.strictEqual(archWarning.isArchitectureError(m), true, 'HTTP_400 sans cause temp-fs = probable arch');
      break;
    }
    case 'isArchitectureError: ENOENT mkdtemp (antislashs) → false': {
      const m = "Failed to load model \"y\". Error: ENOENT: no such file or directory, mkdtemp 'C:\\Users\\X\\.lmstudio\\.internal\\temp\\lmstudio-chat-template-XXXXXX' — HTTP_400";
      assert.strictEqual(archWarning.isArchitectureError(m), false, 'dossier temp manquant ≠ architecture');
      break;
    }
    case 'isArchitectureError: ENOENT mkdtemp (slashs unix) → false': {
      const m = 'HTTP_400 failed to load model ENOENT mkdtemp /Users/x/.lmstudio/.internal/temp/lmstudio-chat-template-XXXXXX';
      assert.strictEqual(archWarning.isArchitectureError(m), false, 'slashs unix : même exception');
      break;
    }
    case 'isTempFsError: ENOENT mkdtemp chat-template (erreur réelle 2026-10-06) → true': {
      const m = String.raw`HTTP_400 — {"error":{"message":"Failed to load model \"ornith-1.5-9b@q6_k\". Error: ENOENT: no such file or directory, mkdtemp 'C:\Users\Flexodiv\.lmstudio\.internal\temp\lmstudio-chat-template-XXXXXX'"}}`;
      assert.strictEqual(archWarning.isTempFsError(m), true, 'erreur réelle du log doit être détectée');
      break;
    }
    case 'isTempFsError: ENOSPC → true': {
      assert.strictEqual(archWarning.isTempFsError('ENOSPC: no space left on device'), true);
      break;
    }
    case 'isTempFsError: timeout réseau → false': {
      assert.strictEqual(archWarning.isTempFsError('Timeout après 30s — le modèle n\'a pas répondu'), false);
      break;
    }
    case 'isTempFsError: ECONNREFUSED → false': {
      assert.strictEqual(archWarning.isTempFsError('ECONNREFUSED 127.0.0.1:1234'), false);
      break;
    }
    case 'ensureLmStudioTempDir: recrée le dossier absent': {
      const dir = path.join(os.homedir(), '.lmstudio', '.internal', 'temp');
      const backup = path.join(os.homedir(), '.lmstudio', '.internal', 'temp_benchgo_test');
      // Simulation : déplace le dossier (comme un nettoyage de disque).
      const moved = fs.existsSync(dir) && !fs.existsSync(backup);
      if (moved) fs.renameSync(dir, backup);
      try {
        const ok = archWarning.ensureLmStudioTempDir(true);
        assert.strictEqual(ok, true, 'la recréation doit réussir');
        assert.strictEqual(fs.existsSync(dir), true, 'le dossier doit exister après ensure');
      } finally {
        // État final sain : dossier présent + backup de test supprimé.
        if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
      }
      break;
    }
    case 'ensureLmStudioTempDir: no-op quand le dossier existe': {
      const dir = path.join(os.homedir(), '.lmstudio', '.internal', 'temp');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      assert.strictEqual(archWarning.ensureLmStudioTempDir(), true, 'dossier présent → true sans erreur');
      assert.strictEqual(fs.existsSync(dir), true);
      break;
    }
  }
}

module.exports = { run, cases };

// Exécution directe : node tests/test-arch-warning.js
if (require.main === module) {
  let fails = 0;
  for (const c of cases) {
    try { run(c); console.log('  ✔ test-arch-warning.js ::', c.name); }
    catch (e) { fails++; console.error('  ✘ test-arch-warning.js ::', c.name, '—', e.message); }
  }
  process.exit(fails ? 1 : 0);
}