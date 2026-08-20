// dsh-desktop-session-manager — sidebar session-delete patch.
//
// Upstream's workspace browser (`@deepseek-ai/dsh-client-ui-workspace`) renders
// the sidebar Session rows and only offers Rename / Fork / Archive (upstream
// README lists "no session deletion or unarchive control" as a known gap).
// The desktop owns a hard-delete backend (`/desktop-sessions/delete`), so this
// module idempotently patches the SERVED client bundle to add a danger
// "永久删除" row-menu entry that confirms in a modal and runs that endpoint.
//
// The bundle is generated, minified-per-source (tabs, no newlines within
// statements) and versioned by upstream; every edit is anchored on a verbatim
// upstream fragment and the whole patch is applied atomically — if ANY anchor
// is missing (a future dsh build reshaped the bundle), NOTHING is written and
// the caller logs a degraded note, mirroring the settings-nav-icon patch in the
// Rust shell. A marker comment guarantees idempotence across boots and after
// each dsh kernel update (the host plugin re-runs on every boot).
//
// The client side talks to the desktop's own host route (same origin), then
// clears the selection when the deleted session was current and refreshes the
// runtime baseline so the row disappears from every grouping surface.

export const WORKSPACE_BUNDLE_ID = '@deepseek-ai/dsh-client-ui-workspace';

/** Marker comment inserted with the row-menu entry; its presence means patched. */
export const WORKSPACE_DELETE_MARKER = 'dsh-desktop-session-delete';

// ——— verbatim upstream fragments (fetched from the shipped bundle) ———
const T = '\t';

// The pre-fix delete selector dropped the title argument, which surfaced the
// session name as "undefined" in the confirm modal. Both literals are kept so
// an already-patched bundle (marker present, buggy selector) can be upgraded
// in place without needing a pristine upstream copy.
const DELETE_SELECT_BUGGY = `${T.repeat(9)}if (id === "delete") onDelete(node.id);`;
const DELETE_SELECT_FIXED = `${T.repeat(9)}if (id === "delete") onDelete(node.id, row.title);`;

// 1. Session row menu: append the danger entry after the archive item.
const MENU_TAIL_ANCHOR = [
  `${T.repeat(5)}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })`,
  `${T.repeat(4)}}`,
  `${T.repeat(3)}];`,
].join('\n');
const MENU_TAIL_INSERT = [
  `${T.repeat(5)}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })`,
  `${T.repeat(4)}},`,
  `${T.repeat(4)}/* ${WORKSPACE_DELETE_MARKER}: permanent-delete entry for session rows. */`,
  `${T.repeat(4)}{`,
  `${T.repeat(5)}id: "delete",`,
  `${T.repeat(5)}label: t("menu.deleteSession"),`,
  `${T.repeat(5)}icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),`,
  `${T.repeat(5)}danger: true`,
  `${T.repeat(4)}}`,
  `${T.repeat(3)}];`,
].join('\n');

// 2. Row menu onSelect: route the new id.
const SELECT_ANCHOR = [
  `${T.repeat(8)}onSelect: (id) => {`,
  `${T.repeat(9)}setMenuOpen(false);`,
  `${T.repeat(9)}if (id === "rename") onRename(node.id, row.title);`,
  `${T.repeat(9)}if (id === "fork") onFork(node.id);`,
  `${T.repeat(9)}if (id === "archive") onArchive(node.id);`,
  `${T.repeat(8)}},`,
].join('\n');
const SELECT_INSERT = [
  `${T.repeat(8)}onSelect: (id) => {`,
  `${T.repeat(9)}setMenuOpen(false);`,
  `${T.repeat(9)}if (id === "rename") onRename(node.id, row.title);`,
  `${T.repeat(9)}if (id === "fork") onFork(node.id);`,
  `${T.repeat(9)}if (id === "archive") onArchive(node.id);`,
  DELETE_SELECT_FIXED,
  `${T.repeat(8)}},`,
].join('\n');

