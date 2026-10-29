'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startPreview } = require('../scripts/billing-import-preview.cjs');
const { AppError } = require('../src/errors');

function gate() {
  let release, enter;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  return { entered, release, wait: async () => { enter(); await pending; } };
}
async function fixture(t) {
  const demo = await startPreview({ port: 0 });
  t.after(() => demo.stop());
  const base = `http://127.0.0.1:${demo.port}`;
  const login = await fetch(`${base}/preview`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const session = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
  const headers = { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
  const imports = demo.imports, batchId = imports.store.batches()[0].id;
  const row = imports.detail(batchId, { filter: 'actionable' }).rows[0];
  const task = (kind = 'preview', input = { rowIds: [row.id] }) => ({ id: crypto.randomUUID(), kind, input });
  const request = (url, body, overrides = {}) => fetch(`${base}/api/billing-imports/${batchId}${url}`, {
    method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(1500), ...overrides
  });
  return { ...demo, imports, batchId, row, task, request, base, headers };
}
const confirmation = rows => ({ acknowledge: true, rows: rows.map(row => ({ id: row.id, version: row.version, previewId: row.preview.id })) });

test('task acceptance and polling return without waiting for blocked full evidence reads or core quotes', async t => {
  const f = await fixture(t), sourceGate = gate(), quoteGate = gate();
  const load = f.imports.source.load, request = f.imports.recovery.request;
  f.imports.source.load = async (...args) => { await sourceGate.wait(); return load(...args); };
  let quotes = 0;
  f.imports.recovery.request = async (...args) => {
    if (args[0] === '/imports/quote') { quotes++; await quoteGate.wait(); }
    return request(...args);
  };
  try {
    const body = f.task();
    const response = await f.request('/tasks', body);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).task.id, body.id);
    await sourceGate.entered;
    assert.equal((await (await f.request(`/tasks/${body.id}`)).json()).task.progress.phase, 'rechecking');
    assert.equal((await (await f.request('')).json()).task.id, body.id);
    assert.equal((await f.request('/tasks', body)).status, 202, 'lost response retries return the same task');
    assert.equal((await f.request('/tasks', { ...body, input: { rowIds: [f.row.id], missingCacheIsZero: true } })).status, 409);
    assert.equal((await f.request('/tasks', f.task())).status, 409);
    assert.equal((await f.request('/preview', { rowIds: [f.row.id] })).status, 409);
    assert.equal((await f.request('/match', f.imports.store.batch(f.batchId).options)).status, 409);
    sourceGate.release(); await quoteGate.entered;
    const polling = (await (await f.request(`/tasks/${body.id}`)).json()).task;
    assert.equal(polling.status, 'running'); assert.equal(polling.progress.phase, 'quoting');
    assert.equal(polling.progress.rowNumber, f.row.number); assert.equal(polling.progress.completed, 0);
    assert.equal(f.ledger.usageRecords.size, 0); assert.equal(f.ledger.charges.size, 0);
    quoteGate.release(); await f.imports.tasks.work;
    const finished = (await (await f.request(`/tasks/${body.id}`)).json()).task;
    assert.equal(finished.status, 'succeeded'); assert.equal(finished.result.results[0].status, 'preview');
    assert.equal(finished.progress.completed, 1); assert.equal(quotes, 1);
    assert.equal((await f.request('/tasks', body)).status, 202);
    assert.equal(quotes, 1, 're-reading a finished task must not generate another quote');
    assert.equal(f.imports.store.get(f.row.id).status, 'preview'); assert.equal(f.ledger.usageRecords.size, 0);
    assert.equal(Object.hasOwn(finished, 'payloadHash'), false);
    assert.equal(Object.hasOwn(finished, 'input'), false);
  } finally { sourceGate.release(); quoteGate.release(); await f.imports.tasks.work; }
});

