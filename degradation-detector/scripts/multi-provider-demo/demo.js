'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const refreshIcons = () => window.lucide.createIcons();
const storageKey = 'degradation-multi-provider-demo-v1';
const snapshot = Date.parse('2026-11-19T04:32:00Z');
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const formatTime = value => timeFormat.format(new Date(value));
const labels = { passed: '检测通过', incorrect: '答案不符', error: '检测异常', unknown: '无法判定', normal: '检测正常', degraded: '疑似降智', success: '检测成功', running: '检测中', pending: '尚未检测' };
const good = status => ['passed', 'normal', 'success'].includes(status);
const badge = status => `<span class="status ${status}">${icon(good(status) ? 'check' : ['incorrect', 'degraded'].includes(status) ? 'x' : 'circle-alert')}${labels[status] || status}</span>`;
const providers = [
  { id: 'manxue', name: '满血 AI', mark: '满', url: 'https://manxue.ai/api' },
  { id: 'testllm', name: 'TestLLM', mark: 'T', url: 'https://testllm.ai/model-iq-test' },
];
const channels = [
  { id: 'candy', provider: 'manxue', name: '糖果检测', symbol: 'candy' },
  { id: 'pelican', provider: 'manxue', name: '鹈鹕检测', symbol: 'bird' },
  { id: 'iq', provider: 'testllm', name: '推理检测', symbol: 'brain-circuit' },
];
const groups = [
  ['g1', 'GPT「标准组」速度快 / 稳定调用', 'gpt-6.1-sol', 0.03, 66.3, '智商一般', '4.612 秒'],
  ['g2', 'GPT「Plus 组」速度中等 / 稳定性佳', 'gpt-6.1-sol', 0.07, 92.3, '高智商', '5.381 秒'],
  ['g3', 'GPT「Pro 企业组」速度快 / 稳定输出', 'gpt-6.1-sol', 0.10, 61.4, '高智商', '2.714 秒'],
  ['g4', 'GPT「推理增强」专享 GPT-6-Astra', 'gpt-6-astra', 0.11, 81.9, '极高智商', '9.232 秒'],
  ['g5', 'GPT「铂金组」高并发专线', 'gpt-6.1-sol', 0.12, 97.2, '极高智商', '1.951 秒'],
  ['g6', 'GPT「Pro 大客户组」低延迟', 'gpt-6.1-sol', 0.13, 100, '极高智商', '2.010 秒'],
  ['g7', 'GPT「流量不限量·推荐码」', 'gpt-6.1-sol', 0.14, 100, '智商一般', '3.066 秒'],
  ['g8', 'GPT「重推理」OpenAI 官方 Key', 'gpt-6.1-sol', 0.25, 82.6, '极高智商', '1.125 秒'],
  ['g9', 'GPT「轻推理」OpenAI 官方 Key', 'gpt-6.1-sol', 0.30, 60, '极高智商', '2.017 秒'],
  ['c1', 'Claude「Kiro 标准版本」智商测试', 'claude-opus-5-5', 0.08, 0, '智商一般', '缺少思考'],
  ['c2', 'Claude「Kiro 企业通道」测试线路', 'claude-opus-5-5', 0.28, null, '未取得结果', '缺少思考'],
  ['c3', 'Claude「Opus 独享」稳定通道', 'claude-opus-5-5', 0.65, 96.1, '极高智商', '12.201 秒'],
  ['c4', 'Claude「Sonnet 企业线路」', 'claude-sonnet-4-8', 0.19, 88.6, '高智商', '7.183 秒'],
  ['c5', 'Claude「跨区域低延迟」专线', 'claude-sonnet-4-8', 0.24, 76.5, '高智商', '5.420 秒'],
  ['c6', 'Claude「官方直连」推理通道', 'claude-opus-5-5', 0.80, 91.3, '极高智商', '8.512 秒'],
  ['c7', 'Claude「高并发共享」通道', 'claude-sonnet-4-8', 0.16, 80.4, '高智商', '6.312 秒'],
].map(([id, name, model, ratio, cache, level, latency]) => ({ id, name, model, ratio, cache, level, latency, platform: id.startsWith('g') ? 'GPT' : 'Claude' }));
const groupsFor = channel => channel === 'iq' ? groups : groups.filter(group => !['g9', 'c5', 'c6', 'c7'].includes(group.id));
const channelName = id => channels.find(channel => channel.id === id).name;
const providerName = channel => channel === 'iq' ? 'TestLLM' : '满血 AI';
const percent = (part, total) => total ? `${(part / total * 100).toFixed(1)}%` : '—';
const cacheLabel = value => value == null ? '未取得' : `${value}%`;
const shortName = group => group.name.split('」')[0] + '」';
const clone = value => JSON.parse(JSON.stringify(value));

function defaultConfig() {
  return {
    version: 1, savedAt: null, providers: { manxue: true, testllm: true }, logs: [],
    channels: Object.fromEntries(channels.map(channel => [channel.id, {
      enabled: true, endpoint: channel.id === 'iq' ? 'https://testllm.ai' : 'https://manxue.ai/api/v1/tests',
      target: 'https://relay.example.com/v1', model: channel.id === 'iq' ? 'gpt-6.1-sol' : 'gpt-6-astra', modelSource: 'group',
      protocol: channel.id === 'iq' ? 'auto' : 'responses', effort: channel.id === 'candy' ? 'low' : 'medium', tier: '',
      timeout: channel.id === 'iq' ? 90 : 180, concurrency: 2, retention: 30,
      schedule: { enabled: true, mode: 'interval', times: ['09:00', '21:00'], interval: 60, unit: 'minutes' },
      groups: Object.fromEntries(groupsFor(channel.id).map(group => [group.id, { enabled: true, hasKey: true, override: null }])),
    }]))
  };
}

function loadConfig() {
  const defaults = defaultConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!saved || saved.version !== 1) return defaults;
    for (const channel of channels) {
      const entry = saved.channels?.[channel.id];
      if (entry) defaults.channels[channel.id] = { ...defaults.channels[channel.id], ...entry, schedule: { ...defaults.channels[channel.id].schedule, ...entry.schedule }, groups: { ...defaults.channels[channel.id].groups, ...entry.groups } };
    }
    return { ...defaults, savedAt: saved.savedAt || null, providers: { ...defaults.providers, ...saved.providers }, logs: Array.isArray(saved.logs) ? saved.logs.slice(-30) : [] };
  } catch { return defaults; }
}

