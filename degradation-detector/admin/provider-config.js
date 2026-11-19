(() => {
  'use strict';
  const { esc, icon, names, badge, stamp, openHistory, icons } = window.ProviderUI;
  const channels = ['candy', 'pelican', 'testllm'];
  const $ = id => document.getElementById(id);
  const state = { data: null, channel: 'candy', view: 'connection', dirty: false, saving: false, query: '', group: null, polling: false };
  let context;
  const provider = () => state.channel === 'testllm' ? 'testllm' : 'manxue';
  const entry = () => state.data.channels[state.channel];
  const groupEntry = group => group.configurations[state.channel];
  const displayModel = group => {
    const config = groupEntry(group);
    const params = config.override || entry().defaults;
    return state.channel === 'testllm' && params.model_source === 'group' ? config.inherited_model || params.model : params.model;
  };
  const field = (label, control) => `<label class="pc-field"><span>${label}</span>${control}</label>`;
  const input = (label, name, value, type = 'text', extra = '') => field(label, `<input type="${type}" name="${name}" value="${esc(value)}" ${extra}>`);
  const select = (label, name, value, options) => field(label, `<select name="${name}">${options.map(([id, text]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${text}</option>`).join('')}</select>`);
  const check = (label, name, value, extra = '') => `<label class="pc-check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${extra}><span>${label}</span></label>`;
  function dirty() { state.dirty = true; $('pc-save').disabled = state.saving; $('pc-save-label').textContent = '保存更改'; document.querySelectorAll('[data-pc-run],[data-pc-batch]').forEach(button => { button.disabled = true; }); }
  function paramsFields(params) {
    const llm = state.channel === 'testllm';
    return `<div class="pc-fields">${input('上游 API 地址', 'target_url', params.target_url, 'url', 'maxlength="2048" placeholder="https://api.your-domain.com/v1"')}${input('检测模型', 'model', params.model, 'text', 'maxlength="200"')}${llm ? select('模型来源', 'model_source', params.model_source, [['group', '跟随原有分组检测模型'], ['default', '使用此处指定模型']]) + select('接口协议', 'protocol', params.protocol, [['auto', '跟随分组平台'], ['gpt', 'GPT'], ['claude', 'Claude']]) : select('推理程度', 'reasoning_effort', params.reasoning_effort, (state.channel === 'pelican' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).map(id => [id, id])) + select('服务档位', 'service_tier', params.service_tier, [['', '默认'], ['priority', 'Fast / priority'], ['ultrafast', 'UltraFast / ultrafast']])}</div>${llm ? `<div class="pc-checks">${check('检测缓存率', 'cache_test', params.cache_test)}${check('检测思考与签名', 'thinking_test', params.thinking_test)}</div>` : ''}`;
  }
  function readParams(root, previous) {
    const params = structuredClone(previous);
    for (const key of Object.keys(params)) {
      const control = root.querySelector(`[name="${key}"]`);
      if (control) params[key] = control.type === 'checkbox' ? control.checked : control.value.trim();
    }
    return params;
  }
  function render() {
    if (!state.data) return;
    const llm = state.channel === 'testllm';
    const root = $('provider-config');
    root.innerHTML = `<header class="pc-heading"><div><h2>第三方降智检测</h2><span class="p-muted">${state.data.demo ? '演示配置 · ' : ''}${state.data.groups.length} 个可管理分组 · ${state.data.timezone}</span></div><div class="pc-actions"><button id="pc-reload" class="icon-button" type="button" title="重新读取配置" aria-label="重新读取配置">${icon('refresh-cw')}</button><button id="pc-save" class="button primary" type="button" ${state.saving ? 'disabled' : ''}>${icon('save')}<span id="pc-save-label">${state.dirty ? '保存更改' : '保存三方配置'}</span></button></div></header>
      <nav class="p-tabs" role="tablist" aria-label="第三方服务"><button id="pc-manxue" type="button" data-pc-provider="manxue" role="tab" aria-controls="pc-provider-panel" aria-selected="${!llm}" tabindex="${llm ? -1 : 0}"><span class="p-mark">满</span>满血 AI</button><button id="pc-testllm" type="button" data-pc-provider="testllm" role="tab" aria-controls="pc-provider-panel" aria-selected="${llm}" tabindex="${llm ? 0 : -1}"><span class="p-mark p-blue">T</span>TestLLM</button></nav>
      <section id="pc-provider-panel" role="tabpanel" aria-labelledby="pc-${llm ? 'testllm' : 'manxue'}"><div class="p-subbar">${!llm ? `<nav class="p-segmented" role="tablist" aria-label="满血 AI 类别">${['candy', 'pelican'].map(channel => `<button type="button" id="pc-${channel}" role="tab" aria-controls="pc-category-panel" data-pc-channel="${channel}" aria-selected="${state.channel === channel}" tabindex="${state.channel === channel ? 0 : -1}">${icon(channel === 'candy' ? 'candy' : 'bike')}${names[channel]}</button>`).join('')}</nav>` : '<strong>TestLLM 推理检测</strong>'}<nav class="pc-views" aria-label="配置视图">${[['connection', 'plug-zap', '第三方接入'], ['groups', 'layers', '分组 / 模型'], ['schedule', 'calendar-clock', '检测计划']].map(([id, symbol, label]) => `<button class="button" type="button" data-pc-view="${id}" aria-pressed="${state.view === id}">${icon(symbol)}${label}</button>`).join('')}</nav></div><section id="pc-category-panel" ${!llm ? `role="tabpanel" aria-labelledby="pc-${state.channel}"` : ''}>${state.view === 'connection' ? connection() : state.view === 'groups' ? groups() : schedule()}</section></section>`;
    $('pc-save').onclick = save;
    $('pc-reload').onclick = async () => { if (!state.dirty || confirm('放弃尚未保存的三方配置并重新读取？')) await load().catch(handleError); };
    icons();
  }
  function connection() {
    const settings = entry();
    const site = state.data.providers[provider()];
    return `<form id="pc-connection-form" autocomplete="off"><section class="pc-section"><div class="pc-section-head"><h3>${names[state.channel]}</h3>${check('启用此检测', 'channel_enabled', settings.enabled)}</div><div class="pc-fields">${input(state.channel === 'testllm' ? 'TestLLM 服务地址' : '满血 AI 任务接口', 'api_url', site.api_url, 'url', 'maxlength="2048"')}${field('第三方服务', check('启用此第三方', 'provider_enabled', site.enabled))}</div></section><section class="pc-section"><h3>默认检测参数</h3>${paramsFields(settings.defaults)}${state.channel === 'testllm' ? '<p class="pc-note">跟随原有分组检测模型；未配置时使用上方模型。缓存、思考签名各执行一次独立检测。</p>' : '<p class="pc-note">满血 AI 需要支持 Responses 的上游。鹈鹕分类器基于 gpt-6-astra，其他模型的结论仅供参考。</p>'}</section><section class="pc-section"><h3>运行设置</h3><div class="pc-fields">${input('单次任务超时（秒）', 'timeout_seconds', settings.timeout_seconds, 'number', 'required min="30" max="1800"')}${input('此类别并发上限', 'concurrency', settings.concurrency, 'number', 'required min="1" max="4"')}</div><p class="pc-note">三方检测总并发上限 ${state.data.total_concurrency}。分组专用 Key 在分组管理中配置；变更检测网站或上游地址后需重新填写。</p></section></form>`;
  }
  function groups() {
    const rows = state.data.groups.filter(group => `${group.name} ${group.platform} ${displayModel(group)}`.toLowerCase().includes(state.query));
    return `<div class="pc-group-toolbar"><label class="p-search">${icon('search')}<input type="search" id="pc-group-query" value="${esc(state.query)}" placeholder="搜索分组或平台" aria-label="搜索分组或平台"></label><button type="button" class="button" data-pc-batch ${state.dirty ? 'disabled' : ''}>${icon('play')}检测已启用分组</button><span class="p-muted">${rows.length} 个分组</span></div><div class="p-table-scroll"><table class="p-table pc-group-table"><thead><tr><th scope="col">启用</th><th scope="col">分组 / 模型</th><th scope="col">专用 Key</th><th scope="col">参数</th><th scope="col">最近状态 / 下次计划</th><th scope="col">操作</th></tr></thead><tbody>${rows.map(group => {
      const value = groupEntry(group);
      return `<tr><td><input type="checkbox" data-pc-enabled="${esc(group.id)}" aria-label="启用 ${esc(group.name)}" ${value.enabled ? 'checked' : ''}></td><td><strong>${esc(group.name)}</strong><small>${esc(displayModel(group))} · ${esc(group.platform)}</small></td><td><span class="${value.key_reconfirm_required ? 'p-amber' : value.key_configured || value.key ? 'p-green' : 'p-muted'}">${value.key ? '待保存' : value.key_reconfirm_required ? '需重新填写' : value.key_configured ? '已配置' : '待配置'}</span></td><td>${value.override ? '独立参数' : '继承默认'}</td><td>${badge(value.latest)}<small>${value.next_run_at ? stamp(value.next_run_at) : '自动计划未启用'}</small></td><td><div class="pc-row-actions"><button class="icon-button" type="button" data-pc-edit="${esc(group.id)}" title="配置 ${esc(group.name)}" aria-label="配置 ${esc(group.name)}">${icon('sliders-horizontal')}</button><button class="icon-button" type="button" data-pc-run="${esc(group.id)}" ${state.dirty || !value.enabled ? 'disabled' : ''} title="立即检测" aria-label="立即检测 ${esc(group.name)}">${icon('play')}</button><button class="icon-button" type="button" data-pc-history="${esc(group.id)}" title="查看历史" aria-label="查看 ${esc(group.name)} 历史">${icon('history')}</button><button class="icon-button" type="button" data-pc-delete="${esc(group.id)}" title="清空已完成历史" aria-label="清空 ${esc(group.name)} 已完成历史">${icon('trash-2')}</button></div></td></tr>`;
    }).join('')}</tbody></table></div><p class="pc-note">运行使用最近保存的配置；进行中的任务保留，清空历史仅删除已结束记录。</p>`;
  }
  function schedule() {
    return `<div class="pc-section-head"><h3>独立检测计划</h3><span class="p-muted">Asia/Shanghai</span></div>${channels.map(channel => {
      const plan = state.data.channels[channel].schedule;
      return `<section class="pc-plan" data-pc-plan="${channel}"><header><h3>${names[channel]}</h3>${check('启用自动检测', 'schedule_enabled', plan.enabled)}</header><div class="pc-plan-fields"><fieldset class="pc-radio" aria-label="${names[channel]}计划模式"><label><input type="radio" name="schedule_mode_${channel}" value="daily" ${plan.mode === 'daily' ? 'checked' : ''}>固定时间</label><label><input type="radio" name="schedule_mode_${channel}" value="interval" ${plan.mode === 'interval' ? 'checked' : ''}>间隔执行</label></fieldset>${plan.mode === 'daily' ? `<div class="pc-times">${plan.times.map((time, index) => `<div><input type="time" data-pc-time="${index}" value="${time}" aria-label="${names[channel]}执行时间 ${index + 1}"><button type="button" class="icon-button" data-pc-remove-time="${index}" ${plan.times.length === 1 ? 'disabled' : ''} title="删除时间" aria-label="删除时间">${icon('minus')}</button></div>`).join('')}<button type="button" class="icon-button" data-pc-add-time ${plan.times.length >= 24 ? 'disabled' : ''} title="添加时间" aria-label="添加时间">${icon('plus')}</button></div>` : input('间隔（分钟）', 'interval_minutes', plan.interval_minutes, 'number', 'min="1" max="43200" required')}</div></section>`;
    }).join('')}`;
  }
  function captureConnection() {
    const form = $('pc-connection-form');
    if (!form) return;
    const settings = entry();
    settings.defaults = readParams(form, settings.defaults);
    settings.enabled = form.elements.channel_enabled.checked;
    settings.timeout_seconds = Number(form.elements.timeout_seconds.value);
    settings.concurrency = Number(form.elements.concurrency.value);
    const site = state.data.providers[provider()];
    site.enabled = form.elements.provider_enabled.checked;
    site.api_url = form.elements.api_url.value.trim();
  }
  function payload() {
    captureConnection();
    const { revision, providers, channels: settings } = state.data;
    return { revision, providers, channels: settings, groups: state.data.groups.flatMap(group => channels.map(channel => {
      const config = group.configurations[channel];
      return { id: group.id, channel, enabled: config.enabled, override: config.override, ...(config.key ? { key: config.key } : {}), ...(config.clear_key ? { clear_key: true } : {}) };
    })) };
  }
  function handleError(error) {
    context.toast(error.message, 'error');
    if ([401, 403].includes(error.status)) { reset(); context.showError('管理员身份已失效，请从 Sub2API 重新打开。'); }
  }
  async function save() {
    if (state.saving) return;
    const form = $('pc-connection-form');
    if (form && !form.reportValidity()) return;
    state.saving = true;
    $('pc-save').disabled = true;
    try {
      state.data = await context.api('/api/admin/provider-config', { method: 'PUT', body: payload(), mutation: true });
      state.dirty = false;
      context.toast('第三方检测配置已保存');
    } catch (error) { handleError(error); }
    finally { state.saving = false; render(); }
  }
  async function load() { state.data = await context.api('/api/admin/provider-config'); state.dirty = false; render(); }
  function openGroup(id) {
    const group = state.data.groups.find(group => group.id === id);
    if (!group) return;
    state.group = id;
    const config = groupEntry(group);
    const params = config.override || entry().defaults;
    $('pc-group-title').textContent = `${group.name} · ${names[state.channel]}`;
    $('pc-group-body').innerHTML = `${check('使用分组独立参数', 'override_enabled', Boolean(config.override))}<fieldset id="pc-override-fields" ${config.override ? '' : 'disabled'}>${paramsFields(params)}</fieldset><section class="pc-section"><h3>分组专用 Key</h3><p class="pc-note">${config.key_configured ? '已配置，留空保留现有 Key' : '尚未配置'}${config.key_reconfirm_required ? '；地址变更，请重新填写' : ''}</p>${input('更换专用 Key', 'key', config.key || '', 'password', 'maxlength="8192" autocomplete="new-password"')}${check('清除现有 Key', 'clear_key', config.clear_key)}</section><p id="pc-group-error" role="alert" class="p-history-error"></p>`;
    $('pc-group-dialog').showModal(); icons();
  }
  function applyGroup(event) {
    event.preventDefault();
    if (!$('pc-group-form').reportValidity()) return;
    const config = groupEntry(state.data.groups.find(group => group.id === state.group));
    const form = $('pc-group-form');
    if (form.elements.key.value && form.elements.clear_key.checked) { $('pc-group-error').textContent = '不能同时设置和清除 Key'; return; }
    config.override = form.elements.override_enabled.checked ? readParams($('pc-override-fields'), config.override || entry().defaults) : null;
    config.key = form.elements.key.value;
    config.clear_key = form.elements.clear_key.checked;
    dirty(); $('pc-group-dialog').close(); render();
  }
  async function run(id = null) {
    if (state.dirty || state.saving) return;
    const path = id ? `/api/admin/provider/groups/${encodeURIComponent(id)}/${state.channel}/runs` : `/api/admin/provider/${state.channel}/runs`;
    try {
      const result = await context.api(path, { method: 'POST', body: {}, mutation: true });
      context.toast(`已加入检测队列：${result.runs?.length || 1} 个任务`);
      await load();
    } catch (error) { handleError(error); }
  }
  async function removeHistory(id) {
    const group = state.data.groups.find(group => group.id === id);
    if (!confirm(`清空 ${group.name} 的${names[state.channel]}已完成历史及累计记录？`)) return;
    try {
      const result = await context.api(`/api/admin/provider/groups/${encodeURIComponent(id)}/${state.channel}/runs`, { method: 'DELETE', body: { all: true }, mutation: true });
      context.toast(`已删除 ${result.deleted} 条记录`);
      if (!state.dirty) await load();
    } catch (error) { handleError(error); }
  }
  function reset() {
    state.data = null; state.dirty = false;
    if ($('pc-group-dialog')?.open) $('pc-group-dialog').close();
    $('pc-group-body')?.replaceChildren(); $('provider-config')?.replaceChildren();
    window.ProviderUI.clearHistory();
  }
  function connect(value) {
    context = value;
    const root = $('provider-config');
    root.addEventListener('submit', event => { event.preventDefault(); save(); });
    root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || state.saving) return;
      const data = button.dataset;
      if (data.pcProvider || data.pcChannel || data.pcView) {
        const form = $('pc-connection-form');
        if (form && !form.reportValidity()) return;
        captureConnection();
        if (data.pcProvider) state.channel = data.pcProvider === 'testllm' ? 'testllm' : 'candy';
        if (data.pcChannel) state.channel = data.pcChannel;
        if (data.pcView) state.view = data.pcView;
        render();
      } else if (data.pcEdit) openGroup(data.pcEdit);
      else if (data.pcRun) run(data.pcRun);
      else if ('pcBatch' in data) run();
      else if (data.pcHistory) openHistory(context.api, state.data.groups.find(group => group.id === data.pcHistory), state.channel, { admin: true });
      else if (data.pcDelete) removeHistory(data.pcDelete);
      else if ('pcAddTime' in data || 'pcRemoveTime' in data) {
        const channel = button.closest('[data-pc-plan]').dataset.pcPlan;
        const times = state.data.channels[channel].schedule.times;
        if ('pcRemoveTime' in data) times.splice(Number(data.pcRemoveTime), 1);
        else { const available = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).find(time => !times.includes(time)); if (available) times.push(available); }
        dirty(); render();
      }
    });
    root.addEventListener('input', event => {
      if (event.target.id === 'pc-group-query') {
        const input = event.target; const position = input.selectionStart;
        state.query = input.value.toLowerCase(); render(); $('pc-group-query').focus(); $('pc-group-query').setSelectionRange(position, position);
        return;
      }
      if (event.target.closest('#pc-connection-form')) { captureConnection(); dirty(); }
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
      if (input.dataset.pcEnabled) { groupEntry(state.data.groups.find(group => group.id === input.dataset.pcEnabled)).enabled = input.checked; dirty(); }
      if (input.closest('#pc-connection-form')) { captureConnection(); dirty(); }
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
    $('pc-group-reset').onclick = () => { $('pc-group-form').elements.override_enabled.checked = false; $('pc-override-fields').disabled = true; };
    $('pc-group-form').addEventListener('change', event => { if (event.target.name === 'override_enabled') $('pc-override-fields').disabled = !event.target.checked; });
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
