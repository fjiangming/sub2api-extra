'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const allowed = new Set(['/index.html', '/styles.css', '/app.js', '/assets/lucide.min.js']);
for (const name of fs.readdirSync(path.join(__dirname, 'assets'))) {
  if (/^[a-z-]+\.jpg$/.test(name)) allowed.add('/assets/' + name);
}
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.jpg': 'image/jpeg' };
const port = Number(process.argv[2] || 8786);

http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const resource = pathname === '/' ? '/index.html' : pathname;
  if (!['GET', 'HEAD'].includes(req.method) || !allowed.has(resource)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, resource.slice(1)), (error, contents) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(resource)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : contents);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('Leaderboard demo: http://127.0.0.1:' + port);
});
