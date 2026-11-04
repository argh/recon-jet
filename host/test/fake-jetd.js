// A fake jetd for offline tests: speaks just enough of the protocol (docs/jetd.md) — hello plus
// a kernel-log backlog on connect, canned replies for P/Q/G/O/J/S (with real `f` framing), a
// spontaneous key pair and one live log line shortly after connect. Records every line the CLI
// sends so tests can assert both behaviour and inertness.
import net from 'node:net';

export const LOG_LINES = ['j <6>[1.000000] boot one', 'j <6>[2.000000] boot two', 'j <6>[3.000000] boot three'];

export function startFakeJetd() {
  const received = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('h 428 240 42 12\n' + LOG_LINES.join('\n') + '\n');
    const later = setTimeout(() => sock.write('k 86 1\nk 86 0\nj <6>[9.000000] live line\n'), 150);
    sock.once('close', () => clearTimeout(later));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        received.push(line);
        const [t, ...a] = line.split(' ');
        if (t === 'P') sock.write('p\n');
        else if (t === 'Q') sock.write('q 3812 3900 5012 123 91 50 0 4 18 configured 500\n');
        else if (t === 'G') sock.write('g 1 143\n');
        else if (t === 'O') sock.write('o 1 210\n');
        else if (t === 'J') { const n = a[0] ? Math.min(+a[0], LOG_LINES.length) : LOG_LINES.length; for (const l of LOG_LINES.slice(LOG_LINES.length - n)) sock.write(l + '\n'); sock.write(`J ${n}\n`); }
        else if (t === 'S') { const w = +a[0] || 640, h = +a[1] || 480; const bytes = Buffer.alloc(w * h * 2, 0x80); sock.write(`f ${w} ${h} UYVY ${bytes.length}\n`); sock.write(bytes); }
        else if (t === 'N' && a[0] === '1') {            // mirror on: format reply + a full-frame refresh
          sock.write('N 428 240 16 856\n');
          const rect = Buffer.alloc(428 * 240 * 2, 0x1f);
          sock.write(`b 0 0 428 240 ${rect.length}\n`); sock.write(rect);
        }
        else if (t === 'H' && a[0] === 'r') sock.write(`r ${a[1]} ${a[2]}\n`);   // inject echoes like the device in remote mode
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: server.address().port, received, close: () => new Promise((r) => server.close(r)) })));
}
