// dsh-desktop-change-history — list state + actions hook.
const { useCallback, useEffect, useMemo, useState } = require('react')
const api = require('./api.js')

/**
 * Loads the host change list and owns approval / rejection state updates.
 */
function useChangeHistory() {
  const [changes, setChanges] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.listChanges({ limit: 500 })
      setChanges(result.changes ?? [])
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clearNotice = useCallback(() => {
    setNotice(null)
  }, [])

  const rollback = useCallback(async (id) => {
    setBusyId(id)
    setError(null)
    try {
      const outcome = await api.rollbackChange(id)
      setChanges((list) => list.map((row) => row.id === id ? { ...row, status: 'rejected', reviewed: false } : row))
      setNotice({ kind: outcome.diverged ? 'diverged' : 'rolledBack' })
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  const approve = useCallback(async (id) => {
    setBusyId(id)
    setError(null)
    try {
      await api.approveChange(id)
      setChanges((list) => list.map((row) => row.id === id ? { ...row, status: 'approved', reviewed: true } : row))
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  // Group by session (stable order: first-seen session order, newest change first).
  const groups = useMemo(() => {
    const map = new Map()
    for (const row of changes) {
      const key = row.sessionId ?? '__none__'
      if (!map.has(key)) map.set(key, { sessionId: row.sessionId, sessionTitle: row.sessionTitle, changes: [] })
      map.get(key).changes.push(row)
    }
    return Array.from(map.values())
  }, [changes])

  return { changes, groups, loading, error, busyId, notice, refresh, rollback, approve, clearNotice }
}

module.exports = { useChangeHistory }
