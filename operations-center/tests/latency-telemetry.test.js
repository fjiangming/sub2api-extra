'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LatencyTelemetryStore } = require('../src/latency-telemetry-store');
const { counters, resourceSample, proxySample } = require('../integrations/collector.cjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-test-'));
  let at = Date.parse('2026-10-20T00:00Z');
  const config = { dataDir: directory, latencyTelemetry: { token: 'a'.repeat(32), minFreeMb: 0, maxMb: 32 } };
  const store = new LatencyTelemetryStore(config, { now: () => at }); store.initialize();
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const event = (sequence, name, extra = {}) => ({ requestId: 'root-1', sequence, name,
    at: new Date(at).toISOString(), elapsedMs: sequence * 1000, attributes: {}, ...extra });
  return { store, config, event, advance: (ms) => { at += ms; } };
}

test('stage events survive restart, deduplicate and link retries to upstream request IDs', (t) => {
  const { store, config, event } = setup(t);
  store.ingest({ type: 'events', events: [event(0, 'request_start'), event(2, 'response_headers', {
    attemptId: '2', attributes: { upstreamRequestId: 'remote-2', accountId: '270' } })] });
  store.ingest({ type: 'events', events: [event(1, 'attempt_start', { attemptId: '1' }), event(0, 'request_start')] });
  assert.equal(store.find(['remote-2'])[0].events.length, 3);
  assert.deepEqual(store.find(['root-1'])[0].events.map((row) => row.sequence), [0, 1, 2]);
  store.close(); store.initialize(config);
  assert.equal(store.find(['remote-2'])[0].metadata.accountId, '270');
  store.ingest({ type: 'events', events: [event(3, 'request_end', { attributes: {
    outcome: 'completed', usageRequestId: 'client:client-request-1'
  } })] });
  assert.equal(store.find(['client:client-request-1'])[0].requestId, 'root-1');
});

test('strict ingestion rejects secrets and full bodies, and retains the terminal event at the event cap', (t) => {
  const { store, event } = setup(t);
  assert.throws(() => store.ingest({ type: 'events', events: [event(0, 'request_start', { attributes: { authorization: 'secret' } })] }), /格式无效/);
  assert.throws(() => store.ingest({ type: 'events', events: [event(0, 'request_start')], body: 'prompt' }), /格式无效/);
  for (let offset = 0; offset < 192; offset += 64) store.ingest({ type: 'events', events:
    Array.from({ length: 64 }, (_, index) => event(offset + index, 'response_byte', { attemptId: String(index) })) });
  store.ingest({ type: 'events', events: [event(193, 'request_end', { attributes: { outcome: 'cancelled' } })] });
  const trace = store.find(['root-1'])[0];
  assert.equal(trace.outcome, 'cancelled');
  assert.ok(trace.events.length <= 129);
  assert.equal(trace.events.at(-1).name, 'request_end');
  assert.ok(store.status().droppedEvents > 0);
});

test('completed ordinary traces expire after seven days; unknown active requests are not reported as definitely running', (t) => {
  const { store, event, advance } = setup(t);
  store.ingest({ type: 'events', events: [event(0, 'request_start'), event(1, 'request_end', { attributes: { outcome: 'completed' } })] });
  advance(8 * 86400000); store.prune();
  assert.equal(store.find(['root-1']).length, 0);
  store.ingest({ type: 'events', events: [event(0, 'request_start')] });
  advance(31 * 60000);
  assert.equal(store.recent()[0].outcome, 'unknown');
});

test('low space rejects telemetry without deleting existing traces', (t) => {
  const { store, event } = setup(t);
  store.ingest({ type: 'events', events: [event(0, 'request_start')] });
  store.options.minFreeMb = 1e15;
  assert.throws(() => store.ingest({ type: 'events', events: [event(1, 'body_read')] }), /空间不足/);
  assert.equal(store.find(['root-1'])[0].events.length, 1);
});

