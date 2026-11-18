'use strict';

const { ConversationJsonlStore } = require('../conversation-jsonl-store');
const { failure } = require('./conversation-push-transport');
const { targetHash } = require('./conversation-push-policy');

class ConversationJsonlService {
  constructor(push, transport, options) {
    this.store = new ConversationJsonlStore(push, options).initialize(); this.transport = transport;
    this.stopping = false; this.active = null; this.lastError = ''; this.lastRun = null;
    this.canWork = options?.canWork || (() => true);
  }
  invalidate() { this.active?.controller.abort(); }
  async cleanup() {
    const file = this.store.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE upload_id!='' AND status!='running' AND next_at<=? ORDER BY updated_at LIMIT 1").get(this.store.now());
    if (!file) return false;
    const current = this.store.push.policy();
    const policy = targetHash(current, 's3') === file.target_hash ? current : this.store.push.policy(file.policy_version);
    const result = await this.transport.abortJsonl(policy, file);
    if (result.status === 'sent') this.store.clearUpload(file.id, file.upload_id);
    else this.store.db.prepare('UPDATE cl_push_jsonl_files SET next_at=? WHERE id=?').run(this.store.now() + 60000, file.id);
    return result.status === 'sent';
  }
  async tick() {
    if (this.stopping || !this.canWork()) return false;
    this.store.reconcile();
    let worked = this.store.cleanupMembers() > 0;
    for (let index = 0; index < 20 && !this.stopping && this.canWork(); index++) {
      if (!this.store.assignOne()) break;
      worked = true; await new Promise(resolve => setImmediate(resolve));
    }
    this.store.sealDue();
    if (await this.cleanup()) worked = true;
    const file = this.store.claim(); if (!file) return worked;
    const controller = new AbortController(); this.active = { file, controller };
    const policy = this.store.push.policy(), archiveVersion = this.store.archive.policy().version;
    const guard = () => {
      if (this.stopping || controller.signal.aborted) throw failure('ABORTED', true);
      try { this.store.guard(file, policy.version, archiveVersion); } catch { throw failure('DELIVERY_INVALIDATED', true); }
    };
    try {
      guard();
      const reason = this.store.invalidReason(file, { full: true });
      if (reason) { this.store.cancel(file, reason); return true; }
      const store = this.store;
      async function* envelopes() {
        try { yield* store.envelopes(file, guard); }
        catch (error) { throw failure(error.code === 'EXPORT_MEMORY' ? 'EXPORT_MEMORY' : 'DELIVERY_INVALIDATED', true); }
      }
      const result = await this.transport.sendJsonl(policy, file, envelopes(), controller.signal, {
        guard,
        onCreated: id => { if (!this.store.uploadId(file, id)) throw failure('DELIVERY_INVALIDATED', true); },
        beforeComplete: () => { if (this.store.invalidReason(file, { full: true })) throw failure('DELIVERY_INVALIDATED', true); }
      });
      this.store.finish(file, result); this.lastError = result.errorCode || ''; this.lastRun = this.store.now();
    } catch (error) {
      const code = error.code === 'EXPORT_MEMORY' ? 'EXPORT_MEMORY' : 'DELIVERY_INVALIDATED';
      this.store.finish(file, { status: 'failed', errorCode: code, retryable: true }); this.lastError = code;
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
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.invalidate(); await this.running; }
}

module.exports = { ConversationJsonlService };
