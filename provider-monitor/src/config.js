const path = require('path');

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUrl(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function resolveProjectPath(value, fallback, projectRoot) {
  const raw = String(value || fallback || '').trim();
  if (!raw) return projectRoot;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
}

function loadConfig(env = process.env) {
  const projectRoot = path.resolve(__dirname, '..');
  const secret = String(env.PROVIDER_MONITOR_SECRET || '');
  if (secret.length < 32) {
    throw new Error('PROVIDER_MONITOR_SECRET is required and must contain at least 32 characters');
  }

  const sub2apiBaseUrl = normalizeUrl(env.SUB2API_BASE_URL, 'http://localhost:8080');
  const dataDir = resolveProjectPath(env.PROVIDER_MONITOR_DATA_DIR, 'data', projectRoot);
  const config = {
    env: env.NODE_ENV || 'development',
    port: parseInteger(env.PORT, 3200, 1, 65535),
    bindHost: String(env.PROVIDER_MONITOR_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1',
    projectRoot,
    dataDir,
    databasePath: env.PROVIDER_MONITOR_DATABASE
      ? resolveProjectPath(env.PROVIDER_MONITOR_DATABASE, '', projectRoot)
      : path.join(dataDir, 'provider-monitor.db'),
    secret,
    authMode: env.PROVIDER_MONITOR_AUTH_MODE || 'sub2api',
    sub2apiBaseUrl,
    sub2apiPublicUrl: normalizeUrl(env.SUB2API_PUBLIC_URL, sub2apiBaseUrl),
    adminEmail: String(env.ADMIN_EMAIL || ''),
    adminPassword: String(env.ADMIN_PASSWORD || ''),
    sub2apiAdminToken: String(env.SUB2API_ADMIN_TOKEN || ''),
    localAdminUsername: String(env.PROVIDER_MONITOR_LOCAL_ADMIN_USER || 'admin'),
    localAdminPassword: String(env.PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD || ''),
    localAdminPasswordHash: String(env.PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD_HASH || ''),
    sessionTtlMinutes: parseInteger(env.PROVIDER_MONITOR_SESSION_TTL_MINUTES, 480, 15, 1440),
    queryTimeoutMs: parseInteger(env.PROVIDER_MONITOR_QUERY_TIMEOUT_MS, 15000, 1000, 120000),
    maxResponseBytes: parseInteger(env.PROVIDER_MONITOR_MAX_RESPONSE_BYTES, 2 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    globalConcurrency: parseInteger(env.PROVIDER_MONITOR_CONCURRENCY, 5, 1, 20),
    perProviderConcurrency: parseInteger(env.PROVIDER_MONITOR_PROVIDER_CONCURRENCY, 2, 1, 5),
    keyHealthConcurrency: parseInteger(env.PROVIDER_MONITOR_KEY_HEALTH_CONCURRENCY, 3, 1, 10),
    defaultRefreshMinutes: parseInteger(env.PROVIDER_MONITOR_REFRESH_MINUTES, 15, 1, 1440),
    staleAfterMinutes: parseInteger(env.PROVIDER_MONITOR_STALE_MINUTES, 60, 5, 10080),
    rawSnapshotRetentionDays: parseInteger(env.PROVIDER_MONITOR_RAW_SNAPSHOT_RETENTION_DAYS, 30, 7, 3650),
    snapshotRetentionDays: parseInteger(env.PROVIDER_MONITOR_SNAPSHOT_RETENTION_DAYS, 180, 30, 3650),
    jobRetentionDays: parseInteger(env.PROVIDER_MONITOR_JOB_RETENTION_DAYS, 90, 7, 3650),
    auditRetentionDays: parseInteger(env.PROVIDER_MONITOR_AUDIT_RETENTION_DAYS, 365, 30, 3650),
    notificationRetentionDays: parseInteger(env.PROVIDER_MONITOR_NOTIFICATION_RETENTION_DAYS, 180, 7, 3650),
    allowedHosts: parseList(env.PROVIDER_MONITOR_ALLOWED_HOSTS),
    allowPrivateNetworks: parseBoolean(env.PROVIDER_MONITOR_ALLOW_PRIVATE_NETWORKS, false),
    allowedOrigins: parseList(env.PROVIDER_MONITOR_ALLOWED_ORIGINS),
    metricsEnabled: parseBoolean(env.PROVIDER_MONITOR_METRICS_ENABLED, true),
    automationEnabled: parseBoolean(env.PROVIDER_MONITOR_AUTOMATION_ENABLED, false),
    logLevel: env.PROVIDER_MONITOR_LOG_LEVEL || 'info',
    timezone: env.PROVIDER_MONITOR_TIMEZONE || 'Asia/Shanghai',
    smtp: {
      host: env.PROVIDER_MONITOR_SMTP_HOST || '',
      port: parseInteger(env.PROVIDER_MONITOR_SMTP_PORT, 587, 1, 65535),
      secure: parseBoolean(env.PROVIDER_MONITOR_SMTP_SECURE, false),
      user: env.PROVIDER_MONITOR_SMTP_USER || '',
      password: env.PROVIDER_MONITOR_SMTP_PASSWORD || '',
      from: env.PROVIDER_MONITOR_SMTP_FROM || ''
    }
  };
  if (
    config.authMode === 'local' &&
    !config.localAdminPasswordHash &&
    !config.localAdminPassword
  ) {
    throw new Error(
      'Local authentication requires PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD_HASH or PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD'
    );
  }
  return config;
}

module.exports = {
  loadConfig,
  normalizeUrl,
  parseBoolean,
  parseInteger,
  parseList,
  resolveProjectPath
};
