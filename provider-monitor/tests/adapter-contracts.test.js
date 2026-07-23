const test = require('node:test');
const assert = require('node:assert/strict');
const { Sub2ApiAdapter } = require('../src/adapters/sub2api');
const { OneApiFamilyAdapter } = require('../src/adapters/one-api-family');
const { DeepSeekAdapter } = require('../src/adapters/deepseek');
const { OpenRouterAdapter } = require('../src/adapters/openrouter');
const { LiteLlmAdapter } = require('../src/adapters/litellm');
const { VoApiV2Adapter } = require('../src/adapters/voapi-v2');
const { CustomAdapter } = require('../src/adapters/custom');
const { AppError } = require('../src/errors');

function context(type, responder, extra = {}) {
  return {
    connection: {
      id: `${type}-id`, name: type, adapter_type: type,
      base_url: 'https://provider.example', remote_user_id: '7',
      auth_mode: 'system_token', type_config_json: {}, ...extra.connection
    },
    credentials: { systemToken: 'system-token', userId: '7', ...extra.credentials },
    config: { maxResponseBytes: 1024 * 1024 },
    onCredentialsUpdated: extra.onCredentialsUpdated || (async () => {}),
    http: {
      async requestJson(input, options) {
        return { data: await responder(new URL(input), options || {}) };
      }
    }
  };
}

test('Sub2API OAuth token-pair mode refreshes and persists rotated credentials', async () => {
  let updatedCredentials = null;
  const requests = [];
  const adapter = new Sub2ApiAdapter(context('sub2api', (url, options) => {
    requests.push({ path: url.pathname, body: options.body });
    if (url.pathname === '/api/v1/auth/refresh') {
      return {
        code: 0,
        data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200 }
      };
    }
    if (url.pathname === '/api/v1/user/profile') {
      return { code: 0, data: { id: 7, username: 'oauth-user', balance: 4.5 } };
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }, {
    connection: { auth_mode: 'token_pair' },
    credentials: { refreshToken: 'browser-refresh-token' },
    onCredentialsUpdated: async (next) => { updatedCredentials = next; }
  }));

  const account = await adapter.getAccount();
  assert.equal(account.displayName, 'oauth-user');
  assert.deepEqual(requests[0], {
    path: '/api/v1/auth/refresh',
    body: { refresh_token: 'browser-refresh-token' }
  });
  assert.equal(updatedCredentials.accessToken, 'rotated-access');
  assert.equal(updatedCredentials.refreshToken, 'rotated-refresh');
  assert.equal(updatedCredentials.expiresIn, 7200);
});

test('Sub2API authentication reports interactive and session-bound login requirements', async () => {
  const turnstile = new Sub2ApiAdapter(context('sub2api', () => {
    throw new AppError('REMOTE_REQUEST_FAILED', 'turnstile verification failed', {
      status: 400,
      details: { remoteCode: 'TURNSTILE_VERIFICATION_FAILED', remoteStatus: 400 }
    });
  }, {
    connection: { auth_mode: 'account' },
    credentials: { email: 'user@example.com', password: 'correct-password' }
  }));
  await assert.rejects(
    turnstile.getAccount(),
    (error) => error.code === 'CAPTCHA_REQUIRED' && error.status === 409
  );

  const sessionBound = new Sub2ApiAdapter(context('sub2api', () => {
    throw new AppError('AUTH_FAILED', 'session fingerprint changed', {
      status: 401,
      details: { remoteCode: 'SESSION_BINDING_MISMATCH', remoteStatus: 401 }
    });
  }, {
    connection: { auth_mode: 'token_pair' },
    credentials: { accessToken: 'browser-access-token', tokenExpiresAt: Date.now() + 3600000 }
  }));
  await assert.rejects(
    sessionBound.getAccount(),
    (error) => error.code === 'SUB2API_SESSION_BINDING_INCOMPATIBLE' && error.status === 409
  );
});

