'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { publicIdentity } = require('./identity');

function tokenExpiry(token, fallback) {
  try {
    const expiry = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp) * 1000;
    return Number.isFinite(expiry) && expiry > 0 ? expiry : fallback;
  } catch { return fallback; }
}

function requestContext(req) {
  return { ip: String(req.ip || '').replace(/^::ffff:/, ''), userAgent: String(req.get('user-agent') || '').slice(0, 1024) };
}

class AuthService {
  constructor(config, client, { now = Date.now } = {}) {
    this.config = config;
    this.client = client;
    this.now = now;
    this.sessions = new Map();
    this.activeVerifications = 0;
    this.cookieName = config.cookieSecure ? '__Host-ul_session' : 'ul_session';
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
  }

  cleanup() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }

  sessionId(req) {
    const authorization = String(req.get('authorization') || '');
    if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
    for (const part of String(req.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      const name = part.slice(0, index).trim();
      if ([this.cookieName, `${this.cookieName}_partitioned`].includes(name)) return part.slice(index + 1).trim();
    }
    return null;
  }

  async verify(token, context) {
    if (this.activeVerifications >= 8) throw new AppError('SERVICE_BUSY', '访问人数较多，请稍后重试', 503);
    this.activeVerifications++;
    try { return await this.client.me(token, context); }
    finally { this.activeVerifications--; }
  }

  async sso(req, res, token) {
    if (!token || token.length > 16384 || /[\s\u0000-\u001f]/.test(token)) throw new AppError('AUTH_FAILED', '需要有效的登录状态', 401);
    this.cleanup();
    const oldId = this.sessionId(req);
    if (this.sessions.size >= this.config.maxSessions && !this.sessions.has(oldId)) {
      throw new AppError('SESSION_CAPACITY', '当前在线人数较多，请稍后重试', 503);
    }
    const context = requestContext(req);
    const user = await this.verify(token, context);
    const expiresAt = Math.min(this.now() + this.config.sessionTtlMs, tokenExpiry(token, this.now() + this.config.sessionTtlMs));
    if (expiresAt <= this.now()) throw new AppError('AUTH_FAILED', '登录状态已过期', 401);
    // Recheck after the upstream call: concurrent logins must not exceed the cap.
    this.cleanup();
    if (this.sessions.size >= this.config.maxSessions && !this.sessions.has(oldId)) {
      throw new AppError('SESSION_CAPACITY', '当前在线人数较多，请稍后重试', 503);
    }
    if (oldId) this.sessions.delete(oldId);
    const session = {
      id: crypto.randomBytes(32).toString('base64url'), user, token, context, expiresAt,
      verifiedAt: this.now(), verification: null
    };
    this.sessions.set(session.id, session);
    const age = Math.max(1, Math.floor((expiresAt - this.now()) / 1000));
    const cookie = `${this.cookieName}=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.config.cookieSecure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', this.config.cookieSecure ? [cookie,
      `${this.cookieName}_partitioned=${session.id}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${age}`] : cookie);
    return this.publicSession(session);
  }

  publicSession(session) {
    return { user: publicIdentity(session.user.id, session.user.email),
      sessionToken: session.id, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  middleware() {
    return async (req, _res, next) => {
      try {
        const id = this.sessionId(req);
        const session = id && this.sessions.get(id);
        if (!session || session.expiresAt <= this.now()) {
          if (id) this.sessions.delete(id);
          throw new AppError('AUTH_REQUIRED', '请登录后查看用量排行', 401);
        }
        if (session.context.userAgent !== requestContext(req).userAgent) throw new AppError('AUTH_REQUIRED', '登录环境已变化，请重新从主站打开排行', 401);
        if (this.now() - session.verifiedAt >= 60000) {
          if (!session.verification) {
            session.verification = this.verify(session.token, requestContext(req)).then((user) => {
              if (user.id !== session.user.id) throw new AppError('AUTH_REQUIRED', '登录身份已变化', 401);
              session.user = user;
              session.verifiedAt = this.now();
            }).catch((error) => {
              if ([401, 403].includes(error.status)) this.sessions.delete(id);
              throw error;
            }).finally(() => { session.verification = null; });
          }
          await session.verification;
        }
        if (session.expiresAt <= this.now() || !this.sessions.has(id)) throw new AppError('AUTH_REQUIRED', '登录状态已过期', 401);
        req.auth = session;
        next();
      } catch (error) { next(error); }
    };
  }

  logout(req, res) {
    this.sessions.delete(this.sessionId(req));
    const cookie = `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.cookieSecure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', this.config.cookieSecure ? [cookie,
      `${this.cookieName}_partitioned=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0`] : cookie);
  }

  close() { clearInterval(this.timer); this.sessions.clear(); }
}

module.exports = { AuthService, tokenExpiry };
