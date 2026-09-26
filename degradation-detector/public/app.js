'use strict';

const state = {
  sessionToken: sessionStorage.getItem('degradation-detector.session') || '',
  user: null,
  data: null,
  platform: '',
  activeGroupId: null,
  opener: null,
  openerGroupId: null,
  selectedRunId: null,
  detailRequest: 0,
  refreshBusy: false,
  pollTimer: null
};

const labels = {
  normal: '正常',
  degraded: '疑似降智',
  unknown: '无法判定',
  error: '检测异常',
  running: '检测中',
  queued: '等待检测'
};

const outputLabels = { text: '直接答案', html: 'HTML', image: '图片', file: '文件' };

function $(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function showView(name) {
  $('loading-view').hidden = name !== 'loading';
  $('error-view').hidden = name !== 'error';
  $('app-view').hidden = name !== 'app';
}

function showError(message) {
  $('error-message').textContent = message || '页面暂时不可用';
  showView('error');
  refreshIcons();
}

function toast(message, type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  $('toast-region').append(item);
  setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.sessionToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Session ${state.sessionToken}`;
  }
  if (options.body != null) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
    body: options.body == null || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body)
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setSession(session) {
  state.sessionToken = session.sessionToken || state.sessionToken;
  state.user = session.user;
  if (state.sessionToken) sessionStorage.setItem('degradation-detector.session', state.sessionToken);
  $('user-name').textContent = session.user?.name || 'Sub2API 用户';
}

function cleanAuthParams() {
  const url = new URL(location.href);
  for (const key of ['token', 'access_token']) url.searchParams.delete(key);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function statusHtml(status) {
  return `<span class="yzai-pelican-status" data-status="${escapeHtml(status)}">${escapeHtml(labels[status] || '检测异常')}</span>`;
}

function when(timestamp) {
  if (!timestamp) return '等待开始';
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}

function scheduleDescription(data = state.data) {
  if (data?.schedule_mode === 'interval') {
    const minutes = Number(data.schedule_interval_minutes) || 0;
    if (minutes > 0 && minutes % 1440 === 0) return `每隔 ${minutes / 1440} 天`;
    if (minutes > 0 && minutes % 60 === 0) return `每隔 ${minutes / 60} 小时`;
    return `每隔 ${minutes || '--'} 分钟`;
  }
  const times = Array.isArray(data?.schedule_times) ? data.schedule_times : [];
  return `每日 ${times.length ? times.join('、') : '--:--'}`;
}

function degradationSummary(totals) {
  const valid = Number(totals?.valid || 0);
  const failed = Math.max(0, valid - Number(totals?.passed || 0));
  const rate = valid ? Math.round((failed / valid) * 1000) / 10 : 0;
  return `${rate}% · ${failed} / ${valid} 次`;
}

function activeGroup() {
  return state.data?.groups.find((group) => String(group.id) === String(state.activeGroupId)) || null;
}

function platformIcon(platform) {
  return ({ openai: 'sparkles', anthropic: 'bot', gemini: 'gem', grok: 'orbit' })[platform] || 'cpu';
}

function renderPlatformFilter() {
  const select = $('platform-filter');
  const current = state.platform;
  select.innerHTML = '<option value="">全部平台</option>' + (state.data?.platforms || [])
    .map((platform) => `<option value="${escapeHtml(platform.id)}">${escapeHtml(platform.label)}</option>`)
    .join('');
  select.value = current;
}

function historyChart(history) {
  const runs = [...(history || [])].reverse().slice(-10);
  const padding = Array.from({ length: Math.max(0, 10 - runs.length) }, () => null);
  return [...padding, ...runs].map((run) => {
    const status = run?.status || 'empty';
    const title = run ? `${when(run.started)} · ${labels[status] || status}` : '暂无记录';
    return `<span class="history-point" data-status="${escapeHtml(status)}" title="${escapeHtml(title)}"></span>`;
  }).join('');
}

function renderGroups() {
  const groups = (state.data?.groups || []).filter((group) => !state.platform || group.platform === state.platform);
  $('group-count').textContent = `${groups.length} 个可检测分组`;
  if (!groups.length) {
    $('group-grid').innerHTML = `<div class="empty-list"><i data-lucide="folder-search"></i><p>当前筛选下没有可检测分组</p></div>`;
    refreshIcons();
    return;
  }
  $('group-grid').innerHTML = groups.map((group) => {
    return `
    <article class="group-card" data-group-id="${escapeHtml(group.id)}">
      <div class="group-card-head">
        <div><h2>${escapeHtml(group.name)}</h2><span class="group-id">#${escapeHtml(group.id)}</span></div>
        <span class="platform-label"><i data-lucide="${platformIcon(group.platform)}"></i>${escapeHtml(group.platform_label)}</span>
      </div>
      <div class="group-model">
        <span title="${escapeHtml(group.model)}">${escapeHtml(group.model)}</span>
        <span>${escapeHtml(outputLabels[group.output_type] || group.output_type)}</span>
      </div>
      <div class="history-chart" aria-label="最近检测记录">${historyChart(group.history)}</div>
      <div class="history-caption">PAST ${group.history.length || 0} RESULTS</div>
      <div class="group-actions">
        <span class="degradation-total" title="累计疑似降智次数 / 有效判定次数；异常和无法判定不计入">降智率 <b>${escapeHtml(degradationSummary(group.totals))}</b></span>
        <button class="yzai-pelican-btn detect-button" type="button" data-group-id="${escapeHtml(group.id)}" aria-haspopup="dialog">
          <i data-lucide="eye"></i><span>查看结果</span>
        </button>
      </div>
    </article>
  `;
  }).join('');
  document.querySelectorAll('.detect-button').forEach((button) => {
    button.addEventListener('click', () => openGroup(button.dataset.groupId));
  });
  refreshIcons();
}

function renderPageMeta() {
  const enabled = (state.data?.groups || []).length;
  const next = state.data?.next_run_at ? ` · 下次 ${when(state.data.next_run_at)}` : '';
  $('page-meta').textContent = `只读结果 · ${scheduleDescription()} 检测 · ${enabled} 个分组已启用${next}`;
}

async function refresh() {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  $('refresh-button').classList.add('busy');
  try {
    state.data = await api('/api/results');
    renderPlatformFilter();
    renderPageMeta();
    renderGroups();
    if ($('result-dialog').open && activeGroup()) renderDialog(false);
  } finally {
    state.refreshBusy = false;
    $('refresh-button').classList.remove('busy');
  }
}

function renderHistory(group) {
  const list = $('history-list');
  if (!group.history.length) {
    list.innerHTML = '';
    state.selectedRunId = null;
    return;
  }
  if (!state.selectedRunId || !group.history.some((run) => run.id === state.selectedRunId)) {
    state.selectedRunId = group.history[0].id;
  }
  list.innerHTML = group.history.map((run) => `
    <button type="button" data-run-id="${run.id}" aria-current="${run.id === state.selectedRunId}">
      <strong>${escapeHtml(when(run.started))}</strong>
      ${statusHtml(run.status)}
      <small>${escapeHtml(run.model || group.model)}${run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)} 秒` : ''}</small>
    </button>
  `).join('');
  list.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedRunId = Number(button.dataset.runId);
      renderDialog(true);
    });
  });
}

