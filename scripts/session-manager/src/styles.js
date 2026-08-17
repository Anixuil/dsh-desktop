// dsh-desktop-session-manager — settings-section stylesheet.
//
// Visual language mirrors the existing settings sections (ui-settings-models
// ModelsSection.module.css): same section geometry, row cards, tags, pill
// buttons and confirm-dialog chroma, so the page reads as native settings UI.
const css = `
.smx_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.smx_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.smx_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.smx_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}
.smx_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.smx_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}
.smx_groupTitle{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.4px;margin:14px 2px 6px}
.smx_rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}
.smx_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:8px;padding:12px 14px;display:flex}
.smx_rowHead{align-items:center;gap:10px;display:flex}
.smx_rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}
.smx_rowName{color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border:none;padding:0;font-size:14px;font-weight:500;line-height:22px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
.smx_rowName:hover{text-decoration:underline}
.smx_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.smx_rowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smx_rowActions{align-items:center;gap:4px;margin-left:auto;flex:none;display:inline-flex}
.smx_secondaryButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;justify-content:center;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}
.smx_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.smx_dangerButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;justify-content:center;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}
.smx_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.smx_secondaryButton:disabled,.smx_dangerButton:disabled{opacity:.4;cursor:default}
.smx_footerButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.smx_footerCancel{color:var(--dsw-alias-label-secondary);background:0 0}
.smx_footerCancel:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.smx_footerDanger{background:var(--dsw-alias-state-error-primary);color:#fff}
.smx_footerDanger:hover:not(:disabled){filter:brightness(1.08)}
.smx_footerButton:disabled{opacity:.4;cursor:default}
`;

const TAG_ID = '@deepseek-ai/dsh-desktop-session-manager/section.css';

/** Install the stylesheet exactly once per document. */
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-desktop-session-manager';
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

module.exports = { ensureStyles };
