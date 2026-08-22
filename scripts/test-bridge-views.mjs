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
  TextEncoder: globalThis.TextEncoder,
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
if (typeof result.views?.AppearanceSectionView !== 'function') throw new Error('bundle must export views.AppearanceSectionView');
if (typeof result.views?.PluginNetworkSectionView !== 'function') throw new Error('bundle must export views.PluginNetworkSectionView');
if (typeof result.views?.BuiltinPluginsSectionView !== 'function') throw new Error('bundle must export views.BuiltinPluginsSectionView');
if (typeof result.views?.RemoteSectionView !== 'function') throw new Error('bundle must export views.RemoteSectionView');
if (typeof result.remote?.preserveRemoteDraft !== 'function') throw new Error('bundle must export remote.preserveRemoteDraft');
if (typeof result.qr?.qrSvgDataUri !== 'function') throw new Error('bundle must export qr.qrSvgDataUri');
if (typeof result.qr?.matrixFor !== 'function') throw new Error('bundle must export qr.matrixFor');

// 0. zero-dependency QR encoder sanity: data URI shape, payload sensitivity
{
  const url = 'https://anixuil-pc.remote.example.com/?code=123456';
  const uri = result.qr.qrSvgDataUri(url);
  if (!uri.startsWith('data:image/svg+xml')) throw new Error(`qr data uri missing prefix: ${uri.slice(0, 40)}`);
  const other = result.qr.qrSvgDataUri(url.replace('123456', '654321'));
  if (uri === other) throw new Error('qr output must differ per payload');
  let threw = false;
  try {
    result.qr.qrSvgDataUri('x'.repeat(90));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('qr must reject payloads beyond v5-M capacity');
  console.log('qr encoder ok');
}

// 0b. independent decode verification: walk the matrix back into codewords,
//     check the format info reads 0x5412 (ECC M + mask 0), verify every RS
//     block's syndrome is zero with an independently written GF table, and
//     recover the byte-mode payload text.
{
  const url = 'https://anixuil-pc.remote.example.com/?code=123456';
  const m = result.qr.matrixFor(url)
  const n = m.length
  const version = (n - 17) / 4
  if (![1, 2, 3, 4, 5].includes(version)) throw new Error(`unexpected qr version ${version}`)
  // 1) format info, first copy (ISO 18004 fig. 25): bits 0-5 up the left
  //    column (0..5,8), 6 (7,8), 7 (8,8), 8 (8,7), 9-14 along the top row (8,5..0)
  let format = 0
  for (let i = 0; i <= 5; i++) format |= (m[i][8] & 1) << i
  format |= (m[7][8] & 1) << 6
  format |= (m[8][8] & 1) << 7
  format |= (m[8][7] & 1) << 8
  for (let i = 9; i <= 14; i++) format |= (m[8][14 - i] & 1) << i
  if (format !== 0x5412) throw new Error(`format info mismatch: 0x${format.toString(16)} != 0x5412`)
  // 2) de-mask (mask 0: invert when (r+c) even) and de-interleave data + ecc
  const isFunctionModule = (r, c) => {
    if (r === 6 || c === 6) return true // timing
    // format-info cells only (not the whole row/column 8): top-left corner,
    // right edge, bottom edge
    if (r === 8 && c <= 8) return true
    if (c === 8 && r <= 8) return true
    if (c === 8 && r >= n - 8) return true // right format strip incl. dark module (n-8, 8)
    if (r === 8 && c >= n - 8) return true // bottom format strip (bit 7 of copy 2 at (8, n-8))
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      if (r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7) return true // finder + separator
    }
    const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30]]
    for (const ar of ALIGN[version - 1]) {
      for (const ac of ALIGN[version - 1]) {
        const onFinder = (ar <= 8 && ac <= 8) || (ar <= 8 && ac >= n - 9) || (ar >= n - 9 && ac <= 8)
        if (onFinder) continue // alignment overlaps a finder: not drawn
        if (r >= ar - 2 && r <= ar + 2 && c >= ac - 2 && c <= ac + 2) return true // alignment
      }
    }
    return false
  }
  const bits = []
  const skipped = []
  let upward = true
  for (let c = n - 1; c >= 1; c -= 2) {
    if (c === 6) c-- // skip the timing column; direction still toggles this pair
    for (let row = 0; row < n; row++) {
      for (let k = 0; k < 2; k++) {
        const r = upward ? n - 1 - row : row
        const col = c - k
        if (isFunctionModule(r, col)) {
          if (skipped.length < 60) skipped.push(`(${r},${col})`)
          continue
        }
        const masked = m[r][col] & 1
        const data = masked ^ (((r + col) % 2 === 0) ? 1 : 0)
        bits.push(data)
      }
    }
    upward = !upward
  }
  // 3) codewords per version (ECC M): blocks/data/ecc table
  const LAYOUT = [[1, 16, 10], [1, 28, 16], [1, 44, 26], [2, 32, 18], [2, 43, 24]]
  const [blocks, dataPerBlock, eccPerBlock] = LAYOUT[version - 1]
  const totalBytes = blocks * (dataPerBlock + eccPerBlock)
  // remainder bits carry no data; trim the extracted stream to the codeword length
  const dataBits = bits.slice(0, totalBytes * 8)
  const codewords = []
  for (let i = 0; i < totalBytes; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | dataBits[i * 8 + j]
    codewords.push(byte)
  }
  // debug: compare encoder codewords with decoder-extracted codewords
  const { encodeData, interleave, reservedCell } = result.qr._internals
  const expectedBits = encodeData(url, blocks * dataPerBlock * 8)
  const expectedCw = interleave(blocks, dataPerBlock, eccPerBlock, expectedBits)
  const diffs = []
  for (let i = 0; i < expectedCw.length; i++) {
    if (expectedCw[i] !== codewords[i]) diffs.push(`${i}:enc=${expectedCw[i]} ext=${codewords[i]}`)
  }
  if (diffs.length > 0) {
    // compare placement coordinates around the first mismatch
    const { getLastPlacement } = result.qr._internals
    const placement = getLastPlacement()
    const decCoords = []
    let up = true
    for (let c = n - 1; c >= 1; c -= 2) {
      if (c === 6) c--
      for (let row = 0; row < n; row++) {
        for (let k = 0; k < 2; k++) {
          const r = up ? n - 1 - row : row
          const col = c - k
          if (!isFunctionModule(r, col)) decCoords.push([r, col])
        }
      }
      up = !up
    }
    const firstBad = diffs[0].split(':')[0] * 8
    const report = []
    for (let i = firstBad - 6; i < firstBad + 8; i++) {
      const enc = placement[i]
      const dec = decCoords[i]
      report.push(`${i}:enc=${enc ? enc.join(',') : 'undef'} dec=${dec ? dec.join(',') : 'undef'}${enc && dec && (enc[0] !== dec[0] || enc[1] !== dec[1]) ? ' MISMATCH' : ''}`)
    }
    throw new Error(`codeword mismatches (${diffs.length}): ${diffs.slice(0, 8).join(' | ')} | bits=${bits.length} | ${report.join(' | ')}`)
  }
  // de-interleave
  const dataBlocks = []
  for (let b = 0; b < blocks; b++) {
    const block = []
    for (let i = 0; i < dataPerBlock; i++) block.push(codewords[i * blocks + b])
    for (let i = 0; i < eccPerBlock; i++) block.push(codewords[blocks * dataPerBlock + i * blocks + b])
    dataBlocks.push(block)
  }
  // 4) independent GF(256) + RS syndrome check
  const EXP = new Uint8Array(512)
  const LOG = new Uint8Array(256)
  {
    let x = 1
    for (let i = 0; i < 255; i++) {
      EXP[i] = x
      LOG[x] = i
      x <<= 1
      if (x & 0x100) x ^= 0x11d
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  }
  const gmul2 = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]
  for (const block of dataBlocks) {
    // debug: recompute ecc for this data block and compare with the block's tail
    const { rsEcc: encRsEcc } = result.qr._internals
    const recomputed = encRsEcc(block.slice(0, dataPerBlock), eccPerBlock)
    const tail = block.slice(dataPerBlock)
    const eccOk = recomputed.every((v, i) => v === tail[i])
    if (!eccOk) throw new Error(`de-interleave mismatch: recomputed ecc != block tail (data=${block.slice(0, 8).join(',')} tail=${tail.slice(0, 6).join(',')} recomputed=${recomputed.slice(0, 6).join(',')})`)
    // syndrome: evaluate the received polynomial at α^0..α^(ecc-1)
    for (let e = 0; e < eccPerBlock; e++) {
      let acc = 0
      for (const byte of block) acc = gmul2(acc, EXP[e]) ^ byte
      if (acc !== 0) throw new Error(`rs syndrome ${e} != 0: block is corrupted or mis-encoded`)
    }
  }
  // 5) recover byte-mode text
  const first = dataBlocks[0][0]
  if (first >> 4 !== 0b0100) throw new Error(`expected byte mode, got ${first >> 4}`)
  const len = ((first & 0x0f) << 4) | (dataBlocks[0][1] >> 4)
  const textBytes = []
  // Rebuild the original byte order: block 0's data then block 1's data
  // (the interleaved stream spreads blocks byte-by-byte).
  const allData = []
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < dataPerBlock; i++) allData.push(dataBlocks[b][i])
  }
  // bytes start after the 12-bit header: byte 0 low nibble + byte 1 high nibble
  const stream = []
  for (const byte of allData) for (let j = 7; j >= 0; j--) stream.push((byte >> j) & 1)
  const probe = []
  for (let i = 0; i < Math.min(len, 10); i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | stream[12 + i * 8 + j]
    probe.push(byte)
  }
  const expectedProbe = []
  for (let i = 0; i < Math.min(len, 10); i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | expectedBits[12 + i * 8 + j]
    expectedProbe.push(byte)
  }
  if (probe.join(',') !== expectedProbe.join(',')) {
    throw new Error(`byte extraction drift: extracted=${probe.map((b) => b.toString(16)).join(' ')} expected=${expectedProbe.map((b) => b.toString(16)).join(' ')}`)
  }
  for (let i = 0; i < len; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | stream[12 + i * 8 + j]
    textBytes.push(byte)
  }
  const decoded = Buffer.from(textBytes).toString('utf8')
  if (decoded !== url) throw new Error(`decode mismatch: ${JSON.stringify(decoded)} != ${JSON.stringify(url)}`)
  console.log('qr independent decode verification ok (format + RS syndrome + text round-trip)')
}

