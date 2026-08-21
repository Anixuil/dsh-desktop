const { registerModelBehavior } = await import('../runtime/dsh/node_modules/dsh-desktop-bridge/lib/model-behavior.js')

let value = { systemPrompt: '' }
let promptSection = null
let requestHandler = null
let injection = Promise.resolve()

const scope = {
  get: () => Object.freeze({ ...value }),
  replace: async (next) => { value = { ...next } },
}
const behaviorCtx = {
  settings: {
    register(ns, schema, options) {
      if (ns !== 'desktop-model-behavior') throw new Error(`unexpected settings namespace: ${ns}`)
      if (schema?.type !== 'object' || options?.applies !== 'live') throw new Error('model behavior schema is not live')
      return scope
    },
  },
  systemPrompt: {
    section(section) { promptSection = section; return () => {} },
  },
  on(event, handler) {
    if (event === 'agent/request') requestHandler = handler
    return () => {}
  },
  effect(callback) { callback(); return () => {} },
}
const ctx = {
  inject(deps, callback) {
    if (deps.join(',') !== 'settings,systemPrompt') throw new Error(`unexpected dependencies: ${deps.join(',')}`)
    injection = Promise.resolve(callback(behaviorCtx))
  },
}

const controller = registerModelBehavior(ctx)
await injection
if (promptSection?.name !== 'dsh-desktop:user-system-prompt' || promptSection.order !== 10) {
  throw new Error(`system prompt section missing: ${JSON.stringify(promptSection)}`)
}
if (typeof requestHandler !== 'function') throw new Error('agent/request temperature listener missing')

await controller.save({ systemPrompt: '  默认使用简体中文  ', temperature: 0.3 })
if (controller.read().temperature !== 0.3) throw new Error('saved temperature was not readable')
if (promptSection.text() !== '默认使用简体中文') throw new Error(`prompt section did not read the live value: ${promptSection.text()}`)
const configured = await requestHandler({}, async () => ({ provider: 'demo', model: 'demo-model' }))
if (configured.temperature !== 0.3) throw new Error(`temperature was not applied: ${JSON.stringify(configured)}`)

await controller.save({ systemPrompt: '' })
const restored = await requestHandler({}, async () => ({ provider: 'demo', model: 'demo-model', temperature: 0.3 }))
if ('temperature' in restored) throw new Error(`model-default mode retained temperature: ${JSON.stringify(restored)}`)
if (promptSection.text() !== '') throw new Error('cleared prompt still contributes text')

console.log('model behavior live settings + prompt + request integration PASSED')
