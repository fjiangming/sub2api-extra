'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSimulation, generateSnapshot, advanceSimulation, validateCandidate, projectSimulation, DEFAULT_RULES } = require('../src/simulation');

const options = { now: new Date('2026-10-15T03:00:00Z'), timezone: 'Asia/Shanghai', seed: '0123456789abcdef0123456789abcdef' };
const metrics = ['tokens', 'requests'];
const periods = ['today', 'week', 'month', 'all'];
function check(candidate, rules = candidate.rules) {
  assert.equal(candidate.rows.length, 10);
  assert.equal(new Set(candidate.rows.map((row) => row.key)).size, 10);
  assert.equal(new Set(candidate.rows.map((row) => row.name)).size, 10);
  for (const row of candidate.rows) {
    assert.match(row.name, /^\w{2}\*\*\*@(qq\.com|gmail\.com|163\.com)$/);
    if (row.name.endsWith('@qq.com')) assert.match(row.name, /^[1-9][0-9]\*\*\*@qq\.com$/);
    for (const period of periods) {
      assert.ok(row.values[period].tokens >= Math.max(rules.minimumTokens, rules.boardMinimumTokens));
      assert.ok(row.values[period].tokens <= Math.min(rules.maximumTokens, rules.boardMaximumTokens));
      assert.ok(Number.isSafeInteger(row.values[period].tokens));
      assert.ok(Number.isSafeInteger(row.values[period].requests) && row.values[period].requests > 0);
    }
    for (const metric of metrics) {
      assert.ok(row.values.today[metric] <= row.values.week[metric] && row.values.today[metric] <= row.values.month[metric]);
      assert.ok(row.values.week[metric] <= row.values.all[metric] && row.values.month[metric] <= row.values.all[metric]);
    }
  }
}

test('live examples replay exactly and use one monotone timeline with pauses and independent user activity', () => {
  const candidate = generateSimulation(DEFAULT_RULES, options);
  const original = structuredClone(candidate);
  assert.equal(candidate.version, 4);
  assert.deepEqual(validateCandidate(candidate, options.timezone), candidate);
  const initial = advanceSimulation(candidate, options.now);
  assert.deepEqual(initial.rows, candidate.rows);
  assert.deepEqual(advanceSimulation(candidate, new Date('2026-10-15T03:04:59Z')), initial);
  let before = initial;
  let moved = false;
  let paused = false;
  for (let minutes = 5; minutes <= 600; minutes += 5) {
    const next = advanceSimulation(candidate, new Date(options.now.getTime() + minutes * 60000));
    check(next);
    assert.equal(next.date, initial.date);
    assert.deepEqual(next.rows.map((row) => row.key), initial.rows.map((row) => row.key));
    for (let i = 0; i < next.rows.length; i++) for (const metric of metrics) {
      const delta = next.rows[i].values.today[metric] - before.rows[i].values.today[metric];
      assert.ok(delta >= 0);
      moved ||= delta > 0; paused ||= delta === 0;
      for (const period of periods) assert.equal(next.rows[i].values[period][metric] - before.rows[i].values[period][metric], delta);
    }
    before = next;
  }
  assert.ok(moved && paused);
  assert.ok(new Set(before.rows.map((row, i) => row.values.today.tokens - initial.rows[i].values.today.tokens)).size > 1);
  assert.deepEqual(candidate, original);
});

test('calendar resets and DST preserve period containment and never reverse the same identity', () => {
  for (const [start, finish, timezone] of [
    ['2026-05-31T12:00Z', '2026-06-01T13:00Z', 'UTC'],
    ['2026-12-31T12:00Z', '2027-01-01T13:00Z', 'Asia/Shanghai'],
    ['2026-10-31T12:00Z', '2026-11-01T14:00Z', 'America/New_York'],
    ['2026-03-07T12:00Z', '2026-03-08T14:00Z', 'America/New_York']
  ]) {
    const candidate = generateSimulation(DEFAULT_RULES, { ...options, now: new Date(start), timezone });
    let before = advanceSimulation(candidate, new Date(start));
    for (let time = Date.parse(start) + 1800000; time <= Date.parse(finish); time += 1800000) {
      const next = advanceSimulation(candidate, new Date(time));
      check(next);
      for (const row of next.rows) {
        const old = before.rows.find((item) => item.key === row.key);
        if (old) assert.equal(row.name, old.name);
        for (const metric of metrics) {
          if (old) assert.ok(row.values.all[metric] >= old.values.all[metric]);
          if (old && next.date === before.date) assert.ok(row.values.today[metric] >= old.values.today[metric]);
          if (next.date.endsWith('-01')) assert.equal(row.values.today[metric], row.values.month[metric]);
          if (next.date === '2026-06-01') assert.equal(row.values.today[metric], row.values.week[metric]);
        }
      }
      before = next;
    }
  }
});

