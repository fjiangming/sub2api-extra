'use strict';

const path = require('node:path');
const { z } = require('zod');

const optionalString = z.preprocess((value) => value === '' ? undefined : value, z.string().trim().optional());
const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  USAGE_LEADERBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(9876),
  USAGE_LEADERBOARD_BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
  USAGE_LEADERBOARD_TRUST_PROXY: boolean.default(false),
  USAGE_LEADERBOARD_COOKIE_SECURE: boolean.optional(),
  USAGE_LEADERBOARD_CACHE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  USAGE_LEADERBOARD_PERSONAL_CACHE_ENTRIES: z.coerce.number().int().min(1).max(2000).default(256),
  USAGE_LEADERBOARD_MAX_SESSIONS: z.coerce.number().int().min(1).max(10000).default(1000),
  USAGE_LEADERBOARD_SESSION_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  USAGE_LEADERBOARD_INCLUDE_ADMINS: boolean.default(false),
  SUB2API_BASE_URL: z.string().trim().default('http://127.0.0.1:8080'),
  SUB2API_PUBLIC_URL: optionalString,
  SUB2API_TIMEZONE: z.string().trim().default('Asia/Shanghai'),
  SUB2API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  SUB2API_FORWARD_CLIENT_FINGERPRINT: boolean.default(false),
  SUB2API_DATABASE_URL: optionalString,
  SUB2API_DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  USAGE_LEADERBOARD_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  USAGE_LEADERBOARD_DATABASE_CONNECTIONS: z.coerce.number().int().min(1).max(8).default(3)
});

function baseUrl(value, name) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${name}: 必须是不含账号、路径或参数的 HTTP(S) 根地址`);
  }
}

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`配置无效: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  const value = parsed.data;
  const sub2apiBaseUrl = baseUrl(value.SUB2API_BASE_URL, 'SUB2API_BASE_URL');
  const sub2apiPublicUrl = baseUrl(value.SUB2API_PUBLIC_URL || sub2apiBaseUrl, 'SUB2API_PUBLIC_URL');
  try { new Intl.DateTimeFormat('en', { timeZone: value.SUB2API_TIMEZONE }); }
  catch { throw new Error('SUB2API_TIMEZONE: 无效的 IANA 时区'); }
  if (value.SUB2API_DATABASE_URL) {
    try {
      const url = new URL(value.SUB2API_DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.search || url.hash) throw new Error();
    } catch { throw new Error('SUB2API_DATABASE_URL: 必须是无查询参数的 PostgreSQL 连接串，SSL 通过 SUB2API_DATABASE_SSL 设置'); }
  }
  if (value.NODE_ENV === 'production' && (!sub2apiPublicUrl.startsWith('https://') || value.USAGE_LEADERBOARD_COOKIE_SECURE === false)) {
    throw new Error('生产环境需要 SUB2API_PUBLIC_URL 的 HTTPS 地址和 Secure Cookie');
  }
  return {
    env: value.NODE_ENV,
    projectRoot: path.join(__dirname, '..'),
    port: value.USAGE_LEADERBOARD_PORT,
    bindHost: value.USAGE_LEADERBOARD_BIND_HOST,
    trustProxy: value.USAGE_LEADERBOARD_TRUST_PROXY,
    cookieSecure: value.USAGE_LEADERBOARD_COOKIE_SECURE ?? value.NODE_ENV === 'production',
    cacheTtlMs: value.USAGE_LEADERBOARD_CACHE_SECONDS * 1000,
    personalCacheEntries: value.USAGE_LEADERBOARD_PERSONAL_CACHE_ENTRIES,
    maxSessions: value.USAGE_LEADERBOARD_MAX_SESSIONS,
    sessionTtlMs: value.USAGE_LEADERBOARD_SESSION_MINUTES * 60000,
    includeAdmins: value.USAGE_LEADERBOARD_INCLUDE_ADMINS,
    sub2apiBaseUrl,
    sub2apiPublicUrl,
    timezone: value.SUB2API_TIMEZONE,
    upstreamTimeoutMs: value.SUB2API_REQUEST_TIMEOUT_MS,
    forwardClientFingerprint: value.SUB2API_FORWARD_CLIENT_FINGERPRINT,
    databaseUrl: value.SUB2API_DATABASE_URL || null,
    databaseSsl: value.SUB2API_DATABASE_SSL,
    queryTimeoutMs: value.USAGE_LEADERBOARD_QUERY_TIMEOUT_MS,
    databaseConnections: value.USAGE_LEADERBOARD_DATABASE_CONNECTIONS
  };
}

module.exports = { loadConfig };
