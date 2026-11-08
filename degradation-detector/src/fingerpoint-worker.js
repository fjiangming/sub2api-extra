'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { securedModelFetch } = require('./fingerpoint-http');

async function main() {
  const controller = new AbortController();
  parentPort.on('message', message => { if (message?.type === 'abort') controller.abort(); });
  const sdk = await import('lmfpd-sdk');
  const config = { baseUrl: workerData.target_url, apiKey: workerData.key, model: workerData.model, api: workerData.api, effort: workerData.effort, count: workerData.count, parallel: workerData.parallel, strict: workerData.strict, timeout: workerData.timeout_seconds, stream: true };
  const prepared = sdk.buildRequest(config, 'validation');
  if (prepared.error) throw new Error('FINGERPOINT_CONFIG_INVALID');
  const network = securedModelFetch(prepared.url, controller.signal);
  globalThis.fetch = network.fetch;
  try {
    const detector = await sdk.loadDetector({ source: workerData.directory });
    for (let round = 1; round <= workerData.rounds && !controller.signal.aborted; round++) {
      const result = await detector.detect(config, {
        signal: controller.signal,
        onSample: (index, sample) => {
          if (['complete', 'truncated', 'failed', 'cancelled'].includes(sample.state)) parentPort.postMessage({ type: 'sample', round, index, sample });
        }
      });
      parentPort.postMessage({ type: 'round', result: { round, ...result } });
    }
    parentPort.postMessage({ type: 'done' });
  } finally { await network.close(); parentPort.close(); }
}

main().catch(() => { parentPort.postMessage({ type: 'error', code: 'FINGERPOINT_EXECUTION_FAILED' }); parentPort.close(); });