let savedConfig = loadConfig();
let draft = clone(savedConfig);
const state = {
  page: location.pathname.startsWith('/admin') ? 'admin' : 'results',
  provider: new URLSearchParams(location.search).get('provider') === 'testllm' ? 'testllm' : 'manxue',
  kind: new URLSearchParams(location.search).get('test') === 'pelican' ? 'pelican' : 'candy',
  adminProvider: 'manxue', adminKind: 'candy', adminTab: 'providers',
  query: '', platform: 'all', status: 'all', adminQuery: '', dirty: false, dialog: null, busy: null,
};
let toastTimer;
const activeChannel = admin => (admin ? state.adminProvider : state.provider) === 'testllm' ? 'iq' : admin ? state.adminKind : state.kind;

function effective(channel, group, config = savedConfig) {
  const setting = config.channels[channel];
  const entry = setting.groups[group.id];
  const protocol = setting.protocol === 'auto' ? group.platform === 'GPT' ? 'chat' : 'anthropic' : setting.protocol;
  return { ...setting, model: channel === 'iq' && setting.modelSource !== 'default' ? group.model : setting.model, protocol, ...entry?.override };
}

function records(channel, group) {
  const count = channel === 'iq' ? 12 : 24;
  const index = groups.indexOf(group);
  return Array.from({ length: count }, (_, i) => {
    let status = channel === 'iq' ? 'success' : channel === 'pelican' ? 'normal' : 'passed';
    if ((i * 7 + index * 5) % 23 === 0) status = 'error';
    else if ((i * 11 + index * 3) % 17 === 0) status = channel === 'pelican' ? 'degraded' : channel === 'candy' ? 'incorrect' : 'success';
    if (i === count - 1) status = channel === 'iq' ? group.id === 'c2' ? 'error' : 'success' : group.id === 'g3' || group.id === 'c1' ? channel === 'pelican' ? 'degraded' : 'incorrect' : group.id === 'g8' ? 'error' : channel === 'pelican' ? 'normal' : 'passed';
    const time = snapshot - (count - 1 - i) * (channel === 'iq' ? 2 : 1) * 3600000 - index * 60000;
    return {
      id: `${channel}-${group.id}-${i}`, channel, groupId: group.id, time, status,
      model: channel === 'iq' ? group.model : 'gpt-6-astra', effort: channel === 'candy' ? 'low' : 'medium',
      level: status === 'error' ? '未取得结果' : i === count - 1 ? group.level : (i + index) % 5 ? '极高智商' : '高智商',
      latency: status === 'error' ? null : i === count - 1 ? group.latency : `${(1.2 + ((i * 11 + index * 3) % 90) / 10).toFixed(3)} 秒`,
      cache: status === 'error' ? null : i === count - 1 ? group.cache : 55 + ((i * 13 + index * 7) % 46),
      duration: status === 'error' ? null : (12 + ((i * 3 + index * 7) % 46)).toFixed(1),
      inputTokens: status === 'error' ? null : 4200 + i * 17, outputTokens: status === 'error' ? null : 210 + i * 11,
    };
  });
}

function enabledGroups(channel) {
  const provider = channel === 'iq' ? 'testllm' : 'manxue';
  if (!savedConfig.providers[provider] || !savedConfig.channels[channel].enabled) return [];
  return groupsFor(channel).filter(group => savedConfig.channels[channel].groups[group.id]?.enabled);
}

function matches(group, channel) {
  const last = records(channel, group).at(-1);
  const query = state.query.trim().toLowerCase();
  return (!query || `${group.name} ${group.model}`.toLowerCase().includes(query)) && (state.platform === 'all' || group.platform === state.platform) && (state.status === 'all' || (state.status === 'success' ? good(last.status) : !good(last.status)));
}

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3000);
}

function header(admin) {
  return `<header class="page-header"><div class="title-group"><span class="title-mark">${icon(admin ? 'settings-2' : 'brain-circuit')}</span><div><h1>${admin ? '降智检测配置' : '降智检测'}</h1><p class="secondary">${admin ? '第三方检测服务与分组管理' : '多方检测 · 独立结果 · 持续记录'}</p></div></div><div class="header-actions">${admin ? `<span class="dirty-state ${state.dirty ? 'changed' : ''}" id="save-state">${state.dirty ? '有未保存的修改' : savedConfig.savedAt ? '配置已保存' : '管理员配置'}</span><button class="button primary" data-save>${icon('save')}保存配置</button>` : `<span class="user-role">${icon('circle-user-round')}用户</span><button class="icon-button" data-refresh title="刷新结果" aria-label="刷新结果">${icon('refresh-cw')}</button>`}</div></header>`;
}

function providerTabs(admin = false) {
  const active = admin ? state.adminProvider : state.provider;
  return `<div class="provider-tabs" role="tablist" aria-label="第三方检测服务">${providers.map(provider => `<button id="provider-${provider.id}" class="provider-tab" role="tab" aria-selected="${active === provider.id}" aria-controls="provider-panel" tabindex="${active === provider.id ? 0 : -1}" data-provider="${provider.id}"><span class="provider-mark ${provider.id}">${provider.mark}</span>${provider.name}<span class="tab-count">${provider.id === 'manxue' ? '2 项检测' : '推理检测'}</span></button>`).join('')}<a class="provider-link" href="${providers.find(provider => provider.id === active).url}" target="_blank" rel="noopener noreferrer">${active === 'manxue' ? '接口文档' : '检测官网'}${icon('arrow-up-right')}</a></div>`;
}

function typeTabs(admin = false) {
  const kind = admin ? state.adminKind : state.kind;
  return `<div class="segmented" role="tablist" aria-label="满血 AI 检测类别">${channels.filter(channel => channel.provider === 'manxue').map(channel => `<button id="type-${channel.id}" role="tab" aria-selected="${kind === channel.id}" aria-controls="type-panel" tabindex="${kind === channel.id ? 0 : -1}" data-kind="${channel.id}">${icon(channel.symbol)}${channel.name}</button>`).join('')}</div>`;
}

function nextRun(schedule) {
  if (!schedule.enabled) return '自动检测已暂停';
  if (schedule.mode === 'interval') return `每 ${schedule.interval} ${schedule.unit === 'hours' ? '小时' : schedule.unit === 'days' ? '天' : '分钟'}`;
  return `每天 ${schedule.times.join(' / ')}`;
}

