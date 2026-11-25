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
const { sendPayload } = require('./services/conversation-read-response');

const loginSchema = z.object({
  username: z.string().min(1).max(320).optional(),
  email: z.string().min(1).max(320).optional(),
  password: z.string().min(1).max(1024)
}).refine((value) => value.username || value.email, {
  message: '请输入管理员账号或邮箱',
  path: ['username']
});

const dailyProfitProviderRefreshSchema = z.object({
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().trim().min(1).max(200)
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

const expenseSchema = z.object({
  kind: z.enum(['provider', 'custom']),
  providerId: z.string().trim().min(1).max(100).optional().nullable(),
  name: z.string().trim().max(120).optional().default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite().positive().max(1000000000000)
    .refine((value) => Math.abs(value - Math.round(value * 100) / 100) < 1e-9, '金额最多保留两位小数'),
  currency: z.string().trim().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  note: z.string().trim().max(500).optional().default('')
}).superRefine((value, context) => {
  const parsedDate = new Date(`${value.date}T00:00:00.000Z`);
  if (value.date.startsWith('0000-') || Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== value.date) {
    context.addIssue({ code: 'custom', path: ['date'], message: '发生日期无效' });
  }
  if (value.kind === 'provider' && !value.providerId) {
    context.addIssue({ code: 'custom', path: ['providerId'], message: '请选择供应商' });
  }
  if (value.kind === 'custom' && !value.name) {
    context.addIssue({ code: 'custom', path: ['name'], message: '请输入支出项名称' });
  }
});

const incomeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite().positive().max(1000000000000)
    .refine((value) => Math.abs(value - Math.round(value * 100) / 100) < 1e-9, '金额最多保留两位小数'),
  currency: z.string().trim().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  note: z.string().trim().max(500).optional().default('')
}).superRefine((value, context) => {
  const parsedDate = new Date(`${value.date}T00:00:00.000Z`);
  if (value.date.startsWith('0000-') || Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== value.date) {
    context.addIssue({ code: 'custom', path: ['date'], message: '发生日期无效' });
  }
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

function bearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function frameAncestorSources(config) {
  const sources = new Set(["'self'"]);
  for (const value of config.sub2apiPublicOrigins || [config.sub2apiPublicUrl]) {
    try { sources.add(new URL(value).origin); } catch {}
  }
  return [...sources];
}

function createApp({ config, database, auth, inspector, metrics, profiles, latency, requestErrors, telemetry, costAnalysis, dailyProfit, supplierGroups, accounting, cashFlow, messages, domainAccess, groupMonitor, conversations, conversationArchive, conversationRead, conversationExport, conversationPush, conversationCleanup, conversationRepair, billingRecovery, billingImports, storage, retention, scheduler, sub2api, settings }) {
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
  const jsonBody = express.json({ limit: '64kb' });
  app.use((req, res, next) => {
    const dedicated = req.method === 'POST' && ['/api/billing-imports', '/api/billing-imports/inspect', '/api/conversation-logs/ingest'].includes(req.path) ||
      req.method === 'PUT' && req.path === '/api/conversation-logs/push/policy';
    return dedicated ? next() : jsonBody(req, res, next);
  });

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
        'AUTH_UPSTREAM_UNAVAILABLE',
        'AUTH_UPSTREAM_INVALID_RESPONSE',
        'SUB2API_SESSION_BINDING_INCOMPATIBLE',
        'SSO_DISABLED'
      ].includes(error?.code) ? error.code : 'AUTH_FAILED';
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

  const authenticated = auth.middleware();
  const telemetryLimiter = rateLimit({ windowMs: 60000, limit: 6000, standardHeaders: 'draft-8', legacyHeaders: false });
  app.post('/api/latency/ingest', telemetryLimiter, asyncRoute(async (req, res) => {
    const supplied = bearerToken(req);
    const expected = config.latencyTelemetry?.token;
    if (!expected || !supplied || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(supplied).digest(), crypto.createHash('sha256').update(expected).digest()
    )) throw new AppError('TELEMETRY_AUTH_REQUIRED', '采集认证无效', { status: 401 });
    res.set('cache-control', 'no-store').json(telemetry.ingest(req.body));
  }));
  const csrf = auth.csrfMiddleware();
  const conversationCollectorAuth = (req, res, next) => {
    res.set('cache-control', 'no-store');
    const supplied = bearerToken(req), expected = config.conversationLogs?.token;
    if (!expected || !supplied || !crypto.timingSafeEqual(crypto.createHash('sha256').update(supplied).digest(), crypto.createHash('sha256').update(expected).digest())) {
      return next(new AppError('CONVERSATION_AUTH_REQUIRED', '采集认证无效', { status: 401 }));
    }
    if (!conversations) return next(new AppError('CONVERSATION_UNAVAILABLE', '对话归档暂不可用', { status: 503 }));
    next();
  };
  app.get('/api/conversation-logs/collector-policy', conversationCollectorAuth, (req, res) => res.json(conversations.collectorPolicy(req.get('x-conversation-dropped'), req.get('x-conversation-collector-version'), Boolean(conversationArchive))));
  app.post('/api/conversation-logs/ingest', conversationCollectorAuth,
    (req, res, next) => conversationArchive ? conversationArchive.proxy(req, res, next) : next(),
    express.json({ limit: '272mb', strict: true }), asyncRoute(async (req, res) => {
    res.json(conversations.ingest(req.body));
  }));
  app.get('/api/auth/me', authenticated, (req, res) => {
    res.set('cache-control', 'no-store').json(auth.publicSession(req.auth));
  });
  app.post('/api/auth/logout', authenticated, csrf, (req, res) => {
    auth.logout(req, res);
    res.status(204).end();
  });
  // A one-use capability supports native streaming downloads in header-authenticated embeds.
  app.get('/api/conversation-logs/exports/:id/download', (req,res,next) => {
    res.set({'cache-control':'no-store','referrer-policy':'no-referrer'});
    if (!conversationExport) return next(new AppError('CONVERSATION_EXPORT_UNAVAILABLE','日志导出暂不可用',{status:503}));
    conversationExport.download(req,res,next);
  });

  const announcementLimiter = rateLimit({
    windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false
  });
  app.use('/api/v1/announcements', announcementLimiter, (_req, res, next) => {
    res.set('cache-control', 'no-store');
    if (_req.get('x-operations-announcements-hop')) {
      return next(new AppError('ANNOUNCEMENT_GATEWAY_LOOP', '公告上游地址形成回环，请配置直连 Sub2API 的地址', { status: 508 }));
    }
    if (!messages) return next(new AppError('USER_MESSAGE_DELIVERY_DISABLED', '消息投递尚未启用', { status: 503 }));
    next();
  });
  app.get('/api/v1/announcements', asyncRoute(async (req, res) => {
    const unreadOnly = ['1', 'true', 'yes', 'y', 'on'].includes(String(req.query.unread_only || '').toLowerCase());
    const data = await messages.listForUser(bearerToken(req), unreadOnly);
    res.set('x-operations-announcements', '1').json({ code: 0, message: 'success', data });
  }));
  app.post('/api/v1/announcements/:id/read', asyncRoute(async (req, res) => {
    const data = await messages.markReadForUser(bearerToken(req), req.params.id);
    res.json({ code: 0, message: 'success', data });
  }));

  const api = express.Router();
  api.use(authenticated);
  api.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  api.use('/conversation-logs', (_req, _res, next) => conversations ? next() : next(new AppError('CONVERSATION_UNAVAILABLE', '对话归档暂不可用', { status: 503 })));
  const readConversation = fallback => (req,res,next) => conversationRead
    ? conversationRead.proxy(req,res,next,req.originalUrl.slice('/api/conversation-logs'.length)) : fallback(req,res);
  api.get('/conversation-logs/status', readConversation((_req, res) => res.json({ ...conversations.status(), configured: Boolean(config.conversationLogs?.token) })));
  api.get('/conversation-logs/policy', (_req, res) => res.json(conversations.policy()));
  api.put('/conversation-logs/policy', csrf, (req, res) => {
    const result = conversations.configure(req.body);
    conversationPush?.invalidate();
    res.json(result);
  });
  api.use('/conversation-logs/model-cleanup', (_req, _res, next) => conversationCleanup ? next() : next(new AppError('CONVERSATION_CLEANUP_UNAVAILABLE', '历史清理后台暂不可用', { status: 503 })));
  const conversationCleanupLimiter = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  api.get('/conversation-logs/model-cleanup', (_req, res) => res.json(conversationCleanup.status()));
  api.post('/conversation-logs/model-cleanup', csrf, conversationCleanupLimiter, (req, res) => {
    const result = conversationCleanup.request(req.body);
    conversationPush?.invalidate();
    res.status(202).json(result);
  });
  api.post('/conversation-logs/model-cleanup/:id/cancel', csrf, conversationCleanupLimiter, (req, res) => res.json(conversationCleanup.cancel(req.params.id)));
  api.use('/conversation-logs/history-clear', (_req, _res, next) => conversationCleanup ? next() : next(new AppError('CONVERSATION_CLEANUP_UNAVAILABLE', '历史清理后台暂不可用', { status: 503 })));
  api.get('/conversation-logs/history-clear', (_req, res) => res.json(conversationCleanup.status('all')));
  api.post('/conversation-logs/history-clear', csrf, conversationCleanupLimiter, (req, res) => {
    const result = conversationCleanup.requestAll(req.body);
    conversationPush?.invalidate();
    res.status(202).json(result);
  });
  api.post('/conversation-logs/history-clear/:id/cancel', csrf, conversationCleanupLimiter, (req, res) => res.json(conversationCleanup.cancel(req.params.id, 'all')));
  api.use('/conversation-logs/history-repair', (_req, _res, next) => conversationRepair ? next() : next(new AppError('CONVERSATION_REPAIR_UNAVAILABLE', '历史检查后台暂不可用', { status: 503 })));
  api.get('/conversation-logs/history-repair', (_req, res) => res.json(conversationRepair.status()));
  api.post('/conversation-logs/history-repair', csrf, conversationCleanupLimiter, (req, res) => res.status(202).json(conversationRepair.request(req.body)));
  api.post('/conversation-logs/history-repair/:id/cancel', csrf, conversationCleanupLimiter, (req, res) => res.json(conversationRepair.cancel(req.params.id)));
  api.use('/conversation-logs/history-redaction', (_req, _res, next) => conversationRepair ? next() : next(new AppError('CONVERSATION_REPAIR_UNAVAILABLE', '历史脱敏后台暂不可用', { status: 503 })));
  api.get('/conversation-logs/history-redaction', (_req, res) => res.json(conversationRepair.status('redaction')));
  api.post('/conversation-logs/history-redaction', csrf, conversationCleanupLimiter, (req, res) => res.status(202).json(conversationRepair.request(req.body,'redaction')));
  api.post('/conversation-logs/history-redaction/:id/cancel', csrf, conversationCleanupLimiter, (req, res) => res.json(conversationRepair.cancel(req.params.id,'redaction')));
  api.use('/conversation-logs/push', (_req, _res, next) => conversationPush ? next() : next(new AppError('CONVERSATION_PUSH_UNAVAILABLE', '日志推送暂不可用', { status: 503 })));
  const pushLimiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  api.get('/conversation-logs/push/policy', (_req, res) => res.json(conversationPush.policy()));
  api.put('/conversation-logs/push/policy', csrf, pushLimiter, express.json({ limit: '4mb' }), asyncRoute(async (req, res) => res.json(await conversationPush.configure(req.body))));
  api.get('/conversation-logs/push/jobs', (req, res) => res.json(conversationPush.status(req.query)));
  api.get('/conversation-logs/push/billing', (req, res) => res.json(conversationPush.billing(req.query)));
  api.get('/conversation-logs/push/billing/price', (req, res) => res.json(conversationPush.pricingStatus()));
  api.post('/conversation-logs/push/billing/price', csrf, pushLimiter, (req, res) => res.status(202).json(conversationPush.fillBilling(req.body)));
  api.post('/conversation-logs/push/billing/price/:id/cancel', csrf, pushLimiter, (req, res) => res.json(conversationPush.cancelBilling(req.params.id)));
  api.post('/conversation-logs/push/jsonl/flush', csrf, pushLimiter, (req, res) => res.status(202).json(conversationPush.flush()));
  api.post('/conversation-logs/push/jsonl/:id/retry', csrf, pushLimiter, (req, res) => res.json(conversationPush.retryFile(req.params.id)));
  api.post('/conversation-logs/push/preview', csrf, pushLimiter, (req, res) => res.json(conversationPush.preview(req.body)));
  api.post('/conversation-logs/push/batches', csrf, pushLimiter, asyncRoute(async (req, res) => res.status(202).json(await conversationPush.enqueue(req.body))));
  api.get('/conversation-logs/push/batches/:id', (req, res) => res.json(conversationPush.store.batch(req.params.id)));
  api.post('/conversation-logs/push/batches/:id/cancel', csrf, pushLimiter, (req, res) => res.json(conversationPush.cancelBatch(req.params.id)));
  api.post('/conversation-logs/push/jobs/:id/retry', csrf, pushLimiter, (req, res) => res.json(conversationPush.retry(req.params.id)));
  api.post('/conversation-logs/push/test/:destination', csrf, rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }),
    asyncRoute(async (req, res) => res.json(await conversationPush.test(req.params.destination))));
  api.get('/conversation-logs/users', asyncRoute(async (req, res) => res.json(await messages.searchUsers(req.query, req.auth.upstreamAccessToken))));
  api.get('/conversation-logs/sessions', readConversation((req, res) => res.json(conversations.sessions(req.query))));
  api.get('/conversation-logs/records', readConversation((req, res) => res.json(conversations.list(req.query))));
  api.get('/conversation-logs/index', readConversation((req, res) => res.json(conversations.exportIndex(req.query))));
  api.use('/conversation-logs/exports', (_req,_res,next) => conversationExport ? next() : next(new AppError('CONVERSATION_EXPORT_UNAVAILABLE','日志导出暂不可用',{status:503})));
  const exportLimiter=rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,
    message:{error:{code:'CONVERSATION_EXPORT_RATE_LIMITED',message:'导出操作过于频繁，请稍后重试'}}});
  api.post('/conversation-logs/exports',csrf,exportLimiter,(req,res) => res.status(201).json(conversationExport.create(req,req.body)));
  api.get('/conversation-logs/exports/:id',(req,res) => res.json(conversationExport.status(req,req.params.id)));
  api.post('/conversation-logs/exports/:id/cancel',csrf,(req,res) => res.json(conversationExport.cancel(req,req.params.id)));
  api.get('/conversation-logs/records/:id', readConversation((req, res) => res.json(conversations.detail(req.params.id))));
  api.post('/conversation-logs/records/:id/reprocess', csrf, rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    (req, res, next) => conversationArchive
      ? conversationArchive.proxy(req, res, next, '/reprocess/' + encodeURIComponent(req.params.id), Buffer.from(JSON.stringify(req.body || {})))
      : res.json(conversations.retry(req.params.id, req.body)));
  api.get('/conversation-logs/records/:id/payload/:side', readConversation((req, res) => {
    const value = conversations.payload(req.params.id, req.query.source || 'masked', req.params.side,{decodeText:req.query.download !== '1'});
    sendPayload(req,res,value);
  }));

  api.get('/billing-imports/options', asyncRoute(async (_req, res) => res.json(await billingImports.options())));
  api.post('/billing-imports/inspect', csrf, express.json({ limit: '12mb' }), asyncRoute(async (req, res) => res.json(billingImports.inspect(req.body))));
  api.get('/billing-imports/:id', asyncRoute(async (req, res) => res.json(billingImports.detail(req.params.id, req.query))));
  api.post('/billing-imports/:id/rows', csrf, asyncRoute(async (req, res) => res.json(billingImports.selectedRows(req.params.id, req.body))));
  api.post('/billing-imports/:id/tasks', csrf, asyncRoute(async (req, res) => res.status(202).json({
    task: billingImports.tasks.submit(req.params.id, req.body, req.auth.upstreamAccessToken)
  })));
  api.get('/billing-imports/:id/tasks/:taskId', asyncRoute(async (req, res) => res.json({
    task: billingImports.tasks.get(req.params.id, req.params.taskId)
  })));
  api.post('/billing-imports', csrf, express.json({ limit: '12mb' }), asyncRoute(async (req, res) => res.json(await billingImports.import(req.body))));
  api.post('/billing-imports/:id/match', csrf, asyncRoute(async (req, res) => res.json(await billingImports.match(req.params.id, req.body, req.auth.upstreamAccessToken))));
  api.post('/billing-imports/:id/preview', csrf, asyncRoute(async (req, res) => res.json(await billingImports.preview(req.params.id, req.body, req.auth.upstreamAccessToken))));
  api.post('/billing-imports/:id/confirm', csrf, asyncRoute(async (req, res) => res.json(await billingImports.confirm(req.params.id, req.body, req.auth.upstreamAccessToken))));

  api.get('/billing-recovery/status', (_req, res) => res.json(billingRecovery.status()));
  api.get('/billing-recovery', asyncRoute(async (req, res) => res.json(await billingRecovery.list(req.query, req.auth.upstreamAccessToken))));
  api.get('/billing-recovery/:id', asyncRoute(async (req, res) => res.json(await billingRecovery.detail(req.params.id, req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/retry', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.retryPending(req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/:id/lookup', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.lookup(req.params.id, req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/:id/draft', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.draftVerifiedUsage(req.params.id, req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/:id/review', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.review(req.params.id, req.body, req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/:id/usage', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.restore(req.params.id, req.body, req.auth.upstreamAccessToken))));
  api.post('/billing-recovery/:id/settle', csrf, asyncRoute(async (req, res) => res.json(await billingRecovery.settle(req.params.id, req.body, req.auth.upstreamAccessToken))));

  api.get('/overview', asyncRoute(async (_req, res) => res.json(await metrics.getOverview())));
  const groupMonitorLimiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  api.use('/group-monitor', (_req, _res, next) => groupMonitor ? next() : next(new AppError('GROUP_MONITOR_UNAVAILABLE', '分组监控暂不可用，请检查服务启动日志', { status: 503 })));
  api.get('/group-monitor', asyncRoute(async (req, res) => res.json(await groupMonitor.report(req.query))));
  api.get('/group-monitor/groups/:id', (req, res) => res.json(groupMonitor.detail(req.params.id)));
  api.put('/group-monitor/groups/:id', csrf, groupMonitorLimiter, asyncRoute(async (req, res) => res.json(await groupMonitor.configureGroup(req.params.id, req.body))));
  api.put('/group-monitor/policy', csrf, groupMonitorLimiter, (req, res) => res.json(groupMonitor.configurePolicy(req.body)));
  api.get('/group-monitor/findings', (req, res) => res.json(groupMonitor.findings(req.query)));
  api.get('/group-monitor/findings/:id', (req, res) => res.json(groupMonitor.finding(req.params.id)));
  api.post('/group-monitor/scan', csrf, groupMonitorLimiter, asyncRoute(async (_req, res) => res.json(await groupMonitor.scan())));
  api.post('/group-monitor/runs', csrf, groupMonitorLimiter, asyncRoute(async (req, res) => res.status(202).json(await groupMonitor.startRun(req.body))));
  api.post('/group-monitor/runs/:id/cancel', csrf, groupMonitorLimiter, (req, res) => res.json(groupMonitor.cancel(req.params.id)));

  if (domainAccess) {
    api.get('/domain-access/options', (_req, res) => res.json(domainAccess.options()));
    api.get('/domain-access/status', (_req, res) => res.json(domainAccess.status()));
    api.get('/domain-access/report', (req, res) => res.json(domainAccess.report(req.query)));
    api.get('/domain-access/users', (req, res) => res.json(domainAccess.users(req.query)));
    api.get('/domain-access/users.csv', (req, res) => res.type('text/csv').attachment('domain-access-users.csv').send(domainAccess.csv(req.query)));
    api.get('/domain-access/users/:id', (req, res) => res.json(domainAccess.user(req.params.id, req.query)));
    api.get('/domain-access/requests', (req, res) => res.json(domainAccess.requests(req.query)));
    api.get('/domain-access/requests/:id', (req, res) => res.json(domainAccess.detail(req.params.id)));
    api.get('/domain-access/history', (req, res) => res.json(domainAccess.history(req.query)));
    api.put('/domain-access/settings', csrf, (req, res) => res.json(domainAccess.configure(req.body, req.auth.actor)));
    api.post('/domain-access/notifications', csrf, (req, res) => res.json(domainAccess.notify(req.body, req.auth.actor)));
    api.get('/domain-access/drafts', (req, res) => res.json({ items: domainAccess.drafts(req.query.domain) }));
    api.post('/domain-access/drafts', csrf, (req, res) => res.status(202).json(domainAccess.createDraft(req.body, req.auth.actor,
      req.get('idempotency-key'), req.auth.upstreamAccessToken)));
    api.post('/domain-access/drafts/:id/retry', csrf, (req, res) => res.status(202).json(domainAccess.retryDraft(req.params.id, req.auth.upstreamAccessToken)));
  }
  if (requestErrors) {
    api.get('/request-errors/options', (_req, res) => res.json(requestErrors.options()));
    api.get('/request-errors/report', asyncRoute(async (req, res) => res.json(await requestErrors.report(req.query, req.auth.upstreamAccessToken))));
    api.get('/request-errors/requests/:id', asyncRoute(async (req, res) => res.json(await requestErrors.detail(req.params.id, req.query, req.auth.upstreamAccessToken))));
  }
  api.get('/latency/options', asyncRoute(async (_req, res) => res.json(await latency.options())));
  api.get('/latency/requests', asyncRoute(async (req, res) => res.json(await latency.report(req.query))));
  api.get('/latency/requests/:id', asyncRoute(async (req, res) => res.json(await latency.detail(req.params.id, req.auth.upstreamAccessToken))));
  api.get('/latency/live', (_req, res) => res.json({ items: telemetry.recent(), status: telemetry.status() }));
  api.get('/latency/resources', (req, res) => res.json({ items: telemetry.resources(req.query) }));
  api.get('/user-messages/status', (_req, res) => res.json(messages.status()));
  api.get('/user-messages/users', asyncRoute(async (req, res) => {
    res.json(await messages.searchUsers(req.query, req.auth.upstreamAccessToken));
  }));
  api.get('/user-messages', (req, res) => res.json(messages.list(req.query)));
  api.post('/user-messages', csrf, asyncRoute(async (req, res) => {
    res.status(201).json(await messages.create(req.body, {
      actor: req.auth.actor, accessToken: req.auth.upstreamAccessToken, requestKey: req.get('idempotency-key')
    }));
  }));
  api.put('/user-messages/:id', csrf, asyncRoute(async (req, res) => {
    res.json(await messages.update(req.params.id, req.body, { actor: req.auth.actor, accessToken: req.auth.upstreamAccessToken }));
  }));
  api.post('/user-messages/:id/archive', csrf, asyncRoute(async (req, res) => {
    res.json(await messages.archive(req.params.id, req.auth.actor));
  }));
  api.delete('/user-messages/:id', csrf, asyncRoute(async (req, res) => {
    await messages.remove(req.params.id);
    res.status(204).end();
  }));
  api.get('/metrics/usage', asyncRoute(async (req, res) => res.json(await metrics.getUsage(req.query))));
  api.get('/metrics/usage/dimensions', asyncRoute(async (req, res) => res.json(await metrics.getUsageDimensions(req.query))));
  api.get('/metrics/users', asyncRoute(async (req, res) => res.json(await metrics.getUsers(req.query))));
  api.get('/user-profiles/options', asyncRoute(async (_req, res) => res.json(await profiles.getOptions())));
  api.get('/user-profiles', asyncRoute(async (req, res) => res.json(await profiles.getReport(req.query))));
  api.get('/user-profiles/users', asyncRoute(async (req, res) => res.json(await profiles.getUsers(req.query))));
  api.get('/user-profiles/export', asyncRoute(async (req, res) => {
    const result = await profiles.exportUsers(req.query);
    res.attachment(result.filename).type('text/csv; charset=utf-8').send(result.csv);
  }));
  api.get('/user-profiles/users/:userId', asyncRoute(async (req, res) => {
    res.json(await profiles.getUser(req.params.userId, req.query));
  }));
  api.get('/metrics/finance', asyncRoute(async (req, res) => res.json(await metrics.getFinance(req.query))));
  if (accounting) {
    api.use('/cost-analysis/accounting', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    api.get('/cost-analysis/accounting/report', asyncRoute(async (req, res) => res.json(await accounting.getReport(req.query, { accessToken: req.auth.upstreamAccessToken || null }))));
    api.get('/cost-analysis/accounting/documents', (req, res) => res.json(accounting.listDocuments(req.query)));
    api.get('/cost-analysis/accounting/credits/users', asyncRoute(async (req, res) => res.json(await accounting.creditUsers(req.query))));
    api.get('/cost-analysis/accounting/credits/users/:userKey/records', asyncRoute(async (req, res) => res.json(await accounting.creditUsers(req.query, req.params.userKey))));
    api.get('/cost-analysis/accounting/documents/:key', (req, res) => {
      const item = accounting.effectiveDocuments().find(document => document.key === req.params.key);
      if (!item) throw new AppError('ACCOUNTING_NOT_FOUND', '记录不存在', { status: 404 });
      res.json({ item, history: accounting.store.history(item.key) });
    });
    api.post('/cost-analysis/accounting/documents', csrf, asyncRoute(async (req, res) => res.status(201).json(await accounting.create(req.body, req.auth.actor))));
    api.put('/cost-analysis/accounting/documents/:key', csrf, (req, res) => res.json(accounting.classify(req.params.key, req.body, req.auth.actor)));
    api.put('/cost-analysis/accounting/policy', csrf, (req, res) => res.json(accounting.configure(req.body, req.auth.actor)));
    api.put('/cost-analysis/accounting/opening', csrf, (req, res) => res.json(accounting.opening(req.body, req.auth.actor)));
  }
  if (cashFlow) {
    api.use('/cost-analysis/cash', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    api.get('/cost-analysis/cash/report', asyncRoute(async (req, res) => res.json(await cashFlow.getReport(req.query))));
    api.get('/cost-analysis/cash/balances', asyncRoute(async (req, res) => res.json(await cashFlow.getBalances(req.query))));
    api.get('/cost-analysis/cash/provider-balances', asyncRoute(async (req, res) => res.json(await cashFlow.providerBalances({ accessToken: req.auth.upstreamAccessToken || null, refresh: req.query.refresh === '1' }))));
    api.get('/cost-analysis/cash/records/:key', (req, res) => res.json(cashFlow.detail(req.params.key)));
    api.post('/cost-analysis/cash/records', csrf, asyncRoute(async (req, res) => res.status(201).json(await cashFlow.save(req.body, req.auth.actor))));
    api.put('/cost-analysis/cash/records/:key', csrf, asyncRoute(async (req, res) => res.json(await cashFlow.save(req.body, req.auth.actor, req.params.key))));
    api.delete('/cost-analysis/cash/records/:key', csrf, (req, res) => { cashFlow.remove(req.params.key, req.auth.actor); res.status(204).end(); });
  }
  api.get('/cost-analysis', asyncRoute(async (req, res) => res.json(await costAnalysis.getReport(req.query))));
  api.get('/cost-analysis/supplier-groups', asyncRoute(async (req, res) => {
    if (!supplierGroups) throw new AppError('SUPPLIER_GROUP_UNAVAILABLE', '供应商分组消费暂不可用，请检查模块初始化状态', { status: 503 });
    res.set('Cache-Control', 'no-store').json(await supplierGroups.getReport(req.query, { accessToken: req.auth.upstreamAccessToken || null }));
  }));
  api.put('/cost-analysis/supplier-groups/settings', csrf,
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }), (req, res) => {
      if (!supplierGroups) throw new AppError('SUPPLIER_GROUP_UNAVAILABLE', '供应商分组消费暂不可用', { status: 503 });
      res.set('Cache-Control', 'no-store').json(supplierGroups.configure(req.body, req.auth.actor));
    });
  api.get('/cost-analysis/daily-profit', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await (dailyProfit || costAnalysis).getDailyProfit(req.query, {
      accessToken: req.auth.upstreamAccessToken || null
    }));
  }));
  api.post('/cost-analysis/daily-profit/provider-refresh', csrf, asyncRoute(async (req, res) => {
    if (!dailyProfit?.refreshProvider) throw new AppError('DAILY_PROFIT_REFRESH_UNAVAILABLE', '每日供应商刷新暂不可用', { status: 503 });
    const input = parse(dailyProfitProviderRefreshSchema, req.body || {});
    res.set('Cache-Control', 'no-store').json(await dailyProfit.refreshProvider(input, {
      accessToken: req.auth.upstreamAccessToken || null
    }));
  }));
  api.get('/cost-analysis/automatic-income/users', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await (cashFlow ? cashFlow.creditUsers(req.query) : costAnalysis.getAutomaticIncomeUsers(req.query)));
  }));
  api.get('/cost-analysis/automatic-income/users/:userKey/records', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await (cashFlow ? cashFlow.creditUsers(req.query, req.params.userKey) : costAnalysis.getAutomaticIncomeRecords(req.params.userKey, req.query)));
  }));
  api.get('/cost-analysis/providers', asyncRoute(async (req, res) => res.json(await costAnalysis.getProviders({
    refresh: req.query.refresh === 'true',
    accessToken: req.auth.upstreamAccessToken || null
  }))));
  api.get('/cost-analysis/expenses', (req, res) => res.json({
    items: costAnalysis.listExpenses(req.query),
    customItems: costAnalysis.listCustomItems()
  }));
  api.post('/cost-analysis/expenses', csrf, asyncRoute(async (req, res) => {
    const input = parse(expenseSchema, req.body || {});
    res.status(201).json(await costAnalysis.createExpense(input, req.auth.actor));
  }));
  api.put('/cost-analysis/expenses/:id', csrf, asyncRoute(async (req, res) => {
    const input = parse(expenseSchema, req.body || {});
    res.json(await costAnalysis.updateExpense(req.params.id, input, req.auth.actor));
  }));
  api.delete('/cost-analysis/expenses/:id', csrf, asyncRoute(async (req, res) => {
    await costAnalysis.deleteExpense(req.params.id);
    res.status(204).end();
  }));
  api.get('/cost-analysis/incomes', (req, res) => res.json({
    items: costAnalysis.listIncomes(req.query),
    customItems: costAnalysis.listIncomeItems()
  }));
  api.post('/cost-analysis/incomes', csrf, asyncRoute(async (req, res) => {
    const input = parse(incomeSchema, req.body || {});
    res.status(201).json(await costAnalysis.createIncome(input, req.auth.actor));
  }));
  api.put('/cost-analysis/incomes/:id', csrf, asyncRoute(async (req, res) => {
    const input = parse(incomeSchema, req.body || {});
    res.json(await costAnalysis.updateIncome(req.params.id, input, req.auth.actor));
  }));
  api.delete('/cost-analysis/incomes/:id', csrf, asyncRoute(async (req, res) => {
    await costAnalysis.deleteIncome(req.params.id);
    res.status(204).end();
  }));
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
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(require.resolve('marked')));
  app.get('/vendor/dompurify.js', (_req, res) => res.sendFile(require.resolve('dompurify').replace(/purify\.cjs\.js$/, 'purify.min.js')));
  app.use(express.static(publicDir, {
    index: false,
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', path.basename(filePath) === 'index.html' ? 'no-store' : 'no-cache');
    }
  }));
  app.get('*splat', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(errorMiddleware);
  return app;
}

module.exports = { createApp, parse };
