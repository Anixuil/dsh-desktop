// Simulate the DSH browser module loader enough to materialize
// dsh-desktop-bridge's client bundle: real react, stub UI packages,
// mock client ctx. Asserts the factory registers the slot correctly.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(new URL('../runtime/dsh/package.json', import.meta.url));
const react = require('react');
const jsxRuntime = require('react/jsx-runtime');

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
// controllable focused-session state + captured POSTs for the focus publisher
let currentSessionId = null;
const sessionListeners = new Set();
const focusPosts = [];
const mockCtx = {
  effect: (fn) => { fn(); return () => {}; },
  locale: {
    register: (ns, dicts) => {
      console.log(`locale.register(${ns}) zh keys=${Object.keys(dicts.zh).length} en keys=${Object.keys(dicts.en).length}`);
    },
    bind: (ns) => (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
  },
  slots: {
    register: (opts) => opts,
    inject: (slotName, cb) => {
      const reg = cb();
      registrations.push({ slotName, reg });
    },
  },
  on: () => {},
  sessions: {
    list: {
      subscribe: (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); },
      getSnapshot: () => ({ current: currentSessionId }),
    },
  },
};

let factory;
const loaderCode = readFileSync(new URL('./scripts/bridge/client.js', new URL('../', import.meta.url)), 'utf8');
const sandbox = {
  window: globalThis,
  document: globalThis.document,
  console,
  fetch: async (url, init) => {
    if (String(url).endsWith('/desktop/current-session')) {
      focusPosts.push(JSON.parse(init?.body ?? '{}'));
    }
    return { ok: true };
  },
  require: (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    return {}; // stub the @deepseek-ai UI packages (unused in apply paths)
  },
};
vm.createContext(sandbox);
vm.runInContext(loaderCode, sandbox);
factory = globalThis.__ModuleLoader__Factory;
if (typeof factory !== 'function') throw new Error('client bundle never registered via __ModuleLoader__.load');
const result = factory(sandbox.require);

if (typeof result.apply !== 'function') throw new Error('client bundle did not export apply');
if (!Array.isArray(result.inject) || !result.inject.includes('slots')) throw new Error('client bundle inject must include slots');

result.apply(mockCtx);

// the focus publisher should announce the initial (null) focus once, then
// re-announce whenever the focused session changes
if (focusPosts.length !== 1 || focusPosts[0].sessionId !== null) {
  throw new Error(`focus publisher initial publish mismatch: ${JSON.stringify(focusPosts)}`);
}
currentSessionId = 'session-7';
for (const fn of [...sessionListeners]) fn();
if (focusPosts.length !== 2 || focusPosts[1].sessionId !== 'session-7') {
  throw new Error(`focus publisher change publish mismatch: ${JSON.stringify(focusPosts)}`);
}
console.log('focus publisher ok:', JSON.stringify(focusPosts));

console.log(`registrations: ${registrations.length}`);
if (registrations.length !== 4) throw new Error(`expected 4 registrations, got ${registrations.length}`);
for (const { slotName, reg } of registrations) {
  if (slotName === 'sidebar.footer.action') {
    if (reg.name !== 'sidebar.footer.action') throw new Error(`bad reg name ${reg.name}`);
    if (reg.id !== 'desktop-balance') throw new Error(`bad reg id ${reg.id}`);
    if (typeof reg.inject !== 'function') throw new Error('registration inject missing');
    console.log('slot registration ok:', { name: reg.name, id: reg.id, order: reg.order, locale: reg.locale });
  } else if (slotName === 'settings.section' && reg.id === 'remote-access') {
    if (reg.name !== 'settings.section') throw new Error(`bad reg name ${reg.name}`);
    if (reg.order !== 10) throw new Error(`bad remote-access reg order ${reg.order}`);
    if (typeof reg.label !== 'function' || typeof reg.inject !== 'function') {
      throw new Error('remote-access registration label/inject missing');
    }
    console.log('remote-access section registration ok:', { name: reg.name, id: reg.id, order: reg.order });
  } else if (slotName === 'settings.section' && reg.id === 'appearance') {
    if (reg.name !== 'settings.section') throw new Error(`bad reg name ${reg.name}`);
    if (reg.order !== 5) throw new Error(`bad appearance reg order ${reg.order}`);
    if (typeof reg.label !== 'function' || typeof reg.inject !== 'function') {
      throw new Error('appearance registration label/inject missing');
    }
    console.log('appearance section registration ok:', { name: reg.name, id: reg.id, order: reg.order });
  } else if (slotName === 'settings.section') {
    if (reg.name !== 'settings.section') throw new Error(`bad reg name ${reg.name}`);
    if (reg.id !== 'about') throw new Error(`bad about reg id ${reg.id}`);
    if (reg.order !== 30) throw new Error(`bad about reg order ${reg.order}`);
    if (typeof reg.label !== 'function' || typeof reg.inject !== 'function') {
      throw new Error('about registration label/inject missing');
    }
    console.log('about section registration ok:', { name: reg.name, id: reg.id, order: reg.order });
  } else {
    throw new Error(`unexpected slot ${slotName}`);
  }
}
console.log('client bundle smoke test PASSED');
