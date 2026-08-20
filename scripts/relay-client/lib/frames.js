// dsh-desktop-relay-client — frame protocol constants and validation.
//
// Mirror of scripts/relay/lib/frames.js; keep both files in sync. The relay
// (server) and this client ship as separate deployable units, so each carries
// its own copy of the wire contract.
//
// Frame ids are relay-assigned monotonically increasing integers and scope
// one pending HTTP exchange or one bridged WS stream.

/** Frames the agent may send to the relay. */
export const AGENT_FRAMES = new Set([
  'pong', // heartbeat reply
  'res', // {id, status, headers, body: base64|null} — complete HTTP response
  'chunk', // {id, data: base64} — streaming HTTP response fragment
  'end', // {id} — streaming HTTP response finished
  'err', // {id, message} — local request failed (relay answers 502)
  'ws-ready', // {id} — local WS upgrade succeeded, start piping
  'ws-data', // {id, data: base64, binary} — local WS -> phone
  'ws-close', // {id, code, reason} — local WS closed
])

/** Frames the relay may send to the agent. */
export const RELAY_FRAMES = new Set([
  'ping', // heartbeat request
  'req', // {id, method, path, headers, body: base64|null}
  'ws-open', // {id, path} — phone wants a WS stream; upgrade 127.0.0.1:3080 at path and ws-ready
  'ws-data', // {id, data: base64, binary} — phone -> local WS
  'ws-close', // {id, code, reason} — phone closed its WS
])

/** Device ids appear in hostnames and URLs; keep them DNS-safe and bounded. */
export function validateDeviceId(id) {
  if (typeof id !== 'string') return false
  return /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(id)
}

/** Parse one WS text message into a frame object, rejecting malformed input. */
export function decodeFrame(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) {
    throw new Error('frame must be a string under 2 MiB')
  }
  let frame
  try {
    frame = JSON.parse(raw)
  } catch {
    throw new Error('frame is not valid JSON')
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('frame must be a JSON object')
  }
  if (typeof frame.type !== 'string' || frame.type.length === 0 || frame.type.length > 32) {
    throw new Error('frame type missing or invalid')
  }
  if (!AGENT_FRAMES.has(frame.type) && !RELAY_FRAMES.has(frame.type)) {
    throw new Error(`unknown frame type ${JSON.stringify(frame.type)}`)
  }
  if (frame.id !== undefined && (!Number.isSafeInteger(frame.id) || frame.id < 0)) {
    throw new Error('frame id must be a non-negative safe integer')
  }
  return frame
}

/** Encode a frame object as one wire line. */
export function encodeFrame(frame) {
  return JSON.stringify(frame)
}

/** Base64 round-trip helpers; JSON frames cannot carry raw bytes. */
export function bytesToBase64(buf) {
  return Buffer.from(buf).toString('base64')
}

export function base64ToBytes(text) {
  const buf = Buffer.from(text ?? '', 'base64')
  if (buf.length === 0 && (text ?? '').length > 0 && !/^=*$/.test(text)) {
    throw new Error('invalid base64 payload')
  }
  return buf
}
