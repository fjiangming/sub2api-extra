'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const test = require('node:test');
const { validateAdminConfiguration, validateTestConfig } = require('../src/config');
const { CredentialVault } = require('../src/credential-vault');
const { VisualReviewer, combineReview, prepareReviewHtml } = require('../src/visual-review');
const { publicAddress, requestReviewJson, resolveReviewAddress, reviewUrl } = require('../src/review-http');
const { publicVisualSettings, snapshotValidation, storeVisualTest } = require('../src/visual-config');
const { defaultTests, testConfig } = require('./helpers');

const html = '<!doctype html><html><head><style>@keyframes a{to{opacity:1}}</style></head><body><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"><animateTransform attributeName="transform" type="rotate" values="0 50 50;360 50 50" dur="2s" repeatCount="indefinite"/></circle></svg></body></html>';
function reviewTest(overrides = {}) {
  return validateTestConfig('openai', { ...defaultTests.openai,
    validation: { version: 2, rules: [], visual: { enabled: true, ...overrides } } });
}

test('visual configuration is opt-in, validates endpoints, and rejects injected credential fields', () => {
  assert.equal(validateTestConfig('openai', defaultTests.openai).validation.visual, undefined);
  assert.equal(reviewTest().validation.visual.protocol, 'manxue');
  for (const api_url of ['http://example.com/api', 'https://user:secret@example.com/api', 'https://example.com/api?key=secret', 'https://example.com/api#part']) {
    assert.throws(() => reviewTest({ api_url }), /HTTPS/);
  }
  assert.throws(() => validateTestConfig('openai', { ...reviewTest(), output_type: 'text' }), /只能用于 HTML/);
  assert.throws(() => reviewTest({ api_key: 'test-key', clear_api_key: true }), /同时/);
  const submitted = { schedule_mode: 'daily', schedule_times: ['09:00'], schedule_interval_minutes: 60,
    platforms: [{ id: 'openai', enabled: true, test: reviewTest({ key_cipher: 'forged' }), groups: [] }] };
  assert.throws(() => validateAdminConfiguration(submitted), /服务端审核凭据/);
});

test('review credentials are encrypted, preserved, inherited, cleared and never returned in snapshots', (t) => {
  const vault = new CredentialVault(testConfig(t));
  const key = 'sk-review-dedicated-1234567890';
  const stored = storeVisualTest(reviewTest({ api_key: key }), vault, 'platform:openai');
  const visual = stored.validation.visual;
  assert.equal(vault.decrypt(visual.key_context, visual.key_cipher), key);
  assert.equal(JSON.stringify(stored).includes(key), false);
  assert.equal(publicVisualSettings(visual).api_key_configured, true);
  assert.equal(JSON.stringify(publicVisualSettings(visual)).includes('key_cipher'), false);
  assert.equal(JSON.stringify(snapshotValidation(stored.validation)).includes(visual.key_cipher), false);
  const preserved = storeVisualTest(reviewTest(), vault, 'platform:openai', stored);
  assert.equal(vault.decrypt(preserved.validation.visual.key_context, preserved.validation.visual.key_cipher), key);
  const inherited = storeVisualTest(reviewTest(), vault, 'group:openai:1', null, stored);
  assert.notEqual(inherited.validation.visual.key_context, visual.key_context);
  assert.equal(vault.decrypt(inherited.validation.visual.key_context, inherited.validation.visual.key_cipher), key);
  assert.equal(storeVisualTest(reviewTest({ clear_api_key: true }), vault, 'platform:openai', stored).validation.visual.key_cipher, undefined);
  assert.equal(storeVisualTest(reviewTest({ api_url: 'https://other.example.com/tests' }), vault, 'platform:openai', stored).validation.visual.key_cipher, undefined);
  assert.deepEqual(snapshotValidation({ version: 2, rules: [], visual: { enabled: false } }), { version: 2, rules: [] });
});

test('safe HTML and standalone SVG retain their original animation content', () => {
  assert.equal(prepareReviewHtml(html), html);
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/></svg>';
  const wrapped = prepareReviewHtml(svg);
  assert.match(wrapped, /<!doctype html>/);
  assert.match(wrapped, /<path d="M0 0 L1 1"\/>/);
  assert.doesNotMatch(wrapped, /<\?xml/);
  assert.doesNotThrow(() => prepareReviewHtml('<html><style>svg{clip-path:url(#clip);--color:red}@media (max-width:500px){svg{width:100%}}</style><svg><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs></svg></html>'));
});

