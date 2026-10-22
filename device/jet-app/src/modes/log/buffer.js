// LogBuffer: a ring of text lines with a scrollback position and a horizontal offset, newest at
// the bottom. `offset` is how many lines the view is scrolled up from the bottom (0 = follow);
// `hoff` is the first visible column. Pure: no fonts, no device.
//
// Backlog: jetd sends the last 60 lines by itself on connect and the whole ring on `J` (ended by
// `J n`). `beginBacklog()` starts collecting, `endBacklog(n)` keeps only the last n lines
// collected since, so the 60 automatic lines (also part of the ring) are not shown twice.

export class LogBuffer {
  /** @param {{max?: number}} [options] lines kept */
  constructor({ max = 2000 } = {}) {
    this.max = max;
    /** @type {string[]} */ this.lines = [];
    this.offset = 0; this.hoff = 0;
    this.#backlog = null;
  }
  #backlog;

  get length() { return this.lines.length; }
  get following() { return this.offset === 0; }

  push(line) {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    if (this.#backlog) this.#backlog.push(line);
    else if (this.offset > 0) this.offset = Math.min(this.offset + 1, Math.max(0, this.lines.length - 1));   // keep the view still while scrolled
  }

  clear() { this.lines = []; this.offset = 0; this.#backlog = null; }

  /** Lines pushed from now on are a backlog replay (see above). */
  beginBacklog() { this.#backlog = []; }
  /** The replay is complete: the last `n` replayed lines become the whole buffer (a scrolled view stays where it is). */
  endBacklog(n) {
    const got = this.#backlog ?? [];
    this.#backlog = null;
    this.lines = got.slice(Math.max(0, got.length - n)).slice(-this.max);
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - 1));
  }

  /** Scroll by `d` lines (positive = older); clamps to the buffer. */
  scroll(d, rows) {
    this.offset = Math.max(0, Math.min(this.offset + d, Math.max(0, this.lines.length - rows)));
  }
  /** Pan by `d` columns (positive = right); never left of column 0. */
  pan(d) { this.hoff = Math.max(0, this.hoff + d); }
  /** Back to the newest line, column 0. */
  follow() { this.offset = 0; this.hoff = 0; }

  /** The `rows` visible lines (bottom-aligned when the buffer is short), cut to `cols` from `hoff`. */
  visible(rows, cols) {
    const end = this.lines.length - this.offset, start = Math.max(0, end - rows);
    return this.lines.slice(start, end).map((l) => l.slice(this.hoff, this.hoff + cols));
  }
}
