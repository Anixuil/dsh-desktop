// dsh-desktop-bridge — token-consumption analytics.
//
// Aggregates token consumption from the DSH session projection cache,
// attributed per session to its first-seen request model (cached by session
// file revision). A persisted reset snapshot makes the aggregate behave like
// a trip odometer without deleting historical session data.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeWorkspace, readSessionModel } from './model-attribution.js'

export const MODEL_CACHE_FILE = 'storages/desktop-usage-models.json'
export const USAGE_RESET_FILE = 'storages/desktop-usage-reset.json'
const MAX_MODEL_SCANS_PER_RUN = 40

const tokenValue = (value) => Number.isFinite(Number(value)) ? Number(value) : 0

const tokenTotals = (totals) => ({
  input: tokenValue(totals?.uncachedInputTokens ?? totals?.input),
  output: tokenValue(totals?.outputTokens ?? totals?.output),
  cacheRead: tokenValue(totals?.cacheReadTokens ?? totals?.cacheRead),
  cacheWrite: tokenValue(totals?.cacheWriteTokens ?? totals?.cacheWrite),
})

const withTotal = (tokens) => ({
  ...tokens,
  total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
})

const readSessionsTable = (home) => {
  try {
    return JSON.parse(readFileSync(join(home, 'storages', 'session_projcache.json'), 'utf8'))?.tables?.sessions ?? {}
  } catch {
    return {}
  }
}

/**
 * Stores the current counter values for every known session. Future reports
 * subtract this snapshot, so an already-open session continues contributing
 * only the tokens consumed after the reset, like a trip odometer.
 */
export function resetUsageCounter(home, resetAt = Date.now()) {
  const sessions = {}
  for (const [id, rec] of Object.entries(readSessionsTable(home))) {
    const totals = rec?.rows?.tokenUsage?.val?.totals
    if (totals !== null && typeof totals === 'object') sessions[id] = withTotal(tokenTotals(totals))
  }
  const marker = { version: 1, resetAt, sessions }
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, USAGE_RESET_FILE), JSON.stringify(marker))
  return marker
}

