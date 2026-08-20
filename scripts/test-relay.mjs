// Relay smoke test: exercises the dsh-desktop-relay frame forwarding end to
// end against a scripted agent (mock PC) and phone-side callers.
//   * /healthz answers without auth
//   * phone routes reject missing/invalid bearer tokens
//   * agent registration validates deviceId and supersedes duplicates
//   * HTTP forward: complete res frame and streaming chunk/end frames
//   * WS bridge: ws-open -> ws-ready handshake, bidirectional ws-data, close
//   * status endpoint (path-prefix and Host-subdomain forms)
//   * offline device answers 503 and reports offline
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requireFromRelay = createRequire(new URL('./relay/package.json', import.meta.url))
const { WebSocket } = requireFromRelay('ws')
const { startRelay } = await import('./relay/index.js')

const SECRET = 'test-relay-secret'
const BEARER = `Bearer ${SECRET}`

// Identity store must be isolated per run: a shared relay-state.json in the
// repo root would leak registrations across test executions.
const stateDir = mkdtempSync(join(tmpdir(), 'relay-test-'))
const stateFile = join(stateDir, 'relay-state.json')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function waitMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (data, isBinary) => {
      cleanup()
      resolve({ data, isBinary })
    }
    const onClose = (code) => {
      cleanup()
      reject(new Error(`socket closed (${code}) while waiting for a message`))
    }
    const cleanup = () => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve(ws.closeCode)
    ws.once('close', (code) => resolve(code))
  })
}

