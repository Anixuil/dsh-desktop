// dsh-desktop-session-manager — same-origin HTTP client for the host API.
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
    throw new ApiError('network', `无法连接会话管理服务: ${error?.message ?? error}`)
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

/** @returns {Promise<{ok:boolean, sessions:Array}>} */
function listSessions() {
  return request('/list')
}

/** @returns {Promise<{ok:boolean}>} */
function deleteSession(id) {
  return request('/delete', { method: 'POST', body: JSON.stringify({ id }) })
}

/** @returns {Promise<{ok:boolean}>} */
function unarchiveSession(id) {
  return request('/unarchive', { method: 'POST', body: JSON.stringify({ id }) })
}

module.exports = { ApiError, listSessions, deleteSession, unarchiveSession }
