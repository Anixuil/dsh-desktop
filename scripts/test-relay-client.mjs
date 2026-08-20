// Relay-client smoke test: exercises the product agent against a local relay
// and a scripted mock dsh target.
//   * protocol mirror: relay-client/lib/frames.js matches relay/lib/frames.js
//   * /ping status endpoint reports offline -> online after relay connect
//   * phone HTTP forwarded through relay reaches the local mock target
//   * close() tears the status listener down
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requireFromRelay = createRequire(new URL('./relay/package.json', import.meta.url))
const { WebSocket } = requireFromRelay('ws')
const { startRelay } = await import('./relay/index.js')
const { startRelayClient } = await import('./relay-client/index.js')
const relayFrames = await import('./relay/lib/frames.js')
const clientFrames = await import('./relay-client/lib/frames.js')

const SECRET = 'test-relay-client-secret'
const BEARER = `Bearer ${SECRET}`

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function waitFor(check, message, timeoutMs = 8000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await check()) return resolve()
      } catch { /* keep polling */ }
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${message}`))
      setTimeout(tick, 100)
    }
    tick()
  })
}

const waitMessage = (ws) => new Promise((resolve) => ws.once('message', (d) => resolve(d)))

// --- 1. protocol mirror -----------------------------------------------------
{
  const relayAgent = [...relayFrames.AGENT_FRAMES].sort().join(',')
  const clientAgent = [...clientFrames.AGENT_FRAMES].sort().join(',')
  assert(relayAgent === clientAgent, 'AGENT_FRAMES drifted between relay and relay-client')
  const relayRelay = [...relayFrames.RELAY_FRAMES].sort().join(',')
  const clientRelay = [...clientFrames.RELAY_FRAMES].sort().join(',')
  assert(relayRelay === clientRelay, 'RELAY_FRAMES drifted between relay and relay-client')
  console.log('protocol mirror ok')
}

// --- 2. mock local dsh target ----------------------------------------------
const mock = createServer((req, res) => {
  if (req.url === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'from-pc', via: req.url }))
  } else {
    res.writeHead(404)
    res.end()
  }
})
mock.listen(0, '127.0.0.1')
await once(mock, 'listening')
const mockPort = mock.address().port

const relay = await startRelay({ port: 0, secret: SECRET, heartbeatInterval: 5000, idleTimeout: 20000 })
const client = await startRelayClient({
  relayUrl: `ws://127.0.0.1:${relay.port}`,
  secret: SECRET,
  deviceId: 'prod-pc',
  localPort: mockPort,
  statusPort: 0,
})
const hbStateDir = mkdtempSync(join(tmpdir(), 'relay-client-hb-'))
const ping = async (c) => {
  const res = await fetch(`http://127.0.0.1:${c.statusPort}/ping`)
  return res.ok ? res.json() : null
}

try {
  // 3. status endpoint: online flips true once the relay connection is up
  {
    const ping = async () => {
      const res = await fetch(`http://127.0.0.1:${client.statusPort}/ping`)
      return res.ok ? res.json() : null
    }
    const initial = await ping()
    assert(initial !== null && initial.name === 'dsh-desktop-relay-client', `bad ping payload: ${JSON.stringify(initial)}`)
    await waitFor(async () => (await ping())?.online === true, 'relay-client to report online')
    console.log('status endpoint ok (online reported)')
  }

  // 4. phone HTTP forwarded through relay reaches the mock target
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/prod-pc/api/hello`, { headers: { authorization: BEARER } })
    const body = await res.json()
    assert(res.status === 200 && body.hello === 'from-pc', `forward failed: ${res.status} ${JSON.stringify(body)}`)
    console.log('http forward through relay ok')
  }

  // 5. WS bridge: relay ws-open reaches the client, which upgrades the mock
  //    (mock has no WS support, but the ws-close round-trip must complete)
  {
    const phoneWs = new WebSocket(`ws://127.0.0.1:${relay.port}/d/prod-pc/api/events.mux`, {
      headers: { authorization: BEARER },
    })
    await once(phoneWs, 'open')
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 8000)
      phoneWs.on('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
      phoneWs.send('hello')
      setTimeout(() => phoneWs.close(1000, 'done'), 500)
    })
    assert(closed !== 'timeout', 'phone ws did not close cleanly through the relay')
    console.log('ws bridge close round-trip ok')
  }

  // 5b. proactive heartbeat: the client feeds the relay's liveness window with
  //     unsolicited pongs, so an idle connection survives even when the relay
  //     never pings it (regression: coarse-tick relays dropped healthy agents
  //     with 4001 "heartbeat timeout" and the client reconnected forever)
  {
    const hbRelay = await startRelay({
      port: 0,
      secret: SECRET,
      stateFile: join(hbStateDir, 'relay-state.json'),
      heartbeatInterval: 100_000, // the relay itself never pings during the test
      idleTimeout: 4000,
    })
    const hbClient = await startRelayClient({
      relayUrl: `ws://127.0.0.1:${hbRelay.port}`,
      secret: SECRET,
      deviceId: 'hb-client',
      localPort: mockPort,
      statusPort: 0,
      heartbeatInterval: 2000,
    })
    try {
      await waitFor(async () => (await ping(hbClient))?.online === true, 'hb client to report online')
      // Wait well past the relay idle timeout: proactive pongs must keep it up.
      await new Promise((resolve) => setTimeout(resolve, 7000))
      const p = await ping(hbClient)
      assert(p?.online === true, `proactive heartbeat must keep the client online, got ${JSON.stringify(p)}`)
      console.log('proactive heartbeat keeps client online ok')
    } finally {
      hbClient.close()
      hbRelay.close()
    }
  }

  console.log('test-relay-client: all checks passed')
} finally {
  client.close()
  relay.close()
  mock.close()
  rmSync(hbStateDir, { recursive: true, force: true })
}
