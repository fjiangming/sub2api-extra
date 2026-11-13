'use strict';

const express = require('express');
const { domainAccessFixture } = require('../tests/domain-access-fixture');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

async function startPreview({ port = Number(process.env.DOMAIN_ACCESS_PREVIEW_PORT || 19899), now = Date.now() } = {}) {
  const fixture = await domainAccessFixture({ now });
  const auth = new AuthService(fixture.config);
  const app = createApp({ config: fixture.config, auth, database: {}, messages: fixture.messages,
    domainAccess: fixture.service, settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: fixture.config.adminUser, password: fixture.config.adminPassword }); res.redirect('/#domains'); }
    catch (error) { next(error); }
  }); outer.use(app);
  let server;
  while (!server) {
    try { server = await new Promise((resolve, reject) => { const value = outer.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(value)); value.once('error', reject); }); }
    catch (error) { if (error.code !== 'EADDRINUSE') { auth.close(); await fixture.close(); throw error; } port++; }
  }
  let stopped = false;
  return { port: server.address().port, fixture, async stop() { if (stopped) return; stopped = true; auth.close(); await new Promise(resolve => server.close(resolve)); await fixture.close(); } };
}
if (require.main === module) startPreview().then(preview => {
  console.log(`Domain Access formal-page preview (fictional local data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => preview.stop().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { startPreview };
