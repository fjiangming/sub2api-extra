'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { AppError, errorMiddleware } = require('./errors');

const paging = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().startsWith(s));
const ledgerQuery = paging.extend({ query: z.string().trim().max(320).default(''), from: date.optional(), to: date.optional(),
  status: z.enum(['pending','paid','failed']).optional(), audit: z.enum(['violation','unverifiable','passed','not_required']).optional(), source: z.enum(['recharge','compensation']).optional() }).refine(v => !v.from || !v.to || v.from <= v.to);
const drawInput = z.object({ requestId: z.string().uuid().transform(v => v.toLowerCase()), count: z.union([z.literal(1),z.literal(10),z.literal(20),z.literal(50)]) }).strict();
const profileInput = z.object({ name: z.string().trim().min(1).max(80), status: z.enum(['enabled','disabled']).default('enabled'),
  weights: z.array(z.object({ amountMinor: z.number().int().min(1).max(10000), weight: z.number().int().min(0).max(10000) }).strict()).length(8) }).strict();
const lotteryConfigInput = z.object({ prizes: z.array(z.object({ amountMinor: z.number().int().min(1).max(10000), weight: z.number().int().min(0).max(10000), minimumMinor: z.number().int().min(0).max(1000000000000) }).strict()).length(8) }).strict();
const grantInput = z.object({ audience: z.enum(['all','selected']), userIds: z.array(z.string().trim().regex(/^[1-9]\d{0,14}$/)).max(100).default([]),
  chanceCount: z.number().int().min(1).max(100000), profileId: z.string().trim().min(1).max(100), startsAt: z.string().min(1).max(64), expiresAt: z.string().max(64).nullable().optional(), reason: z.string().trim().min(1).max(200) }).strict();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_REQUEST', '请求参数无效');
  return result.data;
}

function createApp({ config, auth, store, lottery }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ frameguard: false, referrerPolicy: { policy: 'no-referrer' }, contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
    frameAncestors: ["'self'", ...config.origins], upgradeInsecureRequests: config.env === 'production' ? [] : null
  } } }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '4kb' }));
  const limit = (max, windowMs = 60000) => rateLimit({ windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: '操作较频繁，请稍后重试' } } });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ready' }); });
  app.use('/api', limit(240));
  app.get('/api/config', (_req, res) => res.json({ sub2apiUrl: config.sub2apiPublicUrl, timezone: config.timezone }));
  app.post('/api/auth/sso', limit(15), async (req, res) => {
    const token = String(req.get('authorization') || '').replace(/^Bearer /, '');
    res.json(await auth.sso(req, res, token));
  });
  app.use('/api', auth.middleware());
  app.get('/api/auth/me', (req, res) => res.json(auth.publicSession(req.auth)));
  app.post('/api/auth/logout', auth.mutation(), (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  app.get('/api/activities', (_req, res) => res.json({ activities: store.registry() }));
  app.get('/api/activities/recharge-lottery', async (req, res) => res.json(await lottery.summary(req.auth.user.id)));
  app.post('/api/activities/recharge-lottery/draw', limit(20), auth.mutation(), async (req, res) => {
    const { requestId, count } = parse(drawInput, req.body);
    res.json(await lottery.draw(req.auth.user, requestId, count));
  });
  app.get('/api/activities/recharge-lottery/batches/:id', (req, res) => res.json(store.batch(req.auth.user.id, parse(z.string().uuid(), req.params.id))));
  app.get('/api/rewards', (req, res) => res.json(store.list({ ...parse(paging, req.query), userId: req.auth.user.id })));
  const admin = express.Router();
  admin.use(auth.admin.bind(auth));
  admin.get('/view', (_req, res) => res.type('html').sendFile(path.join(config.projectRoot, 'views', 'ledger.html')));
  admin.get('/compensation/view', (_req, res) => res.type('html').sendFile(path.join(config.projectRoot, 'views', 'compensation.html')));
  admin.get('/summary', (_req, res) => res.json({ ...store.ledgerSummary(), audit: store.auditSummary() }));
  admin.get('/rewards', (req, res) => res.json(store.list(parse(ledgerQuery, req.query))));
  admin.get('/rewards/:id', (req, res) => res.json(store.detail(parse(z.string().uuid(), req.params.id))));
  admin.get('/lottery-config', (_req, res) => res.json(store.lotteryConfig()));
  admin.post('/lottery-config', limit(30), auth.mutation(), (req, res) => {
    const input = parse(lotteryConfigInput, req.body);
    res.json(store.updateLotteryConfig(input, req.auth.user.id));
  });
  admin.post('/rewards/:id/retry', limit(10), auth.mutation(), (req, res) => {
    const result = store.retry(parse(z.string().uuid(), req.params.id), req.auth.user.id);
    lottery.kick();
    res.json(result);
  });
  admin.get('/compensation/summary', (_req, res) => res.json(store.compensationSummary()));
  admin.get('/compensation/profiles', (_req, res) => res.json({ profiles: store.compensationProfiles() }));
  admin.post('/compensation/profiles', limit(30), auth.mutation(), (req, res) => {
    const input = parse(profileInput, req.body);
    res.status(201).json(store.createCompensationProfile(input, req.auth.user.id));
  });
  admin.post('/compensation/profiles/:id', limit(30), auth.mutation(), (req, res) => {
    const input = parse(profileInput.partial(), req.body);
    res.json(store.updateCompensationProfile(parse(z.string().min(1).max(100), req.params.id), input, req.auth.user.id));
  });
  admin.get('/compensation/grants', (req, res) => res.json(store.compensationGrants(parse(paging, req.query))));
  admin.get('/compensation/grants/:id', (req, res) => res.json(store.compensationGrant(parse(z.string().uuid(), req.params.id))));
  admin.post('/compensation/grants', limit(30), auth.mutation(), (req, res) => {
    const input = parse(grantInput, req.body);
    res.status(201).json(store.createCompensationGrant(input, req.auth.user.id));
  });
  admin.post('/compensation/grants/:id/disable', limit(30), auth.mutation(), (req, res) => {
    res.json(store.disableCompensationGrant(parse(z.string().uuid(), req.params.id), req.auth.user.id));
  });
  admin.get('/compensation/audit', (req, res) => res.json({ rows: store.compensationAudit() }));
  app.use('/api/admin', admin);
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在', 404)));
  app.get('/vendor/lucide.js', (_req, res) => res.sendFile(require.resolve('lucide/dist/umd/lucide.js')));
  app.get('/', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(config.projectRoot, 'public', 'index.html')); });
  app.use(express.static(path.join(config.projectRoot, 'public'), { index: false, dotfiles: 'deny', maxAge: '5m' }));
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', '页面不存在', 404)));
  app.use(errorMiddleware);
  return app;
}

module.exports = { createApp };