/** Scripted agent: answers req/ws-open/ping frames per the wire protocol. */
function connectAgent(relay, deviceId, { onReq = () => {}, onWsOpen = () => {}, onWsData = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/agent?deviceId=${deviceId}`, {
      headers: { authorization: BEARER },
    })
    const send = (frame) => ws.send(JSON.stringify(frame))
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.type === 'ping') return send({ type: 'pong' })
      if (frame.type === 'req') return onReq(frame, send)
      if (frame.type === 'ws-open') return onWsOpen(frame, send)
      if (frame.type === 'ws-data') return onWsData(frame, send)
      if (frame.type === 'ws-close') {
        ws.emit('agent-ws-close', frame)
      }
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

const b64 = (text) => Buffer.from(text).toString('base64')

// --- boot ---------------------------------------------------------------
const relay = await startRelay({ port: 0, secret: SECRET, stateFile, heartbeatInterval: 5000, idleTimeout: 20000 })
try {
  // 1. healthz (no auth required)
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`)
    const body = await res.json()
    assert(res.status === 200 && body.ok === true, 'healthz should answer ok')
    console.log('healthz ok')
  }

  // 2. unauthorized callers are rejected
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/none/status`)
    assert(res.status === 401, `expected 401 without bearer, got ${res.status}`)
    const bad = await fetch(`http://127.0.0.1:${relay.port}/d/none/status`, {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    assert(bad.status === 401, `expected 401 with wrong secret, got ${bad.status}`)
    console.log('auth fence ok')
  }

  // 2b. browser login flow: html navigation 302s to /login, POST sets cookie
  {
    const nav = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    assert(
      nav.status === 302 && nav.headers.get('location') === '/login?next=%2Fd%2Ftest-pc%2F',
      `expected login redirect, got ${nav.status} ${nav.headers.get('location')}`,
    )
    const form = await fetch(`http://127.0.0.1:${relay.port}/login`)
    const formHtml = await form.text()
    assert(form.status === 200 && formHtml.includes('relay_token') === false && formHtml.includes('name="token"'), 'login form missing')
    const badPost = await fetch(`http://127.0.0.1:${relay.port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=wrong&next=/',
      redirect: 'manual',
    })
    assert((await badPost.text()).includes('class="err"'), 'wrong secret should re-show form with error')
    const good = await fetch(`http://127.0.0.1:${relay.port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${SECRET}&next=/`,
      redirect: 'manual',
    })
    assert(good.status === 302, `login should redirect, got ${good.status}`)
    const setCookie = good.headers.get('set-cookie')
    assert(
      setCookie.includes('relay_token=') && setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax'),
      `bad cookie attributes: ${setCookie}`,
    )
    const authed = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/status`, {
      headers: { cookie: `relay_token=${SECRET}` },
    })
    assert(authed.status === 200, `cookie should authenticate, got ${authed.status}`)
    console.log('login + cookie auth ok')
  }

  // 2b2. QR scan flow: a scanned ?code= rides the 302 into /login and pre-fills
  //      the form (the settings window QR encodes <entry>?code=NNNNNN).
  {
    const nav = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/?code=530005`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    assert(
      nav.status === 302 && nav.headers.get('location') === '/login?next=%2Fd%2Ftest-pc%2F%3Fcode%3D530005&code=530005',
      `expected login redirect carrying code, got ${nav.status} ${nav.headers.get('location')}`,
    )
    const form = await fetch(`http://127.0.0.1:${relay.port}/login?code=530005`)
    const formHtml = await form.text()
    assert(formHtml.includes('value="530005"'), 'login form should pre-fill the scanned pairing code')
    console.log('qr scan code pre-fill ok')
  }

  // 2c. product identity flow: register -> pairing -> phone token
  {
    const register = await fetch(`http://127.0.0.1:${relay.port}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    const reg = await register.json()
    assert(register.status === 200 && typeof reg.deviceSecret === 'string' && reg.deviceSecret.length >= 32, `register failed: ${register.status} ${JSON.stringify(reg)}`)
    const stale = await fetch(`http://127.0.0.1:${relay.port}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    const staleBody = await stale.json()
    assert(stale.status === 200 && staleBody.deviceSecret !== reg.deviceSecret, `offline stale registration should rotate, got ${stale.status} ${JSON.stringify(staleBody)}`)
    const deviceBearer = `Bearer ${staleBody.deviceSecret}`
    const liveAgent = await connectAgent(relay, 'pair-pc')
    const occupied = await fetch(`http://127.0.0.1:${relay.port}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    assert(occupied.status === 409, `live duplicate register should 409, got ${occupied.status}`)
    liveAgent.close()
    // a device secret opens the owner's phone route too (owner login)
    const ownerRoute = await fetch(`http://127.0.0.1:${relay.port}/d/pair-pc/status`, { headers: { authorization: deviceBearer } })
    assert(ownerRoute.status === 200, 'device secret should also serve the owner phone route')
    // pairing: agent-authorized code issuance
    const pairing = await fetch(`http://127.0.0.1:${relay.port}/pairing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: deviceBearer },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    const pair = await pairing.json()
    assert(pairing.status === 200 && /^\d{6}$/.test(pair.code), `pairing failed: ${pairing.status} ${JSON.stringify(pair)}`)
    // unauthenticated pairing attempts are rejected
    const badPairing = await fetch(`http://127.0.0.1:${relay.port}/pairing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    assert(badPairing.status === 401, `unauthenticated pairing should 401, got ${badPairing.status}`)
    // redeem the code for a phone token
    const redeemed = await fetch(`http://127.0.0.1:${relay.port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    })
    const phone = await redeemed.json()
    assert(redeemed.status === 200 && phone.deviceId === 'pair-pc' && typeof phone.phoneToken === 'string', `pair redeem failed: ${redeemed.status} ${JSON.stringify(phone)}`)
    const again = await fetch(`http://127.0.0.1:${relay.port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    })
    assert(again.status === 401, `code must be single-use, got ${again.status}`)
    // the phone token opens the device route
    const phoneRes = await fetch(`http://127.0.0.1:${relay.port}/d/pair-pc/status`, {
      headers: { authorization: `Bearer ${phone.phoneToken}` },
    })
    assert(phoneRes.status === 200, `phone token should authorize, got ${phoneRes.status}`)
    // login form redeems a code and sets a cookie carrying the phone token
    const pair2 = await (await fetch(`http://127.0.0.1:${relay.port}/pairing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: deviceBearer },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })).json()
    const login = await fetch(`http://127.0.0.1:${relay.port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${pair2.code}&next=/`,
      redirect: 'manual',
    })
    assert(login.status === 302, `login with pairing code should redirect, got ${login.status}`)
    const cookie = login.headers.get('set-cookie')
    const cookieVal = decodeURIComponent(cookie.match(/relay_token=([^;]+)/)?.[1] ?? '')
    assert(cookieVal !== '' && cookieVal !== SECRET && cookieVal.length >= 32, `cookie should carry a phone token, got ${cookie}`)
    const cookieAuthed = await fetch(`http://127.0.0.1:${relay.port}/d/pair-pc/status`, { headers: { cookie: `relay_token=${cookieVal}` } })
    assert(cookieAuthed.status === 200, `cookie phone token should authorize, got ${cookieAuthed.status}`)
    console.log('register + pairing + phone token flow ok')
  }

  // 2d. admin recovery: delete a registered device, then re-register works
  {
    const noAdmin = await fetch(`http://127.0.0.1:${relay.port}/admin/device-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    assert(noAdmin.status === 401, `admin delete without admin key should 401, got ${noAdmin.status}`)
    const del = await fetch(`http://127.0.0.1:${relay.port}/admin/device-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: BEARER },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    const delBody = await del.json()
    assert(del.status === 200 && delBody.removed === true, `admin delete failed: ${del.status} ${JSON.stringify(delBody)}`)
    const again = await fetch(`http://127.0.0.1:${relay.port}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc' }),
    })
    assert(again.status === 200, `re-register after admin delete should succeed, got ${again.status}`)
    console.log('admin device reset ok')
  }

  // 3. agent registration: bad deviceId rejected, offline device answers 503
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/status`, { headers: { authorization: BEARER } })
    assert(res.status === 200 && (await res.json()).online === false, 'unknown device should report offline')
    const gone = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/api/x`, { headers: { authorization: BEARER } })
    assert(gone.status === 503, `offline device should answer 503, got ${gone.status}`)
    console.log('offline device ok')
  }

  // 4. HTTP forward: complete res frame
  const agent = await connectAgent(relay, 'test-pc', {
    onReq(frame, send) {
      if (frame.path.startsWith('/api/hello')) {
        send({ type: 'res', id: frame.id, status: 200, headers: { 'content-type': 'application/json' }, body: b64('{"hello":"world"}') })
      } else if (frame.path.startsWith('/api/stream')) {
        send({ type: 'res', id: frame.id, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        send({ type: 'chunk', id: frame.id, data: b64('hel') })
        send({ type: 'chunk', id: frame.id, data: b64('lo') })
        send({ type: 'end', id: frame.id })
      } else {
        send({ type: 'err', id: frame.id, message: `unexpected path ${frame.path}` })
      }
    },
  })

  // 3b. heartbeat pong must NOT close the agent socket (regression: a pong
  //     used to fall through to the "mismatched frame" close path)
  {
    const agentWs = relay.registry.lookup('test-pc').ws
    agentWs.send(JSON.stringify({ type: 'pong' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(agentWs.readyState === agentWs.OPEN, `pong must not close the agent socket, state=${agentWs.readyState}`)
    console.log('heartbeat pong tolerated ok')
  }

  // 3c. heartbeat tick cadence must fit inside the ping window (regression: a
  //     coarse min(interval, timeout) tick could skip the whole
  //     (heartbeatInterval, idleTimeout] window and drop a healthy idle agent
  //     with 4001 without ever pinging it)
  {
    const reg = relay.registry
    assert(
      reg.tickCadence <= reg.idleTimeout - reg.heartbeatInterval,
      `tick cadence (${reg.tickCadence}ms) must be <= ping window (${reg.idleTimeout - reg.heartbeatInterval}ms)`,
    )
    console.log('heartbeat tick cadence ok')
  }

  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/api/hello`, { headers: { authorization: BEARER } })
    const body = await res.json()
    assert(res.status === 200 && body.hello === 'world', `complete-response forward failed: ${res.status}`)
    console.log('http forward (res frame) ok')
  }

  // 5. HTTP forward: streaming chunk/end frames
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/api/stream`, { headers: { authorization: BEARER } })
    const text = await res.text()
    assert(res.status === 200 && text === 'hello', `streaming forward failed: got ${JSON.stringify(text)}`)
    console.log('http forward (chunk/end frames) ok')
  }

  // 6. WS bridge: handshake + bidirectional echo + phone-initiated close
  {
    const phoneWs = new WebSocket(`ws://127.0.0.1:${relay.port}/d/test-pc/api/events.mux`, { headers: { authorization: BEARER } })
    await once(phoneWs, 'open')
    const echoPromise = new Promise((resolve, reject) => {
      phoneWs.on('message', (data) => resolve(data.toString()))
      phoneWs.on('error', reject)
    })
    // The agent answers ws-open with ws-ready and echoes ws-data payloads.
    const agentEcho = new Promise((resolve, reject) => {
      agent.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'ws-open') {
          if (frame.path !== '/api/events.mux') reject(new Error(`ws-open path not forwarded: ${frame.path}`))
          agent.send(JSON.stringify({ type: 'ws-ready', id: frame.id }))
          resolve(frame.id)
        }
        if (frame.type === 'ws-data') {
          agent.send(JSON.stringify({ type: 'ws-data', id: frame.id, data: frame.data, binary: frame.binary }))
        }
      })
    })
    const id = await agentEcho
    phoneWs.send('ping-me')
    const echoed = await echoPromise
    assert(echoed === 'ping-me', `ws echo failed: ${JSON.stringify(echoed)}`)
    const agentClose = new Promise((resolve) => {
      agent.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'ws-close') resolve({ id: frame.id, code: frame.code })
      })
    })
    phoneWs.close(1000, 'done')
    const closed = await agentClose
    assert(closed.id === id && closed.code === 1000, `ws-close not mirrored to agent: ${JSON.stringify(closed)}`)
    console.log('ws bridge ok')
  }

  // 7. status endpoint: path-prefix and Host-subdomain forms
  {
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/status`, { headers: { authorization: BEARER } })
    const body = await res.json()
    assert(body.online === true, `device should be online: ${JSON.stringify(body)}`)
    const sub = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: relay.port,
          path: '/status',
          headers: { host: `test-pc.remote.example.com`, authorization: BEARER },
        },
        (r) => {
          let text = ''
          r.on('data', (c) => (text += c))
          r.on('end', () => resolve({ status: r.statusCode, text }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert(sub.status === 200 && JSON.parse(sub.text).online === true, 'subdomain /status failed')
    console.log('status endpoint ok (path prefix + subdomain)')
  }

  // 8. Host-subdomain routing forwards without the /d/ prefix
  {
    const sub = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: relay.port,
          path: '/api/hello',
          headers: { host: `test-pc.remote.example.com`, authorization: BEARER },
        },
        (r) => {
          let text = ''
          r.on('data', (c) => (text += c))
          r.on('end', () => resolve({ status: r.statusCode, text }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert(sub.status === 200 && JSON.parse(sub.text).hello === 'world', 'subdomain forward failed')
    console.log('host-subdomain forward ok')
  }

  // 9. duplicate agent connection supersedes the first
  {
    const firstClose = waitClose(agent)
    const agent2 = await connectAgent(relay, 'test-pc', {
      onReq(frame, send) {
        send({ type: 'res', id: frame.id, status: 200, headers: { 'content-type': 'text/plain' }, body: b64('second') })
      },
    })
    const code = await firstClose
    assert(code === 4000, `superseded agent should close with 4000, got ${code}`)
    const res = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/api/hello`, { headers: { authorization: BEARER } })
    assert((await res.text()) === 'second', 'new agent should own the device')
    console.log('duplicate agent supersession ok')
  }

  // 10. agent disconnect flips the device offline and fails in-flight routes
  {
    const statusRes = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/status`, { headers: { authorization: BEARER } })
    const online = (await statusRes.json()).online
    assert(online === true, 'second agent should be online before teardown')
    const agent2Ws = relay.registry.lookup('test-pc').ws
    agent2Ws.close(1000, 'done')
    await waitClose(agent2Ws)
    const off = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/status`, { headers: { authorization: BEARER } })
    assert((await off.json()).online === false, 'device should be offline after agent close')
    const gone = await fetch(`http://127.0.0.1:${relay.port}/d/test-pc/api/hello`, { headers: { authorization: BEARER } })
    assert(gone.status === 503, `offline route should answer 503, got ${gone.status}`)
    console.log('agent disconnect -> offline ok')
  }

  // 11. heartbeat liveness: a responsive agent is pinged inside the idle
  //     window and survives it (regression: the coarse tick dropped healthy
  //     idle agents with 4001 "heartbeat timeout" before ever pinging them,
  //     so the device was offline more than online)
  {
    const hbRelay = await startRelay({
      port: 0,
      secret: SECRET,
      stateFile: join(stateDir, 'relay-state-hb.json'),
      heartbeatInterval: 3000,
      idleTimeout: 6000,
    })
    try {
      let pings = 0
      const ws = new WebSocket(`ws://127.0.0.1:${hbRelay.port}/agent?deviceId=hb-pc`, {
        headers: { authorization: BEARER },
      })
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'ping') {
          pings += 1
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      })
      await once(ws, 'open')
      // Wait past the idle timeout: the relay must ping within the window and
      // the agent's pongs must keep the socket open.
      await new Promise((resolve) => setTimeout(resolve, 8000))
      assert(ws.readyState === ws.OPEN, `responsive agent must survive the idle timeout, state=${ws.readyState}`)
      assert(pings >= 1, `relay must ping inside the idle window, got ${pings} pings`)
      console.log('heartbeat liveness ok')
      ws.close(1000, 'done')
    } finally {
      hbRelay.close()
    }
  }

  // 12. a user-defined persistent code can pair more than once and is stored
  // only as a relay-side hash; it never consumes the temporary-code map.
  {
    const persist = await fetch(`http://127.0.0.1:${relay.port}/persistent-pairing`, {
      method: 'POST', headers: { authorization: BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pair-pc', code: 'my-long-lived-code' }),
    })
    assert(persist.status === 200, `persistent code save failed: ${persist.status}`)
    for (let i = 0; i < 2; i += 1) {
      const paired = await fetch(`http://127.0.0.1:${relay.port}/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'pair-pc', code: 'my-long-lived-code' }),
      })
      const body = await paired.json()
      assert(paired.status === 200 && typeof body.phoneToken === 'string', `persistent code pairing ${i} failed`)
    }
    console.log('persistent pairing code ok')
  }

  console.log('test-relay: all checks passed')
} finally {
  relay.close()
  rmSync(stateDir, { recursive: true, force: true })
}
