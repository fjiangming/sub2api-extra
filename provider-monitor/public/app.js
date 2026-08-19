const browserSession = typeof sessionStorage === 'undefined'
  ? { getItem: () => '', setItem: () => {}, removeItem: () => {} }
  : sessionStorage;

const LIST_PAGE_SIZE = 25;
const PAGED_LIST_ENDPOINTS = Object.freeze({
  'cost-groups': '/api/groups?excludeMissing=true&requireRatio=true',
  'cost-prices': '/api/prices',
  'risk-anomalies': '/api/anomalies',
  'risk-changes': '/api/asset-changes',
  'risk-health': '/api/key-health',
  'activity-checks': '/api/checks',
  'activity-jobs': '/api/jobs',
  'activity-audit': '/api/audit-logs'
});

const state = {
  csrfToken: '',
  sessionToken: browserSession.getItem('provider-monitor.session') || '',
  user: null,
  authentication: null,
  authConfig: null,
  view: 'overview',
  providers: [],
  summary: null,
  keys: [],
  groups: [],
  alerts: [],
  alertRules: [],
  channels: [],
  automationRules: [],
  automationActions: [],
  checks: [],
  jobs: [],
  audit: [],
  pagedLists: {},
  activityTab: 'checks',
  costModelOptions: [],
  costListFilters: {
    'cost-groups': { nameQuery: '', nameMode: 'include', connectionId: '', platform: '', rateSort: '' },
    'cost-prices': { connectionId: '', platform: '', rateSort: '' }
  },
  chart: null,
  assetsTab: 'keys',
  assetProviderId: '',
  assetSearch: '',
  assetStatus: '',
  mappings: [],
  sub2apiGroups: [],
  sub2apiMonitors: [],
  sub2apiStatus: null,
  accountMonitor: null,
  accountMonitorDetail: null,
  accountMonitorSelected: new Set(),
  accountMonitorExpandedGroups: new Set(),
  accountMonitorExpandedProviders: new Set(),
  accountMonitorFilters: {
    display: 'providers', groupId: '', platform: '', status: '', search: '', days: '7', page: 1,
    pageSize: 50, sortBy: 'qualityScore', order: 'desc'
  },
  grossProfit: null,
  grossProfitFilters: {
    dimension: 'provider', granularity: 'day', connectionId: '', from: '', to: '', currency: '',
    accountingMode: 'standard'
  },
  grossProfitDetailPage: 1,
  integrationGroups: [],
  integrationExpandedGroups: new Set(),
  autoMappingPreview: null,
  reconciliations: [],
  importPreview: null,
  backupTargets: [],
  reauthResolve: null,
  reauthReject: null,
  sub2apiStepUpResolve: null,
  sub2apiStepUpReject: null
};

const ADAPTERS = [
  ['sub2api', 'Sub2API'], ['new-api', 'New API'], ['one-api', 'One API'],
  ['one-hub', 'One Hub'], ['done-hub', 'Done Hub'], ['veloera', 'Veloera'],
  ['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter'], ['litellm', 'LiteLLM'],
  ['voapi-v2', 'VoAPI v2'], ['custom', '自定义 JSONPath']
];
const DYNAMIC_ROUTE_RATE_ADAPTERS = new Set(['new-api']);
const VIEW_META = {
  overview: ['资产总览', '供应商余额、状态与风险'],
  providers: ['供应商连接', '连接验证、同步与适配器能力'],
  assets: ['密钥与分组', '配额、路由分组与到期状态'],
  usage: ['使用量', '供应商用量快照、请求数与 Token'],
  trends: ['余额趋势', '历史快照、消耗速度与可用天数'],
  'gross-profit': ['毛利统计', '基座现金收入、上游现金成本与毛利趋势'],
  costs: ['价格比较', '模型价格、分组倍率与供应商推荐'],
  risks: ['健康与漂移', 'Key 检测、资产变化与异常识别'],
  'account-monitor': ['账号质量', '真实请求性能、缓存效率与主动能力检测'],
  integrations: ['Sub2API 联动', '分组映射、签到、对账与健康联动'],
  automation: ['规则与自动化', '告警事件、通知与受控动作'],
  tests: ['测试中心', '模拟通知、充值入口与移动端跳转'],
  activity: ['运行记录', '检查、任务与审计日志'],
  settings: ['设置与备份', '运行参数、凭据生命周期与数据迁移']
};
const CREDENTIAL_FIELDS = {
  sub2api: [['email', '邮箱', 'text'], ['password', '密码', 'password'], ['accessToken', 'Access Token', 'password'], ['refreshToken', 'Refresh Token', 'password']],
  'new-api': [['systemToken', '系统令牌', 'password'], ['userId', '用户 ID', 'text'], ['webUsername', '充值网页账号', 'text'], ['webPassword', '充值网页密码', 'password']],
  'one-api': [['systemToken', '系统令牌', 'password'], ['userId', '用户 ID', 'text'], ['webUsername', '充值网页账号', 'text'], ['webPassword', '充值网页密码', 'password']],
  'one-hub': [['systemToken', '系统令牌', 'password'], ['userId', '用户 ID', 'text'], ['webUsername', '充值网页账号', 'text'], ['webPassword', '充值网页密码', 'password']],
  'done-hub': [['systemToken', '系统令牌', 'password'], ['userId', '用户 ID', 'text'], ['webUsername', '充值网页账号', 'text'], ['webPassword', '充值网页密码', 'password']],
  veloera: [['systemToken', '系统令牌', 'password'], ['userId', '用户 ID', 'text'], ['webUsername', '充值网页账号', 'text'], ['webPassword', '充值网页密码', 'password']],
  deepseek: [['apiKey', 'API Key', 'password']],
  openrouter: [['apiKey', '普通 API Key', 'password'], ['managementKey', 'Management Key', 'password']],
  litellm: [['masterKey', 'Master Key', 'password']],
  'voapi-v2': [['apiKey', 'API Key', 'password'], ['userId', '用户 ID', 'text']],
  custom: [['apiKey', 'API Key', 'password'], ['bearerToken', 'Bearer Token', 'password']]
};
const SUB2API_CREDENTIAL_FIELDS = {
  account: CREDENTIAL_FIELDS.sub2api.slice(0, 2),
  token_pair: CREDENTIAL_FIELDS.sub2api.slice(2),
  api_key: [['apiKey', 'API Key', 'password']]
};
const ADAPTER_AUTH_MODES = {
  sub2api: 'account',
  'new-api': 'system_token',
  'one-api': 'system_token',
  'one-hub': 'system_token',
  'done-hub': 'system_token',
  veloera: 'system_token',
  deepseek: 'api_key',
  openrouter: 'management_key',
  litellm: 'bearer',
  'voapi-v2': 'api_key',
  custom: 'api_key'
};
const AUTO_DETECTION_MIN_CONFIDENCE = 0.75;

let providerDetectionTimer = null;
let providerDetectionController = null;
let providerDetectionSequence = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function icons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.innerHTML = `<i data-lucide="${type === 'error' ? 'circle-alert' : 'circle-check'}"></i><span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(item);
  icons();
  setTimeout(() => item.remove(), 4200);
}

function catalogResultMessage(result) {
  const parts = [];
  if (result.groupRateCount) parts.push(`${result.groupRateCount} 个分组倍率`);
  if (result.priceCount) parts.push(`${result.priceCount} 条模型价格`);
  if (parts.length === 0) parts.push('无可用目录数据');
  if (result.status === 'partial' && !result.priceCount) parts.push('供应商未开放模型价格');
  return `已同步 ${parts.join('，')}`;
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body != null) headers['Content-Type'] = 'application/json';
  if (state.sessionToken && !headers.Authorization) headers.Authorization = `Session ${state.sessionToken}`;
  if (!['GET', 'HEAD'].includes(method) && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    signal: options.signal,
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401 && payload?.error?.code === 'AUTH_REQUIRED') {
    state.sessionToken = '';
    state.csrfToken = '';
    browserSession.removeItem('provider-monitor.session');
    showLogin();
    throw new Error('登录状态已失效');
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

async function downloadFile(path, fallbackName = 'provider-monitor-export') {
  const headers = state.sessionToken ? { Authorization: `Session ${state.sessionToken}` } : {};
  const response = await fetch(path, { headers, credentials: 'same-origin' });
  if (response.status === 401) {
    state.sessionToken = '';
    state.csrfToken = '';
    browserSession.removeItem('provider-monitor.session');
    showLogin();
    throw new Error('登录状态已失效');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || `下载失败 (${response.status})`);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = encodedName ? decodeURIComponent(encodedName) : plainName || fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showLogin(message = '') {
  $('#login-screen').hidden = false;
  $('#app-shell').hidden = true;
  if (message) $('#login-error').textContent = message;
  icons();
}

function ssoErrorMessage(code) {
  const messages = {
    AUTH_FAILED: 'Sub2API 登录状态无效或已过期，请返回 Sub2API 重新登录后再打开。',
    ADMIN_REQUIRED: '当前 Sub2API 账号不是管理员，无法访问 Provider Monitor。',
    AUTH_UPSTREAM_TIMEOUT: 'Provider Monitor 暂时无法连接 Sub2API，请稍后重试。',
    SUB2API_SESSION_BINDING_INCOMPATIBLE: 'Sub2API 已开启会话绑定，无法由 Provider Monitor 验证登录状态。请在 Sub2API 系统设置的安全设置中关闭会话绑定，退出并重新登录后再打开。'
  };
  return messages[code] || 'Sub2API 单点登录失败，请重新从自定义菜单打开。';
}

function showApp(session) {
  if (session.sessionToken) {
    state.sessionToken = session.sessionToken;
    browserSession.setItem('provider-monitor.session', session.sessionToken);
  }
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  state.authentication = session.authentication || null;
  $('#user-name').textContent = session.user.name;
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  icons();
}

function timeAgo(value) {
  if (!value) return '尚未同步';
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
}

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value));
}

function formatRateValue(value) {
  const rate = Number(value);
  if (value == null || !Number.isFinite(rate)) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(rate);
}

function formatEffectiveRate(value) {
  const formatted = formatRateValue(value);
  return formatted === '-' ? '-' : `×${formatted}`;
}

function formatMoney(value, currency = 'USD') {
  if (value == null) return '-';
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${formatNumber(value)} ${currency}`;
  }
}

function badge(status, label = null) {
  const text = label || ({ healthy: '正常', warning: '预警', stale: '陈旧', unknown: '未知', active: '活动', inactive: '停用', enabled: '启用', disabled: '停用', missing: '缺失', succeeded: '成功', partial: '部分成功', failed: '失败', pending: '等待', pending_create: '待新增', running: '执行中', dry_run: '演练', resolved: '已恢复', acknowledged: '已确认', expired: '已到期', exhausted: '已耗尽', passed: '通过', info: '信息', already_checked: '今日已签', unsupported: '不支持', manual_action_required: '需人工处理', created: '已创建', existing: '已存在', unmatched: '未匹配', conflict: '冲突', missing_api_key: '缺少 API Key', missing_remote_key: '远端 Key 未找到', updated: '已更新', aligned: '综合倍率一致', rate_mismatch: '综合倍率偏差', missing_base_group: '基座分组缺失', base_group_unselected: '未选基座分组', missing_provider_group: '供应商分组缺失', missing_provider_price: '供应商单价缺失', partial_provider_price: '部分日志单价缺失', missing_reference_price: '日志模型官方价缺失', partial_reference_price: '部分日志模型缺价', missing_dynamic_route_rate: '动态倍率缺失', missing_rate: '倍率缺失', invalid_provider_rate: '供应商倍率无效', mapping_disabled: '映射已停用' }[status] || status || '未知');
  return `<span class="badge ${escapeHtml(status || 'unknown')}">${escapeHtml(text)}</span>`;
}

function alertSeverityLabel(severity) {
  return ({ info: '信息', warning: '预警', error: '错误' })[severity] || severity || '未知';
}

function emptyState(icon, title, text) {
  return `<div class="empty"><div><i data-lucide="${icon}"></i><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div></div>`;
}

function paginationHtml(listKey, pagination) {
  if (!pagination || pagination.total <= 0) return '';
  const { page, pageSize, total, totalPages } = pagination;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const previousDisabled = page <= 1 ? 'disabled' : '';
  const nextDisabled = page >= totalPages ? 'disabled' : '';
  return `<footer class="table-pagination" aria-label="列表分页"><span class="pagination-summary">第 ${start}–${end} 条，共 ${total} 条</span><div class="pagination-actions"><button class="icon-button small" data-action="paginate" data-list-key="${escapeHtml(listKey)}" data-page="1" title="第一页" aria-label="第一页" ${previousDisabled}><i data-lucide="chevrons-left"></i></button><button class="icon-button small" data-action="paginate" data-list-key="${escapeHtml(listKey)}" data-page="${page - 1}" title="上一页" aria-label="上一页" ${previousDisabled}><i data-lucide="chevron-left"></i></button><span class="pagination-position" aria-live="polite">${page} / ${totalPages}</span><button class="icon-button small" data-action="paginate" data-list-key="${escapeHtml(listKey)}" data-page="${page + 1}" title="下一页" aria-label="下一页" ${nextDisabled}><i data-lucide="chevron-right"></i></button><button class="icon-button small" data-action="paginate" data-list-key="${escapeHtml(listKey)}" data-page="${totalPages}" title="最后一页" aria-label="最后一页" ${nextDisabled}><i data-lucide="chevrons-right"></i></button></div></footer>`;
}

function pagedTableHtml({ rows, headers, emptyIcon, emptyTitle, emptyText, listKey, pagination, keepHeaderWhenEmpty = false }) {
  let content = emptyState(emptyIcon, emptyTitle, emptyText);
  if (rows) content = `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  else if (keepHeaderWhenEmpty) content = `<table><thead><tr>${headers}</tr></thead><tbody></tbody></table>${content}`;
  return `<div class="table-wrap">${content}</div>${paginationHtml(listKey, pagination)}`;
}

function costListFiltersFor(listKey) {
  return state.costListFilters[listKey] || {};
}

function costFilterHeaderHtml(listKey, filterName, label, options = []) {
  const selected = costListFiltersFor(listKey)[filterName] || '';
  const normalized = options.map((option) => ({
    value: String(typeof option === 'string' ? option : option.id ?? option.value ?? ''),
    label: String(typeof option === 'string' ? option : option.name ?? option.label ?? option.id ?? '')
  })).filter((option) => option.value);
  if (selected && !normalized.some((option) => option.value === selected)) {
    const provider = state.providers.find((item) => item.id === selected);
    normalized.unshift({ value: selected, label: provider?.name || selected });
  }
  const optionHtml = normalized.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  const scope = listKey === 'cost-groups' ? '分组倍率' : '最新价格目录';
  const allLabel = filterName === 'connectionId' ? '全部供应商' : '全部平台';
  return `<th><div class="table-column-control"><span>${escapeHtml(label)}</span><select data-cost-filter="${escapeHtml(filterName)}" data-list-key="${escapeHtml(listKey)}" aria-label="按${escapeHtml(label)}筛选${scope}" title="按${escapeHtml(label)}筛选"><option value="">${allLabel}</option>${optionHtml}</select></div></th>`;
}

function costRateSortHeaderHtml(listKey, label) {
  const direction = costListFiltersFor(listKey).rateSort || '';
  const config = direction === 'asc'
    ? { icon: 'arrow-up', title: `当前${label}升序，点击切换为降序` }
    : direction === 'desc'
      ? { icon: 'arrow-down', title: `当前${label}降序，点击恢复默认顺序` }
      : { icon: 'arrow-up-down', title: `按${label}升序` };
  return `<th class="numeric"><div class="table-column-control numeric"><span>${escapeHtml(label)}</span><button class="icon-button small table-header-sort ${direction ? 'active' : ''}" type="button" data-action="sort-cost-rate" data-list-key="${escapeHtml(listKey)}" data-sort-direction="${direction}" title="${config.title}" aria-label="${config.title}"><i data-lucide="${config.icon}"></i></button></div></th>`;
}

function costGroupNameFilterHeaderHtml() {
  const filters = costListFiltersFor('cost-groups');
  const query = filters.nameQuery || '';
  const mode = filters.nameMode === 'exclude' ? 'exclude' : 'include';
  const title = mode === 'exclude'
    ? '排除名称中包含任一输入项的分组；多个名称用逗号或顿号分隔'
    : '仅显示名称中包含任一输入项的分组；多个名称用逗号或顿号分隔';
  return `<th><div class="table-column-control group-name-filter"><span>分组</span><select data-cost-filter="nameMode" data-list-key="cost-groups" aria-label="分组名称筛选方式" title="分组名称筛选方式"><option value="include" ${mode === 'include' ? 'selected' : ''}>包含</option><option value="exclude" ${mode === 'exclude' ? 'selected' : ''}>排除</option></select><label class="table-name-filter-input" title="${title}"><i data-lucide="${mode === 'exclude' ? 'list-minus' : 'search'}"></i><input type="search" value="${escapeHtml(query)}" data-cost-name-query data-list-key="cost-groups" maxlength="500" placeholder="名称1、名称2" aria-label="${title}"></label></div></th>`;
}

function sub2apiBaseGroupsHtml(mappings = []) {
  const grouped = new Map();
  for (const mapping of mappings) {
    const groupId = String(mapping.groupId ?? '').trim();
    if (!groupId) continue;
    const current = grouped.get(groupId) || {
      groupId,
      groupName: '',
      mappingCount: 0,
      roles: new Set(),
      missing: false
    };
    if (!current.groupName && mapping.groupName) current.groupName = String(mapping.groupName);
    current.mappingCount += 1;
    if (mapping.role) current.roles.add(mapping.role);
    if (mapping.status === 'missing_base_group') current.missing = true;
    grouped.set(groupId, current);
  }
  if (grouped.size === 0) return '-';
  const roleLabel = (role) => ({ primary: '主映射', backup: '备用映射' }[role] || role);
  const items = [...grouped.values()].sort((left, right) => {
    const leftNumber = Number(left.groupId);
    const rightNumber = Number(right.groupId);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left.groupId.localeCompare(right.groupId, 'zh-CN');
  });
  return `<div class="sub2api-base-groups">${items.map((item) => {
    const label = item.groupName || `基座分组 #${item.groupId}`;
    const details = [
      item.groupName ? `#${item.groupId}` : null,
      `${item.mappingCount} 条映射`,
      [...item.roles].map(roleLabel).join('、')
    ].filter(Boolean).join(' · ');
    return `<div class="sub2api-base-group"><strong>${escapeHtml(label)}${item.missing ? ` ${badge('missing', '缺失')}` : ''}</strong><small>${escapeHtml(details)}</small></div>`;
  }).join('')}</div>`;
}

async function requestPagedList(listKey, requestedPage = 1) {
  const endpoint = PAGED_LIST_ENDPOINTS[listKey];
  if (!endpoint) throw new Error('未知分页列表');
  const currentPageSize = state.pagedLists[listKey]?.pagination?.pageSize || LIST_PAGE_SIZE;
  const separator = endpoint.includes('?') ? '&' : '?';
  const parameters = [
    ['page', Math.max(1, Number(requestedPage) || 1)],
    ['pageSize', currentPageSize]
  ];
  const filters = costListFiltersFor(listKey);
  const filterNames = listKey === 'cost-groups'
    ? ['nameQuery', 'nameMode', 'connectionId', 'platform', 'rateSort']
    : ['connectionId', 'platform', 'rateSort'];
  for (const name of filterNames) {
    if (filters[name]) parameters.push([name, filters[name]]);
  }
  const query = parameters.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return api(`${endpoint}${separator}${query}`);
}

function paintPagedList(listKey) {
  if (listKey === 'cost-groups') paintCostGroups();
  if (listKey === 'cost-prices') paintCostPrices();
  if (listKey === 'risk-anomalies') paintRiskAnomalies();
  if (listKey === 'risk-changes') paintRiskChanges();
  if (listKey === 'risk-health') paintRiskHealth();
  if (listKey.startsWith('activity-')) paintActivityList(listKey.slice('activity-'.length));
}

async function changeListPage(listKey, requestedPage) {
  const current = state.pagedLists[listKey]?.pagination;
  if (!current) return;
  const targetPage = Math.min(current.totalPages, Math.max(1, Number(requestedPage) || 1));
  if (targetPage === current.page) return;
  const buttons = $$(`[data-action="paginate"][data-list-key="${listKey}"]`);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    state.pagedLists[listKey] = await requestPagedList(listKey, targetPage);
    paintPagedList(listKey);
  } catch (error) {
    paintPagedList(listKey);
    throw error;
  }
}

async function updateCostListFilter(listKey, filterName, value) {
  if (!['cost-groups', 'cost-prices'].includes(listKey)) return;
  const allowedFilters = listKey === 'cost-groups'
    ? ['nameQuery', 'nameMode', 'connectionId', 'platform', 'rateSort']
    : ['connectionId', 'platform', 'rateSort'];
  if (!allowedFilters.includes(filterName)) return;
  const filters = costListFiltersFor(listKey);
  const previous = { ...filters };
  const normalizedValue = filterName === 'nameQuery' ? String(value || '').trim() : value;
  if (filters[filterName] === normalizedValue) return;
  filters[filterName] = normalizedValue;
  const nameInputSelector = `[data-list-key="${listKey}"][data-cost-name-query]`;
  const controls = $$(`[data-list-key="${listKey}"][data-cost-filter], [data-list-key="${listKey}"][data-action="sort-cost-rate"]`);
  controls.forEach((control) => { control.disabled = true; });
  const root = $(`[data-paged-list="${listKey}"]`);
  root?.setAttribute('aria-busy', 'true');
  const requestIsCurrent = () => {
    if (filters[filterName] !== normalizedValue) return false;
    if (filterName !== 'nameQuery') return true;
    const input = $(nameInputSelector);
    return !input || String(input.value || '').trim() === normalizedValue;
  };
  try {
    const result = await requestPagedList(listKey, 1);
    if (state.view !== 'costs' || !requestIsCurrent()) return;
    const currentInput = filterName === 'nameQuery' ? $(nameInputSelector) : null;
    const focusedSelection = currentInput && document.activeElement === currentInput
      ? {
          start: currentInput.selectionStart ?? currentInput.value.length,
          end: currentInput.selectionEnd ?? currentInput.value.length
        }
      : null;
    state.pagedLists[listKey] = result;
    paintPagedList(listKey);
    if (focusedSelection) {
      const nextInput = $(nameInputSelector);
      if (nextInput) {
        const valueLength = nextInput.value.length;
        nextInput.focus({ preventScroll: true });
        nextInput.setSelectionRange(
          Math.min(focusedSelection.start, valueLength),
          Math.min(focusedSelection.end, valueLength)
        );
      }
    }
  } catch (error) {
    if (!requestIsCurrent()) return;
    Object.assign(filters, previous);
    if (state.view === 'costs') paintPagedList(listKey);
    throw error;
  } finally {
    controls.forEach((control) => { control.disabled = false; });
    root?.setAttribute('aria-busy', 'false');
  }
}

async function cycleCostRateSort(listKey) {
  const current = costListFiltersFor(listKey).rateSort || '';
  const next = current === '' ? 'asc' : current === 'asc' ? 'desc' : '';
  await updateCostListFilter(listKey, 'rateSort', next);
}

async function loadBase() {
  const [providers, summary] = await Promise.all([api('/api/providers'), api('/api/summary')]);
  state.providers = providers.items;
  state.summary = summary;
}

async function navigate(view) {
  view = view === 'alerts' ? 'automation' : view;
  state.view = view;
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  $$('.module-tab').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    if (active) item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
  const [title, subtitle] = VIEW_META[view];
  $('#view-title').textContent = title;
  $('#view-subtitle').textContent = subtitle;
  $('#main-content').innerHTML = `<div class="empty"><div><i data-lucide="loader-circle"></i><strong>正在加载</strong></div></div>`;
  $('#topbar-actions').innerHTML = '';
  icons();
  try {
    await loadBase();
    if (view === 'overview') renderOverview();
    if (view === 'providers') renderProviders();
    if (view === 'assets') await renderAssets();
    if (view === 'usage') await renderUsage();
    if (view === 'trends') await renderTrends();
    if (view === 'gross-profit') await renderGrossProfit();
    if (view === 'costs') await renderCosts();
    if (view === 'risks') await renderRisks();
    if (view === 'account-monitor') await renderAccountMonitor();
    if (view === 'integrations') await renderIntegrations();
    if (view === 'automation') await renderAutomation();
    if (view === 'tests') await renderTests();
    if (view === 'activity') await renderActivity();
    if (view === 'settings') await renderSettings();
  } catch (error) {
    $('#main-content').innerHTML = emptyState('circle-alert', '加载失败', error.message);
    toast(error.message, 'error');
  }
  icons();
}

function setTopActions(html) {
  $('#topbar-actions').innerHTML = html;
  icons();
}

function renderOverview() {
  const summary = state.summary;
  const primaryTotal = Object.entries(summary.totalsByCurrency)[0];
  setTopActions(`<button class="button" data-action="sync-all"><i data-lucide="refresh-cw"></i><span>全部同步</span></button><button class="button primary" data-action="add-provider"><i data-lucide="plus"></i><span>添加供应商</span></button>`);
  const accountRows = summary.accounts.map((item) => `<tr>
    <td class="primary-cell"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.adapterType)} · ${escapeHtml(item.baseUrl)}</small></td>
    <td><span class="status-line"><span class="status-dot ${item.status}"></span>${badge(item.status)}</span></td>
    <td class="numeric"><strong>${item.unlimited ? '不限额' : formatMoney(item.available, item.currency)}</strong></td>
    <td class="numeric">${formatMoney(item.used, item.currency)}</td>
    <td>${escapeHtml(item.currency)}</td>
    <td title="${escapeHtml(formatDate(item.capturedAt))}">${timeAgo(item.capturedAt)}</td>
    <td class="actions-cell"><button class="icon-button small" data-action="sync-provider" data-id="${item.connectionId}" title="立即同步" aria-label="立即同步"><i data-lucide="refresh-cw"></i></button></td>
  </tr>`).join('');
  const budgetRows = (summary.budgets || []).map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.providerName)}</small></td><td>${badge(item.status)}</td><td>${badge(item.subjectType === 'team' ? 'active' : 'unknown', item.subjectType === 'team' ? 'Team' : 'Key')}</td><td class="numeric">${item.unlimited ? '不限额' : formatMoney(item.available, item.currency)}</td><td class="numeric">${formatMoney(item.used, item.currency)}</td><td class="numeric">${formatMoney(item.total, item.currency)}</td><td>${timeAgo(item.capturedAt)}</td></tr>`).join('');
  const activeAlerts = summary.counts.activeAlerts || 0;
  $('#main-content').innerHTML = `
    <div class="stats-grid">
      <div class="stat"><span class="stat-label"><i data-lucide="wallet-cards"></i>可用余额</span><strong class="stat-value">${primaryTotal ? formatMoney(primaryTotal[1], primaryTotal[0]) : '-'}</strong><span class="stat-detail">${Object.keys(summary.totalsByCurrency).length} 个币种</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="server"></i>活动供应商</span><strong class="stat-value">${summary.counts.providers || 0}</strong><span class="stat-detail">${summary.counts.healthy || 0} 正常 · ${summary.counts.warning || 0} 预警 · ${summary.counts.error || 0} 错误 · ${summary.counts.stale || 0} 陈旧</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="key-round"></i>有效密钥</span><strong class="stat-value">${summary.counts.activeKeys || 0}</strong><span class="stat-detail">${summary.counts.groups || 0} 个分组</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="bell-ring"></i>活动告警</span><strong class="stat-value">${activeAlerts}</strong><span class="stat-detail">${summary.counts.stale || 0} 个数据源陈旧</span></div>
    </div>
    <section class="section split-layout">
      <div><div class="section-header"><h2>账户余额</h2><p>同一账户去重后展示最新快照</p></div><div class="table-wrap">${accountRows ? `<table><thead><tr><th>供应商</th><th>状态</th><th class="numeric">可用</th><th class="numeric">已用</th><th>币种</th><th>更新时间</th><th></th></tr></thead><tbody>${accountRows}</tbody></table>` : emptyState('wallet-cards', '暂无余额', '添加供应商并完成首次同步')}</div></div>
      <div><div class="section-header"><h2>币种汇总</h2></div><div class="panel"><div class="panel-body currency-list">${Object.entries(summary.totalsByCurrency).map(([currency, total]) => `<div class="currency-row"><span>${escapeHtml(currency)}</span><strong>${formatMoney(total, currency)}</strong></div>`).join('') || '<span class="stat-detail">暂无可汇总数据</span>'}</div></div>
      <div class="section"><div class="section-header"><h2>状态分布</h2></div><div class="panel"><div class="panel-body currency-list"><div class="currency-row"><span>正常</span><strong>${summary.counts.healthy || 0}</strong></div><div class="currency-row"><span>预警</span><strong>${summary.counts.warning || 0}</strong></div><div class="currency-row"><span>错误</span><strong>${summary.counts.error || 0}</strong></div><div class="currency-row"><span>陈旧 / 未知</span><strong>${(summary.counts.stale || 0) + (summary.counts.unknown || 0)}</strong></div></div></div></div></div>
    </section>
    <section class="section"><div class="section-header"><h2>Key 额度与 Team 预算</h2><p>独立预算，不计入账户余额汇总</p></div><div class="table-wrap">${budgetRows ? `<table><thead><tr><th>对象</th><th>状态</th><th>类型</th><th class="numeric">剩余</th><th class="numeric">已用</th><th class="numeric">上限</th><th>更新时间</th></tr></thead><tbody>${budgetRows}</tbody></table>` : emptyState('gauge', '暂无独立预算', '支持 Key 额度或 Team Budget 的供应商同步后显示')}</div></section>`;
}

function providerStatus(provider) {
  if (!provider.enabled) return ['disabled', '已停用'];
  if (provider.last_error_code) return ['failed', '同步失败'];
  if (!provider.last_success_at) return ['unknown', '待同步'];
  const stale = Date.now() - Date.parse(provider.last_success_at) > 3600000;
  return stale ? ['stale', '数据陈旧'] : ['healthy', '正常'];
}

function renderProviders() {
  setTopActions(`<button class="button" data-action="sync-all"><i data-lucide="refresh-cw"></i><span>全部同步</span></button><button class="button primary" data-action="add-provider"><i data-lucide="plus"></i><span>添加供应商</span></button>`);
  const items = state.providers.map((provider) => {
    const [status, statusLabel] = providerStatus(provider);
    const catalogAction = provider.capabilities?.priceCatalog
      ? `<button class="icon-button small" data-action="sync-catalog" data-id="${provider.id}" title="同步价格目录" aria-label="同步价格目录"><i data-lucide="badge-dollar-sign"></i></button>`
      : '';
    const rechargeAction = provider.rechargeUrl
      ? `<button class="icon-button small" data-action="open-recharge" data-id="${provider.id}" title="打开充值入口" aria-label="打开充值入口"><i data-lucide="wallet-cards"></i></button>`
      : '';
    return `<article class="provider-item">
      <div class="provider-item-header"><span class="provider-icon"><i data-lucide="server"></i></span><div><h3>${escapeHtml(provider.name)}</h3><div class="url" title="${escapeHtml(provider.base_url)}">${escapeHtml(provider.base_url)}</div></div>${badge(status, statusLabel)}</div>
      <div class="provider-meta"><div><span>适配器</span><strong>${escapeHtml(provider.adapter_type)}</strong></div><div><span>刷新间隔</span><strong>${provider.refresh_interval_minutes} 分钟</strong></div><div><span>最近成功</span><strong>${timeAgo(provider.last_success_at)}</strong></div><div><span>密钥能力</span><strong>${provider.capabilities?.listKeys ? '可查询' : provider.last_success_at ? '不支持' : '待探测'}</strong></div></div>
      <div class="provider-actions"><button class="button small" data-action="sync-provider" data-id="${provider.id}"><i data-lucide="refresh-cw"></i><span>同步</span></button><button class="button small" data-action="provider-assets" data-id="${provider.id}"><i data-lucide="database"></i><span>资产</span></button><span class="action-spacer"></span>${rechargeAction}<button class="icon-button small" data-action="provider-checkin" data-id="${provider.id}" title="签到" aria-label="签到"><i data-lucide="calendar-check"></i></button>${catalogAction}<button class="icon-button small" data-action="rotate-credential" data-id="${provider.id}" title="轮换凭据" aria-label="轮换凭据"><i data-lucide="rotate-cw"></i></button><button class="icon-button small" data-action="clone-provider" data-id="${provider.id}" title="复制连接（不含凭据）" aria-label="复制连接（不含凭据）"><i data-lucide="copy"></i></button><button class="icon-button small" data-action="edit-provider" data-id="${provider.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-provider" data-id="${provider.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></div>
    </article>`;
  }).join('');
  $('#main-content').innerHTML = items ? `<div class="provider-grid">${items}</div>` : emptyState('server-cog', '暂无供应商', '添加第一个供应商连接');
}

async function renderAssets() {
  const [keys, groups] = await Promise.all([api('/api/keys'), api('/api/groups?excludeUnresolved=true')]);
  state.keys = keys.items;
  state.groups = groups.items;
  if (!state.providers.some((provider) => provider.id === state.assetProviderId)) {
    state.assetProviderId = state.providers[0]?.id || '';
  }
  paintAssets();
}

function paintAssets() {
  if (state.providers.length === 0) {
    setTopActions(`<button class="button primary" data-action="add-provider"><i data-lucide="plus"></i><span>添加供应商</span></button>`);
    $('#main-content').innerHTML = emptyState('server-cog', '暂无供应商', '添加供应商并完成同步后查看密钥与分组');
    return;
  }

  const selectedProvider = state.providers.find((provider) => provider.id === state.assetProviderId) || state.providers[0];
  state.assetProviderId = selectedProvider.id;
  const exportQuery = new URLSearchParams({ connectionId: selectedProvider.id });
  setTopActions(`<button class="button" data-action="download" data-url="/api/keys/export.csv?${exportQuery}" data-filename="provider-keys.csv"><i data-lucide="download"></i><span>导出密钥 CSV</span></button><button class="button primary" data-action="add-provider"><i data-lucide="plus"></i><span>添加供应商</span></button>`);

  const providerTabs = state.providers.map((provider) => {
    const active = provider.id === selectedProvider.id;
    const [status] = providerStatus(provider);
    const count = (state.assetsTab === 'keys' ? state.keys : state.groups)
      .filter((item) => item.connection_id === provider.id).length;
    return `<button class="asset-provider-tab ${active ? 'active' : ''}" data-action="asset-provider-tab" data-provider-id="${escapeHtml(provider.id)}" role="tab" aria-selected="${active}" tabindex="${active ? '0' : '-1'}"><span class="status-dot ${escapeHtml(status)}" aria-hidden="true"></span><span>${escapeHtml(provider.name)}</span><span class="provider-tab-count">${count}</span></button>`;
  }).join('');
  const currentItems = (state.assetsTab === 'keys' ? state.keys : state.groups)
    .filter((item) => item.connection_id === selectedProvider.id);
  const statuses = [...new Set(currentItems.map((item) => item.status).filter(Boolean))].sort();
  if (state.assetStatus && !statuses.includes(state.assetStatus)) state.assetStatus = '';
  const statusOptions = statuses.map((status) => `<option value="${escapeHtml(status)}" ${state.assetStatus === status ? 'selected' : ''}>${escapeHtml(assetStatusLabel(status))}</option>`).join('');

  $('#main-content').innerHTML = `
    <div class="asset-provider-tabs" role="tablist" aria-label="供应商">${providerTabs}</div>
    <div class="tabs asset-view-tabs" role="tablist" aria-label="资产类型"><button class="tab ${state.assetsTab === 'keys' ? 'active' : ''}" data-action="assets-tab" data-tab="keys" role="tab" aria-selected="${state.assetsTab === 'keys'}" tabindex="${state.assetsTab === 'keys' ? '0' : '-1'}">密钥 ${state.keys.filter((item) => item.connection_id === selectedProvider.id).length}</button><button class="tab ${state.assetsTab === 'groups' ? 'active' : ''}" data-action="assets-tab" data-tab="groups" role="tab" aria-selected="${state.assetsTab === 'groups'}" tabindex="${state.assetsTab === 'groups' ? '0' : '-1'}">分组 ${state.groups.filter((item) => item.connection_id === selectedProvider.id).length}</button></div>
    <div class="filter-bar asset-filter-bar"><label class="search-box"><i data-lucide="search"></i><input id="asset-search" value="${escapeHtml(state.assetSearch)}" placeholder="${state.assetsTab === 'keys' ? '搜索密钥名称、掩码或分组' : '搜索分组名称、标识或类型'}" aria-label="搜索当前供应商的${state.assetsTab === 'keys' ? '密钥' : '分组'}"></label><select id="asset-status" aria-label="按状态筛选"><option value="">全部状态</option>${statusOptions}</select></div>
    <div class="table-wrap" id="asset-table"></div>`;
  $('.asset-provider-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  paintAssetTable();
}

function assetStatusLabel(status) {
  return ({ active: '活动', enabled: '启用', disabled: '停用', expired: '已到期', exhausted: '已耗尽', missing: '缺失' }[status] || status);
}

function paintAssetTable() {
  const table = $('#asset-table');
  if (!table) return;
  const search = state.assetSearch.trim().toLocaleLowerCase('zh-CN');
  const source = state.assetsTab === 'keys' ? state.keys : state.groups;
  const items = source.filter((item) => {
    if (item.connection_id !== state.assetProviderId) return false;
    if (state.assetStatus && item.status !== state.assetStatus) return false;
    if (!search) return true;
    const fields = state.assetsTab === 'keys'
      ? [item.name, item.masked_key, item.primary_group_ref, item.backup_group_ref, ...(item.additionalGroups || [])]
      : [item.name, item.remote_id, item.group_type];
    return fields.some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(search));
  });

  if (state.assetsTab === 'keys') {
    const rows = items.map((key) => `<tr>
      <td class="primary-cell"><strong>${escapeHtml(key.name)}</strong><small class="mono">${escapeHtml(key.masked_key)}</small></td><td>${badge(key.status)}</td><td>${escapeHtml(key.primary_group_ref || '-')}</td><td>${escapeHtml(key.backup_group_ref || '-')}</td><td class="numeric">${key.unlimited ? '不限额' : formatMoney(key.quota_remaining, key.currency || 'USD')}</td><td>${formatDate(key.expires_at)}</td><td>${key.health_status ? badge(key.health_status) : '-'}</td><td class="actions-cell"><button class="icon-button small" data-action="check-key" data-id="${key.id}" data-provider-id="${key.connection_id}" title="Key 元数据检测" aria-label="Key 元数据检测"><i data-lucide="stethoscope"></i></button></td>
    </tr>`).join('');
    table.innerHTML = rows
      ? `<table><thead><tr><th>密钥</th><th>状态</th><th>主分组</th><th>备用分组</th><th class="numeric">剩余额度</th><th>到期</th><th>健康</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState('key-round', '暂无匹配密钥', state.assetSearch || state.assetStatus ? '调整搜索或状态筛选条件' : '该供应商同步后将在此显示');
  } else {
    const rows = items.map((group) => `<tr><td class="primary-cell"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.remote_id)}</small></td><td>${escapeHtml(group.group_type)}</td><td class="numeric">${formatRateValue(group.ratio)}</td><td class="numeric">${group.key_count}</td><td>${badge(group.status)}</td></tr>`).join('');
    table.innerHTML = rows
      ? `<table><thead><tr><th>分组</th><th>类型</th><th class="numeric">倍率</th><th class="numeric">密钥数</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState('boxes', '暂无匹配分组', state.assetSearch || state.assetStatus ? '调整搜索或状态筛选条件' : '支持分组查询的供应商同步后将在此显示');
  }
  icons();
}

async function filterAssets() {
  state.assetSearch = $('#asset-search')?.value || '';
  state.assetStatus = $('#asset-status')?.value || '';
  paintAssetTable();
}

async function renderUsage() {
  const [latest, history] = await Promise.all([api('/api/usage'), api('/api/usage/history?days=30')]);
  const items = latest.items;
  const totalCost = items.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const totalRequests = items.reduce((sum, item) => sum + Number(item.requests || 0), 0);
  const totalTokens = items.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0);
  setTopActions(`<button class="button" data-action="download" data-url="/api/exports/usage.csv" data-filename="provider-monitor-usage.csv"><i data-lucide="download"></i><span>导出 CSV</span></button><button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  const rows = items.map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.provider_name)}</strong><small>${escapeHtml(item.subject_type)} · ${escapeHtml(item.period)}</small></td><td>${escapeHtml(item.model || '全部模型')}</td><td class="numeric">${formatMoney(item.cost, item.currency)}</td><td class="numeric">${formatNumber(item.requests, 0)}</td><td class="numeric">${formatNumber(item.input_tokens, 0)}</td><td class="numeric">${formatNumber(item.output_tokens, 0)}</td><td>${formatDate(item.captured_at)}</td></tr>`).join('');
  $('#main-content').innerHTML = `<div class="stats-grid"><div class="stat"><span class="stat-label"><i data-lucide="badge-dollar-sign"></i>已记录成本</span><strong class="stat-value">${formatMoney(totalCost, items[0]?.currency || 'USD')}</strong><span class="stat-detail">最新周期快照</span></div><div class="stat"><span class="stat-label"><i data-lucide="send"></i>请求数</span><strong class="stat-value">${formatNumber(totalRequests, 0)}</strong><span class="stat-detail">${items.length} 个统计项</span></div><div class="stat"><span class="stat-label"><i data-lucide="binary"></i>Token</span><strong class="stat-value">${formatNumber(totalTokens, 0)}</strong><span class="stat-detail">输入与输出合计</span></div><div class="stat"><span class="stat-label"><i data-lucide="history"></i>历史快照</span><strong class="stat-value">${history.items.length}</strong><span class="stat-detail">最近 30 天</span></div></div><section class="section"><div class="section-header"><h2>供应商用量</h2></div><div class="table-wrap">${rows ? `<table><thead><tr><th>供应商</th><th>模型</th><th class="numeric">成本</th><th class="numeric">请求</th><th class="numeric">输入 Token</th><th class="numeric">输出 Token</th><th>采集时间</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState('activity', '暂无用量数据', '适配器支持用量接口时会在同步后保存')}</div></section>`;
}

async function renderCosts() {
  const [groups, prices, modelOptions] = await Promise.all([
    requestPagedList('cost-groups', state.pagedLists['cost-groups']?.pagination?.page || 1),
    requestPagedList('cost-prices', state.pagedLists['cost-prices']?.pagination?.page || 1),
    api('/api/models/options?limit=50')
  ]);
  state.pagedLists['cost-groups'] = groups;
  state.pagedLists['cost-prices'] = prices;
  state.costModelOptions = modelOptions.items;
  const catalogProviders = state.providers.filter((provider) => provider.capabilities?.priceCatalog);
  setTopActions(catalogProviders.length > 0 ? `<button class="button" data-action="sync-catalogs"><i data-lucide="refresh-cw"></i><span>同步目录</span></button>` : '');
  $('#main-content').innerHTML = `<div class="filter-bar"><input id="cost-model" list="cost-model-options" autocomplete="off" placeholder="输入模型名称进行推荐比较" aria-label="模型名称"><datalist id="cost-model-options"></datalist><button class="button" data-action="compare-model"><i data-lucide="scale"></i><span>比较</span></button></div><div id="cost-comparison"></div><section class="section"><div class="section-header"><h2>分组倍率</h2><p id="cost-groups-summary"></p></div><div id="cost-groups-list" data-paged-list="cost-groups"></div></section><section class="section"><div class="section-header"><h2>最新价格目录</h2><p id="cost-prices-summary"></p></div><div id="cost-prices-list" data-paged-list="cost-prices"></div></section>`;
  paintCostModelOptions();
  paintCostGroups();
  paintCostPrices();
}

function paintCostModelOptions() {
  const list = $('#cost-model-options');
  if (!list) return;
  list.innerHTML = (state.costModelOptions || [])
    .map((item) => `<option value="${escapeHtml(item.name)}"></option>`)
    .join('');
}

let costModelOptionsSequence = 0;
async function loadCostModelOptions(query = '') {
  const sequence = ++costModelOptionsSequence;
  const result = await api(`/api/models/options?query=${encodeURIComponent(query)}&limit=50`);
  if (sequence !== costModelOptionsSequence || state.view !== 'costs') return;
  state.costModelOptions = result.items;
  paintCostModelOptions();
}

function paintCostGroups() {
  const result = state.pagedLists['cost-groups'];
  const root = $('#cost-groups-list');
  if (!result || !root) return;
  const filters = costListFiltersFor('cost-groups');
  const summary = $('#cost-groups-summary');
  if (summary) summary.textContent = `${result.pagination.total} 个可用分组`;
  const rows = result.items.map((group) => {
    const metadata = group.metadata || {};
    const defaultRatio = metadata.default_rate_multiplier ?? metadata.rate_multiplier;
    const peak = metadata.peak_rate_enabled
      ? `${metadata.peak_start || '-'}–${metadata.peak_end || '-'} · ${formatEffectiveRate(metadata.peak_rate_multiplier)}`
      : '-';
    const multiplier = formatEffectiveRate(group.ratio);
    const defaultMultiplier = formatEffectiveRate(defaultRatio);
    const compositeRate = formatEffectiveRate(group.compositeRate);
    return `<tr><td class="primary-cell"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.remote_id)}</small></td><td>${sub2apiBaseGroupsHtml(group.sub2apiGroups)}</td><td>${escapeHtml(group.provider_name)}</td><td>${escapeHtml(group.platform || metadata.platform || '-')}</td><td class="numeric"><strong>${multiplier}</strong></td><td class="primary-cell numeric">${integrationRecharge({}, group.recharge)}</td><td class="numeric"><strong title="有效倍率 ÷ 充值倍率">${compositeRate}</strong></td><td class="numeric">${defaultMultiplier}</td><td>${escapeHtml(peak)}</td><td class="numeric">${metadata.image_price_1k == null ? '-' : formatMoney(metadata.image_price_1k, 'USD')}</td><td class="numeric">${metadata.image_price_2k == null ? '-' : formatMoney(metadata.image_price_2k, 'USD')}</td><td class="numeric">${metadata.image_price_4k == null ? '-' : formatMoney(metadata.image_price_4k, 'USD')}</td></tr>`;
  }).join('');
  const providerOptions = result.filterOptions?.providers || state.providers;
  const platformOptions = result.filterOptions?.platforms || [...new Set(result.items.map((group) => group.platform || group.metadata?.platform).filter(Boolean))];
  root.innerHTML = pagedTableHtml({
    rows,
    headers: `${costGroupNameFilterHeaderHtml()}<th>Sub2API 基座分组</th>${costFilterHeaderHtml('cost-groups', 'connectionId', '供应商', providerOptions)}${costFilterHeaderHtml('cost-groups', 'platform', '平台', platformOptions)}<th class="numeric">有效倍率</th><th class="numeric">充值倍率</th>${costRateSortHeaderHtml('cost-groups', '综合倍率')}<th class="numeric">默认倍率</th><th>峰值倍率</th><th class="numeric">图片 1K</th><th class="numeric">图片 2K</th><th class="numeric">图片 4K</th>`,
    emptyIcon: 'boxes',
    emptyTitle: filters.nameQuery || filters.connectionId || filters.platform ? '没有匹配的分组倍率' : '暂无分组倍率',
    emptyText: filters.nameQuery || filters.connectionId || filters.platform ? '调整表头中的名称、供应商或平台筛选' : '先同步支持分组查询的供应商',
    listKey: 'cost-groups', pagination: result.pagination, keepHeaderWhenEmpty: true
  });
  icons();
}

function paintCostPrices() {
  const result = state.pagedLists['cost-prices'];
  const root = $('#cost-prices-list');
  if (!result || !root) return;
  const filters = costListFiltersFor('cost-prices');
  state.prices = result.items;
  const summary = $('#cost-prices-summary');
  if (summary) summary.textContent = `${result.summary?.models || 0} 个模型 · ${result.pagination.total} 条价格`;
  const rows = result.items.map((item) => {
    const currency = item.displayCurrency || item.currency;
    const groupLabel = [item.groupName, item.channelName].filter(Boolean).join(' · ') || item.group_ref || '-';
    return `<tr><td class="primary-cell"><strong>${escapeHtml(item.model_id)}</strong><small>${escapeHtml(item.billing_mode)}</small></td><td>${escapeHtml(item.provider_name)}</td><td>${escapeHtml(item.platform || '-')}</td><td>${escapeHtml(groupLabel)}</td><td class="numeric">${formatEffectiveRate(item.groupRatio)}</td><td class="primary-cell numeric">${integrationRecharge({}, item.recharge)}</td><td class="numeric"><strong title="有效倍率 ÷ 充值倍率">${formatEffectiveRate(item.compositeRate)}</strong></td><td class="numeric">${item.effectiveInputPrice == null ? '-' : formatMoney(item.effectiveInputPrice, currency)}</td><td class="numeric">${item.effectiveOutputPrice == null ? '-' : formatMoney(item.effectiveOutputPrice, currency)}</td><td class="numeric">${item.effectiveRequestPrice == null ? '-' : formatMoney(item.effectiveRequestPrice, currency)}</td><td>${formatDate(item.captured_at)}</td></tr>`;
  }).join('');
  const providerOptions = result.filterOptions?.providers || state.providers;
  const platformOptions = result.filterOptions?.platforms || [...new Set(result.items.map((item) => item.platform).filter(Boolean))];
  root.innerHTML = pagedTableHtml({
    rows,
    headers: `<th>模型</th>${costFilterHeaderHtml('cost-prices', 'connectionId', '供应商', providerOptions)}${costFilterHeaderHtml('cost-prices', 'platform', '平台', platformOptions)}<th>分组 / 渠道</th><th class="numeric">有效倍率</th><th class="numeric">充值倍率</th>${costRateSortHeaderHtml('cost-prices', '综合倍率')}<th class="numeric">输入 / 百万</th><th class="numeric">输出 / 百万</th><th class="numeric">单次</th><th>同步时间</th>`,
    emptyIcon: 'badge-dollar-sign',
    emptyTitle: filters.connectionId || filters.platform ? '没有匹配的模型价格' : '暂无模型价格',
    emptyText: filters.connectionId || filters.platform ? '调整表头中的供应商或平台筛选' : '供应商未返回可用的模型价格',
    listKey: 'cost-prices', pagination: result.pagination, keepHeaderWhenEmpty: true
  });
  icons();
}

async function loadCostComparison() {
  const model = $('#cost-model')?.value;
  if (!model) return toast('请选择模型', 'error');
  const result = await api(`/api/comparisons?model=${encodeURIComponent(model)}`);
  const rows = result.items.map((item, index) => `<tr><td>${index === 0 ? badge('healthy', '推荐') : index + 1}</td><td>${escapeHtml(item.provider_name)}</td><td>${escapeHtml(item.group_ref || '-')}</td><td class="numeric">${formatMoney(item.effectivePrice, item.displayCurrency || item.currency)}</td><td class="numeric">${formatNumber(item.healthScore, 0)}</td><td class="numeric"><strong>${formatNumber(item.recommendationScore, 1)}</strong></td><td class="numeric">${formatMoney(item.availableBalance, item.currency)}</td></tr>`).join('');
  $('#cost-comparison').innerHTML = `<div class="section-header"><h2>${escapeHtml(model)} 推荐</h2></div><div class="table-wrap">${rows ? `<table><thead><tr><th>排序</th><th>供应商</th><th>分组</th><th class="numeric">有效价格</th><th class="numeric">健康</th><th class="numeric">综合分</th><th class="numeric">余额</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState('scale', '没有可比较价格', '先同步支持价格目录的供应商')}</div>`;
  icons();
}

async function renderRisks() {
  const [anomalies, changes, health] = await Promise.all([
    requestPagedList('risk-anomalies', state.pagedLists['risk-anomalies']?.pagination?.page || 1),
    requestPagedList('risk-changes', state.pagedLists['risk-changes']?.pagination?.page || 1),
    requestPagedList('risk-health', state.pagedLists['risk-health']?.pagination?.page || 1)
  ]);
  state.pagedLists['risk-anomalies'] = anomalies;
  state.pagedLists['risk-changes'] = changes;
  state.pagedLists['risk-health'] = health;
  setTopActions(`<button class="button" data-action="health-all"><i data-lucide="stethoscope"></i><span>元数据检测</span></button><button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  $('#main-content').innerHTML = `<div class="stats-grid"><div class="stat"><span class="stat-label"><i data-lucide="triangle-alert"></i>活动异常</span><strong class="stat-value" id="risk-active-count">0</strong><span class="stat-detail">余额、用量与契约</span></div><div class="stat"><span class="stat-label"><i data-lucide="git-compare-arrows"></i>资产变化</span><strong class="stat-value" id="risk-change-count">0</strong><span class="stat-detail">累计变化记录</span></div><div class="stat"><span class="stat-label"><i data-lucide="shield-check"></i>检测通过</span><strong class="stat-value" id="risk-passed-count">0</strong><span class="stat-detail">全部 Key 健康记录</span></div><div class="stat"><span class="stat-label"><i data-lucide="shield-x"></i>检测失败</span><strong class="stat-value" id="risk-failed-count">0</strong><span class="stat-detail">需要处理</span></div></div><section class="section"><div class="section-header"><h2>异常</h2><p id="risk-anomalies-summary"></p></div><div id="risk-anomalies-list" data-paged-list="risk-anomalies"></div></section><section class="section"><div class="section-header"><h2>配置漂移</h2><p id="risk-changes-summary"></p></div><div id="risk-changes-list" data-paged-list="risk-changes"></div></section><section class="section"><div class="section-header"><h2>Key 健康记录</h2><p id="risk-health-summary"></p></div><div id="risk-health-list" data-paged-list="risk-health"></div></section>`;
  paintRiskAnomalies();
  paintRiskChanges();
  paintRiskHealth();
}

function paintRiskSummary() {
  const anomalies = state.pagedLists['risk-anomalies'];
  const changes = state.pagedLists['risk-changes'];
  const health = state.pagedLists['risk-health'];
  if ($('#risk-active-count')) $('#risk-active-count').textContent = anomalies?.summary?.active || 0;
  if ($('#risk-change-count')) $('#risk-change-count').textContent = changes?.pagination?.total || 0;
  if ($('#risk-passed-count')) $('#risk-passed-count').textContent = health?.summary?.passed || 0;
  if ($('#risk-failed-count')) $('#risk-failed-count').textContent = health?.summary?.failed || 0;
}

function paintRiskAnomalies() {
  const result = state.pagedLists['risk-anomalies'];
  const root = $('#risk-anomalies-list');
  if (!result || !root) return;
  if ($('#risk-anomalies-summary')) $('#risk-anomalies-summary').textContent = `${result.pagination.total} 条记录`;
  const rows = result.items.map((item) => `<tr><td>${badge(item.resolved_at ? 'resolved' : item.severity)}</td><td class="primary-cell"><strong>${escapeHtml(item.anomaly_type)}</strong><small>${escapeHtml(item.message)}</small></td><td>${escapeHtml(state.providers.find((provider) => provider.id === item.connection_id)?.name || '-')}</td><td class="numeric">${formatNumber(item.score)}</td><td>${formatDate(item.detected_at)}</td></tr>`).join('');
  root.innerHTML = pagedTableHtml({
    rows, headers: '<th>状态</th><th>异常</th><th>供应商</th><th class="numeric">评分</th><th>时间</th>',
    emptyIcon: 'shield-check', emptyTitle: '暂无异常', emptyText: '同步完成后自动分析余额和用量',
    listKey: 'risk-anomalies', pagination: result.pagination
  });
  paintRiskSummary();
  icons();
}

function paintRiskChanges() {
  const result = state.pagedLists['risk-changes'];
  const root = $('#risk-changes-list');
  if (!result || !root) return;
  if ($('#risk-changes-summary')) $('#risk-changes-summary').textContent = `${result.pagination.total} 条记录`;
  const rows = result.items.map((item) => `<tr><td>${badge(item.severity)}</td><td>${escapeHtml(item.asset_type)}</td><td>${escapeHtml(item.change_type)}</td><td>${escapeHtml(state.providers.find((provider) => provider.id === item.connection_id)?.name || '-')}</td><td>${escapeHtml(item.after?.changedFields?.join(', ') || item.remote_id || '-')}</td><td>${formatDate(item.detected_at)}</td></tr>`).join('');
  root.innerHTML = pagedTableHtml({
    rows, headers: '<th>级别</th><th>资产</th><th>变化</th><th>供应商</th><th>字段</th><th>时间</th>',
    emptyIcon: 'git-compare-arrows', emptyTitle: '暂无变化记录', emptyText: '第二次同步后开始对比资产',
    listKey: 'risk-changes', pagination: result.pagination
  });
  paintRiskSummary();
  icons();
}

function paintRiskHealth() {
  const result = state.pagedLists['risk-health'];
  const root = $('#risk-health-list');
  if (!result || !root) return;
  if ($('#risk-health-summary')) $('#risk-health-summary').textContent = `${result.pagination.total} 条记录`;
  const rows = result.items.map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.key_name)}</strong><small>${escapeHtml(item.provider_name)}</small></td><td>${badge(item.status)}</td><td>${escapeHtml(item.level)}</td><td class="numeric">${item.latency_ms == null ? '-' : `${item.latency_ms} ms`}</td><td class="numeric">${item.model_count ?? '-'}</td><td>${escapeHtml(item.error_code || '-')}</td><td>${formatDate(item.checked_at)}</td></tr>`).join('');
  root.innerHTML = pagedTableHtml({
    rows, headers: '<th>Key</th><th>结果</th><th>级别</th><th class="numeric">延迟</th><th class="numeric">模型数</th><th>错误</th><th>时间</th>',
    emptyIcon: 'stethoscope', emptyTitle: '暂无健康检测', emptyText: '可执行免费的元数据检测',
    listKey: 'risk-health', pagination: result.pagination
  });
  paintRiskSummary();
  icons();
}

function accountMonitorPlatformLabel(platform) {
  return ({
    openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', grok: 'Grok',
    antigravity: 'Antigravity'
  })[platform] || platform || '未知';
}

function accountMonitorStatusLabel(status) {
  return ({
    active: '活动', error: '错误', rate_limited: '限流', disabled: '停用',
    inactive: '停用', unknown: '未知'
  })[status] || status || '未知';
}

function accountProbeSuiteLabel(suite) {
  return ({
    capability_v1: '能力题集 v1',
    capability_v2: '动态能力题集 v2',
    capability_v2_unexecuted: '能力题未执行',
    connectivity_v1: '连通性'
  })[suite] || suite || '未知检测';
}

function formatMilliseconds(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return '-';
  if (number < 1000) return `${formatNumber(number, 0)} ms`;
  return `${formatNumber(number / 1000, number < 10000 ? 2 : 1)} s`;
}

function formatPercent(value) {
  return value == null || !Number.isFinite(Number(value))
    ? '-'
    : `${formatNumber(value, 1)}%`;
}

function formatPreciseMoney(value, currency = 'USD') {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return '-';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    }).format(number);
  } catch {
    return `${formatNumber(number, 6)} ${currency || ''}`.trim();
  }
}

function accountUpstreamSourceLabel(source) {
  return ({
    provider_request_logs: '逐请求日志',
    provider_counter_ledger: '累计计数器账本',
    provider_daily_usage: '逐日用量',
    provider_usage_snapshots: '累计用量',
    provider_key_snapshots: 'Key 快照',
    unavailable: '暂无指标'
  })[source] || source || '暂无指标';
}

function accountComparisonReasonLabel(reason) {
  return ({
    no_enabled_mapping: '未映射供应商',
    multiple_upstreams: '多个上游，需分别核算',
    mapping_key_missing: '映射未绑定 Key',
    mapping_key_unverified: '自动映射未通过同一 Key 精确验证',
    provider_cost_unavailable: '供应商未提供费用数据',
    provider_counter_unchanged: '上游计数器未变化',
    provider_recharge_multiplier_missing: '上游充值倍率未确认',
    shared_provider_key: 'Key 被多个账号共享',
    currency_mismatch: '币种不一致',
    sub2api_cost_unavailable: '基座日志缺少费用',
    base_request_logs_incomplete: '基座日志尚未完成精确分页回补',
    request_logs_truncated: '上游日志采集不完整',
    request_logs_incomplete: '上游日志未覆盖完整观察窗口',
    request_logs_stale: '最近一次日志同步失败，展示最近成功数据',
    request_logs_key_unverified: '上游日志未确认覆盖该 Key',
    request_pairing_unavailable: '同窗请求无法可靠配对',
    request_pairing_insufficient: '配对样本不足 30 条，改用窗口聚合指标',
    request_pairing_partial: '仅部分基座请求完成配对',
    cache_token_mismatch: '配对请求的缓存 Token 不一致',
    provider_sync_unavailable: '上游同步失败或尚未成功',
    request_logs_unavailable: '上游请求日志不可用',
    provider_counter_baseline_only: '已建立累计基线，等待下一次同步计算窗口增量',
    no_successful_requests: '观察窗口内没有成功请求',
    account_usage_not_attributable: '供应商仅返回账号汇总，无法按 Key 归因',
    provider_latency_unavailable: '上游仅提供累计用量，未提供延迟字段',
    provider_performance_unavailable: '上游未提供可归因性能数据'
  })[reason] || reason || '暂不可比';
}

function accountComparisonMetric(baseValue, upstreamValue, formatter, options = {}) {
  const base = (options.baseFormatter || formatter)(baseValue);
  const upstream = (options.upstreamFormatter || formatter)(upstreamValue);
  const upstreamTitle = options.upstreamTitle || (upstream === '-' ? '供应商未提供该指标' : '供应商上游');
  const note = options.note ? `<small class="table-metric-note">${escapeHtml(options.note)}</small>` : '';
  return `<div class="account-comparison-metric"><span><small class="source-base">${escapeHtml(options.baseLabel || '基座')}</small><strong class="${base === '-' ? 'metric-empty' : ''}">${escapeHtml(base)}</strong></span><span title="${escapeHtml(upstreamTitle)}"><small class="source-upstream">${escapeHtml(options.upstreamLabel || '上游')}</small><strong class="${upstream === '-' ? 'metric-empty' : ''}">${escapeHtml(upstream)}</strong></span></div>${note}`;
}

function accountTtftComparison(base, upstream) {
  const line = (metrics, source, className) => {
    const p50 = formatMilliseconds(metrics?.ttftP50Ms);
    const p95 = formatMilliseconds(metrics?.ttftP95Ms);
    return `<span><small class="${className}">${source}</small><strong>${escapeHtml(p95)}</strong><em>P50 ${escapeHtml(p50)}</em></span>`;
  };
  return `<div class="account-comparison-metric account-ttft-comparison">${line(base, '基座', 'source-base')}${line(upstream, '上游', 'source-upstream')}</div>`;
}

function accountProviderMarkup(comparison = {}) {
  if (comparison.status === 'unmapped') {
    return `<div class="account-provider-cell">${badge('info', '未映射')}<small>Sub2API 联动中配置</small></div>`;
  }
  if (comparison.status === 'multiple_upstreams') {
    return `<div class="account-provider-cell">${badge('warning', `${comparison.targets?.length || 0} 个上游`)}<small>费用需分别核算</small></div>`;
  }
  const provider = comparison.provider || {};
  const source = accountUpstreamSourceLabel(comparison.source);
  const sourceStatus = comparison.coverage?.stale ? 'stale' : comparison.source === 'unavailable' ? 'info' : 'enabled';
  const reasonText = comparison.metricReason ? accountComparisonReasonLabel(comparison.metricReason) : '';
  const reason = reasonText
    ? `<small class="account-provider-reason" title="${escapeHtml(reasonText)}">${escapeHtml(reasonText)}</small>`
    : '';
  const pairing = comparison.pairing;
  const pairingText = pairing?.matchedCount > 0
    ? `配对 ${formatNumber(pairing.matchedCount, 0)} / ${formatNumber(pairing.baseRequestCount, 0)}${pairing.upstreamExtraCount > 0 ? ` · 上游未归因 ${formatNumber(pairing.upstreamExtraCount, 0)}` : pairing.extraCountTrusted === false ? ' · 额外请求待回补核实' : ''}`
    : '';
  return `<div class="account-provider-cell"><strong>${escapeHtml(provider.name || '-')}</strong><small>${escapeHtml(provider.keyName || '未绑定 Key')}</small>${badge(sourceStatus, source)}${pairingText ? `<small>${escapeHtml(pairingText)}</small>` : ''}${reason}</div>`;
}

function accountCostMarkup(_metrics, comparison = {}) {
  const cost = comparison.cost || {};
  const rawCurrency = cost.currency || 'USD';
  const cashCurrency = cost.cashCurrency || rawCurrency;
  const useWindowLedger = cost.baseWindowCost != null || cost.keyTotalUpstreamCost != null;
  const usesCash = useWindowLedger
    ? cost.baseWindowCashEquivalent != null && cost.keyTotalUpstreamCashEquivalent != null
    : cost.baseCashEquivalent != null && cost.upstreamCashEquivalent != null;
  const baseDisplay = useWindowLedger
    ? usesCash ? cost.baseWindowCashEquivalent : cost.baseWindowCost
    : usesCash ? cost.baseCashEquivalent : cost.baseCost;
  const upstreamDisplay = useWindowLedger
    ? usesCash ? cost.keyTotalUpstreamCashEquivalent : cost.keyTotalUpstreamCost
    : usesCash ? cost.upstreamCashEquivalent : cost.upstreamCost;
  const displayCurrency = usesCash ? cashCurrency : rawCurrency;
  const comparable = useWindowLedger ? cost.windowComparable : cost.comparable;
  const reason = useWindowLedger ? cost.windowReason : cost.reason;
  const differenceAmount = useWindowLedger ? cost.windowDifferenceAmount : cost.differenceAmount;
  const grossMarginRatio = useWindowLedger ? cost.windowGrossMarginRatio : cost.grossMarginRatio;
  const profitStatus = useWindowLedger ? cost.windowProfitStatus : cost.profitStatus;
  let delta = `<span class="metric-empty">${escapeHtml(accountComparisonReasonLabel(reason))}</span>`;
  if (comparable) {
    const difference = Math.abs(Number(differenceAmount));
    const margin = grossMarginRatio == null ? '' : ` · ${formatNumber(Math.abs(grossMarginRatio) * 100, 1)}%`;
    const label = profitStatus === 'break_even'
      ? '收支平衡'
      : profitStatus === 'profit' ? '总账毛差' : '总账倒挂';
    const sign = profitStatus === 'profit' ? '+' : profitStatus === 'loss' ? '-' : '';
    const tone = profitStatus === 'loss' ? 'warning' : 'healthy';
    delta = `<span class="cost-delta ${tone}">${escapeHtml(label)} ${sign}${escapeHtml(formatPreciseMoney(difference, cashCurrency))}${escapeHtml(margin)}</span>`;
  }
  const pairing = comparison.pairing || {};
  const pairingText = pairing.matchedCount > 0 ? `配对 ${formatNumber(pairing.matchedCount, 0)} 次` : '';
  const extraText = pairing.upstreamExtraCount > 0
    ? ` · 上游未归因 ${formatNumber(pairing.upstreamExtraCount, 0)} 次`
    : pairing.extraCountTrusted === false && pairing.observedUpstreamUnmatchedCount > 0
      ? ' · 额外请求待基座回补核实'
      : '';
  const scopeText = useWindowLedger ? '统一窗口 Key 总账' : pairingText;
  const rawBase = useWindowLedger ? cost.baseWindowCost : cost.baseCost;
  const rawUpstream = useWindowLedger ? cost.keyTotalUpstreamCost : cost.upstreamCost;
  const rawCostText = usesCash
    ? `余额消费 ${formatPreciseMoney(rawBase, rawCurrency)} / ${formatPreciseMoney(rawUpstream, rawCurrency)}`
    : '';
  const precisionText = cost.estimated
    ? Number(cost.precisionSeconds) > 0
      ? `累计增量，精度约 ${Math.max(1, Math.ceil(Number(cost.precisionSeconds) / 60))} 分钟`
      : '累计增量'
    : '';
  const notes = [
    scopeText,
    useWindowLedger ? pairingText : '',
    extraText.replace(/^ · /, ''),
    rawCostText,
    precisionText
  ].filter(Boolean);
  return `<div class="account-cost-cell"><div class="account-comparison-metric"><span><small class="source-base">基座${usesCash ? '收入' : '扣费'}</small><strong>${escapeHtml(formatPreciseMoney(baseDisplay, displayCurrency))}</strong></span><span><small class="source-upstream">上游${usesCash ? '支出' : '扣费'}</small><strong class="${upstreamDisplay == null ? 'metric-empty' : ''}">${escapeHtml(formatPreciseMoney(upstreamDisplay, displayCurrency))}</strong></span></div>${delta}${notes.length > 0 ? `<small class="table-metric-note">${escapeHtml(notes.join(' · '))}</small>` : ''}</div>`;
}

function accountProbeTransportLabel(details = {}) {
  return details.transport === 'direct_api_key' ? '直连上游' : 'Sub2API 检测';
}

function accountMetricDelta(baseValue, upstreamValue, formatter) {
  const base = Number(baseValue);
  const upstream = Number(upstreamValue);
  if (baseValue == null || upstreamValue == null || !Number.isFinite(base) || !Number.isFinite(upstream)) return '-';
  const difference = upstream - base;
  if (Math.abs(difference) < 1e-9) return '一致';
  return `${difference > 0 ? '+' : '-'}${formatter(Math.abs(difference))}`;
}

function accountMetricRuleHeader(label, rule, title) {
  return `<span class="metric-rule-trigger"><span>${escapeHtml(label)}</span><button class="metric-rule-icon" type="button" data-action="open-account-metric-rules" data-rule-target="metric-rule-${escapeHtml(rule)}" title="${escapeHtml(title)}" aria-label="查看${escapeHtml(label)}计算规则"><i data-lucide="circle-help"></i></button></span>`;
}

function accountQualityMarkup(score, quality = {}) {
  if (score == null) return '<span class="metric-empty">-</span>';
  const status = score >= 85 ? 'healthy' : score >= 65 ? 'warning' : 'failed';
  const scoreBand = Math.max(0, Math.min(100, Math.round(Number(score) / 10) * 10));
  const coverage = (quality.coverage || []).map((item) => ({
    latency: '延迟', reliability: '可用性', capability: '能力'
  })[item] || item).join('、');
  return `<div class="quality-score" title="已计入：${escapeHtml(coverage || '暂无')}"><strong class="${status}">${formatNumber(score, 0)}</strong><span class="quality-score-track"><span class="${status} score-width-${scoreBand}"></span></span></div>`;
}

function accountMonitorWindowLabel(value, fallbackDays = 7) {
  const raw = typeof value === 'object' && value !== null
    ? value.windowType || value.type || value.value
    : value;
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (['24h', '24_hours', 'last24h', 'rolling24h', 'rolling_24h'].includes(normalized)) {
    return '24 小时';
  }
  if (['today', 'day', 'current_day', 'calendar_day'].includes(normalized)) {
    return '当天';
  }
  const days = Number.isFinite(Number(raw)) ? Number(raw) : Number(fallbackDays);
  return `${Number.isFinite(days) && days > 0 ? days : fallbackDays} 天`;
}

function accountMonitorQuery() {
  const filters = state.accountMonitorFilters;
  return new URLSearchParams(Object.entries({
    display: filters.display,
    groupId: filters.groupId,
    platform: filters.platform,
    status: filters.status,
    search: filters.search,
    days: filters.days,
    page: filters.page,
    pageSize: filters.pageSize,
    sortBy: filters.sortBy,
    order: filters.order
  }).filter(([, value]) => value !== '' && value != null));
}

function accountMonitorPagination(pagination, itemType = 'account') {
  if (!pagination || pagination.total <= 0) return '';
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.total, pagination.page * pagination.pageSize);
  const label = itemType === 'provider' ? '个供应商' : itemType === 'group' ? '个分组' : '个账号';
  return `<footer class="table-pagination"><span class="pagination-summary">第 ${start}–${end} 条，共 ${pagination.total} ${label}</span><div class="pagination-actions"><button class="icon-button small" data-action="account-monitor-page" data-page="${pagination.page - 1}" title="上一页" aria-label="上一页" ${pagination.page <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button><span class="pagination-position">${pagination.page} / ${pagination.totalPages}</span><button class="icon-button small" data-action="account-monitor-page" data-page="${pagination.page + 1}" title="下一页" aria-label="下一页" ${pagination.page >= pagination.totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button></div></footer>`;
}

function updateAccountMonitorSelectionAction() {
  const button = $('[data-action="detect-selected-accounts"]');
  if (!button) return;
  const count = state.accountMonitorSelected.size;
  button.disabled = count === 0;
  const label = $('span', button);
  if (label) label.textContent = count ? `检测所选 ${count}` : '检测所选';
  const pageSelection = $('#account-monitor-select-page');
  const visible = $$('[data-account-monitor-select]');
  if (pageSelection && visible.length > 0) {
    const checked = visible.filter((item) => item.checked).length;
    pageSelection.checked = checked === visible.length;
    pageSelection.indeterminate = checked > 0 && checked < visible.length;
  }
}

function accountGroupSummary(groups = [], associationsKnown = true) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return associationsKnown ? '未分组' : '分组待同步';
  }
  const names = groups.map((group) => group.name || `分组 #${group.id}`);
  const summary = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
  return associationsKnown ? summary : `${summary}（映射缓存）`;
}

function accountMonitorGroupCostMarkup(group) {
  const cost = group.cost || {};
  const comparable = Number(cost.comparableAccountCount || 0);
  const detail = comparable > 0
    ? `毛差正向 ${formatNumber(cost.profitAccountCount, 0)} · 倒挂 ${formatNumber(cost.lossAccountCount, 0)}`
    : '暂无可比总账';
  const amount = cost.differenceAmount == null || !cost.currency
    ? ''
    : `<small class="table-metric-note">净额 ${escapeHtml(formatPreciseMoney(cost.differenceAmount, cost.currency))}</small>`;
  return `<strong>${formatNumber(comparable, 0)} / ${formatNumber(group.accountCount, 0)}</strong><small class="table-metric-note">${escapeHtml(detail)}</small>${amount}`;
}

function accountMonitorTableStructure(grouped = false) {
  const selectLabel = grouped ? '选择已展开的全部账号' : '选择当前页全部账号';
  return `<colgroup><col class="account-col-select"><col class="account-col-identity"><col class="account-col-provider"><col class="account-col-requests"><col class="account-col-cache"><col class="account-col-ttft"><col class="account-col-duration"><col class="account-col-speed"><col class="account-col-cost"><col class="account-col-probe"><col class="account-col-capability"><col class="account-col-quality"><col class="account-col-actions"></colgroup><thead><tr><th class="selection-cell"><input type="checkbox" id="account-monitor-select-page" aria-label="${selectLabel}"></th><th>${grouped ? '基座分组 / 账号' : '账号 / 状态'}</th><th>${grouped ? '账号覆盖 / 供应商上游' : '供应商上游'}</th><th class="numeric">${accountMetricRuleHeader('请求数', 'requests', '基座与上游在同一实际覆盖窗口内的请求总数')}</th><th class="numeric">${accountMetricRuleHeader('缓存读取率', 'cache', '同一窗口内已配对请求的缓存读取 Token 比例')}</th><th class="numeric">${grouped ? '首字 P95 / 分组均值' : accountMetricRuleHeader('首字 P95', 'ttft', '同一窗口内已配对流式请求的首字 95 分位数')}</th><th class="numeric">${grouped ? '总耗时 P95 / 分组均值' : '总耗时 P95'}</th><th class="numeric">${grouped ? '输出速度 / 分组均值' : '输出速度'}</th><th class="numeric">${accountMetricRuleHeader('费用对比', 'cost', '统一窗口 Key 总账收入与支出；详情同时展示配对请求可归因收支')}</th><th class="numeric">${accountMetricRuleHeader('检测通过率', 'probe', '成功主动检测占最近检测样本的比例，并展示最近一次检测状态')}</th><th class="numeric">${accountMetricRuleHeader(grouped ? '能力均值' : '能力分 / 遵循', 'capability', '动态五维能力题集与格式遵循得分')}</th><th class="numeric">${accountMetricRuleHeader(grouped ? '质量均值' : '质量分', 'quality', '延迟、检测通过率与能力分的加权结果')}</th><th aria-label="操作"></th></tr></thead>`;
}

function accountMonitorAccountRows(items, options = {}) {
  return items.map((item) => {
    const metrics = item.metrics;
    const comparison = item.comparison || {};
    const comparisonBase = comparison.base || metrics;
    const upstream = comparison.upstream;
    const windowBase = comparison.windowTotals?.base || comparisonBase;
    const windowUpstream = comparison.windowTotals?.upstream || upstream;
    const pairingNote = comparison.pairing?.matchedCount > 0
      ? `性能按 ${formatNumber(comparison.pairing.matchedCount, 0)} 个配对请求${comparison.pairing.upstreamExtraCount > 0 ? `；同窗上游未归因 ${formatNumber(comparison.pairing.upstreamExtraCount, 0)} 个` : comparison.pairing.extraCountTrusted === false ? '；额外请求待基座回补核实' : ''}`
      : '';
    const selected = state.accountMonitorSelected.has(String(item.accountId));
    const groupSummary = accountGroupSummary(item.groups, item.groupAssociationsKnown !== false);
    const probeStatus = metrics.lastProbeStatus
      ? `<span class="account-probe-latest">${badge(metrics.lastProbeStatus)}<small>${escapeHtml(timeAgo(metrics.lastProbeAt))}</small></span>`
      : '<span class="account-probe-latest"><span class="metric-empty">暂无最近检测</span></span>';
    const capability = metrics.intelligenceScore == null
      ? '<span class="metric-empty" title="暂无有效能力题结果：平台不支持，或当前 Sub2API 基座未转发自定义题目">未覆盖</span>'
      : `<strong>${formatNumber(metrics.intelligenceScore, 0)}</strong><small class="table-metric-note">遵循 ${formatNumber(metrics.instructionScore, 0)}</small>`;
    const rowClass = options.nested ? ' class="account-group-member-row"' : '';
    const parentGroup = options.parentGroupId == null
      ? ''
      : ` data-parent-group="${escapeHtml(options.parentGroupId)}"`;
    return `<tr${rowClass} data-account-monitor-row="${escapeHtml(item.accountId)}"${parentGroup}>
      <td class="selection-cell"><input type="checkbox" data-account-monitor-select="${escapeHtml(item.accountId)}" aria-label="选择 ${escapeHtml(item.name)}" ${selected ? 'checked' : ''}></td>
      <td class="primary-cell account-identity-cell" data-label="账号">
        <div class="account-identity-main"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>${badge(item.status, accountMonitorStatusLabel(item.status))}</div>
        <small title="#${escapeHtml(item.accountId)} · ${escapeHtml(item.accountType)} · ${escapeHtml(accountMonitorPlatformLabel(item.platform))} · 基座分组：${escapeHtml(groupSummary)}">#${escapeHtml(item.accountId)} · ${escapeHtml(accountMonitorPlatformLabel(item.platform))} · ${escapeHtml(groupSummary)}</small>
      </td>
      <td class="account-provider-column" data-label="供应商上游">${accountProviderMarkup(comparison)}</td>
      <td class="numeric account-metric-column" data-label="请求数">${accountComparisonMetric(windowBase?.requestCount, windowUpstream?.requestCount, (value) => formatNumber(value, 0), { note: pairingNote })}</td>
      <td class="numeric account-metric-column" data-label="缓存读取率">${accountComparisonMetric(comparisonBase.cacheRate, upstream?.cacheRate, formatPercent)}</td>
      <td class="numeric account-metric-column" data-label="首字 P95">${accountTtftComparison(comparisonBase, upstream)}</td>
      <td class="numeric account-metric-column" data-label="总耗时 P95">${accountComparisonMetric(comparisonBase.durationP95Ms, upstream?.durationP95Ms, formatMilliseconds)}</td>
      <td class="numeric account-metric-column account-speed-cell" data-label="输出速度">${accountComparisonMetric(comparisonBase.outputTokensPerSecond, upstream?.outputTokensPerSecond, (value) => value == null ? '-' : `${formatNumber(value, 1)} tok/s`)}</td>
      <td class="numeric account-cost-column" data-label="费用对比">${accountCostMarkup(metrics, comparison)}</td>
      <td class="numeric account-probe-cell" data-label="检测通过率"><strong>${formatPercent(metrics.probeSuccessRate)}</strong><small class="table-metric-note">${formatNumber(metrics.probeCount, 0)} 次</small>${probeStatus}</td>
      <td class="numeric account-capability-cell" data-label="能力分 / 遵循">${capability}</td>
      <td class="numeric account-quality-cell" data-label="质量分">${accountQualityMarkup(metrics.qualityScore, metrics.quality)}</td>
      <td class="actions-cell"><button class="icon-button small" data-action="view-account-quality" data-id="${escapeHtml(item.accountId)}" title="查看趋势" aria-label="查看趋势"><i data-lucide="chart-no-axes-combined"></i></button><button class="icon-button small" data-action="detect-account" data-id="${escapeHtml(item.accountId)}" title="立即检测" aria-label="立即检测"><i data-lucide="flask-conical"></i></button></td>
    </tr>`;
  }).join('');
}

function accountMonitorGroupTable(groups) {
  if (!groups.length) {
    return emptyState('list-tree', '暂无基座分组质量数据', '同步 Sub2API 账号及分组后显示');
  }
  const rows = groups.map((group) => {
    const metrics = group.metrics || {};
    const coverage = group.coverage || {};
    const platform = (group.platforms || []).map(accountMonitorPlatformLabel).join('、') || '未知平台';
    const groupId = group.pending
      ? '等待账号目录同步'
      : group.unassigned
        ? '未关联'
        : `#${group.groupId}`;
    const rate = group.rateMultiplier == null ? '' : ` · ${formatEffectiveRate(group.rateMultiplier)}`;
    const cachedMembershipCount = Number(group.cachedMembershipAccountCount || 0);
    const groupBadge = group.pending
      ? badge('warning', '待同步')
      : group.unassigned
        ? badge('info', '未分组')
        : cachedMembershipCount === Number(group.accountCount || 0)
          ? badge('stale', '映射缓存')
          : badge(group.groupStatus);
    const members = (group.memberNames || []).join('、');
    const memberSummary = members
      ? `${members}${group.accountCount > group.memberNames.length ? ` 等 ${group.accountCount} 个` : ''}`
      : '暂无账号';
    const expanded = state.accountMonitorExpandedGroups.has(String(group.groupId));
    const memberRows = expanded
      ? accountMonitorAccountRows(group.accounts || [], {
          nested: true,
          parentGroupId: group.groupId
        }) || `<tr class="account-group-empty-row"><td colspan="13">该分组暂无账号</td></tr>`
      : '';
    return `<tr class="account-group-row${expanded ? ' expanded' : ''}" data-action="toggle-account-monitor-group" data-group-id="${escapeHtml(group.groupId)}" data-account-monitor-group="${escapeHtml(group.groupId)}">
      <td class="selection-cell"><button class="icon-button small account-group-expand" data-action="toggle-account-monitor-group" data-group-id="${escapeHtml(group.groupId)}" title="${expanded ? '收起分组账号' : '展开分组账号'}" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(group.groupName)}" aria-expanded="${expanded}"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></button></td>
      <td class="primary-cell account-group-identity-cell" data-label="基座分组">
        <div class="account-identity-main"><strong title="${escapeHtml(group.groupName)}">${escapeHtml(group.groupName)}</strong>${groupBadge}</div>
        <small title="${escapeHtml(`${groupId} · ${platform}${rate}`)}">${escapeHtml(`${groupId} · ${platform}${rate}`)}</small>
        <small title="${escapeHtml(memberSummary)}">${escapeHtml(memberSummary)}${cachedMembershipCount > 0 ? ` · ${formatNumber(cachedMembershipCount, 0)} 个缓存关联` : ''}</small>
      </td>
      <td class="account-provider-column account-group-count-cell" data-label="账号覆盖"><strong>${formatNumber(group.activeAccountCount, 0)} / ${formatNumber(group.accountCount, 0)}</strong><small class="table-metric-note">映射 ${formatNumber(coverage.mappedAccountCount, 0)} · 逐请求 ${formatNumber(coverage.supplierLogAccountCount, 0)}</small></td>
      <td class="numeric" data-label="基座请求"><strong>${formatNumber(metrics.requestCount, 0)}</strong></td>
      <td class="numeric" data-label="缓存读取率"><strong>${formatPercent(metrics.cacheRate)}</strong></td>
      <td class="numeric" data-label="账号首字 P95 均值"><strong>${formatMilliseconds(metrics.ttftP95Ms)}</strong></td>
      <td class="numeric" data-label="账号总耗时 P95 均值"><strong>${formatMilliseconds(metrics.durationP95Ms)}</strong></td>
      <td class="numeric account-speed-cell" data-label="账号输出速度均值"><strong>${metrics.outputTokensPerSecond == null ? '-' : `${formatNumber(metrics.outputTokensPerSecond, 1)} tok/s`}</strong></td>
      <td class="numeric account-cost-column account-group-cost-cell" data-label="费用可比">${accountMonitorGroupCostMarkup(group)}</td>
      <td class="numeric account-probe-cell" data-label="检测通过率"><strong>${formatPercent(metrics.probeSuccessRate)}</strong><small class="table-metric-note">${formatNumber(metrics.probeCount, 0)} 次 · ${formatNumber(coverage.probeAccountCount, 0)} 个账号</small></td>
      <td class="numeric account-capability-cell" data-label="能力均值"><strong>${metrics.intelligenceScore == null ? '-' : formatNumber(metrics.intelligenceScore, 0)}</strong><small class="table-metric-note">覆盖 ${formatNumber(coverage.capabilityAccountCount, 0)} 个</small></td>
      <td class="numeric account-quality-cell" data-label="质量均值">${accountQualityMarkup(metrics.qualityScore, metrics.quality)}</td>
      <td class="actions-cell" aria-hidden="true"></td>
    </tr>${memberRows}`;
  }).join('');
  return `<table>${accountMonitorTableStructure(true)}<tbody>${rows}</tbody></table>`;
}

function repaintAccountMonitorGroupTable() {
  const root = $('#account-monitor-table');
  if (!root || state.accountMonitor?.itemType !== 'group') return;
  root.innerHTML = accountMonitorGroupTable(state.accountMonitor.items || []);
  updateAccountMonitorSelectionAction();
  icons();
}

function providerRechargeAuditMarkup(provider) {
  const recharge = provider.rechargeAudit || {};
  const audit = provider.audit || {};
  const currency = audit.displayCurrency || recharge.currency || 'USD';
  const funding = audit.fundingDifference;
  const configured = recharge.configured ?? recharge.updatedAt != null;
  const fundingText = !configured
    ? '配置后显示资金差额'
    : funding == null
    ? '资金差额待核算'
    : `${Number(funding) >= 0 ? '收入超充值' : '充值超收入'} ${formatPreciseMoney(Math.abs(Number(funding)), currency)}`;
  const amount = configured
    ? formatPreciseMoney(recharge.rechargedAmount, recharge.currency || 'USD')
    : '未配置';
  return `<div class="provider-recharge-metric"><strong>${escapeHtml(amount)}</strong><small class="table-metric-note">${escapeHtml(fundingText)}</small><button class="icon-button small" data-action="edit-provider-recharge-audit" data-id="${escapeHtml(provider.connectionId)}" title="配置累计充值金额" aria-label="配置 ${escapeHtml(provider.providerName)} 累计充值金额"><i data-lucide="wallet-cards"></i></button></div>`;
}

function providerMetricUnavailableReason(reason) {
  return ({
    base_key_unmapped: '未映射基座账号',
    base_key_attribution_incomplete: '多个 Key，无法唯一归因',
    base_provider_unmapped: '未映射基座账号',
    base_provider_attribution_incomplete: '跨供应商映射，无法唯一归因',
    provider_counter_baseline_only: '已建立累计基线，等待下一次同步计算窗口增量',
    upstream_request_logs_unavailable: '上游日志未采集'
  })[reason] || '暂不可比';
}

function providerComparisonMetric(item, field, formatter, options = {}) {
  const baseMetrics = item.baseMetrics || {};
  const upstreamMetrics = item.upstreamMetrics || item.metrics || {};
  const notes = [];
  if (baseMetrics.available === false) {
    notes.push(`基座：${providerMetricUnavailableReason(baseMetrics.unavailableReason)}`);
  }
  if (upstreamMetrics.available === false) {
    notes.push(`上游：${providerMetricUnavailableReason(upstreamMetrics.unavailableReason)}`);
  }
  if (options.note) notes.push(options.note);
  return accountComparisonMetric(
    baseMetrics.available === false ? null : baseMetrics[field],
    upstreamMetrics.available === false ? null : upstreamMetrics[field],
    formatter,
    { ...options, note: notes.join(' · ') }
  );
}

function providerRequestComparison(item) {
  const note = `累计 ${formatNumber(item.audit?.lifetimeBaseRequestCount, 0)} / ${formatNumber(item.audit?.lifetimeRequestCount, 0)}`;
  return providerComparisonMetric(item, 'requestCount', (value) => formatNumber(value, 0), {
    note,
    upstreamTitle: '供应商上游永久账本中的窗口请求数'
  });
}

function providerCostComparison(item, period = 'window') {
  const audit = item.audit || {};
  const currency = audit.displayCurrency || 'USD';
  const balanceCurrency = audit.upstreamBalanceCurrency || 'USD';
  const lifetime = period === 'lifetime';
  const base = lifetime ? audit.lifetimeBaseRevenue : audit.windowBaseRevenue;
  const cashUpstream = lifetime ? audit.lifetimeUpstreamCost : audit.windowUpstreamCost;
  const balanceUpstream = lifetime
    ? audit.reportedLifetimeUpstreamBalanceCost
    : audit.windowUpstreamBalanceCost;
  const usesBalanceFallback = cashUpstream == null && balanceUpstream != null;
  const upstream = usesBalanceFallback ? balanceUpstream : cashUpstream;
  const grossProfit = lifetime ? audit.lifetimeGrossProfit : audit.windowGrossProfit;
  const missingCount = lifetime
    ? audit.lifetimeSourceMissingCount
    : audit.windowSourceMissingCount;
  const notes = [grossProfit == null
    ? '毛利待核算'
    : `毛利 ${formatPreciseMoney(grossProfit, currency)}`];
  if (usesBalanceFallback) notes.push('未确认充值倍率，成本为余额口径');
  if (audit.accountingMode === 'counter_ledger' || audit.accountingMode === 'mixed') {
    const precisionSeconds = Number(audit.maximumPrecisionSeconds || 0);
    const precision = period === 'window' && precisionSeconds > 0
      ? `，精度约 ${Math.max(1, Math.ceil(precisionSeconds / 60))} 分钟`
      : '';
    notes.push(`计数器账本${precision}`);
  }
  if (lifetime && Number(audit.unallocatedEntryCount) > 0) {
    notes.push(`含 ${formatNumber(audit.unallocatedEntryCount, 0)} 个期初累计，暂不计毛利`);
  }
  if (Number(missingCount) > 0) {
    notes.push(`${formatNumber(missingCount, 0)} 条源记录已删除，本地账本保留`);
  }
  return accountComparisonMetric(base, upstream, (value) => formatPreciseMoney(value, currency), {
    baseLabel: lifetime ? '累计收入' : '基座收入',
    upstreamLabel: usesBalanceFallback
      ? lifetime ? '累计余额消费' : '上游余额消费'
      : lifetime ? '累计成本' : '上游成本',
    upstreamFormatter: usesBalanceFallback
      ? (value) => formatPreciseMoney(value, balanceCurrency)
      : (value) => formatPreciseMoney(value, currency),
    upstreamTitle: lifetime
      ? '供应商永久费用账本累计成本'
      : '供应商永久费用账本窗口成本',
    note: notes.join(' · ')
  });
}

function providerProbeComparison(item) {
  const base = item.baseMetrics || {};
  const upstream = item.upstreamMetrics || {};
  const baseCount = base.available === false ? null : base.probeCount;
  const upstreamCount = upstream.available === false ? null : upstream.probeCount;
  return providerComparisonMetric(item, 'probeSuccessRate', formatPercent, {
    note: `样本 ${formatNumber(baseCount, 0)} / ${formatNumber(upstreamCount, 0)}`,
    upstreamTitle: upstream.probeCount > 0 ? '直连上游检测' : '尚无直连上游检测样本'
  });
}

function providerQualityComparison(item) {
  return providerComparisonMetric(
    item,
    'qualityScore',
    (value) => value == null ? '-' : formatNumber(value, 0),
    { upstreamTitle: '上游质量分仅使用已采集的上游延迟及直连检测项' }
  );
}

function accountMonitorProviderTable(providers) {
  if (!providers.length) {
    return emptyState('server-cog', '暂无供应商质量数据', '添加并同步供应商后显示');
  }
  const header = `<colgroup><col class="provider-col-expand"><col class="provider-col-identity"><col class="provider-col-accounts"><col class="provider-col-requests"><col class="provider-col-cache"><col class="provider-col-ttft"><col class="provider-col-speed"><col class="provider-col-window-cost"><col class="provider-col-lifetime-cost"><col class="provider-col-recharge"><col class="provider-col-probe"><col class="provider-col-quality"></colgroup><thead><tr><th aria-label="展开"></th><th>供应商 / Key</th><th class="numeric">映射账号</th><th class="numeric">窗口请求<br><small>基座 / 上游</small></th><th class="numeric">缓存读取率<br><small>基座 / 上游</small></th><th class="numeric">首字 P95<br><small>基座 / 上游</small></th><th class="numeric">输出速度<br><small>基座 / 上游</small></th><th class="numeric">窗口费用<br><small>收入 / 成本</small></th><th class="numeric">累计费用<br><small>收入 / 成本</small></th><th class="numeric">已充值</th><th class="numeric">检测通过率<br><small>基座 / 上游</small></th><th class="numeric">质量分<br><small>基座 / 上游</small></th></tr></thead>`;
  const rows = providers.map((provider) => {
    const expanded = state.accountMonitorExpandedProviders.has(String(provider.connectionId));
    const keyRows = expanded
      ? (provider.keys || []).map((key) => {
          const accounts = (key.accounts || []).map((account) => account.name).join('、') || '未映射账号';
          return `<tr class="account-provider-key-row" data-parent-provider="${escapeHtml(provider.connectionId)}">
            <td class="selection-cell" aria-hidden="true"></td>
            <td class="primary-cell account-identity-cell" data-label="Key"><div class="account-identity-main"><strong title="${escapeHtml(key.name)}">${escapeHtml(key.name)}</strong>${badge(key.status)}</div><small title="${escapeHtml(key.maskedKey || key.remoteKeyId)}">${escapeHtml(key.maskedKey || key.remoteKeyId)}</small><small title="${escapeHtml(accounts)}">${escapeHtml(accounts)}</small></td>
            <td class="numeric" data-label="映射账号"><strong>${formatNumber(key.mappedAccountCount, 0)}</strong></td>
            <td class="numeric" data-label="窗口请求">${providerRequestComparison(key)}</td>
            <td class="numeric" data-label="缓存读取率">${providerComparisonMetric(key, 'cacheRate', formatPercent)}</td>
            <td class="numeric" data-label="首字 P95">${providerComparisonMetric(key, 'ttftP95Ms', formatMilliseconds)}</td>
            <td class="numeric account-speed-cell" data-label="输出速度">${providerComparisonMetric(key, 'outputTokensPerSecond', (value) => value == null ? '-' : `${formatNumber(value, 1)} tok/s`)}</td>
            <td class="numeric account-cost-column" data-label="窗口费用">${providerCostComparison(key)}</td>
            <td class="numeric account-cost-column" data-label="累计费用">${providerCostComparison(key, 'lifetime')}</td>
            <td class="numeric" data-label="已充值"><span class="metric-empty">供应商级</span></td>
            <td class="numeric account-probe-cell" data-label="检测通过率">${providerProbeComparison(key)}</td>
            <td class="numeric account-quality-cell" data-label="质量分">${providerQualityComparison(key)}</td>
          </tr>`;
        }).join('') || `<tr class="account-provider-empty-row"><td colspan="12">该供应商暂无 Key</td></tr>`
      : '';
    return `<tr class="account-provider-row${expanded ? ' expanded' : ''}" data-action="toggle-account-monitor-provider" data-provider-id="${escapeHtml(provider.connectionId)}">
      <td class="selection-cell"><button class="icon-button small account-provider-expand" data-action="toggle-account-monitor-provider" data-provider-id="${escapeHtml(provider.connectionId)}" title="${expanded ? '收起供应商 Key' : '展开供应商 Key'}" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(provider.providerName)}" aria-expanded="${expanded}"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></button></td>
      <td class="primary-cell account-provider-identity-cell" data-label="供应商"><div class="account-identity-main"><strong title="${escapeHtml(provider.providerName)}">${escapeHtml(provider.providerName)}</strong>${provider.lastErrorCode ? badge('error', '同步异常') : badge('healthy', '已连接')}</div><small>${escapeHtml(adapterLabel(provider.adapterType))} · ${formatNumber(provider.activeKeyCount, 0)} / ${formatNumber(provider.keyCount, 0)} 个活动 Key</small><small>最近同步 ${escapeHtml(timeAgo(provider.lastSyncAt))}</small></td>
      <td class="numeric" data-label="映射账号"><strong>${formatNumber(provider.mappedAccountCount, 0)}</strong></td>
      <td class="numeric" data-label="窗口请求">${providerRequestComparison(provider)}</td>
      <td class="numeric" data-label="缓存读取率">${providerComparisonMetric(provider, 'cacheRate', formatPercent)}</td>
      <td class="numeric" data-label="首字 P95">${providerComparisonMetric(provider, 'ttftP95Ms', formatMilliseconds)}</td>
      <td class="numeric account-speed-cell" data-label="输出速度">${providerComparisonMetric(provider, 'outputTokensPerSecond', (value) => value == null ? '-' : `${formatNumber(value, 1)} tok/s`)}</td>
      <td class="numeric account-cost-column" data-label="窗口费用">${providerCostComparison(provider)}</td>
      <td class="numeric account-cost-column" data-label="累计费用">${providerCostComparison(provider, 'lifetime')}</td>
      <td class="numeric provider-recharge-column" data-label="已充值">${providerRechargeAuditMarkup(provider)}</td>
      <td class="numeric account-probe-cell" data-label="检测通过率">${providerProbeComparison(provider)}</td>
      <td class="numeric account-quality-cell" data-label="质量分">${providerQualityComparison(provider)}</td>
    </tr>${keyRows}`;
  }).join('');
  return `<table>${header}<tbody>${rows}</tbody></table>`;
}

function repaintAccountMonitorProviderTable() {
  const root = $('#account-monitor-table');
  if (!root || state.accountMonitor?.itemType !== 'provider') return;
  root.innerHTML = accountMonitorProviderTable(state.accountMonitor.items || []);
  icons();
}

function openProviderRechargeAudit(provider) {
  const dialog = $('#provider-recharge-audit-dialog');
  const form = $('#provider-recharge-audit-form');
  const recharge = provider.rechargeAudit || {};
  form.elements.connectionId.value = provider.connectionId;
  form.elements.rechargedAmount.value = recharge.rechargedAmount ?? 0;
  form.elements.currency.value = recharge.currency || provider.audit?.displayCurrency || 'USD';
  form.elements.note.value = recharge.note || '';
  $('#provider-recharge-audit-title').textContent = `${provider.providerName} · 累计充值`;
  $('#provider-recharge-audit-error').textContent = '';
  dialog.showModal();
  icons();
}

async function renderAccountMonitor() {
  const result = await api(`/api/account-monitor/accounts?${accountMonitorQuery()}`);
  state.accountMonitor = result;
  state.accountMonitorFilters.page = result.pagination.page;
  const filters = state.accountMonitorFilters;
  filters.display = result.itemType === 'provider'
    ? 'providers'
    : result.itemType === 'group' ? 'groups' : 'accounts';
  const visibleIds = new Set((result.itemType === 'account'
    ? result.items
    : result.itemType === 'group'
      ? result.items.flatMap((group) => group.accounts || [])
      : result.items.flatMap((provider) => provider.keys || []).flatMap((key) => key.accounts || []))
    .map((item) => String(item.accountId)));
  setTopActions(`<button class="button" data-action="open-account-metric-rules" title="查看指标计算规则" aria-label="查看指标计算规则"><i data-lucide="circle-help"></i><span>指标口径</span></button><button class="button" data-action="open-account-monitor-settings" title="检测设置" aria-label="检测设置"><i data-lucide="settings-2"></i><span>检测设置</span></button><button class="button" data-action="sync-account-monitor" title="同步基座和供应商日志" aria-label="同步基座和供应商日志"><i data-lucide="refresh-cw"></i><span>同步双源</span></button>${result.itemType === 'provider' ? '' : '<button class="button primary" data-action="detect-selected-accounts" title="检测所选账号" aria-label="检测所选账号" disabled><i data-lucide="flask-conical"></i><span>检测所选</span></button>'}`);
  const platformOptions = (result.platforms || []).map((platform) =>
    `<option value="${escapeHtml(platform)}" ${filters.platform === platform ? 'selected' : ''}>${escapeHtml(accountMonitorPlatformLabel(platform))}</option>`
  ).join('');
  const groupOptions = (result.groups || []).map((group) =>
    `<option value="${escapeHtml(group.id)}" ${filters.groupId === group.id ? 'selected' : ''}>${escapeHtml(group.name)} (${formatNumber(group.accountCount, 0)})</option>`
  ).join('');
  const rows = result.itemType === 'account'
    ? accountMonitorAccountRows(result.items)
    : '';
  const summary = result.summary;
  const monitorState = result.state || {};
  const baseSyncSummary = monitorState.lastSyncSummary || {};
  const baseSyncNote = baseSyncSummary.usageTruncated
    ? ' · 基座部分日期达到采集上限'
    : baseSyncSummary.usageExactTotal !== true
      ? ' · 基座待精确分页回补'
      : '';
  const groupSyncNote = baseSyncSummary.groupCatalogComplete === false
    ? ' · 基座分组目录未完整同步'
    : '';
  const groupMembershipSyncNote = summary.pendingGroupAccountCount > 0
    ? ` · ${formatNumber(summary.pendingGroupAccountCount, 0)} 个账号分组待同步${summary.mappingCachedGroupAccountCount > 0 ? `（${formatNumber(summary.mappingCachedGroupAccountCount, 0)} 个按映射缓存展示）` : ''}`
    : '';
  const tableContent = result.itemType === 'provider'
    ? accountMonitorProviderTable(result.items)
    : result.itemType === 'group'
      ? accountMonitorGroupTable(result.items)
      : rows
      ? `<table>${accountMonitorTableStructure()}<tbody>${rows}</tbody></table>`
      : emptyState('brain-circuit', '暂无账号质量数据', '同步 Sub2API 账号与请求日志后显示');
  const statsMarkup = result.itemType === 'provider'
    ? `<div class="stats-grid account-quality-stats">
        <div class="stat"><span class="stat-label"><i data-lucide="server-cog"></i>供应商 / Key</span><strong class="stat-value">${formatNumber(summary.providerCount, 0)} / ${formatNumber(summary.visibleKeyCount, 0)}</strong><span class="stat-detail">当前页 ${formatNumber(summary.visibleProviderCount, 0)} 个供应商 · 映射 ${formatNumber(summary.mappedAccountCount, 0)} 个账号</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="activity"></i>累计请求</span><strong class="stat-value">${formatNumber(summary.lifetimeRequestCount, 0)}</strong><span class="stat-detail">当前窗口 ${formatNumber(summary.requestCount, 0)} · ${escapeHtml(accountMonitorWindowLabel(summary.windowType, summary.days))}</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="wallet-cards"></i>当前页累计充值</span><strong class="stat-value">${escapeHtml(formatPreciseMoney(summary.configuredRechargeAmount, summary.displayCurrency))}</strong><span class="stat-detail">上游累计成本 ${escapeHtml(formatPreciseMoney(summary.lifetimeUpstreamCost, summary.displayCurrency))}</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="scale"></i>当前页累计毛利</span><strong class="stat-value">${escapeHtml(formatPreciseMoney(summary.lifetimeGrossProfit, summary.displayCurrency))}</strong><span class="stat-detail">基座累计收入 ${escapeHtml(formatPreciseMoney(summary.lifetimeBaseRevenue, summary.displayCurrency))}</span></div>
      </div>`
    : `<div class="stats-grid account-quality-stats">
        <div class="stat"><span class="stat-label"><i data-lucide="users-round"></i>${summary.comparisonScope === 'page' ? '当前页账号映射' : '账号映射'}</span><strong class="stat-value">${formatNumber(summary.mappedAccountCount, 0)} / ${formatNumber(summary.comparisonScope === 'page' ? summary.comparisonAccountCount : summary.accountCount, 0)}</strong><span class="stat-detail">${summary.platformCount} 个平台 · ${formatNumber(summary.baseGroupCount, 0)} 个基座分组${summary.ungroupedAccountCount ? ` · ${formatNumber(summary.ungroupedAccountCount, 0)} 个未分组` : ''}${summary.pendingGroupAccountCount ? ` · ${formatNumber(summary.pendingGroupAccountCount, 0)} 个待核验` : ''}</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="radio-tower"></i>基座请求</span><strong class="stat-value">${formatNumber(summary.requestCount, 0)}</strong><span class="stat-detail">缓存读取 ${formatPercent(summary.cacheRate)} · ${escapeHtml(accountMonitorWindowLabel(summary.windowType, summary.days))}</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="database-zap"></i>${summary.comparisonScope === 'page' ? '当前页上游覆盖' : '上游逐请求覆盖'}</span><strong class="stat-value">${formatNumber(summary.supplierLogAccountCount, 0)}</strong><span class="stat-detail">成功配对 ${formatNumber(summary.pairedAccountCount, 0)} 个账号 · Key 额外 ${formatNumber(summary.upstreamExtraRequestCount, 0)} 请求</span></div>
        <div class="stat"><span class="stat-label"><i data-lucide="scale"></i>${summary.comparisonScope === 'page' ? '当前页费用可比' : '费用可比账号'}</span><strong class="stat-value">${formatNumber(summary.comparableCostAccountCount, 0)}</strong><span class="stat-detail">主动检测通过 ${formatPercent(summary.probeSuccessRate)}</span></div>
      </div>`;
  const providerView = filters.display === 'providers';
  $('#main-content').innerHTML = `
      <section class="base-instance-bar account-monitor-source"><div><span class="status-dot ${monitorState.lastSyncStatus === 'failed' ? 'error' : monitorState.lastLogSyncAt ? 'healthy' : 'warning'}"></span><strong>Sub2API 基座 / 供应商上游</strong><small>基座 ${escapeHtml(timeAgo(monitorState.lastLogSyncAt))} · 上游 ${escapeHtml(timeAgo(summary.supplierLastSyncAt))}${baseSyncNote}${groupSyncNote}${groupMembershipSyncNote}</small></div><div class="status-summary">${badge(result.settings.syncEnabled ? 'enabled' : 'info', result.settings.syncEnabled ? result.settings.syncIntervalMinutes + ' 分钟双源同步' : '仅手动同步')}${badge(result.settings.probeEnabled ? 'enabled' : 'info', result.settings.probeEnabled ? result.settings.probeIntervalMinutes + ' 分钟检测' : '定时检测关闭')}</div></section>
    ${statsMarkup}
    <section class="section">
      <div class="filter-bar account-monitor-filters">
        <div class="tabs account-monitor-view-tabs" role="tablist" aria-label="账号质量展示方式"><button class="tab ${filters.display === 'providers' ? 'active' : ''}" data-action="account-monitor-display" data-display="providers" role="tab" aria-selected="${filters.display === 'providers'}" tabindex="${filters.display === 'providers' ? '0' : '-1'}"><i data-lucide="server-cog"></i><span>供应商</span></button><button class="tab ${filters.display === 'groups' ? 'active' : ''}" data-action="account-monitor-display" data-display="groups" role="tab" aria-selected="${filters.display === 'groups'}" tabindex="${filters.display === 'groups' ? '0' : '-1'}"><i data-lucide="list-tree"></i><span>基座分组</span></button><button class="tab ${filters.display === 'accounts' ? 'active' : ''}" data-action="account-monitor-display" data-display="accounts" role="tab" aria-selected="${filters.display === 'accounts'}" tabindex="${filters.display === 'accounts' ? '0' : '-1'}"><i data-lucide="users-round"></i><span>账号</span></button></div>
        <label class="search-box"><i data-lucide="search"></i><input id="account-monitor-search" type="search" value="${escapeHtml(filters.search)}" placeholder="${providerView ? '搜索供应商或 Key' : '搜索账号或基座分组'}" aria-label="${providerView ? '搜索供应商或 Key' : '搜索账号或基座分组'}"></label>
        ${providerView ? '' : `<select id="account-monitor-group" aria-label="Sub2API 基座分组"><option value="">全部基座分组</option>${groupOptions}</select><select id="account-monitor-platform" aria-label="平台"><option value="">全部平台</option>${platformOptions}</select><select id="account-monitor-status" aria-label="账号状态"><option value="">全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>活动</option><option value="error" ${filters.status === 'error' ? 'selected' : ''}>错误</option><option value="rate_limited" ${filters.status === 'rate_limited' ? 'selected' : ''}>限流</option></select>`}
        <select id="account-monitor-days" aria-label="观察窗口"><option value="1" ${filters.days === '1' || filters.days === 1 || filters.days === '24h' ? 'selected' : ''}>24 小时</option><option value="today" ${filters.days === 'today' ? 'selected' : ''}>当天</option><option value="7" ${filters.days === '7' ? 'selected' : ''}>7 天</option><option value="30" ${filters.days === '30' ? 'selected' : ''}>30 天</option><option value="90" ${filters.days === '90' ? 'selected' : ''}>90 天</option></select>
        ${providerView ? '' : `<select id="account-monitor-sort" aria-label="排序"><option value="qualityScore" ${filters.sortBy === 'qualityScore' ? 'selected' : ''}>${filters.display === 'groups' ? '质量均值' : '质量分'}</option>${filters.display === 'groups' ? `<option value="accountCount" ${filters.sortBy === 'accountCount' ? 'selected' : ''}>账号数</option>` : `<option value="costDifference" ${filters.sortBy === 'costDifference' ? 'selected' : ''}>费用差额</option>`}<option value="ttftP95Ms" ${filters.sortBy === 'ttftP95Ms' ? 'selected' : ''}>${filters.display === 'groups' ? '账号首字 P95 均值' : '首字 P95'}</option><option value="cacheRate" ${filters.sortBy === 'cacheRate' ? 'selected' : ''}>缓存读取率</option><option value="probeSuccessRate" ${filters.sortBy === 'probeSuccessRate' ? 'selected' : ''}>检测通过率</option><option value="intelligenceScore" ${filters.sortBy === 'intelligenceScore' ? 'selected' : ''}>${filters.display === 'groups' ? '能力均值' : '能力分'}</option><option value="requestCount" ${filters.sortBy === 'requestCount' ? 'selected' : ''}>请求数</option></select>`}
      </div>
      <div id="account-monitor-table" class="table-wrap account-quality-table ${result.itemType === 'provider' ? 'account-provider-quality-table' : result.itemType === 'group' ? 'account-group-quality-table' : ''}">${tableContent}</div>
      ${accountMonitorPagination(result.pagination, result.itemType)}
    </section>
    <section class="section" id="account-monitor-detail"></section>`;
  updateAccountMonitorSelectionAction();
  if (state.accountMonitorDetail && visibleIds.has(String(state.accountMonitorDetail.account.accountId))) {
    paintAccountMonitorDetail(state.accountMonitorDetail);
  }
  icons();
}

async function loadAccountMonitorDetail(accountId) {
  const detail = await api(`/api/account-monitor/accounts/${encodeURIComponent(accountId)}?days=${encodeURIComponent(state.accountMonitorFilters.days)}`);
  state.accountMonitorDetail = detail;
  paintAccountMonitorDetail(detail);
}

function paintAccountMonitorDetail(detail) {
  const root = $('#account-monitor-detail');
  if (!root || !detail) return;
  const metrics = detail.metrics;
  const comparison = detail.comparison || {};
  const comparisonBase = comparison.base || metrics;
  const upstream = comparison.upstream || {};
  const windowBase = comparison.windowTotals?.base || comparisonBase;
  const windowUpstream = comparison.windowTotals?.upstream || upstream;
  const cost = comparison.cost || {};
  const overheadDelta = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    if (Math.abs(Number(value)) < 1e-9) return '一致';
    return `基座 ${Number(value) > 0 ? '+' : '-'}${formatMilliseconds(Math.abs(Number(value)))}`;
  };
  const comparisonRows = [
    ['请求总数（统一窗口）', formatNumber(windowBase.requestCount, 0), formatNumber(windowUpstream.requestCount, 0), accountMetricDelta(windowBase.requestCount, windowUpstream.requestCount, (value) => formatNumber(value, 0))],
    ['缓存读取率（配对）', formatPercent(comparisonBase.cacheRate), formatPercent(upstream.cacheRate), accountMetricDelta(comparisonBase.cacheRate, upstream.cacheRate, (value) => `${formatNumber(value, 1)} 个百分点`)],
    ['首字 P95（配对）', formatMilliseconds(comparisonBase.ttftP95Ms), formatMilliseconds(upstream.ttftP95Ms), overheadDelta(comparison.overhead?.ttftP95Ms)],
    ['总耗时 P95（配对）', formatMilliseconds(comparisonBase.durationP95Ms), formatMilliseconds(upstream.durationP95Ms), overheadDelta(comparison.overhead?.durationP95Ms)],
    ['输出速度（配对）', comparisonBase.outputTokensPerSecond == null ? '-' : `${formatNumber(comparisonBase.outputTokensPerSecond, 1)} tok/s`, upstream.outputTokensPerSecond == null ? '-' : `${formatNumber(upstream.outputTokensPerSecond, 1)} tok/s`, accountMetricDelta(comparisonBase.outputTokensPerSecond, upstream.outputTokensPerSecond, (value) => `${formatNumber(value, 1)} tok/s`)]
  ].map(([label, base, provider, delta]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td class="numeric">${escapeHtml(base)}</td><td class="numeric">${escapeHtml(provider)}</td><td class="numeric">${escapeHtml(delta)}</td></tr>`).join('');
  const rawCostCurrency = cost.currency || 'USD';
  const cashCostCurrency = cost.cashCurrency || rawCostCurrency;
  const pairedUsesCash = cost.baseCashEquivalent != null && cost.upstreamCashEquivalent != null;
  const pairedCostCurrency = pairedUsesCash ? cashCostCurrency : rawCostCurrency;
  const displayedBaseCost = pairedUsesCash ? cost.baseCashEquivalent : cost.baseCost;
  const displayedUpstreamCost = pairedUsesCash ? cost.upstreamCashEquivalent : cost.upstreamCost;
  const pairedCostDelta = cost.comparable
    ? cost.profitStatus === 'break_even'
      ? '收支平衡'
      : `${cost.profitStatus === 'profit' ? '毛差' : '成本倒挂'} ${cost.profitStatus === 'profit' ? '+' : '-'}${formatPreciseMoney(Math.abs(cost.differenceAmount), cashCostCurrency)}`
    : accountComparisonReasonLabel(cost.reason);
  const windowUsesCash = cost.baseWindowCashEquivalent != null &&
    cost.keyTotalUpstreamCashEquivalent != null;
  const windowCostCurrency = windowUsesCash ? cashCostCurrency : rawCostCurrency;
  const displayedBaseWindowCost = windowUsesCash
    ? cost.baseWindowCashEquivalent
    : cost.baseWindowCost;
  const displayedUpstreamWindowCost = windowUsesCash
    ? cost.keyTotalUpstreamCashEquivalent
    : cost.keyTotalUpstreamCost;
  const frozenValuation = cost.valuationMode === 'transaction_snapshot';
  const baseValuationLabel = frozenValuation
    ? '发生时充值倍率已冻结'
    : `当前充值倍率 ${formatEffectiveRate(cost.baseRechargeMultiplier)}`;
  const upstreamValuationLabel = frozenValuation
    ? '发生时充值倍率已冻结'
    : `当前充值倍率 ${formatEffectiveRate(cost.providerRecharge?.multiplier)}`;
  const windowCostDelta = cost.windowComparable
    ? cost.windowProfitStatus === 'break_even'
      ? '收支平衡'
      : `${cost.windowProfitStatus === 'profit' ? '总账毛差' : '总账倒挂'} ${cost.windowProfitStatus === 'profit' ? '+' : '-'}${formatPreciseMoney(Math.abs(cost.windowDifferenceAmount), cashCostCurrency)}`
    : accountComparisonReasonLabel(cost.windowReason);
  const providerHeading = comparison.provider
    ? `${escapeHtml(comparison.provider.name)} · ${escapeHtml(comparison.provider.keyName || '未绑定 Key')}`
    : comparison.status === 'multiple_upstreams' ? `${comparison.targets?.length || 0} 个供应商上游` : '未映射供应商上游';
  const coverageText = comparison.window?.from && comparison.window?.to
    ? `统一窗口 ${formatDate(comparison.window.from)} 至 ${formatDate(comparison.window.to)}`
    : '暂无统一可比窗口';
  const pairingText = comparison.pairing?.matchedCount > 0
    ? ` · 配对 ${formatNumber(comparison.pairing.matchedCount, 0)} / ${formatNumber(comparison.pairing.baseRequestCount, 0)}${comparison.pairing.upstreamExtraCount > 0 ? ` · 上游未归因 ${formatNumber(comparison.pairing.upstreamExtraCount, 0)}` : comparison.pairing.extraCountTrusted === false ? ' · 额外请求待回补核实' : ''}`
    : '';
  const metricReasonText = comparison.metricReason
    ? ` · ${accountComparisonReasonLabel(comparison.metricReason)}`
    : '';
  const probeRows = detail.probes.slice(0, 12).map((probe) =>
    `<tr><td>${badge(probe.status)}</td><td>${escapeHtml(accountProbeSuiteLabel(probe.suite))}</td><td>${badge(probe.details?.transport === 'direct_api_key' ? 'enabled' : 'info', accountProbeTransportLabel(probe.details))}</td><td>${escapeHtml(probe.model || '-')}</td><td class="numeric">${formatMilliseconds(probe.firstTokenMs)}</td><td class="numeric">${formatMilliseconds(probe.durationMs)}</td><td class="numeric">${probe.intelligenceScore == null ? '-' : formatNumber(probe.intelligenceScore, 0)}</td><td class="primary-cell"><strong>${escapeHtml(probe.responseExcerpt || probe.errorMessage || '-')}</strong><small>${formatDate(probe.completedAt)}</small></td></tr>`
  ).join('');
  const probeTable = probeRows
    ? `<table><thead><tr><th>结果</th><th>检测</th><th>路径</th><th>模型</th><th class="numeric">首字</th><th class="numeric">总耗时</th><th class="numeric">能力</th><th>响应 / 错误</th></tr></thead><tbody>${probeRows}</tbody></table>`
    : emptyState('flask-conical', '暂无主动检测', '选择该账号并执行检测');
  root.innerHTML = `<div class="section-header"><h2>${escapeHtml(detail.account.name)}</h2><p>#${escapeHtml(detail.account.accountId)} · ${escapeHtml(accountMonitorPlatformLabel(detail.account.platform))} · ${escapeHtml(accountGroupSummary(detail.account.groups, detail.account.groupAssociationsKnown !== false))} · ${escapeHtml(accountMonitorWindowLabel(detail.windowType, detail.days))}</p><div class="section-actions"><button class="icon-button small" data-action="close-account-quality" title="关闭详情" aria-label="关闭详情"><i data-lucide="x"></i></button></div></div>
    <div class="account-detail-metrics"><div><span>质量分</span><strong>${metrics.qualityScore == null ? '-' : formatNumber(metrics.qualityScore, 0)}</strong></div><div><span>首字 P95</span><strong>${formatMilliseconds(metrics.ttftP95Ms)}</strong></div><div><span>缓存读取率</span><strong>${formatPercent(metrics.cacheRate)}</strong></div><div><span>输出速度</span><strong>${metrics.outputTokensPerSecond == null ? '-' : formatNumber(metrics.outputTokensPerSecond, 1) + ' tok/s'}</strong></div><div><span>检测通过率</span><strong>${formatPercent(metrics.probeSuccessRate)}</strong></div><div><span>能力得分</span><strong>${metrics.intelligenceScore == null ? '未覆盖' : formatNumber(metrics.intelligenceScore, 0)}</strong></div></div>
    <section class="section account-comparison-detail"><div class="section-header"><div><h2>基座 / 上游对比</h2><p>${providerHeading} · ${escapeHtml(accountUpstreamSourceLabel(comparison.source))} · ${escapeHtml(coverageText + pairingText)}${escapeHtml(metricReasonText)}</p></div>${comparison.coverage?.stale ? badge('stale', '上游数据陈旧') : comparison.status === 'mapped' ? badge('enabled', '已映射') : badge('warning', '不可归因')}</div><div class="table-wrap"><table><thead><tr><th>指标</th><th class="numeric">Sub2API 基座</th><th class="numeric">供应商上游</th><th class="numeric">差值</th></tr></thead><tbody>${comparisonRows}<tr class="cost-comparison-row"><td><strong>统一窗口 Key 总账${windowUsesCash ? '（现金等值）' : '（余额单位）'}</strong><small>基座 actual_cost 实际收入 / 上游 actual_cost 实际支出 · ${escapeHtml(cost.source ? `${formatDate(cost.from)} 至 ${formatDate(cost.to)}` : '暂无费用来源')}</small></td><td class="numeric"><strong>${escapeHtml(formatPreciseMoney(displayedBaseWindowCost, windowCostCurrency))}</strong><small>${windowUsesCash ? `余额消费 ${escapeHtml(formatPreciseMoney(cost.baseWindowCost, rawCostCurrency))} · ` : ''}${escapeHtml(baseValuationLabel)}</small></td><td class="numeric"><strong>${escapeHtml(formatPreciseMoney(displayedUpstreamWindowCost, windowCostCurrency))}</strong><small>${windowUsesCash ? `余额消费 ${escapeHtml(formatPreciseMoney(cost.keyTotalUpstreamCost, rawCostCurrency))} · ` : ''}${escapeHtml(upstreamValuationLabel)}</small></td><td class="numeric"><strong>${escapeHtml(windowCostDelta)}</strong>${cost.windowGrossMarginRatio == null ? '' : `<small>总账毛利率 ${escapeHtml(formatPercent(cost.windowGrossMarginRatio * 100))}</small>`}</td></tr><tr><td><strong>配对请求可归因收支${pairedUsesCash ? '（现金等值）' : '（余额单位）'}</strong><small>仅比较成功一一配对的 ${escapeHtml(formatNumber(cost.requestCount, 0))} 次请求；上游未归因流量不混入</small></td><td class="numeric">${escapeHtml(formatPreciseMoney(displayedBaseCost, pairedCostCurrency))}</td><td class="numeric">${escapeHtml(formatPreciseMoney(displayedUpstreamCost, pairedCostCurrency))}</td><td class="numeric"><strong>${escapeHtml(pairedCostDelta)}</strong>${cost.grossMarginRatio == null ? '' : `<small>配对毛利率 ${escapeHtml(formatPercent(cost.grossMarginRatio * 100))}</small>`}</td></tr></tbody></table></div></section>
    <div class="panel account-quality-chart-panel"><div class="panel-header"><h3>统一窗口日趋势</h3><span class="stat-detail">趋势按窗口总请求聚合；表格性能优先使用配对请求</span></div><div class="chart" id="account-quality-chart"></div></div>
    <section class="section"><div class="section-header"><h2>最近主动检测</h2></div><div class="table-wrap">${probeTable}</div></section>`;
  state.chart?.dispose?.();
  const chartRoot = $('#account-quality-chart');
  if (chartRoot && window.echarts) {
    const days = [...new Set([
      ...detail.trends.map((item) => item.day),
      ...(detail.upstreamTrends || []).map((item) => item.day)
    ])].sort();
    const baseByDay = new Map(detail.trends.map((item) => [item.day, item]));
    const upstreamByDay = new Map((detail.upstreamTrends || []).map((item) => [item.day, item]));
    const hasUpstreamTrends = upstreamByDay.size > 0;
    const series = [
      { name: '基座首字', type: 'line', showSymbol: false, data: days.map((day) => baseByDay.get(day)?.ttftMs ?? null) },
      { name: '基座耗时', type: 'line', showSymbol: false, data: days.map((day) => baseByDay.get(day)?.durationMs ?? null) },
      { name: '基座缓存', type: 'line', yAxisIndex: 1, showSymbol: false, data: days.map((day) => baseByDay.get(day)?.cacheRate ?? null) }
    ];
    if (hasUpstreamTrends) {
      series.push(
        { name: '上游首字', type: 'line', showSymbol: false, lineStyle: { type: 'dashed' }, data: days.map((day) => upstreamByDay.get(day)?.ttftMs ?? null) },
        { name: '上游耗时', type: 'line', showSymbol: false, lineStyle: { type: 'dashed' }, data: days.map((day) => upstreamByDay.get(day)?.durationMs ?? null) },
        { name: '上游缓存', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { type: 'dashed' }, data: days.map((day) => upstreamByDay.get(day)?.cacheRate ?? null) }
      );
    }
    state.chart = echarts.init(chartRoot);
    state.chart.setOption({
      animationDuration: 250,
      color: ['#147d64', '#2f6fba', '#b66a16', '#45a284', '#6794c8', '#d49a50'],
      tooltip: { trigger: 'axis' },
      legend: { top: 12, data: series.map((item) => item.name) },
      grid: { left: 58, right: 58, top: 54, bottom: 42 },
      xAxis: { type: 'category', data: days, boundaryGap: false },
      yAxis: [
        { type: 'value', name: 'ms', min: 0 },
        { type: 'value', name: '%', min: 0, max: 100 }
      ],
      series
    });
  }
  root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  icons();
}

function openAccountMonitorSettings() {
  const dialog = $('#account-monitor-settings-dialog');
  const form = $('#account-monitor-settings-form');
  const settings = state.accountMonitor?.settings;
  if (!settings) return;
  form.elements.syncEnabled.checked = settings.syncEnabled;
  form.elements.autoMappingEnabled.checked = settings.autoMappingEnabled;
  form.elements.syncIntervalMinutes.value = settings.syncIntervalMinutes;
  form.elements.lookbackDays.value = settings.lookbackDays;
  form.elements.sampleRetentionDays.value = settings.sampleRetentionDays;
  form.elements.baseRechargeMultiplier.value = settings.baseRechargeMultiplier || 1;
  form.elements.probeEnabled.checked = settings.probeEnabled;
  form.elements.probeIntervalMinutes.value = settings.probeIntervalMinutes;
  form.elements.probeConcurrency.value = settings.probeConcurrency;
  const platforms = [...new Set([
    ...(state.accountMonitor.platforms || []),
    ...(settings.probePlatforms || []),
    ...Object.keys(settings.probeModels || {})
  ])].sort();
  const selected = new Set(settings.probePlatforms?.length ? settings.probePlatforms : platforms);
  const rows = platforms.map((platform) => `<div class="account-platform-setting"><label class="toggle-field"><input type="checkbox" data-probe-platform="${escapeHtml(platform)}" ${selected.has(platform) ? 'checked' : ''}><span>${escapeHtml(accountMonitorPlatformLabel(platform))}</span></label><label><span>检测模型</span><input data-probe-model="${escapeHtml(platform)}" value="${escapeHtml(settings.probeModels?.[platform] || '')}" placeholder="使用基座默认模型"></label></div>`).join('');
  $('#account-monitor-platform-settings').innerHTML = `<span class="field-group-label">定时检测平台与模型</span><div class="account-platform-setting-list">${rows || '<span class="stat-detail">同步账号后显示平台</span>'}</div>`;
  $('#account-monitor-settings-error').textContent = '';
  dialog.showModal();
  icons();
}

function openAccountMetricRules(targetId = '') {
  const dialog = $('#account-metric-rules-dialog');
  if (!dialog) return;
  dialog.showModal();
  const target = targetId ? document.getElementById(targetId) : null;
  if (target) {
    requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  icons();
}

async function trackAccountMonitorJob(jobId, label) {
  toast(`${label}已加入队列`);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === 'failed') throw new Error(job.last_error || `${label}失败`);
    if (job.status === 'succeeded') {
      toast(`${label}完成`);
      if (state.view === 'account-monitor') await renderAccountMonitor();
      return;
    }
  }
  toast(`${label}仍在后台运行`);
}

function integrationDelta(comparison = {}) {
  const percent = Number(comparison.differenceRatio) * 100;
  if (comparison.differenceRatio == null || !Number.isFinite(percent)) return '-';
  return `${percent > 0 ? '+' : ''}${formatRateValue(percent)}%`;
}

function integrationRate(value) {
  return formatEffectiveRate(value);
}

function integrationMeasuredValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  const absolute = Math.abs(number);
  const maximumFractionDigits = absolute > 0 && absolute < 0.01 ? 6 : absolute < 1 ? 5 : 3;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(number);
}

function integrationMeasuredRate(value) {
  return value == null ? '-' : `×${integrationMeasuredValue(value)}`;
}

const PROVIDER_GROUP_SOURCE_LABELS = {
  mapping_explicit: ['info', '映射指定'],
  key_explicit: ['info', 'Key 指定'],
  account_inherited: ['info', '继承账号'],
  gateway_verified: ['healthy', '计费验证'],
  base_group_name_inferred: ['warning', '同名推断'],
  sole_group_inferred: ['warning', '唯一分组推断']
};

function providerGroupSourceBadge(comparison = {}) {
  const definition = PROVIDER_GROUP_SOURCE_LABELS[comparison.details?.providerGroupSource];
  return definition ? ` ${badge(definition[0], definition[1])}` : '';
}

function integrationProviderRate(comparison = {}) {
  const dynamicRouteHistory = comparison.details?.providerRateScope === 'dynamic_route_history';
  const parts = [dynamicRouteHistory
    ? integrationMeasuredRate(comparison.providerRate)
    : integrationRate(comparison.providerRate)];
  if (dynamicRouteHistory) {
    const dynamic = comparison.details.dynamicRouteRate || {};
    const totalObservationCount = dynamic.summary?.totalObservationCount || dynamic.sampleCount || 0;
    const hasUnusableObservations = totalObservationCount > (dynamic.sampleCount || 0);
    const statisticLabel = {
      median: 'P50', p90: 'P90', weighted_average: '成本加权',
      latest: hasUnusableObservations ? '最近可计算' : '最近一次'
    }[dynamic.statistic] || '历史实测';
    parts.push(`日志价÷官方价 ${statisticLabel}`);
    parts.push(hasUnusableObservations
      ? `${totalObservationCount} 条日志/${dynamic.sampleCount || 0} 条可计算`
      : `${dynamic.sampleCount || 0} 次`);
    if ((dynamic.sampleCount || 0) > 1 && dynamic.minMultiplier != null && dynamic.maxMultiplier != null) {
      parts.push(`范围 ${integrationMeasuredRate(dynamic.minMultiplier)}~${integrationMeasuredRate(dynamic.maxMultiplier)}`);
    }
    const latest = dynamic.summary?.latest || {};
    const latestChannel = latest.channelName;
    if (latestChannel) parts.push(`最近 ${escapeHtml(latestChannel)}`);
    const priceSourceLabel = {
      log_explicit: '日志单价',
      log_ratio: '日志倍率换算',
      mixed: '混合单价来源'
    }[latest.providerPriceSource];
    if (priceSourceLabel) parts.push(priceSourceLabel);
    if (
      latest.providerInputPerMillion != null && latest.referenceInputPerMillion != null
    ) {
      const providerPrices = `$${integrationMeasuredValue(latest.providerInputPerMillion)}` +
        (latest.providerOutputPerMillion == null ? '' : `/$${integrationMeasuredValue(latest.providerOutputPerMillion)}`);
      const referencePrices = `$${integrationMeasuredValue(latest.referenceInputPerMillion)}` +
        (latest.referenceOutputPerMillion == null ? '' : `/$${integrationMeasuredValue(latest.referenceOutputPerMillion)}`);
      parts.push(`${providerPrices}÷${referencePrices}`);
    }
    const missingModels = dynamic.summary?.referenceMissingModels || [];
    if (missingModels.length > 0) parts.push(`缺官方价/别名 ${missingModels.map(escapeHtml).join('、')}`);
    const missingProviderModels = dynamic.summary?.providerPriceMissingModels || [];
    if (missingProviderModels.length > 0) parts.push(`缺供应商单价 ${missingProviderModels.map(escapeHtml).join('、')}`);
    if (dynamic.status === 'unavailable') parts.push('缓存');
    else if (dynamic.status === 'low_confidence') parts.push('样本少');
    else if (dynamic.status === 'recalculation_required') parts.push('待重新同步');
  } else {
    if (comparison.details?.providerRateScope === 'group_multiplier') parts.push('分组倍率');
    if (comparison.details?.channelCostVerified === false) parts.push('渠道成本未验证');
  }
  return parts.join(' · ');
}

const RECHARGE_SOURCE_LABELS = {
  manual: '手工',
  default: '默认',
  provider_quote: '用户报价',
  provider_status_price: '站点价格',
  provider_payment_config: '支付配置',
  provider_billing: '计费接口'
};

function rechargeMultiplier(comparison = {}, recharge = {}) {
  const value = Number(comparison.rechargeMultiplier ?? recharge.multiplier);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function integrationRecharge(comparison = {}, recharge = {}) {
  const multiplier = rechargeMultiplier(comparison, recharge);
  if (multiplier == null) return '<strong>-</strong><small>未获取</small>';
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(multiplier);
  const source = comparison.rechargeSource || recharge.source;
  const status = comparison.rechargeStatus || recharge.status;
  const sourceLabel = status === 'unavailable' ? '缓存' : RECHARGE_SOURCE_LABELS[source] || '接口';
  const currencyPair = recharge.paidCurrency && recharge.balanceCurrency
    ? ` · ${recharge.paidCurrency}→${recharge.balanceCurrency}`
    : '';
  return `<strong title="支付 1 单位可获得 ${formatted} 单位供应商余额">1:${formatted}</strong><small>${escapeHtml(`${sourceLabel}${currencyPair}`)}</small>`;
}

function integrationCompositeRate(comparison = {}, recharge = {}) {
  const stored = Number(comparison.compositeRate);
  if (comparison.compositeRate != null && Number.isFinite(stored)) return integrationRate(stored);
  const providerRate = Number(comparison.providerRate);
  const multiplier = rechargeMultiplier(comparison, recharge);
  return Number.isFinite(providerRate) && multiplier != null
    ? integrationRate(providerRate / multiplier)
    : '-';
}

function integrationSummaryHelp() {
  return `<details class="integration-status-help">
    <summary title="查看状态说明" aria-label="查看联动状态说明" aria-describedby="integration-status-help-panel"><i data-lucide="circle-help"></i></summary>
    <div class="integration-status-help-panel" id="integration-status-help-panel" role="tooltip">
      <h3>状态说明</h3>
      <div><span>${badge('aligned', '一致')}</span><p>映射完整，综合倍率与基座倍率的差值在容差范围内。</p></div>
      <div><span>${badge('warning', '预警')}</span><p>存在综合倍率偏差，或供应商分组、官方参考价格、动态路由样本、倍率等映射信息不完整。</p></div>
      <div><span>${badge('failed', '错误')}</span><p>映射引用的 Sub2API 分组已经不存在，需要修正映射。</p></div>
      <div><span>${badge('unknown', '待检查')}</span><p>已有映射尚未生成检查结果，刷新基座后会重新计算。</p></div>
      <p class="integration-status-help-scope">这里只统计已有映射；无映射分组不会计入“待检查”，停用映射也不计入这四项。</p>
    </div>
  </details>`;
}

function integrationMappingActions(item) {
  return `<button class="icon-button small" data-action="reconcile" data-id="${item.id}" title="立即对账" aria-label="立即对账"><i data-lucide="calculator"></i></button>${item.role === 'backup' ? `<button class="icon-button small" data-action="activate-backup" data-id="${item.id}" title="激活备用映射" aria-label="激活备用映射"><i data-lucide="arrow-right-left"></i></button>` : ''}<button class="icon-button small" data-action="edit-mapping" data-id="${item.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-mapping" data-id="${item.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button>`;
}

function integrationAccountPriority(item = {}) {
  const priority = Number(item?.baseAccount?.priority);
  return item?.baseAccount?.priority != null && Number.isFinite(priority)
    ? formatNumber(priority, 0)
    : '-';
}

function integrationDetailRow(item, groupKey, expanded) {
  const comparison = item.comparison || {};
  const providerGroupState = comparison.details?.providerGroupStatus && !['active', 'enabled'].includes(comparison.details.providerGroupStatus.toLowerCase())
    ? ` ${badge(comparison.details.providerGroupStatus)}` : '';
  const providerGroupSource = providerGroupSourceBadge(comparison);
  return `<tr class="integration-detail-row${item.isHighestRate ? ' highest-rate-row' : ''}" data-integration-parent="${escapeHtml(groupKey)}" ${expanded ? '' : 'hidden'}>
    <td class="primary-cell integration-indent"><strong>${item.account_id ? `账号 #${item.account_id}` : '账户级映射'}</strong><small>${item.role === 'primary' ? '主映射' : '备用映射'}</small></td>
    <td class="numeric"><strong>${integrationAccountPriority(item)}</strong></td>
    <td class="numeric">${integrationRate(comparison.baseGroupRate)}</td>
    <td class="primary-cell"><strong>${escapeHtml(item.provider_name)}</strong><small>${escapeHtml(item.key_name || '账户级')} · ${escapeHtml(item.masked_key || '-')}</small></td>
    <td class="primary-cell integration-provider-rate-cell"><strong>${escapeHtml(comparison.providerGroupName || comparison.providerGroupRef || '-')}${providerGroupState}${providerGroupSource}${item.isHighestRate ? ` ${badge('highest', '综合最高')}` : ''}</strong><small>${integrationProviderRate(comparison)}</small></td>
    <td class="numeric">${integrationRecharge(comparison, item.recharge)}</td>
    <td class="numeric"><strong title="供应商分组倍率 ÷ 充值倍率">${integrationCompositeRate(comparison, item.recharge)}</strong></td>
    <td class="numeric comparison-delta ${comparison.status === 'rate_mismatch' ? 'warning' : ''}">${integrationDelta(comparison)}</td>
    <td>${badge(comparison.status || 'unknown', comparison.status ? null : '待检查')}</td>
    <td>${item.reconciliation_status ? badge(item.reconciliation_status) : '-'}</td>
    <td class="actions-cell">${integrationMappingActions(item)}</td>
  </tr>`;
}

function integrationGroupRows(group) {
  const groupKey = String(group.groupId ?? 'unassigned');
  const expanded = state.integrationExpandedGroups.has(groupKey);
  const highest = group.highest;
  const comparison = highest?.comparison || {};
  const baseGroupState = group.status && !['active', 'enabled'].includes(group.status.toLowerCase())
    ? ` ${badge(group.status)}` : '';
  const providerGroupState = comparison.details?.providerGroupStatus && !['active', 'enabled'].includes(comparison.details.providerGroupStatus.toLowerCase())
    ? ` ${badge(comparison.details.providerGroupStatus)}` : '';
  const providerGroupSource = providerGroupSourceBadge(comparison);
  const detailRows = (group.items || []).map((item) => integrationDetailRow(item, groupKey, expanded)).join('');
  return `<tr class="integration-group-row" data-integration-group="${escapeHtml(groupKey)}">
    <td class="primary-cell"><strong>${escapeHtml(group.groupName)}${baseGroupState}</strong><small>#${escapeHtml(group.groupId)}${group.platform ? ` · ${escapeHtml(group.platform)}` : ''}</small></td>
    <td class="numeric"><strong>${integrationAccountPriority(highest)}</strong></td>
    <td class="numeric"><strong>${integrationRate(group.baseRate)}</strong></td>
    <td class="primary-cell"><strong>${escapeHtml(highest?.provider_name || '-')}</strong><small>${highest ? `${escapeHtml(highest.key_name || '账户级')} · ${escapeHtml(highest.masked_key || '-')}` : '暂无有效综合倍率映射'}</small></td>
    <td class="primary-cell integration-provider-rate-cell"><strong>${escapeHtml(comparison.providerGroupName || comparison.providerGroupRef || '-')}${providerGroupState}${providerGroupSource}${highest ? ` ${badge('highest', '综合最高')}` : ''}</strong><small>${integrationProviderRate(comparison)}</small></td>
    <td class="numeric">${integrationRecharge(comparison, highest?.recharge)}</td>
    <td class="numeric"><strong title="供应商分组倍率 ÷ 充值倍率">${integrationCompositeRate(comparison, highest?.recharge)}</strong></td>
    <td class="numeric comparison-delta ${comparison.status === 'rate_mismatch' ? 'warning' : ''}">${integrationDelta(comparison)}</td>
    <td>${highest ? badge(comparison.status || 'unknown') : badge('unknown', '无映射')}</td>
    <td>${badge(group.mappingCount ? 'info' : 'unknown', `${group.mappingCount || 0} 条`)}</td>
    <td class="actions-cell"><button class="icon-button small" data-action="toggle-integration-group" data-group-id="${escapeHtml(groupKey)}" aria-expanded="${expanded}" title="${expanded ? '收起明细' : '展开明细'}" aria-label="${expanded ? '收起明细' : '展开明细'}" ${group.mappingCount ? '' : 'disabled'}><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></button></td>
  </tr>${detailRows}`;
}

const AUTO_MAPPING_REASON_LABELS = {
  account_not_found: '未找到同名或包含供应商名的账号',
  matched_account_has_no_api_key: '匹配账号未配置 API Key',
  account_has_no_groups: '账号未关联 Sub2API 分组',
  account_group_not_found: '账号引用的分组不存在',
  account_api_key_missing: '账号导出中未返回 API Key',
  api_key_not_found_in_provider: '供应商资产中未找到对应 Key',
  remote_key_fingerprint_collision: '多个远端 Key 的脱敏指纹相同',
  provider_group_not_found: 'Key 的主分组引用已失效',
  key_has_no_primary_group: 'Key 未配置主分组',
  mapping_exists: '映射已经存在'
};
const AUTO_MAPPING_KEY_VERIFICATION_LABELS = {
  api_key_secret_exact: '已确认基座与供应商配置为同一 API Key',
  verified_gateway_billing: 'Key 不同，已通过同源计费验证',
  api_key_prefix_normalized: '已按 sk- 前缀规范化匹配',
  gateway_verification_not_supported: '该供应商类型不支持跨 Key 验证',
  gateway_remote_key_ambiguous: '供应商存在多个候选 Key，无法唯一确认',
  gateway_base_url_missing: '基座账号未配置可验证的 Base URL',
  gateway_base_url_mismatch: '基座账号与供应商 Base URL 不同',
  gateway_billing_schema_mismatch: '供应商计费接口返回格式异常',
  gateway_billing_scope_missing: '供应商计费接口未返回 billing scope',
  gateway_billing_group_mismatch: '两枚 Key 的 billing scope 不一致',
  gateway_billing_rate_mismatch: '两枚 Key 的计费倍率不一致',
  gateway_primary_group_mismatch: '已同步 Key 的主分组与计费结果不一致',
  configured_api_key_secret_mismatch: '基座账号 Key 与供应商配置的 Key 不一致',
  configured_api_key_not_synchronized: '匹配的供应商配置 Key 尚未完成同步',
  configured_api_key_credentials_missing: '供应商连接缺少 API Key 凭据',
  configured_api_key_credentials_invalid: '供应商 API Key 凭据无法解密',
  configured_api_key_identity_unavailable: '无法生成 API Key 安全标识',
  configured_api_key_identity_collision: '多个供应商 Key 具有相同安全标识'
};

function autoMappingVerificationLabel(item) {
  if (item.keyMatch === 'exact_configured_secret') {
    return AUTO_MAPPING_KEY_VERIFICATION_LABELS.api_key_secret_exact;
  }
  if (item.keyMatch === 'verified_gateway_billing') {
    return AUTO_MAPPING_KEY_VERIFICATION_LABELS.verified_gateway_billing;
  }
  const code = String(item.keyVerification || '');
  if (AUTO_MAPPING_KEY_VERIFICATION_LABELS[code]) return AUTO_MAPPING_KEY_VERIFICATION_LABELS[code];
  if (code.startsWith('gateway_billing_')) return '基座账号 Key 无法通过供应商计费验证';
  return '';
}

function autoMappingErrorMessage(error) {
  if (error.code === 'SUB2API_ACCOUNT_DISABLED') return '所选 Sub2API 账号未启用，不能建立或重新启用映射。';
  if (error.code === 'SUB2API_ACCOUNT_NOT_FOUND') return '所选 Sub2API 账号不存在，请刷新后重新选择。';
  if (error.code === 'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN') return 'Sub2API 已开启敏感操作 step-up 2FA，管理员 API Key 无法导出账号 Key。请先用完成 TOTP 验证的 Sub2API 管理员会话关闭该开关。';
  if (error.code === 'SUB2API_STEP_UP_REQUIRED') return '当前 Sub2API 管理员会话尚未获得账号 Key 读取授权，请完成 TOTP 二次验证。';
  if (error.code === 'SUB2API_LOGIN_2FA_REQUIRED') return '配置的 Sub2API 管理员账号需要 TOTP 二次验证，请完成登录。';
  if (error.code === 'SUB2API_TOTP_NOT_ENABLED') return '当前 Sub2API 管理员未启用 TOTP，请先在 Sub2API 安全设置中启用。';
  if (error.code === 'SUB2API_SSO_REQUIRED') return '账号 Key 需要可执行敏感操作的 Sub2API 管理员会话，请配置管理员账号密码或使用管理员 SSO 会话。';
  if (error.code === 'SUB2API_ADMIN_SESSION_REQUIRED') return 'Sub2API 管理员会话已失效，请重新完成管理员验证。';
  if (error.code === 'SUB2API_STEP_UP_UNAVAILABLE') return 'Sub2API 二次验证服务暂时不可用，请稍后重试。';
  if (error.code === 'SUB2API_KEY_EXPORT_FORBIDDEN') return 'Sub2API 拒绝读取账号 Key，请检查当前管理员的 TOTP 与敏感操作授权设置。';
  if (error.code === 'SUB2API_KEY_EXPORT_UNSUPPORTED') return '当前 Sub2API 版本不支持管理员账号数据导出，无法安全读取用于匹配的 API Key。';
  if (error.code === 'SCHEMA_MISMATCH') return 'Sub2API 返回的账号导出结构与预期不一致，未创建任何映射。';
  return error.message;
}

function sub2apiStepUpErrorMessage(error) {
  if (error.code === 'SUB2API_TOTP_INVALID_CODE') return 'TOTP 验证码无效或已过期。';
  if (error.code === 'SUB2API_TOTP_RATE_LIMITED') return 'TOTP 验证失败次数过多，请稍后重试。';
  return autoMappingErrorMessage(error);
}

function ensureSub2ApiStepUp() {
  const dialog = $('#sub2api-step-up-dialog');
  const form = $('#sub2api-step-up-form');
  form.reset();
  $('#sub2api-step-up-error').textContent = '';
  dialog.showModal();
  icons();
  return new Promise((resolve, reject) => {
    state.sub2apiStepUpResolve = resolve;
    state.sub2apiStepUpReject = reject;
  });
}

async function withSub2ApiTwoFactor(operation, attemptsRemaining = 2) {
  try {
    return await operation();
  } catch (error) {
    if (attemptsRemaining <= 0 || !['SUB2API_STEP_UP_REQUIRED', 'SUB2API_LOGIN_2FA_REQUIRED'].includes(error.code)) throw error;
    await ensureSub2ApiStepUp();
    return withSub2ApiTwoFactor(operation, attemptsRemaining - 1);
  }
}

function requestAutoMappings(mode) {
  return withSub2ApiTwoFactor(() => api('/api/sub2api/auto-mappings', {
    method: 'POST',
    body: { mode }
  }));
}

function paintAutoMappingPreview(result) {
  const summary = result.summary;
  const rows = result.items.map((item) => {
    const keyCandidates = item.keyCandidates?.map((candidate) => candidate.name).join('、');
    const verification = autoMappingVerificationLabel(item);
    const reason = [AUTO_MAPPING_REASON_LABELS[item.reason] || item.reason, verification]
      .filter(Boolean).join('；');
    let keyLabel = [item.keyName, item.maskedKey].filter(Boolean).join(' · ') || '-';
    const providerFingerprints = item.providerMaskedKeys?.length
      ? item.providerMaskedKeys.join('、')
      : item.providerMaskedKey;
    if (item.baseMaskedKey && providerFingerprints && item.baseMaskedKey !== providerFingerprints) {
      keyLabel = [item.keyName, `基座 ${item.baseMaskedKey} / 监控 ${providerFingerprints}`]
        .filter(Boolean).join(' · ');
    }
    return `<tr>
      <td>${badge(item.status)}</td>
      <td class="primary-cell"><strong>${escapeHtml(item.providerName || '-')}</strong><small>${escapeHtml(reason)}</small></td>
      <td class="primary-cell"><strong>${escapeHtml(item.groupName || '-')}</strong><small>${item.groupId ? `#${item.groupId}` : '-'}</small></td>
      <td class="primary-cell"><strong>${escapeHtml(item.accountName || '-')}</strong><small>${escapeHtml(keyCandidates || keyLabel)}</small></td>
      <td class="primary-cell"><strong>${escapeHtml(item.providerGroupName || item.providerGroupRef || '-')}</strong><small>${integrationRate(item.providerRate)}</small></td>
    </tr>`;
  }).join('');
  $('#auto-mapping-preview').innerHTML = `<div class="status-summary"><span>${badge('pending_create', `待新增 ${summary.pendingCreate}`)}</span><span>${badge('existing', `已存在 ${summary.existing}`)}</span><span>${badge(summary.conflict ? 'conflict' : 'healthy', `冲突 ${summary.conflict}`)}</span><span>${badge(summary.skipped ? 'warning' : 'healthy', `跳过 ${summary.skipped}`)}</span></div>${rows ? `<div class="table-wrap auto-mapping-table"><table><thead><tr><th>结果</th><th>供应商</th><th>Sub2API 分组</th><th>账号 / Key</th><th>供应商分组 / 倍率</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('waypoints', '没有可映射项', '请确认供应商资产已同步且 Sub2API 账号名称可匹配')}`;
  $('button[type="submit"]', $('#auto-mapping-form')).disabled = summary.pendingCreate === 0;
  icons();
}

async function openAutoMappingPreview() {
  const dialog = $('#auto-mapping-dialog');
  const form = $('#auto-mapping-form');
  state.autoMappingPreview = null;
  $('#auto-mapping-error').textContent = '';
  $('#auto-mapping-preview').innerHTML = `<div class="empty"><div><i class="spin" data-lucide="loader-circle"></i><strong>正在生成预览</strong></div></div>`;
  $('button[type="submit"]', form).disabled = true;
  dialog.showModal();
  icons();
  try {
    state.autoMappingPreview = await requestAutoMappings('preview');
    paintAutoMappingPreview(state.autoMappingPreview);
  } catch (error) {
    const message = autoMappingErrorMessage(error);
    $('#auto-mapping-error').textContent = '';
    $('#auto-mapping-preview').innerHTML = emptyState('shield-alert', '无法生成预览', message);
    icons();
  }
}

async function renderIntegrations() {
  const [comparisonData, reconciliationData, checkinData] = await Promise.all([
    withSub2ApiTwoFactor(() => api('/api/sub2api/comparisons')),
    api('/api/reconciliations?limit=100'),
    api('/api/checkins?limit=100')
  ]);
  state.mappings = comparisonData.items;
  state.integrationGroups = comparisonData.groups || [];
  state.sub2apiStatus = comparisonData.status;
  state.reconciliations = reconciliationData.items;
  setTopActions(`<button class="button" data-action="refresh-comparisons" title="刷新基座" aria-label="刷新基座"><i data-lucide="refresh-cw"></i><span>刷新基座</span></button><button class="button primary" data-action="auto-map" title="自动映射" aria-label="自动映射"><i data-lucide="wand-sparkles"></i><span>自动映射</span></button><button class="button" data-action="add-mapping" title="添加映射" aria-label="添加映射"><i data-lucide="plus"></i><span>添加映射</span></button><button class="button danger" data-action="delete-all-mappings" title="删除全部映射" aria-label="删除全部映射" ${state.mappings.length ? '' : 'disabled'}><i data-lucide="trash-2"></i><span>删除全部映射</span></button>`);
  const groupedRows = state.integrationGroups.map(integrationGroupRows).join('');
  const unassigned = comparisonData.unassignedItems?.length
    ? integrationGroupRows({ groupId: 'unassigned', groupName: '未归组', baseRate: null, channels: [], mappingCount: comparisonData.unassignedItems.length, highest: null, items: comparisonData.unassignedItems })
    : '';
  const mappingRows = groupedRows + unassigned;
  const reconciliationRows = state.reconciliations.map((item) => `<tr><td>${escapeHtml(state.mappings.find((mapping) => mapping.id === item.mapping_id)?.provider_name || '-')}</td><td>${badge(item.status)}</td><td>${formatDate(item.period_start)} - ${formatDate(item.period_end)}</td><td class="numeric">${formatNumber(item.upstream_balance_delta)}</td><td class="numeric">${formatNumber(item.expected_cost)}</td><td class="numeric">${formatNumber(item.difference_amount)}</td><td class="numeric">${formatNumber(item.health_score, 0)}</td></tr>`).join('');
  const checkinRows = checkinData.items.map((item) => `<tr><td>${escapeHtml(state.providers.find((p) => p.id === item.connection_id)?.name || '-')}</td><td>${badge(item.status)}</td><td class="numeric">${formatMoney(item.reward_amount, item.currency || 'USD')}</td><td class="numeric">${formatMoney(item.before_balance, item.currency || 'USD')}</td><td class="numeric">${formatMoney(item.after_balance, item.currency || 'USD')}</td><td>${formatDate(item.checked_at)}</td></tr>`).join('');
  const providerCheckins = state.providers.map((provider) => `<tr><td>${escapeHtml(provider.name)}</td><td>${provider.capabilities?.checkIn ? badge('enabled', '支持') : badge('unknown', '未声明')}</td><td class="actions-cell"><button class="button small" data-action="provider-checkin" data-id="${provider.id}"><i data-lucide="calendar-check"></i><span>签到</span></button></td></tr>`).join('');
  const summary = comparisonData.summary;
  const status = comparisonData.status;
  const authLabel = status.authentication?.available
    ? `凭据：${status.authentication.source}`
    : status.authentication?.requiresTwoFactor
      ? '等待 Sub2API 二次验证'
      : '缺少可用管理员凭据';
  $('#main-content').innerHTML = `<section class="base-instance-bar"><div><span class="status-dot ${status.authentication?.available ? 'healthy' : 'warning'}"></span><strong>${escapeHtml(status.publicUrl || status.baseUrl || '未配置基座 Sub2API')}</strong><small>${escapeHtml(authLabel)} · 最近检查 ${escapeHtml(timeAgo(status.lastCheckedAt))}</small></div><div class="status-summary"><span>${badge('aligned', `一致 ${summary.aligned}`)}</span><span>${badge('warning', `预警 ${summary.warning}`)}</span><span>${badge('failed', `错误 ${summary.error}`)}</span><span>${badge('unknown', `待检查 ${summary.unchecked}`)}</span>${integrationSummaryHelp()}</div></section><section class="section"><div class="section-header"><h2>分组与倍率对照</h2><p>${state.integrationGroups.length} 个 Sub2API 分组</p></div><div class="table-wrap integration-table">${mappingRows ? `<table><thead><tr><th>Sub2API 分组</th><th class="numeric" title="Sub2API 基座账号优先级">账号优先级</th><th class="numeric">基座倍率</th><th>最高综合倍率供应商 / Key</th><th>供应商分组 / 倍率</th><th class="numeric" title="支付 1 单位可获得的供应商余额">充值倍率</th><th class="numeric" title="供应商分组倍率 ÷ 充值倍率">综合倍率</th><th class="numeric" title="（基座倍率 - 综合倍率）÷ 综合倍率">综合倍率差</th><th>检查</th><th>映射 / 对账</th><th></th></tr></thead><tbody>${mappingRows}</tbody></table>` : emptyState('waypoints', '暂无 Sub2API 分组', '刷新基座后显示分组与映射关系')}</div></section><section class="section"><div class="section-header"><h2>对账记录</h2></div><div class="table-wrap">${reconciliationRows ? `<table><thead><tr><th>供应商</th><th>结果</th><th>期间</th><th class="numeric">余额减少</th><th class="numeric">预期成本</th><th class="numeric">差异</th><th class="numeric">健康分</th></tr></thead><tbody>${reconciliationRows}</tbody></table>` : emptyState('calculator', '暂无对账记录', '映射创建后可执行对账')}</div></section><section class="section split-layout"><div><div class="section-header"><h2>签到记录</h2></div><div class="table-wrap">${checkinRows ? `<table><thead><tr><th>供应商</th><th>状态</th><th class="numeric">奖励</th><th class="numeric">签到前</th><th class="numeric">签到后</th><th>时间</th></tr></thead><tbody>${checkinRows}</tbody></table>` : emptyState('calendar-check', '暂无签到记录', '支持的供应商可手动或定时签到')}</div></div><div><div class="section-header"><h2>手动签到</h2></div><div class="table-wrap"><table><thead><tr><th>供应商</th><th>能力</th><th></th></tr></thead><tbody>${providerCheckins}</tbody></table></div></div></section>`;
}

async function renderSettings() {
  const [settings, backups, lifecycle, targets, remoteRuns, sub2apiStatus, adminApiKeyStatus] = await Promise.all([
    api('/api/settings'), api('/api/backups'), api('/api/credentials/lifecycle'),
    api('/api/backup-targets'), api('/api/backup-runs?limit=100'), api('/api/sub2api/status'),
    api('/api/sub2api/admin-api-key')
  ]);
  state.settings = settings;
  state.backupTargets = targets.items;
  setTopActions(`<button class="button" data-action="open-import"><i data-lucide="file-input"></i><span>导入</span></button><button class="button" data-action="download" data-url="/api/exports/config" data-filename="provider-monitor-config.json"><i data-lucide="download"></i><span>导出配置</span></button><button class="button primary" data-action="create-backup"><i data-lucide="database-backup"></i><span>在线备份</span></button>`);
  const backupRows = backups.items.map((item) => `<tr><td class="mono">${escapeHtml(item.filename)}</td><td class="numeric">${formatNumber(item.size / 1024 / 1024, 2)} MB</td><td>${formatDate(item.createdAt)}</td></tr>`).join('');
  const lifecycleRows = lifecycle.items.map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.providerName)}</strong><small>${escapeHtml(item.fields.map((field) => field.name).join(', '))}</small></td><td>${badge(item.expiryStatus)}</td><td>${formatDate(item.rotatedAt || item.createdAt)}</td><td>${formatDate(item.expiresAt)}</td><td class="actions-cell"><button class="icon-button small" data-action="rotate-credential" data-id="${item.providerId}" title="轮换凭据" aria-label="轮换凭据"><i data-lucide="rotate-cw"></i></button></td></tr>`).join('');
  const targetRows = targets.items.map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type)} · ${escapeHtml(item.credentialFields.map((field) => field.name).join(', ') || '无凭据')}</small></td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td>${item.lastStatus ? badge(item.lastStatus) : '-'}</td><td>${formatDate(item.lastBackupAt)}</td><td class="actions-cell"><button class="icon-button small" data-action="test-backup-target" data-id="${item.id}" title="测试并上传备份" aria-label="测试并上传备份"><i data-lucide="cloud-upload"></i></button><button class="icon-button small" data-action="edit-backup-target" data-id="${item.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-backup-target" data-id="${item.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></td></tr>`).join('');
  const remoteRunRows = remoteRuns.items.map((item) => `<tr><td>${escapeHtml(item.target_name || '已删除目标')}</td><td>${badge(item.status)}</td><td class="mono">${escapeHtml(item.filename)}</td><td class="numeric">${formatNumber((item.size || 0) / 1024 / 1024, 2)} MB</td><td>${formatDate(item.completed_at || item.created_at)}</td></tr>`).join('');
  const authStatus = sub2apiStatus.authentication?.available ? badge('healthy', sub2apiStatus.authentication.source) : badge('failed', '缺少凭据');
  const securityPanel = state.authentication?.passwordChangeSupported
    ? `<div class="section-header"><h2>管理员安全</h2></div><div class="panel"><div class="panel-body security-setting-row"><div class="security-setting-copy"><strong>本地管理员密码</strong><small>${escapeHtml(state.user?.name || 'admin')} · ${state.authentication.passwordChangedAt ? `最近修改 ${escapeHtml(formatDate(state.authentication.passwordChangedAt))}` : '尚未在网页中修改'}</small></div><button class="button" type="button" data-action="change-password"><i data-lucide="key-round"></i><span>修改密码</span></button></div></div>`
    : '';
  const adminKeySource = adminApiKeyStatus.source === 'stored'
    ? '数据库加密存储'
    : adminApiKeyStatus.source === 'environment'
      ? '环境变量'
      : '未配置';
  const adminKeyCapability = adminApiKeyStatus.capabilities?.accountKeyExport === true
    ? `账号 Key 导出已验证${adminApiKeyStatus.verifiedAt ? ` · ${escapeHtml(formatDate(adminApiKeyStatus.verifiedAt))}` : ''}`
    : adminApiKeyStatus.configured
      ? '尚未验证账号 Key 导出'
      : '定时重建将使用交互式管理员会话';
  const adminApiKeyPanel = `<div class="section-header ${securityPanel ? 'section' : ''}"><h2>Sub2API 管理员 API Key</h2></div><form class="panel" id="sub2api-admin-api-key-form"><div class="panel-header"><div class="primary-cell"><strong>${escapeHtml(adminKeySource)}</strong><small>${escapeHtml(adminApiKeyStatus.maskedKey || '未保存')} · ${adminKeyCapability}</small></div>${badge(adminApiKeyStatus.capabilities?.accountKeyExport === true ? 'healthy' : adminApiKeyStatus.configured ? 'warning' : 'unknown', adminApiKeyStatus.capabilities?.accountKeyExport === true ? '可用于重建' : adminApiKeyStatus.configured ? '待验证' : '未配置')}</div><div class="panel-body"><div class="form-grid"><label class="span-2"><span>管理员 API Key</span><input name="adminApiKey" type="password" minlength="16" maxlength="4096" autocomplete="new-password" placeholder="${adminApiKeyStatus.configured ? '输入新 Key 以替换当前配置' : 'admin-...'}"></label></div><p class="form-hint">Sub2API 必须关闭“敏感操作 step-up 2FA”；该开关已开启时，只能由完成 TOTP 验证的管理员会话关闭。</p><p class="form-error" id="sub2api-admin-api-key-error" role="alert"></p></div><footer class="dialog-actions">${adminApiKeyStatus.source === 'stored' ? '<button class="button danger" type="button" data-action="delete-sub2api-admin-api-key"><i data-lucide="trash-2"></i><span>删除</span></button>' : '<span class="action-spacer"></span>'}<span class="action-spacer"></span><button class="button primary" type="submit"><i data-lucide="shield-check"></i><span>保存并验证</span></button></footer></form>`;
  const systemSettingsPanel = `<section class="section"><form class="panel" id="system-settings-form"><div class="panel-header"><h2>系统参数</h2></div><div class="panel-body"><div class="form-grid">
    <label class="toggle-field"><input name="automationEnabled" type="checkbox" ${settings.automationEnabled ? 'checked' : ''}><span>允许真实自动化</span></label>
    <label class="toggle-field"><input name="allowPrivateNetworks" type="checkbox" ${settings.allowPrivateNetworks ? 'checked' : ''}><span>忽略私网主机限制</span></label>
    <label class="span-2"><span>Provider Monitor 公开地址</span><input name="providerMonitorPublicUrl" type="url" placeholder="https://monitor.example.com" value="${escapeHtml(settings.providerMonitorPublicUrl || '')}"></label>
    <label><span>充值入口有效期（分钟）</span><input name="rechargeLinkTtlMinutes" type="number" min="5" max="1440" value="${settings.rechargeLinkTtlMinutes || 60}"></label>
    <label class="span-2"><span>浏览器 Origin</span><textarea name="allowedOrigins" rows="3">${escapeHtml((settings.allowedOrigins || []).join('\n'))}</textarea></label>
    <label class="span-2"><span>私网主机限制（留空则全部放行）</span><textarea name="allowedHosts" rows="3">${escapeHtml((settings.allowedHosts || []).join('\n'))}</textarea></label>
    <label><span>会话时长（分钟）</span><input name="sessionTtlMinutes" type="number" min="15" max="1440" value="${settings.sessionTtlMinutes}"></label>
    <label><span>请求超时（毫秒）</span><input name="queryTimeoutMs" type="number" min="1000" max="120000" step="1000" value="${settings.queryTimeoutMs}"></label>
    <label><span>响应上限（MB）</span><input name="maxResponseMb" type="number" min="0.01" max="20" step="0.25" value="${formatNumber(settings.maxResponseBytes / 1024 / 1024, 2)}"></label>
    <label><span>新供应商刷新（分钟）</span><input name="defaultRefreshMinutes" type="number" min="1" max="1440" value="${settings.defaultRefreshMinutes}"></label>
    <label><span>数据陈旧（分钟）</span><input name="staleAfterMinutes" type="number" min="5" max="10080" value="${settings.staleAfterMinutes}"></label>
    <label><span>Key 检测并发</span><input name="keyHealthConcurrency" type="number" min="1" max="10" value="${settings.keyHealthConcurrency}"></label>
    <label><span>原始快照保留（天）</span><input name="rawSnapshotRetentionDays" type="number" min="1" max="3650" value="${settings.rawSnapshotRetentionDays}"></label>
    <label><span>聚合快照保留（天）</span><input name="snapshotRetentionDays" type="number" min="1" max="3650" value="${settings.snapshotRetentionDays}"></label>
    <label><span>任务记录保留（天）</span><input name="jobRetentionDays" type="number" min="1" max="3650" value="${settings.jobRetentionDays}"></label>
    <label><span>审计记录保留（天）</span><input name="auditRetentionDays" type="number" min="1" max="3650" value="${settings.auditRetentionDays}"></label>
    <label><span>通知记录保留（天）</span><input name="notificationRetentionDays" type="number" min="1" max="3650" value="${settings.notificationRetentionDays}"></label>
    <label><span>配置漂移保留（天）</span><input name="assetChangeRetentionDays" type="number" min="1" max="3650" value="${settings.assetChangeRetentionDays}"></label>
  </div></div><footer class="dialog-actions"><span class="action-spacer"></span><button class="button primary" type="button" data-action="save-system-settings"><i data-lucide="save"></i><span>保存系统参数</span></button></footer></form></section>`;
  $('#main-content').innerHTML = `<section class="base-instance-bar"><div><span class="status-dot ${sub2apiStatus.authentication?.available ? 'healthy' : 'warning'}"></span><strong>基座 Sub2API</strong><small>${escapeHtml(sub2apiStatus.publicUrl || sub2apiStatus.baseUrl || '未配置')} · 最近检查 ${escapeHtml(timeAgo(sub2apiStatus.lastCheckedAt))}</small></div><div>${authStatus}</div></section><div class="split-layout"><form class="panel" id="settings-form"><div class="panel-header"><h2>运行设置</h2></div><div class="form-grid"><label><span>显示币种</span><input name="displayCurrency" value="${escapeHtml(settings.displayCurrency)}"></label><label><span>预测最短跨度（小时）</span><input name="forecastMinSpanHours" type="number" min="1" value="${settings.forecastMinSpanHours}"></label><label><span>对账容差</span><input name="reconciliationToleranceRatio" type="number" min="0" step="0.01" value="${settings.reconciliationToleranceRatio}"></label><label><span>综合倍率偏差容差</span><input name="sub2apiRateToleranceRatio" type="number" min="0" step="0.01" value="${settings.sub2apiRateToleranceRatio}"></label><label><span>价格刷新（小时）</span><input name="catalogRefreshHours" type="number" min="1" value="${settings.catalogRefreshHours}"></label><label><span>异常跌幅（%）</span><input name="anomalyDropPercent" type="number" min="1" value="${settings.anomalyDropPercent}"></label><label><span>异常突增倍数</span><input name="anomalySpikeMultiplier" type="number" min="1" step="0.1" value="${settings.anomalySpikeMultiplier}"></label><label class="span-2"><span>汇率（JSON）</span><textarea name="currencyRates" rows="4">${escapeHtml(JSON.stringify(settings.currencyRates, null, 2))}</textarea></label><label class="span-2"><span>官方模型单价（USD / 1M，JSON）</span><textarea name="officialModelPrices" rows="10">${escapeHtml(JSON.stringify(settings.officialModelPrices || {}, null, 2))}</textarea></label></div><footer class="dialog-actions"><span class="action-spacer"></span><button class="button primary" type="submit"><i data-lucide="save"></i><span>保存设置</span></button></footer></form><div>${securityPanel}${adminApiKeyPanel}<div class="section-header section"><h2>数据导出</h2></div><div class="panel"><div class="panel-body action-grid"><button class="button" data-action="download" data-url="/api/exports/balances.csv" data-filename="provider-monitor-balances.csv"><i data-lucide="wallet-cards"></i><span>余额 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/usage.csv" data-filename="provider-monitor-usage.csv"><i data-lucide="activity"></i><span>用量 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/alerts.csv" data-filename="provider-monitor-alerts.csv"><i data-lucide="bell"></i><span>告警 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/env" data-filename="provider-monitor-import.env"><i data-lucide="file-code-2"></i><span>环境变量模板</span></button><button class="button" data-action="export-disaster"><i data-lucide="lock-keyhole"></i><span>加密灾备包</span></button></div></div><div class="section-header section"><h2>SQLite 备份</h2></div><div class="table-wrap">${backupRows ? `<table><thead><tr><th>文件</th><th class="numeric">大小</th><th>时间</th></tr></thead><tbody>${backupRows}</tbody></table>` : emptyState('database-backup', '暂无备份', '创建在线一致性备份')}</div></div></div><section class="section"><div class="section-header"><h2>远端备份目标</h2><div class="section-actions"><button class="button small" data-action="run-remote-backups"><i data-lucide="cloud-upload"></i><span>立即备份</span></button><button class="button small primary" data-action="add-backup-target"><i data-lucide="plus"></i><span>添加目标</span></button></div></div><div class="table-wrap">${targetRows ? `<table><thead><tr><th>目标</th><th>状态</th><th>最近结果</th><th>最近备份</th><th></th></tr></thead><tbody>${targetRows}</tbody></table>` : emptyState('cloud-upload', '暂无远端目标', '添加本地目录、WebDAV 或 S3 兼容目标')}</div></section><section class="section"><div class="section-header"><h2>远端备份记录</h2></div><div class="table-wrap">${remoteRunRows ? `<table><thead><tr><th>目标</th><th>状态</th><th>文件</th><th class="numeric">大小</th><th>时间</th></tr></thead><tbody>${remoteRunRows}</tbody></table>` : emptyState('history', '暂无远端备份记录', '执行远端备份后显示')}</div></section><section class="section"><div class="section-header"><h2>凭据生命周期</h2></div><div class="table-wrap">${lifecycleRows ? `<table><thead><tr><th>供应商 / 字段</th><th>到期状态</th><th>最近轮换</th><th>凭据到期</th><th></th></tr></thead><tbody>${lifecycleRows}</tbody></table>` : emptyState('key-round', '暂无凭据', '添加供应商后显示')}</div></section>`;
  $('.split-layout', $('#main-content')).insertAdjacentHTML('afterend', systemSettingsPanel);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#sub2api-admin-api-key-form').addEventListener('submit', saveSub2ApiAdminApiKey);
  $('#system-settings-form').addEventListener('submit', saveSystemSettings);
}

function openBackupTarget(target = null) {
  const form = $('#backup-target-form'); form.reset();
  form.elements.id.value = target?.id || '';
  form.elements.name.value = target?.name || '';
  form.elements.type.value = target?.type || 'local';
  form.elements.config.value = JSON.stringify(target?.config || {}, null, 2);
  form.elements.credentials.value = '{}';
  form.elements.enabled.checked = target?.enabled ?? true;
  $('#backup-target-form-error').textContent = '';
  $('#backup-target-dialog').showModal(); icons();
}

function parseOfficialModelPrices(value) {
  let prices;
  try { prices = JSON.parse(value || '{}'); } catch { throw new Error('官方模型单价不是有效 JSON'); }
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    throw new Error('官方模型单价必须是模型到价格对象的 JSON 映射');
  }
  for (const [key, entry] of Object.entries(prices)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`模型 ${key} 的官方单价必须是对象`);
    }
    const input = entry.inputPerMillion ?? entry.input;
    const output = entry.outputPerMillion ?? entry.output;
    const cachedInput = entry.cacheReadPerMillion ?? entry.cachedInputPerMillion ??
      entry.cacheRead ?? entry.cachedInput;
    const values = [input, output, cachedInput].filter((item) => item != null && item !== '');
    const model = String(entry.model || entry.officialModel || '').trim();
    if (values.length === 0 && !model) throw new Error(`模型 ${key} 需要填写单价或目标模型`);
    if ([input, output].some((item) => item != null && item !== '' && (!Number.isFinite(Number(item)) || Number(item) <= 0))) {
      throw new Error(`模型 ${key} 的输入和输出单价必须大于 0`);
    }
    if (cachedInput != null && cachedInput !== '' && (!Number.isFinite(Number(cachedInput)) || Number(cachedInput) < 0)) {
      throw new Error(`模型 ${key} 的缓存单价不能小于 0`);
    }
  }
  return prices;
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: {
      displayCurrency: form.elements.displayCurrency.value.trim() || 'USD',
      forecastMinSpanHours: Number(form.elements.forecastMinSpanHours.value),
      reconciliationToleranceRatio: Number(form.elements.reconciliationToleranceRatio.value),
      sub2apiRateToleranceRatio: Number(form.elements.sub2apiRateToleranceRatio.value),
      catalogRefreshHours: Number(form.elements.catalogRefreshHours.value),
      anomalyDropPercent: Number(form.elements.anomalyDropPercent.value),
      anomalySpikeMultiplier: Number(form.elements.anomalySpikeMultiplier.value),
      currencyRates: JSON.parse(form.elements.currencyRates.value || '{}'),
      officialModelPrices: parseOfficialModelPrices(form.elements.officialModelPrices.value)
    } });
    state.settings = settings;
    toast('设置已保存');
  } catch (error) { toast(error.message, 'error'); }
}

function sub2apiAdminApiKeyErrorMessage(error) {
  if (error?.code === 'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN') {
    return 'Sub2API 已开启敏感操作 step-up 2FA，管理员 API Key 被禁止导出账号 Key。请先用完成 TOTP 验证的 Sub2API 管理员会话关闭该开关。';
  }
  if (error?.code === 'SUB2API_REQUEST_FAILED' && error?.details?.remoteCode === 'INVALID_ADMIN_KEY') {
    return '管理员 API Key 无效或已被重新生成。';
  }
  return error.message;
}

async function saveSub2ApiAdminApiKey(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorElement = $('#sub2api-admin-api-key-error');
  errorElement.textContent = '';
  try {
    const adminApiKey = form.elements.adminApiKey.value.trim();
    if (!adminApiKey) throw new Error('请输入管理员 API Key');
    await ensureReauth();
    const result = await api('/api/sub2api/admin-api-key', {
      method: 'PUT',
      body: { adminApiKey }
    });
    form.reset();
    toast(`管理员 API Key 已保存，已验证 ${result.verification?.groupCount || 0} 个 Sub2API 分组`);
    await navigate('settings');
  } catch (error) {
    const message = sub2apiAdminApiKeyErrorMessage(error);
    errorElement.textContent = message;
    toast(message, 'error');
  }
}

function parseSettingsList(value) {
  return [...new Set(String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

async function saveSystemSettings(eventOrForm) {
  eventOrForm?.preventDefault?.();
  const form = eventOrForm?.currentTarget || eventOrForm;
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: {
      automationEnabled: form.elements.automationEnabled.checked,
      allowPrivateNetworks: form.elements.allowPrivateNetworks.checked,
      providerMonitorPublicUrl: form.elements.providerMonitorPublicUrl.value.trim(),
      rechargeLinkTtlMinutes: Number(form.elements.rechargeLinkTtlMinutes.value),
      allowedOrigins: parseSettingsList(form.elements.allowedOrigins.value),
      allowedHosts: parseSettingsList(form.elements.allowedHosts.value),
      sessionTtlMinutes: Number(form.elements.sessionTtlMinutes.value),
      queryTimeoutMs: Number(form.elements.queryTimeoutMs.value),
      maxResponseBytes: Math.round(Number(form.elements.maxResponseMb.value) * 1024 * 1024),
      defaultRefreshMinutes: Number(form.elements.defaultRefreshMinutes.value),
      staleAfterMinutes: Number(form.elements.staleAfterMinutes.value),
      keyHealthConcurrency: Number(form.elements.keyHealthConcurrency.value),
      rawSnapshotRetentionDays: Number(form.elements.rawSnapshotRetentionDays.value),
      snapshotRetentionDays: Number(form.elements.snapshotRetentionDays.value),
      jobRetentionDays: Number(form.elements.jobRetentionDays.value),
      auditRetentionDays: Number(form.elements.auditRetentionDays.value),
      notificationRetentionDays: Number(form.elements.notificationRetentionDays.value),
      assetChangeRetentionDays: Number(form.elements.assetChangeRetentionDays.value)
    } });
    state.settings = settings;
    toast('系统参数已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function renderTrends() {
  const connectionId = state.providers[0]?.id || '';
  setTopActions(`<button class="button" data-action="refresh-trends"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  $('#main-content').innerHTML = `<div class="filter-bar"><select id="trend-provider">${state.providers.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select><select id="trend-days"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option><option value="365">365 天</option></select><select id="trend-currency"><option value="USD">USD</option><option value="CNY">CNY</option><option value="EUR">EUR</option></select></div><div class="split-layout"><div class="panel"><div class="panel-header"><h2>可用余额</h2></div><div id="trend-chart" class="chart"></div></div><div class="panel"><div class="panel-header"><h2>消耗预测</h2></div><div class="panel-body" id="forecast-panel"></div></div></div>`;
  if (!connectionId) {
    $('#trend-chart').innerHTML = emptyState('chart-no-axes-combined', '暂无数据', '先添加供应商');
    return;
  }
  await loadTrend();
}

async function loadTrend() {
  const connectionId = $('#trend-provider')?.value;
  if (!connectionId) return;
  const days = $('#trend-days').value;
  const currency = $('#trend-currency').value;
  const [history, forecast] = await Promise.all([
    api(`/api/history?connectionId=${encodeURIComponent(connectionId)}&days=${days}&currency=${encodeURIComponent(currency)}`),
    api(`/api/forecast/${connectionId}?days=${days}&currency=${encodeURIComponent(currency)}`)
  ]);
  const chartElement = $('#trend-chart');
  state.chart?.dispose();
  state.chart = window.echarts.init(chartElement);
  state.chart.setOption({
    animationDuration: 350,
    color: ['#147d64'],
    grid: { left: 58, right: 24, top: 28, bottom: 48 },
    tooltip: { trigger: 'axis', valueFormatter: (value) => formatMoney(value, currency) },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: '#c7cec9' } }, axisLabel: { color: '#667069' } },
    yAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: '#e5e9e6' } }, axisLabel: { color: '#667069' } },
    series: [{ name: '可用余额', type: 'line', smooth: false, symbol: 'none', lineStyle: { width: 2 }, areaStyle: { color: 'rgba(20,125,100,.10)' }, data: history.items.map((row) => [row.captured_at, row.available]) }]
  });
  $('#forecast-panel').innerHTML = `<div class="currency-list"><div class="currency-row"><span>当前余额</span><strong>${formatMoney(forecast.currentAvailable, currency)}</strong></div><div class="currency-row"><span>日均消耗</span><strong>${forecast.dailyBurn == null ? '-' : formatMoney(forecast.dailyBurn, currency)}</strong></div><div class="currency-row"><span>预计可用</span><strong>${forecast.runwayDays == null ? '-' : `${formatNumber(forecast.runwayDays, 1)} 天`}</strong></div><div class="currency-row"><span>样本</span><strong>${forecast.sampleCount || history.items.length}</strong></div><div class="currency-row"><span>可信度</span>${badge(forecast.confidence === 'medium' ? 'healthy' : 'unknown', forecast.confidence === 'medium' ? '中等' : '较低')}</div></div>`;
}

const GROSS_PROFIT_DIMENSION_LABELS = {
  provider: '上游供应商',
  key: 'Key',
  account: '账号'
};

const GROSS_PROFIT_GRANULARITY_LABELS = {
  day: '每天',
  week: '每周',
  month: '每月'
};

const GROSS_PROFIT_ACCOUNTING_MODE_LABELS = {
  standard: '标准毛利',
  exclude_admin: '排除管理员用户账本',
  admin_expense: '管理员消费计入费用（纯毛利）'
};

const GROSS_PROFIT_ACCOUNTING_MODE_NOTES = {
  standard: '标准口径：沿用现有归因规则，包含已归因的全部用户账本',
  exclude_admin: '经营口径：排除管理员用户 #1 的基座消费账本',
  admin_expense: '纯毛利口径：先排除管理员用户 #1 的基座消费，再将其消费金额作为费用扣除'
};

function grossProfitDisplayValue(item) {
  if (!item) return null;
  return item.grossProfit ?? item.estimatedGrossProfit ?? item.provisionalGrossProfit ?? null;
}

function grossProfitAmount(item, currency) {
  const value = grossProfitDisplayValue(item);
  if (value == null) return '-';
  const prefix = item.status === 'estimated' ? '约 ' : item.status === 'partial' ? '暂计 ' : '';
  return `${prefix}${formatPreciseMoney(value, currency)}`;
}

function grossProfitTone(item) {
  const value = grossProfitDisplayValue(item);
  if (value == null) return 'neutral';
  return Number(value) < 0 ? 'negative' : Number(value) > 0 ? 'positive' : 'neutral';
}

function grossProfitStatus(item) {
  return ({
    complete: badge('healthy', '已核算'),
    estimated: badge('warning', '倍率估算'),
    partial: badge('failed', '数据不完整'),
    empty: badge('info', '无账本')
  })[item?.status] || badge('unknown');
}

function grossProfitMargin(item) {
  if (!item || !(Number(item.revenue) > 0)) return '-';
  const ratio = item.grossMarginRatio ?? (
    grossProfitDisplayValue(item) == null
      ? null
      : Number(grossProfitDisplayValue(item)) / Number(item.revenue)
  );
  if (!Number.isFinite(ratio)) return '-';
  return `${item.status === 'complete' ? '' : '约 '}${formatPercent(ratio * 100)}`;
}

function grossProfitNotes(summary, currency, accountingMode = 'standard') {
  const notes = [];
  if (accountingMode !== 'standard' && summary.unknownRequesterUserRequestCount > 0) {
    notes.push(`${formatNumber(summary.unknownRequesterUserRequestCount, 0)} 笔基座账本缺少请求用户 ID，管理员口径暂不完整；请在“账号质量”执行一次同步完成历史回补`);
  }
  if (accountingMode === 'admin_expense') {
    notes.push(`管理员消费支出 ${formatPreciseMoney(summary.administratorExpense || 0, currency)}，已从经营毛利中扣除`);
  }
  if (summary.unconfirmedCostRequests > 0) {
    notes.push(`${formatNumber(summary.unconfirmedCostRequests, 0)} 笔上游成本使用待确认倍率`);
  }
  const missing = Number(summary.missingRevenueRequests || 0) +
    Number(summary.missingCostRequests || 0) +
    Number(summary.missingAdministratorExpenseRequests || 0);
  if (missing > 0) notes.push(`${formatNumber(missing, 0)} 笔账目缺少金额`);
  if (summary.unconvertedCurrencies?.length) {
    notes.push(`${summary.unconvertedCurrencies.join('、')} 缺少到 ${currency} 的汇率`);
  }
  if (summary.unattributedBaseRequestCount > 0) {
    notes.push(`${formatNumber(summary.unattributedBaseRequestCount, 0)} 笔基座收入未归属供应商`);
  }
  if (summary.unattributedUpstreamRequestCount > 0) {
    notes.push(`${formatNumber(summary.unattributedUpstreamRequestCount, 0)} 笔上游成本未归属当前维度`);
  }
  if (summary.unattributedAdministratorRequestCount > 0) {
    notes.push(`${formatNumber(summary.unattributedAdministratorRequestCount, 0)} 笔管理员消费无法归属当前维度`);
  }
  if (summary.maximumPrecisionSeconds > 0) {
    const minutes = Math.max(1, Math.ceil(summary.maximumPrecisionSeconds / 60));
    notes.push(`累计计数器最高入账精度 ${formatNumber(minutes, 0)} 分钟`);
  }
  if (summary.entityResultsTruncated) {
    notes.push(`维度汇总显示毛利绝对值最高的 ${formatNumber(summary.returnedEntityCount, 0)} 项`);
  }
  return notes;
}

function grossProfitPagination(totalItems) {
  if (!totalItems) return '';
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(totalPages, Math.max(1, state.grossProfitDetailPage));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalItems, page * pageSize);
  return `<footer class="table-pagination" aria-label="毛利明细分页"><span class="pagination-summary">第 ${start}–${end} 条，共 ${totalItems} 条</span><div class="pagination-actions"><button class="icon-button small" data-action="gross-profit-page" data-page="1" title="第一页" aria-label="第一页" ${page <= 1 ? 'disabled' : ''}><i data-lucide="chevrons-left"></i></button><button class="icon-button small" data-action="gross-profit-page" data-page="${page - 1}" title="上一页" aria-label="上一页" ${page <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button><span class="pagination-position" aria-live="polite">${page} / ${totalPages}</span><button class="icon-button small" data-action="gross-profit-page" data-page="${page + 1}" title="下一页" aria-label="下一页" ${page >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button><button class="icon-button small" data-action="gross-profit-page" data-page="${totalPages}" title="最后一页" aria-label="最后一页" ${page >= totalPages ? 'disabled' : ''}><i data-lucide="chevrons-right"></i></button></div></footer>`;
}

function grossProfitDetailRows(report) {
  const pageSize = 50;
  const showAdministratorExpense = report.query.accountingMode === 'admin_expense';
  const totalPages = Math.max(1, Math.ceil(report.items.length / pageSize));
  state.grossProfitDetailPage = Math.min(totalPages, Math.max(1, state.grossProfitDetailPage));
  const offset = (state.grossProfitDetailPage - 1) * pageSize;
  return report.items.slice(offset, offset + pageSize).map((item) => {
    const provider = item.providerNames?.join(' / ') || '-';
    const administratorExpense = showAdministratorExpense
      ? `<td class="numeric">${escapeHtml(formatPreciseMoney(item.administratorExpense || 0, report.query.currency))}</td>`
      : '';
    return `<tr><td class="primary-cell"><strong>${escapeHtml(item.periodLabel)}</strong><small>${escapeHtml(GROSS_PROFIT_GRANULARITY_LABELS[report.query.granularity])}</small></td><td class="primary-cell"><strong>${escapeHtml(item.entityName)}</strong><small>${escapeHtml(provider)}</small></td><td class="numeric">${escapeHtml(formatPreciseMoney(item.revenue, report.query.currency))}</td><td class="numeric">${escapeHtml(formatPreciseMoney(item.upstreamCost, report.query.currency))}</td>${administratorExpense}<td class="numeric gross-profit-value ${grossProfitTone(item)}"><strong>${escapeHtml(grossProfitAmount(item, report.query.currency))}</strong><small>${escapeHtml(grossProfitMargin(item))}</small></td><td>${grossProfitStatus(item)}</td></tr>`;
  }).join('');
}

function paintGrossProfitChart(report) {
  state.chart?.dispose?.();
  state.chart = null;
  const chartRoot = $('#gross-profit-chart');
  if (!chartRoot || !window.echarts || report.periods.length === 0) return;
  const currency = report.query.currency;
  const labels = report.periods.map((period) => period.periodLabel);
  const showAdministratorExpense = report.query.accountingMode === 'admin_expense';
  const profitLabel = showAdministratorExpense ? '纯毛利' : '毛利';
  const legend = [profitLabel, '基座收入', '上游成本'];
  if (showAdministratorExpense) legend.push('管理员消费支出');
  state.chart = window.echarts.init(chartRoot);
  state.chart.setOption({
    animationDuration: 300,
    color: ['#147d64', '#2f6fba', '#b66a16', '#b94a48'],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) => formatPreciseMoney(value, currency)
    },
    legend: { top: 10, data: legend },
    grid: { left: 72, right: 28, top: 54, bottom: 58 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#667069', hideOverlap: true },
      axisLine: { lineStyle: { color: '#c7cec9' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#667069' },
      splitLine: { lineStyle: { color: '#e5e9e6' } }
    },
    series: [
      {
        name: profitLabel,
        type: 'bar',
        barMaxWidth: 32,
        data: report.periods.map((period) => ({
          value: grossProfitDisplayValue(period),
          itemStyle: { color: grossProfitTone(period) === 'negative' ? '#b94a48' : '#147d64' }
        }))
      },
      {
        name: '基座收入',
        type: 'line',
        showSymbol: report.periods.length <= 12,
        symbolSize: 6,
        lineStyle: { width: 2 },
        data: report.periods.map((period) => period.revenue)
      },
      {
        name: '上游成本',
        type: 'line',
        showSymbol: report.periods.length <= 12,
        symbolSize: 6,
        lineStyle: { width: 2 },
        data: report.periods.map((period) => period.upstreamCost)
      },
      ...(showAdministratorExpense ? [{
        name: '管理员消费支出',
        type: 'line',
        showSymbol: report.periods.length <= 12,
        symbolSize: 6,
        lineStyle: { width: 2, type: 'dashed' },
        data: report.periods.map((period) => period.administratorExpense || 0)
      }] : [])
    ]
  });
}

function paintGrossProfit(report) {
  const filters = state.grossProfitFilters;
  const summary = report.summary;
  const currency = report.query.currency;
  const accountingMode = report.query.accountingMode || 'standard';
  const showAdministratorExpense = accountingMode === 'admin_expense';
  const accountingModeLabel = GROSS_PROFIT_ACCOUNTING_MODE_LABELS[accountingMode] || accountingMode;
  const providers = report.filterOptions.providers.map((provider) => (
    `<option value="${escapeHtml(provider.id)}" ${filters.connectionId === provider.id ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`
  )).join('');
  const currencies = report.filterOptions.currencies.filter((item) => item.convertible).map((item) => (
    `<option value="${escapeHtml(item.currency)}" ${currency === item.currency ? 'selected' : ''}>${escapeHtml(item.currency)}</option>`
  )).join('');
  const accountingModes = Object.entries(GROSS_PROFIT_ACCOUNTING_MODE_LABELS).map(([value, label]) => (
    `<option value="${value}" ${accountingMode === value ? 'selected' : ''}>${escapeHtml(label)}</option>`
  )).join('');
  const dimensionButtons = Object.entries(GROSS_PROFIT_DIMENSION_LABELS).map(([value, label]) => (
    `<button class="tab ${filters.dimension === value ? 'active' : ''}" data-action="gross-profit-dimension" data-dimension="${value}" role="tab" aria-selected="${filters.dimension === value}" tabindex="${filters.dimension === value ? '0' : '-1'}">${escapeHtml(label)}</button>`
  )).join('');
  const granularityButtons = Object.entries(GROSS_PROFIT_GRANULARITY_LABELS).map(([value, label]) => (
    `<button class="tab ${filters.granularity === value ? 'active' : ''}" data-action="gross-profit-granularity" data-granularity="${value}" role="tab" aria-selected="${filters.granularity === value}" tabindex="${filters.granularity === value ? '0' : '-1'}">${escapeHtml(label)}</button>`
  )).join('');
  const summaryMargin = grossProfitMargin(summary);
  const notes = [
    GROSS_PROFIT_ACCOUNTING_MODE_NOTES[accountingMode],
    ...grossProfitNotes(summary, currency, accountingMode)
  ].filter(Boolean);
  const profitLabel = showAdministratorExpense ? '纯毛利' : '毛利';
  const marginLabel = showAdministratorExpense ? '纯毛利率' : '毛利率';
  const costLabel = showAdministratorExpense ? '总成本' : '上游成本';
  const costValue = showAdministratorExpense ? summary.totalCost : summary.upstreamCost;
  const costDetail = showAdministratorExpense
    ? `上游 ${formatPreciseMoney(summary.upstreamCost, currency)} + 管理员消费 ${formatPreciseMoney(summary.administratorExpense || 0, currency)}`
    : `${formatNumber(summary.upstreamRequestCount, 0)} 笔计费请求`;
  const administratorHeader = showAdministratorExpense ? '<th class="numeric">管理员消费支出</th>' : '';
  const entityRows = report.entities.map((entity) => {
    const provider = entity.providerNames?.join(' / ') || '-';
    const administratorExpense = showAdministratorExpense
      ? `<td class="numeric">${escapeHtml(formatPreciseMoney(entity.administratorExpense || 0, currency))}</td>`
      : '';
    return `<tr><td class="primary-cell"><strong>${escapeHtml(entity.entityName)}</strong><small>${escapeHtml(provider)}</small></td><td class="numeric">${escapeHtml(formatPreciseMoney(entity.revenue, currency))}</td><td class="numeric">${escapeHtml(formatPreciseMoney(entity.upstreamCost, currency))}</td>${administratorExpense}<td class="numeric gross-profit-value ${grossProfitTone(entity)}"><strong>${escapeHtml(grossProfitAmount(entity, currency))}</strong></td><td class="numeric">${escapeHtml(grossProfitMargin(entity))}</td><td class="numeric">${formatNumber(entity.baseRequestCount, 0)} / ${formatNumber(entity.upstreamRequestCount, 0)}</td><td>${grossProfitStatus(entity)}</td></tr>`;
  }).join('');
  const detailRows = grossProfitDetailRows(report);
  $('#main-content').innerHTML = `
    <section class="gross-profit-controls" aria-label="毛利统计筛选">
      <div class="gross-profit-mode"><span>统计维度</span><div class="tabs gross-profit-segmented" role="tablist" aria-label="统计维度">${dimensionButtons}</div></div>
      <div class="gross-profit-mode"><span>时间粒度</span><div class="tabs gross-profit-segmented" role="tablist" aria-label="时间粒度">${granularityButtons}</div></div>
      <label class="gross-profit-provider-field"><span>供应商</span><select id="gross-profit-provider"><option value="">全部供应商</option>${providers}</select></label>
      <label><span>开始日期</span><input id="gross-profit-from" type="date" value="${escapeHtml(filters.from)}"></label>
      <label><span>结束日期</span><input id="gross-profit-to" type="date" value="${escapeHtml(filters.to)}"></label>
      <div class="gross-profit-currency-mode"><label class="gross-profit-currency-field"><span>折算币种</span><select id="gross-profit-currency">${currencies}</select></label><label class="gross-profit-accounting-mode-field"><span>统计模式</span><select id="gross-profit-accounting-mode">${accountingModes}</select></label></div>
    </section>
    <div class="stats-grid gross-profit-stats">
      <div class="stat"><span class="stat-label"><i data-lucide="chart-column-increasing"></i>${escapeHtml(profitLabel)}</span><strong class="stat-value gross-profit-summary-value ${grossProfitTone(summary)}">${escapeHtml(grossProfitAmount(summary, currency))}</strong><span class="stat-detail">${grossProfitStatus(summary)}</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="circle-arrow-up"></i>基座收入</span><strong class="stat-value">${escapeHtml(formatPreciseMoney(summary.revenue, currency))}</strong><span class="stat-detail">${formatNumber(summary.baseRequestCount, 0)} 笔计费请求</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="circle-arrow-down"></i>${escapeHtml(costLabel)}</span><strong class="stat-value">${escapeHtml(formatPreciseMoney(costValue, currency))}</strong><span class="stat-detail">${escapeHtml(costDetail)}</span></div>
      <div class="stat"><span class="stat-label"><i data-lucide="percent"></i>${escapeHtml(marginLabel)}</span><strong class="stat-value">${escapeHtml(summaryMargin)}</strong><span class="stat-detail">${formatNumber(summary.profitablePeriodCount, 0)} 个盈利周期 · ${formatNumber(summary.lossPeriodCount, 0)} 个亏损周期</span></div>
    </div>
    <div class="gross-profit-status ${summary.status}"><div>${grossProfitStatus(summary)}<strong>${escapeHtml(report.query.from)} 至 ${escapeHtml(report.query.to)}</strong><span>${escapeHtml(report.query.timezone)} · ${escapeHtml(GROSS_PROFIT_GRANULARITY_LABELS[report.query.granularity])} · ${escapeHtml(accountingModeLabel)}</span></div>${notes.length ? `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : '<span>账本金额与维度归因完整</span>'}</div>
    <section class="panel gross-profit-chart-panel"><div class="panel-header"><h2>${escapeHtml(profitLabel)}时间线</h2><span class="stat-detail">${formatNumber(summary.activePeriodCount, 0)} / ${formatNumber(summary.periodCount, 0)} 个周期有账本</span></div><div class="chart gross-profit-chart" id="gross-profit-chart"></div></section>
    <section class="section"><div class="section-header"><div><h2>${escapeHtml(GROSS_PROFIT_DIMENSION_LABELS[report.query.dimension])}汇总</h2><p>${formatNumber(summary.entityCount, 0)} 个统计对象</p></div></div><div class="table-wrap gross-profit-table${showAdministratorExpense ? ' has-admin-expense' : ''}">${entityRows ? `<table><thead><tr><th>${escapeHtml(GROSS_PROFIT_DIMENSION_LABELS[report.query.dimension])}</th><th class="numeric">基座收入</th><th class="numeric">上游成本</th>${administratorHeader}<th class="numeric">${escapeHtml(profitLabel)}</th><th class="numeric">${escapeHtml(marginLabel)}</th><th class="numeric">请求（基座 / 上游）</th><th>口径</th></tr></thead><tbody>${entityRows}</tbody></table>` : emptyState('chart-column-increasing', '暂无维度数据', '所选期间没有可归因账本')}</div></section>
    <section class="section"><div class="section-header"><div><h2>周期明细</h2><p>${escapeHtml(GROSS_PROFIT_GRANULARITY_LABELS[report.query.granularity])} × ${escapeHtml(GROSS_PROFIT_DIMENSION_LABELS[report.query.dimension])}</p></div></div><div class="table-wrap gross-profit-table${showAdministratorExpense ? ' has-admin-expense' : ''}">${detailRows ? `<table><thead><tr><th>周期</th><th>${escapeHtml(GROSS_PROFIT_DIMENSION_LABELS[report.query.dimension])}</th><th class="numeric">基座收入</th><th class="numeric">上游成本</th>${administratorHeader}<th class="numeric">${escapeHtml(profitLabel)} / ${escapeHtml(marginLabel)}</th><th>口径</th></tr></thead><tbody>${detailRows}</tbody></table>` : emptyState('calendar-x', '暂无周期明细', '所选期间没有可归因账本')}</div>${grossProfitPagination(report.items.length)}</section>`;
  paintGrossProfitChart(report);
  icons();
}

async function loadGrossProfit() {
  const filters = state.grossProfitFilters;
  const search = new URLSearchParams({
    dimension: filters.dimension,
    granularity: filters.granularity,
    accountingMode: filters.accountingMode || 'standard'
  });
  if (filters.connectionId) search.set('connectionId', filters.connectionId);
  if (filters.from) search.set('from', filters.from);
  if (filters.to) search.set('to', filters.to);
  if (filters.currency) search.set('currency', filters.currency);
  const report = await api(`/api/gross-profit?${search}`);
  state.grossProfit = report;
  state.grossProfitFilters = {
    dimension: report.query.dimension,
    granularity: report.query.granularity,
    connectionId: report.query.connectionId || '',
    from: report.query.from,
    to: report.query.to,
    currency: report.query.currency,
    accountingMode: report.query.accountingMode || 'standard'
  };
  paintGrossProfit(report);
}

async function renderGrossProfit() {
  setTopActions(`<button class="button" data-action="refresh-gross-profit" title="刷新毛利统计"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  await loadGrossProfit();
}

async function renderAutomation() {
  const [alertRules, automationRules, events, channels, actions, mappings] = await Promise.all([
    api('/api/alert-rules'),
    api('/api/automation-rules'),
    api('/api/alerts'),
    api('/api/notification-channels'),
    api('/api/automation-actions'),
    api('/api/mappings')
  ]);
  const rules = normalizeUnifiedRules(alertRules.items, automationRules.items);
  state.alertRules = rules.filter((rule) => rule.kind === 'alert');
  state.automationRules = rules.filter((rule) => rule.kind === 'automation');
  state.alerts = events.items;
  state.channels = channels.items;
  state.automationActions = actions.items;
  state.mappings = mappings.items;
  setTopActions(`<button class="button" data-action="evaluate-alerts" title="立即评估告警" aria-label="立即评估告警"><i data-lucide="scan-line"></i><span>立即评估</span></button><button class="button" data-action="add-alert-rule" title="添加告警规则" aria-label="添加告警规则"><i data-lucide="bell-plus"></i><span>告警规则</span></button><button class="button primary" data-action="add-automation" title="添加自动化规则" aria-label="添加自动化规则"><i data-lucide="workflow"></i><span>自动化规则</span></button>`);
  const ruleRows = rules.map(unifiedRuleRow).join('');
  const eventList = state.alerts.map((event) => `<div class="alert-item"><span class="alert-symbol ${event.severity === 'error' ? 'error' : ''}"><i data-lucide="${event.severity === 'error' ? 'octagon-alert' : 'triangle-alert'}"></i></span><div><p>${escapeHtml(event.message)}</p><small>${formatDate(event.triggered_at)} · ${escapeHtml(alertSeverityLabel(event.severity))}</small></div><div>${badge(event.status)}${event.status === 'active' ? `<button class="icon-button small" data-action="ack-alert" data-id="${event.id}" title="确认告警" aria-label="确认告警"><i data-lucide="check"></i></button>` : ''}</div></div>`).join('');
  const channelRows = state.channels.map((channel) => `<tr><td class="primary-cell"><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(channel.type)}</small></td><td>${channel.enabled ? badge('enabled') : badge('disabled')}</td><td>${channel.credentialFields.map((field) => escapeHtml(field.name)).join(', ') || '-'}</td><td class="actions-cell"><button class="icon-button small" data-action="test-channel" data-id="${channel.id}" title="测试" aria-label="测试"><i data-lucide="send"></i></button><button class="icon-button small" data-action="edit-channel" data-id="${channel.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-channel" data-id="${channel.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></td></tr>`).join('');
  const actionRows = state.automationActions.map((action) => {
    const rollback = action.status === 'succeeded' && !action.rolled_back_at &&
      automationActionCanRollback(action.action_type)
      ? `<button class="button small" data-action="rollback-automation" data-id="${action.id}"><i data-lucide="undo-2"></i><span>回滚</span></button>`
      : '';
    const detailIcon = action.status === 'failed' ? 'circle-alert' : 'info';
    return `<tr><td>${escapeHtml(automationActionLabel(action.action_type))}</td><td>${badge(action.status)}</td><td>${action.dryRun ? '是' : '否'}</td><td>${automationActionResultHtml(action)}</td><td>${formatDate(action.created_at)}</td><td class="actions-cell"><button class="icon-button small ${action.status === 'failed' ? 'danger' : ''}" data-action="view-automation-action" data-id="${action.id}" title="查看执行详情" aria-label="查看执行详情"><i data-lucide="${detailIcon}"></i></button>${rollback}</td></tr>`;
  }).join('');
  const activeAlerts = state.alerts.filter((event) => event.status === 'active').length;
  const failedActions = state.automationActions.filter((action) => action.status === 'failed').length;
  $('#main-content').innerHTML = `<div class="status-summary" aria-label="规则与自动化摘要">${badge('info', `告警规则 ${state.alertRules.length}`)}${badge('enabled', `自动化规则 ${state.automationRules.length}`)}${badge(activeAlerts ? 'warning' : 'healthy', `活动告警 ${activeAlerts}`)}${badge(failedActions ? 'failed' : 'healthy', `失败动作 ${failedActions}`)}</div><div class="section-header"><h2>规则</h2></div><div class="table-wrap">${ruleRows ? `<table><thead><tr><th>规则</th><th>触发条件</th><th>动作</th><th>范围</th><th>模式</th><th>状态</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table>` : emptyState('workflow', '暂无规则', '添加告警规则或自动化规则')}</div><section class="section split-layout"><div class="panel"><div class="panel-header"><h2>告警事件</h2></div><div class="alert-list">${eventList || emptyState('bell-off', '暂无告警', '当前没有触发中的风险事件')}</div></div><div class="panel"><div class="panel-header"><h2>通知通道</h2><div class="panel-actions"><button class="icon-button small" data-action="add-channel" title="添加通知通道" aria-label="添加通知通道"><i data-lucide="plus"></i></button></div></div>${channelRows ? `<div class="table-wrap"><table><thead><tr><th>通道</th><th>状态</th><th>凭据</th><th></th></tr></thead><tbody>${channelRows}</tbody></table></div>` : emptyState('send', '暂无通知通道', '添加 Webhook、Telegram、Gotify、Bark 或邮件')}</div></section><section class="section"><div class="section-header"><h2>动作记录</h2></div><div class="table-wrap">${actionRows ? `<table><thead><tr><th>动作</th><th>结果</th><th>演练</th><th>目标 / 结果</th><th>时间</th><th></th></tr></thead><tbody>${actionRows}</tbody></table>` : emptyState('history', '暂无动作', '触发自动化规则后将在此记录')}</div></section>`;
}

const ALERT_RULE_TYPE_LABELS = {
  low_balance: '低余额 / 低额度',
  runway_below: '可用天数不足',
  stale_data: '数据陈旧',
  sync_failed: '同步失败',
  key_expiry: '密钥到期',
  key_disabled: '密钥停用',
  rate_mismatch: 'Sub2API 综合倍率偏差',
  asset_drift: '资产漂移',
  contract_changed: '接口契约变化',
  anomaly: '用量或余额异常',
  credential_expiry: '凭据久未轮换',
  automation_failed: '自动化失败'
};

const AUTOMATION_ACTION_LABELS = {
  create_alert_event: '创建告警事件',
  disable_sub2api_account: '停用 Sub2API 账号',
  enable_sub2api_account: '启用 Sub2API 账号',
  switch_to_backup: '切换备用映射',
  trigger_recharge_webhook: '触发充值工单 Webhook',
  remind_credential_rotation: '生成凭据轮换提醒',
  create_route_recommendation: '生成路由建议',
  rebuild_sub2api_mappings: '重建全部 Sub2API 映射',
  disable_sub2api_channel: '停用 Sub2API 渠道（旧动作）',
  enable_sub2api_channel: '启用 Sub2API 渠道（旧动作）'
};

const AUTOMATION_TRIGGER_LABELS = {
  low_balance: '余额低于阈值',
  balance_recovered: '余额恢复',
  key_failed: 'Key 健康失败',
  anomaly_detected: '检测到异常',
  contract_changed: '接口契约变化',
  scheduled: '按时间运行'
};

const AUTOMATION_CONDITION_OPERATOR_LABELS = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥'
};

function normalizeUnifiedRules(alertRules, automationRules) {
  return [
    ...alertRules.map((rule) => ({
      ...rule,
      kind: 'alert',
      triggerType: rule.rule_type,
      actionType: 'create_alert_event',
      executionMode: 'event'
    })),
    ...automationRules.map((rule) => ({
      ...rule,
      kind: 'automation',
      triggerType: rule.trigger_type,
      actionType: rule.config?.action || null,
      executionMode: rule.dryRun ? 'dry_run' : 'live'
    }))
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function alertRuleTypeLabel(ruleType) {
  return ALERT_RULE_TYPE_LABELS[ruleType] || ruleType || '-';
}

function automationActionLabel(actionType) {
  return AUTOMATION_ACTION_LABELS[actionType] || actionType || '-';
}

function automationTriggerLabel(triggerType) {
  return AUTOMATION_TRIGGER_LABELS[triggerType] || triggerType || '-';
}

function ruleTriggerDetail(rule) {
  if (rule.kind === 'automation' && rule.triggerType === 'scheduled') {
    const minutes = Number(rule.config?.scheduleIntervalMinutes || 0);
    const details = [];
    if (minutes > 0 && minutes % 1440 === 0) details.push(`每 ${minutes / 1440} 天`);
    else if (minutes > 0 && minutes % 60 === 0) details.push(`每 ${minutes / 60} 小时`);
    else if (minutes > 0) details.push(`每 ${minutes} 分钟`);
    if (rule.config?.condition?.type === 'composite_rate_difference') {
      const operator = AUTOMATION_CONDITION_OPERATOR_LABELS[rule.config.condition.operator] || rule.config.condition.operator;
      details.push(`综合倍率偏差 ${operator} ${formatNumber(rule.config.condition.threshold)}%`);
    }
    return details.join(' · ');
  }
  if (rule.kind === 'alert' && rule.triggerType === 'rate_mismatch') {
    const operator = {
      abs_gt: '绝对偏差 >', lt: '偏差 <', lte: '偏差 ≤', gt: '偏差 >', gte: '偏差 ≥'
    }[rule.config?.comparisonOperator || 'abs_gt'];
    const groupId = Number(rule.config?.groupId);
    const mapping = Number.isInteger(groupId)
      ? state.mappings.find((item) => Number(item.group_id) === groupId)
      : null;
    const groupLabel = Number.isInteger(groupId)
      ? mapping?.comparison?.baseGroupName || `分组 #${groupId}`
      : '全部已映射分组';
    return `${groupLabel} · ${operator} ${formatNumber(rule.threshold)}%`;
  }
  const threshold = rule.kind === 'alert' ? rule.threshold : rule.config?.threshold;
  const currency = rule.kind === 'alert' ? rule.currency : rule.config?.currency;
  const consecutiveMatches = rule.kind === 'alert' ? rule.consecutive_matches : rule.config?.consecutiveMatches;
  const details = [];
  if (threshold != null) details.push(`${formatNumber(threshold)}${currency ? ` ${currency}` : ''}`);
  if (Number(consecutiveMatches) > 1) details.push(`连续 ${consecutiveMatches} 次`);
  return details.join(' · ');
}

function automationRuleActionLabel(rule) {
  const action = automationActionLabel(rule.actionType);
  return rule.config?.onMatchAction
    ? `${action}；命中后${automationActionLabel(rule.config.onMatchAction)}`
    : action;
}

function unifiedRuleRow(rule) {
  const alertRule = rule.kind === 'alert';
  const triggerLabel = alertRule
    ? alertRuleTypeLabel(rule.triggerType)
    : automationTriggerLabel(rule.triggerType);
  const triggerDetail = ruleTriggerDetail(rule);
  const providerName = rule.triggerType === 'scheduled'
    ? '全局'
    : rule.connection_id
      ? state.providers.find((provider) => provider.id === rule.connection_id)?.name || '-'
      : '全部';
  const scope = alertRule && rule.rule_type === 'low_balance'
    ? ({ account: '账户', key: 'Key', team: 'Team Budget' })[rule.scope] || rule.scope
    : '';
  const mode = alertRule
    ? badge('info', '持续评估')
    : rule.executionMode === 'dry_run' ? badge('dry_run') : badge('active', '实执行');
  const actions = alertRule
    ? `<button class="icon-button small" data-action="edit-alert-rule" data-id="${rule.id}" title="编辑告警规则" aria-label="编辑告警规则"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-alert-rule" data-id="${rule.id}" title="删除告警规则" aria-label="删除告警规则"><i data-lucide="trash-2"></i></button>`
    : `<button class="icon-button small" data-action="dry-run-automation" data-id="${rule.id}" title="预览执行条件" aria-label="预览执行条件"><i data-lucide="scan-search"></i></button><button class="icon-button small" data-action="edit-automation" data-id="${rule.id}" title="编辑自动化规则" aria-label="编辑自动化规则"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-automation" data-id="${rule.id}" title="删除自动化规则" aria-label="删除自动化规则"><i data-lucide="trash-2"></i></button>`;
  return `<tr data-rule-kind="${rule.kind}"><td class="primary-cell"><strong>${escapeHtml(rule.name)}</strong><small>${alertRule ? '告警规则' : '自动化规则'}</small></td><td class="primary-cell rule-trigger-cell"><strong>${escapeHtml(triggerLabel)}</strong>${triggerDetail ? `<small>${escapeHtml(triggerDetail)}</small>` : ''}</td><td>${escapeHtml(alertRule ? automationActionLabel(rule.actionType) : automationRuleActionLabel(rule))}</td><td class="primary-cell"><strong>${escapeHtml(providerName)}</strong>${scope ? `<small>${escapeHtml(scope)}</small>` : ''}</td><td>${mode}</td><td>${rule.enabled ? badge('enabled') : badge('disabled')}</td><td class="actions-cell">${actions}</td></tr>`;
}

function automationActionTarget(action) {
  if (action.after?.accountId) return `账号 #${action.after.accountId}`;
  if (action.after?.channelId) return `渠道 #${action.after.channelId}`;
  if (action.after?.createdMappings != null) return `新建 ${action.after.createdMappings} 条`;
  if (action.after?.wouldCreateMappings != null) return `预计新建 ${action.after.wouldCreateMappings} 条`;
  return '-';
}

function automationActionCanRollback(actionType) {
  return ['disable_sub2api_account', 'enable_sub2api_account', 'switch_to_backup',
    'disable_sub2api_channel', 'enable_sub2api_channel'].includes(actionType);
}

const AUTOMATION_FAILURE_STAGE_LABELS = {
  record_action: '记录动作',
  prepare_mapping_rebuild: '读取当前映射',
  rebuild_mappings: '执行映射重建',
  refresh_provider_snapshots: '刷新供应商映射快照',
  discover_candidates: '发现并校验候选映射',
  replace_mappings: '替换映射事务',
  refresh_comparisons: '刷新综合倍率比较',
  read_sub2api_account: '读取 Sub2API 账号',
  update_sub2api_account: '更新 Sub2API 账号',
  switch_backup_mapping: '切换备用映射',
  deliver_recharge_webhook: '发送充值 Webhook',
  record_result: '保存执行结果',
  execute_action: '执行动作'
};

const AUTOMATION_ERROR_GUIDANCE = {
  SUB2API_STEP_UP_REQUIRED: '当前管理员的 Sub2API 二次认证已过期。可在“设置与备份”配置并验证管理员 API Key；若 Sub2API 已开启敏感操作 step-up 2FA，则需先用完成 TOTP 验证的管理员会话关闭该开关。',
  SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN: 'Sub2API 已开启敏感操作 step-up 2FA，管理员 API Key 被禁止导出账号 Key。请用完成 TOTP 验证的 Sub2API 管理员会话关闭该开关，再回到“设置与备份”重新保存并验证 Key。',
  SUB2API_KEY_EXPORT_FORBIDDEN: 'Sub2API 拒绝导出账号 Key。请检查管理员认证权限，或在“设置与备份”重新验证管理员 API Key。',
  SUB2API_GROUP_RATE_INCOMPLETE: 'Sub2API 最新分组中存在缺失或无效倍率，系统已保留旧映射；请修正详情中的分组倍率后重试。',
  MAPPING_PROVIDER_SNAPSHOT_INCOMPLETE: '匹配供应商的分组、Key、充值倍率或动态倍率未完整刷新，系统已保留旧映射；请按详情中的供应商和警告码排查。',
  MAPPING_RATE_SNAPSHOT_INCOMPLETE: '候选映射无法计算完整综合倍率，系统已回滚整个替换事务；请按详情检查供应商分组倍率、充值倍率和 Sub2API 分组倍率。',
  MAPPING_REBUILD_IN_PROGRESS: '已有一次映射重建正在执行，请等待该动作完成后重试。',
  SUB2API_SSO_REQUIRED: '此操作必须使用 Sub2API 管理员 SSO 会话；请重新登录并完成二次认证。',
  SUB2API_TOTP_NOT_ENABLED: '当前 Sub2API 管理员未启用 TOTP，需先在 Sub2API 中启用后才能读取账号 Key。',
  SUB2API_ADMIN_CREDENTIALS_REQUIRED: 'Provider Monitor 没有可用的 Sub2API 管理员会话或凭据，请检查部署配置并重新登录。',
  SUB2API_ADMIN_SESSION_REQUIRED: 'Sub2API 管理员会话已经失效，请重新登录后重试。',
  SUB2API_LOGIN_2FA_REQUIRED: '配置的管理员账号登录需要 TOTP，请先完成登录二次认证。',
  TIMEOUT: '请求 Sub2API 超时，请检查基座地址、容器网络和服务负载。',
  NETWORK_UNREACHABLE: '无法连接 Sub2API，请检查 SUB2API_BASE_URL、容器网络和 DNS。',
  SCHEMA_MISMATCH: 'Sub2API 返回结构与当前版本不兼容，请结合下方端点和响应计数检查基座版本。',
  SQLITE_BUSY: 'SQLite 正被其他任务或实例占用，请确认仅运行一个 Provider Monitor 实例后重试。',
  SQLITE_LOCKED: 'SQLite 表被并发任务锁定，请确认仅运行一个 Provider Monitor 实例后重试。'
};

function automationActionFailure(action) {
  if (action.error) return action.error;
  if (!action.error_message && !action.errorMessage) return null;
  return {
    code: action.error_code || action.errorCode || 'AUTOMATION_ACTION_FAILED',
    message: action.error_message || action.errorMessage,
    stage: action.failure_stage || action.failureStage || null,
    retryable: Boolean(action.errorDetails?.retryable),
    status: action.errorDetails?.status ?? null,
    details: action.errorDetails?.details || action.errorDetails || {}
  };
}

function automationFailureStageLabel(stage) {
  return AUTOMATION_FAILURE_STAGE_LABELS[stage] || stage || '执行动作';
}

function automationActionResultHtml(action) {
  const failure = automationActionFailure(action);
  if (!failure) return escapeHtml(automationActionTarget(action));
  return `<div class="automation-action-result failed"><strong>${escapeHtml(automationFailureStageLabel(failure.stage))}</strong><small title="${escapeHtml(failure.message)}">${escapeHtml(failure.message || '未记录失败原因')}</small></div>`;
}

function automationActionJson(value) {
  try { return JSON.stringify(value == null ? {} : value, null, 2); } catch { return '{}'; }
}

function openAutomationActionDetail(actionId) {
  const action = state.automationActions.find((item) => item.id === actionId);
  if (!action) return;
  const dialog = $('#automation-action-detail-dialog');
  const root = $('#automation-action-detail');
  const failure = automationActionFailure(action);
  const guidance = failure ? AUTOMATION_ERROR_GUIDANCE[failure.code] || '' : '';
  $('#automation-action-detail-title').textContent = automationActionLabel(action.action_type);
  $('#automation-action-detail-subtitle').textContent = action.rule_name
    ? `规则：${action.rule_name}`
    : '规则已删除或不可用';
  root.innerHTML = `
    <div class="automation-action-detail-grid">
      <div><span>结果</span>${badge(action.status)}</div>
      <div><span>模式</span><strong>${action.dryRun ? '演练' : '实执行'}</strong></div>
      <div><span>开始时间</span><strong>${escapeHtml(formatDate(action.created_at))}</strong></div>
      <div><span>完成时间</span><strong>${escapeHtml(formatDate(action.completed_at))}</strong></div>
    </div>
    ${failure ? `<section class="automation-failure-detail">
      <div class="automation-failure-heading"><i data-lucide="circle-alert"></i><div><strong>${escapeHtml(failure.message || '执行失败')}</strong><small>${escapeHtml(automationFailureStageLabel(failure.stage))}</small></div></div>
      <dl>
        <div><dt>错误码</dt><dd><code>${escapeHtml(failure.code || 'AUTOMATION_ACTION_FAILED')}</code></dd></div>
        <div><dt>HTTP 状态</dt><dd>${failure.status == null ? '-' : escapeHtml(failure.status)}</dd></div>
        <div><dt>可重试</dt><dd>${failure.retryable ? '是' : '否'}</dd></div>
      </dl>
      ${guidance ? `<p class="automation-failure-guidance">${escapeHtml(guidance)}</p>` : ''}
      <details><summary>技术详情</summary><pre>${escapeHtml(automationActionJson(failure.details))}</pre></details>
    </section>` : ''}
    <div class="automation-action-payloads">
      <section><h3>执行前</h3><pre>${escapeHtml(automationActionJson(action.before))}</pre></section>
      <section><h3>${action.status === 'failed' ? '失败时计划结果' : '执行后'}</h3><pre>${escapeHtml(automationActionJson(action.after))}</pre></section>
    </div>`;
  dialog.showModal();
  icons();
}

const RECHARGE_TEST_REASON_LABELS = {
  automatic_login_disabled: '供应商配置为直接打开',
  public_url_missing: '未配置 Provider Monitor 公开地址',
  insecure_public_origin: 'Provider Monitor 公开地址不是安全地址',
  insecure_provider_origin: '供应商基础地址不是安全地址',
  adapter_unsupported: '该适配器暂不支持网页登录',
  api_key_has_no_user_session: 'Sub2API API Key 模式没有网页登录会话',
  recharge_target_origin_mismatch: '充值链接与供应商基础地址不同源',
  login_credentials_missing: '缺少可用的供应商登录凭据',
  web_login_credentials_missing: '缺少充值网页账号或密码',
  link_generation_failed: '一次性充值入口签发失败'
};

function rechargeTestReasonLabel(reason) {
  return RECHARGE_TEST_REASON_LABELS[reason] || reason || '';
}

function rechargeTestTargetHost(value) {
  if (!value) return '未配置';
  try { return new URL(value).hostname; } catch { return '地址无效'; }
}

function rechargeTestReadinessHtml(provider, channel, previewOnly = false) {
  if (!provider) return '<div class="test-readiness-state error"><i data-lucide="circle-alert"></i><span>暂无可测试的供应商</span></div>';
  const hasRechargeUrl = Boolean(provider.rechargeUrl);
  const adapterLogin = provider.typeConfig?.rechargeLogin?.enabled === true;
  const ready = hasRechargeUrl && (previewOnly || channel);
  return `<div class="test-readiness-state ${ready ? 'ready' : 'error'}">
      <i data-lucide="${ready ? 'circle-check' : 'circle-alert'}"></i>
      <span>${hasRechargeUrl ? previewOnly ? '仅生成移动端预览，不发送通知' : channel ? '可以发送模拟告警' : '请选择通知通道' : '该供应商未配置充值链接'}</span>
    </div>
    <div class="test-readiness-grid">
      <div><span>适配器</span><strong>${escapeHtml(adapterLabel(provider.adapter_type))}</strong></div>
      <div><span>充值目标</span><strong>${escapeHtml(rechargeTestTargetHost(provider.rechargeUrl))}</strong></div>
      <div><span>请求方式</span><strong>${adapterLogin ? '适配器自动登录' : '直接打开'}</strong></div>
      <div><span>通知通道</span><strong>${previewOnly ? '不发送' : channel ? `${escapeHtml(channel.name)}${channel.enabled ? '' : '（停用）'}` : '未选择'}</strong></div>
    </div>`;
}

function updateRechargeAlertTestReadiness(form = $('#recharge-alert-test-form')) {
  if (!form) return;
  const provider = state.providers.find((item) => item.id === form.elements.connectionId.value);
  const channel = state.channels.find((item) => item.id === form.elements.notificationChannelId.value);
  const previewOnly = form.elements.previewOnly.checked;
  form.elements.notificationChannelId.disabled = previewOnly || state.channels.length === 0;
  $('#recharge-test-readiness').innerHTML = rechargeTestReadinessHtml(provider, channel, previewOnly);
  const submit = $('button[type="submit"]', form);
  submit.disabled = form.dataset.running === 'true' || !provider?.rechargeUrl || (!previewOnly && !channel);
  submit.innerHTML = `<i data-lucide="${previewOnly ? 'smartphone' : 'send'}"></i><span>${previewOnly ? '打开移动端预览' : '发送测试告警'}</span>`;
  icons();
}

function rechargeAlertTestResultHtml(result) {
  const recharge = result.recharge || {};
  const adapterEntry = recharge.mode === 'adapter';
  const reason = rechargeTestReasonLabel(recharge.reason);
  const previewOnly = result.previewOnly === true;
  const succeeded = previewOnly ? result.status === 'preview_ready' : result.status === 'delivered';
  return `<section class="panel test-result-panel">
    <div class="panel-header"><h2>${previewOnly ? '预览结果' : '发送结果'}</h2><div class="panel-actions">${previewOnly && result.mobilePreview?.url ? '<button class="button small" type="button" data-action="regenerate-mobile-preview"><i data-lucide="refresh-cw"></i><span>重新生成预览</span></button>' : ''}${badge(succeeded ? 'succeeded' : 'failed', previewOnly && succeeded ? '预览已生成' : succeeded ? '已送达' : result.status)}</div></div>
    <div class="test-result-grid">
      <div><span>供应商</span><strong>${escapeHtml(result.provider?.name || '-')}</strong></div>
      <div><span>通知通道</span><strong>${previewOnly ? '未发送' : escapeHtml(result.channel?.name || '-')}</strong></div>
      <div><span>充值入口</span><strong>${adapterEntry ? '一次性自动登录入口' : '原充值链接'}</strong></div>
      <div><span>目标主机</span><strong>${escapeHtml(recharge.targetHost || '-')}</strong></div>
      <div><span>模拟余额</span><strong>${formatNumber(result.alert?.balance, 2)} ${escapeHtml(result.alert?.currency || '')}</strong></div>
      <div><span>模拟阈值</span><strong>${formatNumber(result.alert?.threshold, 2)} ${escapeHtml(result.alert?.currency || '')}</strong></div>
      <div><span>入口到期</span><strong>${recharge.expiresAt ? formatDate(recharge.expiresAt) : '不适用'}</strong></div>
      <div><span>${previewOnly ? '生成时间' : '发送时间'}</span><strong>${formatDate(result.sentAt)}</strong></div>
    </div>
    ${reason ? `<div class="test-result-note"><i data-lucide="info"></i><span>${escapeHtml(reason)}，${previewOnly ? '预览将打开原充值链接。' : '本次已发送原充值链接。'}</span></div>` : ''}
  </section>`;
}

function openMobilePreviewWindow(url = '') {
  const popup = window.open(
    url || 'about:blank',
    'provider-monitor-mobile-preview',
    'popup,width=430,height=860,resizable=yes,scrollbars=yes'
  );
  if (popup && !url) {
    try {
      popup.document.title = '移动端充值预览';
      popup.document.body.textContent = '正在准备移动端充值预览...';
    } catch {}
    popup.blur?.();
    window.focus?.();
  }
  return popup;
}

async function runRechargeAlertTest(form) {
  const resultRegion = $('#recharge-test-result');
  const previewOnly = form.elements.previewOnly.checked;
  const previewWindow = previewOnly
    ? openMobilePreviewWindow()
    : null;
  form.dataset.running = 'true';
  updateRechargeAlertTestReadiness(form);
  resultRegion.innerHTML = `<section class="panel test-result-panel"><div class="test-result-pending"><i class="spin" data-lucide="loader-circle"></i><strong>${previewOnly ? '正在生成移动端预览' : '正在发送模拟告警'}</strong></div></section>`;
  icons();
  try {
    const body = {
      connectionId: form.elements.connectionId.value,
      previewOnly,
      ...(!previewOnly ? { channelId: form.elements.notificationChannelId.value } : {})
    };
    const result = await withRecentReauth(() => api('/api/simulations/recharge-alert', {
      method: 'POST',
      body
    }));
    resultRegion.innerHTML = rechargeAlertTestResultHtml(result);
    if (previewWindow && !previewWindow.closed && result.mobilePreview?.url) {
      previewWindow.location.replace(result.mobilePreview.url);
      previewWindow.focus?.();
    }
    toast(previewOnly ? '移动端预览已打开，未发送任何通知' : `模拟告警已发送至 ${result.channel.name}`);
  } catch (error) {
    if (previewWindow && !previewWindow.closed) {
      try {
        previewWindow.document.body.textContent = `移动端预览未打开：${error.message}`;
      } catch {}
    }
    resultRegion.innerHTML = `<section class="panel test-result-panel"><div class="test-result-pending error"><i data-lucide="circle-alert"></i><strong>${escapeHtml(error.message)}</strong></div></section>`;
    toast(error.message, 'error');
  } finally {
    delete form.dataset.running;
    updateRechargeAlertTestReadiness(form);
    icons();
  }
}

async function renderTests() {
  const channels = await api('/api/notification-channels');
  state.channels = channels.items;
  setTopActions('<button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>');
  const providerOptions = state.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} · ${escapeHtml(adapterLabel(provider.adapter_type))}${provider.rechargeUrl ? '' : ' · 未配置充值链接'}</option>`).join('');
  const channelOptions = state.channels.map((channel) => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)} · ${escapeHtml(channel.type)}${channel.enabled ? '' : ' · 停用'}</option>`).join('');
  $('#main-content').innerHTML = `
    <div class="tabs test-suite-tabs" role="tablist" aria-label="测试项目">
      <button class="tab active" type="button" role="tab" aria-selected="true"><i data-lucide="bell-ring"></i><span>告警充值入口</span></button>
    </div>
    <section class="panel test-runner-panel">
      <div class="panel-header"><h2>手机通知链路</h2><div class="panel-actions">${badge('dry_run', '模拟')}</div></div>
      <form id="recharge-alert-test-form" class="test-runner-form">
        <div class="test-control-grid">
          <label><span>供应商</span><select name="connectionId" ${providerOptions ? '' : 'disabled'}>${providerOptions || '<option value="">暂无供应商</option>'}</select></label>
          <label><span>通知通道</span><select name="notificationChannelId" ${channelOptions ? '' : 'disabled'}>${channelOptions || '<option value="">暂无通知通道</option>'}</select></label>
        </div>
        <div id="recharge-test-readiness" class="test-readiness"></div>
        <footer class="test-runner-actions">
          <span class="test-simulation-mark"><i data-lucide="shield-check"></i><span>隔离模拟</span></span>
          <label class="toggle-field test-preview-toggle"><input name="previewOnly" type="checkbox" checked><span>仅打开移动端预览（不发送通知）</span></label>
          <button class="button primary" type="submit"><i data-lucide="send"></i><span>发送测试告警</span></button>
        </footer>
      </form>
    </section>
    <div id="recharge-test-result" aria-live="polite"></div>`;
  const form = $('#recharge-alert-test-form');
  form.elements.connectionId.addEventListener('change', () => updateRechargeAlertTestReadiness(form));
  form.elements.notificationChannelId.addEventListener('change', () => updateRechargeAlertTestReadiness(form));
  form.elements.previewOnly.addEventListener('change', () => updateRechargeAlertTestReadiness(form));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runRechargeAlertTest(form);
  });
  updateRechargeAlertTestReadiness(form);
}

async function renderActivity() {
  const selected = ['checks', 'jobs', 'audit'].includes(state.activityTab) ? state.activityTab : 'checks';
  state.activityTab = selected;
  const selectedKey = `activity-${selected}`;
  state.pagedLists[selectedKey] = await requestPagedList(
    selectedKey,
    state.pagedLists[selectedKey]?.pagination?.page || 1
  );
  setTopActions(`<button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  const tabs = [
    ['checks', '检查记录'], ['jobs', '任务队列'], ['audit', '审计日志']
  ].map(([name, label]) => {
    const active = name === selected;
    return `<button id="activity-${name}-tab" class="tab ${active ? 'active' : ''}" data-activity-tab="${name}" role="tab" aria-selected="${active}" aria-controls="activity-${name}" tabindex="${active ? 0 : -1}">${label}</button>`;
  }).join('');
  const panels = ['checks', 'jobs', 'audit'].map((name) => `<div id="activity-${name}" role="tabpanel" aria-labelledby="activity-${name}-tab" ${name === selected ? '' : 'hidden'}><div id="activity-${name}-list" data-paged-list="activity-${name}"></div></div>`).join('');
  $('#main-content').innerHTML = `<div class="tabs" role="tablist" aria-label="运行记录类型">${tabs}</div>${panels}`;
  ['checks', 'jobs', 'audit'].forEach((name) => {
    if (state.pagedLists[`activity-${name}`]) paintActivityList(name);
  });
}

async function selectActivityTab(name) {
  if (!['checks', 'jobs', 'audit'].includes(name)) return;
  state.activityTab = name;
  $$('[data-activity-tab]').forEach((tab) => {
    const active = tab.dataset.activityTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  ['checks', 'jobs', 'audit'].forEach((panelName) => {
    const panel = $(`#activity-${panelName}`);
    if (panel) panel.hidden = panelName !== name;
  });
  const listKey = `activity-${name}`;
  if (!state.pagedLists[listKey]) {
    const root = $(`#activity-${name}-list`);
    if (root) root.innerHTML = `<div class="table-wrap">${emptyState('loader-circle', '正在加载', '')}</div>`;
    icons();
    state.pagedLists[listKey] = await requestPagedList(listKey, 1);
  }
  paintActivityList(name);
}

function paintActivityList(name) {
  const listKey = `activity-${name}`;
  const result = state.pagedLists[listKey];
  const root = $(`#activity-${name}-list`);
  if (!result || !root) return;
  let rows = '';
  let headers = '';
  let emptyIcon = 'scroll-text';
  let emptyTitle = '暂无运行记录';
  let emptyText = '执行同步或管理操作后将在此显示';
  if (name === 'checks') {
    state.checks = result.items;
    rows = result.items.map((run) => `<tr><td>${escapeHtml(state.providers.find((provider) => provider.id === run.connection_id)?.name || '-')}</td><td>${escapeHtml(run.job_type)}</td><td>${badge(run.status)}</td><td class="numeric">${run.duration_ms == null ? '-' : `${run.duration_ms} ms`}</td><td>${escapeHtml(run.error_code || '-')}</td><td>${formatDate(run.started_at)}</td></tr>`).join('');
    headers = '<th>供应商</th><th>类型</th><th>状态</th><th class="numeric">耗时</th><th>错误码</th><th>开始时间</th>';
    emptyIcon = 'clipboard-check';
    emptyTitle = '暂无检查记录';
  }
  if (name === 'jobs') {
    state.jobs = result.items;
    rows = result.items.map((job) => `<tr><td>${escapeHtml(job.type)}</td><td>${escapeHtml(state.providers.find((provider) => provider.id === job.connection_id)?.name || '-')}</td><td>${badge(job.status)}</td><td class="numeric">${job.attempt}</td><td>${escapeHtml(job.last_error || '-')}</td><td>${formatDate(job.created_at)}</td></tr>`).join('');
    headers = '<th>任务</th><th>供应商</th><th>状态</th><th class="numeric">尝试</th><th>错误</th><th>创建时间</th>';
    emptyIcon = 'list-checks';
    emptyTitle = '暂无任务记录';
  }
  if (name === 'audit') {
    state.audit = result.items;
    rows = result.items.map((log) => `<tr><td>${escapeHtml(log.actor_name || '-')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.target_type || '-')}</td><td>${escapeHtml(log.target_id || '-')}</td><td>${formatDate(log.created_at)}</td></tr>`).join('');
    headers = '<th>操作者</th><th>动作</th><th>对象</th><th>ID</th><th>时间</th>';
    emptyIcon = 'file-clock';
    emptyTitle = '暂无审计日志';
  }
  root.innerHTML = pagedTableHtml({
    rows, headers, emptyIcon, emptyTitle, emptyText,
    listKey, pagination: result.pagination
  });
  icons();
}

function credentialFieldsFor(adapter, authMode) {
  if (adapter === 'sub2api') {
    if (authMode === 'api_key') return SUB2API_CREDENTIAL_FIELDS.api_key;
    return ['token_pair', 'bearer'].includes(authMode)
      ? SUB2API_CREDENTIAL_FIELDS.token_pair
      : SUB2API_CREDENTIAL_FIELDS.account;
  }
  return CREDENTIAL_FIELDS[adapter] || CREDENTIAL_FIELDS.custom;
}

function usesMultipleApiKeyEditor(adapter, authMode) {
  return adapter === 'sub2api' && authMode === 'api_key';
}

function usesRemoteApiKeySelection(adapter, authMode, apiKeySource = '') {
  if (adapter === 'new-api') return authMode === 'api_key';
  if (adapter === 'sub2api' && authMode === 'api_key') return apiKeySource === 'remote';
  return adapter === 'sub2api' && ['account', 'token_pair', 'bearer'].includes(authMode);
}

function selectedSub2ApiKeySource(form) {
  return form.elements.sub2apiApiKeySource?.value || 'manual';
}

function formUsesRemoteApiKeySelection(form) {
  return usesRemoteApiKeySelection(
    form.elements.adapterType.value,
    form.elements.authMode.value,
    selectedSub2ApiKeySource(form)
  );
}

function providerApiKeyRow(entry = {}, index = 0, { monitored = true } = {}) {
  const stored = Boolean(entry.id);
  const generatedId = globalThis.crypto?.randomUUID?.() ||
    `api-key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = String(entry.id || generatedId);
  const name = String(entry.name || `API Key ${index + 1}`);
  const masked = String(entry.masked || '');
  return `<div class="provider-api-key-row" data-provider-api-key-row>
    <input type="hidden" data-api-key-id value="${escapeHtml(id)}">
    <label><span>名称</span><input data-api-key-name value="${escapeHtml(name)}" maxlength="120" required></label>
    <label><span>API Key</span><input data-api-key-value type="password" autocomplete="off" placeholder="${masked ? `已保存 ${escapeHtml(masked)}，留空不修改` : '输入 API Key'}" ${stored ? '' : 'required'}></label>
    <label class="toggle-field provider-api-key-monitor"><input type="checkbox" data-api-key-monitored ${monitored ? 'checked' : ''}><span>监控</span></label>
    <button class="icon-button" type="button" data-action="remove-provider-api-key" title="移除 API Key" aria-label="移除 API Key"><i data-lucide="trash-2"></i></button>
  </div>`;
}

function renderProviderApiKeyEditor(provider = null) {
  const source = provider?.typeConfig?.apiKeySource ||
    (provider?.configuredApiKeys?.length ? 'manual' : 'remote');
  const entries = provider?.configuredApiKeys?.length
    ? provider.configuredApiKeys
    : [{}];
  const monitoredIds = Array.isArray(provider?.typeConfig?.monitoredKeyIds)
    ? new Set(provider.typeConfig.monitoredKeyIds.map(String))
    : null;
  const sessionFields = CREDENTIAL_FIELDS.sub2api.map(([name, label, type]) => {
    const existing = provider?.credentialFields?.find((field) => field.name === name);
    return `<label><span>${escapeHtml(label)}</span><input data-credential="${name}" type="${type}" placeholder="${existing ? `已保存 ${existing.masked}，留空不修改` : ''}" autocomplete="off"></label>`;
  }).join('');
  $('#credential-fields').innerHTML = `<div class="provider-api-key-editor span-2">
    <label class="provider-api-key-source"><span>Key 来源</span><select name="sub2apiApiKeySource"><option value="remote" ${source === 'remote' ? 'selected' : ''}>远端列表</option><option value="manual" ${source === 'manual' ? 'selected' : ''}>手工配置</option></select></label>
    <div class="provider-api-key-session-fields" data-sub2api-api-key-remote ${source === 'remote' ? '' : 'hidden'}>${sessionFields}</div>
    <div data-sub2api-api-key-manual ${source === 'manual' ? '' : 'hidden'}>
      <div class="provider-api-key-heading"><strong>API Keys</strong><button class="icon-button small" type="button" data-action="add-provider-api-key" title="添加 API Key" aria-label="添加 API Key"><i data-lucide="plus"></i></button></div>
      <div class="provider-api-key-list" data-provider-api-key-list>${entries.map((entry, index) => providerApiKeyRow(
      entry,
      index,
      { monitored: monitoredIds == null || monitoredIds.has(String(entry.id)) }
    )).join('')}</div>
    </div>
  </div>`;
  icons();
}

function renderCredentialFields(adapter, provider = null, authMode = '') {
  const selectedAuthMode = authMode || provider?.auth_mode;
  if (usesMultipleApiKeyEditor(adapter, selectedAuthMode)) {
    renderProviderApiKeyEditor(provider);
    return;
  }
  const fields = credentialFieldsFor(adapter, selectedAuthMode);
  $('#credential-fields').innerHTML = fields.map(([name, label, type]) => {
    const existing = provider?.credentialFields?.find((field) => field.name === name);
    return `<label><span>${escapeHtml(label)}</span><input data-credential="${name}" type="${type}" placeholder="${existing ? `已保存 ${existing.masked}，留空不修改` : ''}" autocomplete="off"></label>`;
  }).join('');
}

function renderMonitoredApiKeyOptions(form, provider = null, { loading = false } = {}) {
  const fieldset = $('#monitored-api-keys-fieldset');
  const root = $('#monitored-api-key-options');
  if (!fieldset || !root) return;
  const active = formUsesRemoteApiKeySelection(form);
  fieldset.hidden = !active;
  if (!active) {
    root.innerHTML = '';
    return;
  }
  if (loading) {
    root.innerHTML = '<div class="monitored-api-key-empty"><i class="spin" data-lucide="loader-circle"></i><span>正在读取远端 Key</span></div>';
    icons();
    return;
  }

  const connectionId = provider?.id || form.elements.id.value || 'provider-form-preview';
  const savedSource = provider?.typeConfig?.apiKeySource ||
    (provider?.configuredApiKeys?.length ? 'manual' : null);
  const sourceChanged = form.elements.adapterType.value === 'sub2api' &&
    form.elements.authMode.value === 'api_key' && savedSource &&
    selectedSub2ApiKeySource(form) !== savedSource;
  const configuredIds = !sourceChanged && Array.isArray(provider?.typeConfig?.monitoredKeyIds)
    ? provider.typeConfig.monitoredKeyIds.map(String)
    : null;
  const keys = state.keys.filter((key) =>
    key.connection_id === connectionId &&
    (!sourceChanged || key.key_option_source === 'remote')
  );
  const keysByRemoteId = new Map(keys.map((key) => [String(key.remote_id), key]));
  const options = [...keys];
  for (const remoteId of configuredIds || []) {
    if (keysByRemoteId.has(remoteId)) continue;
    options.push({
      remote_id: remoteId,
      name: `Key #${remoteId}`,
      masked_key: '',
      status: 'missing'
    });
  }
  options.sort((left, right) => {
    const leftMissing = left.status === 'missing' ? 1 : 0;
    const rightMissing = right.status === 'missing' ? 1 : 0;
    return leftMissing - rightMissing || String(left.name).localeCompare(String(right.name), 'zh-CN');
  });
  if (options.length === 0) {
    root.innerHTML = '<div class="monitored-api-key-empty"><i data-lucide="key-round"></i><span>暂无已同步 Key</span></div>';
    icons();
    return;
  }
  const selected = configuredIds == null
    ? new Set(options.filter((key) => key.status !== 'missing').map((key) => String(key.remote_id)))
    : new Set(configuredIds);
  root.innerHTML = options.map((key) => {
    const remoteId = String(key.remote_id);
    return `<label class="monitored-api-key-option">
      <input type="checkbox" data-monitored-api-key value="${escapeHtml(remoteId)}" ${selected.has(remoteId) ? 'checked' : ''}>
      <span><strong>${escapeHtml(key.name || `Key #${remoteId}`)}</strong><small>${escapeHtml([key.masked_key, key.status, `#${remoteId}`].filter(Boolean).join(' · '))}</small></span>
    </label>`;
  }).join('');
}

async function loadMonitoredApiKeyOptions(form, provider) {
  if (!formUsesRemoteApiKeySelection(form)) return;
  const usesLiveSub2ApiDiscovery = form.elements.adapterType.value === 'sub2api';
  if (!provider?.id && !usesLiveSub2ApiDiscovery) return;
  const discoveryCredentials = usesLiveSub2ApiDiscovery
    ? Object.fromEntries(
      $$('[data-credential]', form)
        .filter((input) => input.value)
        .map((input) => [input.dataset.credential, input.value])
    )
    : {};
  const hasSavedDiscoveryCredentials = provider?.credentialFields?.some((field) =>
    ['email', 'password', 'accessToken', 'refreshToken'].includes(field.name)
  );
  if (
    usesLiveSub2ApiDiscovery &&
    Object.keys(discoveryCredentials).length === 0 &&
    !hasSavedDiscoveryCredentials
  ) {
    renderMonitoredApiKeyOptions(form, provider);
    return;
  }
  renderMonitoredApiKeyOptions(form, provider, { loading: true });
  try {
    const connectionId = provider?.id || form.elements.id.value || 'provider-form-preview';
    const result = usesLiveSub2ApiDiscovery
      ? await api('/api/providers/key-options', {
        method: 'POST',
        body: {
          ...(provider?.id ? { existingProviderId: provider.id } : {}),
          baseUrl: normalizeProviderBaseUrl(form.elements.baseUrl.value),
          authMode: form.elements.authMode.value,
          credentials: discoveryCredentials
        }
      })
      : await api(`/api/providers/${provider.id}/keys`);
    if ((provider?.id && form.elements.id.value !== provider.id) || !$('#provider-dialog').open) return;
    state.keys = [
      ...state.keys.filter((key) => key.connection_id !== connectionId),
      ...(result.items || []).map((key) => ({
        ...key,
        connection_id: connectionId,
        ...(usesLiveSub2ApiDiscovery ? { key_option_source: 'remote' } : {})
      }))
    ];
    renderMonitoredApiKeyOptions(form, provider);
  } catch (error) {
    if ((provider?.id && form.elements.id.value !== provider.id) || !$('#provider-dialog').open) return;
    const savedSource = provider?.typeConfig?.apiKeySource ||
      (provider?.configuredApiKeys?.length ? 'manual' : null);
    if (
      usesLiveSub2ApiDiscovery &&
      form.elements.authMode.value === 'api_key' &&
      savedSource !== 'remote'
    ) {
      const connectionId = provider?.id || form.elements.id.value || 'provider-form-preview';
      state.keys = state.keys.filter((key) =>
        key.connection_id !== connectionId || key.key_option_source !== 'remote'
      );
    }
    renderMonitoredApiKeyOptions(form, provider);
    toast(error.message, 'error');
  }
}

function providerDefaults(adapter) {
  if (adapter === 'openrouter') return 'https://openrouter.ai';
  if (adapter === 'deepseek') return 'https://api.deepseek.com';
  return '';
}

function adapterLabel(adapterType) {
  return ADAPTERS.find(([type]) => type === adapterType)?.[1] || adapterType || '未知平台';
}

function normalizeProviderBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请先填写基础地址');
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('基础地址格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('基础地址必须是有效的 HTTP 或 HTTPS 地址');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function setProviderDetectionStatus(kind = 'idle', message = '') {
  const status = $('#provider-detection-status');
  const button = $('[data-action="detect-provider"]', $('#provider-form'));
  if (!status || !button) return;
  const iconByKind = {
    loading: 'loader-circle', success: 'badge-check', warning: 'triangle-alert', error: 'circle-alert'
  };
  status.className = `provider-detection-status${kind === 'idle' ? '' : ` is-${kind}`}`;
  status.innerHTML = message
    ? `<i data-lucide="${iconByKind[kind] || 'info'}"></i><span>${escapeHtml(message)}</span>`
    : '';
  button.disabled = kind === 'loading';
  button.innerHTML = kind === 'loading'
    ? '<i class="spin" data-lucide="loader-circle"></i><span>识别中</span>'
    : '<i data-lucide="scan-search"></i><span>重新识别</span>';
  icons();
}

function cancelProviderDetection({ clearStatus = false } = {}) {
  clearTimeout(providerDetectionTimer);
  providerDetectionTimer = null;
  providerDetectionController?.abort();
  providerDetectionController = null;
  providerDetectionSequence += 1;
  if (clearStatus) setProviderDetectionStatus();
}

function applyProviderAdapter(form, adapterType, { fromDetection = false } = {}) {
  form.elements.adapterType.value = adapterType;
  form.elements.authMode.value = ADAPTER_AUTH_MODES[adapterType] || 'api_key';
  renderCredentialFields(adapterType, null, form.elements.authMode.value);
  form.dataset.credentialsTouched = 'false';
  form.dataset.autoDetectedAdapter = fromDetection ? adapterType : '';
  updateDynamicRouteRateFields(form);
  renderMonitoredApiKeyOptions(form);
}

function updateDynamicRouteRateFields(form) {
  const fieldset = $('#dynamic-route-rate-fieldset');
  if (!fieldset) return;
  if (!form.elements.dynamicRouteRateEnabled) return;
  const supported = DYNAMIC_ROUTE_RATE_ADAPTERS.has(form.elements.adapterType.value);
  fieldset.hidden = !supported;
  const enabledControl = form.elements.dynamicRouteRateEnabled;
  enabledControl.disabled = !supported;
  if (!supported) enabledControl.checked = false;
  const active = supported && enabledControl.checked;
  for (const name of [
    'dynamicRouteRateStatistic', 'dynamicRouteRateLookbackDays', 'dynamicRouteRateMinimumSamples'
  ]) {
    if (form.elements[name]) form.elements[name].disabled = !active;
  }
}

async function detectProvider(form, { manual = false } = {}) {
  const baseUrl = normalizeProviderBaseUrl(form.elements.baseUrl.value);
  form.elements.baseUrl.value = baseUrl;
  clearTimeout(providerDetectionTimer);
  providerDetectionTimer = null;
  providerDetectionController?.abort();
  const controller = new AbortController();
  providerDetectionController = controller;
  const sequence = ++providerDetectionSequence;
  setProviderDetectionStatus('loading', '正在识别供应商');

  try {
    const result = await api('/api/providers/detect', {
      method: 'POST',
      body: { baseUrl },
      signal: controller.signal
    });
    if (sequence !== providerDetectionSequence) return null;
    if (normalizeProviderBaseUrl(form.elements.baseUrl.value) !== baseUrl) return null;

    form.elements.baseUrl.value = normalizeProviderBaseUrl(result.baseUrl || baseUrl);
    const detected = result.recommended?.adapterType;
    const confidence = Number(result.recommended?.confidence || 0);
    const knownAdapter = ADAPTERS.some(([type]) => type === detected);
    const selectionLocked = form.dataset.adapterTouched === 'true'
      || form.dataset.credentialsTouched === 'true'
      || $$('[data-credential]', form).some((input) => input.value.trim());
    const autoApplicable = knownAdapter
      && detected !== 'custom'
      && !result.ambiguous
      && confidence >= AUTO_DETECTION_MIN_CONFIDENCE
      && !selectionLocked;
    const applied = manual ? knownAdapter : autoApplicable;
    if (applied) {
      if (manual) form.dataset.adapterTouched = 'false';
      applyProviderAdapter(form, detected, { fromDetection: true });
    }

    const confidenceText = `${Math.round(confidence * 100)}%`;
    const detectedLabel = adapterLabel(detected);
    let kind = 'success';
    let message = `已识别为 ${detectedLabel}（${confidenceText}）`;
    if (!knownAdapter || detected === 'custom') {
      kind = 'warning';
      message = manual ? '未识别到已支持的平台，已选择自定义适配器' : '未能可靠识别，请手动选择适配器';
    } else if (result.ambiguous) {
      const candidates = (result.suggestions || [])
        .filter((item) => ADAPTERS.some(([type]) => type === item.adapterType) && item.adapterType !== 'custom')
        .slice(0, 2)
        .map((item) => adapterLabel(item.adapterType));
      kind = 'warning';
      message = `可能为 ${candidates.join(' / ') || detectedLabel}，请确认适配器`;
    } else if (!manual && confidence < AUTO_DETECTION_MIN_CONFIDENCE) {
      kind = 'warning';
      message = `可能为 ${detectedLabel}（${confidenceText}），请确认适配器`;
    } else if (!applied && form.elements.adapterType.value !== detected) {
      kind = 'warning';
      message = `识别为 ${detectedLabel}（${confidenceText}），已保留手动选择`;
    }
    setProviderDetectionStatus(kind, message);
    return { result, applied, message };
  } catch (error) {
    if (error.name === 'AbortError') return null;
    if (sequence === providerDetectionSequence) {
      setProviderDetectionStatus('error', '自动识别失败，可手动重试');
    }
    throw error;
  } finally {
    if (sequence === providerDetectionSequence) providerDetectionController = null;
  }
}

function scheduleProviderDetection(form, delay = 650) {
  if (form.elements.id.value) return;
  cancelProviderDetection({ clearStatus: true });
  if (!form.elements.baseUrl.value.trim()) return;
  try {
    normalizeProviderBaseUrl(form.elements.baseUrl.value);
  } catch {
    return;
  }
  providerDetectionTimer = setTimeout(() => {
    detectProvider(form).catch(() => {});
  }, delay);
}

function openProviderDialog(provider = null) {
  const form = $('#provider-form');
  cancelProviderDetection({ clearStatus: true });
  form.reset();
  form.dataset.adapterTouched = 'false';
  form.dataset.credentialsTouched = 'false';
  form.dataset.autoDetectedAdapter = '';
  form.elements.id.value = provider?.id || '';
  form.elements.name.value = provider?.name || '';
  form.elements.adapterType.innerHTML = ADAPTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  form.elements.adapterType.value = provider?.adapter_type || 'sub2api';
  form.elements.baseUrl.value = provider?.base_url || '';
  form.elements.authMode.value = provider?.auth_mode || ADAPTER_AUTH_MODES[provider?.adapter_type || 'sub2api'];
  form.elements.remoteUserId.value = provider?.remote_user_id || '';
  form.elements.refreshIntervalMinutes.value = provider?.refresh_interval_minutes || 15;
  form.elements.warningThreshold.value = provider?.warning_threshold ?? '';
  form.elements.secondaryWarningThreshold.value = provider?.secondary_warning_threshold ?? '';
  form.elements.thresholdCurrency.value = provider?.threshold_currency || 'USD';
  form.elements.rechargeMultiplier.value = provider?.recharge?.manualMultiplier ?? '';
  form.elements.rechargeUrl.value = provider?.rechargeUrl || '';
  form.elements.rechargeLoginMode.value = provider?.typeConfig?.rechargeLogin?.enabled === true ? 'adapter' : 'direct';
  const dynamicRouteRate = provider?.typeConfig?.dynamicRouteRate === true
    ? { enabled: true }
    : provider?.typeConfig?.dynamicRouteRate || {};
  form.elements.dynamicRouteRateEnabled.checked = dynamicRouteRate.enabled === true;
  form.elements.dynamicRouteRateStatistic.value = dynamicRouteRate.statistic || 'median';
  form.elements.dynamicRouteRateLookbackDays.value = dynamicRouteRate.lookbackDays || 30;
  form.elements.dynamicRouteRateMinimumSamples.value = dynamicRouteRate.minimumSamples || 3;
  form.elements.accountDedupeKey.value = provider?.account_dedupe_key || '';
  form.elements.enabled.checked = provider?.enabled ?? true;
  form.elements.typeConfig.value = JSON.stringify(provider?.typeConfig || {}, null, 2);
  form.elements.tags.value = (provider?.tags || []).join(', ');
  form.elements.note.value = provider?.note || '';
  $('#provider-dialog-title').textContent = provider ? '编辑供应商' : '添加供应商';
  $('#provider-form-error').textContent = '';
  renderCredentialFields(form.elements.adapterType.value, provider, form.elements.authMode.value);
  updateDynamicRouteRateFields(form);
  renderMonitoredApiKeyOptions(form, provider);
  $('#provider-dialog').showModal();
  icons();
  loadMonitoredApiKeyOptions(form, provider);
}

function providerBalanceThresholds(form) {
  const warningThreshold = form.elements.warningThreshold.value === ''
    ? null
    : Number(form.elements.warningThreshold.value);
  const secondaryWarningThreshold = form.elements.secondaryWarningThreshold.value === ''
    ? null
    : Number(form.elements.secondaryWarningThreshold.value);
  if (secondaryWarningThreshold != null && warningThreshold == null) {
    throw new Error('设置二级余额阈值前，请先填写一级余额阈值');
  }
  if (secondaryWarningThreshold != null && secondaryWarningThreshold >= warningThreshold) {
    throw new Error('二级余额阈值必须小于一级余额阈值');
  }
  return { warningThreshold, secondaryWarningThreshold };
}

function providerPayload(form) {
  const credentials = {};
  const usesApiKeyEditor = usesMultipleApiKeyEditor(
    form.elements.adapterType.value,
    form.elements.authMode.value
  );
  const configuredApiKeySource = usesApiKeyEditor
    ? selectedSub2ApiKeySource(form)
    : null;
  let configuredApiKeySelection = null;
  $$('[data-credential]', form).forEach((input) => { if (input.value) credentials[input.dataset.credential] = input.value; });
  if (usesApiKeyEditor && configuredApiKeySource === 'manual') {
    const rows = $$('[data-provider-api-key-row]', form);
    if (rows.length === 0) throw new Error('至少配置一个 API Key');
    configuredApiKeySelection = [];
    credentials.apiKeys = rows.map((row, index) => {
      const id = $('[data-api-key-id]', row).value.trim();
      const name = $('[data-api-key-name]', row).value.trim() || `API Key ${index + 1}`;
      const keyInput = $('[data-api-key-value]', row);
      const key = keyInput.value.trim();
      if (keyInput.required && !key) throw new Error(`请填写 ${name} 的 API Key`);
      const monitoredInput = $('[data-api-key-monitored]', row);
      if (!monitoredInput || monitoredInput.checked) configuredApiKeySelection.push(id);
      return { ...(id ? { id } : {}), name, ...(key ? { key } : {}) };
    });
    if (configuredApiKeySelection.length === 0) throw new Error('至少选择一个监控 API Key');
  }
  let typeConfig;
  try { typeConfig = JSON.parse(form.elements.typeConfig.value || '{}'); } catch { throw new Error('高级配置不是有效 JSON'); }
  typeConfig.dynamicRouteRate = {
    enabled: DYNAMIC_ROUTE_RATE_ADAPTERS.has(form.elements.adapterType.value) &&
      form.elements.dynamicRouteRateEnabled.checked,
    statistic: form.elements.dynamicRouteRateStatistic.value || 'median',
    lookbackDays: Number(form.elements.dynamicRouteRateLookbackDays.value || 30),
    minimumSamples: Number(form.elements.dynamicRouteRateMinimumSamples.value || 3)
  };
  typeConfig.rechargeLogin = {
    ...(typeConfig.rechargeLogin && typeof typeConfig.rechargeLogin === 'object' ? typeConfig.rechargeLogin : {}),
    enabled: form.elements.rechargeLoginMode?.value === 'adapter'
  };
  if (configuredApiKeySource) typeConfig.apiKeySource = configuredApiKeySource;
  else delete typeConfig.apiKeySource;
  if (configuredApiKeySelection) {
    typeConfig.monitoredKeyIds = configuredApiKeySelection;
  } else if (formUsesRemoteApiKeySelection(form)) {
    const options = $$('[data-monitored-api-key]', form);
    if (usesApiKeyEditor && options.length === 0) throw new Error('请先刷新远端 Key 列表');
    const monitoredKeyIds = options.filter((input) => input.checked).map((input) => input.value);
    if (options.length > 0 && monitoredKeyIds.length === 0) throw new Error('至少选择一个监控 API Key');
    if (options.length > 0) typeConfig.monitoredKeyIds = monitoredKeyIds;
  } else {
    delete typeConfig.monitoredKeyIds;
  }
  const balanceThresholds = providerBalanceThresholds(form);
  return {
    name: form.elements.name.value.trim(), adapterType: form.elements.adapterType.value,
    baseUrl: normalizeProviderBaseUrl(form.elements.baseUrl.value), authMode: form.elements.authMode.value,
    credentials, remoteUserId: form.elements.remoteUserId.value.trim() || null,
    enabled: form.elements.enabled.checked, refreshIntervalMinutes: Number(form.elements.refreshIntervalMinutes.value || 15),
    ...balanceThresholds,
    thresholdCurrency: form.elements.thresholdCurrency.value.trim() || 'USD',
    rechargeMultiplier: form.elements.rechargeMultiplier.value === '' ? null : Number(form.elements.rechargeMultiplier.value),
    rechargeUrl: form.elements.rechargeUrl.value.trim() || null,
    typeConfig,
    tags: form.elements.tags.value.split(',').map((x) => x.trim()).filter(Boolean), note: form.elements.note.value.trim(),
    accountDedupeKey: form.elements.accountDedupeKey.value.trim() || null
  };
}

function providerValidationPayload(form) {
  const payload = providerPayload(form);
  const existingProviderId = String(form.elements.id.value || '').trim();
  return existingProviderId ? { ...payload, existingProviderId } : payload;
}

function fillProviderSelect(select, selected = '') {
  select.innerHTML = `<option value="">全部</option>${state.providers.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}`;
  select.value = selected || '';
}

const ALERT_RULE_FIELD_CONFIG = Object.freeze({
  low_balance: { fields: ['scope', 'threshold', 'currency', 'consecutiveMatches'], thresholdLabel: '余额阈值', min: '0', step: '0.01' },
  runway_below: { fields: ['threshold', 'currency'], thresholdLabel: '可用天数阈值', min: '0', step: '0.1' },
  stale_data: { fields: ['threshold'], thresholdLabel: '陈旧时间（分钟）', min: '1', step: '1' },
  sync_failed: { fields: [] },
  key_expiry: { fields: ['threshold'], thresholdLabel: '提前预警（天）', min: '0', step: '1' },
  key_disabled: { fields: [] },
  rate_mismatch: { fields: ['groupId', 'comparisonOperator', 'threshold'], thresholdLabel: '偏差阈值（%）', min: '', step: '0.01' },
  asset_drift: { fields: [] },
  contract_changed: { fields: [] },
  anomaly: { fields: [] },
  credential_expiry: { fields: ['threshold'], thresholdLabel: '最长未轮换（天）', min: '1', step: '1' },
  automation_failed: { fields: [] }
});

function alertRuleFieldConfig(ruleType) {
  return ALERT_RULE_FIELD_CONFIG[ruleType] || { fields: [] };
}

function updateAlertRuleFields(form = $('#alert-rule-form'), { resetValues = false } = {}) {
  const config = alertRuleFieldConfig(form.elements.ruleType.value);
  const activeFields = new Set(config.fields);
  form.querySelectorAll('[data-alert-field]').forEach((field) => {
    field.hidden = !activeFields.has(field.dataset.alertField);
  });
  for (const fieldName of ['scope', 'threshold', 'currency', 'consecutiveMatches', 'comparisonOperator', 'groupId']) {
    form.elements[fieldName].required = fieldName !== 'groupId' && activeFields.has(fieldName);
  }
  form.elements.threshold.min = config.min || '';
  form.elements.threshold.step = config.step || 'any';
  $('#alert-threshold-label').textContent = config.thresholdLabel || '阈值';
  if (resetValues) {
    form.elements.scope.value = 'account';
    form.elements.threshold.value = '';
    form.elements.currency.value = 'USD';
    form.elements.consecutiveMatches.value = '1';
    form.elements.comparisonOperator.value = 'lt';
    form.elements.groupId.value = '';
  }
}

function updateAlertGroupOptions(selected = '') {
  const form = $('#alert-rule-form');
  const connectionId = form.elements.connectionId.value;
  const groups = new Map();
  for (const mapping of state.mappings) {
    if (connectionId && mapping.connection_id !== connectionId) continue;
    const groupId = Number(mapping.group_id);
    if (!Number.isInteger(groupId) || groupId <= 0 || groups.has(groupId)) continue;
    groups.set(groupId, mapping.comparison?.baseGroupName || `分组 #${groupId}`);
  }
  const selectedId = Number(selected);
  const missingOption = selected && !groups.has(selectedId)
    ? `<option value="${escapeHtml(selected)}">分组 #${escapeHtml(selected)}（当前无映射）</option>`
    : '';
  form.elements.groupId.innerHTML = `<option value="">全部已映射分组</option>${missingOption}${[...groups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([id, name]) => `<option value="${id}">${escapeHtml(name)} · #${id}</option>`).join('')}`;
  form.elements.groupId.value = selected || '';
}

function openAlertRule(rule = null) {
  const form = $('#alert-rule-form'); form.reset();
  form.dataset.config = JSON.stringify(rule?.config || {});
  form.elements.id.value = rule?.id || ''; form.elements.name.value = rule?.name || '';
  form.elements.ruleType.value = rule?.rule_type || 'low_balance'; fillProviderSelect(form.elements.connectionId, rule?.connection_id);
  updateAlertGroupOptions(rule?.config?.groupId || '');
  form.elements.scope.value = rule?.scope || 'account';
  form.elements.threshold.value = rule?.threshold ?? ''; form.elements.currency.value = rule?.currency || 'USD';
  form.elements.comparisonOperator.value = rule?.config?.comparisonOperator || (rule ? 'abs_gt' : 'lt');
  form.elements.consecutiveMatches.value = rule?.consecutive_matches || 1; form.elements.cooldownMinutes.value = rule?.cooldown_minutes || 60;
  form.elements.enabled.checked = rule?.enabled ?? true; updateAlertRuleFields(); $('#alert-rule-dialog').showModal(); icons();
}

function alertRulePayload(form) {
  const activeFields = new Set(alertRuleFieldConfig(form.elements.ruleType.value).fields);
  const config = { ...JSON.parse(form.dataset?.config || '{}') };
  if (form.elements.ruleType.value === 'rate_mismatch') {
    config.comparisonOperator = form.elements.comparisonOperator.value;
    if (form.elements.groupId.value) config.groupId = Number(form.elements.groupId.value);
    else delete config.groupId;
  } else {
    delete config.comparisonOperator;
    delete config.groupId;
  }
  return {
    name: form.elements.name.value.trim(),
    ruleType: form.elements.ruleType.value,
    connectionId: form.elements.connectionId.value || null,
    scope: activeFields.has('scope') ? form.elements.scope.value : 'account',
    threshold: activeFields.has('threshold') && form.elements.threshold.value !== ''
      ? Number(form.elements.threshold.value)
      : null,
    currency: activeFields.has('currency') ? form.elements.currency.value.trim() || null : null,
    consecutiveMatches: activeFields.has('consecutiveMatches') ? Number(form.elements.consecutiveMatches.value) : 1,
    cooldownMinutes: Number(form.elements.cooldownMinutes.value),
    enabled: form.elements.enabled.checked,
    config
  };
}

function openChannel(channel = null) {
  const form = $('#notification-form'); form.reset();
  form.elements.id.value = channel?.id || ''; form.elements.name.value = channel?.name || '';
  form.elements.type.value = channel?.type || 'webhook'; form.elements.config.value = JSON.stringify(channel?.config || {}, null, 2);
  form.elements.credentials.value = '{}'; form.elements.enabled.checked = channel?.enabled ?? true;
  $('#notification-dialog').showModal(); icons();
}

function openAutomation(rule = null) {
  const form = $('#automation-form'); form.reset();
  form.elements.id.value = rule?.id || ''; form.elements.name.value = rule?.name || '';
  form.elements.triggerType.value = rule?.trigger_type || 'low_balance'; fillProviderSelect(form.elements.connectionId, rule?.connection_id);
  form.elements.threshold.value = rule?.config?.threshold ?? ''; form.elements.currency.value = rule?.config?.currency || 'USD';
  form.elements.accountIds.value = (rule?.config?.accountIds || []).join(', ');
  form.elements.channelIds.value = (rule?.config?.channelIds || []).join(', ');
  form.elements.action.value = rule?.config?.action || 'disable_sub2api_account';
  form.elements.scheduleIntervalMinutes.value = rule?.config?.scheduleIntervalMinutes || 1440;
  form.elements.scheduledConditionType.value = rule?.config?.condition?.type || '';
  form.elements.scheduledConditionOperator.value = rule?.config?.condition?.operator || 'lt';
  form.elements.scheduledConditionThreshold.value = rule?.config?.condition?.threshold ?? 0;
  form.elements.onMatchAction.value = rule?.config?.onMatchAction || 'disable_sub2api_account';
  form.elements.consecutiveMatches.value = rule?.config?.consecutiveMatches || 2;
  form.elements.cooldownMinutes.value = rule?.config?.cooldownMinutes || 60;
  form.elements.dailyMaximumActions.value = rule?.config?.dailyMaximumActions || 10;
  form.elements.contractPauseHours.value = rule?.config?.contractPauseHours || 24;
  form.elements.webhookUrl.value = rule?.config?.webhookUrl || '';
  form.elements.enabled.checked = rule?.enabled ?? false; form.elements.dryRun.checked = rule?.dryRun ?? true;
  form.elements.notifyOnAction.checked = rule?.config?.notifyOnAction ?? false;
  updateAutomationActionFields(form);
  $('#automation-dialog').showModal(); icons();
}

function automationUsesChannelIds(action) {
  return ['switch_to_backup', 'remind_credential_rotation', 'create_route_recommendation'].includes(action);
}

function automationUsesAccountIds(action) {
  return ['disable_sub2api_account', 'enable_sub2api_account'].includes(action);
}

function updateAutomationActionFields(form = $('#automation-form')) {
  const scheduled = form.elements.triggerType.value === 'scheduled';
  const hasScheduledCondition = scheduled && Boolean(form.elements.scheduledConditionType.value);
  if (scheduled && form.elements.action.value !== 'rebuild_sub2api_mappings') {
    form.elements.action.value = 'rebuild_sub2api_mappings';
  } else if (!scheduled && form.elements.action.value === 'rebuild_sub2api_mappings') {
    form.elements.action.value = 'disable_sub2api_account';
  }
  const usesAccountIds = automationUsesAccountIds(form.elements.action.value);
  const usesChannelIds = automationUsesChannelIds(form.elements.action.value);
  const usesWebhook = form.elements.action.value === 'trigger_recharge_webhook';
  const accountField = form.querySelector('[data-automation-account-field]');
  const channelField = form.querySelector('[data-automation-channel-field]');
  const webhookField = form.querySelector('[data-automation-webhook-field]');
  const scheduleField = form.querySelector('[data-automation-schedule-field]');
  const scheduledConditionSelector = form.querySelector('[data-automation-scheduled-condition-selector]');
  accountField.hidden = !usesAccountIds;
  channelField.hidden = !usesChannelIds;
  webhookField.hidden = !usesWebhook;
  scheduleField.hidden = !scheduled;
  scheduledConditionSelector.hidden = !scheduled;
  for (const field of form.querySelectorAll('[data-automation-scheduled-condition-field]')) {
    field.hidden = !hasScheduledCondition;
  }
  for (const field of form.querySelectorAll('[data-automation-event-field]')) field.hidden = scheduled;
  $('#automation-action-label').textContent = scheduled ? '前置动作' : '动作';
  form.elements.action.disabled = scheduled;
  form.elements.connectionId.disabled = scheduled;
  form.elements.threshold.disabled = scheduled;
  form.elements.currency.disabled = scheduled;
  form.elements.consecutiveMatches.disabled = scheduled;
  form.elements.accountIds.required = usesAccountIds;
  form.elements.channelIds.required = usesChannelIds;
  form.elements.webhookUrl.required = usesWebhook;
  form.elements.scheduleIntervalMinutes.required = scheduled;
  form.elements.scheduleIntervalMinutes.disabled = !scheduled;
  form.elements.scheduledConditionType.disabled = !scheduled;
  form.elements.scheduledConditionOperator.required = hasScheduledCondition;
  form.elements.scheduledConditionOperator.disabled = !hasScheduledCondition;
  form.elements.scheduledConditionThreshold.required = hasScheduledCondition;
  form.elements.scheduledConditionThreshold.disabled = !hasScheduledCondition;
  form.elements.onMatchAction.required = hasScheduledCondition;
  form.elements.onMatchAction.disabled = !hasScheduledCondition;
}

function automationPayload(form) {
  const scheduled = form.elements.triggerType.value === 'scheduled';
  const scheduledCondition = scheduled && form.elements.scheduledConditionType.value
    ? {
        type: form.elements.scheduledConditionType.value,
        operator: form.elements.scheduledConditionOperator.value,
        threshold: Number(form.elements.scheduledConditionThreshold.value)
      }
    : null;
  const accountIds = automationUsesAccountIds(form.elements.action.value)
    ? form.elements.accountIds.value.split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
    : [];
  const channelIds = automationUsesChannelIds(form.elements.action.value)
    ? form.elements.channelIds.value.split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
    : [];
  return {
    name: form.elements.name.value,
    triggerType: form.elements.triggerType.value,
    connectionId: scheduled ? null : form.elements.connectionId.value || null,
    enabled: form.elements.enabled.checked,
    dryRun: form.elements.dryRun.checked,
    config: {
      ...(scheduled ? {} : {
        threshold: form.elements.threshold.value === '' ? undefined : Number(form.elements.threshold.value),
        currency: form.elements.currency.value,
        consecutiveMatches: Number(form.elements.consecutiveMatches.value)
      }),
      ...(automationUsesAccountIds(form.elements.action.value) ? { accountIds } : {}),
      ...(automationUsesChannelIds(form.elements.action.value) ? { channelIds } : {}),
      action: form.elements.action.value,
      ...(scheduled ? {
        scheduleIntervalMinutes: Number(form.elements.scheduleIntervalMinutes.value),
        ...(scheduledCondition ? {
          condition: scheduledCondition,
          onMatchAction: form.elements.onMatchAction.value,
          targetMode: 'matched_mapping_accounts'
        } : {})
      } : {}),
      cooldownMinutes: Number(form.elements.cooldownMinutes.value),
      contractPauseHours: Number(form.elements.contractPauseHours.value),
      dailyMaximumActions: Number(form.elements.dailyMaximumActions.value),
      notifyOnAction: form.elements.notifyOnAction.checked,
      ...(!scheduled && form.elements.webhookUrl.value ? { webhookUrl: form.elements.webhookUrl.value } : {})
    }
  };
}

function updateMappingKeyOptions(selected = '') {
  const form = $('#mapping-form');
  const connectionId = form.elements.connectionId.value;
  const keys = state.keys.filter((key) => key.connection_id === connectionId);
  form.elements.keyId.innerHTML = `<option value="">账户级</option>${keys.map((key) => `<option value="${key.id}">${escapeHtml(key.name)} · ${escapeHtml(key.masked_key)}</option>`).join('')}`;
  form.elements.keyId.value = selected || '';
}

function updateMappingProviderGroupOptions(selected = '') {
  const form = $('#mapping-form');
  const connectionId = form.elements.connectionId.value;
  const groups = state.groups.filter((group) => group.connection_id === connectionId && group.status !== 'missing');
  form.elements.upstreamGroupRef.innerHTML = `<option value="">按 Key / 名称自动匹配</option>${groups.map((group) => `<option value="${escapeHtml(group.remote_id)}">${escapeHtml(group.name)} · ${formatEffectiveRate(group.ratio)}</option>`).join('')}`;
  form.elements.upstreamGroupRef.value = selected || '';
}

function updateMappingBaseGroupOptions(selected = '') {
  const form = $('#mapping-form');
  const groups = state.sub2apiGroups;
  const selectedExists = groups.some((group) => Number(group.id) === Number(selected));
  const missingOption = selected && !selectedExists ? `<option value="${escapeHtml(selected)}">分组 #${escapeHtml(selected)}（当前不可用）</option>` : '';
  form.elements.groupId.innerHTML = `<option value="">选择分组</option>${missingOption}${groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)} · ${formatEffectiveRate(group.effectiveRate)}</option>`).join('')}`;
  form.elements.groupId.value = selected || '';
}

async function openMappingDialog(mapping = null) {
  const [keys, groups, [baseGroups, monitors], settings] = await Promise.all([
    api('/api/keys'), api('/api/groups'),
    withSub2ApiTwoFactor(() => Promise.all([
      api('/api/sub2api/groups'),
      api('/api/sub2api/channel-monitors')
    ])),
    api('/api/settings')
  ]);
  state.keys = keys.items;
  state.groups = groups.items;
  state.sub2apiGroups = baseGroups.items;
  state.sub2apiMonitors = monitors.items || [];
  state.settings = settings;
  const form = $('#mapping-form'); form.reset();
  form.dataset.config = JSON.stringify(mapping?.config || {});
  form.elements.id.value = mapping?.id || '';
  form.elements.connectionId.innerHTML = state.providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join('');
  form.elements.connectionId.value = mapping?.connection_id || state.providers[0]?.id || '';
  updateMappingKeyOptions(mapping?.key_id || '');
  updateMappingProviderGroupOptions(mapping?.config?.upstreamGroupRef || '');
  updateMappingBaseGroupOptions(mapping?.group_id || '');
  form.elements.accountId.value = mapping?.account_id || '';
  form.elements.role.value = mapping?.role || 'primary';
  form.elements.models.value = (mapping?.models || []).join(', ');
  form.elements.rateTolerancePercent.value = ((mapping?.config?.rateToleranceRatio ?? state.settings?.sub2apiRateToleranceRatio ?? 0.05) * 100).toFixed(1);
  form.elements.channelMonitorId.innerHTML = `<option value="">不关联</option>${state.sub2apiMonitors.map((monitor) => `<option value="${monitor.id}">${escapeHtml(monitor.name || `Monitor #${monitor.id}`)}</option>`).join('')}`;
  form.elements.channelMonitorId.value = mapping?.config?.channelMonitorId || '';
  form.elements.autoReconcile.checked = mapping?.config?.autoReconcile ?? false;
  form.elements.enabled.checked = mapping?.enabled ?? true;
  $('#mapping-dialog').showModal(); icons();
}

function openCredentialDialog(provider) {
  const form = $('#credential-form'); form.reset();
  form.elements.providerId.value = provider.id;
  const configured = CREDENTIAL_FIELDS[provider.adapter_type] || CREDENTIAL_FIELDS.custom;
  const knownNames = new Set(configured.map(([name]) => name));
  const fields = [...configured, ...(provider.credentialFields || []).filter((field) => !knownNames.has(field.name)).map((field) => [field.name, field.name, 'password'])];
  $('#rotation-credential-fields').innerHTML = fields.map(([name, label, type]) => {
    const existing = provider.credentialFields?.find((field) => field.name === name);
    return `<label><span>${escapeHtml(label)}</span><input data-rotation-credential="${escapeHtml(name)}" type="${type}" placeholder="${existing ? `当前 ${escapeHtml(existing.masked)}` : ''}" autocomplete="off"></label>`;
  }).join('');
  $('#credential-dialog').showModal(); icons();
}

function ensureReauth() {
  if (state.authentication?.mode === 'sub2api') {
    return api('/api/auth/reauth', { method: 'POST', body: {} });
  }
  const dialog = $('#reauth-dialog');
  const form = $('#reauth-form');
  form.reset();
  form.elements.identity.value = state.user?.name || '';
  $('#reauth-error').textContent = '';
  dialog.showModal();
  icons();
  return new Promise((resolve, reject) => {
    state.reauthResolve = resolve;
    state.reauthReject = reject;
  });
}

async function withRecentReauth(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error.code !== 'REAUTH_REQUIRED') throw error;
    await ensureReauth();
    return operation();
  }
}

function openImportDialog() {
  const form = $('#import-form'); form.reset();
  state.importPreview = null;
  $('#import-preview').innerHTML = '';
  $('button[type="submit"]', form).disabled = true;
  $('#import-dialog').showModal(); icons();
}

function downloadJson(filename, payload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleAction(button) {
  const { action, id } = button.dataset;
  if (!action) return;
  try {
    if (action === 'open-account-monitor-settings') openAccountMonitorSettings();
    if (action === 'open-account-metric-rules') openAccountMetricRules(button.dataset.ruleTarget);
    if (action === 'sync-account-monitor') {
      const result = await withSub2ApiTwoFactor(() => api('/api/account-monitor/sync', { method: 'POST', body: {} }));
      trackAccountMonitorJob(result.jobId, '账号日志同步').catch((error) => toast(error.message, 'error'));
    }
    if (action === 'detect-account' || action === 'detect-selected-accounts') {
      const accountIds = action === 'detect-account'
        ? [String(id)]
        : [...state.accountMonitorSelected];
      if (accountIds.length === 0) return toast('请先选择需要检测的账号', 'error');
      if (accountIds.length > 20 && !confirm(`本次将主动检测 ${accountIds.length} 个账号并产生上游请求，确认继续？`)) return;
      const result = await withSub2ApiTwoFactor(() => api('/api/account-monitor/probes', {
        method: 'POST',
        body: { accountIds }
      }));
      trackAccountMonitorJob(result.jobId, '账号主动检测').catch((error) => toast(error.message, 'error'));
    }
    if (action === 'view-account-quality') await loadAccountMonitorDetail(id);
    if (action === 'account-monitor-display') {
      const display = String(button.dataset.display || 'providers');
      state.accountMonitorFilters.display = ['providers', 'groups', 'accounts'].includes(display)
        ? display
        : 'providers';
      state.accountMonitorFilters.groupId = '';
      state.accountMonitorFilters.sortBy = 'qualityScore';
      state.accountMonitorFilters.order = 'desc';
      state.accountMonitorFilters.page = 1;
      state.accountMonitorDetail = null;
      await renderAccountMonitor();
    }
    if (action === 'toggle-account-monitor-group') {
      const groupId = String(button.dataset.groupId || '');
      if (!groupId) return;
      if (state.accountMonitorExpandedGroups.has(groupId)) {
        state.accountMonitorExpandedGroups.delete(groupId);
      } else {
        state.accountMonitorExpandedGroups.add(groupId);
      }
      repaintAccountMonitorGroupTable();
    }
    if (action === 'toggle-account-monitor-provider') {
      const providerId = String(button.dataset.providerId || '');
      if (!providerId) return;
      if (state.accountMonitorExpandedProviders.has(providerId)) {
        state.accountMonitorExpandedProviders.delete(providerId);
      } else {
        state.accountMonitorExpandedProviders.add(providerId);
      }
      repaintAccountMonitorProviderTable();
    }
    if (action === 'edit-provider-recharge-audit') {
      const provider = (state.accountMonitor?.items || []).find(
        (item) => String(item.connectionId) === String(id)
      );
      if (provider) openProviderRechargeAudit(provider);
    }
    if (action === 'close-account-quality') {
      state.accountMonitorDetail = null;
      state.chart?.dispose?.();
      state.chart = null;
      const root = $('#account-monitor-detail');
      if (root) root.innerHTML = '';
    }
    if (action === 'account-monitor-page') {
      state.accountMonitorFilters.page = Number(button.dataset.page) || 1;
      await renderAccountMonitor();
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    if (action === 'download') await downloadFile(button.dataset.url, button.dataset.filename);
    if (action === 'save-system-settings') await saveSystemSettings($('#system-settings-form'));
    if (action === 'add-provider') openProviderDialog();
    if (action === 'add-provider-api-key') {
      const list = $('[data-provider-api-key-list]', $('#provider-form'));
      if (list) {
        list.insertAdjacentHTML('beforeend', providerApiKeyRow({}, $$('[data-provider-api-key-row]', list).length));
        $('#provider-form').dataset.credentialsTouched = 'true';
        icons();
      }
    }
    if (action === 'remove-provider-api-key') {
      button.closest('[data-provider-api-key-row]')?.remove();
      $('#provider-form').dataset.credentialsTouched = 'true';
    }
    if (action === 'refresh-provider-key-options') {
      const form = $('#provider-form');
      const provider = state.providers.find((item) => item.id === form.elements.id.value) || null;
      button.disabled = true;
      try { await loadMonitoredApiKeyOptions(form, provider); } finally { button.disabled = false; }
    }
    if (action === 'edit-provider') openProviderDialog(state.providers.find((p) => p.id === id));
    if (action === 'delete-provider' && confirm('删除该供应商及其历史快照？')) { await api(`/api/providers/${id}`, { method: 'DELETE' }); toast('供应商已删除'); navigate('providers'); }
    if (action === 'clone-provider') { await api(`/api/providers/${id}/clone`, { method: 'POST', body: {} }); toast('已复制连接，凭据为空且默认停用'); navigate('providers'); }
    if (action === 'sync-provider') { await api(`/api/providers/${id}/sync`, { method: 'POST' }); toast('同步任务已加入队列'); setTimeout(() => navigate(state.view), 1200); }
    if (action === 'open-recharge') {
      await ensureReauth();
      const result = await api(`/api/providers/${id}/recharge-link`, { method: 'POST', body: {} });
      window.location.assign(result.url);
      return;
    }
    if (action === 'sync-all') { await api('/api/providers/sync-all', { method: 'POST' }); toast('全部同步任务已加入队列'); }
    if (action === 'sync-catalog') { const result = await api(`/api/providers/${id}/catalog/sync`, { method: 'POST' }); toast(catalogResultMessage(result)); if (state.view === 'costs') await navigate('costs'); }
    if (action === 'sync-catalogs') {
      const providers = state.providers.filter((provider) => provider.capabilities?.priceCatalog);
      if (providers.length === 0) return toast('没有支持目录同步的供应商', 'error');
      const results = await Promise.allSettled(providers.map((provider) => api(`/api/providers/${provider.id}/catalog/sync`, { method: 'POST' })));
      const completed = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      const failed = results.length - completed.length;
      const priceCount = completed.reduce((sum, result) => sum + Number(result.priceCount || 0), 0);
      const groupRateCount = completed.reduce((sum, result) => sum + Number(result.groupRateCount || 0), 0);
      toast(`目录同步完成：${groupRateCount} 个分组倍率，${priceCount} 条模型价格${failed ? `，${failed} 个失败` : ''}`, completed.length ? 'success' : 'error');
      navigate('costs');
    }
    if (action === 'provider-checkin') { const result = await api(`/api/providers/${id}/checkin`, { method: 'POST' }); toast(`签到结果：${result.status}`); if (state.view === 'integrations') navigate('integrations'); }
    if (action === 'provider-assets') { state.assetsTab = 'keys'; state.assetProviderId = id; state.assetSearch = ''; state.assetStatus = ''; await navigate('assets'); }
    if (action === 'asset-provider-tab') { state.assetProviderId = button.dataset.providerId; paintAssets(); icons(); }
    if (action === 'assets-tab') { state.assetsTab = button.dataset.tab; state.assetStatus = ''; paintAssets(); icons(); }
    if (action === 'check-key') { const result = await api(`/api/providers/${button.dataset.providerId}/keys/${id}/check`, { method: 'POST', body: { level: 'metadata' } }); toast(`Key 检测：${result.status}`); navigate(state.view); }
    if (action === 'health-all') {
      const results = await Promise.allSettled(state.providers.map((provider) => api(`/api/providers/${provider.id}/key-health`, { method: 'POST', body: { level: 'metadata' } })));
      toast(`健康检测完成：${results.filter((result) => result.status === 'fulfilled').length}/${results.length}`); navigate('risks');
    }
    if (action === 'paginate') await changeListPage(button.dataset.listKey, button.dataset.page);
    if (action === 'sort-cost-rate') await cycleCostRateSort(button.dataset.listKey);
    if (action === 'refresh-trends') await loadTrend();
    if (action === 'compare-model') await loadCostComparison();
    if (action === 'evaluate-alerts') { await api('/api/alerts/evaluate', { method: 'POST' }); toast('告警评估完成'); navigate('automation'); }
    if (action === 'add-alert-rule') openAlertRule();
    if (action === 'edit-alert-rule') openAlertRule(state.alertRules.find((r) => r.id === id));
    if (action === 'delete-alert-rule' && confirm('删除该告警规则？')) { await api(`/api/alert-rules/${id}`, { method: 'DELETE' }); toast('规则已删除'); navigate('automation'); }
    if (action === 'ack-alert') { await api(`/api/alerts/${id}/acknowledge`, { method: 'POST' }); toast('告警已确认'); navigate('automation'); }
    if (action === 'add-channel') openChannel();
    if (action === 'edit-channel') openChannel(state.channels.find((c) => c.id === id));
    if (action === 'delete-channel' && confirm('删除该通知通道？')) { await api(`/api/notification-channels/${id}`, { method: 'DELETE' }); toast('通道已删除'); navigate('automation'); }
    if (action === 'test-channel') { await api(`/api/notification-channels/${id}/test`, { method: 'POST' }); toast('测试通知已发送'); }
    if (action === 'regenerate-mobile-preview') {
      const form = $('#recharge-alert-test-form');
      if (form && form.dataset.running !== 'true') {
        form.elements.previewOnly.checked = true;
        updateRechargeAlertTestReadiness(form);
        form.requestSubmit();
      }
    }
    if (action === 'add-automation') openAutomation();
    if (action === 'edit-automation') openAutomation(state.automationRules.find((r) => r.id === id));
    if (action === 'delete-automation' && confirm('删除该自动化规则？')) { await api(`/api/automation-rules/${id}`, { method: 'DELETE' }); toast('规则已删除'); navigate('automation'); }
    if (action === 'view-automation-action') openAutomationActionDetail(id);
    if (action === 'rollback-automation' && confirm('恢复到该动作执行前的状态？')) { await api(`/api/automation-actions/${id}/rollback`, { method: 'POST' }); toast('动作已回滚'); navigate('automation'); }
    if (action === 'dry-run-automation') {
      const result = await api(`/api/automation/rules/${id}/dry-run`, { method: 'POST', body: {} });
      const rule = state.automationRules.find((item) => item.id === id);
      const matched = result.items.filter((item) => item.matched && item.safety.allowed).length;
      if (rule?.trigger_type === 'scheduled') {
        const matchedAccounts = Number(result.items[0]?.conditionMatchedTargets || 0);
        toast(matched
          ? rule.config?.condition
            ? `定时任务已到执行时间，当前 ${matchedAccounts} 个账号命中后续条件`
            : '定时任务已到执行时间'
          : '定时任务尚未到执行时间');
      } else {
        toast(`${matched} 个供应商满足执行条件`);
      }
    }
    if (action === 'auto-map') await openAutoMappingPreview();
    if (action === 'toggle-integration-group') {
      const groupKey = String(button.dataset.groupId);
      const expanded = !state.integrationExpandedGroups.has(groupKey);
      if (expanded) state.integrationExpandedGroups.add(groupKey);
      else state.integrationExpandedGroups.delete(groupKey);
      $$('[data-integration-parent]').filter((row) => row.dataset.integrationParent === groupKey).forEach((row) => { row.hidden = !expanded; });
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('title', expanded ? '收起明细' : '展开明细');
      button.setAttribute('aria-label', expanded ? '收起明细' : '展开明细');
      button.innerHTML = `<i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i>`;
      icons();
    }
    if (action === 'add-mapping') await openMappingDialog();
    if (action === 'refresh-comparisons') {
      const result = await withSub2ApiTwoFactor(() => api('/api/sub2api/comparisons/refresh', { method: 'POST', body: {} }));
      toast(`基座对照已刷新：${result.summary.aligned} 条一致，${result.summary.warning + result.summary.error} 条需处理`);
      await navigate('integrations');
    }
    if (action === 'edit-mapping') await openMappingDialog(state.mappings.find((mapping) => mapping.id === id));
    if (action === 'delete-all-mappings') {
      const count = state.mappings.length;
      if (!count || !confirm(`确定删除全部 ${count} 条映射关系及其对账历史？此操作不可撤销。`)) return;
      const result = await api('/api/mappings', { method: 'DELETE' });
      toast(`已删除 ${result.deletedMappings} 条映射关系`);
      await navigate('integrations');
    }
    if (action === 'delete-mapping' && confirm('删除该分组映射及其对账历史？')) { await api(`/api/mappings/${id}`, { method: 'DELETE' }); toast('映射已删除'); navigate('integrations'); }
    if (action === 'reconcile') { const result = await api(`/api/mappings/${id}/reconcile`, { method: 'POST', body: {} }); toast(`对账完成：${result.status}`); navigate('integrations'); }
    if (action === 'activate-backup' && confirm('将该备用映射设为当前主映射？')) { await api(`/api/mappings/${id}/activate-backup`, { method: 'POST' }); toast('备用映射已激活'); navigate('integrations'); }
    if (action === 'rotate-credential') {
      const provider = state.providers.find((item) => item.id === id);
      if (usesMultipleApiKeyEditor(provider?.adapter_type, provider?.auth_mode)) openProviderDialog(provider);
      else openCredentialDialog(provider);
    }
    if (action === 'open-import') openImportDialog();
    if (action === 'change-password') {
      const form = $('#password-form');
      form.reset();
      $('#password-error').textContent = '';
      $('#password-dialog').showModal();
      form.elements.currentPassword.focus();
      icons();
    }
    if (action === 'delete-sub2api-admin-api-key' && confirm('删除数据库中保存的 Sub2API 管理员 API Key？')) {
      await ensureReauth();
      await api('/api/sub2api/admin-api-key', { method: 'DELETE' });
      toast('数据库中的管理员 API Key 已删除');
      await navigate('settings');
    }
    if (action === 'preview-import') {
      const form = $('#import-form');
      state.importPreview = await api('/api/imports/preview', { method: 'POST', body: { format: form.elements.format.value, content: form.elements.content.value } });
      $('#import-preview').innerHTML = `<div class="status-summary"><span>${badge('created', `新增 ${state.importPreview.create}`)}</span><span>${badge('updated', `更新 ${state.importPreview.update}`)}</span><span>${badge(state.importPreview.invalid ? 'failed' : 'healthy', `无效 ${state.importPreview.invalid}`)}</span><span>${badge(state.importPreview.missingCredentials ? 'warning' : 'healthy', `缺凭据 ${state.importPreview.missingCredentials}`)}</span><span>${badge(state.importPreview.disableForMissingCredentials ? 'warning' : 'healthy', `导入后停用 ${state.importPreview.disableForMissingCredentials || 0}`)}</span><span>${badge(state.importPreview.skipForMissingCredentials ? 'warning' : 'healthy', `跳过 ${state.importPreview.skipForMissingCredentials || 0}`)}</span></div>`;
      $('button[type="submit"]', form).disabled = state.importPreview.invalid > 0;
      icons();
    }
    if (action === 'create-backup') { await ensureReauth(); const result = await api('/api/backups', { method: 'POST', body: { label: 'manual' } }); toast(`备份已创建：${result.filename}`); navigate('settings'); }
    if (action === 'add-backup-target') openBackupTarget();
    if (action === 'edit-backup-target') openBackupTarget(state.backupTargets.find((target) => target.id === id));
    if (action === 'delete-backup-target' && confirm('删除该备份目标？')) { await ensureReauth(); await api(`/api/backup-targets/${id}`, { method: 'DELETE' }); toast('备份目标已删除'); navigate('settings'); }
    if (action === 'test-backup-target') { await ensureReauth(); const result = await api(`/api/backup-targets/${id}/test`, { method: 'POST', body: {} }); toast(`备份上传成功：${result.filename}`); navigate('settings'); }
    if (action === 'run-remote-backups') { await ensureReauth(); const result = await api('/api/backups/remote', { method: 'POST', body: {} }); const succeeded = result.items.filter((item) => item.status === 'succeeded').length; toast(`远端备份完成：${succeeded}/${result.items.length}`); navigate('settings'); }
    if (action === 'export-disaster') {
      await ensureReauth();
      $('#disaster-form').reset(); $('#disaster-error').textContent = '';
      $('#disaster-dialog').showModal(); icons();
    }
    if (action === 'refresh-view') navigate(state.view);
    if (action === 'refresh-gross-profit') await loadGrossProfit();
    if (action === 'gross-profit-dimension') {
      state.grossProfitFilters.dimension = button.dataset.dimension;
      state.grossProfitDetailPage = 1;
      await loadGrossProfit();
    }
    if (action === 'gross-profit-granularity') {
      state.grossProfitFilters.granularity = button.dataset.granularity;
      state.grossProfitDetailPage = 1;
      await loadGrossProfit();
    }
    if (action === 'gross-profit-page') {
      state.grossProfitDetailPage = Math.max(1, Number(button.dataset.page) || 1);
      if (state.grossProfit) paintGrossProfit(state.grossProfit);
    }
    if (action === 'detect-provider') {
      const form = $('#provider-form');
      const outcome = await detectProvider(form, { manual: true });
      if (outcome) toast(outcome.message);
    }
    if (action === 'validate-provider') {
      const payload = providerValidationPayload($('#provider-form'));
      const result = await api('/api/providers/validate', { method: 'POST', body: payload });
      const recharge = result.recharge?.multiplier ? `，充值倍率 1:${formatRateValue(result.recharge.multiplier)}` : '';
      toast(`连接有效，余额项 ${result.balances.length} 个${recharge}`);
    }
  } catch (error) { toast(error.message, 'error'); }
}

document.addEventListener('click', (event) => {
  const closeControl = event.target.closest('[data-dialog-close]');
  if (closeControl) {
    event.preventDefault();
    closeControl.closest('dialog')?.close('cancel');
    return;
  }
  const nav = event.target.closest('[data-view]');
  if (nav) navigate(nav.dataset.view);
  const action = event.target.closest('[data-action]');
  if (action) handleAction(action);
  const activityTab = event.target.closest('[data-activity-tab]');
  if (activityTab) {
    selectActivityTab(activityTab.dataset.activityTab).catch((error) => toast(error.message, 'error'));
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('[data-cost-name-query]') && event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(costGroupNameFilterTimer);
    updateCostListFilter('cost-groups', 'nameQuery', event.target.value)
      .catch((error) => toast(error.message, 'error'));
    return;
  }
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('[role="tab"]', tab.closest('[role="tablist"]')).filter((item) => !item.disabled);
  const currentIndex = tabs.indexOf(tab);
  if (currentIndex < 0) return;
  event.preventDefault();
  let nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : currentIndex + (event.key === 'ArrowRight' ? 1 : -1);
  nextIndex = (nextIndex + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-account-monitor-select]')) {
    const accountId = String(event.target.dataset.accountMonitorSelect);
    if (event.target.checked) state.accountMonitorSelected.add(accountId);
    else state.accountMonitorSelected.delete(accountId);
    $$('[data-account-monitor-select]').forEach((input) => {
      if (String(input.dataset.accountMonitorSelect) === accountId) {
        input.checked = event.target.checked;
      }
    });
    updateAccountMonitorSelectionAction();
  }
  if (event.target.matches('#account-monitor-select-page')) {
    $$('[data-account-monitor-select]').forEach((input) => {
      input.checked = event.target.checked;
      const accountId = String(input.dataset.accountMonitorSelect);
      if (event.target.checked) state.accountMonitorSelected.add(accountId);
      else state.accountMonitorSelected.delete(accountId);
    });
    updateAccountMonitorSelectionAction();
  }
  if (event.target.matches('#account-monitor-group, #account-monitor-platform, #account-monitor-status, #account-monitor-days, #account-monitor-sort')) {
    const field = ({
      'account-monitor-group': 'groupId',
      'account-monitor-platform': 'platform',
      'account-monitor-status': 'status',
      'account-monitor-days': 'days',
      'account-monitor-sort': 'sortBy'
    })[event.target.id];
    state.accountMonitorFilters[field] = event.target.value;
    state.accountMonitorFilters.order = event.target.id === 'account-monitor-sort' && event.target.value === 'ttftP95Ms'
      ? 'asc'
      : 'desc';
    state.accountMonitorFilters.page = 1;
    renderAccountMonitor().catch((error) => toast(error.message, 'error'));
  }
  if (event.target.matches('#gross-profit-provider, #gross-profit-from, #gross-profit-to, #gross-profit-currency, #gross-profit-accounting-mode')) {
    const previousFilters = { ...state.grossProfitFilters };
    const field = ({
      'gross-profit-provider': 'connectionId',
      'gross-profit-from': 'from',
      'gross-profit-to': 'to',
      'gross-profit-currency': 'currency',
      'gross-profit-accounting-mode': 'accountingMode'
    })[event.target.id];
    state.grossProfitFilters[field] = event.target.value;
    if (
      state.grossProfitFilters.from && state.grossProfitFilters.to &&
      state.grossProfitFilters.from > state.grossProfitFilters.to
    ) {
      if (field === 'from') state.grossProfitFilters.to = state.grossProfitFilters.from;
      else state.grossProfitFilters.from = state.grossProfitFilters.to;
    }
    state.grossProfitDetailPage = 1;
    loadGrossProfit().catch((error) => {
      state.grossProfitFilters = previousFilters;
      if (state.grossProfit) paintGrossProfit(state.grossProfit);
      toast(error.message, 'error');
    });
  }
  if (event.target.matches('#trend-provider, #trend-days, #trend-currency')) loadTrend().catch((e) => toast(e.message, 'error'));
  if (event.target.matches('#asset-status')) filterAssets().catch((e) => toast(e.message, 'error'));
  if (event.target.matches('[data-cost-filter]')) {
    updateCostListFilter(event.target.dataset.listKey, event.target.dataset.costFilter, event.target.value)
      .catch((error) => toast(error.message, 'error'));
  }
  if (event.target.matches('#mapping-form [name="connectionId"]')) {
    updateMappingKeyOptions();
    updateMappingProviderGroupOptions();
  }
  if (event.target.matches('#mapping-form [name="keyId"]')) {
    const key = state.keys.find((item) => item.id === event.target.value);
    if (key?.primary_group_ref) updateMappingProviderGroupOptions(key.primary_group_ref);
  }
  if (event.target.matches('#cost-model') && event.target.value) loadCostComparison().catch((e) => toast(e.message, 'error'));
  if (event.target.matches('#provider-form [name="adapterType"]')) {
    const form = $('#provider-form'); const adapter = event.target.value;
    form.dataset.adapterTouched = 'true';
    applyProviderAdapter(form, adapter);
    if (!form.elements.baseUrl.value) form.elements.baseUrl.value = providerDefaults(adapter);
  }
  if (event.target.matches('#provider-form [name="authMode"]')) {
    const form = $('#provider-form');
    renderCredentialFields(form.elements.adapterType.value, null, event.target.value);
    const provider = state.providers.find((item) => item.id === form.elements.id.value) || null;
    renderMonitoredApiKeyOptions(form, provider);
    loadMonitoredApiKeyOptions(form, provider);
    form.dataset.credentialsTouched = 'true';
  }
  if (event.target.matches('#provider-form [name="sub2apiApiKeySource"]')) {
    const form = $('#provider-form');
    const source = selectedSub2ApiKeySource(form);
    const provider = state.providers.find((item) => item.id === form.elements.id.value) || null;
    const manual = $('[data-sub2api-api-key-manual]', form);
    const remote = $('[data-sub2api-api-key-remote]', form);
    if (manual) manual.hidden = source !== 'manual';
    if (remote) remote.hidden = source !== 'remote';
    renderMonitoredApiKeyOptions(form, provider);
    if (source === 'remote') loadMonitoredApiKeyOptions(form, provider);
    form.dataset.credentialsTouched = 'true';
  }
  if (event.target.matches(
    '#provider-form [name="dynamicRouteRateEnabled"]'
  )) {
    updateDynamicRouteRateFields(event.target.form);
  }
});

let searchTimer;
let costModelSearchTimer;
let costGroupNameFilterTimer;
let accountMonitorSearchTimer;
document.addEventListener('input', (event) => {
  if (event.target.matches('#account-monitor-search')) {
    clearTimeout(accountMonitorSearchTimer);
    const value = event.target.value;
    accountMonitorSearchTimer = setTimeout(() => {
      state.accountMonitorFilters.search = value.trim();
      state.accountMonitorFilters.page = 1;
      renderAccountMonitor().catch((error) => toast(error.message, 'error'));
    }, 300);
  }
  if (event.target.matches('#asset-search')) {
    clearTimeout(searchTimer); searchTimer = setTimeout(() => filterAssets().catch((e) => toast(e.message, 'error')), 250);
  }
  if (event.target.matches('#cost-model')) {
    clearTimeout(costModelSearchTimer);
    costModelSearchTimer = setTimeout(() => loadCostModelOptions(event.target.value).catch((error) => toast(error.message, 'error')), 200);
  }
  if (event.target.matches('[data-cost-name-query]')) {
    clearTimeout(costGroupNameFilterTimer);
    const value = event.target.value;
    costGroupNameFilterTimer = setTimeout(() => {
      updateCostListFilter('cost-groups', 'nameQuery', value)
        .catch((error) => toast(error.message, 'error'));
    }, 300);
  }
  if (event.target.matches('#provider-form [name="baseUrl"]')) {
    scheduleProviderDetection(event.target.form);
  }
  if (event.target.matches('#provider-form [data-credential], #provider-form [data-api-key-name], #provider-form [data-api-key-value], #provider-form [data-api-key-monitored], #provider-form [data-monitored-api-key]')) {
    event.target.form.dataset.credentialsTouched = 'true';
  }
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  const form = event.currentTarget; const button = $('button[type="submit"]', form); button.disabled = true;
  try {
    const identity = form.elements.identity.value.trim();
    const session = await api('/api/auth/login', { method: 'POST', body: { username: identity, email: identity, password: form.elements.password.value } });
    showApp(session); await navigate('overview');
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.sessionToken = '';
  state.csrfToken = '';
  browserSession.removeItem('provider-monitor.session');
  showLogin();
});
$('#provider-dialog').addEventListener('close', () => cancelProviderDetection({ clearStatus: true }));
$('#alert-rule-form')?.elements?.ruleType?.addEventListener('change', (event) => updateAlertRuleFields(event.target.form, { resetValues: true }));
$('#alert-rule-form')?.elements?.connectionId?.addEventListener('change', () => updateAlertGroupOptions(''));
$('#automation-form')?.elements?.action?.addEventListener('change', (event) => updateAutomationActionFields(event.target.form));
$('#automation-form')?.elements?.triggerType?.addEventListener('change', (event) => updateAutomationActionFields(event.target.form));
$('#automation-form')?.elements?.scheduledConditionType?.addEventListener('change', (event) => updateAutomationActionFields(event.target.form));

$('#provider-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  try {
    const payload = providerPayload(form);
    await api(id ? `/api/providers/${id}` : '/api/providers', { method: id ? 'PUT' : 'POST', body: payload });
    $('#provider-dialog').close(); toast(id ? '供应商已更新' : '供应商已创建，首次同步已排队'); navigate('providers');
  } catch (error) { $('#provider-form-error').textContent = error.message; }
});

$('#account-monitor-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const probePlatforms = $$('[data-probe-platform]', form)
    .filter((input) => input.checked)
    .map((input) => input.dataset.probePlatform);
  const probeModels = Object.fromEntries($$('[data-probe-model]', form)
    .map((input) => [input.dataset.probeModel, input.value.trim()])
    .filter(([, value]) => value));
  try {
    const result = await api('/api/account-monitor/config', {
      method: 'PUT',
      body: {
        syncEnabled: form.elements.syncEnabled.checked,
        autoMappingEnabled: form.elements.autoMappingEnabled.checked,
        syncIntervalMinutes: Number(form.elements.syncIntervalMinutes.value),
        lookbackDays: Number(form.elements.lookbackDays.value),
        sampleRetentionDays: Number(form.elements.sampleRetentionDays.value),
        baseRechargeMultiplier: Number(form.elements.baseRechargeMultiplier.value),
        probeEnabled: form.elements.probeEnabled.checked,
        probeIntervalMinutes: Number(form.elements.probeIntervalMinutes.value),
        probeConcurrency: Number(form.elements.probeConcurrency.value),
        probePlatforms,
        probeModels
      }
    });
    state.accountMonitor.settings = result.settings;
    $('#account-monitor-settings-dialog').close();
    toast('账号检测设置已保存');
    await renderAccountMonitor();
  } catch (error) {
    $('#account-monitor-settings-error').textContent = error.message;
  }
});

$('#provider-recharge-audit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    await api(`/api/account-monitor/providers/${encodeURIComponent(form.elements.connectionId.value)}/recharge-audit`, {
      method: 'PUT',
      body: {
        rechargedAmount: Number(form.elements.rechargedAmount.value),
        currency: form.elements.currency.value.trim(),
        note: form.elements.note.value.trim()
      }
    });
    $('#provider-recharge-audit-dialog').close();
    toast('供应商累计充值已保存');
    await renderAccountMonitor();
  } catch (error) {
    $('#provider-recharge-audit-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#alert-rule-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const payload = alertRulePayload(form);
  try { await api(id ? `/api/alert-rules/${id}` : '/api/alert-rules', { method: id ? 'PUT' : 'POST', body: payload }); $('#alert-rule-dialog').close(); toast('告警规则已保存'); navigate('automation'); } catch (error) { toast(error.message, 'error'); }
});

$('#notification-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  try {
    const payload = { name: form.elements.name.value, type: form.elements.type.value, enabled: form.elements.enabled.checked, config: JSON.parse(form.elements.config.value || '{}'), credentials: JSON.parse(form.elements.credentials.value || '{}') };
    await api(id ? `/api/notification-channels/${id}` : '/api/notification-channels', { method: id ? 'PUT' : 'POST', body: payload }); $('#notification-dialog').close(); toast('通知通道已保存'); navigate('automation');
  } catch (error) { toast(error.message, 'error'); }
});

$('#automation-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const payload = automationPayload(form);
  try { await api(id ? `/api/automation-rules/${id}` : '/api/automation-rules', { method: id ? 'PUT' : 'POST', body: payload }); $('#automation-dialog').close(); toast('自动化规则已保存'); navigate('automation'); } catch (error) { toast(error.message, 'error'); }
});

$('#auto-mapping-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  if (!state.autoMappingPreview || state.autoMappingPreview.summary.pendingCreate === 0) return;
  button.disabled = true;
  $('#auto-mapping-error').textContent = '';
  try {
    const result = await requestAutoMappings('apply');
    $('#auto-mapping-dialog').close('applied');
    state.autoMappingPreview = null;
    toast(`自动映射完成：新增 ${result.summary.created} 条，已有 ${result.summary.existing} 条，跳过 ${result.summary.skipped} 条`);
    await navigate('integrations');
  } catch (error) {
    $('#auto-mapping-error').textContent = autoMappingErrorMessage(error);
    button.disabled = false;
  }
});

$('#mapping-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const config = { ...JSON.parse(form.dataset.config || '{}') };
  if (form.elements.channelMonitorId.value) config.channelMonitorId = Number(form.elements.channelMonitorId.value);
  else delete config.channelMonitorId;
  if (form.elements.upstreamGroupRef.value) config.upstreamGroupRef = form.elements.upstreamGroupRef.value;
  else delete config.upstreamGroupRef;
  config.rateToleranceRatio = Math.max(0, Number(form.elements.rateTolerancePercent.value || 0) / 100);
  config.autoReconcile = form.elements.autoReconcile.checked;
  const payload = {
    connectionId: form.elements.connectionId.value,
    keyId: form.elements.keyId.value || null,
    accountId: form.elements.accountId.value ? Number(form.elements.accountId.value) : null,
    groupId: form.elements.groupId.value ? Number(form.elements.groupId.value) : null,
    role: form.elements.role.value,
    enabled: form.elements.enabled.checked,
    models: form.elements.models.value.split(',').map((value) => value.trim()).filter(Boolean),
    config
  };
  try { await api(id ? `/api/mappings/${id}` : '/api/mappings', { method: id ? 'PUT' : 'POST', body: payload }); $('#mapping-dialog').close(); toast('分组映射已保存'); navigate('integrations'); } catch (error) { toast(autoMappingErrorMessage(error), 'error'); }
});

$('#credential-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  const credentials = {};
  $$('[data-rotation-credential]', form).forEach((input) => { if (input.value) credentials[input.dataset.rotationCredential] = input.value; });
  if (!Object.keys(credentials).length) return toast('至少填写一个新凭据字段', 'error');
  try {
    await ensureReauth();
    const result = await api(`/api/providers/${form.elements.providerId.value}/credentials/rotate`, { method: 'POST', body: { credentials, retentionDays: Number(form.elements.retentionDays.value), reason: form.elements.reason.value } });
    $('#credential-dialog').close(); toast(`凭据已轮换，回滚副本保留至 ${formatDate(result.backupExpiresAt)}`); navigate(state.view);
  } catch (error) { toast(error.message, 'error'); }
});

$('#backup-target-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  try {
    await ensureReauth();
    const payload = {
      name: form.elements.name.value.trim(), type: form.elements.type.value,
      enabled: form.elements.enabled.checked,
      config: JSON.parse(form.elements.config.value || '{}'),
      credentials: JSON.parse(form.elements.credentials.value || '{}')
    };
    await api(id ? `/api/backup-targets/${id}` : '/api/backup-targets', { method: id ? 'PUT' : 'POST', body: payload });
    $('#backup-target-dialog').close(); toast('备份目标已保存'); navigate('settings');
  } catch (error) { $('#backup-target-form-error').textContent = error.message; }
});

$('#reauth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    await api('/api/auth/reauth', { method: 'POST', body: { username: form.elements.identity.value, email: form.elements.identity.value, password: form.elements.password.value } });
    const resolve = state.reauthResolve; state.reauthResolve = null; state.reauthReject = null;
    $('#reauth-dialog').close(); resolve?.();
  } catch (error) { $('#reauth-error').textContent = error.message; }
});

$('#reauth-dialog').addEventListener('close', () => {
  if (state.reauthReject) {
    const reject = state.reauthReject; state.reauthResolve = null; state.reauthReject = null;
    reject(new Error('已取消敏感操作'));
  }
});

$('#sub2api-step-up-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  $('#sub2api-step-up-error').textContent = '';
  try {
    await api('/api/sub2api/step-up', {
      method: 'POST',
      body: { code: form.elements.code.value.trim() }
    });
    const resolve = state.sub2apiStepUpResolve;
    state.sub2apiStepUpResolve = null;
    state.sub2apiStepUpReject = null;
    $('#sub2api-step-up-dialog').close('verified');
    resolve?.();
  } catch (error) {
    $('#sub2api-step-up-error').textContent = sub2apiStepUpErrorMessage(error);
  } finally {
    submit.disabled = false;
  }
});

$('#sub2api-step-up-dialog').addEventListener('close', () => {
  $('#sub2api-step-up-form').reset();
  if (state.sub2apiStepUpReject) {
    const reject = state.sub2apiStepUpReject;
    state.sub2apiStepUpResolve = null;
    state.sub2apiStepUpReject = null;
    reject(new Error('已取消 Sub2API 二次验证'));
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  $('#password-error').textContent = '';
  if (newPassword !== form.elements.confirmation.value) {
    $('#password-error').textContent = '两次输入的新密码不一致';
    return;
  }
  if (newPassword === currentPassword) {
    $('#password-error').textContent = '新密码不能与当前密码相同';
    return;
  }
  submit.disabled = true;
  try {
    const result = await api('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword }
    });
    state.authentication = { ...state.authentication, passwordChangedAt: result.changedAt };
    $('#password-dialog').close();
    form.reset();
    toast(result.revokedSessions > 0
      ? `密码已修改，已退出其他 ${result.revokedSessions} 个会话`
      : '密码已修改');
    if (state.view === 'settings') await navigate('settings');
  } catch (error) {
    $('#password-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!state.importPreview) return;
  try {
    await ensureReauth();
    const result = await api('/api/imports/apply', { method: 'POST', body: { format: form.elements.format.value, content: form.elements.content.value } });
    $('#import-dialog').close(); toast(`导入完成：新增 ${result.created}，更新 ${result.updated}，待补凭据 ${result.disabledForMissingCredentials || 0}，跳过 ${result.skipped}`); navigate('providers');
  } catch (error) { toast(error.message, 'error'); }
});

$('#disaster-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (form.elements.password.value !== form.elements.confirmation.value) {
    $('#disaster-error').textContent = '两次输入的密码不一致'; return;
  }
  try {
    const bundle = await api('/api/exports/disaster-bundle', { method: 'POST', body: { password: form.elements.password.value } });
    downloadJson(`provider-monitor-disaster-${new Date().toISOString().slice(0, 10)}.json`, bundle);
    $('#disaster-dialog').close(); toast('加密灾备包已生成');
  } catch (error) { $('#disaster-error').textContent = error.message; }
});

window.addEventListener('resize', () => state.chart?.resize());

(async function initialize() {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') return;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const redirectedSession = hash.get('pm_session');
  if (redirectedSession) {
    state.sessionToken = redirectedSession;
    browserSession.setItem('provider-monitor.session', redirectedSession);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  const query = new URLSearchParams(window.location.search);
  const theme = query.get('theme');
  const ssoError = query.get('sso_error');
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  const upstreamToken = query.get('token') || query.get('access_token');
  if (upstreamToken) {
    query.delete('token');
    query.delete('access_token');
    const cleanQuery = query.toString();
    history.replaceState(null, '', `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`);
  }

  try {
    state.authConfig = await api('/api/auth/config');
    if (state.authConfig.ssoEnabled) {
      $('#login-hint').textContent = '请从已登录的 Sub2API 自定义菜单进入';
      if (state.authConfig.sub2apiUrl) {
        $('#sub2api-login-link').href = state.authConfig.sub2apiUrl;
        $('#sub2api-login-link').hidden = false;
      }
    }
    if (ssoError) {
      state.sessionToken = '';
      state.csrfToken = '';
      browserSession.removeItem('provider-monitor.session');
      showLogin(ssoErrorMessage(ssoError));
      return;
    }
    if (upstreamToken) {
      const session = await api('/api/auth/sso', {
        method: 'POST',
        headers: { Authorization: `Bearer ${upstreamToken}` }
      });
      showApp(session);
      await navigate('overview');
      return;
    }
    const session = await api('/api/auth/me');
    showApp(session);
    await navigate('overview');
  } catch (error) {
    state.sessionToken = '';
    state.csrfToken = '';
    browserSession.removeItem('provider-monitor.session');
    showLogin(ssoError ? ssoErrorMessage(ssoError) : '');
  }
})();
