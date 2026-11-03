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

async function withFake(fn) {
  const fake = await startFakeJetd();
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

test('live is a stub that exits nonzero without touching the device', async () => {
  const { code, stderr } = await run(['--host', '127.0.0.1', '--port', '1', 'live']);
  assert.notEqual(code, 0);
  assert.match(stderr, /mirror mode/);
});
