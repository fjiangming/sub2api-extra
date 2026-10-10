'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { ensure } = require('./errors');
const { decimal } = require('./money');

const amount = z.string().regex(/^\d+(?:\.\d+)?$/);
const fieldPath = z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_0-9]+)*$/);
const costSchema = z.object({
  mode: z.enum(['per_request', 'per_second']), currency: z.enum(['USD', 'CNY']),
  prices: z.record(z.string(), amount), usdPerUnit: amount.optional(),
  verifiedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  evidence: z.string().min(8), feeMultiplier: amount.default('1'), fixedFee: amount.default('0'),
  referencesIncluded: z.boolean().default(false), feesRefundable: z.boolean().default(false)
}).strict();
const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/), enabled: z.boolean().default(false),
  type: z.enum(['lingsu', 'xcm', 'openai', 'configured', 'mock']),
  baseUrl: z.url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  idempotentCreate: z.boolean().default(false),
  idempotencyRetentionSeconds: z.number().int().positive().max(2592000).optional(),
  financialMode: z.enum(['funds_status', 'bounded_success', 'manual']).default('manual'),
  dailyCostBudgetUsd: amount.default('50'), downloadHosts: z.array(z.string()).default([]),
  downloadMode: z.enum(['content', 'status_url']).default('content'),
  createPath: z.string().optional(), statusPath: z.string().optional(), contentPath: z.string().optional(),
  response: z.object({
    idPaths: z.array(fieldPath).optional(), statusPaths: z.array(fieldPath).optional(),
    urlPaths: z.array(fieldPath).optional(), fundsPaths: z.array(fieldPath).optional(),
    amountPaths: z.array(fieldPath).optional(), reviewPaths: z.array(fieldPath).optional(),
    success: z.array(z.string()).optional(), failure: z.array(z.string()).optional()
  }).strict().optional(),
  quote: z.object({
    path: z.string(), method: z.enum(['GET', 'POST']).default('GET'),
    amountPath: fieldPath, currency: z.enum(['USD', 'CNY']),
    mode: z.enum(['per_request', 'per_second']).default('per_request')
  }).strict().optional()
}).strict();
const modelSchema = z.object({
  id: z.string().min(1).max(100), provider: z.string(), upstreamModel: z.string().min(1).max(100),
  enabled: z.boolean().default(false), minDuration: z.number().int().min(1), maxDuration: z.number().int().max(600),
  durations: z.array(z.number().int().min(1)).optional(), defaultDuration: z.number().int().min(1),
  resolutions: z.array(z.enum(['480p', '720p', '1080p', '2k', '4k'])).min(1),
  aspectRatios: z.array(z.string()).min(1),
  maxReferences: z.object({ image: z.number().int().min(0), video: z.number().int().min(0), audio: z.number().int().min(0), total: z.number().int().min(0) }).strict(),
  requestStyle: z.enum(['standard', 'lingsu-special', 'lingsu-references', 'xcm-h3', 'xcm-mixed']).default('standard'),
  fields: z.record(z.string(), fieldPath).default({}), cost: costSchema
}).strict();
const catalogSchema = z.object({ version: z.string().min(1), providers: z.array(providerSchema), models: z.array(modelSchema) }).strict();

function positiveInteger(env, name, fallback, min = 1, max = 100000000) {
  const value = Number(env[name] ?? fallback);
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_CONFIG', `${name} is out of range`);
  return value;
}

