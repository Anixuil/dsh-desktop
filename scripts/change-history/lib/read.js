// dsh-desktop-change-history — bounded file read for the built-in viewer.
//
// Reads the current on-disk text of a changed file so the client's side drawer
// can render it without opening an external editor. Same node:fs trust boundary
// as rollback.js; a failed read returns a structured { ok:false } instead of
// throwing, so the viewer can surface the error rather than crash the row.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { extname } from 'node:path'
import { CODES } from './contract.js'

/** Hard cap on bytes the viewer reads; past it only the tail is shown and marked. */
export const MAX_READ_BYTES = 1024 * 1024

/** Map a file extension to a grammar hint the viewer can syntax-highlight with. */
function langFromPath(path) {
  const ext = extname(String(path ?? '')).slice(1).toLowerCase()
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', tsx: 'tsx', json: 'json', jsonc: 'json',
    css: 'css', scss: 'scss', html: 'html', htm: 'html',
    md: 'markdown', markdown: 'markdown', txt: 'text',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    sh: 'bash', bash: 'bash', ps1: 'powershell',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
  }
  return map[ext] ?? null
}

/** Read the whole file when it fits, else its bounded tail (bytes + truncated). */
function readBounded(path) {
  const fd = openSync(path, 'r')
  try {
    const bytes = fstatSync(fd).size
    if (bytes <= MAX_READ_BYTES) {
      return { content: readFileSync(fd, 'utf8'), bytes, truncated: false }
    }
    const length = MAX_READ_BYTES
    const buf = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const n = readSync(fd, buf, done, length - done, bytes - length + done)
      if (n <= 0) break
      done += n
    }
    return { content: buf.toString('utf8', 0, done), bytes, truncated: true }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read a file's current text, bounded to {@link MAX_READ_BYTES}.
 * @param path - absolute filesystem path.
 * @returns { ok:true, path, content, bytes, totalLines, lang, truncated } or
 *          { ok:false, code, error }.
 */
export function readFileText(path) {
  if (typeof path !== 'string' || path === '') {
    return { ok: false, code: CODES.BAD_REQUEST, error: '缺少文件路径' }
  }
  let read
  try {
    read = readBounded(path)
  } catch (error) {
    return { ok: false, code: CODES.NOT_READABLE, error: `无法读取文件: ${error?.message ?? error}` }
  }
  const trimmed = read.content.replaceAll('\r\n', '\n')
  const parts = trimmed.split('\n')
  const totalLines = trimmed === ''
    ? 0
    : parts[parts.length - 1] === ''
      ? parts.length - 1
      : parts.length
  return {
    ok: true,
    path,
    content: trimmed,
    bytes: read.bytes,
    totalLines: read.truncated ? null : totalLines,
    lang: langFromPath(path),
    truncated: read.truncated,
  }
}