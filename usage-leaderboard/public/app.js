'use strict';

const PERIODS = { today: '今日', week: '本周', month: '本月', all: '累计' };
const $ = (id) => document.getElementById(id);
const state = { period: 'today', data: null, session: '', config: null, controller: null, sequence: 0,
  authenticated: false, loading: false, pageActive: true, failures: 0 };
const query = new URLSearchParams(location.search);
let upstreamToken = query.get('token') || query.get('access_token') || '';
for (const key of ['token', 'access_token', 'user_id', 'src_host', 'src_url']) query.delete(key);
history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
let toastTimer;
let locateTimer;
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
function changeHtml(user) {
  if (!user.comparisonAvailable) return '<span class="rank-same" aria-label="暂无可比较的排名">—</span>';
  if (user.newEntry) return '<span class="rank-new" aria-label="本期新上榜">新</span>';
  if (user.change === 0 || user.change == null) return '<span class="rank-same" aria-label="排名未变化">—</span>';
  return `<span class="${user.change > 0 ? 'rank-up' : 'rank-down'}" aria-label="${user.change > 0 ? '上升' : '下降'} ${Math.abs(user.change)} 位">${icon(user.change > 0 ? 'arrow-up' : 'arrow-down')}${Math.abs(user.change)}</span>`;
}

function renderStats(data) {
  const simulated = data.display.simulatedCount > 0;
  const scoped = data.display.mode !== 'real';
  const bounded = data.display.rangeApplied === true;
  $('tokens-summary-label').textContent = scoped ? '榜单 Token 用量' : '全站 Token 用量';
  document.querySelector('.station-stats').setAttribute('aria-label', scoped ? '当前榜单用量汇总' : '全站用量概览');
  $('board-source-note').textContent = simulated ? '含示例数据 · 真实用户优先' : scoped ? '真实用户优先 · 按用量下限筛选' : '每一次探索，都值得被看见';
  $('rules-source').hidden = !scoped;
  $('rules-source').textContent = simulated ? `当前榜单含 ${data.display.simulatedCount} 位模拟用户，以“示例”标识；真实用户按设置的用量下限优先展示。汇总仅计当前榜单，个人用量始终来自主站真实记录。模拟快照日期：${data.display.date}。` : scoped ? '当前按 Token 下限筛选真实用户，再按 Token 用量展示前十位。汇总仅计当前榜单，不与全站名次比较；个人用量始终来自真实记录。' : '';
  if (bounded) {
    $('board-source-note').textContent = simulated ? '含示例数据 · 按用量混排' : '真实用量 · 按下限筛选';
    $('rules-source').textContent = `优先纳入达到 Token 下限的真实用户，不足十位时用带“示例”标识的模拟用户补齐。任何真实用户的 Token 用量超过榜尾时均可入榜，不受 Token 下限排除；真实用量不受上限限制。最终按 Token 用量排名，同值并列，最多展示十位。汇总仅计当前榜单，个人用量始终来自真实记录。${data.display.dynamic ? '统计日期' : '快照日期'}：${data.display.date}。`;
  }
  $('rules-retention').textContent = simulated ? data.display.dynamic
    ? '真实用量基于主站现存记录；示例用量随时间增长，四个周期共享同一组示例历史，达到范围上限后更换示例身份。'
    : '真实用量基于主站现存记录，模拟数据为管理员发布的当日快照。' : '所有周期均基于主站现存用量记录。累计不代表已经清理的历史数据；主站清理记录后，相关统计会相应变化。';
  const total = compact(data.summary.tokens);
  $('total-tokens').textContent = total.value;
  $('total-tokens-unit').textContent = total.unit;
  delta('total-tokens-delta', data.summary.deltas?.tokens);
  $('date-range').textContent = rangeText(data);
  $('ranking-period').textContent = data.period === 'all' ? '现存记录累计' : `${PERIODS[data.period]}排名`;
  $('personal-period').textContent = PERIODS[data.period];
  $('table-caption').textContent = `${PERIODS[data.period]}按 Token 用量排序的前十位用户`;
  $('updated-at').textContent = (simulated ? data.display.dynamic ? '示例更新于 ' : '示例快照 ' : '更新于 ') + new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(simulated ? data.display.snapshotAt : data.generatedAt));
  const limited = data.window.retainedFrom && data.window.start && new Date(data.window.retainedFrom) > new Date(data.window.start);
  $('coverage-note').textContent = data.period === 'all'
    ? '仅累计主站现存记录，已清理的历史用量不计入。'
    : limited ? `当前记录最早始于 ${localDate(data.window.retainedFrom)}，仅统计仍保留的用量。` : '统计基于主站现存用量记录。';
  if (simulated) $('coverage-note').textContent = `真实 ${data.display.realCount} 位 · 示例 ${data.display.simulatedCount} 位。${data.display.dynamic ? '示例用量随时间自动更新' : `示例为 ${data.display.date} 的固定快照`}，汇总仅含当前榜单，个人用量为实际记录。`;
  else if (scoped) $('coverage-note').textContent = '按所设 Token 下限优先展示真实用户，再按 Token 用量排序；汇总仅含当前榜单，个人用量为实际记录。';
  if (bounded && !simulated) $('coverage-note').textContent = `真实 ${data.display.realCount} 位。按所设 Token 下限筛选，真实用户不受上限限制；按 Token 用量排序，汇总仅含当前榜单，个人用量为实际记录。`;
}

