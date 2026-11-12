// Scan mode: what the glasses have seen, as a view over the `world` model, and the switch for
// the `scanner` (docs/agent.md). While scanning, the camera runs in the top right corner (the
// surface viewfinder) and the entities are tiles to its left - crop, name, kind, newest claim,
// age - re-sorted as sightings land; off, the same tiles are the full-width review list.
//
// The column under the strip's right end says what the scanner is doing, without words to
// tell apart. The viewfinder's border is the readiness to capture: grey while no capture can
// happen (the last frame is still being analysed), else a grey track filling green, clockwise,
// towards the next capture (`scanner.due`; full at the capture). The frame being analysed
// (`scanner.frame`) slides out from under the viewfinder into the slot below it and stays
// there, a bright segment circling its border, until its analysis ends and the slot clears.
// Those move, so a timer of the view's own repaints at `frameMs` - only while the mode is
// showing, scanning, not under the menu, and something on the glass is in fact changing.
//
// Gestures. Front is the scanner's switch (`scanner.toggle()`), whatever is selected. Swipe
// up/down selects; swipe right opens the selected entity (larger crop, pinned, first/last seen,
// where, the claims newest first; up/down scrolls) and swipe left closes it; inside, front pins
// or unpins. Rear steps back: detail, selection, and at the root it is not consumed (the
// registry ascends). What is selected or open is published as `world.focus`: it is what "this"
// means in a question asked now.
//
// It subscribes to the world and the scanner only while showing, and leaving it stops the
// camera and the scanning - a scan costs a model slot and ~85 mA of camera, so it does not
// outlive the mode that shows it. The camera is a jetd-side overlay the modal mode menu does not
// cover, so it is paused while the switcher is up (as Describe does), and stopped while a
// detail has the panel. Ages are relative, so the 1 s tick looks at what is on the glass and
// repaints only when one of those words changes.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, hint, panel } from '../../modules/ui/style.js';
import { CardList, DetailView } from '../../modules/ui/cards.js';
import { ring } from '../../modules/ui/ring.js';

const s = Schema.create;
const CAMERA = { w: 120, h: 90 };
const BORDER = 2;       // around the viewfinder and around the analysed frame
const SLIDE_MS = 300;   // the captured frame's way from the viewfinder into its slot
const LAP_MS = 1200;    // once round the analysed frame
const SEGMENT = 0.25;   // of the border, the circling part
const around = (r) => ({ x: r.x - BORDER, y: r.y - BORDER, w: r.w + 2 * BORDER, h: r.h + 2 * BORDER });
const clamp = (v) => Math.max(0, Math.min(1, v));
const clock = (t) => new Date(t).toTimeString().slice(0, 5);

/** An age in words that change rarely: now, 10s..50s, 1m..59m, 1h..23h, 1d.. (nothing on the glass jitters). */
export function age(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec - sec % 10}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
const ago = (ms) => { const a = age(ms); return a === 'now' ? 'just now' : `${a} ago`; };

