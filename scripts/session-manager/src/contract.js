// dsh-desktop-session-manager — client half of the wire contract.
// Mirror of the host plugin's lib/contract.js; keep both files in sync.
module.exports = {
  BASE_PATH: '/desktop-sessions',
  CODES: {
    // Target session has work in flight (or could not be released from the
    // host store). Archived sessions only attached but idle are released
    // and deleted instead of refused.
    LIVE: 'live',
    UNKNOWN: 'unknown',
    DEGRADED: 'degraded',
  },
}
