// update-checker.js — Avertit l'utilisateur qu'une mise à jour est disponible.
//
// Mécanisme : compare le SHA du commit local (git rev-parse HEAD) avec le
// dernier commit poussé sur la branche main du dépôt GitHub (API publique
// anonyme). Si les SHA diffèrent, une nouveauté/correction a été poussée et
// l'utilisateur doit faire `git pull` pour la récupérer.
//
// Deux usages :
//   1. CLI (runner.js) : bannière colorée au démarrage, avant le questionnaire.
//   2. Classement local (leaderboard.js) : bannière visuelle côté navigateur.
//      Le SHA local est embarqué dans le HTML à la génération ; le navigateur
//      fetch l'API GitHub et compare.
//
// Robustesse :
//   - Aucune donnée personnelle transmise (API GitHub publique, pas de token).
//   - Cache local (1h) pour éviter de spammer l'API GitHub à chaque lancement.
//   - Échec silencieux : pas de réseau / pas git / dépôt privé → pas d'avis.
//   - Cache partagé avec community-sync (.benchgo-profile.json) pour ne pas
//     multiplier les fichiers de profil.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

const COMMUNITY_REPO = { owner: 'cisco-03', repo: 'BenchGo-LLM-School' };
const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure

// Récupère le SHA du commit local courant via git rev-parse HEAD.
// Retourne null si git n'est pas disponible ou si le dossier n'est pas un dépôt.
function getLocalCommitSha() {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (e) {
    return null;
  }
}

// Récupère le SHA du dernier commit sur la branche main du dépôt GitHub.
// Utilise l'API publique anonyme (rate limit 60 req/h par IP, largement assez).
// Retourne null en cas d'échec réseau ou d'erreur API.
async function getRemoteCommitSha() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/commits/main`,
      {
        signal: controller.signal,
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'BenchGo-V3-Update-Check' }
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data && /^[0-9a-f]{40}$/.test(data.sha)) ? data.sha : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Récupère les N derniers commits distants (message + date + auteur) pour
// afficher un aperçu « Quoi de neuf ? » dans la bannière. Limité à 5 par défaut.
// Retourne un tableau d'objets { sha, message, date, author } ou [] si échec.
async function getRecentRemoteCommits(limit) {
  limit = Math.min(Math.max(limit || 5, 1), 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/commits?per_page=${limit}`,
      {
        signal: controller.signal,
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'BenchGo-V3-Update-Check' }
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(c => ({
      sha: c.sha,
      message: (c.commit && c.commit.message || '').split('\n')[0].slice(0, 120),
      date: c.commit && c.commit.author ? c.commit.author.date : null,
      author: c.commit && c.commit.author ? c.commit.author.name : null
    }));
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// --- Cache anti-spam (profil partagé avec community-sync) ---

function loadProfile() {
  const profileFile = path.join(__dirname, '.benchgo-profile.json');
  try {
    if (fs.existsSync(profileFile)) {
      const data = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {
    // profil illisible → on repart de zéro
  }
  return {};
}

function saveProfile(profile) {
  try {
    fs.writeFileSync(
      path.join(__dirname, '.benchgo-profile.json'),
      JSON.stringify(profile, null, 2) + '\n',
      'utf8'
    );
  } catch (e) {
    logger.warn('update-checker: impossible de sauvegarder le profil : ' + e.message);
  }
}

// Vérifie si une mise à jour est disponible, en utilisant le cache pour éviter
// de spammer l'API GitHub. Retourne un objet :
//   { updateAvailable: bool, localSha, remoteSha, commits: [], reason }
// - reason : 'up-to-date' | 'update-available' | 'no-git' | 'no-network' | 'cached'
// En cas de cache frais (< TTL), on retourne le résultat mis en cache sans
// recontacter GitHub, sauf si forceRefresh=true.
async function checkForUpdate(options) {
  options = options || {};
  const profile = loadProfile();
  const now = Date.now();
  const cache = profile.updateCheck || null;

  // Cache frais → on retourne le résultat caché.
  if (!options.forceRefresh && cache && cache.checkedAt && (now - cache.checkedAt) < CACHE_TTL_MS) {
    return { ...cache.result, reason: 'cached' };
  }

  const localSha = getLocalCommitSha();
  if (!localSha) {
    const result = { updateAvailable: false, localSha: null, remoteSha: null, commits: [], reason: 'no-git' };
    return result;
  }

  const remoteSha = await getRemoteCommitSha();
  if (!remoteSha) {
    const result = { updateAvailable: false, localSha, remoteSha: null, commits: [], reason: 'no-network' };
    // On ne cache pas l'échec réseau (pour réessayer plus vite).
    return result;
  }

  const updateAvailable = localSha !== remoteSha;
  let commits = [];
  if (updateAvailable) {
    commits = await getRecentRemoteCommits(5);
  }

  const result = { updateAvailable, localSha, remoteSha, commits, reason: updateAvailable ? 'update-available' : 'up-to-date' };

  // Met en cache (même si up-to-date, pour ne pas re-vérifier pendant 1h).
  profile.updateCheck = { checkedAt: now, result };
  saveProfile(profile);

  return result;
}

module.exports = {
  COMMUNITY_REPO,
  getLocalCommitSha,
  getRemoteCommitSha,
  getRecentRemoteCommits,
  checkForUpdate
};