'use strict';

const CostAccountingUi = (() => {
  const kinds = { customer_receipt: '客户充值收款', subscription: '订阅服务', service_income: '其他经营收入',
    fee: '运营费用', provider_prepayment: '供应商充值', gift: '赠送额度', correction: '余额纠错',
    excluded: '排除测试 / 非经营记录', refund_unconsumed: '未消费余额退款', refund_service: '已消费服务退款',
    refund_subscription: '订阅终止退款',
    transfer: '转账 / 提款', reference: '关联已有业务', funding: '已关联收款额度' };
  const categories = { infrastructure: '服务器 / 带宽 / 存储', domain: '域名 / 证书 / 软件', payment: '支付手续费', marketing: '推广 / 佣金', labor: '人工 / 外包', other: '其他' };
  const statusLabels = { complete: '已核验', source_pending: '来源待统计', income_pending: '收入待核验', fee_pending: '费用待分类', supplier_pending: '成本待核验', before_start: '核算起点之前', future: '未发生' };

  function create(h) {
    const root = document.getElementById('cost-accounting-root');
    if (!root) return null;
    const e = h.escapeHtml;
    const q = selector => root.querySelector(selector);
    const state = { tab: 'automatic', report: null, request: 0, timer: null, page: 1, automaticPage: 1, documents: [],
      documentPage: 1, documentTotal: 0, search: '', pendingOnly: false, selectedKey: null, providers: [], active: false };
    const money = value => value == null ? '待核验' : h.formatMoney(value, '', 8);
    const automaticMoney = value => value == null ? '暂不可用' : money(value);
    const pct = value => value == null ? '—' : h.formatPercent(value);
    const base = '/api/cost-analysis/accounting';
    const options = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`).join('');
    root.innerHTML = `
      <div class="accounting-tabs" role="tablist" aria-label="成本分析视图">
        ${[['automatic', '自动统计'], ['business', '精细核算'], ['cash', '现金收支'], ['audit', '余额与核对']].map(([key, label]) => `<button type="button" id="accounting-tab-${key}" role="tab" aria-controls="accounting-${key}" aria-selected="${key === 'automatic'}" tabindex="${key === 'automatic' ? 0 : -1}" data-tab="${key}">${label}</button>`).join('')}
      </div>
      <div data-notice hidden></div>
      <section id="accounting-automatic" role="tabpanel" aria-labelledby="accounting-tab-automatic">
        <div class="accounting-metrics" data-automatic-metrics></div><div class="accounting-aux" data-automatic-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>消费与毛利趋势</h2><span class="muted" data-automatic-range></span></div><div id="accounting-automatic-chart" class="chart" role="img" aria-label="主站消费、供应商实际消费及消费毛利趋势"></div></section>
        <section class="accounting-section"><div class="panel-heading"><h2>每日消费与毛利</h2><span class="muted" data-automatic-day-meta></span></div>
          <div class="table-wrap"><table class="accounting-automatic-table"><thead><tr><th>日期</th><th class="numeric">主站消费</th><th class="numeric">供应商消费</th><th class="numeric">消费毛利</th><th class="numeric">毛利率</th><th class="numeric">主站请求数</th><th>数据状态</th><th>详情</th></tr></thead><tbody data-automatic-days></tbody><tfoot data-automatic-total></tfoot></table></div>
          <div class="accounting-pager"><span data-automatic-day-page></span><div><button class="icon-button" type="button" data-automatic-day-step="-1" title="上一页" aria-label="上一页">${h.icon('chevron-left')}</button><button class="icon-button" type="button" data-automatic-day-step="1" title="下一页" aria-label="下一页">${h.icon('chevron-right')}</button></div></div>
        </section>
      </section>
      <section id="accounting-business" role="tabpanel" aria-labelledby="accounting-tab-business" hidden>
        <div class="accounting-metrics" data-metrics></div><div class="accounting-aux" data-business-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>经营趋势</h2><span class="muted" data-range></span></div><div id="accounting-chart" class="chart" role="img" aria-label="确认收入、供应商实际成本、运营费用及经营利润趋势"></div></section>
        <section class="accounting-section"><div class="panel-heading"><h2>每日经营明细</h2><span class="muted" data-day-meta></span></div>
          <div class="table-wrap"><table class="accounting-day-table"><thead><tr><th>日期</th><th class="numeric">用户消费额度</th><th class="numeric">确认收入</th><th class="numeric">供应商成本</th><th class="numeric">运营费用</th><th class="numeric">经营利润</th><th class="numeric">利润率</th><th>数据状态</th><th>详情</th></tr></thead><tbody data-days></tbody><tfoot data-total></tfoot></table></div>
          <div class="accounting-pager"><span data-day-page></span><div><button class="icon-button" type="button" data-day-step="-1" title="上一页" aria-label="上一页">${h.icon('chevron-left')}</button><button class="icon-button" type="button" data-day-step="1" title="下一页" aria-label="下一页">${h.icon('chevron-right')}</button></div></div>
        </section>
      </section>
      <section id="accounting-cash" role="tabpanel" aria-labelledby="accounting-tab-cash" hidden>
        <div class="accounting-metrics" data-cash-metrics></div><div class="accounting-aux" data-cash-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>收支与额度台账</h2><button type="button" class="button secondary" data-command="finance">${h.icon('external-link')}<span>收款与入账</span></button></div>
          <form class="accounting-search" data-doc-search><label>搜索记录<input name="search" type="search" placeholder="名称、用户 ID、记录 ID"></label><label>业务类型<select name="kind"><option value="">全部</option>${options(kinds)}</select></label><label>状态<select name="pending"><option value="">全部</option><option value="1">待核验</option></select></label><button class="button primary" type="submit">${h.icon('search')}<span>查询</span></button></form>
          <div class="table-wrap"><table class="accounting-ledger-table"><thead><tr><th>日期</th><th>项目 / 来源</th><th>业务类型</th><th>用户 / 供应商</th><th class="numeric">原币金额</th><th class="numeric">CNY 金额</th><th>状态</th><th>操作</th></tr></thead><tbody data-documents></tbody></table></div>
          <div class="accounting-pager"><span data-document-page></span><div><button type="button" class="icon-button" title="上一页" aria-label="上一页" data-document-step="-1">${h.icon('chevron-left')}</button><button type="button" class="icon-button" title="下一页" aria-label="下一页" data-document-step="1">${h.icon('chevron-right')}</button></div></div>
        </section>
      </section>
      <section id="accounting-audit" role="tabpanel" aria-labelledby="accounting-tab-audit" hidden>
        <div class="accounting-metrics" data-balance-metrics></div><div class="accounting-aux" data-balance-meta></div>
        <section class="accounting-section"><div class="panel-heading"><h2>待核对事项</h2><button type="button" class="button secondary" data-command="pending">${h.icon('list-filter')}<span>全部待分类记录</span></button></div><div data-issues></div></section>
        <section class="accounting-section"><div class="panel-heading"><h2>期间余额核对</h2></div><div data-balance-history></div></section>
        <section class="accounting-section"><div class="panel-heading"><h2>用户期初余额</h2><button type="button" class="button secondary" data-command="opening">${h.icon('plus')}<span>补录期初</span></button></div><form class="accounting-search" data-user-search><label>搜索用户<input type="search" name="search" placeholder="用户 ID 或用户名"></label><button class="button secondary" type="submit">${h.icon('search')}<span>搜索</span></button></form><div class="table-wrap"><table><thead><tr><th>用户</th><th class="numeric">当前余额</th><th>期初状态</th><th>操作</th></tr></thead><tbody data-users></tbody></table></div><div class="accounting-pager"><span data-user-page></span><div><button class="icon-button" type="button" title="上一页" aria-label="上一页" data-user-step="-1">${h.icon('chevron-left')}</button><button class="icon-button" type="button" title="下一页" aria-label="下一页" data-user-step="1">${h.icon('chevron-right')}</button></div></div></section>
      </section>
      <details class="accounting-rules"><summary>统计口径与核算设置</summary><div class="accounting-aux accounting-policy" data-policy></div>
        <p>自动统计直接读取非 ID 1 用户的主站实际消费与启用供应商账号日消费，消费毛利 = 主站消费 − 供应商实际消费，毛利率以主站消费为分母。充值额度及当前余额单独展示，不重复计入毛利；手工支出不与上游消费叠加。该口径包含赠送和订阅产生的主站计费额度，不等同现金实收利润。</p>
        <p>确认收入按付费额度的实收价值、订阅服务期间及其他已交付服务计算。付费与赠送额度按每日加权平均分配；充值收款不与消费收入相加。上游充值仅列现金支出，上游实际消费计成本。用户消费不含 ID 1，管理员产生的上游成本保留。历史记录及已删除用户的经营数据保留。</p>
        <p>金额缺失显示待核验；已核验日期小计不代表整期利润。上游余额按快照时已确认倍率与汇率折算，为当前估值。当前余额独立展示，不参与本期利润扣减。</p>
      </details>
      <dialog class="accounting-dialog" data-dialog aria-labelledby="accounting-drawer-title"><div class="accounting-drawer-header"><h2 id="accounting-drawer-title"></h2><button type="button" class="icon-button" data-close title="关闭" aria-label="关闭">${h.icon('x')}</button></div><div class="accounting-drawer-body" data-drawer></div></dialog>`;

    function metric(label, value, hint, action, formatter = money) {
      return `<button type="button" class="accounting-metric" data-metric="${action}"><span>${label}</span><strong class="${value != null && value < 0 ? 'negative-value' : ''}">${e(formatter(value))}</strong><small>${e(hint)}</small></button>`;
    }
    function table(headers, rows) {
      return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${e(header)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty-state">暂无数据</td></tr>`}</tbody></table></div>`;
    }
    function drawer(title, body) {
      q('#accounting-drawer-title').textContent = title; q('[data-drawer]').innerHTML = body;
      if (!q('[data-dialog]').open) q('[data-dialog]').showModal();
      q('[data-dialog]').scrollTop = 0; h.refreshIcons();
    }
    async function changeTab(tab, { reload = true } = {}) {
      const previous = state.tab;
      state.tab = tab;
      ['automatic', 'business', 'cash', 'audit'].forEach(key => { q(`[data-tab="${key}"]`).setAttribute('aria-selected', String(tab === key)); q(`[data-tab="${key}"]`).tabIndex = tab === key ? 0 : -1; q(`#accounting-${key}`).hidden = key !== tab; });
      if (!reload) return;
      if (!state.report || (tab === 'automatic') !== (previous === 'automatic') || (tab === 'automatic') !== Boolean(state.report.automatic)) { q('[data-notice]').hidden = true; await load(); }
      else if (tab === 'cash') await loadDocuments();
      if (tab === 'business' || tab === 'automatic') h.resizeCharts();
    }
    function render() {
      const report = state.report; if (!report) return;
      if (report.automatic) { renderAutomatic(); return; }
      const s = report.summary;
      q('[data-metrics]').innerHTML = metric('本期确认收入', s.revenue, '付费余额消费 / 订阅 / 已履约收入', 'revenue') + metric('供应商实际成本', s.supplierCost, '启用供应商账号日汇总', 'supplier') + metric('其他运营费用', s.fee, '按费用所属期间分摊', 'fee') + metric('本期经营利润', s.profit, `经营利润率 ${pct(s.margin)}`, 'profit');
      q('[data-business-meta]').innerHTML = `<span>用户消费额度 ${e(money(s.siteConsumption))}</span><span>服务毛利 ${e(money(s.grossProfit))}</span><button type="button" class="accounting-link" data-command="audit">${s.completeDays}/${s.days} 天已核验</button>`;
      q('[data-range]').textContent = `${report.range.start} 至 ${report.range.end} · CNY`;
      q('[data-day-meta]').textContent = `${report.timezone} · 历史归档 / 当日实时`;
      const c = report.cash;
      q('[data-cash-metrics]').innerHTML = metric('确认实收', c.receipts, c.complete ? '同笔收款仅计一次' : `有 ${c.pending} 条记录待核验`, 'receipts') + metric('实际退款', c.refunds, '按实际退款金额核对', 'refunds') + metric('现金支出', c.payments, '含上游充值及实际付款', 'payments') + metric('净现金流', c.net, '实收 − 退款 − 现金支出', 'cash');
      q('[data-cash-meta]').innerHTML = `<button type="button" class="accounting-link" data-command="credits">自动额度入账 ${e(money(c.credit))} · 用户复核</button><span>${c.pending} 条待核验</span>`;
      const b = report.balances;
      q('[data-balance-metrics]').innerHTML = metric('当前用户余额', b.userBalance, '现有用户 · 不含 ID 1', 'users') + metric('当前上游预付余额', b.providerBalance, '账号余额折算估值', 'balances') + metric('删除账户残留余额', b.deletedBalance, '独立核对履约 / 退款', 'deleted') + metric('待核对事项', report.issueCount, '查看来源、分类与覆盖缺口', 'audit', value => String(value));
      q('[data-balance-meta]').textContent = `当前快照 ${b.capturedAt ? h.formatDateTime(b.capturedAt, report.timezone) : '不可用'} · 不随日期筛选回溯`;
      q('[data-issues]').innerHTML = report.issues.length ? report.issues.map((issue, index) => `<div class="accounting-issue"><div><strong>${e(issue.message)}</strong><small>${e([issue.date, issue.userName || issue.userId, issue.documentKey].filter(Boolean).join(' · '))}</small></div><button type="button" class="button secondary" data-issue="${index}">核对</button></div>`).join('') : '<p class="muted">所选核算范围暂无待核对事项</p>';
      q('[data-balance-history]').innerHTML = '<p class="muted">没有完整的历史时点快照，暂不展示历史期初 / 期末余额。</p>';
      q('[data-policy]').innerHTML = `<span>核算起点 ${e(report.policy.startDate)}</span><span>每日加权平均 · 规则 v${report.policy.version}</span><button type="button" class="accounting-link" data-command="policy">修改起点</button><button type="button" class="accounting-link" data-command="refresh">重算所选范围</button>`;
      const notice = q('[data-notice]'); notice.hidden = !report.issueCount && !report.archive?.pendingDays && s.completeDays === s.days;
      notice.className = 'accounting-notice'; notice.innerHTML = `<span>${report.archive?.pendingDays ? `${report.archive.pendingDays} 天日报等待后台统计。` : ''}${report.issueCount ? `${report.issueCount} 项待核验，完整利润暂不确定。` : s.completeDays !== s.days ? '部分日期尚无完整核算依据，请核对核算起点及来源。' : ''}</span><button class="accounting-link" type="button" data-command="audit">查看问题</button>`;
      renderDays(); renderUsers(); renderChart(); h.refreshIcons();
    }
    function renderAutomatic() {
      const report = state.report, s = report.summary;
      q('[data-automatic-metrics]').innerHTML = metric('主站消费', s.siteConsumption, '用户实际消费 · 不含 ID 1', 'siteConsumption', automaticMoney) + metric('供应商实际消费', s.supplierConsumption, '启用供应商账号日汇总', 'supplierConsumption', automaticMoney) + metric('消费毛利', s.profit, '主站消费 − 供应商实际消费', 'profit', automaticMoney) + metric('消费毛利率', s.margin, `${s.completeDays}/${s.days} 天数据完整`, 'margin', pct);
      renderAutomaticMeta();
      q('[data-automatic-range]').textContent = `${report.range.start} 至 ${report.range.end} · CNY`;
      q('[data-automatic-day-meta]').textContent = '历史归档 / 当日实时';
      q('[data-policy]').innerHTML = '<span>自动统计按所选日期读取，无需核验期初或逐笔分类。</span>';
      const notice = q('[data-notice]'); notice.hidden = s.completeDays === s.days && !report.archive?.pendingDays;
      notice.className = 'accounting-notice'; notice.innerHTML = `<span>${report.archive?.pendingDays ? `${report.archive.pendingDays} 天历史数据正在后台统计或重试。` : ''}${s.completeDays !== s.days ? '部分消费数据暂不完整，对应日期的毛利留空。' : ''}</span>`;
      renderAutomaticDays();
      renderChart('accounting-automatic-chart', [['siteConsumption', '主站消费', '#176b4d'], ['supplierConsumption', '供应商消费', '#b05a3c'], ['profit', '消费毛利', '#2d5ea8']]);
      h.refreshIcons();
    }
    function renderAutomaticMeta() {
      const meta = state.automaticMeta?.summary;
      const format = value => value == null && state.automaticMetaLoading ? '读取中' : automaticMoney(value);
      q('[data-automatic-meta]').innerHTML = `<button type="button" class="accounting-link" data-command="credits">本期充值额度 ${e(format(meta?.automaticRevenue))} · 用户明细</button><button type="button" class="accounting-link" data-command="automatic-balance">当前用户余额 ${e(format(meta?.userBalance))}</button><span>${e(state.report.timezone)} · CNY</span>`;
    }
    function renderAutomaticDays() {
      const report = state.report, size = 15, pages = Math.max(1, Math.ceil(report.items.length / size));
      state.automaticPage = Math.max(1, Math.min(state.automaticPage, pages));
      const labels = { complete: '数据完整', site_incomplete: '用量缺失', supplier_incomplete: '成本缺失', future: '未发生', pending_archive: '待统计', archive_failed: '统计失败', live_failed: '读取失败' };
      q('[data-automatic-days]').innerHTML = report.items.slice((state.automaticPage - 1) * size, state.automaticPage * size).map(row => `<tr><td><strong>${e(row.date)}</strong></td>${['siteConsumption', 'supplierConsumption', 'profit'].map(key => `<td class="numeric${row[key] < 0 ? ' negative-value' : ''}">${e(automaticMoney(row[key]))}</td>`).join('')}<td class="numeric">${pct(row.margin)}</td><td class="numeric">${row.siteRequests == null ? '—' : e(row.siteRequests)}</td><td><span class="badge ${row.complete ? 'success' : 'warning'}">${e(labels[row.status] || '数据不完整')}</span><small>${row.mode === 'live' ? '今日实时' : row.mode === 'archived' ? '已归档' : '待统计'}${row.archiveStatus ? ' · 补算中' : ''}</small></td><td><button type="button" class="accounting-link" data-automatic-day="${e(row.date)}">详情</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">所选范围暂无数据</td></tr>';
      const s = report.summary;
      q('[data-automatic-total]').innerHTML = `<tr><th>期间合计</th>${['siteConsumption', 'supplierConsumption', 'profit'].map(key => `<td class="numeric">${e(automaticMoney(s[key]))}</td>`).join('')}<td class="numeric">${pct(s.margin)}</td><td colspan="3">${s.completeDays}/${s.days} 天数据完整</td></tr>`;
      q('[data-automatic-day-page]').textContent = `第 ${state.automaticPage} / ${pages} 页 · ${report.items.length} 天`;
      q('[data-automatic-day-step="-1"]').disabled = state.automaticPage <= 1; q('[data-automatic-day-step="1"]').disabled = state.automaticPage >= pages;
    }
    function renderDays() {
      const report = state.report; const size = 15; const totalPages = Math.max(1, Math.ceil(report.items.length / size));
      state.page = Math.min(state.page, totalPages);
      const rows = report.items.slice((state.page - 1) * size, state.page * size);
      q('[data-days]').innerHTML = rows.map(row => `<tr><td><strong>${e(row.date)}</strong></td>${['siteConsumption', 'revenue', 'supplierCost', 'fee', 'profit'].map(key => `<td class="numeric${row[key] < 0 ? ' negative-value' : ''}">${e(money(row[key]))}</td>`).join('')}<td class="numeric">${pct(row.margin)}</td><td><span class="badge ${row.complete ? 'success' : 'warning'}">${e(statusLabels[row.status] || '待核验')}</span><small>${row.mode === 'live' ? '今日实时' : row.mode === 'archived' ? '已归档' : '待统计'}${row.archiveStatus ? ' · 补算中' : ''}</small></td><td><button class="accounting-link" type="button" data-day="${e(row.date)}">详情</button></td></tr>`).join('');
      const s = report.summary;
      q('[data-total]').innerHTML = `<tr><th>期间合计</th>${['siteConsumption', 'revenue', 'supplierCost', 'fee', 'profit'].map(key => `<td class="numeric">${e(money(s[key]))}</td>`).join('')}<td class="numeric">${pct(s.margin)}</td><td colspan="2">${s.completeDays}/${s.days} 天已核验</td></tr>${s.completeDays !== s.days && s.completeDays ? `<tr><th>已核验日期小计</th>${['siteConsumption', 'revenue', 'supplierCost', 'fee', 'profit'].map(key => `<td class="numeric">${e(money(report.verifiedSubtotal[key]))}</td>`).join('')}<td class="numeric">${pct(report.verifiedSubtotal.margin)}</td><td colspan="2">仅 ${s.completeDays} 天</td></tr>` : ''}`;
      q('[data-day-page]').textContent = `第 ${state.page} / ${totalPages} 页 · ${report.items.length} 天`;
      q('[data-day-step="-1"]').disabled = state.page <= 1; q('[data-day-step="1"]').disabled = state.page >= totalPages;
    }
    function renderChart(id = 'accounting-chart', fields = [['revenue', '确认收入', '#176b4d'], ['supplierCost', '供应商成本', '#b05a3c'], ['profit', '经营利润', '#2d5ea8'], ['fee', '运营费用', '#69716b']]) {
      h.chart(id, { legend: { type: 'scroll', top: 0, bottom: 'auto', left: 0, right: 0, data: fields.map(field => field[1]), selected: { '运营费用': false } },
        grid: { left: 12, right: 12, top: 58, bottom: 16, containLabel: true },
        tooltip: { trigger: 'axis', confine: true, valueFormatter: id === 'accounting-automatic-chart' ? automaticMoney : money },
        xAxis: { type: 'category', data: state.report.periods.map(period => period.label), axisLabel: { hideOverlap: true } },
        yAxis: { type: 'value', name: 'CNY' }, series: fields.map(([key, name, color]) => ({ name, type: 'line', connectNulls: false, showSymbol: false, data: state.report.periods.map(period => period[key]), lineStyle: { color, width: 2 }, itemStyle: { color } })) });
    }
    function renderUsers() {
      const term = (q('[data-user-search]').elements.search.value || '').toLowerCase();
      const users = state.report.balances.users.filter(user => `${user.name} ${user.id}`.toLowerCase().includes(term));
      const size = 20, pages = Math.max(1, Math.ceil(users.length / size)); state.userPage = Math.max(1, Math.min(pages, state.userPage || 1));
      q('[data-users]').innerHTML = users.slice((state.userPage - 1) * size, state.userPage * size).map(user => `<tr><td>${e(user.name)}<small class="muted">ID ${e(user.id)}${user.deleted ? ' · 已删除' : ''}</small></td><td class="numeric">${e(money(user.balance))}</td><td>${user.opening?.asOf === state.report.policy.startDate ? '已确认' : '待确认 / 新用户零期初'}</td><td><button type="button" class="accounting-link" data-opening="${e(user.id)}">核对期初</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">没有匹配用户</td></tr>';
      q('[data-user-page]').textContent = `第 ${state.userPage} / ${pages} 页 · ${users.length} 位用户`;
      q('[data-user-step="-1"]').disabled = state.userPage <= 1; q('[data-user-step="1"]').disabled = state.userPage >= pages;
    }
    async function loadDocuments() {
      const request = state.documentRequest = (state.documentRequest || 0) + 1;
      const form = q('[data-doc-search]');
      const params = new URLSearchParams({ ...h.query(), page: state.documentPage, pageSize: 20, search: form.elements.search.value, kind: form.elements.kind.value, pending: form.elements.pending.value });
      const result = await h.api(`${base}/documents?${params}`);
      if (request !== state.documentRequest || !state.active) return;
      state.documents = result.items; state.documentTotal = result.pagination.total;
      q('[data-documents]').innerHTML = result.items.map(item => `<tr><td>${e(item.date)}</td><td>${e(item.name)}<small>${e(item.key)}</small></td><td>${e(kinds[item.kind] || '待分类')}</td><td>${e(item.userId || item.providerId || '—')}</td><td class="numeric">${item.amount == null ? '—' : e(`${item.amount} ${item.currency || '待核对'}`)}</td><td class="numeric">${e(money(item.cash))}</td><td><span class="badge ${item.pending ? 'warning' : 'success'}">${item.pending ? '待核验' : '已确认'}</span></td><td><button type="button" class="accounting-link" data-document="${e(item.key)}">详情 / 分类</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">所选范围暂无记录</td></tr>';
      const p = result.pagination; q('[data-document-page]').textContent = `第 ${p.page} / ${Math.max(1, p.totalPages)} 页 · ${p.total} 条`;
      q('[data-document-step="-1"]').disabled = p.page <= 1; q('[data-document-step="1"]').disabled = p.page >= p.totalPages;
    }
    async function load({ refresh = false, poll = false } = {}) {
      state.active = true; const request = ++state.request; clearTimeout(state.timer);
      state.polls = poll ? (state.polls || 0) + 1 : 0;
      const query = { ...h.query(), ...(refresh ? { refresh: '1' } : {}), ...(poll ? { poll: '1' } : {}) };
      const automatic = state.tab === 'automatic';
      const endpoint = automatic ? '/api/cost-analysis/daily-profit' : `${base}/report`;
      const metaKey = new URLSearchParams(h.query()).toString();
      const reuseMetadata = poll && state.automaticMetaKey === metaKey;
      const metadata = automatic ? reuseMetadata ? Promise.resolve(state.automaticMeta) : h.api(`/api/cost-analysis?${metaKey}&include_consumption=0`).catch(() => null) : Promise.resolve(null);
      const report = await h.api(`${endpoint}?${new URLSearchParams(query)}`).catch(error => { if (request === state.request) throw error; return null; });
      if (!report || request !== state.request || !state.active) return;
      report.automatic = automatic;
      if (automatic) { if (!reuseMetadata) state.automaticMeta = null; state.automaticMetaLoading = !reuseMetadata; state.automaticMetaKey = metaKey; }
      state.report = report; render();
      if (automatic) metadata.then(meta => {
        if (request !== state.request || !state.active || !state.report.automatic) return;
        state.automaticMeta = meta; state.automaticMetaLoading = false; renderAutomaticMeta();
      });
      h.setPageMeta(`${report.range.start} 至 ${report.range.end} · ${report.summary.completeDays}/${report.summary.days} 天${automatic ? '数据完整' : '已核验'} · ${report.timezone}`);
      if (state.tab === 'cash') await loadDocuments();
      if (report.archive?.pendingDays && report.archive.ready && h.isActive() && state.polls < 120) state.timer = setTimeout(() => { if (h.isActive()) load({ poll: true }).catch(error => h.toast(error.message, 'error')); }, 5000);
    }
    function leave() { state.active = false; ++state.request; ++state.documentRequest; clearTimeout(state.timer); if (q('[data-dialog]').open) q('[data-dialog]').close(); }
    async function editDocument(key) {
      const request = state.editRequest = (state.editRequest || 0) + 1;
      await ensureProviders();
      const result = await h.api(`${base}/documents/${encodeURIComponent(key)}`);
      if (!state.active || request !== state.editRequest) return;
      entryForm(result.item, result.history);
    }
    function entryForm(item = null, history = []) {
      state.selectedKey = item?.key || null;
      const date = item?.date || h.query().end;
      let defaultKind = item?.kind || (item?.origin === 'redeem' ? 'customer_receipt' : item?.origin === 'refund' ? 'refund_unconsumed' : item?.origin === 'legacy_expense' ? 'fee' : 'fee');
      if (defaultKind === 'funding') defaultKind = '';
      const allowed = item?.origin === 'payment' ? ['customer_receipt', 'subscription', 'gift', 'excluded'] : item?.origin === 'redeem' ? ['customer_receipt', 'gift', 'correction', 'excluded'] : item?.origin === 'refund' ? ['refund_unconsumed', 'refund_service', 'refund_subscription', 'excluded', 'reference'] : Object.keys(kinds).filter(kind => kind !== 'funding');
      if (item?.origin === 'redeem' && item.payments?.length) allowed.splice(allowed.indexOf('customer_receipt'), 1);
      const providerOptions = state.providers.map(provider => `<option value="${e(provider.id)}"${provider.id === item?.providerId ? ' selected' : ''}>${e(provider.name)}</option>`).join('');
      const immutable = item && ['payment', 'redeem', 'refund'].includes(item.origin);
      state.entryRequestId = crypto.randomUUID();
      drawer(item ? `${item.name} · 核对` : '记一笔', `${item ? `<p class="muted">${e(item.key)}${item.userId ? ` · 用户 ${e(item.userId)}` : ''}${item.quantity != null ? ` · 原始额度 ${e(item.quantity)}` : ''}</p>` : ''}<form class="accounting-form" data-entry-form>
        <label class="accounting-wide">业务类型<select name="kind" required><option value="">请选择业务类型</option>${options(Object.fromEntries(allowed.map(key => [key, kinds[key]])), defaultKind)}</select></label>
        <label class="accounting-wide">项目名称<input name="name" maxlength="120" value="${e(item?.name || '')}" required${item ? ' readonly' : ''}></label>
        <label>发生 / 付款日期<input name="date" type="date" value="${e(date)}" required${immutable ? ' readonly' : ''}></label>
        <label>实际现金金额<input name="amount" type="number" min="0" max="1000000000000" step="0.01" value="${e(item?.amount ?? '')}"></label>
        <label>币种<input name="currency" maxlength="12" value="${e(item?.currency || 'CNY')}" required></label>
        <label>1 单位原币兑换 CNY<input name="rate" type="number" min="0.00000001" max="100000000" step="0.00000001" value="${e(item?.rate || 1)}" required></label>
        <label data-field="user">用户 ID<input name="userId" inputmode="numeric" value="${e(item?.userId || '')}"${immutable && item?.userId ? ' readonly' : ''}></label>
        <label data-field="quantity">额度数量（非现金）<input name="quantity" type="number" step="0.00000001" value="${e(item?.quantity ?? '')}"${item?.origin === 'redeem' ? ' readonly' : ''}></label>
        <label data-field="correction" class="accounting-wide">待确认实收价值调整（CNY，可为负）<input name="cashAdjustment" type="number" step="0.00000001" value="${e(item?.cashAdjustment || 0)}"></label>
        <label class="accounting-wide" data-field="provider">供应商<select name="providerId"><option value="">请选择</option>${providerOptions}</select></label>
        <label class="accounting-wide" data-field="category">费用分类<select name="category">${options(categories, item?.category || 'other')}</select></label>
        <label data-field="period">所属 / 服务开始日期<input name="serviceStart" type="date" value="${e(item?.serviceStart || item?.completedAt || date)}"></label>
        <label data-field="period">所属 / 服务结束日期<input name="serviceEnd" type="date" value="${e(item?.serviceEnd || date)}"></label>
        <label class="accounting-wide" data-field="link">关联来源 ID<input name="linkedKey" value="${e(item?.linkedKey || '')}" placeholder="redeem:123 或 payment:123"></label>
        <label class="accounting-wide" data-field="original">原收款记录 ID<input name="relatedKey" value="${e(item?.relatedKey || item?.linkedPayment || '')}" placeholder="payment:123 或 manual:…"></label>
        <label data-field="cancel">停止提供服务日期<input name="cancelDate" type="date" value="${e(item?.cancelDate || date)}"></label>
        <label data-field="cancel">其中已履约退款（CNY）<input name="refundEarned" type="number" min="0" step="0.00000001" value="${e(item?.refundEarned ?? 0)}"></label>
        <label class="checkbox-field accounting-wide"><input type="checkbox" name="paid"${item?.paid !== false ? ' checked' : ''}>已实际收款 / 付款</label>
        <label class="accounting-wide">凭证 / 分类原因<textarea name="reason" maxlength="500" required>${e(item?.reason || '')}</textarea></label>
        <p class="form-error accounting-wide" data-form-error role="alert" hidden></p>
        <div class="form-actions accounting-wide"><button type="submit" class="button primary">${h.icon('save')}<span>保存核算</span></button><button type="button" class="button secondary" data-close>取消</button></div>
      </form>${item?.payments?.length ? `<h3>关联线上收款</h3>${item.payments.map(payment => `<p><button type="button" class="accounting-link" data-document="payment:${e(payment.id)}">核对支付订单 #${e(payment.id)}</button></p>`).join('')}` : ''}${history.length ? `<h3>变更审计</h3>${history.map(record => `<details class="accounting-audit"><summary>${e(h.formatDateTime(record.created_at))} · ${e(record.actor)} · ${e(record.reason)}</summary><pre>${e(JSON.stringify({ before: record.before_value, after: record.after_value }, null, 2))}</pre></details>`).join('')}` : ''}`);
      updateFields();
    }
    function updateFields() {
      const form = q('[data-entry-form]'); if (!form) return;
      const kind = form.elements.kind.value;
      root.querySelectorAll('[data-field="period"]').forEach(node => { node.hidden = !['fee', 'service_income', 'subscription'].includes(kind); });
      q('[data-field="provider"]').hidden = kind !== 'provider_prepayment';
      q('[data-field="category"]').hidden = kind !== 'fee';
      q('[data-field="correction"]').hidden = kind !== 'correction';
      q('[data-field="link"]').hidden = !['customer_receipt', 'reference', 'refund_unconsumed'].includes(kind);
      q('[data-field="original"]').hidden = !kind.startsWith('refund_');
      root.querySelectorAll('[data-field="cancel"]').forEach(node => { node.hidden = kind !== 'refund_subscription'; });
      const quantity = ['gift', 'correction', 'refund_unconsumed'].includes(kind);
      q('[data-field="quantity"]').hidden = !quantity && !state.selectedKey?.startsWith('redeem:');
      q('[data-field="user"]').hidden = !quantity && !['customer_receipt', 'subscription'].includes(kind);
      form.elements.serviceStart.required = ['fee', 'service_income', 'subscription'].includes(kind);
      form.elements.serviceEnd.required = form.elements.serviceStart.required;
      form.elements.cancelDate.required = kind === 'refund_subscription';
      form.elements.refundEarned.required = kind === 'refund_subscription';
    }
    function openingForm(userId = '') {
      const user = state.report?.balances.users.find(user => user.id === userId); const opening = user?.opening;
      drawer('确认用户期初余额', `<p class="muted">核算时点 ${e(state.report.policy.startDate)} 00:00 · ${e(state.report.timezone)}</p><form class="accounting-form" data-opening-form><label class="accounting-wide">用户 ID<input name="userId" inputmode="numeric" value="${e(userId)}" required></label><label>期初额度总量<input name="quantity" type="number" step="0.00000001" min="0" value="${e(opening?.quantity ?? '')}" required></label><label>其中待确认的实收价值（CNY）<input name="cashValue" type="number" step="0.00000001" min="0" value="${e(opening?.cashValue ?? '')}" required></label><label class="accounting-wide">核对依据<textarea name="reason" maxlength="500" required>${e(opening?.reason || '')}</textarea></label><p class="form-error accounting-wide" data-form-error role="alert" hidden></p><div class="form-actions accounting-wide"><button type="submit" class="button primary">${h.icon('save')}<span>保存期初</span></button></div></form>`);
    }
    function dayDetail(date) {
      const row = state.report.items.find(item => item.date === date);
      drawer(`${date} · 经营明细`, table(['项目', '金额'], [['用户消费额度', money(row.siteConsumption)], ['付费余额消费收入', money(row.balanceRevenue)], ['订阅收入分摊', money(row.subscriptionRevenue)], ['其他已履约收入 / 退款', money(row.otherRevenue)], ['确认收入', money(row.revenue)], ['供应商实际成本', money(row.supplierCost)], ['其他运营费用', money(row.fee)], ['经营利润', money(row.profit)], ['利润率', pct(row.margin)]])
        + `<h3>供应商实际成本</h3>${table(['供应商', '成本', '核验'], row.providers.map(provider => [e(provider.name), e(money(provider.cost)), e(provider.complete ? '已核验' : (provider.reasons || ['待核验']).join('；'))]))}`
        + `<h3>付费余额消费</h3>${table(['用户', '消费额度', '确认收入'], (row.users || []).map(user => [e(user.name), money(user.consumption), money(user.revenue)]))}`
        + `<h3>收入与费用分摊</h3>${table(['项目', '类型', '所属期间', '本日金额', '来源'], (row.allocations || []).map(item => [e(item.name), e(kinds[item.kind]), e(`${item.start} 至 ${item.end}`), money(item.amount), `<button type="button" class="accounting-link" data-document="${e(item.documentKey)}">核对</button>`]))}`
        + (row.issues?.length ? `<h3>待核对</h3>${row.issues.map(issue => `<p>${e(issue.message)}</p>`).join('')}` : '')
        + `<p class="muted">${row.mode === 'live' ? '今日实时' : '历史归档'} · ${row.computedAt ? e(h.formatDateTime(row.computedAt, state.report.timezone)) : '等待计算'}</p>`);
    }
    function automaticDayDetail(date) {
      const row = state.report.items.find(item => item.date === date);
      drawer(`${date} · 消费与毛利`, table(['项目', '金额'], [['主站消费', automaticMoney(row.siteConsumption)], ['供应商实际消费', automaticMoney(row.supplierConsumption)], ['消费毛利', automaticMoney(row.profit)], ['毛利率', pct(row.margin)]])
        + `<h3>供应商实际消费</h3>${table(['供应商', '实际消费', '数据状态'], (row.providers || []).map(provider => [e(provider.name), e(automaticMoney(provider.cost)), e(provider.complete ? '数据完整' : (provider.reasons || ['数据缺失']).join('；'))]))}`
        + (state.report.notices?.length ? `<details><summary>数据说明</summary>${state.report.notices.map(notice => `<p>${e(notice)}</p>`).join('')}</details>` : '')
        + `<p class="muted">${row.mode === 'live' ? '今日实时' : '历史归档'} · ${row.computedAt ? e(h.formatDateTime(row.computedAt, state.report.timezone)) : '等待统计'}</p>`);
    }
    async function metricDetail(action) {
      if (state.report?.automatic) {
        const labels = { siteConsumption: '主站消费', supplierConsumption: '供应商实际消费', profit: '消费毛利', margin: '消费毛利率' };
        if (labels[action]) drawer(labels[action], table(['日期', action === 'margin' ? '毛利率' : '金额', '详情'], state.report.items.map(row => [e(row.date), e(action === 'margin' ? pct(row.margin) : automaticMoney(row[action])), `<button type="button" class="accounting-link" data-automatic-day="${e(row.date)}">详情</button>`])));
        return;
      }
      if (['revenue', 'supplier', 'fee', 'profit'].includes(action)) {
        const key = { supplier: 'supplierCost' }[action] || action;
        drawer({ revenue: '确认收入明细', supplier: '供应商实际成本', fee: '运营费用分摊', profit: '经营利润明细' }[action], table(['日期', '金额', '详情'], state.report.items.map(row => [e(row.date), e(money(row[key])), `<button class="accounting-link" type="button" data-day="${e(row.date)}">详情</button>`]))); return;
      }
      if (action === 'balances') { drawer('上游账号预付余额', table(['供应商', '原始余额', 'CNY 估值', '快照 / 状态'], state.report.balances.providers.map(provider => [e(provider.name), e(`${provider.available ?? '—'} ${provider.currency || ''}`), e(money(provider.cashValue)), e(provider.complete ? h.formatDateTime(provider.capturedAt) : (provider.reasons || []).join('；'))]))); return; }
      if (action === 'audit') { await changeTab('audit'); return; }
      if (['users', 'deleted'].includes(action)) { await changeTab('audit'); q('[data-user-search]').elements.search.value = ''; renderUsers(); return; }
      await changeTab('cash');
    }
    root.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      const run = async () => {
        if (button.hasAttribute('data-close')) { q('[data-dialog]').close(); return; }
        if (button.dataset.tab) { await changeTab(button.dataset.tab); return; }
        if (button.dataset.metric) { await metricDetail(button.dataset.metric); return; }
        if (button.dataset.automaticDay) { automaticDayDetail(button.dataset.automaticDay); return; }
        if (button.dataset.automaticDayStep) { state.automaticPage += Number(button.dataset.automaticDayStep); renderAutomaticDays(); return; }
        if (button.dataset.day) { dayDetail(button.dataset.day); return; }
        if (button.dataset.dayStep) { state.page += Number(button.dataset.dayStep); renderDays(); return; }
        if (button.dataset.documentStep) { state.documentPage += Number(button.dataset.documentStep); await loadDocuments(); return; }
        if (button.dataset.userStep) { state.userPage = (state.userPage || 1) + Number(button.dataset.userStep); renderUsers(); return; }
        if (button.dataset.document) { await editDocument(button.dataset.document); return; }
        if (button.hasAttribute('data-opening')) { openingForm(button.dataset.opening); return; }
        if (button.hasAttribute('data-issue')) {
          const issue = state.report.issues[Number(button.dataset.issue)];
          if (issue.type === 'opening') openingForm(issue.userId);
          else if (issue.documentKey) await editDocument(issue.documentKey);
          else if (issue.type === 'subscription') { await ensureProviders(); entryForm({ name: `用户 ${issue.userId} 订阅`, date: issue.date, userId: issue.userId, kind: 'subscription', amount: 0 }); state.selectedKey = null; q('[data-entry-form]').elements.name.readOnly = false; }
          else dayDetail(issue.date && state.report.items.some(row => row.date === issue.date) ? issue.date : state.report.items[0].date);
          return;
        }
        if (button.dataset.command === 'credits') { leave(); await h.openCredits(); return; }
        if (button.dataset.command === 'automatic-balance') { const s = state.automaticMeta?.summary; drawer('当前用户余额', table(['项目', '数值'], [['当前用户余额', automaticMoney(s?.userBalance)], ['现有用户数（不含 ID 1）', s?.balanceUsers ?? '暂不可用']])); return; }
        if (button.dataset.command === 'finance') { h.openFinance(); return; }
        if (button.dataset.command === 'audit') { await changeTab('audit'); return; }
        if (button.dataset.command === 'pending') { q('[data-doc-search]').elements.pending.value = '1'; state.documentPage = 1; await changeTab('cash'); return; }
        if (button.dataset.command === 'opening') { openingForm(); return; }
        if (button.dataset.command === 'refresh') { await load({ refresh: true }); return; }
        if (button.dataset.command === 'policy') drawer('核算起点', `<form class="accounting-form" data-policy-form><label class="accounting-wide">起始日期<input name="startDate" type="date" value="${e(state.report.policy.startDate)}" required></label><label class="accounting-wide">变更原因<textarea name="reason" required maxlength="500"></textarea></label><p class="form-error accounting-wide" data-form-error role="alert" hidden></p><div class="form-actions accounting-wide"><button type="submit" class="button primary">保存并重新核算</button></div></form>`);
      };
      run().catch(error => h.toast(error.message, 'error'));
    });
    root.addEventListener('change', event => { if (event.target.name === 'kind') updateFields(); });
    root.addEventListener('submit', event => {
      event.preventDefault(); const form = event.target;
      if (form.matches('[data-doc-search]')) { state.documentPage = 1; loadDocuments().catch(error => h.toast(error.message, 'error')); return; }
      if (form.matches('[data-user-search]')) { state.userPage = 1; renderUsers(); return; }
      const run = async () => {
        const values = Object.fromEntries(new FormData(form));
        let endpoint;
        if (form.matches('[data-opening-form]')) { endpoint = '/opening'; values.quantity = Number(values.quantity); values.cashValue = Number(values.cashValue); }
        else if (form.matches('[data-policy-form]')) endpoint = '/policy';
        else if (form.matches('[data-entry-form]')) {
          endpoint = state.selectedKey ? `/documents/${encodeURIComponent(state.selectedKey)}` : '/documents';
          values.paid = form.elements.paid.checked;
          for (const key of ['amount', 'quantity', 'rate', 'cashAdjustment', 'refundEarned']) { if (values[key] === '') delete values[key]; else values[key] = Number(values[key]); }
          values.currency = values.currency.trim().toUpperCase();
          if (!state.selectedKey) values.requestId = state.entryRequestId;
          for (const key of ['userId', 'providerId', 'linkedKey', 'relatedKey']) if (!values[key]) delete values[key];
          if (!['fee', 'subscription', 'service_income'].includes(values.kind)) { delete values.serviceStart; delete values.serviceEnd; }
          if (!['customer_receipt', 'reference', 'refund_unconsumed'].includes(values.kind)) delete values.linkedKey;
          if (!values.kind.startsWith('refund_')) delete values.relatedKey;
          if (values.kind !== 'refund_subscription') { delete values.cancelDate; delete values.refundEarned; }
        } else return;
        const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
        try {
          await h.api(`${base}${endpoint}`, { method: endpoint === '/documents' ? 'POST' : 'PUT', body: JSON.stringify(values) });
          if (!state.active || !h.isActive()) return;
          q('[data-dialog]').close(); h.toast('核算记录已保存', 'success');
          if (form.matches('[data-entry-form]')) { h.focusDate(values.date); state.documentPage = 1; await changeTab('cash', { reload: false }); }
          await load();
        } finally { submit.disabled = false; }
      };
      run().catch(error => { const node = form.querySelector('[data-form-error]'); if (node) { node.textContent = error.message; node.hidden = false; } else h.toast(error.message, 'error'); });
    });
    root.querySelector('.accounting-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const tabs = ['automatic', 'business', 'cash', 'audit'];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(state.tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      changeTab(tabs[index]).catch(error => h.toast(error.message, 'error')); q(`[data-tab="${tabs[index]}"]`).focus();
    });
    async function ensureProviders() { const result = await h.api('/api/cost-analysis/providers'); state.providers = result.items || []; }
    document.getElementById('cost-accounting-add').addEventListener('click', () => ensureProviders().then(() => { if (state.active) entryForm(); }).catch(error => h.toast(error.message, 'error')));
    return { load, leave, state };
  }
  return { create };
})();
if (typeof window !== 'undefined') window.CostAccountingUi = CostAccountingUi;
if (typeof module !== 'undefined' && module.exports) module.exports = CostAccountingUi;
