'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');

function authFailure(payload, remoteStatus = 401) {
  const remoteCode = String(payload?.code || payload?.error?.code || '');
  if (remoteCode === 'SESSION_BINDING_MISMATCH') {
    return new AppError(
      'SUB2API_SESSION_BINDING_INCOMPATIBLE',
      'Sub2API 已开启会话绑定，运营中心服务端无法校验该浏览器登录状态',
      { status: 409, details: { remoteCode, remoteStatus } }
    );
  }
  return new AppError('AUTH_FAILED', payload?.message || payload?.error?.message || '管理员认证失败', {
    status: remoteStatus === 403 ? 403 : 401,
    details: { remoteCode: remoteCode || null, remoteStatus }
  });
}

function parseCookies(header) {
  const result = {};
  for (const fragment of String(header || '').split(';')) {
    const index = fragment.indexOf('=');
    if (index <= 0) continue;
    const key = fragment.slice(0, index).trim();
    const raw = fragment.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function unwrap(payload) {
  if (payload?.code != null && ![0, 200].includes(Number(payload.code))) throw authFailure(payload);
  if (payload?.success === false) throw authFailure(payload);
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

function decodeJwtClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return {};
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function tokenExpiresAt(token, fallbackMs = 15 * 60000) {
  const expiration = Number(decodeJwtClaims(token).exp) * 1000;
  return Number.isFinite(expiration) && expiration > 0 ? expiration : Date.now() + fallbackMs;
}

function isAdmin(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'root' || user?.is_admin === true || user?.isAdmin === true;
}

function requestHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  return req.headers?.[String(name).toLowerCase()];
}

class AuthService {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.sessions = new Map();
    this.onAdminToken = typeof options.onAdminToken === 'function' ? options.onAdminToken : () => {};
    this.onAdminTokenCleared = typeof options.onAdminTokenCleared === 'function'
      ? options.onAdminTokenCleared
      : () => {};
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    const tokens = [...this.sessions.values()]
      .map((session) => session.upstreamAccessToken)
      .filter(Boolean);
    this.sessions.clear();
    for (const token of tokens) this.onAdminTokenCleared(token);
  }

  cleanup() {
    const now = Date.now();
    const removedTokens = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      if (session.upstreamAccessToken) removedTokens.push(session.upstreamAccessToken);
      this.sessions.delete(id);
    }
    if (removedTokens.length > 0) this.reconcileRuntimeAdminToken(removedTokens);
  }

  async login(req, res, input) {
    const identity = String(input.username || input.email || '').trim();
    const password = String(input.password || '');
    if (this.config.authMode === 'local') {
      const valid = constantTimeEqual(identity, this.config.adminUser) &&
        constantTimeEqual(password, this.config.adminPassword);
      if (!valid) throw new AppError('AUTH_FAILED', '用户名或密码错误', { status: 401 });
      return this.createSession(req, res, {
        id: 'local-admin', username: identity, role: 'admin'
      }, null, 'local');
    }
    if (this.config.authMode !== 'sub2api') {
      throw new AppError('AUTH_MODE_INVALID', '运营中心认证模式无效', { status: 500 });
    }

    const login = unwrap(await this.trustedJson('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: identity,
        password,
        turnstile_token: input.turnstileToken || ''
      }
    }));
    if (login?.requires_2fa || login?.requires2fa) {
      throw new AppError(
        'MFA_REQUIRED',
        '请先在 Sub2API 完成双因素登录，再从管理员自定义菜单打开运营中心',
        { status: 409 }
      );
    }
    const accessToken = login?.access_token || login?.accessToken || login?.token;
    if (!accessToken || !isAdmin(login?.user)) {
      throw new AppError('ADMIN_REQUIRED', '只有 Sub2API 管理员可以访问运营中心', { status: 403 });
    }
    const expiresAt = tokenExpiresAt(accessToken, Number(login.expires_in || 900) * 1000);
    this.onAdminToken(accessToken, expiresAt);
    return this.createSession(req, res, login.user, accessToken, 'credentials');
  }

  async sso(req, res, token) {
    if (this.config.authMode !== 'sub2api') {
      throw new AppError('SSO_DISABLED', '当前部署未启用 Sub2API 单点登录', { status: 409 });
    }
    const accessToken = String(token || '').trim();
    if (!accessToken || accessToken.length > 16384) {
      throw new AppError('AUTH_FAILED', '缺少有效的 Sub2API 登录令牌', { status: 401 });
    }
    const user = await this.verifyAccessToken(accessToken);
    const expiresAt = tokenExpiresAt(accessToken);
    if (expiresAt <= Date.now()) throw new AppError('AUTH_FAILED', 'Sub2API 登录状态已过期', { status: 401 });
    this.onAdminToken(accessToken, expiresAt);
    return this.createSession(req, res, user, accessToken, 'sso');
  }

  logout(req, res) {
    const id = this.sessionId(req);
    const session = id ? this.sessions.get(id) : null;
    if (id) this.sessions.delete(id);
    this.reconcileRuntimeAdminToken(session?.upstreamAccessToken ? [session.upstreamAccessToken] : []);
    this.clearCookie(req, res);
  }

  sessionId(req) {
    const authorization = String(requestHeader(req, 'authorization') || '');
    if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
    const cookies = parseCookies(req.headers?.cookie);
    return cookies.oc_session || cookies.oc_session_partitioned || null;
  }

  middleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && requestHeader(req, 'x-test-admin') === '1') {
        req.auth = { actor: 'test-admin', csrfToken: 'test-csrf', expiresAt: Date.now() + 60000 };
        return next();
      }
      const id = this.sessionId(req);
      const session = id ? this.sessions.get(id) : null;
      if (!session || session.expiresAt <= Date.now()) {
        if (id) {
          this.sessions.delete(id);
          if (session?.upstreamAccessToken) this.reconcileRuntimeAdminToken([session.upstreamAccessToken]);
        }
        return next(new AppError('AUTH_REQUIRED', '需要管理员登录', { status: 401 }));
      }
      session.expiresAt = Math.min(
        Date.now() + this.config.sessionTtlMinutes * 60000,
        session.upstreamExpiresAt || Number.POSITIVE_INFINITY
      );
      req.auth = session;
      req.sessionId = id;
      return next();
    };
  }

  csrfMiddleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && requestHeader(req, 'x-test-admin') === '1') return next();
      if (!constantTimeEqual(requestHeader(req, 'x-csrf-token') || '', req.auth?.csrfToken || 'missing')) {
        return next(new AppError('CSRF_INVALID', '页面状态已失效，请刷新后重试', { status: 403 }));
      }
      return next();
    };
  }

  publicSession(session) {
    return {
      user: { id: session.actorId, name: session.actor, role: session.role },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      sessionToken: session.id,
      authentication: {
        mode: this.config.authMode,
        source: session.source,
        sub2apiUrl: this.config.sub2apiPublicUrl || null
      }
    };
  }

  createSession(req, res, user, upstreamAccessToken, source) {
    const id = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const upstreamExpiresAt = upstreamAccessToken ? tokenExpiresAt(upstreamAccessToken) : null;
    const expiresAt = Math.min(
      Date.now() + this.config.sessionTtlMinutes * 60000,
      upstreamExpiresAt || Number.POSITIVE_INFINITY
    );
    const session = {
      id,
      csrfToken,
      expiresAt,
      actorId: String(user?.id ?? user?.user_id ?? user?.sub ?? 'administrator'),
      actor: user?.username || user?.name || user?.email || '管理员',
      role: user?.role || 'admin',
      source,
      upstreamAccessToken,
      upstreamExpiresAt
    };
    this.sessions.set(id, session);
    this.setCookie(req, res, session);
    return this.publicSession(session);
  }

  setCookie(req, res, session) {
    const secure = Boolean(
      this.config.cookieSecure || req.secure || requestHeader(req, 'x-forwarded-proto') === 'https'
    );
    const maxAge = this.config.sessionTtlMinutes * 60;
    const encoded = encodeURIComponent(session.id);
    const cookies = [
      `oc_session=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push(
        `oc_session_partitioned=${encoded}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${maxAge}`
      );
    }
    res.setHeader('Set-Cookie', cookies);
  }

  clearCookie(req, res) {
    const secure = Boolean(
      this.config.cookieSecure || req.secure || requestHeader(req, 'x-forwarded-proto') === 'https'
    );
    const cookies = [
      `oc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push('oc_session_partitioned=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0');
    }
    res.setHeader('Set-Cookie', cookies);
  }

  reconcileRuntimeAdminToken(removedTokens) {
    for (const token of removedTokens) this.onAdminTokenCleared(token);
    const replacement = [...this.sessions.values()].reverse().find((session) =>
      session.upstreamAccessToken && session.expiresAt > Date.now()
    );
    if (replacement) {
      this.onAdminToken(replacement.upstreamAccessToken, replacement.upstreamExpiresAt);
    }
  }

  async verifyAccessToken(token) {
    const payload = unwrap(await this.trustedJson('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` }
    }));
    const remoteUser = payload?.user || payload?.profile || payload || {};
    const claims = decodeJwtClaims(token);
    const user = {
      id: remoteUser.id ?? remoteUser.user_id ?? claims.user_id ?? claims.sub ?? claims.id,
      username: remoteUser.username || remoteUser.name || claims.username || claims.name,
      email: remoteUser.email || claims.email,
      role: remoteUser.role || claims.role,
      is_admin: remoteUser.is_admin ?? claims.is_admin,
      isAdmin: remoteUser.isAdmin ?? claims.isAdmin
    };
    if (!user.id || !isAdmin(user)) {
      throw new AppError('ADMIN_REQUIRED', '只有 Sub2API 管理员可以访问运营中心', { status: 403 });
    }
    return user;
  }

  async trustedJson(endpoint, options = {}) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_URL_NOT_CONFIGURED', '未配置 SUB2API_BASE_URL', { status: 503 });
    }
    const url = new URL(endpoint, `${this.config.sub2apiBaseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.sub2apiRequestTimeoutMs || 15000);
    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body == null ? {} : { 'content-type': 'application/json' }),
          ...(options.headers || {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw authFailure(payload || { message: `Sub2API 返回 ${response.status}` }, response.status);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('AUTH_UPSTREAM_TIMEOUT', '连接 Sub2API 认证服务超时', { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  AuthService,
  authFailure,
  constantTimeEqual,
  decodeJwtClaims,
  isAdmin,
  parseCookies,
  tokenExpiresAt,
  unwrap
};
