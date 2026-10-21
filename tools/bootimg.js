#!/usr/bin/env node
// Android boot image (header v0) unpack / pack, as used by the Recon Jet's
// u-boot `booti`.  No deps.
//
//   node bootimg.js unpack boot.img outdir/
//   node bootimg.js pack   outdir/ new.img [--kernel k] [--ramdisk r] [--cmdline "..."]
//
// unpack writes: kernel, ramdisk.gz, second (if any), and info.json with the
// header fields (page size, load addresses, cmdline).  pack rebuilds from
// info.json plus the (possibly replaced) parts.

const fs = require('fs');
const path = require('path');

const MAGIC = 'ANDROID!';

function readHeader(buf) {
  if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('not an Android boot image');
  const u32 = (o) => buf.readUInt32LE(o);
  return {
    kernel_size: u32(8), kernel_addr: u32(12),
    ramdisk_size: u32(16), ramdisk_addr: u32(20),
    second_size: u32(24), second_addr: u32(28),
    tags_addr: u32(32), page_size: u32(36),
    name: buf.toString('latin1', 48, 64).replace(/\0.*$/, ''),
    cmdline: buf.toString('latin1', 64, 576).replace(/\0.*$/, ''),
    id: buf.subarray(576, 608).toString('hex'),
  };
}

const pages = (n, p) => Math.ceil(n / p) * p;

function unpack(img, outdir) {
  const buf = fs.readFileSync(img);
  const h = readHeader(buf);
  const p = h.page_size;
  let off = p;
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(path.join(outdir, 'kernel'), buf.subarray(off, off + h.kernel_size));
  off += pages(h.kernel_size, p);
  fs.writeFileSync(path.join(outdir, 'ramdisk.gz'), buf.subarray(off, off + h.ramdisk_size));
  off += pages(h.ramdisk_size, p);
  if (h.second_size) fs.writeFileSync(path.join(outdir, 'second'), buf.subarray(off, off + h.second_size));
  fs.writeFileSync(path.join(outdir, 'info.json'), JSON.stringify(h, null, 2) + '\n');
  console.log(JSON.stringify(h, null, 2));
}

function pack(dir, out, opts) {
  const h = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8'));
  const kernel = fs.readFileSync(opts.kernel || path.join(dir, 'kernel'));
  const ramdisk = fs.readFileSync(opts.ramdisk || path.join(dir, 'ramdisk.gz'));
  const secondPath = path.join(dir, 'second');
  const second = fs.existsSync(secondPath) ? fs.readFileSync(secondPath) : Buffer.alloc(0);
  const cmdline = opts.cmdline !== undefined ? opts.cmdline : h.cmdline;
  if (Buffer.byteLength(cmdline) > 511) throw new Error('cmdline too long');
  const p = h.page_size;

  const hdr = Buffer.alloc(p);
  hdr.write(MAGIC, 0, 'latin1');
  const w = (o, v) => hdr.writeUInt32LE(v >>> 0, o);
  w(8, kernel.length); w(12, h.kernel_addr);
  w(16, ramdisk.length); w(20, h.ramdisk_addr);
  w(24, second.length); w(28, h.second_addr);
  w(32, h.tags_addr); w(36, p);
  hdr.write(h.name || '', 48, 16, 'latin1');
  hdr.write(cmdline, 64, 512, 'latin1');
  // id: sha1 over sizes+parts like mkbootimg does; informational only for booti
  const crypto = require('crypto');
  const sha = crypto.createHash('sha1');
  for (const part of [kernel, ramdisk, second]) {
    sha.update(part);
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(part.length); sha.update(lenBuf);
  }
  sha.digest().copy(hdr, 576);

  const pad = (b) => Buffer.concat([b, Buffer.alloc(pages(b.length, p) - b.length)]);
  fs.writeFileSync(out, Buffer.concat([hdr, pad(kernel), pad(ramdisk), second.length ? pad(second) : Buffer.alloc(0)]));
  console.log(`${out}: kernel ${kernel.length} ramdisk ${ramdisk.length} page ${p} cmdline "${cmdline}"`);
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1], i++;
}
if (cmd === 'unpack') unpack(a, b);
else if (cmd === 'pack') pack(a, b, opts);
else { console.error('usage: bootimg.js unpack <img> <dir> | pack <dir> <out> [--kernel f] [--ramdisk f] [--cmdline s]'); process.exit(1); }
