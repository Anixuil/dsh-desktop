// Minimal HTTP CONNECT proxy for cargo builds inside the sandbox.
// schannel cannot reach the Windows cert store here; Node's bundled CA works,
// so cargo tunnels through this proxy and Node performs the TLS.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PROXY_PORT ?? 8899);

const server = createServer((req, res) => {
  // plain-HTTP forwarding (absolute-form) — rare, but harmless to support
  const url = new URL(req.url);
  const out = httpRequest(
    { host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  out.on('error', () => res.writeHead(502).end());
  req.pipe(out);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  const upstream = connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[https-proxy] listening on 127.0.0.1:${PORT}`);
});
