import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Input } from '../src/modules/input/index.js';

async function make(overrides = {}, abort) {
  const link = Object.assign(new EventEmitter(), { connected: true, sent: [], send(l) { this.sent.push(l); return true; } });
  const input = Object.assign(new Input(), { holdMs: 40, swipeThreshold: 20, swipeDedupeMs: 300, tapCode: 28, rawKeys: true, deviceLink: link, ...overrides });
  const gestures = [];
  input.on('gesture', (g) => gestures.push(g));
  await input.start(abort);
  const key = (code, value, t) => link.emit('key', { code, value, t });
  return { link, input, gestures, key };
}

test('raw keys: K 1 on connect, K 0 when the run aborts', async () => {
  const abort = new AbortController();
  const { link } = await make({}, abort);
  assert.deepEqual(link.sent, ['K 1']);          // already connected at start
  link.emit('connected');
  assert.deepEqual(link.sent, ['K 1', 'K 1']);
  abort.abort();
  assert.deepEqual(link.sent, ['K 1', 'K 1', 'K 0']);
});

test('short press vs hold (real timing: the hold fires while still held)', async () => {
  const { link, gestures, input } = await make();
  link.emit('key', { code: 86, value: 1 }); link.emit('key', { code: 86, value: 0 });
  assert.deepEqual(gestures, ['press:front']);
  link.emit('key', { code: 86, value: 1 });
  await sleep(60);
  assert.deepEqual(gestures, ['press:front', 'hold:front']);   // before the release
  link.emit('key', { code: 86, value: 0 });
  assert.deepEqual(gestures, ['press:front', 'hold:front']);   // the release adds nothing
  link.emit('key', { code: 107, value: 1 }); link.emit('key', { code: 107, value: 0 });
  assert.deepEqual(gestures, ['press:front', 'hold:front', 'press:rear']);
  await input.stop();
});

test('hold detection from event timestamps (synthetic k stream, 1 s threshold)', async () => {
  let clock = 0;
  const { gestures, key, input } = await make({ holdMs: 1000 });
  input.now = () => clock;
  key(86, 1, 0); key(86, 0, 300);                 // released before the threshold
  assert.deepEqual(gestures, ['press:front']);
  key(86, 1, 1000); key(86, 0, 2200);             // held past it: a hold, classified at release
  assert.deepEqual(gestures, ['press:front', 'hold:front']);
  key(86, 0, 2300);                               // a stray up (jetd's chooser consumed the down): ignored
  key(107, 1, 3000); key(107, 0, 3100);
  assert.deepEqual(gestures, ['press:front', 'hold:front', 'press:rear']);
  key(86, 1, 4000); key(86, 0, 4999);             // just under
  key(86, 1, 5000); key(86, 0, 6000);             // exactly at
  assert.deepEqual(gestures.slice(3), ['press:front', 'hold:front']);
  await input.stop();
});

test('disconnect forgets a held button', async () => {
  const { link, gestures, key, input } = await make({ holdMs: 1000 });
  key(86, 1, 0);
  link.emit('disconnected');
  key(86, 0, 5000);
  assert.deepEqual(gestures, []);
  await input.stop();
});

test('swipes from keys, from motion, and deduped', async () => {
  const { link, gestures, key, input } = await make();
  key(103, 1); key(103, 0);
  link.emit('rel', { dx: -30, dy: 2 });
  key(105, 1);                                    // the driver's key for the same swipe
  link.emit('rel', { dx: 3, dy: -4 });            // below threshold: nothing
  key(108, 1); key(106, 1); key(28, 1);
  assert.deepEqual(gestures, ['swipe:up', 'swipe:left', 'swipe:down', 'swipe:right', 'press:tap']);
  link.emit('rel', { dx: 0, dy: -25, t: 10000 });
  key(108, 1, 10400);                             // same direction but past the dedupe window: a second swipe
  assert.deepEqual(gestures.slice(5), ['swipe:down', 'swipe:down']);
  await input.stop();
});
