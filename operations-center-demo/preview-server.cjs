'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2] || 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/echarts.min.js', ['assets/echarts.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/lucide.js', ['assets/lucide.js', 'text/javascript; charset=utf-8']],
  ['/assets/sub2api.svg', ['assets/sub2api.svg', 'image/svg+xml']]
]);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const file = files.get(url.pathname);
  if (!file || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': file[1],
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(path.join(__dirname, file[0])).on('error', () => res.destroy()).pipe(res);
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Demo preview: http://127.0.0.1:${port}`));
