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
export const STRIP_H = 10;   // the system status strip along the top (ui.setStrip)

/**
 * Greedy word wrap for a monospace font: `cols` characters per line; words longer than a line
 * are broken; newlines in the text start a new line.
 * @returns {string[]}
 */
export function wrapWords(text, cols) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let cur = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > cols) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, cols)); word = word.slice(cols); }
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= cols) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
