'use strict';

const $ = id => document.getElementById(id);
const state = { session: '', csrf: '', user: null, config: null, summary: null, prizes: [], busy: false, rotation: 0,
  page: 1, mySequence: 0, admin: false, adminPanel: '', ledgerPage: 1, ledgerSequence: 0, batch: null, pending: null, polling: false };
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
const sourceText = source => source === 'compensation' ? '补偿机会' : '充值机会';
const auditText = status => ({ violation: '未达门槛', unverifiable: '待核查', passed: '已达门槛', not_required: '无需门槛' })[status] || '待核查';
const auditHtml = audit => `<span class="${audit?.status === 'violation' ? 'failed' : audit?.status === 'passed' || audit?.status === 'not_required' ? 'muted' : 'pending'}">${auditText(audit?.status)}</span>`;
const prizeLabels = new Map([[50,'¥0.5'],[100,'¥1'],[200,'¥2'],[300,'¥3'],[500,'¥5'],[1000,'¥10'],[2000,'¥20'],[5000,'¥50']]);
function decimalToMinor(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole,fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number((fraction + '00').slice(0,2));
  return Number.isSafeInteger(result) ? result : null;
}
function updateLotteryConfigTotal() {
  const values = [...document.querySelectorAll('[data-lottery-weight]')].map(input => decimalToMinor(input.value));
  const total = values.every(Number.isSafeInteger) ? values.reduce((sum,value) => sum + value,0) : null;
  const label = $('lottery-config-total');
  label.textContent = total === null ? '总概率无效' : `总概率 ${(total / 100).toLocaleString('zh-CN',{ maximumFractionDigits: 2 })}%`;
  label.className = total === 10000 ? 'total-good' : 'total-bad';
}
function renderLotteryConfig(config) {
  $('lottery-config-version').textContent = `v${config.version} · 更新于 ${time(config.updatedAt)} · 管理员 #${escapeHtml(config.updatedBy)}`;
  $('lottery-config-rows').innerHTML = config.prizes.map(prize => `<tr><td><strong>${prizeLabels.get(prize.amountMinor)}</strong></td><td><div class="percent-input"><input data-lottery-weight="${prize.amountMinor}" type="number" min="0" max="100" step="0.01" value="${prize.weight / 100}"><span>%</span></div></td><td><div class="money-input"><input data-lottery-threshold="${prize.amountMinor}" type="number" min="0" max="10000000000" step="0.01" value="${prize.minimumMinor / 100}"><span>元</span></div></td></tr>`).join('');
  document.querySelectorAll('[data-lottery-weight],[data-lottery-threshold]').forEach(input => input.oninput = updateLotteryConfigTotal);
  updateLotteryConfigTotal();
}
function readLotteryConfig() {
  const amounts = [...prizeLabels.keys()];
  const prizes = amounts.map(amountMinor => ({ amountMinor,
    weight: decimalToMinor(document.querySelector(`[data-lottery-weight="${amountMinor}"]`)?.value),
    minimumMinor: decimalToMinor(document.querySelector(`[data-lottery-threshold="${amountMinor}"]`)?.value) }));
  if (prizes.some(prize => !Number.isSafeInteger(prize.weight) || !Number.isSafeInteger(prize.minimumMinor))) throw new Error('概率和门槛必须填写为最多两位小数的非负数');
  if (prizes.reduce((sum,prize) => sum + prize.weight,0) !== 10000) throw new Error('基础概率总和必须为 100%');
  if (prizes[0].minimumMinor !== 0 || prizes.some((prize,index) => index > 0 && prize.minimumMinor < prizes[index - 1].minimumMinor)) throw new Error('充值门槛必须从低到高设置，0.5 元奖项门槛必须为 0');
  return { prizes };
}
async function refreshLotteryConfig() {
  if (!$('lottery-config-form')) return;
  const config = await api('admin/lottery-config');
  renderLotteryConfig(config);
}
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
  state.user = null; state.csrf = ''; state.session = ''; state.pending = null; state.admin = false; state.adminPanel = ''; state.summary = null;
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
      state.admin = false; state.adminPanel = ''; state.ledgerSequence++;
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
function renderAudit(audit) {
  const summary = $('audit-summary');
  let html;
  if (!audit) html = '<span class="pending">门槛审计暂不可用，请刷新重试</span>';
  else if (audit.violationCount) html = `<strong class="failed">发现 ${audit.violationUsers} 位用户有 ${audit.violationCount} 笔未达充值门槛的奖励</strong><p>异常奖励合计 ${money(audit.violationMinor)}，其中已入账 ${money(audit.violationPaidMinor)}</p>`;
  else html = `<span class="${audit.unverifiableCount ? 'pending' : 'muted'}">${audit.unverifiableCount ? '部分奖励的充值快照待核查' : audit.totalCount ? `已核验 ${audit.passedCount} 笔门槛奖励，未发现异常` : '暂无需要门槛核验的奖励'}</span>`;
  if (audit?.unverifiableCount) html += `<p class="pending">${audit.unverifiableCount} 笔奖励缺少有效的抽奖时充值快照，需核查</p>`;
  if (summary.innerHTML !== html) summary.innerHTML = html;
  summary.setAttribute('role',audit?.violationCount ? 'alert' : 'status');
  $('ledger-audit').classList.toggle('audit-violation',Boolean(audit?.violationCount));
  $('view-audit-violations').hidden = !audit?.violationCount;
  $('view-audit-unverifiable').hidden = !audit?.unverifiableCount;
}
async function refreshLedger() {
  const seq = ++state.ledgerSequence;
  const filters = new URLSearchParams(new FormData($('ledger-filters')));
  for (const [key,value] of [...filters]) if (!value) filters.delete(key);
  filters.set('page',state.ledgerPage);
  errorBox('ledger-error');
  try {
    const results = await Promise.allSettled([api('admin/summary'),api(`admin/rewards?${filters}`)]);
    if (!state.admin || seq !== state.ledgerSequence) return;
    if (results[0].status === 'fulfilled') {
      const summary = results[0].value;
      $('ledger-total').textContent = money(summary.totalMinor); $('ledger-today').textContent = money(summary.todayMinor);
      $('ledger-users').textContent = summary.recipients.toLocaleString('zh-CN'); $('ledger-paid').textContent = summary.paidCount.toLocaleString('zh-CN');
      $('ledger-unsettled').innerHTML = `<span class="pending">待入账 ${summary.pendingCount} 笔 · ${money(summary.pendingMinor)}</span><span class="failed">入账异常 ${summary.failedCount} 笔 · ${money(summary.failedMinor)}</span>`;
      renderAudit(summary.audit);
    } else renderAudit(null);
    if (results[1].status === 'fulfilled') {
      const data = results[1].value;
      $('ledger-rows').innerHTML = data.rows.length ? data.rows.map(row => `<tr><td>${escapeHtml(row.name)}<span class="row-sub">${escapeHtml(row.email)} · #${escapeHtml(row.userId)}</span></td><td>${money(row.amountMinor)}</td><td>${escapeHtml(sourceText(row.chanceSource))}</td><td>${escapeHtml(row.activity)}</td><td>${escapeHtml(time(row.createdAt))}</td><td>${statusHtml(row.status)}</td><td>${auditHtml(row.audit)}</td><td><button class="icon-button" data-detail="${row.id}" title="查看详情" aria-label="查看奖励详情">${icon('file-text')}</button></td></tr>`).join('') : '<tr><td class="empty" colspan="8">没有符合条件的奖励记录</td></tr>';
      pagination('ledger',data); icons();
      document.querySelectorAll('[data-detail]').forEach(button => { button.onclick = () => showReward(button.dataset.detail); });
    }
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) errorBox('ledger-error',failures.map(result => result.reason.message || '账本加载失败').join('；'));
  } catch (error) {
    if (state.admin && seq === state.ledgerSequence) {
      renderAudit(null);
      errorBox('ledger-error',error.message || '账本加载失败');
    }
  }
}
async function showReward(id) {
  try {
    const row = await api(`admin/rewards/${id}`);
    if (!state.admin) return;
    const entries = [['奖励流水',row.id],['批次',row.batchId],['用户',`${row.name} · #${row.userId}`],['邮箱',row.email],['奖励',money(row.amountMinor)],['抽奖来源',sourceText(row.chanceSource)],['活动',row.activity],['抽奖时间',time(row.createdAt)],['入账时间',row.creditedAt ? time(row.creditedAt) : '待入账'],['状态',statusText(row.status)],['入账尝试',row.attempts],['主站回执编号',row.receipt?.id || '尚未核验'],['主站兑换回执',row.receipt?.code || '尚未核验']];
    if (row.chanceSource === 'compensation') entries.push(['补偿发放批次',row.grantId || '未知'],['概率方案',row.profileId || '已锁定快照']);
    entries.push(['门槛审计',auditText(row.audit?.status)]);
    if (row.audit?.requiredMinor > 0) {
      entries.push(['所需充值',money(row.audit.requiredMinor)],['抽奖时充值',row.audit.rechargeMinor === null ? '缺少有效快照' : money(row.audit.rechargeMinor)]);
      if (row.audit.status === 'violation') entries.push(['充值差额',money(row.audit.requiredMinor-row.audit.rechargeMinor)]);
    }
    if (row.errorCode) entries.push(['异常代码',row.errorCode]);
    if (row.creditMigration) entries.push(['原入账码',row.creditMigration.code],['原入账类型',row.creditMigration.type],
      ['原尝试次数',row.creditMigration.attempts],['兼容核验时间',time(row.creditMigration.verifiedAt)]);
    if (row.retries.length) entries.push(['恢复操作',row.retries.map(r => `管理员 #${r.actorId} · ${time(r.createdAt)}`).join(' / ')]);
    $('dialog-title').textContent = '奖励详情';
    $('dialog-body').innerHTML = `${row.errorCode === 'CREDIT_LEGACY_REVIEW_REQUIRED' ? '<p class="audit-detail pending" role="alert">原入账状态尚未核实，已暂停发放，请核查原回执</p>' : ''}${['violation','unverifiable'].includes(row.audit?.status) ? `<p class="audit-detail ${row.audit.status === 'violation' ? 'failed' : 'pending'}" role="alert">${row.audit.status === 'violation' ? '该奖励未达到充值门槛，请核查' : '该奖励的抽奖时充值快照无法核验，请核查'}</p>` : ''}<dl class="detail-grid">${entries.map(([key,value]) => `<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${row.status === 'failed' ? '<button id="retry-credit" class="button primary dialog-action">恢复入账</button>' : ''}<div id="detail-error" class="error" role="alert" hidden></div>`;
    if ($('retry-credit')) $('retry-credit').onclick = async () => {
      $('retry-credit').disabled = true;
      try { await api(`admin/rewards/${id}/retry`,{ method: 'POST',body: '{}' }); await showReward(id); await refreshLedger(); }
      catch (error) { if ($('detail-error')) errorBox('detail-error',error.message); if ($('retry-credit')) $('retry-credit').disabled = false; }
    };
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
  } catch (error) { if (state.admin) errorBox('ledger-error',error.message); }
}
async function openAdminPanel(panel = 'ledger') {
  try {
    const endpoint = panel === 'compensation' ? 'admin/compensation/view' : 'admin/view';
    const response = await fetch(`./api/${endpoint}`,{ headers: { authorization: `Session ${state.session}` }, cache: 'no-store' });
    if (!response.ok) { await api(panel === 'compensation' ? 'admin/compensation/summary' : 'admin/summary'); throw new Error(panel === 'compensation' ? '补偿管理加载失败' : '账本加载失败'); }
    const html = await response.text();
    if (!state.user || state.user.role !== 'admin') return;
    state.admin = true; state.adminPanel = panel; state.ledgerSequence++;
    $('admin-view').innerHTML = html; $('admin-view').hidden = false; $('activity-view').hidden = true; icons();
    $('back-activity').onclick = () => { state.admin = false; state.adminPanel = ''; state.ledgerSequence++; $('admin-view').hidden = true; $('admin-view').replaceChildren(); $('activity-view').hidden = false; refreshActivity(); };
    if ($('admin-ledger-tab')) $('admin-ledger-tab').onclick = () => openAdminPanel('ledger');
    if ($('admin-compensation-tab')) $('admin-compensation-tab').onclick = () => openAdminPanel('compensation');
    if (panel === 'ledger') {
      $('refresh-ledger').onclick = async () => { await refreshLedger(); await refreshLotteryConfig(); };
      $('ledger-filters').onsubmit = event => { event.preventDefault(); state.ledgerPage = 1; refreshLedger(); };
      $('clear-filters').onclick = () => { $('ledger-filters').reset(); state.ledgerPage = 1; refreshLedger(); };
      for (const [id,audit] of [['view-audit-violations','violation'],['view-audit-unverifiable','unverifiable']]) {
        $(id).onclick = () => { $('ledger-filters').reset(); $('ledger-filters').elements.audit.value = audit; state.ledgerPage = 1; refreshLedger(); };
      }
      $('ledger-prev').onclick = () => { state.ledgerPage--; refreshLedger(); };
      $('ledger-next').onclick = () => { state.ledgerPage++; refreshLedger(); };
      $('lottery-config-form').onsubmit = async event => {
        event.preventDefault();
        const feedback = $('lottery-config-feedback');
        try {
          const payload = readLotteryConfig();
          feedback.className = 'feedback'; feedback.textContent = '';
          const button = $('lottery-config-form button[type="submit"]'); button.disabled = true;
          try {
            await api('admin/lottery-config',{ method: 'POST',body: JSON.stringify(payload) });
            feedback.textContent = '充值抽奖规则已保存，新抽奖将使用本次配置。';
            await refreshLotteryConfig();
          } finally { button.disabled = false; }
        } catch (error) { feedback.className = 'feedback error'; feedback.textContent = error.message || '充值抽奖规则保存失败'; }
      };
      await refreshLedger();
      await refreshLotteryConfig();
    } else if (window.initCompensationAdmin) {
      window.initCompensationAdmin({ api, icons, escapeHtml, time });
    }
  } catch (error) { if (state.user) errorBox('activity-error',error.message || '管理员页面暂不可用'); }
}
function openAdmin() { return openAdminPanel('ledger'); }
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
    if (state.admin) { if (state.adminPanel === 'compensation') await window.refreshCompensationAdmin?.(); else await refreshLedger(); }
    else {
      await refreshActivity();
      if (state.batch?.rewards.some(r => r.status === 'pending')) showBatch(await api(`activities/recharge-lottery/batches/${state.batch.id}`));
    }
  } catch { /* Visible controls provide a retry; mutation identities remain unchanged. */ }
  finally { state.polling = false; }
},10000);
initialize();
