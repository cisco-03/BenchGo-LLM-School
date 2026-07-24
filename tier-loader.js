const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TIERS_DIR = path.join(__dirname, 'tiers');

/**
 * Charge les tiers adaptés au profil demandé.
 * Priorité : tier{N}_{profile}.json > tier{N}_{fallback}.json
 * Fallback chain : DOCTORAT → EXPERT → STANDARD → LIGHT → MASTER
 * Le niveau "master" (tier6_master.json) est le fichier partagé pour le tier 6
 * (Expertise & Résistance) utilisé par STANDARD, EXPERT, DOCTORAT et FRONTIER.
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

  const tiers = {};

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

  return tiers;
}

module.exports = { loadTiers };

