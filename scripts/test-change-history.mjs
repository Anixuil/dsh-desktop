// Tests for dsh-desktop-change-history: pure diff, change store, rollback
// transaction, the host plugin entry (routes + tools/result recording), and the
// client bundle (registration + server-side render). Mirrors the
// session-manager host/client test split in one file.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// ——— 1. pure diff ———
{
  const { unifiedDiff, diffStats } = await import('./change-history/lib/diff.js')
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n')
  if (!d.includes('-b') || !d.includes('+B')) throw new Error(`diff should mark -b/+B, got:\n${d}`)
  if (!d.includes('@@')) throw new Error(`diff should carry a hunk header, got:\n${d}`)
  if (unifiedDiff('same', 'same') !== '') throw new Error('identical inputs must diff to empty')
  const create = unifiedDiff(null, 'hello\nworld\n')
  if (!create.includes('+hello') || !create.includes('+world')) throw new Error(`create diff should be all-added, got:\n${create}`)
  const stats = diffStats('a\nb\n', 'a\nb\nc\n')
  if (stats.added !== 1 || stats.removed !== 0) throw new Error(`stats wrong: ${JSON.stringify(stats)}`)
  const stats2 = diffStats('x\ny\n', 'x\n')
  if (stats2.added !== 0 || stats2.removed !== 1) throw new Error(`stats wrong: ${JSON.stringify(stats2)}`)
  console.log('diff ok')
}

