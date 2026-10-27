// input: raw jetd key/motion events -> gestures. Emits 'press' {button}, 'hold' {button},
// 'swipe' {dir}, a catch-all 'gesture' with the name ('press:front', 'hold:front', 'swipe:up'...)
// and 'motion' {dx, dy, t} for the touchpad's raw REL sums (no gesture is derived from those).
//
// Raw keys: on connect this sends `K 1`, so jetd forwards every down/up as it happens (remote
// mode only) and leaves its own front-hold chooser off; `K 0` goes out when the run is aborted.
// Hold detection works from the real down/up timing: a button down starts a timer that fires
// 'hold' while the button is still held after `holdMs`; a release before that is a 'press'.
// Key events may carry a timestamp `t` (ms); the release decides press vs hold from
// `t_up - t_down`, so a late timer (or a replayed stream) still classifies correctly.
// Outside remote mode jetd keeps the keys, so a stray up (the release of the press that chose
// "remote" in jetd's chooser) arrives without its down and is ignored.
//
// Swipes come from the touchpad driver's swipe keys only, on the key DOWN (value 1): jetd also
// forwards the summed motion (`r dx dy`) for the same gesture, and the driver can emit two keys
// from one long swipe, so motion is logged and re-emitted but never navigates, and a second
// swipe within `swipeDebounceMs` of the previous one is dropped.
//
// A keyboard (jetd forwards its keys in remote mode like any other) navigates without the pod:
// Enter = front (held = front hold, the switcher), Esc/Backspace = rear, arrows = the swipe keys
// already (same evdev codes). Enter wins over a pad tap configured with the same code (28): the
// two mean the same thing everywhere.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;
export const BUTTONS = { 86: 'front', 107: 'rear' };
export const SWIPES = { 103: 'up', 108: 'down', 105: 'left', 106: 'right' };
/** keyboard aliases for the pod buttons: KEY_ENTER, KEY_KPENTER -> front; KEY_ESC, KEY_BACKSPACE -> rear */
export const KEYBOARD = { 28: 'front', 96: 'front', 1: 'rear', 14: 'rear' };

export class Input extends EventEmitter {
  static moduleInfo = {
    name: 'input',
    schema: s()
      .property('holdMs', s('number').default(1000).meta('description', 'button hold threshold'))
      .property('swipeDebounceMs', s('number').default(250).meta('description', 'ignore a swipe this soon after the previous one'))
      .property('tapCode', s('number').default(28).meta('description', 'evdev code the touchpad reports for a tap'))
      .property('rawKeys', s('boolean').default(true).meta('description', 'ask jetd for raw key events (K 1) on connect'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  holdMs; swipeDebounceMs; tapCode; rawKeys; deviceLink; logger;

  /** Clock for events without their own `t` (overridable in tests). */
  now = () => Date.now();
  #down = new Map();     // button -> { t, timer, held }
  #lastSwipeT = -Infinity;

  /** @param {AbortController} [abort] the app's run controller: aborted before any module stops */
  async start(abort) {
    this.deviceLink.on('connected', () => this.#onConnected());
    this.deviceLink.on('key', (k) => this.#onKey(k));
    this.deviceLink.on('rel', (r) => this.#onRel(r));
    this.deviceLink.on('disconnected', () => this.#reset());
    if (this.deviceLink.connected) this.#onConnected();
    abort?.signal.addEventListener('abort', () => this.#setRawKeys(false), { once: true });
  }
  async stop() { this.#reset(); }   // K 0 already went out on abort, before the link closed

  #onConnected() { this.#reset(); if (this.rawKeys) this.#setRawKeys(true); }
  #setRawKeys(on) {
    if (!this.rawKeys || !this.deviceLink.connected) return;
    if (this.deviceLink.send(`K ${on ? 1 : 0}`)) this.logger?.info({ on }, 'raw keys');
  }
  #reset() {
    for (const d of this.#down.values()) clearTimeout(d.timer);
    this.#down.clear();
    this.#lastSwipeT = -Infinity;
  }

  #gesture(kind, detail) {
    const name = `${kind}:${detail}`;
    this.logger?.info({ gesture: name }, 'gesture');
    this.emit(kind, kind === 'swipe' ? { dir: detail } : { button: detail });
    this.emit('gesture', name);
  }

  #hold(button) {
    const d = this.#down.get(button);
    if (!d || d.held) return;
    d.held = true; clearTimeout(d.timer);
    this.#gesture('hold', button);
  }

  /** @param {{code: number, value: number, t?: number}} k */
  #onKey({ code, value, t = this.now() }) {
    this.logger?.debug({ code, value, at: t }, 'key');
    const button = BUTTONS[code] ?? KEYBOARD[code];
    if (button) {
      if (value === 1 && !this.#down.has(button)) {
        const timer = setTimeout(() => this.#hold(button), Math.max(0, this.holdMs - (this.now() - t)));
        timer.unref?.();
        this.#down.set(button, { t, timer, held: false });
      } else if (value === 0 && this.#down.has(button)) {
        const d = this.#down.get(button);
        if (!d.held && t - d.t >= this.holdMs) this.#hold(button);   // the timer lagged the stream
        this.#down.delete(button); clearTimeout(d.timer);
        if (!d.held) this.#gesture('press', button);
      }
      return;
    }
    if (value !== 1) return;
    const dir = SWIPES[code];
    if (dir) return this.#swipe(dir, t);
    if (code === this.tapCode) return this.#gesture('press', 'tap');   // only when tapCode is not a keyboard alias (28 is Enter: a front press)
    this.logger?.debug({ code }, 'unmapped key');
  }

  #swipe(dir, t) {
    const sinceMs = t - this.#lastSwipeT;
    if (sinceMs < this.swipeDebounceMs) { this.logger?.debug({ dir, sinceMs }, 'swipe debounced'); return; }
    this.#lastSwipeT = t;
    this.#gesture('swipe', dir);
  }

  // jet-ofm: x<0 left, y<0 down. Logged and re-emitted for diagnosis and future uses; the
  // driver's swipe key for the same gesture is what navigates.
  #onRel({ dx, dy, t = this.now() }) {
    this.logger?.debug({ dx, dy, at: t }, 'motion');
    this.emit('motion', { dx, dy, t });
  }
}
