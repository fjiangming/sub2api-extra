'use strict';

const USERS = [
  { id: 1, name: 'sh***@example.com', avatar: 'mountain', model: 'Claude', tokens: 128600000, requests: 28942, growth: 24.8, previous: 2, factors: { today: .085, week: .47, all: 8.5 } },
  { id: 2, name: 'pi***@example.net', avatar: 'lake', model: 'GPT', tokens: 96300000, requests: 31280, growth: 18.2, previous: 1, factors: { today: .1, week: .51, all: 11.8 } },
  { id: 3, name: 'ni***@example.org', avatar: 'night', model: 'Claude', tokens: 78400000, requests: 18646, growth: 32.6, previous: 3, factors: { today: .17, week: .72, all: 9.3 } },
  { id: 4, name: 'yu***@example.com', avatar: 'forest', model: 'Gemini', tokens: 62500000, requests: 15432, growth: 15.3, previous: 6, factors: { today: .12, week: .63, all: 7.6 } },
  { id: 5, name: 'mo***@example.net', avatar: 'hills', model: 'GPT', tokens: 51700000, requests: 13984, growth: 9.5, previous: 4, factors: { today: .08, week: .65, all: 8.1 } },
  { id: 6, name: 'we***@example.com', avatar: 'sea', model: 'Claude', tokens: 48200000, requests: 12860, growth: 16.2, previous: 8, factors: { today: .16, week: .59336, all: 10.2 } },
  { id: 7, name: 'pl***@example.org', avatar: 'peak', model: 'Gemini', tokens: 42600000, requests: 10256, growth: 28.7, previous: null, factors: { today: .21, week: .82, all: 5.9 } },
  { id: 8, name: 'ev***@example.net', avatar: 'valley', model: 'GPT', tokens: 36900000, requests: 11728, growth: 12.4, previous: 7, factors: { today: .14, week: .72, all: 9.1 } },
  { id: 9, name: 'li***@example.com', avatar: 'coast', model: 'Claude', tokens: 28500000, requests: 7624, growth: 7.8, previous: 10, factors: { today: .19, week: .69, all: 7.8 } },
  { id: 10, name: 'mi***@example.org', avatar: 'green', model: 'Gemini', tokens: 24700000, requests: 6942, growth: 21.5, previous: null, factors: { today: .2, week: .88, all: 6.4 } },
];
const PERIODS = {
  today: { label: '今日', date: '2026.10.12', tokens: 96800000, active: 426, requests: 32486, deltas: [12.8, 8.2, 16.3] },
  week: { label: '本周', date: '2026.10.12（周一）', tokens: 96800000, active: 426, requests: 32486, deltas: [12.8, 8.2, 16.3] },
  month: { label: '本月', date: '2026.10.01 — 10.12', tokens: 1280000000, active: 1248, requests: 386429, deltas: [18.6, 12.4, 24.8] },
  all: { label: '累计', date: '2026.01.01 — 10.12', tokens: 14820000000, active: 3862, requests: 4291863, deltas: null },
};
const METRICS = { tokens: { label: 'Token 用量', unit: 'Tokens' }, requests: { label: '调用次数', unit: '次调用' } };
const MY_ID = 6;
const $ = (id) => document.getElementById(id);
const state = { period: 'month', metric: 'tokens' };
let toastTimer;
let locateTimer;
let rankedUsers = [];

function icon(name) { return `<i data-lucide="${name}"></i>`; }
function hydrateIcons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function number(value) { return new Intl.NumberFormat('en-US').format(value); }
function compact(value) {
  if (value >= 1e9) return { value: (value / 1e9).toFixed(2), unit: 'B' };
  if (value >= 1e6) return { value: (value / 1e6).toFixed(1), unit: 'M' };
  if (value >= 1e3) return { value: (value / 1e3).toFixed(1), unit: 'K' };
  return { value: String(value), unit: '' };
}
function display(value, metric = state.metric) {
  if (metric === 'tokens') return compact(value);
  return { value: number(value), unit: '' };
}
function displayHtml(value, metric = state.metric) {
  const formatted = display(value, metric);
  return `${formatted.value}${formatted.unit ? ` <small>${formatted.unit}</small>` : ''}`;
}
function periodUsers() {
  return USERS.map((user) => {
    // October 12 is a Monday, so the partial current week equals today.
    const factor = state.period === 'month' ? 1 : user.factors[state.period === 'week' ? 'today' : state.period];
    const metricFactor = state.period === 'today' || state.period === 'week' ? 1 + (user.id % 3) * .07 : 1;
    return { ...user, tokens: Math.round(user.tokens * factor), requests: Math.round(user.requests * factor * metricFactor) };
  });
}
function sortedUsers() {
  const current = periodUsers();
  const previous = current.map((user) => ({ id: user.id, value: user.previous === null ? 0 : user[state.metric] / (1 + user.growth / 100) * (state.metric === 'tokens' && state.period === 'month' ? (12 - user.previous) / (12 - user.id) : 1) })).sort((a, b) => b.value - a.value);
  let previousRank = 0;
  previous.forEach((item, index) => {
    if (index === 0 || item.value !== previous[index - 1].value) previousRank = index + 1;
    item.rank = previousRank;
  });
  current.sort((a, b) => b[state.metric] - a[state.metric] || a.id - b.id);
  let currentRank = 0;
  return current.map((user, index) => {
    if (index === 0 || user[state.metric] !== current[index - 1][state.metric]) currentRank = index + 1;
    const previousPosition = state.period === 'month' && state.metric === 'tokens' ? user.previous : previous.find((item) => item.id === user.id).rank;
    return { ...user, rank: currentRank, change: state.period === 'all' ? 0 : user.previous === null ? null : previousPosition - currentRank };
  });
}
function changeHtml(user) {
  if (state.period === 'all' || user.change === 0) return '<span class="rank-same" aria-label="排名未变化">—</span>';
  if (user.change === null) return '<span class="rank-new" aria-label="新上榜">新</span>';
  return `<span class="${user.change > 0 ? 'rank-up' : 'rank-down'}" aria-label="${user.change > 0 ? '上升' : '下降'} ${Math.abs(user.change)} 位">${icon(user.change > 0 ? 'arrow-up' : 'arrow-down')}${Math.abs(user.change)}</span>`;
}