test('Sub2API API Key mode exposes the configured key and its gateway billing group', async () => {
  const requests = [];
  const adapter = new Sub2ApiAdapter(context('sub2api', (url, options) => {
    requests.push({ path: url.pathname, authorization: options.headers?.Authorization });
    if (url.pathname === '/v1/usage') {
      return {
        mode: 'unrestricted',
        isValid: true,
        planName: 'Wallet Balance',
        remaining: 12.5,
        balance: 12.5,
        unit: 'USD',
        usage: {
          today: {
            requests: 2,
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            cost: 0.4
          },
          total: {
            requests: 9,
            input_tokens: 100,
            output_tokens: 200,
            total_tokens: 300,
            cost: 1.5
          }
        }
      };
    }
    if (url.pathname === '/v1/sub2api/billing') {
      return {
        object: 'sub2api.key_billing',
        billing_scope: 'token',
        group_rate_multiplier: 0.2,
        resolved_rate_multiplier: 0.1,
        effective_rate_multiplier: 0.1
      };
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }, {
    connection: { auth_mode: 'api_key' },
    credentials: { apiKey: 'sk-abcdefgh12345678' }
  }));

  const account = await adapter.getAccount();
  const [balance] = await adapter.getAccountBalances(account);
  const [group] = await adapter.listGroups();
  const [key] = await adapter.listKeys();
  const usage = await adapter.getUsage();

  assert.deepEqual(requests, [
    { path: '/v1/usage', authorization: 'Bearer sk-abcdefgh12345678' },
    { path: '/v1/sub2api/billing', authorization: 'Bearer sk-abcdefgh12345678' }
  ]);
  assert.equal(adapter.capabilities().listKeys, true);
  assert.equal(adapter.capabilities().keyGroup, true);
  assert.equal(adapter.capabilities().priceCatalog, false);
  assert.equal(balance.available, 12.5);
  assert.equal(balance.used, 1.5);
  assert.equal(group.remoteId, 'token');
  assert.equal(group.ratio, 0.1);
  assert.equal(key.remoteId, 'configured-api-key');
  assert.equal(key.maskedKey, 'sk-a...5678');
  assert.equal(key.primaryGroupRef, 'token');
  assert.equal(key.quota.remaining, 12.5);
  assert.equal(usage.length, 2);
  assert.equal(usage[0].period, 'today');
  assert.equal(usage[1].period, 'cumulative');
  assert.equal(usage[1].totalTokens, 300);
});

test('Sub2API contract returns account balance, keys and group associations', async () => {
  // Source: Wei-Shaw/sub2api user routes and DTOs, verified 2026-07-17.
  const adapter = new Sub2ApiAdapter(context('sub2api', (url) => {
    if (url.pathname === '/api/v1/user/profile') return { code: 0, data: { id: 7, email: 'user@example.com', username: 'user', balance: 12.5, frozen_balance: 1, total_recharged: 20 } };
    if (url.pathname === '/api/v1/groups/available') return { code: 0, data: [{ id: 3, name: 'Claude', platform: 'anthropic', rate_multiplier: 1.2, status: 'active' }] };
    if (url.pathname === '/api/v1/groups/rates') return { code: 0, data: { 3: 0.9 } };
    if (url.pathname === '/api/v1/keys') return { code: 0, data: { items: [{ id: 9, name: 'client', key: 'sk-secret-value', group_id: 3, status: 'active', quota: 10, quota_used: 4 }], total: 1 } };
    if (url.pathname === '/api/v1/usage/stats') return { code: 0, data: { total_cost: 2, total_requests: 3, total_input_tokens: 60, total_output_tokens: 40 } };
    if (url.pathname === '/api/v1/channels/available') return { code: 0, data: [{ name: 'Claude Route', platforms: [{ platform: 'anthropic', groups: [{ id: 3, name: 'Claude', rate_multiplier: 1.2 }], supported_models: [{ name: 'claude-test', platform: 'anthropic', pricing: { billing_mode: 'token', input_price: 0.000003, output_price: 0.000015, cache_read_price: 0.0000003, cache_write_price: 0.00000375 } }] }] }] };
    throw new Error(`Unexpected ${url.pathname}`);
  }, { credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 } }));
  const account = await adapter.getAccount();
  const [balance] = await adapter.getAccountBalances(account);
  const [group] = await adapter.listGroups();
  const [key] = await adapter.listKeys();
  const [usage] = await adapter.getUsage();
  const catalog = await adapter.getPriceCatalog();
  assert.equal(balance.available, 12.5);
  assert.equal(group.remoteId, '3');
  assert.equal(group.ratio, 0.9);
  assert.equal(group.metadata.default_rate_multiplier, 1.2);
  assert.equal(group.metadata.effective_rate_multiplier, 0.9);
  assert.equal(key.primaryGroupRef, '3');
  assert.equal(key.quota.remaining, 6);
  assert.equal(usage.totalTokens, 100);
  assert.equal(adapter.capabilities().priceCatalog, true);
  assert.equal(catalog.status, 'succeeded');
  assert.equal(catalog.groups[0].ratio, 0.9);
  assert.equal(catalog.models[0].remoteId, 'claude-test');
  assert.equal(catalog.prices[0].inputPerMillion, 2.7);
  assert.ok(Math.abs(catalog.prices[0].outputPerMillion - 13.5) < 1e-10);
  assert.ok(Math.abs(catalog.prices[0].cacheReadPerMillion - 0.27) < 1e-10);
  assert.equal(catalog.prices[0].raw.groupRatio, 0.9);
});

