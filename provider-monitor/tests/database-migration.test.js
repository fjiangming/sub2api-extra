const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabase, nowIso } = require('../src/db');

test('schema v13 migration preserves mappings and adds provider balance alert levels', (t) => {
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
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 13').get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_recharge_rates'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_dynamic_route_rates'").get());
  assert.ok(db.prepare('PRAGMA table_info(provider_connections)').all().some((column) => column.name === 'recharge_url'));
  assert.ok(db.prepare('PRAGMA table_info(provider_connections)').all().some((column) => column.name === 'secondary_warning_threshold'));
  assert.equal(db.prepare('PRAGMA table_info(sub2api_mappings)').all().find((column) => column.name === 'channel_id').notnull, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 1);
  assert.equal(db.prepare('SELECT status FROM sub2api_mapping_states WHERE mapping_id = ?').get('mapping').status, 'aligned');
  assert.equal(db.prepare('SELECT status FROM reconciliation_runs WHERE mapping_id = ?').get('mapping').status, 'succeeded');
  assert.equal(db.prepare('SELECT mapping_id FROM reconciliation_runs WHERE id = ?').get('duplicate-reconciliation').mapping_id, 'mapping');
  assert.deepEqual(db.pragma('foreign_key_check'), []);

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
