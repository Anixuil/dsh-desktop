// dsh-desktop-change-history — inline write/edit row with review/revert actions.
//
// Takes over the shipped `tool.call.toolview` cells for `write` and `edit`
// (priority -1 shadows the shipped file-mutation row, lowest renders) and
// renders the applied diff plus three inline actions, wired to the host's
// /desktop-changes routes:
//   * 查看  — open the changed file in the built-in side viewer (./file-viewer.js)
//   * 审核  — toggle the reviewed flag (persisted by the host)
//   * 回滚  — restore the pre-change content (confirm modal)
//
// The row correlates with its change-log record by the tool call id: the host
// records every write/edit keyed by `callId`, so the settled row resolves its
// change with /desktop-changes/resolve?callId=….
const { createElement: el, Fragment, useCallback, useEffect, useState } = require('react');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const api = require('./api.js');
const { ensureStyles } = require('./styles.js');
const { openFileViewer } = require('./file-viewer.js');
const { showMessage } = require('./message.js');

/** The diff render intent from a block's settled result or pending call view. */
function viewOf(block) {
  if (block?.resultView?.card === 'diff') return block.resultView;
  if (block?.callView?.card === 'diff') return block.callView;
  return null;
}

function ChangeMutationRow({ toolName, block, openFile, t }) {
  const [change, setChange] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const callId = block?.callId;
  const view = viewOf(block);
  const diffs = view?.diffs ?? null;
  const path = Array.isArray(diffs) && diffs.length > 0 ? diffs[0].path : null;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (error !== null) showMessage(String(error?.message ?? error));
  }, [error]);

  // Resolve the change-log record by call id once the call settles.
  useEffect(() => {
    if (typeof callId !== 'string' || callId === '') return;
    if (block?.resultView == null) return; // still running
    let cancelled = false;
    api.resolveChange(callId).then(
      (res) => { if (!cancelled) setChange(res.change ?? null); },
      () => { if (!cancelled) setChange(null); },
    );
    return () => { cancelled = true; };
  }, [callId, block?.resultView]);

  const open = useCallback(() => {
    if (typeof path === 'string' && path !== '') openFileViewer(path, openFile);
  }, [path, openFile]);

  const rollback = useCallback(async () => {
    if (change === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.rollbackChange(change.id);
      setRolledBack(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [change]);

  const toggleReviewed = useCallback(async () => {
    if (change === null) return;
    const next = !change.reviewed;
    setChange((c) => (c === null ? c : { ...c, reviewed: next }));
    try {
      await api.reviewChange(change.id, next);
    } catch {
      setChange((c) => (c === null ? c : { ...c, reviewed: !next }));
    }
  }, [change]);

  return el(
    'div',
    { className: 'chx_mutationRow' },
    el(
      'div',
      { className: 'chx_mutationHead' },
      el('span', { className: 'chx_mutationTag' }, toolName === 'edit' ? t('inline.edit') : t('inline.write')),
      path !== null
        ? el('button', { type: 'button', className: 'chx_mutationPath', title: path, onClick: open }, path)
        : null,
      rolledBack ? el('span', { className: 'chx_mutationDone' }, t('inline.rolledBack')) : null,
    ),
    Array.isArray(diffs) && diffs.length > 0 ? el(primitives.DiffBlock, { diffs }) : null,
    change !== null && !rolledBack
      ? el(
          'div',
          { className: 'chx_mutationActions' },
          el(
            primitives.Button,
            { type: 'button', size: 'sm', variant: 'outline', icon: el(primitives.IconBrowseOutline16, { size: 14 }), onClick: open },
            t('inline.view'),
          ),
          el(
            primitives.Button,
            {
              type: 'button',
              size: 'sm',
              variant: change.reviewed ? 'outline' : 'ghost',
              icon: el(primitives.IconCheckOutline16, { size: 14 }),
              className: change.reviewed ? 'chx_actionReviewed' : undefined,
              'aria-pressed': change.reviewed,
              onClick: toggleReviewed,
            },
            change.reviewed ? t('inline.reviewed') : t('inline.review'),
          ),
          el(
            primitives.Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'ghost',
              icon: el(primitives.IconRefreshOutline16, { size: 14 }),
              className: 'chx_actionDanger',
              disabled: busy,
              onClick: () => setConfirming(true),
            },
            t('inline.rollback'),
          ),
        )
      : null,
    confirming
      ? el(
          primitives.Modal,
          {
            open: true,
            onClose: () => setConfirming(false),
            title: t('inline.confirm.title'),
            closeLabel: t('inline.confirm.cancel'),
            description: t(change?.operation === 'create' ? 'inline.confirm.desc.create' : 'inline.confirm.desc', { path: path ?? '' }),
            footer: el(
              Fragment,
              null,
              el(primitives.Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => setConfirming(false), disabled: busy }, t('inline.confirm.cancel')),
              el(primitives.Button, { type: 'button', size: 'sm', variant: 'outline', className: 'chx_actionDanger', onClick: rollback, disabled: busy }, busy ? t('inline.busy') : t('inline.confirm.ok')),
            ),
          },
          null,
        )
      : null,
  );
}

/** Registrant shadowing the shipped write/edit rows with review actions. */
const changeMutationToolview = {
  name: 'change-history-toolview',
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', priority: -1, locale: 'changeHistory' }, ChangeMutationRow);
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', priority: -1, locale: 'changeHistory' }, ChangeMutationRow);
    });
  },
};

module.exports = { ChangeMutationRow, changeMutationToolview };
