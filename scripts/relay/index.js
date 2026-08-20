// dsh-desktop-relay — public relay: pairs phones (browsers) with PCs running
// a dsh desktop shell, without either side opening an inbound port.
//
//   agent:  wss://relay/agent?deviceId=my-pc   (Bearer deviceSecret, auto-issued)
//   phone:  https://my-pc.remote.example.com/...   (Host subdomain route)
//           https://relay/d/my-pc/...              (path-prefix fallback)
//
// Identity flow (product shape):
//   PC     POST /register {deviceId}             -> {deviceSecret}
//   PC     POST /pairing {deviceId} (agent auth) -> {code}           (5 min)
//   phone  POST /pair {code}                     -> {deviceId, phoneToken}
//   phone  browses the device URL with the phoneToken cookie/bearer
// RELAY_SECRET remains an admin key that opens any device, so prototype
// deployments keep working unchanged.
//
// The relay never parses dsh semantics: it forwards HTTP exchanges and WS
// streams as opaque frames (see lib/frames.js and README.md).
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { decodeFrame, encodeFrame, validateDeviceId, bytesToBase64 } from './lib/frames.js'
import { bearerToken, cookieToken, secretMatches, unauthorized } from './lib/auth.js'
import { createDeviceStore } from './lib/store.js'
import { DeviceRegistry } from './lib/registry.js'
import { HttpExchange, WsStream, forwardRequestHeaders } from './lib/bridge.js'

const MAX_REQUEST_BODY = 1024 * 1024
const PAIRING_TTL_MS = 5 * 60 * 1000

/** Cookie scope: the host minus its leftmost label (.remote.example.com). */
function cookieDomain(host) {
  const labels = String(host).split(':')[0].split('.')
  return labels.length > 1 ? labels.slice(1).join('.') : labels[0]
}