const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const noop = () => {};
const render = (props) => renderToString(react.createElement(result.views.BalancePanelView, {
  t,
  balance: null,
  error: false,
  usage: null,
  usageError: false,
  refreshing: false,
  resetting: false,
  resetPending: false,
  resetError: false,
  onRefresh: noop,
  onResetRequest: noop,
  onResetCancel: noop,
  onResetConfirm: noop,
  onClose: noop,
  panelRef: null,
  selectedProviderId: null,
  onSelectProvider: noop,
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
        { id: 'gateway', kind: 'usage', configured: true, display_name: 'Gateway', usage: { remaining: 56.78, unit: 'CNY', is_valid: true, total_usage_usd: 12.34, soft_limit_usd: 100, hard_limit_usd: 200, has_payment_method: true } },
        { id: 'volcengine', kind: 'balance', configured: true, display_name: '火山引擎', balance: { is_available: true, balance_infos: [{ total_balance: '0.00', currency: 'CNY', topped_up_balance: '0.00', granted_balance: '0.00' }] }, plans: [{ id: 'plan-1', name: '方舟 Coding Plan', product: '豆包大模型', remaining: 72.5, total: 100, used: 27.5, unit: 'M Tokens', period_usage: 3.75, expires_at: '2026-09-30T15:59:59Z' }] },
        { id: 'unsupported', kind: 'unsupported', configured: true, display_name: 'UnsupportedCo' },
        { id: 'unconfigured', kind: 'balance', configured: false, display_name: 'NoKeyCo' },
        { id: 'broken', kind: 'balance', configured: true, error: 'boom', display_name: 'BrokenCo' },
      ],
    },
    usage: usageFixture,
    selectedProviderId: 'gateway',
  });
  for (const marker of ['DeepSeek', '88.00', 'Gateway', '56.78', 'CNY', 'usage.active', '火山引擎', '方舟 Coding Plan', '豆包大模型', '72.5', 'M Tokens', '27.5', '100', '3.75', '2026-09-30', 'plan.accountBalance', '0.00', 'dbb_planList', 'dbb_planMetrics', 'UnsupportedCo', 'balance.unsupported', 'NoKeyCo', 'badge.unconfigured', 'BrokenCo', 'boom', 'usage.paymentYes', 'dbb_providerCard', 'dbb_selected', 'aria-pressed="true"', 'balance.select']) {
    if (!markup.includes(marker)) throw new Error(`providers render missing ${marker}\n${markup}`);
  }
  // the three data-less providers are folded into a collapsed summary group
  for (const marker of ['balance.folded', 'dbb_foldedSummary', 'dbb_foldedItem']) {
    if (!markup.includes(marker)) throw new Error(`providers render missing folded marker ${marker}\n${markup}`);
  }
  console.log('multi-provider render ok');
}

