'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { AppError } = require('./errors');
const { channels, modelGroupContext, publicModelPlatform } = require('./model-config');
const { modelRunSummary, sanitizeModelResponse } = require('./model-results');
const { requestReviewJson, resolveReviewAddress } = require('./review-http');

function modelFailure(error, stage) {
  const code = error?.code || error?.message;
  const status = error?.httpStatus;
  if (status === 429) return '检测网站限流，本次未自动重复提交；稍后再试';
  if ([401, 403].includes(status)) return '检测网站拒绝访问，请管理员检查网站 API Key、额度或功能权限';
  if (status === 404 && stage === 'poll') return '检测网站任务已过期或不存在，保留已取得的检测项';
  if (status === 400 || status === 422) return '检测网站拒绝请求参数，请检查目标公网地址、模型及协议';
  if (code === 'REVIEW_URL_UNSAFE') return '检测接口或目标地址未通过公网 HTTPS 校验';
  if (code === 'REVIEW_RESPONSE_TOO_LARGE') return '检测网站响应超过 2 MiB 上限，本次未形成完整结果';
  if (code === 'MODEL_CONFIG_CHANGED') return '配置已停用或变更，本地任务已停止；上游已提交任务不会重复发起';
  if (code === 'DETECTION_KEY_UNREADABLE' || code === 'DETECTION_KEY_INVALID') return '模型检测专用 Key 或检测网站 Key 无法读取，请管理员重新配置';
  if (code === 'MODEL_TASK_MISMATCH') return '检测网站返回的任务标识不一致，已停止查询';
  if (code === 'MODEL_RESPONSE_INVALID' || code === 'REVIEW_RESPONSE_INVALID') return '检测网站返回格式不符合当前接入协议，无法形成有效结论';
  if (code === 'MODEL_TIMEOUT' || code === 'REVIEW_TIMEOUT' || error?.name === 'AbortError' || error?.name === 'TimeoutError') return '模型检测超时，保留已取得的检测项；未重新提交任务';
  return stage === 'submit' ? '无法确认检测网站是否接受任务；未自动重发，请核对网站任务后再检测' : '读取检测网站结果失败，保留已取得的检测项；未重新提交任务';
}

function validateModelResponse(channel, response) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(response)) throw new Error('MODEL_RESPONSE_INVALID');
  const validStatuses = channel === 'bazaarlink' ? ['running', 'pending', 'completed', 'failed', 'aborted'] : ['running', 'pending', 'done', 'error'];
  if (response.status != null && !validStatuses.includes(response.status)) throw new Error('MODEL_RESPONSE_INVALID');
  if (channel === 'bazaarlink') {
    if (response.items != null && (!Array.isArray(response.items) || !response.items.every(object))) throw new Error('MODEL_RESPONSE_INVALID');
    if (response.identityAssessment != null && !object(response.identityAssessment)) throw new Error('MODEL_RESPONSE_INVALID');
  } else {
    if (response.scores != null && !object(response.scores)) throw new Error('MODEL_RESPONSE_INVALID');
    if (response.metrics != null && !object(response.metrics)) throw new Error('MODEL_RESPONSE_INVALID');
    if (response.tokenAudit != null && (!object(response.tokenAudit) || response.tokenAudit.rows != null && !Array.isArray(response.tokenAudit.rows))) throw new Error('MODEL_RESPONSE_INVALID');
  }
}

