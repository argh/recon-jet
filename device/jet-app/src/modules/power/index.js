// power: polls jetd's `Q` snapshot while connected and in remote mode (jetd's own setup/power
// page reads the PMIC itself; we stay quiet there), keeps the last reading and a smoothed view
// for display: a median over the last `samples` polls of battery mV and mA, every mV/mA figure
// rounded to `roundStep`, so the readout does not jump between polls.
import { stateOfCharge } from './soc.js';
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { Median, roundTo } from './smooth.js';

const s = Schema.create;

export class Power extends EventEmitter {
  static moduleInfo = {
    name: 'power',
    schema: s()
      .property('pollMs', s('number').default(2000).meta('description', 'power snapshot interval (0 disables)'))
      .property('samples', s('number').default(8).meta('description', 'median window for the smoothed battery readout'))
      .property('internalOhms', s('number').default(0.25).meta('description', 'cell + path resistance for the open-circuit voltage estimate'))
      .property('termMa', s('number').default(40).meta('description', 'charge current below which a charging cell near 4.1 V counts as full'))
      .property('roundStep', s('number').default(10).meta('description', 'display rounding for mV and mA'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  pollMs; samples; internalOhms; termMa; roundStep; deviceLink; logger;
  /** @type {object|null} last `q` reading plus `t` */ last = null;
  /** @type {{vbat:number, ma:number, vsys:number, vbus:number}|null} rounded medians for display */ smoothed = null;
  /** @type {{percent:number, ocv:number, full:boolean, charging:boolean}|null} voltage-based estimate */ soc = null;
  #vbat; #ma;
  #timer = null;

  async start() {
    this.#vbat = new Median(this.samples); this.#ma = new Median(this.samples);
    this.deviceLink.on('connected', () => { this.#reset(); this.#schedule(0); });
    this.deviceLink.on('disconnected', () => clearTimeout(this.#timer));
    if (this.deviceLink.connected) this.#schedule(0);
  }
  async stop() { clearTimeout(this.#timer); }

  #reset() { this.#vbat.reset(); this.#ma.reset(); this.smoothed = null; this.soc = null; }

  #schedule(ms) {
    clearTimeout(this.#timer);
    if (this.pollMs > 0) this.#timer = setTimeout(() => this.#poll(), ms);
  }

  /** Fold one reading into the window; returns the display values. Exposed for tests. */
  ingest(p) {
    const r = this.roundStep;
    this.last = p;
    this.smoothed = { vbat: roundTo(this.#vbat.push(p.vbat), r), ma: roundTo(this.#ma.push(p.ma), r), vsys: roundTo(p.vsys, r), vbus: roundTo(p.vbus, r) };
    this.soc = stateOfCharge(this.smoothed, { ohms: this.internalOhms, termMa: this.termMa });
    return this.smoothed;
  }

  async #poll() {
    if (this.deviceLink.mode === 'remote') {
      try {
        this.ingest({ ...(await this.deviceLink.power()), t: Date.now() });
        this.emit('update', this.last);
      } catch (error) {
        this.logger?.debug({ error: error.message }, 'power poll failed');
      }
    }
    if (this.deviceLink.connected) this.#schedule(this.pollMs);
  }
}
