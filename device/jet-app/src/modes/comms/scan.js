// Scan: what the glasses have seen, as a view over the `world` model, and the switch for the
// `scanner` (docs/agent.md). Front starts scanning, and stops it into review. While it is on, the camera runs in the top
// right corner (the surface viewfinder, beside the tab row) and the entities are tiles to its
// left - crop, name, kind, newest claim, age - re-sorted as sightings land; off, the same tiles
// are the full-width review list. Swipe up/down selects, in review front opens the selected
// entity (larger crop, pinned, first/last seen, where, the claims newest first; scrollable) and
// there pins or unpins it, rear steps back: detail, selection, and at the root it is not consumed.
//
// A Comms screen module (`provides: 'CommsScreen'`): it subscribes to the world and the scanner
// only while showing, and leaving it (or the mode) stops the camera and the scanning - a scan
// costs a model slot and ~85 mA of camera, so it does not outlive the screen that shows it. The
// camera is a jetd-side overlay the modal mode menu does not cover, so it is paused while the
// switcher is up (as Describe does). Ages are relative, so the 1 s tick looks at what is on the
// glass and repaints only when one of those words changes.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, hint } from '../../modules/ui/style.js';
import { CardList, DetailView } from '../../modules/ui/cards.js';

const s = Schema.create;
const CAMERA = { w: 120, h: 90 };
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

export class ScanScreen {
  static moduleInfo = {
    name: 'scan-screen',
    provides: 'CommsScreen',
    schema: s()
      .property('world', s('World').meta('internal', true))
      .property('scanner', s('Scanner').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  world; scanner; surface; modes; ui; logger;

  id = 'scan'; label = 'Scan';
  /** the clock, a field so tests own time */ now = () => Date.now();
  #list = new CardList({ anchor: 'start' });
  #detail = new DetailView();
  /** @type {string|null} the entity open in the detail view */ #open = null;
  #showing = false;
  #camera = false;     // the viewfinder is asked for
  #strip = false;      // the status strip carries our word
  #paused = false;     // we are holding the camera off under the mode menu
  /** @type {string[]} ids of the tiles on the glass */ #drawn = [];
  /** when the words on the glass were worked out: a tick compares the ages then with the ages now */ #at = 0;
  #onWorld = () => { this.#refresh(); this.ui.requestRender(); };
  #onScanner = () => { this.#sync(); this.ui.requestRender(); };
  #onReady = () => { this.#camera = false; this.#sync(); };   // the surface came back: re-request with its fresh geometry
  #onSwitcher = (open) => {
    if (open) { this.#paused = true; this.surface.pauseViewfinder(); return; }
    // deferred: a menu dismissed by picking another mode has left us (and stopped the camera) by then
    queueMicrotask(() => { if (this.#showing) this.#resume(); });
  };

  enter() {
    this.#showing = true; this.#open = null; this.#list.follow();
    this.world.on('change', this.#onWorld);       // we know we are showing: our models tell us when to repaint
    this.scanner.on('state', this.#onScanner);
    this.surface.on('ready', this.#onReady);
    this.modes.on('switcher', this.#onSwitcher);
    this.#refresh(); this.#sync();
  }
  leave() {
    this.#showing = false;
    this.world.off('change', this.#onWorld);
    this.scanner.off('state', this.#onScanner);
    this.surface.off('ready', this.#onReady);
    this.modes.off('switcher', this.#onSwitcher);
    this.scanner.stop();
    this.world.focus(null);   // nothing is picked out once the list is off the glass
    this.#sync();
    this.#resume();   // left through the menu: the hold is ours to lift (nothing is asked for any more, so nothing starts), or the next camera would stay parked
  }
  #resume() { if (this.#paused) { this.#paused = false; this.surface.resumeViewfinder(); } }

  /** The entity open in the detail view; null at the list (or once it has expired). */
  get opened() { return this.#open ? this.world.get(this.#open) : null; }
  /** The camera rectangle: the top right corner under the strip, beside the tab row. */
  get cameraRect() { return { x: this.surface.width - CAMERA.w - MARGIN, y: TOP + 2, ...CAMERA }; }

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
    const word = !this.#showing ? null : state === 'looking' ? 'looking' : active ? 'scanning' : null;
    if (word || this.#strip) this.ui.setStrip(word, { colour: state === 'looking' ? C.title : C.ok });
    this.#strip = Boolean(word);
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

  onGesture(g) {
    const open = this.opened;
    switch (g) {
      // one button, read by where you are (the pad's tap is the front button on this device): in
      // a detail it pins; while scanning it stops (scan -> review); in review a selected card
      // opens, and with nothing selected it starts scanning again
      case 'press:front': case 'press:tap':
        if (open) { this.world.pin(open.id, !open.pinned); return true; }   // its `change` event repaints
        if (this.scanner.active || !this.#list.selected) { this.scanner.toggle(); return true; }   // its `state` event does the rest
        this.#open = this.#list.selected.id; this.#detail.reset(); this.#sync();
        break;
      case 'swipe:up': case 'swipe:down': { const d = g === 'swipe:up' ? -1 : 1; if (open) this.#detail.scroll(d); else this.#list.move(d); break; }
      case 'swipe:left': case 'swipe:right': if (!open) return false; break;   // an open entity is a place of its own: the tabs are a step back
      case 'press:rear':
        if (open) { this.#open = null; this.#refresh(); this.#sync(); }
        else if (!this.#list.following) this.#list.follow();
        else return false;
        break;
      default: return false;
    }
    // what is picked out here is what "this" means in a question asked now: the model's to
    // know (world.focus), not this screen's to keep
    this.world.focus(this.#open ?? this.#list.selected?.id ?? null);
    this.ui.requestRender();
    return true;
  }

  render(s, rect) {
    const { main, small } = s.fonts, { active, state } = this.scanner, e = this.opened;
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
      return hint(s, `front: ${e.pinned ? 'unpin' : 'pin'}   swipe: scroll   rear: back`);
    }
    let area = rect;
    if (active) {   // the camera corner, the scanner's word under it, the tiles in what is left
      const cam = this.cameraRect, cx = cam.x + cam.w / 2;
      s.strokeRect(cam.x - 2, cam.y - 2, cam.w + 4, cam.h + 4, s.viewfinderRect ? C.ok : C.faint);
      if (!s.viewfinderRect) s.icon(cx - 8, cam.y + cam.h / 2 - 10, s.icons.camera, C.faint);
      s.text(cx, cam.y + cam.h + 8, state === 'looking' ? 'looking...' : 'watching', { font: main, colour: state === 'looking' ? C.title : C.ok, align: 'center' });
      s.text(cx, cam.y + cam.h + 8 + main.height + 2, `${this.#list.cards.length} in the log`, { font: small, colour: C.dim, align: 'center' });
      area = { ...rect, w: cam.x - 6 - rect.x };
    }
    this.#drawn = this.#list.render(s, area).map((tile) => tile.card.id);
    if (!this.#drawn.length) s.text(area.x + area.w / 2, rect.y + rect.h / 2 - main.height, active ? 'nothing yet' : 'nothing seen yet', { font: main, colour: C.dim, align: 'center' });
    hint(s, `front: ${active ? 'stop' : this.#list.selected ? 'open' : 'scan'}${this.#drawn.length ? '   swipe: select' : ''}${this.#list.selected ? '   rear: unselect' : ''}`);
  }
}
