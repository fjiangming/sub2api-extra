'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Go's overlay compiles the integration against real core types without changing the checkout.
const root = path.resolve(process.argv[2] || path.join(__dirname, '../../../sub2api'));
if (!fs.existsSync(path.join(root, 'backend/go.mod'))) throw new Error('Pass the local Sub2API checkout as the first argument');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-error-telemetry-'));
try {
  const replacements = {};
  for (const file of ['trace.go', 'trace_test.go', 'delivery.go', 'delivery_test.go']) {
    replacements[path.join(root, 'backend/internal/pkg/latencytrace', file)] = path.join(__dirname, '../integrations/sub2api/latencytrace', file);
  }
  for (const file of ['latency_middleware.go', 'latency_middleware_test.go']) {
    replacements[path.join(root, 'backend/internal/server/middleware', file)] = path.join(__dirname, '../integrations/sub2api', file);
  }
  const overlay = path.join(directory, 'overlay.json');
  fs.writeFileSync(overlay, JSON.stringify({ Replace: replacements }));
  // vet cannot chdir into a virtual package directory on Windows; vet the physical standalone package separately.
  const physical = ['trace.go', 'trace_test.go', 'delivery.go', 'delivery_test.go'].map(file => path.join(__dirname, '../integrations/sub2api/latencytrace', file));
  const standalone = spawnSync('go', ['test', ...physical], { stdio: 'inherit', windowsHide: true });
  if (standalone.error) throw standalone.error;
  if (standalone.status) { process.exitCode = standalone.status; }
  else {
    const result = spawnSync('go', ['test', '-vet=off', '-overlay', overlay, '-timeout', '60s', '-run', 'TestLatencyTrace',
      './internal/server/middleware'], { cwd: path.join(root, 'backend'), stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally {
  if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('sub2api-error-telemetry-')) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
