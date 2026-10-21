import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Input } from '../src/modules/input/index.js';

async function make(overrides = {}) {
  const link = new EventEmitter();
  const input = Object.assign(new Input(), { holdMs: 40, swipeThreshold: 20, swipeDedupeMs: 300, tapCode: 28, deviceLink: link, ...overrides });
  const gestures = [];
  input.on('gesture', (g) => gestures.push(g));
  await input.start();
  return { link, input, gestures };
}

test('short press vs hold', async () => {
  const { link, gestures } = await make();
  link.emit('key', { code: 86, value: 1 }); link.emit('key', { code: 86, value: 0 });
  assert.deepEqual(gestures, ['press:front']);
  link.emit('key', { code: 107, value: 1 });
  await sleep(60);
  link.emit('key', { code: 107, value: 0 });
  assert.deepEqual(gestures, ['press:front', 'hold:rear']);
});

test('swipes from keys, from motion, and deduped', async () => {
  const { link, gestures } = await make();
  link.emit('key', { code: 103, value: 1 }); link.emit('key', { code: 103, value: 0 });
  link.emit('rel', { dx: -30, dy: 2 });
  link.emit('key', { code: 105, value: 1 });               // the driver's key for the same swipe
  link.emit('rel', { dx: 3, dy: -4 });                     // below threshold: nothing
  assert.deepEqual(gestures, ['swipe:up', 'swipe:left']);
});
