#!/usr/bin/env node
// Generates favicon.svg and favicon.ico (repo root) from one geometry definition, with no
// external dependencies.
//
// Design: the app icon (solid brand-green #1a5d1a, white "L") simplified for tiny sizes: a
// bold L filling most of a full-bleed square, on a 16-unit grid with integer coordinates only.
// 16/32/48px are therefore exact 1x/2x/3x scales with no antialiasing, so edges stay crisp.
//
// The .ico holds three classic BMP/DIB frames (16, 32, 48) rather than PNG-in-ICO, for
// maximum compatibility with old browsers.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GRID = 16; // viewBox is GRID x GRID units
const GREEN = [0x1a, 0x5d, 0x1a, 255];
const WHITE = [255, 255, 255, 255];
// Single source of truth for the L (integer coordinates, commands M h v H V z only):
// vertical bar x3-7,y2-14; foot x3-13,y10-14.
const L_PATH = "M3 2h4v8h6v4H3z";
const ICO_SIZES = [16, 32, 48];

// Parses L_PATH into a list of [x, y] vertices.
function pathVertices(d) {
  const tokens = d.match(/[MhvHVz]|-?\d+/g);
  const pts = [];
  let x = 0, y = 0;
  for (let i = 0; i < tokens.length; i++) {
    const cmd = tokens[i];
    if (cmd === "z") break;
    const n = Number(tokens[++i]);
    if (cmd === "M") {
      x = n;
      y = Number(tokens[++i]);
    } else if (cmd === "h") x += n;
    else if (cmd === "v") y += n;
    else if (cmd === "H") x = n;
    else if (cmd === "V") y = n;
    else throw new Error(`Unsupported path command: ${cmd}`);
    pts.push([x, y]);
  }
  return pts;
}

const L_VERTICES = pathVertices(L_PATH);

// Even-odd point-in-polygon test.
function insideL(px, py) {
  let inside = false;
  for (let i = 0, j = L_VERTICES.length - 1; i < L_VERTICES.length; j = i++) {
    const [xi, yi] = L_VERTICES[i];
    const [xj, yj] = L_VERTICES[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildSvg() {
  const hex = (c) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">\n` +
    `  <rect width="${GRID}" height="${GRID}" fill="${hex(GREEN)}"/>\n` +
    `  <path d="${L_PATH}" fill="${hex(WHITE)}"/>\n` +
    `</svg>\n`
  );
}

// One BMP/DIB icon frame: BITMAPINFOHEADER (height doubled to cover the AND mask), 32bpp BGRA
// rows bottom-up, then a 1bpp all-zero AND mask with rows padded to 4 bytes.
function encodeFrame(size) {
  if (size % GRID !== 0) throw new Error(`size ${size} is not a multiple of ${GRID}`);
  const scale = size / GRID;
  const maskStride = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  const maskBytes = maskStride * size;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height (XOR bitmap + AND mask)
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // compression: BI_RGB
  header.writeUInt32LE(pixelBytes + maskBytes, 20); // image size
  // remaining fields (pixels per metre, palette counts) stay 0

  const pixels = Buffer.alloc(pixelBytes);
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row; // bottom-up
    for (let x = 0; x < size; x++) {
      // Sample the pixel centre in grid units; scale is an integer so it never lands on an edge.
      const white = insideL((x + 0.5) / scale, (y + 0.5) / scale);
      const [r, g, b, a] = white ? WHITE : GREEN;
      const i = (row * size + x) * 4;
      pixels[i] = b;
      pixels[i + 1] = g;
      pixels[i + 2] = r;
      pixels[i + 3] = a;
    }
  }

  return Buffer.concat([header, pixels, Buffer.alloc(maskBytes)]);
}

function buildIco() {
  const frames = ICO_SIZES.map(encodeFrame);

  const dir = Buffer.alloc(6 + 16 * frames.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(frames.length, 4);
  let offset = dir.length;
  frames.forEach((frame, n) => {
    const size = ICO_SIZES[n];
    const e = 6 + 16 * n;
    dir[e] = size; // width
    dir[e + 1] = size; // height
    dir[e + 2] = 0; // palette colours
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(frame.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += frame.length;
  });

  return Buffer.concat([dir, ...frames]);
}

async function main() {
  const outputs = [
    { file: "favicon.svg", data: Buffer.from(buildSvg(), "utf8") },
    { file: "favicon.ico", data: buildIco() },
  ];
  for (const { file, data } of outputs) {
    await writeFile(path.join(REPO_ROOT, file), data);
    console.log(`Wrote ${file} (${data.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
