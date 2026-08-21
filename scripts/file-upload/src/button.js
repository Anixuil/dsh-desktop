// dsh-desktop-file-upload — composer tool-row button (host-backed store).
//
// Registers a small button in the composer's left tool row
// (`conversation.input.left`). Clicking it opens a native file picker; the
// selected file is read as base64 and POSTed to the host's same-origin
// /file-upload route, which persists it to a temp-dir store and returns a
// `[File #N "<name>" auto-saved to ...]` hint. The button records the file in
// the client pending-file store (the dock renders it as a card); the hint is
// appended to the draft at send time, so the model reads the full file with
// its own `read` tool instead of receiving the content inline.
const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { showMessage } = require('./message.js')
const { addFile } = require('./store.js')

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILE_LABEL = '10 MB'

function FileUploadButton({ inputActions, t }) {
  const inputRef = react.useRef(null)
  const [busy, setBusy] = react.useState(false)

  const pick = () => {
    if (inputRef.current !== null) inputRef.current.click()
  }

  const onFiles = (fileList) => {
    const file = fileList?.[0]
    if (file === undefined) return
    if (file.size > MAX_FILE_BYTES) {
      showMessage(t('tooLarge', { limit: MAX_FILE_LABEL }))
      return
    }
    setBusy(true)
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
        const response = await fetch('/file-upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, data }),
        })
        const payload = await response.json()
        if (!payload.ok) {
          showMessage(payload.error?.message ?? t('uploadFailed'))
          return
        }
        addFile({
          id: payload.hint,
          name: payload.name,
          hint: payload.hint,
          path: payload.path,
          bytes: payload.bytes,
        })
      } catch {
        showMessage(t('uploadFailed'))
      } finally {
        setBusy(false)
      }
    }
    reader.onerror = () => {
      setBusy(false)
      showMessage(t('readFailed'))
    }
    reader.readAsDataURL(file)
  }

  return jsxs('div', {
    className: 'dfu_root',
    children: [
      jsx('input', {
        ref: inputRef,
        className: 'dfu_input',
        type: 'file',
        onChange: (event) => {
          onFiles(event.target.files)
          event.target.value = ''
        },
      }),
      jsx('button', {
        type: 'button',
        className: 'dfu_btn',
        title: t('title'),
        'aria-label': t('title'),
        disabled: busy,
        onClick: pick,
        children: jsx('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          children: jsx('path', {
            d: 'M9.5 2.5l4 4-6.5 6.5a3 3 0 0 1-4.24-4.24l6.5-6.5a2 2 0 0 1 2.83 2.83l-6.5 6.5a1 1 0 0 1-1.42-1.42l5.5-5.5',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        }),
      }),
    ],
  })
}

module.exports = { FileUploadButton }
