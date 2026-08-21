import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const packageDir = join(root, 'runtime', 'dsh', 'node_modules', 'dsh-desktop-web-search')
const searchModule = await import(pathToFileURL(join(packageDir, 'lib', 'search.js')))
const providerModule = await import(pathToFileURL(join(packageDir, 'lib', 'provider.js')))
const routesModule = await import(pathToFileURL(join(packageDir, 'lib', 'routes.js')))
const includeModule = await import(pathToFileURL(join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js')))
const runtimeRequire = createRequire(join(root, 'runtime', 'dsh', 'package.json'))
const yaml = runtimeRequire('js-yaml')

const routePatch = yaml.load(readFileSync(join(root, 'scripts', 'web-search.patch.yml'), 'utf8'))
const pluginPatch = yaml.load(readFileSync(join(root, 'scripts', 'bridge.patch.yml'), 'utf8'))
const composed = includeModule.applyEntryPatches(
  [{ id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } }],
  [...routePatch, ...pluginPatch],
  () => {},
)
assert.equal(composed.find((entry) => entry.id === 'web').config.searchProvider, 'desktop-priority')
assert.equal(composed.find((entry) => entry.id === 'dsh-desktop-web-search').name, 'dsh-desktop-web-search')

let clientFactory
const browserWindow = {
  setTimeout,
  __ModuleLoader__: { load: ({ factory }) => { clientFactory = factory } },
}
const clientSandbox = {
  window: browserWindow,
  document: {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    getElementById: () => null,
  },
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(clientSandbox)
const clientSource = readFileSync(join(root, 'scripts', 'web-search', 'client.js'), 'utf8')
vm.runInContext(clientSource, clientSandbox)
const react = runtimeRequire('react')
const client = clientFactory((id) => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return runtimeRequire('react/jsx-runtime')
  return {}
})
assert.equal(typeof client.apply, 'function')
assert.equal(typeof client.views?.WebSearchSection, 'function')
assert.ok(clientSource.includes('`/test/${kind}`'))
assert.ok(clientSource.includes("t('testCustom')"))
assert.ok(clientSource.includes("t('testNative')"))
assert.ok(clientSource.includes('dws_testRow'))

const custom = searchModule.parseCustomResponse({
  answer: 'summary',
  results: [
    { url: 'https://example.com/a', title: 'A', text: 'first' },
    { url: 'https://example.com/a', title: 'duplicate' },
    { link: 'https://example.com/b', name: 'B', description: 'second' },
  ],
})
assert.equal(custom.content, 'summary')
assert.deepEqual(custom.sources.map((source) => source.url), ['https://example.com/a', 'https://example.com/b'])

const openai = searchModule.parseOpenAIResponses({
  output: [
    { type: 'web_search_call', action: { sources: [{ url: 'https://openai.example/source', title: 'Source' }] } },
    { type: 'message', content: [{ type: 'output_text', text: 'Native answer', annotations: [] }] },
  ],
})
assert.equal(openai.content, 'Native answer')
assert.equal(openai.sources[0].url, 'https://openai.example/source')

const anthropic = searchModule.parseAnthropicResponse({
  content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://anthropic.example/source', title: 'Source' }] },
    { type: 'text', text: 'Answer', citations: [{ url: 'https://anthropic.example/source', cited_text: 'Excerpt' }] },
  ],
})
assert.equal(anthropic.sources[0].snippet, 'Excerpt')

