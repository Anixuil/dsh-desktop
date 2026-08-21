const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { showMessage } = require('./message.js')

const ENDPOINT = '/desktop-web-search'
const PROVIDER_ENDPOINTS = {
  exa: 'https://api.exa.ai/search',
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  perplexity: 'https://api.perplexity.ai/search',
  generic: 'https://search.example.com/search',
}

async function request(path, init) {
  const response = await fetch(`${ENDPOINT}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok !== true) {
    const error = new Error(payload?.error?.message ?? `HTTP ${String(response.status)}`)
    error.code = payload?.error?.code
    throw error
  }
  return payload.value
}

function draftFromValue(value) {
  return {
    customProvider: value?.customProvider ?? 'none',
    customBaseURL: value?.customBaseURL ?? '',
    customApiKeyEnv: value?.customApiKeyEnv ?? 'DSH_WEB_SEARCH_API_KEY',
    nativeEnabled: value?.nativeEnabled !== false,
    deepseekFallback: value?.deepseekFallback !== false,
    sourceTimeoutMs: Number(value?.sourceTimeoutMs ?? 15000),
    apiKey: '',
  }
}

function Toggle({ checked, disabled, label, onChange }) {
  return jsxs('label', { className: 'dws_switch', children: [
    jsx('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked), 'aria-label': label }),
    jsx('span', { className: 'dws_switchTrack', 'aria-hidden': 'true' }),
  ] })
}

function SourceHeader({ index, title, description, enabled, disabled, onToggle, fixed }) {
  return jsxs('div', { className: 'dws_sourceHeader', children: [
    jsx('span', { className: 'dws_index', 'aria-hidden': 'true', children: String(index) }),
    jsxs('div', { className: 'dws_sourceCopy', children: [
      jsx('h3', { className: 'dws_sourceTitle', children: title }),
      jsx('p', { className: 'dws_sourceDescription', children: description }),
    ] }),
    fixed ? null : jsx(Toggle, { checked: enabled, disabled, label: title, onChange: onToggle }),
  ] })
}

function WebSearchSection({ t, isLoopback, subscribe }) {
  const [view, setView] = react.useState(null)
  const [writable, setWritable] = react.useState(true)
  const [credential, setCredential] = react.useState({ configured: false, writable: false })
  const [draft, setDraft] = react.useState(null)
  const [busy, setBusy] = react.useState(false)
  const [testing, setTesting] = react.useState(false)
  const [error, setError] = react.useState(null)
  const [notice, setNotice] = react.useState(null)

  const read = react.useCallback(async () => {
    try {
      const value = await request('/settings')
      setView(value.view)
      setWritable(value.writable !== false)
      setCredential(value.credential ?? { configured: false, writable: false })
      setDraft((current) => current ?? draftFromValue(value.view?.value))
      setError(null)
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }, [])

  react.useEffect(() => {
    read()
    return subscribe(read)
  }, [read, subscribe])

  react.useEffect(() => {
    if (error) showMessage(`${t('loadFailed')}（${error}）`)
  }, [error, t])

  if (!isLoopback) {
    return jsxs('section', { className: 'dws_section', 'aria-label': t('title'), children: [
      jsx('h2', { className: 'dws_title', children: t('title') }),
      jsx('p', { className: 'dws_intro', children: t('unavailable') }),
    ] })
  }
  if (view === null || draft === null) {
    return jsxs('section', { className: 'dws_section', 'aria-label': t('title'), children: [
      jsx('h2', { className: 'dws_title', children: t('title') }),
      jsx('div', { className: 'dws_skeleton', 'aria-label': t('loadFailed'), children: [0, 1, 2].map((key) => jsx('span', {}, key)) }),
    ] })
  }

  const disabled = busy || testing || !writable
  const customEnabled = draft.customProvider !== 'none'
  const update = (patch) => {
    setNotice(null)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const saveCredential = async () => {
    const key = draft.apiKey.trim()
    if (!key) return credential
    return request('/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: draft.customApiKeyEnv.trim() || 'DSH_WEB_SEARCH_API_KEY', value: key }),
    })
  }

  const save = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const fields = ['customProvider', 'customBaseURL', 'customApiKeyEnv', 'nativeEnabled', 'deepseekFallback', 'sourceTimeoutMs']
      const ops = fields.map((field) => ({ op: 'set', path: [field], value: typeof draft[field] === 'string' ? draft[field].trim() : draft[field] }))
      const value = await request('/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, expectedRevision: view.revision }),
      })
      const nextCredential = await saveCredential()
      setView(value.view)
      setWritable(value.writable !== false)
      setCredential(nextCredential ?? value.credential)
      setDraft({ ...draftFromValue(value.view?.value), apiKey: '' })
      setNotice({ kind: 'ok', text: t('saved') })
    } catch (cause) {
      const text = cause?.code === 'settings-conflict' ? t('conflict') : String(cause?.message ?? cause)
      setNotice({ kind: 'err', text })
      showMessage(text)
      if (cause?.code === 'settings-conflict') await read()
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    setBusy(true)
    try {
      const next = await request('/credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: draft.customApiKeyEnv.trim() || 'DSH_WEB_SEARCH_API_KEY', clear: true }),
      })
      setCredential(next)
      setDraft((current) => ({ ...current, apiKey: '' }))
    } catch (cause) {
      showMessage(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setNotice(null)
    try {
      const value = await request('/test', { method: 'POST' })
      setNotice({ kind: 'ok', text: t('testOk', { count: value.count }) })
    } catch (cause) {
      const text = String(cause?.message ?? cause)
      setNotice({ kind: 'err', text })
      showMessage(text)
    } finally {
      setTesting(false)
    }
  }

  return jsxs('section', { className: 'dws_section', 'aria-label': t('title'), children: [
    jsx('h2', { className: 'dws_title', children: t('title') }),
    jsx('p', { className: 'dws_intro', children: t('intro') }),
    jsx('p', { className: 'dws_orderLabel', children: t('sourceOrder') }),
    jsxs('div', { className: 'dws_sources', children: [
      jsxs('div', { className: `dws_source${customEnabled ? ' dws_sourceEnabled' : ''}`, children: [
        jsx(SourceHeader, {
          index: 1,
          title: t('customTitle'),
          description: t('customDescription'),
          enabled: customEnabled,
          disabled,
          onToggle: (checked) => update({ customProvider: checked ? 'exa' : 'none' }),
        }),
        customEnabled ? jsxs('div', { className: 'dws_sourceBody', children: [
          jsxs('label', { className: 'dws_field', children: [
            jsx('span', { className: 'dws_label', children: t('provider') }),
            jsx('select', { className: 'dws_input', value: draft.customProvider, disabled, onChange: (event) => update({ customProvider: event.target.value, customBaseURL: '' }), children: [
              jsx('option', { value: 'exa', children: t('providerExa') }),
              jsx('option', { value: 'tavily', children: t('providerTavily') }),
              jsx('option', { value: 'brave', children: t('providerBrave') }),
              jsx('option', { value: 'perplexity', children: t('providerPerplexity') }),
              jsx('option', { value: 'generic', children: t('providerGeneric') }),
            ] }),
          ] }),
          jsxs('label', { className: 'dws_field', children: [
            jsx('span', { className: 'dws_label', children: t('baseURL') }),
            jsx('input', { className: 'dws_input', type: 'url', value: draft.customBaseURL, placeholder: PROVIDER_ENDPOINTS[draft.customProvider] ?? '', disabled, spellCheck: false, onChange: (event) => update({ customBaseURL: event.target.value }) }),
            jsx('span', { className: 'dws_hint', children: t('baseURLHint') }),
          ] }),
          jsxs('div', { className: 'dws_grid', children: [
            jsxs('label', { className: 'dws_field', children: [
              jsx('span', { className: 'dws_label', children: t('apiKeyEnv') }),
              jsx('input', { className: 'dws_input', value: draft.customApiKeyEnv, disabled, spellCheck: false, onChange: (event) => update({ customApiKeyEnv: event.target.value }) }),
            ] }),
            jsxs('label', { className: 'dws_field', children: [
              jsxs('span', { className: 'dws_label', children: [
                t('apiKey'),
                jsx('span', { className: credential.configured ? 'dws_keyState dws_keySet' : 'dws_keyState dws_keyMissing', children: credential.configured ? t('apiKeySet') : t('apiKeyMissing') }),
              ] }),
              jsx('input', { className: 'dws_input', type: 'password', value: draft.apiKey, placeholder: t('apiKeyPlaceholder'), disabled, autoComplete: 'off', spellCheck: false, onChange: (event) => update({ apiKey: event.target.value }) }),
            ] }),
          ] }),
          jsxs('div', { className: 'dws_inlineActions', children: [
            jsx('span', { className: 'dws_hint', children: t('apiKeyEnvHint') }),
            credential.configured ? jsx('button', { type: 'button', className: 'dws_textButton', disabled, onClick: clearKey, children: t('clearKey') }) : null,
          ] }),
        ] }) : null,
      ] }),
      jsxs('div', { className: `dws_source${draft.nativeEnabled ? ' dws_sourceEnabled' : ''}`, children: [
        jsx(SourceHeader, { index: 2, title: t('nativeTitle'), description: t('nativeDescription'), enabled: draft.nativeEnabled, disabled, onToggle: (checked) => update({ nativeEnabled: checked }) }),
      ] }),
      jsxs('div', { className: `dws_source${draft.deepseekFallback ? ' dws_sourceEnabled' : ''}`, children: [
        jsx(SourceHeader, { index: 3, title: t('deepseekTitle'), description: t('deepseekDescription'), enabled: draft.deepseekFallback, disabled, onToggle: (checked) => update({ deepseekFallback: checked }) }),
      ] }),
    ] }),
    jsxs('label', { className: 'dws_timeout', children: [
      jsx('span', { className: 'dws_label', children: t('timeout') }),
      jsx('select', { className: 'dws_input dws_timeoutSelect', value: String(draft.sourceTimeoutMs), disabled, onChange: (event) => update({ sourceTimeoutMs: Number(event.target.value) }), children: [10000, 15000, 20000, 30000].map((ms) => jsx('option', { value: String(ms), children: t('seconds', { seconds: ms / 1000 }) }, ms)) }),
    ] }),
    jsxs('div', { className: 'dws_actions', children: [
      !writable ? jsx('span', { className: 'dws_notice', children: t('readOnly') }) : null,
      notice ? jsx('span', { className: notice.kind === 'ok' ? 'dws_status dws_statusOk' : 'dws_status dws_statusErr', role: notice.kind === 'err' ? 'alert' : 'status', children: notice.text }) : null,
      jsx('button', { type: 'button', className: 'dws_secondary', disabled: disabled || !customEnabled, onClick: test, children: testing ? t('testing') : t('test') }),
      jsx('button', { type: 'button', className: 'dws_primary', disabled, onClick: save, children: busy ? t('saving') : t('save') }),
    ] }),
  ] })
}

module.exports = { WebSearchSection, draftFromValue }
