'use strict';

(() => {
  const fixture = window.ConversationDemo;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const badge = (text, color = '') => `<span class="cl-badge ${color}">${escape(text)}</span>`;
  const encoder = new TextEncoder();
  const bytes = text => encoder.encode(text).length;
  const size = value => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
  const formatNumber = value => Number(value).toLocaleString('en-US');
  const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const time = (value, full = false) => dateFormatter.format(new Date(value)).slice(full ? 0 : 11);
  const storageKey = 'sub2api-conversation-logs-demo-policy-v1';
  const captureLabels = { complete: '完整采集', partial: '正文不完整', missing: '正文缺失', redaction_failed: '脱敏失败' };
  const captureColors = { complete: 'green', partial: 'amber', missing: 'amber', redaction_failed: 'red' };
  const modeLabels = { dual: '原文 + 脱敏副本', masked: '仅脱敏副本', original: '仅原文' };
  const records = [...fixture.records];
  let policyLoadIssue = '';
  let policy = loadPolicy(), customRules = structuredClone(policy.custom), excludedUserIds = new Set(policy.excludedUserIds);
  const state = { view: 'requests', scenario: 'normal', selected: 'req_demo_0001', page: 1, pageSize: 6,
    attempt: null, detailTab: 'payload', source: 'masked', wrap: true, session: 'sess_order_01', preview: 'request', mobileDetail: false, simulationUser: 1001 };
  let chart, renderVersion = 0, modalPayload = null, nextSequence = 32;
  function loadPolicy() {
    const defaults = structuredClone(fixture.defaultPolicy);
    const pause = () => { policyLoadIssue = '保存策略无法读取，采集已暂停；请检查后重新保存。'; return { ...defaults, enabled: false }; };
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === null) return defaults;
      const saved = JSON.parse(stored);
      if (!saved || !Object.hasOwn(modeLabels, saved.mode) || !Number.isInteger(saved.version) || saved.version < 1 || saved.version > 9999) return pause();
      for (const key of ['enabled', 'email', 'phone', 'secret', 'ip']) if (typeof saved[key] !== 'boolean') return pause();
      for (const [key, max] of [['retention', 365], ['capacity', 1024], ['reserve', 1024]]) if (!Number.isInteger(saved[key]) || saved[key] < 1 || saved[key] > max) return pause();
      if (!['stop', 'evict'].includes(saved.overflow) || !Array.isArray(saved.custom) || saved.custom.length > 10 || saved.custom.some(rule => !validRule(rule))) return pause();
      const excluded = Object.hasOwn(saved, 'excludedUserIds') ? saved.excludedUserIds : [];
      if (!fixture.validExcludedUserIds(excluded)) return pause();
      return { ...defaults, ...saved, excludedUserIds: [...new Set(excluded)].sort((a, b) => a - b) };
    } catch { return pause(); }
  }
  function validRule(rule) { return rule && typeof rule.from === 'string' && typeof rule.to === 'string' && rule.from.trim().length >= 2 && rule.from.length <= 120 && rule.to.trim().length > 0 && rule.to.length <= 80 && rule.from !== rule.to; }
  function icons() { window.lucide.createIcons(); }
  function toast(message, error = false) {
    const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message;
    $('toast-region').replaceChildren(node); setTimeout(() => node.remove(), 3500);
  }
  function highlight(text) {
    const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|^(?:event|data):/gm;
    let html = '', last = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0], next = text.slice(match.index + value.length);
      const kind = value.startsWith('"') ? (/^\s*:/.test(next) ? 'key' : 'string') : /^(true|false|null)$/.test(value) ? 'literal' : /^(event|data):$/.test(value) ? 'event' : 'number';
      html += escape(text.slice(last, match.index)) + `<span class="cl-code-${kind}">${escape(value)}</span>`; last = match.index + value.length;
    }
    return html + escape(text.slice(last));
  }
  function available() { return state.scenario === 'unconfigured' ? [] : [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); }
  function filtered() {
    const search = $('search').value.trim().toLowerCase(), platform = $('platform-filter').value, protocol = $('protocol-filter').value, capture = $('capture-filter').value;
    return available().filter(row => ($('date-filter').value !== 'today' || dateFormatter.format(new Date(row.at)).startsWith('2026-11-15')) &&
      (platform === 'all' || row.platform === platform) && (protocol === 'all' || row.protocol === protocol) &&
      (capture === 'all' || (capture === 'retry' ? row.attempts.length > 1 : row.capture === capture)) &&
      (!search || `${row.id} ${row.user.name} ${row.user.id} ${row.model} ${row.key} ${row.path}`.toLowerCase().includes(search)));
  }
  const selectedRow = () => available().find(row => row.id === state.selected);
  function activeAttempt(row = selectedRow()) { return row?.attempts[state.attempt ?? row.last]; }
  function storedCopy(row = selectedRow()) {
    const attempt = activeAttempt(row);
    if (!attempt) return null;
    if (!attempt[state.source]) state.source = attempt.masked ? 'masked' : attempt.original ? 'original' : state.source;
    return attempt[state.source];
  }
  function payload(side) {
    const row = selectedRow(), copy = storedCopy(row);
    if (!copy) return null;
    return { text: copy[side], side, id: row.id, protocol: row.protocol, source: state.source,
      extension: side === 'response' && row.protocol === 'SSE' ? 'sse' : 'json' };
  }
  function renderOverview() {
    const rows = state.view === 'requests' ? filtered() : available(), totalAttempts = rows.reduce((sum, row) => sum + row.attempts.length, 0);
    const complete = rows.filter(row => row.capture === 'complete').length, gaps = rows.length - complete;
    $('metrics').innerHTML = `<div class="cl-metric"><span>${icon('messages-square')}请求记录</span><strong>${formatNumber(rows.length)}</strong><small>${totalAttempts} 次上游尝试</small></div><div class="cl-metric green"><span>${icon('circle-check')}完整采集</span><strong>${formatNumber(complete)}</strong><small>${rows.length ? (complete / rows.length * 100).toFixed(1) : '0'}% 正文完整</small></div><div class="cl-metric amber"><span>${icon('scan-line')}存在缺口</span><strong>${formatNumber(gaps)}</strong><small>${rows.filter(row => row.capture === 'partial').length} 条不完整 · ${rows.filter(row => ['missing', 'redaction_failed'].includes(row.capture)).length} 条缺失</small></div>`;
    $('request-count').textContent = available().length;
    const interrupted = state.scenario === 'interrupted' || !policy.enabled;
    $('connection-state').innerHTML = `<span class="status-dot ${interrupted || state.scenario === 'unconfigured' ? 'bad' : 'ok'}"></span><span>${state.scenario === 'unconfigured' ? '模拟节点未接入' : interrupted ? '模拟采集已暂停' : '模拟采集正常'}</span>`;
    $('coverage-banner').hidden = state.scenario === 'normal' && policy.enabled;
    $('coverage-banner').innerHTML = icon('triangle-alert') + (state.scenario === 'unconfigured' ? '当前演示节点尚未接入，没有可展示的归档记录。' : !policy.enabled ? '对话日志保存已暂停。历史演示记录保留，新请求不生成归档。' : '模拟采集中断：15:26–15:29 存在未采集时段。已有归档仍可查看，该时段的完整覆盖未确认。');
    renderChart(rows);
  }
  function renderChart(rows) {
    if (!chart) chart = window.echarts.init($('trend'));
    const groups = Array.from({ length: 16 }, (_, hour) => rows.filter(row => Number(dateFormatter.format(new Date(row.at)).slice(11, 13)) === hour));
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    chart.setOption({ animation: false, grid: { top: 12, bottom: 17, left: 3, right: 8 },
      tooltip: { trigger: 'axis', confine: true }, xAxis: { type: 'category', boundaryGap: false, data: groups.map((_, i) => `${String(i).padStart(2, '0')}:00`),
        axisLine: { lineStyle: { color: dark ? '#43534a' : '#e4e8e3' } }, axisTick: { show: false }, axisLabel: { fontSize: 8, color: dark ? '#a0ada4' : '#859087', interval: 4 } },
      yAxis: { type: 'value', show: false, min: 0, minInterval: 1 }, series: [{ name: '完整采集', type: 'line', smooth: .22, symbol: 'none', data: groups.map(group => group.filter(row => row.capture === 'complete').length), lineStyle: { width: 1.7, color: '#32886e' }, areaStyle: { color: '#78bca3', opacity: .12 } },
        { name: '存在缺口', type: 'bar', barMaxWidth: 7, itemStyle: { color: '#c7a15c', borderRadius: 2 }, data: groups.map(group => group.filter(row => row.capture !== 'complete').length) }] }, true);
  }
  function renderRequests() {
    const rows = filtered(), pages = Math.max(1, Math.ceil(rows.length / state.pageSize)); state.page = Math.min(state.page, pages);
    if (!rows.some(row => row.id === state.selected)) { state.selected = rows[0]?.id || null; state.attempt = null; state.detailTab = 'payload'; }
    $('list-label').textContent = `${rows.length} 条请求 · 按最近时间排序`;
    $('request-list').innerHTML = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize).map(row => `<button class="cl-record" data-record="${row.id}" aria-current="${row.id === state.selected}"><span class="cl-record-top"><span class="cl-record-model"><span class="cl-platform ${row.platform.toLowerCase()}">${icon(row.platform === 'Anthropic' ? 'asterisk' : row.platform === 'Gemini' ? 'sparkles' : 'orbit')}</span><strong>${escape(row.model)}</strong></span><span class="cl-record-time">${time(row.at)}</span></span><span class="cl-record-bottom"><span class="cl-protocol">${escape(row.protocol)}</span><span>${escape(row.user.name)} · #${row.user.id}</span>${row.attempts.length > 1 ? `<span title="包含重试">${icon('repeat-2')}</span>` : ''}${badge(captureLabels[row.capture], captureColors[row.capture])}</span></button>`).join('') || `<div class="cl-empty">${icon('inbox')}<h3>${state.scenario === 'unconfigured' ? '尚未接入采集' : '没有符合条件的请求'}</h3><p>${state.scenario === 'unconfigured' ? '当前演示节点没有归档记录。' : '调整平台、协议或完整性筛选。'}</p><button class="button secondary" data-action="${state.scenario === 'unconfigured' ? 'collection' : 'reset'}">${state.scenario === 'unconfigured' ? '查看采集状态' : '重置筛选'}</button></div>`;
    $('page-label').textContent = rows.length ? `${(state.page - 1) * state.pageSize + 1}–${Math.min(state.page * state.pageSize, rows.length)} / ${rows.length}` : '0 条记录';
    $('prev-page').disabled = state.page <= 1; $('next-page').disabled = state.page >= pages; $('export-index').disabled = !rows.length;
    $('explorer').classList.toggle('detail-open', state.mobileDetail && !!state.selected); renderInspector();
  }
  function renderInspector() {
    const row = selectedRow(), version = ++renderVersion;
    if (!row) { $('inspector').innerHTML = `<div class="cl-empty">${icon('file-search')}<h3>等待归档记录</h3><p>这里将显示对应请求的 Request 与 Response。</p></div>`; icons(); return; }
    const attempt = activeAttempt(row), copy = storedCopy(row), attemptIndex = state.attempt ?? row.last;
    $('inspector').classList.toggle('cl-wrap', state.wrap);
    $('inspector').innerHTML = `<button class="cl-mobile-back" data-action="back">${icon('arrow-left')}返回请求列表</button><header class="cl-detail-heading"><div><div class="cl-detail-kicker">${escape(row.id)}<button data-copy-id="${row.id}" title="复制请求 ID" aria-label="复制请求 ID">${icon('copy')}</button></div><h2>${escape(row.summary)}</h2><p>${badge(captureLabels[row.capture], captureColors[row.capture])}<span>${escape(row.model)}</span><span>·</span><span class="cl-protocol">${escape(row.protocol)}</span>${row.attempts.length > 1 ? badge(`${row.attempts.length} 次尝试`, 'blue') : ''}</p></div><div class="cl-detail-tools"><button class="icon-button" data-action="metadata" title="归档信息" aria-label="归档信息">${icon('info')}</button><button class="icon-button" data-action="wrap" aria-pressed="${state.wrap}" title="${state.wrap ? '取消自动换行' : '自动换行'}" aria-label="切换正文自动换行">${icon('wrap-text')}</button></div></header>
      <dl class="cl-detail-facts"><div><dt>用户 / API Key</dt><dd>${escape(row.user.name)} <span>#${row.user.id} · ${escape(row.key)}</span></dd></div><div><dt>实际请求地址</dt><dd>${row.protocol === 'WebSocket' ? 'WSS' : 'POST'} ${escape(row.path)}</dd></div><div><dt>采集时间</dt><dd>${time(row.at)} <span>UTC+8</span></dd></div><div><dt>上游耗时</dt><dd>${attempt.duration.toFixed(2)} s <span>· ${attempt.status || '未确认'}</span></dd></div></dl>
      <div class="cl-attempts"><span class="cl-attempt-label">上游尝试</span>${row.attempts.map((item, index) => `<button class="cl-attempt" data-attempt="${index}" aria-pressed="${attemptIndex === index}"><b>${String(index + 1).padStart(2, '0')}</b>${escape(item.account)}<span class="cl-attempt-code ${item.status >= 400 ? 'error' : ''}">${item.status || '缺失'}</span></button>`).join('')}</div>
      <div class="cl-detail-tabs" role="tablist" aria-label="请求详情视图">${[['payload', '原始载荷'], ['timeline', row.protocol === 'WebSocket' ? '消息与尝试' : '尝试链'], ['redaction', '脱敏记录']].map(([key, label]) => `<button role="tab" data-detail="${key}" aria-selected="${state.detailTab === key}" tabindex="${state.detailTab === key ? '0' : '-1'}">${label}</button>`).join('')}<select id="copy-source" aria-label="正文版本"><option value="masked" ${state.source === 'masked' ? 'selected' : ''} ${!attempt.masked ? 'disabled' : ''}>脱敏副本</option><option value="original" ${state.source === 'original' ? 'selected' : ''} ${!attempt.original ? 'disabled' : ''}>原始样例</option></select></div>
      <div class="cl-body-section" id="detail-section"></div>`;
    if (state.detailTab === 'payload') {
      if (!copy) $('detail-section').innerHTML = `<div class="cl-notice ${row.capture === 'redaction_failed' ? 'red' : 'amber'}">${icon('triangle-alert')}${escape(attempt.reason)}</div><div class="cl-empty">${icon('file-x-2')}<h3>未保存正文</h3><p>仅保留本次采集的元数据，不能从用量记录还原原文。</p></div>`;
      else {
        $('detail-section').innerHTML = `${row.capture === 'partial' ? `<div class="cl-notice amber">${icon('triangle-alert')}已保留收到的原始片段，未观察到正常结束，不能视为完整 Response。</div>` : ''}<div class="cl-bodies">${['request', 'response'].map(side => `<section class="cl-body-pane" aria-label="${side === 'request' ? 'Request' : 'Response'} 原始正文"><div class="cl-body-heading"><strong>${side === 'request' ? 'Request' : 'Response'}</strong><span class="cl-raw-tag">${side === 'response' && row.protocol === 'SSE' ? 'SSE' : 'RAW'}</span><div><button class="icon-button" data-payload-action="copy" data-side="${side}" title="复制 ${side === 'request' ? 'Request' : 'Response'}" aria-label="复制 ${side === 'request' ? 'Request' : 'Response'}">${icon('copy')}</button><button class="icon-button" data-payload-action="download" data-side="${side}" title="下载原始正文" aria-label="下载 ${side === 'request' ? 'Request' : 'Response'}">${icon('download')}</button><button class="icon-button" data-payload-action="expand" data-side="${side}" title="展开完整正文" aria-label="展开 ${side === 'request' ? 'Request' : 'Response'}">${icon('maximize-2')}</button></div></div><pre class="cl-raw"><code id="${side}-raw">${highlight(copy[side])}</code></pre><div class="cl-body-footer"><span>${size(bytes(copy[side]))} · ${copy[side].split('\n').length} 行</span><span id="${side}-hash">SHA-256 …</span></div></section>`).join('')}</div><p class="cl-detail-footnote">${icon(state.source === 'masked' ? 'shield-check' : 'file-lock-2')}<span>${state.source === 'masked' ? '脱敏副本' : '原始样例（虚构信息）'} · 策略 v${row.policyVersion} · ${row.protocol === 'WebSocket' ? 'Request 为首条发送消息，Response 为最后一条接收消息；全部消息见“消息与尝试”。' : '正文保留原始字段及顺序，Raw 下载不重新序列化。'}</span></p>`;
        for (const side of ['request', 'response']) crypto.subtle.digest('SHA-256', encoder.encode(copy[side])).then(digest => {
          if (version !== renderVersion || !$(side + '-hash')) return;
          const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
          $(side + '-hash').textContent = `SHA-256 ${hash.slice(0, 12)}`; $(side + '-hash').title = hash;
        }).catch(() => { if (version === renderVersion && $(side + '-hash')) $(side + '-hash').textContent = '摘要不可用'; });
      }
    } else if (state.detailTab === 'timeline') renderTimeline(row, copy);
    else renderRedactions(row, attempt);
    icons();
  }
  function renderTimeline(row, copy) {
    const attempt = activeAttempt(row);
    $('detail-section').innerHTML = `<ol class="cl-events">${row.attempts.map((item, index) => `<li><span class="cl-event-mark ${item.status >= 400 ? 'red' : 'green'}">${icon(item.status >= 400 ? 'repeat-2' : 'check')}</span><div class="cl-event-text"><h3>尝试 ${index + 1} · ${escape(item.account)} ${badge(item.status ? `HTTP ${item.status}` : '状态未确认', item.status >= 400 ? 'red' : 'green')}</h3><p><code>${escape(item.host)}</code> · ${item.duration.toFixed(2)} s</p><p>${escape(item.reason || '已观察到完整上游响应')}</p><button class="cl-link" data-attempt-open="${index}">查看该次原始载荷 ${icon('arrow-up-right')}</button></div></li>`).join('')}</ol>${row.protocol === 'WebSocket' && copy?.frames.length ? `<div class="cl-section-heading"><h2>WebSocket 消息</h2><span class="cl-badge blue">${copy.frames.length} 条应用层消息</span></div>${copy.frames.map((frame, index) => `<button class="cl-frame" data-frame="${index}"><span>${String(index + 1).padStart(2, '0')}</span><span>${icon(frame.direction === 'out' ? 'arrow-up-right' : 'arrow-down-left')}${frame.direction === 'out' ? '发送' : '接收'}</span><code>${escape(frameType(frame.text))}</code><span>+${frame.at} ms</span></button>`).join('')}` : ''}`;
    if (!attempt.original && !attempt.masked) $('detail-section').insertAdjacentHTML('beforeend', `<p class="cl-field-note">正文缺失，无法展示对应消息。</p>`);
  }
  function frameType(text) { try { return JSON.parse(text).type || 'message'; } catch { return 'binary / unparsed'; } }
  function renderRedactions(row, attempt) {
    $('detail-section').innerHTML = `<div class="cl-notice">${icon('shield-check')}采集时策略 v${row.policyVersion} · ${escape(modeLabels[row.mode])}。历史记录不随当前策略变化。</div>${attempt.hits.length ? `<table class="cl-redaction-list"><thead><tr><th>位置</th><th>规则</th><th>占位符</th><th>命中</th></tr></thead><tbody>${attempt.hits.map(hit => `<tr><td>${hit.side}</td><td>${escape(hit.name)}</td><td><code>${escape(hit.replacement)}</code></td><td>${hit.count} 处</td></tr>`).join('')}</tbody></table><p class="cl-detail-footnote">${icon('link')}消息角色、顺序和 call_id 原样保留。</p>` : `<div class="cl-empty">${icon('shield')}<h3>${row.capture === 'redaction_failed' ? '正文脱敏校验失败' : row.mode === 'original' ? '此记录未生成脱敏副本' : '没有可展示的脱敏命中'}</h3><p>${row.capture === 'redaction_failed' ? '未回退保存未脱敏正文。' : '保存版本以采集时策略为准。'}</p></div>`}`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('浏览器未允许复制，可下载原始正文', true); }
  }
  function download(text, filename, type = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadPayload(value) { if (value) download(value.text, `${value.id}-${value.side}-${value.source}.${value.extension}`); }
  function showPayload(value, title) {
    if (!value) return;
    modalPayload = value; $('full-title').textContent = title || (value.side === 'request' ? 'Request' : 'Response');
    $('full-subtitle').textContent = `${value.id} · ${value.source === 'masked' ? '脱敏副本' : '原始样例'} · ${size(bytes(value.text))}`;
    $('full-code').innerHTML = highlight(value.text); $('payload-dialog').showModal(); icons();
  }
  function metadata() {
    const row = selectedRow(), attempt = activeAttempt(row);
    const facts = [['请求 ID', row.id], ['上游请求 ID', attempt.upstreamId], ['上游账号', `${attempt.account} / #${attempt.accountId}`], ['上游主机', attempt.host], ['用户 / Key', `${row.user.name} / #${row.user.id} / ${row.key}`], ['会话标识', row.session || '未提供可信会话标识'], ['采集时间', time(row.at, true)], ['采集完整性', captureLabels[row.capture]], ['保存版本', modeLabels[row.mode]], ['策略版本', `v${row.policyVersion}`], ['鉴权 Header', '不保存 Authorization、Cookie 或 API Key Header']];
    $('metadata-body').innerHTML = `<dl>${facts.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`; $('metadata-dialog').showModal();
  }

  function renderSessions() {
    const rows = available(), grouped = new Map();
    for (const row of rows) if (row.session) {
      if (!grouped.has(row.session)) grouped.set(row.session, []);
      grouped.get(row.session).push(row);
    }
    const sessions = [...grouped.entries()];
    if (!grouped.has(state.session)) state.session = sessions[0]?.[0];
    $('view-sessions').innerHTML = `<div class="cl-section-heading"><div><h2>会话归档</h2><span>${sessions.length} 个可信会话 · ${rows.filter(row => !row.session).length} 条独立请求未归入会话</span></div><span class="cl-badge blue">按会话标识关联</span></div>${sessions.length ? `<div class="cl-session-layout"><div class="cl-session-list" aria-label="会话列表">${sessions.map(([id, turns]) => `<button class="cl-session-button" data-session="${id}" aria-pressed="${state.session === id}"><strong>${escape(turns.at(-1).summary)}</strong><p>${turns.length} 轮 · ${escape(turns[0].user.name)} · ${time(turns[0].at)}<br><code>${escape(id)}</code></p></button>`).join('')}</div><div id="session-thread" class="cl-session-thread"></div></div>` : `<div class="cl-empty">${icon('messages-square')}<h3>暂无可关联会话</h3><p>缺少可信会话标识的请求保留为独立记录。</p></div>`}`;
    if (!sessions.length) return;
    const turns = grouped.get(state.session).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    $('session-thread').innerHTML = `<div class="cl-thread-title">${icon('link')}<code>${escape(state.session)}</code>${badge(`${turns.length} 轮`, 'green')}</div>${turns.map((row, index) => `<article class="cl-turn"><div class="cl-turn-heading"><span>第 ${index + 1} 轮 · ${time(row.at)} · ${escape(row.model)}</span><button class="cl-link" data-open-record="${row.id}">查看 Raw ${icon('arrow-up-right')}</button></div><div class="cl-message"><span>${icon('user-round')}</span><div><strong>${escape(row.user.name)}</strong><p>${escape(fixture.redact(row.summary + (index === 0 ? '，通知邮箱是 linyuan@example.com。' : ''), fixture.defaultPolicy).text)}</p></div></div><div class="cl-message assistant"><span>${icon('sparkles')}</span><div><strong>Assistant</strong><p>${escape(row.capture === 'complete' ? fixture.redact(row.answer, fixture.defaultPolicy).text : '此条响应存在采集缺口，无法展示完整内容。')}</p></div></div>${index === 0 && state.session === 'sess_order_01' ? `<p class="cl-detail-footnote">${icon('wrench')}lookup_order · call_order_01 · shipped</p>` : ''}</article>`).join('')}`;
  }
  function renderCollection() {
    const offline = state.scenario !== 'normal' || !policy.enabled, rows = available();
    const gaps = rows.filter(row => row.capture !== 'complete');
    const storedBytes = rows.reduce((sum, row) => sum + row.attempts.reduce((total, attempt) => total + [attempt.original, attempt.masked].filter(Boolean).reduce((count, copy) => count + bytes(copy.request) + bytes(copy.response) + copy.frames.reduce((frameBytes, frame) => frameBytes + bytes(frame.text), 0), 0), 0), 0);
    $('view-collection').innerHTML = `<div class="cl-section-heading"><div><h2>采集状态</h2><span>demo-gateway-01 · 演示节点 · 已排除 ${policy.excludedUserIds.length} 位用户</span></div><div class="cl-simulate-controls"><label>模拟请求用户<select id="simulate-user">${fixture.users.map(user => `<option value="${user.id}" ${state.simulationUser === user.id ? 'selected' : ''}>${escape(user.name)} · #${user.id}</option>`).join('')}</select></label><button class="button secondary" id="simulate-record" ${offline ? 'disabled' : ''}>${icon('circle-plus')}生成模拟记录</button></div></div><dl class="cl-collection-facts"><div><dt>节点状态</dt><dd>${state.scenario === 'unconfigured' ? '待接入' : offline ? '已暂停' : '模拟在线'}<small>2026-11-15 15:30:00</small></dd></div><div><dt>归档记录</dt><dd>${rows.length} 条<small>${rows.reduce((sum, row) => sum + row.attempts.length, 0)} 次独立尝试</small></dd></div><div><dt>正文缺口</dt><dd>${gaps.length} 条<small>不完整或未保存正文</small></dd></div><div><dt>当前策略</dt><dd>v${policy.version}<small>${escape(modeLabels[policy.mode])}</small></dd></div></dl>
      <div class="cl-collection-split"><section><h3>协议覆盖</h3>${[['HTTP · JSON', '非流式请求与完整返回体', '演示已覆盖', 'green'], ['HTTP · SSE', '逐事件保留，包括错误及结束事件', '演示已覆盖', 'green'], ['WebSocket', '双向应用层消息、顺序和时间', '演示已覆盖', 'green'], ['独立传输插件', '独立路径需另行接入采集', '待接入', 'amber']].map(([title, detail, status, color]) => `<div class="cl-coverage-row"><div>${title}<small>${detail}</small></div>${badge(status, color)}</div>`).join('')}</section><section><h3>存储与保留</h3><div class="cl-storage-line"><span>演示正文合计</span><strong>${size(storedBytes)}</strong></div><div class="cl-meter" aria-label="模拟归档使用量"><span style="width:${Math.max(2, Math.min(100, storedBytes / (policy.capacity * 1024 ** 3) * 100))}%"></span></div><div class="cl-storage-details"><div><span>配置上限</span><strong>${policy.capacity} GiB</strong></div><div><span>保留时间</span><strong>${policy.retention} 天</strong></div><div><span>最小可用空间</span><strong>${policy.reserve} GiB</strong></div><div><span>达到容量上限</span><strong>${policy.overflow === 'stop' ? '停止保存新正文' : '淘汰最早日志'}</strong></div></div><button class="cl-link" data-nav="policy">调整保存策略 ${icon('arrow-up-right')}</button></section></div>
      <div class="cl-section-heading"><h2>采集缺口</h2><span class="cl-badge amber">${gaps.length} 条</span></div><div class="table-wrap"><table class="cl-gap-table"><thead><tr><th>时间</th><th>请求 ID</th><th>状态</th><th>原因</th><th></th></tr></thead><tbody>${gaps.map(row => `<tr><td>${time(row.at)}</td><td><code>${row.id}</code></td><td>${badge(captureLabels[row.capture], captureColors[row.capture])}</td><td>${escape(row.attempts.at(-1).reason)}</td><td><button class="cl-link" data-open-record="${row.id}">查看</button></td></tr>`).join('') || '<tr><td colspan="5">暂无缺口记录</td></tr>'}</tbody></table></div>`;
  }
  function draftPolicy() {
    return { version: policy.version, enabled: $('policy-enabled').checked, mode: document.querySelector('[name=mode]:checked').value,
      email: $('rule-email').checked, phone: $('rule-phone').checked, secret: $('rule-secret').checked, ip: $('rule-ip').checked,
      retention: Number($('policy-retention').value), capacity: Number($('policy-capacity').value), reserve: Number($('policy-reserve').value),
      overflow: $('policy-overflow').value, custom: structuredClone(customRules), excludedUserIds: [...excludedUserIds].sort((a, b) => a - b) };
  }
  function fillPolicy(value) {
    $('policy-enabled').checked = value.enabled;
    document.querySelector(`[name=mode][value=${value.mode}]`).checked = true;
    for (const key of ['email', 'phone', 'secret', 'ip']) $('rule-' + key).checked = value[key];
    for (const key of ['retention', 'capacity', 'reserve', 'overflow']) $('policy-' + key).value = value[key];
    customRules = structuredClone(value.custom); excludedUserIds = new Set(value.excludedUserIds);
    renderExcludedUsers(); renderCustomRules(); renderPolicyPreview();
  }
  function renderExcludedSummary() {
    $('excluded-user-count').textContent = excludedUserIds.size ? `已选 ${excludedUserIds.size} 位用户` : '未排除用户';
    $('clear-excluded-users').disabled = !excludedUserIds.size;
  }
  function renderExcludedUsers() {
    const search = $('excluded-user-search').value.trim().toLowerCase().replace(/^#/, '');
    const users = [...fixture.users, ...[...excludedUserIds].filter(id => !fixture.users.some(user => user.id === id)).map(id => ({ id, name: '用户信息暂不可用' }))];
    const matches = users.filter(user => `${user.name} ${user.id}`.toLowerCase().includes(search));
    $('excluded-users').innerHTML = matches.map(user => `<label><input type="checkbox" data-exclude-user="${user.id}" ${excludedUserIds.has(user.id) ? 'checked' : ''}><span>${escape(user.name)}</span><code>#${user.id}</code></label>`).join('') || '<div class="cl-user-empty">没有匹配的用户</div>';
    renderExcludedSummary();
  }
  function renderCustomRules() {
    $('custom-rules').innerHTML = customRules.map((rule, index) => `<div class="cl-custom-rule"><code>${escape(rule.from)}</code>${icon('arrow-right')}<code>${escape(rule.to)}</code><button class="icon-button" type="button" data-remove-rule="${index}" title="删除规则" aria-label="删除规则 ${index + 1}">${icon('x')}</button></div>`).join(''); icons();
  }
  function renderPolicyPreview() {
    const draft = draftPolicy(), original = state.preview === 'request' ? fixture.request : fixture.response;
    const result = draft.mode === 'original' ? { text: original, hits: [] } : fixture.redact(original, draft);
    const dirty = JSON.stringify(draft) !== JSON.stringify(policy);
    $('policy-dirty').hidden = !dirty;
    $('policy-current').textContent = `当前 v${policy.version} · ${modeLabels[policy.mode]} · ${policy.retention} 天 · 排除 ${policy.excludedUserIds.length} 位用户`;
    $('mode-note').textContent = draft.mode === 'masked' ? '仅保留处理后的内容，之后无法从这份归档恢复被替换的原文。' : draft.mode === 'original' ? '保存完整原文，不生成用于日常查看的脱敏副本。' : '保留原文及独立脱敏副本，按记录查看对应版本。';
    $('preview-before').textContent = original;
    $('preview-after').innerHTML = highlight(result.text).replace(/(&lt;(?:EMAIL|PHONE|SECRET|IP|PROJECT)_\d+&gt;)/g, '<mark>$1</mark>');
    $('preview-hit-count').textContent = `${result.hits.reduce((sum, hit) => sum + hit.count, 0)} 处替换`;
    $('preview-version-label').textContent = draft.mode === 'original' ? '不脱敏' : '当前编辑中的规则';
    $('preview-assurance').textContent = draft.mode === 'original' ? '未改写原文；扩展字段、大整数及工具关联 ID 原样保留。' : '仅替换命中值；扩展字段、大整数及工具关联 ID 保留。';
    document.querySelectorAll('[data-preview]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preview === state.preview)));
  }
  function renderAll() {
    renderOverview(); renderRequests();
    if (state.view === 'sessions') renderSessions();
    if (state.view === 'collection') renderCollection();
    if (state.view === 'policy') renderPolicyPreview();
    icons();
  }
  function navigate(view) {
    if (!['requests', 'sessions', 'collection', 'policy'].includes(view)) return;
    state.view = view;
    document.querySelectorAll('[role=tabpanel]').forEach(section => { section.hidden = section.id !== 'view-' + view; });
    document.querySelectorAll('.cl-view-tabs [role=tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.nav === view)); button.tabIndex = button.dataset.nav === view ? 0 : -1;
    });
    renderAll();
    document.querySelector('.cl-view-tabs').scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  function resetFilters() {
    $('search').value = ''; for (const id of ['platform-filter', 'protocol-filter', 'capture-filter']) $(id).value = 'all';
    $('date-filter').value = 'today'; state.page = 1; state.mobileDetail = false; renderAll();
  }
  function openRecord(id) {
    resetFilters(); state.selected = id; state.attempt = null; state.detailTab = 'payload'; state.mobileDetail = true;
    const index = filtered().findIndex(row => row.id === id); state.page = index >= 0 ? Math.floor(index / state.pageSize) + 1 : 1;
    navigate('requests'); $('explorer').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function simulateRecord() {
    if (!policy.enabled || state.scenario !== 'normal') { toast('当前演示采集已暂停', true); return; }
    const row = fixture.makeRecord(nextSequence, policy, state.simulationUser);
    if (!row) { toast('当前用户不参与采集，本次未保存任何数据'); return; }
    nextSequence++; row.at = new Date(fixture.now + (nextSequence - 32) * 1000).toISOString(); row.session = null;
    row.summary = `新归档 · ${row.summary}`; records.push(row); openRecord(row.id); toast(`已生成模拟记录，使用策略 v${policy.version}`);
  }
  function exportIndex() {
    const cell = value => { const text = String(value ?? ''); return `"${(/^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`; };
    const rows = [['时间', '请求 ID', '用户 ID', '用户', '模型', '协议', '完整性', '尝试次数'], ...filtered().map(row => [time(row.at, true), row.id, row.user.id, row.user.name, row.model, row.protocol, captureLabels[row.capture], row.attempts.length])];
    download('\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'conversation-demo-index.csv', 'text/csv;charset=utf-8');
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    const data = button.dataset;
    if (data.nav) navigate(data.nav);
    if (data.record) {
      state.selected = data.record; state.attempt = null; state.detailTab = 'payload'; state.mobileDetail = true; renderRequests();
      if (matchMedia('(max-width: 760px)').matches) $('explorer').scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    if (data.detail) { state.detailTab = data.detail; renderInspector(); $('inspector').querySelector(`[data-detail="${data.detail}"]`)?.focus({ preventScroll: true }); }
    if (data.attempt != null || data.attemptOpen != null) { state.attempt = Number(data.attempt ?? data.attemptOpen); if (data.attemptOpen != null) state.detailTab = 'payload'; renderInspector(); }
    if (data.copyId) copyText(data.copyId);
    if (data.payloadAction) { const value = payload(data.side); if (data.payloadAction === 'copy') copyText(value?.text || ''); if (data.payloadAction === 'download') downloadPayload(value); if (data.payloadAction === 'expand') showPayload(value); }
    if (data.frame != null) { const row = selectedRow(), frame = storedCopy(row)?.frames[Number(data.frame)]; if (frame) showPayload({ text: frame.text, id: row.id, side: `message-${Number(data.frame) + 1}`, source: state.source, extension: 'json' }, `消息 ${Number(data.frame) + 1} · ${frame.direction === 'out' ? '发送' : '接收'}`); }
    if (data.action === 'back') {
      state.mobileDetail = false; renderRequests(); $('explorer').scrollIntoView({ block: 'start', behavior: 'instant' });
      document.querySelector(`[data-record="${state.selected}"]`)?.focus({ preventScroll: true });
    }
    if (data.action === 'metadata') metadata();
    if (data.action === 'wrap') { state.wrap = !state.wrap; renderInspector(); }
    if (data.action === 'reset') resetFilters();
    if (data.action === 'collection') navigate('collection');
    if (data.close) $(data.close).close();
    if (data.openRecord) openRecord(data.openRecord);
    if (data.session) { state.session = data.session; renderSessions(); icons(); }
    if (data.preview) { state.preview = data.preview; renderPolicyPreview(); }
    if (data.removeRule != null) { customRules.splice(Number(data.removeRule), 1); renderCustomRules(); renderPolicyPreview(); }
    if (button.id === 'simulate-record') simulateRecord();
  });
  document.addEventListener('keydown', event => {
    const button = event.target.closest('[role=tab]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const siblings = [...button.parentElement.querySelectorAll('[role=tab]')];
    const index = siblings.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? siblings.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + siblings.length) % siblings.length;
    siblings[next].click();
    const target = siblings[next].dataset.nav ? document.querySelector(`.cl-view-tabs [data-nav="${siblings[next].dataset.nav}"]`) : $('inspector').querySelector(`[data-detail="${siblings[next].dataset.detail}"]`);
    target?.focus({ preventScroll: true });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'copy-source') { state.source = event.target.value; renderInspector(); }
    if (event.target.id === 'simulate-user') state.simulationUser = Number(event.target.value);
  });
  $('search').addEventListener('input', () => { state.page = 1; renderAll(); });
  for (const id of ['platform-filter', 'protocol-filter', 'capture-filter', 'date-filter']) $(id).addEventListener('change', () => { state.page = 1; state.mobileDetail = false; renderAll(); });
  $('scenario').addEventListener('change', () => { state.scenario = $('scenario').value; state.mobileDetail = false; renderAll(); });
  $('reset-filters').addEventListener('click', resetFilters);
  $('prev-page').addEventListener('click', () => { state.page--; renderRequests(); });
  $('next-page').addEventListener('click', () => { state.page++; renderRequests(); });
  $('refresh').addEventListener('click', () => { renderAll(); toast('演示数据已刷新'); });
  $('export-index').addEventListener('click', exportIndex);
  $('full-copy').addEventListener('click', () => modalPayload && copyText(modalPayload.text));
  $('full-download').addEventListener('click', () => downloadPayload(modalPayload));
  $('payload-dialog').addEventListener('close', () => { modalPayload = null; $('full-code').textContent = ''; });
  $('excluded-user-search').addEventListener('input', renderExcludedUsers);
  $('clear-excluded-users').addEventListener('click', () => { excludedUserIds.clear(); renderExcludedUsers(); renderPolicyPreview(); });
  $('policy-form').addEventListener('input', event => {
    if (event.target.dataset.excludeUser) {
      const id = Number(event.target.dataset.excludeUser);
      if (event.target.checked) excludedUserIds.add(id); else excludedUserIds.delete(id);
      renderExcludedSummary();
    }
    renderPolicyPreview();
  });
  $('policy-form').addEventListener('change', renderPolicyPreview);
  $('add-rule').addEventListener('click', () => {
    const rule = { from: $('custom-from').value.trim(), to: $('custom-to').value.trim() };
    const candidate = { ...draftPolicy(), mode: 'dual', custom: [...customRules, rule] };
    const error = !validRule(rule) ? '匹配文本至少 2 个字符，替换值不能为空或与原文相同。' : customRules.length >= 10 ? '最多添加 10 条自定义规则。' : customRules.some(item => item.from === rule.from) ? '已存在相同匹配文本。' : !fixture.validSamplePolicy(candidate) ? '此规则会改变字段结构或工具关联，无法添加。' : '';
    $('custom-error').hidden = !error; $('custom-error').textContent = error; if (error) return;
    customRules.push(rule); $('custom-from').value = ''; $('custom-to').value = ''; renderCustomRules(); renderPolicyPreview();
  });
  $('restore-policy').addEventListener('click', () => { fillPolicy({ ...structuredClone(fixture.defaultPolicy), version: policy.version }); $('custom-error').hidden = true; $('policy-feedback').textContent = '默认值已载入，保存后生效'; });
  $('policy-form').addEventListener('submit', event => {
    event.preventDefault(); if (!$('policy-form').reportValidity()) return;
    const candidate = { ...draftPolicy(), version: policy.version + 1 };
    try { localStorage.setItem(storageKey, JSON.stringify(candidate)); policy = candidate; $('policy-feedback').textContent = `策略 v${policy.version} 已保存到本机`; renderPolicyPreview(); renderOverview(); icons(); toast('策略已保存，仅影响之后生成的模拟记录'); }
    catch { $('policy-feedback').textContent = '浏览器未允许本地保存，修改尚未生效'; toast('策略保存失败', true); }
  });
  fillPolicy(policy); renderAll();
  if (policyLoadIssue) $('policy-feedback').textContent = policyLoadIssue;
  document.querySelector('.module-tabs .active').scrollIntoView({ block: 'nearest', inline: 'nearest' });
  new ResizeObserver(() => chart?.resize()).observe($('trend'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderChart(state.view === 'requests' ? filtered() : available()); });
})();
