'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('public polling preserves the board, pauses for visibility, offline and dialogs, backs off and stops on expired login', async () => {
  const elements = new Map();
  const events = new Map();
  const timers = new Map();
  let time = 0;
  let timerId = 0;
  let requests = 0;
  let failure = null;
  let dialog = false;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, style: {}, classList: { toggle() {} },
      setAttribute() {}, addEventListener() {}, querySelector: () => element(`${id}-child`) });
    return elements.get(id);
  };
  const document = { hidden: false, body: { dataset: {} }, getElementById: element,
    querySelector: (selector) => selector === 'dialog[open]' ? dialog : element(selector),
    querySelectorAll: () => [], addEventListener: (name, listener) => events.set(name, listener) };
  const navigator = { onLine: true };
  const user = { key: 'real', name: 'us***@example.com', tokens: 1700123, requests: 1, rank: 1, eligible: true,
    rankingAvailable: true, models: [], trendTotal: 0, trend: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${10 + i}`, tokens: 0 })) };
  const board = { period: 'today', metric: 'tokens', generatedAt: '2026-10-16T03:00:00Z', timezone: 'Asia/Shanghai',
    window: { end: '2026-10-16T03:00:00Z' }, display: { mode: 'real', simulatedCount: 0, realCount: 1 },
    summary: { tokens: 1700123, requests: 1, active: 1 }, entries: [user], me: user };
  const sandbox = { document, navigator, Intl, URLSearchParams, AbortController, AbortSignal,
    location: { search: '', pathname: '/', hash: '' }, history: { replaceState() {} },
    sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: { UsageAvatars: { set() {}, html: () => '' }, addEventListener: (name, listener) => events.set(name, listener) },
    fetch: async (url) => {
      if (url.includes('leaderboard?')) {
        requests++;
        if (failure === 'network') throw new Error('offline');
        if (failure === 'auth') return { ok: false, status: 401, json: async () => ({ error: { message: '登录已失效' } }) };
        return { ok: true, json: async () => structuredClone(board) };
      }
      return { ok: true, json: async () => url.endsWith('auth/config') ? { sub2apiUrl: 'https://main.example.com', timezone: 'Asia/Shanghai' } : { user } };
    }
  };
  const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const advance = async (milliseconds) => {
    time += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.run(); }
    await settle();
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), sandbox);
  await settle();
  assert.equal(requests, 1);
  assert.equal(element('usage-content').hidden, false);
  await advance(59000); assert.equal(requests, 1);
  await advance(1000); assert.equal(requests, 2);
  document.hidden = true; events.get('visibilitychange')();
  await advance(600000); assert.equal(requests, 2);
  document.hidden = false; events.get('visibilitychange')(); await settle(); assert.equal(requests, 3);
  navigator.onLine = false; events.get('offline')();
  await advance(600000); assert.equal(requests, 3);
  navigator.onLine = true; events.get('online')(); await settle(); assert.equal(requests, 4);
  dialog = true; await advance(60000); assert.equal(requests, 4);
  dialog = false; await advance(60000); assert.equal(requests, 5);
  failure = 'network'; await advance(60000); assert.equal(requests, 6);
  assert.equal(element('usage-content').hidden, false);
  assert.equal(element('page-status').hidden, true);
  await advance(119000); assert.equal(requests, 6);
  failure = 'auth'; await advance(1000); assert.equal(requests, 7);
  assert.equal(element('usage-content').hidden, true);
  assert.equal(element('login-link').hidden, false);
  await advance(600000); assert.equal(requests, 7);
});
