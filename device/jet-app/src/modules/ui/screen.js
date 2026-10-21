// Screen: something that renders into the display grid and may consume gestures.

export class Screen {
  /** @param {import('./index.js').Ui} ui */
  constructor(ui) { this.ui = ui; }
  get name() { return this.constructor.name; }
  /** Draw into `grid` (already cleared). @param {import('../display/grid.js').Grid} grid */
  render(grid) {}   // eslint-disable-line no-unused-vars
  /** @param {string} gesture e.g. 'press:front' @returns {boolean} true when consumed */
  onGesture(gesture) { return false; }   // eslint-disable-line no-unused-vars
  onShow() {}
  onHide() {}
  invalidate() { this.ui.requestRender(); }
}
