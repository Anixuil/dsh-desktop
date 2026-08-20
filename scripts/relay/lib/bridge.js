// dsh-desktop-relay — HTTP and WS bridges between a phone and one agent.
//
// HTTP: the phone's request becomes a `req` frame; the agent answers with
// `res` (headers + body, streamed straight to the phone) and `chunk`/`end`
// fragments, so long-running or SSE-style responses flow in real time.
//
// WS: the phone's upgrade becomes a `ws-open` frame; the agent opens its own
// WS to the local dsh and confirms with `ws-ready`, after which relay pipes
// `ws-data` frames in both directions until either side closes.
import { bytesToBase64, base64ToBytes, encodeFrame } from './frames.js'

/** Response headers worth forwarding verbatim from the agent to the phone. */
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

/** Request headers worth forwarding from the phone to the agent. */
const REQUEST_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'cookie',
  'user-agent',
  'x-requested-with',
])

export function forwardRequestHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) out[name] = value
  }
  return out
}

export function forwardResponseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) out[name] = value
  }
  return out
}

/** One in-flight HTTP forward: req frame out, res/chunk/end frames back. */
export class HttpExchange {
  constructor(entry, id, res, { timeoutMs = 60_000 } = {}) {
    this.entry = entry
    this.id = id
    this.res = res
    this.headSent = false
    this.done = false
    this.timer = setTimeout(() => this.fail('agent response timeout'), timeoutMs)
    this.timer.unref?.()
    entry.pendingHttp.set(id, this)
  }

  /** Agent answered completely (res frame). */
  complete(frame) {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.entry.pendingHttp.delete(this.id)
    const status = Number.isInteger(frame.status) ? frame.status : 500
    const headers = { ...forwardResponseHeaders(frame.headers) }
    if (!('content-length' in headers) && frame.body !== undefined) {
      headers['content-length'] = String(base64ToBytes(frame.body).length)
    }
    if (!this.headSent) {
      this.headSent = true
      this.res.writeHead(status, headers)
    }
    if (frame.body !== undefined && frame.body !== null) this.res.end(base64ToBytes(frame.body))
    else this.res.end()
  }

  /** Streaming response started (res frame with no body = head only). */
  beginHead(frame) {
    if (this.done) return
    this.headSent = true
    const status = Number.isInteger(frame.status) ? frame.status : 500
    this.res.writeHead(status, forwardResponseHeaders(frame.headers))
  }

  /** Streaming fragment. */
  chunk(frame) {
    if (this.done) return
    if (!this.headSent) {
      this.headSent = true
      this.res.writeHead(200, { 'content-type': 'application/octet-stream' })
    }
    this.res.write(base64ToBytes(frame.data))
  }

  /** Streaming response finished. */
  finish() {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.entry.pendingHttp.delete(this.id)
    this.res.end()
  }

  /** Agent reported a local failure: answer 502 unless bytes already flowed. */
  error(message) {
    if (this.done) return
    if (this.headSent) {
      this.res.destroy()
      this.finish()
      return
    }
    this.done = true
    clearTimeout(this.timer)
    this.entry.pendingHttp.delete(this.id)
    this.res.writeHead(502, { 'content-type': 'application/json' })
    this.res.end(JSON.stringify({ ok: false, error: 'agent-side request failed', details: String(message ?? '') }))
  }

  /** Give up: agent disconnected or timed out. */
  fail(reason) {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.entry.pendingHttp.delete(this.id)
    if (!this.headSent) {
      this.res.writeHead(502, { 'content-type': 'application/json' })
      this.res.end(JSON.stringify({ ok: false, error: String(reason) }))
    } else {
      this.res.destroy()
    }
  }
}

/** One bridged phone WS: ws-open/ws-ready handshake, then bidirectional pipe. */
export class WsStream {
  constructor(entry, id, phoneWs, path, { readyTimeoutMs = 15_000, maxBufferBytes = 256 * 1024 } = {}) {
    this.entry = entry
    this.id = id
    this.phoneWs = phoneWs
    this.ready = false
    this.closed = false
    this.bufferedBytes = 0
    this.buffer = []
    this.timer = setTimeout(() => this.abort('agent ws-ready timeout'), readyTimeoutMs)
    this.timer.unref?.()
    entry.pendingWs.set(id, this)
    entry.ws.send(encodeFrame({ type: 'ws-open', id, path }))
  }

  /** Phone sent a message: pipe now, or queue until the agent is ready. */
  fromPhone(data, isBinary) {
    if (this.closed) return
    const payload = { type: 'ws-data', id: this.id, data: bytesToBase64(data), binary: isBinary === true }
    if (this.ready) {
      this.entry.ws.send(encodeFrame(payload))
      return
    }
    const size = Buffer.byteLength(data)
    if (this.bufferedBytes + size > 256 * 1024) {
      this.abort('phone flooded before agent ready')
      return
    }
    this.bufferedBytes += size
    this.buffer.push(payload)
  }

  /** Agent confirmed its local WS: flush the queue and clear the handshake timer. */
  markReady() {
    if (this.closed) return
    this.ready = true
    clearTimeout(this.timer)
    for (const payload of this.buffer) this.entry.ws.send(encodeFrame(payload))
    this.buffer = []
    this.bufferedBytes = 0
  }

  /** Agent forwarded a message from the local dsh WS. */
  fromAgent(frame) {
    if (this.closed) return
    const payload = base64ToBytes(frame.data)
    if (this.phoneWs.readyState === this.phoneWs.OPEN) {
      this.phoneWs.send(frame.binary === true ? payload : payload.toString('utf8'))
    }
  }

  /** Agent's local WS closed: mirror the closure to the phone. */
  agentClosed(frame) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.entry.pendingWs.delete(this.id)
    const code = Number.isInteger(frame.code) ? frame.code : 1000
    try {
      this.phoneWs.close(code, typeof frame.reason === 'string' ? frame.reason.slice(0, 120) : undefined)
    } catch {
      this.phoneWs.terminate()
    }
  }

  /** Phone closed: tell the agent to close its local WS. */
  phoneClosed(code, reason) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.entry.pendingWs.delete(this.id)
    this.entry.ws.send(encodeFrame({ type: 'ws-close', id: this.id, code, reason: reason ?? '' }))
  }

  /** Give up on the stream (agent lost or handshake timed out). */
  abort(reason) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.entry.pendingWs.delete(this.id)
    try {
      this.phoneWs.close(1011, String(reason).slice(0, 120))
    } catch {
      this.phoneWs.terminate()
    }
  }
}