// 3. SessionNodeItem signature: accept the delete handler.
const ROW_SIG_ANCHOR = 'function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {';
const ROW_SIG_INSERT = 'function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onDelete, drag, flat = false, t }) {';

// 4. SessionTree / FlatList signatures: thread the handler down.
const TREE_SIG_ANCHOR = 'function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive,';
const TREE_SIG_INSERT = 'function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, onSessionDelete,';
const FLAT_SIG_ANCHOR = 'function FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive,';
const FLAT_SIG_INSERT = 'function FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, onSessionDelete,';

// 5. Both SessionNodeItem call sites forward it (grouped tree sits deeper
//    than the flat list, so each keeps its own verbatim indentation).
const CALL_TREE_ANCHOR = [
  `${T.repeat(11)}onRename: onSessionRename,`,
  `${T.repeat(11)}onFork: forkSession,`,
  `${T.repeat(11)}onArchive: onSessionArchive,`,
].join('\n');
const CALL_TREE_INSERT = [
  `${T.repeat(11)}onRename: onSessionRename,`,
  `${T.repeat(11)}onFork: forkSession,`,
  `${T.repeat(11)}onArchive: onSessionArchive,`,
  `${T.repeat(11)}onDelete: onSessionDelete,`,
].join('\n');
const CALL_FLAT_ANCHOR = [
  `${T.repeat(7)}onRename: onSessionRename,`,
  `${T.repeat(7)}onFork: forkSession,`,
  `${T.repeat(7)}onArchive: onSessionArchive,`,
].join('\n');
const CALL_FLAT_INSERT = [
  `${T.repeat(7)}onRename: onSessionRename,`,
  `${T.repeat(7)}onFork: forkSession,`,
  `${T.repeat(7)}onArchive: onSessionArchive,`,
  `${T.repeat(7)}onDelete: onSessionDelete,`,
].join('\n');

// 6. WorkspaceBrowser root: destructure the injected actions.
const ROOT_SIG_ANCHOR = 'function WorkspaceBrowser({ wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore,';
const ROOT_SIG_INSERT = 'function WorkspaceBrowser({ wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, deleteSession, clearCurrent, refreshSessions, insertSessionBefore,';

// 7. Root: live current id for the "deleted the open session" case.
const CURRENT_ANCHOR = `${T.repeat(3)}const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);`;
const CURRENT_INSERT = [
  `${T.repeat(3)}const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);`,
  `${T.repeat(3)}const currentSessionId = useSessions((s) => s.current);`,
].join('\n');

// 8. Root: delete-confirm state + handlers, after the archive handler.
const HANDLERS_ANCHOR = [
  `${T.repeat(3)}const onSessionArchive = (sessionId) => {`,
  `${T.repeat(4)}archiveSession(sessionId).catch((reason) => {`,
  `${T.repeat(5)}console.warn("session archive rejected:", reason);`,
  `${T.repeat(4)}});`,
  `${T.repeat(3)}};`,
].join('\n');
const HANDLERS_INSERT = [
  `${T.repeat(3)}const onSessionArchive = (sessionId) => {`,
  `${T.repeat(4)}archiveSession(sessionId).catch((reason) => {`,
  `${T.repeat(5)}console.warn("session archive rejected:", reason);`,
  `${T.repeat(4)}});`,
  `${T.repeat(3)}};`,
  `${T.repeat(3)}const [sessionDeleteTarget, setSessionDeleteTarget] = (0, react.useState)(null);`,
  `${T.repeat(3)}const [sessionDeleting, setSessionDeleting] = (0, react.useState)(false);`,
  `${T.repeat(3)}const [sessionDeleteError, setSessionDeleteError] = (0, react.useState)(null);`,
  `${T.repeat(3)}const onSessionDelete = (sessionId, title) => {`,
  `${T.repeat(4)}setSessionDeleteTarget({ sessionId, title });`,
  `${T.repeat(4)}setSessionDeleteError(null);`,
  `${T.repeat(3)}};`,
  `${T.repeat(3)}const closeSessionDelete = () => {`,
  `${T.repeat(4)}if (sessionDeleting) return;`,
  `${T.repeat(4)}setSessionDeleteTarget(null);`,
  `${T.repeat(4)}setSessionDeleteError(null);`,
  `${T.repeat(3)}};`,
  `${T.repeat(3)}const confirmSessionDelete = () => {`,
  `${T.repeat(4)}/* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */`,
  `${T.repeat(4)}if (sessionDeleting || sessionDeleteTarget === null) return;`,
  `${T.repeat(4)}setSessionDeleting(true);`,
  `${T.repeat(4)}setSessionDeleteError(null);`,
  `${T.repeat(4)}deleteSession(sessionDeleteTarget.sessionId).then(() => {`,
  `${T.repeat(5)}setSessionDeleting(false);`,
  `${T.repeat(5)}setSessionDeleteTarget(null);`,
  `${T.repeat(5)}if (currentSessionId === sessionDeleteTarget.sessionId) clearCurrent();`,
  `${T.repeat(5)}refreshSessions();`,
  `${T.repeat(4)}}).catch((reason) => {`,
  `${T.repeat(5)}setSessionDeleting(false);`,
  `${T.repeat(5)}setSessionDeleteError(reason instanceof Error ? reason.message : String(reason));`,
  `${T.repeat(4)}});`,
  `${T.repeat(3)}};`,
].join('\n');

