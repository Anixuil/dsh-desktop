// Plain-HTTP mirror for crates.io, for sandboxed builds where cargo's
// schannel backend cannot reach the Windows cert store.
//   /index/**   -> https://index.crates.io/**  (config.json dl rewritten to this mirror)
//   /crates/**  -> https://static.crates.io/crates/**
// All TLS happens in Node (bundled CA), cargo speaks plain HTTP.
import { createServer } from 'node:http';

const PORT = Number(process.env.MIRROR_PORT ?? 8900);
const INDEX = 'https://index.crates.io';
const DL = 'https://static.crates.io/crates';

const server = createServer(async (req, res) => {
  try {
    let target;
    if (req.url.startsWith('/index/')) target = INDEX + req.url.slice('/index'.length);
    else if (req.url.startsWith('/crates/')) target = DL + req.url.slice('/crates'.length);
    else {
      res.writeHead(404);
      res.end();
      return;
    }
    const resp = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!resp.ok) {
      res.writeHead(resp.status);
      res.end();
      return;
    }
    let buf = Buffer.from(await resp.arrayBuffer());
    let contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    if (req.url === '/index/config.json') {
      // point cargo's crate downloads back at this mirror
      const cfg = JSON.parse(buf.toString('utf8'));
      cfg.dl = `http://127.0.0.1:${PORT}/crates`;
      buf = Buffer.from(JSON.stringify(cfg));
      contentType = 'application/json';
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e?.message ?? e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[cargo-mirror] listening on http://127.0.0.1:${PORT}`);
});
