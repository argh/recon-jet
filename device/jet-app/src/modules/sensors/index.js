// sensors: the last glance and new-view events from jetd, timestamped, for any screen that shows
// them (Status, Describe). The wear module turns glance into display power; this just records it.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class Sensors extends EventEmitter {
  static moduleInfo = {
    name: 'sensors',
    schema: s().property('deviceLink', s('DeviceLink').meta('internal', true)),
  };
  deviceLink;
  /** @type {{worn: number, raw: number, t: number}|null} the eye is at the glass */ glance = null;
  /** @type {{worn: number, raw: number, t: number}|null} the glasses are on a head */ worn = null;
  /** @type {{degrees: number, t: number}|null} */ view = null;

  async start() {
    this.deviceLink.on('glance', (g) => { this.glance = { ...g, t: Date.now() }; this.emit('glance', this.glance); });
    this.deviceLink.on('worn', (o) => { this.worn = { ...o, t: Date.now() }; this.emit('worn', this.worn); });
    this.deviceLink.on('view', (v) => { this.view = { ...v, t: Date.now() }; this.emit('view', this.view); });
  }
}
