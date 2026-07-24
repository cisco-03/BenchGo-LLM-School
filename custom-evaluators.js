
const vm = require('vm');
const { EVAL_TIMEOUT_MS } = require('./config');
const { buildSandbox } = require('./vm-sandbox');
const { stripTS } = require('./parsing-utils');

function evaluateGeoJSONRFC7946(code) {
  const errors = [];

  if (code.match(/feature\.nom\b/) && !code.match(/feature\.properties\.nom\b/)) {
    errors.push("Violation RFC 7946 : 'feature.nom' utilisé au lieu de 'feature.properties.nom'. Dans un GeoJSON conforme, TOUTES les propriétés utilisateur se trouvent dans l'objet 'properties'.");
  }

  const stripped = stripTS(code);
  const rfc7946Data = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "f1",
        properties: { type: "destination", nom: "Paris", region: "IDF" },
        geometry: { type: "Point", coordinates: [2.3522, 48.8566] }
      },
      {
        type: "Feature",
        id: "f2",
        properties: { type: "waypoint", nom: "Lyon", region: "ARA" },
        geometry: { type: "Point", coordinates: [4.8357, 45.764] }
      },
      {
        type: "Feature",
        id: "f3",
        properties: { type: "destination", nom: "Marseille", region: "PACA" },
        geometry: { type: "Point", coordinates: [5.3698, 43.2965] }
      }
    ]
  };

  try {
    const sandbox = buildSandbox();
    const ctx = vm.createContext(sandbox);
    vm.runInContext(`
      ${stripped}
      this.__geoResult__ = extrairePointsInteret(${JSON.stringify(rfc7946Data)});
    `, ctx, { timeout: EVAL_TIMEOUT_MS });

    const result = ctx.__geoResult__;

    if (!Array.isArray(result)) {
      errors.push("Le résultat n'est pas un tableau. La fonction doit retourner un Array.");
    } else {
      if (result.length !== 2) {
        errors.push(`Attendu : 2 features de type 'destination' (Paris, Marseille). Obtenu : ${result.length}.`);
      }

      const noms = result.map(r => r && r.nom);
      if (!noms.includes("Paris")) {
        errors.push("'Paris' absent des résultats — l'extraction depuis 'properties.nom' est probablement défaillante.");
      }
      if (!noms.includes("Marseille")) {
        errors.push("'Marseille' absent des résultats.");
      }

      const hasLyon = result.some(r => r && r.nom === "Lyon");
      if (hasLyon) {
        errors.push("Filtrage incorrect : 'Lyon' (type: waypoint) ne devrait pas figurer dans les résultats.");
      }

      const allHaveCoords = result.every(r => r && Array.isArray(r.coordonnees));
      if (!allHaveCoords && result.length > 0) {
        errors.push("Le champ 'coordonnees' n'est pas extrait correctement depuis geometry.coordinates.");
      }
    }
  } catch (e) {
    errors.push(`Erreur d'exécution avec les données RFC 7946 : ${e.message}`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function evaluateReactHook(code) {
  const errors = [];

  if (!code.includes('useEffect')) {
    errors.push("useEffect absent : l'instanciation du ChartRender doit se faire dans un useEffect.");
  }

  if (!code.includes('destroy()')) {
    errors.push("Fuite de mémoire : aucun appel à .destroy() pour le nettoyage au démontage.");
  }

  if (!code.includes('return () =>') && !code.includes('return function')) {
    errors.push("Le useEffect doit retourner une fonction de cleanup (return () => { ... }).");
  }

  const usesUseRef = code.includes('useRef');
  const usesUseState = code.includes('useState');

  if (usesUseRef && !usesUseState) {
    errors.push("ANTI-PATTERN DÉTECTÉ : Le hook utilise useRef pour stocker l'instance du chart au lieu de useState. Modifier useRef ne déclenche PAS de re-render. Le composant consommateur reçoit 'null' au premier rendu et n'est jamais notifié de la création de l'instance. Utilise useState pour exposer l'instance chart afin de notifier le consommateur après montage.");
  }

  if (usesUseRef && code.includes('chartRef.current') && code.includes('return')) {
    const returnMatch = code.match(/return\s*\{[^}]*chart\b[^}]*\}/);
    if (returnMatch && returnMatch[0].includes('chartRef.current')) {
      errors.push("RÉGRESSION V1 : Renvoyer 'chartRef.current' directement expose null au montage car le retour du hook s'exécute AVANT que le useEffect ne crée l'instance. useState + useEffect permet une notification correcte.");
    }
  }

  if (usesUseState) {
    const stripped = stripTS(code);
    try {
      let capturedEffect = null;
      let cleanupFn = null;
      let chartInstance = null;
      let stateValues = [];
      let stateSetters = [];

      const mockHooks = {
        useEffect: (fn) => { capturedEffect = fn; },
        useState: (init) => {
          const idx = stateValues.length;
          stateValues.push(init);
          const setter = (newVal) => { stateValues[idx] = newVal; };
          stateSetters.push(setter);
          return [stateValues[idx], setter];
        },
        useRef: (init) => ({ current: init })
      };

      class MockChartRender {
        constructor(el) {
          this.el = el;
          this.destroyed = false;
          chartInstance = this;
        }
        destroy() { this.destroyed = true; }
      }

      const sandbox = {
        ...mockHooks,
        ChartRender: MockChartRender,
        containerRef: { current: {} }
      };
      const ctx = vm.createContext(sandbox);

      const hookNameMatch = stripped.match(/function\s+(\w+)/);
      const hookName = hookNameMatch ? hookNameMatch[1] : 'useChartCanvas';

      vm.runInContext(`
        ${stripped}
        this.__hookResult__ = ${hookName}({ current: {} });
      `, ctx, { timeout: EVAL_TIMEOUT_MS });

      const firstRender = ctx.__hookResult__;

      if (capturedEffect) {
        cleanupFn = capturedEffect();
      }

      if (chartInstance && cleanupFn) {
        cleanupFn();
        if (!chartInstance.destroyed) {
          errors.push("Le cleanup du useEffect n'appelle pas chart.destroy().");
        }
      }
    } catch (e) {
      // Simulation échouée — on se base sur les vérifications par pattern
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function evaluateFloodFill(code) {
  const errors = [];
  const stripped = stripTS(code);

  function runFloodFill(matrix, x, y, newVal) {
    const sandbox = buildSandbox();
    const ctx = vm.createContext(sandbox);
    vm.runInContext(`
      ${stripped}
      this.__ffResult__ = remplirMatrice(
        ${JSON.stringify(matrix)}, ${x}, ${y}, ${newVal}
      );
    `, ctx, { timeout: 2000 });
    return ctx.__ffResult__;
  }

  try {
    const mat1 = [
      [1, 0, 0, 1],
      [1, 0, 0, 1]
    ];
    const expected1 = [
      [1, 0, 0, 5],
      [1, 0, 0, 5]
    ];

    const result1 = runFloodFill(mat1, 3, 1, 5);

    if (JSON.stringify(result1) !== JSON.stringify(expected1)) {
      const unchanged = JSON.stringify(result1) === JSON.stringify(mat1);
      if (unchanged) {
        errors.push("Test INVERSION x/y (2×4, x=3, y=1) : La matrice est inchangée. Le code appelle probablement floodFill(x, y) au lieu de floodFill(y, x). Avec x=3 passé comme row-index sur une matrice à 2 lignes, l'index est hors limites et la fonction retourne sans rien remplir. La convention est x=colonne, y=ligne → grille[y][x].");
      } else {
        errors.push(`Test INVERSION x/y (2×4, x=3, y=1) :\n  Attendu : ${JSON.stringify(expected1)}\n  Obtenu  : ${JSON.stringify(result1)}`);
      }
    }
  } catch (e) {
    if (e.message && (e.message.includes('timed out') || e.message.includes('stack'))) {
      errors.push("Test INVERSION x/y (2×4) : RÉCURSION INFINIE détectée.");
    } else {
      errors.push(`Test INVERSION x/y (2×4) : erreur — ${e.message}`);
    }
  }

  try {
    const mat2 = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1]
    ];
    const expected2 = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1]
    ];

    const result2 = runFloodFill(mat2, 0, 0, 1);

    if (JSON.stringify(result2) !== JSON.stringify(expected2)) {
      errors.push(`Test COULEUR IDENTIQUE (ancienne=1, nouvelle=1) : la matrice devrait rester inchangée.\n  Obtenu : ${JSON.stringify(result2)}`);
    }
  } catch (e) {
    if (e.message && (e.message.includes('timed out') || e.message.includes('stack') || e.message.includes('Maximum call stack'))) {
      errors.push("Test COULEUR IDENTIQUE (oldColor === newColor) : RÉCURSION INFINIE. Un early-return est requis quand la valeur d'origine est égale à la nouvelle valeur, sinon le flood-fill revisite chaque cellule indéfiniment.");
    } else {
      errors.push(`Test couleur identique : erreur — ${e.message}`);
    }
  }

  try {
    const mat3 = [
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 1]
    ];
    const expected3 = [
      [0, 0, 7],
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 1]
    ];

    const result3 = runFloodFill(mat3, 2, 0, 7);

    if (JSON.stringify(result3) !== JSON.stringify(expected3)) {
      errors.push(`Test NON-CARRÉE 5×3 régions déconnectées (x=2, y=0, val=7) :\n  Attendu : ${JSON.stringify(expected3)}\n  Obtenu  : ${JSON.stringify(result3)}`);
    }
  } catch (e) {
    errors.push(`Test NON-CARRÉE 5×3 : erreur — ${e.message}`);
  }

  try {
    const mat4 = [
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 1]
    ];
    const expected4 = [
      [9, 9, 0],
      [9, 0, 0],
      [0, 0, 1]
    ];

    const result4 = runFloodFill(mat4, 0, 0, 9);

    if (JSON.stringify(result4) !== JSON.stringify(expected4)) {
      errors.push(`Test matrice carrée mixte (3×3, x=0, y=0, val=9) :\n  Attendu : ${JSON.stringify(expected4)}\n  Obtenu  : ${JSON.stringify(result4)}`);
    }
  } catch (e) {
    errors.push(`Test matrice carrée mixte (3×3) : erreur d'exécution — ${e.message}`);
  }

  try {
    const mat5 = [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [0, 1, 1, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];
    const expected5 = [
      [0, 0, 0, 0],
      [0, 5, 5, 0],
      [0, 5, 5, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];

    const result5 = runFloodFill(mat5, 1, 1, 5);

    if (JSON.stringify(result5) !== JSON.stringify(expected5)) {
      errors.push(`Test îlot central 5×4 (x=1, y=1, val=5) :\n  Attendu : ${JSON.stringify(expected5)}\n  Obtenu  : ${JSON.stringify(result5)}`);
    }
  } catch (e) {
    errors.push(`Test îlot central 5×4 : erreur — ${e.message}`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function evaluatePowerShellRollback(code) {
  const errors = [];
  const lower = code.toLowerCase();

  const hasBackup = lower.includes('copy-item') && lower.includes('production_backup.db');
  const hasErrorDetection = lower.includes('lastexitcode') || lower.includes('try') || lower.includes('catch') || lower.includes('$error');
  const hasRestore = lower.includes('copy-item') && lower.includes('production_backup') && (lower.includes('destination') || lower.includes('-path'));

  if (!hasBackup) {
    errors.push("Sauvegarde préventive manquante : Copy-Item de production.db vers production_backup.db doit être effectué AVANT la migration.");
  }

  if (!hasErrorDetection) {
    errors.push("Détection d'erreur absente : $LASTEXITCODE, try/catch, ou $Error doivent être utilisés pour détecter les échecs.");
  }

  const backupPos = lower.indexOf('copy-item');
  const sqlitePos = lower.indexOf('sqlite3');
  if (backupPos !== -1 && sqlitePos !== -1 && backupPos > sqlitePos) {
    errors.push("Ordre incorrect : la sauvegarde (Copy-Item) doit être effectuée AVANT l'exécution de sqlite3.");
  }

  if (!lower.includes('migration.sql') && !lower.includes('migration')) {
    errors.push("Le fichier de migration n'est pas référencé dans le script.");
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function evaluatePythonConsecutiveLimiter(code) {
  const errors = [];

  if (!code.includes('for') && !code.includes('while')) {
    errors.push("Aucune boucle (for/while) détectée : l'algorithme doit itérer sur la liste.");
  }

  const hasCounter = /\b(count|compteur|c|n|freq)\s*=\s*1\b/i.test(code) ||
                     /\b(count|compteur|c|n)\s*\+=\s*1\b/i.test(code) ||
                     /\bcount\s*=\s*0\b/i.test(code);
  if (!hasCounter) {
    errors.push("Aucun compteur de répétitions consécutives détecté. L'algorithme nécessite un comptage des occurrences consécutives.");
  }

  if (!code.includes('append') && !code.includes('result') && !code.includes('+=')) {
    errors.push("Aucun mécanisme de construction du résultat détecté (append, +=, etc.).");
  }

  if (code.includes('set(') || code.includes('collections.Counter') || code.includes('unique')) {
    errors.push("Approche incorrecte : set()/Counter suppriment TOUS les doublons, pas seulement les consécutifs.");
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

/**
 * Extrait le nom de la fonction principale d'un extrait de code (function déclarée
 * ou const/let/var assignée à une fonction fléchée/async), avec un nom de repli.
 */
function detecterNomFonction(strippedCode, nomParDefaut) {
  const match = strippedCode.match(/(?:async\s+)?function\s+(\w+)/) ||
                strippedCode.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/) ||
                strippedCode.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/);
  return match ? match[1] : nomParDefaut;
}

/**
 * Définit le code étudiant dans un contexte VM isolé et retourne une référence
 * vers la fonction nommée exposée globalement dans ce contexte, prête à être
 * appelée et attendue (await) depuis l'extérieur (contexte hôte Node.js réel).
 * `extraGlobals` permet d'injecter des mocks (ex: Response, fetch) accessibles
 * par le code étudiant au moment de l'appel.
 */
function exposerFonctionVM(code, nomParDefaut, extraGlobals) {
  const stripped = stripTS(code);
  const fnName = detecterNomFonction(stripped, nomParDefaut);
  const sandbox = buildSandbox();
  if (extraGlobals) Object.assign(sandbox, extraGlobals);
  const ctx = vm.createContext(sandbox);

  try {
    // Convertir const/let top-level en var pour qu'ils s'attachent au global du VM
    const varCode = stripped.replace(/^\s*(const|let)\s+/gm, 'var ');
    vm.runInContext(varCode, ctx, { timeout: EVAL_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`Erreur de compilation du code : ${e.message}`);
  }

  const fn = ctx[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`Fonction '${fnName}' introuvable ou non définie globalement. Vérifie le nom exact demandé.`);
  }
  return fn;
}

function avecTimeout(promesse, label, ms = 3000) {
  return Promise.race([
    promesse,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout sur le scénario '${label}' — la fonction ne s'est jamais résolue ni rejetée (blocage probable, Promise non gérée).`)), ms))
  ]);
}

async function evaluateAsyncPartialErrors(code) {
  const errors = [];
  const studentFn = exposerFonctionVM(code, 'chargerEnParallele');

  const mockFetch = async (url) => {
    if (url === 'fail-1' || url === 'fail-2') {
      throw new Error(`Échec réseau simulé pour ${url}`);
    }
    return { url, data: 'ok' };
  };

  let result;
  try {
    result = await avecTimeout(
      Promise.resolve(studentFn(['ok-1', 'fail-1', 'ok-2', 'fail-2'], mockFetch)),
      'chargement partiel'
    );
  } catch (e) {
    throw new Error(`La fonction a rejeté/planté au lieu de gérer les échecs partiels : ${e.message}. Utilise Promise.allSettled au lieu de Promise.all pour éviter le fail-fast sur le premier échec.`);
  }

  if (!result || typeof result !== 'object') {
    errors.push("Le résultat doit être un objet de la forme { succes: [...], echecs: [...] }.");
  } else {
    if (!Array.isArray(result.succes)) {
      errors.push("La clé 'succes' doit être un tableau des ressources chargées avec succès.");
    } else if (result.succes.length !== 2) {
      errors.push(`Attendu 2 ressources en succès ('ok-1', 'ok-2'), obtenu ${result.succes.length}.`);
    }
    if (!Array.isArray(result.echecs)) {
      errors.push("La clé 'echecs' doit être un tableau identifiant les URLs en échec.");
    } else if (result.echecs.length !== 2) {
      errors.push(`Attendu 2 échecs ('fail-1', 'fail-2'), obtenu ${result.echecs.length}. Vérifie que les deux échecs sont bien capturés sans interrompre le traitement des autres URLs.`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function evaluateAsyncSequentialProcessing(code) {
  const errors = [];
  const studentFn = exposerFonctionVM(code, 'traiterSequentiellement');

  const traiterFn = async (commande) => {
    await new Promise(r => setTimeout(r, 5));
    return commande * 2;
  };

  let result;
  try {
    result = await avecTimeout(
      Promise.resolve(studentFn([1, 2, 3], traiterFn)),
      'traitement séquentiel'
    );
  } catch (e) {
    throw new Error(`La fonction a levé une exception inattendue : ${e.message}`);
  }

  if (!Array.isArray(result) || result.length !== 3) {
    throw new Error(`BUG DÉTECTÉ : le tableau retourné est incomplet (${JSON.stringify(result)}). Symptôme classique du bug 'forEach avec callback async' : Array.prototype.forEach n'attend JAMAIS la résolution des promesses retournées par son callback, donc la fonction englobante retourne avant la fin du traitement. Corrige avec une boucle 'for...of' + 'await', ou avec 'await Promise.all(tableau.map(...))'.`);
  }
  if (JSON.stringify(result) !== JSON.stringify([2, 4, 6])) {
    errors.push(`Résultat incorrect : attendu [2,4,6] (dans l'ordre), obtenu ${JSON.stringify(result)}.`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function evaluateAsyncRetryLogic(code) {
  const errors = [];
  const studentFn = exposerFonctionVM(code, 'executerAvecRetry');

  // Scénario 1 : échoue 2 fois puis réussit à la 3e tentative
  let attempts1 = 0;
  const op1 = async () => {
    attempts1++;
    if (attempts1 < 3) throw new Error("Échec temporaire simulé");
    return "OK";
  };
  try {
    const res1 = await avecTimeout(Promise.resolve(studentFn(op1, 3)), 'succès après échecs');
    if (res1 !== "OK") errors.push(`Scénario succès-après-échecs : attendu 'OK', obtenu ${JSON.stringify(res1)}.`);
    if (attempts1 !== 3) errors.push(`Scénario succès-après-échecs : attendu exactement 3 tentatives, obtenu ${attempts1}.`);
  } catch (e) {
    errors.push(`Scénario succès-après-échecs : la fonction a rejeté alors qu'elle aurait dû réussir à la 3e tentative — ${e.message}`);
  }

  // Scénario 2 : échec permanent -> doit finir par rejeter après épuisement des tentatives
  let attempts2 = 0;
  const op2 = async () => {
    attempts2++;
    throw new Error("Échec permanent simulé");
  };
  let aRejete = false;
  try {
    await avecTimeout(Promise.resolve(studentFn(op2, 3)), 'échec permanent');
  } catch (e) {
    aRejete = true;
  }
  if (!aRejete) {
    errors.push("Scénario échec-permanent : la fonction aurait dû rejeter/lever une erreur après épuisement des tentatives, mais elle s'est résolue normalement.");
  } else if (attempts2 !== 3) {
    errors.push(`Scénario échec-permanent : attendu exactement 3 tentatives avant abandon, obtenu ${attempts2}.`);
  }

  // Scénario 3 : succès immédiat -> une seule tentative, pas de retry inutile
  let attempts3 = 0;
  const op3 = async () => { attempts3++; return "IMMEDIAT"; };
  try {
    const res3 = await avecTimeout(Promise.resolve(studentFn(op3, 3)), 'succès immédiat');
    if (res3 !== "IMMEDIAT") errors.push(`Scénario succès-immédiat : attendu 'IMMEDIAT', obtenu ${JSON.stringify(res3)}.`);
    if (attempts3 !== 1) errors.push(`Scénario succès-immédiat : attendu exactement 1 tentative (pas de retry inutile), obtenu ${attempts3}.`);
  } catch (e) {
    errors.push(`Scénario succès-immédiat : la fonction a rejeté alors que l'opération a réussi du premier coup — ${e.message}`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function evaluateCloudflareMiddleware(code) {
  const errors = [];
  const studentFn = exposerFonctionVM(code, 'middleware', {
    Response: function(body, opts) { this.body = body; this.status = opts ? opts.status : 200; },
    fetch: function(req) { return Promise.resolve({ status: 200, body: 'passed', _proxied: true }); }
  });

  let result;
  try {
    result = await avecTimeout(
      Promise.resolve(studentFn({ headers: { get: function() { return null; } } }, {})),
      'middleware sans Authorization'
    );
  } catch (e) {
    throw new Error(`Le middleware a levé une exception au lieu de retourner une Response 403 : ${e.message}`);
  }

  if (!result || result.status !== 403) {
    errors.push(`Le middleware doit retourner une Response avec status 403 quand le header Authorization est absent ou incorrect. Obtenu : ${JSON.stringify(result)}.`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function evaluateAsyncConcurrencyLimit(code) {
  const errors = [];
  let studentFn;
  try {
    studentFn = exposerFonctionVM(code, 'executerAvecConcurrence');
  } catch (e) {
    throw new Error(`Impossible de compiler executerAvecConcurrence : ${e.message}`);
  }

  // Scénario 1 : 5 tâches, max 2 en parallèle — vérifie la limite ET l'ordre des résultats
  let running = 0;
  let maxObserved = 0;
  const taches1 = [10, 20, 30, 40, 50].map((val) => async () => {
    running++;
    if (running > maxObserved) maxObserved = running;
    await new Promise(r => setTimeout(r, 15));
    running--;
    return val;
  });

  let res1;
  try {
    res1 = await avecTimeout(
      Promise.resolve(studentFn(taches1, 2)),
      '5 tâches / max 2',
      4000
    );
  } catch (e) {
    throw new Error(`La fonction a rejeté ou dépassé le timeout : ${e.message}`);
  }

  if (!Array.isArray(res1) || res1.length !== 5) {
    errors.push(`Résultat incorrect : attendu tableau de 5 éléments, obtenu ${JSON.stringify(res1)}.`);
  } else if (JSON.stringify(res1) !== JSON.stringify([10, 20, 30, 40, 50])) {
    errors.push(`Ordre des résultats non respecté : attendu [10,20,30,40,50], obtenu ${JSON.stringify(res1)}. Les résultats doivent être dans l'ordre d'origine des tâches.`);
  }

  if (maxObserved > 2) {
    errors.push(`Limite de concurrence dépassée : ${maxObserved} tâches tournaient simultanément (max autorisé : 2). Utilisez un compteur ou un pool de workers pour brider la parallélisation.`);
  } else if (maxObserved < 2 && res1 && res1.length === 5) {
    errors.push(`Exécution séquentielle détectée (concurrence max observée = ${maxObserved}). La fonction doit exécuter jusqu'à 2 tâches simultanément pour respecter le paramètre maxConcurrence.`);
  }

  // Scénario 2 : 1 tâche avec max=3 (cas limite)
  const taches2 = [async () => { await new Promise(r => setTimeout(r, 5)); return 'unique'; }];
  try {
    const res2 = await avecTimeout(
      Promise.resolve(studentFn(taches2, 3)),
      '1 tâche / max 3',
      2000
    );
    if (!Array.isArray(res2) || res2[0] !== 'unique') {
      errors.push(`Cas limite (1 tâche, max=3) : attendu ['unique'], obtenu ${JSON.stringify(res2)}.`);
    }
  } catch (e) {
    errors.push(`Scénario 1 tâche : ${e.message}`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

const customEvaluators = {
  evaluateGeoJSONRFC7946,
  evaluateReactHook,
  evaluateFloodFill,
  evaluatePowerShellRollback,
  evaluatePythonConsecutiveLimiter,
  evaluateAsyncPartialErrors,
  evaluateAsyncSequentialProcessing,
  evaluateAsyncRetryLogic,
  evaluateCloudflareMiddleware,
  evaluateAsyncConcurrencyLimit
};

module.exports = customEvaluators;
