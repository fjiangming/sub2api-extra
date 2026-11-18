'use strict';

// Fictional local archives only. Reports API responsiveness, never calls a model provider.
const assert = require('node:assert/strict');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, event } = require('../tests/conversation-logs-fixture');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

async function measure(isolated) {
  const f = fixture(), auth = new AuthService(f.config), archive = isolated ? new ConversationArchiveService(f.store) : null;
  let server;
  try {
    await archive?.start();
    const app = createApp({ config: f.config, database: {}, auth, conversations: f.store, conversationArchive: archive });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const base = 'http://127.0.0.1:' + server.address().port, headers = { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' };
    const people = Array.from({ length: 100 }, (_, index) => ({ name: 'PersonExample' + index + 'Name', passport_number: 'PExample' + index }));
    for (const complex of [false, true]) {
      const input = JSON.stringify({ model: 'example-model', text: ('safe example text, alice@example.com; ').repeat(120000), ...(complex ? { people } : {}) });
      const row = event('perf-' + complex, { request: Buffer.from(input).toString('base64'), response: Buffer.from('{"text":"done"}').toString('base64') });
      const body = JSON.stringify(row), loop = monitorEventLoopDelay({ resolution: 1 }), times = [], probes = [];
      loop.enable(); await delay(20); loop.reset();
      let finished = false, receiptMs = 0;
      const start = performance.now();
      const saving = fetch(base + '/api/conversation-logs/ingest', { method: 'POST', headers, body })
        .then(async response => { assert.equal(response.status, 200); assert((await response.json()).accepted); receiptMs = performance.now() - start; }).finally(() => { finished = true; });
      do {
        const queuedAt = performance.now(); await delay(5); const at = performance.now();
        const response = await fetch(base + '/api/conversation-logs/collector-policy', { headers });
        assert.equal(response.status, 200); await response.json(); times.push(performance.now() - at); probes.push(performance.now() - queuedAt);
        assert(performance.now() - start < 60000, 'background archive exceeded the local benchmark deadline');
      } while (!finished || isolated && f.store.hasPending());
      await saving; const total = performance.now() - start;
      await delay(10); loop.disable();
      const saved = f.store.detail(row.id);
      assert.equal(saved.processing_pending,0);
      console.log(JSON.stringify({ isolated, complex, rawMiB: Buffer.byteLength(input) / 1024 ** 2, receiptMs, processedMs: total, processingError:saved.processing_error, masked:saved.masked,
        policySamples: times.length, policyMaxMs: Math.max(...times), scheduledProbeMaxMs: Math.max(...probes), loopMaxMs: loop.max / 1e6, loopP95Ms: loop.percentile(95) / 1e6 }));
      while (archive?.busy) await delay(10);
    }
  } finally {
    await archive?.stop(); auth.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    f.close();
  }
}
async function main() { await measure(false); await measure(true); }
main().catch(error => { console.error(error.message); process.exitCode = 1; });