const requests = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
  requests.push({ url: req.url, body, authorization: req.headers.authorization })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/test-custom') {
    res.end(JSON.stringify({ results: [{ url: 'https://custom.example/result', title: 'Custom result' }] }))
    return
  }
  if (req.url === '/custom') {
    res.statusCode = 503
    res.end(JSON.stringify({ error: { message: 'custom unavailable' } }))
    return
  }
  if (req.url === '/v1/responses') {
    res.end(JSON.stringify({
      output: [
        { type: 'web_search_call', action: { sources: [{ url: 'https://native.example/result', title: 'Native result' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'native', annotations: [] }] },
      ],
    }))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
const baseURL = `http://127.0.0.1:${port}`

const settings = {
  'llm-pi-ai': {
    providers: {
      current: {
        api: 'openai-responses',
        baseURL: `${baseURL}/v1`,
        apiKeyEnv: 'CURRENT_API_KEY',
      },
      unsupported: {
        api: 'openai-completions',
        baseURL: `${baseURL}/v1`,
        apiKeyEnv: 'UNSUPPORTED_API_KEY',
      },
    },
  },
}
const routeEvents = []
const ctx = {
  get(name) {
    if (name === 'settings') return { get: (ns) => settings[String(ns)] }
    if (name === 'credentials') return { resolve: async () => ({ value: 'test-key', source: 'test' }) }
    if (name === 'agents') return {
      currentInitiator: () => ({
        options: { provider: 'current', model: 'native-model' },
        session: {
          requestHeader: () => ({ config: { provider: 'current', model: 'native-model' } }),
          append: (type, value) => routeEvents.push({ type, value }),
        },
      }),
    }
    return undefined
  },
}
const provider = new providerModule.PrioritySearchProvider(ctx, () => ({
  customProvider: 'generic',
  customBaseURL: `${baseURL}/custom`,
  customApiKeyEnv: 'CUSTOM_API_KEY',
  nativeEnabled: true,
  deepseekFallback: true,
  sourceTimeoutMs: 3000,
}))
const result = await provider.search({ query: 'test', maxResults: 3 })
assert.equal(result.sources[0].url, 'https://native.example/result')
assert.equal(routeEvents.at(-1).value.source, 'model-native')
assert.deepEqual(requests.map((request) => request.url), ['/custom', '/v1/responses'])
assert.equal(requests[1].body.tools[0].type, 'web_search')

let routeHandler
const routeCtx = {
  ...ctx,
  inject(_dependencies, callback) {
    callback({
      effect(effect) { effect() },
      webServer: {
        register(definition) {
          routeHandler = definition.handler
          return () => {}
        },
      },
    })
  },
  get(name) {
    if (name === 'agents') return {
      currentInitiator: () => undefined,
      get: (sessionId) => ({
        options: { provider: 'current', model: 'native-model' },
        session: {
          requestHeader: () => ({
            config: sessionId === 'unsupported-session'
              ? { provider: 'unsupported', model: 'chat-only-model' }
              : { provider: 'current', model: 'native-model' },
          }),
        },
      }),
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'current', model: 'default-model' }) }
    return ctx.get(name)
  },
}
routesModule.registerSearchRoutes(
  routeCtx,
  'desktop-web-search',
  () => null,
  () => ({ customProvider: 'none', nativeEnabled: true, deepseekFallback: false, sourceTimeoutMs: 3000 }),
  provider,
)
assert.equal(typeof routeHandler, 'function')

const routeServer = createServer((req, res) => routeHandler(req, res))
routeServer.listen(0, '127.0.0.1')
await once(routeServer, 'listening')
const routeBaseURL = `http://127.0.0.1:${routeServer.address().port}/desktop-web-search`

const customResponse = await fetch(`${routeBaseURL}/test/custom`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      customProvider: 'generic',
      customBaseURL: `${baseURL}/test-custom`,
      customApiKeyEnv: 'DRAFT_KEY',
      sourceTimeoutMs: 3000,
    },
    apiKey: 'draft-key',
  }),
})
assert.equal(customResponse.status, 200)
const customPayload = await customResponse.json()
assert.equal(customPayload.value.source, 'custom/generic')
assert.equal(customPayload.value.count, 1)
assert.equal(requests.find((request) => request.url === '/test-custom').authorization, 'Bearer draft-key')

const nativeResponse = await fetch(`${routeBaseURL}/test/native`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'current-session' }),
})
assert.equal(nativeResponse.status, 200)
const nativePayload = await nativeResponse.json()
assert.equal(nativePayload.value.provider, 'current')
assert.equal(nativePayload.value.model, 'native-model')
assert.equal(nativePayload.value.count, 1)

const unsupportedResponse = await fetch(`${routeBaseURL}/test/native`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'unsupported-session' }),
})
assert.equal(unsupportedResponse.status, 502)
const unsupportedPayload = await unsupportedResponse.json()
assert.equal(unsupportedPayload.error.details.provider, 'unsupported')
assert.match(unsupportedPayload.error.message, /does not expose a supported native-search protocol/)

routeServer.close()
await once(routeServer, 'close')

server.close()
await once(server, 'close')
console.log('web-search priority + source test routes passed')
