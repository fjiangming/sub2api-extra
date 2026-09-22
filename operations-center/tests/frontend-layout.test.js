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
  assert.equal((html.match(/class="module-tab(?: active)?"/g) || []).length, 8);
  assert.doesNotMatch(html, /class="sidebar"|id="mobile-menu"/);
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
