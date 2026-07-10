const fs = require('fs');
const path = require('path');

const tiersDir = path.join(__dirname, 'tiers');
const files = fs.readdirSync(tiersDir).filter(f => f.endsWith('.json'));

let totalTokensLight = 0;
const lightFiles = files.filter(f => f.includes('light.json')).sort();

console.log("=== Analyse des Tokens (Profil: LIGHT) ===");
lightFiles.forEach(file => {
  const content = fs.readFileSync(path.join(tiersDir, file), 'utf-8');
  const tokens = Math.ceil(content.length / 4);
  console.log(`- ${file}: ~${tokens} tokens`);
  totalTokensLight += tokens;
});

console.log(`\nTOTAL pour l'école primaire (Tiers 0 à 5) en LIGHT: ~${totalTokensLight} tokens`);

const expertFiles = files.filter(f => f.includes('expert.json') || f.includes('master.json') || f.includes('frontier.json')).sort();
let totalTokensExpert = 0;
console.log("\n=== Analyse des Tokens (Profils Supérieurs) ===");
expertFiles.forEach(file => {
  const content = fs.readFileSync(path.join(tiersDir, file), 'utf-8');
  const tokens = Math.ceil(content.length / 4);
  console.log(`- ${file}: ~${tokens} tokens`);
  totalTokensExpert += tokens;
});
console.log(`\nTOTAL pour les Tiers 0-6 complexes: ~${totalTokensExpert} tokens`);

// Script de correction pour enlever les vieilles instructions JSON des fichiers
files.forEach(file => {
  const filePath = path.join(tiersDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  let data = JSON.parse(content);

  if (data.prompt) {
    // Remplacer l'instruction JSON
    data.prompt = data.prompt.replace(/Return your answers as a SINGLE JSON object[^\n]+\n/g, 'Return your answers in Markdown using headers for the exercise IDs and code blocks for the JavaScript functions.\n');
    
    // Remplacer l'exemple JSON par un exemple Markdown
    const jsonExampleRegex = /Expected strict response format:\n\{\n(?:  "[^"]+": "function [^"]+",\n)*(?:  "[^"]+": "function [^"]+"\n)?\}/g;
    data.prompt = data.prompt.replace(jsonExampleRegex, 'Expected Markdown format:\n### tache_X\n```javascript\nfunction solution() { ... }\n```');
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
});
console.log("\n=> Fichiers tiers mis à jour pour remplacer le JSON par du Markdown.");
