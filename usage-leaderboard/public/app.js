'use strict';

const PERIODS = { today: '今日', week: '本周', month: '本月', all: '累计' };
const METRICS = { tokens: { label: 'Token 用量', unit: 'Tokens' }, requests: { label: '调用次数', unit: '次调用' } };
const $ = (id) => document.getElementById(id);
const state = { period: 'today', metric: 'tokens', data: null, session: '', csrf: '', authenticated: false, canManage: false, config: null, controller: null, sequence: 0 };
const query = new URLSearchParams(location.search);
let upstreamToken = query.get('token') || query.get('access_token') || '';
for (const key of ['token', 'access_token', 'user_id', 'src_host', 'src_url']) query.delete(key);
history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
let toastTimer;
let locateTimer;

function icon(name) { return `<i data-lucide="${name}"></i>`; }
function hydrateIcons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function number(value) { return new Intl.NumberFormat('en-US').format(value); }
function compact(value) {
  if (value >= 1e9) return { value: (value / 1e9).toFixed(2), unit: 'B' };
  if (value >= 1e6) return { value: (value / 1e6).toFixed(2), unit: 'M' };
  if (value >= 1e3) return { value: (value / 1e3).toFixed(1), unit: 'K' };
  return { value: number(value), unit: '' };
}
function display(value, metric = state.metric) {
  if (metric === 'tokens') return compact(value);
  return { value: number(value), unit: '' };
}
function displayHtml(value, metric = state.metric) {
  const formatted = display(value, metric);
  return `${formatted.value}${formatted.unit ? ` <small>${formatted.unit}</small>` : ''}`;
}
function saveSession(token) {
  state.session = token;
  try {
    if (token) sessionStorage.setItem('usage-leaderboard.session', token);
    else sessionStorage.removeItem('usage-leaderboard.session');
  } catch { /* Cookies and the in-memory token also support restricted iframes. */ }
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(state.session ? { authorization: `Session ${state.session}` } : {}), ...options.headers };
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method)) {
    headers['content-type'] = 'application/json';
    if (state.csrf) headers['x-csrf-token'] = state.csrf;
  }
  let response;
  try {
    response = await fetch(`./api/${path}`, { ...options, headers, credentials: 'same-origin',
      cache: 'no-store', signal: options.signal || AbortSignal.timeout(60000) });
  } catch (error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    throw new Error('暂时无法连接用量服务，请稍后重试');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || '暂时无法获取数据，请稍后重试');
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  if (!payload) throw new Error('用量服务返回了无效响应，请稍后重试');
  return payload;
}

function showStatus(message, { error = false, login = false } = {}) {
  $('page-status').hidden = false;
  $('page-status').classList.toggle('status-error', error);
  $('status-message').textContent = message;
  $('retry-button').hidden = !error || login;
  $('login-link').hidden = !login || !state.config;
  $('usage-content').hidden = true;
  $('page-status').setAttribute('aria-busy', String(!error && !login));
  if (login) {
    state.authenticated = false;
    state.canManage = false;
    state.csrf = '';
    $('settings-link').hidden = true;
    window.UsageAdmin.clear();
    saveSession('');
    $('signed-in').hidden = true;
    enableFilters(false);
  }
}

function enableFilters(enabled) {
  document.querySelectorAll('[data-period], #metric-select').forEach((control) => { control.disabled = !enabled; });
}

function renderIdentity(user) {
  $('signed-in').hidden = false;
  $('header-name').textContent = user.name;
  $('header-name').title = user.name;
  window.UsageAvatars.set($('header-avatar'), user);
  $('signed-in').setAttribute('aria-label', `查看${user.name}的个人用量`);
  $('personal-name').textContent = user.name;
  $('personal-name').title = user.name;
  window.UsageAvatars.set($('personal-avatar'), user);
}

function localDate(value) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: state.config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)).replaceAll('-', '.');
}
function rangeText(data) {
  const from = data.period === 'all' ? data.window.retainedFrom : data.window.start;
  if (!from) return localDate(data.window.end);
  const start = localDate(from);
  const end = localDate(data.window.end);
  return start === end ? end : `${start} — ${end.slice(5)}`;
}
function delta(id, value) {
  const element = $(id);
  element.hidden = value == null;
  element.classList.toggle('negative', value < 0);
  element.innerHTML = value == null ? '' : icon(value < 0 ? 'trending-down' : 'trending-up') + `${value > 0 ? '+' : ''}${value}%`;
  element.title = '较上期同期';
}
function changeHtml(user) {
  if (!user.comparisonAvailable) return '<span class="rank-same" aria-label="暂无可比较的排名">—</span>';
  if (user.newEntry) return '<span class="rank-new" aria-label="本期新上榜">新</span>';
  if (user.change === 0 || user.change == null) return '<span class="rank-same" aria-label="排名未变化">—</span>';
  return `<span class="${user.change > 0 ? 'rank-up' : 'rank-down'}" aria-label="${user.change > 0 ? '上升' : '下降'} ${Math.abs(user.change)} 位">${icon(user.change > 0 ? 'arrow-up' : 'arrow-down')}${Math.abs(user.change)}</span>`;
}

