const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

test('Sub2API integration exposes the upstream Key pool batch editor', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.match(html, /id="sub2api-pool-config-dialog"/);
  assert.match(html, /name="retryCount" type="number" min="0" max="10"/);
  assert.match(html, /name="retryStatusCodes"[\s\S]*?value="401, 403, 429"/);
  assert.match(html, /仅合并更新这两项凭据/);
  assert.match(app, /data-action="open-sub2api-pool-config"/);
  assert.match(app, /api\('\/api\/sub2api\/accounts\/pool-config-targets'\)/);
  assert.match(app, /api\('\/api\/sub2api\/accounts\/pool-config'/);
  assert.match(app, /retryStatusCodes: parseSub2ApiPoolRetryStatusCodes/);
});

test('pool retry status code input accepts both comma styles, sorts and rejects invalid codes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function parseSub2ApiPoolRetryStatusCodes(value) {');
  const end = source.indexOf('\n\nasync function openSub2ApiPoolConfig()', start);
  assert.ok(start >= 0 && end > start);
  const functionSource = source.slice(start, end);
  const context = vm.createContext({});
  vm.runInContext(functionSource, context);

  const parsed = vm.runInContext("parseSub2ApiPoolRetryStatusCodes('503， 429 401,503')", context);
  assert.deepEqual(Array.from(parsed), [401, 429, 503]);
  assert.deepEqual(Array.from(vm.runInContext("parseSub2ApiPoolRetryStatusCodes('  ')", context)), []);
  assert.throws(
    () => vm.runInContext("parseSub2ApiPoolRetryStatusCodes('99, 429, nope')", context),
    /100–599/
  );
});
