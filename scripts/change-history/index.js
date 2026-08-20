// dsh-desktop-change-history — Cordis host plugin mounted into the dsh web
// profile by DSH Desktop. Tracks every top-level `write`/`edit` the agent
// performs — the fs tool outcome already carries the pre/post content — and
// persists an append-only change log under `$DSH_HOME/desktop/changes/`.
//
// Serves:
//   GET  /desktop-changes/list      — change records (newest first, with diffs)
//   POST /desktop-changes/rollback  — restore one record's pre-change content
//
// Recording rides the observe-only `tools/result` event (listener failures are
// contained by the tool registry), so it can never break tool execution.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CODES, changeRow } from './lib/contract.js'
import { ChangeStore } from './lib/store.js'
import { unifiedDiff, diffStats } from './lib/diff.js'
import { rollbackChange } from './lib/rollback.js'
import { readFileText } from './lib/read.js'

export const name = 'dsh-desktop-change-history'
export const inject = ['webServer']

const MAX_BODY_BYTES = 64 * 1024

/** Best-effort session title from the header, then the last `session/title` log event. */
function sessionTitleOf(session) {
  if (session === undefined || session === null) return null
  if (typeof session.header?.title === 'string' && session.header.title !== '') return session.header.title
  if (!Array.isArray(session.events)) return null
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string' && event.data.title !== '') {
      return event.data.title
    }
  }
  return null
}

/** Read a bounded JSON request body; rejects on size, parse, or shape faults. */
async function readJsonBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_BYTES) throw new Error('请求体过大')
  }
  if (body.trim() === '') return {}
  const parsed = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

export function apply(ctx, config) {
  void config
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const store = new ChangeStore(join(home, 'desktop', 'changes'))

  // Record top-level write/edit outcomes. `tools/result` is observe-only and
  // delivers the deep-frozen final result, whose `value` carries the canonical
  // `{ path, operation?, before, after }` the fs tool returned.
  ctx.on('tools/result', (exec, result) => {
    if (result.isError) return
    if (exec.parent !== undefined) return
    if (exec.name !== 'write' && exec.name !== 'edit') return
    const value = result.value
    if (value === undefined || typeof value.path !== 'string') return
    try {
      const session = exec.agent?.session
      store.append({
        sessionId: session?.id ?? null,
        sessionTitle: sessionTitleOf(session),
        callId: exec.callId ?? null,
        tool: exec.name,
        path: value.path,
        operation: exec.name === 'write' ? value.operation : 'edit',
        before: typeof value.before === 'string' ? value.before : null,
        after: typeof value.after === 'string' ? value.after : '',
      })
    } catch (error) {
      ctx.logger?.warn?.(`change-history record failed: ${error?.message ?? error}`)
    }
  })

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }
  const guard = (res, error) => json(res, 400, { ok: false, code: CODES.BAD_REQUEST, error: String(error?.message ?? error) })

  /** Project one stored record to a client-facing row (diff + stats + reviewed). */
  const rowOf = (record) => ({
    ...changeRow(record),
    stats: diffStats(record.before, record.after),
    diff: unifiedDiff(record.before, record.after),
    reviewed: store.isReviewed(record.id),
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/desktop-changes',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        // Normalise pathname: the web server may deliver the full path
        // (/desktop-changes/read) or a path relative to the prefix (/read).
        // Always promote to the canonical full-path form so the route table
        // works regardless of prefix-stripping behaviour.
        let pathname = url.pathname
        if (pathname !== '/desktop-changes' && !pathname.startsWith('/desktop-changes/')) {
          pathname = '/desktop-changes' + pathname
        }

        if (req.method === 'GET' && pathname === '/desktop-changes/ping') {
          return json(res, 200, { ok: true, name, version: '0.1.0' })
        }
        if (req.method === 'GET' && pathname === '/desktop-changes/read') {
          const path = url.searchParams.get('path') ?? ''
          const outcome = readFileText(path)
          return json(res, outcome.ok ? 200 : 400, outcome)
        }
        if (req.method === 'GET' && pathname === '/desktop-changes/resolve') {
          const callId = url.searchParams.get('callId') ?? ''
          if (callId === '') return json(res, 200, { ok: true, change: null })
          const record = store.findByCallId(callId)
          return json(res, 200, { ok: true, change: record === undefined ? null : rowOf(record) })
        }
        if (req.method === 'GET' && pathname === '/desktop-changes/list') {
          const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200))
          const sessionId = url.searchParams.get('sessionId') ?? null
          let rows = store.list().map(rowOf)
          if (sessionId !== null && sessionId !== '') {
            rows = rows.filter((row) => row.sessionId === sessionId)
          }
          return json(res, 200, { ok: true, changes: rows.slice(0, limit) })
        }
        if (req.method === 'POST' && pathname === '/desktop-changes/review') {
          const body = await readJsonBody(req)
          const id = body.id
          const reviewed = body.reviewed === true
          if (typeof id !== 'string' || id === '') return guard(res, new Error('缺少变更 id'))
          if (store.get(id) === undefined) return json(res, 404, { ok: false, code: CODES.NOT_FOUND, error: '变更记录不存在' })
          store.setReviewed(id, reviewed)
          return json(res, 200, { ok: true, reviewed })
        }
        if (req.method === 'POST' && pathname === '/desktop-changes/rollback') {
          const { id } = await readJsonBody(req)
          if (typeof id !== 'string' || id === '') return guard(res, new Error('缺少变更 id'))
          const record = store.get(id)
          if (record === undefined) return json(res, 404, { ok: false, code: CODES.NOT_FOUND, error: '变更记录不存在' })
          const outcome = rollbackChange(record)
          return json(res, outcome.ok ? 200 : 409, outcome)
        }
        // Catch-all: include the request method + pathname in the error so the
        // client (and logs) show exactly what wasn't matched.
        return json(res, 404, {
          ok: false,
          code: CODES.NOT_FOUND,
          error: `not found (${req.method ?? '?'} ${pathname || '/'})`,
        })
      } catch (error) {
        return guard(res, error)
      }
    },
  }), 'dsh-desktop-change-history: /desktop-changes routes')
}
