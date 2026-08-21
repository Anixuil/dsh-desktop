// dsh-desktop-file-upload — composer dock: pending-file cards.
//
// Renders one card per uploaded file in the `conversation.input.dock` seat (a
// full-width row above the composer card). Each card shows the file's icon,
// name and format with a remove button. The hint text is NOT in the draft
// while composing; instead this component appends every pending hint to the
// draft at submit time — both the send button (wrapped inputActions.submit)
// and the Enter key (a document-level capture listener that runs before the
// composer's own keydown handler).
const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')
const { getFiles, removeFile, clearFiles, subscribe } = require('./store.js')
const { extOf, FILE_ICON_SVG } = require('./meta.js')
const { openFile } = require('./open.js')

function useFiles() {
  return react.useSyncExternalStore(subscribe, getFiles)
}

function FileCard({ file, onRemove, onOpen, t }) {
  return jsxs('div', {
    className: 'dfu_card',
    role: 'button',
    tabIndex: 0,
    title: t('open'),
    onClick: onOpen,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen()
      }
    },
    children: [
      jsx('span', {
        className: 'dfu_cardIcon',
        dangerouslySetInnerHTML: { __html: FILE_ICON_SVG },
      }),
      jsx('span', { className: 'dfu_cardName', title: file.name, children: file.name }),
      jsx('span', { className: 'dfu_cardExt', children: extOf(file.name) }),
      jsx('button', {
        type: 'button',
        className: 'dfu_cardRemove',
        title: t('remove'),
        'aria-label': t('remove'),
        onClick: (event) => {
          event.stopPropagation()
          onRemove()
        },
        children: '×',
      }),
    ],
  })
}

function FileDock({ inputActions, useInput, t }) {
  const files = useFiles()
  const input = useInput((s) => s)
  const draftRef = react.useRef('')
  draftRef.current = input.draft

  // Send button: append pending hints to the draft right before the submit.
  react.useEffect(() => {
    const originalSubmit = inputActions.submit
    inputActions.submit = () => {
      const pending = getFiles()
      if (pending.length > 0) {
        const hints = pending.map((f) => f.hint).join('\n')
        const current = draftRef.current
        inputActions.setDraft(current ? current + '\n' + hints : hints)
        clearFiles()
      }
      originalSubmit()
    }
    return () => { inputActions.submit = originalSubmit }
  }, [inputActions])

  // Enter key: the composer submits through its private keyboard face, so a
  // capture-phase listener appends the hints before its own keydown handler.
  react.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      if (event.isComposing || event.keyCode === 229) return
      const target = event.target
      if (target === null || target.tagName !== 'TEXTAREA' || !target.hasAttribute('data-phase')) return
      // A readOnly/disabled composer refuses the submit (busy / locked), so
      // appending here would strand the hints in the draft with no send.
      if (target.readOnly || target.disabled) return
      const pending = getFiles()
      if (pending.length === 0) return
      const hints = pending.map((f) => f.hint).join('\n')
      const current = target.value
      inputActions.setDraft(current ? current + '\n' + hints : hints)
      clearFiles()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [inputActions])

  if (files.length === 0) return null
  return jsx('div', {
    className: 'dfu_dock',
    children: files.map((file) => jsx(FileCard, {
      key: file.id,
      file,
      onRemove: () => removeFile(file.id),
      onOpen: () => openFile(file.path, t('openFailed')),
      t,
    })),
  })
}

module.exports = { FileDock }
