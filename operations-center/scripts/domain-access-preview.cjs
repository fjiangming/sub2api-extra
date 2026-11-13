'use strict';

const path = require('node:path');
const express = require('express');

async function startPreview({ port = Number(process.env.DOMAIN_ACCESS_PREVIEW_PORT || 19898) } = {}) {
  const app = express();
  const root = path.resolve(__dirname, '..');
  const demo = path.join(__dirname, 'domain-access-demo');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
    next();
  });
  app.get('/', (req, res) => res.sendFile(path.join(demo, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(root, 'public/styles.css')));
  app.get('/vendor/lucide.js', (req, res) => res.sendFile(path.join(root, 'node_modules/lucide/dist/umd/lucide.min.js')));
  app.get('/vendor/echarts.js', (req, res) => res.sendFile(path.join(root, 'node_modules/echarts/dist/echarts.min.js')));
  app.use('/demo', express.static(demo, { index: false, dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  let server;
  for (let attempts = 0; !server && attempts < 20; attempts++) {
    try {
      server = await new Promise((resolve, reject) => {
        const candidate = app.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(candidate));
        candidate.once('error', reject);
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === 0) throw error;
      port++;
    }
  }
  if (!server) throw new Error('No preview port available');
  return { port: server.address().port, stop: () => new Promise(resolve => server.close(resolve)) };
}

if (require.main === module) startPreview().then(preview => {
  console.log(`Domain access demo (fictional data): http://127.0.0.1:${preview.port}/`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.stop().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { startPreview };
