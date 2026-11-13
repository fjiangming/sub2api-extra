(function (root) {
  'use strict';
  const labels = { confirmed: '已确认用户', pending: '等待关联', ambiguous: '身份冲突', anonymous: '无身份记录', unverified: '入口未验证',
    still: '最近仍用旧域名', new: '近期仅见新域名', inactive: '近期无访问', drafted: '已生成草稿', notified: '已通知', ignored: '暂不通知',
    unconfigured: '尚未配置采集', ready: '采集读取正常', error: '采集异常', interrupted: '采集中断', catching_up: '正在追赶日志' };
  const reasons = { backend_id_mismatch: '后端响应编号与网关生成编号不一致，不能确认身份。', awaiting_exact_record: '等待主站产生可精确匹配的身份记录。',
    no_authenticated_record: '网页或静态访问没有可验证的用户记录。', exact_record_not_found: '尚未找到相同请求编号；不会按 IP 或时间猜测用户。',
    identity_conflict: '相同请求编号对应多个身份，已排除出通知名单。', gateway_id_collision: '入口编号出现在不同请求中，关联已被隔离。',
    trusted_gateway_exact_core_request: '网关生成的编号与后端响应一致，并精确匹配主站已有请求快照。', user_unavailable: '用户信息缺失、已删除或角色未验证。' };
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive, openMessages }) {
    const $ = id => document.getElementById(`da-${id}`), container = $('root');
    let options = null, report = null, rows = null, tab = 'users', page = 1, pageSize = 20, selected = new Map();
    let seq = 0, detailSeq = 0, controller = null, detailController = null, timer = null, searchTimer = null, chart = null;
    let detailUser = null, detailTab = 'overview', draftIds = [], draftKey = null, busy = false;
    const number = value => new Intl.NumberFormat('zh-CN').format(value || 0);
    const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: options?.timezone || 'Asia/Shanghai', hour12: false }) : '未记录';
    const badge = (value, fallback = '') => `<span class="da-badge ${['confirmed', 'notified', 'ready', 'new'].includes(value) ? 'green' : ['pending', 'still', 'unverified', 'error', 'interrupted'].includes(value) ? 'amber' : value === 'ambiguous' ? 'red' : value === 'drafted' ? 'blue' : ''}">${esc(value === 'pending' && fallback ? fallback : labels[value] || value)}</span>`;
    const empty = text => `<div class="da-empty">${esc(text)}</div>`;
    const link = (value, attribute) => `<button type="button" class="da-link" ${attribute}>${esc(value)}</button>`;
    const facts = entries => `<dl class="da-facts">${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
    const table = (heads, body, className = '') => `<div class="table-wrap da-main-table ${className}"><table><thead><tr>${heads.map(head => `<th>${head}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${heads.length}" class="empty-row">当前筛选下没有记录</td></tr>`}</tbody></table></div>`;
    const formOptions = (values, all) => `<option value="all">${all}</option>` + values.map(value => `<option value="${value}">${esc(labels[value])}</option>`).join('');
    function init() {
      container.innerHTML = `<section class="da-scope" aria-label="域名与时间范围"><div class="da-domain-pair"><label>关注域名<select id="da-domain"></select></label>${icon('arrow-right')}<div class="da-target"><small>迁移目标</small><strong id="da-target"></strong></div></div><div class="da-dates"><div class="da-presets" role="group" aria-label="观察时段"><button data-da-preset="1" aria-pressed="false">今天</button><button data-da-preset="7" aria-pressed="true">近 7 天</button><button data-da-preset="30" aria-pressed="false">近 30 天</button></div><div class="da-date-inputs"><input id="da-start" type="date" aria-label="开始日期"><span>至</span><input id="da-end" type="date" aria-label="结束日期"></div></div></section>
        <div id="da-status" role="status"></div><section id="da-metrics" class="da-metrics" aria-label="访问指标"></section>
        <section class="da-trend" aria-label="每日访问趋势"><div class="da-section-heading"><h2>访问趋势</h2><small id="da-range"></small><div class="da-legend"><span><b></b>关注域名</span><span><b></b><span id="da-target-legend"></span></span></div></div><div id="da-chart" class="da-chart" role="img" aria-label="关注域名与迁移目标的已采集请求数"></div></section>
        <div class="da-tabs" role="tablist" aria-label="域名访问视图">${[['users','users','用户列表'],['requests','list-filter','访问明细'],['history','history','历史线索'],['collection','radio-tower','采集状态'],['drafts','file-pen-line','通知草稿']].map(([id, glyph, title]) => `<button id="da-tab-${id}" role="tab" data-da-tab="${id}" aria-selected="${id === tab}" aria-controls="da-${id}" tabindex="${id === tab ? 0 : -1}">${icon(glyph)}${title}</button>`).join('')}</div>
        <section id="da-users" role="tabpanel" aria-labelledby="da-tab-users"><form id="da-users-filter" class="da-local-filter"><label class="da-search">${icon('search')}<input name="search" placeholder="搜索用户、邮箱或 Key ID" aria-label="搜索用户、邮箱或 Key ID" autocomplete="off"></label><select name="migration" aria-label="域名使用状态">${formOptions(['still','new','inactive'],'全部使用状态')}</select><select name="notification" aria-label="通知状态">${formOptions(['pending','drafted','notified','ignored'],'全部通知状态').replace('等待关联','待通知')}</select><select name="sort" aria-label="用户排序"><option value="latest">最近旧域名访问</option><option value="count">旧域名请求最多</option><option value="id">用户 ID</option></select><button type="button" class="icon-button" data-da-action="reset" title="重置筛选" aria-label="重置筛选">${icon('rotate-ccw')}</button></form><div class="da-toolbar"><span id="da-selection">已选择 0 位用户</span><div><button class="icon-button" data-da-action="export" title="导出筛选后的用户" aria-label="导出筛选后的用户">${icon('download')}</button><button id="da-create" class="button primary" data-da-action="compose" disabled>${icon('mail-plus')}生成通知草稿</button></div></div><div id="da-user-table"></div><div id="da-user-pagination" class="da-pagination"></div><p class="da-footnote">${icon('badge-check')}仅包含身份已确认的普通用户。累计、首次和最后访问均以保留记录为准；使用状态观察所选结束日之前 7 天。</p></section>
        <section id="da-requests" role="tabpanel" aria-labelledby="da-tab-requests" hidden><form id="da-requests-filter" class="da-local-filter"><label class="da-search">${icon('search')}<input name="search" placeholder="搜索请求 ID、用户或路径" aria-label="搜索请求 ID、用户或路径" autocomplete="off"></label><select name="identity" aria-label="身份关联状态">${formOptions(['confirmed','pending','ambiguous','anonymous','unverified'],'全部关联状态')}</select></form><div id="da-request-table"></div><div id="da-request-pagination" class="da-pagination"></div><p id="da-raw-note" class="da-footnote"></p></section>
        <section id="da-history" role="tabpanel" aria-labelledby="da-tab-history" hidden></section><section id="da-collection" role="tabpanel" aria-labelledby="da-tab-collection" hidden></section><section id="da-drafts" role="tabpanel" aria-labelledby="da-tab-drafts" hidden></section>
        <dialog id="da-detail-dialog" class="da-dialog da-drawer"><header><div id="da-detail-heading"></div><button class="icon-button" data-da-close="detail-dialog" title="关闭详情" aria-label="关闭详情">${icon('x')}</button></header><div id="da-detail-body" class="da-dialog-body"></div></dialog>
        <dialog id="da-draft-dialog" class="da-dialog da-compose"><header><div><h2>通知草稿</h2><p>保存到用户消息，等待管理员发布</p></div><button class="icon-button" data-da-close="draft-dialog" title="关闭草稿" aria-label="关闭草稿">${icon('x')}</button></header><form id="da-draft-form"><div class="da-dialog-body"><div id="da-recipients" class="da-recipients"></div><label>标题<input id="da-draft-title" maxlength="200" required></label><div class="da-editor-heading"><span>消息内容</span><div class="da-presets"><button type="button" data-da-editor="edit" aria-pressed="true">编辑</button><button type="button" data-da-editor="preview" aria-pressed="false">预览</button></div></div><textarea id="da-draft-content" rows="10" maxlength="16000" aria-label="通知内容" required></textarea><div id="da-draft-preview" class="da-preview" hidden></div><p id="da-draft-error" class="form-error" role="alert"></p></div><footer><button type="button" class="button secondary" data-da-close="draft-dialog">取消</button><button id="da-save-draft" type="submit" class="button primary">${icon('save')}保存草稿</button></footer></form></dialog>
        <dialog id="da-notify-dialog" class="da-dialog da-compose"><header><h2>记录通知状态</h2><button class="icon-button" data-da-close="notify-dialog" title="关闭" aria-label="关闭">${icon('x')}</button></header><form id="da-notify-form"><div class="da-dialog-body"><label>状态<select id="da-notify-state"><option value="notified">已通知（人工确认）</option><option value="ignored">暂不通知</option><option value="pending">待通知</option></select></label><label>通知渠道或原因<textarea id="da-notify-note" rows="3" maxlength="500" required></textarea></label><p class="da-footnote">此处记录人工处理结果；消息是否发布、是否已读以用户消息记录为准。</p><p id="da-notify-error" class="form-error" role="alert"></p></div><footer><button type="button" class="button secondary" data-da-close="notify-dialog">取消</button><button type="submit" class="button primary">${icon('save')}保存状态</button></footer></form></dialog>`;
      container.querySelector('.da-domain-pair > svg')?.classList.add('da-domain-arrow');
      for (const dialog of container.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
      $('detail-dialog').addEventListener('close', () => { ++detailSeq; detailController?.abort(); });
      refreshIcons();
    }
    function query(local = true) {
      const form = local && ['users','requests'].includes(tab) ? $(`${tab}-filter`) : null;
      return { domain: $('domain').value, start: $('start').value, end: $('end').value,
        ...(form ? Object.fromEntries(new FormData(form)) : {}), page: String(page), pageSize: String(pageSize) };
    }
    function run(task) { task().catch(error => { if (error.name !== 'AbortError' && isActive()) toast(error.message, 'error'); }); }
    function updateOptions(value, first = false) {
      const previous = $('domain').value;
      options = value; $('domain').innerHTML = options.domains.map(host => `<option value="${esc(host)}">${esc(host)}</option>`).join('');
      if (options.domains.includes(previous)) $('domain').value = previous;
      $('target').textContent = options.target; $('target-legend').textContent = options.target;
      for (const id of ['start','end']) $(id).max = options.today;
      if (first) { $('start').value = options.defaultStart; $('end').value = options.today; }
    }
    async function load({ refresh = false } = {}) {
      const current = ++seq; controller?.abort(); controller = new AbortController(); clearTimeout(timer);
      container.setAttribute('aria-busy', 'true');
      const signal = controller.signal;
      try {
        if (!options || refresh) {
          const value = await api('/api/domain-access/options', { signal });
          if (!isActive() || current !== seq) return;
          updateOptions(value, !options);
        }
        const q = query(), baseQuery = new URLSearchParams(query(false));
        const [nextReport, nextRows] = await Promise.all([
          api(`/api/domain-access/report?${baseQuery}`, { signal }),
          api(`/api/domain-access/${tab === 'collection' ? 'status' : tab}?${new URLSearchParams(q)}`, { signal })
        ]);
        if (!isActive() || current !== seq) return;
        report = nextReport; rows = nextRows; renderReport(); renderRows();
        setPageMeta(`${report.query.start} 至 ${report.query.end} · ${report.timezone} · 更新于 ${time(report.generatedAt)}`);
        const pending = tab === 'drafts' && rows.items?.some(batch => batch.recipients.some(row => row.state === 'pending'));
        if (!document.hidden) timer = setTimeout(() => run(() => load()), pending ? 3000 : 30000);
      } catch (error) {
        if (!isActive() || current !== seq || error.name === 'AbortError') return;
        $('status').innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
        $(`${tab === 'users' ? 'user-table' : tab === 'requests' ? 'request-table' : tab}`).innerHTML = empty('本次读取失败，请刷新重试');
        throw error;
      } finally { if (current === seq) container.setAttribute('aria-busy', 'false'); }
    }
    function renderReport() {
      const status = report.status, s = report.summary;
      const warnings = [];
      if (status.status !== 'ready') warnings.push(`${labels[status.status]}${status.error ? ' · ' + status.error : ''}`);
      if (status.identitySource.lastError) warnings.push(`身份来源暂不可用 · ${status.identitySource.lastError}；新请求保留为等待关联。`);
      if (status.retention?.summarySince && report.query.start < status.retention.summarySince) warnings.push(`汇总仅保留 ${status.retention.summarySince} 及之后的数据。`);
      warnings.push(`启用前的访问无法补全。没有采集记录不代表没有访问；${status.gaps?.length ? '存在 ' + status.gaps.length + ' 条采集缺口记录。' : '首次 / 最后访问仅代表当前保留数据。'}`);
      $('status').innerHTML = warnings.map((text, index) => `<div class="alert ${index === 0 && status.status !== 'ready' ? 'warning' : 'info'}">${esc(text)}</div>`).join('');
      $('metrics').innerHTML = [['保留累计确认用户',s.users,'普通用户 · 截至所选结束日',''],['时段内旧域名用户',s.periodUsers,'已确认身份的普通用户','blue'],['时段内入口请求',s.requests,'同一入口编号只计一次',''],['身份未确认请求',s.unknown,'包含等待关联、冲突和无身份记录','amber']].map(([title,value,caption,tone]) => `<article class="da-metric ${tone}"><span>${title}</span><strong>${number(value)}</strong><small>${caption}</small></article>`).join('');
      $('range').textContent = `${report.query.start} — ${report.query.end}`;
      if (root.echarts) {
        chart ||= root.echarts.init($('chart'));
        chart.setOption({ animation: false, grid: { left: 42, right: 12, top: 18, bottom: 25 },
          tooltip: { trigger: 'axis', renderMode: 'richText' }, xAxis: { type: 'category', data: report.days.map(row => row.date.slice(5)), boundaryGap: false,
            axisLine: { lineStyle: { color: '#dfe2dc' } }, axisTick: { show: false }, axisLabel: { color: '#69716b', fontSize: 10 } },
          yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#69716b', fontSize: 10 }, splitLine: { lineStyle: { color: '#e8ece8', type: 'dashed' } } },
          series: [{ name: '关注域名', type: 'line', data: report.days.map(row => row.old), showSymbol: report.days.length < 8, lineStyle: { width: 2 }, itemStyle: { color: '#bc8536' } },
            { name: report.target, type: 'line', data: report.days.map(row => row.target), showSymbol: report.days.length < 8, lineStyle: { width: 2 }, itemStyle: { color: '#268469' } }] }, true);
        chart.resize();
      }
    }
    function pagination(id) {
      const pages = Math.max(1, Math.ceil(rows.total / rows.pageSize));
      $(id).innerHTML = `<span>共 ${number(rows.total)} 条 · 第 ${page} / ${pages} 页</span><div><select data-da-size aria-label="每页条数">${[20,50,100].map(size => `<option value="${size}"${size === pageSize ? ' selected' : ''}>${size} 条 / 页</option>`).join('')}</select><button class="icon-button" data-da-page="${page - 1}" title="上一页" aria-label="上一页"${page <= 1 ? ' disabled' : ''}>${icon('chevron-left')}</button><button class="icon-button" data-da-page="${page + 1}" title="下一页" aria-label="下一页"${page >= pages ? ' disabled' : ''}>${icon('chevron-right')}</button></div>`;
    }
    function userRows() {
      $('user-table').innerHTML = table(['<input type="checkbox" id="da-select-page" aria-label="选择本页用户">','用户','使用的 Key','域名使用状态','时段 / 累计请求','最近旧域名访问','通知状态',''], rows.items.map(user => `<tr><td><input type="checkbox" data-da-select="${user.id}" aria-label="选择用户 ${esc(user.name)}"${selected.has(user.id) ? ' checked' : ''}></td><td><button type="button" class="da-link da-user-link" data-da-user="${user.id}"><span class="da-avatar">${esc(user.name.slice(0,1).toUpperCase())}</span><span class="da-user-text"><span>${esc(user.name)}</span><small>#${user.id} · ${esc(user.email)}</small><span class="da-mobile-info"><span>${badge(user.migration)}${badge(user.notification, '待通知')}</span><small>旧域名 ${number(user.count)} 次 · 累计 ${number(user.totalCount)}</small></span></span></button></td><td>${user.keyIds.slice(0,3).map(id => '#' + id).join(' / ') || '明细已过保留期'}${user.keyIds.length > 3 ? '<small>另有 ' + (user.keyIds.length - 3) + ' 个 Key</small>' : ''}</td><td>${badge(user.migration)}</td><td>${number(user.count)}<small>累计 ${number(user.totalCount)}</small></td><td>${esc(time(user.lastAt))}</td><td>${badge(user.notification, '待通知')}</td><td><button type="button" class="icon-button" data-da-user="${user.id}" title="查看用户详情" aria-label="查看用户详情">${icon('arrow-up-right')}</button></td></tr>`).join(''));
      pagination('user-pagination'); updateSelection();
    }
    function updateSelection() {
      $('selection').textContent = `已选择 ${selected.size} 位用户`;
      $('create').disabled = !selected.size || selected.size > 50;
      const all = $('select-page');
      if (all && rows?.items) { all.checked = rows.items.length > 0 && rows.items.every(user => selected.has(user.id)); all.indeterminate = !all.checked && rows.items.some(user => selected.has(user.id)); }
    }
    function requestRows(items) {
      return items.map(row => `<tr><td>${link(time(row.at), `data-da-request="${row.id}"`)}<small class="da-code">${esc(row.id)}</small></td><td>${esc(row.domain)}<small>${esc(row.method)} ${esc(row.path)}</small></td><td>${row.user_id ? esc(row.name || '#' + row.user_id) : '身份未知'}<small>${row.key_id ? 'Key #' + row.key_id : '无已验证 Key'}</small></td><td>HTTP ${row.status}<small>流完成情况未采集</small></td><td>${badge(row.identity)}</td><td><button type="button" class="icon-button" data-da-request="${row.id}" title="查看关联证据" aria-label="查看关联证据">${icon('arrow-up-right')}</button></td></tr>`).join('');
    }
    function renderRows() {
      container.querySelectorAll('[data-da-tab]').forEach(button => { const active = button.dataset.daTab === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; $(button.dataset.daTab).hidden = !active; });
      if (tab === 'users') userRows();
      if (tab === 'requests') { $('request-table').innerHTML = table(['访问时间 / 请求 ID','域名 / 路径','用户 / Key','HTTP / 流状态','身份关联',''], requestRows(rows.items)); pagination('request-pagination'); $('raw-note').textContent = `访问明细${rows.rawSince ? '保留自 ' + rows.rawSince + ' 起' : '按明细保留期展示'}；HTTP 200 不代表流式输出完整。`;
      }
      if (tab === 'history') $('history').innerHTML = `<p class="da-info-strip">历史 Referer 只能说明来源页面；明确 Host 可以证明请求域名，均不能据此确认用户。没有完整证据的订单、IP 或时间相近记录不会加入通知名单。</p>${table(['日期','证据类型','路径分类','去重线索数','身份结论'], rows.items.map(row => `<tr><td>${esc(row.day)}</td><td><span class="da-badge ${row.evidence === 'host' ? 'blue' : 'amber'}">${row.evidence === 'host' ? '明确 Host' : 'Referer 线索'}</span></td><td>${esc(row.path)}</td><td>${number(row.count)}</td><td>无法确认用户</td></tr>`).join(''), 'da-history-table')}<p class="da-footnote">${esc(rows.deduplication)} 最多展示 ${rows.limit} 组；未导入的旧日志不会显示。</p>`;
      if (tab === 'collection') renderCollection();
      if (tab === 'drafts') renderDrafts();
      refreshIcons();
    }
    function renderCollection() {
      const s = rows, settings = s.settings;
      $('collection').innerHTML = `<h2 class="da-section-title">${labels[s.status]}</h2>${facts([['最近成功扫描',time(s.lastSuccessAt)],['最近入口请求结束',time(s.latestRequestAt)],['身份来源',s.identitySource.lastError || (s.identitySource.lastSuccess ? '最近读取 ' + time(s.identitySource.lastSuccess) : '尚无成功关联查询')],['明细记录',number(s.rawCount)],['无效 / 已跳过行',number(s.invalid) + ' / ' + number(s.ignored)],['采集缺口',number(s.gaps?.length)]])}
        <form id="da-settings-form" class="da-settings"><label class="da-domains-field">关注域名（每行一个）<textarea name="domains" rows="2" required>${esc(settings.domains.join('\n'))}</textarea></label><label>迁移目标<input name="target" value="${esc(settings.target)}" required></label><label>明细保留天数<input type="number" name="rawDays" min="7" max="365" value="${settings.rawDays}" required></label><label>汇总保留天数<input type="number" name="summaryDays" min="30" max="3650" value="${settings.summaryDays}" required></label><button class="button primary" type="submit">${icon('save')}保存设置</button><p class="da-footnote">缩短保留期会清理到期的运营中心记录，延长保留期不能恢复已清理记录。新增域名从后续扫描开始采集；需同时配置对应 Nginx 入口。</p><p id="da-settings-error" class="form-error" role="alert"></p></form>
        <h3 class="da-section-title">日志文件与断点</h3>${table(['文件','已处理偏移','最近检查'], (s.files || []).map(file => `<tr><td class="da-wrap">${esc(file.name)}</td><td>${number(file.offset)} B${file.done ? ' · 完成' : ''}</td><td>${esc(time(file.checkedAt))}</td></tr>`).join(''), 'da-history-table')}
        <h3 class="da-section-title">采集缺口与异常</h3>${table(['时间','原因','文件'], (s.gaps || []).slice().reverse().map(gap => `<tr><td>${esc(time(gap.at))}</td><td>${esc(gap.reason)}</td><td class="da-wrap">${esc(gap.file || '日志目录')}</td></tr>`).join(''), 'da-history-table')}<p class="da-footnote">${esc(s.coverage)} 本模块只读入口日志和已有身份记录；网页或未鉴权请求可能始终没有用户身份。</p>`;
    }
    function renderDrafts() {
      $('drafts').innerHTML = `<div class="da-toolbar da-info-strip"><span>草稿和通知状态分别保存。发布、编辑、删除及已读情况在用户消息中管理。</span><button class="button" data-da-action="messages">${icon('mail')}用户消息</button></div>${rows.items.length ? rows.items.map(batch => `<section class="da-info-strip"><div class="da-toolbar"><strong>${esc(batch.title)}</strong><span>${esc(time(batch.createdAt))}</span></div><p class="da-wrap">${esc(batch.content)}</p>${table(['用户','草稿结果','用户消息','发布 / 已读'], batch.recipients.map(row => `<tr><td>#${row.userId}</td><td>${row.state === 'drafted' ? badge('drafted') : row.state === 'pending' ? '等待处理' : badge('error')}<small>${esc(row.error || '')}</small></td><td>${row.message ? '#' + row.message.id : row.state === 'drafted' ? '已删除或不可用' : '尚未生成'}</td><td>${row.message ? row.message.readAt ? '已读 · ' + esc(time(row.message.readAt)) : row.message.status === 'active' ? '已发布 · 未读' : row.message.status === 'archived' ? '已归档' : '草稿 · 未发布' : '未确认'}</td></tr>`).join(''), 'da-history-table')}${batch.recipients.some(row => row.state === 'failed') ? `<button class="button" data-da-retry="${batch.id}">${icon('rotate-cw')}重试失败项</button>` : ''}</section>`).join('') : empty('尚未生成通知草稿')}`;
    }
    async function openUser(id) {
      const current = ++detailSeq; detailController?.abort(); detailController = new AbortController();
      const user = await api(`/api/domain-access/users/${id}?${new URLSearchParams(query(false))}`, { signal: detailController.signal });
      if (!isActive() || current !== detailSeq) return;
      detailUser = user; detailTab = 'overview'; $('detail-heading').innerHTML = `<h2>${esc(user.name)}</h2><p>#${user.id} · ${esc(user.email)}</p>`;
      renderUser(); if (!$('detail-dialog').open) $('detail-dialog').showModal();
    }
    function renderUser() {
      const u = detailUser;
      const tabs = `<div class="da-detail-tabs" role="tablist" aria-label="用户详情">${[['overview','访问概览'],['evidence','身份依据'],['notifications','通知记录']].map(([id,title]) => `<button role="tab" aria-selected="${id === detailTab}" data-da-detail-tab="${id}">${title}</button>`).join('')}</div>`;
      let content;
      if (detailTab === 'overview') content = `${facts([['保留累计请求',number(u.totalCount)],['时段内请求',number(u.count)],['首次旧域名访问',time(u.firstAt)],['最后旧域名访问',time(u.lastAt)],['最近新域名访问',time(u.targetLastAt)],['使用的 Key',u.keyIds.map(id => '#' + id).join(' / ') || '明细已过保留期']])}${badge(u.migration)} ${badge(u.notification,'待通知')}<div class="da-detail-actions"><button class="button primary" data-da-compose-user="${u.id}">${icon('mail-plus')}生成通知草稿</button><button class="button" data-da-notify-user="${u.id}">${icon('check-check')}记录通知状态</button></div><h3>最近访问明细（最多 20 条）</h3><div class="da-small-table">${table(['时间 / 请求','域名 / 路径','用户 / Key','HTTP / 流状态','身份关联',''], requestRows(u.requests.items))}</div>`;
      if (detailTab === 'evidence') content = `<p class="da-info-strip">入口日志中的 Host 证明域名，网关生成的编号必须与后端响应一致，再精确关联主站已有快照中的用户与 Key。多次上游尝试只计一个入口请求。IP、时间接近和 Referer 均不用于确认身份。</p>${u.requests.items.length ? u.requests.items.slice(0,5).map(row => `<h3>${link(row.id,`data-da-request="${row.id}"`)}</h3><p>${esc(reasons[row.reason] || row.reason)}</p><p class="da-code">${esc(row.evidence.map(e => e.source + ' #' + e.id).join('\n'))}</p>`).join('') : empty('明细已过保留期，仅保留已确认的汇总记录')}`;
      if (detailTab === 'notifications') content = `${u.notifications.map(row => `<div class="da-notice-log"><strong>${badge(row.action,'待通知')} · ${esc(time(row.at))}</strong><p>${esc(row.actor)} · ${esc(row.note)}</p></div>`).join('')}${u.messages.map(message => `<div class="da-notice-log"><strong>${esc(message.title)}</strong><p>${esc(time(message.at))} · ${message.message ? '用户消息 #' + message.message.id + ' · ' + esc(message.message.status) : '草稿未生成或已删除'}</p></div>`).join('') || empty('没有通知记录')}`;
      $('detail-body').innerHTML = tabs + content; refreshIcons();
    }
    async function openRequest(id) {
      const current = ++detailSeq; detailController?.abort(); detailController = new AbortController();
      const row = await api(`/api/domain-access/requests/${id}`, { signal: detailController.signal });
      if (!isActive() || current !== detailSeq) return;
      detailUser = null;
      $('detail-heading').innerHTML = '<h2>请求关联证据</h2><p class="da-code">' + esc(row.id) + '</p>';
      $('detail-body').innerHTML = `${badge(row.identity)}${facts([['访问时间',time(row.at)],['请求域名',row.domain],['请求路径',row.method + ' ' + row.path],['下游 HTTP',row.status],['用户',row.user_id ? (row.name || '') + ' #' + row.user_id : '身份未知'],['Key',row.key_id ? '#' + row.key_id : '无已验证记录']])}<h3>关联结论</h3><p>${esc(reasons[row.reason] || row.reason)}</p><h3>主站只读证据</h3>${row.evidence.length ? row.evidence.map(item => `<p class="da-code">${esc(item.source)} #${esc(item.id)}</p>`).join('') : '<p>没有可验证的身份记录</p>'}<p class="da-footnote">HTTP 200 不代表流式输出完整；身份未知的请求不会加入通知名单。</p>`;
      refreshIcons(); if (!$('detail-dialog').open) $('detail-dialog').showModal();
    }
    function compose(ids) {
      if (!ids.length || ids.length > 50) { toast('每批请选择 1 至 50 位已确认用户', 'error'); return; }
      draftIds = ids; draftKey = crypto.randomUUID(); $('draft-error').textContent = '';
      $('draft-title').value = 'API 访问域名变更通知';
      $('draft-content').value = `您好，\n\n您曾使用 ${$('domain').value} 访问 API 服务。请将客户端的 API 地址更换为 https://${options.target}，原有路径保持一致。\n\n完成后请检查客户端连接设置。感谢您的支持。`;
      $('recipients').textContent = `收件人：${ids.map(id => selected.get(id)?.name || (detailUser?.id === id ? detailUser.name : '用户 #' + id)).join('、')}（${ids.length} 位）`;
      editor('edit'); $('draft-dialog').showModal(); $('draft-title').focus();
    }
    function editor(mode) {
      const preview = mode === 'preview'; $('draft-content').hidden = preview; $('draft-preview').hidden = !preview;
      $('draft-preview').textContent = $('draft-content').value;
      container.querySelectorAll('[data-da-editor]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.daEditor === mode)));
    }
    async function saveDraft(event) {
      event.preventDefault(); if (busy) return;
      busy = true; $('save-draft').disabled = true; $('draft-error').textContent = '';
      try {
        await api('/api/domain-access/drafts', { method: 'POST', headers: { 'idempotency-key': draftKey },
          body: JSON.stringify({ domain: $('domain').value, userIds: draftIds, title: $('draft-title').value, content: $('draft-content').value }) });
        if (!isActive()) return;
        $('draft-dialog').close(); $('detail-dialog').close(); selected.clear(); toast('草稿任务已保存，未发布消息'); tab = 'drafts'; page = 1; await load();
      } catch (error) { if (isActive()) $('draft-error').textContent = error.message; }
      finally { busy = false; if ($('save-draft')) $('save-draft').disabled = false; }
    }
    async function saveSettings(event) {
      event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true;
      try {
        const form = new FormData(event.target), value = { domains: String(form.get('domains')).split(/[\s,]+/).filter(Boolean),
          target: String(form.get('target')).trim(), rawDays: Number(form.get('rawDays')), summaryDays: Number(form.get('summaryDays')) };
        const next = await api('/api/domain-access/settings', { method: 'PUT', body: JSON.stringify(value) });
        if (!isActive()) return;
        selected.clear(); updateOptions(next); toast('采集设置已保存'); await load();
      } catch (error) { if (isActive()) $('settings-error').textContent = error.message; }
      finally { if (button.isConnected) button.disabled = false; }
    }
    container.addEventListener('submit', event => {
      if (event.target.id === 'da-draft-form') { run(() => saveDraft(event)); return; }
      if (event.target.id === 'da-settings-form') { run(() => saveSettings(event)); return; }
      if (event.target.id === 'da-notify-form') {
        event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true;
        run(async () => {
          try {
            await api('/api/domain-access/notifications', { method: 'POST', body: JSON.stringify({ domain: $('domain').value,
              userIds: [Number($('notify-dialog').dataset.userId)], state: $('notify-state').value, note: $('notify-note').value }) });
            if (!isActive()) return;
            $('notify-dialog').close(); $('detail-dialog').close(); toast('通知状态已记录'); await load();
          } catch (error) { if (isActive()) $('notify-error').textContent = error.message; }
          finally { if (button.isConnected) button.disabled = false; }
        }); return;
      }
      event.preventDefault(); page = 1; run(() => load());
    });
    container.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      const data = button.dataset;
      if (data.daClose) { $(data.daClose).close(); ++detailSeq; detailController?.abort(); return; }
      if (data.daTab) { tab = data.daTab; page = 1; run(() => load()); }
      if (data.daPage) { page = Number(data.daPage); run(() => load()); }
      if (data.daUser) run(() => openUser(data.daUser));
      if (data.daRequest) run(() => openRequest(data.daRequest));
      if (data.daDetailTab) { detailTab = data.daDetailTab; renderUser(); }
      if (data.daComposeUser) compose([Number(data.daComposeUser)]);
      if (data.daNotifyUser) { $('notify-dialog').dataset.userId = data.daNotifyUser; $('notify-note').value = ''; $('notify-error').textContent = ''; $('notify-dialog').showModal(); }
      if (data.daEditor) editor(data.daEditor);
      if (data.daPreset) {
        $('end').value = options.today; const date = new Date(options.today + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - Number(data.daPreset) + 1); $('start').value = date.toISOString().slice(0,10);
        container.querySelectorAll('[data-da-preset]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); page = 1; selected.clear(); run(() => load());
      }
      if (data.daRetry) run(async () => { button.disabled = true; try { await api(`/api/domain-access/drafts/${data.daRetry}/retry`, { method: 'POST', body: '{}' }); if (isActive()) await load(); } finally { if (button.isConnected) button.disabled = false; } });
      if (data.daAction === 'messages') openMessages();
      if (data.daAction === 'compose') compose([...selected.keys()]);
      if (data.daAction === 'reset') { $('users-filter').reset(); selected.clear(); page = 1; run(() => load()); }
      if (data.daAction === 'export') run(async () => {
        const value = await api(`/api/domain-access/users.csv?${new URLSearchParams(query())}`); if (!isActive()) return;
        const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = `domain-users-${$('domain').value}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('用户名单已导出');
      });
    });
    container.addEventListener('change', event => {
      const target = event.target;
      if (target.dataset.daSelect) {
        const id = Number(target.dataset.daSelect), user = rows.items.find(row => row.id === id);
        if (target.checked && selected.size >= 50) { target.checked = false; toast('每批最多选择 50 位用户', 'error'); return; }
        if (target.checked) selected.set(id, user); else selected.delete(id); updateSelection(); return;
      }
      if (target.id === 'da-select-page') {
        for (const user of rows.items) { if (target.checked && selected.size < 50) selected.set(user.id, user); if (!target.checked) selected.delete(user.id); }
        userRows(); refreshIcons(); return;
      }
      if (target.hasAttribute('data-da-size')) { pageSize = Number(target.value); page = 1; run(() => load()); return; }
      if (['da-domain','da-start','da-end'].includes(target.id) || target.closest('#da-users-filter,#da-requests-filter') && target.tagName === 'SELECT') {
        selected.clear(); page = 1;
        if (target.id === 'da-start' || target.id === 'da-end') container.querySelectorAll('[data-da-preset]').forEach(node => node.setAttribute('aria-pressed','false'));
        run(() => load());
      }
    });
    container.addEventListener('input', event => {
      if (!event.target.matches('#da-users-filter input[name=search],#da-requests-filter input[name=search]')) return;
      clearTimeout(searchTimer); selected.clear(); page = 1; searchTimer = setTimeout(() => run(() => load()), 250);
    });
    container.addEventListener('keydown', event => {
      const tabs = [...container.querySelectorAll('[data-da-tab]')], index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
    root.addEventListener('resize', () => chart?.resize());
    function leave() { ++seq; ++detailSeq; controller?.abort(); detailController?.abort(); clearTimeout(timer); clearTimeout(searchTimer); container.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
    function reset() { leave(); options = null; report = null; rows = null; selected.clear(); detailUser = null; draftIds = []; draftKey = null; tab = 'users'; page = 1; chart?.dispose(); chart = null; init(); }
    init(); return { load, leave, reset };
  }
  root.DomainAccessUi = { create };
})(window);
