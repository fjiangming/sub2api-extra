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
    let policy=null,dirty=false,busy=false,mounted=false,epoch=0,controller=null,jobsController=null,jobsSeq=0,timer=null,page=1,preview=null,batchBody=null;
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
    function run(task) {
      const current=epoch;
      Promise.resolve().then(task).catch(error=>{if(current===epoch&&isActive()&&error.name!=='AbortError')message(error.message,true);});
    }
    function shell() {
      container.innerHTML=`<div class="cl-section-heading"><h2>推送策略</h2><span id="clp-state"></span></div><div id="clp-message" class="cl-notice" role="status"></div><div id="clp-config"></div>
        <section class="clp-section" aria-labelledby="clp-history-title"><div class="cl-section-heading"><h2 id="clp-history-title">历史批量推送</h2><span>每批最多 10,000 条日志</span></div>
        <form id="clp-history"><div class="cl-filters">${field('search','模型 / 请求 / 用户','')}${field('start','开始日期','','date')}${field('end','结束日期','','date')}${field('user_id','用户 ID','','number','min="1"')}${field('key_id','Key ID','','number','min="1"')}
        <label>协议<select name="protocol"><option value="">全部协议</option><option>JSON</option><option>SSE</option><option>WebSocket</option></select></label><label>采集状态<select name="capture"><option value="">全部状态</option><option value="complete">完整采集</option><option value="partial">部分采集</option><option value="missing">正文缺失</option><option value="redaction_failed">处理异常</option></select></label></div>
        <div id="clp-destinations" class="cl-modes"></div><div class="clp-actions"><button class="button secondary" type="submit" id="clp-preview">${icon('list-filter')}预览批次</button><span id="clp-source" class="cl-muted"></span></div></form>
        <div id="clp-preview-result"></div></section>
        <section id="clp-files-section" class="clp-section" aria-labelledby="clp-files-title"><div class="cl-section-heading"><h2 id="clp-files-title">JSONL 文件</h2><button type="button" class="button secondary" id="clp-flush" data-clp-action="flush">${icon('upload')}立即上传待汇总日志</button></div><div id="clp-backlog" class="cl-notice" role="status"></div><div id="clp-files"></div></section>
        <section class="clp-section" aria-labelledby="clp-jobs-title"><div class="cl-section-heading"><h2 id="clp-jobs-title">推送记录</h2><div class="clp-actions"><select id="clp-job-status" aria-label="推送状态"><option value="">全部状态</option>${Object.entries(states).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select>${tool('refresh-cw','刷新推送记录','data-clp-action="refresh"')}</div></div>
        <div id="clp-counts" class="clp-counts"></div><div id="clp-skipped" class="cl-notice"></div><div id="clp-jobs"></div><div class="cl-pagination"><span id="clp-pages"></span><div>${tool('chevron-left','上一页推送记录','data-clp-action="prev" id="clp-prev"')}${tool('chevron-right','下一页推送记录','data-clp-action="next" id="clp-next"')}</div></div><div id="clp-batches"></div></section>`;
      $('history').addEventListener('submit',event=>{event.preventDefault();run(previewBatch);});
      $('history').addEventListener('input',clearPreview);$('history').addEventListener('change',clearPreview);
      $('job-status').addEventListener('change',()=>{page=1;run(refreshJobs);});
      mounted=true;refreshIcons();
    }
    function renderPolicy(value) {
      policy=value;
      $('state').textContent=`${value.enabled?'已启用':'已关闭'} · v${value.version}`;
      $('config').innerHTML=`<form id="clp-form" class="cl-policy-form" autocomplete="off">${toggle('enabled','启用日志推送',value.enabled)}
        <div class="clp-options">${toggle('automatic','自动推送新日志',value.automatic)}<label>推送副本<select name="source"><option value="masked" ${value.source==='masked'?'selected':''}>脱敏优先（不可用则原文）</option><option value="original" ${value.source==='original'?'selected':''}>原文（可能含敏感信息）</option></select></label><label>推送范围<select name="captureScope"><option value="complete" ${value.captureScope!=='all'?'selected':''}>仅传输完整</option><option value="all" ${value.captureScope==='all'?'selected':''}>包含传输未确认</option></select></label></div>
        <div class="clp-targets"><fieldset><legend>Webhook</legend>${toggle('webhookEnabled','启用 Webhook',value.webhook.enabled)}<div class="clp-fields">${field('webhookUrl','接收 URL',value.webhook.url,'url','maxlength="2048" placeholder="https://receiver.example/logs"')}${field('webhookToken',`Bearer Token · ${value.webhook.tokenConfigured?'已设置':'未设置'}`,'','password','maxlength="4096" autocomplete="new-password" placeholder="留空保留现有值"')}</div>
        <div class="clp-actions"><label class="clp-check"><input type="checkbox" name="clearToken">清除现有 Token</label><button type="button" class="button secondary" data-clp-test="webhook">${icon('plug-zap')}测试连接</button></div><div id="clp-test-webhook" class="cl-muted" role="status"></div></fieldset>
        <fieldset><legend>S3 兼容存储</legend>${toggle('s3Enabled','启用 S3',value.s3.enabled)}<div class="clp-fields">${field('endpoint','Endpoint',value.s3.endpoint,'url','maxlength="2048" placeholder="https://s3.example.com"')}<div class="clp-pair">${field('bucket','Bucket',value.s3.bucket,'text','maxlength="63"')}${field('region','Region',value.s3.region,'text','required maxlength="64"')}</div>${field('prefix','对象前缀',value.s3.prefix,'text','maxlength="180"')}
        <label>文件格式<select name="s3Format"><option value="jsonl" ${value.s3.format==='jsonl'?'selected':''}>JSONL · 按日期和模型汇总</option><option value="json" ${value.s3.format==='json'?'selected':''}>JSON · 每条日志一个文件</option></select></label>
        <div id="clp-jsonl-options" class="clp-fields" ${value.s3.format==='jsonl'?'':'hidden'}><div class="clp-pair">${field('jsonlMaxGB','单文件上限（GB）',(value.s3.jsonl?.maxFileBytes||10000000000)/1e9,'number','required min="0.01" max="10" step="0.01"')}${field('jsonlTimezone','归档日期时区',value.s3.jsonl?.timezone||'Asia/Shanghai','text','required maxlength="80"')}</div>${field('jsonlFlushMinutes','定时上传间隔（分钟，0 为每日）',value.s3.jsonl?.flushMinutes||0,'number','required min="0" max="1440"')}${field('jsonlUploadRate','上传限速（MiB/s）',value.s3.jsonl?.uploadMiBPerSecond??2,'number','required min="0.25" max="64" step="0.25"')}</div>
        <div class="clp-pair">${field('accessKeyId',`Access Key · ${value.s3.credentialsConfigured?'已设置':'未设置'}`,'','password','maxlength="4096" autocomplete="new-password" placeholder="留空保留现有值"')}${field('secretAccessKey','Secret Key','','password','maxlength="4096" autocomplete="new-password" placeholder="留空保留现有值"')}</div>${field('sessionToken',`Session Token · ${value.s3.sessionTokenConfigured?'已设置':'未设置'}`,'','password','maxlength="4096" autocomplete="new-password" placeholder="可选，留空保留现有值"')}</div>
        <div class="clp-actions"><label class="clp-check"><input type="checkbox" name="forcePathStyle" ${value.s3.forcePathStyle?'checked':''}>Path Style</label><label class="clp-check"><input type="checkbox" name="clearSessionToken">清除 Session Token</label><label class="clp-check"><input type="checkbox" name="clearCredentials">清除全部凭据</label><button type="button" class="button secondary" data-clp-test="s3">${icon('plug-zap')}测试连接</button></div><div id="clp-test-s3" class="cl-muted" role="status"></div></fieldset></div>
        <fieldset><legend>发送设置</legend><div class="cl-policy-grid">${field('maxAttempts','最大尝试次数',value.maxAttempts,'number','required min="1" max="10"')}${field('retrySeconds','首次重试间隔（秒）',value.retrySeconds,'number','required min="5" max="3600"')}${field('timeoutSeconds','发送超时（秒）',value.timeoutSeconds,'number','required min="3" max="60"')}${field('queueLimit','待发送任务上限',value.queueLimit,'number','required min="100" max="50000"')}</div>${toggle('allowPrivateNetwork','允许私有网络目标 / HTTP',value.allowPrivateNetwork)}</fieldset>
        <p class="cl-muted">每条数据包含请求 ID、请求正文和返回正文。压缩内容会解压；无法解码的字节以 data URI 保留。脱敏副本不可用时使用原文，可能含敏感信息，实际来源在本地推送记录中查看。关闭推送会暂停队列，已经发出的内容无法撤回。</p>
        <footer><button type="submit" class="button" id="clp-save">${icon('save')}保存推送策略</button><button type="button" class="button secondary" data-clp-action="discard">放弃更改</button><span id="clp-dirty" class="cl-muted"></span></footer></form>`;
      $('form').addEventListener('input',markDirty);$('form').addEventListener('change',markDirty);
      $('form').addEventListener('submit',event=>{event.preventDefault();run(save);});
      $('destinations').innerHTML=['webhook','s3'].map(target=>`<label><input type="checkbox" name="destination" value="${target}" ${value[target].enabled?'checked':'disabled'}>${target==='s3'?'S3': 'Webhook'}</label>`).join('');
      $('source').textContent=(value.source==='masked'?'脱敏优先，不可用则原文（可能含敏感信息）':'推送原文（可能含敏感信息）')+' · '+(value.captureScope==='all'?'包含传输未确认':'仅传输完整');
      updateControls();refreshIcons();
    }
    function markDirty() {dirty=true;clearPreview();updateControls();}
    function updateControls() {
      if(!$('form'))return;
      $('form').querySelectorAll('input,select,button').forEach(node=>{node.disabled=busy;});
      $('form').querySelectorAll('[data-clp-test]').forEach(node=>{node.disabled=busy||dirty||!policy[node.dataset.clpTest].enabled;});
      $('jsonl-options').hidden=$('form').elements.s3Format.value!=='jsonl';
      $('flush').disabled=busy||dirty||!policy.enabled||!policy.s3.enabled||policy.s3.format!=='jsonl';
      $('dirty').textContent=dirty?'有未保存的更改':'';
      $('preview').disabled=busy||dirty||!policy.enabled;
      if($('enqueue'))$('enqueue').disabled=busy||dirty||!$('acknowledge').checked;
    }
    function body() {
      const data=new FormData($('form')),text=name=>String(data.get(name)||''),yes=name=>data.has(name);
      return {version:policy.version,enabled:yes('enabled'),automatic:yes('automatic'),source:text('source'),captureScope:text('captureScope'),allowPrivateNetwork:yes('allowPrivateNetwork'),
        maxAttempts:Number(data.get('maxAttempts')),retrySeconds:Number(data.get('retrySeconds')),timeoutSeconds:Number(data.get('timeoutSeconds')),queueLimit:Number(data.get('queueLimit')),
        webhook:{enabled:yes('webhookEnabled'),url:text('webhookUrl'),token:text('webhookToken'),clearToken:yes('clearToken')},
        s3:{enabled:yes('s3Enabled'),endpoint:text('endpoint'),region:text('region'),bucket:text('bucket'),prefix:text('prefix'),forcePathStyle:yes('forcePathStyle'),
          accessKeyId:text('accessKeyId'),secretAccessKey:text('secretAccessKey'),sessionToken:text('sessionToken'),clearCredentials:yes('clearCredentials'),clearSessionToken:yes('clearSessionToken'),
          format:text('s3Format'),jsonl:{maxFileBytes:Math.round(Number(data.get('jsonlMaxGB'))*1e9),timezone:text('jsonlTimezone'),flushMinutes:Number(data.get('jsonlFlushMinutes')),uploadMiBPerSecond:Number(data.get('jsonlUploadRate'))}}};
    }
    async function save() {
      if(busy)return;
      const input=body(),current=epoch;busy=true;updateControls();message();
      try {
        const value=await api(base+'policy',{method:'PUT',body:JSON.stringify(input),signal:controller.signal});
        if(current!==epoch||!isActive())return;dirty=false;clearPreview();renderPolicy(value);message('推送策略已保存');await refreshJobs();
      } finally {if(current===epoch){busy=false;updateControls();}}
    }
    function selection() {
      const data=new FormData($('history')),filter={};
      for(const key of ['search','start','end','user_id','key_id','protocol','capture'])if(data.get(key))filter[key]=String(data.get(key));
      return {filter,destinations:data.getAll('destination')};
    }
    function clearPreview() {preview=null;batchBody=null;if($('preview-result'))$('preview-result').innerHTML='';}
    async function previewBatch() {
      if(busy||dirty||!policy.enabled)return;
      const input=selection(),current=epoch;busy=true;updateControls();message();
      try {
        const value=await api(base+'preview',{method:'POST',body:JSON.stringify(input),signal:controller.signal});
        if(current!==epoch||!isActive()||JSON.stringify(selection())!==JSON.stringify(input))return;
        preview=value;batchBody={...input,batchId:crypto.randomUUID(),previewToken:value.previewToken};
        $('preview-result').innerHTML=`<div class="clp-preview"><dl class="cl-facts">${[['匹配日志',value.matched],['可推送日志',value.eligible],['回退原文',value.fallbacks],['规则排除',value.excluded],['暂不可推送',value.unavailable],['已有任务',value.duplicates],['新增任务',value.jobs]].map(([label,count])=>`<div><dt>${label}</dt><dd>${number(count)}</dd></div>`).join('')}</dl>${value.jobs?`<label class="clp-check"><input type="checkbox" id="clp-acknowledge">确认将 ${number(value.eligible)} 条${policy.source==='original'?'原文':'脱敏优先（不可用则原文）'}日志推送至 ${input.destinations.map(target=>target==='s3'?'S3':'Webhook').join('、')}</label><div class="clp-actions"><button id="clp-enqueue" type="button" class="button" data-clp-action="enqueue" disabled>${icon('send')}加入推送队列</button></div>`:'<p class="cl-muted">没有需要新增的推送任务</p>'}</div>`;
        const unavailable=reasons(value.unavailableReasons);
        if(unavailable)$('preview-result').insertAdjacentHTML('beforeend',`<p class="cl-notice">${esc(unavailable)}</p>`);
        if(value.fallbacks)$('preview-result').insertAdjacentHTML('beforeend',`<p class="cl-notice amber">回退原文 ${number(value.fallbacks)} 条，可能含敏感信息。${esc(reasons(value.fallbackReasons))}</p>`);
        $('acknowledge')?.addEventListener('change',updateControls);refreshIcons();
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
    function renderFile(file) {
      const uploaded=file.status==='sent'?file.bytes:Math.min(file.bytes,file.uploaded_bytes||0);
      const paused=file.pause_reason==='archive_busy'?'采集优先，上传暂缓':!policy.enabled||!policy.s3.enabled?'推送已暂停':'';
      return `<tr><td><strong>${esc(file.model||'未提供模型')}</strong><small>${esc(file.day)}</small></td><td><code class="clp-object-key">${esc(file.object_key)}</code></td><td>${number(file.records)} 条<small>${esc(size(file.bytes))}</small><progress class="clp-progress" max="${file.bytes||1}" value="${uploaded}" aria-label="已确认上传进度"></progress><small>${esc(size(uploaded))} / ${esc(size(file.bytes))} · ${number(file.uploaded_parts)} 个分片</small></td><td><span class="cl-badge ${file.status==='sent'?'green':['failed','cancelled'].includes(file.status)?'amber':''}">${fileStates[file.status]||esc(file.status)}</span><small>${esc(['sent','cancelled'].includes(file.status)?'':paused)}</small><small>${esc(errors[file.error_code]||file.error_code||'')}</small></td><td>${file.status==='failed'?tool('rotate-cw','继续上传此 JSONL 文件',`data-clp-file-retry="${esc(file.id)}"`):''}</td></tr>`;
    }
    function renderJobs(value) {
      const files=value.jsonl?.files||[];
      $('files-section').hidden=!files.length&&policy?.s3.format!=='jsonl';
      const backlog=value.jsonl?.backlog;
      $('backlog').textContent=backlog?.files?`待上传 ${number(backlog.files)} 个文件 · ${number(backlog.records)} 条 · ${size(backlog.bytes)}${backlog.expiryAt?' · 最早归档到期 '+time(backlog.expiryAt):''}${backlog.atRisk?' · 6 小时内有归档到期风险':''}`:'暂无待上传积压';
      $('backlog').classList.toggle('amber',Boolean(backlog?.atRisk));
      $('files').innerHTML=files.length?`<div class="table-wrap clp-table"><table><thead><tr><th>模型 / 日期</th><th>文件</th><th>日志 / 上传进度</th><th>状态</th><th></th></tr></thead><tbody>${files.map(renderFile).join('')}</tbody></table></div>`:'<div class="cl-empty">暂无 JSONL 文件</div>';
      const skipped=reasons(Object.fromEntries((value.skipped||[]).map(row=>[row.code,row.count])));
      const fallbacks=reasons(Object.fromEntries((value.fallbacks||[]).map(row=>[row.code,row.count])));
      $('skipped').textContent=[fallbacks?'本策略自动入队已回退原文（可能含敏感信息）：'+fallbacks:'',skipped?'本策略自动扫描已跳过：'+skipped:''].filter(Boolean).join('；');
      $('counts').innerHTML=Object.entries(states).map(([state,label])=>`<span>${label}<strong>${number(value.counts.find(row=>row.status===state)?.count)}</strong></span>`).join('');
      $('jobs').innerHTML=value.items.length?`<div class="table-wrap clp-table"><table><thead><tr><th>日志 / 模型</th><th>目标 / 副本策略</th><th>状态 / 尝试</th><th>最近结果</th><th>更新时间</th><th></th></tr></thead><tbody>${value.items.map(row=>`<tr><td><strong>${esc(row.model||'未提供模型')}</strong><small>用户 #${row.user_id} · ${esc(row.record_id.slice(0,12))}</small></td><td>${row.destination==='s3'?'S3':'Webhook'}<small>${esc(copyLabel(row))}</small></td><td><span class="cl-badge ${row.status==='sent'?'green':['failed','cancelled'].includes(row.status)?'amber':''}">${states[row.status]}</span><small>${row.attempts} 次尝试</small></td><td>${esc(errors[row.error_code]||row.error_code|| (row.status==='sent'?'送达成功':'—'))}${row.http_status?`<small>HTTP ${row.http_status}</small>`:''}${row.status==='pending'&&row.attempts?`<small>下次 ${esc(time(row.next_at))}</small>`:''}</td><td>${esc(time(row.updated_at))}<small><code>${esc(row.id.slice(0,12))}</code></small></td><td>${['failed','cancelled'].includes(row.status)?tool('rotate-cw','重试此推送',`data-clp-retry="${row.id}" ${actions.has(row.id)?'disabled':''}`):''}</td></tr>`).join('')}</tbody></table></div>`:'<div class="cl-empty">暂无推送任务</div>';
      $('pages').textContent=`${number(value.total)} 个任务 · ${page} / ${Math.max(1,value.pages)} 页`;
      $('prev').disabled=page<=1;$('next').disabled=page>=value.pages;
      $('batches').innerHTML=value.batches.length?`<div class="cl-section-heading"><h2>最近批次</h2></div><div class="clp-batches">${value.batches.map(row=>`<div><code>${esc(row.id)}</code><span>${esc(time(row.created_at))} · ${number(row.created)} 个任务</span>${tool('square','取消此批次未完成推送',`data-clp-cancel="${row.id}" ${actions.has(row.id)?'disabled':''}`)}</div>`).join('')}</div>`:'';
      refreshIcons();
    }
    async function refreshJobs() {
      if(!isActive()||!mounted)return;
      const current=epoch,seq=++jobsSeq;jobsController?.abort();jobsController=new AbortController();
      const value=await api(base+'jobs?'+new URLSearchParams({page:String(page),status:$('job-status').value}),{signal:jobsController.signal});
      if(current!==epoch||seq!==jobsSeq||!isActive())return;renderJobs(value);
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
    function click(event) {
      const node=event.target.closest('button');if(!node||node.disabled)return;
      const d=node.dataset;if(d.clpTest)return run(()=>testTarget(d.clpTest));if(d.clpRetry)return run(()=>jobAction('retry',d.clpRetry));if(d.clpCancel)return run(()=>jobAction('cancel',d.clpCancel));
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
      await refreshJobs();
      if(!timer)timer=setInterval(()=>run(refreshJobs),5000);
    }
    function leave() {
      ++epoch;++jobsSeq;controller?.abort();jobsController?.abort();clearInterval(timer);timer=null;
      policy=null;dirty=false;busy=false;mounted=false;preview=null;batchBody=null;actions.clear();container.innerHTML='';page=1;
    }
    container.addEventListener('click',click);
    return {load,leave};
  }
  root.ConversationPushUi={create};
})(window);
