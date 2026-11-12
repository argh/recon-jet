// The world model: association, claims, expiry and eviction, thumbnails, persistence, the
// agent's context line, and the `sightings` tool that reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, boxRect, normaliseName, unreadModel } from '../src/modules/world/index.js';
import { SightingsTool, ago } from '../src/modules/world/sightings-tool.js';
import { tmpdir } from './helpers.js';

const MIN = 60000;

/** A world on a hand-held clock; no `dir` = nothing touches the disk. */
function world(over = {}) {
  const clock = { t: 1_000_000_000_000 };
  const w = Object.assign(new World(), { dir: '', ttlS: 1800, maxEntities: 60, maxClaims: 20, maxSightings: 200, thumbW: 96, thumbH: 72, thumbPad: 0.08, thumbQuality: 75, contextItems: 5, saveMs: 20, logger: null, now: () => clock.t }, over);
  return { w, clock };
}
/** A 640x480 frame, left half red, right half blue. */
function frame() {
  const data = new Uint8Array(640 * 480 * 4);
  for (let i = 0; i < 640 * 480; i++) { data[i * 4 + (i % 640 < 320 ? 0 : 2)] = 255; data[i * 4 + 3] = 255; }
  return { width: 640, height: 480, data };
}
const item = (name, kind = 'tool', note = '', box = [100, 100, 300, 200]) => ({ name, kind, box, note });

test('boxRect: 0..1000 to pixels, padded, ordered; junk is null', () => {
  const r = boxRect([100, 100, 300, 200], 640, 480, 0.08);
  for (const [k, v] of Object.entries({ x: 64 - 128 * 0.08, y: 48 - 48 * 0.08, w: 128 * 1.16, h: 48 * 1.16 })) assert.ok(Math.abs(r[k] - v) < 1e-9, k);
  assert.deepEqual(boxRect([300, 200, 100, 100], 1000, 1000), { x: 100, y: 100, w: 200, h: 100 }, 'corners in any order');
  assert.equal(boxRect([100, 100, 100, 200], 640, 480), null, 'no width');
  assert.equal(boxRect([1, 2, 3], 640, 480), null);
  assert.equal(boxRect(null, 640, 480), null);
  assert.equal(boxRect([0, 0, NaN, 5], 640, 480), null);
});

test('world: thumbnails are the padded box, clamped at the frame edge, fitted to 96x72', () => {
  const { w } = world();
  const [meter, edge, none] = w.observe({ image: frame(), items: [item('meter', 'tool', '', [0, 0, 500, 500]), item('lamp', 'light', '', [900, 0, 1000, 500]), item('wall', 'thing', '', null)] });
  let t = w.thumb(meter.id);
  assert.deepEqual([t.width, t.height], [96, 72], '320x240 (+pad, clamped at the top left) fits 96x72');
  assert.deepEqual([...t.data.subarray(0, 4)], [255, 0, 0, 255], 'red side');
  t = w.thumb(edge.id);   // 64x240 px, padded to 74x259, clamped to x 571..640, y 0..260
  assert.equal(t.height, 72); assert.equal(t.width, Math.round(69 * 72 / 260));
  assert.deepEqual([...t.data.subarray(0, 4)], [0, 0, 255, 255], 'blue side');
  assert.equal(w.thumb(none.id), null, 'no box, no thumbnail');
  assert.equal(w.thumb('e99'), null);
});

test('world: association is by name and kind', () => {
  const { w, clock } = world();
  const [a] = w.observe({ items: [item('Fluke multimeter', 'meter')] });
  assert.equal(a.id, 'e1'); assert.equal(a.seen, 1); assert.equal(a.firstSeen, clock.t);
  clock.t += MIN;
  const again = w.observe({ items: [item('the  fluke MULTIMETER!', 'Meter'), item('Fluke multimeter probe', 'meter'), item('fluke multimeter', 'book'), item('multimeter', 'meter'), item('', 'meter'), null] });
  assert.deepEqual(again.map((e) => e.id), ['e1', 'e2', 'e3'], 'same name; a containing name; another kind is another thing; one word of a name is a category, not that thing');
  const e1 = w.get('e1');
  assert.equal(e1.seen, 2, 'three items in one frame are one sighting'); assert.equal(e1.lastSeen, clock.t); assert.equal(e1.firstSeen, clock.t - MIN);
  assert.equal(e1.name, 'Fluke multimeter', 'the first name stays');
  assert.equal(w.get('e2').kind, 'book');
  // an exact name wins over a containing one, whichever was seen last
  const { w: w2, clock: c2 } = world();
  w2.observe({ items: [item('solder spool', 'spool')] }); c2.t += 1000;
  w2.observe({ items: [item('solder spool kester', 'spool')] });   // contains "solder spool": joins e1
  assert.equal(w2.entities().length, 1);
  const { w: w3, clock: c3 } = world();
  w3.observe({ items: [item('red pliers', 'tool'), item('pliers', 'hardware')] }); c3.t += 1000;
  assert.deepEqual(w3.observe({ items: [item('red pliers', 'tool')] }).map((e) => e.id), ['e1']);
  assert.equal(w3.observe({ items: [item('pliers', '')] })[0].id, 'e2', 'no kind matches any kind; an exact name before a containing one');
  assert.equal(normaliseName(' The Pliers. '), 'pliers'); assert.equal(normaliseName('a'), 'a');
});