function renderStats(data) {
  const simulated = data.display.simulatedCount > 0;
  const scoped = data.display.mode !== 'real';
  $('tokens-summary-label').textContent = scoped ? '榜单 Token 用量' : '全站 Token 用量';
  $('requests-summary-label').textContent = scoped ? '榜单调用次数' : 'API 调用次数';
  document.querySelector('.station-stats').setAttribute('aria-label', scoped ? '当前榜单用量汇总' : '全站用量概览');
  $('board-source-note').textContent = simulated ? '含示例数据 · 真实用户优先' : scoped ? '真实用户优先 · 按用量下限筛选' : '每一次探索，都值得被看见';
  $('rules-source').hidden = !scoped;
  $('rules-source').textContent = simulated ? `当前榜单含 ${data.display.simulatedCount} 位模拟用户，以“示例”标识；真实用户按设置的用量下限优先展示。汇总仅计当前榜单，个人用量始终来自主站真实记录。模拟快照日期：${data.display.date}。` : scoped ? '当前按 Token 下限筛选真实用户，再按所选指标展示前十位。汇总仅计当前榜单，不与全站名次比较；个人用量始终来自真实记录。' : '';
  $('rules-retention').textContent = simulated ? '真实用量基于主站现存记录，模拟数据为管理员发布的当日快照。' : '所有周期均基于主站现存用量记录。累计不代表已经清理的历史数据；主站清理记录后，相关统计会相应变化。';
  const total = compact(data.summary.tokens);
  $('total-tokens').textContent = total.value;
  $('total-tokens-unit').textContent = total.unit;
  $('total-requests').textContent = number(data.summary.requests);
  for (const [id, key] of [['total-tokens-delta', 'tokens'], ['total-requests-delta', 'requests']]) delta(id, data.summary.deltas?.[key]);
  $('date-range').textContent = rangeText(data);
  $('ranking-period').textContent = data.period === 'all' ? '现存记录累计' : `${PERIODS[data.period]}排名`;
  $('personal-period').textContent = PERIODS[data.period];
  $('table-caption').textContent = `${PERIODS[data.period]}按${METRICS[data.metric].label}排序的前十位用户`;
  $('updated-at').textContent = '更新于 ' + new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(data.generatedAt));
  const limited = data.window.retainedFrom && data.window.start && new Date(data.window.retainedFrom) > new Date(data.window.start);
  $('coverage-note').textContent = data.period === 'all'
    ? '仅累计主站现存记录，已清理的历史用量不计入。'
    : limited ? `当前记录最早始于 ${localDate(data.window.retainedFrom)}，仅统计仍保留的用量。` : '统计基于主站现存用量记录。';
  if (simulated) $('coverage-note').textContent = `真实 ${data.display.realCount} 位 · 示例 ${data.display.simulatedCount} 位。示例为 ${data.display.date} 的固定快照，汇总仅含当前榜单，个人用量为实际记录。`;
  else if (scoped) $('coverage-note').textContent = '按所设 Token 下限优先展示真实用户，再按当前指标排序；汇总仅含当前榜单，个人用量为实际记录。';
}