function renderPodium(data) {
  const labels = ['first', 'second', 'third'];
  $('podium').hidden = data.entries.length === 0;
  $('podium').innerHTML = data.entries.slice(0, 3).map((user, index) => {
    const value = compact(user.tokens);
    const bottom = user.growth != null ? icon(user.growth < 0 ? 'trending-down' : 'trending-up') + `较上期 ${user.growth > 0 ? '+' : ''}${user.growth}%` : icon('sparkles') + '持续创造，保持热爱';
    return `<button class="podium-card ${labels[index]}" type="button" data-user-key="${user.key}" aria-label="查看第 ${user.rank} 名 ${escapeHtml(user.name)} 的用量详情">
      ${index === 0 ? `<span class="podium-kicker">${icon('crown')}${user.rank === 1 ? '用量之星' : PERIODS[data.period] + '榜首'}</span>` : ''}
      <span class="podium-avatar">${window.UsageAvatars.html(user, 50)}<span class="medal">${user.rank}</span></span>
      <span class="podium-name" title="${escapeHtml(user.name)}"><span>${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}${user.source === 'simulation' ? '<span class="example-tag">示例</span>' : ''}</span>
      <span class="podium-amount"><strong class="${value.value.length > 9 ? 'long-amount' : ''}">${value.value}</strong><span>${value.unit}</span></span><span class="podium-unit">Tokens</span>
      <span class="podium-bottom">${bottom}</span></button>`;
  }).join('');
}

function renderTable(data) {
  const maximum = data.entries[0]?.tokens || 1;
  $('empty-ranking').hidden = data.entries.length !== 0;
  $('ranking-body').innerHTML = data.entries.map((user, index) => {
    const rank = index < 3 ? `<span class="table-medal ${index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}" aria-label="第 ${user.rank} 名">${icon('medal')}<span class="sr-only">${user.rank}</span></span>` : String(user.rank).padStart(2, '0');
    const value = compact(user.tokens);
    const cell = `<td class="numeric-cell primary-cell" title="${number(user.tokens)}"><span class="usage-cell"><span>${value.value}<span class="value-unit">${value.unit}</span></span><span class="usage-track"><span style="width:${Math.max(0, Math.min(100, user.tokens / maximum * 100))}%"></span></span></span></td>`;
    return `<tr data-ranking-user="${user.key}" ${user.key === data.me.key ? 'class="is-me"' : ''}><td class="rank-cell">${rank}</td>
      <td><div class="rank-user">${window.UsageAvatars.html(user, 31)}<div class="user-copy"><span class="user-name"><span title="${escapeHtml(user.name)}">${escapeHtml(user.name)}</span>${user.key === data.me.key ? '<span class="you-label">你</span>' : ''}${user.source === 'simulation' ? '<span class="example-tag">示例</span>' : ''}</span></div></div></td>
      ${cell}<td class="change-cell">${changeHtml(user)}</td><td class="action-column"><button class="row-detail" type="button" data-user-key="${user.key}" aria-label="查看${escapeHtml(user.name)}的用量详情" title="查看用量详情">${icon('chevron-right')}</button></td></tr>`;
  }).join('');
}

