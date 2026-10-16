'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSnapshot: generateSimulation, validateCandidate, projectSimulation, DEFAULT_RULES } = require('../src/simulation');

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
        assert.ok(tokens >= rules.boardMinimumTokens && tokens <= rules.boardMaximumTokens);
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
    { ...DEFAULT_RULES, minimumTokens: 1e6, maximumTokens: 1e6 }, { ...DEFAULT_RULES, minimumTokens: 1e6 + .5 },
    { ...DEFAULT_RULES, boardMinimumTokens: 999999 }, { ...DEFAULT_RULES, boardMaximumTokens: 1000000001 },
    { ...DEFAULT_RULES, boardMinimumTokens: 5e6, boardMaximumTokens: 5e6 },
    { ...DEFAULT_RULES, minimumTokens: 50e6, boardMaximumTokens: 20e6 },
    { ...DEFAULT_RULES, maximumTokens: 20e6, boardMinimumTokens: 50e6 }
  ]) assert.throws(() => generateSimulation(rules, options), { code: 'INVALID_REQUEST' });
  assert.throws(() => generateSimulation({ ...DEFAULT_RULES, minimumTokens: 1e6, maximumTokens: 1000001, boardMinimumTokens: 1e6 }, options), { code: 'SIMULATION_RANGE_INVALID' });
});

test('real rows retain above-ceiling usage and below-floor contenders beat the metric cutoff without changing actual values', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  const real = [
    { key: 'real-one', name: candidate.rows[0].name, tokens: candidate.rows[0].values.month.tokens, requests: 2, rank: 1 },
    { key: 'real-small', name: 'sm***@test.com', tokens: 3000123, requests: 1, rank: 2 },
    { key: 'real-large', name: 'la***@test.com', tokens: 2000000001, requests: 1, rank: 3 },
    { key: 'real-below', name: 'be***@test.com', tokens: 999999, requests: 100, rank: 4 }
  ];
  const board = { period: 'month', metric: 'tokens', entries: real, qualifiedEntries: real, summary: { tokens: 0 }, comparisonAvailable: true };
  const mixed = projectSimulation(board, candidate, 'test');
  assert.equal(mixed.entries.length, 10);
  assert.deepEqual(mixed.display, { rangeApplied: true, mode: 'mixed', realCount: 3, simulatedCount: 7, version: 'test', snapshotAt: candidate.generatedAt, date: candidate.date });
  assert.equal(mixed.entries.find((row) => row.key === 'real-large').tokens, 2000000001);
  assert.ok(!mixed.entries.some((row) => row.key === 'real-below'));
  assert.ok(mixed.entries.every((row, i, rows) => !i || rows[i - 1].tokens >= row.tokens));
  assert.ok(mixed.entries.findIndex((row) => row.key === 'real-small') > 0);
  assert.equal(mixed.entries.find((row) => row.key === 'real-one').tokens, real[0].tokens);
  assert.equal(new Set(mixed.entries.map((row) => row.name)).size, 10);
  const tie = mixed.entries.filter((row) => row.tokens === real[0].tokens);
  assert.ok(tie.every((row) => row.rank === tie[0].rank));
  assert.equal(mixed.summary.tokens, mixed.entries.reduce((sum, row) => sum + row.tokens, 0));
  assert.equal(mixed.summary.requests, mixed.entries.reduce((sum, row) => sum + row.requests, 0));
  assert.ok(mixed.entries.every((row) => !row.comparisonAvailable && row.change === null));
  assert.deepEqual(projectSimulation(board, candidate, 'test').entries, mixed.entries);
  const requests = projectSimulation({ ...board, metric: 'requests' }, candidate, 'test');
  assert.equal(requests.entries.find((row) => row.key === 'real-below').requests, 100);
  assert.equal(requests.entries.find((row) => row.key === 'real-below').tokens, 999999);
  for (const row of real) if (row.requests > requests.entries.at(-1).requests) {
    assert.ok(requests.entries.some((entry) => entry.key === row.key));
  }
  assert.ok(requests.entries.every((row, i, rows) => !i || rows[i - 1].requests >= row.requests));
  assert.equal(real[0].rank, 1);
});

