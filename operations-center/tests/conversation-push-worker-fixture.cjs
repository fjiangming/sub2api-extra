'use strict';

process.once('message', message => {
  if (message?.type !== 'initialize') return process.exit(1);
  process.send({ type: 'ready' }, () => {
    // Keep the process alive without servicing IPC, timers or cancellation.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
});
