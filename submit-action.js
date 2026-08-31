// submit-action.js — Action --submit autonome (soumission communautaire sans run).
//
// Problème (Memories-BenchGo/Tasks.md, tâche 1) : `node runner.js --submit`
// seul tombait dans le QUESTIONNAIRE DE DÉMARRAGE (choix du fournisseur, du
// modèle...) au lieu de soumettre les carnets existants. La cause : --submit
// n'était qu'un FLAG de confirmation traité en FIN de run (runner.js
// proposeCommunitySubmission), jamais une ACTION unitaire comme status ou
// version. L'utilisateur voyait « Choix du fournisseur : openrouter » puis
// « Saisissez le nom du modèle » — sans queue ni tête.
//
// Ce module expose runSubmitAction(cliArgs) :
//   1. Liste les carnets locaux (Export-Rapports/.carnet/*.json).
//   2. Cible : --model=<nom> si fourni (match insensible à la casse sur model
//      OU shortName), SINON le dernier carnet modifié sur disque, SINON
//      sélection interactive numérotée (TTY uniquement).
//   3. Soumet via communitySync.submitResults (PR GitHub + merge auto).
//
// Réutilise proposeCommunitySubmission de runner.js ? Non — la logique de
// token/pseudo y est correcte mais elle est couplée au flux post-run. On
// refactore ici une version autonome qui partage les mêmes fonctions
// communitySync (getStoredGithubToken, validateGithubToken, submitResults).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('./logger');
const scoreLedger = require('./score-ledger');
const communitySync = require('./community-sync');

