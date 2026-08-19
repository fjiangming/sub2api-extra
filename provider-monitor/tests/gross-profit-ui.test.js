const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('gross profit dashboard exposes supplier daily defaults and all requested dimensions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  assert.match(html, /data-view="gross-profit"[\s\S]*?<span>毛利统计<\/span>/);
  assert.match(app, /grossProfitFilters:\s*\{\s*dimension: 'provider', granularity: 'day'/);
  assert.match(app, /provider: '上游供应商'/);
  assert.match(app, /key: 'Key'/);
  assert.match(app, /account: '账号'/);
  assert.match(app, /day: '每天'/);
  assert.match(app, /week: '每周'/);
  assert.match(app, /month: '每月'/);
  assert.match(app, /id="gross-profit-provider"/);
  assert.match(app, /id="gross-profit-from" type="date"/);
  assert.match(app, /id="gross-profit-to" type="date"/);
  assert.match(app, /id="gross-profit-accounting-mode"/);
  assert.match(app, /gross-profit-currency-mode/);
  assert.match(app, /standard: '标准毛利'/);
  assert.match(app, /exclude_admin: '排除管理员用户账本'/);
  assert.match(app, /admin_expense: '管理员消费计入费用（纯毛利）'/);
  assert.match(app, /基座账本缺少请求用户 ID/);
  assert.match(app, /accountingMode: filters\.accountingMode \|\| 'standard'/);
  assert.match(app, /state\.grossProfitFilters = previousFilters;[\s\S]*?paintGrossProfit\(state\.grossProfit\)/);
  assert.match(app, /id="gross-profit-chart"/);
  assert.match(app, /上游供应商汇总|GROSS_PROFIT_DIMENSION_LABELS/);
  assert.match(app, /周期明细/);
  assert.match(app, /api\(`\/api\/gross-profit\?\$\{search\}`\)/);
  assert.match(css, /\.gross-profit-controls/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.gross-profit-controls/);
  assert.match(css, /\.gross-profit-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.gross-profit-currency-mode/);
  assert.match(css, /\.gross-profit-value\.negative/);
});