test('Sub2API catalog keeps group rates when channel pricing is not exposed', async () => {
  const adapter = new Sub2ApiAdapter(context('sub2api', (url) => {
    if (url.pathname === '/api/v1/groups/available') return { code: 0, data: [{ id: 2, name: 'Codex', platform: 'openai', rate_multiplier: 0.1, status: 'active' }] };
    if (url.pathname === '/api/v1/groups/rates') return { code: 0, data: { 2: 0.05 } };
    if (url.pathname === '/api/v1/channels/available') return { code: 0, data: [] };
    throw new Error(`Unexpected ${url.pathname}`);
  }, { credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 } }));

  const catalog = await adapter.getPriceCatalog();
  assert.equal(catalog.status, 'partial');
  assert.equal(catalog.source, 'sub2api_group_rates');
  assert.equal(catalog.groups[0].ratio, 0.05);
  assert.equal(catalog.prices.length, 0);
  assert.equal(catalog.warning.code, 'PRICE_CATALOG_NOT_EXPOSED');
});

test('One API family variants preserve their current balance and group semantics', async () => {
  // Sources: songquanpeng/one-api, Calcium-Ion/one-api, deanxv/done-hub,
  // QuantumNous/new-api and Veloera/Veloera, verified 2026-07-17.
  for (const type of ['new-api', 'one-api', 'one-hub', 'done-hub', 'veloera']) {
    const adapter = new OneApiFamilyAdapter(context(type, (url) => {
      if (url.pathname === '/api/status') return { success: true, data: { quota_per_unit: 500000, version: 'fixture' } };
      if (url.pathname === '/api/user/self') return { success: true, data: { id: 7, username: 'user', group: 'default', quota: 2500000, used_quota: 500000, status: 1 } };
      if (url.pathname === '/api/user/self/groups') return { success: true, data: [{ id: 'fast', name: 'Fast', ratio: 1.1 }] };
      if (url.pathname === '/api/token/') {
        const token = { id: 1, name: 'key', status: 1, remain_quota: 1000000, used_quota: 500000, group: 'fast', backup_group: 'slow' };
        if (type === 'new-api') return { success: true, data: { items: [token], total: 1 } };
        if (type === 'one-hub' || type === 'done-hub') return { success: true, data: { data: [token], total_count: 1 } };
        return { success: true, data: [token] };
      }
      throw new Error(`Unexpected ${type} ${url.pathname}`);
    }));
    const account = await adapter.getAccount();
    const [balance] = await adapter.getAccountBalances(account);
    const [key] = await adapter.listKeys();
    assert.equal(balance.available, 5, type);
    assert.equal(key.quota.remaining, 2, type);
    if (['new-api', 'one-hub', 'done-hub', 'veloera'].includes(type)) assert.equal(key.primaryGroupRef, 'fast', type);
    if (['one-hub', 'done-hub'].includes(type)) assert.equal(key.backupGroupRef, 'slow', type);
    const groups = await adapter.listGroups();
    if (['new-api', 'veloera'].includes(type)) assert.equal(groups[0].name, 'Fast', type);
    if (type === 'one-api') assert.equal(groups[0].name, 'default', type);
    if (['one-hub', 'done-hub'].includes(type)) assert.deepEqual(groups, [], type);
  }
});

