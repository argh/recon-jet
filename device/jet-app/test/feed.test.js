// The feed model against a temp directory: the ring, the `post` event, the round trip through
// feed.json and the card pictures (JPEG on disk, RGBA in memory), and the `show` tool that posts
// cards for the agent - with and without an entity's thumbnail, and injected as a `Tool` by the
// container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { Feed } from '../src/modules/feed/index.js';
import { ShowTool } from '../src/modules/feed/show-tool.js';
import { tmpdir } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what = 'condition') { for (let i = 0; i < 1200; i++) { if (cond()) return; await sleep(5); } throw new Error(`timeout: ${what}`); }

function make({ dir = tmpdir('jet-feed-'), ...extra } = {}) {
  let t = 1000;
  const feed = Object.assign(new Feed(), { dir, maxItems: 100, saveMs: 100000, jpegQuality: 90, logger: null, ...extra });
  feed.now = () => (t += 1000);
  return feed;
}
/** A flat-coloured RGBA picture (flat, so it survives the JPEG round trip nearly exactly). */
function picture(w, h, [r, g, b]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return { width: w, height: h, data };
}

test('feed: post appends an item, emits it, and the ring drops the oldest', () => {
  const feed = make({ dir: '', maxItems: 3 });
  const seen = [];
  feed.on('post', (item) => seen.push(item.id));
  const first = feed.post({ kind: 'heard', body: '  what is this  ' });
  assert.deepEqual(first, { id: 'f1', t: 2000, kind: 'heard', body: 'what is this' }, 'trimmed, stamped, no empty fields');
  assert.ok(Object.isFrozen(first), 'an item is a record');
  feed.post({ kind: 'said', body: 'A meter.' });
  feed.post({ kind: 'card', title: 'Ranges', body: '600 / 6k', entity: 'e7' });
  assert.deepEqual(feed.items.map((x) => x.kind), ['heard', 'said', 'card'], 'oldest first');
  assert.deepEqual(feed.get('f3'), { id: 'f3', t: 4000, kind: 'card', title: 'Ranges', body: '600 / 6k', entity: 'e7' });
  feed.post({ kind: 'heard', body: 'four' }); feed.post({ kind: 'said', body: 'five' });
  assert.deepEqual(feed.items.map((x) => x.id), ['f3', 'f4', 'f5'], 'a ring of maxItems');
  assert.equal(feed.get('f1'), null);
  assert.deepEqual(seen, ['f1', 'f2', 'f3', 'f4', 'f5']);
  feed.items.push('x');
  assert.equal(feed.items.length, 3, 'items is a copy');
  assert.throws(() => feed.post({ kind: 'shout', body: 'x' }), /unknown kind/);
  assert.equal(feed.items.length, 3);
});

test('feed: survives a restart - text in feed.json, pictures as JPEG, ids carry on', async () => {
  const dir = tmpdir('jet-feed-');
  const a = make({ dir });
  await a.start();   // nothing there yet: an empty feed, not an error
  assert.deepEqual(a.items, []);
  a.post({ kind: 'heard', body: 'what gauge is that' });
  a.post({ kind: 'card', title: 'Solder', body: '0.8 mm\nleaded', entity: 'e6', image: picture(24, 16, [200, 40, 40]) });
  a.post({ kind: 'said', body: 'Zero point eight.' });
  assert.ok(!fs.existsSync(path.join(dir, 'feed.json')), 'writes are debounced');
  await a.stop();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['f2.jpg', 'feed.json'], 'an atomic write leaves no temp file');
  assert.equal(fs.readFileSync(path.join(dir, 'f2.jpg'))[0], 0xff, 'a JPEG');
  assert.ok(!fs.readFileSync(path.join(dir, 'feed.json'), 'utf8').includes('"data"'), 'no pixels in the index');

  const b = make({ dir });
  await b.start();
  assert.deepEqual(b.items.map(({ image, ...x }) => x), a.items.map(({ image, ...x }) => x), 'the same items');
  const { image } = b.get('f2');
  assert.deepEqual([image.width, image.height, image.data.length], [24, 16, 24 * 16 * 4], 'the picture is RGBA again');
  const [r, g, bl] = image.data.subarray(4 * (8 * 24 + 12));
  assert.ok(Math.abs(r - 200) < 12 && Math.abs(g - 40) < 12 && Math.abs(bl - 40) < 12, `the colour came back (${r}, ${g}, ${bl})`);
  assert.equal(b.post({ kind: 'heard', body: 'next' }).id, 'f4', 'ids are unique across restarts');
  await b.stop();
});

