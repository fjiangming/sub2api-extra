'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(process.argv[2] || '.');
const apply = process.argv.includes('--apply');
const files = new Map();
function edit(relative, transform) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', relative], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`Target has local changes: ${relative}`);
  files.set(target, transform(original));
}
function replace(source, before, after, expected = 1) {
  if (source.split(before).length - 1 !== expected) throw new Error(`Unsupported Sub2API source near: ${before.slice(0, 100)}`);
  return source.replaceAll(before, after);
}
function addImport(source, library) {
  return replace(source, 'import (\n', `import (\n\t"${library}"\n`);
}

edit('backend/internal/server/router.go', (source) => replace(source,
  '\tr.Use(middleware2.RequestLogger())', '\tr.Use(middleware2.LatencyTrace())\n\tr.Use(middleware2.RequestLogger())'));
edit('backend/internal/repository/http_upstream.go', (source) => {
  source = addImport(source, 'github.com/Wei-Shaw/sub2api/internal/pkg/latencytrace');
  source = replace(source, '\tresp, err := servertiming.Do(client, req)',
    '\treq, latencyAttempt := latencytrace.BeginAttempt(req, accountID)\n\tresp, err := servertiming.Do(client, req)\n\tlatencyAttempt.Headers(resp, err)', 2);
  return replace(source, '\tdecompressResponseBody(resp)',
    '\tdecompressResponseBody(resp)\n\tresp.Body = latencyAttempt.WrapBody(resp.Body)', 2);
});
edit('backend/internal/handler/request_body_limit.go', (source) => {
  source = addImport(source, 'github.com/Wei-Shaw/sub2api/internal/pkg/latencytrace');
  source = addImport(source, 'github.com/tidwall/gjson');
  return replace(source, '\treturn pkghttputil.ReadLenientJSONRequestBodyWithPrealloc(req, gatewayMaxBodySize(cfg))',
    '\tbody, err := pkghttputil.ReadLenientJSONRequestBodyWithPrealloc(req, gatewayMaxBodySize(cfg))\n' +
    '\tif err == nil && req != nil {\n' +
    '\t\teffort := gjson.GetBytes(body,"reasoning.effort").String()\n\t\tif effort == "" { effort = gjson.GetBytes(body,"reasoning_effort").String() }\n' +
    '\t\tlatencytrace.Mark(req.Context(), "prepare_start", latencytrace.Attributes{Model:gjson.GetBytes(body,"model").String(), Effort:effort})\n\t}\n\treturn body, err');
});
edit('backend/internal/handler/gateway_helper.go', (source) => {
  source = addImport(source, 'github.com/Wei-Shaw/sub2api/internal/pkg/latencytrace');
  return replace(source, '\t// Determine if ping is needed (streaming + ping format defined)',
    '\tlatencytrace.Mark(ctx, "queue_start", latencytrace.Attributes{})\n\tdefer latencytrace.Mark(ctx, "queue_end", latencytrace.Attributes{})\n\n\t// Determine if ping is needed (streaming + ping format defined)');
});
for (const [from, to] of [
  ['latencytrace/trace.go', 'backend/internal/pkg/latencytrace/trace.go'],
  ['latencytrace/trace_test.go', 'backend/internal/pkg/latencytrace/trace_test.go'],
  ['latency_middleware.go', 'backend/internal/server/middleware/latency_middleware.go'],
  ['latency_middleware_test.go', 'backend/internal/server/middleware/latency_middleware_test.go']
]) {
  const target = path.join(root, to);
  if (fs.existsSync(target)) throw new Error(`Target already exists: ${to}`);
  files.set(target, fs.readFileSync(path.join(__dirname, from), 'utf8'));
}
if (apply) {
  for (const [target, data] of files) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); }
  execFileSync('gofmt', ['-w', ...files.keys()].filter((file) => file === '-w' || file.endsWith('.go')), { cwd: root, stdio: 'inherit' });
}
console.log(`${apply ? 'Applied' : 'Validated'} latency instrumentation in ${files.size} files (${root})`);
