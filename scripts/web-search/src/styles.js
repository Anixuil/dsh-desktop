const css = `
.dws_section{box-sizing:border-box;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.dws_title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dws_intro{max-width:680px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.dws_orderLabel{margin:6px 0 0;color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;line-height:18px}
.dws_sources{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base)}
.dws_source{position:relative;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dws_source:last-child{border-bottom:0}
.dws_sourceHeader{box-sizing:border-box;min-height:76px;display:flex;align-items:flex-start;gap:12px;padding:14px 16px}
.dws_index{box-sizing:border-box;flex:none;width:24px;height:24px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);display:grid;place-items:center;font-size:12px;font-variant-numeric:tabular-nums;line-height:1}
.dws_sourceEnabled .dws_index{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dws_sourceCopy{min-width:0;flex:1}
.dws_sourceTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dws_sourceDescription{max-width:610px;margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dws_sourceBody{display:flex;flex-direction:column;gap:12px;padding:0 16px 16px 52px}
.dws_sourceBodyCompact{padding-top:0}
.dws_grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.dws_field,.dws_timeout{display:flex;flex-direction:column;gap:6px}
.dws_label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dws_input{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 12px;font:inherit;font-size:14px;line-height:22px;outline:none}
.dws_input:focus-visible{border-color:var(--dsw-alias-border-l4);box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover)}
.dws_input:disabled{cursor:default;opacity:.5}
.dws_hint{margin:0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.dws_keyState{border-radius:6px;padding:1px 6px;font-size:11px;font-weight:500;line-height:16px}
.dws_keySet{background:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-state-success-primary)}
.dws_keyMissing{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-caption)}
.dws_inlineActions{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dws_testRow{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.dws_testCopy{min-width:0;display:flex;flex-direction:column;gap:2px}
.dws_testLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dws_testHint,.dws_testResult{overflow-wrap:anywhere;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.dws_testResultOk{color:var(--dsw-alias-state-success-primary)}
.dws_testResultErr{color:var(--dsw-alias-state-error-primary)}
.dws_testButton{flex:none;white-space:nowrap}
.dws_switch{position:relative;flex:none;width:36px;height:22px;margin-top:1px;cursor:pointer}
.dws_switch input{position:absolute;width:1px;height:1px;opacity:0}
.dws_switchTrack{position:absolute;inset:0;border-radius:11px;background:var(--dsw-alias-border-l3);transition:background-color .16s ease}
.dws_switchTrack:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .16s cubic-bezier(.2,.8,.2,1)}
.dws_switch input:checked+.dws_switchTrack{background:var(--dsw-alias-button-primary-fill)}
.dws_switch input:checked+.dws_switchTrack:after{transform:translateX(14px)}
.dws_switch input:focus-visible+.dws_switchTrack{box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover),0 0 0 3px var(--dsw-alias-border-l4)}
.dws_switch input:disabled+.dws_switchTrack{opacity:.45}
.dws_timeout{width:180px}
.dws_timeoutSelect{width:180px}
.dws_actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:36px}
.dws_status,.dws_notice{margin-right:auto;font-size:12px;line-height:18px}
.dws_statusOk{color:var(--dsw-alias-state-success-primary)}
.dws_statusErr{color:var(--dsw-alias-state-error-primary)}
.dws_notice{color:var(--dsw-alias-state-warn-label)}
.dws_primary,.dws_secondary,.dws_textButton{box-sizing:border-box;height:36px;border-radius:18px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:background-color .16s ease,transform .08s ease}
.dws_primary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dws_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dws_secondary{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.dws_secondary:hover:not(:disabled),.dws_textButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dws_textButton{height:28px;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px;font-size:12px}
.dws_primary:active:not(:disabled),.dws_secondary:active:not(:disabled),.dws_textButton:active:not(:disabled){transform:scale(.98)}
.dws_primary:disabled,.dws_secondary:disabled,.dws_textButton:disabled{cursor:default;opacity:.4}
.dws_skeleton{display:flex;flex-direction:column;gap:10px;padding:14px 0}
.dws_skeleton span{height:76px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);animation:dws-pulse 1.4s ease-in-out infinite alternate}
.dws_skeleton span:nth-child(2){animation-delay:.12s}.dws_skeleton span:nth-child(3){animation-delay:.24s}
.dws_messageRoot{position:fixed;z-index:10000;top:20px;left:50%;width:min(420px,calc(100vw - 32px));pointer-events:none;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px}
.dws_message{box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px;line-height:20px}
@keyframes dws-pulse{from{opacity:.5}to{opacity:1}}
@media (width<=640px){.dws_grid{grid-template-columns:minmax(0,1fr)}.dws_sourceHeader{padding:12px}.dws_sourceBody{padding:0 12px 14px 48px}.dws_testRow{align-items:stretch;flex-direction:column;gap:8px}.dws_testButton{width:100%}.dws_actions{flex-wrap:wrap}.dws_status,.dws_notice{width:100%;margin-right:0}.dws_actions .dws_primary{width:100%}.dws_timeout,.dws_timeoutSelect{width:100%}}
@media (prefers-reduced-motion:reduce){.dws_switchTrack,.dws_switchTrack:after,.dws_primary,.dws_secondary,.dws_textButton{transition:none}.dws_skeleton span{animation:none}}
`

const style = document.createElement('style')
style.dataset.plugin = 'dsh-desktop-web-search'
style.dataset.pluginCss = 'dsh-desktop-web-search/settings'
style.textContent = css
document.head.appendChild(style)
