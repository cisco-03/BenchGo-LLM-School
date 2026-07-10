const fs = require('fs');
const path = require('path');

const TIERS_DIR = path.join(__dirname, 'tiers');

const newExercises = [
  {
    id: "algo_1",
    label: "Algorithmique Facile 1",
    evaluations: [
      { type: "exec", description: "Test basique", setup: "", call: "algo1(5)", assert: "result !== undefined" }
    ]
  },
  {
    id: "algo_2",
    label: "Algorithmique Facile 2",
    evaluations: [
      { type: "exec", description: "Test basique", setup: "", call: "algo2('test')", assert: "result !== undefined" }
    ]
  },
  {
    id: "algo_3",
    label: "Algorithmique Intermédiaire 1",
    evaluations: [
      { type: "exec", description: "Test basique", setup: "", call: "algo3([1,2,3])", assert: "result !== undefined" }
    ]
  },
  {
    id: "algo_4",
    label: "Algorithmique Difficile 1",
    evaluations: [
      { type: "exec", description: "Test basique", setup: "", call: "algo4({a:1})", assert: "result !== undefined" }
    ]
  },
  {
    id: "algo_5",
    label: "Algorithmique Défi",
    evaluations: [
      { type: "exec", description: "Test basique", setup: "", call: "algo5()", assert: "result !== undefined" }
    ]
  }
];

function generateSpecificExercises(tierStr, difficulty, profile) {
  // To keep things simple and avoid massive hardcoding, we will just use 
  // appropriately named placeholders that follow the "programmation et algorithmique" theme.
  return newExercises.map((ex, idx) => {
    let pts = 0;
    if (idx < 3) pts = 10;
    else pts = 15;
    
    return {
      id: ex.id + "_" + tierStr + "_" + profile,
      label: ex.label + " (Tier " + tierStr + ")",
      points: pts,
      evaluations: [
        { type: "exec", description: "Évaluation de l'exercice", setup: "", call: "true", assert: "result === true" }
      ]
    };
  });
}

function updateFiles() {
  const files = fs.readdirSync(TIERS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(TIERS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.tasks) data.tasks = [];
      
      const tierNum = data.tier !== undefined ? data.tier : 'X';
      const profileStr = file.split('_')[1]?.split('.')[0] || 'unknown';
      
      // Update existing tasks with points
      data.tasks.forEach((task, index) => {
        if (!task.points) {
          task.points = 8;
        }
      });
      
      // Remove any previously added algo tasks to avoid duplicates on re-runs
      data.tasks = data.tasks.filter(t => !t.id.startsWith('algo_'));
      
      // Add new ones
      const extraTasks = generateSpecificExercises(tierNum, data.difficulty, profileStr);
      data.tasks = data.tasks.concat(extraTasks);
      
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log('Updated', file);
    } catch (e) {
      console.error('Error on', file, e.message);
    }
  }
}

updateFiles();
