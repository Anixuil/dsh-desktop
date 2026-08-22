// dsh-desktop-bridge - built-in plugin controls kept in the bridge control
// plane so the user can always re-enable desktop integration.
const react = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { ensureStyles } = require('./styles.js');
const { showMessage } = require('./message.js');

const PLUGIN_GROUPS = [
  {
    id: 'desktop',
    plugins: [
      'dsh-desktop-bridge',
      'dsh-desktop-session-manager',
      'dsh-desktop-change-history',
      'dsh-desktop-file-upload',
      'dsh-desktop-conversation-navigator',
    ],
  },
  { id: 'services', plugins: ['dsh-vision-any', 'dshmarket'] },
];

async function getJson(path, init) {
  const resp = await fetch(path, init);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${String(resp.status)}`);
  return payload;
}

function sameEnabled(left, right) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function sourceLabel(t, source) {
  if (source === 'user') return t('builtinPlugins.sourceUser');
  if (source === 'bundledThirdParty') return t('builtinPlugins.sourceThirdParty');
  return t('builtinPlugins.sourceDesktop');
}

function PluginRow({ t, plugin, enabled, busy, onToggle }) {
  const id = plugin.id;
  return jsxs('div', { className: 'dbb_builtinRow', children: [
    jsxs('div', { className: 'dbb_builtinCopy', children: [
      jsxs('div', { className: 'dbb_builtinNameLine', children: [
        jsx('strong', { className: 'dbb_builtinName', children: t(`builtinPlugins.${id}.name`) }),
        plugin.version ? jsx('span', { className: 'dbb_builtinVersion', children: `v${plugin.version}` }) : null,
      ] }),
      jsx('p', { className: 'dbb_builtinDescription', children: t(`builtinPlugins.${id}.description`) }),
      jsxs('div', { className: 'dbb_builtinMeta', children: [
        jsx('span', { children: sourceLabel(t, plugin.source) }),
        plugin.controlPlaneRetained && !enabled
          ? jsx('span', { children: t('builtinPlugins.controlPlane') })
          : null,
      ] }),
    ] }),
    jsxs('label', { className: 'dbb_builtinSwitch', children: [
      jsx('input', {
        type: 'checkbox',
        checked: enabled,
        disabled: busy,
        onChange: () => onToggle(id),
        'aria-label': t('builtinPlugins.toggle', { name: t(`builtinPlugins.${id}.name`) }),
      }),
      jsx('span', { className: 'dbb_builtinSwitchTrack', 'aria-hidden': 'true' }),
      jsx('span', { className: 'dbb_builtinState', children: enabled ? t('builtinPlugins.on') : t('builtinPlugins.off') }),
    ] }),
  ] });
}

function BuiltinPluginsSectionView({ t, plugins, enabled, initialEnabled, loading, busy, loadError, onToggle, onEnableAll, onCancel, onApply, onRetry }) {
  const dirty = !sameEnabled(enabled, initialEnabled);
  const count = enabled.size;
  return jsxs('section', { className: 'dbb_builtin', 'aria-label': t('builtinPlugins.title'), children: [
    jsxs('div', { className: 'dbb_builtinHeader', children: [
      jsxs('div', { children: [
        jsx('h2', { className: 'dbb_aboutTitle', children: t('builtinPlugins.title') }),
        jsx('p', { className: 'dbb_aboutIntro', children: t('builtinPlugins.intro') }),
      ] }),
      plugins.length > 0
        ? jsx('span', { className: 'dbb_builtinCount', children: t('builtinPlugins.count', { enabled: count, total: plugins.length }) })
        : null,
    ] }),
    loadError !== null
      ? jsxs('div', { className: 'dbb_builtinError dbb_inlineError', role: 'alert', children: [
          jsx('span', { children: t('builtinPlugins.offline') }),
          jsx('button', { type: 'button', className: 'dbb_aboutSecondary', onClick: onRetry, children: t('builtinPlugins.retry') }),
        ] })
      : loading
        ? jsx('div', { className: 'dbb_builtinSkeleton', 'aria-label': t('builtinPlugins.loading'), children: [0, 1, 2].map((id) => jsx('span', {}, id)) })
        : PLUGIN_GROUPS.map((group) => jsxs('div', { className: 'dbb_builtinGroup', children: [
          jsx('h3', { className: 'dbb_builtinGroupTitle', children: t(`builtinPlugins.group.${group.id}`) }),
          jsx('div', { className: 'dbb_builtinList', children: group.plugins.map((id) => {
            const plugin = plugins.find((item) => item.id === id);
            return plugin ? jsx(PluginRow, { t, plugin, enabled: enabled.has(id), busy, onToggle }, id) : null;
          }) }),
        ] }, group.id)),
    plugins.length > 0 ? jsxs('div', { className: 'dbb_builtinFooter' + (dirty ? ' dbb_builtinFooterVisible' : ''), children: [
      jsx('p', { className: 'dbb_builtinRestartHint', children: dirty ? t('builtinPlugins.pending') : t('builtinPlugins.restartHint') }),
      jsxs('div', { className: 'dbb_builtinActions', children: [
        jsx('button', { type: 'button', className: 'dbb_builtinTextButton', disabled: busy || count === plugins.length, onClick: onEnableAll, children: t('builtinPlugins.enableAll') }),
        dirty ? jsx('button', { type: 'button', className: 'dbb_aboutSecondary', disabled: busy, onClick: onCancel, children: t('builtinPlugins.cancel') }) : null,
        dirty ? jsx('button', { type: 'button', className: 'dbb_aboutPrimary', disabled: busy, onClick: onApply, children: busy ? t('builtinPlugins.applying') : t('builtinPlugins.apply') }) : null,
      ] }),
    ] }) : null,
  ] });
}

function BuiltinPluginsSection({ t }) {
  const [plugins, setPlugins] = react.useState([]);
  const [enabled, setEnabled] = react.useState(new Set());
  const [initialEnabled, setInitialEnabled] = react.useState(new Set());
  const [loading, setLoading] = react.useState(true);
  const [busy, setBusy] = react.useState(false);
  const [loadError, setLoadError] = react.useState(null);
  const loadRequest = react.useRef(0);

  const loadSnapshot = react.useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await getJson('/desktop/builtin-plugins');
      if (request !== loadRequest.current) return;
      const rows = Array.isArray(payload.plugins) ? payload.plugins : null;
      if (rows === null || rows.length === 0 || rows.some((plugin) => typeof plugin?.id !== 'string')) {
        throw new Error(t('builtinPlugins.verifyFailed'));
      }
      const active = new Set(rows.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id));
      setPlugins(rows);
      setEnabled(active);
      setInitialEnabled(new Set(active));
    } catch (error) {
      if (request !== loadRequest.current) return;
      setPlugins([]);
      setEnabled(new Set());
      setInitialEnabled(new Set());
      setLoadError(String(error?.message ?? error));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [t]);

  react.useEffect(() => {
    ensureStyles();
    loadSnapshot();
    return () => { loadRequest.current += 1; };
  }, [loadSnapshot]);

  react.useEffect(() => {
    if (loadError !== null) showMessage(`${t('builtinPlugins.offline')}（${loadError}）`);
  }, [loadError, t]);

  const onToggle = (id) => setEnabled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const onEnableAll = () => setEnabled(new Set(plugins.map((plugin) => plugin.id)));
  const onCancel = () => setEnabled(new Set(initialEnabled));
  const onApply = async () => {
    if (loading || loadError !== null || plugins.length === 0 || busy) return;
    setBusy(true);
    try {
      const payload = await getJson('/desktop/builtin-plugins-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: [...enabled],
          expectedEnabled: [...initialEnabled],
        }),
      });
      const rows = Array.isArray(payload.plugins) ? payload.plugins : null;
      const expectedIds = new Set(plugins.map((plugin) => plugin.id));
      if (rows === null || rows.length !== plugins.length || rows.some((plugin) => !expectedIds.has(plugin?.id))) {
        throw new Error(t('builtinPlugins.verifyFailed'));
      }
      const active = new Set(rows.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id));
      if (!sameEnabled(active, enabled)) throw new Error(t('builtinPlugins.verifyFailed'));
      setPlugins(rows);
      setEnabled(active);
      setInitialEnabled(new Set(active));
      showMessage(t('builtinPlugins.restarting'));
    } catch (error) {
      showMessage(String(error?.message ?? error));
      setBusy(false);
    }
  };

  return jsx(BuiltinPluginsSectionView, {
    t, plugins, enabled, initialEnabled, loading, busy, loadError,
    onToggle, onEnableAll, onCancel, onApply, onRetry: loadSnapshot,
  });
}

module.exports = { BuiltinPluginsSection, BuiltinPluginsSectionView, sameEnabled };
