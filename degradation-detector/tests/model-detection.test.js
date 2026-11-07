'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Store } = require('../src/store');
const { ModelStore } = require('../src/model-store');
const { ModelDetection } = require('../src/model-detection');
const { CredentialVault } = require('../src/credential-vault');
const { defaultModelPlatform, defaultSchedule, modelGroupContext, modelPlatformSchema, modelScheduleSchema } = require('../src/model-config');
const { sanitizeModelResponse } = require('../src/model-results');
const { testConfig } = require('./helpers');

function setup(t, dependencies = {}, schedule = defaultSchedule) {
  const config = testConfig(t);
  const store = new Store(config);
  const vault = new CredentialVault(config);
  const models = new ModelStore(store);
  const platform = defaultModelPlatform('openai', 'gpt-test');
  platform.enabled = true; platform.target_url = 'https://relay.example.com/v1';
  for (const key of ['bazaarlink', 'cctest']) {
    const channel = platform.channels[key];
    channel.enabled = true;
    channel.key_context = `model-site:openai:${key}`;
    channel.key_cipher = vault.encrypt(channel.key_context, `cct-site-secret-${key}-123456`);
  }
  models.save({ schedule, platforms: [{ id: 'openai', config: platform, groups: ['1','2'].map(id => ({ id, name: `Group ${id}`, enabled: true, models: id === '2' ? { cctest: 'gpt-custom' } : {}, keyCipher: vault.encrypt(modelGroupContext(id), `sk-model-dedicated-${id}-123456`), keyFingerprint: vault.fingerprint(`sk-model-dedicated-${id}-123456`) })) }] });
  const service = new ModelDetection({ config, store, modelStore: models, vault, resolve: async () => ({}), pollMs: 1, ...dependencies });
  t.after(async () => { await service.close(); store.close(); });
  return { config, store, vault, models, service, platform };
}

test('model configuration is opt-in, validates public targets, schedule and server-only fields', () => {
  assert.equal(defaultModelPlatform('openai').enabled, false);
  assert.equal(defaultSchedule.enabled, false);
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://10.0.0.2', 'https://[::1]', 'https://host.docker.internal', 'https://example.com:8080', 'https://user:pass@example.com', 'https://example.com?key=x']) {
    const candidate = defaultModelPlatform('openai'); candidate.target_url = url;
    assert.equal(modelPlatformSchema.safeParse(candidate).success, false, url);
  }
  const candidate = defaultModelPlatform('openai'); candidate.channels.cctest.key_cipher = 'injected';
  assert.equal(modelPlatformSchema.safeParse(candidate).success, false);
  assert.equal(modelScheduleSchema.safeParse({ enabled: true, mode: 'daily', times: ['09:30','21:30'], interval_minutes: 60 }).success, true);
  assert.equal(modelScheduleSchema.safeParse({ ...defaultSchedule, times: ['09:30','09:30'] }).success, false);
});

test('two channels use only dedicated keys, preserve every returned item, null and unknown fields', async t => {
  const calls = [];
  const { service, models, store } = setup(t, { request: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') return { runId: 'probe-1', taskId: 'check-1', status: 'running' };
    if (url.includes('/probe/')) return { runId: 'probe-1', status: 'completed', score: null, items: [true,false,'warning',null].map((passed, i) => ({ probeId: `item-${i}`, status: i === 3 ? 'error' : 'done', passed, response: `sk-model-dedicated-1-123456`, responseHeaders: { authorization: 'Bearer secret' }, extra: { nullValue: null } })), identityAssessment: { status: 'match', verdict: { status: 'clean_match_family_only', trueModel: null } }, userKey: 'private', startedByIp: '10.0.0.1', reportUrl: '/private', extraDiagnostics: [1,2,3] };
    return { taskId: 'check-1', status: 'done', total: 88, verdictKey: 'official_flawed', scores: { tag_check: 10, server_tool: 0, future_score: null }, tokenAudit: { rows: [{ inputTokens: 12, extra: 4 }, { outputTokens: 0, unknown: null }] } };
  } });
  const queued = service.enqueue('1');
  assert.equal(queued.length, 2);
  assert.deepEqual(service.enqueue('1').map(run => run.id), queued.map(run => run.id));
  for (const run of queued) await service.execute(models.run(run.id));
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  for (const post of posts) assert.equal(post.body.apiKey, 'sk-model-dedicated-1-123456');
  assert.equal(posts[0].body.upstreamFormat, 'openai');
  assert.equal(posts[0].body.sync, false);
  assert.equal(posts[1].body.provider, 'codex');
  assert.match(posts[1].apiKey, /^cct-site-secret-cctest/);
  const probe = models.run(queued[0].id);
  const response = JSON.parse(probe.response_json);
  assert.equal(probe.status, 'completed');
  assert.equal(probe.conclusion, 'clean_match_family_only');
  assert.equal(probe.item_count, 4);
  assert.equal(probe.total, null);
  assert.equal(response.identityAssessment.verdict.trueModel, null);
  assert.deepEqual(response.items.map(item => item.passed), [true,false,'warning',null]);
  assert.equal(response.items[0].response, '[已隐藏]');
  assert.equal(response.items[0].responseHeaders, '[已隐藏]');
  assert.deepEqual(response.extraDiagnostics, [1,2,3]);
  assert.equal(JSON.parse(models.run(queued[1].id).response_json).tokenAudit.rows.length, 2);
  assert.equal(models.run(queued[1].id).total, 88);
  const bytes = store.db.serialize();
  assert.equal(bytes.includes(Buffer.from('sk-model-dedicated-1-123456')), false);
  assert.equal(bytes.includes(Buffer.from('cct-site-secret-cctest-123456')), false);
  assert.equal(models.effective(models.group('2'), 'cctest').model, 'gpt-custom');
});

