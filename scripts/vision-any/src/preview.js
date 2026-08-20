// dsh-vision-any — inline image preview client module.
//
// The host admission replaces pasted images with a plain-text hint
// (`[Image #N auto-saved to <path>]`) so text-only models can still route the
// turn. This module restores the visual half: every rendered hint becomes an
// inline image card fetched from the host's /vision-any/images route (the URL
// is derived purely from the hint's saved path, so history pages render too),
// and clicking it opens a document-level lightbox preview. The model-visible
// message text is untouched.
//
// DOM integration is deliberately React-agnostic: a MutationObserver
// re-transforms hint text nodes whenever the app re-renders them, and the
// lightbox lives outside the app tree. Pure helpers stay document-free so
// scripts/test-vision-any.mjs can import them under Node.

const HINT_RE = /\[Image #(\d+) auto-saved to ([^\]]+)\]/g
const FILE_TAIL_RE = /(image\d+)[\\/]([0-9a-f]{16}\.(?:png|jpe?g|webp|gif|bmp))$/i
const SKIP_TAGS = new Set(['PRE', 'CODE', 'TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE'])

/**
 * Derive the stored image route segments from a hint's saved path.
 * @param hintPath - absolute path captured from a `[Image #N auto-saved to ...]` hint.
 * @returns `{ seqDir, fileName }` for a store-shaped path, else null.
 */
function resolveImagePath(hintPath) {
  if (typeof hintPath !== 'string' || hintPath.length === 0) return null
  const match = FILE_TAIL_RE.exec(hintPath.replace(/\\/g, '/'))
  if (match === null) return null
  return { seqDir: match[1].toLowerCase(), fileName: match[2].toLowerCase() }
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

function createImageCard(seq, hintPath, t) {
  const resolved = resolveImagePath(hintPath)
  const wrapper = document.createElement('span')
  wrapper.className = 'dva_image'
  wrapper.dataset.visionAnyImage = resolved === null ? 'invalid' : `${resolved.seqDir}/${resolved.fileName}`

  const fallback = () => {
    const fail = document.createElement('span')
    fail.className = 'dva_imageErr'
    fail.textContent = t('imageFailed', { seq })
    fail.title = hintPath
    return fail
  }

  if (resolved === null) {
    wrapper.appendChild(fallback())
    return wrapper
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dva_imageBtn'
  button.title = t('imagePreview')
  button.setAttribute('aria-label', t('imagePreview'))
  const img = document.createElement('img')
  img.className = 'dva_imageImg'
  img.alt = `Image #${seq}`
  img.loading = 'lazy'
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  img.src = `${location.origin}/vision-any/images/${resolved.seqDir}/${resolved.fileName}`
  img.addEventListener('error', () => {
    button.classList.add('dva_imageBtnFailed')
    button.replaceChildren(fallback())
  }, { once: true })
  button.appendChild(img)
  wrapper.appendChild(button)
  return wrapper
}

/** Replace every hint occurrence inside one text node with an image card. */
function transformTextNode(textNode, t) {
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
    fragment.appendChild(createImageCard(match[1], match[2], t))
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
.dva_image{display:block;margin:2px 0}
.dva_imageBtn{box-sizing:border-box;max-width:280px;cursor:zoom-in;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:0;overflow:hidden;display:block;line-height:0}
.dva_imageBtn:hover{border-color:var(--dsw-alias-border-l4)}
.dva_imageImg{display:block;max-width:100%;max-height:240px;width:auto;height:auto;border-radius:11px}
.dva_imageBtnFailed{padding:8px 12px;line-height:18px;display:inline-flex;text-align:left}
.dva_imageErr{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.dva_lightbox{z-index:2147483000;position:fixed;inset:0;justify-content:center;align-items:center;padding:32px;display:flex}
.dva_lightbox[hidden]{display:none}
.dva_lightboxMask{position:absolute;inset:0;background:rgba(0,0,0,.74)}
.dva_lightboxImg{position:relative;max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5)}
.dva_lightboxClose{position:absolute;top:18px;right:18px;width:36px;height:36px;cursor:pointer;color:#fff;background:rgba(255,255,255,.16);border:none;border-radius:999px;font-size:22px;line-height:1;display:grid;place-items:center}
.dva_lightboxClose:hover{background:rgba(255,255,255,.3)}
`

const STYLE_TAG_ID = 'dsh-vision-any/image-preview'

function ensureStyles() {
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return null
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-vision-any'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return tag
}

function ensureLightbox(t) {
  let box = document.querySelector('.dva_lightbox[data-vision-any-lightbox]')
  if (box !== null) return box
  box = document.createElement('div')
  box.className = 'dva_lightbox'
  box.dataset.visionAnyLightbox = ''
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.hidden = true
  const mask = document.createElement('div')
  mask.className = 'dva_lightboxMask'
  mask.setAttribute('aria-hidden', 'true')
  const img = document.createElement('img')
  img.className = 'dva_lightboxImg'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dva_lightboxClose'
  close.setAttribute('aria-label', t('previewClose'))
  close.textContent = '×'
  box.append(mask, img, close)
  const dismiss = () => {
    box.hidden = true
    img.removeAttribute('src')
    img.removeAttribute('alt')
  }
  mask.addEventListener('click', dismiss)
  close.addEventListener('click', dismiss)
  document.body.appendChild(box)
  return box
}

function openLightbox(src, alt, t) {
  const box = ensureLightbox(t)
  const img = box.querySelector('.dva_lightboxImg')
  img.src = src
  img.alt = alt
  box.hidden = false
}

function closeLightbox() {
  const box = document.querySelector('.dva_lightbox[data-vision-any-lightbox]')
  if (box === null || box.hidden) return
  box.hidden = true
  const img = box.querySelector('.dva_lightboxImg')
  img.removeAttribute('src')
  img.removeAttribute('alt')
}

/**
 * Install the hint→image transform, click-to-preview lightbox and stylesheet.
 * @param t - namespace-bound translator (locale service).
 * @returns disposer restoring the document state this install owns.
 */
function installImagePreview(t) {
  if (typeof document === 'undefined') return () => {}
  const styleTag = ensureStyles()

  // Initial pass covers history rendered before this bundle loaded.
  if (document.body !== null) walkText(document.body, (node) => transformTextNode(node, t))

  const observer = new MutationObserver((records) => {
    observer.disconnect()
    try {
      for (const record of records) {
        if (record.type === 'characterData') {
          if (typeof record.target.nodeValue === 'string' && record.target.nodeValue.includes('auto-saved')) {
            transformTextNode(record.target, t)
          }
          continue
        }
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) transformTextNode(added, t)
          else if (added.nodeType === Node.ELEMENT_NODE && typeof added.textContent === 'string' && added.textContent.includes('auto-saved')) {
            walkText(added, (node) => transformTextNode(node, t))
          }
        }
      }
    } finally {
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })

  const onClick = (event) => {
    const target = event.target
    if (target === null || typeof target.closest !== 'function') return
    const button = target.closest('button.dva_imageBtn')
    if (button === null) return
    const img = button.querySelector('img.dva_imageImg')
    if (img === null || img.getAttribute('src') === null) return
    openLightbox(img.getAttribute('src'), img.alt, t)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeLightbox()
  }
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown)

  return () => {
    observer.disconnect()
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown)
    if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag)
  }
}

module.exports = { installImagePreview, resolveImagePath }
