const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { z } = require('zod');
const { loadConfig } = require('./config');
const { createDatabase, nowIso, parseJson, stringifyJson } = require('./db');
const { AppError, errorResponse } = require('./errors');
const { redact, redactText } = require('./security/redaction');
const { HttpClient } = require('./http/client');
const { createAdapter, listAdapterTypes } = require('./adapters/registry');
const { ProviderRepository } = require('./repositories/provider-repository');
const { QueryService } = require('./services/query-service');
const { JobQueue } = require('./services/job-queue');
const { NotificationService } = require('./services/notification-service');
const { AlertService } = require('./services/alert-service');
const { AutomationService } = require('./services/automation-service');
const { SyncService } = require('./services/sync-service');
const { AnalysisService } = require('./services/analysis-service');
const { KeyHealthService } = require('./services/key-health-service');
const { CatalogService } = require('./services/catalog-service');
const { CheckInService } = require('./services/checkin-service');
const { Sub2ApiAdminClient } = require('./services/sub2api-admin-client');
const { MappingService } = require('./services/mapping-service');
const { CredentialService } = require('./services/credential-service');
const { TransferService } = require('./services/transfer-service');
const { DetectionService } = require('./services/detection-service');
const { BackupService } = require('./services/backup-service');
const { RetentionService } = require('./services/retention-service');
const { Metrics } = require('./metrics');
const { AuthService } = require('./auth');

const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterType: z.string().trim().min(1),
  baseUrl: z.string().url(),
  authMode: z.string().trim().min(1).default('api_key'),
  credentials: z.record(z.string(), z.any()).optional(),
  remoteUserId: z.union([z.string(), z.number()]).optional().nullable(),
  enabled: z.boolean().optional(),
  refreshIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  warningThreshold: z.number().nonnegative().optional().nullable(),
  thresholdCurrency: z.string().trim().min(1).max(12).optional(),
  typeConfig: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  note: z.string().max(2000).optional(),
  accountDedupeKey: z.string().max(200).optional().nullable()
});

const providerUpdateSchema = providerSchema.partial();
const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  connectionId: z.string().uuid().optional().nullable(),
  ruleType: z.enum([
    'low_balance', 'runway_below', 'stale_data', 'sync_failed', 'key_expiry',
    'key_disabled', 'asset_drift', 'contract_changed', 'anomaly',
    'credential_expiry', 'automation_failed', 'rate_mismatch'
  ]),
  scope: z.string().optional(),
  currency: z.string().max(12).optional().nullable(),
  threshold: z.number().optional().nullable(),
  consecutiveMatches: z.number().int().min(1).max(20).optional(),
  cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  config: z.record(z.string(), z.any()).optional()
});
const notificationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['webhook', 'telegram', 'gotify', 'bark', 'email', 'wecom', 'dingtalk', 'feishu']),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.any()).optional(),
  credentials: z.record(z.string(), z.any()).optional()
});
const automationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  triggerType: z.enum(['low_balance', 'balance_recovered', 'key_failed', 'anomaly_detected', 'contract_changed']),
  connectionId: z.string().uuid().optional().nullable(),
  config: z.object({
    currency: z.string().max(12).optional(),
    threshold: z.number().optional(),
    channelIds: z.array(z.number().int().positive()).min(1),
    action: z.enum([
      'disable_sub2api_channel', 'enable_sub2api_channel', 'switch_to_backup',
      'trigger_recharge_webhook', 'remind_credential_rotation', 'create_route_recommendation'
    ]),
    consecutiveMatches: z.number().int().min(1).max(20).optional(),
    cooldownMinutes: z.number().int().min(1).max(10080).optional(),
    dailyMaximumActions: z.number().int().min(1).max(1000).optional(),
    contractPauseHours: z.number().min(1).max(720).optional(),
    webhookUrl: z.string().url().optional()
  }).passthrough()
});

const mappingSchema = z.object({
  connectionId: z.string().uuid(),
  keyId: z.string().uuid().nullable().optional(),
  channelId: z.number().int().positive(),
  accountId: z.number().int().positive().nullable().optional(),
  groupId: z.number().int().positive().nullable().optional(),
  role: z.enum(['primary', 'backup']).optional(),
  enabled: z.boolean().optional(),
  models: z.array(z.string().max(200)).max(500).optional(),
  config: z.record(z.string(), z.any()).optional()
});
const autoMappingSchema = z.object({
  mode: z.enum(['preview', 'apply'])
});
const sub2apiStepUpSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/)
});

