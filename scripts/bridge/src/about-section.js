// dsh-desktop-bridge — 关于 (About) settings section.
//
// Registered as a native settings page (`settings.section`, id "about", last
// in the nav rail): shows the desktop shell identity (author / blog / repo)
// with one-click links into the system default browser and a check-update
// action. Data comes from the shell through the bridge's same-origin
// /desktop/* proxy (shell listener → /about, /update-status, /open-external),
// so no cross-origin call from the remote dsh page is ever made.
const react = require('react');
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { ensureStyles } = require('./styles.js');

const BLOG_URL = 'https://www.anixuil.top';
const REPO_URL = 'https://github.com/Anixuil/dsh-desktop';

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
function AboutSectionView(props) {
  const { t, info, loadError, update, busy, notice, onOpen, onCheck } = props;
  const u = update?.status ?? null;

  const parts = [];
  if (u?.appUpdateAvailable === true) parts.push(t('about.appUpdate', { version: u.appLatest ?? '?' }));
  if (u?.dshUpdateAvailable === true) parts.push(t('about.dshUpdate', { version: u.dshLatest ?? '?' }));
  const updateText = update?.checking === true
    ? t('about.checking')
    : update?.error !== undefined && update?.error !== null
      ? update.error
      : u === null
        ? null
        : parts.length > 0
          ? parts.join('；')
          : t('about.latest');

  return jsxs('section', {
    className: 'dbb_about',
    'aria-label': t('about.title'),
    children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('about.title') }),
      jsx('p', { className: 'dbb_aboutIntro', children: t('about.intro') }),
      loadError !== null
        ? jsx('p', { className: 'dbb_error', children: `${t('about.offline')}（${loadError}）` })
        : null,
      jsxs('div', { className: 'dbb_aboutCard', children: [
        jsxs('div', { className: 'dbb_aboutHead', children: [
          jsx('span', { className: 'dbb_aboutLogo', children: jsx(primitives.FishLogo, { size: 22 }) }),
          jsxs('div', { className: 'dbb_aboutTitleWrap', children: [
            jsx('div', { className: 'dbb_aboutName', children: info?.appName ?? 'DSH Desktop' }),
            info?.appVersion != null
              ? jsx('div', { className: 'dbb_aboutVer', children: t('about.version', { version: `v${info.appVersion}` }) })
              : null,
          ] }),
        ] }),
        jsxs('div', { className: 'dbb_aboutRows', children: [
          jsxs('div', { className: 'dbb_row', children: [
            jsx('span', { className: 'dbb_rowLabel', children: t('about.author') }),
            jsx('span', { className: 'dbb_rowValue', children: info?.author ?? 'Anixuil' }),
          ] }),
          info?.dshVersion != null
            ? jsxs('div', { className: 'dbb_row', children: [
                jsx('span', { className: 'dbb_rowLabel', children: t('about.dshVersion') }),
                jsx('span', { className: 'dbb_rowValue', children: info.dshVersion }),
              ] })
            : null,
          jsxs('div', { className: 'dbb_row', children: [
            jsx('span', { className: 'dbb_rowLabel', children: t('about.blog') }),
            jsx('button', {
              type: 'button',
              className: 'dbb_aboutLink',
              onClick: () => onOpen(info?.blog ?? BLOG_URL),
              children: 'www.anixuil.top',
            }),
          ] }),
          jsxs('div', { className: 'dbb_row', children: [
            jsx('span', { className: 'dbb_rowLabel', children: t('about.repo') }),
            jsx('button', {
              type: 'button',
              className: 'dbb_aboutLink',
              onClick: () => onOpen(info?.repo ?? REPO_URL),
              children: 'github.com/Anixuil/dsh-desktop',
            }),
          ] }),
        ] }),
        jsx('p', { className: 'dbb_note', children: t('about.note') }),
        jsxs('div', { className: 'dbb_aboutActions', children: [
          jsx('button', {
            type: 'button',
            className: 'dbb_aboutPrimary',
            disabled: busy,
            onClick: onCheck,
            children: busy ? t('about.checking') : t('about.check'),
          }),
          jsx('button', {
            type: 'button',
            className: 'dbb_aboutSecondary',
            onClick: () => onOpen(info?.repo ?? REPO_URL),
            children: t('about.repoBtn'),
          }),
        ] }),
        u?.appUpdateAvailable === true && u?.appUrl
          ? jsx('button', {
              type: 'button',
              className: 'dbb_aboutLink dbb_aboutRelease',
              onClick: () => onOpen(u.appUrl),
              children: t('about.release'),
            })
          : null,
        updateText !== null
          ? jsx('p', {
              className: update?.error !== undefined && update?.error !== null ? 'dbb_error' : 'dbb_aboutStatus',
              children: updateText,
            })
          : null,
        notice?.kind === 'err'
          ? jsx('p', { className: 'dbb_error', children: notice.text })
          : null,
      ] }),
    ],
  });
}

/** Stateful wrapper: loads /desktop/about once, drives update checks and link opens. */
function AboutSection(props) {
  const { t } = props;
  const [info, setInfo] = react.useState(null);
  const [loadError, setLoadError] = react.useState(null);
  const [update, setUpdate] = react.useState(null);
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState(null);

  react.useEffect(() => {
    ensureStyles();
    let cancelled = false;
    getJson('/desktop/about')
      .then((payload) => {
        if (cancelled) return;
        setInfo(payload);
        setLoadError(null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  const openExternal = async (url) => {
    if (!url) return;
    setNotice(null);
    try {
      await getJson('/desktop/open-external', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
    } catch (e) {
      setNotice({ kind: 'err', text: String(e?.message ?? e) });
    }
  };

  const checkUpdate = async () => {
    if (busy) return;
    setBusy(true);
    setUpdate({ checking: true });
    try {
      const payload = await getJson('/desktop/update-status');
      setUpdate({ checking: false, status: payload });
    } catch (e) {
      setUpdate({ checking: false, error: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return jsx(AboutSectionView, {
    t,
    info,
    loadError,
    update,
    busy,
    notice,
    onOpen: openExternal,
    onCheck: checkUpdate,
  });
}

module.exports = { AboutSection, AboutSectionView };