// 2b. a plan-only provider must not present its cash balance as plan quota
{
  const markup = render({
    balance: {
      configured: true,
      low: false,
      providers: [{
        id: 'volcengine',
        kind: 'balance',
        configured: true,
        display_name: '火山引擎',
        balance: { is_available: true, balance_infos: [{ total_balance: '0', currency: 'CNY', topped_up_balance: '0', granted_balance: '0' }] },
        plans: [],
        plans_error: 'Coding Plan 仅可在控制台查询',
      }],
    },
  });
  for (const marker of ['火山引擎', 'plan.limited', 'plan.partial', 'Coding Plan 仅可在控制台查询', 'plan.accountBalance', '0 CNY', 'dbb_planError']) {
    if (!markup.includes(marker)) throw new Error(`limited plan render missing ${marker}\n${markup}`);
  }
  if (markup.includes('dbb_balanceBig">0<')) throw new Error(`limited plan must not use cash balance as the headline\n${markup}`);
  console.log('limited plan render ok');
}

// 2c. Volcengine Coding Plan quota windows show used %, remaining %, and reset
{
  const markup = render({
    balance: {
      configured: true,
      low: false,
      providers: [{
        id: 'volcengine',
        kind: 'balance',
        configured: true,
        display_name: '火山引擎',
        balance: { is_available: true, balance_infos: [{ total_balance: '12.00', currency: 'CNY', topped_up_balance: '12.00', granted_balance: '0' }] },
        plans: [
          { id: 'volc-coding-session', name: '5 小时额度', product: '方舟 Coding Plan', total: 100, used: 0, remaining: 100, unit: '%', status: 'Running' },
          { id: 'volc-coding-weekly', name: '7 天额度', product: '方舟 Coding Plan', total: 100, used: 1.672568, remaining: 98.327432, unit: '%', status: 'Running', expires_at: '2026-06-22T00:00:00Z' },
          { id: 'volc-coding-monthly', name: '每月额度', product: '方舟 Coding Plan', total: 100, used: 0.836284, remaining: 99.163716, unit: '%', status: 'Running', expires_at: '2026-07-17T23:59:59Z' },
        ],
      }],
    },
  });
  for (const marker of ['5 小时额度', '7 天额度', '每月额度', '方舟 Coding Plan', '1.67% plan.used', '98.33%', 'plan.resets', 'plan.noActiveWindow', 'plan.accountBalance', '12.00 CNY']) {
    if (!markup.includes(marker)) throw new Error(`coding plan render missing ${marker}\n${markup}`);
  }
  console.log('coding plan quota render ok');
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

// 5. reset uses a second confirmation layer and offers a recoverable cancel
{
  const markup = render({ balance: { configured: true }, usage: usageFixture, resetPending: true });
  for (const marker of ['usage.reset', 'dbb_resetBtn', 'dbb_confirmScrim', 'usage.resetTitle', 'usage.resetText', 'usage.resetCancel', 'usage.resetConfirm']) {
    if (!markup.includes(marker)) throw new Error(`usage reset confirmation missing ${marker}\n${markup}`);
  }
  console.log('usage reset confirmation render ok');
}

// 6. about section view: identity rows + update/action markers
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
  if (err.includes('about.offline') || err.includes('boom')) throw new Error(`about error leaked into page content\n${err}`);
  console.log('about section render ok');
}