test('world: the scanner reusing a known name lands on the same entity; entities are recency-sorted copies', () => {
  const { w, clock } = world();
  w.observe({ items: [item('multimeter'), item('solder spool')] }); clock.t += 5000;
  const names = w.entities().map((e) => e.name);
  w.observe({ scene: 'bench', items: [item(names[1])] });
  assert.deepEqual(w.entities().map((e) => [e.id, e.seen]), [['e2', 2], ['e1', 1]], 'seen again: to the front');
  const copy = w.entities()[0];
  copy.name = 'x'; copy.claims.push({ t: 0, text: 'forged', source: 'me' });
  assert.equal(w.get('e2').name, 'solder spool'); assert.equal(w.get('e2').claims.length, 0, 'what is handed out is a copy');
  assert.deepEqual(w.sightings().map((x) => [x.id, x.scene, x.entityIds]), [['s2', 'bench', ['e2']], ['s1', '', ['e1', 'e2']]], 'the frame log, newest first');
});

test('world: claims are appended when new, not when they repeat the latest, and capped', () => {
  const { w, clock } = world({ maxClaims: 3 });
  w.observe({ items: [item('meter', 'tool', '2.210 kΩ')] }); clock.t += 1000;
  w.observe({ items: [item('meter', 'tool', '2.210 kΩ')] }); clock.t += 1000;
  w.observe({ items: [item('meter', 'tool', '')] }); clock.t += 1000;
  assert.deepEqual(w.get('e1').claims, [{ t: clock.t - 3000, text: '2.210 kΩ', source: 'scan' }]);
  w.observe({ items: [item('meter', 'tool', '  9.99   V ')] }); clock.t += 1000;
  w.observe({ items: [item('meter', 'tool', '2.210 kΩ')] });
  assert.deepEqual(w.get('e1').claims.map((c) => c.text), ['2.210 kΩ', '9.99 V', '2.210 kΩ'], 'an older claim coming back is news');
  assert.equal(w.note('e1', 'belongs to rg', 'agent').claims.at(-1).source, 'agent');
  assert.deepEqual(w.get('e1').claims.map((c) => c.text), ['9.99 V', '2.210 kΩ', 'belongs to rg'], 'capped, oldest dropped');
  assert.equal(w.note('e1', 'Belongs to RG').claims.length, 3, 'a repeat by hand is no claim either');
  assert.equal(w.note('e9', 'x'), null);
});

test('world: unpinned entities expire after ttlS, pinned ones stay', () => {
  const { w, clock } = world();
  w.observe({ image: frame(), items: [item('meter'), item('spool')] });
  assert.equal(w.pin('e2'), true); assert.equal(w.pin('e9'), false);
  clock.t += 1800 * 1000;
  assert.equal(w.entities().length, 2, 'at the ttl exactly: still here');
  clock.t += 1;
  assert.deepEqual(w.entities().map((e) => e.id), ['e2']);
  assert.equal(w.get('e1'), null); assert.equal(w.get('e2').pinned, true);
  assert.deepEqual(w.observe({ items: [item('meter')] }).map((e) => e.id), ['e3'], 'an expired thing seen again is a new record');
  assert.equal(w.thumb('e1'), null, 'its thumbnail went with it');
  w.pin('e2', false);
  assert.deepEqual(w.entities().map((e) => e.id), ['e3'], 'unpinned past its ttl: gone');
});

