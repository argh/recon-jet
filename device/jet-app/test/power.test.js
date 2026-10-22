import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Median, roundTo } from '../src/modules/power/smooth.js';
import { Power } from '../src/modules/power/index.js';

const reading = (vbat, ma, extra = {}) => ({ vbat, vsys: 4012, vbus: 4893, ma, ctrl1: 0x8c, stat1: 0x4c, linsts: 0, cinlimit: 2, vichrg: 3, udc: 'configured', maxpower: 500, ...extra });

test('median window and rounding', () => {
  const m = new Median(3);
  assert.equal(m.value, null);
  assert.equal(m.push(10), 10);
  assert.equal(m.push(30), 20);          // even count: mean of the middle pair
  assert.equal(m.push(20), 20);
  assert.equal(m.push(100), 30);         // window of 3: [30, 20, 100]
  assert.equal(m.push(100), 100);
  m.reset(); assert.equal(m.value, null);
  assert.equal(roundTo(3987, 10), 3990);
  assert.equal(roundTo(3984, 10), 3980);
  assert.equal(roundTo(-118, 10), -120);
  assert.equal(roundTo(-125, 10), -120);
});

test('Power.ingest smooths battery mV/mA and rounds every rail', () => {
  const p = Object.assign(new Power(), { pollMs: 0, samples: 3, roundStep: 10, deviceLink: new EventEmitter() });
  p.start();
  assert.deepEqual(p.ingest(reading(3987, -118)), { vbat: 3990, ma: -120, vsys: 4010, vbus: 4890 });
  const s2 = p.ingest(reading(4012, -131));
  assert.deepEqual([s2.vbat, s2.ma], [4000, -120]);                              // middle pair means: 3999.5 -> 4000, -124.5 -> -120
  p.ingest(reading(3991, -122));
  assert.deepEqual([p.smoothed.vbat, p.smoothed.ma], [3990, -120]);
  p.ingest(reading(4300, 50));                                                   // one outlier does not move the median
  assert.deepEqual([p.smoothed.vbat, p.smoothed.ma], [4010, -120]);
  assert.equal(p.last.vbat, 4300);                                               // the raw reading is still there
});

test('Power polls only while jetd is in remote mode', async () => {
  const link = Object.assign(new EventEmitter(), { connected: true, mode: 'log', calls: 0, async power() { this.calls++; return reading(3900, -100); } });
  const p = Object.assign(new Power(), { pollMs: 5, samples: 8, roundStep: 10, deviceLink: link });
  const updates = []; p.on('update', (u) => updates.push(u));
  await p.start();
  await sleep(30);
  assert.equal(link.calls, 0);
  link.mode = 'remote';
  await sleep(30);
  assert.ok(link.calls >= 2 && updates.length === link.calls, `polled ${link.calls}, ${updates.length} updates`);
  assert.deepEqual(p.smoothed, { vbat: 3900, ma: -100, vsys: 4010, vbus: 4890 });
  await p.stop();
});