export function usageReport(home, since) {
  let resetMarker = null
  try {
    resetMarker = JSON.parse(readFileSync(join(home, USAGE_RESET_FILE), 'utf8'))
  } catch { /* first run */ }
  const resetAt = Number(resetMarker?.resetAt) || 0
  const resetSnapshots = resetMarker?.version === 1 && resetMarker?.sessions && typeof resetMarker.sessions === 'object'
    ? resetMarker.sessions
    : null
  const requestedSince = Number(since) || 0
  // A versioned snapshot is a stronger, exact baseline than the older
  // registration-date filter: it must include increments from sessions that
  // were already open at reset time.
  const effectiveSince = resetSnapshots === null ? Math.max(requestedSince, resetAt) : 0
  const reportingSince = Math.max(requestedSince, resetAt)
  const sessionsTable = readSessionsTable(home)

  // session id -> log file path, from a light scan of the sessions tree
  const logPaths = new Map()
  {
    const root = join(home, 'sessions')
    let workspaces = []
    try { workspaces = readdirSync(root) } catch { workspaces = [] }
    for (const ws of workspaces) {
      let ids = []
      try { ids = readdirSync(join(root, ws)) } catch { continue }
      for (const id of ids) {
        const candidate = join(root, ws, id, 'session.jsonl.zstd')
        if (existsSync(candidate)) logPaths.set(id, candidate)
      }
    }
  }

  // model attribution cache
  const modelCachePath = join(home, MODEL_CACHE_FILE)
  let modelCache = {}
  try { modelCache = JSON.parse(readFileSync(modelCachePath, 'utf8')) ?? {} } catch { modelCache = {} }
  let cacheDirty = false
  let modelScans = 0

  const modelFor = (id, cwd) => {
    const logPath = logPaths.get(id) ?? (cwd ? join(home, 'sessions', encodeWorkspace(cwd), id, 'session.jsonl.zstd') : null)
    if (logPath === null || !existsSync(logPath)) return null
    let rev = ''
    try {
      const st = statSync(logPath)
      rev = `${st.size}-${st.mtimeMs}`
    } catch { return null }
    const cached = modelCache[id]
    if (cached !== undefined && cached?.rev === rev) {
      return { provider: cached.provider ?? null, model: cached.model ?? null }
    }
    if (modelScans >= MAX_MODEL_SCANS_PER_RUN) return cached?.model !== undefined ? { provider: cached.provider ?? null, model: cached.model ?? null } : null
    modelScans += 1
    const found = readSessionModel(logPath)
    modelCache[id] = { rev, ...(found ?? { provider: null, model: null }) }
    cacheDirty = true
    return found
  }

  const rows = []
  for (const [id, rec] of Object.entries(sessionsTable)) {
    const createdAt = rec?.identity?.createdAt
    const totals = rec?.rows?.tokenUsage?.val?.totals
    if (typeof createdAt !== 'number' || totals === null || typeof totals !== 'object') continue
    const currentTokens = withTotal(tokenTotals(totals))
    if (effectiveSince > 0 && createdAt < effectiveSince) continue
    const snapshot = resetSnapshots?.[id]
    const tokens = snapshot === undefined
      ? currentTokens
      : withTotal({
        input: Math.max(0, currentTokens.input - tokenValue(snapshot?.input)),
        output: Math.max(0, currentTokens.output - tokenValue(snapshot?.output)),
        cacheRead: Math.max(0, currentTokens.cacheRead - tokenValue(snapshot?.cacheRead)),
        cacheWrite: Math.max(0, currentTokens.cacheWrite - tokenValue(snapshot?.cacheWrite)),
      })
    if (tokens.total <= 0) continue
    const stats = rec?.rows?.sessionStats?.val
    let title = rec?.rows?.title?.val
    if (typeof title !== 'string') title = null
    const model = modelFor(id, rec?.identity?.cwd)
    rows.push({
      id,
      title,
      createdAt,
      countedAt: snapshot === undefined ? createdAt : resetAt,
      tokens,
      turns: typeof stats?.turns === 'number' ? stats.turns : null,
      llmMs: typeof stats?.llmMs === 'number' ? stats.llmMs : null,
      provider: model?.provider ?? null,
      model: model?.model ?? null,
    })
  }

  if (cacheDirty) {
    try {
      mkdirSync(join(home, 'storages'), { recursive: true })
      writeFileSync(modelCachePath, JSON.stringify(modelCache))
    } catch { /* best-effort cache */ }
  }

  rows.sort((a, b) => b.createdAt - a.createdAt)

  // totals + by-model
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const byModel = new Map()
  for (const row of rows) {
    totals.input += row.tokens.input
    totals.output += row.tokens.output
    totals.cacheRead += row.tokens.cacheRead
    totals.cacheWrite += row.tokens.cacheWrite
    totals.total += row.tokens.total
    const key = row.model ?? 'unknown'
    let entry = byModel.get(key)
    if (entry === undefined) {
      entry = { model: key, provider: row.provider ?? null, sessions: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      byModel.set(key, entry)
    }
    entry.sessions += 1
    entry.tokens.input += row.tokens.input
    entry.tokens.output += row.tokens.output
    entry.tokens.cacheRead += row.tokens.cacheRead
    entry.tokens.cacheWrite += row.tokens.cacheWrite
    entry.tokens.total += row.tokens.total
  }
  const byModelRows = [...byModel.values()].filter((row) => row.tokens.total > 0).sort((a, b) => b.tokens.total - a.tokens.total)

  // by-day series (last 14 local days)
  const dayKey = (ms) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const today = new Date()
  const days = []
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    days.push({ date: dayKey(d.getTime()), total: 0, output: 0, sessions: 0 })
  }
  const dayIndex = new Map(days.map((d, i) => [d.date, i]))
  const activeDaySet = new Set()
  for (const row of rows) {
    const key = dayKey(row.countedAt)
    if (key >= days[0].date) {
      const idx = dayIndex.get(key)
      if (idx !== undefined) {
        days[idx].total += row.tokens.total
        days[idx].output += row.tokens.output
        days[idx].sessions += 1
      }
    }
    activeDaySet.add(key)
  }

  return {
    ok: true,
    since: reportingSince > 0 ? reportingSince : null,
    fromAllTime: reportingSince <= 0,
    resetAt: resetAt > 0 ? resetAt : null,
    generatedAt: Date.now(),
    totals,
    byModel: byModelRows,
    byDay: days,
    sessions: rows.slice(0, 20).map(({ id, title, createdAt, tokens, turns, model }) => ({ id, title, createdAt, tokens, turns, model })),
    counts: {
      sessions: rows.length,
      activeDays: activeDaySet.size,
      scannedModels: modelScans,
    },
  }
}
