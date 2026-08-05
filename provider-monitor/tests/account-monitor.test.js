const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { Sub2ApiAdminClient } = require('../src/services/sub2api-admin-client');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const {
  AccountMonitorService,
  CHALLENGE_EXPECTED,
  createCapabilityChallenge,
  scoreCapabilityChallenge,
  scoreChallenge
} = require('../src/services/account-monitor-service');

function answerCapabilityPrompt(prompt) {
  const arithmetic = prompt.match(/Arithmetic: calculate (\d+) \* (\d+) - (\d+)\./);
  const sequence = prompt.match(/Sequence: give the next number in ([\d, ]+)\./);
  const sorting = prompt.match(/Sort: sort \[([\d, ]+)\] in descending order\./);
  const checksum = prompt.match(/Checksum: concatenate the uppercase first letters of ([a-z, ]+)\./);
  assert.ok(arithmetic && sequence && sorting && checksum, 'dynamic capability prompt must be parseable');
  const sequenceValues = sequence[1].split(',').map((value) => Number(value.trim()));
  const lastDifference = sequenceValues.at(-1) - sequenceValues.at(-2);
  return JSON.stringify({
    arithmetic: Number(arithmetic[1]) * Number(arithmetic[2]) - Number(arithmetic[3]),
    logic: 'NO',
    sequence: sequenceValues.at(-1) + lastDifference + 2,
    sorted: sorting[1].split(',').map((value) => Number(value.trim()))
      .sort((left, right) => right - left),
    checksum: checksum[1].split(',').map((word) => word.trim()[0].toUpperCase()).join('')
  });
}

