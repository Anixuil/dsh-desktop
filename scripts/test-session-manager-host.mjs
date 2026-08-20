// Host-side smoke test for dsh-desktop-session-manager: materializes apply()
// against a mock cordis ctx, then drives the registered web route handler
// with fake req/res objects. Exercises the plugin entry, the /desktop-sessions
// router, and the real session index scan (against a temp DSH home).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import('./session-manager/index.js');
if (plugin.name !== 'dsh-desktop-session-manager') throw new Error(`bad plugin name ${plugin.name}`);
if (!plugin.inject.includes('webServer')) throw new Error('inject must include webServer');

// temp DSH home with two fake sessions + projection cache rows (one archived)
const home = mkdtempSync(join(tmpdir(), 'dsm-host-test-'));
const wsDir = join(home, 'sessions', '--fake-ws--', 'session-1');
mkdirSync(wsDir, { recursive: true });
writeFileSync(join(wsDir, 'session.jsonl.zstd'), 'not really zstd — index scan only checks the dir');
const archDir = join(home, 'sessions', '--fake-ws--', 'session-archived-9');
mkdirSync(archDir, { recursive: true });
writeFileSync(join(archDir, 'session.jsonl.zstd'), 'not really zstd — index scan only checks the dir');
mkdirSync(join(home, 'storages'), { recursive: true });
writeFileSync(
  join(home, 'storages', 'session_projcache.json'),
  JSON.stringify({
    tables: {
      sessions: {
        'session-1': {
          identity: { createdAt: 1700000000000, cwd: 'fake-ws' },
          rows: { title: { val: 'hello' }, tokenUsage: { val: { totals: { outputTokens: 42 } } }, sessionStats: { val: { turns: 2 } } },
        },
        'session-archived-9': {
          identity: { createdAt: 1700000001000, cwd: 'fake-ws' },
          rows: { title: { val: 'archived one' }, tokenUsage: { val: { totals: { outputTokens: 7 } } }, sessionStats: { val: { turns: 1 } } },
        },
      },
    },
  }),
);

let routeHandler = null;
const mockCtx = {
  effect: (fn) => { fn(); return () => {}; },
  webServer: {
    register: (registration) => {
      if (registration.kind !== 'prefix' || registration.path !== '/desktop-sessions') {
        throw new Error(`unexpected registration: ${JSON.stringify({ kind: registration.kind, path: registration.path })}`);
      }
      routeHandler = registration.handler;
    },
  },
  sessions: { get: () => undefined },
  workspaceRegistry: { archivedSessionIds: ['session-archived-9'], enqueueOperation: (fn) => fn(), requireState: () => ({ archivedSessionIds: ['session-archived-9'] }), setState: async (state) => { mockCtx.workspaceRegistry.state = state; } },
  sessionQuery: null,
};

process.env.DSH_HOME = home;
plugin.apply(mockCtx, {});
if (routeHandler === null) throw new Error('route handler never registered');

// fake req/res
const fakeRes = () => {
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? {}; };
  res.end = (body) => { res.body = String(body); };
  return res;
};

