'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSimulation, validateCandidate, projectSimulation, DEFAULT_RULES } = require('../src/simulation');

const options = { now: new Date('2026-10-15T03:00:00Z'), timezone: 'Asia/Shanghai', seed: '0123456789abcdef0123456789abcdef' };

test('seeded simulation stays inside bounds, avoids integer displays, and reproduces a retained roster', () => {
  for (const distribution of ['natural', 'close', 'concentrated']) {
    const rules = { ...DEFAULT_RULES, minimumTokens: 1e6, maximumTokens: 1e9, distribution };
    const candidate = generateSimulation(rules, options);
    assert.deepEqual(validateCandidate(candidate, options.timezone), candidate);
    assert.deepEqual(generateSimulation(rules, { ...options, roster: candidate.rows.map(({ key, name, avatar }) => ({ key, name, avatar })) }), candidate);
    assert.equal(new Set(candidate.rows.map((row) => row.key)).size, 10);
    assert.equal(new Set(candidate.rows.map((row) => row.name)).size, 10);
    for (const period of ['today', 'week', 'month', 'all']) {
      assert.equal(new Set(candidate.rows.map((row) => (row.values[period].tokens / 1e6).toFixed(2))).size, 10);
      for (const row of candidate.rows) {
        const { tokens, requests } = row.values[period];
        assert.ok(Number.isSafeInteger(tokens) && tokens >= 1e6 && tokens <= 1e9);
        assert.notEqual(tokens % 1000, 0);
        assert.ok(!(tokens / 1e6).toFixed(2).endsWith('.00'));
        assert.ok(Number.isSafeInteger(requests) && requests > 0 && requests < tokens);
      }
    }
  }
  const first = generateSimulation(DEFAULT_RULES, options);
  const second = generateSimulation(DEFAULT_RULES, { ...options, seed: 'f'.repeat(32) });
  assert.notDeepEqual(first.rows.map((row) => row.values), second.rows.map((row) => row.values));
  const altered = structuredClone(first);
  altered.rows[0].values.today.tokens++;
  assert.throws(() => validateCandidate(altered, options.timezone), { code: 'SIMULATION_INVALID' });
  assert.throws(() => validateCandidate(first, 'UTC'), { code: 'SIMULATION_INVALID' });
});

test('calendar aggregates preserve subset relations at month, week, year and DST boundaries', () => {
  for (const [now, timezone] of [
    ['2026-11-01T04:30:00Z', 'America/New_York'], ['2026-03-08T07:30:00Z', 'America/New_York'],
    ['2027-01-01T00:30:00Z', 'Asia/Shanghai'], ['2026-06-01T01:30:00Z', 'UTC'], ['2026-10-15T23:30:00Z', 'Pacific/Auckland']
  ]) {
    const candidate = generateSimulation(DEFAULT_RULES, { ...options, now: new Date(now), timezone });
    assert.deepEqual(validateCandidate(candidate, timezone), candidate);
    for (const { values: v } of candidate.rows) for (const metric of ['tokens', 'requests']) {
      assert.ok(v.today[metric] <= v.week[metric] && v.today[metric] <= v.month[metric]);
      assert.ok(v.week[metric] <= v.all[metric] && v.month[metric] <= v.all[metric]);
      if (candidate.date.endsWith('-01')) assert.equal(v.month[metric], v.today[metric]);
      if (candidate.date === '2026-11-01') assert.ok(v.week[metric] > v.month[metric]);
      if (candidate.date === '2026-06-01') assert.equal(v.week[metric], v.today[metric]);
    }
  }
});

test('impossible or out of bounds ranges fail rather than widening bounds or looping forever', () => {
  for (const rules of [
    { ...DEFAULT_RULES, minimumTokens: 999999 }, { ...DEFAULT_RULES, maximumTokens: 1000000001 },
    { ...DEFAULT_RULES, minimumTokens: 1e6, maximumTokens: 1e6 }, { ...DEFAULT_RULES, minimumTokens: 1e6 + .5 }
  ]) assert.throws(() => generateSimulation(rules, options), { code: 'INVALID_REQUEST' });
  assert.throws(() => generateSimulation({ ...DEFAULT_RULES, minimumTokens: 1e6, maximumTokens: 1000001 }, options), { code: 'SIMULATION_RANGE_INVALID' });
});

test('real rows are reserved, ties prefer real users, and totals and masked identities match the visible list', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  const real = [
    { key: 'real-one', name: candidate.rows[0].name, tokens: candidate.rows[0].values.month.tokens, requests: 2, rank: 1 },
    { key: 'real-large', name: 'la***@test.com', tokens: 2000000001, requests: 1, rank: 2 }
  ];
  const board = { period: 'month', metric: 'tokens', entries: real, qualifiedEntries: real, summary: { tokens: 0 }, comparisonAvailable: true };
  const mixed = projectSimulation(board, candidate, 'test');
  assert.equal(mixed.entries.length, 10);
  assert.deepEqual(mixed.display, { mode: 'mixed', realCount: 2, simulatedCount: 8, version: 'test', snapshotAt: candidate.generatedAt, date: candidate.date });
  assert.equal(mixed.entries[0].key, 'real-large');
  assert.equal(mixed.entries.find((row) => row.key === 'real-one').tokens, real[0].tokens);
  assert.equal(new Set(mixed.entries.map((row) => row.name)).size, 10);
  const tie = mixed.entries.filter((row) => row.tokens === real[0].tokens);
  assert.equal(tie[0].source, 'real');
  assert.ok(tie.every((row) => row.rank === tie[0].rank));
  assert.equal(mixed.summary.tokens, mixed.entries.reduce((sum, row) => sum + row.tokens, 0));
  assert.equal(mixed.summary.requests, mixed.entries.reduce((sum, row) => sum + row.requests, 0));
  assert.ok(mixed.entries.every((row) => !row.comparisonAvailable && row.change === null));
  assert.deepEqual(projectSimulation(board, candidate, 'test').entries, mixed.entries);
  const requests = projectSimulation({ ...board, metric: 'requests' }, candidate, 'test');
  assert.ok(real.every((row) => requests.entries.some((entry) => entry.key === row.key)));
  assert.ok(requests.entries.every((row, i, rows) => !i || rows[i - 1].requests >= row.requests));
  assert.equal(real[0].rank, 1);
});
