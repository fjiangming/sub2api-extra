'use strict';

const state = {
  sessionToken: '',
  csrfToken: '',
  user: null,
  data: null,
  activePlatform: '',
  dirty: false,
  saving: false,
  runningGroups: new Set(),
  historyGroupId: null,
  historyRuns: [],
  historyTotal: 0,
  historyDeletableCount: 0,
  historyNextCursor: null,
  historySelected: new Set(),
  historyLoading: false,
  historyDeleting: false,
  historyError: '',
  historyRequest: 0,
  confirmResolve: null
};

const apiLabels = {
  responses: 'OpenAI Responses',
  chat_completions: 'Chat Completions',
  anthropic_messages: 'Anthropic Messages',
  gemini_generate_content: 'Gemini generateContent',
  images_generations: 'Images Generations'
};
const outputLabels = { text: '直接答案', html: 'HTML', image: '图片', file: '文件' };
const MAX_HISTORY_SELECTION = 100;
const reasoningLabels = {
  none: '不指定', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max'
};
const intervalUnitMinutes = { minutes: 1, hours: 60, days: 1440 };
const statusLabels = {
  normal: '正常', degraded: '疑似降智', unknown: '无法判定', error: '检测异常',
  running: '检测中', queued: '等待检测'
};
const triggerLabels = { manual: '手动检测', scheduled: '自动检测', demo: '演示记录', test: '测试记录' };