// 7. remote section view: online (custom relay) / default relay / disabled /
//    offline states
{
  const renderRemote = (props) => renderToString(react.createElement(result.views.RemoteSectionView, {
    t,
    cfg: null,
    loadError: null,
    busy: false,
    notice: null,
    onChange: noop,
    onSave: noop,
    ...props,
  }));
  const online = renderRemote({
    cfg: { enabled: true, relayUrl: 'wss://remote.example.com', customRelay: true, defaultRelayUrl: 'wss://remote.anixuil.com', secret: 'secret-12345', deviceId: 'my-pc', running: true, online: true, entry: 'https://my-pc.remote.example.com/' },
    pairingCode: '482913',
  });
  for (const marker of ['remote.title', 'remote.enabled', 'remote.customRelay', 'wss://remote.example.com', 'my-pc', 'https://my-pc.remote.example.com/', 'remote.stateOnline', 'remote.save', 'remote.pair', 'remote.pairCode', '482913']) {
    if (!online.includes(marker)) throw new Error(`remote online render missing ${marker}\n${online}`);
  }
  // Default relay mode: no URL input, the public default is shown read-only.
  const def = renderRemote({
    cfg: { enabled: true, relayUrl: 'wss://remote.anixuil.com', customRelay: false, defaultRelayUrl: 'wss://remote.anixuil.com', secret: '', deviceId: 'my-pc', running: true, online: true, entry: 'https://my-pc.remote.anixuil.com/' },
  });
  if (!def.includes('wss://remote.anixuil.com')) throw new Error(`remote default relay render missing default URL\n${def}`);
  const disabled = renderRemote({ cfg: { enabled: false, relayUrl: '', customRelay: false, defaultRelayUrl: 'wss://remote.anixuil.com', secret: '', deviceId: '' } });
  if (!disabled.includes('remote.stateOff') || !disabled.includes('remote.entryNone')) {
    throw new Error(`remote disabled state missing\n${disabled}`);
  }
  const offline = renderRemote({ cfg: null, loadError: 'boom' });
  if (!offline.includes('remote.stateUnavailable') || offline.includes('remote.offline') || offline.includes('boom')) throw new Error(`remote unavailable state missing or error leaked into page content\n${offline}`);
  const checking = renderRemote({ cfg: null });
  if (!checking.includes('remote.stateChecking') || checking.includes('remote.stateOff')) throw new Error(`remote checking state missing\n${checking}`);

  const edited = {
    enabled: false,
    customRelay: true,
    relayUrl: 'wss://draft.example.com',
    deviceId: 'draft-device',
    maxConcurrent: 9,
    running: true,
    online: false,
    persistentPairingEnabled: false,
  };
  const fresh = {
    enabled: true,
    customRelay: false,
    relayUrl: 'wss://saved.example.com',
    deviceId: 'saved-device',
    maxConcurrent: 3,
    running: true,
    online: true,
    persistentPairingEnabled: true,
  };
  const refreshed = result.remote.preserveRemoteDraft(edited, fresh);
  for (const key of ['enabled', 'customRelay', 'relayUrl', 'deviceId', 'maxConcurrent']) {
    if (refreshed[key] !== edited[key]) throw new Error(`remote status refresh overwrote draft field ${key}`);
  }
  if (result.remote.preserveRemoteDraft(null, fresh) !== fresh) throw new Error('remote initial snapshot did not populate draft');
  const liveStatus = renderRemote({ cfg: edited, runtimeCfg: fresh });
  if (!liveStatus.includes('remote.stateOnline') || liveStatus.includes('remote.stateConnecting')) {
    throw new Error(`remote badge did not use authoritative runtime snapshot\n${liveStatus}`);
  }
  console.log('remote section render ok');
}

