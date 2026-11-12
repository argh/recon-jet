// The curator over the real World (no disk) and a scripted vision model: which observations
// are asked about and in what order, what is shown, and what each answer does to the world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/modules/world/index.js';
import { Curator, parseVerdict } from '../src/modules/curator/index.js';

function frame() {
  const data = new Uint8Array(640 * 480 * 4).fill(255);
  return { width: 640, height: 480, data };
}
const BIG = [0, 0, 500, 500], SMALL = [0, 0, 60, 60];
const item = (name, kind, note = '', box = BIG) => ({ name, kind, box, note });

function make({ answers = [], ...over } = {}) {
  const clock = { t: 1_000_000_000_000 };
  const world = Object.assign(new World(), { dir: '', ttlS: 1800, maxEntities: 60, maxClaims: 20, maxSightings: 200, thumbW: 96, thumbH: 72, thumbPad: 0, thumbQuality: 60, cropW: 320, cropH: 240, maxCrops: 4, contextItems: 5, saveMs: 20, logger: null, now: () => clock.t });
  const llm = { calls: [], async chat(req) { this.calls.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return { content: a ?? 'UNSURE - no script', toolCalls: [], usage: {} }; } };
  const curator = Object.assign(new Curator(), { enabled: true, apply: true, model: 'vis', perMinute: 6_000_000, maxCandidates: 3, recentS: 120, minArea: 4800, world, llm, logger: null, now: () => clock.t }, over);
  return { world, llm, curator, clock };
}

test('parseVerdict: SAME, DIFFERENT, UNSURE with the reason; anything else is unsure', () => {
  assert.deepEqual(parseVerdict('SAME - identical dial and switch'), { verdict: 'same', why: 'identical dial and switch' });
  assert.deepEqual(parseVerdict('DIFFERENT; left is a mug, right a magazine'), { verdict: 'different', why: 'left is a mug, right a magazine' });
  assert.deepEqual(parseVerdict('different'), { verdict: 'different', why: '' });
  assert.equal(parseVerdict('UNSURE - too dark').verdict, 'unsure');
  assert.equal(parseVerdict('They look the same to me').verdict, 'unsure', 'only a verdict up front counts');
  assert.equal(parseVerdict('').verdict, 'unsure');
});

test('curator: a new entity that is a known thing under another name is merged into it', async (t) => {
  const { world, llm, curator, clock } = make({ answers: ['SAME - same dial and switch'] });
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Weller WLC100', 'instrument', 'blue station')] });
  await curator.idle();
  assert.equal(llm.calls.length, 0, 'the first thing ever seen has nothing to be compared with');
  assert.equal(world.get('e1').obs[0].checked, 'nothing to compare');
  clock.t += 5 * 60_000;   // looked away for a while
  world.observe({ image: frame(), items: [item('grey soldering station', 'instrument', 'dial and switch')] });
  assert.equal(world.entities().length, 2, 'filed at once, by name, as something new');
  await curator.idle();
  assert.equal(llm.calls.length, 1, 'one candidate (the same kind of thing), one question');
  const parts = llm.calls[0].messages[0].content;
  assert.deepEqual(parts.map((p) => p.type), ['image_url', 'text'], 'one picture: the two crops side by side');
  assert.match(parts[1].text, /LEFT and RIGHT/);
  assert.deepEqual(world.entities().map((e) => e.id), ['e1'], 'one thing');
  const e = world.get('e1');
  assert.deepEqual(e.aliases, ['grey soldering station']); assert.equal(e.seen, 2);
  assert.equal(e.obs[1].checked, 'merged: same dial and switch');
  assert.deepEqual(curator.stats, { checked: 1, questions: 1, same: 0, merged: 1, split: 0, moved: 0, unsure: 0, failed: 0 });
});

test('curator: a split needs "different" against two crops of the entity; against the only one it is left alone', async (t) => {
  const { world, llm, curator, clock } = make({ answers: ['DIFFERENT - left is a mug, right a magazine', 'DIFFERENT - a mug, not a magazine', 'DIFFERENT - a mug'] });
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'cover with tools')] });
  await curator.idle();
  clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'white mug with a logo')] });   // the string match files the mug under the magazine
  await curator.idle();
  assert.equal(llm.calls.length, 1); assert.equal(world.entities().length, 1, 'one crop to compare with: a change of angle looks the same to the model, so no split');
  assert.equal(world.observation('o2').obs.checked, 'unsure: left is a mug, right a magazine'); assert.equal(curator.stats.unsure, 1);
  clock.t += 1000;
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'the mug again')] });
  await curator.idle();
  assert.equal(llm.calls.length, 3, 'two crops of the entity now: both asked');
  assert.deepEqual(world.entities().map((e) => [e.id, e.obs.map((o) => o.id)]), [['e2', ['o3']], ['e1', ['o1', 'o2']]], 'different from both: it is something else');
  assert.equal(curator.stats.split, 1);
});