test('polling reconnects five times without replaying POST, and ambiguous submissions are never retried', async t => {
  let posts = 0; let gets = 0;
  const { service, models } = setup(t, { request: async (_url, options) => {
    if (options.method === 'POST') { posts++; return { runId: 'reconnect-1' }; }
    if (++gets <= 5) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
    return { runId: 'reconnect-1', status: 'completed', items: [] };
  } });
  const run = service.enqueue('1', 'manual', ['bazaarlink'])[0];
  await service.execute(models.run(run.id));
  assert.equal(models.run(run.id).status, 'completed');
  assert.equal(posts, 1); assert.equal(gets, 6);
  let attempts = 0;
  service.request = async () => { attempts++; throw Object.assign(new Error('disconnected'), { code: 'ECONNRESET' }); };
  const next = service.enqueue('1', 'manual', ['bazaarlink'])[0];
  await service.execute(models.run(next.id));
  assert.equal(attempts, 1);
  assert.match(models.run(next.id).reason, /未自动重发/);
});

test('restart resumes only known remote tasks, never regenerates a request with unknown submission outcome', async t => {
  const calls = [];
  const { models, store, service } = setup(t, { request: async (_url, options) => { calls.push(options.method); return { taskId: 'resume-1', status: 'done', scores: {}, total: null }; } });
  const queued = service.enqueue('1');
  models.markRunning(queued[0].id); models.markSubmitted(queued[0].id);
  models.markRunning(queued[1].id); models.rememberRemote(queued[1].id, 'resume-1');
  const unsent = service.enqueue('2', 'manual', ['bazaarlink'])[0];
  new ModelStore(store);
  assert.equal(models.run(queued[0].id).status, 'error');
  assert.match(models.run(queued[0].id).reason, /未自动重发/);
  assert.equal(models.run(unsent.id).status, 'queued', 'an unsubmitted queued task is safe to continue');
  await service.execute(models.run(queued[1].id));
  assert.deepEqual(calls, ['GET']);
  assert.equal(models.run(queued[1].id).status, 'completed');
});

test('mismatched task IDs, HTTP errors, expired tasks, config changes and timeouts cannot become matches', async t => {
  const { service, models, platform } = setup(t, { request: async (_url, options) => options.method === 'POST' ? { runId: 'task-1' } : { runId: 'other-task', status: 'completed', items: [] } });
  const run = service.enqueue('1', 'manual', ['bazaarlink'])[0];
  await service.execute(models.run(run.id));
  assert.equal(models.run(run.id).error_code, 'MODEL_TASK_MISMATCH');
  service.request = async () => { throw Object.assign(new Error('HTTP'), { httpStatus: 429, retryAfterSeconds: 120 }); };
  const next = service.enqueue('1', 'manual', ['bazaarlink'])[0];
  await service.execute(models.run(next.id));
  assert.equal(models.throttled('bazaarlink'), true);
  assert.equal(models.run(next.id).conclusion, 'error');
  const stopped = service.enqueue('1', 'manual', ['cctest'])[0];
  models.db.prepare('UPDATE model_groups SET enabled=0 WHERE group_id=?').run('1');
  await service.execute(models.run(stopped.id));
  assert.equal(models.run(stopped.id).error_code, 'MODEL_CONFIG_CHANGED');
  const expired = models.create(models.group('2'), 'cctest', 'manual');
  models.markRunning(expired.id); models.rememberRemote(expired.id, 'expired-1');
  service.request = async () => { throw Object.assign(new Error('not found'), { httpStatus: 404 }); };
  await service.execute(models.run(expired.id));
  assert.match(models.run(expired.id).reason, /过期/);
  const timed = models.create(models.group('2'), 'cctest', 'manual');
  models.db.prepare('UPDATE model_runs SET started_at=? WHERE id=?').run(Date.now() - (platform.timeout_seconds + 1) * 1000, timed.id);
  await service.execute(models.run(timed.id));
  assert.match(models.run(timed.id).reason, /超时/);
});

