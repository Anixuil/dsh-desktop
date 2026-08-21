// Configurable web-search priority provider for DSH Desktop.
// Route order: custom search API -> current model native search -> DeepSeek.
import { PrioritySearchProvider } from './lib/provider.js'
import {
  Config,
  SEARCH_SETTINGS_NAMESPACE,
  resolveBaseConfig,
  validateConfig,
} from './lib/config.js'
import { registerSearchRoutes } from './lib/routes.js'

export const name = 'dsh-desktop-web-search'
export const inject = ['web']

export function apply(ctx, rowConfig = {}) {
  const entry = resolveBaseConfig(rowConfig)
  validateConfig(entry)
  let source = () => entry
  let handle = null

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SEARCH_SETTINGS_NAMESPACE, Config, {
      base: entry,
      applies: 'live',
      validate: validateConfig,
    })
    source = () => scope.get()
    handle = { service: sctx.settings, scope }
    sctx.effect(() => () => {
      source = () => entry
      handle = null
    }, 'dsh-desktop-web-search: settings scope')
  })

  const provider = new PrioritySearchProvider(ctx, () => source())
  ctx.web.registerSearchProvider(provider)
  registerSearchRoutes(ctx, SEARCH_SETTINGS_NAMESPACE, () => handle, () => source())
}

export { PrioritySearchProvider } from './lib/provider.js'
export { Config, SEARCH_PROVIDER_ID, SEARCH_SETTINGS_NAMESPACE } from './lib/config.js'
