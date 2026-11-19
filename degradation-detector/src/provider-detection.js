'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { AppError } = require('./errors');
const { channels, names, configurationSchema, keyContext, providerFor, providerPlatform, validateEffective } = require('./provider-config');
const { cleanManxue, cleanReport, runSummary } = require('./provider-results');
const { requestReviewJson, resolveReviewAddress } = require('./review-http');
const { waitForTestLLM } = require('./provider-http');

const fail = (code, message, status = 400) => new AppError(code, message, { status });
const remoteId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
function failure(error, stage) {
  const code = error.code || error.message;
  if (code === 'PROVIDER_CONFIG_CHANGED') return '配置已变更或停用，任务已停止';
  if (error.httpStatus === 429) return '第三方限流，已暂停该服务的新提交；本次未自动重发';
  if (stage === 'submit') return '提交未取得可确认的任务编号，未自动重发；请核对第三方任务后再检测';
  if (error.httpStatus === 404) return '第三方任务已失效或不存在，保留已取得的结果';
  if (code === 'REVIEW_URL_UNSAFE') return '检测服务或上游地址未通过公网校验';
  if (['REVIEW_TIMEOUT', 'PROVIDER_TIMEOUT'].includes(code) || error.name === 'AbortError' || error.name === 'TimeoutError') return '检测超时，保留已取得的结果；未重复提交';
  if (code === 'PROVIDER_REMOTE_FAILED') return '第三方检测失败，保留已取得的结果';
  return '第三方响应异常或不符合接入协议，保留已取得的结果';
}