function renderPodium(data) {
  const labels = ['first', 'second', 'third'];
  $('podium').hidden = data.entries.length === 0;
  $('podium').innerHTML = data.entries.slice(0, 3).map((user, index) => {
    const value = display(user[data.metric]);
    const bottom = user.growth != null ? icon(user.growth < 0 ? 'trending-down' : 'trending-up') + `较上期 ${user.growth > 0 ? '+' : ''}${user.growth}%` : icon('sparkles') + '持续创造，保持热爱';
    return `<button class="podium-card ${labels[index]}" type="button" data-user-key="${user.key}" aria-label="查看第 ${user.rank} 名 ${escapeHtml(user.name)} 的用量详情">
      ${index === 0 ? `<span class="podium-kicker">${icon('crown')}${user.rank === 1 ? '用量之星' : PERIODS[data.period] + '榜首'}</span>` : ''}
      <span class="podium-avatar">${window.UsageAvatars.html(user, 50)}<span class="medal">${user.rank}</span></span>
      <span class="podium-name" title="${escapeHtml(user.name)}"><span>${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}${user.source === 'simulation' ? '<span class="example-tag">示例</span>' : ''}</span>
      <span class="podium-model">${number(user.requests)} 次探索</span>
      <span class="podium-amount"><strong class="${value.value.length > 9 ? 'long-amount' : ''}">${value.value}</strong><span>${value.unit}</span></span><span class="podium-unit">${METRICS[data.metric].unit}</span>
      <span class="podium-bottom">${bottom}</span></button>`;
  }).join('');
}

function renderTable(data) {
  const metrics = [data.metric, ...Object.keys(METRICS).filter((metric) => metric !== data.metric)];
  ['tokens-heading', 'requests-heading'].forEach((id, index) => {
    $(id).innerHTML = METRICS[metrics[index]].label + (index === 0 ? ' ' + icon('arrow-down') : '');
    $(id).setAttribute('aria-sort', index === 0 ? 'descending' : 'none');
  });
  const maximum = data.entries[0]?.[data.metric] || 1;
  $('empty-ranking').hidden = data.entries.length !== 0;
  $('ranking-body').innerHTML = data.entries.map((user, index) => {
    const rank = index < 3 ? `<span class="table-medal ${index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}" aria-label="第 ${user.rank} 名">${icon('medal')}<span class="sr-only">${user.rank}</span></span>` : String(user.rank).padStart(2, '0');
    const cells = metrics.map((metric, column) => {
      const value = display(user[metric], metric);
      return `<td class="numeric-cell ${column === 0 ? 'primary-cell' : 'secondary-cell'}" title="${number(user[metric])}">${column === 0 ? `<span class="usage-cell"><span>${value.value}<span class="value-unit">${value.unit}</span></span><span class="usage-track"><span style="width:${Math.max(0, Math.min(100, user[metric] / maximum * 100))}%"></span></span></span>` : value.value + (value.unit ? ' ' + value.unit : '')}</td>`;
    }).join('');
    return `<tr data-ranking-user="${user.key}" ${user.key === data.me.key ? 'class="is-me"' : ''}><td class="rank-cell">${rank}</td>
      <td><div class="rank-user">${window.UsageAvatars.html(user, 31)}<div class="user-copy"><span class="user-name"><span title="${escapeHtml(user.name)}">${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}${user.source === 'simulation' ? '<span class="example-tag">示例</span>' : ''}</span><span class="user-model">${number(user.requests)} 次调用</span></div></div></td>
      ${cells}<td class="change-cell">${changeHtml(user)}</td><td class="action-column"><button class="row-detail" type="button" data-user-key="${user.key}" aria-label="查看${escapeHtml(user.name)}的用量详情" title="查看用量详情">${icon('chevron-right')}</button></td></tr>`;
  }).join('');
}

function renderPersonal(data) {
  const me = data.me;
  const rankingAvailable = me.rankingAvailable !== false;
  $('personal-title').textContent = rankingAvailable ? '我的排名' : '我的实际用量';
  $('personal-ranking').hidden = !rankingAvailable;
  $('personal-next').hidden = !rankingAvailable;
  $('locate-me').hidden = !rankingAvailable;
  renderIdentity(me);
  $('my-rank').textContent = me.rank ? String(me.rank).padStart(2, '0') : '—';
  $('my-rank').classList.toggle('long-rank', me.rank >= 1000);
  $('my-percentile').textContent = me.rank ? `超过 ${me.percentile}% 的创造者` : me.eligible ? '本期还没有用量记录' : '此账号不参与排行';
  $('my-change').classList.toggle('down', me.change < 0);
  $('my-change').innerHTML = !me.rank ? icon('sprout') + '每一次探索，都是新的开始' : !me.comparisonAvailable ? icon('sparkles') + '保持热爱，持续创造' : me.newEntry ? icon('sparkles') + '本期新上榜' : me.change == null ? icon('sprout') + '本期开始活跃' : me.change === 0 ? icon('minus') + '与上期排名持平' : icon(me.change > 0 ? 'move-up' : 'move-down') + `较上期${me.change > 0 ? '上升' : '下降'} ${Math.abs(me.change)} 位`;
  $('my-primary-label').textContent = METRICS[data.metric].label;
  $('my-primary-value').innerHTML = displayHtml(me[data.metric], data.metric);
  const secondary = data.metric === 'requests' ? 'tokens' : 'requests';
  $('my-secondary-label').textContent = METRICS[secondary].label;
  $('my-secondary-value').innerHTML = displayHtml(me[secondary], secondary);
  $('next-rank-label').textContent = me.next ? `距离第 ${me.next.rank} 名` : me.rank === 1 ? '你已位居榜首' : '每一份用量，都有意义';
  $('next-rank-gap').textContent = me.next ? Object.values(display(me.next.gap, data.metric)).join(' ').trim() : me.rank === 1 ? 'TOP 01' : '—';
  $('next-rank-progress').style.width = me.next ? `${me.next.progress}%` : me.rank === 1 ? '100%' : '0%';
  $('next-rank-copy').textContent = me.next ? '再向前一点，就能遇见新的风景。' : '保持热爱，让好想法继续发生。';
  $('locate-me').innerHTML = data.entries.some((entry) => entry.key === me.key)
    ? icon('locate-fixed') + '找到我的位置' + icon('arrow-right') : icon('activity') + '查看我的用量' + icon('arrow-right');
}

