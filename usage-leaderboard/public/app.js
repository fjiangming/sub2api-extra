'use strict';

const PERIODS = { today: '今日', week: '本周', month: '本月', all: '累计' };
const $ = (id) => document.getElementById(id);
const state = { period: 'today', data: null, boards: new Map(), session: '', config: null, controller: null, sequence: 0,
  authenticated: false, loading: false, pageActive: true, failures: 0 };
const query = new URLSearchParams(location.search);
let upstreamToken = query.get('token') || query.get('access_token') || '';
for (const key of ['token', 'access_token', 'user_id', 'src_host', 'src_url']) query.delete(key);
history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
let toastTimer;
let refreshTimer;

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
function displayHtml(value) {
  const formatted = compact(value);
  return `${formatted.value}${formatted.unit ? ` <small>${formatted.unit}</small>` : ''}`;
}
function saveSession(token) {
  if (state.session !== token) { state.boards.clear(); state.data = null; }
  state.session = token;
  try {
    if (token) sessionStorage.setItem('usage-leaderboard.session', token);
    else sessionStorage.removeItem('usage-leaderboard.session');
  } catch { /* Cookies and the in-memory token also support restricted iframes. */ }
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(state.session ? { authorization: `Session ${state.session}` } : {}), ...options.headers };
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method)) headers['content-type'] = 'application/json';
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
    clearTimeout(refreshTimer);
    saveSession('');
    $('signed-in').hidden = true;
    enableFilters(false);
  }
}

function enableFilters(enabled) {
  document.querySelectorAll('[data-period]').forEach((control) => { control.disabled = !enabled; });
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
function renderBoardInfo(data) {
  $('date-range').textContent = rangeText(data);
  $('ranking-period').textContent = data.period === 'all' ? '现存记录累计' : `${PERIODS[data.period]}排名`;
  $('personal-period').textContent = PERIODS[data.period];
  $('table-caption').textContent = `${PERIODS[data.period]}按 Token 用量排序的前十位用户`;
  $('updated-at').textContent = '更新于 ' + new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(data.generatedAt));
}

function renderPodium(data) {
  const labels = ['first', 'second', 'third'];
  $('podium').hidden = data.entries.length === 0;
  $('podium').innerHTML = data.entries.slice(0, 3).map((user, index) => {
    const value = compact(user.tokens);
    const bottom = user.growth != null ? icon(user.growth < 0 ? 'trending-down' : 'trending-up') + `较上期 ${user.growth > 0 ? '+' : ''}${user.growth}%` : icon('sparkles') + '持续创造，保持热爱';
    return `<article class="podium-card ${labels[index]}" aria-label="第 ${user.rank} 名 ${escapeHtml(user.name)}">
      ${index === 0 ? `<span class="podium-kicker">${icon('crown')}${user.rank === 1 ? '用量之星' : PERIODS[data.period] + '榜首'}</span>` : ''}
      <span class="podium-avatar">${window.UsageAvatars.html(user, 50)}<span class="medal">${user.rank}</span></span>
      <span class="podium-name" title="${escapeHtml(user.name)}"><span>${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}</span>
      <span class="podium-amount"><strong class="${value.value.length > 9 ? 'long-amount' : ''}">${value.value}</strong><span>${value.unit}</span></span><span class="podium-unit">Tokens</span>
      <span class="podium-bottom">${bottom}</span></article>`;
  }).join('');
}

function renderTable(data) {
  const maximum = data.entries[0]?.tokens || 1;
  $('empty-ranking').hidden = data.entries.length !== 0;
  $('ranking-body').innerHTML = data.entries.map((user, index) => {
    const rank = index < 3 ? `<span class="table-medal ${index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}" aria-label="第 ${user.rank} 名">${icon('medal')}<span class="sr-only">${user.rank}</span></span>` : String(user.rank).padStart(2, '0');
    const value = compact(user.tokens);
    const cell = `<td class="numeric-cell primary-cell" title="${number(user.tokens)}"><span class="usage-cell"><span>${value.value}<span class="value-unit">${value.unit}</span></span><span class="usage-track"><span style="width:${Math.max(0, Math.min(100, user.tokens / maximum * 100))}%"></span></span></span></td>`;
    return `<tr${user.key === data.me.key ? ' class="is-me"' : ''}><td class="rank-cell">${rank}</td>
      <td><div class="rank-user">${window.UsageAvatars.html(user, 31)}<div class="user-copy"><span class="user-name"><span title="${escapeHtml(user.name)}">${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}</span></div></div></td>
      ${cell}</tr>`;
  }).join('');
}

function renderPersonal(data) {
  const me = data.me;
  $('personal-title').textContent = '我的实际用量';
  renderIdentity(me);
  $('my-primary-value').innerHTML = displayHtml(me.tokens);
}

function renderChart(me) {
  const peak = Math.max(1, ...me.trend.map((day) => day.tokens));
  $('weekly-total').innerHTML = displayHtml(me.trendTotal).replaceAll('small', 'span');
  delta('trend-delta', me.trendGrowth);
  $('trend-delta').title = '较此前 7 天同期';
  $('usage-chart').innerHTML = me.trend.map((day, index) => `<span class="chart-bar ${index === 6 ? 'latest' : ''}" tabindex="0" style="--bar-height:${Math.max(0, day.tokens / peak * 90)}%" aria-label="${day.date.slice(5).replace('-', '/')}：${number(day.tokens)} Tokens"></span>`).join('');
  $('usage-chart').setAttribute('aria-label', me.trend.map((day) => `${day.date}：${number(day.tokens)} Tokens`).join('；'));
  $('chart-labels').innerHTML = [0, 3, 6].map((index) => `<span>${me.trend[index].date.slice(5).replace('-', '/')}</span>`).join('');
}