class ProviderDetection {
  constructor({ config, providerStore, vault, request = requestReviewJson, events = waitForTestLLM, resolve = resolveReviewAddress, pollMs = 3000 }) {
    Object.assign(this, { config, providerStore, vault, request, events, resolve, pollMs });
    this.active = new Map();
    this.timer = null;
    this.closed = false;
  }
  prepareConfiguration(body, discovered) {
    const parsed = configurationSchema.safeParse(body);
    if (!parsed.success) throw fail('VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；').slice(0, 1500));
    const previous = this.providerStore.configuration();
    const input = { ...parsed.data, platforms: parsed.data.platforms ?? previous.platforms,
      provider_platforms: parsed.data.provider_platforms ?? previous.provider_platforms };
    if (input.revision !== previous.revision) throw fail('PROVIDER_CONFIG_CONFLICT', '配置已被其他管理员修改，请刷新后重试', 409);
    const changedPlatforms = new Set();
    const platformIds = new Set();
    for (const platform of input.platforms) {
      if (platformIds.has(platform.id)) throw fail('VALIDATION_ERROR', '平台配置不能重复');
      platformIds.add(platform.id);
      const old = previous.platforms.find(item => item.id === platform.id);
      if (JSON.stringify(platform.params) !== JSON.stringify(old?.params)) changedPlatforms.add(platform.id);
    }
    for (const old of previous.platforms) if (!platformIds.has(old.id)) changedPlatforms.add(old.id);
    const scopes = new Set();
    for (const scope of input.provider_platforms) {
      const identity = `${scope.provider}:${scope.id}`;
      if (scopes.has(identity)) throw fail('VALIDATION_ERROR', '同一检测平台下的 AI 平台配置不能重复');
      scopes.add(identity);
      if (scope.enabled && input.providers[scope.provider].enabled) {
        const invalid = validateEffective(scope.provider === 'manxue' ? 'candy' : 'testllm', scope.params);
        if (invalid) throw fail('VALIDATION_ERROR', `${scope.provider} / ${scope.id}：${invalid}`);
        if (scope.tests && !Object.values(scope.tests).some(Boolean)) throw fail('VALIDATION_ERROR', '启用的满血 AI 平台至少需要选择一项检测');
      }
    }
    for (const [id, provider] of Object.entries(input.providers)) if (provider.enabled && !provider.api_url) throw fail('VALIDATION_ERROR', `${id} 必须配置检测接口地址`);
    const available = new Map(discovered.map(group => [String(group.id), group]));
    const seen = new Set();
    const records = [];
    for (const choice of input.groups) {
      const found = available.get(choice.id);
      const pair = `${choice.channel}:${choice.id}`;
      if (!found || seen.has(pair)) throw fail('GROUP_NOT_AVAILABLE', '分组无权访问或存在重复配置');
      seen.add(pair);
      const old = this.providerStore.group(choice.id, choice.channel);
      const reusable = old?.platform === found.platform ? old : null;
      const scoped = providerPlatform(input, providerFor(choice.channel), found.platform);
      const group = {
        group_id: choice.id, channel: choice.channel, platform: found.platform, group_name: found.name,
        enabled: choice.enabled ? 1 : 0, override_json: choice.override && (scoped || !platformIds.has(found.platform) && !changedPlatforms.has(found.platform)) ? JSON.stringify(choice.override) : null,
        key_cipher: reusable?.key_cipher || null, key_fingerprint: reusable?.key_fingerprint || null,
        group_enabled: choice.group_enabled === undefined ? reusable?.group_enabled ?? 1 : choice.group_enabled ? 1 : 0,
        schedule_json: Object.hasOwn(choice, 'schedule_override') ? choice.schedule_override ? JSON.stringify(choice.schedule_override) : null : reusable?.schedule_json || null
      };
      if (choice.key && choice.clear_key) throw fail('VALIDATION_ERROR', '不能同时设置和清除 Key');
      if (choice.clear_key) { group.key_cipher = null; group.key_fingerprint = null; }
      if (choice.key) {
        group.key_cipher = this.vault.encrypt(keyContext(choice.channel, choice.id), choice.key);
        group.key_fingerprint = this.vault.fingerprint(choice.key);
      }
      const effective = this.providerStore.effective(group, input);
      if (effective.enabled) {
        const invalid = validateEffective(choice.channel, effective);
        if (invalid) throw fail('VALIDATION_ERROR', `${found.name} / ${names[choice.channel]}：${invalid}`);
        if (!group.key_cipher) throw fail('PROVIDER_KEY_REQUIRED', `${found.name} / ${names[choice.channel]}：请配置分组专用 Key`);
        this.vault.decrypt(keyContext(choice.channel, choice.id), group.key_cipher);
      }
      records.push(group);
    }
    // Include records outside the current administrator's visible groups in duplicate-key protection.
    const fingerprints = new Map();
    const omitted = this.providerStore.groups().filter(group => !seen.has(`${group.channel}:${group.group_id}`))
      .map(group => !providerPlatform(input, providerFor(group.channel), group.platform) && (changedPlatforms.has(group.platform) || platformIds.has(group.platform)) ? { ...group, override_json: null } : group);
    for (const group of [...omitted, ...records]) {
      const effective = this.providerStore.effective(group, input);
      if (effective.enabled) {
        const invalid = validateEffective(group.channel, effective);
        if (invalid) throw fail('VALIDATION_ERROR', `${names[group.channel]}：${invalid}`);
        if (!group.key_cipher) throw fail('PROVIDER_KEY_REQUIRED', `${names[group.channel]}：请配置分组专用 Key`);
        this.vault.decrypt(keyContext(group.channel, group.group_id), group.key_cipher);
      }
      if (!group.key_fingerprint) continue;
      const identity = `${group.channel}:${group.key_fingerprint}`;
      if (fingerprints.has(identity) && fingerprints.get(identity) !== group.group_id) throw fail('PROVIDER_KEY_DUPLICATED', '同一检测类别的不同分组不能共用专用 Key');
      fingerprints.set(identity, group.group_id);
    }
    return { input, groups: [...records, ...omitted.filter(group => changedPlatforms.has(group.platform) || platformIds.has(group.platform))] };
  }
  enqueue(id, channel, trigger = 'manual') {
    if (this.closed) throw fail('PROVIDER_CLOSED', '检测服务正在关闭', 503);
    const group = this.providerStore.group(id, channel);
    if (!group || !this.providerStore.enabled(group)) throw fail('PROVIDER_GROUP_NOT_CONFIGURED', '该分组未启用此检测或缺少有效专用 Key', 409);
    if (this.providerStore.throttled(channel)) throw fail('PROVIDER_THROTTLED', '第三方处于限流等待期，请稍后再试', 429);
    const run = this.providerStore.create(group, trigger);
    if (trigger === 'scheduled') this.providerStore.advance(group);
    if (this.timer) {
      if (this.providerStore.db.inTransaction) setImmediate(() => this.pump());
      else this.pump();
    }
    return runSummary(run);
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.schedulerPollSeconds * 1000);
    this.timer.unref?.();
    this.tick();
  }
  tick() {
    if (this.closed) return;
    try {
      for (const group of this.providerStore.due()) {
        if (!this.providerStore.enabled(group)) { this.providerStore.advance(group); continue; }
        if (!this.providerStore.throttled(group.channel)) this.enqueue(group.group_id, group.channel, 'scheduled');
      }
      this.pump();
    } catch (error) { console.error(JSON.stringify({ event: 'provider_scheduler_failed', code: error.code || 'UNKNOWN' })); }
  }
  pump() {
    if (this.closed) return;
    const config = this.providerStore.configuration();
    for (const run of this.providerStore.queued()) {
      if (this.active.has(run.id)) continue;
      if (!this.providerStore.current(run)) { this.providerStore.finish(run.id, 'error', '配置已变更或停用，任务已停止', 'PROVIDER_CONFIG_CHANGED'); continue; }
      if (this.active.size >= this.config.concurrency) break;
      if (this.providerStore.throttled(run.channel) && !Object.keys(JSON.parse(run.parts_json)).length) continue;
      const scope = this.providerStore.concurrencyScope(run, config);
      if ([...this.active.values()].filter(item => item.scope === scope.id).length >= scope.limit) continue;
      const controller = new AbortController();
      const promise = this.execute(run, controller).catch(() => {
        this.providerStore.finish(run.id, 'error', '检测执行异常', 'PROVIDER_INTERNAL');
      }).finally(() => { this.active.delete(run.id); if (!this.closed) this.pump(); });
      this.active.set(run.id, { channel: run.channel, scope: scope.id, controller, promise });
    }
  }
  configurationChanged() {
    for (const [id, task] of this.active) if (!this.providerStore.current(this.providerStore.run(id))) task.controller.abort(new Error('PROVIDER_CONFIG_CHANGED'));
    if (this.timer) this.pump();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map(task => task.promise));
  }
  async execute(original, controller = new AbortController()) {
    const store = this.providerStore;
    if (!store.current(original)) { store.finish(original.id, 'error', '配置已变更或停用，任务已停止', 'PROVIDER_CONFIG_CHANGED'); return; }
    store.markRunning(original.id);
    const run = store.run(original.id);
    const snapshot = JSON.parse(run.snapshot_json);
    const remaining = snapshot.timeout_seconds * 1000 - (Date.now() - run.started_at);
    if (remaining <= 0) { store.finish(run.id, 'error', '检测超时；未重复提交', 'PROVIDER_TIMEOUT'); return; }
    const timeout = setTimeout(() => controller.abort(new Error('PROVIDER_TIMEOUT')), remaining);
    const signal = controller.signal;
    let stage = 'prepare';
    const response = JSON.parse(run.response_json || '{}');
    try {
      if (this.config.demoMode) {
        store.response(run.id, demoResponse(run.channel));
        store.finish(run.id, 'completed', '演示数据，未调用真实第三方');
        return;
      }
      await this.resolve(new URL(snapshot.api_url), signal);
      await this.resolve(new URL(snapshot.target_url), signal);
      const key = this.vault.decrypt(snapshot.key_context, snapshot.key_cipher);
      const check = () => {
        signal.throwIfAborted();
        if (!store.current(run)) throw new Error('PROVIDER_CONFIG_CHANGED');
      };
      const json = async (url, options) => {
        check();
        return this.request(url, { ...options, signal, secrets: [key], maxResponseBytes: 2 * 1024 * 1024 });
      };
      const read = async fn => {
        for (let retry = 0; ; retry++) {
          try { check(); return await fn(); } catch (error) {
            if (retry >= 3 || error.httpStatus && error.httpStatus < 500 || signal.aborted || !store.current(run)) throw error;
            await delay(this.pollMs * (retry + 1), undefined, { signal });
          }
        }
      };
      const modes = run.channel === 'testllm' ? ['iq', ...(snapshot.cache_test ? ['cache'] : []), ...(snapshot.thinking_test ? ['think'] : [])] : [run.channel];
      for (const mode of modes) {
        let part = JSON.parse(store.run(run.id).parts_json)[mode];
        if (part?.state === 'done' || part?.state === 'error') continue;
        if (part?.state === 'submitting') throw new Error('PROVIDER_SUBMISSION_UNKNOWN');
        let data;
        if (!part?.remote_id) {
          stage = 'submit';
          check();
          if (store.throttled(run.channel)) throw new Error('PROVIDER_THROTTLED');
          store.part(run.id, mode, { state: 'submitting' });
          const body = run.channel === 'testllm'
            ? { protocol: snapshot.protocol, base_url: snapshot.target_url, api_key: key, model: snapshot.model, mode }
            : { benchmark: mode, base_url: snapshot.target_url, api_key: key, model: snapshot.model, reasoning_effort: snapshot.reasoning_effort, ...(snapshot.service_tier ? { service_tier: snapshot.service_tier } : {}) };
          data = await json(run.channel === 'testllm' ? `${snapshot.api_url}/api/detect` : snapshot.api_url, { method: 'POST', body, taskKey: `degradation-${run.channel}-${run.id}-${mode}` });
          const id = remoteId(run.channel === 'testllm' ? data.job_id : data.id);
          if (!id) throw new Error('PROVIDER_RESPONSE_INVALID');
          part = { state: 'submitted', remote_id: id };
          store.part(run.id, mode, part);
          if (run.channel !== 'testllm' && data.status == null) data = null;
        }
        stage = 'poll';
        check();
        if (run.channel === 'testllm') {
          try {
            const reportUrl = `${snapshot.api_url}/api/reports/${part.remote_id}`;
            let report;
            // Reports are durable; after a restart try the saved job's report before reconnecting to events.
            try { report = await json(reportUrl, { method: 'GET' }); } catch (error) { if (error.httpStatus !== 404) throw error; }
            if (!report) {
              await read(() => this.events(`${snapshot.api_url}/api/jobs/${part.remote_id}/events`, { signal }));
              report = await read(() => json(reportUrl, { method: 'GET' }));
            }
            if (report.id != null && report.id !== part.remote_id || report.job_id != null && report.job_id !== part.remote_id) throw new Error('PROVIDER_TASK_MISMATCH');
            response[mode] = cleanReport(report, mode);
            store.response(run.id, response);
            store.part(run.id, mode, { ...part, state: 'done' });
          } catch (error) {
            if (signal.aborted || !store.current(run) || error.httpStatus === 429) throw error;
            response.errors ||= {};
            response.errors[mode] = failure(error, stage);
            store.response(run.id, response);
            store.part(run.id, mode, { ...part, state: 'error' });
          }
        } else {
          while (true) {
            if (!data) data = await read(() => json(`${snapshot.api_url}/${part.remote_id}`, { method: 'GET' }));
            if (data.id != null && data.id !== part.remote_id || data.benchmark != null && data.benchmark !== mode) throw new Error('PROVIDER_TASK_MISMATCH');
            if (data.status === 'succeeded') {
              store.response(run.id, cleanManxue(data, [key]));
              store.part(run.id, mode, { ...part, state: 'done' });
              break;
            }
            if (['failed', 'error', 'cancelled', 'canceled'].includes(data.status)) throw new Error('PROVIDER_REMOTE_FAILED');
            if (!['queued', 'pending', 'running'].includes(data.status)) throw new Error('PROVIDER_RESPONSE_INVALID');
            await delay(this.pollMs, undefined, { signal });
            data = null;
          }
        }
      }
      check();
      const partial = run.channel === 'testllm' && Object.keys(response.errors || {}).length;
      store.finish(run.id, run.channel === 'testllm' && !response.iq ? 'error' : 'completed', partial ? '部分检测未取得结果，详见各项记录' : '');
    } catch (error) {
      if (this.closed) return;
      if (error.httpStatus === 429 || error.httpStatus === 503) store.throttle(providerFor(run.channel), error.retryAfterSeconds || 60);
      const changed = !store.current(run);
      const cause = changed ? new Error('PROVIDER_CONFIG_CHANGED') : signal.aborted ? signal.reason || error : error;
      store.finish(run.id, 'error', failure(cause, changed ? 'poll' : stage), typeof cause.code === 'string' ? cause.code : /^PROVIDER_[A-Z_]+$/.test(cause.message) ? cause.message : 'PROVIDER_FAILED');
    } finally { clearTimeout(timeout); }
  }
}

function demoResponse(channel) {
  if (channel === 'candy') return { status: 'succeeded', candy: { status: 'passed', answer: '9', duration_ms: 42000, input_tokens: 4300, output_tokens: 1000 }, prompt: null };
  if (channel === 'pelican') return { status: 'succeeded', assessment: { quality: 'normal', label: '正常', reason: '演示作品，非真实检测' }, result: { html: '<!doctype html><html><body><h1>演示作品</h1><p>未调用第三方检测</p></body></html>' }, prompt: null };
  return { iq: { level: 'excellent', duration: 18.2, timeout: false }, cache: { supported: true, total: 4, hit_rate: 87.5, request_hit_rate: 75, duration: 6 }, think: { has_thinking: true, has_signature: true, duration: 3.2 } };
}

module.exports = { ProviderDetection, demoResponse, failure };
