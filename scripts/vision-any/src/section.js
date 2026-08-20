// dsh-vision-any — settings section component (视觉模型 / Vision model).
//
// Renders the `vision-any` settings namespace as a form in the web settings
// panel: provider / base URL / model / API key / key-env. Reads and writes
// through the plugin's own same-origin routes (/vision-any/settings), which
// talk to the settings seam directly — the namespace is not on the API
// proxy's expose list, and its owner exposes it instead. Writes use per-field
// mutate ops, so fields the user never touched keep following the config
// file / env / built-in defaults.
const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { showMessage } = require('./message.js')

const SETTINGS_ENDPOINT = '/vision-any/settings'

const EDITABLE_FIELDS = ['provider', 'baseUrl', 'model', 'apiKeyEnv']

const PROVIDER_HINTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** Draft field texts from a (redacted) namespace value. */
function draftFromValue(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    provider: textOf(source.provider),
    baseUrl: textOf(source.baseUrl),
    model: textOf(source.model),
    apiKeyEnv: textOf(source.apiKeyEnv),
    apiKey: '',
  }
}

function secretIsSet(view) {
  return Array.isArray(view?.secrets)
    && view.secrets.some((s) => Array.isArray(s.path) && s.path[0] === 'apiKey' && s.set === true)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** GET/POST /vision-any/settings with the plugin's { ok, value | error } envelope. */
async function requestSettings(init) {
  const response = await fetch(SETTINGS_ENDPOINT, init)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`HTTP ${String(response.status)}`)
  }
  if (!payload.ok) {
    const error = new Error(payload.error?.message ?? 'request failed')
    error.code = payload.error?.code
    throw error
  }
  return payload
}

