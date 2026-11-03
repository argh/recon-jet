// Map mode: a basic slippy map centred on the GPS fix, for "heya jet, check my location".
// Raster tiles (OpenStreetMap standard, 256 px PNG) are fetched over WiFi, decoded on the device
// and blitted into the panel; a disk cache keeps a revisited area offline and light on the tile
// server. OSM is keyless and holds up best here; the dark CARTO styles that need a key looked
// worse on the panel. For a keyed provider later, set tileUrl to its template and mapMode.tileKey
// in the per-device config layer (it is appended as ?key= and never committed); the cache is
// keyed by style so a swap stays clean. Data/tiles (c) OpenStreetMap contributors.
// The last good fix is kept on disk, so a cold open indoors still centres somewhere; until a live
// fix lands the position reads as stale (a hollow amber ring, "last fix N ago") not current (a
// solid green dot). The glasses buttons zoom (front in, rear out); pad swipes pan, bounded to the area
// around the fix so the map stays local and the fetch stays small; a tap recentres and follows
// the fix again. hold:front opens the switcher to leave, as everywhere. Not a persisted start
// mode: it needs a position. While GPS is on WiFi is slow (coex), so first paint can take a
// second; cached tiles are instant.
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, hint, row } from '../../modules/ui/style.js';
import { decodePng } from '../../lib/png.js';
import { project, unproject, coverViewport, clampLat, TILE } from '../../lib/slippy.js';

const s = Schema.create;
const PAN_TILES = 2;   // how far from the fix a pan may wander, in tiles

