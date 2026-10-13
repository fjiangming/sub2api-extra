'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { z } = require('zod');
const { AppError, errorMiddleware } = require('./errors');
const { PERIODS, METRICS } = require('./repository');

const selection = z.object({
  period: z.enum(PERIODS).default('month'),
  metric: z.enum(METRICS).default('tokens')
}).strict();

function originCheck(req, _res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) throw new Error();
    } catch { return next(new AppError('ORIGIN_INVALID', '页面来源无效，请重新打开排行', 403)); }
  }
  next();
}

function createApp({ config, database, inspector, auth, leaderboard }) {
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
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"],
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
    includeAdmins: config.includeAdmins,
    preview: config.preview === true
  }));
  app.post('/api/auth/sso', originCheck, async (req, res) => {
    const header = String(req.get('authorization') || '');
    res.json(await auth.sso(req, res, header.startsWith('Bearer ') ? header.slice(7) : ''));
  });
  app.use('/api', auth.middleware());
  app.get('/api/auth/me', (req, res) => res.json(auth.publicSession(req.auth)));
  app.post('/api/auth/logout', originCheck, (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  app.get('/api/leaderboard', async (req, res) => {
    const parsed = selection.safeParse(req.query);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '统计周期或排名依据无效', 400);
    res.json(await leaderboard.get(parsed.data.period, parsed.data.metric, req.auth.user.id));
  });
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在', 404)));
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.projectRoot, 'public', 'index.html'));
  });
  app.use(express.static(path.join(config.projectRoot, 'public'), { index: false, maxAge: '1h', dotfiles: 'deny' }));
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', '页面不存在', 404)));
  app.use(errorMiddleware);
  return app;
}

module.exports = { createApp };
