// dsh-desktop-relay — per-device identity store.
//
// Replaces the prototype's single shared secret with product identities:
//   * a PC registers a deviceId and receives a deviceSecret (auto-generated)
//   * a phone pairs with a short code and receives a phoneToken (long-lived)
// Only hashes are persisted; plaintexts exist on the wire once.
// State lives in one JSON file (relay-state.json next to the relay).
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const hash = (value) => createHash('sha256').update(String(value)).digest('hex')

export function createDeviceStore({ file = 'relay-state.json' } = {}) {
  let state = { devices: {} }
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
    if (state === null || typeof state !== 'object' || !state.devices) state = { devices: {} }
  } catch {
    state = { devices: {} }
  }
  const save = () => {
    try {
      writeFileSync(file, JSON.stringify(state, null, 2))
    } catch {
      // read-only deployment; keep serving from memory
    }
  }

  return {
    /**
     * Register a device, returning its one-time plaintext secret.
     *
     * A relay state file can outlive a desktop installation.  Callers may
     * explicitly replace that stale identity after the live registry has
     * confirmed that no agent is connected.  We keep the phone token list so
     * an offline/restarted desktop does not unexpectedly log every phone out.
     */
    register(deviceId, { replace = false } = {}) {
      if (state.devices[deviceId] !== undefined && !replace) return undefined
      const deviceSecret = randomBytes(32).toString('hex')
      const previous = state.devices[deviceId]
      state.devices[deviceId] = {
        secretHash: hash(deviceSecret),
        phoneTokens: Array.isArray(previous?.phoneTokens) ? previous.phoneTokens : [],
        ...(typeof previous?.persistentCodeHash === 'string'
          ? { persistentCodeHash: previous.persistentCodeHash }
          : {}),
      }
      save()
      return deviceSecret
    },
    /** Whether the deviceId exists in the store. */
    has(deviceId) {
      return state.devices[deviceId] !== undefined
    },
    /** Remove a device and all its phone tokens (admin recovery path). */
    remove(deviceId) {
      if (state.devices[deviceId] === undefined) return false
      delete state.devices[deviceId]
      save()
      return true
    },
    /** Whether `presented` is the device's own secret. */
    verifyAgent(deviceId, presented) {
      const device = state.devices[deviceId]
      return device !== undefined && hash(presented) === device.secretHash
    },
    /** Save a user-defined long-lived pairing code as a hash only. */
    setPersistentCode(deviceId, code) {
      const device = state.devices[deviceId]
      if (device === undefined) return false
      device.persistentCodeHash = hash(code)
      save()
      return true
    },
    /** Remove the device's long-lived pairing code. Existing phone tokens stay valid. */
    clearPersistentCode(deviceId) {
      const device = state.devices[deviceId]
      if (device === undefined) return false
      delete device.persistentCodeHash
      save()
      return true
    },
    hasPersistentCode(deviceId) {
      return typeof state.devices[deviceId]?.persistentCodeHash === 'string'
    },
    verifyPersistentCode(deviceId, presented) {
      const device = state.devices[deviceId]
      return device !== undefined && typeof device.persistentCodeHash === 'string' && hash(presented) === device.persistentCodeHash
    },
    /** Issue a long-lived phone token for a registered device. */
    issuePhoneToken(deviceId) {
      const device = state.devices[deviceId]
      if (device === undefined) return undefined
      const token = randomBytes(32).toString('hex')
      device.phoneTokens.push(hash(token))
      save()
      return token
    },
    /** Whether `presented` is a phone token bound to the device. */
    verifyPhone(deviceId, presented) {
      const device = state.devices[deviceId]
      return device !== undefined && device.phoneTokens.includes(hash(presented))
    },
    /** Registered device count (healthz). */
    get count() {
      return Object.keys(state.devices).length
    },
  }
}
