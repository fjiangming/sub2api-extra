'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { asyncRoute, errorMiddleware, AppError } = require('./errors');
const { cleanupTargetIds } = require('./config');
const { ROLE_PATTERN } = require('./services/system-settings-service');

const loginSchema = z.object({
  username: z.string().min(1).max(320).optional(),
  email: z.string().min(1).max(320).optional(),
  password: z.string().min(1).max(1024)
}).refine((value) => value.username || value.email, {
  message: '请输入管理员账号或邮箱',
  path: ['username']
});

const previewSchema = z.object({
  targets: z.array(z.string()).max(20).optional()
});

const executeSchema = z.object({
  previewId: z.string().uuid(),
  confirmationPhrase: z.string().min(1).max(100),
  acknowledgeImpact: z.literal(true),
  acknowledgeDownstream: z.literal(true)
});

const databaseSetupSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9_.-]+$/),
  username: z.string().trim().min(1).max(63),
  password: z.string().min(1).max(1024),
  sslMode: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  readRole: z.string().regex(ROLE_PATTERN).default('sub2api_ops_read'),
  createMaintenance: z.boolean().default(true),
  maintenanceRole: z.string().regex(ROLE_PATTERN).default('sub2api_ops_maintenance'),
  grantMonitoring: z.boolean().default(false),
  hardenPublicSchema: z.boolean().default(false)
});

const cleanupSettingsSchema = z.object({
  enabled: z.boolean(),
  automaticEnabled: z.boolean(),
  automaticTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  automaticTargets: z.array(z.enum(cleanupTargetIds)).min(1),
  backupWaitMinutes: z.number().int().min(1).max(55),
  retention: z.object({
    usageLogsDays: z.number().int().min(30).max(3650),
    usageHourlyDays: z.number().int().min(30).max(3650),
    usageDailyDays: z.number().int().min(365).max(3650),
    systemLogDays: z.number().int().min(7).max(3650),
    errorLogDays: z.number().int().min(30).max(3650),
    opsMetricDays: z.number().int().min(7).max(3650)
  })
}).superRefine((value, context) => {
  if (value.automaticEnabled && !value.enabled) {
    context.addIssue({ code: 'custom', path: ['automaticEnabled'], message: '自动清理要求先启用清理执行' });
  }
});

const sub2ApiCredentialsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('session') }),
  z.object({ mode: z.literal('token'), token: z.string().trim().min(16).max(16384) }),
  z.object({
    mode: z.literal('account'),
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(1024)
  })
]);

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_REQUEST', '请求参数无效', {
      status: 400,
      details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    });
  }
  return result.data;
}

function bearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function frameAncestorSources(config) {
  const sources = new Set(["'self'"]);
  if (config.sub2apiPublicUrl) {
    try { sources.add(new URL(config.sub2apiPublicUrl).origin); } catch {}
  }
  return [...sources];
}

