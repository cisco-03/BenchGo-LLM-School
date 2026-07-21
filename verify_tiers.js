// Vérification exhaustive V2 : teste chaque exercice avec une solution canonique
// en style const/arrow (le cas qui cassait à cause des bugs setup/stripTS).

const fs = require('fs');
const path = require('path');
const { execCodeInVM } = require('./vm-sandbox');
const { stripTS } = require('./parsing-utils');
const { EVAL_TIMEOUT_MS } = require('./config');

const TIERS_DIR = path.join(__dirname, 'tiers');

// Solutions canoniques en style const/arrow pour tous les exercices connus.
// Clé = id de la tâche (les algo_* sont partagés entre profils).
const SOLUTIONS = {
  // Tier 0 light/standard
  tache_0a: 'const direBonjour = () => "Bonjour";',
  tache_0b: 'const retournerVrai = () => true;',
  tache_0c: 'const retourner42 = () => 42;',
  tache_0d: 'const additionner = (a, b) => a + b;',
  tache_0e: 'const identite = (x) => x;',
  // Tier 0 expert
  tache_0a_expert: 'const curry = (fn) => { const curried = (...args) => args.length >= fn.length ? fn(...args) : curried.bind(null, ...args); return curried; };',
  tache_0b_expert: 'const egalProfond = (a, b) => { if (a === b) return true; if (typeof a !== typeof b || a === null || b === null) return false; if (typeof a === "object") { const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false; return ka.every(k => egalProfond(a[k], b[k])); } return false; };',
  tache_0c_expert: 'const composer = (...fns) => (x) => fns.reduceRight((acc, f) => f(acc), x);',
  tache_0d_expert: 'const creerBST = () => { let root = null; const ins = (n, v) => { if (!n) return {val:v,left:null,right:null}; if (v<n.val) n.left=ins(n.left,v); else n.right=ins(n.right,v); return n; }; return { insert: (v) => { root = ins(root, v); }, contains: (v) => { let n = root; while (n) { if (v === n.val) return true; n = v < n.val ? n.left : n.right; } return false; } }; };',
  tache_0e_expert: 'const debounce = (fn, delai, immediat) => { let timer = null, called = false; return function(...args) { if (immediat && !called) { called = true; fn.apply(this, args); } if (timer) clearTimeout(timer); timer = setTimeout(() => { if (!immediat) fn.apply(this, args); called = false; }, delai); }; };',
  // Tier 1 light/standard
  tache_1a: 'const soustraire = (a, b) => a - b;',
  tache_1b: 'const superieurA10 = (n) => n > 10;',
  tache_1c: 'const concatener = (m1, m2) => m1 + " " + m2;',
  tache_1d: 'const estVide = (c) => c === "";',
  tache_1e: 'const multiplierPar2 = (n) => n * 2;',
  // Tier 1 standard
  tache_1a_std: 'const aire = (l, L) => l * L;',
  tache_1b_std: 'const remplacer = (s, a, b) => s.split(a).join(b);',
  tache_1c_std: 'const vitesse = (d, t) => t === 0 ? 0 : d / t;',
  tache_1d_std: 'const traduireAnimal = (m) => ({chien:"dog",chat:"cat"}[m] || "unknown");',
  tache_1e_std: 'const creerEleve = (nom, age) => ({ nom, age, classe: "5eme" });',
  // Tier 1 expert
  tache_1a_expert: 'const creerFilePriorite = () => { const items = []; return { enqueue: (val, p) => { items.push({val, p}); items.sort((a,b)=>a.p-b.p); }, dequeue: () => items.length ? items.shift().val : null, taille: () => items.length }; };',
  tache_1b_expert: 'const creerEventEmitter = () => { const l = {}; return { on: (e, fn) => { (l[e] = l[e] || []).push(fn); }, off: (e, fn) => { l[e] = (l[e]||[]).filter(f => f !== fn); }, emit: (e, ...args) => { (l[e]||[]).forEach(fn => fn(...args)); } }; };',
  tache_1c_expert: 'const zip = (...arrs) => { const min = Math.min(...arrs.map(a=>a.length)); const r=[]; for(let i=0;i<min;i++) r.push(arrs.map(a=>a[i])); return r; };',
  tache_1d_expert: 'const parcoursEnLargeur = (graphe, depart) => { const visites = []; const file = [depart]; while (file.length > 0) { const noeud = file.shift(); if (!visites.includes(noeud)) { visites.push(noeud); for (const v of (graphe[noeud] || [])) file.push(v); } } return visites; };',
  tache_1e_expert: 'const creerProxy = (cible, g) => new Proxy(cible, { get: (t,k) => g.get(t,k), set: (t,k,v) => { g.set(t,k,v); return true; } });',
  // Tier 2 light
  tache_2a: 'const longueurChaine = (c) => c.length;',
  tache_2b: 'const premierElement = (t) => t.length ? t[0] : undefined;',
  tache_2c: 'const estPair = (n) => n % 2 === 0;',
  tache_2d: 'const enMajuscules = (c) => c.toUpperCase();',
  tache_2e: 'const ajouterALaFin = (t, e) => { t.push(e); return t; };',
  // Tier 2 standard
  tache_2a_std: 'const pythagore = (a, b) => Math.sqrt(a*a + b*b);',
  tache_2b_std: 'const conjuguerJe = (v) => "je " + v.slice(0, -2) + "e";',
  tache_2c_std: 'const melanger = (c1, c2) => { const s = new Set([c1, c2]); return (s.has("bleu") && s.has("jaune")) ? "vert" : "marron"; };',
  tache_2d_std: 'const compterPays = (t) => t.length;',
  tache_2e_std: 'const SimpleComponent = (props) => "<div>" + props.titre + "</div>";',
  // Tier 2 expert
  tache_2a_expert: 'async function executerEnPool(taches, c) { const r = new Array(taches.length); let i = 0; async function run() { while (i < taches.length) { const idx = i++; r[idx] = await taches[idx]().catch(e => ({ error: e })); } } await Promise.all(Array.from({length: Math.min(c, taches.length)}, run)); return r; }',
  tache_2b_expert: 'const creerSubject = () => { const subs = []; let closed = false; return { subscribe: (o) => subs.push(o), next: (v) => { if(!closed) subs.forEach(s=>s.next&&s.next(v)); }, error: (e) => { if(!closed) subs.forEach(s=>s.error&&s.error(e)); closed=true; }, complete: () => { if(!closed) subs.forEach(s=>s.complete&&s.complete()); closed=true; } }; };',
  tache_2c_expert: 'const memoiserAsync = (fn) => { const cache = new Map(); return (x) => { if (cache.has(x)) return cache.get(x); const p = fn(x); cache.set(x, p); return p; }; };',
  tache_2d_expert: 'async function chargerUtilisateur(id) { const r = await fetch("/api/user/" + id); return r.json(); }',
  tache_2e_expert: 'const creerCircuitBreaker = (fn, seuil, delaiResetMs) => { let failures = 0, open = false, openTime = 0; return async (...args) => { if (open && Date.now() - openTime < delaiResetMs) throw new Error("open"); if (open) { open = false; failures = 0; } try { const r = await fn(...args); failures = 0; return r; } catch (e) { failures++; if (failures >= seuil) { open = true; openTime = Date.now(); } throw e; } }; };',
  // Tier 3 light
  tache_3a: 'const dernierElement = (t) => t[t.length - 1];',
  tache_3b: 'const compterJusqua = (n) => { const r = []; for (let i = 1; i <= n; i++) r.push(i); return r; };',
  tache_3c: 'const remplacerLettre = (m, a, n) => m.split(a).join(n);',
  tache_3d: 'const sommeTableau = (t) => t.reduce((s, x) => s + x, 0);',
  tache_3e: 'const contientA = (m) => /a/i.test(m);',
  // Tier 3 standard
  math_t3: 'const resoudreEquation = (a, b) => a === 0 ? null : -b / a;',
  francais_t3: 'const compterVoyelles = (p) => (p.match(/[aeiouy]/gi) || []).length;',
  histoire_t3: 'const trierAnnees = (a) => [...a].sort((x, y) => x - y);',
  svt_t3: 'const estADN = (c) => /^[ATCG]*$/.test(c);',
  info_t3: 'const bonsEleves = (e) => e.filter(x => x.moyenne >= 10).map(x => x.nom);',
  // Tier 3 expert
  tache_3b_expert: 'function remplirMatrice(grille, x, y, nv) { const ancien = grille[y][x]; if (ancien === nv) return; const pile = [[x, y]]; while (pile.length) { const [cx, cy] = pile.pop(); if (grille[cy] && grille[cy][cx] === ancien) { grille[cy][cx] = nv; pile.push([cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]); } } }',
  tache_3d_expert: 'const rechercherUtilisateurSecurise = (db, nom) => db.query("SELECT * FROM users WHERE nom = ?", [nom]);',
  tache_3e_expert: 'async function executerAvecRetry(op, max) { for (let i = 0; i < max; i++) { try { return await op(); } catch (e) { if (i === max - 1) throw e; await new Promise(r => setTimeout(r, Math.pow(2, i) * 100)); } } }',
  tache_3f_expert: 'const fusionnerConfig = (base, override) => { const r = Array.isArray(base) ? [...base] : {...base}; for (const k in override) { if (k === "__proto__") continue; r[k] = override[k]; } return r; };',
  // Tier 4 light
  tache_4a: 'const trouverMaximum = (t) => t.length ? Math.max(...t) : -Infinity;',
  tache_4b: 'const inverserChaine = (c) => c.split("").reverse().join("");',
  tache_4c: 'const compterVoyelles = (c) => (c.match(/[aeiou]/gi) || []).length;',
  tache_4d: 'const filtrerPositifs = (t) => t.filter(x => x > 0);',
  tache_4e: 'const repeterChaine = (c, n) => n <= 0 ? "" : c.repeat(n);',
  // Tier 4 standard
  math_t4: 'const discriminant = (a, b, c) => b*b - 4*a*c;',
  francais_t4: 'const estPalindrome = (m) => m === m.split("").reverse().join("");',
  physique_t4: 'const celsiusToFahrenheit = (c) => (c * 9/5) + 32;',
  langues_t4: 'const traduire = (m, l) => m !== "bonjour" ? "?" : (l === "EN" ? "hello" : l === "ES" ? "hola" : "?");',
  react_t4: 'const ButtonComponent = (p) => "<button onClick={" + p.onClick + "}>" + p.label + "</button>";',
  // Tier 4 frontier
  tache_4a_frontier: 'function creerLRU(cap) { const m = new Map(); return { get: (k) => { if (!m.has(k)) return -1; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, put: (k, v) => { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > cap) m.delete(m.keys().next().value); } }; }',
  tache_4b_frontier: 'const deepClone = (o, seen = new Map()) => { if (o === null || typeof o !== "object") return o; if (o instanceof Date) return new Date(o); if (seen.has(o)) return seen.get(o); const c = Array.isArray(o) ? [] : {}; seen.set(o, c); for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = deepClone(o[k], seen); return c; };',
  // Tier 5 light
  tache_5a: 'const doublons = (t) => t.filter((x, i) => t.indexOf(x) !== i);',
  tache_5b: 'const capitaliser = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";',
  tache_5c: 'const frequenceCaracteres = (s) => { const r = {}; for (const c of s) r[c] = (r[c]||0)+1; return r; };',
  tache_5d: 'const filtrerPairs = (t) => t.filter(x => x % 2 === 0);',
  tache_5e: 'const plusLongue = (s) => s.split(" ").reduce((a, b) => b.length > a.length ? b : a, "");',
  // Tier 5 standard
  math_t5: 'const moyennePonderee = (notes) => { if(!notes.length) return 0; let s=0,c=0; for(const n of notes){s+=n.valeur*n.coeff;c+=n.coeff;} return c===0?0:s/c; };',
  francais_t5: 'const frequenceMots = (p) => { const r={}; for(const m of p.split(/\\s+/)){ if(!m)continue; r[m]=(r[m]||0)+1; } return r; };',
  svt_t5: 'const transcrireADN = (a) => { const m={A:"U",T:"A",C:"G",G:"C"}; let r=""; for(const c of a) r+=m[c]||c; return r; };',
  histoire_t5: 'const grouperParEpoque = (e) => { const r={}; for(const x of e){ if(!r[x.epoque])r[x.epoque]=[]; r[x.epoque].push(x.nom); } return r; };',
  info_t5: "class FeuTricolore { constructor() { this.couleur = 'rouge'; } passerAuSuivant() { const o=['rouge','vert','orange']; this.couleur=o[(o.indexOf(this.couleur)+1)%3]; } }",
  // algo communs (partagés entre profils, id identiques)
  algo_facile_1: 'const estPair = (n) => n % 2 === 0;',
  algo_facile_2: 'const carre = (n) => n * n;',
  algo_moyen_1: 'const somme1aN = (n) => { let s=0; for(let i=1;i<=n;i++)s+=i; return s; };',
  algo_difficile_1: 'const inverserChaine = (s) => s.split("").reverse().join("");',
  algo_defi: 'const valeurMax = (t) => Math.max(...t)',
  // algo tier 1
  algo_facile_1_t1: 'const estMultipleDe = (n, m) => m !== 0 && n % m === 0;',
  algo_facile_2_t1: 'const puissance = (b, e) => Math.pow(b, e);',
  algo_moyen_1_t1: 'const compterPairs = (t) => t.filter(x => x % 2 === 0).length;',
  algo_difficile_1_t1: 'const supprimerDoublons = (t) => [...new Set(t)];',
  algo_defi_t1: 'const sommePaires = (t) => t.filter(x => x % 2 === 0).reduce((s, x) => s + x, 0);',
  // algo tier 2
  algo_facile_1_t2: 'const estPalindrome = (s) => s === s.split("").reverse().join("");',
  algo_facile_2_t2: 'const pgcd = (a, b) => { while (b !== 0) { [a, b] = [b, a % b]; } return a; };',
  algo_moyen_1_t2: 'const nombreMots = (s) => { const t = s.trim(); return t === "" ? 0 : t.split(/\\s+/).length; };',
  algo_difficile_1_t2: 'const fusionTriee = (a, b) => { let i=0,j=0; const r=[]; while(i<a.length&&j<b.length){ if(a[i]<=b[j])r.push(a[i++]); else r.push(b[j++]); } return r.concat(a.slice(i),b.slice(j)); };',
  algo_defi_t2: 'const sontAnagrammes = (a, b) => a.length===b.length && a.split("").sort().join("")===b.split("").sort().join("");',
  // algo tier 3
  algo_facile_1_t3: 'const validerParentheses = (s) => { let p=0; for(const c of s){ if(c==="(")p++; else if(c===")"){ if(p===0)return false; p--; } } return p===0; };',
  algo_facile_2_t3: 'const fibonacci = (n) => { if(n<=0)return 0; if(n===1)return 1; let a=0,b=1; for(let i=2;i<=n;i++){const t=a+b;a=b;b=t;} return b; };',
  algo_moyen_1_t3: 'const motsUniques = (s) => new Set(s.trim().split(/\\s+/)).size;',
  algo_difficile_1_t3: 'const aplatirTableau = (t) => t.flat(1);',
  algo_defi_t3: 'const rotationDroite = (t, k) => { if(!t.length)return []; k=k%t.length; if(k===0)return [...t]; return t.slice(-k).concat(t.slice(0,-k)); };',
  // algo tier 4
  algo_facile_1_t4: 'const capitaliserMots = (s) => s.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" ");',
  algo_facile_2_t4: 'const sommeChiffres = (n) => String(n).split("").reduce((s,c)=>s+Number(c),0);',
  algo_moyen_1_t4: 'const grouperParParite = (t) => ({ pairs: t.filter(x=>x%2===0), impairs: t.filter(x=>x%2!==0) });',
  algo_difficile_1_t4: 'const plusLongMot = (s) => { const w=s.split(" "); let b=""; for(const x of w)if(x.length>b.length)b=x; return b; };',
  algo_defi_t4: 'const mediane = (t) => { const s=[...t].sort((a,b)=>a-b); const n=s.length; return n%2?s[Math.floor(n/2)]:(s[n/2-1]+s[n/2])/2; };',
  // algo tier 5
  algo_facile_1_t5: 'const convertirBase = (n, b) => n.toString(b).toLowerCase();',
  algo_facile_2_t5: 'const kemePlusGrand = (t, k) => [...new Set(t)].sort((a,b)=>b-a)[k-1];',
  algo_moyen_1_t5: 'const compteurFrequence = (t) => { const r={}; for(const x of t)r[x]=(r[x]||0)+1; return r; };',
  algo_difficile_1_t5: 'const exponentiationRapide = (x, n) => { if(n===0)return 1; let r=1; while(n>0){if(n%2===1)r*=x;x*=x;n=Math.floor(n/2);} return r; };',
  algo_defi_t5: 'const sousTableauMax = (t) => { let m=-Infinity,c=0; for(const x of t){c=Math.max(x,c+x);m=Math.max(m,c);} return m; };',
  // algo tier 6
  algo_facile_1_t6: 'const fusionIntervalles = (intervals) => { if(!intervals.length)return []; intervals.sort((a,b)=>a[0]-b[0]); const r=[intervals[0]]; for(const i of intervals.slice(1)){ const last=r[r.length-1]; if(i[0]<=last[1]) last[1]=Math.max(last[1],i[1]); else r.push(i); } return r; };',
  algo_facile_2_t6: 'const prefixeCommun = (strs) => { if(!strs.length)return ""; let p=strs[0]; for(const s of strs.slice(1)){ while(s.indexOf(p)!==0) p=p.slice(0,-1); } return p; };',
  algo_moyen_1_t6: 'const compterBits = (n) => { let c=0; while(n){c+=n&1;n>>=1;} return c; };',
  algo_difficile_1_t6: 'const medianeDeuxTriees = (a, b) => { const m = [...a, ...b].sort((x,y)=>x-y); const n = m.length; return n%2 ? m[Math.floor(n/2)] : (m[n/2-1]+m[n/2])/2; };',
  algo_defi_t6: 'const plusLongueCroissante = (nums) => { if(!nums.length)return 0; const tails=[nums[0]]; for(const x of nums.slice(1)){ if(x>tails[tails.length-1]) tails.push(x); else { let lo=0,hi=tails.length-1; while(lo<hi){const mid=(lo+hi)>>1; if(tails[mid]<x)lo=mid+1; else hi=mid;} tails[lo]=x; } } return tails.length; };',
  // Tier 6 master
  trier_tableau: 'function trierTableau(t) { return [...t].sort((a,b)=>a-b); }',
  memoire_longue: 'function memoireLongue(texte, cle) { const idx = texte.indexOf(cle); return idx === -1 ? null : texte.substring(idx, idx + 500); }',
  calcul_robuste: 'function calculRobuste(prompt) { const m = prompt.match(/\\d+/); return m ? Number(m[0]) * 2 : null; }',
  optimisation_extreme: 'function optimisation_extreme(arr, target) { for (let i = 0; i < arr.length; i++) { if (arr[i] === target) return true; } return false; }',
};

