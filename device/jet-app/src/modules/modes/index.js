// modes: the mode registry and switcher, the one owner of the panel after boot.
//
// A mode is a plugin `{ id, label, enter(ctx), leave(), onGesture(g) -> handled, render(s),
// tick?() }` (docs/interaction-design.md). Mode modules register themselves here in their
// `start()` (public ones live in src/modes/*, private ones come from personal/index.js); the
// switcher lists them in registration order. `begin()` (called once every module has started)
// enters the start mode: a mode asking for first use (`firstUse()` true) wins, then the mode
// persisted in the state file, then `ui.defaultMode`, then the first registered. Until then the
// Log mode (always registered) is what the panel shows, so the boot log continues seamlessly.
//
// Gestures (raw keys through `input`): one tree, rear ascends it. Rear press is "back" inside
// the mode; at a mode's root (its `onGesture` does not consume it) rear opens the switcher, and
// rear in the switcher returns to the mode — so rear-rear-rear always escapes anything. Front
// hold is the shortcut straight to the switcher from anywhere (and closes it again); swipe
// up/down moves, front press (or a pad tap) picks. Nothing fires on a release.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { Chooser } from '../ui/chooser.js';
import { readState, writeState } from './state.js';

const s = Schema.create;

/**
 * @typedef {object} Mode
 * @property {string} id
 * @property {string} label
 * @property {(ctx: {wizard: boolean}) => void} [enter]
 * @property {() => void} [leave]
 * @property {(gesture: string) => boolean} [onGesture]  true when consumed
 * @property {(s: import('../surface/index.js').Surface) => void} render
 * @property {() => void} [tick]  once per `tickMs` while current
 * @property {() => Promise<boolean>|boolean} [firstUse]  true: start here, as a wizard
 * @property {boolean} [transient]  never persisted as the start mode (e.g. jetd's shell)
 * @property {string[]} [spoken]  other names "heya jet, open <name>" accepts besides the id and label ("settings", "console")
 * @property {() => string|null} [unavailable]  why the mode cannot be entered right now (e.g. its data is missing): listed disabled in the switcher with that reason, switchTo refuses
 */

