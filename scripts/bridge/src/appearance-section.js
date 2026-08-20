// dsh-desktop-bridge — 外观与动效 (Appearance & motion) settings section.
//
// Registered as a native settings page (`settings.section`, id "appearance"):
// a two-way motion-intensity picker (安静 / 丰富) backed by the desktop
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
  const { t, motion, loadError, busy, notice, onChange } = props;
  const value = motion === 'quiet' ? 'quiet' : 'rich';
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
              'aria-checked': value === 'quiet',
              className: segCls(value === 'quiet'),
              disabled: busy,
              onClick: () => onChange('quiet'),
              children: t('appearance.motionQuiet'),
            }),
            jsx('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': value === 'rich',
              className: segCls(value === 'rich'),
              disabled: busy,
              onClick: () => onChange('rich'),
              children: t('appearance.motionRich'),
            }),
          ],
        }),
        jsx('p', { className: 'dbb_note', children: t('appearance.hint') }),
        notice !== null && notice?.kind !== 'err'
          ? jsx('p', {
              className: notice?.kind === 'err' ? 'dbb_error' : 'dbb_aboutStatus',
              children: notice.text,
            })
          : null,
      ] }),
    ],
  });
}

/** Stateful wrapper: loads /desktop/motion once, saves changes optimistic-side. */
function AppearanceSection(props) {
  const { t } = props;
  const [motion, setMotion] = react.useState(null);
  const [loadError, setLoadError] = react.useState(null);
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState(null);

  react.useEffect(() => {
    ensureStyles();
    let cancelled = false;
    getJson('/desktop/motion')
      .then((payload) => {
        if (cancelled) return;
        setMotion(payload?.motion === 'quiet' ? 'quiet' : 'rich');
        setLoadError(null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  react.useEffect(() => { if (loadError !== null) showMessage(`${t('appearance.offline')}（${loadError}）`); }, [loadError, t]);
  react.useEffect(() => { if (notice?.kind === 'err') showMessage(notice.text); }, [notice]);

  const onChange = async (next) => {
    if (busy) return;
    const previous = motion;
    setMotion(next); // optimistic — the ambient layer follows the save's event
    setNotice(null);
    setBusy(true);
    try {
      await getJson('/desktop/motion-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motion: next }),
      });
    } catch (e) {
      setMotion(previous);
      setNotice({ kind: 'err', text: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return jsx(AppearanceSectionView, {
    t,
    motion,
    loadError,
    busy,
    notice,
    onChange,
  });
}

module.exports = { AppearanceSection, AppearanceSectionView };