// 7. appearance section view: DSH default / quiet / rich states + offline state
{
  const renderAppearance = (props) => renderToString(react.createElement(result.views.AppearanceSectionView, {
    t,
    motion: null,
    loading: false,
    loadError: null,
    busy: false,
    notice: null,
    onChange: noop,
    onRetry: noop,
    notificationMode: 'unfocused',
    notificationBusy: false,
    testBusy: false,
    notificationNotice: null,
    onNotificationChange: noop,
    onNotificationTest: noop,
    ...props,
  }));
  const quiet = renderAppearance({ motion: 'quiet' });
  for (const marker of ['appearance.title', 'appearance.motionLabel', 'appearance.motionDefault', 'appearance.motionQuiet', 'appearance.motionRich', 'appearance.hint', 'appearance.notificationLabel', 'appearance.notificationOff', 'appearance.notificationUnfocused', 'appearance.notificationAlways', 'appearance.notificationHint', 'appearance.notificationTest']) {
    if (!quiet.includes(marker)) throw new Error(`appearance quiet render missing ${marker}\n${quiet}`);
  }
  if (!quiet.includes('aria-checked="true"')) throw new Error(`appearance quiet should mark the quiet option checked\n${quiet}`);
  const rich = renderAppearance({ motion: 'rich' });
  if (rich === quiet) throw new Error('appearance rich/quiet renders must differ');
  const dshDefault = renderAppearance({ motion: 'default' });
  if (dshDefault === quiet || dshDefault === rich) throw new Error('appearance default/quiet/rich renders must differ');
  if (!dshDefault.match(/aria-checked="true"[^>]*>appearance\.motionDefault</)) {
    throw new Error(`appearance default should mark the DSH default option checked\n${dshDefault}`);
  }
  const offline = renderAppearance({ motion: null, loadError: 'boom' });
  if (!offline.includes('appearance.offline') || !offline.includes('appearance.retry') || offline.includes('boom')
      || !offline.match(/aria-checked="false"[^>]*>appearance\.motionDefault</)
      || !offline.match(/aria-checked="false"[^>]*>appearance\.motionQuiet</)
      || !offline.match(/aria-checked="false"[^>]*>appearance\.motionRich</)) {
    throw new Error(`appearance error state should be visible without claiming a selected preset or leaking details\n${offline}`);
  }
  const loading = renderAppearance({ motion: null, loading: true });
  if (!loading.includes('appearance.loading')
      || !loading.match(/aria-checked="false"[^>]*>appearance\.motionDefault</)
      || !loading.match(/aria-checked="false"[^>]*>appearance\.motionQuiet</)
      || !loading.match(/aria-checked="false"[^>]*>appearance\.motionRich</)) {
    throw new Error(`appearance loading state must not claim rich is selected\n${loading}`);
  }
  const notifyAlways = renderAppearance({ motion: 'default', notificationMode: 'always' });
  if (!notifyAlways.match(/aria-checked="true"[^>]*>appearance\.notificationAlways</)) {
    throw new Error(`appearance notifications should mark always checked\n${notifyAlways}`);
  }
  const notifyBusy = renderAppearance({ notificationBusy: true, testBusy: true });
  if (!notifyBusy.includes('appearance.notificationTesting') || !notifyBusy.includes('disabled=""')) {
    throw new Error(`appearance notification busy state missing\n${notifyBusy}`);
  }
  const notifyOk = renderAppearance({ notificationNotice: { kind: 'ok', text: 'appearance.notificationTestSent' } });
  if (!notifyOk.includes('role="status"') || !notifyOk.includes('appearance.notificationTestSent')) {
    throw new Error(`appearance notification success feedback missing\n${notifyOk}`);
  }
  console.log('appearance section render ok');
}