test('New API recharge quote uses the authenticated user price instead of quota conversion fields', async () => {
  const requests = [];
  const adapter = new OneApiFamilyAdapter(context('new-api', (url, options) => {
    requests.push({ path: url.pathname, body: options.body });
    if (url.pathname === '/api/status') {
      return {
        success: true,
        data: {
          quota_per_unit: 500000,
          quota_display_type: 'USD',
          price: 6.96,
          payment_fx_rate_cny_per_usd: 6.76
        }
      };
    }
    if (url.pathname === '/api/user/topup/info') {
      return { success: true, data: { min_topup: 1, amount_options: [1, 10], discount: {} } };
    }
    if (url.pathname === '/api/user/amount') {
      assert.deepEqual(options.body, { amount: 1 });
      return { message: 'success', data: '6.96' };
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }));

  const quote = await adapter.getRechargeQuote();
  assert.equal(adapter.capabilities().rechargeQuote, true);
  assert.equal(quote.source, 'provider_quote');
  assert.equal(quote.paidCurrency, 'CNY');
  assert.equal(quote.balanceCurrency, 'USD');
  assert.equal(quote.paidAmount, 6.96);
  assert.equal(quote.creditedAmount, 1);
  assert.ok(Math.abs(quote.multiplier - (1 / 6.96)) < 1e-12);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/status', '/api/user/topup/info', '/api/user/amount'
  ]);
});

test('New API dynamic route rates use successful request billing logs without paid probes', async () => {
  const requests = [];
  const adapter = new OneApiFamilyAdapter(context('new-api', (url) => {
    requests.push(url);
    if (url.pathname === '/api/log/self') {
      return {
        success: true,
        data: {
          total: 5,
          items: [
            {
              created_at: 100, token_id: 9, token_name: 'route-key', model_name: 'model-a',
              channel: 11, channel_name: 'Low', prompt_tokens: 100, completion_tokens: 0,
              quota: 3, other: JSON.stringify({ request_final_status: 'success', model_ratio: 0.03, group_ratio: 1 })
            },
            {
              created_at: 200, token_id: 9, token_name: 'route-key', model_name: 'model-a',
              channel: 12, channel_name: 'High', prompt_tokens: 100, completion_tokens: 0,
              quota: 5, other: { request_final_status: 'success', model_ratio: 0.05, group_ratio: 1 }
            },
            {
              created_at: 300, token_id: 9, token_name: 'route-key', model_name: 'model-a',
              quota: 50, other: { request_final_status: 'refunded', model_ratio: 0.5, group_ratio: 1 }
            },
            {
              created_at: 400, token_id: 9, token_name: 'route-key', model_name: 'legacy',
              quota: 0, other: 'null'
            },
            {
              created_at: 500, token_id: 10, token_name: 'historical-key', model_name: 'model-b',
              channel: 13, channel_name: 'Historical', prompt_tokens: 100, completion_tokens: 0,
              quota: 7, other: { request_final_status: 'success', model_ratio: 0.07, group_ratio: 1 }
            }
          ]
        }
      };
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }));

  const rates = await adapter.getDynamicRouteRates({
    enabled: true,
    statistic: 'median',
    minimumSamples: 2,
    keys: [{ remoteId: '9', name: 'route-key' }]
  });
  const rate = rates.find((item) => item.remoteKeyId === '9');
  const historical = rates.find((item) => item.remoteKeyId === '10');
  assert.equal(adapter.capabilities().dynamicRouteRates, true);
  assert.equal(rate.remoteKeyId, '9');
  assert.equal(rate.sampleCount, 2);
  assert.equal(rate.selectedMultiplier, 0.04);
  assert.equal(rate.minMultiplier, 0.03);
  assert.equal(rate.maxMultiplier, 0.05);
  assert.equal(rate.latest.channelName, 'High');
  assert.equal(historical.keyName, 'historical-key');
  assert.equal(historical.selectedMultiplier, 0.07);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('type'), '0');
});

