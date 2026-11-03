// jet snapshot: `S` -> one UYVY frame -> PNG on disk. The converters are jet-app's own
// dependency-free ones (the same path tools/jetshot.sh uses), imported rather than copied.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { uyvyToRgba } from '../../device/jet-app/src/lib/uyvy.js';
import { encodePng } from '../../device/jet-app/src/lib/png.js';
import { Command } from './command.js';

const s = Schema.create;

export class SnapshotCommand extends Command {
  static moduleInfo = {
    name: 'snapshot',
    schema: s().meta('description', 'camera snapshot to a PNG file')
      .property('out', s('string').meta('general').meta('valueDescription', 'out.png')
        .meta('description', 'output file (default: jet-<utc>.png in the current directory)'))
      .property('size', s('string').default('640x480')
        .meta('description', 'frame size WxH (the media pipeline must already be configured for it)')),
  };
  out; size;

  async run(jet) {
    const m = /^(\d+)x(\d+)$/.exec(this.size);
    if (!m) throw new Error(`--size wants WxH, not "${this.size}"`);
    const frame = await jet.request('f', `S ${+m[1]} ${+m[2]}`, Math.max(this.timeoutMs, 15000));   // 6 skipped frames for exposure take a while
    const { width, height, data } = uyvyToRgba(frame.data, frame.w, frame.h);
    const out = path.resolve(this.out ?? `jet-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}.png`);
    await writeFile(out, encodePng(data, width, height));
    console.log(out);
  }
}
