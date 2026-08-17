// dsh-desktop-session-manager — host/client contract.
//
// The plugin is split across two realms (node host plugin / web client bundle)
// that cannot share imports, so this module is the single written source of
// truth for the wire shape. The client bundle mirrors these constants in its
// own src/contract.js — keep the two files in sync by hand.

/** Prefix under which the host plugin registers its same-origin HTTP API. */
export const BASE_PATH = '/desktop-sessions'

/** Response codes the client keys off (strings stay stable across versions). */
export const CODES = {
  /** The target session is live in the host session store (open right now). */
  LIVE: 'live',
  /** The target session does not exist anywhere we can see. */
  UNKNOWN: 'unknown',
  /** The workspaceRegistry capability patch is unavailable in this dsh build. */
  DEGRADED: 'degraded',
}

/** Shape of one session row served by GET /desktop-sessions/list. */
export function sessionRow(session) {
  return {
    id: session.id,
    title: session.title ?? null,
    createdAt: session.createdAt ?? null,
    workspaceId: session.workspaceId ?? null,
    archived: session.archived === true,
    tokens: session.tokens ?? null,
    turns: session.turns ?? null,
  }
}
