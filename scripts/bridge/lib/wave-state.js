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
// `agent/status` stays as a coarse fallback: entering running before any
// session event arrives counts as thinking; dropping to idle while still in
// an active state emits settle (a missed turn/end can't strand the UI).

const STATE_POST = '/turn-state'

export function registerWaveState(ctx, { shellPort }) {
  let state = 'calm'
  let sawSessionEvent = false

  const post = (next, detail) => {
    if (next === state) return
    state = next
    fetch(`http://127.0.0.1:${shellPort}${STATE_POST}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: next, detail: detail ?? '' }),
    }).catch(() => {})
  }

  ctx.on('session/event', (_session, event) => {
    const type = event?.type
    if (!type) return
    sawSessionEvent = true
    switch (type) {
      case 'turn/start':
        post('thinking', type)
        break
      case 'assistant/chunk':
        post('streaming', type)
        break
      case 'tool/call':
        post('tooling', type)
        break
      case 'tool/result': {
        if (event?.data?.error) post('error', type)
        else post('tooling', type)
        break
      }
      case 'approval/asked':
        post('waiting', type)
        break
      case 'approval/decided':
        post('thinking', type)
        break
      case 'command/done': {
        if (event?.data?.kind === 'error') post('error', type)
        else post('thinking', type)
        break
      }
      case 'turn/end':
        post('settle', type)
        break
      default:
        break
    }
  })

  // Coarse fallback: lifecycle transitions only matter when the fine-grained
  // stream is unavailable or a turn ended without a session event.
  ctx.on('agent/status', ({ status }) => {
    if (status === 'running') {
      if (!sawSessionEvent) post('thinking', 'agent/status running')
      return
    }
    // idle: the turn ended — settle unless we already did via turn/end.
    if (state !== 'calm' && state !== 'settle') post('settle', 'agent/status idle')
  })
}
