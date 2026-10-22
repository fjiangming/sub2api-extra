(function (root) {
  'use strict';
  const labels = { unknown: '结果未知', prepared: '待结算', review: '待核查', settled: '已结算', ignored: '已排除' };
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = (id) => document.getElementById(id);
    let page = 1, total = 0, selected = null, sequence = 0, busy = false;
    const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    const amount = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '';
    function error(message = '') { $('br-error').textContent = message; $('br-error').hidden = !message; }
    function buttons() {
      $('br-settle').disabled = busy || selected?.state !== 'prepared';
      $('br-approve').disabled = busy || selected?.state !== 'review' || !selected?.usage_record || !$('br-checked').checked;
      $('br-ignore').disabled = busy || !selected || selected.state === 'settled';
      $('br-review').disabled = $('br-ignore').disabled;
      $('br-lookup').disabled = busy || !selected;
      $('br-save-usage').disabled = busy || !selected || !['unknown', 'review', 'settled'].includes(selected.state);
      $('br-retry').disabled = busy;
    }
    async function run(action) {
      if (busy) return; busy = true; error(); buttons();
      try { await action(); } catch (cause) { error(cause.message); }
      finally { busy = false; buttons(); }
    }
    async function load() {
      const current = ++sequence;
      try {
        const query = new URLSearchParams({ state: $('br-filter').elements.state.value, page: String(page), page_size: '20' });
        const [result, status] = await Promise.all([api(`/api/billing-recovery?${query}`), api('/api/billing-recovery/status')]);
        if (current !== sequence || !isActive()) return;
        total = result.total;
        $('br-list').innerHTML = result.items.map((row) => `<tr><td>${esc(date(row.created_at))}<small>${esc(row.upstream_request_id || row.id)}</small></td><td>${esc(row.platform || '未知')}<small>${esc(row.model)}</small></td><td>${esc(row.user_id)} / ${esc(row.api_key_id)} / ${esc(row.account_id)}</td><td>${esc(labels[row.state])}</td><td>${row.usage_record ? esc(amount(row.usage_record.ActualCost)) : '待核定'}</td><td>${esc(row.attempts)}<small>${esc(row.last_error)}</small></td><td><button class="table-icon-button" data-case="${esc(row.id)}" title="核查详情" aria-label="核查详情">${icon('search')}</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">暂无记录</td></tr>';
        $('br-pagination').textContent = `共 ${total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(total / 20))} 页`;
        $('br-prev').disabled = page <= 1; $('br-next').disabled = page * 20 >= total;
        $('br-status').textContent = status.automaticEnabled ? status.credentialsConfigured ? `自动恢复已开启${status.lastRun ? ` · 最近 ${date(status.lastRun)}` : ''}` : '自动恢复等待持久认证' : '自动恢复已暂停';
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
      const fields = [['请求标识', selected.upstream_request_id || selected.id], ['用户 / Key / 账号', `${selected.user_id} / ${selected.api_key_id} / ${selected.account_id}`], ['用量', usage ? `输入 ${usage.InputTokens} · 输出 ${usage.OutputTokens} · 缓存创建 ${usage.CacheCreationTokens} · 缓存读取 ${usage.CacheReadTokens}` : Object.entries(selected.observed_usage || {}).filter(([,v]) => typeof v === 'number').map(([k,v]) => `${k}: ${v}`).join(' · ') || '待查单'], ['费用', usage ? `标准 ${amount(usage.TotalCost)} × ${usage.RateMultiplier} = 用户 ${amount(usage.ActualCost)}` : '待核定'], ['凭据', selected.evidence || '待补充']];
      $('br-summary').innerHTML = fields.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
      $('br-evidence').value = selected.evidence || ''; $('br-checked').checked = false;
      $('br-lookup-result').textContent = '';
      const form = $('br-usage-form'); form.reset();
      for (const input of form.elements) if (input.name && usage?.[input.name] != null) input.value = usage[input.name];
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
    $('br-retry').addEventListener('click', () => run(async () => { const result = await api('/api/billing-recovery/retry', { method: 'POST', body: '{}' }); toast(`已恢复 ${result.settled} 条，未完成 ${result.failed} 条`); await load(); }));
    $('br-lookup').addEventListener('click', () => run(async () => {
      const result = await api(`/api/billing-recovery/${selected.id}/lookup`, { method: 'POST', body: '{}' });
      $('br-lookup-result').textContent = result.exact ? `已找到唯一账单 · 请求 ${result.exact.requestId || result.exact.request_id} · 模型 ${result.exact.model || ''} · 输入 ${result.exact.inputTokens ?? result.exact.input_tokens ?? '未知'} · 输出 ${result.exact.outputTokens ?? result.exact.output_tokens ?? '未知'}` : `尚未取得唯一账单 · 候选 ${result.candidates} 条${result.truncated ? ' · 查询未完整覆盖' : ''}`;
      if (result.exact && result.comparison?.length) {
        const names = { input_tokens: '输入', output_tokens: '输出', cache_creation_tokens: '缓存创建', cache_read_tokens: '缓存读取' };
        $('br-lookup-result').innerHTML += `<div class="table-wrap"><table><thead><tr><th>用量</th><th>上游</th><th>本地记录</th><th>差额</th></tr></thead><tbody>${result.comparison.map(row => `<tr><td>${esc(names[row.field] || row.field)}</td><td>${esc(row.upstream ?? '未知')}</td><td>${esc(row.recorded ?? '未记录')}</td><td>${esc(row.difference ?? '待核查')}</td></tr>`).join('')}</tbody></table></div>`;
      }
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
    function reset() { sequence += 1; selected = null; page = 1; $('br-detail').hidden = true; error(); buttons(); }
    buttons();
    return { load, reset, leave() { sequence += 1; } };
  }
  root.BillingRecoveryUi = { create };
})(window);
