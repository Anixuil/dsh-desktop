const STYLE_ID = 'dsh-desktop-conversation-navigator-styles'

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-desktop-conversation-navigator'
  style.textContent = `
.dcn_root{box-sizing:border-box;width:28px;position:absolute;z-index:9;pointer-events:auto}
.dcn_scroller{box-sizing:border-box;width:28px;height:100%;padding:2px 0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none}
.dcn_scroller::-webkit-scrollbar{display:none}
.dcn_list{list-style:none;width:28px;min-height:100%;margin:0;padding:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px}
.dcn_item{width:28px;height:18px;margin:0;padding:0;display:flex;align-items:center;justify-content:flex-start}
.dcn_tick{box-sizing:border-box;width:28px;height:18px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer;display:flex;align-items:center;justify-content:flex-start}
.dcn_tickLine{display:block;width:12px;height:1.5px;border-radius:2px;background:currentColor;opacity:.62;transform-origin:left center;transition:width .12s cubic-bezier(.16,1,.3,1),height .12s cubic-bezier(.16,1,.3,1),opacity .12s ease,color .12s ease}
.dcn_tick:hover{color:var(--dsw-alias-label-secondary)}
.dcn_tick:hover .dcn_tickLine,.dcn_tick:focus-visible .dcn_tickLine{width:18px;opacity:1}
.dcn_tick[aria-current=location]{color:var(--dsw-alias-state-business-primary)}
.dcn_tick[aria-current=location] .dcn_tickLine{width:22px;height:2px;opacity:1}
.dcn_tick:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:1px}
.dcn_tick:active .dcn_tickLine{transform:scaleX(.92)}
.dcn_load{color:var(--dsw-alias-label-tertiary)}
.dcn_load .dcn_tickLine{width:8px;box-shadow:0 -4px 0 currentColor,0 4px 0 currentColor}
.dcn_load:disabled{cursor:default;opacity:.46}
.dcn_preview{box-sizing:border-box;width:min(320px,calc(100vw - 56px));padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2);pointer-events:none;position:absolute;left:34px;opacity:1;transform:translateY(0);transition:opacity .12s ease,transform .12s cubic-bezier(.16,1,.3,1)}
.dcn_previewTitle{font:var(--dsw-font-s-strong-14);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dcn_previewSummary{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:19px;margin-top:4px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.dcn_tickLine,.dcn_preview{transition:none}.dcn_tick:active .dcn_tickLine{transform:none}}
`
  document.head.appendChild(style)
}

module.exports = { ensureStyles, STYLE_ID }
