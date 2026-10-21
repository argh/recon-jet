// display: a Grid that is pushed to jetd by diffing against what jetd last showed.
// Geometry follows the hello; `active` gates drawing (jetd ignores draws outside remote mode,
// so the ui keeps this false while another jetd mode is showing and forces a redraw after).
import { Schema } from '@versionzero/module-manager';
import { Grid } from './grid.js';

const s = Schema.create;
const BLACK = [0, 0, 0];

export class Display {
  static moduleInfo = {
    name: 'display',
    schema: s()
      .property('cols', s('number').default(42).meta('description', 'columns before the first hello'))
      .property('rows', s('number').default(12).meta('description', 'rows before the first hello'))
      .property('minFlushMs', s('number').default(50).meta('description', 'minimum interval between flushes'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  cols; rows; minFlushMs; deviceLink; logger;

  /** @type {Grid} what the app wants on the glass */ grid;
  #shown = null;          // Grid jetd currently shows, null = unknown (full redraw needed)
  #geometry = null;       // { w, h, cols, rows } from hello
  #lastFlush = 0; #timer = null;
  active = false;

  async start() {
    this.grid = new Grid(this.cols, this.rows);
    this.deviceLink.on('hello', (h) => this.#onHello(h));
    this.deviceLink.on('disconnected', () => { this.#shown = null; });
  }
  async stop() { clearTimeout(this.#timer); }

  #onHello(h) {
    this.#geometry = h;
    if (h.cols !== this.grid.cols || h.rows !== this.grid.rowCount) {
      this.grid.resize(h.cols, h.rows);
      this.logger?.info({ cols: h.cols, rows: h.rows }, 'display resized');
    }
    this.#shown = null;     // jetd cleared its buffer; everything must be resent
  }

  /** Mark everything as needing a resend (e.g. remote mode came back). */
  invalidate() { this.#shown = null; }

  /** Push changed rows to jetd (rate-limited). Returns true when something was sent. */
  flush() {
    if (!this.active || !this.deviceLink.connected) return false;
    const wait = this.minFlushMs - (Date.now() - this.#lastFlush);
    if (wait > 0) { clearTimeout(this.#timer); this.#timer = setTimeout(() => this.flush(), wait); return false; }
    const changed = this.grid.diff(this.#shown);
    if (!changed.length) return false;
    const lines = [];
    const full = !this.#shown || changed.length > this.grid.rowCount / 2;
    const rowH = this.#geometry ? Math.floor(this.#geometry.h / this.#geometry.rows) : 20;
    const width = this.#geometry?.w ?? 428;
    if (full) lines.push('C');
    let colour = null;
    for (const i of full ? this.grid.rows.map((_, i) => i) : changed) {
      const row = this.grid.rows[i];
      if (!full) lines.push(`B 0 ${i * rowH} ${width} ${rowH} ${BLACK.join(' ')}`);
      if (!row.text) continue;
      const c = row.colour.join(' ');
      if (c !== colour) { lines.push(`R ${c}`); colour = c; }
      lines.push(`${row.centre ? 'A' : 'T'} ${i} ${row.text}`);
    }
    lines.push('F');
    this.deviceLink.send(...lines);
    this.#shown = this.grid.clone();
    this.#lastFlush = Date.now();
    this.logger?.debug({ rows: full ? 'all' : changed, lines: lines.length }, 'flush');
    return true;
  }
}
