// dsh-desktop-relay — device registry: one live agent connection per device.
//
// Each PC registers as a device under its relay connection. A second agent
// connection for the same deviceId supersedes the first (the older socket is
// closed with code 4000 and its pending exchanges fail fast), so the phone
// always talks to the newest incarnation of a PC.
import { encodeFrame } from './frames.js'

const CLOSE_SUPERSEDED = 4000

/** One registered device: its socket plus in-flight exchanges keyed by frame id. */
export class DeviceEntry {
  constructor(deviceId, ws) {
    this.deviceId = deviceId
    this.ws = ws
    this.connectedAt = Date.now()
    this.lastSeen = Date.now()
    /** id -> HttpExchange (pending HTTP forward) */
    this.pendingHttp = new Map()
    /** id -> WsStream (pending/bridged phone WS) */
    this.pendingWs = new Map()
    /** phone session key -> last activity timestamp */
    this.viewerSessions = new Map()
  }

  /** Fail every in-flight exchange: the agent can no longer answer them. */
  failAll(reason) {
    for (const exchange of this.pendingHttp.values()) exchange.fail(reason)
    this.pendingHttp.clear()
    for (const stream of this.pendingWs.values()) stream.abort(reason)
    this.pendingWs.clear()
  }

  acquireViewer(sessionKey, maxConcurrentViewers) {
    const now = Date.now()
    if (this.viewerSessions.has(sessionKey)) {
      this.viewerSessions.set(sessionKey, now)
      return true
    }
    if (this.viewerSessions.size >= maxConcurrentViewers) return false
    this.viewerSessions.set(sessionKey, now)
    return true
  }

  touchViewer(sessionKey) {
    if (this.viewerSessions.has(sessionKey)) this.viewerSessions.set(sessionKey, Date.now())
  }

  sweepViewers(now, idleTimeout) {
    for (const [key, lastSeen] of this.viewerSessions) {
      if (now - lastSeen > idleTimeout) this.viewerSessions.delete(key)
    }
  }
}

export class DeviceRegistry {
  constructor({ heartbeatInterval = 25_000, idleTimeout = 35_000, maxConcurrentViewers = 3, viewerIdleTimeout = 5 * 60_000 } = {}) {
    this.heartbeatInterval = heartbeatInterval
    this.idleTimeout = idleTimeout
    this.maxConcurrentViewers = Math.max(1, Math.floor(maxConcurrentViewers))
    this.viewerIdleTimeout = Math.max(30_000, viewerIdleTimeout)
    /** deviceId -> DeviceEntry */
    this.devices = new Map()
    // Tick cadence bug (fixed): the old cadence was min(heartbeatInterval,
    // idleTimeout) — a coarse 25 s grid against a 35 s idle timeout. An agent
    // that attached just after a tick could have its idle jump straight past
    // idleTimeout on the next tick, so it was closed with 4001 "heartbeat
    // timeout" without ever receiving a ping; the relay-client then reconnected
    // every ~45 s and the device was offline more than it was online.
    //
    // A ping is only useful when it lands inside the window
    // (heartbeatInterval < idle <= idleTimeout), so the tick MUST run no less
    // often than the window itself — otherwise the window can be skipped. Tick
    // at a small fraction of the window so at least one tick always lands in
    // it, while keeping a sane floor.
    const windowMs = Math.max(1000, idleTimeout - heartbeatInterval)
    const cadenceMs = Math.min(windowMs, Math.max(1000, Math.min(heartbeatInterval, idleTimeout) / 4))
    /** Interval between heartbeat ticks (exposed for tests / introspection). */
    this.tickCadence = cadenceMs
    this.timer = setInterval(() => this.tick(), cadenceMs)
    this.timer.unref?.()
  }

  /** Attach an agent socket for deviceId; a prior connection is superseded. */
  attach(deviceId, ws) {
    const prior = this.devices.get(deviceId)
    if (prior !== undefined) {
      this.devices.delete(deviceId)
      prior.failAll('agent connection superseded')
      try {
        prior.ws.close(CLOSE_SUPERSEDED, 'superseded by a newer connection')
      } catch {
        // socket already gone; nothing to close
      }
    }
    const entry = new DeviceEntry(deviceId, ws)
    this.devices.set(deviceId, entry)
    return entry
  }

  /** Forget a device whose socket left; returns the entry for cleanup. */
  detach(ws) {
    for (const [deviceId, entry] of this.devices) {
      if (entry.ws === ws) {
        this.devices.delete(deviceId)
        entry.failAll('agent disconnected')
        return entry
      }
    }
    return undefined
  }

  /** Look up a live device and touch its liveness timestamp. */
  lookup(deviceId) {
    const entry = this.devices.get(deviceId)
    if (entry !== undefined) entry.lastSeen = Date.now()
    return entry
  }

  /** Return the entry owning a socket, or undefined for foreign sockets. */
  entryFor(ws) {
    for (const entry of this.devices.values()) {
      if (entry.ws === ws) return entry
    }
    return undefined
  }

  /** Public presence snapshot (status endpoint). */
  snapshot(deviceId) {
    const entry = this.devices.get(deviceId)
    if (entry === undefined) return { deviceId, online: false, lastSeen: null, activeViewers: 0, maxConcurrentViewers: this.maxConcurrentViewers }
    entry.sweepViewers(Date.now(), this.viewerIdleTimeout)
    return { deviceId, online: true, connectedAt: entry.connectedAt, lastSeen: entry.lastSeen, activeViewers: entry.viewerSessions.size, maxConcurrentViewers: this.maxConcurrentViewers }
  }

  /** Periodic heartbeat: ping idle agents, drop those that stop answering. */
  tick() {
    const now = Date.now()
    for (const entry of this.devices.values()) {
      entry.sweepViewers(now, this.viewerIdleTimeout)
      if (entry.ws.readyState !== entry.ws.OPEN) continue
      const idle = now - entry.lastSeen
      if (idle > this.idleTimeout) {
        entry.failAll('agent heartbeat timeout')
        try {
          entry.ws.close(4001, 'heartbeat timeout')
        } catch {
          // ignore close races
        }
        continue
      }
      if (idle > this.heartbeatInterval) {
        try {
          entry.ws.send(encodeFrame({ type: 'ping' }))
        } catch {
          // socket write failed; the close handler cleans up
        }
      }
    }
  }

  /** Stop the heartbeat timer (test/exit hygiene). */
  close() {
    clearInterval(this.timer)
  }
}