test('review preparation rejects incomplete, excessive and unsafe content without executing it', () => {
  assert.throws(() => prepareReviewHtml('<html><body><svg/>'), /REVIEW_INPUT_INVALID/);
  assert.throws(() => prepareReviewHtml('x'.repeat(1024 * 1024 + 1)), /REVIEW_INPUT_TOO_LARGE/);
  for (const source of [
    '<script>alert(1)</script>', '<svg onload="alert(1)"></svg>', '<iframe srcdoc="x"></iframe>',
    '<svg><foreignObject><div>unsafe</div></foreignObject></svg>', '<img src="https://example.com/x">',
    '<style>@import "https://example.com/x";</style>', '<style>x{background:u\\72l(https://example.com)}</style>',
    '<style>x{background:u\\72l("https://example.com")}</style>',
    '<style>x{background:image-set("https://example.com/x" 1x)}</style>',
    '<svg xml:base="https://example.com/x"><image href="#asset"/></svg>',
    '<noscript><img src="https://example.com/x"></noscript>',
    '<template><img src="https://example.com/x"></template>',
    '<style>x{--image:url(https://example.com)}</style>', '<svg><animate attributeName="href" values="#x;https://example.com"/></svg>',
    '<svg><animate attributeName="fill" values="red;url(https://example.com)"/></svg>', '<meta http-equiv="refresh" content="0;url=https://example.com">'
  ]) assert.throws(() => prepareReviewHtml(`<html><body>${source}</body></html>`), /REVIEW_INPUT_UNSAFE/, source);
});

test('manxue submits exactly the tutorial payload, polls the same task and maps quality', async () => {
  for (const quality of ['normal', 'degraded']) {
    const calls = [];
    const reviewer = new VisualReviewer({ sleep: async () => {}, request: async (url, options) => {
      calls.push({ url, options });
      return options.method === 'POST' ? { id: 'task-1', status: 'queued', benchmark: 'pelican' }
        : { id: 'task-1', status: 'succeeded', benchmark: 'pelican', assessment: { quality } };
    } });
    const result = await reviewer.review({ visual: reviewTest().validation.visual, html, apiKey: '', runId: 17 });
    assert.equal(result.status, quality);
    assert.equal(result.state, 'completed');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options.body, { benchmark: 'pelican', html });
    assert.match(calls[0].options.taskKey, /^degradation-review-17-[a-f0-9-]{36}$/);
    assert.equal(calls[1].options.taskKey, calls[0].options.taskKey);
    assert.equal(calls[1].url, 'https://manxue.ai/api/v1/tests/task-1');
    assert.equal(calls[1].options.body, undefined);
  }
});

test('manxue rejects mismatched tasks, unknown conclusions, invalid statuses and never resubmits', async () => {
  for (const task of [
    { id: 'wrong', benchmark: 'pelican', status: 'succeeded', assessment: { quality: 'normal' } },
    { id: 'task-1', benchmark: 'other', status: 'succeeded', assessment: { quality: 'normal' } },
    { id: 'task-1', benchmark: 'pelican', status: 'running', assessment: { quality: 'normal' } },
    { id: 'task-1', benchmark: 'pelican', status: 'succeeded', assessment: { quality: 'future' } },
    { id: 'task-1', benchmark: 'pelican', status: 'succeeded', quality: 'normal' },
    { id: 'task-1', benchmark: 'pelican', status: 'failed' }
  ]) {
    let posts = 0;
    const reviewer = new VisualReviewer({ sleep: async () => {}, request: async (_url, options) => {
      if (options.method === 'POST') { posts++; return { id: 'task-1', status: 'queued' }; }
      if (task.status === 'running') throw new Error('external secret response');
      return task;
    } });
    const result = await reviewer.review({ visual: reviewTest().validation.visual, html, runId: 1 });
    assert.equal(result.status, 'unknown');
    assert.equal(posts, 1);
    assert.equal(JSON.stringify(result).includes('external secret'), false);
  }
});

test('sync HTML review supports a configured endpoint, model and rubric', async () => {
  const visual = reviewTest({ protocol: 'html_review', api_url: 'https://review.example.com/check', model: 'vision-test', instructions: 'Inspect visible contact.' }).validation.visual;
  let posted;
  const reviewer = new VisualReviewer({ request: async (url, options) => {
    posted = { url, options };
    return { quality: 'normal' };
  } });
  const result = await reviewer.review({ visual, html, apiKey: 'review-only-key', runId: 3 });
  assert.equal(result.status, 'normal');
  assert.equal(posted.url, visual.api_url);
  assert.equal(posted.options.apiKey, 'review-only-key');
  assert.deepEqual(posted.options.body, { benchmark: 'pelican', html, model: 'vision-test', instructions: 'Inspect visible contact.' });
});

