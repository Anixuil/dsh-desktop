// dsh-desktop-change-history — shared stylesheet.
//
// Styled entirely through the DeepSeek web tokens (`--dsw-*`) so the change
// history surfaces follow the same design language as the shipped settings,
// tool rows, and panels. Injected once at section/row/viewer mount (idempotent
// via a marker id).
const STYLE_ID = 'dsh-desktop-change-history-styles'

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
/* ——— settings section ——— */
.chx_section { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.chx_title { font-size: 18px; font-weight: 600; margin: 0; }
.chx_intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.chx_error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; }
.chx_savedNotice { margin: 0; color: var(--dsw-alias-state-success-primary); font-size: 13px; line-height: 20px; }
.chx_group { display: flex; flex-direction: column; gap: 8px; }
.chx_groupTitle { margin: 4px 0 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.chx_rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.chx_rowCard { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-base); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.chx_rowHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.chx_rowIdentity { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.chx_rowPath { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 13px; line-height: 20px; word-break: break-all; }
.chx_rowMeta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.chx_tag { border-radius: 6px; padding: 1px 7px; font-size: 11px; line-height: 16px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.chx_filter { display: flex; flex-direction: column; gap: 4px; }
.chx_filterLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.chx_select { max-width: 320px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }

/* ——— settings action buttons ——— */
.chx_dangerButton { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 5px 12px; font-size: 12px; line-height: 18px; cursor: pointer; }
.chx_dangerButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.chx_dangerButton:disabled { opacity: 0.5; cursor: default; }
.chx_footerButton { border-radius: 8px; padding: 6px 14px; font-size: 13px; line-height: 20px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.chx_footerButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.chx_footerDanger { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.chx_footerDanger:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.chx_footerDanger:disabled { opacity: 0.6; cursor: default; }

/* ——— inline mutation row ——— */
.chx_mutationRow { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; color: var(--dsw-alias-label-primary); }
.chx_mutationHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.chx_mutationTag { flex: none; font-size: 12px; font-weight: 600; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.chx_mutationPath { flex: auto; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 13px; line-height: 20px; text-align: left; background: none; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: underline; text-decoration-color: var(--dsw-alias-label-quaternary, var(--dsw-alias-label-caption)); text-underline-offset: 3px; }
.chx_mutationPath:hover { color: var(--dsw-alias-label-primary); text-decoration-color: currentColor; }
.chx_mutationDone { flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
.chx_mutationError { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.chx_mutationActions { display: flex; gap: 8px; align-items: center; }

/* Semantic tints layered onto primitives.Button (ghost/outline). */
.chx_actionDanger, .chx_actionDanger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.chx_actionDanger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.chx_actionReviewed, .chx_actionReviewed:not(:disabled) { color: var(--dsw-alias-state-success-primary); }

/* ——— built-in side file viewer ——— */
.chx_viewerBackdrop { --chx-ease-out: cubic-bezier(0.23, 1, 0.32, 1); --chx-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); position: fixed; inset: 0; z-index: 90; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, 0.32); opacity: 1; pointer-events: auto; transition: opacity 180ms var(--chx-ease-out); }
.chx_viewerPanel { position: relative; box-sizing: border-box; height: 100%; width: min(560px, calc(100vw - 48px)); min-width: min(360px, calc(100vw - 48px)); max-width: calc(100vw - 48px); background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-shadow-lv3); display: flex; flex-direction: column; overflow: hidden; opacity: 1; transform: translateX(0); will-change: transform; transition: transform 240ms var(--chx-ease-drawer); }
.chx_viewerBackdrop.is-closing { opacity: 0; pointer-events: none; }
.chx_viewerBackdrop.is-closing .chx_viewerPanel { transform: translateX(100%); }
@starting-style { .chx_viewerBackdrop { opacity: 0; } .chx_viewerPanel { transform: translateX(100%); } }
.chx_viewerResizeHandle { position: absolute; z-index: 1; inset: 0 auto 0 -5px; width: 10px; cursor: col-resize; touch-action: none; outline: none; }
.chx_viewerResizeHandle::after { content: ""; position: absolute; inset: 0 auto 0 4px; width: 2px; background: var(--dsw-alias-state-business-primary); opacity: 0; transition: opacity 120ms ease; }
.chx_viewerResizeHandle:hover::after, .chx_viewerResizeHandle:focus-visible::after, .chx_viewerPanel.is-resizing .chx_viewerResizeHandle::after { opacity: 1; }
.chx_viewerResizeHandle:focus-visible::after { box-shadow: 0 0 0 1px var(--dsw-alias-bg-base); }
.chx_viewerPanel.is-resizing, .chx_viewerPanel.is-resizing * { user-select: none; }
html.chx_viewerResizing, html.chx_viewerResizing * { cursor: col-resize !important; }
.chx_viewerHeader { box-sizing: border-box; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); flex: none; justify-content: space-between; align-items: center; gap: 8px; min-height: 48px; padding: 8px 12px; display: flex; }
.chx_viewerTitle { min-width: 0; align-items: center; gap: 8px; display: flex; }
.chx_viewerTitleIcon { color: var(--dsw-alias-state-business-primary); flex: none; display: inline-flex; }
.chx_viewerPath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 18px; }
.chx_viewerActions { flex: none; align-items: center; gap: 2px; display: flex; }
.chx_viewerIconBtn { width: 26px; height: 26px; color: var(--dsw-alias-label-tertiary); cursor: pointer; background: 0 0; border: none; border-radius: 999px; justify-content: center; align-items: center; padding: 0; display: inline-flex; }
.chx_viewerIconBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.chx_viewerIconBtn:disabled { opacity: 0.45; cursor: default; }
.chx_viewerBody { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; background: var(--dsw-alias-markdown-code-block); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.chx_viewerNotice { padding: 10px 14px; color: var(--dsw-alias-state-warn-label); border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-base); }
.chx_viewerLoading, .chx_viewerError { padding: 22px 16px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.chx_viewerError { color: var(--dsw-alias-state-error-primary); }
.chx_viewerLines { box-sizing: border-box; width: 100%; min-width: 0; margin: 0; padding: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 18px; }
.chx_viewerLine { display: grid; grid-template-columns: 62px minmax(0, 1fr); min-width: 0; }
.chx_viewerLine:hover { background: var(--dsw-alias-interactive-bg-hover); }
.chx_viewerGutter { text-align: right; color: var(--dsw-alias-label-caption); padding-right: 16px; user-select: none; }
.chx_viewerText { min-width: 0; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; padding-right: 20px; }
.chx_viewerFooter { box-sizing: border-box; border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); flex: none; align-items: center; gap: 14px; min-height: 30px; padding: 6px 12px; display: flex; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px; }
.chx_viewerMeta { flex: none; display: inline-flex; align-items: center; gap: 4px; }

/* ——— per-turn approval workspace ——— */
.chx_turnSummary { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); margin-top: 14px; padding: 10px 12px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; }
.chx_turnSummaryLead { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.chx_turnSummaryLead span, .chx_turnSummaryFiles { color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 18px; }
.chx_turnSummaryFiles { grid-column: 1 / 2; display: flex; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; }
.chx_turnSummaryFiles span { overflow: hidden; text-overflow: ellipsis; }
.chx_turnSummaryActions { grid-row: 1 / 3; grid-column: 2; display: flex; gap: 6px; }
.chx_approvalBackdrop { position: fixed; inset: 0; z-index: 95; padding: 32px; background: rgba(0, 0, 0, 0.52); display: flex; justify-content: center; align-items: center; }
.chx_approvalPanel { width: min(1180px, 100%); height: min(760px, 100%); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-shadow-lv3); display: flex; flex-direction: column; overflow: hidden; }
.chx_approvalHeader { min-height: 58px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.chx_approvalTitle { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 22px; font-weight: 600; }
.chx_approvalMeta { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.chx_approvalHeaderActions, .chx_approvalFileActions { display: flex; align-items: center; gap: 8px; }
.chx_approvalContent { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(220px, 30%) minmax(0, 1fr); }
.chx_approvalList { overflow: auto; border-right: 1px solid var(--dsw-alias-border-l2); padding: 6px; display: flex; flex-direction: column; gap: 3px; }
.chx_approvalFile { width: 100%; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 7px 8px; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; }
.chx_approvalFile:hover, .chx_approvalFile.is-selected { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.chx_approvalFile:focus-visible, .chx_approvalFileActions button:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 1px; }
.chx_approvalFileName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 18px; }
.chx_approvalFileStats { grid-column: 1 / 2; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.chx_approvalStatus { align-self: center; border-radius: 5px; padding: 1px 5px; font-size: 10px; line-height: 15px; background: var(--dsw-alias-interactive-bg-hover); }
.chx_approvalStatus.is-approved { color: var(--dsw-alias-state-success-primary); }
.chx_approvalStatus.is-rejected { color: var(--dsw-alias-state-error-primary); }
.chx_approvalStatus.is-pending { color: var(--dsw-alias-state-warn-label); }
.chx_approvalDiff { min-width: 0; overflow: auto; padding: 12px; background: var(--dsw-alias-markdown-code-block); }
.chx_approvalFileHead { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.chx_approvalDisabled { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.chx_approvalEmpty { margin: auto; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
@media (max-width: 720px) { .chx_viewerPanel { width: 100% !important; min-width: 0; max-width: 100%; } .chx_viewerResizeHandle { display: none; } }
@media (max-width: 720px) { .chx_approvalBackdrop { padding: 10px; } .chx_approvalContent { grid-template-columns: 1fr; grid-template-rows: minmax(140px, 32%) minmax(0, 1fr); } .chx_approvalList { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); } .chx_turnSummary { grid-template-columns: 1fr; } .chx_turnSummaryActions { grid-row: auto; grid-column: 1; } }
@media (prefers-reduced-motion: reduce) { .chx_viewerResizeHandle::after { transition: none; } .chx_viewerBackdrop { transition: opacity 140ms var(--chx-ease-out); } .chx_viewerPanel { transform: none; will-change: opacity; transition: opacity 140ms var(--chx-ease-out); } .chx_viewerBackdrop.is-closing .chx_viewerPanel { opacity: 0; transform: none; } @starting-style { .chx_viewerBackdrop { opacity: 0; } .chx_viewerPanel { opacity: 0; transform: none; } } }
`
  document.head.appendChild(style)
}

module.exports = { ensureStyles }
