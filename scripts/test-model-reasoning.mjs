import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyDshModelReasoningPatch, REASONING_PATCH_MARKER } from './dsh-model-reasoning-patch.mjs'
import {
  __dshDesktopCatalogReasoning as catalogReasoning,
  __dshDesktopReasoningPlatform as reasoningPlatform,
  __dshDesktopResolveRouteModels as resolveRouteModels,
} from '../runtime/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
import { streamSimple as streamOpenAICompletions } from '../runtime/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'

const root = join(import.meta.dirname, '..')
const modulesDir = join(root, 'runtime', 'dsh', 'node_modules')
const route = (overrides = {}) => ({
  provider: 'third-party',
  baseURL: 'https://api.deepseek.com/v1',
  api: 'openai-completions',
  models: [{ id: 'deepseek-reasoner' }],
  defaultInput: ['text'],
  defaultContextWindow: 131072,
  defaultMaxTokens: 8192,
  ...overrides,
})

assert.deepEqual(applyDshModelReasoningPatch(modulesDir), { adapter: false, ui: false, piAi: false })

assert.equal(reasoningPlatform('gateway', 'https://api.openai.com/v1'), 'openai')
assert.equal(reasoningPlatform('gateway', 'https://openrouter.ai/api/v1'), 'openrouter')
assert.equal(reasoningPlatform('gateway', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen')
assert.equal(reasoningPlatform('gateway', 'https://unknown.invalid/v1'), undefined)

const openai = catalogReasoning('gateway', 'https://api.openai.com/v1', 'gpt-5.2')
assert.equal(openai?.reasoning, true)
assert.equal(openai?.thinkingLevelMap?.xhigh, 'xhigh')

const proxiedOpenAI = catalogReasoning('gpt', 'https://proxy.invalid/v1', 'gpt-5.6-sol', 'openai-responses')
assert.equal(proxiedOpenAI?.reasoning, true, 'an explicit first-party wire protocol may reuse an exact catalog model through a custom gateway')
assert.equal(proxiedOpenAI?.thinkingLevelMap?.max, 'max')
assert.equal(catalogReasoning('gpt', 'https://proxy.invalid/v1', 'gpt-5.6-sol', 'openai-completions'), undefined)
assert.equal(catalogReasoning('gpt', 'https://proxy.invalid/v1', 'reasoning-large', 'openai-responses'), undefined)

const openrouter = catalogReasoning('gateway', 'https://openrouter.ai/api/v1', 'anthropic/claude-opus-4.6')
assert.equal(openrouter?.reasoning, true)
assert.equal(openrouter?.compat?.thinkingFormat, 'openrouter')
assert.equal(openrouter?.thinkingLevelMap?.max, 'max')
assert.equal(catalogReasoning('gateway', 'https://unknown.invalid/v1', 'reasoning-large'), undefined)
assert.equal(catalogReasoning('gateway', 'https://api.openai.com/v1', 'reasoning-large'), undefined)

const automatic = resolveRouteModels(route()).models[0]
assert.equal(automatic.reasoning, true)
assert.equal(automatic.compat.thinkingFormat, 'deepseek')
assert.equal(automatic.thinkingLevelMap.medium, 'high')
assert.equal(automatic.thinkingLevelMap.off, 'disabled')

const explicit = resolveRouteModels(route({
  models: [{
    id: 'deepseek-reasoner',
    reasoningEfforts: { off: 'none', low: 'lite', high: 'strong' },
    compat: { thinkingFormat: 'openrouter' },
  }],
})).models[0]
assert.equal(explicit.reasoning, true)
assert.deepEqual(explicit.thinkingLevelMap, {
  off: 'none', minimal: null, low: 'lite', medium: null, high: 'strong', xhigh: null, max: null,
})
assert.equal(explicit.compat.thinkingFormat, 'openrouter')

const disabled = resolveRouteModels(route({ models: [{ id: 'deepseek-reasoner', reasoningEfforts: false }] })).models[0]
assert.equal(disabled.reasoning, false)

const restored = resolveRouteModels(route({ models: [{ id: 'deepseek-reasoner', name: 'Renamed', contextWindow: 200000 }] })).models[0]
assert.equal(restored.reasoning, true)
assert.equal(restored.name, 'Renamed')
assert.equal(restored.contextWindow, 200000)
assert.equal(restored.compat.thinkingFormat, 'deepseek')

const proxiedGpt = resolveRouteModels(route({
  provider: 'gpt',
  baseURL: 'https://proxy.invalid/v1',
  api: 'openai-responses',
  models: [{ id: 'gpt-5.6-sol' }],
})).models[0]
assert.equal(proxiedGpt.reasoning, true)
assert.equal(proxiedGpt.thinkingLevelMap.low, 'low')
assert.equal(proxiedGpt.thinkingLevelMap.max, 'max')

const unknown = resolveRouteModels(route({
  baseURL: 'https://unknown.invalid/v1',
  models: [{ id: 'reasoning-large' }],
})).models[0]
assert.equal(unknown.reasoning, false)
assert.equal(unknown.compat, undefined)

const qwen = resolveRouteModels(route({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: 'qwen3.6-plus' }],
})).models[0]
assert.equal(qwen.reasoning, true)
assert.equal(qwen.compat.thinkingFormat, 'qwen')

