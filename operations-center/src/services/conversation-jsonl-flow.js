'use strict';

const { Readable } = require('node:stream');
const { performance } = require('node:perf_hooks');
const { failure } = require('./conversation-push-transport');

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

module.exports = { delay, waitForTurn, pacedBody };
