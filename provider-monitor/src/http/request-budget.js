const { AppError } = require('../errors');
const { setMaxListeners } = require('node:events');

class RequestBudget {
  constructor(timeoutMs, { signal } = {}) {
    this.deadline = Date.now() + Math.max(0, timeoutMs);
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    // A report deliberately shares cancellation across every supplier and queue.
    setMaxListeners(0, this.signal);
    this.parent = signal;
    this.onAbort = () => this.controller.abort(signal.reason);
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(() => this.expire(), Math.max(0, timeoutMs));
  }

  expire() {
    this.controller.abort(new AppError('TIMEOUT', 'Provider read budget exceeded', { status: 504, retryable: true }));
  }

  check() {
    if (Date.now() >= this.deadline) this.expire();
    if (this.signal.aborted) throw this.signal.reason instanceof AppError ? this.signal.reason :
      new AppError('TIMEOUT', 'Provider read cancelled or timed out', { status: 504, retryable: true });
  }

  async wait(operation) {
    // Observe late failures even if the deadline has already expired.
    const pending = Promise.resolve(operation);
    pending.catch(() => {});
    this.check();
    let onAbort;
    try {
      const result = await Promise.race([pending, new Promise((_, reject) => {
        onAbort = () => { try { this.check(); } catch (error) { reject(error); } };
        this.signal.addEventListener('abort', onAbort, { once: true });
      })]);
      this.check();
      return result;
    } finally { this.signal.removeEventListener('abort', onAbort); }
  }

  run(operation) {
    return this.wait(Promise.resolve().then(() => { this.check(); return operation(); }));
  }

  dispose() {
    clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.onAbort);
  }
}

module.exports = { RequestBudget };
