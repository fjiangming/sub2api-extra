CREATE SCHEMA IF NOT EXISTS video_adapter;
CREATE TABLE IF NOT EXISTS video_adapter.jobs (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL, api_key_id BIGINT NOT NULL, group_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  request_spec JSONB NOT NULL, secret_snapshot TEXT NOT NULL, pricing_snapshot JSONB NOT NULL,
  hold_usd NUMERIC(20,8) NOT NULL CHECK (hold_usd > 0),
  cost_cap_usd NUMERIC(20,8) NOT NULL CHECK (cost_cap_usd >= 0),
  supplier_cost_usd NUMERIC(20,8), charged_usd NUMERIC(20,8),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','unknown','running','review','completed','failed')),
  funds_state TEXT NOT NULL DEFAULT 'held' CHECK (funds_state IN ('held','captured','released','refunded')),
  upstream_id TEXT, upstream_status TEXT, progress INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_code TEXT, reconcile_note TEXT,
  download_requests INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, lease_owner TEXT, lease_until TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), audit_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ,
  UNIQUE(api_key_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_worker_idx ON video_adapter.jobs (next_poll_at) WHERE funds_state = 'held';
CREATE INDEX IF NOT EXISTS jobs_user_idx ON video_adapter.jobs (user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_budget_idx ON video_adapter.jobs (provider_id, created_at);
CREATE TABLE IF NOT EXISTS video_adapter.events (
  id BIGSERIAL PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_adapter.provider_controls (
  provider_id TEXT PRIMARY KEY, paused BOOLEAN NOT NULL DEFAULT FALSE, reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_adapter.cache_outbox (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, api_key_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_adapter.schema_version (version INTEGER PRIMARY KEY);
INSERT INTO video_adapter.schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS video_adapter.budget_lock (id INTEGER PRIMARY KEY);
INSERT INTO video_adapter.budget_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
