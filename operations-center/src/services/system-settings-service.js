'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { AppError } = require('../errors');
const { sslOptions } = require('../db');
const { REQUIRED_TABLES } = require('../schema-inspector');
const { POLICY_DEFINITIONS, poolConfigured } = require('./retention-service');

const MANAGED_ROLE_COMMENT = 'managed-by:sub2api-operations-center:v1';
const ROLE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const CLEANUP_TABLES = [...new Set(Object.values(POLICY_DEFINITIONS)
  .flatMap((definition) => definition.tables.map((item) => item.table)))];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildConnectionUrl(input, username, password) {
  const url = new URL('postgresql://localhost');
  url.hostname = input.host;
  url.port = String(input.port);
  url.pathname = `/${input.database}`;
  url.username = username;
  url.password = password;
  return url.toString();
}

function generatedPassword() {
  return crypto.randomBytes(36).toString('base64url');
}

function checkResult(id, label, status, detail, extra = {}) {
  return { id, label, status, detail, ...extra };
}

function setupError(error, password) {
  if (error instanceof AppError) return error;
  let message = String(error?.message || '连接失败');
  if (password) message = message.replaceAll(String(password), '[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-database-url]');
  return new AppError('DATABASE_SETUP_FAILED', `数据库初始化失败：${message}`, { status: 502 });
}

class SystemSettingsService {
  constructor({ config, database, settingsStore, inspector, storage, retention, scheduler, sub2api, poolFactory }) {
    this.config = config;
    this.database = database;
    this.settingsStore = settingsStore;
    this.inspector = inspector;
    this.storage = storage;
    this.retention = retention;
    this.scheduler = scheduler;
    this.sub2api = sub2api;
    this.poolFactory = poolFactory || ((options) => new Pool(options));
  }

  getStatus() {
    const database = this.database.status();
    return {
      generatedAt: new Date().toISOString(),
      setupRequired: !database.read.configured,
      databaseSetupEnabled: this.config.databaseSetupEnabled,
      database,
      authentication: {
        mode: this.config.authMode,
        sub2apiBaseUrlConfigured: Boolean(this.config.sub2apiBaseUrl),
        sub2apiPublicUrl: this.config.sub2apiPublicUrl || null,
        persistentAdminCredentialsConfigured: this.sub2api.persistentCredentialsConfigured(),
        persistentCredentialSource: this.config.sub2apiCredentialSource || 'session',
        persistentCredentialType: this.config.sub2apiAdminToken
          ? 'token'
          : (this.config.sub2apiAdminEmail && this.config.sub2apiAdminPassword ? 'account' : 'session'),
        sessionCredentialAvailable: this.sub2api.configured()
      },
      cleanup: {
        enabled: this.config.cleanupEnabled,
        maintenanceConnectionConfigured: poolConfigured(this.database.maintenance),
        freshBackupRequired: this.config.requireFreshBackup,
        previewTtlMinutes: this.config.previewTtlMinutes,
        automatic: { ...this.config.automaticCleanup },
        retention: { ...this.config.retention }
      },
      persistence: {
        dataDirectory: this.config.dataDir,
        encrypted: true
      }
    };
  }

  bootstrapPool(input) {
    return this.poolFactory({
      host: input.host,
      port: input.port,
      database: input.database,
      user: input.username,
      password: input.password,
      ssl: sslOptions(input.sslMode),
      max: 1,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      application_name: 'sub2api-operations-center-setup'
    });
  }

  async inspectBootstrap(client) {
    const identity = (await client.query(`
      SELECT current_database() AS database, current_user AS "user",
             role.rolsuper, role.rolcreaterole,
             EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') AS public_schema
      FROM pg_roles role WHERE role.rolname = current_user
    `)).rows[0];
    const owners = (await client.query(`
      SELECT DISTINCT owner.rolname AS owner,
             pg_has_role(current_user, owner.oid, 'MEMBER') AS manageable
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_roles owner ON owner.oid = relation.relowner
      WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
      ORDER BY owner.rolname
    `)).rows;
    return {
      ...identity,
      owners,
      canCreateRoles: identity.rolsuper || identity.rolcreaterole,
      canManageAllOwners: identity.rolsuper || owners.every((owner) => owner.manageable)
    };
  }