function insertMonitoredAccount(db, account) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'active', 1, '{}', ?, ?)
  `).run(String(account.id), account.name, account.platform, account.type, now, now);
}

function createSub2ApiMock() {
  const calls = [];
  let usageReturned = false;
  return {
    calls,
    authenticationStatus() {
      return { available: true, source: 'test' };
    },
    async adminToken() {
      calls.push({ type: 'auth' });
      return 'test-admin-token';
    },
    async listAll(endpoint, query) {
      calls.push({ type: 'list', endpoint, query });
      if (endpoint === '/api/v1/admin/accounts') {
        return {
          items: [
            {
              id: 11,
              name: 'OpenAI Fast',
              platform: 'openai',
              type: 'oauth',
              status: 'active',
              schedulable: true,
              priority: 10,
              credentials: { access_token: 'must-not-be-stored' }
            },
            {
              id: 12,
              name: 'Claude Pool',
              platform: 'anthropic',
              type: 'oauth',
              status: 'active',
              schedulable: true
            }
          ],
          total: 2,
          truncated: false
        };
      }
      if (endpoint === '/api/v1/admin/usage') {
        if (usageReturned) return { items: [], total: 0, truncated: false };
        usageReturned = true;
        return {
          items: [
            {
              id: 101,
              account_id: 11,
              request_id: 'request-101',
              model: 'gpt-5.4',
              upstream_model: 'gpt-5.4',
              stream: true,
              duration_ms: 4200,
              first_token_ms: 1200,
              input_tokens: 100,
              output_tokens: 300,
              cache_read_tokens: 900,
              cache_creation_tokens: 0,
              actual_cost: 0.02,
              created_at: new Date(Date.now() - 60000).toISOString()
            },
            {
              id: 102,
              account_id: 11,
              request_id: 'request-102',
              model: 'gpt-5.4',
              stream: true,
              duration_ms: 5000,
              first_token_ms: 1800,
              input_tokens: 100,
              output_tokens: 320,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              actual_cost: 0.03,
              created_at: new Date(Date.now() - 30000).toISOString()
            },
            {
              id: 103,
              account_id: 11,
              request_id: 'request-103',
              model: 'gpt-5.4',
              stream: false,
              duration_ms: 50,
              first_token_ms: 0,
              output_tokens: 100,
              created_at: new Date(Date.now() - 15000).toISOString()
            }
          ],
          total: 3,
          truncated: false
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    async sse(endpoint, options) {
      calls.push({ type: 'sse', endpoint, body: options.body });
      await options.onEvent({ type: 'test_start', model: options.body.model_id || 'default-test-model' });
      if (endpoint.includes('/11/')) {
        assert.match(options.body.prompt, /LOCALCAP2 challenge/);
        const answer = answerCapabilityPrompt(options.body.prompt);
        await options.onEvent({ type: 'content', text: answer.slice(0, 30) });
        await options.onEvent({ type: 'content', text: answer.slice(30) });
      } else {
        assert.equal(options.body.prompt, '');
        await options.onEvent({ type: 'content', text: 'healthy' });
      }
      await options.onEvent({ type: 'test_complete', success: true });
      return { eventCount: 4, bytes: 100 };
    }
  };
}

test('account monitor syncs redacted metrics and scores dynamic capability probes', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const sub2api = createSub2ApiMock();
  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api });

  const sync = await monitor.sync();
  assert.equal(sync.accountCount, 2);
  assert.equal(sync.fetchedSampleCount, 3);
  assert.deepEqual(sync.truncatedDates, []);
  const usageCalls = sub2api.calls.filter((call) => call.endpoint === '/api/v1/admin/usage');
  assert.ok(usageCalls.length > 1);
  assert.ok(usageCalls.every((call) => call.query.start_date === call.query.end_date));
  assert.doesNotMatch(
    context.db.prepare('SELECT metadata_json FROM sub2api_monitored_accounts WHERE account_id = ?').get('11').metadata_json,
    /must-not-be-stored/
  );

  const listing = monitor.accounts({ platform: 'openai', days: 7 });
  assert.equal(listing.items.length, 1);
  assert.deepEqual(listing.platforms, ['anthropic', 'openai']);
  assert.equal(listing.items[0].metrics.requestCount, 3);
  assert.equal(listing.items[0].metrics.cacheRate, 81.8);
  assert.equal(listing.items[0].metrics.ttftP50Ms, 1200);
  assert.equal(listing.items[0].metrics.ttftP95Ms, 1800);
  assert.equal(listing.items[0].metrics.ttftSampleCount, 2);
  assert.ok(listing.items[0].metrics.outputTokensPerSecond >= 100);

  const probe = await monitor.probe({ accountIds: ['11', '12'], triggerType: 'manual' });
  assert.equal(probe.accountCount, 2);
  assert.equal(probe.succeeded, 2);
  assert.equal(probe.results[0].intelligenceScore, 100);
  assert.equal(probe.results[0].instructionScore, 100);
  assert.equal(probe.results[0].suite, 'capability_v2');
  assert.equal(probe.results[0].details.challengeVersion, 2);
  assert.equal(probe.results[1].suite, 'connectivity_v1');
  assert.equal(probe.results[1].intelligenceScore, null);
  assert.equal(monitor.accounts({ platform: 'anthropic', days: 7 }).items[0].metrics.intelligenceScore, null);

  const detail = monitor.account('11', { days: 7 });
  assert.equal(detail.probes.length, 1);
  assert.equal(detail.metrics.probeSuccessRate, 100);
  assert.equal(detail.metrics.intelligenceScore, 100);
  assert.ok(detail.metrics.qualityScore > 90);
});

test('account quality compares mapped provider logs and same-window upstream cost', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Mapped New API',
    adapterType: 'new-api',
    baseUrl: 'https://mapped-provider.example',
    authMode: 'system_token',
    remoteUserId: 'provider-user',
    credentials: { systemToken: 'not-stored-in-samples' }
  });
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  insertMonitoredAccount(context.db, {
    id: 501,
    name: 'Mapped account',
    platform: 'openai',
    type: 'apikey'
  });
  context.db.prepare(`
    INSERT INTO remote_accounts(
      id, connection_id, remote_id, display_name, status, metadata_json,
      first_seen_at, last_seen_at
    ) VALUES ('remote-account', ?, 'provider-user', 'Provider user', 'active', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_account_id, remote_id, name, masked_key,
      status, unlimited, currency, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('mapped-key', ?, 'remote-account', '77', 'Mapped key', 'sk-...test',
      'enabled', 0, 'USD', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapped-account-link', ?, 'mapped-key', 1, 501, 1, 'primary',
      1, '[]', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO provider_request_log_sync_state(
      connection_id, status, coverage_from, coverage_to, truncated,
      total_count, last_synced_at, updated_at
    ) VALUES (?, 'succeeded', ?, ?, 0, 2, ?, ?)
  `).run(provider.id, iso(7 * 24 * 60), iso(1), iso(1), iso(1));

  const insertBase = context.db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, account_id, request_id, model, stream, duration_ms,
      first_token_ms, input_tokens, output_tokens, cache_creation_tokens,
      cache_read_tokens, actual_cost, created_at, ingested_at
    ) VALUES (?, '501', ?, 'gpt-test', 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  insertBase.run('base-1', 'request-1', 2200, 800, 100, 100, 100, 0.02, iso(40), iso(1));
  insertBase.run('base-2', 'request-2', 2800, 1200, 100, 120, 0, 0.02, iso(20), iso(1));
  const insertUpstream = context.db.prepare(`
    INSERT INTO provider_request_samples(
      connection_id, key_id, source_log_id, request_id, model, stream, status,
      duration_ms, first_token_ms, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, actual_cost, currency,
      created_at, ingested_at
    ) VALUES (?, 'mapped-key', ?, ?, 'gpt-test', 1, 'success', ?, ?, ?, ?, 0, ?, ?, 'USD', ?, ?)
  `);
  insertUpstream.run(provider.id, 'provider-1', 'request-1', 1800, 700, 100, 100, 100, 0.01, iso(40), iso(1));
  insertUpstream.run(provider.id, 'provider-2', 'request-2', 2300, 1000, 100, 120, 0, 0.02, iso(20), iso(1));
  const insertUsage = context.db.prepare(`
    INSERT INTO usage_snapshots(
      connection_id, subject_type, subject_id, currency, cost, requests,
      input_tokens, output_tokens, total_tokens, model, period, raw_json, captured_at
    ) VALUES (?, 'key', 'mapped-key', 'USD', ?, ?, ?, ?, ?, NULL, 'cumulative', '{}', ?)
  `);
  insertUsage.run(provider.id, 1, 10, 1000, 100, 1100, iso(7 * 24 * 60 + 10));
  insertUsage.run(provider.id, 1.03, 12, 1200, 320, 1520, iso(10));

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const item = monitor.accounts({ search: 'Mapped account', days: 7 }).items[0];
  assert.equal(item.comparison.status, 'mapped');
  assert.equal(item.comparison.source, 'provider_request_logs');
  assert.equal(item.comparison.provider.name, 'Mapped New API');
  assert.equal(item.comparison.upstream.requestCount, 2);
  assert.equal(item.comparison.upstream.ttftP95Ms, 1000);
  assert.equal(item.comparison.upstream.cacheRate, 33.3);
  assert.equal(item.comparison.cost.comparable, true);
  assert.ok(Math.abs(item.comparison.cost.baseCost - 0.04) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.upstreamCost - 0.03) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.differenceAmount - 0.01) < 1e-8);
  assert.equal(item.comparison.cost.moreExpensive, 'sub2api');
  const detail = monitor.account('501', { days: 7 });
  assert.equal(detail.upstreamTrends.length, 1);
  assert.equal(detail.comparison.cost.source, 'provider_usage_snapshots');
  context.db.prepare(`
    UPDATE usage_snapshots SET cost = 1, requests = 10
    WHERE connection_id = ? AND subject_id = 'mapped-key' AND captured_at = ?
  `).run(provider.id, iso(10));
  const stagnant = monitor.account('501', { days: 7 }).comparison.cost;
  assert.equal(stagnant.comparable, false);
  assert.equal(stagnant.reason, 'provider_counter_unchanged');
});

test('account monitor HTTP API supports manual sync, filtering and probes', async (t) => {
  const context = createTestContext();
  const sub2api = createSub2ApiMock();
  const app = createApplication({
    config: context.config,
    db: context.db,
    sub2api,
    startBackground: false
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken
  };

  const sync = await fetch(`${base}/api/account-monitor/sync?wait=true`, {
    method: 'POST', headers, body: '{}'
  });
  assert.equal(sync.status, 200);
  const accounts = await fetch(`${base}/api/account-monitor/accounts?platform=openai&days=7`, {
    headers: { Cookie: cookie }
  });
  assert.equal(accounts.status, 200);
  assert.deepEqual((await accounts.json()).items.map((item) => item.accountId), ['11']);

  const probe = await fetch(`${base}/api/account-monitor/probes?wait=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountIds: ['11'], model: 'gpt-test' })
  });
  assert.equal(probe.status, 200);
  const probeBody = await probe.json();
  assert.equal(probeBody.results[0].intelligenceScore, 100);
  assert.equal(sub2api.calls.find((call) => call.type === 'sse').body.model_id, 'gpt-test');

  const invalidProbe = await fetch(`${base}/api/account-monitor/probes?wait=true`, {
    method: 'POST', headers, body: '{}'
  });
  assert.equal(invalidProbe.status, 400);
});

