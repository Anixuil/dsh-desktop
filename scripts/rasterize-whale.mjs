// Rasterizes the DSH whale SVG path to a 1024x1024 RGBA PNG without any
// external renderer: parse the cubic-bezier path, flatten to segments,
// even-odd scanline fill, then encode PNG (deflate + crc32).
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const svgPath = path.join(root, 'src-tauri/icons/icon-src.svg');
const svg = readFileSync(svgPath, 'utf8');
const m = svg.match(/<path[^>]*\sd="([^"]+)"/);
if (!m) throw new Error('path not found');
const d = m[1];
const fillMatch = svg.match(/<path[^>]*\sfill="#[0-9a-f]{6}"/i);
if (!fillMatch) throw new Error('path fill not found');
const fill = fillMatch[0].match(/#([0-9a-f]{6})/i)[1];
const color = [0, 2, 4].map((offset) => Number.parseInt(fill.slice(offset, offset + 2), 16));

// ---- parse path (uppercase M/C/Z only — the favicon uses that) ----
const tokens = d.match(/[MZC]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
const segs = []; // [x1,y1,x2,y2]
let cx = 0, cy = 0, sx = 0, sy = 0, i = 0;
const num = () => parseFloat(tokens[i++]);
while (i < tokens.length) {
  const cmd = tokens[i++];
  if (cmd === 'M') {
    cx = num(); cy = num(); sx = cx; sy = cy;
  } else if (cmd === 'C') {
    const c1x = num(), c1y = num(), c2x = num(), c2y = num(), ex = num(), ey = num();
    // adaptive-ish fixed flattening: 24 steps per cubic is smooth at 1024px/50u
    const N = 24;
    let px = cx, py = cy;
    for (let k = 1; k <= N; k++) {
      const t = k / N, u = 1 - t;
      const x = u*u*u*cx + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*ex;
      const y = u*u*u*cy + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*ey;
      segs.push([px, py, x, y]);
      px = x; py = y;
    }
    cx = ex; cy = ey;
  } else if (cmd === 'Z') {
    if (cx !== sx || cy !== sy) segs.push([cx, cy, sx, sy]);
    cx = sx; cy = sy;
  }
}

// ---- rasterize into 1024 canvas (viewBox 0 0 50 50) ----
const S = 1024;
const SCALE = S / 50;
const buf = Buffer.alloc(S * S * 4); // RGBA, transparent
const crossings = Array.from({ length: S }, () => []);
for (const [x1, y1, x2, y2] of segs) {
  const X1 = x1 * SCALE, Y1 = y1 * SCALE, X2 = x2 * SCALE, Y2 = y2 * SCALE;
  const yMin = Math.max(0, Math.floor(Math.min(Y1, Y2)));
  const yMax = Math.min(S - 1, Math.ceil(Math.max(Y1, Y2)));
  if (Y2 === Y1) continue;
  for (let y = yMin; y <= yMax; y++) {
    const t = (y + 0.5 - Y1) / (Y2 - Y1);
    if (t < 0 || t > 1) continue;
    crossings[y].push(X1 + t * (X2 - X1));
  }
}
for (let y = 0; y < S; y++) {
  const xs = crossings[y].sort((a, b) => a - b);
  let inside = false, last = 0;
  for (const x of xs) {
    const x0 = Math.max(0, Math.floor(last));
    const x1 = Math.min(S - 1, Math.ceil(x));
    if (inside && x1 >= x0) {
      for (let px = x0; px <= x1; px++) {
        const o = (y * S + px) * 4;
        buf[o] = color[0];
        buf[o + 1] = color[1];
        buf[o + 2] = color[2];
        buf[o + 3] = 255;
      }
    }
    inside = !inside;
    last = x;
  }
}

// ---- PNG encode ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
};
const stride = S * 4 + 1;
const raw = Buffer.alloc(S * stride);
for (let y = 0; y < S; y++) {
  raw[y * stride] = 0;
  buf.copy(raw, y * stride + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(root, 'src-tauri/icons/icon.png');
writeFileSync(out, png);
const opaque = buf.filter((_, i) => i % 4 === 3 && buf[i] === 255).length / 4;
console.log(`whale icon written: ${out} (${png.length} bytes, ${Math.round(opaque)} opaque px)`);
