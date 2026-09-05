// Render the Betterfy mark to the PNG sizes browsers and phones ask for.
//
// The mark is five stacked bars whose widths grow then shrink, so the right
// edge forms a play triangle: a sorted list that reads as a play button. At
// favicon sizes the gaps close up and it degrades into the triangle alone,
// which is the point — it stays recognisable at 16px.
//
// No dependencies: shapes are rounded rectangles, so they can be sampled from
// a signed distance function and written out with zlib, rather than pulling in
// a rasteriser for four small files.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* ---------- geometry, in the 32-unit space the inline SVG also uses ---------- */

const TILE_R = 9;                       // corner radius of the app tile
const BAR_X = 7.75, BAR_H = 3.4, PITCH = 4.7, BAR_R = 1.7, BAR_Y0 = 4.9;
const BAR_W = [7, 12, 16.5, 12, 7];
const BAR_A = [0.92, 0.97, 1, 0.97, 0.92];   // outer bars sit back a hair

// Brand colours. The web app re-tints the mark from the viewer's accent, but a
// file on disk has to pick one — these are the defaults the app ships with.
const TOP = [0xEC, 0x66, 0x3E];
const BOTTOM = [0xC7, 0x42, 0x1E];
const INK = [0xFF, 0xFF, 0xFF];

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r), qy = Math.abs(py - cy) - (h / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Coverage of the tile and of each bar at one point, 3x3 supersampled.
 * `inset` shrinks the artwork inside the canvas (maskable icons need a safe
 * zone; Android crops up to 20% off every edge).
 */
function sample(u, v, step, tileR) {
  let tile = 0;
  const bars = new Array(BAR_W.length).fill(0);
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = u + (sx + 0.5) * step / 3, py = v + (sy + 0.5) * step / 3;
      if (sdRoundRect(px, py, 0, 0, 32, 32, tileR) < 0) tile++;
      for (let i = 0; i < BAR_W.length; i++)
        if (sdRoundRect(px, py, BAR_X, BAR_Y0 + i * PITCH, BAR_W[i], BAR_H, BAR_R) < 0) bars[i]++;
    }
  }
  return { tile: tile / 9, bars: bars.map(b => b / 9) };
}

/** @returns {Buffer} RGBA pixels for a size x size icon. */
function renderIcon(size, { tileR = TILE_R, pad = 0 } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const scale = 32 / (size * (1 - 2 * pad));   // canvas px -> mark units
  const off = -size * pad * scale;             // where the mark starts
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { tile, bars } = sample(off + x * scale, off + y * scale, scale, tileR);
      if (tile <= 0) continue;
      // vertical gradient across the tile
      const t = Math.min(Math.max((off + y * scale) / 32, 0), 1);
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
      for (let i = 0; i < bars.length; i++) {
        const a = bars[i] * BAR_A[i];
        if (!a) continue;
        r += (INK[0] - r) * a; g += (INK[1] - g) * a; b += (INK[2] - b) * a;
      }
      const p = (y * size + x) * 4;
      out[p] = Math.round(r); out[p + 1] = Math.round(g); out[p + 2] = Math.round(b);
      out[p + 3] = Math.round(tile * 255);
    }
  }
  return out;
}

/* ---------- minimal PNG writer ---------- */

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = buf => {
  let c = ~0;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- outputs ---------- */

const FILES = [
  ['docs/icon-192.png', 192, {}],
  ['docs/icon-512.png', 512, {}],
  // iOS applies its own mask, so this one is square and full-bleed.
  ['docs/apple-touch-icon.png', 180, { tileR: 0 }],
  // Android may crop 20% off every edge, so the mark is inset inside a square.
  ['docs/icon-maskable-512.png', 512, { tileR: 0, pad: 0.14 }],
];

for (const [file, size, opts] of FILES) {
  const buf = png(size, renderIcon(size, opts));
  writeFileSync(file, buf);
  console.log(`${file} — ${size}x${size}, ${(buf.length / 1024).toFixed(1)} KB`);
}
