// dsh-vision-any — 视觉模型 settings section stylesheet.
// Side effect module: index.js requires it first so the styles install when
// the bundle loads (same contract as dsh-desktop-bridge).
const css = `
.dva_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.dva_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dva_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.dva_card{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}
.dva_grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;display:grid}
@media (width<=640px){.dva_grid{grid-template-columns:minmax(0,1fr)}}
.dva_field{flex-direction:column;gap:6px;display:flex}
.dva_label{color:var(--dsw-alias-label-secondary);align-items:center;gap:8px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.dva_input{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px;font-size:14px;line-height:22px;outline:none}
.dva_input:focus{border-color:var(--dsw-alias-border-l4)}
.dva_input:disabled{opacity:.5;cursor:default}
.dva_hint{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}
.dva_actions{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.dva_status{font-size:12px;line-height:18px;margin:0}
.dva_statusOk{color:var(--dsw-alias-state-success-primary)}
.dva_statusErr{color:var(--dsw-alias-state-error-primary)}
.dva_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}
.dva_primary{box-sizing:border-box;height:36px;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);font:inherit;cursor:pointer;border:none;border-radius:18px;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dva_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dva_primary:disabled{opacity:.4;cursor:default}
.dva_secondary{box-sizing:border-box;height:36px;color:var(--dsw-alias-label-primary);background:0 0;border:1px solid var(--dsw-alias-border-l2);font:inherit;cursor:pointer;border-radius:18px;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dva_secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dva_secondary:disabled{opacity:.4;cursor:default}
.dva_keyRow{flex-direction:column;gap:6px;display:flex}
.dva_keyInputRow{flex-direction:column;gap:6px;display:flex}
.dva_keyDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.dva_keyDotSet{background:var(--dsw-alias-state-success-primary)}
.dva_keyDotMissing{background:var(--dsw-alias-state-error-primary)}
.dva_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:14px;line-height:22px}
`
const style = document.createElement('style')
style.dataset.plugin = 'dsh-vision-any'
style.dataset.pluginCss = 'dsh-vision-any/settings-section'
style.textContent = css
document.head.appendChild(style)
