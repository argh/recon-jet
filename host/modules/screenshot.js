// jet screenshot: the glass as shown, via the mirror (N 1): jetd sends a banded full refresh of
// the composed framebuffer — jetd screens, jet-app drawing and the viewfinder alike — which is
// assembled here until every pixel has arrived and written as a PNG. Read-only and independent
// of jet-app (tools/jetshot.sh is the older route through the app / ssh).
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';
import { encodePng } from '../../device/jet-app/src/lib/png.js';
import fs from 'node:fs';

const s = Schema.create;

export class ScreenshotCommand extends Command {
  static moduleInfo = {
    name: 'screenshot',
    schema: s().meta('description', 'capture the panel as shown (via the mirror) to a PNG')
      .property('out', s('string').meta('general').meta('valueDescription', 'out.png')
        .meta('description', 'output file (default: jet-screen-<utc>.png in the current directory)'))
      .property('settleMs', s('number').default(2000).meta('advanced').meta('description', 'give up waiting for full coverage after this long')),
  };
  out; settleMs;

  async run(jet) {
    const fmt = await jet.request('N', 'N 1');
    const bytes = fmt.bpp / 8;
    const frame = Buffer.alloc(fmt.w * fmt.h * 4);
    const seen = new Uint8Array(fmt.w * fmt.h);
    let covered = 0;

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, this.settleMs);
      jet.on('blit', ({ x, y, w, h, data }) => {
        for (let r = 0; r < h; r++)
          for (let c = 0; c < w; c++) {
            const p = (y + r) * fmt.w + x + c, o = p * 4;
            if (!seen[p]) { seen[p] = 1; covered++; }
            if (bytes === 2) {
              const v = data.readUInt16LE((r * w + c) * 2);
              frame[o] = (v >> 8) & 0xf8; frame[o + 1] = (v >> 3) & 0xfc; frame[o + 2] = (v << 3) & 0xf8;
            } else {
              const v = data.readUInt32LE((r * w + c) * 4);
              frame[o] = (v >> 16) & 0xff; frame[o + 1] = (v >> 8) & 0xff; frame[o + 2] = v & 0xff;
            }
            frame[o + 3] = 255;
          }
        if (covered === fmt.w * fmt.h) { clearTimeout(timer); resolve(); }
      });
    });
    jet.send('N 0');
    if (covered < fmt.w * fmt.h) console.error(`screenshot: ${(100 * covered / (fmt.w * fmt.h)).toFixed(0)}% covered after ${this.settleMs} ms (writing what arrived)`);

    const out = this.out ?? `jet-screen-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}.png`;
    fs.writeFileSync(out, encodePng(frame, fmt.w, fmt.h));
    console.log(out);
  }
}
