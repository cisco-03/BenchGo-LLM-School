const fs = require('fs');
const h = fs.readFileSync('Export-Rapports/classement.html', 'utf8');
const i = h.indexOf('id="catSelect"');
const block = h.substring(i, i + 500).split('</select>')[0];
console.log('=== catSelect options in generated HTML ===');
// Print each option with its raw text
const opts = block.match(/<option[^>]*>.*?<\/option>/g);
if (opts) opts.forEach((o, idx) => {
  const val = o.match(/value="([^"]*)"/);
  const text = o.replace(/<[^>]*>/g, '');
  const stripped = text.replace(/\s*\(\d+\)\s*$/, '').trim();
  console.log(`  [${idx}] value="${val?val[1]:'?'}" text="${text}" stripped="${stripped}"`);
});