test('feed: the debounced write lands by itself; a dropped card takes its picture; strays are swept', async () => {
  const dir = tmpdir('jet-feed-');
  const feed = make({ dir, maxItems: 2, saveMs: 20 });
  await feed.start();
  feed.post({ kind: 'card', title: 'one', image: picture(8, 8, [0, 0, 255]) });
  await until(() => fs.existsSync(path.join(dir, 'feed.json')), 'feed.json written after saveMs');
  assert.ok(fs.existsSync(path.join(dir, 'f1.jpg')));
  feed.post({ kind: 'said', body: 'two' }); feed.post({ kind: 'said', body: 'three' });
  await feed.flush();
  assert.ok(!fs.existsSync(path.join(dir, 'f1.jpg')), 'the ring dropped the card: its picture goes too');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'feed.json'), 'utf8')).items.map((x) => x.id), ['f2', 'f3']);

  fs.writeFileSync(path.join(dir, 'f99.jpg'), 'left by a run that died');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'not ours');
  const again = make({ dir });
  await again.start();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['feed.json', 'keep.txt'], 'a picture no item owns is removed, nothing else is touched');

  fs.writeFileSync(path.join(dir, 'feed.json'), '{ not json');
  const broken = make({ dir });
  await broken.start();
  assert.deepEqual(broken.items, [], 'a damaged file is an empty feed');
  const card = { v: 1, seq: 7, items: [{ id: 'f7', t: 1, kind: 'card', title: 'no picture left', image: true }, { id: 'x', kind: 'nonsense' }] };
  fs.writeFileSync(path.join(dir, 'feed.json'), JSON.stringify(card));
  const lost = make({ dir });
  await lost.start();
  assert.deepEqual(lost.items, [{ id: 'f7', t: 1, kind: 'card', title: 'no picture left' }], 'a card whose picture is gone stays, without it');
});

test('show tool: posts a card; a named entity brings the world\'s thumbnail as a copy', async () => {
  const feed = make({ dir: '' });
  const thumb = picture(96, 72, [10, 200, 10]);
  const world = { asked: [], thumb(id) { this.asked.push(id); return id === 'e7' ? thumb : null; } };
  const show = Object.assign(new ShowTool(), { feed, world, logger: null });
  assert.equal(show.name, 'show'); assert.equal(show.silent, true);
  assert.deepEqual(show.parameters.required, ['title', 'body']);
  assert.deepEqual(Object.keys(show.parameters.properties), ['title', 'body', 'entity']);
  assert.match(show.description, /card/);

  assert.equal(await show.run({ title: 'Fluke 117', body: 'Ohms to 40M', entity: 'e7' }), 'shown');
  const card = feed.items.at(-1);
  assert.deepEqual([card.kind, card.title, card.body, card.entity], ['card', 'Fluke 117', 'Ohms to 40M', 'e7']);
  assert.deepEqual([card.image.width, card.image.height], [96, 72]);
  assert.notEqual(card.image.data, thumb.data, 'the card keeps its own pixels');
  thumb.data.fill(0);   // the world replaces its thumbnail on the next sighting
  assert.deepEqual([...card.image.data.subarray(0, 4)], [10, 200, 10, 255]);

  assert.equal(await show.run({ title: 'Steps', body: '1. Flux' }), 'shown');
  assert.deepEqual(feed.items.at(-1), { id: 'f2', t: feed.items.at(-1).t, kind: 'card', title: 'Steps', body: '1. Flux' }, 'no entity: a plain card');
  assert.equal(await show.run({ title: 'Ghost', body: 'gone', entity: 'e99' }), 'shown');
  assert.equal(feed.items.at(-1).image, undefined); assert.equal(feed.items.at(-1).entity, undefined, 'an entity without a picture is not recorded');
  assert.deepEqual(world.asked, ['e7', 'e99']);

  show.world = null;   // lax: the tool works before the world model exists
  assert.equal(await show.run({ title: 'Alone', body: 'x', entity: 'e7' }), 'shown');
  assert.equal(feed.items.at(-1).image, undefined);
  await assert.rejects(show.run({}), /title/, 'the agent turns a throw into an error result');
  await assert.rejects(show.run({ title: ' ', body: '' }), /title/);
  assert.equal(feed.items.length, 4);
});

