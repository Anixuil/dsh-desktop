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

// 4. delete a live session is refused
{
  mockCtx.sessions.get = (id) => (id === 'session-1' ? {} : undefined);
  const res = fakeRes();
  const body = JSON.stringify({ id: 'session-1' });
  const req = { method: 'POST', url: '/desktop-sessions/delete', [Symbol.asyncIterator]: async function* () { yield body; } };
  await routeHandler(req, res);
  const payload = JSON.parse(res.body);
  if (res.status !== 409 || payload.ok !== false || payload.code !== 'live') throw new Error(`live guard failed: ${res.status} ${res.body}`);
  console.log('live guard ok');
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

rmSync(home, { recursive: true, force: true });
console.log('session-manager host smoke test PASSED');