test('Sub2API account payment config exposes its balance recharge multiplier', async () => {
  const adapter = new Sub2ApiAdapter(context('sub2api', (url) => {
    if (url.pathname === '/api/v1/payment/checkout-info') {
      return {
        code: 0,
        data: {
          balance_recharge_multiplier: 10,
          balance_disabled: false,
          recharge_fee_rate: 0.02
        }
      };
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }, {
    connection: { auth_mode: 'token_pair' },
    credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 }
  }));

  const quote = await adapter.getRechargeQuote();
  assert.equal(quote.source, 'provider_payment_config');
  assert.equal(quote.multiplier, 10);
  assert.equal(quote.paidAmount, 1);
  assert.equal(quote.creditedAmount, 10);
  assert.equal(quote.metadata.rechargeFeeRate, 0.02);
});

test('DeepSeek and OpenRouter contracts retain independent balance meanings', async () => {
  const deepseek = new DeepSeekAdapter(context('deepseek', () => ({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '8.50', granted_balance: '1.50', topped_up_balance: '7.00' },
      { currency: 'USD', total_balance: '-0.25', granted_balance: '0', topped_up_balance: '-0.25' }
    ]
  }), { credentials: { apiKey: 'sk-deepseek' } }));
  const deepBalances = await deepseek.getAccountBalances(await deepseek.getAccount());
  assert.deepEqual(deepBalances.map((item) => [item.currency, item.available]), [['CNY', 8.5], ['USD', -0.25]]);

  const openrouter = new OpenRouterAdapter(context('openrouter', (url) => {
    if (url.pathname === '/api/v1/key') return { data: { hash: 'current', workspace_id: 'workspace', is_management_key: true } };
    if (url.pathname === '/api/v1/credits') return { data: { total_credits: 25, total_usage: 7 } };
    if (url.pathname === '/api/v1/keys') return { data: [{ hash: 'key-1', name: 'prod', limit: 10, usage: 3, limit_remaining: 7 }] };
    throw new Error(`Unexpected ${url.pathname}`);
  }, { connection: { auth_mode: 'management_key' }, credentials: { managementKey: 'management-key' } }));
  const [openBalance] = await openrouter.getAccountBalances(await openrouter.getAccount());
  const [openKey] = await openrouter.listKeys();
  assert.equal(openBalance.available, 18);
  assert.equal(openKey.quota.remaining, 7);
});