function $(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function platformIcon(platform) {
  return ({ openai: 'sparkles', anthropic: 'bot', gemini: 'gem', grok: 'orbit' })[platform] || 'cpu';
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

function when(timestamp) {
  if (!timestamp) return '等待开始';
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.sessionToken) headers.Authorization = `Session ${state.sessionToken}`;
  if (options.body != null) headers['Content-Type'] = 'application/json';
  if (options.mutation && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
    body: options.body == null || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function optionsHtml(values, selected, labels) {
  return values.map((value) => (
    `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(labels[value] || value)}</option>`
  )).join('');
}

function intervalDisplay(totalMinutes) {
  const minutes = Number(totalMinutes) || 60;
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

function updateIntervalLimit() {
  const unit = $('schedule-interval-unit').value;
  $('schedule-interval-value').max = String(Math.floor(43200 / intervalUnitMinutes[unit]));
}

function updateScheduleTimeButtons() {
  const items = [...$('schedule-times').querySelectorAll('.schedule-time-item')];
  items.forEach((item) => {
    item.querySelector('[data-remove-time]').disabled = items.length <= 1;
  });
  $('schedule-time-add').disabled = items.length >= 24;
}

function addScheduleTime(value = '09:00', dirty = true) {
  if ($('schedule-times').children.length >= 24) return;
  const item = document.createElement('div');
  item.className = 'schedule-time-item';
  item.innerHTML = `
    <input type="time" required step="60" value="${escapeHtml(value)}" aria-label="每日执行时间">
    <button class="icon-button schedule-time-remove" type="button" data-remove-time
      title="删除执行时间" aria-label="删除执行时间"><i data-lucide="x"></i></button>`;
  const input = item.querySelector('input');
  const remove = item.querySelector('[data-remove-time]');
  input.addEventListener('input', markDirty);
  input.addEventListener('change', markDirty);
  remove.addEventListener('click', () => {
    if ($('schedule-times').children.length <= 1) return;
    item.remove();
    updateScheduleTimeButtons();
    markDirty();
  });
  $('schedule-times').append(item);
  updateScheduleTimeButtons();
  if (dirty) markDirty();
  refreshIcons();
}

function suggestedScheduleTime() {
  const values = [...$('schedule-times').querySelectorAll('input')]
    .map((input) => input.value)
    .filter(Boolean)
    .sort();
  if (values.length === 0) return '09:00';
  const used = new Set(values);
  const [hour, minute] = values.at(-1).split(':').map(Number);
  for (let offset = 1; offset <= 24; offset += 1) {
    const candidate = `${String((hour + offset) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  return '09:00';
}

function syncScheduleMode(dirty = false) {
  const mode = document.querySelector('input[name="schedule-mode"]:checked')?.value || 'daily';
  const daily = mode === 'daily';
  $('schedule-daily-fields').hidden = !daily;
  $('schedule-interval-fields').hidden = daily;
  $('schedule-times').querySelectorAll('input').forEach((input) => { input.disabled = !daily; });
  $('schedule-interval-value').disabled = daily;
  $('schedule-interval-unit').disabled = daily;
  if (dirty) markDirty();
}

function renderSchedule() {
  const mode = state.data.schedule_mode === 'interval' ? 'interval' : 'daily';
  const radio = document.querySelector(`input[name="schedule-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $('schedule-times').replaceChildren();
  const times = Array.isArray(state.data.schedule_times) && state.data.schedule_times.length
    ? state.data.schedule_times
    : ['09:00'];
  times.forEach((time) => addScheduleTime(time, false));
  const interval = intervalDisplay(state.data.schedule_interval_minutes);
  $('schedule-interval-value').value = String(interval.value);
  $('schedule-interval-unit').value = interval.unit;
  updateIntervalLimit();
  syncScheduleMode(false);
}

function groupHtml(group, platformIndex, groupIndex) {
  const configured = group.key_configured === true;
  return `
    <div class="group-row" data-group-index="${groupIndex}" data-group-id="${escapeHtml(group.id)}"
      data-selected="${group.enabled === true}" data-saved-enabled="${group.enabled === true}" data-key-configured="${configured}">
      <label class="group-choice">
        <input type="checkbox" data-group-toggle ${group.enabled ? 'checked' : ''}>
        <span class="group-copy">
          <strong>${escapeHtml(group.name)}</strong>
          <small>#${escapeHtml(group.id)}${group.rate_multiplier == null ? '' : ` · 倍率 ${escapeHtml(group.rate_multiplier)}`}</small>
        </span>
      </label>
      <div class="group-controls">
        <div class="key-box">
          <input type="password" data-group-key maxlength="8192" autocomplete="new-password"
            aria-label="${escapeHtml(group.name)} 专用 Key"
            placeholder="${configured ? '已安全保存，留空保持不变' : '输入完整的分组专用 Key'}">
          <span class="key-state ${configured ? 'configured' : ''}">
            <i data-lucide="${configured ? 'shield-check' : 'key-round'}"></i>
            <span>${configured ? '已配置' : '未配置'}</span>
          </span>
        </div>
        <button class="button run-group-button" type="button" data-run-button data-group-id="${escapeHtml(group.id)}"
          title="立即检测 ${escapeHtml(group.name)}" ${group.enabled && configured ? '' : 'disabled'}>
          <i data-lucide="play"></i><span>立即检测</span>
        </button>
        <button class="button history-group-button" type="button" data-history-button data-group-id="${escapeHtml(group.id)}"
          title="管理 ${escapeHtml(group.name)} 的历史检测记录">
          <i data-lucide="history"></i><span>历史</span><b data-history-count>${Number(group.history_count) || 0}</b>
        </button>
      </div>
    </div>`;
}

function platformPanelHtml(platform, index) {
  const test = platform.test || {};
  const validation = test.validation || {};
  const groups = platform.groups || [];
  return `
    <section class="platform-panel" data-platform-index="${index}"${platform.id === state.activePlatform ? '' : ' hidden'}>
      <header class="platform-title-row">
        <div class="platform-title-copy">
          <span><i data-lucide="${platformIcon(platform.id)}"></i></span>
          <div><h3>${escapeHtml(platform.label || platform.id)}</h3><p>${escapeHtml(platform.id)} · ${groups.length} 个分组</p></div>
        </div>
        <label class="platform-status">
          <input type="checkbox" data-platform-enabled ${platform.enabled ? 'checked' : ''}>
          <span class="switch-track" aria-hidden="true"><span></span></span>
          <span>启用平台</span>
        </label>
      </header>
      <div class="platform-content">
        <section class="test-config">
          <h4 class="subsection-title">检测题配置</h4>
          <div class="form-grid">
            <label class="field"><span>显示名称</span><input data-test="label" required maxlength="80" value="${escapeHtml(test.label || platform.label || platform.id)}"></label>
            <label class="field"><span>模型</span><input data-test="model" required maxlength="200" value="${escapeHtml(test.model || '')}"></label>
            <label class="field"><span>请求协议</span><select data-test="api">${optionsHtml(Object.keys(apiLabels), test.api, apiLabels)}</select></label>
            <label class="field"><span>输出类型</span><select data-test="output_type">${optionsHtml(Object.keys(outputLabels), test.output_type, outputLabels)}</select></label>
            <label class="field"><span>推理强度</span><select data-test="reasoning_effort">${optionsHtml(Object.keys(reasoningLabels), test.reasoning_effort || 'none', reasoningLabels)}</select></label>
            <label class="field"><span>最大输出 Token</span><input data-test="max_output_tokens" type="number" min="64" max="131072" required value="${escapeHtml(test.max_output_tokens || 16384)}"></label>
            <label class="field field-wide"><span>检测提示词</span><textarea class="prompt-input" data-test="prompt" required maxlength="100000">${escapeHtml(test.prompt || '')}</textarea></label>
            <label class="field field-wide"><span>文件 MIME 类型</span><input data-test="mime_type" maxlength="200" value="${escapeHtml(test.mime_type || '')}" placeholder="可选"></label>
            <details class="validation-details">
              <summary>判定规则</summary>
              <div class="validation-grid">
                <label class="field"><span>最小字节数</span><input data-validation="min_bytes" type="number" min="0" max="20971520" required value="${escapeHtml(validation.min_bytes ?? 1)}"></label>
                <label class="check-field"><input data-validation="case_sensitive" type="checkbox" ${validation.case_sensitive ? 'checked' : ''}><span>正则区分大小写</span></label>
                <label class="field field-wide"><span>必须匹配的正则（每行一条）</span><textarea class="pattern-input" data-validation="required_patterns">${escapeHtml((validation.required_patterns || []).join('\n'))}</textarea></label>
                <label class="field field-wide"><span>禁止匹配的正则（每行一条）</span><textarea class="pattern-input" data-validation="forbidden_patterns">${escapeHtml((validation.forbidden_patterns || []).join('\n'))}</textarea></label>
                <label class="field"><span>图片最小宽度</span><input data-validation="min_width" type="number" min="1" max="16384" value="${escapeHtml(validation.min_width || '')}" placeholder="可选"></label>
                <label class="field"><span>图片最小高度</span><input data-validation="min_height" type="number" min="1" max="16384" value="${escapeHtml(validation.min_height || '')}" placeholder="可选"></label>
              </div>
            </details>
          </div>
        </section>
        <section class="groups-config">
          <header class="groups-head"><h4 class="subsection-title">自动检测分组</h4><span class="selected-count"></span></header>
          <div class="group-list">
            ${groups.length ? groups.map((group, groupIndex) => groupHtml(group, index, groupIndex)).join('') : '<p class="empty-groups">该平台暂无可配置分组</p>'}
          </div>
        </section>
      </div>
    </section>`;
}

function setActivePlatform(platformId) {
  state.activePlatform = platformId;
  document.querySelectorAll('.platform-tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.platform === platformId));
  });
  document.querySelectorAll('.platform-panel').forEach((panel) => {
    const platform = state.data.platforms[Number(panel.dataset.platformIndex)];
    panel.hidden = platform.id !== platformId;
  });
}

function updateGroupRow(row, platformEnabled) {
  const toggle = row.querySelector('[data-group-toggle]');
  const key = row.querySelector('[data-group-key]');
  const stateBox = row.querySelector('.key-state');
  const runButton = row.querySelector('[data-run-button]');
  const configured = row.dataset.keyConfigured === 'true';
  const savedEnabled = row.dataset.savedEnabled === 'true';
  const groupId = row.dataset.groupId;
  toggle.disabled = !platformEnabled;
  const selected = platformEnabled && toggle.checked;
  row.dataset.selected = String(selected);
  key.disabled = !selected;
  let label = configured ? '已配置' : '未配置';
  let icon = configured ? 'shield-check' : 'key-round';
  if (!platformEnabled) label = '平台未启用';
  else if (!toggle.checked && configured) { label = '保存后清除'; icon = 'trash-2'; }
  else if (selected && key.value) { label = configured ? '将更新' : '待保存'; icon = 'key-round'; }
  stateBox.classList.toggle('configured', configured && selected && !key.value);
  stateBox.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  const running = state.runningGroups.has(groupId);
  runButton.disabled = state.dirty || running || !selected || !savedEnabled || !configured || Boolean(key.value);
  runButton.classList.toggle('busy', running);
  runButton.title = state.dirty
    ? '请先保存配置后再检测'
    : (runButton.disabled ? '启用分组并配置专用 Key 后才能检测' : '使用已保存配置立即检测');
  runButton.querySelector('span').textContent = running ? '正在提交' : '立即检测';
}

function markDirty() {
  state.dirty = true;
  document.querySelectorAll('.platform-panel').forEach((panel) => {
    updatePlatform(Number(panel.dataset.platformIndex));
  });
}

function updatePlatform(index) {
  const panel = document.querySelector(`.platform-panel[data-platform-index="${index}"]`);
  const enabled = panel.querySelector('[data-platform-enabled]').checked;
  let selected = 0;
  panel.querySelectorAll('.group-row').forEach((row) => {
    updateGroupRow(row, enabled);
    if (row.dataset.selected === 'true') selected += 1;
  });
  panel.querySelector('.selected-count').textContent = `${selected} 个已启用`;
  const tab = document.querySelector(`.platform-tab[data-platform-index="${index}"]`);
  tab.dataset.enabled = String(enabled);
  refreshIcons();
}

function bindPanel(panel) {
  const index = Number(panel.dataset.platformIndex);
  panel.querySelector('[data-platform-enabled]').addEventListener('change', () => {
    markDirty();
    updatePlatform(index);
  });
  panel.querySelectorAll('[data-group-toggle]').forEach((toggle) => {
    toggle.addEventListener('change', () => {
      markDirty();
      if (!toggle.checked) toggle.closest('.group-row').querySelector('[data-group-key]').value = '';
      updatePlatform(index);
    });
  });
  panel.querySelectorAll('[data-group-key]').forEach((input) => {
    input.addEventListener('input', () => {
      markDirty();
      updatePlatform(index);
    });
  });
  panel.querySelectorAll('[data-run-button]').forEach((button) => {
    button.addEventListener('click', () => triggerManualRun(button));
  });
  panel.querySelectorAll('[data-history-button]').forEach((button) => {
    button.addEventListener('click', () => openHistory(button.dataset.groupId));
  });
  panel.querySelectorAll('input, textarea, select').forEach((control) => {
    control.addEventListener('input', markDirty);
    control.addEventListener('change', markDirty);
  });
  updatePlatform(index);
}

function render() {
  const platforms = state.data.platforms || [];
  if (!platforms.some((platform) => platform.id === state.activePlatform)) {
    state.activePlatform = platforms[0]?.id || '';
  }
  renderSchedule();
  $('schedule-next').textContent = state.data.schedule_timezone || 'Asia/Shanghai';
  $('platform-summary').textContent = `${platforms.length} 个平台 · ${platforms.reduce((sum, platform) => sum + platform.groups.length, 0)} 个分组`;
  $('platform-tabs').innerHTML = platforms.map((platform, index) => `
    <button class="platform-tab" type="button" role="tab" data-platform="${escapeHtml(platform.id)}" data-platform-index="${index}"
      data-enabled="${platform.enabled === true}" aria-selected="${platform.id === state.activePlatform}">
      <i data-lucide="${platformIcon(platform.id)}"></i><span>${escapeHtml(platform.label || platform.id)}</span><span class="platform-tab-dot"></span>
    </button>`).join('');
  $('platform-panels').innerHTML = platforms.length
    ? platforms.map(platformPanelHtml).join('')
    : '<div class="empty-list"><i data-lucide="folder-search"></i><p>Sub2API 当前没有返回可配置分组</p></div>';
  state.dirty = false;
  document.querySelectorAll('.platform-tab').forEach((tab) => {
    tab.addEventListener('click', () => setActivePlatform(tab.dataset.platform));
  });
  document.querySelectorAll('.platform-panel').forEach(bindPanel);
  refreshIcons();
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function optionalNumber(input) {
  return input.value === '' ? undefined : Number(input.value);
}

function collectPlatform(panel) {
  const index = Number(panel.dataset.platformIndex);
  const original = state.data.platforms[index];
  const enabled = panel.querySelector('[data-platform-enabled]').checked;
  const reasoning = panel.querySelector('[data-test="reasoning_effort"]').value;
  const mime = panel.querySelector('[data-test="mime_type"]').value.trim();
  const minWidth = optionalNumber(panel.querySelector('[data-validation="min_width"]'));
  const minHeight = optionalNumber(panel.querySelector('[data-validation="min_height"]'));
  const test = {
    label: panel.querySelector('[data-test="label"]').value.trim(),
    model: panel.querySelector('[data-test="model"]').value.trim(),
    api: panel.querySelector('[data-test="api"]').value,
    prompt: panel.querySelector('[data-test="prompt"]').value.trim(),
    output_type: panel.querySelector('[data-test="output_type"]').value,
    ...(reasoning === 'none' ? {} : { reasoning_effort: reasoning }),
    max_output_tokens: Number(panel.querySelector('[data-test="max_output_tokens"]').value),
    ...(mime ? { mime_type: mime } : {}),
    validation: {
      min_bytes: Number(panel.querySelector('[data-validation="min_bytes"]').value),
      required_patterns: lines(panel.querySelector('[data-validation="required_patterns"]').value),
      forbidden_patterns: lines(panel.querySelector('[data-validation="forbidden_patterns"]').value),
      case_sensitive: panel.querySelector('[data-validation="case_sensitive"]').checked,
      ...(minWidth === undefined ? {} : { min_width: minWidth }),
      ...(minHeight === undefined ? {} : { min_height: minHeight })
    }
  };
  const groups = [...panel.querySelectorAll('.group-row')].map((row, groupIndex) => ({
    id: original.groups[groupIndex].id,
    enabled: enabled && row.querySelector('[data-group-toggle]').checked,
    key: enabled && row.querySelector('[data-group-toggle]').checked
      ? row.querySelector('[data-group-key]').value.trim()
      : ''
  }));
  return { id: original.id, enabled, test, groups };
}

function collect() {
  if (!$('config-form').reportValidity()) return null;
  const scheduleMode = document.querySelector('input[name="schedule-mode"]:checked')?.value || 'daily';
  const scheduleTimes = [...new Set([...$('schedule-times').querySelectorAll('input')]
    .map((input) => input.value)
    .filter(Boolean))].sort();
  const intervalMinutes = Number($('schedule-interval-value').value)
    * intervalUnitMinutes[$('schedule-interval-unit').value];
  return {
    schedule_mode: scheduleMode,
    schedule_times: scheduleTimes,
    schedule_interval_minutes: intervalMinutes,
    platforms: [...document.querySelectorAll('.platform-panel')].map(collectPlatform)
  };
}

async function save() {
  if (state.saving) return;
  const payload = collect();
  if (!payload) return;
  state.saving = true;
  const button = $('save-button');
  button.disabled = true;
  button.classList.add('busy');
  try {
    state.data = await api('/api/admin/config', {
      method: 'PUT',
      body: payload,
      mutation: true
    });
    state.dirty = false;
    render();
    toast('检测配置已保存');
  } catch (error) {
    toast(error.message, 'error');
    if ([401, 403].includes(error.status)) showError('管理员身份已失效，请返回 Sub2API 后重新打开。');
  } finally {
    state.saving = false;
    button.disabled = false;
    button.classList.remove('busy');
  }
}

async function triggerManualRun(button) {
  if (state.dirty || button.disabled) return;
  const groupId = String(button.dataset.groupId || '');
  state.runningGroups.add(groupId);
  const row = button.closest('.group-row');
  const panel = button.closest('.platform-panel');
  updateGroupRow(row, panel.querySelector('[data-platform-enabled]').checked);
  refreshIcons();
  try {
    await api(`/api/admin/groups/${encodeURIComponent(groupId)}/runs`, {
      method: 'POST',
      body: {},
      mutation: true
    });
    toast('检测任务已开始，可在只读结果页查看进度');
  } catch (error) {
    toast(error.message, 'error');
    if ([401, 403].includes(error.status)) showError('管理员身份已失效，请从 Sub2API 重新打开。');
  } finally {
    state.runningGroups.delete(groupId);
    updateGroupRow(row, panel.querySelector('[data-platform-enabled]').checked);
    refreshIcons();
  }
}

function configuredGroup(groupId) {
  for (const platform of state.data?.platforms || []) {
    const group = platform.groups.find((item) => String(item.id) === String(groupId));
    if (group) return group;
  }
  return null;
}

function updateHistoryCount(groupId, count) {
  const group = configuredGroup(groupId);
  if (group) group.history_count = Number(count) || 0;
  document.querySelectorAll('[data-history-button]').forEach((button) => {
    if (String(button.dataset.groupId) !== String(groupId)) return;
    button.querySelector('[data-history-count]').textContent = String(Number(count) || 0);
  });
}

function historyStatus(status) {
  return `<span class="history-status" data-status="${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>`;
}

function renderHistoryList() {
  const list = $('history-list');
  if (state.historyError) {
    list.innerHTML = `<div class="history-empty error"><i data-lucide="circle-alert"></i><p>${escapeHtml(state.historyError)}</p></div>`;
  } else if (state.historyLoading && state.historyRuns.length === 0) {
    list.innerHTML = '<div class="history-empty"><span class="spinner" aria-hidden="true"></span><p>正在读取历史记录</p></div>';
  } else if (state.historyRuns.length === 0) {
    list.innerHTML = '<div class="history-empty"><i data-lucide="history"></i><p>该分组暂无历史检测记录</p></div>';
  } else {
    list.innerHTML = state.historyRuns.map((run) => `
      <label class="history-row" data-status="${escapeHtml(run.status)}" data-deletable="${run.deletable === true}">
        <input type="checkbox" data-history-run-id="${run.id}"
          ${state.historySelected.has(run.id) ? 'checked' : ''} ${run.deletable && !state.historyDeleting ? '' : 'disabled'}>
        <span class="history-row-main">
          <span class="history-row-title"><strong>${escapeHtml(when(run.started))}</strong>${historyStatus(run.status)}</span>
          <span class="history-row-reason">${escapeHtml(run.reason || (run.deletable ? '没有判定说明' : '任务尚未完成'))}</span>
          <small>${escapeHtml(triggerLabels[run.trigger_type] || run.trigger_type || '检测任务')} · ${escapeHtml(run.model || '--')}${run.duration_ms == null ? '' : ` · ${(run.duration_ms / 1000).toFixed(1)} 秒`}</small>
        </span>
      </label>`).join('');
    list.querySelectorAll('[data-history-run-id]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const id = Number(checkbox.dataset.historyRunId);
        if (checkbox.checked) {
          if (state.historySelected.size >= MAX_HISTORY_SELECTION) {
            checkbox.checked = false;
            toast(`单次最多选择 ${MAX_HISTORY_SELECTION} 条，请分批删除或清空该分组`, 'error');
          } else {
            state.historySelected.add(id);
          }
        } else {
          state.historySelected.delete(id);
        }
        updateHistorySelection();
      });
    });
  }
  $('history-load-more').hidden = !state.historyNextCursor;
  $('history-load-more').disabled = state.historyLoading || state.historyDeleting;
  updateHistorySelection();
  refreshIcons();
}

function updateHistorySelection() {
  const deletableIds = state.historyRuns.filter((run) => run.deletable).map((run) => run.id);
  const selectedCount = deletableIds.filter((id) => state.historySelected.has(id)).length;
  const selectAll = $('history-select-all');
  selectAll.disabled = deletableIds.length === 0 || state.historyLoading || state.historyDeleting;
  selectAll.checked = deletableIds.length > 0 && selectedCount === deletableIds.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < deletableIds.length;
  $('history-selection').textContent = `已选择 ${selectedCount}/${MAX_HISTORY_SELECTION} 条`;
  $('history-delete-selected').disabled = selectedCount === 0 || state.historyLoading || state.historyDeleting;
  $('history-clear-all').disabled = state.historyDeletableCount === 0 || state.historyLoading || state.historyDeleting;
}

async function loadHistory(append = false) {
  if (state.historyLoading || !state.historyGroupId) return;
  const groupId = state.historyGroupId;
  const requestId = ++state.historyRequest;
  state.historyLoading = true;
  if (!append) {
    state.historyRuns = [];
    state.historyNextCursor = null;
    state.historySelected.clear();
  }
  state.historyError = '';
  renderHistoryList();
  try {
    const cursor = append && state.historyNextCursor
      ? `&before_id=${encodeURIComponent(state.historyNextCursor)}`
      : '';
    const payload = await api(`/api/admin/groups/${encodeURIComponent(groupId)}/runs?limit=50${cursor}`);
    if (requestId !== state.historyRequest || groupId !== state.historyGroupId || !$('history-dialog').open) return;
    state.historyRuns = append ? [...state.historyRuns, ...payload.runs] : payload.runs;
    state.historyTotal = Number(payload.total) || 0;
    state.historyDeletableCount = Number(payload.deletable_count) || 0;
    state.historyNextCursor = payload.next_cursor;
    $('history-title').textContent = `历史检测记录 · ${payload.group.name}`;
    $('history-meta').textContent = `共 ${state.historyTotal} 条记录 · ${state.historyDeletableCount} 条可清理`;
    updateHistoryCount(groupId, state.historyTotal);
  } catch (error) {
    if (requestId === state.historyRequest) {
      if (append) toast(error.message, 'error');
      else state.historyError = error.message;
      if ([401, 403].includes(error.status)) showError('管理员身份已失效，请从 Sub2API 重新打开。');
    }
  } finally {
    if (requestId === state.historyRequest) {
      state.historyLoading = false;
      renderHistoryList();
    }
  }
}

function openHistory(groupId) {
  const group = configuredGroup(groupId);
  state.historyGroupId = String(groupId);
  state.historyRuns = [];
  state.historyTotal = Number(group?.history_count) || 0;
  state.historyDeletableCount = 0;
  state.historyNextCursor = null;
  state.historySelected.clear();
  state.historyLoading = false;
  state.historyError = '';
  $('history-title').textContent = `历史检测记录 · ${group?.name || groupId}`;
  $('history-meta').textContent = '正在读取记录';
  $('history-dialog').showModal();
  loadHistory(false);
}

function settleConfirmation(accepted) {
  const resolve = state.confirmResolve;
  if (!resolve) return;
  state.confirmResolve = null;
  $('confirm-dialog').close();
  resolve(accepted);
}

function confirmDeletion(message, label) {
  $('confirm-message').textContent = message;
  $('confirm-accept').querySelector('span').textContent = label;
  $('confirm-dialog').showModal();
  refreshIcons();
  return new Promise((resolve) => { state.confirmResolve = resolve; });
}

async function deleteHistory(clearAll) {
  if (state.historyDeleting || !state.historyGroupId) return;
  const ids = [...state.historySelected];
  if (!clearAll && ids.length === 0) return;
  const group = configuredGroup(state.historyGroupId);
  const accepted = await confirmDeletion(
    clearAll
      ? `将永久删除“${group?.name || state.historyGroupId}”的 ${state.historyDeletableCount} 条已结束记录，正在执行的任务会保留。`
      : `将永久删除选中的 ${ids.length} 条历史检测记录。`,
    clearAll ? '确认清空' : '确认删除'
  );
  if (!accepted || !$('history-dialog').open) return;
  state.historyDeleting = true;
  renderHistoryList();
  try {
    const result = await api(`/api/admin/groups/${encodeURIComponent(state.historyGroupId)}/runs`, {
      method: 'DELETE',
      mutation: true,
      body: clearAll ? { all: true } : { run_ids: ids }
    });
    updateHistoryCount(state.historyGroupId, result.total);
    toast(result.deleted ? `已删除 ${result.deleted} 条历史记录` : '没有可删除的历史记录');
    state.historyDeleting = false;
    await loadHistory(false);
  } catch (error) {
    state.historyDeleting = false;
    renderHistoryList();
    toast(error.message, 'error');
    if ([401, 403].includes(error.status)) showError('管理员身份已失效，请从 Sub2API 重新打开。');
  }
}

async function initialize() {
  showView('loading');
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  try {
    const session = await api('/api/auth/me');
    if (session.canOperate !== true) throw Object.assign(new Error('只有 Sub2API 管理员可以访问检测配置。'), { status: 403 });
    state.csrfToken = session.csrfToken || '';
    state.user = session.user;
    state.sessionToken = session.sessionToken || state.sessionToken;
    if (state.sessionToken) sessionStorage.setItem('degradation-detector.session', state.sessionToken);
    $('user-name').textContent = session.user?.name || 'Sub2API 管理员';
    state.data = await api('/api/admin/config');
    $('page-meta').textContent = `管理员配置 · ${state.data.schedule_timezone}`;
    render();
    showView('app');
    refreshIcons();
  } catch (error) {
    showError(error.status === 401
      ? '登录状态无效或已过期，请从 Sub2API 自定义菜单重新打开。'
      : error.message);
  }
}

$('config-form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});
document.querySelectorAll('input[name="schedule-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => syncScheduleMode(true));
});
$('schedule-time-add').addEventListener('click', () => addScheduleTime(suggestedScheduleTime()));
$('schedule-interval-value').addEventListener('input', markDirty);
$('schedule-interval-unit').addEventListener('change', () => {
  updateIntervalLimit();
  markDirty();
});
$('history-close').addEventListener('click', () => {
  if (!state.historyDeleting) $('history-dialog').close();
});
$('history-load-more').addEventListener('click', () => loadHistory(true));
$('history-select-all').addEventListener('change', (event) => {
  const deletableRuns = state.historyRuns.filter((run) => run.deletable);
  if (event.target.checked) {
    let limitReached = false;
    for (const run of deletableRuns) {
      if (state.historySelected.has(run.id)) continue;
      if (state.historySelected.size >= MAX_HISTORY_SELECTION) {
        limitReached = true;
        break;
      }
      state.historySelected.add(run.id);
    }
    if (limitReached) toast(`已选择前 ${MAX_HISTORY_SELECTION} 条，请分批删除或清空该分组`);
  } else {
    deletableRuns.forEach((run) => state.historySelected.delete(run.id));
  }
  renderHistoryList();
});
$('history-delete-selected').addEventListener('click', () => deleteHistory(false));
$('history-clear-all').addEventListener('click', () => deleteHistory(true));
$('history-dialog').addEventListener('close', () => {
  state.historyRequest += 1;
  state.historyGroupId = null;
  state.historyRuns = [];
  state.historySelected.clear();
  state.historyLoading = false;
  state.historyError = '';
});
$('history-dialog').addEventListener('cancel', (event) => {
  if (state.historyDeleting) event.preventDefault();
});
$('confirm-cancel').addEventListener('click', () => settleConfirmation(false));
$('confirm-accept').addEventListener('click', () => settleConfirmation(true));
$('confirm-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  settleConfirmation(false);
});
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

initialize();
