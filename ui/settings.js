// DSH Desktop settings window — ocean theme + motion layer
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

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
function applyMotion(m) {
  const v = m === 'quiet' ? 'quiet' : 'rich';
  document.documentElement.dataset.motion = v;
  document.querySelectorAll('#motion-seg button').forEach((b) => {
    const on = b.dataset.motion === v;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

const msgAnim = (el) => { if (el) restartAnim(el, 'msg-anim'); };
const msg = (text, cls) => { const m = $('msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };
const upMsg = (text, cls) => { const m = $('up-msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };
const aboutMsg = (text, cls) => { const m = $('about-msg'); m.textContent = text; m.className = cls || ''; msgAnim(m); };

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
  $('st-dsh').innerHTML = badge(st.ui_ready, '运行中', st.dsh_running ? '启动中' : '未运行');
  $('st-bridge').innerHTML = badge(st.bridge_ok, '已连接', '未连接（降级为定时轮询）');
  setVal('st-mode', st.adopted ? '已接管外部 dsh 实例' : '自托管（应用内置 dsh）', 'st-mode');
  setVal('st-versions', `${st.app_version} / ${st.dsh_version || '?'} / ${st.node_version || '?'}`, 'st-versions');
  setVal('st-home', st.dsh_home, 'st-home');
  $('log-path').textContent = `日志：${st.log_path}`;
  $('key').placeholder = st.key_configured ? '已配置（输入新 Key 将覆盖）' : 'sk-...';
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
  const u = e.payload;
  const parts = [];
  if (u.dsh_update_available) {
    parts.push(`dsh 内核有新版：${u.dsh_current} → ${u.dsh_latest}`);
    $('apply-dsh-update').disabled = false;
    $('apply-dsh-update').dataset.tarball = u.dsh_tarball || '';
  }
  if (u.app_update_available) {
    parts.push(`应用有新版：${u.app_current} → ${u.app_latest}`);
    aboutMsg(`应用有新版：${u.app_current} → ${u.app_latest}`, 'ok');
    $('about-release-link').dataset.url = u.app_url || '';
    $('about-release-link').hidden = !u.app_url;
  }
  if (parts.length) upMsg(`【自动检测】${parts.join('；')}`, 'ok');
});

listen('update-rollback', (e) => {
  upMsg(String(e.payload), 'ok');
});

/* ---------------------------------------------------------------------------
 * motion intensity picker
 * ------------------------------------------------------------------------- */

applyMotion(window.__DSH_MOTION__);
document.querySelectorAll('#motion-seg button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const motion = btn.dataset.motion;
    applyMotion(motion);
    try {
      await invoke('set_motion_intensity', { motion });
    } catch (e) {
      msg(String(e), 'err');
      renderStatus(); // re-sync from the authoritative state
    }
  });
});
listen('motion-updated', (e) => {
  if (e.payload && e.payload.motion) applyMotion(e.payload.motion);
});

/* ---------------------------------------------------------------------------
 * API key
 * ------------------------------------------------------------------------- */

$('save').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) { msg('请输入 API Key', 'err'); return; }
  $('save').disabled = true;
  $('save').classList.add('busy');
  msg('正在验证 Key 并查询余额…');
  try {
    const res = await invoke('set_api_key', { key });
    msg(res.configured ? 'Key 已保存，DSH 与余额查询均已生效。' : 'Key 已清除。', 'ok');
    $('key').value = '';
    renderStatus();
  } catch (e) {
    msg(String(e), 'err');
  } finally {
    $('save').disabled = false;
    $('save').classList.remove('busy');
  }
});

$('clear').addEventListener('click', async () => {
  $('clear').disabled = true;
  $('clear').classList.add('busy');
  try {
    await invoke('set_api_key', { key: '' });
    msg('Key 已清除。', 'ok');
    $('key').value = '';
    renderStatus();
  } catch (e) {
    msg(String(e), 'err');
  } finally {
    $('clear').disabled = false;
    $('clear').classList.remove('busy');
  }
});

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  $('refresh').classList.add('busy');
  msg('正在查询余额…');
  try {
    const bal = await invoke('refresh_balance');
    renderBalance(bal, new Date().toLocaleTimeString());
    msg(bal ? '余额已刷新。' : '未配置 Key，无法查询余额。', bal ? 'ok' : 'err');
  } catch (e) {
    msg(String(e), 'err');
  } finally {
    $('refresh').disabled = false;
    $('refresh').classList.remove('busy');
  }
});

