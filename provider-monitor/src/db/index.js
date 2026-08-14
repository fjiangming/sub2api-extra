const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 23;

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

CREATE INDEX IF NOT EXISTS remote_key_connection_status_lookup
  ON remote_keys(connection_id, status, name);

CREATE INDEX IF NOT EXISTS remote_key_connection_name_lookup
  ON remote_keys(connection_id, name, remote_id);

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

CREATE INDEX IF NOT EXISTS check_run_recent
  ON check_runs(started_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS job_recent
  ON jobs(created_at DESC, id DESC);

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

CREATE TABLE IF NOT EXISTS recharge_access_tickets (
  token_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  alert_event_id TEXT REFERENCES alert_events(id) ON DELETE SET NULL,
  target_url TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recharge_access_ticket_expiry
  ON recharge_access_tickets(expires_at);

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
  error_code TEXT,
  error_message TEXT,
  failure_stage TEXT,
  error_details_json TEXT NOT NULL DEFAULT '{}',
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

CREATE INDEX IF NOT EXISTS audit_log_recent
  ON audit_logs(created_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS asset_change_recent
  ON asset_change_events(detected_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS anomaly_recent
  ON anomaly_events(detected_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS key_health_recent
  ON key_health_checks(checked_at DESC, id DESC);

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

CREATE TABLE IF NOT EXISTS sub2api_account_monitor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 15,
  lookback_days INTEGER NOT NULL DEFAULT 7,
  sample_retention_days INTEGER NOT NULL DEFAULT 30,
  base_recharge_multiplier REAL NOT NULL DEFAULT 1 CHECK (base_recharge_multiplier > 0),
  probe_enabled INTEGER NOT NULL DEFAULT 0,
  probe_interval_minutes INTEGER NOT NULL DEFAULT 360,
  probe_platforms_json TEXT NOT NULL DEFAULT '[]',
  probe_models_json TEXT NOT NULL DEFAULT '{}',
  probe_concurrency INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub2api_monitored_accounts (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  schedulable INTEGER NOT NULL DEFAULT 0,
  priority INTEGER,
  concurrency INTEGER,
  rate_multiplier REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_since TEXT
);

CREATE INDEX IF NOT EXISTS sub2api_monitored_account_lookup
  ON sub2api_monitored_accounts(platform, status, name);

CREATE TABLE IF NOT EXISTS sub2api_account_request_samples (
  source_log_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES sub2api_monitored_accounts(account_id) ON DELETE CASCADE,
  request_id TEXT,
  model TEXT,
  upstream_model TEXT,
  model_mapping_chain TEXT,
  request_type TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  first_token_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost REAL,
  created_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sub2api_account_sample_lookup
  ON sub2api_account_request_samples(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sub2api_account_sample_created
  ON sub2api_account_request_samples(created_at DESC);

CREATE TABLE IF NOT EXISTS provider_request_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
  source_log_id TEXT NOT NULL,
  request_id TEXT,
  model TEXT,
  upstream_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  duration_ms INTEGER,
  first_token_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(connection_id, source_log_id)
);

CREATE INDEX IF NOT EXISTS provider_request_sample_key_lookup
  ON provider_request_samples(key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS provider_request_sample_request_lookup
  ON provider_request_samples(request_id, connection_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_request_sample_metric_lookup
  ON provider_request_samples(key_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
  remote_key_id TEXT,
  key_identity TEXT NOT NULL,
  source_log_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  currency TEXT NOT NULL DEFAULT 'USD',
  cost REAL,
  request_count INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, key_identity, source_log_id)
);

CREATE INDEX IF NOT EXISTS provider_cost_ledger_key_lookup
  ON provider_cost_ledger(key_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS provider_cost_ledger_connection_lookup
  ON provider_cost_ledger(connection_id, currency, occurred_at DESC);

CREATE INDEX IF NOT EXISTS provider_cost_ledger_identity_lookup
  ON provider_cost_ledger(connection_id, key_identity, occurred_at DESC);

CREATE TABLE IF NOT EXISTS provider_cost_rollups (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  key_id TEXT REFERENCES remote_keys(id) ON DELETE SET NULL,
  key_identity TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  cost_sample_count INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(connection_id, key_identity, currency)
);

CREATE INDEX IF NOT EXISTS provider_cost_rollup_key_lookup
  ON provider_cost_rollups(key_id, currency);

CREATE TRIGGER IF NOT EXISTS provider_cost_ledger_rollup_insert
AFTER INSERT ON provider_cost_ledger
BEGIN
  INSERT INTO provider_cost_rollups(
    connection_id, key_id, key_identity, currency, request_count,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    cost, cost_sample_count, first_at, last_at, updated_at
  ) VALUES (
    NEW.connection_id, NEW.key_id, NEW.key_identity, NEW.currency,
    CASE WHEN NEW.status = 'success' THEN NEW.request_count ELSE 0 END,
    CASE WHEN NEW.status = 'success' THEN NEW.input_tokens ELSE 0 END,
    CASE WHEN NEW.status = 'success' THEN NEW.output_tokens ELSE 0 END,
    CASE WHEN NEW.status = 'success' THEN NEW.cache_creation_tokens ELSE 0 END,
    CASE WHEN NEW.status = 'success' THEN NEW.cache_read_tokens ELSE 0 END,
    COALESCE(NEW.cost, 0), CASE WHEN NEW.cost IS NULL THEN 0 ELSE NEW.request_count END,
    NEW.occurred_at, NEW.occurred_at, NEW.updated_at
  )
  ON CONFLICT(connection_id, key_identity, currency) DO UPDATE SET
    key_id = COALESCE(excluded.key_id, provider_cost_rollups.key_id),
    request_count = provider_cost_rollups.request_count + excluded.request_count,
    input_tokens = provider_cost_rollups.input_tokens + excluded.input_tokens,
    output_tokens = provider_cost_rollups.output_tokens + excluded.output_tokens,
    cache_creation_tokens = provider_cost_rollups.cache_creation_tokens + excluded.cache_creation_tokens,
    cache_read_tokens = provider_cost_rollups.cache_read_tokens + excluded.cache_read_tokens,
    cost = provider_cost_rollups.cost + excluded.cost,
    cost_sample_count = provider_cost_rollups.cost_sample_count + excluded.cost_sample_count,
    first_at = MIN(provider_cost_rollups.first_at, excluded.first_at),
    last_at = MAX(provider_cost_rollups.last_at, excluded.last_at),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS provider_cost_ledger_rollup_relink
AFTER UPDATE OF key_id ON provider_cost_ledger
BEGIN
  UPDATE provider_cost_rollups SET key_id = NEW.key_id, updated_at = NEW.updated_at
  WHERE connection_id = NEW.connection_id AND key_identity = NEW.key_identity
    AND currency = NEW.currency;
END;

CREATE TABLE IF NOT EXISTS sub2api_account_cost_ledger (
  source_log_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  cost REAL,
  request_count INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sub2api_account_cost_ledger_lookup
  ON sub2api_account_cost_ledger(account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS sub2api_account_cost_rollups (
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  request_count INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  cost_sample_count INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, currency)
);

CREATE TRIGGER IF NOT EXISTS sub2api_account_cost_ledger_rollup_insert
AFTER INSERT ON sub2api_account_cost_ledger
BEGIN
  INSERT INTO sub2api_account_cost_rollups(
    account_id, currency, request_count, cost, cost_sample_count,
    first_at, last_at, updated_at
  ) VALUES (
    NEW.account_id, NEW.currency, NEW.request_count, COALESCE(NEW.cost, 0),
    CASE WHEN NEW.cost IS NULL THEN 0 ELSE NEW.request_count END,
    NEW.occurred_at, NEW.occurred_at, NEW.updated_at
  )
  ON CONFLICT(account_id, currency) DO UPDATE SET
    request_count = sub2api_account_cost_rollups.request_count + excluded.request_count,
    cost = sub2api_account_cost_rollups.cost + excluded.cost,
    cost_sample_count = sub2api_account_cost_rollups.cost_sample_count + excluded.cost_sample_count,
    first_at = MIN(sub2api_account_cost_rollups.first_at, excluded.first_at),
    last_at = MAX(sub2api_account_cost_rollups.last_at, excluded.last_at),
    updated_at = excluded.updated_at;
END;

CREATE TABLE IF NOT EXISTS provider_recharge_audits (
  connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
  recharged_amount REAL NOT NULL DEFAULT 0 CHECK (recharged_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_request_log_sync_state (
  connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  coverage_from TEXT,
  coverage_to TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_request_key_sync_state (
  key_id TEXT PRIMARY KEY REFERENCES remote_keys(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  coverage_from TEXT,
  coverage_to TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_request_key_sync_connection
  ON provider_request_key_sync_state(connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sub2api_account_probe_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES sub2api_monitored_accounts(account_id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  suite TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  intelligence_score REAL,
  instruction_score REAL,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  response_excerpt TEXT,
  error_code TEXT,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sub2api_account_probe_lookup
  ON sub2api_account_probe_runs(account_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS sub2api_account_probe_batch
  ON sub2api_account_probe_runs(batch_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS sub2api_account_monitor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_account_sync_at TEXT,
  last_log_sync_at TEXT,
  last_probe_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  last_sync_summary_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sub2api_account_monitor_settings(id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO sub2api_account_monitor_state(id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

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

CREATE INDEX IF NOT EXISTS sub2api_mapping_account_lookup
  ON sub2api_mappings(account_id, enabled, connection_id, key_id);

CREATE INDEX IF NOT EXISTS sub2api_mapping_key_lookup
  ON sub2api_mappings(key_id, enabled, account_id);

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

function migrateAutomationAccountActionsV16(db) {
  const replacements = new Map([
    ['disable_sub2api_channel', 'disable_sub2api_account'],
    ['enable_sub2api_channel', 'enable_sub2api_account']
  ]);
  const rows = db.prepare('SELECT id, config_json FROM automation_rules').all();
  const update = db.prepare(`
    UPDATE automation_rules
    SET enabled = 0, config_json = ?, updated_at = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const row of rows) {
      const config = parseJson(row.config_json, {});
      const replacement = replacements.get(config.action);
      if (!replacement) continue;
      config.legacyChannelAction = config.action;
      config.legacyChannelIds = Array.isArray(config.channelIds) ? config.channelIds : [];
      config.action = replacement;
      config.accountIds = [];
      config.migrationNotice = 'account_targets_required';
      delete config.channelIds;
      update.run(stringifyJson(config), nowIso(), row.id);
    }
  })();
}

function migrateUnexecutedCapabilityProbesV18(db) {
  const greeting = /^(?:hi|hello|hey)[!. ,]*(?:how can i (?:help|assist)(?: you)?(?: today)?|what would you like help with)\??[!.]?$/i;
  const rows = db.prepare(`
    SELECT id, response_excerpt, details_json
    FROM sub2api_account_probe_runs
    WHERE suite = 'capability_v2' AND intelligence_score = 0 AND instruction_score = 0
  `).all();
  const update = db.prepare(`
    UPDATE sub2api_account_probe_runs
    SET suite = 'capability_v2_unexecuted', intelligence_score = NULL,
      instruction_score = NULL, details_json = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const row of rows) {
      const excerpt = String(row.response_excerpt || '').replace(/\s+/g, ' ').trim();
      const details = parseJson(row.details_json, {});
      const answers = details.challengeAnswers;
      const answerValues = answers && typeof answers === 'object' ? Object.values(answers) : [];
      if (
        !greeting.test(excerpt) ||
        Number(details.challengeVersion) !== 2 ||
        answerValues.length === 0 ||
        !answerValues.every((value) => value === false)
      ) continue;
      update.run(stringifyJson({
        ...details,
        challengeAnswers: null,
        challengeExecuted: false,
        unscoredReason: 'sub2api_prompt_not_forwarded'
      }), row.id);
    }
  })();
}

function migrateAutomationActionFailureDetailsV19(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(automation_actions)').all().map((column) => column.name)
  );
  if (!columns.has('error_code')) {
    db.exec('ALTER TABLE automation_actions ADD COLUMN error_code TEXT');
  }
  if (!columns.has('failure_stage')) {
    db.exec('ALTER TABLE automation_actions ADD COLUMN failure_stage TEXT');
  }
  if (!columns.has('error_details_json')) {
    db.exec("ALTER TABLE automation_actions ADD COLUMN error_details_json TEXT NOT NULL DEFAULT '{}'");
  }
}

function migrateAccountMonitorBaseRechargeMultiplierV21(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(sub2api_account_monitor_settings)').all().map((column) => column.name)
  );
  if (!columns.has('base_recharge_multiplier')) {
    db.exec(`
      ALTER TABLE sub2api_account_monitor_settings
      ADD COLUMN base_recharge_multiplier REAL NOT NULL DEFAULT 1
      CHECK (base_recharge_multiplier > 0)
    `);
  }
}

function migratePersistentCostLedgersV22(db) {
  const migratedAt = nowIso();
  db.exec(`
    CREATE INDEX IF NOT EXISTS sub2api_mapping_account_lookup
      ON sub2api_mappings(account_id, enabled, connection_id, key_id);
    CREATE INDEX IF NOT EXISTS sub2api_mapping_key_lookup
      ON sub2api_mappings(key_id, enabled, account_id);

    INSERT OR IGNORE INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at
    )
    SELECT samples.connection_id, samples.key_id, keys.remote_id,
      COALESCE(
        NULLIF(json_extract(keys.metadata_json, '$.identityHash'), ''),
        NULLIF(keys.remote_id, ''),
        COALESCE(samples.key_id, 'unassigned')
      ),
      samples.source_log_id, samples.status, samples.currency, samples.actual_cost,
      1, samples.input_tokens, samples.output_tokens, samples.cache_creation_tokens,
      samples.cache_read_tokens, samples.created_at, samples.ingested_at, samples.ingested_at
    FROM provider_request_samples samples
    LEFT JOIN remote_keys keys ON keys.id = samples.key_id;

    INSERT OR IGNORE INTO sub2api_account_cost_ledger(
      source_log_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at
    )
    SELECT source_log_id, account_id, 'USD', actual_cost, 1,
      created_at, ingested_at, ingested_at
    FROM sub2api_account_request_samples;
  `);
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (22, ?)'
  ).run(migratedAt);
}

function migratePersistentCostRollupsV23(db) {
  const migrated = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 23'
  ).get();
  if (migrated) return;
  const migratedAt = nowIso();
  db.transaction(() => {
    db.exec(`
      DELETE FROM provider_cost_rollups;
      INSERT INTO provider_cost_rollups(
        connection_id, key_id, key_identity, currency, request_count,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost, cost_sample_count, first_at, last_at, updated_at
      )
      SELECT connection_id, MAX(key_id), key_identity, currency,
        SUM(CASE WHEN status = 'success' THEN request_count ELSE 0 END),
        SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END),
        SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END),
        SUM(CASE WHEN status = 'success' THEN cache_creation_tokens ELSE 0 END),
        SUM(CASE WHEN status = 'success' THEN cache_read_tokens ELSE 0 END),
        SUM(COALESCE(cost, 0)),
        SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END),
        MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
      FROM provider_cost_ledger
      GROUP BY connection_id, key_identity, currency;

      DELETE FROM sub2api_account_cost_rollups;
      INSERT INTO sub2api_account_cost_rollups(
        account_id, currency, request_count, cost, cost_sample_count,
        first_at, last_at, updated_at
      )
      SELECT account_id, currency, SUM(request_count), SUM(COALESCE(cost, 0)),
        SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END),
        MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
      FROM sub2api_account_cost_ledger
      GROUP BY account_id, currency;
    `);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (23, ?)'
    ).run(migratedAt);
  })();
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
    migrateAutomationAccountActionsV16(db);
    migrateUnexecutedCapabilityProbesV18(db);
    migrateAutomationActionFailureDetailsV19(db);
    migrateAccountMonitorBaseRechargeMultiplierV21(db);
    migratePersistentCostLedgersV22(db);
    migratePersistentCostRollupsV23(db);
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
