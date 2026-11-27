'use strict';
const SupplierGroupUi = (() => {
  function create(h, root) {
    const e = h.escapeHtml, q = selector => root.querySelector(selector), base = '/api/cost-analysis/supplier-groups';
    const state = { active: false, request: 0, date: '', providerId: '', view: 'groups', detail: 'accounts', groupId: '', page: 1, issuesOnly: true, report: null, expandedAccounts: new Set() };
    const money = value => value == null ? '—' : h.formatMoney(value, '', 8);
    const upstream = (row, value = row.upstream) => value != null ? e(money(value)) : row.knownKeyCount > 0
      ? `${e(money(row.knownUpstream))}<small class="supplier-group-subtotal">${row.stale ? '上次已知小计' : '已知小计'}</small>` : '—';
    const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${money(value)}`;
    const pct = value => value == null ? '—' : h.formatPercent(value);
    const lowMargin = (row, report = state.report) => row?.rate != null && Number.isFinite(Number(row.rate)) && Number(row.rate) < Number(report?.settings?.marginAlert?.threshold ?? 10);
    const option = (value, text, selected) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(text)}</option>`;
    const labels = { comparable: '可比较', upstream_high: '上游偏高', upstream_above: '上游高于主站', upstream_missing: '上游数据待核验', upstream_group_unmatched: '上游分组待核对', archive_conflict: '历史归档冲突', site_incomplete: '主站数据不完整', unlinked_key: '有 Key 未关联', mapping_incomplete: '关联待核对', history_unverified: '全天归属待核对', zero: '零消费', history_missing: '历史缺失', stale: '上次快照' };
    const status = value => `<span class="supplier-group-status ${['upstream_high'].includes(value) ? 'bad' : ['upstream_missing', 'upstream_group_unmatched', 'archive_conflict', 'site_incomplete', 'unlinked_key', 'mapping_incomplete', 'history_unverified', 'history_missing', 'stale'].includes(value) ? 'warn' : ''}">${e(labels[value] || value)}</span>`;
    const link = (attr, value, text, label) => `<button type="button" class="accounting-link" ${attr}="${e(value)}"${label ? ` aria-label="${e(label)}" title="${e(label)}"` : ''}>${text}</button>`;
    const table = (headers, rows, cls = '') => `<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map(t => `<th>${t}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map((v, i) => `<td${headers[i].includes('CNY') || headers[i].includes('差额率') || headers[i] === '请求数' ? ' class="numeric"' : ''}>${v}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty-state">当前范围暂无记录</td></tr>`}</tbody></table></div>`;
    root.innerHTML = `<div class="supplier-group-toolbar">
      <label>消费日期<input type="date" data-sg-date></label><label>供应商<select data-sg-provider><option value="">全部供应商</option></select></label>
      <div class="supplier-group-tools"><button type="button" class="icon-button" data-sg-view="mapping" aria-label="账号关联核对" title="账号关联核对" aria-pressed="false">${h.icon('list-checks')}<span data-sg-issue-count></span></button><button type="button" class="icon-button" data-sg-settings aria-label="简称与差额提醒" title="简称与差额提醒">${h.icon('sliders-horizontal')}</button></div><span class="muted" data-sg-meta></span></div>
      <p data-sg-warning class="accounting-notice" role="status" hidden></p><section id="sg-main-panel" aria-label="供应商分组消费" data-sg-content></section>
      <div class="accounting-pager"><span data-sg-page></span><div><button type="button" class="icon-button" data-sg-step="-1" aria-label="上一页" title="上一页">${h.icon('chevron-left')}</button><button type="button" class="icon-button" data-sg-step="1" aria-label="下一页" title="下一页">${h.icon('chevron-right')}</button></div></div>
      <details class="accounting-rules"><summary>消费统计口径</summary><p>主站按账号的实际请求统计消费，跨主站分组累加，再汇总到对应上游分组。同一上游 Key 对应的多个账号分别列出，上游消费只计一次。排除 ID 1，保留停用或已删除账号的历史消费。</p><p>仅展示主站有关联账号的上游分组，零消费账号也保留。名称已定位供应商但分组未核验的账号单列待核对。供应商账号日总额减去已知 Key 分组金额的正向残差也单列待核对，不冒充真实分组且不计入差额。当前分组已唯一定位、全天身份历史未核验时，仍展示账号和消费，标记全天归属待核对，不核定差额。供应商合计包含所展示范围的全部分页；分组未定位时正式上游合计和差额保持未知。差额 = 主站合计 − 上游分组消费，未扣除抽奖和其他费用。</p><p>资金时区每日 01:00 首次归档前一天，今日实时。历史只读归档，没有归档时保持缺失，不按当前账号关系倒推历史。</p></details>
      <dialog class="accounting-dialog" data-sg-dialog aria-labelledby="sg-dialog-title"><header class="accounting-drawer-header"><h2 id="sg-dialog-title"></h2><button type="button" class="icon-button" data-sg-close aria-label="关闭" title="关闭">${h.icon('x')}</button></header><div class="accounting-drawer-body" data-sg-dialog-body></div></dialog>`;
    function render() {
      const r = state.report;
      if (!r) return;
      q('[data-sg-date]').value = state.date; q('[data-sg-date]').max = r.today;
      q('[data-sg-provider]').innerHTML = option('', '全部供应商', state.providerId) + r.providers.map(p => option(p.id, p.name, state.providerId)).join('');
      q('[data-sg-meta]').textContent = `${r.timezone} · CNY · ${r.source === 'live' ? '今日实时' : r.source === 'archive' ? '本地归档' : '历史缺失'}${r.computedAt ? ` · ${h.formatDateTime(r.computedAt)}` : ''}`;
      q('[data-sg-view="mapping"]').setAttribute('aria-pressed', String(state.view === 'mapping' && !r.group));
      q('[data-sg-issue-count]').textContent = r.summary?.issueCount || '';
      const notices = [r.warning, ...(r.missingProviders || []).map(p => `${p.name}：${(p.reasons?.length ? p.reasons : ['上游分组来源缺失']).join('；')}`),
        r.siteComplete === false ? '主站用量未通过原生日桶完整性核验，主站金额与差额暂不核定' : null,
        r.summary?.unassignedProviderCount ? `另有 ${r.summary.unassignedProviderCount} 个账号未定位供应商，可在全部供应商范围核对` : null].filter(Boolean);
      q('[data-sg-warning]').hidden = !notices.length; q('[data-sg-warning]').textContent = notices.join('；');
      q('[data-sg-content]').innerHTML = r.source === 'history_missing' ? '<p class="empty-state">该日没有分组消费归档</p>' : state.view === 'mapping' ? renderMappings(r) : r.group ? renderDetail(r.group) : renderGroups(r);
      const p = r.pagination; q('[data-sg-page]').textContent = `第 ${p.page} / ${Math.max(1, p.totalPages)} 页 · ${p.total} 条`;
      q('[data-sg-step="-1"]').disabled = p.page <= 1; q('[data-sg-step="1"]').disabled = p.page >= p.totalPages;
      root.querySelector('.accounting-pager').hidden = p.totalPages <= 1 || (state.detail === 'daily' && Boolean(r.group));
      h.refreshIcons();
    }
    function accountMarkup(account, groupId) {
      const id = `${groupId}:${account.id}`;
      return `<details class="supplier-group-account" data-sg-account="${e(id)}"${state.expandedAccounts.has(id) ? ' open' : ''}><summary aria-label="${e(account.name)}，消费 ${e(money(account.main))}，查看主站分组明细">${h.icon('chevron-right')}<span class="supplier-group-account-name">${e(account.name)}</span><span class="supplier-group-account-amount">${e(money(account.main))}</span></summary><div class="supplier-group-account-splits"><small>#${e(account.id)}${account.deleted ? ' · 已删除，保留历史' : account.status !== 'active' ? ' · 当前停用，保留消费' : ''}</small>${account.reason ? `<small>${e(account.reason)}</small>` : ''}${account.localGroups.length ? account.localGroups.map(row => `<div class="supplier-group-split"><span>${e(row.name)}</span><span>${e(money(row.main))}</span></div>`).join('') : '<small>当日无消费</small>'}</div></details>`;
    }
    function comparisonTable(groups, summary, pending) {
      const amountCell = (label, value, cls, markup = false) => `<td class="numeric supplier-group-amount ${cls || ''}"><span class="supplier-group-mobile-label">${label}</span><span>${markup ? value : e(value)}</span></td>`;
      const rateCell = (row, label = '收益率') => `<td class="numeric supplier-group-amount supplier-group-rate-cell${lowMargin(row) ? ' supplier-group-low-margin' : ''}"><span class="supplier-group-mobile-label">${label}</span><span>${e(pct(row.rate))}</span></td>`;
      let rows = groups.map(g => `<tr data-sg-row="${e(g.id)}"><td class="supplier-group-accounts-cell"><div class="supplier-group-accounts"><span class="supplier-group-mobile-label">主站账号 / 消费</span>${g.accounts.map(account => accountMarkup(account, g.id)).join('')}${g.accountsTruncated ? link('data-sg-group', g.id, `查看全部 ${g.accountCount} 个账号`) : ''}</div></td><td class="supplier-group-name">${link('data-sg-group', g.id, e(g.name), `查看 ${g.name} 账号与每日明细`)}<small>${g.accountCount} 个主站账号</small>${['comparable', 'zero'].includes(g.status) ? '' : status(g.status)}</td>${amountCell('主站合计', money(g.main), 'supplier-group-main')}${amountCell('上游分组消费', upstream(g), 'supplier-group-upstream', true)}${amountCell('主站 − 上游', signed(g.diff), `supplier-group-diff ${g.diff < 0 ? 'negative-value' : ''}`)}${rateCell(g)}</tr>`).join('');
      if (pending) rows += `<tr data-sg-pending="${e(pending.id)}"><td class="supplier-group-accounts-cell"><div class="supplier-group-accounts"><span class="supplier-group-mobile-label">主站账号 / 消费</span>${pending.accounts.map(account => accountMarkup(account, `pending:${pending.id}`)).join('')}${pending.accountsTruncated ? link('data-sg-pending-provider', pending.id, `查看全部 ${pending.accountCount} 个待核对账号`) : ''}${!pending.accountCount ? '<small class="muted">暂无可定位的主站账号</small>' : ''}</div></td><td class="supplier-group-name"><span>上游分组待核对</span><small>${pending.accountCount ? `${pending.accountCount} 个主站账号` : '未定位主站账号'}</small>${status(pending.status || 'mapping_incomplete')}</td>${amountCell('主站合计', money(pending.main), 'supplier-group-main')}${amountCell('上游分组消费', money(pending.upstream), 'supplier-group-upstream')}${amountCell('主站 − 上游', signed(null), 'supplier-group-diff')}${rateCell(pending)}</tr>`;
      const footer = summary ? `<tfoot><tr><th scope="row" colspan="2">供应商合计<small>主站在用 ${summary.groupCount} 个上游分组${summary.pendingAccountCount ? ` · ${summary.pendingAccountCount} 个账号待核对` : ''}</small>${summary.upstream === null && summary.groupCount ? `<small>${summary.knownGroups}/${summary.groupCount} 组完整</small>` : ''}${summary.unmatchedUpstream != null ? `<small>另有 ${money(summary.unmatchedUpstream)} CNY 上游消费待核对</small>` : ''}</th>${amountCell('主站合计', money(summary.main))}${amountCell('上游分组消费', upstream(summary), '', true)}${amountCell('差额', signed(summary.diff), summary.diff < 0 ? 'negative-value' : '')}${rateCell(summary)}</tr></tfoot>` : '';
      return `<table class="supplier-group-table"><colgroup><col><col><col><col><col><col></colgroup><thead><tr><th scope="col">主站账号<small>账号消费 CNY</small></th><th scope="col">上游供应商分组</th><th scope="col" class="numeric">主站合计</th><th scope="col" class="numeric">上游分组消费<small>折算 CNY</small></th><th scope="col" class="numeric">差额<small>主站 − 上游</small></th><th scope="col" class="numeric">收益率<small>低于阈值高亮</small></th></tr></thead><tbody>${rows}</tbody>${footer}</table>`;
    }
    function renderGroups(r) {
      const providers = new Map();
      for (const group of r.groups || []) {
        if (!providers.has(group.providerId)) providers.set(group.providerId, []);
        providers.get(group.providerId).push(group);
      }
      const pendingProviders = new Map((r.pendingProviders || []).map(provider => [provider.id, provider]));
      for (const id of pendingProviders.keys()) if (!providers.has(id)) providers.set(id, []);
      return [...providers].map(([id, groups]) => {
        const summary = r.providerSummaries.find(provider => provider.id === id);
        const accountTotal = summary.providerAccountTotal != null ? ` · 供应商账号总消费 ${money(summary.providerAccountTotal)} CNY` : summary.providerAccountTotalStatus === 'legacy' ? ' · 旧快照未含供应商账号汇总' : ['unavailable', 'partial', 'stale'].includes(summary.providerAccountTotalStatus) ? ' · 供应商账号总消费待核验' : '';
        return `<section class="supplier-group-provider" aria-label="${e(summary.name)}"><div class="supplier-group-provider-heading"><h2>${e(summary.name)}</h2><small>${summary.groupCount} 个在用上游分组${summary.pendingAccountCount ? ` · ${summary.pendingAccountCount} 个账号待核对` : ''}${accountTotal}</small></div>${comparisonTable(groups, summary, pendingProviders.get(id))}</section>`;
      }).join('') || '<p class="empty-state">当前范围暂无分组消费</p>';
    }
    function renderMappings(r) {
      return `<div class="supplier-group-heading"><button type="button" class="icon-button" data-sg-view="groups" aria-label="返回分组列表" title="返回分组列表">${h.icon('arrow-left')}</button><h2>账号关联核对</h2></div><div class="supplier-group-filter"><label class="supplier-group-check"><input type="checkbox" data-sg-issues${state.issuesOnly ? ' checked' : ''}>仅待核对</label></div>` +
        table(['主站账号', '供应商候选', 'Key / 上游分组', '主站消费 CNY', '状态', '依据'], (r.mappings || []).map(a => [
          `<strong>${e(a.name)}</strong><small>#${e(a.id)}${a.deleted ? ' · 已删除' : a.status !== 'active' ? ` · ${e(a.status || '状态未知')}` : ''}</small>`, a.candidates.map(p => e(p.name)).join('<br>') || '未定位',
          `${e(a.maskedKey || '未核验')}<small>${e(a.groupName || '待核对')}</small>`, e(r.siteComplete ? money(a.main) : '—'), a.matched ? a.historyVerified === false ? '当前已关联，全天归属待核对' : '已关联' : e(a.reason), link('data-sg-proof', a.id, '查看')]), 'supplier-group-account-table');
    }
    function renderDetail(g) {
      const tabs = [['accounts', '账号消费'], ['local', '按主站分组'], ['daily', '每日对比']];
      let content;
      if (state.detail === 'daily') content = table(['日期', '上游消费 CNY', '主站消费 CNY', '消费差额 CNY', '收益率', '状态'], g.days.map(d => [link('data-sg-day', d.date, e(d.date)), upstream(d), e(money(d.main)), e(signed(d.diff)), `<span class="${lowMargin(d) ? 'supplier-group-low-margin' : ''}">${e(pct(d.rate))}</span>`, status(d.status)]), 'supplier-group-account-table');
      else if (state.detail === 'local') content = table(['主站分组', '主站账号', '请求数', '主站消费 CNY'], g.localGroups.map(row => [`${e(row.name)}<small>#${e(row.id)}</small>`, row.accounts.map(account => e(account.name)).join('<br>'), row.requests, e(money(row.main))]), 'supplier-group-account-table');
      else {
        content = `<p class="muted">上游 ${upstream(g)} · 主站 ${e(money(g.main))} · 差额 ${e(signed(g.diff))}</p>` +
          table(['主站账号', '主站分组 / 消费', '请求数', '账号消费 CNY'], g.accounts.map(a => [
            `<strong>${e(a.name)}</strong><small>#${e(a.id)}${a.deleted ? ' · 已删除，保留历史' : a.status !== 'active' ? ' · 当前停用，保留消费' : ''}</small>`,
            a.localGroups.map(row => `<div class="supplier-group-split"><span>${e(row.name)}</span><span>${e(money(row.main))}</span></div>`).join(''), a.requests, e(money(a.main))]), 'supplier-group-account-table');
      }
      return `<div class="supplier-group-heading"><button type="button" class="icon-button" data-sg-back aria-label="返回分组列表" title="返回分组列表">${h.icon('arrow-left')}</button><div><h2>${e(g.providerName)} / ${e(g.name)}</h2><small>${g.accountCount} 个主站账号 · ${g.localGroupCount} 个主站分组</small></div>${status(g.status)}</div>` +
        (g.reasons.length ? `<p class="accounting-notice">${g.reasons.map(e).join('；')}</p>` : '') +
        `<div class="accounting-subtabs supplier-group-tabs" role="tablist" aria-label="分组明细">${tabs.map(([id, text]) => `<button type="button" role="tab" id="sg-detail-tab-${id}" aria-controls="sg-detail-panel" aria-selected="${state.detail === id}" tabindex="${state.detail === id ? 0 : -1}" data-sg-detail="${id}">${text}</button>`).join('')}</div><section id="sg-detail-panel" role="tabpanel" aria-labelledby="sg-detail-tab-${state.detail}">${content}</section>`;
    }
    function schedule() { clearTimeout(state.timer); if (state.active && h.isActive() && !document.hidden) state.timer = setTimeout(() => {
      if (q('[data-sg-dialog]').open) return schedule(); load().catch(() => {});
    }, 60000); }
    async function load() {
      state.active = true; clearTimeout(state.timer); state.controller?.abort(); state.controller = new AbortController(); const request = ++state.request;
      const outerEnd = h.query().end;
      if (outerEnd !== state.outerEnd) { state.outerEnd = outerEnd; state.date = outerEnd || ''; state.groupId = ''; state.page = 1; }
      const params = { ...(state.date ? { date: state.date } : {}), providerId: state.providerId, view: state.groupId ? state.detail : state.view,
        ...(state.groupId ? { groupId: state.groupId } : {}), page: state.page, pageSize: 20, issuesOnly: state.issuesOnly ? '1' : '0' };
      const selection = JSON.stringify([params.date, params.providerId, params.view, params.groupId, params.page, params.issuesOnly]);
      if (selection !== state.selection) {
        state.report = null; state.selection = selection;
        q('[data-sg-content]').innerHTML = '<p class="empty-state" role="status">正在读取分组消费…</p>';
      }
      q('[data-sg-content]').setAttribute('aria-busy', 'true');
      try {
        const report = await h.api(`${base}?${new URLSearchParams(params)}`, { signal: state.controller.signal });
        if (!state.active || request !== state.request || !h.isActive()) return;
        state.report = report; state.date = report.date; state.page = report.pagination.page;
        state.selection = JSON.stringify([state.date, params.providerId, params.view, params.groupId, params.page, params.issuesOnly]);
        render(); h.setPageMeta(`${report.date} · ${report.timezone} · 供应商分组每日消费`);
      } catch (error) {
        if (!state.active || request !== state.request) return;
        if (state.report) {
          state.report.stale = true;
          if (state.report.groups) state.report.groups = state.report.groups.map(g => ({ ...g, stale: true, diff: null, rate: null, status: 'stale' }));
          if (state.report.providerSummaries) state.report.providerSummaries = state.report.providerSummaries.map(provider => ({ ...provider, stale: true, diff: null }));
          if (state.report.group) {
            state.report.group = { ...state.report.group, stale: true, diff: null, rate: null, status: 'stale',
              days: state.report.group.days.map(d => d.date === state.date ? { ...d, stale: true, diff: null, rate: null, status: 'stale' } : d) };
          }
          if (state.report.summary) state.report.summary.diff = null;
          render();
        }
        q('[data-sg-warning]').hidden = false; q('[data-sg-warning]').textContent = `${error.message}；稍后自动重试`;
        if (!state.report) q('[data-sg-content]').innerHTML = '<p class="empty-state">分组消费暂不可用</p>';
      } finally { if (request === state.request) { q('[data-sg-content]').removeAttribute('aria-busy'); schedule(); } }
    }
    function leave() { state.active = false; ++state.request; clearTimeout(state.timer); state.controller?.abort(); q('[data-sg-dialog]').close(); }
    function dialog(title, html) { q('#sg-dialog-title').textContent = title; q('[data-sg-dialog-body]').innerHTML = html; q('[data-sg-dialog]').showModal(); h.refreshIcons(); }
    root.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b) return;
      let changed = false;
      if (b.hasAttribute('data-sg-close')) q('[data-sg-dialog]').close();
      if (b.dataset.sgView) { state.view = b.dataset.sgView; state.groupId = ''; state.page = 1; changed = true; }
      if (b.dataset.sgGroup) { state.groupId = b.dataset.sgGroup; state.detail = 'accounts'; state.page = 1; changed = true; }
      if (b.dataset.sgPendingProvider) { state.providerId = b.dataset.sgPendingProvider; state.view = 'mapping'; state.issuesOnly = true; state.groupId = ''; state.page = 1; changed = true; }
      if (b.hasAttribute('data-sg-back')) { state.groupId = ''; state.page = 1; changed = true; }
      if (b.dataset.sgDetail) { state.detail = b.dataset.sgDetail; state.page = 1; changed = true; }
      if (b.dataset.sgStep) { state.page += Number(b.dataset.sgStep); changed = true; }
      if (b.dataset.sgDay) { state.date = b.dataset.sgDay; state.page = 1; changed = true; }
      if (changed) load();
      if (b.dataset.sgProof) {
        const a = state.report.mappings.find(row => row.id === b.dataset.sgProof); if (!a) return;
        dialog(`${a.name} #${a.id}`, table(['核对项', '依据'], [['名称候选', a.candidates.map(p => e(p.name)).join('、') || '未定位'], ['Key 核验', e(a.maskedKey || '未核验')], ['上游分组', e(a.groupName || '待核对')], ['结论', e(a.reason)], ['主站当日消费 CNY', e(state.report.siteComplete ? money(a.main) : '—')]]));
      }
      if (b.hasAttribute('data-sg-settings') && state.report) openSettings();
    });
    async function openSettings() {
      state.draft = JSON.parse(JSON.stringify(state.report.settings)); state.draft.marginAlert ||= { enabled: true, threshold: 10, channelIds: [] };
      state.draft.marginAlert.channelIds ||= []; state.aliasProvider = state.report.providers[0]?.id || '';
      let channels = [];
      try { channels = (await h.api('/api/settings/notification-channels')).items || []; } catch (error) { h.toast(error.message, 'error'); }
      state.notificationChannels = channels;
      dialog('供应商简称与收益率提醒', `<form data-sg-settings-form class="accounting-form"><label class="accounting-wide">供应商<select data-sg-alias-provider>${state.report.providers.map(p => option(p.id, p.name, state.aliasProvider)).join('')}</select></label><label class="accounting-wide">供应商简称（每行一个）<textarea data-sg-alias maxlength="2400">${e((state.draft.aliases[state.aliasProvider] || []).join('\n'))}</textarea></label><label class="supplier-group-check accounting-wide"><input type="checkbox" name="enabled"${state.draft.alert.enabled ? ' checked' : ''}>上游超出主站消费时提醒</label><label>超出金额至少（CNY）<input name="amount" type="number" min="0" max="1000000" step="any" value="${state.draft.alert.amount}" required></label><label>超出比例至少（%）<input name="percent" type="number" min="0" max="1000" step="any" value="${state.draft.alert.percent}" required></label><hr class="accounting-wide"><label class="supplier-group-check accounting-wide"><input type="checkbox" name="marginEnabled"${state.draft.marginAlert.enabled ? ' checked' : ''}>收益率低于阈值时发送提醒</label><label>收益率高亮阈值（%）<input name="marginThreshold" type="number" min="0" max="1000" step="any" value="${state.draft.marginAlert.threshold}" required></label><label class="accounting-wide">通知渠道<select name="marginChannels" multiple size="${Math.min(5, Math.max(2, channels.length || 2))}">${channels.map(channel => `<option value="${e(channel.id)}"${state.draft.marginAlert.channelIds.includes(channel.id) ? ' selected' : ''}>${e(`${channel.name}${channel.enabled ? '' : '（停用）'}`)}</option>`).join('') || '<option disabled>请先在系统设置中配置渠道</option>'}</select></label><p class="accounting-wide muted">仅对数据完整且可比较的分组发送；异常、历史冲突和待核对数据不会触发提醒。</p><p class="accounting-wide form-error" data-sg-save-error role="alert" hidden></p><div class="accounting-wide form-actions"><button type="submit" class="button primary">${h.icon('save')}<span>保存设置</span></button></div></form>`);
    }
    root.addEventListener('toggle', event => {
      const detail = event.target;
      if (!detail.matches('details[data-sg-account]') || !detail.isConnected) return;
      if (detail.open) state.expandedAccounts.add(detail.dataset.sgAccount);
      else state.expandedAccounts.delete(detail.dataset.sgAccount);
    }, true);
    function captureAlias() { if (state.aliasProvider) state.draft.aliases[state.aliasProvider] = q('[data-sg-alias]').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
    root.addEventListener('change', event => {
      const n = event.target;
      if (n.hasAttribute('data-sg-alias-provider')) { captureAlias(); state.aliasProvider = n.value; q('[data-sg-alias]').value = (state.draft.aliases[n.value] || []).join('\n'); return; }
      if (n.hasAttribute('data-sg-date')) state.date = n.value;
      else if (n.hasAttribute('data-sg-provider')) { state.providerId = n.value; state.groupId = ''; }
      else if (n.hasAttribute('data-sg-issues')) state.issuesOnly = n.checked;
      else return;
      state.page = 1; load();
    });
    root.addEventListener('submit', async event => {
      if (!event.target.matches('[data-sg-settings-form]')) return;
      event.preventDefault(); if (state.saving) return;
      const form = event.target, button = form.querySelector('[type=submit]'); state.saving = true; button.disabled = true;
      try {
        captureAlias(); state.draft.alert = { enabled: form.elements.enabled.checked, amount: Number(form.elements.amount.value), percent: Number(form.elements.percent.value) };
        state.draft.marginAlert = { enabled: form.elements.marginEnabled.checked, threshold: Number(form.elements.marginThreshold.value), channelIds: [...form.elements.marginChannels.selectedOptions].map(option => option.value) };
        await h.api(`${base}/settings`, { method: 'PUT', body: JSON.stringify(state.draft) });
        if (!state.active) return;
        q('[data-sg-dialog]').close(); h.toast('分组消费设置已保存', 'success'); await load();
      } catch (error) { const node = form.querySelector('[data-sg-save-error]'); node.hidden = false; node.textContent = error.message; }
      finally { state.saving = false; button.disabled = false; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(state.timer); else if (state.active && h.isActive()) load(); });
    return { load, leave, state };
  }
  return { create };
})();
if (typeof window !== 'undefined') window.SupplierGroupUi = SupplierGroupUi;
if (typeof module !== 'undefined' && module.exports) module.exports = SupplierGroupUi;