  async testDatabaseAdministrator(input) {
    const pool = this.bootstrapPool(input);
    try {
      const client = await pool.connect();
      try {
        const inspection = await this.inspectBootstrap(client);
        return {
          connected: true,
          database: inspection.database,
          user: inspection.user,
          canCreateRoles: inspection.canCreateRoles,
          canGrantCurrentTables: inspection.canManageAllOwners,
          publicSchemaAvailable: inspection.public_schema,
          tableOwners: inspection.owners.map((owner) => owner.owner)
        };
      } finally {
        client.release();
      }
    } catch (error) {
      throw setupError(error, input.password);
    } finally {
      await pool.end();
    }
  }

  async prepareRole(client, role, password) {
    if (!ROLE_PATTERN.test(role)) {
      throw new AppError('INVALID_ROLE_NAME', '数据库角色名格式无效', { status: 400 });
    }
    const existing = (await client.query(`
      SELECT role.rolname, shobj_description(role.oid, 'pg_authid') AS comment
      FROM pg_roles role WHERE role.rolname = $1
    `, [role])).rows[0];
    if (existing && existing.comment !== MANAGED_ROLE_COMMENT) {
      throw new AppError('DATABASE_ROLE_EXISTS', `数据库角色 ${role} 已存在且不由运营中心管理，请更换角色名`, {
        status: 409
      });
    }
    if (existing) {
      const ownership = (await client.query(`
        SELECT
          (SELECT COUNT(*) FROM pg_class WHERE relowner = role.oid) +
          (SELECT COUNT(*) FROM pg_namespace WHERE nspowner = role.oid) +
          (SELECT COUNT(*) FROM pg_database WHERE datdba = role.oid) AS owned_objects
        FROM pg_roles role WHERE role.rolname = $1
      `, [role])).rows[0];
      if (Number(ownership?.owned_objects || 0) > 0) {
        throw new AppError('MANAGED_ROLE_OWNS_OBJECTS', `受管角色 ${role} 当前拥有数据库对象，已拒绝自动轮换`, {
          status: 409
        });
      }
    }
    if (!existing) await client.query(`CREATE ROLE ${quoteIdentifier(role)}`);
    await client.query(`
      ALTER ROLE ${quoteIdentifier(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)}
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8
      VALID UNTIL 'infinity'
    `);
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} RESET ALL`);
    await client.query(`COMMENT ON ROLE ${quoteIdentifier(role)} IS ${quoteLiteral(MANAGED_ROLE_COMMENT)}`);
    const memberships = (await client.query(`
      SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = $1
    `, [role])).rows;
    for (const membership of memberships) {
      await client.query(`REVOKE ${quoteIdentifier(membership.rolname)} FROM ${quoteIdentifier(role)}`);
    }
  }

  async provisionDatabase(input) {
    if (!this.config.databaseSetupEnabled) {
      throw new AppError('DATABASE_SETUP_DISABLED', '页面数据库初始化已被部署配置关闭', { status: 403 });
    }
    if (input.readRole === input.maintenanceRole && input.createMaintenance) {
      throw new AppError('DATABASE_ROLES_MUST_DIFFER', '只读角色和清理角色不能相同', { status: 400 });
    }
    if (!input.createMaintenance && this.config.cleanupEnabled) {
      throw new AppError('MAINTENANCE_ROLE_REQUIRED', '清理已启用，不能移除独立清理角色', { status: 409 });
    }
    const pool = this.bootstrapPool(input);
    const readPassword = generatedPassword();
    const maintenancePassword = input.createMaintenance ? generatedPassword() : null;
    let client;
    let inspection;
    let grantedTables = [];
    let monitoringGranted = false;
    let publicSchemaHardened = false;
    const warnings = [];
    try {
      client = await pool.connect();
      inspection = await this.inspectBootstrap(client);
      if (!inspection.public_schema) {
        throw new AppError('PUBLIC_SCHEMA_MISSING', '目标数据库不存在 public schema', { status: 409 });
      }
      if (!inspection.canCreateRoles) {
        throw new AppError('CREATE_ROLE_REQUIRED', '该数据库账号没有 CREATEROLE 权限', { status: 403 });
      }
      if (!inspection.canManageAllOwners) {
        throw new AppError('TABLE_OWNER_PRIVILEGE_REQUIRED', '该数据库账号不能为全部现有业务表授权', {
          status: 403,
          details: { owners: inspection.owners.filter((owner) => !owner.manageable).map((owner) => owner.owner) }
        });
      }
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sub2api-operations-center-role-setup'))");
      await this.prepareRole(client, input.readRole, readPassword);
      if (input.createMaintenance) {
        await this.prepareRole(client, input.maintenanceRole, maintenancePassword);
      }

      const databaseName = quoteIdentifier(inspection.database);
      const readRole = quoteIdentifier(input.readRole);
      await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${databaseName} FROM ${readRole}`);
      await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${readRole}`);
      await client.query(`REVOKE ALL ON SCHEMA public FROM ${readRole}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${readRole}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${readRole}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${readRole}`);
      const readCanCreate = (await client.query(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS can_create`,
        [input.readRole]
      )).rows[0]?.can_create === true;
      if (readCanCreate) {
        if (!input.hardenPublicSchema) {
          throw new AppError(
            'PUBLIC_SCHEMA_CREATE_PRIVILEGE',
            '数据库向 PUBLIC 授予了 public Schema 建表权限；请勾选 Schema 安全加固后重试',
            { status: 409 }
          );
        }
        await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        publicSchemaHardened = true;
      }
      for (const owner of inspection.owners) {
        await client.query(`
          ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner.owner)} IN SCHEMA public
          GRANT SELECT ON TABLES TO ${readRole}
        `);
      }
      if (input.grantMonitoring) {
        await client.query('SAVEPOINT grant_monitoring');
        try {
          await client.query(`GRANT pg_monitor TO ${readRole}`);
          monitoringGranted = true;
          await client.query('RELEASE SAVEPOINT grant_monitoring');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT grant_monitoring');
          warnings.push('当前数据库管理员不能授予 pg_monitor；核心统计不受影响，部分运行诊断会显示不可用。');
        }
      }

      if (input.createMaintenance) {
        const maintenanceRole = quoteIdentifier(input.maintenanceRole);
        await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${databaseName} FROM ${maintenanceRole}`);
        await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${maintenanceRole}`);
        await client.query(`REVOKE ALL ON SCHEMA public FROM ${maintenanceRole}`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${maintenanceRole}`);
        await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${maintenanceRole}`);
        const existing = (await client.query(`
          SELECT relation.relname
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p')
            AND relation.relname = ANY($1::text[])
          ORDER BY relation.relname
        `, [CLEANUP_TABLES])).rows.map((row) => row.relname);
        grantedTables = existing;
        if (existing.length > 0) {
          const tables = existing.map((name) => `public.${quoteIdentifier(name)}`).join(', ');
          await client.query(`GRANT SELECT, DELETE ON TABLE ${tables} TO ${maintenanceRole}`);
        }
        const rollupStateExists = (await client.query(`SELECT to_regclass('public.usage_group_rollup_state') AS relation`))
          .rows[0]?.relation;
        if (rollupStateExists) {
          await client.query(`
            GRANT SELECT, UPDATE ON TABLE public.usage_group_rollup_state TO ${maintenanceRole}
          `);
        }
        if (existing.length < CLEANUP_TABLES.length) {
          warnings.push('部分清理白名单表尚不存在；升级 Sub2API 后可再次运行本操作补齐授权。');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw setupError(error, input.password);
    } finally {
      client?.release();
      await pool.end();
    }

    const readUrl = buildConnectionUrl(input, input.readRole, readPassword);
    const maintenanceUrl = input.createMaintenance
      ? buildConnectionUrl(input, input.maintenanceRole, maintenancePassword)
      : null;
    await this.database.reconfigure({
      readUrl,
      maintenanceUrl,
      sslMode: input.sslMode,
      source: 'managed'
    });
    await this.settingsStore.update((settings) => {
      settings.database = {
        readUrl,
        maintenanceUrl,
        sslMode: input.sslMode,
        readRole: input.readRole,
        maintenanceRole: input.createMaintenance ? input.maintenanceRole : null,
        updatedAt: new Date().toISOString()
      };
      return settings;
    });
    this.inspector.reset();
    this.storage.reset();
    const schema = await this.inspector.inspect({ refresh: true });
    return {
      configured: true,
      readRole: input.readRole,
      maintenanceRole: input.createMaintenance ? input.maintenanceRole : null,
      monitoringGranted,
      publicSchemaHardened,
      grantedCleanupTables: grantedTables,
      schemaCompatible: schema.compatible,
      missingRequiredTables: schema.missingRequired,
      warnings,
      database: this.database.status()
    };
  }

  async updateCleanup(input) {
    if (this.retention.activeRunId || this.scheduler.running) {
      throw new AppError('CLEANUP_ACTIVE', '清理任务执行期间不能修改清理设置', { status: 409 });
    }
    if (input.enabled && !poolConfigured(this.database.maintenance)) {
      throw new AppError('MAINTENANCE_DATABASE_REQUIRED', '启用清理前需要先创建独立清理角色', { status: 409 });
    }
    if (input.automaticEnabled && !this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_URL_REQUIRED', '启用自动清理前需要配置 Sub2API 管理 API 地址', { status: 409 });
    }
    if (input.backupWaitMinutes + 1 >= this.config.previewTtlMinutes) {
      throw new AppError('BACKUP_WAIT_TOO_LONG', '备份等待时间必须至少比预览有效期短 2 分钟', { status: 400 });
    }
    const runtime = {
      enabled: input.enabled,
      automaticEnabled: input.automaticEnabled,
      automaticTime: input.automaticTime,
      automaticTargets: [...input.automaticTargets],
      backupWaitMinutes: input.backupWaitMinutes,
      retention: { ...input.retention }
    };
    await this.settingsStore.update((settings) => {
      settings.cleanup = runtime;
      return settings;
    });
    this.config.cleanupEnabled = runtime.enabled;
    this.config.requireFreshBackup = true;
    this.config.automaticCleanup = {
      enabled: runtime.automaticEnabled,
      time: runtime.automaticTime,
      targets: [...runtime.automaticTargets],
      backupWaitMinutes: runtime.backupWaitMinutes
    };
    Object.assign(this.config.retention, runtime.retention);
    this.scheduler.reconfigure();
    return this.getStatus().cleanup;
  }

  async updateSub2ApiCredentials(input) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_URL_REQUIRED', '部署尚未配置 Sub2API 管理 API 地址', { status: 409 });
    }
    let credentials = { token: null, email: null, password: null };
    let stored;
    if (input.mode === 'token') {
      credentials.token = input.token;
      await this.sub2api.validateAdminCredentials(credentials);
      stored = { adminToken: input.token, adminEmail: null, adminPassword: null };
    } else if (input.mode === 'account') {
      credentials.email = input.email;
      credentials.password = input.password;
      await this.sub2api.validateAdminCredentials(credentials);
      stored = { adminToken: null, adminEmail: input.email, adminPassword: input.password };
    } else {
      stored = { clearPersistentCredentials: true };
    }
    await this.settingsStore.update((settings) => {
      settings.sub2api = stored;
      return settings;
    });
    this.sub2api.setPersistentCredentials(credentials);
    this.config.sub2apiCredentialSource = input.mode === 'session' ? 'session' : 'managed';
    return this.getStatus().authentication;
  }

  async runChecks() {
    const checks = [];
    try {
      const ping = await this.database.ping('read');
      checks.push(checkResult('database_read', '数据库读取连接', 'passed', `${ping.database} / ${ping.user} / ${ping.latencyMs} ms`));
    } catch (error) {
      checks.push(checkResult('database_read', '数据库读取连接', 'failed', error.message, { code: error.code || null }));
    }
    try {
      const schema = await this.inspector.inspect({ refresh: true });
      checks.push(checkResult(
        'schema',
        'Sub2API Schema',
        schema.compatible ? 'passed' : 'failed',
        schema.compatible ? '必要表完整' : `缺少：${schema.missingRequired.join(', ')}`
      ));
    } catch (error) {
      checks.push(checkResult('schema', 'Sub2API Schema', 'failed', error.message, { code: error.code || null }));
    }
    try {
      const { rows } = await this.database.read.query(`
        SELECT relation.relname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relname = ANY($1::text[])
          AND NOT has_table_privilege(current_user, format('%I.%I', namespace.nspname, relation.relname), 'SELECT')
        ORDER BY relation.relname
      `, [REQUIRED_TABLES]);
      checks.push(checkResult(
        'database_read_permissions',
        '统计表读取权限',
        rows.length === 0 ? 'passed' : 'failed',
        rows.length === 0 ? '必要表均可读取' : `缺少：${rows.map((row) => row.relname).join(', ')}`
      ));
    } catch (error) {
      checks.push(checkResult('database_read_permissions', '统计表读取权限', 'failed', error.message, { code: error.code || null }));
    }
    try {
      const ping = await this.database.ping('maintenance');
      const { rows } = await this.database.maintenance.query(`
        SELECT COUNT(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'DELETE')) AS delete_tables
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      `, [CLEANUP_TABLES]);
      checks.push(checkResult(
        'database_maintenance',
        '独立清理连接',
        'passed',
        `${ping.user} / ${Number(rows[0]?.delete_tables || 0)} 个白名单表可删除`
      ));
    } catch (error) {
      checks.push(checkResult(
        'database_maintenance',
        '独立清理连接',
        poolConfigured(this.database.maintenance) ? 'failed' : 'warning',
        error.message,
        { code: error.code || null }
      ));
    }
    try {
      if (!this.sub2api.configured()) throw new AppError('SUB2API_AUTH_NOT_CONFIGURED', '当前没有可用的管理 API 认证', { status: 409 });
      const version = await this.sub2api.getVersion();
      checks.push(checkResult(
        'sub2api_api',
        'Sub2API 管理 API',
        'passed',
        version?.version || version?.current_version || '连接正常'
      ));
    } catch (error) {
      checks.push(checkResult('sub2api_api', 'Sub2API 管理 API', 'warning', error.message, { code: error.code || null }));
    }
    const backup = await this.retention.getBackupStatus();
    checks.push(checkResult(
      'native_backup',
      'Sub2API 原生备份',
      backup.available && backup.satisfied ? 'passed' : 'warning',
      backup.latest?.finishedAt ? `最近完成：${backup.latest.finishedAt}` : (backup.reason || '没有满足时效的成功备份')
    ));
    return { generatedAt: new Date().toISOString(), checks };
  }
}

module.exports = {
  SystemSettingsService,
  MANAGED_ROLE_COMMENT,
  CLEANUP_TABLES,
  ROLE_PATTERN,
  buildConnectionUrl,
  quoteIdentifier,
  quoteLiteral
};