export class MapMode {
  static moduleInfo = {
    name: 'map-mode',
    schema: s()
      .property('tileUrl', s('string').default('https://tile.openstreetmap.org/{z}/{x}/{y}.png').meta('description', 'raster tile template; OpenStreetMap standard by default (keyless)'))
      .property('tileKey', s('string').default('').meta('description', 'tile-server API key for a keyed provider, appended as ?key=; set per-device, never committed'))
      .property('userAgent', s('string').default('recon-jet-hud/1.0 (github.com/argh/recon-jet)').meta('description', 'the tile server wants an identifying User-Agent; tile policies prefer a contact, so setup.sh offers a personalised one'))
      .property('cacheDir', s('string').default('/android-data/mainline/map-tiles').meta('description', 'on-disk tile cache (revisits are offline); subfoldered by style'))
      .property('lastFixFile', s('string').default('/android-data/mainline/map-last-fix.json').meta('description', 'last good position, so the map opens before a fix lands'))
      .property('saveMs', s('number').default(60000).meta('description', 'minimum interval between last-fix writes to flash'))
      .property('zoom', s('number').default(16).meta('description', 'initial zoom (streets)'))
      .property('minZoom', s('number').default(10).meta('description'))
      .property('maxZoom', s('number').default(18).meta('description', 'OSM has tiles to 19'))
      .property('maxTiles', s('number').default(192).meta('description', 'in-memory tile cap (LRU)'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('gps', s('Gps').meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  tileUrl; tileKey; userAgent; cacheDir; lastFixFile; saveMs; zoom; minZoom; maxZoom; maxTiles; modes; ui; surface; gps; sounds; logger;

  id = 'map'; label = 'Map'; transient = true;
  /** @type {{lat: number, lon: number}|null} the view centre */ center = null;
  /** @type {{lat: number, lon: number}|null} the fix the map is anchored to (pan is bounded to it) */ anchor = null;
  /** @type {{lat: number, lon: number, at: number}|null} last good fix, in memory and on disk */ #lastFix = null;
  #savedAt = 0;
  follow = true;
  /** @type {Map<string, {img?: object, state: 'loading'|'ready'|'error'}>} "z/x/y" -> tile */ #tiles = new Map();
  #order = [];   // LRU of tile keys
  #inflight = 0;

  async start() {
    this.modes.register(this);
    try {   // the last position from a previous run, so a cold open has somewhere to go
      const saved = JSON.parse(fs.readFileSync(this.lastFixFile, 'utf8'));
      if (saved?.lat != null && saved?.lon != null) this.#lastFix = { lat: saved.lat, lon: saved.lon, at: saved.at || 0 };
    } catch { /* none yet */ }
    this.gps?.on('update', (snap) => {
      if (snap.good) this.#remember(snap);
      if (this.modes.current === this && this.follow && snap.good) { this.center = { lat: snap.lat, lon: snap.lon }; this.anchor = this.center; this.ui.requestRender(); }
    });
  }

  /** Keep the freshest good fix in memory, and write it back to flash at most every `saveMs`. */
  #remember(snap) {
    this.#lastFix = { lat: snap.lat, lon: snap.lon, at: snap.at || Date.now() };
    if (Date.now() - this.#savedAt < (this.saveMs ?? 60000)) return;
    this.#savedAt = Date.now();
    if (this.lastFixFile) fsp.writeFile(this.lastFixFile, JSON.stringify(this.#lastFix)).catch(() => {});
  }

  /** Centre on the best position we have; a hint to a fix we pass in wins (the check flow). The
   *  last good fix from disk is the final fallback, so the map still opens before a live fix. */
  enter({ lat, lon } = {}) {
    const fix = (lat != null && lon != null) ? { lat, lon }
      : this.gps?.goodFix()
      ?? (this.gps?.state.lat != null ? { lat: this.gps.state.lat, lon: this.gps.state.lon } : null)
      ?? this.#lastFix;
    this.center = fix ? { lat: fix.lat, lon: fix.lon } : this.center;
    this.anchor = fix ? { lat: fix.lat, lon: fix.lon } : this.anchor;
    this.follow = true;
    if (!this.gps?.listening) this.gps?.listen();   // keep the fix live while the map is up
  }
  leave() { /* GPS stays as the user left it; Location controls that */ }

  onGesture(g) {
    switch (g) {
      case 'press:front': return this.#zoom(1);
      case 'press:rear': return this.#zoom(-1);
      case 'press:tap': this.#recenter(); return true;
      case 'swipe:up': return this.#pan(0, -1);
      case 'swipe:down': return this.#pan(0, 1);
      case 'swipe:left': return this.#pan(-1, 0);
      case 'swipe:right': return this.#pan(1, 0);
      default: return false;
    }
  }

  #zoom(d) {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + d));
    if (z === this.zoom) return d > 0;   // zoom-out at minimum is unconsumed: rear ascends out of the map
    this.zoom = z; this.sounds?.play?.('ack'); this.ui.requestRender();
    return true;
  }

  #recenter() {
    const fix = this.gps?.goodFix() ?? (this.gps?.state.lat != null ? { lat: this.gps.state.lat, lon: this.gps.state.lon } : null) ?? this.#lastFix;
    if (fix) { this.center = { lat: fix.lat, lon: fix.lon }; this.anchor = { lat: fix.lat, lon: fix.lon }; }
    this.follow = true; this.ui.requestRender();
  }

  /** Pan by ~a third of the screen, bounded to PAN_TILES of the anchor. */
  #pan(dx, dy) {
    if (!this.center) return true;
    this.follow = false;
    const p = project(this.center.lat, this.center.lon, this.zoom);
    let np = { x: p.x + dx * this.surface.width / 3, y: p.y + dy * this.surface.height / 3 };
    if (this.anchor) {   // clamp to a box around the fix so the map stays local
      const a = project(this.anchor.lat, this.anchor.lon, this.zoom), lim = PAN_TILES * TILE;
      np.x = Math.max(a.x - lim, Math.min(a.x + lim, np.x));
      np.y = Math.max(a.y - lim, Math.min(a.y + lim, np.y));
    }
    const u = unproject(np.x, np.y, this.zoom);
    this.center = { lat: clampLat(u.lat), lon: ((u.lon + 540) % 360) - 180 };
    this.ui.requestRender();
    return true;
  }

  render(sfc) {
    const { small } = sfc.fonts, W = sfc.width, H = sfc.height;
    if (!this.center) {
      sfc.text(MARGIN, TOP + 20, 'no position yet', { font: sfc.fonts.main, colour: C.dim });
      hint(sfc, 'front/rear: zoom   tap: recentre');
      return;
    }
    const c = project(this.center.lat, this.center.lon, this.zoom);
    const left = c.x - W / 2, top = c.y - H / 2;
    const cov = coverViewport(left, top, W, H, this.zoom);
    for (const t of cov.tiles) {
      const tile = this.#get(t.x, t.y, this.zoom);
      if (tile?.state === 'ready') sfc.blitImage(tile.img, Math.round(t.sx), Math.round(t.sy));
      else { sfc.fillRect(Math.round(t.sx), Math.round(t.sy), TILE, TILE, C.panel); if (tile?.state !== 'error') sfc.text(Math.round(t.sx) + 8, Math.round(t.sy) + 8, '...', { font: small, colour: C.faint }); }
    }
    // the position marker (may differ from centre if panned): a live good fix reads current (solid
    // green), the last-known fix reads stale (hollow amber). The centre crosshair shows only when
    // panned away from the marker (while following, the marker sits at centre already).
    const g = this.gps?.state;
    const m = this.#marker();
    if (m) {
      const mp = project(m.lat, m.lon, this.zoom);
      const course = m.live && g && g.speedKmh != null && g.speedKmh >= 3 ? g.courseDeg : null;   // only when moving
      this.#fixMarker(sfc, mp.x - left, mp.y - top, course, m.live);
    }
    if (!(this.follow && m)) this.#crosshair(sfc, W / 2, H / 2, C.ok);
    // overlay: zoom, position, and whether it is current or stale
    this.#label(sfc, MARGIN, TOP, `z${this.zoom}`);
    let ly = TOP + small.height + 2;
    if (m?.live) {
      this.#label(sfc, MARGIN, ly, `${m.lat.toFixed(5)} ${m.lon.toFixed(5)}`);
    } else if (m) {   // a cached position, with no live fix: say how old, and that we are still trying
      this.#label(sfc, MARGIN, ly, `last fix ${this.#ago(m.at)}`, C.warn); ly += small.height + 2;
      this.#label(sfc, MARGIN, ly, `${m.lat.toFixed(5)} ${m.lon.toFixed(5)}`, C.dim); ly += small.height + 2;
      this.#label(sfc, MARGIN, ly, g ? `acquiring ${g.satsUsed}/${g.satsInView}` : 'no gps', C.dim);
    } else {
      this.#label(sfc, MARGIN, ly, g ? `acquiring ${g.satsUsed}/${g.satsInView}` : 'acquiring', C.dim);
    }
    hint(sfc, this.follow ? 'front/rear: zoom   pad: pan' : 'front/rear: zoom   tap: recentre');
  }

  /** A small filled label with a dark backing so it reads over the map. */
  #label(sfc, x, y, text, colour = C.white) {
    const { small } = sfc.fonts;
    sfc.fillRect(x - 2, y, text.length * small.width + 4, small.height, C.black);
    sfc.text(x, y, text, { font: small, colour });
  }

  /** The position to mark and whether it is a live good fix: a live fix wins, else the last known
   *  one (shown stale). @returns {{lat:number, lon:number, at?:number, live:boolean}|null} */
  #marker() {
    const fix = this.gps?.goodFix();
    if (fix) return { lat: fix.lat, lon: fix.lon, at: fix.at, live: true };
    if (this.#lastFix) return { ...this.#lastFix, live: false };
    return null;
  }

  /** A terse age for a stale fix: `45s`, `12m`, `3h`, `2d`. */
  #ago(at) {
    if (!at) return 'a while ago';
    const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 90) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 90) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return hr < 48 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
  }

  /** The position dot: a dark halo, a white ring and a bright core, so it reads over any tile; a
   *  bright needle (dark-cased) points along `course` when we are moving. A stale (last-known) fix
   *  is instead a hollow amber ring, with no heading, to read as "not current". */
  #fixMarker(sfc, x, y, course, live = true) {
    x = Math.round(x); y = Math.round(y);
    if (x < -8 || x > sfc.width + 8 || y < -8 || y > sfc.height + 8) return;
    if (!live) {
      sfc.fillCircle(x, y, 7, C.black);   // halo
      sfc.fillCircle(x, y, 6, C.warn);    // amber
      sfc.fillCircle(x, y, 3, C.black);   // hollow centre: a ring, clearly not the live dot
      return;
    }
    if (course != null) {   // draw the needle under the dot so the dot caps its base
      const a = (course - 90) * Math.PI / 180, r1 = 15;
      const x1 = x + r1 * Math.cos(a), y1 = y + r1 * Math.sin(a);
      const px = Math.round(Math.cos(a + Math.PI / 2)), py = Math.round(Math.sin(a + Math.PI / 2));
      sfc.line(x + px, y + py, x1 + px, y1 + py, C.black);   // 1 px dark casing either side
      sfc.line(x - px, y - py, x1 - px, y1 - py, C.black);
      sfc.line(x, y, x1, y1, C.title);
    }
    sfc.fillCircle(x, y, 7, C.black);   // halo lifts it off the map
    sfc.fillCircle(x, y, 6, C.white);   // contrast ring (reads on dark and light)
    sfc.fillCircle(x, y, 4, C.ok);      // bright core
  }

  /** A plain crosshair marking the view centre when panned off the fix. */
  #crosshair(sfc, x, y, colour) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x > sfc.width || y < 0 || y > sfc.height) return;
    sfc.line(x - 6, y, x - 2, y, colour); sfc.line(x + 2, y, x + 6, y, colour);
    sfc.line(x, y - 6, x, y - 2, colour); sfc.line(x, y + 2, x, y + 6, colour);
  }

  // ---- tiles ----------------------------------------------------------------------------------
  #get(x, y, z) {
    const key = `${z}/${x}/${y}`;
    const have = this.#tiles.get(key);
    if (have) { const i = this.#order.indexOf(key); if (i >= 0) { this.#order.splice(i, 1); this.#order.push(key); } return have; }
    const entry = { state: 'loading' };
    this.#tiles.set(key, entry); this.#order.push(key);
    while (this.#order.length > this.maxTiles) this.#tiles.delete(this.#order.shift());
    this.#load(x, y, z, key, entry);
    return entry;
  }

  /** A filesystem-safe slug for the current tile style (everything up to the {z} placeholder), so
   *  swapping tileUrl does not serve another style's cached tiles. */
  get #style() { return (this.tileUrl.split('{z}')[0] || 'tiles').replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase(); }

  async #load(x, y, z, key, entry) {
    const file = path.join(this.cacheDir, this.#style, `${z}`, `${x}`, `${y}.png`);
    try {   // disk cache first: offline and kind to the tile server
      const buf = await fsp.readFile(file);
      entry.img = decodePng(buf); entry.state = 'ready'; this.#repaint(key); return;
    } catch { /* not cached: fetch */ }
    // a small concurrency cap so a zoom change does not open dozens of sockets at once
    if (this.#inflight >= 4) { setTimeout(() => { if (this.#tiles.get(key) === entry && entry.state === 'loading') this.#load(x, y, z, key, entry); }, 150); return; }
    this.#inflight++;
    const url = this.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);   // keyless: used in logs
    const req = this.tileKey ? url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(this.tileKey) : url;
    https.get(req, { headers: { 'User-Agent': this.userAgent }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); this.#inflight--; entry.state = 'error'; this.logger?.warn({ url, status: res.statusCode }, 'map: tile http'); this.#repaint(key); return; }
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        this.#inflight--;
        try {
          const buf = Buffer.concat(chunks);
          entry.img = decodePng(buf); entry.state = 'ready';
          fsp.mkdir(path.dirname(file), { recursive: true }).then(() => fsp.writeFile(file, buf)).catch(() => {});
        } catch (error) { entry.state = 'error'; this.logger?.warn({ url, error: error.message }, 'map: tile decode'); }
        this.#repaint(key);
      });
    }).on('error', (error) => { this.#inflight--; entry.state = 'error'; this.logger?.warn({ url, error: error.message }, 'map: tile fetch'); this.#repaint(key); })
      .on('timeout', function () { this.destroy(); });
  }

  #repaint(key) { if (this.modes.current === this && this.#tiles.has(key)) this.ui.requestRender(); }
}
