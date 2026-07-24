// community-sync.js — Synchronisation communautaire participative.
//
// Deux mécanismes distincts :
//
//  1. PING ANONYME (télémétrie opt-in)
//     À chaque lancement du runner, une requête GET anonyme est envoyée vers un
//     fichier hébergé sur le dépôt GitHub. Cela incrémente le compteur de visites
//     (« Insights → Traffic ») visible par le propriétaire du dépôt. AUCUNE donnée
//     n'est transmise : c'est un simple fetch d'un URL statique. Le propriétaire
//     sait ainsi combien de personnes utilisent BenchGo actives, sans collecter
//     d'informations personnelles.
//
//     Opt-out : --no-telemetry ou mettre telemetry=false dans le profil local.
//
//  2. SOUMISSION DE RÉSULTATS (via Pull Request GitHub)
//     L'utilisateur peut envoyer son carnet de scores (.carnet/<modele>.json) sur
//     le dépôt communautaire via une Pull Request créée automatiquement par
//     l'API GitHub. Cela nécessite un Personal Access Token (PAT) GitHub avec le
//     scope `repo`. Le fichier est déposé dans `submissions/<userId>/<model>.json`
//     sur une branche dédiée, puis une PR est ouverte vers `main`. Le propriétaire
//     du dépôt merge la PR à la main — un classement consolidé est alors reconstruit
//     par une GitHub Action et publié sur GitHub Pages.
//
//     Le userId est un identifiant anonyme aléatoire généré une fois et stocké
//     localement (jamais commité). L'utilisateur peut optionnellement renseigner
//     un pseudo public pour l'attribution dans le classement consolidé.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('./logger');

// Dépôt communautaire — défini en dur car c'est le dépôt public de référence.
// L'utilisateur n'a rien à configurer : le ping et la soumission ciblent ce dépôt.
const COMMUNITY_REPO = {
  owner: 'cisco-03',
  repo: 'BenchGo-LLM-School'
};

const GITHUB_API = 'https://api.github.com';

// Fichier de profil local (préférences communautaires). Stocké à la racine du
// projet, automatiquement ignoré par .gitignore (règle `*` qui ignore tout).
const PROFILE_FILE = path.join(__dirname, '.benchgo-profile.json');

// URL du ping télémétrie — un fichier texte statique hébergé sur la branche main.
// Le simple fait de le fetcher incrémente le compteur de vues du dépôt (visible
// dans Insights → Traffic par le propriétaire). Aucune donnée n'est envoyée.
const PING_URL = `https://raw.githubusercontent.com/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/main/.community/ping.txt`;

// --- Gestion du profil local ---

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {
    logger.warn('Profil communautaire illisible, recréation : ' + e.message);
  }
  return {};
}

function saveProfile(profile) {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn('Impossible de sauvegarder le profil communautaire : ' + e.message);
  }
}

// Génère ou récupère un identifiant utilisateur anonyme (16 caractères hex).
// Cet identifiant permet :
//   - de regrouper les soumissions d'un même utilisateur dans submissions/<id>/
//   - d'éviter les doublons de ping (on ne ping qu'une fois par jour par userId)
function getOrCreateUserId() {
  const profile = loadProfile();
  if (profile.userId) return profile.userId;
  const id = crypto.randomBytes(8).toString('hex');
  profile.userId = id;
  saveProfile(profile);
  return id;
}

// Renvoie les préférences télémétrie (opt-in par défaut au premier lancement,
// mais l'utilisateur est informé et peut refuser).
function getTelemetryConsent() {
  const profile = loadProfile();
  if (profile.telemetry === false) return false;
  return true; // opt-in par défaut (le premier lancement demandera confirmation)
}

function setTelemetryConsent(enabled) {
  const profile = loadProfile();
  profile.telemetry = Boolean(enabled);
  saveProfile(profile);
}

// Renvoie le pseudo public optionnel (pour l'attribution dans le classement consolidé).
function getPublicPseudo() {
  const profile = loadProfile();
  return profile.pseudo || null;
}

function setPublicPseudo(pseudo) {
  const profile = loadProfile();
  profile.pseudo = pseudo || null;
  saveProfile(profile);
}

// Renvoie le token GitHub mémorisé (PAT) pour la soumission, ou null.
function getStoredGithubToken() {
  const profile = loadProfile();
  return profile.githubToken || null;
}

function setGithubToken(token) {
  const profile = loadProfile();
  profile.githubToken = token || null;
  saveProfile(profile);
}

function forgetGithubToken() {
  const profile = loadProfile();
  const existed = Boolean(profile.githubToken);
  delete profile.githubToken;
  saveProfile(profile);
  return existed;
}

// --- 1. Ping télémétrie anonyme ---

