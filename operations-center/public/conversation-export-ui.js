(function (root) {
  'use strict';
  const skipNames={COLLECTION_EXCLUDED:'当前用户或模型已排除',PROCESSING_PENDING:'后台处理未完成',PROCESSING_FAILED:'脱敏处理异常',
    COPY_UNAVAILABLE:'所选副本缺失',INSPECTION_INCOMPLETE:'部分内容未检查',REDACTION_OUTDATED:'脱敏规则已更新',MASKED_READ_FAILED:'脱敏副本读取失败'};
  const active=job => ['ready','running'].includes(job?.status);
  function create({container,api,escapeHtml:esc,icon,refreshIcons,isActive,getFilter}) {
    let job=null,busy=false,preparing=false,timer=null,controller=null,epoch=0,frame=null,errorText='';
    const num=value => new Intl.NumberFormat('zh-CN').format(value || 0);
    container.innerHTML=`<form id="cl-export-form" class="cl-export-form" aria-label="导出对话日志 JSONL">
      <label>最近条数<input id="cl-export-limit" name="limit" type="number" min="1" max="10000" step="1" value="1000" required></label>
      <label>导出副本<select id="cl-export-source" name="source"><option value="masked">脱敏优先（不可用则原文）</option><option value="original">原文（含敏感信息）</option></select></label>
      <button class="icon-button" type="submit" data-cl-action="export" title="导出最近 N 条 JSONL" aria-label="导出最近 N 条 JSONL">${icon('download')}</button>
      <button class="icon-button" type="button" data-export-cancel title="取消导出" aria-label="取消导出" hidden>${icon('square')}</button>
      <span data-export-warning class="cl-muted">脱敏不可用时包含原文，可能含敏感信息</span></form>
      <p data-export-status class="cl-export-status" role="status" aria-live="polite"></p>`;
    const form=container.querySelector('form'),output=container.querySelector('[data-export-status]');
    function render() {
      if (!isActive()) return;
      const running=active(job),locked=busy || running;
      for (const node of form.querySelectorAll('input,select')) node.disabled=locked;
      form.querySelector('[type=submit]').disabled=locked || preparing;
      const cancel=form.querySelector('[data-export-cancel]');cancel.hidden=!running;cancel.disabled=busy;
      form.querySelector('[data-export-warning]').textContent=form.elements.source.value==='original' ? '文件将包含未脱敏原文' : '脱敏不可用时包含原文，可能含敏感信息';
      const skipped=Object.values(job?.skipped || {}).reduce((sum,value) => sum+value,0);
      const names={ready:'等待下载',running:job?.pauseReason ? '采集优先，导出已暂停' : '正在导出',completed:'导出已发送',cancelled:'导出已中止',expired:'下载链接已过期',failed:'导出失败'};
      const text=job ? `${names[job.status] || job.status} · 最近 ${num(job.limit)} 条中选中 ${num(job.selected)} 条 · 已导出 ${num(job.exported)} 条${job.fallbacks ? ` · 回退原文 ${num(job.fallbacks)} 条` : ''}${skipped ? ` · 跳过 ${num(skipped)} 条` : ''}` : '';
      const reasons=[...Object.entries(job?.fallbackReasons || {}).map(([code,count]) => `回退原文：${skipNames[code] || code} ${num(count)} 条`),
        ...Object.entries(job?.skipped || {}).map(([code,count]) => `${skipNames[code] || code} ${num(count)} 条`)].join('；');
      output.innerHTML=`${esc(text)}${reasons ? `<span>${esc(reasons)}</span>` : ''}${job?.errorMessage ? `<span>${esc(job.errorMessage)}</span>` : ''}${errorText ? `<span>${esc(errorText)}</span>` : ''}`;
      output.classList.toggle('amber',Boolean(errorText || job?.errorCode || skipped || job?.fallbacks));
    }
    function schedule(ms=1000) {clearTimeout(timer);if (active(job) && isActive()) timer=setTimeout(poll,ms);}
    async function poll() {
      if (!active(job) || !isActive()) return;
      const current=epoch,id=job.id;controller?.abort();controller=new AbortController();
      try {
        const value=await api('/api/conversation-logs/exports/'+id,{signal:controller.signal});
        if (current!==epoch || !isActive() || job?.id!==id) return;
        job=value;errorText='';render();
        if (!active(job)) {frame?.remove();frame=null;}
        schedule();
      } catch(error) {
        if (current===epoch && error.name!=='AbortError' && isActive()) {errorText=error.message;render();schedule(5000);}
      }
    }
    async function start(event) {
      event.preventDefault();
      if (busy || active(job) || preparing || !form.reportValidity()) return;
      const current=epoch,limit=Number(form.elements.limit.value),source=form.elements.source.value;
      const filter={...getFilter()};delete filter.page;
      busy=true;job=null;errorText='';render();
      try {
        const value=await api('/api/conversation-logs/exports',{method:'POST',body:JSON.stringify({limit,source,filter})});
        if (current!==epoch || !isActive()) {
          api('/api/conversation-logs/exports/'+value.job.id+'/cancel',{method:'POST',body:'{}'}).catch(() => {});
          return;
        }
        job=value.job;
        frame?.remove();frame=document.createElement('iframe');frame.hidden=true;frame.name='cl-export-'+job.id;frame.referrerPolicy='no-referrer';
        document.body.append(frame);
        const link=document.createElement('a');link.href=value.downloadUrl;link.target=frame.name;link.referrerPolicy='no-referrer';
        document.body.append(link);link.click();link.remove();schedule(250);
      } catch(error) {if (current===epoch && error.name!=='AbortError' && isActive()) errorText=error.message;}
      finally {if (current===epoch) {busy=false;render();}}
    }
    async function cancel() {
      if (busy || !active(job)) return;
      const current=epoch,id=job.id;busy=true;errorText='';render();
      try {
        const value=await api('/api/conversation-logs/exports/'+id+'/cancel',{method:'POST',body:'{}'});
        if (current!==epoch || !isActive()) return;
        job=value;clearTimeout(timer);frame?.remove();frame=null;
      } catch(error) {if (current===epoch && error.name!=='AbortError' && isActive()) {errorText=error.message;schedule();}}
      finally {if (current===epoch) {busy=false;render();}}
    }
    form.addEventListener('submit',start);form.querySelector('[data-export-cancel]').addEventListener('click',cancel);
    form.elements.source.addEventListener('change',render);refreshIcons();
    function setPreparing(value) {preparing=Boolean(value);render();schedule();}
    function leave() {++epoch;clearTimeout(timer);controller?.abort();frame?.remove();frame=null;busy=false;}
    return {setPreparing,leave};
  }
  root.ConversationExportUi={create};
})(window);
