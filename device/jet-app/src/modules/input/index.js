// input: raw jetd key/motion events -> gestures. Emits 'press' {button}, 'hold' {button},
// 'swipe' {dir} and a catch-all 'gesture' with the name ('press:front', 'hold:front', 'swipe:up'...).
// Note: today's jetd forwards a button as a down/up pair at release and consumes the front
// hold itself (its mode chooser), so 'hold:*' only fires once jetd forwards raw keys.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;
const BUTTONS = { 86: 'front', 107: 'rear' };
const SWIPES = { 103: 'up', 108: 'down', 105: 'left', 106: 'right' };

export class Input extends EventEmitter {
  static moduleInfo = {
    name: 'input',
    schema: s()
      .property('holdMs', s('number').default(1000).meta('description', 'button hold threshold'))
      .property('swipeThreshold', s('number').default(20).meta('description', 'summed REL counts for a swipe from raw motion'))
      .property('swipeDedupeMs', s('number').default(300).meta('description', 'ignore a swipe key this soon after the same swipe from motion'))
      .property('tapCode', s('number').default(28).meta('description', 'evdev code the touchpad reports for a tap'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  holdMs; swipeThreshold; swipeDedupeMs; tapCode; deviceLink; logger;

  #down = new Map();     // button -> { t, timer }
  #lastSwipe = { dir: null, t: 0 };

  async start() {
    this.deviceLink.on('key', (k) => this.#onKey(k));
    this.deviceLink.on('rel', (r) => this.#onRel(r));
    this.deviceLink.on('disconnected', () => { for (const d of this.#down.values()) clearTimeout(d.timer); this.#down.clear(); });
  }
  async stop() { for (const d of this.#down.values()) clearTimeout(d.timer); }

  #gesture(kind, detail) {
    const name = `${kind}:${detail}`;
    this.logger?.info({ gesture: name }, 'gesture');
    this.emit(kind, kind === 'swipe' ? { dir: detail } : { button: detail });
    this.emit('gesture', name);
  }

  #onKey({ code, value }) {
    const button = BUTTONS[code];
    if (button) {
      if (value === 1 && !this.#down.has(button)) {
        const timer = setTimeout(() => { this.#down.set(button, { held: true }); this.#gesture('hold', button); }, this.holdMs);
        this.#down.set(button, { t: Date.now(), timer });
      } else if (value === 0 && this.#down.has(button)) {
        const d = this.#down.get(button); this.#down.delete(button); clearTimeout(d.timer);
        if (!d.held) this.#gesture('press', button);
      }
      return;
    }
    if (value !== 1) return;
    const dir = SWIPES[code];
    if (dir) {
      const dup = this.#lastSwipe.dir === dir && Date.now() - this.#lastSwipe.t < this.swipeDedupeMs;
      if (!dup) this.#gesture('swipe', dir);
      return;
    }
    if (code === this.tapCode) return this.#gesture('press', 'tap');
    this.logger?.debug({ code }, 'unmapped key');
  }

  // jet-ofm: x<0 left, y<0 down; the driver sends REL before its own swipe key, so remember it.
  #onRel({ dx, dy }) {
    const ax = Math.abs(dx), ay = Math.abs(dy), thr = this.swipeThreshold;
    let dir = null;
    if (ax > ay && ax >= thr) dir = dx < 0 ? 'left' : 'right';
    else if (ay > ax && ay >= thr) dir = dy < 0 ? 'down' : 'up';
    this.logger?.debug({ dx, dy, dir }, 'motion');
    if (!dir) return;
    this.#lastSwipe = { dir, t: Date.now() };
    this.#gesture('swipe', dir);
  }
}
