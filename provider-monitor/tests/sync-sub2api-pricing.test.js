const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergePricing,
  normalizeTemplate,
  normalizeTimePricing,
  parseArgs,
  selectGroups,
  syncPricing
} = require('../scripts/sync-sub2api-pricing');

function pricingTemplate(overrides = {}) {
  return {
    unit: 'usd_per_1m_tokens',
    channel: {
      name: 'Domestic models',
      groups: { mode: 'merge', platforms: ['deepseek'] }
    },
    rules: [{
      platform: 'deepseek',
      models: ['deepseek-chat'],
      input: 0.14,
      output: 0.28
    }],
    ...overrides
  };
}

function createClient({ channels = [], groups = [], createID = 99 } = {}) {
  const calls = [];
  return {
    calls,
    async listAll(endpoint, query, options) {
      calls.push({ endpoint, query, options });
      assert.equal(endpoint, '/api/v1/admin/channels');
      return { items: channels, total: channels.length };
    },
    async data(endpoint, options = {}) {
      calls.push({ endpoint, options });
      if (endpoint === '/api/v1/admin/groups/all') return groups;
      if (endpoint === '/api/v1/admin/channels' && options.method === 'POST') return { id: createID };
      if (/^\/api\/v1\/admin\/channels\/\d+$/.test(endpoint) && options.method === 'PUT') return { id: Number(endpoint.split('/').pop()) };
      throw new Error(`unexpected endpoint ${endpoint}`);
    }
  };
}

test('CLI only accepts channel sync options', () => {
  assert.deepEqual(parseArgs([
    '--file', 'pricing.json', '--mode=replace', '--group-mode', 'merge', '--apply'
  ]), {
    apply: true,
    mode: 'replace',
    groupMode: 'merge',
    file: 'pricing.json'
  });
  assert.throws(() => parseArgs(['--file', 'pricing.json', '--group-id', '1']), /Unknown option/);
});

test('template normalizes every channel pricing field', () => {
  const normalized = normalizeTemplate({
    unit: 'usd_per_1m_tokens',
    pricing_mode: 'replace',
    channel: {
      name: 'Domestic shared pricing',
      description: 'Shared by domestic model groups',
      status: 'active',
      billing_model_source: 'channel_mapped',
      restrict_models: true,
      groups: {
        mode: 'replace',
        ids: [7],
        names: ['Kimi primary'],
        name_contains: ['domestic'],
        platforms: ['deepseek'],
        include_inactive: false
      }
    },
    rules: [{
      platform: 'deepseek',
      models: ['DeepSeek-Chat'],
      billing_mode: 'token',
      input: 0.14,
      output: 0.28,
      cache_write: 0.2,
      cache_write_1h: 0.3,
      cache_read: 0.04,
      image_input: 0.5,
      image_output: 1.5,
      per_request: 0.01,
      fast_multiplier: 2,
      flex_multiplier: 0.5,
      max_reasoning_effort_multiplier: 1.25,
      long_context_tiers: [{
        min_tokens: 32000,
        max_tokens: null,
        input_multiplier: 2,
        output: 0.56,
        cache_read_multiplier: 1.5
      }],
      time_pricing: {
        timezone: 'Asia/Shanghai',
        weekdays_only: true,
        periods: [
          { start_time: '22:00', end_time: '00:00', multiplier: 0.5 },
          { start: '08:00', end: '22:00', multiplier: 1.2 }
        ]
      }
    }]
  });

  assert.equal(normalized.pricingMode, 'replace');
  assert.equal(normalized.channel.name, 'Domestic shared pricing');
  assert.equal(normalized.channel.restrict_models, true);
  assert.equal(normalized.channel.groups.mode, 'replace');
  assert.deepEqual(normalized.channel.groups.ids, [7]);
  assert.equal(normalized.channel.groups.includeInactive, false);
  const rule = normalized.rules[0];
  assert.deepEqual(rule.models, ['deepseek-chat']);
  assert.equal(rule.input_price, 0.14e-6);
  assert.equal(rule.output_price, 0.28e-6);
  assert.equal(rule.cache_write_1h_price, 0.3e-6);
  assert.equal(rule.image_output_price, 1.5e-6);
  assert.equal(rule.per_request_price, 0.01);
  assert.equal(rule.fast_multiplier, 2);
  assert.equal(rule.intervals[0].output_price, 0.56e-6);
  assert.equal(rule.intervals[0].input_multiplier, 2);
  assert.deepEqual(rule.time_pricing, {
    timezone: 'Asia/Shanghai',
    weekdays_only: true,
    periods: [
      { start_time: '08:00', end_time: '22:00', multiplier: 1.2 },
      { start_time: '22:00', end_time: '00:00', multiplier: 0.5 }
    ]
  });
});