test('review total timeout covers polling, while unsafe output never reaches the API', async () => {
  let time = 0;
  let calls = 0;
  const reviewer = new VisualReviewer({ now: () => time, sleep: async (ms) => { time += ms; }, request: async () => {
    calls++;
    return { id: 'task-1', status: 'running', benchmark: 'pelican' };
  } });
  const visual = reviewTest({ timeout_seconds: 5, poll_interval_seconds: 2 }).validation.visual;
  const result = await reviewer.review({ visual, html, runId: 1 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error_code, 'REVIEW_TIMEOUT');
  assert.equal(calls, 3);
  calls = 0;
  const unsafe = await reviewer.review({ visual, html: '<html><script>alert(1)</script></html>', runId: 2 });
  assert.equal(unsafe.error_code, 'REVIEW_INPUT_UNSAFE');
  assert.equal(calls, 0);
});

test('visual and combined decisions preserve local evidence and never turn an audit failure into a pass', () => {
  const deterministic = { status: 'degraded', quality: 'degraded', score: 20, validationResult: { results: [{ passed: false }] } };
  const visual = reviewTest().validation.visual;
  assert.equal(combineReview(deterministic, visual, { status: 'normal', reason: 'normal' }).status, 'normal');
  assert.equal(combineReview(deterministic, { ...visual, decision_mode: 'both' }, { status: 'normal', reason: 'normal' }).status, 'degraded');
  for (const mode of ['visual', 'both']) {
    assert.equal(combineReview({ ...deterministic, status: 'normal' }, { ...visual, decision_mode: mode }, { status: 'unknown', reason: 'timeout' }).status, 'unknown');
  }
  const combined = combineReview(deterministic, visual, { status: 'normal', reason: 'normal' });
  assert.equal(combined.validationResult.local_status, 'degraded');
  assert.deepEqual(combined.validationResult.results, deterministic.validationResult.results);
});

test('review networking rejects private addresses including mapped IPv6 and bounds DNS by cancellation', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.2', '::1', 'fc00::1', '::ffff:7f00:1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => reviewUrl('http://127.0.0.1/api'), /REVIEW_URL_UNSAFE/);
  const controller = new AbortController();
  await assert.rejects(resolveReviewAddress(new URL('https://example.com'), controller.signal, async () => [{ address: '127.0.0.1', family: 4 }]), /REVIEW_URL_UNSAFE/);
  const pending = resolveReviewAddress(new URL('https://example.com'), controller.signal, () => new Promise(() => {}));
  controller.abort();
  await assert.rejects(pending, /REVIEW_TIMEOUT/);
});

test('review HTTP pins DNS, uses only its own optional key, rejects redirects and limits response size', async () => {
  const captured = [];
  function transport(statusCode, chunks, headers = {}) {
    return (url, options, receive) => {
      captured.push({ url, options });
      const connection = new EventEmitter();
      connection.end = (body) => {
        captured.at(-1).body = body;
        const response = Readable.from(chunks);
        response.statusCode = statusCode;
        response.headers = headers;
        receive(response);
      };
      return connection;
    };
  }
  const options = { method: 'POST', body: { benchmark: 'pelican', html }, apiKey: 'audit-key-only', signal: new AbortController().signal, taskKey: 'run-1' };
  const dependencies = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: transport(200, [Buffer.from('{"quality":"normal"}')]) };
  assert.deepEqual(await requestReviewJson('https://review.example.com/api', options, dependencies), { quality: 'normal' });
  assert.equal(captured[0].options.headers.authorization, 'Bearer audit-key-only');
  assert.equal(captured[0].options.headers['Idempotency-Key'], 'run-1');
  captured[0].options.lookup('changed.example.com', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
  await assert.rejects(requestReviewJson('https://review.example.com/api', options, { ...dependencies, request: transport(302, [], { location: 'http://127.0.0.1' }) }), /REVIEW_HTTP_ERROR/);
  await assert.rejects(requestReviewJson('https://review.example.com/api', options, { ...dependencies, request: transport(200, [Buffer.alloc(256 * 1024 + 1)]) }), /REVIEW_RESPONSE_TOO_LARGE/);
  assert.equal(captured.length, 3);
  await assert.rejects(requestReviewJson('https://review.example.com/api', options, { ...dependencies, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /REVIEW_URL_UNSAFE/);
  assert.equal(captured.length, 3);
});