export class ScanMode {
  static moduleInfo = {
    name: 'scan-mode',
    schema: s()
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('world', s('World').meta('internal', true))
      .property('scanner', s('Scanner').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  modes; ui; world; scanner; surface; logger;

  id = 'scan'; label = 'Scan'; spoken = ['scan', 'scanner'];
  /** the clock, a field so tests own time */ now = () => Date.now();
  /** the animation's period while something moves: ~9 fps (a repaint is 15-30 ms on this CPU) */ frameMs = 110;
  #list = new CardList({ anchor: 'start' });
  #detail = new DetailView();
  /** @type {string|null} the entity open in the detail view */ #open = null;
  #showing = false;
  #camera = false;     // the viewfinder is asked for
  #strip = false;      // the status strip carries our word
  #paused = false;     // we are holding the camera off under the mode menu
  #timer = null;       // the animation, while something on the glass moves
  #frameAt = 0;        // when the frame under analysis appeared: where its slide and its circling start
  /** @type {string[]} ids of the tiles on the glass */ #drawn = [];
  /** when the words on the glass were worked out: a tick compares the ages then with the ages now */ #at = 0;
  #onWorld = () => { this.#refresh(); this.ui.requestRender(); };
  #onScanner = () => { this.#sync(); this.ui.requestRender(); };
  #onFrame = (frame) => { this.#frameAt = frame ? this.now() : 0; this.#onScanner(); };
  #onReady = () => { this.#camera = false; this.#sync(); };   // the surface came back: re-request with its fresh geometry
  #onSwitcher = (open) => {
    if (open) { this.#paused = true; this.surface.pauseViewfinder('menu'); this.#animate(); return; }
    // deferred: a menu dismissed by picking another mode has left us (and stopped the camera) by then
    queueMicrotask(() => { if (this.#showing) this.#resume(); });
  };

  async start() { this.modes.register(this); }   // before any await: registration order is the switcher's order

  enter() {
    this.#showing = true; this.#open = null; this.#list.follow();
    this.world.on('change', this.#onWorld);       // we know we are showing: our models tell us when to repaint
    this.scanner.on('state', this.#onScanner);
    this.scanner.on('due', this.#onScanner);
    this.scanner.on('frame', this.#onFrame);
    this.surface.on('ready', this.#onReady);
    this.modes.on('switcher', this.#onSwitcher);
    this.#refresh(); this.#sync();
  }
  leave() {
    this.#showing = false;
    this.world.off('change', this.#onWorld);
    this.scanner.off('state', this.#onScanner);
    this.scanner.off('due', this.#onScanner);
    this.scanner.off('frame', this.#onFrame);
    this.surface.off('ready', this.#onReady);
    this.modes.off('switcher', this.#onSwitcher);
    this.scanner.stop();
    this.world.focus(null);   // nothing is picked out once the list is off the glass
    this.#sync();
    this.#resume();   // left through the menu: the hold is ours to lift (nothing is asked for any more, so nothing starts), or the next camera would stay parked
  }
  #resume() { if (this.#paused) { this.#paused = false; this.surface.resumeViewfinder('menu'); this.#animate(); } }

  /** The entity open in the detail view; null at the list (or once it has expired). */
  get opened() { return this.#open ? this.world.get(this.#open) : null; }
  /** The camera rectangle: the top right corner under the strip. */
  get cameraRect() { return { x: this.surface.width - CAMERA.w - MARGIN, y: TOP + 2, ...CAMERA }; }
  /** Where the frame under analysis sits: the camera's footprint again, under it and a caption row. */
  get slotRect() { const cam = this.cameraRect; return { ...cam, y: cam.y + cam.h + 2 * BORDER + this.surface.fonts.small.height + 6 }; }
  /** The animation timer is running (the mode is showing, scanning, and something moves). */
  get animating() { return this.#timer !== null; }

  /**
   * How near the next capture is, 0..1 (1: now); null while none can happen - scanning is off,
   * or the last frame is still being analysed. By the clock for now (`scanner.due`); a head
   * turn brings a capture forward, so this is where an angle would come in.
   */
  get readiness() {
    const { active, state, due } = this.scanner;
    if (!active || state === 'looking' || !due) return null;
    return clamp((this.now() - due.from) / Math.max(1, due.at - due.from));
  }

  /** The world as tiles, most recently seen first (the thumbnail is fetched only for a tile that is drawn). */
  #refresh() {
    const t = this.#at = this.now(), { world } = this;
    this.#list.set(world.entities().map((e) => ({
      id: e.id, title: e.name, colour: e.pinned ? C.title : undefined,
      lines: [[e.kind, e.claims?.at(-1)?.text].filter(Boolean).join(' - ')],   // the kind rides the claim's row: beside the camera the top row is the name's
      badge: `${e.pinned ? 'pin ' : ''}${age(t - e.lastSeen)}`,
      get thumb() { return world.thumb(e.id); },
    })));
  }

  /** Camera and strip follow the state: the viewfinder while scanning at the list, the strip while a scan is on or running. */
  #sync() {
    const { active, state } = this.scanner, camera = this.#showing && active && !this.opened;
    if (camera && !this.#camera) { const r = this.cameraRect; this.surface.viewfinder(r.x, r.y, r.w, r.h).catch((error) => this.logger?.warn({ error: error.message }, 'scan: no camera')); }
    if (!camera && this.#camera) this.surface.stopViewfinder();
    this.#camera = camera;
    const word = !this.#showing ? null : state === 'looking' ? 'analyzing' : active ? 'scanning' : null;
    if (word || this.#strip) this.ui.setStrip(word, { colour: state === 'looking' ? C.title : C.ok });
    this.#strip = Boolean(word);
    this.#animate();
  }

  /** Something in the column is changing: a frame is circled, or the border has not filled yet. */
  #moving() { const p = this.readiness; return Boolean(this.scanner.frame) || (p !== null && p < 1); }

  /** The timer follows the state: on while the column is on the glass and moving, off otherwise (it stops itself when the border is full). */
  #animate() {
    const on = this.#camera && !this.#paused && this.#moving();
    if (on && !this.#timer) { this.#timer = setInterval(() => { this.ui.requestRender(); this.#animate(); }, this.frameMs); this.#timer.unref?.(); }
    if (!on && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  /** The age words of what is on the glass, as they read at time `t`. */
  #ages(t) {
    const e = this.opened;
    if (e) return `${age(t - e.firstSeen)} ${age(t - e.lastSeen)}`;
    return this.#drawn.map((id) => { const x = this.world.get(id); return x ? age(t - x.lastSeen) : '-'; }).join(' ');
  }

  /** Once a second while showing: repaint only when an age on the glass reads differently. */
  tick() {
    if (this.#ages(this.now()) === this.#ages(this.#at)) return;
    this.#refresh(); this.ui.requestRender();
  }

  /** Open or close the detail (null): the list is re-read on the way back, the camera follows. */
  #show(id) { this.#open = id; if (id) this.#detail.reset(); else this.#refresh(); this.#sync(); }

  onGesture(g) {
    const open = this.opened, picked = this.#list.selected;
    switch (g) {
      // the one button never navigates (the pad's tap is the same button on this device): at
      // the list it is the scanner's switch, in a detail it pins. Their events repaint
      case 'press:front': case 'press:tap':
        if (open) this.world.pin(open.id, !open.pinned); else this.scanner.toggle();
        return true;
      case 'swipe:up': case 'swipe:down': { const d = g === 'swipe:up' ? -1 : 1; if (open) this.#detail.scroll(d); else this.#list.move(d); break; }
      case 'swipe:right': if (open || !picked) return false; this.#show(picked.id); break;
      case 'swipe:left': if (!open) return false; this.#show(null); break;
      case 'press:rear':
        if (open) this.#show(null);
        else if (!this.#list.following) this.#list.follow();
        else return false;
        break;
      default: return false;
    }
    // what is picked out here is what "this" means in a question asked now: the model's to
    // know (world.focus), not this view's to keep
    this.world.focus(this.opened?.id ?? this.#list.selected?.id ?? null);
    this.ui.requestRender();
    return true;
  }

  /** The right-hand column while scanning. The viewfinder's own pixels are jetd's: nothing is drawn in them while it runs. */
  #column(s) {
    const { small } = s.fonts, { frame } = this.scanner, cam = this.cameraRect, slot = this.slotRect, cx = cam.x + cam.w / 2;
    const fill = (rects, colour) => { for (const r of rects) s.fillRect(r.x, r.y, r.w, r.h, colour); };
    // no capture can happen now (the last frame is still being analysed): a plain grey frame,
    // brighter than the empty progress track so "not capturing" and "waiting" do not look alike
    fill(ring(around(cam), BORDER, 0, 1), this.readiness === null ? C.dim : C.faint);
    fill(ring(around(cam), BORDER, 0, this.readiness ?? 0), C.ok);
    if (!s.viewfinderRect) s.icon(cx - 8, cam.y + cam.h / 2 - 10, s.icons.camera, C.faint);
    s.text(cx, cam.y + cam.h + BORDER + 4, frame ? 'analyzing' : `${this.#list.cards.length} logged`, { font: small, colour: frame ? C.title : C.dim, align: 'center' });
    if (!frame) return;
    // the frame comes out from under the viewfinder and down into its slot, then is circled
    const t = this.now() - this.#frameAt, y = t < SLIDE_MS ? Math.round(cam.y + (slot.y - cam.y) * clamp(t / SLIDE_MS)) : slot.y;
    const cut = Math.max(0, cam.y + cam.h + BORDER - y);   // rows still behind the viewfinder
    if (cut < frame.height) {
      const bytes = frame.data.length / (frame.width * frame.height), x = slot.x + ((slot.w - frame.width) >> 1);
      s.blitImage(cut ? { width: frame.width, height: frame.height - cut, data: frame.data.subarray(cut * frame.width * bytes) } : frame, x, y + cut);
    }
    if (y < slot.y) return;
    const phase = ((t - SLIDE_MS) % LAP_MS) / LAP_MS;
    fill(ring(around(slot), BORDER, 0, 1), C.faint);
    fill(ring(around(slot), BORDER, phase, phase + SEGMENT), C.title);
  }

  render(s) {
    const rect = panel(s), { main } = s.fonts, { active } = this.scanner, e = this.opened;
    if (e) {
      const t = this.#at = this.now();
      this.#detail.render(s, rect, {
        title: e.name, badge: e.kind, image: this.world.thumb(e.id),
        paragraphs: [
          ...(e.pinned ? [{ text: 'pinned', colour: C.title }] : []),
          { text: `first seen ${ago(t - e.firstSeen)}`, colour: C.dim },
          { text: `last seen ${ago(t - e.lastSeen)}${e.seen > 1 ? `, ${e.seen} times` : ''}`, colour: C.dim },
          ...(e.where?.lat != null ? [{ text: `at ${e.where.lat.toFixed(5)}, ${e.where.lon.toFixed(5)}`, colour: C.dim }] : []),
          '',
          ...(e.claims ?? []).toReversed().map((c) => `${clock(c.t)} ${c.text}`),
        ],
      });
      return hint(s, `front: ${e.pinned ? 'unpin' : 'pin'}   up/down: scroll   left: back`);
    }
    let area = rect;
    if (active) {   // the camera corner and what the scanner is doing under it, the tiles in what is left
      this.#column(s);
      area = { ...rect, w: this.cameraRect.x - 6 - rect.x };
    }
    this.#drawn = this.#list.render(s, area).map((tile) => tile.card.id);
    if (!this.#drawn.length) s.text(area.x + area.w / 2, rect.y + rect.h / 2 - main.height, active ? 'nothing yet' : 'nothing seen yet', { font: main, colour: C.dim, align: 'center' });
    hint(s, `front: ${active ? 'stop' : 'scan'}${this.#list.selected ? '   right: open   rear: unselect' : this.#drawn.length ? '   swipe: select' : ''}`);
  }
}