function VisionSection(props) {
  const { t, isLoopback, subscribe } = props
  const [view, setView] = react.useState(null)
  const [writable, setWritable] = react.useState(true)
  const [draft, setDraft] = react.useState(null)
  const [busy, setBusy] = react.useState(false)
  const [loadError, setLoadError] = react.useState(null)
  const [notice, setNotice] = react.useState(null)

  const read = react.useCallback(async () => {
    try {
      const payload = await requestSettings({})
      setView(payload.value.view)
      setWritable(payload.value.writable !== false)
      setLoadError(null)
      // Fill the form only on first load; later reloads keep the user's
      // in-progress edits (and the write response resets the draft itself).
      setDraft((prev) => (prev === null ? draftFromValue(payload.value.view?.value) : prev))
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  react.useEffect(() => {
    read()
    return subscribe(read)
  }, [read, subscribe])

  react.useEffect(() => {
    if (loadError !== null) showMessage(`${t('loadFailed')}（${loadError}）`)
  }, [loadError, t])

  react.useEffect(() => {
    if (notice?.kind === 'err') showMessage(notice.text)
  }, [notice])

  if (!isLoopback) {
    return jsxs('section', {
      className: 'dva_section',
      'aria-label': t('title'),
      children: [jsx('h2', { className: 'dva_title', children: t('title') }), jsx('p', { className: 'dva_intro', children: t('unavailable') })],
    })
  }

  if (loadError !== null && view === null) {
    return jsxs('section', {
      className: 'dva_section',
      'aria-label': t('title'),
      children: [jsx('h2', { className: 'dva_title', children: t('title') }), jsx('p', { className: 'dva_intro', children: t('loadFailed') })],
    })
  }

  const hint = PROVIDER_HINTS[draft?.provider] ?? {}
  const disabled = busy || !writable
  const keySet = secretIsSet(view)

  const update = (field, text) => {
    setNotice(null)
    setDraft((prev) => ({ ...prev, [field]: text }))
  }

  /** Apply the write response (fresh redacted view) and reset the draft. */
  const accept = (next) => {
    setView(next)
    setDraft(draftFromValue(next?.value))
    setNotice({ kind: 'ok', text: t('saved') })
  }

  /** Handle a failed write: surface the message and resync on conflicts. */
  const reject = async (error) => {
    setNotice({ kind: 'err', text: error?.code === 'settings-conflict' ? t('conflict') : messageOf(error) })
    if (error?.code === 'settings-conflict') await read()
  }

  const save = async () => {
    if (disabled || view === null) return
    setBusy(true)
    setNotice(null)
    try {
      const ops = []
      for (const field of EDITABLE_FIELDS) {
        const text = (draft?.[field] ?? '').trim()
        ops.push(text.length > 0
          ? { op: 'set', path: [field], value: text }
          : { op: 'unset', path: [field] })
      }
      const keyText = (draft?.apiKey ?? '').trim()
      if (keyText.length > 0) ops.push({ op: 'set', path: ['apiKey'], value: keyText })
      const payload = await requestSettings({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops,
          ...(view.revision === undefined ? {} : { expectedRevision: view.revision }),
        }),
      })
      accept(payload.value.view)
    } catch (error) {
      await reject(error)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    if (disabled || view === null) return
    setBusy(true)
    setNotice(null)
    try {
      const payload = await requestSettings({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops: [{ op: 'unset', path: ['apiKey'] }],
          ...(view.revision === undefined ? {} : { expectedRevision: view.revision }),
        }),
      })
      accept(payload.value.view)
    } catch (error) {
      await reject(error)
    } finally {
      setBusy(false)
    }
  }

  return jsxs('section', {
    className: 'dva_section',
    'aria-label': t('title'),
    children: [
      jsx('h2', { className: 'dva_title', children: t('title') }),
      jsx('p', { className: 'dva_intro', children: t('intro') }),
      jsxs('div', {
        className: 'dva_card',
        children: [
          jsxs('label', {
            className: 'dva_field',
            children: [
              jsx('span', { className: 'dva_label', children: t('provider') }),
              jsx('select', {
                className: 'dva_input',
                value: draft?.provider ?? '',
                disabled,
                onChange: (event) => {
                  update('provider', event.target.value)
                },
                children: [
                  jsx('option', { value: '', children: t('providerEmpty') }),
                  jsx('option', { value: 'openai', children: t('providerOpenai') }),
                  jsx('option', { value: 'anthropic', children: t('providerAnthropic') }),
                  jsx('option', { value: 'gemini', children: t('providerGemini') }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'dva_grid',
            children: [
              jsxs('label', {
                className: 'dva_field',
                children: [
                  jsx('span', { className: 'dva_label', children: t('baseUrl') }),
                  jsx('input', {
                    className: 'dva_input',
                    type: 'text',
                    value: draft?.baseUrl ?? '',
                    placeholder: hint.baseUrl ?? '',
                    spellCheck: false,
                    disabled,
                    onChange: (event) => {
                      update('baseUrl', event.target.value)
                    },
                  }),
                ],
              }),
              jsxs('label', {
                className: 'dva_field',
                children: [
                  jsx('span', { className: 'dva_label', children: t('model') }),
                  jsx('input', {
                    className: 'dva_input',
                    type: 'text',
                    value: draft?.model ?? '',
                    placeholder: hint.model ?? '',
                    spellCheck: false,
                    disabled,
                    onChange: (event) => {
                      update('model', event.target.value)
                    },
                  }),
                ],
              }),
            ],
          }),
          jsxs('label', {
            className: 'dva_field',
            children: [
              jsx('span', { className: 'dva_label', children: t('apiKeyEnv') }),
              jsx('input', {
                className: 'dva_input',
                type: 'text',
                value: draft?.apiKeyEnv ?? '',
                placeholder: 'OPENAI_API_KEY',
                spellCheck: false,
                disabled,
                onChange: (event) => {
                  update('apiKeyEnv', event.target.value)
                },
              }),
              jsx('p', { className: 'dva_hint', children: t('apiKeyEnvHint') }),
            ],
          }),
          jsxs('label', {
            className: 'dva_field',
            children: [
              jsxs('span', {
                className: 'dva_label',
                children: [
                  t('apiKey'),
                  keySet
                    ? jsx('span', { className: 'dva_keyDot dva_keyDotSet', title: t('apiKeySet') })
                    : jsx('span', { className: 'dva_keyDot dva_keyDotMissing', title: t('apiKeyMissing') }),
                ],
              }),
              jsx('input', {
                className: 'dva_input',
                type: 'password',
                value: draft?.apiKey ?? '',
                placeholder: t('apiKeyPlaceholder'),
                autoComplete: 'off',
                spellCheck: false,
                disabled,
                onChange: (event) => {
                  update('apiKey', event.target.value)
                },
              }),
              keySet
                ? jsx('div', {
                    className: 'dva_actions',
                    children: jsx('button', {
                      type: 'button',
                      className: 'dva_secondary',
                      disabled,
                      onClick: clearKey,
                      children: t('clearKey'),
                    }),
                  })
                : null,
            ],
          }),
          jsxs('div', {
            className: 'dva_actions',
            children: [
              writable ? null : jsx('span', { className: 'dva_notice', children: t('readOnly') }),
              notice !== null && notice.kind !== 'err'
                ? jsx('span', {
                    className: `dva_status ${notice.kind === 'ok' ? 'dva_statusOk' : 'dva_statusErr'}`,
                    children: notice.text,
                  })
                : null,
              jsx('button', {
                type: 'button',
                className: 'dva_primary',
                disabled,
                onClick: save,
                children: busy ? t('saving') : t('save'),
              }),
            ],
          }),
        ],
      }),
    ],
  })
}

module.exports = { VisionSection, draftFromValue, secretIsSet }