test('feed: the container builds the show tool as a Tool, with the feed and the world injected', async () => {
  const mm = new ModuleManager(), s = Schema.create;
  const world = Object.assign(new EventEmitter(), { thumb: () => null });
  mm.registerInstance(world, { name: 'world', lifecycle: false });
  class Harness {
    static moduleInfo = { name: 'harness', isMain: true, schema: s().property('feed', s('Feed').required()).property('tools', s('array').property('*', s('Tool')).default(['show-tool'])) };
    feed; tools = [];
  }
  mm.register(Harness).register(Feed);
  const config = await mm.configure({ argv: [], env: {}, defaults: { feed: { dir: '', maxItems: 7 } } });
  await mm.initModules(config);
  const { feed, tools } = mm.getModuleInstance('harness');
  assert.ok(feed instanceof Feed); assert.equal(feed.maxItems, 7);
  assert.equal(tools.length, 1); assert.ok(tools[0] instanceof ShowTool);
  assert.equal(tools[0].feed, feed); assert.equal(tools[0].world, world);
  assert.equal(await tools[0].run({ title: 'Wired', body: 'by the container' }), 'shown');
  assert.equal(feed.items.at(-1).title, 'Wired');
});

test('feed: a clip is attached after the words, read back on demand, persisted, and goes with its item', async () => {
  const dir = path.join(tmpdir('jet-feed-'), 'feed');
  const feed = Object.assign(new Feed(), { dir, maxItems: 2, saveMs: 5, jpegQuality: 75 });
  await feed.start();
  const changes = []; feed.on('change', (i) => changes.push(i));
  const said = feed.post({ kind: 'said', body: 'Copy.' });
  assert.equal(said.audio, undefined); assert.equal(await feed.audio(said.id), null);
  const pcm = Buffer.alloc(48000, 7);   // 1 s of 24 kHz mono S16
  const now = feed.attach(said.id, { audio: { rate: 24000, channels: 1, pcm } });
  assert.deepEqual(now.audio, { rate: 24000, channels: 1, seconds: 1 }); assert.equal(feed.get(said.id), now); assert.deepEqual(changes, [now]);
  assert.deepEqual(await feed.audio(said.id), { rate: 24000, channels: 1, pcm });
  assert.equal(feed.attach('f99', { audio: { rate: 24000, pcm } }), null); assert.equal(feed.attach(said.id, { audio: { rate: 24000, pcm: Buffer.alloc(0) } }), null);
  const heard = feed.post({ kind: 'heard', body: 'hello', audio: { rate: 16000, channels: 1, pcm: Buffer.alloc(3200) } });
  assert.equal(heard.audio.seconds, 0.1, 'a clip can come with the post');
  assert.equal(feed.post({ kind: 'photo', image: { width: 2, height: 2, data: new Uint8Array(16).fill(200) } }).kind, 'photo');
  await feed.flush();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['f2.pcm', 'f3.jpg', 'feed.json'], 'the first item fell off the ring, its clip with it');
  const back = Object.assign(new Feed(), { dir, maxItems: 2, saveMs: 5, jpegQuality: 75 });
  await back.start();
  assert.equal((await back.audio('f2')).pcm.length, 3200); assert.equal(back.get('f3').image.width, 2);
});

test('feed: export hands the newest out as WAV and JPEG; clear empties it, files too', async () => {
  const dir = path.join(tmpdir('jet-feed-'), 'feed');
  const feed = Object.assign(new Feed(), { dir, maxItems: 50, saveMs: 5, jpegQuality: 75 });
  await feed.start();
  feed.post({ kind: 'heard', body: 'specs please', audio: { rate: 16000, channels: 1, pcm: Buffer.alloc(3200, 1) } });
  feed.post({ kind: 'said', body: 'On your display.' });
  feed.post({ kind: 'card', title: 'Specs', body: '418 ft', image: { width: 4, height: 3, data: new Uint8Array(48).fill(90) } });
  assert.deepEqual(feed.items.map((x) => x.kind), ['heard', 'said', 'card'], 'in the order they were posted');
  const out = await feed.export(2);
  assert.deepEqual(out.map((x) => [x.kind, Boolean(x.wav), Boolean(x.jpeg)]), [['said', false, false], ['card', false, true]]);
  const all = await feed.export(10);
  assert.equal(all[0].wav.toString('latin1', 0, 4), 'RIFF'); assert.equal(all[0].wav.length, 44 + 3200); assert.equal(all[0].wav.readUInt32LE(24), 16000);
  assert.equal(all[2].jpeg.readUInt16BE(0), 0xffd8); assert.equal(all[0].audio, undefined, 'the export carries files, not the in-memory fields');
  const changes = []; feed.on('change', (x) => changes.push(x));
  assert.equal(feed.clear(), 3); assert.deepEqual(feed.items, []); assert.deepEqual(changes, [null]);
  await feed.flush();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['feed.json']);
});