async function showRecord(run) {
  const requestId = ++state.detailRequest;
  const box = $('result-detail');
  box.innerHTML = `
    <div class="yzai-pelican-meta">开始：${escapeHtml(when(run.started))} · 结束：${escapeHtml(run.finished ? when(run.finished) : '进行中')}</div>
    <p class="yzai-pelican-reason">${statusHtml(run.status)} · ${escapeHtml(run.reason || '正在生成与评估，请稍后查看。')}</p>
  `;
  if (['queued', 'running'].includes(run.status)) {
    box.insertAdjacentHTML('beforeend', '<div class="yzai-pelican-empty">检测进行中，完成后自动更新。</div>');
    refreshIcons();
    return;
  }
  if (run.status === 'error') {
    box.insertAdjacentHTML('beforeend', '<div class="yzai-pelican-empty">本次没有可展示的作品。</div>');
    refreshIcons();
    return;
  }
  const loading = document.createElement('p');
  loading.className = 'yzai-pelican-empty';
  loading.textContent = '正在加载作品...';
  box.append(loading);
  try {
    const detail = await api(`/api/results/${run.id}`);
    if (requestId !== state.detailRequest || !$('result-dialog').open) return;
    loading.remove();
    if (detail.output_type === 'text') {
      if (detail.text == null) {
        box.insertAdjacentHTML('beforeend', '<p class="yzai-pelican-empty">作品已过期，判定记录仍然保留。</p>');
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'yzai-pelican-code yzai-pelican-text';
      pre.textContent = detail.text;
      box.append(pre);
      return;
    }
    if (!detail.preview_url) {
      box.insertAdjacentHTML('beforeend', '<p class="yzai-pelican-empty">作品已过期，判定记录仍然保留。</p>');
      return;
    }
    const controls = document.createElement('div');
    controls.className = 'yzai-pelican-controls';
    const frame = document.createElement('iframe');
    frame.className = 'yzai-pelican-frame';
    frame.title = `${activeGroup()?.name || ''} 检测作品`;
    frame.sandbox = 'allow-scripts';
    frame.referrerPolicy = 'no-referrer';
    frame.src = detail.preview_url;
    if (detail.output_type === 'html') {
      const toggle = document.createElement('button');
      toggle.className = 'yzai-pelican-btn';
      toggle.type = 'button';
      toggle.textContent = '查看源码';
      const code = document.createElement('pre');
      code.className = 'yzai-pelican-code';
      code.textContent = detail.html || '';
      let source = false;
      toggle.addEventListener('click', () => {
        source = !source;
        toggle.textContent = source ? '查看预览' : '查看源码';
        if (source) {
          frame.replaceWith(code);
          frame.src = 'about:blank';
        } else {
          code.replaceWith(frame);
          frame.src = detail.preview_url;
        }
      });
      controls.append(toggle);
    }
    if (detail.artifact?.download_url) {
      const download = document.createElement('a');
      download.className = 'yzai-pelican-btn';
      download.href = detail.artifact.download_url;
      download.textContent = '下载文件';
      controls.append(download);
    }
    if (controls.childNodes.length) box.append(controls);
    box.append(frame);
  } catch (error) {
    if (requestId === state.detailRequest) loading.textContent = error.message;
  }
}

function renderDialog(force) {
  const group = activeGroup();
  if (!group || !$('result-dialog').open) return;
  $('dialog-title').textContent = `降智检测 · ${group.name}`;
  $('dialog-subtitle').textContent = `${scheduleDescription()} 检测 · ${group.model} · ${outputLabels[group.output_type] || group.output_type}；单次作品不代表长期表现。`;
  renderHistory(group);
  const run = group.history.find((item) => item.id === state.selectedRunId);
  if (!run) {
    $('result-detail').innerHTML = '<p class="yzai-pelican-empty">暂无检测记录。</p>';
  } else {
    const key = `${run.id}:${run.status}`;
    if (force || $('result-dialog').dataset.record !== key) {
      $('result-dialog').dataset.record = key;
      showRecord(run);
    }
  }
  refreshIcons();
}

async function openGroup(groupId) {
  state.opener = document.activeElement;
  state.openerGroupId = String(groupId);
  state.activeGroupId = String(groupId);
  state.selectedRunId = null;
  $('result-dialog').dataset.record = '';
  $('result-dialog').showModal();
  renderDialog(true);
}

function schedulePolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!document.hidden) refresh(false).catch(() => {});
  }, 5000);
}

