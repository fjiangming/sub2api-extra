'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('../src/conversation-log-store');
const { maskPayload } = require('../src/services/conversation-redaction');
const { fixture, event } = require('./conversation-logs-fixture');

const policy = { ...defaults };
function masked(request, response = '{}', rules = policy) {
  const result = maskPayload({ request: Buffer.from(request), response: Buffer.from(response), frames: [] }, rules, Buffer.alloc(32, 1));
  return { request: result.payload.request.toString(), response: result.payload.response.toString(), hits: result.hits };
}

test('identity, payment, credentials, personal and device fields include numeric values and nested objects', () => {
  const source = '{ "customer":{"id":"customer-private-xyz","name":"张三","passport_no":"E12345678","ssn":"123-45-6789",' +
    '"id_card":"11010519491231002X","phone":13800138000,"email":"alice@example.com","card_number":4111111111111111,' +
    '"iban":"DE89370400440532013000","address":{"city":"示例城市","street":"测试路 12 号"},"date_of_birth":"1990-01-01",' +
    '"coordinates":[31.23,121.47],"diagnosis":"fictional-health-detail","imei":"490154203237518","wechat_id":"fictional-wechat"},' +
    '"credentials":{"password":"private-password","session_id":"private-session","otp":246810,"private_key":"private-key-value"},' +
    '"keep":1.2300,"big":9007199254740993,"unknown":true }';
  const result = masked(source), saved = JSON.parse(result.request);
  for (const sensitive of ['customer-private-xyz','张三','E12345678','123-45-6789','11010519491231002X','13800138000','alice@example.com',
    '4111111111111111','DE89370400440532013000','示例城市','测试路','1990-01-01','31.23','121.47','fictional-health-detail','490154203237518',
    'fictional-wechat','private-password','private-session','246810','private-key-value']) assert(!result.request.includes(sensitive), sensitive);
  assert.equal(saved.customer.name.match(/^<PERSONAL_/)[0], '<PERSONAL_');
  assert(result.request.includes('"keep":1.2300')); assert(result.request.includes('"big":9007199254740993'));
  assert.equal(saved.unknown, true); assert.deepEqual(Object.keys(saved.customer), Object.keys(JSON.parse(source).customer));
});

test('free text detects validated IDs, cards, IBAN, IPv6, MAC and varied credential formats', () => {
  const samples = ['11010519491231002X','123-45-6789','4111 1111 1111 1111','DE89370400440532013000','2001:db8::1234',
    'aa:bb:cc:dd:ee:ff','sk-fictional_private_key_123456','ghp_1234567890abcdefghijklm','AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWN0aW9uYWwifQ.abcdefghijklmnop',
    'password=fictional-password','身份证号：invalid-test-id','护照：E12345678','姓名：张三','验证码=246810',
    'https://alice:private-password@service.example/path', 'https://service.example/?X-Amz-Signature=fictional-signature&email=alice%40example.com'];
  for (const value of samples) {
    const output = JSON.parse(masked(JSON.stringify({ content: value })).request).content;
    assert.notEqual(output, value, value);
    for (const sensitive of ['alice','private-password','fictional-signature','E12345678','invalid-test-id','张三','246810']) {
      if (value.includes(sensitive)) assert(!output.includes(sensitive), value + ' leaked ' + sensitive);
    }
  }
});

test('identical learned personal values remain associated across roles, tool results and response fragments', () => {
  const request = JSON.stringify({ model: 'selected-model', messages: [{ role: 'user', content: '张三，请查询' }],
    tools: [{ type: 'function', function: { name: 'lookup' } }], customer: { name: '张三' } });
  const response = 'data: {"type":"response.function_call_arguments.delta","item_id":"item_1794806368560","delta":"{\\"name\\":\\"张"}\n\n' +
    'data: {"type":"response.function_call_arguments.delta","item_id":"item_1794806368560","delta":"三\\"}"}\n\n' +
    'data: {"type":"response.output_text.delta","item_id":"item_1794806368560","delta":"张三 已找到"}\n\ndata: [DONE]\n\n';
  const output = masked(request, response), parsed = JSON.parse(output.request), alias = parsed.customer.name;
  assert(!output.request.includes('张三')); assert(!output.response.includes('张三'));
  assert(parsed.messages[0].content.includes(alias)); assert(output.response.includes(alias));
  assert.equal(parsed.messages[0].role, 'user'); assert.equal(parsed.tools[0].function.name, 'lookup');
  assert.equal((output.response.match(/item_1794806368560/g) || []).length, 3);
  assert.equal(output.response.split('data: ').length, 5); assert(output.response.endsWith('data: [DONE]\n\n'));
  const shortName = JSON.parse(masked('{"customer":{"name":"Li"},"content":"Li listens; Listen remains"}').request);
  assert(shortName.content.includes('listens; Listen remains')); assert(!shortName.content.startsWith('Li '));
});

