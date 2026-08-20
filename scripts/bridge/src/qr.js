// dsh-desktop-bridge — minimal zero-dependency QR encoder (SVG output).
//
// Deliberately scoped: byte mode, ECC level M, versions 1-5, fixed mask 0.
// That covers ~84 bytes — plenty for a pairing URL like
// https://my-pc.remote.example.com/?code=123456. Fixed masking is visually
// denser than an optimal mask but decodes fine on every scanner.
//
// Mirror: ui/qr.js ships an identical copy for the settings window (keep both
// files in sync).

// GF(256) arithmetic, generator 0x11d.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]

/** RS generator polynomial coefficients for `degree`, highest-order first:
 *  gen[0] is the leading coefficient (1), gen[degree] the constant term —
 *  the same convention as the reference qrcode-generator implementation.
 *  Roots are α^0 .. α^(degree-1). */
function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const factor = [1, EXP[i]] // x + α^i (highest-order first)
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      for (let k = 0; k < 2; k++) next[j + k] ^= gmul(poly[j], factor[k])
    }
    poly = next
  }
  return poly
}

/** Compute `degree` error codewords for `data` (transmitted order: first
 *  codeword is the highest-degree coefficient — the QR convention). Polynomial
 *  long division over the generator, highest-order first throughout. */
function rsEcc(data, degree) {
  const gen = rsGenerator(degree)
  const msg = [...data, ...new Array(degree).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = msg[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) msg[i + j] ^= gmul(gen[j], factor)
  }
  return msg.slice(data.length)
}

// ECC M block layout: [blocks, dataPerBlock, eccPerBlock] for versions 1-5.
const VERSIONS = [
  [1, 16, 10],
  [1, 28, 16],
  [1, 44, 26],
  [2, 32, 18],
  [2, 43, 24],
]

/** Byte-mode bit stream for `text`; pads per spec: bit-pad to the codeword
 *  boundary, then alternate 0xEC / 0x11 pad codewords up to `totalBits`. */
function encodeData(text, totalBits) {
  const bytes = new TextEncoder().encode(text)
  const bits = []
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  // terminator (up to 4 zero bits)
  for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0)
  // bit-pad to the codeword boundary
  while (bits.length % 8 !== 0) bits.push(0)
  // pad codewords: 0xEC / 0x11 alternating (RS covers them, decoders expect them)
  const PADS = [0xec, 0x11]
  let pad = 0
  while (bits.length < totalBits) {
    push(PADS[pad % 2], 8)
    pad++
  }
  return bits
}

function interleave(blocks, dataPerBlock, eccPerBlock, dataBits) {
  const dataBlocks = []
  const eccBlocks = []
  let bit = 0
  for (let b = 0; b < blocks; b++) {
    const block = []
    for (let i = 0; i < dataPerBlock; i++) {
      let byte = 0
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | (dataBits[bit] ?? 0)
        bit++
      }
      block.push(byte)
    }
    dataBlocks.push(block)
    eccBlocks.push(rsEcc(block, eccPerBlock))
  }
  const out = []
  for (let i = 0; i < dataPerBlock; i++) {
    for (const block of dataBlocks) out.push(block[i])
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of eccBlocks) out.push(block[i])
  }
  return out
}

/** Matrix side length for a version. */
const side = (version) => 17 + version * 4

/** Whether (r,c) is a reserved functional-module cell for the version. */
function reservedCell(r, c, n, version) {
  if (r === 6 || c === 6) return true // timing
  // finder patterns + separators
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    if (r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7) return true
  }
  // alignment patterns (skip centers overlapping finders)
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30]]
  for (const ar of ALIGN[version - 1]) {
    for (const ac of ALIGN[version - 1]) {
      const onFinder = (ar <= 8 && ac <= 8) || (ar <= 8 && ac >= n - 9) || (ar >= n - 9 && ac <= 8)
      if (onFinder) continue
      if (r >= ar - 2 && r <= ar + 2 && c >= ac - 2 && c <= ac + 2) return true
    }
  }
  // format-info cells (both copies) + dark module (n-8, 8)
  if (r === 8 && c <= 8) return true
  if (c === 8 && r <= 8) return true
  if (c === 8 && r >= n - 8) return true
  if (r === 8 && c >= n - 8) return true
  return false
}

