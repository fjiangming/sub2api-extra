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
    URL,
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

test('integration recharge and composite columns use the documented multiplier direction', () => {
  const { context, source } = createBrowserContext();
  const recharge = vm.runInContext(
    "integrationRecharge({ rechargeMultiplier: 10, rechargeSource: 'manual' })",
    context
  );
  const composite = vm.runInContext(
    'integrationCompositeRate({ providerRate: 0.8, rechargeMultiplier: 10 })',
    context
  );
  const defaultRate = vm.runInContext(
    "integrationRecharge({ rechargeMultiplier: 1, rechargeSource: 'default', rechargeStatus: 'default' })",
    context
  );
  const cachedRate = vm.runInContext(
    "integrationRecharge({ rechargeMultiplier: 1, rechargeSource: 'provider_payment_config', rechargeStatus: 'unavailable' })",
    context
  );
  const dynamicRate = vm.runInContext(`integrationProviderRate({
    providerRate: 0.024,
    details: {
      providerRateScope: 'dynamic_route_history',
      dynamicRouteRate: {
        statistic: 'median', sampleCount: 57, minMultiplier: 0.0102,
        maxMultiplier: 0.0534, status: 'detected',
        summary: { latest: { channelName: 'Latest route' } }
      }
    }
  })`, context);
  assert.match(recharge, /1:10/);
  assert.match(recharge, /手工/);
  assert.match(defaultRate, /1:1/);
  assert.match(defaultRate, /默认/);
  assert.match(cachedRate, /1:1/);
  assert.match(cachedRate, /缓存/);
  assert.match(dynamicRate, /动态实测 P50/);
  assert.match(dynamicRate, /57 次/);
  assert.match(dynamicRate, /Latest route/);
  assert.equal(composite, '×0.08');
  assert.match(source, /充值倍率/);
  assert.match(source, /综合倍率/);
});

test('alert severity labels are displayed in Chinese', () => {
  const { context, source } = createBrowserContext();

  assert.equal(vm.runInContext("alertSeverityLabel('warning')", context), '预警');
  assert.equal(vm.runInContext("alertSeverityLabel('error')", context), '错误');
  assert.match(source, /alertSeverityLabel\(event\.severity\)/);
});

test('alert rule form only enables fields used by the selected type', () => {
  const { context } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const controls = {
    name: { value: 'Low balance' },
    ruleType: { value: 'low_balance' },
    connectionId: { value: '' },
    scope: { value: 'account' },
    threshold: { value: '20' },
    currency: { value: 'USD' },
    consecutiveMatches: { value: '2' },
    cooldownMinutes: { value: '60' },
    enabled: { checked: true }
  };
  const fields = ['scope', 'threshold', 'currency', 'consecutiveMatches'].map((name) => ({
    dataset: { alertField: name }, hidden: false
  }));
  const form = {
    elements: controls,
    querySelectorAll(selector) { return selector === '[data-alert-field]' ? fields : []; }
  };
  context.testAlertRuleForm = form;

  vm.runInContext('updateAlertRuleFields(testAlertRuleForm)', context);
  assert.equal(fields.every((field) => !field.hidden), true);
  assert.equal(controls.threshold.required, true);
  assert.equal(controls.currency.required, true);
  assert.equal(
    vm.runInContext("alertRuleFieldConfig('runway_below').fields.join(',')", context),
    'threshold,currency'
  );

  const lowBalancePayload = JSON.parse(vm.runInContext('JSON.stringify(alertRulePayload(testAlertRuleForm))', context));
  assert.equal(lowBalancePayload.threshold, 20);
  assert.equal(lowBalancePayload.currency, 'USD');
  assert.equal(lowBalancePayload.consecutiveMatches, 2);

  controls.ruleType.value = 'sync_failed';
  vm.runInContext('updateAlertRuleFields(testAlertRuleForm)', context);
  assert.equal(fields.every((field) => field.hidden), true);
  assert.equal(controls.threshold.required, false);
  assert.equal(controls.currency.required, false);
  const syncFailurePayload = JSON.parse(vm.runInContext('JSON.stringify(alertRulePayload(testAlertRuleForm))', context));
  assert.equal(syncFailurePayload.threshold, null);
  assert.equal(syncFailurePayload.currency, null);
  assert.equal(syncFailurePayload.consecutiveMatches, 1);

  assert.match(index, /data-alert-field="scope"/);
  assert.match(index, /data-alert-field="threshold"/);
  assert.match(index, /name="cooldownMinutes"[^>]+required/);
});

