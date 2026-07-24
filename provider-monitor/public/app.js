const browserSession = typeof sessionStorage === 'undefined'
  ? { getItem: () => '', setItem: () => {}, removeItem: () => {} }
  : sessionStorage;

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
  chart: null,
  assetsTab: 'keys',
  assetProviderId: '',
  assetSearch: '',
  assetStatus: '',
  mappings: [],
  sub2apiGroups: [],
  sub2apiMonitors: [],
  sub2apiStatus: null,
  integrationGroups: [],
  integrationExpandedGroups: new Set(),
  autoMappingPreview: null,
  reconciliations: [],
  importPreview: null,
  backupTargets: [],
  mobilePreviewUrl: '',
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
  costs: ['价格比较', '模型价格、分组倍率与供应商推荐'],
  risks: ['健康与漂移', 'Key 检测、资产变化与异常识别'],
  alerts: ['告警中心', '规则、事件与通知通道'],
  integrations: ['Sub2API 联动', '分组映射、签到、对账与健康联动'],
  automation: ['自动化', '低余额联动与可回滚操作'],
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
  const text = label || ({ healthy: '正常', warning: '预警', stale: '陈旧', unknown: '未知', active: '活动', inactive: '停用', enabled: '启用', disabled: '停用', missing: '缺失', succeeded: '成功', partial: '部分成功', failed: '失败', pending: '等待', pending_create: '待新增', running: '执行中', dry_run: '演练', resolved: '已恢复', acknowledged: '已确认', expired: '已到期', exhausted: '已耗尽', passed: '通过', info: '信息', already_checked: '今日已签', unsupported: '不支持', manual_action_required: '需人工处理', created: '已创建', existing: '已存在', unmatched: '未匹配', conflict: '冲突', missing_api_key: '缺少 API Key', missing_remote_key: '远端 Key 未找到', updated: '已更新', aligned: '综合倍率一致', rate_mismatch: '综合倍率偏差', missing_base_group: '基座分组缺失', base_group_unselected: '未选基座分组', missing_provider_group: '供应商分组缺失', missing_dynamic_route_rate: '动态倍率缺失', missing_rate: '倍率缺失', invalid_provider_rate: '供应商倍率无效', mapping_disabled: '映射已停用' }[status] || status || '未知');
  return `<span class="badge ${escapeHtml(status || 'unknown')}">${escapeHtml(text)}</span>`;
}

function alertSeverityLabel(severity) {
  return ({ info: '信息', warning: '预警', error: '错误' })[severity] || severity || '未知';
}

function emptyState(icon, title, text) {
  return `<div class="empty"><div><i data-lucide="${icon}"></i><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div></div>`;
}

async function loadBase() {
  const [providers, summary] = await Promise.all([api('/api/providers'), api('/api/summary')]);
  state.providers = providers.items;
  state.summary = summary;
}

