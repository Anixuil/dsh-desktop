// dsh-vision-any — plugin-owned settings + image routes.
//
// The web settings seam keeps an explicit allowlist of namespaces remotely
// readable/writable through the API proxy; a namespace outside it answers
// `settings-not-exposed` even when its owner registered it. This plugin owns
// the `vision-any` namespace, so it exposes its own configuration through a
// same-origin prefix route on the dsh web server — the same pattern the
// desktop bridge uses for its /desktop routes — reading and writing the
// settings service directly (loopback-gated, redacted like the seam's own
// wire views).
//
// The /vision-any/images/{seqDir}/{file} GET route serves the pasted images
// the prompt-admission store saved to the temp dir, so the web client can
// render them inline (click-to-preview) instead of leaving only the hint
// text. Both path segments are strict regexes and the file name is the
// store's own content hash, so no path traversal can reach outside the store.

import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { TMP_DIR } from './store.js'

const MAX_BODY_BYTES = 64 * 1024

// seqDir mirrors the store's `image{seq}` directory layout; fileName mirrors
// its `{16-hex-md5}.{ext}` content-hash names (both written lowercase).
const IMAGE_PATH_RE = /^\/vision-any\/images\/(image\d+)\/([0-9a-f]{16}\.(?:png|jpe?g|webp|gif|bmp))$/i

const IMAGE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/**
 * Map an incoming image-route pathname onto the stored temp file it names.
 * @param pathname - decoded request pathname.
 * @returns `{ seqDir, fileName, filePath }` for a valid image path, else null.
 */
export function resolveImageRequest(pathname) {
  const match = IMAGE_PATH_RE.exec(pathname)
  if (match === null) return null
  const seqDir = match[1].toLowerCase()
  const fileName = match[2].toLowerCase()
  return {
    seqDir,
    fileName,
    filePath: join(TMP_DIR, seqDir, fileName),
  }
}

/**
 * Stream one stored pasted image. Content-addressed names are immutable, so
 * the response caches aggressively; evicted (LRU/age-swept) files answer 404
 * and the client falls back to its placeholder.
 */
export function serveStoredImage(res, pathname) {
  const resolved = resolveImageRequest(pathname)
  if (resolved === null) return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
  let stat
  try {
    stat = statSync(resolved.filePath)
  } catch {
    return json(res, 404, { ok: false, error: { code: 'not-found', message: 'image no longer stored' } })
  }
  if (!stat.isFile()) return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
  const ext = resolved.fileName.slice(resolved.fileName.lastIndexOf('.'))
  res.writeHead(200, {
    'content-type': IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'public, max-age=31536000, immutable',
    'content-disposition': 'inline',
  })
  const stream = createReadStream(resolved.filePath)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {}
  })
  stream.pipe(res)
}

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

function unavailable(res, message) {
  return json(res, 503, { ok: false, error: { code: 'unavailable', message } })
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** The redacted descriptor view one namespace's write response mirrors. */
function viewOf(handle, namespace) {
  const descriptor = handle.service
    .describe({ redactSecrets: true })
    .find((candidate) => candidate.ns === namespace)
  if (descriptor === undefined) return undefined
  return {
    ns: descriptor.ns,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    applies: descriptor.applies,
    secrets: descriptor.secrets,
    revision: descriptor.revision,
  }
}

/**
 * Register GET/POST /vision-any/settings on the dsh web server. Only mounted
 * while a settings service exists; in headless profiles (no web server) the
 * registration is a no-op and the vision tool keeps working from config.
 * @param ctx - plugin context.
 * @param namespace - the `vision-any` settings namespace.
 * @param handle - thunk returning the live `{ service, scope }` pair (null while unavailable).
 */
export function registerSettingsRoutes(ctx, namespace, handle) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: '/vision-any',
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname.startsWith('/vision-any/images/')) {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
          return serveStoredImage(res, pathname)
        }
        if (pathname !== '/vision-any/settings') {
          return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
        }
        const current = handle()
        if (current === null || current.service === undefined) {
          return unavailable(res, 'settings service is unavailable')
        }
        if (req.method === 'GET') {
          const view = viewOf(current, namespace)
          if (view === undefined) {
            return unavailable(res, `settings namespace "${namespace}" is not registered`)
          }
          return json(res, 200, {
            ok: true,
            value: { writable: current.service.writable !== false, view },
          })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return badRequest(res, error instanceof Error ? error.message : String(error))
          }
          const ops = body?.ops
          if (!Array.isArray(ops) || ops.length === 0) {
            return badRequest(res, 'body must carry a non-empty "ops" array of {op,path[,value]} edits')
          }
          for (const op of ops) {
            if (op === null || typeof op !== 'object') {
              return badRequest(res, 'every op must be an object')
            }
            if ((op.op !== 'set' && op.op !== 'unset') || !Array.isArray(op.path)) {
              return badRequest(res, 'every op must be {op:"set"|"unset", path:[...]}')
            }
          }
          try {
            await current.service.mutate(
              namespace,
              ops,
              body.expectedRevision === undefined ? undefined : body.expectedRevision,
            )
          } catch (error) {
            if (error instanceof SettingsConflictError) {
              return json(res, 409, {
                ok: false,
                error: { code: 'settings-conflict', message: error.message },
              })
            }
            return json(res, 400, {
              ok: false,
              error: {
                code: 'settings-rejected',
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
          const view = viewOf(current, namespace)
          if (view === undefined) {
            return unavailable(res, `settings namespace "${namespace}" was disposed after the write`)
          }
          return json(res, 200, { ok: true, value: { writable: current.service.writable !== false, view } })
        }
        return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
      },
    }), 'dsh-vision-any: settings routes')
  })
}