test('capability scorer separates answers from exact instruction following', () => {
  assert.deepEqual(scoreChallenge(CHALLENGE_EXPECTED), {
    intelligenceScore: 100,
    instructionScore: 100,
    answers: { arithmetic: true, logic: true, sequence: true },
    exact: true
  });
  const verbose = scoreChallenge('The answers are 43, NO, and 42.');
  assert.equal(verbose.intelligenceScore, 100);
  assert.equal(verbose.instructionScore, 0);
});

test('dynamic capability suite is reproducible, varied and independently scored', () => {
  const challenge = createCapabilityChallenge('account-11:batch-a');
  const repeated = createCapabilityChallenge('account-11:batch-a');
  const different = createCapabilityChallenge('account-11:batch-b');
  assert.deepEqual(repeated, challenge);
  assert.notEqual(different.id, challenge.id);

  const perfect = scoreCapabilityChallenge(challenge, JSON.stringify(challenge.expected));
  assert.equal(perfect.intelligenceScore, 100);
  assert.equal(perfect.instructionScore, 100);
  assert.equal(perfect.exact, true);

  const fenced = scoreCapabilityChallenge(
    challenge,
    `\`\`\`json\n${JSON.stringify(challenge.expected)}\n\`\`\``
  );
  assert.equal(fenced.intelligenceScore, 100);
  assert.equal(fenced.instructionScore, 60);

  const wrong = scoreCapabilityChallenge(challenge, JSON.stringify({
    ...challenge.expected,
    arithmetic: challenge.expected.arithmetic + 1
  }));
  assert.equal(wrong.intelligenceScore, 80);

  const allWrongButExecuted = scoreCapabilityChallenge(challenge, JSON.stringify({
    arithmetic: challenge.expected.arithmetic + 1,
    logic: 'YES',
    sequence: challenge.expected.sequence + 1,
    sorted: [...challenge.expected.sorted].reverse(),
    checksum: 'WRONG'
  }));
  assert.equal(allWrongButExecuted.parsed, true);
  assert.equal(allWrongButExecuted.intelligenceScore, 0);
});

