'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'public', 'styles.css'), 'utf8');
const script = fs.readFileSync(path.join(projectRoot, 'public', 'app.js'), 'utf8');

test('recharge UI keeps the current Sub2API payment layout contract', () => {
  assert.match(html, /class="card account-card"/);
  assert.match(html, /id="amount-options"[^>]+role="radiogroup"/);
  assert.match(html, /id="custom-amount"[^>]+inputmode="decimal"/);
  assert.match(html, /<span aria-hidden="true">\$<\/span>\s*<input id="custom-amount"/);
  assert.match(html, /id="order-summary-card"[^>]+hidden/);
  assert.match(html, /id="payment-method-card"/);
  assert.match(html, /class="card payment-card"/);
  assert.match(html, /当前余额:/);
  assert.match(html, /支付金额/);
  assert.match(html, /确认支付 ¥0\.00/);
  assert.doesNotMatch(html, /预计入账额度/);
  assert.doesNotMatch(html, /随机分角尾数/);
  assert.match(html, /class="view-tabs"/);
  assert.match(css, /--primary-500:\s*#14b8a6/);
  assert.match(css, /--primary-600:\s*#0d9488/);
  assert.match(css, /width:\s*min\(896px, 100%\)/);
  assert.match(css, /\.card\s*\{[^}]*border-radius:\s*16px/s);
  assert.match(css, /\.amount-options\s*\{[^}]*gap:\s*16px;[^}]*padding-top:\s*8px/s);
  assert.doesNotMatch(css, /#1677ff|#0d65dd/i);
});

test('embedded pages follow the Sub2API theme and remove the duplicate app shell', () => {
  assert.match(script, /presentationParams\.get\('theme'\)/);
  assert.match(script, /presentationParams\.get\('ui_mode'\) === 'embedded'/);
  assert.match(script, /window\.self !== window\.top/);
  assert.match(script, /classList\.toggle\('dark'/);
  assert.match(script, /classList\.toggle\('embedded'/);
  assert.match(css, /html\.embedded \.standalone-only\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(css, /#recharge-page-header,\s*#history-section\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.mesh-background\s*\{[^}]*display:\s*none/s);
  assert.match(css, /html\.dark\s*\{/);
});

test('recharge interactions use native-style feedback instead of browser dialogs', () => {
  assert.match(html, /id="confirm-dialog" class="modal-dialog"/);
  assert.match(html, /id="toast-region" class="toast-region"/);
  assert.match(css, /\.modal-dialog::backdrop/);
  assert.match(css, /\.button\.primary\s*\{[^}]*linear-gradient/s);
  assert.match(css, /\.button:active:not\(:disabled\)\s*\{[^}]*scale\(0\.98\)/s);
  assert.doesNotMatch(script, /window\.confirm\s*\(/);
  assert.match(script, /\^\\d\*\(\?:\\\.\\d\{0,2\}\)\?\$/);
  assert.match(script, /isAutomaticMode\(\) \? 3000 : 10000/);
  assert.match(script, /if \(isOfficialMode\(\)\) \{\s*state\.session = await api\('\/api\/auth\/refresh'/s);
  assert.match(script, /state\.session\.user\.balance = currentBalance \+ creditedAmount/);
  assert.match(script, /classList\.toggle\('payment-phase-active', Boolean\(order\)\)/);
  assert.match(css, /body\.payment-phase-active \.account-card\s*\{[^}]*display:\s*none/s);
});
