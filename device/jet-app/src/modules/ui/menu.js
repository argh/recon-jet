// Menu: a list of items; swipe up/down moves, front press (or tap) picks, rear press closes.
// An item with `live: true` is the camera thumbnail: picking it toggles jetd's viewfinder in the
// rectangle drawn beside the list (the surface leaves that rectangle to jetd while it streams).
import { Screen, C, MARGIN } from './screen.js';

export class Menu extends Screen {
  /** @param {{title: string, items: Array<{label: string, action?: () => void, live?: boolean}>}} spec */
  constructor(ui, { title, items }) { super(ui); this.title = title; this.items = items; this.selected = 0; }

  /** Camera rectangle: right of the list, 4:3, below the title. */
  get thumb() { const { width, height } = this.ui.surface; const w = 160, h = 120; return { x: width - w - MARGIN - 2, y: Math.floor((height - h) / 2) + 6, w, h }; }

  render(s) {
    const { main, small } = s.fonts, { width, height, viewfinderRect } = s;
    s.text(MARGIN, 4, this.title, { font: main, colour: C.title });
    s.line(0, 26, width, 26, C.faint);
    this.items.forEach((item, i) => {
      const y = 34 + i * (main.height + 6), selected = i === this.selected;
      const label = item.live ? `${item.label}: ${viewfinderRect ? 'on' : 'off'}` : item.label;
      if (selected) s.fillRect(0, y - 2, 230, main.height + 4, C.panel);
      s.text(MARGIN + 14, y, label, { font: main, colour: selected ? C.ok : C.dim, maxWidth: 230 - MARGIN - 14 });
      if (selected) s.text(MARGIN, y, '>', { font: main, colour: C.ok });
    });
    const t = this.thumb;
    s.strokeRect(t.x - 2, t.y - 2, t.w + 4, t.h + 4, viewfinderRect ? C.ok : C.faint);
    if (!viewfinderRect) { s.icon(t.x + t.w / 2 - 8, t.y + t.h / 2 - 10, s.icons.camera, C.faint); s.text(t.x + t.w / 2, t.y + t.h / 2 + 4, 'camera off', { font: small, colour: C.faint, align: 'center' }); }
    s.text(width / 2, height - small.height - 2, 'swipe: move   front/tap: pick   rear: back', { font: small, colour: C.dim, align: 'center' });
  }

  onGesture(gesture) {
    const n = this.items.length, item = this.items[this.selected];
    switch (gesture) {
      case 'swipe:up': this.selected = (this.selected + n - 1) % n; break;
      case 'swipe:down': this.selected = (this.selected + 1) % n; break;
      case 'press:front': case 'press:tap': if (item.live) this.#toggleCamera(); else item.action?.(); return true;
      case 'press:rear': this.ui.closeMenu(); return true;
      default: return false;
    }
    this.invalidate();
    return true;
  }

  onHide() { this.ui.surface.stopViewfinder(); this.invalidate(); }

  #toggleCamera() {
    const s = this.ui.surface;
    if (s.viewfinderRect) { s.stopViewfinder(); this.invalidate(); return; }
    const t = this.thumb;
    s.viewfinder(t.x, t.y, t.w, t.h).then(() => this.invalidate(), (error) => this.ui.logger?.warn({ error: error.message }, 'viewfinder failed'));
  }
}
