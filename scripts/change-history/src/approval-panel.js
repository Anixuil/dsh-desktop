// Codex-inspired review summary and per-turn approval workspace.
const { createElement: el, Fragment, useCallback, useEffect, useMemo, useState } = require('react')
const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
const api = require('./api.js')
const { ensureStyles } = require('./styles.js')
const { showMessage } = require('./message.js')

function basename(path) {
  const parts = String(path ?? '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function diffOf(row) {
  return [{ path: row.path, oldText: row.operation === 'create' ? null : row.before, newText: row.after }]
}

function canReject(row) {
  return row.status !== 'rejected' && (row.operation === 'create' || typeof row.before === 'string')
}

function ApprovalPanel({ sessionId, turn, openFile, t, onClose }) {
  const [approval, setApproval] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const result = await api.getTurnApproval(sessionId, turn)
      const next = result.approval
      setApproval(next)
      setSelectedId((id) => id && next.changes.some((row) => row.id === id) ? id : next.changes[0]?.id ?? null)
    } catch (err) { setError(err) }
  }, [sessionId, turn])

  useEffect(() => { ensureStyles(); void refresh() }, [refresh])
  useEffect(() => {
    const keydown = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [onClose])
  useEffect(() => { if (error) showMessage(String(error.message ?? error)) }, [error])

  const selected = useMemo(() => approval?.changes.find((row) => row.id === selectedId) ?? null, [approval, selectedId])
  const pending = approval?.changes.filter((row) => row.status === 'pending') ?? []

  const approveAll = async () => {
    setBusy(true); setError(null)
    try { await api.approveTurn(sessionId, turn); await refresh() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  const approve = async () => {
    if (!selected) return
    setBusy(true); setError(null)
    try { await api.approveChange(selected.id); await refresh() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  const reject = async () => {
    if (!confirming) return
    setBusy(true); setError(null)
    try { await api.rollbackChange(confirming.id); setConfirming(null); await refresh() } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return el('div', { className: 'chx_approvalBackdrop', onClick: onClose },
    el('section', { className: 'chx_approvalPanel', role: 'dialog', 'aria-modal': true, 'aria-label': t('approval.title'), onClick: (event) => event.stopPropagation() },
      el('header', { className: 'chx_approvalHeader' },
        el('div', null, el('h2', { className: 'chx_approvalTitle' }, t('approval.title')), el('p', { className: 'chx_approvalMeta' }, approval ? `${t('approval.files', { count: approval.changes.length })} · +${approval.totals.added} / -${approval.totals.removed}` : '')),
        el('div', { className: 'chx_approvalHeaderActions' },
          el(primitives.Button, { type: 'button', size: 'sm', variant: 'outline', disabled: busy || pending.length === 0, onClick: approveAll }, t('approval.approveAll')),
          el('button', { type: 'button', className: 'chx_viewerIconBtn', onClick: onClose, 'aria-label': t('approval.close'), title: t('approval.close') }, el(primitives.IconCloseOutline16, { size: 16 })),
        ),
      ),
      approval === null ? el('p', { className: 'chx_approvalEmpty' }, t('loading')) : approval.changes.length === 0 ? el('p', { className: 'chx_approvalEmpty' }, t('approval.empty')) :
        el('div', { className: 'chx_approvalContent' },
          el('aside', { className: 'chx_approvalList', 'aria-label': t('approval.files', { count: approval.changes.length }) }, approval.changes.map((row) =>
            el('button', { type: 'button', key: row.id, className: `chx_approvalFile${row.id === selectedId ? ' is-selected' : ''}`, onClick: () => setSelectedId(row.id) },
              el('span', { className: 'chx_approvalFileName' }, basename(row.path)),
              el('span', { className: `chx_approvalStatus is-${row.status}` }, t(`row.status.${row.status}`)),
              el('span', { className: 'chx_approvalFileStats' }, `+${row.stats.added} / -${row.stats.removed}`),
            ),
          )),
          selected ? el('main', { className: 'chx_approvalDiff' },
            el('div', { className: 'chx_approvalFileHead' },
              el('button', { type: 'button', className: 'chx_mutationPath', onClick: () => openFile(selected.path), title: selected.path }, selected.path),
              el('div', { className: 'chx_approvalFileActions' },
                selected.status === 'pending' ? el(primitives.Button, { type: 'button', size: 'sm', variant: 'outline', disabled: busy, onClick: approve }, t('approval.approve')) : null,
                canReject(selected) ? el(primitives.Button, { type: 'button', size: 'sm', variant: 'ghost', className: 'chx_actionDanger', disabled: busy, onClick: () => setConfirming(selected) }, t('approval.reject')) : null,
                !canReject(selected) && selected.status !== 'rejected' ? el('span', { className: 'chx_approvalDisabled' }, t('approval.noBaseline')) : null,
              ),
            ),
            el(primitives.DiffBlock, { diffs: diffOf(selected) }),
          ) : null,
        ),
      confirming ? el(primitives.Modal, { open: true, onClose: () => setConfirming(null), title: t('approval.confirm.title'), closeLabel: t('approval.confirm.cancel'), description: t('approval.confirm.desc', { path: confirming.path }), footer: el(Fragment, null,
        el(primitives.Button, { type: 'button', size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setConfirming(null) }, t('approval.confirm.cancel')),
        el(primitives.Button, { type: 'button', size: 'sm', variant: 'outline', className: 'chx_actionDanger', disabled: busy, onClick: reject }, t('approval.confirm.ok')),
      ) }, null) : null,
    ),
  )
}

function TurnApprovalSummary({ matched, sessionId, openFile, t }) {
  const { turn } = matched
  const [approval, setApproval] = useState(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const result = await api.getTurnApproval(sessionId, turn)
    setApproval(result.approval)
  }, [sessionId, turn])
  useEffect(() => { ensureStyles(); void refresh().catch((err) => showMessage(String(err.message ?? err))) }, [refresh])
  const approveAll = async () => {
    setBusy(true)
    try { await api.approveTurn(sessionId, turn); await refresh() } catch (err) { showMessage(String(err.message ?? err)) } finally { setBusy(false) }
  }
  if (approval === null) return el('section', { className: 'chx_turnSummary', 'aria-busy': true }, el('span', { className: 'chx_approvalMeta' }, t('loading')))
  if (approval.changes.length === 0) return null
  const pending = approval.changes.filter((row) => row.status === 'pending').length
  return el(Fragment, null,
    el('section', { className: 'chx_turnSummary' },
      el('div', { className: 'chx_turnSummaryLead' }, el('strong', null, t('approval.summary', { count: approval.changes.length })), el('span', null, `+${approval.totals.added} / -${approval.totals.removed}`)),
      el('div', { className: 'chx_turnSummaryFiles' }, approval.changes.slice(0, 3).map((row) => el('span', { key: row.id }, basename(row.path))), approval.changes.length > 3 ? el('span', null, `+${approval.changes.length - 3}`) : null),
      el('div', { className: 'chx_turnSummaryActions' },
        el(primitives.Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => setOpened(true) }, t('approval.review')),
        el(primitives.Button, { type: 'button', size: 'sm', variant: 'outline', disabled: busy || pending === 0, onClick: approveAll }, t('approval.approveAll')),
      ),
    ),
    opened ? el(ApprovalPanel, { sessionId, turn, openFile, t, onClose: () => { setOpened(false); void refresh() } }) : null,
  )
}

function selectTurnApproval(owner) {
  const turn = owner.turn?.turn
  return Number.isInteger(turn) ? { turn } : null
}

module.exports = { ApprovalPanel, TurnApprovalSummary, selectTurnApproval }
