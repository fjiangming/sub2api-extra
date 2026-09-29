'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('primary modules use an accessible top tab bar', () => {
  assert.match(html, /<header class="module-header">/);
  assert.match(html, /<nav id="main-nav" class="module-tabs"[^>]*role="tablist">/);
  assert.equal((html.match(/class="module-tab(?: active)?"/g) || []).length, 9);
  assert.doesNotMatch(html, /class="sidebar"|id="mobile-menu"/);
});

test('cost analysis exposes reporting plus editable income and expense ledgers', () => {
  assert.match(html, /data-view="costs"/);
  assert.match(html, /id="cost-analysis-filter"/);
  assert.match(html, /id="cost-income-add"/);
  assert.match(html, /id="cost-income-form"/);
  assert.match(html, /id="cost-income-breakdown"/);
  assert.match(html, /id="cost-incomes"/);
  assert.match(html, /id="cost-expense-form"/);
  assert.match(html, /id="cost-provider-sync"/);
  assert.match(html, /id="cost-periods"/);
  assert.match(html, /<script src="\/cost-analysis-ui\.js\?v=[^"]+" defer><\/script>[\s\S]*<script src="\/app\.js\?v=[^"]+" defer><\/script>/);
  assert.match(script, /api\(`\/api\/cost-analysis\?\$\{search\}`\)/);
  assert.match(script, /api\(`\/api\/cost-analysis\/incomes\?\$\{search\}`\)/);
  assert.match(script, /api\('\/api\/cost-analysis\/providers\?refresh=true'\)/);
  assert.match(script, /\/api\/cost-analysis\/incomes/);
  assert.match(script, /method: id \? 'PUT' : 'POST'/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /CostAnalysisUi\.entryEditorCurrency\(entry\)/);
  assert.match(script, /CostAnalysisUi\.focusLedgerEntryFilter/);
  assert.match(script, /report\.summary\.automaticRevenue/);
  assert.match(script, /report\.summary\.manualRevenue/);
  assert.match(script, /report\.summary\.userBalance/);
  assert.match(script, /report\.summary\.actualProfit/);
  assert.match(script, /report\.summary\.actualMargin/);
  assert.match(script, /metricCard\('用户总余额'/);
  assert.match(script, /metricCard\('实际利润'/);
  assert.match(html, /<th class="numeric">自动收入<\/th>/);
  assert.match(html, /<th class="numeric">兑换笔数<\/th>/);
  assert.match(script, /refreshCostAnalysisAfterMutation/);
  assert.doesNotMatch(script, /updateCostProviderCurrency/);
});

test('system settings exposes guarded database setup and cleanup configuration', () => {
  assert.match(html, /data-view="settings"/);
  assert.match(html, /id="database-provision-form"/);
  assert.match(html, /id="database-test-button"/);
  assert.match(html, /id="cleanup-settings-form"/);
  assert.match(html, /id="sub2api-credential-form"/);
  assert.match(script, /api\('\/api\/settings\/database\/provision'/);
  assert.match(script, /api\('\/api\/settings\/sub2api-credentials'/);
  assert.match(script, /settings\.setupRequired \? 'settings'/);
});

test('navigation keeps tab selection state and keyboard controls in sync', () => {
  assert.match(script, /setAttribute\('aria-selected', String\(active\)\)/);
  assert.match(script, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(script, /function revealActiveTab\(\)[\s\S]*nav\.scrollLeft/);
  assert.doesNotMatch(script, /\.nav-item|mobile-menu|menu-open/);
});

test('retention view separates automatic status from guarded manual cleanup', () => {
  assert.match(html, /id="automatic-cleanup-summary"/);
  assert.match(html, /<h2>自动清理<\/h2>/);
  assert.match(html, /<h2>手动清理<\/h2>/);
  assert.match(script, /api\('\/api\/retention\/automation'\)/);
});

test('embedded access exchanges the Sub2API token for a local session', () => {
  assert.match(script, /query\.get\('token'\).*query\.get\('access_token'\)/);
  assert.match(script, /api\('\/api\/auth\/sso'/);
  assert.match(script, /query\.delete\('token'\)[\s\S]*history\.replaceState/);
  assert.match(script, /authorization: `Session \$\{state\.sessionToken\}`/);
  assert.match(script, /browserSession\.setItem\('operations-center\.session'/);
  assert.match(html, /id="sub2api-login-link"[^>]*target="_top"/);
  assert.match(script, /payload\?\.error\?\.code === 'AUTH_REQUIRED'/);
  assert.match(script, /AUTH_UPSTREAM_UNAVAILABLE: '运营中心无法连接 Sub2API/);
});