test('simulation uses the intersection of the independent single-user and board ranges in all periods', () => {
  for (const distribution of ['natural', 'close', 'concentrated']) {
    const rules = { ...DEFAULT_RULES, minimumTokens: 20e6, maximumTokens: 200e6, boardMinimumTokens: 5e6, boardMaximumTokens: 80e6, distribution };
    const candidate = generateSimulation(rules, options);
    assert.deepEqual(candidate.rules, rules);
    assert.equal(candidate.version, 3);
    assert.deepEqual(validateCandidate(candidate, options.timezone), candidate);
    for (const row of candidate.rows) for (const period of ['today', 'week', 'month', 'all']) {
      assert.ok(row.values[period].tokens >= 20e6 && row.values[period].tokens <= 80e6);
    }
    const raised = generateSimulation({ ...rules, minimumTokens: 1e6, boardMinimumTokens: 30e6 }, options);
    assert.ok(raised.rows.every((row) => Object.values(row.values).every((value) => value.tokens >= 30e6 && value.tokens <= 80e6)));
    const tampered = structuredClone(candidate);
    tampered.rules.boardMaximumTokens = 50e6;
    assert.throws(() => validateCandidate(tampered, options.timezone), { code: 'SIMULATION_INVALID' });
  }
});

test('equal values share a rank and seeded tie order does not favor either real or simulated users', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  let realFirst = false;
  let simulationFirst = false;
  for (let index = 0; index < 16; index++) {
    const real = { key: `tie-${index}`, name: 'ti***@test.com', tokens: 3000123, requests: 1 };
    const board = { period: 'month', metric: 'tokens', entries: [real], qualifiedEntries: [real] };
    const initial = projectSimulation(board, candidate, 'test');
    real.tokens = initial.entries.filter((row) => row.source === 'simulation')[index % 9].tokens;
    const result = projectSimulation(board, candidate, 'test');
    const tied = result.entries.filter((row) => row.tokens === real.tokens);
    assert.equal(tied.length, 2);
    assert.equal(tied[0].rank, tied[1].rank);
    realFirst ||= tied[0].source === 'real'; simulationFirst ||= tied[0].source === 'simulation';
    assert.deepEqual(projectSimulation(board, candidate, 'test').entries, result.entries);
  }
  assert.ok(realFirst && simulationFirst);
});

test('no real user beating the displayed cutoff is omitted across periods, metrics and candidate counts', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  for (let count = 0; count <= 25; count++) for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const real = Array.from({ length: count }, (_, i) => ({ key: `real-${i}`, name: `person-${i}`,
      source: 'real', tokens: i % 3 ? 100000 + i : 2000000000 + i, requests: (count - i) * 2000 + i % 2 }));
    const ordered = real.toSorted((a, b) => b[metric] - a[metric]);
    const board = { period, metric, entries: ordered.slice(0, 10),
      qualifiedEntries: ordered.filter((row) => row.tokens >= candidate.rules.boardMinimumTokens).slice(0, 10) };
    const mixed = projectSimulation(board, candidate, 'test');
    assert.equal(mixed.entries.length, 10);
    assert.equal(new Set(mixed.entries.map((row) => row.key)).size, 10);
    assert.ok(mixed.entries.every((row, i, entries) => !i || entries[i - 1][metric] >= row[metric]));
    for (const row of real) if (row[metric] > mixed.entries.at(-1)[metric]) {
      assert.ok(mixed.entries.some((entry) => entry.key === row.key), `${period}/${metric}: omitted ${row.key}`);
    }
    assert.equal(mixed.display.realCount, mixed.entries.filter((row) => row.source === 'real').length);
    assert.equal(mixed.display.simulatedCount, mixed.entries.filter((row) => row.source === 'simulation').length);
  }
});

test('legacy daily snapshots still replay until an administrator regenerates the new range rules', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  const { origin, ...snapshot } = candidate;
  const { boardMinimumTokens, boardMaximumTokens, ...legacyRules } = candidate.rules;
  const legacy = { ...snapshot, version: 1, rules: legacyRules };
  const bounded = { ...snapshot, version: 2 };
  assert.deepEqual(validateCandidate(legacy, options.timezone), legacy);
  assert.deepEqual(validateCandidate(bounded, options.timezone), bounded);
  assert.deepEqual(generateSimulation(DEFAULT_RULES, { ...options, previous: legacy }).rows, candidate.rows);
  assert.deepEqual(generateSimulation(DEFAULT_RULES, { ...options, previous: bounded }).rows, candidate.rows);
  const large = { key: 'large', name: 'la***@test.com', tokens: 2e9, requests: 1 };
  const board = { period: 'month', metric: 'tokens', entries: [large], qualifiedEntries: [large] };
  assert.equal(projectSimulation(board, legacy, 'old').display.realCount, 1);
  assert.equal(projectSimulation(board, candidate, 'new').display.realCount, 1);
});

