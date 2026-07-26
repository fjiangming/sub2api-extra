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

test('all retention inputs allow a one-day minimum', () => {
  const { source } = createBrowserContext();
  const retentionKeys = [
    'rawSnapshotRetentionDays',
    'snapshotRetentionDays',
    'jobRetentionDays',
    'auditRetentionDays',
    'notificationRetentionDays',
    'assetChangeRetentionDays'
  ];

  for (const key of retentionKeys) {
    assert.match(source, new RegExp(`<input name="${key}" type="number" min="1" max="3650"`));
  }
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

test('large operational tables render server-side pagination controls', () => {
  const { context, source } = createBrowserContext();
  const html = vm.runInContext(`paginationHtml('cost-prices', {
    page: 2, pageSize: 25, total: 61, totalPages: 3
  })`, context);

  assert.match(html, /第 26–50 条，共 61 条/);
  assert.match(html, /data-list-key="cost-prices"/);
  assert.match(html, /data-page="3"/);
  assert.match(source, /'activity-audit': '\/api\/audit-logs'/);
  assert.match(source, /'cost-groups': '\/api\/groups\?excludeMissing=true&requireRatio=true'/);
  assert.match(source, /api\('\/api\/groups\?excludeUnresolved=true'\)/);
  assert.match(source, /if \(!state\.pagedLists\[listKey\]\)/);
  assert.doesNotMatch(source, /api\('\/api\/checks\?limit=100'\)/);
  assert.doesNotMatch(source, /api\('\/api\/prices'\)/);
});

test('Sub2API integrations expose a confirmed bulk mapping delete action', () => {
  const { source } = createBrowserContext();
  assert.match(source, /data-action="delete-all-mappings"/);
  assert.match(source, /state\.mappings\.length \? '' : 'disabled'/);
  assert.match(source, /确定删除全部.*条映射关系及其对账历史？此操作不可撤销。/);
  assert.match(source, /api\('\/api\/mappings', \{ method: 'DELETE' \}\)/);
  assert.match(source, /result\.deletedMappings/);
});

test('cost table filters stay combined across pagination and remain visible for empty results', async () => {
  const { context, source } = createBrowserContext();
  let requestedUrl = '';
  context.fetch = async (input) => {
    requestedUrl = String(input);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          items: [],
          pagination: { page: 3, pageSize: 50, total: 0, totalPages: 1 },
          summary: { models: 0 },
          filterOptions: { providers: [], platforms: [] }
        };
      }
    };
  };
  vm.runInContext(`
    state.costListFilters['cost-prices'] = {
      connectionId: 'provider/a', platform: 'openai & compatible', rateSort: 'desc'
    };
    state.pagedLists['cost-prices'] = {
      pagination: { page: 1, pageSize: 50, total: 100, totalPages: 2 }
    };
  `, context);

  await vm.runInContext("requestPagedList('cost-prices', 3)", context);
  const requested = new URL(requestedUrl, 'http://provider-monitor.local');
  assert.equal(requested.searchParams.get('page'), '3');
  assert.equal(requested.searchParams.get('pageSize'), '50');
  assert.equal(requested.searchParams.get('connectionId'), 'provider/a');
  assert.equal(requested.searchParams.get('platform'), 'openai & compatible');
  assert.equal(requested.searchParams.get('rateSort'), 'desc');

  vm.runInContext(`
    state.costListFilters['cost-groups'] = {
      nameQuery: 'GPT、Image <活动>', nameMode: 'exclude',
      connectionId: 'provider/a', platform: 'openai', rateSort: 'asc'
    };
    state.pagedLists['cost-groups'] = {
      pagination: { page: 1, pageSize: 25, total: 40, totalPages: 2 }
    };
  `, context);
  await vm.runInContext("requestPagedList('cost-groups', 2)", context);
  const groupRequest = new URL(requestedUrl, 'http://provider-monitor.local');
  assert.equal(groupRequest.searchParams.get('page'), '2');
  assert.equal(groupRequest.searchParams.get('nameQuery'), 'GPT、Image <活动>');
  assert.equal(groupRequest.searchParams.get('nameMode'), 'exclude');
  assert.equal(groupRequest.searchParams.get('connectionId'), 'provider/a');
  assert.equal(groupRequest.searchParams.get('platform'), 'openai');
  assert.equal(groupRequest.searchParams.get('rateSort'), 'asc');

  const providerHeader = vm.runInContext(`costFilterHeaderHtml(
    'cost-prices', 'connectionId', '供应商', [{ id: 'provider/a', name: 'Provider A' }]
  )`, context);
  const platformHeader = vm.runInContext(`costFilterHeaderHtml(
    'cost-prices', 'platform', '平台', ['openai & compatible', 'anthropic']
  )`, context);
  const rateHeader = vm.runInContext("costRateSortHeaderHtml('cost-prices', '综合倍率')", context);
  const nameHeader = vm.runInContext('costGroupNameFilterHeaderHtml()', context);
  const emptyTable = vm.runInContext(`pagedTableHtml({
    rows: '', headers: '<th>筛选表头</th>', emptyIcon: 'boxes',
    emptyTitle: '没有匹配项', emptyText: '调整筛选', listKey: 'cost-prices',
    pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
    keepHeaderWhenEmpty: true
  })`, context);

  assert.match(providerHeader, /data-cost-filter="connectionId"/);
  assert.match(providerHeader, /value="provider\/a" selected/);
  assert.match(platformHeader, /data-cost-filter="platform"/);
  assert.match(platformHeader, /openai &amp; compatible/);
  assert.match(rateHeader, /data-sort-direction="desc"/);
  assert.match(rateHeader, /data-lucide="arrow-down"/);
  assert.match(rateHeader, /当前综合倍率降序/);
  assert.match(nameHeader, /data-cost-filter="nameMode"/);
  assert.match(nameHeader, /value="exclude" selected/);
  assert.match(nameHeader, /data-cost-name-query/);
  assert.match(nameHeader, /value="GPT、Image &lt;活动&gt;"/);
  assert.match(nameHeader, /排除名称中包含任一输入项的分组/);
  assert.match(nameHeader, /placeholder="名称1、名称2"/);
  assert.match(emptyTable, /筛选表头/);
  assert.match(emptyTable, /没有匹配项/);
  assert.match(vm.runInContext("costRateSortHeaderHtml('cost-groups', '综合倍率')", context), /当前综合倍率升序/);
  assert.match(source, /有效倍率 ÷ 充值倍率/);
  assert.match(source, /integrationRecharge\(\{\}, group\.recharge\)/);
  assert.match(source, /integrationRecharge\(\{\}, item\.recharge\)/);
  assert.match(source, /updateCostListFilter\('cost-groups', 'nameQuery', value\)/);
});

