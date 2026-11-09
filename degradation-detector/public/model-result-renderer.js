(() => {
  'use strict';
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const formatDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '未返回';
  const num = value => value == null ? '未返回' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
  const money = value => value == null ? '未返回' : `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)}`;
  const duration = value => value == null ? '未返回' : `${(value / 1000).toFixed(2)} 秒`;
  const json = value => JSON.stringify(value, null, 2);
  const protectedFields = /^(api_?key|user_?key|startedByIp|responseHeaders|headers|authorization|cookie|set-cookie|password|secret|access_?token|refresh_?token|session_?token|baseUrl|base_url|runId|taskId|reportUrl)$/i;
  function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, protectedFields.test(key) ? '[已隐藏]' : redact(item)]));
  }
  const knownNames = {
    identity: '身份', fingerprint: '指纹', behavior: '行为', context: '上下文', security: '安全对照', protocol: '协议', usage: '用量', effort: '推理强度',
    match: '家族匹配', mismatch: '家族不匹配', uncertain: '证据不确定', insufficient_data: '数据不足',
    done: '已完成', completed: '已完成', error: '异常', pending: '待执行', running: '检测中', failed: '失败', aborted: '已终止',
    clean_match: '家族及型号匹配', clean_match_family_only: '仅确认家族', clean_match_submodel_mismatch: '声明子型号不匹配', plain_mismatch: '家族不匹配',
    spoof_behavior_induced: '疑似行为诱导伪装', spoof_selfclaim_forged: '疑似自述伪造', ambiguous: '证据冲突',
    official: '高可靠性', official_flawed: '官方 · 有瑕疵', unofficial: '非官方渠道', reversed: '疑似逆向', not_claude: '非 Claude', not_gpt: '非 GPT',
    high: '高', medium: '中', low: '低', baseline_missing: '缺少基线', submodel_mismatch: '声明子型号不匹配',
    unconfirmed: '未确认', attr_match: '未检测到替换', attr_swapped: '疑似模型替换', attr_uncertain: '归因不确定', attr_unknown: '无法归因'
  };
  const label = value => knownNames[value] || value || '未返回';
  function verdict(channel, run) {
    if (['pending', 'queued', 'running'].includes(run.status)) return { text: run.status === 'queued' ? '等待检测' : '检测中', tone: 'neutral', key: run.status, reason: '检测任务尚未结束' };
    if (['error', 'failed', 'aborted'].includes(run.status)) return { text: '检测异常', tone: 'neutral', key: run.status, reason: run.error || '本轮没有可用结论' };
    if (channel === 'fingerpoint') {
      const key = run.verdictKey || run.analysis?.decision || 'unscorable';
      const text = ({ candidate_match: '候选相符', candidate_differs: '候选不同', scored: '已提供候选', partial: '部分样本有效', unscorable: '无法评分', not_model: '序列特征异常' })[key] || '待确认';
      return { key, text, tone: ['candidate_match', 'scored'].includes(key) ? 'info' : 'warning', reason: '候选排序仅在参考库内比较，不代表模型身份或能力证明。' };
    }
    if (channel === 'bazaarlink') {
      const assessment = run.identityAssessment || {};
      const detailed = assessment.verdict || {};
      const key = detailed.status || assessment.status;
      const tone = key === 'clean_match' ? 'success' : key === 'clean_match_family_only' ? 'info' : ['clean_match_submodel_mismatch', 'ambiguous', 'uncertain', 'insufficient_data'].includes(key) ? 'warning' : ['plain_mismatch', 'spoof_behavior_induced', 'spoof_selfclaim_forged', 'mismatch'].includes(key) ? 'danger' : 'neutral';
      return { text: label(key), tone, key, reason: detailed.reasoning || '接口未返回详细判定理由' };
    }
    if (run.attributionOnly && !run.verdictKey) return { text: '指纹模式 · 待确认', tone: 'warning', key: 'attributionOnly', reason: '本次仅做指纹检测，没有返回可解析的身份结论；不提供完整分数。' };
    return { text: label(run.verdictKey || 'unconfirmed'), tone: ['official', 'attr_match'].includes(run.verdictKey) ? 'success' : ['official_flawed', 'attr_uncertain', 'attr_unknown'].includes(run.verdictKey) ? 'warning' : ['unofficial', 'reversed', 'not_claude', 'not_gpt', 'attr_swapped'].includes(run.verdictKey) ? 'danger' : 'neutral', key: run.verdictKey, reason: run.verdictKey ? '保留检测网站的原始结论与逐项分值。' : '接口未返回可用身份结论' };
  }
  const badge = (text, tone = 'neutral') => `<span class="model-badge" data-tone="${html(tone)}">${html(text)}</span>`;
  function facts(entries) {
    return `<dl class="identity-facts">${entries.map(([name, value]) => `<div><dt>${html(name)}</dt><dd>${html(value)}</dd></div>`).join('')}</dl>`;
  }
  function fieldList(value) {
    if (!value || typeof value !== 'object') return `<p>${html(value == null ? '未返回' : value)}</p>`;
    return `<dl class="record-fields">${Object.entries(redact(value)).map(([key, item]) => `<div><dt class="model-code">${html(key)}</dt><dd>${item && typeof item === 'object' ? `<pre>${html(json(item))}</pre>` : html(item === null ? 'null（未提供）' : String(item))}</dd></div>`).join('')}</dl>`;
  }
  function block(title, contents, open = false) { return `<details class="data-block"${open ? ' open' : ''}><summary>${html(title)}</summary><div class="data-content">${contents}</div></details>`; }
  function section(title, contents, suffix = '') { return `<section class="model-section"><div class="model-section-head"><h4>${html(title)}</h4><span>${html(suffix)}</span></div>${contents}</section>`; }
  function allRecordsTable(records) {
    const keys = [...new Set(records.flatMap(row => Object.keys(row)))];
    return `<div class="data-scroll"><table class="model-table"><thead><tr>${keys.map(key => `<th>${html(key)}</th>`).join('')}</tr></thead><tbody>${records.map(row => `<tr>${keys.map(key => `<td>${row[key] != null && typeof row[key] === 'object' ? `<pre>${html(json(redact(row[key])))}</pre>` : html(row[key] ?? '未返回')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function renderProbe(run, mode = {}) {
    const assessment = run.identityAssessment || {};
    const detail = assessment.verdict || {};
    const items = Array.isArray(run.items) ? run.items.filter(item => item && typeof item === 'object') : [];
    const result = verdict('bazaarlink', { ...run, status: mode.local_status || run.status, error: mode.local_reason || run.error });
    const passed = items.filter(item => item.passed === true).length;
    const warnings = items.filter(item => item.passed === 'warning').length;
    const unavailable = items.filter(item => item.status === 'error' || item.passed == null).length;
    const title = `<div class="model-verdict"><div><h3>Bazaarlink Probe ${badge(result.text, result.tone)}</h3><p>${html(result.reason)}</p></div></div>`;
    const heading = facts([
      ['声明模型', run.claimedModel || '未指定'], ['推测家族', detail.trueFamily || '未确认'], ['推测子型号', detail.trueModel || '未确认'],
      ['家族级结论', label(assessment.status)], ['详细结论', detail.status || '未返回'], ['置信度（详细结论）', label(detail.confidence)],
      ['网站任务状态（最后返回）', label(run.status)], ['总耗时', duration(run.wallClockMs)], ['输入 / 输出 Token', `${num(run.totalInputTokens)} / ${num(run.totalOutputTokens)}`]
    ]);
    const caveat = detail.status === 'clean_match_family_only' ? '本轮只确认模型家族，不能据此确认具体子型号。' : detail.status === 'clean_match_submodel_mismatch' ? '家族匹配不能覆盖子型号不匹配；真实型号为 null 时保持“未确认”。' : assessment.status === 'uncertain' ? '冲突证据保留为无法确认，不转换成通过或降智。' : '身份探测不能替代推理能力评估，警告不自动改变接口原身份结论。';
    const table = `<div class="data-scroll"><table class="model-table items-table"><thead><tr><th>检测项 / 分类</th><th>执行与判定</th><th>原因 / 返回详情</th><th>首字 / 耗时</th><th>输入 / 输出 Token</th><th>速度</th></tr></thead><tbody>${items.map(item => {
      const tone = item.passed === true ? 'success' : item.passed === false ? 'danger' : item.passed === 'warning' ? 'warning' : 'neutral';
      const outcome = item.passed === true ? '通过' : item.passed === false ? '未通过' : item.passed === 'warning' ? '警告' : '无有效判定';
      return `<tr><td class="name-cell"><strong>${html(item.label || item.probeId)}</strong><small>${html(item.probeId)} · ${html(label(item.group))}${item.neutral ? ' · 对照项' : ''}</small></td><td>${badge(outcome, tone)}<small>${html(label(item.status))}</small></td><td class="reason-cell">${html(item.passReason || item.error || '未返回原因')}${item.error ? `<small>${html(item.error)}</small>` : ''}<details><summary>该项全部返回字段</summary><pre>${html(json(redact(item)))}</pre></details></td><td class="number">${html(duration(item.ttftMs))}<small>${html(duration(item.durationMs))}</small></td><td class="number">${html(num(item.inputTokens))} / ${html(num(item.outputTokens))}</td><td class="number">${html(num(item.tps))}${item.tps == null ? '' : ' t/s'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    const warningItems = Array.isArray(run.warnings) ? run.warnings : [];
    const warningList = warningItems.map(item => `<li><strong>${html(item?.label || item?.id || '警告')} · ${html(item?.severity)}</strong><p>${html(typeof item === 'string' ? item : typeof item?.evidence === 'string' ? item.evidence : json(item))}</p></li>`).join('');
    const evidence = {
      ...(assessment.evidence !== undefined ? { evidence: assessment.evidence } : {}),
      ...(assessment.riskFlags !== undefined ? { riskFlags: assessment.riskFlags } : {}),
      ...(assessment.predictedCandidates !== undefined ? { predictedCandidates: assessment.predictedCandidates } : {}),
      ...(assessment.resolvedIdentity !== undefined ? { resolvedIdentity: assessment.resolvedIdentity } : {})
    };
    const assessmentExtra = Object.fromEntries(Object.entries(assessment).filter(([key]) => !['status', 'claimedModel', 'verdict', 'confidence', 'evidence', 'riskFlags', 'predictedCandidates', 'resolvedIdentity'].includes(key)));
    const taskMeta = Object.fromEntries(Object.entries(run).filter(([key]) => !['items', 'identityAssessment', 'warnings'].includes(key)));
    return `${title}${heading}<p class="model-notice">${icon('info')}${html(caveat)}</p>${section('全部检测项结果', table, `${items.length}/${items.length} 项 · 通过 ${passed} · 未通过 ${items.filter(item => item.passed === false).length} · 警告 ${warnings} · 异常或无结论 ${unavailable}`)}${section('风险与行为警告', warningList ? `<ul class="model-warnings">${warningList}</ul>` : '<p>接口未返回警告。</p>', `${warningItems.length} 条`)}${block('身份判定原文与证据', fieldList({ status: assessment.status, verdict: detail, confidence: assessment.confidence, ...evidence }), true)}${block('指纹、基线与阶段诊断', fieldList({ ...assessmentExtra, fingerprintFeatures: run.fingerprintFeatures ?? null, channelSignature: run.channelSignature ?? null, baselineMissingProbes: run.baselineMissingProbes ?? null, linguisticPhase: run.linguisticPhase ?? null, analysisPhase: run.analysisPhase ?? null, effortVerificationPhase: run.effortVerificationPhase ?? null }))}${block('任务元数据与其它返回字段', fieldList(taskMeta))}${block('完整脱敏响应 JSON', `<pre>${html(json(redact(run)))}</pre>`)}<p class="model-footnote">Bazaarlink 的旧综合 score=null 不作 0 分处理；模型身份结论不等于能力评估。</p>`;
  }
  const scoreLabels = { tag_check: '标签 / 指纹检测', stream_structure: '流式结构校验', non_stream: '非流式结构校验', websearch: '联网搜索', signature_proto: '签名校验', output_config: '结构化输出', server_tool: '工具调用', knowledge: '知识库检测', model_attribution: '数字指纹模型归因', doc_recognition: '文档识别', image_recognition: '图片识别' };
  function renderCheck(run, mode = {}) {
    const attributionOnly = run.attributionOnly ?? mode.attribution_only;
    const result = verdict('cctest', { ...run, attributionOnly, status: mode.local_status || run.status, error: mode.local_reason || run.error });
    const scores = Object.entries(run.scores || {});
    const metrics = run.metrics || {};
    const audit = run.tokenAudit;
    const title = `<div class="model-verdict"><div><h3>CCTest ${badge(result.text, result.tone)}</h3><p>${html(result.reason)}</p></div></div>`;
    const heading = facts([
      ['请求模型', run.expectedModel || '未指定'], ['响应模型名称（不等于身份验证）', run.responseModel || '未返回'], ['原始结论', run.verdictKey || '未返回'],
      ['网站总分', run.total == null ? '未提供评分' : `${num(run.total)} 分`], ['网站任务状态 / 进度（最后返回）', `${label(run.status)} / ${run.progress == null ? '未返回' : `${num(run.progress * 100)}%`}`], ['检测类型', (run.provider || mode.provider) === 'claude' ? 'Claude / Messages' : (run.provider || mode.provider) === 'codex' ? 'GPT / Responses' : '未返回'],
      ['流式渠道', run.streamChannel || '未确认'], ['非流式渠道', run.nonStreamChannel || '未确认'], ['Vertex 特征', run.hasVertex == null ? '未返回' : run.hasVertex ? '检出' : '未检出']
    ]);
    const table = scores.length ? `<div class="data-scroll"><table class="model-table"><thead><tr><th>检测项</th><th>接口字段</th><th>返回分值</th><th>逐项原因</th></tr></thead><tbody>${scores.map(([key, value]) => `<tr><td><strong>${html(scoreLabels[key] || key)}</strong></td><td class="model-code">${html(key)}</td><td class="number">${html(value == null ? '未返回' : typeof value === 'number' ? `${value} 分` : typeof value === 'object' ? json(value) : value)}</td><td>接口未返回逐项原因</td></tr>`).join('')}</tbody></table></div>` : `<p>${attributionOnly ? '本次仅做指纹归因，不提供完整评分项。返回的归因字段见下方原始结论与扩展字段。' : '本次接口没有返回评分项；检测异常不计为 0 分，也不作为身份不匹配。'}</p>`;
    const performance = facts([['首字时间', duration(metrics.ttfbMs)], ['总延迟', duration(metrics.latencyMs)], ['生成速度', metrics.tokensPerSec == null ? '未返回' : `${num(metrics.tokensPerSec)} t/s`], ['输入 Token', num(metrics.inputTokens)], ['输出 Token', num(metrics.outputTokens)], ['错误原因', run.error || '未返回错误']]);
    let auditHtml = '<p>本轮未返回 Token 审计，不展示为零费用或零缓存率。</p>';
    if (audit) {
      auditHtml = facts([['检测请求费用（USD）', money(audit.totalCost)], ['网站基线费用（USD）', money(audit.baselineTotalCost)], ['费用比', num(audit.overallRatio)], ['本次审计缓存率', audit.cacheHitRate == null ? '未返回' : `${num(audit.cacheHitRate)}%`], ['审计明细', audit.rows == null ? '未返回' : `${audit.rows.length} 轮`], ['异常项', Array.isArray(audit.anomalies) ? `${audit.anomalies.length} 项` : '未返回']]) + `<p class="model-footnote">检测网站本次请求的审计数据，与分组最近 5h 缓存率独立。</p>` + (Array.isArray(audit.rows) && audit.rows.length && audit.rows.every(row => row && typeof row === 'object') ? allRecordsTable(audit.rows) : '<p>接口未返回逐轮明细。</p>') + block('Token 审计的全部返回字段', fieldList(audit));
    }
    const extras = Object.fromEntries(Object.entries(run).filter(([key]) => !['scores', 'metrics', 'tokenAudit'].includes(key)));
    return `${title}${heading}${run.error ? `<p class="model-notice">${icon('circle-alert')}${html(run.error)}</p>` : ''}${section('全部检测项结果', table, `${scores.length}/${scores.length} 个返回项 · 保留原分值`)}<p class="model-footnote">按接口 scores 中的全部字段逐项列出，包含 0 分、未知字段和空值；网站未给逐项原因时不推测。总分采用接口 total，不自行累加或设定通过阈值。</p>${section('性能与用量', performance)}${section('Token 用量审计', auditHtml)}${block('原始结论、任务状态与扩展字段', fieldList(extras), true)}${block('完整脱敏响应 JSON', `<pre>${html(json(redact(run)))}</pre>`)}<p class="model-footnote">可选字段只在接口返回时展示；指纹模式不伪造完整评分。网站的渠道标签属于其检测结论，不能据此直接判定模型降智。</p>`;
  }

  function platformSections(groups, renderCard) {
    const platforms = new Map();
    for (const group of groups) {
      if (!platforms.has(group.platform)) platforms.set(group.platform, []);
      platforms.get(group.platform).push(group);
    }
    return [...platforms].map(([key, members]) => `<section class="fp-platform-zone" data-platform="${html(key)}"><header class="fp-platform-zone-head"><h2>${icon(({ openai: 'sparkles', anthropic: 'bot', gemini: 'gem', grok: 'orbit' })[key] || 'cpu')}${html(members[0].platform_label || key)}</h2><span>${members.length} 个检测分组</span></header><div class="group-grid fp-platform-grid">${members.map(renderCard).join('')}</div></section>`).join('');
  }
  const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '不提供';
  function ranking(analysis) {
    const results = Array.isArray(analysis?.results) ? analysis.results : [];
    if (!results.length) return '<p>本轮未返回可评分的候选排名。</p>';
    return `<div class="data-scroll"><table class="model-table fp-rankings"><thead><tr><th>排名</th><th>候选模型</th><th>家族</th><th>排名分数</th><th>库内置信度</th></tr></thead><tbody>${results.map((result, index) => `<tr><td>${index + 1}</td><td><strong>${html(result.display_name || result.model || '未返回')}</strong>${index === 0 ? '<small>本轮最相近候选</small>' : ''}</td><td>${html(result.family || '未返回')}</td><td class="number">${html(typeof result.score === 'number' ? result.score.toFixed(3) : '不提供')}</td><td class="number">${percent(result.probability)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function fingerprintSamples(round) {
    const samples = Array.isArray(round.samples) ? round.samples : [];
    return `<div class="data-scroll"><table class="model-table fp-samples"><thead><tr><th>样本</th><th>状态</th><th>有效整数</th><th>首字节</th><th>返回模型 / 异常</th></tr></thead><tbody>${samples.map((sample, index) => `<tr><td>${index + 1}</td><td>${badge(sample.error ? '失败' : sample.state === 'complete' ? '完整' : sample.state || '未返回', sample.error ? 'warning' : 'neutral')}</td><td>${html(sample.count ?? '未返回')} / ${html(sample.expected_count ?? '未返回')}</td><td>${html(sample.first_byte_ms == null ? '未收到' : `${sample.first_byte_ms} ms`)}</td><td>${html(sample.error || sample.response_model || '未返回')}</td></tr>`).join('')}</tbody></table></div>${samples.map((sample, index) => block(`样本 ${index + 1} · 挑战与完整回答`, `<p class="model-footnote">挑战提示词</p><pre>${html(sample.prompt || round.challenges?.[index]?.prompt || '未保留')}</pre><p class="model-footnote">原始回答</p><pre>${html(sample.raw_text ?? sample.text ?? sample.error ?? '未返回')}</pre>${block('该样本全部返回字段', fieldList(sample))}`)).join('')}`;
  }
  function renderFingerprint(response, mode = {}) {
    const analysis = response.analysis;
    const rounds = Array.isArray(response.rounds) ? response.rounds : [];
    const params = response.parameters || {};
    const data = response.data || {};
    const result = verdict('fingerpoint', { ...response, status: mode.local_status || response.status, error: mode.local_reason });
    const comparisonNote = ({ version_separator: '版本号分隔符写法等价，按同一候选名称比较。', reference_name: '请求名称对应参考库中的候选显示名称。', ambiguous: '请求名称对应多个参考候选，暂不判断名称是否相符。' })[response.comparison?.method] || '';
    return `<div class="fp-result" data-fingerprint-detail><div class="model-verdict"><div><h3>${icon('fingerprint')}Fingerpoint ${badge(result.text, result.tone)}</h3><p>最相近候选：<strong>${html(analysis?.prediction_name || analysis?.prediction || '未提供')}</strong> · ${rounds.length} 轮检测</p>${comparisonNote ? `<p>${html(comparisonNote)}</p>` : ''}</div></div><p class="fp-scope-note">${icon('info')}排名和置信度仅在参考库收录模型之间比较，不能单独证明模型身份，也不代表智商或能力评分。</p>${facts([['请求模型', response.requested_model || '未指定'], ['最新一轮有效样本', `${analysis?.used_outputs ?? 0} / ${params.count ?? '未返回'}`], ['参考库内置信度', percent(analysis?.probability)], ['检测程序', `SDK ${response.sdk_version || '未返回'}`], ['参考数据版本', data.built_at || '未返回'], ['参考模型数', data.models == null ? '未返回' : `${data.models} 个`]])}${section('全部候选排名', ranking(analysis), `${Array.isArray(analysis?.results) ? analysis.results.length : 0} 个返回候选`)}${analysis?.decision === 'partial' ? '<p class="model-footnote">有效样本不足三条，本轮只提供排名，不提供置信度。</p>' : ''}${section('逐轮结果与样本', rounds.map((round, index) => block(`第 ${round.round || index + 1} 轮 · ${round.analysis?.used_outputs ?? 0}/${params.count ?? '?'} 个有效样本 · ${percent(round.analysis?.probability)}`, `${facts([['最相近候选', round.analysis?.prediction_name || round.analysis?.prediction || '未提供'], ['判定类型', round.analysis?.decision || '未返回'], ['概率范围', '仅参考库内']])}${ranking(round.analysis)}${fingerprintSamples(round)}${block('该轮全部评分、诊断与序列特征', fieldList(round))}`, index === 0)).join('') || '<p>尚未取得完整轮次结果。</p>', '每轮独立评分')}${facts([['请求协议', ({ responses: 'OpenAI Responses', chat_completions: 'Chat Completions', messages: 'Anthropic Messages' })[params.api] || '未返回'], ['推理强度', params.effort || '默认'], ['数据指纹', data.hash || '未返回']])}${block('完整脱敏响应 JSON', `<pre>${html(json(redact(response)))}</pre>`)}<p class="model-footnote">检测使用执行时的固定数据版本。更新参考数据不会覆盖这条历史记录的原始结论。</p></div>`;
  }

  window.ModelResultRenderer = { renderProbe, renderCheck, renderFingerprint, platformSections, verdict, badge, html, icon, formatDate, duration };
})();
