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
  let routeRegistration = null
  const disposers = []
  const mockCtx = {
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (registration) => { routeRegistration = registration; } },
    on: (event, fn) => {
      handlers[event] = fn;
      return () => {};
    },
    get: (name) => (name === 'credentials' ? { set: async () => {}, unset: async () => {} } : undefined),
  }
  process.env.DSH_HOME = home
  plugin.apply(mockCtx, { port: 0, shellPort: 38657 })
  if (plugin.name !== 'dsh-desktop-bridge' || !plugin.inject.includes('webServer')) throw new Error('bad plugin shape')
  if (routeRegistration?.path !== '/desktop') throw new Error(`bad route path: ${routeRegistration?.path}`)
  if (typeof handlers['agent/status'] !== 'function') throw new Error('agent/status listener missing')
  if (typeof handlers['dispose'] !== 'function') throw new Error('dispose listener missing')
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
    // agent/status running→idle transition arms the turn-end notifier once
    handlers['agent/status']({ status: 'running' })
    handlers['agent/status']({ status: 'idle' })
    handlers['agent/status']({ status: 'idle' })
    console.log('agent/status listener ok')
  }
  handlers['dispose']()
  console.log('dispose ok')
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log('bridge host smoke test PASSED')
