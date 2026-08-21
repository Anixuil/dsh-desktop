import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const SEARCH_PROVIDER_ID = 'desktop-priority'
export const SEARCH_SETTINGS_NAMESPACE = settingsNamespace('desktop-web-search')
export const CUSTOM_KEY_REF = 'DSH_WEB_SEARCH_API_KEY'

export const CUSTOM_PROVIDERS = new Set([
  'none',
  'exa',
  'tavily',
  'brave',
  'perplexity',
  'generic',
])

export const Config = z.object({
  customProvider: z.string().default('none'),
  customBaseURL: z.string().default(''),
  customApiKeyEnv: z.string().default(CUSTOM_KEY_REF),
  nativeEnabled: z.boolean().default(true),
  deepseekFallback: z.boolean().default(true),
  sourceTimeoutMs: z.number().step(1).min(1000).default(15000),
})

export function resolveBaseConfig(config = {}) {
  return {
    customProvider: config.customProvider ?? 'none',
    customBaseURL: config.customBaseURL ?? '',
    customApiKeyEnv: config.customApiKeyEnv ?? CUSTOM_KEY_REF,
    nativeEnabled: config.nativeEnabled ?? true,
    deepseekFallback: config.deepseekFallback ?? true,
    sourceTimeoutMs: config.sourceTimeoutMs ?? 15000,
  }
}

export function validateConfig(config) {
  if (!CUSTOM_PROVIDERS.has(config.customProvider)) {
    throw new Error(`unsupported custom search provider "${config.customProvider}"`)
  }
  const baseURL = config.customBaseURL?.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.customApiKeyEnv)) {
    throw new Error('custom search credential name must be a POSIX environment variable name')
  }
  if (config.customProvider === 'generic' && !baseURL) {
    throw new Error('generic JSON search requires a Base URL')
  }
  if (baseURL && !isHttpUrl(baseURL)) {
    throw new Error('custom search Base URL must be an absolute HTTP(S) URL')
  }
  if (!Number.isInteger(config.sourceTimeoutMs) || config.sourceTimeoutMs < 1000) {
    throw new Error('sourceTimeoutMs must be an integer greater than or equal to 1000')
  }
  if (config.customProvider === 'none' && !config.nativeEnabled && !config.deepseekFallback) {
    throw new Error('at least one web-search source must remain enabled')
  }
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
