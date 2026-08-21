// Plugin download network settings. The desktop shell owns persistence and
// restarts DSH after a save so dshmarket's packaged pnpm receives the new env.
const react = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { ensureStyles } = require('./styles.js');
const { showMessage } = require('./message.js');

async function getJson(path, init) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

function NetworkSectionView({ t, config, busy, testing, result, onChange, onSave, onTest }) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  return jsxs('section', {
    className: 'dbb_pluginNetwork',
    'aria-label': t('pluginNetwork.title'),
    children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('pluginNetwork.title') }),
      jsx('p', { className: 'dbb_aboutIntro', children: t('pluginNetwork.intro') }),
      jsxs('div', { className: 'dbb_aboutCard', children: [
        jsxs('label', { className: 'dbb_remoteField', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('pluginNetwork.proxy') }),
          jsx('input', { className: 'dbb_remoteInput', type: 'url', placeholder: 'http://127.0.0.1:7890', value: config.proxy ?? '', onChange: (e) => onChange({ proxy: e.target.value }), spellCheck: false, autoComplete: 'off' }),
          jsx('span', { className: 'dbb_note dbb_networkHint', children: t('pluginNetwork.proxyHint') }),
        ] }),
        jsxs('label', { className: 'dbb_remoteField', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('pluginNetwork.registry') }),
          jsx('input', { className: 'dbb_remoteInput', type: 'url', placeholder: 'https://registry.npmjs.org/', value: config.npmRegistry ?? '', onChange: (e) => onChange({ npmRegistry: e.target.value }), spellCheck: false, autoComplete: 'off' }),
          jsx('span', { className: 'dbb_note dbb_networkHint', children: t('pluginNetwork.registryHint') }),
        ] }),
        jsxs('label', { className: 'dbb_remoteField', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('pluginNetwork.timeout') }),
          jsx('select', { className: 'dbb_remoteInput dbb_networkSelect', value: String(config.installTimeoutMinutes ?? 30), onChange: (e) => onChange({ installTimeoutMinutes: Number(e.target.value) }), children: [10, 20, 30, 45, 60].map((minutes) => jsx('option', { value: String(minutes), children: t('pluginNetwork.minutes', { minutes }) }, minutes)) }),
        ] }),
        jsxs('div', { className: 'dbb_aboutActions', children: [
          jsx('button', { type: 'button', className: 'dbb_aboutPrimary', disabled: busy || testing, onClick: onSave, children: busy ? t('pluginNetwork.saving') : t('pluginNetwork.save') }),
          jsx('button', { type: 'button', className: 'dbb_aboutSecondary', disabled: busy || testing, onClick: onTest, children: testing ? t('pluginNetwork.testing') : t('pluginNetwork.test') }),
        ] }),
        jsx('p', { className: 'dbb_note', children: t('pluginNetwork.restartHint') }),
      ] }),
      result ? jsxs('div', { className: 'dbb_networkResults', children: [
        jsx('span', { className: 'dbb_remoteLabel', children: result.ok ? t('pluginNetwork.healthy') : t('pluginNetwork.unhealthy') }),
        ...checks.map((check) => jsxs('div', { className: 'dbb_networkRow', children: [
          jsx('span', { className: check.ok ? 'dbb_badge dbb_badgeOk' : 'dbb_badge dbb_badgeErr', children: check.ok ? t('pluginNetwork.ok') : t('pluginNetwork.failed') }),
          jsx('span', { className: 'dbb_networkName', children: check.name }),
          jsx('span', { className: 'dbb_networkMeta', children: check.ok ? `${check.status} · ${check.elapsedMs}ms` : String(check.error ?? t('pluginNetwork.failed')) }),
        ] }, check.name)),
      ] }) : null,
    ],
  });
}

function PluginNetworkSection({ t }) {
  const [config, setConfig] = react.useState({ proxy: '', npmRegistry: '', installTimeoutMinutes: 30 });
  const [busy, setBusy] = react.useState(false);
  const [testing, setTesting] = react.useState(false);
  const [result, setResult] = react.useState(null);

  react.useEffect(() => {
    ensureStyles();
    getJson('/desktop/plugin-network').then((payload) => setConfig((previous) => ({ ...previous, ...(payload.config ?? {}) }))).catch((error) => showMessage(`${t('pluginNetwork.offline')}（${String(error?.message ?? error)}）`));
  }, [t]);

  const onSave = async () => {
    setBusy(true);
    try {
      const payload = await getJson('/desktop/plugin-network-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
      setConfig((previous) => ({ ...previous, ...(payload.config ?? {}) }));
      showMessage(t('pluginNetwork.saved'));
    } catch (error) {
      showMessage(String(error?.message ?? error));
    } finally { setBusy(false); }
  };
  const onTest = async () => {
    setTesting(true);
    try { setResult(await getJson('/desktop/plugin-network-test', { method: 'POST' })); }
    catch (error) { setResult({ ok: false, checks: [{ name: 'network', ok: false, error: String(error?.message ?? error) }] }); }
    finally { setTesting(false); }
  };
  return jsx(NetworkSectionView, { t, config, busy, testing, result, onChange: (patch) => setConfig((previous) => ({ ...previous, ...patch })), onSave, onTest });
}

module.exports = { PluginNetworkSection, NetworkSectionView };
