const test = require('node:test');
const assert = require('node:assert/strict');
const { LiteLlmAdapter } = require('../src/adapters/litellm');
const { VoApiV2Adapter } = require('../src/adapters/voapi-v2');

test('LiteLLM requests full key objects and paginates budgets', async () => {
  const calls = [];
  const adapter = new LiteLlmAdapter({
    connection: { id: 'lite', adapter_type: 'litellm', base_url: 'https://litellm.example' },
    credentials: { masterKey: 'sk-master' },
    http: {
      async requestJson(input) {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        const page = Number(url.searchParams.get('page'));
        const keys = page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ token: `hash-${index}`, key_alias: `key-${index}`, max_budget: 10, spend: 2, team_id: 'team-a' }))
          : [{ token: 'hash-100', key_alias: 'key-100', max_budget: 5, spend: 1 }];
        return { data: { keys, total_count: 101, current_page: page, total_pages: 2 } };
      }
    }
  });
  const keys = await adapter.listKeys();
  assert.equal(keys.length, 101);
  assert.equal(keys[0].quota.remaining, 8);
  assert.equal(keys[0].primaryGroupRef, 'team-a');
  assert.equal(calls[0], '/key/list?return_full_object=true&page=1&size=100');
  assert.equal(calls[1], '/key/list?return_full_object=true&page=2&size=100');
});

test('VoAPI v2 treats amount as remaining quota and uses raw dashboard auth', async () => {
  const calls = [];
  const adapter = new VoApiV2Adapter({
    connection: { id: 'voapi', adapter_type: 'voapi-v2', base_url: 'https://voapi.example', type_config_json: {} },
    credentials: { apiKey: 'dashboard-jwt', userId: '9' },
    http: {
      async requestJson(input, options) {
        const url = new URL(input);
        calls.push({ path: `${url.pathname}${url.search}`, authorization: options.headers.Authorization });
        if (url.pathname === '/api/keys/template') {
          return { data: { code: 0, data: { groups: [{ id: 3, name: 'Fast' }] } } };
        }
        return { data: { code: 0, data: { records: [{ id: 1, name: 'token', tokenMasked: 'vo-***', groups: [3], enable: true, boundlessAmount: false, amount: '7.5', used: '2.5' }] } } };
      }
    }
  });
  const keys = await adapter.listKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].quota.limit, 10);
  assert.equal(keys[0].quota.remaining, 7.5);
  assert.equal(keys[0].primaryGroupRef, '3');
  assert.equal(calls.every((call) => call.authorization === 'dashboard-jwt'), true);
  assert.match(calls[1].path, /sl\[name\]=true/);
});
