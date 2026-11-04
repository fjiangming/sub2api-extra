const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HttpClient } = require('../src/http/client');

const config = { queryTimeoutMs: 65, maxResponseBytes: 1024 * 1024, allowedHosts: [], allowPrivateNetworks: true };
const resolve = async input => ({ url: new URL(input), hostname: 'upstream.example', addresses: [{ address: '1.1.1.1', family: 4 }] });

test('DNS lookup and ignored fetch cancellation have bounded deadlines and late completion cannot continue', async () => {
  let resume, calls = 0;
  const pending = new Promise(done => { resume = done; });
  const client = new HttpClient(config, { resolve: () => pending, fetchImpl: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(client.requestJson('https://upstream.example', { retries: 0 }), { code: 'TIMEOUT' });
  resume(await resolve('https://upstream.example'));
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 0);

  let destroyed = 0;
  const hung = new HttpClient(config, { resolve, dispatcher: () => ({ destroy: async () => { destroyed++; } }),
    fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(hung.requestJson('https://upstream.example', { retries: 0 }), { code: 'TIMEOUT' });
  assert.equal(destroyed, 1);
  await assert.rejects(hung.requestSse('https://upstream.example'), { code: 'TIMEOUT' });
  assert.equal(destroyed, 2);
});

test('socket cleanup does not hold a successful response and parent cancellation stops DNS waits', async () => {
  let destroyed = 0;
  const client = new HttpClient(config, { resolve,
    dispatcher: () => ({ close: () => new Promise(() => {}), destroy: () => { destroyed++; return new Promise(() => {}); } }),
    fetchImpl: async () => new Response('{"amount":12}') });
  assert.equal((await client.requestJson('https://upstream.example')).data.amount, 12);
  assert.equal(destroyed, 1);
  const abort = new AbortController();
  const pending = new HttpClient({ ...config, queryTimeoutMs: 10000 }, { resolve: () => new Promise(() => {}) });
  const result = pending.requestJson('https://upstream.example', { signal: abort.signal });
  abort.abort();
  await assert.rejects(result, { code: 'TIMEOUT' });
});

test('real stalled headers, partial bodies, redirects and retry delays all obey one request budget', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/headers') return;
    if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"amount":'); return; }
    if (req.url === '/retry') { res.writeHead(429, { 'retry-after': '30' }); res.end('{}'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/headers' }); res.end(); return; }
    res.end('{"amount":7}');
  }).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const client = new HttpClient({ ...config, queryTimeoutMs: 120 });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/headers', '/body', '/redirect', '/retry']) {
    const start = performance.now();
    await assert.rejects(client.requestJson(base + path), { code: 'TIMEOUT' });
    assert(performance.now() - start < 1200, path);
    assert.equal((await client.requestJson(base + '/healthy')).data.amount, 7);
  }
});
