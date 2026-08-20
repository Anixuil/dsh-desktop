// dsh-desktop-change-history — list state + actions hook.
const { useCallback, useEffect, useMemo, useState } = require('react')
const api = require('./api.js')

/**
 * Loads the host change list and owns the rollback action with optimistic
 * local updates (the reverted change is dropped from the list on success).
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
      setChanges((list) => list.filter((row) => row.id !== id))
      setNotice({ kind: outcome.diverged ? 'diverged' : 'rolledBack' })
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

  return { changes, groups, loading, error, busyId, notice, refresh, rollback, clearNotice }
}

module.exports = { useChangeHistory }