test('LiteLLM and VoAPI contracts return team/key groups and budgets', async () => {
  const litellm = new LiteLlmAdapter(context('litellm', (url) => {
    if (url.pathname === '/global/spend') return { spend: 12, max_budget: 50 };
    if (url.pathname === '/team/list') return [{ team_id: 'team-a', team_alias: 'Team A', max_budget: 50, spend: 5 }];
    if (url.pathname === '/key/list') return { keys: [{ token: 'hash', key_alias: 'client', team_id: 'team-a', max_budget: 20, spend: 4 }], total_count: 1 };
    throw new Error(`Unexpected ${url.pathname}`);
  }, { credentials: { masterKey: 'master-key' } }));
  const [team] = await litellm.listGroups();
  const [liteKey] = await litellm.listKeys();
  const [liteBalance] = await litellm.getAccountBalances(await litellm.getAccount());
  assert.equal(team.remoteId, 'team-a');
  assert.equal(liteKey.primaryGroupRef, 'team-a');
  assert.equal(liteKey.quota.remaining, 16);
  assert.equal(liteBalance.available, 38);

  const voapi = new VoApiV2Adapter(context('voapi-v2', (url) => {
    if (url.pathname === '/api/user/info') return { code: 0, data: { id: 7, nickname: 'user', basicBalance: 8, bindBalance: 2, usedBasicBalance: 3, usedBindBalance: 1, currency: 'USD' } };
    if (url.pathname === '/api/keys/template') return { code: 0, data: { groups: [{ id: 2, name: 'Fast' }, { id: 3, name: 'Backup' }] } };
    if (url.pathname === '/api/keys') return { code: 0, data: { records: [{ id: 1, name: 'client', groups: [2, 3], amount: 6, used: 4, enable: true }] } };
    throw new Error(`Unexpected ${url.pathname}`);
  }, { credentials: { apiKey: 'dashboard-token' } }));
  const [voBalance] = await voapi.getAccountBalances(await voapi.getAccount());
  const voGroups = await voapi.listGroups();
  const [voKey] = await voapi.listKeys();
  assert.equal(voBalance.available, 10);
  assert.equal(voGroups.length, 2);
  assert.equal(voKey.primaryGroupRef, '2');
  assert.deepEqual(voKey.additionalGroupRefs, ['3']);
});

test('Custom JSONPath adapter implements configured balances, keys, groups and usage', async () => {
  const requests = {
    account: { path: '/account', idJsonPath: '$.id', nameJsonPath: '$.name' },
    accountBalance: { path: '/balance', balanceItemsJsonPath: '$.balances[*]', currencyJsonPath: '$.currency', availableJsonPath: '$.available' },
    groups: { path: '/groups', itemsJsonPath: '$.items[*]', idJsonPath: '$.id', nameJsonPath: '$.name', ratioJsonPath: '$.ratio' },
    keys: { path: '/keys', itemsJsonPath: '$.items[*]', idJsonPath: '$.id', nameJsonPath: '$.name', primaryGroupJsonPath: '$.group', limitJsonPath: '$.limit', usedJsonPath: '$.used' },
    usage: { path: '/usage', itemsJsonPath: '$.items[*]', costJsonPath: '$.cost', requestsJsonPath: '$.requests', totalTokensJsonPath: '$.tokens' }
  };
  const adapter = new CustomAdapter(context('custom', (url) => ({
    '/account': { id: 1, name: 'Custom' },
    '/balance': { balances: [{ currency: 'USD', available: 9 }] },
    '/groups': { items: [{ id: 'g1', name: 'Default', ratio: 1 }] },
    '/keys': { items: [{ id: 'k1', name: 'Client', group: 'g1', limit: 10, used: 3 }] },
    '/usage': { items: [{ cost: 3, requests: 4, tokens: 100 }] }
  })[url.pathname], { connection: { type_config_json: { requests } }, credentials: { apiKey: 'key' } }));
  assert.equal((await adapter.getAccountBalances(await adapter.getAccount()))[0].available, 9);
  assert.equal((await adapter.listGroups())[0].remoteId, 'g1');
  assert.equal((await adapter.listKeys())[0].quota.remaining, 7);
  assert.equal((await adapter.getUsage())[0].totalTokens, 100);
  assert.equal(adapter.capabilities().listKeys, true);
});
