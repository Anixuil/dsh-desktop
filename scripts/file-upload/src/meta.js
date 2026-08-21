// dsh-desktop-file-upload — pure file-meta helpers (document-free).
//
// Shared by the composer dock card list and the message preview so both render
// the same icon + format badge from a file name. No DOM access here, so the
// preview module can import it under Node for tests.

/** Uppercase extension label for a display name (`.png` → `PNG`), else `FILE`. */
function extOf(name) {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(String(name ?? ''))
  return match === null ? 'FILE' : match[1].toUpperCase()
}

/** Generic folded-corner document glyph, tinted by `currentColor`. */
const FILE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.5 1.5V5H13" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

module.exports = { extOf, FILE_ICON_SVG }