function renderStats() {
  const data = PERIODS[state.period];
  const tokens = compact(data.tokens);
  $('total-tokens').textContent = tokens.value;
  $('total-tokens-unit').textContent = tokens.unit;
  $('active-users').textContent = number(data.active);
  $('total-requests').textContent = number(data.requests);
  ['total-tokens-delta', 'active-users-delta', 'total-requests-delta'].forEach((id, index) => {
    $(id).hidden = !data.deltas;
    if (data.deltas) {
      $(id).innerHTML = icon('trending-up') + data.deltas[index] + '%';
      $(id).title = '较上一等长周期';
    }
  });
  $('date-range').textContent = data.date;
  $('ranking-period').textContent = data.label + '排名';
  $('personal-period').textContent = data.label;
  $('table-caption').textContent = `${data.label}按${METRICS[state.metric].label}排序的前十位用户`;
}

function renderPodium() {
  const labels = ['first', 'second', 'third'];
  $('podium').innerHTML = rankedUsers.slice(0, 3).map((user, index) => {
    const value = display(user[state.metric]);
    const kicker = index === 0 ? `<span class="podium-kicker">${icon('crown')}${PERIODS[state.period].label}榜首</span>` : '';
    return `<button class="podium-card ${labels[index]}" type="button" data-user-id="${user.id}" aria-label="查看第 ${user.rank} 名 ${user.name} 的用量详情">
      ${kicker}<span class="podium-avatar"><img src="./assets/${user.avatar}.jpg" alt="" width="64" height="64"><span class="medal">${user.rank}</span></span>
      <span class="podium-name" title="${user.name}"><span>${user.name}</span>${user.id === MY_ID ? '<span class="you-label">你</span>' : ''}</span><span class="podium-model">${user.model} 爱好者</span>
      <span class="podium-amount"><strong>${value.value}</strong><span>${value.unit}</span></span><span class="podium-unit">${METRICS[state.metric].unit}</span>
      <span class="podium-bottom">${state.period === 'all' ? icon('sparkles') + '持续创造，保持热爱' : icon('trending-up') + '较上期增长 ' + user.growth + '%'}</span>
    </button>`;
  }).join('');
}

function renderTable() {
  const metrics = [state.metric, ...Object.keys(METRICS).filter((metric) => metric !== state.metric)];
  ['tokens-heading', 'requests-heading'].forEach((id, index) => {
    $(id).innerHTML = METRICS[metrics[index]].label + (index === 0 ? ' ' + icon('arrow-down') : '');
    $(id).setAttribute('aria-sort', index === 0 ? 'descending' : 'none');
  });
  const max = rankedUsers[0][state.metric];
  $('ranking-body').innerHTML = rankedUsers.map((user, index) => {
    const rank = index < 3 ? `<span class="table-medal ${index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}" aria-label="第 ${user.rank} 名">${icon('medal')}</span>` : String(user.rank).padStart(2, '0');
    const cells = metrics.map((metric, column) => {
      const value = display(user[metric], metric);
      return `<td class="numeric-cell ${column === 0 ? 'primary-cell' : 'secondary-cell'}">${column === 0 ? `<span class="usage-cell"><span>${value.value}<span class="value-unit">${value.unit}</span></span><span class="usage-track"><span style="width:${user[metric] / max * 100}%"></span></span></span>` : value.value + (value.unit ? ' ' + value.unit : '')}</td>`;
    }).join('');
    return `<tr data-ranking-user="${user.id}" ${user.id === MY_ID ? 'class="is-me"' : ''}>
      <td class="rank-cell">${rank}</td><td><div class="rank-user"><img src="./assets/${user.avatar}.jpg" alt="" width="31" height="31"><div class="user-copy"><span class="user-name"><span>${user.name}</span>${user.id === MY_ID ? '<span class="you-label">你</span>' : ''}</span><span class="user-model">${user.model} 爱好者</span></div></div></td>
      ${cells}<td class="change-cell">${changeHtml(user)}</td><td class="action-column"><button class="row-detail" type="button" data-user-id="${user.id}" aria-label="查看${user.name}的用量详情" title="查看用量详情">${icon('chevron-right')}</button></td>
    </tr>`;
  }).join('');
}