function loadConfig(env = process.env, demo = false) {
  const production = !demo && env.VIDEO_ADAPTER_MODE !== 'demo';
  const config = {
    production, port: positiveInteger(env, 'VIDEO_ADAPTER_PORT', 9875, 1, 65535),
    host: env.VIDEO_ADAPTER_BIND_HOST || '127.0.0.1',
    databaseUrl: env.VIDEO_ADAPTER_DATABASE_URL, databaseSsl: env.VIDEO_ADAPTER_DATABASE_SSL || 'verify-full',
    redisUrl: env.VIDEO_ADAPTER_REDIS_URL,
    catalogPath: path.resolve(env.VIDEO_ADAPTER_CATALOG_PATH || path.join(__dirname, '../config/catalog.json')),
    groupIds: String(env.VIDEO_ADAPTER_GROUP_IDS || (production ? '' : '1')).split(',').filter(Boolean),
    usageAccountId: env.VIDEO_ADAPTER_USAGE_ACCOUNT_ID || (production ? '' : '1'),
    encryptionKey: env.VIDEO_ADAPTER_ENCRYPTION_KEY || (production ? '' : Buffer.alloc(32, 7).toString('base64')),
    adminToken: env.VIDEO_ADAPTER_ADMIN_TOKEN || (production ? '' : 'demo-admin-local-only'),
    timezone: env.VIDEO_ADAPTER_TIMEZONE || 'Asia/Shanghai',
    revenueFactor: env.VIDEO_ADAPTER_REVENUE_FACTOR || '0.80',
    minMargin: env.VIDEO_ADAPTER_MIN_MARGIN || '0.20', costBuffer: env.VIDEO_ADAPTER_COST_BUFFER || '0.10',
    overheadUsd: env.VIDEO_ADAPTER_OVERHEAD_USD || '0.01', maxJobCostUsd: env.VIDEO_ADAPTER_MAX_JOB_COST_USD || '20',
    dailyCostBudgetUsd: env.VIDEO_ADAPTER_DAILY_COST_BUDGET_USD || '100',
    maxActiveJobsPerUser: positiveInteger(env, 'VIDEO_ADAPTER_MAX_ACTIVE_JOBS_PER_USER', 2),
    maxDownloadsPerJob: positiveInteger(env, 'VIDEO_ADAPTER_MAX_DOWNLOADS_PER_JOB', 4, 1, 100),
    pollIntervalMs: positiveInteger(env, 'VIDEO_ADAPTER_POLL_INTERVAL_MS', 5000, 100, 3600000),
    maxTaskAgeMs: positiveInteger(env, 'VIDEO_ADAPTER_MAX_TASK_AGE_MS', 86400000, 1000, 604800000),
    workerConcurrency: positiveInteger(env, 'VIDEO_ADAPTER_WORKER_CONCURRENCY', 4, 1, 32),
    requestTimeoutMs: 30000, leaseMs: 120000,
    trustProxy: env.VIDEO_ADAPTER_TRUST_PROXY ? env.VIDEO_ADAPTER_TRUST_PROXY.split(',').map(s => s.trim()) : false
  };
  for (const name of ['revenueFactor', 'minMargin', 'costBuffer', 'overheadUsd', 'maxJobCostUsd', 'dailyCostBudgetUsd']) decimal(config[name]);
  ensure(decimal(config.revenueFactor).gt(0) && decimal(config.revenueFactor).lte(1), 'INVALID_CONFIG', 'Revenue factor must be in (0, 1]');
  ensure(decimal(config.minMargin).lt(1), 'INVALID_CONFIG', 'Minimum margin must be below 1');
  ensure(decimal(config.dailyCostBudgetUsd).gt(0) && decimal(config.maxJobCostUsd).gt(0), 'INVALID_CONFIG', 'Cost budgets must be positive');
  ensure(config.groupIds.length && config.groupIds.every(id => /^[1-9]\d*$/.test(id)), 'INVALID_CONFIG', 'Dedicated group IDs are required');
  ensure(/^[1-9]\d*$/.test(config.usageAccountId), 'INVALID_CONFIG', 'An existing usage attribution account ID is required');
  ensure(Buffer.from(config.encryptionKey, 'base64').length === 32, 'INVALID_CONFIG', 'Encryption key must be 32 bytes encoded in base64');
  ensure(!production || config.adminToken.length >= 32, 'INVALID_CONFIG', 'A random admin token of at least 32 characters is required');
  ensure(!production || (config.databaseUrl && config.redisUrl), 'INVALID_CONFIG', 'Production requires Sub2API PostgreSQL and Redis connections');
  ensure(['disable', 'verify-full'].includes(config.databaseSsl), 'INVALID_CONFIG', 'Database SSL must be disable or verify-full');
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
  ensure(production || ['127.0.0.1', '::1', 'localhost'].includes(config.host), 'INVALID_CONFIG', 'Demo must listen on loopback only');
  return config;
}

