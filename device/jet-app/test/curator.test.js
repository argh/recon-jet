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

test('curator: a name reused for something else is split off; a look back at the same thing is confirmed', async (t) => {
  const { world, llm, curator, clock } = make({ answers: ['DIFFERENT - left is a mug, right a magazine', 'DIFFERENT - a mug', 'SAME - same cover'] });
  await curator.start(); t.after(() => curator.stop());
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'cover with tools')] });
  await curator.idle();
  clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'white mug with a logo')] });   // the string match files the mug under the magazine
  assert.equal(world.entities().length, 1);
  await curator.idle();
  assert.equal(llm.calls.length, 1, 'compared with the entity it was filed under');
  assert.deepEqual(world.entities().map((e) => [e.id, e.name, e.obs.map((o) => o.id)]), [['e2', 'Make magazine', ['o2']], ['e1', 'Make magazine', ['o1']]], 'two things now');
  assert.deepEqual(world.get('e1').claims.map((c) => c.text), ['cover with tools'], 'the claim went with its observation');
  clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('Make magazine', 'magazine', 'the cover again')] });   // joins the latest of that name: the mug
  await curator.idle();
  assert.equal(llm.calls.length, 3, 'its own entity (the mug) first, then the other of that name');
  assert.equal(world.observation('o3').entity.id, 'e1', 'moved to the magazine'); assert.equal(world.observation('o3').obs.checked, 'moved: same cover');
  assert.deepEqual(world.get('e2').obs.map((o) => o.id), ['o2']);
  assert.equal(curator.stats.split, 1); assert.equal(curator.stats.moved, 1);
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
  const { world, llm, curator, clock } = make({ answers: Array(6).fill('DIFFERENT - not it') });
  world.observe({ image: frame(), items: [item('desk lamp', 'lamp', 'a'), item('floor lamp', 'lamp', 'b')] }); clock.t += 5 * 60_000;
  world.observe({ image: frame(), items: [item('steel ruler', 'tool', 'c')] }); clock.t += 1000;
  await curator.start(); t.after(() => curator.stop());
  // one frame: the ruler again (current set), a new lamp, and the desk lamp after five minutes away
  world.observe({ image: frame(), items: [item('steel ruler', 'tool', 'd'), item('reading lamp', 'lamp', 'e'), item('desk lamp', 'lamp', 'f')] });
  await curator.idle();
  // order: o6 (the desk lamp, looked back: its own entity, then the floor lamp - split off), o5 (new: the floor lamp
  // and the old desk-lamp entity, which o6 turned out not to be; never the things still in its own frame),
  // o4 (the ruler, current set: its own entity)
  assert.deepEqual([world.observation('o6'), world.observation('o5'), world.observation('o4')].map((x) => x.obs.checked), ['split: not it', 'same: not it', 'split: not it']);
  assert.equal(curator.stats.questions, 5);
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