function renderChart(me) {
  const peak = Math.max(1, ...me.trend.map((day) => day.tokens));
  $('weekly-total').innerHTML = displayHtml(me.trendTotal, 'tokens').replaceAll('small', 'span');
  delta('trend-delta', me.trendGrowth);
  $('trend-delta').title = '较此前 7 天同期';
  $('usage-chart').innerHTML = me.trend.map((day, index) => `<span class="chart-bar ${index === 6 ? 'latest' : ''}" tabindex="0" style="--bar-height:${Math.max(0, day.tokens / peak * 90)}%" aria-label="${day.date.slice(5).replace('-', '/')}：${number(day.tokens)} Tokens"></span>`).join('');
  $('usage-chart').setAttribute('aria-label', me.trend.map((day) => `${day.date}：${number(day.tokens)} Tokens`).join('；'));
  $('chart-labels').innerHTML = [0, 3, 6].map((index) => `<span>${me.trend[index].date.slice(5).replace('-', '/')}</span>`).join('');
}

function renderModels(me) {
  $('model-basis').textContent = me.modelMetric === 'tokens' ? '按 Token' : '按调用';
  $('model-distribution').hidden = me.models.length === 0;
  $('model-empty').hidden = me.models.length !== 0;
  $('model-distribution').setAttribute('aria-label', me.models.map((model) => `${model.name} ${model.percent.toFixed(1)}%`).join('，'));
  $('model-distribution').innerHTML = me.models.map((model, index) => `<span class="model-segment model-color-${index}" style="width:${model.percent}%"></span>`).join('');
  $('model-legend').innerHTML = me.models.map((model, index) => `<li><span class="model-dot model-color-${index}"></span><span class="model-name" title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</span><strong>${model.percent.toFixed(1)}%</strong></li>`).join('');
}

function render(data) {
  document.body.dataset.metric = data.metric;
  renderStats(data); renderPodium(data); renderTable(data); renderPersonal(data); renderChart(data.me); renderModels(data.me);
  $('page-status').hidden = true;
  $('usage-content').hidden = false;
  $('usage-content').setAttribute('aria-busy', 'false');
  hydrateIcons();
}

async function loadBoard({ announce = false } = {}) {
  const sequence = ++state.sequence;
  state.controller?.abort();
  state.controller = new AbortController();
  state.data = null;
  document.querySelectorAll('[data-period]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.period === state.period)));
  showStatus('正在获取用量排行');
  $('usage-content').setAttribute('aria-busy', 'true');
  $('refresh-button').disabled = true;
  try {
    const data = await api(`leaderboard?${new URLSearchParams({ period: state.period, metric: state.metric })}`,
      { signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(60000)]) });
    if (sequence !== state.sequence) return;
    state.data = data;
    render(data);
    if (announce) toast('榜单已更新');
  } catch (error) {
    if (sequence !== state.sequence) return;
    const login = [401, 403].includes(error.status);
    showStatus(login ? error.message : error.name === 'TimeoutError' ? '统计暂时超时，请稍后重试' : error.message || '暂时无法获取用量，请稍后重试', { error: true, login });
  } finally {
    if (sequence === state.sequence) $('refresh-button').disabled = false;
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').querySelector('span').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function showUser(key) {
  const data = state.data;
  if (!data) return;
  const user = data.entries.find((entry) => entry.key === key) || (key === data.me.key ? data.me : null);
  if (!user) return;
  $('detail-period').textContent = PERIODS[data.period] + '用量';
  window.UsageAvatars.set($('detail-avatar'), user);
  hydrateIcons();
  $('user-dialog-title').textContent = user.name;
  $('detail-rank').textContent = (user.source === 'simulation' ? '示例数据 · ' : '') + (user.rank ? `${PERIODS[data.period]}排名 #${user.rank} · ${METRICS[data.metric].label}` : '个人实际用量');
  $('detail-range').textContent = user.source === 'simulation' ? `模拟快照 ${data.display.date}` : rangeText(data);
  $('detail-stats').innerHTML = Object.keys(METRICS).map((metric) => `<div><dt>${METRICS[metric].label}</dt><dd>${displayHtml(user[metric], metric)}</dd></div>`).join('');
  $('user-dialog').showModal();
}

