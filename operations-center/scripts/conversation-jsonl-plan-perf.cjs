'use strict';

// Fictional temporary archives only; no server or remote bucket is contacted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fixture, event } = require('../tests/conversation-logs-fixture');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationJsonlStore } = require('../src/conversation-jsonl-store');

function measure() {
  const f = fixture();
  try {
    f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
    const push = new ConversationPushStore(f.store).initialize(), current = push.policy();
    push.configure({ ...current, enabled: true, source: 'original', s3: { ...current.s3, enabled: true,
      endpoint: 'https://storage.example', bucket: 'fictional-benchmark', accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret' } });
    const jsonl = new ConversationJsonlStore(push, { memoryBudget: () => ({ memory: 1024 ** 3, heap: 1024 ** 3 }) }).initialize();
    const request = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'safe example text; '.repeat(220000) }] })).toString('base64');
    const response = Buffer.from(JSON.stringify({ output: [{ text: 'safe example response; '.repeat(180000) }] })).toString('base64');
    for (let index = 0; index < 6; index++) assert(f.store.ingest(event('jsonl-perf-' + index,
      { policy_version: f.store.policy().version, model: 'Opus5', request, response })).accepted);
    const input = { filter: {}, destinations: ['s3'] }, preview = push.preview(input);
    push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
    const prepare = push.db.prepare.bind(push.db), delivery = push.delivery.bind(push), timings = {};
    const add = (key, start) => { const value = timings[key] ||= { calls: 0, ms: 0 }; value.calls++; value.ms += performance.now() - start; };
    push.db.prepare = sql => {
      const statement = prepare(sql);
      if (!/FROM cl_records/.test(sql) || !/WHERE (?:r\.)?id=\?/.test(sql)) return statement;
      const key = / AS payload/.test(sql) ? 'payloadRead' : /length\((?:r\.)?original\)/.test(sql) ? 'admissionRead' : 'recordMetadataRead';
      return new Proxy(statement, { get(target, name) {
        if (name !== 'get') return Reflect.get(target, name, target);
        return (...args) => { const start = performance.now(); try { return target.get(...args); } finally { add(key, start); } };
      } });
    };
    push.delivery = (...args) => { const start = performance.now(); try { return delivery(...args); } finally { add('delivery', start); } };
    const start = performance.now(); let records = 0;
    while (jsonl.assignOne()) records++;
    const ms = performance.now() - start, bytes = jsonl.list().files.reduce((sum, file) => sum + file.bytes, 0);
    assert.equal(records, 6); assert(bytes > 40000000);
    console.log(JSON.stringify({ records, jsonlMiB: bytes / 1024 ** 2, ms, MiBPerSecond: bytes / 1024 ** 2 / (ms / 1000), timings }));
  } finally { f.close(); }
}

measure();