test('task routes enforce authentication, CSRF, ownership, acknowledgement and original size limits before enqueueing', async t => {
  const f = await fixture(t), body = f.task();
  assert.equal((await f.request('/tasks', body, { headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await f.request('/tasks', body, { headers: { cookie: f.headers.cookie, 'content-type': 'application/json' } })).status, 403);
  assert.equal((await f.request('/tasks', f.task('confirm', { acknowledge: false, rows: [] }))).status, 400);
  assert.equal((await f.request('/tasks', f.task('preview', { rowIds: Array(21).fill(f.row.id) }))).status, 400);
  assert.equal((await f.request('/tasks', { ...body, kind: 'settle', input: {} })).status, 400);
  const other = await f.imports.import({ fileName: 'other.csv', csv: 'Time,Model,Input Tokens,Output Tokens\n2026-10-22,test,1,2' });
  assert.equal((await f.request('/tasks', f.task('preview', { rowIds: [other.rows[0].id] }))).status, 409);
  assert.equal(f.imports.store.db.prepare('SELECT COUNT(*) AS n FROM import_tasks').get().n, 0);
  const accepted = await f.request('/tasks', body); assert.equal(accepted.status, 202); await f.imports.tasks.work;
  assert.equal((await f.request(`/tasks/${body.id}`, null, { headers: {} })).status, 401);
  assert.equal((await fetch(`${f.base}/api/billing-imports/${other.id}/tasks/${body.id}`, { headers: f.headers })).status, 404);
});

test('background confirmation preserves native receipts after a slow commit and lost upstream response without duplicate charges', async t => {
  const f = await fixture(t);
  await f.imports.preview(f.batchId, { rowIds: [f.row.id] });
  const row = f.imports.store.get(f.row.id), commitGate = gate(), settle = f.imports.recovery.settle;
  f.imports.recovery.settle = async (...args) => { await settle(...args); await commitGate.wait(); throw new Error('response lost after native commit'); };
  try {
    const body = f.task('confirm', confirmation([row]));
    assert.equal((await f.request('/tasks', body)).status, 202);
    await commitGate.entered;
    assert.equal(f.ledger.usageRecords.size, 1); assert.equal(f.ledger.charges.size, 1);
    assert.equal((await (await f.request(`/tasks/${body.id}`)).json()).task.progress.phase, 'settling');
    assert.equal((await f.request('/tasks', body)).status, 202);
    assert.equal((await f.request('/confirm', confirmation([row]))).status, 409);
    commitGate.release(); await f.imports.tasks.work;
    const finished = (await (await f.request(`/tasks/${body.id}`)).json()).task;
    assert.equal(finished.status, 'succeeded'); assert.equal(finished.result.results[0].status, 'settled');
    const saved = f.imports.store.get(row.id);
    assert.equal(saved.result.caseId, saved.case_id); assert.equal(saved.result.amount, row.preview.usage.ActualCost);
    assert.equal(f.ledger.balances.get(row.preview.userId), Number((100 - row.preview.usage.ActualCost).toFixed(8)));
    assert.equal((await f.request('/tasks', f.task('confirm', confirmation([saved])))).status, 202);
    await f.imports.tasks.work;
    assert.deepEqual([...f.ledger.charges.values()], [1]);
  } finally { commitGate.release(); await f.imports.tasks.work; }
});

test('restart marks interrupted work without replaying credentials or clearing frozen previews and native claims', async t => {
  const f = await fixture(t);
  await f.imports.preview(f.batchId, { rowIds: [f.row.id] });
  let row = f.imports.store.get(f.row.id);
  const previewId = row.preview.id;
  const abandonedId = crypto.randomUUID();
  f.imports.store.createTask(abandonedId, f.batchId, 'confirm', 'prior-process-fingerprint', 1);
  f.imports.store.updateTask(abandonedId, { status: 'running' });
  row = f.imports.store.claim(row.id, row.version, previewId);
  // Simulate a native commit whose final local receipt was interrupted.
  const reserved = await f.imports.recovery.request('/imports/reserve', { body: row.preview.reservation });
  row = f.imports.store.save(row.id, { case_id: reserved.case_id, lease_until: 0 }, row.version);
  await f.imports.recovery.restore(row.case_id, { usage_record: row.preview.usage });
  await f.imports.recovery.review(row.case_id, { state: 'prepared' });
  await f.imports.recovery.settle(row.case_id);
  const persistent = f.imports.store.store;
  persistent.close(); persistent.initialize(); f.imports.store.initialize();
  f.imports.start();
  const interrupted = f.imports.tasks.get(f.batchId, abandonedId);
  assert.equal(interrupted.status, 'interrupted'); assert.match(interrupted.error.message, /重启/);
  row = f.imports.store.get(row.id);
  assert.equal(row.preview.id, previewId); assert.equal(row.status, 'confirming');
  assert.deepEqual([...f.ledger.charges.values()], [1]);
  assert.equal((await f.request('/tasks', f.task('confirm', confirmation([row])))).status, 202);
  await f.imports.tasks.work;
  assert.equal(f.imports.store.get(row.id).status, 'settled');
  assert.equal(f.imports.store.get(row.id).preview.id, previewId);
  assert.deepEqual([...f.ledger.charges.values()], [1]);
  const schema = f.imports.store.db.pragma('table_info(import_tasks)').map(column => column.name);
  assert.ok(!schema.some(name => /token|credential|password/.test(name)), 'credentials must never be stored');
});

test('a task error after partial previews preserves successful rows and never creates native usage', async t => {
  const f = await fixture(t), rows = f.imports.detail(f.batchId, { filter: 'actionable' }).rows;
  const save = f.imports.store.save.bind(f.imports.store);
  f.imports.store.save = (id, values, version) => {
    if (id === rows[1].id && values.status === 'preview') throw new AppError('PREVIEW_CONFLICT', '模拟报价后版本变化', { status: 409 });
    return save(id, values, version);
  };
  const body = f.task('preview', { rowIds: rows.map(row => row.id) });
  assert.equal((await f.request('/tasks', body)).status, 202); await f.imports.tasks.work;
  const failed = f.imports.tasks.get(f.batchId, body.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error.message, /版本变化/);
  assert.equal(failed.progress.completed, 1);
  assert.equal(f.imports.store.get(rows[0].id).status, 'preview');
  assert.equal(f.imports.store.get(rows[1].id).preview, null); assert.equal(f.imports.store.get(rows[2].id).preview, null);
  assert.equal(f.ledger.usageRecords.size, 0); assert.equal(f.ledger.charges.size, 0);
});

test('failed evidence checks retain earlier previews, and shutdown waits for current work while refusing new tasks', async t => {
  const f = await fixture(t);
  await f.imports.preview(f.batchId, { rowIds: [f.row.id] });
  const before = f.imports.store.get(f.row.id), load = f.imports.source.load;
  f.imports.source.load = async () => { throw new Error('source unavailable with private diagnostic'); };
  const body = f.task(); assert.equal((await f.request('/tasks', body)).status, 202);
  await f.imports.tasks.work;
  const failed = f.imports.tasks.get(f.batchId, body.id);
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.error.message, /private diagnostic/);
  assert.equal(f.imports.store.get(f.row.id).preview.id, before.preview.id);
  const sourceGate = gate(); f.imports.source.load = async (...args) => { await sourceGate.wait(); return load(...args); };
  try {
    assert.equal((await f.request('/tasks', f.task())).status, 202); await sourceGate.entered;
    let stopped = false; const stopping = f.imports.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    assert.equal((await f.request('/tasks', f.task())).status, 409);
    sourceGate.release(); await stopping; assert.equal(stopped, true);
    assert.equal((await f.request('/tasks', f.task())).status, 409);
  } finally { sourceGate.release(); await f.imports.tasks.work; }
  assert.equal(f.ledger.usageRecords.size, 0); assert.equal(f.ledger.charges.size, 0);
});
