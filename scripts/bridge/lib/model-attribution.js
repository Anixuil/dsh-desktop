// dsh-desktop-bridge — session model attribution.
//
// Reads the first model attribution from a session log's early
// request/header events, and the workspace-directory encoding used by dsh's
// session tree (`--<sanitized>--`).
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { scanFrames } from './zstd.js'

/** Read the first model attribution from a session log's early request/header events. */
export function readSessionModel(filePath, maxBytes = 12 * 1024 * 1024) {
  let buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    return null
  }
  const cap = Math.min(buffer.length, maxBytes)
  const frames = scanFrames(buffer.subarray(0, cap), 8)
  for (const frame of frames) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"type":"request/header"')) continue
      try {
        const event = JSON.parse(line)
        const config = event?.data?.header?.config
        if (typeof config === 'object' && config !== null) {
          return {
            provider: typeof config.provider === 'string' ? config.provider : null,
            model: typeof config.model === 'string' ? config.model : null,
          }
        }
      } catch { /* malformed line — keep scanning */ }
    }
  }
  return null
}

/** DSH session dirs encode the workspace cwd as `--<sanitized>--`. */
export function encodeWorkspace(cwd) {
  return `--${String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')}--`
}