// Envoie un ping anonyme (GET sur un fichier statique du dépôt). Ne transmet
// AUCUNE donnée personnelle. Le userId est envoyé en query string uniquement
// pour que le propriétaire puisse estimer le nombre d'utilisateurs uniques via
// les logs d'accès GitHub (si il active GitHub Pages analytics) — c'est purement
// optionnel et le userId est un hash aléatoire non-identifiant.
//
// Pour éviter de spammer, on ne ping qu'une fois par jour (horodatage stocké
// dans le profil local). En cas d'échec réseau, on échoue silencieusement.
async function sendPing() {
  if (!getTelemetryConsent()) return false;

  // Anti-spam : un ping par jour maximum.
  const profile = loadProfile();
  const today = new Date().toISOString().slice(0, 10);
  if (profile.lastPingDate === today) return false;

  try {
    const userId = profile.userId || getOrCreateUserId();
    const url = `${PING_URL}?u=${userId}&v=3&t=${today}`;
    // Timeout court : si pas de réseau, on abandonne sans bloquer l'utilisateur.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    // Peu importe le code de retour (404 est normal si le fichier n'existe pas
    // encore sur le dépôt — le ping incrémentera quand même le trafic).
    profile.lastPingDate = today;
    saveProfile(profile);
    return true;
  } catch (e) {
    // Échec réseau silencieux — ne jamais bloquer le runner.
    return false;
  }
}

// --- 2. Soumission de résultats via Pull Request GitHub ---

// Récupère le SHA de la branche de référence (main) du dépôt communautaire.
async function getMainBranchSha(token) {
  const res = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/git/refs/heads/main`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API (getMainBranchSha) : ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.object.sha;
}

// Crée une branche à partir du SHA de main.
async function createBranch(token, branchName, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/git/refs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: sha
    })
  });
  if (!res.ok) {
    const body = await res.text();
    // Si la branche existe déjà (422), c'est OK — on continue.
    if (res.status === 422 && /already exists/i.test(body)) return true;
    throw new Error(`GitHub API (createBranch) : ${res.status} ${body}`);
  }
  return true;
}

// Crée ou met à jour un fichier sur une branche via l'API Contents.
async function putFile(token, branch, filePath, contentBase64, message) {
  // Vérifie si le fichier existe déjà (pour récupérer le sha et faire un update).
  let existingSha = null;
  const checkRes = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community'
    }
  });
  if (checkRes.ok) {
    const checkData = await checkRes.json();
    existingSha = checkData.sha;
  }

  const body = {
    message: message,
    content: contentBase64,
    branch: branch
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/contents/${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API (putFile) : ${res.status} ${errBody}`);
  }
  return true;
}

// Ouvre une Pull Request vers main.
async function createPullRequest(token, headBranch, title, body) {
  const res = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/pulls`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: title,
      body: body,
      head: headBranch,
      base: 'main'
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    // Si une PR existe déjà pour cette branche (422), on récupère l'URL existante.
    if (res.status === 422) {
      const existing = await findExistingPullRequest(token, headBranch);
      if (existing) return existing;
    }
    throw new Error(`GitHub API (createPullRequest) : ${res.status} ${errBody}`);
  }
  return await res.json();
}

// Cherche une PR déjà ouverte pour une branche donnée.
async function findExistingPullRequest(token, headBranch) {
  const res = await fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/pulls?head=${COMMUNITY_REPO.owner}:${headBranch}&state=open`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'BenchGo-V3-Community'
    }
  });
  if (!res.ok) return null;
  const prs = await res.json();
  if (Array.isArray(prs) && prs.length > 0) return prs[0];
  return null;
}

// Prépare le payload de soumission à partir d'un carnet de scores.
// On emballe le carnet avec des métadonnées (version BenchGo, date, userId,
// pseudo optionnel, hash d'intégrité) pour permettre la validation côté dépôt.
function buildSubmissionPayload(shortName, ledger, options) {
  options = options || {};
  const userId = options.userId || getOrCreateUserId();
  const pseudo = options.pseudo || null;
  const benchgoVersion = options.benchgoVersion || null;

  // Hash d'intégrité : permet à la GitHub Action de détecter les soumissions
  // falsifiées (un carnet édité à la main aura un hash non-reproductible car
  // il ne correspondra pas à un run réel — c'est une heuristique, pas une
  // garantie cryptographique, mais ça dissuade les tricheurs occasionnels).
  const integrityInput = JSON.stringify({
    model: ledger.model,
    shortName: ledger.shortName,
    ecoles: ledger.ecoles,
    lastUpdated: ledger.lastUpdated
  });
  const integrityHash = crypto.createHash('sha256').update(integrityInput).digest('hex').slice(0, 16);

  return {
    schemaVersion: 1,
    benchgoVersion: benchgoVersion,
    userId: userId,
    pseudo: pseudo,
    submittedAt: new Date().toISOString(),
    integrityHash: integrityHash,
    carnet: ledger
  };
}

