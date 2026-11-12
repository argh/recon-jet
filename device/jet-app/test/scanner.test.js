// The scanner: the tolerant reply parser, one scan end to end (real Camera and World, a fake
// model), the trigger state machine on mocked timers, the `look` tool, and the container wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import jpegJs from 'jpeg-js';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { Scanner, parseScan } from '../src/modules/scanner/index.js';
import { LookTool } from '../src/modules/scanner/look-tool.js';
import { Camera } from '../src/modules/camera/index.js';
import { World } from '../src/modules/world/index.js';
import { fakeLink, settle, tmpdir } from './helpers.js';

const REPLY = JSON.stringify({ scene: 'electronics bench, soldering in progress', items: [
  { name: 'Fluke multimeter', kind: 'meter', box: [100, 200, 400, 700], note: 'display reads 2.210 kΩ' },
  { name: 'solder spool', kind: 'spool', box: [600, 100, 800, 300], note: 'Kester 63/37' },
] });

const mkWorld = (over = {}) => Object.assign(new World(), { dir: '', ttlS: 1800, maxEntities: 60, maxClaims: 20, maxSightings: 200, thumbW: 96, thumbH: 72, thumbPad: 0.08, thumbQuality: 75, contextItems: 5, saveMs: 20, logger: null }, over);

/** A model that answers when the test says so: `calls[i].resolve(text)` / `.reject(error)`. */
function fakeLlm(auto) {
  const llm = { calls: [], chat(request) {
    if (auto !== undefined) { this.calls.push({ request }); return Promise.resolve({ content: auto, toolCalls: [], usage: { prompt: 500, completion: 80, cached: 0 } }); }
    return new Promise((resolve, reject) => this.calls.push({ request, resolve: (content = REPLY) => resolve({ content, toolCalls: [], usage: { prompt: 500, completion: 80, cached: 0 } }), reject }));
  } };
  return llm;
}
/** A camera that costs nothing: a tiny frame, a token JPEG; counts captures. */
const fakeCamera = () => ({ captures: 0, async capture() { this.captures++; return { width: 8, height: 8, data: new Uint8Array(256).fill(255), t: Date.now() }; }, jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });

function scanner(over = {}) {
  const sc = Object.assign(new Scanner(), { model: 'qwen-vision', prompt: 'Scan. At most {maxItems}.', maxItems: 6, maxTokens: 400, intervalS: 10, minGapMs: 3000, maxScanS: 180, jpegQuality: 70,
    camera: fakeCamera(), world: mkWorld(), llm: fakeLlm(), sensors: new EventEmitter(), gps: null, logger: null }, over);
  const states = [], scans = [];
  sc.on('state', (s) => states.push(s)); sc.on('scan', (e) => scans.push(e));
  sc.attach();
  return { sc, states, scans, llm: sc.llm, sensors: sc.sensors };
}

test('parseScan: the object asked for, fenced, wrapped in prose, or a bare array', () => {
  const want = { scene: 'electronics bench, soldering in progress', items: [
    { name: 'Fluke multimeter', kind: 'meter', box: [100, 200, 400, 700], note: 'display reads 2.210 kΩ' },
    { name: 'solder spool', kind: 'spool', box: [600, 100, 800, 300], note: 'Kester 63/37' }] };
  assert.deepEqual(parseScan(REPLY), want);
  assert.deepEqual(parseScan('```json\n' + JSON.stringify(JSON.parse(REPLY), null, 2) + '\n```'), want);
  assert.deepEqual(parseScan(`Here is what I see:\n${REPLY}\nLet me know if you need more.`), want);
  assert.deepEqual(parseScan('```json\n' + JSON.stringify(JSON.parse(REPLY).items) + '\n```'), { scene: '', items: want.items }, 'a bare array has no scene');
  assert.deepEqual(parseScan('{"scene": "a blank wall", "items": []}'), { scene: 'a blank wall', items: [] });
  for (const junk of ['', null, undefined, 'I cannot see anything.', '{}', '[]', '42', '{"items": "none"}']) assert.deepEqual(parseScan(junk), { scene: '', items: [] }, String(junk));
});

