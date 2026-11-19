(function (root) {
  'use strict';
  function create({api,escapeHtml:esc,icon,refreshIcons,isActive,onChanged}) {
    let state = null, busy = false, timer = null, controller = null, epoch = 0, errorText = '', retryId = null;
    const active = job => ['pending','running'].includes(job?.status);
    const num = value => new Intl.NumberFormat('zh-CN').format(value || 0);
    const names = {pending:'等待清空历史',running:'正在清空历史',done:'历史清空完成',cancelled:'清空已停止'};
    const errors = {CLEANUP_TIMEOUT:'后台任务超时，将自动续办',CLEANUP_WORKER_UNAVAILABLE:'后台进程暂不可用，将自动续办',CLEANUP_STORAGE_UNAVAILABLE:'存储暂不可用，将稍后重试'};
    const redactionUi = root.ConversationRedactionUi.create({api,escapeHtml:esc,icon,isActive,onRender:render,onChanged});
    function render() {
      const host = document.getElementById('cl-history-clear'); if (!host || !isActive()) return;
      const job = state?.job, running = active(job), other = state?.activeScope === 'models';
      host.innerHTML = `<div class="cl-history-actions"><div><button class="button secondary" type="button" data-clear-start ${busy || running || other || !state ? 'disabled' : ''}>${icon('trash-2')}一键清空历史</button>${redactionUi.controls(busy || running || other)}${running ? `<button class="button secondary" type="button" data-clear-stop ${busy ? 'disabled' : ''}>${icon('square')}停止清空</button>` : ''}</div><p class="cl-muted" role="status">${job ? `${esc(names[job.status] || job.status)} · 已删除 ${num(job.deleted)} 条` : '清空全部历史日志，保留新增归档和保存策略'}${other ? ' · 名单外日志清理正在进行' : ''}${job?.error_code || state?.lastError ? '<br>' + esc(errors[job?.error_code || state.lastError] || '后台清理暂不可用') : ''}</p>${redactionUi.summary()}</div>${errorText ? `<p class="cl-notice amber" role="alert">${esc(errorText)}</p>` : ''}`;
      refreshIcons();
    }
    function showError(error) {
      if (error.name !== 'AbortError' && isActive()) {
        errorText = error.message; render();
        if (state?.activeScope) { clearTimeout(timer); timer = setTimeout(() => refresh(true).catch(showError),5000); }
      }
    }
    async function refresh(notify = false) {
      if (!isActive()) return;
      const current = epoch; controller?.abort(); clearTimeout(timer); controller = new AbortController();
      const value = await api('/api/conversation-logs/history-clear',{signal:controller.signal});
      if (current !== epoch || !isActive()) return;
      const finished = active(state?.job) && !active(value.job);
      state = value; errorText = ''; render();
      if (active(state.job) || state.activeScope) timer = setTimeout(() => refresh(true).catch(showError),2000);
      if (notify && finished) onChanged();
    }
    async function command(stop) {
      if (busy || !state) return;
      if (!stop && !root.confirm('确定清空所有已采集的历史对话日志？\n\n将删除全部用户、全部模型的本地原文、脱敏副本、会话索引及关联推送任务，无法恢复。\n保存策略和清理期间新增的归档保留；已推送到外部的数据不会删除。')) return;
      const current = epoch, id = state.job?.id;
      if (!stop && !retryId) retryId = root.crypto.randomUUID();
      const requestId = retryId;
      busy = true; errorText = ''; render();
      try {
        const value = await api('/api/conversation-logs/history-clear' + (stop ? '/' + id + '/cancel' : ''),{
          method:'POST',body:JSON.stringify(stop ? {} : {request_id:requestId,confirm:'clear-all-history'})
        });
        if (retryId === requestId) retryId = null;
        if (current === epoch && isActive()) {
          state = value; render();
          try { await refresh(); } finally { if (current === epoch && isActive()) onChanged(); }
        }
      } catch (error) { if (current === epoch) showError(error); }
      finally { if (current === epoch) { busy = false; render(); } }
    }
    async function load() {
      const host = document.getElementById('cl-history-clear'); if (!host) return;
      host.onclick = event => {
        redactionUi.handleClick(event);
        if (event.target.closest('[data-clear-start]:not(:disabled)')) command(false);
        if (event.target.closest('[data-clear-stop]:not(:disabled)')) command(true);
      };
      render();
      await Promise.all([refresh().catch(showError),redactionUi.load()]);
    }
    function leave() { ++epoch; clearTimeout(timer); controller?.abort(); state = null; busy = false; errorText = '';redactionUi.leave(); }
    return {load,leave};
  }
  root.ConversationClearUi = {create};
})(window);
