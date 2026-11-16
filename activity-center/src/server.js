'use strict';

const { loadConfig } = require('./config');
const { AuthService } = require('./auth');
const { CoreClient } = require('./upstream');
const { RechargeSource } = require('./recharge-source');
const { Store } = require('./store');
const { Lottery } = require('./lottery');
const { createApp } = require('./app');

function createRuntime(env = process.env, options = {}) {
  const config = options.config || loadConfig(env);
  const core = options.core || new CoreClient(config);
  const source = options.source || new RechargeSource(config);
  const store = options.store || new Store(config, options.storeOptions);
  const auth = new AuthService(config, core);
  const lottery = new Lottery(store, source, core);
  const app = createApp({ config, auth, store, lottery });
  if (options.worker !== false) lottery.start();
  return { app, config, core, source, store, auth, lottery,
    async close() { auth.close(); await lottery.close(); await source.close?.(); store.close(); } };
}

if (require.main === module) {
  try {
    const runtime = createRuntime();
    const server = runtime.app.listen(runtime.config.port, runtime.config.bindHost, () => console.log(`[activity-center] listening on ${runtime.config.bindHost}:${runtime.config.port}`));
    server.requestTimeout = 45000;
    server.headersTimeout = 15000;
    let stopping = false;
    const close = async () => {
      if (stopping) return;
      stopping = true;
      await new Promise(resolve => server.close(resolve));
      await runtime.close();
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  } catch (error) { console.error(`[activity-center] ${error.message}`); process.exitCode = 1; }
}

module.exports = { createRuntime };
