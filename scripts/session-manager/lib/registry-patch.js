// dsh-desktop-session-manager — workspaceRegistry capability patch.
//
// Upstream dsh-workspace only exposes a one-way `archiveSession(id)`: the
// archive set (`archivedSessionIds`) can grow but never shrink, which is why
// archived sessions are unrecoverable from the UI today. The registry keeps
// its durable state behind private instance methods (`enqueueOperation`,
// `requireState`, `setState`) — private by TypeScript convention, but present
// on the runtime instance. We patch the singleton instance with the missing
// inverse operations, so every write still flows through the registry's own
// durability + operation queue, and the domain-table write fires dsh's own
// `domain/changed` → `host/archived-sessions-changed` broadcast, refreshing
// every connected web client without a reload.
//
// This is an intentional, contained runtime patch: it is capability-probed
// before use and degrades gracefully when a future dsh build changes the
// registry internals (the caller reports `degraded` instead of failing).

/** Names of the private-but-present instance members the patch relies on. */
const REQUIRED_MEMBERS = ['enqueueOperation', 'requireState', 'setState']

/**
 * Remove one id from the archive set through the registry's own write path.
 * Resolves without writing when the id is not archived (no-op durability).
 * @param registry - the workspaceRegistry service instance.
 * @param id - session id to unarchive.
 */
function installPatch(registry) {
  const removeArchived = (sessionId) =>
    registry.enqueueOperation(async () => {
      const state = registry.requireState()
      if (!Array.isArray(state?.archivedSessionIds)) return
      if (!state.archivedSessionIds.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
  // One patched implementation, two semantic entry points: unarchiving a
  // session and scrubbing an archived id during deletion are the same write.
  registry.unarchiveSession = removeArchived
  registry.removeArchived = removeArchived
}

/**
 * Ensure the registry instance carries the inverse archive operations.
 * Idempotent and re-probed on every call (the instance could have been
 * replaced by a plugin reload between calls).
 * @param registry - the workspaceRegistry service instance (may be undefined).
 * @returns whether the registry now supports unarchive/removeArchived.
 */
export function ensureRegistryPatch(registry) {
  if (registry === undefined || registry === null) return false
  if (typeof registry.unarchiveSession === 'function' && typeof registry.removeArchived === 'function') {
    return true
  }
  for (const member of REQUIRED_MEMBERS) {
    if (typeof registry[member] !== 'function') return false
  }
  try {
    installPatch(registry)
  } catch {
    return false
  }
  return typeof registry.unarchiveSession === 'function' && typeof registry.removeArchived === 'function'
}