async function navigate(view) {
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
    if (view === 'costs') await renderCosts();
    if (view === 'risks') await renderRisks();
    if (view === 'alerts') await renderAlerts();
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
  const [keys, groups] = await Promise.all([api('/api/keys'), api('/api/groups')]);
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
  const [prices, models, groups] = await Promise.all([api('/api/prices'), api('/api/models'), api('/api/groups')]);
  state.prices = prices.items;
  const modelNames = [...new Set([...prices.items.map((item) => item.model_id), ...models.items.map((item) => item.name || item.remote_id)])].sort();
  const catalogProviders = state.providers.filter((provider) => provider.capabilities?.priceCatalog);
  setTopActions(catalogProviders.length > 0 ? `<button class="button" data-action="sync-catalogs"><i data-lucide="refresh-cw"></i><span>同步目录</span></button>` : '');
  const activeGroups = groups.items.filter((group) => group.status !== 'missing');
  const groupRows = activeGroups.map((group) => {
    const metadata = group.metadata || {};
    const defaultRatio = metadata.default_rate_multiplier ?? metadata.rate_multiplier;
    const peak = metadata.peak_rate_enabled
      ? `${metadata.peak_start || '-'}–${metadata.peak_end || '-'} · ${formatEffectiveRate(metadata.peak_rate_multiplier)}`
      : '-';
    const multiplier = formatEffectiveRate(group.ratio);
    const defaultMultiplier = formatEffectiveRate(defaultRatio);
    return `<tr><td class="primary-cell"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.remote_id)}</small></td><td>${escapeHtml(group.provider_name)}</td><td>${escapeHtml(metadata.platform || '-')}</td><td class="numeric"><strong>${multiplier}</strong></td><td class="numeric">${defaultMultiplier}</td><td>${escapeHtml(peak)}</td><td class="numeric">${metadata.image_price_1k == null ? '-' : formatMoney(metadata.image_price_1k, 'USD')}</td><td class="numeric">${metadata.image_price_2k == null ? '-' : formatMoney(metadata.image_price_2k, 'USD')}</td><td class="numeric">${metadata.image_price_4k == null ? '-' : formatMoney(metadata.image_price_4k, 'USD')}</td></tr>`;
  }).join('');
  const rows = prices.items.map((item) => {
    const currency = item.displayCurrency || item.currency;
    const groupLabel = [item.groupName, item.channelName].filter(Boolean).join(' · ') || item.group_ref || '-';
    const multiplier = formatEffectiveRate(item.groupRatio);
    return `<tr><td class="primary-cell"><strong>${escapeHtml(item.model_id)}</strong><small>${escapeHtml(item.billing_mode)}</small></td><td>${escapeHtml(item.provider_name)}</td><td>${escapeHtml(groupLabel)}</td><td class="numeric">${multiplier}</td><td class="numeric">${item.effectiveInputPrice == null ? '-' : formatMoney(item.effectiveInputPrice, currency)}</td><td class="numeric">${item.effectiveOutputPrice == null ? '-' : formatMoney(item.effectiveOutputPrice, currency)}</td><td class="numeric">${item.effectiveRequestPrice == null ? '-' : formatMoney(item.effectiveRequestPrice, currency)}</td><td>${formatDate(item.captured_at)}</td></tr>`;
  }).join('');
  $('#main-content').innerHTML = `<div class="filter-bar"><select id="cost-model"><option value="">选择模型进行推荐比较</option>${modelNames.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')}</select><button class="button" data-action="compare-model"><i data-lucide="scale"></i><span>比较</span></button></div><div id="cost-comparison"></div><section class="section"><div class="section-header"><h2>分组倍率</h2><p>${activeGroups.length} 个可用分组</p></div><div class="table-wrap">${groupRows ? `<table><thead><tr><th>分组</th><th>供应商</th><th>平台</th><th class="numeric">有效倍率</th><th class="numeric">默认倍率</th><th>峰值倍率</th><th class="numeric">图片 1K</th><th class="numeric">图片 2K</th><th class="numeric">图片 4K</th></tr></thead><tbody>${groupRows}</tbody></table>` : emptyState('boxes', '暂无分组倍率', '先同步支持分组查询的供应商')}</div></section><section class="section"><div class="section-header"><h2>最新价格目录</h2><p>${models.items.length} 个模型 · ${prices.items.length} 条价格</p></div><div class="table-wrap">${rows ? `<table><thead><tr><th>模型</th><th>供应商</th><th>分组 / 渠道</th><th class="numeric">倍率</th><th class="numeric">输入 / 百万</th><th class="numeric">输出 / 百万</th><th class="numeric">单次</th><th>同步时间</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState('badge-dollar-sign', '暂无模型价格', '供应商未返回可用的模型价格')}</div></section>`;
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
    api('/api/anomalies?limit=200'), api('/api/asset-changes?limit=200'), api('/api/key-health?limit=200')
  ]);
  setTopActions(`<button class="button" data-action="health-all"><i data-lucide="stethoscope"></i><span>元数据检测</span></button><button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  const anomalyRows = anomalies.items.map((item) => `<tr><td>${badge(item.resolved_at ? 'resolved' : item.severity)}</td><td class="primary-cell"><strong>${escapeHtml(item.anomaly_type)}</strong><small>${escapeHtml(item.message)}</small></td><td>${escapeHtml(state.providers.find((p) => p.id === item.connection_id)?.name || '-')}</td><td class="numeric">${formatNumber(item.score)}</td><td>${formatDate(item.detected_at)}</td></tr>`).join('');
  const changeRows = changes.items.map((item) => `<tr><td>${badge(item.severity)}</td><td>${escapeHtml(item.asset_type)}</td><td>${escapeHtml(item.change_type)}</td><td>${escapeHtml(state.providers.find((p) => p.id === item.connection_id)?.name || '-')}</td><td>${escapeHtml(item.after?.changedFields?.join(', ') || item.remote_id || '-')}</td><td>${formatDate(item.detected_at)}</td></tr>`).join('');
  const healthRows = health.items.map((item) => `<tr><td class="primary-cell"><strong>${escapeHtml(item.key_name)}</strong><small>${escapeHtml(item.provider_name)}</small></td><td>${badge(item.status)}</td><td>${escapeHtml(item.level)}</td><td class="numeric">${item.latency_ms == null ? '-' : `${item.latency_ms} ms`}</td><td class="numeric">${item.model_count ?? '-'}</td><td>${escapeHtml(item.error_code || '-')}</td><td>${formatDate(item.checked_at)}</td></tr>`).join('');
  $('#main-content').innerHTML = `<div class="stats-grid"><div class="stat"><span class="stat-label"><i data-lucide="triangle-alert"></i>活动异常</span><strong class="stat-value">${anomalies.items.filter((item) => !item.resolved_at).length}</strong><span class="stat-detail">余额、用量与契约</span></div><div class="stat"><span class="stat-label"><i data-lucide="git-compare-arrows"></i>资产变化</span><strong class="stat-value">${changes.items.length}</strong><span class="stat-detail">最近 200 条</span></div><div class="stat"><span class="stat-label"><i data-lucide="shield-check"></i>检测通过</span><strong class="stat-value">${health.items.filter((item) => item.status === 'passed').length}</strong><span class="stat-detail">Key 健康记录</span></div><div class="stat"><span class="stat-label"><i data-lucide="shield-x"></i>检测失败</span><strong class="stat-value">${health.items.filter((item) => item.status === 'failed').length}</strong><span class="stat-detail">需要处理</span></div></div><section class="section"><div class="section-header"><h2>异常</h2></div><div class="table-wrap">${anomalyRows ? `<table><thead><tr><th>状态</th><th>异常</th><th>供应商</th><th class="numeric">评分</th><th>时间</th></tr></thead><tbody>${anomalyRows}</tbody></table>` : emptyState('shield-check', '暂无异常', '同步完成后自动分析余额和用量')}</div></section><section class="section"><div class="section-header"><h2>配置漂移</h2></div><div class="table-wrap">${changeRows ? `<table><thead><tr><th>级别</th><th>资产</th><th>变化</th><th>供应商</th><th>字段</th><th>时间</th></tr></thead><tbody>${changeRows}</tbody></table>` : emptyState('git-compare-arrows', '暂无变化记录', '第二次同步后开始对比资产')}</div></section><section class="section"><div class="section-header"><h2>Key 健康记录</h2></div><div class="table-wrap">${healthRows ? `<table><thead><tr><th>Key</th><th>结果</th><th>级别</th><th class="numeric">延迟</th><th class="numeric">模型数</th><th>错误</th><th>时间</th></tr></thead><tbody>${healthRows}</tbody></table>` : emptyState('stethoscope', '暂无健康检测', '可执行免费的元数据检测')}</div></section>`;
}

function integrationDelta(comparison = {}) {
  const percent = Number(comparison.differenceRatio) * 100;
  if (comparison.differenceRatio == null || !Number.isFinite(percent)) return '-';
  return `${percent > 0 ? '+' : ''}${formatRateValue(percent)}%`;
}