function createApp({ config, database, auth, inspector, metrics, storage, retention, scheduler, sub2api, settings }) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });
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
        baseUri: ["'none'"],
        frameAncestors: frameAncestorSources(config)
      }
    }
  }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', asyncRoute(async (_req, res) => {
    if (database.configured?.() === false) {
      return res.status(503).json({ status: 'setup_required', database: null });
    }
    const db = await database.ping();
    res.json({ status: 'ready', database: db.database, latencyMs: db.latencyMs });
  }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'LOGIN_RATE_LIMITED', message: '登录尝试过多，请稍后再试' } }
  });
  const setupLimiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'SETUP_RATE_LIMITED', message: '数据库初始化尝试过多，请稍后再试' } }
  });

  app.get('/api/auth/config', (_req, res) => {
    res.set('cache-control', 'no-store').json({
      mode: config.authMode,
      ssoEnabled: config.authMode === 'sub2api' && Boolean(config.sub2apiBaseUrl),
      sub2apiUrl: config.sub2apiPublicUrl || null
    });
  });

  app.post('/api/auth/sso', loginLimiter, asyncRoute(async (req, res) => {
    const session = await auth.sso(req, res, bearerToken(req) || req.body?.token);
    res.set('cache-control', 'no-store').json(session);
  }));

  app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const session = await auth.login(req, res, body);
    res.set('cache-control', 'no-store').json(session);
  }));

  app.use(asyncRoute(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz') {
      return next();
    }
    const token = String(req.query.token || req.query.access_token || '').trim();
    if (!token) return next();
    res.set('cache-control', 'no-store');
    const search = new URLSearchParams();
    const theme = String(req.query.theme || '').toLowerCase();
    if (theme === 'dark' || theme === 'light') search.set('theme', theme);
    const cleanPath = req.path === '/index.html' ? '/' : req.path;
    try {
      const session = await auth.sso(req, res, token);
      return res.redirect(
        303,
        `${cleanPath}${search.size ? `?${search}` : ''}#oc_session=${encodeURIComponent(session.sessionToken)}`
      );
    } catch (error) {
      const exposedCode = [
        'AUTH_FAILED',
        'ADMIN_REQUIRED',
        'AUTH_UPSTREAM_TIMEOUT',
        'SUB2API_SESSION_BINDING_INCOMPATIBLE',
        'SSO_DISABLED'
      ].includes(error?.code) ? error.code : 'AUTH_FAILED';
      search.set('sso_error', exposedCode);
      return res.redirect(303, `${cleanPath}?${search}`);
    }
  }));

  const authenticated = auth.middleware();
  const csrf = auth.csrfMiddleware();
  app.get('/api/auth/me', authenticated, (req, res) => {
    res.set('cache-control', 'no-store').json(auth.publicSession(req.auth));
  });
  app.post('/api/auth/logout', authenticated, csrf, (req, res) => {
    auth.logout(req, res);
    res.status(204).end();
  });

  const api = express.Router();
  api.use(authenticated);
  api.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  api.get('/overview', asyncRoute(async (_req, res) => res.json(await metrics.getOverview())));
  api.get('/metrics/usage', asyncRoute(async (req, res) => res.json(await metrics.getUsage(req.query))));
  api.get('/metrics/usage/dimensions', asyncRoute(async (req, res) => res.json(await metrics.getUsageDimensions(req.query))));
  api.get('/metrics/users', asyncRoute(async (req, res) => res.json(await metrics.getUsers(req.query))));
  api.get('/metrics/finance', asyncRoute(async (req, res) => res.json(await metrics.getFinance(req.query))));
  api.get('/storage', asyncRoute(async (req, res) => res.json(await storage.getStorage({ refresh: req.query.refresh === 'true' }))));
  api.get('/capabilities', asyncRoute(async (_req, res) => {
    const schema = await inspector.inspect({ refresh: true });
    let version = null;
    let versionError = null;
    if (sub2api?.configured()) {
      try { version = await sub2api.getVersion(); } catch (error) { versionError = { code: error.code, message: error.message }; }
    }
    res.json({
      generatedAt: new Date().toISOString(),
      schema,
      version,
      versionError,
      configuredTimezone: config.sub2apiTimezone,
      financeTimezone: config.financeTimezone,
      cleanupEnabled: config.cleanupEnabled,
      automaticCleanupEnabled: Boolean(config.automaticCleanup?.enabled),
      maintenanceConnectionConfigured: database.configured?.('maintenance') ?? Boolean(database.maintenance)
    });
  }));

  api.get('/settings', (_req, res) => res.json(settings.getStatus()));
  api.post('/settings/checks', csrf, asyncRoute(async (_req, res) => res.json(await settings.runChecks())));
  api.post('/settings/database/test', setupLimiter, csrf, asyncRoute(async (req, res) => {
    const input = parse(databaseSetupSchema, req.body || {});
    res.json(await settings.testDatabaseAdministrator(input));
  }));
  api.post('/settings/database/provision', setupLimiter, csrf, asyncRoute(async (req, res) => {
    const input = parse(databaseSetupSchema, req.body || {});
    res.status(201).json(await settings.provisionDatabase(input));
  }));
  api.put('/settings/cleanup', csrf, asyncRoute(async (req, res) => {
    const input = parse(cleanupSettingsSchema, req.body || {});
    res.json(await settings.updateCleanup(input));
  }));
  api.put('/settings/sub2api-credentials', csrf, asyncRoute(async (req, res) => {
    const input = parse(sub2ApiCredentialsSchema, req.body || {});
    res.json(await settings.updateSub2ApiCredentials(input));
  }));

  api.get('/retention/policy', (_req, res) => res.json(retention.getPolicy()));
  api.get('/retention/automation', (_req, res) => res.json(scheduler.getStatus()));
  api.get('/retention/backups/status', asyncRoute(async (_req, res) => res.json(await retention.getBackupStatus())));
  api.post('/retention/backups', csrf, asyncRoute(async (_req, res) => {
    const record = await retention.startNativeBackup();
    res.status(202).json(record);
  }));
  api.post('/retention/previews', csrf, asyncRoute(async (req, res) => {
    const body = parse(previewSchema, req.body || {});
    res.status(201).json(await retention.createPreview(body.targets));
  }));
  api.get('/retention/previews/:id', (req, res) => res.json(retention.getPreview(req.params.id)));
  api.post('/retention/runs', csrf, asyncRoute(async (req, res) => {
    const body = parse(executeSchema, req.body);
    const run = await retention.execute({ ...body, actor: req.auth.actor });
    res.status(202).json(run);
  }));
  api.get('/retention/runs', (_req, res) => res.json({ items: retention.listRuns() }));
  api.get('/retention/runs/:id', (req, res) => res.json(retention.getRun(req.params.id)));
  api.get('/retention/runs/:id/report', (req, res) => {
    const report = retention.getRun(req.params.id);
    res.attachment(`sub2api-cleanup-report-${report.id}.json`).json(report);
  });
  api.post('/retention/runs/:id/cancel', csrf, (req, res) => res.json(retention.cancelRun(req.params.id)));

  app.use('/api', api);

  const publicDir = path.join(__dirname, '..', 'public');
  const lucideDir = path.dirname(require.resolve('lucide/package.json'));
  const echartsDir = path.dirname(require.resolve('echarts/package.json'));
  app.get('/vendor/lucide.js', (_req, res) => res.sendFile(path.join(lucideDir, 'dist', 'umd', 'lucide.js')));
  app.get('/vendor/echarts.js', (_req, res) => res.sendFile(path.join(echartsDir, 'dist', 'echarts.min.js')));
  app.use(express.static(publicDir, { index: false, etag: true, maxAge: config.env === 'production' ? '1h' : 0 }));
  app.get('*splat', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use(errorMiddleware);
  return app;
}

module.exports = { createApp, parse };
