// dsh-desktop-bridge — legacy credentials endpoint.
//
// The shell's settings window writes the DeepSeek key here (POST /set-key |
// /unset-key); delivery goes through the official credentials service, looked
// up lazily per request via the injected getter.
import { createServer } from 'node:http'

/**
 * Start the standalone bridge HTTP listener.
 * @param port - listen port (0 = ephemeral, used by tests).
 * @param getCredentials - returns the cordis credentials service (or undefined).
 * @returns { close } — dispose handle.
 */
export function startCredentialsServer({ port, host = '127.0.0.1', getCredentials }) {
  let server
  try {
    server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/ping' || req.url === '/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, name: 'dsh-desktop-bridge', version: '0.2.0' }))
          return
        }
        if (req.method === 'POST' && (req.url === '/set-key' || req.url === '/unset-key')) {
          let body = ''
          for await (const chunk of req) body += chunk
          const data = JSON.parse(body || '{}')
          const credentials = getCredentials()
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
    server.listen(port, host, () => {
      console.log(`[dsh-desktop-bridge] listening on ${host}:${port}`)
    })
    server.on('error', (error) => {
      console.error(`[dsh-desktop-bridge] server error: ${error?.message ?? error}`)
    })
  } catch (error) {
    console.error(`[dsh-desktop-bridge] failed to start: ${error?.message ?? error}`)
  }
  return {
    close: () => {
      if (server !== undefined) server.close()
    },
  }
}