const qwenCustom = resolveRouteModels(route({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{
    id: 'qwen3.6-plus',
    reasoningEfforts: { off: 'disabled', low: 'low', high: 'high' },
    compat: { thinkingFormat: 'qwen' },
    thinkingBudgets: { low: 2048, high: 16384 },
  }],
})).models[0]
assert.deepEqual(qwenCustom.thinkingBudgets, { low: 2048, high: 16384 })

const gemini = resolveRouteModels(route({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  api: 'google-generative-ai',
  models: [{ id: 'gemini-3-pro-preview' }],
})).models[0]
assert.equal(gemini.reasoning, true)
assert.equal(gemini.api, 'google-generative-ai')
assert.equal(gemini.thinkingLevelMap.low, 'LOW')
assert.equal(gemini.thinkingLevelMap.high, 'HIGH')
assert.equal(gemini.thinkingLevelMap.off, null, 'mandatory Gemini models must not expose off')

const geminiCustom = resolveRouteModels(route({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  api: 'google-generative-ai',
  models: [{ id: 'gemini-3-pro-preview', reasoningEfforts: { off: 'none', low: 'LOW', high: 'HIGH' } }],
})).models[0]
assert.equal(geminiCustom.thinkingLevelMap.off, null, 'custom overrides must not re-enable off for mandatory models')
assert.equal(geminiCustom.thinkingLevelMap.low, 'LOW')

const originalFetch = globalThis.fetch
async function completionPayload(compat, reasoning, thinkingLevelMap, thinkingBudgets) {
  let payload
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body)
    const sse = [
      'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const stream = streamOpenAICompletions({
    id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://fixture.invalid/v1',
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072, maxTokens: 8192, compat, thinkingLevelMap,
  }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 0 }] }, {
    apiKey: 'fixture-key', reasoning, thinkingBudgets, maxRetries: 0,
  })
  for await (const _event of stream) void _event
  return payload
}

try {
  const openaiChat = await completionPayload({ thinkingFormat: 'openai', supportsReasoningEffort: true }, 'high', { high: 'high' })
  assert.equal(openaiChat.reasoning_effort, 'high')

  const openrouterBody = await completionPayload({ thinkingFormat: 'openrouter' }, 'medium', { medium: 'medium' })
  assert.deepEqual(openrouterBody.reasoning, { effort: 'medium' })

  const deepseekOn = await completionPayload({ thinkingFormat: 'deepseek', supportsReasoningEffort: true }, 'medium', { off: 'disabled', medium: 'high' })
  assert.deepEqual(deepseekOn.thinking, { type: 'enabled' })
  assert.equal(deepseekOn.reasoning_effort, 'high')
  const deepseekOff = await completionPayload({ thinkingFormat: 'deepseek', supportsReasoningEffort: true }, 'off', { off: 'disabled', medium: 'high' })
  assert.deepEqual(deepseekOff.thinking, { type: 'disabled' })

  const qwenOn = await completionPayload({ thinkingFormat: 'qwen' }, 'high', { off: 'disabled', high: 'high' }, { high: 16384 })
  assert.equal(qwenOn.enable_thinking, true)
  assert.equal(qwenOn.thinking_budget, 16384)
  const qwenOff = await completionPayload({ thinkingFormat: 'qwen' }, 'off', { off: 'disabled', high: 'high' }, { high: 16384 })
  assert.equal(qwenOff.enable_thinking, false)
  assert.equal(qwenOff.thinking_budget, undefined)

  const zaiOff = await completionPayload({ thinkingFormat: 'zai', supportsReasoningEffort: true }, 'off', { off: 'disabled', high: 'high' })
  assert.deepEqual(zaiOff.thinking, { type: 'disabled' })
} finally {
  globalThis.fetch = originalFetch
}