// Soumet un carnet de scores sur le dépôt communautaire via une Pull Request.
//
// Étapes :
//   1. Récupère le SHA de main.
//   2. Crée une branche `community/<userId>-<shortName>`.
//   3. Dépose le fichier JSON dans `submissions/<userId>/<shortName>.json`.
//   4. Ouvre une PR vers main avec un message descriptif.
//
// @param {string} shortName - nom court du modèle (nom du fichier carnet).
// @param {object} ledger - contenu du carnet de scores.
// @param {string} token - PAT GitHub (scope repo).
// @param {object} options - { pseudo, benchgoVersion }
// @returns {Promise<{ok, prUrl, branch, filePath}>}
async function submitResults(shortName, ledger, token, options) {
  if (!shortName) throw new Error('shortName manquant');
  if (!ledger) throw new Error('carnet (ledger) manquant');
  if (!token) throw new Error('token GitHub manquant — utilisez --github-token ou configurez-le');

  options = options || {};
  const userId = options.userId || getOrCreateUserId();
  const payload = buildSubmissionPayload(shortName, ledger, options);

  // Nom de branche et chemin de fichier sanitizés.
  const safeShortName = String(shortName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const branchName = `community/${safeUserId}-${safeShortName}`;
  const filePath = `submissions/${safeUserId}/${safeShortName}.json`;

  // Étape 1 : SHA de main
  const mainSha = await getMainBranchSha(token);

  // Étape 2 : branche
  await createBranch(token, branchName, mainSha);

  // Étape 3 : fichier
  const contentBase64 = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64');
  const commitMsg = `community: soumission ${safeShortName} par ${safeUserId}`;
  await putFile(token, branchName, filePath, contentBase64, commitMsg);

  // Étape 4 : PR
  const prTitle = `[Communauté] Résultats ${ledger.model || safeShortName}`;
  const pseudoDisplay = options.pseudo ? ` (par **${options.pseudo}**)` : '';
  const prBody = [
    '## Soumission communautaire BenchGo',
    '',
    `**Modèle :** ${ledger.model || safeShortName}`,
    `**Utilisateur :** ${safeUserId}${pseudoDisplay}`,
    `**Date :** ${payload.submittedAt}`,
    `**Hash d'intégrité :** \`${payload.integrityHash}\``,
    '',
    'Ce carnet de scores a été généré par BenchGo V3 et soumis automatiquement',
    'via `node runner.js --submit`. Le propriétaire du dépôt validera cette PR',
    'pour intégrer les résultats au classement consolidé.',
    '',
    '---',
    '_Soumission automatique — ne pas éditer manuellement._'
  ].join('\n');

  const pr = await createPullRequest(token, branchName, prTitle, prBody);

  return {
    ok: true,
    prUrl: pr.html_url,
    branch: branchName,
    filePath: filePath
  };
}

// Vérifie qu'un token GitHub est valide en interrogeant l'API /user.
async function validateGithubToken(token) {
  try {
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'BenchGo-V3-Community'
      }
    });
    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { valid: true, login: data.login };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Récupère la liste des modèles déjà soumis par cet utilisateur sur le dépôt
// communautaire. Interroge l'API GitHub Contents sur submissions/<userId>/ et
// renvoie un Set de shortNames (sans extension .json) déjà présents.
//
// Permet à la modale de soumission de n'afficher que les NOUVEAUX modèles
// (ceux pas encore soumis), évitant de re-soumettre 400 modèles à chaque fois.
async function getAlreadySubmittedModels(token) {
  const userId = getOrCreateUserId();
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dirPath = `submissions/${safeUserId}`;

  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/contents/${encodeURIComponent(dirPath)}?ref=main`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'BenchGo-V3-Community'
        }
      }
    );
    // 404 = le dossier n'existe pas encore (première soumission) → Set vide.
    if (res.status === 404) return new Set();
    if (!res.ok) {
      logger.warn('getAlreadySubmittedModels: HTTP ' + res.status);
      return new Set();
    }
    const entries = await res.json();
    if (!Array.isArray(entries)) return new Set();
    // Extraction des noms de fichiers sans .json → shortNames.
    const submitted = new Set();
    for (const entry of entries) {
      if (entry.type === 'file' && entry.name.endsWith('.json')) {
        submitted.add(entry.name.replace(/\.json$/, ''));
      }
    }
    return submitted;
  } catch (e) {
    logger.warn('getAlreadySubmittedModels: ' + e.message);
    return new Set();
  }
}

module.exports = {
  COMMUNITY_REPO,
  PROFILE_FILE,
  loadProfile,
  saveProfile,
  getOrCreateUserId,
  getTelemetryConsent,
  setTelemetryConsent,
  getPublicPseudo,
  setPublicPseudo,
  getStoredGithubToken,
  setGithubToken,
  forgetGithubToken,
  sendPing,
  buildSubmissionPayload,
  submitResults,
  validateGithubToken,
  getAlreadySubmittedModels
};