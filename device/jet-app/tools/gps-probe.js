#!/usr/bin/env node
// Talk to TI's navd the way the stock GPS HAL did and print what comes back: a protocol probe
// for bringing GPS up on mainline (docs/gps.md). Needs /dev/tigps (hci0 up) and navd running in
// the stock chroot. Usage: gps-probe.js [seconds] [--data-dir /android-data/gps]
import net from 'node:net';
import fs from 'node:fs';
import { basebandStart, basebandStop, fixStart, fixStop, Responses, FifoRecords, parseComplete, parsePosition, parseSatellites, EVENT, REPORT } from '../src/lib/navl.js';

const seconds = Number(process.argv[2]) || 60;
const dir = process.argv.includes('--data-dir') ? process.argv[process.argv.indexOf('--data-dir') + 1] : '/android-data/gps';
const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);

// the NMEA fifo first (non-blocking open so we do not wait for a writer)
try {
  const fd = fs.openSync(`${dir}/recongps`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const records = new FifoRecords();
  fs.createReadStream(null, { fd, autoClose: true }).on('data', (c) => { for (const r of records.feed(c)) log('fifo', r.code, r.text.trim()); }).on('error', (e) => log('fifo error', e.code));
} catch (e) { log('fifo not opened', e.code); }

const sock = net.connect(`${dir}/gps4121`);
const rx = new Responses();
let started = false;
sock.on('connect', () => { log('connected; baseband start'); sock.write(basebandStart()); });
sock.on('data', (chunk) => {
  for (const { code, payload } of rx.feed(chunk)) {
    if (code === EVENT.COMPLETE) {
      const c = parseComplete(payload);
      log('complete', `op 0x${c.opcode.toString(16)}`, 'result', c.result);
      if (c.opcode === 1 && !started) { started = true; log('fix start'); sock.write(fixStart()); }
    } else if (code === EVENT.REPORT) {
      const kind = payload.readUInt32LE(8);
      if (kind === REPORT.POSITION) log('position', JSON.stringify(parsePosition(payload)));
      else if (kind === REPORT.SATELLITES) { const s = parseSatellites(payload); log('satellites', s.sats.length, s.sats.map((x) => `${x.prn}:${x.snr}`).join(' ')); }
      else log('report kind', kind, payload.length, 'bytes', payload.subarray(0, 32).toString('hex'));
    } else if (code === EVENT.NMEA) log('nmea', payload.toString('latin1', 16).trim());
    else log('event', code, payload.length, 'bytes', payload.subarray(0, 32).toString('hex'));
  }
});
sock.on('error', (e) => { log('socket error', e.message); process.exit(1); });
sock.on('close', () => { log('socket closed'); process.exit(0); });
setTimeout(() => { log('fix stop'); sock.write(fixStop()); setTimeout(() => { sock.write(basebandStop()); setTimeout(() => process.exit(0), 1500); }, 1500); }, seconds * 1000);
