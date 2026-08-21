const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { buildTurnEntries } = require('./model.js')
const { ensureStyles } = require('./styles.js')

const EMPTY_SNAPSHOT = Object.freeze({
  chat: { order: [], nodes: { get: () => undefined } },
  hasMore: false,
  loadingOlder: false,
  running: false,
})
const EMPTY_STORE = Object.freeze({
  getSnapshot: () => EMPTY_SNAPSHOT,
  subscribe: () => () => {},
})

function findAnchor(key) {
  if (typeof document === 'undefined') return null
  for (const node of document.querySelectorAll('[data-chat-anchor-key]')) {
    if (node.dataset.chatAnchorKey === key) return node
  }
  return null
}

function computeLayout(rects) {
  if (!rects?.overlay || !rects.sidebar || !rects.flow || !rects.scroll) return null
  const top = rects.scroll.top + 14
  const visibleBottom = Math.min(rects.scroll.bottom, rects.composer?.top ?? rects.scroll.bottom) - 14
  const height = Math.floor(visibleBottom - top)
  if (height < 72) return null
  const sidebarLeft = rects.sidebar.right + 12
  const contentSafeLeft = rects.flow.left - 34
  const left = Math.max(rects.scroll.left + 4, Math.min(sidebarLeft, contentSafeLeft))
  return {
    left: Math.round(left - rects.overlay.left),
    top: Math.round(top - rects.overlay.top),
    height,
  }
}

function copyFor(t) {
  return {
    imageMessage: t('imageMessage'),
    turnFallback: (turn) => t('turnFallback', { turn }),
    generating: t('generating'),
    noReply: t('noReply'),
  }
}

