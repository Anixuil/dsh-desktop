// dsh-desktop-bridge — Cordis host plugin mounted into the dsh web profile by
// DSH Desktop. It is the shell's window into DSH:
//   * listens for `agent/status` idle transitions and POSTs /turn-end to the shell
//   * serves POST /set-key | /unset-key so the shell can write the DeepSeek key
//     through the official credentials service
import { createServer } from 'node:http'

export const name = 'dsh-desktop-bridge'

export function apply(ctx, config) {
  const port = Number(config?.port ?? 38658)
  const shellPort = Number(config?.shellPort ?? 38657)
  let lastRunning = false
  let notified = false

  const notifyTurnEnd = () => {
    fetch(`http://127.0.0.1:${shellPort}/turn-end`, { method: 'POST' }).catch(() => {})
  }

  ctx.on('agent/status', (payload) => {
    const status = payload?.status
    if (status === 'running') {
      lastRunning = true
      notified = false
      return
    }
    if (status === 'idle' && lastRunning && !notified) {
      lastRunning = false
      notified = true
      notifyTurnEnd()
    }
  })

  let server
  try {
    server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/ping' || req.url === '/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, name, version: '0.1.0' }))
          return
        }
        if (req.method === 'POST' && (req.url === '/set-key' || req.url === '/unset-key')) {
          let body = ''
          for await (const chunk of req) body += chunk
          const data = JSON.parse(body || '{}')
          const credentials = ctx.get('credentials')
          if (credentials === undefined) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'no credentials service in this profile' }))
            return
          }
          if (req.url === '/set-key') {
            const key = String(data.key ?? '')
            if (key === '') throw new Error('empty key')
            await credentials.set('DEEPSEEK_API_KEY', key)
          } else {
            await credentials.unset('DEEPSEEK_API_KEY')
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`[dsh-desktop-bridge] listening on 127.0.0.1:${port}`)
    })
    server.on('error', (error) => {
      console.error(`[dsh-desktop-bridge] server error: ${error?.message ?? error}`)
    })
  } catch (error) {
    console.error(`[dsh-desktop-bridge] failed to start: ${error?.message ?? error}`)
  }

  ctx.on('dispose', () => {
    if (server !== undefined) server.close()
  })
}
