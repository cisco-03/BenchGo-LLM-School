const { SPINNER_CHARS } = require('./config');
const logger = require('./logger');

const BAR_WIDTH = 30;

// Intervalle de rotation des messages pédagogiques (ms). Le label fixe reste
// affiché (⠋ <label>...), et une phrase pédagogique change sous lui toutes les
// ~5s pour tenir l'utilisateur en haleine pendant les temps morts longs.
const MESSAGE_ROTATION_MS = 5000;

// ============================================================
// ProgressBar enrichie — phases + ETA dynamique (Plan §3 UI/Ludisme)
// ============================================================
// La ProgressBar originale n'affichait qu'un pourcentage sans notion de phase
// ni d'estimation du temps restant. On ajoute :
//   • setPhases(phases) : déclare les phases du run (connexion, chargement,
//     évaluation, correction, rapport) et leur poids relatif.
//   • setPhase(name, currentInPhase, totalInPhase) : progresse dans une phase
//     précise — la barre globale reflète la somme pondérée des phases.
//   • ETA dynamique : calculé à partir de la vitesse constatée (tokens/s ou
//     items/s) et affiché sous la barre. Se base sur un taux glissant pour
//     rester stable malgré les variations de latence.
// La ProgressBar d'origine (label, total) reste utilisable sans phases pour
// rétro-compatibilité — setPhases est optionnel.

class ProgressBar {
  constructor(label, total) {
    this.label = label;
    this.total = total > 0 ? total : 1;
    this._phases = null;          // [{ name, weight, total }]
    this._phaseIndex = -1;
    this._phaseProgress = [];     // progression absolue par phase
    this._startMs = Date.now();
    this._lastUpdateMs = this._startMs;
    this._etaSamples = [];        // fenêtre glissante pour ETA stable
  }

  // Déclare les phases du run avec leur poids relatif (somme libre, normalisée).
  // Ex: setPhases([{name:'Connexion LM Studio', weight:1}, {name:'Chargement modèle', weight:2}, ...])
  setPhases(phases) {
    if (!Array.isArray(phases) || phases.length === 0) return this;
    this._phases = phases.map(p => ({
      name: p.name || '?',
      weight: Math.max(0.001, p.weight || 1),
      total: Math.max(1, p.total || 1)
    }));
    this._phaseProgress = this._phases.map(() => 0);
    this._phaseIndex = -1;
    return this;
  }

  // Active une phase et met à jour sa progression interne (0..total).
  // La barre globale reflète la somme pondérée de toutes les phases.
  setPhase(name, currentInPhase) {
    if (!this._phases) return this;
    const idx = this._phases.findIndex(p => p.name === name);
    if (idx === -1) return this;
    this._phaseIndex = idx;
    this._phaseProgress[idx] = Math.max(0, Math.min(this._phases[idx].total, currentInPhase || 0));
    return this;
  }

  // Calcule le pourcentage global pondéré à travers toutes les phases.
  _globalPct() {
    if (!this._phases) return null;
    let weightedDone = 0, weightedTotal = 0;
    for (let i = 0; i < this._phases.length; i++) {
      const p = this._phases[i];
      const done = i < this._phaseIndex ? p.total : (i === this._phaseIndex ? this._phaseProgress[i] : 0);
      weightedDone += done * p.weight;
      weightedTotal += p.total * p.weight;
    }
    return weightedTotal > 0 ? Math.min(100, Math.round((weightedDone / weightedTotal) * 100)) : 0;
  }

  // Calcule un ETA (s) à partir de la vitesse constatée depuis le démarrage.
  // Renvoie null si pas assez de données (< 5% ou < 2s écoulées).
  _computeEta(pct) {
    const elapsedMs = Date.now() - this._startMs;
    if (pct < 5 || elapsedMs < 2000) return null;
    // ETA = temps_total_estimé - temps_écoulé
    // temps_total_estimé = elapsedMs / (pct/100)
    const totalEstimateMs = elapsedMs / (pct / 100);
    const etaMs = Math.max(0, totalEstimateMs - elapsedMs);
    return Math.ceil(etaMs / 1000);
  }

