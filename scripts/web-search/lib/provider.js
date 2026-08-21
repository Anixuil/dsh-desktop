import { WebError } from '@deepseek-ai/dsh-web'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  resolveCredential,
  searchAnthropic,
  searchCustom,
  searchOpenAIResponses,
} from './search.js'
import { SEARCH_PROVIDER_ID } from './config.js'

const PI_SETTINGS = settingsNamespace('llm-pi-ai')
const DEEPSEEK_SEARCH_SETTINGS = settingsNamespace('web-search-deepseek')

const NATIVE_DEFAULTS = {
  openai: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' },
}

function attemptSignal(parent, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`search source timed out after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAborted(error, parent) {
  return parent?.aborted === true || error?.code === 'WEB_ABORTED'
}

export class PrioritySearchProvider {
  id = SEARCH_PROVIDER_ID

  constructor(ctx, getConfig) {
    this.ctx = ctx
    this.getConfig = getConfig
  }

  available() {
    const config = this.getConfig()
    return config.customProvider !== 'none' || config.nativeEnabled || config.deepseekFallback
  }

  async run(label, operation, parent, timeoutMs, failures) {
    const child = attemptSignal(parent, timeoutMs)
    try {
      const result = await operation(child.signal)
      this.ctx.get('agents')?.currentInitiator()?.session.append('web/desktop-search-route', { source: label })
      return result
    } catch (error) {
      if (isAborted(error, parent)) throw error
      failures.push(`${label}: ${errorText(error)}`)
      return undefined
    } finally {
      child.dispose()
    }
  }

  async search(request, signal) {
    const config = this.getConfig()
    const failures = []
    if (config.customProvider !== 'none') {
      const result = await this.run(
        `custom/${config.customProvider}`,
        (attempt) => searchCustom(this.ctx, config, request, attempt),
        signal,
        config.sourceTimeoutMs,
        failures,
      )
      if (result) return result
    }
    if (config.nativeEnabled) {
      const result = await this.run(
        'model-native',
        (attempt) => this.searchCurrentModel(request, attempt),
        signal,
        config.sourceTimeoutMs,
        failures,
      )
      if (result) return result
    }
    if (config.deepseekFallback) {
      const result = await this.run(
        'deepseek-official',
        (attempt) => this.searchDeepSeek(request, attempt),
        signal,
        Math.max(config.sourceTimeoutMs, 30000),
        failures,
      )
      if (result) return result
    }
    throw new WebError(
      failures.length > 0
        ? `all configured web-search sources failed (${failures.join(' | ')})`
        : 'no web-search source is enabled',
      'WEB_PROVIDER_ERROR',
    )
  }

  async searchCurrentModel(request, signal) {
    const agent = this.ctx.get('agents')?.currentInitiator()
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    if (!provider || !model) {
      throw new WebError('the current session has no resolved provider/model', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    const profile = this.ctx.get('settings')?.get(PI_SETTINGS)?.providers?.[provider]
    const defaults = NATIVE_DEFAULTS[provider] ?? {}
    const api = profile?.api ?? defaults.api
    const baseURL = profile?.baseURL ?? defaults.baseURL
    const apiKeyEnv = profile?.apiKeyEnv ?? defaults.apiKeyEnv
    if (!baseURL || !apiKeyEnv || !['openai-responses', 'anthropic-messages'].includes(api)) {
      throw new WebError(
        `provider "${provider}" does not expose a supported native-search protocol`,
        'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
      )
    }
    const apiKey = await resolveCredential(this.ctx, apiKeyEnv)
    if (!apiKey) throw new WebError(`model credential "${apiKeyEnv}" is not configured`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    if (api === 'openai-responses') {
      return searchOpenAIResponses({ baseURL, apiKey, model, query: request.query, signal })
    }
    return searchAnthropic({ baseURL, apiKey, model, query: request.query, signal })
  }

  async searchDeepSeek(request, signal) {
    const config = this.ctx.get('settings')?.get(DEEPSEEK_SEARCH_SETTINGS) ?? {}
    const apiKeyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    const apiKey = config.apiKey ?? await resolveCredential(this.ctx, apiKeyEnv)
    if (!apiKey) throw new WebError(`DeepSeek credential "${apiKeyEnv}" is not configured`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    return searchAnthropic({
      baseURL: config.baseURL ?? process.env.DEEPSEEK_SEARCH_BASE_URL ?? 'https://api.deepseek.com/anthropic/v1',
      apiKey,
      model: config.model ?? 'deepseek-v4-flash',
      query: request.query,
      signal,
      maxUses: config.maxUses ?? 5,
    })
  }
}
