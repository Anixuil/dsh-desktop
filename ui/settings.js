// DSH Desktop settings window
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const msg = (text, cls) => { const m = $('msg'); m.textContent = text; m.className = cls || ''; };

function renderBalance(balance, at) {
  if (!balance) {
    $('bal-status').innerHTML = '<span class="badge warn">未获取</span>';
    $('bal-total').textContent = '—';
    $('bal-topped').textContent = '—';
    $('bal-granted').textContent = '—';
    $('bal-currency').textContent = '—';
    $('bal-at').textContent = at || '—';
    return;
  }
  if (!balance.is_available) {
    $('bal-status').innerHTML = '<span class="badge err">账户余额不可用</span>';
  } else {
    $('bal-status').innerHTML = '<span class="badge ok">可用</span>';
  }
  const info = balance.balance_infos && balance.balance_infos[0];
  if (info) {
    $('bal-total').textContent = info.total_balance;
    $('bal-topped').textContent = info.topped_up_balance;
    $('bal-granted').textContent = info.granted_balance;
    $('bal-currency').textContent = info.currency;
  }
  $('bal-at').textContent = at || '—';
}

function badge(ok, okText, badText) {
  return ok ? `<span class="badge ok">${okText}</span>` : `<span class="badge err">${badText}</span>`;
}

async function renderStatus() {
  const st = await invoke('get_status');
  $('st-dsh').innerHTML = badge(st.ui_ready, '运行中', st.dsh_running ? '启动中' : '未运行');
  $('st-bridge').innerHTML = badge(st.bridge_ok, '已连接', '未连接（降级为定时轮询）');
  $('st-mode').textContent = st.adopted ? '已接管外部 dsh 实例' : '自托管（应用内置 dsh）';
  $('st-versions').textContent = `${st.app_version} / ${st.dsh_version || '?'} / ${st.node_version || '?'}`;
  $('st-home').textContent = st.dsh_home;
  $('log-path').textContent = `日志：${st.log_path}`;
  $('key').placeholder = st.key_configured ? '已配置（输入新 Key 将覆盖）' : 'sk-...';
  renderBalance(st.balance, null);
}

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

$('save').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) { msg('请输入 API Key', 'err'); return; }
  $('save').disabled = true;
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
  }
});

$('clear').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    await invoke('set_api_key', { key: '' });
    msg('Key 已清除。', 'ok');
    $('key').value = '';
    renderStatus();
  } catch (e) {
    msg(String(e), 'err');
  } finally {
    $('save').disabled = false;
  }
});

$('refresh').addEventListener('click', async () => {
  msg('正在查询余额…');
  try {
    const bal = await invoke('refresh_balance');
    renderBalance(bal, new Date().toLocaleTimeString());
    msg(bal ? '余额已刷新。' : '未配置 Key，无法查询余额。', bal ? 'ok' : 'err');
  } catch (e) {
    msg(String(e), 'err');
  }
});

$('open-logs').addEventListener('click', () => invoke('open_logs'));
$('open-home').addEventListener('click', () => invoke('open_dsh_home'));

// ---- updates ----
const upMsg = (text, cls) => { const m = $('up-msg'); m.textContent = text; m.className = cls || ''; };

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
  }
});

$('apply-dsh-update').addEventListener('click', async () => {
  if (!confirm('更新 dsh 内核？更新会自动备份当前版本并在失败时回滚，正在运行中的对话不受影响。')) return;
  $('apply-dsh-update').disabled = true;
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
  }
});

// ---- autostart ----
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

// ---- about ----
const BLOG_URL = 'https://www.anixuil.top';
const GITHUB_URL = 'https://github.com/Anixuil/dsh-desktop';

const aboutMsg = (text, cls) => { const m = $('about-msg'); m.textContent = text; m.className = cls || ''; };

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
  }
});

renderStatus();
renderUpdatePanel();
setInterval(renderStatus, 15000);
