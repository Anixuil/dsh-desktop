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
vm.runInContext(readFileSync(join(root, 'scripts', 'web-search', 'client.js'), 'utf8'), clientSandbox)
const react = runtimeRequire('react')
const client = clientFactory((id) => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return runtimeRequire('react/jsx-runtime')
  return {}
})
assert.equal(typeof client.apply, 'function')
assert.equal(typeof client.views?.WebSearchSection, 'function')

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
  requests.push({ url: req.url, body })
  res.setHeader('content-type', 'application/json')
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

server.close()
await once(server, 'close')
console.log('web-search priority + response mapping tests passed')