function renderPersonal() {
  const me = rankedUsers.find((user) => user.id === MY_ID);
  $('my-rank').textContent = String(me.rank).padStart(2, '0');
  $('my-percentile').textContent = `超过 ${((PERIODS[state.period].active - me.rank) / PERIODS[state.period].active * 100).toFixed(1)}% 的创造者`;
  $('my-change').classList.toggle('down', me.change < 0);
  $('my-change').innerHTML = state.period === 'all' ? icon('sparkles') + '每一份坚持，都会积累' : me.change === 0 ? icon('minus') + '与上期排名持平' : icon(me.change > 0 ? 'move-up' : 'move-down') + `较上期${me.change > 0 ? '上升' : '下降'} ${Math.abs(me.change)} 位`;
  $('my-primary-label').textContent = METRICS[state.metric].label;
  $('my-primary-value').innerHTML = displayHtml(me[state.metric]);
  const secondary = state.metric === 'requests' ? 'tokens' : 'requests';
  $('my-secondary-label').textContent = METRICS[secondary].label;
  $('my-secondary-value').innerHTML = displayHtml(me[secondary], secondary);
  const next = rankedUsers.filter((user) => user.rank < me.rank).at(-1);
  $('next-rank-label').textContent = next ? `距离第 ${next.rank} 名` : '你已位居榜首';
  $('next-rank-gap').textContent = next ? Object.values(display(next[state.metric] - me[state.metric])).join(' ').trim() : 'TOP 01';
  $('next-rank-progress').style.width = next ? me[state.metric] / next[state.metric] * 100 + '%' : '100%';
  $('next-rank-copy').textContent = next ? '再向前一点，就能遇见新的风景。' : '保持热爱，让好想法继续发生。';
}

function renderChart() {
  // This seven-day history is independent of the leaderboard's selected period.
  const values = [3100000, 4200000, 3400000, 4800000, 2800000, 2588000, 7712000];
  $('weekly-total').innerHTML = displayHtml(values.reduce((total, value) => total + value, 0), 'tokens').replace(/small/g, 'span');
  const peak = Math.max(...values);
  $('usage-chart').innerHTML = values.map((value, index) => `<span class="chart-bar ${index === 6 ? 'latest' : ''}" tabindex="0" style="--bar-height:${value / peak * 90}%" aria-label="10月${index + 6}日：${(value / 1e6).toFixed(2)} M"></span>`).join('');
}

function render() {
  document.body.dataset.metric = state.metric;
  rankedUsers = sortedUsers();
  document.querySelectorAll('[data-period]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.period === state.period)); });
  renderStats();
  renderPodium();
  renderTable();
  renderPersonal();
  hydrateIcons();
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').querySelector('span').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}

function showUser(id) {
  const user = rankedUsers.find((entry) => entry.id === id);
  if (!user) return;
  $('detail-period').textContent = PERIODS[state.period].label + '用量';
  $('detail-avatar').src = `./assets/${user.avatar}.jpg`;
  $('user-dialog-title').textContent = user.name;
  $('detail-rank').textContent = PERIODS[state.period].label + '排名 #' + user.rank + ' · ' + METRICS[state.metric].label;
  $('detail-model').textContent = user.model;
  $('detail-stats').innerHTML = Object.keys(METRICS).map((metric) => `<div><dt>${METRICS[metric].label}</dt><dd>${displayHtml(user[metric], metric)}</dd></div>`).join('');
  $('user-dialog').showModal();
}

document.querySelectorAll('[data-period]').forEach((button) => {
  button.addEventListener('click', () => { state.period = button.dataset.period; render(); });
});
$('metric-select').addEventListener('change', (event) => { state.metric = event.target.value; render(); });
$('rules-button').addEventListener('click', () => { $('rules-dialog').showModal(); });
document.querySelectorAll('[data-close-dialog]').forEach((button) => { button.addEventListener('click', () => { button.closest('dialog').close(); }); });
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-user-id]');
  if (button) showUser(Number(button.dataset.userId));
});
$('locate-me').addEventListener('click', () => {
  const row = document.querySelector(`[data-ranking-user="${MY_ID}"]`);
  const button = row.querySelector('button');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'center' });
  button.focus({ preventScroll: true });
  row.classList.remove('located');
  requestAnimationFrame(() => { row.classList.add('located'); });
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => { row.classList.remove('located'); }, 1800);
});
$('refresh-button').addEventListener('click', () => {
  const button = $('refresh-button');
  button.disabled = true;
  button.classList.add('spinning');
  setTimeout(() => {
    render();
    const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    $('updated-at').textContent = '更新于 ' + now;
    button.classList.remove('spinning');
    button.disabled = false;
    toast('榜单已刷新 · 当前为示例数据');
  }, 450);
});
renderChart();
render();
