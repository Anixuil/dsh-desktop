// dsh-desktop-session-manager — delete transaction.
//
// Hard-deletes one session end to end. Order matters:
//   1. guards (the only truly destructive step is refused up front),
//   2. archive-set scrub (reversible, through the registry's own write path),
//   3. the session directory itself (the irreversible step),
//   4. derived-cache purges (projection cache, sqlite search index) — these
//      are repair work after the fact and degrade to warnings, never failures.
//
// A session that is live in the host session store (open right now, or owned
// by a running agent) is refused: its persistence writer holds the log file
// and removing the directory underneath it would corrupt the running session.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureRegistryPatch } from './registry-patch.js'
import { findSessionDir, readProjectionCache } from './sessions-index.js'

const PROJCACHE_REL = 'storages/session_projcache.json'

/** Purge one id from the projection cache with an atomic write (tmp + rename). */
function purgeProjectionCache(home, id) {
  const path = join(home, PROJCACHE_REL)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  const table = parsed?.tables?.sessions
  if (table === null || typeof table !== 'object' || !(id in table)) return true
  delete table[id]
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(parsed))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Purge one id from the sqlite search index (dsh-session-query-sqlite).
 * The engine exposes no public removal API, so this opens the derived index
 * with a short-lived node:sqlite connection (the bundled runtime is Node 24,
 * where `node:sqlite` is available; the upstream engine itself uses it).
 * @returns 'purged' | 'absent' (no index configured in this profile) | 'failed'
 */
async function purgeQueryIndex(queryService, id) {
  const path = queryService?.config?.path
  if (typeof path !== 'string' || path === '') return 'absent'
  const { DatabaseSync } = await import('node:sqlite')
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 2000')
    db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
    return 'purged'
  } catch {
    return 'failed'
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Delete one session.
 * @param ctx - host plugin context (carries sessions/workspaceRegistry/sessionQuery).
 * @param home - DSH home directory.
 * @param id - session id to delete.
 * @returns { ok:true, indexPurged } or { ok:false, code, error }.
 */
export async function deleteSession(ctx, home, id) {
  // 1. refuse live sessions — deleting underneath a running session corrupts it
  const live = ctx.sessions?.get?.(id)
  if (live !== undefined) {
    return { ok: false, code: 'live', error: '会话正在使用中（已打开或正在运行），请先切换到其他会话' }
  }

  // 2. scrub the archive set (tolerated: a stale archived id is invisible)
  if (ensureRegistryPatch(ctx.workspaceRegistry)) {
    try {
      await ctx.workspaceRegistry.removeArchived(id)
    } catch {
      /* tolerate — the id is scrubbed by a later unarchive/delete or harmless */
    }
  }

  // 3. resolve the session directory (prefer the projection cache's cwd canon)
  const cwd = readProjectionCache(home)[id]?.identity?.cwd ?? null
  const dir = findSessionDir(home, id, cwd)
  if (dir !== null) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, code: 'fs', error: `删除会话目录失败: ${error?.message ?? error}` }
    }
  }

  // 4. repair derived caches (best-effort after the irreversible step)
  const projPurged = purgeProjectionCache(home, id)
  const indexResult = await purgeQueryIndex(ctx.sessionQuery, id)

  return {
    ok: true,
    // When false, the projection-cache row survives until dsh rewrites it;
    // the sidebar entry lingers but the session itself is gone.
    cachePurged: projPurged,
    indexPurged: indexResult === 'purged',
    indexAbsent: indexResult === 'absent',
  }
}