$('open-logs').addEventListener('click', () => invoke('open_logs'));
$('open-home').addEventListener('click', () => invoke('open_dsh_home'));

/* ---------------------------------------------------------------------------
 * updates
 * ------------------------------------------------------------------------- */

async function renderUpdatePanel() {
  try {
    const st = await invoke('get_status');
    $('up-app').textContent = st.app_version;
    $('up-dsh').textContent = st.dsh_version || '?';
    $('about-version').textContent = 'v' + st.app_version;
  } catch (e) { /* ignore */ }
}

$('check-update').addEventListener('click', async () => {
  $('check-update').disabled = true;
  $('check-update').classList.add('busy');
  upMsg('正在检查更新…');
  try {
    const u = await invoke('check_update');
    const parts = [];
    if (u.dsh_update_available) {
      parts.push(`dsh 内核：${u.dsh_current} → ${u.dsh_latest}`);
      $('apply-dsh-update').disabled = false;
      $('apply-dsh-update').dataset.tarball = u.dsh_tarball || '';
    } else {
      parts.push(`dsh 内核已是最新（${u.dsh_current || '?'}）`);
      $('apply-dsh-update').disabled = true;
    }
    if (u.app_repo) {
      if (u.app_update_available) parts.push(`壳：${u.app_current} → ${u.app_latest}（请前往 Releases 下载安装）`);
      else parts.push(`壳已是最新（${u.app_current}）`);
    } else {
      parts.push('壳更新未配置仓库');
    }
    upMsg(parts.join('；'), u.dsh_update_available || u.app_update_available ? 'ok' : '');
  } catch (e) {
    upMsg(String(e), 'err');
  } finally {
    $('check-update').disabled = false;
    $('check-update').classList.remove('busy');
  }
});

$('apply-dsh-update').addEventListener('click', async () => {
  if (!confirm('更新 dsh 内核？更新会自动备份当前版本并在失败时回滚，正在运行中的对话不受影响。')) return;
  $('apply-dsh-update').disabled = true;
  $('apply-dsh-update').classList.add('busy');
  upMsg('正在下载并应用 dsh 更新（请勿关闭应用）…');
  try {
    const tarball = $('apply-dsh-update').dataset.tarball || null;
    const result = await invoke('apply_dsh_update', { tarball });
    upMsg(result, 'ok');
    $('apply-dsh-update').disabled = true;
    renderStatus();
    renderUpdatePanel();
  } catch (e) {
    upMsg(String(e), 'err');
    $('apply-dsh-update').disabled = false;
  } finally {
    $('apply-dsh-update').classList.remove('busy');
  }
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
    upMsg(`设置开机自启失败：${e}`, 'err');
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
    aboutMsg(String(e), 'err');
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
    const u = await invoke('check_update');
    const parts = [];
    if (u.dsh_update_available) parts.push(`dsh 内核：${u.dsh_current} → ${u.dsh_latest}`);
    else parts.push(`dsh 内核已是最新（${u.dsh_current || '?'}）`);
    if (u.app_repo) {
      if (u.app_update_available) {
        parts.push(`应用：${u.app_current} → ${u.app_latest}`);
        $('about-release-link').dataset.url = u.app_url || '';
        $('about-release-link').hidden = !u.app_url;
      } else {
        parts.push(`应用已是最新（${u.app_current}）`);
        $('about-release-link').hidden = true;
      }
    } else {
      $('about-release-link').hidden = true;
    }
    aboutMsg(parts.join('；'), u.dsh_update_available || u.app_update_available ? 'ok' : '');
  } catch (e) {
    aboutMsg(String(e), 'err');
  } finally {
    $('about-check-update').disabled = false;
    $('about-check-update').classList.remove('busy');
  }
});

renderStatus();
renderUpdatePanel();
setInterval(renderStatus, 15000);
