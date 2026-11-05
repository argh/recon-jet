// The Demo mode's picture path: UYVY -> RGBA (pure), the describe flow (snapshot, JPEG, look).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { uyvyToRgba } from '../src/lib/uyvy.js';
import { DemoMode } from '../src/modes/demo/index.js';
import { fakeLink, fakeSounds, settle } from './helpers.js';
import { EventEmitter } from 'node:events';

test('uyvy -> rgba: grey, pure colours, subsampling', () => {
  const px = (Y, U, V) => Buffer.from([U, Y, V, Y]);   // two pixels
  let img = uyvyToRgba(px(128, 128, 128), 2, 1);
  assert.deepEqual([...img.data.subarray(0, 4)], [130, 130, 130, 255]);
  img = uyvyToRgba(px(235, 128, 128), 2, 1);
  assert.deepEqual([...img.data.subarray(0, 3)], [255, 255, 255], 'white clamps');
  img = uyvyToRgba(px(81, 90, 240), 2, 1);
  const [r, g, b] = img.data;
  assert.ok(r > 200 && g < 60 && b < 60, `red: ${r} ${g} ${b}`);
  const frame = Buffer.alloc(640 * 480 * 2, 0x80);
  const t0 = performance.now();
  img = uyvyToRgba(frame, 640, 480, { scale: 2 });
  assert.equal(img.width, 320); assert.equal(img.height, 240); assert.equal(img.data.length, 320 * 240 * 4);
  const { data: jpg } = jpeg.encode(img, 60);
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
  assert.ok(performance.now() - t0 < 2000);
});

