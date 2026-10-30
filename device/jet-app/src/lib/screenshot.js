// Screenshot: the framebuffer as the panel shows it, so whatever jetd, jet-app and the viewfinder
// drew is in the picture. Geometry comes from sysfs, not from jetd, so this works whoever owns the
// pixels; only 16 bpp (the Kopin panel) and 32 bpp are understood.
import fs from 'node:fs/promises';
import { encodePng, rgb565ToRgba } from './png.js';

/**
 * @param {{device?: string, sysfs?: string, scale?: number}} [options]
 * @returns {Promise<{png: Buffer, width: number, height: number, bpp: number}>}
 */
export async function screenshot({ device = '/dev/fb0', sysfs = '/sys/class/graphics/fb0', scale = 1 } = {}) {
  const read = (f) => fs.readFile(`${sysfs}/${f}`, 'utf8').then((t) => t.trim(), () => '');
  const [size, bits, strideText] = await Promise.all([read('virtual_size'), read('bits_per_pixel'), read('stride')]);
  const [width, height] = size.split(',').map(Number), bpp = Number(bits) || 16;
  if (!(width > 0 && height > 0)) throw new Error(`screenshot: no framebuffer geometry at ${sysfs}`);
  const stride = Number(strideText) || width * (bpp >> 3);
  const fb = await fs.readFile(device);
  if (fb.length < stride * height) throw new Error(`screenshot: ${fb.length} bytes from ${device}, expected ${stride * height}`);
  let rgba;
  if (bpp === 16) rgba = rgb565ToRgba(fb, width, height, stride >> 1);
  else if (bpp === 32) {   // XRGB / BGRA as the OMAP writes it: byte order B G R X
    rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * stride + x * 4, o = (y * width + x) * 4; rgba[o] = fb[i + 2]; rgba[o + 1] = fb[i + 1]; rgba[o + 2] = fb[i]; rgba[o + 3] = 255; }
  } else throw new Error(`screenshot: ${bpp} bpp not supported`);
  return { png: encodePng(rgba, width, height, { scale }), width, height, bpp };
}
