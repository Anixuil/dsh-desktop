// dsh-desktop-change-history — client half of the wire contract.
// Mirror of the host plugin's lib/contract.js; keep both files in sync.
module.exports = {
  BASE_PATH: '/desktop-changes',
  MAX_READ_BYTES: 1024 * 1024,
  CODES: {
    NOT_FOUND: 'not_found',
    NO_BASELINE: 'no_baseline',
    BAD_REQUEST: 'bad_request',
    NOT_READABLE: 'not_readable',
  },
}
