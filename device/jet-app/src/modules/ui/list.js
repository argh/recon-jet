// The part every scrolling list of the house grammar shares (the card tiles and the chat
// bubbles): which item is selected, and which whole items the window shows. What an item looks
// like - and so how tall it is - is its list's business; this only asks for the height.
//
// A list *follows* until the wearer moves: nothing is selected and the window stays on the
// anchored edge (`end`: the newest at the bottom, a conversation; `start`: the first at the top,
// a review list). A move away from that edge selects; moving back past it, or `follow()`, lets
// go again. Only the items the window touches are measured: a hundred cost what eight do.

import { C } from './style.js';

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/** The largest size with the image's aspect that fits the box (it may grow: a 96x72 crop fills 160x120). */
export function fit(image, box) {
  const k = Math.min(box.w / image.width, box.h / image.height);
  return { w: Math.max(1, Math.round(image.width * k)), h: Math.max(1, Math.round(image.height * k)) };
}

/** A thin position bar on the right edge of `rect`: items `first..last` of `n` are showing. Nothing when all are. */
export function scrollBar(s, rect, first, last, n) {
  if (n <= 0 || last - first + 1 >= n) return;
  const x = rect.x + rect.w - 2, top = Math.floor(rect.h * first / n), h = Math.max(4, Math.ceil(rect.h * (last - first + 1) / n));
  s.fillRect(x, rect.y, 2, rect.h, C.faint);
  s.fillRect(x, rect.y + Math.min(top, rect.h - h), 2, h, C.dim);
}

export class ListWindow {
  /** @type {{id: string}[]} */ #items = [];
  /** @type {string|null} the selected item's id; null = following */ #selected = null;
  /** @type {string|null} the item on the anchored edge of the window while not following */ #edge = null;
  #anchor; #gap; #selectable;

  /**
   * @param {object} [options]
   * @param {'end'|'start'} [options.anchor]  the edge a following list stays on
   * @param {number} [options.gap]  pixels between items
   * @param {(item: object) => boolean} [options.selectable]  items the selection steps over when false (they are still shown)
   */
  constructor({ anchor = 'end', gap = 0, selectable = () => true } = {}) { this.#anchor = anchor; this.#gap = gap; this.#selectable = selectable; }

  /** Hand in the items (in display order, top to bottom). A selection whose item is gone lets go. */
  set(items) {
    this.#items = items;
    if (this.#selected !== null && !items.some((c) => c.id === this.#selected)) this.follow();
    return this;
  }
  get items() { return this.#items; }

  /** The selected item; null while following. */
  get selected() { return this.#selected === null ? null : this.#items.find((c) => c.id === this.#selected) ?? null; }
  /** Nothing selected: the window stays on the anchored edge. */
  get following() { return this.#selected === null; }
  /** Let go of the selection and return to the anchored edge. */
  follow() { this.#selected = null; this.#edge = null; }
  /** Select the item with this id (no-op when absent or not selectable). */
  select(id) { if (this.#items.some((c) => c.id === id && this.#selectable(c))) this.#selected = id; }

  /**
   * Move the selection by `d` items. From following, a move away from the anchored edge selects
   * the item on it (the newest, in a conversation); moving back past that edge follows again;
   * the far end clamps.
   */
  move(d) {
    const can = this.#items.filter(this.#selectable), n = can.length, end = this.#anchor === 'end', home = end ? n - 1 : 0;
    if (!n || !d) return;
    const i = can.findIndex((c) => c.id === this.#selected);
    if (i < 0) { if (end ? d < 0 : d > 0) this.#selected = can[home].id; return; }
    const j = i + d;
    if (end ? j > home : j < home) return this.follow();
    this.#selected = can[Math.max(0, Math.min(n - 1, j))].id;
  }

  /**
   * Where the items go in `rect`: whole items only, the selected one always among them, the
   * window held still while the selection moves inside it. A following `end` list is
   * bottom-aligned.
   * @param {Rect} rect @param {(item: object) => number} heightOf  asked once per item the window touches
   * @returns {{item: object, index: number, y: number, h: number, selected: boolean}[]} top to bottom
   */
  place(rect, heightOf) {
    const items = this.#items, n = items.length, end = this.#anchor === 'end', gap = this.#gap;
    if (!n) return [];
    const memo = new Map(), h = (i) => memo.get(i) ?? memo.set(i, heightOf(items[i])).get(i);
    // k counts items from the anchored edge (0 = the newest of a conversation, the first of a review list)
    const at = (k) => (end ? n - 1 - k : k);
    /** one past the last k that fits when the window's edge is at `from` (never fewer than one item) */
    const reach = (from) => { let used = 0, k = from; while (k < n && used + h(at(k)) + (k > from ? gap : 0) <= rect.h) { used += h(at(k)) + (k > from ? gap : 0); k++; } return Math.max(k, from + 1); };
    const sel = items.findIndex((c) => c.id === this.#selected), ks = sel < 0 ? -1 : at(sel);
    let edge = 0;
    if (ks >= 0) {
      const held = items.findIndex((c) => c.id === this.#edge);
      edge = Math.min(held < 0 ? 0 : at(held), ks);
      while (reach(edge) <= ks) edge++;
    }
    this.#edge = ks >= 0 ? items[at(edge)].id : null;
    const stop = reach(edge), first = end ? at(stop - 1) : edge, last = end ? at(edge) : stop - 1;
    let used = -gap;
    for (let i = first; i <= last; i++) used += h(i) + gap;
    let y = rect.y + (end ? Math.max(0, rect.h - used) : 0);
    const placed = [];
    for (let i = first; i <= last; i++) { placed.push({ item: items[i], index: i, y, h: h(i), selected: i === sel }); y += h(i) + gap; }
    return placed;
  }
}