test('missing data mounts stop initialization before creating a fallback directory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-mount-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mount = path.join(directory, 'unmounted');
  const store = new LatencyTelemetryStore({ dataDir: directory,
    latencyTelemetry: { token: 'a'.repeat(32), directory: path.join(mount, 'telemetry'), mountPath: mount } });
  assert.throws(() => store.initialize(), (error) => error.code === 'TELEMETRY_MOUNT_MISSING');
  assert.equal(fs.existsSync(mount), false);
  store.close();
});

test('event and link caps survive terminal-first delivery and repeated terminal events', (t) => {
  const { store, event } = setup(t);
  store.ingest({ type: 'events', events: [event(1000, 'request_end', { attributes: { outcome: 'completed' } })] });
  for (let offset = 0; offset < 192; offset += 64) store.ingest({ type: 'events', events:
    Array.from({ length: 64 }, (_, index) => event(offset + index, 'response_headers', {
      attributes: { upstreamRequestId: `remote-${offset + index}` }
    })) });
  store.ingest({ type: 'events', events: Array.from({ length: 64 }, (_, index) => event(1001 + index, 'request_end', {
    attributes: { outcome: 'error', upstreamRequestId: `extra-${index}` }
  })) });
  const trace = store.find(['root-1'])[0];
  assert.equal(trace.events.length, 129);
  assert.equal(trace.outcome, 'completed');
  assert.equal(trace.events.at(-1).name, 'request_end');
  assert.equal(store.find(['remote-191', 'extra-63']).length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM trace_links').get().n, 129);
});

test('live requests remain visible when more than fifty newer requests have completed', (t) => {
  const { store, event, advance } = setup(t);
  store.ingest({ type: 'events', events: [event(0, 'request_start')] });
  advance(60000);
  for (let index = 0; index < 55; index += 1) store.ingest({ type: 'events', events: [
    event(0, 'request_start', { requestId: `done-${index}` }),
    event(1, 'request_end', { requestId: `done-${index}`, attributes: { outcome: 'completed' } })
  ] });
  assert.equal(store.recent()[0].requestId, 'root-1');
  assert.equal(store.recent()[0].outcome, 'active');
  const actualBytes = store.bytes.bind(store);
  store.bytes = () => store.maxBytes * 0.95;
  store.checkSpace();
  assert.equal(store.find(['root-1']).length, 1, 'reusable SQLite pages must not trigger repeated eviction');
  store.bytes = actualBytes;
});

test('resource deltas account for steal and resets, and proxy timings keep missing values null', () => {
  const current = { cpu: [30, 0, 20, 100, 10, 0, 0, 40], rx: 200, tx: 100, drops: 0, retransmits: 5 };
  const previous = { cpu: [10, 0, 10, 80, 0, 0, 0, 0], rx: 100, tx: 200, drops: 0, retransmits: 3 };
  const result = resourceSample(current, previous, 2, 'MemAvailable: 1024 kB\nMemTotal: 2048 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB',
    { bavail: 100, bsize: 4096, blocks: 200, ffree: 5 }, 'host', '2026-10-20T00:00Z');
  assert.equal(result.cpuPercent, 30);
  assert.equal(result.stealPercent, 40);
  assert.equal(result.networkRxBytesPerSecond, 50);
  assert.equal(result.networkTxBytesPerSecond, undefined);
  assert.equal(result.tcpRetransmitsPerSecond, 1);
  assert.equal(proxySample({ request_id: 'id', at: '2026-10-20T00:00Z', request_time: '118.123',
    upstream_header_time: '-', upstream_connect_time: '0.001, 0.002', upstream_response_time: '110.0',
    request_bytes: '14660000', sent_bytes: '123', status: '200' }).upstreamHeaderMs, null);
  assert.equal(counters('cpu 1 2 3 4 5 6 7 8', 'eth0: 1 2 3 4 5 6 7 8 9 10 11 12',
    'Tcp: RetransSegs\nTcp: 123', '', 'vdb').retransmits, 123);
});
