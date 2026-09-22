'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { asyncRoute, errorMiddleware, AppError } = require('./errors');

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1024)
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

function createApp({ config, database, auth, inspector, metrics, storage, retention, sub2api }) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', asyncRoute(async (_req, res) => {
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

  app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const session = auth.login(body.username, body.password);
    auth.setCookie(res, session);
    res.set('cache-control', 'no-store').json({
      user: { name: session.actor },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  }));

  const authenticated = auth.middleware();
  const csrf = auth.csrfMiddleware();
  app.get('/api/auth/me', authenticated, (req, res) => {
    res.set('cache-control', 'no-store').json({
      user: { name: req.auth.actor },
      csrfToken: req.auth.csrfToken,
      expiresAt: new Date(req.auth.expiresAt).toISOString()
    });
  });
  app.post('/api/auth/logout', authenticated, csrf, (req, res) => {
    auth.logout(req);
    auth.clearCookie(res);
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
      maintenanceConnectionConfigured: Boolean(database.maintenance)
    });
  }));

  api.get('/retention/policy', (_req, res) => res.json(retention.getPolicy()));
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
