(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => `<i data-lucide="${name}"></i>`;
  const labels = { passed: '通过 / 正常', failed: '未通过 / 疑似降智', error: '检测异常', unknown: '无法判定', running: '检测中', queued: '排队中' };
  const names = { candy: '糖果检测', pelican: '鹈鹕检测', testllm: 'TestLLM 推理检测' };
  const levels = { excellent: '极高智商', high: '高智商', normal: '智商一般', timeout: '思考超时', failed: '检测失败' };
  const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无记录';
  const seconds = value => typeof value === 'number' ? `${value.toFixed(1)} 秒` : '未取得';
  const percent = value => typeof value === 'number' ? `${value.toFixed(1)}%` : '未取得';
  const badge = run => `<span class="p-pill ${esc(run?.conclusion || 'unknown')}">${esc(run ? labels[run.conclusion] || run.conclusion : '等待首次检测')}</span>`;
  const special = run => run?.think ? `${run.think.has_thinking ? '有思考' : '无思考'} · ${run.think.has_signature ? '有签名' : '无签名'}` : '思考 / 签名未取得';
  const cache = run => run?.cache?.supported && run.cache.total > 0 && run.cache.hit_rate <= 100 ? percent(run.cache.hit_rate) : run?.cache && !run.cache.supported ? '未支持' : '未取得';
  const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
  let historyDialog;
  let dialogState;
  let detailRequest = 0;
  let historyRequest = 0;
  const canDelete = run => !['queued', 'running'].includes(run.status);

  function ancestors() {
    const candidates = [];
    try { candidates.push(...Array.from(location.ancestorOrigins || [])); } catch {}
    if (!candidates.length && document.referrer) candidates.push(document.referrer);
    const origins = [];
    for (const value of candidates) {
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin && !origins.includes(url.origin)) origins.push(url.origin);
        if (origins.length === 4) break;
      } catch {}
    }
    return JSON.stringify(origins);
  }
  function ensureDialog() {
    if (historyDialog) return;
    historyDialog = document.createElement('dialog');
    historyDialog.className = 'p-history';
    historyDialog.setAttribute('aria-labelledby', 'p-history-title');
    historyDialog.innerHTML = `<header class="p-history-head"><div><h2 id="p-history-title"></h2><p id="p-history-meta"></p></div><div class="p-row"><button type="button" class="icon-button" data-history-refresh title="刷新历史" aria-label="刷新历史">${icon('refresh-cw')}</button><button type="button" class="icon-button" data-history-close title="关闭" aria-label="关闭">${icon('x')}</button></div></header><div class="p-history-tools" hidden><label><input type="checkbox" data-history-select-all><span data-history-select-label>全选已加载</span></label><span class="p-muted" data-history-selection>已选 0 / 100 条</span><div class="p-history-delete-actions"><button type="button" class="button danger" data-history-delete disabled>${icon('trash-2')}删除所选</button><button type="button" class="button danger" data-history-clear>${icon('trash-2')}一键清空</button></div></div><p class="p-history-feedback" role="status" aria-live="polite" hidden></p><div class="p-history-body"><nav class="p-history-list" aria-label="检测记录"></nav><div class="p-history-detail" aria-live="polite"></div></div>`;
    document.body.append(historyDialog);
    const detail = historyDialog.querySelector('.p-history-detail');
    detail.tabIndex = 0; detail.setAttribute('aria-label', '检测结果详情');
    historyDialog.querySelector('[data-history-close]').onclick = () => historyDialog.close();
    historyDialog.querySelector('[data-history-refresh]').onclick = () => loadHistory();
    historyDialog.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button?.disabled) return;
      if (button?.dataset.runId) selectRun(Number(button.dataset.runId));
      if (button?.hasAttribute('data-history-more')) loadHistory(true);
      if (button?.hasAttribute('data-history-delete')) deleteResults(false);
      if (button?.hasAttribute('data-history-clear')) deleteResults(true);
      if (event.target === historyDialog) { const box = historyDialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) historyDialog.close(); }
    });
    historyDialog.addEventListener('change', event => {
      const current = dialogState;
      if (!current?.admin || current.loading || current.deleting) return;
      if (event.target.hasAttribute('data-history-select-all')) {
        current.checked = new Set(event.target.checked ? current.runs.filter(canDelete).slice(0, 100).map(run => run.id) : []);
      } else if (event.target.hasAttribute('data-history-select')) {
        const id = Number(event.target.dataset.historySelect);
        if (!current.runs.some(run => run.id === id && canDelete(run))) return;
        if (event.target.checked && !current.checked.has(id) && current.checked.size >= 100) {
          event.target.checked = false; historyFeedback('每次最多勾选 100 条记录。', true); return;
        }
        if (event.target.checked) current.checked.add(id); else current.checked.delete(id);
      } else return;
      updateHistoryActions();
    });
    historyDialog.addEventListener('close', () => { historyRequest++; detailRequest++; dialogState = null; historyDialog.querySelector('.p-history-detail').replaceChildren(); });
  }
  async function openHistory(api, group, channel, options = {}) {
    ensureDialog();
    historyRequest++; detailRequest++;
    dialogState = { api, group, channel, admin: options.admin === true, window: options.window || '', runs: [], cursor: null, selected: options.runId || null,
      loading: false, deleting: false, checked: new Set(), total: 0, archived: 0,
      confirmDeletion: options.confirmDeletion, onDeleted: options.onDeleted, onError: options.onError };
    historyDialog.querySelector('.p-history-list').replaceChildren();
    historyDialog.querySelector('.p-history-tools').hidden = !dialogState.admin;
    historyFeedback(''); updateHistoryActions();
    historyDialog.querySelector('h2').textContent = `${group.name} · ${names[channel]}`;
    historyDialog.querySelector('#p-history-meta').textContent = `${options.window === '24h' ? '最近 24 小时' : '检测历史'} · Asia/Shanghai`;
    historyDialog.querySelector('.p-history-list').textContent = '正在读取记录';
    historyDialog.querySelector('.p-history-detail').textContent = '';
    if (!historyDialog.open) historyDialog.showModal();
    icons();
    await loadHistory();
  }
  async function loadHistory(more = false) {
    const current = dialogState;
    if (!current || current.loading) return;
    current.loading = true;
    updateHistoryActions();
    const requestId = ++historyRequest;
    const query = new URLSearchParams();
    if (more && current.cursor) query.set('before', current.cursor);
    if (current.window) query.set('window', current.window);
    try {
      const path = `${current.admin ? '/api/admin' : '/api'}/provider/groups/${encodeURIComponent(current.group.id)}/${current.channel}/runs?${query}`;
      const data = await current.api(path);
      if (requestId !== historyRequest || current !== dialogState) return;
      current.runs = more ? [...current.runs, ...data.runs] : data.runs;
      current.cursor = data.next_cursor;
      current.total = data.total; current.archived = data.archived;
      const eligible = new Set(current.runs.filter(canDelete).map(run => run.id));
      current.checked = new Set([...current.checked].filter(id => eligible.has(id)));
      historyDialog.querySelector('#p-history-meta').textContent = `${current.window === '24h' ? '最近 24 小时' : '检测历史'} · 现存 ${data.total} 条 · 已归档 ${data.archived} 条 · Asia/Shanghai`;
      if (!current.runs.some(run => run.id === current.selected)) current.selected = current.runs[0]?.id || null;
      renderHistory();
      if (current.selected) await selectRun(current.selected);
      else historyDialog.querySelector('.p-history-detail').textContent = current.window ? '最近 24 小时没有检测记录' : '尚无检测记录';
    } catch (error) {
      if (current === dialogState && requestId === historyRequest) historyDialog.querySelector('.p-history-detail').textContent = error.message;
    } finally { current.loading = false; if (current === dialogState) updateHistoryActions(); }
  }
  function renderHistory() {
    const current = dialogState;
    historyDialog.querySelector('.p-history-list').innerHTML = current.runs.map(run => {
      const button = `<button type="button" data-run-id="${run.id}" aria-pressed="${current.selected === run.id}" ${current.deleting ? 'disabled' : ''}>${badge(run)}<small>${stamp(run.created_at)}</small><small>${esc(run.model)}</small></button>`;
      return current.admin ? `<div class="p-history-entry"><label class="p-history-select"><input type="checkbox" data-history-select="${run.id}" aria-label="选择记录 ${run.id}" ${current.checked.has(run.id) ? 'checked' : ''} ${!canDelete(run) || current.deleting || current.loading ? 'disabled' : ''}></label>${button}</div>` : button;
    }).join('') + (current.cursor ? `<button type="button" data-history-more ${current.loading || current.deleting ? 'disabled' : ''}>加载更多</button>` : '');
    updateHistoryActions();
  }
  function updateHistoryActions() {
    const current = dialogState; if (!current) return;
    const busy = current.loading || current.deleting;
    historyDialog.querySelector('[data-history-refresh]').disabled = busy;
    const more = historyDialog.querySelector('[data-history-more]'); if (more) more.disabled = busy;
    if (!current.admin) return;
    const completed = current.runs.filter(canDelete), eligible = completed.slice(0, 100);
    const all = historyDialog.querySelector('[data-history-select-all]');
    all.checked = eligible.length > 0 && eligible.every(run => current.checked.has(run.id));
    all.indeterminate = !all.checked && current.checked.size > 0;
    all.disabled = busy || !eligible.length;
    historyDialog.querySelector('[data-history-select-label]').textContent = completed.length > 100 ? '全选前 100 条' : '全选已加载';
    historyDialog.querySelector('[data-history-selection]').textContent = `已选 ${current.checked.size} / 100 条`;
    historyDialog.querySelector('[data-history-delete]').disabled = busy || !current.checked.size;
    historyDialog.querySelector('[data-history-clear]').disabled = busy || !(current.total > current.runs.filter(run => !canDelete(run)).length || current.archived);
    const runs = new Map(current.runs.map(run => [run.id, run]));
    for (const control of historyDialog.querySelectorAll('[data-history-select]')) {
      const run = runs.get(Number(control.dataset.historySelect));
      if (!run) { control.disabled = true; continue; }
      control.checked = current.checked.has(run.id); control.disabled = busy || !canDelete(run);
    }
  }
  function historyFeedback(message, error = false) {
    const target = historyDialog.querySelector('.p-history-feedback');
    target.textContent = message; target.hidden = !message; target.classList.toggle('p-history-error', error);
  }
  async function deleteResults(all) {
    const current = dialogState;
    if (!current?.admin || current.loading || current.deleting || !all && !current.checked.size) return;
    const ids = [...current.checked];
    current.deleting = true; renderHistory(); historyFeedback('');
    try {
      const message = all ? `清空“${current.group.name}”的${names[current.channel]}全部已结束检测结果及累计记录？排队和检测中的任务将保留。`
        : `删除“${current.group.name}”的${names[current.channel]}已勾选的 ${ids.length} 条检测结果？`;
      const accepted = current.confirmDeletion ? await current.confirmDeletion(message, all ? '确认清空' : '确认删除') : confirm(message);
      if (!accepted || current !== dialogState) return;
      detailRequest++;
      historyFeedback(all ? '正在清空检测结果...' : '正在删除所选结果...');
      const result = await current.api(`/api/admin/provider/groups/${encodeURIComponent(current.group.id)}/${current.channel}/runs`, {
        method: 'DELETE', body: all ? { all: true } : { ids }, mutation: true
      });
      if (current !== dialogState) return;
      current.checked.clear();
      await loadHistory();
      if (current !== dialogState) return;
      historyFeedback(all ? '已清空已结束检测结果及累计记录。' : `已删除 ${result.deleted} 条检测结果。`);
      await current.onDeleted?.(result);
    } catch (error) {
      if (current === dialogState) { historyFeedback(error.message, true); current.onError?.(error); }
      if (current === dialogState && current.selected) await selectRun(current.selected);
    } finally {
      current.deleting = false;
      if (current === dialogState) renderHistory();
    }
  }
  async function selectRun(id) {
    const current = dialogState;
    if (!current) return;
    current.selected = id;
    const requestId = ++detailRequest;
    renderHistory();
    const target = historyDialog.querySelector('.p-history-detail');
    target.classList.remove('p-history-detail--artwork');
    target.scrollTop = 0;
    target.textContent = '正在读取本次结果';
    try {
      const run = await current.api(`${current.admin ? '/api/admin' : '/api'}/provider-results/${id}`, { headers: { 'x-preview-ancestors': ancestors() } });
      if (current !== dialogState || requestId !== detailRequest) return;
      const response = run.response;
      const settings = run.settings;
      const iq = current.channel === 'testllm';
      const summary = iq ? levels[run.iq?.level] || '未取得结果' : labels[run.conclusion];
      target.innerHTML = `<div class="p-card-head"><h3>本次检测结果</h3>${badge(run)}</div><dl class="p-detail-metrics"><div><dt>${iq ? '推理等级' : '检测判定'}</dt><dd>${esc(summary)}</dd></div><div><dt>任务总耗时</dt><dd>${run.duration_ms == null ? '进行中' : seconds(run.duration_ms / 1000)}</dd></div><div><dt>${iq ? '测试缓存' : '输出 Token'}</dt><dd>${iq ? cache(run) : run.output_tokens ?? '未取得'}</dd></div></dl>${run.reason ? `<section><h3>判定说明</h3><p>${esc(run.reason)}</p></section>` : ''}${response?.assessment?.reason ? `<section><h3>第三方判定</h3><p>${esc(response.assessment.reason)}</p></section>` : ''}${iq ? `<section><h3>分项结果</h3><p>推理用时：${seconds(run.iq?.duration)}\nToken 缓存率：${cache(run)}\n请求数缓存率：${percent(run.cache?.request_hit_rate)}\n思考与签名：${special(run)}\n首字耗时：未取得</p>${Object.entries(run.errors || {}).map(([mode, message]) => `<p class="p-history-error">${esc(mode)}：${esc(message)}</p>`).join('')}</section>` : ''}${response?.candy?.answer != null ? `<section><h3>检测回答</h3><pre class="p-code">${esc(response.candy.answer)}</pre></section>` : ''}${run.preview_url ? '<section><h3>作品预览</h3><div id="p-artwork-target"></div></section>' : ''}<details><summary>本次检测参数</summary><pre class="p-code">${esc(JSON.stringify(settings, null, 2))}</pre></details><details><summary>检测提示词</summary><pre class="p-code">${esc(response?.prompt || '第三方未返回本次提示词')}</pre></details>${response?.result?.html ? `<details><summary>作品源码</summary><pre class="p-code">${esc(response.result.html)}</pre></details>` : ''}<details><summary>第三方结果</summary><pre class="p-code">${esc(response ? JSON.stringify(response, null, 2) : '详细响应已清理或尚未返回')}</pre></details><p class="p-muted">${stamp(run.created_at)} · ${esc(run.model)} · 执行时参数</p>`;
      if (run.method === 'local_html') {
        const method = document.createElement('p');
        method.className = 'p-muted'; method.textContent = '本地生成 · HTML 源码分类';
        target.querySelector('.p-card-head').after(method);
      }
      if (current.admin && run.diagnostic) {
        const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
        summary.textContent = '检测诊断'; code.className = 'p-code'; code.textContent = JSON.stringify(run.diagnostic, null, 2);
        details.append(summary, code); target.append(details);
      }
      if (run.preview_url) {
        const artwork = target.querySelector('#p-artwork-target').parentElement;
        artwork.classList.add('p-artwork-section');
        target.classList.add('p-history-detail--artwork');
        target.prepend(artwork);
        const frame = document.createElement('iframe');
        frame.className = 'p-artwork'; frame.title = '本次鹈鹕检测作品';
        const source = new URL(run.preview_url, location.href); source.searchParams.set('fit', '1');
        frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'; frame.setAttribute('scrolling', 'no'); frame.src = source.href;
        target.querySelector('#p-artwork-target').append(frame);
      }
      for (const code of target.querySelectorAll('.p-code')) code.tabIndex = 0;
      icons();
    } catch (error) { if (current === dialogState && requestId === detailRequest) target.textContent = error.message; }
  }
  function clearHistory() { if (historyDialog?.open) historyDialog.close(); }
  window.ProviderUI = { esc, icon, labels, names, stamp, seconds, percent, badge, levels, special, cache, openHistory, clearHistory, icons };

  if (!document.getElementById('provider-results')) return;
  const { api, mount, toast } = window.DetectorSession;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const platformNames = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', grok: 'Grok' };
  const state = { channel: params.get('provider') === 'testllm' ? 'testllm' : params.get('test') === 'pelican' ? 'pelican' : 'candy', data: null, query: '', platform: '', status: '', request: 0 };
  function controls() {
    const llm = state.channel === 'testllm';
    for (const button of document.querySelectorAll('[data-provider]')) { const active = button.dataset.provider === (llm ? 'testllm' : 'manxue'); button.setAttribute('aria-selected', active); button.tabIndex = active ? 0 : -1; }
    for (const button of document.querySelectorAll('[data-channel]')) { const active = button.dataset.channel === state.channel; button.setAttribute('aria-selected', active); button.tabIndex = active ? 0 : -1; }
    $('p-kinds').hidden = llm;
    $('p-results-panel').setAttribute('aria-labelledby', llm ? 'p-testllm-tab' : 'p-manxue-tab');
    if (llm) { $('p-category-panel').removeAttribute('role'); $('p-category-panel').removeAttribute('aria-labelledby'); }
    else { $('p-category-panel').setAttribute('role', 'tabpanel'); $('p-category-panel').setAttribute('aria-labelledby', `p-${state.channel}-tab`); }
    $('p-official').href = llm ? 'https://testllm.ai/model-iq-test' : 'https://manxue.ai/api';
    const url = new URL(location.href);
    url.searchParams.set('provider', llm ? 'testllm' : 'manxue');
    if (llm) url.searchParams.delete('test'); else url.searchParams.set('test', state.channel);
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
  async function refresh() {
    const request = ++state.request;
    const channel = state.channel;
    const data = await api(`/api/provider-results?channel=${channel}`);
    if (request !== state.request || channel !== state.channel) return;
    state.data = data;
    if (dialogState && !dialogState.admin && !data.groups.some(group => group.id === dialogState.group.id)) clearHistory();
    $('page-meta').textContent = `${data.demo ? '演示数据 · ' : ''}第三方检测 · ${stamp(data.server_time)} · Asia/Shanghai`;
    const options = [...new Set(data.groups.map(group => group.platform))];
    if (!options.includes(state.platform)) state.platform = '';
    const optionSignature = options.join(',');
    if ($('p-platform').dataset.options !== optionSignature) {
      $('p-platform').innerHTML = '<option value="">全部平台</option>' + options.map(platform => `<option value="${esc(platform)}">${esc(platformNames[platform] || platform)}</option>`).join('');
      $('p-platform').dataset.options = optionSignature;
    }
    $('p-platform').value = state.platform;
    controls(); render();
  }
  function card(group) {
    const latest = group.latest;
    const history = group.history.slice(0, 24);
    const valid = history.filter(run => ['passed', 'failed'].includes(run.conclusion));
    const passed = valid.filter(run => run.conclusion === 'passed').length;
    const bars = [...Array(Math.max(0, 24 - history.length)).fill(null), ...history.slice().reverse()];
    return `<article class="p-card"><div class="p-card-head"><h3>${esc(group.name)}</h3>${badge(latest)}</div><p class="p-card-model">${esc(latest?.model || group.model)}</p><dl class="p-card-metrics"><div><dt>分组倍率</dt><dd>${group.rate_multiplier == null ? '未取得' : `× ${esc(group.rate_multiplier)}`}</dd></div><div><dt>最近 5h 缓存率</dt><dd>${typeof group.cache_stats?.rate === 'number' ? percent(group.cache_stats.rate * 100) : '未取得'}</dd></div></dl><div class="p-card-assessment"><span class="p-muted">${state.channel === 'candy' ? '最近糖果检测' : '最近鹈鹕判定'}</span><strong class="${latest?.conclusion === 'passed' ? 'p-green' : latest?.conclusion === 'failed' ? 'p-red' : 'p-amber'}">${esc(latest ? labels[latest.conclusion] : '等待检测')}</strong></div><div class="p-bars" role="group" aria-label="最近 24 次检测">${bars.map(run => `<button type="button" class="p-bar ${run?.conclusion || ''}" ${run ? `data-group="${esc(group.id)}" data-run="${run.id}" title="${stamp(run.created_at)} · ${esc(labels[run.conclusion])}" aria-label="${stamp(run.created_at)} · ${esc(labels[run.conclusion])}"` : 'disabled aria-label="无记录"'}></button>`).join('')}</div><div class="p-chart-caption"><span>最近 24 次检测</span><span>最新</span></div><div class="p-card-foot"><span>近 ${history.length} 次通过率<strong>${valid.length ? percent(passed / valid.length * 100) : '—'}</strong> (${passed}/${valid.length})</span><button type="button" class="button" data-group="${esc(group.id)}">${icon('eye')}查看结果</button></div></article>`;
  }
  function table(groups) {
    return `<div class="p-table-scroll" tabindex="0" aria-label="${esc(groups[0].platform_label)} 检测列表"><table class="p-table"><thead><tr><th scope="col">分组 / 检测模型</th><th scope="col">推理评估</th><th scope="col">测试缓存</th><th scope="col">耗时 / 思考签名</th><th scope="col">最新状态</th><th scope="col">检测记录</th></tr></thead><tbody>${groups.map(group => { const run = group.latest; return `<tr><td><strong>${esc(group.name)}</strong><small>${esc(run?.model || group.model)} · × ${esc(group.rate_multiplier ?? '—')}</small></td><td><strong class="${run?.conclusion === 'passed' ? 'p-green' : 'p-amber'}">${levels[run?.iq?.level] || '未取得结果'}</strong><small>${stamp(run?.created_at)}</small></td><td><strong>${cache(run)}</strong><small>Token 缓存率 · 请求 ${percent(run?.cache?.request_hit_rate)}</small></td><td><strong>${seconds(run?.iq?.duration)}</strong><small>${special(run)}</small></td><td>${badge(run)}<small>${run?.errors && Object.keys(run.errors).length ? '部分检测异常' : stamp(run?.finished_at)}</small></td><td><button type="button" class="button" data-group="${esc(group.id)}">24小时检测记录</button></td></tr>`; }).join('')}</tbody></table></div>`;
  }
  function render() {
    if (!state.data) return;
    const all = state.data.groups;
    const groups = all.filter(group => `${group.name} ${group.latest?.model || group.model}`.toLowerCase().includes(state.query) && (!state.platform || group.platform === state.platform) && (!state.status || group.latest?.conclusion === state.status));
    const plans = [...new Map(groups.map(group => { const plan = group.schedule || state.data.schedule; return [JSON.stringify(plan), plan]; })).values()];
    const schedule = plans[0] || state.data.schedule;
    $('p-plan').textContent = plans.length > 1 ? '按平台 / 分组计划执行'
      : schedule.enabled ? schedule.mode === 'daily' ? `每日 ${schedule.times.join(' / ')} · ${state.data.timezone}` : `每 ${schedule.interval_minutes} 分钟执行` : '自动计划未启用';
    const stats = [['可见分组', all.length], ['通过 / 正常', all.filter(group => group.latest?.conclusion === 'passed').length], ['未通过 / 疑似降智', all.filter(group => group.latest?.conclusion === 'failed').length], ['异常 / 待检测', all.filter(group => !group.latest || !['passed', 'failed'].includes(group.latest.conclusion)).length]];
    $('p-stats').innerHTML = stats.map(([label, value]) => `<div class="p-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
    $('p-count').textContent = `${groups.length} 个分组`;
    $('p-results-content').innerHTML = !groups.length ? `<div class="p-empty">${all.length ? '没有符合筛选条件的分组' : '暂无已启用且有权访问的检测分组'}</div>`
      : window.ModelResultRenderer.platformSections(groups.map(group => ({ ...group, platform_label: platformNames[group.platform] || group.platform })), card,
        members => state.channel === 'testllm' ? table(members) : `<div class="p-cards">${members.map(card).join('')}</div>`);
    icons();
  }
  document.querySelector('#provider-results').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.provider || button.dataset.channel) {
      state.channel = button.dataset.channel || (button.dataset.provider === 'testllm' ? 'testllm' : 'candy');
      state.request++; state.data = null; clearHistory(); controls();
      $('p-results-content').textContent = '正在读取检测结果';
      refresh().catch(error => { $('p-results-content').textContent = error.message; toast(error.message, 'error'); });
    } else if (button.dataset.group) {
      const group = state.data?.groups.find(group => group.id === button.dataset.group);
      if (group) openHistory(api, group, state.channel, { runId: Number(button.dataset.run) || null, window: state.channel === 'testllm' ? '24h' : '' });
    }
  });
  document.addEventListener('keydown', event => {
    if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].focus(); tabs[next].click();
  });
  $('p-search').addEventListener('input', event => { state.query = event.target.value.toLowerCase(); render(); });
  $('p-platform').addEventListener('change', event => { state.platform = event.target.value; render(); });
  $('p-status').addEventListener('change', event => { state.status = event.target.value; render(); });
  controls();
  mount(refresh, () => { state.request++; state.data = null; clearHistory(); $('p-results-content').replaceChildren(); });
})();