test('demo: front press takes a snapshot, encodes it and streams the answer; rear clears; stale looks are dropped', async () => {
  const link = fakeLink();
  const ui = { renders: 0, strips: [], requestRender() { this.renders++; }, setStrip(t) { this.strips.push(t); } };
  const surface = { width: 428, height: 240, viewfinderRect: null, viewfinder(x, y, w, h) { this.viewfinderRect = { x, y, w, h }; return Promise.resolve({ w: 640, h: 480 }); }, stopViewfinder() { this.viewfinderRect = null; } };
  let resolveLook; const looks = [];
  const voice = { look(jpg, q, { onToken }) { looks.push({ jpg, q }); onToken('It '); onToken('is a wall.'); return new Promise((r) => { resolveLook = r; }); } };
  const demo = Object.assign(new DemoMode(), { question: 'what?', jpegQuality: 50, modes: { register() {} }, ui, surface, deviceLink: link, power: { smoothed: null }, sensors: { glance: null, view: null }, voice, sounds: fakeSounds() });
  await demo.start();
  demo.enter(); await settle();
  assert.deepEqual(surface.viewfinderRect, { x: 428 - 160 - 6, y: 14, w: 160, h: 120 });
  assert.equal(demo.onGesture('press:rear'), false, 'nothing to clear: root');
  assert.equal(demo.onGesture('press:front'), true);
  assert.equal(demo.state, 'looking'); assert.equal(ui.strips.at(-1), 'looking');
  assert.equal(demo.onGesture('press:front'), true, 'a second press while working is swallowed');
  await settle(); await new Promise((r) => setTimeout(r, 100));
  assert.equal(looks.length, 1); assert.equal(link.sent.at(-1), 'S 640 480');
  assert.equal(looks[0].q, 'what?'); assert.equal(looks[0].jpg[0], 0xff);
  const decoded = jpeg.decode(looks[0].jpg);
  assert.equal(decoded.width, 320); assert.equal(decoded.height, 240);
  assert.equal(demo.state, 'answering'); assert.equal(demo.answer, 'It is a wall.');
  resolveLook('It is a wall.'); await settle();
  assert.equal(demo.state, 'idle'); assert.equal(ui.strips.at(-1), null);
  assert.equal(demo.onGesture('press:rear'), true); assert.equal(demo.answer, '');
  // leaving mid-look: the late answer is ignored
  demo.onGesture('press:front'); await new Promise((r) => setTimeout(r, 100));
  demo.leave();
  assert.equal(surface.viewfinderRect, null);
  resolveLook('late'); await settle();
  assert.equal(demo.answer, ''); assert.equal(demo.state, 'idle');
  // a failing snapshot shows the error
  demo.enter(); link.snapshot = async () => { throw new Error('no camera'); };
  demo.onGesture('press:front'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(demo.error, 'no camera'); assert.equal(demo.state, 'idle');
  assert.deepEqual(demo.sounds.played.filter((n) => n === 'error'), ['error'], 'the failure is heard'); assert.equal(demo.sounds.played[0], 'ack', 'sending is acknowledged');
});

test('demo: the live camera is modal — it pauses under the mode menu, resumes on cancel, stays off on a pick', async () => {
  const modes = Object.assign(new EventEmitter(), { current: null, register(m) { this.current = m; return this; } });
  const ui = { requestRender() {}, setStrip() {} };
  const surface = Object.assign(new EventEmitter(), {
    width: 428, height: 240, viewfinderRect: null, paused: false,
    viewfinder(x, y, w, h) { if (!this.paused) this.viewfinderRect = { x, y, w, h }; return Promise.resolve({ w: 640, h: 480 }); },
    stopViewfinder() { this.viewfinderRect = null; },
    pauseViewfinder() { this.paused = true; this.viewfinderRect = null; },
    resumeViewfinder() { this.paused = false; this.viewfinderRect = { x: 262, y: 14, w: 160, h: 120 }; },
  });
  const demo = Object.assign(new DemoMode(), { modes, ui, surface, deviceLink: fakeLink(), power: { smoothed: null }, sensors: {}, voice: {}, sounds: fakeSounds() });
  await demo.start();                 // register() made demo the current mode
  demo.enter(); await settle();
  assert.ok(surface.viewfinderRect, 'camera live while Describe is the screen');
  // front hold opens the switcher: the camera (a jetd-side overlay) must stop, or it shows through the menu
  modes.emit('switcher', true); await settle();
  assert.equal(surface.paused, true); assert.equal(surface.viewfinderRect, null, 'paused under the menu');
  // rear cancels back to Describe: the camera comes back
  modes.emit('switcher', false); await settle(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(surface.paused, false); assert.ok(surface.viewfinderRect, 'resumed on cancel');
  // picking another mode: switcher closes, then current moves away (and leave() stops the camera) — no brief re-open
  modes.emit('switcher', true); await settle();
  assert.equal(surface.paused, true);
  modes.emit('switcher', false);      // closeSwitcher fires first...
  modes.current = { id: 'other' };    // ...then switchTo moves current away (same tick, before the deferred resume)
  demo.leave();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(surface.paused, true, 'a pick does not resume the camera for a frame');
});

test('demo: the "run analysis" command comes to this mode first, then describes', async () => {
  const link = fakeLink();
  const ui = { renders: 0, strips: [], requestRender() { this.renders++; }, setStrip(t) { this.strips.push(t); } };
  const surface = { width: 428, height: 240, viewfinderRect: null, viewfinder(x, y, w, h) { this.viewfinderRect = { x, y, w, h }; return Promise.resolve({ w: 640, h: 480 }); }, stopViewfinder() { this.viewfinderRect = null; } };
  // spoken: the SAY line comes first and never reaches the glass; its TTS starts as soon as the line is complete
  // (while the details still stream) and the clip plays right after the "report" phrase
  const voice = { asked: [], phrases: [], synthed: [], played: [], warmed: 0, synthAt: null,
    look(jpg, q, { onToken }) { this.asked.push(q); for (const t of ['SAY: “someone', ' needs a shelf.”\n', 'a desk', ' with mugs.']) { onToken(t); if (this.synthed.length && this.synthAt === null) this.synthAt = t; } return Promise.resolve('SAY: “someone needs a shelf.”\na desk with mugs.'); },
    phrase(set) { this.phrases.push(set); }, synth(text) { this.synthed.push(text); return Promise.resolve(Buffer.from(`pcm:${text}`)); }, playClip(pcm) { this.played.push(pcm.toString()); }, warm() { this.warmed++; } };
  const registered = []; const actions = { register(name, pattern, run) { registered.push({ name, pattern, run }); return this; } };
  const modes = { current: null, switched: [], register() {}, switchTo(id) { this.switched.push(id); this.current = demo; return true; } };
  const demo = Object.assign(new DemoMode(), { question: 'what?', spokenQuestion: 'what? then SAY:', jpegQuality: 50, modes, ui, surface, deviceLink: link, power: { smoothed: null }, sensors: { glance: null, view: null }, voice, sounds: fakeSounds(), actions });
  await demo.start();
  assert.equal(registered.length, 1); assert.equal(registered[0].name, 'analysis');
  assert.ok(registered[0].pattern.test('run analysis')); assert.ok(registered[0].pattern.test('run analysis of the camera view'), 'trailing words are fine');
  assert.ok(!registered[0].pattern.test('look')); assert.ok(!registered[0].pattern.test('run analysisx'));
  assert.ok(!registered[0].pattern.test('what time is it'));
  await registered[0].run([], 'run analysis');
  assert.deepEqual(modes.switched, ['demo'], 'not current: switched first');
  assert.deepEqual(voice.asked, ['what? then SAY:'], 'the spoken prompt');
  assert.equal(demo.answer, 'a desk with mugs.', 'the SAY line is not on the glass');
  assert.equal(voice.warmed, 1, 'the TTS was woken when the look began');
  assert.deepEqual(voice.synthed, ['someone needs a shelf.'], 'quotes dropped, synthesised once');
  assert.equal(voice.synthAt, ' needs a shelf.”\n', 'the TTS started on the token that completed the SAY line, before the details');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(voice.phrases, ['report']); assert.deepEqual(voice.played, ['pcm:someone needs a shelf.'], 'the report phrase, then the remark');
  const { splitRemark } = await import('../src/modes/demo/index.js');
  assert.deepEqual(splitRemark('SAY: tidy up\nTwo mugs.'), { details: 'Two mugs.', say: 'tidy up' });
  assert.deepEqual(splitRemark('Two mugs.\nsay: "tidy up"'), { details: 'Two mugs.', say: 'tidy up' }, 'last line works too');
  assert.deepEqual(splitRemark('SAY: tidy', { final: false }), { details: '', say: '' }, 'a SAY line still being written: nothing yet');
  assert.deepEqual(splitRemark('SAY: tidy', { final: true }), { details: '', say: 'tidy' }, 'the answer ended on it: complete');
  assert.deepEqual(splitRemark('Two mugs. SAY: no'), { details: 'Two mugs. SAY: no', say: '' }, 'only on its own line');
  assert.deepEqual(splitRemark(''), { details: '', say: '' });
  // the button's describe: the plain prompt, nothing spoken, no warm-up
  demo.answer = ''; voice.asked.length = 0;
  await demo.describe();
  assert.deepEqual(voice.asked, ['what?']); assert.deepEqual(voice.phrases, ['report'], 'no second phrase'); assert.deepEqual(voice.synthed, ['someone needs a shelf.']); assert.equal(voice.warmed, 1);
  assert.equal(demo.answer, 'a desk with mugs.', 'the model still answered with a SAY line; the glass drops it');
  await registered[0].run([], 'look');
  assert.deepEqual(modes.switched, ['demo'], 'already current: no switch');
});
