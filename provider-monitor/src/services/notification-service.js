const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { AppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { maskValue, redactText } = require('../security/redaction');
const { safeFetch } = require('../http/safe-fetch');
const { nowIso, parseJson, stringifyJson } = require('../db');

function normalizedRechargeUrl(event) {
  const value = event?.details?.rechargeUrl;
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function notificationMessage(event, markdown = false) {
  const rechargeUrl = normalizedRechargeUrl(event);
  if (!rechargeUrl) return event.message;
  if (markdown) {
    const markdownUrl = rechargeUrl.replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `${event.message}\n[立即充值](${markdownUrl})`;
  }
  return `${event.message}\n充值链接：${rechargeUrl}`;
}

class NotificationService {
  constructor({ db, config, rechargeLinks = null }) {
    this.db = db;
    this.config = config;
    this.rechargeLinks = rechargeLinks;
  }

  listChannels() {
    return this.db.prepare(`
      SELECT c.*, e.payload AS credential_payload
      FROM notification_channels c
      LEFT JOIN encrypted_credentials e ON e.id = c.credential_id
      ORDER BY c.name COLLATE NOCASE
    `).all().map((row) => {
      let credentialFields = [];
      if (row.credential_payload) {
        const credentials = decryptJson(row.credential_payload, this.config.secret);
        credentialFields = Object.entries(credentials)
          .filter(([, value]) => value != null && value !== '')
          .map(([name, value]) => ({ name, masked: maskValue(value) }));
      }
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: Boolean(row.enabled),
        config: parseJson(row.config_json, {}),
        credentialFields,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  save(input, id = null) {
    const channelId = id || crypto.randomUUID();
    const now = nowIso();
    const existing = id
      ? this.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id)
      : null;
    if (id && !existing) {
      throw new AppError('CHANNEL_NOT_FOUND', 'Notification channel was not found', { status: 404 });
    }
    let credentialId = existing?.credential_id || null;
    this.db.transaction(() => {
      if (input.credentials && Object.keys(input.credentials).length > 0) {
        if (!credentialId) {
          credentialId = crypto.randomUUID();
          this.db.prepare(`
            INSERT INTO encrypted_credentials(id, payload, created_at) VALUES (?, ?, ?)
          `).run(credentialId, encryptJson(input.credentials, this.config.secret), now);
        } else {
          this.db.prepare(`
            UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?
          `).run(encryptJson(input.credentials, this.config.secret), now, credentialId);
        }
      }
      if (existing) {
        this.db.prepare(`
          UPDATE notification_channels SET name = ?, type = ?, enabled = ?,
            credential_id = ?, config_json = ?, updated_at = ? WHERE id = ?
        `).run(
          input.name ?? existing.name,
          input.type ?? existing.type,
          input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
          credentialId,
          stringifyJson(input.config ?? parseJson(existing.config_json, {})),
          now,
          channelId
        );
      } else {
        this.db.prepare(`
          INSERT INTO notification_channels(
            id, name, type, enabled, credential_id, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          channelId,
          input.name,
          input.type,
          input.enabled === false ? 0 : 1,
          credentialId,
          stringifyJson(input.config || {}),
          now,
          now
        );
      }
    })();
    return this.listChannels().find((channel) => channel.id === channelId);
  }

  delete(id) {
    const channel = this.db.prepare(`
      SELECT credential_id FROM notification_channels WHERE id = ?
    `).get(id);
    if (!channel) throw new AppError('CHANNEL_NOT_FOUND', 'Notification channel was not found', { status: 404 });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
      if (channel.credential_id) {
        this.db.prepare('DELETE FROM encrypted_credentials WHERE id = ?').run(channel.credential_id);
      }
    })();
  }

  async test(id) {
    const fakeEvent = {
      id: crypto.randomUUID(),
      severity: 'info',
      message: 'Provider Monitor notification test succeeded.',
      triggered_at: nowIso(),
      details: { test: true }
    };
    return this.#deliverToChannel(this.#getChannel(id), fakeEvent, false);
  }

  async testRechargeAlert(id, event) {
    const channel = this.#getChannel(id);
    const prepared = this.#prepareDeliveryEvent(event);
    const delivery = await this.#deliverToChannel(channel, prepared.event, false);
    return {
      delivery,
      recharge: prepared.recharge
    };
  }

  async dispatch(event) {
    const channels = this.db.prepare(`
      SELECT c.*, e.payload AS credential_payload
      FROM notification_channels c
      LEFT JOIN encrypted_credentials e ON e.id = c.credential_id
      WHERE c.enabled = 1
    `).all();
    if (channels.length === 0) return [];
    const deliveryEvent = this.#prepareDeliveryEvent(event).event;
    return Promise.allSettled(
      channels.map((channel) => this.#deliverWithRetry(channel, deliveryEvent))
    );
  }

  #prepareDeliveryEvent(event) {
    const directUrl = normalizedRechargeUrl(event);
    let recharge = directUrl
      ? { mode: 'direct', url: directUrl, reason: null, expiresAt: null }
      : null;
    if (!this.rechargeLinks || !directUrl) return { event, recharge };

    try {
      const issued = this.rechargeLinks.notificationLink(event);
      if (!issued?.url) return { event, recharge };
      recharge = issued;
      return {
        event: {
          ...event,
          details: { ...(event.details || {}), rechargeUrl: issued.url }
        },
        recharge
      };
    } catch (error) {
      if (this.config.env !== 'test') {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'Recharge login link generation failed; using the direct recharge URL',
          code: error?.code || 'RECHARGE_LINK_FAILED'
        }));
      }
      return {
        event,
        recharge: recharge
          ? {
              ...recharge,
              reason: 'link_generation_failed',
              errorCode: error?.code || 'RECHARGE_LINK_FAILED'
            }
          : null
      };
    }
  }

  async #deliverWithRetry(channel, event) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#deliverToChannel(channel, event, true, attempt);
      } catch (error) {
        lastError = error;
        if (!error?.retryable || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  #getChannel(id) {
    const channel = this.db.prepare(`
      SELECT c.*, e.payload AS credential_payload
      FROM notification_channels c
      LEFT JOIN encrypted_credentials e ON e.id = c.credential_id
      WHERE c.id = ?
    `).get(id);
    if (!channel) throw new AppError('CHANNEL_NOT_FOUND', 'Notification channel was not found', { status: 404 });
    return channel;
  }

  async #deliverToChannel(channel, event, recordDelivery, attempt = 1) {
    const deliveryId = crypto.randomUUID();
    const config = parseJson(channel.config_json, {});
    const credentials = channel.credential_payload
      ? decryptJson(channel.credential_payload, this.config.secret)
      : {};
    if (recordDelivery) {
      this.db.prepare(`
        INSERT INTO notification_deliveries(
          id, alert_event_id, channel_id, status, attempt, created_at
        ) VALUES (?, ?, ?, 'sending', ?, ?)
      `).run(deliveryId, event.id, channel.id, attempt, nowIso());
    }
    try {
      await this.#send(channel.type, config, credentials, event);
      if (recordDelivery) {
        this.db.prepare(`
          UPDATE notification_deliveries SET status = 'delivered', delivered_at = ? WHERE id = ?
        `).run(nowIso(), deliveryId);
      }
      return { channelId: channel.id, status: 'delivered' };
    } catch (error) {
      if (recordDelivery) {
        this.db.prepare(`
          UPDATE notification_deliveries SET status = 'failed', error_message = ? WHERE id = ?
        `).run(redactText(error?.message || error).slice(0, 1000), deliveryId);
      }
      throw error;
    }
  }

  async #send(type, config, credentials, event) {
    const title = config.titlePrefix
      ? `${config.titlePrefix} ${event.severity.toUpperCase()}`
      : `Provider Monitor ${event.severity.toUpperCase()}`;
    const message = notificationMessage(event);
    if (type === 'webhook') {
      return this.#postJson(config.url, {
        event: 'provider_monitor.alert',
        title,
        message,
        severity: event.severity,
        triggeredAt: event.triggered_at,
        details: event.details || {}
      }, credentials.headers || {});
    }
    if (type === 'telegram') {
      const url = `https://api.telegram.org/bot${credentials.botToken}/sendMessage`;
      return this.#postJson(url, {
        chat_id: config.chatId,
        text: `${title}\n${message}`,
        disable_web_page_preview: true
      });
    }
    if (type === 'gotify') {
      const url = new URL('/message', config.baseUrl).toString();
      const withToken = new URL(url);
      withToken.searchParams.set('token', credentials.token);
      return this.#postJson(withToken.toString(), {
        title,
        message,
        priority: config.priority ?? 5
      });
    }
    if (type === 'bark') {
      return this.#postJson(config.endpoint || 'https://api.day.app/push', {
        device_key: credentials.deviceKey,
        title,
        body: message,
        group: config.group || 'Provider Monitor'
      });
    }
    if (type === 'wecom') {
      const markdownMessage = notificationMessage(event, true).replace(/\n/g, '\n>');
      return this.#postJson(config.url || credentials.webhookUrl, {
        msgtype: 'markdown',
        markdown: { content: `**${title}**\n>${markdownMessage}\n>${event.triggered_at}` }
      });
    }
    if (type === 'serverchan') {
      const sendKey = String(credentials.sendKey || '').trim();
      if (!sendKey.startsWith('SCT')) {
        throw new AppError('NOTIFICATION_CREDENTIAL_INVALID', 'Server酱需要 SCT 开头的 Turbo SendKey', {
          status: 400
        });
      }
      const baseUrl = this.config.env === 'test' && config.baseUrl
        ? config.baseUrl
        : 'https://sctapi.ftqq.com/';
      const target = new URL(`${encodeURIComponent(sendKey)}.send`, baseUrl).toString();
      return this.#postForm(target, {
        title: title.replace(/[\r\n]+/g, ' ').slice(0, 120),
        desp: `${notificationMessage(event, true)}\n\n触发时间：${event.triggered_at}`
      }, 'Server酱');
    }
    if (type === 'dingtalk') {
      const target = new URL(config.url || credentials.webhookUrl);
      if (credentials.secret) {
        const timestamp = Date.now();
        const sign = crypto.createHmac('sha256', credentials.secret)
          .update(`${timestamp}\n${credentials.secret}`)
          .digest('base64');
        target.searchParams.set('timestamp', String(timestamp));
        target.searchParams.set('sign', sign);
      }
      return this.#postJson(target.toString(), {
        msgtype: 'markdown',
        markdown: { title, text: `### ${title}\n${message}\n\n${event.triggered_at}` }
      });
    }
    if (type === 'feishu') {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: title } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `${message}\n${event.triggered_at}` } }]
        }
      };
      if (credentials.secret) {
        payload.timestamp = String(timestamp);
        payload.sign = crypto.createHmac('sha256', `${timestamp}\n${credentials.secret}`).update('').digest('base64');
      }
      return this.#postJson(config.url || credentials.webhookUrl, payload);
    }
    if (type === 'email') {
      const smtp = {
        host: config.host || config.smtpHost || this.config.smtp.host,
        port: Number(config.port || config.smtpPort || this.config.smtp.port || 587),
        secure: config.secure ?? config.smtpSecure ?? this.config.smtp.secure,
        user: config.user || config.smtpUser || this.config.smtp.user,
        from: config.from || config.smtpFrom || this.config.smtp.from
      };
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: credentials.password || smtp.password } : undefined
      });
      await transporter.sendMail({
        from: smtp.from || smtp.user,
        to: config.to,
        subject: title,
        text: `${message}\n\nTriggered at: ${event.triggered_at}`
      });
      return;
    }
    throw new AppError('CHANNEL_TYPE_UNSUPPORTED', `Unsupported notification channel: ${type}`, {
      status: 400
    });
  }

  async #postJson(input, body, headers = {}) {
    const response = await safeFetch(input, this.config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new AppError('NOTIFICATION_FAILED', `Notification endpoint returned HTTP ${response.status}`, {
        status: 502,
        retryable: response.status === 429 || response.status >= 500
      });
    }
  }

  async #postForm(input, body, serviceName) {
    const response = await safeFetch(input, this.config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(body).toString(),
      readBody: true
    });
    if (!response.ok) {
      throw new AppError('NOTIFICATION_FAILED', `${serviceName} returned HTTP ${response.status}`, {
        status: 502,
        retryable: response.status === 429 || response.status >= 500
      });
    }
    const result = parseJson(response.body, null);
    if (!result || Number(result.code) !== 0) {
      const reason = redactText(result?.message || result?.info || 'unknown response').slice(0, 300);
      throw new AppError('NOTIFICATION_FAILED', `${serviceName} rejected the notification: ${reason}`, {
        status: 502
      });
    }
  }
}

module.exports = {
  NotificationService,
  notificationMessage
};
