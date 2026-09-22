'use strict';

const { z } = require('zod');

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}, z.boolean());

const optionalUrl = z.preprocess(
  (value) => value == null || String(value).trim() === '' ? undefined : String(value).trim(),
  z.string().url().optional()
);

const optionalString = z.preprocess(
  (value) => value == null || String(value).trim() === '' ? undefined : String(value),
  z.string().optional()
);

const optionalPassword = z.preprocess(
  (value) => value == null || String(value) === '' ? undefined : String(value),
  z.string().min(12).max(1024).optional()
);

const cleanupTargetIds = [
  'usage_logs',
  'usage_hourly',
  'usage_daily',
  'system_logs',
  'error_logs',
  'ops_metrics'
];

const automaticCleanupTargets = z.preprocess((value) => {
  const source = value == null || String(value).trim() === ''
    ? 'system_logs,error_logs,ops_metrics'
    : String(value);
  return [...new Set(source.split(',').map((item) => item.trim()).filter(Boolean))];
}, z.array(z.enum(cleanupTargetIds)).min(1));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPERATIONS_CENTER_BIND_HOST: z.string().default('127.0.0.1'),
  OPERATIONS_CENTER_PORT: z.coerce.number().int().min(1).max(65535).default(9872),
  OPERATIONS_CENTER_AUTH_MODE: z.enum(['local', 'sub2api']).default('local'),
  OPERATIONS_CENTER_ADMIN_USER: z.string().trim().min(1).max(100).default('admin'),
  OPERATIONS_CENTER_ADMIN_PASSWORD: optionalPassword,
  OPERATIONS_CENTER_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  OPERATIONS_CENTER_COOKIE_SECURE: boolFromEnv.default(false),
  OPERATIONS_CENTER_TRUST_PROXY: boolFromEnv.default(false),
  OPERATIONS_CENTER_ENABLE_CLEANUP: boolFromEnv.default(false),
  OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP: boolFromEnv.default(true),
  OPERATIONS_CENTER_PREVIEW_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(15),
  OPERATIONS_CENTER_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  OPERATIONS_CENTER_CLEANUP_TIMEOUT_MS: z.coerce.number().int().min(10000).max(3600000).default(1800000),
  OPERATIONS_CENTER_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(100).max(10000).default(5000),
  OPERATIONS_CENTER_CLEANUP_BATCH_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(250),
  OPERATIONS_CENTER_CLEANUP_MAX_ROWS: z.coerce.number().int().min(1000).max(1000000000).default(5000000),
  OPERATIONS_CENTER_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  OPERATIONS_CENTER_CAPACITY_SAMPLE_LIMIT: z.coerce.number().int().min(24).max(2016).default(336),
  OPERATIONS_CENTER_CAPACITY_SAMPLE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: boolFromEnv.default(false),
  OPERATIONS_CENTER_AUTO_CLEANUP_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '必须是 HH:mm 格式').default('03:30'),
  OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS: automaticCleanupTargets,
  OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES: z.coerce.number().int().min(1).max(55).default(10),
  SUB2API_DATABASE_URL: z.string().min(1),
  SUB2API_MAINTENANCE_DATABASE_URL: optionalString,
  SUB2API_DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  SUB2API_TIMEZONE: z.string().trim().min(1).max(100).default('Asia/Shanghai'),
  FINANCE_TIMEZONE: z.string().trim().min(1).max(100).default('Asia/Shanghai'),
  SUB2API_BASE_URL: optionalUrl,
  SUB2API_PUBLIC_URL: optionalUrl,
  SUB2API_ADMIN_TOKEN: optionalString,
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  SUB2API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  RETENTION_USAGE_LOGS_DAYS: z.coerce.number().int().min(30).max(3650).default(30),
  RETENTION_USAGE_HOURLY_DAYS: z.coerce.number().int().min(30).max(3650).default(30),
  RETENTION_USAGE_DAILY_DAYS: z.coerce.number().int().min(365).max(3650).default(730),
  RETENTION_SYSTEM_LOG_DAYS: z.coerce.number().int().min(7).max(3650).default(7),
  RETENTION_ERROR_LOG_DAYS: z.coerce.number().int().min(30).max(3650).default(30),
  RETENTION_OPS_METRIC_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  RETENTION_BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(168).default(24)
}).superRefine((value, ctx) => {
  if (value.OPERATIONS_CENTER_AUTH_MODE === 'local' && !value.OPERATIONS_CENTER_ADMIN_PASSWORD) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPERATIONS_CENTER_ADMIN_PASSWORD'],
      message: 'local 认证模式必须配置本地管理员密码'
    });
  }
  if (value.OPERATIONS_CENTER_AUTH_MODE === 'sub2api' && !value.SUB2API_BASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUB2API_BASE_URL'],
      message: 'sub2api 认证模式必须配置 Sub2API API 地址'
    });
  }
  if (value.NODE_ENV === 'production' && value.OPERATIONS_CENTER_AUTH_MODE === 'local' &&
      value.OPERATIONS_CENTER_ADMIN_PASSWORD && value.OPERATIONS_CENTER_ADMIN_PASSWORD.length < 16) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPERATIONS_CENTER_ADMIN_PASSWORD'],
      message: '生产环境管理员密码至少需要 16 个字符'
    });
  }
  if (value.OPERATIONS_CENTER_ENABLE_CLEANUP && !value.SUB2API_MAINTENANCE_DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUB2API_MAINTENANCE_DATABASE_URL'],
      message: '启用清理时必须显式提供维护数据库连接，不能隐式提升只读连接权限'
    });
  }
  if (value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED && !value.OPERATIONS_CENTER_ENABLE_CLEANUP) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED'],
      message: '自动清理要求同时启用 OPERATIONS_CENTER_ENABLE_CLEANUP'
    });
  }
  if (value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED && !value.OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP'],
      message: '自动清理不能关闭新鲜备份硬闸门'
    });
  }
  const hasSub2ApiCredentials = Boolean(value.SUB2API_ADMIN_TOKEN || (value.ADMIN_EMAIL && value.ADMIN_PASSWORD));
  if (value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED && !value.SUB2API_BASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUB2API_BASE_URL'],
      message: '自动清理要求配置 Sub2API 管理 API 地址'
    });
  }
  if (value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED &&
      value.OPERATIONS_CENTER_AUTH_MODE === 'local' && !hasSub2ApiCredentials) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUB2API_ADMIN_TOKEN'],
      message: 'local 认证模式的自动清理要求配置 Sub2API 管理员凭据或令牌'
    });
  }
  if (value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED &&
      value.OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES + 1 >= value.OPERATIONS_CENTER_PREVIEW_TTL_MINUTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES'],
      message: '自动备份等待时间必须至少比预览有效期短 2 分钟'
    });
  }
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`operations-center 配置无效: ${message}`);
  }
  const value = parsed.data;
  for (const [name, timezone] of [['SUB2API_TIMEZONE', value.SUB2API_TIMEZONE], ['FINANCE_TIMEZONE', value.FINANCE_TIMEZONE]]) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      throw new Error(`operations-center 配置无效: ${name}: 不是有效的 IANA 时区`);
    }
  }
  return {
    env: value.NODE_ENV,
    bindHost: value.OPERATIONS_CENTER_BIND_HOST,
    port: value.OPERATIONS_CENTER_PORT,
    authMode: value.OPERATIONS_CENTER_AUTH_MODE,
    adminUser: value.OPERATIONS_CENTER_ADMIN_USER,
    adminPassword: value.OPERATIONS_CENTER_ADMIN_PASSWORD || '',
    sessionTtlMinutes: value.OPERATIONS_CENTER_SESSION_TTL_MINUTES,
    cookieSecure: value.OPERATIONS_CENTER_COOKIE_SECURE,
    trustProxy: value.OPERATIONS_CENTER_TRUST_PROXY,
    cleanupEnabled: value.OPERATIONS_CENTER_ENABLE_CLEANUP,
    requireFreshBackup: value.OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP,
    previewTtlMinutes: value.OPERATIONS_CENTER_PREVIEW_TTL_MINUTES,
    queryTimeoutMs: value.OPERATIONS_CENTER_QUERY_TIMEOUT_MS,
    cleanupTimeoutMs: value.OPERATIONS_CENTER_CLEANUP_TIMEOUT_MS,
    cleanupBatchSize: value.OPERATIONS_CENTER_CLEANUP_BATCH_SIZE,
    cleanupBatchDelayMs: value.OPERATIONS_CENTER_CLEANUP_BATCH_DELAY_MS,
    cleanupMaxRows: value.OPERATIONS_CENTER_CLEANUP_MAX_ROWS,
    cacheTtlSeconds: value.OPERATIONS_CENTER_CACHE_TTL_SECONDS,
    capacitySampleLimit: value.OPERATIONS_CENTER_CAPACITY_SAMPLE_LIMIT,
    capacitySampleIntervalMinutes: value.OPERATIONS_CENTER_CAPACITY_SAMPLE_INTERVAL_MINUTES,
    automaticCleanup: {
      enabled: value.OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED,
      time: value.OPERATIONS_CENTER_AUTO_CLEANUP_TIME,
      targets: value.OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS,
      backupWaitMinutes: value.OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES
    },
    databaseUrl: value.SUB2API_DATABASE_URL,
    maintenanceDatabaseUrl: value.SUB2API_MAINTENANCE_DATABASE_URL || null,
    databaseSsl: value.SUB2API_DATABASE_SSL,
    sub2apiTimezone: value.SUB2API_TIMEZONE,
    financeTimezone: value.FINANCE_TIMEZONE,
    sub2apiBaseUrl: value.SUB2API_BASE_URL?.replace(/\/$/, '') || null,
    sub2apiPublicUrl: value.SUB2API_PUBLIC_URL?.replace(/\/$/, '') ||
      value.SUB2API_BASE_URL?.replace(/\/$/, '') || null,
    sub2apiAdminToken: value.SUB2API_ADMIN_TOKEN || null,
    sub2apiAdminEmail: value.ADMIN_EMAIL || null,
    sub2apiAdminPassword: value.ADMIN_PASSWORD || null,
    sub2apiRequestTimeoutMs: value.SUB2API_REQUEST_TIMEOUT_MS,
    retention: {
      usageLogsDays: value.RETENTION_USAGE_LOGS_DAYS,
      usageHourlyDays: value.RETENTION_USAGE_HOURLY_DAYS,
      usageDailyDays: value.RETENTION_USAGE_DAILY_DAYS,
      systemLogDays: value.RETENTION_SYSTEM_LOG_DAYS,
      errorLogDays: value.RETENTION_ERROR_LOG_DAYS,
      opsMetricDays: value.RETENTION_OPS_METRIC_DAYS,
      backupMaxAgeHours: value.RETENTION_BACKUP_MAX_AGE_HOURS
    }
  };
}

module.exports = { loadConfig, cleanupTargetIds };