// ——— 2. change store ———
{
  const { ChangeStore } = await import('./change-history/lib/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'dch-store-'))
  const store = new ChangeStore(dir)
  const a = store.append({ sessionId: 's1', tool: 'edit', path: '/x/a.txt', operation: 'edit', before: 'a', after: 'b' })
  const b = store.append({ sessionId: 's1', tool: 'write', path: '/x/b.txt', operation: 'create', before: null, after: 'hi' })
  if (typeof a.id !== 'string' || typeof b.id !== 'string') throw new Error('append must stamp ids')
  if (store.list().length !== 2) throw new Error('list should return both records')
  if (store.list()[0].id !== b.id) throw new Error('list should be newest-first')
  if (store.get(a.id)?.path !== '/x/a.txt') throw new Error('get should find by id')
  if (store.get('nope') !== undefined) throw new Error('get should return undefined for missing id')

  // persistence: a fresh store over the same dir reloads the records
  const reloaded = new ChangeStore(dir)
  if (reloaded.list().length !== 2) throw new Error('reloaded store should read persisted records')
  if (reloaded.get(a.id)?.before !== 'a') throw new Error('reloaded record should keep before content')
  rmSync(dir, { recursive: true, force: true })
  console.log('store ok')
}

// ——— 3. rollback transaction ———
{
  const { rollbackChange } = await import('./change-history/lib/rollback.js')
  const dir = mkdtempSync(join(tmpdir(), 'dch-rollback-'))
  const created = join(dir, 'created.txt')
  writeFileSync(created, 'new content')
  const r1 = rollbackChange({ path: created, operation: 'create', before: null, after: 'new content' })
  if (r1.ok !== true || r1.action !== 'deleted') throw new Error(`create rollback should delete: ${JSON.stringify(r1)}`)
  if (existsSync(created)) throw new Error('created file still exists after rollback')

  const updated = join(dir, 'updated.txt')
  writeFileSync(updated, 'after text')
  const r2 = rollbackChange({ path: updated, operation: 'update', before: 'before text', after: 'after text' })
  if (r2.ok !== true || r2.action !== 'restored' || r2.diverged !== false) throw new Error(`update rollback wrong: ${JSON.stringify(r2)}`)
  if (readFileSync(updated, 'utf8') !== 'before text') throw new Error('rollback did not restore before content')

  // divergence: current differs from the recorded after -> flagged but still restored
  writeFileSync(updated, 'hand-edited')
  const r3 = rollbackChange({ path: updated, operation: 'update', before: 'before text', after: 'after text' })
  if (r3.ok !== true || r3.diverged !== true) throw new Error(`diverged rollback wrong: ${JSON.stringify(r3)}`)
  if (readFileSync(updated, 'utf8') !== 'before text') throw new Error('diverged rollback should still restore before content')

  // no baseline: an update whose prior content was never captured is refused
  const r4 = rollbackChange({ path: updated, operation: 'update', before: null, after: 'after text' })
  if (r4.ok !== false || r4.code !== 'no_baseline') throw new Error(`no-baseline should refuse: ${JSON.stringify(r4)}`)
  rmSync(dir, { recursive: true, force: true })
  console.log('rollback ok')
}

// ——— 4. host plugin entry ———
{
  const plugin = await import('./change-history/index.js')
  if (plugin.name !== 'dsh-desktop-change-history') throw new Error(`bad plugin name ${plugin.name}`)
  if (!plugin.inject.includes('webServer')) throw new Error('inject must include webServer')

  const home = mkdtempSync(join(tmpdir(), 'dch-host-'))
  process.env.DSH_HOME = home

  let routeHandler = null
  let resultListener = null
  const warns = []
  const mockCtx = {
    effect: (fn) => { fn(); return () => {}; },
    on: (event, handler) => { if (event === 'tools/result') resultListener = handler; },
    webServer: {
      register: (registration) => {
        if (registration.kind !== 'prefix' || registration.path !== '/desktop-changes') {
          throw new Error(`unexpected registration: ${JSON.stringify({ kind: registration.kind, path: registration.path })}`)
        }
        routeHandler = registration.handler
      },
    },
    logger: { warn: (msg) => { warns.push(msg); } },
  }
  plugin.apply(mockCtx, {})
  if (routeHandler === null) throw new Error('route handler never registered')
  if (typeof resultListener !== 'function') throw new Error('tools/result listener never registered')

  const fakeRes = () => {
    const res = { status: 0, headers: {}, body: '' }
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? {}; }
    res.end = (body) => { res.body = String(body); }
    return res
  }
  const emptyReq = (method, url) => ({ method, url, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) })

  // record an edit through the observed event (path under the temp home)
  const target = join(home, 'proj', 'src', 'a.js')
  resultListener(
    { name: 'edit', callId: 'call-1', parent: undefined, agent: { session: { id: 'sess-1', header: {}, events: [{ type: 'turn/start', data: { turn: 3 } }, { type: 'session/title', data: { title: 'hello' } }] } } },
    { isError: false, value: { path: target, before: 'old', after: 'new' } },
  )
  // a nested call and a non-fs tool must be ignored
  resultListener({ name: 'write', parent: {}, agent: null }, { isError: false, value: { path: '/ignored', operation: 'create', before: null, after: 'x' } })
  resultListener({ name: 'bash', parent: undefined, agent: null }, { isError: false, value: {} })

  // list
  {
    const res = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/list'), res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true) throw new Error(`list failed: ${res.status} ${res.body}`)
    if (payload.changes.length !== 1) throw new Error(`expected 1 change, got ${payload.changes.length}`)
    const row = payload.changes[0]
    if (row.path !== target || row.tool !== 'edit' || row.operation !== 'edit') throw new Error(`bad row: ${JSON.stringify(row)}`)
    if (row.sessionId !== 'sess-1' || row.sessionTitle !== 'hello' || row.turn !== 3) throw new Error(`bad session fields: ${JSON.stringify(row)}`)
    if (typeof row.diff !== 'string' || !row.diff.includes('+new')) throw new Error(`row diff missing: ${JSON.stringify(row.diff)}`)
    if (row.stats.added !== 1 || row.stats.removed !== 1) throw new Error(`row stats wrong: ${JSON.stringify(row.stats)}`)
    console.log('host list ok:', JSON.stringify({ path: row.path, diff: row.diff }))
  }

  // Legacy reviewed array migrates to approved status; state persists as a map.
  {
    const stateDir = mkdtempSync(join(tmpdir(), 'dch-state-'))
    writeFileSync(join(stateDir, 'reviewed.json'), JSON.stringify(['legacy']))
    const { ChangeStore } = await import('./change-history/lib/store.js')
    const stateStore = new ChangeStore(stateDir)
    if (stateStore.statusOf('legacy') !== 'approved') throw new Error('legacy review state did not migrate')
    stateStore.setStatus('rejected', 'rejected')
    if (JSON.parse(readFileSync(join(stateDir, 'reviewed.json'), 'utf8')).rejected !== 'rejected') throw new Error('status map did not persist')
    rmSync(stateDir, { recursive: true, force: true })
    console.log('approval state migration ok')
  }

  // resolve by call id
  {
    const res = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/resolve?callId=call-1'), res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true) throw new Error(`resolve failed: ${res.status} ${res.body}`)
    if (payload.change === null || payload.change.path !== target || payload.change.reviewed !== false) throw new Error(`bad resolve row: ${JSON.stringify(payload.change)}`)
    console.log('host resolve ok:', JSON.stringify({ id: payload.change.id, reviewed: payload.change.reviewed }))
    const resolvedId = payload.change.id

    // review toggle persists through the store
    const markRes = fakeRes()
    const markBody = JSON.stringify({ id: resolvedId, reviewed: true })
    const markReq = { method: 'POST', url: '/desktop-changes/review', [Symbol.asyncIterator]: async function* () { yield markBody; } }
    await routeHandler(markReq, markRes)
    if (markRes.status !== 200 || !JSON.parse(markRes.body).reviewed) throw new Error(`review mark failed: ${markRes.status} ${markRes.body}`)
    const reRes = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/resolve?callId=call-1'), reRes)
    if (JSON.parse(reRes.body).change.reviewed !== true) throw new Error('reviewed flag not persisted')
    console.log('host review ok')
  }

  // Per-turn approval isolates sessions, dedupes repeated writes to a path,
  // supports individual and batch approvals, and never mixes same-number turns.
  {
    const second = join(home, 'proj', 'src', 'b.js')
    resultListener({ name: 'write', callId: 'call-2', parent: undefined, agent: { session: { id: 'sess-1', header: {}, events: [{ type: 'turn/start', data: { turn: 3 } }] } } }, { isError: false, value: { path: second, operation: 'create', before: null, after: 'two' } })
    resultListener({ name: 'edit', callId: 'call-3', parent: undefined, agent: { session: { id: 'sess-2', header: {}, events: [{ type: 'turn/start', data: { turn: 3 } }] } } }, { isError: false, value: { path: second, before: 'two', after: 'other session' } })
    const res = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/turn?sessionId=sess-1&turn=3'), res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.approval.changes.length !== 2 || payload.approval.totals.added !== 2) throw new Error(`turn query failed: ${res.status} ${res.body}`)
    const firstId = payload.approval.changes.find((row) => row.path === target).id
    const approveReq = { method: 'POST', url: '/desktop-changes/approve', [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ id: firstId }); } }
    const approveRes = fakeRes()
    await routeHandler(approveReq, approveRes)
    if (JSON.parse(approveRes.body).status !== 'approved') throw new Error(`single approval failed: ${approveRes.body}`)
    const bulkReq = { method: 'POST', url: '/desktop-changes/approve-turn', [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ sessionId: 'sess-1', turn: 3 }); } }
    const bulkRes = fakeRes()
    await routeHandler(bulkReq, bulkRes)
    if (JSON.parse(bulkRes.body).approvedIds.length !== 1) throw new Error(`bulk approval failed: ${bulkRes.body}`)
    console.log('turn approval routes ok')
  }

  // rollback through the route (restore an edit)
  {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'new')
    const row = (await (async () => {
      const res = fakeRes()
      await routeHandler(emptyReq('GET', '/desktop-changes/list'), res)
      return JSON.parse(res.body).changes.find((change) => change.path === target)
    })())
    const res = fakeRes()
    const body = JSON.stringify({ id: row.id })
    const req = { method: 'POST', url: '/desktop-changes/rollback', [Symbol.asyncIterator]: async function* () { yield body; } }
    await routeHandler(req, res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true) throw new Error(`rollback failed: ${res.status} ${res.body}`)
    if (readFileSync(target, 'utf8') !== 'old') throw new Error('route rollback did not restore before content')
    console.log('host rollback ok:', JSON.stringify(payload))
  }

  // rollback of an unknown id -> 404
  {
    const res = fakeRes()
    const body = JSON.stringify({ id: 'missing' })
    const req = { method: 'POST', url: '/desktop-changes/rollback', [Symbol.asyncIterator]: async function* () { yield body; } }
    await routeHandler(req, res)
    const payload = JSON.parse(res.body)
    if (res.status !== 404 || payload.code !== 'not_found') throw new Error(`unknown id should 404: ${res.status} ${res.body}`)
    console.log('host unknown-id guard ok')
  }

  // Failed rejection keeps its pending state, while a rejected record cannot
  // be rolled back twice.
  {
    resultListener({ name: 'edit', callId: 'call-no-baseline', parent: undefined, agent: { session: { id: 'sess-1', header: {}, events: [{ type: 'turn/start', data: { turn: 4 } }] } } }, { isError: false, value: { path: join(home, 'no-baseline.js'), before: null, after: 'after' } })
    const list = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/list'), list)
    const missingBaseline = JSON.parse(list.body).changes.find((change) => change.callId === 'call-no-baseline')
    const rejectRes = fakeRes()
    await routeHandler({ method: 'POST', url: '/desktop-changes/rollback', [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ id: missingBaseline.id }); } }, rejectRes)
    if (rejectRes.status === 200) throw new Error('no-baseline rejection must fail')
    const refreshed = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/resolve?callId=call-no-baseline'), refreshed)
    if (JSON.parse(refreshed.body).change.status !== 'pending') throw new Error('failed rejection changed approval state')
    const rejectedId = JSON.parse(list.body).changes.find((change) => change.path === target).id
    const again = fakeRes()
    await routeHandler({ method: 'POST', url: '/desktop-changes/rollback', [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ id: rejectedId }); } }, again)
    if (again.status !== 409) throw new Error('rejected change must not roll back twice')
    console.log('rejection safeguards ok')
  }

  // read route powers the built-in side viewer
  {
    writeFileSync(target, 'one\nthree lines\n')
    const res = fakeRes()
    await routeHandler(emptyReq('GET', `/desktop-changes/read?path=${encodeURIComponent(target)}`), res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true) throw new Error(`read failed: ${res.status} ${res.body}`)
    if (payload.content !== 'one\nthree lines\n') throw new Error(`read content wrong: ${JSON.stringify(payload.content)}`)
    if (payload.totalLines !== 2) throw new Error(`read totalLines wrong: ${payload.totalLines}`)
    if (payload.truncated !== false) throw new Error('read should not be truncated')
    if (payload.lang !== 'javascript') throw new Error(`read lang wrong: ${payload.lang}`)
    console.log('host read ok:', JSON.stringify({ totalLines: payload.totalLines, bytes: payload.bytes, lang: payload.lang }))
  }

  // read of a missing file -> 400 not_readable
  {
    const res = fakeRes()
    await routeHandler(emptyReq('GET', '/desktop-changes/read?path=' + encodeURIComponent(join(home, 'nope.txt'))), res)
    const payload = JSON.parse(res.body)
    if (res.status === 200 || payload.code !== 'not_readable') throw new Error(`missing file read should fail not_readable: ${res.status} ${res.body}`)
    console.log('host read missing-file guard ok')
  }

  // A moved/removed workspace file remains viewable from the change record.
  {
    rmSync(target, { force: true })
    const res = fakeRes()
    const row = await (async () => {
      const list = fakeRes()
      await routeHandler(emptyReq('GET', '/desktop-changes/list'), list)
      return JSON.parse(list.body).changes.find((change) => change.path === target)
    })()
    await routeHandler(emptyReq('GET', `/desktop-changes/read?path=${encodeURIComponent(row.path)}&changeId=${encodeURIComponent(row.id)}`), res)
    const payload = JSON.parse(res.body)
    if (res.status !== 200 || payload.ok !== true || payload.snapshot !== true) throw new Error(`snapshot fallback failed: ${res.status} ${res.body}`)
    if (payload.content !== 'new') throw new Error(`snapshot content wrong: ${JSON.stringify(payload.content)}`)
    console.log('host read snapshot fallback ok')
  }

  if (warns.length > 0) throw new Error(`unexpected warnings: ${warns.join('; ')}`)
  rmSync(home, { recursive: true, force: true })
  console.log('host entry ok')
}

