// dsh-desktop-session-manager — Cordis host plugin mounted into the dsh web
// profile by DSH Desktop (second row of scripts/bridge.patch.yml).
//
// Session management the desktop shell owns end to end:
//   * GET  /desktop-sessions/list       — every session (archived flag merged)
//   * POST /desktop-sessions/unarchive  — restore an archived session
//   * POST /desktop-sessions/delete     — hard-delete a session + derived caches
//
// The archive set lives inside dsh's workspaceRegistry, so unarchive/scrub go
// through the registry's own durability path (see lib/registry-patch.js):
// writes fire dsh's domain-change broadcast and the sidebar refreshes live.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CODES } from './lib/contract.js'
import { deleteSession } from './lib/delete.js'
import { ensureRegistryPatch } from './lib/registry-patch.js'
import { buildSessionsIndex } from './lib/sessions-index.js'

export const name = 'dsh-desktop-session-manager'
export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionQuery']

const MAX_BODY_BYTES = 64 * 1024

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

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  const guard = (res, error) => json(res, 400, { ok: false, code: 'bad_request', error: String(error?.message ?? error) })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/desktop-sessions',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      try {
        if (req.method === 'GET' && pathname === '/desktop-sessions/ping') {
          return json(res, 200, { ok: true, name, version: '0.1.0' })
        }
        if (req.method === 'GET' && pathname === '/desktop-sessions/list') {
          const archivedIds = ctx.workspaceRegistry.archivedSessionIds
          const archived = new Set(Array.isArray(archivedIds) ? archivedIds : [])
          return json(res, 200, {
            ok: true,
            sessions: buildSessionsIndex(home, archived),
          })
        }
        if (req.method === 'POST' && pathname === '/desktop-sessions/unarchive') {
          const { id } = await readJsonBody(req)
          if (typeof id !== 'string' || id === '') return guard(res, new Error('缺少会话 id'))
          if (!ensureRegistryPatch(ctx.workspaceRegistry)) {
            return json(res, 200, { ok: false, code: CODES.DEGRADED, error: '当前 dsh 版本不支持恢复归档，请升级 dsh 或删除该会话' })
          }
          try {
            await ctx.workspaceRegistry.unarchiveSession(id)
            return json(res, 200, { ok: true })
          } catch (error) {
            return json(res, 500, { ok: false, code: 'registry', error: String(error?.message ?? error) })
          }
        }
        if (req.method === 'POST' && pathname === '/desktop-sessions/delete') {
          const { id } = await readJsonBody(req)
          if (typeof id !== 'string' || id === '') return guard(res, new Error('缺少会话 id'))
          const result = await deleteSession(ctx, home, id)
          return json(res, result.ok ? 200 : 409, result)
        }
        return json(res, 404, { ok: false, code: 'not_found', error: 'not found' })
      } catch (error) {
        return guard(res, error)
      }
    },
  }), 'dsh-desktop-session-manager: /desktop-sessions routes')
}
