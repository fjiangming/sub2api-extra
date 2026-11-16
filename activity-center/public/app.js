'use strict';

const $ = id => document.getElementById(id);
const state = { session: '', csrf: '', user: null, config: null, summary: null, prizes: [], busy: false, rotation: 0,
  page: 1, mySequence: 0, admin: false, ledgerPage: 1, ledgerSequence: 0, batch: null, pending: null, polling: false };
const query = new URLSearchParams(location.search);
let upstreamToken = query.get('token') || query.get('access_token') || '';
for (const key of ['token','access_token','user_id','src_host','src_url']) query.delete(key);
history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : ''));
const money = cents => '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
const statusText = status => ({ paid: '已入账', pending: '待入账', failed: '入账异常' })[status] || '待核验';
const statusHtml = status => `<span class="${['paid','pending','failed'].includes(status) ? status : ''}">${statusText(status)}</span>`;
function storage(key, value) {
  try { if (value === undefined) return sessionStorage.getItem(key); if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); }
  catch { /* Session cookies and in-memory recovery remain available. */ }
}
function time(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: state.config.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
function errorBox(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function controls() {
  document.querySelectorAll('[data-count]').forEach(button => {
    button.disabled = !state.summary?.enabled || state.busy || Boolean(state.pending) || Number(button.dataset.count) > (state.summary?.available || 0);
  });
  $('recover-draw').hidden = !state.pending;
  $('recover-draw').disabled = state.busy;
}
function signedOut(message) {
  state.user = null; state.csrf = ''; state.session = ''; state.pending = null; state.admin = false; state.summary = null;
  state.mySequence++; state.ledgerSequence++;
  storage('activity-center.session', null);
  $('activity-view').hidden = true;
  $('admin-view').hidden = true;
  $('admin-view').replaceChildren();
  $('admin-entry').replaceChildren();
  $('dialog-body').replaceChildren();
  $('detail-dialog').close();
  $('page-status').hidden = false;
  $('status-copy').textContent = message;
  $('login-link').hidden = false;
  $('retry-page').hidden = false;
  controls();
}
async function api(endpoint, options = {}) {
  const headers = { accept: 'application/json', ...(state.session ? { authorization: `Session ${state.session}` } : {}), ...options.headers };
  if (options.method && options.method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = state.csrf; }
  const response = await fetch(`./api/${endpoint}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(45000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error?.message || '暂时无法连接活动中心，请稍后重试');
    error.status = response.status; error.code = result?.error?.code;
    if (response.status === 401) signedOut('登录已过期，请重新从主站打开活动中心');
    if (response.status === 403 && endpoint.startsWith('admin/')) {
      state.admin = false; state.ledgerSequence++;
      $('admin-view').replaceChildren(); $('admin-view').hidden = true;
      $('activity-view').hidden = !state.user; $('admin-entry').replaceChildren();
      $('detail-dialog').close(); $('dialog-body').replaceChildren();
    }
    throw error;
  }
  return result;
}
function paintWheel() {
  const canvas = $('wheel');
  const ctx = canvas.getContext('2d');
  const style = getComputedStyle(document.documentElement);
  // Resolve CSS light-dark colors through a real element for Canvas color parsing.
  const resolver = document.createElement('span');
  resolver.hidden = true; document.body.append(resolver);
  const color = variable => { resolver.style.color = style.getPropertyValue(variable); return getComputedStyle(resolver).color; };
  ctx.clearRect(0, 0, 720, 720);
  const size = state.prizes.length;
  if (!size) { resolver.remove(); return; }
  const step = Math.PI * 2 / size;
  for (let i = 0; i < size; i++) {
    const start = -Math.PI / 2 + i * step;
    ctx.beginPath(); ctx.moveTo(360,360); ctx.arc(360,360,339,start,start+step); ctx.closePath();
    ctx.fillStyle = color(`--wedge-${i}`); ctx.fill();
    ctx.strokeStyle = color('--bg'); ctx.lineWidth = 4; ctx.stroke();
    ctx.save(); ctx.translate(360,360); ctx.rotate(start+step/2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color('--text');
    ctx.translate(235,0); ctx.rotate(Math.PI/2); ctx.font = '600 35px system-ui';
    ctx.fillText(`¥${state.prizes[i]/100}`,0,0); ctx.restore();
  }
  resolver.remove();
}
async function refreshSummary() {
  const summary = await api('activities/recharge-lottery');
  if (!state.user) return;
  state.summary = summary;
  $('available').textContent = summary.available.toLocaleString('zh-CN');
  $('my-total').textContent = money(summary.creditedMinor);
  $('my-draws').textContent = `${summary.drawn.toLocaleString('zh-CN')} 次`;
  controls();
}
async function refreshPersonal() {
  const seq = ++state.mySequence;
  const data = await api(`rewards?page=${state.page}`);
  if (!state.user || seq !== state.mySequence) return;
  $('my-rewards').innerHTML = data.rows.length ? data.rows.map(row => `<tr><td>${escapeHtml(time(row.createdAt))}<span class="row-sub">第 ${row.sequence} 次</span></td><td>${money(row.amountMinor)}</td><td>${statusHtml(row.status)}</td></tr>`).join('') : '<tr><td class="empty" colspan="3">暂无奖励记录</td></tr>';
  const pages = Math.max(1, Math.ceil(data.total/data.pageSize));
  $('my-page').textContent = `${data.total} 条 · ${data.page} / ${pages}`;
  $('my-prev').disabled = data.page <= 1; $('my-next').disabled = data.page >= pages;
}
async function refreshActivity() {
  errorBox('activity-error');
  const results = await Promise.allSettled([refreshSummary(),refreshPersonal()]);
  for (const result of results) if (result.status === 'rejected' && state.user) errorBox('activity-error', result.reason.message || '刷新失败，请稍后重试');
}
function showBatch(batch) {
  state.batch = batch;
  const total = batch.rewards.reduce((sum, r) => sum + r.amountMinor, 0);
  const groups = new Map();
  batch.rewards.forEach(r => groups.set(r.amountMinor,(groups.get(r.amountMinor)||0)+1));
  const parts = [...groups].sort((a,b) => a[0]-b[0]).map(([amount,count]) => `<span>${money(amount)} × ${count}</span>`).join('');
  const pending = batch.rewards.filter(r => r.status === 'pending').length;
  const failed = batch.rewards.filter(r => r.status === 'failed').length;
  $('outcome').innerHTML = `<span class="muted">${batch.count === 1 ? '本次获得' : `${batch.count} 次共获得`}</span><strong class="outcome-value">${money(total)}</strong><div class="outcome-parts">${batch.count > 1 ? parts : ''}<span>${failed ? `${failed} 笔入账异常` : pending ? `${pending} 笔待入账` : '已入账'}</span></div>${batch.count > 1 ? '<button id="batch-detail" class="button">查看本次结果</button>' : ''}`;
  if ($('batch-detail')) $('batch-detail').onclick = () => {
    $('dialog-title').textContent = '本次抽奖结果';
    $('dialog-body').innerHTML = `<strong class="outcome-value">${money(total)}</strong><div class="batch-results">${state.batch.rewards.map(r => `<span>${r.sequence}. ${money(r.amountMinor)}<br>${statusHtml(r.status)}</span>`).join('')}</div>`;
    $('detail-dialog').showModal();
  };
}
async function spin(batch) {
  const final = batch.rewards[batch.rewards.length-1];
  const index = state.prizes.indexOf(final.amountMinor);
  if (index < 0) throw new Error('奖项信息需要刷新');
  const angle = 360 / state.prizes.length;
  const target = (360 - (index * angle + angle/2)) % 360;
  state.rotation += 1440 + (target - state.rotation%360 + 360)%360;
  $('wheel').style.transform = `rotate(${state.rotation}deg)`;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve,2650));
  if (state.user) showBatch(batch);
}
async function draw(count) {
  if (state.busy || !state.user) return;
  if (!state.pending && (!state.summary?.enabled || count > state.summary.available)) return;
  state.busy = true;
  if (!state.pending) state.pending = { requestId: crypto.randomUUID(), count, userId: state.user.id };
  storage('activity-center.pending', JSON.stringify(state.pending));
  controls(); errorBox('activity-error');
  $('outcome').innerHTML = '<span class="muted">正在揭晓好运</span>';
  try {
    const pending = state.pending;
    const batch = await api('activities/recharge-lottery/draw', { method: 'POST', body: JSON.stringify({ requestId: pending.requestId, count: pending.count }) });
    if (!state.user || state.user.id !== pending.userId) return;
    state.pending = null; storage('activity-center.pending', null);
    storage('activity-center.last-batch', JSON.stringify({ userId: state.user.id, id: batch.id }));
    state.page = 1;
    await spin(batch);
    await refreshActivity();
  } catch (error) {
    if (['CHANCES_INSUFFICIENT','ACTIVITY_UNAVAILABLE','INVALID_REQUEST'].includes(error.code)) { state.pending = null; storage('activity-center.pending',null); }
    if (state.user) errorBox('activity-error', state.pending ? '暂未取得抽奖结果，请恢复本次结果。' : error.message);
  } finally { state.busy = false; controls(); }
}
function pagination(prefix, data) {
  const pages = Math.max(1,Math.ceil(data.total/data.pageSize));
  $(`${prefix}-page`).textContent = `${data.total} 条 · ${data.page} / ${pages}`;
  $(`${prefix}-prev`).disabled = data.page <= 1; $(`${prefix}-next`).disabled = data.page >= pages;
}
async function refreshLedger() {
  const seq = ++state.ledgerSequence;
  const filters = new URLSearchParams(new FormData($('ledger-filters')));
  for (const [key,value] of [...filters]) if (!value) filters.delete(key);
  filters.set('page',state.ledgerPage);
  errorBox('ledger-error');
  try {
    const [summary,data] = await Promise.all([api('admin/summary'),api(`admin/rewards?${filters}`)]);
    if (!state.admin || seq !== state.ledgerSequence) return;
    $('ledger-total').textContent = money(summary.totalMinor); $('ledger-today').textContent = money(summary.todayMinor);
    $('ledger-users').textContent = summary.recipients.toLocaleString('zh-CN'); $('ledger-paid').textContent = summary.paidCount.toLocaleString('zh-CN');
    $('ledger-unsettled').innerHTML = `<span class="pending">待入账 ${summary.pendingCount} 笔 · ${money(summary.pendingMinor)}</span><span class="failed">入账异常 ${summary.failedCount} 笔 · ${money(summary.failedMinor)}</span>`;
    $('ledger-rows').innerHTML = data.rows.length ? data.rows.map(row => `<tr><td>${escapeHtml(row.name)}<span class="row-sub">${escapeHtml(row.email)} · #${escapeHtml(row.userId)}</span></td><td>${money(row.amountMinor)}</td><td>${escapeHtml(row.activity)}</td><td>${escapeHtml(time(row.createdAt))}</td><td>${statusHtml(row.status)}</td><td><button class="icon-button" data-detail="${row.id}" title="查看详情" aria-label="查看奖励详情">${icon('file-text')}</button></td></tr>`).join('') : '<tr><td class="empty" colspan="6">没有符合条件的奖励记录</td></tr>';
    pagination('ledger',data); icons();
    document.querySelectorAll('[data-detail]').forEach(button => { button.onclick = () => showReward(button.dataset.detail); });
  } catch (error) { if (state.admin && seq === state.ledgerSequence) errorBox('ledger-error',error.message || '账本加载失败'); }
}
async function showReward(id) {
  try {
    const row = await api(`admin/rewards/${id}`);
    if (!state.admin) return;
    const entries = [['奖励流水',row.id],['批次',row.batchId],['用户',`${row.name} · #${row.userId}`],['邮箱',row.email],['奖励',money(row.amountMinor)],['活动',row.activity],['抽奖时间',time(row.createdAt)],['入账时间',row.creditedAt ? time(row.creditedAt) : '待入账'],['状态',statusText(row.status)],['入账尝试',row.attempts],['主站回执编号',row.receipt?.id || '尚未核验'],['主站兑换回执',row.receipt?.code || '尚未核验']];
    if (row.errorCode) entries.push(['异常代码',row.errorCode]);
    if (row.retries.length) entries.push(['恢复操作',row.retries.map(r => `管理员 #${r.actorId} · ${time(r.createdAt)}`).join(' / ')]);
    $('dialog-title').textContent = '奖励详情';
    $('dialog-body').innerHTML = `<dl class="detail-grid">${entries.map(([key,value]) => `<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${row.status === 'failed' ? '<button id="retry-credit" class="button primary dialog-action">恢复入账</button>' : ''}<div id="detail-error" class="error" role="alert" hidden></div>`;
    if ($('retry-credit')) $('retry-credit').onclick = async () => {
      $('retry-credit').disabled = true;
      try { await api(`admin/rewards/${id}/retry`,{ method: 'POST',body: '{}' }); await showReward(id); await refreshLedger(); }
      catch (error) { if ($('detail-error')) errorBox('detail-error',error.message); if ($('retry-credit')) $('retry-credit').disabled = false; }
    };
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
  } catch (error) { if (state.admin) errorBox('ledger-error',error.message); }
}
async function openAdmin() {
  try {
    const response = await fetch('./api/admin/view',{ headers: { authorization: `Session ${state.session}` }, cache: 'no-store' });
    if (!response.ok) { await api('admin/summary'); throw new Error('账本加载失败'); }
    const html = await response.text();
    if (!state.user || state.user.role !== 'admin') return;
    state.admin = true;
    $('admin-view').innerHTML = html; $('admin-view').hidden = false; $('activity-view').hidden = true; icons();
    $('back-activity').onclick = () => { state.admin = false; state.ledgerSequence++; $('admin-view').hidden = true; $('admin-view').replaceChildren(); $('activity-view').hidden = false; refreshActivity(); };
    $('refresh-ledger').onclick = refreshLedger;
    $('ledger-filters').onsubmit = event => { event.preventDefault(); state.ledgerPage = 1; refreshLedger(); };
    $('clear-filters').onclick = () => { $('ledger-filters').reset(); state.ledgerPage = 1; refreshLedger(); };
    $('ledger-prev').onclick = () => { state.ledgerPage--; refreshLedger(); };
    $('ledger-next').onclick = () => { state.ledgerPage++; refreshLedger(); };
    await refreshLedger();
  } catch (error) { if (state.user) errorBox('activity-error',error.message || '账本暂不可用'); }
}
async function initialize() {
  $('retry-page').disabled = true;
  try {
    state.config = await api('config');
    $('login-link').href = state.config.sub2apiUrl;
    state.session = storage('activity-center.session') || '';
    let session;
    if (upstreamToken) {
      state.session = '';
      session = await api('auth/sso',{ method: 'POST',headers: { authorization: `Bearer ${upstreamToken}` },body: '{}' });
      upstreamToken = '';
    } else session = await api('auth/me');
    state.user = session.user; state.csrf = session.csrfToken; state.session = session.sessionToken;
    storage('activity-center.session',state.session);
    $('admin-entry').replaceChildren();
    if (state.user.role === 'admin') {
      const button = document.createElement('button'); button.className = 'button'; button.id = 'open-ledger'; button.innerHTML = icon('notebook-pen')+'奖励账本'; button.onclick = openAdmin;
      $('admin-entry').append(button);
    }
    const registry = await api('activities');
    const activity = registry.activities.find(a => a.id === 'recharge-lottery');
    state.prizes = activity.prizes;
    $('activity-tabs').innerHTML = `<button id="lottery-tab" class="tab" role="tab" aria-selected="true" aria-controls="lottery-panel">${icon('gift')}${escapeHtml(activity.name)}</button>`;
    $('page-status').hidden = true; $('activity-view').hidden = false;
    icons(); paintWheel();
    let pending;
    try { pending = JSON.parse(storage('activity-center.pending')); } catch {}
    state.pending = pending?.userId === state.user.id && [1,10,20,50].includes(pending.count) && /^[\da-f-]{36}$/.test(pending.requestId) ? pending : null;
    await refreshActivity();
    if (state.pending) { await draw(state.pending.count); }
    else {
      let last;
      try { last = JSON.parse(storage('activity-center.last-batch')); } catch {}
      if (last?.userId === state.user?.id) {
        try { showBatch(await api(`activities/recharge-lottery/batches/${last.id}`)); } catch { /* Deleted or unavailable old results do not block the activity. */ }
      }
    }
  } catch (error) {
    if (error.status !== 401) { $('page-status').hidden = false; $('status-copy').textContent = error.message || '加载失败，请稍后重试'; $('retry-page').hidden = false; }
  } finally { $('retry-page').disabled = false; }
}
document.querySelectorAll('[data-count]').forEach(button => { button.onclick = () => draw(Number(button.dataset.count)); });
$('recover-draw').onclick = () => draw(state.pending?.count);
$('refresh-rewards').onclick = refreshActivity;
$('my-prev').onclick = () => { state.page--; refreshPersonal().catch(error => errorBox('activity-error',error.message)); };
$('my-next').onclick = () => { state.page++; refreshPersonal().catch(error => errorBox('activity-error',error.message)); };
$('retry-page').onclick = initialize;
$('close-dialog').onclick = () => $('detail-dialog').close();
$('detail-dialog').addEventListener('click', event => { if (event.target === $('detail-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',paintWheel);
setInterval(async () => {
  if (!state.user || state.busy || state.polling || document.hidden) return;
  state.polling = true;
  try {
    if (state.admin) await refreshLedger();
    else {
      await refreshActivity();
      if (state.batch?.rewards.some(r => r.status === 'pending')) showBatch(await api(`activities/recharge-lottery/batches/${state.batch.id}`));
    }
  } catch { /* Visible controls provide a retry; mutation identities remain unchanged. */ }
  finally { state.polling = false; }
},10000);
initialize();
