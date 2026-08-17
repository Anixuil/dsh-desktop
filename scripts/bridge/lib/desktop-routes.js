// dsh-desktop-bridge — /desktop routes + turn-end notifications.
//
// Same-origin /desktop routes inside the dsh web server (no CORS, no ports):
// status/balance/refresh proxy to the shell listener, usage aggregates from
// the dsh session projection cache. Also listens for `agent/status` idle
// transitions and POSTs /turn-end to the shell.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { usageReport } from './usage.js'

export function registerDesktopRoutes(ctx, { shellPort }) {
  let lastRunning = false
  let notified = false

  const notifyTurnEnd = () => {
    fetch(`http://127.0.0.1:${shellPort}/turn-end`, { method: 'POST' }).catch(() => {})
  }

  ctx.on('agent/status', (payload) => {
    const status = payload?.status
    if (status === 'running') {
      lastRunning = true
      notified = false
      return
    }
    if (status === 'idle' && lastRunning && !notified) {
      lastRunning = false
      notified = true
      notifyTurnEnd()
    }
  })

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }
  const shellGet = async (path, timeoutMs) => {
    const resp = await fetch(`http://127.0.0.1:${shellPort}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) throw new Error(`shell responded ${resp.status}`)
    return await resp.json()
  }
  const readJsonBody = async (req, maxBytes = 4096) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > maxBytes) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('request body is not valid JSON')
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/desktop',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === '/desktop/open-external') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          const url = typeof body?.url === 'string' ? body.url.trim() : ''
          if (!url) return json(res, 400, { ok: false, error: '缺少 url' })
          const resp = await fetch(`http://127.0.0.1:${shellPort}/open-external`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: AbortSignal.timeout(8000),
          })
          if (!resp.ok) {
            const payload = await resp.json().catch(() => ({}))
            return json(res, 502, { ok: false, error: payload?.error ?? `shell responded ${resp.status}` })
          }
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 502, { ok: false, error: `桌面壳不可用: ${error?.message ?? error}` })
        }
      }
      if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'not found' })
      if (pathname === '/desktop/status') {
        return json(res, 200, { ok: true, running: lastRunning });
      }
      if (pathname === '/desktop/balance') {
        try {
          return json(res, 200, await shellGet('/balance', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: `桌面壳不可用: ${error?.message ?? error}` })
        }
      }
      if (pathname === '/desktop/refresh') {
        try {
          return json(res, 200, await shellGet('/refresh', 15000))
        } catch (error) {
          return json(res, 502, { ok: false, error: `桌面壳不可用: ${error?.message ?? error}` })
        }
      }
      if (pathname === '/desktop/about') {
        try {
          return json(res, 200, await shellGet('/about', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: `桌面壳不可用: ${error?.message ?? error}` })
        }
      }
      if (pathname === '/desktop/update-status') {
        try {
          return json(res, 200, await shellGet('/update-status', 20000))
        } catch (error) {
          return json(res, 502, { ok: false, error: `桌面壳不可用: ${error?.message ?? error}` })
        }
      }
      if (pathname === '/desktop/usage') {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const since = Number(url.searchParams.get('since') ?? 0) || 0
          const home = process.env.DSH_HOME || join(homedir(), '.dsh')
          return json(res, 200, usageReport(home, since))
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      return json(res, 404, { ok: false, error: 'not found' })
    },
  }), 'dsh-desktop-bridge: /desktop routes')
}
