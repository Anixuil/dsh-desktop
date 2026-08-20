// dsh-desktop-relay — demo agent: the PC side of the relay protocol.
//
// Runs on the PC next to a dsh web instance (127.0.0.1:3080). Connects out
// to the relay, answers req frames with a local fetch whose response streams
// straight back as res/chunk/end frames, and bridges ws-open to the local
// dsh upgrade endpoint (/api/events.mux etc.). This file is the reference
// implementation the product relay-client (Tauri companion process) is built
// from; it already exercises the full wire contract.
//
//   $env:RELAY_URL    = "wss://remote.example.com"
//   $env:RELAY_SECRET = "<安装时生成的 secret>"
//   $env:DEVICE_ID    = "my-pc"          # [a-z0-9_-]，手机访问 https://my-pc.remote.example.com/
//   $env:LOCAL_PORT   = "3080"           # dsh web 端口，默认 3080
//   node agent-demo.mjs
import { WebSocket } from 'ws'
import { encodeFrame, decodeFrame, bytesToBase64, base64ToBytes } from './lib/frames.js'
import { forwardRequestHeaders, forwardResponseHeaders } from './lib/bridge.js'

const relayUrl = process.env.RELAY_URL
const secret = process.env.RELAY_SECRET
const deviceId = String(process.env.DEVICE_ID ?? '').toLowerCase()
const localPort = Number(process.env.LOCAL_PORT ?? 3080)
const localBase = `http://127.0.0.1:${localPort}`

if (!/^wss?:\/\//.test(relayUrl ?? '')) throw new Error('RELAY_URL must be a ws(s):// URL')
if (!secret || secret.length < 8) throw new Error('RELAY_SECRET must be at least 8 characters')
if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(deviceId)) throw new Error('DEVICE_ID must match [a-z0-9_-] (see frames.js)')

const log = (...args) => console.log(new Date().toISOString(), ...args)

/** Forward one phone HTTP request to the local dsh and stream the answer back. */
async function answerRequest(ws, frame) {
  const { id, method, path, headers, body } = frame
  try {
    const res = await fetch(`${localBase}${path}`, {
      method: method ?? 'GET',
      headers: forwardRequestHeaders(headers ?? {}),
      body: body === null || body === undefined ? undefined : base64ToBytes(body),
      redirect: 'manual',
    })
    const head = {
      type: 'res',
      id,
      status: res.status,
      headers: forwardResponseHeaders(Object.fromEntries(res.headers.entries())),
    }
    ws.send(encodeFrame(head))
    if (res.body === null) {
      ws.send(encodeFrame({ type: 'end', id }))
      return
    }
    for await (const chunk of res.body) {
      ws.send(encodeFrame({ type: 'chunk', id, data: bytesToBase64(Buffer.from(chunk)) }))
    }
    ws.send(encodeFrame({ type: 'end', id }))
  } catch (error) {
    ws.send(encodeFrame({ type: 'err', id, message: String(error?.message ?? error) }))
  }
}

/** Bridge a phone WS stream to the local dsh upgrade endpoint. */
function bridgeWs(ws, frame) {
  const { id, path } = frame
  const local = new WebSocket(`ws://127.0.0.1:${localPort}${path}`)
  const wire = (data, isBinary) => {
    if (ws.readyState !== ws.OPEN) return
    ws.send(encodeFrame({ type: 'ws-data', id, data: bytesToBase64(data), binary: isBinary === true }))
  }
  local.on('open', () => ws.send(encodeFrame({ type: 'ws-ready', id })))
  local.on('message', (data, isBinary) => wire(data, isBinary))
  local.on('error', () => {})
  local.on('close', (code, reason) => {
    ws.send(encodeFrame({ type: 'ws-close', id, code, reason: reason.toString() }))
  })
  // Store the local socket on the parent connection keyed by id, so the
  // relay's ws-close frame can tear it down.
  bridges.set(id, local)
}

const bridges = new Map()

function connect() {
  log(`connecting to ${relayUrl}/agent?deviceId=${deviceId} ...`)
  const ws = new WebSocket(`${relayUrl}/agent?deviceId=${deviceId}`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  ws.on('open', () => log('agent online — phone entry: https://' + deviceId + '.' + new URL(relayUrl).host))
  ws.on('message', (raw) => {
    let frame
    try {
      frame = decodeFrame(raw.toString())
    } catch (error) {
      log('bad relay frame:', String(error?.message ?? error))
      return
    }
    if (frame.type === 'ping') return ws.send(encodeFrame({ type: 'pong' }))
    if (frame.type === 'req') return void answerRequest(ws, frame)
    if (frame.type === 'ws-open') return bridgeWs(ws, frame)
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
    log(`relay closed (${code} ${reason.toString()})`)
    if (code === 4000) log('WARNING: 另一处已用相同 DEVICE_ID 连接，本连接被挤下线')
    const delay = code === 4000 ? 15_000 : 5_000
    setTimeout(connect, delay)
  })
  ws.on('error', (error) => log('relay socket error:', error?.message ?? error))
}

connect()
