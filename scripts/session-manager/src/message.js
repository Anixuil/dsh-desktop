const ROOT_ID = 'dsh-desktop-message-root';
function showMessage(text) {
  if (typeof document === 'undefined' || text == null || text === '') return;
  let root = document.getElementById(ROOT_ID);
  if (root === null) { root = document.createElement('div'); root.id = ROOT_ID; root.className = 'dsh_messageRoot'; root.setAttribute('aria-live', 'polite'); document.body.appendChild(root); }
  if (document.getElementById('dsh-desktop-message-style') === null) { const style = document.createElement('style'); style.id = 'dsh-desktop-message-style'; style.textContent = '.dsh_messageRoot{position:fixed;z-index:10000;top:20px;left:50%;width:min(420px,calc(100vw - 32px));pointer-events:none;transform:translateX(-50%);display:flex;flex-direction:column;gap:10px}.dsh_message{box-sizing:border-box;min-height:40px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary,#f56c6c);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#303133);box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px;line-height:20px;pointer-events:auto;display:flex;gap:8px}.dsh_messageText{flex:1;overflow-wrap:anywhere}.dsh_messageClose{border:0;background:transparent;cursor:pointer;font:inherit;font-size:18px;line-height:18px;padding:0}@keyframes dsh-message-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}.dsh_message{animation:dsh-message-in .2s ease-out}'; document.head.appendChild(style); }
  const item = document.createElement('div'); item.className = 'dsh_message'; item.setAttribute('role', 'alert');
  const content = document.createElement('span'); content.className = 'dsh_messageText'; content.textContent = String(text);
  const close = document.createElement('button'); close.className = 'dsh_messageClose'; close.type = 'button'; close.setAttribute('aria-label', '关闭提示'); close.textContent = '×';
  const dismiss = () => item.remove(); close.addEventListener('click', dismiss); item.append(content, close); root.appendChild(item); window.setTimeout(dismiss, 4500);
}
module.exports = { showMessage };