// Liste les carnets disponibles avec leur date de modification.
// Seuls les carnets RÉELS (avec au moins une école) sont listés — on exclut
// les fichiers utilitaires du dossier .carnet/ comme classement_snapshot.json
// (snapshot d'ordre du classement, sans champ ecoles).
// Retourne [{ shortName, file, mtimeMs }] triés du plus récent au plus ancien.
function listLocalLedgers() {
  if (!fs.existsSync(scoreLedger.LEDGER_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(scoreLedger.LEDGER_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(scoreLedger.LEDGER_DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || !j.ecoles || Object.keys(j.ecoles).length === 0) continue;
      const st = fs.statSync(file);
      out.push({ shortName: f.replace(/\.json$/, ''), file, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Cherche un carnet dont le shortName OU le champ model correspond à `name`
// (insensible à la casse, tirets/underscores/espaces équivalents).
function findLedgerByName(ledgers, name) {
  if (!name) return null;
  const norm = s => String(s || '').toLowerCase().replace(/[-_\s]+/g, '-');
  const target = norm(name);
  for (const l of ledgers) {
    if (norm(l.shortName) === target) return l;
    try {
      const j = JSON.parse(fs.readFileSync(l.file, 'utf8'));
      if (norm(j.model) === target || norm(j.displayName) === target) return l;
    } catch (_) {}
  }
  // Repli non ambigu par sous-chaîne (slug partiel, nom tronqué).
  const partial = ledgers.filter(l => norm(l.shortName).includes(target));
  return partial.length === 1 ? partial[0] : null;
}

// Sélection interactive numérotée du carnet à soumettre (TTY uniquement).
// Retourne le shortName choisi, ou null si annulé / aucun carnet.
async function chooseLedgerInteractive(ledgers) {
  console.log('  \x1b[90mChoisissez le carnet à envoyer sur le classement communautaire :\x1b[0m\n');
  ledgers.forEach((l, i) => {
    const d = new Date(l.mtimeMs).toLocaleString('fr-FR');
    console.log(`    \x1b[1m${String(i + 1).padStart(2)}.\x1b[0m ${l.shortName} \x1b[90m(${d})\x1b[0m`);
  });
  console.log(`    \x1b[1m 0.\x1b[0m Annuler`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('  Numéro du carnet : ', a => { rl.close(); resolve((a || '').trim()); });
  });
  const n = parseInt(answer, 10);
  if (Number.isInteger(n) && n >= 1 && n <= ledgers.length) return ledgers[n - 1].shortName;
  console.log('  \x1b[90mSoumission annulée.\x1b[0m');
  return null;
}

// Point d'entrée de l'action --submit autonome. Retourne true si l'action a
// été traitée (le runner doit alors exit), false si --submit n'était pas
// demandé comme action (le runner poursuit son flux normal post-run).
async function runSubmitAction(cliArgs) {
  const ledgers = listLocalLedgers();
  console.log('  \x1b[1;36m━━━ SOUMISSION COMMUNAUTAIRE ━━━\x1b[0m');
  console.log('  \x1b[90mEnvoie un carnet de scores via une Pull Request GitHub sur le dépôt\x1b[0m');
  console.log('  \x1b[90mcommunautaire — le classement public sera reconstruit ensuite.\x1b[0m\n');

  if (ledgers.length === 0) {
    console.log('  \x1b[33mAucun carnet trouvé dans Export-Rapports/.carnet/.\x1b[0m');
    console.log('  \x1b[90mLancez d\'abord un benchmark : node runner.js all --profile=LIGHT\x1b[0m\n');
    return true;
  }

  // Cible : --model explicite > dernier carnet modifié > choix interactif.
  let shortName = null;
  const explicit = findLedgerByName(ledgers, cliArgs.model);
  if (explicit) {
    shortName = explicit.shortName;
    console.log(`  \x1b[90mCarnet ciblé par --model : \x1b[1m${shortName}\x1b[0m\x1b[90m (${new Date(explicit.mtimeMs).toLocaleString('fr-FR')})\x1b[0m\n`);
  } else if (cliArgs.model) {
    console.log(`  \x1b[33mAucun carnet ne correspond à "${cliArgs.model}".\x1b[0m`);
  }
  if (!shortName) {
    const latest = ledgers[0];
    if (ledgers.length === 1 || (process.stdin.isTTY && process.stdout.isTTY)) {
      if (ledgers.length === 1) {
        shortName = latest.shortName;
        console.log(`  \x1b[90mCarnet unique détecté : \x1b[1m${shortName}\x1b[0m\n`);
      } else {
        shortName = await chooseLedgerInteractive(ledgers);
        if (!shortName) return true;
      }
    } else {
      shortName = latest.shortName;
      console.log(`  \x1b[90mMode non-interactif : dernier carnet modifié sélectionné — \x1b[1m${shortName}\x1b[0m\x1b[90m (${new Date(latest.mtimeMs).toLocaleString('fr-FR')})\x1b[0m`);
      console.log('  \x1b[90mPour cibler un autre carnet : node runner.js --submit --model=<nom>\x1b[0m\n');
    }
  }

  // Charge et valide le carnet.
  const ledger = scoreLedger.loadLedger(shortName);
  if (!ledger || !ledger.ecoles || Object.keys(ledger.ecoles).length === 0) {
    console.log(`  \x1b[33mCarnet "${shortName}" vide ou illisible — soumission impossible.\x1b[0m\n`);
    return true;
  }

  // Token GitHub : CLI > profil local > saisie interactive.
  let token = cliArgs.githubToken || communitySync.getStoredGithubToken();
  if (!token) {
    console.log('  \x1b[36mUn token GitHub (Personal Access Token, scope "repo") est nécessaire pour créer la Pull Request.\x1b[0m');
    console.log('  \x1b[90mCréez-en un sur : https://github.com/settings/tokens\x1b[0m');
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      console.log('  \x1b[33mMode non-interactif sans token mémorisé — soumission annulée.\x1b[0m');
      console.log('  \x1b[90mFournissez-le via --github-token=ghp_... puis relancez.\x1b[0m\n');
      return true;
    }
    token = await askTokenInteractive();
    if (!token) {
      console.log('  \x1b[33mAucun token fourni — soumission annulée.\x1b[0m\n');
      return true;
    }
  }

  // Pseudo optionnel pour l'attribution publique.
  let pseudo = communitySync.getPublicPseudo();
  if (!pseudo && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('  Pseudo public (Entrée = anonyme) : ', a => { rl.close(); resolve((a || '').trim()); });
    });
    if (answer) {
      pseudo = answer;
      communitySync.setPublicPseudo(pseudo);
    }
  }
  console.log('');

  console.log('  \x1b[35mSoumission en cours...\x1b[0m');
  try {
    const result = await communitySync.submitResults(shortName, ledger, token, {
      pseudo: pseudo || null,
      benchgoVersion: 'V3'
    });
    console.log(`\n  \x1b[1;32m━━━ SOUMISSION RÉUSSIE ━━━\x1b[0m`);
    console.log(`  \x1b[32mCarnet : ${shortName}\x1b[0m`);
    console.log(`  \x1b[32mPull Request : ${result.prUrl}\x1b[0m`);
    console.log(`  \x1b[90mBranche : ${result.branch}\x1b[0m`);
    console.log(`  \x1b[90mFichier : ${result.filePath}\x1b[0m`);
    if (result.merged) {
      console.log(`  \x1b[32mPR #${result.prNumber} mergée automatiquement — résultats intégrés au classement.\x1b[0m`);
      console.log('  \x1b[90mLe classement communautaire sera reconstruit par la GitHub Action consolidate.yml.\x1b[0m');
    } else {
      console.log(`  \x1b[33mMerge auto impossible : ${result.mergeMessage || 'raison inconnue'}\x1b[0m`);
      console.log('  \x1b[90mLe propriétaire du dépôt validera votre PR manuellement.\x1b[0m');
    }
    console.log('  \x1b[90mMerci pour votre participation !\x1b[0m\n');
  } catch (e) {
    logger.error('Soumission --submit échouée : ' + e.message);
    console.log(`\n  \x1b[31mÉchec de la soumission : ${e.message}\x1b[0m`);
    console.log('  \x1b[33mVérifiez votre token GitHub (scope repo) et votre connexion réseau.\x1b[0m');
    console.log('  \x1b[90mRéessayez avec : node runner.js --submit --github-token=ghp_...\x1b[0m\n');
  }
  return true;
}

// Saisie interactive du token GitHub + validation + proposition de mémorisation.
async function askTokenInteractive() {
  const secrets = require('./secrets');
  let token = await secrets.askSecret('  Collez votre token GitHub (ghp_...)', { revealMs: 3000 });
  if (!token) return null;
  const validation = await communitySync.validateGithubToken(token);
  if (!validation.valid) {
    console.log(`  \x1b[31mToken invalide : ${validation.error}. Soumission annulée.\x1b[0m`);
    return null;
  }
  console.log(`  \x1b[32mToken valide (compte : ${validation.login}).\x1b[0m`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('  Mémoriser ce token pour les prochaines soumissions ? (O/n) : ', a => { rl.close(); resolve((a || '').trim().toLowerCase()); });
  });
  if (answer !== 'n') {
    communitySync.setGithubToken(token);
    console.log('  \x1b[90mToken mémorisé localement (.benchgo-profile.json, hors GitHub).\x1b[0m');
  }
  return token;
}

module.exports = { runSubmitAction, listLocalLedgers, findLedgerByName };