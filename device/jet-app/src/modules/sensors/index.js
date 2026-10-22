// sensors: the last glance and new-view events from jetd, timestamped, for any screen that shows
// them (Status, Demo). Glance is an event (`g worn raw`), not display automation.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class Sensors extends EventEmitter {
  static moduleInfo = {
    name: 'sensors',
    schema: s().property('deviceLink', s('DeviceLink').meta('internal', true)),
  };
  deviceLink;
  /** @type {{worn: number, raw: number, t: number}|null} */ glance = null;
  /** @type {{degrees: number, t: number}|null} */ view = null;

  async start() {
    this.deviceLink.on('glance', (g) => { this.glance = { ...g, t: Date.now() }; this.emit('glance', this.glance); });
    this.deviceLink.on('view', (v) => { this.view = { ...v, t: Date.now() }; this.emit('view', this.view); });
  }
}
