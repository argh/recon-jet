// Menu: a list of items; swipe up/down moves, front press (or tap) picks, rear press closes.
import { Screen } from './screen.js';

const HILITE = [0, 255, 128], DIM = [200, 200, 200], TITLE = [255, 255, 0];

export class Menu extends Screen {
  /** @param {{title: string, items: Array<{label: string, action: () => void}>}} spec */
  constructor(ui, { title, items }) { super(ui); this.title = title; this.items = items; this.selected = 0; }

  render(grid) {
    grid.set(0, this.title, { colour: TITLE, centre: true });
    this.items.forEach((item, i) => grid.set(2 + i, `${i === this.selected ? '> ' : '  '}${item.label}`, { colour: i === this.selected ? HILITE : DIM }));
    grid.set(grid.rowCount - 1, 'swipe: move  front: pick  rear: back', { colour: DIM, centre: true });
  }

  onGesture(gesture) {
    const n = this.items.length;
    switch (gesture) {
      case 'swipe:up': this.selected = (this.selected + n - 1) % n; break;
      case 'swipe:down': this.selected = (this.selected + 1) % n; break;
      case 'press:front': case 'press:tap': this.items[this.selected].action(); return true;
      case 'press:rear': this.ui.closeMenu(); return true;
      default: return false;
    }
    this.invalidate();
    return true;
  }
}