test('OpenAI default greeting is recorded as an unexecuted capability probe, not zero', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertMonitoredAccount(context.db, {
    id: 21,
    name: 'OpenAI OAuth greeting',
    platform: 'openai',
    type: 'oauth'
  });
  const sub2api = {
    async sse(_endpoint, options) {
      await options.onEvent({ type: 'test_start', model: 'gpt-test' });
      await options.onEvent({ type: 'content', text: 'Hi! How can I help?' });
      await options.onEvent({ type: 'test_complete', success: true });
    }
  };
  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api });
  const result = await monitor.probe({ accountIds: ['21'], model: 'gpt-test' });
  assert.equal(result.results[0].suite, 'capability_v2_unexecuted');
  assert.equal(result.results[0].intelligenceScore, null);
  assert.equal(result.results[0].instructionScore, null);
  assert.equal(result.results[0].details.challengeExecuted, false);
  assert.equal(result.results[0].details.unscoredReason, 'sub2api_prompt_not_forwarded');
});

test('manual OpenAI API-key probe uses an ephemeral direct capability request', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertMonitoredAccount(context.db, {
    id: 22,
    name: 'OpenAI API key',
    platform: 'openai',
    type: 'apikey'
  });
  let sseCalls = 0;
  const sub2api = {
    async data(endpoint, options) {
      assert.equal(endpoint, '/api/v1/admin/accounts/data');
      assert.equal(options.query.ids, '22');
      assert.equal(options.query.include_proxies, true);
      return {
        accounts: [{
          name: 'OpenAI API key',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-ephemeral-test-secret',
            base_url: 'https://upstream.example/v1'
          },
          extra: { openai_responses_supported: true }
        }],
        proxies: []
      };
    },
    async sse() {
      sseCalls += 1;
      throw new Error('direct probe must not use the Sub2API greeting endpoint');
    }
  };
  const requests = [];
  const httpClient = {
    async requestJson(url, options) {
      requests.push({ url, options });
      const prompt = options.body.input[0].content[0].text;
      return {
        data: {
          model: options.body.model,
          output_text: answerCapabilityPrompt(prompt)
        }
      };
    }
  };
  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api,
    http: httpClient
  });
  const prepared = await monitor.prepareProbe({
    accountIds: ['22'],
    model: 'gpt-test',
    triggerType: 'manual'
  });
  assert.ok(prepared.credentialTicket);
  assert.doesNotMatch(JSON.stringify(prepared), /ephemeral-test-secret/);
  const result = await monitor.probe(prepared);
  assert.equal(sseCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://upstream.example/v1/responses');
  assert.equal(requests[0].options.maxRedirects, 0);
  assert.equal(result.results[0].intelligenceScore, 100);
  assert.equal(result.results[0].instructionScore, 100);
  assert.equal(result.results[0].details.transport, 'direct_api_key');
  assert.equal(result.results[0].details.directCapability, 'responses');
  assert.equal(monitor.probeCredentials.size, 0);
  assert.doesNotMatch(
    JSON.stringify(context.db.prepare('SELECT * FROM sub2api_account_probe_runs').all()),
    /ephemeral-test-secret/
  );
});

