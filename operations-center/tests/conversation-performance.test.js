'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRedactor, maskPayload } = require('../src/services/conversation-redaction');
const { defaults } = require('../src/conversation-log-store');
const { fixture, event } = require('./conversation-logs-fixture');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

test('email scanning preserves existing matches and stable placeholders at adjacent token boundaries', () => {
  const previous = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;
  const salt = Buffer.alloc(32, 1), policy = { ...defaults, phone: false, secret: false, ip: false };
  const values = ['alice@example.com', 'a@b.com-c@d.com', 'a@b.com+c@d.com', '@@a@b.com',
    'a@localhost next@example.com', 'a.b+tag@SUB.example.co.uk.', 'prefix@a..b.com',
    'x@y.c x@y.comx@z.com', '中文alice@example.com结尾', 'a@@b.com', 'a@b.com@c@d.com'];
  const fragments = ['a', 'B', '0', '.', '-', '+', '@', ' ', 'com', 'example', '_', '\n', '中文'];
  let seed = 17;
  for (let index = 0; index < 500; index++) {
    let value = '';
    for (let part = 0; part < 30; part++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += fragments[seed % fragments.length]; }
    values.push(value);
  }
  for (const value of values) {
    const expected = value.replace(previous, match => '<EMAIL_' + crypto.createHmac('sha256', salt).update('email\0' + match).digest('hex').slice(0, 12).toUpperCase() + '>');
    const redactor = createRedactor(policy, salt);
    assert.equal(JSON.parse(redactor.process([JSON.stringify({ content: value })])[0]).content, expected);
  }
});

test('megabyte non-email tokens and invalid domains cannot stall the collector', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { maskPayload } = require('./src/services/conversation-redaction');
    const { defaults } = require('./src/conversation-log-store');
    for (const text of ['a'.repeat(1024 * 1024), 'a'.repeat(256 * 1024) + '@localhost', 'a@' + 'b'.repeat(256 * 1024)]) {
      const raw = Buffer.from(JSON.stringify({ content: text, contact: 'alice@example.com' }));
      const result = maskPayload({ request: raw, response: Buffer.from('{}'), frames: [] }, defaults, Buffer.alloc(32, 1));
      const saved = JSON.parse(result.payload.request.toString());
      assert.equal(saved.content, text); assert(saved.contact.startsWith('<EMAIL_'));
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('many stream edits preserve every event, numeric spelling and cross-fragment association', () => {
  const stream = Array.from({ length: 2000 }, (_, index) => 'data: {"type":"response.output_text.delta","item_id":"item_' + index + '","delta":"alice@example.com","unknown":1.2300}\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  const result = maskPayload({ request: Buffer.from('{}'), response: Buffer.from(stream), frames: [] }, defaults, Buffer.alloc(32, 1));
  const output = result.payload.response.toString();
  assert.equal(output.split('data: ').length, 2002);
  assert.equal((output.match(/"unknown":1\.2300/g) || []).length, 2000);
  assert.equal((output.match(/<EMAIL_[A-F0-9]+>/g) || []).length, 2000);
  assert(output.endsWith('data: [DONE]\r\n\r\n'));
  assert(!output.includes('alice@example.com'));
});

test('bounded text previews preserve complete text and exact raw downloads on demand', async t => {
  const f = fixture(); t.after(() => f.close());
  const policy = f.store.configure({ ...f.store.policy(), mode: 'original' });
  const prefix = '{"text":"';
  const raw = prefix + 'a'.repeat(65535 - prefix.length) + '\u{1F600}' + 'b'.repeat(300000) + '"}';
  const row = event('large-preview', { policy_version: policy.version, request: Buffer.from(raw).toString('base64') });
  f.store.ingest(row);
  const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, database: {}, conversations: f.store, messages: f.messages });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const url = base + '/api/conversation-logs/records/' + row.id + '/payload/request?source=original';
  assert.equal((await fetch(url + '&view=preview')).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  const headers = { authorization: 'Session ' + (await login.json()).sessionToken };
  const previewResponse = await fetch(url + '&view=preview', { headers });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.headers.get('cache-control'), 'no-store');
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, raw.slice(0, 65535));
  assert(!('base64' in preview));
  assert.equal(preview.bytes, Buffer.byteLength(raw));
  const full = await (await fetch(url + '&view=text', { headers })).json();
  assert.equal(full.text, raw); assert.equal(full.truncated, false); assert(!('base64' in full));
  assert.equal(full.sha256, preview.sha256);
  const legacy = await (await fetch(url, { headers })).json();
  assert.equal(legacy.base64, Buffer.from(raw).toString('base64'));
  const download = await fetch(url + '&download=1', { headers });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(raw));
  assert.equal(crypto.createHash('sha256').update(Buffer.from(raw)).digest('hex'), preview.sha256);
});
