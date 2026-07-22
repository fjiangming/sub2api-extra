const { AppError } = require('../errors');

function remoteErrorCode(payload) {
  const candidates = [payload?.reason, payload?.error?.code, payload?.code];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value && !/^\d+$/.test(value)) return value;
  }
  return null;
}

function remoteErrorMessage(payload, fallback) {
  return payload?.message || payload?.error?.message || fallback;
}

function tokenExpiration(token, fallbackMs = 15 * 60000) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return Date.now() + fallbackMs;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expiresAt = Number(payload.exp) * 1000;
    return Number.isFinite(expiresAt) ? expiresAt : Date.now() + fallbackMs;
  } catch {
    return Date.now() + fallbackMs;
  }
}

function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'root' || user?.is_admin === true || user?.isAdmin === true;
}

function unwrapSub2Api(payload) {
  if (payload?.code != null && Number(payload.code) !== 0 && Number(payload.code) !== 200) {
    throw new AppError('SUB2API_REQUEST_FAILED', remoteErrorMessage(payload, 'Sub2API rejected the request'), {
      status: Number(payload.code) === 401 ? 401 : 502,
      details: { remoteCode: remoteErrorCode(payload) }
    });
  }
  if (payload?.success === false) {
    throw new AppError('SUB2API_REQUEST_FAILED', remoteErrorMessage(payload, 'Sub2API rejected the request'), {
      status: 502,
      details: { remoteCode: remoteErrorCode(payload) }
    });
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

class Sub2ApiAdminClient {
  constructor(config) {
    this.config = config;
    this.cachedToken = null;
    this.runtimeToken = null;
    this.pendingLogin = null;
    this.pendingStepUpToken = null;
    this.tokenPromise = null;
    this.configuredTokenRejected = false;
  }

  setRuntimeToken(token, expiresAt = null) {
    const value = String(token || '').trim();
    if (!value) return;
    this.runtimeToken = {
      value,
      expiresAt: Number(expiresAt) || tokenExpiration(value),
      source: 'sso_session'
    };
  }

  clearRuntimeToken(token = null) {
    if (!token || this.runtimeToken?.value === token) this.runtimeToken = null;
    if (!token || this.pendingStepUpToken?.value === token) this.pendingStepUpToken = null;
  }

  authenticationStatus() {
    if (this.runtimeToken?.expiresAt > Date.now() + 1000) {
      return {
        available: true,
        source: this.runtimeToken.source,
        expiresAt: new Date(this.runtimeToken.expiresAt).toISOString()
      };
    }
    if (this.config.sub2apiAdminToken && !this.configuredTokenRejected) {
      return { available: true, source: 'configured_token' };
    }
    if (this.cachedToken?.expiresAt > Date.now() + 1000) {
      return { available: true, source: 'configured_credentials' };
    }
    if (this.pendingLogin?.expiresAt > Date.now()) {
      return {
        available: false,
        source: 'configured_credentials',
        error: 'two_factor_required',
        requiresTwoFactor: true
      };
    }
    if (this.cachedToken?.refreshToken) return { available: true, source: 'configured_credentials' };
    if (this.config.adminEmail && this.config.adminPassword) return { available: true, source: 'configured_credentials' };
    if (this.configuredTokenRejected) return { available: false, source: 'configured_token', error: 'invalid' };
    return { available: false, source: 'missing' };
  }

  async adminToken(force = false) {
    if (!force && this.runtimeToken?.expiresAt > Date.now() + 1000) return this.runtimeToken.value;
    if (this.runtimeToken?.expiresAt <= Date.now() + 1000) this.runtimeToken = null;
    if (!force && this.config.sub2apiAdminToken && !this.configuredTokenRejected) {
      return this.config.sub2apiAdminToken;
    }
    if (!force && this.cachedToken?.expiresAt > Date.now() + 60000) return this.cachedToken.value;
    if (this.pendingLogin?.expiresAt > Date.now()) throw this.#loginTwoFactorRequired();
    if (this.pendingLogin) this.pendingLogin = null;
    if (!this.cachedToken?.refreshToken && (!this.config.adminEmail || !this.config.adminPassword)) {
      throw new AppError(
        'SUB2API_ADMIN_CREDENTIALS_REQUIRED',
        'An active Sub2API administrator SSO session, SUB2API_ADMIN_TOKEN, or ADMIN_EMAIL/ADMIN_PASSWORD is required for Sub2API integration',
        { status: 409 }
      );
    }
    if (this.tokenPromise) return this.tokenPromise;
    const operation = this.#configuredSessionToken();
    this.tokenPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.tokenPromise === operation) this.tokenPromise = null;
    }
  }

  #loginTwoFactorRequired() {
    return new AppError(
      'SUB2API_LOGIN_2FA_REQUIRED',
      'Sub2API requires a TOTP code to complete the configured administrator login',
      { status: 403, details: { purpose: 'login' } }
    );
  }

  #cacheTokenPair(data, { requireAdmin = false } = {}) {
    if (!data?.access_token) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API authentication did not return an access token', {
        status: 502
      });
    }
    if (requireAdmin && !isAdminUser(data.user)) {
      throw new AppError('SUB2API_ADMIN_REQUIRED', 'Sub2API administrator authentication failed', {
        status: 403
      });
    }
    this.cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      refreshToken: data.refresh_token || this.cachedToken?.refreshToken || null
    };
    this.pendingLogin = null;
    return this.cachedToken.value;
  }

  async #configuredSessionToken() {
    if (this.cachedToken?.refreshToken) {
      try {
        const refreshed = unwrapSub2Api(await this.request('/api/v1/auth/refresh', {
          method: 'POST',
          body: { refresh_token: this.cachedToken.refreshToken },
          authenticated: false
        }));
        return this.#cacheTokenPair(refreshed);
      } catch (error) {
        if (Number(error?.status) >= 500 || error?.retryable) throw error;
        this.cachedToken = null;
      }
    }

    if (!this.config.adminEmail || !this.config.adminPassword) {
      throw new AppError(
        'SUB2API_ADMIN_CREDENTIALS_REQUIRED',
        'ADMIN_EMAIL and ADMIN_PASSWORD are required to establish a Sub2API administrator session',
        { status: 409 }
      );
    }
    const login = unwrapSub2Api(await this.request('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: this.config.adminEmail,
        password: this.config.adminPassword,
        turnstile_token: ''
      },
      authenticated: false
    }));
    if (login?.requires_2fa) {
      if (!login.temp_token) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API 2FA login did not return a temporary token', {
          status: 502
        });
      }
      this.pendingLogin = {
        tempToken: login.temp_token,
        expiresAt: Date.now() + 5 * 60000
      };
      throw this.#loginTwoFactorRequired();
    }
    return this.#cacheTokenPair(login, { requireAdmin: true });
  }

  async request(endpoint, options = {}) {
    const url = new URL(endpoint, `${this.config.sub2apiBaseUrl}/`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const authenticated = options.authenticated !== false;
    const explicitAccessToken = String(options.accessToken || '').trim() || null;
    const token = authenticated
      ? explicitAccessToken || await this.adminToken(Boolean(options.forceTokenRefresh))
      : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.config.queryTimeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > this.config.maxResponseBytes * 4) {
        throw new AppError('RESPONSE_TOO_LARGE', 'Sub2API response exceeded the configured size limit', {
          status: 502
        });
      }
      const payload = text ? JSON.parse(text) : null;
      if (remoteErrorCode(payload) === 'STEP_UP_REQUIRED' && token) {
        this.pendingStepUpToken = {
          value: token,
          expiresAt: tokenExpiration(token)
        };
      }
      if (!response.ok) {
        if (response.status === 401 && token && this.runtimeToken?.value === token) {
          this.clearRuntimeToken(token);
        }
        if (response.status === 401 && token && token === this.config.sub2apiAdminToken) {
          this.configuredTokenRejected = true;
        }
        if (response.status === 401 && token && this.cachedToken?.value === token) {
          this.cachedToken = {
            ...this.cachedToken,
            value: null,
            expiresAt: 0
          };
        }
        if (response.status === 401 && authenticated && !explicitAccessToken && !options.forceTokenRefresh) {
          if (this.cachedToken?.refreshToken || (this.config.adminEmail && this.config.adminPassword)) {
            return this.request(endpoint, { ...options, forceTokenRefresh: true });
          }
        }
        throw new AppError('SUB2API_REQUEST_FAILED', remoteErrorMessage(payload, `Sub2API returned HTTP ${response.status}`), {
          status: response.status >= 500 ? 502 : response.status,
          retryable: response.status === 429 || response.status >= 500,
          details: {
            remoteStatus: response.status,
            remoteCode: remoteErrorCode(payload)
          }
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API returned invalid JSON', { status: 502 });
      }
      if (error?.name === 'AbortError') {
        throw new AppError('TIMEOUT', 'Sub2API request timed out', { status: 504, retryable: true });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async data(endpoint, options = {}) {
    return unwrapSub2Api(await this.request(endpoint, options));
  }

  async verifyStepUp(accessToken, code) {
    const explicitToken = String(accessToken || '').trim();
    if (!explicitToken && this.pendingLogin?.expiresAt > Date.now()) {
      try {
        const login = await this.data('/api/v1/auth/login/2fa', {
          method: 'POST',
          body: {
            temp_token: this.pendingLogin.tempToken,
            totp_code: code
          },
          authenticated: false
        });
        this.#cacheTokenPair(login, { requireAdmin: true });
        return {
          verified: true,
          expiresIn: Number(login.expires_in) || 0
        };
      } catch (error) {
        throw this.#translateTwoFactorError(error);
      }
    }
    if (this.pendingLogin) this.pendingLogin = null;
    const pendingToken = this.pendingStepUpToken?.expiresAt > Date.now()
      ? this.pendingStepUpToken.value
      : null;
    const token = explicitToken || pendingToken || await this.adminToken();
    try {
      const result = await this.data('/api/v1/user/totp/step-up', {
        method: 'POST',
        body: { code },
        accessToken: token
      });
      if (result?.verified !== true) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API returned an invalid step-up response', {
          status: 502
        });
      }
      this.pendingStepUpToken = null;
      return {
        verified: true,
        expiresIn: Number(result.expires_in) || 0
      };
    } catch (error) {
      throw this.#translateTwoFactorError(error);
    }
  }

  #translateTwoFactorError(error) {
    const remoteCode = String(error?.details?.remoteCode || '');
    const details = {
      remoteCode: remoteCode || null,
      remoteStatus: Number(error?.details?.remoteStatus || error?.status) || null
    };
    if (remoteCode === 'TOTP_INVALID_CODE') {
      return new AppError('SUB2API_TOTP_INVALID_CODE', 'The TOTP code is invalid or expired', {
        status: 400,
        details
      });
    }
    if (remoteCode === 'TOTP_TOO_MANY_ATTEMPTS') {
      return new AppError('SUB2API_TOTP_RATE_LIMITED', 'Too many TOTP attempts; try again later', {
        status: 429,
        retryable: true,
        details
      });
    }
    if (['TOTP_NOT_SETUP', 'STEP_UP_TOTP_NOT_ENABLED'].includes(remoteCode)) {
      return new AppError('SUB2API_TOTP_NOT_ENABLED', 'TOTP is not enabled for this Sub2API administrator', {
        status: 409,
        details
      });
    }
    if (remoteCode === 'STEP_UP_UNAVAILABLE') {
      return new AppError('SUB2API_STEP_UP_UNAVAILABLE', 'Sub2API step-up verification is temporarily unavailable', {
        status: 503,
        retryable: true,
        details
      });
    }
    if (Number(error?.status) === 401) {
      return new AppError('SUB2API_ADMIN_SESSION_REQUIRED', 'The configured Sub2API administrator session is no longer valid', {
        status: 401,
        details
      });
    }
    return error;
  }

  async listAll(endpoint, query = {}, options = {}) {
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 100));
    const maxItems = Math.min(50000, Math.max(pageSize, Number(options.maxItems) || 10000));
    const items = [];
    let page = 1;
    let total = null;
    let pages = null;
    while (items.length < maxItems) {
      const data = await this.data(endpoint, {
        query: { ...query, page, page_size: pageSize },
        ...(options.accessToken ? { accessToken: options.accessToken } : {})
      });
      if (!Array.isArray(data) && !Array.isArray(data?.items)) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API list response did not contain an items array', {
          status: 502,
          details: { endpoint, page }
        });
      }
      const batch = Array.isArray(data) ? data : data.items;
      if (batch.some((item) => item == null || typeof item !== 'object' || Array.isArray(item))) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API list response contained an invalid item', {
          status: 502,
          details: { endpoint, page }
        });
      }
      if (total == null && data && !Array.isArray(data)) total = Number(data.total ?? batch.length);
      if (pages == null && data && !Array.isArray(data)) pages = Number(data.pages || 0) || null;
      items.push(...batch.slice(0, maxItems - items.length));
      if (batch.length < pageSize || (pages && page >= pages) || (total != null && items.length >= total)) break;
      page += 1;
    }
    return {
      items,
      total: total ?? items.length,
      truncated: items.length >= maxItems && (total == null || total > items.length),
      pagesFetched: page
    };
  }
}

module.exports = {
  Sub2ApiAdminClient,
  unwrapSub2Api
};