test('recharge automation payload does not include Sub2API channel IDs', () => {
  const { context } = createBrowserContext();
  const elements = {
    name: { value: 'Recharge account' },
    triggerType: { value: 'low_balance' },
    connectionId: { value: '11111111-1111-4111-8111-111111111111' },
    enabled: { checked: true },
    dryRun: { checked: true },
    threshold: { value: '20' },
    currency: { value: 'USD' },
    channelIds: { value: '7, 8' },
    action: { value: 'trigger_recharge_webhook' },
    consecutiveMatches: { value: '2' },
    cooldownMinutes: { value: '360' },
    dailyMaximumActions: { value: '1' },
    contractPauseHours: { value: '24' },
    webhookUrl: { value: 'https://recharge.example/hook' }
  };
  context.automationForm = { elements };

  const payload = JSON.parse(vm.runInContext('JSON.stringify(automationPayload(automationForm))', context));

  assert.equal(Object.hasOwn(payload.config, 'channelIds'), false);
  assert.equal(payload.config.webhookUrl, elements.webhookUrl.value);
  assert.equal(vm.runInContext("automationUsesChannelIds('trigger_recharge_webhook')", context), false);
  assert.equal(vm.runInContext("automationUsesChannelIds('disable_sub2api_channel')", context), true);
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

test('Sub2API provider validation keeps the edited provider identity and separates account from OAuth credentials', () => {
  const { context } = createBrowserContext();
  const credentials = [{ dataset: { credential: 'password' }, value: 'replacement-password' }];
  const form = {
    elements: {
      id: { value: '11111111-1111-4111-8111-111111111111' },
      name: { value: 'Supplier' },
      adapterType: { value: 'sub2api' },
      baseUrl: { value: 'https://supplier.example' },
      authMode: { value: 'account' },
      remoteUserId: { value: '' },
      enabled: { checked: true },
      refreshIntervalMinutes: { value: '15' },
      warningThreshold: { value: '' },
      secondaryWarningThreshold: { value: '' },
      thresholdCurrency: { value: 'USD' },
      rechargeMultiplier: { value: '' },
      rechargeUrl: { value: 'https://supplier.example/account/recharge' },
      dynamicRouteRateEnabled: { checked: false },
      dynamicRouteRateStatistic: { value: 'median' },
      dynamicRouteRateLookbackDays: { value: '30' },
      dynamicRouteRateMinimumSamples: { value: '3' },
      typeConfig: { value: '{}' },
      tags: { value: '' },
      note: { value: '' },
      accountDedupeKey: { value: '' }
    },
    querySelectorAll(selector) { return selector === '[data-credential]' ? credentials : []; }
  };
  context.testProviderForm = form;

  const payload = JSON.parse(vm.runInContext(
    'JSON.stringify(providerValidationPayload(testProviderForm))',
    context
  ));
  assert.equal(payload.existingProviderId, form.elements.id.value);
  assert.equal(payload.secondaryWarningThreshold, null);
  assert.equal(payload.rechargeUrl, 'https://supplier.example/account/recharge');
  assert.deepEqual(payload.credentials, { password: 'replacement-password' });
  assert.equal(payload.typeConfig.dynamicRouteRate.enabled, false);
  assert.equal(
    vm.runInContext("credentialFieldsFor('sub2api', 'account').map(([name]) => name).join(',')", context),
    'email,password'
  );
  assert.equal(
    vm.runInContext("credentialFieldsFor('sub2api', 'token_pair').map(([name]) => name).join(',')", context),
    'accessToken,refreshToken'
  );
  assert.equal(
    vm.runInContext("credentialFieldsFor('sub2api', 'api_key').map(([name]) => name).join(',')", context),
    'apiKey'
  );
});

test('provider payload exposes dynamic route rate controls for New API', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const form = {
    elements: {
      id: { value: '' }, name: { value: 'Dynamic' }, adapterType: { value: 'new-api' },
      baseUrl: { value: 'https://dynamic.example' }, authMode: { value: 'system_token' },
      remoteUserId: { value: '7' }, enabled: { checked: true },
      refreshIntervalMinutes: { value: '15' }, warningThreshold: { value: '' },
      secondaryWarningThreshold: { value: '' },
      thresholdCurrency: { value: 'USD' }, rechargeMultiplier: { value: '' },
      rechargeUrl: { value: '' },
      rechargeLoginMode: { value: 'adapter' },
      dynamicRouteRateEnabled: { checked: true },
      dynamicRouteRateStatistic: { value: 'p90' },
      dynamicRouteRateLookbackDays: { value: '14' },
      dynamicRouteRateMinimumSamples: { value: '5' },
      typeConfig: { value: '{"preserved":true}' }, tags: { value: '' }, note: { value: '' },
      accountDedupeKey: { value: '' }
    },
    querySelectorAll() { return []; }
  };
  context.dynamicProviderForm = form;
  const payload = JSON.parse(vm.runInContext('JSON.stringify(providerPayload(dynamicProviderForm))', context));
  assert.deepEqual(payload.typeConfig.dynamicRouteRate, {
    enabled: true, statistic: 'p90', lookbackDays: 14, minimumSamples: 5
  });
  assert.equal(payload.typeConfig.rechargeLogin.enabled, true);
  assert.equal(payload.typeConfig.preserved, true);
  assert.equal(
    vm.runInContext("credentialFieldsFor('new-api', 'system_token').map(([name]) => name).join(',')", context),
    'systemToken,userId,webUsername,webPassword'
  );
  assert.match(source, /dynamicRouteRateEnabled/);
  assert.match(index, /name="dynamicRouteRateEnabled"/);
  assert.match(index, /name="rechargeUrl" type="url"/);
  assert.match(index, /name="rechargeLoginMode"/);
  assert.match(index, /name="secondaryWarningThreshold"/);
  assert.match(index, /value="serverchan">Server酱（个人微信）/);
  assert.match(index, /Token 加权平均/);
});

test('provider balance alert levels require the secondary threshold to be lower', () => {
  const { context } = createBrowserContext();
  context.thresholdForm = {
    elements: {
      warningThreshold: { value: '20' },
      secondaryWarningThreshold: { value: '5' }
    }
  };

  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(providerBalanceThresholds(thresholdForm))', context)),
    { warningThreshold: 20, secondaryWarningThreshold: 5 }
  );
  context.thresholdForm.elements.secondaryWarningThreshold.value = '20';
  assert.throws(
    () => vm.runInContext('providerBalanceThresholds(thresholdForm)', context),
    /必须小于一级/
  );
  context.thresholdForm.elements.warningThreshold.value = '';
  context.thresholdForm.elements.secondaryWarningThreshold.value = '5';
  assert.throws(
    () => vm.runInContext('providerBalanceThresholds(thresholdForm)', context),
    /先填写一级/
  );
});

