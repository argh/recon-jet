// Chooser: the one list box used everywhere a choice is offered (mode switcher, System menu):
// a 2 px yellow border, the title in yellow, one big-font row per item, the selected row as a
// filled green bar with black text, and a hint line along the bottom of the panel. Pure state
// plus a render; the owner routes gestures to `move()` and reads `item`.
import { C, MARGIN, hint } from './style.js';

/** @typedef {{label: string, id?: string, disabled?: boolean, [k: string]: any}} ChooserItem  disabled: shown faint, never selected */

export class Chooser {
  /** @param {{title: string, items: ChooserItem[], hint?: string, cols?: number}} spec cols: box width in big-font cells (22 = jetd's chooser) */
  constructor({ title, items, hint: hintText = 'swipe: move   front: pick   rear: back', cols = 22 }) {
    this.title = title; this.items = items; this.hint = hintText; this.cols = cols;
    this.selected = 0;
    if (items[0]?.disabled) this.move(1);
  }
  get item() { return this.items[this.selected]; }
  /** Move the selection by `d` rows, wrapping and skipping disabled items. */
  move(d) {
    const n = this.items.length;
    for (let i = this.selected, k = 0; n && k < n; k++) { i = (i + d + n) % n; if (!this.items[i].disabled) { this.selected = i; return; } }
  }
  /** Select the item with this id (no-op when absent or disabled). */
  select(id) { const i = this.items.findIndex((it) => it.id === id); if (i >= 0 && !this.items[i].disabled) this.selected = i; }

  /** The box: left-aligned, vertically centred. */
  box(s) {
    const { main } = s.fonts;
    const w = this.cols * main.width, h = (this.items.length + 1) * main.height + 8;
    return { x: MARGIN + 2, y: Math.max(0, Math.floor((s.height - h) / 2)), w, h };
  }

  render(s) {
    const { main } = s.fonts, b = this.box(s), pad = 4, rowH = main.height;
    s.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, C.black);
    s.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, C.title, { width: 2 });
    s.text(b.x + main.width, b.y + pad, this.title, { font: main, colour: C.title, maxWidth: b.w - main.width });
    this.items.forEach((item, i) => {
      const y = b.y + pad + (i + 1) * rowH, on = i === this.selected;
      if (on) s.fillRect(b.x, y, b.w, rowH, C.ok);
      const label = typeof item.label === 'function' ? item.label() : item.label;
      s.text(b.x + main.width, y, `${on ? '> ' : '  '}${label}`, { font: main, colour: on ? C.black : item.disabled ? C.faint : C.dim, maxWidth: b.w - main.width });
    });
    if (this.hint) hint(s, this.hint);
  }
}