  update(current, taskLabel) {
    // Mode phases : on ignore current/taskLabel (gérés par setPhase).
    if (this._phases) {
      const pct = this._globalPct();
      const filled = Math.round((pct / 100) * BAR_WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      const phaseName = this._phaseIndex >= 0 ? this._phases[this._phaseIndex].name : '';
      const eta = this._computeEta(pct);
      const etaStr = eta != null ? ` — ETA ~${eta}s` : '';
      const line = `  \x1b[36m${this.label}\x1b[0m [${bar}] ${String(pct).padStart(3)}% \x1b[90m${phaseName}${etaStr}\x1b[0m`;
      process.stdout.write(`\r${line}`.padEnd(120));
      return;
    }
    // Mode simple (rétro-compat)
    const pct = Math.max(0, Math.min(100, Math.round((current / this.total) * 100)));
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const elapsedMs = Date.now() - this._startMs;
    const eta = this._computeEta(pct);
    const etaStr = eta != null ? ` \x1b[90mETA ~${eta}s\x1b[0m` : '';
    const suffix = taskLabel ? ` ${taskLabel}` : '';
    const line = `  \x1b[36m${this.label}\x1b[0m [${bar}] ${String(pct).padStart(3)}%${suffix}${etaStr}`;
    process.stdout.write(`\r${line}`.padEnd(120));
  }

  complete() {
    const bar = '█'.repeat(BAR_WIDTH);
    const elapsedMs = Date.now() - this._startMs;
    logger.info('ProgressBar[' + this.label + ']: complétée en ' + (elapsedMs / 1000).toFixed(1) + 's');
    process.stdout.write(`\r  \x1b[36m${this.label}\x1b[0m [${bar}] 100% — Terminé`.padEnd(120) + '\n');
  }
}

class Spinner {
  constructor(label) {
    this.label = label;
    this.frameIndex = 0;
    this.interval = null;
    this.tokenCount = 0;
    this.charCount = 0;
    this._modelName = null;

    // Streaming live du raisonnement (cf. logs LM Studio)
    this._streamingActive = false;
    this._streamStartTime = null;
    this._streamingKind = null;       // 'reasoning' | 'content'
    this._lastStatsTime = 0;          // dernier affichage des stats (throttle)
    this._reasoningTokensWindow = []; // fenêtre glissante 3s pour tg_3s

    // Messages pédagogiques rotatifs (temps morts). Affichés sous le label fixe,
    // ils tournent toutes les ~5-10s pour tenir l'utilisateur en haleine et donner
    // un sentiment de progression. PAS d'humour (décision spinner_no_humor).
    this._waitingMessages = null;    // tableau de phrases ou null (désactivé)
    this._messageIndex = 0;
    this._messageRotationMs = 7000;  // ~7s entre deux phrases (entre 5 et 10s)
    this._lastMessageTime = 0;
  }

  // Active/désactive la rotation de messages pédagogiques pendant l'attente.
  // Passez un tableau de phrases (non vide) pour activer, null/[] pour stopper.
  setWaitingMessages(messages) {
    if (Array.isArray(messages) && messages.length > 0) {
      this._waitingMessages = messages;
      this._messageIndex = 0;
      this._lastMessageTime = Date.now();
    } else {
      this._waitingMessages = null;
    }
    return this;
  }

  // Renvoie la phrase pédagogique courante (ou '' si aucune). Fait tourner
  // l'index toutes les ~7s pour donner un sentiment d'activité à l'utilisateur
  // pendant les temps morts longs (auto-profilage, chargement des exercices).
  _currentWaitingMessage() {
    if (!this._waitingMessages || this._waitingMessages.length === 0) return '';
    const now = Date.now();
    if (now - this._lastMessageTime >= this._messageRotationMs) {
      this._messageIndex = (this._messageIndex + 1) % this._waitingMessages.length;
      this._lastMessageTime = now;
    }
    return this._waitingMessages[this._messageIndex] || '';
  }

