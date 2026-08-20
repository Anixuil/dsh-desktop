// Small Element-Plus-style message layer shared by desktop client surfaces.
const ROOT_ID = 'dsh-desktop-message-root';
const STYLE_ID = 'dsh-desktop-message-style';

function ensureMessageLayer() {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(ROOT_ID);
  if (root === null) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'dsh_messageRoot';
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(root);
  }
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.dsh_messageRoot{position:fixed;z-index:10000;top:20px;left:50%;width:min(420px,calc(100vw - 32px));pointer-events:none;transform:translateX(-50%);display:flex;flex-direction:column;gap:10px}.dsh_message{box-sizing:border-box;min-height:40px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e4e7ed);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#303133);box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px;line-height:20px;pointer-events:auto;display:flex;align-items:flex-start;gap:8px;animation:dsh-message-in .2s ease-out}.dsh_messageError{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f56c6c) 36%,transparent)}.dsh_messageIcon{flex:none;color:var(--dsw-alias-state-error-primary,#f56c6c);font-weight:700}.dsh_messageText{min-width:0;flex:1;overflow-wrap:anywhere}.dsh_messageClose{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:18px;line-height:18px;padding:0;opacity:.65}.dsh_messageClose:hover{opacity:1}@keyframes dsh-message-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@media (prefers-reduced-motion:reduce){.dsh_message{animation:none}}';
    document.head.appendChild(style);
  }
  return root;
}

function showMessage(text, options = {}) {
  const root = ensureMessageLayer();
  if (root === null || text === null || text === undefined || text === '') return;
  const item = document.createElement('div');
  item.className = 'dsh_message dsh_messageError';
  item.setAttribute('role', 'alert');
  const icon = document.createElement('span');
  icon.className = 'dsh_messageIcon';
  icon.textContent = '!';
  const content = document.createElement('span');
  content.className = 'dsh_messageText';
  content.textContent = String(text);
  const close = document.createElement('button');
  close.className = 'dsh_messageClose';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  const dismiss = () => item.remove();
  close.addEventListener('click', dismiss);
  item.append(icon, content, close);
  root.appendChild(item);
  window.setTimeout(dismiss, options.duration ?? 4500);
}

module.exports = { showMessage };
