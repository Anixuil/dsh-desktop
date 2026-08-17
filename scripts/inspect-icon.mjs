// Inspect PNG/ICO contents: report sampled colors so we can tell which icon
// design (indigo gradient ring vs black whale vs white whale) each file has.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function pngInfo(path) {
  const b = readFileSync(path);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  let off = 8, idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off), type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  const px = (x, y) => {
    const i = y * stride + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  const samples = [
    ['center', px(w >> 1, h >> 1)],
    ['top-left', px(2, 2)],
    ['top-right', px(w - 3, 2)],
    ['bottom-right', px(w - 3, h - 3)],
    ['mid-left', px(2, h >> 1)],
  ];
  // opaque pixel fraction + average color of opaque pixels (sampled grid)
  let opaque = 0, total = 0, sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    total++;
    const [r, g, bl, a] = px(x, y);
    if (a > 128) { opaque++; sr += r; sg += g; sb += bl; }
  }
  const avg = opaque > 0 ? [Math.round(sr / opaque), Math.round(sg / opaque), Math.round(sb / opaque)] : null;
  return { w, h, samples, opaquePct: Math.round((opaque / total) * 100), avgOpaqueColor: avg };
}

function icoInfo(path) {
  const b = readFileSync(path);
  const count = b.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    entries.push({
      w: b[o] || 256, h: b[o + 1] || 256,
      size: b.readUInt32LE(o + 8), offset: b.readUInt32LE(o + 12),
    });
  }
  // decode the largest entry as PNG if it starts with PNG magic
  const largest = entries.sort((a, b) => b.size - a.size)[0];
  let png = null;
  if (largest && b.toString('ascii', largest.offset, largest.offset + 8) === '\x89PNG\r\n\x1a\n') {
    // write temp png and inspect
    const tmp = path + '.entry.png';
    writeFileSyncTmp(tmp, b.subarray(largest.offset, largest.offset + largest.size));
    png = pngInfo(tmp);
  }
  return { count, entries: entries.map(({ w, h, size }) => `${w}x${h} (${size}B)`), largest: png };
}

import { writeFileSync, rmSync } from 'node:fs';
const writeFileSyncTmp = writeFileSync;

const files = process.argv.slice(2);
for (const f of files) {
  console.log('===', f, '===');
  if (f.endsWith('.ico')) {
    const info = icoInfo(f);
    console.log('entries:', info.entries.join(', '));
    if (info.largest) {
      console.log('largest entry:', JSON.stringify({ w: info.largest.w, h: info.largest.h, opaquePct: info.largest.opaquePct, avg: info.largest.avgOpaqueColor, samples: info.largest.samples }));
    }
    rmSync(f + '.entry.png', { force: true });
  } else {
    const info = pngInfo(f);
    console.log(JSON.stringify(info));
  }
}