function renderPersonal(data) {
  const me = data.me;
  const rankingAvailable = me.rankingAvailable !== false;
  const boardOnly = !rankingAvailable && me.boardRank != null;
  const shownRank = boardOnly ? me.boardRank : me.rank;
  $('personal-title').textContent = rankingAvailable ? '我的排名' : boardOnly ? '我的榜内排名' : '我的实际用量';
  $('personal-ranking').hidden = !rankingAvailable && !boardOnly;
  $('personal-next').hidden = !rankingAvailable;
  $('locate-me').hidden = !rankingAvailable && !boardOnly;
  renderIdentity(me);
  $('my-rank').textContent = shownRank ? String(shownRank).padStart(2, '0') : '—';
  $('my-rank').classList.toggle('long-rank', shownRank >= 1000);
  $('my-percentile').textContent = boardOnly ? '当前展示榜单' : me.rank ? `超过 ${me.percentile}% 的创造者` : me.eligible ? '本期还没有用量记录' : '此账号不参与排行';
  $('my-change').hidden = boardOnly;
  $('my-change').classList.toggle('down', me.change < 0);
  $('my-change').innerHTML = !me.rank ? icon('sprout') + '每一次探索，都是新的开始' : !me.comparisonAvailable ? icon('sparkles') + '保持热爱，持续创造' : me.newEntry ? icon('sparkles') + '本期新上榜' : me.change == null ? icon('sprout') + '本期开始活跃' : me.change === 0 ? icon('minus') + '与上期排名持平' : icon(me.change > 0 ? 'move-up' : 'move-down') + `较上期${me.change > 0 ? '上升' : '下降'} ${Math.abs(me.change)} 位`;
  $('my-primary-value').innerHTML = displayHtml(me.tokens);
  $('next-rank-label').textContent = me.next ? `距离第 ${me.next.rank} 名` : me.rank === 1 ? '你已位居榜首' : '每一份用量，都有意义';
  $('next-rank-gap').textContent = me.next ? Object.values(compact(me.next.gap)).join(' ').trim() : me.rank === 1 ? 'TOP 01' : '—';
  $('next-rank-progress').style.width = me.next ? `${me.next.progress}%` : me.rank === 1 ? '100%' : '0%';
  $('next-rank-copy').textContent = me.next ? '再向前一点，就能遇见新的风景。' : '保持热爱，让好想法继续发生。';
  $('locate-me').innerHTML = data.entries.some((entry) => entry.key === me.key)
    ? icon('locate-fixed') + '找到我的位置' + icon('arrow-right') : icon('activity') + '查看我的用量' + icon('arrow-right');
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
  renderStats(data); renderPodium(data); renderTable(data); renderPersonal(data); renderChart(data.me); renderModels(data.me);
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
  const retain = background && state.data;
  if (!retain) state.data = null;
  document.querySelectorAll('[data-period]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.period === state.period)));
  if (!retain) showStatus('正在获取用量排行');
  $('usage-content').setAttribute('aria-busy', 'true');
  $('refresh-button').disabled = true;
  try {
    const data = await api(`leaderboard?${new URLSearchParams({ period: state.period, metric: 'tokens' })}`,
      { signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(60000)]) });
    if (sequence !== state.sequence) return;
    state.data = data;
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
function showUser(key) {
  const data = state.data;
  if (!data) return;
  const user = data.entries.find((entry) => entry.key === key) || (key === data.me.key ? data.me : null);
  if (!user) return;
  $('detail-period').textContent = PERIODS[data.period] + '用量';
  window.UsageAvatars.set($('detail-avatar'), user);
  hydrateIcons();
  $('user-dialog-title').textContent = user.name;
  const shownRank = user.boardRank ?? user.rank;
  $('detail-rank').textContent = (user.source === 'simulation' ? '示例数据 · ' : '') + (shownRank ? `${PERIODS[data.period]}排名 #${shownRank} · Token 用量` : '个人实际用量');
  $('detail-range').textContent = user.source === 'simulation' ? `${data.display.dynamic ? '动态示例' : '模拟快照'} ${data.display.date}` : rangeText(data);
  $('detail-stats').innerHTML = `<div><dt>Token 用量</dt><dd>${displayHtml(user.tokens)}</dd></div>`;
  $('user-dialog').showModal();
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