function demoModelResponse(channel, model, platform) {
  if (channel === 'cctest') return {
    status: 'done', progress: 1, provider: platform === 'anthropic' ? 'claude' : 'codex', expectedModel: model, responseModel: model,
    scores: Object.fromEntries(['tag_check', 'stream_structure', 'non_stream', 'websearch', 'signature_proto', 'output_config', 'server_tool', 'knowledge', 'model_attribution', 'doc_recognition', 'image_recognition'].map((key, i) => [key, i === 6 ? 0 : 10])),
    verdictKey: 'official_flawed', total: 90, metrics: { latencyMs: 28000, ttfbMs: 640, inputTokens: 1500, outputTokens: 250, tokensPerSec: 38 },
    tokenAudit: { rows: Array.from({ length: 6 }, (_, i) => ({ round: i + 1, requestType: i % 2 ? 'stream' : 'non_stream', inputTokens: 250, outputTokens: i === 5 ? 0 : 50, cachedTokens: 0, costUsd: 0.0005, baselineCostUsd: null })), totalCost: 0.003, baselineTotalCost: null, overallRatio: null, cacheHitRate: 0, anomalies: [] }
  };
  return {
    status: 'completed', modelId: model, claimedModel: model, createdAt: Date.now(), wallClockMs: 28000, totalInputTokens: 1500, totalOutputTokens: 250,
    identityAssessment: { status: 'match', verdict: { status: 'clean_match_family_only', trueFamily: platform === 'anthropic' ? 'Anthropic' : 'OpenAI', trueModel: null, confidence: 'medium', reasoning: '演示数据：只确认模型家族，不确认具体子型号。' } },
    items: [true, true, true, 'warning', null, false, true, true].map((passed, i) => ({ probeId: `demo-${i}`, label: ['家族指纹示例', '协议特征示例', '行为检查示例', '基线检查示例', '可选检查示例', '子型号检查示例', '上下文检查示例', '安全对照示例'][i], group: ['fingerprint', 'protocol', 'behavior', 'context', 'effort', 'identity', 'context', 'security'][i], status: i === 4 ? 'error' : 'done', passed, passReason: '仅用于页面演示，不是实际检测网站实测', response: '模拟回答', inputTokens: 100, outputTokens: 25, ttftMs: 480, durationMs: 1200, tps: 20.8 })),
    warnings: [{ id: 'demo', label: '模拟检测', severity: 'info', evidence: '未调用真实检测网站或付费模型' }]
  };
}

class ModelDetection {
  constructor({ config, store, modelStore, vault, request = requestReviewJson, resolve = resolveReviewAddress, pollMs = 3000 }) {
    Object.assign(this, { config, store, modelStore, vault, request, resolve, pollMs });
    this.active = new Map();
    this.timer = null;
    this.closed = false;
  }

  prepareConfiguration(submitted, discovered) {
    if (!submitted.model_schedule && !submitted.platforms.some(platform => platform.model_detection || platform.groups.some(group => group.model_detection))) return null;
    const accessible = new Map(discovered.map(group => [String(group.id), group]));
    const fingerprints = new Map();
    const platforms = [];
    for (const platform of submitted.platforms) {
      const previous = this.modelStore.platform(platform.id);
      const candidate = platform.model_detection;
      const config = candidate ? structuredClone(candidate) : previous;
      if (config.enabled && !['openai', 'anthropic'].includes(platform.id)) throw new AppError('MODEL_PLATFORM_UNSUPPORTED', '模型检测目前仅支持 OpenAI 和 Anthropic 平台', { status: 400 });
      let destinationChanged = config.target_url !== previous.target_url;
      for (const channel of channels) {
        const settings = config.channels[channel];
        const old = previous.channels[channel];
        const key = String(settings.api_key || '').trim();
        delete settings.api_key;
        const clear = settings.clear_api_key === true;
        delete settings.clear_api_key;
        const changed = settings.api_url !== old.api_url;
        destinationChanged ||= settings.enabled && (changed || !old.enabled);
        settings.key_context = `model-site:${platform.id}:${channel}`;
        if (key && clear) throw new AppError('MODEL_CONFIG_INVALID', '不能同时设置和清除检测网站 Key', { status: 400 });
        if (key) {
          settings.key_cipher = this.vault.encrypt(settings.key_context, key);
          settings.key_fingerprint = this.vault.fingerprint(key);
        } else if (!clear && !changed) {
          settings.key_cipher = old.key_cipher || null;
          settings.key_fingerprint = old.key_fingerprint || null;
        } else {
          settings.key_cipher = null;
          settings.key_fingerprint = null;
        }
        if (config.enabled && settings.enabled && channel === 'cctest' && !settings.key_cipher) throw new AppError('MODEL_SITE_KEY_REQUIRED', 'CCTest 需要单独配置检测网站 API Key', { status: 400 });
      }
      const groups = platform.groups.map(selection => {
        const discoveredGroup = accessible.get(String(selection.id));
        if (!discoveredGroup || discoveredGroup.platform !== platform.id) throw new AppError('GROUP_NOT_AVAILABLE', '模型检测分组不存在或无权配置', { status: 400 });
        const old = this.modelStore.group(selection.id);
        const choice = selection.model_detection || { enabled: Boolean(old?.enabled), models: old ? JSON.parse(old.models_json) : {} };
        const enabled = config.enabled && choice.enabled;
        const key = String(choice.key || '').trim();
        let keyCipher = null;
        let keyFingerprint = null;
        if (enabled) {
          if (destinationChanged && !key && old?.key_cipher) throw new AppError('MODEL_KEY_CONFIRM_REQUIRED', '目标地址或已选检测网站变更后，请重新填写模型检测专用 Key', { status: 400 });
          if (key) {
            keyCipher = this.vault.encrypt(modelGroupContext(selection.id), key);
            keyFingerprint = this.vault.fingerprint(key);
          } else if (old?.key_cipher) {
            this.vault.decrypt(modelGroupContext(selection.id), old.key_cipher);
            keyCipher = old.key_cipher;
            keyFingerprint = old.key_fingerprint;
          } else throw new AppError('MODEL_TARGET_KEY_REQUIRED', `分组 ${discoveredGroup.name} 需要单独填写模型检测专用 Key`, { status: 400 });
          if (fingerprints.has(keyFingerprint)) throw new AppError('MODEL_TARGET_KEY_DUPLICATED', '不同分组不能共用模型检测专用 Key', { status: 400 });
          fingerprints.set(keyFingerprint, String(selection.id));
        } else if (key) throw new AppError('MODEL_CONFIG_INVALID', '未启用模型检测的分组不能提交专用 Key', { status: 400 });
        return { id: String(selection.id), name: discoveredGroup.name, enabled, keyCipher, keyFingerprint, models: choice.models || {} };
      });
      platforms.push({ id: platform.id, config, groups });
    }
    return { schedule: submitted.model_schedule, platforms };
  }