test('world: maxEntities evicts the longest unseen, pinned last', () => {
  const { w, clock } = world({ maxEntities: 3 });
  for (const name of ['one', 'two', 'three']) { w.observe({ items: [item(name)] }); clock.t += 1000; }
  w.pin('e1');
  w.observe({ items: [item('four')] });
  assert.deepEqual(w.entities().map((e) => e.name), ['four', 'three', 'one'], 'two was the oldest unpinned');
  w.pin('e3'); w.pin('e4'); clock.t += 1000;
  w.observe({ items: [item('five')] });
  assert.deepEqual(w.entities().map((e) => e.name), ['five', 'four', 'three'], 'all pinned: the bound still holds, and the frame in hand is not what goes');
  const { w: w2 } = world({ maxSightings: 2 });
  for (let i = 0; i < 4; i++) w2.observe({ scene: `s${i}` });
  assert.deepEqual(w2.sightings().map((x) => x.scene), ['s3', 's2'], 'the sightings log is a ring');
});

test('world: find, forget, change events', () => {
  const { w, clock } = world();
  let changes = 0; w.on('change', () => changes++);
  w.observe({ items: [item('Fluke multimeter', 'meter', 'reads 2.210 kΩ'), item('solder spools', 'spool', 'Kester 63/37'), item('pliers', 'tool', 'red handles')] });
  clock.t += 1000;
  w.observe({ items: [item('pliers', 'tool')] });
  assert.equal(changes, 2);
  assert.deepEqual(w.find('multimeter').map((e) => e.id), ['e1']);
  assert.deepEqual(w.find('where is the spool?').map((e) => e.id), ['e2'], 'filler words match nothing; a plural is its singular');
  assert.deepEqual(w.find('kester').map((e) => e.id), ['e2'], 'a word from a claim');
  assert.deepEqual(w.find('tool meter').map((e) => e.id), ['e3', 'e1'], 'any word; the most recent first on a tie');
  assert.deepEqual(w.find('red pliers handles meter').map((e) => e.id), ['e3', 'e1'], 'more words first');
  assert.deepEqual(w.find('E2').map((e) => e.id), ['e2'], 'an id');
  assert.deepEqual(w.find('the'), []); assert.deepEqual(w.find(''), []); assert.deepEqual(w.find('oscilloscope'), []);
  w.pin('e1'); w.pin('e1'); w.note('e1', 'mine');
  assert.equal(changes, 4, 'a pin that changes nothing is no event');
  assert.equal(w.forget('e3'), true); assert.equal(w.forget('e3'), false);
  assert.equal(changes, 5); assert.equal(w.get('e3'), null);
});

test('world: context is one line of the newest few, null when nothing is recent', () => {
  const { w, clock } = world({ contextItems: 2 });
  assert.equal(w.context(), null);
  assert.equal(w.id, 'world');
  w.observe({ items: [item('pliers'), item('solder spool')] }); clock.t += 1000;
  w.observe({ items: [item('multimeter', 'meter', '2.210 kΩ')] }); clock.t += 1000;
  w.pin('e1');
  assert.equal(w.context(), 'In view lately (names are from earlier glances and may be wrong): multimeter [e3] (2.210 kΩ), pliers [e1]');
  w.note('e3', 'x'.repeat(80));
  assert.equal(w.context(), `In view lately (names are from earlier glances and may be wrong): multimeter [e3] (${'x'.repeat(47)}…), pliers [e1]`);
  clock.t += 1801 * 1000;
  assert.equal(w.entities().length, 1, 'the pinned one is still on record');
  assert.equal(w.context(), null, 'but it is not in view');
});

