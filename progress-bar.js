const { SPINNER_CHARS } = require('./config');

const BAR_WIDTH = 30;

// Intervalle de rotation des messages pédagogiques (ms). Le label fixe reste
// affiché (⠋ <label>...), et une phrase pédagogique change sous lui toutes les
// ~5s pour tenir l'utilisateur en haleine pendant les temps morts longs.
const MESSAGE_ROTATION_MS = 5000;

class ProgressBar {
  constructor(label, total) {
    this.label = label;
    this.total = total > 0 ? total : 1;
  }

  update(current, taskLabel) {
    const pct = Math.max(0, Math.min(100, Math.round((current / this.total) * 100)));
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const suffix = taskLabel ? ` ${taskLabel}` : '';
    const line = `  \x1b[36m${this.label}\x1b[0m [${bar}] ${String(pct).padStart(3)}%${suffix}`;
    process.stdout.write(`\r${line}`.padEnd(120));
  }

  complete() {
    const bar = '█'.repeat(BAR_WIDTH);
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

module.exports = { ProgressBar, Spinner, letterGrade };