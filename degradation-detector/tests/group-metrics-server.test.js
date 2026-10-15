'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GroupMetrics } = require('../src/group-metrics');
const { createApp } = require('../src/server');
const { listen, seedRuntime, testConfig } = require('./helpers');

test('shared group cache rates reveal only authorized, enabled groups and no credentials or usage details', async (t) => {
  const config = testConfig(t, { env: { SUB2API_DATABASE_URL: 'postgresql://reader:secret@private-host/sub2api' } });
  const queries = [];
  let available = ['1', '2'];
  const discovered = [
    { id: '1', name: 'OpenAI', platform: 'openai', rate_multiplier: 0.75 },
    { id: '2', name: 'Claude', platform: 'anthropic', rate_multiplier: 0 },
    { id: '3', name: 'Disabled group', platform: 'openai', rate_multiplier: 2 }
  ];
  const groupMetrics = new GroupMetrics(config, { pool: {
    async query(_sql, values) {
      queries.push(values);
      return { rows: [{ group_id: '1', cache_rate: '0.25' }, { group_id: '2', cache_rate: '0' }] };
    },
    async end() {}
  } });
  const { app, runtime } = createApp(config, {
    groupMetrics,
    sub2api: { async listAvailableGroups() { return discovered.filter((group) => available.includes(group.id)); } },
    runner: { async execute() { assert.fail('viewing results must not start inference'); } },
    startScheduler: false
  });
  seedRuntime(runtime, discovered.slice(0, 2));
  const http = await listen(app);
  t.after(async () => {
    await http.close(); await groupMetrics.close(); await runtime.scheduler.close(); runtime.auth.close(); runtime.store.close();
  });
  const getResults = async (suffix = '') => {
    const response = await fetch(`${http.baseUrl}/api/results${suffix}`, { headers: { 'x-test-user': 'ordinary-user' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const anonymous = await fetch(`${http.baseUrl}/api/results`);
  assert.equal(anonymous.status, 401);
  assert.equal(queries.length, 0);
  const first = await getResults();
  assert.deepEqual(first.groups.map((group) => group.id), ['1', '2']);
  assert.equal(first.groups[0].rate_multiplier, 0.75);
  assert.equal(first.groups[1].rate_multiplier, 0);
  assert.equal(first.groups[0].cache_stats.rate, 0.25);
  assert.equal(first.groups[1].cache_stats.rate, 0);
  assert.equal(first.groups[1].cache_stats.status, 'ok');
  assert.deepEqual(queries[0][0], ['1', '2']);
  assert.doesNotMatch(JSON.stringify(first), /secret|private-host|reader|input_tokens|cache_read_tokens|actual_cost|api_key|key_cipher/);

  // Client-supplied group/time filters cannot broaden the server's authorized response.
  available = ['2', '3'];
  const second = await getResults('?group_id=1&hours=24');
  assert.deepEqual(second.groups.map((group) => group.id), ['2']);
  assert.equal(second.groups[0].cache_stats.window_hours, 5);
  assert.equal(queries.length, 1);
  runtime.store.setMonitorEnabled(config.serviceOwnerId, '2', false);
  assert.deepEqual((await getResults()).groups, []);
  assert.equal(queries.length, 1);
});

test('missing statistics connections and query failures preserve detection result availability', async (t) => {
  for (const failure of [false, true]) {
    const config = testConfig(t);
    const groupMetrics = new GroupMetrics(config, { pool: failure ? {
      async query() { throw Object.assign(new Error('private database diagnostics'), { code: '57014' }); },
      async end() {}
    } : null });
    const { app, runtime } = createApp(config, {
      groupMetrics,
      sub2api: { async listAvailableGroups() { return [{ id: '1', name: 'Group 1', platform: 'openai' }]; } },
      runner: { async execute() {} }, startScheduler: false
    });
    seedRuntime(runtime, [{ id: '1', name: 'Group 1', platform: 'openai' }]);
    const http = await listen(app);
    t.after(async () => {
      await http.close(); await groupMetrics.close(); await runtime.scheduler.close(); runtime.auth.close(); runtime.store.close();
    });
    const response = await fetch(`${http.baseUrl}/api/results`, { headers: { 'x-test-user': 'ordinary-user' } });
    assert.equal(response.status, 200);
    const group = (await response.json()).groups[0];
    assert.equal(group.cache_stats.status, failure ? 'unavailable' : 'not_configured');
    assert.equal(group.cache_stats.rate, null);
    assert.equal(group.rate_multiplier, null);
    assert.equal(group.model, 'gpt-test');
    assert.deepEqual(group.history, []);
  }
});
