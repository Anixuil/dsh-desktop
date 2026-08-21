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
const { createElement: el, useEffect, useRef, useState, useSyncExternalStore } = require('react')
const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
const api = require('./api.js')
const { ensureStyles } = require('./styles.js')
const { showMessage } = require('./message.js')

const VIEWER_WIDTH_KEY = 'dsh-desktop-change-history:viewer-width'
const DEFAULT_VIEWER_WIDTH = 560
const MIN_VIEWER_WIDTH = 360
const VIEWPORT_GUTTER = 48
const VIEWER_EXIT_MS = 240

function viewerWidthBounds() {
  const viewportWidth = typeof window === 'undefined' ? DEFAULT_VIEWER_WIDTH + VIEWPORT_GUTTER : window.innerWidth
  const max = Math.max(280, viewportWidth - VIEWPORT_GUTTER)
  return { min: Math.min(MIN_VIEWER_WIDTH, max), max }
}

function clampViewerWidth(width) {
  const { min, max } = viewerWidthBounds()
  const numeric = Number(width)
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : DEFAULT_VIEWER_WIDTH))
}

function storedViewerWidth() {
  try {
    const stored = window.localStorage?.getItem(VIEWER_WIDTH_KEY)
    return stored === null || stored === undefined ? clampViewerWidth(DEFAULT_VIEWER_WIDTH) : clampViewerWidth(stored)
  } catch {
    return clampViewerWidth(DEFAULT_VIEWER_WIDTH)
  }
}

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
  snapshot: false,
  openExternal: null,
}
const listeners = new Set()
const notify = () => { for (const fn of listeners) fn() }
const getSnapshot = () => state
const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }

let readToken = 0

/** Open the viewer for `path`; `openFile` keeps the system-open fallback. */
function openFileViewer(path, openFile, changeId) {
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
    snapshot: false,
    openExternal: typeof openFile === 'function' ? openFile : null,
  }
  notify()
  api.readFile(path, changeId).then(
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
        snapshot: res.snapshot === true,
        // A removed file cannot be opened by the operating system; omit the
        // external-open action while its recorded snapshot is on screen.
        openExternal: res.snapshot === true ? null : state.openExternal,
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
  // Keep the current content mounted until the drawer's exit transition ends.
  // A new open interrupts this state immediately and reuses the same surface.
  state = { ...state, open: false, loading: false }
  notify()
}

