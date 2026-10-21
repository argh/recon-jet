#!/usr/bin/env node
// Create a newc-format cpio archive from a directory with all entries owned by
// root (uid/gid 0), like Android's mkbootfs.  Output is gzip-compressed.
//
//   node cpio-newc.js <dir> <out.gz>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const pad4 = (n) => (4 - (n % 4)) % 4;

function entry(name, st, data, ino) {
  const mode = st.mode;
  const nameBuf = Buffer.from(name + '\0', 'latin1');
  const hdr = Buffer.from(
    '070701' + hex8(ino) + hex8(mode) + hex8(0) + hex8(0) + hex8(1) +
    hex8(0) + hex8(data.length) + hex8(0) + hex8(0) + hex8(0) + hex8(0) +
    hex8(nameBuf.length) + hex8(0), 'latin1');
  const namePad = Buffer.alloc(pad4(hdr.length + nameBuf.length));
  const dataPad = Buffer.alloc(pad4(data.length));
  return Buffer.concat([hdr, nameBuf, namePad, data, dataPad]);
}

function walk(root) {
  const out = [];
  const rec = (rel) => {
    const abs = path.join(root, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? rel + '/' + name : name;
      const st = fs.lstatSync(path.join(root, r));
      out.push([r, st]);
      if (st.isDirectory()) rec(r);
    }
  };
  rec('');
  return out;
}

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: cpio-newc.js <dir> <out.gz|out.cpio>'); process.exit(1); }

const parts = [];
let ino = 300000;
for (const [rel, st] of walk(dir)) {
  let data = Buffer.alloc(0);
  if (st.isSymbolicLink()) data = Buffer.from(fs.readlinkSync(path.join(dir, rel)), 'latin1');
  else if (st.isFile()) data = fs.readFileSync(path.join(dir, rel));
  parts.push(entry(rel, st, data, ino++));
}
parts.push(entry('TRAILER!!!', { mode: 0 }, Buffer.alloc(0), 0));
const raw = Buffer.concat(parts);
fs.writeFileSync(out, out.endsWith('.cpio') ? raw : zlib.gzipSync(raw, { level: 9 }));   // .cpio: raw, for xz/zstd outside
console.log(`${out}: ${parts.length - 1} entries`);
