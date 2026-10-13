'use strict';

const SNAPSHOT = '2026-10-13';
const FIRST_DAY = '2026-09-14';
const PLATFORMS = [
  { id: 'anthropic', name: 'Anthropic', color: '#cf8471' },
  { id: 'openai', name: 'OpenAI', color: '#4d9b88' },
  { id: 'google', name: 'Google', color: '#6490c1' },
  { id: 'other', name: '其他平台', color: '#a394ba' }
];
const MODELS = [
  { name: 'Claude Sonnet 4.5', platform: 'anthropic', weight: .77, price: .078, input: 2300, output: 730, read: 1450, creation: 180 },
  { name: 'Claude Opus 4.1', platform: 'anthropic', weight: .23, price: .185, input: 3100, output: 890, read: 1650, creation: 240 },
  { name: 'GPT-5', platform: 'openai', weight: .68, price: .054, input: 2450, output: 820, read: 1190, creation: 0 },
  { name: 'GPT-5 mini', platform: 'openai', weight: .32, price: .012, input: 1550, output: 570, read: 850, creation: 0 },
  { name: 'Gemini 2.5 Pro', platform: 'google', weight: .64, price: .044, input: 2900, output: 910, read: 1050, creation: 0 },
  { name: 'Gemini 2.5 Flash', platform: 'google', weight: .36, price: .0085, input: 1650, output: 510, read: 700, creation: 0 },
  { name: 'DeepSeek V3.1', platform: 'other', weight: .61, price: .008, input: 1850, output: 640, read: 600, creation: 0 },
  { name: 'Qwen3 Coder', platform: 'other', weight: .39, price: .0105, input: 2400, output: 670, read: 540, creation: 0 }
];
const USER_SEEDS = [
  [12, '林予安', 'nova', 640, [.73, .20, .07, 0], 'balance', 'steady'],
  [18, '陈知远', 'zhiyuan', 510, [.16, .68, .16, 0], 'balance', 'steady'],
  [23, '周映', 'ying', 390, [.58, .22, .14, .06], 'subscription', 'steady'],
  [27, '许景', 'jing', 310, [.81, .19, 0, 0], 'balance', 'steady'],
  [31, '白若舟', 'ruozhou', 245, [.31, .29, .32, .08], 'balance', 'steady'],
  [36, '顾言', 'guyan', 215, [.25, .62, .13, 0], 'subscription', 'steady'],
  [41, '苏禾', 'suhe', 185, [1, 0, 0, 0], 'balance', 'decline'],
  [47, '陆见深', 'jianshen', 156, [.37, .35, .18, .10], 'balance', 'steady'],
  [52, '沈初', 'shenchu', 132, [.20, .15, .65, 0], 'balance', 'steady'],
  [57, '唐亦', 'tangyi', 118, [0, .88, .12, 0], 'subscription', 'steady'],
  [63, '林小满', 'xiaoman', 101, [.70, .30, 0, 0], 'balance', 'decline'],
  [68, '温时', 'wenshi', 88, [.15, .56, .21, .08], 'balance', 'steady'],
  [73, '程嘉', 'chengjia', 78, [0, 0, 1, 0], 'balance', 'steady'],
  [79, '江澄', 'jiangcheng', 66, [.52, .38, .10, 0], 'subscription', 'steady'],
  [83, '余晓', 'yuxiao', 59, [.61, .39, 0, 0], 'balance', 'quiet'],
  [89, '季川', 'jichuan', 49, [0, .72, .28, 0], 'balance', 'steady'],
  [94, '梁思', 'liangsi', 41, [.26, .22, .41, .11], 'balance', 'new'],
  [101, '何沐', 'hemu', 34, [0, 1, 0, 0], 'subscription', 'steady'],
  [106, '徐遥', 'xuyao', 27, [.42, .33, .25, 0], 'balance', 'steady'],
  [111, '方宁', 'fangning', 21, [0, 0, .71, .29], 'balance', 'sparse'],
  [115, '宋竹', 'songzhu', 17, [.63, .37, 0, 0], 'balance', 'new'],
  [119, '叶青', 'yeqing', 12, [0, .58, 0, .42], 'subscription', 'sparse'],
  [124, '简一', 'jianyi', 8, [0, 0, 0, 1], 'balance', 'sparse'],
  [129, '张悦', 'zhangyue', 4, [0, 1, 0, 0], 'balance', 'new']
];
const METRICS = {
  requests: { name: '请求数', total: '总请求', share: '请求占比', unit: '次请求' },
  tokens: { name: 'Token', total: '总 Token', share: 'Token 占比', unit: 'Token' },
  cost: { name: '消费额度', total: '总消费', share: '消费占比', unit: '额度' }
};
const state = { start: FIRST_DAY, end: SNAPSHOT, plan: 'all', platform: 'all', metric: 'requests', detailMetric: 'requests', segment: 'all', search: '', sort: 'cost', page: 1, pageSize: 8, selected: null };
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = (value) => nf.format(value);
const money = (value) => moneyFormat.format(value);
const percent = (value, total) => total > 0 ? `${(value / total * 100).toFixed(1)}%` : '—';
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const platformById = (id) => PLATFORMS.find((p) => p.id === id);
const escaped = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const roundCost = (value) => Math.round(value * 1000000) / 1000000;
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
let view = null;
let platformChart = null;
let trendChart = null;
let toastTimer;

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function shortNumber(value, digits = 1) {
  if (value >= 100000000) return `${(value / 100000000).toFixed(digits)} 亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(digits)} 万`;
  return number(value);
}

