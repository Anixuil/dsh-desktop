// dsh-desktop-relay-client — product agent: the PC side of the relay protocol.
//
// The shell spawns this as a companion process next to dsh web. It connects
// out to the public relay, answers req frames with a local fetch whose
// response streams straight back as res/chunk/end frames, and bridges ws-open
// frames to the local dsh upgrade endpoint (/api/events.mux etc.).
//
// It also serves a tiny loopback status endpoint (GET /ping, default port
// 38659) so the shell can report online/offline without parsing logs.
//
// Configuration arrives via environment (injected by the shell):
//   RELAY_URL    wss://remote.example.com
//   RELAY_SECRET shared deployment secret
//   DEVICE_ID    [a-z0-9_-]{1,63} — phone entry https://<DEVICE_ID>.<host>/
//   LOCAL_PORT   dsh web port (default 3080)
//   STATUS_PORT  loopback status port (default 38659, 0 = OS-assigned)
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { encodeFrame, decodeFrame, bytesToBase64, base64ToBytes, validateDeviceId } from './lib/frames.js'

/** Response headers worth forwarding verbatim from the local dsh to the phone. */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'set-cookie',
  'location',
  'www-authenticate',
])

/** Request headers worth forwarding from the phone to the local dsh. */
const REQUEST_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'cookie',
  'user-agent',
  'x-requested-with',
])

const log = (...args) => console.log(new Date().toISOString(), ...args)

/**
 * Start the product agent.
 * @returns { statusPort, close, isOnline } (resolves once the status listener is up).
 */
