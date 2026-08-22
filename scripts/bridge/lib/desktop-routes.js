// dsh-desktop-bridge — /desktop routes + turn-end notifications.
//
// Same-origin /desktop routes inside the dsh web server (no CORS, no ports):
// status/balance/refresh proxy to the shell listener, usage aggregates from
// the dsh session projection cache. Turn completion is tracked independently
// by turn-notifier.js and exposed here through getRunning().
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resetUsageCounter, usageReport } from './usage.js'

export function registerDesktopRoutes(ctx, { shellPort, onFocus, getRunning, modelBehavior }) {

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  // Format an error for the API response envelope.
  // - Network-level failures (connection refused, timeout, DNS) → "桌面壳不可用: …"
  // - Shell-level errors (shell responded but returned a non-ok status) → pass
  //   through the shell's own error message directly.
  const shellError = (error) => {
    const msg = error?.message ?? String(error)
    if (error?.shellReachable === true) return msg
    return `桌面壳不可用: ${msg}`
  }

  // GET a JSON endpoint on the shell listener.  When the shell responds with a
  // non-ok status the error carries the shell's own `error` field (when
  // present) and is tagged `shellReachable` so the caller can tell the
  // difference between "shell is down" and "shell rejected this request".
  const shellGet = async (path, timeoutMs) => {
    const resp = await fetch(`http://127.0.0.1:${shellPort}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      let shellMsg = ''
      try {
        const body = await resp.json()
        shellMsg = body?.error ?? ''
      } catch {}
      const err = new Error(shellMsg || `shell responded ${resp.status}`)
      err.shellReachable = true
      throw err
    }
    return await resp.json()
  }

  // POST to the shell listener and return the parsed JSON body.  Same
  // shellReachable tagging as shellGet so the catch block can use shellError().
  const shellPost = async (path, body, timeoutMs) => {
    const resp = await fetch(`http://127.0.0.1:${shellPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      let shellMsg = ''
      try {
        const payload = await resp.json()
        shellMsg = payload?.error ?? ''
      } catch {}
      const err = new Error(shellMsg || `shell responded ${resp.status}`)
      err.shellReachable = true
      throw err
    }
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
          await shellPost('/open-external', { url }, 8000)
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/remote-save') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          const result = await shellPost('/remote-save', {
            enabled: body?.enabled === true,
            relayUrl: typeof body?.relayUrl === 'string' ? body.relayUrl : '',
            customRelay: body?.customRelay === true,
            secret: typeof body?.secret === 'string' ? body.secret : '',
            deviceId: typeof body?.deviceId === 'string' ? body.deviceId : '',
          }, 10000)
          return json(res, 200, result)
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/current-session') {
        // The bridge client publishes the currently focused session id here so
        // the wave-state classifier can report THAT conversation's activity
        // instead of any background session's.
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null
          onFocus?.(sessionId || null)
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 400, { ok: false, error: `bad current-session body: ${error?.message ?? error}` })
        }
      }
      if (pathname === '/desktop/motion-save') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          const motion = typeof body?.motion === 'string' ? body.motion : ''
          const payload = await shellPost('/motion-save', { motion }, 8000)
          return json(res, 200, payload)
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/config-replace') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          if (body?.confirm !== true) return json(res, 400, { ok: false, error: 'explicit confirmation required' })
          return json(res, 200, await shellPost('/config-replace', { confirm: true }, 8000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/notifications-save') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          const mode = typeof body?.mode === 'string' ? body.mode : ''
          return json(res, 200, await shellPost('/notifications-save', { mode }, 8000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/notifications-test') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          return json(res, 200, await shellPost('/notifications-test', {}, 8000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/plugin-network-save') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          return json(res, 200, await shellPost('/plugin-network-save', {
            proxy: typeof body?.proxy === 'string' ? body.proxy : '',
            npmRegistry: typeof body?.npmRegistry === 'string' ? body.npmRegistry : '',
            installTimeoutMinutes: Number(body?.installTimeoutMinutes),
          }, 15000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/plugin-network-test') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          return json(res, 200, await shellPost('/plugin-network-test', {}, 55000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/builtin-plugins-apply') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          if (!Array.isArray(body?.enabled) || body.enabled.some((id) => typeof id !== 'string')) {
            return json(res, 400, { ok: false, error: 'enabled must be a string array' })
          }
          if (!Array.isArray(body?.expectedEnabled) || body.expectedEnabled.some((id) => typeof id !== 'string')) {
            return json(res, 400, { ok: false, error: 'expectedEnabled must be a string array' })
          }
          return json(res, 200, await shellPost('/builtin-plugins-apply', {
            enabled: body.enabled,
            expectedEnabled: body.expectedEnabled,
          }, 15000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/model-behavior-save') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req, 65536)
          const value = await modelBehavior?.save(body)
          if (value === undefined) throw new Error('model behavior settings are unavailable')
          return json(res, 200, { ok: true, ...value })
        } catch (error) {
          const message = String(error?.message ?? error)
          const status = /not ready|unavailable/.test(message) ? 503 : 400
          return json(res, status, { ok: false, error: message })
        }
      }
      // The persistent pairing endpoint is a write operation, so it must be
      // handled before the GET-only guard below. Keeping it after that guard
      // makes every save request fail with a misleading 404 at the bridge
      // layer and prevents the shell/Rust endpoint from being reached.
      if (pathname === '/desktop/remote-persistent-pairing') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const body = await readJsonBody(req)
          return json(res, 200, await shellPost('/remote-persistent-pairing', {
            code: typeof body?.code === 'string' ? body.code : '',
          }, 10000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/usage-reset') {
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' })
        try {
          const home = process.env.DSH_HOME || join(homedir(), '.dsh')
          const marker = resetUsageCounter(home)
          return json(res, 200, { ok: true, resetAt: marker.resetAt })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'not found' })
      if (pathname === '/desktop/motion') {
        try {
          return json(res, 200, await shellGet('/motion', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/config-health') {
        try {
          return json(res, 200, await shellGet('/config-health', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/notifications') {
        try {
          return json(res, 200, await shellGet('/notifications', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/plugin-network') {
        try {
          return json(res, 200, await shellGet('/plugin-network', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/builtin-plugins') {
        try {
          return json(res, 200, await shellGet('/builtin-plugins', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/model-behavior') {
        try {
          const value = modelBehavior?.read()
          if (value === undefined) throw new Error('model behavior settings are unavailable')
          return json(res, 200, { ok: true, ...value })
        } catch (error) {
          return json(res, 503, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (pathname === '/desktop/remote-config') {
        try {
          return json(res, 200, await shellGet('/remote-config', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/remote-pairing') {
        try {
          return json(res, 200, await shellGet('/remote-pairing', 10000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/status') {
        return json(res, 200, { ok: true, running: getRunning?.() === true });
      }
      if (pathname === '/desktop/balance') {
        try {
          return json(res, 200, await shellGet('/balance', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/refresh') {
        try {
          return json(res, 200, await shellGet('/refresh', 15000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/about') {
        try {
          return json(res, 200, await shellGet('/about', 3000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
        }
      }
      if (pathname === '/desktop/update-status') {
        try {
          return json(res, 200, await shellGet('/update-status', 20000))
        } catch (error) {
          return json(res, 502, { ok: false, error: shellError(error) })
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