// 9. Root render: pass the handler into both surfaces.
const RENDER_ANCHOR = [
  `${T.repeat(7)}onSessionRename,`,
  `${T.repeat(7)}onSessionArchive,`,
].join('\n');
const RENDER_INSERT = [
  `${T.repeat(7)}onSessionRename,`,
  `${T.repeat(7)}onSessionArchive,`,
  `${T.repeat(7)}onSessionDelete,`,
].join('\n');

// 10. injected share: the hard-delete RPC + selection/lifecycle helpers.
const SHARE_ANCHOR = [
  `${T.repeat(4)}archiveSession: async (sessionId) => {`,
  `${T.repeat(5)}await ctx.workspaces.archiveSession(sessionId);`,
  `${T.repeat(4)}},`,
].join('\n');
const SHARE_INSERT = [
  `${T.repeat(4)}archiveSession: async (sessionId) => {`,
  `${T.repeat(5)}await ctx.workspaces.archiveSession(sessionId);`,
  `${T.repeat(4)}},`,
  `${T.repeat(4)}deleteSession: async (sessionId) => {`,
  `${T.repeat(5)}const resp = await fetch("/desktop-sessions/delete", {`,
  `${T.repeat(6)}method: "POST",`,
  `${T.repeat(6)}headers: { "content-type": "application/json" },`,
  `${T.repeat(6)}body: JSON.stringify({ id: sessionId })`,
  `${T.repeat(5)}});`,
  `${T.repeat(5)}let payload = null;`,
  `${T.repeat(5)}try { payload = await resp.json(); } catch { /* non-JSON body */ }`,
  `${T.repeat(5)}if (!resp.ok || payload === null || payload.ok !== true) {`,
  `${T.repeat(6)}throw new Error(payload?.error ?? \`删除会话失败 (HTTP ${'${resp.status}'})\`);`,
  `${T.repeat(5)}}`,
  `${T.repeat(4)}},`,
  `${T.repeat(4)}clearCurrent: () => {`,
  `${T.repeat(5)}ctx.sessions.clear();`,
  `${T.repeat(4)}},`,
  `${T.repeat(4)}refreshSessions: () => {`,
  `${T.repeat(5)}void ctx.sessions.refresh();`,
  `${T.repeat(4)}},`,
].join('\n');

