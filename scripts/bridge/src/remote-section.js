// dsh-desktop-bridge — 远程访问 (Remote access) settings section.
//
// Registered as a native settings page (`settings.section`, id "remote-access",
// first in the nav rail): configures the relay-client companion through the
// bridge's same-origin /desktop/* proxy (shell listener → /remote-config,
// /remote-save, /remote-pairing), so no cross-origin call from the dsh page
// is ever made.
//
// Product flow: remote access works out of the box against the public default
// relay — the user only picks a device name. Checking "自定义中继服务器"
// reveals the relay URL field so they can override the default with their own
// relay. The shell auto-registers the device (device secret never shown);
// phones connect by redeeming a 6-digit pairing code minted here.
const react = require('react');
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const { ensureStyles } = require('./styles.js');
const { qrSvgDataUri } = require('./qr.js');
const { showMessage } = require('./message.js');

// Fallback in case an older shell omits `defaultRelayUrl` from the snapshot;
// the shell is the source of truth and reports the real default.
const DEFAULT_RELAY_URL = 'wss://remote.anixuil.com';

/** GET/POST one /desktop/* route with the { ok, ... } shell envelope. */
async function getJson(path, init) {
  const resp = await fetch(path, init);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${String(resp.status)}`);
  }
  return payload;
}

function statusBadge(cfg, t) {
  if (cfg?.enabled !== true) {
    return jsx('span', { className: 'dbb_badge dbb_badgeErr', children: t('remote.stateOff') });
  }
  if (cfg?.online === true) {
    return jsx('span', { className: 'dbb_badge dbb_badgeOk', children: t('remote.stateOnline') });
  }
  if (cfg?.running === true) {
    return jsx('span', { className: 'dbb_badge dbb_badgeWarn', children: t('remote.stateConnecting') });
  }
  return jsx('span', { className: 'dbb_badge dbb_badgeWarn', children: t('remote.stateStopped') });
}

/** Pure render layer: props in, section markup out (no fetch, no effects). */
function RemoteSectionView(props) {
  const { t, cfg, loadError, busy, notice, pairingBusy, pairingCode, pairingQr, pairingError, persistentCode, persistentBusy, persistentNotice, onPersistentCodeChange, onSavePersistentCode, onChange, onSave, onPair } = props;
  const custom = cfg?.customRelay === true;
  const defaultRelayUrl = cfg?.defaultRelayUrl || DEFAULT_RELAY_URL;
  return jsxs('section', {
    className: 'dbb_remote',
    'aria-label': t('remote.title'),
    children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('remote.title') }),
      jsx('p', { className: 'dbb_aboutIntro', children: t('remote.intro') }),
      jsxs('div', { className: 'dbb_aboutCard', children: [
        jsxs('label', { className: 'dbb_remoteSwitch', children: [
          jsx('input', {
            type: 'checkbox',
            checked: cfg?.enabled === true,
            onChange: (e) => onChange({ enabled: e.target.checked }),
          }),
          jsx('span', { className: 'dbb_remoteSwitchText', children: t('remote.enabled') }),
        ] }),
        jsxs('label', { className: 'dbb_remoteSwitch dbb_remoteCustomSwitch', children: [
          jsx('input', {
            type: 'checkbox',
            checked: custom,
            onChange: (e) => onChange({ customRelay: e.target.checked }),
          }),
          jsx('span', { className: 'dbb_remoteSwitchText', children: t('remote.customRelay') }),
        ] }),
        custom
          ? jsxs('label', { className: 'dbb_remoteField', children: [
              jsx('span', { className: 'dbb_remoteLabel', children: t('remote.relayUrl') }),
              jsx('input', {
                type: 'text',
                className: 'dbb_remoteInput',
                placeholder: 'wss://your-relay.example.com',
                value: cfg?.relayUrl ?? '',
                onChange: (e) => onChange({ relayUrl: e.target.value }),
                spellCheck: false,
                autoComplete: 'off',
              }),
            ] })
          : jsx('div', { className: 'dbb_remoteField dbb_remoteDefaultField', children: [
              jsx('span', { className: 'dbb_remoteLabel', children: t('remote.relayUrl') }),
              jsx('div', { className: 'dbb_remoteDefault', children: defaultRelayUrl }),
            ] }),
      jsxs('label', { className: 'dbb_remoteField', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('remote.deviceId') }),
          jsx('input', {
            type: 'text',
            className: 'dbb_remoteInput',
            placeholder: 'my-pc',
            value: cfg?.deviceId ?? '',
            onChange: (e) => onChange({ deviceId: e.target.value }),
            spellCheck: false,
            autoComplete: 'off',
          }),
        ] }),
        jsxs('label', { className: 'dbb_remoteField', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('remote.maxConcurrent') }),
          jsx('input', {
            type: 'number', min: 1, max: 64, step: 1,
            className: 'dbb_remoteInput',
            value: cfg?.maxConcurrent ?? 3,
            onChange: (e) => onChange({ maxConcurrent: Math.max(1, Math.min(64, Number(e.target.value) || 1)) }),
          }),
        ] }),
        jsxs('div', { className: 'dbb_aboutActions', children: [
          jsx('button', {
            type: 'button',
            className: 'dbb_aboutPrimary',
            disabled: busy,
            onClick: onSave,
            children: busy ? t('remote.saving') : t('remote.save'),
          }),
          jsx('button', {
            type: 'button',
            className: 'dbb_aboutSecondary',
            disabled: pairingBusy || cfg?.enabled !== true,
            onClick: onPair,
            children: pairingBusy ? t('remote.pairingBusy') : t('remote.pair'),
          }),
          statusBadge(cfg, t),
        ] }),
        jsxs('div', { className: 'dbb_remotePersistent', children: [
          jsx('span', { className: 'dbb_remoteLabel', children: t('remote.persistentCode') }),
          jsx('p', { className: 'dbb_note', children: t('remote.persistentHint') }),
          jsx('input', {
            type: 'password', className: 'dbb_remoteInput', value: persistentCode,
            placeholder: cfg?.persistentPairingEnabled ? t('remote.persistentReplace') : t('remote.persistentPlaceholder'),
            onChange: (e) => onPersistentCodeChange(e.target.value), autoComplete: 'new-password',
          }),
          jsxs('div', { className: 'dbb_aboutActions', children: [
            jsx('button', { type: 'button', className: 'dbb_aboutSecondary', disabled: persistentBusy || busy || cfg?.enabled !== true, onClick: onSavePersistentCode, children: persistentBusy ? t('remote.persistentSaving') : t('remote.persistentSave') }),
            cfg?.persistentPairingEnabled ? jsx('span', { className: 'dbb_badge dbb_badgeOk', children: t('remote.persistentEnabled') }) : null,
          ] }),
          persistentNotice?.kind !== 'err' && persistentNotice ? jsx('p', { className: 'dbb_aboutStatus', children: persistentNotice.text }) : null,
        ] }),
        pairingCode
          ? jsx('p', { className: 'dbb_remoteCode', children: t('remote.pairCode', { code: pairingCode }) })
          : null,
        pairingQr
          ? jsxs('div', { className: 'dbb_remoteQr', children: [
              jsx('img', { src: pairingQr, alt: t('remote.qrAlt') }),
              jsx('p', { className: 'dbb_note', children: t('remote.qrHint') }),
            ] })
          : null,
        jsxs('div', { className: 'dbb_row', children: [
          jsx('span', { className: 'dbb_rowLabel', children: t('remote.entry') }),
          cfg?.entry
            ? jsx('span', { className: 'dbb_rowValue', children: cfg.entry })
            : jsx('span', { className: 'dbb_rowValue', children: t('remote.entryNone') }),
        ] }),
        notice !== null && notice?.kind !== 'err'
          ? jsx('p', {
              className: notice?.kind === 'err' ? 'dbb_error' : 'dbb_aboutStatus',
              children: notice.text,
            })
          : null,
        jsx('p', { className: 'dbb_note', children: t('remote.note') }),
      ] }),
    ],
  });
}

/** Stateful wrapper: loads /desktop/remote-config once, drives saves and pairing. */
function RemoteSection(props) {
  const { t } = props;
  const [cfg, setCfg] = react.useState(null);
  const [loadError, setLoadError] = react.useState(null);
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState(null);
  const [pairingBusy, setPairingBusy] = react.useState(false);
  const [pairingCode, setPairingCode] = react.useState(null);
  const [pairingQr, setPairingQr] = react.useState(null);
  const [pairingError, setPairingError] = react.useState(null);
  const [persistentCode, setPersistentCode] = react.useState('');
  const [persistentBusy, setPersistentBusy] = react.useState(false);
  const [persistentNotice, setPersistentNotice] = react.useState(null);

  react.useEffect(() => {
    ensureStyles();
    let cancelled = false;
    getJson('/desktop/remote-config')
      .then((payload) => {
        if (cancelled) return;
        setCfg(payload?.config ?? null);
        setLoadError(null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  react.useEffect(() => { if (loadError !== null) showMessage(`${t('remote.offline')}（${loadError}）`); }, [loadError, t]);
  react.useEffect(() => { if (notice?.kind === 'err') showMessage(notice.text); }, [notice]);
  react.useEffect(() => { if (pairingError !== null) showMessage(pairingError); }, [pairingError]);
  react.useEffect(() => { if (persistentNotice?.kind === 'err') showMessage(persistentNotice.text); }, [persistentNotice]);

  const onChange = (patch) => {
    setCfg((prev) => {
      const base = prev ?? { enabled: false, relayUrl: '', secret: '', deviceId: '', customRelay: false, defaultRelayUrl: DEFAULT_RELAY_URL };
      const defaultUrl = base.defaultRelayUrl || DEFAULT_RELAY_URL;
      const next = { ...base, ...patch };
      // Toggling custom relay ON: never prefill the public default into the
      // custom URL field — the user types their own relay.
      if (patch.customRelay === true && base.customRelay !== true && base.relayUrl === defaultUrl) {
        next.relayUrl = '';
      }
      return next;
    });
    setNotice(null);
  };

  const saveRemoteConfig = async (sourceCfg, showNotice = true) => {
    if (sourceCfg === null) return null;
    const custom = sourceCfg.customRelay === true;
    const defaultUrl = sourceCfg.defaultRelayUrl || DEFAULT_RELAY_URL;
    // Effective relay: the user's custom URL when custom is on, otherwise the
    // public default relay (nothing to fill in).
    const relayUrl = custom ? String(sourceCfg.relayUrl ?? '').trim() : defaultUrl;
    const deviceId = String(sourceCfg.deviceId ?? '').trim();
    if (sourceCfg.enabled === true) {
      if (custom && !/^wss?:\/\//.test(relayUrl)) { if (showNotice) setNotice({ kind: 'err', text: t('remote.badUrl') }); return null; }
      if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(deviceId)) { if (showNotice) setNotice({ kind: 'err', text: t('remote.badDevice') }); return null; }
    }
    setBusy(true);
    if (showNotice) { setNotice(null); setPairingCode(null); setPairingError(null); }
    try {
      const payload = await getJson('/desktop/remote-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: sourceCfg.enabled === true, relayUrl, customRelay: custom, secret: '', deviceId, maxConcurrent: Number(sourceCfg.maxConcurrent ?? 3) }),
      });
      const nextCfg = payload?.config ?? sourceCfg;
      setCfg(nextCfg);
      if (showNotice) setNotice({ kind: nextCfg.online === true ? 'ok' : '', text: sourceCfg.enabled === true ? (nextCfg.online === true ? t('remote.saved') : t('remote.savedPending')) : t('remote.disabled') });
      return nextCfg;
    } catch (e) {
      if (showNotice) setNotice({ kind: 'err', text: String(e?.message ?? e) });
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (busy || cfg === null) return;
    try { await saveRemoteConfig(cfg); } catch { /* notice is rendered by helper */ }
  };

  const onPair = async () => {
    if (pairingBusy) return;
    setPairingBusy(true);
    setPairingError(null);
    setPairingCode(null);
    setPairingQr(null);
    try {
      const payload = await getJson('/desktop/remote-pairing');
      const code = payload?.pairing?.code;
      if (typeof code === 'string') {
        setPairingCode(code);
        const entry = payload?.pairing?.entry;
        try {
          if (entry) setPairingQr(qrSvgDataUri(`${entry}?code=${code}`));
        } catch {
          // qr rendering is best-effort; the numeric code stays usable
        }
      } else {
        setPairingError(payload?.error ?? t('remote.pairFail'));
      }
    } catch (e) {
      setPairingError(String(e?.message ?? e));
    } finally {
      setPairingBusy(false);
    }
  };

  const onSavePersistentCode = async () => {
    if (persistentBusy) return;
    if (persistentCode !== '' && (persistentCode.length < 6 || persistentCode.length > 64)) {
      setPersistentNotice({ kind: 'err', text: t('remote.persistentInvalid') });
      return;
    }
    setPersistentBusy(true);
    setPersistentNotice(null);
    try {
      // The long-lived code depends on a registered device. Commit the
      // current remote settings first so this action works on its own, even
      // when the user has not pressed “保存并连接” yet.
      const savedCfg = await saveRemoteConfig(cfg, false);
      if (savedCfg === null) return;
      const payload = await getJson('/desktop/remote-persistent-pairing', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: persistentCode }),
      });
      setCfg(payload?.config ?? savedCfg ?? cfg);
      setPersistentCode('');
      setPersistentNotice({ kind: 'ok', text: persistentCode ? t('remote.persistentSaved') : t('remote.persistentCleared') });
    } catch (e) {
      setPersistentNotice({ kind: 'err', text: String(e?.message ?? e) });
    } finally { setPersistentBusy(false); }
  };

  return jsx(RemoteSectionView, {
    t,
    cfg,
    loadError,
    busy,
    notice,
    pairingBusy,
    pairingCode,
    pairingQr,
    pairingError,
    persistentCode,
    persistentBusy,
    persistentNotice,
    onPersistentCodeChange: setPersistentCode,
    onSavePersistentCode,
    onChange,
    onSave,
    onPair,
  });
}

module.exports = { RemoteSection, RemoteSectionView };
