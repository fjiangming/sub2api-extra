const crypto = require('crypto');
const { AppError } = require('../errors');
const { createAdapter } = require('../adapters/registry');
const { nowIso } = require('../db');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function secureProviderOrigin(value) {
  const url = validHttpUrl(value);
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function rechargeLoginEnabled(connection) {
  return connection?.type_config_json?.rechargeLogin?.enabled === true;
}

function pageHeaders(res, formOrigins = ["'self'"]) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `form-action ${formOrigins.join(' ')}`,
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
}

function pageDocument({ title, heading, detail, content = '', stage = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="recharge-entry-page"${stage ? ` data-recharge-stage="${escapeHtml(stage)}"` : ''}>
  <main class="recharge-entry-shell">
    <section class="recharge-entry-panel">
      <span class="recharge-entry-mark" aria-hidden="true">¥</span>
      <h1>${escapeHtml(heading)}</h1>
      <p id="recharge-entry-status">${escapeHtml(detail)}</p>
      ${content}
    </section>
  </main>
  ${stage ? '<script src="/recharge-entry.js" defer></script>' : ''}
</body>
</html>`;
}

function jsonLoginFormField(body) {
  return {
    name: JSON.stringify({ username: body.username, password: body.password, _: '' }).slice(0, -2),
    value: '"}'
  };
}

function renderEntryPage(preview, token) {
  return pageDocument({
    title: '前往充值',
    heading: `正在前往 ${preview.providerName}`,
    detail: preview.targetHost,
    stage: 'confirm',
    content: `<form id="recharge-entry-form" method="post" action="/recharge-entry">
        <input type="hidden" name="ticket" value="${escapeHtml(token)}">
        <button class="button primary" type="submit">继续充值</button>
      </form>`
  });
}

function renderProviderLoginPage(descriptor) {
  const loginUrl = validHttpUrl(descriptor.loginUrl);
  const targetUrl = validHttpUrl(descriptor.targetUrl);
  if (!loginUrl || !targetUrl) {
    throw new AppError('RECHARGE_TARGET_INVALID', 'Recharge login target is invalid', { status: 400 });
  }
  const field = jsonLoginFormField(descriptor.body);
  const content = `<form id="provider-login-form" method="post" enctype="text/plain"
        action="${escapeHtml(loginUrl.toString())}" target="provider-login-window">
        <input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}">
      </form>
      <button class="button primary" id="provider-login-button" type="button">登录并前往充值</button>`;
  return pageDocument({
    title: '登录供应商',
    heading: '正在建立供应商登录会话',
    detail: targetUrl.hostname,
    stage: 'provider-login',
    content
  }).replace(
    '<body class="recharge-entry-page" data-recharge-stage="provider-login">',
    `<body class="recharge-entry-page" data-recharge-stage="provider-login" data-target-url="${escapeHtml(targetUrl.toString())}" data-wait-ms="${Math.max(1000, Math.min(10000, Number(descriptor.waitMs) || 2500))}">`
  );
}

function renderErrorPage(message, fallbackUrl = null) {
  const target = validHttpUrl(fallbackUrl);
  const content = target
    ? `<a class="button primary" href="${escapeHtml(target.toString())}" rel="noreferrer">打开充值页面</a>`
    : '';
  return pageDocument({
    title: '充值入口不可用',
    heading: '无法建立自动登录会话',
    detail: message,
    content
  });
}

class RechargeLinkService {
  constructor({ db, config, providers, http }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
  }

  #connection(connectionId) {
    return this.providers.get(connectionId, { forAdapter: true });
  }

  #adapter(connection) {
    return createAdapter(connection.adapter_type, {
      connection,
      credentials: this.providers.getCredentials(connection),
      http: this.http,
      config: this.config,
      onCredentialsUpdated: async (next) => this.providers.updateCredentials(connection, next)
    });
  }

  #direct(connection, reason = null) {
    const target = validHttpUrl(connection.recharge_url);
    if (!target) {
      throw new AppError('RECHARGE_URL_MISSING', '该供应商尚未配置有效的充值链接', { status: 409 });
    }
    return { mode: 'direct', url: target.toString(), reason };
  }

  issue(connectionId, options = {}) {
    const connection = this.#connection(connectionId);
    const direct = this.#direct(connection);
    if (!rechargeLoginEnabled(connection)) return { ...direct, reason: 'automatic_login_disabled' };
    if (!this.config.providerMonitorPublicUrl) return { ...direct, reason: 'public_url_missing' };
    if (!secureProviderOrigin(this.config.providerMonitorPublicUrl)) {
      return { ...direct, reason: 'insecure_public_origin' };
    }
    if (!secureProviderOrigin(connection.base_url)) return { ...direct, reason: 'insecure_provider_origin' };

    const adapter = this.#adapter(connection);
    const support = adapter.rechargeLoginSupport(direct.url);
    if (!support.supported) return { ...direct, reason: support.reason };

    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(
      Date.now() + Number(this.config.rechargeLinkTtlMinutes || 60) * 60000
    ).toISOString();
    this.db.prepare(`
      INSERT INTO recharge_access_tickets(
        token_hash, connection_id, alert_event_id, target_url, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenHash(token), connection.id, options.alertEventId || null, direct.url, expiresAt, createdAt);
    this.db.prepare(`
      DELETE FROM recharge_access_tickets
      WHERE expires_at < ? AND (consumed_at IS NOT NULL OR expires_at < ?)
    `).run(createdAt, new Date(Date.now() - 86400000).toISOString());

    const url = new URL('/recharge-entry', `${this.config.providerMonitorPublicUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('ticket', token);
    return {
      mode: 'adapter',
      adapterType: connection.adapter_type,
      url: url.toString(),
      expiresAt
    };
  }

  notificationUrl(event) {
    const issued = this.notificationLink(event);
    return issued?.mode === 'adapter' ? issued.url : null;
  }

  notificationLink(event) {
    const connectionId = event?.connection_id || event?.details?.connectionId;
    if (!connectionId || !event?.details?.rechargeUrl) return null;
    return this.issue(connectionId, { alertEventId: event.id });
  }

  #ticket(token) {
    if (!TOKEN_PATTERN.test(String(token || ''))) {
      throw new AppError('RECHARGE_TICKET_INVALID', '充值入口无效', { status: 404 });
    }
    const row = this.db.prepare(`
      SELECT t.*, p.name AS provider_name, p.adapter_type
      FROM recharge_access_tickets t
      JOIN provider_connections p ON p.id = t.connection_id
      WHERE t.token_hash = ?
    `).get(tokenHash(token));
    if (!row) throw new AppError('RECHARGE_TICKET_INVALID', '充值入口无效', { status: 404 });
    if (row.consumed_at) throw new AppError('RECHARGE_TICKET_USED', '该充值入口已使用', { status: 410 });
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new AppError('RECHARGE_TICKET_EXPIRED', '该充值入口已过期', { status: 410 });
    }
    return row;
  }

  preview(token) {
    const row = this.#ticket(token);
    const target = new URL(row.target_url);
    return {
      providerName: row.provider_name,
      adapterType: row.adapter_type,
      targetHost: target.hostname,
      targetOrigin: target.origin,
      expiresAt: row.expires_at
    };
  }

  async consume(token) {
    const row = this.#ticket(token);
    const consumedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE recharge_access_tickets SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(consumedAt, row.token_hash, consumedAt);
    if (result.changes !== 1) {
      throw new AppError('RECHARGE_TICKET_USED', '该充值入口已使用或已过期', { status: 410 });
    }

    const connection = this.#connection(row.connection_id);
    if (!rechargeLoginEnabled(connection)) {
      return {
        mode: 'redirect',
        adapterType: connection.adapter_type,
        connectionId: connection.id,
        url: row.target_url,
        targetUrl: row.target_url
      };
    }
    try {
      return {
        ...(await this.#adapter(connection).createRechargeLogin(row.target_url)),
        connectionId: connection.id
      };
    } catch (error) {
      throw new AppError(
        error.code || 'RECHARGE_LOGIN_FAILED',
        error.message || '无法建立供应商登录会话',
        {
          status: error.status || 502,
          details: { ...(error.details || {}), fallbackUrl: row.target_url },
          cause: error
        }
      );
    }
  }
}

module.exports = {
  RechargeLinkService,
  pageHeaders,
  renderEntryPage,
  renderProviderLoginPage,
  renderErrorPage,
  jsonLoginFormField,
  tokenHash,
  validHttpUrl
};
