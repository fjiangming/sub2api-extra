'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function createPage() {
  const elements = new Map();
  const events = new Map();
  const timers = new Map();
  let time = 0;
  let timerId = 0;
  let requests = 0;
  let failure = null;
  let dialog = false;
  let defer = false;
  const pending = [];
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
    window: { end: '2026-10-16T03:00:00Z' }, entries: [user], me: user };
  const sandbox = { document, navigator, Intl, URLSearchParams, AbortController, AbortSignal,
    location: { search: '', pathname: '/', hash: '' }, history: { replaceState() {} },
    sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: { UsageAvatars: { set() {}, html: () => '' }, addEventListener: (name, listener) => events.set(name, listener) },
    fetch: async (url) => {
      if (url.includes('leaderboard?')) {
        requests++;
        if (defer) await new Promise((resolve) => pending.push(resolve));
        if (failure === 'network') throw new Error('offline');
        if (failure === 'auth') return { ok: false, status: 401, json: async () => ({ error: { message: '登录已失效' } }) };
        const period = new URLSearchParams(url.split('?')[1]).get('period');
        return { ok: true, json: async () => ({ ...structuredClone(board), period }) };
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
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  await settle();
  return { element, document, navigator, events, board, user, settle, advance,
    run: (script) => vm.runInContext(script, context),
    resolveRequest: (index = 0) => pending.splice(index, 1)[0](),
    get requests() { return requests; },
    set failure(value) { failure = value; },
    set dialog(value) { dialog = value; },
    set defer(value) { defer = value; } };
}

test('public polling preserves the board, pauses for visibility, offline and dialogs, backs off and stops on expired login', async () => {
  const page = await createPage();
  const { element, board, user, document, navigator, events, advance, settle } = page;
  assert.equal(page.requests, 1);
  assert.equal(element('usage-content').hidden, false);
  board.entries = [{ ...user, rank: 5 }];
  await advance(59000); assert.equal(page.requests, 1);
  await advance(1000); assert.equal(page.requests, 2);
  assert.equal(element('personal-title').textContent, '我的实际用量');
  assert.match(element('my-primary-value').innerHTML, /1\.70/);
  assert.doesNotMatch(element('podium').innerHTML + element('ranking-body').innerHTML,
    /<button|data-user-key|data-ranking-user|用量详情/);
  board.entries = [];
  await advance(60000); assert.equal(page.requests, 3);
  assert.equal(element('personal-title').textContent, '我的实际用量');
  assert.match(element('my-primary-value').innerHTML, /1\.70/);
  document.hidden = true; events.get('visibilitychange')();
  await advance(600000); assert.equal(page.requests, 3);
  document.hidden = false; events.get('visibilitychange')(); await settle(); assert.equal(page.requests, 4);
  navigator.onLine = false; events.get('offline')();
  await advance(600000); assert.equal(page.requests, 4);
  navigator.onLine = true; events.get('online')(); await settle(); assert.equal(page.requests, 5);
  page.dialog = true; await advance(60000); assert.equal(page.requests, 5);
  page.dialog = false; await advance(60000); assert.equal(page.requests, 6);
  page.failure = 'network'; await advance(60000); assert.equal(page.requests, 7);
  assert.equal(element('usage-content').hidden, false);
  assert.equal(element('page-status').hidden, true);
  await advance(119000); assert.equal(page.requests, 7);
  page.failure = 'auth'; await advance(1000); assert.equal(page.requests, 8);
  assert.equal(element('usage-content').hidden, true);
  assert.equal(element('login-link').hidden, false);
  await advance(600000); assert.equal(page.requests, 8);
});

test('manual refresh and revisiting a period render existing data while revalidating, and expired login clears it', async () => {
  const page = await createPage();
  const { element, run, settle } = page;
  page.defer = true;
  let request = run('loadBoard({ announce: true })');
  await settle();
  assert.equal(element('usage-content').hidden, false);
  assert.equal(element('page-status').hidden, true);
  assert.equal(element('refresh-button').disabled, true);
  page.resolveRequest(); await request;

  request = run("state.period = 'week'; loadBoard()");
  await settle();
  assert.equal(element('usage-content').hidden, true);
  page.resolveRequest(); await request;
  assert.match(element('table-caption').textContent, /本周/);

  request = run("state.period = 'today'; loadBoard()");
  await settle();
  assert.equal(element('usage-content').hidden, false);
  assert.match(element('table-caption').textContent, /今日/);
  page.resolveRequest(); await request;

  page.failure = 'network';
  request = run("state.period = 'week'; loadBoard()");
  await settle();
  assert.equal(element('usage-content').hidden, false);
  assert.match(element('table-caption').textContent, /本周/);
  page.resolveRequest(); await request;
  assert.equal(element('usage-content').hidden, false);
  assert.equal(element('page-status').hidden, true);

  page.failure = 'auth';
  request = run('loadBoard()');
  await settle();
  page.resolveRequest(); await request;
  assert.equal(element('usage-content').hidden, true);
  assert.equal(element('login-link').hidden, false);
  assert.equal(run('state.boards.size'), 0);
  assert.equal(run('state.data'), null);
});

test('period reuse is bounded by age and local day, and late responses cannot overwrite a newer selection', async () => {
  const page = await createPage();
  const { element, run, settle } = page;
  page.defer = true;
  const week = run("state.period = 'week'; loadBoard()");
  await settle();
  const today = run("state.period = 'today'; loadBoard()");
  await settle();
  assert.equal(element('usage-content').hidden, false);
  assert.match(element('table-caption').textContent, /今日/);
  page.resolveRequest(1); await today;
  page.resolveRequest(); await week;
  assert.match(element('table-caption').textContent, /今日/);
  assert.equal(run('state.boards.has("week")'), false);

  for (const expire of ['cached.receivedAt = Date.now() - 300001', "cached.day = '2000.01.01'"]) {
    run(`{ state.data = null; const cached = state.boards.get('today'); ${expire}; }`);
    const request = run('loadBoard()');
    await settle();
    assert.equal(element('usage-content').hidden, true);
    page.resolveRequest(); await request;
    assert.equal(element('usage-content').hidden, false);
  }
});