// 11. Locale keys (zh source of truth + en mirror), appended after the menu set.
const ZH_ANCHOR = `${T.repeat(3)}"menu.archiveSession": "归档会话",`;
const ZH_INSERT = [
  `${T.repeat(3)}"menu.archiveSession": "归档会话",`,
  `${T.repeat(3)}"menu.deleteSession": "永久删除",`,
  `${T.repeat(3)}"delete.session.title": "永久删除会话？",`,
  `${T.repeat(3)}"delete.session.desc": "将永久删除“{name}”及其全部消息记录和派生缓存，此操作不可恢复。",`,
  `${T.repeat(3)}"delete.session.pending": "正在删除会话…",`,
  `${T.repeat(3)}"delete.session.confirm": "永久删除",`,
].join('\n');
const EN_ANCHOR = `${T.repeat(3)}"menu.archiveSession": "Archive session",`;
const EN_INSERT = [
  `${T.repeat(3)}"menu.archiveSession": "Archive session",`,
  `${T.repeat(3)}"menu.deleteSession": "Delete permanently",`,
  `${T.repeat(3)}"delete.session.title": "Permanently delete session?",`,
  `${T.repeat(3)}"delete.session.desc": "This permanently deletes “{name}” with all of its messages and derived data. This cannot be undone.",`,
  `${T.repeat(3)}"delete.session.pending": "Deleting session…",`,
  `${T.repeat(3)}"delete.session.confirm": "Delete permanently",`,
].join('\n');