// Map task id -> solution key, en tenant compte du profil et du tier
function getSolutionKey(task, tierNum, profile) {
  // D'abord essayer id_profil (ex: tache_0a_expert)
  const expertKeys = ['tache_0a','tache_0b','tache_0c','tache_0d','tache_0e','tache_1a','tache_1b','tache_1c','tache_1d','tache_1e','tache_2a','tache_2b','tache_2c','tache_2d','tache_2e','tache_3b','tache_3d','tache_3e','tache_3f','tache_4a','tache_4b'];
  if (expertKeys.includes(task.id) && profile !== 'light' && profile !== 'standard') {
    const k = task.id + '_' + profile;
    if (SOLUTIONS[k]) return k;
  }
  // algo_* par tier
  if (task.id.startsWith('algo_')) {
    const k = task.id + '_t' + tierNum;
    if (SOLUTIONS[k]) return k;
  }
  // math/francais/etc par tier
  const subjKeys = ['math','francais','svt','histoire','info','physique','langues','react','chimie','geo','anglais','contient','absolu'];
  if (subjKeys.includes(task.id)) {
    const k = task.id + '_t' + tierNum;
    if (SOLUTIONS[k]) return k;
  }
  return task.id;
}

const files = fs.readdirSync(TIERS_DIR).filter(f => f.endsWith('.json'));
let totalIssues = 0, totalTests = 0, totalPass = 0, totalSkip = 0;

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(TIERS_DIR, file), 'utf8'));
  const profile = file.replace(/^tier\d+_/, '').replace('.json', '');
  const tierNum = data.tier;
  console.log(`\n${'='.repeat(60)}\n${file} (tier ${tierNum}, ${profile})\n${'='.repeat(60)}`);

  for (const task of (data.tasks || [])) {
    const solKey = getSolutionKey(task, tierNum, profile);
    const sol = SOLUTIONS[solKey];
    let passCount = 0, failCount = 0, skipCount = 0;
    let failMsgs = [];

    for (const ev of (task.evaluations || [])) {
      if (ev.type === 'exec') {
        totalTests++;
        if (!sol) { skipCount++; totalSkip++; continue; }
        const r = execCodeInVM(stripTS(sol), ev.setup || '', ev.call, ev.assert, ev.maxTimeMs || EVAL_TIMEOUT_MS);
        if (r.passed) { passCount++; totalPass++; }
        else { failCount++; failMsgs.push(`[${ev.description}] ${r.error}`); totalIssues++; }
      } else {
        skipCount++;
      }
    }

    if (failCount > 0) {
      console.log(`  ✘ ${task.id}: ${failCount} ÉCHEC(s) sur ${passCount+failCount} exec`);
      for (const m of failMsgs) console.log(`      ${m}`);
    } else if (passCount > 0) {
      console.log(`  ✔ ${task.id}: ${passCount} exec OK`);
    } else {
      console.log(`  • ${task.id}: ${skipCount} éval(s) non-exec (skip)`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`BILAN: ${totalPass} exec OK / ${totalTests} exec testés (${totalSkip} skip), ${totalIssues} problème(s)`);
console.log(`${'='.repeat(60)}`);