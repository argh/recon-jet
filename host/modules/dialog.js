// jet dialog: the conversation off the device - the last N items of jet-app's feed (what was
// said to Jet, what Jet said, the photos and cards), each with its sound as a WAV and its
// picture as a JPEG, into a directory with a `dialog.json` index and a readable `dialog.md`.
// Unlike the other commands this does not talk to jetd: the feed belongs to jet-app, which
// serves it on its debug HTTP port (`voice.debugPort` in the device config; 0 = off).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;
const WHO = { heard: 'you', said: 'Jet', photo: 'photo', card: 'card' };

export class DialogCommand extends Command {
  static moduleInfo = {
    name: 'dialog',
    schema: s().meta('description', 'download the last items of the conversation, with audio and pictures')
      .property('count', s('number').default(10).meta('flagHint', 'n').meta('description', 'how many of the newest items'))
      .property('out', s('string').meta('general').meta('valueDescription', 'dir')
        .meta('description', 'output directory (default: jet-dialog-<utc> in the current directory)'))
      .property('appPort', s('number').default(7781).meta('description', 'jet-app\'s debug HTTP port on the device'))
      .property('clear', s('boolean').default(false).meta('description', 'instead of downloading: empty the conversation on the device (a clean slate)')),
  };
  count; out; appPort; clear;

  /** No jetd connection: one HTTP request to jet-app. */
  async execute() {
    const base = `http://${this.host}:${this.appPort}`, signal = AbortSignal.timeout(Math.max(this.timeoutMs, 30000));
    const call = async (route, init) => {
      const res = await fetch(base + route, { ...init, signal }).catch((error) => { throw new Error(`jet-app is not answering at ${base} (${error.cause?.code ?? error.message}): is voice.debugPort set on the device?`); });
      const reply = await res.json().catch(() => ({ error: `status ${res.status}` }));
      if (!res.ok) throw new Error(`${route}: ${reply.error ?? res.status}`);
      return reply;
    };
    if (this.clear) { const { cleared } = await call('/dialog/clear', { method: 'POST' }); console.log(`cleared ${cleared} items`); return; }

    const { items } = await call(`/dialog?n=${Math.max(1, this.count)}`);
    const dir = path.resolve(this.out ?? `jet-dialog-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`);
    await mkdir(dir, { recursive: true });
    const index = [], lines = [];
    for (const [i, { wav, jpeg, ...item }] of items.entries()) {
      const stem = `${String(i + 1).padStart(2, '0')}-${item.kind}`;
      if (wav) { item.audio = `${stem}.wav`; await writeFile(path.join(dir, item.audio), Buffer.from(wav, 'base64')); }
      if (jpeg) { item.image = `${stem}.jpg`; await writeFile(path.join(dir, item.image), Buffer.from(jpeg, 'base64')); }
      index.push(item);
      const said = [item.title && `**${item.title}**`, item.body?.replace(/\s*\n\s*/g, ' / ')].filter(Boolean).join(' — ');
      lines.push(`- ${new Date(item.t).toISOString().slice(11, 19)} **${WHO[item.kind] ?? item.kind}**: ${said || ''}${item.audio ? ` ([audio](${item.audio}))` : ''}${item.image ? ` ![](${item.image})` : ''}`);
    }
    await writeFile(path.join(dir, 'dialog.json'), JSON.stringify({ host: this.host, exported: new Date().toISOString(), items: index }, null, 2) + '\n');
    await writeFile(path.join(dir, 'dialog.md'), lines.join('\n') + '\n');
    console.log(`${dir}  (${index.length} items, ${index.filter((x) => x.audio).length} with audio, ${index.filter((x) => x.image).length} with a picture)`);
  }
}
