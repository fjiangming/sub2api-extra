#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { RechargeListenerClient } = require('./listener-client');
const { normalizeOpaqueAlipayQrUrl } = require('../src/qr-provisioning-service');
const { parseMoneyToMinor, safeEqual } = require('../src/security');

const FAILURE_CODES = new Set([
  'login_required',
  'navigation_failed',
  'unexpected_page',
  'field_mismatch',
  'qr_not_generated',
  'adapter_unavailable',
  'other'
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeFailureCode(error) {
  const code = String(error?.code || '').toLowerCase();
  return FAILURE_CODES.has(code) ? code : 'other';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateGeneratedResult(job, generated, expectedRecipientId) {
  let qrUrl;
  try {
    qrUrl = normalizeOpaqueAlipayQrUrl(generated?.qrUrl);
  } catch {
    throw codedError('qr_not_generated', '适配器未返回有效的支付宝 fkx 收钱码');
  }
  let amountMatches = false;
  try {
    amountMatches = parseMoneyToMinor(generated?.observedAmount) === parseMoneyToMinor(job.amount);
  } catch {}
  if (!amountMatches || !safeEqual(String(generated?.observedMemo || '').trim(), job.memo) ||
      !safeEqual(String(generated?.observedRecipientId || '').trim(), expectedRecipientId)) {
    throw codedError('field_mismatch', '支付宝结果页回读字段与订单不一致');
  }
  let generatedAt;
  try {
    generatedAt = new Date(String(generated?.generatedAt || '')).toISOString();
  } catch {
    throw codedError('qr_not_generated', '适配器未返回有效的二维码生成时间');
  }
  return {
    qrUrl,
    observedAmount: generated.observedAmount,
    observedMemo: String(generated.observedMemo).trim(),
    observedRecipientId: String(generated.observedRecipientId).trim(),
    generatedAt
  };
}

async function loadAdapter(modulePath) {
  const resolved = path.resolve(String(modulePath || ''));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('二维码适配模块必须是普通文件');
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new Error('二维码适配模块不能允许同组或其他用户写入');
  }
  const imported = await import(pathToFileURL(resolved).href);
  const adapter = imported.default || imported;
  if (typeof adapter.generate !== 'function') throw new Error('二维码适配模块必须导出 generate(job)');
  return adapter;
}

class QrProvisionerAgent {
  constructor({
    client,
    adapter,
    expectedRecipientId,
    pollMs = 3000,
    heartbeatMs = 10000,
    logger = console,
    clock = () => new Date()
  }) {
    if (!String(expectedRecipientId || '').trim()) throw new Error('二维码代理必须配置精确收款账户标识');
    this.client = client;
    this.adapter = adapter;
    this.expectedRecipientId = String(expectedRecipientId).trim();
    this.pollMs = boundedInteger(pollMs, 3000, 3000, 10000);
    this.heartbeatMs = boundedInteger(heartbeatMs, 10000, 2000, 30000);
    this.logger = logger;
    this.clock = clock;
    this.running = false;
    this.ready = false;
    this.faulted = false;
    this.lastHealthCheckAt = null;
    this.lastHeartbeatAt = 0;
  }

  #log(level, message, metadata = {}) {
    this.logger[level]?.(JSON.stringify({ level, message, ...metadata }));
  }

  async #healthCheck() {
    if (this.faulted) {
      this.ready = false;
      this.lastHealthCheckAt = this.clock().toISOString();
      return false;
    }
    try {
      const result = typeof this.adapter.healthCheck === 'function'
        ? await this.adapter.healthCheck()
        : { ready: false };
      this.ready = result?.ready === true &&
        safeEqual(String(result?.recipientId || '').trim(), this.expectedRecipientId);
    } catch {
      this.ready = false;
    }
    this.lastHealthCheckAt = this.clock().toISOString();
    return this.ready;
  }

  async #heartbeat(force = false) {
    const now = this.clock().getTime();
    if (!force && now - this.lastHeartbeatAt < this.heartbeatMs) return;
    await this.#healthCheck();
    await this.client.qrHeartbeat({
      version: 'opaque-qr-agent/1',
      ready: this.ready,
      observedAt: this.lastHealthCheckAt
    });
    this.lastHeartbeatAt = now;
  }

  async runOnce() {
    await this.#heartbeat();
    if (!this.ready) return { status: 'not_ready' };
    const job = await this.client.claimQrJob();
    if (!job) return { status: 'idle' };

    const deadline = Math.min(Date.parse(job.expiresAt), Date.parse(job.leaseExpiresAt));
    if (!Number.isFinite(deadline) || deadline <= this.clock().getTime() + 1000) {
      return { status: 'lease_too_short', jobId: job.jobId };
    }
    const controller = new AbortController();
    let timeout;
    try {
      const timeoutMs = Math.max(1, deadline - this.clock().getTime() - 1000);
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(codedError('qr_not_generated', '二维码生成超过任务租约'));
        }, timeoutMs);
      });
      const generated = await Promise.race([
        Promise.resolve().then(() => this.adapter.generate({
          jobId: job.jobId,
          orderNo: job.orderNo,
          amount: job.amount,
          memo: job.memo,
          expiresAt: job.expiresAt,
          signal: controller.signal
        })),
        timedOut
      ]);
      const validated = validateGeneratedResult(job, generated, this.expectedRecipientId);
      const completion = {
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        ...validated
      };
      let result;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          result = await this.client.completeQrJob(completion);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const ambiguous = !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
          if (!ambiguous || attempt === 3 || this.clock().getTime() + attempt * 250 >= deadline) break;
          await sleep(attempt * 250);
        }
      }
      if (lastError) {
        const ambiguous = !lastError?.status || lastError.status === 408 ||
          lastError.status === 429 || lastError.status >= 500;
        if (ambiguous) {
          lastError.completionUnknown = true;
          lastError.code = 'completion_unknown';
        }
        throw lastError;
      }
      this.#log('info', 'opaque Alipay QR provisioned', { jobId: job.jobId, orderNo: job.orderNo });
      return { status: 'completed', jobId: job.jobId, result };
    } catch (error) {
      if (error?.completionUnknown) {
        this.faulted = true;
        this.ready = false;
        try { await this.#heartbeat(true); } catch {}
        this.#log('error', 'opaque Alipay QR completion is uncertain', {
          jobId: job.jobId,
          orderNo: job.orderNo,
          failureCode: 'completion_unknown'
        });
        return { status: 'completion_unknown', jobId: job.jobId };
      }
      const failureCode = safeFailureCode(error);
      try {
        await this.client.failQrJob({ jobId: job.jobId, leaseToken: job.leaseToken, failureCode });
      } catch {}
      this.faulted = true;
      this.ready = false;
      try { await this.#heartbeat(true); } catch {}
      this.#log('error', 'opaque Alipay QR provisioning failed', {
        jobId: job.jobId,
        orderNo: job.orderNo,
        failureCode
      });
      return { status: 'failed', jobId: job.jobId, failureCode };
    } finally {
      clearTimeout(timeout);
    }
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.ready = false;
        this.#log('error', 'QR provisioner loop failed', { code: String(error?.code || 'AGENT_LOOP_FAILED') });
      }
      if (this.running) await sleep(this.pollMs);
    }
  }

  stop() {
    this.running = false;
  }
}

async function main() {
  process.umask?.(0o077);
  const adapter = await loadAdapter(process.env.RECHARGE_CENTER_QR_ADAPTER_MODULE);
  const client = new RechargeListenerClient({
    baseUrl: process.env.RECHARGE_CENTER_LISTENER_BASE_URL,
    secret: process.env.RECHARGE_CENTER_QR_PROVISIONER_SECRET,
    collectorId: process.env.RECHARGE_CENTER_LISTENER_COLLECTOR_ID,
    allowInsecureHttp: String(process.env.ALLOW_INSECURE_LISTENER_HTTP || '').toLowerCase() === 'true'
  });
  const agent = new QrProvisionerAgent({
    client,
    adapter,
    expectedRecipientId: process.env.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID,
    pollMs: process.env.RECHARGE_CENTER_QR_POLL_MS,
    heartbeatMs: process.env.RECHARGE_CENTER_QR_HEARTBEAT_MS
  });
  process.on('SIGINT', () => agent.stop());
  process.on('SIGTERM', () => agent.stop());
  await agent.start();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { QrProvisionerAgent, loadAdapter, safeFailureCode, validateGeneratedResult };
