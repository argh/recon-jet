// power: polls jetd's `Q` snapshot while connected and keeps the last reading.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class Power extends EventEmitter {
  static moduleInfo = {
    name: 'power',
    schema: s()
      .property('pollMs', s('number').default(2000).meta('description', 'power snapshot interval (0 disables)'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  pollMs; deviceLink; logger;
  /** @type {object|null} last `q` reading plus `t` */ last = null;
  #timer = null;

  async start() {
    this.deviceLink.on('connected', () => this.#schedule(0));
    this.deviceLink.on('disconnected', () => clearTimeout(this.#timer));
    if (this.deviceLink.connected) this.#schedule(0);
  }
  async stop() { clearTimeout(this.#timer); }

  #schedule(ms) {
    clearTimeout(this.#timer);
    if (this.pollMs > 0) this.#timer = setTimeout(() => this.#poll(), ms);
  }

  async #poll() {
    try {
      this.last = { ...(await this.deviceLink.power()), t: Date.now() };
      this.emit('update', this.last);
    } catch (error) {
      this.logger?.debug({ error: error.message }, 'power poll failed');
    }
    if (this.deviceLink.connected) this.#schedule(this.pollMs);
  }
}
