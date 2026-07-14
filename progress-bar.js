const { SPINNER_CHARS } = require('./config');

const BAR_WIDTH = 30;

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
  }

  start() {
    this.interval = setInterval(() => {
      // Pendant le streaming, le spinner est arrêté — on n'affiche rien ici.
      if (this._streamingActive) return;
      const frame = SPINNER_CHARS[this.frameIndex % SPINNER_CHARS.length];
      this.frameIndex++;
      const status = this.tokenCount > 0
        ? `${this.label}... (${this.tokenCount} tokens, ${this.charCount} chars)`
        : `${this.label}...`;
      const line = `  \x1b[35m${frame}\x1b[0m ${status}`;
      process.stdout.write(`\r${line}`.padEnd(120));
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
    // Arrête le spinner pour libérer la console
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    // Efface la ligne du spinner
    process.stdout.write(`\r${' '.repeat(120)}\r`);
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
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
    }
    process.stdout.write(`\r  \x1b[32m✔\x1b[0m ${finalLabel || this.label} (${this.tokenCount} tokens)`.padEnd(120) + '\n');
  }

  fail(finalLabel) {
    if (this.interval) clearInterval(this.interval);
    if (this._streamingActive) {
      process.stdout.write('\n');
      this._streamingActive = false;
    }
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