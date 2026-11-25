'use strict';

const { Readable } = require('node:stream');
const { performance } = require('node:perf_hooks');
const { failure } = require('./conversation-push-transport');

function abortable(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, signal.reason?.pushCode ? signal.reason : failure('ABORTED', true));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('ABORTED', true));
    const abort = () => { clearTimeout(timer); reject(failure('ABORTED', true)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function waitForTurn({ canWork, guard, signal, onPause = () => {} }) {
  guard();
  if (canWork()) return;
  onPause('archive_busy');
  try {
    while (!canWork()) { guard(); await delay(100, signal); }
    guard();
  } finally { onPause(''); }
}

async function prepareWithMemoryWait(prepare, { guard, checkpoint, onPause, timeoutMs = 30000, now = () => performance.now(), wait = delay }) {
  const deadline = now() + timeoutMs; let paused = false, backoff = 250;
  try {
    while (true) {
      await checkpoint(); guard();
      try { return prepare(); }
      catch (error) {
        if (error.code !== 'EXPORT_MEMORY' || now() >= deadline) throw error;
      }
      paused = true; onPause('memory_wait');
      const retryAt = Math.min(deadline, now() + backoff);
      while (now() < retryAt) { await wait(Math.min(100, retryAt - now())); guard(); }
      backoff = Math.min(4000, backoff * 2);
    }
  } finally { if (paused) onPause(''); }
}

function pacedBody(body, bytesPerSecond, signal, { now = () => performance.now(), wait = delay } = {}) {
  return Readable.from((async function* () {
    let next = now();
    for (let offset = 0; offset < body.length; offset += 65536) {
      if (signal?.aborted) throw failure('ABORTED', true);
      const chunk = body.subarray(offset, Math.min(body.length, offset + 65536));
      const at = Math.max(next, now());
      if (at > now()) await wait(at - now(), signal);
      next = at + chunk.length * 1000 / bytesPerSecond;
      yield chunk;
    }
  })(), { objectMode: false, highWaterMark: 65536 });
}

module.exports = { abortable, delay, waitForTurn, prepareWithMemoryWait, pacedBody };
