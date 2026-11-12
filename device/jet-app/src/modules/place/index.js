// place: where the wearer is, in words. The GPS gives numbers and the model cannot turn numbers
// into a place (asked what is at 37.7822, -122.2478 it answered, with confidence, a hospital in
// another city), so this does it: the last good fix, and the nearest towns to it from an
// offline table (GeoNames cities over 15,000 people, `assets/places/`, CC BY 4.0). Offline on
// purpose: no network on a hillside, and a position is not something to send to a lookup
// service on every question.
//
// It is a ContextSource for the agent ("at 37.7822, -122.2478, fix 2 min old: in or near
// Alameda, California, US (1.4 km from its centre); Oakland is 2.6 km away"). The fix is kept
// after the receiver is switched off - on this hardware GPS and WiFi share a radio, so the
// practical sequence is: get a fix, GPS off, talk - and across a restart (`file`).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Schema } from '@versionzero/module-manager';
import { appRoot } from '../../lib/config.js';

const s = Schema.create;
const RAD = Math.PI / 180;

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** `lat\tlon\tname\tregion\tcountry` lines -> typed columns (flat arrays: 34,000 rows on a small machine). */
export function parsePlaces(tsv) {
  const lines = tsv.split('\n').filter(Boolean), lat = new Float32Array(lines.length), lon = new Float32Array(lines.length), label = new Array(lines.length);
  lines.forEach((line, i) => { const f = line.split('\t'); lat[i] = +f[0]; lon[i] = +f[1]; label[i] = [f[2], f[3], f[4]].filter(Boolean).join(', '); });
  return { lat, lon, label };
}

/** The `n` nearest places to a point, nearest first: `[{label, km}]`. */
export function nearest({ lat, lon, label }, at, n = 2) {
  const best = [];
  for (let i = 0; i < label.length; i++) {
    if (Math.abs(lat[i] - at.lat) > 1.5) continue;   // > ~160 km north or south: not a neighbour
    const km = distanceKm(at.lat, at.lon, lat[i], lon[i]);
    if (best.length < n || km < best.at(-1).km) { best.push({ label: label[i], km }); best.sort((a, b) => a.km - b.km); if (best.length > n) best.pop(); }
  }
  return best;
}

const km = (v) => (v < 10 ? `${v.toFixed(1)} km` : `${Math.round(v)} km`);
const age = (ms) => (ms < 90_000 ? 'just now' : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min old` : `${Math.round(ms / 3_600_000)} h old`);

export class Place {
  static moduleInfo = {
    name: 'place',
    provides: 'ContextSource',
    schema: s()
      .property('table', s('string').default('assets/places/cities15000.tsv.gz').meta('description', 'the offline place table (gzipped TSV: lat, lon, name, region, country), relative to the app'))
      .property('file', s('string').default('/android-data/mainline/place.json').meta('description', 'the last good fix is kept here across restarts; empty = not kept'))
      .property('maxAgeS', s('number').default(21600).meta('description', 'a fix older than this is no longer offered as where the wearer is'))
      .property('gps', s('Gps').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  table; file; maxAgeS; gps; logger;

  /** ContextSource id */ id = 'place';
  now = () => Date.now();
  /** @type {{lat: number, lon: number, t: number}|null} the last good fix */ fix = null;
  /** @type {{label: string, km: number}[]} the nearest towns to it */ near = [];
  #places = null; #saved = 0;
  #onGps = (state) => { if (state?.good && Number.isFinite(state.lat) && Number.isFinite(state.lon)) this.locate(state.lat, state.lon); };

  async start() {
    if (this.file) {
      try { const o = JSON.parse(await fs.promises.readFile(this.file, 'utf8')); if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) this.locate(o.lat, o.lon, o.t, { save: false }); }
      catch { /* no fix kept yet */ }
    }
    this.gps?.on?.('update', this.#onGps);
  }
  async stop() { this.gps?.off?.('update', this.#onGps); }

  /** A good fix: remember it and name it. The table is read on the first one (~0.5 MB gzipped). */
  locate(lat, lon, t = this.now(), { save = true } = {}) {
    const moved = !this.fix || distanceKm(this.fix.lat, this.fix.lon, lat, lon) > 0.2;
    this.fix = { lat, lon, t };
    if (moved) {
      try {
        this.#places ??= parsePlaces(zlib.gunzipSync(fs.readFileSync(path.resolve(appRoot, this.table))).toString('utf8'));
        this.near = nearest(this.#places, this.fix, 2);
        this.logger?.info({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), near: this.near.map((p) => `${p.label} ${km(p.km)}`) }, 'place');
      } catch (error) { this.logger?.warn({ error: error.message }, 'place: no table'); this.near = []; }
    }
    if (save && this.file && (moved || t - this.#saved > 60_000)) {
      this.#saved = t;
      fs.promises.writeFile(this.file, JSON.stringify(this.fix) + '\n').catch((error) => this.logger?.warn({ error: error.message }, 'place: not saved'));
    }
  }

  /** ContextSource: the position and what it is near; null without a usable fix. */
  context() {
    const f = this.fix, old = f ? this.now() - f.t : Infinity;
    if (!f || old > this.maxAgeS * 1000) return null;
    const [a, b] = this.near;
    const where = a ? `: in or near ${a.label} (${km(a.km)} from its centre)${b && b.km < 3 * Math.max(a.km, 2) ? `; ${b.label.split(',')[0]} is ${km(b.km)} away` : ''}` : '';
    return `Your partner's position by GPS (fix ${age(old)}): ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}${where}. Only if the question is about where they are or what is around them: use the place name (you cannot tell places from coordinates yourself). Otherwise leave it out.`;
  }
}
