// input: raw jetd key/motion events -> gestures. Emits 'press' {button}, 'hold' {button},
// 'swipe' {dir} and a catch-all 'gesture' with the name ('press:front', 'hold:front', 'swipe:up'...).
//
// Raw keys: on connect this sends `K 1`, so jetd forwards every down/up as it happens (remote
// mode only) and leaves its own front-hold chooser off; `K 0` goes out when the run is aborted.
// Hold detection works from the real down/up timing: a button down starts a timer that fires
// 'hold' while the button is still held after `holdMs`; a release before that is a 'press'.
// Key events may carry a timestamp `t` (ms); the release decides press vs hold from
// `t_up - t_down`, so a late timer (or a replayed stream) still classifies correctly.
// Outside remote mode jetd keeps the keys, so a stray up (the release of the press that chose
// "remote" in jetd's chooser) arrives without its down and is ignored.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;
export const BUTTONS = { 86: 'front', 107: 'rear' };
export const SWIPES = { 103: 'up', 108: 'down', 105: 'left', 106: 'right' };

export class Input extends EventEmitter {
  static moduleInfo = {
    name: 'input',
    schema: s()
      .property('holdMs', s('number').default(1000).meta('description', 'button hold threshold'))
      .property('swipeThreshold', s('number').default(20).meta('description', 'summed REL counts for a swipe from raw motion'))
      .property('swipeDedupeMs', s('number').default(300).meta('description', 'ignore a swipe key this soon after the same swipe from motion'))
      .property('tapCode', s('number').default(28).meta('description', 'evdev code the touchpad reports for a tap'))
      .property('rawKeys', s('boolean').default(true).meta('description', 'ask jetd for raw key events (K 1) on connect'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  holdMs; swipeThreshold; swipeDedupeMs; tapCode; rawKeys; deviceLink; logger;

  /** Clock for events without their own `t` (overridable in tests). */
  now = () => Date.now();
  #down = new Map();     // button -> { t, timer, held }
  #lastSwipe = { dir: null, t: 0 };

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
  #reset() { for (const d of this.#down.values()) clearTimeout(d.timer); this.#down.clear(); }

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
    const button = BUTTONS[code];
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
    if (dir) {
      const dup = this.#lastSwipe.dir === dir && t - this.#lastSwipe.t < this.swipeDedupeMs;
      if (!dup) this.#gesture('swipe', dir);
      return;
    }
    if (code === this.tapCode) return this.#gesture('press', 'tap');
    this.logger?.debug({ code }, 'unmapped key');
  }

  // jet-ofm: x<0 left, y<0 down; the driver sends REL before its own swipe key, so remember it.
  #onRel({ dx, dy, t = this.now() }) {
    const ax = Math.abs(dx), ay = Math.abs(dy), thr = this.swipeThreshold;
    let dir = null;
    if (ax > ay && ax >= thr) dir = dx < 0 ? 'left' : 'right';
    else if (ay > ax && ay >= thr) dir = dy < 0 ? 'down' : 'up';
    this.logger?.debug({ dx, dy, dir }, 'motion');
    if (!dir) return;
    this.#lastSwipe = { dir, t };
    this.#gesture('swipe', dir);
  }
}
