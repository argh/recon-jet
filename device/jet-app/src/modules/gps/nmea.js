// NMEA 0183, the slice of it the chip emits (GGA, RMC, GSA, GSV, GLL, VTG): pure parsers and a
// small accumulator that turns the 1 Hz sentence burst into one position snapshot. Coordinates
// arrive as ddmm.mmmm; empty fields are the no-fix answer and leave the snapshot's nulls alone.

/** "$GPGGA,...*47" -> { type: 'GGA', fields: [...] } after checksum, or null for junk. */
export function parseSentence(line) {
  const m = /^\$([A-Z]{2})([A-Z]{3}),([^*]*)(?:\*([0-9A-Fa-f]{2}))?\s*$/.exec(line);
  if (!m) return null;
  if (m[4] !== undefined) {
    let sum = 0;
    for (let i = 1; i < line.indexOf('*'); i++) sum ^= line.charCodeAt(i);
    if (sum !== parseInt(m[4], 16)) return null;
  }
  return { talker: m[1], type: m[2], fields: m[3].split(',') };
}

/** "3723.4567" + "N" -> degrees, or null for an empty field. */
export function parseCoord(text, hemi) {
  if (!text) return null;
  const dot = text.indexOf('.');
  const deg = parseInt(text.slice(0, dot - 2), 10), min = parseFloat(text.slice(dot - 2));
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  const v = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -v : v;
}

/**
 * The rolling picture of the fix. Feed every sentence; read `snapshot()`.
 * fix: 'none' | '2d' | '3d'; satsUsed from GGA; satsInView from GSV; hdop, altM, lat, lon,
 * speedKmh, courseDeg, time (ms epoch, from RMC's date + time) when known.
 */
export class NmeaState {
  fix = 'none'; lat = null; lon = null; altM = null; hdop = null;
  satsUsed = 0; satsInView = 0; speedKmh = null; courseDeg = null; time = null;
  /** @type {number|null} ms clock of the last sentence seen (any, fix or not) */ at = null;

  /** @param {string} line @returns {boolean} true if it was an NMEA sentence */
  feed(line, now = Date.now()) {
    const s = parseSentence(line);
    if (!s) return false;
    this.at = now;
    const f = s.fields;
    switch (s.type) {
      case 'GGA': {   // time, lat, N/S, lon, E/W, quality, sats, hdop, alt, M, ...
        const quality = parseInt(f[5], 10) || 0;
        this.satsUsed = parseInt(f[6], 10) || 0;
        this.hdop = f[7] ? parseFloat(f[7]) : null;
        if (quality > 0) {
          this.lat = parseCoord(f[1], f[2]); this.lon = parseCoord(f[3], f[4]);
          this.altM = f[8] ? parseFloat(f[8]) : null;
        }   // quality 0: the last known position stays; GSA carries the fix downgrade
        break;
      }
      case 'GSA':   // mode, fix 1/2/3, sv*12, pdop, hdop, vdop
        this.fix = f[1] === '3' ? '3d' : f[1] === '2' ? '2d' : 'none';
        break;
      case 'GSV':   // total msgs, msg n, sats in view, ...
        this.satsInView = parseInt(f[2], 10) || 0;
        break;
      case 'RMC': {   // time, status, lat, N/S, lon, E/W, speed kn, course, date ddmmyy
        if (f[1] === 'A') {
          this.lat = parseCoord(f[2], f[3]) ?? this.lat; this.lon = parseCoord(f[4], f[5]) ?? this.lon;
          this.speedKmh = f[6] ? +(parseFloat(f[6]) * 1.852).toFixed(1) : null;
          this.courseDeg = f[7] ? parseFloat(f[7]) : null;
          if (f[8] && f[0]) {
            const [d, mo, y] = [f[8].slice(0, 2), f[8].slice(2, 4), f[8].slice(4, 6)];
            const century = y > '80' ? '19' : '20';   // and this 2013 chip may sit a 1024-week rollover in the past anyway
            this.time = Date.parse(`${century}${y}-${mo}-${d}T${f[0].slice(0, 2)}:${f[0].slice(2, 4)}:${f[0].slice(4, 6)}Z`) || null;
          }
        }
        break;
      }
    }
    return true;
  }

  snapshot() {
    const { fix, lat, lon, altM, hdop, satsUsed, satsInView, speedKmh, courseDeg, time, at } = this;
    return { fix, lat, lon, altM, hdop, satsUsed, satsInView, speedKmh, courseDeg, time, at };
  }
}
