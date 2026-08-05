const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabase, nowIso } = require('../src/db');

test('schema v19 migration preserves mappings and adds provider request samples', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-monitor-migration-'));
  const databasePath = path.join(directory, 'migration.db');
  let db = createDatabase(databasePath);
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = nowIso();
  db.prepare(`INSERT INTO encrypted_credentials(id, payload, created_at) VALUES ('credential', 'encrypted', ?)`).run(now);
  db.prepare(`
    INSERT INTO provider_connections(
      id, name, adapter_type, base_url, auth_mode, credential_id, enabled,
      refresh_interval_minutes, capabilities_json, fingerprint_json, type_config_json,
      tags_json, note, created_at, updated_at
    ) VALUES ('provider', 'Provider', 'new-api', 'https://provider.example', 'system_token',
      'credential', 1, 15, '{}', '{}', '{}', '[]', '', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, unlimited,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('key', 'provider', 'remote-key', 'Key', 'sk-a...1234', 'active', 0, '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id,
      role, enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping', 'provider', 'key', 11, 21, 31, 'primary', 1, '[]', '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO sub2api_mapping_states(
      mapping_id, status, tolerance_ratio, details_json, checked_at
    ) VALUES ('mapping', 'aligned', 0.05, '{}', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO reconciliation_runs(
      id, mapping_id, status, period_start, period_end, details_json, created_at
    ) VALUES ('reconciliation', 'mapping', 'succeeded', ?, ?, '{}', ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO automation_rules(
      id, name, enabled, dry_run, trigger_type, connection_id,
      config_json, created_at, updated_at
    ) VALUES ('legacy-channel-rule', 'Legacy channel rule', 1, 0, 'low_balance', 'provider', ?, ?, ?)
  `).run(JSON.stringify({
    action: 'disable_sub2api_channel',
    channelIds: [11],
    threshold: 5,
    currency: 'USD'
  }), now, now);
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('probe-account', 'Probe account', 'openai', 'oauth', 'active', 1, '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO sub2api_account_probe_runs(
      id, batch_id, account_id, trigger_type, suite, model, status,
      intelligence_score, instruction_score, response_excerpt, details_json,
      started_at, completed_at
    ) VALUES ('unexecuted-probe', 'batch', 'probe-account', 'manual', 'capability_v2',
      'gpt-test', 'succeeded', 0, 0, 'Hi! How can I help?', ?, ?, ?)
  `).run(JSON.stringify({
    challengeVersion: 2,
    challengeAnswers: {
      arithmetic: false,
      logic: false,
      sequence: false,
      sorted: false,
      checksum: false
    }
  }), now, now);

  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE provider_connections DROP COLUMN recharge_url;
    ALTER TABLE provider_connections DROP COLUMN secondary_warning_threshold;
    DROP INDEX IF EXISTS sub2api_mapping_identity;
    CREATE TABLE sub2api_mappings_v7 (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
      channel_id INTEGER NOT NULL,
      account_id INTEGER,
      group_id INTEGER,
      role TEXT NOT NULL DEFAULT 'primary',
      enabled INTEGER NOT NULL DEFAULT 1,
      models_json TEXT NOT NULL DEFAULT '[]',
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(connection_id, key_id, channel_id)
    );
    INSERT INTO sub2api_mappings_v7 SELECT * FROM sub2api_mappings;
    DROP TABLE sub2api_mappings;
    ALTER TABLE sub2api_mappings_v7 RENAME TO sub2api_mappings;
    CREATE UNIQUE INDEX sub2api_mapping_account_identity
      ON sub2api_mappings(connection_id, channel_id) WHERE key_id IS NULL;
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id,
      role, enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping-duplicate', 'provider', 'key', 12, 21, 31, 'backup', 0, '[]', '{}', '${now}', '${now}');
    INSERT INTO reconciliation_runs(
      id, mapping_id, status, period_start, period_end, details_json, created_at
    ) VALUES ('duplicate-reconciliation', 'mapping-duplicate', 'succeeded', '${now}', '${now}', '{}', '${now}');
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations(version, applied_at) VALUES (8, '${now}');
  `);
  db.close();

  db = createDatabase(databasePath);
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 19').get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_recharge_rates'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_dynamic_route_rates'").get());
  assert.ok(db.prepare('PRAGMA table_info(provider_connections)').all().some((column) => column.name === 'recharge_url'));
  assert.ok(db.prepare('PRAGMA table_info(provider_connections)').all().some((column) => column.name === 'secondary_warning_threshold'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recharge_access_tickets'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sub2api_monitored_accounts'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sub2api_account_probe_runs'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_request_samples'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_request_log_sync_state'").get());
  const actionColumns = new Set(db.prepare('PRAGMA table_info(automation_actions)').all().map((column) => column.name));
  assert.equal(actionColumns.has('error_code'), true);
  assert.equal(actionColumns.has('failure_stage'), true);
  assert.equal(actionColumns.has('error_details_json'), true);
  assert.equal(db.prepare('PRAGMA table_info(sub2api_mappings)').all().find((column) => column.name === 'channel_id').notnull, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 1);
  assert.equal(db.prepare('SELECT status FROM sub2api_mapping_states WHERE mapping_id = ?').get('mapping').status, 'aligned');
  assert.equal(db.prepare('SELECT status FROM reconciliation_runs WHERE mapping_id = ?').get('mapping').status, 'succeeded');
  assert.equal(db.prepare('SELECT mapping_id FROM reconciliation_runs WHERE id = ?').get('duplicate-reconciliation').mapping_id, 'mapping');
  const migratedRule = db.prepare('SELECT enabled, config_json FROM automation_rules WHERE id = ?').get('legacy-channel-rule');
  const migratedConfig = JSON.parse(migratedRule.config_json);
  assert.equal(migratedRule.enabled, 0);
  assert.equal(migratedConfig.action, 'disable_sub2api_account');
  assert.deepEqual(migratedConfig.accountIds, []);
  assert.deepEqual(migratedConfig.legacyChannelIds, [11]);
  assert.equal(migratedConfig.migrationNotice, 'account_targets_required');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const migratedProbe = db.prepare(`
    SELECT suite, intelligence_score, instruction_score, details_json
    FROM sub2api_account_probe_runs WHERE id = 'unexecuted-probe'
  `).get();
  assert.equal(migratedProbe.suite, 'capability_v2_unexecuted');
  assert.equal(migratedProbe.intelligence_score, null);
  assert.equal(migratedProbe.instruction_score, null);
  assert.equal(JSON.parse(migratedProbe.details_json).challengeExecuted, false);

  db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id,
      role, enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping-2', 'provider', 'key', NULL, 21, 32, 'primary', 1, '[]', '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id,
      role, enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping-3', 'provider', 'key', NULL, 22, 31, 'primary', 1, '[]', '{}', ?, ?)
  `).run(now, now);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 3);
  db.close();
  db = createDatabase(databasePath);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 3);
  assert.throws(() => db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id,
      role, enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('duplicate', 'provider', 'key', 999, 21, 31, 'primary', 1, '[]', '{}', ?, ?)
  `).run(now, now), /UNIQUE constraint failed/);
});
