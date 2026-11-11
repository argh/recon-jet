// jet live: full remote view/drive of the glass in a browser. One jetd connection subscribed
// to the mirror (N 1, docs/jetd.md), one local HTTP server hosting live/index.html, and a
// minimal RFC6455 WebSocket bridge in between — no dependencies, loopback only. The page gets
// a JSON text message per event and a binary message per payload (mirror rect, speaker tee,
// mic chunk), and whatever text it sends back is written to jetd verbatim (it speaks the same
// protocol; the interesting ones are H k / H r injections and V for push-to-talk).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';
import { JetClient } from '../lib/client.js';

const s = Schema.create;
const pageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'live');

export class LiveCommand extends Command {
  static moduleInfo = {
    name: 'live',
    schema: s().meta('description', 'mirror and drive the glass in a browser (local server, loopback only)')
      .property('httpPort', s('number').default(0).meta('description', 'HTTP port for the page (0 = pick a free one; `port` stays jetd\'s)'))
      .property('open', s('boolean').default(true).meta('description', 'open the page in the default browser')),
  };
  httpPort; open;

  async run(jet) {
    const sockets = new Set();
    let current = jet, fmt = null, stopping = false;

    // jetd -> every page: text events as JSON, payloads as a JSON header + a binary message
    const text = (obj) => { const f = wsFrame(1, Buffer.from(JSON.stringify(obj))); for (const ws of sockets) ws.write(f); };
    const binary = (buf) => { const f = wsFrame(2, buf); for (const ws of sockets) ws.write(f); };

    // The Jet's links drop (USB falls off, WiFi starves under GPS/BT coex) and come back; a live
    // session must ride through that, so unlike the one-shot commands this one redials forever.
    const wire = (j) => {
      j.on('blit', (r) => { text({ t: 'b', x: r.x, y: r.y, w: r.w, h: r.h }); binary(r.data); });
      j.on('speaker', (d) => { text({ t: 'u' }); binary(d); });
      j.on('mic', (d) => { text({ t: 'a' }); binary(d); });
      j.on('line', (l) => { if (!'bua'.includes(l[0]) || l[1] !== ' ') text({ t: 'line', line: l }); });
      j.once('close', () => { if (!stopping && current === j) { current = null; text({ t: 'gone' }); redial(); } });
    };
    // A session is up only once the socket is connected AND `N 1` is acknowledged: the subscribe
    // reply can be slow or never arrive (jetd still booting, WiFi settling after a reconnect), and
    // a single failed attempt must not strand the bridge connected-but-unsubscribed — that left the
    // page frozen on a stale, half-refreshed frame (it read as garbage). redial() keeps trying and
    // is a single shared promise, so the startup path and a later drop await the same recovery
    // rather than racing (the race exited the process mid-reconnect). Each acknowledged `N 1` makes
    // jetd restart a full band refresh, so a recovered link always repaints whole.
    const subscribe = async (j) => { const f = await j.request('N', 'N 1'); fmt = f; current = j; text({ t: 'fmt', ...f }); };
    const idle = () => { if (!sockets.size) current?.send('N 0'); };   // last page gone: stop the tee
    let redialPromise = null, dialing = null;
    const redial = () => redialPromise ??= (async () => {
      text({ t: 'gone' });
      console.log(`jet live: lost ${this.host} — redialing`);
      for (; !stopping;) {
        const next = dialing = new JetClient(this);
        try { await next.connect(); wire(next); await subscribe(next); console.log(`jet live: ${this.host} is mirroring`); break; }
        catch { await next.close().catch(() => {}); if (stopping) break; await new Promise((r) => setTimeout(r, 2000)); }
      }
      dialing = null; redialPromise = null;
    })();

    wire(jet);
    try { await subscribe(jet); }
    catch { await jet.close().catch(() => {}); redial(); }   // background: the server still starts and the page shows "reconnecting"

    const server = createServer(async (req, res) => {
      const file = req.url === '/' ? 'index.html' : null;   // one page; nothing else is served
      if (!file) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(path.join(pageDir, file)));
    });
    server.on('upgrade', (req, sock) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) return sock.destroy();
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                 `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sock.setNoDelay(true);
      sockets.add(sock);
      const reader = wsReader((op, payload) => {
        if (op === 8) return sock.end();
        if (op === 9) return sock.write(wsFrame(10, payload));
        if (op === 1) current?.send(payload.toString());      // the page speaks jetd's protocol
      });
      sock.on('data', reader);
      // Nobody watching: drop the subscription. jetd tees every panel push to a subscribed
      // mirror whether or not a page is reading, and with a direct writer reporting its frames
      // (doom) that is megabytes a second of the device's link and CPU spent on no one. A
      // closed tab leaves this process running, so without this a backgrounded `jet live` taxed
      // the Jet indefinitely. The next page re-subscribes below and gets a fresh band refresh.
      sock.on('close', () => { sockets.delete(sock); idle(); });
      sock.on('error', () => { sockets.delete(sock); idle(); });
      if (current && fmt) { text({ t: 'fmt', ...fmt }); current.send('N 1'); }   // late joiner: format + fresh refresh
      else text({ t: 'gone' });                                                  // mid-outage: the page shows reconnecting
    });

    await new Promise((r) => server.listen(this.httpPort, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(fmt ? `jet live: mirroring ${fmt.w}x${fmt.h} @ ${fmt.bpp} bpp from ${this.host}` : `jet live: waiting for ${this.host} to come up`);
    console.log(`jet live: ${url}  (Ctrl-C stops; the glass is never blocked by this)`);
    if (this.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

    await this.interrupted();
    stopping = true;
    current?.send('N 0');
    if (current && current !== jet) await current.close().catch(() => {});   // the original is closed by the base
    if (dialing && dialing !== current) await dialing.close().catch(() => {});   // a reconnect in flight: let Ctrl-C exit promptly
    server.close(); for (const ws of sockets) ws.destroy();
  }
}

/* ---- minimal RFC6455, server side: masked client frames in, unmasked frames out ---------- */
function wsFrame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}
function wsReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.subarray(need);
      onFrame(op, payload);
    }
  };
}
