// dsh-desktop-relay — shared-secret bearer authentication.
//
// Prototype scope: one deployment-wide secret (RELAY_SECRET) authenticates
// both the agent (PC) and the phone viewer. Per-device pairing tokens land in
// the pairing milestone; the bearer plumbing stays identical.
import { createHash, timingSafeEqual } from 'node:crypto'

const AUTH_SCHEME = /^bearer\s+(.+)$/i

/** Extract the bearer token from an Authorization header, or undefined. */
export function bearerToken(header) {
  if (typeof header !== 'string') return undefined
  const match = header.match(AUTH_SCHEME)
  return match === null ? undefined : match[1].trim()
}

/** Parse a Cookie header into a name -> value map. */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

/** The relay_token cookie value, or undefined. */
export function cookieToken(header) {
  return parseCookies(header).relay_token
}

/** Constant-time comparison of a presented token against the deployment secret. */
export function secretMatches(presented, secret) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

/** Build the 401 body shown to unauthenticated callers. */
export function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="dsh-relay"',
  })
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
}
