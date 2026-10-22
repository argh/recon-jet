import test from 'node:test';
import assert from 'node:assert/strict';
import { openCircuitVoltage, percentFromOcv, stateOfCharge } from '../src/modules/power/soc.js';

test('soc: the open-circuit estimate removes the charger step', () => {
  const charging = openCircuitVoltage(4000, 280, 0.25);     // reads 4.00 V while pushing 280 mA
  const unplugged = openCircuitVoltage(3860, -360, 0.25);   // reads 3.86 V while drawing 360 mA
  assert.ok(Math.abs(charging - unplugged) < 30, `${charging} vs ${unplugged}`);
});

test('soc: curve is monotonic and anchored', () => {
  assert.equal(percentFromOcv(3200), 0);
  assert.equal(percentFromOcv(4200), 100);
  let last = -1;
  for (let v = 3300; v <= 4200; v += 10) { const p = percentFromOcv(v); assert.ok(p >= last); last = p; }
  assert.ok(percentFromOcv(3740) >= 45 && percentFromOcv(3740) <= 55);
});

test('soc: full only when the charger has tapered near the top', () => {
  assert.equal(stateOfCharge({ vbat: 4150, ma: 10, vbus: 5000 }).full, true);
  assert.equal(stateOfCharge({ vbat: 4150, ma: 300, vbus: 5000 }).full, false);
  assert.equal(stateOfCharge({ vbat: 4150, ma: 10, vbus: 0 }).full, false);
});
