// dsh-desktop-session-manager — session index scan.
//
// Ground truth for "which sessions exist" is the sessions tree on disk
// (`<home>/sessions/<encoded-workspace>/<id>/`); the projection cache
// (`<home>/storages/session_projcache.json`) supplies the display metadata
// (title, createdAt, token totals, turn count). The archive flag is merged in
// by the caller from the workspaceRegistry's `archivedSessionIds`.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** DSH session dirs encode the workspace cwd as `--<sanitized>--`. */
export function encodeWorkspace(cwd) {
  return `--${String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')}--`
}

/** Read the projection-cache sessions table, tolerating every failure shape. */
export function readProjectionCache(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache.json'), 'utf8'))
    return parsed?.tables?.sessions ?? {}
  } catch {
    return {}
  }
}

/**
 * Walk the sessions tree and merge projection metadata.
 * @param home - DSH home directory (`~/.dsh` or `$DSH_HOME`).
 * @param archived - Set of archived session ids (string ids).
 * @returns session rows sorted by createdAt descending (unknown dates last, then by id).
 */
export function buildSessionsIndex(home, archived) {
  const proj = readProjectionCache(home)
  const rows = []
  const root = join(home, 'sessions')
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    workspaces = []
  }
  for (const ws of workspaces) {
    let ids = []
    try {
      ids = readdirSync(join(root, ws), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const id of ids) {
      const rec = proj[id]
      const createdAt = rec?.identity?.createdAt
      const totals = rec?.rows?.tokenUsage?.val?.totals
      const stats = rec?.rows?.sessionStats?.val
      const title = rec?.rows?.title?.val
      const tokens = totals === null || typeof totals !== 'object'
        ? null
        : {
            input: Number(totals.uncachedInputTokens ?? 0),
            output: Number(totals.outputTokens ?? 0),
            cacheRead: Number(totals.cacheReadTokens ?? 0),
            cacheWrite: Number(totals.cacheWriteTokens ?? 0),
          }
      if (tokens !== null) tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
      rows.push({
        id,
        title: typeof title === 'string' ? title : null,
        createdAt: typeof createdAt === 'number' ? createdAt : null,
        workspaceId: ws,
        cwd: typeof rec?.identity?.cwd === 'string' ? rec.identity.cwd : null,
        archived: archived.has(id),
        tokens,
        turns: typeof stats?.turns === 'number' ? stats.turns : null,
      })
    }
  }
  rows.sort((a, b) => {
    if (a.createdAt === null && b.createdAt === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (a.createdAt === null) return 1
    if (b.createdAt === null) return -1
    return b.createdAt - a.createdAt
  })
  return rows
}

/**
 * Locate a session directory by id, preferring the projection cache's cwd
 * (the same canonical source dsh-session-persistence-jsonl uses) and falling
 * back to a scan of every workspace dir.
 * @returns the absolute session directory path, or null when absent.
 */
export function findSessionDir(home, id, cwd) {
  const root = join(home, 'sessions')
  const candidates = []
  if (typeof cwd === 'string' && cwd !== '') {
    candidates.push(join(root, encodeWorkspace(cwd), id))
  }
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    workspaces = []
  }
  for (const ws of workspaces) {
    candidates.push(join(root, ws, id))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
