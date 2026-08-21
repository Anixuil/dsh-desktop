import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const root = join(import.meta.dirname, '..')
const require = createRequire(join(root, 'runtime', 'dsh', 'package.json'))
const react = require('react')
const jsxRuntime = require('react/jsx-runtime')

let factory
const styles = []
const documentMock = {
  head: { appendChild: (node) => styles.push(node.textContent) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
}
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } },
  document: documentMock,
  console,
  require: (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return jsxRuntime
    return {}
  },
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(root, 'scripts', 'conversation-navigator', 'client.js'), 'utf8'), sandbox)
if (typeof factory !== 'function') throw new Error('conversation navigator bundle did not register')
const plugin = factory(sandbox.require)
if (!plugin.inject.includes('sessions')) throw new Error('sessions injection missing')

const registrations = []
const ctx = {
  effect: (setup) => { setup(); return () => {} },
  locale: { register: () => {}, bind: () => (key, params) => params?.turn ? `${key}:${params.turn}` : key },
  sessions: {},
  slots: {
    inject: (name, setup) => registrations.push({ name, registration: setup() }),
    register: (options, component) => ({ options, component }),
  },
}
plugin.apply(ctx)
if (registrations.length !== 1 || registrations[0].name !== 'shell.overlay') throw new Error('shell.overlay registration missing')
if (registrations[0].registration.options.id !== 'conversation-navigator') throw new Error('navigator registration id mismatch')

const { normalizeText, buildTurnEntries, computeLayout } = plugin.helpers
if (normalizeText('## 标题\n\n- 内容 `code`') !== '标题\n内容 code') throw new Error('markdown normalization mismatch')

const nodes = new Map([
  ['u1', { key: 'u1', kind: 'user', visibility: 'visible', location: { kind: 'turn', turn: { turn: 1 } }, data: { content: [{ type: 'text', text: '## 第一问\n细节' }] } }],
  ['a1', { key: 'a1', kind: 'assistant-step', visibility: 'visible', location: { kind: 'step', turn: { turn: 1 } }, data: { status: 'settled', blocks: [{ kind: 'text', text: '第一答\n\n更多' }] } }],
  ['u2', { key: 'u2', kind: 'user', visibility: 'visible', location: { kind: 'turn', turn: { turn: 2 } }, data: { content: [{ type: 'image', attachment: {} }] } }],
  ['a2', { key: 'a2', kind: 'assistant-step', visibility: 'visible', location: { kind: 'step', turn: { turn: 2 } }, data: { status: 'running', blocks: [] } }],
  ['hidden', { key: 'hidden', kind: 'assistant-step', visibility: 'hidden', location: { kind: 'step', turn: { turn: 3 } }, data: {} }],
])
const entries = buildTurnEntries({ chat: { order: [...nodes.keys()], nodes: { get: (key) => nodes.get(key) } }, running: true }, {
  imageMessage: '图片消息', turnFallback: (turn) => `第 ${turn} 轮对话`, generating: '正在生成回复', noReply: '暂无回复',
})
if (entries.length !== 2) throw new Error(`expected 2 entries, got ${entries.length}`)
if (entries[0].title !== '第一问' || entries[0].summary !== '第一答' || entries[0].anchorKey !== 'u1') throw new Error(`turn 1 mismatch: ${JSON.stringify(entries[0])}`)
if (entries[1].title !== '图片消息' || entries[1].summary !== '正在生成回复') throw new Error(`turn 2 mismatch: ${JSON.stringify(entries[1])}`)

const settledWithoutReply = new Map([
  ['u4', { key: 'u4', kind: 'user', visibility: 'visible', location: { kind: 'turn', turn: { turn: 4 } }, data: { content: [] } }],
])
const fallback = buildTurnEntries({
  chat: { order: ['u4'], nodes: { get: (key) => settledWithoutReply.get(key) } },
  running: true,
}, {
  turnFallback: (turn) => `第 ${turn} 轮对话`,
  generating: '正在生成回复',
  noReply: '暂无回复',
})
if (fallback[0].title !== '第 4 轮对话' || fallback[0].summary !== '暂无回复') {
  throw new Error(`session running state leaked into an older turn: ${JSON.stringify(fallback[0])}`)
}

const layout = computeLayout({
  overlay: { left: 200, top: 40 },
  sidebar: { right: 300 },
  flow: { left: 420 },
  scroll: { left: 260, top: 96, bottom: 760 },
  composer: { top: 640 },
})
if (JSON.stringify(layout) !== JSON.stringify({ left: 112, top: 70, height: 516 })) throw new Error(`sidebar-relative layout mismatch: ${JSON.stringify(layout)}`)

const narrowLayout = computeLayout({
  overlay: { left: 0, top: 0 },
  sidebar: { right: 280 },
  flow: { left: 314 },
  scroll: { left: 280, top: 72, bottom: 640 },
  composer: { top: 560 },
})
if (narrowLayout.left !== 284) throw new Error(`content safety clamp mismatch: ${JSON.stringify(narrowLayout)}`)

for (const [file, marker] of [
  ['scripts/bridge.patch.yml', 'dsh-desktop-conversation-navigator'],
  ['scripts/sync-runtime-plugins.mjs', "dir: 'conversation-navigator'"],
  ['scripts/fetch-runtime.mjs', "dir: 'conversation-navigator'"],
  ['scripts/bridge/src/builtin-plugins-section.js', "'dsh-desktop-conversation-navigator'"],
  ['src-tauri/src/lib.rs', '"dsh-desktop-conversation-navigator"'],
]) {
  if (!readFileSync(join(root, file), 'utf8').includes(marker)) throw new Error(`${file} is missing ${marker}`)
}

console.log('conversation navigator bundle and projection tests PASSED')
