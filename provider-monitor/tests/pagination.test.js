const test = require('node:test');
const assert = require('node:assert/strict');
const { OneApiFamilyAdapter } = require('../src/adapters/one-api-family');

function token(index) {
  return {
    id: index,
    name: `key-${index}`,
    status: 1,
    remain_quota: 500000,
    used_quota: 0,
    unlimited_quota: false
  };
}

function adapterFor(type, responder) {
  const calls = [];
  const adapter = new OneApiFamilyAdapter({
    connection: {
      id: 'connection', adapter_type: type, base_url: 'https://provider.example',
      remote_user_id: '1', auth_mode: 'system_token'
    },
    credentials: { systemToken: 'token', userId: '1' },
    config: {},
    http: {
      async requestJson(input) {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/api/status') return { data: { success: true, data: { quota_per_unit: 500000 } } };
        return { data: responder(url) };
      }
    }
  });
  return { adapter, calls };
}

test('New API pagination starts at page 1 and uses page_size', async () => {
  const { adapter, calls } = adapterFor('new-api', (url) => {
    const page = Number(url.searchParams.get('p'));
    const items = page === 1
      ? Array.from({ length: 100 }, (_, index) => token(index + 1))
      : [token(101)];
    return { success: true, data: { items, total: 101 } };
  });
  const keys = await adapter.listKeys();
  assert.equal(keys.length, 101);
  assert.deepEqual(calls.slice(0, 2), [
    '/api/token/?p=1&page_size=100',
    '/api/token/?p=2&page_size=100'
  ]);
});

test('One API pagination continues in fixed ten-item pages', async () => {
  const { adapter, calls } = adapterFor('one-api', (url) => {
    const page = Number(url.searchParams.get('p'));
    const items = page === 0
      ? Array.from({ length: 10 }, (_, index) => token(index + 1))
      : [token(11)];
    return { success: true, data: items };
  });
  const keys = await adapter.listKeys();
  assert.equal(keys.length, 11);
  assert.deepEqual(calls.slice(0, 2), ['/api/token/?p=0', '/api/token/?p=1']);
});

test('One Hub and Veloera use their current family-specific paging parameters', async () => {
  const oneHub = adapterFor('one-hub', (url) => ({
    success: true,
    data: { data: [token(1)], page: 1, size: 100, total_count: 1 }
  }));
  assert.equal((await oneHub.adapter.listKeys()).length, 1);
  assert.equal(oneHub.calls[0], '/api/token/?page=1&size=100');

  const veloera = adapterFor('veloera', (url) => ({ success: true, data: [token(1)] }));
  assert.equal((await veloera.adapter.listKeys()).length, 1);
  assert.equal(veloera.calls[0], '/api/token/?p=0&size=100');
});