function finalizeClosedFileViewer() {
  if (state.open) return
  state = { ...state, path: null, content: null, bytes: 0, totalLines: null, lang: null, truncated: false, snapshot: false, error: null, openExternal: null }
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
  const [rendered, setRendered] = useState(snap.open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef(null)
  const resizeHandleRef = useRef(null)
  const dragRef = useRef(null)

  useEffect(() => {
    ensureStyles()
  }, [])

  useEffect(() => {
    if (snap.open) {
      setRendered(true)
      setClosing(false)
      return
    }
    if (!rendered) return

    if (panelRef.current?.contains(document.activeElement)) document.activeElement.blur()
    setClosing(true)
    const timer = window.setTimeout(() => {
      setRendered(false)
      setClosing(false)
      finalizeClosedFileViewer()
    }, VIEWER_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [snap.open, rendered])

  useEffect(() => {
    if (!snap.open) return
    const onKeyDown = (e) => { if (e.key === 'Escape') closeFileViewer() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [snap.open])

  useEffect(() => {
    if (!snap.open) return

    const resizeTo = (width, persist = false) => {
      const next = Math.round(clampViewerWidth(width))
      if (panelRef.current !== null) panelRef.current.style.width = `${next}px`
      if (resizeHandleRef.current !== null) {
        const { min, max } = viewerWidthBounds()
        resizeHandleRef.current.setAttribute('aria-valuemin', String(Math.round(min)))
        resizeHandleRef.current.setAttribute('aria-valuemax', String(Math.round(max)))
        resizeHandleRef.current.setAttribute('aria-valuenow', String(next))
      }
      if (persist) {
        try { window.localStorage?.setItem(VIEWER_WIDTH_KEY, String(next)) } catch {}
      }
      return next
    }

    resizeTo(storedViewerWidth())
    const onViewportResize = () => resizeTo(panelRef.current?.getBoundingClientRect().width ?? DEFAULT_VIEWER_WIDTH, true)
    window.addEventListener('resize', onViewportResize)
    return () => {
      window.removeEventListener('resize', onViewportResize)
      dragRef.current = null
      document.documentElement.classList.remove('chx_viewerResizing')
    }
  }, [snap.open])

  useEffect(() => {
    if (snap.error !== null) showMessage(t('viewer.error', { error: String(snap.error?.message ?? snap.error) }))
  }, [snap.error, t])

  if (!rendered) return null

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

  const resizeTo = (width, persist = false) => {
    const next = Math.round(clampViewerWidth(width))
    if (panelRef.current !== null) panelRef.current.style.width = `${next}px`
    if (resizeHandleRef.current !== null) resizeHandleRef.current.setAttribute('aria-valuenow', String(next))
    if (persist) {
      try { window.localStorage?.setItem(VIEWER_WIDTH_KEY, String(next)) } catch {}
    }
    return next
  }

  const startResize = (event) => {
    if (event.button !== 0 || panelRef.current === null) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelRef.current.getBoundingClientRect().width,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    panelRef.current.classList.add('is-resizing')
    document.documentElement.classList.add('chx_viewerResizing')
  }

  const moveResize = (event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    resizeTo(drag.startWidth + drag.startX - event.clientX)
  }

  const finishResize = (event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    panelRef.current?.classList.remove('is-resizing')
    document.documentElement.classList.remove('chx_viewerResizing')
    resizeTo(panelRef.current?.getBoundingClientRect().width ?? DEFAULT_VIEWER_WIDTH, true)
  }

  const resizeWithKeyboard = (event) => {
    if (panelRef.current === null) return
    const { min, max } = viewerWidthBounds()
    const current = panelRef.current.getBoundingClientRect().width
    const step = event.shiftKey ? 64 : 16
    const next = event.key === 'ArrowLeft'
      ? current + step
      : event.key === 'ArrowRight'
        ? current - step
        : event.key === 'Home'
          ? min
          : event.key === 'End'
            ? max
            : null
    if (next === null) return
    event.preventDefault()
    resizeTo(next, true)
  }

  const metaBits = []
  if (typeof snap.bytes === 'number' && snap.bytes > 0) {
    metaBits.push(snap.bytes >= 1024 * 1024 ? `${(snap.bytes / 1024 / 1024).toFixed(1)} MB` : `${(snap.bytes / 1024).toFixed(1)} KB`)
  }
  if (typeof snap.totalLines === 'number') metaBits.push(t('viewer.lines', { count: snap.totalLines }))
  if (typeof snap.lang === 'string' && snap.lang !== '') metaBits.push(snap.lang)

  return el(
    'div',
    {
      className: `chx_viewerBackdrop${closing ? ' is-closing' : ''}`,
      'data-state': closing ? 'closing' : 'open',
      'aria-hidden': closing || undefined,
      onClick: closing ? undefined : closeFileViewer,
    },
    el(
      'div',
      { ref: panelRef, className: 'chx_viewerPanel', role: 'dialog', 'aria-label': t('viewer.title'), onClick: (e) => e.stopPropagation() },
      el('div', {
        ref: resizeHandleRef,
        className: 'chx_viewerResizeHandle',
        role: 'separator',
        tabIndex: 0,
        'aria-label': t('viewer.resize'),
        'aria-orientation': 'vertical',
        'aria-valuemin': MIN_VIEWER_WIDTH,
        'aria-valuemax': DEFAULT_VIEWER_WIDTH,
        'aria-valuenow': DEFAULT_VIEWER_WIDTH,
        onPointerDown: startResize,
        onPointerMove: moveResize,
        onPointerUp: finishResize,
        onPointerCancel: finishResize,
        onDoubleClick: () => resizeTo(DEFAULT_VIEWER_WIDTH, true),
        onKeyDown: resizeWithKeyboard,
      }),
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
      snap.snapshot ? el('div', { className: 'chx_viewerNotice' }, t('viewer.snapshot')) : null,
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
