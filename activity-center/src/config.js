'use strict';

const path = require('node:path');
const { z } = require('zod');

const flag = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ACTIVITY_CENTER_PORT: z.coerce.number().int().min(1).max(65535).default(9878),
  ACTIVITY_CENTER_BIND_HOST: z.string().default('127.0.0.1'),
  ACTIVITY_CENTER_PUBLIC_URL: z.string().default('http://127.0.0.1:9878'),
  ACTIVITY_CENTER_DATA_DIR: z.string().default('./data'),
  // Reject legacy overrides so recharge eligibility cannot be backdated.
  ACTIVITY_CENTER_START_AT: z.never().optional(),
  ACTIVITY_CENTER_ENABLED: flag.default(true),
  ACTIVITY_CENTER_TRUST_PROXY: flag.default(false),
  ACTIVITY_CENTER_COOKIE_SECURE: flag.optional(),
  ACTIVITY_CENTER_RECHARGE_SOURCES: z.string().default('redemptions'),
  // Retained only to verify the source identity when migrating an existing campaign.
  ACTIVITY_CENTER_RECHARGE_URL: z.string().optional(),
  SUB2API_BASE_URL: z.string().default('http://127.0.0.1:8080'),
  SUB2API_PUBLIC_URL: z.string().default('http://127.0.0.1:8080'),
  SUB2API_PUBLIC_URLS: z.string().default(''),
  SUB2API_ADMIN_API_KEY: z.string().min(16).max(256),
  SUB2API_FORWARD_CLIENT_FINGERPRINT: flag.default(false),
  SUB2API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  SUB2API_DATABASE_URL: z.string().optional(),
  SUB2API_DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  SUB2API_TIMEZONE: z.string().default('Asia/Shanghai')
});

function httpUrl(value, name, rootOnly = true) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.includes('*') || url.username || url.password || url.search || url.hash ||
        (rootOnly && url.pathname !== '/')) throw new Error();
    return rootOnly ? url.origin : url.href;
  } catch { throw new Error(`${name}: 必须为不含凭据、参数或片段的 HTTP(S) 地址`); }
}

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  if (!parsed.success) throw new Error(`活动中心配置无效: ${parsed.error.issues.map(v => v.path.join('.')).join(', ')}`);
  const v = parsed.data;
  const publicUrl = httpUrl(v.ACTIVITY_CENTER_PUBLIC_URL, 'ACTIVITY_CENTER_PUBLIC_URL');
  const sub2apiPublicUrl = httpUrl(v.SUB2API_PUBLIC_URL, 'SUB2API_PUBLIC_URL');
  const configuredSources = [...new Set(v.ACTIVITY_CENTER_RECHARGE_SOURCES.split(',').map(s => s.trim()))];
  if (configuredSources.some(s => !['redemptions', 'official', 'recharge_center'].includes(s)) ||
      (configuredSources.includes('redemptions') && configuredSources.length !== 1)) throw new Error('ACTIVITY_CENTER_RECHARGE_SOURCES: 无效来源');
  if (!v.SUB2API_DATABASE_URL) throw new Error('主站兑换来源需要只读数据库连接');
  if (v.SUB2API_DATABASE_URL) {
    const db = new URL(v.SUB2API_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || db.pathname.length < 2 || db.search || db.hash) throw new Error('SUB2API_DATABASE_URL: 无效连接串');
  }
  const origins = [...new Set([sub2apiPublicUrl, ...v.SUB2API_PUBLIC_URLS.split(',').map(s => s.trim()).filter(Boolean).map(s => httpUrl(s, 'SUB2API_PUBLIC_URLS'))])];
  if (v.NODE_ENV === 'production' && ([publicUrl, ...origins].some(s => !s.startsWith('https:')) || v.ACTIVITY_CENTER_COOKIE_SECURE === false || !/^admin-[a-f0-9]{64}$/.test(v.SUB2API_ADMIN_API_KEY))) throw new Error('生产环境需要 HTTPS、Secure Cookie 和主站管理员 API Key');
  try { new Intl.DateTimeFormat('en', { timeZone: v.SUB2API_TIMEZONE }); } catch { throw new Error('SUB2API_TIMEZONE: 无效时区'); }
  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = path.resolve(projectRoot, v.ACTIVITY_CENTER_DATA_DIR);
  const relative = path.relative(path.join(projectRoot, 'public'), dataDir);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('数据目录不能在静态目录中');
  return {
    env: v.NODE_ENV, projectRoot, dataDir, port: v.ACTIVITY_CENTER_PORT, bindHost: v.ACTIVITY_CENTER_BIND_HOST,
    publicUrl, sub2apiPublicUrl, origins, sub2apiBaseUrl: httpUrl(v.SUB2API_BASE_URL, 'SUB2API_BASE_URL'),
    rechargeUrl: v.ACTIVITY_CENTER_RECHARGE_URL ? httpUrl(v.ACTIVITY_CENTER_RECHARGE_URL, 'ACTIVITY_CENTER_RECHARGE_URL') : null,
    adminKey: v.SUB2API_ADMIN_API_KEY,
    sources: ['redemptions'],
    enabled: v.ACTIVITY_CENTER_ENABLED, timezone: v.SUB2API_TIMEZONE,
    databaseUrl: v.SUB2API_DATABASE_URL, databaseSsl: v.SUB2API_DATABASE_SSL,
    timeoutMs: v.SUB2API_REQUEST_TIMEOUT_MS, forwardFingerprint: v.SUB2API_FORWARD_CLIENT_FINGERPRINT,
    trustProxy: v.ACTIVITY_CENTER_TRUST_PROXY, cookieSecure: v.ACTIVITY_CENTER_COOKIE_SECURE ?? v.NODE_ENV === 'production',
    maxSessions: 1000, sessionTtlMs: 30 * 60000
  };
}

module.exports = { loadConfig, httpUrl };
