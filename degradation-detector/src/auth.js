'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');

function parseCookies(header) {
  const output = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      output[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      output[name] = part.slice(index + 1).trim();
    }
  }
  return output;
}

function jwtExpiresAt(token, fallback) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return fallback;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const value = Number(claims.exp) * 1000;
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'root' || user?.is_admin === true || user?.isAdmin === true;
}

class AuthService {
  constructor(config, sub2api) {
    this.config = config;
    this.sub2api = sub2api;
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }

  sessionId(req) {
    const authorization = String(req.get?.('authorization') || req.headers?.authorization || '');
    if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
    const cookies = parseCookies(req.headers?.cookie);
    return cookies.dd_session || cookies.dd_session_partitioned || null;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  async sso(req, res, accessToken) {
    const token = String(accessToken || '').trim();
    if (!token || token.length > 16384) {
      throw new AppError('AUTH_REQUIRED', '缺少有效的 Sub2API 登录令牌', { status: 401 });
    }
    const user = await this.sub2api.verifyUser(token);
    return this.createSession(req, res, user, token, 'sso');
  }

  demo(req, res, readOnly = false) {
    if (!this.config.demoMode) {
      throw new AppError('NOT_FOUND', '接口不存在', { status: 404 });
    }
    return this.createSession(req, res, {
      id: 'demo-user',
      name: readOnly ? '只读演示用户' : '演示用户',
      email: '',
      role: readOnly ? 'user' : 'admin'
    }, 'demo-access-token', 'demo');
  }

  createSession(req, res, user, upstreamToken, source) {
    const id = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const sessionLimit = Date.now() + this.config.sessionTtlMinutes * 60000;
    const upstreamExpiresAt = source === 'demo'
      ? sessionLimit
      : jwtExpiresAt(upstreamToken, sessionLimit);
    if (upstreamExpiresAt <= Date.now()) {
      throw new AppError('AUTH_EXPIRED', 'Sub2API 登录状态已过期', { status: 401 });
    }
    const session = {
      id,
      csrfToken,
      user,
      upstreamToken,
      upstreamExpiresAt,
      expiresAt: Math.min(sessionLimit, upstreamExpiresAt),
      identityVerifiedAt: Date.now(),
      source
    };
    this.sessions.set(id, session);
    this.setCookie(req, res, session);
    return this.publicSession(session);
  }

  publicSession(session) {
    return {
      user: session.user,
      canOperate: isAdminUser(session.user),
      csrfToken: session.csrfToken,
      sessionToken: session.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
      source: session.source
    };
  }

  async refreshUser(session, maxAgeMs = 60000) {
    if (!session || ['demo', 'test'].includes(session.source)) return session?.user || null;
    const verifiedAt = Number(session.identityVerifiedAt || 0);
    if (maxAgeMs > 0 && Date.now() - verifiedAt < maxAgeMs) return session.user;
    session.user = await this.sub2api.verifyUser(session.upstreamToken);
    session.identityVerifiedAt = Date.now();
    return session.user;
  }

  middleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && req.get('x-test-user')) {
        const role = String(req.get('x-test-role') || 'user');
        req.auth = {
          id: 'test-session',
          csrfToken: 'test-csrf',
          user: {
            id: String(req.get('x-test-user')),
            name: 'Test User',
            role,
            isAdmin: req.get('x-test-admin') === '1'
          },
          upstreamToken: 'test-upstream-token',
          expiresAt: Date.now() + 60000,
          source: 'test'
        };
        return next();
      }
      const id = this.sessionId(req);
      const session = id ? this.sessions.get(id) : null;
      if (!session || session.expiresAt <= Date.now()) {
        if (id) this.sessions.delete(id);
        return next(new AppError('AUTH_REQUIRED', '需要从 Sub2API 打开降智检测页面', { status: 401 }));
      }
      session.expiresAt = Math.min(
        Date.now() + this.config.sessionTtlMinutes * 60000,
        session.upstreamExpiresAt
      );
      req.auth = session;
      return next();
    };
  }

  csrfMiddleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && req.get('x-test-user')) return next();
      if (!secureEqual(req.get('x-csrf-token'), req.auth?.csrfToken)) {
        return next(new AppError('CSRF_INVALID', '页面状态已失效，请刷新后重试', { status: 403 }));
      }
      return next();
    };
  }

  adminMiddleware() {
    return async (req, _res, next) => {
      try {
        await this.refreshUser(req.auth, 0);
        if (!isAdminUser(req.auth?.user)) {
          return next(new AppError(
            'ADMIN_REQUIRED',
            '只有 Sub2API 管理员可以访问配置或执行检测操作',
            { status: 403 }
          ));
        }
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  logout(req, res) {
    const id = this.sessionId(req);
    if (id) this.sessions.delete(id);
    this.clearCookie(req, res);
  }

  setCookie(req, res, session) {
    const secure = Boolean(
      this.config.cookieSecure || req.secure || req.get('x-forwarded-proto') === 'https'
    );
    const maxAge = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
    const encoded = encodeURIComponent(session.id);
    const cookies = [
      `dd_session=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push(
        `dd_session_partitioned=${encoded}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${maxAge}`
      );
    }
    res.setHeader('Set-Cookie', cookies);
  }

  clearCookie(req, res) {
    const secure = Boolean(
      this.config.cookieSecure || req.secure || req.get('x-forwarded-proto') === 'https'
    );
    const cookies = [
      `dd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push('dd_session_partitioned=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0');
    }
    res.setHeader('Set-Cookie', cookies);
  }
}

module.exports = { AuthService, isAdminUser, jwtExpiresAt, parseCookies, secureEqual };
