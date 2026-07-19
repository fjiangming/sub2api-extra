const test = require('node:test');
const assert = require('node:assert/strict');
const { DetectionService } = require('../src/services/detection-service');

test('provider detection uses official hostnames and public status fingerprints as suggestions', async () => {
  let calls = 0;
  const official = new DetectionService({ http: { async requestJson() { calls += 1; throw new Error('not expected'); } } });
  const deepseek = await official.detect('https://api.deepseek.com');
  assert.equal(deepseek.recommended.adapterType, 'deepseek');
  assert.equal(calls, 0);

  const statusBased = new DetectionService({
    http: {
      async requestJson(input) {
        const url = new URL(input);
        if (url.pathname === '/api/status') {
          return { status: 200, data: { success: true, data: { system_name: 'Veloera', quota_per_unit: 500000 } } };
        }
        throw new Error(`Unexpected ${url.pathname}`);
      }
    }
  });
  const veloera = await statusBased.detect('https://gateway.example');
  assert.equal(veloera.recommended.adapterType, 'veloera');
  assert.equal(veloera.ambiguous, false);
});