test('parseScan: the model\'s other spellings (label, bbox_2d, objects) and untidy fields', () => {
  const { items } = parseScan(JSON.stringify([
    { label: ' Kester  solder ', bbox_2d: [10, 20, 300, 400], description: 'a spool' },
    { name: 'pliers', kind: 'Hand Tool', bbox: ['10', '20', '30', '40'], note: 7 },
    { kind: 'thing', box: [1, 2, 300, 400], note: 'no name: not an item' },
    { name: '', box: [1, 2, 300, 400] },
    'pliers', null,
  ]));
  assert.deepEqual(items, [
    { name: 'Kester solder', kind: '', box: [10, 20, 300, 400], note: 'a spool' },
    { name: 'pliers', kind: 'hand', box: [10, 20, 30, 40], note: '7' },
  ]);
  assert.equal(parseScan('{"scene": "desk", "objects": [{"label": "mug", "bbox_2d": [1, 2, 300, 400]}]}').items[0].name, 'mug');
  assert.deepEqual(parseScan('{"label": "mug", "bbox_2d": [1, 2, 300, 400]}').items.map((i) => i.name), ['mug'], 'a lone item');
});

test('parseScan: boxes are clamped to 0..1000 and ordered; a degenerate or malformed one is dropped, the item kept', () => {
  const box = (b) => parseScan(JSON.stringify([{ name: 'x', box: b }])).items[0].box;
  assert.deepEqual(box([-20, 500.4, 1200, 999.6]), [0, 500, 1000, 1000]);
  assert.deepEqual(box([800, 600, 200, 100]), [200, 100, 800, 600], 'corners swapped');
  assert.equal(box([500, 500, 500, 900]), null, 'no width');
  assert.equal(box([1100, 100, 1300, 300]), null, 'wholly outside: nothing left after clamping');
  assert.equal(box([1, 2, 3]), null); assert.equal(box('1 2 3 4'), null); assert.equal(box([1, 2, null, 4]), null); assert.equal(box([1, 2, 'x', 4]), null);
  assert.equal(box(undefined), null);
});

test('parseScan: a reply cut off at the token limit keeps its complete items', () => {
  const cut = REPLY.slice(0, REPLY.indexOf('"Kester') + 4);   // mid-string in the second item
  assert.deepEqual(parseScan(cut), { scene: 'electronics bench, soldering in progress', items: [{ name: 'Fluke multimeter', kind: 'meter', box: [100, 200, 400, 700], note: 'display reads 2.210 kΩ' }] });
  assert.deepEqual(parseScan('```json\n' + REPLY.slice(0, -2)).items.length, 2, 'only the closing brackets missing');
  const array = JSON.stringify(JSON.parse(REPLY).items);
  assert.deepEqual(parseScan(array.slice(0, array.indexOf('"box"', 120) + 12)).items.map((i) => i.name), ['Fluke multimeter'], 'a bare array cut inside a box');
  assert.deepEqual(parseScan('{"scene": "a \\"lab\\" {bench}", "items": [{"name": "brace } in a note", "kind": "x", "box": [1,2,300,400], "note": "says {ok}"}, {"name": "cu'),
    { scene: 'a "lab" {bench}', items: [{ name: 'brace } in a note', kind: 'x', box: [1, 2, 300, 400], note: 'says {ok}' }] }, 'braces and quotes inside strings do not confuse the salvage');
  assert.deepEqual(parseScan('{"scene": "half a sce'), { scene: '', items: [] });
});

