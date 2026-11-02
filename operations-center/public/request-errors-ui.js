(function (root) {
  'use strict';
  const outputs = { none: '未输出内容', partial: '已输出部分内容', complete: '完整输出', unknown: '输出情况未知' };
  const retries = { recovered: '自动重试成功', exhausted: '自动重试次数耗尽', retried_failed: '自动重试后仍失败',
    not_retried: '未发起自动重试', stopped_after_output: '输出后失败，未重试', unknown: '重试证据不足' };
  const delivery = { http_error: '错误响应', body_error: '错误正文', sse_error: 'SSE error', response_failed: 'response.failed', incomplete_close: '提前断流 · 无错误事件', complete: '正常结束' };
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, isActive }) {
    const $ = id => document.getElementById(id);
    const outer = $('ra-filter'), local = $('ra-local');
    let options = null, report = null, selectedUser = null, seq = 0, detailSeq = 0, controller = null, detailController = null, timer = null;
    let state = { view: 'types', day: '', scopeGroupId: '', keyId: '', userId: '', page: 1, expanded: new Set() };
    const number = n => new Intl.NumberFormat('zh-CN').format(n || 0);
    const time = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: options?.timezone || 'Asia/Shanghai', hour12: false }) : '未记录';
    const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const empty = text => `<div class="ra-empty">${esc(text)}</div>`;
    const link = (value, attrs = '') => `<button type="button" class="ra-link" ${attrs}>${esc(value)}</button>`;
    const mix = types => types.slice(0, 2).map(t => `${t.label} ${t.count}`).join(' · ') + (types.length > 2 ? ` · 其他 ${types.length - 2} 类` : '');
    const badge = r => `<span class="badge ${['http', 'stream'].includes(r.outcome) ? 'error' : r.outcome === 'recovered' ? 'success' : 'warning'}">${esc(!r.linked ? '待关联记录' : options.outcomes[r.outcome])}</span>`;
    const response = r => `${r.wire ? 'HTTP ' + r.wire : 'HTTP 未记录'}${r.delivery ? ' · ' + delivery[r.delivery] : ''}`;
    const finalEvidence = r => r.evidence.final === 'telemetry.request_end.resultVersion=1' ? '主站最终响应记录' :
      r.evidence.final ? '主站 HTTP 结束状态及响应写出记录' : '缺少最终响应证据';
    const currentQuery = () => {
      const q = { ...Object.fromEntries(new FormData(outer)), ...Object.fromEntries(new FormData(local)), ...state, expanded: undefined, pageSize: '20' };
      return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
    };
    function run(task) { task().catch(e => { if (e.name !== 'AbortError' && isActive()) toast(e.message, 'error'); }); }
    function clearLocal() {
      local.reset(); Object.assign(state, { scopeGroupId: '', keyId: '', userId: '', page: 1 }); selectedUser = null;
    }
    function fill(select, entries, label, chosen) {
      const list = [...entries];
      if (chosen && !list.some(e => e.id === chosen)) list.push({ id: chosen, name: chosen });
      select.innerHTML = `<option value="">${label}</option>` + list.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
      select.value = chosen || '';
    }
    async function load({ refresh = false } = {}) {
      const current = ++seq; controller?.abort(); controller = new AbortController(); clearTimeout(timer);
      const signal = controller.signal;
      $('ra-status').hidden = false; $('ra-status').textContent = '正在读取错误分析';
      try {
        if (!options || refresh) {
          const value = await api('/api/request-errors/options', { signal });
          if (seq !== current || !isActive()) return;
          const previousToday = options?.today, initialize = !options;
          const followToday = previousToday && outer.elements.start.value === previousToday && outer.elements.end.value === previousToday;
          options = value;
          for (const k of ['start', 'end']) {
            if (initialize || followToday && previousToday !== options.today) outer.elements[k].value = options.defaultRange[k];
            outer.elements[k].max = options.today;
          }
          if (initialize || followToday && previousToday !== options.today) state.day = options.today;
          if (initialize) {
            local.elements.failureType.innerHTML = '<option value="all">全部失败类型</option>' + Object.entries(options.failureTypes).map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
            local.elements.cause.innerHTML = '<option value="all">全部来源</option>' + Object.entries(options.causes).map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
          }
        }
        const q = currentQuery(); if (refresh) q.refresh = '1';
        const value = await api(`/api/request-errors/report?${new URLSearchParams(q)}`, { signal });
        if (seq !== current || !isActive()) return;
        report = value; render(); $('ra-data').hidden = false; $('ra-status').hidden = true;
        setPageMeta(`${value.query.range.start} 至 ${value.query.range.end} · ${value.timezone} · 更新于 ${time(value.generatedAt)}`);
      } catch (error) {
        if (seq !== current || !isActive() || error.name === 'AbortError') return;
        $('ra-data').hidden = true; $('ra-status').hidden = false; $('ra-status').textContent = error.message;
        throw error;
      } finally {
        if (seq === current && isActive() && !document.hidden && options && outer.elements.end.value === options.today) timer = setTimeout(() => run(() => load({ refresh: true })), 60000);
      }
    }
    function typesTable(types, interactive = true) {
      if (!types.length) return empty('当前范围没有已确认的下游失败');
      const action = (t, value, view) => interactive ? link(value, `data-type="${esc(t.id)}" data-target-view="${view}"`) : esc(value);
      return table(['最终失败类型', '下游实际响应', '失败请求', '占同范围失败', '重试后仍失败', '影响用户'], types.map(t => `<tr><td>${action(t, t.label, 'groups')}<small>${esc(t.output.map(o => outputs[o]).join(' / '))}</small></td><td>${t.responses.map(esc).join('<br>')}</td><td>${action(t, number(t.count), 'requests')}</td><td>${t.share == null ? '—' : (t.share * 100).toFixed(1) + '%'}</td><td>${number(t.retryFailed)}<small>${t.notRetried ? '未重试 ' + t.notRetried : ''}${t.retryUnknown ? ' 重试未知 ' + t.retryUnknown : ''}</small></td><td>${action(t, number(t.users), 'users')}</td></tr>`).join(''));
    }
    function counts(s, attrs) {
      return `<td>${link(number(s.failed), `${attrs} data-result="failed"`)}</td><td>${s.failedAttempts}${s.attemptsIncomplete ? ' +' : ''}</td><td>${s.retryFailed}</td><td>${link(s.http, `${attrs} data-result="http"`)}</td><td>${link(s.stream, `${attrs} data-result="stream"`)}</td><td>${link(s.recovered, `${attrs} data-result="recovered"`)}</td><td>${s.disconnected} / ${s.unknown}</td><td>${link(s.unlinked, `${attrs} data-result="unlinked"`)}</td><td>${s.affectedUsers}</td>`;
    }
    function groupsTable(groups) {
      if (!groups.length) return empty('当前筛选下没有记录');
      return table(['分组 / 供应商 Key', '下游失败', '失败尝试', '重试后仍失败', 'HTTP 错误', '流错误 / 中断', '重试恢复', '断开 / 待判定', '待关联记录', '影响用户'], groups.map(g => {
        const attrs = `data-group="${esc(g.id)}"`;
        return `<tr class="ra-group"><td>${link(g.name, `data-expand="${esc(g.id)}" aria-expanded="${state.expanded.has(g.id)}"`)}<small>${esc(mix(g.types))}</small></td>${counts(g.summary, attrs)}</tr>` + (state.expanded.has(g.id) ? g.keys.map(k => `<tr><td class="ra-key">${link(k.providerName + ' / ' + k.name, `${attrs} data-key="${esc(k.id)}" data-result="${esc(local.elements.outcome.value)}"`)}<small>${k.accountIds?.length ? '主站账号 #' + esc(k.accountIds.join(' / #')) : esc(k.providerName)} · ${k.verified ? '历史映射 · 当前别名' : 'Key 未验证'}</small><small>${esc(mix(k.types))}</small></td>${counts(k.summary, `${attrs} data-key="${esc(k.id)}"`)}</tr>`).join('') : '');
      }).join(''));
    }
    function usersTable(users) {
      if (!users.length) return empty('当前筛选下没有用户');
      return table(['用户', '下游失败', '主要失败类型', '重试后仍失败', 'HTTP 错误', '流错误 / 中断', '恢复', '待关联记录'], users.map(u => `<tr><td>${link(u.name, `data-user="${esc(u.id)}"`)}<small>#${esc(u.id)}</small></td><td>${u.summary.failed}</td><td>${esc(mix(u.types))}</td><td>${u.summary.retryFailed}</td><td>${u.summary.http}</td><td>${u.summary.stream}</td><td>${u.summary.recovered}</td><td>${u.summary.unlinked}</td></tr>`).join(''));
    }
    function requestsTable(rows) {
      if (!rows.length) return empty('当前筛选下没有记录');
      return table(['时间 / 请求', '用户 / 分组', '最终失败类型', '下游实际结果', '重试 / 输出', ''], rows.map(r => `<tr><td>${link(time(r.at), `data-request="${esc(r.id)}"`)}<small>${esc(r.requestId || r.id)}</small></td><td>${esc(r.userName)}<small>${esc(r.groupName)}</small></td><td>${esc(options.failureTypes[r.failureType] || options.causes[r.cause])}<small>${esc(r.errorCode || '')}</small></td><td>${badge(r)}<small>${esc(response(r))}</small></td><td>${esc(retries[r.retryState])}<small>${esc(outputs[r.outputState])}</small></td><td><button type="button" class="icon-button" data-request="${esc(r.id)}" aria-label="查看请求详情" title="查看请求详情">${icon('arrow-up-right')}</button></td></tr>`).join(''));
    }
    function render() {
      const r = report, q = r.query, s = r.summary;
      fill(outer.elements.groupId, r.options.groups, '全部分组', q.groupId);
      fill(outer.elements.providerId, r.options.providers, '全部供应商', q.providerId);
      $('ra-notices').innerHTML = r.warnings.map(text => `<div class="alert warning">${esc(text)}</div>`).join('');
      $('ra-metrics').innerHTML = [
        ['已确认下游最终失败', s.failed, `HTTP ${s.http} · 流错误 / 中断 ${s.stream} · ${s.affectedUsers} 位已知用户${s.unknownUsers ? ' · ' + s.unknownUsers + ' 个失败请求未记录用户' : ''}`, true],
        ['重试恢复 · 下游未报错', s.recovered, '已确认完整响应与正常结束'],
        ['已关联异常请求', s.total, `${s.sourceRows} 条错误日志 · ${s.failedAttempts}${s.attemptsIncomplete ? '+' : ''} 次已知失败尝试`],
        ['其他 / 待判定', s.disconnected + s.unknown, `客户端断开 ${s.disconnected} · 待判定 ${s.unknown} · 待关联记录 ${s.unlinked}`]
      ].map(([label, value, caption, red]) => `<div class="ra-metric${red ? ' ra-danger' : ''}"><span>${esc(label)}</span><strong>${number(value)}</strong><small>${esc(caption)}</small></div>`).join('');
      if (s.unlinked) $('ra-notices').insertAdjacentHTML('beforeend', `<button type="button" class="button" data-unlinked>查看 ${number(s.unlinked)} 条待关联错误记录</button>`);
      $('ra-days').innerHTML = table(['日期', '已关联请求', '最终失败', 'HTTP', '流错误 / 中断', '重试恢复', '断开', '待判定', '待关联记录', '影响用户'], r.days.map(d => `<tr><td>${link(d.date, `data-day="${d.date}" aria-pressed="${d.date === state.day}"`)}</td><td>${d.total}</td><td>${d.failed}</td><td>${d.http}</td><td>${d.stream}</td><td>${d.recovered}</td><td>${d.disconnected}</td><td>${d.unknown}</td><td>${d.unlinked}</td><td>${d.affectedUsers}</td></tr>`).join(''));
      $('ra-day').innerHTML = r.days.map(d => `<option value="${d.date}">${d.date}${d.date === options.today ? ' · 今日' : ''}</option>`).join(''); $('ra-day').value = state.day;
      $('ra-title').textContent = `${state.day} · 下游结果分析`;
      const day = r.days.find(d => d.date === state.day);
      $('ra-day-meta').textContent = `已关联 ${day.total} 个异常请求 · 最终失败 ${day.failed} · ${day.affectedUsers} 位受影响用户 · 待关联 ${day.unlinked} 条`;
      $('ra-views').querySelectorAll('[data-view]').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.view === state.view)); b.tabIndex = b.dataset.view === state.view ? 0 : -1; });
      $('ra-panel').setAttribute('aria-labelledby', `ra-tab-${state.view}`);
      const scope = [selectedUser ? '用户 ' + selectedUser : '', q.scopeGroupId ? '分组 #' + q.scopeGroupId : '', q.keyId || '', q.failureType !== 'all' ? options.failureTypes[q.failureType] : ''].filter(Boolean);
      $('ra-scope').hidden = !scope.length;
      $('ra-scope').innerHTML = scope.map(esc).join(' · ') + `<button class="icon-button" type="button" data-clear-scope aria-label="取消下钻">${icon('x')}</button>`;
      $('ra-selected').textContent = `当前匹配：下游失败 ${r.selected.failed} · HTTP ${r.selected.http} / 流式 ${r.selected.stream} · 重试后仍失败 ${r.selected.retryFailed} · 受影响 ${r.selected.affectedUsers} 位用户 · 待关联 ${r.selected.unlinked} 条`;
      $('ra-panel').innerHTML = state.view === 'types' ? typesTable(r.failureTypes) : state.view === 'groups' ? groupsTable(r.groups) : state.view === 'users' ? usersTable(r.items) : requestsTable(r.items);
      const p = r.pagination;
      $('ra-pagination').innerHTML = `共 ${number(p.total)} ${state.view === 'requests' ? '条记录' : state.view === 'users' ? '位用户' : state.view === 'groups' ? '个分组' : '类失败'}` + (['requests', 'users'].includes(state.view) ? `<span>第 ${p.page} 页</span><button class="icon-button" type="button" data-page="-1" ${p.page === 1 ? 'disabled' : ''} aria-label="上一页">${icon('chevron-left')}</button><button class="icon-button" type="button" data-page="1" ${p.hasNext ? '' : 'disabled'} aria-label="下一页">${icon('chevron-right')}</button>` : '');
      $('ra-note').textContent = state.view === 'types' ? '每个最终失败只归一类；占比以同日同范围的全部确认失败为分母。各类型人数独立去重，不可直接相加。' : state.view === 'groups' ? '跨 Key 请求可能多行出现，分组总计独立去重。失败尝试的 + 表示仍有未覆盖的尝试，不能当作精确总次数。' : '待关联错误记录不计入去重请求与最终失败合计；相同客户端 ID 不能合并原请求。';
      $('ra-matrix').innerHTML = table(['主要错误来源', '已关联请求', '重试恢复', 'HTTP 失败', '流式失败', '断开', '待判定', '待关联记录'], r.matrix.map(c => `<tr><td>${esc(c.label)}</td><td>${c.total}</td>${['recovered', 'http', 'stream', 'disconnected', 'unknown', 'unlinked'].map(result => `<td>${link(c[result], `data-cause="${esc(c.cause)}" data-result="${result}"`)}</td>`).join('')}</tr>`).join(''));
      $('ra-presets').querySelectorAll('[data-preset]').forEach(b => {
        const starts = { today: options.today, yesterday: addDays(options.today, -1), week: addDays(options.today, -6) };
        b.setAttribute('aria-pressed', String(outer.elements.start.value === starts[b.dataset.preset] && outer.elements.end.value === (b.dataset.preset === 'yesterday' ? starts.yesterday : options.today)));
      }); refreshIcons();
    }
    function addDays(value, days) { const d = new Date(value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
    async function detail(id) {
      const current = ++detailSeq; detailController?.abort(); detailController = new AbortController();
      const q = { start: report.query.range.start, end: report.query.range.end };
      const value = await api(`/api/request-errors/requests/${encodeURIComponent(id)}?${new URLSearchParams(q)}`, { signal: detailController.signal });
      if (!isActive() || detailSeq !== current) return;
      const r = value.request, type = options.failureTypes[r.failureType];
      $('ra-dialog-title').textContent = '请求详情';
      $('ra-dialog-body').innerHTML = `<div class="ra-verdict">${badge(r)}<h3>${esc(type || (!r.linked ? '待关联错误记录' : options.outcomes[r.outcome]))}</h3><p>${esc(r.reason)}</p></div><dl class="ra-facts">${[
        ['主站请求 ID', r.requestId || '缺失'], ['客户端请求 ID', r.clientId || '未记录'], ['用户', `${r.userName} #${r.userId || '未知'}`], ['用户 Key ID', r.userKeyId || '未知'], ['请求分组', r.groupName], ['请求模型 / 上游模型', `${r.model} / ${r.upstreamModel || '未记录'}`],
        ['实际下游响应', response(r)], ['语义错误状态', r.semanticStatus || '未记录'], ['记录的错误代码', r.errorCode || '未记录'], ['输出情况', outputs[r.outputState]], ['重试结果', retries[r.retryState]], ['归日依据', r.dayBasis === 'request_start' ? '主站接收时间' : '最早错误时间 · 回退'],
        ['正常结束 / 完整响应', `${r.terminal ?? '未知'} / ${r.complete ?? '未知'}`], ['来源日志', r.sourceRows ? `${r.sourceRows} 条 · #${r.sourceIds.join(' / #')}` : '无错误表记录 · 来自下游终止采集'], ['判定来源', finalEvidence(r)],
        ['尝试覆盖', r.attemptsComplete ? '尝试链完整' : '尝试记录可能不完整'], ['身份关联', r.linked ? r.evidence.root.includes('+ api_key_id') ? '主站 ID、用户与用户 Key 一致' : '主站 ID 与用户一致；采集未记录用户 Key' : '缺少可信主站请求关联'], ['客户端断开', r.clientDisconnected === true ? '已记录断开' : r.clientDisconnected === false ? '未记录断开' : '未知']
      ].map(([label, content]) => `<div><dt>${esc(label)}</dt><dd>${esc(content)}</dd></div>`).join('')}</dl><h3>完整上游尝试链</h3><ol class="ra-chain">${r.attempts.map((a, i) => `<li><strong>尝试 ${i + 1} · ${esc(a.id || '尝试 ID 未记录')}</strong><p>${esc(a.accountId ? '主站账号 #' + a.accountId : '账号未记录')} · ${esc(a.status ? '上游 HTTP ' + a.status : '状态未记录')} · ${a.failed ? '失败' : a.ended ? '已结束' : '结束未确认'}</p></li>`).join('') || '<li>上游尝试未记录</li>'}<li><strong>最终下游结果</strong><p>${esc(response(r))} · ${esc(r.reason)}</p></li></ol><h3>供应商 Key 归属</h3><p>${r.keys.map(k => esc(k.providerName + ' / ' + k.name + (k.accountId ? ' · 主站账号 #' + k.accountId : ''))).join('<br>')}</p>`;
      if (!$('ra-dialog').open) $('ra-dialog').showModal(); refreshIcons();
    }
    outer.addEventListener('submit', e => { e.preventDefault(); state.day = outer.elements.end.value; clearLocal(); run(() => load()); });
    local.addEventListener('submit', e => { e.preventDefault(); state.page = 1; run(() => load()); });
    local.addEventListener('change', e => {
      if (e.target.name === 'failureType' && e.target.value !== 'all') local.elements.outcome.value = 'failed';
      if (e.target.name === 'outcome' && ['all', 'recovered', 'disconnected', 'unknown', 'unlinked'].includes(e.target.value)) {
        local.elements.failureType.value = 'all'; if (state.view === 'types') state.view = 'requests';
      }
      state.page = 1; run(() => load());
    });
    $('ra-day').addEventListener('change', e => { state.day = e.target.value; clearLocal(); run(() => load()); });
    $('ra-views').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...$('ra-views').querySelectorAll('[data-view]')], index = tabs.indexOf(e.target);
      if (index < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
    $('ra-clear').addEventListener('click', () => { clearLocal(); run(() => load()); });
    $('ra-close').addEventListener('click', () => $('ra-dialog').close());
    $('ra-dialog').addEventListener('close', () => { ++detailSeq; detailController?.abort(); });
    $('view-errors').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.request) { run(() => detail(b.dataset.request)); return; }
      if (b.dataset.expand) { state.expanded.has(b.dataset.expand) ? state.expanded.delete(b.dataset.expand) : state.expanded.add(b.dataset.expand); $('ra-panel').innerHTML = groupsTable(report.groups); refreshIcons(); return; }
      if (b.dataset.preset && options) {
        outer.elements.end.value = b.dataset.preset === 'yesterday' ? addDays(options.today, -1) : options.today;
        outer.elements.start.value = b.dataset.preset === 'week' ? addDays(options.today, -6) : outer.elements.end.value;
        state.day = outer.elements.end.value; clearLocal();
      } else if (b.dataset.view) {
        state.view = b.dataset.view; if (state.view === 'types' && !['failed', 'http', 'stream'].includes(local.elements.outcome.value)) local.elements.outcome.value = 'failed';
      } else if (b.dataset.type) {
        local.elements.failureType.value = b.dataset.type; local.elements.outcome.value = 'failed'; state.view = b.dataset.targetView;
      } else if (b.dataset.group) {
        state.scopeGroupId = b.dataset.group; state.keyId = b.dataset.key || ''; local.elements.outcome.value = b.dataset.result; state.view = 'requests';
        if (!['failed', 'http', 'stream'].includes(b.dataset.result)) local.elements.failureType.value = 'all';
      } else if (b.dataset.user) {
        state.userId = b.dataset.user; selectedUser = b.textContent; state.view = ['failed', 'http', 'stream'].includes(local.elements.outcome.value) ? 'types' : 'requests';
      } else if (b.dataset.day) { state.day = b.dataset.day; clearLocal();
      } else if (b.hasAttribute('data-clear-scope')) { clearLocal();
      } else if (b.hasAttribute('data-unlinked')) { clearLocal(); local.elements.outcome.value = 'unlinked'; state.view = 'requests';
      } else if (b.dataset.cause) {
        local.elements.cause.value = b.dataset.cause; local.elements.failureType.value = 'all'; local.elements.outcome.value = b.dataset.result; state.view = 'requests';
      } else if (b.dataset.page) { state.page += Number(b.dataset.page); run(() => load()); return;
      } else return;
      state.page = 1; run(() => load());
    });
    function leave() { ++seq; ++detailSeq; controller?.abort(); detailController?.abort(); clearTimeout(timer); if ($('ra-dialog').open) $('ra-dialog').close(); }
    function reset() { leave(); options = null; report = null; selectedUser = null; state = { view: 'types', day: '', scopeGroupId: '', keyId: '', userId: '', page: 1, expanded: new Set() }; local.reset(); outer.reset(); $('ra-data').hidden = true; $('ra-dialog-body').innerHTML = ''; $('ra-notices').innerHTML = ''; }
    return { load, leave, reset };
  }
  root.RequestErrorsUi = { create };
})(window);