function random(seed) {
  const value = Math.sin(seed * 17.319 + 23.711) * 43758.5453;
  return value - Math.floor(value);
}

// All views use the same deterministic synthetic request aggregates.
function createDemoData() {
  const users = USER_SEEDS.map(([id, name, email, base, mix, plan, behavior], index) => ({ id, name, email: `${email}@example.com`, base, mix, plan, behavior, avatar: ['', 'sky', 'rose', 'lilac'][index % 4], created: behavior === 'new' ? '2026-10-05' : addDays(FIRST_DAY, -34 - index * 9) }));
  const records = [];
  for (const user of users) {
    for (let day = 0; day < 30; day += 1) {
      const date = addDays(FIRST_DAY, day);
      if (user.behavior === 'new' && date < user.created) continue;
      if (user.behavior === 'sparse' && (day + user.id) % 3 !== 0) continue;
      if (user.behavior === 'quiet' && day >= 23) continue;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const decline = user.behavior === 'decline' && day >= 23 ? .21 : 1;
      const factor = (.76 + random(user.id * 50 + day) * .68) * (weekday === 0 || weekday === 6 ? .75 : 1) * decline;
      for (let index = 0; index < MODELS.length; index += 1) {
        const model = MODELS[index];
        const platformIndex = PLATFORMS.findIndex((p) => p.id === model.platform);
        const requests = Math.round(user.base * factor * user.mix[platformIndex] * model.weight);
        if (!requests) continue;
        const tokenFactor = .85 + random(user.id * 160 + day * 10 + index) * .3;
        const input = Math.round(requests * model.input * tokenFactor);
        const output = Math.round(requests * model.output * tokenFactor);
        const read = Math.round(requests * model.read * tokenFactor);
        const creation = Math.round(requests * model.creation * tokenFactor);
        records.push({ userId: user.id, date, platform: model.platform, model: model.name, requests, input, output, read, creation, tokens: input + output + read + creation, cost: roundCost(requests * model.price * tokenFactor) });
      }
    }
  }
  for (const user of users) {
    const recentCost = sum(records.filter((r) => r.userId === user.id && r.date >= '2026-10-07'), 'cost');
    const low = [12, 31, 52, 106, 115].includes(user.id);
    user.balance = user.plan === 'balance' ? roundCost(recentCost / 7 * (low ? 1.15 + random(user.id) : 9 + random(user.id) * 19) + (recentCost === 0 ? 22.5 : 0)) : 0;
  }
  return { users, records };
}
const data = createDemoData();

function totals(records) {
  const result = { requests: 0, cost: 0, tokens: 0, input: 0, output: 0, read: 0, creation: 0 };
  for (const record of records) for (const key of Object.keys(result)) result[key] += record[key];
  result.cost = roundCost(result.cost);
  return result;
}

