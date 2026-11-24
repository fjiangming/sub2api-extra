'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const publicRoot = path.resolve(__dirname, '..', 'public');
const lucideFile = require.resolve('lucide/dist/umd/lucide.js');
const port = Number(process.env.ACTIVITY_COMPENSATION_DEMO_PORT || 19928);
const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function safeFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = decoded === '/' || decoded === '/demo' || decoded === '/demo/'
    ? path.join(publicRoot, 'demo', 'compensation-lottery.html')
    : decoded === '/vendor/lucide.js'
      ? lucideFile
      : path.resolve(publicRoot, `.${decoded}`);
  if (target !== lucideFile && (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`))) return null;
  return target;
}

const server = http.createServer((request, response) => {
  try {
    const target = safeFile(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!target) { response.writeHead(404); response.end('Not found'); return; }
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': types.get(path.extname(target)) || 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404); response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Compensation demo: http://127.0.0.1:${port}/demo/compensation-lottery.html`));
const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
