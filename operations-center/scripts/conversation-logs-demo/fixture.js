'use strict';

(() => {
  const now = Date.parse('2026-11-15T15:30:00+08:00');
  const request = `{
  "model": "gpt-6.1",
  "instructions": "你是一个客服助手。保留订单与工具结果的对应关系。",
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "帮我查询订单 ORION-42，邮箱是 linyuan@example.com，联系电话 +1-202-555-0148。" }] },
    { "type": "function_call", "id": "fc_order_01", "call_id": "call_order_01", "name": "lookup_order", "arguments": "{\\"email\\":\\"linyuan@example.com\\",\\"order_id\\":\\"ORION-42\\"}" },
    { "type": "function_call_output", "call_id": "call_order_01", "output": "{\\"status\\":\\"shipped\\",\\"order_id\\":\\"ORION-42\\"}" }
  ],
  "tools": [{ "type": "function", "name": "lookup_order", "parameters": { "type": "object", "properties": { "email": { "type": "string" }, "order_id": { "type": "string" } }, "required": ["email", "order_id"], "additionalProperties": false }, "strict": true }],
  "reasoning": { "effort": "high" },
  "stream": true,
  "store": false,
  "metadata": { "project": "ORION-42", "debug_credential": "demo_secret_alpha_2026", "client_ip": "198.51.100.24" },
  "provider_extensions": { "trace_hint": "preserve-this-field", "experimental": true, "exact_counter": 9007199254740993, "weight": 1.2300 }
}`;
  const sse = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_demo_order_01","model":"gpt-6.1","status":"in_progress","output":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_order_01","output_index":0,"content_index":0,"delta":"订单 ORION-42 已发货。"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_order_01","output_index":0,"content_index":0,"delta":"物流通知将发送到 linyuan@example.com，联系电话为 +1-202-555-0148。"}

event: response.completed
data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_demo_order_01","status":"completed","output":[{"id":"msg_order_01","type":"message","role":"assistant","content":[{"type":"output_text","text":"订单 ORION-42 已发货。物流通知将发送到 linyuan@example.com，联系电话为 +1-202-555-0148。","annotations":[]}]}],"usage":{"input_tokens":1268,"output_tokens":91,"total_tokens":1359},"provider_extensions":{"region":"demo-region-1","custom_field":"kept"}}}

`;
  const anthropic = `{
  "model": "claude-sonnet-4-5",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "为 linyuan@example.com 编写一封订单 ORION-42 的跟进邮件。" }
  ],
  "system": [{ "type": "text", "text": "使用中文，正文不超过三句话。", "cache_control": { "type": "ephemeral" } }],
  "metadata": { "user_id": "demo_customer_1002" },
  "stream": false
}`;
  const anthropicResponse = `{"id":"msg_demo_mail_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"您好，您的订单 ORION-42 已发货。后续物流更新将发送至 linyuan@example.com，请注意查收。感谢您的耐心等待。"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":246,"output_tokens":68},"vendor_metadata":{"trace":"demo-claude-01"}}`;
  const chat = `{"model":"gpt-6.1","messages":[{"role":"system","content":"你是代码审查助手。"},{"role":"user","content":"这段字符串应该作为文字展示：<img src=x onerror=alert(1)>。不要执行它。"}],"temperature":0.2,"stream":false,"vendor_options":{"retain_unknown":true}}`;
  const chatResponse = `{"id":"chatcmpl_demo_01","object":"chat.completion","model":"gpt-6.1","choices":[{"index":0,"message":{"role":"assistant","content":"这是一段 HTML 字符串，应以纯文本显示；不要将其交给 innerHTML。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":183,"completion_tokens":46,"total_tokens":229},"system_fingerprint":"fp_demo"}`;
  const wsFrames = [
    { direction: 'out', at: 0, text: '{"type":"response.create","response":{"model":"gpt-6.1","input":[{"role":"user","content":"查到订单后，发一封邮件到 linyuan@example.com。"}],"tools":[{"type":"function","name":"send_mail","parameters":{"type":"object","properties":{"email":{"type":"string"}},"required":["email"]}}],"store":false}}' },
    { direction: 'in', at: 146, text: '{"type":"response.created","response":{"id":"resp_demo_ws_01","status":"in_progress"}}' },
    { direction: 'in', at: 492, text: '{"type":"response.function_call_arguments.done","item_id":"fc_mail_01","call_id":"call_mail_01","name":"send_mail","arguments":"{\\"email\\":\\"linyuan@example.com\\"}"}' },
    { direction: 'in', at: 623, text: '{"type":"response.completed","response":{"id":"resp_demo_ws_01","status":"completed","output":[{"type":"function_call","id":"fc_mail_01","call_id":"call_mail_01","name":"send_mail","arguments":"{\\"email\\":\\"linyuan@example.com\\"}"}],"usage":{"input_tokens":382,"output_tokens":24}}}' },
    { direction: 'out', at: 811, text: '{"type":"response.create","response":{"previous_response_id":"resp_demo_ws_01","input":[{"type":"function_call_output","call_id":"call_mail_01","output":"{\\"status\\":\\"sent\\"}"}],"store":false}}' },
    { direction: 'in', at: 1268, text: '{"type":"response.completed","response":{"id":"resp_demo_ws_02","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已向 linyuan@example.com 发送订单通知。"}]}],"usage":{"input_tokens":418,"output_tokens":26}}}' }
  ];
  const partial = sse.slice(0, sse.indexOf('event: response.completed'));
  const defaultPolicy = { version: 3, enabled: true, mode: 'dual', email: true, phone: true, secret: true, ip: false,
    retention: 7, capacity: 10, reserve: 2, overflow: 'stop', custom: [], excludedUserIds: [] };
  const users = ['林远', '陈夏', '周宁', '苏禾', '方知'].map((name, index) => ({ id: 1001 + index, name }));
  const substitutions = [
    { kind: 'email', from: 'linyuan@example.com', to: '<EMAIL_1>', name: '邮箱' },
    { kind: 'phone', from: '+1-202-555-0148', to: '<PHONE_1>', name: '电话号码' },
    { kind: 'secret', from: 'demo_secret_alpha_2026', to: '<SECRET_1>', name: '正文密钥' },
    { kind: 'ip', from: '198.51.100.24', to: '<IP_1>', name: 'IP 地址' }
  ];
  function redact(text, policy) {
    let output = text;
    const hits = [];
    for (const rule of [...substitutions.filter(rule => policy[rule.kind]), ...policy.custom.map(rule => ({ ...rule, name: '自定义规则' }))]) {
      const count = output.split(rule.from).length - 1;
      if (count) { output = output.replaceAll(rule.from, rule.to); hits.push({ kind: rule.kind || 'custom', name: rule.name, count, replacement: rule.to }); }
    }
    return { text: output, hits };
  }
  const fixedFields = new Set(['type', 'role', 'id', 'call_id', 'tool_call_id', 'previous_response_id', 'name', 'model', 'item_id', 'stop_reason', 'finish_reason']);
  function sameStructure(before, after, field = '') {
    if (typeof before !== typeof after || before === null || after === null) return before === after;
    if (typeof before === 'string') {
      if (fixedFields.has(field)) return before === after;
      if (['arguments', 'output'].includes(field)) {
        try { return sameStructure(JSON.parse(before), JSON.parse(after)); } catch { return field !== 'arguments'; }
      }
      return true;
    }
    if (typeof before !== 'object') return before === after;
    if (Array.isArray(before) !== Array.isArray(after)) return false;
    const keys = Object.keys(before), otherKeys = Object.keys(after);
    return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && sameStructure(before[key], after[key], key));
  }
  function validSamplePolicy(policy) {
    try {
      const documents = [request, anthropic, chat, wsFrames[0].text, ...sse.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))];
      return documents.every(text => sameStructure(JSON.parse(text), JSON.parse(redact(text, policy).text)));
    } catch { return false; }
  }
  function snapshot(attempt, policy) {
    const raw = { request: attempt.request, response: attempt.response, frames: attempt.frames || [] };
    const requestMasked = redact(raw.request, policy), responseMasked = redact(raw.response, policy);
    const masked = { request: requestMasked.text, response: responseMasked.text,
      frames: raw.frames.map(frame => ({ ...frame, text: redact(frame.text, policy).text })) };
    const { request: ignoredRequest, response: ignoredResponse, frames: ignoredFrames, ...metadata } = attempt;
    return { ...metadata, original: policy.mode === 'masked' ? null : raw, masked: policy.mode === 'original' ? null : masked,
      hits: policy.mode === 'original' ? [] : [...requestMasked.hits.map(hit => ({ ...hit, side: 'Request' })),
        ...responseMasked.hits.map(hit => ({ ...hit, side: 'Response' }))] };
  }
  function validExcludedUserIds(value) { return Array.isArray(value) && value.length <= 1000 && value.every(id => Number.isSafeInteger(id) && id > 0); }
  const sources = [
    { platform: 'OpenAI', model: 'gpt-6.1', protocol: 'SSE', path: '/v1/responses', request, response: sse, summary: '查询订单与物流通知', answer: '订单 ORION-42 已发货，通知将发送到 linyuan@example.com。' },
    { platform: 'Anthropic', model: 'claude-sonnet-4-5', protocol: 'JSON', path: '/v1/messages', request: anthropic, response: anthropicResponse, summary: '生成订单跟进邮件', answer: '您好，您的订单 ORION-42 已发货，感谢您的耐心等待。' },
    { platform: 'OpenAI', model: 'gpt-6.1', protocol: 'WebSocket', path: '/v1/responses', request: wsFrames[0].text, response: wsFrames.at(-1).text, frames: wsFrames, summary: '发送订单通知邮件', answer: '已向 linyuan@example.com 发送订单通知。' },
    { platform: 'Gemini', model: 'gemini-2.5-pro', protocol: 'JSON', path: '/v1beta/models/gemini-2.5-pro:generateContent',
      request: '{"contents":[{"role":"user","parts":[{"text":"请将 ORION-42 订单的物流状态翻译成英文。"}]}],"generationConfig":{"temperature":0.2},"custom_metadata":{"tag":"original-field"}}',
      response: '{"candidates":[{"content":{"role":"model","parts":[{"text":"Order ORION-42 has been shipped."}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":89,"candidatesTokenCount":16,"totalTokenCount":105},"modelVersion":"gemini-2.5-pro"}', summary: '翻译物流状态', answer: 'Order ORION-42 has been shipped.' },
    { platform: 'OpenAI', model: 'gpt-6.1', protocol: 'JSON', path: '/v1/chat/completions', request: chat, response: chatResponse, summary: '审查 HTML 字符串的处理方式', answer: '将 HTML 字符串作为纯文本展示。' }
  ];
  function makeRecord(index, overridePolicy, userId) {
    const policy = { ...defaultPolicy, ...(index === 8 ? { mode: 'masked' } : {}), ...overridePolicy };
    const user = userId === undefined ? users[Math.floor(index / 3) % users.length] : users.find(item => item.id === userId);
    // Exclude before constructing any archive metadata, body copies, retries or message snapshots.
    if (!policy.enabled || !user || !validExcludedUserIds(policy.excludedUserIds) || policy.excludedUserIds.includes(user.id)) return null;
    const source = sources[index % sources.length], id = `req_demo_${String(index + 1).padStart(4, '0')}`;
    const problem = ({ 5: 'partial', 11: 'missing', 17: 'partial', 23: 'missing', 29: 'redaction_failed' })[index] || 'complete';
    const base = { account: `演示${source.platform}线路 A`, accountId: 201 + index % 4, host: `${source.platform.toLowerCase()}.upstream.example.com`,
      status: problem === 'missing' ? null : 200, duration: 2.46 + index % 5 * 1.26, request: source.request,
      response: problem === 'partial' ? (source.protocol === 'SSE' ? partial : source.response.slice(0, 85)) : source.response, frames: source.frames,
      upstreamId: `up_demo_${index + 101}`, complete: problem === 'complete', reason: problem === 'partial' ? '上游连接在结束标记前断开' : '' };
    let attempts = [snapshot(base, policy)];
    if ([3, 9, 15, 21, 27].includes(index)) {
      attempts.unshift(snapshot({ ...base, account: `演示${source.platform}线路 B`, accountId: 309, status: 429, duration: .38,
        request: source.request, response: '{"error":{"type":"rate_limit_error","message":"Too many requests","retry_after":1},"vendor_trace":"demo-retry-01"}', frames: [], upstreamId: `up_demo_${index + 101}_first`, complete: true, reason: '上游限流，切换线路后完成' }, policy));
    }
    if (['missing', 'redaction_failed'].includes(problem)) attempts = attempts.map(attempt => ({ ...attempt, original: null, masked: null, hits: [], complete: false,
      reason: problem === 'missing' ? '采集队列达到上限，未保存正文' : '脱敏未通过结构校验，未保存正文' }));
    return { id, index, at: new Date(now - index * 19 * 60000 - 17000).toISOString(), ...source, request: undefined, response: undefined, frames: undefined,
      user: { ...user }, key: `Key #${user.id - 920}`,
      session: index < 3 ? 'sess_order_01' : index % 7 === 0 ? null : `sess_demo_${Math.floor(index / 3) + 1}`,
      capture: problem, outcome: problem === 'partial' ? 'interrupted' : 'success', policyVersion: policy.version, mode: policy.mode,
      attempts, last: attempts.length - 1, bytes: attempts.reduce((sum, attempt) => sum + (attempt.original?.request.length || attempt.masked?.request.length || 0) + (attempt.original?.response.length || attempt.masked?.response.length || 0), 0) };
  }
  const records = Array.from({ length: 32 }, (_, index) => makeRecord(index));
  // These three exchanges have a verified shared identity and session, in turn order.
  for (let index = 0; index < 3; index++) {
    records[index].user = { id: 1001, name: '林远' }; records[index].key = 'Key #81';
    records[index].at = new Date(now - (3 - index) * 80000).toISOString();
  }
  window.ConversationDemo = { now, defaultPolicy, records, users, request, response: sse, redact, makeRecord, validSamplePolicy, validExcludedUserIds };
})();
