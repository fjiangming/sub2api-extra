(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ui = window.ModelResultRenderer;
  const { html, badge, icon, duration } = ui;
  const state = { view: location.hash === '#model' ? 'model' : 'iq', ready: false, available: { iq: false, model: false }, data: null, platform: '', channel: '', busy: false, groupId: '', selectedChannel: '', history: [], cursor: null, selectedId: null, ticket: 0, detail: null, opener: null };
  const names = { bazaarlink: 'Bazaarlink Probe', cctest: 'CCTest' };
  const date = timestamp => timestamp ? ui.formatDate(timestamp * 1000) : '尚无记录';
  const group = () => state.data?.groups.find(item => item.id === state.groupId);
  function conclusion(channel, run) {
    if (!run) return { text: '尚未检测', tone: 'neutral' };
    return ui.verdict(channel, { status: run.status, error: run.reason, identityAssessment: { verdict: { status: run.conclusion, reasoning: '详细身份结论及证据见检测项。' } }, verdictKey: run.conclusion === 'unconfirmed' ? null : run.conclusion });
  }
  async function load() {
    if (state.busy || !state.ready) return;
    state.busy = true;
    $('model-refresh').classList.add('busy');
    try {
      state.data = await api('/api/model-results');
      const schedule = state.data.schedule;
      $('model-meta').textContent = `只读结果 · ${schedule.enabled ? schedule.mode === 'daily' ? `每日 ${schedule.times.join('、')}` : `每隔 ${schedule.interval_minutes} 分钟` : '自动检测未启用'} · ${state.data.groups.length} 个分组 · 各渠道独立记录`;
      const selected = $('model-platform-filter').value;
      $('model-platform-filter').innerHTML = '<option value="">全部平台</option>' + state.data.platforms.map(platform => `<option value="${html(platform.id)}">${html(platform.label)}</option>`).join('');
      $('model-platform-filter').value = state.data.platforms.some(item => item.id === selected) ? selected : '';
      state.platform = $('model-platform-filter').value;
      renderGroups();
      if (!state.data.groups.length) {
        state.available.model = false;
        setView(state.view, false, false);
      }
      if ($('model-dialog').open) {
        if (!group()?.channels[state.selectedChannel]) $('model-dialog').close();
        else {
          const latest = group().channels[state.selectedChannel].latest;
          if (latest && !state.history.some(item => item.id === latest.id)) state.history.unshift(latest);
          if (latest) state.history = state.history.map(item => item.id === latest.id ? latest : item);
          renderHistory();
          if (['queued', 'running'].includes(state.detail?.status) || state.selectedId === latest?.id && state.detail?.status !== latest?.status) await loadDetail(state.selectedId, true);
        }
      }
    } catch (error) {
      if (!state.data) $('model-grid').innerHTML = `<div class="empty-list"><p>${html(error.message)}</p></div>`;
      else toast(error.message, 'error');
      if ([401, 403].includes(error.status)) { $('model-dialog').close(); state.data = null; $('model-grid').replaceChildren(); }
    } finally { state.busy = false; $('model-refresh').classList.remove('busy'); }
  }
  function renderGroups() {
    const groups = state.data.groups.filter(item => (!state.platform || item.platform === state.platform) && (!state.channel || item.channels[state.channel]));
    $('model-group-count').textContent = `${groups.length} 个分组`;
    $('model-grid').innerHTML = groups.map(item => {
      const entries = Object.entries(item.channels).filter(([key]) => !state.channel || key === state.channel);
      return `<article class="group-card model-card"><div class="group-card-head"><div><h2>${html(item.name)}</h2><span class="group-id">#${html(item.id)}</span></div><span class="platform-label">${icon(item.platform === 'openai' ? 'sparkles' : 'bot')}${html(item.platform_label)}</span></div><div class="group-model"><span>${entries.length} 个检测渠道</span><span>${item.next_run_at ? `下次 ${html(date(item.next_run_at))}` : '自动检测未启用'}</span></div>${entries.map(([key, channel]) => {
        const run = channel.latest;
        const result = conclusion(key, run);
        return `<section class="channel-result"><div class="channel-line"><span>${icon(key === 'bazaarlink' ? 'fingerprint' : 'shield-check')}<strong>${html(channel.name)}</strong></span>${badge(result.text, result.tone)}</div><p class="channel-meta">${html(run?.model || channel.model)} · ${html(date(run?.started))}</p><p class="channel-reason">${run?.total == null ? '' : `网站总分 ${html(run.total)} 分；`}${html(run?.reason || result.reason || '')}</p><div class="channel-action"><span>${run ? `${run.item_count} 个返回项 · ${html(duration(run.duration_ms))}` : '尚无检测结果'}</span><button class="channel-detail-button" type="button" data-model-open="${html(item.id)}" data-model-channel="${key}">查看全部检测项${icon('arrow-up-right')}</button></div></section>`;
      }).join('')}<div class="card-foot">独立检测记录 · 不计入降智率</div></article>`;
    }).join('') || '<div class="empty-list"><i data-lucide="folder-search"></i><p>当前筛选下暂无已启用的模型检测分组。</p></div>';
    refreshIcons();
  }
  function setView(view, focus = false, reload = true) {
    if (!state.available[view]) view = state.available.iq ? 'iq' : state.available.model ? 'model' : null;
    state.view = view;
    const iq = view === 'iq';
    const model = view === 'model';
    const tabs = document.querySelector('.result-tabs');
    for (const [id, hidden] of [['iq-pane', !iq], ['model-pane', !model], ['page-meta', !iq], ['model-meta', !model], ['capability-note', !iq], ['refresh-button', model], ['model-refresh', !model], ['detection-empty', Boolean(view)]]) $(id).hidden = hidden;
    $('page-title').textContent = model ? '模型检测' : iq ? '降智检测' : '检测结果';
    document.querySelector('.page-mark').innerHTML = icon(model ? 'scan-search' : iq ? 'brain-circuit' : 'folder-search');
    const focusedTab = document.activeElement?.closest('.result-tabs button');
    tabs.hidden = !state.available.iq && !state.available.model;
    for (const name of ['iq', 'model']) {
      const tab = $(`${name}-tab`);
      tab.hidden = !state.available[name];
      tab.setAttribute('aria-selected', String(name === view));
      tab.tabIndex = name === view ? 0 : -1;
    }
    if (!state.available.iq && $('result-dialog').open) $('result-dialog').close();
    if (!state.available.model && $('model-dialog').open) $('model-dialog').close();
    if (focus || focusedTab?.hidden) (view ? $(`${view}-tab`) : $('detection-empty')).focus();
    refreshIcons();
    if (model && reload) load();
  }
  function renderTabs() {
    $('model-channel-tabs').innerHTML = Object.entries(group().channels).map(([key, entry]) => {
      const result = conclusion(key, entry.latest);
      return `<button type="button" role="tab" data-channel-tab="${key}" aria-selected="${key === state.selectedChannel}" aria-controls="model-detail" tabindex="${key === state.selectedChannel ? 0 : -1}">${html(entry.name)}${badge(result.text, result.tone)}</button>`;
    }).join('');
  }
  function renderHistory() {
    $('model-history').innerHTML = `<small class="model-history-label">${html(names[state.selectedChannel])} · 独立历史</small>${state.history.map(run => {
      const result = conclusion(state.selectedChannel, run);
      return `<button type="button" data-model-history="${run.id}" aria-current="${run.id === state.selectedId}"><strong>${html(date(run.started))}</strong>${badge(result.text, result.tone)}<small>${html(run.model)}</small><small>${run.trigger_type === 'scheduled' ? '定时检测' : '手动检测'}</small></button>`;
    }).join('')}${state.cursor ? '<button type="button" data-model-more>加载更早记录</button>' : ''}`;
  }
  async function loadHistory(append = false) {
    const selectedGroup = state.groupId;
    const selectedChannel = state.selectedChannel;
    const ticket = ++state.ticket;
    $('model-detail').innerHTML = '<p class="yzai-pelican-empty">正在读取检测记录…</p>';
    try {
      const result = await api(`/api/model/groups/${encodeURIComponent(selectedGroup)}/channels/${selectedChannel}/runs${append && state.cursor ? `?before=${state.cursor}` : ''}`);
      if (ticket !== state.ticket || !$('model-dialog').open) return;
      state.history = append ? [...state.history, ...result.runs] : result.runs;
      state.cursor = result.next_cursor;
      if (!state.history.some(run => run.id === state.selectedId)) state.selectedId = state.history[0]?.id || null;
      renderHistory();
      if (state.selectedId) await loadDetail(state.selectedId);
      else $('model-detail').innerHTML = '<p class="yzai-pelican-empty">该渠道尚无检测记录。</p>';
    } catch (error) { if (ticket === state.ticket) $('model-detail').innerHTML = `<p class="yzai-pelican-empty">${html(error.message)}</p>`; }
  }
  async function loadDetail(id, preserve = false) {
    if (!id) return;
    const ticket = ++state.ticket;
    const detailBox = $('model-detail');
    const scrollTop = preserve ? detailBox.scrollTop : 0;
    const expanded = preserve ? [...detailBox.querySelectorAll('details')].map((item, index) => item.open ? index : null).filter(index => index != null) : [];
    if (!preserve) detailBox.innerHTML = '<p class="yzai-pelican-empty">正在读取检测项…</p>';
    try {
      const result = await api(`/api/model-results/${id}`);
      if (ticket !== state.ticket || !$('model-dialog').open) return;
      state.detail = result;
      const mode = { ...result.mode, local_status: result.status, local_reason: result.reason };
      detailBox.innerHTML = `<p class="model-detail-meta">本地记录时间：${html(date(result.started))} · ${result.trigger_type === 'scheduled' ? '定时检测' : '手动检测'} · ${html(duration(result.duration_ms))}</p>${result.reason ? `<p class="model-notice">${icon('info')}${html(result.reason)}</p>` : ''}${result.response ? state.selectedChannel === 'bazaarlink' ? ui.renderProbe(result.response, mode) : ui.renderCheck(result.response, mode) : `<p class="yzai-pelican-empty">${['queued', 'running'].includes(result.status) ? '检测进行中，结果将自动更新。' : '该历史记录未保留详细响应。'}</p>`}`;
      if (preserve) detailBox.querySelectorAll('details').forEach((item, index) => { item.open = expanded.includes(index); });
      detailBox.scrollTop = scrollTop;
      refreshIcons();
    } catch (error) { if (ticket === state.ticket) detailBox.innerHTML = `<p class="yzai-pelican-empty">${html(error.message)}</p>`; }
  }
  function open(groupId, channel) {
    state.opener = document.activeElement;
    state.groupId = groupId;
    state.selectedChannel = channel;
    state.history = [];
    state.selectedId = null;
    state.detail = null;
    $('model-dialog-title').textContent = `模型检测 · ${group().name}`;
    $('model-dialog-subtitle').textContent = `${group().platform_label} · 分组 #${groupId} · 各渠道独立历史`;
    renderTabs(); renderHistory();
    $('model-dialog').showModal();
    loadHistory();
  }
  $('model-grid').addEventListener('click', event => { const button = event.target.closest('[data-model-open]'); if (button) open(button.dataset.modelOpen, button.dataset.modelChannel); });
  $('model-history').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.modelHistory) { state.selectedId = Number(button.dataset.modelHistory); renderHistory(); loadDetail(state.selectedId); }
    else if (button?.hasAttribute('data-model-more')) { button.disabled = true; loadHistory(true); }
  });
  $('model-channel-tabs').addEventListener('click', event => { const button = event.target.closest('[data-channel-tab]'); if (button) { state.selectedChannel = button.dataset.channelTab; state.selectedId = null; state.detail = null; renderTabs(); loadHistory(); $('model-channel-tabs').querySelector(`[data-channel-tab="${state.selectedChannel}"]`).focus(); } });
  $('model-channel-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...$('model-channel-tabs').querySelectorAll('button')]; const index = tabs.findIndex(tab => tab.dataset.channelTab === state.selectedChannel);
    event.preventDefault(); tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].click();
  });
  $('model-dialog-close').addEventListener('click', () => $('model-dialog').close());
  $('model-dialog').addEventListener('close', () => { state.ticket++; state.detail = null; $('model-detail').replaceChildren(); if (state.opener?.isConnected) state.opener.focus(); });
  $('model-dialog').addEventListener('click', event => { if (event.target !== $('model-dialog')) return; const b = event.target.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) event.target.close(); });
  $('iq-tab').addEventListener('click', () => setView('iq'));
  $('model-tab').addEventListener('click', () => setView('model'));
  document.querySelector('.result-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = ['iq', 'model'].filter(name => state.available[name]);
    if (!available.length) return;
    event.preventDefault();
    const index = available.indexOf(state.view);
    setView(available[event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length], true);
  });
  $('model-platform-filter').addEventListener('change', event => { state.platform = event.target.value; renderGroups(); });
  $('model-channel-filter').addEventListener('change', event => { state.channel = event.target.value; renderGroups(); });
  $('model-refresh').addEventListener('click', load);
  document.addEventListener('detector:refreshed', event => {
    state.ready = true;
    state.available = event.detail.tabs || { iq: event.detail.groups > 0, model: true };
    $('iq-tab-count').textContent = `${event.detail.groups} 个分组`;
    if (!state.available.model) { state.data = null; $('model-grid').replaceChildren(); }
    setView(state.view);
  });
})();