function groups(records, key) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record[key])) map.set(record[key], []);
    map.get(record[key]).push(record);
  }
  return Array.from(map, ([name, rows]) => ({ name, platform: rows[0].platform, ...totals(rows) }));
}

function recentStatus(user) {
  const all = data.records.filter((r) => r.userId === user.id);
  const filtered = all.filter((r) => state.platform === 'all' || r.platform === state.platform);
  const previous = sum(filtered.filter((r) => r.date >= '2026-09-30' && r.date < '2026-10-07'), 'requests');
  const current = sum(filtered.filter((r) => r.date >= '2026-10-07'), 'requests');
  const dailyBalanceCost = user.plan === 'balance' ? sum(all.filter((r) => r.date >= '2026-10-07'), 'cost') / 7 : 0;
  const runway = dailyBalanceCost > 0 ? user.balance / dailyBalanceCost : null;
  return { decline: previous >= 100 && current <= previous * .5, lowBalance: runway !== null && runway < 3, runway, previous, current, dailyBalanceCost };
}

function calculateView() {
  const allowedIds = new Set(data.users.filter((u) => state.plan === 'all' || u.plan === state.plan).map((u) => u.id));
  const records = data.records.filter((r) => allowedIds.has(r.userId) && r.date >= state.start && r.date <= state.end && (state.platform === 'all' || r.platform === state.platform));
  const byUser = groups(records, 'userId');
  const users = byUser.map((aggregate) => {
    const user = data.users.find((u) => u.id === aggregate.name);
    const userRecords = records.filter((r) => r.userId === user.id);
    const platforms = groups(userRecords, 'platform');
    const models = groups(userRecords, 'model');
    return { ...user, ...aggregate, name: user.name, records: userRecords, platforms, models, days: new Set(userRecords.map((r) => r.date)).size, recent: recentStatus(user) };
  }).sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.id - b.id);
  const highCount = Math.ceil(users.length * .2);
  users.forEach((u, index) => { u.high = index < highCount && u.cost > 0; u.multi = u.platforms.length >= 2; });
  return { users, records, total: totals(records), platforms: groups(records, 'platform'), models: groups(records, 'model'), days: Math.round((new Date(state.end) - new Date(state.start)) / 86400000) + 1 };
}

function renderSummary() {
  const multi = view.users.filter((u) => u.multi).length;
  const totalDays = view.users.reduce((n, u) => n + u.days, 0);
  const metrics = [
    ['区间活跃用户', number(view.users.length), '人', 'users-round', `日均活跃 <b>${(totalDays / view.days).toFixed(1)}</b> 人`],
    ['用户消费额度', money(view.total.cost), '额度', 'coins', `共 ${shortNumber(view.total.requests)} 次请求 · 实际计费`],
    ['人均消费额度', money(view.users.length ? view.total.cost / view.users.length : 0), '额度 / 人', 'chart-no-axes-column-increasing', `按区间去重活跃用户计算`],
    ['多平台使用率', percent(multi, view.users.length), '', 'network', `<b>${multi}</b> 位用户使用 ≥ 2 个平台`]
  ];
  $('summary-metrics').innerHTML = metrics.map(([label, value, unit, symbol, foot]) => `<article class="metric-card"><div class="metric-label"><span>${label}</span>${icon(symbol)}</div><div class="metric-value">${value}<small>${unit}</small></div><div class="metric-foot">${foot}</div></article>`).join('');
}