export class Modes extends EventEmitter {
  static moduleInfo = {
    name: 'modes',
    schema: s()
      .property('stateFile', s('string').default('/android-data/mainline/jet-app-state.json').meta('description', 'persisted app state (last mode)'))
      .property('tickMs', s('number').default(1000).meta('description', 'mode tick / clock interval'))
      .property('bootMode', s('string').default('log').meta('description', 'mode shown until the start mode is entered'))
      .property('ui', s('Ui').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  stateFile; tickMs; bootMode; ui; input; deviceLink; actions; logger;

  /** @type {Mode[]} in registration order */ list = [];
  /** @type {Mode|null} */ current = null;
  /** @type {Chooser|null} the switcher overlay while open */ switcher = null;
  /** @type {Promise<void>|null} the state write in flight (tests await it) */ saving = null;
  #timer = null;
  #began = false;

  async start() {
    this.ui.root = this;
    this.input.on('gesture', (g) => this.#onGesture(g));
    // "heya jet, open settings": a mode by id, label or one of its `spoken` names; a name that is
    // no mode is declined so a mode's own "open <screen>" command can take it
    this.actions?.register('open', /^open (?:the )?(\w+)$/, (m) => {
      const mode = this.spoken(m[1]);
      if (!this.switchTo(mode.id)) throw new Error(`${mode.label ?? mode.id}: ${mode.unavailable?.() ?? 'unavailable'}`);
    }, { when: (m) => Boolean(this.spoken(m[1])) });
  }

  /** The mode a spoken name means: its id, its label, or one of its `spoken` aliases. */
  spoken(name) {
    return this.list.find((x) => x.id === name || (x.label ?? '').toLowerCase() === name || x.spoken?.includes(name)) ?? null;
  }
  async stop() { clearInterval(this.#timer); this.current?.leave?.(); }

  /** @param {Mode} mode */
  register(mode) {
    if (!mode?.id || typeof mode.render !== 'function') throw new Error('a mode needs an id and a render()');
    if (this.list.some((m) => m.id === mode.id)) throw new Error(`mode ${mode.id} registered twice`);
    this.list.push(mode);
    this.logger?.info({ mode: mode.id, label: mode.label }, 'mode registered');
    if (!this.current) this.ui.requestRender();
    return this;
  }
  get(id) { return this.list.find((m) => m.id === id) ?? null; }

  /** Enter the start mode (once, after every module has started and registered). */
  async begin() {
    if (this.#began) return;
    this.#began = true;
    const persisted = (await readState(this.stateFile)).mode;
    const wizard = this.list.find((m) => m.firstUse) ? (await Promise.all(this.list.map(async (m) => (await m.firstUse?.()) ? m : null))).find(Boolean) : null;
    const start = wizard ?? this.get(persisted) ?? this.get(this.ui.defaultMode) ?? this.list[0] ?? null;
    this.logger?.info({ persisted, defaultMode: this.ui.defaultMode, wizard: wizard?.id ?? null, start: start?.id ?? null }, 'start mode');
    if (start) this.switchTo(start.id, { wizard: !!wizard, persist: false });
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#tick(), this.tickMs);
    this.#timer.unref?.();
  }

  /**
   * Make `id` the current mode: the old one leaves, the new one enters, the choice is persisted.
   * @returns {boolean} false when no such mode, or it is unavailable
   */
  switchTo(id, { wizard = false, persist = true } = {}) {
    const mode = this.get(id);
    if (!mode) return false;
    const why = mode.unavailable?.();
    if (why) { this.logger?.info({ mode: id, why }, 'mode unavailable'); return false; }
    if (mode === this.current) mode.reselect?.();   // picking the current mode again: an opt-in re-entry (the shell reopens its pty view)
    if (mode !== this.current) {
      this.current?.leave?.();
      this.current = mode;
      this.logger?.info({ mode: id, wizard }, 'mode');
      mode.enter?.({ wizard });
      this.emit('mode', mode);
      if (persist && !mode.transient) this.saving = writeState(this.stateFile, { mode: id }).then(() => {}, (error) => this.logger?.warn({ error: error.message, file: this.stateFile }, 'state not saved'));
    }
    this.ui.requestRender();
    return true;
  }

  openSwitcher() {
    if (this.switcher) return;
    this.switcher = new Chooser({ title: 'MODE', items: this.list.map((m) => { const why = m.unavailable?.() ?? null; return { id: m.id, label: why ? `${m.label ?? m.id}  ${why}` : m.label ?? m.id, disabled: !!why }; }), hint: 'swipe: move   front: pick   rear: cancel' });
    if (this.current) this.switcher.select(this.current.id);
    this.logger?.info('switcher open');
    this.emit('switcher', true);
    this.ui.requestRender();
  }
  closeSwitcher() {
    if (!this.switcher) return;
    this.switcher = null;
    this.logger?.info('switcher closed');
    this.emit('switcher', false);
    this.ui.requestRender();
  }

  #onGesture(gesture) {
    if (this.deviceLink.mode !== 'remote') return;   // jetd's own screens keep their keys
    if (gesture === 'hold:front') { if (this.switcher) this.closeSwitcher(); else this.openSwitcher(); return; }
    if (this.switcher) {
      switch (gesture) {
        case 'swipe:up': this.switcher.move(-1); break;
        case 'swipe:down': this.switcher.move(1); break;
        case 'press:front': case 'press:tap': { const it = this.switcher.item; if (it?.disabled) return; this.closeSwitcher(); if (it) this.switchTo(it.id); return; }
        case 'press:rear': this.closeSwitcher(); return;
        default: return;
      }
      this.ui.requestRender();
      return;
    }
    const handled = this.current?.onGesture?.(gesture) ?? false;
    if (!handled && gesture === 'press:rear') { this.openSwitcher(); return; }   // at the mode's root: ascend
    this.logger?.debug({ gesture, mode: this.current?.id, handled }, 'mode gesture');
  }

  #tick() {
    if (!this.ui.active) return;
    try { this.current?.tick?.(); } catch (error) { this.logger?.warn({ error: error.message, mode: this.current?.id }, 'tick failed'); }
    this.ui.requestRender();
  }

  /** The system layer's root: the current mode (the boot mode until one is entered), then the switcher. */
  render(surface) {
    const mode = this.current ?? this.get(this.bootMode) ?? this.list[0];
    try { mode?.render(surface); } catch (error) { this.logger?.warn({ error: error.message, mode: mode?.id }, 'render failed'); }
    this.switcher?.render(surface);
  }
}