test('import feedback distinguishes disabled credential shells from skipped rows', () => {
  const { source } = createBrowserContext();

  assert.match(source, /state\.importPreview\.disableForMissingCredentials/);
  assert.match(source, /state\.importPreview\.skipForMissingCredentials/);
  assert.match(source, /result\.disabledForMissingCredentials/);
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

test('integration groups render the highest-composite winner and mark exactly one detail', () => {
  const { context, source } = createBrowserContext();
  const group = {
    groupId: 101,
    groupName: 'Retail',
    status: 'inactive',
    baseRate: 1.1,
    mappingCount: 2,
    highest: {
      id: 'high', account_id: 501, provider_name: 'Supplier A',
      key_name: 'High key', masked_key: 'sk-h...7890',
      comparison: {
        providerGroupName: 'Premium', providerRate: 1.5, rechargeMultiplier: 1,
        compositeRate: 1.5, baseGroupRate: 1.1,
        status: 'rate_mismatch',
        differenceRatio: -0.2667, details: {
          providerGroupStatus: 'inactive', providerGroupSource: 'account_inherited',
          providerRateScope: 'group_multiplier', channelCostVerified: false
        }
      }
    },
    items: [
      {
        id: 'high', account_id: 501, provider_name: 'Supplier A',
        key_name: 'High key', masked_key: 'sk-h...7890', isHighestRate: true,
        comparison: {
          providerGroupName: 'Premium', providerRate: 1.5, rechargeMultiplier: 1,
          compositeRate: 1.5, baseGroupRate: 1.1,
          status: 'rate_mismatch',
          differenceRatio: -0.2667, details: {
            providerGroupStatus: 'inactive', providerGroupSource: 'account_inherited',
            providerRateScope: 'group_multiplier', channelCostVerified: false
          }
        }
      },
      {
        id: 'low', account_id: 502, provider_name: 'Supplier A',
        key_name: 'Low key', masked_key: 'sk-l...4321', isHighestRate: false,
        comparison: {
          providerGroupName: 'Economy', providerRate: 0.8, baseGroupRate: 1.1,
          status: 'rate_mismatch',
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
  assert.match(collapsed, /综合最高/);
  assert.match(source, /最高综合倍率供应商/);
  assert.match(source, /综合倍率差/);
  assert.match(source, /（基座倍率 - 综合倍率）÷ 综合倍率/);
  assert.equal((collapsed.match(/data-integration-parent="101" hidden/g) || []).length, 2);
  assert.match(collapsed, /badge inactive/);
  assert.match(collapsed, /继承账号/);
  assert.match(collapsed, /分组倍率/);
  assert.match(collapsed, /渠道成本未验证/);
  assert.match(collapsed, /aria-expanded="false"/);

  vm.runInContext("state.integrationExpandedGroups.add('101')", context);
  const expanded = vm.runInContext(`integrationGroupRows(${serialized})`, context);
  assert.equal((expanded.match(/data-integration-parent="101" hidden/g) || []).length, 0);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /chevron-down/);
});

test('integration summary help explains every counter and its mapping scope', () => {
  const { context } = createBrowserContext();
  const help = vm.runInContext('integrationSummaryHelp()', context);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  assert.match(help, /data-lucide="circle-help"/);
  assert.match(help, /一致/);
  assert.match(help, /预警/);
  assert.match(help, /错误/);
  assert.match(help, /待检查/);
  assert.match(help, /无映射分组不会计入“待检查”/);
  assert.match(styles, /\.integration-status-help-panel \{/);
  assert.match(styles, /\.integration-status-help:focus-within \.integration-status-help-panel/);
});

test('auto-mapping UI uses preview then apply and provides actionable export authentication errors', () => {
  const { context, source } = createBrowserContext();
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(source, /requestAutoMappings\('preview'\)/);
  assert.match(source, /requestAutoMappings\('apply'\)/);
  assert.match(source, /api\/sub2api\/step-up/);
  assert.match(source, /sub2api-step-up-dialog/);
  assert.match(source, /SUB2API_LOGIN_2FA_REQUIRED/);
  assert.doesNotMatch(source, /state\.authentication\?\.mode !== 'sub2api'/);
  assert.match(source, /data-action="auto-map" title="自动映射" aria-label="自动映射"/);
  assert.match(source, /comparisonData\.unassignedItems/);
  assert.match(source, /\[item\.keyName, item\.maskedKey\]/);
  assert.match(source, /verified_gateway_billing/);
  assert.match(source, /item\.baseMaskedKey/);
  assert.match(source, /item\.providerMaskedKeys/);
  assert.doesNotMatch(source, /form\.elements\.channelId\b/);
  assert.doesNotMatch(source, /<th>Sub2API 渠道<\/th>/);
  assert.match(styles, /#auto-mapping-dialog \{ width: min\(1120px,[^}]+height: min\(780px,/);
  assert.match(styles, /#auto-mapping-dialog form \{[^}]+grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);

  const forbidden = vm.runInContext(
    "autoMappingErrorMessage({ code: 'SUB2API_KEY_EXPORT_FORBIDDEN', message: 'forbidden' })",
    context
  );
  const unsupported = vm.runInContext(
    "autoMappingErrorMessage({ code: 'SUB2API_KEY_EXPORT_UNSUPPORTED', message: 'missing' })",
    context
  );
  const required = vm.runInContext(
    "autoMappingErrorMessage({ code: 'SUB2API_STEP_UP_REQUIRED', message: 'required' })",
    context
  );
  const invalidCode = vm.runInContext(
    "sub2apiStepUpErrorMessage({ code: 'SUB2API_TOTP_INVALID_CODE', message: 'invalid' })",
    context
  );
  assert.match(forbidden, /TOTP/);
  assert.match(unsupported, /不支持/);
  assert.match(required, /二次验证/);
  assert.match(invalidCode, /无效或已过期/);
});