test('API-key export matches unordered accounts and resolves duplicate names by ID', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  for (const account of [
    { id: 31, name: 'Unique account', platform: 'openai', type: 'apikey' },
    { id: 32, name: 'Duplicate account', platform: 'openai', type: 'apikey' },
    { id: 33, name: 'Duplicate account', platform: 'openai', type: 'apikey' }
  ]) insertMonitoredAccount(context.db, account);
  const exportedById = new Map([
    ['31', { name: 'Unique account', key: 'sk-account-31' }],
    ['32', { name: 'Duplicate account', key: 'sk-account-32' }],
    ['33', { name: 'Duplicate account', key: 'sk-account-33' }]
  ]);
  const exportCalls = [];
  const sub2api = {
    async data(_endpoint, options) {
      const ids = options.query.ids.split(',');
      exportCalls.push(ids);
      return {
        accounts: [...ids].reverse().map((id) => {
          const account = exportedById.get(id);
          return {
            name: account.name,
            platform: 'openai',
            type: 'apikey',
            credentials: {
              api_key: account.key,
              base_url: `https://upstream-${id}.example/v1`
            }
          };
        }),
        proxies: []
      };
    }
  };
  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api,
    http: {}
  });
  const prepared = await monitor.prepareProbe({
    accountIds: ['31', '32', '33'],
    model: 'gpt-test',
    triggerType: 'manual'
  });
  const credentials = monitor.probeCredentials.get(prepared.credentialTicket).accounts;
  assert.equal(credentials.get('31').apiKey, 'sk-account-31');
  assert.equal(credentials.get('32').apiKey, 'sk-account-32');
  assert.equal(credentials.get('33').apiKey, 'sk-account-33');
  assert.equal(exportCalls.length, 3);
  assert.deepEqual(exportCalls.slice(1).map((ids) => ids.length), [1, 1]);
  monitor.probeCredentials.delete(prepared.credentialTicket);
});

test('Sub2API admin client parses incremental SSE events with administrator auth', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/admin/accounts/11/test');
    assert.equal(req.headers.authorization, 'Bearer account-monitor-admin-token');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"test_start","model":"gpt-test"}\n\n');
    setTimeout(() => {
      res.write('data:{"type":"content","text":"IQCHECK|43|NO|42"}\n\n');
      res.end('data: {"type":"test_complete","success":true}\n\n');
    }, 10);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const context = createTestContext({
    SUB2API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    SUB2API_ADMIN_TOKEN: 'account-monitor-admin-token'
  });
  t.after(() => context.cleanup());
  const client = new Sub2ApiAdminClient(context.config);
  const events = [];
  const result = await client.sse('/api/v1/admin/accounts/11/test', {
    method: 'POST',
    body: { model_id: 'gpt-test' },
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.eventCount, 3);
  assert.deepEqual(events.map((event) => event.type), ['test_start', 'content', 'test_complete']);
  assert.equal(events[1].text, CHALLENGE_EXPECTED);
});