const adapterSource = readFileSync(join(modulesDir, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8')
const completionsSource = readFileSync(join(modulesDir, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'), 'utf8')
const responsesSource = readFileSync(join(modulesDir, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-responses.js'), 'utf8')
const anthropicSource = readFileSync(join(modulesDir, '@earendil-works', 'pi-ai', 'dist', 'api', 'anthropic-messages.js'), 'utf8')
const googleSource = readFileSync(join(modulesDir, '@earendil-works', 'pi-ai', 'dist', 'api', 'google-generative-ai.js'), 'utf8')
const uiSource = readFileSync(join(modulesDir, '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js'), 'utf8')

assert.match(adapterSource, /reasoning === void 0 \? \{\} : \{ reasoning \}/, 'off must reach pi-ai instead of being collapsed to omission')
assert.match(responsesSource, /params\.reasoning = \{[\s\S]*?effort:/, 'OpenAI Responses reasoning.effort mapping drifted')
assert.match(completionsSource, /params\.reasoning_effort =/, 'OpenAI Chat reasoning_effort mapping drifted')
assert.match(completionsSource, /thinking = \{ type: "disabled" \}/, 'DeepSeek or Z.AI explicit off mapping drifted')
assert.match(completionsSource, /reasoning = \{[\s\S]*?effort:/, 'OpenRouter nested reasoning mapping drifted')
assert.match(completionsSource, /params\.enable_thinking = !!options\?\.reasoningEffort/, 'Qwen enable_thinking mapping drifted')
assert.match(completionsSource, /params\.thinking_budget = budget/, 'Qwen thinking_budget patch is missing')
assert.match(anthropicSource, /type: "adaptive"/)
assert.match(anthropicSource, /budget_tokens/)
assert.match(anthropicSource, /output_config/)
assert.match(googleSource, /thinkingConfig/)
assert.match(googleSource, /thinkingBudget/)
assert.match(googleSource, /thinkingLevel/)

assert.ok(uiSource.includes(REASONING_PATCH_MARKER))
assert.ok(uiSource.includes('使用自动配置'))
assert.ok(uiSource.includes('实际发送值'))
assert.ok(uiSource.includes('Token 预算'))
assert.ok(adapterSource.includes('function desktopPlatformCatalogModels(provider, baseURL, api)'), 'known-platform or explicit-protocol catalog discovery fallback is missing')
assert.ok(uiSource.includes('reasoningAutoResolved'), 'automatic reasoning levels are not rendered')
assert.ok(uiSource.includes('reasoningMandatory'), 'mandatory reasoning state is not rendered')
assert.ok(uiSource.includes('const [reasoningCatalog, setReasoningCatalog]'), 'automatic reasoning discovery state is missing')
assert.ok(uiSource.includes('automatic?.mandatory ? DESKTOP_REASONING_EFFORTS.filter'), 'mandatory models must hide off in the custom editor')
assert.ok(uiSource.includes('["openai-responses", "anthropic-messages", "google-generative-ai"].includes(probe.api)'), 'settings discovery must recognize unambiguous first-party wire protocols')
assert.match(uiSource, /if \(!desktopKnownReasoningProbe\(probe\)\) \{ setReasoningCatalog\([^\n]+return; \}/, 'unknown platforms must not trigger catalog discovery')
assert.match(uiSource, /setReasoningCatalog\(new Map\([\s\S]*?candidate\.reasoning[\s\S]*?\)\)\);/, 'discovered reasoning metadata must stay in read-only UI state')
assert.doesNotMatch(uiSource, /patch\([^\n]+reasoningCatalog/, 'automatic discovery must not persist catalog metadata into the model')
assert.match(uiSource, /const compat = \{ \.\.\.model\.compat \};[\s\S]*?delete compat\.thinkingFormat/, 'restoring automatic mode must preserve unrelated compat fields')

console.log('model reasoning compatibility tests passed')
