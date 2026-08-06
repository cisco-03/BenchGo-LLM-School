// community-stats.js — Statistiques d'utilisation communautaire (côté propriétaire).
//
// Ce module est destiné au propriétaire du dépôt (celui qui a le token avec
// droits suffisants). Il interroge l'API GitHub pour récupérer :
//   - le nombre de clones uniques (GitHub Insights → Traffic)
//   - le nombre de vues uniques (proxy pour le nombre d'utilisateurs actifs,
//     incrémenté par le ping télémétrie de community-sync.js)
//   - le nombre de soumissions communautaires en attente (PRs ouvertes)
//   - le nombre total de soumissions mergées (fichiers dans submissions/)
//
// Utilisation :  node community-stats.js --token=ghp_xxx
//
// Le token doit avoir au minimum le scope `repo` (pour le traffic) et
// idéalement `read:org` si le dépôt appartient à une organisation.

const fs = require('fs');
const path = require('path');
const { COMMUNITY_REPO } = require('./community-sync');
const { printEntryHelp, wantsHelp } = require('./cli-help');

const GITHUB_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'BenchGo-V3-CommunityStats'
  };
}

// Récupère les statistiques de trafic (vues + clones) sur 14 jours.
// Nécessite le scope repo + accès push au dépôt (limitation API GitHub).
async function fetchTrafficStats(token) {
  try {
    const [viewsRes, clonesRes] = await Promise.all([
      fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/traffic/views`, { headers: ghHeaders(token) }),
      fetch(`${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/traffic/clones`, { headers: ghHeaders(token) })
    ]);

    const result = { views: null, clones: null };
    if (viewsRes.ok) result.views = await viewsRes.json();
    else result.viewsError = `HTTP ${viewsRes.status}`;
    if (clonesRes.ok) result.clones = await clonesRes.json();
    else result.clonesError = `HTTP ${clonesRes.status}`;
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

// Récupère le nombre de PRs communautaires ouvertes (soumissions en attente).
async function fetchOpenCommunityPRs(token) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/pulls?state=open&per_page=100`,
      { headers: ghHeaders(token) }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const prs = await res.json();
    // Filtre les PRs communautaires (titre commence par [Communauté])
    const communityPRs = prs.filter(pr => /^\[Communaut[eé]\]/i.test(pr.title || ''));
    return { count: communityPRs.length, prs: communityPRs };
  } catch (e) {
    return { error: e.message };
  }
}

// Compte le nombre de fichiers dans submissions/ (soumissions mergées).
async function fetchSubmissionCount(token) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}/contents/submissions?ref=main`,
      { headers: ghHeaders(token) }
    );
    if (res.status === 404) return { count: 0, users: 0 }; // dossier pas encore créé
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const entries = await res.json();
    if (!Array.isArray(entries)) return { count: 0, users: 0 };
    // submissions/ contient un sous-dossier par userId
    const userDirs = entries.filter(e => e.type === 'dir');
    let totalFiles = 0;
    for (const dir of userDirs) {
      const dirRes = await fetch(dir.url, { headers: ghHeaders(token) });
      if (dirRes.ok) {
        const files = await dirRes.json();
        if (Array.isArray(files)) totalFiles += files.filter(f => f.type === 'file').length;
      }
    }
    return { count: totalFiles, users: userDirs.length };
  } catch (e) {
    return { error: e.message };
  }
}

// Récupère le nombre d'étoiles et de forks (popularité du projet).
async function fetchRepoMeta(token) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}`,
      { headers: ghHeaders(token) }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      stars: data.stargazers_count || 0,
      forks: data.forks_count || 0,
      watchers: data.subscribers_count || 0,
      openIssues: data.open_issues_count || 0,
      createdAt: data.created_at,
      pushedAt: data.pushed_at
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Affiche un tableau de bord récapitulatif dans la console.
async function printDashboard(token) {
  console.log('\n  \x1b[1;36m━━━ TABLEAU DE BORD COMMUNAUTAIRE — BenchGo ━━━\x1b[0m');
  console.log(`  \x1b[90mDépôt : ${COMMUNITY_REPO.owner}/${COMMUNITY_REPO.repo}\x1b[0m\n`);

  const [traffic, prs, submissions, meta] = await Promise.all([
    fetchTrafficStats(token),
    fetchOpenCommunityPRs(token),
    fetchSubmissionCount(token),
    fetchRepoMeta(token)
  ]);

  // --- Trafic ---
  if (meta && !meta.error) {
    console.log(`  \x1b[1m⭐ Étoiles\x1b[0m        : ${meta.stars}`);
    console.log(`  \x1b[1m🍴 Forks\x1b[0m         : ${meta.forks}`);
    console.log(`  \x1b[1m👀 Watchers\x1b[0m      : ${meta.watchers}`);
    console.log(`  \x1b[1m📋 Issues ouvertes\x1b[0m : ${meta.openIssues}`);
    console.log('');
  } else if (meta && meta.error) {
    console.log(`  \x1b[33m⚠ Trafic dépôt : ${meta.error}\x1b[0m\n`);
  }

  // --- Vues & Clones ---
  if (traffic && traffic.views) {
    const v = traffic.views;
    console.log(`  \x1b[1m👁 Vues (14j)\x1b[0m    : ${v.count} total · ${v.uniques} uniques`);
    if (v.views && v.views.length > 0) {
      console.log('  \x1b[90m  Derniers jours :\x1b[0m');
      const recent = v.views.slice(-7);
      for (const d of recent) {
        const date = d.timestamp.slice(0, 10);
        const bar = '█'.repeat(Math.min(20, Math.round(d.uniques / 2)));
        console.log(`  \x1b[90m  ${date} : ${String(d.uniques).padStart(3)} uniques ${bar}\x1b[0m`);
      }
    }
  } else if (traffic && traffic.viewsError) {
    console.log(`  \x1b[33m⚠ Vues : ${traffic.viewsError} (nécessite droits push sur le dépôt)\x1b[0m`);
  }

  if (traffic && traffic.clones) {
    const c = traffic.clones;
    console.log(`  \x1b[1m📥 Clones (14j)\x1b[0m  : ${c.count} total · ${c.uniques} uniques`);
  } else if (traffic && traffic.clonesError) {
    console.log(`  \x1b[33m⚠ Clones : ${traffic.clonesError}\x1b[0m`);
  }
  console.log('');

  // --- Soumissions ---
  if (submissions && !submissions.error) {
    console.log(`  \x1b[1m📦 Soumissions mergées\x1b[0m : ${submissions.count} carnet(s) de ${submissions.users} utilisateur(s)`);
  } else if (submissions && submissions.error) {
    console.log(`  \x1b[33m⚠ Soumissions : ${submissions.error}\x1b[0m`);
  }

  if (prs && !prs.error) {
    if (prs.count > 0) {
      console.log(`  \x1b[1m⏳ PRs en attente\x1b[0m     : ${prs.count}`);
      for (const pr of prs.prs) {
        console.log(`  \x1b[90m    #${pr.number} ${pr.title} — ${pr.html_url}\x1b[0m`);
      }
    } else {
      console.log(`  \x1b[1m⏳ PRs en attente\x1b[0m     : 0`);
    }
  } else if (prs && prs.error) {
    console.log(`  \x1b[33m⚠ PRs : ${prs.error}\x1b[0m`);
  }
  console.log('');

  // --- Ratio de conversion participation ---
  // Soumissions réussies / clones uniques (14j) = taux de participation active.
  // Si ≈ 0 %, cela confirme que personne ne soumet malgré le clonage.
  const clonesUniques = (traffic && traffic.clones && typeof traffic.clones.uniques === 'number') ? traffic.clones.uniques : null;
  const subCount = (submissions && !submissions.error && typeof submissions.count === 'number') ? submissions.count : null;
  if (clonesUniques != null && subCount != null) {
    const ratio = clonesUniques > 0 ? ((subCount / clonesUniques) * 100) : 0;
    const ratioStr = ratio.toFixed(1) + '%';
    const rc = ratio === 0 ? '\x1b[33m' : (ratio < 5 ? '\x1b[36m' : '\x1b[32m');
    console.log(`  \x1b[1m📊 Taux de participation\x1b[0m : ${rc}${ratioStr}\x1b[0m  \x1b[90m(soumissions mergées / clones uniques 14j)\x1b[0m`);
    if (ratio === 0) {
      console.log(`  \x1b[33m⚠ Aucune soumission malgré des clones — les utilisateurs clonent mais ne soumettent pas.\x1b[0m`);
    }
    console.log('');
  }

  // --- PRs en attente = 0 + note sur la visibilité des échecs ---
  if (prs && !prs.error && prs.count === 0) {
    console.log(`  \x1b[33m⚠ Aucune PR en attente — si vous attendiez des soumissions communautaires,\x1b[0m`);
    console.log(`  \x1b[33m  elles ont peut-être échoué chez les utilisateurs (non visible sans token valide chez eux).\x1b[0m\n`);
  }

  // --- Section interprétation ---
  console.log(`  \x1b[1;36m━━━ INTERPRÉTATION ━━━\x1b[0m`);
  console.log(`  \x1b[90m• Les soumissions mergées sont visibles ici (dossier submissions/).\x1b[0m`);
  console.log(`  \x1b[90m• Les tentatives échouées NE sont PAS visibles (un échec ne crée pas de\x1b[0m`);
  console.log(`  \x1b[90m  fichier/PR). Pour savoir si quelqu'un essaie sans succès, le propriétaire\x1b[0m`);
  console.log(`  \x1b[90m  doit demander les logs à l'utilisateur (logs/benchgo_*.log).\x1b[0m`);
  console.log(`  \x1b[90m• Comparez le nombre de clones uniques (adoption) au nombre de soumissions\x1b[0m`);
  console.log(`  \x1b[90m  réussies (participation active) pour estimer le ratio de conversion.\x1b[0m`);
  console.log('');
}

module.exports = {
  fetchTrafficStats,
  fetchOpenCommunityPRs,
  fetchSubmissionCount,
  fetchRepoMeta,
  printDashboard
};

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  // --help / help / -h : affiche l aide puis quitte. Outil propriétaire.
  if (wantsHelp(args)) {
    printEntryHelp('community-stats.js', 'Tableau de bord communautaire (côté propriétaire)', [
      { cmd: 'node community-stats.js --token=ghp_xxx', desc: 'Affiche le dashboard (clones, vues, PRs, soumissions mergées).' },
      { cmd: 'set GITHUB_TOKEN=ghp_xxx && node community-stats.js', desc: 'Via la variable d environnement GITHUB_TOKEN (ou GH_TOKEN).' },
      { cmd: 'node community-stats.js --help  |  help  |  -h', desc: 'Affiche cette aide.' }
    ], [
      'OUTIL PROPRIÉTAIRE : nécessite un token GitHub avec droits push sur le dépôt communautaire.',
      'Le token doit avoir le scope repo (traffic) — idéalement read:org pour une organisation.',
      'Récupération rapide du token : gh auth token'
    ]);
    process.exit(0);
  }
  const tokenArg = args.find(a => a.startsWith('--token='));
  const token = tokenArg ? tokenArg.split('=').slice(1).join('=') : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN);

  if (!token) {
    console.error('\x1b[31m[ERREUR]\x1b[0m Token GitHub requis.');
    console.log('  Usage : node community-stats.js --token=ghp_xxxxx');
    console.log('  Ou    : set GITHUB_TOKEN=ghp_xxxxx && node community-stats.js');
    process.exit(1);
  }

  printDashboard(token).catch(e => {
    console.error(`\x1b[31m[ERREUR]\x1b[0m ${e.message}`);
    process.exit(1);
  });
}