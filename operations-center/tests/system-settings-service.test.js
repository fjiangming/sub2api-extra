'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SystemSettingsService,
  MANAGED_ROLE_COMMENT,
  CLEANUP_TABLES,
  buildConnectionUrl
} = require('../src/services/system-settings-service');

test('connection URLs encode generated credentials without exposing the bootstrap account', () => {
  const url = buildConnectionUrl({ host: 'database.internal', port: 5432, database: 'sub2api' }, 'ops_reader', 'a/b:c@d');
  assert.equal(url, 'postgresql://ops_reader:a%2Fb%3Ac%40d@database.internal:5432/sub2api');
});

test('database provisioning stores only generated restricted-role connections', async () => {
  const statements = [];
  const client = {
    async query(sql, parameters = []) {
      const text = String(sql);
      statements.push({ text, parameters });
      if (text.includes('role.rolsuper')) {
        return { rows: [{ database: 'sub2api', user: 'postgres', rolsuper: true, rolcreaterole: true, public_schema: true }] };
      }
      if (text.includes('DISTINCT owner.rolname')) {
        return { rows: [{ owner: 'sub2api', manageable: true }] };
      }
      if (text.includes("shobj_description(role.oid")) return { rows: [] };
      if (text.includes('FROM pg_auth_members')) return { rows: [] };
      if (text.includes('relation.relname = ANY')) {
        return { rows: [{ relname: 'usage_logs' }, { relname: 'ops_system_logs' }] };
      }
      if (text.includes("to_regclass('public.usage_group_rollup_state')")) {
        return { rows: [{ relation: 'usage_group_rollup_state' }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = { connect: async () => client, end: async () => {} };
  let configured;
  const database = {
    reconfigure: async (value) => { configured = value; },
    status: () => ({ read: { configured: true }, maintenance: { configured: true }, sslMode: 'disable' }),
    maintenance: { configured: () => true }
  };
  let persisted = {};
  const service = new SystemSettingsService({
    config: { databaseSetupEnabled: true, retention: {}, automaticCleanup: {}, requireFreshBackup: true },
    database,
    settingsStore: {
      update: async (mutator) => { persisted = mutator(persisted); return persisted; }
    },
    inspector: { reset() {}, inspect: async () => ({ compatible: true, missingRequired: [] }) },
    storage: { reset() {} },
    retention: { activeRunId: null },
    scheduler: { running: false },
    sub2api: { persistentCredentialsConfigured: () => false, configured: () => false },
    poolFactory: () => pool
  });
  const result = await service.provisionDatabase({
    host: 'database.internal', port: 5432, database: 'sub2api', username: 'postgres',
    password: 'bootstrap-password-must-not-persist', sslMode: 'disable', readRole: 'sub2api_ops_read',
    createMaintenance: true, maintenanceRole: 'sub2api_ops_maintenance', grantMonitoring: true
  });

  assert.equal(result.configured, true);
  assert.match(configured.readUrl, /^postgresql:\/\/sub2api_ops_read:/);
  assert.match(configured.maintenanceUrl, /^postgresql:\/\/sub2api_ops_maintenance:/);
  assert.equal(persisted.database.readUrl, configured.readUrl);
  assert.doesNotMatch(JSON.stringify(persisted), /bootstrap-password|postgres@/);
  const sql = statements.map((entry) => entry.text).join('\n');
  assert.match(sql, /GRANT SELECT ON ALL TABLES/);
  assert.match(sql, /GRANT SELECT, DELETE ON TABLE/);
  assert.doesNotMatch(sql, /DELETE ON TABLE[^\n]*users(?:,|\s|$)/);
  assert.ok(CLEANUP_TABLES.includes('usage_logs'));
  assert.ok(!CLEANUP_TABLES.includes('users'));
});

function publicSchemaHarness({ canCreate }) {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      statements.push(text);
      if (text.includes('role.rolsuper')) {
        return { rows: [{ database: 'sub2api', user: 'postgres', rolsuper: true, rolcreaterole: true, public_schema: true }] };
      }
      if (text.includes('DISTINCT owner.rolname')) return { rows: [{ owner: 'sub2api', manageable: true }] };
      if (text.includes('shobj_description(role.oid')) return { rows: [] };
      if (text.includes('FROM pg_auth_members')) return { rows: [] };
      if (text.includes('has_schema_privilege')) return { rows: [{ can_create: canCreate }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = { connect: async () => client, end: async () => {} };
  let reconfigured = false;
  const service = new SystemSettingsService({
    config: { databaseSetupEnabled: true, cleanupEnabled: false, retention: {}, automaticCleanup: {}, requireFreshBackup: true },
    database: {
      reconfigure: async () => { reconfigured = true; },
      status: () => ({ read: { configured: true }, maintenance: { configured: false }, sslMode: 'disable' }),
      maintenance: { configured: () => false }
    },
    settingsStore: { update: async (mutator) => mutator({}) },
    inspector: { reset() {}, inspect: async () => ({ compatible: true, missingRequired: [] }) },
    storage: { reset() {} },
    retention: { activeRunId: null },
    scheduler: { running: false },
    sub2api: { persistentCredentialsConfigured: () => false, configured: () => false },
    poolFactory: () => pool
  });
  return { service, statements, wasReconfigured: () => reconfigured };
}

function readOnlyProvisionInput(overrides = {}) {
  return {
    host: 'database.internal',
    port: 5432,
    database: 'sub2api',
    username: 'postgres',
    password: 'temporary-bootstrap-password',
    sslMode: 'disable',
    readRole: 'sub2api_ops_read',
    createMaintenance: false,
    maintenanceRole: 'sub2api_ops_maintenance',
    grantMonitoring: false,
    hardenPublicSchema: false,
    ...overrides
  };
}

test('database provisioning blocks inherited PUBLIC schema CREATE unless explicitly approved', async () => {
  const harness = publicSchemaHarness({ canCreate: true });

  await assert.rejects(
    harness.service.provisionDatabase(readOnlyProvisionInput()),
    (error) => error.code === 'PUBLIC_SCHEMA_CREATE_PRIVILEGE' && error.status === 409
  );

  assert.equal(harness.wasReconfigured(), false);
  assert.ok(harness.statements.includes('ROLLBACK'));
  assert.ok(!harness.statements.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));
});

test('database provisioning hardens PUBLIC schema only after explicit approval', async () => {
  const harness = publicSchemaHarness({ canCreate: true });

  const result = await harness.service.provisionDatabase(readOnlyProvisionInput({ hardenPublicSchema: true }));

  assert.equal(result.publicSchemaHardened, true);
  assert.equal(harness.wasReconfigured(), true);
  assert.ok(harness.statements.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));
  assert.ok(harness.statements.includes('COMMIT'));
});

test('managed roles that own database objects are not automatically rotated', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      statements.push(text);
      if (text.includes('shobj_description(role.oid')) {
        return { rows: [{ rolname: 'sub2api_ops_read', comment: MANAGED_ROLE_COMMENT }] };
      }
      if (text.includes('AS owned_objects')) return { rows: [{ owned_objects: '1' }] };
      return { rows: [] };
    }
  };
  const service = new SystemSettingsService({});

  await assert.rejects(
    service.prepareRole(client, 'sub2api_ops_read', 'new-generated-password'),
    (error) => error.code === 'MANAGED_ROLE_OWNS_OBJECTS' && error.status === 409
  );

  assert.ok(!statements.some((statement) => statement.includes('ALTER ROLE')));
});
