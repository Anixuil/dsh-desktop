// dsh-desktop-file-upload — open a stored file with the OS default app.
//
// Shared by the composer dock card and the message preview: clicking a file
// card calls the host's GET /file-upload/open?path=… route, which validates
// the path stays inside the store and hands it to the desktop opener.
const { showMessage } = require('./message.js')

async function openFile(path, failText) {
  try {
    const response = await fetch('/file-upload/open?path=' + encodeURIComponent(path))
    const payload = await response.json()
    if (!payload.ok) showMessage(payload.error?.message ?? failText ?? 'Failed to open file')
  } catch {
    showMessage(failText ?? 'Failed to open file')
  }
}

module.exports = { openFile }
