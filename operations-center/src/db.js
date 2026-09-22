'use strict';

const { Pool } = require('pg');
const { AppError } = require('./errors');

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

function connectionSummary(connectionString) {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username)
    };
  } catch {
    return { host: null, port: null, database: null, user: null };
  }
}

class SwitchablePool {
  constructor(role, pool = null, connectionString = null) {
    this.role = role;
    this.pool = pool;
    this.connectionString = connectionString;
  }

  configured() {
    return Boolean(this.pool);
  }

  requirePool() {
    if (!this.pool) {
      throw new AppError(
        'DATABASE_NOT_CONFIGURED',
        this.role === 'read' ? '尚未配置 Sub2API 数据库读取连接' : '尚未配置独立清理连接',
        { status: 503 }
      );
    }
    return this.pool;
  }

  query(...args) {
    return this.requirePool().query(...args);
  }

  connect(...args) {
    return this.requirePool().connect(...args);
  }

  async swap(pool, connectionString) {
    const previous = this.pool;
    this.pool = pool;
    this.connectionString = connectionString || null;
    if (previous && previous !== pool) await previous.end();
  }

  async end() {
    const current = this.pool;
    this.pool = null;
    this.connectionString = null;
    await current?.end();
  }
}

function createDatabase(config) {
  const read = new SwitchablePool('read', createPool(config.databaseUrl, config, 'read'), config.databaseUrl);
  const maintenance = new SwitchablePool(
    'maintenance',
    createPool(config.maintenanceDatabaseUrl, config, 'maintenance'),
    config.maintenanceDatabaseUrl
  );

  return {
    read,
    maintenance,
    configured(role = 'read') {
      return role === 'maintenance' ? maintenance.configured() : read.configured();
    },
    status() {
      return {
        read: {
          configured: read.configured(),
          source: config.databaseSource,
          connection: connectionSummary(read.connectionString)
        },
        maintenance: {
          configured: maintenance.configured(),
          source: config.maintenanceDatabaseSource,
          connection: connectionSummary(maintenance.connectionString)
        },
        sslMode: config.databaseSsl
      };
    },
    async ping(role = 'read') {
      const selected = role === 'maintenance' ? maintenance : read;
      const startedAt = Date.now();
      const result = await selected.query(
        'SELECT current_database() AS database, current_user AS "user", version() AS version, NOW() AS now'
      );
      return { ...result.rows[0], latencyMs: Date.now() - startedAt };
    },
    async reconfigure({ readUrl, maintenanceUrl = null, sslMode = config.databaseSsl, source = 'managed' }) {
      const candidateConfig = { ...config, databaseSsl: sslMode };
      const candidateRead = createPool(readUrl, candidateConfig, 'read');
      const candidateMaintenance = createPool(maintenanceUrl, candidateConfig, 'maintenance');
      try {
        if (!candidateRead) throw new AppError('READ_DATABASE_REQUIRED', '读取数据库连接不能为空', { status: 400 });
        await candidateRead.query('SELECT 1');
        if (candidateMaintenance) await candidateMaintenance.query('SELECT 1');
      } catch (error) {
        await Promise.all([candidateRead?.end(), candidateMaintenance?.end()].filter(Boolean));
        throw error;
      }
      await read.swap(candidateRead, readUrl);
      await maintenance.swap(candidateMaintenance, maintenanceUrl);
      config.databaseUrl = readUrl;
      config.maintenanceDatabaseUrl = maintenanceUrl;
      config.databaseSsl = sslMode;
      config.databaseSource = source;
      config.maintenanceDatabaseSource = maintenanceUrl ? source : 'none';
      return this.status();
    },
    async close() {
      await Promise.all([read.end(), maintenance.end()]);
    }
  };
}

module.exports = { createDatabase, createPool, sslOptions, connectionSummary, SwitchablePool };
