// Generates src-tauri/icons/icon.png (1024x1024) without any image library.
// Then run: pnpm icons  →  `tauri icon` expands it to every bundle format.
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const S = 1024;
const CORNER = 180;

// raw RGBA scanlines, filter byte 0 per row
const stride = S * 4 + 1;
const raw = Buffer.alloc(S * stride);

for (let y = 0; y < S; y++) {
  const row = y * stride;
  raw[row] = 0;
  for (let x = 0; x < S; x++) {
    const i = row + 1 + x * 4;
    // rounded corners -> transparent
    const cx = Math.min(x, S - 1 - x);
    const cy = Math.min(y, S - 1 - y);
    if (cx < CORNER && cy < CORNER) {
      const dx = CORNER - cx;
      const dy = CORNER - cy;
      if (dx * dx + dy * dy > CORNER * CORNER) {
        raw[i + 3] = 0;
        continue;
      }
    }
    // diagonal gradient #6366F1 -> #312E81
    const t = (x + y) / (2 * S);
    let r = Math.round(99 + (49 - 99) * t);
    let g = Math.round(102 + (46 - 102) * t);
    let b = Math.round(241 + (129 - 241) * t);
    // white ring + center dot
    const dx = x - S / 2;
    const dy = y - S / 2;
    const d = Math.sqrt(dx * dx + dy * dy);
    if ((d < 300 && d > 230) || d <= 56) {
      r = 255; g = 255; b = 255;
    }
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = 255;
  }
}

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.resolve(import.meta.dirname, '../src-tauri/icons');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'icon.png');
writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes)`);
