// Fixture-driven tests for the bridge client's pure view layer
// (BalancePanelView, exported by the modular bundle). Covers the data states
// the equivalence snapshot cannot reach via SSR: legacy balance payload,
// multi-provider cards, loaded usage report, usage error, empty usage.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'runtime', 'dsh', 'package.json'));
const react = require('react');
const { renderToString } = require('react-dom/server');

globalThis.window = globalThis;
globalThis.document = {
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.__ModuleLoader__ = {
  load: ({ id, factory }) => { globalThis.__ModuleLoader__Factory = factory; },
};

// Icons render nothing; wrapper components pass children through.
const stubPrimitives = new Proxy({}, { get: () => (props) => props?.children ?? null });
// jsx(type, props, key): React's createElement third arg is children, NOT
// key — rebuild props so a key argument cannot clobber props.children.
const jsxStub = (type, props, key) => {
  const copy = props === null || props === undefined ? {} : { ...props };
  if (key !== undefined) copy.key = key;
  return react.createElement(type, copy);
};
const sandbox = {
  window: globalThis,
  document: globalThis.document,
  console,
  require: (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub, Fragment: react.Fragment };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives;
    return {};
  },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(repoRoot, 'scripts', 'bridge', 'client.js'), 'utf8'), sandbox);
const factory = globalThis.__ModuleLoader__Factory;
const result = factory(sandbox.require);
if (typeof result.views?.BalancePanelView !== 'function') throw new Error('bundle must export views.BalancePanelView');
if (typeof result.views?.AboutSectionView !== 'function') throw new Error('bundle must export views.AboutSectionView');

const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const noop = () => {};
const render = (props) => renderToString(react.createElement(result.views.BalancePanelView, {
  t,
  balance: null,
  error: false,
  usage: null,
  usageError: false,
  refreshing: false,
  onRefresh: noop,
  onClose: noop,
  panelRef: null,
  ...props,
}));

const usageFixture = {
  ok: true, since: null, fromAllTime: true, generatedAt: 0,
  totals: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, total: 1700 },
  byModel: [{ model: 'deepseek-chat', provider: 'deepseek', sessions: 1, tokens: { total: 1700 } }],
  byDay: [{ date: '2025-01-01', total: 1700, output: 500, sessions: 1 }],
  sessions: [{ id: 'session-1', title: 'My Session', createdAt: 1735689600000, tokens: { total: 1700 }, turns: 2, model: 'deepseek-chat' }],
  counts: { sessions: 1, activeDays: 1, scannedModels: 0 },
};

// 1. legacy single-balance payload
{
  const markup = render({
    balance: {
      configured: true,
      low: false,
      registeredAt: 1735689600000,
      balance: {
        is_available: true,
        balance_infos: [{ total_balance: '100.00', currency: 'CNY', topped_up_balance: '50.00', granted_balance: '20.00' }],
      },
    },
    usage: usageFixture,
  });
  for (const marker of ['100.00', 'CNY', '50.00', '20.00', 'balance.ok', 'My Session', 'deepseek-chat', 'usage.sessionsCount']) {
    if (!markup.includes(marker)) throw new Error(`legacy render missing ${marker}\n${markup}`);
  }
  console.log('legacy balance render ok');
}

// 2. multi-provider cards
{
  const markup = render({
    balance: {
      configured: true,
      low: false,
      registeredAt: 1735689600000,
      providers: [
        { id: 'deepseek-official', kind: 'balance', configured: true, display_name: 'DeepSeek', balance: { is_available: true, balance_infos: [{ total_balance: '88.00', currency: 'CNY', topped_up_balance: '88.00', granted_balance: '0.00' }] } },
        { id: 'gateway', kind: 'usage', configured: true, display_name: 'Gateway', usage: { total_usage_usd: 12.34, soft_limit_usd: 100, hard_limit_usd: 200, has_payment_method: true } },
        { id: 'unsupported', kind: 'unsupported', configured: true, display_name: 'UnsupportedCo' },
        { id: 'unconfigured', kind: 'balance', configured: false, display_name: 'NoKeyCo' },
        { id: 'broken', kind: 'balance', configured: true, error: 'boom', display_name: 'BrokenCo' },
      ],
    },
    usage: usageFixture,
  });
  for (const marker of ['DeepSeek', '88.00', 'Gateway', '$12.34', 'UnsupportedCo', 'balance.unsupported', 'NoKeyCo', 'badge.unconfigured', 'BrokenCo', 'boom', 'usage.paymentYes']) {
    if (!markup.includes(marker)) throw new Error(`providers render missing ${marker}\n${markup}`);
  }
  console.log('multi-provider render ok');
}

// 3. usage error state
{
  const markup = render({ balance: { configured: true }, usageError: true });
  if (!markup.includes('usage.error')) throw new Error(`usage error state missing marker\n${markup}`);
  console.log('usage error render ok');
}

// 4. empty usage state
{
  const markup = render({ balance: { configured: true }, usage: null });
  if (!markup.includes('usage.empty')) throw new Error(`empty usage state missing marker\n${markup}`);
  console.log('empty usage render ok');
}

// 5. about section view: identity rows + update/action markers
{
  const renderAbout = (props) => renderToString(react.createElement(result.views.AboutSectionView, {
    t,
    info: null,
    loadError: null,
    update: null,
    busy: false,
    notice: null,
    onOpen: noop,
    onCheck: noop,
    ...props,
  }));
  const markup = renderAbout({
    info: { ok: true, appName: 'DSH Desktop', appVersion: '0.1.0', dshVersion: '0.1.0-rc.6', author: 'Anixuil', blog: 'https://www.anixuil.top', repo: 'https://github.com/Anixuil/dsh-desktop' },
    update: { checking: false, status: { ok: true, appCurrent: '0.1.0', appLatest: '0.2.0', appUpdateAvailable: true, appUrl: 'https://github.com/Anixuil/dsh-desktop/releases/tag/v0.2.0', dshUpdateAvailable: false } },
  });
  for (const marker of ['about.title', 'Anixuil', 'DSH Desktop', 'www.anixuil.top', 'github.com/Anixuil/dsh-desktop', 'about.appUpdate', '0.2.0', 'about.release', 'about.repoBtn', 'about.check']) {
    if (!markup.includes(marker)) throw new Error(`about render missing ${marker}\n${markup}`);
  }
  const latest = renderAbout({ info: null, update: { checking: false, status: { ok: true } } });
  if (!latest.includes('about.latest')) throw new Error(`about latest state missing\n${latest}`);
  const err = renderAbout({ info: null, loadError: 'boom', update: null });
  if (!err.includes('about.offline') || !err.includes('boom')) throw new Error(`about offline state missing\n${err}`);
  console.log('about section render ok');
}

console.log('bridge views fixture tests PASSED');
