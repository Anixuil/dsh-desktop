// dsh-desktop-change-history — settings section UI.
//
// Renders as a native settings page (registered on `settings.section`): a
// session-filtered timeline of every AI write/edit, each card showing the file
// path, a colored unified diff, and a revert action with a confirmation modal.
const { createElement: el, Fragment, useEffect, useState } = require('react');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { useChangeHistory } = require('./use-change-history.js');
const { ensureStyles } = require('./styles.js');
const { showMessage } = require('./message.js');

function fmtDate(ms) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function basename(path) {
  if (typeof path !== 'string' || path === '') return path;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function dirname(path) {
  if (typeof path !== 'string' || path === '') return '';
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

/** Build the primitives/DiffBlock input from a change row's before/after pair. */
function diffsOf(row) {
  const isCreate = row.operation === 'create';
  return [{ path: row.path, oldText: isCreate ? null : (row.before ?? null), newText: row.after ?? '' }];
}

/** One historical change card: identity, approval result, diff and safe revert. */
function ChangeRow({ row, busy, onRollback, onApprove, t }) {
  const isCreate = row.operation === 'create';
  const noBaseline = !isCreate && (row.before === null || row.before === undefined);
  const metaBits = [];
  metaBits.push(row.tool === 'edit' ? t('row.tool.edit') : t('row.tool.write'));
  if (row.operation === 'create') metaBits.push(t('row.created'));
  else if (row.operation === 'update') metaBits.push(t('row.updated'));
  if (row.stats && row.stats.added !== null && row.stats.removed !== null) {
    metaBits.push(t('row.diffLines', { added: row.stats.added, removed: row.stats.removed }));
  }
  const date = fmtDate(row.createdAt);
  if (date) metaBits.push(date);
  metaBits.push(t(`row.status.${row.status ?? (row.reviewed ? 'approved' : 'pending')}`));

  const rollbackLabel = noBaseline
    ? t('row.rollback.noBaseline')
    : isCreate
      ? t('row.rollback.created')
      : t('row.rollback');

  return el(
    'li',
    { className: 'chx_rowCard' },
    el(
      'div',
      { className: 'chx_rowHead' },
      el(
        'div',
        { className: 'chx_rowIdentity' },
        el('span', { className: 'chx_rowPath' }, basename(row.path)),
        el('span', { className: 'chx_rowMeta' }, dirname(row.path)),
      ),
      el('div', { className: 'chx_approvalFileActions' },
        row.status === 'pending'
          ? el('button', { type: 'button', className: 'chx_footerButton', disabled: busy, onClick: () => onApprove(row) }, t('approval.approve'))
          : null,
        row.status !== 'rejected'
          ? el('button', { type: 'button', className: 'chx_dangerButton', disabled: busy || noBaseline, onClick: () => onRollback(row) }, rollbackLabel)
          : null,
      ),
    ),
    el('div', { className: 'chx_rowMeta' }, metaBits.map((bit, i) => el('span', { key: i, className: 'chx_tag' }, bit))),
    el(primitives.DiffBlock, { diffs: diffsOf(row) }),
  );
}

/** Revert confirmation over primitives/Modal. */
function ConfirmModal({ target, busy, onCancel, onConfirm, t }) {
  const isCreate = target !== null && target.operation === 'create';
  return el(
    primitives.Modal,
    {
      open: target !== null,
      onClose: onCancel,
      title: t('confirm.title'),
      closeLabel: t('confirm.cancel'),
      description: target !== null
        ? t(isCreate ? 'confirm.desc.create' : 'confirm.desc', { path: target.path })
        : undefined,
      footer: el(
        Fragment,
        null,
        el('button', { type: 'button', className: 'chx_footerButton', onClick: onCancel, disabled: busy }, t('confirm.cancel')),
        el('button', { type: 'button', className: 'chx_footerButton chx_footerDanger', onClick: onConfirm, disabled: busy }, busy ? t('confirm.busy') : t('confirm.ok')),
      ),
    },
    null,
  );
}

/** The settings page. `manager` overrides the hook for fixture tests. */
function ChangeHistorySection(props) {
  const { t, manager: managerOverride } = props;
  const hookManager = useChangeHistory();
  const manager = managerOverride ?? hookManager;
  const { changes, groups, loading, error, busyId, notice, rollback, approve, clearNotice } = manager;
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [sessionFilter, setSessionFilter] = useState('');

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => clearNotice(), 3500);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  useEffect(() => {
    if (error !== null) showMessage(t('error.load', { error: String(error?.message ?? error) }));
  }, [error, t]);

  const confirmRollback = async () => {
    if (confirmTarget === null) return;
    const ok = await rollback(confirmTarget.id);
    if (ok) setConfirmTarget(null);
  };

  const filterOptions = groups
    .filter((group) => group.sessionId !== null && group.sessionId !== undefined)
    .map((group) => ({ id: group.sessionId, title: group.sessionTitle || group.sessionId }));

  const visibleGroups = sessionFilter === ''
    ? groups
    : groups.filter((group) => group.sessionId === sessionFilter);

  return el(
    'div',
    { className: 'chx_section' },
    el('h2', { className: 'chx_title' }, t('title')),
    el('p', { className: 'chx_intro' }, t('intro', { count: changes.length })),
    notice !== null
      ? el('p', { className: 'chx_savedNotice', role: 'status', 'aria-live': 'polite' }, t(notice.kind === 'diverged' ? 'status.diverged' : 'status.rolledBack'))
      : null,
    filterOptions.length > 0
      ? el(
          'div',
          { className: 'chx_filter' },
          el('label', { className: 'chx_filterLabel' }, t('filter.all')),
          el(
            'select',
            { className: 'chx_select', value: sessionFilter, onChange: (e) => setSessionFilter(e.target.value) },
            el('option', { value: '' }, t('filter.all')),
            filterOptions.map((opt) => el('option', { key: opt.id, value: opt.id }, opt.title)),
          ),
        )
      : null,
    loading
      ? el('p', { className: 'chx_intro' }, t('loading'))
      : visibleGroups.length === 0
        ? el('p', { className: 'chx_intro' }, t('group.none'))
        : visibleGroups.map((group) =>
            el(
              'div',
              { key: group.sessionId ?? '__none__', className: 'chx_group' },
              el('p', { className: 'chx_groupTitle' }, group.sessionTitle || group.sessionId || t('row.untitled')),
              el(
                'ul',
                { className: 'chx_rows' },
                group.changes.map((row) =>
                  el(ChangeRow, {
                    key: row.id,
                    row,
                    busy: busyId === row.id,
                    onRollback: (target) => setConfirmTarget(target),
                    onApprove: (target) => { void approve(target.id); },
                    t,
                  }),
                ),
              ),
            ),
          ),
    el(ConfirmModal, {
      target: confirmTarget,
      busy: busyId === confirmTarget?.id,
      onCancel: () => setConfirmTarget(null),
      onConfirm: confirmRollback,
      t,
    }),
  );
}

module.exports = { ChangeHistorySection, ChangeRow, ConfirmModal };
