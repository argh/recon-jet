// Bluetooth: a view over the radio module (hci0 on or off, live and for the next boot; the
// device lists; the WiFi coex warning). On for a keyboard while on the USB link, off to use WiFi
// unplugged. Front toggles (and "heya jet, enable bluetooth" sets); the screen lists connected
// and paired devices. Pairing itself is still bluetoothctl over ssh.
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

const s = Schema.create;
const REFRESH_TICKS = 5;

export class BluetoothScreen {
  static moduleInfo = {
    name: 'bluetooth-screen',
    provides: 'Screen',
    schema: s()
      .property('radio', s('Radio').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true)),
  };
  radio; ui;

  id = 'bluetooth'; label = 'Bluetooth';
  error = null;
  #ticks = 0;

  enter() { this.#ticks = 0; this.refresh(); }
  tick() { if (++this.#ticks % REFRESH_TICKS === 0) this.refresh(); }
  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.toggle(); return true; }
    return false;
  }

  async refresh() { await this.radio.refresh(); this.ui.requestRender(); }

  /** Flip the radio and make that the boot default. */
  toggle() { if (this.radio.controller) this.set(!this.radio.controller.powered).catch(() => {}); }

  /** Radio on or off, live and at boot. Rejects, after showing why, when it cannot: a spoken command reports that. */
  async set(on) {
    if (this.radio.busy) return;
    this.error = null;
    this.ui.requestRender();
    try {
      await this.radio.set(on);
      this.ui.setStrip(`bluetooth ${on ? 'on' : 'off'}`, { colour: on ? C.warn : C.ok, ms: 2000 });
    } catch (error) { this.error = error.message; this.ui.requestRender(); throw error; }
    this.ui.requestRender();
  }

  render(s) {
    heading(s, 'bluetooth');
    let y = TOP + 26;
    const { controller, busy, atBoot, connected, paired } = this.radio;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    if (controller === null) { row(s, y, 'radio', 'no controller (bluetoothd down?)', C.dim); hint(s, 'rear: menu'); return; }
    const on = controller?.powered ?? false;
    y = row(s, y, 'radio', busy ? 'switching...' : on ? 'ON  (WiFi rx degraded)' : 'off', busy ? C.dim : on ? C.warn : C.ok);
    y = row(s, y, 'at boot', atBoot ? 'on' : 'off');
    y += 4;
    if (connected.length) for (const d of connected) y = row(s, y, 'connected', d.name, C.ok);
    else y = row(s, y, 'connected', on ? 'nothing' : '-', C.dim);
    row(s, y, 'paired', paired.length ? paired.map((d) => d.name).join(', ') : 'none (pair over ssh)', C.dim);
    hint(s, `front: radio ${on ? 'off' : 'on'}   rear: menu`);
  }
}
