'use strict';

const { ConversationJsonlStore } = require('../conversation-jsonl-store');
const { performance } = require('node:perf_hooks');
const { failure, failureResult } = require('./conversation-push-transport');
const { targetHash,targetPolicy } = require('./conversation-push-policy');
const { delay, waitForTurn, withArchiveRetry } = require('./conversation-jsonl-flow');

const LEASE_RECOVERY_INTERVAL_MS = 30000;
const CHECKPOINT_TIMEOUT_MS = 120000;
const COLLECTION_BUDGET_MS = 100;
const DEFAULT_UPLOAD_CONCURRENCY = 2;
const MAX_UPLOAD_CONCURRENCY = 2;
const STREAMING_POLL_MS = 250;
const STREAMING_IDLE_MS = 5000;

function localFailure(error) {
  if (error.pushCode) return error;
  if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) return failure('ARCHIVE_BUSY', true);
  if (['EXPORT_MEMORY', 'EXPORT_REQUEST_ID'].includes(error.code)) return failure(error.code, error.code === 'EXPORT_MEMORY');
  return failure(error.message === 'DELIVERY_INVALIDATED' ? 'DELIVERY_INVALIDATED' : 'COPY_UNAVAILABLE', true);
}

class ConversationJsonlService {
  constructor(push, transport, options) {
    this.store = new ConversationJsonlStore(push, options).initialize(); this.transport = transport;
    this.stopping = false; this.active = null; this.activeUploads = new Map(); this.lastError = ''; this.lastRun = null;
    const requestedConcurrency = Number(options?.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY);
    this.uploadConcurrency = Number.isSafeInteger(requestedConcurrency) ? Math.max(1, Math.min(MAX_UPLOAD_CONCURRENCY, requestedConcurrency)) : DEFAULT_UPLOAD_CONCURRENCY;
    this.canWork = options?.canWork || (() => true);
    this.abortGraceMs = options?.abortGraceMs ?? 5000;
    this.archiveRetryMs = options?.archiveRetryMs ?? 5000;
    this.settlementRetryMs = options?.settlementRetryMs ?? 15000;
    this.nextCollectionAt = 0;
    this.busyUsers = 0; this.busyTimeout = null;
  }
  _syncActive() {
    const next = this.activeUploads.values().next().value;
    if (next) this.active = next;
    else if (this.active?.managed) this.active = null;
  }
  _activeCount() { return this.activeUploads.size || (this.active ? 1 : 0); }
  _activeValues() {
    const values = [...this.activeUploads.values()];
    if (!values.length && this.active) values.push(this.active);
    return values;
  }
  _acquireBusyTimeout() {
    if (this.busyUsers++ === 0) { this.busyTimeout = this.store.db.pragma('busy_timeout', { simple: true }); this.store.db.pragma('busy_timeout = 1'); }
  }
  _releaseBusyTimeout() {
    if (this.busyUsers <= 0 || --this.busyUsers) return;
    this.store.db.pragma(`busy_timeout = ${this.busyTimeout}`); this.busyTimeout = null;
  }
  _invalidateActive(active, code) {
    active.abortAt ??= performance.now();
    active.controller.abort(failure(code, true));
  }
  recoverExpired() {
    if (this.stopping) return;
    try {
      const now = this.store.now();
      for (const active of this._activeValues()) {
        const current = this.store.get(active.file.id);
        const activeStatus = active.file.streaming ? 'streaming' : 'running';
        if (current?.status !== activeStatus || current.lease_token !== active.file.lease_token) this._invalidateActive(active, 'DELIVERY_INVALIDATED');
        else if ((current.lease_until > 0 && current.lease_until <= now) ||
          performance.now() - active.lastCheckpointAt >= CHECKPOINT_TIMEOUT_MS) this._invalidateActive(active, 'UPLOAD_STALLED');
      }
      const recovered = this.store.recoverExpired();
      if (recovered) this.wake();
    } catch { this.lastError = 'JSONL_RECOVERY_RETRY'; }
  }
  invalidate(code = 'ABORTED') {
    for (const active of this._activeValues()) this._invalidateActive(active, code);
  }
  needsRestart() {
    return this._activeValues().some(active => active.abortAt != null && performance.now() - active.abortAt >= this.abortGraceMs);
  }
  async cleanup() {
    if (this.cleanupRunning) return this.cleanupRunning;
    this.cleanupRunning = (async () => {
    const file = this.store.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE upload_id!='' AND status NOT IN ('running','streaming') AND (status='cancelled' OR upload_version=0) AND next_at<=? ORDER BY updated_at LIMIT 1").get(this.store.now());
    if (!file) return false;
    const current = this.store.push.policy();
    const policy = targetPolicy(targetHash(current, file.destination) === file.target_hash ? current : this.store.push.policy(file.policy_version),file.destination);
    const result = await this.transport.abortJsonl(policy, file);
    if (result.status === 'sent') this.store.clearUpload(file.id, file.upload_id);
    else this.store.db.prepare("UPDATE cl_push_jsonl_files SET next_at=? WHERE id=? AND upload_id=? AND status NOT IN ('running','streaming')")
      .run(this.store.now() + 60000, file.id, file.upload_id);
    return result.status === 'sent';
    })().finally(() => { this.cleanupRunning = null; });
    return this.cleanupRunning;
  }
  collect() {
    if (this.collecting) return this.collecting;
    if (this.stopping || !this.canWork()) return Promise.resolve(false);
    this.collecting = (async () => {
      const started = performance.now(), duringUpload = this._activeCount() > 0;
      if (!duringUpload) this.store.reconcile();
      let worked = this.store.cleanupMembers() > 0;
      // Network waits must not freeze the next file's manifest. Yield between
      // records and bound each collection turn to protect foreground work.
      for (let index = 0; index < 20 && !this.stopping && this.canWork() && (!duringUpload || index === 0 || performance.now() - started < COLLECTION_BUDGET_MS); index++) {
        if (!this.store.assignOne()) break;
        worked = true; await new Promise(resolve => setImmediate(resolve));
      }
      if (!this.stopping && this.canWork()) this.store.sealDue();
      return worked;
    })().finally(() => { this.collecting = null; });
    return this.collecting;
  }
  async tick({ wait = true } = {}) {
    if (this.stopping || this._activeCount() >= this.uploadConcurrency || !this.canWork()) return false;
    let worked = await this.collect();
    if (this.stopping || !this.canWork()) return worked;
    if (await this.cleanup()) worked = true;
    if (this.stopping || !this.canWork()) return worked;
    if (this._activeCount() >= this.uploadConcurrency) return worked;
    const file = this.store.claim(); if (!file) return worked;
    const task = this._start(file);
    if (!wait) return true;
    await task;
    return true;
  }
  _start(file) {
    const controller = new AbortController(), active = { file, controller, lastCheckpointAt: performance.now(), abortAt: null, managed: true };
    this.activeUploads.set(file.id, active); this._syncActive(); this._acquireBusyTimeout();
    const task = this._run(active);
    active.promise = task;
    return task;
  }
  async _run(active) {
    const { file, controller } = active;
    let policy, archiveVersion, createdUploadId = '';
    const retry = async (action, options) => {
      try { return await withArchiveRetry(action, { timeoutMs: this.archiveRetryMs, ...options }); }
      catch (error) { throw localFailure(error); }
    };
    const check = () => {
      if (this.stopping || controller.signal.aborted) throw controller.signal.reason?.pushCode ? controller.signal.reason : failure('ABORTED', true);
      this.store.guard(file, policy.version, archiveVersion);
      active.lastCheckpointAt = performance.now();
    };
    const local = (action, timeoutMs = this.archiveRetryMs) => retry(() => { check(); return action(); }, { signal: controller.signal, timeoutMs });
    const guard = () => local(() => {});
    const checkpoint = () => waitForTurn({ canWork: this.canWork, guard, signal: controller.signal,
      onPause: reason => local(() => this.store.pause(file, reason)) });
    try {
      ({ policy, archiveVersion } = await retry(() => ({ policy: targetPolicy(this.store.push.policy(),file.destination),
        archiveVersion: this.store.archive.policy().version }), { signal: controller.signal }));
      const reason = await local(() => this.store.invalidReason(file, { full: true }));
      if (reason) { await local(() => this.store.cancel(file, reason)); return true; }
      const store = this.store;
      const streaming = Boolean(file.streaming);
      let observedRecords = file.records;
      let idleSince = performance.now();
      const waitForMembers = async () => {
        if (!streaming) return false;
        await checkpoint();
        let current = await local(() => store.get(file.id));
        if (!current || current.status !== 'streaming' || current.lease_token !== file.lease_token) throw failure('DELIVERY_INVALIDATED', true);
        if (current.records > observedRecords) { observedRecords = current.records; idleSince = performance.now(); return true; }
        if (current.sealed_at > 0) return false;
        while (performance.now() - idleSince < STREAMING_IDLE_MS) {
          await delay(STREAMING_POLL_MS, controller.signal);
          await checkpoint();
          current = await local(() => store.get(file.id));
          if (!current || current.status !== 'streaming' || current.lease_token !== file.lease_token) throw failure('DELIVERY_INVALIDATED', true);
          if (current.records > observedRecords) { observedRecords = current.records; idleSince = performance.now(); return true; }
          if (current.sealed_at > 0) return false;
        }
        // Release the upload slot while the open file is idle. Its multipart
        // checkpoint remains durable and the next worker can resume it after
        // pending sealed files have been serviced.
        return false;
      };
      async function* envelopes() {
        try { yield* store.envelopes(file, guard, checkpoint, local, { waitForMembers: streaming ? waitForMembers : undefined }); }
        catch (error) { throw localFailure(error); }
      }
      const result = await this.transport.sendJsonl(policy, file, envelopes(), controller.signal, {
        guard, checkpoint, restoredParts: await local(() => this.store.parts(file)),
        streaming, getFile: () => store.get(file.id),
        onCreated: id => { createdUploadId = id; return local(() => { if (!this.store.uploadId(file, id)) throw failure('DELIVERY_INVALIDATED', true); }); },
        onPart: (part, id) => local(() => { if (!this.store.savePart(file, id, part)) throw failure('DELIVERY_INVALIDATED', true); }),
        beforeComplete: () => local(() => { const current = this.store.get(file.id); if (!current || this.store.invalidReason(current, { full: true })) throw failure('DELIVERY_INVALIDATED', true); })
      });
      if (result.status === 'sent') await guard();
      const uploadId = createdUploadId || file.upload_id;
      if (uploadId && result.httpStatus === 404) {
        await local(() => this.store.clearUpload(file.id, uploadId, file.lease_token));
        Object.assign(result, { errorCode: 'MULTIPART_RESTART', retryable: true });
      } else if (uploadId && ['MULTIPART_CHECKPOINT_INVALID','JSONL_CONTENT_CHANGED','EXPORT_REQUEST_ID'].includes(result.errorCode)) {
        await local(() => this.store.abandonUpload(file, uploadId));
        if (result.errorCode === 'MULTIPART_CHECKPOINT_INVALID') result.retryable = true;
      }
      await local(() => this.store.finish(file, result), this.settlementRetryMs);
      this.lastError = result.errorCode || ''; this.lastRun = this.store.now();
    } catch (error) {
      const result = failureResult(localFailure(error));
      this.lastError = result.errorCode;
      // Cancellation must not prevent persisting a resumable failure receipt.
      try { await retry(() => this.store.finish(file, result), { timeoutMs: this.settlementRetryMs }); }
      catch (settleError) { this.lastError = settleError.pushCode; }
    } finally {
      try {
        if (createdUploadId) {
          const current = await retry(() => this.store.get(file.id));
          if (current?.upload_id !== createdUploadId && current?.status !== 'sent') await this.transport.abortJsonl(policy, { ...file, upload_id: createdUploadId });
        }
      } catch { this.lastError = 'JSONL_RECOVERY_RETRY'; }
      this.activeUploads.delete(file.id);
      if (this.active === active) this.active = null;
      this._syncActive();
      try { this.store.cleanupMembers(); } catch { this.lastError ||= 'ARCHIVE_BUSY'; }
      this._releaseBusyTimeout();
      // A started worker is woken immediately to fill the freed slot. Direct
      // tick() callers remain deterministic and can await one upload at a time.
      if (this.timer && !this.stopping) setImmediate(() => this.wake());
    }
    return true;
  }
  wake() {
    if (this.stopping) return;
    if (this._activeCount() >= this.uploadConcurrency) {
      if (this.collecting || performance.now() < this.nextCollectionAt) return;
      this.nextCollectionAt = performance.now() + 1000;
      this.collect().catch(error => { if (!/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) this.lastError = 'JSONL_QUEUE_FAILED'; });
      return;
    }
    if (this.running) return;
    this.running = (async () => {
      for (let index = 0; index < this.uploadConcurrency && !this.stopping; index++) {
        if (!await this.tick({ wait: false })) break;
        await new Promise(resolve => setImmediate(resolve));
      }
    })().catch(() => { this.lastError = 'JSONL_QUEUE_FAILED'; }).finally(() => { this.running = null; });
  }
  start() {
    if (this.timer) return;
    this.stopping = false; this.store.recover();
    this.recoveryTimer = setInterval(() => this.recoverExpired(), LEASE_RECOVERY_INTERVAL_MS); this.recoveryTimer.unref();
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); clearInterval(this.recoveryTimer); this.timer = null; this.recoveryTimer = null;
    this.invalidate(); await this.running; await this.collecting?.catch(() => {});
    await Promise.allSettled([...this.activeUploads.values()].map(active => active.promise));
  }
}

module.exports = { ConversationJsonlService };
