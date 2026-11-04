// The GPS path: NMEA parsing (the classic example coordinates, not anywhere real), the rolling
// snapshot, and the module following a real FIFO with the daemon's record framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSentence, parseCoord, NmeaState } from '../src/modules/gps/nmea.js';
import net from 'node:net';
import { Gps } from '../src/modules/gps/index.js';
import { tmpdir } from './helpers.js';

const sum = (body) => { let c = 0; for (const ch of body) c ^= ch.charCodeAt(0); return c.toString(16).toUpperCase().padStart(2, '0'); };
const nmea = (body) => `$${body}*${sum(body)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what = 'condition') { for (let i = 0; i < 400; i++) { if (cond()) return; await sleep(5); } throw new Error(`timeout: ${what}`); }

test('nmea: sentences, checksums, coordinates', () => {
  const s = parseSentence(nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'));
  assert.equal(s.talker, 'GP'); assert.equal(s.type, 'GGA'); assert.equal(s.fields[6], '08');
  assert.equal(parseSentence('$GPGGA,123519*FF'), null, 'bad checksum');
  assert.equal(parseSentence('garbage'), null);
  assert.ok(parseSentence('$GPGLL,,,,,,V,N*64'), 'the chip\'s real empty sentence');
  assert.ok(Math.abs(parseCoord('4807.038', 'N') - 48.1173) < 1e-4);
  assert.ok(Math.abs(parseCoord('01131.000', 'W') - -11.5167) < 1e-4);
  assert.equal(parseCoord('', 'N'), null);
});

test('nmea: the snapshot goes no-data -> satellites -> fix, and keeps the last position', () => {
  const st = new NmeaState();
  assert.equal(st.feed('not nmea'), false);
  st.feed(nmea('GPGGA,,,,,,0,,,,,,,,'));
  st.feed(nmea('GPGSV,1,1,00'));
  let s = st.snapshot();
  assert.deepEqual([s.fix, s.satsUsed, s.satsInView, s.lat], ['none', 0, 0, null]);
  st.feed(nmea('GPGSV,2,1,05,01,40,083,41,02,17,308,43'));
  st.feed(nmea('GPGGA,123519,4807.038,N,01131.000,E,1,04,1.2,545.4,M,46.9,M,,'));
  st.feed(nmea('GPGSA,A,3,01,02,03,04,,,,,,,,,2.0,1.2,1.6'));
  st.feed(nmea('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W'));
  s = st.snapshot();
  assert.equal(s.fix, '3d'); assert.equal(s.satsUsed, 4); assert.equal(s.satsInView, 5);
  assert.ok(Math.abs(s.lat - 48.1173) < 1e-4); assert.ok(Math.abs(s.lon - 11.5167) < 1e-4);
  assert.equal(s.altM, 545.4); assert.equal(s.hdop, 1.2);
  assert.equal(s.speedKmh, 41.5); assert.equal(s.courseDeg, 84.4);
  assert.equal(new Date(s.time).toISOString(), '1994-03-23T12:35:19.000Z');
  st.feed(nmea('GPGSA,A,1,,,,,,,,,,,,,,,'));   // fix lost: position stays, fix says none
  s = st.snapshot();
  assert.equal(s.fix, 'none'); assert.ok(s.lat != null);
});

test('gps module: follows the FIFO, logs raw sentences, survives writer restarts', async (t) => {
  const dir = tmpdir('jet-gps-'), fifo = path.join(dir, 'recongps');
  execSync(`mkfifo ${fifo}`);
  // the daemon's command socket: expect the baseband start, answer complete, expect the fix start
  const cmds = [];
  const server = net.createServer((c) => c.on('data', (b) => {
    cmds.push(b[5]);
    if (b[5] === 1) { const r = Buffer.alloc(16); r.set([0xf0, 0xf1, 0xf2, 0xf3, 1, 1, 8, 0, 1], 0); c.write(r); }
  }));
  await new Promise((r) => server.listen(path.join(dir, 'gps4121'), r));
  t.after(() => server.close());
  const gps = Object.assign(new Gps(), { fifo, socket: path.join(dir, 'gps4121'), logFile: path.join(dir, 'nmea.log'), retryMs: 20, logger: null });
  t.after(() => gps.stopListening());   // a failed assert must not leave handles pinning the suite
  const frame = (text) => { const b = Buffer.from(text + '\0', 'latin1'), h = Buffer.alloc(8); h.writeUInt32LE(0x10, 0); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b]); };
  const updates = [];
  gps.on('update', (s) => updates.push(s));
  gps.listen(); gps.listen();   // idempotent
  await until(() => fs.existsSync(gps.logFile), 'log created');
  let w = fs.createWriteStream(fifo);
  w.write(frame(nmea('GPGSV,1,1,03')));
  w.end(frame(nmea('GPGGA,123519,4807.038,N,01131.000,E,1,03,1.5,545.4,M,46.9,M,,')));
  await until(() => gps.state.lat != null, 'fix parsed');
  await until(() => cmds.includes(0x10), 'session started');
  assert.deepEqual(cmds.slice(0, 2), [1, 0x10], 'baseband start, then fix start');
  assert.equal(gps.state.satsInView, 3); assert.equal(gps.state.satsUsed, 3);
  assert.equal(gps.state.good, false, 'three satellites is not a position (the indoor flap is 0 <-> 4-5)');
  assert.equal(gps.goodFix(), null);
  assert.equal(updates.length, 1, 'bursts collapse into one update');
  // the writer closed (daemon restart): a new writer is picked up
  await sleep(60);
  w = fs.createWriteStream(fifo);
  w.write(frame(nmea('GPGSV,1,1,07')));
  w.write(frame(nmea('GPGGA,123520,4807.038,N,01131.000,E,1,05,1.0,545.4,M,46.9,M,,')));
  w.end(frame(nmea('GPGSA,A,3,01,02,03,04,05,,,,,,,,2.0,1.0,1.6')));
  await until(() => gps.state.satsInView === 7, 'reopened');
  await until(() => gps.state.good, 'gated fix');
  assert.ok(gps.goodFix(), 'fresh and good');
  const log = fs.readFileSync(gps.logFile, 'utf8');
  assert.equal(log.split('\n').filter((l) => l && !l.startsWith('#')).length, 5);
  assert.match(log, /GPGSV,1,1,07/);
  gps.stopListening(); gps.stopListening();
  assert.equal(gps.listening, false);
  assert.equal(gps.state.satsInView, 7, 'the last snapshot survives');
  gps.listen();   // a fresh walk starts clean
  assert.equal(gps.state.satsInView, 0);
  gps.stopListening();
});

test('local time: a good fix derives the zone, persists it, and sets TZ; off returns to GMT', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'jet-tz-'));
  const gps = Object.assign(new Gps(), {
    fifo: path.join(dir, 'fifo'), socket: path.join(dir, 'sock'), logFile: '', retryMs: 50,
    deviceConfig: path.join(dir, 'jet-app.json'), localtimeFile: path.join(dir, 'localtime'),
    localTime: false, tz: '',
  });
  const envBefore = process.env.TZ;
  try {
    gps.goodFix = () => ({ lat: 37.7749, lon: -122.4194, good: true, at: Date.now() });
    await gps.setLocalTime(true);
    assert.equal(gps.tz, 'America/Los_Angeles');
    assert.equal(process.env.TZ, 'America/Los_Angeles');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'jet-app.json'), 'utf8'));
    assert.equal(persisted.gps.localTime, true);
    assert.equal(persisted.gps.tz, 'America/Los_Angeles');
    await gps.setLocalTime(false);
    assert.equal(process.env.TZ, 'UTC');
    assert.equal(gps.tz, 'America/Los_Angeles', 'the derived zone is kept for next time');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jet-app.json'), 'utf8')).gps.localTime, false);
  } finally {
    if (envBefore === undefined) delete process.env.TZ; else process.env.TZ = envBefore;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gps: the fix pursuit is observable data: acquiring with satellite progress, then fixed, timeout or cancelled', async () => {
  const gps = Object.assign(new Gps(), { logger: null, fixTimeoutS: 0.05 });
  let fix = null, sats = 0;
  gps.probe = async () => true;   // receiver already on
  gps.goodFix = () => fix;
  Object.defineProperty(gps, 'state', { get: () => ({ satsUsed: sats }) });
  const events = [];
  gps.on('pursuit', (p) => events.push(p));
  // the hunt: progress only when the used count moves, fixed the moment the gated fix lands
  assert.equal(await gps.startPursuit(), true);
  assert.deepEqual(events, [{ state: 'acquiring', satsUsed: 0 }]);
  assert.equal(await gps.startPursuit(), false, 'one hunt at a time');
  gps.emit('update', {});
  assert.equal(events.length, 1, 'no progress: no event');
  sats = 3; gps.emit('update', {});
  assert.deepEqual(events.at(-1), { state: 'acquiring', satsUsed: 3 });
  fix = { good: true }; gps.emit('update', {});
  assert.deepEqual(events.at(-1), { state: 'fixed', fix });
  gps.emit('update', {});
  assert.equal(events.at(-1).state, 'fixed', 'the hunt is over: updates no longer watched');
  // a fresh good fix answers at once
  events.length = 0;
  assert.equal(await gps.startPursuit(), true);
  assert.deepEqual(events, [{ state: 'fixed', fix }]);
  // the pursuit owns its timeout; the receiver is left on
  fix = null; events.length = 0;
  await gps.startPursuit();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events.map((e) => e.state), ['acquiring', 'timeout']);
  // cancelled: back to idle, nothing more
  events.length = 0;
  await gps.startPursuit();
  gps.cancelPursuit();
  assert.deepEqual(events.map((e) => e.state), ['acquiring', 'idle']);
  // a receiver that will not come up rejects and returns to idle
  gps.probe = async () => false;
  gps.enable = async () => { throw new Error('no receiver'); };
  events.length = 0;
  await assert.rejects(gps.startPursuit(), /no receiver/);
  assert.deepEqual(events.map((e) => e.state), ['acquiring', 'idle']);
  assert.equal(gps.pursuit.state, 'idle');
});