function buildMatrix(version, codewords) {
  const n = side(version)
  // 0 = free data cell, 1 = dark module, 2 = reserved light module
  const m = Array.from({ length: n }, () => new Uint8Array(n))
  const set = (r, c, v) => { m[r][c] = v | 0 }
  // finder patterns + separators (reserved, light)
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const dark = (r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        set(r0 + r, c0 + c, dark ? 1 : 2)
      }
    }
    for (let i = -1; i <= 7; i++) {
      // full separator ring: right column, left column, bottom row, top row
      if (r0 + i >= 0 && r0 + i < n && c0 + 7 < n) set(r0 + i, c0 + 7, 2)
      if (r0 + i >= 0 && r0 + i < n && c0 - 1 >= 0) set(r0 + i, c0 - 1, 2)
      if (c0 + i >= 0 && c0 + i < n && r0 + 7 < n) set(r0 + 7, c0 + i, 2)
      if (c0 + i >= 0 && c0 + i < n && r0 - 1 >= 0) set(r0 - 1, c0 + i, 2)
    }
  }
  // timing patterns (reserved, alternating)
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 2)
    set(i, 6, i % 2 === 0 ? 1 : 2)
  }
  // alignment patterns (positions table for versions 1-5; index = version-1)
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30]]
  for (const r of ALIGN[version - 1]) {
    for (const c of ALIGN[version - 1]) {
      const onFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)
      if (onFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 2)
        }
      }
    }
  }
  // dark module (always dark; sits next to the bottom-left format strip)
  set(n - 8, 8, 1)
  // Reserve the format-info cells (marker 2) so data placement skips them.
  const reserveFmt = (r, c) => { if (m[r][c] === 0) set(r, c, 2) }
  for (let i = 0; i <= 5; i++) reserveFmt(8, i)
  reserveFmt(8, 7); reserveFmt(8, 8)
  for (let i = 0; i <= 5; i++) reserveFmt(i, 8)
  reserveFmt(7, 8)
  for (let i = 0; i < 8; i++) reserveFmt(n - 1 - i, 8)
  for (let i = 0; i < 8; i++) reserveFmt(8, n - 1 - i)
  // data placement (zigzag, fixed mask 0: dark when ((r + c) % 2 === 0)).
  // Direction alternates every column pair, including the skipped pair that
  // contains the timing column: (n-1,n-2) up, (n-3,n-4) down, ..., (8,7) up,
  // (5,4) down, (3,2) up, (1,0) down.
  let bit = 0
  let upward = true
  for (let c = n - 1; c >= 1; c -= 2) {
    if (c === 6) c--
    for (let row = 0; row < n; row++) {
      for (let k = 0; k < 2; k++) {
        const r = upward ? n - 1 - row : row
        const col = c - k
        if (m[r][col] === 0) {
          const data = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1
          bit++
          const masked = data ^ (((r + col) % 2 === 0) ? 1 : 0)
          set(r, col, masked ? 1 : 0)
        }
      }
    }
    upward = !upward
  }
  // format info: ECC M (00) + mask 0 (000) -> BCH -> XOR 0x5412.
  // Spec cell layout (ISO/IEC 18004 fig. 25): copy 1 around the top-left
  // finder — bits 0-5 up the left column (rows 0-5), bits 6-8 at (7,8)/(8,8)/
  // (8,7), bits 9-14 along the top row right-to-left. Copy 2: bits 0-7 along
  // the bottom row right-to-left, bits 8-14 up the right column from (n-7,8).
  const FORMAT = 0x5412
  const fmtBits = []
  for (let i = 0; i < 15; i++) fmtBits.push((FORMAT >> i) & 1) // fmtBits[i] = bit i
  const putFmt = (i, r, c) => set(r, c, fmtBits[i] ? 1 : 0)
  putFmt(0, 0, 8); putFmt(1, 1, 8); putFmt(2, 2, 8); putFmt(3, 3, 8); putFmt(4, 4, 8); putFmt(5, 5, 8)
  putFmt(6, 7, 8); putFmt(7, 8, 8); putFmt(8, 8, 7)
  putFmt(9, 8, 5); putFmt(10, 8, 4); putFmt(11, 8, 3); putFmt(12, 8, 2); putFmt(13, 8, 1); putFmt(14, 8, 0)
  // second copy: bits 0-7 along the bottom row, bits 8-14 up the right column
  for (let i = 0; i < 8; i++) putFmt(i, 8, n - 1 - i)
  for (let i = 8; i < 15; i++) putFmt(i, n - 15 + i, 8)
  return m
}

/**
 * Render `text` as an SVG data URI (scale-4 dark modules, quiet zone).
 * Throws when the payload exceeds the v5-M capacity.
 */
function qrSvgDataUri(text, { scale = 4, margin = 4 } = {}) {
  const matrix = matrixFor(text)
  const n = matrix.length
  const size = (n + margin * 2) * scale
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`]
  parts.push(`<rect width="${size}" height="${size}" fill="#fff"/>`)
  let path = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c] === 1) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h${-scale}z`
    }
  }
  parts.push(`<path d="${path}" fill="#000"/>`)
  parts.push('</svg>')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(''))}`
}

/** Raw module matrix for `text` (test seam: decode-verification walks it). */
function matrixFor(text) {
  const bytes = new TextEncoder().encode(text)
  let version = -1
  for (let v = 0; v < VERSIONS.length; v++) {
    const [blocks, dataPerBlock] = VERSIONS[v]
    // byte-mode overhead: 12 bits header + 8 bits per byte + 4-bit terminator
    if (12 + bytes.length * 8 + 4 <= blocks * dataPerBlock * 8) { version = v; break }
  }
  if (version === -1) throw new Error('qr payload too long for v5-M')
  const [blocks, dataPerBlock, eccPerBlock] = VERSIONS[version]
  const totalBits = blocks * dataPerBlock * 8
  const bits = encodeData(text, totalBits)
  const codewords = interleave(blocks, dataPerBlock, eccPerBlock, bits)
  return buildMatrix(version + 1, codewords)
}

module.exports = { qrSvgDataUri, matrixFor, _internals: { encodeData, interleave, VERSIONS, reservedCell, side, rsEcc, rsGenerator, EXP, LOG, gmul } }
