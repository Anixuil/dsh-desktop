// dsh-desktop-bridge — Cordis host plugin mounted into the dsh web profile by
// DSH Desktop. It is the shell's window into DSH:
//   * tracks per-session task completion and POSTs /turn-end to the shell
//   * serves POST /set-key | /unset-key so the shell can write the DeepSeek key
//     through the official credentials service
//   * serves same-origin GET /desktop/balance | /desktop/refresh (proxied to the
//     shell) and GET /desktop/usage (token-consumption analytics aggregated
//     from the DSH session projection cache + session logs)
//
// Implementation lives in the modules under lib/: zstd frame scan, session
// model attribution, usage aggregation, the credentials listener, the
// /desktop routes, the turn notifier, and the wave-state classifier. This
// entry only wires them into the cordis context.
import { startCredentialsServer } from './lib/credentials.js'
import { registerDesktopRoutes } from './lib/desktop-routes.js'
import { registerTurnNotifier } from './lib/turn-notifier.js'
import { registerWaveState } from './lib/wave-state.js'
import { registerModelBehavior } from './lib/model-behavior.js'

export const name = 'dsh-desktop-bridge'
export const inject = ['webServer']
export { scanFrames } from './lib/zstd.js'
export { usageReport } from './lib/usage.js'

export function apply(ctx, config) {
  const port = Number(config?.port ?? 38658)
  const shellPort = Number(config?.shellPort ?? 38657)

  // legacy bridge endpoint (the shell's settings window writes keys here)
  const credentials = startCredentialsServer({
    port,
    getCredentials: () => ctx.get('credentials'),
  })

  // conversation-state classifier → shell /turn-state (drives the wave UI).
  // Its setFocused() is wired into /desktop/current-session so the classifier
  // reports only the conversation currently focused in the UI.
  const wave = registerWaveState(ctx, { shellPort })
  const turnNotifier = registerTurnNotifier(ctx, { shellPort })
  const modelBehavior = registerModelBehavior(ctx)

  // Same-origin /desktop routes publish the focused session to both consumers:
  // ambient motion follows it, while completion notifications use it to avoid
  // interrupting a task the user is already viewing.
  registerDesktopRoutes(ctx, {
    shellPort,
    getRunning: turnNotifier.isRunning,
    modelBehavior,
    onFocus: (id) => {
      wave.setFocused(id)
      turnNotifier.setFocused(id)
    },
  })

  ctx.on('dispose', () => {
    credentials.close()
  })
}
