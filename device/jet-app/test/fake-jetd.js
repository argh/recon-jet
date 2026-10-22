// A stand-in for jetd's hub side of the protocol (docs/jetd.md): sends hello on connect,
// answers P/Q/G/E/Z, records drawing commands, and lets a test inject jet->host events.
// Standalone: `node test/fake-jetd.js [port]` (logs every line it receives).
import net from 'node:net';
import { EventEmitter } from 'node:events';

export class FakeJetd extends EventEmitter {
  constructor({ hello = 'h 428 240 42 12', power = 'q 3987 4012 4890 -120 0x8c 0x4c 0x00 0x02 0x03 configured 500', surface = '428 240 16 856', camera = '640 480' } = {}) {
    super();
    this.hello = hello; this.power = power; this.surface = surface; this.camera = camera;
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
        else if (line[0] === 'S') sock.write('e no camera\n');
        else if (line[0] === 'E') sock.write(`E ${this.surface}\n`);
        else if (line[0] === 'Z') sock.write(this.camera ? `Z ${this.camera}\n` : 'e viewfinder: open: No such device\n');
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

if (process.argv[1] && process.argv[1].endsWith('fake-jetd.js')) {
  const fake = new FakeJetd();
  fake.on('line', (l) => console.log(`${new Date().toISOString()} < ${l}`));
  fake.on('connection', () => console.log(`${new Date().toISOString()} hub connected`));
  const port = await fake.listen(+(process.argv[2] ?? 7777), '0.0.0.0');
  console.log(`fake jetd listening on ${port}`);
}