test('world: persists debounced and atomically, thumbnails as JPEG files, and comes back', async () => {
  const dir = path.join(tmpdir('jet-world-'), 'world');   // does not exist yet
  const { w, clock } = world({ dir });
  await w.start();   // nothing there: an empty world, no complaint
  w.observe({ image: frame(), where: { lat: 37.5, lon: -122.25 }, scene: 'a bench', items: [item('meter', 'tool', '2.210 kΩ', [0, 0, 500, 500]), item('lamp', 'light', 'on', [600, 0, 1000, 500])] });
  w.pin('e2');
  assert.equal(fs.existsSync(path.join(dir, 'world.json')), false, 'not written at once');
  await new Promise((r) => setTimeout(r, 120));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(saved.entities.length, 2); assert.equal(saved.entities[1].pinned, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['crops', 'thumbs', 'world.json'], 'no temp file left');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'crops')).sort(), ['o1.jpg', 'o2.jpg'], 'each observation keeps its crop');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'thumbs')).sort(), ['e1.jpg', 'e2.jpg']);
  assert.equal(fs.readFileSync(path.join(dir, 'thumbs', 'e1.jpg')).readUInt16BE(0), 0xffd8);

  const { w: back } = world({ dir, now: () => clock.t + MIN });
  await back.start();
  assert.deepEqual(back.entities(), w.entities(), 'the same entities');
  assert.deepEqual(back.get('e1').where, { lat: 37.5, lon: -122.25 });
  assert.deepEqual(back.sightings(), w.sightings());
  const t = back.thumb('e1');
  assert.deepEqual([t.width, t.height], [96, 72]);
  assert.ok(t.data[0] > 200 && t.data[2] < 60, 'decoded from the file: the red side');
  assert.equal(back.thumb('e1'), t, 'decoded once');
  assert.ok(back.thumb('e2').data[2] > 200, 'the blue side');
  assert.equal(back.observe({ items: [item('probe')] })[0].id, 'e3', 'ids carry on');
  back.forget('e1');
  await back.flush();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'thumbs')), ['e2.jpg'], 'a forgotten entity takes its file with it');

  const { w: later } = world({ dir, now: () => clock.t + 3600 * 1000 });
  await later.start();
  assert.deepEqual(later.entities().map((e) => e.id), ['e2'], 'what expired while off is gone at load; the pinned one is not');
  await later.stop();
  fs.writeFileSync(path.join(dir, 'world.json'), '{"entities": [');
  const { w: broken } = world({ dir });
  await broken.start();
  assert.deepEqual(broken.entities(), [], 'a damaged file is an empty world');
});

test('sightings tool: the recent list, a query in detail, nothing', async () => {
  assert.deepEqual([0, 4000, 45000, 125000, 2 * 3600e3 + 5, 49 * 3600e3].map(ago), ['just now', 'just now', '45s ago', '2m ago', '2h ago', '2d ago']);
  const { w, clock } = world();
  const tool = Object.assign(new SightingsTool(), { world: w, recent: 12, matches: 5, claims: 2 });
  assert.equal(tool.name, 'sightings'); assert.equal(tool.parameters.properties.query.type, 'string');
  assert.equal(await tool.run({}), 'Nothing on record.');
  w.observe({ scene: 'electronics bench, someone soldering', where: { lat: 37.5, lon: -122.25 }, items: [item('Fluke multimeter', 'meter', 'reads 2.210 kΩ'), item('pliers', 'tool')] });
  clock.t += 2 * MIN;
  w.observe({ scene: 'electronics bench', items: [item('Fluke multimeter', 'meter', 'reads 0.4 V'), item('solder spool', 'spool', 'Kester')] });
  w.pin('e1'); w.note('e1', 'the one with the cracked case', 'agent');
  clock.t += 30000;
  assert.equal(await tool.run(), [
    'Scene 30s ago: electronics bench',
    'e1 Fluke multimeter (meter), pinned, seen 2x, last 30s ago: the one with the cracked case',
    'e3 solder spool (spool), seen 1x, last 30s ago: Kester',
    'e2 pliers (tool), seen 1x, last 2m ago',
  ].join('\n'));
  assert.equal(await tool.run({ query: ' the multimeter ' }), [
    'e1 Fluke multimeter (meter), pinned, seen 2x, last 30s ago, first 2m ago, at 37.50000,-122.25000',
    '  - the one with the cracked case (30s ago, agent)',
    '  - reads 0.4 V (30s ago)',
  ].join('\n'), 'claims newest first, capped');
  assert.equal(await tool.run({ query: 'e2' }), 'e2 pliers (tool), seen 1x, last 2m ago, first 2m ago, at 37.50000,-122.25000');
  assert.equal(await tool.run({ query: 'oscilloscope' }), 'Nothing on record matching "oscilloscope".');
  assert.equal(await tool.run({ query: 42 }), await tool.run({}), 'a query that is not text is no query');
});

test('world: observations keep the evidence - the model\'s own name, its note and a crop that is never enlarged; the newest few and the largest survive', () => {
  const { w, clock } = world({ maxCrops: 3 });
  w.observe({ image: frame(), items: [item('bench meter', 'tool', 'big view', [0, 0, 1000, 1000])] });   // the largest crop
  for (let i = 0; i < 4; i++) { clock.t += 1000; w.observe({ image: frame(), items: [item('bench meter', 'tool', `view ${i}`, [100, 100, 200, 200])] }); }
  const e = w.get('e1');
  assert.deepEqual(e.obs.map((o) => o.id), ['o1', 'o4', 'o5'], 'three kept: the largest and the two newest');
  assert.deepEqual({ ...e.obs[0], area: undefined }, { id: 'o1', t: e.firstSeen, name: 'bench meter', kind: 'tool', note: 'big view', area: undefined });
  assert.equal(e.obs[0].area, 320 * 240, 'the whole frame fitted to 320x240');
  assert.ok(e.obs[2].area < 80 * 60, 'a small box stays small: 64x48 plus the pad');
  assert.equal(w.crop('o1').readUInt16BE(0), 0xffd8, 'a JPEG');
  assert.equal(w.crop('o2'), null, 'a trimmed observation has no crop'); assert.equal(w.crop('o99'), null);
  assert.equal(e.claims.length, 5, 'the readable log is not trimmed with them');
});

