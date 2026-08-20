// dsh-desktop-change-history — rollback transaction.
//
// Restores one recorded change to its pre-change state using node:fs directly
// (the same trust boundary the session-manager host plugin uses for its own
// filesystem work): a `create` is rolled back by removing the file; an
// `update`/`edit` is rolled back by atomically writing the recorded `before`.
// When the pre-change content is unavailable (`before` is null on an update),
// the rollback is refused with a structured code instead of destroying the file.
//
// A divergence check reads the current file first: if it no longer equals the
// recorded `after`, the file changed again after the AI edit (e.g. the user
// hand-edited it) and the response flags `diverged` so the UI can surface it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CODES } from './contract.js'

/** LF-normalize for the divergence comparison (the diff basis is LF). */
function normalize(content) {
  return (content ?? '').replaceAll('\r\n', '\n')
}

/** Read a file's current text, or null when absent. */
function readCurrent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Atomically publish `content` at `path` (tmp + rename, sibling directory). */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.dsh-rollback.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw error
  }
}

/**
 * Roll back one stored change.
 * @param record - the persisted record ({ path, operation, before, after }).
 * @returns { ok:true, action:'deleted'|'restored', diverged } or
 *          { ok:false, code, error }.
 */
export function rollbackChange(record) {
  if (record === null || typeof record !== 'object' || typeof record.path !== 'string') {
    return { ok: false, code: CODES.BAD_REQUEST, error: '无效的变更记录' }
  }

  if (record.operation === 'create') {
    try {
      rmSync(record.path, { force: true })
    } catch (error) {
      return { ok: false, code: 'fs', error: `删除文件失败: ${error?.message ?? error}` }
    }
    return { ok: true, action: 'deleted', diverged: false }
  }

  if (typeof record.before !== 'string') {
    return { ok: false, code: CODES.NO_BASELINE, error: '改动前内容不可用，无法回滚' }
  }

  const current = readCurrent(record.path)
  const diverged = current === null ? false : normalize(current) !== normalize(record.after)
  try {
    atomicWrite(record.path, record.before)
  } catch (error) {
    return { ok: false, code: 'fs', error: `回滚写入失败: ${error?.message ?? error}` }
  }
  return { ok: true, action: 'restored', diverged }
}