function integrationRate(value) {
  return formatEffectiveRate(value);
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
  const parts = [integrationRate(comparison.providerRate)];
  if (comparison.details?.providerRateScope === 'dynamic_route_history') {
    const dynamic = comparison.details.dynamicRouteRate || {};
    const statisticLabel = {
      median: 'P50', p90: 'P90', weighted_average: 'Token 加权', latest: '最近一次'
    }[dynamic.statistic] || '历史实测';
    parts.push(`动态实测 ${statisticLabel}`);
    parts.push(`${dynamic.sampleCount || 0} 次`);
    if (dynamic.minMultiplier != null && dynamic.maxMultiplier != null) {
      parts.push(`${integrationRate(dynamic.minMultiplier)}~${integrationRate(dynamic.maxMultiplier)}`);
    }
    const latestChannel = dynamic.summary?.latest?.channelName;
    if (latestChannel) parts.push(`最近 ${escapeHtml(latestChannel)}`);
    if (dynamic.status === 'unavailable') parts.push('缓存');
    else if (dynamic.status === 'low_confidence') parts.push('样本少');
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
      <div><span>${badge('warning', '预警')}</span><p>存在综合倍率偏差，或供应商分组、动态路由样本、倍率等映射信息不完整。</p></div>
      <div><span>${badge('failed', '错误')}</span><p>映射引用的 Sub2API 分组已经不存在，需要修正映射。</p></div>
      <div><span>${badge('unknown', '待检查')}</span><p>已有映射尚未生成检查结果，刷新基座后会重新计算。</p></div>
      <p class="integration-status-help-scope">这里只统计已有映射；无映射分组不会计入“待检查”，停用映射也不计入这四项。</p>
    </div>
  </details>`;
}

function integrationMappingActions(item) {
  return `<button class="icon-button small" data-action="reconcile" data-id="${item.id}" title="立即对账" aria-label="立即对账"><i data-lucide="calculator"></i></button>${item.role === 'backup' ? `<button class="icon-button small" data-action="activate-backup" data-id="${item.id}" title="激活备用映射" aria-label="激活备用映射"><i data-lucide="arrow-right-left"></i></button>` : ''}<button class="icon-button small" data-action="edit-mapping" data-id="${item.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-mapping" data-id="${item.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button>`;
}

function integrationDetailRow(item, groupKey, expanded) {
  const comparison = item.comparison || {};
  const providerGroupState = comparison.details?.providerGroupStatus && !['active', 'enabled'].includes(comparison.details.providerGroupStatus.toLowerCase())
    ? ` ${badge(comparison.details.providerGroupStatus)}` : '';
  const providerGroupSource = providerGroupSourceBadge(comparison);
  return `<tr class="integration-detail-row${item.isHighestRate ? ' highest-rate-row' : ''}" data-integration-parent="${escapeHtml(groupKey)}" ${expanded ? '' : 'hidden'}>
    <td class="primary-cell integration-indent"><strong>${item.account_id ? `账号 #${item.account_id}` : '账户级映射'}</strong><small>${item.role === 'primary' ? '主映射' : '备用映射'}</small></td>
    <td class="numeric">${integrationRate(comparison.baseGroupRate)}</td>
    <td class="primary-cell"><strong>${escapeHtml(item.provider_name)}</strong><small>${escapeHtml(item.key_name || '账户级')} · ${escapeHtml(item.masked_key || '-')}</small></td>
    <td class="primary-cell"><strong>${escapeHtml(comparison.providerGroupName || comparison.providerGroupRef || '-')}${providerGroupState}${providerGroupSource}${item.isHighestRate ? ` ${badge('highest', '综合最高')}` : ''}</strong><small>${integrationProviderRate(comparison)}</small></td>
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
    <td class="numeric"><strong>${integrationRate(group.baseRate)}</strong></td>
    <td class="primary-cell"><strong>${escapeHtml(highest?.provider_name || '-')}</strong><small>${highest ? `${escapeHtml(highest.key_name || '账户级')} · ${escapeHtml(highest.masked_key || '-')}` : '暂无有效综合倍率映射'}</small></td>
    <td class="primary-cell"><strong>${escapeHtml(comparison.providerGroupName || comparison.providerGroupRef || '-')}${providerGroupState}${providerGroupSource}${highest ? ` ${badge('highest', '综合最高')}` : ''}</strong><small>${integrationProviderRate(comparison)}</small></td>
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
  gateway_primary_group_mismatch: '已同步 Key 的主分组与计费结果不一致'
};

function autoMappingVerificationLabel(item) {
  if (item.keyMatch === 'verified_gateway_billing') {
    return AUTO_MAPPING_KEY_VERIFICATION_LABELS.verified_gateway_billing;
  }
  const code = String(item.keyVerification || '');
  if (AUTO_MAPPING_KEY_VERIFICATION_LABELS[code]) return AUTO_MAPPING_KEY_VERIFICATION_LABELS[code];
  if (code.startsWith('gateway_billing_')) return '基座账号 Key 无法通过供应商计费验证';
  return '';
}

function autoMappingErrorMessage(error) {
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
  setTopActions(`<button class="button" data-action="refresh-comparisons" title="刷新基座" aria-label="刷新基座"><i data-lucide="refresh-cw"></i><span>刷新基座</span></button><button class="button primary" data-action="auto-map" title="自动映射" aria-label="自动映射"><i data-lucide="wand-sparkles"></i><span>自动映射</span></button><button class="button" data-action="add-mapping" title="添加映射" aria-label="添加映射"><i data-lucide="plus"></i><span>添加映射</span></button>`);
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
  $('#main-content').innerHTML = `<section class="base-instance-bar"><div><span class="status-dot ${status.authentication?.available ? 'healthy' : 'warning'}"></span><strong>${escapeHtml(status.publicUrl || status.baseUrl || '未配置基座 Sub2API')}</strong><small>${escapeHtml(authLabel)} · 最近检查 ${escapeHtml(timeAgo(status.lastCheckedAt))}</small></div><div class="status-summary"><span>${badge('aligned', `一致 ${summary.aligned}`)}</span><span>${badge('warning', `预警 ${summary.warning}`)}</span><span>${badge('failed', `错误 ${summary.error}`)}</span><span>${badge('unknown', `待检查 ${summary.unchecked}`)}</span>${integrationSummaryHelp()}</div></section><section class="section"><div class="section-header"><h2>分组与倍率对照</h2><p>${state.integrationGroups.length} 个 Sub2API 分组</p></div><div class="table-wrap integration-table">${mappingRows ? `<table><thead><tr><th>Sub2API 分组</th><th class="numeric">基座倍率</th><th>最高综合倍率供应商 / Key</th><th>供应商分组 / 倍率</th><th class="numeric" title="支付 1 单位可获得的供应商余额">充值倍率</th><th class="numeric" title="供应商分组倍率 ÷ 充值倍率">综合倍率</th><th class="numeric" title="（基座倍率 - 综合倍率）÷ 综合倍率">综合倍率差</th><th>检查</th><th>映射 / 对账</th><th></th></tr></thead><tbody>${mappingRows}</tbody></table>` : emptyState('waypoints', '暂无 Sub2API 分组', '刷新基座后显示分组与映射关系')}</div></section><section class="section"><div class="section-header"><h2>对账记录</h2></div><div class="table-wrap">${reconciliationRows ? `<table><thead><tr><th>供应商</th><th>结果</th><th>期间</th><th class="numeric">余额减少</th><th class="numeric">预期成本</th><th class="numeric">差异</th><th class="numeric">健康分</th></tr></thead><tbody>${reconciliationRows}</tbody></table>` : emptyState('calculator', '暂无对账记录', '映射创建后可执行对账')}</div></section><section class="section split-layout"><div><div class="section-header"><h2>签到记录</h2></div><div class="table-wrap">${checkinRows ? `<table><thead><tr><th>供应商</th><th>状态</th><th class="numeric">奖励</th><th class="numeric">签到前</th><th class="numeric">签到后</th><th>时间</th></tr></thead><tbody>${checkinRows}</tbody></table>` : emptyState('calendar-check', '暂无签到记录', '支持的供应商可手动或定时签到')}</div></div><div><div class="section-header"><h2>手动签到</h2></div><div class="table-wrap"><table><thead><tr><th>供应商</th><th>能力</th><th></th></tr></thead><tbody>${providerCheckins}</tbody></table></div></div></section>`;
}

async function renderSettings() {
  const [settings, backups, lifecycle, targets, remoteRuns, sub2apiStatus] = await Promise.all([
    api('/api/settings'), api('/api/backups'), api('/api/credentials/lifecycle'),
    api('/api/backup-targets'), api('/api/backup-runs?limit=100'), api('/api/sub2api/status')
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
    <label><span>原始快照保留（天）</span><input name="rawSnapshotRetentionDays" type="number" min="7" max="3650" value="${settings.rawSnapshotRetentionDays}"></label>
    <label><span>聚合快照保留（天）</span><input name="snapshotRetentionDays" type="number" min="30" max="3650" value="${settings.snapshotRetentionDays}"></label>
    <label><span>任务记录保留（天）</span><input name="jobRetentionDays" type="number" min="7" max="3650" value="${settings.jobRetentionDays}"></label>
    <label><span>审计记录保留（天）</span><input name="auditRetentionDays" type="number" min="30" max="3650" value="${settings.auditRetentionDays}"></label>
    <label><span>通知记录保留（天）</span><input name="notificationRetentionDays" type="number" min="7" max="3650" value="${settings.notificationRetentionDays}"></label>
  </div></div><footer class="dialog-actions"><span class="action-spacer"></span><button class="button primary" type="button" data-action="save-system-settings"><i data-lucide="save"></i><span>保存系统参数</span></button></footer></form></section>`;
  $('#main-content').innerHTML = `<section class="base-instance-bar"><div><span class="status-dot ${sub2apiStatus.authentication?.available ? 'healthy' : 'warning'}"></span><strong>基座 Sub2API</strong><small>${escapeHtml(sub2apiStatus.publicUrl || sub2apiStatus.baseUrl || '未配置')} · 最近检查 ${escapeHtml(timeAgo(sub2apiStatus.lastCheckedAt))}</small></div><div>${authStatus}</div></section><div class="split-layout"><form class="panel" id="settings-form"><div class="panel-header"><h2>运行设置</h2></div><div class="form-grid"><label><span>显示币种</span><input name="displayCurrency" value="${escapeHtml(settings.displayCurrency)}"></label><label><span>预测最短跨度（小时）</span><input name="forecastMinSpanHours" type="number" min="1" value="${settings.forecastMinSpanHours}"></label><label><span>对账容差</span><input name="reconciliationToleranceRatio" type="number" min="0" step="0.01" value="${settings.reconciliationToleranceRatio}"></label><label><span>综合倍率偏差容差</span><input name="sub2apiRateToleranceRatio" type="number" min="0" step="0.01" value="${settings.sub2apiRateToleranceRatio}"></label><label><span>价格刷新（小时）</span><input name="catalogRefreshHours" type="number" min="1" value="${settings.catalogRefreshHours}"></label><label><span>异常跌幅（%）</span><input name="anomalyDropPercent" type="number" min="1" value="${settings.anomalyDropPercent}"></label><label><span>异常突增倍数</span><input name="anomalySpikeMultiplier" type="number" min="1" step="0.1" value="${settings.anomalySpikeMultiplier}"></label><label class="span-2"><span>汇率（JSON）</span><textarea name="currencyRates" rows="4">${escapeHtml(JSON.stringify(settings.currencyRates, null, 2))}</textarea></label></div><footer class="dialog-actions"><span class="action-spacer"></span><button class="button primary" type="submit"><i data-lucide="save"></i><span>保存设置</span></button></footer></form><div>${securityPanel}<div class="section-header ${securityPanel ? 'section' : ''}"><h2>数据导出</h2></div><div class="panel"><div class="panel-body action-grid"><button class="button" data-action="download" data-url="/api/exports/balances.csv" data-filename="provider-monitor-balances.csv"><i data-lucide="wallet-cards"></i><span>余额 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/usage.csv" data-filename="provider-monitor-usage.csv"><i data-lucide="activity"></i><span>用量 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/alerts.csv" data-filename="provider-monitor-alerts.csv"><i data-lucide="bell"></i><span>告警 CSV</span></button><button class="button" data-action="download" data-url="/api/exports/env" data-filename="provider-monitor-import.env"><i data-lucide="file-code-2"></i><span>环境变量模板</span></button><button class="button" data-action="export-disaster"><i data-lucide="lock-keyhole"></i><span>加密灾备包</span></button></div></div><div class="section-header section"><h2>SQLite 备份</h2></div><div class="table-wrap">${backupRows ? `<table><thead><tr><th>文件</th><th class="numeric">大小</th><th>时间</th></tr></thead><tbody>${backupRows}</tbody></table>` : emptyState('database-backup', '暂无备份', '创建在线一致性备份')}</div></div></div><section class="section"><div class="section-header"><h2>远端备份目标</h2><div class="section-actions"><button class="button small" data-action="run-remote-backups"><i data-lucide="cloud-upload"></i><span>立即备份</span></button><button class="button small primary" data-action="add-backup-target"><i data-lucide="plus"></i><span>添加目标</span></button></div></div><div class="table-wrap">${targetRows ? `<table><thead><tr><th>目标</th><th>状态</th><th>最近结果</th><th>最近备份</th><th></th></tr></thead><tbody>${targetRows}</tbody></table>` : emptyState('cloud-upload', '暂无远端目标', '添加本地目录、WebDAV 或 S3 兼容目标')}</div></section><section class="section"><div class="section-header"><h2>远端备份记录</h2></div><div class="table-wrap">${remoteRunRows ? `<table><thead><tr><th>目标</th><th>状态</th><th>文件</th><th class="numeric">大小</th><th>时间</th></tr></thead><tbody>${remoteRunRows}</tbody></table>` : emptyState('history', '暂无远端备份记录', '执行远端备份后显示')}</div></section><section class="section"><div class="section-header"><h2>凭据生命周期</h2></div><div class="table-wrap">${lifecycleRows ? `<table><thead><tr><th>供应商 / 字段</th><th>到期状态</th><th>最近轮换</th><th>凭据到期</th><th></th></tr></thead><tbody>${lifecycleRows}</tbody></table>` : emptyState('key-round', '暂无凭据', '添加供应商后显示')}</div></section>`;
  $('.split-layout', $('#main-content')).insertAdjacentHTML('afterend', systemSettingsPanel);
  $('#settings-form').addEventListener('submit', saveSettings);
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

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/settings', { method: 'PUT', body: {
      displayCurrency: form.elements.displayCurrency.value.trim() || 'USD',
      forecastMinSpanHours: Number(form.elements.forecastMinSpanHours.value),
      reconciliationToleranceRatio: Number(form.elements.reconciliationToleranceRatio.value),
      sub2apiRateToleranceRatio: Number(form.elements.sub2apiRateToleranceRatio.value),
      catalogRefreshHours: Number(form.elements.catalogRefreshHours.value),
      anomalyDropPercent: Number(form.elements.anomalyDropPercent.value),
      anomalySpikeMultiplier: Number(form.elements.anomalySpikeMultiplier.value),
      currencyRates: JSON.parse(form.elements.currencyRates.value || '{}')
    } });
    toast('设置已保存');
  } catch (error) { toast(error.message, 'error'); }
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
      notificationRetentionDays: Number(form.elements.notificationRetentionDays.value)
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

async function renderAlerts() {
  const [events, rules, channels] = await Promise.all([api('/api/alerts'), api('/api/alert-rules'), api('/api/notification-channels')]);
  state.alerts = events.items;
  state.alertRules = rules.items;
  state.channels = channels.items;
  setTopActions(`<button class="button" data-action="evaluate-alerts"><i data-lucide="scan-line"></i><span>立即评估</span></button><button class="button primary" data-action="add-alert-rule"><i data-lucide="plus"></i><span>添加规则</span></button>`);
  const eventList = state.alerts.map((event) => `<div class="alert-item"><span class="alert-symbol ${event.severity === 'error' ? 'error' : ''}"><i data-lucide="${event.severity === 'error' ? 'octagon-alert' : 'triangle-alert'}"></i></span><div><p>${escapeHtml(event.message)}</p><small>${formatDate(event.triggered_at)} · ${escapeHtml(alertSeverityLabel(event.severity))}</small></div><div>${badge(event.status)}${event.status === 'active' ? `<button class="icon-button small" data-action="ack-alert" data-id="${event.id}" title="确认告警" aria-label="确认告警"><i data-lucide="check"></i></button>` : ''}</div></div>`).join('');
  const ruleRows = state.alertRules.map((rule) => `<tr><td class="primary-cell"><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.rule_type)}</small></td><td>${rule.connection_id ? escapeHtml(state.providers.find((p) => p.id === rule.connection_id)?.name || '-') : '全部'}</td><td>${rule.threshold ?? '-'}</td><td>${rule.currency || '-'}</td><td>${rule.enabled ? badge('enabled') : badge('disabled')}</td><td class="actions-cell"><button class="icon-button small" data-action="edit-alert-rule" data-id="${rule.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-alert-rule" data-id="${rule.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></td></tr>`).join('');
  const channelRows = state.channels.map((channel) => `<tr><td class="primary-cell"><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(channel.type)}</small></td><td>${channel.enabled ? badge('enabled') : badge('disabled')}</td><td>${channel.credentialFields.map((f) => escapeHtml(f.name)).join(', ') || '-'}</td><td class="actions-cell"><button class="icon-button small" data-action="test-channel" data-id="${channel.id}" title="测试" aria-label="测试"><i data-lucide="send"></i></button><button class="icon-button small" data-action="edit-channel" data-id="${channel.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-channel" data-id="${channel.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></td></tr>`).join('');
  $('#main-content').innerHTML = `<div class="split-layout"><div class="panel"><div class="panel-header"><h2>告警事件</h2></div><div class="alert-list">${eventList || emptyState('bell-off', '暂无告警', '当前没有触发中的风险事件')}</div></div><div class="panel"><div class="panel-header"><h2>通知通道</h2><div class="panel-actions"><button class="icon-button small" data-action="add-channel" title="添加通知通道" aria-label="添加通知通道"><i data-lucide="plus"></i></button></div></div>${channelRows ? `<div class="table-wrap"><table><thead><tr><th>通道</th><th>状态</th><th>凭据</th><th></th></tr></thead><tbody>${channelRows}</tbody></table></div>` : emptyState('send', '暂无通知通道', '添加 Webhook、Telegram、Gotify、Bark 或邮件')}</div></div><section class="section"><div class="section-header"><h2>告警规则</h2></div><div class="table-wrap">${ruleRows ? `<table><thead><tr><th>规则</th><th>供应商</th><th>阈值</th><th>币种</th><th>状态</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table>` : emptyState('list-checks', '暂无规则', '供应商的两级余额阈值仍会生成内置规则')}</div></section>`;
}

async function renderAutomation() {
  const [rules, actions] = await Promise.all([api('/api/automation-rules'), api('/api/automation-actions')]);
  state.automationRules = rules.items;
  state.automationActions = actions.items;
  setTopActions(`<button class="button primary" data-action="add-automation"><i data-lucide="plus"></i><span>添加规则</span></button>`);
  const ruleRows = state.automationRules.map((rule) => `<tr><td class="primary-cell"><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.trigger_type)}</small></td><td>${rule.connection_id ? escapeHtml(state.providers.find((p) => p.id === rule.connection_id)?.name || '-') : '全部'}</td><td>${rule.dryRun ? badge('dry_run') : badge('active', '实执行')}</td><td>${rule.enabled ? badge('enabled') : badge('disabled')}</td><td class="actions-cell"><button class="icon-button small" data-action="dry-run-automation" data-id="${rule.id}" title="预览执行条件" aria-label="预览执行条件"><i data-lucide="scan-search"></i></button><button class="icon-button small" data-action="edit-automation" data-id="${rule.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button small" data-action="delete-automation" data-id="${rule.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></td></tr>`).join('');
  const actionRows = state.automationActions.map((action) => `<tr><td>${escapeHtml(action.action_type)}</td><td>${badge(action.status)}</td><td>${action.dryRun ? '是' : '否'}</td><td>${escapeHtml(action.after?.channelId || '-')}</td><td>${formatDate(action.created_at)}</td><td class="actions-cell">${action.status === 'succeeded' && !action.rolled_back_at ? `<button class="button small" data-action="rollback-automation" data-id="${action.id}"><i data-lucide="undo-2"></i><span>回滚</span></button>` : ''}</td></tr>`).join('');
  $('#main-content').innerHTML = `<div class="table-wrap">${ruleRows ? `<table><thead><tr><th>规则</th><th>供应商</th><th>模式</th><th>状态</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table>` : emptyState('workflow', '暂无自动化规则', '规则默认使用演练模式')}</div><section class="section"><div class="section-header"><h2>动作记录</h2></div><div class="table-wrap">${actionRows ? `<table><thead><tr><th>动作</th><th>结果</th><th>演练</th><th>渠道 ID</th><th>时间</th><th></th></tr></thead><tbody>${actionRows}</tbody></table>` : emptyState('history', '暂无动作', '触发规则后将在此记录')}</div></section>`;
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

function rechargeTestReadinessHtml(provider, channel) {
  if (!provider) return '<div class="test-readiness-state error"><i data-lucide="circle-alert"></i><span>暂无可测试的供应商</span></div>';
  const hasRechargeUrl = Boolean(provider.rechargeUrl);
  const adapterLogin = provider.typeConfig?.rechargeLogin?.enabled === true;
  return `<div class="test-readiness-state ${hasRechargeUrl && channel ? 'ready' : 'error'}">
      <i data-lucide="${hasRechargeUrl && channel ? 'circle-check' : 'circle-alert'}"></i>
      <span>${hasRechargeUrl ? channel ? '可以发送模拟告警' : '请选择通知通道' : '该供应商未配置充值链接'}</span>
    </div>
    <div class="test-readiness-grid">
      <div><span>适配器</span><strong>${escapeHtml(adapterLabel(provider.adapter_type))}</strong></div>
      <div><span>充值目标</span><strong>${escapeHtml(rechargeTestTargetHost(provider.rechargeUrl))}</strong></div>
      <div><span>请求方式</span><strong>${adapterLogin ? '适配器自动登录' : '直接打开'}</strong></div>
      <div><span>通知通道</span><strong>${channel ? `${escapeHtml(channel.name)}${channel.enabled ? '' : '（停用）'}` : '未选择'}</strong></div>
    </div>`;
}

function updateRechargeAlertTestReadiness(form = $('#recharge-alert-test-form')) {
  if (!form) return;
  const provider = state.providers.find((item) => item.id === form.elements.connectionId.value);
  const channel = state.channels.find((item) => item.id === form.elements.notificationChannelId.value);
  $('#recharge-test-readiness').innerHTML = rechargeTestReadinessHtml(provider, channel);
  $('button[type="submit"]', form).disabled = form.dataset.running === 'true' || !provider?.rechargeUrl || !channel;
  icons();
}

function rechargeAlertTestResultHtml(result) {
  const recharge = result.recharge || {};
  const adapterEntry = recharge.mode === 'adapter';
  const reason = rechargeTestReasonLabel(recharge.reason);
  return `<section class="panel test-result-panel">
    <div class="panel-header"><h2>发送结果</h2><div class="panel-actions">${result.mobilePreview?.url ? '<button class="button small" type="button" data-action="open-mobile-preview"><i data-lucide="smartphone"></i><span>打开移动端预览</span></button>' : ''}${badge(result.status === 'delivered' ? 'succeeded' : 'failed', result.status === 'delivered' ? '已送达' : result.status)}</div></div>
    <div class="test-result-grid">
      <div><span>供应商</span><strong>${escapeHtml(result.provider?.name || '-')}</strong></div>
      <div><span>通知通道</span><strong>${escapeHtml(result.channel?.name || '-')}</strong></div>
      <div><span>充值入口</span><strong>${adapterEntry ? '一次性自动登录入口' : '原充值链接'}</strong></div>
      <div><span>目标主机</span><strong>${escapeHtml(recharge.targetHost || '-')}</strong></div>
      <div><span>模拟余额</span><strong>${formatNumber(result.alert?.balance, 2)} ${escapeHtml(result.alert?.currency || '')}</strong></div>
      <div><span>模拟阈值</span><strong>${formatNumber(result.alert?.threshold, 2)} ${escapeHtml(result.alert?.currency || '')}</strong></div>
      <div><span>入口到期</span><strong>${recharge.expiresAt ? formatDate(recharge.expiresAt) : '不适用'}</strong></div>
      <div><span>发送时间</span><strong>${formatDate(result.sentAt)}</strong></div>
    </div>
    ${reason ? `<div class="test-result-note"><i data-lucide="info"></i><span>${escapeHtml(reason)}，本次已发送原充值链接。</span></div>` : ''}
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
  const previewWindow = form.elements.openMobilePreview.checked
    ? openMobilePreviewWindow()
    : null;
  state.mobilePreviewUrl = '';
  form.dataset.running = 'true';
  updateRechargeAlertTestReadiness(form);
  resultRegion.innerHTML = `<section class="panel test-result-panel"><div class="test-result-pending"><i class="spin" data-lucide="loader-circle"></i><strong>正在发送模拟告警</strong></div></section>`;
  icons();
  try {
    const body = {
      connectionId: form.elements.connectionId.value,
      channelId: form.elements.notificationChannelId.value
    };
    const result = await withRecentReauth(() => api('/api/simulations/recharge-alert', {
      method: 'POST',
      body
    }));
    state.mobilePreviewUrl = result.mobilePreview?.url || '';
    resultRegion.innerHTML = rechargeAlertTestResultHtml(result);
    if (previewWindow && !previewWindow.closed && state.mobilePreviewUrl) {
      previewWindow.location.replace(state.mobilePreviewUrl);
      previewWindow.focus?.();
    }
    toast(`模拟告警已发送至 ${result.channel.name}`);
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
  state.mobilePreviewUrl = '';
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
          <label class="toggle-field test-preview-toggle"><input name="openMobilePreview" type="checkbox" checked><span>发送后打开移动端预览</span></label>
          <button class="button primary" type="submit"><i data-lucide="send"></i><span>发送测试告警</span></button>
        </footer>
      </form>
    </section>
    <div id="recharge-test-result" aria-live="polite"></div>`;
  const form = $('#recharge-alert-test-form');
  form.elements.connectionId.addEventListener('change', () => updateRechargeAlertTestReadiness(form));
  form.elements.notificationChannelId.addEventListener('change', () => updateRechargeAlertTestReadiness(form));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runRechargeAlertTest(form);
  });
  updateRechargeAlertTestReadiness(form);
}

