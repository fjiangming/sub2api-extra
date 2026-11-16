'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');

const context = req => ({ ip: String(req.ip || '').replace(/^::ffff:/, ''), userAgent: String(req.get('user-agent') || '').slice(0, 1024) });
function expiry(token, fallback) {
  try { const time = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp) * 1000; return Number.isFinite(time) && time > 0 ? time : fallback; }
  catch { return fallback; }
}
function sameOrigin(req, config) {
  if (req.get('origin') !== config.publicUrl) throw new AppError('ORIGIN_INVALID', '请求来源无效，请刷新页面', 403);
}

class AuthService {
  constructor(config, client, now = Date.now) {
    Object.assign(this, { config, client, now, sessions: new Map(), verifications: 0 });
    this.cookie = config.cookieSecure ? '__Host-ac_session' : 'ac_session';
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
  }
  cleanup() { for (const [id, s] of this.sessions) if (s.expiresAt <= this.now()) this.sessions.delete(id); }
  id(req) {
    const authorization = String(req.get('authorization') || '');
    if (authorization.startsWith('Session ')) return authorization.slice(8);
    for (const entry of String(req.headers.cookie || '').split(';')) {
      const [key, value] = entry.trim().split('=');
      if ([this.cookie, `${this.cookie}_partitioned`].includes(key)) return value;
    }
    return null;
  }
  cookies(res, session) {
    const age = session ? Math.max(1, Math.floor((session.expiresAt - this.now()) / 1000)) : 0;
    const head = `${session?.id || ''}; Path=/; HttpOnly; Max-Age=${age}`;
    res.setHeader('Set-Cookie', this.config.cookieSecure ? [
      `${this.cookie}=${head}; SameSite=Lax; Secure`, `${this.cookie}_partitioned=${head}; SameSite=None; Secure; Partitioned`
    ] : `${this.cookie}=${head}; SameSite=Lax`);
  }
  publicSession(s) { return { user: { ...s.user }, csrfToken: s.csrf, sessionToken: s.id, expiresAt: new Date(s.expiresAt).toISOString() }; }
  async verify(token, req) {
    if (this.verifications >= 8) throw new AppError('SERVICE_BUSY', '当前访问人数较多，请稍后重试', 503);
    this.verifications++;
    try { return await this.client.me(token, context(req)); } finally { this.verifications--; }
  }
  async sso(req, res, token) {
    sameOrigin(req, this.config);
    if (!token || token.length > 16384 || /[\s\u0000-\u001f]/.test(token)) throw new AppError('AUTH_REQUIRED', '请从主站打开活动中心', 401);
    this.cleanup();
    if (this.sessions.size >= this.config.maxSessions) throw new AppError('SERVICE_BUSY', '当前在线人数较多，请稍后重试', 503);
    const user = await this.verify(token, req);
    this.cleanup();
    if (this.sessions.size >= this.config.maxSessions) throw new AppError('SERVICE_BUSY', '当前在线人数较多，请稍后重试', 503);
    const expiresAt = Math.min(this.now() + this.config.sessionTtlMs, expiry(token, Infinity));
    if (expiresAt <= this.now()) throw new AppError('AUTH_REQUIRED', '登录已过期', 401);
    const session = { id: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url'),
      user, token, expiresAt, verifiedAt: this.now(), context: context(req) };
    this.sessions.delete(this.id(req));
    this.sessions.set(session.id, session);
    this.cookies(res, session);
    return this.publicSession(session);
  }
  active(s) {
    if (this.sessions.get(s.id) !== s || s.expiresAt <= this.now()) throw new AppError('AUTH_REQUIRED', '登录已过期，请重新从主站打开', 401);
  }
  async refresh(s, req) {
    this.active(s);
    if (!s.refreshing) {
      s.refreshing = this.verify(s.token, req).then(user => {
        this.active(s);
        if (user.id !== s.user.id) throw new AppError('AUTH_REQUIRED', '登录身份已变化', 401);
        s.user = user;
        s.verifiedAt = this.now();
      }).catch(error => { if ([401, 403].includes(error.status)) this.sessions.delete(s.id); throw error; }).finally(() => { s.refreshing = null; });
    }
    await s.refreshing;
    this.active(s);
  }
  middleware() {
    return async (req, _res, next) => {
      try {
        const s = this.sessions.get(this.id(req));
        if (!s) throw new AppError('AUTH_REQUIRED', '请登录主站后打开活动中心', 401);
        this.active(s);
        if (s.context.userAgent !== context(req).userAgent) throw new AppError('AUTH_REQUIRED', '登录环境已变化', 401);
        if (this.now() - s.verifiedAt >= 60000 || !['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/admin')) await this.refresh(s, req);
        req.auth = s;
        next();
      } catch (error) { next(error); }
    };
  }
  mutation() {
    return (req, _res, next) => {
      try {
        sameOrigin(req, this.config);
        const actual = Buffer.from(String(req.get('x-csrf-token') || ''));
        const expected = Buffer.from(req.auth.csrf);
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new AppError('CSRF_INVALID', '页面已失效，请重新加载', 403);
        next();
      } catch (error) { next(error); }
    };
  }
  admin(req, _res, next) { next(req.auth.user.role === 'admin' ? undefined : new AppError('ADMIN_REQUIRED', '仅管理员可以查看奖励账本', 403)); }
  logout(req, res) { this.sessions.delete(this.id(req)); this.cookies(res, null); }
  close() { clearInterval(this.timer); this.sessions.clear(); }
}

module.exports = { AuthService, expiry };
