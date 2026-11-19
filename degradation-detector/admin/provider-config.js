(() => {
  'use strict';
  const { esc, icon, names, badge, stamp, openHistory, icons } = window.ProviderUI;
  const channels = ['candy', 'pelican', 'testllm'];
  const providerNames = { manxue: '满血 AI', testllm: 'TestLLM' };
  const platformNames = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini' };
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const state = { data: null, provider: query.get('provider') === 'testllm' ? 'testllm' : 'manxue',
    selected: { manxue: query.get('platform') || 'openai', testllm: query.get('platform') || 'openai' },
    channel: 'candy', dirty: false, saving: false, polling: false, running: false, query: '', modal: null, advanced: new Set() };
  let context, lastToast;
  function toast(message, type) {
    lastToast?.remove(); context.toast(message, type); lastToast = $('toast-region').lastElementChild;
  }
  const kinds = (provider = state.provider) => provider === 'manxue' ? ['candy', 'pelican'] : ['testllm'];
  const currentAI = () => state.selected[state.provider];
  const scopes = () => state.data.provider_platforms.filter(item => item.provider === state.provider);
  const scope = () => scopes().find(item => item.id === currentAI());
  const groups = () => state.data.groups.filter(group => group.platform === currentAI());
  const groupEnabled = group => kinds().some(channel => group.configurations[channel].group_enabled);
  const hasKey = value => Boolean(value.key || value.key_configured && !value.clear_key);
  const effective = (group, channel) => ({ ...scope().params, ...group.configurations[channel].override });
  const activeKinds = group => kinds().filter(channel => group.configurations[channel].enabled && (scope().tests?.[channel] ?? true));
  const runnable = group => state.data.providers[state.provider].enabled && scope().enabled && groupEnabled(group)
    && activeKinds(group).some(channel => hasKey(group.configurations[channel]));
  const field = (label, control) => `<label class="pc-field"><span>${label}</span>${control}</label>`;
  const input = (label, name, value, type = 'text', extra = '') => field(label, `<input type="${type}" name="${name}" value="${esc(value)}" ${extra}>`);
  const select = (label, name, value, options) => field(label, `<select name="${name}">${options.map(([id, text]) => `<option value="${esc(id)}" ${value === id ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`);
  const check = (label, name, value, extra = '') => `<label class="pc-check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${extra}><span>${esc(label)}</span></label>`;
  const toggle = (label, name, value, extra = '') => `<label class="pc-switch"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${extra}><span>${esc(label)}</span></label>`;
  const mode = (name, value, options) => `<div class="pc-segmented" role="radiogroup" aria-label="${name === 'parameter_mode' ? '分组参数来源' : '计划模式'}">${options.map(([id, text]) => `<label><input type="radio" name="${name}" value="${id}" ${value === id ? 'checked' : ''}>${esc(text)}</label>`).join('')}</div>`;
  function effortField(value, token) {
    const custom = !efforts.includes(value);
    return `<div class="pc-field"><label for="pc-effort-${token}">思考等级</label><select id="pc-effort-${token}" name="reasoning_effort_preset" data-pc-effort>${[...efforts, 'custom'].map(effort => `<option value="${effort}" ${(custom ? 'custom' : value) === effort ? 'selected' : ''}>${effort === 'custom' ? '自定义' : effort}</option>`).join('')}</select><input name="reasoning_effort" value="${esc(value)}" maxlength="64" required aria-label="自定义思考等级" ${custom ? '' : 'hidden disabled'}></div>`;
  }
  function parameterFields(params, token, required = false, withTimeout = false) {
    return `<div class="pc-fields">${input('上游 API 地址', 'target_url', params.target_url, 'url', `${required ? 'required' : ''} maxlength="2048"`)}${input('检测模型', 'model', params.model, 'text', `${required ? 'required' : ''} maxlength="200"`)}${state.provider === 'manxue'
      ? effortField(params.reasoning_effort, token) + select('服务档位', 'service_tier', params.service_tier, [['', '默认'], ['priority', 'Fast / priority'], ['ultrafast', 'UltraFast / ultrafast']])
      : select('请求协议', 'protocol', params.protocol, [['gpt', 'GPT'], ['claude', 'Claude']])}${withTimeout ? input('单次超时（秒）', 'timeout_seconds', params.timeout_seconds, 'number', 'required min="30" max="1800"') : ''}</div>${state.provider === 'testllm' ? `<div class="pc-checks">${check('推理检测', 'iq_test', true, 'disabled')}${check('缓存检测', 'cache_test', params.cache_test)}${check('思考与签名检测', 'thinking_test', params.thinking_test)}</div>` : ''}`;
  }
  function planFields(plan, token) {
    return `<div class="pc-plan" data-pc-plan="${token}">${toggle('启用自动检测', 'schedule_enabled_' + token, plan.enabled, 'data-plan-enabled')}<fieldset class="pc-plan-controls" ${plan.enabled ? '' : 'disabled'}>${mode('schedule_mode_' + token, plan.mode, [['daily', '固定时间'], ['interval', '间隔执行']])}<div class="pc-times" ${plan.mode === 'daily' ? '' : 'hidden'}>${plan.times.map((time, index) => `<div>${input('执行时间 ' + (index + 1), 'time_' + index, time, 'time', 'required data-plan-time')}<button class="icon-button" type="button" data-pc-remove-time="${index}" aria-label="移除此时间" title="移除此时间" ${plan.times.length < 2 ? 'disabled' : ''}>${icon('x')}</button></div>`).join('')}<button class="icon-button" type="button" data-pc-add-time aria-label="添加执行时间" title="添加执行时间" ${plan.times.length >= 24 ? 'disabled' : ''}>${icon('plus')}</button></div><div ${plan.mode === 'interval' ? '' : 'hidden'}>${input('间隔（分钟）', 'interval_minutes', plan.interval_minutes, 'number', 'required min="1" max="43200" data-plan-interval')}</div></fieldset></div>`;
  }
  function readPlan(root, previous) {
    const plan = { ...previous, times: [...root.querySelectorAll('[data-plan-time]')].map(control => control.value) };
    plan.enabled = root.querySelector('[data-plan-enabled]').checked;
    plan.mode = root.querySelector('input[type="radio"]:checked').value;
    plan.interval_minutes = Number(root.querySelector('[data-plan-interval]').value);
    return plan;
  }
  function readParams(root, previous) {
    const params = { ...previous };
    for (const key of Object.keys(params)) {
      const control = root.querySelector(`[name="${key}"]`);
      if (control) params[key] = control.type === 'checkbox' ? control.checked : control.type === 'number' ? Number(control.value) : control.value.trim();
    }
    return params;
  }
  function dirty() {
    state.dirty = true;
    if ($('pc-save-label')) $('pc-save-label').textContent = '保存更改';
    document.querySelectorAll('[data-pc-run],[data-pc-batch]').forEach(button => { button.disabled = true; });
  }
  function capture() {
    const provider = $('pc-provider-form');
    if (provider) { const value = state.data.providers[state.provider]; value.enabled = provider.elements.provider_enabled.checked; value.api_url = provider.elements.api_url.value.trim(); }
    const form = $('pc-platform-form'); if (!form) return;
    const value = scope(); value.enabled = form.elements.platform_enabled.checked;
    value.params = readParams(form, value.params);
    if (value.tests) for (const channel of kinds()) value.tests[channel] = form.elements[channel].checked;
    value.concurrency = Number(form.elements.concurrency.value);
    value.schedule = readPlan(form.querySelector('[data-pc-plan]'), value.schedule);
  }
  function valid() { return [...document.querySelectorAll('#pc-provider-form,#pc-platform-form')].every(form => form.reportValidity()); }
  function sharedView() {
    const value = scope();
    return `<form id="pc-platform-form" autocomplete="off"><section class="pc-section pc-shared"><div class="pc-section-head"><div><h3>${esc(platformNames[currentAI()] || currentAI())} 共享检测参数</h3><p class="pc-subtitle">${providerNames[state.provider]} · ${groups().length} 个分组</p></div>${toggle('启用此 AI 平台', 'platform_enabled', value.enabled)}</div>${parameterFields(value.params, 'shared', value.enabled && state.data.providers[state.provider].enabled)}${value.tests ? `<div class="pc-checks">${kinds().map(channel => check(names[channel], channel, value.tests[channel])).join('')}</div>` : ''}<details class="pc-advanced" ${state.advanced.has(`${state.provider}:${currentAI()}`) ? 'open' : ''}><summary>运行设置与自动计划</summary><div class="pc-fields">${input('单次超时（秒）', 'timeout_seconds', value.params.timeout_seconds, 'number', 'required min="30" max="1800"')}${input('平台并发上限', 'concurrency', value.concurrency, 'number', 'required min="1" max="4"')}</div><p class="pc-note">第三方检测总并发上限 ${state.data.total_concurrency} · ${esc(state.data.timezone)}</p>${planFields(value.schedule, 'shared')}</details></section></form>`;
  }
  function groupsView() {
    const rows = groups().filter(group => `${group.name} ${group.id}`.toLowerCase().includes(state.query));
    return `<section class="pc-section"><div class="pc-section-head"><h3><span class="pc-level-number">03</span>${esc(platformNames[currentAI()] || currentAI())} 分组 <span class="pc-tag">${groups().filter(groupEnabled).length} / ${groups().length} 已启用</span></h3></div><div class="pc-group-toolbar"><label class="p-search">${icon('search')}<input type="search" id="pc-group-query" value="${esc(state.query)}" placeholder="搜索当前平台分组" aria-label="搜索当前平台分组"></label><div class="pc-actions">${state.provider === 'manxue' ? `<label class="pc-history-channel">记录类别<select id="pc-history-channel">${kinds().map(channel => `<option value="${channel}" ${state.channel === channel ? 'selected' : ''}>${names[channel]}</option>`).join('')}</select></label>` : ''}<button type="button" class="button" data-pc-batch ${state.dirty || state.running || !groups().some(runnable) ? 'disabled' : ''}>${icon('play')}检测本平台分组</button></div></div><div class="pc-table-scroll"><table class="pc-group-table"><thead><tr><th>启用</th><th>分组</th><th>检测项目</th><th>生效模型 / 参数来源</th><th>专用 Key</th><th>上次检测</th><th>操作</th></tr></thead><tbody>${rows.map(group => {
      const active = activeKinds(group); const channel = active[0] || kinds()[0];
      const overrides = kinds().filter(kind => group.configurations[kind].override);
      const models = [...new Set((active.length ? active : [channel]).map(kind => effective(group, kind).model))];
      const configured = kinds().filter(kind => hasKey(group.configurations[kind]));
      return `<tr data-pc-row="${esc(group.id)}"><td>${toggle('', '', groupEnabled(group), `data-pc-enabled="${esc(group.id)}" aria-label="启用 ${esc(group.name)}"`)}</td><td class="pc-group-name"><strong>${esc(group.name)}</strong><small>#${esc(group.id)} · 倍率 ${esc(group.rate_multiplier ?? '—')}</small></td><td data-label="检测项目"><div class="pc-tags">${state.provider === 'manxue' ? active.map(kind => `<span class="pc-tag">${names[kind]}</span>`).join('') || '<span class="p-muted">未选择</span>' : `<span class="pc-tag">推理</span>${effective(group, channel).cache_test ? '<span class="pc-tag">缓存</span>' : ''}${effective(group, channel).thinking_test ? '<span class="pc-tag">思考签名</span>' : ''}`}</div></td><td class="pc-model-cell" data-label="生效模型"><div>${models.map(esc).join('<br>')}<small class="pc-source">${icon(overrides.length ? 'sliders-horizontal' : 'link-2')}${overrides.length ? '分组独立参数' : `继承 ${esc(platformNames[currentAI()] || currentAI())}`}</small></div></td><td data-label="专用 Key"><span class="${configured.length === kinds().length ? 'p-green' : 'p-amber'}">${configured.length === kinds().length ? '已配置' : configured.length ? '部分配置' : '未配置'}</span></td><td data-label="上次检测"><div class="pc-latest">${(active.length ? active : [channel]).map(kind => `<div>${state.provider === 'manxue' ? `<small>${names[kind]}</small>` : ''}${badge(group.configurations[kind].latest)}<small>${stamp(group.configurations[kind].latest?.created_at)}</small></div>`).join('')}</div></td><td class="pc-actions-cell"><div class="pc-row-actions"><button type="button" class="icon-button" data-pc-edit="${esc(group.id)}" title="分组详细配置" aria-label="配置 ${esc(group.name)}">${icon('sliders-horizontal')}</button><button type="button" class="icon-button" data-pc-run="${esc(group.id)}" title="立即检测" aria-label="检测 ${esc(group.name)}" ${state.dirty || state.running || !runnable(group) ? 'disabled' : ''}>${icon('play')}</button><button type="button" class="icon-button" data-pc-history="${esc(group.id)}" title="检测记录" aria-label="查看 ${esc(group.name)} 的记录">${icon('history')}</button><button type="button" class="icon-button" data-pc-delete="${esc(group.id)}" title="清空当前类别历史" aria-label="清空 ${esc(group.name)} 的当前类别历史">${icon('trash-2')}</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="pc-empty">没有匹配的分组</td></tr>'}</tbody></table></div></section>`;
  }
  function render() {
    if (!state.data) return;
    if (!scopes().some(item => item.id === currentAI())) state.selected[state.provider] = scopes()[0]?.id || '';
    if (!kinds().includes(state.channel)) state.channel = kinds()[0];
    const value = state.data.providers[state.provider];
    $('provider-config').innerHTML = `<header class="pc-heading"><div><h2>第三方降智检测</h2><span class="p-muted">${state.data.demo ? '演示配置 · ' : ''}${state.data.groups.length} 个可管理分组 · ${esc(state.data.timezone)}</span></div><div class="pc-actions"><button id="pc-reload" class="icon-button" type="button" title="重新读取配置" aria-label="重新读取配置">${icon('refresh-cw')}</button><button id="pc-save" class="button primary" type="button" ${state.saving ? 'disabled' : ''}>${icon('save')}<span id="pc-save-label">${state.dirty ? '保存更改' : '保存三方配置'}</span></button></div></header><div class="pc-level"><b>01</b>检测平台</div><nav class="p-tabs pc-provider-tabs" role="tablist" aria-label="检测平台">${Object.keys(providerNames).map(id => `<button type="button" id="pc-provider-${id}" data-pc-provider="${id}" role="tab" aria-controls="pc-provider-panel" aria-selected="${state.provider === id}" tabindex="${state.provider === id ? 0 : -1}">${icon(id === 'manxue' ? 'candy' : 'brain-circuit')}${providerNames[id]}</button>`).join('')}</nav><section id="pc-provider-panel" role="tabpanel" aria-labelledby="pc-provider-${state.provider}"><form id="pc-provider-form" autocomplete="off"><section class="pc-section"><div class="pc-section-head"><h3>${providerNames[state.provider]} 接口设置 <span class="pc-tag">全部 AI 平台共用</span></h3>${toggle('启用', 'provider_enabled', value.enabled)}</div><div class="pc-endpoint">${input(state.provider === 'manxue' ? '任务接口地址' : '服务地址', 'api_url', value.api_url, 'url', `${value.enabled ? 'required' : ''} maxlength="2048"`)}</div></section></form><div class="pc-level"><b>02</b>AI 模型平台</div><nav class="p-tabs pc-platform-tabs" role="tablist" aria-label="AI 模型平台">${scopes().map(item => `<button type="button" id="pc-platform-${esc(item.id)}" data-pc-platform="${esc(item.id)}" role="tab" aria-controls="pc-platform-panel" aria-selected="${item.id === currentAI()}" tabindex="${item.id === currentAI() ? 0 : -1}">${icon(item.id === 'anthropic' ? 'sparkles' : item.id === 'gemini' ? 'gem' : 'bot')}${esc(platformNames[item.id] || item.id)}<span class="pc-tab-count">${state.data.groups.filter(group => group.platform === item.id).length}</span></button>`).join('')}</nav><section id="pc-platform-panel" role="tabpanel" aria-labelledby="pc-platform-${esc(currentAI())}">${scope() ? sharedView() + groupsView() : '<p class="pc-note">暂无支持此检测的可管理分组。</p>'}</section></section>`;
    $('pc-save').onclick = save;
    $('pc-reload').onclick = async () => { if (!state.dirty || confirm('放弃尚未保存的三方配置并重新读取？')) await load().catch(handleError); };
    const advanced = document.querySelector('#pc-platform-form .pc-advanced');
    if (advanced) { const id = `${state.provider}:${currentAI()}`; advanced.ontoggle = () => { if (advanced.open) state.advanced.add(id); else state.advanced.delete(id); }; }
    syncPlanControls($('provider-config')); icons();
    if (state.saving || state.running) $('provider-config').querySelectorAll('input,select,button').forEach(control => { control.disabled = true; });
  }
  function payload() {
    capture();
    return { revision: state.data.revision, providers: state.data.providers, channels: state.data.channels, platforms: state.data.platforms,
      provider_platforms: state.data.provider_platforms, groups: state.data.groups.flatMap(group => channels.map(channel => {
        const value = group.configurations[channel];
        return { id: group.id, channel, enabled: value.enabled, group_enabled: value.group_enabled, override: value.override, schedule_override: value.schedule_override || null,
          ...(value.key ? { key: value.key } : {}), ...(value.clear_key ? { clear_key: true } : {}) };
      })) };
  }
  function adopt(data) {
    data.provider_platforms = data.hierarchy_platforms;
    for (const group of data.groups) for (const channel of channels) group.configurations[channel].override = group.configurations[channel].hierarchy_override;
    state.data = data; state.dirty = false; render();
  }
  function handleError(error) {
    toast(error.message, 'error');
    if ([401, 403].includes(error.status)) { reset(); context.showError('管理员身份已失效，请从 Sub2API 重新打开。'); }
  }
  async function save() {
    if (state.saving || state.running || !valid()) return;
    const body = payload(); state.saving = true;
    $('provider-config').querySelectorAll('input,select,button').forEach(control => { control.disabled = true; });
    try { adopt(await context.api('/api/admin/provider-config', { method: 'PUT', body, mutation: true })); toast('第三方检测配置已保存'); }
    catch (error) { handleError(error); }
    finally { state.saving = false; render(); }
  }
  async function load(idleOnly = false) {
    const data = await context.api('/api/admin/provider-config');
    if (state.data && data.revision < state.data.revision || idleOnly && (state.dirty || state.saving || state.running || state.modal)) return;
    adopt(data);
  }
  function openGroup(id) {
    const group = state.data.groups.find(group => group.id === id); if (!group) return;
    capture();
    const entries = kinds().map(channel => group.configurations[channel]);
    const commonKey = entries.every(entry => (entry.key || '') === (entries[0].key || '') && Boolean(entry.clear_key) === Boolean(entries[0].clear_key));
    const individual = state.provider === 'manxue' && JSON.stringify(entries[0].override) !== JSON.stringify(entries[1].override);
    state.modal = { id, enabled: groupEnabled(group), channel: kinds()[0], mode: individual ? 'individual' : entries.some(entry => entry.override) ? 'override' : 'inherit',
      params: structuredClone(entries.find(entry => entry.override)?.override || scope().params), key: commonKey ? entries[0].key || '' : '', clear_key: commonKey && Boolean(entries[0].clear_key),
      values: Object.fromEntries(kinds().map(channel => { const entry = group.configurations[channel]; return [channel, {
        selected: entry.enabled || !entries.some(value => value.enabled) && (scope().tests?.[channel] ?? true),
        params: structuredClone(effective(group, channel)), key: commonKey ? '' : entry.key || '', clear_key: !commonKey && Boolean(entry.clear_key),
        independent: Boolean(entry.schedule_override), schedule: structuredClone(entry.schedule_override || scope().schedule)
      }]; })) };
    $('pc-group-title').textContent = `${group.name} · ${providerNames[state.provider]} / ${platformNames[currentAI()] || currentAI()}`;
    renderGroup(); $('pc-group-dialog').showModal();
  }
  function renderGroup() {
    const draft = state.modal; const group = state.data.groups.find(group => group.id === draft.id);
    const openDetails = [...$('pc-group-body').querySelectorAll('details')].map(details => details.open);
    const value = draft.mode === 'individual' ? draft.values[draft.channel].params : draft.mode === 'inherit' ? scope().params : draft.params;
    $('pc-group-body').innerHTML = `<section><div class="pc-section-head"><h3>分组配置</h3>${toggle('启用分组', 'group_enabled', draft.enabled)}</div>${state.provider === 'manxue' ? `<div class="pc-checks">${kinds().map(channel => check(names[channel], channel, draft.values[channel].selected)).join('')}</div>` : ''}${input('分组专用 Key', 'key', draft.key, 'password', 'maxlength="8192" autocomplete="new-password" placeholder="留空保留已保存的 Key"')}<p class="pc-note">${kinds().map(channel => `${names[channel]}：${group.configurations[channel].key_configured ? '已配置' : '未配置'}`).join(' · ')}</p>${check('清除本检测平台的分组 Key', 'clear_key', draft.clear_key)}${state.provider === 'manxue' ? `<details class="pc-advanced"><summary>分项 Key</summary>${kinds().map(channel => input(names[channel] + ' Key', 'key_' + channel, draft.values[channel].key, 'password', 'maxlength="8192" autocomplete="new-password" placeholder="留空保留此项 Key"') + check('清除' + names[channel] + ' Key', 'clear_' + channel, draft.values[channel].clear_key)).join('')}</details>` : ''}</section><section class="pc-section"><div class="pc-section-head"><h3>检测参数</h3>${mode('parameter_mode', draft.mode, [['inherit', '继承平台'], ['override', '独立配置'], ...(state.provider === 'manxue' ? [['individual', '分项配置']] : [])])}</div>${draft.mode === 'individual' ? `<nav class="p-tabs pc-test-tabs" role="tablist" aria-label="分项检测参数">${kinds().map(channel => `<button type="button" id="pc-group-test-${channel}" data-pc-group-channel="${channel}" role="tab" aria-controls="pc-override-fields" aria-selected="${draft.channel === channel}" tabindex="${draft.channel === channel ? 0 : -1}">${names[channel]}</button>`).join('')}</nav>` : ''}<fieldset id="pc-override-fields" ${draft.mode === 'inherit' ? 'disabled' : ''}>${parameterFields(value, 'group', draft.enabled, true)}</fieldset></section><details class="pc-advanced"><summary>分组独立检测计划</summary>${kinds().map(channel => { const entry = draft.values[channel]; return `<section class="pc-group-plan" data-pc-group-plan="${channel}"><h3>${names[channel]}</h3>${check('使用独立计划', 'independent_schedule', entry.independent)}<fieldset ${entry.independent ? '' : 'disabled'}>${planFields(entry.schedule, channel)}</fieldset></section>`; }).join('')}</details><p id="pc-group-error" role="alert" class="p-history-error"></p>`;
    $('pc-group-body').querySelectorAll('details').forEach((details, index) => { details.open = openDetails[index] || false; });
    syncPlanControls($('pc-group-body')); icons();
  }
  function captureGroup() {
    const draft = state.modal; if (!draft) return;
    const form = $('pc-group-form'); draft.enabled = form.elements.group_enabled.checked;
    draft.key = form.elements.key.value; draft.clear_key = form.elements.clear_key.checked;
    if (draft.mode === 'override') draft.params = readParams($('pc-override-fields'), draft.params);
    if (draft.mode === 'individual') draft.values[draft.channel].params = readParams($('pc-override-fields'), draft.values[draft.channel].params);
    for (const channel of kinds()) {
      const value = draft.values[channel];
      if (state.provider === 'manxue') { value.selected = form.elements[channel].checked; value.key = form.elements['key_' + channel].value; value.clear_key = form.elements['clear_' + channel].checked; }
      const plan = form.querySelector(`[data-pc-group-plan="${channel}"]`);
      value.independent = plan.querySelector('[name="independent_schedule"]').checked;
      value.schedule = readPlan(plan.querySelector('[data-pc-plan]'), value.schedule);
    }
  }
  function applyGroup(event) {
    event.preventDefault(); const form = $('pc-group-form'); if (!form.reportValidity()) return;
    captureGroup(); const draft = state.modal;
    let error = '';
    if (draft.key && draft.clear_key || Object.values(draft.values).some(value => value.key && value.clear_key)) error = '不能同时设置和清除 Key';
    if ((draft.key || draft.clear_key) && Object.values(draft.values).some(value => value.key || value.clear_key)) error = '统一 Key 与分项 Key 请选择一种填写';
    if (draft.enabled && !kinds().some(channel => draft.values[channel].selected && (scope().tests?.[channel] ?? true))) error = '启用分组至少需要选择一项平台已启用的检测';
    if (error) { $('pc-group-error').textContent = error; return; }
    const group = state.data.groups.find(group => group.id === draft.id);
    for (const channel of kinds()) {
      const entry = group.configurations[channel]; const value = draft.values[channel];
      entry.enabled = value.selected; entry.group_enabled = draft.enabled;
      entry.override = draft.mode === 'inherit' ? null : structuredClone(draft.mode === 'override' ? draft.params : value.params);
      entry.key = draft.key || value.key; entry.clear_key = draft.clear_key || value.clear_key;
      entry.schedule_override = value.independent ? structuredClone(value.schedule) : null;
    }
    dirty(); $('pc-group-dialog').close(); render();
  }
  async function run(id) {
    if (state.dirty || state.saving || state.running) return;
    const path = `/api/admin/provider-platforms/${state.provider}/${encodeURIComponent(currentAI())}${id ? `/groups/${encodeURIComponent(id)}` : ''}/runs`;
    state.running = true; render();
    try { const result = await context.api(path, { method: 'POST', body: {}, mutation: true }); toast(`已加入检测队列：${result.runs.length} 个任务`); await load(); }
    catch (error) { handleError(error); }
    finally { state.running = false; render(); }
  }
  async function removeHistory(id) {
    const group = state.data.groups.find(group => group.id === id);
    const channel = state.provider === 'testllm' ? 'testllm' : state.channel;
    if (!confirm(`清空 ${group.name} 的${names[channel]}已完成历史及累计记录？`)) return;
    try { const result = await context.api(`/api/admin/provider/groups/${encodeURIComponent(id)}/${channel}/runs`, { method: 'DELETE', body: { all: true }, mutation: true }); toast(`已删除 ${result.deleted} 条记录`); if (!state.dirty) await load(); }
    catch (error) { handleError(error); }
  }
  function syncEffort(event) {
    if (!event.target.matches('[data-pc-effort]')) return;
    const control = event.target.closest('.pc-field').querySelector('[name="reasoning_effort"]');
    const custom = event.target.value === 'custom'; control.hidden = !custom; control.disabled = !custom;
    if (custom) control.focus(); else control.value = event.target.value;
  }
  function syncPlanControls(root) {
    root.querySelectorAll('[data-pc-plan]').forEach(plan => {
      const daily = plan.querySelector('input[type="radio"]:checked').value === 'daily';
      plan.querySelectorAll('[data-plan-time]').forEach(control => { control.disabled = !daily; });
      plan.querySelector('[data-plan-interval]').disabled = daily;
    });
  }
  function editTime(button, modal) {
    const token = button.closest('[data-pc-plan]').dataset.pcPlan;
    if (modal) captureGroup(); else capture();
    const plan = modal ? state.modal.values[token].schedule : scope().schedule;
    if ('pcRemoveTime' in button.dataset) plan.times.splice(Number(button.dataset.pcRemoveTime), 1);
    else { const time = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).find(time => !plan.times.includes(time)); if (time) plan.times.push(time); }
    if (modal) renderGroup(); else { dirty(); render(); }
  }
  function reset() {
    state.data = null; state.dirty = false; state.modal = null;
    if ($('pc-group-dialog')?.open) $('pc-group-dialog').close();
    $('pc-group-body')?.replaceChildren(); $('provider-config')?.replaceChildren(); window.ProviderUI.clearHistory();
  }
  function connect(value) {
    context = value; const root = $('provider-config');
    root.addEventListener('submit', event => { event.preventDefault(); save(); });
    root.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled || state.saving || state.running) return;
      const data = button.dataset;
      if (data.pcProvider || data.pcPlatform) {
        if (!valid()) return; capture();
        if (data.pcProvider) state.provider = data.pcProvider;
        if (data.pcPlatform) state.selected[state.provider] = data.pcPlatform;
        state.query = ''; render(); syncPlanControls(root);
      } else if (data.pcEdit) openGroup(data.pcEdit);
      else if (data.pcRun) run(data.pcRun);
      else if ('pcBatch' in data) run();
      else if (data.pcHistory) openHistory(context.api, state.data.groups.find(group => group.id === data.pcHistory), state.provider === 'testllm' ? 'testllm' : state.channel, { admin: true });
      else if (data.pcDelete) removeHistory(data.pcDelete);
      else if ('pcAddTime' in data || 'pcRemoveTime' in data) { editTime(button, false); syncPlanControls(root); }
    });
    root.addEventListener('input', event => {
      if (state.saving || state.running) return;
      syncEffort(event);
      if (event.target.id === 'pc-group-query') {
        const position = event.target.selectionStart; state.query = event.target.value.toLowerCase(); capture(); render();
        $('pc-group-query').focus(); if (position !== null) $('pc-group-query').setSelectionRange(position, position); return;
      }
      if (event.target.closest('form')) { capture(); dirty(); }
    });
    root.addEventListener('change', event => {
      if (state.saving || state.running) return;
      const control = event.target;
      if (control.dataset.pcEnabled) {
        capture(); const group = state.data.groups.find(group => group.id === control.dataset.pcEnabled);
        const selected = kinds().some(channel => group.configurations[channel].enabled);
        for (const channel of kinds()) { const value = group.configurations[channel]; value.group_enabled = control.checked; if (control.checked && !selected) value.enabled = scope().tests?.[channel] ?? true; }
        dirty(); render();
      } else if (control.id === 'pc-history-channel') state.channel = control.value;
      else if (control.closest('form')) { capture(); dirty(); if (control.type === 'checkbox' || control.type === 'radio') { render(); syncPlanControls(root); } }
    });
    const modalBody = $('pc-group-body');
    modalBody.addEventListener('input', syncEffort);
    modalBody.addEventListener('change', event => {
      captureGroup();
      if (event.target.name === 'parameter_mode') state.modal.mode = event.target.value;
      if (event.target.type === 'checkbox' || event.target.type === 'radio') renderGroup();
    });
    modalBody.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.pcGroupChannel) { if (!$('pc-group-form').reportValidity()) return; captureGroup(); state.modal.channel = button.dataset.pcGroupChannel; renderGroup(); }
      else if ('pcAddTime' in button.dataset || 'pcRemoveTime' in button.dataset) editTime(button, true);
    });
    document.addEventListener('keydown', event => {
      if (!event.target.closest('#provider-config,#pc-group-dialog') || !event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); const id = tabs[index].id; tabs[index].click(); $(id)?.focus();
    });
    $('pc-group-form').addEventListener('submit', applyGroup);
    $('pc-group-close').onclick = $('pc-group-cancel').onclick = () => $('pc-group-dialog').close();
    $('pc-group-reset').onclick = () => { state.modal.key = ''; state.modal.clear_key = false; for (const value of Object.values(state.modal.values)) { value.key = ''; value.clear_key = false; } renderGroup(); };
    $('pc-group-dialog').addEventListener('close', () => { state.modal = null; $('pc-group-body').replaceChildren(); });
    modalBody.addEventListener('focusin', event => { if (event.target.matches('input,select')) event.target.scrollIntoView({ block: 'nearest' }); });
    window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
    setInterval(async () => {
      if (!state.data || state.dirty || state.saving || state.running || state.polling || document.hidden || $('pc-group-dialog').open) return;
      if (!state.data.groups.some(group => channels.some(channel => ['queued', 'running'].includes(group.configurations[channel].latest?.status)))) return;
      state.polling = true;
      try { await load(true); } catch (error) { handleError(error); } finally { state.polling = false; }
    }, 5000);
  }
  window.ProviderConfig = { connect, load, reset };
})();
