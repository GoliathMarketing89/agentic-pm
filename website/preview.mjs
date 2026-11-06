import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/board-preview.jpg', ['assets/board-preview.jpg', 'image/jpeg']],
]);
http.createServer(async (request, response) => {
  let path;
  try { path = new URL(request.url, 'http://localhost').pathname; } catch { response.writeHead(400).end('Bad request'); return; }
  const file = files.get(path);
  if (!file || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end('Not found'); return; }
  try {
    const content = await readFile(join(root, file[0]));
    response.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(4192, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4192/'));
