// Cards: the list of tiles and the opened card, the drawing the Scan and Assistant modes share
// (docs/agent.md), next to the Chooser as the second list box of the house grammar.
//
// `CardList` lays full-width tiles out in a rectangle: thumbnail on the left when there is one,
// the title in the big font, a few small-font lines under it, a badge at the right of the top
// row. The selected tile is the Chooser's selected row at tile size: a filled green bar with
// black text. A tile is as tall as what it holds (a one-line remark is one line, a titled card
// with two lines or a thumbnail is 48 px: four of those fill the panel between the strip and
// the hint), and only whole tiles are drawn. It is a view helper: the cards are handed in
// (`set`), the only state here is which one is selected and where the window sits.
//
// Selection and the scroll window are list.js (shared with the chat bubbles): a list *follows*
// its anchored edge until the wearer moves. Text is wrapped here, and only for the tiles the
// window touches: a hundred cards cost what eight do.
//
// `DetailView` is the opened card: the title, the picture (fitted into 160x120, or with `fill`
// as tall as the view: an opened photo is there to be looked at) with the text flowing beside
// and then under it, scrolled a page at a time.
import { C, wrapWords } from './style.js';
import { ListWindow, fit, scrollBar } from './list.js';

const PAD = 2;                    // inside a tile, every side
const GAP = 2;                    // between tiles
const THUMB = { w: 58, h: 44 };   // the thumbnail box in a tile (4:3; with PAD the 48 px of a full tile)
const BAR = 4;                    // the right edge kept free for the scroll bar
const IMAGE = { w: 160, h: 120 }; // the picture box in a detail view

/**
 * @typedef {{width: number, height: number, data: Uint8Array}} Image
 * @typedef {object} Card
 * @property {string} id
 * @property {string} [title]  big font, one row, truncated
 * @property {string[]} [lines]  small font; each is wrapped, the tile shows the first rows that fit its budget
 * @property {Image|null} [thumb]
 * @property {string} [badge]  small font, right end of the top row
 * @property {number} [colour]  of the title, or of the lines when there is none (default white)
 * @property {boolean} [dim]  a quiet tile: no panel behind it, grey text
 * @property {boolean} [tail]  show the last rows instead of the first (text still being written)
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 * @typedef {{card: Card, x: number, y: number, w: number, h: number, rows: string[], thumb: Image|null, selected: boolean}} Tile
 */

export class CardList {
  #window;

