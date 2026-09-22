'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');

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

class AuthService {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  login(username, password) {
    const valid = constantTimeEqual(username, this.config.adminUser) &&
      constantTimeEqual(password, this.config.adminPassword);
    if (!valid) throw new AppError('AUTH_FAILED', '用户名或密码错误', { status: 401 });
    const id = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.config.sessionTtlMinutes * 60000;
    const session = { id, csrfToken, expiresAt, actor: username };
    this.sessions.set(id, session);
    return session;
  }

  logout(req) {
    const id = this.sessionId(req);
    if (id) this.sessions.delete(id);
  }

  sessionId(req) {
    const authorization = String(req.get?.('authorization') || '');
    if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
    return parseCookies(req.headers?.cookie).oc_session || null;
  }

  middleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && req.get('x-test-admin') === '1') {
        req.auth = { actor: 'test-admin', csrfToken: 'test-csrf', expiresAt: Date.now() + 60000 };
        return next();
      }
      const id = this.sessionId(req);
      const session = id ? this.sessions.get(id) : null;
      if (!session || session.expiresAt <= Date.now()) {
        if (id) this.sessions.delete(id);
        return next(new AppError('AUTH_REQUIRED', '需要管理员登录', { status: 401 }));
      }
      session.expiresAt = Date.now() + this.config.sessionTtlMinutes * 60000;
      req.auth = session;
      req.sessionId = id;
      return next();
    };
  }

  csrfMiddleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && req.get('x-test-admin') === '1') return next();
      if (!constantTimeEqual(req.get('x-csrf-token') || '', req.auth?.csrfToken || 'missing')) {
        return next(new AppError('CSRF_INVALID', '页面状态已失效，请刷新后重试', { status: 403 }));
      }
      return next();
    };
  }

  setCookie(res, session) {
    res.cookie('oc_session', session.id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.cookieSecure,
      maxAge: this.config.sessionTtlMinutes * 60000,
      path: '/'
    });
  }

  clearCookie(res) {
    res.clearCookie('oc_session', { httpOnly: true, sameSite: 'strict', secure: this.config.cookieSecure, path: '/' });
  }
}

module.exports = { AuthService, parseCookies, constantTimeEqual };
