const crypto = require('crypto');
const { AppError } = require('./errors');
const { createScryptPasswordHash, verifyScryptPassword } = require('./security/encryption');

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function unwrap(payload) {
  if (payload?.code != null && ![0, 200].includes(Number(payload.code))) {
    throw new AppError('AUTH_FAILED', payload.message || 'Authentication failed', { status: 401 });
  }
  if (payload?.success === false) {
    throw new AppError('AUTH_FAILED', payload.message || 'Authentication failed', { status: 401 });
  }
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
  return Number.isFinite(expiration) ? expiration : Date.now() + fallbackMs;
}

function isAdmin(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'root' || user?.is_admin === true || user?.isAdmin === true;
}

function requestHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  return req.headers?.[String(name).toLowerCase()];
}

function sessionIdFromRequest(req) {
  const authorization = String(requestHeader(req, 'authorization') || '');
  if (authorization.startsWith('Session ')) return authorization.slice(8).trim();
  const cookies = parseCookies(req.headers?.cookie);
  return cookies.pm_session || cookies.pm_session_partitioned || null;
}

class AuthService {
  constructor(config, options = {}) {
    this.config = config;
    this.db = options.db || null;
    this.sessions = new Map();
    const storedCredentials = this.db?.prepare(`
      SELECT password_hash, password_changed_at
      FROM local_admin_credentials
      WHERE id = 1
    `).get() || null;
    this.localAdminPasswordHash = storedCredentials?.password_hash || config.localAdminPasswordHash || '';
    this.localPasswordChangedAt = storedCredentials?.password_changed_at || null;
    this.onAdminToken = typeof options.onAdminToken === 'function' ? options.onAdminToken : () => {};
    this.onAdminTokenCleared = typeof options.onAdminTokenCleared === 'function'
      ? options.onAdminTokenCleared
      : () => {};
    this.cleanup = setInterval(() => this.#cleanup(), 60000);
    this.cleanup.unref?.();
  }

  close() {
    clearInterval(this.cleanup);
  }

  middleware() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && requestHeader(req, 'x-test-admin') === '1') {
        req.auth = { actorId: 'test-admin', actorName: 'Test Admin', csrfToken: 'test-csrf', source: 'test' };
        return next();
      }
      const sessionId = sessionIdFromRequest(req);
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (!session || session.expiresAt <= Date.now()) {
        if (sessionId) this.sessions.delete(sessionId);
        return next(new AppError('AUTH_REQUIRED', 'Administrator login is required', { status: 401 }));
      }
      session.expiresAt = Math.min(
        Date.now() + this.config.sessionTtlMinutes * 60000,
        session.upstreamExpiresAt || Number.POSITIVE_INFINITY
      );
      req.auth = session;
      req.sessionId = sessionId;
      return next();
    };
  }

  mutationGuard() {
    return (req, _res, next) => {
      if (this.config.env === 'test' && requestHeader(req, 'x-test-admin') === '1') return next();
      const token = requestHeader(req, 'x-csrf-token');
      if (!token || token !== req.auth?.csrfToken) {
        return next(new AppError('CSRF_FAILED', 'CSRF token is missing or invalid', { status: 403 }));
      }
      return next();
    };
  }

  requireRecentReauth(maxAgeMinutes = 5) {
    return (req, _res, next) => {
      if (this.config.env === 'test' && requestHeader(req, 'x-test-admin') === '1') return next();
      const validUntil = Number(req.auth?.reauthUntil || 0);
      const maximumUntil = Date.now() + Math.max(1, maxAgeMinutes) * 60000;
      if (validUntil <= Date.now() || validUntil > maximumUntil + 60000) {
        return next(new AppError('REAUTH_REQUIRED', 'Recent administrator authentication is required', {
          status: 403
        }));
      }
      return next();
    };
  }

  async reauth(req, input) {
    if (!req.sessionId || !req.auth) {
      throw new AppError('AUTH_REQUIRED', 'Administrator login is required', { status: 401 });
    }
    if (this.config.authMode === 'local') {
      const username = input.username || input.email || req.auth.actorName;
      const usernameValid = username === this.config.localAdminUsername || req.auth.actorName === username;
      const passwordValid = this.#verifyLocalPassword(input.password);
      if (!usernameValid || !passwordValid) {
        throw new AppError('AUTH_FAILED', 'Invalid administrator credentials', { status: 401 });
      }
    } else if (this.config.authMode === 'sub2api') {
      let accessToken = req.auth.upstreamTokens?.accessToken;
      if (input.password) {
        const login = unwrap(await this.#trustedJson('/api/v1/auth/login', {
          method: 'POST',
          body: {
            email: input.email || input.username,
            password: input.password,
            turnstile_token: input.turnstileToken || ''
          }
        }));
        if (!login?.access_token || !isAdmin(login.user)) {
          throw new AppError('ADMIN_REQUIRED', 'Only a Sub2API administrator may perform this operation', {
            status: 403
          });
        }
        accessToken = login.access_token;
        req.auth.upstreamTokens = {
          accessToken,
          refreshToken: login.refresh_token || null
        };
      } else if (accessToken) {
        await this.#verifyAccessToken(accessToken);
      } else {
        throw new AppError('REAUTH_REQUIRED', 'Sub2API credentials are required to renew this authorization', {
          status: 403
        });
      }
      this.onAdminToken(accessToken, tokenExpiresAt(accessToken));
    } else {
      throw new AppError('AUTH_MODE_INVALID', `Unsupported authentication mode: ${this.config.authMode}`, {
        status: 500
      });
    }
    req.auth.reauthUntil = Date.now() + 5 * 60000;
    return { reauthenticatedUntil: new Date(req.auth.reauthUntil).toISOString() };
  }

  async login(req, res, input) {
    let user;
    let upstreamTokens = {};
    let source = 'local';
    if (this.config.authMode === 'local') {
      const usernameValid = input.username === this.config.localAdminUsername;
      const passwordValid = this.#verifyLocalPassword(input.password);
      if (!usernameValid || !passwordValid) {
        throw new AppError('AUTH_FAILED', 'Invalid administrator credentials', { status: 401 });
      }
      user = { id: 'local-admin', username: input.username, role: 'admin' };
    } else if (this.config.authMode === 'sub2api') {
      const login = unwrap(await this.#trustedJson('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email: input.email || input.username,
          password: input.password,
          turnstile_token: input.turnstileToken || ''
        }
      }));
      if (login?.requires_2fa) {
        throw new AppError('MFA_REQUIRED', 'Complete two-factor login in Sub2API, then reopen Provider Monitor from its custom menu', {
          status: 409
        });
      }
      if (!login?.access_token || !isAdmin(login.user)) {
        throw new AppError('ADMIN_REQUIRED', 'Only a Sub2API administrator may access Provider Monitor', {
          status: 403
        });
      }
      user = login.user;
      upstreamTokens = {
        accessToken: login.access_token,
        refreshToken: login.refresh_token || null
      };
      source = 'credentials';
      this.onAdminToken(login.access_token, Date.now() + Number(login.expires_in || 3600) * 1000);
    } else {
      throw new AppError('AUTH_MODE_INVALID', `Unsupported authentication mode: ${this.config.authMode}`, {
        status: 500
      });
    }

    return this.#createSession(req, res, user, upstreamTokens, source);
  }

  async sso(req, res, token) {
    if (this.config.authMode !== 'sub2api') {
      throw new AppError('SSO_DISABLED', 'Sub2API single sign-on is not enabled', { status: 409 });
    }
    const accessToken = String(token || '').trim();
    if (!accessToken || accessToken.length > 16384) {
      throw new AppError('AUTH_FAILED', 'A valid Sub2API access token is required', { status: 401 });
    }
    const user = await this.#verifyAccessToken(accessToken);
    const expiresAt = tokenExpiresAt(accessToken);
    this.onAdminToken(accessToken, expiresAt);
    return this.#createSession(req, res, user, { accessToken, refreshToken: null }, 'sso', {
      reauthUntil: Date.now() + 5 * 60000
    });
  }

  logout(req, res) {
    const accessToken = req.auth?.upstreamTokens?.accessToken || null;
    if (req.sessionId) this.sessions.delete(req.sessionId);
    this.#reconcileRuntimeAdminToken(accessToken ? [accessToken] : []);
    this.#clearCookies(req, res);
  }

  changeLocalPassword(req, input) {
    if (this.config.authMode !== 'local') {
      throw new AppError('PASSWORD_CHANGE_UNSUPPORTED', 'Password changes are managed by Sub2API in this authentication mode', {
        status: 409
      });
    }
    if (!req.sessionId || !req.auth) {
      throw new AppError('AUTH_REQUIRED', 'Administrator login is required', { status: 401 });
    }

    const currentPassword = String(input?.currentPassword || '');
    const newPassword = String(input?.newPassword || '');
    if (!this.#verifyLocalPassword(currentPassword)) {
      throw new AppError('AUTH_FAILED', 'The current administrator password is incorrect', { status: 401 });
    }
    if (newPassword.length < 12 || newPassword.length > 256) {
      throw new AppError('PASSWORD_POLICY_FAILED', 'The new password must contain 12 to 256 characters', {
        status: 400
      });
    }
    if (this.#verifyLocalPassword(newPassword)) {
      throw new AppError('PASSWORD_UNCHANGED', 'The new password must be different from the current password', {
        status: 400
      });
    }
    if (!this.db) {
      throw new AppError('PASSWORD_STORAGE_UNAVAILABLE', 'Administrator password storage is unavailable', {
        status: 500
      });
    }

    const passwordHash = createScryptPasswordHash(newPassword);
    const changedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO local_admin_credentials(id, password_hash, password_changed_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        password_hash = excluded.password_hash,
        password_changed_at = excluded.password_changed_at
    `).run(passwordHash, changedAt);
    this.localAdminPasswordHash = passwordHash;
    this.localPasswordChangedAt = changedAt;

    let revokedSessions = 0;
    const removedTokens = [];
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === req.sessionId) continue;
      if (session.upstreamTokens?.accessToken) removedTokens.push(session.upstreamTokens.accessToken);
      this.sessions.delete(sessionId);
      revokedSessions += 1;
    }
    if (removedTokens.length > 0) this.#reconcileRuntimeAdminToken(removedTokens);
    req.auth.reauthUntil = Date.now() + 5 * 60000;

    return { changedAt, revokedSessions };
  }

  publicSession(session) {
    return {
      user: {
        id: session.actorId,
        name: session.actorName,
        role: session.role
      },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      reauthenticatedUntil: session.reauthUntil ? new Date(session.reauthUntil).toISOString() : null,
      authentication: {
        mode: this.config.authMode,
        source: session.source || this.config.authMode,
        sub2apiUrl: this.config.sub2apiPublicUrl || null,
        passwordChangeSupported: this.config.authMode === 'local',
        passwordChangedAt: this.localPasswordChangedAt
      }
    };
  }

  #verifyLocalPassword(password) {
    if (this.localAdminPasswordHash) {
      return verifyScryptPassword(password, this.localAdminPasswordHash);
    }
    return Boolean(this.config.localAdminPassword) && password === this.config.localAdminPassword;
  }

  #createSession(req, res, user, upstreamTokens, source, overrides = {}) {
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const upstreamExpiresAt = upstreamTokens?.accessToken ? tokenExpiresAt(upstreamTokens.accessToken) : null;
    const session = {
      actorId: String(user.id ?? user.user_id ?? user.sub),
      actorName: user.username || user.name || user.email || 'Administrator',
      role: user.role || 'admin',
      csrfToken,
      expiresAt: Math.min(
        Date.now() + this.config.sessionTtlMinutes * 60000,
        upstreamExpiresAt || Number.POSITIVE_INFINITY
      ),
      upstreamExpiresAt,
      upstreamTokens,
      source,
      ...overrides
    };
    this.sessions.set(sessionId, session);
    this.#setCookies(req, res, sessionId);
    return { ...this.publicSession(session), sessionToken: sessionId };
  }

  #setCookies(req, res, sessionId) {
    const secure = req.secure || requestHeader(req, 'x-forwarded-proto') === 'https';
    const maxAge = this.config.sessionTtlMinutes * 60;
    const encoded = encodeURIComponent(sessionId);
    const cookies = [
      `pm_session=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push(`pm_session_partitioned=${encoded}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${maxAge}`);
    }
    res.setHeader('Set-Cookie', cookies);
  }

  #clearCookies(req, res) {
    const secure = req.secure || requestHeader(req, 'x-forwarded-proto') === 'https';
    const cookies = [
      `pm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
    ];
    if (secure) {
      cookies.push('pm_session_partitioned=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0');
    }
    res.setHeader('Set-Cookie', cookies);
  }

  #cleanup() {
    const now = Date.now();
    const removedTokens = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        if (session.upstreamTokens?.accessToken) removedTokens.push(session.upstreamTokens.accessToken);
        this.sessions.delete(id);
      }
    }
    if (removedTokens.length > 0) this.#reconcileRuntimeAdminToken(removedTokens);
  }

  #reconcileRuntimeAdminToken(removedTokens) {
    for (const token of removedTokens) this.onAdminTokenCleared(token);
    const replacement = [...this.sessions.values()].reverse().find((session) =>
      session.upstreamTokens?.accessToken && session.expiresAt > Date.now()
    );
    if (replacement) {
      this.onAdminToken(
        replacement.upstreamTokens.accessToken,
        replacement.upstreamExpiresAt || tokenExpiresAt(replacement.upstreamTokens.accessToken)
      );
    }
  }

  async #verifyAccessToken(token) {
    const payload = unwrap(await this.#trustedJson('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
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
      throw new AppError('ADMIN_REQUIRED', 'Only a Sub2API administrator may access Provider Monitor', {
        status: 403
      });
    }
    return user;
  }

  async #trustedJson(endpoint, options = {}) {
    const url = new URL(endpoint, `${this.config.sub2apiBaseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.queryTimeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers || {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new AppError('AUTH_FAILED', payload?.message || `Sub2API returned HTTP ${response.status}`, {
          status: response.status === 403 ? 403 : 401,
          details: { remoteStatus: response.status }
        });
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('AUTH_UPSTREAM_TIMEOUT', 'Sub2API authentication timed out', { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  AuthService,
  parseCookies,
  isAdmin,
  decodeJwtClaims,
  sessionIdFromRequest,
  tokenExpiresAt
};
