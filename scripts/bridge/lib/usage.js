// dsh-desktop-bridge — token-consumption analytics.
//
// Aggregates token consumption since `since` (unix ms; 0 = all time) from the
// DSH session projection cache, attributed per session to its first-seen
// request model (cached by session-file rev across calls).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeWorkspace, readSessionModel } from './model-attribution.js'

export const MODEL_CACHE_FILE = 'storages/desktop-usage-models.json'
const MAX_MODEL_SCANS_PER_RUN = 40

export function usageReport(home, since) {
  const projPath = join(home, 'storages', 'session_projcache.json')
  const sessionsTable = (() => {
    try {
      const parsed = JSON.parse(readFileSync(projPath, 'utf8'))
      return parsed?.tables?.sessions ?? {}
    } catch {
      return {}
    }
  })()

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
    const tokens = {
      input: Number(totals.uncachedInputTokens ?? 0),
      output: Number(totals.outputTokens ?? 0),
      cacheRead: Number(totals.cacheReadTokens ?? 0),
      cacheWrite: Number(totals.cacheWriteTokens ?? 0),
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    if (since > 0 && createdAt < since) continue
    const stats = rec?.rows?.sessionStats?.val
    let title = rec?.rows?.title?.val
    if (typeof title !== 'string') title = null
    const model = modelFor(id, rec?.identity?.cwd)
    rows.push({
      id,
      title,
      createdAt,
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
    const key = dayKey(row.createdAt)
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
    since: since > 0 ? since : null,
    fromAllTime: since <= 0,
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
