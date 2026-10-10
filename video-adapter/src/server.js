'use strict';

const { loadConfig,loadCatalog } = require('./config');
const { createDatabase } = require('./db');
const { createCache } = require('./cache');
const { Store } = require('./store');
const { SafeHttpClient } = require('./http-client');
const { ProviderRegistry,MockProvider } = require('./providers');
const { Worker } = require('./worker');
const { createApp } = require('./app');
const { AppError } = require('./errors');

async function main() {
  const config = loadConfig(process.env,process.argv.includes('--demo'));
  const demo = config.production ? null : require('./demo');
  const catalog = demo ? demo.demoCatalog() : loadCatalog(config);
  let db,cache,http,worker,server,closing;
  const shutdown = () => closing ||= (async () => {
    const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    const deadline = server && setTimeout(() => server.closeAllConnections(),60000);
    deadline?.unref();
    await worker?.stop();
    await closed;
    clearTimeout(deadline);
    await Promise.allSettled([cache?.close(),http?.close()]);
    await db?.close();
  })();
  try {
    db = demo ? await demo.createDemoDatabase() : await createDatabase(config);
    cache = await createCache(db,config);
    http = new SafeHttpClient(config.requestTimeoutMs);
    const registry = new ProviderRegistry(http);
    if (demo) registry.register('mock',new MockProvider());
    const store = new Store(db,config,cache);
    worker = new Worker(store,registry,cache,config,catalog);
    const app = createApp({ store,registry,cache,catalog,config,worker });
    server = await new Promise((resolve,reject) => {
      const candidate = app.listen(config.port,config.host,error => error ? reject(error) : resolve(candidate));
      candidate.once('error',reject);
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 60000;
    worker.start();
    console.log(JSON.stringify({ event:'listening',host:config.host,port:config.port,mode:demo ? 'demo' : 'production',catalog:catalog.version }));
    if (demo) console.log('Demo API key: sk-demo-video-local-only; admin token: demo-admin-local-only; no external generation calls.');
    const stop = () => void shutdown().catch(() => { console.error(JSON.stringify({ event:'shutdown_failed' })); process.exitCode=1; });
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
    return { server,shutdown };
  } catch (error) { await shutdown().catch(() => {}); throw error; }
}

if (require.main===module) main().catch(error => {
  console.error(JSON.stringify({ event:'startup_failed',code:error instanceof AppError ? error.code : 'STARTUP_FAILED',
    message:error instanceof AppError ? error.message : 'Startup failed; check configuration and dependency access' }));
  process.exitCode=1;
});

module.exports = { main };