function filters() {
  return `<div class="filters"><label class="search-field">${icon('search')}<input type="search" data-filter="query" aria-label="搜索分组或模型" placeholder="搜索分组或模型" value="${esc(state.query)}"></label><select data-filter="platform" aria-label="筛选平台">${[['all', '全部平台'], ['GPT', 'GPT'], ['Claude', 'Claude']].map(([value, text]) => `<option value="${value}" ${state.platform === value ? 'selected' : ''}>${text}</option>`).join('')}</select><select data-filter="status" aria-label="筛选状态">${[['all', '全部状态'], ['success', '检测通过 / 成功'], ['issue', '未通过 / 异常']].map(([value, text]) => `<option value="${value}" ${state.status === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div>`;
}

function empty(message = '没有匹配的检测记录') {
  return `<div class="empty">${icon('folder-search')}<h3>${message}</h3><p>当前服务或分组未启用，或没有符合筛选条件的记录。</p></div>`;
}

function stats(items) {
  return `<section class="summary-band" aria-label="当前检测概览">${items.map(item => `<div class="stat"><div class="stat-label">${icon(item.icon)}${item.label}</div><div class="stat-value ${item.color || ''}">${item.value}<small>${item.unit || ''}</small></div><div class="stat-meta">${item.meta}</div></div>`).join('')}</section>`;
}

function card(group, channel) {
  const history = records(channel, group);
  const latest = history.at(-1);
  const valid = history.filter(run => good(run.status) || ['incorrect', 'degraded'].includes(run.status));
  const passed = valid.filter(run => good(run.status));
  const score = percent(passed.length, valid.length);
  return `<article class="group-card" data-card="${group.id}"><div class="card-heading"><h3>${esc(shortName(group))}</h3>${badge(latest.status)}</div><div class="card-model"><span class="mono">${esc(latest.model)}</span><span>${latest.effort} · ${channel === 'candy' ? '答案' : 'HTML'}</span></div><dl class="card-metrics"><div><dt>分组倍率</dt><dd>× ${group.ratio.toFixed(2)}</dd></div><div><dt>最近 5h 缓存率</dt><dd>${cacheLabel(group.cache)}</dd></div></dl><div class="card-assessment"><span>${channel === 'candy' ? '最近糖果检测' : '综合判定'}</span><strong class="${good(latest.status) ? 'green' : latest.status === 'error' ? 'amber' : 'red'}">${labels[latest.status]}</strong></div><div class="bars" role="group" aria-label="最近 24 次检测">${history.map((run, index) => `<button class="bar ${run.status}" data-detail="${group.id}" data-record="${index}" title="${formatTime(run.time)} · ${labels[run.status]}" aria-label="${formatTime(run.time)} · ${labels[run.status]}"></button>`).join('')}</div><div class="chart-caption"><span>最近 24 次检测</span><span>最新</span></div><div class="card-footer"><span>${channel === 'candy' ? '通过率' : '正常率'}<b>${score}</b><span class="faint"> (${passed.length}/${valid.length})</span></span><button class="button small" data-detail="${group.id}">${icon('eye')}查看结果</button></div></article>`;
}

function renderManxue() {
  const channel = state.kind;
  const rows = enabledGroups(channel).filter(group => matches(group, channel));
  const allRuns = rows.flatMap(group => records(channel, group));
  const valid = allRuns.filter(run => good(run.status) || ['incorrect', 'degraded'].includes(run.status));
  const passed = valid.filter(run => good(run.status)).length;
  const issues = rows.filter(group => ['incorrect', 'degraded'].includes(records(channel, group).at(-1).status)).length;
  const errors = rows.filter(group => records(channel, group).at(-1).status === 'error').length;
  const summary = stats([
    { label: '检测分组', value: rows.length, unit: '个', meta: '当前可见分组', icon: 'layers-3' },
    { label: channel === 'candy' ? '近 24 次通过率' : '近 24 次正常率', value: percent(passed, valid.length), meta: `${passed} / ${valid.length} 次有效判定`, icon: 'circle-check', color: 'green' },
    { label: channel === 'candy' ? '最新未通过' : '最新疑似降智', value: issues, unit: '组', meta: `${errors} 组检测异常`, icon: 'circle-alert', color: 'amber' },
    { label: '最近更新', value: '12:32', meta: '11 月 19 日 · UTC+8', icon: 'clock-3' },
  ]);
  return `${summary}<div class="filter-toolbar">${filters()}<div class="legend"><span><i></i>${channel === 'candy' ? '通过' : '正常'}</span><span><i class="incorrect"></i>${channel === 'candy' ? '答案不符' : '疑似降智'}</span><span><i class="error"></i>检测异常</span></div></div>${rows.length ? ['GPT', 'Claude'].map(platform => {
    const items = rows.filter(group => group.platform === platform);
    return items.length ? `<section class="platform-section"><div class="platform-heading"><span class="platform-mark ${platform.toLowerCase()}">${platform[0]}</span><h2>${platform}</h2><small>${items.length} 个分组</small></div><div class="group-grid">${items.map(group => card(group, channel)).join('')}</div></section>` : '';
  }).join('') : empty()}`;
}

function renderTestLLM() {
  const rows = enabledGroups('iq').filter(group => matches(group, 'iq'));
  const valid = rows.filter(group => records('iq', group).at(-1).status !== 'error');
  const exceptional = valid.filter(group => group.level === '极高智商').length;
  const high = valid.filter(group => group.level === '高智商').length;
  const average = valid.length ? `${(valid.reduce((sum, group) => sum + (group.cache || 0), 0) / valid.length).toFixed(1)}%` : '—';
  return `${stats([
    { label: '检测分组', value: rows.length, unit: '个', meta: `${valid.length} 组检测成功`, icon: 'layers-3' },
    { label: '极高智商', value: exceptional, unit: '组', meta: `${high} 组高智商`, icon: 'brain', color: 'green' },
    { label: '平均测试缓存', value: average, meta: '有效结果的算术平均', icon: 'database' },
    { label: '检测异常', value: rows.length - valid.length, unit: '组', meta: '异常不参与统计', icon: 'circle-alert', color: 'amber' },
  ])}<div class="filter-toolbar">${filters()}<span class="next-run">最近 24 小时 · 分组独立记录</span></div><div class="table-wrap"><table class="result-table"><thead><tr><th>分组 / 模型</th><th>推理检测</th><th>测试缓存</th><th>专属检测 <span title="首字响应耗时；未取得时显示原因">${icon('info')}</span></th><th>状态 / 最近结果</th><th></th></tr></thead><tbody>${['GPT', 'Claude'].map(platform => {
    const items = rows.filter(group => group.platform === platform);
    if (!items.length) return '';
    return `<tr class="table-platform"><td colspan="6"><strong>${platform}</strong><small>${items.length} 个分组</small></td></tr>${items.map(group => {
      const last = records('iq', group).at(-1);
      const minute = Math.round((snapshot - last.time) / 60000);
      return `<tr class="llm-row" data-row="${group.id}"><td><div class="table-group"><span class="platform-mark ${platform.toLowerCase()}">${platform[0]}</span><div><div class="table-group-name">${esc(group.name)}</div><div class="table-group-model"><span class="mono">${esc(last.model)}</span><span class="rate-tag">× ${group.ratio}</span></div></div></div></td><td><strong class="metric-main ${last.level === '未取得结果' ? 'red' : last.level === '智商一般' ? 'amber' : 'green'}">${last.level}</strong><small class="metric-sub">${last.status === 'error' ? '请求失败' : '1/1 推理'} · ${formatTime(last.time).slice(-5)}</small></td><td><strong class="metric-main ${last.cache == null ? 'muted' : 'green'}">${cacheLabel(last.cache)}</strong><small class="metric-sub">${last.cache == null ? '上游未返回结果' : `1/1 缓存 · ${formatTime(last.time).slice(-5)}`}</small></td><td><strong class="metric-main ${last.latency == null || last.latency === '缺少思考' ? 'amber' : 'green'}">${last.latency || '未取得'}</strong><small class="metric-sub">${last.latency == null ? '请求超时' : '首字耗时'} · ${formatTime(last.time).slice(-5)}</small></td><td>${badge(last.status)}<small class="metric-sub">${minute ? `${minute} 分钟前` : '刚刚更新'}</small></td><td><button class="button subtle small" data-detail="${group.id}">24小时检测记录</button></td></tr>`;
    }).join('')}`;
  }).join('')}</tbody></table>${!rows.length ? empty() : ''}</div>`;
}

function renderResults() {
  const channel = activeChannel(false);
  return `${header(false)}${providerTabs()}<section id="provider-panel" role="tabpanel" aria-labelledby="provider-${state.provider}"><div class="sub-toolbar">${state.provider === 'manxue' ? typeTabs() : `<span class="section-label">${icon('brain-circuit')}模型推理能力检测</span>`}<span class="next-run">${icon('clock-3')}${nextRun(savedConfig.channels[channel].schedule)}<span class="optional"> · Asia/Shanghai</span></span></div><section id="type-panel" ${state.provider === 'manxue' ? `role="tabpanel" aria-labelledby="type-${state.kind}"` : ''}>${state.provider === 'manxue' ? renderManxue() : renderTestLLM()}</section></section><footer class="results-footer"><p>${icon('info')}疑似降智不等于不可用，检测结论仅供参考。</p><p>2026-11-19 12:32 · Asia/Shanghai</p></footer>`;
}

function field(label, control, help = '', extra = '') {
  return `<label class="field ${extra}"><span>${label}</span>${control}${help ? `<small class="help">${help}</small>` : ''}</label>`;
}
function inputField(label, key, value, type = 'text', help = '', attr = '') {
  return field(label, `<input type="${type}" data-setting="${key}" value="${esc(value)}" ${attr}>`, help);
}
function selectField(label, key, value, options, help = '') {
  return field(label, `<select data-setting="${key}">${options.map(item => { const [id, text] = Array.isArray(item) ? item : [item, item]; return `<option value="${id}" ${String(id) === String(value) ? 'selected' : ''}>${text}</option>`; }).join('')}</select>`, help);
}
function toggle(label, checked, data, disabled = false) {
  return `<label class="switch"><input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${data}><span>${label}</span></label>`;
}

function parameterFields(channel, setting, prefix = '') {
  const followsGroup = channel === 'iq' && !prefix && setting.modelSource !== 'default';
  return `<div class="form-grid">${channel === 'iq' && !prefix ? selectField('模型选择', 'modelSource', setting.modelSource || 'group', [['group', '跟随分组模型'], ['default', '使用指定模型']]) : ''}${inputField(prefix ? '分组检测模型' : '默认检测模型', `${prefix}model`, setting.model, 'text', '', `required maxlength="100" ${followsGroup ? 'disabled' : ''}`)}${selectField('请求协议', `${prefix}protocol`, setting.protocol, channel === 'iq' ? [['auto', '跟随模型平台'], ['chat', 'OpenAI Chat Completions'], ['anthropic', 'Anthropic Messages']] : [['responses', 'OpenAI Responses']])}${channel !== 'iq' ? selectField('推理强度', `${prefix}effort`, setting.effort, channel === 'candy' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high']) + selectField('服务档位', `${prefix}tier`, setting.tier, [['', '默认'], ['priority', 'priority · Fast'], ['ultrafast', 'ultrafast · UltraFast']]) : ''}</div>`;
}

function overview(channel) {
  const setting = draft.channels[channel];
  const selected = Object.values(setting.groups).filter(group => group.enabled).length;
  return `<aside class="overview"><h3>当前配置概览</h3><dl><dt>检测服务</dt><dd>${providerName(channel)}</dd><dt>检测类别</dt><dd>${channelName(channel)}</dd><dt>已启用分组</dt><dd>${selected} / ${groupsFor(channel).length}</dd><dt>默认模型</dt><dd class="mono">${esc(setting.model)}</dd><dt>检测计划</dt><dd>${setting.schedule.enabled ? '已启用' : '已暂停'}</dd></dl><div class="aside-block"><h3>结果展示</h3><p class="aside-description">${channel === 'iq' ? '按平台分组的检测列表，保留每次推理、缓存与延迟结果。' : '按平台分组的结果卡片，与原鹈鹕检测保持一致。'}</p>${channel !== 'iq' ? `<div class="mapping-line"><span>${channel === 'candy' ? '通过' : '正常'}</span><i></i></div><div class="mapping-line"><span>${channel === 'candy' ? '答案不符' : '疑似降智'}</span><i class="incorrect"></i></div><div class="mapping-line"><span>检测异常</span><i class="error"></i></div>` : ''}</div><div class="aside-block"><h3>检测用 Key</h3><p class="aside-description">使用分组独立专用 Key，不使用浏览者的个人 Key。</p></div></aside>`;
}

function providerConfig() {
  const channel = activeChannel(true);
  const provider = state.adminProvider;
  const setting = draft.channels[channel];
  return `<div class="provider-state"><div><h2>${providerName(channel)} · ${channelName(channel)}</h2><p>${channel === 'iq' ? '独立记录推理等级、测试缓存与首字耗时。' : channel === 'candy' ? '检测模型回答，按通过、答案不符与异常分别记录。' : '保留作品预览、源码、提示词与历史判定。'}</p></div>${toggle('启用此检测', setting.enabled, 'data-setting="enabled"')}</div><div class="admin-columns"><form id="provider-form" novalidate><section class="config-section"><h3>${icon('plug-zap')}第三方接入</h3><div class="form-grid">${inputField(channel === 'iq' ? '检测服务地址' : '检测任务接口', 'endpoint', setting.endpoint, 'url', '', 'required')}${field('检测服务', `<input value="${providerName(channel)}" readonly>`)}${inputField('默认上游 API 地址', 'target', setting.target, 'url', '分组可单独覆盖上游地址。', 'required')}${field('分组专用 Key', `<div class="field-action"><span class="key-state">${icon('key-round')}已配置 ${Object.values(setting.groups).filter(group => group.hasKey).length} 个分组</span><button type="button" class="button small" data-admin-tab="groups">分组管理${icon('arrow-right')}</button></div>`)}</div><div class="connection-row">${toggle('启用此第三方', draft.providers[provider], `data-provider-enabled="${provider}"`)}<span class="muted">${channel === 'iq' ? 'TestLLM' : '糖果与鹈鹕共用此第三方开关'}</span></div></section><section class="config-section"><h3>${icon('sliders-horizontal')}默认检测参数</h3>${parameterFields(channel, setting)}<p class="admin-note">${icon('git-branch')}分组未设置独立参数时，继承上述默认配置。</p></section><section class="config-section"><h3>${icon('timer')}运行设置</h3><div class="form-grid">${inputField('单次任务超时（秒）', 'timeout', setting.timeout, 'number', '', 'min="30" max="900" required')}${inputField('并发任务上限', 'concurrency', setting.concurrency, 'number', '', 'min="1" max="10" required')}${inputField('详细历史保留（天）', 'retention', setting.retention, 'number', '', 'min="1" max="3650" required')}${field('计划执行', `<div class="field-action"><span>${esc(nextRun(setting.schedule))}</span><button type="button" class="icon-button" data-admin-tab="schedule" title="修改检测计划" aria-label="修改检测计划">${icon('calendar-clock')}</button></div>`)}</div></section></form>${overview(channel)}</div>`;
}

function groupConfig() {
  const channel = activeChannel(true);
  const setting = draft.channels[channel];
  const query = state.adminQuery.toLowerCase();
  const rows = groupsFor(channel).filter(group => `${group.name} ${group.model}`.toLowerCase().includes(query));
  const selected = Object.values(setting.groups).filter(group => group.enabled).length;
  return `<div class="admin-heading"><div><h2>分组与检测模型</h2><p>${channelName(channel)} · 已启用 <strong id="selected-count">${selected}</strong> / ${groupsFor(channel).length} 个分组</p></div><label class="search-field">${icon('search')}<input type="search" data-admin-search placeholder="搜索分组" aria-label="搜索管理分组" value="${esc(state.adminQuery)}"></label></div><div class="admin-note">${icon('key-round')}每组使用独立专用 Key；参数可继承默认，或按分组覆盖。</div><div class="table-wrap"><table class="config-table"><thead><tr><th><label class="row"><input type="checkbox" data-select-groups ${rows.length && rows.every(group => setting.groups[group.id].enabled) ? 'checked' : ''} aria-label="选择当前所有分组">分组</label></th><th>检测模型 / 参数来源</th><th>专用 Key</th><th>最近结果</th><th>操作</th></tr></thead><tbody>${rows.map(group => {
    const entry = setting.groups[group.id];
    const settings = effective(channel, group, draft);
    const last = records(channel, group).at(-1);
    return `<tr data-config-group="${group.id}"><td><label class="row"><input type="checkbox" data-group-toggle="${group.id}" ${entry.enabled ? 'checked' : ''}><span>${esc(shortName(group))}</span></label><span class="metric-sub">${group.platform} · 分组倍率 × ${group.ratio}</span></td><td><span class="mono">${esc(settings.model)}</span><span class="metric-sub">${entry.override ? '分组独立配置' : '继承默认配置'}${channel === 'iq' ? ' · 跟随平台模型' : ` · ${settings.effort}`}</span></td><td><span class="key-state ${entry.hasKey ? 'green' : 'amber'}">${icon('key-round')}${entry.hasKey ? '已配置' : '待配置'}</span></td><td>${badge(last.status)}</td><td><div class="row"><button class="icon-button" data-group-edit="${group.id}" title="分组独立配置" aria-label="${esc(shortName(group))} 独立配置">${icon('settings-2')}</button><button class="icon-button" data-run="${channel}" data-run-group="${group.id}" ${state.dirty || !entry.enabled || !entry.hasKey || !setting.enabled || !draft.providers[state.adminProvider] || state.busy ? 'disabled' : ''} title="立即检测" aria-label="${esc(shortName(group))} 立即检测">${icon('play')}</button><button class="icon-button" data-admin-history="${group.id}" title="历史记录" aria-label="${esc(shortName(group))} 历史记录">${icon('history')}</button></div></td></tr>`;
  }).join('')}</tbody></table>${rows.length ? '' : empty('没有匹配的分组')}</div><p class="admin-note">${icon('info')}${state.dirty ? '保存配置后可发起检测。' : '每个第三方及检测类别分别选择分组、保存参数和历史。'}</p>`;
}

function scheduleConfig() {
  return `<div class="admin-heading"><div><h2>检测计划</h2><p>三个检测类别独立调度 · Asia/Shanghai (UTC+8)</p></div></div>${channels.map(channel => {
    const setting = draft.channels[channel.id];
    const plan = setting.schedule;
    return `<section class="schedule-row" data-plan-row="${channel.id}"><div><h3 class="row">${icon(channel.symbol)}${channelName(channel.id)}</h3><p class="muted"><small>${providerName(channel.id)}</small></p></div><div><div class="segmented" role="group" aria-label="${channel.name}计划模式"><button data-plan-mode="daily" data-plan-channel="${channel.id}" aria-pressed="${plan.mode === 'daily'}">固定时间</button><button data-plan-mode="interval" data-plan-channel="${channel.id}" aria-pressed="${plan.mode === 'interval'}">间隔执行</button></div><div class="time-fields">${plan.mode === 'daily' ? plan.times.map((time, index) => `<div class="time-input"><input type="time" data-plan-time="${index}" data-plan-channel="${channel.id}" value="${time}" aria-label="${channel.name}第 ${index + 1} 个时间" required><button class="time-remove" data-remove-time="${index}" data-plan-channel="${channel.id}" ${plan.times.length <= 1 ? 'disabled' : ''} title="移除此时间" aria-label="移除此时间">${icon('x')}</button></div>`).join('') + `<button class="icon-button" data-add-time="${channel.id}" ${plan.times.length >= 6 ? 'disabled' : ''} title="增加时间" aria-label="增加${channel.name}时间">${icon('plus')}</button>` : `<span class="muted">每</span><input type="number" min="1" max="1440" data-plan-interval="${channel.id}" value="${plan.interval}" aria-label="${channel.name}间隔" required><select data-plan-unit="${channel.id}" aria-label="${channel.name}间隔单位">${[['minutes', '分钟'], ['hours', '小时'], ['days', '天']].map(([value, name]) => `<option value="${value}" ${value === plan.unit ? 'selected' : ''}>${name}</option>`).join('')}</select>`}</div></div><div class="schedule-next"><small>执行范围</small><strong>${Object.values(setting.groups).filter(group => group.enabled && group.hasKey).length} 个已配置分组</strong><small>${!setting.enabled || !draft.providers[channel.provider] ? '检测已停用' : '按保存的配置执行'}</small></div><div class="schedule-actions">${toggle('自动检测', plan.enabled, `data-plan-enabled="${channel.id}"`)}<button class="button small" data-run="${channel.id}" ${state.dirty || state.busy || !setting.enabled || !draft.providers[channel.provider] || !Object.values(setting.groups).some(group => group.enabled && group.hasKey) ? 'disabled' : ''}>${icon('play')}立即检测</button></div></section>`;
  }).join('')}<section class="schedule-settings"><h3>最近任务</h3><div id="run-status" class="run-status" aria-live="polite">${state.busy ? '正在执行演示任务…' : state.dirty ? '有未保存的配置，请先保存。' : '所有检测计划使用各分组专用 Key。'}</div>${draft.logs.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>检测类别</th><th>分组</th><th>任务结果</th></tr></thead><tbody>${[...draft.logs].reverse().slice(0, 6).map(log => `<tr><td>${formatTime(log.time)}</td><td>${providerName(log.channel)} · ${channelName(log.channel)}</td><td>${log.count} 个</td><td>${badge('success')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无手动任务</p>'}</section>`;
}

function renderAdmin() {
  const nav = [['providers', '第三方接入', 'plug-zap'], ['groups', '分组与模型', 'folder-tree'], ['schedule', '检测计划', 'calendar-clock']];
  return `${header(true)}<nav class="admin-tabs" role="tablist" aria-label="配置分类">${nav.map(([id, name, symbol]) => `<button class="admin-tab" id="admin-${id}" data-admin-tab="${id}" role="tab" aria-selected="${state.adminTab === id}" aria-controls="admin-panel" tabindex="${state.adminTab === id ? 0 : -1}">${icon(symbol)}${name}</button>`).join('')}</nav><section id="admin-panel" role="tabpanel" aria-labelledby="admin-${state.adminTab}">${state.adminTab === 'schedule' ? scheduleConfig() : `${providerTabs(true)}<section id="provider-panel" role="tabpanel" aria-labelledby="provider-${state.adminProvider}"><div class="sub-toolbar">${state.adminProvider === 'manxue' ? typeTabs(true) : `<span class="section-label">${icon('brain-circuit')}TestLLM 模型推理检测</span>`}<span class="next-run">${icon('git-branch')}独立配置</span></div><section id="type-panel" ${state.adminProvider === 'manxue' ? `role="tabpanel" aria-labelledby="type-${state.adminKind}"` : ''}>${state.adminTab === 'groups' ? groupConfig() : providerConfig()}</section></section>`}</section>`;
}

function render(options = {}) {
  $('#app').innerHTML = state.page === 'admin' ? renderAdmin() : renderResults();
  document.title = `${state.page === 'admin' ? '降智检测配置' : '降智检测'} · 多平台 Demo`;
  document.querySelectorAll('[data-preview]').forEach(link => link.classList.toggle('active', link.dataset.preview === state.page));
  refreshIcons();
  if (options.focus) { const input = $(options.focus); if (input) { input.focus({ preventScroll: true }); if (options.position != null) input.setSelectionRange(options.position, options.position); } }
}

function markDirty() {
  state.dirty = true;
  const label = $('#save-state'); if (label) { label.textContent = '有未保存的修改'; label.classList.add('changed'); }
  document.querySelectorAll('[data-run]').forEach(button => { button.disabled = true; });
}

function validateConfig() {
  for (const channel of channels) {
    const entry = draft.channels[channel.id];
    for (const value of [entry.endpoint, entry.target]) { try { if (!['https:', 'http:'].includes(new URL(value).protocol)) throw new Error(); } catch { return `${channelName(channel.id)}：请填写有效的 HTTP / HTTPS 地址。`; } }
    if (!entry.model.trim()) return `${channelName(channel.id)}：请填写默认检测模型。`;
    if (!Number.isInteger(entry.timeout) || entry.timeout < 30 || entry.timeout > 900) return `${channelName(channel.id)}：超时须为 30–900 秒。`;
    if (!Number.isInteger(entry.concurrency) || entry.concurrency < 1 || entry.concurrency > 10) return `${channelName(channel.id)}：并发上限须为 1–10。`;
    if (!Number.isInteger(entry.retention) || entry.retention < 1 || entry.retention > 3650) return `${channelName(channel.id)}：历史保留须为 1–3650 天。`;
    const plan = entry.schedule;
    if (plan.mode === 'daily' && (!plan.times.length || plan.times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(plan.times).size !== plan.times.length)) return `${channelName(channel.id)}：检测时间不能为空或重复。`;
    if (plan.mode === 'interval' && (!Number.isInteger(plan.interval) || plan.interval < 1 || plan.interval > 1440)) return `${channelName(channel.id)}：检测间隔须为 1–1440。`;
  }
  return null;
}

function save() {
  const error = validateConfig(); if (error) { toast(error); return; }
  const candidate = clone(draft); candidate.savedAt = Date.now();
  try { localStorage.setItem(storageKey, JSON.stringify(candidate)); }
  catch { toast('浏览器未能保存，请检查本机存储设置。'); return; }
  savedConfig = candidate; draft = clone(candidate); state.dirty = false; render(); toast('已保存演示配置');
}

function openDialog(title, subtitle, body, kicker = '') {
  $('#dialog-title').textContent = title; $('#dialog-subtitle').textContent = subtitle; $('#dialog-kicker').textContent = kicker;
  $('#dialog-body').innerHTML = body; refreshIcons();
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}

function showGroupEditor(id) {
  const group = groups.find(item => item.id === id);
  const channel = activeChannel(true);
  const entry = draft.channels[channel].groups[id];
  const setting = effective(channel, group, draft);
  state.dialog = { type: 'group', group: id, channel };
  openDialog(`${shortName(group)} · 独立配置`, `${providerName(channel)} / ${channelName(channel)}`, `<form id="group-form"><div class="group-form-content"><div class="editor-mode">${toggle('使用分组独立参数', !!entry.override, 'id="override-enabled"')}</div><fieldset id="override-fields" ${entry.override ? '' : 'disabled'}>${parameterFields(channel, setting, 'group-')}<div class="form-grid editor-gap">${inputField('分组上游 API 地址', 'group-target', setting.target, 'url', '', 'required')}</div></fieldset><section class="key-editor"><h3>${icon('key-round')}分组专用 Key</h3><p class="muted">${entry.hasKey ? '已配置，留空保留现有 Key' : '待配置'}</p><label class="field"><span>更换专用 Key</span><input type="password" id="group-key" autocomplete="new-password" placeholder="输入演示 Key" maxlength="256"></label></section><p id="group-error" class="form-error" role="alert" hidden></p></div><footer class="dialog-footer"><button type="button" class="button" data-restore-defaults>${icon('undo-2')}恢复默认参数</button><span class="spacer"></span><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary">${icon('check')}应用配置</button></footer></form>`, '分组独立配置');
}

function detailBody(run, group, channel) {
  const failed = run.status === 'error';
  const explanation = failed ? '检测请求超时，未取得有效结果。本次不计入通过率，也不会被记为模型降智。' : channel === 'candy' ? run.status === 'passed' ? '模型答案符合本次糖果检测的预期结果。' : '模型答案与本次糖果检测的预期结果不符。' : channel === 'pelican' ? run.status === 'normal' ? '作品完成度与结构符合本次检测要求。' : '作品存在结构或细节问题，本次判定为疑似降智。' : `模型推理等级为「${run.level}」，本次任务已完成。`;
  const prompt = channel === 'pelican' ? '请生成一个完整的 HTML 页面，绘制一只骑自行车的鹈鹕，包含车架、车轮、鸟嘴与脚踏细节。' : channel === 'candy' ? '【演示题目】盒子中有 15 颗糖果，先拿走 4 颗，再放入 7 颗，随后拿走剩余糖果的一半。盒子里还剩多少颗糖果？只输出数字。' : '【演示题目】比较两个逻辑推理方案，并说明能推出结论的必要条件。';
  return `<div class="result-heading"><h3>本次检测结果</h3>${badge(run.status)}</div><dl class="detail-metrics"><div><dt>${channel === 'iq' ? '推理等级' : '检测判定'}</dt><dd class="${failed ? 'amber' : good(run.status) ? 'green' : 'red'}">${channel === 'iq' ? run.level : labels[run.status]}</dd></div><div><dt>检测耗时</dt><dd>${run.duration == null ? '—' : `${run.duration} 秒`}</dd></div><div><dt>${channel === 'iq' ? '测试缓存' : '输出 Token'}</dt><dd>${channel === 'iq' ? cacheLabel(run.cache) : run.outputTokens ?? '—'}</dd></div></dl><section class="answer-section"><h3>判定说明</h3><p>${explanation}</p></section>${failed ? '' : channel === 'pelican' ? `<section class="answer-section"><h3>作品预览</h3><iframe class="artwork" src="/pelican.html" sandbox title="鹈鹕骑行演示作品"></iframe></section>` : channel === 'candy' ? `<section class="answer-section"><h3>检测回答</h3><pre class="code answer-code">${run.status === 'passed' ? '9' : '8'}</pre></section>` : `<section class="answer-section"><h3>本次服务表现</h3><p>首字耗时：${run.latency || '未取得'}\n测试缓存：${cacheLabel(run.cache)}\n检测模型：${esc(run.model)}</p></section>`}<details class="prompt-section"><summary>${icon('message-square-text')}查看检测提示词</summary><pre class="code">${esc(prompt)}</pre></details>${channel === 'pelican' && !failed ? `<details><summary>${icon('code-xml')}查看源码</summary><pre class="code artwork-source">正在读取本次作品源码</pre></details>` : ''}<details><summary>${icon('braces')}原始结果</summary><pre class="code">${esc(JSON.stringify({ id: run.id, provider: providerName(channel), benchmark: channel, model: run.model, status: run.status, started_at: new Date(run.time).toISOString(), result: channel === 'iq' ? { level: run.level, cache_rate: run.cache, latency: run.latency } : { answer: channel === 'candy' && !failed ? run.status === 'passed' ? '9' : '8' : null, duration_seconds: run.duration }, demo: true }, null, 2))}</pre></details><p class="detail-note">记录于 ${formatTime(run.time)} · ${esc(run.model)} · 本次记录的参数</p>`;
}

function showHistory(groupId, channel, recordIndex) {
  const group = groups.find(item => item.id === groupId);
  const history = records(channel, group);
  const selected = recordIndex ?? history.length - 1;
  state.dialog = { type: 'history', group: groupId, channel, record: selected };
  const run = history[selected];
  openDialog(shortName(group), `${providerName(channel)} · ${channelName(channel)} · 最近 24 小时`, `<div class="detail-layout"><nav class="history-nav" aria-label="检测历史记录">${[...history].reverse().map(item => `<button class="history-entry ${item.id === run.id ? 'active' : ''}" aria-current="${item.id === run.id}" data-history-record="${history.indexOf(item)}"><strong>${formatTime(item.time)}</strong>${badge(item.status)}<small>${channel === 'iq' ? item.level : item.status === 'error' ? '未取得结果' : `${item.duration} 秒`}</small></button>`).join('')}</nav><article class="detail-content">${detailBody(run, group, channel)}</article></div>`, channel === 'iq' ? '24 小时检测记录' : '历史检测结果');
  if (channel === 'pelican' && run.status !== 'error') {
    const source = $('.artwork-source');
    source.textContent = window.demoPelicanSource || '作品源码载入中';
  }
}

function applyGroup(event) {
  event.preventDefault();
  const form = $('#group-form');
  const data = state.dialog;
  const entry = draft.channels[data.channel].groups[data.group];
  let override = null;
  if ($('#override-enabled').checked) {
    if (!form.reportValidity()) return;
    const get = key => $(`[data-setting="group-${key}"]`, form)?.value;
    try { if (!['http:', 'https:'].includes(new URL(get('target')).protocol)) throw new Error(); }
    catch { $('#group-error').hidden = false; $('#group-error').textContent = '请填写有效的上游 API 地址。'; return; }
    if (!get('model').trim()) { $('#group-error').hidden = false; $('#group-error').textContent = '请填写检测模型。'; return; }
    override = { model: get('model').trim(), protocol: get('protocol'), target: get('target'), effort: get('effort') || '', tier: get('tier') || '' };
  }
  // Only the simulated presence of a key is retained; the entered value is discarded.
  entry.hasKey = entry.hasKey || !!$('#group-key').value;
  entry.override = override;
  $('#group-key').value = '';
  $('#detail-dialog').close(); markDirty(); render(); toast('分组参数已应用，请保存配置');
}

async function runDemo(channel, groupId) {
  if (state.dirty || state.busy) return;
  const selected = Object.entries(savedConfig.channels[channel].groups).filter(([id, group]) => (!groupId || groupId === id) && group.enabled && group.hasKey);
  if (!selected.length) { toast('没有已启用且配置 Key 的分组'); return; }
  state.busy = channel; render(); toast('演示任务已加入队列');
  await new Promise(resolve => setTimeout(resolve, 900));
  const log = { time: Date.now(), channel, count: selected.length };
  savedConfig.logs = [...savedConfig.logs, log].slice(-30); draft.logs = clone(savedConfig.logs);
  try { localStorage.setItem(storageKey, JSON.stringify(savedConfig)); } catch { /* The in-memory task result remains available. */ }
  state.busy = null; render(); toast(`演示任务完成：${selected.length} 个分组，未发出真实请求`);
}

function navigate(page, url) {
  state.page = page;
  if (page === 'results') { state.query = ''; state.platform = 'all'; state.status = 'all'; }
  history.pushState({}, '', url);
  render(); window.scrollTo(0, 0);
}

document.addEventListener('click', event => {
  const target = event.target.closest('button, a'); if (!target || target.disabled) return;
  const data = target.dataset;
  if (data.preview) { event.preventDefault(); navigate(data.preview, target.getAttribute('href')); }
  else if (data.provider) { if (state.page === 'admin') state.adminProvider = data.provider; else { state.provider = data.provider; state.query = ''; state.platform = 'all'; state.status = 'all'; } render(); $(`[data-provider="${data.provider}"]`)?.focus({ preventScroll: true }); }
  else if (data.kind) { if (state.page === 'admin') state.adminKind = data.kind; else { state.kind = data.kind; state.status = 'all'; } render(); $(`[data-kind="${data.kind}"]`)?.focus({ preventScroll: true }); }
  else if (data.adminTab) { state.adminTab = data.adminTab; state.adminQuery = ''; render(); }
  else if ('save' in data) save();
  else if ('refresh' in data) { savedConfig = loadConfig(); if (!state.dirty) draft = clone(savedConfig); render(); toast('结果已刷新'); }
  else if (data.groupEdit) showGroupEditor(data.groupEdit);
  else if ('close' in data) $('#detail-dialog').close();
  else if (data.detail) showHistory(data.detail, activeChannel(false), data.record == null ? undefined : Number(data.record));
  else if (data.adminHistory) showHistory(data.adminHistory, activeChannel(true));
  else if (data.historyRecord != null) { const current = state.dialog; showHistory(current.group, current.channel, Number(data.historyRecord)); }
  else if ('restoreDefaults' in data) { $('#override-enabled').checked = false; $('#override-fields').disabled = true; }
  else if (data.planMode) { draft.channels[data.planChannel].schedule.mode = data.planMode; markDirty(); render(); }
  else if (data.addTime) { const times = draft.channels[data.addTime].schedule.times; const next = ['12:00', '15:00', '18:00', '23:00', '06:00', '03:00'].find(time => !times.includes(time)); if (next && times.length < 6) times.push(next); markDirty(); render(); }
  else if (data.removeTime != null) { const times = draft.channels[data.planChannel].schedule.times; if (times.length > 1) times.splice(Number(data.removeTime), 1); markDirty(); render(); }
  else if (data.run) runDemo(data.run, data.runGroup);
});

document.addEventListener('input', event => {
  const input = event.target;
  const data = input.dataset;
  if (data.filter === 'query') { state.query = input.value; render({ focus: '[data-filter="query"]', position: input.selectionStart }); }
  else if ('adminSearch' in data) { state.adminQuery = input.value; render({ focus: '[data-admin-search]', position: input.selectionStart }); }
  else if (data.setting && !data.setting.startsWith('group-') && input.type !== 'checkbox') {
    draft.channels[activeChannel(true)][data.setting] = input.type === 'number' ? Number(input.value) : input.value;
    markDirty();
    if (data.setting === 'modelSource') render();
  } else if (data.planTime != null) { draft.channels[data.planChannel].schedule.times[Number(data.planTime)] = input.value; markDirty(); }
  else if (data.planInterval) { draft.channels[data.planInterval].schedule.interval = Number(input.value); markDirty(); }
});

document.addEventListener('change', event => {
  const input = event.target;
  const data = input.dataset;
  if (data.filter && data.filter !== 'query') { state[data.filter] = input.value; render(); }
  else if (data.providerEnabled) { draft.providers[data.providerEnabled] = input.checked; markDirty(); }
  else if (data.setting === 'enabled') { draft.channels[activeChannel(true)].enabled = input.checked; markDirty(); }
  else if (data.setting && !data.setting.startsWith('group-') && input.tagName === 'SELECT') { draft.channels[activeChannel(true)][data.setting] = input.value; markDirty(); }
  else if (data.groupToggle) { draft.channels[activeChannel(true)].groups[data.groupToggle].enabled = input.checked; markDirty(); render(); }
  else if ('selectGroups' in data) { const channel = activeChannel(true); groupsFor(channel).filter(group => `${group.name} ${group.model}`.toLowerCase().includes(state.adminQuery.toLowerCase())).forEach(group => { draft.channels[channel].groups[group.id].enabled = input.checked; }); markDirty(); render(); }
  else if (input.id === 'override-enabled') $('#override-fields').disabled = !input.checked;
  else if (data.planEnabled) { draft.channels[data.planEnabled].schedule.enabled = input.checked; markDirty(); }
  else if (data.planUnit) { draft.channels[data.planUnit].schedule.unit = input.value; markDirty(); }
});

document.addEventListener('submit', event => { if (event.target.id === 'group-form') applyGroup(event); else event.preventDefault(); });
document.addEventListener('focusin', event => {
  if (event.target.matches('.group-form-content input, .group-form-content select')) event.target.scrollIntoView({ block: 'nearest' });
});
document.addEventListener('keydown', event => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[next].click();
  document.getElementById(tabs[next].id)?.focus({ preventScroll: true });
});
$('#detail-dialog').addEventListener('click', event => {
  if (event.target !== $('#detail-dialog')) return;
  const rect = $('#detail-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#detail-dialog').close();
});
$('#detail-dialog').addEventListener('close', () => { state.dialog = null; $('#dialog-body').replaceChildren(); });
window.addEventListener('popstate', () => { state.page = location.pathname.startsWith('/admin') ? 'admin' : 'results'; render(); });
render();