  publicPlatform(id) { return publicModelPlatform(this.modelStore.platform(id)); }
  current(run) {
    const group = this.modelStore.group(run.group_id);
    return group?.enabled && group.revision === run.revision && this.modelStore.platform(group.platform).enabled
      && this.modelStore.effective(group, run.channel).enabled;
  }

  enqueue(groupId, trigger = 'manual', selected = channels) {
    if (this.closed) throw new AppError('MODEL_SCHEDULER_CLOSED', '模型检测服务正在关闭', { status: 503 });
    const group = this.modelStore.group(groupId);
    if (!group?.enabled || !this.modelStore.platform(group.platform).enabled || !group.key_cipher) throw new AppError('MODEL_GROUP_NOT_CONFIGURED', '分组未启用模型检测或未配置专用 Key', { status: 409 });
    const enabled = selected.filter(key => this.modelStore.effective(group, key).enabled);
    if (!enabled.length) throw new AppError('MODEL_CHANNEL_NOT_CONFIGURED', '该分组未选择可执行的模型检测渠道', { status: 409 });
    const runs = this.store.db.transaction(() => enabled.map(channel => modelRunSummary(this.modelStore.create(group, channel, trigger))))();
    if (trigger === 'scheduled') this.modelStore.advance(groupId);
    if (this.timer) this.pump();
    return runs;
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), this.config.schedulerPollSeconds * 1000);
    this.timer.unref?.();
    this.tick();
  }
  tick() {
    if (this.closed) return;
    try {
      if (this.modelStore.schedule().enabled) for (const group of this.modelStore.due()) this.enqueue(group.group_id, 'scheduled');
      this.pump();
    } catch (error) {
      console.error(JSON.stringify({ event: 'model_scheduler_failed', code: error.code || 'UNKNOWN' }));
    }
  }
  pump() {
    if (this.closed || this.active.size) return;
    this.modelStore.cancelObsolete();
    const run = this.modelStore.nextRunnable(channels.filter(channel => !this.modelStore.throttled(channel)));
    if (!run) return;
    const controller = new AbortController();
    const promise = this.execute(run, controller.signal).catch(() => {
      this.modelStore.finish(run.id, 'error', '模型检测执行异常，未自动重新提交', 'MODEL_EXECUTION_ERROR');
    }).finally(() => { this.active.delete(run.id); this.pump(); });
    this.active.set(run.id, { promise, controller });
  }

  async execute(run, closingSignal = new AbortController().signal) {
    const snapshot = JSON.parse(run.snapshot_json);
    const remaining = (snapshot.timeout_seconds || 1800) * 1000 - (run.started_at ? Date.now() - run.started_at : 0);
    const signal = AbortSignal.any([closingSignal, AbortSignal.timeout(Math.max(1, remaining))]);
    let stage = run.remote_id ? 'poll' : 'submit';
    let lastJson = '';
    const ensureCurrent = () => {
      if (signal.aborted) throw new Error('MODEL_TIMEOUT');
      if (!this.current(run)) throw new Error('MODEL_CONFIG_CHANGED');
    };
    try {
      if (remaining <= 0) throw new Error('MODEL_TIMEOUT');
      ensureCurrent();
      this.modelStore.markRunning(run.id);
      const targetKey = this.vault.decrypt(snapshot.target_key_context, snapshot.target_key_cipher);
      const siteKey = snapshot.key_cipher ? this.vault.decrypt(snapshot.key_context, snapshot.key_cipher) : '';
      const secrets = [targetKey, siteKey, snapshot.target_url, this.config.sub2apiBaseUrl, run.remote_id];
      const request = async (url, options) => {
        ensureCurrent();
        const result = await this.request(url, { ...options, apiKey: siteKey, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), maxResponseBytes: 2 * 1024 * 1024, secrets });
        ensureCurrent();
        return result;
      };
      const record = (response, terminal = false) => {
        const safe = sanitizeModelResponse(response, secrets);
        const value = JSON.stringify(safe);
        if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error('REVIEW_RESPONSE_TOO_LARGE');
        if (value !== lastJson || terminal) this.modelStore.updateResponse(run.id, safe, terminal ? 'completed' : 'running');
        lastJson = value;
        validateModelResponse(run.channel, response);
      };
      const terminal = response => run.channel === 'bazaarlink' ? ['completed', 'failed', 'aborted'].includes(response.status) : ['done', 'error'].includes(response.status);
      const finish = response => {
        const success = ['completed', 'done'].includes(response.status);
        record(response, true);
        this.modelStore.finish(run.id, success ? 'completed' : 'error', success ? '' : '检测网站返回任务失败，请查看逐项结果与脱敏响应', success ? '' : 'PROVIDER_TASK_FAILED');
      };
      if (this.config.demoMode) { finish(demoModelResponse(run.channel, run.model, snapshot.platform)); return; }
      let remoteId = run.remote_id;
      if (!remoteId) {
        await this.resolve(new URL(snapshot.target_url), signal);
        ensureCurrent();
        const body = run.channel === 'bazaarlink' ? {
          baseUrl: snapshot.target_url, apiKey: targetKey, modelId: run.model, claimedModel: run.model, sync: false,
          upstreamFormat: snapshot.upstream_format === 'auto' ? snapshot.platform === 'anthropic' ? 'anthropic' : 'openai' : snapshot.upstream_format,
          runContextCheck: true, lang: 'zh-CN'
        } : {
          url: snapshot.target_url, apiKey: targetKey, model: run.model,
          provider: snapshot.provider === 'auto' ? snapshot.platform === 'anthropic' ? 'claude' : 'codex' : snapshot.provider,
          attributionOnly: snapshot.attribution_only, checkTokenUsage: snapshot.check_token_usage, concurrency: 1
        };
        this.modelStore.markSubmitted(run.id);
        const response = await request(snapshot.api_url, { method: 'POST', body });
        remoteId = run.channel === 'bazaarlink' ? response.runId : response.taskId;
        if (typeof remoteId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(remoteId)) throw new Error('MODEL_RESPONSE_INVALID');
        this.modelStore.rememberRemote(run.id, remoteId);
        secrets.push(remoteId);
        if (terminal(response)) { finish(response); return; }
        record(response);
      }
      stage = 'poll';
      let failures = 0;
      while (!signal.aborted) {
        await delay(this.pollMs * Math.min(8, 2 ** failures), null, { signal });
        let response;
        try {
          response = await request(`${snapshot.api_url.replace(/\/$/, '')}/${encodeURIComponent(remoteId)}`, { method: 'GET' });
          failures = 0;
        } catch (error) {
          if (signal.aborted || error.message === 'MODEL_CONFIG_CHANGED' || (error.httpStatus && error.httpStatus < 500) || ['REVIEW_URL_UNSAFE', 'REVIEW_RESPONSE_INVALID', 'REVIEW_RESPONSE_TOO_LARGE'].includes(error.code) || ++failures > 5) throw error;
          continue;
        }
        const id = run.channel === 'bazaarlink' ? response.runId : response.taskId;
        if (id != null && id !== remoteId) throw new Error('MODEL_TASK_MISMATCH');
        if (!response.status) throw new Error('MODEL_RESPONSE_INVALID');
        if (terminal(response)) { finish(response); return; }
        record(response);
      }
      throw new Error('MODEL_TIMEOUT');
    } catch (error) {
      if (this.closed && this.modelStore.run(run.id)?.remote_id) return;
      if (error.httpStatus === 429) this.modelStore.throttle(run.channel, error.retryAfterSeconds || 3600);
      this.modelStore.finish(run.id, 'error', modelFailure(error, stage), String(error.code || (error.message?.startsWith('MODEL_') ? error.message : 'MODEL_REQUEST_FAILED')).slice(0, 80));
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map(active => active.promise));
  }
}

module.exports = { demoModelResponse, ModelDetection, modelFailure };