// 12. The confirmation modal, appended after the workspace-delete modal.
const MODAL_ANCHOR = [
  `${T.repeat(6)}children: [deleting && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.deleteStatus,`,
  `${T.repeat(7)}role: "status",`,
  `${T.repeat(7)}children: t("delete.pending")`,
  `${T.repeat(6)}}), deleteError !== null && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.renameError,`,
  `${T.repeat(7)}role: "alert",`,
  `${T.repeat(7)}children: deleteError`,
  `${T.repeat(6)}})]`,
  `${T.repeat(5)}})`,
  `${T.repeat(4)}]`,
  `${T.repeat(3)}});`,
].join('\n');
const MODAL_INSERT = [
  `${T.repeat(6)}children: [deleting && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.deleteStatus,`,
  `${T.repeat(7)}role: "status",`,
  `${T.repeat(7)}children: t("delete.pending")`,
  `${T.repeat(6)}}), deleteError !== null && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.renameError,`,
  `${T.repeat(7)}role: "alert",`,
  `${T.repeat(7)}children: deleteError`,
  `${T.repeat(6)}})]`,
  `${T.repeat(5)}}),`,
  `${T.repeat(5)}(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {`,
  `${T.repeat(6)}open: sessionDeleteTarget !== null,`,
  `${T.repeat(6)}onClose: closeSessionDelete,`,
  `${T.repeat(6)}closeLabel: t("close"),`,
  `${T.repeat(6)}title: t("delete.session.title"),`,
  `${T.repeat(6)}...sessionDeleteTarget === null ? {} : { description: t("delete.session.desc", { name: sessionDeleteTarget.title }) },`,
  `${T.repeat(6)}footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {`,
  `${T.repeat(7)}variant: "outline",`,
  `${T.repeat(7)}disabled: sessionDeleting,`,
  `${T.repeat(7)}onClick: closeSessionDelete,`,
  `${T.repeat(7)}children: t("cancel")`,
  `${T.repeat(6)}}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {`,
  `${T.repeat(7)}variant: "outline",`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.deleteAction,`,
  `${T.repeat(7)}disabled: sessionDeleting,`,
  `${T.repeat(7)}onClick: confirmSessionDelete,`,
  `${T.repeat(7)}children: t("delete.session.confirm")`,
  `${T.repeat(6)}})] }),`,
  `${T.repeat(6)}children: [sessionDeleting && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.deleteStatus,`,
  `${T.repeat(7)}role: "status",`,
  `${T.repeat(7)}children: t("delete.session.pending")`,
  `${T.repeat(6)}}), sessionDeleteError !== null && (0, react_jsx_runtime.jsx)("div", {`,
  `${T.repeat(7)}className: WorkspaceBrowser_module_css_default.renameError,`,
  `${T.repeat(7)}role: "alert",`,
  `${T.repeat(7)}children: sessionDeleteError`,
  `${T.repeat(6)}})]`,
  `${T.repeat(5)}})`,
  `${T.repeat(4)}]`,
  `${T.repeat(3)}});`,
].join('\n');

// One verbatim-anchored replacement.
const EDITS = [
  { anchor: MENU_TAIL_ANCHOR, insert: MENU_TAIL_INSERT, name: 'row menu item' },
  { anchor: SELECT_ANCHOR, insert: SELECT_INSERT, name: 'row menu onSelect' },
  { anchor: ROW_SIG_ANCHOR, insert: ROW_SIG_INSERT, name: 'SessionNodeItem signature' },
  { anchor: TREE_SIG_ANCHOR, insert: TREE_SIG_INSERT, name: 'SessionTree signature' },
  { anchor: FLAT_SIG_ANCHOR, insert: FLAT_SIG_INSERT, name: 'FlatList signature' },
  { anchor: CALL_TREE_ANCHOR, insert: CALL_TREE_INSERT, name: 'SessionNodeItem tree call' },
  { anchor: CALL_FLAT_ANCHOR, insert: CALL_FLAT_INSERT, name: 'SessionNodeItem flat call' },
  { anchor: ROOT_SIG_ANCHOR, insert: ROOT_SIG_INSERT, name: 'WorkspaceBrowser signature' },
  { anchor: CURRENT_ANCHOR, insert: CURRENT_INSERT, name: 'current session hook' },
  { anchor: HANDLERS_ANCHOR, insert: HANDLERS_INSERT, name: 'delete handlers' },
  { anchor: RENDER_ANCHOR, insert: RENDER_INSERT, name: 'surface render props', replaceAll: true },
  { anchor: MODAL_ANCHOR, insert: MODAL_INSERT, name: 'delete confirm modal' },
  { anchor: SHARE_ANCHOR, insert: SHARE_INSERT, name: 'injected delete action' },
  { anchor: ZH_ANCHOR, insert: ZH_INSERT, name: 'zh dictionary' },
  { anchor: EN_ANCHOR, insert: EN_INSERT, name: 'en dictionary' },
];

/**
 * Apply the session-delete patch to a workspace browser bundle source.
 * Atomic: unless EVERY anchor matches exactly once (the call-site anchors
 * exactly twice), the original source is returned untouched.
 * @param source - raw bundle source.
 * @returns { source, applied, reason } — `reason` lists missing/ambiguous anchors.
 */
export function applyWorkspaceDeletePatch(source) {
  if (typeof source !== 'string') return { source, applied: false, reason: 'bundle source is not a string' };
  if (source.includes(WORKSPACE_DELETE_MARKER)) {
    // Self-heal: a bundle already carrying the marker but with the older
    // selector (missing the title arg) is upgraded in place, so existing
    // installs get the "undefined"-name fix without a pristine re-patch.
    if (source.includes(DELETE_SELECT_BUGGY) && !source.includes(DELETE_SELECT_FIXED)) {
      return { source: source.replace(DELETE_SELECT_BUGGY, DELETE_SELECT_FIXED), applied: true, reason: null };
    }
    return { source, applied: false, reason: 'already patched' };
  }

  const counts = [];
  for (const edit of EDITS) {
    const expected = edit.replaceAll === true ? 2 : 1;
    let first = 0;
    let index = -1;
    let occurrences = 0;
    while ((index = source.indexOf(edit.anchor, index + 1)) !== -1) {
      occurrences += 1;
      if (first === 0) first = index;
    }
    if (occurrences !== expected) counts.push(`${edit.name} (expected ${expected}, found ${occurrences})`);
  }
  if (counts.length > 0) return { source, applied: false, reason: `anchor mismatch: ${counts.join('; ')}` };

  let out = source;
  for (const edit of EDITS) {
    if (edit.replaceAll === true) out = out.split(edit.anchor).join(edit.insert);
    else out = out.replace(edit.anchor, edit.insert);
  }
  if (!out.includes(WORKSPACE_DELETE_MARKER) || !out.includes('deleteSession')) {
    return { source, applied: false, reason: 'patch produced no marker (internal error)' };
  }
  return { source: out, applied: true, reason: null };
}