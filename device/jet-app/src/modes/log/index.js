// Log mode: the kernel log as jetd streams it (`j` lines), small font, newest at the bottom.
// On connect (and whenever this mode is entered) the whole ring is requested with `J`, so the
// view continues from jetd's own boot log without a gap; live lines keep arriving whether or
// not the mode is showing. Swipe up/down scroll by a page, swipe left/right pan by 10 columns,
// rear press returns to following the tail (and does nothing when already following).
// This is also what the panel shows until the start mode is entered.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, STRIP_H, hint } from '../../modules/ui/style.js';
import { LogBuffer } from './buffer.js';

const s = Schema.create;
const PAN = 10;

export class LogMode {
  static moduleInfo = {
    name: 'log-mode',
    schema: s()
      .property('lines', s('number').default(2000).meta('description', 'scrollback kept'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  lines; modes; ui; deviceLink; logger;

  id = 'log'; label = 'Log';
  /** @type {LogBuffer} */ buffer;
  #current = false;
  #loading = false;

  async start() {
    this.buffer = new LogBuffer({ max: this.lines });
    this.modes.register(this);
    this.deviceLink.on('connected', () => this.#reload());
    this.deviceLink.on('log', (line) => { this.buffer.push(line); if (this.#current && !this.#loading) this.ui.requestRender(); });
    if (this.deviceLink.connected) this.#reload();
  }

  enter() { this.#current = true; this.buffer.follow(); if (!this.#loading) this.#reload(); }
  leave() { this.#current = false; }

  /** Ask jetd for its whole ring; the lines that follow replace the buffer when `J n` lands. */
  #reload() {
    if (!this.deviceLink.connected || this.#loading) return;
    this.#loading = true;
    this.buffer.beginBacklog();
    this.deviceLink.logBacklog().then(
      (n) => { this.buffer.endBacklog(n); this.logger?.info({ lines: n }, 'log backlog'); },
      (error) => { this.buffer.endBacklog(Infinity); this.logger?.warn({ error: error.message }, 'log backlog failed'); })
      .finally(() => { this.#loading = false; this.ui.requestRender(); });
  }

  /** Rows and columns of the small-font grid under the strip (one row kept for the hint). */
  #grid(s) { const { small } = s.fonts; return { rows: Math.floor((s.height - STRIP_H - small.height) / small.height), cols: Math.floor((s.width - 2 * MARGIN) / small.width) }; }

  onGesture(g) {
    const { rows } = this.#grid(this.ui.surface);
    switch (g) {
      case 'swipe:up': this.buffer.scroll(rows - 1, rows); break;
      case 'swipe:down': this.buffer.scroll(-(rows - 1), rows); break;
      case 'swipe:left': this.buffer.pan(-PAN); break;
      case 'swipe:right': this.buffer.pan(PAN); break;
      case 'press:rear': if (this.buffer.following && this.buffer.hoff === 0) return false; this.buffer.follow(); break;
      default: return false;
    }
    this.ui.requestRender();
    return true;
  }

  render(s) {
    const { small } = s.fonts, { rows, cols } = this.#grid(s), b = this.buffer;
    b.visible(rows, cols).forEach((line, i) => s.text(MARGIN, STRIP_H + i * small.height, line, { font: small, colour: C.white }));
    const scrolled = !b.following || b.hoff > 0;
    hint(s, scrolled ? `^${b.offset} >${b.hoff}   rear: follow` : `${b.length} lines${this.#loading ? '  loading' : ''}   swipe: scroll / pan`, scrolled ? C.title : C.dim);
  }
}