test('model scheduling is independent, manual runs preserve schedule, and submission quota survives history deletion', t => {
  const { service, models, store } = setup(t, {}, { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 60 });
  const iqSchedule = store.getServiceSettings();
  const next = models.group('1').next_run_at;
  service.enqueue('1', 'manual', ['bazaarlink']);
  assert.equal(models.group('1').next_run_at, next);
  assert.equal(store.getServiceSettings().schedule_interval_minutes, iqSchedule.schedule_interval_minutes);
  for (let i = 0; i < 30; i++) {
    const row = models.active('1','bazaarlink') || models.create(models.group('1'), 'bazaarlink', 'manual');
    models.markSubmitted(row.id); models.finish(row.id, 'error');
  }
  models.deleteHistory('1', 'bazaarlink', null);
  assert.equal(models.throttled('bazaarlink'), true);
  assert.equal(models.throttled('cctest'), false);
  assert.equal(models.counts('1','bazaarlink').total, 0);
});

test('history is scoped by group and channel, preserves active runs and retires details separately from IQ', async t => {
  const { service, models, store } = setup(t);
  for (let i = 0; i < 75; i++) {
    const row = models.create(models.group('1'), 'bazaarlink', 'manual');
    models.updateResponse(row.id, { status: 'completed', items: [], extra: i }, 'completed'); models.finish(row.id, 'completed');
  }
  const other = models.create(models.group('2'), 'cctest', 'manual'); models.finish(other.id, 'completed');
  assert.equal(models.deleteHistory('1','bazaarlink',[other.id]), null);
  const active = service.enqueue('1', 'manual', ['cctest'])[0];
  assert.equal(models.deleteHistory('1','cctest',[active.id]), null);
  assert.deepEqual(await models.maintain({ enabled: true, history_days: 90, history_per_group: 60, artifact_per_group: 60 }), { archived: 15, pending: false });
  assert.deepEqual(models.counts('1','bazaarlink'), { total: 60, archived: 15 });
  assert.equal(models.run(other.id).status, 'completed');
  assert.equal(models.run(active.id).status, 'queued');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  assert.equal(models.deleteHistory('1','bazaarlink',null), 60);
  assert.equal(models.counts('1','bazaarlink').archived, 0);
});

test('malformed item arrays are retained as diagnostics and cannot produce a matching conclusion', async t => {
  const { service, models } = setup(t, { request: async (_url, options) => options.method === 'POST' ? { runId: 'malformed-1' } : { status: 'completed', items: [null, 0, { passed: true }], identityAssessment: { verdict: { status: 'clean_match' } } } });
  const run = service.enqueue('1', 'manual', ['bazaarlink'])[0];
  await service.execute(models.run(run.id));
  const saved = models.run(run.id);
  assert.equal(saved.status, 'error');
  assert.equal(saved.error_code, 'MODEL_RESPONSE_INVALID');
  assert.equal(saved.conclusion, 'error');
  assert.deepEqual(JSON.parse(saved.response_json).items, [null, 0, { passed: true }]);
});

test('maintenance limits work per group and continues across group batches without removing active tasks', async t => {
  const { models } = setup(t);
  for (let i = 0; i < 470; i++) {
    const row = models.create(models.group('1'), 'bazaarlink', 'manual');
    models.updateResponse(row.id, { status: 'completed', items: [] }, 'completed');
    models.finish(row.id, 'completed');
  }
  const policy = { enabled: true, history_days: 90, history_per_group: 60, artifact_per_group: 60 };
  assert.deepEqual(await models.maintain(policy), { archived: 200, pending: true });
  assert.deepEqual(await models.maintain(policy), { archived: 200, pending: true });
  assert.deepEqual(await models.maintain(policy), { archived: 10, pending: false });
  for (let i = 0; i < 24; i++) {
    models.db.prepare('INSERT INTO model_runs(group_id,channel,model,trigger_type,status,snapshot_json,revision,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`new-${i}`, 'cctest', 'model', 'manual', 'completed', '{}', 'test', Date.now());
  }
  assert.equal((await models.maintain(policy)).pending, true);
  assert.equal((await models.maintain(policy)).pending, false);
  assert.equal(models.counts('1', 'bazaarlink').total, 60);
});

test('response sanitization preserves zero, null, all results and diagnostics but blocks operational credentials', () => {
  const safe = sanitizeModelResponse({ items: [{ passed: false, response: 'apiKey=the-real-secret; <script>unsafe()</script>', usage: { totalTokens: 0 }, responseHeaders: { cookie: 'session' } }], userKey: 'private', api_key: 'private', baseUrl: 'https://secret.example.com', startedByIp: '127.0.0.1', client_ip: 'fd00::12', remoteIp: '2001:db8::1', extra: null }, ['the-real-secret']);
  assert.equal(safe.items[0].passed, false); assert.equal(safe.items[0].usage.totalTokens, 0); assert.equal(safe.extra, null);
  assert.doesNotMatch(JSON.stringify(safe), /the-real-secret|session|127\.0\.0\.1|secret\.example/);
  assert.match(safe.items[0].response, /<script>/);
  assert.equal(safe.client_ip, '[已隐藏]'); assert.equal(safe.remoteIp, '[已隐藏]');
});
