// Screen: something that renders onto the surface and may consume gestures.

export class Screen {
  /** @param {import('./index.js').Ui} ui */
  constructor(ui) { this.ui = ui; }
  get name() { return this.constructor.name; }
  /** Draw onto `s` (already cleared to black). @param {import('../surface/index.js').Surface} s */
  render(s) {}   // eslint-disable-line no-unused-vars
  /** @param {string} gesture e.g. 'press:front' @returns {boolean} true when consumed */
  onGesture(gesture) { return false; }   // eslint-disable-line no-unused-vars
  onShow() {}
  onHide() {}
  invalidate() { this.ui.requestRender(); }
}

// Shared palette (0xRRGGBB) and layout constants for the 428x240 panel.
export const C = { white: 0xffffff, dim: 0xa0a0a0, faint: 0x404040, title: 0xffff00, ok: 0x00ff80, warn: 0xffa000, bad: 0xff4040, panel: 0x101820 };
export const MARGIN = 6;