test('world: merge folds one entity into another; split gives an observation an entity of its own', () => {
  const { w, clock } = world();
  w.observe({ image: frame(), items: [item('Weller WLC100', 'instrument', 'blue station', [0, 0, 400, 400])] }); clock.t += 1000;
  w.observe({ image: frame(), items: [item('grey soldering station', 'instrument', 'dial and switch', [500, 0, 900, 400]), item('cat lamp', 'lamp')] }); clock.t += 1000;
  const events = []; w.on('change', () => events.push('change'));
  const m = w.merge('e2', 'e1');
  assert.equal(m.id, 'e1'); assert.equal(m.name, 'Weller WLC100', 'the entity merged into keeps its name');
  assert.deepEqual(m.aliases, ['grey soldering station']);
  assert.deepEqual(m.obs.map((o) => o.id), ['o1', 'o2']); assert.deepEqual(m.claims.map((c) => c.text), ['blue station', 'dial and switch']);
  assert.equal(m.seen, 2); assert.equal(m.lastSeen, clock.t - 1000);
  assert.equal(w.get('e2'), null); assert.ok(w.crop('o2'), 'the crop went with its observation');
  assert.deepEqual(w.sightings()[0].entityIds, ['e1', 'e3'], 'the frame log follows');
  const hue = (id) => { const t = w.thumb(id), i = ((t.height >> 1) * t.width + (t.width >> 1)) * 4; return t.data[i] > t.data[i + 2] ? 'red' : 'blue'; };   // the middle pixel (the crop is a JPEG, and padded)
  assert.equal(hue('e1'), 'blue', 'the thumbnail is the newest crop (the blue half)');
  assert.equal(w.merge('e1', 'e1'), null); assert.equal(w.merge('e9', 'e1'), null);

  const n = w.split('o2');
  assert.equal(n.id, 'e4'); assert.equal(n.name, 'grey soldering station', 'under the name it was observed by');
  assert.deepEqual(n.claims.map((c) => c.text), ['dial and switch']); assert.deepEqual(n.obs.map((o) => o.id), ['o2']);
  const e1 = w.get('e1');
  assert.deepEqual(e1.obs.map((o) => o.id), ['o1']); assert.deepEqual(e1.claims.map((c) => c.text), ['blue station']); assert.equal(e1.seen, 1);
  assert.equal(hue('e1'), 'red', 'and the thumbnail goes back to what is left');
  assert.equal(w.split('o1'), null, 'the only observation of an entity is not split off');
  assert.equal(w.mark('o1', 'same'), true); assert.equal(w.get('e1').obs[0].checked, 'same'); assert.equal(w.mark('o77', 'x'), false);
  assert.equal(events.length, 3);
});

test('world: observe announces which observation went where; a model number nobody read is flagged on the context line', () => {
  const { w, clock } = world();
  const seen = []; w.on('observed', (o) => seen.push(o));
  w.observe({ items: [item('Weller WLC100', 'instrument', 'blue station with a dial')] }); clock.t += 1000;
  w.observe({ items: [item('Weller WLC100', 'instrument', 'label reads "WELLER"'), item('Fluke 117', 'meter', 'yellow, "117" on the face')] });
  assert.deepEqual(seen.map((o) => o.entries), [[{ obs: 'o1', entity: 'e1', created: true }], [{ obs: 'o2', entity: 'e1', created: false }, { obs: 'o3', entity: 'e2', created: true }]]);
  assert.equal(unreadModel(w.get('e1')), true); assert.equal(unreadModel(w.get('e2')), false); assert.equal(unreadModel({ name: 'cat lamp', claims: [] }), false);
  assert.match(w.context(), /Weller WLC100 \(model number is a guess\) \[e1\].*Fluke 117 \[e2\]|Fluke 117 \[e2\].*Weller WLC100 \(model number is a guess\) \[e1\]/);
});
