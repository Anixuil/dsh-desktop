// Simulate the DSH browser module loader enough to materialize
// dsh-desktop-session-manager's client bundle: real react, stub UI
// primitives (Proxy — every icon/component resolves to a children
// passthrough), mock client ctx. Asserts the factory registers the settings
// section correctly, that the section renders to static markup (loading
// state), and that fixture-driven managers render both row groups with the
// settings visual language.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(new URL('../runtime/dsh/package.json', import.meta.url));
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
  load: ({ id, factory }) => {
    console.log(`__ModuleLoader__.load(${id})`);
    globalThis.__ModuleLoader__Factory = factory;
  },
};

const registrations = [];
const mockCtx = {
  effect: (fn) => { fn(); return () => {}; },
  locale: {
    register: (ns, dicts) => {
      console.log(`locale.register(${ns}) zh keys=${Object.keys(dicts.zh).length} en keys=${Object.keys(dicts.en).length}`);
      for (const key of Object.keys(dicts.zh)) {
        if (!(key in dicts.en)) throw new Error(`locale key missing in en: ${key}`);
      }
    },
    bind: (ns) => (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
  },
  slots: {
    register: (opts, component) => ({ opts, component }),
    inject: (slotName, cb) => {
      const reg = cb();
      registrations.push({ slotName, reg: reg.opts, component: reg.component });
    },
  },
  on: () => {},
};

// Icons render nothing; wrapper components (Tooltip/Modal) pass children through.
const stubPrimitives = new Proxy({}, { get: () => (props) => props?.children ?? null });

const sandbox = {
  window: globalThis,
  document: globalThis.document,
  console,
  require: (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives;
    return {};
  },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('./scripts/session-manager/client.js', new URL('../', import.meta.url)), 'utf8'), sandbox);
const factory = globalThis.__ModuleLoader__Factory;
if (typeof factory !== 'function') throw new Error('client bundle never registered via __ModuleLoader__.load');
const result = factory(sandbox.require);

if (typeof result.apply !== 'function') throw new Error('client bundle did not export apply');
if (!Array.isArray(result.inject) || !result.inject.includes('slots')) throw new Error('client bundle inject must include slots');
if (!result.inject.includes('locale')) throw new Error('client bundle inject must include locale');

result.apply(mockCtx);
console.log(`registrations: ${registrations.length}`);
if (registrations.length !== 1) throw new Error(`expected 1 slot registration, got ${registrations.length}`);
for (const { slotName, reg } of registrations) {
  if (slotName !== 'settings.section') throw new Error(`unexpected slot ${slotName}`);
  if (reg.name !== 'settings.section') throw new Error(`bad reg name ${reg.name}`);
  if (reg.id !== 'session-manager') throw new Error(`bad reg id ${reg.id}`);
  if (reg.order !== 20) throw new Error(`bad reg order ${reg.order}`);
  if (typeof reg.label !== 'function' || reg.label() !== 'nav') throw new Error('registration label must be a localized nav function');
  if (typeof reg.inject !== 'function') throw new Error('registration inject missing');
  console.log('slot registration ok:', { name: reg.name, id: reg.id, order: reg.order, label: reg.label(), locale: reg.locale });
}

// 1. SSR of the production wiring (hook loads on mount -> loading state)
{
  const first = registrations[0];
  const injected = first.reg.inject();
  const markup = renderToString(
    react.createElement(first.component, { ...injected, close: () => {} }),
  );
  if (!markup.includes('smx_section')) throw new Error('rendered markup missing the section class');
  if (!markup.includes('title')) throw new Error('rendered markup missing the section title');
  console.log(`static render ok (loading state): ${markup.length} chars`);
}

// 2. fixture-driven manager: archived + active groups render settings-style rows
{
  const { SessionManagerSection, SessionRow } = result.views;
  const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
  const fakeManager = {
    sessions: [
      { id: 's-arch', title: 'Archived One', createdAt: 1735689600000, archived: true, tokens: { total: 1200 }, turns: 2 },
      { id: 's-1', title: 'Active One', createdAt: 1735689600000, archived: false, tokens: { total: 3000000 }, turns: 5 },
    ],
    loading: false,
    error: null,
    busyId: null,
    notice: null,
    archivedCount: 1,
    refresh: async () => {},
    remove: async () => true,
    unarchive: async () => true,
    clearNotice: () => {},
  };
  const sessionsService = {
    list: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: 's-1' }),
    },
    open: () => {},
  };
  const markup = renderToString(
    react.createElement(SessionManagerSection, { t, sessions: sessionsService, close: () => {}, manager: fakeManager }),
  );
  for (const marker of ['smx_section', 'smx_rowCard', 'Archived One', 'Active One', 'row.restore', 'row.delete', 'row.meta.tokens']) {
    if (!markup.includes(marker)) throw new Error(`fixture render missing ${marker}\n${markup}`);
  }
  console.log('fixture render ok (both groups, actions, meta)');
  // the current-session state (tag + disabled delete) is client-rendered data
  // (useSyncExternalStore server snapshot is null) — assert via SessionRow directly
  const rowMarkup = renderToString(
    react.createElement(SessionRow, {
      row: { id: 's-1', title: 'Active One', createdAt: null, archived: false, tokens: null, turns: null },
      current: true,
      busy: false,
      onOpen: () => {},
      onDelete: () => {},
      onRestore: () => {},
      t,
    }),
  );
  for (const marker of ['row.current', 'disabled']) {
    if (!rowMarkup.includes(marker)) throw new Error(`current row render missing ${marker}\n${rowMarkup}`);
  }
  console.log('current row render ok (tag + disabled delete)');
}

// 3. mergeArchivedFlags unit check (client-side live archive overlay)
{
  const { mergeArchivedFlags } = result.views;
  const rows = [
    { id: 'a', archived: false, title: 'A' },
    { id: 'b', archived: true, title: 'B' },
    { id: 'c', archived: false, title: 'C' },
  ];
  const merged = mergeArchivedFlags(rows, ['a', 'c']);
  if (merged.find((r) => r.id === 'a')?.archived !== true) throw new Error('merge must mark a archived');
  if (merged.find((r) => r.id === 'b')?.archived !== true) throw new Error('merge must keep b archived');
  if (merged.find((r) => r.id === 'c')?.archived !== true) throw new Error('merge must mark c archived');
  if (mergeArchivedFlags(rows, []) !== rows) throw new Error('empty archive set must be a no-op');
  if (mergeArchivedFlags(rows, null) !== rows) throw new Error('null archive set must be a no-op');
  console.log('mergeArchivedFlags ok');
}

console.log('session-manager client bundle smoke test PASSED');
