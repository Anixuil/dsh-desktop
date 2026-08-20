// dsh-desktop-change-history — built-in side file viewer (read-only).
//
// A shared module store + a `shell.overlay` entry. The inline mutation row's
// 查看 action calls `openFileViewer(path, openFile)`, and this overlay renders
// a right-side drawer with the file's current content (line numbers, copy, and
// an open-with-system fallback). Read-only today. The store keeps the full
// content, an explicit `mode` field, and a flat open/close contract so an
// edit+save surface can be added later without reshaping the viewer: swap the
// read body for an editor, drive it with the same content, and wire a host
// save route (a `saveFileContent` api next to `readFile`).
const { createElement: el, useEffect, useState, useSyncExternalStore } = require('react')
const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
const api = require('./api.js')
const { ensureStyles } = require('./styles.js')
const { showMessage } = require('./message.js')

// ——— shared store (module singleton, one per bundle) ———
let state = {
  open: false,
  path: null,
  mode: 'read', // future: 'edit'
  loading: false,
  error: null,
  content: null,
  bytes: 0,
  totalLines: null,
  lang: null,
  truncated: false,
  openExternal: null,
}
const listeners = new Set()
const notify = () => { for (const fn of listeners) fn() }
const getSnapshot = () => state
const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }

let readToken = 0

/** Open the viewer for `path`; `openFile` keeps the system-open fallback. */
function openFileViewer(path, openFile) {
  readToken += 1
  const token = readToken
  state = {
    ...state,
    open: true,
    path,
    mode: 'read',
    loading: true,
    error: null,
    content: null,
    bytes: 0,
    totalLines: null,
    lang: null,
    truncated: false,
    openExternal: typeof openFile === 'function' ? openFile : null,
  }
  notify()
  api.readFile(path).then(
    (res) => {
      if (token !== readToken) return
      state = {
        ...state,
        loading: false,
        content: res.content ?? '',
        bytes: res.bytes ?? 0,
        totalLines: typeof res.totalLines === 'number' ? res.totalLines : null,
        lang: res.lang ?? null,
        truncated: res.truncated === true,
      }
      notify()
    },
    (err) => {
      if (token !== readToken) return
      state = { ...state, loading: false, error: err }
      notify()
    },
  )
}

function closeFileViewer() {
  readToken += 1
  state = { ...state, open: false, path: null, content: null, error: null, openExternal: null }
  notify()
}

function useFileViewer() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Read-only line-numbered body: gutter + text per line. */
function CodeView({ content, totalLines, truncated }) {
  if (truncated) {
    return el('pre', { className: 'chx_viewerLines' }, content)
  }
  const lines = String(content).split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return el(
    'div',
    { className: 'chx_viewerLines' },
    lines.map((text, i) =>
      el(
        'div',
        { key: i, className: 'chx_viewerLine' },
        el('span', { className: 'chx_viewerGutter' }, String(i + 1)),
        el('span', { className: 'chx_viewerText' }, text),
      ),
    ),
  )
}

/** The drawer itself, rendered as a `shell.overlay` entry (root scope). */
function FileViewerOverlay({ t }) {
  const snap = useFileViewer()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ensureStyles()
  }, [])

  useEffect(() => {
    if (!snap.open) return
    const onKeyDown = (e) => { if (e.key === 'Escape') closeFileViewer() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [snap.open])

  useEffect(() => {
    if (snap.error !== null) showMessage(t('viewer.error', { error: String(snap.error?.message ?? snap.error) }))
  }, [snap.error, t])

  if (!snap.open) return null

  const copy = async () => {
    if (snap.content === null) return
    const ok = await primitives.writeClipboard(snap.content)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const openExternal = () => {
    if (typeof snap.openExternal === 'function' && typeof snap.path === 'string') snap.openExternal(snap.path)
  }

  const metaBits = []
  if (typeof snap.bytes === 'number' && snap.bytes > 0) {
    metaBits.push(snap.bytes >= 1024 * 1024 ? `${(snap.bytes / 1024 / 1024).toFixed(1)} MB` : `${(snap.bytes / 1024).toFixed(1)} KB`)
  }
  if (typeof snap.totalLines === 'number') metaBits.push(t('viewer.lines', { count: snap.totalLines }))
  if (typeof snap.lang === 'string' && snap.lang !== '') metaBits.push(snap.lang)

  return el(
    'div',
    { className: 'chx_viewerBackdrop', onClick: closeFileViewer },
    el(
      'div',
      { className: 'chx_viewerPanel', role: 'dialog', 'aria-label': t('viewer.title'), onClick: (e) => e.stopPropagation() },
      el(
        'header',
        { className: 'chx_viewerHeader' },
        el(
          'div',
          { className: 'chx_viewerTitle' },
          el('span', { className: 'chx_viewerTitleIcon' }, el(primitives.IconCodeOutline16, { size: 16 })),
          el('span', { className: 'chx_viewerPath', title: snap.path ?? '' }, snap.path ?? ''),
        ),
        el(
          'div',
          { className: 'chx_viewerActions' },
          el(
            'button',
            { type: 'button', className: 'chx_viewerIconBtn', title: t('viewer.copy'), 'aria-label': t('viewer.copy'), onClick: copy, disabled: snap.content === null },
            copied ? el(primitives.IconCheckOutline16, { size: 14 }) : el(primitives.IconCopyOutline16, { size: 14 }),
          ),
          snap.openExternal !== null
            ? el(
                'button',
                { type: 'button', className: 'chx_viewerIconBtn', title: t('viewer.openExternal'), 'aria-label': t('viewer.openExternal'), onClick: openExternal },
                el(primitives.IconRightUpOutline16, { size: 14 }),
              )
            : null,
          el(
            'button',
            { type: 'button', className: 'chx_viewerIconBtn', title: t('viewer.close'), 'aria-label': t('viewer.close'), onClick: closeFileViewer },
            el(primitives.IconCloseOutline16, { size: 14 }),
          ),
        ),
      ),
      snap.truncated ? el('div', { className: 'chx_viewerNotice' }, t('viewer.truncated')) : null,
      el(
        'div',
        { className: 'chx_viewerBody' },
        snap.loading
          ? el('div', { className: 'chx_viewerLoading' }, t('viewer.loading'))
          : snap.error !== null
            ? null
            : el(CodeView, { content: snap.content, totalLines: snap.totalLines, truncated: snap.truncated }),
      ),
      el('footer', { className: 'chx_viewerFooter' }, metaBits.map((bit, i) => el('span', { key: i, className: 'chx_viewerMeta' }, bit))),
    ),
  )
}

module.exports = { FileViewerOverlay, CodeView, useFileViewer, openFileViewer, closeFileViewer }