test('scanner: one scan is capture -> jpeg -> one vision call -> world.observe, with the fix as where', async () => {
  const link = fakeLink(), world = mkWorld(), logs = [];
  const camera = Object.assign(new Camera(), { deviceLink: link, logger: null });
  let fix = { lat: 37.5, lon: -122.25, good: true, satsUsed: 7, at: 1 };
  const { sc, llm, states, scans } = scanner({ camera, world, gps: { goodFix: () => fix }, logger: { info: (o, m) => logs.push(m), warn: (o, m) => logs.push(m) } });
  assert.equal(sc.state, 'off'); assert.equal(sc.active, false);
  const p = sc.scanOnce();
  assert.equal(sc.state, 'looking'); assert.equal(sc.active, false, 'a single scan does not switch scanning on');
  await settle();
  assert.equal(link.sent.at(-1), 'S 640 480');
  const { request } = llm.calls[0];
  assert.equal(request.model, 'qwen-vision'); assert.equal(request.maxTokens, 400); assert.equal(request.messages.length, 1);
  const [picture, prompt] = request.messages[0].content;
  assert.equal(request.messages[0].role, 'user');
  assert.equal(picture.type, 'image_url'); assert.match(picture.image_url.url, /^data:image\/jpeg;base64,\/9j\//);
  const sent = jpegJs.decode(Buffer.from(picture.image_url.url.split(',')[1], 'base64'));
  assert.deepEqual([sent.width, sent.height], [640, 480], 'the frame goes out at full resolution');
  assert.deepEqual(prompt, { type: 'text', text: 'Scan. At most 6.' }, 'an empty world offers no names');
  fix = null;   // the fix is read as the frame is taken, not when the model answers
  llm.calls[0].resolve('```json\n' + REPLY + '\n```');
  const entities = await p;
  assert.deepEqual(entities.map((e) => [e.id, e.name, e.kind, e.claims[0].text]), [['e1', 'Fluke multimeter', 'meter', 'display reads 2.210 kΩ'], ['e2', 'solder spool', 'spool', 'Kester 63/37']]);
  assert.deepEqual(entities[0].where, { lat: 37.5, lon: -122.25 });
  assert.deepEqual(world.entities(), entities);
  assert.equal(world.sightings()[0].scene, 'electronics bench, soldering in progress');
  const thumb = world.thumb('e1');
  assert.ok(thumb.width <= 96 && thumb.height === 72, 'the box became a thumbnail');
  assert.deepEqual(states, ['looking', 'off']); assert.equal(sc.state, 'off');
  assert.equal(scans.length, 1); assert.equal(scans[0].entities, entities); assert.equal(typeof scans[0].ms, 'number');
  assert.equal(sc.scans, 1); assert.equal(sc.failures, 0); assert.deepEqual(logs, ['scanner: scan']);

  // the second scan offers the names the world knows; no fix, no where
  const q = sc.scanOnce(); await settle();
  assert.equal(llm.calls[1].request.messages[0].content[1].text, 'Scan. At most 6.\nSeen here before: Fluke multimeter, solder spool. Reuse one of these names, exactly, only for the very same physical object; a different object gets a new name even if it carries the same brand or text.');
  llm.calls[1].resolve(JSON.stringify({ scene: 'bench', items: [{ name: 'Solder Spool', kind: 'wire', box: [1, 1, 500, 500], note: 'Kester 63/37' }, { name: 'tweezers', kind: 'tool', box: [5, 5, 50, 50], note: '' }] }));
  assert.deepEqual((await q).map((e) => [e.id, e.seen, e.where]), [['e2', 2, { lat: 37.5, lon: -122.25 }], ['e3', 1, undefined]], 'a reused name is the same thing whatever kind the model calls it this time; it keeps where it was last placed');
  assert.equal(world.get('e2').kind, 'spool');
});

test('scanner: a given image is scanned without a capture; maxItems bounds what is filed', async () => {
  const { sc, llm } = scanner({ maxItems: 2 });
  const image = { width: 4, height: 4, data: new Uint8Array(64), t: 777 };
  const p = sc.scanOnce({ image }); await settle();
  assert.equal(sc.camera.captures, 0);
  llm.calls[0].resolve(JSON.stringify({ scene: 's', items: ['a', 'b', 'c', 'd'].map((name) => ({ name, kind: 'k', box: [0, 0, 500, 500], note: '' })) }));
  assert.deepEqual((await p).map((e) => e.name), ['a', 'b']);
  assert.equal(sc.world.sightings()[0].t, 777, 'the sighting is dated by the frame');
});

test('scanner: scans are single flight; failures are counted and never thrown', async () => {
  const { sc, llm, states, scans } = scanner();
  const a = sc.scanOnce(), b = sc.scanOnce({ image: { width: 1, height: 1, data: new Uint8Array(4) } });
  assert.equal(a, b, 'a scan asked for while one runs joins it');
  await settle();
  assert.equal(llm.calls.length, 1); assert.equal(sc.camera.captures, 1);
  llm.calls[0].reject(new Error('503 loading model'));
  assert.deepEqual(await a, []);
  assert.equal(sc.failures, 1); assert.equal(sc.lastError, '503 loading model'); assert.equal(sc.scans, 0); assert.equal(sc.state, 'off');
  const c = sc.scanOnce(); await settle();
  llm.calls[1].resolve('Sorry, I can only see a blur.');
  assert.deepEqual(await c, []);
  assert.equal(sc.failures, 2); assert.match(sc.lastError, /unreadable reply: Sorry/);
  sc.camera.capture = async () => { throw new Error('not connected'); };
  assert.deepEqual(await sc.scanOnce(), []);
  assert.equal(sc.failures, 3); assert.equal(sc.lastError, 'not connected'); assert.equal(llm.calls.length, 2, 'no frame, no call');
  delete sc.camera.capture; Object.assign(sc.camera, fakeCamera());
  const d = sc.scanOnce(); await settle(); llm.calls[2].resolve();
  assert.equal((await d).length, 2);
  assert.equal(sc.lastError, null, 'a good scan clears the error'); assert.equal(sc.failures, 3); assert.equal(sc.scans, 1);
  assert.equal(scans.length, 1, 'only a filed frame is a scan event');
  assert.deepEqual(states, ['looking', 'off', 'looking', 'off', 'looking', 'off', 'looking', 'off']);
  assert.equal(sc.world.sightings().length, 1);
});

test('scanner: while on, the next scan follows the interval or a new view, never inside the gap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { sc, llm, states, sensors } = scanner();
  sensors.emit('view', { degrees: 40 }); await settle();
  assert.equal(llm.calls.length, 0, 'a new view while off is nothing');
  sc.start(); sc.start();
  assert.equal(sc.active, true); assert.deepEqual(states, ['idle', 'looking'], 'on: a scan at once');
  await settle(); assert.equal(llm.calls.length, 1);
  t.mock.timers.tick(60000); await settle();
  assert.equal(llm.calls.length, 1, 'nothing is started while one runs, however long it takes');
  llm.calls[0].resolve(); await settle();
  assert.equal(sc.state, 'idle'); assert.equal(sc.scans, 1);

  t.mock.timers.tick(9999); await settle(); assert.equal(llm.calls.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(llm.calls.length, 2, 'intervalS after the last one finished');
  assert.equal(sc.state, 'looking');
  llm.calls[1].resolve(); await settle();

  t.mock.timers.tick(1000);
  sensors.emit('view', { degrees: 35 }); await settle();
  assert.equal(llm.calls.length, 2, 'a new view inside the gap waits');
  t.mock.timers.tick(1999); await settle(); assert.equal(llm.calls.length, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(llm.calls.length, 3, 'and goes when minGapMs is up');
  t.mock.timers.tick(20000); await settle(); assert.equal(llm.calls.length, 3, 'the interval timer it replaced does not fire a second one');
  llm.calls[2].resolve(); await settle();

  t.mock.timers.tick(5000);
  sensors.emit('view', { degrees: 50 }); await settle();
  assert.equal(llm.calls.length, 4, 'a new view after the gap scans at once');
  sensors.emit('view', { degrees: 50 }); sensors.emit('view', { degrees: 50 });   // head still turning while it looks
  llm.calls[3].resolve(); await settle();
  t.mock.timers.tick(2999); await settle(); assert.equal(llm.calls.length, 4);
  t.mock.timers.tick(1); await settle(); assert.equal(llm.calls.length, 5, 'views during a scan make the next one come at the gap, once');
  llm.calls[4].reject(new Error('timeout')); await settle();
  assert.equal(sc.failures, 1); assert.equal(sc.state, 'idle');
  t.mock.timers.tick(10000); await settle(); assert.equal(llm.calls.length, 6, 'a failure does not stop the scanning');

  assert.equal(sc.toggle(), false);
  assert.equal(sc.state, 'looking', 'off, but the scan in flight finishes');
  llm.calls[5].resolve(); await settle();
  assert.equal(sc.state, 'off'); assert.equal(sc.scans, 5, 'and is filed');
  sensors.emit('view', { degrees: 50 }); t.mock.timers.tick(600000); await settle();
  assert.equal(llm.calls.length, 6, 'nothing follows');
  assert.deepEqual(states.slice(-3), ['idle', 'looking', 'off']);
  assert.equal(sc.toggle(), true); await settle();
  assert.equal(llm.calls.length, 7, 'on again: a scan at once (the gap is long past)');
  sc.stop();
});

test('scanner: switches itself off after maxScanS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { sc, llm } = scanner({ llm: fakeLlm(REPLY), maxScanS: 60 });
  sc.start();
  for (let s = 0; s < 59; s++) { await settle(); t.mock.timers.tick(1000); }
  await settle();
  assert.equal(sc.active, true); assert.equal(llm.calls.length, 6, 'at 0, 10 ... 50 s');
  t.mock.timers.tick(1000); await settle();
  assert.equal(sc.active, false); assert.equal(sc.state, 'off');
  t.mock.timers.tick(120000); await settle();
  assert.equal(llm.calls.length, 6);
  sc.start(); await settle();
  assert.equal(llm.calls.length, 7, 'switched on again, it gets its full time again');
  t.mock.timers.tick(59000); await settle(); assert.equal(sc.active, true);
  t.mock.timers.tick(1000); await settle(); assert.equal(sc.active, false);
});

test('look tool: returns the frame as a JPEG and files it through the scanner in the background', async () => {
  const camera = Object.assign(new Camera(), { deviceLink: fakeLink(), logger: null });
  const scans = [], warned = [];
  let fail = null;
  const tool = Object.assign(new LookTool(), { jpegQuality: 70, camera, logger: { warn: (o, m) => warned.push([m, o.error]) },
    scanner: { scanOnce(arg) { scans.push(arg); return fail ? Promise.reject(fail) : Promise.resolve([]); } } });
  assert.equal(tool.name, 'look'); assert.match(tool.description, /See through the glasses/); assert.deepEqual(Object.keys(tool.parameters.properties), ['item']);
  assert.ok(!tool.silent);
  const out = await tool.run({}, {});
  assert.equal(typeof out.text, 'string'); assert.ok(Buffer.isBuffer(out.image));
  const decoded = jpegJs.decode(out.image);
  assert.deepEqual([decoded.width, decoded.height], [640, 480]);
  await settle();
  assert.equal(scans.length, 1); assert.deepEqual([scans[0].image.width, scans[0].image.height], [640, 480], 'the same frame is scanned');
  fail = new Error('boom');
  assert.ok((await tool.run()).image.length > 100, 'a scan that throws does not fail the look');
  await settle();
  assert.deepEqual(warned, [['look: scan failed', 'boom']]);
  tool.scanner = { scanOnce() { throw new Error('sync boom'); } };
  await tool.run(); await settle();
  assert.equal(warned.length, 2);
  // a frame held at question time is the one looked at, once; then it is a fresh one again
  let captures = 0;
  const held = { width: 2, height: 2, data: new Uint8Array(16).fill(9), t: 1 };
  tool.scanner = { scanOnce(arg) { scans.push(arg); return Promise.resolve([]); } };
  tool.camera = { held: () => (captures++ ? null : Promise.resolve(held)), capture: async () => ({ width: 4, height: 4, data: new Uint8Array(64), t: 2 }), jpeg: (im) => Buffer.from([im.width]) };
  assert.deepEqual([...(await tool.run()).image], [2], 'the held frame'); assert.deepEqual([...(await tool.run({})).image], [4], 'then a fresh one');
  // with an item: the picture on record, no camera
  const crops = { o5: Buffer.from('JPEG-big'), o6: Buffer.from('JPEG-small') };
  tool.world = { get: (id) => (id === 'e7' ? { id: 'e7', name: 'blue mug', kind: 'mug', lastSeen: Date.now() - 60000, claims: [{ text: 'logo of a gear' }], obs: [{ id: 'o6', area: 100 }, { id: 'o5', area: 900 }, { id: 'o4' }] } : id === 'e8' ? { id: 'e8', name: 'lamp', kind: '', lastSeen: Date.now(), claims: [], obs: [] } : null), crop: (o) => crops[o] ?? null };
  const rec = await tool.run({ item: 'e7' });
  assert.equal(rec.image, crops.o5, 'its largest crop'); assert.match(rec.text, /blue mug \[e7\], mug, last seen 60 s ago\. Noted: logo of a gear\./);
  assert.equal((await tool.run({ item: 'e8' })).image, undefined); await assert.rejects(tool.run({ item: 'e99' }), /nothing logged as e99/);
  tool.camera = { held: () => null, capture: async () => { throw new Error('not connected'); } };
  await assert.rejects(tool.run(), /not connected/, 'no photo is the tool\'s error to report');
});

test('scanner: the container builds camera, world and both tools from Scanner alone', async () => {
  const mm = new ModuleManager(), s = Schema.create;
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);   // instances are assigned, plain objects deep-merged
  const sensors = new EventEmitter(), llm = inst(fakeLlm(REPLY)), link = fakeLink();
  mm.registerInstance(link, { name: 'device-link', lifecycle: false });
  mm.registerInstance(llm, { name: 'llm', lifecycle: false });
  mm.registerInstance(sensors, { name: 'sensors', lifecycle: false });
  class Harness {
    static moduleInfo = { name: 'harness', isMain: true, schema: s()
      .property('scanner', s('Scanner').required())
      .property('tools', s('array').property('*', s('Tool')).default(['look-tool', 'sightings-tool']))
      .property('context', s('array').property('*', s('ContextSource')).default(['world'])) };
    scanner; tools; context;
  }
  mm.register(Harness).register(Scanner);
  const dir = tmpdir('jet-scan-di-');
  const config = await mm.configure({ argv: [], env: {}, defaults: { world: { dir, sightingsTool: { recent: 3 } }, scanner: { maxItems: 4, lookTool: { jpegQuality: 55 } } } });
  await mm.initModules(config);
  const { scanner: sc, tools, context } = mm.getModuleInstance('harness');
  assert.ok(sc instanceof Scanner); assert.ok(sc.camera instanceof Camera); assert.ok(sc.world instanceof World);
  assert.equal(sc.camera.deviceLink, link); assert.equal(sc.llm, llm); assert.equal(sc.sensors, sensors); assert.equal(sc.gps ?? null, null);
  assert.deepEqual([sc.model, sc.maxItems, sc.maxTokens, sc.intervalS, sc.minGapMs, sc.maxScanS, sc.jpegQuality], ['qwen-vision', 4, 400, 10, 3000, 180, 70]);
  assert.match(sc.prompt, /name \| kind \| x1,y1,x2,y2 \| note/);
  assert.deepEqual(tools.map((x) => x.name), ['look', 'sightings']);
  assert.equal(tools[0].scanner, sc); assert.equal(tools[0].camera, sc.camera); assert.equal(tools[0].jpegQuality, 55, 'scanner.lookTool.*');
  assert.equal(tools[1].world, sc.world); assert.equal(tools[1].recent, 3, 'world.sightingsTool.*');
  assert.deepEqual(context, [sc.world]); assert.equal(sc.world.dir, dir); assert.equal(sc.world.ttlS, 1800);

  // the container's start hook is `attach`, not the scanning switch
  await mm.invokeLifecycleMethod('start', { args: [] });
  assert.equal(sc.active, false, 'starting the app does not start scanning');
  assert.equal(sensors.listenerCount('view'), 1);
  const out = await tools[0].run({}); await settle();   // the look's own scan has landed
  assert.ok(Buffer.isBuffer(out.image));
  assert.match(await tools[1].run({}), /e1 Fluke multimeter \(meter\), seen 1x/);
  assert.match(context[0].context(), /^In view lately .*Fluke multimeter \[e1\] \(display reads 2\.210 kΩ\)/);
  sc.start(); assert.equal(sc.active, true);
  await mm.invokeLifecycleMethod('stop');
  assert.equal(sc.active, false, 'shutdown switches scanning off');
  await settle();
});

test('parseScan: the line format the prompt asks for (scene, rows, a header echo, a bad box, a | in a note)', () => {
  const { scene, items } = parseScan('SCENE: A cluttered electronics bench.\nname | kind | x1,y1,x2,y2 | note\nFNIRSI multimeter | Device | 54,554,400,998 | reads 2.210 kOhm\n- solder spool | spool | [625, 131, 745, 277] | silver wire | white label\nresistor | component | somewhere | colour bands\njust prose here');
  assert.equal(scene, 'A cluttered electronics bench.');
  assert.deepEqual(items, [
    { name: 'FNIRSI multimeter', kind: 'device', box: [54, 554, 400, 998], note: 'reads 2.210 kOhm' },
    { name: 'solder spool', kind: 'spool', box: [625, 131, 745, 277], note: 'silver wire | white label' },
    { name: 'resistor', kind: 'component', box: null, note: 'colour bands' },
  ]);
});
