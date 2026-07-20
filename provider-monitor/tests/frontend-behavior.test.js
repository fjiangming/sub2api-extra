const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement() {
  return {
    addEventListener() {},
    append() {},
    classList: { add() {}, remove() {}, toggle() {} },
    close() {},
    dataset: {},
    elements: {},
    hidden: false,
    innerHTML: '',
    querySelector() { return this; },
    querySelectorAll() { return []; },
    remove() {},
    setAttribute() {},
    showModal() {},
    style: {},
    textContent: ''
  };
}

function createBrowserContext() {
  const element = createElement();
  const removedSessionKeys = [];
  const sessionStorage = {
    getItem(key) { return key === 'provider-monitor.session' ? 'active-session' : ''; },
    setItem() {},
    removeItem(key) { removedSessionKeys.push(key); }
  };
  const context = vm.createContext({
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      createElement,
      querySelector() { return element; },
      querySelectorAll() { return []; }
    },
    fetch: async () => { throw new Error('Unexpected fetch'); },
    sessionStorage,
    setTimeout,
    window: { addEventListener() {}, lucide: null }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/app.js' });
  return { context, removedSessionKeys, source };
}

function errorResponse(code, message) {
  return {
    ok: false,
    status: 401,
    async json() { return { error: { code, message } }; }
  };
}

test('an upstream Sub2API 401 does not clear the Provider Monitor session', async () => {
  const { context, removedSessionKeys } = createBrowserContext();
  context.fetch = async () => errorResponse('SUB2API_REQUEST_FAILED', 'Upstream token expired');

  await assert.rejects(
    vm.runInContext("api('/api/sub2api/channels')", context),
    (error) => error.code === 'SUB2API_REQUEST_FAILED'
  );

  assert.equal(vm.runInContext('state.sessionToken', context), 'active-session');
  assert.deepEqual(removedSessionKeys, []);
});

test('a local AUTH_REQUIRED response still clears the expired session', async () => {
  const { context, removedSessionKeys } = createBrowserContext();
  context.fetch = async () => errorResponse('AUTH_REQUIRED', 'Administrator login is required');

  await assert.rejects(
    vm.runInContext("api('/api/summary')", context),
    /登录状态已失效/
  );

  assert.equal(vm.runInContext('state.sessionToken', context), '');
  assert.deepEqual(removedSessionKeys, ['provider-monitor.session']);
});

test('embedded SSO failures are actionable and do not request autofocus', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(vm.runInContext("ssoErrorMessage('AUTH_FAILED')", context), /重新登录/);
  assert.match(vm.runInContext("ssoErrorMessage('ADMIN_REQUIRED')", context), /不是管理员/);
  assert.match(vm.runInContext("ssoErrorMessage('AUTH_UPSTREAM_TIMEOUT')", context), /无法连接/);
  assert.match(vm.runInContext("ssoErrorMessage('SUB2API_SESSION_BINDING_INCOMPATIBLE')", context), /关闭会话绑定/);
  assert.match(vm.runInContext("ssoErrorMessage('UNKNOWN')", context), /单点登录失败/);
  assert.match(source, /if \(ssoError\) \{[\s\S]*?removeItem\('provider-monitor\.session'\);[\s\S]*?return;/);
  assert.doesNotMatch(index, /\sautofocus(?:\s|>)/i);
  assert.match(index, /id="sub2api-login-link" target="_top"/);
});

test('effective rates use at most three decimal places without trailing zeroes', () => {
  const { context, source } = createBrowserContext();

  assert.equal(vm.runInContext('formatRateValue(1)', context), '1');
  assert.equal(vm.runInContext("formatRateValue('1.2000')", context), '1.2');
  assert.equal(vm.runInContext('formatRateValue(0.125)', context), '0.125');
  assert.equal(vm.runInContext('formatRateValue(1.2349)', context), '1.235');
  assert.equal(vm.runInContext('formatEffectiveRate(1)', context), '×1');
  assert.equal(vm.runInContext("formatEffectiveRate('1.2000')", context), '×1.2');
  assert.equal(vm.runInContext('formatEffectiveRate(0.125)', context), '×0.125');
  assert.equal(vm.runInContext('formatEffectiveRate(1.2349)', context), '×1.235');
  assert.equal(vm.runInContext('formatEffectiveRate(null)', context), '-');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: 0.2 })', context), '+20%');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: -0.266666 })', context), '-26.667%');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: 0 })', context), '0%');
  assert.match(source, /const multiplier = formatEffectiveRate\(group\.ratio\);/);
  assert.doesNotMatch(source, /formatNumber\([^\r\n]*,\s*4\)/);
});

