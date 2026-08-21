import { WebError } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const DEFAULT_ENDPOINTS = {
  exa: 'https://api.exa.ai/search',
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  perplexity: 'https://api.perplexity.ai/search',
}

function cleanBase(value) {
  return String(value ?? '').trim().replace(/\/+$/u, '')
}

function endpointFromBase(baseURL, suffix) {
  const base = cleanBase(baseURL)
  if (base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

function sourceOf(item) {
  if (item === null || typeof item !== 'object') return undefined
  const url = item.url ?? item.link ?? item.href
  if (typeof url !== 'string' || !/^https?:\/\//iu.test(url)) return undefined
  const title = item.title ?? item.name
  const snippet = item.snippet ?? item.text ?? item.content ?? item.description
  const publishedAt = item.publishedAt ?? item.published_date ?? item.publishedDate ?? item.date
  return {
    url,
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    ...(typeof snippet === 'string' && snippet.length > 0 ? { snippet } : {}),
    ...(typeof publishedAt === 'string' && publishedAt.length > 0 ? { publishedAt } : {}),
  }
}

export function normalizeSources(items) {
  if (!Array.isArray(items)) return []
  const seen = new Set()
  const sources = []
  for (const item of items) {
    const source = sourceOf(item)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return sources
}

function commonResultArrays(payload) {
  return [
    payload?.results,
    payload?.items,
    payload?.data,
    payload?.web?.results,
    payload?.organic,
  ]
}

export function parseCustomResponse(payload) {
  for (const items of commonResultArrays(payload)) {
    const sources = normalizeSources(items)
    if (sources.length > 0) {
      const answer = payload?.answer ?? payload?.content ?? payload?.summary
      return {
        ...(typeof answer === 'string' && answer.length > 0 ? { content: answer } : {}),
        sources,
        truncated: false,
      }
    }
  }
  throw new WebError('custom search returned no usable HTTP(S) results', 'WEB_PROVIDER_ERROR')
}

function responseText(payload) {
  const parts = []
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const block of item.content ?? []) {
      if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

export function parseOpenAIResponses(payload) {
  const candidates = []
  for (const item of payload?.output ?? []) {
    if (item?.type === 'web_search_call') candidates.push(...(item.action?.sources ?? []))
    if (item?.type !== 'message') continue
    for (const block of item.content ?? []) {
      for (const annotation of block?.annotations ?? []) {
        if (annotation?.type === 'url_citation' || typeof annotation?.url === 'string') {
          candidates.push(annotation)
        }
      }
    }
  }
  const sources = normalizeSources(candidates)
  if (sources.length === 0) {
    throw new WebError('the current model returned no native web-search citations', 'WEB_PROVIDER_ERROR')
  }
  const content = responseText(payload)
  return {
    ...(content ? { content } : {}),
    sources,
    truncated: false,
  }
}

export function parseAnthropicResponse(payload) {
  const candidates = []
  const snippets = new Map()
  const text = []
  for (const block of payload?.content ?? []) {
    if (block?.type === 'text') {
      if (typeof block.text === 'string') text.push(block.text)
      for (const citation of block.citations ?? []) {
        if (typeof citation?.url === 'string' && typeof citation?.cited_text === 'string') {
          snippets.set(citation.url, citation.cited_text)
        }
      }
    }
    if (block?.type === 'web_search_tool_result') {
      candidates.push(...(block.content ?? []).filter((item) => item?.type === 'web_search_result'))
    }
  }
  const sources = normalizeSources(candidates).map((source) => ({
    ...source,
    ...(source.snippet === undefined && snippets.has(source.url) ? { snippet: snippets.get(source.url) } : {}),
  }))
  if (sources.length === 0) {
    throw new WebError('the current model returned no native web-search result blocks', 'WEB_PROVIDER_ERROR')
  }
  const content = text.join('\n').trim()
  return {
    ...(content ? { content } : {}),
    sources,
    truncated: false,
  }
}

async function readResponse(response, label) {
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new WebError(`${label} returned invalid JSON`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? payload?.message
    throw new WebError(
      typeof detail === 'string' && detail.length > 0 ? `${label}: ${detail}` : `${label} failed with HTTP ${response.status}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  return payload
}

async function fetchJson(url, init, label) {
  let response
  try {
    response = await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    if (init.signal?.aborted) throw new WebError(`${label} was aborted`, 'WEB_ABORTED', { cause: error })
    throw new WebError(`${label} request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return readResponse(response, label)
}

export async function resolveCredential(ctx, ref) {
  const normalized = credentialRef(ref)
  const stored = await ctx.get('credentials')?.resolve(normalized)
  const value = stored?.value ?? process.env[normalized]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export async function searchCustom(ctx, config, request, signal, options = {}) {
  const provider = config.customProvider
  if (!provider || provider === 'none') {
    throw new WebError('custom search is disabled', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  }
  const keyRef = config.customApiKeyEnv || 'DSH_WEB_SEARCH_API_KEY'
  const apiKey = typeof options.apiKey === 'string' && options.apiKey.trim().length > 0
    ? options.apiKey.trim()
    : await resolveCredential(ctx, keyRef)
  if (!apiKey) throw new WebError(`custom search credential "${keyRef}" is not configured`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
  const endpoint = cleanBase(config.customBaseURL) || DEFAULT_ENDPOINTS[provider]
  if (!endpoint) throw new WebError('custom search Base URL is required', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  const maxResults = request.maxResults ?? 8
  let url = endpoint
  let init
  if (provider === 'brave') {
    const parsed = new URL(endpoint)
    parsed.searchParams.set('q', request.query)
    parsed.searchParams.set('count', String(maxResults))
    url = parsed.toString()
    init = { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': apiKey }, signal }
  } else {
    const body = provider === 'exa'
      ? { query: request.query, numResults: maxResults, contents: { text: { maxCharacters: 1200 } } }
      : provider === 'tavily'
        ? { api_key: apiKey, query: request.query, max_results: maxResults, include_answer: false }
        : { query: request.query, maxResults, max_results: maxResults }
    init = {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(provider === 'exa' ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal,
    }
  }
  return parseCustomResponse(await fetchJson(url, init, `${provider} search`))
}

export async function searchOpenAIResponses({ baseURL, apiKey, model, query, signal }) {
  const endpoint = endpointFromBase(baseURL, '/responses')
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: `Search the web for: ${query}`,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
    }),
    signal,
  }, 'model-native OpenAI Responses search')
  return parseOpenAIResponses(payload)
}

export async function searchAnthropic({ baseURL, apiKey, model, query, signal, maxUses = 5 }) {
  const endpoint = endpointFromBase(baseURL, '/messages')
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Search the web for: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }),
    signal,
  }, 'model-native Anthropic search')
  return parseAnthropicResponse(payload)
}
