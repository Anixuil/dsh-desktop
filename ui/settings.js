// DSH Desktop settings window — ocean theme + motion layer
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * settings tabs
 * ------------------------------------------------------------------------- */

const tabs = [...document.querySelectorAll('.settings-tab')];
const panels = [...document.querySelectorAll('.settings-panel')];

function selectTab(name, focus = false) {
  tabs.forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  panels.forEach((panel) => {
    const selected = panel.dataset.panel === name;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    let next = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next].dataset.tab, true);
  });
});

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/* ---------------------------------------------------------------------------
 * window chrome + DSH theme preference
 * ------------------------------------------------------------------------- */

let themePreference = 'system';

function applyTheme(preference) {
  themePreference = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  const useDark = themePreference === 'dark' ||
    (themePreference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = useDark ? 'dark' : 'light';
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
colorScheme.addEventListener('change', () => {
  if (themePreference === 'system') applyTheme(themePreference);
});

if (window.__TAURI__ && window.__TAURI__.window) {
  const win = window.__TAURI__.window.getCurrentWindow();
  const MAX_SVG =
    '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  const RESTORE_SVG =
    '<svg viewBox="0 0 10 10" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1" d="M2.5 2.5V.5h7v7h-2"/><rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  const syncMax = async () => {
    try {
      const maximized = await win.isMaximized();
      $('win-max').innerHTML = maximized ? RESTORE_SVG : MAX_SVG;
      $('win-max').title = maximized ? '向下还原' : '最大化';
      $('win-max').setAttribute('aria-label', maximized ? '向下还原' : '最大化');
    } catch (e) { /* window not ready yet */ }
  };
  $('win-min').addEventListener('click', () => win.minimize());
  $('win-max').addEventListener('click', () => win.toggleMaximize());
  $('win-close').addEventListener('click', () => win.close());
  win.onResized(syncMax);
  syncMax();
}

/* ---------------------------------------------------------------------------
 * motion helpers
 * ------------------------------------------------------------------------- */

// Restart a one-shot CSS animation (used for msg slide-ins / kv flashes).
function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow → animation restarts
  el.classList.add(cls);
}

// Animate a number towards `toText` (rAF, tabular-nums; skips in quiet /
// reduced-motion mode).
function animateNumber(el, toText) {
  if (!el || el.textContent === toText) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const target = parseFloat(String(toText).replace(/,/g, ''));
  if (reduced || document.documentElement.dataset.motion !== 'rich' || !Number.isFinite(target)) {
    el.textContent = toText;
    return;
  }
  const from = parseFloat(String(el.textContent).replace(/,/g, '')) || 0;
  if (from === target) { el.textContent = toText; return; }
  const dur = 420;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = (from + (target - from) * ease(t)).toFixed(2);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = toText;
  };
  requestAnimationFrame(step);
}

// Track previous values so polling refreshes can flash only what changed.
const lastVals = {};
function setVal(id, text, key) {
  const el = $(id);
  if (!el) return;
  const prev = lastVals[key];
  lastVals[key] = text;
  if (prev !== undefined && prev !== text) {
    const row = el.closest('.kv');
    if (row) {
      restartAnim(row, 'flash');
      row.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
    }
  }
  el.textContent = text;
}

// Motion intensity (persisted config → <html data-motion="quiet|rich">).
// Read-only here: the picker now lives in the main window's settings modal,
// but this window still mirrors the value for its own ambient layer.
function applyMotion(m) {
  document.documentElement.dataset.motion = m === 'quiet' ? 'quiet' : 'rich';
}

