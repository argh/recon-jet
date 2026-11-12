// Comms mode: the link to Jet (docs/agent.md). Two screens side by side, the System-mode
// pattern one level down: each is a module of its own (`provides: 'CommsScreen'`, its own schema
// and injected models - see channel.js for the shape), this mode holds the configurable
// `screens` array (tab order; personal/ can add to it), the tab row and the gesture routing.
//
// A screen is `{ id, label, enter(ctx), leave(), onGesture(g) -> handled, render(s, rect),
// tick?() }`. It gets every gesture first; a swipe left/right it does not consume (it does while
// a card is open) moves to the neighbouring tab, and a rear press it does not consume is the
// mode's root: the registry ascends to the switcher. `rect` is the panel under the tab row and
// above the hint line; the hint itself is the screen's to write. The mode relays no data: a
// screen subscribes to its own models between `enter` and `leave`. The conversation belongs
// to no mode (the operator answers a wake-word question wherever the wearer is, and nothing here
// switches screens for it): the Channel is where it is reviewed.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP } from '../../modules/ui/style.js';
import { ChannelScreen } from './channel.js';
import { ScanScreen } from './scan.js';

const s = Schema.create;

export class CommsMode {
  static moduleInfo = {
    name: 'comms-mode',
    schema: s()
      .property('screens', s('array').property('*', s('CommsScreen'))
        .default(['channel-screen', 'scan-screen'])
        .meta('description', 'the Comms screens, in tab order (personal/ screens provide "CommsScreen" and are added here)'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [
      { ModuleClass: ChannelScreen, relative: true },
      { ModuleClass: ScanScreen, relative: true },
    ],
  };
  /** @type {object[]} the CommsScreen providers, in tab order (injected) */ screens = [];
  modes; ui; logger;

  id = 'comms'; label = 'Comms'; spoken = ['comms'];
  #index = 0;        // the tab last shown: coming back to the mode returns to it
  #current = false;
  #ctx = {};

  async start() { this.modes.register(this); }   // before any await: registration order is the switcher's order

  /** The screen showing, or the one that will when the mode is entered. */
  get screen() { return this.screens[this.#index] ?? null; }
  /** The screen with this id (undefined when the configured array has no such screen). */
  getScreen(id) { return this.screens.find((sc) => sc.id === id); }

  enter(ctx = {}) { this.#current = true; this.#ctx = ctx; this.screen?.enter?.(ctx); }
  leave() { this.#current = false; this.screen?.leave?.(); }

  /** Show a screen by id. The one showing hears `leave()`, the new one `enter(ctx)`. @returns {boolean} false when there is no such screen */
  open(id) {
    const i = this.screens.findIndex((sc) => sc.id === id);
    if (i < 0) return false;
    if (i === this.#index) return true;
    if (this.#current) this.screen?.leave?.();
    this.#index = i;
    if (this.#current) this.screen.enter?.(this.#ctx);
    this.logger?.info({ screen: id }, 'comms screen');
    this.ui.requestRender();
    return true;
  }

  onGesture(g) {
    if (this.screen?.onGesture?.(g)) return true;
    // the secondary axis switches tabs; the ends do not wrap (the tab row shows where you are)
    const next = g === 'swipe:left' ? this.screens[this.#index - 1] : g === 'swipe:right' ? this.screens[this.#index + 1] : null;
    return next ? this.open(next.id) : false;
  }

  tick() { this.screen?.tick?.(); }

  /** What a screen draws in: under the tab row, above the hint line. */
  rect(s) {
    const { small } = s.fonts, y = TOP + small.height + 2;
    return { x: 2, y, w: s.width - 4, h: s.height - small.height - 2 - y };
  }

  render(s) {
    const { small } = s.fonts;
    let x = MARGIN;
    for (const sc of this.screens) {   // the tab row: the showing screen as the selected chip of the house grammar
      const label = (sc.label ?? sc.id).toUpperCase(), w = label.length * small.width + 8, on = sc === this.screen;
      if (on) s.fillRect(x, TOP, w, small.height, C.ok);
      s.text(x + 4, TOP, label, { font: small, colour: on ? C.black : C.dim });
      x += w + 4;
    }
    this.screen?.render(s, this.rect(s));
  }
}
