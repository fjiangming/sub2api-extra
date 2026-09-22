'use strict';

const { Pool } = require('pg');

function sslOptions(mode) {
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

function createPool(connectionString, config, role) {
  if (!connectionString) return null;
  const pool = new Pool({
    connectionString,
    ssl: sslOptions(config.databaseSsl),
    max: role === 'maintenance' ? 1 : 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: role === 'maintenance' ? config.cleanupTimeoutMs : config.queryTimeoutMs,
    application_name: `sub2api-operations-center-${role}`
  });
  pool.on('error', (error) => console.error(`[database:${role}] idle client error`, error));
  return pool;
}

function createDatabase(config) {
  const read = createPool(config.databaseUrl, config, 'read');
  const maintenance = createPool(config.maintenanceDatabaseUrl, config, 'maintenance');
  return {
    read,
    maintenance,
    async ping() {
      const startedAt = Date.now();
      const result = await read.query('SELECT current_database() AS database, version() AS version, NOW() AS now');
      return { ...result.rows[0], latencyMs: Date.now() - startedAt };
    },
    async close() {
      await Promise.all([read?.end(), maintenance?.end()].filter(Boolean));
    }
  };
}

module.exports = { createDatabase, createPool };
