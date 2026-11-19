'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// This preview serves only a fixed set of static demo files. No production APIs.
const files = new Map([
  ['/results', ['index.html', 'text/html; charset=utf-8']],
  ['/admin/config', ['index.html', 'text/html; charset=utf-8']],
  ['/demo.css', ['demo.css', 'text/css; charset=utf-8']],
  ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['/pelican.html', ['pelican.html', 'text/html; charset=utf-8']],
  ['/pelican-source.js', ['pelican.html', 'text/javascript; charset=utf-8']],
  ['/vendor/lucide.min.js', ['../../node_modules/lucide/dist/umd/lucide.min.js', 'text/javascript; charset=utf-8']],
  ['/detector-icon.svg', ['../../public/degradation-detector-icon.svg', 'image/svg+xml']],
]);

function createPreview(port = 19960) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end();
    }
    if (pathname === '/') {
      response.writeHead(302, { Location: '/results' });
      return response.end();
    }
    if (pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end('{"ok":true,"demo":true}');
    }
    const entry = files.get(pathname);
    if (!entry) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    });
    if (request.method === 'HEAD') return response.end();
    if (pathname === '/pelican-source.js') {
      return response.end('window.demoPelicanSource = ' + JSON.stringify(fs.readFileSync(path.join(__dirname, entry[0]), 'utf8')) + ';');
    }
    fs.createReadStream(path.resolve(__dirname, entry[0])).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 19960);
  createPreview(port).then(({ url }) => console.log(`Demo: ${url}/results\nAdmin: ${url}/admin/config`)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createPreview };
