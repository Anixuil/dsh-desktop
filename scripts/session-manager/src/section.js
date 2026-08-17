// dsh-desktop-session-manager — settings section UI.
//
// Renders as a native settings page (registered on `settings.section`, the
// same seat the Models/General sections use): title + intro, then two row-card
// groups — 已归档 (restore / delete) and 全部会话 (open / delete) — plus the
// delete confirmation over primitives/Modal. Visual language mirrors
// ui-settings-models' ModelsSection (section geometry, row cards, tags, pill
// buttons). A `manager` prop override keeps the render tree fixture-testable;
// in production the hook owns the list state.
const { createElement: el, Fragment, useEffect, useState, useSyncExternalStore } = require('react');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { useSessionManager } = require('./use-session-manager.js');
const { ensureStyles } = require('./styles.js');

const MAX_ALL_ROWS = 50;
const noopSub = () => () => {};

function fmtDate(ms) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTokens(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** One session row card: identity + meta line + contextual actions. */
function SessionRow({ row, current, busy, onOpen, onDelete, onRestore, t }) {
  const archived = row.archived === true;
  const title = row.title || t('row.meta.untitled');
  const metaBits = [];
  const date = fmtDate(row.createdAt);
  metaBits.push(date ?? t('row.meta.noDate'));
  if (row.tokens !== null && row.tokens !== undefined) metaBits.push(t('row.meta.tokens', { tokens: fmtTokens(row.tokens.total ?? row.tokens) }));
  if (typeof row.turns === 'number') metaBits.push(t('row.meta.turns', { count: row.turns }));

  return el(
    'li',
    { className: 'smx_rowCard' },
    el(
      'div',
      { className: 'smx_rowHead' },
      el(
        'div',
        { className: 'smx_rowIdentity' },
        el('button', { type: 'button', className: 'smx_rowName', title: t('row.open'), onClick: () => onOpen(row.id) }, title),
        current ? el('span', { className: 'smx_rowTag' }, t('row.current')) : null,
      ),
      el(
        'div',
        { className: 'smx_rowActions' },
        archived
          ? el('button', { type: 'button', className: 'smx_secondaryButton', disabled: busy, onClick: () => onRestore(row.id) }, t('row.restore'))
          : null,
        el(
          'button',
          {
            type: 'button',
            className: 'smx_dangerButton',
            disabled: busy || current,
            onClick: () => onDelete(row),
          },
          t('row.delete'),
        ),
      ),
    ),
    el('div', { className: 'smx_rowMeta' }, metaBits.join(' · ')),
  );
}

/** Delete confirmation over primitives/Modal with settings-style footer buttons. */
function ConfirmModal({ target, busy, onCancel, onConfirm, t }) {
  return el(
    primitives.Modal,
    {
      open: target !== null,
      onClose: onCancel,
      title: t('confirm.title'),
      closeLabel: t('confirm.cancel'),
      description: target !== null ? t('confirm.desc', { title: target.title || t('row.meta.untitled') }) : undefined,
      footer: el(
        Fragment,
        null,
        el('button', { type: 'button', className: 'smx_footerButton smx_footerCancel', onClick: onCancel, disabled: busy }, t('confirm.cancel')),
        el('button', { type: 'button', className: 'smx_footerButton smx_footerDanger', onClick: onConfirm, disabled: busy }, busy ? t('confirm.busy') : t('confirm.ok')),
      ),
    },
    null,
  );
}

/** The settings page. `manager` overrides the hook for fixture tests. */
function SessionManagerSection(props) {
  const { t, sessions, workspaces, close, manager: managerOverride } = props;
  const hookManager = useSessionManager(workspaces);
  const manager = managerOverride ?? hookManager;
  const { sessions: rows, loading, error, busyId, notice, remove, unarchive, clearNotice, archivedCount } = manager;
  const [confirmTarget, setConfirmTarget] = useState(null);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => clearNotice(), 2500);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  const snapshot = useSyncExternalStore(
    (fn) => (sessions?.list?.subscribe ?? noopSub)(fn),
    () => sessions?.list?.getSnapshot?.() ?? null,
    () => null,
  );
  const currentId = snapshot?.current ?? null;

  const openSession = (id) => {
    try {
      sessions?.open?.(id);
    } catch {
      /* the app's own state surfaces the failure */
    }
    close();
  };

  const confirmDelete = async () => {
    if (confirmTarget === null) return;
    const ok = await remove(confirmTarget.id);
    if (ok) setConfirmTarget(null);
  };

  const archivedRows = rows.filter((row) => row.archived);
  const activeRows = rows.filter((row) => !row.archived).slice(0, MAX_ALL_ROWS);
  const capped = rows.filter((row) => !row.archived).length > MAX_ALL_ROWS;

  const group = (heading, list, emptyKey) =>
    el(
      Fragment,
      null,
      el('p', { className: 'smx_groupTitle' }, heading),
      list.length === 0
        ? el('p', { className: 'smx_intro' }, t(emptyKey))
        : el(
            'ul',
            { className: 'smx_rows' },
            list.map((row) =>
              el(SessionRow, {
                key: row.id,
                row,
                current: row.id === currentId,
                busy: busyId === row.id,
                onOpen: openSession,
                onDelete: (target) => setConfirmTarget(target),
                onRestore: (id) => void unarchive(id),
                t,
              }),
            ),
          ),
    );

  return el(
    'div',
    { className: 'smx_section' },
    el('h2', { className: 'smx_title' }, t('title')),
    el('p', { className: 'smx_intro' }, t('intro', { count: rows.length, archived: archivedCount })),
    error !== null
      ? el('p', { className: 'smx_error' }, t('error.load', { error: String(error?.message ?? error) }))
      : null,
    notice !== null
      ? el('p', { className: 'smx_savedNotice', role: 'status', 'aria-live': 'polite' }, notice.kind === 'deleted' ? t('status.deleted') : t('status.restored'))
      : null,
    loading
      ? el('p', { className: 'smx_intro' }, t('loading'))
      : el(
          Fragment,
          null,
          group(t('group.archived'), archivedRows, 'group.archived.none'),
          group(t('group.all'), activeRows, 'group.all.none'),
          capped ? el('p', { className: 'smx_notice' }, t('capNote', { limit: MAX_ALL_ROWS })) : null,
        ),
    el(ConfirmModal, {
      target: confirmTarget,
      busy: busyId === confirmTarget?.id,
      onCancel: () => setConfirmTarget(null),
      onConfirm: confirmDelete,
      t,
    }),
  );
}

module.exports = { SessionManagerSection, SessionRow, ConfirmModal };
