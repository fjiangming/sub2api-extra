'use strict';

(() => {
  const fixture = window.DomainDemoFixture;
  const $ = id => document.getElementById(id);
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const count = value => Number(value).toLocaleString('en-US');
  const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const time = (value, full = false) => value == null ? '未观测到' : (full ? dateFormatter.format(new Date(value)) : dateFormatter.format(new Date(value)).slice(5, 16));
  const dateKey = value => dateFormatter.format(new Date(value)).slice(0, 10);
  const storageKey = 'sub2api-domain-access-demo-v1';
  const notificationLabels = { pending: '待通知', drafted: '已生成草稿', notified: '已通知', ignored: '暂不通知' };
  const statusLabels = { still: '最近仍用旧域名', new: '近期仅见新域名', inactive: '近期无访问' };
  const associationLabels = { confirmed: '已确认用户', pending: '等待关联', ambiguous: '身份冲突', anonymous: '匿名访问' };
  const initial = () => ({
    drafts: [{ id: 'demo-draft-initial', recipients: [1005, 1010], domain: fixture.oldDomain, title: '接口域名迁移提醒', content: `你好，我们的接口域名已更新为 ${fixture.newDomain}。\n\n请将客户端中的 ${fixture.oldDomain} 更换为 ${fixture.newDomain}，保留原有的接口路径和 API Key。\n\n完成后请检查所有设备、脚本及自动化任务中的配置。感谢配合。`, createdAt: '2026-11-12T17:30:00+08:00', state: 'draft' }],
    notifications: { 1002: { status: 'notified', log: [{ status: 'notified', at: '2026-11-12T16:30:00+08:00' }] },
      1005: { status: 'drafted', log: [{ status: 'drafted', at: '2026-11-12T17:30:00+08:00' }] },
      1010: { status: 'drafted', log: [{ status: 'drafted', at: '2026-11-12T17:30:00+08:00' }] },
      1015: { status: 'notified', log: [{ status: 'notified', at: '2026-11-11T09:00:00+08:00' }] },
      1023: { status: 'ignored', log: [{ status: 'ignored', at: '2026-11-10T10:00:00+08:00' }] } },
    retention: 90, summaryRetention: 365
  });
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved || !Array.isArray(saved.drafts) || typeof saved.notifications !== 'object' || !saved.notifications) return initial();
      return { ...initial(), ...saved, drafts: saved.drafts.filter(draft => typeof draft.id === 'string' &&
        typeof draft.title === 'string' && typeof draft.content === 'string' && typeof draft.domain === 'string' &&
        Array.isArray(draft.recipients) && draft.recipients.length > 0 && draft.recipients.every(id => fixture.users.some(user => user.id === id))) };
    } catch { return initial(); }
  }
  let saved = load();
  const state = { tab: 'users', domain: fixture.oldDomain, start: '2026-11-07', end: '2026-11-13', scenario: 'normal',
    search: '', migration: 'all', notification: 'all', sort: 'latest', page: 1, pageSize: 10, selected: new Set(),
    requestSearch: '', association: 'all', requestPage: 1, detailUser: null, detailTab: 'overview', draftRecipients: [], editingDraft: null };
  let chart;
  let snapshot;
  let confirmation;
  let actionSequence = 0;
  function icons() { window.lucide.createIcons(); }
  function stamp() { return new Date(fixture.now + ++actionSequence * 1000).toISOString(); }
  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast'; node.textContent = message; $('toast-region').replaceChildren(node);
    setTimeout(() => node.remove(), 4200);
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); return true; }
    catch { toast('浏览器未允许本地保存，当前页面仍可预览'); return false; }
  }
  function notification(id) {
    const item = saved.notifications[id];
    return item && Object.hasOwn(notificationLabels, item.status) ? item.status : 'pending';
  }
  function setNotification(id, status) {
    const previous = saved.notifications[id];
    saved.notifications[id] = { status, log: [...(Array.isArray(previous?.log) ? previous.log : []), { status, at: stamp() }] };
  }
  const badge = (text, color = '', dot = false) => `<span class="da-badge ${color}">${dot ? '<b class="da-mini-dot"></b>' : ''}${escape(text)}</span>`;
  const statusBadge = row => badge(statusLabels[row.status], row.status === 'still' ? 'amber' : row.status === 'new' ? 'green' : '', true);
  const notificationBadge = id => badge(notificationLabels[notification(id)], { pending: '', drafted: 'blue', notified: 'green', ignored: '' }[notification(id)]);
  const associationBadge = event => badge(associationLabels[event.association], { confirmed: 'green', pending: 'blue', ambiguous: 'red', anonymous: '' }[event.association]);
  function buildSnapshot() {
    const cutoff = fixture.now - (state.scenario === 'interrupted' ? 45 * 60000 : 0);
    const available = state.scenario === 'unconfigured' ? [] : fixture.events.filter(event => event.at <= cutoff);
    const from = Date.parse(`${state.start}T00:00:00+08:00`);
    const until = Date.parse(`${state.end}T00:00:00+08:00`) + fixture.day;
    const period = available.filter(event => event.at >= from && event.at < until);
    const oldEvents = period.filter(event => event.domain === state.domain);
    const allOld = available.filter(event => event.domain === state.domain && event.association === 'confirmed');
    const users = fixture.users.filter(user => allOld.some(event => event.userId === user.id)).map(user => {
      const history = allOld.filter(event => event.userId === user.id);
      const old = oldEvents.filter(event => event.userId === user.id);
      const newer = period.filter(event => event.domain === fixture.newDomain && event.userId === user.id);
      return { ...user, history, old, newer, oldCount: old.length, newCount: newer.length,
        firstOld: history.at(-1).at, lastOld: history[0].at,
        lastNew: available.find(event => event.domain === fixture.newDomain && event.userId === user.id)?.at ?? null,
        status: old.length ? 'still' : newer.length ? 'new' : 'inactive' };
    });
    return { available, period, oldEvents, users, from, until, cutoff,
      unlinked: oldEvents.filter(event => event.association !== 'confirmed') };
  }
  function filteredUsers() {
    const search = state.search.trim().toLowerCase();
    return snapshot.users.filter(user => (!search || `${user.id} ${user.name} ${user.email} ${user.keys.map(key => `${key.id} ${key.name}`).join(' ')}`.toLowerCase().includes(search)) &&
      (state.migration === 'all' || user.status === state.migration) && (state.notification === 'all' || notification(user.id) === state.notification))
      .sort((a, b) => state.sort === 'count' ? b.oldCount - a.oldCount || b.lastOld - a.lastOld : state.sort === 'id' ? a.id - b.id : b.lastOld - a.lastOld || a.id - b.id);
  }
  function emptyRow(columns, title, subtitle, action = '') {
    return `<tr><td colspan="${columns}" class="da-empty">${icon(state.scenario === 'unconfigured' ? 'unplug' : 'search-x')}<strong>${escape(title)}</strong><p>${escape(subtitle)}</p>${action}</td></tr>`;
  }
  function pagination(target, total, page, size, kind) {
    const pages = Math.max(1, Math.ceil(total / size));
    const begin = total ? (page - 1) * size + 1 : 0;
    const end = Math.min(page * size, total);
    $(target).innerHTML = `<span>${count(total)} 条记录 · 显示 ${begin}–${end}</span><div>${kind === 'users' ? `<select id="page-size" aria-label="每页用户数"><option value="10" ${size === 10 ? 'selected' : ''}>10 条 / 页</option><option value="20" ${size === 20 ? 'selected' : ''}>20 条 / 页</option></select>` : ''}<button class="icon-button" data-page="${kind}" data-direction="-1" ${page <= 1 ? 'disabled' : ''} title="上一页" aria-label="上一页">${icon('chevron-left')}</button><span>${page} / ${pages}</span><button class="icon-button" data-page="${kind}" data-direction="1" ${page >= pages ? 'disabled' : ''} title="下一页" aria-label="下一页">${icon('chevron-right')}</button></div>`;
  }
  function renderSelection(visible) {
    $('selection-label').textContent = `已选择 ${state.selected.size} 位用户`;
    $('create-draft').disabled = !state.selected.size;
    const selected = visible.filter(user => state.selected.has(user.id)).length;
    $('select-all').checked = visible.length > 0 && selected === visible.length;
    $('select-all').indeterminate = selected > 0 && selected < visible.length;
    $('select-all').disabled = !visible.length;
  }
  function renderUsers() {
    const users = filteredUsers();
    state.page = Math.min(state.page, Math.max(1, Math.ceil(users.length / state.pageSize)));
    const visible = users.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    $('user-rows').innerHTML = visible.map(user => `<tr data-user-row="${user.id}">
      <td class="da-check-cell"><input type="checkbox" data-select="${user.id}" aria-label="选择 ${escape(user.name)}" ${state.selected.has(user.id) ? 'checked' : ''}></td>
      <td><button class="da-link da-user-link" data-user="${user.id}"><span class="da-avatar" aria-hidden="true">${escape(user.name.slice(0, 1))}</span><span class="da-user-text"><span>${escape(user.name)} <span class="muted">#${user.id}</span></span><small>${escape(user.email)}</small><span class="da-mobile-info"><span>${statusBadge(user)}${notificationBadge(user.id)}</span><small>旧域名 ${count(user.oldCount)} 次 · 新域名 ${count(user.newCount)} 次</small></span></span></button></td>
      <td><strong>${escape(user.keys[0].name)}</strong><small>Key #${user.keys[0].id}${user.keys.length > 1 ? ` · 共 ${user.keys.length} 个` : ''}</small></td>
      <td>${statusBadge(user)}<small>${user.status === 'still' && user.newCount ? '同时有新域名请求' : user.status === 'new' ? '所选时段未见旧域名请求' : user.status === 'inactive' ? '所选时段未见新旧域名请求' : '所选时段内有请求'}</small></td>
      <td class="numeric"><strong>${count(user.oldCount)}</strong><small>新域名 ${count(user.newCount)}</small></td>
      <td>${time(user.lastOld)}<small>首次 ${time(user.firstOld)}</small></td><td>${notificationBadge(user.id)}</td>
      <td><button class="table-icon-button" data-user="${user.id}" title="查看 ${escape(user.name)} 的访问详情" aria-label="查看 ${escape(user.name)} 的访问详情">${icon('chevron-right')}</button></td></tr>`).join('') || emptyRow(8,
        state.scenario === 'unconfigured' ? '尚未接入域名日志' : '没有符合条件的用户',
        state.scenario === 'unconfigured' ? '当前没有可以确认的访问身份。' : '调整搜索内容或使用状态后重试。',
        state.scenario === 'unconfigured' ? '<button class="button secondary" data-go="collection">查看采集状态</button>' : '<button class="button secondary" id="empty-reset">重置筛选</button>');
    pagination('user-pagination', users.length, state.page, state.pageSize, 'users');
    $('export-users').disabled = !users.length;
    renderSelection(visible);
  }
  function renderMetrics() {
    const missing = state.scenario === 'unconfigured';
    const metrics = [
      ['累计确认用户', snapshot.users.length, '采集以来使用过关注域名', ''],
      ['仍用旧域名', snapshot.users.filter(user => user.status === 'still').length, '所选时段 · 去重用户', 'amber'],
      ['旧域名请求', snapshot.oldEvents.length, '所选时段 · 含未关联访问', ''],
      ['未关联访问', snapshot.unlinked.length, '查看未关联明细', 'blue']
    ];
    $('metrics').innerHTML = metrics.map(([label, value, foot, color], index) => `<div class="da-metric ${color}"><span>${label}</span><strong>${missing ? '—' : count(value)}</strong>${index === 3 && !missing ? `<button id="show-unlinked">${foot}${icon('arrow-up-right')}</button>` : `<small>${missing ? '等待采集数据' : foot}</small>`}</div>`).join('');
    $('users-count').textContent = snapshot.users.length;
    $('collection-label').textContent = { normal: '模拟采集正常', interrupted: '模拟采集中断', unconfigured: '模拟采集未配置' }[state.scenario];
    $('collection-dot').className = `status-dot ${state.scenario === 'normal' ? 'ok' : 'bad'}`;
    $('coverage-alert').hidden = state.scenario === 'normal';
    $('coverage-alert').className = `alert ${state.scenario === 'interrupted' ? 'warning' : 'info'}`;
    $('coverage-alert').innerHTML = state.scenario === 'interrupted' ? `${icon('circle-alert')}<span>采集中断 · 11-13 14:15 之后的新访问尚未入库，当前统计覆盖不完整。</span>` : `${icon('info')}<span>尚未配置采集源 · 新访问暂未记录，历史线索仍可查看。</span>`;
  }
  function renderChart() {
    const missing = state.scenario === 'unconfigured';
    $('trend').hidden = missing; $('trend-empty').hidden = !missing;
    $('trend-range').textContent = `${state.start.slice(5)} 至 ${state.end.slice(5)}`;
    if (missing) { chart?.clear(); return; }
    chart ||= echarts.init($('trend'), null, { renderer: 'canvas' });
    const days = [];
    for (let at = snapshot.from; at < snapshot.until; at += fixture.day) days.push(dateKey(at));
    const old = new Map(days.map(key => [key, 0])), newer = new Map(old);
    for (const event of snapshot.period) {
      const key = dateKey(event.at);
      if (event.domain === state.domain) old.set(key, old.get(key) + 1);
      if (event.domain === fixture.newDomain) newer.set(key, newer.get(key) + 1);
    }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    chart.setOption({ animation: false, aria: { enabled: true }, grid: { left: 36, right: 12, top: 16, bottom: 27 },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: dark ? '#242c26' : '#fff', borderColor: dark ? '#4b5a50' : '#dfe2dc', textStyle: { color: dark ? '#e1e9e3' : '#1e2420', fontSize: 11 } },
      xAxis: { type: 'category', data: days.map(key => key.slice(5)), boundaryGap: false, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: dark ? '#9ba99e' : '#7a837d', fontSize: 10, margin: 12, hideOverlap: true } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: dark ? '#9ba99e' : '#7a837d', fontSize: 10 }, splitLine: { lineStyle: { color: dark ? '#343f37' : '#e5e9e3', type: 'dashed' } } },
      series: [{ name: state.domain, data: [...old.values()], type: 'line', showSymbol: days.length <= 7, symbolSize: 4, itemStyle: { color: dark ? '#dfb36c' : '#bc8536' }, lineStyle: { width: 2 } },
        { name: fixture.newDomain, data: [...newer.values()], type: 'line', showSymbol: days.length <= 7, symbolSize: 4, itemStyle: { color: dark ? '#7ac4a2' : '#268469' }, lineStyle: { width: 2 } }] }, true);
    chart.resize();
  }
  function renderRequests() {
    const search = state.requestSearch.trim().toLowerCase();
    const events = snapshot.oldEvents.filter(event => (state.association === 'all' || state.association === 'unlinked' && event.association !== 'confirmed' || event.association === state.association) &&
      (!search || `${event.id} ${event.path} ${event.userId || ''} ${fixture.users.find(user => user.id === event.userId)?.name || ''}`.toLowerCase().includes(search)));
    state.requestPage = Math.min(state.requestPage, Math.max(1, Math.ceil(events.length / 15)));
    $('request-count').textContent = `${count(events.length)} 次入口请求`;
    $('request-rows').innerHTML = events.slice((state.requestPage - 1) * 15, state.requestPage * 15).map(event => {
      const user = fixture.users.find(item => item.id === event.userId);
      return `<tr><td>${time(event.at)}<small class="da-code">${escape(event.id)}</small></td><td><strong>${escape(event.domain)}</strong><small>${escape(event.path)}</small></td>
        <td>${user ? `<button class="da-link" data-user="${user.id}">${escape(user.name)} #${user.id}</button><small>Key #${event.keyId}</small>` : '<span class="muted">未确认</span><small>不分配注册用户</small>'}</td>
        <td>${badge(`HTTP ${event.status}`, event.status >= 400 ? 'red' : '')}<small>${escape(event.flow)}</small></td><td>${associationBadge(event)}</td><td><button class="table-icon-button" data-request="${event.id}" title="查看关联证据" aria-label="查看关联证据">${icon('chevron-right')}</button></td></tr>`;
    }).join('') || emptyRow(6, state.scenario === 'unconfigured' ? '尚无采集记录' : '没有符合条件的访问', '调整日期、关联状态或搜索内容后重试。');
    pagination('request-pagination', events.length, state.requestPage, 15, 'requests');
  }
  function renderHistory() {
    $('view-history').innerHTML = `<div class="da-info-strip"><div>${icon('file-clock')}<strong>采集前的历史线索</strong>${badge('5 条模拟样例', 'blue')}</div><p>时间范围 10-10 至 10-14 · 与上方新采集统计分别展示</p></div>
      <p class="da-footnote">来源页面不等于访问域名；未知身份不进入用户通知名单。</p>
      <div class="table-wrap da-main-table da-history-table"><table><thead><tr><th>记录时间 / 来源</th><th>线索</th><th>身份</th><th>证据状态</th><th></th></tr></thead><tbody>${fixture.history.map(item => `<tr><td>${escape(item.at)}<small>${escape(item.source)}</small></td><td>${escape(item.evidence)}<small>${escape(item.path)}</small></td><td>${escape(item.owner || '未关联用户')}<small>${item.owner ? '仅为管理员历史订单' : '没有可靠身份关联'}</small></td><td>${badge(item.state, item.owner ? '' : 'amber')}</td><td><button class="table-icon-button" data-history="${item.id}" title="查看历史证据" aria-label="查看历史证据">${icon('chevron-right')}</button></td></tr>`).join('')}</tbody></table></div>
      <details class="da-definitions"><summary>历史记录的确认范围</summary><p>带 Host 的错误记录可以证明域名，但不能据此认领用户。Referer 只表示来源页面。共享 IP、相近时间或同一日志文件都不作为确认用户的依据。已删除或未曾记录的字段无法补回。</p></details>`;
  }
  function renderCollection() {
    const normal = state.scenario === 'normal', empty = state.scenario === 'unconfigured';
    const labels = { normal: '正常采集', interrupted: '采集中断', unconfigured: '尚未配置' };
    const confirmed = snapshot.oldEvents.length - snapshot.unlinked.length;
    $('view-collection').innerHTML = `<div class="da-collection-heading"><h2>${icon('radio-tower')}入口采集${badge(labels[state.scenario], normal ? 'green' : 'amber', true)}</h2>${!normal ? '<button class="button secondary compact" id="restore-collection">切换为正常采集场景</button>' : badge('模拟数据源', 'blue')}</div>
      <dl class="da-facts"><div><dt>关注域名</dt><dd>${escape(state.domain)}</dd></div><div><dt>采集开始</dt><dd>${empty ? '尚未开始' : fixture.collectionStart}</dd></div><div><dt>最近入库</dt><dd>${empty ? '未接入' : normal ? '2026-11-13 14:59:42' : '2026-11-13 14:15:00'}</dd></div><div><dt>入口请求</dt><dd>${count(snapshot.oldEvents.length)} 次</dd></div><div><dt>已关联身份</dt><dd>${count(confirmed)} 次${snapshot.oldEvents.length ? ` · ${(confirmed / snapshot.oldEvents.length * 100).toFixed(1)}%` : ''}</dd></div><div><dt>未关联身份</dt><dd>${count(snapshot.unlinked.length)} 次</dd></div></dl>
      <div class="da-section-heading"><div><h2>最近 14 天采集覆盖</h2></div><div class="da-legend"><span><b class="da-new-dot"></b>有记录</span><span><b class="da-old-dot"></b>覆盖缺口</span></div></div>
      <div class="da-coverage-bars" role="img" aria-label="${empty ? '尚未配置采集' : normal ? '最近14天有模拟记录' : '最后一天存在采集缺口'}">${Array.from({ length: 14 }, (_, i) => `<span class="${empty ? 'empty' : !normal && i === 13 ? 'gap' : ''}" title="${i + 1} / 14 · ${empty ? '无记录' : !normal && i === 13 ? '部分覆盖' : '有记录'}"></span>`).join('')}</div><div class="da-coverage-axis"><span>10-31</span><span>11-13</span></div>
      <form id="collection-settings" class="da-settings"><label>请求明细保留 / 天<input id="retention" type="number" min="30" max="365" step="1" required value="${Number(saved.retention) || 90}"></label><label>每日汇总保留 / 天<input id="summary-retention" type="number" min="90" max="1095" step="1" required value="${Number(saved.summaryRetention) || 365}"></label><button type="submit" class="button secondary">${icon('save')}保存模拟设置</button><button type="button" id="reset-demo" class="button secondary da-reset">${icon('rotate-ccw')}重置演示数据</button></form>
      <details class="da-definitions"><summary>数据范围与关联口径</summary><p>入口访问按单个 HTTP 请求去重，上游重试不重复增加访问次数。身份只在主站记录能唯一证明所属账号时确认。等待关联、身份冲突与匿名访问分别展示，不按 IP 猜测。</p><p>API Key 共享时显示 Key 所属账号。HTTP 200 仅是响应状态，流式请求需要单独的结束证据。首页、静态资源和未登录访问不保证具备用户身份。</p><p>模拟采集范围：2026-10-15 至 2026-11-13。当前演示只保留虚构元数据，没有主站连接、真实用户信息、明文 Key 或请求正文。</p></details>`;
  }
  function renderDrafts() {
    $('drafts-count').hidden = !saved.drafts.length;
    $('drafts-count').textContent = saved.drafts.length;
    $('view-drafts').innerHTML = `<div class="da-info-strip"><div>${icon('file-pen-line')}<strong>迁移通知草稿</strong>${badge('仅本机演示', 'blue')}</div><p>共 ${saved.drafts.length} 条 · 不发送消息</p></div>
      <div class="table-wrap da-main-table"><table><thead><tr><th>标题 / 域名</th><th>收件人</th><th>保存时间</th><th>处理状态</th><th>操作</th></tr></thead><tbody>${saved.drafts.map(draft => `<tr><td class="da-title-cell"><button class="da-link" data-edit-draft="${escape(draft.id)}">${escape(draft.title)}</button><small>${escape(draft.domain)}</small></td><td>${escape(draft.recipients.map(id => fixture.users.find(user => user.id === id).name).slice(0, 3).join('、'))}${draft.recipients.length > 3 ? '等' : ''}<small>${draft.recipients.length} 位已确认用户</small></td><td>${time(draft.createdAt)}</td><td>${badge(draft.state === 'handled' ? '已标记通知' : '草稿 · 未发送', draft.state === 'handled' ? 'green' : 'blue')}</td><td><div class="da-draft-actions"><button class="table-icon-button" data-edit-draft="${escape(draft.id)}" title="编辑草稿" aria-label="编辑草稿">${icon('pencil')}</button><button class="table-icon-button" data-mark-draft="${escape(draft.id)}" title="标记已通知" aria-label="标记已通知" ${draft.state === 'handled' ? 'disabled' : ''}>${icon('check-check')}</button><button class="table-icon-button danger-text" data-delete-draft="${escape(draft.id)}" title="删除草稿" aria-label="删除草稿">${icon('trash-2')}</button></div></td></tr>`).join('') || emptyRow(5, '还没有通知草稿', '从已确认的用户中选择收件人。', '<button class="button secondary" data-go="users">返回用户列表</button>')}</tbody></table></div>`;
  }
  function render() {
    snapshot = buildSnapshot(); renderMetrics(); renderUsers(); renderRequests(); renderHistory(); renderCollection(); renderDrafts(); renderChart(); icons();
  }
  function setTab(tab, focus = false) {
    if (!['users', 'requests', 'history', 'collection', 'drafts'].includes(tab)) return;
    state.tab = tab;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $(`view-${button.dataset.tab}`).hidden = !active;
    }
    for (const button of document.querySelectorAll('[data-main]')) {
      const active = button.dataset.main === tab || button.dataset.main === 'users' && ['requests', 'history'].includes(tab);
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    const selected = $(`tab-${tab}`);
    selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) selected.focus();
  }
  function openDialog(id) { if (!$(id).open) $(id).showModal(); }
  function confirm(title, body, action, label = '确认') {
    $('confirm-title').textContent = title; $('confirm-body').textContent = body;
    $('confirm-action').textContent = label; confirmation = action; openDialog('confirm-dialog');
  }
  function openUser(id, tab = 'overview') {
    const user = snapshot.users.find(item => item.id === id);
    if (!user) return;
    state.detailUser = id; state.detailTab = tab;
    $('detail-heading').innerHTML = `<span class="da-eyebrow">已确认用户 · #${id}</span><h2>${escape(user.name)} ${statusBadge(user)}</h2><p>${escape(user.email)}</p>`;
    let body = `<div class="da-detail-tabs" role="tablist" aria-label="用户详情视图">${[['overview', '访问概览'], ['evidence', '身份依据'], ['notifications', '通知记录']].map(([key, label]) => `<button role="tab" data-detail-tab="${key}" aria-selected="${key === tab}" tabindex="${key === tab ? '0' : '-1'}">${label}</button>`).join('')}</div>`;
    if (tab === 'overview') {
      body += `<div class="da-detail-stats"><div><small>旧域名请求</small><strong>${count(user.oldCount)}</strong></div><div><small>新域名请求</small><strong>${count(user.newCount)}</strong></div><div><small>使用的 Key</small><strong>${user.keys.length}</strong></div></div>
        <dl class="da-facts"><div><dt>首次观测旧域名</dt><dd>${time(user.firstOld, true)}</dd></div><div><dt>最近旧域名访问</dt><dd>${time(user.lastOld, true)}</dd></div><div><dt>最近新域名访问</dt><dd>${time(user.lastNew, true)}</dd></div></dl>
        <h3>使用的 API Key</h3><div class="da-small-table"><table><thead><tr><th>名称 / ID</th><th class="numeric">旧域名请求</th><th class="numeric">新域名请求</th></tr></thead><tbody>${user.keys.map(key => `<tr><td>${escape(key.name)}<small>Key #${key.id}</small></td><td class="numeric">${count(user.old.filter(event => event.keyId === key.id).length)}</td><td class="numeric">${count(user.newer.filter(event => event.keyId === key.id).length)}</td></tr>`).join('')}</tbody></table></div>
        <h3>最近旧域名请求</h3><div class="da-small-table"><table><thead><tr><th>访问时间</th><th>路径</th><th></th></tr></thead><tbody>${user.history.slice(0, 5).map(event => `<tr><td>${time(event.at)}</td><td>${escape(event.path)}</td><td><button class="table-icon-button" data-request="${event.id}" data-back-user="${id}" title="查看请求证据" aria-label="查看请求证据">${icon('chevron-right')}</button></td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'evidence') {
      const event = user.history[0];
      body += `<p>${badge('唯一身份关联', 'green')} ${badge('模拟证据', 'blue')}</p><ol class="da-evidence"><li><strong>入口域名已记录</strong><p>${escape(event.domain)} · ${time(event.at, true)}</p><code>${escape(event.id)}</code></li><li><strong>主站请求身份一致</strong><p>请求关联号唯一对应用户 #${id}、Key #${event.keyId}。</p><code>原生请求快照 / 已验证身份</code></li><li><strong>确认账号归属</strong><p>${escape(user.name)} · ${escape(user.email)}</p><p>上游尝试 ${event.attempts} 次，入口访问计为 1 次。</p></li></ol><p class="da-footnote">确认的是 API Key 所属账号；不推断共享 Key 后面的实际个人。</p>`;
    } else {
      const log = Array.isArray(saved.notifications[id]?.log) ? saved.notifications[id].log : [];
      body += `<p>当前状态 ${notificationBadge(id)}</p>${log.length ? `<div class="da-notice-log">${[...log].reverse().map(item => `<strong>${escape(notificationLabels[item.status] || '状态更新')}</strong><p>${time(item.at, true)} · 模拟操作</p>`).join('')}</div>` : '<div class="da-empty"><strong>暂无通知记录</strong><p>尚未为该用户生成通知草稿。</p></div>'}`;
    }
    body += `<div class="da-detail-actions"><button class="button primary" data-draft-user="${id}">${icon('mail-plus')}生成通知草稿</button><button class="button secondary" data-notify-user="${id}">${icon('check-check')}标记已通知</button><button class="button secondary" data-ignore-user="${id}">${icon('bell-off')}暂不通知</button></div>`;
    $('detail-body').innerHTML = body; icons(); openDialog('detail-dialog');
  }
  function openRequest(id, backUser) {
    const event = fixture.events.find(item => item.id === id);
    if (!event) return;
    const user = fixture.users.find(item => item.id === event.userId);
    const reasons = { pending: '主站身份记录尚未到齐，当前不认领用户。', ambiguous: '关联号存在多个身份候选，当前无法唯一确认。', anonymous: '请求没有通过有效身份验证，不分配注册用户。' };
    $('detail-heading').innerHTML = `<span class="da-eyebrow">${backUser ? `<button class="da-link" data-user="${backUser}">${icon('arrow-left')}返回用户详情</button>` : '入口请求 · 模拟证据'}</span><h2>请求关联证据</h2><p class="da-code">${escape(event.id)}</p>`;
    $('detail-body').innerHTML = `<p style="margin-top:20px">${associationBadge(event)} ${badge(`HTTP ${event.status}`, event.status >= 400 ? 'red' : '')}</p>
      <dl class="da-facts"><div><dt>访问时间</dt><dd>${time(event.at, true)}</dd></div><div><dt>实际入口域名</dt><dd>${escape(event.domain)}</dd></div><div><dt>用户 / Key</dt><dd>${user ? `${escape(user.name)} #${user.id}<br>Key #${event.keyId}` : '未确认'}</dd></div><div><dt>请求路径</dt><dd>${escape(event.method)} ${escape(event.path)}</dd></div><div><dt>流式结束状态</dt><dd>${escape(event.flow)}</dd></div><div><dt>上游尝试 / 入口计数</dt><dd>${event.attempts} 次 / 1 次</dd></div><div><dt>来源 IP（示例地址）</dt><dd>${escape(event.ip)}</dd></div><div><dt>客户端</dt><dd>${escape(event.agent)}</dd></div></dl>
      ${user ? `<h3>身份关联链</h3><ol class="da-evidence"><li><strong>入口日志记录域名及关联号</strong><p>${escape(event.domain)}</p><code>${escape(event.id)}</code></li><li><strong>主站记录匹配同一次请求</strong><p>请求快照中的用户 #${user.id}、Key #${event.keyId} 归属一致。</p></li><li><strong>用户已确认</strong><p>${escape(user.email)}</p></li></ol>` : `<div class="alert warning">${icon('circle-alert')}<span>${escape(reasons[event.association])}</span></div><ol class="da-evidence unknown"><li><strong>入口域名已知</strong><p>${escape(event.domain)}</p></li><li><strong>身份未确认</strong><p>${escape(reasons[event.association])}</p></li></ol>`}
      <details class="da-definitions"><summary>判定口径</summary><p>HTTP 状态与身份关联分别记录。HTTP 200 不能单独证明流式生成成功。没有可靠请求关联号时，不按 IP、相近时间或相同路径认领用户。</p></details>`;
    icons(); openDialog('detail-dialog');
  }
  function openHistory(id) {
    const item = fixture.history.find(row => row.id === id);
    if (!item) return;
    $('detail-heading').innerHTML = '<span class="da-eyebrow">采集前 · 模拟历史样例</span><h2>历史线索</h2>';
    $('detail-body').innerHTML = `<dl class="da-facts"><div><dt>时间</dt><dd>${escape(item.at)}</dd></div><div><dt>来源</dt><dd>${escape(item.source)}</dd></div><div><dt>证据类型</dt><dd>${escape(item.evidence)}</dd></div><div><dt>相关域名</dt><dd>${escape(item.domain)}</dd></div><div><dt>路径</dt><dd>${escape(item.path)}</dd></div><div><dt>身份</dt><dd>${escape(item.owner || '未关联用户')}</dd></div></dl><div class="alert info">${icon('info')}<span>${escape(item.reason)}</span></div><p class="da-footnote">该线索不加入普通用户通知名单。</p>`;
    icons(); openDialog('detail-dialog');
  }
  function editorMode(mode) {
    $('draft-content').hidden = mode !== 'edit'; $('draft-preview').hidden = mode !== 'preview';
    $('draft-preview').textContent = $('draft-content').value;
    for (const button of document.querySelectorAll('[data-editor]')) button.setAttribute('aria-pressed', String(button.dataset.editor === mode));
  }
  function openDraft(ids, draftId) {
    const draft = draftId ? saved.drafts.find(item => item.id === draftId) : null;
    state.draftRecipients = draft ? [...draft.recipients] : [...new Set(ids)].filter(id => snapshot.users.some(user => user.id === id));
    if (!state.draftRecipients.length) return;
    state.editingDraft = draft?.id || null;
    $('detail-dialog').close();
    $('draft-recipients').innerHTML = `收件人 ${state.draftRecipients.map(id => `<span>${escape(fixture.users.find(user => user.id === id).name)} #${id}</span>`).join('')}`;
    $('draft-title').value = draft?.title || '接口域名迁移提醒';
    $('draft-content').value = draft?.content || `你好，\n\n我们在所选观察期内记录到你的账号使用过 ${state.domain}。\n\n请将客户端中的接口域名更换为 ${fixture.newDomain}，保留原有路径（如 /v1）和 API Key。请同时检查其他设备、脚本及自动化任务的配置。\n\n如已完成更换，请忽略本条提醒。感谢配合。`;
    editorMode('edit'); icons(); openDialog('draft-dialog');
  }
  function resetFilters() {
    state.search = ''; state.migration = 'all'; state.notification = 'all'; state.sort = 'latest'; state.page = 1; state.selected.clear();
    $('user-search').value = ''; $('migration-filter').value = 'all'; $('notification-filter').value = 'all'; $('sort').value = 'latest';
    renderUsers(); icons();
  }
  function applyScope() {
    const start = $('start').value, end = $('end').value;
    if (!start || !end || start > end || start < '2026-10-15' || end > '2026-11-13') {
      $('date-error').textContent = '请选择 2026-10-15 至 2026-11-13 范围内的有效起止日期。'; $('date-error').hidden = false; return;
    }
    $('date-error').hidden = true; state.start = start; state.end = end; state.page = 1; state.requestPage = 1; state.selected.clear();
    for (const button of document.querySelectorAll('[data-preset]')) {
      const expected = dateKey(fixture.today - (Number(button.dataset.preset) - 1) * fixture.day);
      button.setAttribute('aria-pressed', String(start === expected && end === '2026-11-13'));
    }
    render();
  }
  function exportUsers() {
    const rows = filteredUsers();
    const cells = value => {
      const text = String(value ?? '');
      return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
    };
    const csv = [['演示数据', '用户ID', '用户名', '邮箱', '关注域名', '旧域名请求', '新域名请求', '使用状态', '最后旧域名访问', '通知状态'],
      ...rows.map(user => ['模拟', user.id, user.name, user.email, state.domain, user.oldCount, user.newCount, statusLabels[user.status], time(user.lastOld, true), notificationLabels[notification(user.id)]])].map(row => row.map(cells).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'domain-access-demo-users.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${rows.length} 位模拟用户`);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const data = button.dataset;
    if (data.tab) setTab(data.tab);
    else if (data.main || data.go) setTab(data.main || data.go);
    else if (data.close) $(data.close).close();
    else if (data.preset) { $('start').value = dateKey(fixture.today - (Number(data.preset) - 1) * fixture.day); $('end').value = '2026-11-13'; applyScope(); }
    else if (data.page) { if (data.page === 'users') state.page += Number(data.direction); else state.requestPage += Number(data.direction); renderUsers(); renderRequests(); icons(); }
    else if (data.user) openUser(Number(data.user));
    else if (data.detailTab) openUser(state.detailUser, data.detailTab);
    else if (data.request) openRequest(data.request, Number(data.backUser) || null);
    else if (data.history) openHistory(data.history);
    else if (data.editor) editorMode(data.editor);
    else if (data.draftUser) openDraft([Number(data.draftUser)]);
    else if (data.notifyUser || data.ignoreUser) {
      const id = Number(data.notifyUser || data.ignoreUser), status = data.notifyUser ? 'notified' : 'ignored';
      confirm(data.notifyUser ? '标记已通知' : '暂不通知', '仅更新本机演示状态，不发送消息。', () => { setNotification(id, status); persist(); render(); openUser(id, 'notifications'); toast('模拟状态已更新'); });
    } else if (data.editDraft) openDraft([], data.editDraft);
    else if (data.markDraft) {
      const draft = saved.drafts.find(item => item.id === data.markDraft);
      if (draft) confirm('标记已通知', `将 ${draft.recipients.length} 位模拟收件人标记为已通知。此操作不发送消息。`, () => { for (const id of draft.recipients) setNotification(id, 'notified'); draft.state = 'handled'; persist(); render(); toast('已更新模拟通知状态，未发送消息'); });
    } else if (data.deleteDraft) {
      confirm('删除模拟草稿', '删除本机保存的这条演示草稿。', () => {
        const draft = saved.drafts.find(item => item.id === data.deleteDraft);
        saved.drafts = saved.drafts.filter(item => item.id !== data.deleteDraft);
        for (const id of draft?.recipients || []) if (notification(id) === 'drafted' && !saved.drafts.some(item => item.state === 'draft' && item.recipients.includes(id))) setNotification(id, 'pending');
        persist(); render(); toast('模拟草稿已删除');
      }, '删除草稿');
    } else if (button.id === 'create-draft') openDraft([...state.selected]);
    else if (button.id === 'reset-filters' || button.id === 'empty-reset') resetFilters();
    else if (button.id === 'export-users') exportUsers();
    else if (button.id === 'show-unlinked') {
      state.association = 'unlinked'; state.requestPage = 1; state.requestSearch = ''; $('request-search').value = '';
      if (!$('association-filter').querySelector('[value=unlinked]')) $('association-filter').add(new Option('全部未关联访问', 'unlinked'));
      $('association-filter').value = 'unlinked'; renderRequests(); icons(); setTab('requests');
    } else if (button.id === 'restore-collection') { state.scenario = 'normal'; $('scenario').value = 'normal'; render(); toast('已切换为正常采集场景'); }
    else if (button.id === 'reset-demo') confirm('重置演示数据', '将清除本机的模拟草稿、通知状态和模拟保留设置。', () => { saved = initial(); persist(); resetFilters(); render(); toast('已恢复初始演示数据'); }, '重置演示');
    else if (button.id === 'refresh') { render(); toast('模拟数据已刷新'); }
    else if (button.id === 'confirm-action') { const action = confirmation; confirmation = null; $('confirm-dialog').close(); action?.(); }
  });
  document.addEventListener('change', event => {
    const target = event.target;
    if (target.dataset.select) { const id = Number(target.dataset.select); if (target.checked) state.selected.add(id); else state.selected.delete(id); renderUsers(); icons(); }
    else if (target.id === 'select-all') {
      const users = filteredUsers().slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
      for (const user of users) if (target.checked) state.selected.add(user.id); else state.selected.delete(user.id);
      renderUsers(); icons();
    } else if (target.id === 'page-size') { state.pageSize = Number(target.value); state.page = 1; renderUsers(); icons(); }
    else if (target.id === 'domain') { state.domain = target.value; resetFilters(); state.requestPage = 1; state.requestSearch = ''; $('request-search').value = ''; state.association = 'all'; $('association-filter').value = 'all'; render(); }
    else if (target.id === 'scenario') { state.scenario = target.value; state.selected.clear(); state.page = 1; state.requestPage = 1; render(); }
    else if (target.id === 'start' || target.id === 'end') applyScope();
    else if (['migration-filter', 'notification-filter', 'sort'].includes(target.id)) { state.migration = $('migration-filter').value; state.notification = $('notification-filter').value; state.sort = $('sort').value; state.page = 1; state.selected.clear(); renderUsers(); icons(); }
    else if (target.id === 'association-filter') { state.association = target.value; state.requestPage = 1; renderRequests(); icons(); }
  });
  let searchTimer;
  $('user-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = $('user-search').value; state.page = 1; state.selected.clear(); renderUsers(); icons(); }, 150); });
  $('request-search').addEventListener('input', () => { state.requestSearch = $('request-search').value; state.requestPage = 1; renderRequests(); icons(); });
  document.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'users-filter') { clearTimeout(searchTimer); state.search = $('user-search').value; state.page = 1; state.selected.clear(); renderUsers(); icons(); }
    if (event.target.id === 'draft-form') {
      const title = $('draft-title').value.trim(), content = $('draft-content').value.trim();
      if (!title || !content) { toast('请填写标题和消息内容'); return; }
      let draft = saved.drafts.find(item => item.id === state.editingDraft);
      if (draft) Object.assign(draft, { title, content, createdAt: stamp(), state: 'draft' });
      else { draft = { id: `demo-draft-${Date.now()}-${++actionSequence}`, recipients: [...state.draftRecipients], domain: state.domain, title, content, createdAt: stamp(), state: 'draft' }; saved.drafts.unshift(draft); }
      for (const id of draft.recipients) setNotification(id, 'drafted');
      const persisted = persist(); state.selected.clear(); $('draft-dialog').close(); render(); setTab('drafts');
      if (persisted) toast('模拟草稿已保存，未发送消息');
    } else if (event.target.id === 'collection-settings') {
      saved.retention = Number($('retention').value); saved.summaryRetention = Number($('summary-retention').value);
      if (persist()) toast('模拟保留设置已保存');
    }
  });
  document.addEventListener('keydown', event => {
    const button = event.target.closest('[data-tab]');
    if (button && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const buttons = [...document.querySelectorAll('[data-tab]')], index = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); setTab(buttons[next].dataset.tab, true);
    }
    const detail = event.target.closest('[data-detail-tab]');
    if (detail && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const tabs = ['overview', 'evidence', 'notifications'];
      const next = (tabs.indexOf(detail.dataset.detailTab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); openUser(state.detailUser, tabs[next]); document.querySelector(`[data-detail-tab="${tabs[next]}"]`).focus();
    }
  });
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  new ResizeObserver(() => chart?.resize()).observe($('trend'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderChart);
  render();
  requestAnimationFrame(() => document.querySelector('[data-main="users"]').scrollIntoView({ block: 'nearest', inline: 'nearest' }));
})();
