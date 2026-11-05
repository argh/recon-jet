// Offline tests: each case runs the real CLI as a subprocess against a fake jetd on a loopback
// port, proving per-command parse/output/exit behaviour without a device. The real-device smoke
// is the same commands with JET_HOST set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeJetd, LOG_LINES } from './fake-jetd.js';

const JET = fileURLToPath(new URL('../jet.js', import.meta.url));

/** Run the CLI; `onStdout(all, child)` can watch output (to SIGINT a streaming command). */
function run(args, { env = {}, onStdout, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JET, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; onStdout?.(stdout, child); });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`jet ${args.join(' ')} hung\nstdout: ${stdout}\nstderr: ${stderr}`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

async function withFake(fn, opts) {
  const fake = await startFakeJetd(opts);
  try { return await fn(fake, ['--host', '127.0.0.1', '--port', String(fake.port)]); }
  finally { await fake.close(); }
}

test('state prints hello, pong, glance, wear and power — and is inert', () => withFake(async (fake, flags) => {
  const { code, stdout } = await run([...flags, 'state']);
  assert.equal(code, 0);
  assert.match(stdout, /hello\s+428x240 px, 42x12 cells/);
  assert.match(stdout, /pong\s+\d+ ms/);
  assert.match(stdout, /glance\s+at the glass \(raw 143\)/);
  assert.match(stdout, /wear\s+worn \(raw 210\)/);
  assert.match(stdout, /vbat 3812 mV/);
  assert.match(stdout, /udc configured/);
  // inert by default: nothing but the four read-only queries went over the wire
  assert.deepEqual([...new Set(fake.received)].sort(), ['G', 'O', 'P', 'Q']);
}));

test('state --json emits one machine-readable object; JET_HOST/JET_PORT are honored', () => withFake(async (fake) => {
  const { code, stdout } = await run(['state', '--json'], { env: { JET_HOST: '127.0.0.1', JET_PORT: String(fake.port) } });
  assert.equal(code, 0);
  const j = JSON.parse(stdout);
  assert.deepEqual(j.hello, { w: 428, h: 240, cols: 42, rows: 12 });
  assert.equal(typeof j.pongMs, 'number');
  assert.deepEqual(j.glance, { at: 1, raw: 143 });
  assert.deepEqual(j.wear, { worn: 1, raw: 210 });
  assert.equal(j.power.vbat, 3812);
  assert.equal(j.power.ctrl1, 0x91);
  assert.equal(j.power.udc, 'configured');
}));