test('curator: two established entities that are one thing are found and merged; a pair found different is asked about once', async (t) => {
  const { world, llm, curator, clock } = make({ answers: ['SAME - same camera', 'SAME - same body and lens', 'DIFFERENT - a lamp and a camera', 'SAME - same lamp'] });
  // two names for one camera, each with a history, never in one frame
  world.observe({ image: frame(), items: [item('Nikon D800 camera', 'instrument', 'black body')] }); clock.t += 1000;
  world.observe({ image: frame(), items: [item('Nikon D800 camera', 'instrument', 'strap lug')] }); clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('Nikon DSLR camera', 'instrument', 'macro lens')] }); clock.t += 1000;
  world.observe({ image: frame(), items: [item('Nikon DSLR camera', 'instrument', 'lens barrel')] }); clock.t += 1000;
  world.observe({ image: frame(), items: [item('Nikon DSLR camera', 'instrument', 'rear dial')] }); clock.t += 1000;
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Nikon DSLR camera', 'instrument', 'top plate')] });
  await curator.idle();
  assert.equal(llm.calls.length, 2, 'its own entity, then the other Nikon');
  assert.deepEqual(world.entities().map((e) => [e.id, e.name, e.seen, e.aliases]), [['e2', 'Nikon DSLR camera', 6, ['Nikon D800 camera']]], 'the one seen less joined the one seen more');
  assert.equal(curator.stats.merged, 1);
  // a different thing of the same kind: asked once, remembered on both
  clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('desk lamp', 'instrument', 'a')] });
  await curator.idle();
  assert.equal(llm.calls.length, 3, 'new: compared with the camera');
  assert.equal(world.distinct('e3', 'e2'), true); assert.equal(world.distinct('e2', 'e3'), true);
  clock.t += 1000;
  world.observe({ image: frame(), items: [item('desk lamp', 'instrument', 'b')] });
  await curator.idle();
  assert.equal(llm.calls.length, 4, 'only its own entity this time: the pair is known');
  assert.equal(world.entities().length, 2);
});

test('curator: checks wait while a voice turn is running', async (t) => {
  const { world, llm, curator, clock } = make({ answers: ['SAME - x'] });
  const { EventEmitter } = await import('node:events');
  const voice = Object.assign(new EventEmitter(), { state: 'speaking' });
  curator.voice = voice;
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Weller station', 'instrument', 'a')] }); clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('grey station', 'instrument', 'b')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(llm.calls.length, 0); assert.equal(curator.pending, 2, 'held');
  voice.state = 'idle'; voice.emit('state', { to: 'idle' });
  await curator.idle();
  assert.ok(llm.calls.length >= 1, 'released'); assert.equal(world.entities().length, 1);
});

test('curator: an observation filed under the wrong entity moves to the one the model picks', async (t) => {
  const { world, curator, clock } = make({ answers: ['DIFFERENT - other handles', 'DIFFERENT - blue grips here', 'SAME - same red handles'] });
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('red pliers', 'tool', 'on the mat')] }); clock.t += 1000;
  await curator.idle();
  world.observe({ image: frame(), items: [item('wire cutters', 'tool', 'by the vice')] }); clock.t += 5 * 60_000;
  await curator.idle();   // the cutters against the pliers: different, nothing changes
  world.observe({ image: frame(), items: [item('wire cutters', 'tool', 'red handles')] });
  await curator.idle();
  assert.deepEqual(world.get('e1').obs.map((o) => o.id), ['o1', 'o3'], 'moved to the pliers');
  assert.deepEqual(world.get('e2').obs.map((o) => o.id), ['o2']);
  assert.deepEqual(world.get('e1').aliases, ['wire cutters']);
  assert.equal(curator.stats.moved, 1);
});

test('curator: the doubtful go first - a look back, then a new entity, then what joined the current set; the same frame is never a candidate', async (t) => {
  const { world, llm, curator, clock } = make({ answers: Array(8).fill('UNSURE - cannot tell') });
  world.observe({ image: frame(), items: [item('desk lamp', 'lamp', 'a'), item('floor lamp', 'lamp', 'b')] }); clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('steel ruler', 'tool', 'c')] }); clock.t += 1000;
  await curator.start(); t.after(() => curator.stop());
  const order = []; curator.on('checked', (obs) => order.push(obs));
  // one frame: the ruler again (current set), a new lamp, and the desk lamp after five minutes away
  world.observe({ image: frame(), items: [item('steel ruler', 'tool', 'd'), item('reading lamp', 'lamp', 'e'), item('desk lamp', 'lamp', 'f')] });
  await curator.idle();
  assert.deepEqual(order, ['o6', 'o5', 'o4'], 'the look back, the new one, the current set');
  // o6: its own entity is unsure -> left there, not shopped around (1). o5: new, only the floor lamp is a candidate -
  // the desk lamp is in its own frame (1). o4: its own entity (1).
  assert.equal(llm.calls.length, 3); assert.equal(curator.stats.questions, 3);
  assert.equal(world.entities().length, 4, 'unsure changes nothing');
});

test('curator: small crops are not evidence; apply off only logs; a failing model is counted and the queue goes on', async (t) => {
  const { world, llm, curator, clock } = make({ apply: false, answers: [new Error('socket hang up'), 'SAME - same'] });
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Weller WLC100', 'instrument', 'x')] }); clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('tiny screw', 'instrument', 'y', SMALL)] });
  await curator.idle();
  assert.equal(world.observation('o2').obs.checked, 'no evidence'); assert.equal(llm.calls.length, 0);
  world.observe({ image: frame(), items: [item('soldering station', 'instrument', 'z')] });
  await curator.idle();
  assert.equal(curator.stats.failed, 1); assert.equal(world.observation('o3').obs.checked, undefined, 'a failed check leaves no verdict');
  world.observe({ image: frame(), items: [item('grey station', 'instrument', 'w')] });
  await curator.idle();
  assert.equal(curator.stats.merged, 1);
  assert.equal(world.entities().length, 4, 'apply off: nothing was merged');
  assert.equal(world.observation('o4').obs.checked, 'merged: same');
});
