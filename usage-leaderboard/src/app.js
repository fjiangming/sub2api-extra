'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const helmet = require('helmet');
const { z } = require('zod');
const { AppError, errorMiddleware } = require('./errors');
const { PERIODS, METRICS } = require('./repository');
const { publicIdentity } = require('./identity');
const { publicProfile, publicLeaderboard } = require('./public-leaderboard');
const { SettingsStore } = require('./settings');
const { rulesSchema } = require('./simulation');

const selection = z.object({
  period: z.enum(PERIODS).default('today'),
  metric: z.enum(METRICS).default('tokens')
}).strict();
const revisionSchema = z.object({ revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const sourceSchema = revisionSchema.extend({ source: z.enum(['real', 'simulation']) }).strict();
const generateSchema = revisionSchema.extend({ rules: rulesSchema, keepIdentities: z.boolean().default(true) }).strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_REQUEST', '请求参数无效，请检查设置后重试', 400);
  return result.data;
}

function originCheck(req, _res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) throw new Error();
    } catch { return next(new AppError('ORIGIN_INVALID', '页面来源无效，请重新打开排行', 403)); }
  }
  next();
}

function createApp({ config, database, inspector, auth, leaderboard, settings = new SettingsStore(config) }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    frameguard: false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"],
        frameAncestors: ["'self'", new URL(config.sub2apiPublicUrl).origin],
        upgradeInsecureRequests: config.env === 'production' ? [] : null
      }
    }
  }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try { await inspector.inspect(); await database.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '20kb' }));

  // A fixed bucket table keeps rate-limit memory bounded even under many source IPs.
  const buckets = new Map();
  app.use('/api', (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (!bucket && buckets.size >= 4096) {
        for (const [id, value] of buckets) if (value.until <= now) buckets.delete(id);
        if (buckets.size >= 4096) return next(new AppError('SERVICE_BUSY', '访问人数较多，请稍后重试', 503));
      }
      bucket = { until: now + 60000, requests: 0, auth: 0 };
      buckets.set(key, bucket);
    }
    bucket.requests++;
    if (req.path === '/auth/sso') bucket.auth++;
    if (bucket.requests > 120 || bucket.auth > 15) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1000))));
      return next(new AppError('RATE_LIMITED', '操作较频繁，请稍后重试', 429));
    }
    next();
  });
  app.get('/api/auth/config', (_req, res) => res.json({
    sub2apiUrl: config.sub2apiPublicUrl, timezone: config.timezone,
    includeAdmins: config.includeAdmins
  }));
  app.post('/api/auth/sso', originCheck, async (req, res) => {
    const header = String(req.get('authorization') || '');
    const session = await auth.sso(req, res, header.startsWith('Bearer ') ? header.slice(7) : '');
    res.json({ ...session, user: publicProfile(session.user) });
  });
  app.use('/api', auth.middleware());
  app.get('/api/auth/me', (req, res) => {
    const session = auth.publicSession(req.auth);
    res.json({ ...session, user: publicProfile(session.user) });
  });
  app.post('/api/auth/logout', originCheck, (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  app.get('/api/leaderboard', async (req, res) => {
    const parsed = selection.safeParse(req.query);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '统计周期或排名依据无效', 400);
    res.json(publicLeaderboard(await leaderboard.get(parsed.data.period, parsed.data.metric, req.auth.user.id)));
  });
  const admin = express.Router();
  admin.use(auth.adminMiddleware());
  admin.get('/session', (req, res) => res.json({ csrfToken: req.auth.csrfToken }));
  admin.get('/view', (_req, res) => res.json({ html: fs.readFileSync(path.join(config.projectRoot, 'views', 'admin.html'), 'utf8') }));
  admin.get('/settings', (_req, res) => res.json(settings.snapshot()));
  admin.post('/simulation/preview', async (req, res) => res.json(await settings.generate(parse(generateSchema, req.body))));
  admin.get('/leaderboard/preview', async (req, res) => {
    const { period, metric, source } = parse(selection.extend({ source: z.enum(['real', 'simulation']) }).strict(), req.query);
    res.json(await leaderboard.preview(source === 'simulation' ? settings.draftCandidate() : null, period, metric));
  });
  admin.put('/settings/draft', async (req, res) => res.json(await settings.saveDraft(parse(sourceSchema, req.body))));
  const actor = (req) => publicIdentity(req.auth.user.id, req.auth.user.email).name;
  admin.post('/leaderboard/publish', async (req, res) => res.json(await settings.publish(parse(sourceSchema, req.body), actor(req))));
  admin.post('/leaderboard/restore-real', async (req, res) => res.json(await settings.publish({ ...parse(revisionSchema, req.body), source: 'real' }, actor(req))));
  admin.post('/leaderboard/rollback', async (req, res) => res.json(await settings.rollback(parse(revisionSchema, req.body), actor(req))));
  app.use('/api/admin', admin);
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在', 404)));
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.projectRoot, 'public', 'index.html'));
  });
  app.get('/settings', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.projectRoot, 'public', 'settings.html'));
  });
  app.use(express.static(path.join(config.projectRoot, 'public'), { index: false, maxAge: '1h', dotfiles: 'deny' }));
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', '页面不存在', 404)));
  app.use(errorMiddleware);
  return app;
}

module.exports = { createApp };
