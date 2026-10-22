// ui: the system layer of the screen. It schedules renders (at most one per tick), draws only
// while jetd's remote mode is showing with the surface acquired, paints the `root` (the mode
// registry: the current mode plus the switcher overlay) and then the 10 px status strip along
// the top (link/voice indicators, transient notices). It owns no screens of its own: every
// screen after boot belongs to a mode (src/modes/*), reached through the switcher.
import { Schema } from '@versionzero/module-manager';
import { C, STRIP_H } from './style.js';

const s = Schema.create;

export class Ui {
  static moduleInfo = {
    name: 'ui',
    schema: s()
      .property('defaultMode', s('string').default('').meta('description', 'mode id to start in when nothing is persisted (empty: the first registered)'))
      .property('surface', s('Surface').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  defaultMode; surface; deviceLink; logger;

  /** @type {{render(s: import('../surface/index.js').Surface): void}|null} what fills the panel under the strip */ root = null;
  /** @type {{text: string, colour: number}|null} the system strip along the top, over any screen */ strip = null;
  #pending = false;
  #stripTimer = null;
  renders = 0;   // flushed frames (diagnostics, tests)

  async start() {
    // the surface is acquired on connect; jetd sends a fresh hello whenever remote mode (re)appears
    this.surface.on('ready', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('hello', () => { this.#setActive(); this.requestRender(); });
    this.deviceLink.on('mode', (mode) => { this.logger?.info({ mode }, 'jetd mode'); this.#setActive(); });
    this.deviceLink.on('disconnected', () => this.#setActive());
    this.#setActive();   // the surface may already be up (jetd connected before we started)
  }
  async stop() { clearTimeout(this.#stripTimer); }

  /** jetd is in remote mode, connected, and we hold the pixels: the only time anything is drawn. */
  get active() { return this.surface.active; }

  /**
   * The 10 px status strip along the top (listening/looking indicator, transient notices).
   * `null` clears it; `ms` makes it a notice that clears itself.
   */
  setStrip(text, { colour = C.ok, ms = 0 } = {}) {
    clearTimeout(this.#stripTimer); this.#stripTimer = null;
    this.strip = text ? { text, colour } : null;
    if (text && ms > 0) { this.#stripTimer = setTimeout(() => { this.strip = null; this.requestRender(); }, ms); this.#stripTimer.unref?.(); }
    this.requestRender();
  }

  #setActive() { this.surface.active = this.deviceLink.connected && this.deviceLink.mode === 'remote' && this.surface.ready; }

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
    this.root?.render(this.surface);
    if (this.strip) {   // the small font is 12 px: drawn one row up, its blank top row falls off the panel
      this.surface.fillRect(0, 0, this.surface.width, STRIP_H, C.panel);
      this.surface.text(4, -1, this.strip.text, { font: this.surface.fonts.small, colour: this.strip.colour, maxWidth: this.surface.width - 8 });
    }
    const renderMs = +(performance.now() - t0).toFixed(2);
    const rect = this.surface.flush();
    this.renders++;
    this.logger?.debug({ renderMs, flushMs: +(performance.now() - t0 - renderMs).toFixed(2), rect }, 'render');
  }
}
