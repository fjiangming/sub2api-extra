'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { BillingImportLogs, sanitizeLogEvent } = require('../src/services/billing-import-logs');

const range = { from: '2026-10-22T00:00:00Z', to: '2026-10-23T00:00:00Z', accounts: ['9'] };
const event = { component: 'gateway', request_id: 'native-1', ts: '2026-10-22T09:00:00.000+0800',
  user_id: 3, api_key_id: 4, group_id: 5, model: 'test', selected_account_id: 9, stream: false };
function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-logs-test-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value;
}

test('bounded read-only log reader handles tab JSON, rotation and gzip and strips bodies, secrets and error text', async t => {
  const dir = directory(t), serialized = JSON.stringify({ ...event, request_body: 'PRIVATE-PAYLOAD', authorization: 'SECRET-KEY', error: 'PRIVATE-ERROR' });
  const tabbed = `${event.ts}\tINFO\tgateway.go:1\tselected\t${serialized}\n`;
  fs.writeFileSync(path.join(dir, 'sub2api.log'), tabbed);
  fs.writeFileSync(path.join(dir, 'sub2api-2026-10-22.log.gz'), zlib.gzipSync(tabbed.replace('native-1', 'native-2')));
  fs.writeFileSync(path.join(dir, 'ignored.log'), tabbed);
  const result = await new BillingImportLogs(dir).load(range);
  assert.equal(result.events.length, 2); assert.equal(result.diagnostics.files, 2);
  assert.equal(result.diagnostics.coverageComplete, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|authorization|request_body/);
  assert.equal(fs.readFileSync(path.join(dir, 'sub2api.log'), 'utf8'), tabbed);
});

test('oversized lines and broken gzip fail instead of returning partial log evidence; handles close after failure', async t => {
  const dir = directory(t), file = path.join(dir, 'sub2api.log');
  fs.writeFileSync(file, 'x'.repeat(66000));
  await assert.rejects(new BillingImportLogs(dir).load(range), { code: 'LOG_SOURCE_TRUNCATED' });
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(dir, 'sub2api-broken.log.gz'), 'broken gzip');
  await assert.rejects(new BillingImportLogs(dir).load(range));
  fs.unlinkSync(path.join(dir, 'sub2api-broken.log.gz'));
});

test('unconfigured or empty log sources advertise missing evidence, without inventing coverage or accepting malformed IDs', async t => {
  assert.equal((await new BillingImportLogs().load(range)).diagnostics.status, 'not_configured');
  assert.equal((await new BillingImportLogs(directory(t)).load(range)).diagnostics.status, 'empty');
  assert.equal(sanitizeLogEvent({ ...event, user_id: true }).user_id, undefined);
  assert.equal(sanitizeLogEvent({ ...event, ts: 'bad timestamp' }), null);
});