  start() {
    this._lastMessageTime = Date.now();
    this.interval = setInterval(() => {
      // Pendant le streaming, le spinner est arrêté — on n'affiche rien ici.
      if (this._streamingActive) return;
      const frame = SPINNER_CHARS[this.frameIndex % SPINNER_CHARS.length];
      this.frameIndex++;
      const status = this.tokenCount > 0
        ? `${this.label}... (${this.tokenCount} tokens, ${this.charCount} chars)`
        : `${this.label}...`;
      const msg = this._currentWaitingMessage();
      const line = msg
        ? `  \x1b[35m${frame}\x1b[0m ${status}\n  \x1b[90m${msg}\x1b[0m`
        : `  \x1b[35m${frame}\x1b[0m ${status}`;
      // Efface 2 lignes (label + message) avant de réécrire pour un rendu propre.
      if (msg) process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K\r');
      else process.stdout.write('\r\x1b[K\r');
      process.stdout.write(line.padEnd(120));
    }, 100);
  }

  updateTokens(tokenCount, charCount) {
    this.tokenCount = tokenCount;
    this.charCount = charCount;
  }

  // Active le mode streaming : arrête le spinner et prépare l'affichage en flux.
  beginStreaming() {
    this._streamingActive = true;
    this._streamStartTime = Date.now();
    this._lastStatsTime = 0;
    this._reasoningTokensWindow = [];
    this._waitingMessages = null;  // stoppe la rotation pendant le streaming
    // Arrête le spinner pour libérer la console
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    // Efface la ligne du spinner (et la ligne de message s'il y en avait une)
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K\r');
  }

  // Affiche un fragment du raisonnement/réponse directement dans la console,
  // sans manipulation de curseur (compatible PowerShell 5.1). Le texte s'écrit
  // au fur et à mesure, comme les logs LM Studio.
  // kind: 'reasoning' (pensée) | 'content' (réponse finale) | null
  appendStreamChunk(text, kind = null) {
    if (!text) return;

    // Si on change de type (reasoning -> content), on ajoute un séparateur
    if (this._streamingKind && this._streamingKind !== kind) {
      process.stdout.write('\n');
    }
    this._streamingKind = kind;

    const kindTag = kind === 'reasoning' ? '💭 ' : (kind === 'content' ? '✍ ' : '');

    // Affiche les stats périodiquement (throttle ~2s), façon LM Studio
    const now = Date.now();
    if (now - this._lastStatsTime > 2000 || this._lastStatsTime === 0) {
      this._lastStatsTime = now;
      const elapsed = (now - this._streamStartTime) / 1000;
      const tps = elapsed > 0 ? (this.tokenCount / elapsed).toFixed(2) : '0.00';

      // Fenêtre glissante 3s pour tg_3s
      this._reasoningTokensWindow.push({ t: now, count: this.tokenCount });
      this._reasoningTokensWindow = this._reasoningTokensWindow.filter(e => now - e.t <= 3000);
      let tps3s = '0.00';
      if (this._reasoningTokensWindow.length >= 2) {
        const first = this._reasoningTokensWindow[0];
        const last = this._reasoningTokensWindow[this._reasoningTokensWindow.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt > 0) tps3s = ((last.count - first.count) / dt).toFixed(2);
      }

      process.stdout.write(`\x1b[90m  ${kindTag}n_decoded = ${this.tokenCount}, tg = ${tps} t/s, tg_3s = ${tps3s} t/s\x1b[0m\n`);
    }

    // Écrit le fragment de texte directement (append, pas de cursor trick)
    process.stdout.write(text);
  }

  // Termine le streaming : ferme la ligne en cours.
  endStreaming() {
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
  }

  stop(finalLabel) {
    const hadMessage = Boolean(this._waitingMessages);
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
    // Efface proprement les 2 lignes (spinner + message) avant le résultat final.
    process.stdout.write('\r\x1b[K');
    if (hadMessage) process.stdout.write('\x1b[1A\r\x1b[K');
    this._waitingMessages = null;
    process.stdout.write(`\r  \x1b[32m✔\x1b[0m ${finalLabel || this.label} (${this.tokenCount} tokens)`.padEnd(120) + '\n');
  }