test('group name filtering keeps the input focused after the table header is repainted', async () => {
  const { context } = createBrowserContext();
  const input = {
    disabled: false,
    focusCalls: 0,
    selectionStart: 4,
    selectionEnd: 4,
    value: 'grok',
    focus() { this.focusCalls += 1; },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  };
  const root = { innerHTML: '', setAttribute() {} };
  context.document.activeElement = input;
  context.document.querySelector = (selector) => selector.includes('data-cost-name-query') ? input : root;
  context.document.querySelectorAll = () => [];
  context.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        items: [],
        pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
        summary: {},
        filterOptions: { providers: [], platforms: [] }
      };
    }
  });
  vm.runInContext(`
    state.view = 'costs';
    state.costListFilters['cost-groups'] = {
      nameQuery: '', nameMode: 'include', connectionId: '', platform: '', rateSort: ''
    };
  `, context);

  await vm.runInContext("updateCostListFilter('cost-groups', 'nameQuery', 'grok')", context);

  assert.equal(input.disabled, false);
  assert.equal(input.focusCalls, 1);
  assert.equal(input.selectionStart, 4);
  assert.equal(input.selectionEnd, 4);
});

test('an older group name response does not repaint over newer input', async () => {
  const { context } = createBrowserContext();
  const input = { value: 'g', selectionStart: 1, selectionEnd: 1 };
  const root = { innerHTML: 'unchanged', setAttribute() {} };
  let resolveResponse;
  context.document.activeElement = input;
  context.document.querySelector = (selector) => selector.includes('data-cost-name-query') ? input : root;
  context.document.querySelectorAll = () => [];
  context.fetch = () => new Promise((resolve) => { resolveResponse = resolve; });
  vm.runInContext(`
    state.view = 'costs';
    state.costListFilters['cost-groups'] = {
      nameQuery: '', nameMode: 'include', connectionId: '', platform: '', rateSort: ''
    };
    state.pagedLists['cost-groups'] = { marker: 'original' };
  `, context);

  const request = vm.runInContext("updateCostListFilter('cost-groups', 'nameQuery', 'g')", context);
  input.value = 'gr';
  resolveResponse({
    ok: true,
    status: 200,
    async json() {
      return {
        items: [{ id: 'stale' }],
        pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
        summary: {},
        filterOptions: { providers: [], platforms: [] }
      };
    }
  });
  await request;

  assert.equal(vm.runInContext("state.pagedLists['cost-groups'].marker", context), 'original');
  assert.equal(root.innerHTML, 'unchanged');
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
        statistic: 'median', priceBasis: 'official_relative', sampleCount: 57, minMultiplier: 0.0102,
        maxMultiplier: 0.0534, status: 'detected',
        summary: { latest: {
          channelName: 'Latest route', providerPriceSource: 'log_ratio', providerInputPerMillion: 0.036,
          providerOutputPerMillion: 0.216, referenceInputPerMillion: 5,
          referenceOutputPerMillion: 30
        } }
      }
    }
  })`, context);
  const missingDynamicRate = vm.runInContext(`integrationProviderRate({
    providerRate: null,
    details: {
      providerRateScope: 'dynamic_route_history',
      dynamicRouteRate: {
        statistic: 'latest', sampleCount: 0, status: 'missing_reference_price',
        summary: { totalObservationCount: 2, referenceMissingModels: ['gpt-test'] }
      }
    }
  })`, context);
  const partialDynamicRate = vm.runInContext(`integrationProviderRate({
    providerRate: 0.0061768,
    details: {
      providerRateScope: 'dynamic_route_history',
      dynamicRouteRate: {
        statistic: 'latest', sampleCount: 1, status: 'partial_reference_price',
        minMultiplier: 0.0061768, maxMultiplier: 0.0061768,
        summary: {
          totalObservationCount: 3,
          referenceMissingModels: ['codex-auto-review'],
          latest: { channelName: 'codex-route', providerPriceSource: 'log_ratio' }
        }
      }
    }
  })`, context);
  assert.match(recharge, /1:10/);
  assert.match(recharge, /手工/);
  assert.match(defaultRate, /1:1/);
  assert.match(defaultRate, /默认/);
  assert.match(cachedRate, /1:1/);
  assert.match(cachedRate, /缓存/);
  assert.match(dynamicRate, /日志价÷官方价 P50/);
  assert.match(dynamicRate, /57 次/);
  assert.match(dynamicRate, /Latest route/);
  assert.match(dynamicRate, /日志倍率换算/);
  assert.match(dynamicRate, /\$0\.036\/\$0\.216÷\$5\/\$30/);
  assert.match(missingDynamicRate, /2 条日志\/0 条可计算/);
  assert.match(missingDynamicRate, /缺官方价\/别名 gpt-test/);
  assert.match(partialDynamicRate, /日志价÷官方价 最近可计算/);
  assert.match(partialDynamicRate, /3 条日志\/1 条可计算/);
  assert.match(partialDynamicRate, /×0\.006177/);
  assert.match(partialDynamicRate, /缺官方价\/别名 codex-auto-review/);
  assert.doesNotMatch(partialDynamicRate, /范围/);
  assert.equal(vm.runInContext("badge('partial_reference_price')", context).includes('部分日志模型缺价'), true);
  assert.equal(composite, '×0.08');
  assert.match(source, /充值倍率/);
  assert.match(source, /综合倍率/);
});

test('group price rows render corresponding Sub2API base groups', () => {
  const { context, source } = createBrowserContext();
  const html = vm.runInContext(`sub2apiBaseGroupsHtml([
    { groupId: 3, groupName: 'gpt plus号池', role: 'primary', status: 'aligned' },
    { groupId: 3, groupName: 'gpt plus号池', role: 'backup', status: 'rate_mismatch' },
    { groupId: 21, groupName: null, role: 'primary', status: 'missing_base_group' }
  ])`, context);

  assert.match(html, /gpt plus号池/);
  assert.match(html, /#3 · 2 条映射 · 主映射、备用映射/);
  assert.match(html, /基座分组 #21/);
  assert.match(html, /缺失/);
  assert.equal(vm.runInContext('sub2apiBaseGroupsHtml([])', context), '-');
  assert.match(source, /Sub2API 基座分组/);
  assert.match(source, /sub2apiBaseGroupsHtml\(group\.sub2apiGroups\)/);
});

test('alert severity labels are displayed in Chinese', () => {
  const { context, source } = createBrowserContext();

  assert.equal(vm.runInContext("alertSeverityLabel('warning')", context), '预警');
  assert.equal(vm.runInContext("alertSeverityLabel('error')", context), '错误');
  assert.match(source, /alertSeverityLabel\(event\.severity\)/);
});

test('test center exposes provider-scoped mobile recharge alert simulation', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const readiness = vm.runInContext(`rechargeTestReadinessHtml({
    id: 'provider-id', name: 'Sub2API Wallet', adapter_type: 'sub2api',
    rechargeUrl: 'https://supplier.example/purchase',
    typeConfig: { rechargeLogin: { enabled: true } }
  }, {
    id: 'channel-id', name: 'Personal WeChat', type: 'serverchan', enabled: false
  })`, context);
  const previewReadiness = vm.runInContext(`rechargeTestReadinessHtml({
    id: 'provider-id', name: 'Sub2API Wallet', adapter_type: 'sub2api',
    rechargeUrl: 'https://supplier.example/purchase',
    typeConfig: { rechargeLogin: { enabled: true } }
  }, null, true)`, context);

  assert.match(index, /data-view="tests"/);
  assert.match(index, /flask-conical/);
  assert.match(source, /async function renderTests\(\)/);
  assert.match(source, /api\('\/api\/simulations\/recharge-alert'/);
  assert.match(source, /name="notificationChannelId"/);
  assert.match(source, /name="previewOnly"[^>]+checked/);
  assert.match(source, /仅打开移动端预览（不发送通知）/);
  assert.match(source, /\.\.\.\(!previewOnly \? \{ channelId:/);
  assert.match(source, /openMobilePreviewWindow/);
  assert.match(source, /width=430,height=860/);
  assert.match(source, /data-action="regenerate-mobile-preview"/);
  assert.match(source, /form.requestSubmit()/);
  assert.match(source, /withRecentReauth/);
  assert.match(readiness, /Sub2API/);
  assert.match(readiness, /supplier\.example/);
  assert.match(readiness, /适配器自动登录/);
  assert.match(readiness, /Personal WeChat（停用）/);
  assert.match(previewReadiness, /仅生成移动端预览，不发送通知/);
  assert.match(previewReadiness, /通知通道<\/span><strong>不发送/);
  assert.equal(
    vm.runInContext("rechargeTestReasonLabel('web_login_credentials_missing')", context),
    '缺少充值网页账号或密码'
  );
  assert.match(styles, /\.test-runner-panel/);
  assert.match(styles, /\.test-result-grid/);
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

test('alert and execution rules share one rules and automation workspace', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  context.testAlertRule = {
    id: 'alert-1',
    name: 'Low balance warning',
    enabled: true,
    rule_type: 'low_balance',
    scope: 'account',
    threshold: 20,
    currency: 'USD',
    consecutive_matches: 2,
    connection_id: null
  };
  context.testAutomationRule = {
    id: 'automation-1',
    name: 'Daily mapping rebuild',
    enabled: true,
    dryRun: true,
    trigger_type: 'scheduled',
    connection_id: null,
    config: {
      action: 'rebuild_sub2api_mappings',
      scheduleIntervalMinutes: 1440,
      condition: { type: 'composite_rate_difference', operator: 'lt', threshold: 0 },
      onMatchAction: 'disable_sub2api_account',
      targetMode: 'matched_mapping_accounts'
    }
  };

  const normalizedRules = JSON.parse(vm.runInContext(
    'JSON.stringify(normalizeUnifiedRules([testAlertRule], [testAutomationRule]))',
    context
  ));
  const normalizedAlertRule = normalizedRules.find((rule) => rule.kind === 'alert');
  const normalizedAutomationRule = normalizedRules.find((rule) => rule.kind === 'automation');
  context.normalizedAlertRule = normalizedAlertRule;
  context.normalizedAutomationRule = normalizedAutomationRule;
  const alertRow = vm.runInContext('unifiedRuleRow(normalizedAlertRule)', context);
  const automationRow = vm.runInContext('unifiedRuleRow(normalizedAutomationRule)', context);

  assert.match(index, /data-view="automation"[\s\S]*?<span>规则与自动化<\/span>/);
  assert.doesNotMatch(index, /data-view="alerts"/);
  assert.match(source, /view = view === 'alerts' \? 'automation' : view/);
  assert.match(source, /api\('\/api\/alert-rules'\)/);
  assert.match(source, /api\('\/api\/automation-rules'\)/);
  assert.doesNotMatch(source, /api\('\/api\/rules'\)/);
  assert.match(source, /normalizeUnifiedRules\(alertRules\.items, automationRules\.items\)/);
  assert.match(source, /rule\.kind === 'alert'/);
  assert.match(source, /rule\.kind === 'automation'/);
  assert.equal(normalizedAlertRule.actionType, 'create_alert_event');
  assert.equal(normalizedAlertRule.executionMode, 'event');
  assert.equal(normalizedAutomationRule.actionType, 'rebuild_sub2api_mappings');
  assert.equal(normalizedAutomationRule.executionMode, 'dry_run');
  assert.match(alertRow, /告警规则/);
  assert.match(alertRow, /创建告警事件/);
  assert.match(alertRow, /连续 2 次/);
  assert.match(alertRow, /data-action="edit-alert-rule"/);
  assert.match(automationRow, /自动化规则/);
  assert.match(automationRow, /每 1 天/);
  assert.match(automationRow, /综合倍率偏差 &lt; 0\.00%/);
  assert.match(automationRow, /重建全部 Sub2API 映射/);
  assert.match(automationRow, /命中后停用 Sub2API 账号/);
  assert.match(automationRow, /data-action="dry-run-automation"/);
});

test('automation payload separates account targets and builds scheduled mapping condition workflows', () => {
  const { context } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const elements = {
    name: { value: 'Recharge account' },
    triggerType: { value: 'low_balance' },
    connectionId: { value: '11111111-1111-4111-8111-111111111111' },
    enabled: { checked: true },
    dryRun: { checked: true },
    notifyOnAction: { checked: false },
    threshold: { value: '20' },
    currency: { value: 'USD' },
    accountIds: { value: '17, 18' },
    channelIds: { value: '7, 8' },
    action: { value: 'trigger_recharge_webhook' },
    consecutiveMatches: { value: '2' },
    cooldownMinutes: { value: '360' },
    dailyMaximumActions: { value: '1' },
    contractPauseHours: { value: '24' },
    scheduleIntervalMinutes: { value: '1440' },
    scheduledConditionType: { value: '' },
    scheduledConditionOperator: { value: 'lt' },
    scheduledConditionThreshold: { value: '0' },
    onMatchAction: { value: 'disable_sub2api_account' },
    webhookUrl: { value: 'https://recharge.example/hook' }
  };
  context.automationForm = { elements };

  const payload = JSON.parse(vm.runInContext('JSON.stringify(automationPayload(automationForm))', context));

  assert.equal(Object.hasOwn(payload.config, 'channelIds'), false);
  assert.equal(Object.hasOwn(payload.config, 'accountIds'), false);
  assert.equal(payload.config.notifyOnAction, false);
  assert.equal(payload.config.webhookUrl, elements.webhookUrl.value);
  assert.equal(vm.runInContext("automationUsesChannelIds('trigger_recharge_webhook')", context), false);
  assert.equal(vm.runInContext("automationUsesChannelIds('disable_sub2api_account')", context), false);
  assert.equal(vm.runInContext("automationUsesAccountIds('disable_sub2api_account')", context), true);

  elements.action.value = 'disable_sub2api_account';
  const accountPayload = JSON.parse(vm.runInContext('JSON.stringify(automationPayload(automationForm))', context));
  assert.deepEqual(accountPayload.config.accountIds, [17, 18]);
  assert.equal(Object.hasOwn(accountPayload.config, 'channelIds'), false);

  elements.triggerType.value = 'scheduled';
  elements.action.value = 'rebuild_sub2api_mappings';
  elements.scheduledConditionType.value = 'composite_rate_difference';
  elements.notifyOnAction.checked = true;
  const scheduledPayload = JSON.parse(vm.runInContext('JSON.stringify(automationPayload(automationForm))', context));
  assert.equal(scheduledPayload.connectionId, null);
  assert.equal(scheduledPayload.config.scheduleIntervalMinutes, 1440);
  assert.equal(Object.hasOwn(scheduledPayload.config, 'threshold'), false);
  assert.deepEqual(scheduledPayload.config.condition, {
    type: 'composite_rate_difference', operator: 'lt', threshold: 0
  });
  assert.equal(scheduledPayload.config.onMatchAction, 'disable_sub2api_account');
  assert.equal(scheduledPayload.config.targetMode, 'matched_mapping_accounts');
  assert.equal(scheduledPayload.config.cooldownMinutes, 360);
  assert.equal(scheduledPayload.config.contractPauseHours, 24);
  assert.equal(scheduledPayload.config.notifyOnAction, true);
  assert.match(index, /name="notifyOnAction"/);
  assert.match(index, /动作触发时通知/);
  assert.match(index, /name="scheduledConditionType"/);
  assert.match(index, /name="scheduledConditionOperator"/);
  assert.match(index, /name="scheduledConditionThreshold"/);
  assert.match(index, /name="onMatchAction"/);
  assert.match(index, /停用映射关联账号/);
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

test('Sub2API API Key provider payload submits multiple named keys and preserves stored rows', () => {
  const { context, source } = createBrowserContext();
  const keyRows = [
    {
      querySelector(selector) {
        return {
          '[data-api-key-id]': { value: 'primary' },
          '[data-api-key-name]': { value: 'Primary renamed' },
          '[data-api-key-value]': { value: '', required: false },
          '[data-api-key-monitored]': { checked: true }
        }[selector];
      }
    },
    {
      querySelector(selector) {
        return {
          '[data-api-key-id]': { value: 'backup' },
          '[data-api-key-name]': { value: 'Backup' },
          '[data-api-key-value]': { value: 'sk-backup-12345678', required: true },
          '[data-api-key-monitored]': { checked: false }
        }[selector];
      }
    }
  ];
  const form = {
    elements: {
      id: { value: '11111111-1111-4111-8111-111111111111' },
      name: { value: 'Multi-key gateway' }, adapterType: { value: 'sub2api' },
      baseUrl: { value: 'https://gateway.example' }, authMode: { value: 'api_key' },
      remoteUserId: { value: '' }, enabled: { checked: true },
      refreshIntervalMinutes: { value: '15' }, warningThreshold: { value: '' },
      secondaryWarningThreshold: { value: '' }, thresholdCurrency: { value: 'USD' },
      rechargeMultiplier: { value: '' }, rechargeUrl: { value: '' },
      rechargeLoginMode: { value: 'direct' }, dynamicRouteRateEnabled: { checked: false },
      dynamicRouteRateStatistic: { value: 'median' },
      dynamicRouteRateLookbackDays: { value: '30' }, dynamicRouteRateMinimumSamples: { value: '3' },
      typeConfig: { value: '{}' }, tags: { value: '' }, note: { value: '' },
      accountDedupeKey: { value: '' }
    },
    querySelectorAll(selector) {
      if (selector === '[data-provider-api-key-row]') return keyRows;
      return [];
    }
  };
  context.multiKeyProviderForm = form;

  const payload = JSON.parse(vm.runInContext(
    'JSON.stringify(providerPayload(multiKeyProviderForm))',
    context
  ));
  assert.deepEqual(payload.credentials.apiKeys, [
    { id: 'primary', name: 'Primary renamed' },
    { id: 'backup', name: 'Backup', key: 'sk-backup-12345678' }
  ]);
  assert.deepEqual(payload.typeConfig.monitoredKeyIds, ['primary']);
  assert.equal(payload.typeConfig.apiKeySource, 'manual');
  assert.equal(
    vm.runInContext("usesMultipleApiKeyEditor('sub2api', 'api_key')", context),
    true
  );
  const newRow = vm.runInContext("providerApiKeyRow({}, 0)", context);
  assert.match(newRow, /data-api-key-id value="api-key-[^"]+"/);
  assert.match(newRow, /data-api-key-monitored checked/);
  assert.match(source, /data-action="add-provider-api-key"/);
  assert.match(source, /data-action="remove-provider-api-key"/);
  assert.match(source, /data-api-key-monitored/);
});

test('Sub2API API Key remote source submits session credentials and selected remote keys', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const credentials = [{ dataset: { credential: 'accessToken' }, value: 'session-access-token' }];
  const monitoredKeys = [
    { value: '281', checked: true },
    { value: '727', checked: false }
  ];
  const form = {
    elements: {
      id: { value: '11111111-1111-4111-8111-111111111111' },
      name: { value: 'Remote Sub2API keys' }, adapterType: { value: 'sub2api' },
      baseUrl: { value: 'https://sub2api.example' }, authMode: { value: 'api_key' },
      sub2apiApiKeySource: { value: 'remote' }, remoteUserId: { value: '' },
      enabled: { checked: true }, refreshIntervalMinutes: { value: '15' },
      warningThreshold: { value: '' }, secondaryWarningThreshold: { value: '' },
      thresholdCurrency: { value: 'USD' }, rechargeMultiplier: { value: '' },
      rechargeUrl: { value: '' }, rechargeLoginMode: { value: 'direct' },
      dynamicRouteRateEnabled: { checked: false }, dynamicRouteRateStatistic: { value: 'median' },
      dynamicRouteRateLookbackDays: { value: '30' }, dynamicRouteRateMinimumSamples: { value: '3' },
      typeConfig: { value: '{}' }, tags: { value: '' }, note: { value: '' },
      accountDedupeKey: { value: '' }
    },
    querySelectorAll(selector) {
      if (selector === '[data-credential]') return credentials;
      if (selector === '[data-monitored-api-key]') return monitoredKeys;
      return [];
    }
  };
  context.remoteSub2ApiKeyForm = form;

  const payload = JSON.parse(vm.runInContext(
    'JSON.stringify(providerPayload(remoteSub2ApiKeyForm))',
    context
  ));
  assert.deepEqual(payload.credentials, { accessToken: 'session-access-token' });
  assert.equal(payload.typeConfig.apiKeySource, 'remote');
  assert.deepEqual(payload.typeConfig.monitoredKeyIds, ['281']);
  assert.equal(vm.runInContext(
    "usesRemoteApiKeySelection('sub2api', 'api_key', 'remote')",
    context
  ), true);
  assert.match(source, /name="sub2apiApiKeySource"/);
  assert.match(index, /data-action="refresh-provider-key-options"/);
});

test('New API API Key mode submits every selected remote monitoring key', () => {
  const { context, source } = createBrowserContext();
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const monitoredKeys = [
    { value: '14998', checked: true },
    { value: '14999', checked: true },
    { value: '15000', checked: false }
  ];
  const form = {
    elements: {
      id: { value: '11111111-1111-4111-8111-111111111111' },
      name: { value: 'a6api' }, adapterType: { value: 'new-api' },
      baseUrl: { value: 'https://a6api.example' }, authMode: { value: 'api_key' },
      remoteUserId: { value: '2160' }, enabled: { checked: true },
      refreshIntervalMinutes: { value: '15' }, warningThreshold: { value: '' },
      secondaryWarningThreshold: { value: '' }, thresholdCurrency: { value: 'USD' },
      rechargeMultiplier: { value: '' }, rechargeUrl: { value: '' },
      rechargeLoginMode: { value: 'direct' }, dynamicRouteRateEnabled: { checked: true },
      dynamicRouteRateStatistic: { value: 'latest' },
      dynamicRouteRateLookbackDays: { value: '30' }, dynamicRouteRateMinimumSamples: { value: '1' },
      typeConfig: { value: '{}' }, tags: { value: '' }, note: { value: '' },
      accountDedupeKey: { value: '' }
    },
    querySelectorAll(selector) {
      if (selector === '[data-monitored-api-key]') return monitoredKeys;
      return [];
    }
  };
  context.newApiKeySelectionForm = form;

  const payload = JSON.parse(vm.runInContext(
    'JSON.stringify(providerPayload(newApiKeySelectionForm))',
    context
  ));
  assert.deepEqual(payload.typeConfig.monitoredKeyIds, ['14998', '14999']);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('new-api', 'api_key')", context), true);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('new-api', 'system_token')", context), false);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('sub2api', 'account')", context), true);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('sub2api', 'token_pair')", context), true);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('sub2api', 'bearer')", context), true);
  assert.equal(vm.runInContext("usesRemoteApiKeySelection('sub2api', 'api_key')", context), false);
  assert.match(index, /id="monitored-api-keys-fieldset"/);
  assert.match(source, /data-monitored-api-key/);
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
    enabled: true,
    statistic: 'p90',
    lookbackDays: 14,
    minimumSamples: 5
  });
  assert.equal(payload.typeConfig.rechargeLogin.enabled, true);
  assert.equal(payload.typeConfig.preserved, true);
  assert.equal(
    vm.runInContext("credentialFieldsFor('new-api', 'system_token').map(([name]) => name).join(',')", context),
    'systemToken,userId,webUsername,webPassword'
  );
  assert.match(source, /dynamicRouteRateEnabled/);
  assert.match(index, /name="dynamicRouteRateEnabled"/);
  assert.doesNotMatch(index, /name="dynamicRouteRatePriceBasis"/);
  assert.doesNotMatch(index, /name="dynamicRouteReferencePrices"/);
  assert.doesNotMatch(index, /name="dynamicRouteProviderPrices"/);
  assert.match(source, /name="officialModelPrices"/);
  assert.match(source, /parseOfficialModelPrices/);
  assert.match(index, /name="rechargeUrl" type="url"/);
  assert.match(index, /name="rechargeLoginMode"/);
  assert.match(index, /name="secondaryWarningThreshold"/);
  assert.match(index, /value="serverchan">Server酱（个人微信）/);
  assert.match(index, /成本加权平均/);
});

test('official model prices accept global model entries and route aliases', () => {
  const { context } = createBrowserContext();
  const parsed = JSON.parse(vm.runInContext(`JSON.stringify(parseOfficialModelPrices(JSON.stringify({
    'gpt-test': { input: 5, output: 30, cachedInput: 0.5 },
    'a6api/route-a@7': { model: 'gpt-test' }
  })))`, context));

  assert.deepEqual(parsed, {
    'gpt-test': { input: 5, output: 30, cachedInput: 0.5 },
    'a6api/route-a@7': { model: 'gpt-test' }
  });
  assert.throws(() => vm.runInContext(
    `parseOfficialModelPrices('{"gpt-test":{"input":0}}')`,
    context
  ));
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
  assert.equal(vm.runInContext('integrationMeasuredRate(0.00576)', context), '×0.00576');
  assert.equal(vm.runInContext('integrationMeasuredRate(0.0061768029)', context), '×0.006177');
  assert.equal(vm.runInContext('integrationMeasuredValue(0.0288)', context), '0.0288');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: 0.2 })', context), '+20%');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: -0.266666 })', context), '-26.667%');
  assert.equal(vm.runInContext('integrationDelta({ differenceRatio: 0 })', context), '0%');
  assert.match(source, /const multiplier = formatEffectiveRate\(group\.ratio\);/);
  assert.doesNotMatch(source, /formatNumber\([^\r\n]*,\s*4\)/);
});

test('integration groups render the highest-composite winner and mark exactly one detail', () => {
  const { context, source } = createBrowserContext();
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const group = {
    groupId: 101,
    groupName: 'Retail',
    status: 'inactive',
    baseRate: 1.1,
    mappingCount: 2,
    highest: {
      id: 'high', account_id: 501, provider_name: 'Supplier A',
      baseAccount: { id: 501, name: 'Supplier A account', priority: 17 },
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
        baseAccount: { id: 501, name: 'Supplier A account', priority: 17 },
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
        baseAccount: { id: 502, name: 'Supplier A backup', priority: 3 },
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
  assert.equal(vm.runInContext('integrationAccountPriority({ baseAccount: { priority: 17 } })', context), '17');
  assert.equal(vm.runInContext('integrationAccountPriority({ baseAccount: { priority: 0 } })', context), '0');
  assert.equal(vm.runInContext('integrationAccountPriority({})', context), '-');
  assert.equal(vm.runInContext('integrationAccountPriority(null)', context), '-');
  assert.match(source, /账号优先级/);
  assert.match(source, /最高综合倍率供应商/);
  assert.match(source, /综合倍率差/);
  assert.match(source, /（基座倍率 - 综合倍率）÷ 综合倍率/);
  assert.match(collapsed, /integration-provider-rate-cell/);
  assert.match(styles, /\.integration-provider-rate-cell > small \{[^}]+white-space: normal;/);
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