// ——— 5. client bundle ———
{
  // Build the bundle first so the test is self-contained.
  await import('./change-history/build.mjs')

  const { createRequire } = await import('node:module')
  const vm = await import('node:vm')
  const require = createRequire(new URL('../runtime/dsh/package.json', import.meta.url))
  const react = require('react')
  const { renderToString } = require('react-dom/server')

  globalThis.window = globalThis
  globalThis.document = {
    head: { appendChild: () => {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.__ModuleLoader__ = {
    load: ({ id, factory }) => { globalThis.__ModuleLoader__Factory = factory; },
  }
  const registrations = []
  const mockCtx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: (ns, dicts) => {
        for (const key of Object.keys(dicts.zh)) {
          if (!(key in dicts.en)) throw new Error(`locale key missing in en: ${key}`)
        }
      },
      bind: () => (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
    },
    slots: {
      register: (opts, component) => ({ opts, component }),
      inject: (slotName, cb) => {
        const push = (reg) => registrations.push({ slotName, reg: reg.opts, component: reg.component });
        const result = cb();
        if (result && typeof result.next === 'function') {
          for (const reg of result) push(reg);
        } else {
          push(result);
        }
      },
    },
    on: () => {},
  }
  const stubPrimitives = new Proxy({}, { get: () => (props) => props?.children ?? null })
  const sandbox = {
    window: globalThis,
    document: globalThis.document,
    console,
    require: (id) => {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives
      return {}
    },
  }
  vm.createContext(sandbox)
  const clientSource = readFileSync(new URL('./scripts/change-history/client.js', new URL('../', import.meta.url)), 'utf8')
  for (const marker of ['chx_viewerResizeHandle', "role: 'separator'", 'overflow-wrap: anywhere', 'white-space: pre-wrap', 'viewer.resize', "data-state': closing", '@starting-style', 'cubic-bezier(0.32, 0.72, 0, 1)', 'translateX(100%)']) {
    if (!clientSource.includes(marker)) throw new Error(`resizable wrapping viewer bundle missing ${marker}`)
  }
  vm.runInContext(clientSource, sandbox)
  const factory = globalThis.__ModuleLoader__Factory
  if (typeof factory !== 'function') throw new Error('client bundle never registered')
  const result = factory(sandbox.require)
  if (typeof result.apply !== 'function') throw new Error('client bundle did not export apply')
  if (!result.inject.includes('slots') || !result.inject.includes('locale')) throw new Error('client inject must include slots + locale')

  result.apply(mockCtx)
  if (registrations.length !== 5) throw new Error(`expected 5 slot registrations, got ${registrations.length}`)
  const settingsReg = registrations.find((r) => r.slotName === 'settings.section')
  if (settingsReg === undefined || settingsReg.reg.id !== 'change-history' || settingsReg.reg.order !== 21) {
    throw new Error(`bad settings registration: ${JSON.stringify(settingsReg)}`)
  }
  console.log('settings registration ok:', { id: settingsReg.reg.id, order: settingsReg.reg.order, label: settingsReg.reg.label() })
  const toolviews = registrations.filter((r) => r.slotName === 'tool.call.toolview')
  if (toolviews.length !== 2) throw new Error(`expected 2 toolview registrations, got ${toolviews.length}`)
  const keys = toolviews.map((r) => r.reg.key).sort()
  if (keys.join(',') !== 'edit,write') throw new Error(`bad toolview keys: ${keys.join(',')}`)
  for (const tv of toolviews) {
    if (tv.reg.priority !== -1) throw new Error(`toolview ${tv.reg.key} priority must be -1 to shadow the shipped row`)
    if (tv.reg.locale !== 'changeHistory') throw new Error(`toolview ${tv.reg.key} locale must be changeHistory`)
  }
  console.log('toolview registration ok:', toolviews.map((tv) => ({ key: tv.reg.key, priority: tv.reg.priority, locale: tv.reg.locale })))

  const overlay = registrations.find((r) => r.slotName === 'shell.overlay')
  if (overlay === undefined || overlay.reg.id !== 'change-history-file-viewer' || overlay.reg.locale !== 'changeHistory') {
    throw new Error(`bad shell.overlay registration: ${JSON.stringify(overlay)}`)
  }
  console.log('shell.overlay registration ok:', { id: overlay.reg.id, locale: overlay.reg.locale })

  const turnTail = registrations.find((r) => r.slotName === 'conversation.chat.turnTail')
  if (turnTail === undefined || turnTail.reg.locale !== 'changeHistory' || typeof turnTail.reg.select !== 'function') {
    throw new Error(`bad turn-tail registration: ${JSON.stringify(turnTail?.reg)}`)
  }
  if (turnTail.reg.select({ turn: { turn: 7 } }) !== null) throw new Error('turn-tail selector must ignore a running turn')
  if (turnTail.reg.select({ turn: { turn: 7, end: { time: 123 } } })?.turn !== 7) throw new Error('turn-tail selector must match completed turns')
  console.log('turn-tail review registration ok')

  // SSR of the inline mutation row (settled diff, actions absent until the
  // change resolves — the header + diff surface still render).
  {
    const { ChangeMutationRow } = result.views
    const markup = renderToString(
      react.createElement(ChangeMutationRow, {
        toolName: 'edit',
        block: { callId: 'call-1', resultView: { card: 'diff', title: 'Edit x', diffs: [{ path: '/x/a.js', oldText: 'a', newText: 'b' }] } },
        openFile: () => {},
        t: (key) => key,
      }),
    )
    for (const marker of ['chx_mutationRow', 'chx_mutationTag', 'chx_mutationPath', '/x/a.js']) {
      if (!markup.includes(marker)) throw new Error(`mutation row render missing ${marker}\n${markup}`)
    }
    console.log('mutation row render ok (header + diff surface)')
  }

  // SSR with a fixture-driven manager (two groups, diffs, rollback actions)
  const { ChangeHistorySection, ApprovalPanel, TurnApprovalSummary } = result.views
  const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '')
  const fakeManager = {
    changes: [
      { id: 'c1', sessionId: 's1', sessionTitle: 'Session One', tool: 'edit', path: '/x/a.js', operation: 'edit', before: 'a', after: 'b', createdAt: 1735689600000, status: 'pending', stats: { added: 1, removed: 1 }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' },
      { id: 'c2', sessionId: 's1', sessionTitle: 'Session One', tool: 'write', path: '/x/b.txt', operation: 'create', before: null, after: 'hi', createdAt: 1735689600000, status: 'approved', stats: { added: 1, removed: 0 }, diff: '@@ -1,0 +1,1 @@\n+hi' },
    ],
    groups: [{ sessionId: 's1', sessionTitle: 'Session One', changes: [
      { id: 'c1', sessionId: 's1', sessionTitle: 'Session One', tool: 'edit', path: '/x/a.js', operation: 'edit', before: 'a', after: 'b', createdAt: 1735689600000, status: 'pending', stats: { added: 1, removed: 1 }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' },
      { id: 'c2', sessionId: 's1', sessionTitle: 'Session One', tool: 'write', path: '/x/b.txt', operation: 'create', before: null, after: 'hi', createdAt: 1735689600000, status: 'approved', stats: { added: 1, removed: 0 }, diff: '@@ -1,0 +1,1 @@\n+hi' },
    ] }],
    loading: false,
    error: null,
    busyId: null,
    notice: null,
    refresh: async () => {},
    rollback: async () => true,
    approve: async () => true,
    clearNotice: () => {},
  }
  const markup = renderToString(react.createElement(ChangeHistorySection, { t, manager: fakeManager }))
  for (const marker of ['chx_section', 'chx_rowCard', 'chx_tag', 'a.js', 'b.txt', 'Session One', 'row.rollback.created', 'row.diffLines']) {
    if (!markup.includes(marker)) throw new Error(`fixture render missing ${marker}\n${markup}`)
  }
  console.log('client fixture render ok (groups, diffs, actions)')

  const approvalMarkup = renderToString(react.createElement(ApprovalPanel, { sessionId: 's1', turn: 1, openFile: () => {}, onClose: () => {}, t }))
  if (!approvalMarkup.includes('chx_approvalPanel')) throw new Error(`approval panel render missing\n${approvalMarkup}`)
  const summaryMarkup = renderToString(react.createElement(TurnApprovalSummary, { matched: { turn: 1 }, sessionId: 's1', openFile: () => {}, t }))
  if (summaryMarkup !== '') throw new Error(`turn summary must stay absent while its background request is pending\n${summaryMarkup}`)
  console.log('approval views render ok')
}

console.log('change-history test PASSED')
