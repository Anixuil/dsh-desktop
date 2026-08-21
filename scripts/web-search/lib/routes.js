import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { searchCustom } from './search.js'
import { validateConfig } from './config.js'

const MAX_BODY_BYTES = 64 * 1024
const TEST_QUERY = 'DeepSeek Harness official website'
const CONFIG_FIELDS = [
  'customProvider',
  'customBaseURL',
  'customApiKeyEnv',
  'nativeEnabled',
  'deepseekFallback',
  'sourceTimeoutMs',
]

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

function testConfig(current, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return current
  const next = { ...current }
  for (const field of CONFIG_FIELDS) {
    if (Object.hasOwn(value, field)) next[field] = value[field]
  }
  validateConfig(next)
  return next
}

function currentModelRoute(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = typeof sessionId === 'string' && sessionId.length > 0 ? agents?.get(sessionId) : undefined
  const logged = agent?.session?.requestHeader?.()?.config
  if (logged?.provider && logged?.model) return { provider: logged.provider, model: logged.model }
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (fallback?.provider && fallback?.model) return { provider: fallback.provider, model: fallback.model }
  return undefined
}

function testFailure(res, error, startedAt, details = {}) {
  return json(res, 502, {
    ok: false,
    error: {
      code: error?.code ?? 'test-failed',
      message: String(error?.message ?? error),
      details: { ...details, elapsedMs: Date.now() - startedAt },
    },
  })
}

export function registerSearchRoutes(ctx, namespace, handle, getConfig, provider) {
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
        if ((pathname === '/desktop-web-search/test' || pathname === '/desktop-web-search/test/custom') && req.method === 'POST') {
          let body
          try { body = await readJsonBody(req) } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
          }
          let config
          try { config = testConfig(getConfig(), body.config) } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'settings-rejected', message: String(error?.message ?? error) } })
          }
          if (config.customProvider === 'none') {
            return json(res, 400, { ok: false, error: { code: 'custom-disabled', message: 'custom search is disabled' } })
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.sourceTimeoutMs)
          const startedAt = Date.now()
          try {
            const result = await searchCustom(
              ctx,
              config,
              { query: TEST_QUERY, maxResults: 3 },
              controller.signal,
              { apiKey: body.apiKey },
            )
            return json(res, 200, {
              ok: true,
              value: {
                source: `custom/${config.customProvider}`,
                count: result.sources.length,
                sources: result.sources,
                elapsedMs: Date.now() - startedAt,
              },
            })
          } catch (error) {
            return testFailure(res, error, startedAt, { source: `custom/${config.customProvider}` })
          } finally {
            clearTimeout(timer)
          }
        }
        if (pathname === '/desktop-web-search/test/native' && req.method === 'POST') {
          let body
          try { body = await readJsonBody(req) } catch (error) {
            return json(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
          }
          const route = currentModelRoute(ctx, body.sessionId)
          if (!route) {
            return json(res, 400, {
              ok: false,
              error: { code: 'model-unavailable', message: 'no current provider/model is available for testing' },
            })
          }
          const config = getConfig()
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.sourceTimeoutMs)
          const startedAt = Date.now()
          try {
            const result = await provider.searchCurrentModel(
              { query: TEST_QUERY, maxResults: 3 },
              controller.signal,
              route,
            )
            return json(res, 200, {
              ok: true,
              value: {
                source: 'model-native',
                provider: route.provider,
                model: route.model,
                count: result.sources.length,
                sources: result.sources,
                elapsedMs: Date.now() - startedAt,
              },
            })
          } catch (error) {
            return testFailure(res, error, startedAt, route)
          } finally {
            clearTimeout(timer)
          }
        }
        return json(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
      },
    }), 'dsh-desktop-web-search: routes')
  })
}
