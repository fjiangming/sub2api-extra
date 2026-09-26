'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nextDailyRunAt, parseDailyTime } = require('../src/schedule');

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
