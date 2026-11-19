(() => {
  'use strict';
  const storageKey = 'sub2api-provider-hierarchy-demo-v1';
  const providerNames = { manxue: '满血 AI', testllm: 'TestLLM' };
  const aiNames = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini' };
  const aiIcons = { openai: 'bot', anthropic: 'sparkles', gemini: 'gem' };
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const catalog = [
    { id: '8', platform: 'openai', name: 'GPT｜不降智｜官Key', rate: '1.0×' },
    { id: '18', platform: 'openai', name: 'GPT｜优先通道', rate: '1.2×' },
    { id: '28', platform: 'openai', name: 'GPT｜备用分组', rate: '0.8×' },
    { id: '2', platform: 'anthropic', name: 'Claude｜企业', rate: '1.0×' },
    { id: '12', platform: 'anthropic', name: 'Claude｜共享中转', rate: '0.9×' },
    { id: '40', platform: 'gemini', name: 'Gemini｜专属定制', rate: '1.0×' }
  ];
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons = () => window.lucide.createIcons();
  const stamp = timestamp => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
  const field = (label, control) => `<label class="field"><span>${label}</span>${control}</label>`;
  const input = (label, name, value, type = 'text', attributes = '') => field(label, `<input name="${name}" type="${type}" value="${esc(value)}" ${attributes}>`);
  const select = (label, name, value, options) => field(label, `<select name="${name}">${options.map(([id, text]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${text}</option>`).join('')}</select>`);
  const check = (label, name, checked, attributes = '') => `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${attributes}><span>${label}</span></label>`;
  const toggle = (label, name, checked, attributes = '') => `<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${attributes}><span>${label}</span></label>`;
  const mode = (name, value, options) => `<div class="segmented" role="radiogroup" aria-label="${name === 'parameter_mode' ? '分组参数来源' : '计划模式'}">${options.map(([id, text]) => `<label><input type="radio" name="${name}" value="${id}" ${value === id ? 'checked' : ''}>${text}</label>`).join('')}</div>`;

  function defaultParams(provider, ai) {
    const common = { target_url: `https://${provider === 'manxue' ? 'gateway' : 'iq-gateway'}.example.com/v1`, model: ai === 'anthropic' ? 'claude-sonnet-4-5' : ai === 'gemini' ? 'gemini-2.5-pro' : 'gpt-6-astra', timeout_seconds: 900 };
    return provider === 'manxue'
      ? { ...common, reasoning_effort: 'low', service_tier: '' }
      : { ...common, protocol: ai === 'anthropic' ? 'claude' : 'gpt', cache_test: true, thinking_test: true };
  }
  function seed() {
    return { version: 1, providers: Object.fromEntries(Object.keys(providerNames).map(provider => [provider, {
      enabled: true, api_url: provider === 'manxue' ? 'https://manxue.ai/api/v1/tests' : 'https://testllm.ai',
      platforms: Object.fromEntries(Object.keys(aiNames).filter(ai => provider === 'manxue' || ai !== 'gemini').map(ai => [ai, {
        enabled: true, params: defaultParams(provider, ai), tests: provider === 'manxue' ? { candy: true, pelican: true } : null,
        concurrency: 2, schedule: { enabled: false, mode: 'daily', times: ['09:30', '21:30'], interval_minutes: 360 },
        groups: catalog.filter(group => group.platform === ai).map((group, index) => ({
          id: group.id, enabled: index < 2, key_configured: group.id !== '28',
          tests: provider === 'manxue' ? { candy: true, pelican: index !== 1 } : null,
          override: provider === 'manxue' && group.id === '18' ? { ...defaultParams(provider, ai), reasoning_effort: 'high', service_tier: 'priority' } : null
        }))
      }]))
    }])) };
  }
  function readSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved?.version !== 1) return seed();
      const expected = seed();
      for (const [provider, config] of Object.entries(expected.providers)) {
        const value = saved.providers[provider];
        if (typeof value.enabled !== 'boolean' || typeof value.api_url !== 'string') return seed();
        for (const [ai, platform] of Object.entries(config.platforms)) {
          const candidate = value.platforms[ai];
          if (!candidate || !Array.isArray(candidate.groups) || candidate.groups.length !== platform.groups.length) return seed();
          if (!Object.keys(platform.params).every(key => typeof candidate.params[key] === typeof platform.params[key])) return seed();
        }
      }
      return saved;
    } catch { return seed(); }
  }
  const query = new URLSearchParams(location.search);
  const state = {
    data: readSaved(), provider: query.get('provider') === 'testllm' ? 'testllm' : 'manxue',
    selected: { manxue: 'openai', testllm: 'openai' }, dirty: false, saved: false,
    query: '', advanced: false, group: null, runs: new Map(), busy: new Set(), error: ''
  };
  if (Object.hasOwn(state.data.providers[state.provider].platforms, query.get('platform'))) state.selected[state.provider] = query.get('platform');
  const currentProvider = () => state.data.providers[state.provider];
  const currentAI = () => state.selected[state.provider];
  const currentPlatform = () => currentProvider().platforms[currentAI()];
  const currentGroups = () => currentPlatform().groups;
  const groupMeta = id => catalog.find(group => group.id === id);
  const effective = group => ({ ...currentPlatform().params, ...group.override });
  const runKey = id => `${state.provider}:${currentAI()}:${id}`;
  function activeTests(group) {
    const params = effective(group);
    return state.provider === 'manxue'
      ? ['candy', 'pelican'].filter(id => currentPlatform().tests[id] && group.tests[id]).map(id => id === 'candy' ? '糖果' : '鹈鹕')
      : ['推理', ...(params.cache_test ? ['缓存'] : []), ...(params.thinking_test ? ['思考签名'] : [])];
  }
  function runnable(group) { return currentProvider().enabled && currentPlatform().enabled && group.enabled && group.key_configured && activeTests(group).length > 0; }
  let toastTimer;
  function toast(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400);
  }
  function saveState() {
    $('save-state').textContent = state.dirty ? '有未保存的更改' : state.saved ? '配置已保存' : '示例配置';
    $('save-state').style.color = state.dirty ? 'var(--amber)' : '';
    document.querySelectorAll('[data-run-group]').forEach(button => {
      const group = currentGroups().find(group => group.id === button.dataset.runGroup);
      button.disabled = state.dirty || !runnable(group) || state.busy.has(runKey(group.id));
    });
    const batch = document.querySelector('[data-run-platform]');
    if (batch) batch.disabled = state.dirty || !currentGroups().some(group => runnable(group) && !state.busy.has(runKey(group.id)));
  }
  function dirty() { state.dirty = true; state.error = ''; saveState(); $('page-error').textContent = ''; }
  function effortControl(value, scope) {
    const custom = !efforts.includes(value);
    return `<div class="field"><label for="${scope}-effort">思考等级</label><select id="${scope}-effort" name="reasoning_effort_preset" data-effort>${[...efforts, 'custom'].map(effort => `<option value="${effort}" ${(custom ? 'custom' : value) === effort ? 'selected' : ''}>${effort === 'custom' ? '自定义' : effort}</option>`).join('')}</select><input name="reasoning_effort" aria-label="自定义思考等级" value="${esc(value)}" maxlength="64" required ${custom ? '' : 'hidden disabled'}></div>`;
  }
  function parameterFields(params, scope) {
    const base = input('上游 API 地址', 'target_url', params.target_url, 'url', 'required maxlength="2048"') + input('检测模型', 'model', params.model, 'text', 'required maxlength="200"');
    return `<div class="fields">${base}${state.provider === 'manxue'
      ? effortControl(params.reasoning_effort, scope) + select('服务档位', 'service_tier', params.service_tier, [['', '默认'], ['priority', 'Fast / priority'], ['ultrafast', 'UltraFast / ultrafast']])
      : select('请求协议', 'protocol', params.protocol, [['gpt', 'GPT'], ['claude', 'Claude']])}</div>${state.provider === 'testllm' ? `<div class="check-section"><span>检测项目</span><div class="checks">${check('推理检测', 'iq_test', true, 'disabled')}${check('缓存检测', 'cache_test', params.cache_test)}${check('思考与签名检测', 'thinking_test', params.thinking_test)}</div></div>` : ''}`;
  }
  function sharedView() {
    const platform = currentPlatform();
    const plan = platform.schedule;
    return `<form id="shared-form" autocomplete="off"><section class="platform-shared"><div class="section-heading platform-heading"><div><h2>${aiNames[currentAI()]} 共享检测参数</h2><p>${providerNames[state.provider]} · ${platform.groups.length} 个分组</p></div>${toggle('启用此 AI 平台', 'platform_enabled', platform.enabled)}</div>
      ${parameterFields(platform.params, 'shared')}
      ${state.provider === 'manxue' ? `<div class="check-section"><span>启用检测</span><div class="checks">${check('糖果检测', 'candy', platform.tests.candy)}${check('鹈鹕检测', 'pelican', platform.tests.pelican)}</div></div>` : ''}
      <details class="advanced" ${state.advanced ? 'open' : ''}><summary>运行设置与自动计划</summary><div class="fields">${input('单次超时（秒）', 'timeout_seconds', platform.params.timeout_seconds, 'number', 'required min="30" max="1800"')}${input('平台并发上限', 'concurrency', platform.concurrency, 'number', 'required min="1" max="4"')}</div>
        <div class="plan">${toggle('启用自动检测', 'schedule_enabled', plan.enabled)}<fieldset id="schedule-controls" ${plan.enabled ? '' : 'disabled'} style="border:0;padding:0;margin:0;min-width:0"><div class="plan-controls">${mode('schedule_mode', plan.mode, [['daily', '固定时间'], ['interval', '间隔执行']])}
        ${plan.mode === 'daily' ? `<div class="inline">${plan.times.map((time, index) => `<label class="field"><span>时间 ${index + 1}</span><input type="time" data-time-index="${index}" value="${time}" required aria-label="执行时间 ${index + 1}"></label>`).join('')}<button type="button" class="icon-button" data-add-time title="添加执行时间" aria-label="添加执行时间" ${plan.times.length >= 4 ? 'disabled' : ''}>${icon('plus')}</button>${plan.times.length > 1 ? `<button type="button" class="icon-button" data-remove-time title="移除最后一个时间" aria-label="移除最后一个时间">${icon('minus')}</button>` : ''}</div>` : input('间隔（分钟）', 'interval_minutes', plan.interval_minutes, 'number', 'required min="1" max="43200"')}</div></fieldset></div>
      </details></section></form>`;
  }
  function latest(group) {
    if (state.busy.has(runKey(group.id))) return `<span class="status blue">${icon('loader-circle')}模拟检测中</span>`;
    const history = state.runs.get(runKey(group.id));
    if (!history && !group.key_configured) return '<span class="status muted">未检测</span>';
    return `<span class="status ${history?.[0]?.status === 'failed' ? 'amber' : 'green'}">${icon(history?.[0]?.status === 'failed' ? 'circle-alert' : 'circle-check')}${history?.[0]?.status === 'failed' ? '答案不符' : '通过'}</span><small>${stamp(history?.[0]?.at || Date.now() - 42 * 60000)}</small>`;
  }
  function groupsView() {
    const groups = currentGroups().filter(group => groupMeta(group.id).name.toLowerCase().includes(state.query));
    return `<section class="groups-section"><div class="section-heading"><div class="groups-title"><span class="level-label"><b>03</b></span><h2>${aiNames[currentAI()]} 分组</h2><span class="small-tag">${currentGroups().filter(group => group.enabled).length} / ${currentGroups().length} 已启用</span></div></div>
      <div class="group-toolbar"><label class="search">${icon('search')}<input type="search" id="group-search" value="${esc(state.query)}" placeholder="搜索当前平台分组" aria-label="搜索当前平台分组"></label><button type="button" class="button" data-run-platform>${icon('play')}检测本平台分组</button></div>
      <div class="table-scroll"><table class="groups-table"><thead><tr><th>启用</th><th>分组</th><th>检测项目</th><th>生效模型 / 参数来源</th><th>专用 Key</th><th>上次检测</th><th>操作</th></tr></thead><tbody>${groups.map(group => {
        const meta = groupMeta(group.id); const tests = activeTests(group);
        return `<tr data-group-row="${group.id}"><td>${toggle('', '', group.enabled, `data-group-enabled="${group.id}" aria-label="启用 ${esc(meta.name)}"`)}</td><td class="group-name"><strong>${esc(meta.name)}</strong><small>#${group.id} · 倍率 ${meta.rate}</small></td>
          <td data-label="检测项目"><div class="tags">${tests.length ? tests.map(test => `<span class="tag">${test}</span>`).join('') : '<span class="muted">未选择</span>'}</div></td>
          <td class="model-cell" data-label="生效模型"><div>${esc(effective(group).model)}<br><span class="source ${group.override ? 'custom' : ''}">${icon(group.override ? 'sliders-horizontal' : 'link-2')}${group.override ? '分组独立参数' : `继承 ${aiNames[currentAI()]}`}</span></div></td>
          <td data-label="专用 Key"><span class="status ${group.key_configured ? 'green' : 'amber'}">${icon(group.key_configured ? 'key-round' : 'circle-alert')}${group.key_configured ? '已配置' : '未配置'}</span></td>
          <td data-label="上次检测"><div>${latest(group)}</div></td><td class="actions-cell"><div class="row-actions"><button type="button" class="icon-button" data-edit-group="${group.id}" title="分组详细配置" aria-label="配置 ${esc(meta.name)}">${icon('sliders-horizontal')}</button><button type="button" class="icon-button" data-run-group="${group.id}" title="模拟检测" aria-label="模拟检测 ${esc(meta.name)}">${icon('play')}</button><button type="button" class="icon-button" data-history-group="${group.id}" title="检测记录" aria-label="查看 ${esc(meta.name)} 的记录">${icon('history')}</button></div></td></tr>`;
      }).join('') || '<tr><td class="empty" colspan="7">没有匹配的分组</td></tr>'}</tbody></table></div></section>`;
  }
  function render() {
    const provider = currentProvider();
    $('configuration').innerHTML = `<div class="level-label"><b>01</b>检测平台</div><nav class="provider-tabs" role="tablist" aria-label="检测平台">${Object.keys(providerNames).map(id => `<button type="button" id="provider-${id}" data-provider-tab="${id}" role="tab" aria-selected="${id === state.provider}" aria-controls="provider-panel" tabindex="${id === state.provider ? 0 : -1}"><span class="provider-symbol ${id}">${icon(id === 'manxue' ? 'candy' : 'brain-circuit')}</span>${providerNames[id]}</button>`).join('')}</nav>
      <section id="provider-panel" role="tabpanel" aria-labelledby="provider-${state.provider}"><form id="provider-form" class="provider-endpoint" autocomplete="off"><div class="section-heading"><h2>${providerNames[state.provider]} 接口设置<span class="small-tag">全部 AI 平台共用</span></h2>${toggle('启用', 'provider_enabled', provider.enabled)}</div>${input(state.provider === 'manxue' ? '任务接口地址' : '服务地址', 'api_url', provider.api_url, 'url', 'required maxlength="2048"')}</form>
      <section class="platform-section"><div class="level-label"><b>02</b>AI 模型平台</div><nav class="platform-tabs" role="tablist" aria-label="AI 模型平台">${Object.entries(provider.platforms).map(([ai, platform]) => `<button type="button" id="ai-${ai}" data-ai-tab="${ai}" role="tab" aria-selected="${ai === currentAI()}" aria-controls="ai-panel" tabindex="${ai === currentAI() ? 0 : -1}">${icon(aiIcons[ai])}${aiNames[ai]}<span class="tab-count">${platform.groups.length}</span></button>`).join('')}</nav><section id="ai-panel" role="tabpanel" aria-labelledby="ai-${currentAI()}">${sharedView()}${groupsView()}</section></section></section><p class="error" id="page-error" role="alert">${esc(state.error)}</p>`;
    icons(); saveState();
  }
  function readParams(root, previous) {
    const params = { ...previous };
    for (const key of Object.keys(params)) {
      const control = root.querySelector(`[name="${key}"]`);
      if (control) params[key] = control.type === 'checkbox' ? control.checked : control.type === 'number' ? Number(control.value) : control.value.trim();
    }
    return params;
  }
  function capture() {
    const providerForm = $('provider-form'); const form = $('shared-form');
    if (!providerForm || !form) return;
    currentProvider().enabled = providerForm.elements.provider_enabled.checked;
    currentProvider().api_url = providerForm.elements.api_url.value.trim();
    const platform = currentPlatform();
    platform.enabled = form.elements.platform_enabled.checked;
    platform.params = readParams(form, platform.params);
    if (platform.tests) for (const kind of ['candy', 'pelican']) platform.tests[kind] = form.elements[kind].checked;
    platform.concurrency = Number(form.elements.concurrency.value);
    platform.schedule.enabled = form.elements.schedule_enabled.checked;
    platform.schedule.mode = form.elements.schedule_mode.value;
    const times = [...form.querySelectorAll('[data-time-index]')];
    if (times.length) platform.schedule.times = times.map(input => input.value);
    if (form.elements.interval_minutes) platform.schedule.interval_minutes = Number(form.elements.interval_minutes.value);
  }
  function validUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port && url.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname); }
    catch { return false; }
  }
  function validateParams(params, provider) {
    if (!validUrl(params.target_url)) return '请填写公网 HTTPS 上游 API 地址';
    if (!params.model || params.model.length > 200 || /[\x00-\x1f\x7f]/.test(params.model)) return '请填写有效的检测模型';
    if (!Number.isInteger(params.timeout_seconds) || params.timeout_seconds < 30 || params.timeout_seconds > 1800) return '单次超时范围为 30–1800 秒';
    if (provider === 'manxue' && (!params.reasoning_effort || params.reasoning_effort.length > 64 || /[\x00-\x1f\x7f]/.test(params.reasoning_effort))) return '请填写有效的思考等级，最多 64 个字符';
    return '';
  }
  function validationError() {
    for (const [providerId, provider] of Object.entries(state.data.providers)) {
      if (!provider.enabled) continue;
      if (!validUrl(provider.api_url)) return { providerId, message: '请填写有效的检测平台 HTTPS 接口地址' };
      for (const [ai, platform] of Object.entries(provider.platforms)) {
        if (!platform.enabled) continue;
        let message = validateParams(platform.params, providerId);
        if (!Number.isInteger(platform.concurrency) || platform.concurrency < 1 || platform.concurrency > 4) message = '平台并发上限范围为 1–4';
        if (platform.schedule.enabled) {
          const plan = platform.schedule;
          if (plan.mode === 'daily' && (!plan.times.length || plan.times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(plan.times).size !== plan.times.length)) message = '执行时间不能为空或重复';
          if (plan.mode === 'interval' && (!Number.isInteger(plan.interval_minutes) || plan.interval_minutes < 1 || plan.interval_minutes > 43200)) message = '执行间隔范围为 1–43200 分钟';
        }
        if (message) return { providerId, ai, message };
        for (const group of platform.groups.filter(group => group.enabled)) {
          message = !group.key_configured ? '启用分组前请配置分组专用 Key' : validateParams({ ...platform.params, ...group.override }, providerId);
          if (providerId === 'manxue' && !['candy', 'pelican'].some(kind => platform.tests[kind] && group.tests[kind])) message = '启用分组至少需要一项已启用的检测';
          if (message) return { providerId, ai, id: group.id, message };
        }
      }
    }
    return null;
  }
  function save() {
    if (!$('provider-form').reportValidity() || !$('shared-form').reportValidity()) return;
    capture();
    const error = validationError();
    if (error) {
      state.provider = error.providerId; if (error.ai) state.selected[error.providerId] = error.ai;
      state.error = error.message; render();
      if (error.id) { openGroup(error.id); $('group-error').textContent = error.message; }
      else $('page-error').scrollIntoView({ block: 'nearest' });
      return;
    }
    try { state.data.saved_at = Date.now(); localStorage.setItem(storageKey, JSON.stringify(state.data)); }
    catch { toast('浏览器未能保存演示配置，请检查存储权限'); return; }
    state.dirty = false; state.saved = true; state.error = ''; render(); toast('演示配置已保存');
  }
  function openGroup(id) {
    capture();
    const group = currentGroups().find(group => group.id === id);
    if (!group) return;
    state.group = { original: group, draft: structuredClone(group), mode: group.override ? 'custom' : 'inherit', params: { ...currentPlatform().params, ...group.override } };
    $('group-path').textContent = `${providerNames[state.provider]} / ${aiNames[currentAI()]} / 分组 #${id}`;
    $('group-title').textContent = groupMeta(id).name;
    renderGroup(); $('group-dialog').showModal();
  }
  function renderGroup() {
    const { draft, params } = state.group;
    $('group-body').innerHTML = `<div class="section-heading"><h3>分组状态</h3>${toggle('启用检测', 'group_enabled', draft.enabled)}</div>
      ${state.provider === 'manxue' ? `<div class="checks">${check('糖果检测', 'group_candy', draft.tests.candy, currentPlatform().tests.candy ? '' : 'disabled')}${check('鹈鹕检测', 'group_pelican', draft.tests.pelican, currentPlatform().tests.pelican ? '' : 'disabled')}</div>` : ''}
      <section><div class="section-heading"><h3>专用凭据</h3><span class="status ${draft.key_configured ? 'green' : 'amber'}">${icon('key-round')}${draft.key_configured ? '已配置' : '未配置'}</span></div>${input('分组专用 Key', 'group_key', '', 'password', 'maxlength="8192" autocomplete="new-password" placeholder="留空保留已保存的 Key"')}<label class="check key-clear"><input type="checkbox" name="clear_key"><span>清除已保存的 Key</span></label></section>
      <section><div class="parameter-mode"><h3>检测参数</h3>${mode('parameter_mode', state.group.mode, [['inherit', '继承平台'], ['custom', '独立配置']])}</div><p class="inherit-note" id="inherit-note">${state.group.mode === 'inherit' ? `继承 ${providerNames[state.provider]} / ${aiNames[currentAI()]} 的共享参数` : '当前分组使用独立参数'}</p><fieldset id="group-params" ${state.group.mode === 'inherit' ? 'disabled' : ''}>${parameterFields(params, 'group')}${input('单次超时（秒）', 'timeout_seconds', params.timeout_seconds, 'number', 'required min="30" max="1800"')}</fieldset></section><p class="error" id="group-error" role="alert"></p>`;
    icons();
  }
  function groupModeChanged(value) {
    const form = $('group-form');
    if (state.group.mode === 'custom') state.group.params = readParams(form, state.group.params);
    state.group.mode = value;
    const params = value === 'inherit' ? currentPlatform().params : state.group.params;
    const fieldset = $('group-params');
    fieldset.innerHTML = parameterFields(params, 'group') + input('单次超时（秒）', 'timeout_seconds', params.timeout_seconds, 'number', 'required min="30" max="1800"');
    fieldset.disabled = value === 'inherit';
    $('inherit-note').textContent = value === 'inherit' ? `继承 ${providerNames[state.provider]} / ${aiNames[currentAI()]} 的共享参数` : '当前分组使用独立参数';
    icons();
  }
  function applyGroup(event) {
    event.preventDefault(); const form = $('group-form'); if (!form.reportValidity()) return;
    const key = form.elements.group_key.value.trim(); const clear = form.elements.clear_key.checked;
    const draft = structuredClone(state.group.draft);
    const error = message => { $('group-error').textContent = message; };
    if (key && clear) return error('不能同时填写和清除 Key');
    if (key && (key.length < 16 || /[\x00-\x20\x7f]/.test(key) || key.includes('***'))) return error('请填写完整的分组专用 Key');
    draft.enabled = form.elements.group_enabled.checked;
    draft.key_configured = clear ? false : key ? true : draft.key_configured;
    if (draft.tests) for (const kind of ['candy', 'pelican']) draft.tests[kind] = form.elements[`group_${kind}`].checked;
    draft.override = state.group.mode === 'inherit' ? null : readParams(form, state.group.params);
    const invalid = draft.enabled ? validateParams(draft.override || currentPlatform().params, state.provider) : '';
    if (invalid) return error(invalid);
    if (draft.enabled && !draft.key_configured) return error('启用分组前请配置分组专用 Key');
    if (draft.enabled && draft.tests && !['candy', 'pelican'].some(kind => currentPlatform().tests[kind] && draft.tests[kind])) return error('请选择至少一项已启用的检测');
    Object.assign(state.group.original, draft);
    $('group-dialog').close(); render(); dirty();
  }
  function historyFor(group) {
    const key = runKey(group.id);
    if (!state.runs.has(key)) state.runs.set(key, [42, 142, 242].map((minutes, index) => ({
      at: Date.now() - minutes * 60000, status: index === 1 && state.provider === 'manxue' ? 'failed' : 'passed',
      params: structuredClone(effective(group)), tests: activeTests(group), inherited: !group.override
    })));
    return state.runs.get(key);
  }
  function openHistory(id) {
    capture(); const group = currentGroups().find(group => group.id === id);
    $('history-path').textContent = `${providerNames[state.provider]} / ${aiNames[currentAI()]} / 分组 #${id}`;
    $('history-title').textContent = `${groupMeta(id).name} · 检测记录`;
    $('history-body').innerHTML = `<p class="inherit-note">模拟记录 · 未调用第三方或真实模型</p>${historyFor(group).map(record => `<article class="history-entry"><header><time>${stamp(record.at)}</time><span class="status ${record.status === 'passed' ? 'green' : 'amber'}">${icon(record.status === 'passed' ? 'circle-check' : 'circle-alert')}${record.status === 'passed' ? '通过' : '答案不符'}</span></header><p>${record.tests.join(' / ')} · ${esc(record.params.model)}</p><details><summary>执行时参数</summary><dl>${Object.entries(record.params).map(([key, value]) => `<dt>${esc(({ target_url: '上游地址', model: '检测模型', reasoning_effort: '思考等级', service_tier: '服务档位', protocol: '请求协议', timeout_seconds: '超时（秒）', cache_test: '缓存检测', thinking_test: '思考签名' })[key])}</dt><dd>${esc(typeof value === 'boolean' ? value ? '开启' : '关闭' : value || '默认')}</dd>`).join('')}<dt>参数来源</dt><dd>${record.inherited ? '平台共享参数' : '分组独立参数'}</dd></dl></details></article>`).join('')}`;
    icons(); $('history-dialog').showModal();
  }
  function run(ids) {
    if (state.dirty) return;
    const provider = state.provider; const ai = currentAI();
    const jobs = ids.map(id => currentGroups().find(group => group.id === id)).filter(group => group && runnable(group) && !state.busy.has(runKey(group.id))).map(group => {
      const key = runKey(group.id); const history = historyFor(group);
      state.busy.add(key);
      return { key, history, snapshot: { at: Date.now(), status: 'passed', params: structuredClone(effective(group)), tests: activeTests(group), inherited: !group.override } };
    });
    if (!jobs.length) return;
    capture(); render();
    setTimeout(() => {
      jobs.forEach(job => { job.history.unshift(job.snapshot); state.busy.delete(job.key); });
      if (state.provider === provider && currentAI() === ai) { capture(); render(); }
      toast(`模拟检测完成：${providerNames[provider]} / ${aiNames[ai]}，${jobs.length} 个分组`);
    }, 700);
  }
  function syncEffort(event) {
    if (!event.target.matches('[data-effort]')) return;
    const control = event.target.closest('.field').querySelector('[name="reasoning_effort"]');
    const custom = event.target.value === 'custom';
    control.hidden = !custom; control.disabled = !custom;
    if (custom) control.focus(); else control.value = event.target.value;
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if ('providerTab' in button.dataset || 'aiTab' in button.dataset) {
      capture();
      if (button.dataset.providerTab) state.provider = button.dataset.providerTab;
      if (button.dataset.aiTab) state.selected[state.provider] = button.dataset.aiTab;
      state.query = ''; state.error = ''; render();
    } else if (button.hasAttribute('data-save')) save();
    else if (button.dataset.editGroup) openGroup(button.dataset.editGroup);
    else if (button.dataset.runGroup) run([button.dataset.runGroup]);
    else if (button.hasAttribute('data-run-platform')) run(currentGroups().map(group => group.id));
    else if (button.dataset.historyGroup) openHistory(button.dataset.historyGroup);
    else if (button.hasAttribute('data-group-close')) $('group-dialog').close();
    else if (button.hasAttribute('data-history-close')) $('history-dialog').close();
    else if (button.hasAttribute('data-reload')) {
      if (state.dirty && !confirm('放弃未保存的演示更改？')) return;
      state.data = readSaved(); state.dirty = false; state.error = ''; render(); toast('已重新读取演示配置');
    } else if (button.hasAttribute('data-reset')) {
      if (!confirm('恢复全部示例配置？这只影响此 Demo。')) return;
      state.data = seed(); state.runs.clear(); state.saved = false; state.dirty = true; state.error = ''; render();
    } else if (button.hasAttribute('data-theme-toggle')) {
      const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    } else if (button.hasAttribute('data-add-time') || button.hasAttribute('data-remove-time')) {
      capture(); const plan = currentPlatform().schedule;
      if (button.hasAttribute('data-remove-time')) plan.times.pop();
      else plan.times.push(Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).find(time => !plan.times.includes(time)));
      render(); dirty();
    }
  });
  $('configuration').addEventListener('input', event => {
    syncEffort(event);
    if (event.target.id === 'group-search') {
      state.query = event.target.value.toLowerCase(); capture();
      const position = event.target.selectionStart; render(); $('group-search').focus(); $('group-search').setSelectionRange(position, position); return;
    }
    if (event.target.dataset.groupEnabled) {
      currentGroups().find(group => group.id === event.target.dataset.groupEnabled).enabled = event.target.checked;
      capture(); render(); dirty(); return;
    }
    capture(); dirty();
    if (event.target.name === 'schedule_enabled') $('schedule-controls').disabled = !event.target.checked;
  });
  $('configuration').addEventListener('change', event => {
    if (event.target.name === 'schedule_mode') { capture(); render(); dirty(); }
  });
  $('configuration').addEventListener('toggle', event => { if (event.target.matches('.advanced')) state.advanced = event.target.open; }, true);
  $('configuration').addEventListener('submit', event => { event.preventDefault(); save(); });
  $('group-form').addEventListener('submit', applyGroup);
  $('group-form').addEventListener('input', event => { syncEffort(event); $('group-error').textContent = ''; });
  $('group-form').addEventListener('change', event => { if (event.target.name === 'parameter_mode') groupModeChanged(event.target.value); });
  $('group-dialog').addEventListener('close', () => { state.group = null; $('group-body').replaceChildren(); });
  $('group-body').addEventListener('focusin', event => { if (event.target.matches('input,select')) event.target.scrollIntoView({ block: 'nearest' }); });
  document.addEventListener('keydown', event => {
    if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('button')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); const id = tabs[index].id; tabs[index].click(); $(id).focus();
  });
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  state.saved = Boolean(state.data.saved_at);
  render();
  if (query.get('group')) openGroup(query.get('group'));
})();
