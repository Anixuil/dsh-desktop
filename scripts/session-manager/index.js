// dsh-desktop-session-manager — Cordis host plugin mounted into the dsh web
// profile by DSH Desktop (second row of scripts/bridge.patch.yml).
//
// Session management the desktop shell owns end to end:
//   * GET  /desktop-sessions/list       — every session (archived flag merged)
//   * POST /desktop-sessions/unarchive  — restore an archived session
//   * POST /desktop-sessions/delete     — hard-delete a session + derived caches
//
// On top of the routes, activation also idempotently patches the served
// workspace-browser client bundle (see lib/workspace-patch.js) so sidebar
// session rows gain a permanent-delete entry that calls our delete route.
//
// The archive set lives inside dsh's workspaceRegistry, so unarchive/scrub go
// through the registry's own durability path (see lib/registry-patch.js):
// writes fire dsh's domain-change broadcast and the sidebar refreshes live.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CODES } from './lib/contract.js'
import { deleteSession } from './lib/delete.js'
import { ensureRegistryPatch } from './lib/registry-patch.js'
import { buildSessionsIndex } from './lib/sessions-index.js'
import { applyWorkspaceDeletePatch, WORKSPACE_BUNDLE_ID } from './lib/workspace-patch.js'

export const name = 'dsh-desktop-session-manager'
export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionQuery', 'agents']

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

  // Sidebar session-delete: idempotently patch the SERVED workspace-browser
  // bundle so every session row gains a danger 永久删除 menu entry that calls
  // /desktop-sessions/delete, confirms in a modal, clears the selection when
  // the deleted session was current, and refreshes the baseline so the row
  // disappears from every grouping surface. Reading the bundle through the
  // client-modules registry (not inject — it may be absent in a degraded
  // composition) guarantees we patch exactly the file the browser fetches.
  const patchWorkspaceBundle = () => {
    const clientModules = ctx.get?.('clientModules')
    if (clientModules === undefined || typeof clientModules.clientPath !== 'function') return
    let bundlePath
    try {
      bundlePath = clientModules.clientPath(WORKSPACE_BUNDLE_ID)
    } catch {
      return
    }
    if (bundlePath === undefined) return
    try {
      const current = readFileSync(bundlePath, 'utf8')
      const patched = applyWorkspaceDeletePatch(current)
      if (patched.applied && patched.source !== current) {
        writeFileSync(bundlePath, patched.source)
        if (typeof clientModules.rebuilt === 'function') {
          try {
            clientModules.rebuilt(WORKSPACE_BUNDLE_ID)
          } catch (error) {
            ctx.logger?.warn?.(`workspace bundle rev refresh failed: ${error?.message ?? error}`)
          }
        }
        ctx.logger?.info?.(`sidebar session-delete patch applied -> ${bundlePath}`)
      } else if (patched.reason !== 'already patched') {
        ctx.logger?.warn?.(`workspace bundle left untouched: ${patched.reason}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`sidebar session-delete patch failed: ${error?.message ?? error}`)
    }
  }
  patchWorkspaceBundle()
  // The client-modules fiber activates in the same wave as our inject
  // services; retry on the next tick so a fresh (post-kernel-update) bundle is
  // patched even when the registry wins the race against this activation.
  if (typeof setImmediate === 'function') setImmediate(patchWorkspaceBundle)

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