test('time pricing accepts midnight splits and rejects crossing or overlapping periods', () => {
  assert.deepEqual(normalizeTimePricing({
    timezone: 'Asia/Shanghai',
    periods: [
      { start: '22:00', end: '00:00', multiplier: 0.5 },
      { start: '00:00', end: '02:00', multiplier: 0.6 }
    ]
  }, 0).periods, [
    { start_time: '00:00', end_time: '02:00', multiplier: 0.6 },
    { start_time: '22:00', end_time: '00:00', multiplier: 0.5 }
  ]);
  assert.throws(() => normalizeTimePricing({
    timezone: 'Asia/Shanghai',
    periods: [{ start: '22:00', end: '02:00', multiplier: 0.5 }]
  }, 0), /split cross-midnight/);
  assert.throws(() => normalizeTimePricing({
    timezone: 'Asia/Shanghai',
    periods: [
      { start: '08:00', end: '12:00', multiplier: 1.2 },
      { start: '11:00', end: '13:00', multiplier: 1.1 }
    ]
  }, 0), /must not overlap/);
});

test('template rejects invalid interval and model overlaps', () => {
  assert.throws(() => normalizeTemplate(pricingTemplate({
    rules: [
      { platform: 'deepseek', models: ['deepseek-*'], input: 1 },
      { platform: 'deepseek', models: ['deepseek-chat'], input: 2 }
    ]
  })), /overlapping models/);
  assert.throws(() => normalizeTemplate(pricingTemplate({
    rules: [{
      platform: 'deepseek',
      models: ['deepseek-chat'],
      intervals: [
        { min_tokens: 0, max_tokens: 40000, input: 1 },
        { min_tokens: 32000, max_tokens: null, input: 2 }
      ]
    }]
  })), /must not overlap/);
  assert.throws(() => normalizeTemplate(pricingTemplate({
    rules: [{ platform: 'deepseek', models: ['deepseek-chat'], intervals: [{ min_tokens: 1 }] }]
  })), /at least one price or multiplier/);
});

test('top-level group peak rate is rejected with migration guidance', () => {
  assert.throws(() => normalizeTemplate({
    ...pricingTemplate(),
    peak_rate: { enabled: true, start: '08:00', end: '22:00', multiplier: 1.2 }
  }), /move peak\/valley periods into each rule.time_pricing/);
});

test('group selectors use union semantics and can exclude inactive groups', () => {
  const config = normalizeTemplate(pricingTemplate({
    channel: {
      name: 'Domestic models',
      groups: {
        ids: [1],
        names: ['Named'],
        name_contains: ['extra'],
        platforms: ['kimi'],
        include_inactive: false
      }
    }
  })).channel.groups;
  const selected = selectGroups([
    { id: 1, name: 'One', platform: 'openai', status: 'active' },
    { id: 2, name: 'Named', platform: 'openai', status: 'active' },
    { id: 3, name: 'Extra pool', platform: 'openai', status: 'active' },
    { id: 4, name: 'Kimi', platform: 'kimi', status: 'active' },
    { id: 5, name: 'Inactive Kimi', platform: 'kimi', status: 'inactive' }
  ], config);
  assert.deepEqual(selected.map((group) => group.id), [1, 2, 3, 4]);
});

