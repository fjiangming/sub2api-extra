'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

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

test('collector QR generation uses a non-error waiting state and hides premature download', () => {
  assert.match(script, /response\.status === 425/);
  assert.match(script, /正在生成本单收钱码/);
  assert.match(script, /\$\('download-qr'\)\.hidden = !awaiting \|\| \(isAutomaticMode\(\) && !order\.qrAvailable\)/);
  assert.match(script, /正在通过受控设备生成本单支付宝收钱码/);
});

test('payment notices use the exact payable amount and match each payment mode', () => {
  const elements = new Map();
  const context = vm.createContext({
    URLSearchParams,
    window: {
      location: { search: '?theme=light' },
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false })
    },
    document: {
      documentElement: { classList: { toggle() {} } },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false });
        return elements.get(id);
      }
    }
  });
  // Disable startup while exercising the real browser notice renderer.
  vm.runInContext(`${script}\nfunction bindEvents() {}\nfunction bootstrap() {}`, context);
  const fixtures = [
    { mode: 'personal_accountlog_static', minutes: 3, automatic: true, prefilled: false, adjustment: true },
    { mode: 'personal_transfer_auto', minutes: 3, automatic: true, prefilled: true, adjustment: true },
    { mode: 'sub2api_official', minutes: 20, automatic: true, prefilled: true, adjustment: false },
    { mode: 'personal_manual', minutes: 20, automatic: false, prefilled: false, adjustment: false }
  ];
  for (const fixture of fixtures) {
    context.fixtureConfig = { paymentMode: fixture.mode, automaticConfirmation: fixture.automatic };
    context.fixtureOrder = {
      requestedAmount: '50.00', payableAmount: '50.01',
      createdAt: '2026-10-09T00:00:00.000Z',
      expiresAt: new Date(Date.parse('2026-10-09T00:00:00.000Z') + fixture.minutes * 60000).toISOString()
    };
    vm.runInContext('state.config = fixtureConfig; renderPaymentNotice(fixtureOrder)', context);
    assert.equal(elements.get('payment-notice-amount').textContent, '50.01', fixture.mode);
    assert.equal(elements.get('payment-notice-amount-intro').textContent, fixture.prefilled ? '确认金额 ' : '手动填写 ', fixture.mode);
    assert.equal(elements.get('payment-notice-expiry').textContent, `订单${fixture.minutes}分钟内有效，确认或刷新不会延长。`, fixture.mode);
    assert.equal(elements.get('payment-notice-adjustment').hidden, !fixture.adjustment, fixture.mode);
    assert.match(elements.get('payment-notice-confirmation').textContent, fixture.automatic ? /等待自动确认/ : /等待管理员核验/, fixture.mode);
    if (fixture.mode === 'personal_transfer_auto') {
      assert.match(elements.get('payment-notice-amount-suffix').textContent, /保留自动备注/);
    }
  }
});
