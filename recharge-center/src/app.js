'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { AppError, asyncRoute, errorResponse } = require('./errors');
const { clientContext, redactText } = require('./security');

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  turnstileToken: z.string().max(8192).optional(),
  tencentCaptchaTicket: z.string().max(8192).optional(),
  tencentCaptchaRandstr: z.string().max(1024).optional()
});

const login2faSchema = z.object({
  challengeId: z.string().min(20).max(200),
  totpCode: z.string().regex(/^\d{6}$/)
});

const ssoSchema = z.object({ token: z.string().min(16).max(16384).optional() });
const createOrderSchema = z.object({ amount: z.union([z.string(), z.number()]) });
const reportPaymentSchema = z.object({ tradeNo: z.string().min(20).max(100) });
const confirmSchema = z.object({
  paidAmount: z.union([z.string(), z.number()]),
  paidAt: z.string().datetime({ offset: true }),
  tradeNo: z.string().trim().min(6).max(256).regex(/^[A-Za-z0-9_-]+$/),
  acknowledge: z.literal(true)
});
const rejectSchema = z.object({
  reason: z.enum(['trade_not_found', 'amount_mismatch', 'payment_outside_window', 'duplicate_payment', 'payment_reversed', 'other'])
});
const listenerHeartbeatSchema = z.object({
  collectorId: z.string().min(3).max(64),
  version: z.string().trim().min(1).max(80).optional(),
  ready: z.boolean(),
  observedAt: z.string().datetime({ offset: true })
}).strict();
const qrJobClaimSchema = z.object({
  collectorId: z.string().min(3).max(64)
}).strict();
const qrProvisionerHeartbeatSchema = z.object({
  collectorId: z.string().min(3).max(64),
  version: z.string().trim().min(1).max(80).optional(),
  ready: z.boolean(),
  observedAt: z.string().datetime({ offset: true })
}).strict();
const qrJobCompleteSchema = z.object({
  collectorId: z.string().min(3).max(64),
  jobId: z.string().uuid(),
  leaseToken: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  qrUrl: z.string().url().max(512),
  observedAmount: z.union([z.string(), z.number()]),
  observedMemo: z.string().trim().min(1).max(200),
  observedRecipientId: z.string().trim().min(1).max(200),
  generatedAt: z.string().datetime({ offset: true })
}).strict();
const qrJobFailSchema = z.object({
  collectorId: z.string().min(3).max(64),
  jobId: z.string().uuid(),
  leaseToken: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  failureCode: z.enum([
    'login_required',
    'navigation_failed',
    'unexpected_page',
    'field_mismatch',
    'qr_not_generated',
    'adapter_unavailable',
    'other'
  ])
}).strict();
const listenerEventSchema = z.object({
  collectorId: z.string().min(3).max(64),
  eventId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  source: z.enum(['browser', 'phone']),
  evidenceType: z.string().trim().min(1).max(40),
  tradeNo: z.string().min(20).max(100),
  amount: z.union([z.string(), z.number()]),
  paidAt: z.string().datetime({ offset: true }),
  memo: z.string().trim().min(1).max(200),
  recipientId: z.string().trim().min(1).max(200),
  direction: z.string().trim().min(1).max(40),
  status: z.string().trim().min(1).max(40)
}).strict();

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

function requestAuditContext(req) {
  return { requestId: req.id, ip: clientContext(req).ip };
}

function safeRedirectQuery(query) {
  const output = new URLSearchParams();
  for (const key of ['theme', 'lang', 'ui_mode']) {
    const value = String(query[key] || '');
    if (/^[a-zA-Z0-9_-]{1,20}$/.test(value)) output.set(key, value);
  }
  return output.toString();
}

function limiter(limit, code, message) {
  return rateLimit({
    windowMs: 15 * 60000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code, message } }
  });
}

