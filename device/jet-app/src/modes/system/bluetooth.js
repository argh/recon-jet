// Bluetooth screen: the View/Controller over two models — `radio` (hci0 power + boot marker) and
// `bluez` (the live HID device list + pairing). It owns no Bluetooth logic: it renders their state
// and routes gestures to their methods. A selectable list, row 0 the radio toggle and the rest the
// HID devices in range; front toggles the radio, pairs a new device, or removes a paired one.
// Discovery runs only while the screen shows (enter/leave), and only code-free keyboards pair (the
// agent is NoInputNoOutput) — one that wants a typed passkey fails with a clear note.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, heading, row, hint } from '../../modules/ui/style.js';

const s = Schema.create;
const REFRESH_TICKS = 5;

export class BluetoothScreen {
  static moduleInfo = {
    name: 'bluetooth-screen',
    provides: 'Screen',
    schema: s()
      .property('radio', s('Radio').meta('internal', true))
      .property('bluez', s('Bluez').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  radio; bluez; ui; logger;

  id = 'bluetooth'; label = 'Bluetooth';
  #sel = 0; #status = null; #busy = false; #ticks = 0;
  #onChange = () => this.ui.requestRender();

  enter() {
    this.#sel = 0; this.#status = null; this.#busy = false; this.#ticks = 0;
    this.bluez.on('change', this.#onChange);
    this.radio.refresh().then(() => { if (this.#on()) this.bluez.scan(true).catch(() => {}); this.ui.requestRender(); }, () => {});
  }
  leave() { this.bluez.off('change', this.#onChange); this.bluez.scan(false).catch(() => {}); }
  tick() { if (++this.#ticks % REFRESH_TICKS === 0) this.radio.refresh().then(() => this.ui.requestRender(), () => {}); }

  #on() { return this.radio.controller?.powered ?? false; }
  /** The rows: a radio toggle, then the HID devices (newest/connected first). */
  #rows() { return [{ radio: true }, ...this.bluez.list()]; }

  onGesture(g) {
    const n = this.#rows().length;
    if (g === 'swipe:up') { this.#sel = (this.#sel - 1 + n) % n; this.ui.requestRender(); return true; }
    if (g === 'swipe:down') { this.#sel = (this.#sel + 1) % n; this.ui.requestRender(); return true; }
    if (g === 'press:front' || g === 'press:tap') { this.#act(this.#rows()[Math.min(this.#sel, n - 1)]); return true; }
    return false;   // rear: System takes it back to the menu
  }

  async #act(sel) {
    if (this.#busy || !sel) return;
    if (sel.radio) return this.#toggleRadio();
    this.#busy = true; this.#status = `${sel.paired ? 'removing' : 'pairing'} ${sel.name}...`; this.ui.requestRender();
    try {
      if (sel.paired) { await this.bluez.remove(sel.address); this.#status = `removed ${sel.name}`; }
      else { await this.bluez.pair(sel.address); this.#status = `paired ${sel.name}`; }
      this.logger?.info({ action: sel.paired ? 'remove' : 'pair', address: sel.address, name: sel.name }, 'bt action');
    } catch (error) {
      this.#status = `${sel.paired ? 'remove' : 'pair'} failed: ${this.#why(error)}`;
      this.logger?.warn({ error: error.message, dbus: error.dbusName }, 'bt action');
    } finally { this.#busy = false; this.ui.requestRender(); }
  }

  #why(e) {
    const tag = `${e.dbusName || ''} ${e.message || ''}`;
    if (/AuthenticationFailed|Rejected|AuthenticationCanceled|Passkey|PinCode/i.test(tag)) return 'needs a passkey (unsupported)';
    return (e.message?.split(':').pop() || 'failed').trim().slice(0, 26);
  }

  async #toggleRadio() {
    if (this.radio.busy) return;
    const on = !this.#on();
    this.#busy = true; this.#status = null; this.ui.requestRender();
    try {
      await this.radio.set(on);
      this.ui.setStrip(`bluetooth ${on ? 'on' : 'off'}`, { colour: on ? C.warn : C.ok, ms: 1500 });
      await this.bluez.scan(on).catch(() => {});
    } catch (error) { this.#status = `radio: ${error.message}`; }
    finally { this.#busy = false; this.ui.requestRender(); }
  }

  render(sfc) {
    heading(sfc, 'bluetooth');
    const rows = this.#rows(), sel = Math.min(this.#sel, rows.length - 1), on = this.#on();
    let y = TOP + 24;
    y = this.#line(sfc, y, sel === 0, 'radio', this.radio.busy ? 'switching...' : on ? 'ON  (WiFi degraded)' : 'off', on ? C.warn : C.ok);
    y = row(sfc, y, 'at boot', this.radio.atBoot ? 'on' : 'off', C.dim);
    y += 3;
    if (!on) row(sfc, y, '', 'turn the radio on to find keyboards', C.dim);
    else if (rows.length === 1) row(sfc, y, '', this.bluez.ready ? 'scanning for keyboards...' : 'bluetooth unavailable', C.dim);
    else for (let i = 1; i < rows.length; i++) {
      const d = rows[i];
      const tag = d.connected ? 'connected' : d.paired ? 'paired' : d.rssi != null ? `${d.rssi} dBm` : 'new';
      y = this.#line(sfc, y, sel === i, d.name, tag, d.connected ? C.ok : d.paired ? C.white : C.dim);
    }
    if (this.#status) this.#line(sfc, sfc.height - 2 * (sfc.fonts.small.height + 1) - 10, false, '', this.#status, /failed/.test(this.#status) ? C.bad : C.ok);
    const cur = rows[sel];
    const action = cur?.radio ? (on ? 'radio off' : 'radio on') : cur?.paired ? 'remove' : 'pair';
    hint(sfc, `swipe: move   front: ${action}   rear: back`);
  }

  /** One list row with a selection bar. */
  #line(sfc, y, selected, label, value, colour) {
    const { small } = sfc.fonts;
    if (selected) sfc.fillRect(0, y - 1, sfc.width, small.height + 2, C.panel);
    sfc.text(MARGIN, y, label, { font: small, colour: selected ? C.white : C.dim });
    sfc.text(sfc.width - MARGIN, y, value, { font: small, colour, align: 'right', maxWidth: sfc.width - 2 * MARGIN - 70 });
    return y + small.height + 1;
  }
}
