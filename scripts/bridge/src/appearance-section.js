// dsh-desktop-bridge — 外观与动效 (Appearance & motion) settings section.
//
// Registered as a native settings page (`settings.section`, id "appearance"):
// a three-way appearance picker (DSH 默认 / 安静 / 丰富) backed by the desktop
// shell's persisted config. GETs /desktop/motion on mount and POSTs
// /desktop/motion-save on change, so no cross-origin call from the remote dsh
// page is ever made — the same bridge proxy contract used by remote-access.
const react = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { ensureStyles } = require('./styles.js');
const { showMessage } = require('./message.js');

/** GET/POST one /desktop/* route with the { ok, ... } shell envelope. */
async function getJson(path, init) {
  const resp = await fetch(path, init);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${String(resp.status)}`);
  }
  return payload;
}

/** Pure render layer: props in, section markup out (no fetch, no effects). */
function AppearanceSectionView(props) {
  const {
    t, motion, loading, loadError, busy, notice, onChange, onRetry,
    notificationMode, notificationBusy, testBusy, notificationNotice,
    onNotificationChange, onNotificationTest,
  } = props;
  const value = ['default', 'quiet', 'rich'].includes(motion) ? motion : null;
  const notifyValue = ['off', 'unfocused', 'always'].includes(notificationMode)
    ? notificationMode
    : 'unfocused';
  const segCls = (active) => 'dbb_segBtn' + (active ? ' dbb_segActive' : '');

  return jsxs('section', {
    className: 'dbb_appearance',
    'aria-label': t('appearance.title'),
    children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('appearance.title') }),
      jsx('p', { className: 'dbb_aboutIntro', children: t('appearance.intro') }),
      jsxs('div', { className: 'dbb_aboutCard', children: [
        jsx('span', { className: 'dbb_remoteLabel', children: t('appearance.motionLabel') }),
        jsxs('div', {
          className: 'dbb_seg',
          role: 'radiogroup',
          'aria-label': t('appearance.motionLabel'),
          children: [
            jsx('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': value === 'default',
              className: segCls(value === 'default'),
              disabled: busy || loading || loadError !== null,
              onClick: () => onChange('default'),
              children: t('appearance.motionDefault'),
            }),
            jsx('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': value === 'quiet',
              className: segCls(value === 'quiet'),
              disabled: busy || loading || loadError !== null,
              onClick: () => onChange('quiet'),
              children: t('appearance.motionQuiet'),
            }),
            jsx('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': value === 'rich',
              className: segCls(value === 'rich'),
              disabled: busy || loading || loadError !== null,
              onClick: () => onChange('rich'),
              children: t('appearance.motionRich'),
            }),
          ],
        }),
        jsx('p', { className: 'dbb_note', children: t('appearance.hint') }),
        loading
          ? jsx('p', { className: 'dbb_note', role: 'status', children: t('appearance.loading') })
          : loadError !== null
            ? jsxs('div', { className: 'dbb_builtinError dbb_inlineError', role: 'alert', children: [
                jsx('span', { children: t('appearance.offline') }),
                jsx('button', { type: 'button', className: 'dbb_aboutSecondary', onClick: onRetry, children: t('appearance.retry') }),
              ] })
            : null,
        notice !== null && notice?.kind !== 'err'
          ? jsx('p', {
              className: notice?.kind === 'err' ? 'dbb_error' : 'dbb_aboutStatus',
              children: notice.text,
            })
          : null,
      ] }),
      jsxs('div', { className: 'dbb_aboutCard', children: [
        jsx('span', { className: 'dbb_remoteLabel', children: t('appearance.notificationLabel') }),
        jsxs('div', {
          className: 'dbb_seg dbb_notificationSeg',
          role: 'radiogroup',
          'aria-label': t('appearance.notificationLabel'),
          children: [
            jsx('button', {
              type: 'button', role: 'radio',
              'aria-checked': notifyValue === 'off',
              className: segCls(notifyValue === 'off'),
              disabled: notificationBusy || testBusy,
              onClick: () => onNotificationChange('off'),
              children: t('appearance.notificationOff'),
            }),
            jsx('button', {
              type: 'button', role: 'radio',
              'aria-checked': notifyValue === 'unfocused',
              className: segCls(notifyValue === 'unfocused'),
              disabled: notificationBusy || testBusy,
              onClick: () => onNotificationChange('unfocused'),
              children: t('appearance.notificationUnfocused'),
            }),
            jsx('button', {
              type: 'button', role: 'radio',
              'aria-checked': notifyValue === 'always',
              className: segCls(notifyValue === 'always'),
              disabled: notificationBusy || testBusy,
              onClick: () => onNotificationChange('always'),
              children: t('appearance.notificationAlways'),
            }),
          ],
        }),
        jsx('p', { className: 'dbb_note', children: t('appearance.notificationHint') }),
        jsxs('div', { className: 'dbb_aboutActions', children: [
          jsx('button', {
            type: 'button',
            className: 'dbb_aboutSecondary',
            disabled: notificationBusy || testBusy,
            onClick: onNotificationTest,
            children: testBusy ? t('appearance.notificationTesting') : t('appearance.notificationTest'),
          }),
        ] }),
        notificationNotice?.kind === 'ok'
          ? jsx('p', { className: 'dbb_aboutStatus', role: 'status', children: notificationNotice.text })
          : null,
      ] }),
    ],
  });
}

/** Stateful wrapper: loads /desktop/motion once, saves changes optimistic-side. */
function AppearanceSection(props) {
  const { t } = props;
  const [motion, setMotion] = react.useState(null);
  const [loading, setLoading] = react.useState(true);
  const [loadError, setLoadError] = react.useState(null);
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState(null);
  const [notificationMode, setNotificationMode] = react.useState(null);
  const [notificationBusy, setNotificationBusy] = react.useState(false);
  const [testBusy, setTestBusy] = react.useState(false);
  const [notificationNotice, setNotificationNotice] = react.useState(null);
  const [notificationError, setNotificationError] = react.useState(null);
  const motionRequest = react.useRef(0);

  const loadMotion = react.useCallback(async () => {
    const request = ++motionRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await getJson('/desktop/motion');
      if (request !== motionRequest.current) return;
      if (!['default', 'quiet', 'rich'].includes(payload?.motion)) throw new Error(t('appearance.invalidState'));
      setMotion(payload.motion);
    } catch (e) {
      if (request !== motionRequest.current) return;
      setMotion(null);
      setLoadError(String(e?.message ?? e));
    } finally {
      if (request === motionRequest.current) setLoading(false);
    }
  }, [t]);

  react.useEffect(() => {
    ensureStyles();
    loadMotion();
    return () => { motionRequest.current += 1; };
  }, [loadMotion]);

  react.useEffect(() => {
    let cancelled = false;
    getJson('/desktop/notifications')
      .then((payload) => {
        if (cancelled) return;
        setNotificationMode(['off', 'unfocused', 'always'].includes(payload?.mode) ? payload.mode : 'unfocused');
        setNotificationError(null);
      })
      .catch((e) => {
        if (!cancelled) setNotificationError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  react.useEffect(() => { if (loadError !== null) showMessage(`${t('appearance.offline')}（${loadError}）`); }, [loadError, t]);
  react.useEffect(() => { if (notice?.kind === 'err') showMessage(notice.text); }, [notice]);
  react.useEffect(() => {
    if (notificationError !== null) showMessage(`${t('appearance.notificationOffline')}（${notificationError}）`);
  }, [notificationError, t]);
  react.useEffect(() => {
    if (notificationNotice?.kind === 'err') showMessage(notificationNotice.text);
  }, [notificationNotice]);

  const onChange = async (next) => {
    if (busy || loading || loadError !== null || !['default', 'quiet', 'rich'].includes(motion)) return;
    const previous = motion;
    setMotion(next); // optimistic — the ambient layer follows the save's event
    setNotice(null);
    setBusy(true);
    try {
      const payload = await getJson('/desktop/motion-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motion: next }),
      });
      if (payload?.motion !== next) throw new Error(t('appearance.verifyFailed'));
    } catch (e) {
      setMotion(previous);
      setNotice({ kind: 'err', text: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const onNotificationChange = async (next) => {
    if (notificationBusy || testBusy) return;
    const previous = notificationMode;
    setNotificationMode(next);
    setNotificationNotice(null);
    setNotificationBusy(true);
    try {
      await getJson('/desktop/notifications-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
    } catch (e) {
      setNotificationMode(previous);
      setNotificationNotice({ kind: 'err', text: String(e?.message ?? e) });
    } finally {
      setNotificationBusy(false);
    }
  };

  const onNotificationTest = async () => {
    if (notificationBusy || testBusy) return;
    setNotificationNotice(null);
    setTestBusy(true);
    try {
      await getJson('/desktop/notifications-test', { method: 'POST' });
      setNotificationNotice({ kind: 'ok', text: t('appearance.notificationTestSent') });
    } catch (e) {
      setNotificationNotice({ kind: 'err', text: String(e?.message ?? e) });
    } finally {
      setTestBusy(false);
    }
  };

  return jsx(AppearanceSectionView, {
    t,
    motion,
    loading,
    loadError,
    busy,
    notice,
    onChange,
    onRetry: loadMotion,
    notificationMode,
    notificationBusy,
    testBusy,
    notificationNotice,
    onNotificationChange,
    onNotificationTest,
  });
}

module.exports = { AppearanceSection, AppearanceSectionView };
