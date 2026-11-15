const { createApplication } = require('../src/server');
const { createTestContext } = require('../tests/helpers');
const { historyOptions } = require('../src/services/recharge-rate-history');
const { startOfDateInTimezone } = require('../src/services/gross-profit-service');
const { AppError } = require('../src/errors');

async function startPreview({ port = 0 } = {}) {
  const context = createTestContext({ PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'preview-password' });
  const app = createApplication({ ...context, startBackground: false, http: {
    async requestJson(input) {
      const url = new URL(input);
      if (url.pathname === '/api/v1/user/profile') return { data: { code: 0, data: { id: 7, username: 'preview-only' } } };
      if (url.pathname === '/api/v1/usage/stats') return { data: { code: 0, data: { total_actual_cost: 100, total_requests: 255 } } };
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Preview endpoint unavailable', { status: 404 });
    }
  } });
  const providers = app.locals.services.providers;
  const { today, timezone } = historyOptions(context.config);
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const midnight = startOfDateInTimezone(yesterday, timezone).getTime();
  const provider = providers.create({ name: 'Initial rate example', adapterType: 'sub2api',
    baseUrl: 'https://initial-rate.example', authMode: 'token_pair',
    credentials: { accessToken: 'preview-only-access-token' }, enabled: true });
  context.db.prepare('UPDATE provider_connections SET created_at=? WHERE id=?')
    .run(new Date(midnight + 35 * 60000).toISOString(), provider.id);
  providers.recordRecharge(provider.id, { available: false }, new Date(midnight + 36 * 60000).toISOString());
  providers.recordRecharge(provider.id, { multiplier: 10, paidCurrency: 'CNY', balanceCurrency: 'USD',
    source: 'provider_payment_config' }, new Date(midnight + 47 * 60000).toISOString());
  context.db.prepare("INSERT OR REPLACE INTO settings VALUES ('currencyRates', ?, ?)")
    .run(JSON.stringify({ USD: 1, CNY: 1 }), new Date().toISOString());
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { app, db: context.db, port: server.address().port, providerId: provider.id, yesterday, today,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await app.locals.close();
      context.cleanup();
    }
  };
}

if (require.main === module) {
  startPreview({ port: Number(process.env.RECHARGE_HISTORY_PREVIEW_PORT || 0) }).then(preview => {
    console.log(`Recharge history preview: http://127.0.0.1:${preview.port} (admin / preview-password)`);
    const close = async () => { await preview.close(); process.exit(0); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { startPreview };
