// jet state: one read-only round trip — hello geometry, pong RTT, glance, wear, power (`Q`).
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;
const hex = (v) => `0x${v.toString(16).padStart(2, '0')}`;

export class StateCommand extends Command {
  static moduleInfo = {
    name: 'state',
    schema: s().meta('description', 'report hello geometry, pong RTT, glance, wear and the power snapshot')
      .property('json', s('boolean').default(false).meta('description', 'machine-readable output')),
  };
  json;

  async run(jet) {
    const t0 = Date.now();
    await jet.request('p', 'P');
    const pongMs = Date.now() - t0;
    const glance = await jet.request('g', 'G');
    const wear = await jet.request('o', 'O');
    const power = await jet.request('q', 'Q');
    if (this.json) return console.log(JSON.stringify({ hello: jet.hello, pongMs, glance, wear, power }));
    const out = (label, text) => console.log(label.padEnd(11) + text);
    out('hello', `${jet.hello.w}x${jet.hello.h} px, ${jet.hello.cols}x${jet.hello.rows} cells`);
    out('pong', `${pongMs} ms`);
    out('glance', `${glance.at ? 'at the glass' : 'looking ahead'} (raw ${glance.raw})`);
    out('wear', `${wear.worn ? 'worn' : 'off the head'} (raw ${wear.raw})`);
    out('power', `vbat ${power.vbat} mV  vsys ${power.vsys} mV  vbus ${power.vbus} mV  ${power.ma} mA`);
    out('charger', `ctrl1 ${hex(power.ctrl1)}  stat1 ${hex(power.stat1)}  linsts ${hex(power.linsts)}  cinlimit ${hex(power.cinlimit)}  vichrg ${hex(power.vichrg)}`);
    out('usb', `udc ${power.udc}, maxpower ${power.maxpower} mA`);
  }
}