test('identical calendar windows select identical mixed boards for every real-user count and metric', () => {
  const candidate = generateSimulation(DEFAULT_RULES, { ...options, now: new Date('2026-06-01T03:00:00Z') });
  for (let count = 0; count <= 10; count++) for (const metric of ['tokens', 'requests']) {
    const real = Array.from({ length: count }, (_, i) => ({ key: `real-${i}`, name: `person-${i}`, tokens: 30000123 + i, requests: 2000 + i }));
    const boards = ['today', 'week', 'month'].map((period) => projectSimulation({ period, metric, entries: real, qualifiedEntries: real }, candidate, 'same'));
    assert.deepEqual(boards[0].entries, boards[1].entries);
    assert.deepEqual(boards[0].entries, boards[2].entries);
    assert.deepEqual(boards[0].summary, boards[1].summary);
  }
});

test('retained identities replay one history, append daily increments and ignore regeneration timing and path', () => {
  const initialRules = { ...DEFAULT_RULES, minimumTokens: 1e6, boardMinimumTokens: 1e6, maximumTokens: 80e6, boardMaximumTokens: 80e6 };
  const rules = { ...initialRules, maximumTokens: 1e9, boardMaximumTokens: 1e9 };
  for (const [start, following, next] of [
    ['2026-05-31T03:00:00Z', '2026-06-01T03:00:00Z', '2026-06-02T03:00:00Z'],
    ['2026-12-31T03:00:00Z', '2027-01-01T03:00:00Z', '2027-01-02T03:00:00Z']
  ]) {
    const initial = generateSimulation(initialRules, { ...options, now: new Date(start) });
    const first = generateSimulation(rules, { ...options, now: new Date(following), previous: initial });
    const repeated = generateSimulation(rules, { ...options, seed: 'f'.repeat(32), now: new Date(following.replace('03:00', '08:00')), previous: first });
    assert.deepEqual(repeated.rows, first.rows);
    assert.equal(repeated.seed, initial.seed);
    assert.deepEqual(validateCandidate(first, options.timezone), first);
    const second = generateSimulation(rules, { ...options, now: new Date(next), previous: first });
    const direct = generateSimulation(rules, { ...options, now: new Date(next), previous: initial });
    assert.deepEqual(second, direct);
    for (let i = 0; i < first.rows.length; i++) for (const metric of ['tokens', 'requests']) {
      const before = initial.rows[i].values;
      const middle = first.rows[i].values;
      const after = second.rows[i].values;
      assert.equal(middle.all[metric] - before.all[metric], middle.today[metric]);
      assert.equal(middle.month[metric], middle.today[metric]);
      if (first.date === '2026-06-01') assert.equal(middle.week[metric], middle.today[metric]);
      assert.equal(after.all[metric] - middle.all[metric], after.today[metric]);
      assert.equal(after.month[metric] - middle.month[metric], after.today[metric]);
      assert.equal(after.week[metric] - middle.week[metric], after.today[metric]);
    }
    const altered = structuredClone(first);
    altered.origin.generatedAt = start.replace('31T', '30T');
    assert.throws(() => validateCandidate(altered, options.timezone), { code: 'SIMULATION_INVALID' });
  }
});

test('incompatible bounds, distribution and backwards dates cannot rewrite retained history', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  for (const [rules, now] of [
    [{ ...DEFAULT_RULES, boardMaximumTokens: 50e6 }, options.now],
    [{ ...DEFAULT_RULES, distribution: 'close' }, options.now],
    [DEFAULT_RULES, new Date('2026-10-14T03:00:00Z')],
    [DEFAULT_RULES, new Date('9999-01-01T03:00:00Z')]
  ]) assert.throws(() => generateSimulation(rules, { ...options, now, previous: candidate }), { code: 'SIMULATION_HISTORY_CONFLICT' });
});
