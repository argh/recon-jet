// ui: owns the screen stack and the menu overlay, routes gestures, schedules renders, and only
// flushes while jetd's remote mode is showing with the surface acquired (jetd owns its own
// log/shell/setup modes and draws over the surface there; a hello means remote is back).
import { Schema } from '@versionzero/module-manager';
import { Screen } from './screen.js';
import { Menu } from './menu.js';
import { StatusScreen } from './status.js';

const s = Schema.create;

/** Passive screen: nothing drawn, so jetd's remote mode looks like a plain, hub-less remote. */
class RemoteScreen extends Screen { render() {} }

export class Ui {
  static moduleInfo = {
    name: 'ui',
    schema: s()
      .property('menuGestures', s('array').property('*', s('string')).default(['hold:front', 'press:rear'])
        .meta('description', 'gestures that open the menu when the screen does not consume them'))
      .property('clockMs', s('number').default(1000).meta('description', 'status screen refresh'))
      .property('surface', s('Surface').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  menuGestures; clockMs; surface; input; power; deviceLink; logger;

  /** @type {Screen} */ screen;
  /** @type {Menu|null} */ menu = null;
  #pending = false;

  async start() {
    this.status = new StatusScreen(this);
    this.remote = new RemoteScreen(this);
    // the surface is acquired on connect; jetd sends a fresh hello whenever remote mode (re)appears
    this.surface.on('ready', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('hello', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('mode', (mode) => { this.logger?.info({ mode }, 'jetd mode'); this.#setActive(); });
    this.deviceLink.on('disconnected', () => { this.menu = null; this.#setActive(); });
    this.deviceLink.on('glance', (g) => { this.status.glance = { ...g, t: Date.now() }; this.status.invalidate(); });
    this.deviceLink.on('view', (v) => { this.status.view = { ...v, t: Date.now() }; this.status.invalidate(); });
    this.power.on('update', () => this.status.invalidate());
    this.input.on('gesture', (g) => this.#onGesture(g));
    this.show(this.status);
  }
  async stop() { this.screen?.onHide(); this.menu?.onHide(); }

  #setActive() { this.surface.active = this.deviceLink.connected && this.deviceLink.mode === 'remote' && this.surface.ready; }

  /** @param {Screen} screen */
  show(screen) {
    this.screen?.onHide();
    this.screen = screen;
    screen.onShow();
    this.logger?.info({ screen: screen.name }, 'screen');
    this.requestRender();
  }

  openMenu() {
    this.menu = new Menu(this, { title: 'jet-app', items: [
      { label: 'Status', action: () => { this.closeMenu(); this.show(this.status); } },
      { label: 'Camera', live: true },
      { label: 'Back to jetd remote', action: () => { this.closeMenu(); this.show(this.remote); } },
    ] });
    this.menu.onShow();
    this.requestRender();
  }
  closeMenu() { this.menu?.onHide(); this.menu = null; this.requestRender(); }

  #onGesture(gesture) {
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
    if (!this.surface.ready) return;
    const t0 = performance.now();
    this.surface.clear();
    (this.menu ?? this.screen).render(this.surface);
    const renderMs = +(performance.now() - t0).toFixed(2);
    const rect = this.surface.flush();
    this.logger?.debug({ renderMs, flushMs: +(performance.now() - t0 - renderMs).toFixed(2), rect }, 'render');
  }
}