function ConversationNavigator({ sessions, t }) {
  const listSnapshot = react.useSyncExternalStore(
    react.useCallback((notify) => sessions?.list?.subscribe?.(notify) ?? (() => {}), [sessions]),
    react.useCallback(() => sessions?.list?.getSnapshot?.() ?? { current: null }, [sessions]),
  )
  const sessionId = listSnapshot?.current ?? null
  const session = sessionId === null ? null : sessions?.binding?.(sessionId)?.session ?? null
  const store = session ?? EMPTY_STORE
  const snapshot = react.useSyncExternalStore(
    react.useCallback((notify) => store.subscribe(notify), [store]),
    react.useCallback(() => store.getSnapshot(), [store]),
  )
  const entries = react.useMemo(() => buildTurnEntries(snapshot, copyFor(t)), [snapshot, t])
  const [layout, setLayout] = react.useState(null)
  const [activeTurn, setActiveTurn] = react.useState(null)
  const [previewTurn, setPreviewTurn] = react.useState(null)
  const [previewTop, setPreviewTop] = react.useState(0)
  const rootRef = react.useRef(null)
  const scrollerRef = react.useRef(null)
  const previewRef = react.useRef(null)
  const buttonRefs = react.useRef(new Map())

  react.useEffect(() => {
    ensureStyles()
  }, [])

  react.useLayoutEffect(() => {
    if (entries.length < 2 || typeof document === 'undefined') {
      setLayout(null)
      return undefined
    }
    const overlay = document.querySelector('[data-shell-overlay]')
    const scroll = document.querySelector('[data-conversation-scroll]')
    const sidebar = overlay?.parentElement?.firstElementChild ?? null
    if (!(overlay instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      setLayout(null)
      return undefined
    }
    const observed = new Set([overlay, sidebar, scroll])
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    const observe = (element) => {
      if (!(element instanceof HTMLElement) || observed.has(element)) return
      observed.add(element)
      resizeObserver?.observe(element)
    }
    const measure = () => {
      const flow = scroll.querySelector('[data-chat-flow]')
      const composer = scroll.querySelector('[data-composer-seat]')
      if (!(flow instanceof HTMLElement)) {
        setLayout(null)
        return
      }
      observe(flow)
      observe(composer)
      setLayout(computeLayout({
        overlay: overlay.getBoundingClientRect(),
        sidebar: sidebar.getBoundingClientRect(),
        flow: flow.getBoundingClientRect(),
        scroll: scroll.getBoundingClientRect(),
        composer: composer instanceof HTMLElement ? composer.getBoundingClientRect() : null,
      }))
    }
    resizeObserver?.observe(overlay)
    resizeObserver?.observe(sidebar)
    resizeObserver?.observe(scroll)
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
    mutationObserver?.observe(scroll, { childList: true, subtree: true })
    measure()
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [sessionId, entries.length])

  react.useEffect(() => {
    if (layout === null || entries.length < 2 || typeof document === 'undefined') return undefined
    const scroll = document.querySelector('[data-conversation-scroll]')
    if (!(scroll instanceof HTMLElement)) return undefined
    const anchored = entries
      .map((entry) => ({ entry, element: findAnchor(entry.anchorKey) }))
      .filter((item) => item.element instanceof HTMLElement)
    if (anchored.length === 0) return undefined

    const activationLine = scroll.getBoundingClientRect().top + scroll.clientHeight * .28
    let initial = anchored[0]
    for (const item of anchored) {
      if (item.element.getBoundingClientRect().top <= activationLine) initial = item
      else break
    }
    setActiveTurn(initial.entry.turn)

    if (typeof IntersectionObserver === 'undefined') return undefined
    const visible = new Map()
    const turns = new Map(anchored.map(({ entry, element }) => [element, entry.turn]))
    const observer = new IntersectionObserver((changes) => {
      for (const change of changes) {
        const turn = turns.get(change.target)
        if (!Number.isFinite(turn)) continue
        if (change.isIntersecting) visible.set(turn, change.boundingClientRect.top)
        else visible.delete(turn)
      }
      if (visible.size === 0) return
      const next = [...visible].sort((left, right) => left[1] - right[1])[0]?.[0]
      if (Number.isFinite(next)) setActiveTurn(next)
    }, { root: scroll, rootMargin: '0px 0px -68% 0px', threshold: 0 })
    for (const { entry, element } of anchored) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [sessionId, entries, layout])

  react.useEffect(() => {
    if (activeTurn === null) return
    buttonRefs.current.get(activeTurn)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeTurn])

  react.useLayoutEffect(() => {
    if (previewTurn === null || layout === null) return
    const button = buttonRefs.current.get(previewTurn)
    const scroller = scrollerRef.current
    const preview = previewRef.current
    if (!(button instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !(preview instanceof HTMLElement)) return
    const desired = button.offsetTop - scroller.scrollTop - 6
    setPreviewTop(Math.max(0, Math.min(desired, layout.height - preview.offsetHeight)))
  }, [previewTurn, layout])

  const jumpTo = react.useCallback((entry) => {
    const target = findAnchor(entry.anchorKey)
    const scroll = typeof document === 'undefined' ? null : document.querySelector('[data-conversation-scroll]')
    if (!(target instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return
    const top = scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    scroll.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' })
    setActiveTurn(entry.turn)
  }, [])

  const focusRelative = react.useCallback((entry, delta) => {
    const index = entries.findIndex((candidate) => candidate.turn === entry.turn)
    const next = entries[Math.max(0, Math.min(entries.length - 1, index + delta))]
    if (next) buttonRefs.current.get(next.turn)?.focus()
  }, [entries])

  if (layout === null || entries.length < 2) return null
  const preview = entries.find((entry) => entry.turn === previewTurn) ?? null
  const previewId = preview === null ? undefined : `dcn-preview-${sessionId}-${preview.turn}`
  const previewMaxWidth = typeof window === 'undefined'
    ? 320
    : Math.max(160, Math.min(320, window.innerWidth - layout.left - 70))
  return jsxs('nav', {
    ref: rootRef,
    className: 'dcn_root',
    style: { left: layout.left, top: layout.top, height: layout.height },
    'aria-label': t('navLabel'),
    children: [
      jsx('div', { ref: scrollerRef, className: 'dcn_scroller', children: jsxs('ol', { className: 'dcn_list', children: [
        snapshot.hasMore ? jsx('li', { className: 'dcn_item', children: jsx('button', {
          type: 'button',
          className: 'dcn_tick dcn_load',
          disabled: snapshot.loadingOlder,
          'aria-label': t(snapshot.loadingOlder ? 'loadingOlder' : 'loadOlder'),
          onClick: () => session?.loadOlder?.(),
          children: jsx('span', { className: 'dcn_tickLine', 'aria-hidden': 'true' }),
        }) }, 'load-older') : null,
        ...entries.map((entry) => jsx('li', { className: 'dcn_item', children: jsx('button', {
          ref: (node) => {
            if (node === null) buttonRefs.current.delete(entry.turn)
            else buttonRefs.current.set(entry.turn, node)
          },
          type: 'button',
          className: 'dcn_tick',
          tabIndex: activeTurn === entry.turn ? 0 : -1,
          'aria-current': activeTurn === entry.turn ? 'location' : undefined,
          'aria-describedby': previewTurn === entry.turn ? previewId : undefined,
          'aria-label': t('turnLabel', { turn: entry.turn, title: entry.title }),
          onClick: () => jumpTo(entry),
          onMouseEnter: () => setPreviewTurn(entry.turn),
          onMouseLeave: () => setPreviewTurn((current) => current === entry.turn ? null : current),
          onFocus: () => setPreviewTurn(entry.turn),
          onBlur: () => setPreviewTurn((current) => current === entry.turn ? null : current),
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); focusRelative(entry, 1) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); focusRelative(entry, -1) }
            else if (event.key === 'Home') { event.preventDefault(); buttonRefs.current.get(entries[0].turn)?.focus() }
            else if (event.key === 'End') { event.preventDefault(); buttonRefs.current.get(entries.at(-1).turn)?.focus() }
          },
          children: jsx('span', { className: 'dcn_tickLine', 'aria-hidden': 'true' }),
        }) }, entry.turn)),
      ] }) }),
      preview ? jsxs('div', { id: previewId, ref: previewRef, className: 'dcn_preview', style: { top: previewTop, maxWidth: previewMaxWidth }, role: 'tooltip', children: [
        jsx('div', { className: 'dcn_previewTitle', children: preview.title }),
        jsx('div', { className: 'dcn_previewSummary', children: preview.summary }),
      ] }) : null,
    ],
  })
}

module.exports = {
  ConversationNavigator,
  computeLayout,
  findAnchor,
  EMPTY_SNAPSHOT,
}
