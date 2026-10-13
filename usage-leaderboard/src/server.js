'use strict';

const { loadConfig } = require('./config');
const { createDatabase, SchemaInspector } = require('./db');
const { Sub2ApiClient } = require('./sub2api-client');
const { AuthService } = require('./auth');
const { UsageRepository } = require('./repository');
const { LeaderboardService } = require('./leaderboard');
const { createApp } = require('./app');

function createRuntime(config, { database = createDatabase(config), client = new Sub2ApiClient(config) } = {}) {
  const inspector = new SchemaInspector(database);
  const auth = new AuthService(config, client);
  const leaderboard = new LeaderboardService(new UsageRepository(database, config), inspector, config);
  const app = createApp({ config, database, inspector, auth, leaderboard });
  return { app, database, inspector, auth, leaderboard,
    async close() { auth.close(); leaderboard.close(); await database.close(); } };
}

function listen(runtime, config) {
  const server = runtime.app.listen(config.port, config.bindHost, () => {
    console.log(`[usage-leaderboard] listening on http://${config.bindHost}:${config.port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 20000);
    timer.unref();
    server.close(async () => {
      await runtime.close();
      clearTimeout(timer);
    });
    server.closeIdleConnections();
  };
  server.on('error', async (error) => {
    console.error(`[usage-leaderboard] ${error.code || 'LISTEN_FAILED'}`);
    await runtime.close();
    process.exitCode = 1;
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

if (require.main === module) {
  try { const config = loadConfig(); listen(createRuntime(config), config); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createRuntime, listen };
