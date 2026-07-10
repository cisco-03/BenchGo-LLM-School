const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TIERS_DIR = path.join(__dirname, 'tiers');

const newExercises = [
  { id: "algo_facile_1", label: "Algorithmique - Variables et Types", evaluations: [{ type: "exec", description: "Retourne basique", setup: "", call: "true", assert: "result === true" }] },
  { id: "algo_facile_2", label: "Algorithmique - Opérations de base", evaluations: [{ type: "exec", description: "Vérification", setup: "", call: "true", assert: "result === true" }] },
  { id: "algo_moyen_1",  label: "Algorithmique - Conditions et Boucles", evaluations: [{ type: "exec", description: "Logique moyenne", setup: "", call: "true", assert: "result === true" }] },
  { id: "algo_difficile_1", label: "Algorithmique - Structures de Données", evaluations: [{ type: "exec", description: "Logique difficile", setup: "", call: "true", assert: "result === true" }] },
  { id: "algo_defi",     label: "Algorithmique - Défi d'Optimisation", evaluations: [{ type: "exec", description: "Défi", setup: "", call: "true", assert: "result === true" }] }
];

function generateSpecificExercises(tierStr, profile) {
  return newExercises.map((ex, idx) => {
    let pts = 8;
    if (idx < 3) pts = 10;
    else pts = 15;
    
    return {
      id: ex.id + "_tier" + tierStr,
      label: ex.label,
      points: pts,
      evaluations: ex.evaluations
    };
  });
}

function updateTiers() {
  const files = fs.readdirSync(TIERS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(TIERS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let modified = false;

      if (!data.tasks) data.tasks = [];
      
      const tierNum = data.tier !== undefined ? data.tier : 'X';
      const profileStr = file.split('_')[1]?.split('.')[0] || 'unknown';
      
      data.tasks.forEach(task => {
        if (task.points === undefined) {
          task.points = 8;
          modified = true;
        }
      });
      
      const hasAlgo = data.tasks.some(t => t.id.startsWith('algo_'));
      if (!hasAlgo) {
        const extraTasks = generateSpecificExercises(tierNum, profileStr);
        data.tasks = data.tasks.concat(extraTasks);
        modified = true;
      }
      
      if (modified) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        logger.info(`Fichier JSON mis à jour avec les 5 nouveaux exercices : ${file}`);
      }
    } catch (e) {
      logger.error(`Erreur lors de la mise à jour de ${file} : ${e.message}`);
    }
  }
}

module.exports = { updateTiers };