  fail(finalLabel) {
    const hadMessage = Boolean(this._waitingMessages);
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
    process.stdout.write('\r\x1b[K');
    if (hadMessage) process.stdout.write('\x1b[1A\r\x1b[K');
    this._waitingMessages = null;
    process.stdout.write(`\r  \x1b[31m✘\x1b[0m ${finalLabel || this.label}`.padEnd(120) + '\n');
  }
}

function letterGrade(pct) {
  if (pct >= 90) return { grade: 'A', color: '\x1b[42m\x1b[30m' };
  if (pct >= 80) return { grade: 'B', color: '\x1b[46m\x1b[30m' };
  if (pct >= 70) return { grade: 'C', color: '\x1b[43m\x1b[30m' };
  if (pct >= 60) return { grade: 'D', color: '\x1b[45m\x1b[37m' };
  return { grade: 'F', color: '\x1b[41m\x1b[37m' };
}

// ============================================================
// BigSpinner — spinner large et visible pour les temps d'attente
// longs (raisonnement du modèle sur Tiers 0-2). Affiche :
//   • Un gros caractère de spinner (2x plus gros)
//   • Le temps écoulé en secondes
//   • Des messages pédagogiques qui tournent toutes les ~7s
//   • Une barre de progression temporelle (points qui s'ajoutent)
//   • Le nombre de tokens produits (quand disponible)
// ============================================================
const BIG_SPINNER_CHARS = ['◐', '◓', '◑', '◒'];

class BigSpinner {
  constructor(label) {
    this.label = label;
    this.frameIndex = 0;
    this.interval = null;
    this.tokenCount = 0;
    this.charCount = 0;
    this._startTime = null;
    this._modelName = null;

    // Messages pédagogiques rotatifs
    this._waitingMessages = null;
    this._messageIndex = 0;
    this._messageRotationMs = 7000;
    this._lastMessageTime = 0;

    // Streaming
    this._streamingActive = false;
    this._streamStartTime = null;
    this._streamingKind = null;
    this._lastStatsTime = 0;
    this._reasoningTokensWindow = [];
  }

  setWaitingMessages(messages) {
    if (Array.isArray(messages) && messages.length > 0) {
      this._waitingMessages = messages;
      this._messageIndex = 0;
      this._lastMessageTime = Date.now();
    } else {
      this._waitingMessages = null;
    }
    return this;
  }

  _currentWaitingMessage() {
    if (!this._waitingMessages || this._waitingMessages.length === 0) return '';
    const now = Date.now();
    if (now - this._lastMessageTime >= this._messageRotationMs) {
      this._messageIndex = (this._messageIndex + 1) % this._waitingMessages.length;
      this._lastMessageTime = now;
    }
    return this._waitingMessages[this._messageIndex] || '';
  }

  // Barre de progression temporelle : plus le temps passe, plus on ajoute
  // de points. 1 point toutes les 5s, max 20 points.
  _timeDots() {
    if (!this._startTime) return '';
    const elapsedSec = Math.floor((Date.now() - this._startTime) / 1000);
    const dotCount = Math.min(20, Math.floor(elapsedSec / 5));
    const fullDots = '●'.repeat(dotCount);
    const emptyDots = '○'.repeat(20 - dotCount);
    return `[${fullDots}${emptyDots}]`;
  }