document.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
  if (state.period === button.dataset.period) return;
  state.period = button.dataset.period; loadBoard();
}));
$('metric-select').addEventListener('change', (event) => { state.metric = event.target.value; loadBoard(); });
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
}));
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-user-key]');
  if (button) showUser(button.dataset.userKey);
});
$('locate-me').addEventListener('click', () => {
  if (!state.data) return;
  const row = document.querySelector(`[data-ranking-user="${state.data.me.key}"]`);
  if (!row) return showUser(state.data.me.key);
  row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  row.querySelector('button').focus({ preventScroll: true });
  row.classList.remove('located');
  requestAnimationFrame(() => row.classList.add('located'));
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => row.classList.remove('located'), 1800);
});
$('refresh-button').addEventListener('click', () => loadBoard({ announce: true }));
$('retry-button').addEventListener('click', () => initialize());
async function updateNavigation() {
  const settings = location.hash === '#settings';
  $('main').hidden = settings;
  $('admin-page').hidden = !settings;
  document.querySelector('.skip-link').href = settings ? '#admin-page' : '#main';
  if (settings) {
    state.controller?.abort(); state.sequence++;
    if (state.authenticated && state.canManage) await window.UsageAdmin.show();
    else {
      $('admin-loading').hidden = false;
      $('admin-loading').textContent = state.authenticated ? '该页面仅主站管理员可见' : '请先登录主站管理员账号后打开排行设置';
    }
  } else {
    window.UsageAdmin.hide();
    if (state.authenticated && !state.data) await loadBoard();
  }
}
window.addEventListener('hashchange', updateNavigation);

async function initialize() {
  showStatus('正在获取用量排行');
  try {
    state.config = await api('auth/config');
    $('login-link').href = state.config.sub2apiUrl;
    $('rules-timezone').textContent = `今日从 00:00、本周从周一、本月从 1 日开始。统计时区：${state.config.timezone}。`;
    $('rules-participants').textContent = `仅统计当前可用的账号，已停用或删除的账号不参与。${state.config.includeAdmins ? '管理员也参与排名。' : '管理员不参与排名。'}`;
    if (!state.session) {
      try { state.session = sessionStorage.getItem('usage-leaderboard.session') || ''; } catch {}
    }
    let session;
    if (upstreamToken) {
      saveSession('');
      session = await api('auth/sso', { method: 'POST', headers: { authorization: `Bearer ${upstreamToken}` }, body: '{}' });
      upstreamToken = '';
    } else session = await api('auth/me');
    saveSession(session.sessionToken);
    state.authenticated = true;
    state.canManage = session.capabilities?.manageLeaderboard === true;
    state.csrf = session.csrfToken || '';
    $('settings-link').hidden = !state.canManage;
    if (!state.canManage) window.UsageAdmin.clear();
    renderIdentity(session.user);
    enableFilters(true);
    await updateNavigation();
  } catch (error) {
    const login = [401, 403].includes(error.status);
    showStatus(login ? '请登录主站后打开用量排行' : error.message || '暂时无法连接用量服务', { error: true, login });
  }
  hydrateIcons();
}

window.UsageAdmin.configure({ api, notify: toast, onChanged() { state.data = null; }, onDenied(error) {
  state.canManage = false; $('settings-link').hidden = true;
  $('admin-loading').hidden = false; $('admin-loading').textContent = error.message;
  if (error.status === 401) { showStatus('请重新登录主站后打开用量排行', { login: true, error: true }); location.hash = '#leaderboard'; }
} });
enableFilters(false); hydrateIcons(); updateNavigation(); initialize();
