import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Input } from '../src/modules/input/index.js';

async function make(overrides = {}, abort) {
  const link = Object.assign(new EventEmitter(), { connected: true, sent: [], send(l) { this.sent.push(l); return true; } });
  const input = Object.assign(new Input(), { holdMs: 40, swipeDebounceMs: 250, tapCode: 28, rawKeys: true, deviceLink: link, ...overrides });
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

test('swipes: key downs only; motion never navigates; one move per gesture', async () => {
  const { link, gestures, key, input } = await make();
  const motion = [];
  input.on('motion', (m) => motion.push(m));
  // one swipe as jetd forwards it: the driver's summed motion plus the key pair, within 100 ms
  link.emit('rel', { dx: 0, dy: -30, t: 1000 });
  key(108, 1, 1050); key(108, 0, 1080);
  assert.deepEqual(gestures, ['swipe:down'], 'key pair + matching motion: exactly one move');
  assert.deepEqual(motion, [{ dx: 0, dy: -30, t: 1000 }], 'motion is re-emitted, not navigated');
  key(103, 0, 2000);                              // a lone key up: nothing
  link.emit('rel', { dx: -40, dy: 0, t: 2100 });  // motion on its own: nothing
  assert.deepEqual(gestures, ['swipe:down']);
  key(105, 1, 3000); key(28, 1, 3010); key(28, 0, 3020);
  assert.deepEqual(gestures, ['swipe:down', 'swipe:left', 'press:front'], 'a tap (code 28, also keyboard Enter) is a front press and is not debounced');
  await input.stop();
});

test('swipe debounce: two key downs 100 ms apart move once, 400 ms apart move twice', async () => {
  const { gestures, key, input } = await make();
  key(108, 1, 1000); key(108, 0, 1020);
  key(108, 1, 1100); key(108, 0, 1120);           // the driver's second key from one long swipe
  assert.deepEqual(gestures, ['swipe:down']);
  key(108, 1, 1500); key(108, 0, 1520);
  assert.deepEqual(gestures, ['swipe:down', 'swipe:down']);
  key(103, 1, 1600);                              // a different direction inside the window is dropped too
  assert.deepEqual(gestures, ['swipe:down', 'swipe:down']);
  key(103, 1, 1900);
  assert.deepEqual(gestures, ['swipe:down', 'swipe:down', 'swipe:up']);
  await input.stop();
});

test('keyboard aliases: Enter is the front button (held = hold), Esc and Backspace are rear; repeats are ignored', async () => {
  const { gestures, input, key } = await make();
  key(28, 1, 0); key(28, 0, 10);                 // Enter tap
  key(1, 1, 100); key(1, 0, 110);                // Esc
  key(14, 1, 200); key(14, 0, 210);              // Backspace
  key(96, 1, 300); key(96, 2, 320); key(96, 2, 340); key(96, 0, 1400);   // keypad Enter held, with key repeats
  assert.deepEqual(gestures, ['press:front', 'press:rear', 'press:rear', 'hold:front']);
  key(103, 1, 2000); key(103, 2, 2020); key(103, 0, 2030);   // a keyboard arrow is the same code as the pad's swipe key
  assert.deepEqual(gestures.slice(-1), ['swipe:up']);
  await input.stop();
});
