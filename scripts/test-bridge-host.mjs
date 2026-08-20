// Host-side smoke test for dsh-desktop-bridge after its modular split.
// Exercises the split modules end to end against a mock cordis ctx:
//   * zstd frame scan round-trips real node:zlib frames
//   * readSessionModel attributes a fake log to its request model
//   * usageReport aggregates a temp home (projcache + session log)
//   * apply() wires credentials server (ephemeral port) + /desktop routes
//   * /desktop/status and /desktop/usage handlers answer through the route
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const { scanFrames } = await import('./bridge/lib/zstd.js')
const { readSessionModel, encodeWorkspace } = await import('./bridge/lib/model-attribution.js')
const { usageReport } = await import('./bridge/lib/usage.js')
const plugin = await import('./bridge/index.js')

// --- 1. zstd frame scan round-trip -----------------------------------------
{
  const payload = Buffer.from('{"type":"request/header","data":{"header":{"config":{"provider":"deepseek","model":"deepseek-chat"}}}}')
  const compressed = zstdCompressSync(payload)
  const frames = scanFrames(compressed)
  if (frames.length !== 1) throw new Error(`expected 1 zstd frame, got ${frames.length}`)
  const roundtrip = zstdDecompressSync(compressed.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (!roundtrip.includes('request/header')) throw new Error('frame payload did not round-trip')
  console.log('zstd scanFrames round-trip ok')
}

// --- 2. temp home + model attribution + usage report -----------------------
const home = mkdtempSync(join(tmpdir(), 'bridge-host-test-'))
try {
  const wsDir = join(home, 'sessions', '--fake-ws--', 'session-1')
  mkdirSync(wsDir, { recursive: true })
  const log = '{"type":"request/header","data":{"header":{"config":{"provider":"deepseek","model":"deepseek-chat"}}}}\n'
  writeFileSync(join(wsDir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(log)))
  mkdirSync(join(home, 'storages'), { recursive: true })
  const createdAt = Date.now()
  writeFileSync(
    join(home, 'storages', 'session_projcache.json'),
    JSON.stringify({
      tables: {
        sessions: {
          'session-1': {
            identity: { createdAt, cwd: 'fake-ws' },
            rows: {
              title: { val: 'hello' },
              tokenUsage: { val: { totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } } },
              sessionStats: { val: { turns: 3 } },
            },
          },
        },
      },
    }),
  )

  const model = readSessionModel(join(wsDir, 'session.jsonl.zstd'))
  if (model?.provider !== 'deepseek' || model?.model !== 'deepseek-chat') throw new Error(`bad model attribution: ${JSON.stringify(model)}`)
  console.log('readSessionModel ok:', JSON.stringify(model))

  if (encodeWorkspace('E:\\some dir') !== '--E--some-dir--') throw new Error(`encodeWorkspace mismatch: ${encodeWorkspace('E:\\some dir')}`)
  console.log('encodeWorkspace ok')

  const report = usageReport(home, 0)
  if (report.ok !== true) throw new Error('usageReport not ok')
  const row = report.sessions.find((s) => s.id === 'session-1')
  if (row === undefined) throw new Error('session-1 missing from usage report')
  if (row.model !== 'deepseek-chat' || row.tokens.total !== 18 || row.turns !== 3) throw new Error(`bad usage row: ${JSON.stringify(row)}`)
  if (report.totals.total !== 18 || report.counts.sessions !== 1) throw new Error(`bad report totals: ${JSON.stringify(report.totals)}`)
  console.log('usageReport ok:', JSON.stringify({ totals: report.totals, counts: report.counts }))

  // --- 3. apply() wiring + routes -------------------------------------------
  const handlers = {}
  const emit = (event, ...args) => (handlers[event] ?? []).forEach((fn) => fn(...args))
  let routeRegistration = null
  const disposers = []
  const mockCtx = {
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (registration) => { routeRegistration = registration; } },
    on: (event, fn) => {
      (handlers[event] = handlers[event] ?? []).push(fn)
      return () => {};
    },
    get: (name) => (name === 'credentials' ? { set: async () => {}, unset: async () => {} } : undefined),
  }
  process.env.DSH_HOME = home
  plugin.apply(mockCtx, { port: 0, shellPort: 38657 })
  if (plugin.name !== 'dsh-desktop-bridge' || !plugin.inject.includes('webServer')) throw new Error('bad plugin shape')
  if (routeRegistration?.path !== '/desktop') throw new Error(`bad route path: ${routeRegistration?.path}`)
  if ((handlers['agent/status'] ?? []).length === 0) throw new Error('agent/status listener missing')
  if ((handlers['session/event'] ?? []).length === 0) throw new Error('session/event listener missing')
  if ((handlers['dispose'] ?? []).length === 0) throw new Error('dispose listener missing')
  console.log('apply wiring ok')

  const fakeRes = () => {
    const res = { status: 0, body: '' }
    res.writeHead = (status) => { res.status = status; };
    res.end = (body) => { res.body = String(body); };
    return res;
  }
  {
    const res = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/status' }, res)
    if (res.status !== 200 || !res.body.includes('"running":false')) throw new Error(`status route failed: ${res.status} ${res.body}`)
    console.log('/desktop/status ok:', res.body)
  }
  {
    const res = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/usage' }, res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true || payload.counts.sessions !== 1) throw new Error(`usage route failed: ${res.status} ${res.body}`)
    console.log('/desktop/usage ok:', JSON.stringify({ counts: payload.counts, sessions: payload.sessions.length }))
  }
  {
    // Shell listener may or may not be live in this harness: the about /
    // update proxies must answer with the { ok, ... } envelope either way
    // (200 proxied, or 502 when the shell is unreachable) — never 404.
    const res = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/about' }, res)
    if ((res.status !== 200 && res.status !== 502) || !res.body.includes('"ok"')) throw new Error(`about route failed: ${res.status} ${res.body}`)
    console.log(`/desktop/about proxy ok (status ${res.status})`)
    const res2 = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/update-status' }, res2)
    if ((res2.status !== 200 && res2.status !== 502) || !res2.body.includes('"ok"')) throw new Error(`update-status route failed: ${res2.status} ${res2.body}`)
    console.log(`/desktop/update-status proxy ok (status ${res2.status})`)
  }
  {
    // Remote-access proxies: GET config and POST save must answer with the
    // { ok, ... } envelope either way (200 proxied, 502 when the shell is
    // unreachable) — never 404.
    const res = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/remote-config' }, res)
    if ((res.status !== 200 && res.status !== 502) || !res.body.includes('"ok"')) throw new Error(`remote-config route failed: ${res.status} ${res.body}`)
    console.log(`/desktop/remote-config proxy ok (status ${res.status})`)
    const saveReq = {
      method: 'POST',
      url: '/desktop/remote-save',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ enabled: false, relayUrl: '', customRelay: false, secret: '', deviceId: '' }))
      },
    }
    const res2 = fakeRes()
    await routeRegistration.handler(saveReq, res2)
    if ((res2.status !== 200 && res2.status !== 502) || !res2.body.includes('"ok"')) throw new Error(`remote-save route failed: ${res2.status} ${res2.body}`)
    console.log(`/desktop/remote-save proxy ok (status ${res2.status})`)
    const persistentReq = {
      method: 'POST',
      url: '/desktop/remote-persistent-pairing',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ code: 'abcdef' }))
      },
    }
    const res3 = fakeRes()
    await routeRegistration.handler(persistentReq, res3)
    if ((res3.status !== 200 && res3.status !== 502) || !res3.body.includes('"ok"')) throw new Error(`remote-persistent-pairing route failed: ${res3.status} ${res3.body}`)
    console.log(`/desktop/remote-persistent-pairing proxy ok (status ${res3.status})`)
  }
  {
    // Motion proxies: GET /desktop/motion and POST /desktop/motion-save must
    // answer with the { ok, ... } envelope either way (200 proxied, or 502
    // when the shell is unreachable) — never 404.
    const res = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/motion' }, res)
    if ((res.status !== 200 && res.status !== 502) || !res.body.includes('"ok"')) throw new Error(`motion route failed: ${res.status} ${res.body}`)
    console.log(`/desktop/motion proxy ok (status ${res.status})`)
    const saveReq = {
      method: 'POST',
      url: '/desktop/motion-save',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ motion: 'quiet' }))
      },
    }
    const res2 = fakeRes()
    await routeRegistration.handler(saveReq, res2)
    if ((res2.status !== 200 && res2.status !== 502) || !res2.body.includes('"ok"')) throw new Error(`motion-save route failed: ${res2.status} ${res2.body}`)
    console.log(`/desktop/motion-save proxy ok (status ${res2.status})`)
  }
  {
    // open-external: GET → 404; POST with a non-http(s) url → the shell
    // rejects it (400 → surfaced as 502) without ever launching a browser,
    // and an unreachable shell yields the same 502 envelope.
    const badMethod = fakeRes()
    await routeRegistration.handler({ method: 'GET', url: '/desktop/open-external' }, badMethod)
    if (badMethod.status !== 404) throw new Error(`open-external GET should 404, got ${badMethod.status}`)
    const fakeReq = {
      method: 'POST',
      url: '/desktop/open-external',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ url: 'javascript:alert(1)' }))
      },
    }
    const res = fakeRes()
    await routeRegistration.handler(fakeReq, res)
    if (res.status !== 502 || !res.body.includes('"ok":false')) throw new Error(`open-external POST failed: ${res.status} ${res.body}`)
    console.log('/desktop/open-external route ok (404 on GET, rejected url never reaches explorer)')
  }
  {
    // Error-message distinction: a shell that RESPONDS with a non-ok status
    // carrying its own error must have that error passed through verbatim (no
    // "桌面壳不可用" mislabel), while a genuine network failure keeps the
    // "桌面壳不可用" prefix.
    const realFetch = globalThis.fetch
    const respondWith = (status, body) => {
      globalThis.fetch = async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      })
    }
    try {
      respondWith(502, { ok: false, error: '查询 dsh 最新版本失败: 网络不可达' })
      const res = fakeRes()
      await routeRegistration.handler({ method: 'GET', url: '/desktop/update-status' }, res)
      const payload = JSON.parse(res.body)
      if (!payload.error.startsWith('查询 dsh 最新版本失败')) throw new Error(`shell error not passed through: ${payload.error}`)
      if (payload.error.includes('桌面壳不可用')) throw new Error(`shell error mislabeled as unavailable: ${payload.error}`)
      console.log(`update-status shell error passed through: ${payload.error}`)

      globalThis.fetch = async () => { throw new TypeError('fetch failed') }
      const res2 = fakeRes()
      await routeRegistration.handler({ method: 'GET', url: '/desktop/about' }, res2)
      const payload2 = JSON.parse(res2.body)
      if (!payload2.error.startsWith('桌面壳不可用')) throw new Error(`network error not labeled unavailable: ${payload2.error}`)
      console.log(`about network error keeps unavailable prefix: ${payload2.error}`)
    } finally {
      globalThis.fetch = realFetch
    }
  }
  {
    // agent/status running→idle transition arms the turn-end notifier once
    emit('agent/status', { status: 'running' })
    emit('agent/status', { status: 'idle' })
    emit('agent/status', { status: 'idle' })
    console.log('agent/status listener ok')
  }
  {
    // --- 4. wave-state classifier: per-session + focused-session reporting -----
    const wavePosts = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/turn-state')) {
        wavePosts.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') })
        return { ok: true }
      }
      return realFetch(url, init)
    }
    const setFocus = async (sessionId) => {
      const res = fakeRes()
      await routeRegistration.handler({
        method: 'POST',
        url: '/desktop/current-session',
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ sessionId }))
        },
      }, res)
      if (res.status !== 200) throw new Error(`current-session route failed: ${res.status} ${res.body}`)
    }
    try {
      // without a focused session, no activity is reported to the shell
      emit('session/event', { id: 's2' }, { type: 'assistant/chunk', data: {} })
      if (wavePosts.length !== 0) throw new Error('reported a wave before any focus')

      // the bridge client's focus publish path (route → setFocused)
      await setFocus('s1')
      if (wavePosts.length !== 0) throw new Error('focusing a calm session should not move the wave')

      // a background conversation (s2) must not drive the wave
      const before = wavePosts.length
      emit('session/event', { id: 's2' }, { type: 'turn/start', data: {} })
      emit('session/event', { id: 's2' }, { type: 'assistant/chunk', data: {} })
      emit('session/event', { id: 's2' }, { type: 'tool/call', data: {} })
      if (wavePosts.length !== before) throw new Error('background conversation leaked into wave')

      // the focused conversation (s1) drives it
      emit('session/event', { id: 's1' }, { type: 'turn/start', data: {} })
      emit('session/event', { id: 's1' }, { type: 'assistant/chunk', data: {} })
      emit('session/event', { id: 's1' }, { type: 'assistant/chunk', data: {} }) // dedupe
      emit('session/event', { id: 's1' }, { type: 'tool/call', data: {} })
      emit('session/event', { id: 's1' }, { type: 'tool/result', data: { error: { name: 'x', code: 'y' } } })
      emit('session/event', { id: 's1' }, { type: 'approval/asked', data: {} })
      emit('session/event', { id: 's1' }, { type: 'approval/decided', data: {} })
      const states = wavePosts.slice(before).map((p) => p.body.state)
      const expected = 'thinking,streaming,tooling,error,waiting,thinking'
      if (states.join(',') !== expected) throw new Error(`wave-state mismatch: ${states.join(',')} ≠ ${expected}`)
      const details = wavePosts.slice(before).map((p) => p.body.detail)
      if (details[3] !== 'tool/result' || details[4] !== 'approval/asked') throw new Error(`wave-state detail mismatch: ${details.join(',')}`)
      console.log('wave-state focused classifier ok:', states.join(' → '))

      // switching focus re-syncs the wave to the newly focused session (s2 is
      // mid-tooling from its ignored-but-still-tracked background activity)
      const beforeSwitch = wavePosts.length
      await setFocus('s2')
      const switched = wavePosts.slice(beforeSwitch).map((p) => p.body.state)
      if (switched.length !== 1 || switched[0] !== 'tooling') throw new Error(`focus switch mismatch: ${switched.join(',')}`)
      console.log('wave-state focus switch ok:', switched.join(' → '))

      // per-session agent/status fallback: an unfocused agent never reports;
      // a focused one reports thinking→settle even without any session/event
      const beforeAgent = wavePosts.length
      emit('agent/status', { agent: { id: 's3' }, status: 'running' })
      emit('agent/status', { agent: { id: 's3' }, status: 'idle' })
      if (wavePosts.length !== beforeAgent) throw new Error('unfocused agent/status leaked into wave')
      await setFocus('s3')
      const beforeS3 = wavePosts.length
      emit('agent/status', { agent: { id: 's3' }, status: 'running' })
      emit('agent/status', { agent: { id: 's3' }, status: 'idle' })
      const agentStates = wavePosts.slice(beforeS3).map((p) => p.body.state)
      if (agentStates.join(',') !== 'thinking,settle') throw new Error(`agent/status focus mismatch: ${agentStates.join(',')}`)
      console.log('wave-state agent/status fallback ok:', agentStates.join(' → '))
    } finally {
      // release any pending decay timers before the fake fetch goes away
      emit('session/disposed', { id: 's1' })
      emit('session/disposed', { id: 's2' })
      emit('session/disposed', { id: 's3' })
      globalThis.fetch = realFetch
    }
  }
  emit('dispose')
  console.log('dispose ok')
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log('bridge host smoke test PASSED')
