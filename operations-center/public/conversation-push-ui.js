(function(root) {
  'use strict';
  const states={pending:'等待推送',buffered:'待上传',running:'推送中',sent:'已送达',failed:'失败',cancelled:'已取消'};
  const errors={TIMEOUT:'目标响应超时',ABORTED:'发送已中止',DNS_FAILED:'目标域名解析失败',ADDRESS_BLOCKED:'目标地址不被允许',REDIRECT_REJECTED:'目标返回重定向',HTTP_REJECTED:'目标拒绝请求',NETWORK_FAILED:'连接失败',RESPONSE_TOO_LARGE:'目标响应过大',DELIVERY_UNKNOWN:'上次送达结果未确认',COLLECTION_EXCLUDED:'用户或模型已排除',TARGET_CHANGED:'推送目标或副本已更改',CONTENT_CHANGED:'日志副本已更新',COPY_UNAVAILABLE:'所选副本不可用',RECORD_EXPIRED:'日志已过期',ADMIN_CANCELLED:'管理员取消',DELIVERY_INVALIDATED:'发送条件已变化',ATTEMPTS_EXHAUSTED:'已达重试上限',QUEUE_FAILED:'队列暂不可用'};
  function create({container,api,escapeHtml:esc,icon,refreshIcons,isActive}) {
    Object.assign(errors,{INCOMPLETE_CAPTURE:'传输完整性未确认，当前范围不推送',INSPECTION_INCOMPLETE:'含未检查内容，暂停脱敏推送',REDACTION_OUTDATED:'脱敏规则已更新，需重新处理',PROCESSING_PENDING:'原文已保存，等待后台处理',PROCESSING_FAILED:'脱敏处理异常，需重新处理'});
    Object.assign(errors,{JSONL_RECORD_TOO_LARGE:'单条日志超过文件上限，正文未截断',JSONL_CONTENT_CHANGED:'文件内容校验不一致',JSONL_QUEUE_FAILED:'JSONL 队列暂不可用',EXPORT_MEMORY:'后台内存暂不足，正文与进度保留',EXPORT_CAPACITY:'可用空间不足，未增加汇总数据',MULTIPART_INVALID:'分片上传回执无效',PUSH_WORKER_UNAVAILABLE:'推送后台暂不可用'});
    Object.assign(errors,{MULTIPART_RESTART:'远端上传已失效，将沿原路径重建',MULTIPART_CHECKPOINT_INVALID:'分片进度校验异常，将重建上传'});
    Object.assign(errors,{MASKED_READ_FAILED:'脱敏副本读取失败',EXPORT_REQUEST_ID:'归档请求 ID 缺失或无效，请检查对应日志'});
    const fileStates={open:'汇总中',pending:'待上传',running:'上传中',sent:'已送达',failed:'失败',cancelled:'已取消'};
    const $=id=>container.querySelector('#clp-'+id),base='/api/conversation-logs/push/';
    let policy=null,dirty=false,busy=false,mounted=false,epoch=0,controller=null,jobsController=null,jobsSeq=0,timer=null,page=1,preview=null,batchBody=null,jobsError='';
    let platforms=null,view='platforms',billingPage=1,billingView='summary',billingController=null,billingSeq=0,jobsTableKey='';
    let pricing=null,pricingController=null,pricingSeq=0,lastBillingRefresh=0;
    const pricingActive=()=>pricing?.job&&['pending','running'].includes(pricing.job.status);
    const targets=()=>root.ConversationPlatformsUi.all(policy);
    const targetName=id=>targets().find(row=>row.id===id)?.name||id;
    const actions=new Set();
    const number=value=>new Intl.NumberFormat('zh-CN').format(value||0);
    const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
    const size=value=>value>=1024**3?`${number(Math.round(value/1024**3*100)/100)} GiB`:value>=1024**2?`${number(Math.round(value/1024**2*100)/100)} MiB`:`${number(Math.round((value||0)/1024))} KiB`;
    const reasons=value=>Object.entries(value||{}).map(([code,count])=>`${errors[code]||code} ${number(count)} 条`).join('；');
    const copyLabel=row=>row.delivery_source==='masked'?'已固定脱敏副本':row.delivery_source==='original'?
      (row.delivery_fallback_reason?'已固定原文回退':'已固定原文'):row.source==='original'?'原文':'脱敏优先，可回退原文';
    const tool=(glyph,title,attrs='')=>`<button type="button" class="icon-button" title="${esc(title)}" aria-label="${esc(title)}" ${attrs}>${icon(glyph)}</button>`;
    const toggle=(name,label,checked)=>`<label class="clp-toggle"><span>${label}</span><input type="checkbox" name="${name}" ${checked?'checked':''}></label>`;
    const field=(name,label,value,type='text',attrs='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value??'')}" ${attrs}></label>`;
    function message(value='',bad=false) { if($('message')){$('message').textContent=value;$('message').classList.toggle('amber',bad);} }
    function errorText(error) {return /failed to fetch|networkerror|load failed|network request failed/i.test(error.message||'')
      ?'运营中心连接失败，请稍后重试；若持续出现，请检查服务状态':error.message;}
    function previewNotice(value='',bad=false) {if($('preview-status')){$('preview-status').textContent=value;$('preview-status').classList.toggle('amber',bad);}}
    function run(task) {
      const current=epoch;
      Promise.resolve().then(task).catch(error=>{if(current===epoch&&isActive()&&error.name!=='AbortError')message(errorText(error),true);});
    }
    function shell() {
      container.innerHTML=`<div class="cl-section-heading"><h2>推送与存储计费</h2><span id="clp-state"></span></div><div class="cl-tabs" role="tablist" aria-label="推送管理"><button type="button" class="active" id="clp-tab-platforms" role="tab" aria-selected="true" aria-controls="clp-view-platforms" data-clp-view="platforms">${icon('network')}推送平台</button><button type="button" id="clp-tab-jobs" role="tab" aria-selected="false" aria-controls="clp-view-jobs" data-clp-view="jobs">${icon('list-checks')}推送任务</button><button type="button" id="clp-tab-billing" role="tab" aria-selected="false" aria-controls="clp-view-billing" data-clp-view="billing">${icon('receipt-text')}存储计费</button></div><div id="clp-message" class="cl-notice" role="status"></div><section id="clp-view-platforms" role="tabpanel" aria-labelledby="clp-tab-platforms"><div id="clp-config"></div></section><div id="clp-cleanup" class="cl-notice" role="status"></div><section id="clp-view-jobs" role="tabpanel" aria-labelledby="clp-tab-jobs" hidden>
        <section class="clp-section" aria-labelledby="clp-history-title"><div class="cl-section-heading"><h2 id="clp-history-title">历史批量推送</h2><span>每批最多 10,000 条日志</span></div><div id="clp-index" class="cl-notice" role="status"></div>
        <form id="clp-history"><div class="cl-filters">${field('search','模型 / 请求 / 用户','')}${field('start','开始日期','','date')}${field('end','结束日期','','date')}${field('user_id','用户 ID','','number','min="1"')}${field('key_id','Key ID','','number','min="1"')}
        <label>协议<select name="protocol"><option value="">全部协议</option><option>JSON</option><option>SSE</option><option>WebSocket</option></select></label><label>采集状态<select name="capture"><option value="">全部状态</option><option value="complete">完整采集</option><option value="partial">部分采集</option><option value="missing">正文缺失</option><option value="redaction_failed">处理异常</option></select></label></div>
        <div id="clp-destinations" class="cl-modes"></div><div class="clp-actions"><button class="button secondary" type="submit" id="clp-preview">${icon('list-filter')}预览批次</button><span id="clp-source" class="cl-muted"></span></div><div id="clp-preview-status" class="cl-notice" role="status" aria-live="polite"></div></form>
        <div id="clp-preview-result"></div></section>
        <section id="clp-files-section" class="clp-section" aria-labelledby="clp-files-title"><div class="cl-section-heading"><h2 id="clp-files-title">JSONL 文件</h2><button type="button" class="button secondary" id="clp-flush" data-clp-action="flush">${icon('upload')}立即上传待汇总日志</button></div><div id="clp-backlog" class="cl-notice" role="status"></div><div id="clp-files"></div></section>
        <section class="clp-section" aria-labelledby="clp-jobs-title"><div class="cl-section-heading"><h2 id="clp-jobs-title">推送记录</h2><div class="clp-actions"><select id="clp-job-status" aria-label="推送状态"><option value="">全部状态</option>${Object.entries(states).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select>${tool('refresh-cw','刷新推送记录','data-clp-action="refresh"')}</div></div>
        <div id="clp-counts" class="clp-counts"></div><div id="clp-skipped" class="cl-notice"></div><div id="clp-jobs"></div><div class="cl-pagination"><span id="clp-pages"></span><div>${tool('chevron-left','上一页推送记录','data-clp-action="prev" id="clp-prev"')}${tool('chevron-right','下一页推送记录','data-clp-action="next" id="clp-next"')}</div></div><div id="clp-batches"></div></section></section><section id="clp-view-billing" role="tabpanel" aria-labelledby="clp-tab-billing" hidden><div class="cl-section-heading"><h2>存储计费</h2><span>人民币 · 1 TB = 10¹² 字节</span></div><div class="cl-filters clpp-billing-filters"><label>推送平台<select id="clp-bill-platform"><option value="">全部平台</option></select></label><label>模型<input id="clp-bill-model" maxlength="160"></label><label>开始日期<input type="date" id="clp-bill-start"></label><label>结束日期<input type="date" id="clp-bill-end"></label><div class="clp-actions"><button class="button secondary" type="button" data-clp-action="bill-filter">${icon('list-filter')}查询</button>${tool('refresh-cw','刷新计费','data-clp-action="bill-refresh"')}</div></div><div class="cl-modes"><button type="button" class="active" data-clp-bill-view="summary" aria-pressed="true">按模型汇总</button><button type="button" data-clp-bill-view="detail" aria-pressed="false">送达明细</button></div><div id="clp-billing" aria-live="polite"></div><div class="clp-actions"><button class="button secondary" type="button" data-clp-action="bill-price">${icon('calculator')}自动补记全部未计费记录</button><span class="cl-muted">当前筛选范围 · 保留已计费记录原单价</span></div><div id="clp-bill-pricing" class="clp-pricing" role="status" aria-live="polite"></div><div class="cl-pagination"><span id="clp-bill-pages"></span><div>${tool('chevron-left','上一页计费明细','data-clp-action="bill-prev" id="clp-bill-prev"')}${tool('chevron-right','下一页计费明细','data-clp-action="bill-next" id="clp-bill-next"')}</div></div></section>`;
      $('history').addEventListener('submit',event=>{event.preventDefault();run(previewBatch);});
      $('history').addEventListener('input',clearPreview);$('history').addEventListener('change',clearPreview);
      $('job-status').addEventListener('change',()=>{page=1;run(refreshJobs);});
      mounted=true;showView(view);refreshIcons();
    }
    function renderPolicy(value) {
      policy=value;
      $('state').textContent=`${value.enabled?'已启用':'已关闭'} · v${value.version}`;
      $('config').innerHTML=`<form id="clp-form" class="cl-policy-form" autocomplete="off">${toggle('enabled','启用日志推送',value.enabled)}
        <div class="clp-options">${toggle('automatic','自动推送新日志',value.automatic)}<label id="clp-automatic-options">自动推送方式<select name="automaticMode"><option value="realtime" ${value.automaticMode!=='previous_day'?'selected':''}>实时推送</option><option value="previous_day" ${value.automaticMode==='previous_day'?'selected':''}>推送前一天</option></select></label><label>推送副本<select name="source"><option value="masked" ${value.source==='masked'?'selected':''}>脱敏优先（不可用则原文）</option><option value="original" ${value.source==='original'?'selected':''}>原文（可能含敏感信息）</option></select></label><label>推送范围<select name="captureScope"><option value="complete" ${value.captureScope!=='all'?'selected':''}>仅传输完整</option><option value="all" ${value.captureScope==='all'?'selected':''}>包含传输未确认</option></select></label></div>
        <div id="clp-automatic-status" class="cl-notice" role="status"></div>
        <div id="clp-platforms"></div>
        <fieldset><legend>本地保留</legend>${toggle('deleteAfterPush','确认送达后清理本地对话日志',value.deleteAfterPush)}<p class="cl-muted">所有推送目标确认送达后，删除本地原文和脱敏副本，保留送达凭证。开启后也会清理符合条件的已送达历史；清理后不能从本地再次查看、导出或重新脱敏。</p></fieldset>
        <fieldset><legend>发送设置</legend><div class="cl-policy-grid">${field('maxAttempts','最大尝试次数',value.maxAttempts,'number','required min="1" max="10"')}${field('retrySeconds','首次重试间隔（秒）',value.retrySeconds,'number','required min="5" max="3600"')}${field('timeoutSeconds','发送超时（秒）',value.timeoutSeconds,'number','required min="3" max="60"')}${field('queueLimit','待发送任务上限',value.queueLimit,'number','required min="100" max="50000"')}</div>${toggle('allowPrivateNetwork','允许私有网络目标 / HTTP',value.allowPrivateNetwork)}</fieldset>
        <p class="cl-muted">每条数据包含请求 ID、请求正文和返回正文。压缩内容会解压；无法解码的字节以 data URI 保留。脱敏副本不可用时使用原文，可能含敏感信息，实际来源在本地推送记录中查看。关闭推送会暂停队列，已经发出的内容无法撤回。</p>
        <footer><button type="submit" class="button" id="clp-save">${icon('save')}保存推送策略</button><button type="button" class="button secondary" data-clp-action="discard">放弃更改</button><span id="clp-dirty" class="cl-muted"></span></footer></form>`;
      $('form').addEventListener('input',markDirty);$('form').addEventListener('change',markDirty);
      $('form').addEventListener('submit',event=>{event.preventDefault();run(save);});
      platforms=root.ConversationPlatformsUi.create({container:$('platforms'),escapeHtml:esc,icon,refreshIcons,onChange:markDirty,onSave:()=>$('form').requestSubmit()});platforms.render(value);
      $('destinations').innerHTML=targets().filter(row=>row.enabled||row.endpoint||row.url).map(target=>`<label><input type="checkbox" name="destination" value="${esc(target.id)}" ${target.enabled?'checked':'disabled'}>${esc(target.name)}</label>`).join('');
      const billPlatform=$('bill-platform'),selected=billPlatform.value;
      billPlatform.innerHTML='<option value="">全部平台</option>'+targets().filter(row=>row.enabled||row.endpoint||row.url).map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');billPlatform.value=selected;
      $('source').textContent=(value.source==='masked'?'脱敏优先，不可用则原文（可能含敏感信息）':'推送原文（可能含敏感信息）')+' · '+(value.captureScope==='all'?'包含传输未确认':'仅传输完整');
      updateControls();refreshIcons();
    }
    function markDirty() {dirty=true;clearPreview();updateControls();}
    function updateControls() {
      if(!$('form'))return;
      $('form').querySelectorAll('input,select,button').forEach(node=>{node.disabled=busy||node.dataset.clppLimited==='true';});
      $('form').querySelectorAll('[data-clp-test]').forEach(node=>{node.disabled=busy||dirty||!targets().find(row=>row.id===node.dataset.clpTest)?.enabled;});
      $('automatic-options').hidden=!$('form').elements.automatic.checked;
      $('form').elements.automaticMode.disabled=busy||!$('form').elements.automatic.checked;
      $('flush').disabled=busy||dirty||!policy.enabled||!targets().some(row=>row.enabled&&row.type==='s3'&&row.format==='jsonl');
      $('dirty').textContent=dirty?'有未保存的更改':'';
      const price=container.querySelector('[data-clp-action="bill-price"]');
      price.disabled=busy||dirty||actions.has('billing')||pricingActive();price.title=dirty?'请先保存平台与模型定价':'';
      const cancel=container.querySelector('[data-clp-action="bill-stop"]');if(cancel)cancel.disabled=actions.has('billing');
      $('preview').disabled=busy||dirty||!policy.enabled;
      if($('enqueue'))$('enqueue').disabled=busy||dirty||!$('acknowledge').checked;
    }
    function body() {
      const data=new FormData($('form')),text=name=>String(data.get(name)||''),yes=name=>data.has(name);
      return {version:policy.version,enabled:yes('enabled'),automatic:yes('automatic'),automaticMode:$('form').elements.automaticMode.value,source:text('source'),captureScope:text('captureScope'),deleteAfterPush:yes('deleteAfterPush'),allowPrivateNetwork:yes('allowPrivateNetwork'),
        maxAttempts:Number(data.get('maxAttempts')),retrySeconds:Number(data.get('retrySeconds')),timeoutSeconds:Number(data.get('timeoutSeconds')),queueLimit:Number(data.get('queueLimit')),
        ...platforms.body()};
    }
    async function save() {
      if(busy)return;
      const input=body(),current=epoch;busy=true;updateControls();message();
      try {
        const value=await api(base+'policy',{method:'PUT',body:JSON.stringify(input),signal:controller.signal});
        if(current!==epoch||!isActive())return;dirty=false;clearPreview();renderPolicy(value);message('推送策略已保存');await refreshJobs();await refreshBilling();
      } finally {if(current===epoch){busy=false;updateControls();}}
    }
    function selection() {
      const data=new FormData($('history')),filter={};
      for(const key of ['search','start','end','user_id','key_id','protocol','capture'])if(data.get(key))filter[key]=String(data.get(key));
      return {filter,destinations:data.getAll('destination')};
    }
    function clearPreview() {preview=null;batchBody=null;if($('preview-result'))$('preview-result').innerHTML='';previewNotice();}
    async function previewBatch() {
      if(busy||dirty||!policy.enabled)return;
      const input=selection(),current=epoch;clearPreview();busy=true;updateControls();message();previewNotice('正在预览批次，请稍候');
      try {
        const value=await api(base+'preview',{method:'POST',body:JSON.stringify(input),signal:controller.signal});
        if(current!==epoch||!isActive())return;
        if(JSON.stringify(selection())!==JSON.stringify(input)){previewNotice('筛选条件已变化，请重新预览');return;}
        preview=value;batchBody={...input,batchId:crypto.randomUUID(),previewToken:value.previewToken};
        $('preview-result').innerHTML=`<div class="clp-preview"><dl class="cl-facts">${[['匹配日志',value.matched],['可推送日志',value.eligible],['回退原文',value.fallbacks],['规则排除',value.excluded],['暂不可推送',value.unavailable],['已有任务',value.duplicates],['新增任务',value.jobs]].map(([label,count])=>`<div><dt>${label}</dt><dd>${number(count)}</dd></div>`).join('')}</dl>${value.jobs?`<label class="clp-check"><input type="checkbox" id="clp-acknowledge">确认将 ${number(value.eligible)} 条${policy.source==='original'?'原文':'脱敏优先（不可用则原文）'}日志推送至 ${input.destinations.map(id=>esc(targetName(id))).join('、')}</label><div class="clp-actions"><button id="clp-enqueue" type="button" class="button" data-clp-action="enqueue" disabled>${icon('send')}加入推送队列</button></div>`:'<p class="cl-muted">没有需要新增的推送任务</p>'}</div>`;
        const unavailable=reasons(value.unavailableReasons);
        if(unavailable)$('preview-result').insertAdjacentHTML('beforeend',`<p class="cl-notice">${esc(unavailable)}</p>`);
        if(value.fallbacks)$('preview-result').insertAdjacentHTML('beforeend',`<p class="cl-notice amber">回退原文 ${number(value.fallbacks)} 条，可能含敏感信息。${esc(reasons(value.fallbackReasons))}</p>`);
        previewNotice(`预览完成 · 匹配 ${number(value.matched)} 条 · 新增 ${number(value.jobs)} 个任务`);
        $('acknowledge')?.addEventListener('change',updateControls);refreshIcons();
      } catch(error) {
        if(current===epoch&&isActive()&&error.name!=='AbortError')previewNotice(errorText(error),true);
      } finally {if(current===epoch){busy=false;updateControls();}}
    }
    async function enqueue() {
      if(busy||dirty||!preview||!$('acknowledge').checked)return;
      const input=batchBody,current=epoch;busy=true;updateControls();message();
      try {
        const result=await api(base+'batches',{method:'POST',body:JSON.stringify(input),signal:controller.signal});
        if(current!==epoch||!isActive())return;clearPreview();message(`批次已创建，新增 ${number(result.created)} 个任务`);page=1;await refreshJobs();
      } finally {if(current===epoch){busy=false;updateControls();}}
    }
    function renderTable(id,columns,rows,emptyText,reset=false) {
      const host=$(id);let viewport=host.querySelector('.clp-table');
      const top=reset?0:viewport?.scrollTop||0,left=reset?0:viewport?.scrollLeft||0;
      if(!rows){host.innerHTML=`<div class="cl-empty">${esc(emptyText)}</div>`;return;}
      if(!viewport){
        host.innerHTML=`<div class="table-wrap clp-table"><table><thead><tr>${columns.map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
        viewport=host.querySelector('.clp-table');
      }
      viewport.querySelector('tbody').innerHTML=rows;
      viewport.scrollTop=top;viewport.scrollLeft=left;
    }
    function renderFile(file) {
      const uploaded=file.status==='sent'?file.bytes:Math.min(file.bytes,file.uploaded_bytes||0);
      const paused=file.pause_reason==='archive_busy'?'采集优先，上传暂缓':file.pause_reason==='memory_wait'?'等待内存恢复，上传进度保留':!policy.enabled?'推送已暂停':'';
      return `<tr><td><strong>${esc(file.model||'未提供模型')}</strong><small>${esc(targetName(file.destination||'s3'))} · ${esc(file.day)}</small></td><td><code class="clp-object-key">${esc(file.object_key)}</code></td><td>${number(file.records)} 条<small>${esc(size(file.bytes))}</small><progress class="clp-progress" max="${file.bytes||1}" value="${uploaded}" aria-label="已确认上传进度"></progress><small>${esc(size(uploaded))} / ${esc(size(file.bytes))} · ${number(file.uploaded_parts)} 个分片</small></td><td><span class="cl-badge ${file.status==='sent'?'green':['failed','cancelled'].includes(file.status)?'amber':''}">${fileStates[file.status]||esc(file.status)}</span><small>${esc(['sent','cancelled'].includes(file.status)?'':paused)}</small><small>${esc(errors[file.error_code]||file.error_code||'')}</small></td><td>${file.status==='failed'?tool('rotate-cw','继续上传此 JSONL 文件',`data-clp-file-retry="${esc(file.id)}"`):''}</td></tr>`;
    }
    function renderJobs(value) {
      const automatic=value.automatic;
      const schedule=automatic?.mode==='previous_day'?`次日 00:00 起 · ${automatic.timezone}`:'实时安排 · JSONL 沿用汇总及定时设置';
      $('automatic-status').hidden=!policy.automatic&&!automatic?.waiting;
      $('automatic-status').textContent=[policy.enabled&&policy.automatic?schedule:'自动计划已暂停',automatic?.waiting?`待自动核对 ${number(automatic.waiting)} 条，已到日期 ${number(automatic.ready)} 条`:''].filter(Boolean).join(' · ');
      const index=value.metadataIndex;
      $('index').textContent=index&&!index.ready?`历史推送准备中 · 已就绪 ${number(index.indexed)} / ${number(index.total)} 条，后台会继续处理`:'';
      const cleanup=value.cleanup;
      $('cleanup').hidden=!cleanup?.enabled;
      $('cleanup').textContent=cleanup?.enabled?`送达后清理 · 已清理 ${number(cleanup.deleted)} 条 · 已移除 ${size(cleanup.bytes)} · 待核对 ${number(cleanup.pending)} 条${cleanup.error?' · 本地清理暂缓，后台将重试':''}`:'';
      const files=value.jsonl?.files||[];
      $('files-section').hidden=!files.length&&!targets().some(row=>row.type==='s3'&&row.format==='jsonl');
      const backlog=value.jsonl?.backlog;
      $('backlog').textContent=backlog?.files?`待上传 ${number(backlog.files)} 个文件 · ${number(backlog.records)} 条 · ${size(backlog.bytes)}${backlog.expiryAt?' · 最早归档到期 '+time(backlog.expiryAt):''}${backlog.atRisk?' · 6 小时内有归档到期风险':''}`:'暂无待上传积压';
      $('backlog').classList.toggle('amber',Boolean(backlog?.atRisk));
      renderTable('files',['模型 / 日期','文件','日志 / 上传进度','状态',''],files.map(renderFile).join(''),'暂无 JSONL 文件');
      const skipped=reasons(Object.fromEntries((value.skipped||[]).map(row=>[row.code,row.count])));
      const fallbacks=reasons(Object.fromEntries((value.fallbacks||[]).map(row=>[row.code,row.count])));
      $('skipped').textContent=[fallbacks?'本策略自动入队已回退原文（可能含敏感信息）：'+fallbacks:'',skipped?'本策略自动扫描已跳过：'+skipped:''].filter(Boolean).join('；');
      $('counts').innerHTML=Object.entries(states).map(([state,label])=>`<span>${label}<strong>${number(value.counts.find(row=>row.status===state)?.count)}</strong></span>`).join('');
      const tableKey=`${page}:${$('job-status').value}`;
      renderTable('jobs',['日志 / 模型','目标 / 副本策略','状态 / 尝试','最近结果','更新时间',''],value.items.map(row=>`<tr><td><strong>${esc(row.model||'未提供模型')}</strong><small>${row.local_deleted_at?'本地已清理':'用户 #'+esc(row.user_id)} · ${esc(row.record_id.slice(0,12))}</small></td><td>${esc(targetName(row.destination))}<small>${esc(copyLabel(row))}</small></td><td><span class="cl-badge ${row.status==='sent'?'green':['failed','cancelled'].includes(row.status)?'amber':''}">${states[row.status]}</span><small>${row.attempts} 次尝试</small></td><td>${esc(errors[row.error_code]||row.error_code|| (row.local_deleted_at?'送达成功，本地已清理':row.status==='sent'?'送达成功':'—'))}${row.http_status?`<small>HTTP ${row.http_status}</small>`:''}${row.status==='pending'&&row.attempts?`<small>下次 ${esc(time(row.next_at))}</small>`:''}</td><td>${esc(time(row.updated_at))}<small><code>${esc(row.id.slice(0,12))}</code></small></td><td>${['failed','cancelled'].includes(row.status)?tool('rotate-cw','重试此推送',`data-clp-retry="${row.id}" ${actions.has(row.id)?'disabled':''}`):''}</td></tr>`).join(''),'暂无推送任务',jobsTableKey!==tableKey);
      jobsTableKey=tableKey;
      $('pages').textContent=`${number(value.total)} 个任务 · ${page} / ${Math.max(1,value.pages)} 页`;
      $('prev').disabled=page<=1;$('next').disabled=page>=value.pages;
      $('batches').innerHTML=value.batches.length?`<div class="cl-section-heading"><h2>最近批次</h2></div><div class="clp-batches">${value.batches.map(row=>`<div><code>${esc(row.id)}</code><span>${esc(time(row.created_at))} · ${number(row.created)} 个任务</span>${tool('square','取消此批次未完成推送',`data-clp-cancel="${row.id}" ${actions.has(row.id)?'disabled':''}`)}</div>`).join('')}</div>`:'';
      refreshIcons();
    }
    async function refreshJobs() {
      if(!isActive()||!mounted)return;
      const current=epoch,seq=++jobsSeq;jobsController?.abort();jobsController=new AbortController();
      try {
        const value=await api(base+'jobs?'+new URLSearchParams({page:String(page),status:$('job-status').value}),{signal:jobsController.signal});
        if(current!==epoch||seq!==jobsSeq||!isActive())return;renderJobs(value);
        if(view==='billing')run(refreshBilling);
        if(jobsError&&$('message').textContent===jobsError)message();jobsError='';
      } catch(error) {
        if(current===epoch&&seq===jobsSeq&&isActive()&&error.name!=='AbortError'){jobsError=errorText(error);message(jobsError,true);}
      }
    }
    async function testTarget(destination) {
      if(busy||dirty)return;
      const current=epoch;busy=true;updateControls();$('test-'+destination).textContent='正在测试连接';
      try {
        const value=await api(base+'test/'+destination,{method:'POST',body:'{}',signal:controller.signal});
        if(current!==epoch||!isActive())return;
        $('test-'+destination).textContent=value.status==='sent'?'连接成功，诊断数据已送达':`${errors[value.errorCode]||value.errorCode}${value.httpStatus?' · HTTP '+value.httpStatus:''}`;
      } finally {if(current===epoch){busy=false;updateControls();}}
    }
    async function jobAction(kind,id) {
      if(actions.has(id))return;const current=epoch;actions.add(id);
      try {
        const value=await api(base+(kind==='file'?`jsonl/${id}/retry`:kind==='retry'?`jobs/${id}/retry`:`batches/${id}/cancel`),{method:'POST',body:'{}',signal:controller.signal});
        if(current!==epoch||!isActive())return;message(kind==='retry'||kind==='file'?'已加入重试队列':`已取消 ${number(value.cancelled)} 个未完成任务`);await refreshJobs();
      } finally {actions.delete(id);}
    }
    async function flush() {
      if(busy||dirty)return;const current=epoch;busy=true;updateControls();
      try {await api(base+'jsonl/flush',{method:'POST',body:'{}',signal:controller.signal});if(current===epoch&&isActive()){message('待汇总日志已加入上传队列');await refreshJobs();}}
      finally {if(current===epoch){busy=false;updateControls();}}
    }
    function showView(value) {
      view=value;
      container.querySelectorAll('[data-clp-view]').forEach(button=>{const selected=button.dataset.clpView===value;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));});
      for(const name of ['platforms','jobs','billing'])$('view-'+name).hidden=name!==value;
      if(value==='billing'&&policy)run(refreshBilling);
    }
    function billingQuery() {
      const result={page:String(billingPage)};
      for(const [id,key] of [['platform','platform'],['model','model'],['start','start'],['end','end']])if($('bill-'+id).value.trim())result[key]=$('bill-'+id).value.trim();
      return result;
    }
    function renderBilling(value,taskSeq) {
      const money=value=>value===null?'待定价':'¥'+Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6});
      const summary=value.summary,list=billingView==='summary'?value.models:value.items;
      const billingStatus=row=>row.rate!==null?'已计费':row.billing_enabled?'待定价':'未启用计费';
      $('billing').innerHTML=`<div class="clpp-billing-stats"><div><span>确认送达容量</span><strong>${esc(summary.terabytes)} TB</strong><small>按平台分别累计</small></div><div><span>已计费金额</span><strong>${money(summary.amount)}</strong><small>${number(summary.pricedFiles)} 个已定价文件</small></div><div><span>待定价</span><strong>${number(summary.pendingFiles)} 项</strong><small>另有 ${number(summary.disabledFiles)} 项未启用计费</small></div></div><div class="table-wrap clpp-billing-table"><table><thead><tr><th>平台${billingView==='detail'?' / 送达时间':''}</th><th>模型${billingView==='detail'?' / 日志日期':''}</th><th>成功容量（TB）</th><th>单价（元 / TB）</th><th>费用（元）</th><th>${billingView==='detail'?'状态':'文件数'}</th></tr></thead><tbody>${list.map(row=>`<tr><td>${esc(row.platform_name)}${billingView==='detail'?`<small>${esc(time(row.delivered_at))}</small>`:''}</td><td>${esc(row.model)}${billingView==='detail'?`<small>${esc(row.log_date)} · ${number(row.records)} 条</small>`:''}</td><td class="clp-money">${esc(row.terabytes)}<small>${number(row.bytes)} 字节</small></td><td class="clp-money">${row.rate===null?'—':esc(row.rate)}<small>v${number(row.rate_version)}</small></td><td class="clp-money">${row.rate===null?esc(billingStatus(row)):money(row.amount)}</td><td>${billingView==='detail'?esc(billingStatus(row)):number(row.files)}</td></tr>`).join('')||'<tr><td colspan="6" class="cl-muted">暂无已确认送达的数据</td></tr>'}</tbody><tfoot><tr><td colspan="2">合计</td><td class="clp-money">${esc(summary.terabytes)}</td><td></td><td class="clp-money">${money(summary.amount)}</td><td>${number(summary.files)}</td></tr></tfoot></table></div><p class="cl-muted">仅确认送达的完整文件参与计费；同一平台同一文件重试只计费一次。正文清理后保留费用凭证。${value.modelsTruncated?'模型汇总最多展示 1,000 行，可缩小筛选范围；合计仍包含全部匹配数据。':''}</p>`;
      $('bill-pages').textContent=billingView==='detail'?`${number(value.total)} 个文件 · ${billingPage} / ${Math.max(1,value.pages)} 页`:`${number(value.models.length)} 行模型汇总`;
      $('bill-prev').disabled=billingView!=='detail'||billingPage<=1;$('bill-next').disabled=billingView!=='detail'||billingPage>=value.pages;
      container.querySelectorAll('[data-clp-bill-view]').forEach(button=>{const selected=button.dataset.clpBillView===billingView;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
      for(const row of value.platforms)if(![...$('bill-platform').options].some(option=>option.value===row.id))$('bill-platform').add(new Option(row.name,row.id));
      if(!Object.keys(billingQuery()).some(key=>key!=='page')){
        platforms?.amounts(value.platformTotals.map(row=>[row.id,row.amount]));
      }
      if(taskSeq===pricingSeq)renderPricing(value.pricing);
      refreshIcons();
    }
    function renderPricing(value) {
      pricing=value||null;
      const job=pricing?.job,node=$('bill-pricing');
      if(!job){node.innerHTML='';updateControls();return;}
      const active=pricingActive(),paused={foreground:'等待采集、读取或导出完成',push:'等待当前推送完成',worker:'等待后台进程恢复',retry:'归档忙，稍后自动继续',stopped:'等待后台恢复'};
      const label=job.status==='done'?'补记已完成':job.status==='cancelled'?'补记已停止':paused[value.pauseReason]||(job.phase==='history'?'正在核对历史成功文件':'正在自动补记');
      const scope=[job.filter.platform?targetName(job.filter.platform):'全部平台',job.filter.model||'全部模型',job.filter.start||job.filter.end?`${job.filter.start||'不限'} 至 ${job.filter.end||'不限'}`:'全部日期'].join(' · ');
      node.innerHTML=`<div><strong>${esc(label)}</strong><span>已补记 ${number(job.updated)} 项 · ${esc(job.terabytes)} TB · ¥${esc(job.amount)}</span><small>${esc(scope)} · ${esc(time(job.requestedAt))} 提交时单价</small><small>已检查 ${number(job.scanned)} 项${job.imported?` · 已核验补入 ${number(job.imported)} 份历史容量`:''}${active?'':' · 未启用计费或缺少单价的记录保留待处理'}</small></div>${active?tool('square','停止本次补记','data-clp-action="bill-stop"'):''}`;
      updateControls();refreshIcons();
    }
    async function refreshBilling() {
      if(!isActive()||!mounted||!policy)return;
      const current=epoch,seq=++billingSeq,taskSeq=++pricingSeq,query=billingQuery();billingController?.abort();billingController=new AbortController();
      try{
        const value=await api(base+'billing?'+new URLSearchParams(query),{signal:billingController.signal});
        if(current===epoch&&seq===billingSeq&&isActive()&&JSON.stringify(query)===JSON.stringify(billingQuery())){lastBillingRefresh=Date.now();renderBilling(value,taskSeq);}
      }catch(error){if(current===epoch&&seq===billingSeq&&error.name!=='AbortError')message(errorText(error),true);}
    }
    async function pollBilling() {
      if(!pricingActive()) {if(Date.now()-lastBillingRefresh>=15000)await refreshBilling();return;}
      if(!isActive()||!mounted||actions.has('billing'))return;
      const current=epoch,seq=++pricingSeq;pricingController?.abort();pricingController=new AbortController();
      const value=await api(base+'billing/price',{signal:pricingController.signal});
      if(current!==epoch||seq!==pricingSeq||!isActive())return;
      renderPricing(value);
      if(!pricingActive()||Date.now()-lastBillingRefresh>=30000)await refreshBilling();
    }
    async function pricePending() {
      if(busy||dirty||actions.has('billing')||pricingActive())return;actions.add('billing');++pricingSeq;pricingController?.abort();
      const current=epoch,button=container.querySelector('[data-clp-action="bill-price"]');button.disabled=true;
      try{
        const value=await api(base+'billing/price',{method:'POST',body:JSON.stringify(billingQuery()),signal:controller.signal});
        if(current!==epoch||!isActive())return;renderPricing({job:value.job});message(value.job.status==='done'?'没有符合当前定价的待补记记录':'补记任务已提交，将自动处理全部匹配记录');await refreshBilling();
      }finally{actions.delete('billing');if(current===epoch)updateControls();}
    }
    async function stopPricing() {
      if(!pricingActive()||actions.has('billing'))return;
      actions.add('billing');++pricingSeq;pricingController?.abort();updateControls();const current=epoch,id=pricing.job.id;
      try{
        const value=await api(base+'billing/price/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:'{}',signal:controller.signal});
        if(current!==epoch||!isActive())return;renderPricing({job:value.job});message('补记已停止，已完成的计费保留');await refreshBilling();
      }finally{actions.delete('billing');if(current===epoch)updateControls();}
    }
    function click(event) {
      const node=event.target.closest('button');if(!node||node.disabled)return;
      const d=node.dataset;if(d.clpTest)return run(()=>testTarget(d.clpTest));if(d.clpRetry)return run(()=>jobAction('retry',d.clpRetry));if(d.clpCancel)return run(()=>jobAction('cancel',d.clpCancel));
      if(d.clpView){showView(d.clpView);return;}
      if(d.clpBillView){billingView=d.clpBillView;billingPage=1;run(refreshBilling);return;}
      if(d.clpAction==='bill-filter'||d.clpAction==='bill-refresh'){billingPage=1;run(refreshBilling);}
      if(d.clpAction==='bill-prev'||d.clpAction==='bill-next'){billingPage+=d.clpAction==='bill-next'?1:-1;run(refreshBilling);}
      if(d.clpAction==='bill-price')run(pricePending);
      if(d.clpAction==='bill-stop')run(stopPricing);
      if(d.clpFileRetry)return run(()=>jobAction('file',d.clpFileRetry));
      if(d.clpAction==='flush')run(flush);
      if(d.clpAction==='discard'){dirty=false;run(load);}
      if(d.clpAction==='enqueue')run(enqueue);
      if(d.clpAction==='refresh')run(refreshJobs);
      if(d.clpAction==='prev'||d.clpAction==='next'){page+=d.clpAction==='next'?1:-1;run(refreshJobs);}
    }
    async function load() {
      if(!isActive())return;if(!mounted)shell();
      if(busy)return;
      const current=epoch;controller?.abort();controller=new AbortController();
      const value=await api(base+'policy',{signal:controller.signal});
      if(current!==epoch||!isActive())return;
      if(!dirty){if(policy?.version!==value.version)clearPreview();renderPolicy(value);}
      if(!timer)timer=setInterval(()=>run(view==='billing'?pollBilling:refreshJobs),5000);
      await refreshJobs();await refreshBilling();
    }
    function leave() {
      ++epoch;++jobsSeq;++billingSeq;++pricingSeq;controller?.abort();jobsController?.abort();billingController?.abort();pricingController?.abort();platforms?.clear();platforms=null;clearInterval(timer);timer=null;
      policy=null;dirty=false;busy=false;mounted=false;preview=null;batchBody=null;jobsError='';actions.clear();container.innerHTML='';page=1;jobsTableKey='';
      pricing=null;lastBillingRefresh=0;
    }
    container.addEventListener('click',click);
    return {load,leave};
  }
  root.ConversationPushUi={create};
})(window);
