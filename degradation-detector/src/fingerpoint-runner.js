'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function runFingerprintWorker(input, signal, onEvent) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(path.join(__dirname, 'fingerpoint-worker.js'), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false; let timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort); clearTimeout(timer);
      worker.terminate().catch(() => {}).then(() => { if (error) reject(error); else resolve(); });
    };
    const abort = () => { worker.postMessage({ type: 'abort' }); timer = setTimeout(() => finish(new Error('MODEL_TIMEOUT')), 1000); timer.unref?.(); };
    worker.on('message', message => {
      if (settled) return;
      try {
        if (signal.aborted) return finish(new Error('MODEL_TIMEOUT'));
        if (message.type === 'error') return finish(new Error(message.code));
        if (message.type === 'done') return finish();
        onEvent(message);
      } catch (error) { finish(error); }
    });
    worker.once('error', () => finish(new Error(signal.aborted ? 'MODEL_TIMEOUT' : 'FINGERPOINT_EXECUTION_FAILED')));
    worker.once('exit', () => finish(new Error(signal.aborted ? 'MODEL_TIMEOUT' : 'FINGERPOINT_EXECUTION_FAILED')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

module.exports = { runFingerprintWorker };
