// JSON-lines console logger (12-factor: one event per line on stdout).
// Call style follows AppModule: logger.info('msg'), logger.info({field: 1}, 'msg').

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export class Logger {
  /** @param {{level?: string, name?: string, out?: NodeJS.WritableStream}} [options] */
  constructor({ level = 'info', name = 'jet-app', out = process.stdout } = {}) {
    this.threshold = LEVELS[level] ?? LEVELS.info;
    this.name = name;
    this.out = out;
  }

  setLevel(level) { this.threshold = LEVELS[level] ?? this.threshold; }

  /** @returns {Logger} a child logger that tags every line with `name` */
  child(name) { return Object.assign(new Logger({ out: this.out }), { threshold: this.threshold, name }); }

  _emit(level, args) {
    if (LEVELS[level] < this.threshold) return;
    const fields = typeof args[0] === 'object' && args[0] !== null ? args.shift() : {};
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (fields.error instanceof Error) fields.error = { message: fields.error.message, stack: fields.error.stack };
    this.out.write(JSON.stringify({ t: new Date().toISOString(), level, name: this.name, msg, ...fields }) + '\n');
  }

  debug(...args) { this._emit('debug', args); }
  info(...args) { this._emit('info', args); }
  log(...args) { this._emit('info', args); }
  warn(...args) { this._emit('warn', args); }
  error(...args) { this._emit('error', args); }
  fatal(...args) { this._emit('fatal', args); }
}
