// ui: owns the screen stack and the menu overlay, routes gestures, schedules renders, and only
// draws while jetd's remote mode is showing with the surface acquired. jetd owns its own
// log/shell/setup modes and draws over the surface there: `leaveTo(mode)` hands the panel over
// and the app stays silent (no renders, no commands) until jetd comes back to remote, which it
// announces with `m remote` and a fresh hello; that hello triggers the repaint.
//
// Button semantics (raw keys, see input): front hold opens the menu and closes it again; swipe
// up/down moves the selection; front press (or a pad tap) picks; rear press goes up one level
// and closes the menu at the top. Menu tree: Camera, Kernel log, System > (Status, Setup, Back).
import { Schema } from '@versionzero/module-manager';
import { Menu } from './menu.js';
import { StatusScreen } from './status.js';

const s = Schema.create;

export class Ui {
  static moduleInfo = {
    name: 'ui',
    schema: s()
      .property('menuGestures', s('array').property('*', s('string')).default(['hold:front'])
        .meta('description', 'gestures that open the menu when the screen does not consume them'))
      .property('clockMs', s('number').default(1000).meta('description', 'status screen refresh'))
      .property('surface', s('Surface').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  menuGestures; clockMs; surface; input; power; deviceLink; logger;

  /** @type {import('./screen.js').Screen} */ screen;
  /** @type {Menu|null} */ menu = null;
  #pending = false;
  renders = 0;   // flushed frames (diagnostics, tests)

  async start() {
    this.status = new StatusScreen(this);
    // the surface is acquired on connect; jetd sends a fresh hello whenever remote mode (re)appears
    this.surface.on('ready', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('hello', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('mode', (mode) => { this.logger?.info({ mode }, 'jetd mode'); this.#setActive(); });
    this.deviceLink.on('disconnected', () => { this.closeMenu(); this.#setActive(); });
    this.deviceLink.on('glance', (g) => { this.status.glance = { ...g, t: Date.now() }; this.status.invalidate(); });
    this.deviceLink.on('view', (v) => { this.status.view = { ...v, t: Date.now() }; this.status.invalidate(); });
    this.power.on('update', () => this.status.onPower());
    this.input.on('gesture', (g) => this.#onGesture(g));
    this.#setActive();   // the surface may already be up (jetd connected before we started)
    this.show(this.status);
  }
  async stop() { this.menu?.onHide(); this.screen?.onHide(); }

  #setActive() { this.surface.active = this.deviceLink.connected && this.deviceLink.mode === 'remote' && this.surface.ready; }

  /** @param {import('./screen.js').Screen} screen */
  show(screen) {
    this.screen?.onHide();
    this.screen = screen;
    if (!this.menu) screen.onShow();   // a covered screen stays paused until the menu closes
    this.logger?.info({ screen: screen.name }, 'screen');
    this.requestRender();
  }

  /** The menu covers the screen: the screen's timers pause until it closes. */
  openMenu() {
    if (this.menu) return;
    this.screen?.onHide();
    this.menu = new Menu(this, { title: 'MENU', items: [
      { label: 'Camera', live: true },
      { label: 'Kernel log', action: () => this.leaveTo('log') },
      { label: 'System', children: [
        { label: 'Status', action: () => { this.closeMenu(); this.show(this.status); } },
        { label: 'Setup', action: () => this.leaveTo('setup') },
        { label: 'Back', back: true },
      ] },
    ] });
    this.menu.onShow();
    this.logger?.info('menu open');
    this.requestRender();
  }
  closeMenu() {
    if (!this.menu) return;
    this.menu.onHide(); this.menu = null;
    this.screen?.onShow();
    this.logger?.info('menu closed');
    this.requestRender();
  }
  toggleMenu() { if (this.menu) this.closeMenu(); else this.openMenu(); }

  /** Hand the panel to one of jetd's own modes (log, shell, setup); jetd's hello brings us back. */
  leaveTo(mode) {
    this.closeMenu();
    this.surface.active = false;   // stop drawing now; `m <mode>` confirms, `m remote` + hello revives
    this.logger?.info({ mode }, 'leaving to jetd mode');
    this.deviceLink.setMode(mode);
  }

  #onGesture(gesture) {
    if (this.deviceLink.mode !== 'remote') return;   // jetd's modes own their keys; nothing is sent from here
    if (this.menu) { this.menu.onGesture(gesture); return; }
    if (this.screen.onGesture(gesture)) return;
    if (this.menuGestures.includes(gesture)) this.openMenu();
  }

  /** Coalesce renders to one per tick. */
  requestRender() {
    if (this.#pending) return;
    this.#pending = true;
    setImmediate(() => { this.#pending = false; this.#render(); });
  }

  #render() {
    if (!this.surface.active) return;   // jetd is drawing (another mode), or nothing to draw on
    const t0 = performance.now();
    this.surface.clear();
    (this.menu ?? this.screen).render(this.surface);
    const renderMs = +(performance.now() - t0).toFixed(2);
    const rect = this.surface.flush();
    this.renders++;
    this.logger?.debug({ renderMs, flushMs: +(performance.now() - t0 - renderMs).toFixed(2), rect }, 'render');
  }
}
