'use strict';
const SupplierGroupUi = (() => {
  function create(h, root) {
    const e = h.escapeHtml, q = selector => root.querySelector(selector), base = '/api/cost-analysis/supplier-groups';
    const state = { active: false, request: 0, date: '', providerId: '', view: 'groups', detail: 'keys', groupId: '', keyId: '', page: 1, issuesOnly: true, report: null };
    const money = value => value == null ? '—' : h.formatMoney(value, '', 8);
    const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${money(value)}`;
    const pct = value => value == null ? '—' : h.formatPercent(value);
    const option = (value, text, selected) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(text)}</option>`;
    const labels = { comparable: '可比较', upstream_high: '上游偏高', upstream_above: '上游高于主站', upstream_missing: '上游数据缺失', site_incomplete: '主站数据不完整', unlinked_key: '有 Key 未关联', mapping_incomplete: '关联待核对', zero: '零消费', history_missing: '历史缺失', stale: '上次快照' };
    const status = value => `<span class="supplier-group-status ${['upstream_high'].includes(value) ? 'bad' : ['upstream_missing', 'site_incomplete', 'unlinked_key', 'mapping_incomplete', 'history_missing', 'stale'].includes(value) ? 'warn' : ''}">${e(labels[value] || value)}</span>`;
    const link = (attr, value, text, label) => `<button type="button" class="accounting-link" ${attr}="${e(value)}"${label ? ` aria-label="${e(label)}" title="${e(label)}"` : ''}>${text}</button>`;
    const table = (headers, rows, cls = '') => `<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map(t => `<th>${t}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map((v, i) => `<td${headers[i].includes('CNY') || headers[i].includes('差额率') || headers[i] === '请求数' ? ' class="numeric"' : ''}>${v}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty-state">当前范围暂无记录</td></tr>`}</tbody></table></div>`;
    root.innerHTML = `<div class="supplier-group-toolbar">
      <label>消费日期<input type="date" data-sg-date></label><label>供应商<select data-sg-provider><option value="">全部供应商</option></select></label>
      <button type="button" class="button secondary" data-sg-settings>${h.icon('sliders-horizontal')}<span>简称与差额提醒</span></button><span class="muted" data-sg-meta></span></div>
      <div class="accounting-subtabs supplier-group-tabs" role="tablist" aria-label="分组消费视图"><button type="button" role="tab" id="sg-tab-groups" aria-controls="sg-main-panel" aria-selected="true" data-sg-view="groups">分组对比</button><button type="button" role="tab" id="sg-tab-mapping" aria-controls="sg-main-panel" aria-selected="false" data-sg-view="mapping">账号关联核对 <span data-sg-issue-count></span></button></div>
      <p data-sg-warning class="accounting-notice" role="status" hidden></p><section id="sg-main-panel" role="tabpanel" aria-labelledby="sg-tab-groups" data-sg-content></section>
      <div class="accounting-pager"><span data-sg-page></span><div><button type="button" class="icon-button" data-sg-step="-1" aria-label="上一页" title="上一页">${h.icon('chevron-left')}</button><button type="button" class="icon-button" data-sg-step="1" aria-label="下一页" title="下一页">${h.icon('chevron-right')}</button></div></div>
      <details class="accounting-rules"><summary>分组归集与消费口径</summary><p>供应商全名或简称形成名称候选，再用完整 Key 指纹确定唯一上游分组。账号名和 Key 有歧义时保留待核对。Key 原文不返回页面，展示尾号不参与匹配。</p><p>上游 Key 消费只计一次；主站以实际使用的账号汇总用户计费金额，按请求所属主站分组拆分，排除 ID 1，保留停用或已删除账号的历史消费。消费差额 = 主站对应消费 − 上游实际消费，差额率以主站消费为分母；未分摊抽奖和其他费用，不能直接认定漏记或经营净利润。</p><p>资金时区每日 01:00 首次归档前一天，今日实时。历史只读归档；没有归档不按当前 Key 关系倒推，不重新查询历史上游消费。缺失不当零；来源与关联均完整的组才计算差额，主站零消费时差额率为空。</p></details>
      <dialog class="accounting-dialog" data-sg-dialog aria-labelledby="sg-dialog-title"><header class="accounting-drawer-header"><h2 id="sg-dialog-title"></h2><button type="button" class="icon-button" data-sg-close aria-label="关闭" title="关闭">${h.icon('x')}</button></header><div class="accounting-drawer-body" data-sg-dialog-body></div></dialog>`;
    function metrics(upstream, main, diff, notes) {
      return `<div class="supplier-group-metrics">${[['上游实际消费', money(upstream), notes[0]], ['已关联主站消费', money(main), notes[1]], ['可比组消费差额', signed(diff), notes[2]]].map(([label, value, note]) => `<div><span>${label}</span><strong class="${label.includes('差额') && diff < 0 ? 'negative-value' : ''}">${e(value)}</strong><small>${e(note)}</small></div>`).join('')}</div>`;
    }
    function render() {
      const r = state.report;
      if (!r) return;
      q('[data-sg-date]').value = state.date; q('[data-sg-date]').max = r.today;
      q('[data-sg-provider]').innerHTML = option('', '全部供应商', state.providerId) + r.providers.map(p => option(p.id, p.name, state.providerId)).join('');
      q('[data-sg-meta]').textContent = `${r.timezone} · CNY · ${r.source === 'live' ? '今日实时' : r.source === 'archive' ? '本地归档' : '历史缺失'}${r.computedAt ? ` · ${h.formatDateTime(r.computedAt)}` : ''}`;
      root.querySelectorAll('[data-sg-view]').forEach(b => { const active = b.dataset.sgView === state.view; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
      q('[data-sg-content]').setAttribute('aria-labelledby', state.view === 'mapping' ? 'sg-tab-mapping' : 'sg-tab-groups');
      q('[data-sg-issue-count]').textContent = r.summary?.issueCount ?? '';
      const notices = [r.warning, ...(r.missingProviders || []).map(p => `${p.name}：${(p.reasons || ['来源缺失']).join('；')}`),
        r.siteComplete === false ? '主站用量未通过原生日桶完整性核验，主站金额与差额暂不核定' : null,
        r.summary?.unassignedProviderCount ? `另有 ${r.summary.unassignedProviderCount} 个账号未定位供应商，可在全部供应商范围核对` : null].filter(Boolean);
      q('[data-sg-warning]').hidden = !notices.length; q('[data-sg-warning]').textContent = notices.join('；');
      q('[data-sg-content]').innerHTML = r.source === 'history_missing' ? '<p class="empty-state">该日没有分组消费归档</p>' : state.view === 'mapping' ? renderMappings(r) : r.group ? renderDetail(r.group) : renderGroups(r);
      const p = r.pagination; q('[data-sg-page]').textContent = `第 ${p.page} / ${Math.max(1, p.totalPages)} 页 · ${p.total} 条`;
      q('[data-sg-step="-1"]').disabled = p.page <= 1; q('[data-sg-step="1"]').disabled = p.page >= p.totalPages;
      root.querySelector('.accounting-pager').hidden = state.detail === 'daily' && Boolean(r.group);
      h.refreshIcons();
    }
    function renderGroups(r) {
      const s = r.summary;
      return metrics(s.upstream, s.main, s.diff, [`${s.knownGroups}/${s.groupCount} 组金额已知 · 已知小计`, `${s.accountCount} 个去重账号 · ${s.localGroupCount} 个主站分组`, `${s.comparableGroups}/${s.groupCount} 组可比 · 未计其他费用`]) +
        table(['上游分组 / 供应商', 'Key / 账号', '主站分组', '上游消费 CNY', '主站消费 CNY', '消费差额 CNY', '差额率', '状态', '明细'],
          (r.groups || []).map(g => [link('data-sg-group', g.id, e(g.name)) + `<small>${e(g.providerName)} · ${e(g.groupRef || '未定位')}</small>`, `${g.keyCount} / ${g.accountCount}`, g.localGroupCount,
            e(money(g.upstream)), e(money(g.main)), `<span class="${g.diff < 0 ? 'negative-value' : ''}">${e(signed(g.diff))}</span>`, e(pct(g.rate)), status(g.status), link('data-sg-group', g.id, h.icon('chevron-right'), '查看分组明细')]), 'supplier-group-table');
    }
    function renderMappings(r) {
      return `<div class="supplier-group-filter"><label class="supplier-group-check"><input type="checkbox" data-sg-issues${state.issuesOnly ? ' checked' : ''}>仅待核对</label></div>` +
        table(['主站账号', '供应商候选', 'Key / 上游分组', '主站消费 CNY', '状态', '依据'], (r.mappings || []).map(a => [
          `<strong>${e(a.name)}</strong><small>#${e(a.id)}${a.deleted ? ' · 已删除' : a.status !== 'active' ? ` · ${e(a.status || '状态未知')}` : ''}</small>`, a.candidates.map(p => e(p.name)).join('<br>') || '未定位',
          `${e(a.maskedKey || '未核验')}<small>${e(a.groupName || '待核对')}</small>`, e(r.siteComplete ? money(a.main) : '—'), a.matched ? '已关联' : e(a.reason), link('data-sg-proof', a.id, '查看')]), 'supplier-group-account-table');
    }
    function renderDetail(g) {
      const tabs = [['keys', 'Key 与账号'], ['local', '按主站分组'], ['daily', '每日对比']];
      let content;
      if (state.detail === 'daily') content = table(['日期', '上游消费 CNY', '主站消费 CNY', '消费差额 CNY', '差额率', '状态'], g.days.map(d => [link('data-sg-day', d.date, e(d.date)), e(money(d.upstream)), e(money(d.main)), e(signed(d.diff)), e(pct(d.rate)), status(d.status)]), 'supplier-group-account-table');
      else if (state.detail === 'local') content = table(['主站分组', '账号', '请求数', '主站消费 CNY'], g.localGroups.map(row => [`${e(row.name)}<small>#${e(row.id)}</small>`, row.accountIds.map(id => `#${e(id)}`).join('、'), row.requests, e(money(row.main))]), 'supplier-group-account-table');
      else {
        const selected = g.keys.find(k => k.id === g.selectedKeyId);
        content = `<div class="supplier-group-key-toolbar"><label>上游 Key<select data-sg-key>${g.keys.map(k => option(k.id, `${k.name} · ${k.maskedKey || '无脱敏标识'} · ${k.accountCount} 个账号`, g.selectedKeyId)).join('')}</select></label><span>上游 ${e(money(selected.upstream))} · 主站 ${e(money(selected.main))}</span></div>` +
          (selected.reasons.length ? `<p class="muted">${selected.reasons.map(e).join('；')}</p>` : '') +
          (!selected.accountCount ? '<p class="accounting-notice">该 Key 尚未关联主站账号，此分组不进入可比组差额。</p>' : '') +
          table(['主站账号', '实际请求所属主站分组 / 消费', '请求数', '账号消费 CNY', '匹配依据'], selected.accounts.map(a => [
            `<strong>${e(a.name)}</strong><small>#${e(a.id)}${a.deleted ? ' · 已删除，保留历史' : a.status !== 'active' ? ' · 当前停用，保留消费' : ''}</small>`,
            a.localGroups.map(row => `<div class="supplier-group-split"><span>${e(row.name)} #${e(row.id)}</span><span>${e(money(row.main))}</span></div>`).join(''), a.requests, e(g.main === null ? '—' : money(a.main)), `${e(a.method)}<small>完整 Key 指纹一致</small>`]), 'supplier-group-account-table');
      }
      return `<div class="supplier-group-heading"><button type="button" class="icon-button" data-sg-back aria-label="返回分组列表" title="返回分组列表">${h.icon('arrow-left')}</button><div><h2>${e(g.providerName)} / ${e(g.name)}</h2><small>${g.keyCount} 个 Key → ${g.accountCount} 个账号 → ${g.localGroupCount} 个主站分组</small></div>${status(g.status)}</div>` +
        (g.reasons.length ? `<p class="accounting-notice">${g.reasons.map(e).join('；')}</p>` : '') +
        metrics(g.upstream, g.main, g.diff, ['供应商分组当日消费', `${g.accountCount} 个去重账号 · ${g.requests} 次请求`, `差额率 ${pct(g.rate)} · 未计其他费用`]) +
        `<div class="accounting-subtabs supplier-group-tabs" role="tablist" aria-label="分组明细">${tabs.map(([id, text]) => `<button type="button" role="tab" id="sg-detail-tab-${id}" aria-controls="sg-detail-panel" aria-selected="${state.detail === id}" tabindex="${state.detail === id ? 0 : -1}" data-sg-detail="${id}">${text}</button>`).join('')}</div><section id="sg-detail-panel" role="tabpanel" aria-labelledby="sg-detail-tab-${state.detail}">${content}</section>`;
    }
    function schedule() { clearTimeout(state.timer); if (state.active && h.isActive() && !document.hidden) state.timer = setTimeout(() => {
      if (q('[data-sg-dialog]').open) return schedule(); load().catch(() => {});
    }, 60000); }
    async function load() {
      state.active = true; clearTimeout(state.timer); state.controller?.abort(); state.controller = new AbortController(); const request = ++state.request;
      const outerEnd = h.query().end;
      if (outerEnd !== state.outerEnd) { state.outerEnd = outerEnd; state.date = outerEnd || ''; state.groupId = ''; state.keyId = ''; state.page = 1; }
      const params = { ...(state.date ? { date: state.date } : {}), providerId: state.providerId, view: state.groupId ? state.detail : state.view,
        ...(state.groupId ? { groupId: state.groupId } : {}), ...(state.keyId ? { keyId: state.keyId } : {}), page: state.page, pageSize: 20, issuesOnly: state.issuesOnly ? '1' : '0' };
      const selection = JSON.stringify([params.date, params.providerId, params.view, params.groupId, params.keyId, params.page, params.issuesOnly]);
      if (selection !== state.selection) {
        state.report = null; state.selection = selection;
        q('[data-sg-content]').innerHTML = '<p class="empty-state" role="status">正在读取分组消费…</p>';
      }
      q('[data-sg-content]').setAttribute('aria-busy', 'true');
      try {
        const report = await h.api(`${base}?${new URLSearchParams(params)}`, { signal: state.controller.signal });
        if (!state.active || request !== state.request || !h.isActive()) return;
        state.report = report; state.date = report.date; state.page = report.pagination.page;
        if (report.group) state.keyId = report.group.selectedKeyId;
        state.selection = JSON.stringify([state.date, params.providerId, params.view, params.groupId, state.keyId || undefined, state.page, params.issuesOnly]);
        render(); h.setPageMeta(`${report.date} · ${report.timezone} · 供应商分组每日消费`);
      } catch (error) {
        if (!state.active || request !== state.request) return;
        if (state.report) {
          state.report.stale = true;
          if (state.report.groups) state.report.groups = state.report.groups.map(g => ({ ...g, diff: null, rate: null, status: 'stale' }));
          if (state.report.group) {
            state.report.group = { ...state.report.group, diff: null, rate: null, status: 'stale',
              days: state.report.group.days.map(d => d.date === state.date ? { ...d, diff: null, rate: null, status: 'stale' } : d) };
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
      if (b.dataset.sgView) { state.view = b.dataset.sgView; state.groupId = ''; state.keyId = ''; state.page = 1; changed = true; }
      if (b.dataset.sgGroup) { state.groupId = b.dataset.sgGroup; state.detail = 'keys'; state.keyId = ''; state.page = 1; changed = true; }
      if (b.hasAttribute('data-sg-back')) { state.groupId = ''; state.keyId = ''; state.page = 1; changed = true; }
      if (b.dataset.sgDetail) { state.detail = b.dataset.sgDetail; state.page = 1; changed = true; }
      if (b.dataset.sgStep) { state.page += Number(b.dataset.sgStep); changed = true; }
      if (b.dataset.sgDay) { state.date = b.dataset.sgDay; state.page = 1; changed = true; }
      if (changed) load();
      if (b.dataset.sgProof) {
        const a = state.report.mappings.find(row => row.id === b.dataset.sgProof); if (!a) return;
        dialog(`${a.name} #${a.id}`, table(['核对项', '依据'], [['名称候选', a.candidates.map(p => e(p.name)).join('、') || '未定位'], ['Key 核验', e(a.maskedKey || '未核验')], ['上游分组', e(a.groupName || '待核对')], ['结论', e(a.reason)], ['主站当日消费 CNY', e(state.report.siteComplete ? money(a.main) : '—')]]));
      }
      if (b.hasAttribute('data-sg-settings') && state.report) {
        state.draft = JSON.parse(JSON.stringify(state.report.settings)); state.aliasProvider = state.report.providers[0]?.id || '';
        dialog('供应商简称与差额提醒', `<form data-sg-settings-form class="accounting-form"><label class="accounting-wide">供应商<select data-sg-alias-provider>${state.report.providers.map(p => option(p.id, p.name, state.aliasProvider)).join('')}</select></label><label class="accounting-wide">供应商简称（每行一个）<textarea data-sg-alias maxlength="2400">${e((state.draft.aliases[state.aliasProvider] || []).join('\n'))}</textarea></label><label class="supplier-group-check accounting-wide"><input type="checkbox" name="enabled"${state.draft.alert.enabled ? ' checked' : ''}>上游超出主站消费时提醒</label><label>超出金额至少（CNY）<input name="amount" type="number" min="0" max="1000000" step="any" value="${state.draft.alert.amount}" required></label><label>超出比例至少（%）<input name="percent" type="number" min="0" max="1000" step="any" value="${state.draft.alert.percent}" required></label><p class="accounting-wide form-error" data-sg-save-error role="alert" hidden></p><div class="accounting-wide form-actions"><button type="submit" class="button primary">${h.icon('save')}<span>保存设置</span></button></div></form>`);
      }
    });
    function captureAlias() { if (state.aliasProvider) state.draft.aliases[state.aliasProvider] = q('[data-sg-alias]').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
    root.addEventListener('change', event => {
      const n = event.target;
      if (n.hasAttribute('data-sg-alias-provider')) { captureAlias(); state.aliasProvider = n.value; q('[data-sg-alias]').value = (state.draft.aliases[n.value] || []).join('\n'); return; }
      if (n.hasAttribute('data-sg-date')) state.date = n.value;
      else if (n.hasAttribute('data-sg-provider')) { state.providerId = n.value; state.groupId = ''; state.keyId = ''; }
      else if (n.hasAttribute('data-sg-issues')) state.issuesOnly = n.checked;
      else if (n.hasAttribute('data-sg-key')) state.keyId = n.value;
      else return;
      state.page = 1; load();
    });
    root.addEventListener('submit', async event => {
      if (!event.target.matches('[data-sg-settings-form]')) return;
      event.preventDefault(); if (state.saving) return;
      const form = event.target, button = form.querySelector('[type=submit]'); state.saving = true; button.disabled = true;
      try {
        captureAlias(); state.draft.alert = { enabled: form.elements.enabled.checked, amount: Number(form.elements.amount.value), percent: Number(form.elements.percent.value) };
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
