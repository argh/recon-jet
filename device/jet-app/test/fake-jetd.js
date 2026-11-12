// A stand-in for jetd's hub side of the protocol (docs/jetd.md): sends hello on connect,
// answers P/Q/G/E/Z/J/U, records drawing commands, and lets a test inject jet->host events.
// Standalone: `node test/fake-jetd.js [port] [frame.png]` (logs every line it receives; with a
// PNG the camera snapshot `S` answers with that picture, so the vision path has something to see).
// The buttons are on HTTP at port+1 (`curl localhost:7791/front`), so the app can be driven without a device.
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export class FakeJetd extends EventEmitter {
  constructor({ hello = 'h 428 240 42 12', power = 'q 3987 4012 4890 -120 0x8c 0x4c 0x00 0x02 0x03 configured 500', surface = '428 240 16 856', camera = '640 480', klog = [], frame = null } = {}) {
    super();
    this.hello = hello; this.power = power; this.surface = surface; this.camera = camera;
    /** @type {{w: number, h: number, data: Buffer}|null} what `S` returns (UYVY); null = no camera */ this.frame = frame;
    this.klog = klog;   // the kernel-log ring: the last 60 go out on connect, the whole ring on J
    this.received = [];   // every line from the host
    this.sock = null;
    this.server = net.createServer((sock) => this.#attach(sock));
  }
  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  close() { this.sock?.destroy(); return new Promise((resolve) => this.server.close(() => resolve())); }

  #attach(sock) {
    this.sock?.destroy();
    this.sock = sock;
    sock.write(this.hello + '\n');
    for (const l of this.klog.slice(-60)) sock.write(`j ${l}\n`);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        this.received.push(line);
        this.emit('line', line);
        if (line === 'P') sock.write('p\n');
        else if (line === 'Q') sock.write(this.power + '\n');
        else if (line === 'G') sock.write('g 1 140\n');
        else if (line[0] === 'M') sock.write(`m ${line.slice(2)}\n` + (line.slice(2) === 'remote' ? this.hello + '\n' : ''));
        else if (line === 'w') sock.write('w idle\n');
        else if (line[0] === 'S') { if (this.frame) { sock.write(`f ${this.frame.w} ${this.frame.h} UYVY ${this.frame.data.length}\n`); sock.write(this.frame.data); } else sock.write('e no camera\n'); }
        else if (line[0] === 'D') sock.write(line[2] === '1' ? 'x on\n' : 'x off\n');
        else if (line[0] === 'E') sock.write(`E ${this.surface}\n`);
        else if (line[0] === 'Z') sock.write(this.camera ? `Z ${this.camera}\n` : 'e viewfinder: open: No such device\n');
        else if (line[0] === 'J') { const n = Math.min(this.klog.length, +line.slice(2) || this.klog.length); for (const l of this.klog.slice(-n)) sock.write(`j ${l}\n`); sock.write(`J ${n}\n`); }
        else if (line === 'U') sock.write('U 180 197 20 1000\n');
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (this.sock === sock) this.sock = null; });
    this.emit('connection');
  }
  /** Inject a jet->host line (e.g. 'k 86 1'). */
  send(line) { this.sock?.write(line + '\n'); }
  key(code) { this.send(`k ${code} 1`); this.send(`k ${code} 0`); }
}

/** RGBA -> packed UYVY (BT.601 video range, the inverse of lib/uyvy.js), chroma from the even pixel. */
export function rgbaToUyvy({ width: w, height: h, data }) {
  const out = Buffer.alloc(w * h * 2), clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4, o = (y * w + x) * 2, [r, g, b] = [data[i], data[i + 1], data[i + 2]], [r2, g2, b2] = [data[i + 4] ?? r, data[i + 5] ?? g, data[i + 6] ?? b];
    out[o] = clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b); out[o + 1] = clamp(16 + 0.257 * r + 0.504 * g + 0.098 * b);
    out[o + 2] = clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b); out[o + 3] = clamp(16 + 0.257 * r2 + 0.504 * g2 + 0.098 * b2);
  }
  return { w, h, data: out };
}

if (process.argv[1] && process.argv[1].endsWith('fake-jetd.js')) {
  const { decodePng } = await import('../src/lib/png.js');
  const fake = new FakeJetd({ frame: process.argv[3] ? rgbaToUyvy(decodePng(fs.readFileSync(process.argv[3]))) : null });
  fake.on('line', (l) => console.log(`${new Date().toISOString()} < ${l}`));
  fake.on('connection', () => console.log(`${new Date().toISOString()} hub connected`));
  const port = await fake.listen(+(process.argv[2] ?? 7777), '0.0.0.0');
  console.log(`fake jetd listening on ${port}`);
  // the buttons, for driving the app by hand: `curl localhost:<port+1>/front` (rear, up, down, left, right, or a raw line: /line/n%2025)
  const KEYS = { front: 86, rear: 107, up: 103, down: 108, left: 105, right: 106 };
  const http = await import('node:http');
  http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    if (KEYS[name]) fake.key(KEYS[name]); else if (name.startsWith('line/')) fake.send(name.slice(5)); else { res.statusCode = 404; return res.end('front rear up down left right line/<raw>\n'); }
    res.end('ok\n');
  }).listen(port + 1, '127.0.0.1', () => console.log(`buttons on http://127.0.0.1:${port + 1}/front|rear|up|down|left|right`));
}
