// Pure calibration arithmetic (matches jetd's setup mode) and the Network screen's parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padThresholds, ofmArgs, glanceThresholds, glanceFile, backlightStep, PAD_STEPS, GLANCE_STEPS } from '../src/modes/system/calibration.js';
import { parseIpAddr, parseIwLink } from '../src/modes/system/network.js';
import { parseShow, parseDevices } from '../src/modes/system/bluetooth.js';

test('pad thresholds: median magnitude per direction, half the weaker direction per axis, clamped 8..60', () => {
  assert.deepEqual(PAD_STEPS.map((s) => s.dir), ['RIGHT', 'LEFT', 'DOWN', 'UP']);
  assert.deepEqual(padThresholds([[80, 90, 100], [-70, -60, -200], [-50, -40, -45], [60, 55, 58]]), { thrX: 35, thrY: 22 });   // medians 90, 70, 45, 58
  assert.deepEqual(padThresholds([[10, 11, 12], [-9, -9, -9], [300, 300, 300], [200, 200, 200]]), { thrX: 8, thrY: 60 }, 'clamped both ways');
  assert.deepEqual(padThresholds([[41, 41, 41], [41, 41, 41], [41, 41, 41], [41, 41, 41]]), { thrX: 20, thrY: 20 }, 'integer division');
  assert.equal(ofmArgs({ thrX: 41, thrY: 38 }), 'thr_x=41 thr_y=38\n');
});

test('glance thresholds: 60 % / 40 % of the span above the away level, either polarity, flat runs rejected', () => {
  assert.equal(GLANCE_STEPS.length, 4);
  let r = glanceThresholds([150, 230, 130, 230]);   // worn reads lower on this pod
  assert.deepEqual(r, { ok: true, at: 140, away: 230, span: -90, on: 176, off: 194 });
  assert.equal(glanceFile(r), '176 194\n');
  r = glanceThresholds([900, 700, 880, 720]);
  assert.deepEqual(r, { ok: true, at: 890, away: 710, span: 180, on: 818, off: 782 });
  r = glanceThresholds([700, 710, 705, 690]);
  assert.equal(r.ok, false); assert.equal(r.span, 2);
  assert.equal(glanceThresholds([740, 700, 740, 700]).ok, true, 'span 40 is the limit');
});

test('backlight steps', () => {
  assert.equal(backlightStep(208, 1), 256); assert.equal(backlightStep(208, -1), 160);
  assert.equal(backlightStep(1000, 1), 1023); assert.equal(backlightStep(30, -1), 16);
});

test('network parsers', () => {
  const json = JSON.stringify([
    { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }] },
    { ifname: 'usb0', addr_info: [{ family: 'inet', local: '10.42.0.1', prefixlen: 24 }, { family: 'inet6', local: 'fe80::1', prefixlen: 64 }] },
    { ifname: 'wlan0', addr_info: [] },
  ]);
  assert.deepEqual(parseIpAddr(json), { lo: ['127.0.0.1/8'], usb0: ['10.42.0.1/24'], wlan0: [] });
  assert.deepEqual(parseIpAddr(''), {});
  assert.deepEqual(parseIwLink('Connected to e2:63:da:22:3a:15 (on wlan0)\n\tSSID: fire swamp\n\tfreq: 2412\n\tsignal: -48 dBm\n'), { ssid: 'fire swamp', freq: '2412', signal: '-48 dBm' });
  assert.equal(parseIwLink('Not connected.\n'), null);
  assert.equal(parseIwLink(''), null);
});

test('bluetooth parsers', () => {
  assert.deepEqual(parseShow('Controller 84:7E:40:45:C5:C2 (public)\n\tName: BlueZ 5.66\n\tPowered: yes\n\tDiscoverable: no\n'), { address: '84:7E:40:45:C5:C2', powered: true });
  assert.deepEqual(parseShow('Controller 84:7E:40:45:C5:C2 (public)\n\tPowered: no\n'), { address: '84:7E:40:45:C5:C2', powered: false });
  assert.equal(parseShow('No default controller available\n'), null);
  assert.equal(parseShow(''), null);
  assert.deepEqual(parseDevices('Device D1:00:77:34:9F:55 K06 BLE Keyboard\nDevice C1:9A:1B:6E:42:97 Govee_H6093_4297\n'),
    [{ address: 'D1:00:77:34:9F:55', name: 'K06 BLE Keyboard' }, { address: 'C1:9A:1B:6E:42:97', name: 'Govee_H6093_4297' }]);
  assert.deepEqual(parseDevices(''), []);
});
