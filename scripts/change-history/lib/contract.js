// dsh-desktop-change-history — host/client contract.
//
// The plugin is split across two realms (node host plugin / web client bundle)
// that cannot share imports, so this module is the single written source of
// truth for the wire shape. The client bundle mirrors these constants in its
// own src/contract.js — keep the two files in sync by hand.

/** Prefix under which the host plugin registers its same-origin HTTP API. */
export const BASE_PATH = '/desktop-changes'

/** Response codes the client keys off (strings stay stable across versions). */
export const CODES = {
  /** The requested change record does not exist in the store. */
  NOT_FOUND: 'not_found',
  /** The pre-change content is unavailable (e.g. a full-file write whose
   *  prior content the backend declined to capture), so rollback is refused. */
  NO_BASELINE: 'no_baseline',
  /** Malformed request body / missing required field. */
  BAD_REQUEST: 'bad_request',
  /** The file exists but cannot be read for the built-in viewer. */
  NOT_READABLE: 'not_readable',
}

/** Normalize one persisted record to the client-facing change row. */
export function changeRow(record) {
  return {
    id: record.id,
    sessionId: record.sessionId ?? null,
    sessionTitle: record.sessionTitle ?? null,
    turn: typeof record.turn === 'number' ? record.turn : null,
    tool: record.tool,
    path: record.path,
    operation: record.operation,
    before: record.before ?? null,
    after: record.after ?? '',
    createdAt: record.createdAt ?? null,
  }
}
