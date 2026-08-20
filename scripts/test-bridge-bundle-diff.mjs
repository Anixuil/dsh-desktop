// Equivalence harness for the dsh-desktop-bridge client bundle.
//
// The pre-split client.js was a hand-maintained bundle without source, so the
// modular rewrite needs a migration safety net: BEFORE the split, `--record`
// snapshots the old bundle's SSR output (closed trigger, wide + rail variants)
// plus its slot-registration metadata into scripts/bridge/test/legacy-snapshot.json.
// After the split the test (without --record) renders the new bundle and
// requires byte-identical output.
//
// Usage:
//   node scripts/test-bridge-bundle-diff.mjs --record   # capture fixture from current client.js
//   node scripts/test-bridge-bundle-diff.mjs            # verify current client.js matches fixture
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(repoRoot, 'scripts', 'bridge', 'client.js');
const fixturePath = join(repoRoot, 'scripts', 'test-fixtures', 'bridge-legacy-snapshot.json');
const record = process.argv.includes('--record');

const require = createRequire(join(repoRoot, 'runtime', 'dsh', 'package.json'));
const react = require('react');
const { renderToString } = require('react-dom/server');

// The legacy bundle (and its verbatim successor) call useSyncExternalStore
// without a getServerSnapshot — fine in the browser, fatal under renderToString.
// Patch react for the sandbox only: both bundles render under the same harness.
const sandboxReact = {
  ...react,
  useSyncExternalStore: (subscribe, getSnapshot) =>
    react.useSyncExternalStore(subscribe, getSnapshot, () => null),
};

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
    globalThis.__ModuleLoader__Factory = factory;
    console.log(`__ModuleLoader__.load(${id})`);
  },
};

const registrations = [];
const mockCtx = {
  effect: (fn) => { fn(); return () => {}; },
  locale: {
    register: () => {},
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
    if (id === 'react') return sandboxReact;
    if (id === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub, Fragment: react.Fragment };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives;
    return {};
  },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox);
const factory = globalThis.__ModuleLoader__Factory;
if (typeof factory !== 'function') throw new Error('client bundle never registered via __ModuleLoader__.load');
const result = factory(sandbox.require);
result.apply(mockCtx);

if (registrations.length !== 4) throw new Error(`expected 4 registrations, got ${registrations.length}`);
const balanceReg = registrations.find((r) => r.slotName === 'sidebar.footer.action');
const aboutReg = registrations.find((r) => r.slotName === 'settings.section' && r.reg.id === 'about');
const remoteReg = registrations.find((r) => r.slotName === 'settings.section' && r.reg.id === 'remote-access');
const appearanceReg = registrations.find((r) => r.slotName === 'settings.section' && r.reg.id === 'appearance');
if (!balanceReg || !aboutReg || !remoteReg || !appearanceReg) throw new Error(`missing bridge registrations: ${registrations.map((r) => r.slotName).join(', ')}`);
const { reg, component } = balanceReg;
const injected = reg.inject();
const renderVariant = (wide) =>
  renderToString(react.createElement(component, { wide, ...injected }));

const snapshot = {
  registration: { slot: reg.name, id: reg.id, order: reg.order, locale: reg.locale },
  renders: {
    wide: renderVariant(true),
    rail: renderVariant(false),
  },
};

if (record) {
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`legacy snapshot recorded -> ${fixturePath}`);
  process.exit(0);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
for (const key of ['slot', 'id', 'order', 'locale']) {
  if (snapshot.registration[key] !== fixture.registration[key]) {
    throw new Error(`registration mismatch on ${key}: ${JSON.stringify(snapshot.registration[key])} !== ${JSON.stringify(fixture.registration[key])}`);
  }
}
for (const variant of ['wide', 'rail']) {
  const current = snapshot.renders[variant];
  const expected = fixture.renders[variant];
  if (current !== expected) {
    throw new Error(
      `SSR render mismatch (${variant}):\n--- expected (legacy) ---\n${expected}\n--- current ---\n${current}`,
    );
  }
  console.log(`render ${variant} matches legacy snapshot (${current.length} chars)`);
}

// the 关于 (About) settings section: id/order contract the settings shell
// and the desktop nav-icon patch rely on
if (aboutReg.reg.id !== 'about' || aboutReg.reg.order !== 30) {
  throw new Error(`about registration mismatch: ${JSON.stringify(aboutReg.reg)}`);
}
console.log('about settings.section registration ok (id=about, order=30)');
if (appearanceReg.reg.id !== 'appearance' || appearanceReg.reg.order !== 5) {
  throw new Error(`appearance registration mismatch: ${JSON.stringify(appearanceReg.reg)}`);
}
console.log('appearance settings.section registration ok (id=appearance, order=5)');
console.log('bridge client bundle equivalence test PASSED');
