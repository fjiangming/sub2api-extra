(function (root) {
  'use strict';
  const labels = { unmatched: '未匹配', unmapped: '待映射账号', invalid: '数据无效', duplicate: '重复行', ambiguous: '多个候选',
    exact: '请求 ID 匹配', time_candidate: '时间候选', assignment_conflict: '归属冲突', already_recorded: '已确认本地扣费',
    owner_candidate: '已定位用户，请求待核查', billing_unresolved: '有记录，扣费待核查', time_uncertain: '时间证据不足', recorded_conflict: '多笔账单争用本地记录',
    usage_difference: '已有记录，用量不同', needs_review: '待核查', preview: '待确认扣费', confirming: '结算待恢复', failed: '结算未完成', settled: '已补记扣费' };
  const fieldNames = { time: '时间', key: '上游 Key 名称', model: '模型', requestId: '请求 ID', input: '输入 Token', output: '输出 Token',
    cacheRead: '缓存读取 Token', cacheCreation: '缓存创建 Token', cache5m: '缓存创建 5m', cache1h: '缓存创建 1h',
    duration: '总耗时（ms）', cost: '上游支出', type: '同步 / 流式', endpoint: '入站接口', billingMode: '计费模式' };
  function create({ api, escapeHtml: esc, refreshIcons, toast, isActive }) {
    const $ = id => document.getElementById(id);
    let accounts = [], batch = null, fileText = null, columns = {}, busy = false, epoch = 0, dirty = false, matchDirty = false;
    const rules = new Map(), assignments = new Map();
    const amount = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '未知';
    const units = value => value == null ? null : BigInt(value.replace('.', ''));
    const fixed = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100000000n}.${((value < 0n ? -value : value) % 100000000n).toString().padStart(8, '0')}`;
    const difference = value => value == null ? '未知' : value > 0n ? `上游多扣 ${fixed(value)}` : value < 0n ? `本站拟多收 ${fixed(-value)}` : '持平 0.00000000';
    function totals(rows) {
      let supplier = 0n, local = 0n, unknown = 0;
      for (const row of rows) {
        const comparison = row.costComparison;
        local += units(comparison?.localCost) ?? units(amount(row.preview.usage.ActualCost));
        if (comparison?.supplierCost == null) unknown++;
        else supplier += units(comparison.supplierCost);
      }
      return { supplier, local, unknown };
    }
    const supplierAmount = total => `${total.unknown ? `已知 ${fixed(total.supplier)} · ${total.unknown} 笔未知` : fixed(total.supplier)}`;
    const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    function candidateDetails(item) {
      return !item ? '' : `<small>用户 ${esc(item.userId)} · Key ${esc(item.apiKeyId)} · 账号 ${esc(item.accountId)} · 分组 ${esc(item.groupId)}</small><small>${esc(item.reference)}${item.statusCode ? ` · HTTP ${esc(item.statusCode)}` : ''}</small><small>${item.startUncertain ? '开始时间范围' : '本地开始'} ${esc(date(item.startMs))}${item.startUncertain ? ` 至 ${esc(date(item.endMs))}` : ''}</small>${item.recorded ? `<small>本地实际费用 ${esc(amount(item.cost))} · ${item.billed ? '已确认原生扣费' : '原生扣费未确认'}</small>` : ''}`;
    }
    function error(message = '') { $('bci-error').textContent = message; $('bci-error').hidden = !message; }
    function chosen() { return [...$('bci-list').querySelectorAll('[data-select]:checked')].map(input => batch.rows.find(row => row.id === input.dataset.select)).filter(Boolean); }
    function update() {
      const rows = batch ? chosen().filter(row => ['preview', 'failed', 'confirming'].includes(row.status) && row.preview) : [];
      const total = totals(rows);
      const users = new Set(rows.map(row => row.preview.userId));
      $('bci-total').textContent = rows.length ? `本页所选 ${rows.length} 笔 · ${users.size} 位用户 · 补记 ${fixed(total.local)} USD` : '待生成预览';
      const balances = rows.filter(row => row.preview.billingType === 'balance'), balance = totals(balances);
      const subscriptions = rows.filter(row => row.preview.billingType === 'subscription'), subscription = totals(subscriptions);
      $('bci-cost-preview').hidden = !rows.length;
      $('bci-cost-note').hidden = !rows.length;
      $('bci-cost-preview').innerHTML = rows.length ? `<table><thead><tr><th>本页所选预览</th><th>笔数</th><th>上游支出（USD）</th><th>本站拟补记（USD）</th><th>上游多扣余额差额（USD）</th></tr></thead><tbody>${
        [[balances, balance, '余额补扣'], [subscriptions, subscription, '订阅用量']].filter(([items]) => items.length).map(([items, value, name]) => `<tr><td>${name}</td><td>${items.length}</td><td>${supplierAmount(value)}</td><td>${fixed(value.local)}</td><td>${items === subscriptions ? '不适用：订阅用量' : value.unknown ? '未知：上游费用不完整' : difference(value.supplier - value.local)}</td></tr>`).join('')
      }</tbody></table>` : '';
      $('bci-confirm').disabled = busy || dirty || matchDirty || !rows.length || !$('bci-acknowledge').checked;
      $('bci-preview').disabled = busy || matchDirty || !batch || !chosen().length;
      for (const button of $('br-import-pane').querySelectorAll('button:not(#bci-confirm):not(#bci-preview)')) button.disabled = busy;
      $('bci-prev').disabled = busy || !batch || batch.page <= 1;
      $('bci-next').disabled = busy || !batch || batch.page * 20 >= batch.filteredTotal;
      const grouped = new Map();
      for (const row of rows) {
        const value = row.preview, key = `${value.userId}:${value.billingType}`;
        const group = grouped.get(key) || { name: value.userEmail || `用户 ${value.userId}`, userId: value.userId, type: value.billingType, rows: [] };
        group.rows.push(row); grouped.set(key, group);
      }
      $('bci-user-preview').hidden = !grouped.size;
      $('bci-user-preview').innerHTML = grouped.size ? `<table><thead><tr><th>所选用户</th><th>计费类型</th><th>笔数</th><th>上游支出（USD）</th><th>补记合计（USD）</th><th>上游多扣余额差额（USD）</th></tr></thead><tbody>${[...grouped.values()].map(group => {
        const value = totals(group.rows);
        return `<tr><td>${esc(group.name)} · ${esc(group.userId)}</td><td>${group.type === 'subscription' ? '订阅用量' : '余额'}</td><td>${group.rows.length}</td><td>${supplierAmount(value)}</td><td>${fixed(value.local)}</td><td>${group.type === 'subscription' ? '不适用：订阅用量' : value.unknown ? '未知：上游费用不完整' : difference(value.supplier - value.local)}</td></tr>`;
      }).join('')}</tbody></table>` : '';
    }
    async function run(action) {
      if (busy) return; busy = true; error(); update();
      try { await action(); } catch (cause) { error(cause.message); }
      finally { busy = false; update(); refreshIcons(); }
    }
    function renderColumns(headers, detected) {
      $('bci-columns-box').hidden = false;
      $('bci-columns').innerHTML = Object.entries(fieldNames).map(([key, name]) => `<label>${esc(name)}<select data-column="${key}"><option value="">自动识别 / 无此列</option>${headers.map(header => `<option value="${esc(header)}"${detected[key] === header ? ' selected' : ''}>${esc(header)}</option>`).join('')}</select></label>`).join('');
      columns = { ...detected };
    }
    function readColumns() {
      const result = {};
      for (const input of $('bci-columns').querySelectorAll('[data-column]')) result[input.dataset.column] = input.value;
      return result;
    }
    function readPrices() {
      for (const tr of $('bci-price-list').querySelectorAll('[data-model]')) {
        const value = {};
        for (const input of tr.querySelectorAll('[data-price]')) value[input.dataset.price] = input.tagName === 'SELECT' ? input.value : input.value === '' ? null : Number(input.value);
        rules.set(tr.dataset.model, value);
      }
    }
    function renderPrices() {
      const models = [...new Set(batch.rows.map(row => row.record.model))];
      $('bci-price-list').innerHTML = models.map(model => {
        const rule = rules.get(model) || {};
        return `<tr data-model="${esc(model)}"><td>${esc(model)}</td>${['input','output','cacheRead','cache5m','cache1h','multiplier','accountMultiplier'].map(key => `<td><input data-price="${key}" type="number" min="0" step="any" aria-label="${esc(model)} ${key}" value="${esc(rule[key] ?? (['multiplier','accountMultiplier'].includes(key) ? 1 : ''))}"></td>`).join('')}<td><select data-price="cacheTTL" aria-label="${esc(model)} 缓存归属">${[['split','按 CSV 明细'],['5m','全部 5 分钟'],['1h','全部 1 小时']].map(([value, name]) => `<option value="${value}"${(rule.cacheTTL || 'split') === value ? ' selected' : ''}>${name}</option>`).join('')}</select></td></tr>`;
      }).join('');
    }
    function render() {
      $('bci-workspace').hidden = false; $('bci-title').textContent = batch.fileName;
      const summary = batch.summary;
      $('bci-summary').textContent = `共 ${batch.total} 条 · 已确认扣费 ${summary.already_recorded || 0} · 可预览 ${(summary.exact || 0) + (summary.time_candidate || 0)} · 已定位待核查 ${summary.owner_candidate || 0} · 扣费异常 ${summary.billing_unresolved || 0} · 已补记 ${summary.settled || 0} 条`;
      const diagnostics = batch.matchDiagnostics;
      $('bci-diagnostics').textContent = diagnostics?.algorithmVersion === 2 ? [
        ...(diagnostics.clocks || []).map(clock => `${clock.key || '未命名 Key'}：${clock.effective === 'end' ? '结束时间' : clock.effective === 'start' ? '开始时间' : '时间含义待确认'}，开始 / 结束证据 ${clock.start} / ${clock.end}${clock.conflict ? '，设置与证据冲突，请重新匹配' : ''}`),
        diagnostics.logs?.status === 'read' ? '已读取文件日志，覆盖范围不保证完整' : '未读取文件日志，历史取消请求可能缺少归属证据',
        diagnostics.coreAvailable === false ? '主站历史预留接口不可用' : ''
      ].filter(Boolean).join('；') : '请自动匹配；旧版匹配和预览需要重新核查。';
      $('bci-filter').value = batch.filter;
      const form = $('bci-match');
      for (const key of ['timezone','timeKind','toleranceSeconds','clockOffsetSeconds']) form.elements[key].value = batch.options[key];
      form.elements.inputIncludesCache.checked = batch.options.inputIncludesCache;
      $('bci-mappings').innerHTML = batch.keys.map(key => `<label>${esc(key || '未命名上游 Key')} 对应账号<select data-key="${esc(key)}"><option value="">选择上游账号</option>${accounts.map(account => `<option value="${esc(account.id)}"${String(batch.options.accountMappings[key] || '') === String(account.id) ? ' selected' : ''}>${esc(account.name)} · ${esc(account.id)}</option>`).join('')}</select></label>`).join('');
      renderColumns(batch.headers, batch.columns);
      $('bci-list').innerHTML = batch.rows.map(row => {
        const record = row.record, preview = row.preview, candidates = row.match?.candidates || [];
        const selected = assignments.get(row.id) || row.selection || row.match?.selected || '';
        const eligible = row.match?.algorithmVersion === 2 && !['invalid','duplicate','unmapped','unmatched','already_recorded','usage_difference','billing_unresolved','recorded_conflict','time_uncertain','settled'].includes(row.status) &&
          (Boolean(preview) || candidates.some(item => !item.recorded && !item.blockedReason));
        const candidate = preview ? `用户 ${preview.userId} · ${preview.userEmail} · Key ${preview.apiKeyId}` : '';
        const options = candidates.map(item => `<option value="${esc(item.reference)}"${selected === item.reference ? ' selected' : ''}${item.recorded || item.blockedReason ? ' disabled' : ''}>用户 ${esc(item.userId)} · Key ${esc(item.apiKeyId)} · ${esc(item.userEmail)} · ${esc(item.reference)} · ${esc((item.timeDifferenceMs / 1000).toFixed(3))}s${item.recorded ? ' · 已记账' : item.blockedReason ? ` · ${esc(item.blockedReason)}` : ''}</option>`).join('');
        const status = row.result?.error || row.match?.reason || record.error || (row.status === 'settled' ? `账单 ${row.case_id}` : '');
        const dims = record.tokens || {};
        const owner = row.match?.owner;
        const comparison = row.costComparison;
        const gap = !preview ? '待生成预览' : preview.billingType === 'subscription' ? '不适用：订阅用量' : difference(units(comparison?.balanceDifference));
        const details = candidateDetails(candidates.find(item => item.reference === selected) || (candidates.length === 1 ? candidates[0] : null));
        return `<tr><td><input data-select="${row.id}" type="checkbox" aria-label="选择第 ${row.number} 行"${eligible ? selected || preview ? ' checked' : '' : ' disabled'}></td><td>${esc(row.number)} · ${esc(date(record.startedAt))}<small>${esc(record.model)}</small><small>${esc(record.requestId || record.key)}</small></td><td>${preview ? `<span>${esc(candidate)}</span><small>${preview.billingType === 'subscription' ? '订阅用量' : '余额计费'}</small>` : owner ? `<span>用户 ${esc(owner.userId)} · Key ${esc(owner.apiKeyId)} · 分组 ${esc(owner.groupId)}</span>` : ''}<select data-assignment="${row.id}" aria-label="第 ${row.number} 行匹配用户"${preview || !eligible ? ' disabled' : ''}><option value="">选择候选请求</option>${options}</select><div data-candidate="${row.id}">${details}</div></td><td>${esc(labels[row.status] || row.status)}${row.match?.method === 'time' && eligible ? `<small>${row.selection_confirmed ? '时间归属已核对' : '按时间匹配，待人工确认'}</small>` : row.match?.method === 'tokens_time' ? '<small>Token 与时间核对</small>' : ''}</td><td>${esc(dims.InputTokens ?? '未知')} / ${esc(dims.OutputTokens ?? '未知')}<small>缓存 ${esc(dims.CacheCreationTokens ?? '未知')} / ${esc(dims.CacheReadTokens ?? '未知')}</small></td><td>${esc(comparison?.supplierCost ?? (record.cost || '未知'))}</td><td>${preview ? `${esc(amount(preview.usage.ActualCost))} USD<small>${preview.pricingSource === 'immutable_dispatch_snapshot' ? '请求历史价格快照' : '人工核定历史售价'}</small><small>售卖倍率 ${esc(preview.usage.RateMultiplier)}</small>` : '待核定'}</td><td data-cost-gap>${esc(gap)}</td><td>${esc(status)}</td></tr>`;
      }).join('');
      $('bci-page').textContent = `${batch.filteredTotal} 条 · 第 ${batch.page} / ${Math.max(1, Math.ceil(batch.filteredTotal / 20))} 页`;
      $('bci-prev').disabled = batch.page <= 1; $('bci-next').disabled = batch.page * 20 >= batch.filteredTotal;
      $('bci-select-all').checked = false; $('bci-acknowledge').checked = false;
      renderPrices(); dirty = false; matchDirty = false; update(); refreshIcons();
    }
    async function open(id, page = 1, filter = batch?.filter || 'all') {
      const current = ++epoch;
      const result = await api(`/api/billing-imports/${encodeURIComponent(id)}?page=${page}&filter=${encodeURIComponent(filter)}`);
      if (current !== epoch || !isActive()) return;
      batch = result; render();
    }
    async function load() {
      const current = ++epoch;
      try {
        const result = await api('/api/billing-imports/options');
        if (current !== epoch || !isActive()) return;
        accounts = result.accounts;
        $('bci-batches').innerHTML = '<option value="">选择批次</option>' + result.batches.map(item => `<option value="${item.id}"${batch?.id === item.id ? ' selected' : ''}>${esc(item.file_name)} · ${item.settled || 0}/${item.total}</option>`).join('');
        if (batch) await open(batch.id, batch.page);
      } catch (cause) { if (current === epoch && isActive()) error(cause.message); }
    }
    async function inspectFile() {
      fileText = null;
      const file = $('bci-file').files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error('CSV 不能超过 8 MiB');
      fileText = new TextDecoder($('bci-encoding').value, { fatal: true }).decode(await file.arrayBuffer());
      const result = await api('/api/billing-imports/inspect', { method: 'POST', body: JSON.stringify({ csv: fileText }) });
      renderColumns(result.headers, result.columns);
      matchDirty = Boolean(batch); $('bci-acknowledge').checked = false;
    }
    $('bci-file').addEventListener('change', () => run(inspectFile));
    $('bci-encoding').addEventListener('change', () => run(inspectFile));
    $('bci-upload').addEventListener('submit', event => { event.preventDefault(); run(async () => {
      if (!fileText) await inspectFile();
      const result = await api('/api/billing-imports', { method: 'POST', body: JSON.stringify({ fileName: $('bci-file').files[0].name, csv: fileText, options: { columns: readColumns() } }) });
      rules.clear(); assignments.clear(); batch = result; render(); await load();
    }); });
    $('bci-batches').addEventListener('change', () => { if ($('bci-batches').value) run(async () => { rules.clear(); assignments.clear(); await open($('bci-batches').value); }); });
    $('bci-match').addEventListener('submit', event => { event.preventDefault(); run(async () => {
      const form = event.currentTarget, accountMappings = Object.create(null);
      for (const input of $('bci-mappings').querySelectorAll('[data-key]')) if (input.value) accountMappings[input.dataset.key] = Number(input.value);
      const result = await api(`/api/billing-imports/${batch.id}/match`, { method: 'POST', body: JSON.stringify({
        timezone: form.elements.timezone.value.trim(), timeKind: form.elements.timeKind.value,
        toleranceSeconds: Number(form.elements.toleranceSeconds.value), clockOffsetSeconds: Number(form.elements.clockOffsetSeconds.value),
        inputIncludesCache: form.elements.inputIncludesCache.checked, accountMappings, columns: readColumns() }) });
      assignments.clear(); batch = result; render();
      if (!result.coreAvailable) error('已读取原版日志。执行补记前需要更新支持历史导入的主站版本。');
    }); });
    $('bci-list').addEventListener('change', event => {
      if (event.target.dataset.assignment) {
        assignments.set(event.target.dataset.assignment, event.target.value);
        const checkbox = $('bci-list').querySelector(`[data-select="${event.target.dataset.assignment}"]`);
        checkbox.checked = Boolean(event.target.value); dirty = true; $('bci-acknowledge').checked = false;
        const row = batch.rows.find(item => item.id === event.target.dataset.assignment);
        $('bci-list').querySelector(`[data-candidate="${row.id}"]`).innerHTML = candidateDetails(row.match?.candidates.find(item => item.reference === event.target.value));
      }
      update();
    });
    for (const name of ['bci-match', 'bci-columns']) $(name).addEventListener('input', () => {
      matchDirty = true; $('bci-acknowledge').checked = false; update();
    });
    $('bci-select-all').addEventListener('change', event => { for (const input of $('bci-list').querySelectorAll('[data-select]:not(:disabled)')) input.checked = event.target.checked; update(); });
    $('bci-filter').addEventListener('change', () => run(async () => { readPrices(); await open(batch.id, 1, $('bci-filter').value); }));
    for (const name of ['bci-price-list','bci-price-evidence','bci-assignment-evidence','bci-time-checked','bci-final-usage','bci-cache-zero']) $(name).addEventListener('input', () => { dirty = true; $('bci-acknowledge').checked = false; update(); });
    $('bci-acknowledge').addEventListener('change', update);
    $('bci-preview').addEventListener('click', () => run(async () => {
      readPrices();
      const pricing = Object.create(null);
      for (const row of chosen()) {
        const rule = rules.get(row.record.model);
        if (rule) pricing[row.record.model] = Object.fromEntries(Object.entries(rule).filter(([, value]) => value != null));
      }
      const result = await api(`/api/billing-imports/${batch.id}/preview`, { method: 'POST', body: JSON.stringify({ rowIds: chosen().map(row => row.id),
        assignments: Object.fromEntries(assignments), pricing, pricingEvidence: $('bci-price-evidence').value.trim(),
        assignmentEvidence: $('bci-assignment-evidence').value.trim(), confirmTimeMatches: $('bci-time-checked').checked,
        finalUsageConfirmed: $('bci-final-usage').checked, missingCacheIsZero: $('bci-cache-zero').checked }) });
      await open(result.detail.id, batch.page); toast('扣费预览已生成');
    }));
    $('bci-confirm').addEventListener('click', () => run(async () => {
      const rows = chosen().filter(row => row.preview && ['preview','failed','confirming'].includes(row.status)).map(row => ({ id: row.id, version: row.version, previewId: row.preview.id }));
      const result = await api(`/api/billing-imports/${batch.id}/confirm`, { method: 'POST', body: JSON.stringify({ acknowledge: $('bci-acknowledge').checked, rows }) });
      await open(batch.id, batch.page); toast(`已补记 ${result.results.filter(row => row.status === 'settled').length} 笔`);
    }));
    for (const [name, direction] of [['bci-prev',-1],['bci-next',1]]) $(name).addEventListener('click', () => run(async () => { readPrices(); await open(batch.id, batch.page + direction); }));
    update();
    return { load, leave() { epoch++; }, reset() {
      epoch++; batch = null; fileText = null; rules.clear(); assignments.clear(); dirty = false; matchDirty = false;
      $('bci-upload').reset(); $('bci-workspace').hidden = true; $('bci-columns-box').hidden = true;
      for (const name of ['bci-price-evidence', 'bci-assignment-evidence']) $(name).value = '';
      for (const name of ['bci-final-usage','bci-time-checked','bci-cache-zero','bci-acknowledge']) $(name).checked = false;
      for (const name of ['bci-list','bci-price-list','bci-columns','bci-mappings']) $(name).replaceChildren();
      for (const name of ['bci-summary','bci-diagnostics','bci-title']) $(name).textContent = '';
      error(); update();
    } };
  }
  root.BillingImportUi = { create };
})(window);
