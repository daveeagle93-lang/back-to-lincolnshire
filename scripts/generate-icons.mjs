#!/usr/bin/env node
// Generates the PWA icon set as real PNG files with no external dependencies (no
// ImageMagick/PIL/canvas library available in this environment) - just a minimal,
// from-scratch RGBA PNG encoder (raw chunks + zlib deflate from Node's built-in zlib).
//
// Design: solid brand-green (#1a5d1a) background, bold white "L" mark (Lincolnshire),
// sized and centred so it sits inside the maskable-icon safe zone (a circle of radius
// 40% of the icon size from centre) - see https://web.dev/articles/maskable-icon.

import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ICONS_DIR = path.join(REPO_ROOT, "icons");

const GREEN = [0x1a, 0x5d, 0x1a, 255];
const WHITE = [255, 255, 255, 255];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Draws the icon into a flat RGBA pixel array, returns a Buffer of raw scanlines
// (filter byte 0 + width*4 bytes per row) ready for zlib deflate.
function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;

  // Bold "L" mark: a vertical bar and a horizontal foot, in fractional coordinates.
  const vBar = { x0: 0.32, x1: 0.44, y0: 0.22, y1: 0.72 };
  const hBar = { x0: 0.32, x1: 0.68, y0: 0.6, y1: 0.72 };
  function insideL(fx, fy) {
    const inV = fx >= vBar.x0 && fx <= vBar.x1 && fy >= vBar.y0 && fy <= vBar.y1;
    const inH = fx >= hBar.x0 && fx <= hBar.x1 && fy >= hBar.y0 && fy <= hBar.y1;
    return inV || inH;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x / size, fy = y / size;
      const [r, g, b, a] = insideL(fx, fy) ? WHITE : GREEN;
      const i = (y * size + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return raw;
}

function encodePng(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const raw = renderRgba(size);
  const idat = chunk("IDAT", deflateSync(raw));

  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

async function main() {
  await mkdir(ICONS_DIR, { recursive: true });
  const targets = [
    { file: "icon-192.png", size: 192 },
    { file: "icon-512.png", size: 512 },
    { file: "icon-512-maskable.png", size: 512 },
    { file: "apple-touch-icon.png", size: 180 },
  ];
  for (const { file, size } of targets) {
    const png = encodePng(size);
    const outPath = path.join(ICONS_DIR, file);
    await writeFile(outPath, png);
    console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (${size}x${size}, ${png.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
