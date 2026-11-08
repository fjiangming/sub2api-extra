(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ui = window.ModelResultRenderer;
  const { html, icon, badge } = ui;
  const channels = ['bazaarlink', 'cctest', 'fingerpoint'];
  const names = { bazaarlink: 'Bazaarlink Probe', cctest: 'CCTest', fingerpoint: 'Fingerpoint' };
  let context;
  const running = new Set();
  let dataBusy = false;
  const history = { groupId: '', channel: 'bazaarlink', rows: [], selected: new Set(), activeId: null, cursor: null, ticket: 0, busy: false, loading: false, timer: null, opener: null };
  const options = (items, selected) => items.map(([value, label]) => `<option value="${html(value)}"${String(selected) === String(value) ? ' selected' : ''}>${html(label)}</option>`).join('');
  const field = (title, control) => `<label class="field"><span>${html(title)}</span>${control}</label>`;
  function fingerprintHtml(config) {
    const select = (key, items) => `<select data-channel-field="${key}">${options(items, config[key])}</select>`;
    return `<article class="model-channel fp-channel" data-channel="fingerpoint"><header class="model-channel-head"><label class="model-check"><input type="checkbox" data-channel-enabled${config.enabled ? ' checked' : ''}><strong>${icon('fingerprint')}Fingerpoint</strong></label><span class="model-channel-state"></span></header><div class="model-channel-body"><div class="fp-channel-meta">${icon('scan-search')}官方检测逻辑<span>·</span>SDK ${html(context.state.data.fingerprint_data.sdk_version)}<span>·</span>无需检测网站 Key</div><div class="form-grid">${field('目标模型', `<input data-channel-field="model" maxlength="200" value="${html(config.model)}">`)}${field('目标协议', select('api', [['responses','OpenAI Responses'],['chat_completions','Chat Completions'],['messages','Anthropic Messages']]))}${field('推理强度', select('effort', [['','默认'],['none','None'],['low','Low'],['medium','Medium'],['high','High'],['xhigh','XHigh'],['max','Max']]))}${field('检测轮数', `<input type="number" data-channel-field="rounds" min="1" max="10" value="${config.rounds}">`)}</div><details><summary>取样设置</summary><div class="form-grid">${field('每轮样本数', select('count', [[3,'3 个 · 可提供校准置信度'],[2,'2 个 · 仅排名'],[1,'1 个 · 仅排名']]))}${field('请求并发', select('parallel', [[1,'1 · 依次请求'],[2,'2'],[3,'3']]))}</div><label class="model-check"><input type="checkbox" data-channel-strict${config.strict ? ' checked' : ''}><span>严格模式：要求每轮 3 个完整样本</span></label></details><p class="fp-estimate" data-fp-estimate></p><p class="model-setting-note">使用分组的模型检测专用 Key 直接请求目标 API，参考数据服务不接收该 Key。指纹结果独立展示，不计入降智率。</p></div></article>`;
  }
  function platformHtml(platform) {
    const config = platform.model_detection;
    const supported = ['openai', 'anthropic'].includes(platform.id);
    return `<section class="model-detection-block" data-model-platform><div class="model-detection-heading"><h4>模型检测</h4><label class="model-check"><input type="checkbox" data-model-enabled ${config.enabled ? 'checked' : ''} ${supported ? '' : 'disabled'}><span>启用模型检测</span></label></div>${supported ? '' : '<p class="model-setting-note">当前仅支持 OpenAI 与 Anthropic 平台。</p>'}<div class="form-grid"><label class="field"><span>目标 API 公网地址</span><input type="url" data-model-target value="${html(config.target_url)}" maxlength="2048" placeholder="https://api.example.com"></label><label class="field"><span>检测总超时（秒）</span><input type="number" data-model-timeout value="${config.timeout_seconds}" min="30" max="1800"></label></div><div class="model-channel-grid">${channels.map(key => {
      const channel = config.channels[key];
      if (key === 'fingerpoint') return fingerprintHtml(channel);
      return `<article class="model-channel" data-channel="${key}"><header class="model-channel-head"><label class="model-check"><input type="checkbox" data-channel-enabled ${channel.enabled ? 'checked' : ''}><strong>${names[key]}</strong></label><span class="model-channel-state"></span></header><div class="model-channel-body"><label class="field"><span>检测 API 地址</span><input type="url" data-channel-field="api_url" maxlength="2048" value="${html(channel.api_url)}"></label><div class="form-grid"><label class="field"><span>目标模型</span><input data-channel-field="model" maxlength="200" value="${html(channel.model)}"></label>${key === 'bazaarlink' ? `<label class="field"><span>目标协议</span><select data-channel-field="upstream_format">${[['auto','自动匹配'],['openai','Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic','Anthropic Messages']].map(([value,name]) => `<option value="${value}" ${channel.upstream_format === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>` : `<label class="field"><span>检测类型</span><select data-channel-field="provider">${[['auto','按平台自动匹配'],['codex','GPT / Responses'],['claude','Claude / Messages']].map(([value,name]) => `<option value="${value}" ${channel.provider === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`}</div><label class="field"><span>检测网站 API Key${key === 'bazaarlink' ? '（可选）' : ''}</span><input type="password" data-channel-key autocomplete="new-password" maxlength="8192" placeholder="${channel.key_configured ? '已安全保存，留空保持不变' : key === 'cctest' ? '填写 CCTest 控制台的 cct-… Key' : '无需认证时留空'}"></label><label class="model-check"><input type="checkbox" data-channel-clear><span>清除已保存的网站 Key</span></label>${key === 'cctest' ? `<div class="model-channel-options"><label class="model-check"><input type="checkbox" data-channel-attribution ${channel.attribution_only ? 'checked' : ''}><span>仅做指纹归因</span></label><label class="model-check"><input type="checkbox" data-channel-audit ${channel.check_token_usage ? 'checked' : ''}><span>启用 Token 用量审计</span></label></div>` : ''}</div></article>`;
    }).join('')}</div><p class="model-setting-note">目标地址须能被检测网站公网访问。仅使用分组单独配置的模型检测 Key；CCTest 按次消耗检测额度，Token 审计会增加目标请求。</p><div class="model-platform-actions"><button class="button" type="button" data-model-run-platform>${icon('play')}<span>检测本平台模型</span></button></div></section>`;
  }
  function groupHtml(group) {
    const config = group.model_detection;
    return `<section class="model-group-config" data-model-group-config data-model-saved="${config.enabled}" data-model-key-configured="${config.key_configured}"><div class="model-group-heading"><label class="model-check"><input type="checkbox" data-model-group-toggle ${config.enabled ? 'checked' : ''}><span>模型检测</span></label><span class="model-group-state"></span></div><div class="model-group-fields"><label class="field"><span>模型检测专用 Key</span><input type="password" data-model-group-key maxlength="8192" autocomplete="new-password" placeholder="${config.key_configured ? '已安全保存，留空保持不变' : '单独填写完整的模型检测 Key'}"></label><details class="model-group-overrides"><summary>分组目标模型（留空继承平台）</summary><div class="form-grid">${channels.map(key => `<label class="field"><span>${names[key]}</span><input data-model-group-model="${key}" maxlength="200" value="${html(config.models?.[key])}" placeholder="继承平台默认模型"></label>`).join('')}</div></details></div><div class="model-group-actions"><button class="button" type="button" data-model-run-group>${icon('scan-search')}<span>模型检测</span></button><button class="button" type="button" data-model-history>${icon('history')}<span>模型历史</span></button></div></section>`;
  }
  function updatePanel(panel) {
    const enabled = panel.querySelector('[data-model-enabled]').checked;
    let selected = 0;
    for (const card of panel.querySelectorAll('.model-channel')) {
      const active = enabled && card.querySelector('[data-channel-enabled]').checked;
      card.dataset.enabled = String(active);
      card.querySelector('.model-channel-state').textContent = active ? '已选择' : '未选择';
      for (const input of card.querySelectorAll('[data-channel-field="api_url"], [data-channel-field="model"]')) input.required = active;
      const audit = card.querySelector('[data-channel-audit]');
      if (audit) audit.disabled = card.querySelector('[data-channel-attribution]').checked;
      if (card.dataset.channel === 'fingerpoint') {
        const count = Number(card.querySelector('[data-channel-field="count"]').value);
        const rounds = Number(card.querySelector('[data-channel-field="rounds"]').value);
        const parallel = card.querySelector('[data-channel-field="parallel"]');
        for (const option of parallel.options) option.disabled = Number(option.value) > count;
        if (Number(parallel.value) > count) parallel.value = String(count);
        const strict = card.querySelector('[data-channel-strict]');
        strict.disabled = count !== 3;
        if (strict.disabled) strict.checked = false;
        card.querySelector('[data-fp-estimate]').textContent = `每组每次 ${rounds * count} 个目标请求 · ${rounds} 轮 × ${count} 个样本${count < 3 ? ' · 仅提供排名，不提供置信度' : ''}`;
      }
    }
    panel.querySelector('[data-model-target]').required = enabled;
    for (const row of panel.querySelectorAll('.group-row')) {
      const block = row.querySelector('[data-model-group-config]');
      const toggle = block.querySelector('[data-model-group-toggle]');
      toggle.disabled = !enabled;
      const active = enabled && toggle.checked;
      if (active) selected++;
      block.dataset.enabled = String(active);
      block.querySelector('.model-group-fields').hidden = !active;
      const key = block.querySelector('[data-model-group-key]');
      key.disabled = !active;
      block.querySelector('.model-group-state').textContent = !active ? '未启用' : key.value ? 'Key 待保存' : block.dataset.modelKeyConfigured === 'true' ? '专用 Key 已配置' : '需要单独配置 Key';
      block.querySelector('[data-model-run-group]').disabled = context.state.dirty || running.has(row.dataset.groupId) || !active || block.dataset.modelSaved !== 'true' || block.dataset.modelKeyConfigured !== 'true';
    }
    const platformButton = panel.querySelector('[data-model-run-platform]');
    platformButton.disabled = context.state.dirty || !enabled || !selected || running.has(`platform:${panel.dataset.platformIndex}`);
    const iqCount = [...panel.querySelectorAll('.group-row')].filter(row => row.dataset.selected === 'true').length;
    panel.querySelector('.selected-count').textContent = `${iqCount} 个降智检测 · ${selected} 个模型检测`;
  }
  function collectPlatform(panel) {
    const original = context.state.data.platforms[Number(panel.dataset.platformIndex)].model_detection;
    return { enabled: panel.querySelector('[data-model-enabled]').checked, target_url: panel.querySelector('[data-model-target]').value.trim(), timeout_seconds: Number(panel.querySelector('[data-model-timeout]').value), channels: Object.fromEntries([...panel.querySelectorAll('.model-channel')].map(card => {
      const key = card.dataset.channel;
      const old = original.channels[key];
      const read = field => card.querySelector(`[data-channel-field="${field}"]`)?.value ?? old[field];
      if (key === 'fingerpoint') return [key, { enabled: card.querySelector('[data-channel-enabled]').checked, model: read('model').trim(), api: read('api'), effort: read('effort'), rounds: Number(read('rounds')), count: Number(read('count')), parallel: Number(read('parallel')), strict: card.querySelector('[data-channel-strict]').checked }];
      return [key, { enabled: card.querySelector('[data-channel-enabled]').checked, api_url: read('api_url').trim(), model: read('model').trim(), upstream_format: read('upstream_format'), provider: read('provider'), attribution_only: card.querySelector('[data-channel-attribution]')?.checked || false, check_token_usage: card.querySelector('[data-channel-audit]')?.checked && !card.querySelector('[data-channel-attribution]')?.checked || false, api_key: card.querySelector('[data-channel-key]').value.trim(), clear_api_key: card.querySelector('[data-channel-clear]').checked }];
    })) };
  }
  function collectGroup(row) {
    const active = row.closest('.platform-panel').querySelector('[data-model-enabled]').checked && row.querySelector('[data-model-group-toggle]').checked;
    return { enabled: active, key: active ? row.querySelector('[data-model-group-key]').value.trim() : '', models: Object.fromEntries([...row.querySelectorAll('[data-model-group-model]')].map(input => [input.dataset.modelGroupModel, input.value.trim()])) };
  }
  function renderSchedule() {
    const schedule = context.state.data.model_schedule;
    $('model-schedule-enabled').checked = schedule.enabled;
    document.querySelector(`[name="model-schedule-mode"][value="${schedule.mode}"]`).checked = true;
    $('model-schedule-times').replaceChildren();
    for (const time of schedule.times) addTime(time, false);
    $('model-schedule-interval').value = schedule.interval_minutes;
    syncSchedule();
    renderData();
  }
  function addTime(value, dirty = true) {
    if ($('model-schedule-times').children.length >= 24) return;
    const item = document.createElement('div'); item.className = 'schedule-time-item';
    item.innerHTML = `<input type="time" required value="${html(value)}" aria-label="模型检测每日时间"><button type="button" class="icon-button schedule-time-remove" title="删除模型检测时间" aria-label="删除模型检测时间">${icon('x')}</button>`;
    item.querySelector('button').addEventListener('click', () => { if ($('model-schedule-times').children.length <= 1) return; item.remove(); context.markDirty(); syncSchedule(); });
    item.querySelector('input').addEventListener('change', context.markDirty);
    $('model-schedule-times').append(item);
    syncSchedule();
    if (dirty) context.markDirty();
    context.refreshIcons();
  }
  function syncSchedule() {
    const daily = $('model-schedule-daily').checked;
    $('model-schedule-daily-fields').hidden = !daily;
    $('model-schedule-interval-fields').hidden = daily;
    $('model-schedule-interval').disabled = daily;
    for (const input of $('model-schedule-times').querySelectorAll('input')) input.disabled = !daily;
    for (const button of $('model-schedule-times').querySelectorAll('button')) button.disabled = $('model-schedule-times').children.length <= 1;
    $('model-schedule-add').disabled = $('model-schedule-times').children.length >= 24;
  }
  function collectSchedule() { return { enabled: $('model-schedule-enabled').checked, mode: $('model-schedule-daily').checked ? 'daily' : 'interval', times: [...$('model-schedule-times').querySelectorAll('input')].map(input => input.value).sort(), interval_minutes: Number($('model-schedule-interval').value) }; }
  async function trigger(panel, row) {
    if (context.state.dirty) return context.toast('请先保存配置后再检测');
    const platform = context.state.data.platforms[Number(panel.dataset.platformIndex)];
    const id = row ? row.dataset.groupId : `platform:${panel.dataset.platformIndex}`;
    if (running.has(id)) return;
    running.add(id); updatePanel(panel);
    try {
      const result = await context.api(row ? `/api/admin/groups/${encodeURIComponent(id)}/model-runs` : `/api/admin/platforms/${encodeURIComponent(platform.id)}/model-runs`, { method: 'POST', body: {}, mutation: true });
      context.toast(`已排队 ${result.runs.length} 个独立渠道检测任务`);
      if (row) openHistory(id, result.runs[0]?.channel);
    } catch (error) { fail(error); }
    finally { running.delete(id); updatePanel(panel); }
  }
  function fail(error) {
    context.toast(error.message, 'error');
    if ([401, 403].includes(error.status)) { reset(); context.showError('管理员身份已失效，请从 Sub2API 重新打开。'); }
  }
  function bindPanel(panel) {
    panel.querySelector('[data-model-run-platform]').addEventListener('click', () => trigger(panel));
    for (const row of panel.querySelectorAll('.group-row')) {
      row.querySelector('[data-model-run-group]').addEventListener('click', () => trigger(panel, row));
      row.querySelector('[data-model-history]').addEventListener('click', () => openHistory(row.dataset.groupId));
      row.querySelector('[data-model-group-toggle]').addEventListener('change', event => { if (!event.target.checked) row.querySelector('[data-model-group-key]').value = ''; });
    }
    updatePanel(panel);
  }
  function outcome(run) { return ui.verdict(run.channel, { status: run.status, error: run.reason, identityAssessment: { verdict: { status: run.conclusion } }, verdictKey: run.conclusion }); }
  function renderHistory() {
    $('model-admin-history-list').innerHTML = history.rows.map(run => {
      const result = outcome(run);
      return `<div class="model-admin-history-row" data-active="${run.id === history.activeId}"><input type="checkbox" data-model-select="${run.id}" aria-label="选择记录 ${run.id}" ${history.selected.has(run.id) ? 'checked' : ''} ${['queued','running'].includes(run.status) ? 'disabled' : ''}><button type="button" data-model-record="${run.id}"><strong>${html(ui.formatDate(run.started * 1000))}</strong>${badge(result.text, result.tone)}<small>${html(run.model)}</small></button></div>`;
    }).join('') || '<p class="model-setting-note">该渠道暂无记录。</p>';
    $('model-admin-history-more').hidden = !history.cursor;
    updateSelection();
  }
  function updateSelection() {
    const eligible = history.rows.filter(run => !['queued','running'].includes(run.status));
    const selectAll = $('model-admin-select-all');
    selectAll.checked = eligible.length > 0 && eligible.every(run => history.selected.has(run.id));
    selectAll.indeterminate = !selectAll.checked && history.selected.size > 0;
    selectAll.disabled = history.busy || !eligible.length;
    for (const input of $('model-admin-history-list').querySelectorAll('[data-model-select]')) input.checked = history.selected.has(Number(input.dataset.modelSelect));
    $('model-admin-delete-selected').disabled = history.busy || !history.selected.size;
    $('model-admin-clear-all').disabled = history.busy;
    $('model-admin-selection').textContent = `已选 ${history.selected.size} 条`;
  }
  async function loadHistory(append = false, preserve = false) {
    const ticket = ++history.ticket;
    history.loading = true;
    try {
      const result = await context.api(`/api/admin/groups/${encodeURIComponent(history.groupId)}/model-runs/${history.channel}${append && history.cursor ? `?before=${history.cursor}` : ''}`);
      if (ticket !== history.ticket || !$('model-admin-history-dialog').open) return;
      const previous = history.rows;
      history.rows = append ? [...previous, ...result.runs] : preserve ? [...result.runs, ...previous.filter(row => row.id < (result.runs.at(-1)?.id || 0))] : result.runs;
      if (!preserve || !previous.length) history.cursor = result.next_cursor;
      const eligibleIds = new Set(history.rows.filter(run => !['queued','running'].includes(run.status)).map(run => run.id));
      history.selected = new Set([...history.selected].filter(id => eligibleIds.has(id)));
      $('model-admin-history-meta').textContent = `${names[history.channel]} · 详细记录 ${result.total} 条 · 已归档 ${result.archived} 条`;
      if (!history.rows.some(row => row.id === history.activeId)) history.activeId = history.rows[0]?.id || null;
      renderHistory();
      if (history.activeId) await loadDetail(preserve); else $('model-admin-detail').innerHTML = '<p class="yzai-pelican-empty">该渠道尚无检测记录。</p>';
    } catch (error) { if (ticket === history.ticket) { $('model-admin-detail').innerHTML = `<p class="yzai-pelican-empty">${html(error.message)}</p>`; fail(error); } }
    finally { history.loading = false; }
  }
  async function loadDetail(preserve = false) {
    const ticket = ++history.ticket;
    const box = $('model-admin-detail');
    const scrollTop = preserve ? box.scrollTop : 0;
    const expanded = preserve ? [...box.querySelectorAll('details')].map(item => item.open) : [];
    if (!preserve) box.innerHTML = '<p class="yzai-pelican-empty">正在读取检测项…</p>';
    try {
      const result = await context.api(`/api/admin/model-results/${history.activeId}`);
      if (ticket !== history.ticket || !$('model-admin-history-dialog').open) return;
      const mode = { ...result.mode, local_status: result.status, local_reason: result.reason };
      const render = ({ bazaarlink: ui.renderProbe, cctest: ui.renderCheck, fingerpoint: ui.renderFingerprint })[result.channel];
      box.innerHTML = `${result.reason ? `<p class="model-notice">${html(result.reason)}</p>` : ''}${result.response ? render(result.response, mode) : `<p class="yzai-pelican-empty">${['queued','running'].includes(result.status) ? '检测进行中，结果将自动更新。' : '该记录未保留详细响应。'}</p>`}`;
      if (preserve) box.querySelectorAll('details').forEach((item, index) => { if (index < expanded.length) item.open = expanded[index]; });
      box.scrollTop = scrollTop;
      context.refreshIcons();
    } catch (error) { if (ticket === history.ticket) { $('model-admin-detail').innerHTML = `<p class="yzai-pelican-empty">${html(error.message)}</p>`; fail(error); } }
  }
  function openHistory(groupId, channel = 'bazaarlink') {
    history.opener = document.activeElement;
    Object.assign(history, { groupId, channel, rows: [], selected: new Set(), activeId: null, cursor: null, busy: false });
    const group = context.state.data.platforms.flatMap(platform => platform.groups).find(item => item.id === groupId);
    $('model-admin-history-title').textContent = `模型检测 · ${group?.name || groupId}`;
    $('model-admin-channel').value = channel;
    renderHistory(); $('model-admin-history-dialog').showModal(); loadHistory();
    clearInterval(history.timer);
    history.timer = setInterval(() => {
      if (!history.busy && !history.loading && history.rows.some(run => ['queued','running'].includes(run.status))) loadHistory(false, true);
    }, 5000);
  }
  async function deleteHistory(all) {
    if (history.busy || !all && !history.selected.size) return;
    const accepted = await context.confirmDeletion(all ? `清空该分组在 ${names[history.channel]} 的全部已完成模型检测记录？` : `删除选中的 ${history.selected.size} 条模型检测记录？`, all ? '清空模型历史' : '删除模型记录');
    if (!accepted || !$('model-admin-history-dialog').open) return;
    history.busy = true; renderHistory();
    try {
      const result = await context.api(`/api/admin/groups/${encodeURIComponent(history.groupId)}/model-runs/${history.channel}`, { method: 'DELETE', body: all ? { all: true } : { ids: [...history.selected] }, mutation: true });
      history.selected.clear(); await loadHistory(); context.toast(`已删除 ${result.deleted} 条模型检测记录`);
    } catch (error) { fail(error); }
    finally { history.busy = false; renderHistory(); }
  }
  let dataTimer; let dataTicket = 0;
  function collectData() { return { automatic: $('fp-data-auto').checked, interval_hours: Number($('fp-data-interval').value), application: $('fp-data-application').value, source: $('fp-data-source').value }; }
  function renderData() {
    const data = context.state.data.fingerprint_data;
    const active = data.active;
    const referenceText = data.last_error ? '上次操作未完成' : data.available ? '参考数据有更新' : !active ? '尚未下载参考数据' : !data.last_checked ? '尚未检查更新' : '参考数据无可用更新';
    const sdkText = ({ unchecked: '尚未检查', current: '已是最新', update_available: `可升级至 ${data.sdk_available_version}`, upgrade_required: '需要升级镜像' })[data.sdk_status] || '尚未检查';
    $('fingerprint-data').innerHTML = `<div class="fp-data-heading"><div class="section-heading"><span class="section-icon">${icon('database-backup')}</span><div><h2>指纹检测数据与更新</h2><p>Fingerpoint · 参考数据与检测程序分别管理</p></div></div>${badge(data.busy ? '正在处理' : referenceText, data.last_error || data.available ? 'warning' : 'neutral')}</div><div class="fp-data-controls"><label class="model-check"><input id="fp-data-auto" type="checkbox"${data.automatic ? ' checked' : ''}><span>自动检查参考数据</span></label>${field('检查间隔（小时）', `<input id="fp-data-interval" type="number" min="1" max="168" required value="${data.interval_hours}">`)}${field('发现新参考数据时', `<select id="fp-data-application">${options([['automatic','校验后自动应用'],['manual','通知后手动应用']], data.application)}</select>`)}${field('数据来源', `<select id="fp-data-source">${options([['official','官方优先 · 镜像备用'],['mirror','镜像优先 · 官方备用']], data.source)}</select>`)}</div><div class="data-scroll"><table class="model-table fp-version-table"><thead><tr><th>更新内容</th><th>当前版本</th><th>状态</th><th>更新方式</th></tr></thead><tbody><tr><td>参考模型与评分参数</td><td>${active ? `<strong>${html(active.built_at.slice(0, 10))}</strong> · ${active.models} 个模型<br><code>SHA-256 ${html(active.hash.slice(0, 16))}…</code>` : '尚未下载'}</td><td>${badge(data.available ? `可更新至 ${data.available.built_at.slice(0, 10)}` : referenceText, data.available || data.last_error ? 'warning' : 'neutral')}</td><td>自动或手动更新，即时生效</td></tr><tr><td>检测程序与请求逻辑</td><td><strong>SDK ${html(data.sdk_version)}</strong></td><td>${badge(sdkText, ['update_available','upgrade_required'].includes(data.sdk_status) ? 'warning' : 'neutral')}</td><td>随服务镜像升级</td></tr></tbody></table></div><div class="fp-data-status"><span>上次检查 ${html(ui.formatDate(data.last_checked))}<br>${data.automatic ? data.next_check ? `下次检查 ${html(ui.formatDate(data.next_check))}` : '启用该渠道后自动检查' : '自动检查已关闭'}</span><div class="fp-data-actions"><button class="button" type="button" data-fp-update="check">${icon('refresh-cw')}检查更新</button><button class="button primary" type="button" data-fp-update="apply"${data.available ? '' : ' disabled'}>${icon('download')}应用数据更新</button><button class="icon-button" type="button" data-fp-update="rollback"${data.can_rollback ? '' : ' disabled'} aria-label="恢复上一版参考数据" title="恢复上一版参考数据">${icon('rotate-ccw')}</button></div></div><p class="fp-data-footnote">参考数据更新包含新增模型、评分参数与校准；加载验证成功后切换，失败时保留可用版本。挑战生成或协议逻辑变更需要升级服务镜像，历史结果保留当时版本。<button class="fp-history-link" id="fp-version-history" type="button">查看更新记录</button></p><p id="fp-update-live" class="fp-update-live" role="status"${data.last_error ? ' data-error="true"' : ''}>${html(data.busy ? '正在处理参考数据，请稍候…' : data.last_error)}</p>`;
    const sync = () => { $('fp-data-interval').disabled = !$('fp-data-auto').checked; $('fp-data-application').disabled = !$('fp-data-auto').checked; };
    for (const input of $('fingerprint-data').querySelectorAll('input, select')) input.addEventListener('change', () => { context.markDirty(); sync(); });
    sync();
    for (const button of $('fingerprint-data').querySelectorAll('[data-fp-update]')) { if (data.busy) button.disabled = true; button.addEventListener('click', () => updateData(button.dataset.fpUpdate)); }
    $('fp-version-history').addEventListener('click', showVersions);
    context.refreshIcons();
    if (data.busy) pollData();
  }
  function showVersions() {
    let dialog = $('fp-version-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'fp-version-dialog'; dialog.className = 'fp-version-dialog'; dialog.setAttribute('aria-labelledby', 'fp-version-title');
      dialog.innerHTML = `<header><h2 id="fp-version-title">参考数据更新记录</h2><button class="icon-button" type="button" aria-label="关闭版本记录" title="关闭版本记录">${icon('x')}</button></header><div class="fp-version-content"></div>`;
      document.body.append(dialog); dialog.querySelector('button').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
    }
    dialog.querySelector('.fp-version-content').innerHTML = `<div class="data-scroll"><table class="model-table"><thead><tr><th>操作时间</th><th>操作</th><th>数据版本</th><th>状态</th></tr></thead><tbody>${context.state.data.fingerprint_data.history.map(item => `<tr><td>${html(ui.formatDate(item.at))}</td><td>${html(item.action)}</td><td>${html(item.version)}</td><td>${html(item.status)}</td></tr>`).join('') || '<tr><td colspan="4">暂无更新记录</td></tr>'}</tbody></table></div>`;
    dialog.showModal(); context.refreshIcons();
  }
  function pollData(failureMessage = '') {
    clearTimeout(dataTimer);
    const ticket = dataTicket;
    dataTimer = setTimeout(async () => {
      try {
        const data = await context.api('/api/admin/fingerpoint/data');
        if (ticket !== dataTicket) return;
        const settings = context.state.dirty ? collectData() : {};
        context.state.data.fingerprint_data = { ...data, ...settings };
        renderData();
        if (!data.busy) { dataBusy = false; if (!data.last_error) { $('fp-update-live').textContent = failureMessage || '参考数据操作已完成'; $('fp-update-live').dataset.error = String(Boolean(failureMessage)); } }
      } catch (error) { if (ticket !== dataTicket) return; dataBusy = false; fail(error); if (![401,403].includes(error.status)) { $('fp-update-live').textContent = '读取进度失败，请重新加载配置核对结果'; $('fp-update-live').dataset.error = 'true'; } }
    }, 2000);
  }
  async function updateData(action) {
    if (dataBusy) return;
    if (context.state.dirty) return context.toast('请先保存配置后再执行更新');
    if (action === 'rollback' && !await context.confirmDeletion('恢复上一版参考数据？正在执行的检测和历史记录保留原版本。', '恢复参考数据')) return;
    const ticket = dataTicket; dataBusy = true;
    for (const button of $('fingerprint-data').querySelectorAll('[data-fp-update]')) button.disabled = true;
    $('fp-update-live').textContent = '正在提交参考数据操作…';
    try {
      const data = await context.api(`/api/admin/fingerpoint/data/${action}`, { method: 'POST', body: {}, mutation: true });
      if (ticket !== dataTicket) return;
      context.state.data.fingerprint_data = data; renderData();
      if (!data.busy) { dataBusy = false; if (!data.last_error) $('fp-update-live').textContent = '参考数据操作已完成'; }
    } catch (error) {
      if (ticket !== dataTicket) return;
      dataBusy = false; fail(error);
      if (![401,403].includes(error.status)) { renderData(); $('fp-update-live').textContent = error.message; $('fp-update-live').dataset.error = 'true'; pollData(error.message); }
    }
  }
  function reset() { dataTicket++; clearTimeout(dataTimer); dataBusy = false; $('fp-version-dialog')?.close(); $('fingerprint-data').replaceChildren(); history.ticket++; $('model-admin-history-dialog').close(); document.querySelectorAll('[data-channel-key], [data-model-group-key]').forEach(input => { input.value = ''; }); }
  function connect(value) {
    context = value;
    for (const input of document.querySelectorAll('[name="model-schedule-mode"], #model-schedule-enabled, #model-schedule-interval')) input.addEventListener('change', () => { syncSchedule(); context.markDirty(); });
    $('model-schedule-add').addEventListener('click', () => {
      const used = new Set([...$('model-schedule-times').querySelectorAll('input')].map(input => input.value));
      let minute = 570; while (used.has(`${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`)) minute = (minute + 30) % 1440;
      addTime(`${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`);
    });
    $('model-admin-history-close').addEventListener('click', () => $('model-admin-history-dialog').close());
    $('model-admin-history-dialog').addEventListener('close', () => { history.ticket++; clearInterval(history.timer); history.timer = null; $('model-admin-detail').replaceChildren(); if (history.opener?.isConnected) history.opener.focus(); });
    $('model-admin-channel').addEventListener('change', event => { history.channel = event.target.value; history.selected.clear(); history.activeId = null; loadHistory(); });
    $('model-admin-history-refresh').addEventListener('click', () => loadHistory());
    $('model-admin-history-more').addEventListener('click', () => loadHistory(true));
    $('model-admin-delete-selected').addEventListener('click', () => deleteHistory(false));
    $('model-admin-clear-all').addEventListener('click', () => deleteHistory(true));
    $('model-admin-select-all').addEventListener('change', event => {
      if (event.target.checked) for (const row of history.rows.filter(run => !['queued','running'].includes(run.status)).slice(0,100)) history.selected.add(row.id);
      else history.selected.clear(); updateSelection();
    });
    $('model-admin-history-list').addEventListener('change', event => {
      const id = Number(event.target.dataset.modelSelect);
      if (!id) return;
      if (event.target.checked && history.selected.size >= 100) { event.target.checked = false; return context.toast('一次最多选择 100 条记录'); }
      if (event.target.checked) history.selected.add(id); else history.selected.delete(id); updateSelection();
    });
    $('model-admin-history-list').addEventListener('click', event => { const button = event.target.closest('[data-model-record]'); if (button) { history.activeId = Number(button.dataset.modelRecord); renderHistory(); loadDetail(); } });
  }
  window.ModelConfig = { platformHtml, groupHtml, bindPanel, updatePanel, collectPlatform, collectGroup, renderSchedule, collectSchedule, collectData, connect, reset };
})();
