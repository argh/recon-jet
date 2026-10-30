// The wire protocol between the stock GPS HAL and TI's navd (the "NAVL" server), recovered from
// gps.omap4.so: a Unix socket (/data/gps/gps4121) carrying 8-byte framed messages, and a FIFO
// (/data/gps/recongps) where navd routes NMEA sentences. Pure codecs; the GPS module owns the I/O.
//
// Both directions share the header (verified against live navd 2026-10-30): f0 f1 f2 f3, flag
// (requests: 1 when a payload follows; responses: a count byte), opcode/event code, length le16.
// Events:
//   1  command complete: u32 opcode, u32 result (0 = ok)
//   2  report: u32 at 8 = kind (0 position, 1 measurement = satellites, 2 raw position, 3 nmea)
//   3  nmea text at payload + 16
//   9  engine/version banner ("WL128X", "NaviLink_MCP2.6"), sent on connect
//   23 engine status
// Fix requests carry the session id 0xfe the HAL uses.
const MAGIC = Buffer.from([0xf0, 0xf1, 0xf2, 0xf3]);
export const SESSION = 0xfe;
export const OP = { BASEBAND_START: 0x01, BASEBAND_STOP: 0x02, FIX_START: 0x10, FIX_STOP: 0x11, SAVE_AIDING: 0x57, DELETE_AIDING: 0x22, NMEA_MASK: 0x50, POSITION_MODE: 0xc9, FIX_INTERVAL: 0x6a };
export const EVENT = { COMPLETE: 1, REPORT: 2, NMEA: 3, STATUS: 0x17 };
export const REPORT = { POSITION: 0, SATELLITES: 1, RAW_POSITION: 2, NMEA: 3 };
const GPS_EPOCH_MS = 315964800000;   // 1980-01-06 as the HAL adds it; no leap seconds applied

/** A framed request: `payload` optional. */
export function frame(opcode, payload = null) {
  const hdr = Buffer.alloc(8);
  MAGIC.copy(hdr, 0);
  hdr[4] = payload ? 1 : 0; hdr[5] = opcode; hdr.writeUInt16LE(payload ? payload.length : 0, 6);
  return payload ? Buffer.concat([hdr, payload]) : hdr;
}

/**
 * The HAL's "location fix start" (0x38 bytes), from its config file defaults.
 * mode 0 autonomous, 1 MS-based, 2 MS-assisted; intervalS between fixes; accuracyM, timeS, ageS as
 * the HAL's preferred accuracy / response time / location age; ttff as its ttff value.
 */
export function fixStart({ mode = 1, intervalS = 1, accuracyM = 80, timeS = 40, ageS = 3, ttff = 200, session = SESSION } = {}) {
  const p = Buffer.alloc(0x38);
  p.writeUInt32LE(mode === 1 || mode === 2 ? mode : 0, 0);
  p[4] = 0x3f; p[5] = 0x30;
  p.writeUInt16LE(intervalS, 8); p.writeUInt16LE(ttff, 0xa); p.writeUInt32LE(session, 0xc);
  p.writeUInt16LE(Math.min(accuracyM, 0xffff), 0x12); p.writeUInt16LE(Math.min(timeS, 0xffff), 0x16); p[0x18] = Math.min(ageS, 0xff);
  p.writeUInt32LE(mode === 1 || mode === 2 ? 1 : 7, 0x30);
  return frame(OP.FIX_START, p);
}

export function fixStop(session = SESSION) { const p = Buffer.alloc(8); p.writeUInt32LE(session, 0); return frame(OP.FIX_STOP, p); }
export function basebandStart() { return frame(OP.BASEBAND_START); }
export function basebandStop() { return frame(OP.BASEBAND_STOP); }

/** Incremental parser of the response stream: feed chunks, get `{ code, payload }` messages. */
export class Responses {
  #buf = Buffer.alloc(0);
  /** @param {Buffer} chunk @returns {{code: number, payload: Buffer}[]} */
  feed(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out = [];
    while (this.#buf.length >= 8) {
      const len = this.#buf.readUInt16LE(6);
      if (this.#buf.length < 8 + len) break;
      out.push({ code: this.#buf[5], payload: this.#buf.subarray(8, 8 + len) });
      this.#buf = this.#buf.subarray(8 + len);
    }
    return out;
  }
}

/** The NMEA FIFO stream: `{ code, text }` records (u32 code, u32 length, bytes). */
export class FifoRecords {
  #buf = Buffer.alloc(0);
  feed(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out = [];
    while (this.#buf.length >= 8) {
      const len = this.#buf.readUInt32LE(4);
      if (len > 65536) { this.#buf = Buffer.alloc(0); break; }   // lost sync
      if (this.#buf.length < 8 + len) break;
      out.push({ code: this.#buf.readUInt32LE(0), text: this.#buf.toString('latin1', 8, 8 + len).replace(/\0+$/, '') });
      this.#buf = this.#buf.subarray(8 + len);
    }
    return out;
  }
}

/** @param {Buffer} p  a COMPLETE payload */
export function parseComplete(p) { return { opcode: p.readUInt32LE(0), result: p.length >= 8 ? p.readInt32LE(4) : 0 }; }

/**
 * A position report (REPORT kind 0), as the HAL converted it to a GpsLocation. Scales are the
 * HAL's: lat = raw / (2^23 / 90), lon = raw / (2^23 / 180), bearing = raw / 182.04445.
 * @param {Buffer} p
 * @returns {{fix: 'none'|'2d'|'3d', lat?: number, lon?: number, altM?: number, speedMps?: number, bearingDeg?: number, accuracyM?: number, time?: number}}
 */
export function parsePosition(p) {
  if (p.length < 0x48) return { fix: 'none' };
  const type = p.readUInt32LE(0x14);
  if (type !== 0 && type !== 1) return { fix: 'none' };
  const lat = (p[0x24] ? -1 : 1) * p.readUInt32LE(0x18) / 93206.7578125;
  const lon = p.readInt32LE(0x1c) / 46603.37890625;
  const out = { fix: type === 1 ? '3d' : '2d', lat, lon, time: Math.round(p.readDoubleLE(0x40) * 1000) + GPS_EPOCH_MS };
  if (type === 1) out.altM = (p[0x26] ? -1 : 1) * p.readUInt16LE(0x22);
  const flags = p[0x30];
  if (flags & 4) out.speedMps = p.readUInt16LE(0x36);
  if (flags & 2) out.bearingDeg = p.readUInt16LE(0x34) / 182.04445;
  if (flags & 0x10) out.accuracyM = p.readUInt16LE(0x3a);
  return out;
}

/**
 * A measurement report (REPORT kind 1): the satellites the chip is tracking, as the HAL turned
 * it into a GpsSvStatus (prn, snr dB, elevation and azimuth in degrees), plus the in-fix mask.
 * @param {Buffer} p
 */
export function parseSatellites(p) {
  const n = Math.min(p[0x17] ?? 0, 32), sats = [];
  for (let i = 0; i < n; i++) {
    const o = 0x10 + i * 0x18;
    if (o + 0x27 > p.length) break;
    const snr = p.readUInt16LE(o + 0x16) / 10;
    if (snr === 0) continue;
    sats.push({ prn: p[o + 0x14] + 1, snr, elevationDeg: +(p.readInt8(o + 0x25) * 0.703125).toFixed(1), azimuthDeg: +(p[o + 0x26] * 1.40625).toFixed(1) });
  }
  const used = p.length >= 0x24 ? p.readUInt32LE(0x20) : 0;
  return { sats, usedMask: used >>> 0 };
}