const credentialRotationSchema = z.object({
  credentials: z.record(z.string(), z.any()),
  replace: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(30).optional(),
  reason: z.string().max(200).optional()
});
const backupTargetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['local', 'webdav', 's3']),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.any()).optional(),
  credentials: z.record(z.string(), z.any()).optional()
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(256)
});

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', {
      status: 400,
      details: result.error.flatten()
    });
  }
  return result.data;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function audit(db, req, action, targetType, targetId, details = {}) {
  db.prepare(`
    INSERT INTO audit_logs(
      actor_id, actor_name, action, target_type, target_id, ip_address,
      details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.auth?.actorId || null,
    req.auth?.actorName || null,
    action,
    targetType || null,
    targetId || null,
    req.ip || null,
    stringifyJson(redact(details)),
    nowIso()
  );
}

function frameAncestorSources(config) {
  const sources = new Set(["'self'"]);
  for (const value of [config.sub2apiPublicUrl, ...(config.allowedOrigins || [])]) {
    if (value === '*') {
      sources.add('*');
      continue;
    }
    try {
      sources.add(new URL(value).origin);
    } catch {}
  }
  return [...sources];
}

function bearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
}

function createApplication(options = {}) {
  const config = options.config || loadConfig();
  const db = options.db || createDatabase(config.databasePath);
  const providers = new ProviderRepository(db, config);
  const transfers = new TransferService({ db, config, providers });
  transfers.applyRuntimeSettings();
  const http = new HttpClient(config);
  const queries = new QueryService(db, config);
  const notifications = new NotificationService({ db, config });
  const alerts = new AlertService({ db, config, queries, notifications });
  const sub2api = new Sub2ApiAdminClient(config);
  const automation = new AutomationService({ db, config, sub2api });
  const analysis = new AnalysisService({ db, config });
  const keyHealth = new KeyHealthService({ db, config, providers, http });
  const catalog = new CatalogService({ db, config, providers, http, queries });
  const checkins = new CheckInService({ db, config, providers, http });
  const mappings = new MappingService({ db, config, sub2api });
  const credentials = new CredentialService({ db, config, providers, http });
  const detection = new DetectionService({ http });
  const backups = new BackupService({ db, config, transfers });
  const retention = new RetentionService({ db, config, credentials });
  const metrics = new Metrics(db, config.metricsEnabled);
  const auth = new AuthService(config, {
    db,
    onAdminToken: (token, expiresAt) => sub2api.setRuntimeToken(token, expiresAt),
    onAdminTokenCleared: (token) => sub2api.clearRuntimeToken(token)
  });
  const queue = new JobQueue({
    db,
    concurrency: config.globalConcurrency,
    perConnectionConcurrency: config.perProviderConcurrency
  });
  const sync = new SyncService({
    db,
    config,
    providers,
    http,
    metrics,
    analysis,
    onCompleted: async ({ connectionId }) => {
      if (mappings.list({ connectionId }).length > 0) {
        await mappings.refreshComparisons({ connectionId, force: true }).catch(() => null);
      }
      await alerts.evaluateConnection(connectionId);
      await automation.evaluateConnection(connectionId);
      const connection = providers.get(connectionId);
      if (connection.typeConfig?.autoKeyHealth) {
        queue.enqueue('key_health', {
          connectionId,
          payload: { level: connection.typeConfig.keyHealthLevel || 'metadata' },
          priority: -1
        });
      }
      if (connection.capabilities?.priceCatalog) {
        const latestPrice = db.prepare(`SELECT MAX(captured_at) captured_at FROM model_prices WHERE connection_id = ?`).get(connectionId)?.captured_at;
        const latestJob = db.prepare(`
          SELECT MAX(updated_at) updated_at FROM jobs
          WHERE connection_id = ? AND type = 'catalog_sync' AND status = 'succeeded'
        `).get(connectionId)?.updated_at;
        const latestCatalogAt = [latestPrice, latestJob]
          .filter(Boolean)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
        const hours = Number(transfers.settings().catalogRefreshHours || 24);
        if (!latestCatalogAt || Date.now() - Date.parse(latestCatalogAt) >= hours * 3600000) {
          queue.enqueue('catalog_sync', { connectionId, priority: -2 });
        }
      }
    }
  });
  queue.register('provider_sync', (job) => sync.run(job.connection_id, {
    jobType: job.type,
    manual: Boolean(job.payload.manual)
  }));
  queue.register('alert_evaluation', () => alerts.evaluateAll());
  queue.register('catalog_sync', (job) => catalog.sync(job.connection_id));
  queue.register('key_health', (job) => keyHealth.checkConnection(job.connection_id, job.payload.level || 'metadata'));
  queue.register('provider_checkin', (job) => checkins.run(job.connection_id, { throwOnRetryable: true }));
  queue.register('reconciliation', (job) => mappings.reconcile(job.payload.mappingId, job.payload));
  queue.register('sub2api_mapping_sync', async () => {
    const result = await mappings.refreshComparisons({ force: true });
    await alerts.evaluateAll();
    return result;
  });
  queue.register('snapshot_retention', () => retention.run());
  queue.register('remote_backup', (job) => backups.runAll(job.payload.targetIds || null, job.payload.label || 'scheduled'));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: [() => frameAncestorSources(config).join(' ')]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use((req, res, next) => {
    const supplied = String(req.get('x-request-id') || '');
    req.id = /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader('X-Request-ID', req.id);
    const started = Date.now();
    if (config.env !== 'test') {
      res.on('finish', () => {
        console.log(JSON.stringify({
          level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
          requestId: req.id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - started
        }));
      });
    }
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Request-ID');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  app.use(express.json({ limit: '1mb' }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const passwordChangeLimiter = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const sub2apiStepUpLimiter = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const enqueueSub2ApiRefresh = () => {
    if (mappings.list().some((mapping) => mapping.enabled)) {
      queue.enqueue('sub2api_mapping_sync', { priority: 5 });
    }
  };
  app.get('/api/auth/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      mode: config.authMode,
      ssoEnabled: config.authMode === 'sub2api' && Boolean(config.sub2apiBaseUrl),
      sub2apiUrl: config.sub2apiPublicUrl || null
    });
  });
  app.post('/api/auth/sso', loginLimiter, asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = await auth.sso(req, res, bearerToken(req) || req.body?.token);
    enqueueSub2ApiRefresh();
    res.json(session);
  }));
  app.use(asyncRoute(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path === '/metrics') return next();
    const token = String(req.query.token || req.query.access_token || '').trim();
    if (!token) return next();
    res.setHeader('Cache-Control', 'no-store');
    const search = new URLSearchParams();
    const theme = String(req.query.theme || '').toLowerCase();
    if (theme === 'dark' || theme === 'light') search.set('theme', theme);
    const cleanPath = req.path === '/index.html' ? '/' : req.path;
    try {
      const session = await auth.sso(req, res, token);
      enqueueSub2ApiRefresh();
      const location = `${cleanPath}${search.size ? `?${search}` : ''}#pm_session=${encodeURIComponent(session.sessionToken)}`;
      return res.redirect(303, location);
    } catch (error) {
      const exposedCode = [
        'AUTH_FAILED',
        'ADMIN_REQUIRED',
        'AUTH_UPSTREAM_TIMEOUT',
        'SUB2API_SESSION_BINDING_INCOMPATIBLE'
      ].includes(error?.code)
        ? error.code
        : 'AUTH_FAILED';
      search.set('sso_error', exposedCode);
      if (config.env !== 'test') {
        console.warn(JSON.stringify({
          level: 'warn',
          requestId: req.id,
          message: 'Sub2API SSO exchange failed',
          code: exposedCode,
          remoteStatus: error?.details?.remoteStatus || null
        }));
      }
      return res.redirect(303, `${cleanPath}?${search}`);
    }
  }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', time: nowIso() }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: nowIso() }));
  app.get('/readyz', (_req, res) => {
    try {
      db.prepare('SELECT 1 value').get();
      res.json({ status: 'ready', database: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'not_ready', database: error.message });
    }
  });
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1 value').get();
      res.json({ status: 'ready', database: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'not_ready', database: error.message });
    }
  });
  app.get('/metrics', asyncRoute(async (_req, res) => {
    if (!config.metricsEnabled) return res.status(404).end();
    res.type(metrics.contentType()).send(await metrics.render());
  }));

  app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = await auth.login(req, res, req.body || {});
    if (config.authMode === 'sub2api') enqueueSub2ApiRefresh();
    res.json(session);
  }));

  const api = express.Router();
  api.use(auth.middleware());
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return auth.mutationGuard()(req, res, next);
  });

  api.get('/auth/me', (req, res) => res.json(auth.publicSession(req.auth)));
  api.post('/auth/reauth', asyncRoute(async (req, res) => {
    const result = await auth.reauth(req, req.body || {});
    audit(db, req, 'auth.reauthenticate', 'session', req.sessionId);
    res.json(result);
  }));
  api.post('/auth/password', passwordChangeLimiter, (req, res) => {
    const input = validate(passwordChangeSchema, req.body || {});
    const result = auth.changeLocalPassword(req, input);
    audit(db, req, 'auth.password_change', 'administrator', req.auth.actorId, {
      revokedSessions: result.revokedSessions
    });
    res.json(result);
  });
  api.post('/auth/logout', (req, res) => {
    auth.logout(req, res);
    res.status(204).end();
  });
  api.get('/adapters', (_req, res) => res.json({ items: listAdapterTypes() }));
  api.get('/summary', (_req, res) => res.json(queries.summary()));

  api.get('/providers', (_req, res) => res.json({ items: providers.list() }));
  api.post('/providers/detect', asyncRoute(async (req, res) => {
    const input = validate(z.object({ baseUrl: z.string().url() }), req.body || {});
    const result = await detection.detect(input.baseUrl);
    audit(db, req, 'provider.detect', 'provider', null, {
      baseUrl: result.baseUrl,
      recommended: result.recommended,
      ambiguous: result.ambiguous
    });
    res.json(result);
  }));
  api.post('/providers', asyncRoute(async (req, res) => {
    const input = validate(providerSchema, req.body);
    if (!listAdapterTypes().includes(input.adapterType)) {
      throw new AppError('ADAPTER_NOT_FOUND', 'Unsupported provider adapter', { status: 400 });
    }
    const provider = providers.create(input);
    audit(db, req, 'provider.create', 'provider', provider.id, { input });
    const jobId = provider.enabled
      ? queue.enqueue('provider_sync', { connectionId: provider.id, priority: 10 })
      : null;
    res.status(201).json({ provider, jobId });
  }));
  api.post('/providers/validate', asyncRoute(async (req, res) => {
    const input = validate(providerSchema, req.body);
    const fakeConnection = {
      id: crypto.randomUUID(),
      name: input.name,
      adapter_type: input.adapterType,
      base_url: input.baseUrl.replace(/\/+$/, ''),
      auth_mode: input.authMode,
      remote_user_id: input.remoteUserId || null,
      account_dedupe_key: input.accountDedupeKey || null,
      type_config_json: input.typeConfig || {}
    };
    const adapter = createAdapter(input.adapterType, {
      connection: fakeConnection,
      credentials: input.credentials || {},
      http,
      config,
      onCredentialsUpdated: async () => {}
    });
    const probe = await adapter.probe();
    const account = await adapter.getAccount();
    const balances = await adapter.getAccountBalances(account);
    res.json({ valid: true, probe, account, balances });
  }));
  api.get('/providers/:id', (req, res) => res.json(providers.get(req.params.id)));
  api.post('/providers/:id/probe', asyncRoute(async (req, res) => {
    const connection = providers.get(req.params.id, { forAdapter: true });
    const adapter = createAdapter(connection.adapter_type, {
      connection,
      credentials: providers.getCredentials(connection),
      http,
      config,
      onCredentialsUpdated: async (next) => providers.updateCredentials(connection, next)
    });
    const probe = await adapter.probe();
    audit(db, req, 'provider.probe', 'provider', connection.id, { probe });
    res.json(probe);
  }));
  api.post('/providers/:id/validate', asyncRoute(async (req, res) => {
    const connection = providers.get(req.params.id, { forAdapter: true });
    const candidate = { ...providers.getCredentials(connection), ...(req.body?.credentials || {}) };
    const adapter = createAdapter(connection.adapter_type, {
      connection,
      credentials: candidate,
      http,
      config,
      onCredentialsUpdated: async () => {}
    });
    const probe = await adapter.probe();
    const account = await adapter.getAccount();
    const balances = await adapter.getAccountBalances(account);
    audit(db, req, 'provider.validate', 'provider', connection.id, { balanceCount: balances.length });
    res.json({ valid: true, probe, account, balances });
  }));
  api.post('/providers/:id/clone', (req, res) => {
    const source = providers.get(req.params.id);
    const clone = providers.create({
      name: req.body?.name || `${source.name} Copy`,
      adapterType: source.adapter_type,
      baseUrl: source.base_url,
      authMode: source.auth_mode,
      credentials: {},
      remoteUserId: null,
      enabled: false,
      refreshIntervalMinutes: source.refresh_interval_minutes,
      warningThreshold: source.warning_threshold,
      thresholdCurrency: source.threshold_currency,
      typeConfig: source.typeConfig,
      tags: source.tags,
      note: source.note,
      accountDedupeKey: null
    });
    audit(db, req, 'provider.clone_without_credentials', 'provider', clone.id, { sourceId: source.id });
    res.status(201).json(clone);
  });
  api.get('/providers/:id/assets', (req, res) => {
    providers.get(req.params.id);
    res.json(queries.providerAssets(req.params.id));
  });
  api.get('/providers/:id/accounts', (req, res) => {
    providers.get(req.params.id);
    res.json({ items: db.prepare(`SELECT * FROM remote_accounts WHERE connection_id = ? ORDER BY display_name`).all(req.params.id).map((row) => ({
      ...row, metadata: parseJson(row.metadata_json, {}), metadata_json: undefined
    })) });
  });
  api.get('/providers/:id/groups', (req, res) => {
    providers.get(req.params.id);
    res.json({ items: queries.groups(req.params.id) });
  });
  api.get('/providers/:id/keys', (req, res) => {
    providers.get(req.params.id);
    res.json({ items: queries.keys({ connectionId: req.params.id, status: req.query.status, search: req.query.search }) });
  });
  api.put('/providers/:id', (req, res) => {
    const input = validate(providerUpdateSchema, req.body);
    if (input.adapterType && !listAdapterTypes().includes(input.adapterType)) {
      throw new AppError('ADAPTER_NOT_FOUND', 'Unsupported provider adapter', { status: 400 });
    }
    const provider = providers.update(req.params.id, input);
    audit(db, req, 'provider.update', 'provider', provider.id, { input });
    res.json(provider);
  });
  api.delete('/providers/:id', (req, res) => {
    providers.delete(req.params.id);
    audit(db, req, 'provider.delete', 'provider', req.params.id);
    res.status(204).end();
  });
  api.post('/providers/:id/sync', asyncRoute(async (req, res) => {
    providers.get(req.params.id);
    if (req.query.wait === 'true') {
      const result = await sync.run(req.params.id, { jobType: 'manual_sync', manual: true });
      audit(db, req, 'provider.sync', 'provider', req.params.id, { status: result.status });
      return res.json(result);
    }
    const jobId = queue.enqueue('provider_sync', {
      connectionId: req.params.id,
      priority: 20,
      payload: { manual: true }
    });
    audit(db, req, 'provider.sync.enqueue', 'provider', req.params.id, { jobId });
    return res.status(202).json({ jobId });
  }));
  api.post('/providers/:id/refresh', asyncRoute(async (req, res) => {
    providers.get(req.params.id);
    if (req.query.wait === 'true') {
      const result = await sync.run(req.params.id, { jobType: 'manual_refresh', manual: true });
      audit(db, req, 'provider.refresh', 'provider', req.params.id, { status: result.status });
      return res.json(result);
    }
    const jobId = queue.enqueue('provider_sync', {
      connectionId: req.params.id,
      priority: 20,
      payload: { manual: true }
    });
    audit(db, req, 'provider.refresh.enqueue', 'provider', req.params.id, { jobId });
    return res.status(202).json({ jobId });
  }));
  api.post(['/providers/sync-all', '/providers/check-all'], (req, res) => {
    const jobIds = providers.list().filter((provider) => provider.enabled).map((provider) =>
      queue.enqueue('provider_sync', {
        connectionId: provider.id,
        priority: 10,
        payload: { manual: true }
      })
    );
    audit(db, req, 'provider.sync_all', 'provider', null, { jobIds });
    res.status(202).json({ jobIds });
  });
  api.post('/providers/:id/keys/:keyId/check', asyncRoute(async (req, res) => {
    providers.get(req.params.id);
    const key = db.prepare('SELECT id FROM remote_keys WHERE id = ? AND connection_id = ?').get(req.params.keyId, req.params.id);
    if (!key) throw new AppError('KEY_NOT_FOUND', 'Remote key was not found', { status: 404 });
    const level = validate(z.enum(['metadata', 'models', 'paid', 'capabilities']), req.body?.level || 'metadata');
    const result = await keyHealth.check(key.id, level);
    audit(db, req, 'key.health_check', 'key', key.id, { level, status: result.status });
    res.json(result);
  }));
  api.post('/providers/:id/accounts/:accountId/refresh', (req, res) => {
    const account = db.prepare('SELECT id FROM remote_accounts WHERE id = ? AND connection_id = ?').get(req.params.accountId, req.params.id);
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Remote account was not found', { status: 404 });
    const jobId = queue.enqueue('provider_sync', {
      connectionId: req.params.id,
      priority: 20,
      payload: { manual: true }
    });
    audit(db, req, 'account.refresh.enqueue', 'account', account.id, { jobId });
    res.status(202).json({ jobId, scope: 'provider_full_sync' });
  });
  api.post('/providers/:id/keys/:keyId/refresh', (req, res) => {
    const key = db.prepare('SELECT id FROM remote_keys WHERE id = ? AND connection_id = ?').get(req.params.keyId, req.params.id);
    if (!key) throw new AppError('KEY_NOT_FOUND', 'Remote key was not found', { status: 404 });
    const jobId = queue.enqueue('provider_sync', {
      connectionId: req.params.id,
      priority: 20,
      payload: { manual: true }
    });
    audit(db, req, 'key.refresh.enqueue', 'key', key.id, { jobId });
    res.status(202).json({ jobId, scope: 'provider_full_sync' });
  });
  api.post('/providers/:id/keys/:keyId/reveal', auth.requireRecentReauth(), (req, res) => {
    providers.get(req.params.id);
    const key = db.prepare('SELECT id FROM remote_keys WHERE id = ? AND connection_id = ?').get(req.params.keyId, req.params.id);
    if (!key) throw new AppError('KEY_NOT_FOUND', 'Remote key was not found', { status: 404 });
    audit(db, req, 'key.reveal.denied', 'key', key.id, { reason: 'adapter_capability_unsupported' });
    throw new AppError('CAPABILITY_UNSUPPORTED', 'This adapter does not provide a secure full-key reveal API', { status: 409 });
  });

  api.get('/keys', (req, res) => res.json({ items: queries.keys({
    connectionId: req.query.connectionId,
    status: req.query.status,
    group: req.query.group,
    search: req.query.search
  }) }));
  api.get('/keys/export.csv', (req, res) => {
    const rows = queries.keys({ connectionId: req.query.connectionId, status: req.query.status });
    const headers = ['provider', 'name', 'masked_key', 'status', 'primary_group', 'backup_group', 'quota_limit', 'quota_used', 'quota_remaining', 'currency', 'expires_at'];
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push([
        row.provider_name, row.name, row.masked_key, row.status, row.primary_group_ref,
        row.backup_group_ref, row.quota_limit, row.quota_used, row.quota_remaining,
        row.currency, row.expires_at
      ].map(csvEscape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="provider-keys.csv"');
    res.send(`\uFEFF${lines.join('\r\n')}`);
  });
  api.get('/groups', (req, res) => res.json({ items: queries.groups(req.query.connectionId || null) }));
  api.get('/balances', (req, res) => {
    const clauses = ['r.row_number = 1'];
    const params = [];
    if (req.query.connectionId) { clauses.push('r.connection_id = ?'); params.push(req.query.connectionId); }
    if (req.query.currency) { clauses.push('r.currency = ?'); params.push(req.query.currency); }
    if (req.query.subjectType) { clauses.push('r.subject_type = ?'); params.push(req.query.subjectType); }
    res.json({ items: db.prepare(`
      WITH ranked AS (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.connection_id, s.subject_type, s.subject_id, s.currency
          ORDER BY s.captured_at DESC, s.id DESC
        ) row_number FROM balance_snapshots s
      ) SELECT r.*, p.name provider_name FROM ranked r
      JOIN provider_connections p ON p.id = r.connection_id
      WHERE ${clauses.join(' AND ')} ORDER BY p.name, r.subject_type, r.currency
    `).all(...params).map((row) => ({ ...row, unlimited: Boolean(row.unlimited), raw: parseJson(row.raw_json, {}), raw_json: undefined, row_number: undefined })) });
  });
  api.get('/balances/history', (req, res) => res.json({ items: queries.history({
    connectionId: req.query.connectionId,
    currency: req.query.currency,
    days: Number(req.query.days || 30),
    subjectType: req.query.subjectType || 'account'
  }) }));
  api.get('/history', (req, res) => res.json({ items: queries.history({
    connectionId: req.query.connectionId,
    currency: req.query.currency,
    days: Number(req.query.days || 30),
    subjectType: req.query.subjectType || 'account'
  }) }));
  api.get('/forecast/:connectionId', (req, res) => res.json(
    queries.forecast(req.params.connectionId, req.query.currency || 'USD', Number(req.query.days || 14))
  ));
  api.get('/forecasts', (req, res) => {
    const ids = req.query.connectionId ? [req.query.connectionId] : providers.list().map((provider) => provider.id);
    res.json({ items: ids.map((id) => ({ connectionId: id, ...queries.forecast(id, req.query.currency || 'USD', Number(req.query.days || 14)) })) });
  });
  api.get('/burn-rates', (req, res) => {
    if (!req.query.connectionId) throw new AppError('VALIDATION_ERROR', 'connectionId is required', { status: 400 });
    res.json(queries.burnRates(req.query.connectionId, req.query.currency || 'USD', Number(req.query.days || 30)));
  });
  api.get('/usage', (req, res) => {
    const connectionClause = req.query.connectionId ? 'AND u.connection_id = ?' : '';
    const params = req.query.connectionId ? [req.query.connectionId] : [];
    res.json({ items: db.prepare(`
      WITH ranked AS (
        SELECT u.*, ROW_NUMBER() OVER (
          PARTITION BY u.connection_id, u.subject_type, u.subject_id, u.currency, COALESCE(u.model, ''), u.period
          ORDER BY u.captured_at DESC, u.id DESC
        ) row_number FROM usage_snapshots u WHERE 1 = 1 ${connectionClause}
      ) SELECT r.*, p.name provider_name FROM ranked r
      JOIN provider_connections p ON p.id = r.connection_id
      WHERE r.row_number = 1 ORDER BY p.name, r.subject_type, r.model
    `).all(...params).map((row) => ({ ...row, raw: parseJson(row.raw_json, {}), raw_json: undefined, row_number: undefined })) });
  });
  api.get('/usage/history', (req, res) => res.json({ items: queries.usageHistory({
    connectionId: req.query.connectionId,
    days: Number(req.query.days || 30)
  }) }));
  api.get('/asset-changes', (req, res) => res.json({ items: analysis.listChanges({
    connectionId: req.query.connectionId,
    limit: Number(req.query.limit || 200)
  }) }));
  api.get('/anomalies', (req, res) => res.json({ items: analysis.listAnomalies({
    connectionId: req.query.connectionId,
    activeOnly: req.query.activeOnly === 'true',
    limit: Number(req.query.limit || 200)
  }) }));
  api.get('/key-health', (req, res) => res.json({ items: keyHealth.list({
    connectionId: req.query.connectionId,
    keyId: req.query.keyId,
    limit: Number(req.query.limit || 200)
  }) }));
  api.post('/providers/:id/key-health', asyncRoute(async (req, res) => {
    const level = validate(z.enum(['metadata', 'models', 'paid', 'capabilities']), req.body?.level || 'metadata');
    const result = await keyHealth.checkConnection(req.params.id, level);
    audit(db, req, 'provider.key_health', 'provider', req.params.id, { level, checked: result.checked });
    res.json(result);
  }));
  api.get('/models', (req, res) => res.json({ items: catalog.models(req.query.connectionId || null) }));
  api.get('/prices', (req, res) => res.json({ items: catalog.prices({
    connectionId: req.query.connectionId,
    model: req.query.model,
    limit: Number(req.query.limit || 5000)
  }) }));
  api.get('/comparisons', (req, res) => {
    if (!req.query.model) throw new AppError('VALIDATION_ERROR', 'model is required', { status: 400 });
    res.json({ items: catalog.comparisons(req.query.model) });
  });
  api.post('/providers/:id/catalog/sync', asyncRoute(async (req, res) => {
    const result = await catalog.sync(req.params.id);
    audit(db, req, 'provider.catalog_sync', 'provider', req.params.id, result);
    res.json(result);
  }));
  api.get('/checkins', (req, res) => res.json({ items: checkins.list(req.query.connectionId || null, Number(req.query.limit || 200)) }));
  api.post('/providers/:id/checkin', asyncRoute(async (req, res) => {
    const result = await checkins.run(req.params.id);
    audit(db, req, 'provider.checkin', 'provider', req.params.id, { status: result.status, rewardAmount: result.rewardAmount });
    res.json(result);
  }));
  api.get('/checks', (req, res) => res.json({ items: queries.checkRuns({
    connectionId: req.query.connectionId,
    limit: req.query.limit
  }) }));
  api.get('/jobs', (req, res) => res.json({ items: queue.list(req.query.limit) }));
  api.get('/jobs/:id', (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Job was not found', { status: 404 });
    res.json(job);
  });

  api.get('/alert-rules', (_req, res) => res.json({ items: alerts.listRules() }));
  api.post('/alert-rules', (req, res) => {
    const rule = alerts.saveRule(validate(alertRuleSchema, req.body));
    audit(db, req, 'alert_rule.create', 'alert_rule', rule.id, { rule });
    res.status(201).json(rule);
  });
  api.put('/alert-rules/:id', (req, res) => {
    const rule = alerts.saveRule(validate(alertRuleSchema.partial(), req.body), req.params.id);
    audit(db, req, 'alert_rule.update', 'alert_rule', rule.id, { rule });
    res.json(rule);
  });
  api.delete('/alert-rules/:id', (req, res) => {
    alerts.deleteRule(req.params.id);
    audit(db, req, 'alert_rule.delete', 'alert_rule', req.params.id);
    res.status(204).end();
  });
  api.post('/alerts/evaluate', asyncRoute(async (req, res) => {
    await alerts.evaluateAll();
    audit(db, req, 'alerts.evaluate', 'alert', null);
    res.json({ status: 'completed' });
  }));
  api.get('/alerts', (req, res) => res.json({ items: alerts.listEvents(req.query.status || null) }));
  api.post('/alerts/:id/acknowledge', (req, res) => {
    const event = alerts.acknowledge(req.params.id);
    audit(db, req, 'alert.acknowledge', 'alert', req.params.id);
    res.json(event);
  });
  api.post('/alerts/:id/ack', (req, res) => {
    const event = alerts.acknowledge(req.params.id);
    audit(db, req, 'alert.acknowledge', 'alert', req.params.id);
    res.json(event);
  });

  api.get('/notification-channels', (_req, res) => res.json({ items: notifications.listChannels() }));
  api.post('/notification-channels', (req, res) => {
    const channel = notifications.save(validate(notificationSchema, req.body));
    audit(db, req, 'notification_channel.create', 'notification_channel', channel.id, { channel });
    res.status(201).json(channel);
  });
  api.put('/notification-channels/:id', (req, res) => {
    const channel = notifications.save(validate(notificationSchema.partial(), req.body), req.params.id);
    audit(db, req, 'notification_channel.update', 'notification_channel', channel.id, { channel });
    res.json(channel);
  });
  api.delete('/notification-channels/:id', (req, res) => {
    notifications.delete(req.params.id);
    audit(db, req, 'notification_channel.delete', 'notification_channel', req.params.id);
    res.status(204).end();
  });
  api.post('/notification-channels/:id/test', asyncRoute(async (req, res) => {
    const result = await notifications.test(req.params.id);
    audit(db, req, 'notification_channel.test', 'notification_channel', req.params.id);
    res.json(result);
  }));
  api.post('/notifications/test', asyncRoute(async (req, res) => {
    if (!req.body?.channelId) throw new AppError('VALIDATION_ERROR', 'channelId is required', { status: 400 });
    const result = await notifications.test(req.body.channelId);
    audit(db, req, 'notification_channel.test', 'notification_channel', req.body.channelId);
    res.json(result);
  }));

  api.get('/automation-rules', (_req, res) => res.json({ items: automation.listRules() }));
  api.post('/automation-rules', (req, res) => {
    const rule = automation.saveRule(validate(automationSchema, req.body));
    audit(db, req, 'automation_rule.create', 'automation_rule', rule.id, { rule });
    res.status(201).json(rule);
  });
  api.put('/automation-rules/:id', (req, res) => {
    const rule = automation.saveRule(validate(automationSchema.partial(), req.body), req.params.id);
    audit(db, req, 'automation_rule.update', 'automation_rule', rule.id, { rule });
    res.json(rule);
  });
  api.delete('/automation-rules/:id', (req, res) => {
    automation.deleteRule(req.params.id);
    audit(db, req, 'automation_rule.delete', 'automation_rule', req.params.id);
    res.status(204).end();
  });
  api.get('/automation-actions', (req, res) => res.json({ items: automation.listActions(req.query.limit) }));
  api.post('/automation-actions/:id/rollback', asyncRoute(async (req, res) => {
    const result = await automation.rollback(req.params.id);
    audit(db, req, 'automation_action.rollback', 'automation_action', req.params.id);
    res.json(result);
  }));

  api.get('/automation/rules', (_req, res) => res.json({ items: automation.listRules() }));
  api.post('/automation/rules', (req, res) => {
    const rule = automation.saveRule(validate(automationSchema, req.body));
    audit(db, req, 'automation_rule.create', 'automation_rule', rule.id, { rule });
    res.status(201).json(rule);
  });
  api.put('/automation/rules/:id', (req, res) => {
    const rule = automation.saveRule(validate(automationSchema.partial(), req.body), req.params.id);
    audit(db, req, 'automation_rule.update', 'automation_rule', rule.id, { rule });
    res.json(rule);
  });
  api.delete('/automation/rules/:id', (req, res) => {
    automation.deleteRule(req.params.id);
    audit(db, req, 'automation_rule.delete', 'automation_rule', req.params.id);
    res.status(204).end();
  });
  api.post('/automation/rules/:id/dry-run', (req, res) => {
    const result = automation.previewRule(req.params.id, req.body?.connectionId || null);
    audit(db, req, 'automation_rule.dry_run', 'automation_rule', req.params.id, { result });
    res.json({ items: result });
  });
  api.get('/automation/actions', (req, res) => res.json({ items: automation.listActions(req.query.limit) }));
  api.post('/automation/actions/:id/rollback', asyncRoute(async (req, res) => {
    const result = await automation.rollback(req.params.id);
    audit(db, req, 'automation_action.rollback', 'automation_action', req.params.id);
    res.json(result);
  }));

  api.get('/mappings', (req, res) => res.json({ items: mappings.list({
    connectionId: req.query.connectionId,
    channelId: req.query.channelId
  }) }));
  api.post('/mappings', (req, res) => {
    const mapping = mappings.save(validate(mappingSchema, req.body));
    queue.enqueue('sub2api_mapping_sync', { priority: 5 });
    audit(db, req, 'mapping.create', 'mapping', mapping.id, { mapping });
    res.status(201).json(mapping);
  });
  api.put('/mappings/:id', (req, res) => {
    const mapping = mappings.save(validate(mappingSchema.partial(), req.body), req.params.id);
    queue.enqueue('sub2api_mapping_sync', { priority: 5 });
    audit(db, req, 'mapping.update', 'mapping', mapping.id, { mapping });
    res.json(mapping);
  });
  api.delete('/mappings/:id', (req, res) => {
    mappings.delete(req.params.id);
    audit(db, req, 'mapping.delete', 'mapping', req.params.id);
    res.status(204).end();
  });
  api.post('/mappings/:id/activate-backup', (req, res) => {
    const mapping = mappings.activateBackup(req.params.id);
    queue.enqueue('sub2api_mapping_sync', { priority: 5 });
    audit(db, req, 'mapping.activate_backup', 'mapping', mapping.id, { channelId: mapping.channel_id });
    res.json(mapping);
  });
  api.get('/sub2api/channels', asyncRoute(async (_req, res) => res.json(await mappings.channels())));
  api.get('/sub2api/groups', asyncRoute(async (_req, res) => res.json(await mappings.groups())));
  api.get('/sub2api/status', (_req, res) => res.json(mappings.status()));
  api.get('/sub2api/comparisons', asyncRoute(async (req, res) => res.json(await mappings.comparisons({
    connectionId: req.query.connectionId || null
  }))));
  api.post('/sub2api/step-up', sub2apiStepUpLimiter, asyncRoute(async (req, res) => {
    const input = validate(sub2apiStepUpSchema, req.body || {});
    const result = await sub2api.verifyStepUp(req.auth?.upstreamTokens?.accessToken, input.code);
    audit(db, req, 'sub2api.step_up.verify', 'sub2api', null, { expiresIn: result.expiresIn });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  }));
  api.post('/sub2api/auto-mappings', asyncRoute(async (req, res) => {
    const input = validate(autoMappingSchema, req.body || {});
    const result = await mappings.autoMappings(input, {
      accessToken: req.auth?.upstreamTokens?.accessToken || null
    });
    if (input.mode === 'apply') {
      await alerts.evaluateAll();
      audit(db, req, 'sub2api.auto_mappings.apply', 'sub2api', null, { summary: result.summary });
    }
    res.json(result);
  }));
  api.post('/sub2api/comparisons/refresh', asyncRoute(async (req, res) => {
    const result = await mappings.refreshComparisons({
      connectionId: req.body?.connectionId || null,
      force: true
    });
    await alerts.evaluateAll();
    audit(db, req, 'sub2api.comparisons.refresh', 'sub2api', null, { summary: result.summary });
    res.json(result);
  }));
  api.get('/sub2api/channel-monitors', asyncRoute(async (_req, res) => res.json(await mappings.channelMonitors())));
  api.get('/reconciliations', (req, res) => res.json({ items: mappings.listReconciliations({
    mappingId: req.query.mappingId,
    limit: Number(req.query.limit || 200)
  }) }));
  api.post('/mappings/:id/reconcile', asyncRoute(async (req, res) => {
    if (req.query.wait === 'false') {
      mappings.get(req.params.id);
      const jobId = queue.enqueue('reconciliation', {
        connectionId: mappings.get(req.params.id).connection_id,
        payload: { ...(req.body || {}), mappingId: req.params.id },
        dedupe: false
      });
      audit(db, req, 'reconciliation.enqueue', 'mapping', req.params.id, { jobId });
      return res.status(202).json({ jobId });
    }
    const result = await mappings.reconcile(req.params.id, req.body || {});
    audit(db, req, 'reconciliation.run', 'mapping', req.params.id, { status: result.status, differenceRatio: result.difference_ratio });
    return res.json(result);
  }));

  api.get('/credentials/lifecycle', (_req, res) => res.json({ items: credentials.listLifecycle() }));
  api.get('/providers/:id/credential-backups', (req, res) => res.json({ items: credentials.listBackups(req.params.id) }));
  api.post('/providers/:id/credentials/rotate', auth.requireRecentReauth(), asyncRoute(async (req, res) => {
    const input = validate(credentialRotationSchema, req.body);
    const result = await credentials.rotate(req.params.id, input.credentials, input);
    audit(db, req, 'credential.rotate', 'provider', req.params.id, { backupId: result.backupId, fields: result.fields.map((field) => field.name) });
    queue.enqueue('provider_sync', { connectionId: req.params.id, priority: 30 });
    res.json(result);
  }));
  api.post('/providers/:id/credentials/rollback/:backupId', auth.requireRecentReauth(), (req, res) => {
    const result = credentials.rollback(req.params.id, req.params.backupId);
    audit(db, req, 'credential.rollback', 'provider', req.params.id, { backupId: req.params.backupId });
    res.json(result);
  });
  api.post('/credentials/master-secret/rotate', auth.requireRecentReauth(), (req, res) => {
    const result = credentials.reencryptMasterSecret(req.body?.newSecret);
    audit(db, req, 'credential.master_secret_rotate', 'credential', null, { reencrypted: result.reencrypted });
    res.json(result);
  });

  api.get('/settings', (_req, res) => res.json(transfers.settings()));
  api.put('/settings', (req, res) => {
    const settings = transfers.saveSettings(req.body || {});
    audit(db, req, 'settings.update', 'settings', null, { keys: Object.keys(req.body || {}) });
    res.json(settings);
  });
  api.post('/imports/preview', (req, res) => res.json(transfers.previewImport(req.body || {})));
  api.post('/imports/apply', auth.requireRecentReauth(), (req, res) => {
    const result = transfers.applyImport(req.body || {});
    for (const item of result.results || []) {
      if (item.providerId && providers.get(item.providerId).enabled) queue.enqueue('provider_sync', { connectionId: item.providerId, priority: 5 });
    }
    audit(db, req, 'import.apply', 'import', result.id, { format: result.format, created: result.created, updated: result.updated });
    res.json(result);
  });
  api.get('/exports/config', (req, res) => {
    const payload = transfers.exportConfiguration();
    audit(db, req, 'export.configuration', 'export', null, { providerCount: payload.providers.length });
    res.setHeader('Content-Disposition', 'attachment; filename="provider-monitor-config.json"');
    res.json(payload);
  });
  api.get('/exports/env', (req, res) => {
    audit(db, req, 'export.environment_template', 'export', null);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="provider-monitor-import.env"');
    res.send(transfers.exportEnvironmentTemplate());
  });
  api.get('/exports/:kind.csv', (req, res) => {
    const content = transfers.exportCsv(req.params.kind);
    audit(db, req, 'export.csv', 'export', req.params.kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="provider-monitor-${req.params.kind}.csv"`);
    res.send(content);
  });
  api.get('/exports/credential-profiles', (req, res) => {
    const includeSecrets = req.query.includeSecrets === 'true';
    if (includeSecrets) return auth.requireRecentReauth()(req, res, () => {
      const items = transfers.credentialProfiles({ includeSecrets: true });
      audit(db, req, 'export.credential_profiles_sensitive', 'export', null, { count: items.length });
      res.json({ items });
    });
    return res.json({ items: transfers.credentialProfiles() });
  });
  api.post('/exports/disaster-bundle', auth.requireRecentReauth(), (req, res) => {
    const bundle = transfers.exportDisasterBundle(req.body?.password);
    audit(db, req, 'export.disaster_bundle', 'export', null, { schema: bundle.schema });
    res.json(bundle);
  });
  api.post('/imports/disaster-bundle', auth.requireRecentReauth(), (req, res) => {
    const decoded = transfers.decodeDisasterBundle(req.body?.bundle, req.body?.password);
    const result = transfers.applyImport({ format: 'provider-monitor', content: decoded });
    if (decoded.settings) transfers.saveSettings(decoded.settings);
    for (const item of result.results || []) {
      if (item.providerId && providers.get(item.providerId).enabled) queue.enqueue('provider_sync', { connectionId: item.providerId, priority: 5 });
    }
    audit(db, req, 'import.disaster_bundle', 'import', result.id, { created: result.created, updated: result.updated });
    res.json(result);
  });
  api.get('/backups', (_req, res) => res.json({ items: transfers.listBackups() }));
  api.post('/backups', auth.requireRecentReauth(), asyncRoute(async (req, res) => {
    const backup = await transfers.backupDatabase(req.body?.label);
    audit(db, req, 'backup.create', 'backup', backup.filename, { size: backup.size });
    res.status(201).json(backup);
  }));
  api.get('/backup-targets', (_req, res) => res.json({ items: backups.listTargets() }));
  api.post('/backup-targets', auth.requireRecentReauth(), (req, res) => {
    const target = backups.saveTarget(validate(backupTargetSchema, req.body || {}));
    audit(db, req, 'backup_target.create', 'backup_target', target.id, { name: target.name, type: target.type });
    res.status(201).json(target);
  });
  api.put('/backup-targets/:id', auth.requireRecentReauth(), (req, res) => {
    const input = validate(backupTargetSchema.partial(), req.body || {});
    const target = backups.saveTarget(input, req.params.id);
    audit(db, req, 'backup_target.update', 'backup_target', target.id, { name: target.name, type: target.type });
    res.json(target);
  });
  api.delete('/backup-targets/:id', auth.requireRecentReauth(), (req, res) => {
    backups.deleteTarget(req.params.id);
    audit(db, req, 'backup_target.delete', 'backup_target', req.params.id);
    res.status(204).end();
  });
  api.post('/backup-targets/:id/test', auth.requireRecentReauth(), asyncRoute(async (req, res) => {
    const result = await backups.runTarget(req.params.id, 'target-test');
    audit(db, req, 'backup_target.test', 'backup_target', req.params.id, { status: result.status, location: result.location });
    res.json(result);
  }));
  api.get('/backup-runs', (req, res) => res.json({ items: backups.listRuns(req.query.limit) }));
  api.post('/backups/remote', auth.requireRecentReauth(), asyncRoute(async (req, res) => {
    const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : null;
    const results = await backups.runAll(targetIds, req.body?.label || 'manual');
    const items = results.map((result) => result.status === 'fulfilled'
      ? { status: 'succeeded', value: result.value }
      : { status: 'failed', error: { code: result.reason?.code || 'BACKUP_UPLOAD_FAILED', message: redactText(result.reason?.message) } });
    audit(db, req, 'backup.remote', 'backup', null, { targetIds, results: items.map((item) => item.status) });
    res.json({ items });
  }));

  api.get('/audit-logs', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json({ items: db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit) });
  });
  api.get('/audit', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json({ items: db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit) });
  });
  app.use('/api', api);

  const nodeModules = path.join(config.projectRoot, 'node_modules');
  app.use('/vendor/echarts', express.static(path.join(nodeModules, 'echarts', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/lucide', express.static(path.join(nodeModules, 'lucide', 'dist', 'umd'), { maxAge: '7d' }));
  app.use(express.static(path.join(config.projectRoot, 'public'), { maxAge: config.env === 'production' ? '1h' : 0 }));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/metrics') return next();
    return res.sendFile(path.join(config.projectRoot, 'public', 'index.html'));
  });

  app.use((req, _res, next) => next(new AppError('NOT_FOUND', 'Route was not found', { status: 404 })));
  app.use((error, req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500 && config.env !== 'test') {
      console.error(JSON.stringify({ level: 'error', requestId: req.id, message: redactText(error.message), code: error.code, path: req.path }));
    }
    res.status(status).json(errorResponse(error));
  });

  const cronTasks = [];
  let backgroundStarted = false;
  const startBackground = () => {
    if (backgroundStarted) return;
    backgroundStarted = true;
    queue.start();
    cronTasks.push(cron.schedule('* * * * *', () => {
      const due = db.prepare(`
        SELECT id FROM provider_connections
        WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
      `).all(nowIso());
      for (const provider of due) queue.enqueue('provider_sync', { connectionId: provider.id });
      queue.enqueue('alert_evaluation', { priority: -1 });
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('17 3 * * *', () => {
      queue.enqueue('snapshot_retention', { priority: -5 });
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('15 9 * * *', () => {
      for (const connectionId of checkins.dueConnections()) {
        queue.enqueue('provider_checkin', { connectionId, priority: 5 });
      }
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('25 2 * * *', () => {
      for (const provider of providers.list().filter((item) => item.enabled && item.capabilities?.priceCatalog)) {
        queue.enqueue('catalog_sync', { connectionId: provider.id, priority: -3 });
      }
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('45 3 * * *', () => {
      for (const mapping of mappings.list().filter((item) => item.enabled && item.config?.autoReconcile)) {
        queue.enqueue('reconciliation', {
          connectionId: mapping.connection_id,
          payload: { mappingId: mapping.id },
          priority: -3,
          dedupe: false
        });
      }
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('*/5 * * * *', () => {
      if (mappings.list().some((item) => item.enabled)) {
        queue.enqueue('sub2api_mapping_sync', { priority: -2 });
      }
    }, { timezone: config.timezone }));
    cronTasks.push(cron.schedule('35 3 * * *', () => {
      const targetIds = backups.listTargets().filter((target) => target.enabled).map((target) => target.id);
      if (targetIds.length > 0) {
        queue.enqueue('remote_backup', { payload: { targetIds, label: 'scheduled' }, priority: -5 });
      }
    }, { timezone: config.timezone }));
  };
  const close = async () => {
    for (const task of cronTasks) task.stop();
    await queue.stop();
    auth.close();
    db.close();
  };

  app.locals.services = {
    config, db, providers, queries, notifications, alerts, automation, analysis,
    keyHealth, catalog, checkins, mappings, credentials, transfers, sub2api,
    metrics, auth, queue, sync, detection, backups, retention
  };
  app.locals.startBackground = startBackground;
  app.locals.close = close;
  if (options.startBackground) startBackground();
  return app;
}

function startServer() {
  const app = createApplication({ startBackground: true });
  const config = app.locals.services.config;
  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Provider Monitor listening on http://${config.bindHost}:${config.port}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await app.locals.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { app, server };
}

if (require.main === module) startServer();

module.exports = {
  createApplication,
  startServer,
  validate,
  providerSchema
};
