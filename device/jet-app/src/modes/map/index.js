// Map mode: a basic OSM slippy map centred on the GPS fix, for "heya jet, check my location".
// Raster tiles (tile.openstreetmap.org, 256 px PNG) are fetched over WiFi, decoded on the device
// and blitted into the panel; a disk cache keeps a revisited area offline and light on the tile
// server. The glasses buttons zoom (front in, rear out); pad swipes pan, bounded to the area
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
      .property('tileUrl', s('string').default('https://tile.openstreetmap.org/{z}/{x}/{y}.png').meta('description', 'OSM raster tile template'))
      .property('userAgent', s('string').default('recon-jet-hud/1.0 (personal; v0.net)').meta('description', 'the tile server wants an identifying User-Agent'))
      .property('cacheDir', s('string').default('/android-data/mainline/map-tiles').meta('description', 'on-disk tile cache (revisits are offline)'))
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
  tileUrl; userAgent; cacheDir; zoom; minZoom; maxZoom; maxTiles; modes; ui; surface; gps; sounds; logger;

  id = 'map'; label = 'Map'; transient = true;
  /** @type {{lat: number, lon: number}|null} the view centre */ center = null;
  /** @type {{lat: number, lon: number}|null} the fix the map is anchored to (pan is bounded to it) */ anchor = null;
  follow = true;
  /** @type {Map<string, {img?: object, state: 'loading'|'ready'|'error'}>} "z/x/y" -> tile */ #tiles = new Map();
  #order = [];   // LRU of tile keys
  #inflight = 0;

  async start() {
    this.modes.register(this);
    this.gps?.on('update', (snap) => { if (this.modes.current === this && this.follow && snap.good) { this.center = { lat: snap.lat, lon: snap.lon }; this.anchor = this.center; this.ui.requestRender(); } });
  }

  /** Centre on the best position we have; a hint to a fix we pass in wins (the check flow). */
  enter({ lat, lon } = {}) {
    const fix = (lat != null && lon != null) ? { lat, lon } : this.gps?.goodFix() ?? (this.gps?.state.lat != null ? { lat: this.gps.state.lat, lon: this.gps.state.lon } : null);
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
    if (z === this.zoom) return true;
    this.zoom = z; this.sounds?.play?.('ack'); this.ui.requestRender();
    return true;
  }

  #recenter() {
    const fix = this.gps?.goodFix() ?? (this.gps?.state.lat != null ? { lat: this.gps.state.lat, lon: this.gps.state.lon } : null);
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
    // the GPS fix marker (may differ from centre if panned); else the centre crosshair
    const fix = this.gps?.goodFix();
    if (fix) {
      const fp = project(fix.lat, fix.lon, this.zoom);
      this.#marker(sfc, fp.x - left, fp.y - top, C.title);
    }
    this.#marker(sfc, W / 2, H / 2, this.follow && fix ? null : C.ok);   // crosshair at view centre
    // overlay: zoom, position, fix quality
    const g = this.gps?.state;
    const where = fix ? `${fix.lat.toFixed(5)} ${fix.lon.toFixed(5)}` : g?.lat != null ? `~${g.lat.toFixed(4)} ${g.lon.toFixed(4)}` : 'acquiring';
    this.#label(sfc, MARGIN, TOP, `z${this.zoom}`);
    this.#label(sfc, MARGIN, TOP + small.height + 2, where);
    if (!fix) this.#label(sfc, MARGIN, TOP + 2 * (small.height + 2), g ? `${g.satsUsed}/${g.satsInView} sats` : 'no gps');
    hint(sfc, this.follow ? 'front/rear: zoom   pad: pan' : 'front/rear: zoom   tap: recentre');
  }

  /** A small filled label with a dark backing so it reads over the map. */
  #label(sfc, x, y, text) {
    const { small } = sfc.fonts;
    sfc.fillRect(x - 2, y, text.length * small.width + 4, small.height, C.black);
    sfc.text(x, y, text, { font: small, colour: C.white });
  }

  #marker(sfc, x, y, colour) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x > sfc.width || y < 0 || y > sfc.height) return;
    if (colour === null) return;   // following a fix: the fix marker already shows here
    sfc.line(x - 5, y, x + 5, y, colour); sfc.line(x, y - 5, x, y + 5, colour);
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

  async #load(x, y, z, key, entry) {
    const file = path.join(this.cacheDir, `${z}`, `${x}`, `${y}.png`);
    try {   // disk cache first: offline and kind to the tile server
      const buf = await fsp.readFile(file);
      entry.img = decodePng(buf); entry.state = 'ready'; this.#repaint(key); return;
    } catch { /* not cached: fetch */ }
    // a small concurrency cap so a zoom change does not open dozens of sockets at once
    if (this.#inflight >= 4) { setTimeout(() => { if (this.#tiles.get(key) === entry && entry.state === 'loading') this.#load(x, y, z, key, entry); }, 150); return; }
    this.#inflight++;
    const url = this.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    https.get(url, { headers: { 'User-Agent': this.userAgent }, timeout: 15000 }, (res) => {
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