function renderPreferences() {
  const metric = state.metric;
  const spec = METRICS[metric];
  const total = view.total[metric];
  const amounts = PLATFORMS.map((p) => ({ ...p, value: view.platforms.find((item) => item.name === p.id)?.[metric] || 0 }));
  $('platform-count').textContent = `${amounts.filter((p) => p.value > 0).length} 个平台`;
  $('donut-label').textContent = spec.total;
  $('donut-value').textContent = metric === 'cost' ? shortNumber(total, 2) : shortNumber(total);
  $('donut-unit').textContent = spec.unit;
  $('platform-chart').setAttribute('aria-label', `${spec.name}平台分布：${amounts.map((p) => `${p.name} ${percent(p.value, total)}`).join('，')}`);
  $('platform-legend').innerHTML = amounts.map((p) => `<div class="platform-legend-row"><span class="legend-dot" style="background:${p.color}"></span><span class="platform-legend-name">${p.name}</span><span class="platform-legend-value">${percent(p.value, total)}</span><span class="platform-legend-amount">${metric === 'cost' ? money(p.value) : shortNumber(p.value)} ${spec.unit}</span></div>`).join('');
  platformChart ||= echarts.init($('platform-chart'), null, { renderer: 'svg' });
  platformChart.setOption({
    animationDuration: 0,
    animationDurationUpdate: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350,
    tooltip: { trigger: 'item', confine: true, borderColor: '#e2e9e7', textStyle: { color: '#415553', fontSize: 11 }, formatter: (p) => `${p.name}<br>${metric === 'cost' ? money(p.value) : number(p.value)} ${spec.unit} · ${percent(p.value, total)}` },
    series: [{ type: 'pie', radius: ['73%', '89%'], center: ['50%', '50%'], startAngle: 90, padAngle: 3, label: { show: false }, labelLine: { show: false }, emphasis: { scaleSize: 3 }, data: amounts.map((p) => ({ name: p.name, value: p.value, itemStyle: { color: p.color, borderRadius: 3 } })), stillShowZeroSum: false }]
  });
  const sorted = [...view.models].sort((a, b) => b[metric] - a[metric]);
  const top = sorted.slice(0, 5);
  if (sorted.length > 5) top.push({ name: '其他模型', platform: null, [metric]: sum(sorted.slice(5), metric) });
  const max = top[0]?.[metric] || 1;
  $('model-bars').innerHTML = top.length ? top.map((model) => {
    const color = model.platform ? platformById(model.platform).color : '#b1b9bb';
    return `<div class="model-bar-row" title="${escaped(model.name)}：${metric === 'cost' ? money(model[metric]) : number(model[metric])} ${spec.unit}"><span class="model-name"><span class="legend-dot" style="background:${color}"></span><span>${escaped(model.name)}</span></span><div class="model-track"><div class="model-fill" style="background:${color};width:${model[metric] / max * 100}%"></div></div><span class="model-percent">${percent(model[metric], total)}</span></div>`;
  }).join('') : '<p class="muted">当前范围无模型使用记录</p>';
  document.querySelectorAll('[data-metric]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.metric === metric)));
}

function renderInsights() {
  const count = view.users.length;
  const head = Math.ceil(count * .2);
  const middle = Math.ceil(count * .5);
  const segments = [
    { name: `前 20% 用户 · ${head} 人`, cost: sum(view.users.slice(0, head), 'cost'), color: '#428d76' },
    { name: `中间 30% · ${middle - head} 人`, cost: sum(view.users.slice(head, middle), 'cost'), color: '#9fc7b6' },
    { name: `其余 50% · ${count - middle} 人`, cost: sum(view.users.slice(middle), 'cost'), color: '#dcebe3' }
  ];
  $('concentration-value').textContent = percent(segments[0].cost, view.total.cost);
  $('concentration-description').textContent = `的消费由排名前 ${head} 位用户贡献`;
  $('concentration-bar').innerHTML = segments.map((s) => `<span style="width:${view.total.cost ? s.cost / view.total.cost * 100 : 0}%;background:${s.color}" title="${s.name}：${money(s.cost)} 额度"></span>`).join('');
  $('concentration-bar').setAttribute('aria-label', `消费集中度：${segments.map((s) => `${s.name}占${percent(s.cost, view.total.cost)}`).join('，')}`);
  $('concentration-legend').innerHTML = segments.map((s) => `<span><span class="legend-dot" style="background:${s.color}"></span>${s.name}<b>${percent(s.cost, view.total.cost)}</b></span>`).join('');
  $('decline-count').innerHTML = `${view.users.filter((u) => u.recent.decline).length}<small>人</small>`;
  $('balance-count').innerHTML = `${view.users.filter((u) => u.recent.lowBalance).length}<small>人</small>`;
}

function filteredUsers() {
  const query = state.search.trim().toLowerCase();
  return view.users.filter((user) => {
    const matches = !query || `${user.id} ${user.name} ${user.email}`.toLowerCase().includes(query);
    const segmentMatches = state.segment === 'all' || (state.segment === 'high' && user.high) || (state.segment === 'multi' && user.multi) || (state.segment === 'decline' && user.recent.decline) || (state.segment === 'balance' && user.recent.lowBalance);
    return matches && segmentMatches;
  }).sort((a, b) => b[state.sort] - a[state.sort] || b.cost - a.cost || a.id - b.id);
}

function tags(user) {
  const values = [];
  if (user.high) values.push(['high', '高消费']);
  if (user.multi) values.push(['multi', '多平台']);
  if (user.recent.decline) values.push(['decline', '活跃下降']);
  if (user.recent.lowBalance) values.push(['balance', '低余额']);
  if (!values.length) values.push(['', user.created >= state.start && user.created <= state.end ? '新用户' : '单平台']);
  return values.map(([type, label]) => `<span class="tag ${type}">${label}</span>`).join('');
}

function platformStack(user, metric = state.metric) {
  return PLATFORMS.map((p) => {
    const amount = user.platforms.find((s) => s.name === p.id)?.[metric] || 0;
    return amount ? `<span style="width:${user[metric] > 0 ? amount / user[metric] * 100 : 0}%;background:${p.color}" title="${p.name}：${percent(amount, user[metric])}"></span>` : '';
  }).join('');
}

function renderTable() {
  const users = filteredUsers();
  const pages = Math.max(1, Math.ceil(users.length / state.pageSize));
  state.page = Math.max(1, Math.min(state.page, pages));
  const start = (state.page - 1) * state.pageSize;
  const subset = users.slice(start, start + state.pageSize);
  $('user-count').textContent = `${users.length} 位`;
  $('platform-table-heading').textContent = `平台偏好 · ${METRICS[state.metric].share}`;
  $('user-rows').innerHTML = subset.map((user, index) => {
    const leader = [...user.models].sort((a, b) => b[state.metric] - a[state.metric])[0];
    const platformDescription = user.platforms.map((p) => `${platformById(p.name).name} ${percent(p[state.metric], user[state.metric])}`).join('，');
    return `<tr><td class="rank-cell">${String(start + index + 1).padStart(2, '0')}</td><td><div class="user-cell"><span class="avatar ${user.avatar}" aria-hidden="true">${user.name.slice(-2)}</span><div><button class="user-name-button" data-user="${user.id}" type="button" aria-label="查看${user.name}画像">${user.name}</button><div class="user-email">${user.email}</div></div></div></td><td class="platform-cell"><div class="mini-stack" role="img" aria-label="${escaped(platformDescription)}">${platformStack(user)}</div><div class="preferred-model">${leader ? escaped(leader.name) : '—'}</div></td><td class="numeric cost-cell">${money(user.cost)}</td><td class="share-col"><span class="share-value">${percent(user.cost, view.total.cost)}</span><div class="share-track"><span style="width:${view.total.cost ? user.cost / view.total.cost * 100 : 0}%"></span></div></td><td class="numeric">${number(user.requests)}</td><td class="numeric day-count"><b>${user.days}</b> / ${view.days}</td><td><div class="tag-list">${tags(user)}</div></td><td class="action-cell"><button class="row-open" data-user="${user.id}" aria-label="打开${user.name}详情" title="查看用户画像" type="button">${icon('arrow-up-right')}</button></td></tr>`;
  }).join('');
  $('empty-state').hidden = users.length > 0;
  $('pagination-summary').textContent = users.length ? `显示 ${start + 1}–${Math.min(start + state.pageSize, users.length)} 位，共 ${users.length} 位用户` : '0 位用户';
  $('page-number').textContent = `${state.page} / ${pages}`;
  $('previous-page').disabled = state.page <= 1;
  $('next-page').disabled = state.page >= pages;
  document.querySelectorAll('[data-segment]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.segment === state.segment)));
  refreshIcons();
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
}

function renderAll() {
  view = calculateView();
  const platform = state.platform === 'all' ? '' : ` · ${platformById(state.platform).name}`;
  const plan = state.plan === 'all' ? '' : state.plan === 'balance' ? ' · 按量付费' : ' · 订阅用户';
  $('range-summary').textContent = `${state.start.replaceAll('-', '.')} — ${state.end.replaceAll('-', '.')} · ${view.days} 天 · Asia/Shanghai${platform}${plan}`;
  renderSummary();
  renderPreferences();
  renderInsights();
  renderTable();
  document.querySelectorAll('[data-days]').forEach((button) => button.setAttribute('aria-pressed', String(state.end === SNAPSHOT && state.start === addDays(SNAPSHOT, 1 - Number(button.dataset.days)))));
}

function selectSegment(segment, scroll = false) {
  state.segment = segment;
  state.page = 1;
  renderTable();
  if (scroll) $('user-list-title').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function openProfile(id) {
  const user = view.users.find((u) => u.id === Number(id));
  if (!user) return;
  state.selected = user.id;
  state.detailMetric = state.metric;
  $('profile-identity').innerHTML = `<span class="avatar ${user.avatar}" aria-hidden="true">${user.name.slice(-2)}</span><div><h2 id="profile-name">${user.name}</h2><p class="identity-email">${user.email} · ID ${user.id} · ${user.plan === 'balance' ? '按量付费' : '订阅用户'}</p><div class="tag-list">${tags(user)}</div></div>`;
  $('profile-range').textContent = `${state.start.replaceAll('-', '.')} — ${state.end.replaceAll('-', '.')} · 当前筛选范围`;
  $('profile-metrics').innerHTML = [ ['消费额度', money(user.cost)], ['范围内消费占比', percent(user.cost, view.total.cost)], ['请求数', number(user.requests)], ['活跃天数', `${user.days} / ${view.days}`] ].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('');
  renderProfilePreferences(user);
  $('detail-token-total').textContent = `${shortNumber(user.tokens)} Token`;
  $('detail-tokens').innerHTML = [['输入 Token', 'input', '#4d9b88'], ['输出 Token', 'output', '#6490c1'], ['缓存读取', 'read', '#a394ba'], ['缓存创建', 'creation', '#cf8471']].map(([label, key, color]) => `<div><div class="token-label"><span class="legend-dot" style="background:${color}"></span>${label}</div><strong class="token-value">${shortNumber(user[key])}<small>${percent(user[key], user.tokens)}</small></strong></div>`).join('');
  const days = Array.from({ length: view.days }, (_, i) => {
    const date = addDays(state.start, i);
    return { date, ...totals(user.records.filter((r) => r.date === date)) };
  });
  const max = Math.max(...days.map((d) => d.requests), 1);
  $('calendar-summary').textContent = `${user.days} / ${view.days} 天有请求`;
  $('detail-calendar').innerHTML = days.map((day) => `<div class="calendar-day level-${day.requests ? Math.max(1, Math.ceil(day.requests / max * 4)) : 0}" title="${day.date}：${number(day.requests)} 次请求 · ${money(day.cost)} 额度" aria-label="${day.date}，${number(day.requests)} 次请求">${day.date.slice(8)}</div>`).join('');
  const recent = user.recent;
  const last = data.records.filter((r) => r.userId === user.id).map((r) => r.date).sort().at(-1);
  $('detail-state').innerHTML = [
    ['计费类型', user.plan === 'balance' ? '按量付费' : '订阅用户'],
    ['当前余额', user.plan === 'balance' ? `${money(user.balance)} 额度` : '不估算订阅剩余额度'],
    ['近 7 天日均余额消费', user.plan === 'balance' ? `${money(recent.dailyBalanceCost)} 额度 / 天` : '—'],
    ['余额预计可用', recent.runway !== null ? `${recent.runway.toFixed(1)} 天` : '无适用估算'],
    ['近 7 天请求变化', recent.previous > 0 ? `${((recent.current - recent.previous) / recent.previous * 100).toFixed(1)}% · 对比前 7 天` : '无可比基期'],
    ['最近使用', last ? `${last.replaceAll('-', '.')} · Asia/Shanghai` : '无使用记录'],
    ['注册日期', user.created.replaceAll('-', '.')]
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  setDetailTab('preference');
  refreshIcons();
  $('profile-dialog').showModal();
  $('profile-dialog').scrollTop = 0;
}

function renderProfilePreferences(user) {
  const metric = state.detailMetric;
  $('detail-metric-name').textContent = `按${METRICS[metric].name}`;
  $('detail-platform-bar').innerHTML = platformStack(user, metric);
  $('detail-platform-bar').setAttribute('role', 'img');
  $('detail-platform-bar').setAttribute('aria-label', user.platforms.map((p) => `${platformById(p.name).name} ${percent(p[metric], user[metric])}`).join('，'));
  $('detail-platform-legend').innerHTML = PLATFORMS.map((p) => {
    const amount = user.platforms.find((item) => item.name === p.id)?.[metric] || 0;
    return `<span><span class="legend-dot" style="background:${p.color}"></span>${p.name}<b>${percent(amount, user[metric])}</b></span>`;
  }).join('');
  $('detail-model-share-label').textContent = METRICS[metric].share;
  $('detail-model-rows').innerHTML = [...user.models].sort((a, b) => b[metric] - a[metric]).map((m) => `<tr><td>${escaped(m.name)}<span class="model-platform-name">${platformById(m.platform).name}</span></td><td class="numeric">${number(m.requests)}</td><td class="numeric">${money(m.cost)}</td><td class="numeric">${percent(m[metric], user[metric])}</td></tr>`).join('');
  document.querySelectorAll('[data-detail-metric]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.detailMetric === metric)));
}

function setDetailTab(name) {
  const preference = name === 'preference';
  $('preference-tab').classList.toggle('active', preference);
  $('activity-tab').classList.toggle('active', !preference);
  $('preference-tab').setAttribute('aria-selected', String(preference));
  $('activity-tab').setAttribute('aria-selected', String(!preference));
  $('preference-panel').hidden = !preference;
  $('activity-panel').hidden = preference;
  if (!preference) renderDetailTrend();
}

function renderDetailTrend() {
  const user = view.users.find((u) => u.id === state.selected);
  if (!user) return;
  const days = Array.from({ length: view.days }, (_, i) => {
    const date = addDays(state.start, i);
    return { date, ...totals(user.records.filter((r) => r.date === date)) };
  });
  trendChart ||= echarts.init($('detail-trend'), null, { renderer: 'svg' });
  trendChart.resize();
  trendChart.setOption({
    animation: false,
    grid: { left: 42, right: 44, top: 35, bottom: 26 },
    legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 6, textStyle: { color: '#7c8c8b', fontSize: 10 }, data: ['消费额度', '请求数'] },
    tooltip: { trigger: 'axis', confine: true, textStyle: { color: '#415553', fontSize: 11 }, valueFormatter: (value) => money(value) },
    xAxis: { type: 'category', data: days.map((d) => d.date.slice(5).replace('-', '.')), boundaryGap: true, axisLine: { lineStyle: { color: '#e7ecea' } }, axisTick: { show: false }, axisLabel: { color: '#899592', fontSize: 9, interval: Math.max(0, Math.ceil(days.length / 6) - 1) } },
    yAxis: [ { type: 'value', name: '额度', nameTextStyle: { color: '#899592', fontSize: 9 }, splitLine: { lineStyle: { color: '#f0f3f2' } }, axisLabel: { color: '#899592', fontSize: 9 } }, { type: 'value', name: '请求', nameTextStyle: { color: '#899592', fontSize: 9 }, splitLine: { show: false }, axisLabel: { color: '#899592', fontSize: 9 } } ],
    series: [ { name: '消费额度', type: 'bar', data: days.map((d) => Number(d.cost.toFixed(2))), barMaxWidth: 9, itemStyle: { color: '#91bcab', borderRadius: [2, 2, 0, 0] } }, { name: '请求数', type: 'line', yAxisIndex: 1, data: days.map((d) => d.requests), symbol: 'none', lineStyle: { color: '#6b91b8', width: 1.5 }, itemStyle: { color: '#6b91b8' } } ]
  }, { notMerge: true });
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function exportUsers() {
  const users = filteredUsers();
  if (!users.length) return showToast('当前没有可导出的用户');
  const header = ['用户ID', '用户名', '邮箱', '开始日期', '结束日期', '计费类型', '消费额度', '消费占比（当前统计范围）', '请求数', 'Token', '活跃天数', 'Anthropic占比', 'OpenAI占比', 'Google占比', '其他平台占比', '平台占比口径', '模拟数据'];
  const rows = users.map((u) => [u.id, u.name, u.email, state.start, state.end, u.plan === 'balance' ? '按量付费' : '订阅用户', u.cost.toFixed(6), percent(u.cost, view.total.cost), u.requests, u.tokens, u.days, ...PLATFORMS.map((p) => percent(u.platforms.find((x) => x.name === p.id)?.[state.metric] || 0, u[state.metric])), METRICS[state.metric].name, '是']);
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `user-profiles-demo-${state.start}-${state.end}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出 ${users.length} 位用户的模拟画像`);
}

function bindEvents() {
  $('range-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const start = $('start-date').value;
    const end = $('end-date').value;
    if (!start || !end || start > end || start < FIRST_DAY || end > SNAPSHOT) {
      $('range-error').textContent = '请选择 2026.09.14 至 2026.10.13 之间的有效日期范围。';
      $('range-error').hidden = false;
      return;
    }
    $('range-error').hidden = true;
    state.start = start;
    state.end = end;
    state.plan = $('plan-filter').value;
    state.platform = $('platform-filter').value;
    state.page = 1;
    renderAll();
  });
  document.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
    $('start-date').value = addDays(SNAPSHOT, 1 - Number(button.dataset.days));
    $('end-date').value = SNAPSHOT;
    $('range-form').requestSubmit();
  }));
  for (const id of ['plan-filter', 'platform-filter']) $(id).addEventListener('change', () => $('range-form').requestSubmit());
  document.querySelectorAll('[data-metric]').forEach((button) => button.addEventListener('click', () => {
    state.metric = button.dataset.metric;
    renderPreferences();
    renderTable();
  }));
  document.querySelectorAll('[data-segment]').forEach((button) => button.addEventListener('click', () => selectSegment(button.dataset.segment)));
  $('attention-decline').addEventListener('click', () => selectSegment('decline', true));
  $('attention-balance').addEventListener('click', () => selectSegment('balance', true));
  $('user-search').addEventListener('input', (event) => { state.search = event.target.value; state.page = 1; renderTable(); });
  $('sort-select').addEventListener('change', (event) => { state.sort = event.target.value; state.page = 1; renderTable(); });
  $('page-size').addEventListener('change', (event) => { state.pageSize = Number(event.target.value); state.page = 1; renderTable(); });
  $('previous-page').addEventListener('click', () => { state.page -= 1; renderTable(); });
  $('next-page').addEventListener('click', () => { state.page += 1; renderTable(); });
  $('user-rows').addEventListener('click', (event) => { const button = event.target.closest('[data-user]'); if (button) openProfile(button.dataset.user); });
  $('clear-table-filters').addEventListener('click', () => { state.search = ''; $('user-search').value = ''; selectSegment('all'); });
  $('profile-close').addEventListener('click', () => $('profile-dialog').close());
  $('definitions-open').addEventListener('click', () => { refreshIcons(); $('definitions-dialog').showModal(); });
  $('definitions-close').addEventListener('click', () => $('definitions-dialog').close());
  $('preference-tab').addEventListener('click', () => setDetailTab('preference'));
  $('activity-tab').addEventListener('click', () => setDetailTab('activity'));
  document.querySelectorAll('[data-detail-metric]').forEach((button) => button.addEventListener('click', () => {
    state.detailMetric = button.dataset.detailMetric;
    const user = view.users.find((u) => u.id === state.selected);
    if (user) renderProfilePreferences(user);
  }));
  for (const dialog of [$('profile-dialog'), $('definitions-dialog')]) dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  const tabs = [$('preference-tab'), $('activity-tab')];
  tabs.forEach((tab, index) => tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const target = 1 - index;
      setDetailTab(target === 0 ? 'preference' : 'activity');
      tabs[target].focus();
    }
  }));
  $('export-button').addEventListener('click', exportUsers);
  new ResizeObserver(() => {
    platformChart?.resize();
    if (!$('activity-panel').hidden && $('profile-dialog').open) trendChart?.resize();
  }).observe(document.body);
}

renderAll();
bindEvents();