test('merge replaces covered models and preserves unrelated full channel rules', () => {
  const existing = [{
    id: 10,
    platform: 'deepseek',
    models: ['deepseek-chat', 'legacy-model'],
    billing_mode: 'token',
    input_price: 1,
    time_pricing: {
      timezone: 'Asia/Shanghai',
      weekdays_only: false,
      periods: [{ start_time: '00:00', end_time: '08:00', multiplier: 0.5 }]
    },
    intervals: [{ id: 11, min_tokens: 100, max_tokens: null, input_multiplier: 2 }]
  }];
  const incoming = normalizeTemplate(pricingTemplate({ unit: 'usd_per_token' })).rules;
  const merged = mergePricing(existing, incoming, 'merge');
  assert.deepEqual(merged.map((rule) => rule.models), [['deepseek-chat'], ['legacy-model']]);
  assert.equal(merged[0].input_price, 0.14);
  assert.equal(merged[1].time_pricing.periods[0].multiplier, 0.5);
  assert.equal(merged[1].intervals[0].input_multiplier, 2);
  assert.equal('id' in merged[1], false);
  assert.equal('id' in merged[1].intervals[0], false);
});

test('dry-run previews an existing channel without writes', async () => {
  const client = createClient({
    channels: [{ id: 5, name: 'Domestic models', group_ids: [1], model_pricing: [] }],
    groups: [{ id: 1, name: 'DeepSeek', platform: 'deepseek', status: 'active', model_pricing: [] }]
  });
  const summary = await syncPricing({
    client,
    template: pricingTemplate(),
    options: parseArgs(['--file', 'pricing.json']),
    logger: { log() {} }
  });
  assert.equal(summary.action, 'update');
  assert.equal(summary.applied, false);
  assert.equal(client.calls.filter((call) => call.options?.method).length, 0);
});

test('apply creates a channel with groups and complete pricing', async () => {
  const client = createClient({
    groups: [
      { id: 7, name: 'DeepSeek A', platform: 'deepseek', status: 'active', model_pricing: [] },
      { id: 8, name: 'Kimi A', platform: 'kimi', status: 'active', model_pricing: [] }
    ],
    createID: 42
  });
  const template = pricingTemplate({
    channel: {
      name: 'Domestic models',
      description: 'Shared pricing',
      billing_model_source: 'requested',
      restrict_models: true,
      groups: { mode: 'replace', platforms: ['deepseek', 'kimi'] }
    },
    rules: [{
      platform: 'deepseek',
      models: ['deepseek-chat'],
      input: 0.14,
      intervals: [{ min_tokens: 32000, max_tokens: null, input_multiplier: 2 }],
      time_pricing: {
        timezone: 'Asia/Shanghai',
        periods: [{ start: '00:00', end: '08:00', multiplier: 0.5 }]
      }
    }]
  });
  const summary = await syncPricing({
    client,
    template,
    options: parseArgs(['--file', 'pricing.json', '--apply']),
    logger: { log() {} }
  });
  const createCall = client.calls.find((call) => call.endpoint === '/api/v1/admin/channels' && call.options?.method === 'POST');
  assert.equal(summary.action, 'create');
  assert.equal(summary.id, 42);
  assert.equal(summary.applied, true);
  assert.deepEqual(createCall.options.body.group_ids, [7, 8]);
  assert.equal(createCall.options.body.description, 'Shared pricing');
  assert.equal(createCall.options.body.billing_model_source, 'requested');
  assert.equal(createCall.options.body.restrict_models, true);
  assert.equal(createCall.options.body.model_pricing[0].intervals[0].input_multiplier, 2);
  assert.equal(createCall.options.body.model_pricing[0].time_pricing.periods[0].multiplier, 0.5);
});

