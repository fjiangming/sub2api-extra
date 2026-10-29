(function (root) {
  'use strict';
  const MATCH_VERSION = 6;
  const PREVIEW_CHUNK_SIZE = 20;
  const labels = { unmatched: '未匹配', unmapped: '待映射账号', invalid: '数据无效', duplicate: '重复行', ambiguous: '多个候选',
    exact: '待自动报价', time_candidate: '待自动报价', group_candidate: '整组待核价', assignment_conflict: '归属冲突', already_recorded: '已计费',
    already_imported: '此前已补记', import_pending: '此前已认领，待续办',
    owner_candidate: '已定位用户，请求待核查', billing_unresolved: '有记录，扣费待核查', time_uncertain: '时间证据不足', recorded_conflict: '多笔账单争用本地记录',
    usage_difference: '已有记录，用量不同', needs_review: '待核查', preview: '可补记，待确认', confirming: '结算待恢复', failed: '结算未完成', settled: '已补记' };
  const fieldNames = { time: '时间', key: '上游 Key 名称', model: '模型', requestId: '请求 ID', input: '输入 Token', output: '输出 Token',
    cacheRead: '缓存读取 Token', cacheCreation: '缓存创建 Token', cache5m: '缓存创建 5m', cache1h: '缓存创建 1h',
    duration: '总耗时（ms）', cost: '上游支出', type: '同步 / 流式', endpoint: '入站接口', billingMode: '计费模式' };
  function create({ api, escapeHtml: esc, refreshIcons, isActive }) {
    const $ = id => document.getElementById(id);
    let accounts = [], batch = null, fileText = null, columns = {}, busy = false, epoch = 0, dirty = false, matchDirty = false;
    const rules = new Map(), assignments = new Map();
    const selection = new Map(), rowCache = new Map();
    const dateFormats = new Map();
    let selectionBatch = null, defaultSelection = true;
    const taskActive = task => ['queued', 'running'].includes(task?.status);
    const pause = () => new Promise(resolve => setTimeout(resolve, 2000));
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
    const settledReceipt = row => row?.status === 'settled' && row.case_id && row.result?.caseId === row.case_id &&
      row.preview && amount(row.result.amount) === amount(row.preview.usage.ActualCost);
    const date = value => {
      if (value == null || value === '') return '';
      try {
        const timezone = batch?.options.timezone || 'Asia/Shanghai';
        if (!dateFormats.has(timezone)) dateFormats.set(timezone, new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: timezone
        }));
        return dateFormats.get(timezone).format(new Date(value));
      }
      catch { return new Date(value).toISOString(); }
    };
    function candidateDetails(item) {
      const source = { usage: '使用记录', case: '持久异常记录', error: '数据库错误日志', log: '业务文件日志' }[item?.kind] || '';
      const usage = item?.usageEvidence;
      return !item ? '' : `<small>用户 ${esc(item.userId)} · Key ${esc(item.apiKeyId)} · 账号 ${esc(item.accountId)} · 分组 ${esc(item.groupId)}</small><small>${esc(source)} · ${esc(item.reference)}${item.statusCode ? ` · HTTP ${esc(item.statusCode)}` : ''}</small>${item.sourceEvidence?.length > 1 ? `<small>已关联 ${item.sourceEvidence.length} 份来源证据</small>` : ''}<small>${item.startUncertain ? '开始时间范围' : '本地开始'} ${esc(date(item.startMs))}${item.startUncertain ? ` 至 ${esc(date(item.endMs))}` : ''}</small>${usage && !usage.invalid && usage.supported && Object.values(usage.tokens).some(value => value != null) ? `<small>${usage.complete ? '最终' : '已观察'}输入 / 输出 Token：${esc(usage.tokens.InputTokens ?? '未知')} / ${esc(usage.tokens.OutputTokens ?? '未知')}</small>` : ''}${item.recorded ? `<small>本地实际费用 ${esc(amount(item.cost))} · ${item.billed ? '已确认原生扣费' : '原生扣费未确认'}</small>` : ''}`;
    }
    function feedback(message = '', kind = 'status') {
      $('bci-action-status').textContent = message;
      $('bci-action-status').dataset.kind = kind;
      $('bci-action-status').hidden = !message;
    }
    function error(message = '') {
      $('bci-error').textContent = message; $('bci-error').hidden = !message;
      if (message) feedback(message, 'error');
    }
    function clearSelection(batchId = batch?.id, defaults = true) {
      selection.clear(); rowCache.clear(); selectionBatch = batchId; defaultSelection = defaults;
    }
    function eligible(row) {
      const legacy = [3, 4, 5].includes(row.match?.algorithmVersion) && ['failed', 'confirming'].includes(row.status) && row.preview;
      return (row.match?.algorithmVersion === MATCH_VERSION || legacy) &&
        !['invalid','duplicate','unmapped','unmatched','already_recorded','already_imported','import_pending','usage_difference','billing_unresolved','recorded_conflict','time_uncertain','settled'].includes(row.status) &&
        (Boolean(row.preview) || row.match?.candidates?.some(item => !item.recorded && !item.blockedReason));
    }
    function remember(detail, autoSelect = true) {
      for (const row of [...(detail.relatedRows || []), ...(detail.rows || [])]) {
        rowCache.set(row.id, row);
        if (!eligible(row)) selection.delete(row.id);
        else if (!selection.has(row.id)) selection.set(row.id, autoSelect && defaultSelection &&
          Boolean((assignments.has(row.id) ? assignments.get(row.id) : row.selection || row.match?.selected) || row.preview || row.status === 'group_candidate'));
      }
    }
    function select(row, checked) {
      for (const id of row.preview?.group?.memberIds || [row.id]) {
        const member = rowCache.get(id);
        if (member && eligible(member)) selection.set(id, checked);
      }
      $('bci-acknowledge').checked = false;
    }
    function syncSelection() {
      const locked = busy || taskActive(batch?.task);
      const inputs = [...$('bci-list').querySelectorAll('[data-select]')];
      for (const input of inputs) {
        input.checked = selection.get(input.dataset.select) === true;
        input.disabled = locked || !eligible(rowCache.get(input.dataset.select));
      }
      for (const input of $('bci-list').querySelectorAll('[data-assignment]')) {
        const row = rowCache.get(input.dataset.assignment);
        input.disabled = locked || Boolean(row.preview) || Boolean(row.match?.candidateGroup?.auditEligible) || !eligible(row);
      }
      const available = inputs.filter(input => eligible(rowCache.get(input.dataset.select)));
      const count = available.filter(input => input.checked).length;
      $('bci-select-all').checked = Boolean(available.length) && count === available.length;
      $('bci-select-all').indeterminate = count > 0 && count < available.length;
      $('bci-select-all').disabled = locked || !available.length;
    }
    function chosen() {
      const picked = new Map([...selection].filter(([, checked]) => checked).map(([id]) => [id, rowCache.get(id)]).filter(([, row]) => row));
      for (const row of [...picked.values()]) for (const id of row.preview?.group?.memberIds || []) if (rowCache.has(id)) picked.set(id, rowCache.get(id));
      return [...picked.values()];
    }
    async function refreshSelected(batchId, rowIds = chosen().map(row => row.id)) {
      const current = epoch;
      for (let offset = 0; offset < rowIds.length; offset += 400) {
        const detail = await api(`/api/billing-imports/${encodeURIComponent(batchId)}/rows`, {
          method: 'POST', body: JSON.stringify({ rowIds: rowIds.slice(offset, offset + 400) })
        });
        if (selectionBatch !== batchId || current !== epoch) return;
        remember(detail);
      }
    }
    function previewRowIds(rows) {
      const groups = new Set();
      return rows.filter(row => {
        const group = row.preview?.group?.identity || (row.match?.candidateGroup?.auditEligible ? row.match.candidateGroup.id : null);
        if (!group) return true;
        if (groups.has(group)) return false;
        groups.add(group);
        return true;
      }).map(row => row.id);
    }
    function taskFeedback(task) {
      const progress = task.progress || {};
      const phase = { queued: '等待处理', rechecking: '正在复核完整主站证据', quoting: '正在逐笔核价', settling: '正在补记并读取主站结算回执' }[progress.phase] || '正在处理';
      feedback(`后台${task.kind === 'preview' ? '预览' : '补记'}：${phase}；已处理 ${progress.completed || 0} / ${progress.total || 0} 笔${progress.rowNumber ? `，当前 CSV 第 ${progress.rowNumber} 行` : ''}。${task.kind === 'preview' ? '尚未补记或扣费。' : '请等待主站回执，勿重复提交。'}`);
    }
    async function waitTask(task, current, batchId) {
      let failures = 0;
      while (taskActive(task)) {
        if (current !== epoch || !isActive()) return null;
        if (batch?.id === batchId) batch.task = task;
        taskFeedback(task);
        try {
          ({ task } = await api(`/api/billing-imports/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(task.id)}`));
          failures = 0;
        } catch (cause) {
          if (++failures >= 3) throw new Error(`无法读取后台进度：${cause.message}。任务可能仍在运行，请刷新当前批次核对，勿重复导入或提交。`);
          feedback('进度连接暂时中断，正在重新读取；后台任务不受页面连接影响。');
        }
        if (taskActive(task)) await pause();
      }
      if (current !== epoch || !isActive()) return null;
      if (batch?.id === batchId) batch.task = task;
      return task;
    }
    async function runTask(kind, input, current, batchId) {
      const id = root.crypto.randomUUID();
      let task;
      try {
        ({ task } = await api(`/api/billing-imports/${encodeURIComponent(batchId)}/tasks`, {
          method: 'POST', body: JSON.stringify({ id, kind, input })
        }));
      } catch (cause) {
        // A lost acceptance response must only read the same task, never replay
        // a money command with a new identity.
        try { ({ task } = await api(`/api/billing-imports/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(id)}`)); }
        catch { throw new Error(`提交结果未确认：${cause.message}。请刷新当前批次核对任务和回执。`); }
      }
      task = await waitTask(task, current, batchId);
      if (!task) return null;
      if (task.status !== 'succeeded') throw new Error(task.error?.message || '后台任务未完成，请刷新核对已保存的记录。');
      return task.result;
    }
    async function generatePreviewChunks(rowIds, body, current, batchId) {
      const results = [];
      const chunks = [];
      for (let offset = 0; offset < rowIds.length; offset += PREVIEW_CHUNK_SIZE) {
        chunks.push(rowIds.slice(offset, offset + PREVIEW_CHUNK_SIZE));
      }
      for (let index = 0; index < chunks.length; index++) {
        if (current !== epoch || !isActive()) break;
        $('bci-page').textContent = `生成预览批次 ${index + 1} / ${chunks.length}`;
        feedback(`正在生成扣费预览：第 ${index + 1} / ${chunks.length} 批；尚未补记或扣费。`);
        const chunkRows = chunks[index].map(id => rowCache.get(id)).filter(Boolean);
        const pricing = Object.fromEntries(chunkRows.map(row => [row.record.model, body.pricing?.[row.record.model]]).filter(([, rule]) => rule));
        const assignments = Object.fromEntries(chunks[index].filter(id => Object.hasOwn(body.assignments || {}, id)).map(id => [id, body.assignments[id]]));
        const response = await runTask('preview', { ...body, pricing, assignments, rowIds: chunks[index] }, current, batchId);
        if (!response) break;
        results.push(...response.results);
        if (current !== epoch || !isActive()) break;
        await refreshSelected(batchId, response.results.map(row => row.rowId));
        for (const row of response.results) if (row.status === 'needs_review') selection.set(row.rowId, false);
      }
      return results;
    }
    function update() {
      const locked = busy || taskActive(batch?.task);
      syncSelection();
      const selected = batch ? chosen() : [];
      const rows = selected.filter(row => ['preview', 'failed', 'confirming'].includes(row.status) && row.preview);
      const total = totals(rows);
      const users = new Set(rows.map(row => row.preview.userId));
      const visibleIds = new Set(batch?.rows.map(row => row.id));
      const scope = rows.some(row => !visibleIds.has(row.id)) ? '跨页所选' : batch?.view === 'all' ? '所选' : '本页所选';
      $('bci-selection').textContent = `已选 ${selected.filter(row => row.status !== 'settled').length} 笔（当前批次，跨页保留）`;
      $('bci-total').textContent = rows.length ? `${scope} ${rows.length} 笔 · ${users.size} 位用户 · 补记 ${fixed(total.local)} USD` : '待生成预览';
      const balances = rows.filter(row => row.preview.billingType === 'balance'), balance = totals(balances);
      const subscriptions = rows.filter(row => row.preview.billingType === 'subscription'), subscription = totals(subscriptions);
      $('bci-cost-preview').hidden = !rows.length;
      $('bci-cost-note').hidden = !rows.length;
      $('bci-cost-preview').innerHTML = rows.length ? `<table><thead><tr><th>所选扣费预览</th><th>笔数</th><th>上游支出（USD）</th><th>本站拟补记（USD）</th><th>上游多扣余额差额（USD）</th></tr></thead><tbody>${
        [[balances, balance, '余额补扣'], [subscriptions, subscription, '订阅用量']].filter(([items]) => items.length).map(([items, value, name]) => `<tr><td>${name}</td><td>${items.length}</td><td>${supplierAmount(value)}</td><td>${fixed(value.local)}</td><td>${items === subscriptions ? '不适用：订阅用量' : value.unknown ? '未知：上游费用不完整' : difference(value.supplier - value.local)}</td></tr>`).join('')
      }</tbody></table>` : '';
      const selectedGroups = new Map(selected.filter(row => row.preview?.group).map(row => [row.preview.group.identity, row.preview.group]));
      $('bci-group-preview').hidden = !selectedGroups.size;
      $('bci-group-preview').innerHTML = [...selectedGroups.values()].map(group => {
        const members = selected.filter(row => row.preview?.group?.identity === group.identity);
        return `<details open><summary>整组核查通过 · ${group.count} 笔 · 原预览合计 ${esc(group.total)} USD</summary><table><thead><tr><th>CSV 行 / 时间</th><th>用户 / Key</th><th>模型</th><th>输入 / 输出 Token</th><th>缓存创建 / 读取</th><th>补记费用（USD）</th><th>状态</th></tr></thead><tbody>${members.map(row => `<tr><td>${esc(row.number)} · ${esc(date(row.record.time || row.record.startedAt))}</td><td>${esc(row.preview.userId)} / ${esc(row.preview.apiKeyId)}</td><td>${esc(row.record.model)}</td><td>${esc(row.record.tokens.InputTokens)} / ${esc(row.record.tokens.OutputTokens)}</td><td>${esc(row.record.tokens.CacheCreationTokens)} / ${esc(row.record.tokens.CacheReadTokens)}</td><td>${esc(amount(row.preview.usage.ActualCost))}</td><td>${esc(labels[row.status] || row.status)}</td></tr>`).join('')}</tbody></table></details>`;
      }).join('');
      const expired = rows.filter(row => row.status === 'preview' && row.preview.expiresAt <= Date.now()).length;
      const unquoted = selected.filter(row => row.status !== 'settled' && !row.preview).length;
      const leased = rows.some(row => row.status === 'confirming' && row.lease_until > Date.now());
      const note = locked ? '后台任务正在处理，请等待完成；刷新页面可继续查看进度。' : matchDirty ? '匹配设置已变更，需重新分析账单。' : dirty ? '核价或归属设置已变更，需重新生成所选预览。' :
        leased ? '所选记录正在结算，刷新后核对回执。' : expired ? `${expired} 笔扣费预览已过期，需重新生成所选预览。` :
          unquoted ? `所选还有 ${unquoted} 笔未生成扣费预览。` : !rows.length ? '尚未选择可确认的扣费预览。' :
            !$('bci-acknowledge').checked ? '尚未确认所选归属、用量、价格和金额。' : '';
      $('bci-confirm-note').textContent = note; $('bci-confirm-note').hidden = !note;
      $('bci-confirm').disabled = locked || dirty || matchDirty || expired > 0 || unquoted > 0 || leased || !rows.length || !$('bci-acknowledge').checked;
      $('bci-acknowledge').disabled = locked;
      $('bci-preview').disabled = locked || matchDirty || !batch || !selected.length;
      for (const button of $('br-import-pane').querySelectorAll('button:not(#bci-confirm):not(#bci-preview)')) button.disabled = locked;
      for (const input of $('bci-match').querySelectorAll('input,select')) input.disabled = locked;
      for (const id of ['bci-prices', 'bci-upload']) for (const input of $(id).querySelectorAll('input,select,textarea')) input.disabled = locked;
      for (const id of ['bci-filter', 'bci-user', 'bci-batches']) $(id).disabled = locked;
      $('bci-manual-prices').hidden = $('bci-pricing-mode').value !== 'manual';
      $('bci-prev').disabled = locked || !batch || batch.view === 'all' || batch.page <= 1;
      $('bci-next').disabled = locked || !batch || batch.view === 'all' || batch.page * batch.pageSize >= batch.filteredTotal;
      $('bci-clear-selection').disabled = locked || !selected.length;
      $('bci-select-filtered').disabled = locked || !batch || !batch.filteredTotal;
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
      if (busy) return; busy = true; error(); feedback(); update();
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
      const actionable = ['exact','time_candidate','group_candidate','preview','failed','confirming'].reduce((n, key) => n + (summary[key] || 0), 0);
      const paid = (summary.already_recorded || 0) + (summary.already_imported || 0);
      const reviewCount = batch.total - actionable - paid - (summary.settled || 0);
      $('bci-summary').textContent = `共 ${batch.total} 条 · 可补记 ${actionable} · 待核查 ${reviewCount} · 已计费 ${paid} · 已补记 ${summary.settled || 0} 条`;
      const diagnostics = batch.matchDiagnostics;
      $('bci-diagnostics').textContent = diagnostics?.algorithmVersion === MATCH_VERSION ? [
        diagnostics.window ? `CSV 账单时间 ${date(diagnostics.window.csvFrom)} 至 ${date(diagnostics.window.csvTo)}（${batch.options.timezone}）` : '',
        diagnostics.window ? `证据读取时段 ${date(diagnostics.window.from)} 至 ${date(diagnostics.window.to)}` : '',
        ...(diagnostics.clocks || []).map(clock => `${clock.key || '未命名 Key'}：${clock.effective === 'end' ? '结束时间' : clock.effective === 'start' ? '开始时间' : '时间含义待确认'}，开始 / 结束证据 ${clock.start} / ${clock.end}${clock.conflict ? '，设置与证据冲突，请重新匹配' : ''}`),
        diagnostics.native ? `本地证据：使用记录 ${diagnostics.native.usages}、数据库错误 ${diagnostics.native.errors}、持久异常 ${diagnostics.native.cases}` : '',
        diagnostics.candidateGroups?.groups ? `自动核查 ${diagnostics.candidateGroups.groups} 个候选组，${diagnostics.candidateGroups.sameOwner} 组归属一致，${diagnostics.candidateGroups.mixedOwners} 组存在不同归属` : '',
        diagnostics.candidateGroups?.auditable ? `${diagnostics.candidateGroups.auditable} 组共 ${diagnostics.candidateGroups.auditableRows} 笔进入主站费用等价核查` : '',
        diagnostics.claims ? `已核对 ${diagnostics.claims} 笔历史补记认领，重复账单转原回执` : '',
        diagnostics.observedUsageExclusions ? `已观察 Token 排除 ${diagnostics.observedUsageExclusions} 个不符的候选关系` : '',
        diagnostics.logs?.status === 'read' ? `已读取业务文件日志${diagnostics.logs.first ? `，留存时间 ${date(diagnostics.logs.first)} 至 ${date(diagnostics.logs.last)}` : ''}，覆盖范围不保证完整` : '未读取文件日志，对应时段的取消请求可能缺少归属证据',
        diagnostics.coreAvailable === false ? '主站历史预留接口不可用' : ''
      ].filter(Boolean).join('；') : '请重新分析旧版匹配和未确认预览；已经开始的补记可按原预览恢复。';
      $('bci-filter').value = batch.filter;
      $('bci-user-filter').hidden = batch.filter !== 'review';
      $('bci-user').innerHTML = '<option value="">全部用户</option>' + (batch.reviewUsers || []).map(user =>
        `<option value="${esc(user.userId)}"${batch.userId === user.userId ? ' selected' : ''}>用户 ${esc(user.userId)} · ${user.count} 条 · ${user.keys} 个 Key</option>`).join('');
      const attributed = (batch.reviewUsers || []).reduce((count, user) => count + user.count, 0);
      $('bci-review-summary').hidden = batch.filter !== 'review';
      $('bci-review-summary').textContent = `${(batch.reviewUsers || []).length} 位用户有 ${attributed} 条已定位归属的待核查记录；其余 ${reviewCount - attributed} 条需核查归属或 CSV 数据。`;
      const form = $('bci-match');
      for (const key of ['timezone','timeKind','toleranceSeconds','clockOffsetSeconds']) form.elements[key].value = batch.options[key];
      form.elements.inputIncludesCache.checked = batch.options.inputIncludesCache;
      $('bci-mappings').innerHTML = batch.keys.map(key => `<label>${esc(key || '未命名上游 Key')} 对应账号<select data-key="${esc(key)}"><option value="">选择上游账号</option>${accounts.map(account => `<option value="${esc(account.id)}"${String(batch.options.accountMappings[key] || '') === String(account.id) ? ' selected' : ''}>${esc(account.name)} · ${esc(account.id)}</option>`).join('')}</select></label>`).join('');
      renderColumns(batch.headers, batch.columns);
      $('bci-list').innerHTML = batch.rows.map(row => {
        const record = row.record, preview = row.preview, candidates = row.match?.candidates || [];
        const selected = assignments.has(row.id) ? assignments.get(row.id) : row.selection || row.match?.selected || '';
        const selectable = eligible(row);
        const candidate = preview ? `用户 ${preview.userId} · ${preview.userEmail} · Key ${preview.apiKeyId}` : '';
        const options = candidates.map(item => `<option value="${esc(item.reference)}"${selected === item.reference ? ' selected' : ''}${item.recorded || item.blockedReason ? ' disabled' : ''}>用户 ${esc(item.userId)} · Key ${esc(item.apiKeyId)} · ${esc(item.userEmail)} · ${esc(item.reference)} · ${esc((item.timeDifferenceMs / 1000).toFixed(3))}s${item.recorded ? ' · 已记账' : item.blockedReason ? ` · ${esc(item.blockedReason)}` : ''}</option>`).join('');
        const group = row.match?.candidateGroup;
        const status = [row.result?.error || (preview?.group ? row.status === 'settled' ? `账单 ${row.case_id}` : '整组报价及归属核查通过' : row.match?.reason) || record.error || (row.status === 'settled' ? `账单 ${row.case_id}` : ''),
          preview?.group ? `整组 ${preview.group.count} 笔，核查合计 ${preview.group.total} USD；组内分配不表示逐笔历史对应` : '',
          group && !preview?.group ? `自动核查组：${group.rows} 条账单 / ${group.sources} 个候选来源；${group.reason}` : '',
          group?.auditReason || '',
          row.match?.usageConstraints?.excluded ? `已观察 Token 排除 ${row.match.usageConstraints.excluded} 个不符候选` : ''].filter(Boolean).join('；');
        const dims = record.tokens || {};
        const owner = row.match?.owner;
        const comparison = row.costComparison;
        const gap = !preview ? '待生成预览' : preview.billingType === 'subscription' ? '不适用：订阅用量' : difference(units(comparison?.balanceDifference));
        const details = candidateDetails(candidates.find(item => item.reference === selected) || (candidates.length === 1 ? candidates[0] : null));
        return `<tr><td><input data-select="${row.id}" type="checkbox" aria-label="选择第 ${row.number} 行"${selectable ? selection.get(row.id) ? ' checked' : '' : ' disabled'}></td><td>${esc(row.number)} · CSV ${esc(date(record.time || record.startedAt))}<small>${record.matchedTimeKind ? `请求开始 ${esc(date(record.startedAt))}` : '时间含义待确认'}${record.matchedEndedAt ? ` 至 ${esc(date(record.matchedEndedAt))}` : ''}</small><small>${esc(record.model)}</small><small>${esc(record.requestId || record.key)}</small></td><td>${preview ? `<span>${esc(candidate)}</span><small>${preview.billingType === 'subscription' ? '订阅用量' : '余额计费'}</small>` : owner ? `<span>用户 ${esc(owner.userId)} · Key ${esc(owner.apiKeyId)} · 分组 ${esc(owner.groupId)}</span>` : ''}<select data-assignment="${row.id}" aria-label="第 ${row.number} 行匹配用户"${preview || group?.auditEligible || !selectable ? ' disabled' : ''}><option value="">${group?.auditEligible ? '整组自动核查' : '选择候选请求'}</option>${options}</select><div data-candidate="${row.id}">${details}</div></td><td>${esc(labels[row.status] || row.status)}${row.match?.basis ? `<small>${esc(row.match.basis)}</small>` : ''}</td><td>${esc(dims.InputTokens ?? '未知')} / ${esc(dims.OutputTokens ?? '未知')}<small>缓存 ${esc(dims.CacheCreationTokens ?? '未知')} / ${esc(dims.CacheReadTokens ?? '未知')}</small></td><td>${esc(comparison?.supplierCost ?? (record.cost || '未知'))}</td><td>${preview ? `${esc(amount(preview.usage.ActualCost))} USD<small>${preview.pricingSource === 'immutable_dispatch_snapshot' ? '请求历史价格快照' : preview.pricingSource === 'current_sub2api_prices' ? '当前主站价格' : '人工核定历史售价'}</small>${preview.pricingAt ? `<small>报价 ${esc(date(preview.pricingAt))}</small>` : ''}<small>预览有效至 ${esc(date(preview.expiresAt))}</small><small>售卖倍率 ${esc(preview.usage.RateMultiplier)}</small>` : '待核定'}</td><td data-cost-gap>${esc(gap)}</td><td>${esc(status)}</td></tr>`;
      }).join('');
      $('bci-page').textContent = batch.view === 'all' ? `共 ${batch.filteredTotal} 条可补记记录 · 已全部展示` : `${batch.filteredTotal} 条 · 第 ${batch.page} / ${Math.max(1, Math.ceil(batch.filteredTotal / batch.pageSize))} 页`;
      $('bci-prev').hidden = $('bci-next').hidden = batch.view === 'all';
      $('bci-select-all').setAttribute('aria-label', batch.view === 'all' ? '选择全部可补记记录' : '选择本页可补记记录');
      $('bci-select-all').checked = false; $('bci-acknowledge').checked = false;
      renderPrices(); update(); refreshIcons();
    }
    async function open(id, page = 1, filter = batch?.filter || 'actionable', userId = batch?.userId || '', followTask = true) {
      const current = ++epoch;
      const result = await api(`/api/billing-imports/${encodeURIComponent(id)}?page=${page}&filter=${encodeURIComponent(filter)}&userId=${encodeURIComponent(userId)}${filter === 'actionable' ? '&view=all' : ''}`);
      if (current !== epoch || !isActive()) return;
      if (selectionBatch !== result.id) { clearSelection(result.id); dirty = false; matchDirty = false; feedback(); }
      batch = result; remember(result); render();
      if (taskActive(result.task) && followTask) {
        const resume = async () => {
          const task = await waitTask(result.task, current, id);
          if (!task) return;
          await open(id, batch.page, batch.filter);
          if (task.status !== 'succeeded') throw new Error(task.error?.message || '后台任务中断，请核对已保存的记录。');
          const results = task.result.results;
          if (task.kind === 'preview') {
            const ready = results.filter(row => row.status === 'preview').length;
            const review = results.filter(row => row.status === 'needs_review');
            feedback(`后台预览完成：${ready} 条可确认${review.length ? `，${review.length} 条待核查：${review[0].error}` : ''}；尚未补记或扣费。`, review.length ? 'error' : 'status');
          } else {
            await refreshSelected(id, results.map(row => row.id));
            const rows = results.map(row => rowCache.get(row.id)), done = rows.filter(settledReceipt);
            const charged = totals(done.filter(row => row.preview.billingType === 'balance'));
            feedback(`后台补记已核实 ${done.length} 笔原生使用记录；余额扣费 ${fixed(charged.local)} USD，订阅用量 ${done.filter(row => row.preview.billingType === 'subscription').length} 笔。${rows.length > done.length ? `另有 ${rows.length - done.length} 笔未确认完成，请核对原记录。` : ''}`, rows.length > done.length ? 'error' : 'status');
          }
        };
        if (busy) await resume(); else await run(resume);
      }
      else if (['failed', 'interrupted'].includes(result.task?.status)) feedback(result.task.error?.message || '上次后台任务未完成，请核对原记录。', 'error');
    }
    async function load() {
      if (busy) return;
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
      rules.clear(); assignments.clear(); clearSelection(result.id); dirty = false; matchDirty = false;
      $('bci-pricing-mode').value = 'auto'; batch = result; remember(result); render();
      const resultOptions = await api('/api/billing-imports/options'); accounts = resultOptions.accounts;
      $('bci-batches').innerHTML = '<option value="">选择批次</option>' + resultOptions.batches.map(item => `<option value="${item.id}"${batch.id === item.id ? ' selected' : ''}>${esc(item.file_name)} · ${item.settled || 0}/${item.total}</option>`).join('');
      await open(batch.id, 1);
    }); });
    $('bci-batches').addEventListener('change', () => { if ($('bci-batches').value) run(async () => { rules.clear(); assignments.clear(); await open($('bci-batches').value, 1, 'actionable', ''); }); });
    $('bci-match').addEventListener('submit', event => { event.preventDefault(); run(async () => {
      const form = event.currentTarget, accountMappings = Object.create(null);
      for (const input of $('bci-mappings').querySelectorAll('[data-key]')) if (input.value) accountMappings[input.dataset.key] = Number(input.value);
      const result = await api(`/api/billing-imports/${batch.id}/match`, { method: 'POST', body: JSON.stringify({
        timezone: form.elements.timezone.value.trim(), timeKind: form.elements.timeKind.value,
        toleranceSeconds: Number(form.elements.toleranceSeconds.value), clockOffsetSeconds: Number(form.elements.clockOffsetSeconds.value),
        inputIncludesCache: form.elements.inputIncludesCache.checked, accountMappings, columns: readColumns() }) });
      assignments.clear(); clearSelection(result.id); dirty = false; matchDirty = false;
      batch = result; remember(result); render();
      await open(batch.id, 1, result.summary.exact || result.summary.time_candidate || result.summary.group_candidate || result.summary.preview ? 'actionable' : 'review');
      feedback('账单分析完成，尚未生成新的扣费预览或扣费。');
      if (!result.coreAvailable) error('已读取原版日志。执行补记前需要更新支持历史导入的主站版本。');
    }); });
    $('bci-list').addEventListener('change', event => {
      if (event.target.dataset.assignment) {
        assignments.set(event.target.dataset.assignment, event.target.value);
        const checkbox = $('bci-list').querySelector(`[data-select="${event.target.dataset.assignment}"]`);
        checkbox.checked = Boolean(event.target.value); dirty = true; $('bci-acknowledge').checked = false;
        const row = batch.rows.find(item => item.id === event.target.dataset.assignment);
        select(row, checkbox.checked);
        $('bci-list').querySelector(`[data-candidate="${row.id}"]`).innerHTML = candidateDetails(row.match?.candidates.find(item => item.reference === event.target.value));
      }
      if (event.target.dataset.select) {
        const row = batch.rows.find(item => item.id === event.target.dataset.select);
        if (row) select(row, event.target.checked);
      }
      update();
    });
    for (const name of ['bci-match', 'bci-columns']) $(name).addEventListener('input', () => {
      matchDirty = true; $('bci-acknowledge').checked = false; update();
    });
    $('bci-select-all').addEventListener('change', event => {
      for (const row of batch.rows.filter(eligible)) select(row, event.target.checked);
      update();
    });
    $('bci-clear-selection').addEventListener('click', () => {
      defaultSelection = false;
      for (const id of selection.keys()) selection.set(id, false);
      $('bci-acknowledge').checked = false; update();
    });
    $('bci-select-filtered').addEventListener('click', () => run(async () => {
      if (batch.view === 'all') {
        for (const row of batch.rows.filter(eligible)) select(row, true);
        feedback(`已选择 ${chosen().filter(row => row.status !== 'settled').length} 笔可操作记录。`);
        return;
      }
      const current = epoch, batchId = batch.id, filter = batch.filter, userId = batch.userId || '';
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        if (current !== epoch || !isActive()) return;
        feedback(`正在选择筛选结果：第 ${page} / ${pages} 页。`);
        const detail = await api(`/api/billing-imports/${encodeURIComponent(batchId)}?page=${page}&filter=${encodeURIComponent(filter)}&userId=${encodeURIComponent(userId)}`);
        if (current !== epoch || !isActive()) return;
        pages = Math.ceil(detail.filteredTotal / detail.pageSize);
        remember(detail, false);
        for (const row of detail.rows.filter(eligible)) select(row, true);
      }
      feedback(`已选择筛选结果中 ${chosen().filter(row => row.status !== 'settled').length} 笔可操作记录。`);
    }));
    $('bci-filter').addEventListener('change', () => run(async () => { readPrices(); await open(batch.id, 1, $('bci-filter').value, ''); }));
    $('bci-user').addEventListener('change', () => run(async () => { readPrices(); await open(batch.id, 1, 'review', $('bci-user').value); }));
    for (const name of ['bci-pricing-mode','bci-cache-ttl','bci-price-list','bci-price-evidence','bci-assignment-evidence','bci-time-checked','bci-final-usage','bci-cache-zero']) $(name).addEventListener('input', () => { dirty = true; $('bci-acknowledge').checked = false; update(); });
    $('bci-acknowledge').addEventListener('change', update);
    $('bci-preview').addEventListener('click', () => run(async () => {
      readPrices();
      const pricing = Object.create(null);
      const current = epoch, batchId = batch.id;
      $('bci-acknowledge').checked = false;
      feedback('正在读取所选记录并核对主站证据，随后生成扣费预览；尚未扣费。');
      await refreshSelected(batchId);
      if (current !== epoch || !isActive()) return;
      const selected = chosen();
      for (const row of selected) {
        const rule = rules.get(row.record.model);
        if ($('bci-pricing-mode').value === 'auto') pricing[row.record.model] = { cacheTTL: $('bci-cache-ttl').value };
        else if (rule) pricing[row.record.model] = Object.fromEntries(Object.entries(rule).filter(([, value]) => value != null));
      }
      const rowIds = previewRowIds(selected);
      let results;
      try { results = await generatePreviewChunks(rowIds, { assignments: Object.fromEntries(assignments), pricing,
        pricingMode: $('bci-pricing-mode').value, pricingEvidence: $('bci-price-evidence').value.trim(),
        assignmentEvidence: $('bci-assignment-evidence').value.trim(), confirmTimeMatches: $('bci-time-checked').checked,
        finalUsageConfirmed: $('bci-final-usage').checked, missingCacheIsZero: $('bci-cache-zero').checked }, current, batchId); }
      catch (cause) {
        if (current === epoch && isActive()) {
          try { await refreshSelected(batchId); await open(batchId, batch.page, batch.filter, batch.userId, false); } catch {}
        }
        throw cause;
      }
      if (current !== epoch || !isActive()) return;
      dirty = false;
      await open(batch.id, batch.page, batch.filter);
      const ready = results.filter(row => row.status === 'preview').length;
      const failed = results.filter(row => row.status === 'needs_review').length;
      const message = `预览处理完成：${ready} 条可确认${failed ? `，${failed} 条待核查：${results.find(row => row.status === 'needs_review').error}` : ''}；尚未补记或扣费。`;
      feedback(message, failed ? 'error' : 'status');
    }));
    $('bci-confirm').addEventListener('click', () => run(async () => {
      if (!$('bci-acknowledge').checked) throw new Error('请先核对所选预览并确认。');
      const batchId = batch.id, current = epoch, selected = chosen(), ids = selected.map(row => row.id);
      feedback('正在核对所选扣费预览与当前结算状态。');
      await refreshSelected(batchId, ids);
      if (current !== epoch || !isActive()) return;
      const changed = selected.some(row => {
        const latest = rowCache.get(row.id);
        return latest.version !== row.version || latest.preview?.id !== row.preview?.id;
      });
      if (changed) {
        await open(batchId, batch.page, batch.filter, batch.userId, false);
        throw new Error('所选预览或结算状态已变化，已刷新；请重新核对金额并确认。');
      }
      // Keep each frozen group complete, and bound each confirmation request.
      const chunks = [], groups = new Set();
      let chunk = [];
      for (const row of selected) {
        if (row.preview?.group && groups.has(row.preview.group.identity)) continue;
        const members = row.preview?.group ? selected.filter(item => item.preview?.group?.identity === row.preview.group.identity) : [row];
        if (row.preview?.group) groups.add(row.preview.group.identity);
        if (chunk.length + members.length > PREVIEW_CHUNK_SIZE) { if (chunk.length) chunks.push(chunk); chunk = []; }
        chunk.push(...members);
      }
      if (chunk.length) chunks.push(chunk);
      let failure = '', refreshFailure = '';
      for (let index = 0; index < chunks.length; index++) {
        if (current !== epoch || !isActive()) break;
        feedback(`正在补记并结算：第 ${index + 1} / ${chunks.length} 批，共 ${selected.filter(row => row.status !== 'settled').length} 笔；请等待回执。`);
        try {
          const result = await runTask('confirm', { acknowledge: true,
            rows: chunks[index].map(row => ({ id: row.id, version: row.version, previewId: row.preview.id })) }, current, batchId);
          if (!result) return;
          failure = [...new Set(result.results.filter(row => row.status !== 'settled').map(row => row.error || '结算尚未完成'))].slice(0, 3).join('；');
          await refreshSelected(batchId, chunks[index].map(row => row.id));
          if (current !== epoch || !isActive()) return;
          if (chunks[index].some(row => !settledReceipt(rowCache.get(row.id)))) failure ||= '尚未读取到完整结算回执，已停止后续批次。';
          const complete = selected.filter(row => row.status !== 'settled' && settledReceipt(rowCache.get(row.id))).length;
          feedback(`已核实 ${complete} 笔已补记使用记录；正在处理第 ${index + 1} / ${chunks.length} 批。`);
        } catch (cause) { failure = cause.message; }
        if (failure) break;
      }
      if (current !== epoch || !isActive()) return;
      try { await refreshSelected(batchId, ids); }
      catch (cause) { refreshFailure = cause.message; }
      if (current !== epoch || !isActive()) return;
      const completed = selected.filter(row => row.status !== 'settled' && settledReceipt(rowCache.get(row.id)));
      const charged = totals(completed.map(row => rowCache.get(row.id)).filter(row => row.preview.billingType === 'balance'));
      const subscriptions = completed.filter(row => row.preview.billingType === 'subscription').length;
      $('bci-acknowledge').checked = false;
      try {
        await open(batchId, batch.page, batch.filter, batch.userId, false);
        if (batch.filter === 'actionable' && !batch.filteredTotal) await open(batchId, 1, 'settled');
      } catch (cause) { refreshFailure ||= cause.message; }
      const pending = selected.filter(row => row.status !== 'settled').length - completed.length;
      const message = `${refreshFailure ? '已读取的回执显示' : '已核实'} ${completed.length} 笔已补记使用记录；余额扣费 ${fixed(charged.local)} USD${subscriptions ? `，订阅用量 ${subscriptions} 笔` : ''}。` +
        (pending ? `\n${pending} 笔未确认完成，已停止后续批次。${failure || '刷新后核对原记录状态。'}` : '') +
        (refreshFailure ? `\n回执刷新失败：${refreshFailure}；结果可能仍在处理，请刷新核对，勿重新导入重复扣款。` : '');
      feedback(message, pending || refreshFailure ? 'error' : 'status');
      $('bci-action-status').focus({ preventScroll: true });
      $('bci-action-status').scrollIntoView({ block: 'nearest' });
    }));
    for (const [name, direction] of [['bci-prev',-1],['bci-next',1]]) $(name).addEventListener('click', () => run(async () => { readPrices(); await open(batch.id, batch.page + direction); }));
    update();
    return { load, leave() { epoch++; }, reset() {
      epoch++; batch = null; fileText = null; rules.clear(); assignments.clear(); clearSelection(null); dirty = false; matchDirty = false;
      $('bci-upload').reset(); $('bci-workspace').hidden = true; $('bci-columns-box').hidden = true;
      $('bci-pricing-mode').value = 'auto'; $('bci-cache-ttl').value = 'split';
      for (const name of ['bci-price-evidence', 'bci-assignment-evidence']) $(name).value = '';
      for (const name of ['bci-final-usage','bci-time-checked','bci-cache-zero','bci-acknowledge']) $(name).checked = false;
      for (const name of ['bci-list','bci-price-list','bci-columns','bci-mappings']) $(name).replaceChildren();
      for (const name of ['bci-summary','bci-diagnostics','bci-title','bci-review-summary']) $(name).textContent = '';
      $('bci-user').replaceChildren(); $('bci-user-filter').hidden = true; $('bci-review-summary').hidden = true;
      error(); feedback(); update();
    } };
  }
  root.BillingImportUi = { create };
})(window);
