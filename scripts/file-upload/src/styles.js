// dsh-desktop-file-upload — composer button stylesheet.
// Side effect module: index.js requires it first so the styles install when
// the bundle loads (same contract as dsh-desktop-bridge).
const css = `
.dfu_root{display:inline-flex;align-items:center}
.dfu_input{display:none}
.dfu_btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;cursor:pointer;border-radius:6px;align-items:center;justify-content:center;gap:4px;padding:0 6px;display:inline-flex}
.dfu_btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dfu_btn:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:1px}
.dfu_dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto;padding:0 var(--dsh-composer-side-clearance);flex:none;flex-direction:column;gap:6px;display:flex}
.dfu_card{box-sizing:border-box;min-width:0;align-items:center;gap:8px;padding:6px 8px 6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);cursor:pointer;display:flex}
.dfu_card:hover{border-color:var(--dsw-alias-border-l4)}
.dfu_cardIcon{color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex}
.dfu_cardName{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dfu_cardExt{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover)}
.dfu_cardRemove{flex:none;width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;font-size:16px;line-height:1;place-items:center;padding:0;display:grid}
.dfu_cardRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`
const style = document.createElement('style')
style.dataset.plugin = 'dsh-desktop-file-upload'
style.dataset.pluginCss = 'dsh-desktop-file-upload/composer-button'
style.textContent = css
document.head.appendChild(style)