  _elapsedStr() {
    if (!this._startTime) return '0s';
    const sec = Math.floor((Date.now() - this._startTime) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }

  start() {
    this._startTime = Date.now();
    this._lastMessageTime = Date.now();
    this.interval = setInterval(() => {
      if (this._streamingActive) return;
      this.frameIndex++;
      const bigFrame = BIG_SPINNER_CHARS[this.frameIndex % BIG_SPINNER_CHARS.length];
      const elapsed = this._elapsedStr();
      const dots = this._timeDots();
      const status = this.tokenCount > 0
        ? `${this.label} (${this.tokenCount} tokens)`
        : this.label;
      const msg = this._currentWaitingMessage();
      const dotLine = `  \x1b[36m${dots}\x1b[0m`;
      const elapsedLine = `  \x1b[90mTemps ecoule : ${elapsed}\x1b[0m`;
      // Ligne 1 : gros spinner + label
      const line1 = `  \x1b[35;1m${bigFrame}\x1b[0m \x1b[1m${status}\x1b[0m`;
      // Ligne 2 : barre de progression temporelle
      const line2 = dotLine;
      // Ligne 3 : temps écoulé
      const line3 = elapsedLine;
      // Ligne 4 : message pédagogique (si présent)
      const line4 = msg ? `  \x1b[33m${msg}\x1b[0m` : '';

      // Efface 4 lignes (3 écrites + 1 ligne vide après le dernier \n)
      // puis 1 ligne supplémentaire si le message pédagogique est présent
      process.stdout.write('\r\x1b[K');
      process.stdout.write('\x1b[1A\r\x1b[K');
      process.stdout.write('\x1b[1A\r\x1b[K');
      process.stdout.write('\x1b[1A\r\x1b[K');
      if (line4) process.stdout.write('\x1b[1A\r\x1b[K');

      process.stdout.write(line1.padEnd(120) + '\n');
      process.stdout.write(line2.padEnd(120) + '\n');
      process.stdout.write(line3.padEnd(120) + '\n');
      if (line4) process.stdout.write(line4.padEnd(120) + '\n');
    }, 200);
  }

  updateTokens(tokenCount, charCount) {
    this.tokenCount = tokenCount;
    this.charCount = charCount;
  }

  beginStreaming() {
    this._streamingActive = true;
    this._streamStartTime = Date.now();
    this._lastStatsTime = 0;
    this._reasoningTokensWindow = [];
    this._waitingMessages = null;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    // Efface les 4 lignes du BigSpinner
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K');
  }

  appendStreamChunk(text, kind) {
    if (!text) return;
    if (this._streamingKind && this._streamingKind !== kind) {
      process.stdout.write('\n');
    }
    this._streamingKind = kind;
    const kindTag = kind === 'reasoning' ? '💭 ' : (kind === 'content' ? '✍ ' : '');
    const now = Date.now();
    if (now - this._lastStatsTime > 2000 || this._lastStatsTime === 0) {
      this._lastStatsTime = now;
      const elapsed = (now - this._streamStartTime) / 1000;
      const tps = elapsed > 0 ? (this.tokenCount / elapsed).toFixed(2) : '0.00';
      this._reasoningTokensWindow.push({ t: now, count: this.tokenCount });
      this._reasoningTokensWindow = this._reasoningTokensWindow.filter(e => now - e.t <= 3000);
      let tps3s = '0.00';
      if (this._reasoningTokensWindow.length >= 2) {
        const first = this._reasoningTokensWindow[0];
        const last = this._reasoningTokensWindow[this._reasoningTokensWindow.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt > 0) tps3s = ((last.count - first.count) / dt).toFixed(2);
      }
      process.stdout.write(`\x1b[90m  ${kindTag}n_decoded = ${this.tokenCount}, tg = ${tps} t/s, tg_3s = ${tps3s} t/s\x1b[0m\n`);
    }
    process.stdout.write(text);
  }

  endStreaming() {
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
  }

  stop(finalLabel) {
    const hadMessage = Boolean(this._waitingMessages);
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
    // Efface 4 lignes (toujours écrites) + 1 si message présent
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K');
    if (hadMessage) process.stdout.write('\x1b[1A\r\x1b[K');
    this._waitingMessages = null;
    const elapsed = this._startTime ? ` (${this._elapsedStr()})` : '';
    process.stdout.write(`\r  \x1b[32m✔\x1b[0m ${finalLabel || this.label}${elapsed} (${this.tokenCount} tokens)`.padEnd(120) + '\n');
  }

  fail(finalLabel) {
    const hadMessage = Boolean(this._waitingMessages);
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
      this._streamingKind = null;
    }
    // Efface 4 lignes (toujours écrites) + 1 si message présent
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K');
    if (hadMessage) process.stdout.write('\x1b[1A\r\x1b[K');
    this._waitingMessages = null;
    process.stdout.write(`\r  \x1b[31m✘\x1b[0m ${finalLabel || this.label}`.padEnd(120) + '\n');
  }
}

module.exports = { ProgressBar, Spinner, BigSpinner, letterGrade };