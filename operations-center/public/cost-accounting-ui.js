'use strict';

const CostAccountingUi = (() => {
  function create(h) {
    const root = document.getElementById('cost-accounting-root');
    if (!root) return null;
    const e = h.escapeHtml, q = selector => root.querySelector(selector), base = '/api/cost-analysis/cash';
    const state = { tab: 'automatic', report: null, active: false, request: 0, automaticPage: 1, cashPage: 1,
      providers: [], search: '', direction: 'all', origin: 'all', dialogRequest: 0 };
    const money = value => value == null ? '暂不可用' : h.formatMoney(value, '', 8);
    const pct = value => value == null ? '-' : h.formatPercent(value);
    const option = (key, label, selected) => `<option value="${e(key)}"${key === selected ? ' selected' : ''}>${e(label)}</option>`;
    const button = (attr, value, label = '详情') => `<button type="button" class="accounting-link" ${attr}="${e(value)}">${label}</button>`;
    const iconButton = (attr, value, iconName, title, extra = '') => `<button type="button" class="icon-button ${extra}" ${attr}="${e(value)}" title="${e(title)}" aria-label="${e(title)}">${h.icon(iconName)}</button>`;
    const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty-state">暂无记录</td></tr>`}</tbody></table></div>`;
    const pager = name => `<div class="accounting-pager"><span data-${name}-page></span><div>${[-1, 1].map(step => `<button type="button" class="icon-button" data-${name}-step="${step}" title="${step < 0 ? '上一页' : '下一页'}" aria-label="${step < 0 ? '上一页' : '下一页'}">${h.icon(step < 0 ? 'chevron-left' : 'chevron-right')}</button>`).join('')}</div></div>`;
    const metric = (title, value, hint, action, format = money) => `<button type="button" class="accounting-metric" data-metric="${e(action)}"><span>${e(title)}</span><strong class="${value < 0 ? 'negative-value' : ''}" title="${e(format(value))}">${e(format(value))}</strong><small>${e(hint)}</small></button>`;
    root.innerHTML = `
      <div class="accounting-tabs" role="tablist" aria-label="成本分析视图">
        ${[['automatic', '消费毛利'], ['cash', '现金收支']].map(([key, label]) => `<button type="button" id="accounting-tab-${key}" role="tab" aria-controls="accounting-${key}" aria-selected="${key === 'automatic'}" tabindex="${key === 'automatic' ? 0 : -1}" data-tab="${key}">${label}</button>`).join('')}
      </div><div data-notice class="accounting-notice" role="status" hidden></div>
      <section id="accounting-automatic" role="tabpanel" aria-labelledby="accounting-tab-automatic">
        <div class="accounting-metrics" data-automatic-metrics></div><div class="accounting-aux" data-automatic-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>消费与毛利趋势</h2><span class="muted" data-automatic-range></span></div><div id="accounting-automatic-chart" class="chart" role="img" aria-label="主站消费、供应商消费及消费毛利趋势"></div></section>
        <section class="accounting-section"><div class="panel-heading accounting-detail-heading"><div class="accounting-subtabs" role="tablist" aria-label="消费明细">${[['days', '每日明细'], ['providers', '供应商汇总']].map(([key, label]) => `<button type="button" id="cost-detail-tab-${key}" role="tab" aria-controls="cost-detail-${key}" aria-selected="${key === 'days'}" tabindex="${key === 'days' ? 0 : -1}" data-detail-tab="${key}">${label}</button>`).join('')}</div><span class="muted" data-automatic-day-meta></span></div>
          <div id="cost-detail-days" role="tabpanel" aria-labelledby="cost-detail-tab-days"><div class="table-wrap"><table class="accounting-automatic-table"><thead><tr><th>日期</th><th class="numeric">主站消费</th><th class="numeric">供应商消费</th><th class="numeric">消费毛利</th><th class="numeric">毛利率</th><th class="numeric">请求数</th><th>数据状态</th><th>操作</th></tr></thead><tbody data-automatic-days></tbody><tfoot data-automatic-total></tfoot></table></div>${pager('automatic-day')}</div>
          <div id="cost-detail-providers" role="tabpanel" aria-labelledby="cost-detail-tab-providers" hidden><div data-provider-summary></div></div>
        </section>
      </section>
      <section id="accounting-cash" role="tabpanel" aria-labelledby="accounting-tab-cash" hidden>
        <div class="accounting-cash-toolbar"><span class="muted" data-cash-range></span></div>
        <div class="accounting-metrics accounting-cash-period" data-cash-metrics></div>
        <div class="accounting-metrics accounting-cash-history" data-cash-history></div><div class="accounting-aux" data-cash-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>现金收支趋势</h2></div><div id="accounting-cash-chart" class="chart" role="img" aria-label="现金收入、支出与净现金流趋势"></div></section>
        <section class="accounting-section"><div class="panel-heading"><h2>收支记录</h2><button type="button" class="button secondary" data-command="add">${h.icon('plus')}<span>记一笔</span></button></div>
          <form class="accounting-search" data-cash-search><label>搜索<input name="search" type="search" maxlength="100" placeholder="项目、供应商、单号"></label><label>收支<select name="direction"><option value="all">全部</option><option value="income">收入</option><option value="expense">支出</option></select></label><label>来源<select name="origin"><option value="all">全部来源</option><option value="automatic">自动入账</option><option value="manual">手工 / 历史</option></select></label><button type="submit" class="icon-button" title="搜索" aria-label="搜索">${h.icon('search')}</button></form>
          <p class="muted accounting-filter-total" data-filter-total></p><div class="table-wrap"><table class="accounting-cash-table"><thead><tr><th>日期</th><th>项目</th><th>收支</th><th>来源</th><th>供应商 / 用户</th><th class="numeric">金额（元）</th><th>统计状态</th><th>操作</th></tr></thead><tbody data-cash-rows></tbody></table></div>${pager('cash')}
        </section>
      </section>
      <details class="accounting-rules"><summary>统计范围与数据来源</summary><p>消费毛利 = 主站实际消费 − 启用定时检查的供应商账号实际消费。主站消费不含 ID 1；包含余额、赠送与订阅产生的用量，充值额度和余额独立展示。供应商充值只计现金支出，不重复扣入消费毛利。</p><p>自动收入恢复已使用余额兑换的入账口径，按使用日期统计正负额度；排除 ID 1，以及并发、订阅、邀请等非金额兑换，已有有效排除事实沿用。关联支付订单不重复相加；未关联兑换的已付款订单按实收补充。额度可能含赠送、优惠，不等同渠道实收。手工收付按实际日期统计，所有金额统一按人民币原数值计算，历史 USD 100 计为人民币 100 元。</p><p>第一行按所选期间统计，列表搜索只筛记录。第二行的历史收入、历史支出与累计净结余从资金时区 2026-10-01（含当天）累计至今，不受日期和粒度影响。累计净结余 = 该日起累计入账 − 该日起累计支出 − 当前用户余额；余额排除 ID 1 及已删除用户。历史来源或余额缺失时保留未知，源站同步前已清理的数据无法恢复。</p><p>历史日报每日 01:00 自动归档，今天实时统计；缺失来源自动重试，未知不当零。消费毛利、净现金流和累计净结余均不表示经营净利润。</p></details>
      <dialog class="accounting-dialog" data-dialog aria-labelledby="accounting-drawer-title"><header class="accounting-drawer-header"><h2 id="accounting-drawer-title"></h2><button type="button" class="icon-button" data-close title="关闭" aria-label="关闭">${h.icon('x')}</button></header><div class="accounting-drawer-body" data-drawer></div></dialog>`;

    function fitMetrics() {
      root.querySelectorAll('.accounting-metric strong').forEach(node => {
        node.style.fontSize = ''; let size = parseFloat(getComputedStyle(node).fontSize);
        while (node.scrollWidth > node.clientWidth && size > 10) { size--; node.style.fontSize = `${size}px`; }
      });
    }
    new ResizeObserver(fitMetrics).observe(root);
    function readyIcons() { h.refreshIcons(); requestAnimationFrame(fitMetrics); }
    function drawer(title, body) {
      ++state.dialogRequest; q('#accounting-drawer-title').textContent = title; q('[data-drawer]').innerHTML = body;
      if (!q('[data-dialog]').open) q('[data-dialog]').showModal(); readyIcons();
    }
    function pageState(name, p) {
      q(`[data-${name}-page]`).textContent = `第 ${p.page} / ${Math.max(1, p.totalPages)} 页 · ${p.total} ${name === 'balance' ? '位用户' : name === 'automatic-day' ? '天' : '条'}`;
      q(`[data-${name}-step="-1"]`).disabled = p.page <= 1; q(`[data-${name}-step="1"]`).disabled = p.page >= p.totalPages;
    }
    function renderChart(id, periods, fields, currency) {
      h.chart(id, { legend: { type: 'scroll', top: 0, bottom: 'auto', left: 0, right: 0, data: fields.map(field => field[1]) },
        grid: { left: 12, right: 12, top: 58, bottom: 16, containLabel: true }, tooltip: { trigger: 'axis', confine: true, valueFormatter: money },
        xAxis: { type: 'category', data: periods.map(row => row.label), axisLabel: { hideOverlap: true } }, yAxis: { type: 'value', name: currency },
        series: fields.map(([key, name, color]) => ({ name, type: 'line', showSymbol: false, connectNulls: false, data: periods.map(row => row[key]), lineStyle: { color, width: 2 }, itemStyle: { color } })) });
    }
    function renderAutomatic() {
      const r = state.report, s = r.summary;
      q('[data-automatic-metrics]').innerHTML = metric('主站消费', s.siteConsumption, '用户实际消费 · 不含 ID 1', 'siteConsumption') + metric('供应商实际消费', s.supplierConsumption, '启用供应商账号日汇总', 'supplierConsumption') + metric('消费毛利', s.profit, '主站消费 − 供应商实际消费', 'profit') + metric('消费毛利率', s.margin, `${s.completeDays}/${s.days} 天数据完整`, 'margin', pct);
      q('[data-automatic-range]').textContent = `${r.range.start} 至 ${r.range.end} · CNY`; q('[data-automatic-day-meta]').textContent = '历史归档 / 当日实时';
      const notice = q('[data-notice]'); notice.hidden = s.completeDays === s.days && !r.archive?.pendingDays;
      notice.textContent = `${r.archive?.pendingDays ? `${r.archive.pendingDays} 天历史数据正在后台同步或重试。` : ''}${s.completeDays !== s.days ? `数据完整 ${s.completeDays}/${s.days} 天，完整日期毛利小计 ${money(r.completeSubtotal?.profit)} CNY。缺失日期留空。` : ''}`;
      renderMeta(); renderAutomaticDays(); renderProviders();
      renderChart('accounting-automatic-chart', r.periods, [['siteConsumption', '主站消费', '#176b4d'], ['supplierConsumption', '供应商消费', '#b05a3c'], ['profit', '消费毛利', '#2d5ea8']], 'CNY'); readyIcons();
    }
    function renderMeta() {
      const value = (source, amount) => source === undefined ? '读取中' : money(amount);
      q('[data-automatic-meta]').innerHTML = button('data-command', 'credits', `本期充值额度 ${e(value(state.credits, state.credits?.complete ? state.credits.summary.totalIncome : null))}`) + button('data-command', 'balance', `当前用户余额 ${e(value(state.balances, state.balances?.userBalance))}`) + button('data-command', 'upstream', `当前上游余额 ${e(value(state.upstream, state.upstream?.total))}`) + '<span>CNY · 余额为当前快照</span>'; readyIcons();
    }
    function renderAutomaticDays() {
      const r = state.report, size = 15, pages = Math.max(1, Math.ceil(r.items.length / size)); state.automaticPage = Math.max(1, Math.min(state.automaticPage, pages));
      const labels = { complete: '数据完整', site_incomplete: '用量缺失', supplier_incomplete: '成本缺失', future: '未发生', pending_archive: '同步中', archive_failed: '自动重试', live_failed: '自动重试', live_pending: '实时查询中' };
      q('[data-automatic-days]').innerHTML = r.items.slice((state.automaticPage - 1) * size, state.automaticPage * size).map(row => `<tr><td><strong>${e(row.date)}</strong></td>${['siteConsumption', 'supplierConsumption', 'profit'].map(key => `<td class="numeric${row[key] < 0 ? ' negative-value' : ''}">${e(money(row[key]))}</td>`).join('')}<td class="numeric">${e(pct(row.margin))}</td><td class="numeric">${e(row.siteRequests ?? '-')}</td><td><span class="badge ${row.complete ? 'success' : 'warning'}">${e(labels[row.status] || '数据缺失')}</span><small>${row.mode === 'live' ? '今日实时' : row.mode === 'archived' ? '已归档' : '等待同步'}${row.archiveStatus ? ' · 自动更新中' : ''}</small></td><td>${button('data-day', row.date)}</td></tr>`).join('');
      const total = (label, values, hint) => `<tr><th>${label}</th>${['siteConsumption', 'supplierConsumption', 'profit'].map(key => `<td class="numeric">${e(money(values?.[key]))}</td>`).join('')}<td class="numeric">${e(pct(values?.margin))}</td><td colspan="3">${hint}</td></tr>`;
      q('[data-automatic-total]').innerHTML = total('期间合计', r.summary, `${r.summary.completeDays}/${r.summary.days} 天完整`) + (r.summary.completeDays < r.summary.days ? total('完整日期小计', r.completeSubtotal, `仅 ${r.summary.completeDays} 天`) : '');
      pageState('automatic-day', { page: state.automaticPage, totalPages: pages, total: r.items.length }); readyIcons();
    }
    function providerRows() {
      const groups = new Map(), missingScope = state.report.items.some(row => !row.supplierComplete && !row.providers?.length && row.status !== 'future');
      for (const day of state.report.items) for (const provider of day.providers || []) {
        if (!groups.has(provider.id)) groups.set(provider.id, { id: provider.id, name: provider.name, days: [], known: 0 });
        const group = groups.get(provider.id); group.days.push({ date: day.date, ...provider }); if (provider.cost != null) group.known += Number(provider.cost);
      }
      return [...groups.values()].map(row => ({ ...row, complete: !missingScope && row.days.every(day => day.complete && day.cost != null) }));
    }
    function renderProviders() {
      q('[data-provider-summary]').innerHTML = table(['供应商', '实际消费 CNY', '完整 / 纳入天数', '操作'], providerRows().map(row => [e(row.name), `${e(money(row.complete ? row.known : null))}${!row.complete ? `<small>已取得 ${e(money(row.known))}</small>` : ''}`, `${row.days.filter(day => day.complete).length} / ${row.days.length}`, `${button('data-provider', row.id)} · ${button('data-provider-entry', row.id, '记支出')}`])); readyIcons();
    }
    function renderCash() {
      const r = state.report, s = r.summary;
      q('[data-cash-range]').textContent = `${r.range.start} 至 ${r.range.end} · 人民币（元）`;
      q('[data-cash-metrics]').innerHTML = metric('本期收入', s.income, '人民币', 'income') + metric('本期支出', s.expense, '人民币', 'expense') + metric('净现金流', s.net, '收入 − 支出 · 人民币', 'net');
      const c = r.cumulative;
      const since = `${c.from} 起`;
      q('[data-cash-history]').innerHTML = metric('历史收入', c.income, `${since} · 人民币`, 'historyIncome') + metric('历史支出', c.expense, `${since} · 人民币`, 'historyExpense') + metric('当前用户余额', c.userBalance, '不含 ID 1 及已删除用户', 'userBalance') + metric('累计净结余', c.net, `${since} · 不随筛选变化`, 'cumulative');
      q('[data-cash-meta]').textContent = `自动收入 ${r.source.complete ? money(s.automatic) : '暂不可用'} · 手工收入 ${money(s.manual)} 元 · ${r.recordCount} 条期间记录`;
      const notices = [...new Set([...r.notices, ...c.notices])];
      q('[data-notice]').hidden = !notices.length; q('[data-notice]').textContent = notices.join('；');
      const form = q('[data-cash-search]'); form.elements.search.value = state.search; form.elements.direction.value = state.direction; form.elements.origin.value = state.origin;
      q('[data-filter-total]').textContent = `列表筛选 ${r.pagination.total} 条 · 收入 ${money(r.filteredSummary.income)} / 支出 ${money(r.filteredSummary.expense)} 元`;
      q('[data-cash-rows]').innerHTML = r.items.length ? r.items.map(row => `<tr${row.key === state.savedKey ? ' class="accounting-saved"' : ''}><td>${e(row.date)}</td><td><strong>${e(row.name)}</strong><small>${e(row.sourceRef || row.key)}</small></td><td>${row.direction === 'income' ? '收入' : '支出'}</td><td>${row.source === 'automatic' ? '自动入账' : row.legacy ? '历史记录' : '手工记录'}</td><td>${e(row.providerName || (row.userId ? `用户 #${row.userId}` : '-'))}</td><td class="numeric">${e(money(row.amount))} 元</td><td>${row.counted ? '已统计' : e(row.mergeReason)}</td><td>${button('data-record', row.key)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty-state">所选范围暂无收支记录</td></tr>';
      state.cashPage = r.pagination.page; pageState('cash', r.pagination);
      renderChart('accounting-cash-chart', r.periods, [['income', '现金收入', '#176b4d'], ['expense', '现金支出', '#b05a3c'], ['net', '净现金流', '#2d5ea8']], '元'); readyIcons();
      if (state.locateSaved) { q('.accounting-saved')?.scrollIntoView({ block: 'nearest' }); state.locateSaved = false; }
    }
    function schedule(delay = 60000) {
      clearTimeout(state.timer); if (!state.active || !h.isActive() || document.hidden) return;
      state.timer = setTimeout(() => { if (!state.active || !h.isActive()) return; if (q('[data-dialog]').open) { schedule(); return; } load({ poll: delay < 60000 }).catch(() => schedule()); }, delay);
    }
    async function load({ refresh = false, poll = false } = {}) {
      state.active = true; clearTimeout(state.timer); const request = ++state.request, automatic = state.tab === 'automatic';
      if (poll && Date.now() - (state.liveRefreshedAt || 0) >= 60000) poll = false;
      if (automatic && !poll) state.liveRefreshedAt = Date.now();
      const query = { ...h.query(), ...(refresh ? { refresh: '1' } : {}), ...(poll ? { poll: '1' } : {}) };
      const auxKey = new URLSearchParams(h.query()).toString();
      if (automatic && (!poll || state.auxKey !== auxKey || Date.now() - (state.auxAt || 0) >= 60000)) {
        state.auxKey = auxKey; state.auxAt = Date.now();
        state.credits = undefined; state.balances = undefined; state.upstream = undefined; renderMeta();
        const aux = (key, url) => h.api(url).catch(() => null).then(value => { if (state.active && request === state.request && state.tab === 'automatic') { state[key] = value; renderMeta(); } });
        aux('credits', `/api/cost-analysis/automatic-income/users?${new URLSearchParams(query)}&pageSize=1`);
        aux('balances', `${base}/balances?pageSize=1${refresh ? '&refresh=1' : ''}`); aux('upstream', `${base}/provider-balances${refresh ? '?refresh=1' : ''}`);
      }
      const params = automatic ? { ...query, live: '0' } : { ...query, currency: 'CNY', page: state.cashPage, pageSize: 20, search: state.search, direction: state.direction, origin: state.origin };
      const showReport = report => {
        state.report = { ...report, automatic }; automatic ? renderAutomatic() : renderCash();
        h.setPageMeta(`${report.range.start} 至 ${report.range.end} · ${automatic ? `${report.summary.completeDays}/${report.summary.days} 天完整 · ` : ''}${report.timezone}`);
      };
      try {
        let report = await h.api(`${automatic ? '/api/cost-analysis/daily-profit' : `${base}/report`}?${new URLSearchParams(params)}`);
        if (request !== state.request || !state.active || automatic !== (state.tab === 'automatic')) return;
        showReport(report);
        if (automatic && report.live?.included && !poll) {
          // Render archived dates before waiting for the independent current-day read.
          report = await h.api(`/api/cost-analysis/daily-profit?${new URLSearchParams(query)}`);
          if (request !== state.request || !state.active || state.tab !== 'automatic') return;
          showReport(report);
          const day = q('[data-open-day]')?.dataset.openDay;
          if (q('[data-dialog]').open && day) dayDetail(day);
        }
        schedule(automatic && report.archive?.pendingDays && report.archive.ready ? 5000 : 60000);
      } catch (error) { if (request !== state.request || !state.active) return; q('[data-notice]').hidden = false; q('[data-notice]').textContent = `${error.message}，稍后自动重试`; schedule(); throw error; }
    }
    function leave() { state.active = false; ++state.request; ++state.dialogRequest; clearTimeout(state.timer); if (q('[data-dialog]').open) q('[data-dialog]').close(); }
    async function changeTab(tab) {
      if (!['automatic', 'cash'].includes(tab)) return; state.tab = tab; state.report = null;
      for (const key of ['automatic', 'cash']) { q(`[data-tab="${key}"]`).setAttribute('aria-selected', String(key === tab)); q(`[data-tab="${key}"]`).tabIndex = key === tab ? 0 : -1; q(`#accounting-${key}`).hidden = key !== tab; }
      q('[data-notice]').hidden = true; await load(); h.resizeCharts();
    }
    function dayDetail(date) {
      const row = state.report.items.find(row => row.date === date); if (!row) return;
      const notices = [...new Set([...(row.notices || []), ...(row.lastAttempt?.errorCode ? row.lastAttempt.notices : [])])];
      drawer(`${date} · 消费与毛利`, `<div data-open-day="${e(date)}">${table(['项目', 'CNY'], [['主站消费', money(row.siteConsumption)], ['供应商消费', money(row.supplierConsumption)], ['消费毛利', money(row.profit)], ['毛利率', pct(row.margin)]])}<h3>供应商账号消费</h3>${table(['供应商', 'CNY', '数据状态', '操作'], (row.providers || []).map(provider => [e(provider.name), money(provider.cost), e(provider.complete ? '数据完整' : (provider.reasons || ['自动重试']).join('；')), iconButton('data-provider-refresh', provider.id, 'refresh-cw', `刷新 ${provider.name} 消费`, `cost-provider-refresh" data-provider-date="${e(date)}`)]))}<p class="muted">${row.mode === 'live' ? '今日实时' : '历史归档'} · ${e(row.computedAt ? h.formatDateTime(row.computedAt) : '等待同步')}</p>${row.complete && row.lastAttempt?.errorCode ? '<p class="muted">更新失败，保留最后一次完整归档，后台自动重试。</p>' : ''}${notices.length ? `<details><summary>来源状态</summary>${notices.map(text => `<p>${e(text)}</p>`).join('')}</details>` : ''}</div>`);
    }
    async function refreshProvider(date, providerId, node) {
      if (state.providerRefresh) return;
      state.providerRefresh = true;
      node.disabled = true; node.setAttribute('aria-busy', 'true'); node.classList.add('is-loading');
      try {
        await h.api('/api/cost-analysis/daily-profit/provider-refresh', {
          method: 'POST', body: JSON.stringify({ date, providerId })
        });
        if (!state.active || !h.isActive()) return;
        h.toast('供应商消费已刷新', 'success');
        await load({ poll: true });
        if (state.active && q('[data-dialog]').open) dayDetail(date);
      } finally {
        state.providerRefresh = false;
        if (node.isConnected) { node.disabled = false; node.removeAttribute('aria-busy'); node.classList.remove('is-loading'); }
      }
    }
    async function balanceDetail(page = 1, search = '') {
      const request = ++state.dialogRequest, value = await h.api(`${base}/balances?${new URLSearchParams({ page, search, pageSize: 20 })}`);
      if (!state.active || request !== state.dialogRequest) return; state.balancePage = value.pagination.page; state.balanceSearch = search;
      drawer('当前用户余额', `<p>合计 ${e(money(value.userBalance))} CNY</p><p class="muted">不含 ID 1 和已删除用户 · ${e(h.formatDateTime(value.capturedAt))}</p><form class="accounting-search" data-balance-search><label>搜索用户<input type="search" name="search" maxlength="100" value="${e(search)}" placeholder="用户 ID、名称、邮箱"></label><button type="submit" class="icon-button" title="搜索" aria-label="搜索">${h.icon('search')}</button></form>${table(['用户', '当前余额 CNY'], value.items.map(user => [`${e(user.name)}<small>ID ${e(user.id)} · ${e(user.email)}</small>`, money(user.balance)]))}${pager('balance')}`); pageState('balance', value.pagination);
    }
    function cumulativeDetail() {
      const c = state.report.cumulative;
      drawer('累计净结余', table(['组成', '金额（元）'], [['累计入账', money(c.income)], ['累计支出', money(c.expense)], ['当前用户余额（不含 ID 1）', money(c.userBalance)], ['累计净结余', `<strong>${e(money(c.net))}</strong>`]]) + `<p class="muted">${e(c.from)}（含当天）至 ${e(c.to)} · ${e(h.formatDateTime(c.capturedAt))}</p><p class="muted">余额快照 ${e(c.balanceCapturedAt ? h.formatDateTime(c.balanceCapturedAt) : '暂不可用')}</p>${c.notices.map(text => `<p class="accounting-notice">${e(text)}</p>`).join('')}`);
    }
    async function ensureProviders() { try { state.providers = (await h.api('/api/cost-analysis/providers')).items || []; } catch { /* Custom cash entries remain available. */ } }
    async function entryForm(item = null, providerId = '') {
      const request = ++state.dialogRequest; await ensureProviders(); if (!state.active || request !== state.dialogRequest) return;
      state.selectedKey = item?.key || null; state.entryItem = item; state.entryRequestId = crypto.randomUUID();
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: state.report?.timezone || 'Asia/Shanghai' });
      const defaultDate = h.query().end > today ? today : h.query().end;
      const providers = [...state.providers]; if (item?.providerId && !providers.some(row => row.id === item.providerId)) providers.push({ id: item.providerId, name: item.providerName || item.providerId });
      drawer(item ? '修改收支记录' : '记一笔', `<form class="accounting-form" data-entry-form>
        <fieldset class="accounting-direction accounting-wide"><legend>收支</legend>${[['income', '收入'], ['expense', '支出']].map(([key, label]) => `<label><input type="radio" name="direction" value="${key}"${key === (item?.direction || 'expense') ? ' checked' : ''}>${label}</label>`).join('')}</fieldset>
        <label class="accounting-wide" data-expense-type>支出类型<select name="category">${option('provider', '供应商付款', item?.category || 'provider')}${option('custom', '自定义支出', item?.category || 'provider')}</select></label>
        <label class="accounting-wide" data-provider-field>供应商<select name="providerId"><option value="">请选择</option>${providers.map(row => option(row.id, row.name, item?.providerId || providerId)).join('')}</select></label>
        <label class="accounting-wide" data-entry-name hidden>项目<input name="name" maxlength="120" value="${e(item?.name || '')}"></label>
        <label>实际收付日期<input name="date" type="date" required max="${e(today)}" value="${e(item?.date || defaultDate)}"></label><label>金额（人民币元）<input name="amount" type="number" required min="0.01" max="1000000000000" step="0.01" value="${e(item?.amount ?? '')}"></label>
        <label>来源单号（选填）<input name="sourceRef" maxlength="120" value="${e(item?.sourceRef || '')}"></label><label class="accounting-wide">备注（选填）<textarea name="note" maxlength="500">${e(item?.note || '')}</textarea></label>
        <p class="form-error accounting-wide" data-form-error role="alert" hidden></p><div class="form-actions accounting-wide"><button type="submit" class="button primary">${h.icon('save')}<span>保存</span></button><button type="button" class="button secondary" data-close>取消</button></div></form>`); updateFields();
    }
    function updateFields() {
      const form = q('[data-entry-form]'); if (!form) return;
      const expense = form.elements.direction.value === 'expense', provider = expense && form.elements.category.value === 'provider';
      q('[data-expense-type]').hidden = !expense; q('[data-provider-field]').hidden = !provider; form.elements.providerId.required = provider;
      q('[data-entry-name]').hidden = expense; form.elements.name.disabled = expense; form.elements.name.required = !expense;
    }
    async function recordDetail(key) {
      const request = ++state.dialogRequest, value = await h.api(`${base}/records/${encodeURIComponent(key)}`);
      if (!state.active || request !== state.dialogRequest) return; state.selectedItem = value.item; const row = value.item;
      drawer(row.name, table(['项目', '内容'], [['日期', e(row.date)], ['收支', row.direction === 'income' ? '收入' : '支出'], ['金额（元）', e(money(row.amount))], ['来源', row.basis === 'redeem' ? '已使用余额兑换记录' : row.source === 'automatic' ? '主站已付款订单' : row.legacy ? '历史收支' : '手工记账'], ['供应商 / 用户', e(row.providerName || row.userId || '-')], ['来源单号', e(row.sourceRef || row.key)], ['统计状态', row.counted ? '已统计' : e(row.mergeReason)], ['备注', e(row.note || '-')]]) + (row.editable ? `<div class="form-actions"><button type="button" class="button secondary" data-command="edit">${h.icon('pencil')}<span>修改</span></button><button type="button" class="button danger" data-command="delete">${h.icon('trash-2')}<span>删除</span></button></div>` : '') + (value.history.length ? `<details class="accounting-audit"><summary>变更历史</summary>${value.history.map(row => `<p>${e(h.formatDateTime(row.created_at))} · ${e(row.actor)} · ${e(row.reason)}</p><pre>${e(JSON.stringify({ before: row.before_value, after: row.after_value }, null, 2))}</pre>`).join('')}</details>` : ''));
    }
    async function command(action) {
      if (action === 'add') return entryForm(); if (action === 'credits') { leave(); return h.openCredits(); } if (action === 'balance') return balanceDetail();
      if (action === 'upstream') { const u = state.upstream; drawer('当前上游余额', `${table(['供应商', '原币余额', 'CNY 估值', '快照 / 状态'], (u?.items || []).map(row => [e(row.name), e(`${row.available ?? '-'} ${row.currency || ''}`), money(row.cashValue), e(row.complete ? h.formatDateTime(row.capturedAt) : (row.reasons || ['来源缺失']).join('；'))]))}<p class="muted">${u ? e(h.formatDateTime(u.capturedAt)) : '上游余额暂不可用，后台将自动重试'}</p>`); return; }
      if (action === 'edit') return entryForm(state.selectedItem);
      if (action === 'delete') { if (!window.confirm('删除这条收支记录？删除后将更新统计，变更历史仍会保留。')) return; await h.api(`${base}/records/${encodeURIComponent(state.selectedItem.key)}`, { method: 'DELETE' }); q('[data-dialog]').close(); h.toast('收支记录已删除', 'success'); await load(); }
    }
    root.addEventListener('click', event => {
      const node = event.target.closest('button'); if (!node) return;
      const run = async () => {
        if (node.hasAttribute('data-close')) { ++state.dialogRequest; q('[data-dialog]').close(); return; }
        if (node.dataset.tab) return changeTab(node.dataset.tab);
        if (node.dataset.detailTab) { for (const key of ['days', 'providers']) { const active = key === node.dataset.detailTab; q(`[data-detail-tab="${key}"]`).setAttribute('aria-selected', String(active)); q(`[data-detail-tab="${key}"]`).tabIndex = active ? 0 : -1; q(`#cost-detail-${key}`).hidden = !active; } return; }
        if (node.dataset.command) return command(node.dataset.command); if (node.dataset.day) return dayDetail(node.dataset.day);
        if (node.dataset.providerRefresh) return refreshProvider(node.dataset.providerDate, node.dataset.providerRefresh, node);
        if (node.dataset.automaticDayStep) { state.automaticPage += Number(node.dataset.automaticDayStep); return renderAutomaticDays(); }
        if (node.dataset.cashStep) { state.cashPage += Number(node.dataset.cashStep); return load(); }
        if (node.dataset.balanceStep) return balanceDetail(state.balancePage + Number(node.dataset.balanceStep), state.balanceSearch);
        if (node.dataset.record) return recordDetail(node.dataset.record); if (node.dataset.providerEntry) return entryForm(null, node.dataset.providerEntry);
        if (node.dataset.provider) { const row = providerRows().find(row => row.id === node.dataset.provider); if (row) drawer(row.name, table(['日期', '实际消费 CNY', '数据状态', '操作'], row.days.map(day => [e(day.date), money(day.cost), e(day.complete ? '数据完整' : (day.reasons || ['自动重试']).join('；')), button('data-day', day.date)]))); return; }
        if (node.dataset.metric && state.report) { const key = node.dataset.metric;
          if (state.tab === 'cash') {
            if (['cumulative', 'historyIncome', 'historyExpense'].includes(key)) return cumulativeDetail();
            if (key === 'userBalance') return balanceDetail();
            state.direction = key === 'net' ? 'all' : key; state.cashPage = 1; return load();
          }
          const label = { siteConsumption: '主站消费', supplierConsumption: '供应商消费', profit: '消费毛利', margin: '消费毛利率' }[key];
          return drawer(label, table(['日期', key === 'margin' ? '毛利率' : 'CNY', '操作'], state.report.items.map(row => [e(row.date), e(key === 'margin' ? pct(row[key]) : money(row[key])), button('data-day', row.date)])));
        }
      }; run().catch(error => h.toast(error.message, 'error'));
    });
    root.addEventListener('change', event => { if (['direction', 'category'].includes(event.target.name)) updateFields(); });
    root.addEventListener('submit', event => {
      event.preventDefault(); const form = event.target;
      if (form.matches('[data-cash-search]')) { Object.assign(state, Object.fromEntries(new FormData(form)), { cashPage: 1 }); load().catch(error => h.toast(error.message, 'error')); return; }
      if (form.matches('[data-balance-search]')) { balanceDetail(1, form.elements.search.value).catch(error => h.toast(error.message, 'error')); return; }
      if (!form.matches('[data-entry-form]') || state.saving) return;
      const run = async () => {
        state.saving = true; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
        const values = Object.fromEntries(new FormData(form)); values.amount = Number(values.amount); values.currency = 'CNY';
        if (values.direction === 'expense') {
          const previous = state.entryItem, sameExpense = previous?.direction === 'expense' && previous.category === values.category &&
            (values.category !== 'provider' || previous.providerId === values.providerId);
          values.name = sameExpense ? previous.name : values.category === 'provider'
            ? `${form.elements.providerId.selectedOptions[0].textContent} 付款`.slice(0, 120) : '自定义支出';
        }
        if (!state.selectedKey) values.requestId = state.entryRequestId; const selectedKey = state.selectedKey;
        try {
          q('[data-form-error]').hidden = true;
          const result = await h.api(`${base}/records${selectedKey ? `/${encodeURIComponent(selectedKey)}` : ''}`, { method: selectedKey ? 'PUT' : 'POST', body: JSON.stringify(values) });
          if (!state.active || !h.isActive()) return;
          h.focusDate(result.date); state.search = result.key; state.direction = 'all'; state.origin = 'all'; state.cashPage = 1; state.savedKey = result.key; state.locateSaved = true;
          q('[data-dialog]').close(); h.toast('收支记录已保存', 'success'); if (state.tab !== 'cash') await changeTab('cash'); else await load();
        } catch (error) { const node = form.querySelector('[data-form-error]'); if (node?.isConnected) { node.textContent = error.message; node.hidden = false; } else h.toast(error.message, 'error'); }
        finally { state.saving = false; submit.disabled = false; }
      }; run();
    });
    root.addEventListener('keydown', event => {
      const tab = event.target.closest('[role="tab"]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')], index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; tabs[next].click(); tabs[next].focus();
    });
    q('[data-dialog]').addEventListener('cancel', () => { ++state.dialogRequest; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(state.timer); else if (state.active && h.isActive()) schedule(1000); });
    document.getElementById('cost-accounting-add').addEventListener('click', () => { if (state.active) entryForm().catch(error => h.toast(error.message, 'error')); });
    return { load, leave, state };
  }
  return { create };
})();
if (typeof window !== 'undefined') window.CostAccountingUi = CostAccountingUi;
if (typeof module !== 'undefined' && module.exports) module.exports = CostAccountingUi;
