// dsh-desktop-session-manager — delete transaction.
//
// Hard-deletes one session end to end. Order matters:
//   1. guards (the only truly destructive step is refused up front), plus the
//      store detach for a merely-attached idle session — archiving only hides
//      a session from the workspace list, it never releases the host session
//      store, so an archived session can still be "attached" (its agent and
//      persistence writer alive). We release the store entry through its own
//      detach disposer before touching disk; sessions with work in flight, or
//      owned by subagent routing, are refused.
//   2. archive-set scrub (reversible, through the registry's own write path),
//   3. the session directory itself (the irreversible step),
//   4. derived-cache purges (projection cache, sqlite search index) — these
//      are repair work after the fact and degrade to warnings, never failures.
//
// A session whose agent is actively running (a turn executing, a maintenance
// pass, or queued-but-unclaimed input) is refused: deleting underneath it
// would corrupt the live session. A session merely present in the store with
// an idle agent is detached first — the store entry's `detach()` runs the
// full internal teardown (store removal, attachments cleanup, and the
// `session/disposed` emission that makes the persistence plugin retire its
// writer), so the directory can be removed without corrupting or resurrecting
// the session. The same contained-patch pattern as registry-patch.js: the
// store internals are probed at runtime and we degrade to the old refusal
// when a future dsh build changes them.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureRegistryPatch } from './registry-patch.js'
import { findSessionDir, readProjectionCache } from './sessions-index.js'

const PROJCACHE_REL = 'storages/session_projcache.json'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * Whether the session's agent has work in flight. Mirrors the agent's public
 * `status` (running vs idle) plus the inbox's unclaimed input. The public
 * Agent handle exposes no `phase`/`maintenance` field: a maintenance task runs
 * while `status` stays `idle`, and "maintenance" is not an observable status.
 */
function agentBusy(ctx, id) {
  const agent = ctx.agents?.get?.(id)
  if (agent === undefined) return false
  if (agent.status === 'running') return true
  return agent.inbox?.hasPending === true
}

/**
 * Whether the session is owned by subagent routing and must stay out of the
 * desktop delete flow entirely. Mirrors dsh-api-remotes' ownership fence
 * (`origin === 'subagent'`, or a live parent agent that owns this id).
 */
function subagentOwned(ctx, session) {
  const header = session?.header
  if (header?.origin === 'subagent') return true
  const parentId = header?.parentSession
  if (parentId === undefined) return false
  const parent = ctx.agents?.get?.(parentId)
  return parent !== undefined && ctx.agents?.isOwnedBy?.(session.id, parent) === true
}

/**
 * Release one attached session from the host session store through the store
 * entry's own detach disposer. The store instance carries its internal entry
 * map as a plain field (no `#private`), and each entry exposes the exact
 * detach callback the store itself installed — calling it runs the full
 * internal teardown and emits `session/disposed`, which makes the persistence
 * plugin retire (flush + close) its writer before we remove the directory.
 *
 * @returns 'detached' | 'absent' (was not attached) | 'failed' | 'unsupported'
 *   ('unsupported' when a future dsh build changed the store internals).
 */
async function detachStoreSession(ctx, id) {
  const sessions = ctx.sessions
  if (sessions === undefined || sessions === null) return 'unsupported'
  const store = sessions.store
  if (store === undefined || typeof store.get !== 'function') return 'unsupported'
  const entry = store.get(id)
  if (entry === undefined) return 'absent'
  if (typeof entry.detach !== 'function') return 'unsupported'
  try {
    entry.detach()
  } catch {
    return 'failed'
  }
  // A detach requested mid-announce/append is deferred to the next dispatch
  // tick; wait briefly for the store to release the id before touching disk.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (store.get(id) === undefined) return 'detached'
    await sleep(30)
  }
  return 'failed'
}

/**
 * Remove the session directory with bounded retries: the detach's final
 * flush and any racing log write may briefly hold a file handle (Windows
 * refuses directory deletion while a child file is open).
 * @returns true on success (including an already-absent directory).
 */
async function removeSessionDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (attempt === 4) return { error: error?.message ?? String(error) }
      await sleep(150)
    }
  }
  return { error: 'unknown' }
}

/**
 * Delete one session.
 * @param ctx - host plugin context (carries sessions/agents/workspaceRegistry/sessionQuery).
 * @param home - DSH home directory.
 * @param id - session id to delete.
 * @returns { ok:true, indexPurged } or { ok:false, code, error }.
 */
export async function deleteSession(ctx, home, id) {
  // 1. guard + release any merely-attached idle session. A session with work
  //    in flight or subagent ownership is refused; a session only attached in
  //    the store (e.g. archived but still resident) is detached cleanly.
  const live = ctx.sessions?.get?.(id)
  if (live !== undefined) {
    if (subagentOwned(ctx, live)) {
      return { ok: false, code: 'live', error: '该会话由子代理任务占用，无法删除' }
    }
    if (agentBusy(ctx, id)) {
      return { ok: false, code: 'live', error: '该会话正在运行中（有未完成的回复或任务），请等待其结束后再删除' }
    }
    const detached = await detachStoreSession(ctx, id)
    if (detached === 'failed' || detached === 'unsupported') {
      return { ok: false, code: 'live', error: '该会话仍被当前应用占用且无法自动释放，请重启应用后再试' }
    }
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
    const removed = await removeSessionDir(dir)
    if (removed !== true) {
      return { ok: false, code: 'fs', error: `删除会话目录失败: ${removed.error}` }
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