// dsh-desktop-file-upload — inline file-card preview client module.
//
// The host admission writes a plain-text hint (`[File #N "<name>" auto-saved
// to <path>]`) into the message so the model can read the file. This module
// restores the visual half: every rendered hint becomes a file card (icon +
// name + format) so the user sees the source file, not a text address. The
// model-visible message text is untouched.
//
// DOM integration is deliberately React-agnostic: a MutationObserver
// re-transforms hint text nodes whenever the app re-renders them. Pure helpers
// stay document-free so scripts can import them under Node.

const { extOf, FILE_ICON_SVG } = require('./meta.js')
const { openFile } = require('./open.js')

const HINT_RE = /\[File #(\d+) "([^"]*)" auto-saved to ([^\]]+)\]/g
const SKIP_TAGS = new Set(['PRE', 'CODE', 'TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE'])

/** Extract `{ seq, name, path }` from one hint string, else null. */
function parseHint(text) {
  if (typeof text !== 'string') return null
  const match = /\[File #(\d+) "([^"]*)" auto-saved to ([^\]]+)\]/.exec(text)
  if (match === null) return null
  return { seq: Number(match[1]), name: match[2], path: match[3] }
}

function isSkippable(textNode) {
  let el = textNode.parentNode
  while (el !== null && el.nodeType === Node.ELEMENT_NODE) {
    if (SKIP_TAGS.has(el.tagName)) return true
    if (el.isContentEditable) return true
    el = el.parentNode
  }
  return false
}

function createFileCard(name, hintPath) {
  const wrapper = document.createElement('span')
  wrapper.className = 'dfu_msgCard'
  wrapper.title = hintPath
  wrapper.setAttribute('role', 'button')
  wrapper.tabIndex = 0
  wrapper.addEventListener('click', () => openFile(hintPath))
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openFile(hintPath)
    }
  })

  const icon = document.createElement('span')
  icon.className = 'dfu_msgCardIcon'
  icon.innerHTML = FILE_ICON_SVG

  const label = document.createElement('span')
  label.className = 'dfu_msgCardName'
  label.textContent = name

  const ext = document.createElement('span')
  ext.className = 'dfu_msgCardExt'
  ext.textContent = extOf(name)

  wrapper.append(icon, label, ext)
  return wrapper
}

/** Replace every hint occurrence inside one text node with a file card. */
function transformTextNode(textNode) {
  const value = textNode.nodeValue
  if (typeof value !== 'string' || value.indexOf('auto-saved') === -1) return
  const parent = textNode.parentNode
  if (parent === null || parent.nodeType !== Node.ELEMENT_NODE) return
  if (isSkippable(textNode)) return

  HINT_RE.lastIndex = 0
  const fragment = document.createDocumentFragment()
  let cursor = 0
  let replaced = false
  for (let match = HINT_RE.exec(value); match !== null; match = HINT_RE.exec(value)) {
    if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)))
    fragment.appendChild(createFileCard(match[2], match[3]))
    cursor = match.index + match[0].length
    replaced = true
  }
  if (!replaced) return
  if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)))
  parent.replaceChild(fragment, textNode)
}

function walkText(root, visit) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (typeof node.nodeValue === 'string' && node.nodeValue.includes('auto-saved') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) visit(node)
}

const CSS = `
.dfu_msgCard{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px 4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);vertical-align:middle;cursor:pointer}
.dfu_msgCard:hover{border-color:var(--dsw-alias-border-l4)}
.dfu_msgCardIcon{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dfu_msgCardName{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dfu_msgCardExt{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover)}
`

const STYLE_TAG_ID = 'dsh-desktop-file-upload/file-preview'

function ensureStyles() {
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return null
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-desktop-file-upload'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return tag
}

/**
 * Install the hint→file-card transform and its stylesheet.
 * @returns disposer restoring the document state this install owns.
 */
function installFilePreview() {
  if (typeof document === 'undefined') return () => {}
  const styleTag = ensureStyles()

  // Initial pass covers history rendered before this bundle loaded.
  if (document.body !== null) walkText(document.body, (node) => transformTextNode(node))

  const observer = new MutationObserver((records) => {
    observer.disconnect()
    try {
      for (const record of records) {
        if (record.type === 'characterData') {
          if (typeof record.target.nodeValue === 'string' && record.target.nodeValue.includes('auto-saved')) {
            transformTextNode(record.target)
          }
          continue
        }
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) transformTextNode(added)
          else if (added.nodeType === Node.ELEMENT_NODE && typeof added.textContent === 'string' && added.textContent.includes('auto-saved')) {
            walkText(added, (node) => transformTextNode(node))
          }
        }
      }
    } finally {
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })

  return () => {
    observer.disconnect()
    if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag)
  }
}

module.exports = { installFilePreview, parseHint, HINT_RE }