function parseCatalog(input, env = process.env, production = true) {
  const catalog = catalogSchema.parse(input);
  ensure(new Set(catalog.providers.map(p => p.id)).size === catalog.providers.length, 'INVALID_CATALOG', 'Duplicate provider IDs');
  ensure(new Set(catalog.models.map(m => m.id)).size === catalog.models.length, 'INVALID_CATALOG', 'Duplicate public model IDs');
  for (const provider of catalog.providers) {
    ensure(!production || provider.type !== 'mock', 'INVALID_CATALOG', 'Mock providers are not allowed in production');
    const url = new URL(provider.baseUrl);
    ensure(!production || url.protocol === 'https:', 'INVALID_CATALOG', 'Production providers require HTTPS');
    ensure(!url.username && !url.password && !url.search && !url.hash, 'INVALID_CATALOG', 'Provider base URLs cannot contain credentials, query or fragment');
    provider.baseUrl = provider.baseUrl.replace(/\/$/, '');
    provider.apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    ensure(!provider.enabled || provider.type === 'mock' || provider.apiKey, 'INVALID_CATALOG', `Missing credential for provider ${provider.id}`);
    ensure(provider.type !== 'lingsu' || provider.idempotentCreate, 'INVALID_CATALOG', 'Lingsu requires durable idempotency');
    ensure(!provider.enabled || !provider.idempotentCreate || provider.idempotencyRetentionSeconds,
      'INVALID_CATALOG','Idempotent suppliers require a verified minimum key-retention duration');
    ensure(provider.type !== 'lingsu' || provider.financialMode === 'funds_status', 'INVALID_CATALOG', 'Lingsu must reconcile native financial status');
    ensure(decimal(provider.dailyCostBudgetUsd).gt(0), 'INVALID_CATALOG', 'Provider cost budget must be positive');
    ensure(provider.downloadHosts.every(host => /^[a-z0-9.-]+$/i.test(host) && !host.includes('*')), 'INVALID_CATALOG', 'Download hosts must be exact hostnames');
    for (const route of [provider.createPath, provider.statusPath, provider.contentPath, provider.quote?.path].filter(Boolean)) {
      ensure(route.startsWith('/') && !route.startsWith('//') && !route.includes('..') && !route.includes('#'), 'INVALID_CATALOG', 'Provider endpoint must be a relative path');
    }
  }
  for (const model of catalog.models) {
    const provider = catalog.providers.find(p => p.id === model.provider);
    ensure(provider, 'INVALID_CATALOG', `Unknown provider for ${model.id}`);
    ensure(model.minDuration <= model.defaultDuration && model.defaultDuration <= model.maxDuration, 'INVALID_CATALOG', 'Invalid duration range');
    ensure(!model.durations || (model.durations.includes(model.defaultDuration) && model.durations.every(d => d >= model.minDuration && d <= model.maxDuration)), 'INVALID_CATALOG', 'Invalid discrete durations');
    ensure(new Date(model.cost.expiresAt) > new Date(model.cost.verifiedAt), 'INVALID_CATALOG', 'Cost card expiry must follow verification');
    ensure(model.cost.currency === 'USD' || (model.cost.usdPerUnit && decimal(model.cost.usdPerUnit).gt(0)), 'INVALID_CATALOG', 'CNY costs require a conservative USD conversion');
    ensure(!model.enabled || provider.financialMode!=='funds_status' || model.cost.feesRefundable ||
      (decimal(model.cost.fixedFee).isZero() && decimal(model.cost.feeMultiplier).eq(1)), 'INVALID_CATALOG', 'Automatic supplier refunds require a verified refund contract for all additional fees');
    for (const [key,value] of Object.entries(model.fields)) {
      ensure(['model', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'references'].includes(key), 'INVALID_CATALOG', 'Unsupported canonical request field');
      ensure(value.split('.').every(part => !['__proto__','constructor','prototype'].includes(part)), 'INVALID_CATALOG', 'Unsafe field mapping');
    }
    ensure(new Set(Object.values(model.fields)).size === Object.values(model.fields).length, 'INVALID_CATALOG', 'Request fields cannot share the same destination');
  }
  return catalog;
}

function loadCatalog(config, env = process.env) { return parseCatalog(JSON.parse(fs.readFileSync(config.catalogPath, 'utf8')), env, config.production); }

module.exports = { loadConfig, loadCatalog, parseCatalog };
