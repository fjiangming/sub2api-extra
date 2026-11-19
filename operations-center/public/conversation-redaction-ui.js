(function (root) {
  'use strict';
  function create({api,escapeHtml:esc,icon,isActive,onRender,onChanged}) {
    let state = null, busy = false, timer = null, controller = null, epoch = 0, errorText = '';
    const active = job => ['pending','running'].includes(job?.status);
    const num = value => new Intl.NumberFormat('zh-CN').format(value || 0);
    const names = {pending:'等待重新脱敏',running:'正在重新脱敏',done:'历史重新脱敏完成',cancelled:'重新脱敏已停止',paused:'重新脱敏已暂停'};
    const errors = {POLICY_CHANGED:'保存策略已变化，请核对后重新启动',ALGORITHM_CHANGED:'脱敏算法已更新，请重新启动',REPAIR_TIMEOUT:'单条超时，原文保留，将有限重试',REPAIR_WORKER_UNAVAILABLE:'后台进程暂不可用，将自动续办',REPAIR_STORAGE_UNAVAILABLE:'存储暂不可用，将稍后重试'};
    function controls(blocked) {
      const running = active(state?.job);
      return `<button class="button secondary" type="button" data-redaction-start ${blocked || busy || !state || state.activeScope ? 'disabled' : ''}>${icon('scan-text')}一键重新脱敏</button>${running ? `<button class="button secondary" type="button" data-redaction-stop ${busy ? 'disabled' : ''}>${icon('square')}停止脱敏</button>` : ''}`;
    }
    function summary() {
      const job = state?.job;
      const counts = job ? ` · 已扫描 ${num(job.scanned)} · 脱敏成功 ${num(job.repaired)} · 部分内容未检查 ${num(job.warnings)} · 无原文 ${num(job.missing_original)} · 仅存原文 ${num(job.original_only)} · 资源暂缓 ${num(job.deferred)} · 失败 ${num(job.errors)} · 跳过 ${num(job.skipped)}` : '';
      const status = job ? `${esc(names[job.status] || job.status)} · 策略 v${num(job.policy_version)}` : '按当前已保存规则重新脱敏历史';
      return `<p class="cl-muted" role="status" data-redaction-status>${status}${counts}${state?.activeScope === 'compatibility' ? ' · 历史兼容检查正在进行' : ''}${job?.error_code || state?.lastError ? '<br>' + esc(errors[job?.error_code || state.lastError] || '后台脱敏暂不可用') : ''}</p>${errorText ? `<p class="cl-notice amber" role="alert">${esc(errorText)}</p>` : ''}`;
    }
    function showError(error) {
      if (error.name === 'AbortError' || !isActive()) return;
      errorText = error.message;onRender();
      if (state?.activeScope) {clearTimeout(timer);timer = setTimeout(() => refresh(true).catch(showError),5000);}
    }
    async function refresh(notify = false) {
      if (!isActive()) return;
      const current = epoch;controller?.abort();clearTimeout(timer);controller = new AbortController();
      const next = await api('/api/conversation-logs/history-redaction',{signal:controller.signal});
      if (current !== epoch || !isActive()) return;
      const finished = active(state?.job) && !active(next.job);
      state = next;errorText = '';onRender();
      if (state.activeScope) timer = setTimeout(() => refresh(true).catch(showError),2000);
      if (notify && finished) onChanged();
    }
    async function command(stop) {
      if (busy || !state) return;
      if (!stop && !root.confirm('按当前已保存的脱敏规则重新处理全部历史？\n\n仅处理启动前有原文且保存方式包含脱敏副本的记录，按原保存方式更新副本。无原文的旧记录无法还原；仅存原文的记录保持原保存方式。\n新归档保留，任务可停止；保存策略或算法变化时暂停。已推送到外部的数据不会被撤回或替换。')) return;
      const current = epoch,id = state.job?.id;busy = true;errorText = '';onRender();
      try {
        const value = await api('/api/conversation-logs/history-redaction' + (stop ? '/' + id + '/cancel' : ''),{method:'POST',body:JSON.stringify(stop ? {} : {policy_version:state.policyVersion})});
        if (current === epoch && isActive()) {state = value;onRender();await refresh();if (stop) onChanged();}
      } catch (error) {if (current === epoch) showError(error);}
      finally {if (current === epoch) {busy = false;onRender();}}
    }
    function handleClick(event) {
      if (event.target.closest('[data-redaction-start]:not(:disabled)')) command(false);
      if (event.target.closest('[data-redaction-stop]:not(:disabled)')) command(true);
    }
    async function load() {try {await refresh();} catch (error) {showError(error);}}
    function leave() {++epoch;clearTimeout(timer);controller?.abort();state = null;busy = false;errorText = '';}
    return {controls,summary,handleClick,load,leave};
  }
  root.ConversationRedactionUi = {create};
})(window);
