const { SPINNER_CHARS, WAITING_MESSAGES } = require('./config');

const BAR_WIDTH = 30;
const WAITING_MESSAGE_INTERVAL_MS = 2500;

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
    this.messageIndex = Math.floor(Math.random() * WAITING_MESSAGES.length);
    this.currentWaitingMessage = WAITING_MESSAGES[this.messageIndex];
    this.messageInterval = null;

    // Suivi du raisonnement/streaming en live (cf. logs LM Studio)
    this._streamingActive = false;
    this._streamStartTime = null;
    this._lastReasoningChunkTime = null;
    this._reasoningTokensWindow = []; // {t, count} pour calcul t/s sur 3s glissantes
    this._lastDisplayLen = 0;
    this._reasoningLineActive = false;
  }

  start() {
    this.interval = setInterval(() => {
      const frame = SPINNER_CHARS[this.frameIndex % SPINNER_CHARS.length];
      this.frameIndex++;

      let status;
      if (this._streamingActive && this.tokenCount > 0) {
        const elapsed = (Date.now() - this._streamStartTime) / 1000;
        const tps = elapsed > 0 ? (this.tokenCount / elapsed).toFixed(2) : '0.00';
        status = `${this.label}... (n_decoded=${this.tokenCount}, tg=${tps} t/s)`;
      } else if (this.tokenCount > 0) {
        status = `${this.label}... (${this.tokenCount} tokens, ${this.charCount} chars)`;
      } else {
        status = this.currentWaitingMessage;
      }
      const line = `  \x1b[35m${frame}\x1b[0m ${status}`;
      process.stdout.write(`\r${line}`.padEnd(120));
    }, 100);

    this.messageInterval = setInterval(() => {
      if (this.tokenCount === 0) {
        this.messageIndex = (this.messageIndex + 1) % WAITING_MESSAGES.length;
        this.currentWaitingMessage = WAITING_MESSAGES[this.messageIndex];
      }
    }, WAITING_MESSAGE_INTERVAL_MS);
  }

  updateTokens(tokenCount, charCount) {
    this.tokenCount = tokenCount;
    this.charCount = charCount;
  }

  // Active le mode streaming live : affiche le raisonnement du modèle au fur
  // et à mesure de sa génération (comme les logs LM Studio), avec le nombre de
  // tokens décodés et le débit en t/s. À appeler une fois au début du stream.
  beginStreaming() {
    this._streamingActive = true;
    this._streamStartTime = Date.now();
    this._lastReasoningChunkTime = Date.now();
    this._reasoningTokensWindow = [];
  }

  // Affiche un fragment de raisonnement en live (streaming) sur une ligne
  // rafraîchie, façon log LM Studio. À appeler pour chaque chunk reçu.
  // kind: 'reasoning' (pensée) | 'content' (réponse finale) | null
  appendStreamChunk(text, kind = null) {
    if (!text) return;
    // Nouvelle ligne de raisonnement : on saute une ligne après le spinner
    if (!this._reasoningLineActive) {
      // Arrête le spinner spinner temporairement pour libérer la ligne
      if (this.interval) { clearInterval(this.interval); this.interval = null; }
      if (this.messageInterval) { clearInterval(this.messageInterval); this.messageInterval = null; }
      process.stdout.write('\n');
      this._reasoningLineActive = true;
      this._lastDisplayLen = 0;
    }

    const now = Date.now();
    const elapsed = (now - this._streamStartTime) / 1000;
    const tps = elapsed > 0 ? (this.tokenCount / elapsed).toFixed(2) : '0.00';

    // Fenêtre glissante 3s pour t/s (style log LM Studio : tg_3s)
    this._reasoningTokensWindow.push({ t: now, count: this.tokenCount });
    this._reasoningTokensWindow = this._reasoningTokensWindow.filter(e => now - e.t <= 3000);
    let tps3s = '0.00';
    if (this._reasoningTokensWindow.length >= 2) {
      const first = this._reasoningTokensWindow[0];
      const last = this._reasoningTokensWindow[this._reasoningTokensWindow.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) tps3s = ((last.count - first.count) / dt).toFixed(2);
    }

    // Tronque le texte affiché pour éviter les lignes trop longues (terminaux ~120 colonnes)
    const kindTag = kind === 'reasoning' ? '💭' : (kind === 'content' ? '✍' : '›');
    const header = `  \x1b[90m${kindTag} n_decoded=${this.tokenCount}, tg=${tps} t/s, tg_3s=${tps3s} t/s\x1b[0m`;
    // On ne réaffiche que les ~80 derniers caractères du flux courant
    const snippet = text.length > 80 ? '…' + text.slice(-80) : text;
    const display = `${header}\n  \x1b[37m${snippet}\x1b[0m`;

    // Efface la zone d'affichage précédente (2 lignes) puis réécrit
    if (this._lastDisplayLen > 0) {
      process.stdout.write(`\x1b[2A\r${' '.repeat(120)}\n${' '.repeat(120)}\n\x1b[2A\r`);
    }
    process.stdout.write(`\r${display}\n`);
    this._lastDisplayLen = display.length;
  }

  // Termine l'affichage streaming et relance le spinner (si besoin)
  endStreaming() {
    if (this._reasoningLineActive) {
      // Laisse une ligne vierge pour séparer le raisonnement de la suite
      process.stdout.write('\n');
      this._reasoningLineActive = false;
      this._lastDisplayLen = 0;
    }
    this._streamingActive = false;
    // Relance le spinner si stop() n'a pas encore été appelé
    if (!this.interval) {
      this.start();
    }
  }

  stop(finalLabel) {
    if (this.interval) clearInterval(this.interval);
    if (this.messageInterval) clearInterval(this.messageInterval);
    if (this._reasoningLineActive) {
      process.stdout.write('\n');
      this._reasoningLineActive = false;
    }
    this._streamingActive = false;
    process.stdout.write(`\r  \x1b[32m✔\x1b[0m ${finalLabel || this.label} (${this.tokenCount} tokens)`.padEnd(120) + '\n');
  }

  fail(finalLabel) {
    if (this.interval) clearInterval(this.interval);
    if (this.messageInterval) clearInterval(this.messageInterval);
    if (this._reasoningLineActive) {
      process.stdout.write('\n');
      this._reasoningLineActive = false;
    }
    this._streamingActive = false;
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