test('bounded examples renew distinct identities indefinitely with deterministic, period-independent filling', () => {
  for (const distribution of ['natural', 'close', 'concentrated']) {
    const rules = { ...DEFAULT_RULES, boardMinimumTokens: 137e6, boardMaximumTokens: 980e6, distribution };
    const candidate = generateSimulation(rules, options);
    for (const date of ['2026-10-16T15:55Z', '2026-11-01T00:00Z', '2027-06-01T03:00Z', '2099-01-01T00:00Z']) {
      const live = advanceSimulation(candidate, new Date(date));
      check(live);
      assert.deepEqual(advanceSimulation(structuredClone(candidate), new Date(date)), live);
      const boards = periods.map((period) => projectSimulation({ period, metric: 'tokens', entries: [], qualifiedEntries: [] }, live, 'live'));
      for (const board of boards) {
        assert.equal(board.entries.length, 10);
        assert.equal(board.display.dynamic, true);
        assert.equal(board.display.intervalSeconds, 300);
        assert.ok(board.entries.every((row, i) => !i || board.entries[i - 1].tokens >= row.tokens));
        assert.deepEqual(new Set(board.entries.map((row) => row.key)), new Set(live.rows.map((row) => row.key)));
      }
    }
    const later = advanceSimulation(candidate, new Date('2027-01-01T00:00Z'));
    assert.ok(later.rows.every((row) => !candidate.rows.some((old) => old.key === row.key)));
  }
});

test('stored example.com timelines retain their original names and remain valid after renewal', () => {
  const generated = generateSnapshot(DEFAULT_RULES, options);
  const prefixes = ['dt', 'pd', 'if', 'ok', 'xe', 'wq', 'hp', 'tr', 'wk', 'iz'];
  const roster = generated.rows.map(({ key, avatar }, index) => ({ key, avatar, name: `${prefixes[index]}***@example.com` }));
  const legacy = generateSnapshot(DEFAULT_RULES, { ...options, roster, origin: { generatedAt: options.now.toISOString(), rules: DEFAULT_RULES } });
  const candidate = generateSimulation(DEFAULT_RULES, { ...options, previous: legacy });
  const renewed = generateSimulation(DEFAULT_RULES, { ...options, previous: candidate, now: new Date('2027-01-01T00:00:00Z') });
  assert.deepEqual(renewed.rows.map((row) => row.name),
    ['ov', 'dy', 'ck', 'bh', 'ay', 'wq', 'hp', 'ah', 'wk', 'iz'].map((prefix) => `${prefix}***@example.com`));
  assert.deepEqual(validateCandidate(renewed, options.timezone), renewed);
  assert.deepEqual(advanceSimulation(candidate, new Date(renewed.generatedAt)).rows, renewed.rows);
});

test('retaining live history preserves the root timeline across regeneration, migration and clock boundaries', () => {
  const legacy = generateSnapshot(DEFAULT_RULES, options);
  const candidate = generateSimulation(DEFAULT_RULES, { ...options, previous: legacy });
  assert.deepEqual(candidate.rows, legacy.rows);
  const time = new Date('2026-11-01T03:01:17Z');
  const regenerated = generateSimulation(DEFAULT_RULES, { ...options, now: time, previous: candidate });
  assert.deepEqual(regenerated.rows, advanceSimulation(candidate, time).rows);
  assert.deepEqual(regenerated.origin, candidate.origin);
  assert.deepEqual(validateCandidate(regenerated, options.timezone), regenerated);
  const following = new Date('2026-12-01T05:15Z');
  assert.deepEqual(advanceSimulation(candidate, following).rows, advanceSimulation(regenerated, following).rows);
  assert.throws(() => generateSimulation(DEFAULT_RULES, { ...options, previous: regenerated }), { code: 'SIMULATION_HISTORY_CONFLICT' });
  for (const mutate of [
    (value) => value.rows[0].values.all.tokens++,
    (value) => value.origin.rows[0].values.today.requests++,
    (value) => { value.generatedAt = '2026-10-14T00:00:00.000Z'; value.date = '2026-10-14'; },
    (value) => { value.rules.boardMaximumTokens = 50e6; }
  ]) {
    const altered = structuredClone(candidate); mutate(altered);
    assert.throws(() => validateCandidate(altered, options.timezone), { code: 'SIMULATION_INVALID' });
  }
});
