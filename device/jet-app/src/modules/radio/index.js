// radio: the Bluetooth radio (hci0) as a model. The stack (dbus + bluetoothd) runs from init
// with AutoEnable off, so the radio only comes up when asked: an up hci0 pins the wl1283's WiFi
// rx at 1 Mbit/s (coex untuned). `set(on)` flips it live (bluetoothctl) and makes that the boot
// default (the marker file init reads); GPS rides the same chip and its UART, so off stops the
// GPS daemon first (through the gps module). `refresh()` reads the controller and device lists
// for whoever shows them (the Bluetooth and Status screens); pairing itself stays bluetoothctl
// over ssh. `powerDown()` is the bare chip-off the gps module uses when GPS stops and Bluetooth
// is not wanted: power off, hci0 down, and a WiFi reassociate (the coex rate stays pinned until one).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

/** `bluetoothctl show` text -> { address, powered }, or null without a controller (bluetoothd down) */
export function parseShow(text) {
  const m = text.match(/^Controller (\S+)/m);
  return m ? { address: m[1], powered: /^\s*Powered:\s*yes/m.test(text) } : null;
}

/** `bluetoothctl devices [Connected|Paired]` lines -> [{ address, name }] */
export function parseDevices(text) {
  return [...text.matchAll(/^Device (\S+) (.*)$/gm)].map((m) => ({ address: m[1], name: m[2].trim() }));
}

export class Radio {
  static moduleInfo = {
    name: 'radio',
    schema: s()
      .property('btMarker', s('string').default('/android-data/mainline/bt').meta('description', 'exists = init powers the Bluetooth radio on at boot'))
      .property('gps', s('Gps').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  btMarker; gps; logger;

  /** @type {{address: string, powered: boolean}|null|undefined} undefined until the first refresh, null = no controller */
  controller;
  /** @type {{address: string, name: string}[]} */ connected = [];
  /** @type {{address: string, name: string}[]} */ paired = [];
  atBoot = false;   // the marker, as of the last refresh
  busy = false;     // a set() is switching

  /** Re-read the controller, the device lists and the boot marker. Never throws: a dev box has none of the tools. */
  async refresh() {
    this.controller = parseShow(await run('bluetoothctl', ['show']).catch(() => ''));
    this.connected = this.controller?.powered ? parseDevices(await run('bluetoothctl', ['devices', 'Connected']).catch(() => '')) : [];
    this.paired = this.controller ? parseDevices(await run('bluetoothctl', ['devices', 'Paired']).catch(() => '')) : [];
    this.atBoot = await this.wantedAtBoot();
    return this.controller;
  }

  /** The boot marker, read now (gps consults it as GPS goes down). */
  wantedAtBoot() { return fs.access(this.btMarker).then(() => true, () => false); }

  /** Radio on or off, live and at boot. Throws when it cannot (no controller, bluetoothctl failed). */
  async set(on) {
    if (this.busy) return;
    if (this.controller === undefined) await this.refresh();
    if (!this.controller) throw new Error('no bluetooth controller');
    this.busy = true;
    let failed = null;
    try {
      // GPS rides this radio: powering it off takes the GPS daemon down first
      if (!on && this.gps?.running) await this.gps.disable({ keepRadio: true }).then(() => this.logger?.info('gps stopped for radio off'), () => {});
      await run('bluetoothctl', ['power', on ? 'on' : 'off']);
      if (on) await fs.writeFile(this.btMarker, 'bluetooth radio on at boot (System > Bluetooth)\n');
      else await fs.rm(this.btMarker, { force: true });
      this.logger?.info({ on }, 'bluetooth radio');
    } catch (error) { failed = error; this.logger?.warn({ error: error.message }, 'bluetooth toggle failed'); }
    this.busy = false;
    await this.refresh();
    if (failed) throw failed;
  }

  /** The bare chip-off (no marker change): GPS stopped and Bluetooth not wanted. */
  async powerDown() {
    await run('bluetoothctl', ['power', 'off']).catch(() => {});   // radio down powers the chip off
    await run('hciconfig', ['hci0', 'down']).catch(() => {});      // belt and suspenders
    await run('wpa_cli', ['-i', 'wlan0', 'reassociate']).catch(() => {});   // the coex rate stays pinned at 1 Mbit/s until a reassociate
  }
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
