(function (root) {
  'use strict';
  const reasons = { body_limit: '旧采集器按单条上限截断，仅保留已采集部分', memory_limit: '旧采集器内存不足，可能仅保留部分内容', transport_error: '上游连接失败', read_error: '采集器记录了非 EOF 读取异常；可能发生于请求或响应，也可能是完成后的取消。该标记不表示日志写入失败，原始采集完整性仍未确认。', closed_early: '响应提前关闭', session_closed: '连接关闭前未见结束事件', redaction_failed: '旧记录脱敏失败，原文未保留，无法重新处理', capacity: '存储空间不足' };
  const processingErrors = { INVALID_JSON: 'JSON 不完整或格式不兼容', PROTECTED_FIELD_MATCH: '自定义规则会改变结构或关联字段', UNSUPPORTED_ENCODING: '不支持的压缩编码', INVALID_UTF8: '正文含非 UTF-8 字节', DECOMPRESSION_FAILED: '解压失败或超过解压上限', BINARY_MESSAGE_REQUIRES_ORIGINAL_MODE: '二进制消息暂不支持脱敏', UNSAFE_SSE_REPLACEMENT: '替换会改变 SSE 结构', DOCUMENT_TOO_DEEP: 'JSON 嵌套超过处理上限', NESTED_ARGUMENTS_TOO_DEEP: '工具参数嵌套超过处理上限', PROCESSING_FAILED: '处理异常' };
  const modeNames = { dual: '原文 + 脱敏副本', masked: '仅脱敏副本', original: '仅原文' };
  Object.assign(processingErrors, { UNINSPECTABLE_CONTENT: '媒体、外部文件或加密内容无法完整检查', REDACTION_RESOURCE_LIMIT: '脱敏处理达到资源保护上限，原文未截断', REDACTION_MEMORY_PRESSURE: '当前脱敏内存预算不足，原文未截断，可稍后重试', REDACTION_VALUE_LIMIT: '敏感值数量达到处理保护上限，原文未截断' });
  Object.assign(processingErrors, { PROCESSING_INTERRUPTED: '后台处理连续中断，已保留原文，可重新处理', REDACTION_CAPACITY: '脱敏副本空间不足，已保留原文，可释放空间后重试' });
  reasons.storage_failed = '存储写入失败，未保存新日志';
  reasons.processor_busy = '归档处理繁忙，已跳过新日志';
  reasons.processor_memory = '归档处理内存不足，已跳过新日志';
  reasons.processor_failed = '归档处理暂不可用，已跳过新日志';
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = id => document.getElementById('cl-' + id), container = $('root');
    let tab = 'requests', page = 1, report = null, status = null, policy = null, detail = null, source = 'masked', detailTab = 'raw';
    let seq = 0, detailSeq = 0, searchSeq = 0, lifecycle = 0, controller = null, detailController = null, userController = null, searchTimer = null, indexTimer = null;
    let payloads = new Map(), excluded = new Set(), users = new Map(), sessionFilter = null, saving = false, dirty = false;
    const reprocessing = new Set();
    let pushUi = null, exportUi = null;
    const repairUi = root.ConversationRepairUi.create({api,escapeHtml:esc,icon,refreshIcons,isActive:() => isActive() && tab === 'collection'});
    const clearUi = root.ConversationClearUi.create({api,escapeHtml:esc,icon,refreshIcons,isActive,onChanged:() => { clearDetail(); page = 1; run(load); }});
    let cleanupState = null, cleanupBusy = false, cleanupTimer = null, cleanupController = null;
    const num = value => value === null ? '准备中' : new Intl.NumberFormat('zh-CN').format(value || 0);
    const bytes = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GiB' : value >= 1048576 ? (value / 1048576).toFixed(2) + ' MiB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KiB' : num(value) + ' B';
    const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: status?.timezone || 'Asia/Shanghai', hour12: false }) : '尚无记录';
    const tool = (name, title, attrs = '') => `<button class="icon-button" type="button" title="${esc(title)}" aria-label="${esc(title)}" ${attrs}>${icon(name)}</button>`;
    const endedAbnormally = row => !row.complete && row.upstream_status === 'completed' && row.completion_source !== 'masked' && ['read_error','closed_early','session_closed'].includes(row.reason);
    const badge = row => `<span class="cl-badge ${row.complete ? 'green' : 'amber'}">${row.complete ? '完整采集' : endedAbnormally(row) ? '传输结束未确认' : row.original || row.masked ? '部分采集' : '正文缺失'}</span>${row.upstream_status === 'completed' ? `<span class="cl-badge green">${row.completion_source === 'masked' ? '副本含完成事件' : '上游已完成'}</span>` : row.upstream_status === 'failed' ? '<span class="cl-badge amber">上游执行失败</span>' : row.upstream_status === 'incomplete' ? '<span class="cl-badge amber">上游未完整完成</span>' : ''}${row.processing_pending ? '<span class="cl-badge amber">原文已保存 · 待处理</span>' : row.processing_error ? '<span class="cl-badge amber">处理异常</span>' : row.inspection_warnings?.length ? '<span class="cl-badge amber">部分内容未检查</span>' : ''}`;
    const facts = values => `<dl class="cl-facts">${values.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
    const empty = text => `<div class="cl-empty">${esc(text)}</div>`;
    function run(task) { Promise.resolve().then(task).catch(error => { if (error.name !== 'AbortError' && isActive()) { $('notice').textContent = error.message; toast(error.message, 'error'); } }); }
    function init() {
      container.innerHTML = `<div id="cl-notice" class="cl-notice" role="status"></div><div id="cl-metrics" class="cl-metrics"></div><div id="cl-index-notice" class="cl-notice amber" role="status" hidden></div><section id="cl-history-clear" aria-label="清空历史日志"></section>
        <div class="cl-tabs" role="tablist" aria-label="对话日志视图">${[['requests','list-filter','请求日志'],['sessions','messages-square','会话视图'],['collection','radio-tower','采集状态'],['policy','shield-check','保存策略'],['push','send','推送策略']].map(([id, glyph, label]) => `<button id="cl-tab-${id}" role="tab" data-cl-tab="${id}" aria-selected="${id === tab}" aria-controls="cl-${id}" tabindex="${id === tab ? 0 : -1}">${icon(glyph)}${label}</button>`).join('')}</div>
        <section id="cl-requests" role="tabpanel" aria-labelledby="cl-tab-requests"><form id="cl-filter" class="cl-filters"><label class="cl-search">${icon('search')}<input name="search" aria-label="搜索请求、用户或模型" placeholder="请求 ID、用户 ID、模型" autocomplete="off"></label><input name="start" type="date" aria-label="开始日期"><input name="end" type="date" aria-label="结束日期"><select name="protocol" aria-label="协议"><option value="">全部协议</option><option>JSON</option><option>SSE</option><option>WebSocket</option></select><select name="capture" aria-label="采集完整性"><option value="">全部完整性</option><option value="complete">完整采集</option><option value="partial">部分采集</option><option value="missing">正文缺失</option><option value="redaction_failed">脱敏失败</option></select><button class="button secondary" type="submit">${icon('search')}查询</button>${tool('rotate-ccw','重置筛选','data-cl-action="reset-filter"')}</form><section id="cl-export" aria-label="导出 JSONL"></section><div id="cl-session-filter"></div><div class="cl-explorer"><aside class="cl-records"><div id="cl-list"></div><div class="cl-pagination"><span id="cl-page-label"></span><div>${tool('chevron-left','上一页','id="cl-prev"')}${tool('chevron-right','下一页','id="cl-next"')}</div></div></aside><article id="cl-inspector" class="cl-inspector" aria-label="请求详情">${empty('选择一条请求查看原始请求与响应')}</article></div></section>
        <section id="cl-sessions" role="tabpanel" aria-labelledby="cl-tab-sessions" hidden></section><section id="cl-collection" role="tabpanel" aria-labelledby="cl-tab-collection" hidden></section><section id="cl-policy" role="tabpanel" aria-labelledby="cl-tab-policy" hidden></section><section id="cl-push" role="tabpanel" aria-labelledby="cl-tab-push" hidden></section>`;
      pushUi = root.ConversationPushUi.create({container:$('push'),api,escapeHtml:esc,icon,refreshIcons,isActive:() => isActive() && tab === 'push'});
      exportUi = root.ConversationExportUi.create({container:$('export'),api,escapeHtml:esc,icon,refreshIcons,isActive,getFilter:query});
      $('filter').addEventListener('submit', event => { event.preventDefault(); page = 1; run(load); });
      container.removeEventListener('click', handleClick); container.addEventListener('click', handleClick);
      container.querySelector('.cl-tabs').addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        const tabs = [...container.querySelectorAll('[data-cl-tab]')], at = tabs.indexOf(document.activeElement); if (at < 0) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus(); run(() => switchTab(tabs[next].dataset.clTab));
      });
      refreshIcons();
    }
    function query() { return { ...Object.fromEntries(new FormData($('filter'))), ...(sessionFilter || {}), page: String(page) }; }
    function url(path, params = query()) { return '/api/conversation-logs/' + path + '?' + new URLSearchParams(params); }
    function storagePause() {
      return status.storage ? status.storage.pauseReason : status.lastError === 'capacity' ? 'capacity' : '';
    }
    function storageNotice() {
      return ({ capacity: '对话日志实际占用已达容量上限，已暂停新采集', disk_reserve: '磁盘可用空间不足预留值，已暂停新采集' })[storagePause()] || '';
    }
    function overview() {
      $('metrics').innerHTML = [['已归档尝试', num(status.records)],['正文完整', status.gaps === null ? '准备中' : num(status.records - status.gaps)],['日志实际占用', bytes(status.storage?.capacityBytes ?? status.storage?.physicalBytes ?? status.diskBytes)],['排除用户', num(status.policy.excludedUserIds.length)]].map(([label,value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
      const preparing = status.metadataIndex?.ready === false;
      $('index-notice').hidden = !preparing;
      $('index-notice').textContent = preparing ? `历史日志索引正在后台准备：${num(status.metadataIndex.indexed)} / ${num(status.metadataIndex.total)} 条。当前列表、会话和汇总仅包含已准备的记录，原始正文保留。` : '';
      exportUi.setPreparing(preparing);
      $('notice').textContent = !status.configured ? '尚未配置主站采集连接' : !status.policy.enabled ? '对话日志保存已关闭' : storageNotice() || (!status.lastContact ? '等待主站采集连接' : Date.now() - status.lastContact > 60000 ? '近期未收到主站策略读取，请检查采集连接' : status.collectorVersion !== 2 ? '主站仍为旧采集器，正文可能截断；需要同时升级主站' : '采集连接正常');
      setPageMeta(`上游请求与响应归档 · ${status.timezone} · 策略 v${status.policy.version}`);
    }
    async function load() {
      clearTimeout(indexTimer);
      const current = ++seq; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const checkCurrent = () => { if (current !== seq || signal.aborted || !isActive()) throw new DOMException('Request cancelled','AbortError'); };
      try {
      const [next, data] = await Promise.all([api('/api/conversation-logs/status', { signal }),
        tab === 'requests' ? api(url('records'), { signal }) : tab === 'sessions' ? api(url('sessions'), { signal }) : null]);
      checkCurrent();
      const policyChanged = status?.policy.version !== next.policy.version;
      status = next; overview();
      await clearUi.load();
      checkCurrent();
      if (tab === 'push') { await pushUi.load(); return; }
      if (tab === 'policy') { if (!dirty && !saving) renderPolicy(status.policy); await refreshCleanup(); return; }
      if (tab === 'collection') { renderCollection(); await repairUi.load($('history-repair'),status.policy.version); return; }
      if (tab === 'sessions') {
        $('sessions').innerHTML = `<div class="cl-section-heading"><h2>最近会话</h2><span>最多 100 个 · 仅包含有会话标识的请求${data.metadataIndex?.ready === false ? ' · 历史正在准备' : ''}</span></div>${data.items.length ? data.items.map(row => `<button class="cl-session" data-cl-session="${row.session_id}" data-user="${row.user_id}" data-key="${row.key_id}"><strong>用户 #${row.user_id} · Key #${row.key_id}</strong><span>${num(row.turns)} 次请求 / ${num(row.attempts)} 次尝试 · ${esc(time(row.last_at))}</span><code>${row.session_id}</code>${icon('arrow-up-right')}</button>`).join('') : empty(data.metadataIndex?.ready === false ? '历史会话正在准备，请稍候' : '尚无可关联的会话记录')}`;
        refreshIcons(); return;
      }
      report = data;
      $('list').innerHTML = data.items.length ? data.items.map(row => `<button class="cl-record" data-cl-record="${row.id}" aria-pressed="${detail?.id === row.id}"><div><strong>${esc(row.model || row.protocol)}</strong><span>${esc(time(row.at))}</span></div><p>用户 #${row.user_id} · ${esc(row.protocol)} · HTTP ${row.status || '—'}</p><code>${row.request_id.slice(0,20)}</code>${badge(row)}</button>`).join('') : empty(data.metadataIndex?.ready === false ? '历史日志正在准备，请稍候' : '当前筛选下没有记录');
      $('page-label').textContent = `${data.metadataIndex?.ready === false ? '已准备部分 · ' : ''}${num(data.summary.requests)} 次请求 / ${num(data.summary.total)} 次尝试 · ${page} / ${Math.max(1,data.pages)} 页`;
      $('prev').disabled = page <= 1; $('next').disabled = page >= data.pages;
      $('session-filter').innerHTML = sessionFilter ? `<div class="cl-notice">会话筛选 · 用户 #${sessionFilter.user_id} · Key #${sessionFilter.key_id}${tool('x','清除会话筛选','data-cl-action="clear-session"')}</div>` : '';
      refreshIcons();
      if (detail && !data.items.some(row => row.id === detail.id)) clearDetail();
      if (detail && (policyChanged || detail.processing_pending)) await openDetail(detail.id);
      else if (!detail && data.items.length) await openDetail(data.items[0].id);
      } catch(error) { checkCurrent(); throw error; }
      finally {
        if (current === seq && !signal.aborted && isActive() && (status?.metadataIndex?.ready === false || status?.processingPending > 0)) {
          indexTimer = setTimeout(() => { if (current === seq && isActive()) run(load); },5000);
        }
      }
    }
    function clearDetail() { ++detailSeq; detailController?.abort(); detail = null; payloads.clear(); $('inspector').innerHTML = empty('选择一条请求查看原始请求与响应'); }
    async function openDetail(id) {
      const current = ++detailSeq; detailController?.abort(); detailController = new AbortController(); payloads.clear(); detail = null;
      $('inspector').innerHTML = empty('正在读取请求详情');
      let row;
      try { row = await api('/api/conversation-logs/records/' + id, { signal: detailController.signal }); }
      catch(error) { if (current !== detailSeq || !isActive() || tab !== 'requests') return; throw error; }
      if (current !== detailSeq || !isActive() || tab !== 'requests') return;
      detail = row; source = row.masked ? 'masked' : 'original'; detailTab = 'raw';
      container.querySelectorAll('[data-cl-record]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.clRecord === id)));
      renderDetail(); await loadBodies(current);
    }
    function renderDetail() {
      if (!detail) return;
      const limited = Boolean(detail.inspection_warnings?.length);
      const processingTitle = detail.processing_error ? '处理异常 · ' + (processingErrors[detail.processing_error] || '处理异常') : detail.redaction_outdated ? '脱敏规则已有更新' : '可读文本已处理 · 部分内容未检查';
      const retained = !detail.original ? '未保留原文，无法重新识别全部敏感信息' : detail.retry_available ? '已保留加密原文，支持按当前规则重处理' : detail.processing_error || detail.redaction_outdated ? '已保留加密原文' : '已保留加密原文，当前规则已处理';
      $('inspector').innerHTML = `<div class="cl-detail-heading"><div><code>${detail.request_id}</code><h2>${esc(detail.model || detail.protocol + ' 请求')}</h2><p>${badge(detail)} · ${esc(detail.protocol)} · ${esc(modeNames[detail.mode])} · 策略 v${detail.policy_version}</p></div>${tool('x','关闭请求详情','data-cl-action="close-detail"')}</div>${facts([['用户 / Key',`#${detail.user_id} / #${detail.key_id}`],['上游账号',detail.account_id ? '#' + detail.account_id : '未提供'],['时间',time(detail.at)],['耗时',num(detail.duration_ms) + ' ms'],['上游 Host',detail.host || '未提供'],['路径',detail.path]])}
        ${detail.processing_pending ? '<div class="cl-notice cl-processing" role="status">原文已加密保存，等待后台处理；处理完成前暂停推送。</div>' : ''}
        ${detail.reason ? `<div class="cl-notice amber">${esc(reasons[detail.reason] || detail.reason)}</div>` : ''}
        ${detail.upstream_status === 'completed' ? `<div class="cl-notice ${detail.complete ? '' : 'amber'}">${detail.completion_source === 'masked' ? '脱敏副本中有有效完成事件；原文未保留，来源按副本注明。' : '已解析并核对上游应用完成事件。'}${!detail.complete ? ' 原始采集仍标记异常，不能据此证明请求、响应或用户端逐字节完整，也不会放宽推送完整性条件。' : ''} · ${esc(detail.upstream_evidence)}</div>` : ''}
        ${detail.processing_error || detail.redaction_outdated || limited ? `<div class="cl-notice amber cl-processing" role="status"><div><strong>${esc(processingTitle)}</strong><span>${esc(retained)} · ${esc(detail.processing_error || (limited ? '含未检查内容，暂停脱敏推送' : '旧副本暂停脱敏推送'))} · 处理策略 v${detail.processing_policy_version}</span>${limited ? '<span>部分内容原样保留，其内部未检查；其他可读文本已按该副本规则处理。</span>' : ''}${detail.retry_blocked === 'user_excluded' ? '<span>该用户已排除，不能重新处理</span>' : detail.retry_blocked === 'model_excluded' ? '<span>该模型不在采集名单中，不能重新处理</span>' : ''}</div><button type="button" class="button secondary" data-cl-action="reprocess" title="处理失败或规则更新后可重处理；重复处理无法检查图片或解密模型上下文" ${!detail.retry_available || reprocessing.has(detail.id) ? 'disabled' : ''}>${icon('refresh-cw')}${reprocessing.has(detail.id) ? '处理中' : '重新处理'}</button></div>` : detail.processing_policy_version ? `<p class="cl-muted">脱敏策略 v${detail.processing_policy_version} · ${esc(time(detail.processed_at))}</p>` : ''}
        <div class="cl-attempts"><span>请求尝试</span>${detail.attempts.map((row,index) => `<button data-cl-attempt="${row.id}" aria-pressed="${row.id === detail.id}">#${index + 1} · ${row.status || '连接错误'} · 账号 ${row.account_id || '未提供'}</button>`).join('')}</div>
        <div class="cl-detail-tabs" role="tablist" aria-label="请求详情视图">${[['raw','Request / Response'],['frames',`消息 (${detail.frames.length})`],['redactions','脱敏记录']].map(([id,label]) => `<button data-cl-detail="${id}" role="tab" aria-selected="${id === detailTab}">${label}</button>`).join('')}<select id="cl-source" aria-label="日志版本"><option value="masked" ${source === 'masked' ? 'selected' : ''} ${!detail.masked ? 'disabled' : ''}>脱敏副本</option><option value="original" ${source === 'original' ? 'selected' : ''} ${!detail.original ? 'disabled' : ''}>原文</option></select></div><div id="cl-detail-body"></div>`;
      $('source').addEventListener('change', () => { source = $('source').value; payloads.clear(); renderDetailBody(); if (detailTab === 'raw') run(() => loadBodies(detailSeq)); });
      if (detail.completion_version && detail.upstream_status !== 'completed') {
        const evidence = document.createElement('p'); evidence.className = 'cl-muted';
        evidence.textContent = `上游完成检查：${({unknown:'未见可靠完成证据',unverified:'无法核验',failed:'执行失败',incomplete:'未完整完成'})[detail.upstream_status] || '待检查'} · ${detail.upstream_evidence}`;
        container.querySelector('.cl-detail-heading').after(evidence);
      }
      if (limited) {
        const scope = container.querySelector('.cl-processing > div > span:nth-of-type(2)');
        const scopes = [['OPAQUE_SIGNATURE','模型协议签名'],['OPAQUE_ENCRYPTED_REASONING','模型加密推理'],['OPAQUE_ENCRYPTED_COMPACTION','模型加密压缩上下文'],['OPAQUE_IMAGE','协议图片']].filter(([code]) => detail.inspection_warnings.includes(code)).map(([,name]) => name).join('、');
        if (scope) scope.textContent = `${scopes || '不透明协议内容'}原样保留，其内部未检查；其他可读文本已按该副本规则处理。${detail.inspection_warnings.includes('OPAQUE_IMAGE') ? '图片中的文字、人脸及其他敏感信息未识别，外部图片未下载。' : ''}${!detail.processing_error && !detail.redaction_outdated ? '此检查范围提示不代表正文漏存；重复处理无法消除内部检查限制。' : ''}`;
      }
      if (detail.processing_error === 'UNINSPECTABLE_CONTENT') {
        const explanation = document.createElement('span');
        explanation.textContent = '旧规则可能因协议图片、普通链接、模型协议签名、加密推理、加密压缩上下文或工具业务文件编号触发，可按最新规则重处理。已识别图片和加密上下文原样保留并单独提示检查范围；未识别媒体、外部文件及加密正文仍可能无法检查，原文不会因此丢失。';
        container.querySelector('.cl-processing > div')?.append(explanation);
      }
      renderTransport();
      renderDetailBody(); refreshIcons();
    }
    function renderTransport() {
      if (!detail.transport_diagnostics && !['transport_error','read_error','closed_early','session_closed'].includes(detail.reason)) return;
      const block = document.createElement('div'); block.className = 'cl-notice cl-transport';
      if (!detail.transport_diagnostics) {
        block.textContent = '此记录未采集底层错误类型和发生侧，无法区分断流、超时或完成后的关闭。重新处理只能检查已保存正文，无法补回缺失字节或还原历史错误。';
      } else {
        const kinds = {cancelled:'取消',deadline:'截止时间已到',unexpected_eof:'非正常 EOF',closed:'连接或管道已关闭',timeout:'网络超时',network:'网络错误',other:'其他读取错误'};
        const heading = document.createElement('strong'); heading.textContent = '传输读取信息'; block.append(heading);
        for (const [side,label] of [['request','Request'],['response','Response']]) {
          const value = detail.transport_diagnostics[side],line = document.createElement('p');
          line.textContent = `${label}：已观察 ${bytes(value.bytes)}；声明长度 ${value.expected_bytes < 0 ? '未知' : bytes(value.expected_bytes)}；${value.eof ? '已读到 EOF' : '未读到 EOF'}${value.error ? '；' + (kinds[value.error] || '未知读取错误') + (value.error_during_close ? '（错误返回时已开始关闭，不代表关闭导致错误）' : '（错误返回时尚未开始关闭）') : ''}。`;
          block.append(line);
        }
        const note = document.createElement('p'); note.textContent = '只记录网关实际读取的字节和错误枚举；关闭时机与完成事件都不能单独证明传输或用户端收齐。'; block.append(note);
      }
      container.querySelector('.cl-detail-heading').after(block);
    }
    function pane(side, title) { return `<section class="cl-body-pane"><header><strong>${esc(title)}</strong><span>RAW</span><div>${tool('maximize-2','查看完整 ' + title,`data-cl-full="${side}" hidden`)}${tool('copy','复制 ' + title,`data-cl-copy="${side}" disabled`)}${tool('download','下载 ' + title,`data-cl-download="${side}" disabled`)}</div></header><pre class="cl-raw" tabindex="0"><code id="cl-body-${side}">正在读取</code></pre><footer id="cl-info-${side}"></footer></section>`; }
    function renderDetailBody() {
      if (!detail) return;
      if (detailTab === 'raw') $('detail-body').innerHTML = `<div class="cl-bodies">${pane('request','Request')}${pane('response','Response')}</div>`;
      else if (detailTab === 'frames') $('detail-body').innerHTML = detail.frames.length ? `<div class="cl-frames">${detail.frames.map(frame => `<button data-cl-frame="${frame.index}" class="cl-frame"><strong>#${frame.index + 1} ${frame.direction === 'out' ? 'Request →' : '← Response'}</strong><span>+${frame.at} ms · ${bytes(frame.bytes)} · ${frame.binary ? 'Binary' : 'Text'}</span>${icon('chevron-down')}</button>`).join('')}</div><div id="cl-frame-view"></div>` : empty('此请求没有 WebSocket 消息');
      else $('detail-body').innerHTML = detail.hits.length ? `<div class="table-wrap"><table><thead><tr><th>规则</th><th>占位符</th><th>命中次数</th></tr></thead><tbody>${detail.hits.map(hit => `<tr><td>${esc(hit.name)}</td><td><code>${esc(hit.replacement)}</code></td><td>${hit.count}</td></tr>`).join('')}</tbody></table></div>` : empty(detail.processing_error ? '处理异常，尚无脱敏副本' : detail.reason === 'redaction_failed' ? '旧记录未保留正文或命中值' : '此记录没有脱敏命中');
      refreshIcons();
    }
    async function loadPayload(side, current, { full = false, raw = false, render = true } = {}) {
      if (!detail?.[source]) { const node = $('body-' + side); if (node) node.textContent = '此版本未保存'; return null; }
      const requestedSource = source, requestedId = detail.id, view = raw ? 'raw' : full ? 'text' : 'preview';
      const prefix = requestedId + ':' + source + ':' + side + ':', key = prefix + view;
      let pending = payloads.get(key) || (!raw && (payloads.get(prefix + 'raw') || payloads.get(prefix + 'text')));
      if (!pending) {
        pending = api(`/api/conversation-logs/records/${requestedId}/payload/${side}?source=${requestedSource}${raw ? '' : '&view=' + view}`, { signal: detailController.signal });
        payloads.set(key, pending);
      }
      let data;
      try { data = await pending; }
      catch (error) {
        if (payloads.get(key) === pending) payloads.delete(key);
        if (current !== detailSeq || !isActive() || tab !== 'requests' || source !== requestedSource || detail?.id !== requestedId) return null;
        throw error;
      }
      if (current !== detailSeq || !isActive() || tab !== 'requests' || source !== requestedSource || detail?.id !== requestedId) return null;
      if (!render) return data;
      const node = $('body-' + side); if (node) node.textContent = data.text ?? '二进制或不支持的编码，可下载原始字节';
      const info = $('info-' + side); if (info) info.textContent = `${data.truncated ? '预览 · ' : ''}${bytes(data.bytes)} · SHA-256 ${data.sha256}`;
      const expand = container.querySelector(`[data-cl-full="${side}"]`); if (expand) expand.hidden = !data.truncated;
      for (const button of container.querySelectorAll(`[data-cl-download="${side}"], [data-cl-copy="${side}"]`)) button.disabled = button.hasAttribute('data-cl-copy') && data.text === null;
      return data;
    }
    async function loadBodies(current) { await Promise.all(['request','response'].map(side => loadPayload(side,current))); }
    function renderCollection() {
      const storage = status.storage;
      const storageValue = key => storage?.[key] ?? storage?.breakdown?.[key] ?? null;
      const physicalBytes = storageValue('physicalBytes') ?? status.diskBytes;
      const reusableBytes = storageValue('reusableBytes') ?? 0;
      const walBytes = storageValue('walBytes') ?? 0;
      const shmBytes = storageValue('shmBytes') ?? 0;
      const databaseBytes = storageValue('databaseBytes') ?? Math.max(0, physicalBytes - walBytes - shmBytes);
      const databaseChargedBytes = storageValue('databaseChargedBytes') ?? Math.max(0, databaseBytes - reusableBytes);
      const quotaBytes = storageValue('quotaBytes') ?? Math.max(0, databaseChargedBytes + walBytes + shmBytes);
      const capacityBytes = storageValue('capacityBytes') ?? physicalBytes;
      const accountingNote = storage?.accountingReady === false ? 'SQLite 页统计暂不可用，当前按主库文件 + WAL + SHM 全额计入；统计恢复后会重新核算可复用空间。' : '主库中已释放、可由 SQLite 复用的空间不计入容量；数据库文件实际占用还包括这部分可复用空间。';
      const capacityBreakdown = storage ? `<section class="cl-capacity-breakdown" aria-label="对话日志容量构成"><div class="cl-capacity-heading"><strong>对话日志容量阈值</strong><span>${bytes(databaseBytes)} + ${bytes(walBytes)} + ${bytes(shmBytes)} = ${bytes(capacityBytes)}</span></div><p class="cl-muted">容量上限按对话日志物理文件实际占用判断：主库文件 + WAL 日志文件 + SHM 共享文件。计入容量仅作为参考统计。${accountingNote}</p><div class="cl-capacity-parts">${[['主库文件实际占用',databaseBytes],['WAL 日志文件',walBytes],['SHM 共享文件',shmBytes],['实际占用合计（阈值口径）',physicalBytes],['计入容量（参考）',quotaBytes],['可复用空间',reusableBytes]].map(([label,value]) => `<div><span>${label}</span><strong>${bytes(value)}</strong></div>`).join('')}</div></section>` : '';
      const space = [['实际占用（阈值）',bytes(capacityBytes)],['容量上限',bytes(status.policy.capacity * 1073741824)],['计入容量（参考）',bytes(quotaBytes)],
        ...(storage ? [['可复用空间',bytes(storage.reusableBytes)]] : []),['磁盘可用',bytes(status.freeBytes)]];
      const lastError = status.lastError === 'capacity' && storage && !storage.pauseReason ? '' : status.lastError;
      $('collection').innerHTML = `<div class="cl-section-heading"><h2>采集状态</h2><span>${!status.policy.enabled ? '保存已关闭' : storageNotice() || '已启用保存'}</span></div>${capacityBreakdown}${facts([['最近策略读取',time(status.lastContact)],['归档尝试',num(status.records)],['不完整 / 缺失',num(status.gaps)],['采集端累计丢弃',num(status.collectorDropped)],...space,['保存版本',modeNames[status.policy.mode]],['保留时长',status.policy.retention ? status.policy.retention + ' 天' : '永久'],['正文采集',status.collectorVersion === 2 ? '完整正文 · 无单条截断' : '等待新版采集器'],['最近异常',reasons[lastError] || lastError || '无']])}<div class="cl-notice amber">用户对话优先。内存、队列或存储不足时放弃归档；上游断流只保留实际收到的部分并标记不完整。完整采集不代表模型执行成功。</div>`;
      const section = document.createElement('section'); section.id = 'cl-history-repair'; section.className = 'clp-section cl-model-cleanup'; $('collection').append(section);
    }
    function renderPolicy(value) {
      policy = value; excluded = new Set(value.excludedUserIds); users.clear(); dirty = false;
      $('policy').innerHTML = `<form id="cl-policy-form" class="cl-policy-form"><div class="cl-section-heading"><h2>保存策略 <small>v${value.version}</small></h2><span id="cl-dirty" role="status"></span></div><label class="cl-setting"><span>保存对话日志</span><input name="enabled" type="checkbox" role="switch" ${value.enabled ? 'checked' : ''}></label>
        <fieldset><legend>排除用户</legend><div class="cl-user-toolbar"><span id="cl-excluded-count"></span><button class="cl-link" type="button" data-cl-action="clear-users">清空选择</button></div><div id="cl-selected-users" class="cl-selected-users"></div><div class="cl-user-search"><input id="cl-user-search" type="search" aria-label="搜索排除用户" placeholder="输入用户名、邮箱或用户 ID" autocomplete="off">${tool('search','搜索排除用户','data-cl-action="search-users"')}</div><div id="cl-users" role="group" aria-label="不采集的用户"></div><p class="cl-muted">所选用户全部 Key 均不采集，不保存正文、元数据、索引、会话或缺口。保存时也会丢弃尚未入库的请求；历史记录按原保留期处理。</p></fieldset>
        <fieldset><legend>采集模型</legend><label class="cl-setting"><span>仅记录所选模型</span><input name="modelFilterEnabled" type="checkbox" role="switch" ${value.modelFilterEnabled ? 'checked' : ''}></label><label class="cl-model-list">模型名单<textarea name="allowedModels" rows="9" maxlength="20099" aria-label="允许记录的模型" spellcheck="false" placeholder="gpt-6.1-sol&#10;claude-fable-5-1&#10;gemini-carbon">${esc(value.allowedModels.join('\n'))}</textarea></label><label class="cl-setting"><span>Kimi K3 及后续版本</span><input name="kimiK3Plus" type="checkbox" ${value.kimiK3Plus ? 'checked' : ''}></label><p class="cl-muted">按实际上游模型匹配，忽略大小写和空格，兼容 Fable / Opus 简称。名单外或模型无法识别时不新增归档；历史记录保留。空名单且未勾选 Kimi 时不记录任何模型。</p></fieldset>
        <fieldset><legend>保存版本</legend><div class="cl-modes">${Object.entries(modeNames).map(([id,label]) => `<label><input type="radio" name="mode" value="${id}" ${value.mode === id ? 'checked' : ''}>${label}</label>`).join('')}</div><p class="cl-muted">原文含完整敏感内容，仅管理员可读。处理异常或仍有未检查内容时保留加密原文；仅脱敏记录成功且无未检查内容后才移除临时原文。</p></fieldset>
        <fieldset><legend>脱敏规则</legend><div class="cl-rules">${[['email','邮箱地址'],['phone','电话号码'],['secret','密码、凭据与验证码'],['identity','身份证、护照与证件'],['financial','银行卡与金融账户'],['personal','姓名、地址与个人资料'],['ip','IPv4 / IPv6 地址'],['device','设备与社交标识']].map(([id,label]) => `<label>${label}<input name="${id}" type="checkbox" ${value[id] ? 'checked' : ''}></label>`).join('')}</div><p class="cl-muted">姓名、地址等依赖字段或文字标签识别。已识别协议图片、签名和加密推理原样保留并提示未检查，加密压缩上下文同样保留；其他无法处理的媒体、文件或加密内容保留原文并标记异常。</p><div id="cl-custom-rules"></div><button type="button" class="button secondary" data-cl-action="add-rule">${icon('plus')}添加文本规则</button></fieldset>
        <fieldset><legend>容量与保留</legend><div class="cl-policy-grid"><label>保留天数（0 为永久）<input name="retention" type="number" min="0" max="365" value="${value.retention}" required></label><label>对话日志实际占用上限 (GiB)<input name="capacity" type="number" min="1" max="1024" value="${value.capacity}" required></label><label>磁盘预留（应急保护 GiB）<input name="reserve" type="number" min="0" max="1024" value="${value.reserve}" required></label></div><p class="cl-muted">容量上限按 archive.sqlite、WAL 和 SHM 的实际文件占用判断；计入容量仅用于参考。磁盘预留是整机写入前的独立应急保护，外部监控仍可根据整机空间动态调整本上限。空间不足时停止保存新日志，保留历史。</p></fieldset><p id="cl-policy-error" class="form-error" role="alert"></p><footer><button id="cl-save" class="button primary" type="submit">${icon('save')}保存策略</button><button class="button secondary" type="button" data-cl-action="discard-policy">放弃更改</button></footer></form>`;
      for (const rule of value.custom) addRule(rule);
      updateExcluded();
      $('policy-form').addEventListener('input', markDirty);
      $('policy-form').addEventListener('change', event => { if (event.target.matches('[data-cl-user]')) { const id = Number(event.target.dataset.clUser); event.target.checked ? excluded.add(id) : excluded.delete(id); updateExcluded(); } markDirty(); });
      $('policy-form').addEventListener('submit', event => { event.preventDefault(); run(savePolicy); });
      $('user-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => run(searchUsers), 350); });
      $('user-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(searchUsers); } });
      const cleanupSection = document.createElement('section'); cleanupSection.id = 'cl-model-cleanup'; cleanupSection.className = 'clp-section cl-model-cleanup';
      $('policy').append(cleanupSection); renderCleanup();
      refreshIcons();
    }
    function markDirty() { dirty = true; if ($('dirty')) $('dirty').textContent = '有未保存更改'; renderCleanup(); }
    function renderCleanup() {
      const host = $('model-cleanup'); if (!host || !policy) return;
      const job = cleanupState?.job, running = ['pending','running'].includes(job?.status);
      const ready = policy.modelFilterEnabled && (policy.allowedModels.length || policy.kimiK3Plus);
      const names = { pending:'等待后台清理', running:'后台清理中', done:'清理完成', cancelled:'已停止', paused:'模型名单已变化，清理已暂停' };
      const errors = { MODEL_POLICY_CHANGED:'请核对当前模型名单后重新启动', CLEANUP_WORKER_UNAVAILABLE:'清理进程暂不可用，将自动重试', CLEANUP_STORAGE_UNAVAILABLE:'存储暂不可用，将稍后重试' };
      host.innerHTML = `<div class="cl-section-heading"><h2>历史模型清理</h2><span>使用已保存的模型名单</span></div><p class="cl-muted">删除名单外的历史日志，包含未知模型的记录、正文和索引；删除后无法恢复。所选模型与新增归档保留。</p><div class="cl-cleanup-actions"><button class="button secondary" type="button" data-cl-action="cleanup-models" ${cleanupBusy || running || cleanupState?.activeScope === 'all' || dirty || saving || !ready ? 'disabled' : ''}>${icon('trash-2')}后台清理名单外日志</button>${running ? `<button class="button secondary" type="button" data-cl-action="stop-model-cleanup" ${cleanupBusy ? 'disabled' : ''}>${icon('square')}停止清理</button>` : ''}</div><p id="cl-cleanup-progress" class="cl-muted" role="status">${job ? `${esc(names[job.status] || job.status)} · 已扫描 ${num(job.scanned)} 条 · 已删除 ${num(job.deleted)} 条 · 启动策略 v${job.policy_version}` : '尚未启动清理'}${cleanupState?.activeScope === 'all' ? ' · 正在清空全部历史' : ''}${dirty ? ' · 请先保存模型名单' : !ready ? ' · 请先启用并保存至少一个模型' : ''}${job?.error_code || cleanupState?.lastError ? '<br>' + esc(errors[job?.error_code || cleanupState.lastError] || '清理暂不可用') : ''}</p>`;
      refreshIcons();
    }
    async function refreshCleanup() {
      if (!isActive() || tab !== 'policy') return;
      const epoch = lifecycle; cleanupController?.abort(); cleanupController = new AbortController(); clearTimeout(cleanupTimer);
      const value = await api('/api/conversation-logs/model-cleanup', { signal: cleanupController.signal });
      if (epoch !== lifecycle || !isActive() || tab !== 'policy') return;
      cleanupState = value; renderCleanup();
      if (value.activeScope) cleanupTimer = setTimeout(() => run(refreshCleanup), 2000);
    }
    async function startCleanup() {
      if (cleanupBusy || dirty || saving) return;
      const epoch = lifecycle; cleanupBusy = true; renderCleanup();
      try {
        const value = await api('/api/conversation-logs/model-cleanup', { method:'POST', body:JSON.stringify({policy_version:policy.version}) });
        if (epoch !== lifecycle || !isActive() || tab !== 'policy') return;
        cleanupState = value; toast('已安排后台清理'); await refreshCleanup();
      } finally { if (epoch === lifecycle) { cleanupBusy = false; renderCleanup(); } }
    }
    async function stopCleanup() {
      if (cleanupBusy || !cleanupState?.job) return;
      const epoch = lifecycle, id = cleanupState.job.id; cleanupBusy = true; renderCleanup();
      try {
        const value = await api(`/api/conversation-logs/model-cleanup/${id}/cancel`, { method:'POST',body:'{}' });
        if (epoch !== lifecycle || !isActive() || tab !== 'policy') return;
        cleanupState = value; clearTimeout(cleanupTimer); renderCleanup();
      } finally { if (epoch === lifecycle) { cleanupBusy = false; renderCleanup(); } }
    }
    function updateExcluded() {
      $('excluded-count').textContent = `已排除 ${excluded.size} 位用户`;
      $('selected-users').innerHTML = [...excluded].map(id => `<span>用户 #${id}${tool('x','取消排除用户 ' + id,`data-cl-remove-user="${id}"`)}</span>`).join('');
      container.querySelectorAll('[data-cl-user]').forEach(input => { input.checked = excluded.has(Number(input.dataset.clUser)); });
      refreshIcons();
    }
    async function searchUsers() {
      const term = $('user-search').value.trim(), current = ++searchSeq; userController?.abort(); userController = new AbortController();
      if (!term) { $('users').textContent = ''; return; }
      $('users').textContent = '正在搜索';
      try {
        const data = await api(url('users',{ search:term }), { signal:userController.signal });
        if (current !== searchSeq || !isActive() || tab !== 'policy') return;
        data.items.forEach(user => users.set(user.id,user));
        $('users').innerHTML = data.items.length ? data.items.map(user => `<label class="cl-user"><input data-cl-user="${user.id}" type="checkbox" ${excluded.has(user.id) ? 'checked' : ''}><span><strong>${esc(user.username || '用户 #' + user.id)}</strong><small>#${user.id} · ${esc(user.email)}</small></span></label>`).join('') : empty('没有匹配的用户');
      } catch(error) { if (error.name !== 'AbortError' && current === searchSeq && isActive()) $('users').textContent = error.message; }
    }
    function addRule(rule = {from:'',to:''}) {
      if ($('custom-rules').children.length >= 50) return;
      const row = document.createElement('div'); row.className = 'cl-custom-rule';
      row.innerHTML = `<input data-rule-from value="${esc(rule.from)}" minlength="2" maxlength="120" placeholder="匹配文本" aria-label="规则匹配文本" required><span>→</span><input data-rule-to value="${esc(rule.to)}" maxlength="80" placeholder="替换文本" aria-label="规则替换文本" required>${tool('trash-2','删除文本规则','data-cl-action="remove-rule"')}`;
      $('custom-rules').append(row); refreshIcons();
    }
    async function savePolicy() {
      if (saving) return;
      const data = new FormData($('policy-form')), body = { ...policy, enabled:data.has('enabled'), mode:data.get('mode'), excludedUserIds:[...excluded], modelFilterEnabled:data.has('modelFilterEnabled'), allowedModels:String(data.get('allowedModels')).split(/\r?\n/).map(value => value.trim()).filter(Boolean), kimiK3Plus:data.has('kimiK3Plus'), retention:Number(data.get('retention')), capacity:Number(data.get('capacity')), reserve:Number(data.get('reserve')), overflow:'stop', custom:[...$('custom-rules').children].map(row => ({ from:row.querySelector('[data-rule-from]').value, to:row.querySelector('[data-rule-to]').value })) };
      for (const field of ['email','phone','secret','ip','identity','financial','personal','device']) body[field] = data.has(field);
      const epoch = lifecycle;
      saving = true; $('policy-error').textContent = ''; $('policy-form').querySelectorAll('input,button,select,textarea').forEach(node => { node.disabled = true; });
      renderCleanup();
      try {
        const value = await api('/api/conversation-logs/policy', { method:'PUT',body:JSON.stringify(body) });
        if (!isActive() || epoch !== lifecycle) return; dirty = false; status.policy = value; overview(); renderPolicy(value); toast('保存策略已生效');
      } catch(error) { if (isActive() && epoch === lifecycle && $('policy-error')) $('policy-error').textContent = error.code === 'CONVERSATION_POLICY_CONFLICT' ? '策略已被其他管理员修改，请放弃更改后重新读取' : error.message; }
      finally { saving = false; if ($('policy-form')) $('policy-form').querySelectorAll('input,button,select,textarea').forEach(node => { node.disabled = false; }); renderCleanup(); }
    }
    function download(blob, name) { const href = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = href; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(href),1000); }
    async function reprocess() {
      if (!detail?.retry_available || reprocessing.has(detail.id)) return;
      const id = detail.id, current = detailSeq, epoch = lifecycle, processedAt = detail.processed_at;
      reprocessing.add(id); const button = container.querySelector('[data-cl-action="reprocess"]'); if (button) button.disabled = true;
      try {
        const row = await api(`/api/conversation-logs/records/${id}/reprocess`, { method: 'POST', body: JSON.stringify({ policy_version: status.policy.version, processed_at: processedAt }) });
        if (!isActive() || epoch !== lifecycle || current !== detailSeq || detail?.id !== id || tab !== 'requests') return;
        reprocessing.delete(id); payloads.clear(); detail = row; source = row.masked ? 'masked' : 'original';
        renderDetail(); if (detailTab === 'raw') await loadBodies(current);
        toast(row.processing_error ? '处理仍有异常，原文已保留' : row.inspection_warnings?.length ? '可读文本已处理，仍有未检查内容' : '重新处理完成', row.processing_error ? 'error' : undefined);
        await load();
      } finally {
        reprocessing.delete(id);
        if (epoch === lifecycle && detail?.id === id) { const node = container.querySelector('[data-cl-action="reprocess"]'); if (node) node.disabled = !detail.retry_available; }
      }
    }
    async function switchTab(value) {
      if (!['requests','sessions','collection','policy','push'].includes(value)) return;
      if (value !== tab) { ++searchSeq; userController?.abort(); clearTimeout(searchTimer); clearTimeout(cleanupTimer); cleanupController?.abort(); clearDetail(); pushUi.leave(); repairUi.leave(); }
      tab = value;
      for (const id of ['requests','sessions','collection','policy','push']) { $(id).hidden = id !== tab; $('tab-' + id).setAttribute('aria-selected',String(id === tab)); $('tab-' + id).tabIndex = id === tab ? 0 : -1; }
      await load();
    }
    function handleClick(event) {
      const node = event.target.closest('button'); if (!node || node.disabled) return;
      const d = node.dataset;
      if (d.clTab) return run(() => switchTab(d.clTab));
      if (d.clRecord || d.clAttempt) return run(() => openDetail(d.clRecord || d.clAttempt));
      if (node.id === 'cl-prev' || node.id === 'cl-next') { page += node.id === 'cl-next' ? 1 : -1; return run(load); }
      if (d.clSession) { sessionFilter = {session_id:d.clSession,user_id:d.user,key_id:d.key}; page = 1; return run(() => switchTab('requests')); }
      if (d.clDetail) { detailTab = d.clDetail; renderDetail(); if (detailTab === 'raw') run(() => loadBodies(detailSeq)); return; }
      if (d.clFrame !== undefined) { $('frame-view').innerHTML = pane('frame-' + d.clFrame,'消息 #' + (Number(d.clFrame)+1)); refreshIcons(); return run(() => loadPayload('frame-' + d.clFrame,detailSeq)); }
      if (d.clFull) return run(() => loadPayload(d.clFull,detailSeq,{ full:true }));
      if (d.clCopy || d.clDownload) return run(async () => { const side = d.clCopy || d.clDownload, value = await loadPayload(side,detailSeq,{ full:true,raw:Boolean(d.clDownload),render:false }); if (!value) return; if (d.clCopy) { await navigator.clipboard.writeText(value.text); toast('已复制原始文本'); } else { const raw = Uint8Array.from(atob(value.base64),ch => ch.charCodeAt(0)); download(new Blob([raw]),`conversation-${detail.id}-${source}-${side}.raw`); } });
      if (d.clRemoveUser) { excluded.delete(Number(d.clRemoveUser)); updateExcluded(); markDirty(); return; }
      const action = d.clAction;
      if (action === 'cleanup-models') return run(startCleanup);
      if (action === 'stop-model-cleanup') return run(stopCleanup);
      if (action === 'reprocess') return run(reprocess);
      if (action === 'close-detail') clearDetail();
      if (action === 'reset-filter') { $('filter').reset(); sessionFilter = null; page = 1; run(load); }
      if (action === 'clear-session') { sessionFilter = null; page = 1; run(load); }
      if (action === 'clear-users') { excluded.clear(); updateExcluded(); markDirty(); }
      if (action === 'search-users') run(searchUsers);
      if (action === 'add-rule') { addRule(); markDirty(); }
      if (action === 'remove-rule') { node.closest('.cl-custom-rule').remove(); markDirty(); }
      if (action === 'discard-policy') { dirty = false; run(load); }
    }
    function leave() { ++seq; ++detailSeq; ++searchSeq; ++lifecycle; controller?.abort(); detailController?.abort(); userController?.abort(); cleanupController?.abort(); clearTimeout(indexTimer); clearTimeout(cleanupTimer); cleanupState = null; cleanupBusy = false; pushUi?.leave(); exportUi?.leave(); repairUi.leave(); clearUi.leave(); clearTimeout(searchTimer); payloads.clear(); detail = null; report = null; dirty = false; if ($('index-notice')) $('index-notice').hidden = true; for (const id of ['inspector','list','sessions','collection','policy','metrics','notice','history-clear']) if ($(id)) $(id).innerHTML = ''; }
    function reset() { leave(); status = null; policy = null; users.clear(); excluded.clear(); sessionFilter = null; page = 1; tab = 'requests'; container.innerHTML = ''; init(); }
    init(); return { load, leave, reset };
  }
  root.ConversationLogsUi = {create};
})(window);