function showMessage(text) {
  if (text == null || text === '') return;
  let root = document.getElementById('dsh-desktop-message-root');
  if (root === null) {
    root = document.createElement('div'); root.id = 'dsh-desktop-message-root'; root.className = 'dsh-message-root'; root.setAttribute('aria-live', 'polite'); document.body.appendChild(root);
  }
  const item = document.createElement('div'); item.className = 'dsh-message'; item.setAttribute('role', 'alert');
  const content = document.createElement('span'); content.textContent = String(text);
  const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label', '关闭提示'); close.textContent = '×';
  const dismiss = () => item.remove(); close.addEventListener('click', dismiss); item.append(content, close); root.appendChild(item); window.setTimeout(dismiss, 4500);
}
const msgAnim = (el) => { if (el) restartAnim(el, 'msg-anim'); };
const upMsg = (text, cls) => { const m = $('up-msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };
const aboutMsg = (text, cls) => { const m = $('about-msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };
const remoteMsg = (text, cls) => { if (cls === 'err') { showMessage(text); $('remote-msg').textContent = ''; return; } const m = $('remote-msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };

/* ---------------------------------------------------------------------------
 * remote access
 * ------------------------------------------------------------------------- */

// Public default relay — used out of the box; overridden only when the user
// checks 自定义中继服务器 and saves their own URL.
const DEFAULT_RELAY_URL = 'wss://remote.anixuil.com';

function syncRemoteUrlBlocks() {
  const custom = $('remote-custom').checked;
  $('remote-custom-block').hidden = !custom;
  $('remote-default-block').hidden = custom;
}

async function renderRemote() {
  try {
    const r = await invoke('get_remote_config');
    $('remote-enabled').checked = r.enabled;
    $('remote-custom').checked = r.customRelay === true;
    $('remote-default').textContent = r.defaultRelayUrl || DEFAULT_RELAY_URL;
    $('remote-url').value = r.customRelay === true ? (r.relayUrl || '') : '';
    $('remote-device').value = r.deviceId || '';
    syncRemoteUrlBlocks();
    renderRemoteState(r);
  } catch (e) { /* command unavailable — leave the card empty */ }
}

$('remote-custom').addEventListener('change', () => {
  if ($('remote-custom').checked) {
    // Never prefill the public default into the custom URL field.
    const current = $('remote-url').value.trim();
    if (!current || current === DEFAULT_RELAY_URL) $('remote-url').value = '';
  }
  syncRemoteUrlBlocks();
  remoteMsg('修改后请点击「保存并连接」', '');
});

function renderRemoteState(r) {
  if (!r.enabled) {
    $('st-remote').innerHTML = badge(false, '', '未启用');
    $('remote-entry').textContent = '—';
    return;
  }
  if (r.online) {
    $('st-remote').innerHTML = badge(true, '已连接', '');
  } else if (r.running) {
    $('st-remote').innerHTML = badge(false, '', '连接中（未连上中继）');
  } else {
    $('st-remote').innerHTML = badge(false, '', '已启用（客户端未运行）');
  }
  $('remote-entry').textContent = r.entry || '（配置不完整）';
}

$('remote-save').addEventListener('click', async () => {
  const enabled = $('remote-enabled').checked;
  const custom = $('remote-custom').checked;
  const relayUrl = custom ? $('remote-url').value.trim() : DEFAULT_RELAY_URL;
  const deviceId = $('remote-device').value.trim();
  if (enabled) {
    if (custom && !/^wss?:\/\//.test(relayUrl)) { remoteMsg('中继地址需以 wss://（或 ws://）开头', 'err'); return; }
    if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(deviceId)) { remoteMsg('设备名只能包含小写字母、数字、-、_（用于手机访问地址）', 'err'); return; }
  }
  $('remote-save').disabled = true;
  $('remote-save').classList.add('busy');
  remoteMsg('正在保存并连接…');
  try {
    const r = await invoke('save_remote_config', { enabled, customRelay: custom, relayUrl, secret: '', deviceId });
    renderRemoteState(r);
    remoteMsg(r.enabled ? (r.online ? '已保存，中继连接成功。' : '已保存，等待连接（稍后自动刷新状态）。') : '远程访问已关闭。', r.online ? 'ok' : '');
  } catch (e) {
    remoteMsg(String(e), 'err');
  } finally {
    $('remote-save').disabled = false;
    $('remote-save').classList.remove('busy');
  }
});

$('remote-pair').addEventListener('click', async () => {
  $('remote-pair').disabled = true;
  $('remote-pair').classList.add('busy');
  $('remote-code').textContent = '…';
  $('remote-qr-wrap').hidden = true;
  try {
    const res = await invoke('get_remote_pairing');
    if (res && res.ok === true && res.pairing && res.pairing.code) {
      $('remote-code').textContent = res.pairing.code;
      const entry = res.pairing.entry;
      if (entry && window.qrSvgDataUri) {
        try {
          $('remote-qr').src = window.qrSvgDataUri(entry + '?code=' + res.pairing.code);
          $('remote-qr-wrap').hidden = false;
        } catch { /* qr rendering best-effort; numeric code stays usable */ }
      }
      remoteMsg('配对码已生成（5 分钟内有效），手机扫码或输入配对码即可。', 'ok');
    } else {
      $('remote-code').textContent = '—';
      remoteMsg((res && res.error) || '生成配对码失败', 'err');
    }
  } catch (e) {
    $('remote-code').textContent = '—';
    remoteMsg(String(e), 'err');
  } finally {
    $('remote-pair').disabled = false;
    $('remote-pair').classList.remove('busy');
  }
});

$('remote-enabled').addEventListener('change', () => {
  // The checkbox alone does not persist — saving commits the whole card.
  remoteMsg('修改后请点击「保存并连接」', '');
});

function renderBalance(balance, at) {
  if (!balance) {
    $('bal-status').innerHTML = '<span class="badge warn">未获取</span>';
    $('bal-total').textContent = '—';
    setVal('bal-topped', '—', 'bal-topped');
    setVal('bal-granted', '—', 'bal-granted');
    setVal('bal-currency', '—', 'bal-currency');
    lastVals['bal-at'] = null;
    $('bal-at').textContent = '—';
    return;
  }
  if (!balance.is_available) {
    $('bal-status').innerHTML = '<span class="badge err">账户余额不可用</span>';
  } else {
    $('bal-status').innerHTML = '<span class="badge ok">可用</span>';
  }
  const info = balance.balance_infos && balance.balance_infos[0];
  if (info) {
    animateNumber($('bal-total'), info.total_balance);
    setVal('bal-topped', info.topped_up_balance, 'bal-topped');
    setVal('bal-granted', info.granted_balance, 'bal-granted');
    setVal('bal-currency', info.currency, 'bal-currency');
  }
  if (at) setVal('bal-at', at, 'bal-at');
}

function badge(ok, okText, badText) {
  return ok ? `<span class="badge ok">${okText}</span>` : `<span class="badge err">${badText}</span>`;
}

async function renderStatus() {
  const st = await invoke('get_status');
  if (st.motionIntensity) applyMotion(st.motionIntensity);
  applyTheme(st.themePreference);
  $('st-dsh').innerHTML = badge(st.uiReady, '运行中', st.dshRunning ? '启动中' : '未运行');
  $('st-bridge').innerHTML = badge(st.bridgeOk, '已连接', '未连接（降级为定时轮询）');
  setVal('st-mode', st.adopted ? '已接管外部 dsh 实例' : '自托管（应用内置 dsh）', 'st-mode');
  setVal('st-versions', `${st.appVersion} / ${st.dshVersion || '?'} / ${st.nodeVersion || '?'}`, 'st-versions');
  setVal('st-home', st.dshHome, 'st-home');
  $('log-path').textContent = `日志：${st.logPath}`;
  renderBalance(st.balance, null);
}

/* ---------------------------------------------------------------------------
 * events → UI
 * ------------------------------------------------------------------------- */

listen('balance-updated', (e) => {
  const { balance, at } = e.payload;
  renderBalance(balance, at);
});

listen('update-status', (e) => {
  updateStatus = normalizeUpdateStatus(e.payload);
  renderUpdateStatus(updateStatus);
  renderAboutUpdateStatus(updateStatus);
  if (updateStatus.core.updateAvailable || updateStatus.shell.updateAvailable) upMsg('已自动检测到可用更新。', 'ok');
});

listen('update-rollback', (e) => {
  const detail = String(e.payload);
  const failed = detail.includes('失败');
  setUpdatePhase('core', failed ? '回滚失败' : detail.includes('验证通过') ? '更新成功' : '已回滚', failed ? 'err' : 'ok');
  setProgress('core', detail, null, null);
  upMsg(detail, failed ? 'err' : 'ok');
  refreshUpdateReadiness();
});

listen('update-progress', (e) => {
  const payload = e.payload || {};
  const labels = { download: '下载中', install: '安装中', verify: '验证中' };
  setUpdatePhase('core', labels[payload.stage] || '更新中', 'warn');
  setProgress('core', payload.detail || '正在更新 dsh 内核…', payload.downloaded, payload.total);
});

listen('shell-update-progress', (e) => {
  const payload = e.payload || {};
  setUpdatePhase('shell', payload.stage === 'download' ? '下载中' : '安装中', 'warn');
  setProgress('shell', payload.detail || '正在更新桌面应用…', payload.downloaded, payload.total);
});

/* ---------------------------------------------------------------------------
 * motion intensity (mirror only)
 * ------------------------------------------------------------------------- */

applyMotion(window.__DSH_MOTION__);
listen('motion-updated', (e) => {
  if (e.payload && e.payload.motion) applyMotion(e.payload.motion);
});

$('open-logs').addEventListener('click', () => invoke('open_logs'));
$('open-home').addEventListener('click', () => invoke('open_dsh_home'));

/* ---------------------------------------------------------------------------
 * updates
 * ------------------------------------------------------------------------- */

let updateStatus = null;
let coreUpdating = false;
let shellUpdating = false;

function normalizeUpdateStatus(value) {
  const core = value?.core || { current: value?.dshCurrent ?? null, latest: value?.dshLatest ?? null, updateAvailable: value?.dshUpdateAvailable === true, releaseUrl: null, notes: null };
  const shell = value?.shell || { current: value?.appCurrent ?? null, latest: value?.appLatest ?? null, updateAvailable: value?.appUpdateAvailable === true, releaseUrl: value?.appUrl ?? null, notes: null };
  return { core, shell, readiness: value?.readiness || { ready: true, reason: null } };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setUpdatePhase(kind, text, tone = 'warn') {
  const badge = $(`${kind}-update-state`);
  badge.textContent = text;
  badge.className = `badge ${tone}`;
}

function setProgress(kind, label, downloaded, total) {
  const root = $(`${kind}-progress`);
  const bar = $(`${kind}-progress-bar`);
  root.hidden = false;
  $(`${kind}-progress-label`).textContent = label;
  const hasTotal = Number.isFinite(total) && total > 0 && Number.isFinite(downloaded);
  if (hasTotal) {
    const percent = Math.min(100, Math.max(0, downloaded / total * 100));
    bar.value = percent;
    $(`${kind}-progress-bytes`).textContent = `${formatBytes(downloaded)} / ${formatBytes(total)} · ${Math.round(percent)}%`;
  } else {
    bar.removeAttribute('value');
    $(`${kind}-progress-bytes`).textContent = Number.isFinite(downloaded) ? formatBytes(downloaded) : '';
  }
}

function updateComponent(kind, component) {
  $(kind === 'core' ? 'up-dsh' : 'up-app').textContent = component.current || '?';
  $(kind === 'core' ? 'up-dsh-latest' : 'up-app-latest').textContent = component.latest || '未获取';
  if (!(kind === 'core' ? coreUpdating : shellUpdating)) {
    setUpdatePhase(kind, component.updateAvailable ? '有新版本' : component.latest ? '已是最新' : '未检查', component.updateAvailable ? 'ok' : 'warn');
  }
}

function renderReadiness(readiness) {
  const root = $('update-readiness');
  const ready = readiness?.coreReady !== false && readiness?.shellReady !== false && readiness?.ready !== false;
  const reason = readiness?.reason || readiness?.coreReason || readiness?.shellReason;
  root.textContent = ready ? '当前空闲，可以执行更新。' : (reason || '当前暂不可更新。');
  root.className = `update-readiness ${ready ? 'ready' : 'blocked'}`;
}

function syncUpdateButtons() {
  if (!updateStatus) return;
  const readiness = updateStatus.readiness || {};
  const coreReady = readiness.coreReady ?? (readiness.ready !== false && readiness.adopted !== true);
  const shellReady = readiness.shellReady ?? readiness.ready !== false;
  $('apply-dsh-update').disabled = coreUpdating || shellUpdating || !coreReady || !updateStatus.core.updateAvailable;
  $('apply-shell-update').disabled = coreUpdating || shellUpdating || !shellReady || !updateStatus.shell.updateAvailable;
}

function renderUpdateStatus(status) {
  updateComponent('core', status.core);
  updateComponent('shell', status.shell);
  renderReadiness(status.readiness);
  const notes = $('shell-release-notes');
  notes.textContent = status.shell.notes || '';
  notes.hidden = !status.shell.notes;
  const release = $('open-shell-release');
  release.dataset.url = status.shell.releaseUrl || '';
  release.hidden = !status.shell.releaseUrl;
  syncUpdateButtons();
}

function renderAboutUpdateStatus(status) {
  const parts = [
    status.core.updateAvailable ? `dsh 内核：${status.core.current || '?'} → ${status.core.latest || '?'}` : `dsh 内核已是最新（${status.core.current || '?'}）`,
    status.shell.updateAvailable ? `桌面应用：${status.shell.current || '?'} → ${status.shell.latest || '?'}` : `桌面应用已是最新（${status.shell.current || '?'}）`,
  ];
  aboutMsg(parts.join('；'), status.core.updateAvailable || status.shell.updateAvailable ? 'ok' : '');
  $('about-release-link').dataset.url = status.shell.releaseUrl || '';
  $('about-release-link').hidden = !status.shell.releaseUrl;
}

async function refreshUpdateReadiness() {
  if (!updateStatus) return;
  try {
    updateStatus.readiness = await invoke('get_update_readiness');
    renderReadiness(updateStatus.readiness);
    syncUpdateButtons();
  } catch (e) { /* transient shell restart */ }
}

async function renderUpdatePanel() {
  try {
    const st = await invoke('get_status');
    $('up-app').textContent = st.appVersion;
    $('up-dsh').textContent = st.dshVersion || '?';
    $('about-version').textContent = 'v' + st.appVersion;
  } catch (e) { /* ignore */ }
}

$('check-update').addEventListener('click', async () => {
  $('check-update').disabled = true;
  $('check-update').classList.add('busy');
  upMsg('正在检查更新…');
  try {
    updateStatus = normalizeUpdateStatus(await invoke('check_update'));
    renderUpdateStatus(updateStatus);
    renderAboutUpdateStatus(updateStatus);
    const available = updateStatus.core.updateAvailable || updateStatus.shell.updateAvailable;
    upMsg(available ? '发现可用更新。' : 'dsh 内核和桌面应用均已是最新。', available ? 'ok' : '');
  } catch (e) {
    showMessage(String(e));
  } finally {
    $('check-update').disabled = false;
    $('check-update').classList.remove('busy');
  }
});

$('apply-dsh-update').addEventListener('click', async () => {
  if (!confirm('更新 dsh 内核？服务会短暂重启，当前页面可能暂时断开；新版本验证失败时会自动回滚。')) return;
  coreUpdating = true;
  $('apply-dsh-update').disabled = true;
  $('apply-dsh-update').classList.add('busy');
  upMsg('正在下载并应用 dsh 更新（请勿关闭应用）…');
  try {
    const result = await invoke('apply_dsh_update');
    upMsg(result, 'ok');
    renderStatus();
    renderUpdatePanel();
  } catch (e) {
    setUpdatePhase('core', '更新失败', 'err');
    upMsg(String(e), 'err');
    showMessage(String(e));
  } finally {
    coreUpdating = false;
    $('apply-dsh-update').classList.remove('busy');
    refreshUpdateReadiness();
  }
});

$('apply-shell-update').addEventListener('click', async () => {
  if (!confirm('安装桌面应用更新？下载并验证签名后，应用会退出、完成安装并自动重启。')) return;
  shellUpdating = true;
  syncUpdateButtons();
  $('apply-shell-update').classList.add('busy');
  setUpdatePhase('shell', '准备下载', 'warn');
  setProgress('shell', '正在连接官方签名更新源…', null, null);
  try {
    await invoke('apply_shell_update');
  } catch (e) {
    shellUpdating = false;
    $('apply-shell-update').classList.remove('busy');
    setUpdatePhase('shell', '更新失败', 'err');
    upMsg(String(e), 'err');
    showMessage(String(e));
    refreshUpdateReadiness();
  }
});

$('open-shell-release').addEventListener('click', () => {
  const url = $('open-shell-release').dataset.url;
  if (url) openExternal(url);
});

/* ---------------------------------------------------------------------------
 * autostart
 * ------------------------------------------------------------------------- */

(async () => {
  try {
    $('autostart').checked = await invoke('get_autostart');
  } catch (e) { /* registry unavailable (sandbox) — leave unchecked */ }
})();
$('autostart').addEventListener('change', async () => {
  try {
    await invoke('set_autostart', { enabled: $('autostart').checked });
  } catch (e) {
    $('autostart').checked = false;
    showMessage(`设置开机自启失败：${e}`);
  }
});

/* ---------------------------------------------------------------------------
 * about
 * ------------------------------------------------------------------------- */

const BLOG_URL = 'https://www.anixuil.top';
const GITHUB_URL = 'https://github.com/Anixuil/dsh-desktop';

async function openExternal(url) {
  try {
    await invoke('open_external', { url });
  } catch (e) {
    showMessage(String(e));
  }
}

$('about-blog').addEventListener('click', (e) => { e.preventDefault(); openExternal(BLOG_URL); });
$('about-github').addEventListener('click', (e) => { e.preventDefault(); openExternal(GITHUB_URL); });
$('about-github-btn').addEventListener('click', () => openExternal(GITHUB_URL));
$('about-release-link').addEventListener('click', (e) => {
  e.preventDefault();
  const url = $('about-release-link').dataset.url;
  if (url) openExternal(url);
});

$('about-check-update').addEventListener('click', async () => {
  $('about-check-update').disabled = true;
  $('about-check-update').classList.add('busy');
  aboutMsg('正在检查更新…');
  try {
    updateStatus = normalizeUpdateStatus(await invoke('check_update'));
    renderUpdateStatus(updateStatus);
    renderAboutUpdateStatus(updateStatus);
  } catch (e) {
    showMessage(String(e));
  } finally {
    $('about-check-update').disabled = false;
    $('about-check-update').classList.remove('busy');
  }
});

renderStatus();
renderUpdatePanel();
renderRemote();
setInterval(renderStatus, 15000);
setInterval(renderRemote, 15000);
setInterval(refreshUpdateReadiness, 5000);
