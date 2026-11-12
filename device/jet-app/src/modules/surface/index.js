// surface: jetd's external pixel surface. On connect it takes the panel over (`E 1`), sizes an
// RGB565 Raster from the reply, and `flush()` writes only what changed to the framebuffer
// device (plain positional writes, no mmap) then asks jetd to push that rectangle (`F x y w h`).
// The drawing API is the Raster's, delegated. `viewfinder()` hands a rectangle to jetd's camera
// stream (`Z`); the surface never writes that rectangle while it is active.
// `active` gates flushing (jetd ignores `F` outside remote mode; the ui keeps it in step).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { appRoot } from '../../lib/config.js';
import { parsePsf } from './psf.js';
import { Raster, diffRect, intersect, union } from './raster.js';
import { ICONS } from './icons.js';

const s = Schema.create;

export class Surface extends EventEmitter {
  static moduleInfo = {
    name: 'surface',
    schema: s()
      .property('device', s('string').default('/dev/fb0').meta('description', 'framebuffer device to write'))
      .property('minFlushMs', s('number').default(30).meta('description', 'minimum interval between flushes'))
      .property('fontDir', s('string').default(path.join(appRoot, 'assets', 'fonts')).meta('description', 'directory holding the PSF fonts'))
      .property('mainFont', s('string').default('ter-u20b.psf').meta('description', 'headings (10x20 bold)'))
      .property('smallFont', s('string').default('Lat2-Terminus12x6.psf').meta('description', 'details (6x12)'))
      .property('viewfinderFps', s('number').default(10).meta('description', 'default camera rectangle rate'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  device; minFlushMs; fontDir; mainFont; smallFont; viewfinderFps; deviceLink; logger;

  /** @type {{main: import('./psf.js').PsfFont, small: import('./psf.js').PsfFont}} */ fonts;
  icons = ICONS;
  /** @type {Raster|null} */ raster = null;
  /** @type {{w:number, h:number, bpp:number, stride:number}|null} from jetd's `E` reply */ geometry = null;
  /** @type {import('./raster.js').Rect|null} jetd's camera rectangle while streaming */ viewfinderRect = null;
  /** the camera stream is held off (display dark); what the mode asked for waits in #vf for `resumeViewfinder()` */ viewfinderPaused = false;
  active = false;
  #fd = -1; #shown = null; #force = null; #lastFlush = 0; #timer = null; #vf = null;

  get ready() { return this.raster !== null; }
  get width() { return this.raster?.width ?? 0; }
  get height() { return this.raster?.height ?? 0; }

  /** @param {AbortController} [abort] the app's run controller: aborted before any module stops */
  async start(abort) {
    const load = (file) => parsePsf(fs.readFileSync(path.join(this.fontDir, file)));
    this.fonts = { main: load(this.mainFont), small: load(this.smallFont) };
    this.deviceLink.on('connected', () => this.#acquire());
    this.deviceLink.on('hello', () => this.invalidate());
    // a drop (jetd restart included) resets the streaming state but keeps #vf — the rect the
    // owning mode still wants — so #acquire can re-arm it once the geometry is back
    this.deviceLink.on('disconnected', () => { this.raster = null; this.geometry = null; this.viewfinderRect = null; this.active = false; });
    if (this.deviceLink.connected) this.#acquire();
    // modules stop in dependency order (the link first), so the panel is handed back at abort time
    abort?.signal.addEventListener('abort', () => this.#release(), { once: true });
  }

  async stop() { clearTimeout(this.#timer); this.#release(); this.#close(); }

  #release() {
    this.stopViewfinder();
    if (!this.raster || !this.deviceLink.connected) return;
    this.deviceLink.surface(false).catch(() => {});
    this.raster = null; this.active = false;
    this.logger?.info('surface released');
  }

  async #acquire() {
    try {
      const g = await this.deviceLink.surface(true);
      if (g.bpp !== 16) this.logger?.warn({ bpp: g.bpp }, 'panel is not 16 bpp; colours will be wrong');
      this.geometry = g;
      this.raster = new Raster(g.w, g.h, { pitch: g.stride >> 1 });
      this.#shown = null; this.#force = null; this.viewfinderRect = null;
      // jetd's viewfinder outlives the client that asked for it: after a crash and a restart the
      // camera is still streaming into a rectangle nobody here knows about, over every screen.
      // Whatever is wanted now is asked for again below.
      this.deviceLink.viewfinderStop();
      this.#close();
      try { this.#fd = fs.openSync(this.device, 'w'); }
      catch (error) { this.logger?.error({ error: error.message, device: this.device }, 'framebuffer open failed; nothing will be drawn'); }
      this.logger?.info({ ...g, device: this.device }, 'surface acquired');
      this.emit('ready', g);
      // re-arm a viewfinder that a drop interrupted, now that the geometry is real again —
      // but let the owning mode's own request win: it re-renders on hello with fresh coordinates
      if (this.#vf && !this.viewfinderPaused) this.#stream().catch((error) => this.logger?.warn({ error: error.message }, 'viewfinder re-arm'));
    } catch (error) {
      this.logger?.warn({ error: error.message }, 'surface request failed');
    }
  }

  #close() { if (this.#fd >= 0) fs.closeSync(this.#fd); this.#fd = -1; }

  /** Everything must be rewritten (jetd's other modes drew over us, or remote mode came back). */
  invalidate() { this.#shown = null; this.raster?.touch(this.raster.bounds); }

  // ---- drawing (see raster.js) ---------------------------------------------------------
  clear(colour) { this.raster?.clear(colour); }
  fillRect(x, y, w, h, colour) { this.raster?.fillRect(x, y, w, h, colour); }
  strokeRect(x, y, w, h, colour, options) { this.raster?.strokeRect(x, y, w, h, colour, options); }
  fillCircle(cx, cy, r, colour) { this.raster?.fillCircle(cx, cy, r, colour); }
  line(x0, y0, x1, y1, colour) { this.raster?.line(x0, y0, x1, y1, colour); }
  text(x, y, str, options) { return this.raster?.text(x, y, str, { font: this.fonts.main, ...options }); }
  measureText(str, options) { return this.raster?.measureText(str, { font: this.fonts.main, ...options }); }
  blitRGB565(buf, x, y, w, h, options) { this.raster?.blitRGB565(buf, x, y, w, h, options); }
  blitImage(image, x, y, options) { this.raster?.blitImage(image, x, y, options); }
  icon(x, y, icon, colour, options) { this.raster?.icon(x, y, icon, colour, options); }
  /** Decode a JPEG into the RGBA image `blitImage` takes. @param {Buffer} buf */
  decodeJpeg(buf) { return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); }

  // ---- flushing ------------------------------------------------------------------------
  /** Write the changed rectangle to the framebuffer and push it. Returns the rectangle, or null. */
  flush() {
    // the live link mode, not just the event-driven `active` flag: setMode flips the mode
    // optimistically, and a frame flushed in the ACK window lands on jetd's own screen (the
    // shell-entry race: the placeholder overwrote the console)
    if (!this.active || this.deviceLink.mode !== 'remote' || !this.raster || !this.deviceLink.connected) return null;
    const wait = this.minFlushMs - (Date.now() - this.#lastFlush);
    if (wait > 0) { clearTimeout(this.#timer); this.#timer = setTimeout(() => this.flush(), wait); return null; }
    const { raster } = this;
    let rect = raster.takeDirty();
    if (this.#shown) rect = union(rect && diffRect(raster.bytes, this.#shown, rect, raster.pitch), this.#force);
    else { rect = raster.bounds; this.#shown = Buffer.alloc(raster.bytes.length); }
    this.#force = null;
    if (!rect) return null;
    const t0 = performance.now();
    if (this.#fd >= 0) this.#write(rect);
    raster.bytes.copy(this.#shown, rect.y * raster.pitch * 2, rect.y * raster.pitch * 2, (rect.y + rect.h) * raster.pitch * 2);
    this.deviceLink.flushRect(rect.x, rect.y, rect.w, rect.h);
    this.#lastFlush = Date.now();
    this.logger?.debug({ ...rect, writeMs: +(performance.now() - t0).toFixed(2) }, 'flush');
    return rect;
  }

  // The rows of `rect` go to the device in one positional write (a syscall costs more than the
  // unchanged bytes beside the rectangle, which match the panel anyway); only rows that cross
  // the viewfinder rectangle are written as spans so jetd's pixels stay untouched.
  #write(rect) {
    const { bytes, pitch, width } = this.raster, stride = pitch * 2;
    const vf = intersect({ x: 0, y: rect.y, w: width, h: rect.h }, this.viewfinderRect);
    if (!vf && stride === width * 2) {
      fs.writeSync(this.#fd, bytes, rect.y * stride, rect.h * stride, rect.y * stride);
      return;
    }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const spans = vf && y >= vf.y && y < vf.y + vf.h
        ? [[rect.x, vf.x - rect.x], [vf.x + vf.w, rect.x + rect.w - vf.x - vf.w]]
        : [[rect.x, rect.w]];
      for (const [x, w] of spans) if (w > 0) fs.writeSync(this.#fd, bytes, y * stride + x * 2, w * 2, y * stride + x * 2);
    }
  }

  // ---- camera rectangle ------------------------------------------------------------------
  /**
   * Stream the camera into (x, y, w, h) at `fps`. Resolves with the source size `{w, h}`, or null
   * while paused: the stream then starts on `resumeViewfinder()`.
   */
  async viewfinder(x, y, w, h, fps = this.viewfinderFps) {
    // no geometry: the caller computed this rect from width 0, so it must not become the stored
    // want (the owner re-requests on 'ready' with real numbers; see demo mode)
    if (!this.ready) { this.logger?.info({ x, y, w, h }, 'viewfinder parked (no surface yet)'); return null; }
    this.#vf = { x, y, w, h, fps };
    if (this.viewfinderPaused) { this.logger?.info({ x, y, w, h }, 'viewfinder parked'); return null; }
    return this.#stream();
  }

  /** jetd starts streaming the wanted rectangle; a stop or pause that raced the reply wins. */
  async #stream() {
    if (!this.ready) return null;   // belt: viewfinder() already refuses to store without geometry
    const p = this.#vf;
    const src = await this.deviceLink.viewfinder(p.x, p.y, p.w, p.h, p.fps);
    if (this.#vf !== p || this.viewfinderPaused) { this.deviceLink.viewfinderStop(); return null; }
    this.viewfinderRect = { x: p.x, y: p.y, w: p.w, h: p.h };
    this.logger?.info({ ...p, src }, 'viewfinder started');
    return src;
  }

  stopViewfinder() { this.#vf = null; this.#halt('stopped'); }

  /** Hold the camera off (the display is dark); the mode's request is kept for `resumeViewfinder()`. */
  pauseViewfinder() { if (!this.viewfinderPaused) { this.viewfinderPaused = true; this.#halt('paused'); } }

  resumeViewfinder() {
    if (!this.viewfinderPaused) return;
    this.viewfinderPaused = false;
    if (this.#vf) this.#stream().catch((error) => this.logger?.warn({ error: error.message }, 'viewfinder resume'));
  }

  #halt(why) {
    const rect = this.viewfinderRect;
    if (!rect) return;
    this.viewfinderRect = null;
    this.deviceLink.viewfinderStop();
    this.#force = union(this.#force, rect);   // our pixels go back on the next flush
    this.raster?.touch(rect);
    this.logger?.info(`viewfinder ${why}`);
  }
}
