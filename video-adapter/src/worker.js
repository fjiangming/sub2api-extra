'use strict';

const crypto = require('node:crypto');
const { ensure } = require('./errors');
const { decrypt } = require('./security');
const { decimal, money } = require('./money');

class Worker {
  constructor(store,registry,cache,config,catalog) {
    this.store = store; this.registry = registry; this.cache = cache; this.config = config;
    this.catalog = catalog;
    this.owner = crypto.randomUUID(); this.running = new Set(); this.stopped = true;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(() => console.error(JSON.stringify({ event:'worker_tick_failed' }))), 500);
    this.timer.unref();
    void this.tick().catch(() => console.error(JSON.stringify({ event:'worker_tick_failed' })));
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tickPromise?.catch(() => {});
    await Promise.allSettled([...this.running]);
  }
  tick() {
    if (this.stopped || this.tickPromise) return this.tickPromise || Promise.resolve();
    this.tickPromise = this.dispatch().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  async dispatch() {
    if (!(await this.cache.flush())) return;
    await this.cache.ping();
    while (!this.stopped && this.running.size < this.config.workerConcurrency) {
      const job = await this.store.claim(`${this.owner}:${crypto.randomUUID()}`);
      if (!job) break;
      if (this.stopped) { await this.store.unlock(job); break; }
      const work = this.process(job).catch(error => console.error(JSON.stringify({ event:'worker_job_failed',jobId:job.id,code:error.code || 'INTERNAL_ERROR' }))).finally(() => this.running.delete(work));
      this.running.add(work);
    }
  }

  async process(original) {
    let job = original;
    try {
      const snapshot = decrypt(job.secret_snapshot,this.config.encryptionKey);
      const { provider } = snapshot;
      if (job.funds_state==='captured') {
        const status = await this.registry.status(provider,job.upstream_id);
        ensure(!status.id || status.id===job.upstream_id,'TASK_ID_MISMATCH','Supplier returned a different task identity',502);
        if (status.funds==='refunded') await this.store.refundCaptured(job.id,{ source:'supplier_funds',funds:'refunded' },job.lease_owner);
        else await this.store.update(job,{},1800000);
        return;
      }
      if (Date.now() - new Date(job.created_at).getTime() > this.config.maxTaskAgeMs) {
        await this.store.update(job,{ state:'review',last_code:'TASK_AGE_REVIEW' },0,'review'); return;
      }
      if (['queued','submitting','unknown'].includes(job.state) && !job.upstream_id) {
        const disabled = this.catalog && !this.catalog.providers.some(p => p.id===provider.id && p.enabled);
        if (disabled) {
          if (job.state==='queued' && job.attempts===0) await this.store.settle(job.id,{ charge:'0',supplierCost:'0',owner:job.lease_owner,proof:{ source:'not_submitted',reason:'PROVIDER_DISABLED' } });
          else await this.store.update(job,{ state:'review',last_code:'PROVIDER_DISABLED_UNKNOWN_OPERATION' },0,'review');
          return;
        }
        const paused = await this.store.db.query('SELECT paused FROM video_adapter.provider_controls WHERE provider_id=$1',[provider.id]);
        if (paused.rows[0]?.paused) { await this.store.update(job,{ state:'review',last_code:'PROVIDER_PAUSED' },0,'review'); return; }
        const retry = job.state!=='queued';
        const withinRetention = () => Date.now()+this.config.requestTimeoutMs < new Date(job.created_at).getTime()+provider.idempotencyRetentionSeconds*1000;
        if (job.state !== 'queued' && (!provider.idempotentCreate || job.attempts >= 3)) {
          await this.store.update(job,{ state:'review',last_code:'CREATE_OUTCOME_UNKNOWN' },0,'review'); return;
        }
        if (retry && !withinRetention()) {
          await this.store.update(job,{ state:'review',last_code:'IDEMPOTENCY_RETENTION_EXPIRED' },0,'review'); return;
        }
        if (job.state==='queued' && new Date(snapshot.model.cost.expiresAt)<=new Date()) {
          await this.store.settle(job.id,{ charge:'0',supplierCost:'0',owner:job.lease_owner,proof:{ source:'not_submitted',reason:'COST_CARD_EXPIRED' } }); return;
        }
        if (job.state!=='queued' && new Date(snapshot.model.cost.expiresAt)<=new Date()) {
          await this.store.update(job,{ state:'review',last_code:'COST_CARD_EXPIRED_UNKNOWN_OPERATION' },0,'review'); return;
        }
        job = await this.store.update(job,{ state:'submitting',attempts:job.attempts+1 },0,'submission_started');
        if (retry && !withinRetention()) {
          await this.store.update(job,{ state:'review',last_code:'IDEMPOTENCY_RETENTION_EXPIRED' },0,'review'); return;
        }
        // The encrypted original body and original provider credential are reused verbatim.
        const accepted = await this.registry.create(provider,snapshot.supplierBody,job.id);
        ensure(accepted.id, 'CREATE_ID_MISSING', 'Supplier did not return a recoverable task ID',502);
        job = await this.store.update(job,{ upstream_id:accepted.id,state:'running',upstream_status:accepted.status || null,progress:accepted.progress ?? null,last_code:null },this.config.pollIntervalMs,'accepted');
        await this.observe(job,snapshot,accepted);
      } else {
        ensure(job.upstream_id, 'UPSTREAM_ID_MISSING', 'Task has no supplier ID',502);
        const status = await this.registry.status(provider,job.upstream_id);
        ensure(!status.id || status.id === job.upstream_id, 'TASK_ID_MISMATCH', 'Supplier returned a different task identity',502);
        job = await this.store.update(job,{ upstream_status:status.status || null,progress:status.progress ?? null,last_code:null },this.config.pollIntervalMs);
        await this.observe(job,snapshot,status);
      }
    } catch (error) {
      if (error.code === 'LEASE_LOST') return;
      try {
        if (job.funds_state==='captured') { await this.store.update(job,{ last_code:'REFUND_AUDIT_UNAVAILABLE' },1800000); return; }
        const snapshot = decrypt(job.secret_snapshot,this.config.encryptionKey);
        const isCreate = job.state === 'submitting' && !job.upstream_id;
        const delay = Math.max(this.config.pollIntervalMs, error.retryAfterMs || 0);
        const permanent = error.upstreamStatus && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 429;
        const state = isCreate ? (snapshot.provider.idempotentCreate && job.attempts < 3 && !permanent ? 'unknown' : 'review') : permanent ? 'review' : 'running';
        await this.store.update(job,{ state, last_code:error.code || 'UPSTREAM_UNAVAILABLE' },delay, state === 'review' ? 'review' : 'retry_scheduled');
      } catch { console.error(JSON.stringify({ event:'worker_state_update_failed',jobId:job.id })); }
    } finally { await this.store.unlock(job).catch(() => {}); }
  }

  async observe(job,snapshot,status) {
    const { provider, cost, model } = snapshot;
    if (provider.financialMode === 'funds_status' && ['released','refunded'].includes(status.funds)) {
      await this.store.settle(job.id,{ charge:'0',supplierCost:'0',owner:job.lease_owner,proof:{ source:'supplier_funds',funds:status.funds,upstreamModel:model.upstreamModel } }); return;
    }
    if (status.amount != null && decimal(status.amount).gt(cost.quotedAmountBound)) {
      await this.store.pause(provider.id,'SUPPLIER_QUOTE_EXCEEDS_BOUND');
      await this.store.update(job,{ state:'review',last_code:'SUPPLIER_COST_OVERRUN' },0,'review'); return;
    }
    if (status.review) { await this.store.update(job,{ state:'review',last_code:'SUPPLIER_REVIEW' },0,'review'); return; }
    if (status.failed) { await this.store.update(job,{ state:'review',last_code:'FAILURE_FINANCIAL_REVIEW' },0,'review'); return; }
    if (!status.completed) return;
    if (provider.financialMode === 'manual') { await this.store.update(job,{ state:'review',last_code:'FINANCIAL_PROOF_REQUIRED' },0,'review'); return; }
    if (provider.financialMode === 'funds_status' && (status.funds !== 'captured' || status.amount == null)) return;
    const observedCost = provider.financialMode === 'funds_status' ? money(decimal(status.amount).mul(cost.feeMultiplier).plus(cost.fixedFee).mul(cost.usdPerUnit)) : cost.capUsd;
    await this.store.settle(job.id,{ charge:job.hold_usd,supplierCost:observedCost,owner:job.lease_owner,
      proof:{ source:provider.financialMode === 'funds_status' ? 'supplier_funds' : 'verified_contract_upper_bound',funds:status.funds || null,upstreamModel:model.upstreamModel,estimated:provider.financialMode !== 'funds_status' } });
  }
}

module.exports = { Worker };
