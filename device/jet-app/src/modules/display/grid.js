// Character-grid surface: `rows` rows of text, each with its own colour and alignment.
// jetd draws whole rows (`T`/`A`), so a row is the unit of change.

const WHITE = [255, 255, 255];

/** @typedef {{text: string, colour: number[], centre: boolean}} Row */

export class Grid {
  constructor(cols, rows) { this.resize(cols, rows); }

  resize(cols, rows) {
    this.cols = cols; this.rowCount = rows;
    /** @type {Row[]} */
    this.rows = Array.from({ length: rows }, () => Grid.emptyRow());
  }

  static emptyRow() { return { text: '', colour: WHITE, centre: false }; }

  clear() { this.rows = this.rows.map(() => Grid.emptyRow()); return this; }

  /** @param {number} row @param {string} text @param {{colour?: number[], centre?: boolean}} [opts] */
  set(row, text, { colour = WHITE, centre = false } = {}) {
    if (row < 0 || row >= this.rowCount) return this;
    this.rows[row] = { text: String(text).slice(0, this.cols), colour, centre };
    return this;
  }

  /** @returns {Grid} independent copy */
  clone() { const g = new Grid(this.cols, this.rowCount); g.rows = this.rows.map((r) => ({ ...r })); return g; }

  static rowEquals(a, b) {
    return a.text === b.text && a.centre === b.centre && a.colour[0] === b.colour[0] && a.colour[1] === b.colour[1] && a.colour[2] === b.colour[2];
  }

  /** Row indexes that differ from `other` (all rows if geometry differs). */
  diff(other) {
    if (!other || other.cols !== this.cols || other.rowCount !== this.rowCount) return this.rows.map((_, i) => i);
    return this.rows.map((r, i) => (Grid.rowEquals(r, other.rows[i]) ? -1 : i)).filter((i) => i >= 0);
  }
}