export async function startRelayClient({
  relayUrl,
  secret,
  deviceId,
  localPort = 3080,
  statusPort = 38659,
  heartbeatInterval = 15_000,
} = {}) {
  if (!/^wss?:\/\//.test(relayUrl ?? '')) throw new Error('relayUrl must be a ws(s):// URL')
  if (!secret || secret.length < 8) throw new Error('secret must be at least 8 characters')
  if (!validateDeviceId(deviceId ?? '')) throw new Error('deviceId must match [a-z0-9_-] (see lib/frames.js)')
  const localBase = `http://127.0.0.1:${localPort}`

  const state = { online: false, connectedAt: null, lastError: null }
  const bridges = new Map()
  let agentWs = undefined
  let reconnectTimer = undefined
  let heartbeatTimer = undefined
  let closed = false

  // Proactive heartbeat: while connected, re-ping the relay at a steady
  // cadence so its liveness window never expires. The relay refreshes its
  // "last seen" on ANY frame it receives from the agent and tolerates
  // unsolicited pongs (pong is a legal agent frame), so a periodic pong keeps
  // a healthy agent alive even when the relay's own ping scheduling is sparse
  // or misaligned. Without this, an idle agent is dropped with 4001 "heartbeat
  // timeout" and reconnects forever (device offline more than online). Must be
  // well below the relay's idleTimeout (production default 35 s).
  const heartbeatMs = Number.isFinite(heartbeatInterval) && heartbeatInterval > 0 ? heartbeatInterval : 15_000

  const statusServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      name: 'dsh-desktop-relay-client',
      version: '0.1.0',
      online: state.online,
      deviceId,
      connectedAt: state.connectedAt,
      lastError: state.lastError,
    }))
  })
  statusServer.listen(statusPort, '127.0.0.1')
  await once(statusServer, 'listening')
  const actualStatusPort = statusServer.address().port

  /** Forward one phone HTTP request to the local dsh and stream the answer back. */
  async function answerRequest(frame) {
    const { id, method, path, headers, body } = frame
    try {
      const res = await fetch(`${localBase}${path}`, {
        method: method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries(headers ?? {}).filter(([name]) => REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())),
        ),
        body: body === null || body === undefined ? undefined : base64ToBytes(body),
        redirect: 'manual',
      })
      const head = {
        type: 'res',
        id,
        status: res.status,
        headers: Object.fromEntries(
          [...res.headers.entries()].filter(([name]) => RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())),
        ),
      }
      agentWs.send(encodeFrame(head))
      if (res.body === null) {
        agentWs.send(encodeFrame({ type: 'end', id }))
        return
      }
      for await (const chunk of res.body) {
        agentWs.send(encodeFrame({ type: 'chunk', id, data: bytesToBase64(Buffer.from(chunk)) }))
      }
      agentWs.send(encodeFrame({ type: 'end', id }))
    } catch (error) {
      agentWs.send(encodeFrame({ type: 'err', id, message: String(error?.message ?? error) }))
    }
  }

  /** Bridge a phone WS stream to the local dsh upgrade endpoint. */
  function bridgeWs(frame) {
    const { id, path } = frame
    const local = new WebSocket(`ws://127.0.0.1:${localPort}${path}`)
    /** Guard against in-flight data after the bridge was cleaned up. */
    const hasBridge = () => bridges.has(id) && agentWs?.readyState === WebSocket.OPEN
    const wire = (data, isBinary) => {
      if (!hasBridge()) return
      agentWs.send(encodeFrame({ type: 'ws-data', id, data: bytesToBase64(data), binary: isBinary === true }))
    }
    local.on('open', () => agentWs.send(encodeFrame({ type: 'ws-ready', id })))
    local.on('message', (data, isBinary) => wire(data, isBinary))
    local.on('error', () => {})
    local.on('close', (code, reason) => {
      if (!bridges.has(id)) return // already cleaned up by a relay ws-close frame
      bridges.delete(id)
      if (hasBridge()) {
        agentWs.send(encodeFrame({ type: 'ws-close', id, code, reason: reason.toString() }))
      }
    })
    bridges.set(id, local)
  }

  function connect() {
    if (closed) return
    log(`connecting to ${relayUrl}/agent?deviceId=${deviceId} ...`)
    const ws = new WebSocket(`${relayUrl}/agent?deviceId=${deviceId}`, {
      headers: { authorization: `Bearer ${secret}` },
    })
    agentWs = ws
    ws.on('open', () => {
      state.online = true
      state.connectedAt = Date.now()
      state.lastError = null
      log('agent online')
    })
    ws.on('message', (raw) => {
      let frame
      try {
        frame = decodeFrame(raw.toString())
      } catch (error) {
        log('bad relay frame:', String(error?.message ?? error))
        return
      }
      if (frame.type === 'ping') return ws.send(encodeFrame({ type: 'pong' }))
      if (frame.type === 'req') return void answerRequest(frame)
      if (frame.type === 'ws-open') return bridgeWs(frame)
      if (frame.type === 'ws-close') {
        const local = bridges.get(frame.id)
        bridges.delete(frame.id)
        if (local !== undefined) {
          try {
            local.close()
          } catch {
            local.terminate()
          }
        }
      }
    })
    ws.on('close', (code, reason) => {
      if (state.online || state.connectedAt !== null) log(`relay closed (${code} ${reason.toString()})`)
      state.online = false
      if (closed) return
      const delay = code === 4000 ? 15_000 : 5_000
      reconnectTimer = setTimeout(connect, delay)
    })
    ws.on('error', (error) => {
      state.lastError = String(error?.message ?? error)
      log('relay socket error:', state.lastError)
    })
  }

  connect()

  // Feed the relay's liveness window with proactive pongs while connected.
  // This runs across reconnect gaps (it only sends when the socket is open).
  heartbeatTimer = setInterval(() => {
    if (agentWs?.readyState === WebSocket.OPEN) {
      try {
        agentWs.send(encodeFrame({ type: 'pong' }))
      } catch {
        // socket teardown race; the close handler schedules the next connect
      }
    }
  }, heartbeatMs)
  heartbeatTimer.unref?.()

  return {
    get statusPort() {
      return actualStatusPort
    },
    isOnline: () => state.online,
    close: () => {
      closed = true
      clearTimeout(reconnectTimer)
      clearInterval(heartbeatTimer)
      for (const local of bridges.values()) {
        try {
          local.close()
        } catch {
          local.terminate()
        }
      }
      try {
        agentWs?.close(1000, 'client shutting down')
      } catch {
        agentWs?.terminate()
      }
      statusServer.close()
    },
  }
}

// CLI entry (spawned by the shell): node index.js
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const client = await startRelayClient({
    relayUrl: process.env.RELAY_URL,
    secret: process.env.RELAY_SECRET,
    deviceId: String(process.env.DEVICE_ID ?? '').toLowerCase(),
    localPort: Number(process.env.LOCAL_PORT ?? 3080),
    statusPort: Number(process.env.STATUS_PORT ?? 38659),
  }).catch((error) => {
    console.error(`[relay-client] failed to start: ${error?.message ?? error}`)
    process.exit(1)
  })
  console.log(`[relay-client] status listener on 127.0.0.1:${client.statusPort}`)
}
