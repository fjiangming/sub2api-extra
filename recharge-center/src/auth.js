'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const {
  clientBinding,
  clientContext,
  decodeJwtExpiration,
  maskEmail,
  parseCookies,
  safeEqual
} = require('./security');

function isAdmin(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'root' || user?.is_admin === true || user?.isAdmin === true;
}

function sessionTokenFromRequest(req, cookieNames) {
  const authorization = String(req.get?.('authorization') || req.headers?.authorization || '');
  if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
  const cookies = parseCookies(req.headers?.cookie);
  for (const name of cookieNames) {
    if (cookies[name]) return cookies[name];
  }
  return null;
}

function normalizeUser(source) {
  const user = source?.user || source?.profile || source || {};
  const id = Number(user.id ?? user.user_id);
  const balance = Number(user.balance ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0 || !user.email) {
    throw new AppError('SUB2API_USER_INVALID', 'Sub2API 用户信息不完整', { status: 502 });
  }
  if (!Number.isFinite(balance)) {
    throw new AppError('SUB2API_USER_INVALID', 'Sub2API 用户余额无效', { status: 502 });
  }
  if (user.status && user.status !== 'active') {
    throw new AppError('ACCOUNT_DISABLED', '该 Sub2API 账号当前不可用', { status: 403 });
  }
  return {
    id,
    email: String(user.email),
    emailMasked: maskEmail(user.email),
    username: String(user.username || user.name || ''),
    role: isAdmin(user) ? 'admin' : 'user',
    balance
  };
}

