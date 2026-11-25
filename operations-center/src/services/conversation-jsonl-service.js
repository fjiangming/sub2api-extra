'use strict';

const { ConversationJsonlStore } = require('../conversation-jsonl-store');
const { performance } = require('node:perf_hooks');
const { failure, failureResult } = require('./conversation-push-transport');
const { targetHash,targetPolicy } = require('./conversation-push-policy');
const { waitForTurn } = require('./conversation-jsonl-flow');

const LEASE_RECOVERY_INTERVAL_MS = 30000;
const CHECKPOINT_TIMEOUT_MS = 120000;

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
  async tick() {
    if (this.stopping || this.active || !this.canWork()) return false;
    this.store.reconcile();
    let worked = this.store.cleanupMembers() > 0;
    for (let index = 0; index < 20 && !this.stopping && this.canWork(); index++) {
      if (!this.store.assignOne()) break;
      worked = true; await new Promise(resolve => setImmediate(resolve));
    }
    this.store.sealDue();
    if (await this.cleanup()) worked = true;
    if (this.stopping || !this.canWork()) return worked;
    const file = this.store.claim(); if (!file) return worked;
    const controller = new AbortController(), active = { file, controller, lastCheckpointAt: performance.now(), abortAt: null };
    this.active = active;
    const policy = targetPolicy(this.store.push.policy(),file.destination), archiveVersion = this.store.archive.policy().version;
    let uploadId = file.upload_id;
    const local = action => { try { return action(); } catch (error) { throw localFailure(error); } };
    const guard = () => {
      if (this.stopping || controller.signal.aborted) throw controller.signal.reason?.pushCode ? controller.signal.reason : failure('ABORTED', true);
      local(() => this.store.guard(file, policy.version, archiveVersion));
      active.lastCheckpointAt = performance.now();
    };
    const checkpoint = () => waitForTurn({ canWork: this.canWork, guard, signal: controller.signal,
      onPause: reason => local(() => this.store.pause(file, reason)) });
    try {
      guard();
      const reason = this.store.invalidReason(file, { full: true });
      if (reason) { this.store.cancel(file, reason); return true; }
      const store = this.store;
      async function* envelopes() {
        try { yield* store.envelopes(file, guard, checkpoint); }
        catch (error) { throw localFailure(error); }
      }
      const result = await this.transport.sendJsonl(policy, file, envelopes(), controller.signal, {
        guard, checkpoint, restoredParts: this.store.parts(file),
        onCreated: id => local(() => { uploadId = id; if (!this.store.uploadId(file, id)) throw failure('DELIVERY_INVALIDATED', true); }),
        onPart: (part, id) => local(() => { if (!this.store.savePart(file, id, part)) throw failure('DELIVERY_INVALIDATED', true); }),
        beforeComplete: () => local(() => { if (this.store.invalidReason(file, { full: true })) throw failure('DELIVERY_INVALIDATED', true); })
      });
      if (result.status === 'sent') guard();
      if (uploadId && this.store.get(file.id)?.upload_id !== uploadId) {
        // The remote creation succeeded but the lease could not persist it.
        await this.transport.abortJsonl(policy, { ...file, upload_id: uploadId });
      }
      if (uploadId && result.httpStatus === 404) {
        this.store.clearUpload(file.id, uploadId, file.lease_token);
        Object.assign(result, { errorCode: 'MULTIPART_RESTART', retryable: true });
      } else if (uploadId && ['MULTIPART_CHECKPOINT_INVALID','JSONL_CONTENT_CHANGED','EXPORT_REQUEST_ID'].includes(result.errorCode)) {
        this.store.abandonUpload(file, uploadId);
        if (result.errorCode === 'MULTIPART_CHECKPOINT_INVALID') result.retryable = true;
      }
      this.store.finish(file, result); this.lastError = result.errorCode || ''; this.lastRun = this.store.now();
    } catch (error) {
      const result = failureResult(localFailure(error));
      this.store.finish(file, result); this.lastError = result.errorCode;
    } finally { this.active = null; this.store.cleanupMembers(); }
    return true;
  }
  wake() {
    if (this.stopping || this.running) return;
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
  async stop() { this.stopping = true; clearInterval(this.timer); clearInterval(this.recoveryTimer); this.timer = null; this.recoveryTimer = null; this.invalidate(); await this.running; }
}

module.exports = { ConversationJsonlService };