async function renderActivity() {
  const [checks, jobs, auditLogs] = await Promise.all([api('/api/checks?limit=100'), api('/api/jobs?limit=100'), api('/api/audit-logs?limit=100')]);
  state.checks = checks.items;
  state.jobs = jobs.items;
  state.audit = auditLogs.items;
  setTopActions(`<button class="button" data-action="refresh-view"><i data-lucide="refresh-cw"></i><span>刷新</span></button>`);
  const checksRows = state.checks.map((run) => `<tr><td>${escapeHtml(state.providers.find((p) => p.id === run.connection_id)?.name || '-')}</td><td>${escapeHtml(run.job_type)}</td><td>${badge(run.status)}</td><td class="numeric">${run.duration_ms == null ? '-' : `${run.duration_ms} ms`}</td><td>${escapeHtml(run.error_code || '-')}</td><td>${formatDate(run.started_at)}</td></tr>`).join('');
  const jobRows = state.jobs.map((job) => `<tr><td>${escapeHtml(job.type)}</td><td>${escapeHtml(state.providers.find((p) => p.id === job.connection_id)?.name || '-')}</td><td>${badge(job.status)}</td><td class="numeric">${job.attempt}</td><td>${escapeHtml(job.last_error || '-')}</td><td>${formatDate(job.created_at)}</td></tr>`).join('');
  const auditRows = state.audit.map((log) => `<tr><td>${escapeHtml(log.actor_name || '-')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.target_type || '-')}</td><td>${escapeHtml(log.target_id || '-')}</td><td>${formatDate(log.created_at)}</td></tr>`).join('');
  $('#main-content').innerHTML = `<div class="tabs"><button class="tab active" data-activity-tab="checks">检查记录</button><button class="tab" data-activity-tab="jobs">任务队列</button><button class="tab" data-activity-tab="audit">审计日志</button></div><div id="activity-checks" class="table-wrap"><table><thead><tr><th>供应商</th><th>类型</th><th>状态</th><th class="numeric">耗时</th><th>错误码</th><th>开始时间</th></tr></thead><tbody>${checksRows}</tbody></table></div><div id="activity-jobs" class="table-wrap" hidden><table><thead><tr><th>任务</th><th>供应商</th><th>状态</th><th class="numeric">尝试</th><th>错误</th><th>创建时间</th></tr></thead><tbody>${jobRows}</tbody></table></div><div id="activity-audit" class="table-wrap" hidden><table><thead><tr><th>操作者</th><th>动作</th><th>对象</th><th>ID</th><th>时间</th></tr></thead><tbody>${auditRows}</tbody></table></div>`;
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

function renderCredentialFields(adapter, provider = null, authMode = '') {
  const fields = credentialFieldsFor(adapter, authMode || provider?.auth_mode);
  $('#credential-fields').innerHTML = fields.map(([name, label, type]) => {
    const existing = provider?.credentialFields?.find((field) => field.name === name);
    return `<label><span>${escapeHtml(label)}</span><input data-credential="${name}" type="${type}" placeholder="${existing ? `已保存 ${existing.masked}，留空不修改` : ''}" autocomplete="off"></label>`;
  }).join('');
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
  $('#provider-dialog').showModal();
  icons();
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
  $$('[data-credential]', form).forEach((input) => { if (input.value) credentials[input.dataset.credential] = input.value; });
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
  rate_mismatch: { fields: ['threshold'], thresholdLabel: '倍率偏差（%）', min: '0', step: '0.01' },
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
  for (const fieldName of ['scope', 'threshold', 'currency', 'consecutiveMatches']) {
    form.elements[fieldName].required = activeFields.has(fieldName);
  }
  form.elements.threshold.min = config.min || '';
  form.elements.threshold.step = config.step || 'any';
  $('#alert-threshold-label').textContent = config.thresholdLabel || '阈值';
  if (resetValues) {
    form.elements.scope.value = 'account';
    form.elements.threshold.value = '';
    form.elements.currency.value = 'USD';
    form.elements.consecutiveMatches.value = '1';
  }
}

function openAlertRule(rule = null) {
  const form = $('#alert-rule-form'); form.reset();
  form.elements.id.value = rule?.id || ''; form.elements.name.value = rule?.name || '';
  form.elements.ruleType.value = rule?.rule_type || 'low_balance'; fillProviderSelect(form.elements.connectionId, rule?.connection_id);
  form.elements.scope.value = rule?.scope || 'account';
  form.elements.threshold.value = rule?.threshold ?? ''; form.elements.currency.value = rule?.currency || 'USD';
  form.elements.consecutiveMatches.value = rule?.consecutive_matches || 1; form.elements.cooldownMinutes.value = rule?.cooldown_minutes || 60;
  form.elements.enabled.checked = rule?.enabled ?? true; updateAlertRuleFields(); $('#alert-rule-dialog').showModal(); icons();
}

function alertRulePayload(form) {
  const activeFields = new Set(alertRuleFieldConfig(form.elements.ruleType.value).fields);
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
    config: {}
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
  form.elements.channelIds.value = (rule?.config?.channelIds || []).join(', '); form.elements.action.value = rule?.config?.action || 'disable_sub2api_channel';
  form.elements.consecutiveMatches.value = rule?.config?.consecutiveMatches || 2;
  form.elements.cooldownMinutes.value = rule?.config?.cooldownMinutes || 60;
  form.elements.dailyMaximumActions.value = rule?.config?.dailyMaximumActions || 10;
  form.elements.contractPauseHours.value = rule?.config?.contractPauseHours || 24;
  form.elements.webhookUrl.value = rule?.config?.webhookUrl || '';
  form.elements.enabled.checked = rule?.enabled ?? false; form.elements.dryRun.checked = rule?.dryRun ?? true;
  updateAutomationActionFields(form);
  $('#automation-dialog').showModal(); icons();
}

function automationUsesChannelIds(action) {
  return action !== 'trigger_recharge_webhook';
}

function updateAutomationActionFields(form = $('#automation-form')) {
  const usesChannelIds = automationUsesChannelIds(form.elements.action.value);
  const usesWebhook = form.elements.action.value === 'trigger_recharge_webhook';
  const channelField = form.querySelector('[data-automation-channel-field]');
  const webhookField = form.querySelector('[data-automation-webhook-field]');
  channelField.hidden = !usesChannelIds;
  webhookField.hidden = !usesWebhook;
  form.elements.channelIds.required = usesChannelIds;
  form.elements.webhookUrl.required = usesWebhook;
}

function automationPayload(form) {
  const channelIds = automationUsesChannelIds(form.elements.action.value)
    ? form.elements.channelIds.value.split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
    : [];
  return {
    name: form.elements.name.value,
    triggerType: form.elements.triggerType.value,
    connectionId: form.elements.connectionId.value || null,
    enabled: form.elements.enabled.checked,
    dryRun: form.elements.dryRun.checked,
    config: {
      threshold: form.elements.threshold.value === '' ? undefined : Number(form.elements.threshold.value),
      currency: form.elements.currency.value,
      ...(automationUsesChannelIds(form.elements.action.value) ? { channelIds } : {}),
      action: form.elements.action.value,
      consecutiveMatches: Number(form.elements.consecutiveMatches.value),
      cooldownMinutes: Number(form.elements.cooldownMinutes.value),
      dailyMaximumActions: Number(form.elements.dailyMaximumActions.value),
      contractPauseHours: Number(form.elements.contractPauseHours.value),
      ...(form.elements.webhookUrl.value ? { webhookUrl: form.elements.webhookUrl.value } : {})
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
    if (action === 'download') await downloadFile(button.dataset.url, button.dataset.filename);
    if (action === 'save-system-settings') await saveSystemSettings($('#system-settings-form'));
    if (action === 'add-provider') openProviderDialog();
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
    if (action === 'refresh-trends') await loadTrend();
    if (action === 'compare-model') await loadCostComparison();
    if (action === 'evaluate-alerts') { await api('/api/alerts/evaluate', { method: 'POST' }); toast('告警评估完成'); navigate('alerts'); }
    if (action === 'add-alert-rule') openAlertRule();
    if (action === 'edit-alert-rule') openAlertRule(state.alertRules.find((r) => r.id === id));
    if (action === 'delete-alert-rule' && confirm('删除该告警规则？')) { await api(`/api/alert-rules/${id}`, { method: 'DELETE' }); toast('规则已删除'); navigate('alerts'); }
    if (action === 'ack-alert') { await api(`/api/alerts/${id}/acknowledge`, { method: 'POST' }); toast('告警已确认'); navigate('alerts'); }
    if (action === 'add-channel') openChannel();
    if (action === 'edit-channel') openChannel(state.channels.find((c) => c.id === id));
    if (action === 'delete-channel' && confirm('删除该通知通道？')) { await api(`/api/notification-channels/${id}`, { method: 'DELETE' }); toast('通道已删除'); navigate('alerts'); }
    if (action === 'test-channel') { await api(`/api/notification-channels/${id}/test`, { method: 'POST' }); toast('测试通知已发送'); }
    if (action === 'open-mobile-preview') {
      const popup = state.mobilePreviewUrl ? openMobilePreviewWindow(state.mobilePreviewUrl) : null;
      if (!popup) toast('浏览器阻止了移动端预览窗口，请允许本站弹出窗口后重试', 'error');
    }
    if (action === 'add-automation') openAutomation();
    if (action === 'edit-automation') openAutomation(state.automationRules.find((r) => r.id === id));
    if (action === 'delete-automation' && confirm('删除该自动化规则？')) { await api(`/api/automation-rules/${id}`, { method: 'DELETE' }); toast('规则已删除'); navigate('automation'); }
    if (action === 'rollback-automation' && confirm('将 Sub2API 渠道恢复到动作前状态？')) { await api(`/api/automation-actions/${id}/rollback`, { method: 'POST' }); toast('动作已回滚'); navigate('automation'); }
    if (action === 'dry-run-automation') { const result = await api(`/api/automation/rules/${id}/dry-run`, { method: 'POST', body: {} }); toast(`${result.items.filter((item) => item.matched && item.safety.allowed).length} 个供应商满足执行条件`); }
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
    if (action === 'delete-mapping' && confirm('删除该分组映射及其对账历史？')) { await api(`/api/mappings/${id}`, { method: 'DELETE' }); toast('映射已删除'); navigate('integrations'); }
    if (action === 'reconcile') { const result = await api(`/api/mappings/${id}/reconcile`, { method: 'POST', body: {} }); toast(`对账完成：${result.status}`); navigate('integrations'); }
    if (action === 'activate-backup' && confirm('将该备用映射设为当前主映射？')) { await api(`/api/mappings/${id}/activate-backup`, { method: 'POST' }); toast('备用映射已激活'); navigate('integrations'); }
    if (action === 'rotate-credential') openCredentialDialog(state.providers.find((provider) => provider.id === id));
    if (action === 'open-import') openImportDialog();
    if (action === 'change-password') {
      const form = $('#password-form');
      form.reset();
      $('#password-error').textContent = '';
      $('#password-dialog').showModal();
      form.elements.currentPassword.focus();
      icons();
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
    $$('[data-activity-tab]').forEach((tab) => tab.classList.toggle('active', tab === activityTab));
    ['checks', 'jobs', 'audit'].forEach((name) => { $(`#activity-${name}`).hidden = name !== activityTab.dataset.activityTab; });
  }
});

document.addEventListener('keydown', (event) => {
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
  if (event.target.matches('#trend-provider, #trend-days, #trend-currency')) loadTrend().catch((e) => toast(e.message, 'error'));
  if (event.target.matches('#asset-status')) filterAssets().catch((e) => toast(e.message, 'error'));
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
    form.dataset.credentialsTouched = 'true';
  }
  if (event.target.matches('#provider-form [name="dynamicRouteRateEnabled"]')) {
    updateDynamicRouteRateFields(event.target.form);
  }
});

let searchTimer;
document.addEventListener('input', (event) => {
  if (event.target.matches('#asset-search')) {
    clearTimeout(searchTimer); searchTimer = setTimeout(() => filterAssets().catch((e) => toast(e.message, 'error')), 250);
  }
  if (event.target.matches('#provider-form [name="baseUrl"]')) {
    scheduleProviderDetection(event.target.form);
  }
  if (event.target.matches('#provider-form [data-credential]')) {
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
$('#automation-form')?.elements?.action?.addEventListener('change', (event) => updateAutomationActionFields(event.target.form));

$('#provider-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  try {
    const payload = providerPayload(form);
    await api(id ? `/api/providers/${id}` : '/api/providers', { method: id ? 'PUT' : 'POST', body: payload });
    $('#provider-dialog').close(); toast(id ? '供应商已更新' : '供应商已创建，首次同步已排队'); navigate('providers');
  } catch (error) { $('#provider-form-error').textContent = error.message; }
});

$('#alert-rule-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const payload = alertRulePayload(form);
  try { await api(id ? `/api/alert-rules/${id}` : '/api/alert-rules', { method: id ? 'PUT' : 'POST', body: payload }); $('#alert-rule-dialog').close(); toast('告警规则已保存'); navigate('alerts'); } catch (error) { toast(error.message, 'error'); }
});

$('#notification-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  try {
    const payload = { name: form.elements.name.value, type: form.elements.type.value, enabled: form.elements.enabled.checked, config: JSON.parse(form.elements.config.value || '{}'), credentials: JSON.parse(form.elements.credentials.value || '{}') };
    await api(id ? `/api/notification-channels/${id}` : '/api/notification-channels', { method: id ? 'PUT' : 'POST', body: payload }); $('#notification-dialog').close(); toast('通知通道已保存'); navigate('alerts');
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
  try { await api(id ? `/api/mappings/${id}` : '/api/mappings', { method: id ? 'PUT' : 'POST', body: payload }); $('#mapping-dialog').close(); toast('分组映射已保存'); navigate('integrations'); } catch (error) { toast(error.message, 'error'); }
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
