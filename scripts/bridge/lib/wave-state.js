// dsh-desktop-bridge — conversation-state classifier for the shell's wave UI.
//
// Subscribes to the dsh session event stream (`session/event`, bubbled to the
// plugin root context) and reduces token/tool/approval activity into one of
// the shell's ocean-wave states. Only state *changes* are POSTed to
// /turn-state (fire-and-forget); the ambient layer on the dsh page owns the
// crossfades, the settle→calm easing, and its own watchdog.
//
// States: calm | thinking | streaming | tooling | waiting | error | settle
//
//   turn/start            → thinking   (pre-step processing, model request)
//   assistant/chunk       → streaming  (tokens flowing)
//   tool/call|tool/result → tooling    (tool activity; result errors → error)
//   approval/asked        → waiting    (user must confirm)
//   command/done error    → error
//   turn/end              → settle     (ambient layer eases back to calm)
//
// State is tracked PER SESSION: `session/event` and `agent/status` both carry
// their session/agent id, so a background conversation's activity can no
// longer hijack the wave. Only the session currently focused in the UI is
// reported. "Currently focused" is client-side UI state (`sessions.list.current`),
// which the bridge's client module publishes here via POST /desktop/current-session;
// registerDesktopRoutes forwards it into setFocused().
//
// `agent/status` stays as a coarse per-session fallback: entering running
// before any session event arrives counts as thinking; dropping to idle while
// still in an active state emits settle (a missed turn/end can't strand the UI).

const STATE_POST = '/turn-state'
const SETTLE_DECAY_MS = 1900
const ERROR_DECAY_MS = 1800

/** Coerce a session/agent argument (object with `.id`, or a raw string) to an id. */
function idOf(value) {
  if (value !== null && typeof value === 'object') {
    return typeof value.id === 'string' ? value.id : null
  }
  return typeof value === 'string' && value !== '' ? value : null
}

export function registerWaveState(ctx, { shellPort }) {
  /** sessionId → effective wave state (terminal states decay back to calm). */
  const states = new Map()
  /** sessionIds that have produced at least one `session/event`. */
  const sawSessionEvents = new Set()
  /** sessionId → pending settle/error decay timeout. */
  const timers = new Map()
  /** The session currently focused in the UI (null = none known yet). */
  let focusedId = null
  /** What the shell was last told (global — the ambient layer is singular). */
  let posted = 'calm'

  const post = (state, detail) => {
    if (state === posted) return
    posted = state
    fetch(`http://127.0.0.1:${shellPort}${STATE_POST}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, detail: detail ?? '' }),
    }).catch(() => {})
  }

  const clearTimer = (id) => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  const decayToCalm = (id) => {
    timers.delete(id)
    if (states.get(id) !== 'calm') {
      states.set(id, 'calm')
      if (id === focusedId) post('calm', 'decay')
    }
  }

  const setState = (id, state, detail) => {
    clearTimer(id)
    if (states.get(id) === state) {
      // same effective state: nothing to reclassify, but if the shell fell
      // out of sync (focus moved away and back) re-affirm it.
      if (id === focusedId) post(state, detail)
      return
    }
    states.set(id, state)
    if (id === focusedId) post(state, detail)
    if (state === 'settle') {
      timers.set(id, setTimeout(() => decayToCalm(id), SETTLE_DECAY_MS))
    } else if (state === 'error') {
      timers.set(id, setTimeout(() => decayToCalm(id), ERROR_DECAY_MS))
    }
  }

  /**
   * Point the classifier at the session the user is looking at. Unknown or
   * empty ids mean "no focused session" and drop the wave back to calm.
   */
  const setFocused = (id) => {
    const next = typeof id === 'string' && id !== '' ? id : null
    if (next === focusedId) return
    focusedId = next
    post(next === null ? 'calm' : (states.get(next) ?? 'calm'), 'focus')
  }

  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (!type) return
    const id = idOf(session)
    if (id === null) return
    sawSessionEvents.add(id)
    switch (type) {
      case 'turn/start':
        setState(id, 'thinking', type)
        break
      case 'assistant/chunk':
        setState(id, 'streaming', type)
        break
      case 'tool/call':
        setState(id, 'tooling', type)
        break
      case 'tool/result': {
        if (event?.data?.error) setState(id, 'error', type)
        else setState(id, 'tooling', type)
        break
      }
      case 'approval/asked':
        setState(id, 'waiting', type)
        break
      case 'approval/decided':
        setState(id, 'thinking', type)
        break
      case 'command/done': {
        if (event?.data?.kind === 'error') setState(id, 'error', type)
        else setState(id, 'thinking', type)
        break
      }
      case 'turn/end':
        setState(id, 'settle', type)
        break
      default:
        break
    }
  })

  // Coarse per-session fallback: lifecycle transitions only matter when the
  // fine-grained stream is unavailable or a turn ended without a session event.
  ctx.on('agent/status', (payload) => {
    const id = idOf(payload?.agent)
    if (id === null) return
    const status = payload?.status
    if (status === 'running') {
      if (!sawSessionEvents.has(id)) setState(id, 'thinking', 'agent/status running')
      return
    }
    // idle: the turn ended — settle unless we already did via turn/end.
    const active = states.get(id)
    if (active !== undefined && active !== 'calm' && active !== 'settle') {
      setState(id, 'settle', 'agent/status idle')
    }
  })

  // Release bookkeeping for disposed sessions so a deleted/closed session
  // can't leave a stale state or fire a late decay into a reused id.
  ctx.on('session/disposed', (session) => {
    const id = idOf(session)
    if (id === null) return
    clearTimer(id)
    states.delete(id)
    sawSessionEvents.delete(id)
    if (id === focusedId) {
      focusedId = null
      post('calm', 'focused session disposed')
    }
  })

  return { setFocused }
}