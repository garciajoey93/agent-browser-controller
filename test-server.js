// Tiny static file server for test-page.html. Listens on :9333.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '9333', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/test-page.html';
    const safe = normalize(join(__dirname, p));
    if (!safe.startsWith(__dirname)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const body = await readFile(safe);
    res.writeHead(200, {
      'Content-Type': MIME[extname(safe)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`test page: http://127.0.0.1:${PORT}/`);
});
