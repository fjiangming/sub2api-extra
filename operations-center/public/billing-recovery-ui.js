(function (root) {
  'use strict';
  const labels = { unknown: '结果未知', prepared: '待结算', review: '待核查', settled: '已结算', ignored: '已排除' };
  const checks = { not_checked: '待查单', exact: '唯一账单', unresolved: '未匹配', missing_request_id: '缺少关联 ID',
    in_flight: '等待最终结果', review_ready: '待确认补记', final_usage_missing: '最终用量未知',
    historical_price_missing: '缺少历史价格', cache_ttl_unverified: '缓存时长待核对', usage_conflict: '用量冲突',
    multimodal_pricing_review: '多模态费用待核对', provider_unavailable: '上游查单暂不可用',
    usage_difference: '存在用量差额', verified: '用量一致' };
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = (id) => document.getElementById(id);
    let page = 1, total = 0, selected = null, sequence = 0, busy = false;
    let mode = 'requests';
    const imports = root.BillingImportUi?.create({ api, escapeHtml: esc, refreshIcons, toast, isActive });
    function switchMode(value) {
      mode = value;
      $('br-import-pane').hidden = value !== 'import'; $('br-requests-pane').hidden = value !== 'requests';
      $('br-import-tab').setAttribute('aria-selected', String(value === 'import'));
      $('br-requests-tab').setAttribute('aria-selected', String(value === 'requests'));
      load();
    }
    $('br-import-tab')?.addEventListener('click', () => switchMode('import'));
    $('br-requests-tab')?.addEventListener('click', () => switchMode('requests'));
    const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    const amount = (value) => value == null || value === '' ? '未知' : Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '未知';
    function error(message = '') { $('br-error').textContent = message; $('br-error').hidden = !message; }
    function renderLookup(result) {
      $('br-lookup-result').textContent = !result ? '' : result.exact
        ? `已找到唯一账单 · 请求 ${result.exact.requestId || result.exact.request_id} · 模型 ${result.exact.model || ''} · 上游费用 ${amount(result.exact.actual_cost)} ${result.exact.currency || ''}`
        : `尚未取得唯一账单 · 候选 ${result.candidates || 0} 条${result.truncated || result.coverageComplete === false ? ' · 查询未完整覆盖' : ''}${result.errorCode ? ` · ${result.errorCode}` : ''}`;
      if (result?.exact && result.comparison?.length) {
        const names = { input_tokens: '输入', output_tokens: '输出', cache_creation_tokens: '缓存创建', cache_read_tokens: '缓存读取' };
        $('br-lookup-result').innerHTML += `<div class="table-wrap"><table><thead><tr><th>用量</th><th>上游</th><th>本地记录</th><th>差额</th></tr></thead><tbody>${result.comparison.map(row => `<tr><td>${esc(names[row.field] || row.field)}</td><td>${esc(row.upstream ?? '未知')}</td><td>${esc(row.recorded ?? '未记录')}</td><td>${esc(row.difference ?? '待核查')}</td></tr>`).join('')}</tbody></table></div>`;
      }
    }
    function buttons() {
      $('br-settle').disabled = busy || selected?.state !== 'prepared';
      $('br-approve').disabled = busy || selected?.state !== 'review' || !selected?.usage_record || !$('br-checked').checked;
      $('br-ignore').disabled = busy || !selected || selected.state === 'settled';
      $('br-review').disabled = $('br-ignore').disabled;
      $('br-lookup').disabled = busy || !selected;
      $('br-draft').disabled = busy || !selected || Boolean(selected.usage_record) || !['unknown', 'review'].includes(selected.state);
      $('br-save-usage').disabled = busy || !selected || !['unknown', 'review', 'settled'].includes(selected.state);
      $('br-retry').disabled = busy;
    }
    async function run(action) {
      if (busy) return; busy = true; error(); buttons();
      try { await action(); } catch (cause) { error(cause.message); }
      finally { busy = false; buttons(); }
    }
    async function load() {
      if (mode === 'import') return imports?.load();
      const current = ++sequence;
      try {
        const filters = $('br-filter').elements;
        const query = new URLSearchParams({ state: filters.state.value, user_id: filters.user_id.value, api_key_id: filters.api_key_id.value,
          account_id: filters.account_id.value, request_id: filters.request_id.value.trim(),
          timeout_only: String(filters.timeout_only.checked), page: String(page), page_size: '20' });
        const [result, status] = await Promise.all([api(`/api/billing-recovery?${query}`), api('/api/billing-recovery/status')]);
        if (current !== sequence || !isActive()) return;
        total = result.total;
        $('br-list').innerHTML = result.items.map((row) => {
          const s = row.request_snapshot || {}, u = row.usage_record, observed = row.observed_tokens || {};
          const input = u?.InputTokens ?? observed.input_tokens ?? '未知', output = u?.OutputTokens ?? observed.output_tokens ?? '未知';
          const creation = u?.CacheCreationTokens ?? observed.cache_creation_tokens ?? '未知', read = u?.CacheReadTokens ?? observed.cache_read_tokens ?? '未知';
          const usageState = row.observed_usage?._recovery?.complete === false ? '最终用量待核查' : u ? '本地记录用量' : observed.complete ? '已确认最终用量' : '部分 / 未知用量';
          return `<tr><td>${esc(date(row.created_at))}<small>${esc(row.upstream_request_id || row.id)}</small></td><td>${esc(row.platform || '未知')}<small>${esc(row.model)}</small></td><td>${esc(s.user_email || s.user_name || `用户 ${row.user_id}`)}<small>用户 ${esc(row.user_id)} · Key ${esc(row.api_key_id)} ${esc(s.api_key_name || '')}</small><small>账号 ${esc(row.account_id)} ${esc(s.account_name || '')}</small></td><td>${esc(labels[row.state])}<small>${esc(row.http_status || '等待响应')}</small></td><td>${esc(input)} / ${esc(output)}<small>${esc(usageState)}</small></td><td>${esc(creation)} / ${esc(read)}</td><td>${u ? esc(amount(u.ActualCost)) : '待核定'}</td><td>${esc(checks[row.reconciliation?.status] || row.reconciliation?.status || '待查单')}<small>${esc(row.last_error || row.reconciliation?.last_error || '')}</small></td><td><button class="table-icon-button" data-case="${esc(row.id)}" title="核查详情" aria-label="核查详情">${icon('search')}</button></td></tr>`;
        }).join('') || '<tr><td colspan="9" class="empty-state">暂无记录</td></tr>';
        $('br-pagination').textContent = `共 ${total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(total / 20))} 页`;
        $('br-prev').disabled = page <= 1; $('br-next').disabled = page * 20 >= total;
        $('br-status').textContent = status.automaticEnabled ? status.credentialsConfigured ? `自动查单 / 结算重试已开启${status.lastRun ? ` · 最近 ${date(status.lastRun)}` : ''}` : '自动核查等待持久认证' : '自动核查已暂停';
        if (status.lastError) $('br-status').textContent += ` · ${status.lastError}`;
        setPageMeta(`${total} 条计费记录`); refreshIcons();
      } catch (cause) { if (current === sequence && isActive()) error(cause.message); }
    }
    async function detail(id) {
      const result = await api(`/api/billing-recovery/${encodeURIComponent(id)}`);
      if (!isActive()) return;
      selected = result.case;
      $('br-detail').hidden = false; $('br-title').textContent = `核查记录 · ${labels[selected.state]}`;
      $('br-usage-heading').textContent = selected.state === 'settled' ? '核定最终累计使用记录' : '补充使用记录';
      const usage = selected.usage_record;
      const snapshot = selected.request_snapshot || {}, observed = selected.observed_tokens || {};
      const ids = { dispatch: selected.id, request: snapshot.request_id, client: snapshot.client_request_id,
        upstream: selected.upstream_request_id, ...(selected.observed_usage?._recovery?.response_request_ids || {}) };
      const fields = [['请求标识', Object.entries(ids).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(' · ')],
        ['用户', `${snapshot.user_email || snapshot.user_name || ''} · ID ${selected.user_id}`],
        ['Key / 上游账号', `${selected.api_key_id} ${snapshot.api_key_name || ''} / ${selected.account_id} ${snapshot.account_name || ''}`],
        ['分组 / 端点', `${selected.group_id ?? ''} ${snapshot.group_name || ''} · ${selected.endpoint || ''} → ${snapshot.upstream_path || ''}`],
        ['开始 / 最近观察', `${date(selected.created_at)} / ${date(selected.observed_usage?._recovery?.observed_at || selected.updated_at)} · HTTP ${selected.http_status || '未知'}`],
        ['用量状态', `${usage ? '已有本地记录' : '尚无本地记录'} · ${observed.complete ? '已收到最终用量' : '上游最终用量待核查'}`],
        ['传输', `${snapshot.downstream_stream ? '下游流式' : '下游同步'} · ${snapshot.upstream_stream ? '上游流式' : '上游同步'}${selected.observed_usage?._recovery?.client_disconnected ? ' · 下游已断开' : ''} · 已观察 ${selected.observed_usage?._recovery?.body_duration_ms ?? '未知'} ms`],
        ['已观察用量', `输入 ${observed.input_tokens ?? '未知'} · 输出 ${observed.output_tokens ?? '未知'} · 缓存创建 ${observed.cache_creation_tokens ?? '未知'} · 缓存读取 ${observed.cache_read_tokens ?? '未知'}`],
        ['本地使用记录', usage ? `输入 ${usage.InputTokens} · 输出 ${usage.OutputTokens} · 缓存创建 ${usage.CacheCreationTokens} · 缓存读取 ${usage.CacheReadTokens}` : '尚无记录'],
        ['费用', usage ? `标准 ${amount(usage.TotalCost)} × ${usage.RateMultiplier} = 用户 ${amount(usage.ActualCost)}` : '待核定'],
        ['查单', `${checks[result.reconciliation?.status] || result.reconciliation?.status || '待查单'} · 已查 ${result.reconciliation?.attempts || 0} 次`],
        ['凭据', selected.evidence || '待补充']];
      $('br-summary').innerHTML = fields.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
      $('br-evidence').value = selected.evidence || ''; $('br-checked').checked = false;
      renderLookup(result.reconciliation?.lookup);
      const form = $('br-usage-form'); form.reset();
      for (const input of form.elements) if (input.name && usage?.[input.name] != null) input.value = usage[input.name];
      if (!usage) {
        form.elements.InputTokens.value = observed.input_tokens ?? '';
        form.elements.OutputTokens.value = observed.output_tokens ?? '';
        for (const [name, field] of Object.entries({ CacheCreationTokens: 'cache_creation_tokens', CacheReadTokens: 'cache_read_tokens',
          CacheCreation5mTokens: 'cache_creation_5m_tokens', CacheCreation1hTokens: 'cache_creation_1h_tokens' })) form.elements[name].value = observed[field] ?? '';
      }
      form.elements.Model.value = usage?.Model || selected.model || '';
      $('br-evidence').value = selected.evidence || '';
      $('br-events').innerHTML = (result.events || []).map((event) => `<tr><td>${esc(date(event.created_at))}</td><td>${esc(labels[event.action] || ({ usage_restored: '补充使用记录' })[event.action] || event.action)}</td><td>${esc(event.actor)}</td><td>${esc(event.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">暂无处理记录</td></tr>';
      buttons(); refreshIcons();
    }
    async function review(state) {
      const evidence = $('br-evidence').value.trim();
      if (evidence.length < 8) throw new Error('请填写完整的核查及价格凭据，至少 8 个字符');
      await api(`/api/billing-recovery/${selected.id}/review`, { method: 'POST', body: JSON.stringify({ version: selected.version, state, evidence }) });
      await detail(selected.id); await load();
    }
    $('br-filter').addEventListener('submit', (event) => { event.preventDefault(); page = 1; load(); });
    $('br-filter').elements.state.addEventListener('change', () => { page = 1; load(); });
    $('br-prev').addEventListener('click', () => { page = Math.max(1, page - 1); load(); });
    $('br-next').addEventListener('click', () => { page += 1; load(); });
    $('br-list').addEventListener('click', (event) => { const button = event.target.closest('[data-case]'); if (button) run(() => detail(button.dataset.case)); });
    $('br-close').addEventListener('click', () => { selected = null; $('br-detail').hidden = true; buttons(); });
    $('br-checked').addEventListener('change', buttons);
    $('br-draft').addEventListener('click', () => run(async () => {
      const result = await api(`/api/billing-recovery/${selected.id}/draft`, { method: 'POST', body: '{}' });
      toast(checks[result.status] || result.status);
      await detail(result.caseId || selected.id); await load();
    }));
    $('br-retry').addEventListener('click', () => run(async () => { const result = await api('/api/billing-recovery/retry', { method: 'POST', body: '{}' }); toast(`已恢复 ${result.settled} 条，未完成 ${result.failed} 条`); await load(); }));
    $('br-lookup').addEventListener('click', () => run(async () => {
      const result = await api(`/api/billing-recovery/${selected.id}/lookup`, { method: 'POST', body: '{}' });
      renderLookup(result);
    }));
    $('br-usage-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
      const usage = {}; const form = event.currentTarget;
      for (const input of form.elements) if (input.name && input.name !== 'evidence' && input.value !== '') usage[input.name] = input.type === 'number' ? Number(input.value) : input.value;
      const saved = await api(`/api/billing-recovery/${selected.id}/usage`, { method: 'POST', body: JSON.stringify({ version: selected.version, usage_record: usage, evidence: $('br-evidence').value.trim() }) });
      await detail(saved.case_id || selected.id); await load();
    }); });
    $('br-approve').addEventListener('click', () => run(() => review('prepared')));
    $('br-review').addEventListener('click', () => run(() => review('review')));
    $('br-ignore').addEventListener('click', () => run(() => review('ignored')));
    $('br-settle').addEventListener('click', () => run(async () => {
      await api(`/api/billing-recovery/${selected.id}/settle`, { method: 'POST', body: JSON.stringify({ version: selected.version }) });
      await detail(selected.id); await load(); toast('已按使用记录完成结算');
    }));
    function reset() { sequence += 1; selected = null; page = 1; $('br-detail').hidden = true; imports?.reset(); error(); buttons(); }
    buttons();
    return { load, reset, leave() { sequence += 1; imports?.leave(); } };
  }
  root.BillingRecoveryUi = { create };
})(window);
