(function(root) {
  'use strict';
  const preset=[['gpt-6-astra','40000'],['gpt-6.1-sol','40000'],['gpt-6.2-astra','40000'],['gpt-6.2-sol','40000'],['claude-opus-5-5','80000'],['claude-opus-5','50000'],['fable-5','60000'],['fable-5-1','80000'],['fable-5-2','100000']];
  const all=value=>[{...value.webhook,id:'webhook',type:'webhook'},{...value.s3,id:'s3',type:'s3'},...(value.platforms||[])];
  const configured=row=>row.enabled||row.url||row.endpoint;
  function create({container,escapeHtml:esc,icon,refreshIcons,onChange,onSave}) {
    let policy=null,editing='',amounts=new Map();
    const $=id=>container.querySelector('#clpp-'+id);
    const copy=value=>JSON.parse(JSON.stringify(value));
    const current=()=>all(policy).find(row=>row.id===editing);
    const tool=(name,label,attrs)=>`<button type="button" class="icon-button" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${icon(name)}</button>`;
    const field=(name,label,value='',type='text',attrs='')=>`<label>${label}<input name="platform${name}" value="${esc(value)}" type="${type}" ${attrs}></label>`;
    const select=(name,label,options)=>`<label>${label}<select name="platform${name}">${options}</select></label>`;
    const check=(name,label,value)=>`<label class="clp-check"><input name="platform${name}" type="checkbox" ${value?'checked':''}>${label}</label>`;
    function replace(row) {if(row.id==='s3'||row.id==='webhook'){const {id,type,...value}=row;policy[id]=value;}else policy.platforms=policy.platforms.map(item=>item.id===row.id?row:item);}
    function read() {
      if(!editing||!$('editor')?.childElementCount)return;
      const row=current(),input=name=>$('editor').querySelector(`[name="platform${name}"]`),text=name=>input(name)?.value||'';
      row.name=text('Name').trim();row.enabled=input('Enabled').checked;row.billing.enabled=input('Billing').checked;
      row.billing.rates=[...$('rates').querySelectorAll('tr')].map(tr=>({model:tr.querySelector('[data-model]').value.trim(),price:tr.querySelector('[data-price]').value.trim()}));
      if(row.type==='webhook'){row.url=text('Url').trim();row.token=text('Token');row.clearToken=input('ClearToken').checked;}
      else{
        Object.assign(row,{endpoint:text('Endpoint').trim(),bucket:text('Bucket').trim(),region:text('Region').trim(),prefix:text('Prefix').trim(),format:text('Format'),
          accessKeyId:text('AccessKey'),secretAccessKey:text('SecretKey'),sessionToken:text('SessionToken'),clearCredentials:input('ClearCredentials').checked,clearSessionToken:input('ClearSessionToken').checked,
          forcePathStyle:input('PathStyle').checked,jsonl:{maxFileBytes:Math.round(Number(text('MaxGB'))*1e9),timezone:text('Timezone'),flushMinutes:Number(text('FlushMinutes')),uploadMiBPerSecond:Number(text('Rate')),cleanupBatchMiB:Number(text('CleanupBatchMiB')),streamingUpload:input('StreamingUpload').checked}});
      }
      replace(row);
    }
    function availability() {
      const button=container.querySelector('[data-clpp-add]'),limited=configured(policy[$('type').value])&&policy.platforms.length>=18;
      button.dataset.clppLimited=String(limited);button.disabled=limited;button.title=limited?'最多添加 18 个附加平台':'';
    }
    function rows() {
      $('rows').innerHTML=all(policy).filter(configured).map(row=>`<tr><td><label class="clp-check"><input type="checkbox" aria-label="启用 ${esc(row.name)}" data-clpp-toggle="${esc(row.id)}" ${row.enabled?'checked':''}></label></td><td><strong>${esc(row.name)}</strong><small>${row.type==='s3'?'S3 兼容存储':'Webhook'} · ${esc(row.bucket||row.url||'未配置')}</small><small id="clp-test-${esc(row.id)}" role="status"></small></td><td>${row.type==='s3'?esc(row.format.toUpperCase()):'JSON'}</td><td><button type="button" class="clpp-price-link" data-clpp-edit="${esc(row.id)}">${row.billing.enabled?`${row.billing.rates.length} 个模型 · v${row.billing.version}`:'未启用计费'}</button></td><td class="clp-money">${amounts.has(row.id)?'¥'+Number(amounts.get(row.id)).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}</td><td><div class="clp-actions">${tool('settings-2','编辑 '+row.name,`data-clpp-edit="${esc(row.id)}"`)}${tool('plug-zap','测试 '+row.name,`data-clp-test="${esc(row.id)}"`)}${tool('trash-2','删除 '+row.name,`data-clpp-remove="${esc(row.id)}"`)}</div></td></tr>`).join('')||'<tr><td colspan="6" class="cl-muted">暂无推送平台</td></tr>';
      availability();refreshIcons();
    }
    function priceRows() {
      $('rates').innerHTML=current().billing.rates.map((row,i)=>`<tr><td><input data-model value="${esc(row.model)}" aria-label="第 ${i+1} 行模型名称" maxlength="160" required></td><td><input data-price type="number" value="${esc(row.price)}" aria-label="第 ${i+1} 行元每 TB 单价" min="0" max="999999999.9999" step="0.0001" required></td><td>${tool('trash-2','删除第 '+(i+1)+' 行定价',`data-clpp-rate-remove="${i}"`)}</td></tr>`).join('');refreshIcons();
    }
    function edit(id) {
      read();editing=id;const row=current(),s3=row.type==='s3';
      $('editor').hidden=false;
      $('editor').innerHTML=`<div class="cl-section-heading"><h2>编辑平台 · ${esc(row.name)}</h2>${tool('x','关闭平台编辑','data-clpp-close')}</div><div class="clp-fields"><div class="clp-pair">${field('Name','平台名称',row.name,'text','required maxlength="80"')}${select('Type','协议',`<option value="${row.type}">${s3?'S3 兼容存储':'Webhook'}</option>`)}</div>${s3?`${field('Endpoint','Endpoint',row.endpoint,'url','required maxlength="2048"')}<div class="clp-pair">${field('Bucket','Bucket',row.bucket,'text','required maxlength="63"')}${field('Region','Region',row.region,'text','required maxlength="64"')}</div>${field('Prefix','对象前缀',row.prefix,'text','maxlength="180"')}${select('Format','文件格式',`<option value="jsonl" ${row.format==='jsonl'?'selected':''}>JSONL · 按日期和模型汇总</option><option value="json" ${row.format==='json'?'selected':''}>JSON · 每条日志一个文件</option>`)}<div class="clp-pair">${field('MaxGB','单文件上限（GB）',row.jsonl.maxFileBytes/1e9,'number','required min="0.01" max="10" step="0.01"')}${field('Timezone','归档日期时区',row.jsonl.timezone,'text','required maxlength="80"')}${field('FlushMinutes','定时上传间隔（分钟，0 为每日）',row.jsonl.flushMinutes,'number','required min="0" max="1440"')}${field('Rate','上传限速（MiB/s）',row.jsonl.uploadMiBPerSecond,'number','required min="0.25" max="64" step="0.25"')}${field('CleanupBatchMiB','本地清理批次（MiB）',row.jsonl.cleanupBatchMiB,'number','required min="32" max="64" step="1"')}</div><div class="clp-actions">${check('StreamingUpload','边汇总边上传（安全模式）',row.jsonl.streamingUpload)}</div><p class="cl-muted">开启后达到完整分片就开始上传，文件仍会继续汇总；只有整个文件 Complete 且所有目标送达后才清理本地日志。不会因接近容量上限自动封卷。</p><div class="clp-pair">${field('AccessKey','Access Key','','password',`autocomplete="new-password" maxlength="4096" placeholder="${row.credentialsConfigured?'已设置，留空保留':'未设置'}"`)}${field('SecretKey','Secret Key','','password','autocomplete="new-password" maxlength="4096" placeholder="留空保留"')}</div>${field('SessionToken','Session Token','','password','autocomplete="new-password" maxlength="4096" placeholder="可选，留空保留"')}<div class="clp-actions">${check('PathStyle','Path Style',row.forcePathStyle)}${check('ClearCredentials','清除全部凭据',false)}${check('ClearSessionToken','清除 Session Token',false)}</div>`:`${field('Url','接收 URL',row.url,'url','required maxlength="2048"')}${field('Token','Bearer Token','','password','autocomplete="new-password" maxlength="4096" placeholder="留空保留"')}${check('ClearToken','清除现有 Token',false)}`}${check('Enabled','启用平台',row.enabled)}</div>
        <div class="clpp-pricing"><div class="cl-section-heading"><h2>模型存储定价</h2>${check('Billing','启用计费',row.billing.enabled)}</div><div class="clp-actions"><span class="cl-muted">人民币 / TB · 精确匹配模型名 · 0 表示免费</span><button type="button" class="button secondary" data-clpp-add-rate>${icon('plus')}添加模型</button></div><div class="table-wrap"><table class="clpp-rates"><thead><tr><th>模型名称</th><th>单价（元 / TB）</th><th></th></tr></thead><tbody id="clpp-rates"></tbody></table></div><p class="cl-muted">新价格用于后续确认送达的数据，已计费记录保留原单价；缺少单价的成功数据标记为待定价。</p></div><div class="clp-actions"><button type="button" class="button" data-clpp-save>${icon('save')}保存平台与策略</button></div>`;
      for(const [name,key] of [['AccessKey','accessKeyId'],['SecretKey','secretAccessKey'],['SessionToken','sessionToken'],['Token','token']]){
        const input=$('editor').querySelector(`[name="platform${name}"]`);if(input)input.value=row[key]||'';
      }
      for(const [name,key] of [['ClearCredentials','clearCredentials'],['ClearSessionToken','clearSessionToken'],['ClearToken','clearToken']]){
        const input=$('editor').querySelector(`[name="platform${name}"]`);if(input)input.checked=Boolean(row[key]);
      }
      priceRows();refreshIcons();
    }
    function add(type) {
      read();
      if(configured(policy[type])&&policy.platforms.length>=18)return;
      const primary=policy[type],id=!configured(primary)?type:'platform-'+crypto.randomUUID();
      const common={id,type,name:type==='s3'?'新 S3 平台':'新 Webhook 平台',enabled:true,billing:{enabled:true,version:1,rates:preset.map(([model,price])=>({model,price}))}};
      const row=type==='s3'?{...common,endpoint:'',region:'us-east-1',bucket:'',prefix:'conversation-logs',forcePathStyle:true,format:'jsonl',jsonl:{maxFileBytes:1e10,timezone:'Asia/Shanghai',flushMinutes:0,uploadMiBPerSecond:2,cleanupBatchMiB:48,streamingUpload:false}}:{...common,url:''};
      if(id===type)replace(row);else policy.platforms.push(row);rows();edit(id);onChange();
    }
    function clean(row,extra=false) {
      const keys=row.type==='s3'?['enabled','name','billing','endpoint','region','bucket','prefix','forcePathStyle','accessKeyId','secretAccessKey','sessionToken','clearCredentials','clearSessionToken','format','jsonl']:['enabled','name','billing','url','token','clearToken'];
      return {...(extra?{id:row.id,type:row.type}:{}),...Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))};
    }
    function body() {
      read();const list=all(policy);
      for(const row of list){const models=row.billing.rates.map(rate=>rate.model);if(new Set(models).size!==models.length)throw new Error('同一平台不能重复配置同名模型');}
      return {webhook:clean(list.find(row=>row.id==='webhook')),s3:clean(list.find(row=>row.id==='s3')),platforms:policy.platforms.map(row=>clean(row,true))};
    }
    container.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.hasAttribute('data-clpp-add'))add($('type').value);
      if(button.dataset.clppEdit)edit(button.dataset.clppEdit);
      if(button.hasAttribute('data-clpp-close')){read();editing='';$('editor').innerHTML='';$('editor').hidden=true;rows();}
      if(button.hasAttribute('data-clpp-add-rate')){read();const row=current();row.billing.rates.push({model:'',price:''});replace(row);priceRows();$('rates').lastElementChild.querySelector('input').focus();onChange();}
      if(button.dataset.clppRateRemove!==undefined){read();const row=current();row.billing.rates.splice(Number(button.dataset.clppRateRemove),1);replace(row);priceRows();onChange();}
      if(button.dataset.clppRemove){read();const id=button.dataset.clppRemove;if(id==='s3'||id==='webhook'){const row=all(policy).find(item=>item.id===id);Object.assign(row,{enabled:false,...(id==='s3'?{endpoint:'',bucket:'',clearCredentials:true}:{url:'',clearToken:true})});replace(row);}else policy.platforms=policy.platforms.filter(row=>row.id!==id);editing='';$('editor').innerHTML='';$('editor').hidden=true;rows();onChange();}
      if(button.hasAttribute('data-clpp-save'))onSave();
    });
    container.addEventListener('change',event=>{if(event.target.id==='clpp-type')availability();if(event.target.dataset.clppToggle){read();const row=all(policy).find(item=>item.id===event.target.dataset.clppToggle);row.enabled=event.target.checked;replace(row);if(editing===row.id)$('editor').querySelector('[name="platformEnabled"]').checked=row.enabled;onChange();}});
    return {
      render(value){policy=copy(value);policy.platforms ||= [];editing='';container.innerHTML=`<div class="cl-section-heading"><h2>推送平台</h2><div class="clp-actions"><select id="clpp-type" aria-label="新平台协议"><option value="s3">S3 兼容存储</option><option value="webhook">Webhook</option></select><button type="button" class="button secondary" data-clpp-add>${icon('plus')}添加平台</button></div></div><div class="table-wrap"><table class="clpp-platform-table"><thead><tr><th>启用</th><th>平台 / 存储位置</th><th>格式</th><th>模型定价</th><th>已计费金额</th><th>操作</th></tr></thead><tbody id="clpp-rows"></tbody></table></div><p class="cl-muted">停用只影响后续入队，已有任务继续等待其目标完成；未完成的平台不能删除。</p><section id="clpp-editor" class="clpp-editor" hidden></section>`;rows();},
      body,all:()=>all(policy),
      amounts(value){amounts=new Map(value);if(policy)rows();},
      clear(){policy=null;editing='';amounts.clear();container.innerHTML='';}
    };
  }
  root.ConversationPlatformsUi={create,all};
})(window);
