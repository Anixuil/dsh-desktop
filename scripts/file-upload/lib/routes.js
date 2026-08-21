// dsh-desktop-file-upload — same-origin /file-upload routes.
//
// The web client reads a picked file as base64 and POSTs it here; the route
// decodes, enforces the byte cap, persists it through the store, and returns
// the `[File #N "<name>" auto-saved to ...]` hint the client shows as a card.
// A companion GET /file-upload/open?path=… opens a stored file with the OS
// default application (validated to stay inside the store dir). Same-origin
// only (no CORS, no extra port), mirroring the bridge's /desktop routes and
// the vision plugin's /vision-any routes.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { saveFile, TMP_DIR } from './store.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024
// base64 inflates ~4/3, so the body cap sits above the file cap.
const MAX_BODY_BYTES = 15 * 1024 * 1024

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function badRequest(res, message) {
  return json(res, 400, { ok: false, error: { code: 'bad-request', message } })
}

async function readJsonBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Open one Windows path with its registered desktop application. */
function openPath(path) {
  return new Promise((resolvePromise, reject) => {
    const literal = `'${path.replace(/'/g, "''")}'`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath ${literal}`], { windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`open exited with code ${code}`))))
  })
}

/** Whether a resolved path stays inside the file store (no traversal). */
function isInsideStore(path) {
  const store = resolve(TMP_DIR)
  const target = resolve(path)
  return target === store || target.startsWith(store + sep)
}

function handleOpen(url, res) {
  const path = url.searchParams.get('path') ?? ''
  if (path === '') return badRequest(res, 'missing "path" query parameter')
  if (!isInsideStore(path)) {
    return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'path is outside the file store' } })
  }
  if (!existsSync(path)) {
    return json(res, 404, { ok: false, error: { code: 'not-found', message: 'file no longer stored' } })
  }
  openPath(path).then(
    () => json(res, 200, { ok: true, opened: true }),
    (error) => json(res, 500, { ok: false, error: { code: 'open-failed', message: error instanceof Error ? error.message : String(error) } }),
  )
}

export function registerFileUploadRoutes(ctx) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: '/file-upload',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname
        if (pathname === '/file-upload/open') {
          return handleOpen(url, res)
        }
        if (pathname !== '/file-upload') {
          return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
        }
        if (req.method !== 'POST') {
          return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
        }
        let body
        try {
          body = await readJsonBody(req, MAX_BODY_BYTES)
        } catch (error) {
          return badRequest(res, error instanceof Error ? error.message : String(error))
        }
        const name = typeof body?.name === 'string' ? body.name : ''
        const data = typeof body?.data === 'string' ? body.data : ''
        if (data.length === 0) {
          return badRequest(res, 'body must carry a non-empty "data" (base64) field')
        }
        let buffer
        try {
          buffer = Buffer.from(data, 'base64')
        } catch {
          return badRequest(res, '"data" is not valid base64')
        }
        if (buffer.length === 0) {
          return badRequest(res, '"data" decodes to empty')
        }
        if (buffer.length > MAX_FILE_BYTES) {
          return json(res, 413, {
            ok: false,
            error: { code: 'too-large', message: `file too large (max ${MAX_FILE_BYTES} bytes)` },
          })
        }
        const saved = saveFile(buffer, name)
        if (saved === null) {
          return badRequest(res, 'could not store the uploaded file')
        }
        return json(res, 200, { ok: true, hint: saved.hint, name: saved.name, path: saved.filePath, bytes: buffer.length })
      },
    }), 'dsh-desktop-file-upload: routes')
  })
}
