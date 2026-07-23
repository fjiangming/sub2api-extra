const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 13;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS local_admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id) ON DELETE RESTRICT,
  remote_user_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_interval_minutes INTEGER NOT NULL DEFAULT 15,
  warning_threshold REAL,
  secondary_warning_threshold REAL,
  threshold_currency TEXT,
  recharge_url TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  fingerprint_json TEXT NOT NULL DEFAULT '{}',
  type_config_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  account_dedupe_key TEXT,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  next_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

DROP INDEX IF EXISTS provider_connection_identity;
CREATE UNIQUE INDEX provider_connection_identity
  ON provider_connections(base_url, adapter_type, COALESCE(account_dedupe_key, remote_user_id))
  WHERE account_dedupe_key IS NOT NULL OR remote_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_recharge_rates (
  connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
  detected_multiplier REAL CHECK (detected_multiplier IS NULL OR detected_multiplier > 0),
  manual_multiplier REAL CHECK (manual_multiplier IS NULL OR manual_multiplier > 0),
  quote_paid_amount REAL,
  quote_credited_amount REAL,
  paid_currency TEXT,
  balance_currency TEXT,
  detection_source TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  user_group TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(connection_id, remote_id)
);

CREATE TABLE IF NOT EXISTS remote_groups (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  group_type TEXT NOT NULL,
  name TEXT NOT NULL,
  ratio REAL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(connection_id, group_type, remote_id)
);

CREATE TABLE IF NOT EXISTS remote_keys (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  remote_account_id TEXT REFERENCES remote_accounts(id) ON DELETE SET NULL,
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  masked_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  primary_group_ref TEXT,
  backup_group_ref TEXT,
  unlimited INTEGER NOT NULL DEFAULT 0,
  quota_limit REAL,
  quota_used REAL,
  quota_remaining REAL,
  currency TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(connection_id, remote_id)
);

