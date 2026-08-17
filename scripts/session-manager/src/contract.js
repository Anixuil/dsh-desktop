// dsh-desktop-session-manager — client half of the wire contract.
// Mirror of the host plugin's lib/contract.js; keep both files in sync.
module.exports = {
  BASE_PATH: '/desktop-sessions',
  CODES: {
    LIVE: 'live',
    UNKNOWN: 'unknown',
    DEGRADED: 'degraded',
  },
}
