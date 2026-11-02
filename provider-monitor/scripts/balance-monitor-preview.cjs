const { createApplication } = require('../src/server');
const { createTestContext } = require('../tests/helpers');
const { AppError } = require('../src/errors');

async function startPreview({ port = 0 } = {}) {
  const context = createTestContext({ PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'preview-password' });
  const amounts = new Map([['supplier-a.example.test', 280], ['supplier-b.example.test', 45]]);
  const calls = [];
  const app = createApplication({ ...context, http: { async requestJson(url) {
    const target = new URL(url);
    calls.push(target.pathname);
    if (target.pathname !== '/balance' || !amounts.has(target.hostname)) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Preview endpoint unavailable', { status: 404 });
    }
    return { data: { balance: amounts.get(target.hostname) } };
  } } });
  const { providers, balances, queue } = app.locals.services;
  for (const [name, host, balanceInterval, assetInterval] of [
    ['示例供应商 A', 'supplier-a.example.test', 1, 15],
    ['示例供应商 B', 'supplier-b.example.test', 3, 45]
  ]) {
    const provider = providers.create({ name, adapterType: 'custom', baseUrl: `https://${host}`,
      credentials: { apiKey: 'preview-only-key' },
      balanceRefreshIntervalMinutes: balanceInterval, refreshIntervalMinutes: assetInterval,
      warningThreshold: 100, secondaryWarningThreshold: 20, thresholdCurrency: 'USD',
      typeConfig: { requests: { accountBalance: { path: '/balance', availableJsonPath: '$.balance' } } } });
    context.db.prepare('UPDATE provider_connections SET last_success_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 8 * 60000).toISOString(), provider.id);
    await balances.run(provider.id);
  }
  providers.create({ name: '已暂停的示例供应商', adapterType: 'custom', baseUrl: 'https://paused.example.test',
    credentials: {}, enabled: false, balanceRefreshIntervalMinutes: 5, refreshIntervalMinutes: 120 });
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  balances.start();
  queue.start();
  return { app, port: server.address().port, amounts, calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await app.locals.close();
      context.cleanup();
    }
  };
}

if (require.main === module) {
  startPreview({ port: Number(process.env.BALANCE_PREVIEW_PORT || 0) }).then((preview) => {
    console.log(`Balance preview: http://127.0.0.1:${preview.port} (admin / preview-password)`);
    const close = async () => { await preview.close(); process.exit(0); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { startPreview };
