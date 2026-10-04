#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { listenerSignature } = require('../src/listener-service');

const MAX_RESPONSE_BYTES = 64 * 1024;

function normalizedBaseUrl(value, allowInsecureHttp = false) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('监听地址必须是不含账号、查询参数和片段的 HTTP(S) 地址');
  }
  if (url.protocol !== 'https:' && !allowInsecureHttp) {
    throw new Error('监听地址必须使用 HTTPS；受控内网调试需显式设置 ALLOW_INSECURE_LISTENER_HTTP=true');
  }
  return url.toString().replace(/\/$/, '');
}

class RechargeListenerClient {
  constructor(options = {}) {
    if (String(options.secret || '').length < 32) throw new Error('监听签名密钥至少需要 32 个字符');
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(options.collectorId || ''))) throw new Error('监听器 ID 格式无效');
    this.baseUrl = normalizedBaseUrl(options.baseUrl, options.allowInsecureHttp === true);
    this.secret = String(options.secret);
    this.collectorId = String(options.collectorId);
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Number(options.timeoutMs) || 5000;
  }

  heartbeat(input = {}) {
    const status = typeof input === 'string' ? { version: input } : input;
    return this.#post('/api/listener/alipay/heartbeat', {
      collectorId: this.collectorId,
      ready: status.ready === true,
      observedAt: status.observedAt || new Date().toISOString(),
      ...(status.version ? { version: String(status.version).slice(0, 80) } : {})
    });
  }

  sendPayment(event) {
    return this.#post('/api/listener/alipay/events', { ...event, collectorId: this.collectorId });
  }

  async #post(pathname, payload) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Recharge-Timestamp': timestamp,
          'X-Recharge-Nonce': nonce,
          'X-Recharge-Signature': listenerSignature(this.secret, timestamp, nonce, Buffer.from(body))
        },
        body,
        redirect: 'error',
        signal: controller.signal
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('监听服务响应超出限制');
      let result = {};
      if (text) {
        try { result = JSON.parse(text); } catch { throw new Error('监听服务返回无效 JSON'); }
      }
      if (!response.ok) {
        const code = result?.error?.code || `HTTP_${response.status}`;
        throw new Error(`监听服务拒绝请求: ${code}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readEventFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024) throw new Error('事件文件必须是 16 KiB 以内的普通 JSON 文件');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('事件文件包含付款详情，权限必须设置为 0600');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  process.umask?.(0o077);
  const command = process.argv[2];
  const client = new RechargeListenerClient({
    baseUrl: process.env.RECHARGE_CENTER_LISTENER_BASE_URL,
    secret: process.env.RECHARGE_CENTER_LISTENER_SECRET,
    collectorId: process.env.RECHARGE_CENTER_LISTENER_COLLECTOR_ID,
    allowInsecureHttp: String(process.env.ALLOW_INSECURE_LISTENER_HTTP || '').toLowerCase() === 'true'
  });
  const result = command === 'heartbeat'
    ? await client.heartbeat({
        version: process.env.RECHARGE_CENTER_LISTENER_VERSION || 'listener-client/1',
        ready: String(process.env.RECHARGE_CENTER_LISTENER_READY || '').toLowerCase() === 'true',
        observedAt: process.env.RECHARGE_CENTER_LISTENER_OBSERVED_AT || new Date().toISOString()
      })
    : command === 'event' && process.argv[3]
      ? await client.sendPayment(readEventFile(process.argv[3]))
      : (() => { throw new Error('用法: listener-client.js heartbeat | event <受保护的JSON文件>'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { RechargeListenerClient, normalizedBaseUrl, readEventFile };