test('snapshot writes a PNG from the UYVY frame and prints its path', () => withFake(async (fake, flags) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jet-test-'));
  try {
    const out = path.join(dir, 'shot.png');
    const { code, stdout } = await run([...flags, 'snapshot', out, '--size', '8x4']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), out);
    assert.ok(fake.received.includes('S 8 4'));
    const png = await readFile(out);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('snapshot rejects a malformed --size', () => withFake(async (fake, flags) => {
  const { code, stderr } = await run([...flags, 'snapshot', '--size', 'huge']);
  assert.equal(code, 1);
  assert.match(stderr, /WxH/);
}));

test('log -n 2 prints exactly the last two lines (connect backlog deduplicated)', () => withFake(async (fake, flags) => {
  const { code, stdout } = await run([...flags, 'log', '-n', '2']);
  assert.equal(code, 0);
  assert.deepEqual(stdout.trimEnd().split('\n'), LOG_LINES.slice(-2).map((l) => l.slice(2)));
}));

test('log --follow streams live lines and exits 0 on SIGINT', () => withFake(async (fake, flags) => {
  let sent = false;   // one Ctrl-C only: a second would (rightly) force-kill
  const { code, stdout } = await run([...flags, 'log', '-n', '1', '--follow'],
    { onStdout: (all, child) => { if (!sent && all.includes('live line')) { sent = true; child.kill('SIGINT'); } } });
  assert.equal(code, 0);
  assert.match(stdout, /boot three/);
  assert.match(stdout, /live line/);
}));

test('events labels the stream and exits 0 on SIGINT', () => withFake(async (fake, flags) => {
  let sent = false;
  const { code, stdout } = await run([...flags, 'events'],
    { onStdout: (all, child) => { if (!sent && all.includes('86 up')) { sent = true; child.kill('SIGINT'); } } });
  assert.equal(code, 0);
  assert.match(stdout, /key\s+86 down/);
  assert.match(stdout, /key\s+86 up/);
}));

test('console escapes control characters for I', () => withFake(async (fake, flags) => {
  const { code } = await run([...flags, 'console', 'ls -l\n\tback\\slash']);
  assert.equal(code, 0);
  assert.ok(fake.received.includes('I ls -l\\n\\tback\\\\slash'), `got: ${JSON.stringify(fake.received)}`);
}));

test('mode sends M and nothing else', () => withFake(async (fake, flags) => {
  const { code } = await run([...flags, 'mode', 'shell']);
  assert.equal(code, 0);
  assert.deepEqual(fake.received, ['M shell']);
}));

test('mode rejects an unknown mode', () => withFake(async (fake, flags) => {
  const { code } = await run([...flags, 'mode', 'disco']);
  assert.equal(code, 1);
  assert.equal(fake.received.length, 0);
}));

test('backlight sends L and validates the range', () => withFake(async (fake, flags) => {
  const ok = await run([...flags, 'backlight', '300']);
  assert.equal(ok.code, 0);
  assert.deepEqual(fake.received, ['L 300']);
  const bad = await run([...flags, 'backlight', '2000']);
  assert.equal(bad.code, 1);
  assert.deepEqual(fake.received, ['L 300']);   // the invalid value never reached the wire
}));

test('raw sends lines verbatim and prints the replies', () => withFake(async (fake, flags) => {
  const { code, stdout } = await run([...flags, 'raw', 'P', 'Q']);
  assert.equal(code, 0);
  assert.ok(fake.received.includes('P') && fake.received.includes('Q'));
  assert.match(stdout, /^p$/m);
  assert.match(stdout, /^q 3812 /m);
}));

test('live serves the page, bridges mirror rects over WS, and round-trips an injection', () => withFake(async (fake, flags) => {
  let url = null, child = null;
  const done = run([...flags, 'live', '--open', 'false', '--http-port', '0'], {
    onStdout: (all, c) => { child = c; url ??= all.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]; },
  });
  while (!url) await new Promise((r) => setTimeout(r, 25));

  const page = await (await fetch(url)).text();
  assert.match(page, /<title>jet live<\/title>/);

  // a minimal WS client (mirrors what the page does): expect fmt, a rect header + its binary
  // payload, and our H r injection coming back as a device event
  const { createHash, randomBytes } = await import('node:crypto');
  const net = await import('node:net');
  const port = +url.match(/:(\d+)/)[1];
  const got = await new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    const state = { fmt: null, rect: null, rectBytes: 0, echo: false };
    let buf = Buffer.alloc(0), shaken = false, header = null;
    const frame = (op, p) => { const m = randomBytes(4), b = Buffer.from(p); for (let i = 0; i < b.length; i++) b[i] ^= m[i & 3]; return Buffer.concat([Buffer.from([0x80 | op, 0x80 | b.length]), m, b]); };
    sock.on('connect', () => sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('error', reject);
    const timer = setTimeout(() => resolve(state), 4000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shaken) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        assert.ok(buf.toString().includes(createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')));
        buf = buf.subarray(end + 4); shaken = true;
        sock.write(frame(1, 'H r 9 -4'));
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15; let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if (op === 1) {
          const m = JSON.parse(payload.toString());
          if (m.t === 'fmt') state.fmt = m;
          else if (m.t === 'b') header = m;
          else if (m.t === 'line' && m.line === 'r 9 -4') state.echo = true;
        } else if (op === 2 && header) { state.rect = header; state.rectBytes = payload.length; header = null; }
        if (state.fmt && state.rect && state.echo) { clearTimeout(timer); sock.destroy(); return resolve(state); }
      }
    });
  });

  assert.deepEqual({ w: got.fmt.w, h: got.fmt.h, bpp: got.fmt.bpp }, { w: 428, h: 240, bpp: 16 });
  assert.equal(got.rectBytes, got.rect.w * got.rect.h * 2);   // header matches payload
  assert.ok(got.echo, 'H r injection came back as a device event');
  child.kill('SIGINT');
  const { code } = await done;
  assert.equal(code, 0);
}));

test('live keeps redialing until a subscribe is acknowledged, instead of stranding on a failed one', () => withFake(async (fake, flags) => {
  // the first two connections drop on `N 1` without ever acknowledging it (jetd rebooting, WiFi
  // settling): the regression left the bridge connected-but-unsubscribed after one such failure,
  // so the page froze on a stale frame. It must keep trying and reach the connection that mirrors.
  let child = null;
  const done = run([...flags, 'live', '--open', 'false', '--http-port', '0'], { onStdout: (_all, c) => { child = c; }, timeoutMs: 20000 });
  const t0 = Date.now();
  while (fake.state.conns < 3 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fake.state.conns >= 3, `expected redials past the failed subscribes, saw ${fake.state.conns} connections`);
  child?.kill('SIGINT');
  assert.equal((await done).code, 0, 'stays up and exits cleanly, never crashed out of the redial loop');
}, { flakyMirrors: 2 }));

test('screenshot assembles the mirror refresh into a PNG', () => withFake(async (fake, flags) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jet-screen-'));
  try {
    const out = path.join(dir, 'glass.png');
    const { code, stdout } = await run([...flags, 'screenshot', out]);
    assert.equal(code, 0);
    assert.match(stdout, /glass\.png/);
    const png = await readFile(out);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(fake.received.includes('N 1') && fake.received.includes('N 0'), 'subscribes and unsubscribes');
  } finally { await rm(dir, { recursive: true, force: true }); }
}));
