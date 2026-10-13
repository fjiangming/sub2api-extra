'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestGate, dailyRows, percent, platformColor } = require('../public/user-profiles-ui');

test('late requests cannot replace a newer filter or reopen a closed user drawer', () => {
  const gate = createRequestGate();
  const oldRequest = gate.next();
  const newRequest = gate.next();
  assert.equal(gate.current(oldRequest), false);
  assert.equal(gate.current(newRequest), true);
  gate.invalidate();
  assert.equal(gate.current(newRequest), false);
});

test('activity dates distinguish known zero days from missing or unverified detail', () => {
  const days = dailyRows({ range: { start: '2026-10-01', end: '2026-10-04' },
    trend: [{ date: '2026-10-02', requests: 7, cost: 3 }],
    coverage: { selected: { missingDays: ['2026-10-02', '2026-10-03'], unverifiedDays: ['2026-10-04'] } } });
  assert.deepEqual(days.map((d) => d.requests), [0, 7, null, null]);
  assert.deepEqual(days.map((d) => d.uncertain), [false, true, true, true]);
  assert.deepEqual(days.map((d) => d.cost), [0, 3, null, null]);
});

test('zero denominators have no invented percentage and dynamic platforms keep consistent colors', () => {
  assert.equal(percent(0, 0), '—');
  assert.equal(percent(1, 4), '25%');
  assert.equal(percent(1, 100000), '< 0.1%');
  assert.equal(platformColor('future-provider'), platformColor('future-provider'));
  assert.match(platformColor('future-provider'), /^#[0-9a-f]{6}$/);
  assert.notEqual(platformColor('openai'), platformColor('gemini'));
});
