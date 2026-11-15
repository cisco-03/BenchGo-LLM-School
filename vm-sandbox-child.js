// vm-sandbox-child.js — Processus JETABLE pour l'exécution du code élève.
// (SEC-VM-01 / SEC-VM-02, protocole Admin/Tasks.md — implémentation P0 avec
// feu vert explicite de l'utilisateur, session 2026-11-15c.)
//
// PRINCIPE : le processus parent (runner, benchmark) ne JAMAIS exécuter de code
// produit par un modèle. Chaque évaluation `exec` est envoyée à un enfant Node
// qui vit le temps d'une seule évaluation :
//   - environnement nettoyé (liste blanche : ni clé API, ni PAT, ni HOME) ;
//   - dossier de travail vide dans le tempdir système ;
//   - mécanisme plafonné par le PARENT sur toutes les phases (l'enfant peut
//     être tué à tout instant, son verdict devient un simple échec borné) ;
//   - globals réseau neutralisés (fetch, WebSocket, XHR, Worker) ;
//   - chemins vers les modules natifs fermés (process.getBuiltinModule,
//     process.mainModule, process.binding, process.dlopen) — le code qui
//     réussirait à s'échapper du contexte VM n'a plus de route vers fs/net ;
//   - résultat écrit sur un canal dédié (fd 3) protégé par un nonce aléatoire :
//     un code qui polluerait stdout ne peut pas forger un verdict.
//
// Le protocole exige de plus une isolation OS réelle (compte restreint/ACL/Job
// Object) pour la confidentialité complète : c'est la suite P1 — l'isolation
// processus ci-dessus supprime déjà secrets/argv/env et borne temps/mémoire/sortie.
//
// Protocole d'échange (une requête, une réponse) :
//   parent → stdin : { v, nonce, code, setup, callExpr, assertExpr, timeout } + '\n'
//   enfant → fd 3  : __BENCHGO_VM_RESULT__{ json } + '\n'

const fs = require('fs');
const path = require('path');
// Le journal de l'enfant va dans UN fichier fixe (chaque spawn serait un
// processus neuf : sans redirection, 486 vérifications créeraient autant de
// fichiers journaux horodatés).
const logger = require('./logger');
logger.setLogFile(path.join(__dirname, 'logs', 'vm-sandbox-child.log'));

const RESULT_PREFIX = '__BENCHGO_VM_RESULT__';
const MAX_RESULT_CHARS = 65000;

function writeResult(envelope) {
  let payload = null;
  try {
    payload = JSON.stringify(envelope);
  } catch (e) {
    payload = JSON.stringify({ nonce: envelope.nonce, passed: false, error: 'Sérialisation du verdict impossible : ' + e.message, executionTimeMs: null });
  }
  if (payload && payload.length > MAX_RESULT_CHARS) {
    payload = JSON.stringify({ nonce: envelope.nonce, passed: false, error: 'Verdict trop volumineux pour l\'échange parent/enfant (' + payload.length + ' chars > ' + MAX_RESULT_CHARS + ')', executionTimeMs: envelope.executionTimeMs || null });
  }
  try {
    fs.writeSync(3, RESULT_PREFIX + payload + '\n');
  } catch (e) {
    // fd 3 indisponible (lancement manuel sans stdio étendu) : repli stdout.
    try { process.stdout.write(RESULT_PREFIX + payload + '\n'); } catch (_) {}
  }
}

// Neutralisation des globals d'accès réseau et des chemins vers les modules
// natifs, AVANT toute évaluation. Le code élève n'a JAMAIS besoin de l'un de
// ces objets : aucun exercice de réseau n'existe dans la sandbox.
function hardenChildProcess() {
  const undefinedGlobal = (name) => {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: false }); } catch (_) {}
  };
  undefinedGlobal('fetch');
  undefinedGlobal('WebSocket');
  undefinedGlobal('XMLHttpRequest');
  undefinedGlobal('Worker');
  undefinedGlobal('localStorage');
  // Chemins vers les modules natifs : sans eux, un code qui aurait réussi une
  // évasion du contexte VM ne peut pas charger fs/net/child_process (le realm
  // purifié de vm-sandbox.js ferme déjà le Function hôte, c'est la couche 2).
  const neutralizeProcessProp = (name) => {
    try { Object.defineProperty(process, name, { value: undefined, configurable: true, writable: false }); } catch (_) {
      try { process[name] = undefined; } catch (__) {}
    }
  };
  neutralizeProcessProp('getBuiltinModule');
  neutralizeProcessProp('mainModule');
  neutralizeProcessProp('binding');
  neutralizeProcessProp('dlopen');
  neutralizeProcessProp('_linkedBinding');
  neutralizeProcessProp('_getActiveHandles');
}

// Lecture de la requête : stdin fermé par le parent après le JSON complet.
let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { inbuf += chunk; });
process.stdin.on('end', () => {
  let request = null;
  try {
    request = JSON.parse(inbuf || '{}');
  } catch (e) {
    writeResult({ nonce: null, passed: false, error: 'Requête sandbox illisible', executionTimeMs: null });
    process.exit(0);
    return;
  }
  const { nonce, code, setup, callExpr, assertExpr, timeout } = request || {};
  if (!nonce) {
    writeResult({ nonce: null, passed: false, error: 'nonce manquant', executionTimeMs: null });
    process.exit(0);
    return;
  }
  hardenChildProcess();
  const sandbox = require('./vm-sandbox');
  try {
    // Le filtrage regex tourne AUSSI dans l'enfant : double défense (le parent
    // ne spawn pas pour rien, l'enfant ne compte jamais sur le parent).
    const boundedTimeout = Math.max(50, Math.min(Number(timeout) || 10000, 60000));
    const result = sandbox.execCodeInVMInProcess(code, setup, callExpr, assertExpr, boundedTimeout);
    writeResult({
      nonce,
      passed: Boolean(result.passed),
      serializedResult: sandbox.serializeVmResult(result.result),
      error: result.error,
      executionTimeMs: result.executionTimeMs
    });
  } catch (e) {
    writeResult({ nonce, passed: false, serializedResult: { type: 'string', value: null }, error: 'Erreur sandbox enfant : ' + (e && e.message ? e.message : String(e)), executionTimeMs: null });
  }
  process.exit(0);
});