/** Minimal login page: phones POST a pairing code and get a cookie. */
function loginPage(next, error, prefill) {
  const safe = typeof next === 'string' && next.startsWith('/') ? next : '/'
  const code = typeof prefill === 'string' && /^\d{6}$/.test(prefill) ? prefill : ''
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh relay · 登录</title>
<style>body{font-family:system-ui;background:#101418;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#1a2026;padding:28px;border-radius:12px;width:min(90vw,340px);display:flex;flex-direction:column;gap:12px}
input{padding:10px;border-radius:8px;border:1px solid #39424d;background:#0d1117;color:#e8eaf0;font-size:16px}
button{padding:12px;border:0;border-radius:8px;background:#2f81f7;color:#fff;font-size:16px;cursor:pointer}
h1{font-size:18px;margin:0 0 4px} p{color:#8b949e;font-size:13px;margin:0 0 8px}
.err{color:#f85149;font-size:13px}</style>
<form method="post" action="/login">
<h1>dsh relay 登录</h1><p>输入配对码（在电脑的远程访问设置里生成，5 分钟内有效）</p>
${error ? `<div class="err">${String(error)}</div>` : ''}
${safe === '/login' || safe === '/' ? '' : `<input type="hidden" name="next" value="${safe.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`}
<input type="text" name="token" inputmode="numeric" autocomplete="one-time-code" autofocus required${code ? ` value="${code}"` : ''}>
<button type="submit">连接</button>
</form>`
}

/** Read a small JSON request body, or undefined when unreadable. */
async function readJson(req, maxBytes = 16 * 1024) {
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

/**
 * Boot the relay.
 * @param options.port - listen port (0 = OS-assigned, used by tests).
 * @param options.host - bind host (default 127.0.0.1; put caddy in front).
 * @param options.secret - admin key (RELAY_SECRET env by default).
 * @param options.secretFile - file holding the admin key (read when no env/option).
 * @param options.stateFile - per-device identity store (relay-state.json).
 * @param options.registerSecret - optional gate for POST /register.
 * @param options.heartbeatInterval / options.idleTimeout - agent liveness tuning.
 * @returns { port, registry, close } (resolves once the listener is up).
 */
export async function startRelay({
  port = 8080,
  host = '127.0.0.1',
  secret = process.env.RELAY_SECRET,
  secretFile = process.env.RELAY_SECRET_FILE,
  stateFile = process.env.RELAY_STATE_FILE ?? 'relay-state.json',
  registerSecret = process.env.RELAY_REGISTER_SECRET,
  heartbeatInterval = 25_000,
  idleTimeout = 35_000,
  maxConcurrentViewers = Number(process.env.RELAY_MAX_CONCURRENT_VIEWERS ?? 3),
  viewerIdleTimeout = Number(process.env.RELAY_VIEWER_IDLE_TIMEOUT ?? 5 * 60_000),
} = {}) {
  if ((secret === undefined || secret === null) && secretFile !== undefined) {
    try {
      secret = readFileSync(secretFile, 'utf8').trim()
    } catch (error) {
      throw new Error(`无法读取密钥文件 ${secretFile}（${error?.message ?? error}）— 请在宝塔文件管理里创建该文件，内容为一行随机密钥（至少 8 位），或改用 RELAY_SECRET 环境变量`)
    }
  }
  if (typeof secret !== 'string' || secret.length < 8) {
    throw new Error('RELAY_SECRET must be set (at least 8 characters)')
  }
  const store = createDeviceStore({ file: stateFile })
  const registry = new DeviceRegistry({ heartbeatInterval, idleTimeout, maxConcurrentViewers, viewerIdleTimeout })
  /** pairing code -> { deviceId, expires } (in-memory, 5-minute TTL). */
  const pairings = new Map()
  const pairingSweep = setInterval(() => {
    const now = Date.now()
    for (const [code, entry] of pairings) {
      if (entry.expires < now) pairings.delete(code)
    }
  }, 60_000)
  pairingSweep.unref?.()
  let nextId = 1

  /** Credentials presented by a request (bearer + cookie, de-duplicated). */
  function presentedCredentials(req) {
    const found = []
    const bearer = bearerToken(req.headers.authorization)
    const cookie = cookieToken(req.headers.cookie)
    if (bearer !== undefined && bearer !== '') found.push(bearer)
    if (cookie !== undefined && cookie !== '' && cookie !== bearer) found.push(cookie)
    return found
  }

  const isAdmin = (presented) => secretMatches(presented, secret)
  /** Agent-side auth: admin key or the device's own secret. */
  const agentAuthorized = (req, deviceId) => presentedCredentials(req)
    .some((p) => isAdmin(p) || store.verifyAgent(deviceId, p))
  /** Phone-side auth: admin key, phone token, or the device secret (owner). */
  const phoneAuthorized = (req, deviceId) => presentedCredentials(req)
    .some((p) => isAdmin(p) || store.verifyPhone(deviceId, p) || store.verifyAgent(deviceId, p))

  const viewerSessionKey = (req) => {
    const bearer = bearerToken(req.headers.authorization)
    const cookie = cookieToken(req.headers.cookie)
    return bearer || cookie || `ip:${req.socket.remoteAddress ?? 'unknown'}`
  }

  /** Resolve the device a phone request addresses, plus the remaining path. */
  function resolveTarget(req, url) {
    // Explicit path prefix wins: /d/<deviceId>/<rest>
    const prefix = url.pathname.match(/^\/d\/([^/]+)(\/.*)?$/)
    if (prefix !== null) {
      const deviceId = prefix[1].toLowerCase()
      if (!validateDeviceId(deviceId)) return undefined
      return { deviceId, path: prefix[2] ?? '/', query: url.search }
    }
    // Otherwise derive the device from the Host subdomain: <deviceId>.example.com
    const hostname = String(req.headers.host ?? '').split(':')[0].toLowerCase()
    const sub = hostname.match(/^([a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9]))\./)
    if (sub !== null && validateDeviceId(sub[1])) {
      return { deviceId: sub[1], path: url.pathname, query: url.search }
    }
    return undefined
  }

  /** Answer an agent frame with id against its pending phone-side exchange. */
  function deliverAgentFrame(entry, frame) {
    // Heartbeat reply: nothing to deliver, the message handler already
    // refreshed lastSeen.
    if (frame.type === 'pong') return
    const http = frame.id === undefined ? undefined : entry.pendingHttp.get(frame.id)
    const ws = frame.id === undefined ? undefined : entry.pendingWs.get(frame.id)
    if (http !== undefined) {
      switch (frame.type) {
        case 'res':
          if (frame.body === undefined || frame.body === null) http.beginHead(frame)
          else http.complete(frame)
          return
        case 'chunk':
          http.chunk(frame)
          return
        case 'end':
          http.finish()
          return
        case 'err':
          http.error(frame.message)
          return
        default:
          break
      }
    }
    if (ws !== undefined) {
      switch (frame.type) {
        case 'ws-ready':
          ws.markReady()
          return
        case 'ws-data':
          ws.fromAgent(frame)
          return
        case 'ws-close':
          ws.agentClosed(frame)
          return
        default:
          break
      }
    }
    // Stale id (already cleaned up from a completed exchange/stream): a benign
    // close-echo or in-flight data race — ignore instead of killing the agent
    // connection. A genuine protocol error (wrong frame kind for a known id)
    // still closes the socket below.
    if (http === undefined && ws === undefined) return
    // Mismatched frame (wrong kind for the id): genuine protocol error.
    entry.ws.close(1008, `unexpected frame ${frame.type} for id ${frame.id}`)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    try {
      if (url.pathname === '/healthz') {
        json(200, { ok: true, name: 'dsh-desktop-relay', devices: registry.devices.size, registered: store.count })
        return
      }
      // Public device registration.  Device names are only considered
      // occupied while an agent with that name is online.  Relay state can
      // survive an uninstall/reinstall, so an offline stale identity is
      // safely rotated instead of trapping the user behind a misleading 409.
      if (url.pathname === '/register') {
        if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
        if (registerSecret !== undefined && registerSecret !== '') {
          const presented = presentedCredentials(req)
          if (!presented.some((p) => secretMatches(p, registerSecret))) return json(401, { ok: false, error: 'registration not authorized' })
        }
        const body = await readJson(req)
        const deviceId = String(body?.deviceId ?? '').toLowerCase()
        if (!validateDeviceId(deviceId)) return json(400, { ok: false, error: 'invalid deviceId' })
        const live = registry.devices.has(deviceId)
        const deviceSecret = store.register(deviceId, { replace: !live })
        if (deviceSecret === undefined) {
          return json(409, { ok: false, error: 'deviceId is currently in use' })
        }
        return json(200, { ok: true, deviceId, deviceSecret })
      }
      // Admin recovery: remove a registered device (RELAY_SECRET required).
      // Lets a PC that lost its device secret (reinstall/config loss)
      // register the same deviceId again.
      if (url.pathname === '/admin/device-delete') {
        if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
        if (!presentedCredentials(req).some((p) => isAdmin(p))) {
          return json(401, { ok: false, error: 'admin key required' })
        }
        const body = await readJson(req)
        const deviceId = String(body?.deviceId ?? '').toLowerCase()
        if (!validateDeviceId(deviceId)) return json(400, { ok: false, error: 'invalid deviceId' })
        const removed = store.remove(deviceId)
        return json(200, { ok: true, deviceId, removed })
      }
      // Public pairing exchange: a temporary code or user-defined persistent
      // code becomes a per-phone long-lived token.
      if (url.pathname === '/pair') {
        if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
        const body = await readJson(req)
        const code = String(body?.code ?? '').trim()
        const entry = pairings.get(code)
        const requestedDeviceId = String(body?.deviceId ?? '').toLowerCase()
        const persistentDeviceId = validateDeviceId(requestedDeviceId) && store.verifyPersistentCode(requestedDeviceId, code)
          ? requestedDeviceId
          : undefined
        if ((entry === undefined || entry.expires < Date.now()) && persistentDeviceId === undefined) {
          pairings.delete(code)
          return json(401, { ok: false, error: '配对码无效或已过期' })
        }
        if (entry !== undefined) pairings.delete(code)
        const deviceId = entry?.deviceId ?? persistentDeviceId
        const phoneToken = store.issuePhoneToken(deviceId)
        if (phoneToken === undefined) return json(404, { ok: false, error: 'device not registered' })
        return json(200, { ok: true, deviceId, phoneToken })
      }
      // Login page: GET shows the form, POST redeems a code (or admin key).
      if (url.pathname === '/login') {
        const host = String(req.headers.host ?? '')
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(loginPage(url.searchParams.get('next'), undefined, url.searchParams.get('code')))
          return
        }
        if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) break
          }
          const fields = new URLSearchParams(body)
          const next = typeof fields.get('next') === 'string' && fields.get('next').startsWith('/')
            ? fields.get('next')
            : '/'
          const token = String(fields.get('token') ?? '').trim()
          // 1) pairing code -> phone token bound to its device
          const pairing = pairings.get(token)
          if (pairing !== undefined && pairing.expires >= Date.now()) {
            pairings.delete(token)
            const phoneToken = store.issuePhoneToken(pairing.deviceId)
            if (phoneToken !== undefined) {
              res.writeHead(302, {
                location: next,
                'set-cookie': `relay_token=${encodeURIComponent(phoneToken)}; Domain=${cookieDomain(host)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
                'content-type': 'text/plain; charset=utf-8',
              })
              res.end('ok\n')
              return
            }
          }
          // 2) persistent user pairing code. A device subdomain identifies the
          // target device so the same code is never searched globally here.
          const hostname = String(req.headers.host ?? '').split(':')[0].toLowerCase()
          const deviceId = hostname.match(/^([a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9]))\./)?.[1]
          if (deviceId !== undefined && store.verifyPersistentCode(deviceId, token)) {
            const phoneToken = store.issuePhoneToken(deviceId)
            if (phoneToken !== undefined) {
              res.writeHead(302, {
                location: next,
                'set-cookie': `relay_token=${encodeURIComponent(phoneToken)}; Domain=${cookieDomain(host)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
                'content-type': 'text/plain; charset=utf-8',
              })
              res.end('ok\n')
              return
            }
          }
          // 3) admin key fallback (legacy prototype deployments)
          if (isAdmin(token)) {
            res.writeHead(302, {
              location: next,
              'set-cookie': `relay_token=${encodeURIComponent(secret)}; Domain=${cookieDomain(host)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
              'content-type': 'text/plain; charset=utf-8',
            })
            res.end('ok\n')
            return
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(loginPage(next, '配对码不正确或已过期'))
          return
        }
      }
      // Agent-only: issue a pairing code for the calling device.
      if (url.pathname === '/pairing') {
        if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
        const body = await readJson(req)
        const deviceId = String(body?.deviceId ?? '').toLowerCase()
        if (!validateDeviceId(deviceId) || !store.has(deviceId) || !agentAuthorized(req, deviceId)) {
          return json(401, { ok: false, error: 'device not authorized' })
        }
        let code = String(randomInt(0, 1000000)).padStart(6, '0')
        while (pairings.has(code)) code = String(randomInt(0, 1000000)).padStart(6, '0')
        pairings.set(code, { deviceId, expires: Date.now() + PAIRING_TTL_MS })
        return json(200, { ok: true, code, deviceId, expiresInSec: PAIRING_TTL_MS / 1000 })
      }
      // Agent-only: set or clear a long-lived user pairing code. The server
      // stores only a SHA-256 hash; clearing it never revokes existing phones.
      if (url.pathname === '/persistent-pairing') {
        if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
        const body = await readJson(req)
        const deviceId = String(body?.deviceId ?? '').toLowerCase()
        const code = typeof body?.code === 'string' ? body.code.trim() : ''
        if (!validateDeviceId(deviceId) || !store.has(deviceId) || !agentAuthorized(req, deviceId)) {
          return json(401, { ok: false, error: 'device not authorized' })
        }
        if (code === '') {
          store.clearPersistentCode(deviceId)
          return json(200, { ok: true, deviceId, enabled: false })
        }
        if (code.length < 6 || code.length > 64) return json(400, { ok: false, error: '长期配对码长度需为 6 至 64 位' })
        store.setPersistentCode(deviceId, code)
        return json(200, { ok: true, deviceId, enabled: true })
      }
      // Everything below addresses one device and needs device-scoped auth.
      const target = resolveTarget(req, url)
      if (target === undefined) {
        // Bare relay root (no device addressed): show the public info page.
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-desktop-relay: open https://<deviceId>.<this-host>/ from your phone.\n')
          return
        }
        return json(404, { ok: false, error: 'unknown device route' })
      }
      if (!phoneAuthorized(req, target.deviceId)) {
        const acceptsHtml = String(req.headers.accept ?? '').includes('text/html')
        if (acceptsHtml) {
          // Carry a scanned ?code=<pairing code> through to the login form so
          // the phone QR flow pre-fills it instead of dropping it in `next`.
          const codeParam = url.searchParams.get('code')
          const loginQuery = `next=${encodeURIComponent(`${url.pathname}${url.search}`)}` +
            (codeParam !== null ? `&code=${encodeURIComponent(codeParam)}` : '')
          res.writeHead(302, { location: `/login?${loginQuery}` })
          res.end()
          return
        }
        unauthorized(res)
        return
      }
      // Status endpoint: /d/<deviceId>/status or /status on the device subdomain.
      const statusMatch = url.pathname.match(/^\/d\/([^/]+)\/status$/)
      const subdomain = String(req.headers.host ?? '').split(':')[0].toLowerCase()
      const subdomainId = subdomain.match(/^([a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9]))\./)?.[1]
      if (statusMatch !== null || (url.pathname === '/status' && subdomainId === target.deviceId)) {
        return json(200, registry.snapshot(target.deviceId))
      }
      const entry = registry.lookup(target.deviceId)
      if (entry === undefined) {
        return json(503, { ok: false, error: 'device offline', deviceId: target.deviceId })
      }
      const sessionKey = viewerSessionKey(req)
      if (!entry.acquireViewer(sessionKey, registry.maxConcurrentViewers)) {
        return json(429, { ok: false, error: 'concurrent_limit_reached', message: '当前同时连接设备数已达上限', limit: registry.maxConcurrentViewers, retryAfter: 30 })
      }
      entry.touchViewer(sessionKey)
      // Read the request body (bounded) and forward as one req frame.
      let body = null
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_REQUEST_BODY) {
          return json(413, { ok: false, error: 'request body too large' })
        }
        chunks.push(chunk)
      }
      if (chunks.length > 0) body = bytesToBase64(Buffer.concat(chunks))
      const id = nextId++
      const exchange = new HttpExchange(entry, id, res)
      entry.ws.send(encodeFrame({
        type: 'req',
        id,
        method: req.method ?? 'GET',
        path: target.path + target.query,
        headers: forwardRequestHeaders(req.headers),
        body,
      }))
      void exchange
    } catch (error) {
      if (!res.headersSent) {
        json(500, { ok: false, error: String(error?.message ?? error) })
      } else {
        res.destroy()
      }
    }
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    try {
      // Agent registration: /agent?deviceId=<id>, device-secret authenticated.
      if (url.pathname === '/agent') {
        const deviceId = String(url.searchParams.get('deviceId') ?? '').toLowerCase()
        if (!validateDeviceId(deviceId)) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        if (!agentAuthorized(req, deviceId)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const entry = registry.attach(deviceId, ws)
          ws.on('message', (raw) => {
            try {
              const frame = decodeFrame(raw.toString())
              entry.lastSeen = Date.now()
              deliverAgentFrame(entry, frame)
            } catch (error) {
              ws.close(1008, String(error?.message ?? error).slice(0, 120))
            }
          })
          ws.on('close', () => registry.detach(ws))
          ws.on('error', () => {})
        })
        return
      }
      // Phone WS bridge: any path except /agent, addressed to a device either
      // via Host subdomain or the /d/<deviceId>/ prefix. The path rides the
      // ws-open frame verbatim (dsh connects /api/events.mux etc.).
      const target = resolveTarget(req, url)
      if (target === undefined) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!phoneAuthorized(req, target.deviceId)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const entry = registry.lookup(target.deviceId)
      if (entry === undefined) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const sessionKey = viewerSessionKey(req)
      if (!entry.acquireViewer(sessionKey, registry.maxConcurrentViewers)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (phoneWs) => {
        const id = nextId++
        const stream = new WsStream(entry, id, phoneWs, target.path + target.query)
        phoneWs.on('message', (data, isBinary) => stream.fromPhone(data, isBinary))
        phoneWs.on('message', () => entry.touchViewer(sessionKey))
        phoneWs.on('close', (code, reason) => stream.phoneClosed(code, reason.toString()))
        phoneWs.on('error', () => stream.abort('phone socket error'))
      })
    } catch (error) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  server.listen(port, host)
  await once(server, 'listening')
  const actual = server.address().port
  console.log(`[dsh-desktop-relay] listening on ${host}:${actual} (${registry.devices.size} devices, ${store.count} registered)`)
  return {
    get port() {
      return server.address().port
    },
    registry,
    store,
    close: () => {
      clearInterval(pairingSweep)
      registry.close()
      for (const entry of registry.devices.values()) {
        try {
          entry.ws.close(1001, 'relay shutting down')
        } catch {
          // ignore
        }
      }
      wss.close()
      server.close()
    },
  }
}

// CLI entry: node index.js [--port 8080] [--host 127.0.0.1]
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const idx = args.indexOf(name)
    return idx === -1 ? fallback : args[idx + 1]
  }
  startRelay({
    port: Number(flag('--port', '8080')),
    host: flag('--host', '127.0.0.1'),
    secretFile: flag('--secret-file', process.env.RELAY_SECRET_FILE),
  })
}
