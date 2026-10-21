import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../src/modules/display/grid.js';
import { wrap, spread } from '../src/modules/display/layout.js';
import { Display } from '../src/modules/display/index.js';

test('diff reports changed rows only', () => {
  const a = new Grid(42, 12).set(0, 'hello').set(3, 'x', { colour: [1, 2, 3] });
  const b = a.clone().set(3, 'x', { colour: [1, 2, 4] }).set(5, 'new');
  assert.deepEqual(b.diff(a), [3, 5]);
  assert.equal(new Grid(42, 12).diff(null).length, 12);
});

test('wrap and spread', () => {
  assert.deepEqual(wrap('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
  assert.deepEqual(wrap('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.equal(spread('a', 'b', 6), 'a    b');
});

test('flush sends only changed rows, full redraw after hello', async () => {
  const sent = [];
  const link = { connected: true, send: (...l) => sent.push(...l), on() {} };
  const d = Object.assign(new Display(), { cols: 42, rows: 12, minFlushMs: 0, deviceLink: link, active: true });
  await d.start();
  d.grid.set(0, 'one').set(1, 'two', { centre: true });
  d.flush();
  assert.deepEqual(sent, ['C', 'R 255 255 255', 'T 0 one', 'A 1 two', 'F']);
  sent.length = 0;
  d.grid.set(1, 'TWO', { centre: true, colour: [0, 255, 0] });
  d.flush();
  assert.deepEqual(sent, ['B 0 20 428 20 0 0 0', 'R 0 255 0', 'A 1 TWO', 'F']);
  sent.length = 0;
  d.flush();
  assert.deepEqual(sent, []);
  d.invalidate(); d.flush();
  assert.equal(sent[0], 'C');
});