// 8. model behavior: prompt editor, temperature defaults, dirty/save states
{
  const renderModelBehavior = (props) => renderToString(react.createElement(result.views.ModelBehaviorSectionView, {
    t,
    loading: false,
    loadError: null,
    systemPrompt: '默认使用简体中文',
    temperatureEnabled: true,
    temperature: 0.4,
    dirty: true,
    busy: false,
    notice: null,
    onPromptChange: noop,
    onTemperatureEnabledChange: noop,
    onTemperatureChange: noop,
    onReset: noop,
    onSave: noop,
    onRetry: noop,
    ...props,
  }));
  const custom = renderModelBehavior({});
  for (const marker of ['modelBehavior.title', 'modelBehavior.promptLabel', '默认使用简体中文', 'modelBehavior.temperatureLabel', '0.4', 'modelBehavior.save']) {
    if (!custom.includes(marker)) throw new Error(`model behavior view missing ${marker}\n${custom}`);
  }
  if (!custom.includes('type="range"') || !custom.includes('type="number"') || !custom.includes('checked=""')) {
    throw new Error(`model behavior custom temperature controls missing\n${custom}`);
  }
  const defaults = renderModelBehavior({ temperatureEnabled: false, dirty: false });
  if (!defaults.includes('disabled=""') || !defaults.includes('modelBehavior.modelDefault')) {
    throw new Error(`model behavior default state missing\n${defaults}`);
  }
  const loading = renderModelBehavior({ loading: true });
  if (!loading.includes('modelBehavior.loading')) throw new Error(`model behavior loading state missing\n${loading}`);
  const failed = renderModelBehavior({ loadError: 'boom-secret' });
  if (!failed.includes('role="alert"') || !failed.includes('modelBehavior.retry') || failed.includes('boom-secret')) {
    throw new Error(`model behavior error state missing or leaked details\n${failed}`);
  }
  console.log('model behavior settings render ok');
}

