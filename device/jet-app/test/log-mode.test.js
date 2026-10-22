// The Log mode: the scrollback buffer (pure) and the backlog handshake with jetd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from '../src/modes/log/buffer.js';
import { LogMode } from '../src/modes/log/index.js';
import { fakeLink, settle } from './helpers.js';

test('log buffer: newest at the bottom, scroll by lines with clamping, pan, follow', () => {
  const b = new LogBuffer({ max: 100 });
  for (let i = 1; i <= 10; i++) b.push(`line ${i}`);
  assert.deepEqual(b.visible(3, 80), ['line 8', 'line 9', 'line 10']);
  assert.equal(b.following, true);
  b.scroll(2, 3);
  assert.deepEqual(b.visible(3, 80), ['line 6', 'line 7', 'line 8']);
  b.push('line 11');
  assert.deepEqual(b.visible(3, 80), ['line 6', 'line 7', 'line 8'], 'a new line does not move a scrolled view');
  b.scroll(100, 3);
  assert.deepEqual(b.visible(3, 80), ['line 1', 'line 2', 'line 3'], 'clamped at the oldest');
  b.scroll(-1, 3);
  assert.deepEqual(b.visible(3, 80), ['line 2', 'line 3', 'line 4']);
  b.pan(5); b.pan(-20);
  assert.equal(b.hoff, 0, 'never left of column 0');
  b.pan(5);
  assert.deepEqual(b.visible(3, 2), ['2', '3', '4']);
  b.follow();
  assert.deepEqual(b.visible(3, 80), ['line 9', 'line 10', 'line 11']);
  assert.deepEqual(new LogBuffer().visible(3, 80), []);
  assert.deepEqual(Object.assign(new LogBuffer(), { lines: ['a'] }).visible(3, 80), ['a'], 'short buffers are not padded');
  const small = new LogBuffer({ max: 3 });
  for (let i = 0; i < 5; i++) small.push(String(i));
  assert.deepEqual(small.lines, ['2', '3', '4']);
});

test('log buffer: the backlog replay replaces what the automatic 60 lines started', () => {
  const b = new LogBuffer();
  for (let i = 41; i <= 100; i++) b.push(`l${i}`);   // jetd's own last-60 on connect
  b.beginBacklog();
  for (let i = 1; i <= 100; i++) b.push(`l${i}`);    // J: the whole ring
  b.endBacklog(100);
  assert.equal(b.length, 100); assert.equal(b.lines[0], 'l1'); assert.equal(b.lines.at(-1), 'l100');
  b.push('l101');
  assert.equal(b.lines.at(-1), 'l101'); assert.equal(b.length, 101);
});

test('log mode: J on connect and on enter, live lines render only while current, gestures', async () => {
  const klog = Array.from({ length: 80 }, (_, i) => `[${i}] boot`);
  const link = fakeLink({ klog });
  const ui = { renders: 0, requestRender() { this.renders++; }, surface: { height: 240, width: 428, fonts: { small: { width: 6, height: 12 } } } };
  const modes = { registered: [], register(m) { this.registered.push(m.id); } };
  const mode = Object.assign(new LogMode(), { lines: 2000, modes, ui, deviceLink: link });
  await mode.start();
  assert.deepEqual(modes.registered, ['log']);
  await settle();
  assert.deepEqual(link.sent, ['J']);
  assert.equal(mode.buffer.length, 80); assert.equal(mode.buffer.lines[0], '[0] boot');
  const r = ui.renders;
  link.emit('log', 'live 1');
  assert.equal(ui.renders, r, 'not current: no repaint'); assert.equal(mode.buffer.length, 81);
  mode.enter(); await settle();
  assert.deepEqual(link.sent, ['J', 'J'], 'entering reloads the ring');
  link.emit('log', 'live 2');
  assert.ok(ui.renders > r, 'current: repaint');
  assert.equal(mode.buffer.lines.at(-1), 'live 2');
  assert.equal(mode.onGesture('press:rear'), false, 'following: rear is not consumed (root)');
  assert.equal(mode.onGesture('swipe:up'), true);
  assert.ok(mode.buffer.offset > 0);
  assert.equal(mode.onGesture('swipe:right'), true); assert.equal(mode.buffer.hoff, 10);
  assert.equal(mode.onGesture('press:rear'), true); assert.equal(mode.buffer.following, true); assert.equal(mode.buffer.hoff, 0);
  assert.equal(mode.onGesture('press:front'), false);
  link.emit('connected'); await settle();
  assert.equal(link.sent.at(-1), 'J', 'reconnect reloads');
});
