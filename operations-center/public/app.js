'use strict';

const browserSession = typeof sessionStorage === 'undefined'
  ? { getItem: () => '', setItem: () => {}, removeItem: () => {} }
  : sessionStorage;

const state = {
  csrfToken: '',
  sessionToken: browserSession.getItem('operations-center.session') || '',
  user: null,
  authentication: null,
  authConfig: null,
  currentView: 'overview',
  charts: new Map(),
  preview: null,
  policy: null,
  runPoller: null,
  settings: null
};

const titles = {
  overview: '运营概览',
  usage: '用量分析',
  users: '用户分析',
  finance: '收款与入账',
  storage: '存储容量',
  retention: '数据清理',
  maintenance: '维护状态',
  settings: '系统设置'
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function icon(name) {
  return `<i data-lucide="${escapeHtml(name)}"></i>`;
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatDecimal(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'N/A';
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(number);
}

function formatMoney(value, currency = '') {
  const amount = formatDecimal(value, 2);
  return currency ? `${amount} ${currency}` : amount;
}

function formatBytes(value) {
  let bytes = Number(value);
  if (!Number.isFinite(bytes)) return 'N/A';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  while (Math.abs(bytes) >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${formatDecimal(bytes, index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return 'N/A';
  return value >= 1000 ? `${formatDecimal(value / 1000, 2)} s` : `${formatDecimal(value, 0)} ms`;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function todayString() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function setDefaultDates(formId, days = 30) {
  const form = $(formId);
  const today = todayString();
  form.elements.end.value = today;
  form.elements.start.value = addDays(today, -(days - 1));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.sessionToken ? { authorization: `Session ${state.sessionToken}` } : {}),
      ...(state.csrfToken && options.method && options.method !== 'GET' ? { 'x-csrf-token': state.csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const type = response.headers.get('content-type') || '';
  const payload = response.status === 204
    ? null
    : type.includes('application/json') ? await response.json() : await response.text();
  if (response.status === 401 && payload?.error?.code === 'AUTH_REQUIRED') {
    state.sessionToken = '';
    state.csrfToken = '';
    browserSession.removeItem('operations-center.session');
    showLogin();
    throw new Error('登录已失效');
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = message;
  $('toast-region').append(node);
  setTimeout(() => node.remove(), 4500);
}

function setPageMeta(text) {
  $('page-meta').textContent = text;
}

function setConnection(ok, text) {
  $('connection-dot').className = `status-dot ${ok ? 'ok' : 'bad'}`;
  $('connection-label').textContent = text;
}

function revealActiveTab() {
  requestAnimationFrame(() => {
    const nav = $('main-nav');
    const active = nav.querySelector('.module-tab.active');
    if (!active) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < navRect.left + 8) nav.scrollLeft -= navRect.left + 8 - activeRect.left;
    if (activeRect.right > navRect.right - 8) nav.scrollLeft += activeRect.right - navRect.right + 8;
  });
}

function alertHtml(type, message) {
  const icons = { info: 'info', warning: 'triangle-alert', error: 'circle-x', success: 'circle-check' };
  return `<div class="alert ${type}">${icon(icons[type] || 'info')}<div>${escapeHtml(message)}</div></div>`;
}

function metricCard(label, value, foot = '', tone = '') {
  return `<article class="metric-card ${tone}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-foot">${escapeHtml(foot)}</div></article>`;
}

function emptyRow(columns, text = '暂无数据') {
  return `<tr><td colspan="${columns}" class="empty-row">${escapeHtml(text)}</td></tr>`;
}

function badge(status) {
  const mapping = {
    completed: ['success', '已完成'], running: ['warning', '执行中'], queued: ['neutral', '等待中'],
    pending: ['neutral', '等待中'], partial: ['warning', '部分完成'], canceled: ['neutral', '已取消'],
    failed: ['error', '失败'], blocked: ['error', '已阻断'], skipped: ['neutral', '已跳过'],
    started: ['success', '已启动'], disabled: ['neutral', '未启用'], ready: ['success', '已就绪'],
    available: ['success', '可用'], missing: ['error', '缺失'], passed: ['success', '通过'],
    warning: ['warning', '需处理']
  };
  const [tone, label] = mapping[status] || ['neutral', status || '未知'];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function showLogin(message = '') {
  if (state.runPoller) clearInterval(state.runPoller);
  state.runPoller = null;
  state.csrfToken = '';
  state.user = null;
  $('app-shell').hidden = true;
  $('login-view').hidden = false;
  $('login-password').value = '';
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
  setTimeout(() => $('login-username').focus(), 0);
  refreshIcons();
}

function showApp(session) {
  if (session.sessionToken) {
    state.sessionToken = session.sessionToken;
    browserSession.setItem('operations-center.session', session.sessionToken);
  }
  state.csrfToken = session.csrfToken;
  state.user = session.user;
  state.authentication = session.authentication || null;
  $('admin-name').textContent = session.user.name;
  $('login-view').hidden = true;
  $('app-shell').hidden = false;
  refreshIcons();
}

function ssoErrorMessage(code) {
  const messages = {
    AUTH_FAILED: 'Sub2API 登录状态无效或已过期，请返回 Sub2API 重新登录后再打开。',
    ADMIN_REQUIRED: '当前 Sub2API 账号不是管理员，无法访问运营中心。',
    AUTH_UPSTREAM_TIMEOUT: '运营中心暂时无法连接 Sub2API，请稍后重试。',
    AUTH_UPSTREAM_UNAVAILABLE: '运营中心无法连接 Sub2API。请检查部署配置中的 Sub2API 地址、容器网络或反向代理。',
    AUTH_UPSTREAM_INVALID_RESPONSE: 'Sub2API 认证接口返回了无法识别的响应，请检查反向代理目标。',
    SUB2API_SESSION_BINDING_INCOMPATIBLE: 'Sub2API 已开启会话绑定，无法由运营中心校验登录状态。请关闭会话绑定并重新登录，或改用本地认证模式。',
    SSO_DISABLED: '当前运营中心未启用 Sub2API 单点登录。'
  };
  return messages[code] || 'Sub2API 单点登录失败，请重新从管理员自定义菜单打开。';
}

function chart(id, option) {
  if (!window.echarts) return;
  let instance = state.charts.get(id);
  if (!instance) {
    instance = window.echarts.init($(id), null, { renderer: 'canvas' });
    state.charts.set(id, instance);
  }
  instance.setOption({
    animationDuration: 250,
    textStyle: { fontFamily: 'Inter, Segoe UI, Microsoft YaHei, sans-serif', color: '#4b554f' },
    tooltip: { trigger: 'axis', borderColor: '#dfe2dc', backgroundColor: '#fff', textStyle: { color: '#1e2420' } },
    grid: { left: 58, right: 24, top: 30, bottom: 44 },
    ...option
  }, true);
  return instance;
}

function lineSeries(name, data, color, yAxisIndex = 0) {
  return {
    name,
    type: 'line',
    data,
    yAxisIndex,
    smooth: false,
    symbol: 'circle',
    symbolSize: 5,
    connectNulls: false,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    areaStyle: { color, opacity: 0.06 }
  };
}

async function loadOverview() {
  setPageMeta('正在读取运营汇总');
  $('overview-metrics').innerHTML = Array.from({ length: 5 }, (_, i) => metricCard('读取中', '...', '', ['green', 'blue', 'amber'][i % 3])).join('');
  const [overview, usage] = await Promise.all([api('/api/overview'), api('/api/metrics/usage')]);
  $('overview-metrics').innerHTML = [
    metricCard('今日用量活跃', formatInteger(overview.activity.dau), `${overview.timezones.usage} 自然日`, 'green'),
    metricCard('本月用量活跃', formatInteger(overview.activity.mau), '自然月去重', 'blue'),
    metricCard('今日请求', formatInteger(overview.usage.requests_today), `日汇总至 ${formatDateTime(overview.usage.computed_at)}`, 'amber'),
    metricCard('本月用户消费', formatDecimal(overview.usage.spend_month, 4), 'actual_cost', 'red'),
    metricCard('当前可用用户', formatInteger(overview.users.available_users), `本月新增 ${formatInteger(overview.users.new_month)}`, 'green')
  ].join('');
  $('overview-usage-meta').textContent = `${usage.timezone} · ${usage.range.start} 至 ${usage.range.end}`;
  chart('overview-chart', {
    legend: { top: 2, right: 10, data: ['请求数', '用户消费'] },
    xAxis: { type: 'category', data: usage.trend.map((row) => row.date.slice(5)), axisLabel: { color: '#69716b' } },
    yAxis: [
      { type: 'value', name: '请求', splitLine: { lineStyle: { color: '#edf0eb' } } },
      { type: 'value', name: '消费', splitLine: { show: false } }
    ],
    series: [
      lineSeries('请求数', usage.trend.map((row) => row.available === false ? null : row.total_requests), '#176b4d'),
      lineSeries('用户消费', usage.trend.map((row) => row.available === false ? null : row.actual_cost), '#b05a3c', 1)
    ]
  });
  $('overview-finance-zone').textContent = overview.timezones.finance;
  $('overview-payments').innerHTML = overview.payments.length ? overview.payments.map((item) => `
    <div class="compact-row"><div class="grow"><strong>${escapeHtml(item.currency)}</strong><span>${formatInteger(item.orders_month)} 笔成功支付</span></div><strong class="amount">${escapeHtml(formatMoney(item.paid_month, item.currency))}</strong></div>
  `).join('') : '<div class="compact-row"><div class="grow"><strong>本月暂无支付</strong><span>paid_at 口径</span></div></div>';
  const alerts = [];
  if (!overview.coverage.daily_from) alerts.push(alertHtml('warning', '日汇总当前没有可用数据。'));
  if (usage.trend.some((row) => row.available === false)) alerts.push(alertHtml('warning', '所选范围存在无汇总桶日期；它们显示为空缺，不会自动当作 0。'));
  $('overview-alerts').innerHTML = alerts.join('');
  setPageMeta(`更新于 ${formatDateTime(overview.generatedAt)} · 用量 ${overview.timezones.usage} · 资金 ${overview.timezones.finance}`);
  refreshIcons();
}

function formRange(formId) {
  const form = $(formId);
  return { start: form.elements.start.value, end: form.elements.end.value };
}

async function loadUsage() {
  setPageMeta('日汇总最长 730 天，维度明细最近 30 天');
  const range = formRange('usage-filter');
  const dimension = $('usage-filter').elements.dimension.value;
  const usage = await api(`/api/metrics/usage?${new URLSearchParams(range)}`);
  $('usage-metrics').innerHTML = [
    metricCard('请求记录数', formatInteger(usage.summary.total_requests), `${usage.range.days} 天`, 'green'),
    metricCard('区间活跃用户', formatInteger(usage.summary.active_users), '所选自然日去重', 'green'),
    metricCard('输入 Token', formatInteger(usage.summary.input_tokens), '不含缓存读取', 'blue'),
    metricCard('输出 Token', formatInteger(usage.summary.output_tokens), '', 'amber'),
    metricCard('用户消费', formatDecimal(usage.summary.actual_cost, 4), 'actual_cost', 'red'),
    metricCard('标准计价', formatDecimal(usage.summary.total_cost, 4), 'total_cost', 'blue'),
    metricCard('账号成本', formatDecimal(usage.summary.account_cost, 4), 'account_cost', 'amber'),
    metricCard('平均耗时', formatDuration(usage.summary.average_duration_ms), '总耗时 / 请求数', 'green'),
    metricCard('汇总桶', formatInteger(usage.coverage.stored_buckets), `${usage.coverage.available_from || 'N/A'} 起`, 'blue')
  ].join('');
  $('usage-zone').textContent = `${usage.timezone} 日桶 · ${range.start} 至 ${range.end}`;
  $('usage-notices').innerHTML = [
    ...usage.limitations.map((message) => alertHtml('warning', message)),
    ...(usage.trend.some((row) => row.available === false) ? [alertHtml('warning', '空缺日期没有被填成业务零值。')] : [])
  ].join('');
  chart('usage-chart', {
    legend: { top: 2, right: 10, data: ['请求数', '总 Token', '用户消费'] },
    xAxis: { type: 'category', data: usage.trend.map((row) => row.date), axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: 'value', name: '请求 / Token', splitLine: { lineStyle: { color: '#edf0eb' } } },
      { type: 'value', name: '消费', splitLine: { show: false } }
    ],
    series: [
      lineSeries('请求数', usage.trend.map((row) => row.available === false ? null : row.total_requests), '#176b4d'),
      lineSeries('总 Token', usage.trend.map((row) => row.available === false ? null : row.input_tokens + row.output_tokens), '#2d5ea8'),
      lineSeries('用户消费', usage.trend.map((row) => row.available === false ? null : row.actual_cost), '#ae3636', 1)
    ]
  });
  const detailRetentionDays = Number(usage.detailRetentionDays || 30);
  const detailCutoff = addDays(todayString(), -(detailRetentionDays - 1));
  if (usage.range.days > detailRetentionDays || range.start < detailCutoff) {
    $('usage-dimensions').innerHTML = emptyRow(6, '该范围超出请求明细保证期，维度分布不可恢复');
  } else {
    try {
      const params = new URLSearchParams({ ...range, dimension });
      const details = await api(`/api/metrics/usage/dimensions?${params}`);
      $('usage-dimensions').innerHTML = details.rows.length ? details.rows.map((row) => `
        <tr><td>${escapeHtml(row.label)}</td><td class="numeric">${formatInteger(row.requests)}</td><td class="numeric">${formatInteger(row.input_tokens)}</td><td class="numeric">${formatInteger(row.output_tokens)}</td><td class="numeric">${formatDecimal(row.actual_cost, 4)}</td><td class="numeric">${formatDuration(row.average_duration_ms)}</td></tr>
      `).join('') : emptyRow(6);
    } catch (error) {
      $('usage-dimensions').innerHTML = emptyRow(6, error.message);
    }
  }
  refreshIcons();
}

async function loadUsers() {
  setPageMeta('用量活跃口径，不等同登录活跃');
  const range = formRange('users-filter');
  const data = await api(`/api/metrics/users?${new URLSearchParams(range)}`);
  $('users-metrics').innerHTML = [
    metricCard('区间活跃用户', formatInteger(data.summary.active_users), '区间内去重', 'green'),
    metricCard('新增注册', formatInteger(data.summary.new_users), data.timezone, 'blue'),
    metricCard('首次观测活跃', formatInteger(data.summary.first_observed_users), '受历史覆盖限制', 'amber'),
    metricCard('7 日激活率', data.activation7d.rate == null ? 'N/A' : `${formatDecimal(data.activation7d.rate * 100, 1)}%`, `${formatInteger(data.activation7d.activated_7d)} / ${formatInteger(data.activation7d.mature_registrations)}`, 'red'),
    metricCard('当前保留用户', formatInteger(data.summary.retained_users), '未物理删除', 'blue'),
    metricCard('当前可用用户', formatInteger(data.summary.available_users), 'status=active', 'green')
  ].join('');
  $('users-zone').textContent = `${data.timezone} 自然日 · 缺失活跃桶显示为空`;
  chart('users-chart', {
    legend: { top: 2, right: 10, data: ['活跃用户', '新增注册'] },
    xAxis: { type: 'category', data: data.trend.map((row) => row.date), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#edf0eb' } } },
    series: [
      lineSeries('活跃用户', data.trend.map((row) => row.activeUsers), '#176b4d'),
      { ...lineSeries('新增注册', data.trend.map((row) => row.newUsers), '#2d5ea8'), type: 'bar', barMaxWidth: 18, areaStyle: undefined }
    ]
  });
  const now = todayString();
  $('users-cohorts').innerHTML = data.cohorts.length ? data.cohorts.slice().reverse().map((row) => {
    const rate = (value, days) => addDays(row.cohort_date, days) > now ? '未成熟' : (row.registered ? `${formatDecimal(value / row.registered * 100, 1)}%` : 'N/A');
    return `<tr><td>${escapeHtml(row.cohort_date)}</td><td class="numeric">${formatInteger(row.registered)}</td><td class="numeric">${rate(row.retained_d1, 1)}</td><td class="numeric">${rate(row.retained_d7, 7)}</td><td class="numeric">${rate(row.retained_d30, 30)}</td></tr>`;
  }).join('') : emptyRow(5);
}

async function loadFinance() {
  setPageMeta('现金与额度分账展示');
  const range = formRange('finance-filter');
  const data = await api(`/api/metrics/finance?${new URLSearchParams(range)}`);
  const cards = data.summary.flatMap((row) => [
    metricCard(`${row.currency} ${row.order_type} 实收`, formatMoney(row.gross_received, row.currency), `${formatInteger(row.orders)} 笔`, 'green'),
    metricCard(`${row.currency} ${row.order_type} 净额`, formatMoney(row.netReceived, row.currency), `退款估算 ${formatMoney(row.estimated_cash_refund, row.currency)}`, 'blue')
  ]);
  cards.push(metricCard('数据异常项', formatInteger(Object.values(data.anomalies).reduce((sum, value) => sum + Number(value || 0), 0)), '需要人工核对', 'amber'));
  $('finance-metrics').innerHTML = cards.join('') || metricCard('区间实收', '0', '', 'green');
  $('finance-notices').innerHTML = data.caveats.map((message) => alertHtml('info', message)).join('');
  $('finance-zone').textContent = `${data.timezone} · 退款为系统字段比例估算`;
  const dates = [...new Set([...data.payments.map((row) => row.date), ...data.refunds.map((row) => row.date)])].sort();
  const currencies = [...new Set([...data.payments.map((row) => row.currency), ...data.refunds.map((row) => row.currency)])];
  const series = [];
  currencies.forEach((currency, index) => {
    const colors = ['#176b4d', '#2d5ea8', '#9b6518', '#704c9b'];
    series.push(lineSeries(`${currency} 实收`, dates.map((date) => data.payments.filter((row) => row.date === date && row.currency === currency).reduce((sum, row) => sum + row.gross_received, 0)), colors[index % colors.length]));
    series.push(lineSeries(`${currency} 退款`, dates.map((date) => data.refunds.filter((row) => row.date === date && row.currency === currency).reduce((sum, row) => sum + row.estimated_cash_refund, 0)), '#ae3636'));
  });
  chart('finance-chart', {
    legend: { top: 2, right: 10 },
    xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#edf0eb' } } },
    series
  });
  $('finance-summary').innerHTML = data.summary.length ? data.summary.map((row) => `
    <tr><td>${escapeHtml(row.currency)}</td><td>${escapeHtml(row.order_type)}</td><td class="numeric">${formatInteger(row.orders)}</td><td class="numeric">${formatMoney(row.gross_received)}</td><td class="numeric">${formatMoney(row.estimated_cash_refund)}</td><td class="numeric">${formatMoney(row.netReceived)}</td></tr>
  `).join('') : emptyRow(6);
  $('finance-credits').innerHTML = data.credits.length ? data.credits.map((row) => `
    <tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.source)}</td><td class="numeric">${formatInteger(row.events)}</td><td class="numeric">${formatDecimal(row.credited_amount, 4)}</td></tr>
  `).join('') : emptyRow(4);
  refreshIcons();
}

async function loadStorage(refresh = false) {
  setPageMeta('数据库关系与运行期增长样本');
  const data = await api(`/api/storage${refresh ? '?refresh=true' : ''}`);
  $('storage-metrics').innerHTML = [
    metricCard('数据库总大小', formatBytes(data.database.database_bytes), data.database.database, 'green'),
    metricCard('清理候选关系', formatBytes(data.totals.candidateBytes), '非等同可释放空间', 'amber'),
    metricCard('非清理候选关系', formatBytes(data.totals.protectedBytes), '未知对象也默认保护', 'blue'),
    metricCard('估算日增长', data.growth.available ? formatBytes(data.growth.databaseBytesPerDay) : 'N/A', data.growth.available ? `${data.growth.sampleCount} 个进程内样本` : data.growth.reason, 'red')
  ].join('');
  const notices = [alertHtml('info', data.physicalReleaseNote), alertHtml('warning', data.filesystem.reason)];
  if (data.maintenance.longTransactions?.oldestSeconds > 300) notices.push(alertHtml('warning', `存在超过 5 分钟的事务，最老 ${formatDuration(data.maintenance.longTransactions.oldestSeconds * 1000)}。`));
  for (const slot of data.maintenance.replicationSlots || []) {
    if (slot.retainedWalBytes > 1024 ** 3) notices.push(alertHtml('warning', `复制槽 ${slot.slotName} 保留 WAL ${formatBytes(slot.retainedWalBytes)}。`));
  }
  $('storage-notices').innerHTML = notices.join('');
  $('storage-relations').innerHTML = data.relations.length ? data.relations.map((row) => {
    const properties = [row.cleanupCandidate ? badge('partial').replace('部分完成', '清理候选') : '', row.protected ? '<span class="badge success">受保护</span>' : '', row.parent_table ? `<span class="badge neutral">分区: ${escapeHtml(row.parent_table)}</span>` : ''].filter(Boolean).join(' ');
    return `<tr><td><strong>${escapeHtml(row.table_name)}</strong><br><span class="muted">${escapeHtml(row.schema_name)}</span></td><td>${properties || '<span class="muted">业务表</span>'}</td><td class="numeric">${formatBytes(row.total_bytes)}</td><td class="numeric">${formatBytes(row.heap_bytes)}</td><td class="numeric">${formatBytes(row.index_bytes)}</td><td class="numeric">${formatInteger(row.estimated_live_rows)}</td><td class="numeric">${formatInteger(row.estimated_dead_rows)}</td><td>${formatDateTime(row.last_autovacuum)}</td></tr>`;
  }).join('') : emptyRow(8);
  setPageMeta(`测量于 ${formatDateTime(data.generatedAt)} · 文件系统余量不可从远程数据库推断`);
  refreshIcons();
}

async function loadRetention() {
  setPageMeta('自动调度与手动预览、备份、复核、分批执行');
  const [policy, automation, runs] = await Promise.all([
    api('/api/retention/policy'),
    api('/api/retention/automation'),
    api('/api/retention/runs')
  ]);
  state.policy = policy;
  const status = [];
  status.push(alertHtml(policy.cleanupEnabled ? 'success' : 'warning', policy.cleanupEnabled
    ? '清理执行已启用；所有安全闸门仍会逐项复核。'
    : '当前为只读模式。设置 OPERATIONS_CENTER_ENABLE_CLEANUP=true 并配置独立维护连接后才能执行。'));
  status.push(alertHtml('info', policy.nativeConfiguration.note));
  $('retention-status').innerHTML = status.join('');
  renderAutomaticCleanup(automation, policy);
  $('policy-list').innerHTML = policy.policies.map((item) => `
    <label class="policy-row">
      <input type="checkbox" name="cleanup-target" value="${escapeHtml(item.id)}" checked>
      <span><strong>${escapeHtml(item.label)}</strong><small>${item.tables.map(escapeHtml).join(', ')}</small></span>
      <span class="badge ${item.critical ? 'warning' : 'neutral'}">${formatInteger(item.retentionDays)} 天</span>
      <span class="policy-effect">${escapeHtml(item.effect)}</span>
    </label>
  `).join('');
  renderRuns(runs.items);
  refreshIcons();
}

function renderAutomaticCleanup(automation, policy) {
  const policyById = new Map(policy.policies.map((item) => [item.id, item.label]));
  const displayStatus = !automation.enabled ? 'disabled' : automation.running ? 'running' : automation.ready ? 'ready' : 'blocked';
  $('automatic-cleanup-badge').outerHTML = badge(displayStatus).replace('<span ', '<span id="automatic-cleanup-badge" ');
  const phaseLabels = { idle: '等待计划', preview: '生成预览', backup: '等待备份', execute: '提交清理', cleanup: '分批清理中' };
  const last = automation.lastAttempt;
  const lastStatus = last?.cleanup?.status || last?.status;
  const lastMessage = last?.cleanup?.error?.message || last?.error?.message || last?.reason ||
    (last?.cleanup ? `已删除 ${formatInteger(last.cleanup.deletedRows)} 行` : last?.runId ? `运行 ${last.runId.slice(0, 12)}` : `符合 ${formatInteger(last?.eligibleRows)} 行`);
  const lastDetail = last
    ? `${badge(lastStatus)} <strong>${formatDateTime(last.cleanup?.finishedAt || last.finishedAt || last.startedAt)}</strong><small>${escapeHtml(lastMessage)}</small>`
    : '<strong>尚无自动运行</strong><small>首次执行将在下一个计划时间触发</small>';
  $('automatic-cleanup-summary').innerHTML = `
    <div class="schedule-field"><span>当前状态</span><strong>${escapeHtml(automation.running ? phaseLabels[automation.phase] || automation.phase : automation.ready ? '等待计划' : automation.enabled ? '配置未就绪' : '未启用')}</strong></div>
    <div class="schedule-field"><span>每日时间</span><strong>${escapeHtml(automation.schedule.time)} · ${escapeHtml(automation.schedule.timezone)}</strong></div>
    <div class="schedule-field"><span>下次执行</span><strong>${automation.schedule.nextRunAt ? formatDateTime(automation.schedule.nextRunAt) : 'N/A'}</strong></div>
    <div class="schedule-field"><span>备份等待上限</span><strong>${formatInteger(automation.backupWaitMinutes)} 分钟</strong></div>
    <div class="schedule-field wide"><span>自动目标</span><strong>${automation.targets.map((id) => escapeHtml(policyById.get(id) || id)).join('、')}</strong></div>
    <div class="schedule-field wide"><span>最近尝试</span>${lastDetail}</div>
  `;
}

function renderPreview(preview) {
  state.preview = preview;
  $('preview-panel').hidden = false;
  $('preview-meta').textContent = `预览 ${preview.id.slice(0, 8)} · ${formatDateTime(preview.expiresAt)} 过期`;
  const alerts = [];
  if (preview.blockers.length) preview.blockers.forEach((message) => alerts.push(alertHtml('error', message)));
  else alerts.push(alertHtml('success', '当前预览通过数据侧检查；执行时仍会重新复核。'));
  alerts.push(alertHtml(preview.backup.satisfied ? 'success' : 'warning', preview.backup.satisfied
    ? `最近成功备份：${formatDateTime(preview.backup.latest?.finishedAt)}`
    : preview.backupRequirement));
  if (preview.usageCoverage) alerts.push(alertHtml(preview.usageCoverage.passed ? 'success' : 'error', preview.usageCoverage.passed
    ? `用量原始数据与日汇总核对通过，聚合水位延迟 ${formatDuration(preview.usageCoverage.watermark?.lagSeconds * 1000)}。`
    : `用量聚合核对失败：${preview.usageCoverage.reason}`));
  $('preview-alerts').innerHTML = alerts.join('');
  $('preview-targets').innerHTML = preview.targets.map((target) => `
    <tr><td><strong>${escapeHtml(target.label)}</strong><br><span class="muted">${target.tables.map((table) => escapeHtml(table.table)).join(', ')}</span></td><td>${formatDateTime(target.cutoff)}</td><td class="numeric">${formatInteger(target.eligibleRows)}</td><td class="numeric">${formatBytes(target.estimatedLogicalBytes)}</td><td>${escapeHtml(target.effect)}</td></tr>
  `).join('');
  $('confirmation-phrase').placeholder = preview.confirmationPhrase;
  $('confirmation-phrase').value = '';
  $('confirm-impact').checked = false;
  $('confirm-downstream').checked = false;
  $('execute-button').disabled = !preview.executable || !state.policy?.cleanupEnabled;
  refreshIcons();
  $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRuns(runs) {
  $('cleanup-runs').innerHTML = runs.length ? runs.map((run) => `
    <div class="run-row">
      <div><strong class="run-id">${escapeHtml(run.id.slice(0, 12))}</strong><div class="muted">${formatDateTime(run.startedAt || run.createdAt)}</div></div>
      <div>${badge(run.status)}</div>
      <div><span class="muted">删除行数</span><br><strong>${formatInteger(run.deletedRows)}</strong></div>
      <div><span class="muted">执行人</span><br><strong>${escapeHtml(run.actor)}</strong></div>
      <div class="run-actions">
        ${['queued', 'running'].includes(run.status) ? `<button class="icon-button cancel-run-button" data-run-id="${escapeHtml(run.id)}" title="停止后续清理批次" aria-label="停止后续清理批次">${icon('circle-stop')}</button>` : ''}
        <button class="icon-button report-button" data-run-id="${escapeHtml(run.id)}" title="下载运行报告" aria-label="下载运行报告">${icon('download')}</button>
      </div>
    </div>
  `).join('') : '<div class="compact-row"><div class="grow"><strong>尚无清理运行</strong><span>生成预览不会删除数据</span></div></div>';
  document.querySelectorAll('.cancel-run-button').forEach((button) => button.addEventListener('click', () => cancelRun(button.dataset.runId)));
  document.querySelectorAll('.report-button').forEach((button) => button.addEventListener('click', () => downloadRun(button.dataset.runId)));
  refreshIcons();
  const active = runs.some((run) => ['queued', 'running'].includes(run.status));
  if (active && !state.runPoller) {
    state.runPoller = setInterval(async () => {
      try {
        const latest = await api('/api/retention/runs');
        renderRuns(latest.items);
        if (!latest.items.some((run) => ['queued', 'running'].includes(run.status))) {
          clearInterval(state.runPoller);
          state.runPoller = null;
          toast('清理运行已结束');
        }
      } catch {}
    }, 3000);
  }
}

async function cancelRun(id) {
  const button = document.querySelector(`.cancel-run-button[data-run-id="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  try {
    await api(`/api/retention/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
    toast('已请求停止，当前事务完成后不再启动新批次');
    const runs = await api('/api/retention/runs');
    renderRuns(runs.items);
  } catch (error) {
    toast(error.message, 'error');
    if (button) button.disabled = false;
  }
}

async function downloadRun(id) {
  try {
    const headers = state.sessionToken ? { authorization: `Session ${state.sessionToken}` } : {};
    const response = await fetch(`/api/retention/runs/${encodeURIComponent(id)}/report`, {
      headers,
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error('报告下载失败');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sub2api-cleanup-report-${id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function createPreview() {
  const targets = [...document.querySelectorAll('input[name="cleanup-target"]:checked')].map((node) => node.value);
  if (!targets.length) return toast('至少选择一个清理目标', 'error');
  $('preview-button').disabled = true;
  try {
    const preview = await api('/api/retention/previews', { method: 'POST', body: JSON.stringify({ targets }) });
    renderPreview(preview);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('preview-button').disabled = false;
  }
}

async function triggerBackup() {
  $('backup-button').disabled = true;
  try {
    await api('/api/retention/backups', { method: 'POST', body: '{}' });
    toast('Sub2API 原生备份已启动，完成后才能执行清理');
  } catch (error) {
    toast(`${error.message}。可在 Sub2API 原生备份页完成备份。`, 'error');
  } finally {
    $('backup-button').disabled = false;
  }
}

async function executeCleanup() {
  if (!state.preview) return;
  $('execute-button').disabled = true;
  try {
    const run = await api('/api/retention/runs', {
      method: 'POST',
      body: JSON.stringify({
        previewId: state.preview.id,
        confirmationPhrase: $('confirmation-phrase').value,
        acknowledgeImpact: $('confirm-impact').checked,
        acknowledgeDownstream: $('confirm-downstream').checked
      })
    });
    toast(`清理任务 ${run.id.slice(0, 8)} 已进入执行队列`);
    state.preview = null;
    $('preview-panel').hidden = true;
    const runs = await api('/api/retention/runs');
    renderRuns(runs.items);
  } catch (error) {
    toast(error.message, 'error');
    $('execute-button').disabled = false;
  }
}

async function loadMaintenance() {
  setPageMeta('版本、数据库结构与执行能力');
  const data = await api('/api/capabilities');
  const existing = Object.values(data.schema.tables).filter((table) => table.exists).length;
  const total = Object.keys(data.schema.tables).length;
  $('maintenance-metrics').innerHTML = [
    metricCard('Schema 兼容', data.schema.compatible ? '通过' : '失败', data.schema.missingRequired.join(', ') || '必要表完整', data.schema.compatible ? 'green' : 'red'),
    metricCard('识别对象', `${existing} / ${total}`, '按白名单探测', 'blue'),
    metricCard('Sub2API 版本', data.version?.version || data.version?.current_version || 'N/A', data.versionError?.message || '', 'amber'),
    metricCard('清理执行', data.cleanupEnabled && data.maintenanceConnectionConfigured ? '可用' : '只读', data.configuredTimezone, data.cleanupEnabled ? 'green' : 'amber')
  ].join('');
  $('schema-checked-at').textContent = formatDateTime(data.schema.checkedAt);
  $('schema-capabilities').innerHTML = Object.entries(data.schema.tables).map(([name, table]) => `
    <tr><td>${escapeHtml(name)}</td><td>${table.exists ? badge('available') : badge('missing')}</td><td>${table.partitioned ? '是' : '否'}</td><td class="numeric">${formatInteger(table.columns.length)}</td></tr>
  `).join('');
  setConnection(data.schema.compatible, data.schema.compatible ? '数据源正常' : 'Schema 不兼容');
  refreshIcons();
}

function settingField(label, value, note = '') {
  return `<div class="schedule-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
}

function renderSettingsStatus(data) {
  state.settings = data;
  const read = data.database.read;
  const maintenance = data.database.maintenance;
  $('settings-metrics').innerHTML = [
    metricCard('统计数据库', read.configured ? '已连接' : '待配置', read.connection?.user || '无读取角色', read.configured ? 'green' : 'red'),
    metricCard('清理数据库', maintenance.configured ? '已隔离' : '未配置', maintenance.connection?.user || '无维护角色', maintenance.configured ? 'green' : 'amber'),
    metricCard('登录模式', data.authentication.mode === 'sub2api' ? 'Sub2API SSO' : '独立登录', data.authentication.persistentAdminCredentialsConfigured ? '含持久 API 凭据' : '交互会话', 'blue'),
    metricCard('自动清理', data.cleanup.automatic.enabled ? '已启用' : '未启用', data.cleanup.automatic.enabled ? `${data.cleanup.automatic.time} / ${data.cleanup.automatic.targets.length} 项` : '默认关闭', data.cleanup.automatic.enabled ? 'amber' : '')
  ].join('');
  const alerts = [];
  if (data.setupRequired) {
    alerts.push(alertHtml('warning', '尚未配置统计数据库。完成下方数据库访问初始化后，运营统计与存储诊断会立即可用。'));
  }
  if (read.configured && !maintenance.configured) {
    alerts.push(alertHtml('info', '当前只具备读取能力；统计功能正常，任何数据删除都会被阻断。'));
  }
  if (data.cleanup.automatic.enabled && !data.authentication.persistentAdminCredentialsConfigured) {
    alerts.push(alertHtml('warning', '自动清理当前依赖浏览器 SSO Token；Token 过期或服务重启后，备份阶段会安全失败且不会删除数据。'));
  }
  $('settings-alerts').innerHTML = alerts.join('');
  $('database-setup-badge').className = `badge ${read.configured ? 'success' : 'warning'}`;
  $('database-setup-badge').textContent = read.configured ? '已配置' : '待初始化';
  $('database-access-summary').innerHTML = [
    settingField('读取来源', read.source === 'managed' ? '页面托管' : read.source === 'environment' ? '部署配置' : '未配置'),
    settingField('数据库', read.connection?.database || 'N/A', read.connection?.host ? `${read.connection.host}:${read.connection.port}` : ''),
    settingField('读取角色', read.connection?.user || 'N/A'),
    settingField('清理角色', maintenance.connection?.user || '未配置')
  ].join('');
  $('sub2api-api-summary').textContent = data.authentication.sub2apiBaseUrlConfigured
    ? `管理 API 已配置${data.authentication.sub2apiPublicUrl ? ` / ${data.authentication.sub2apiPublicUrl}` : ''}`
    : '部署尚未配置 Sub2API 管理 API 地址';
  $('sub2api-credential-badge').className = `badge ${data.authentication.persistentAdminCredentialsConfigured ? 'success' : 'neutral'}`;
  $('sub2api-credential-badge').textContent = data.authentication.persistentAdminCredentialsConfigured ? '持久认证' : '仅会话';
  const credentialForm = $('sub2api-credential-form');
  credentialForm.elements.mode.value = data.authentication.persistentCredentialType || 'session';
  credentialForm.querySelector('button[type="submit"]').disabled = !data.authentication.sub2apiBaseUrlConfigured;
  updateCredentialFields();

  const databaseForm = $('database-provision-form');
  $('database-test-button').disabled = !data.databaseSetupEnabled;
  $('database-provision-button').disabled = !data.databaseSetupEnabled;
  if (read.connection) {
    databaseForm.elements.host.value = read.connection.host || databaseForm.elements.host.value;
    databaseForm.elements.port.value = read.connection.port || databaseForm.elements.port.value;
    databaseForm.elements.database.value = read.connection.database || databaseForm.elements.database.value;
  }
  const cleanupForm = $('cleanup-settings-form');
  cleanupForm.elements.enabled.checked = data.cleanup.enabled;
  cleanupForm.elements.enabled.disabled = !data.cleanup.maintenanceConnectionConfigured && !data.cleanup.enabled;
  cleanupForm.elements.automaticEnabled.checked = data.cleanup.automatic.enabled;
  cleanupForm.elements.automaticTime.value = data.cleanup.automatic.time;
  cleanupForm.elements.backupWaitMinutes.max = Math.max(1, data.cleanup.previewTtlMinutes - 2);
  cleanupForm.elements.backupWaitMinutes.value = data.cleanup.automatic.backupWaitMinutes;
  for (const [name, value] of Object.entries(data.cleanup.retention)) {
    if (cleanupForm.elements[name]) cleanupForm.elements[name].value = value;
  }
  const selected = new Set(data.cleanup.automatic.targets);
  cleanupForm.querySelectorAll('input[name="automaticTargets"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
  updateCleanupControlState();
  refreshIcons();
}

async function loadSettings() {
  setPageMeta('连接、权限、安全闸门与运行配置');
  const data = await api('/api/settings');
  renderSettingsStatus(data);
  setConnection(!data.setupRequired, data.setupRequired ? '等待数据库配置' : '配置正常');
  if (!$('settings-checks').children.length) {
    $('settings-checks').innerHTML = emptyRow(3, '尚未运行依赖检查');
  }
}

function databaseSetupPayload() {
  const form = $('database-provision-form');
  return {
    host: form.elements.host.value.trim(),
    port: Number(form.elements.port.value),
    database: form.elements.database.value.trim(),
    username: form.elements.username.value.trim(),
    password: form.elements.password.value,
    sslMode: form.elements.sslMode.value,
    readRole: form.elements.readRole.value.trim(),
    createMaintenance: form.elements.createMaintenance.checked,
    maintenanceRole: form.elements.maintenanceRole.value.trim(),
    grantMonitoring: form.elements.grantMonitoring.checked,
    hardenPublicSchema: form.elements.hardenPublicSchema.checked
  };
}

function showSettingsFormError(id, message = '') {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
}

async function testDatabaseAdministrator() {
  const button = $('database-test-button');
  button.disabled = true;
  showSettingsFormError('database-setup-error');
  try {
    const result = await api('/api/settings/database/test', {
      method: 'POST',
      body: JSON.stringify(databaseSetupPayload())
    });
    const status = result.canCreateRoles && result.canGrantCurrentTables && result.publicSchemaAvailable;
    toast(status ? `连接成功：${result.database} / ${result.user}` : '连接成功，但该账号缺少创建角色或授权能力', status ? '' : 'error');
  } catch (error) {
    showSettingsFormError('database-setup-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function provisionDatabase(event) {
  event.preventDefault();
  const button = $('database-provision-button');
  button.disabled = true;
  showSettingsFormError('database-setup-error');
  try {
    const result = await api('/api/settings/database/provision', {
      method: 'POST',
      body: JSON.stringify(databaseSetupPayload())
    });
    $('database-provision-form').elements.password.value = '';
    toast(result.schemaCompatible ? '受限数据库账号已创建并启用' : '账号已创建，但 Schema 兼容检查未通过', result.schemaCompatible ? '' : 'error');
    await loadSettings();
    await runSettingsChecks();
  } catch (error) {
    showSettingsFormError('database-setup-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function runSettingsChecks() {
  const button = $('settings-check-button');
  button.disabled = true;
  try {
    const data = await api('/api/settings/checks', { method: 'POST', body: '{}' });
    $('settings-checked-at').textContent = formatDateTime(data.generatedAt);
    $('settings-checks').innerHTML = data.checks.map((check) => `
      <tr><td>${escapeHtml(check.label)}</td><td>${badge(check.status)}</td><td>${escapeHtml(check.detail)}</td></tr>
    `).join('') || emptyRow(3);
    refreshIcons();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function saveCleanupSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showSettingsFormError('cleanup-settings-error');
  const numberField = (name) => Number(form.elements[name].value);
  try {
    await api('/api/settings/cleanup', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: form.elements.enabled.checked,
        automaticEnabled: form.elements.automaticEnabled.checked,
        automaticTime: form.elements.automaticTime.value,
        automaticTargets: [...form.querySelectorAll('input[name="automaticTargets"]:checked')].map((input) => input.value),
        backupWaitMinutes: numberField('backupWaitMinutes'),
        retention: {
          usageLogsDays: numberField('usageLogsDays'),
          usageHourlyDays: numberField('usageHourlyDays'),
          usageDailyDays: numberField('usageDailyDays'),
          systemLogDays: numberField('systemLogDays'),
          errorLogDays: numberField('errorLogDays'),
          opsMetricDays: numberField('opsMetricDays')
        }
      })
    });
    toast('清理与保留设置已保存');
    await loadSettings();
  } catch (error) {
    showSettingsFormError('cleanup-settings-error', error.message);
  } finally {
    button.disabled = false;
  }
}

function updateCredentialFields() {
  const form = $('sub2api-credential-form');
  const mode = form.elements.mode.value;
  form.querySelectorAll('[data-credential-field]').forEach((label) => {
    const visible = label.dataset.credentialField === mode;
    label.hidden = !visible;
    const input = label.querySelector('input');
    if (input) input.required = visible;
  });
}

function updateCleanupControlState() {
  const form = $('cleanup-settings-form');
  const executionEnabled = form.elements.enabled.checked;
  form.elements.automaticEnabled.disabled = !executionEnabled;
  if (!executionEnabled) form.elements.automaticEnabled.checked = false;
}

async function saveSub2ApiCredentials(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showSettingsFormError('sub2api-credential-error');
  const mode = form.elements.mode.value;
  const payload = mode === 'token'
    ? { mode, token: form.elements.token.value }
    : mode === 'account'
      ? { mode, email: form.elements.email.value.trim(), password: form.elements.password.value }
      : { mode: 'session' };
  try {
    await api('/api/settings/sub2api-credentials', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    form.elements.token.value = '';
    form.elements.password.value = '';
    toast(mode === 'session' ? '已改为仅使用当前 SSO 会话' : 'Sub2API 管理凭据已验证并加密保存');
    await loadSettings();
  } catch (error) {
    showSettingsFormError('sub2api-credential-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function navigateAfterAuthentication(initialView) {
  try {
    const settings = await api('/api/settings');
    const view = settings.setupRequired ? 'settings' : (titles[initialView] ? initialView : 'overview');
    navigate(view);
  } catch {
    navigate(titles[initialView] ? initialView : 'overview');
  }
}

async function loadCurrentView(options = {}) {
  const loaders = {
    overview: loadOverview,
    usage: loadUsage,
    users: loadUsers,
    finance: loadFinance,
    storage: () => loadStorage(options.refresh),
    retention: loadRetention,
    maintenance: loadMaintenance,
    settings: loadSettings
  };
  try {
    await loaders[state.currentView]();
    if (!['maintenance', 'settings'].includes(state.currentView)) setConnection(true, '数据源正常');
  } catch (error) {
    setConnection(false, '数据源异常');
    setPageMeta(error.message);
    toast(error.message, 'error');
  } finally {
    revealActiveTab();
  }
}

function navigate(view) {
  if (!titles[view]) return;
  state.currentView = view;
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.id === `view-${view}`));
  document.querySelectorAll('.module-tab').forEach((node) => {
    const active = node.dataset.view === view;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', String(active));
    node.tabIndex = active ? 0 : -1;
  });
  revealActiveTab();
  $('page-title').textContent = titles[view];
  history.replaceState(null, '', `#${view}`);
  loadCurrentView();
}

async function initialize() {
  setDefaultDates('usage-filter', 30);
  setDefaultDates('users-filter', 30);
  setDefaultDates('finance-filter', 30);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const redirectedSession = hash.get('oc_session');
  const initialView = redirectedSession ? 'overview' : location.hash.slice(1);
  if (redirectedSession) {
    state.sessionToken = redirectedSession;
    browserSession.setItem('operations-center.session', redirectedSession);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  const query = new URLSearchParams(location.search);
  const ssoError = query.get('sso_error');
  const upstreamToken = query.get('token') || query.get('access_token');
  if (upstreamToken || ssoError) {
    query.delete('token');
    query.delete('access_token');
    query.delete('sso_error');
    const cleanQuery = query.toString();
    history.replaceState(null, '', `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`);
  }
  try {
    state.authConfig = await api('/api/auth/config');
    if (state.authConfig.ssoEnabled) {
      $('login-hint').textContent = '请从已登录的 Sub2API 管理员自定义菜单进入';
      if (state.authConfig.sub2apiUrl) {
        $('sub2api-login-link').href = state.authConfig.sub2apiUrl;
        $('sub2api-login-link').hidden = false;
      }
    }
    if (ssoError) {
      state.sessionToken = '';
      browserSession.removeItem('operations-center.session');
      showLogin(ssoErrorMessage(ssoError));
      return;
    }
    if (upstreamToken) {
      const session = await api('/api/auth/sso', {
        method: 'POST',
        headers: { authorization: `Bearer ${upstreamToken}` },
        body: '{}'
      });
      showApp(session);
      await navigateAfterAuthentication(initialView);
      return;
    }
    const session = await api('/api/auth/me');
    showApp(session);
    await navigateAfterAuthentication(initialView);
  } catch (error) {
    showLogin(ssoError
      ? ssoErrorMessage(ssoError)
      : upstreamToken ? ssoErrorMessage(error.code) : '');
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').hidden = true;
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const session = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('login-username').value, password: $('login-password').value })
    });
    showApp(session);
    await navigateAfterAuthentication('overview');
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  state.sessionToken = '';
  browserSession.removeItem('operations-center.session');
  showLogin();
});
document.querySelectorAll('.module-tab').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
$('refresh-button').addEventListener('click', () => loadCurrentView({ refresh: true }));
$('usage-filter').addEventListener('submit', (event) => { event.preventDefault(); loadUsage().catch((error) => toast(error.message, 'error')); });
$('users-filter').addEventListener('submit', (event) => { event.preventDefault(); loadUsers().catch((error) => toast(error.message, 'error')); });
$('finance-filter').addEventListener('submit', (event) => { event.preventDefault(); loadFinance().catch((error) => toast(error.message, 'error')); });
$('storage-refresh').addEventListener('click', () => loadStorage(true).catch((error) => toast(error.message, 'error')));
$('preview-button').addEventListener('click', createPreview);
$('backup-button').addEventListener('click', triggerBackup);
$('execute-button').addEventListener('click', executeCleanup);
$('settings-check-button').addEventListener('click', runSettingsChecks);
$('database-test-button').addEventListener('click', testDatabaseAdministrator);
$('database-provision-form').addEventListener('submit', provisionDatabase);
$('cleanup-settings-form').addEventListener('submit', saveCleanupSettings);
$('sub2api-credential-form').addEventListener('submit', saveSub2ApiCredentials);
$('sub2api-credential-form').elements.mode.addEventListener('change', updateCredentialFields);
$('cleanup-settings-form').elements.enabled.addEventListener('change', updateCleanupControlState);
$('database-provision-form').elements.createMaintenance.addEventListener('change', (event) => {
  $('database-provision-form').elements.maintenanceRole.disabled = !event.currentTarget.checked;
});
window.addEventListener('resize', () => {
  state.charts.forEach((instance) => instance.resize());
  revealActiveTab();
});
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (titles[view] && view !== state.currentView) navigate(view);
});
document.addEventListener('keydown', (event) => {
  const tab = event.target.closest?.('.module-tab[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('.module-tab[role="tab"]')].filter((item) => !item.disabled);
  const currentIndex = tabs.indexOf(tab);
  if (currentIndex < 0) return;
  event.preventDefault();
  const offset = event.key === 'ArrowRight' ? 1 : -1;
  let nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : currentIndex + offset;
  nextIndex = (nextIndex + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});

initialize();
