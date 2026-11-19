(() => {
  'use strict';
  const { esc, icon, names, badge, stamp, openHistory, icons } = window.ProviderUI;
  const channels = ['candy', 'pelican', 'testllm'];
  const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const platformNames = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini' };
  const $ = id => document.getElementById(id);
  const state = { data: null, view: 'providers', platform: '', channel: 'candy', dirty: false, saving: false, query: '', group: null, polling: false, drafts: Object.create(null), edited: new Set() };
  let context;
  const field = (label, control) => `<label class="pc-field"><span>${label}</span>${control}</label>`;
  const input = (label, name, value, type = 'text', extra = '') => field(label, `<input type="${type}" name="${name}" value="${esc(value)}" ${extra}>`);
  const select = (label, name, value, options) => field(label, `<select name="${name}">${options.map(([id, text]) => `<option value="${esc(id)}" ${value === id ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`);
  const check = (label, name, value, extra = '') => `<label class="pc-check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${extra}><span>${esc(label)}</span></label>`;
  const platforms = () => [...new Set(state.data.groups.map(group => group.platform))];
  const platformGroups = () => state.data.groups.filter(group => group.platform === state.platform);
  const supports = (platform, channel) => channel !== 'testllm' || ['openai', 'anthropic'].includes(platform);
  const groupEntry = group => group.configurations[state.channel];
  function dirty() {
    state.dirty = true;
    $('pc-save').disabled = state.saving;
    $('pc-save-label').textContent = '保存更改';
    document.querySelectorAll('[data-pc-run],[data-pc-batch]').forEach(button => { button.disabled = true; });
  }
  function platformDraft() {
    if (!state.drafts[state.platform]) {
      const saved = state.data.platforms.find(platform => platform.id === state.platform);
      const group = platformGroups().find(group => channels.some(channel => group.configurations[channel].enabled)) || platformGroups()[0];
      const channel = channels.find(channel => group?.configurations[channel].enabled) || 'candy';
      const legacy = group?.configurations[channel];
      const params = structuredClone(saved?.params || legacy?.override || state.data.channels[channel].defaults);
      if (params.model_source === 'group') params.model = legacy?.model || legacy?.inherited_model || params.model;
      params.model_source = 'default';
      state.drafts[state.platform] = { id: state.platform, params };
    }
    return state.drafts[state.platform];
  }
  function effectiveModel(group) {
    const value = groupEntry(group);
    const platform = state.data.platforms.find(platform => platform.id === group.platform);
    const params = value.override || platform?.params || state.data.channels[state.channel].defaults;
    return params.model_source === 'group' ? value.inherited_model || params.model : params.model;
  }
  function effortField(value) {
    const custom = !reasoningEfforts.includes(value);
    return `<div class="pc-field"><span id="pc-effort-label">思考等级</span><select name="reasoning_effort_preset" data-pc-effort aria-labelledby="pc-effort-label">${[...reasoningEfforts, 'custom'].map(effort => `<option value="${effort}" ${(custom ? 'custom' : value) === effort ? 'selected' : ''}>${effort === 'custom' ? '自定义' : effort}</option>`).join('')}</select><input type="text" name="reasoning_effort" value="${esc(value)}" maxlength="64" required aria-label="自定义思考等级" ${custom ? '' : 'hidden disabled'}></div>`;
  }
  function syncEffort(event) {
    if (!event.target.matches('[data-pc-effort]')) return;
    const control = event.target.closest('.pc-field').querySelector('[name="reasoning_effort"]');
    const custom = event.target.value === 'custom';
    control.hidden = !custom; control.disabled = !custom;
    if (custom) control.focus(); else control.value = event.target.value;
  }
  function render() {
    if (!state.data) return;
    if (!platforms().includes(state.platform)) state.platform = platforms()[0] || '';
    if (!supports(state.platform, state.channel)) state.channel = 'candy';
    $('provider-config').innerHTML = `<header class="pc-heading"><div><h2>第三方降智检测</h2><span class="p-muted">${state.data.demo ? '演示配置 · ' : ''}${state.data.groups.length} 个可管理分组 · ${state.data.timezone}</span></div><div class="pc-actions"><button id="pc-reload" class="icon-button" type="button" title="重新读取配置" aria-label="重新读取配置">${icon('refresh-cw')}</button><button id="pc-save" class="button primary" type="button" ${state.saving ? 'disabled' : ''}>${icon('save')}<span id="pc-save-label">${state.dirty ? '保存更改' : '保存三方配置'}</span></button></div></header>
      <nav class="p-tabs pc-main-tabs" role="tablist" aria-label="配置区域">${[['providers', 'plug-zap', '第三方接口'], ['platforms', 'layers', 'AI 平台配置'], ['schedule', 'calendar-clock', '检测计划']].map(([id, symbol, label]) => `<button type="button" id="pc-view-${id}" data-pc-view="${id}" role="tab" aria-controls="pc-view-panel" aria-selected="${state.view === id}" tabindex="${state.view === id ? 0 : -1}">${icon(symbol)}${label}</button>`).join('')}</nav>
      <section id="pc-view-panel" role="tabpanel" aria-labelledby="pc-view-${state.view}">${state.view === 'providers' ? providersView() : state.view === 'platforms' ? platformView() : scheduleView()}</section>`;
    $('pc-save').onclick = save;
    $('pc-reload').onclick = async () => { if (!state.dirty || confirm('放弃尚未保存的三方配置并重新读取？')) await load().catch(handleError); };
    icons();
  }
  function providersView() {
    return `<form id="pc-provider-form" autocomplete="off">${[['manxue', '满血 AI', '任务接口地址'], ['testllm', 'TestLLM', '服务地址']].map(([id, name, label]) => {
      const provider = state.data.providers[id];
      return `<section class="pc-section" data-pc-site="${id}"><div class="pc-section-head"><h3>${name}</h3>${check('启用此第三方', 'provider_enabled', provider.enabled)}</div><div class="pc-fields">${input(label, 'api_url', provider.api_url, 'url', 'maxlength="2048"')}</div></section>`;
    }).join('')}<section class="pc-section"><h3>检测开关与运行设置</h3>${channels.map(channel => {
      const settings = state.data.channels[channel];
      return `<div class="pc-runtime" data-pc-runtime="${channel}">${check(names[channel], 'channel_enabled', settings.enabled)}${input('单次超时（秒）', 'timeout_seconds', settings.timeout_seconds, 'number', 'required min="30" max="1800"')}${input('类别并发上限', 'concurrency', settings.concurrency, 'number', 'required min="1" max="4"')}</div>`;
    }).join('')}<p class="pc-note">三方检测总并发上限 ${state.data.total_concurrency}。</p></section></form>`;
  }
  function platformView() {
    if (!state.platform) return '<p class="pc-note">暂无可管理的分组。</p>';
    const params = platformDraft().params;
    const legacy = platformGroups().filter(group => channels.some(channel => group.configurations[channel].override));
    return `<nav class="p-tabs pc-platform-tabs" role="tablist" aria-label="Sub2API 平台类型">${platforms().map(id => `<button type="button" id="pc-platform-${esc(id)}" data-pc-platform="${esc(id)}" role="tab" aria-controls="pc-platform-panel" aria-selected="${id === state.platform}" tabindex="${id === state.platform ? 0 : -1}">${esc(platformNames[id] || id)}<span class="pc-tab-count">${state.data.groups.filter(group => group.platform === id).length}</span></button>`).join('')}</nav>
      <section id="pc-platform-panel" role="tabpanel" aria-labelledby="pc-platform-${esc(state.platform)}"><form id="pc-platform-form" autocomplete="off"><section class="pc-section"><div class="pc-section-head"><h3>${esc(platformNames[state.platform] || state.platform)} 共享检测参数</h3>${legacy.length ? `<button type="button" class="button" data-pc-unify>${icon('combine')}统一平台参数</button>` : ''}</div><div class="pc-fields">${input('上游 API 地址', 'target_url', params.target_url, 'url', 'maxlength="2048" placeholder="https://api.your-domain.com/v1"')}${input('检测模型', 'model', params.model, 'text', 'maxlength="200"')}${effortField(params.reasoning_effort)}${select('服务档位', 'service_tier', params.service_tier, [['', '默认'], ['priority', 'Fast / priority'], ['ultrafast', 'UltraFast / ultrafast']])}${select('TestLLM 协议', 'protocol', params.protocol, [['auto', '跟随 AI 平台'], ['gpt', 'GPT'], ['claude', 'Claude']])}</div><div class="pc-checks">${check('TestLLM 缓存检测', 'cache_test', params.cache_test)}${check('TestLLM 思考与签名检测', 'thinking_test', params.thinking_test)}</div>${legacy.length ? `<p class="pc-note">${legacy.length} 个分组保留已保存的独立参数；修改平台参数后统一应用。</p>` : ''}</section></form>${groupsView()}</section>`;
  }
  function groupsView() {
    const rows = platformGroups().filter(group => `${group.name} ${effectiveModel(group)}`.toLowerCase().includes(state.query));
    return `<section class="pc-section"><h3>参与检测的分组</h3><div class="pc-group-toolbar"><label class="p-search">${icon('search')}<input type="search" id="pc-group-query" value="${esc(state.query)}" placeholder="搜索分组" aria-label="搜索分组"></label><label class="pc-history-channel"><span>检测记录</span><select id="pc-history-channel" aria-label="检测记录类别">${channels.filter(channel => supports(state.platform, channel)).map(channel => `<option value="${channel}" ${channel === state.channel ? 'selected' : ''}>${names[channel]}</option>`).join('')}</select></label><button type="button" class="button" data-pc-batch ${state.dirty ? 'disabled' : ''}>${icon('play')}检测本平台已启用分组</button></div><div class="p-table-scroll"><table class="p-table pc-group-table"><thead><tr><th scope="col">分组 / 检测模型</th>${channels.map(channel => `<th scope="col">${names[channel]}</th>`).join('')}<th scope="col">专用 Key</th><th scope="col">${names[state.channel]}状态 / 下次计划</th><th scope="col">操作</th></tr></thead><tbody>${rows.map(group => {
      const value = groupEntry(group);
      const keys = channels.filter(channel => supports(group.platform, channel));
      const configured = keys.filter(channel => !group.configurations[channel].clear_key && (group.configurations[channel].key_configured || group.configurations[channel].key)).length;
      const pending = keys.some(channel => group.configurations[channel].key || group.configurations[channel].clear_key);
      return `<tr><td><strong>${esc(group.name)}</strong><small>${esc(effectiveModel(group))}</small></td>${channels.map(channel => `<td><input type="checkbox" data-pc-enabled="${esc(group.id)}" data-pc-category="${channel}" aria-label="启用 ${esc(group.name)} 的${names[channel]}" ${group.configurations[channel].enabled ? 'checked' : ''} ${supports(group.platform, channel) ? '' : 'disabled'}></td>`).join('')}<td><span class="${configured ? 'p-green' : 'p-muted'}">${pending ? '待保存' : configured === keys.length ? '已配置' : configured ? `已配置 ${configured}/${keys.length}` : '待配置'}</span></td><td>${badge(value.latest)}<small>${value.next_run_at ? stamp(value.next_run_at) : '自动计划未启用'}</small></td><td><div class="pc-row-actions"><button class="icon-button" type="button" data-pc-edit="${esc(group.id)}" title="配置分组 Key" aria-label="配置 ${esc(group.name)} 的 Key">${icon('key-round')}</button><button class="icon-button" type="button" data-pc-run="${esc(group.id)}" ${state.dirty || !value.enabled ? 'disabled' : ''} title="立即检测" aria-label="立即检测 ${esc(group.name)}">${icon('play')}</button><button class="icon-button" type="button" data-pc-history="${esc(group.id)}" title="查看历史" aria-label="查看 ${esc(group.name)} 历史">${icon('history')}</button><button class="icon-button" type="button" data-pc-delete="${esc(group.id)}" title="清空已完成历史" aria-label="清空 ${esc(group.name)} 已完成历史">${icon('trash-2')}</button></div></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
  }
  function scheduleView() {
    return `<div class="pc-section-head"><h3>独立检测计划</h3><span class="p-muted">Asia/Shanghai</span></div>${channels.map(channel => {
      const plan = state.data.channels[channel].schedule;
      return `<section class="pc-plan" data-pc-plan="${channel}"><header><h3>${names[channel]}</h3>${check('启用自动检测', 'schedule_enabled', plan.enabled)}</header><div class="pc-plan-fields"><fieldset class="pc-radio" aria-label="${names[channel]}计划模式"><label><input type="radio" name="schedule_mode_${channel}" value="daily" ${plan.mode === 'daily' ? 'checked' : ''}>固定时间</label><label><input type="radio" name="schedule_mode_${channel}" value="interval" ${plan.mode === 'interval' ? 'checked' : ''}>间隔执行</label></fieldset>${plan.mode === 'daily' ? `<div class="pc-times">${plan.times.map((time, index) => `<div><input type="time" data-pc-time="${index}" value="${time}" aria-label="${names[channel]}执行时间 ${index + 1}"><button type="button" class="icon-button" data-pc-remove-time="${index}" ${plan.times.length === 1 ? 'disabled' : ''} title="删除时间" aria-label="删除时间">${icon('minus')}</button></div>`).join('')}<button type="button" class="icon-button" data-pc-add-time ${plan.times.length >= 24 ? 'disabled' : ''} title="添加时间" aria-label="添加时间">${icon('plus')}</button></div>` : input('间隔（分钟）', 'interval_minutes', plan.interval_minutes, 'number', 'min="1" max="43200" required')}</div></section>`;
    }).join('')}`;
  }
  function readParams(root, previous) {
    const params = structuredClone(previous);
    for (const key of Object.keys(params)) {
      const control = root.querySelector(`[name="${key}"]`);
      if (control) params[key] = control.type === 'checkbox' ? control.checked : control.value.trim();
    }
    params.model_source = 'default';
    return params;
  }
  function captureProviders() {
    const form = $('pc-provider-form'); if (!form) return;
    form.querySelectorAll('[data-pc-site]').forEach(section => {
      const provider = state.data.providers[section.dataset.pcSite];
      provider.enabled = section.querySelector('[name="provider_enabled"]').checked;
      provider.api_url = section.querySelector('[name="api_url"]').value.trim();
    });
    form.querySelectorAll('[data-pc-runtime]').forEach(section => {
      const settings = state.data.channels[section.dataset.pcRuntime];
      settings.enabled = section.querySelector('[name="channel_enabled"]').checked;
      for (const name of ['timeout_seconds', 'concurrency']) settings[name] = Number(section.querySelector(`[name="${name}"]`).value);
    });
  }
  function applyPlatform() {
    const draft = structuredClone(platformDraft());
    const index = state.data.platforms.findIndex(platform => platform.id === draft.id);
    if (index < 0) state.data.platforms.push(draft); else state.data.platforms[index] = draft;
    for (const group of platformGroups()) for (const channel of channels) group.configurations[channel].override = null;
    state.edited.add(state.platform);
  }
  function capturePlatform(apply = false) {
    const form = $('pc-platform-form'); if (!form) return;
    platformDraft().params = readParams(form, platformDraft().params);
    if (apply || state.edited.has(state.platform)) applyPlatform();
  }
  function capture() { captureProviders(); capturePlatform(); }
  function valid() { return [...document.querySelectorAll('#pc-provider-form,#pc-platform-form')].every(form => form.reportValidity()); }
  function payload() {
    capture();
    const { revision, providers, channels: settings, platforms: platformSettings } = state.data;
    return { revision, providers, channels: settings, platforms: platformSettings, groups: state.data.groups.flatMap(group => channels.map(channel => {
      const value = group.configurations[channel];
      return { id: group.id, channel, enabled: value.enabled, override: value.override, ...(value.key ? { key: value.key } : {}), ...(value.clear_key ? { clear_key: true } : {}) };
    })) };
  }
  function handleError(error) {
    context.toast(error.message, 'error');
    if ([401, 403].includes(error.status)) { reset(); context.showError('管理员身份已失效，请从 Sub2API 重新打开。'); }
  }
  async function save() {
    if (state.saving || !valid()) return;
    state.saving = true; $('pc-save').disabled = true;
    try {
      state.data = await context.api('/api/admin/provider-config', { method: 'PUT', body: payload(), mutation: true });
      state.dirty = false; state.drafts = Object.create(null); state.edited.clear();
      context.toast('第三方检测配置已保存');
    } catch (error) { handleError(error); }
    finally { state.saving = false; render(); }
  }
  async function load() {
    state.data = await context.api('/api/admin/provider-config');
    state.data.platforms ||= []; state.dirty = false; state.drafts = Object.create(null); state.edited.clear(); render();
  }
  function openGroup(id) {
    const group = state.data.groups.find(group => group.id === id); if (!group) return;
    state.group = id;
    const statuses = channels.filter(channel => supports(group.platform, channel)).map(channel => `${names[channel]}：${group.configurations[channel].key_configured ? '已配置' : '待配置'}`);
    const pending = channels.map(channel => group.configurations[channel].key).find(Boolean) || '';
    $('pc-group-title').textContent = `${group.name} · 分组 Key`;
    $('pc-group-body').innerHTML = `<p class="pc-note">${esc(statuses.join(' · '))}</p>${input('分组专用 Key', 'key', pending, 'password', 'maxlength="8192" autocomplete="new-password" placeholder="留空保留已保存的 Key"')}<p class="pc-note">新 Key 用于此分组的糖果、鹈鹕及 TestLLM 检测。</p>${check('清除已保存的 Key', 'clear_key', channels.some(channel => group.configurations[channel].clear_key))}<p id="pc-group-error" role="alert" class="p-history-error"></p>`;
    $('pc-group-dialog').showModal(); icons();
  }
  function applyGroup(event) {
    event.preventDefault(); const form = $('pc-group-form'); if (!form.reportValidity()) return;
    if (form.elements.key.value && form.elements.clear_key.checked) { $('pc-group-error').textContent = '不能同时设置和清除 Key'; return; }
    const group = state.data.groups.find(group => group.id === state.group);
    for (const channel of channels) { const value = group.configurations[channel]; value.key = form.elements.key.value; value.clear_key = form.elements.clear_key.checked; }
    dirty(); $('pc-group-dialog').close(); render();
  }
  async function run(id = null) {
    if (state.dirty || state.saving) return;
    const path = id ? `/api/admin/provider/groups/${encodeURIComponent(id)}/${state.channel}/runs` : `/api/admin/provider/${state.channel}/runs`;
    try {
      const result = await context.api(path, { method: 'POST', body: id ? {} : { platform: state.platform }, mutation: true });
      context.toast(`已加入检测队列：${result.runs?.length || 1} 个任务`); await load();
    } catch (error) { handleError(error); }
  }
  async function removeHistory(id) {
    const group = state.data.groups.find(group => group.id === id);
    if (!confirm(`清空 ${group.name} 的${names[state.channel]}已完成历史及累计记录？`)) return;
    try {
      const result = await context.api(`/api/admin/provider/groups/${encodeURIComponent(id)}/${state.channel}/runs`, { method: 'DELETE', body: { all: true }, mutation: true });
      context.toast(`已删除 ${result.deleted} 条记录`); if (!state.dirty) await load();
    } catch (error) { handleError(error); }
  }
  function reset() {
    state.data = null; state.dirty = false; state.drafts = Object.create(null); state.edited.clear();
    if ($('pc-group-dialog')?.open) $('pc-group-dialog').close();
    $('pc-group-body')?.replaceChildren(); $('provider-config')?.replaceChildren(); window.ProviderUI.clearHistory();
  }
  function connect(value) {
    context = value; const root = $('provider-config');
    root.addEventListener('submit', event => { event.preventDefault(); save(); });
    root.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled || state.saving) return;
      const data = button.dataset;
      if (data.pcView || data.pcPlatform) {
        if (!valid()) return; capture();
        if (data.pcView) state.view = data.pcView;
        if (data.pcPlatform) { state.platform = data.pcPlatform; state.query = ''; }
        if (!supports(state.platform, state.channel)) state.channel = 'candy';
        render();
      } else if ('pcUnify' in data) { if (!valid()) return; capturePlatform(true); dirty(); render(); }
      else if (data.pcEdit) openGroup(data.pcEdit);
      else if (data.pcRun) run(data.pcRun);
      else if ('pcBatch' in data) run();
      else if (data.pcHistory) openHistory(context.api, state.data.groups.find(group => group.id === data.pcHistory), state.channel, { admin: true });
      else if (data.pcDelete) removeHistory(data.pcDelete);
      else if ('pcAddTime' in data || 'pcRemoveTime' in data) {
        const plan = state.data.channels[button.closest('[data-pc-plan]').dataset.pcPlan].schedule;
        if ('pcRemoveTime' in data) plan.times.splice(Number(data.pcRemoveTime), 1);
        else { const time = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).find(time => !plan.times.includes(time)); if (time) plan.times.push(time); }
        dirty(); render();
      }
    });
    root.addEventListener('input', event => {
      syncEffort(event);
      if (event.target.id === 'pc-group-query') {
        const position = event.target.selectionStart; state.query = event.target.value.toLowerCase(); render();
        $('pc-group-query').focus(); $('pc-group-query').setSelectionRange(position, position); return;
      }
      if (event.target.closest('#pc-provider-form')) { captureProviders(); dirty(); }
      if (event.target.closest('#pc-platform-form')) { capturePlatform(true); dirty(); }
      const plan = event.target.closest('[data-pc-plan]');
      if (plan) {
        const schedule = state.data.channels[plan.dataset.pcPlan].schedule;
        if ('pcTime' in event.target.dataset) schedule.times[Number(event.target.dataset.pcTime)] = event.target.value;
        if (event.target.name === 'interval_minutes') schedule.interval_minutes = Number(event.target.value);
        dirty();
      }
    });
    root.addEventListener('change', event => {
      const input = event.target;
      if (input.dataset.pcEnabled) { state.data.groups.find(group => group.id === input.dataset.pcEnabled).configurations[input.dataset.pcCategory].enabled = input.checked; dirty(); }
      if (input.id === 'pc-history-channel') { capturePlatform(); state.channel = input.value; render(); }
      const plan = input.closest('[data-pc-plan]');
      if (plan) {
        const schedule = state.data.channels[plan.dataset.pcPlan].schedule;
        if (input.name === 'schedule_enabled') schedule.enabled = input.checked;
        if (input.type === 'radio') schedule.mode = input.value;
        dirty(); if (input.type === 'radio') render();
      }
    });
    root.addEventListener('keydown', event => {
      if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); const id = tabs[index].id; tabs[index].click(); $(id)?.focus();
    });
    $('pc-group-form').addEventListener('submit', applyGroup);
    $('pc-group-close').onclick = () => $('pc-group-dialog').close();
    $('pc-group-cancel').onclick = () => $('pc-group-dialog').close();
    $('pc-group-reset').onclick = () => { const form = $('pc-group-form'); form.elements.key.value = ''; form.elements.clear_key.checked = false; };
    $('pc-group-dialog').addEventListener('close', () => { state.group = null; $('pc-group-body').replaceChildren(); });
    $('pc-group-body').addEventListener('focusin', event => { if (event.target.matches('input,select')) event.target.scrollIntoView({ block: 'nearest' }); });
    window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
    setInterval(async () => {
      if (!state.data || state.dirty || state.saving || state.polling || document.hidden || $('pc-group-dialog').open) return;
      if (!state.data.groups.some(group => channels.some(channel => ['queued', 'running'].includes(group.configurations[channel].latest?.status)))) return;
      state.polling = true;
      try { await load(); } catch (error) { handleError(error); } finally { state.polling = false; }
    }, 5000);
  }
  window.ProviderConfig = { connect, load, reset };
})();
