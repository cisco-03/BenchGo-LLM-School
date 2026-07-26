const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const TIERS_DIR = path.join(__dirname, 'tiers');

// Cache des tiers chargés par profil, avec invalidation par mtime des fichiers
// tiers/*.json (Plan §2 Performance). On évite de relire+parse les 16 fichiers
// JSON à chaque appel loadTiers() au sein d'un même run (appelé 1 fois par école
// dans un run multi-écoles). L'invalidation se fait en comparant le mtime de
// chaque fichier : si un tier a été modifié (ex: auto-updater), le cache est
// invalidé pour ce profil. Clé = profil, valeur = { tiers, signatures }.
const _tierCache = new Map();

// Calcule une signature { file, mtimeMs, size } pour un fichier tier.
function tierSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { file: path.basename(filePath), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (_) {
    return null;
  }
}

/**
 * Charge les tiers adaptés au profil demandé.
 * Priorité : tier{N}_{profile}.json > tier{N}_{fallback}.json
 * Fallback chain : DOCTORAT → EXPERT → STANDARD → LIGHT → MASTER
 * Le niveau "master" (tier6_master.json) est le fichier partagé pour le tier 6
 * (Expertise & Résistance) utilisé par STANDARD, EXPERT, DOCTORAT et FRONTIER.
 *
 * Cache : si le profil a déjà été chargé ET qu'aucun fichier tier n'a changé
 * (mtime+size identiques), on renvoie le tiers mis en cache. Sinon, on recharge
 * et on met à jour la signature. Journalisé pour le diagnostic.
 */
function loadTiers(profileArg) {
  const profile = (profileArg || 'LIGHT').toUpperCase();
  const fallbackChain = {
    FRONTIER: ['FRONTIER','DOCTORAT','EXPERT','STANDARD','LIGHT','MASTER'],
    DOCTORAT: ['DOCTORAT','EXPERT','STANDARD','LIGHT','MASTER'],
    EXPERT: ['EXPERT','STANDARD','LIGHT','MASTER'],
    STANDARD: ['STANDARD','LIGHT','MASTER'],
    LIGHT: ['LIGHT','MASTER']
  };
  const chain = fallbackChain[profile] || ['LIGHT','MASTER'];

  // --- Vérification du cache : compare les signatures des fichiers utilisés ---
  const cached = _tierCache.get(profile);
  if (cached) {
    let allFresh = true;
    for (const sig of cached.signatures) {
      const current = tierSignature(path.join(TIERS_DIR, sig.file));
      if (!current || current.mtimeMs !== sig.mtimeMs || current.size !== sig.size) {
        allFresh = false;
        logger.info('TierLoader: cache invalidé pour ' + profile + ' — fichier modifié : ' + sig.file);
        break;
      }
    }
    if (allFresh) {
      logger.info('TierLoader: cache HIT pour ' + profile + ' (' + Object.keys(cached.tiers).length + ' tiers)');
      return cached.tiers;
    }
  }

  const tiers = {};
  const signatures = [];

  // Détecte tous les numéros de tiers disponibles
  const allFiles = fs.readdirSync(TIERS_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  const tierNums = [...new Set(
    allFiles.map(f => { const m = f.match(/^tier(\d+)/i); return m ? parseInt(m[1]) : null; }).filter(n => n !== null)
  )].sort((a, b) => a - b);

  for (const num of tierNums) {
    // Cherche le fichier le plus adapté au profil selon la chaîne de fallback
    let loaded = false;
    for (const lvl of chain) {
      const candidate = `tier${num}_${lvl.toLowerCase()}.json`;
      const filePath = path.join(TIERS_DIR, candidate);
      if (!fs.existsSync(filePath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof data.tier !== 'number') {
          logger.warn(`Fichier tier ignoré (champ 'tier' manquant) : ${candidate}`);
          continue;
        }
        tiers[num] = data;
        signatures.push(tierSignature(filePath));
        logger.info(`Tier ${num} chargé : ${candidate} (profil ${profile})`);
        loaded = true;
        break;
      } catch (e) {
        logger.error(`Échec du chargement de ${candidate} : ${e.message}`);
        throw new Error(`Impossible de charger le fichier de tier '${candidate}' : ${e.message}`);
      }
    }
    if (!loaded) {
      logger.warn(`Aucun fichier trouvé pour tier ${num} avec le profil ${profile}.`);
    }
  }

  // Mise en cache avec signatures pour invalidation future.
  _tierCache.set(profile, { tiers, signatures });
  logger.info('TierLoader: cache MISS pour ' + profile + ' — ' + Object.keys(tiers).length + ' tiers chargés et mis en cache');
  return tiers;
}

// Invalide manuellement le cache (utile après auto-updater qui modifie les tiers).
function invalidateTierCache(profile) {
  if (profile) {
    _tierCache.delete((profile || '').toUpperCase());
    logger.info('TierLoader: cache invalidé manuellement pour ' + profile);
  } else {
    _tierCache.clear();
    logger.info('TierLoader: cache invalidé entièrement');
  }
}

module.exports = { loadTiers, invalidateTierCache };

