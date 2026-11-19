'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const files = new Map([
  ['/admin/config', ['index.html', 'text/html; charset=utf-8']],
  ['/demo.css', ['demo.css', 'text/css; charset=utf-8']],
  ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['/vendor/lucide.min.js', ['../../node_modules/lucide/dist/umd/lucide.min.js', 'text/javascript; charset=utf-8']],
  ['/detector-icon.svg', ['../../public/degradation-detector-icon.svg', 'image/svg+xml']]
]);

function createPreview(port = 19964) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); return response.end(); }
    if (pathname === '/') { response.writeHead(302, { Location: '/admin/config' }); return response.end(); }
    if (pathname === '/healthz') { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end('{"ok":true,"demo":true}'); }
    const file = files.get(pathname);
    if (!file) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, {
      'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    if (request.method === 'HEAD') return response.end();
    const stream = fs.createReadStream(path.resolve(__dirname, file[0]));
    stream.on('error', () => response.destroy()); stream.pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (require.main === module) createPreview(Number(process.argv[2] || 19964)).then(({ server, url }) => {
  console.log(`Three-level configuration demo: ${url}/admin/config`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { createPreview };
