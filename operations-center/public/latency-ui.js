(function (root) {
  'use strict';
  const phases = { request_start: '进入应用', body_read: '请求体读取完成', prepare_start: '前置处理开始',
    prepare_end: '前置处理完成', queue_start: '进入排队', queue_end: '离开排队', attempt_start: '上游尝试开始',
    rewrite_end: '请求改写完成', get_conn: '开始取得连接', got_conn: '连接可用', dns_start: 'DNS 开始',
    dns_end: 'DNS 完成', tcp_start: 'TCP 开始', tcp_end: 'TCP 完成', tls_start: 'TLS 开始', tls_end: 'TLS 完成',
    wrote_request: '请求写入完成', response_byte: '收到响应首字节', response_headers: '响应头完成',
    first_sse: '首个完整 SSE', first_semantic: '首个语义事件', first_content: '首个内容增量',
    downstream_write: '向下游首次写出', downstream_flush: '首次 Flush 返回', attempt_end: '上游尝试结束', request_end: '请求结束' };
  const outcomes = { active: '等待中', completed: '已结束', error: '错误', cancelled: '已取消', unknown: '状态未确认' };
  const number = (value, digits = 1) => value == null ? '-' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value));
  const ms = (value) => value == null ? '-' : `${number(Number(value) / 1000, 3)} s`;
  const ttft = (row) => row.stream && Number(row.first_token_ms) > 0 ? row.first_token_ms : null;
  const bytes = (value) => value == null ? '-' : value >= 1073741824 ? `${number(value / 1073741824)} GiB`
    : value >= 1048576 ? `${number(value / 1048576)} MiB` : `${number(value / 1024)} KiB`;

  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = (id) => document.getElementById(id);
    let options = null, mode = 'requests', page = 1, report = null, detail = null, live = [];
    let requestSequence = 0, detailSequence = 0, timer = null, requestController = null;
    const charts = new Map();
    const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: options?.timezone || 'Asia/Shanghai' }) : '-';
    const badge = (text, tone = 'neutral') => `<span class="badge ${tone}">${esc(text)}</span>`;
    const empty = (columns, text) => `<tr><td colspan="${columns}" class="lt-empty">${esc(text)}</td></tr>`;

    function chart(id, option) {
      if (!root.echarts) return;
      let instance = charts.get(id);
      if (!instance) { instance = root.echarts.init($(id)); charts.set(id, instance); }
      instance.setOption({ animation: false, tooltip: { trigger: 'axis' }, grid: { left: 54, right: 42, top: 46, bottom: 48 },
        legend: { type: 'scroll', top: 0, textStyle: { fontSize: 11 } }, ...option }, true);
      instance.resize();
    }

    function schedule() {
      clearTimeout(timer);
      if ($('lt-auto').checked && isActive() && !document.hidden) {
        timer = setTimeout(() => load().catch((error) => toast(error.message, 'error')), 15000);
      }
    }

    function query() {
      const result = Object.fromEntries(new FormData($('lt-filter')));
      for (const key of Object.keys(result)) if (result[key] === '') delete result[key];
      return { ...result, page: String(page), pageSize: '20' };
    }

    async function load() {
      const sequence = ++requestSequence;
      requestController?.abort();
      requestController = new AbortController();
      const signal = requestController.signal;
      clearTimeout(timer);
      $('lt-status').hidden = false;
      $('lt-status').textContent = '正在读取监测数据';
      try {
        if (!options) {
          const result = await api('/api/latency/options', { signal });
          if (sequence !== requestSequence || !isActive()) return;
          options = result;
          const form = $('lt-filter');
          for (const name of ['start', 'end']) {
            form.elements[name].value = result.defaultRange[name];
            form.elements[name].min = result.earliest; form.elements[name].max = result.today;
          }
        }
        $('lt-notices').innerHTML = !options.upstreamConfigured && mode === 'requests'
          ? '<div class="alert warning">尚未连接供应商监控，上游核对暂不可用。</div>' : '';
        if (mode === 'requests') {
          const result = await api(`/api/latency/requests?${new URLSearchParams(query())}`, { signal });
          if (sequence !== requestSequence || !isActive()) return;
          report = result; renderReport(result);
          setPageMeta(`${result.query.range.start} 至 ${result.query.range.end} · ${result.timezone} · 更新于 ${time(result.generatedAt)}`);
        } else if (mode === 'live') {
          const result = await api('/api/latency/live', { signal });
          if (sequence !== requestSequence || !isActive()) return;
          live = result.items; renderLive(result);
          setPageMeta(`实时阶段 · ${options.timezone} · 最近接收 ${time(result.status.lastIngestAt)}`);
        } else {
          const form = $('lt-resource-filter');
          const end = Date.now();
          const search = new URLSearchParams({ from: new Date(end - Number(form.elements.hours.value) * 3600000).toISOString(), to: new Date(end).toISOString() });
          if (form.elements.host.value.trim()) search.set('host', form.elements.host.value.trim());
          const result = await api(`/api/latency/resources?${search}`, { signal });
          if (sequence !== requestSequence || !isActive()) return;
          renderResources(result.items); setPageMeta(`资源历史 · ${options.timezone}`);
        }
        $('lt-status').hidden = true;
      } catch (error) {
        if (sequence !== requestSequence || error.name === 'AbortError' || !isActive()) return;
        $('lt-status').textContent = error.message;
        if (mode === 'requests') $('lt-data').hidden = true;
        throw error;
      } finally { if (sequence === requestSequence) { schedule(); refreshIcons(); } }
    }

    function renderReport(result) {
      $('lt-data').hidden = false;
      const summary = result.summary;
      const metric = (label, value, caption, warn = false) => `<div class="lt-metric${warn ? ' warn' : ''}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(caption)}</small></div>`;
      $('lt-metrics').innerHTML = metric('范围内记录', number(summary.records, 0), '用量 + 错误 · 不含 ID 1') +
        metric('慢记录', number(summary.slow_records, 0), `${summary.records ? number(summary.slow_records / summary.records * 100) : '-'}% 占比`, true) +
        metric('错误记录', number(summary.error_records, 0), '包含重试相关记录') +
        metric('首输出 P50', ms(summary.ttft_p50_ms), `${number(summary.ttft_samples, 0)} 个有效流式样本`) +
        metric('首输出 P95', ms(summary.ttft_p95_ms), '按当前账号 / 模型筛选') +
        metric('总耗时 P95', ms(summary.duration_p95_ms), '包含非流式记录');
      $('lt-count').textContent = `符合列表筛选 ${number(result.pagination.total, 0)} 条`;
      $('lt-rows').innerHTML = result.items.map((row) => `<tr><td>${esc(time(row.created_at))}<span class="lt-secondary">${esc(row.request_id || `${row.source}:${row.source_id}`)}</span></td>
        <td>${esc(row.account_id || '-')}<span class="lt-secondary">用户 ${esc(row.user_id || '-')}</span></td>
        <td>${esc(row.requested_model || row.model)}<span class="lt-secondary">${esc(row.reasoning_effort || '档位未记录')} · ${row.stream ? '流式' : '非流式'}</span></td>
        <td>${badge(row.source === 'error' ? `错误 ${row.status_code || ''}` : '用量', row.source === 'error' ? 'error' : 'neutral')}${row.is_slow ? `<span class="lt-secondary">${badge('慢记录', 'warning')}</span>` : ''}</td>
        <td class="numeric">${esc(ms(ttft(row)))}</td><td class="numeric">${esc(ms(row.duration_ms))}</td>
        <td><button class="icon-button" type="button" data-detail="${esc(`${row.source}:${row.source_id}`)}" title="核对上游与时间线" aria-label="核对上游与时间线">${icon('scan-search')}</button></td></tr>`).join('') || empty(7, '没有符合条件的记录');
      $('lt-page').textContent = `第 ${page} 页 · ${number(result.pagination.total, 0)} 条`;
      $('lt-previous').disabled = page <= 1; $('lt-next').disabled = !result.pagination.hasNext;
      $('lt-export').disabled = !result.items.length;
      $('lt-groups').innerHTML = result.groups.map((row) => `<tr><td>${esc(row.account_id || '-')}<span class="lt-secondary">${esc(row.requested_model)}</span></td><td>${esc(row.reasoning_effort || '-')}</td><td class="numeric">${number(row.slow_records, 0)} / ${number(row.records, 0)}</td><td class="numeric">${esc(ms(row.ttft_p95_ms))}<span class="lt-secondary">n=${number(row.ttft_samples, 0)}</span></td></tr>`).join('') || empty(4, '暂无分布数据');
      $('lt-definitions').innerHTML = [...result.warnings,
        '阈值只标记慢记录，不会修改模型、并发、请求超时或发起付费探测。',
        '概要、趋势和分布遵循日期、账号、用户、模型和档位；记录范围只筛选下方列表。']
        .map((text) => `<li>${esc(text)}</li>`).join('');
      chart('lt-trend', { xAxis: { type: 'category', data: result.trend.map((row) => row.date) }, yAxis: { type: 'value', minInterval: 1 }, series: [
        { name: '全部记录', type: 'line', data: result.trend.map((row) => row.records), color: '#2d5ea8' },
        { name: '慢记录', type: 'bar', data: result.trend.map((row) => row.slow_records), color: '#be842d' },
        { name: '错误记录', type: 'line', data: result.trend.map((row) => row.error_records), color: '#ae3636' }
      ] });
    }

    function renderLive(result) {
      const status = result.status;
      $('lt-collection').innerHTML = `<span>${badge(status.enabled ? '采集已启用' : '尚未启用阶段采集', status.enabled ? 'success' : 'warning')}</span><span>最近接收 ${esc(time(status.lastIngestAt))}</span><span>诊断存储 ${esc(bytes(status.bytes))} / ${esc(bytes(status.maxBytes))}</span><span>丢弃事件 ${number(status.droppedEvents, 0)}</span>${status.lastError ? `<span>${esc(status.lastError)}</span>` : ''}`;
      $('lt-live-rows').innerHTML = result.items.map((row, index) => `<tr><td>${esc(row.requestId)}<span class="lt-secondary">${esc(row.metadata.host || '-')}</span></td><td>${esc(row.metadata.accountId || '-')}<span class="lt-secondary">${esc(row.metadata.model || '-')}</span></td><td>${badge(outcomes[row.outcome] || row.outcome, row.outcome === 'active' ? 'warning' : 'neutral')}</td><td>${esc(phases[row.events.at(-1)?.name] || '-')}</td><td class="numeric">${esc(ms(row.elapsedMs))}</td><td><button class="icon-button" type="button" data-live="${index}" title="查看时间线" aria-label="查看时间线">${icon('list-tree')}</button></td></tr>`).join('') || empty(6, '尚无阶段事件');
    }

    function renderResources(rows) {
      const hosts = [...new Set(rows.map((row) => row.host))];
      $('lt-resource-meta').textContent = rows.length ? `${number(rows.length, 0)} 个样本 · ${hosts.join('、')} · 最新 ${time(rows.at(-1).at)}${rows.length === 2000 ? ' · 达到样本上限，请缩短时段或筛选主机' : ''}` : '该时段暂无资源采样';
      const series = (field, label, axis, color) => hosts.slice(0, 5).map((host) => ({ name: `${host} ${label}`, type: 'line', showSymbol: false,
        yAxisIndex: axis, color, data: rows.filter((row) => row.host === host).map((row) => [row.at, row[field] ?? null]) }));
      chart('lt-cpu', { xAxis: { type: 'time' }, yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } }, series: [
        ...series('cpuPercent', 'CPU', 0, '#176b4d'), ...series('stealPercent', 'steal', 0, '#ae3636'), ...series('iowaitPercent', 'iowait', 0, '#be842d')] });
      chart('lt-network', { xAxis: { type: 'time' }, yAxis: [
        { type: 'value', axisLabel: { formatter: (value) => `${number(value / 1024, 0)}K` } }, { type: 'value', name: '重传 / 秒' }], series: [
        ...series('networkRxBytesPerSecond', '接收 B/s', 0, '#2d5ea8'), ...series('networkTxBytesPerSecond', '发送 B/s', 0, '#176b4d'), ...series('tcpRetransmitsPerSecond', '重传', 1, '#ae3636')] });
      $('lt-resource-rows').innerHTML = rows.slice(-30).reverse().map((row) => `<tr><td>${esc(time(row.at))}<span class="lt-secondary">${esc(row.host)}</span></td><td class="numeric">${esc(bytes(row.memoryAvailableBytes))}</td><td class="numeric">${esc(bytes(row.swapUsedBytes))}</td><td class="numeric">${esc(bytes(row.diskAvailableBytes))}</td><td class="numeric">${esc(bytes(row.diskReadBytesPerSecond))} / ${esc(bytes(row.diskWriteBytesPerSecond))}/s</td><td class="numeric">${esc(bytes(row.networkRxBytesPerSecond))} / ${esc(bytes(row.networkTxBytesPerSecond))}/s</td><td class="numeric">${number(row.tcpRetransmitsPerSecond)}</td></tr>`).join('') || empty(7, '暂无采样');
    }

    function comparisonTable(base, remote) {
      const difference = (a, b) => a != null && b != null ? a - b : null;
      const baseFirst = ttft(base), remoteFirst = remote ? ttft(remote) : null;
      const after = (row) => row && ttft(row) != null && row.duration_ms >= ttft(row) ? row.duration_ms - ttft(row) : null;
      return `<div class="table-wrap"><table><thead><tr><th>计时</th><th class="numeric">本地</th><th class="numeric">上游</th><th class="numeric">本地减上游</th></tr></thead><tbody>${[
        ['首输出', baseFirst, remoteFirst], ['总耗时', base.duration_ms, remote?.duration_ms], ['首输出后', after(base), after(remote)]
      ].map(([label, a, b]) => `<tr><td>${label}</td><td class="numeric">${esc(ms(a))}</td><td class="numeric">${esc(ms(b))}</td><td class="numeric">${esc(ms(difference(a, b)))}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function traceHtml(trace) {
      const max = Math.max(1, ...trace.events.map((row) => row.elapsedMs));
      const previous = new Map();
      const table = trace.events.map((row) => {
        const key = row.attemptId || 'root';
        const gap = previous.has(key) ? row.elapsedMs - previous.get(key) : null;
        previous.set(key, row.elapsedMs);
        const metadata = Object.entries(row.attributes).map(([name, value]) => `${name}: ${value}`).join(' · ');
        return `<tr><td>${esc(row.attemptId || '应用')}</td><td>${esc(phases[row.name] || row.name)}<span class="lt-secondary">${esc(metadata)}</span></td><td><progress value="${Math.max(0, row.elapsedMs)}" max="${max}" aria-label="${esc(phases[row.name] || row.name)}"></progress></td><td class="numeric">${esc(ms(row.elapsedMs))}</td><td class="numeric">${esc(ms(gap))}</td></tr>`;
      }).join('');
      const proxy = trace.proxy;
      const proxyHtml = proxy ? `<h3>入口 Nginx</h3><div class="table-wrap"><table><thead><tr><th>代理总耗时</th><th>连接应用</th><th>应用响应头</th><th>应用响应完成</th></tr></thead><tbody><tr>${[
        proxy.requestTimeMs, proxy.upstreamConnectMs, proxy.upstreamHeaderMs, proxy.upstreamResponseMs
      ].map((value) => `<td>${esc(ms(value))}</td>`).join('')}</tr></tbody></table></div><p class="lt-status">状态 ${esc(proxy.statusCode)} · 请求 ${esc(bytes(proxy.requestBytes))} · 发送 ${esc(bytes(proxy.sentBytes))}${proxy.cfRayId ? ` · Cloudflare Ray ${esc(proxy.cfRayId)}` : ''}<br>此处的上游为本机 Sub2API，计时不代表模型供应商的首输出。</p>` : '';
      return `<h3>分段时间线 · ${esc(trace.requestId)}</h3><div class="lt-evidence">${badge(outcomes[trace.outcome] || trace.outcome)}<span>主机 ${esc(trace.metadata.host || '-')} · 丢弃 ${number(trace.droppedEvents, 0)} 个事件</span></div><div class="table-wrap"><table class="lt-timeline"><thead><tr><th>尝试</th><th>事件</th><th>相对位置</th><th class="numeric">距入口</th><th class="numeric">同尝试相邻事件间隔</th></tr></thead><tbody>${table}</tbody></table></div><p class="lt-status">连接获取包含 DNS / TCP / TLS 的重叠区间，不重复相加；复用连接没有新的握手事件。写入完成不证明上游应用读完，Flush 返回不证明用户已经收到。</p>${proxyHtml}`;
    }

    function renderDetail(result, candidate = null) {
      candidate = candidate || result.manualCandidate;
      const upstream = result.upstream;
      const selected = candidate || upstream?.selected;
      const label = candidate ? '人工选择的候选' : upstream?.status === 'matched' ? '请求 ID 精确关联' :
        upstream?.status === 'candidate' ? '疑似同一请求，待核实' : upstream?.status === 'ambiguous' ? '存在多个候选' : '尚未找到上游记录';
      const observation = result.comparison?.observation === 'similar_waiting_gap'
        ? '<div class="lt-note">首输出差与总耗时差接近，额外等待可能集中在首输出前。需结合连接、发送及上游计时起点继续定位。</div>' : '';
      const candidates = !upstream?.selected ? (upstream?.candidates || []).map((row, index) => `<div class="lt-candidate">${esc(row.providerName || '')} · ${esc(row.request_id || row.source_log_id)}<br><span class="lt-secondary">${esc(time(row.created_at))} · ${esc(row.model)} · 输入 ${number(row.input_tokens, 0)} / 输出 ${number(row.output_tokens, 0)} / 缓存 ${number(row.cache_read_tokens, 0)}<br>首输出 ${esc(ms(ttft(row)))} · 总耗时 ${esc(ms(row.duration_ms))}</span><button class="button" type="button" data-candidate="${index}">${icon('git-compare-arrows')}<span>对比此候选</span></button></div>`).join('') : '';
      const coverage = (upstream?.mappings || []).map((row) => `<li>${esc(row.providerName)} · ${row.keyMapped ? '已映射上游 Key' : '缺少 Key 映射'} · 最近同步 ${esc(time(row.lastSyncAt))} · ${esc(row.coverage?.status || '覆盖未知')}${row.scope === 'current_unverified' ? ' · 历史映射未验证' : ''}</li>`).join('');
      $('lt-detail-body').innerHTML = `<div class="lt-evidence">${badge(label, !candidate && upstream?.status === 'matched' ? 'success' : 'warning')}<span>${esc(result.base.requested_model || result.base.model || '')} · 账号 ${esc(result.base.account_id || '-')}</span></div>
        ${result.upstreamError ? `<div class="alert warning">${esc(result.upstreamError.message)}</div>` : ''}
        ${comparisonTable(result.base, selected)}${observation}<div class="lt-note">${esc((result.warnings || []).join(' '))}${upstream?.truncated ? ' 上游查询有截断，不能证明候选唯一。' : ''}${candidate ? ' 此处为人工候选对比，不计入已确认关联。' : ''}</div>${candidates}
        ${coverage ? `<details class="lt-definitions"><summary>上游同步与映射</summary><ul>${coverage}</ul></details>` : ''}
        ${(result.traces || []).map(traceHtml).join('') || '<h3>分段时间线</h3><p class="lt-status">该记录尚无分段事件，无法还原连接、上传或排队时间。</p>'}
        <h3>同时段资源</h3><div id="lt-detail-resources" class="lt-status">${result.resources == null ? '正在读取资源采样' : resourceSummary(result.resources)}</div>`;
      refreshIcons();
    }

    function resourceSummary(rows) {
      if (!rows.length) return '该请求时段暂无资源采样';
      return [...new Set(rows.map((row) => row.host))].map((host) => {
        const samples = rows.filter((row) => row.host === host);
        const maximum = (field) => samples.some((row) => row[field] != null) ? Math.max(...samples.map((row) => row[field] ?? 0)) : null;
        return `${esc(host)} · ${samples.length} 个样本 · CPU 峰值 ${number(maximum('cpuPercent'))}% · steal 峰值 ${number(maximum('stealPercent'))}% · 重传峰值 ${number(maximum('tcpRetransmitsPerSecond'))}/s`;
      }).join('<br>');
    }

    async function openDetail(id) {
      const sequence = ++detailSequence;
      $('lt-detail-id').textContent = id;
      $('lt-detail-body').textContent = '正在核对本地与上游记录';
      $('lt-detail-export').disabled = true;
      if (!$('lt-detail').open) $('lt-detail').showModal();
      try {
        const result = await api(`/api/latency/requests/${encodeURIComponent(id)}`);
        if (sequence !== detailSequence || !isActive() || !$('lt-detail').open) return;
        detail = result; renderDetail(result); $('lt-detail-export').disabled = false;
        await loadDetailResources(result, sequence);
      } catch (error) { if (sequence === detailSequence) $('lt-detail-body').textContent = error.message; }
    }

    async function loadDetailResources(result, sequence) {
      const at = Date.parse(result.traces[0]?.startedAt || result.base.created_at);
      const length = Math.max(0, Math.min(result.base.duration_ms || result.traces[0]?.elapsedMs || 0, 23 * 3600000));
      const search = new URLSearchParams({ from: new Date(at - (result.traces.length ? 0 : length) - 120000).toISOString(),
        to: new Date(at + length + 120000).toISOString() });
      if (result.traces[0]?.metadata.host) search.set('host', result.traces[0].metadata.host);
      try {
        const resources = await api(`/api/latency/resources?${search}`);
        if (sequence !== detailSequence || !$('lt-detail').open || !isActive()) return;
        detail.resources = resources.items;
        $('lt-detail-resources').innerHTML = resourceSummary(resources.items);
      } catch { if (sequence === detailSequence) $('lt-detail-resources').textContent = '资源采样暂不可用'; }
    }

    function download(name, data, type) {
      const url = URL.createObjectURL(new Blob([data], { type }));
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    $('lt-filter').addEventListener('submit', (event) => { event.preventDefault(); page = 1; load().catch((error) => toast(error.message, 'error')); });
    $('lt-resource-filter').addEventListener('submit', (event) => { event.preventDefault(); load().catch((error) => toast(error.message, 'error')); });
    $('lt-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]'); if (!button) return;
      mode = button.dataset.mode;
      for (const name of ['requests', 'live', 'resources']) $(`lt-${name}`).hidden = mode !== name;
      $('lt-modes').querySelectorAll('button').forEach((node) => node.setAttribute('aria-pressed', String(node === button)));
      load().catch((error) => toast(error.message, 'error'));
    });
    $('lt-auto').addEventListener('change', schedule);
    $('lt-previous').addEventListener('click', () => { page = Math.max(1, page - 1); load().catch((error) => toast(error.message, 'error')); });
    $('lt-next').addEventListener('click', () => { page += 1; load().catch((error) => toast(error.message, 'error')); });
    $('lt-rows').addEventListener('click', (event) => { const button = event.target.closest('[data-detail]'); if (button) openDetail(button.dataset.detail); });
    $('lt-live-rows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-live]'); const trace = button && live[button.dataset.live]; if (!trace) return;
      const sequence = ++detailSequence;
      detail = { base: { request_id: trace.requestId, account_id: trace.metadata.accountId, model: trace.metadata.model,
        created_at: trace.startedAt, duration_ms: trace.outcome === 'active' ? null : trace.elapsedMs },
        traces: [trace], upstreamError: { message: '此处展示已接收的阶段事件；上游日志核对请从请求记录进入。' }, warnings: [] };
      $('lt-detail-id').textContent = trace.requestId; $('lt-detail-export').disabled = false;
      renderDetail(detail); $('lt-detail').showModal(); loadDetailResources(detail, sequence);
    });
    $('lt-detail-body').addEventListener('click', (event) => {
      const button = event.target.closest('[data-candidate]');
      if (button && detail) {
        detail.manualCandidate = detail.upstream.candidates[button.dataset.candidate];
        renderDetail(detail);
      }
    });
    const close = () => { detailSequence += 1; $('lt-detail').close(); detail = null; };
    $('lt-detail-close').addEventListener('click', close);
    $('lt-detail').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    $('lt-detail-export').addEventListener('click', () => { if (detail) download('request-diagnosis.json', JSON.stringify(detail, null, 2), 'application/json'); });
    $('lt-export').addEventListener('click', () => {
      if (!report) return;
      const fields = ['source', 'source_id', 'request_id', 'upstream_request_id', 'created_at', 'account_id', 'user_id', 'requested_model', 'reasoning_effort', 'stream', 'first_token_ms', 'duration_ms', 'is_slow'];
      const cell = (value) => `"${String(value ?? '').replace(/^[\s]*[=+@-]/, (text) => `'${text}`).replaceAll('"', '""')}"`;
      const csv = '\uFEFF' + [fields, ...report.items.map((row) => fields.map((field) => row[field]))].map((row) => row.map(cell).join(',')).join('\r\n');
      download('latency-page.csv', csv, 'text/csv;charset=utf-8');
    });
    window.addEventListener('resize', () => { if (isActive()) charts.forEach((instance) => instance.resize()); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else schedule(); });

    function leave() { clearTimeout(timer); requestSequence += 1; requestController?.abort(); close(); }
    return { load, leave, reset() { leave(); options = null; report = null; live = []; $('lt-data').hidden = true; } };
  }

  root.LatencyUi = { create };
})(window);
