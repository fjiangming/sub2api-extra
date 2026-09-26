'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  nextDailyRunAt,
  nextDailyTimesRunAt,
  nextIntervalRunAt,
  nextScheduledRunAt,
  parseDailyTime
} = require('../src/schedule');

test('daily schedule selects the next fixed Asia/Shanghai wall-clock time', () => {
  const before = Date.parse('2026-09-26T00:00:00.000Z');
  const after = Date.parse('2026-09-26T02:00:00.000Z');
  assert.equal(
    new Date(nextDailyRunAt('09:30', before, 'Asia/Shanghai')).toISOString(),
    '2026-09-26T01:30:00.000Z'
  );
  assert.equal(
    new Date(nextDailyRunAt('09:30', after, 'Asia/Shanghai')).toISOString(),
    '2026-09-27T01:30:00.000Z'
  );
});

test('daily schedule rejects invalid clock values', () => {
  assert.deepEqual(parseDailyTime('00:05'), { hour: 0, minute: 5, value: '00:05' });
  assert.throws(() => parseDailyTime('24:00'), /无效/);
  assert.throws(() => parseDailyTime('9:30'), /HH:mm/);
});

test('daily schedule selects the nearest of multiple fixed times', () => {
  const from = Date.parse('2026-09-26T02:00:00.000Z');
  assert.equal(
    new Date(nextDailyTimesRunAt(['09:30', '18:45'], from, 'Asia/Shanghai')).toISOString(),
    '2026-09-26T10:45:00.000Z'
  );
  assert.equal(
    new Date(nextDailyTimesRunAt(['09:30', '18:45'], Date.parse('2026-09-26T11:00:00.000Z'), 'Asia/Shanghai')).toISOString(),
    '2026-09-27T01:30:00.000Z'
  );
});

test('interval and generic schedules calculate the next run from the supplied baseline', () => {
  const from = Date.parse('2026-09-26T00:00:00.000Z');
  assert.equal(nextIntervalRunAt(90, from), from + 90 * 60 * 1000);
  assert.equal(nextScheduledRunAt({
    mode: 'interval', times: ['09:00'], intervalMinutes: 180
  }, from, 'Asia/Shanghai'), from + 180 * 60 * 1000);
  assert.throws(() => nextIntervalRunAt(0, from), /1 到 43200/);
  assert.throws(() => nextDailyTimesRunAt([], from), /至少需要一个/);
});
