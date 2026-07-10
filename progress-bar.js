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
  }

  start() {
    this.interval = setInterval(() => {
      const frame = SPINNER_CHARS[this.frameIndex % SPINNER_CHARS.length];
      this.frameIndex++;
      const status = this.tokenCount > 0
        ? `${this.label}... (${this.tokenCount} tokens, ${this.charCount} chars)`
        : this.currentWaitingMessage;
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

  stop(finalLabel) {
    if (this.interval) clearInterval(this.interval);
    if (this.messageInterval) clearInterval(this.messageInterval);
    process.stdout.write(`\r  \x1b[32m✔\x1b[0m ${finalLabel || this.label} (${this.tokenCount} tokens)`.padEnd(120) + '\n');
  }

  fail(finalLabel) {
    if (this.interval) clearInterval(this.interval);
    if (this.messageInterval) clearInterval(this.messageInterval);
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
