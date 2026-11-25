'use strict';

const { ConversationJsonlStore } = require('../conversation-jsonl-store');
const { performance } = require('node:perf_hooks');
const { failure, failureResult } = require('./conversation-push-transport');
const { targetHash,targetPolicy } = require('./conversation-push-policy');
const { waitForTurn, withArchiveRetry } = require('./conversation-jsonl-flow');

const LEASE_RECOVERY_INTERVAL_MS = 30000;
const CHECKPOINT_TIMEOUT_MS = 120000;
const COLLECTION_BUDGET_MS = 100;

function localFailure(error) {
  if (error.pushCode) return error;
  if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) return failure('ARCHIVE_BUSY', true);
  if (['EXPORT_MEMORY', 'EXPORT_REQUEST_ID'].includes(error.code)) return failure(error.code, error.code === 'EXPORT_MEMORY');
  return failure(error.message === 'DELIVERY_INVALIDATED' ? 'DELIVERY_INVALIDATED' : 'COPY_UNAVAILABLE', true);
}

class ConversationJsonlService {
  constructor(push, transport, options) {
    this.store = new ConversationJsonlStore(push, options).initialize(); this.transport = transport;
    this.stopping = false; this.active = null; this.lastError = ''; this.lastRun = null;
    this.canWork = options?.canWork || (() => true);
    this.abortGraceMs = options?.abortGraceMs ?? 5000;
    this.archiveRetryMs = options?.archiveRetryMs ?? 5000;
    this.settlementRetryMs = options?.settlementRetryMs ?? 15000;
    this.nextCollectionAt = 0;
  }
  recoverExpired() {
    if (this.stopping) return;
    try {
      const active = this.active, now = this.store.now();
      if (active) {
        const current = this.store.get(active.file.id);
        if (current?.status !== 'running' || current.lease_token !== active.file.lease_token) this.invalidate('DELIVERY_INVALIDATED');
        else if ((current.lease_until > 0 && current.lease_until <= now) ||
          performance.now() - active.lastCheckpointAt >= CHECKPOINT_TIMEOUT_MS) this.invalidate('UPLOAD_STALLED');
      }
      const recovered = this.store.recoverExpired();
      if (recovered) this.wake();
    } catch { this.lastError = 'JSONL_RECOVERY_RETRY'; }
  }
  invalidate(code = 'ABORTED') {
    if (!this.active) return;
    this.active.abortAt ??= performance.now();
    this.active.controller.abort(failure(code, true));
  }
  needsRestart() {
    return Boolean(this.active?.abortAt != null && performance.now() - this.active.abortAt >= this.abortGraceMs);
  }
  async cleanup() {
    const file = this.store.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE upload_id!='' AND status!='running' AND (status='cancelled' OR upload_version=0) AND next_at<=? ORDER BY updated_at LIMIT 1").get(this.store.now());
    if (!file) return false;
    const current = this.store.push.policy();
    const policy = targetPolicy(targetHash(current, file.destination) === file.target_hash ? current : this.store.push.policy(file.policy_version),file.destination);
    const result = await this.transport.abortJsonl(policy, file);
    if (result.status === 'sent') this.store.clearUpload(file.id, file.upload_id);
    else this.store.db.prepare("UPDATE cl_push_jsonl_files SET next_at=? WHERE id=? AND upload_id=? AND status!='running'")
      .run(this.store.now() + 60000, file.id, file.upload_id);
    return result.status === 'sent';
  }
  collect() {
    if (this.collecting) return this.collecting;
    if (this.stopping || !this.canWork()) return Promise.resolve(false);
    this.collecting = (async () => {
      const started = performance.now(), duringUpload = Boolean(this.active);
      if (!this.active) this.store.reconcile();
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
  async tick() {
    if (this.stopping || this.active || !this.canWork()) return false;
    let worked = await this.collect();
    if (this.stopping || !this.canWork()) return worked;
    if (await this.cleanup()) worked = true;
    if (this.stopping || !this.canWork()) return worked;
    const file = this.store.claim(); if (!file) return worked;
    const controller = new AbortController(), active = { file, controller, lastCheckpointAt: performance.now(), abortAt: null };
    const busyTimeout = this.store.db.pragma('busy_timeout', { simple: true });
    // Let lock owners run while this upload awaits an asynchronous retry.
    this.store.db.pragma('busy_timeout = 1');
    this.active = active;
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
      async function* envelopes() {
        try { yield* store.envelopes(file, guard, checkpoint, local); }
        catch (error) { throw localFailure(error); }
      }
      const result = await this.transport.sendJsonl(policy, file, envelopes(), controller.signal, {
        guard, checkpoint, restoredParts: await local(() => this.store.parts(file)),
        onCreated: id => { createdUploadId = id; return local(() => { if (!this.store.uploadId(file, id)) throw failure('DELIVERY_INVALIDATED', true); }); },
        onPart: (part, id) => local(() => { if (!this.store.savePart(file, id, part)) throw failure('DELIVERY_INVALIDATED', true); }),
        beforeComplete: () => local(() => { if (this.store.invalidReason(file, { full: true })) throw failure('DELIVERY_INVALIDATED', true); })
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
      this.active = null;
      try { this.store.cleanupMembers(); } catch { this.lastError ||= 'ARCHIVE_BUSY'; }
      this.store.db.pragma(`busy_timeout = ${busyTimeout}`);
    }
    return true;
  }
  wake() {
    if (this.stopping) return;
    if (this.active) {
      if (this.collecting || performance.now() < this.nextCollectionAt) return;
      this.nextCollectionAt = performance.now() + 1000;
      this.collect().catch(error => { if (!/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) this.lastError = 'JSONL_QUEUE_FAILED'; });
      return;
    }
    if (this.running) return;
    this.running = (async () => {
      for (let index = 0; index < 20 && !this.stopping; index++) {
        if (!await this.tick()) break;
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
  async stop() { this.stopping = true; clearInterval(this.timer); clearInterval(this.recoveryTimer); this.timer = null; this.recoveryTimer = null; this.invalidate(); await this.running; await this.collecting?.catch(() => {}); }
}

module.exports = { ConversationJsonlService };
