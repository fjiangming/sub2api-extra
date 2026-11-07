(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ui = window.ModelResultRenderer;
  const { html, icon, badge } = ui;
  const channels = ['bazaarlink', 'cctest'];
  const names = { bazaarlink: 'Bazaarlink Probe', cctest: 'CCTest' };
  let context;
  const running = new Set();
  const history = { groupId: '', channel: 'bazaarlink', rows: [], selected: new Set(), activeId: null, cursor: null, ticket: 0, busy: false, loading: false, timer: null, opener: null };
  function platformHtml(platform) {
    const config = platform.model_detection;
    const supported = ['openai', 'anthropic'].includes(platform.id);
    return `<section class="model-detection-block" data-model-platform><div class="model-detection-heading"><h4>模型检测</h4><label class="model-check"><input type="checkbox" data-model-enabled ${config.enabled ? 'checked' : ''} ${supported ? '' : 'disabled'}><span>启用模型检测</span></label></div>${supported ? '' : '<p class="model-setting-note">当前仅支持 OpenAI 与 Anthropic 平台。</p>'}<div class="form-grid"><label class="field"><span>目标 API 公网地址</span><input type="url" data-model-target value="${html(config.target_url)}" maxlength="2048" placeholder="https://api.example.com"></label><label class="field"><span>检测总超时（秒）</span><input type="number" data-model-timeout value="${config.timeout_seconds}" min="30" max="1800"></label></div><div class="model-channel-grid">${channels.map(key => {
      const channel = config.channels[key];
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
      box.innerHTML = `${result.reason ? `<p class="model-notice">${html(result.reason)}</p>` : ''}${result.response ? result.channel === 'bazaarlink' ? ui.renderProbe(result.response, mode) : ui.renderCheck(result.response, mode) : `<p class="yzai-pelican-empty">${['queued','running'].includes(result.status) ? '检测进行中，结果将自动更新。' : '该记录未保留详细响应。'}</p>`}`;
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
  function reset() { history.ticket++; $('model-admin-history-dialog').close(); document.querySelectorAll('[data-channel-key], [data-model-group-key]').forEach(input => { input.value = ''; }); }
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
  window.ModelConfig = { platformHtml, groupHtml, bindPanel, updatePanel, collectPlatform, collectGroup, renderSchedule, collectSchedule, connect, reset };
})();