async function authenticate() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  const token = params.get('token') || params.get('access_token');
  let session;
  if (token) {
    cleanAuthParams();
    session = await api('/api/auth/sso', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {}
    });
  } else if (['1', 'readonly'].includes(params.get('demo'))) {
    session = await api('/api/auth/demo', {
      method: 'POST',
      body: { readOnly: params.get('demo') === 'readonly' }
    });
  } else {
    session = await api('/api/auth/me');
  }
  setSession(session);
}

async function initialize() {
  showView('loading');
  try {
    await authenticate();
    showView('app');
    await refresh(true);
    schedulePolling();
    refreshIcons();
  } catch (error) {
    state.sessionToken = '';
    sessionStorage.removeItem('degradation-detector.session');
    showError(error.status === 401
      ? '登录状态无效或已过期，请从 Sub2API 自定义菜单重新打开。'
      : error.message);
  }
}

$('platform-filter').addEventListener('change', (event) => {
  state.platform = event.target.value;
  renderGroups();
});
$('refresh-button').addEventListener('click', () => refresh(true).catch((error) => toast(error.message, 'error')));
$('retry-button').addEventListener('click', initialize);
$('dialog-close').addEventListener('click', () => $('result-dialog').close());
$('result-dialog').addEventListener('click', (event) => {
  if (event.target !== $('result-dialog')) return;
  const bounds = $('result-dialog').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) {
    $('result-dialog').close();
  }
});
$('result-dialog').addEventListener('close', () => {
  const opener = state.opener;
  const openerGroupId = state.openerGroupId;
  state.detailRequest += 1;
  state.activeGroupId = null;
  state.selectedRunId = null;
  state.opener = null;
  state.openerGroupId = null;
  $('result-detail').replaceChildren();
  const fallback = [...document.querySelectorAll('.detect-button')]
    .find((button) => button.dataset.groupId === openerGroupId);
  if (opener?.isConnected) opener.focus();
  else fallback?.focus();
});

initialize();