CREATE TABLE IF NOT EXISTS provider_dynamic_route_rates (
  key_id TEXT PRIMARY KEY REFERENCES remote_keys(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  selected_multiplier REAL CHECK (selected_multiplier IS NULL OR selected_multiplier > 0),
  statistic TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  min_multiplier REAL,
  median_multiplier REAL,
  p90_multiplier REAL,
  max_multiplier REAL,
  weighted_average_multiplier REAL,
  latest_multiplier REAL,
  status TEXT NOT NULL DEFAULT 'unknown',
  error_code TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  observed_from TEXT,
  observed_to TEXT,
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dynamic_route_rate_connection_lookup
  ON provider_dynamic_route_rates(connection_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS remote_key_groups (
  key_id TEXT NOT NULL REFERENCES remote_keys(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES remote_groups(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'additional',
  PRIMARY KEY(key_id, group_id, relation_type)
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  currency TEXT NOT NULL,
  available REAL,
  total REAL,
  used REAL,
  granted REAL,
  topped_up REAL,
  frozen REAL,
  unlimited INTEGER NOT NULL DEFAULT 0,
  source_field TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS balance_snapshot_lookup
  ON balance_snapshots(connection_id, subject_type, subject_id, currency, captured_at DESC);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  cost REAL,
  requests INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  model TEXT,
  period TEXT NOT NULL DEFAULT 'cumulative',
  raw_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_snapshot_lookup
  ON usage_snapshots(connection_id, subject_type, subject_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS balance_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  currency TEXT NOT NULL,
  available REAL,
  total REAL,
  used REAL,
  granted REAL,
  topped_up REAL,
  frozen REAL,
  unlimited INTEGER NOT NULL DEFAULT 0,
  source_field TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  granularity TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS balance_aggregate_identity
  ON balance_aggregates(connection_id, subject_type, COALESCE(subject_id, ''), currency, granularity, captured_at);

CREATE INDEX IF NOT EXISTS balance_aggregate_lookup
  ON balance_aggregates(connection_id, subject_type, subject_id, currency, captured_at DESC);

CREATE TABLE IF NOT EXISTS usage_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  cost REAL,
  requests INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  model TEXT,
  period TEXT NOT NULL DEFAULT 'cumulative',
  raw_json TEXT NOT NULL DEFAULT '{}',
  granularity TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_aggregate_identity
  ON usage_aggregates(connection_id, subject_type, COALESCE(subject_id, ''), currency,
    COALESCE(model, ''), period, granularity, captured_at);

CREATE INDEX IF NOT EXISTS usage_aggregate_lookup
  ON usage_aggregates(connection_id, subject_type, subject_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  retry_after TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS check_run_lookup
  ON check_runs(connection_id, started_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_job_lookup
  ON jobs(status, run_after, priority DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'account',
  currency TEXT,
  threshold REAL,
  consecutive_matches INTEGER NOT NULL DEFAULT 1,
  cooldown_minutes INTEGER NOT NULL DEFAULT 60,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT,
  subject_id TEXT,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  triggered_at TEXT NOT NULL,
  resolved_at TEXT,
  acknowledged_at TEXT,
  UNIQUE(fingerprint)
);

CREATE INDEX IF NOT EXISTS active_alert_lookup
  ON alert_events(status, triggered_at DESC);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  credential_id TEXT REFERENCES encrypted_credentials(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  alert_event_id TEXT REFERENCES alert_events(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES notification_channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_actions (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 1,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_change_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  asset_id TEXT,
  remote_id TEXT,
  change_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_change_lookup
  ON asset_change_events(connection_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  anomaly_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  message TEXT NOT NULL,
  score REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  fingerprint TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS anomaly_lookup
  ON anomaly_events(connection_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS key_health_checks (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES remote_keys(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  model_count INTEGER,
  error_code TEXT,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS key_health_lookup
  ON key_health_checks(key_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS remote_models (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  vendor TEXT,
  context_length INTEGER,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(connection_id, remote_id)
);

CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  group_ref TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_mode TEXT NOT NULL DEFAULT 'token',
  input_per_million REAL,
  output_per_million REAL,
  cache_read_per_million REAL,
  cache_write_per_million REAL,
  request_price REAL,
  image_price REAL,
  audio_price REAL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS model_price_lookup
  ON model_prices(model_id, connection_id, group_ref, captured_at DESC);

CREATE TABLE IF NOT EXISTS checkin_records (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reward_amount REAL,
  currency TEXT,
  before_balance REAL,
  after_balance REAL,
  manual_action_required INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  UNIQUE(connection_id, checked_at)
);

CREATE INDEX IF NOT EXISTS checkin_lookup
  ON checkin_records(connection_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS sub2api_mappings (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
  channel_id INTEGER,
  account_id INTEGER,
  group_id INTEGER,
  role TEXT NOT NULL DEFAULT 'primary',
  enabled INTEGER NOT NULL DEFAULT 1,
  models_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub2api_mapping_states (
  mapping_id TEXT PRIMARY KEY REFERENCES sub2api_mappings(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  provider_group_ref TEXT,
  provider_group_name TEXT,
  provider_rate REAL,
  channel_name TEXT,
  channel_status TEXT,
  base_group_id INTEGER,
  base_group_name TEXT,
  base_group_rate REAL,
  difference_ratio REAL,
  tolerance_ratio REAL NOT NULL DEFAULT 0.05,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sub2api_mapping_state_status
  ON sub2api_mapping_states(status, checked_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  mapping_id TEXT NOT NULL REFERENCES sub2api_mappings(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  upstream_balance_delta REAL,
  upstream_key_usage_delta REAL,
  sub2api_cost REAL,
  expected_cost REAL,
  difference_amount REAL,
  difference_ratio REAL,
  health_score REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS reconciliation_lookup
  ON reconciliation_runs(mapping_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credential_backups (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  restored_at TEXT
);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS backup_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  credential_id TEXT REFERENCES encrypted_credentials(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_status TEXT,
  last_error TEXT,
  last_backup_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT REFERENCES backup_targets(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER,
  location TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS backup_run_lookup
  ON backup_runs(target_id, created_at DESC);
`;

function nowIso() {
  return new Date().toISOString();
}

function migrateSub2ApiMappingsV9(db) {
  const channelColumn = db.prepare('PRAGMA table_info(sub2api_mappings)').all()
    .find((column) => column.name === 'channel_id');
  const identityIndex = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'sub2api_mapping_identity'
  `).get();
  const currentIdentity = /COALESCE\s*\(\s*account_id\s*,\s*0\s*\)[\s\S]*group_id[\s\S]*WHERE\s+group_id\s+IS\s+NOT\s+NULL/i
    .test(identityIndex?.sql || '');
  if (channelColumn?.notnull === 0 && currentIdentity) return;

  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      DROP TABLE IF EXISTS temp.sub2api_mapping_v9_redirect;
      CREATE TEMP TABLE sub2api_mapping_v9_redirect AS
      SELECT id AS old_id,
        CASE WHEN group_id IS NULL THEN id ELSE FIRST_VALUE(id) OVER (
          PARTITION BY connection_id, COALESCE(key_id, ''), COALESCE(account_id, 0), group_id
          ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, enabled DESC, created_at, id
        ) END AS keep_id
      FROM sub2api_mappings;

      DELETE FROM sub2api_mapping_states
      WHERE mapping_id IN (
        SELECT old_id FROM sub2api_mapping_v9_redirect WHERE old_id != keep_id
      );
      UPDATE reconciliation_runs
      SET mapping_id = (
        SELECT keep_id FROM sub2api_mapping_v9_redirect
        WHERE old_id = reconciliation_runs.mapping_id
      )
      WHERE mapping_id IN (
        SELECT old_id FROM sub2api_mapping_v9_redirect WHERE old_id != keep_id
      );

      DROP TABLE IF EXISTS sub2api_mappings_v9;
      CREATE TABLE sub2api_mappings_v9 (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
        key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
        channel_id INTEGER,
        account_id INTEGER,
        group_id INTEGER,
        role TEXT NOT NULL DEFAULT 'primary',
        enabled INTEGER NOT NULL DEFAULT 1,
        models_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sub2api_mappings_v9(
        id, connection_id, key_id, channel_id, account_id, group_id, role,
        enabled, models_json, config_json, created_at, updated_at
      )
      SELECT
        mapping.id, mapping.connection_id, mapping.key_id, mapping.channel_id,
        mapping.account_id, mapping.group_id, mapping.role, mapping.enabled,
        mapping.models_json, mapping.config_json, mapping.created_at, mapping.updated_at
      FROM sub2api_mappings mapping
      JOIN sub2api_mapping_v9_redirect redirect
        ON redirect.old_id = mapping.id AND redirect.keep_id = mapping.id;
      DROP TABLE sub2api_mappings;
      ALTER TABLE sub2api_mappings_v9 RENAME TO sub2api_mappings;
      DROP INDEX IF EXISTS sub2api_mapping_account_identity;
      DROP INDEX IF EXISTS sub2api_mapping_identity;
      CREATE UNIQUE INDEX sub2api_mapping_identity
        ON sub2api_mappings(
          connection_id,
          COALESCE(key_id, ''),
          COALESCE(account_id, 0),
          group_id
        )
        WHERE group_id IS NOT NULL;
      DROP TABLE sub2api_mapping_v9_redirect;
    `);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function migrateProviderRechargeUrlV12(db) {
  const rechargeUrlColumn = db.prepare('PRAGMA table_info(provider_connections)').all()
    .find((column) => column.name === 'recharge_url');
  if (!rechargeUrlColumn) {
    db.exec('ALTER TABLE provider_connections ADD COLUMN recharge_url TEXT');
  }
}

function migrateSecondaryWarningThresholdV13(db) {
  const secondaryThresholdColumn = db.prepare('PRAGMA table_info(provider_connections)').all()
    .find((column) => column.name === 'secondary_warning_threshold');
  if (!secondaryThresholdColumn) {
    db.exec('ALTER TABLE provider_connections ADD COLUMN secondary_warning_threshold REAL');
  }
}

function createDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(SCHEMA);
    migrateSub2ApiMappingsV9(db);
    migrateProviderRechargeUrlV12(db);
    migrateSecondaryWarningThresholdV13(db);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
    ).run(SCHEMA_VERSION, nowIso());
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const foreignKeyErrors = db.pragma('foreign_key_check');
  if (foreignKeyErrors.length > 0) {
    db.close();
    throw new Error(`Database foreign key check failed after migration (${foreignKeyErrors.length} violation(s))`);
  }
  return db;
}

function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

module.exports = {
  createDatabase,
  nowIso,
  parseJson,
  stringifyJson,
  SCHEMA_VERSION
};