function renderModels(me) {
  const total = me.models.reduce((sum, model) => sum + model.tokens, 0);
  const models = me.models.filter((model) => model.tokens > 0).map((model) => ({ ...model, percent: model.tokens / total * 100 }));
  $('model-basis').textContent = '按 Token';
  $('model-distribution').hidden = models.length === 0;
  $('model-empty').hidden = models.length !== 0;
  $('model-distribution').setAttribute('aria-label', models.map((model) => `${model.name} ${model.percent.toFixed(1)}%`).join('，'));
  $('model-distribution').innerHTML = models.map((model, index) => `<span class="model-segment model-color-${index}" style="width:${model.percent}%"></span>`).join('');
  $('model-legend').innerHTML = models.map((model, index) => `<li><span class="model-dot model-color-${index}"></span><span class="model-name" title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</span><strong>${model.percent.toFixed(1)}%</strong></li>`).join('');
}

function render(data) {
  renderBoardInfo(data); renderPodium(data); renderTable(data); renderPersonal(data); renderChart(data.me); renderModels(data.me);
  $('page-status').hidden = true;
  $('usage-content').hidden = false;
  $('usage-content').setAttribute('aria-busy', 'false');
  hydrateIcons();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!state.authenticated || !state.pageActive || document.hidden || !navigator.onLine) return;
  refreshTimer = setTimeout(() => loadBoard({ background: true }), Math.min(300000, 60000 * 2 ** Math.min(state.failures, 3)));
}

async function loadBoard({ announce = false, background = false } = {}) {
  if (background && (state.loading || document.querySelector('dialog[open]'))) { scheduleRefresh(); return; }
  clearTimeout(refreshTimer);
  const sequence = ++state.sequence;
  state.controller?.abort();
  state.controller = new AbortController();
  state.loading = true;
  const previous = state.data;
  const cached = state.boards.get(state.period);
  const retain = previous?.period === state.period ? previous
    : cached && Date.now() - cached.receivedAt < 300000 && cached.day === localDate(Date.now()) ? cached.data : null;
  state.data = retain;
  document.querySelectorAll('[data-period]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.period === state.period)));
  if (retain) {
    if (retain !== previous || $('usage-content').hidden) render(retain);
  } else showStatus('正在获取用量排行');
  $('usage-content').setAttribute('aria-busy', 'true');
  $('refresh-button').disabled = true;
  try {
    const data = await api(`leaderboard?${new URLSearchParams({ period: state.period, metric: 'tokens' })}`,
      { signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(60000)]) });
    if (sequence !== state.sequence) return;
    state.data = data;
    state.boards.set(data.period, { data, receivedAt: Date.now(), day: localDate(Date.now()) });
    state.failures = 0;
    render(data);
    if (announce) toast('榜单已更新');
  } catch (error) {
    if (sequence !== state.sequence) return;
    state.failures++;
    const login = [401, 403].includes(error.status);
    if (!retain || login) showStatus(login ? error.message : error.name === 'TimeoutError' ? '统计暂时超时，请稍后重试' : error.message || '暂时无法获取用量，请稍后重试', { error: true, login });
    else if (state.failures === 1) toast('暂时无法更新，稍后自动重试');
  } finally {
    if (sequence === state.sequence) {
      state.loading = false;
      $('usage-content').setAttribute('aria-busy', 'false');
      $('refresh-button').disabled = false;
      scheduleRefresh();
    }
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').querySelector('span').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
document.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
  if (state.period === button.dataset.period) return;
  state.period = button.dataset.period; loadBoard();
}));
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
}));
$('refresh-button').addEventListener('click', () => loadBoard({ announce: true }));
$('retry-button').addEventListener('click', () => initialize());
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer);
  if (!document.hidden && state.authenticated && state.pageActive && navigator.onLine) loadBoard({ background: true });
});
window.addEventListener('offline', () => clearTimeout(refreshTimer));
window.addEventListener('online', () => { if (state.authenticated && !document.hidden && state.pageActive) loadBoard({ background: true }); });
window.addEventListener('pagehide', () => {
  state.pageActive = false; clearTimeout(refreshTimer); state.controller?.abort(); state.sequence++; state.loading = false;
});
window.addEventListener('pageshow', () => {
  state.pageActive = true;
  if (state.authenticated && !document.hidden && navigator.onLine) loadBoard({ background: true });
});
async function initialize() {
  clearTimeout(refreshTimer);
  state.authenticated = false;
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
    renderIdentity(session.user);
    enableFilters(true);
    await loadBoard();
  } catch (error) {
    const login = [401, 403].includes(error.status);
    showStatus(login ? '请登录主站后打开用量排行' : error.message || '暂时无法连接用量服务', { error: true, login });
  }
  hydrateIcons();
}

enableFilters(false); hydrateIcons(); initialize();