// 9. built-in plugin controls: grouped rows, state changes, and action bar
{
  const plugins = [
    { id: 'dsh-desktop-bridge', version: '0.2.0', source: 'desktop', enabled: true, controlPlaneRetained: true },
    { id: 'dsh-desktop-session-manager', version: '0.1.0', source: 'desktop', enabled: true },
    { id: 'dsh-desktop-change-history', version: '0.1.0', source: 'desktop', enabled: true },
    { id: 'dsh-desktop-file-upload', version: '0.2.0', source: 'desktop', enabled: true },
    { id: 'dsh-desktop-conversation-navigator', version: '0.1.0', source: 'desktop', enabled: true },
    { id: 'dsh-vision-any', version: '0.1.0', source: 'bundledThirdParty', enabled: true },
    { id: 'dshmarket', version: '1.15.0', source: 'user', enabled: false },
  ];
  const renderBuiltin = (active, initial = active) => renderToString(react.createElement(result.views.BuiltinPluginsSectionView, {
    t,
    plugins,
    enabled: new Set(active),
    initialEnabled: new Set(initial),
    loading: false,
    busy: false,
    loadError: null,
    onToggle: noop,
    onEnableAll: noop,
    onCancel: noop,
    onApply: noop,
    onRetry: noop,
  }));
  const clean = renderBuiltin(plugins.slice(0, 6).map((plugin) => plugin.id));
  for (const marker of ['builtinPlugins.title', 'builtinPlugins.group.desktop', 'builtinPlugins.group.services', 'dshmarket', 'v1.15.0']) {
    if (!clean.includes(marker)) throw new Error(`built-in plugin view missing ${marker}\n${clean}`);
  }
  if (clean.includes('builtinPlugins.apply')) throw new Error(`clean built-in plugin state should not show apply action\n${clean}`);
  const dirty = renderBuiltin(plugins.slice(0, 5).map((plugin) => plugin.id), plugins.slice(0, 6).map((plugin) => plugin.id));
  if (!dirty.includes('builtinPlugins.apply') || !dirty.includes('builtinPlugins.pending')) throw new Error(`dirty built-in plugin state missing actions\n${dirty}`);
  const failed = renderToString(react.createElement(result.views.BuiltinPluginsSectionView, {
    t, plugins: [], enabled: new Set(), initialEnabled: new Set(), loading: false,
    busy: false, loadError: 'secret-detail', onToggle: noop, onEnableAll: noop,
    onCancel: noop, onApply: noop, onRetry: noop,
  }));
  if (!failed.includes('role="alert"') || !failed.includes('builtinPlugins.retry') || failed.includes('secret-detail')) {
    throw new Error(`built-in plugin load failure must be visible, retryable, and redact details\n${failed}`);
  }
  console.log('built-in plugin settings render ok');
}

console.log('bridge views fixture tests PASSED');
