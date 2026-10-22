// About: what is running. jet-app and Node versions, the kernel, jetd's hello and the panel.
import os from 'node:os';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

export class AboutScreen {
  /** @param {import('./index.js').SystemMode} sys @param {string} version jet-app's package version */
  constructor(sys, version) { this.sys = sys; this.version = version; }
  onGesture() { return false; }

  render(s) {
    const { deviceLink, modes } = this.sys, h = deviceLink.hello, g = s.geometry;
    heading(s, 'about');
    let y = TOP + 26;
    y = row(s, y, 'jet-app', this.version);
    y = row(s, y, 'node', process.version);
    y = row(s, y, 'kernel', os.release());
    y = row(s, y, 'jetd', h ? `hello ${h.w}x${h.h}  ${h.cols}x${h.rows} cells` : 'not connected', h ? C.white : C.warn);
    y = row(s, y, 'panel', g ? `${g.w}x${g.h}  ${g.bpp} bpp  stride ${g.stride}` : '-');
    y = row(s, y, 'modes', modes.list.map((m) => m.id).join(' '));
    y = row(s, y, 'uptime', `${Math.round(process.uptime())} s   rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    row(s, y, 'host', os.hostname());
    hint(s, 'rear: menu');
  }
}
