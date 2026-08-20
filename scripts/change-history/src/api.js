// dsh-desktop-change-history — same-origin HTTP client for the host API.
const { BASE_PATH } = require('./contract.js')

/** Normalized failure carrying the host's stable code (see contract.js). */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code ?? 'error'
  }
}

async function request(path, options) {
  let resp
  try {
    resp = await fetch(`${BASE_PATH}${path}`, {
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      ...options,
    })
  } catch (error) {
    throw new ApiError('network', `无法连接变更历史服务: ${error?.message ?? error}`)
  }
  let payload = null
  try {
    payload = await resp.json()
  } catch {
    /* non-JSON body */
  }
  if (!resp.ok || payload?.ok === false) {
    throw new ApiError(payload?.code ?? 'http', payload?.error ?? `请求失败 (HTTP ${resp.status})`)
  }
  return payload ?? { ok: true }
}

/** @returns {Promise<{ok:boolean, changes:Array}>} */
function listChanges(query) {
  const params = new URLSearchParams()
  if (query?.sessionId) params.set('sessionId', query.sessionId)
  if (query?.limit) params.set('limit', String(query.limit))
  const qs = params.toString()
  return request(`/list${qs ? `?${qs}` : ''}`)
}

/** @returns {Promise<{ok:boolean, change:object|null}>} */
function resolveChange(callId) {
  return request(`/resolve?callId=${encodeURIComponent(callId)}`)
}

/**
 * Read the current on-disk text of a file for the built-in viewer.
 * @returns {Promise<{ok:boolean, path:string, content:string, bytes:number, totalLines:number|null, lang:string|null, truncated:boolean}>}
 */
function readFile(path) {
  return request(`/read?path=${encodeURIComponent(path)}`)
}

/** @returns {Promise<{ok:boolean, reviewed:boolean}>} */
function reviewChange(id, reviewed) {
  return request('/review', { method: 'POST', body: JSON.stringify({ id, reviewed }) })
}

/** @returns {Promise<{ok:boolean, action:string, diverged?:boolean}>} */
function rollbackChange(id) {
  return request('/rollback', { method: 'POST', body: JSON.stringify({ id }) })
}

module.exports = { ApiError, listChanges, resolveChange, readFile, reviewChange, rollbackChange }
