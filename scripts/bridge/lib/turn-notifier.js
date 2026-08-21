// dsh-desktop-bridge - per-session task-completion notifications.
//
// Fine-grained session events are authoritative. agent/status remains a
// fallback for runtimes that miss turn/start or turn/end, but both paths share
// the same armed turn so a single task can never notify twice.

const TURN_END_PATH = '/turn-end'
const TITLE_LIMIT = 80

function idOf(value) {
  if (value !== null && typeof value === 'object') {
    return typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : null
  }
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function snapshotValue(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return null
  try {
    const snapshot = typeof value.getSnapshot === 'function' ? value.getSnapshot() : value
    if (typeof snapshot === 'string') return snapshot
    for (const key of ['current', 'value', 'val', 'title', 'name', 'label']) {
      if (typeof snapshot?.[key] === 'string') return snapshot[key]
    }
  } catch {
    return null
  }
  return null
}

export function normalizeTurnTitle(session, event) {
  const candidates = [
    event?.data?.title,
    session?.title,
    session?.name,
    session?.label,
  ]
  for (const candidate of candidates) {
    const value = snapshotValue(candidate)?.trim()
    if (value) return Array.from(value).slice(0, TITLE_LIMIT).join('')
  }
  return null
}

export function registerTurnNotifier(ctx, { shellPort, post } = {}) {
  const turns = new Map()
  let focusedId = null

  const send = post ?? ((payload) => fetch(`http://127.0.0.1:${shellPort}${TURN_END_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {}))

  const stateFor = (id) => {
    let state = turns.get(id)
    if (state === undefined) {
      state = { sequence: 0, active: false, notified: false, title: null }
      turns.set(id, state)
    }
    return state
  }

  const arm = (id, title) => {
    const state = stateFor(id)
    if (!state.active) {
      state.sequence += 1
      state.active = true
      state.notified = false
    }
    if (title) state.title = title
    return state
  }

  const finish = (id, title) => {
    const state = stateFor(id)
    // A fallback idle may arrive before the fine-grained turn/end. Once a turn
    // is sealed, that late terminal signal belongs to the same turn and must
    // not arm a new sequence. A real next turn is opened by running/start.
    if (!state.active && state.notified) return
    if (!state.active) arm(id, title)
    else if (title) state.title = title
    if (state.notified) return
    state.notified = true
    state.active = false
    const payload = {
      sessionId: id,
      title: state.title,
      turnKey: `${id}:${String(state.sequence)}`,
      isFocusedSession: id === focusedId,
      completedAt: new Date().toISOString(),
    }
    Promise.resolve(send(payload)).catch(() => {})
  }

  ctx.on('session/event', (session, event) => {
    const id = idOf(session)
    if (id === null) return
    const title = normalizeTurnTitle(session, event)
    if (event?.type === 'turn/start') arm(id, title)
    if (event?.type === 'turn/end') finish(id, title)
  })

  ctx.on('agent/status', (payload) => {
    const id = idOf(payload?.agent)
    if (id === null) return
    const title = normalizeTurnTitle(payload.agent, payload)
    if (payload?.status === 'running') arm(id, title)
    if (payload?.status === 'idle' && stateFor(id).active) finish(id, title)
  })

  ctx.on('session/disposed', (session) => {
    const id = idOf(session)
    if (id === null) return
    turns.delete(id)
    if (focusedId === id) focusedId = null
  })

  return {
    setFocused(id) {
      focusedId = idOf(id)
    },
    isRunning() {
      for (const state of turns.values()) {
        if (state.active) return true
      }
      return false
    },
  }
}