test('legacy identity cards and complete long PEM keys are masked with other pattern rules disabled', () => {
  const rules = { ...policy, email: false, phone: false, financial: false, ip: false, personal: false, device: false };
  for (const value of ['130503670401001', '11010519491231002X']) {
    const output = JSON.parse(masked(JSON.stringify({ content: value }), '{}', rules).request).content;
    assert.match(output, /^<IDENTITY_[A-F0-9]{12}>$/);
  }
  const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(40000) + '\n-----END RSA PRIVATE KEY-----';
  const text = 'before ' + pem + ' after';
  assert.match(JSON.parse(masked(JSON.stringify({ content: text }), '{}', rules).request).content, /^before <SECRET_[A-F0-9]{12}> after$/);
});

test('unfinished PEM content retains exact encrypted source and cannot produce a safe masked copy', t => {
  const f = fixture(); t.after(() => f.close());
  const p = f.store.configure({ ...f.store.policy(), mode: 'masked' });
  const request = JSON.stringify({ content: 'before -----BEGIN PRIVATE KEY-----\nfictional-unfinished-key' });
  const row = event('unfinished-pem', { policy_version: p.version, request: Buffer.from(request).toString('base64') });
  assert(f.store.ingest(row).accepted);
  const saved = f.store.detail(row.id);
  assert.equal(saved.processing_error, 'INCOMPLETE_PRIVATE_KEY'); assert(saved.complete); assert(saved.original); assert(!saved.masked);
  assert(saved.retry_available); assert.equal(f.store.payload(row.id, 'original', 'request').text, request);
  assert(!JSON.stringify(saved).includes('fictional-unfinished-key'));
});

test('all valid nested JSON string fields are inspected, including numeric secrets and nonprotocol name/id', () => {
  const value = masked(JSON.stringify({ payload: JSON.stringify({ name: '张三', id: 'private-client-id', otp: 246810, keep: 1 }) }));
  const inner = JSON.parse(JSON.parse(value.request).payload);
  assert.match(inner.name, /^<PERSONAL_/); assert.match(inner.id, /^<IDENTITY_/); assert.match(inner.otp, /^<SECRET_/); assert.equal(inner.keep, 1);
});

test('media, signed/encrypted content and unsupported bytes retain source and withhold masked copies', t => {
  const f = fixture(); t.after(() => f.close());
  const p = f.store.configure({ ...f.store.policy(), mode: 'masked' });
  for (const [index, request] of [
    '{"input":[{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}]}',
    '{"file_id":"file-fictional-123"}', '{"image_url":{"url":"https://files.example/private.png"}}',
    '{"encrypted_content":"opaque-private-value"}', '{"thinking":{"signature":"opaque-signature"}}'
  ].entries()) {
    const row = event('opaque-' + index, { policy_version: p.version, request: Buffer.from(request).toString('base64') });
    f.store.ingest(row); const saved = f.store.detail(row.id);
    assert.equal(saved.processing_error, 'UNINSPECTABLE_CONTENT'); assert(saved.complete); assert(saved.original); assert(!saved.masked);
    assert(saved.retry_available); assert.equal(f.store.payload(row.id, 'original', 'request').text, request);
    assert(!JSON.stringify(saved).includes('opaque-private-value'));
  }
});

test('updated rules offer reprocessing for dual copies without a prior error and protect unavailable masked history', t => {
  const f = fixture(); t.after(() => f.close()); const row = event('upgrade-rules'); f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0,redaction_policy_hash=? WHERE id=?').run('', row.id);
  const before = f.store.detail(row.id); assert(before.redaction_outdated); assert(before.retry_available);
  const done = f.store.retry(row.id, { policy_version: f.store.policy().version, processed_at: before.processed_at });
  assert.equal(done.redaction_version, 5); assert(!done.redaction_outdated); assert(!done.retry_available);
  f.store.configure({ ...f.store.policy(), custom: [{ from: 'ORION-42', to: '<ORDER>' }] });
  assert(f.store.detail(row.id).retry_available);
  const p = f.store.configure({ ...f.store.policy(), mode: 'masked' }), only = event('masked-upgrade', { policy_version: p.version }); f.store.ingest(only);
  f.store.configure({ ...f.store.policy(), custom: [] });
  const stale = f.store.detail(only.id); assert(stale.redaction_outdated); assert(!stale.retry_available); assert.equal(stale.retry_blocked, 'no_original');
});
