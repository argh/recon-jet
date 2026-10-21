import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolParser, parsePower } from '../src/modules/device-link/parser.js';

test('lines split across chunks', () => {
  const p = new ProtocolParser();
  assert.deepEqual(p.feed(Buffer.from('h 428 240 42')), []);
  assert.deepEqual(p.feed(Buffer.from(' 12\nk 86 1\n')), [{ type: 'line', line: 'h 428 240 42 12' }, { type: 'line', line: 'k 86 1' }]);
});

test('binary payload after f and a', () => {
  const p = new ProtocolParser();
  const frame = Buffer.from([1, 2, 3, 4]);
  const out = p.feed(Buffer.concat([Buffer.from('f 2 1 UYVY 4\n'), frame.subarray(0, 2)]));
  assert.deepEqual(out, []);
  const rest = p.feed(Buffer.concat([frame.subarray(2), Buffer.from('a 2\nxyp\n')]));
  assert.equal(rest[0].type, 'frame'); assert.equal(rest[0].w, 2); assert.deepEqual(rest[0].data, frame);
  assert.equal(rest[1].type, 'audio'); assert.equal(rest[1].data.toString(), 'xy');
  assert.deepEqual(rest[2], { type: 'line', line: 'p' });
});

test('power snapshot parses', () => {
  const q = parsePower('3987 4012 4890 -120 0x8c 0x4c 0x00 0x02 0x03 configured 500'.split(' '));
  assert.equal(q.vbat, 3987); assert.equal(q.ma, -120); assert.equal(q.ctrl1, 0x8c); assert.equal(q.udc, 'configured'); assert.equal(q.maxpower, 500);
});
