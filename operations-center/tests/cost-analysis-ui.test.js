'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expenseEditorCurrency, focusExpenseFilter } = require('../public/cost-analysis-ui');

function fields({ start = '2026-09-01', end = '2026-09-30', currency = 'CNY' } = {}) {
  return {
    start: { value: start },
    end: { value: end },
    currency: { value: currency }
  };
}

test('new expenses default to CNY while edits retain their recorded currency', () => {
  assert.equal(expenseEditorCurrency(null), 'CNY');
  assert.equal(expenseEditorCurrency({ currency: 'usd' }), 'USD');
});

test('saved expense switches the report currency so a provider cost remains visible', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-09-15', currency: 'usd' });

  assert.deepEqual(result, {
    currency: 'USD', date: '2026-09-15', currencyChanged: true, dateChanged: false
  });
  assert.equal(elements.currency.value, 'USD');
  assert.equal(elements.start.value, '2026-09-01');
  assert.equal(elements.end.value, '2026-09-30');
});

test('saved expense outside the report range narrows the range to its date', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-10-05', currency: 'CNY' });

  assert.equal(result.currencyChanged, false);
  assert.equal(result.dateChanged, true);
  assert.equal(elements.start.value, '2026-10-05');
  assert.equal(elements.end.value, '2026-10-05');
});

test('editing both currency and date updates both report filters', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2025-12-31', currency: 'EUR' });

  assert.equal(result.currencyChanged, true);
  assert.equal(result.dateChanged, true);
  assert.deepEqual(
    [elements.start.value, elements.end.value, elements.currency.value],
    ['2025-12-31', '2025-12-31', 'EUR']
  );
});

test('saved expense already covered by the report leaves filters unchanged', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-09-10', currency: 'CNY' });

  assert.equal(result.currencyChanged, false);
  assert.equal(result.dateChanged, false);
  assert.deepEqual(
    [elements.start.value, elements.end.value, elements.currency.value],
    ['2026-09-01', '2026-09-30', 'CNY']
  );
});