test('integration groups render a collapsed outer winner and mark exactly one highest-rate detail', () => {
  const { context } = createBrowserContext();
  const group = {
    groupId: 101,
    groupName: 'Retail',
    status: 'inactive',
    baseRate: 1.1,
    mappingCount: 2,
    channels: [{ id: 11, name: 'Supplier route' }],
    highest: {
      id: 'high', channel_id: 11, account_id: 501, provider_name: 'Supplier A',
      key_name: 'High key', masked_key: 'sk-h...7890',
      comparison: {
        providerGroupName: 'Premium', providerRate: 1.5, baseGroupRate: 1.1,
        status: 'rate_mismatch', channelName: 'Supplier route', channelStatus: 'active',
        differenceRatio: -0.2667, details: { providerGroupStatus: 'inactive' }
      }
    },
    items: [
      {
        id: 'high', channel_id: 11, account_id: 501, provider_name: 'Supplier A',
        key_name: 'High key', masked_key: 'sk-h...7890', isHighestRate: true,
        comparison: {
          providerGroupName: 'Premium', providerRate: 1.5, baseGroupRate: 1.1,
          status: 'rate_mismatch', channelName: 'Supplier route', channelStatus: 'active',
          differenceRatio: -0.2667, details: { providerGroupStatus: 'inactive' }
        }
      },
      {
        id: 'low', channel_id: 11, account_id: 502, provider_name: 'Supplier A',
        key_name: 'Low key', masked_key: 'sk-l...4321', isHighestRate: false,
        comparison: {
          providerGroupName: 'Economy', providerRate: 0.8, baseGroupRate: 1.1,
          status: 'rate_mismatch', channelName: 'Supplier route', channelStatus: 'active',
          differenceRatio: 0.375, details: { providerGroupStatus: 'active' }
        }
      }
    ]
  };
  const serialized = JSON.stringify(group);
  const collapsed = vm.runInContext(`integrationGroupRows(${serialized})`, context);
  assert.match(collapsed, /class="integration-group-row"/);
  assert.match(collapsed, /Supplier A/);
  assert.match(collapsed, /sk-h\.\.\.7890/);
  assert.equal((collapsed.match(/highest-rate-row/g) || []).length, 1);
  assert.equal((collapsed.match(/data-integration-parent="101" hidden/g) || []).length, 2);
  assert.match(collapsed, /badge inactive/);
  assert.match(collapsed, /aria-expanded="false"/);

  vm.runInContext("state.integrationExpandedGroups.add('101')", context);
  const expanded = vm.runInContext(`integrationGroupRows(${serialized})`, context);
  assert.equal((expanded.match(/data-integration-parent="101" hidden/g) || []).length, 0);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /chevron-down/);
});

test('auto-mapping UI uses preview then apply and provides actionable export authentication errors', () => {
  const { context, source } = createBrowserContext();
  assert.match(source, /body: \{ mode: 'preview' \}/);
  assert.match(source, /body: \{ mode: 'apply' \}/);
  assert.match(source, /data-action="auto-map" title="自动映射" aria-label="自动映射"/);
  assert.match(source, /comparisonData\.unassignedItems/);
  assert.match(source, /\[item\.keyName, item\.maskedKey\]/);

  const forbidden = vm.runInContext(
    "autoMappingErrorMessage({ code: 'SUB2API_KEY_EXPORT_FORBIDDEN', message: 'forbidden' })",
    context
  );
  const unsupported = vm.runInContext(
    "autoMappingErrorMessage({ code: 'SUB2API_KEY_EXPORT_UNSUPPORTED', message: 'missing' })",
    context
  );
  assert.match(forbidden, /TOTP/);
  assert.match(unsupported, /不支持/);
});
