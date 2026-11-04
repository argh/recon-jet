// jetd -> host stream parser: newline-delimited lines, except that `f` (camera frame) and
// `a` (capture chunk) lines are followed by <len> raw bytes (see docs/jetd.md).

export class ProtocolParser {
  #buf = Buffer.alloc(0);
  #pending = null;   // { kind, header, len } while a binary payload is being collected

  /**
   * Feed a socket chunk; returns the complete messages it finished.
   * @param {Buffer} chunk
   * @returns {Array<{type:'line', line:string} | {type:'frame', w:number, h:number, fmt:string, data:Buffer} | {type:'audio', data:Buffer}>}
   */
  feed(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.#pending) {
        if (this.#buf.length < this.#pending.len) break;
        const data = Buffer.from(this.#buf.subarray(0, this.#pending.len));
        this.#buf = this.#buf.subarray(this.#pending.len);
        out.push(this.#pending.kind === 'f' ? { type: 'frame', ...this.#pending.header, data } : { type: 'audio', data });
        this.#pending = null;
        continue;
      }
      const nl = this.#buf.indexOf(10);
      if (nl < 0) break;
      const line = this.#buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
      this.#buf = this.#buf.subarray(nl + 1);
      const [t, ...a] = line.split(' ');
      // a length that cannot be real (resync garbage shaped like a header) must not leave the
      // parser waiting on payload bytes forever — pass it through as a line instead
      const sane = (len) => Number.isInteger(len) && len >= 0 && len <= 16 << 20;
      if (t === 'f' && sane(+a[3])) this.#pending = { kind: 'f', header: { w: +a[0], h: +a[1], fmt: a[2] }, len: +a[3] };
      else if (t === 'a' && sane(+a[0])) this.#pending = { kind: 'a', len: +a[0] };
      else out.push({ type: 'line', line });
    }
    return out;
  }
}

/** `q vbat vsys vbus mA ctrl1 stat1 linsts cinlimit vichrg udc maxpower` -> object */
export function parsePower(fields) {
  const [vbat, vsys, vbus, ma, ctrl1, stat1, linsts, cinlimit, vichrg, udc, maxpower] = fields;
  const hex = (s) => parseInt(s, 16);
  return { vbat: +vbat, vsys: +vsys, vbus: +vbus, ma: +ma, ctrl1: hex(ctrl1), stat1: hex(stat1), linsts: hex(linsts),
           cinlimit: hex(cinlimit), vichrg: hex(vichrg), udc, maxpower: +maxpower };
}
