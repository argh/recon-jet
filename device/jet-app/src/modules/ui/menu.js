// Menu: a vertical list in a bordered box, laid out like jetd's mode chooser. Swipe up/down
// moves the selection, front press (or a pad tap) picks, rear press goes up one level (closes
// at the top), another front hold closes outright. An item with `children` opens them as a
// sub-level titled by the item's label; an item with `back: true` goes up one level. An item
// with `live: true` is the camera thumbnail: picking it toggles jetd's viewfinder in the
// rectangle drawn beside the list (the surface leaves that rectangle to jetd while it streams).
import { Screen, C, MARGIN } from './screen.js';

const BORDER = 0xffff00, SELECTED_BG = C.ok, SELECTED_FG = 0x000000;

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {() => void} [action]  picked: run this
 * @property {MenuItem[]} [children]  picked: open these as a sub-level
 * @property {boolean} [back]  picked: go up one level
 * @property {boolean} [live]  the camera thumbnail toggle
 */

export class Menu extends Screen {
  /** @type {Array<{title: string, items: MenuItem[], selected: number}>} the open levels, root first */
  #levels;

  /** @param {{title: string, items: MenuItem[]}} spec */
  constructor(ui, { title, items }) { super(ui); this.#levels = [{ title, items, selected: 0 }]; }

  get #level() { return this.#levels[this.#levels.length - 1]; }
  /** The current level's list. */
  get items() { return this.#level.items; }
  get title() { return this.#level.title; }
  get selected() { return this.#level.selected; }
  set selected(i) { this.#level.selected = i; }
  /** 1 at the root. */
  get depth() { return this.#levels.length; }

  /** Open `item.children` as a new level. */
  enter(item) { this.#levels.push({ title: item.label.toUpperCase(), items: item.children, selected: 0 }); this.invalidate(); }
  /** Up one level; at the root the menu closes. */
  back() { if (this.#levels.length > 1) { this.#levels.pop(); this.invalidate(); } else this.ui.closeMenu(); }

  /** The list box: 22 big-font cells wide (jetd's chooser width), title row plus one row per item. */
  get box() {
    const { main } = this.ui.surface.fonts, { height } = this.ui.surface;
    const w = 22 * main.width, h = (this.items.length + 1) * main.height + 8;
    return { x: MARGIN + 2, y: Math.max(0, Math.floor((height - h) / 2)), w, h };
  }
  /** Camera rectangle: right of the box, 4:3, vertically centred. */
  get thumb() { const { width, height } = this.ui.surface; const w = 160, h = 120; return { x: width - w - MARGIN - 2, y: Math.floor((height - h) / 2), w, h }; }

  render(s) {
    const { main, small } = s.fonts, { width, height, viewfinderRect } = s;
    const b = this.box, pad = 4, rowH = main.height;
    s.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, BORDER, { width: 2 });
    s.text(b.x + main.width, b.y + pad, this.title, { font: main, colour: BORDER });
    this.items.forEach((item, i) => {
      const y = b.y + pad + (i + 1) * rowH, selected = i === this.selected;
      const label = item.live ? `${item.label}: ${viewfinderRect ? 'on' : 'off'}` : item.label;
      if (selected) s.fillRect(b.x, y, b.w, rowH, SELECTED_BG);
      s.text(b.x + main.width, y, `${selected ? '> ' : '  '}${label}`, { font: main, colour: selected ? SELECTED_FG : C.dim, maxWidth: b.w - main.width });
    });
    const t = this.thumb;
    s.strokeRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4, viewfinderRect ? C.ok : C.faint);
    if (!viewfinderRect) { s.icon(t.x + t.w / 2 - 8, t.y + t.h / 2 - 10, s.icons.camera, C.faint); s.text(t.x + t.w / 2, t.y + t.h / 2 + 4, 'camera off', { font: small, colour: C.faint, align: 'center' }); }
    const rear = this.depth > 1 ? 'rear: back' : 'rear: close';
    s.text(width / 2, height - small.height - 2, `swipe: move   front: pick   ${rear}   hold front: close`, { font: small, colour: C.dim, align: 'center' });
  }

  onGesture(gesture) {
    const n = this.items.length, item = this.items[this.selected];
    switch (gesture) {
      case 'swipe:up': this.selected = (this.selected + n - 1) % n; break;
      case 'swipe:down': this.selected = (this.selected + 1) % n; break;
      case 'press:front': case 'press:tap': this.#pick(item); return true;
      case 'press:rear': this.back(); return true;
      case 'hold:front': this.ui.closeMenu(); return true;
      default: return false;
    }
    this.invalidate();
    return true;
  }

  #pick(item) {
    if (item.live) this.#toggleCamera();
    else if (item.children) this.enter(item);
    else if (item.back) this.back();
    else item.action?.();
  }

  onHide() { this.ui.surface.stopViewfinder(); this.invalidate(); }

  #toggleCamera() {
    const s = this.ui.surface;
    if (s.viewfinderRect) { s.stopViewfinder(); this.invalidate(); return; }
    const t = this.thumb;
    s.viewfinder(t.x, t.y, t.w, t.h).then(() => this.invalidate(), (error) => this.ui.logger?.warn({ error: error.message }, 'viewfinder failed'));
  }
}
