// dsh-desktop-session-manager — list state + actions hook.
const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = require('react')
const api = require('./api.js')

const noopSub = () => () => {}

/**
 * Overlay the live archive set onto server rows. The host endpoint marks
 * archived rows too, but the client runtime's workspaces store is the live
 * source the sidebar itself uses (updated by host events), so merging here
 * keeps the section in sync with archive actions from anywhere — and makes
 * the section correct even against a host that under-reports the flag.
 * @param rows - session rows (server shape, `archived` respected).
 * @param archivedIds - live archive id list from the workspaces store.
 * @returns rows with the merged `archived` flag.
 */
function mergeArchivedFlags(rows, archivedIds) {
  if (!Array.isArray(archivedIds) || archivedIds.length === 0) return rows
  const set = new Set(archivedIds)
  return rows.map((row) => (set.has(row.id) && row.archived !== true ? { ...row, archived: true } : row))
}

/**
 * Loads the host session list and owns delete/unarchive actions with
 * optimistic local updates. One busy action at a time (busyId). The
 * `workspaces` client service (when present) contributes the live archive
 * set merged on top of the server rows.
 */
function useSessionManager(workspaces) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.listSessions()
      setSessions(result.sessions ?? [])
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const workspaceSnap = useSyncExternalStore(
    (fn) => (workspaces?.list?.subscribe ?? noopSub)(fn),
    () => workspaces?.list?.getSnapshot?.() ?? null,
    () => null,
  )
  const archivedIds = workspaceSnap?.archivedSessionIds ?? null
  const rows = useMemo(
    () => (archivedIds === null ? sessions : mergeArchivedFlags(sessions, archivedIds)),
    [sessions, archivedIds],
  )

  const clearNotice = useCallback(() => {
    setNotice(null)
  }, [])

  const remove = useCallback(async (id) => {
    setBusyId(id)
    setError(null)
    try {
      await api.deleteSession(id)
      setSessions((list) => list.filter((row) => row.id !== id))
      setNotice({ kind: 'deleted' })
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  const unarchive = useCallback(async (id) => {
    setBusyId(id)
    setError(null)
    try {
      await api.unarchiveSession(id)
      setSessions((list) => list.map((row) => (row.id === id ? { ...row, archived: false } : row)))
      setNotice({ kind: 'restored' })
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  const archivedCount = rows.reduce((n, row) => n + (row.archived ? 1 : 0), 0)

  return { sessions: rows, loading, error, busyId, notice, archivedCount, refresh, remove, unarchive, clearNotice }
}

module.exports = { useSessionManager, mergeArchivedFlags }
