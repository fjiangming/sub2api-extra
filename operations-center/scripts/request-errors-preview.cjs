'use strict';

const express = require('express');
const { requestErrorsFixture } = require('../tests/request-errors-fixture');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { loadConfig } = require('../src/config');

async function startPreview({ port = Number(process.env.REQUEST_ERRORS_PREVIEW_PORT || 19892) } = {}) {
  const fixture = await requestErrorsFixture({ now: new Date() });
  const read = fixture.service.source.read.bind(fixture.service.source);
  fixture.service.source.read = async (...args) => {
    const data = await read(...args);
    return { ...data, coverage: { ...data.coverage, warning: '示例数据 · 仅本地模拟，用于核对页面与分类，不代表生产日志或采集覆盖。' } };
  };
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'request-errors-local-preview' });
  const auth = new AuthService(config);
  const app = createApp({ config, auth, database: {}, requestErrors: fixture.service,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: config.adminUser, password: config.adminPassword }); res.redirect('/#errors'); }
    catch (error) { next(error); }
  }); outer.use(app);
  let server;
  while (!server) {
    try { server = await new Promise((resolve, reject) => { const s = outer.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(s)); s.once('error', reject); }); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; port++; }
  }
  let stopped = false;
  return { fixture, port: server.address().port, async stop() { if (stopped) return; stopped = true; auth.close(); await new Promise(resolve => server.close(resolve)); await fixture.close(); } };
}
if (require.main === module) startPreview().then(preview => {
  console.log(`Error analysis preview (example data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.stop().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { startPreview };
