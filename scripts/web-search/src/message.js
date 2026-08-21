const ROOT_ID = 'dws_messageRoot'

function showMessage(text) {
  if (typeof document === 'undefined' || !text) return
  let root = document.getElementById(ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = ROOT_ID
    root.className = 'dws_messageRoot'
    root.setAttribute('aria-live', 'polite')
    document.body.appendChild(root)
  }
  const item = document.createElement('div')
  item.className = 'dws_message'
  item.setAttribute('role', 'status')
  item.textContent = String(text)
  root.appendChild(item)
  window.setTimeout(() => item.remove(), 4200)
}

module.exports = { showMessage }
