import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { searchCustom } from './search.js'

const MAX_BODY_BYTES = 64 * 1024

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function viewOf(service, namespace) {
  const descriptor = service.describe({ redactSecrets: true }).find((item) => item.ns === namespace)
  if (!descriptor) return undefined
  return {
    ns: descriptor.ns,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    revision: descriptor.revision,
    applies: descriptor.applies,
  }
}

async function credentialInfo(ctx, ref) {
  try {
    return await ctx.get('credentials')?.describe(credentialRef(ref)) ?? { configured: false, writable: false }
  } catch {
    return { configured: false, writable: false }
  }
}

async function settingsPayload(ctx, namespace, handle) {
  const current = handle()
  if (!current) return undefined
  const view = viewOf(current.service, namespace)
  if (!view) return undefined
  const ref = view.value?.customApiKeyEnv || 'DSH_WEB_SEARCH_API_KEY'
  return {
    writable: current.service.writable !== false,
    view,
    credential: await credentialInfo(ctx, ref),
  }
}

export function registerSearchRoutes(ctx, namespace, handle, getConfig) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: '/desktop-web-search',
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/desktop-web-search/settings' && req.method === 'GET') {
          const payload = await settingsPayload(ctx, namespace, handle)
          return payload
            ? json(res, 200, { ok: true, value: payload })
            : json(res, 503, { ok: false, error: { code: 'unavailable', message: 'search settings are unavailable' } })
        }
        if (pathname === '/desktop-web-search/settings' && req.method === 'POST') {
          let body
          try { body = await readJsonBody(req) } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
          }
          const current = handle()
          if (!current) return json(res, 503, { ok: false, error: { code: 'unavailable', message: 'search settings are unavailable' } })
          if (!Array.isArray(body.ops) || body.ops.length === 0) {
            return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'a non-empty ops array is required' } })
          }
          try {
            await current.service.mutate(namespace, body.ops, body.expectedRevision)
          } catch (error) {
            const conflict = error instanceof SettingsConflictError
            return json(res, conflict ? 409 : 400, {
              ok: false,
              error: { code: conflict ? 'settings-conflict' : 'settings-rejected', message: String(error?.message ?? error) },
            })
          }
          return json(res, 200, { ok: true, value: await settingsPayload(ctx, namespace, handle) })
        }
        if (pathname === '/desktop-web-search/credential' && req.method === 'POST') {
          let body
          try { body = await readJsonBody(req) } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
          }
          const credentials = ctx.get('credentials')
          if (!credentials) return json(res, 503, { ok: false, error: { code: 'unavailable', message: 'credential storage is unavailable' } })
          try {
            const ref = credentialRef(String(body.ref ?? 'DSH_WEB_SEARCH_API_KEY'))
            if (body.clear === true) await credentials.unset(ref)
            else {
              const value = String(body.value ?? '').trim()
              if (!value) throw new Error('API key must not be empty')
              await credentials.set(ref, value)
            }
            return json(res, 200, { ok: true, value: await credentialInfo(ctx, ref) })
          } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'credential-rejected', message: String(error?.message ?? error) } })
          }
        }
        if (pathname === '/desktop-web-search/test' && req.method === 'POST') {
          const config = getConfig()
          if (config.customProvider === 'none') {
            return json(res, 400, { ok: false, error: { code: 'custom-disabled', message: 'custom search is disabled' } })
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.sourceTimeoutMs)
          try {
            const result = await searchCustom(ctx, config, { query: 'DeepSeek Harness', maxResults: 3 }, controller.signal)
            return json(res, 200, { ok: true, value: { count: result.sources.length, sources: result.sources } })
          } catch (error) {
            return json(res, 502, { ok: false, error: { code: error?.code ?? 'test-failed', message: String(error?.message ?? error) } })
          } finally {
            clearTimeout(timer)
          }
        }
        return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
      },
    }), 'dsh-desktop-web-search: routes')
  })
}
