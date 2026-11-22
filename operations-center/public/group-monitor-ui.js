(function (root) {
  'use strict';
  const labels = { ok:'请求正常', failed:'请求失败', waiting:'待检测', unconfigured:'未配置检测', empty:'无启用账号', paused:'分组已停用',
    running:'检测中', queued:'排队中', blocked:'检测受阻', cancelled:'已取消', completed:'已完成', stopping:'正在停止', interrupted:'已中断' };
  const codes = { GENERATED:'已收到有效生成文本', HTTP_ERROR:'主站返回 HTTP 错误', INVALID_GENERATION:'没有收到有效生成文本，或响应不是预期的模型协议',
    RESPONSE_TOO_LARGE:'响应超过检测大小上限', TIMEOUT:'请求超时', REQUEST_UNAVAILABLE:'连接失败或响应读取中断',
    KEY_GROUP_MISMATCH:'专用 Key 的分组归属、启用状态或有效期已变更，请重新配置', KEY_UNAVAILABLE:'无法解密专用 Key，请重新保存该组 Key', KEY_VERIFICATION_UNAVAILABLE:'暂时无法核验 Key，未发起模型请求',
    SITE_NOT_CONFIGURED:'未配置主站地址', CANCELLED:'本次请求已取消', SOURCE_CHANGED:'主站配置发生变化，本轮已中断', MONITOR_WORKER_FAILED:'巡检执行中断，请检查存储状态', MONITOR_STORE_UNAVAILABLE:'巡检记录保存失败，请检查存储状态' };
  const platforms = { anthropic:'Claude',openai:'OpenAI',gemini:'Gemini',antigravity:'Antigravity',grok:'Grok',composite:'合成分组' };
  const protocols = { auto:'按平台 / 模型自动选择',messages:'Anthropic Messages',responses:'OpenAI Responses',chat:'Chat Completions',gemini:'Gemini GenerateContent' };
  const activeRun = run => run && ['running','stopping','preparing'].includes(run.state);
  const tone = status => status === 'ok' ? 'gm-good' : ['failed','blocked'].includes(status) ? 'gm-bad' : ['waiting','unconfigured','empty','running'].includes(status) ? 'gm-warn' : '';
  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, setConnection, isActive }) {
    const $ = id => document.getElementById(`gm-${id}`), container = $('root');
    let report = null, findings = null, view = 'requests', page = 1, findingsPage = 1, pageSize = 20;
    let sequence = 0, lifetime = 0, detailSequence = 0, controller, detailController, actionController, timer, searchTimer, busy = false, detail = null;
    const number = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits:4 }).format(Number(value));
    const rate = value => value == null ? '未知' : `${number(value)}×`;
    const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone:report?.timezone || 'Asia/Shanghai', hour12:false }) : '尚无记录';
    const badge = status => `<span class="gm-badge ${tone(status)}">${esc(labels[status] || status)}</span>`;
    const facts = rows => `<dl class="gm-facts">${rows.map(([k,v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
    const table = (headers,rows,main=false) => `<div class="table-wrap"><table${main?' class="gm-main-table"':''}>${main?'<colgroup><col style="width:20%"><col style="width:18%"><col style="width:16%"><col style="width:14%"><col style="width:17%"><col style="width:15%"></colgroup>':''}<thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td class="gm-empty" colspan="${headers.length}">当前没有匹配的记录</td></tr>`}</tbody></table></div>`;
    function init() {
      container.innerHTML = `<div class="gm-actions gm-commands"><button id="gm-settings" class="button secondary" type="button">${icon('settings-2')}巡检设置</button><button id="gm-run-all" class="button primary" type="button">${icon('play')}立即巡检</button></div>
        <div id="gm-source" class="gm-source" role="status"></div><div id="gm-metrics" class="gm-metrics"></div>
        <div id="gm-attention" class="gm-notice" hidden>${icon('triangle-alert')}<span id="gm-attention-text"></span><button id="gm-open-anomalies" class="gm-link" type="button">查看异常列表 →</button></div>
        <div id="gm-progress" class="gm-progress" role="status" hidden><div class="gm-heading"><span id="gm-progress-text"></span><button id="gm-stop" class="gm-link" type="button">停止本轮</button></div><div class="gm-track" role="progressbar" aria-label="本轮巡检进度" aria-valuemin="0" aria-valuemax="100"><div id="gm-progress-bar"></div></div></div>
        <p id="gm-run-summary" class="gm-muted"></p>
        <div class="gm-tabs" role="tablist" aria-label="监控内容"><button id="gm-tab-requests" type="button" role="tab" aria-controls="gm-requests" aria-selected="true">${icon('activity')}分组请求</button><button id="gm-tab-anomalies" type="button" role="tab" aria-controls="gm-anomalies" aria-selected="false" tabindex="-1">${icon('badge-alert')}倍率异常 <span id="gm-anomaly-count" class="gm-risk-count">0</span></button></div>
        <section id="gm-requests" role="tabpanel" aria-labelledby="gm-tab-requests"><div class="gm-heading"><h2>请求可用性</h2><span id="gm-schedule" class="gm-muted"></span></div>
          <div class="gm-toolbar"><label class="gm-search">搜索分组 / 检测模型<input id="gm-search" type="search" maxlength="120" placeholder="分组名称、ID 或模型"></label><label>平台<select id="gm-platform"><option value="all">全部平台</option></select></label><label>请求状态<select id="gm-status"><option value="all">全部状态</option>${['ok','failed','blocked','waiting','unconfigured','empty','paused','cancelled'].map(v=>`<option value="${v}">${labels[v]}</option>`).join('')}</select></label></div>
          <div id="gm-group-table"></div><div id="gm-group-pages" class="gm-pagination"></div>
          <p class="gm-footnote">每组使用指定模型与分组专用 Key，经过主站路由发起生成请求，按主站规则计入该 Key 的正常用量。单组通过代表本次路由可用；倍率检查覆盖全部启用账号。</p></section>
        <section id="gm-anomalies" role="tabpanel" aria-labelledby="gm-tab-anomalies" hidden><div class="gm-heading"><div><h2>账号倍率高于所属分组</h2><p class="gm-muted">按账号启用状态逐组比较；倍率相等不报异常，倍率缺失列入待核验。</p></div><button id="gm-rescan" type="button" class="button secondary">${icon('refresh-cw')}重新核验</button></div>
          <div class="gm-toolbar"><label class="gm-search">搜索账号 / 分组<input id="gm-findings-search" type="search" maxlength="120" placeholder="账号名称、ID 或分组"></label><label>记录范围<select id="gm-scope"><option value="current">当前异常</option><option value="unknown">待核验</option><option value="history">已恢复记录</option></select></label></div><p id="gm-audit-summary" class="gm-muted"></p><div id="gm-findings-table"></div><div id="gm-findings-pages" class="gm-pagination"></div>
          <p class="gm-footnote">倍率核验每分钟自动读取一次。仅 status=active 的账号参与，调度开关单独展示；分组停用不排除该组启用账号。比较分组默认文本倍率，不混入用户专属、高峰、图片或视频倍率；历史记录保留 30 天。</p></section>
        <dialog id="gm-dialog" class="gm-dialog" aria-labelledby="gm-dialog-title"><header><div><h2 id="gm-dialog-title"></h2><p id="gm-dialog-subtitle" class="gm-muted"></p></div><button id="gm-close" type="button" class="icon-button" aria-label="关闭详情" title="关闭">${icon('x')}</button></header><div id="gm-dialog-body" class="gm-dialog-body"></div><footer id="gm-dialog-footer"></footer></dialog>`;
      $('dialog').addEventListener('close', () => { ++detailSequence; detailController?.abort(); detail=null; $('dialog-body').innerHTML=''; $('dialog-footer').innerHTML=''; });
      refreshIcons();
    }
    function runAction(task) { task().catch(error=>{if(error.name!=='AbortError'&&isActive())toast(error.message,'error');}); }
    function setView(next) { view=next; for(const name of ['requests','anomalies']) { $(`tab-${name}`).setAttribute('aria-selected',String(view===name)); $(`tab-${name}`).tabIndex=view===name?0:-1; $(name).hidden=view!==name; } runAction(()=>load()); }
    function pagination(target,data,kind) {
      $(target).innerHTML = `<span>共 ${data.total} 条 · ${data.page} / ${data.pages} 页</span><select data-gm-size aria-label="每页记录数">${[10,20,50,100].map(v=>`<option value="${v}" ${pageSize===v?'selected':''}>${v} 条 / 页</option>`).join('')}</select><button type="button" class="icon-button" data-gm-page="${data.page-1}" data-gm-kind="${kind}" ${data.page<=1?'disabled':''} aria-label="上一页" title="上一页">${icon('chevron-left')}</button><button type="button" class="icon-button" data-gm-page="${data.page+1}" data-gm-kind="${kind}" ${data.page>=data.pages?'disabled':''} aria-label="下一页" title="下一页">${icon('chevron-right')}</button>`;
    }
    function renderGroups() {
      $('group-table').innerHTML = table(['分组 / 平台','检测模型','最近请求 / 10 次','耗时 / HTTP','启用账号 / 倍率','操作'],report.items.map(g=>{
        const history=report.histories[g.id] || [], bars=history.slice(0,10).reverse();
        return `<tr data-gm-group-row="${esc(g.id)}"><td><button type="button" class="gm-link" data-gm-group="${esc(g.id)}"><strong>${esc(g.name)}</strong></button><small>#${esc(g.id)} · ${esc(platforms[g.platform]||g.platform)} · 分组 ${rate(g.rate)}</small></td><td data-label="检测模型">${esc(g.profile.model||'未选择模型')}<small>${g.profile.keyConfigured?'专用 Key 已配置':'未配置专用 Key'}</small></td><td data-label="最近请求">${badge(g.status)}<div class="gm-bars" role="img" aria-label="最近 ${bars.length} 次请求，${bars.filter(r=>r.status==='ok').length} 次成功">${(bars.length?bars:Array(10).fill({status:'unknown'})).map(r=>`<span class="${r.status==='ok'?'':r.status==='failed'?'gm-failed':'gm-skipped'}"></span>`).join('')}</div></td><td data-label="耗时 / HTTP"><span class="gm-number">${g.result?`${(g.result.elapsedMs/1000).toFixed(2)} s`:'—'}</span><small>${g.result?.httpStatus?`HTTP ${g.result.httpStatus}`:g.result?esc(codes[g.result.code]||g.result.code):'尚无当前配置结果'}</small>${g.result?`<small>${esc(time(g.result.at))}</small>`:''}</td><td data-label="启用账号 / 倍率">${g.enabledAccounts} / ${g.accountCount}<small>${g.anomalyCount?`<button type="button" class="gm-link" data-gm-risk="${esc(g.name)}">${g.anomalyCount} 条倍率异常</button>`:g.unknownCount?`${g.unknownCount} 项待核验`:g.enabledAccounts?'倍率正常':'无可核验账号'}</small></td><td><div class="gm-actions"><button type="button" class="gm-link" data-gm-group="${esc(g.id)}">详情</button><button type="button" class="gm-link" data-gm-retest="${esc(g.id)}" ${busy||activeRun(report.run)||['paused','empty','unconfigured'].includes(g.status)?'disabled':''}>${icon('rotate-cw')}重测</button></div></td></tr>`;
      }).join(''),true); pagination('group-pages',report,'groups');
    }
    function renderFindings() {
      if(!findings)return;
      $('audit-summary').textContent=`全部 ${findings.groups} 个分组 · ${findings.enabledAccounts} 个启用账号 / ${findings.enabledMemberships} 个分组关联 · 核验于 ${time(findings.source.at)}`;
      $('findings-table').innerHTML=table(['上游账号','所属分组','账号 / 分组倍率','超出幅度 / 状态','发现 / 核验','操作'],findings.items.map(f=>`<tr data-gm-finding-row="${esc(f.id)}"><td><strong>${esc(f.accountName)}</strong><small>账号 #${esc(f.accountId)} · ${f.state==='open'?'已启用':'历史记录'}</small></td><td>${esc(f.groupName)}<small>分组 #${esc(f.groupId)}${f.groupStatus!=='active'?' · 分组已停用':''}</small></td><td data-label="账号 / 分组倍率"><span class="gm-number ${f.kind==='higher'&&f.state==='open'?'gm-bad':''}">${rate(f.accountRate)} / ${rate(f.groupRate)}</span></td><td data-label="超出幅度 / 状态">${f.state==='resolved'?'<span class="gm-badge gm-good">已解除</span>':f.kind==='unknown'?'<span class="gm-badge gm-warn">倍率待核验</span>':`<strong class="gm-bad">${f.excessPercent==null?'分组倍率为 0':`+${number(f.excessPercent)}%`}</strong><small>差值 +${rate(f.difference)}</small>`}</td><td data-label="发现 / 核验">${esc(time(f.firstAt))}<small>${f.state==='resolved'?'解除':'复核'} ${esc(time(f.resolvedAt||f.lastAt))}</small></td><td><button type="button" class="gm-link" data-gm-finding="${esc(f.id)}">查看记录</button></td></tr>`).join(''),true);pagination('findings-pages',findings,'findings');
    }
    function render() {
      const s=report.summary,r=report.run;
      $('metrics').innerHTML=[['全部分组',s.groups,`${s.activeGroups} 启用 · ${s.groups-s.activeGroups} 停用`,''],['请求正常',s.ok,'最近一次生成成功','gm-good'],['请求失败',s.failed,'请求错误 / 检测受阻','gm-bad'],['尚未检测',s.pending,'待检测 / 配置缺失','gm-warn'],['倍率异常',s.anomalies,`${s.anomalyGroups} 组 · 待核验 ${s.unknown} 项`,'gm-bad']].map(([label,value,note,cls])=>`<div><span>${label}</span><strong class="${cls}" data-gm-metric="${label}">${value}</strong><small>${note}</small></div>`).join('');
      $('source').innerHTML=report.source.ready?'':`<div class="alert warning">${esc(report.source.error|| (report.source.stale?'分组快照已过期':'尚未取得分组快照'))}<p>${report.source.at?`保留上次核验结果：${esc(time(report.source.at))}。`:'请核对主站只读数据库连接和读取权限。'} 数据读取恢复前不会将旧异常自动标为已恢复。</p></div>`;
      $('attention').hidden=!s.anomalies;$('attention-text').textContent=`发现 ${s.anomalies} 条启用账号倍率高于分组的记录，涉及 ${s.anomalyGroups} 个分组。`;$('anomaly-count').textContent=s.anomalies;
      $('progress').hidden=!activeRun(r);
      if(activeRun(r)) {const percent=r.total?Math.round(r.done/r.total*100):0;$('progress-text').textContent=`${r.state==='stopping'?'正在停止':'本轮巡检'} · ${r.done} / ${r.total} 完成 · ${r.skipped} 组未发起请求`;$('progress-bar').style.width=`${percent}%`;$('progress-bar').parentElement.setAttribute('aria-valuenow',String(percent));}
      $('stop').disabled=busy||r?.state==='stopping';$('settings').disabled=busy||activeRun(r);$('run-all').disabled=busy||activeRun(r)||!report.source.ready;
      $('rescan').disabled=busy;
      $('run-summary').textContent=r&&!activeRun(r)?`上轮${labels[r.state]||r.state} · ${r.done}/${r.total} 完成 · ${r.ok} 正常 · ${r.failed} 失败 / 受阻 · ${r.cancelled} 取消 · ${r.skipped} 跳过${r.error?' · '+(codes[r.error]||r.error):''} · ${time(r.finishedAt)}`:'';
      $('schedule').textContent=report.policy.automatic?`自动请求巡检 · 每 ${report.policy.intervalMinutes} 分钟${report.nextAt?' · 下次 '+time(report.nextAt):''}`:'自动请求巡检已关闭';
      const current=$('platform').value, options='<option value="all">全部平台</option>'+report.platforms.map(p=>`<option value="${esc(p)}">${esc(platforms[p]||p)}</option>`).join('');
      if($('platform').innerHTML!==options){$('platform').innerHTML=options;$('platform').value=report.platforms.includes(current)?current:'all';}
      renderGroups();renderFindings();refreshIcons();setPageMeta(`全部 ${s.groups} 个分组 · 最近核验 ${time(report.source.at)}`);setConnection(report.source.ready,report.source.ready?'分组数据正常':'分组数据待更新');
    }
    async function load() {
      if(!isActive())return;
      if(!$('dialog'))init();
      const seq=++sequence;controller?.abort();controller=new AbortController();clearTimeout(timer);const signal=controller.signal;
      try {
        const query=new URLSearchParams({search:$('search').value,platform:$('platform').value,status:$('status').value,page,pageSize});
        const next=await api(`/api/group-monitor?${query}`,{signal});
        const nextFindings=view==='anomalies'?await api(`/api/group-monitor/findings?${new URLSearchParams({search:$('findings-search').value,scope:$('scope').value,page:findingsPage,pageSize})}`,{signal}):null;
        if(!isActive()||seq!==sequence)return;report=next;page=next.page;findings=nextFindings;if(findings)findingsPage=findings.page;render();
      } catch(error) {if(error.name==='AbortError'||seq!==sequence||!isActive())return;setConnection(false,'读取失败');$('source').innerHTML=`<div class="alert error">${esc(error.message)}；当前列表可能已过期。</div>`;throw error;}
      finally {if(seq===sequence&&isActive()&&!document.hidden)timer=setTimeout(()=>runAction(()=>load()),activeRun(report?.run)?1200:15000);}
    }
    function openDialog(title,subtitle,body,footer) {
      $('dialog-title').textContent=title;$('dialog-subtitle').textContent=subtitle;$('dialog-body').innerHTML=body;$('dialog-footer').innerHTML=footer;
      if(!$('dialog').open)$('dialog').showModal();refreshIcons();
    }
    const closeButton=()=>'<button type="button" class="button secondary" data-gm-close>关闭</button>';
    function showGroup(g) {
      detail=g;const eligible=!['paused','empty','unconfigured'].includes(g.status),result=g.result;
      openDialog(g.name,`分组 #${g.id} · ${platforms[g.platform]||g.platform} · ${g.groupStatus==='active'?'已启用':'已停用'}`,
        facts([['分组倍率',rate(g.rate)],['启用 / 全部账号',`${g.enabledAccounts} / ${g.accountCount}`],['当前请求状态',labels[g.status]||g.status]])+
        `<div class="gm-result ${tone(g.status)}"><strong>${esc(result?(codes[result.code]||result.code):labels[g.status])}${result?.httpStatus?' · HTTP '+result.httpStatus:''}</strong><p>${result?esc(time(result.at))+' · '+(result.elapsedMs/1000).toFixed(2)+' s':'当前配置尚无检测结果'}${result?.requestId?' · 请求 ID '+esc(result.requestId):''}</p>${g.previousResult?`<p>此前参数的检测结果保留在历史中，未计作当前配置通过。</p>`:''}</div>
        <div><h3>全部上游账号</h3>${table(['账号','状态 / 调度','账号倍率','比较结果'],g.accounts.map(a=>`<tr><td>${esc(a.name)}<small>#${esc(a.id)}</small></td><td>${esc(a.status==='active'?'已启用':a.status)}<small>${a.schedulable?'调度开启':'调度关闭'}</small></td><td>${rate(a.rate)}</td><td><span class="gm-badge ${a.comparison==='higher'?'gm-bad':a.comparison==='unknown'?'gm-warn':a.comparison==='normal'?'gm-good':''}">${a.comparison==='higher'?'高于分组':a.comparison==='unknown'?'待核验':a.comparison==='normal'?'不高于分组':'不参与'}</span></td></tr>`).join(''))}</div>
        <div><h3>检测参数</h3><div class="gm-form-grid"><label>检测模型<input id="gm-model" value="${esc(g.profile.model)}" maxlength="120" placeholder="该组可用的模型名"></label><label>请求协议<select id="gm-protocol">${Object.entries(protocols).map(([v,l])=>`<option value="${v}" ${g.profile.protocol===v?'selected':''}>${l}</option>`).join('')}</select></label><label>分组专用 Key ${g.profile.keyConfigured?'· 已配置':''}<input id="gm-key" type="password" autocomplete="new-password" maxlength="1024" placeholder="${g.profile.keyConfigured?'留空保留现有 Key':'输入仅属于此组的 Key'}"></label><label class="gm-check"><input id="gm-clear-key" type="checkbox">移除已保存的 Key</label></div><p id="gm-form-error" class="form-error" role="alert"></p></div>
        <div><h3>最近请求记录</h3>${table(['时间 / 模型','结果','耗时 / HTTP'],g.history.map(r=>`<tr><td>${esc(time(r.at))}<small>${esc(r.model)} · 参数 v${r.profileRevision}</small></td><td>${badge(r.status)}<small>${esc(codes[r.code]||r.code)}</small></td><td>${(r.elapsedMs/1000).toFixed(2)} s<small>${r.httpStatus?'HTTP '+r.httpStatus:'未取得 HTTP 响应'}</small></td></tr>`).join(''))}</div>`,`${closeButton()}<button type="button" id="gm-save-group" class="button secondary" ${busy||activeRun(report.run)?'disabled':''}>保存检测参数</button><button type="button" class="button primary" data-gm-retest="${esc(g.id)}" ${!eligible||busy||activeRun(report.run)?'disabled':''}>${icon('rotate-cw')}重测本组</button>`);
    }
    async function getDetail(path,show) {
      const seq=++detailSequence;detailController?.abort();detailController=new AbortController();const data=await api(path,{signal:detailController.signal});
      if(isActive()&&seq===detailSequence)show(data);
    }
    function showFinding(f) {
      detail=null;openDialog(f.state==='resolved'?'已解除的倍率记录':f.kind==='unknown'?'倍率待核验记录':'倍率异常记录',`账号 #${f.accountId} · 分组 #${f.groupId}`,
        `<div class="gm-result ${f.state==='resolved'?'gm-good':f.kind==='higher'?'gm-bad':''}"><strong>${esc(f.accountName)}</strong><p>${f.state==='resolved'?'复核时已不再触发此项异常，可能因倍率调整、停用或移出分组。':f.kind==='unknown'?'启用账号或所属分组缺少有效倍率，无法判断高低。':`账号 ${rate(f.accountRate)} 高于分组 ${rate(f.groupRate)}。`}</p></div>`+
        facts([['所属分组',f.groupName],['记录账号倍率',rate(f.accountRate)],['记录分组倍率',rate(f.groupRate)],['首次发现',time(f.firstAt)],['最近复核',time(f.lastAt)],['解除时间',time(f.resolvedAt)]])+
        `<div><h3>账号当前所属分组</h3>${table(['分组','当前账号倍率','当前分组倍率','账号状态'],f.groups.map(g=>`<tr><td>${esc(g.name)}<small>#${esc(g.id)}</small></td><td>${rate(g.account.rate)}</td><td>${rate(g.rate)}</td><td>${esc(g.account.status)}</td></tr>`).join(''))}</div>`,`${closeButton()}<button type="button" class="button secondary" data-gm-group="${esc(f.groupId)}">查看分组全部账号</button>`);
    }
    function showSettings() {
      const p=report.policy;detail=null;openDialog('巡检设置','分组请求与账号倍率核验',
        `<label class="gm-check"><input id="gm-auto" type="checkbox" ${p.automatic?'checked':''}>启用自动请求巡检</label><div class="gm-form-grid"><label>巡检间隔 / 分钟<input id="gm-interval" type="number" min="1" max="1440" step="1" value="${p.intervalMinutes}"></label><label>单次请求超时 / 秒<input id="gm-timeout" type="number" min="1" max="120" step="1" value="${p.timeoutSeconds}"></label><label>并发检测分组数<input id="gm-concurrency" type="number" min="1" max="5" step="1" value="${p.concurrency}"></label><label>最大生成 Token<input id="gm-max-tokens" type="number" min="16" max="512" step="1" value="${p.maxOutputTokens}"></label></div><p class="gm-muted">自动请求巡检仅检测已启用、存在启用账号且已配置模型与专用 Key 的分组。检测通过主站正常路由计费，停止后已发出的请求仍可能产生用量。</p><p class="gm-muted">账号倍率每分钟独立核验，不受自动请求开关影响。账号倍率严格大于所属分组默认文本倍率时记录异常，缺失倍率保留待核验。</p><p id="gm-form-error" class="form-error" role="alert"></p>`,`${closeButton()}<button type="button" id="gm-save-settings" class="button primary">保存设置</button>`);
    }
    async function mutate(path,method='POST',body={}) {
      if(busy)return;busy=true;const stamp=lifetime;actionController=new AbortController();
      const buttons=[...$('dialog-footer').querySelectorAll('button:not([data-gm-close])')].map(button=>[button,button.disabled]);
      for(const [button] of buttons)button.disabled=true;
      try {const data=await api(path,{method,body:JSON.stringify(body),signal:actionController.signal});if(!isActive()||stamp!==lifetime)return;
        if($('dialog').open)$('dialog').close();await load();toast(method==='PUT'?'巡检配置已保存':'操作已完成');return data;
      } catch(error) {if(error.name==='AbortError'||stamp!==lifetime||!isActive())return;if($('dialog').open&&$('form-error'))$('form-error').textContent=error.message;else throw error;}
      finally {if(stamp===lifetime){busy=false;for(const [button,disabled] of buttons)if(button.isConnected)button.disabled=disabled;if(report&&isActive())render();}}
    }
    container.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.dataset.gmClose!==undefined){$('dialog').close();return;}
      if(button.dataset.gmGroup){runAction(()=>getDetail(`/api/group-monitor/groups/${encodeURIComponent(button.dataset.gmGroup)}`,showGroup));return;}
      if(button.dataset.gmFinding){runAction(()=>getDetail(`/api/group-monitor/findings/${encodeURIComponent(button.dataset.gmFinding)}`,showFinding));return;}
      if(button.dataset.gmRisk){$('findings-search').value=button.dataset.gmRisk;$('scope').value='current';findingsPage=1;setView('anomalies');return;}
      if(button.dataset.gmRetest){runAction(()=>mutate('/api/group-monitor/runs','POST',{groupIds:[button.dataset.gmRetest]}));return;}
      if(button.dataset.gmPage){if(button.dataset.gmKind==='groups')page=Number(button.dataset.gmPage);else findingsPage=Number(button.dataset.gmPage);runAction(()=>load());return;}
      switch(button.id){
        case 'gm-tab-requests':setView('requests');break;case 'gm-tab-anomalies':setView('anomalies');break;
        case 'gm-open-anomalies':$('findings-search').value='';$('scope').value='current';findingsPage=1;setView('anomalies');break;
        case 'gm-settings':showSettings();break;case 'gm-close':$('dialog').close();break;
        case 'gm-run-all':runAction(()=>mutate('/api/group-monitor/runs'));break;
        case 'gm-stop':if(report.run)runAction(()=>mutate(`/api/group-monitor/runs/${report.run.id}/cancel`));break;
        case 'gm-rescan':runAction(()=>mutate('/api/group-monitor/scan'));break;
        case 'gm-save-group':if(detail)runAction(()=>mutate(`/api/group-monitor/groups/${detail.id}`,'PUT',{revision:detail.profile.revision,model:$('model').value.trim(),protocol:$('protocol').value,apiKey:$('key').value.trim(),clearKey:$('clear-key').checked}));break;
        case 'gm-save-settings':runAction(()=>mutate('/api/group-monitor/policy','PUT',{revision:report.policy.revision,automatic:$('auto').checked,intervalMinutes:Number($('interval').value),timeoutSeconds:Number($('timeout').value),concurrency:Number($('concurrency').value),maxOutputTokens:Number($('max-tokens').value)}));break;
      }
    });
    container.addEventListener('input',event=>{if(['gm-search','gm-findings-search'].includes(event.target.id)){clearTimeout(searchTimer);page=1;findingsPage=1;searchTimer=setTimeout(()=>runAction(()=>load()),250);}});
    container.addEventListener('change',event=>{
      if(['gm-platform','gm-status','gm-scope'].includes(event.target.id)){page=1;findingsPage=1;runAction(()=>load());}
      if(event.target.dataset.gmSize!==undefined){pageSize=Number(event.target.value);page=1;findingsPage=1;runAction(()=>load());}
    });
    container.addEventListener('keydown',event=>{if(event.target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'requests':event.key==='End'?'anomalies':view==='requests'?'anomalies':'requests';setView(next);$(`tab-${next}`).focus();}});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if(isActive())runAction(()=>load());});
    function leave() {++sequence;++lifetime;++detailSequence;clearTimeout(timer);clearTimeout(searchTimer);controller?.abort();detailController?.abort();actionController?.abort();busy=false;if($('dialog')?.open)$('dialog').close();if($('dialog-body'))$('dialog-body').innerHTML='';}
    function reset() {leave();report=null;findings=null;detail=null;view='requests';page=1;findingsPage=1;container.innerHTML='';}
    return {load,leave,reset};
  }
  root.GroupMonitorUi={create};
})(window);
