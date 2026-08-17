// Decode ICO entries (PNG or DIB incl. palette formats) and report sampled
// colors per size — used to verify which icon design lives in an .ico/exe.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function pngPixels(b) {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  let off = 8, idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off), type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  return { w, h, raw: zlib.inflateSync(Buffer.concat(idat)), stride: w * 4 + 1, png: true };
}

function dibPixels(b, entryOffset) {
  const biSize = b.readUInt32LE(entryOffset);
  if (biSize !== 40) throw new Error(`unsupported biSize ${biSize}`);
  const w = b.readInt32LE(entryOffset + 4);
  const hRaw = b.readInt32LE(entryOffset + 8);
  const h = Math.abs(hRaw) / 2;
  const bitCount = b.readUInt16LE(entryOffset + 14);
  let palette = null;
  let pixOff = entryOffset + 40;
  if (bitCount <= 8) {
    const colors = bitCount === 4 ? 16 : bitCount === 8 ? 256 : 2;
    palette = [];
    for (let i = 0; i < colors; i++) {
      const o = pixOff + i * 4;
      palette.push([b[o + 2], b[o + 1], b[o], b[o + 3]]); // BGRA -> RGBA
    }
    pixOff += colors * 4;
  }
  const stride = Math.ceil((w * bitCount) / 32) * 4;
  return { w, h, bitCount, stride, pixOff, palette, dib: true };
}

function sample(buf, info) {
  const { w, h, png, raw, stride, dib, bitCount, pixOff, palette } = info;
  const px = (x, y) => {
    if (png) {
      const i = y * stride + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    }
    const row = (h - 1 - y) * stride;
    if (bitCount === 32) {
      const i = row + x * 4;
      return [buf[pixOff + i + 2], buf[pixOff + i + 1], buf[pixOff + i], buf[pixOff + i + 3]];
    }
    if (bitCount <= 8 && palette !== null) {
      const byteIdx = row + Math.floor((x * bitCount) / 8);
      const shift = 8 - bitCount - ((x * bitCount) % 8);
      const idx = (buf[pixOff + byteIdx] >> shift) & ((1 << bitCount) - 1);
      const c = palette[idx];
      return [c[0], c[1], c[2], c[3]];
    }
    return [0, 0, 0, 0];
  };
  const out = {
    center: px(w >> 1, h >> 1),
    midLeft: px(2, h >> 1),
    topLeft: px(2, 2),
  };
  let opaque = 0, total = 0, sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    total++;
    const [r, g, b, a] = px(x, y);
    if (a > 128) { opaque++; sr += r; sg += g; sb += b; }
  }
  out.opaquePct = Math.round((opaque / total) * 100);
  out.avg = opaque ? [Math.round(sr / opaque), Math.round(sg / opaque), Math.round(sb / opaque)] : null;
  return out;
}

const ico = readFileSync(process.argv[2]);
const count = ico.readUInt16LE(4);
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = ico[o] || 256, h = ico[o + 1] || 256;
  const size = ico.readUInt32LE(o + 8), offset = ico.readUInt32LE(o + 12);
  const entry = ico.subarray(offset, offset + size);
  const isPng = entry.length >= 8 && entry[0] === 0x89 && entry[1] === 0x50 && entry[2] === 0x4e && entry[3] === 0x47;
  if (isPng) {
    const info = pngPixels(entry);
    console.log(`${w}x${h}: PNG ->`, JSON.stringify(sample(entry, info)));
  } else {
    try {
      const info = dibPixels(entry, 0);
      console.log(`${w}x${h}: DIB(${info.bitCount}bpp) ->`, JSON.stringify(sample(entry, info)));
    } catch (e) {
      console.log(`${w}x${h}: decode failed (${e.message})`);
    }
  }
}