  /** @param {{anchor?: 'end'|'start', lines?: number}} [options] anchor: the edge a following list stays on; lines: small-font rows under a title (one more without) */
  constructor({ anchor = 'end', lines = 2 } = {}) { this.anchor = anchor; this.lines = lines; this.#window = new ListWindow({ anchor, gap: GAP }); }

  /** Hand in the cards (in display order, top to bottom). A selection whose card is gone lets go. */
  set(cards) { this.#window.set(cards); return this; }
  /** @returns {Card[]} */
  get cards() { return this.#window.items; }

  /** @returns {Card|null} the selected card; null while following */
  get selected() { return this.#window.selected; }
  /** Nothing selected: the window stays on the anchored edge. */
  get following() { return this.#window.following; }
  /** Let go of the selection and return to the anchored edge. */
  follow() { this.#window.follow(); }
  /** Select the card with this id (no-op when absent). */
  select(id) { this.#window.select(id); }
  /** Move the selection by `d` tiles (list.js: away from the anchored edge selects, back past it follows, the far end clamps). */
  move(d) { this.#window.move(d); }

  /** Small-font columns a tile's text has in a `width` px list. */
  cols(s, width, { thumb = false } = {}) { return Math.max(1, Math.floor(this.#textWidth(width, thumb) / s.fonts.small.width)); }
  #textWidth(width, thumb) { return width - 2 * PAD - BAR - (thumb ? THUMB.w + 6 : 4); }

  /** A card's rows (wrapped, cut to its budget, a cut marked `~`), its thumbnail (read once: it may be a getter) and its tile height. */
  #measure(s, card, width) {
    const { main, small } = s.fonts, thumb = card.thumb ?? null, cols = this.cols(s, width, { thumb: !!thumb }), max = this.lines + (card.title ? 0 : 1);
    const all = (card.lines ?? []).flatMap((l) => wrapWords(l, cols));
    const rows = card.tail ? all.slice(-max) : all.slice(0, max);
    if (!card.tail && all.length > max) rows[max - 1] = `${rows[max - 1].slice(0, cols - 1)}~`;
    const h = Math.max(thumb ? THUMB.h : 0, (card.title ? main.height : 0) + rows.length * small.height, small.height) + 2 * PAD;
    return { rows, h, thumb };
  }

  /**
   * Where the tiles go: whole tiles only, the selected one always among them (list.js).
   * @param {object} s the surface (fonts) @param {Rect} rect @returns {Tile[]} top to bottom
   */
  layout(s, rect) {
    const memo = new Map(), m = (card) => memo.get(card) ?? memo.set(card, this.#measure(s, card, rect.w)).get(card);
    return this.#window.place(rect, (card) => m(card).h).map(({ item, y, h, selected }) => ({ card: item, x: rect.x, y, w: rect.w - BAR, h, rows: m(item).rows, thumb: m(item).thumb, selected }));
  }

  /** Draw the list into `rect` (the caller's clear is the background). @returns {Tile[]} what was drawn */
  render(s, rect) {
    const { main, small } = s.fonts, tiles = this.layout(s, rect);
    for (const { card, x, y, w, h, rows, thumb, selected } of tiles) {
      if (selected) s.fillRect(x, y, w, h, C.ok);
      else if (!card.dim) s.fillRect(x, y, w, h, C.panel);
      let tx = x + PAD + 4;
      if (thumb) {
        const d = fit(thumb, THUMB);
        s.blitImage(thumb, x + PAD + ((THUMB.w - d.w) >> 1), y + PAD + ((THUMB.h - d.h) >> 1), d);
        tx = x + PAD + THUMB.w + 6;
      }
      const right = x + w - PAD - 2, ink = (colour) => (selected ? C.black : colour);
      const badge = card.badge ? s.text(right, y + PAD + (card.title ? (main.height - small.height) >> 1 : 0), card.badge, { font: small, colour: ink(C.dim), align: 'right' }) : null;
      const top = (badge ? badge.x - 6 : right) - tx;   // what the top row has left of the badge
      let ty = y + PAD;
      if (card.title) { s.text(tx, ty, card.title, { font: main, colour: ink(card.colour ?? C.white), maxWidth: top }); ty += main.height; }
      rows.forEach((r, i) => s.text(tx, ty + i * small.height, r, { font: small, colour: ink(card.dim ? C.dim : card.title ? C.white : card.colour ?? C.white), maxWidth: !card.title && i === 0 ? top : right - tx }));
    }
    if (tiles.length) scrollBar(s, rect, this.cards.indexOf(tiles[0].card), this.cards.indexOf(tiles.at(-1).card), this.cards.length);
    return tiles;
  }
}

/**
 * Word wrap into rows of varying width: `colsAt(row)` is the room row `row` has (the rows beside
 * a picture are shorter than the ones under it). Each paragraph starts a row, an empty one is a
 * blank row, a word longer than a row is broken.
 * @param {{text: string, colour?: number}[]} paragraphs @returns {{text: string, colour?: number}[]}
 */
function flow(paragraphs, colsAt) {
  const rows = [];
  for (const { text, colour } of paragraphs) {
    for (const piece of String(text ?? '').split('\n')) {
      let cur = '';
      for (let word of piece.split(/\s+/).filter(Boolean)) {
        for (;;) {
          const cols = Math.max(1, colsAt(rows.length));
          if (!cur && word.length > cols) { rows.push({ text: word.slice(0, cols), colour }); word = word.slice(cols); continue; }
          if (!cur) { cur = word; break; }
          if (cur.length + 1 + word.length <= cols) { cur += ` ${word}`; break; }
          rows.push({ text: cur, colour }); cur = '';
        }
      }
      rows.push({ text: cur, colour });
    }
  }
  return rows;
}

/**
 * @typedef {object} Detail  what an opened card shows
 * @property {string} title
 * @property {string} [badge]  small font, right of the title
 * @property {Image|null} [image]
 * @property {(string|{text: string, colour?: number})[]} [paragraphs]  each starts a row; '' is a blank row
 */

export class DetailView {
  #scroll = 0;   // rows scrolled off the top; clamped to the content at each render
  #page = 1;     // rows a swipe moves: a page less two rows of overlap, known once drawn
  #fill;

  /** @param {{fill?: boolean}} [options] fill: the picture is as tall as the view (and at most 55% of its width) instead of 160x120 */
  constructor({ fill = false } = {}) { this.#fill = fill; }

  /** Back to the top (a card was just opened). */
  reset() { this.#scroll = 0; }
  /** Scroll by `d` pages (negative: back up). The far end is clamped when drawn. */
  scroll(d) { this.#scroll = Math.max(0, this.#scroll + d * this.#page); }

  /**
   * Draw the opened card into `rect`: the title row, then the picture with the text beside and
   * under it, scrolled as one sheet.
   * @param {object} s the surface @param {Rect} rect @param {Detail} detail
   * @returns {{scroll: number, max: number, rows: number, visible: number}} where the view is and how far it can go, in rows
   */
  render(s, rect, { title, badge, image, paragraphs = [] }) {
    const { main, small } = s.fonts, x = rect.x + PAD + 4, right = rect.x + rect.w - BAR - PAD;
    const b = badge ? s.text(right, rect.y + ((main.height - small.height) >> 1), badge, { font: small, colour: C.dim, align: 'right' }) : null;
    s.text(x, rect.y, title ?? '', { font: main, colour: C.title, maxWidth: (b ? b.x - 6 : right) - x });
    s.line(rect.x, rect.y + main.height + 2, rect.x + rect.w, rect.y + main.height + 2, C.faint);
    const body = { x: rect.x, y: rect.y + main.height + 6, w: rect.w, h: rect.h - main.height - 6 };
    const visible = Math.max(1, Math.floor(body.h / small.height));
    const box = this.#fill ? { w: Math.floor((right - x) * 0.55), h: visible * small.height - 4 } : IMAGE;   // -4: the picture's rows (its height + 4) are exactly the page
    const pic = image ? fit(image, box) : null, picRows = pic ? Math.ceil((pic.h + 4) / small.height) : 0;
    const beside = pic ? x + pic.w + 8 : x;
    const rows = flow(paragraphs.map((p) => (typeof p === 'string' ? { text: p } : p)), (r) => Math.floor((right - (r < picRows ? beside : x)) / small.width));
    const total = Math.max(rows.length, picRows), max = Math.max(0, total - visible);
    this.#scroll = Math.min(this.#scroll, max);
    this.#page = Math.max(1, visible - 2);
    const cut = this.#scroll * small.height;   // pixels of the sheet above the window
    if (pic && cut < pic.h) {
      // the raster clips to the panel, not to our rectangle: a picture scrolled half out is drawn from the source row that is still in
      const skip = Math.floor(cut * image.height / pic.h), bytes = image.data.length / (image.width * image.height);
      const part = skip ? { width: image.width, height: image.height - skip, data: image.data.subarray(skip * image.width * bytes) } : image;
      s.blitImage(part, x, body.y, { w: pic.w, h: pic.h - cut });
    }
    for (let r = this.#scroll; r < Math.min(rows.length, this.#scroll + visible); r++) {
      s.text(r < picRows ? beside : x, body.y + (r - this.#scroll) * small.height, rows[r].text, { font: small, colour: rows[r].colour ?? C.white });
    }
    scrollBar(s, body, this.#scroll, this.#scroll + visible - 1, total);
    return { scroll: this.#scroll, max, rows: total, visible };
  }
}