class AuthService {
  constructor(config, sub2api) {
    this.config = config;
    this.sub2api = sub2api;
    this.sessions = new Map();
    this.challenges = new Map();
    this.cookieNames = config.cookieSecure
      ? ['__Host-rc_session', '__Host-rc_session_partitioned']
      : ['rc_session'];
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
    this.challenges.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now || challenge.attempts >= 5) this.challenges.delete(id);
    }
  }

  async login(req, res, input) {
    const context = clientContext(req);
    const result = await this.sub2api.login(input, context);
    if (result?.requires_2fa) {
      const challengeId = crypto.randomBytes(24).toString('base64url');
      this.challenges.set(challengeId, {
        tempToken: String(result.temp_token || ''),
        emailMasked: String(result.user_email_masked || maskEmail(input.email)),
        binding: clientBinding(context),
        context,
        attempts: 0,
        expiresAt: Date.now() + 5 * 60000
      });
      if (!result.temp_token) {
        this.challenges.delete(challengeId);
        throw new AppError('SUB2API_2FA_INVALID', 'Sub2API 未返回有效的双因素登录会话', { status: 502 });
      }
      return {
        requires2fa: true,
        challengeId,
        emailMasked: this.challenges.get(challengeId).emailMasked,
        expiresAt: new Date(this.challenges.get(challengeId).expiresAt).toISOString()
      };
    }
    return this.#finishLogin(req, res, result, context, 'credentials');
  }

  async login2fa(req, res, input) {
    const challenge = this.challenges.get(input.challengeId);
    const context = clientContext(req);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      if (challenge) this.challenges.delete(input.challengeId);
      throw new AppError('LOGIN_CHALLENGE_EXPIRED', '双因素登录会话已过期，请重新登录', { status: 410 });
    }
    if (!safeEqual(challenge.binding, clientBinding(context))) {
      this.challenges.delete(input.challengeId);
      throw new AppError('LOGIN_CONTEXT_CHANGED', '登录环境已变化，请重新登录', { status: 401 });
    }
    challenge.attempts += 1;
    try {
      const result = await this.sub2api.login2fa(challenge.tempToken, input.totpCode, challenge.context);
      this.challenges.delete(input.challengeId);
      return this.#finishLogin(req, res, result, challenge.context, 'credentials_2fa');
    } catch (error) {
      if (challenge.attempts >= 5) this.challenges.delete(input.challengeId);
      throw error;
    }
  }

  async sso(req, res, token) {
    const accessToken = String(token || '').trim();
    if (!accessToken || accessToken.length > 16384) {
      throw new AppError('AUTH_TOKEN_INVALID', '需要有效的 Sub2API 登录令牌', { status: 401 });
    }
    const context = clientContext(req);
    const remoteUser = await this.sub2api.getCurrentUser(accessToken, context);
    return this.#createSession(req, res, normalizeUser(remoteUser), accessToken, context, 'sso');
  }

  async refresh(session) {
    if (!session?.upstreamToken || session.expiresAt <= Date.now()) {
      throw new AppError('SUB2API_PAYMENT_SESSION_REQUIRED', '支付会话已失效，请重新进入充值中心', { status: 401 });
    }
    const user = normalizeUser(await this.sub2api.getCurrentUser(session.upstreamToken, session.client));
    if (user.id !== session.user.id) {
      throw new AppError('SUB2API_USER_MISMATCH', 'Sub2API 会话用户发生变化，请重新登录', { status: 401 });
    }
    session.user = user;
    return this.publicSession(session);
  }

  async #finishLogin(req, res, result, context, source) {
    const accessToken = String(result?.access_token || result?.accessToken || result?.token || '');
    if (!accessToken) throw new AppError('SUB2API_TOKEN_MISSING', 'Sub2API 登录响应缺少访问令牌', { status: 502 });
    let remoteUser = result?.user;
    if (!remoteUser) remoteUser = await this.sub2api.getCurrentUser(accessToken, context);
    return this.#createSession(req, res, normalizeUser(remoteUser), accessToken, context, source, result?.expires_in);
  }

  #createSession(req, res, user, accessToken, context, source, expiresIn) {
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const claimedExpiration = decodeJwtExpiration(accessToken);
    const responseExpiration = Number(expiresIn) > 0 ? Date.now() + Number(expiresIn) * 1000 : null;
    const upstreamExpirations = [claimedExpiration, responseExpiration].filter((value) => Number.isFinite(value));
    const upstreamExpiration = upstreamExpirations.length ? Math.min(...upstreamExpirations) : null;
    const configuredExpiration = Date.now() + this.config.sessionTtlMinutes * 60000;
    const expiresAt = upstreamExpiration
      ? Math.min(configuredExpiration, upstreamExpiration)
      : configuredExpiration;
    if (expiresAt <= Date.now()) {
      throw new AppError('SUB2API_TOKEN_EXPIRED', 'Sub2API 登录令牌已过期，请重新登录', { status: 401 });
    }
    const session = {
      user,
      csrfToken,
      source,
      binding: clientBinding(context),
      client: context,
      expiresAt,
      upstreamExpiresAt: upstreamExpiration,
      // Official payment mode needs the user's short-lived token for Sub2API's
      // user-scoped payment API. It remains memory-only and never reaches the browser.
      upstreamToken: user.role === 'admin' || this.config.paymentMode === 'sub2api_official'
        ? accessToken
        : null
    };
    this.sessions.set(sessionId, session);
    this.#setCookies(res, sessionId, expiresAt);
    return this.publicSession(session);
  }

  #setCookies(res, sessionId, expiresAt) {
    const encoded = encodeURIComponent(sessionId);
    const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    const cookies = [];
    if (this.config.cookieSecure) {
      cookies.push(`__Host-rc_session=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
      cookies.push(`__Host-rc_session_partitioned=${encoded}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`);
    } else {
      cookies.push(`rc_session=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    }
    res.setHeader('Set-Cookie', cookies);
  }

  #clearCookies(res) {
    const cookies = this.config.cookieSecure
      ? [
          '__Host-rc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          '__Host-rc_session_partitioned=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0'
        ]
      : ['rc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'];
    res.setHeader('Set-Cookie', cookies);
  }

  middleware() {
    return (req, _res, next) => {
      const sessionId = sessionTokenFromRequest(req, this.cookieNames);
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (!session || session.expiresAt <= Date.now()) {
        if (sessionId) this.sessions.delete(sessionId);
        return next(new AppError('AUTH_REQUIRED', '请先通过 Sub2API 登录', { status: 401 }));
      }
      const currentBinding = clientBinding(clientContext(req));
      if (!safeEqual(session.binding, currentBinding)) {
        this.sessions.delete(sessionId);
        return next(new AppError('SESSION_BINDING_MISMATCH', '登录环境已变化，请重新登录', { status: 401 }));
      }
      req.auth = session;
      req.sessionId = sessionId;
      return next();
    };
  }

  requireAdmin() {
    return (req, _res, next) => {
      if (req.auth?.user?.role !== 'admin' || !req.auth.upstreamToken) {
        return next(new AppError('ADMIN_REQUIRED', '需要 Sub2API 管理员身份', { status: 403 }));
      }
      return next();
    };
  }

  csrfGuard() {
    return (req, _res, next) => {
      const supplied = String(req.get('x-csrf-token') || '');
      if (!supplied || !safeEqual(supplied, req.auth?.csrfToken)) {
        return next(new AppError('CSRF_FAILED', '请求校验失败，请刷新页面后重试', { status: 403 }));
      }
      return next();
    };
  }

  publicSession(session) {
    return {
      user: {
        id: session.user.id,
        username: session.user.username,
        emailMasked: session.user.emailMasked,
        role: session.user.role,
        balance: session.user.balance
      },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      source: session.source
    };
  }

  logout(req, res) {
    if (req.sessionId) this.sessions.delete(req.sessionId);
    this.#clearCookies(res);
  }
}

module.exports = { AuthService, isAdmin, normalizeUser, sessionTokenFromRequest };