test('apply updates only managed channel fields and merges group associations', async () => {
  const client = createClient({
    channels: [{
      id: 12,
      name: 'Domestic models',
      description: 'Old',
      group_ids: [1],
      model_pricing: [{ platform: 'kimi', models: ['kimi-old'], billing_mode: 'token', input_price: 1 }],
      model_mapping: { kimi: { alias: 'kimi-old' } },
      account_stats_pricing_rules: [{ id: 1 }]
    }],
    groups: [
      { id: 1, name: 'Existing', platform: 'kimi', status: 'active', model_pricing: [] },
      { id: 2, name: 'DeepSeek', platform: 'deepseek', status: 'active', model_pricing: [] }
    ]
  });
  await syncPricing({
    client,
    template: pricingTemplate({
      channel: {
        name: 'Domestic models',
        description: 'New',
        groups: { mode: 'merge', platforms: ['deepseek'] }
      }
    }),
    options: parseArgs(['--file', 'pricing.json', '--apply']),
    logger: { log() {} }
  });
  const updateCall = client.calls.find((call) => call.endpoint === '/api/v1/admin/channels/12' && call.options?.method === 'PUT');
  assert.deepEqual(updateCall.options.body.group_ids, [1, 2]);
  assert.equal(updateCall.options.body.description, 'New');
  assert.deepEqual(updateCall.options.body.model_pricing.map((rule) => rule.models), [
    ['deepseek-chat'], ['kimi-old']
  ]);
  assert.equal('model_mapping' in updateCall.options.body, false);
  assert.equal('account_stats_pricing_rules' in updateCall.options.body, false);
});

test('group replace mode detaches associations not selected by the template', async () => {
  const client = createClient({
    channels: [{ id: 13, name: 'Domestic models', group_ids: [1, 2], model_pricing: [] }],
    groups: [
      { id: 1, name: 'DeepSeek', platform: 'deepseek', status: 'active', model_pricing: [] },
      { id: 2, name: 'Kimi', platform: 'kimi', status: 'active', model_pricing: [] }
    ]
  });
  await syncPricing({
    client,
    template: pricingTemplate({
      channel: { name: 'Domestic models', groups: { mode: 'replace', ids: [1] } }
    }),
    options: parseArgs(['--file', 'pricing.json', '--apply']),
    logger: { log() {} }
  });
  const updateCall = client.calls.find((call) => call.endpoint === '/api/v1/admin/channels/13' && call.options?.method === 'PUT');
  assert.deepEqual(updateCall.options.body.group_ids, [1]);
});

test('sync rejects groups owned by another channel before writing', async () => {
  const client = createClient({
    channels: [{ id: 20, name: 'Other', group_ids: [7], model_pricing: [] }],
    groups: [{ id: 7, name: 'DeepSeek', platform: 'deepseek', status: 'active', model_pricing: [] }]
  });
  await assert.rejects(() => syncPricing({
    client,
    template: pricingTemplate(),
    options: parseArgs(['--file', 'pricing.json', '--apply']),
    logger: { log() {} }
  }), /already belongs to channel Other/);
  assert.equal(client.calls.filter((call) => call.options?.method).length, 0);
});

test('summary reports group pricing that would override channel pricing', async () => {
  const client = createClient({
    channels: [{ id: 21, name: 'Domestic models', group_ids: [7], model_pricing: [] }],
    groups: [{
      id: 7,
      name: 'DeepSeek',
      platform: 'deepseek',
      status: 'active',
      model_pricing: [{ models: ['deepseek-chat'], input_price: 9 }]
    }]
  });
  const summary = await syncPricing({
    client,
    template: pricingTemplate(),
    options: parseArgs(['--file', 'pricing.json']),
    logger: { log() {} }
  });
  assert.deepEqual(summary.group_pricing_overrides, [{
    id: 7,
    name: 'DeepSeek',
    platform: 'deepseek',
    pricing_rules: 1
  }]);
});

test('creating a disabled channel performs the required follow-up update', async () => {
  const client = createClient({
    groups: [{ id: 1, name: 'DeepSeek', platform: 'deepseek', status: 'active', model_pricing: [] }],
    createID: 77
  });
  await syncPricing({
    client,
    template: pricingTemplate({
      channel: {
        name: 'Domestic models',
        status: 'disabled',
        groups: { platforms: ['deepseek'] }
      }
    }),
    options: parseArgs(['--file', 'pricing.json', '--apply']),
    logger: { log() {} }
  });
  const createCall = client.calls.find((call) => call.endpoint === '/api/v1/admin/channels' && call.options?.method === 'POST');
  const disableCall = client.calls.find((call) => call.endpoint === '/api/v1/admin/channels/77' && call.options?.method === 'PUT');
  assert.equal('status' in createCall.options.body, false);
  assert.deepEqual(disableCall.options.body, { status: 'disabled' });
});
