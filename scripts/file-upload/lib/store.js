// dsh-desktop-file-upload — file landing store.
//
// Uploaded files land in the system temp dir under
// dsh-file-upload/file{N}/{hash}.{ext} and a hint text carries the display
// name and absolute path to the model. The model then reads the file with its
// own `read` tool
// (which resolves absolute paths through the local fs backend), so the full
// file content never has to ride the prompt. MD5 names keep paths collision-
// free; an LRU cap and an age sweep bound the store.

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

export const TMP_DIR = join(tmpdir(), 'dsh-file-upload')

const lruQueue = []
let nextSeq = 1
let maxFiles = Number(process.env['FILE_UPLOAD_MAX_FILES'] || 200)

export function setMaxFiles(value) {
  if (Number.isInteger(value) && value > 0) maxFiles = value
}

function hintForPath(filePath, seq, name) {
  return `[File #${seq} "${name}" auto-saved to ${filePath}]`
}

/** Keep only a safe, short extension (`.txt`, `.py`, …) from a display name. */
function sanitizeExt(name) {
  const ext = extname(typeof name === 'string' ? name : '')
  const clean = ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16)
  return clean || '.bin'
}

/** Strip characters that would break the `[File #N "name" ...]` hint framing. */
function sanitizeName(name) {
  const clean = String(name ?? '').replace(/["[\]\r\n\t]/g, ' ').trim().slice(0, 120)
  return clean || 'file'
}

function touchLRU(seqDir) {
  const idx = lruQueue.indexOf(seqDir)
  if (idx !== -1) lruQueue.splice(idx, 1)
  lruQueue.push(seqDir)
  while (lruQueue.length > maxFiles) {
    const oldest = lruQueue.shift()
    if (!oldest) break
    try {
      rmSync(oldest, { recursive: true, force: true })
    } catch {}
  }
}

export function ensureTmpDir() {
  try {
    mkdirSync(TMP_DIR, { recursive: true })
  } catch {}
  sweepStale()
}

const DEFAULT_MAX_AGE_DAYS = 7

function sweepStale() {
  const maxAgeDays = Number(process.env['FILE_UPLOAD_MAX_AGE_DAYS'] || DEFAULT_MAX_AGE_DAYS)
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let entries
  try {
    entries = readdirSync(TMP_DIR, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^file\d+$/.test(entry.name)) continue
    const dir = join(TMP_DIR, entry.name)
    try {
      if (statSync(dir).mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {}
  }
}

/**
 * Persist one uploaded file and return its hint text.
 * @param data - raw file bytes.
 * @param name - original display name (extension is preserved for the read tool).
 * @returns `{ seq, filePath, hint }`.
 */
export function saveFile(data, name) {
  if (!data || data.length === 0) return null
  const ext = sanitizeExt(name)
  const hash = createHash('md5').update(data).digest('hex').slice(0, 16)
  const seq = nextSeq++
  const seqDir = join(TMP_DIR, `file${seq}`)
  const filePath = join(seqDir, `${hash}${ext}`)

  try {
    mkdirSync(seqDir, { recursive: true })
    writeFileSync(filePath, data, { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  touchLRU(seqDir)
  const displayName = sanitizeName(name)
  return { seq, filePath, name: displayName, hint: hintForPath(filePath, seq, displayName) }
}
