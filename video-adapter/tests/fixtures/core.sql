-- Isolated compatibility fixture. Never run this file against a real Sub2API database.
CREATE TABLE users (id BIGINT PRIMARY KEY, balance NUMERIC(20,8) NOT NULL DEFAULT 0, frozen_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',restrict_public_groups BOOLEAN NOT NULL DEFAULT FALSE,concurrency INTEGER NOT NULL DEFAULT 5,rpm_limit INTEGER NOT NULL DEFAULT 0,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE groups (id BIGINT PRIMARY KEY,platform TEXT NOT NULL DEFAULT 'grok',status TEXT NOT NULL DEFAULT 'active',deleted_at TIMESTAMPTZ,
  subscription_type TEXT DEFAULT 'standard',is_exclusive BOOLEAN DEFAULT FALSE,allow_image_generation BOOLEAN DEFAULT TRUE,
  rate_multiplier NUMERIC DEFAULT 1,video_rate_independent BOOLEAN DEFAULT FALSE,video_rate_multiplier NUMERIC DEFAULT 1,
  video_price_480p NUMERIC,video_price_720p NUMERIC,video_price_1080p NUMERIC,video_model_prices JSONB,model_pricing JSONB,
  peak_rate_enabled BOOLEAN DEFAULT FALSE,peak_start TEXT DEFAULT '',peak_end TEXT DEFAULT '',peak_rate_multiplier NUMERIC DEFAULT 1,
  model_allowlist JSONB DEFAULT '{}',profit_control_enabled BOOLEAN DEFAULT FALSE,profit_min_margin NUMERIC DEFAULT 0,profit_safety_buffer NUMERIC DEFAULT 0,rpm_limit INTEGER DEFAULT 0);
CREATE TABLE api_keys (id BIGINT PRIMARY KEY,key TEXT UNIQUE NOT NULL,user_id BIGINT NOT NULL,group_id BIGINT NOT NULL,status TEXT DEFAULT 'active',deleted_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,
  quota NUMERIC DEFAULT 0,quota_used NUMERIC DEFAULT 0,ip_whitelist JSONB DEFAULT '[]',ip_blacklist JSONB DEFAULT '[]',
  usage_5h NUMERIC DEFAULT 0,usage_1d NUMERIC DEFAULT 0,usage_7d NUMERIC DEFAULT 0,rate_limit_5h NUMERIC DEFAULT 0,rate_limit_1d NUMERIC DEFAULT 0,rate_limit_7d NUMERIC DEFAULT 0,
  window_5h_start TIMESTAMPTZ,window_1d_start TIMESTAMPTZ,window_7d_start TIMESTAMPTZ,last_used_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE accounts (id BIGINT PRIMARY KEY,deleted_at TIMESTAMPTZ);
CREATE TABLE user_group_rate_multipliers (user_id BIGINT,group_id BIGINT,rate_multiplier NUMERIC,rpm_override INTEGER);
CREATE TABLE user_platform_quotas (user_id BIGINT,platform TEXT,deleted_at TIMESTAMPTZ,daily_limit_usd NUMERIC,weekly_limit_usd NUMERIC,monthly_limit_usd NUMERIC);
CREATE TABLE user_allowed_groups (user_id BIGINT,group_id BIGINT);
CREATE TABLE channels (id BIGINT PRIMARY KEY,status TEXT DEFAULT 'active',model_mapping JSONB DEFAULT '{}',billing_model_source TEXT DEFAULT 'channel_mapped');
CREATE TABLE channel_groups (channel_id BIGINT,group_id BIGINT);
CREATE TABLE channel_model_pricing (id BIGINT PRIMARY KEY,channel_id BIGINT,platform TEXT,models JSONB,billing_mode TEXT,per_request_price NUMERIC,time_pricing JSONB);
CREATE TABLE channel_pricing_intervals (id BIGINT PRIMARY KEY,pricing_id BIGINT,tier_label TEXT,min_tokens INTEGER DEFAULT 0,max_tokens INTEGER,per_request_price NUMERIC,sort_order INTEGER DEFAULT 0);
CREATE TABLE usage_logs (id BIGSERIAL PRIMARY KEY,user_id BIGINT,api_key_id BIGINT,account_id BIGINT,group_id BIGINT,request_id TEXT,model TEXT,requested_model TEXT,upstream_model TEXT,
  total_cost NUMERIC(20,10),actual_cost NUMERIC(20,10),account_stats_cost NUMERIC(20,10),rate_multiplier NUMERIC,account_rate_multiplier NUMERIC,billing_type INTEGER,billing_mode TEXT,
  video_count INTEGER,video_resolution VARCHAR(10),video_duration_seconds INTEGER,stream BOOLEAN,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE auth_cache_invalidation_outbox (id BIGSERIAL PRIMARY KEY,cache_key CHAR(64) NOT NULL);