function createApp({
  config, db, auth, orders, qr, officialPayments, listener, qrProvisioning, accountLogPoller
}) {
  const app = express();
  const officialMode = config.paymentMode === 'sub2api_official';
  const personalTransferAutoMode = config.paymentMode === 'personal_transfer_auto';
  const accountLogStaticMode = config.paymentMode === 'personal_accountlog_static';
  const automaticPersonalMode = personalTransferAutoMode || accountLogStaticMode;
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use((req, res, next) => {
    const supplied = String(req.get('x-request-id') || '');
    req.id = /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader('X-Request-ID', req.id);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const started = Date.now();
    if (config.env !== 'test') {
      res.on('finish', () => {
        console.log(JSON.stringify({
          level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
          requestId: req.id,
          method: req.method,
          path: req.path.startsWith('/pay/') ? '/pay/:token' : req.path,
          status: res.statusCode,
          durationMs: Date.now() - started
        }));
      });
    }
    next();
  });

  app.use(helmet({
    frameguard: false,
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'", config.sub2apiOrigin]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use(express.json({
    limit: '16kb',
    strict: true,
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    }
  }));

  app.use((req, _res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !config.publicOrigin ||
        req.path.startsWith('/api/listener/')) return next();
    const origin = String(req.get('origin') || '');
    if (!origin || origin !== config.publicOrigin) {
      return next(new AppError('ORIGIN_REJECTED', '请求来源校验失败', { status: 403 }));
    }
    return next();
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => {
    const dbStatus = db.prepare('SELECT 1 AS ok').get();
    const qrStatus = qr.status();
    const staticQrRequired = config.paymentMode === 'personal_manual' && config.env === 'production';
    const listenerStatus = listener?.status() || { required: false, healthy: true };
    const accountLogStatus = accountLogPoller?.status?.() || { required: false, healthy: true };
    const ready = dbStatus?.ok === 1 && (!staticQrRequired || qrStatus.available) &&
      (!personalTransferAutoMode || (qrStatus.available && listenerStatus.healthy)) &&
      (!accountLogStaticMode || (qrStatus.available && accountLogStatus.healthy));
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database: 'ok',
      paymentMode: config.paymentMode,
      paymentQr: officialMode || automaticPersonalMode ? 'dynamic' : qrStatus.available,
      listener: listenerStatus,
      accountLog: accountLogStatus
    });
  });

  const loginLimiter = limiter(10, 'LOGIN_RATE_LIMITED', '登录尝试过多，请稍后再试');
  const orderLimiter = limiter(20, 'ORDER_RATE_LIMITED', '订单操作过于频繁，请稍后再试');
  const qrLimiter = limiter(60, 'QR_RATE_LIMITED', '二维码读取过于频繁，请稍后再试');
  const relayLimiter = limiter(120, 'PAYMENT_RELAY_RATE_LIMITED', '付款入口访问过于频繁，请稍后再试');
  const reviewLimiter = limiter(30, 'REVIEW_RATE_LIMITED', '审核操作过于频繁，请稍后再试');
  const listenerLimiter = limiter(600, 'LISTENER_RATE_LIMITED', '监听器请求过于频繁');
  const qrProvisionerLimiter = limiter(600, 'QR_PROVISIONER_RATE_LIMITED', '收钱码生成代理请求过于频繁');

  app.get('/pay/:orderNo', relayLimiter, (req, res, next) => {
    try {
      const target = orders.openPaymentRelay(req.params.orderNo, requestAuditContext(req));
      res.set({
        'Cache-Control': 'no-store, max-age=0, private',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer'
      });
      return res.redirect(303, target);
    } catch (error) {
      return next(error);
    }
  });

  const signedDevice = (scope) => (req, _res, next) => {
    try {
      listener?.authenticate(req, scope);
      next();
    } catch (error) {
      next(error);
    }
  };
  const listenerAuthenticated = signedDevice('ledger');
  const qrProvisionerAuthenticated = signedDevice('qr');

  app.post('/api/listener/alipay/heartbeat', listenerLimiter, listenerAuthenticated, (req, res) => {
    const input = parse(listenerHeartbeatSchema, req.body);
    res.set('Cache-Control', 'no-store').json(listener.heartbeat(input));
  });
  app.post('/api/listener/alipay/events', listenerLimiter, listenerAuthenticated, asyncRoute(async (req, res) => {
    const input = parse(listenerEventSchema, req.body);
    listener.assertCollector(input.collectorId);
    const result = await orders.acceptAutomaticPayment(input, requestAuditContext(req));
    res.set('Cache-Control', 'no-store').status(result.status === 'completed' || result.duplicate ? 200 : 202).json(result);
  }));
  app.post('/api/listener/alipay/qr-heartbeat', qrProvisionerLimiter, qrProvisionerAuthenticated, (req, res) => {
    const input = parse(qrProvisionerHeartbeatSchema, req.body);
    res.set('Cache-Control', 'no-store').json(listener.qrHeartbeat(input));
  });
  app.post('/api/listener/alipay/qr-jobs/claim', qrProvisionerLimiter, qrProvisionerAuthenticated, (req, res) => {
    const input = parse(qrJobClaimSchema, req.body);
    listener.assertCollector(input.collectorId);
    orders.expireAwaiting();
    const job = qrProvisioning.claim(input.collectorId, requestAuditContext(req));
    res.set('Cache-Control', 'no-store');
    return job ? res.json(job) : res.status(204).end();
  });
  app.post('/api/listener/alipay/qr-jobs/complete', qrProvisionerLimiter, qrProvisionerAuthenticated, asyncRoute(async (req, res) => {
    const input = parse(qrJobCompleteSchema, req.body);
    listener.assertCollector(input.collectorId);
    res.set('Cache-Control', 'no-store').json(await qrProvisioning.complete(input, requestAuditContext(req)));
  }));
  app.post('/api/listener/alipay/qr-jobs/fail', qrProvisionerLimiter, qrProvisionerAuthenticated, asyncRoute(async (req, res) => {
    const input = parse(qrJobFailSchema, req.body);
    listener.assertCollector(input.collectorId);
    res.set('Cache-Control', 'no-store').json(await qrProvisioning.fail(input, requestAuditContext(req)));
  }));

  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      paymentMode: config.paymentMode,
      automaticConfirmation: officialMode || automaticPersonalMode,
      quickAmounts: config.quickAmounts,
      allowedAmounts: config.allowedAmounts,
      minAmount: config.minAmount,
      maxAmount: config.maxAmount,
      orderTtlMinutes: config.orderTtlMinutes,
      paymentQrAvailable: officialMode || automaticPersonalMode || qr.status().available,
      passwordLoginEnabled: config.passwordLoginEnabled,
      sub2apiUrl: config.sub2apiPublicUrl
    });
  });

  const passwordLoginRequired = (_req, _res, next) => config.passwordLoginEnabled
    ? next()
    : next(new AppError('PASSWORD_LOGIN_DISABLED', '请从 Sub2API 自定义菜单进入充值中心', { status: 403 }));

  app.post('/api/auth/login', passwordLoginRequired, loginLimiter, asyncRoute(async (req, res) => {
    const result = await auth.login(req, res, parse(loginSchema, req.body));
    res.set('Cache-Control', 'no-store').status(result.requires2fa ? 202 : 200).json(result);
  }));
  app.post('/api/auth/login/2fa', passwordLoginRequired, loginLimiter, asyncRoute(async (req, res) => {
    const result = await auth.login2fa(req, res, parse(login2faSchema, req.body));
    res.set('Cache-Control', 'no-store').json(result);
  }));
  app.post('/api/auth/sso', loginLimiter, asyncRoute(async (req, res) => {
    const body = parse(ssoSchema, req.body || {});
    const result = await auth.sso(req, res, bearerToken(req) || body.token);
    res.set('Cache-Control', 'no-store').json(result);
  }));

  // Sub2API custom menu supplies the current access token in the iframe URL.
  // Exchange once, then immediately remove it from browser-visible history.
  app.use(asyncRoute(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || !req.query.token) return next();
    res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
    await auth.sso(req, res, String(req.query.token));
    const query = safeRedirectQuery(req.query);
    return res.redirect(303, `/${query ? `?${query}` : ''}`);
  }));

  const authenticated = auth.middleware();
  const csrf = auth.csrfGuard();
  const admin = auth.requireAdmin();

  app.get('/api/auth/me', authenticated, (req, res) => {
    res.set('Cache-Control', 'no-store').json(auth.publicSession(req.auth));
  });
  app.post('/api/auth/refresh', authenticated, csrf, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await auth.refresh(req.auth));
  }));
  app.post('/api/auth/logout', authenticated, csrf, (req, res) => {
    officialPayments?.releaseSession(req.sessionId);
    auth.logout(req, res);
    res.status(204).end();
  });

  const api = express.Router();
  api.use(authenticated);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0, private');
    next();
  });

  const nonOfficialOnly = (_req, _res, next) => officialMode
    ? next(new AppError('MANUAL_PAYMENT_DISABLED', '官方支付宝模式不使用人工到账审核', { status: 404 }))
    : next();
  const userReportOnly = (_req, _res, next) => config.paymentMode !== 'personal_manual'
    ? next(new AppError('MANUAL_PAYMENT_DISABLED', '当前模式不需要用户提交交易号', { status: 404 }))
    : next();

  api.get('/checkout', asyncRoute(async (req, res) => {
    if (officialMode) return res.json(await officialPayments.checkout(req.auth));
    return res.json({
      paymentMode: config.paymentMode,
      automaticConfirmation: automaticPersonalMode,
      currency: 'CNY',
      minAmount: config.minAmount,
      maxAmount: config.maxAmount,
      quickAmounts: config.quickAmounts,
      balanceRechargeMultiplier: 1,
      rechargeFeeRate: 0
    });
  }));
  api.get('/orders', asyncRoute(async (req, res) => {
    const items = officialMode
      ? await officialPayments.listForUser(req.auth, req.sessionId)
      : orders.listForUser(req.auth.user.id);
    res.json({ items });
  }));
  api.post('/orders', orderLimiter, csrf, asyncRoute(async (req, res) => {
    const input = parse(createOrderSchema, req.body);
    if (personalTransferAutoMode) listener.assertReady();
    if (accountLogStaticMode) accountLogPoller.assertReady();
    const order = officialMode
      ? await officialPayments.create(req.auth, req.sessionId, input.amount)
      : orders.create(req.auth.user, input.amount, requestAuditContext(req));
    res.status(201).json(order);
  }));
  api.get('/orders/:id', asyncRoute(async (req, res) => {
    const order = officialMode
      ? await officialPayments.getForUser(req.auth, req.sessionId, req.params.id)
      : orders.getForUser(req.params.id, req.auth.user.id);
    res.json(order);
  }));
  api.get('/orders/:id/qr', qrLimiter, asyncRoute(async (req, res) => {
    if (officialMode) return officialPayments.sendQr(res, req.auth, req.params.id);
    const payment = automaticPersonalMode
      ? orders.paymentQrData(req.params.id, req.auth.user)
      : (orders.canAccessQr(req.params.id, req.auth.user), null);
    return qr.send(res, payment);
  }));
  api.post('/orders/:id/report-payment', userReportOnly, orderLimiter, csrf, (req, res) => {
    const input = parse(reportPaymentSchema, req.body);
    res.json(orders.reportPayment(req.params.id, req.auth.user, input.tradeNo, requestAuditContext(req)));
  });
  api.post('/orders/:id/cancel', orderLimiter, csrf, asyncRoute(async (req, res) => {
    const order = officialMode
      ? await officialPayments.cancel(req.auth, req.sessionId, req.params.id)
      : orders.cancel(req.params.id, req.auth.user, requestAuditContext(req));
    res.json(order);
  }));

  const adminApi = express.Router();
  adminApi.use(nonOfficialOnly);
  adminApi.use(admin);
  adminApi.get('/orders', (req, res) => res.json(orders.listForAdmin(req.query)));
  adminApi.get('/orders/:id', (req, res) => res.json(orders.getForAdmin(req.params.id)));
  adminApi.post('/orders/:id/confirm', reviewLimiter, csrf, asyncRoute(async (req, res) => {
    const input = parse(confirmSchema, req.body);
    res.json(await orders.confirm(req.params.id, req.auth, input, requestAuditContext(req)));
  }));
  adminApi.post('/orders/:id/retry', reviewLimiter, csrf, asyncRoute(async (req, res) => {
    res.json(await orders.retry(req.params.id, req.auth, requestAuditContext(req)));
  }));
  adminApi.post('/orders/:id/reject', reviewLimiter, csrf, (req, res) => {
    const input = parse(rejectSchema, req.body);
    res.json(orders.reject(req.params.id, req.auth.user, input.reason, requestAuditContext(req)));
  });
  adminApi.get('/stats', (_req, res) => res.json(orders.stats()));
  api.use('/admin', adminApi);
  app.use('/api', api);

  const nodeModules = path.join(config.projectRoot, 'node_modules');
  app.use('/vendor/lucide', express.static(path.join(nodeModules, 'lucide', 'dist', 'umd'), {
    immutable: true,
    maxAge: '7d',
    fallthrough: false
  }));
  app.use(express.static(path.join(config.projectRoot, 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, max-age=0')
  }));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz') return next();
    return res.sendFile(path.join(config.projectRoot, 'public', 'index.html'));
  });

  app.use((req, _res, next) => next(new AppError('NOT_FOUND', '请求的资源不存在', { status: 404 })));
  app.use((error, req, res, _next) => {
    const status = Number(error?.status) || (error?.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500 && config.env !== 'test') {
      console.error(JSON.stringify({
        level: 'error',
        requestId: req.id,
        code: error?.code || 'INTERNAL_ERROR',
        message: redactText(error?.message),
        path: req.path.startsWith('/pay/') ? '/pay/:token' : req.path
      }));
    }
    if (!error.status) error.status = status;
    res.status(status).set('Cache-Control', 'no-store').json(errorResponse(error, req.id));
  });
  return app;
}

module.exports = { createApp, parse, requestAuditContext, safeRedirectQuery };
