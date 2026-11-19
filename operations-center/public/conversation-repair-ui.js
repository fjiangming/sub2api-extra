(function (root) {
  'use strict';
  function create({api,escapeHtml:esc,icon,refreshIcons,isActive}) {
    let host = null, state = null, policyVersion = 0, busy = false, timer = null, controller = null, epoch = 0, errorText = '';
    const num = value => new Intl.NumberFormat('zh-CN').format(value || 0);
    const names = {pending:'等待后台检查',running:'后台检查中',done:'检查完成',cancelled:'已停止',paused:'保存策略已变化，检查已暂停'};
    const errors = {POLICY_CHANGED:'核对当前策略后可重新启动',ALGORITHM_CHANGED:'脱敏算法已更新，请重新启动',REPAIR_TIMEOUT:'单条处理超时，原文保留，将有限重试',REPAIR_WORKER_UNAVAILABLE:'后台进程暂不可用，将自动续办',REPAIR_STORAGE_UNAVAILABLE:'存储暂不可用，将稍后重试'};
    function render() {
      if (!host || !isActive()) return;
      const job = state?.job, running = ['pending','running'].includes(job?.status);
      host.innerHTML = `<div class="cl-section-heading"><h2>历史兼容检查</h2><span>当前规则 · 策略 v${policyVersion}</span></div><div class="cl-cleanup-actions"><button class="button secondary" type="button" data-repair-start ${busy || running || state?.activeScope || !state ? 'disabled' : ''}>${icon('scan-line')}后台检查并重新处理</button>${running ? `<button class="button secondary" type="button" data-repair-stop ${busy ? 'disabled' : ''}>${icon('square')}停止检查</button>` : ''}</div><p class="cl-muted" role="status">${job ? `${esc(names[job.status] || job.status)} · 已扫描 ${num(job.scanned)} · 已检查 ${num(job.analyzed)} · 重处理成功 ${num(job.repaired)} · 检查范围警告 ${num(job.warnings)} · 资源暂缓 ${num(job.deferred)} · 仍有异常 ${num(job.errors)} · 跳过 ${num(job.skipped)}` : state ? '尚未启动历史检查' : '正在读取历史检查状态'}${state?.activeScope === 'redaction' ? ' · 历史重新脱敏正在进行' : ''}${job?.error_code || state?.lastError ? '<br>' + esc(errors[job?.error_code || state.lastError] || '历史检查暂不可用') : ''}</p>${errorText ? `<p class="cl-notice amber">${esc(errorText)}</p>` : ''}<p class="cl-muted">仅处理启动前的历史，跳过排除用户、名单外模型与过期记录；策略变化会暂停。原始采集标记保留，已缺失的字节无法补回。资源暂缓项可稍后重新检查；仅有脱敏副本时，完成证据单独注明来源。</p>`;
      refreshIcons();
    }
    async function refresh() {
      if (!isActive()) return;
      const current = epoch; controller?.abort(); clearTimeout(timer); controller = new AbortController();
      const value = await api('/api/conversation-logs/history-repair',{signal:controller.signal});
      if (current !== epoch || !isActive()) return;
      state = value; errorText = ''; render();
      if (state.activeScope) timer = setTimeout(() => refresh().catch(showError),2000);
    }
    function showError(error) { if (error.name !== 'AbortError' && isActive() && host) { errorText = error.message; render(); } }
    async function command(stop) {
      if (busy || !state) return;
      const current = epoch, id = state.job?.id; busy = true; errorText = ''; render();
      try {
        await api('/api/conversation-logs/history-repair' + (stop ? '/' + id + '/cancel' : ''),{method:'POST',body:JSON.stringify(stop ? {} : {policy_version:policyVersion})});
        if (current === epoch && isActive()) await refresh();
      } catch (error) { if (current === epoch) showError(error); }
      finally { if (current === epoch) { busy = false; render(); } }
    }
    async function load(element, version) {
      host = element; policyVersion = version; render();
      host.onclick = event => {
        if (event.target.closest('[data-repair-start]:not(:disabled)')) command(false);
        if (event.target.closest('[data-repair-stop]:not(:disabled)')) command(true);
      };
      await refresh();
    }
    function leave() { ++epoch; clearTimeout(timer); controller?.abort(); host = null; state = null; busy = false; errorText = ''; }
    return {load,leave};
  }
  root.ConversationRepairUi = {create};
})(window);