// 1. ping
{
  const res = fakeRes();
  await routeHandler({ method: 'GET', url: '/desktop-sessions/ping', [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }, res);
  if (res.status !== 200 || !res.body.includes('"ok":true')) throw new Error(`ping failed: ${res.status} ${res.body}`);
  console.log('ping ok');
}

// 2. list (real scan over the temp home)
{
  const res = fakeRes();
  await routeHandler({ method: 'GET', url: '/desktop-sessions/list', [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 200 || payload.ok !== true) throw new Error(`list failed: ${res.status} ${res.body}`);
  const row = payload.sessions.find((s) => s.id === 'session-1');
  if (row === undefined) throw new Error('session-1 missing from list');
  if (row.title !== 'hello' || row.archived !== false || row.tokens.output !== 42 || row.turns !== 2) {
    throw new Error(`bad row shape: ${JSON.stringify(row)}`);
  }
  // regression: a session in the registry's archived set MUST read archived=true
  const archivedRow = payload.sessions.find((s) => s.id === 'session-archived-9');
  if (archivedRow === undefined) throw new Error('session-archived-9 missing from list');
  if (archivedRow.archived !== true) throw new Error(`archived flag lost: ${JSON.stringify(archivedRow)}`);
  console.log('list ok:', JSON.stringify(payload.sessions));
  console.log('list ok:', JSON.stringify(payload.sessions));
}

// 3. unarchive through the patched registry (write-path check)
{
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-archived-9' });
  const req = { method: 'POST', url: '/desktop-sessions/unarchive', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  if (res.status !== 200 || !res.body.includes('"ok":true')) throw new Error(`unarchive failed: ${res.status} ${res.body}`);
  const state = mockCtx.workspaceRegistry.state;
  if (state.archivedSessionIds.includes('session-archived-9')) throw new Error('registry state still contains the id');
  console.log('unarchive ok:', JSON.stringify(state.archivedSessionIds));
}

// 4. delete an attached session whose store internals are unreachable (a
//    future dsh build, or a bare mock) degrades to the old refusal
{
  mockCtx.sessions.get = (id) => (id === 'session-1' ? {} : undefined);
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-1' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 409 || payload.ok !== false || payload.code !== 'live') throw new Error(`degrade guard failed: ${res.status} ${res.body}`);
  console.log('degrade guard ok');
}

// 5. delete a non-live session removes the dir and purges the cache
{
  mockCtx.sessions.get = () => undefined;
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-1' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 200 || payload.ok !== true) throw new Error(`delete failed: ${res.status} ${res.body}`);
  const { existsSync, readFileSync } = await import('node:fs');
  if (existsSync(wsDir)) throw new Error('session dir still exists after delete');
  const proj = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache.json'), 'utf8'));
  if ('session-1' in (proj.tables?.sessions ?? {})) throw new Error('projcache row still present after delete');
  console.log('delete ok:', JSON.stringify(payload));
}

// 6. an attached-but-idle session (the archived case: still resident in the
//    host session store, idle agent) is released through the store entry's
//    detach and then deleted
{
  const attachedDir = join(home, 'sessions', '--fake-ws--', 'session-attached-7');
  mkdirSync(attachedDir, { recursive: true });
  writeFileSync(join(attachedDir, 'session.jsonl.zstd'), 'attached idle session');
  const store = new Map();
  store.set('session-attached-7', { detach: () => { store.delete('session-attached-7'); } });
  mockCtx.sessions = {
    get: (id) => (id === 'session-attached-7'
      ? { id: 'session-attached-7', header: { id: 'session-attached-7', origin: 'root' } }
      : undefined),
    store,
  };
  mockCtx.agents = { get: () => ({ status: 'idle', inbox: { hasPending: false } }), isOwnedBy: () => false };
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-attached-7' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 200 || payload.ok !== true) throw new Error(`attached-idle delete failed: ${res.status} ${res.body}`);
  const { existsSync: exists2 } = await import('node:fs');
  if (exists2(attachedDir)) throw new Error('attached session dir still exists after delete');
  if (store.has('session-attached-7')) throw new Error('store entry was not detached');
  console.log('attached-idle delete ok:', JSON.stringify(payload));
}

// 7. an attached session with work in flight (running agent) is refused
{
  mockCtx.sessions.get = (id) => (id === 'session-running-8'
    ? { id: 'session-running-8', header: { id: 'session-running-8', origin: 'root' } }
    : undefined);
  mockCtx.sessions.store = new Map();
  mockCtx.agents = {
    get: () => ({ status: 'running', inbox: { hasPending: false } }),
    isOwnedBy: () => false,
  };
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-running-8' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 409 || payload.ok !== false || payload.code !== 'live') throw new Error(`running guard failed: ${res.status} ${res.body}`);
  console.log('running guard ok:', JSON.stringify(payload));
}

// 7b. an attached session with an idle agent but unclaimed inbox input is refused
{
  mockCtx.sessions.get = (id) => (id === 'session-pending-8b'
    ? { id: 'session-pending-8b', header: { id: 'session-pending-8b', origin: 'root' } }
    : undefined);
  mockCtx.sessions.store = new Map();
  mockCtx.agents = {
    get: () => ({ status: 'idle', inbox: { hasPending: true } }),
    isOwnedBy: () => false,
  };
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-pending-8b' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 409 || payload.ok !== false || payload.code !== 'live') throw new Error(`pending-inbox guard failed: ${res.status} ${res.body}`);
  console.log('pending-inbox guard ok:', JSON.stringify(payload));
}

// 8. a subagent-owned attached session is refused regardless of idle state
{
  mockCtx.sessions.get = (id) => (id === 'session-child-9'
    ? { id: 'session-child-9', header: { id: 'session-child-9', origin: 'subagent' } }
    : undefined);
  mockCtx.sessions.store = new Map();
  mockCtx.agents = { get: () => undefined, isOwnedBy: () => false };
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-child-9' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 409 || payload.ok !== false || payload.code !== 'live') throw new Error(`subagent guard failed: ${res.status} ${res.body}`);
  console.log('subagent guard ok:', JSON.stringify(payload));
}

// 9. sidebar session-delete patch: pure-function behaviour over the REAL
//    shipped workspace bundle (when the runtime tree is present), idempotence,
//    graceful degradation, and syntax validity of the patched output.
{
  const { applyWorkspaceDeletePatch, WORKSPACE_BUNDLE_ID, WORKSPACE_DELETE_MARKER } = await import('./session-manager/lib/workspace-patch.js');
  const nodePath = join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  const { existsSync: bundleExists, copyFileSync, readFileSync: readBundle } = await import('node:fs');
  if (bundleExists(nodePath)) {
    // Patch a pristine COPY of the shipped bundle: the live runtime file may
    // already carry the marker from a real boot, which is exactly the state
    // the function must tolerate without re-patching.
    const workDir = mkdtempSync(join(tmpdir(), 'dsm-workspace-patch-'));
    const bundleCopy = join(workDir, 'client.js');
    copyFileSync(nodePath, bundleCopy);
    const source = readBundle(bundleCopy, 'utf8');
    // The live runtime file may already carry the marker from a real boot; the
    // function must tolerate that state (either reporting 'already patched' or
    // self-healing an older patch), so always run it against the copy.
    const applied = applyWorkspaceDeletePatch(source);
    if (!applied.applied && applied.reason !== 'already patched') {
      throw new Error(`workspace patch failed against real bundle: ${applied.reason}`);
    }
    const out = applied.source;
    for (const needle of [
      WORKSPACE_DELETE_MARKER,
      'id: "delete",',
      'if (id === "delete") onDelete(node.id, row.title);',
      'onDelete: onSessionDelete,',
      'confirmSessionDelete',
      'deleteSession: async (sessionId) => {',
      'clearCurrent: () => {',
      'refreshSessions: () => {',
      '"menu.deleteSession"',
      '"delete.session.title"',
    ]) {
      if (!out.includes(needle)) throw new Error(`patched bundle missing ${needle}`);
    }
    if ((out.split('onDelete: onSessionDelete,').length - 1) !== 2) throw new Error('onDelete forwarded at exactly two call sites');
    // regression: the session-delete modal must be a comma-separated sibling of
    // the workspace-delete modal. A missing comma is still VALID syntax (it
    // parses as a call chain) but throws "jsxs is not a function" at render —
    // which blanked the sidebar. Pin the exact seam.
    const TAB = '\t';
    const modalSeam = `${TAB.repeat(5)}}),\n${TAB.repeat(5)}(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {\n${TAB.repeat(6)}open: sessionDeleteTarget !== null,`;
    if (!out.includes(modalSeam)) throw new Error('session-delete modal not comma-separated from the workspace-delete modal');
    // syntax check (parse without executing: the bundle needs window.__ModuleLoader__)
    const vm = await import('node:vm');
    new vm.Script(out, { filename: 'patched-workspace-client.js' });
    // idempotence: a second pass over the copy is a no-op
    const again = applyWorkspaceDeletePatch(out);
    if (again.applied !== false || again.reason !== 'already patched') throw new Error(`re-patch should be a no-op: ${again.reason}`);
    console.log('workspace bundle patch ok (real bundle, syntax ok, idempotent)');
  } else {
    console.log('workspace bundle patch: runtime bundle absent, skipping real-bundle case');
  }
  // degradation: anchors missing -> nothing written, loud reason
  const nonsense = applyWorkspaceDeletePatch('function navIcon(id) { return null; }\n');
  if (nonsense.applied !== false || !String(nonsense.reason).includes('anchor mismatch')) {
    throw new Error(`unexpected degradation result: ${nonsense.reason}`);
  }
  console.log('workspace bundle patch degradation ok');
}

// 10. wiring: plugin activation patches the bundle the client-modules registry
//     reports and refreshes its revision (exercised against a copy of the real
//     shipped bundle so the anchors resolve; skipped when the runtime is absent)
{
  const { WORKSPACE_BUNDLE_ID } = await import('./session-manager/lib/workspace-patch.js');
  const realBundle = join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  const { existsSync: realExists, copyFileSync, readFileSync: readSync } = await import('node:fs');
  if (!realExists(realBundle)) {
    console.log('workspace bundle patch wiring: runtime bundle absent, skipping');
  } else {
    const wsHome = mkdtempSync(join(tmpdir(), 'dsm-patch-wiring-'));
    const bundlePath = join(wsHome, 'client.js');
    copyFileSync(realBundle, bundlePath);
    const before = readSync(bundlePath, 'utf8');
    const wasPristine = !before.includes('dsh-desktop-session-delete');
    const rebuiltIds = [];
    const fakeClientModules = {
      clientPath: (id) => (id === WORKSPACE_BUNDLE_ID ? bundlePath : undefined),
      rebuilt: (id) => { rebuiltIds.push(id); },
    };
    const wiringCtx = {
      effect: (fn) => { fn(); return () => {}; },
      get: (name) => (name === 'clientModules' ? fakeClientModules : undefined),
      logger: { info: () => {}, warn: (msg) => { throw new Error(`unexpected warn: ${msg}`); } },
      webServer: { register: () => () => {} },
      sessions: { get: () => undefined },
      workspaceRegistry: { archivedSessionIds: [], enqueueOperation: (fn) => fn(), requireState: () => ({ archivedSessionIds: [] }), setState: async () => {} },
      sessionQuery: null,
    };
    const hostModule = await import('./session-manager/index.js');
    hostModule.apply(wiringCtx, {});
    const patchedSource = readSync(bundlePath, 'utf8');
    if (!patchedSource.includes('dsh-desktop-session-delete')) throw new Error('wiring did not patch the reported bundle');
    // The rev refresh only fires when the patch actually wrote the file: a
    // pristine bundle is patched and an older patched bundle is self-healed,
    // while an up-to-date bundle is intentionally left untouched.
    const changed = patchedSource !== before;
    if (changed && !rebuiltIds.includes(WORKSPACE_BUNDLE_ID)) throw new Error('wiring did not refresh the bundle revision');
    console.log(`workspace bundle patch wiring ok (${wasPristine ? 'patched' : changed ? 'self-healed' : 'already patched, untouched'})`);
  }
}

rmSync(home, { recursive: true, force: true });
console.log('session-manager host smoke test PASSED');
