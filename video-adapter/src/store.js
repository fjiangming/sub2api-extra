'use strict';

const crypto = require('node:crypto');
const { ensure } = require('./errors');
const { parseCoreJson } = require('./core-json');
const { checkIp, encrypt, hash } = require('./security');
const { decimal, money, enforceMargin } = require('./money');
const { resolveSellingPrice } = require('./pricing');

const windowSpecs = [{ label: '5h', hours: 5 }, { label: '1d', hours: 24 }, { label: '7d', hours: 168 }];

async function event(tx, jobId, kind, payload = {}) {
  await tx.query('INSERT INTO video_adapter.events (job_id, kind, payload) VALUES ($1, $2, $3::jsonb)', [jobId, kind, JSON.stringify(payload)]);
}

async function invalidate(tx, userId, keyId) {
  const keys = await tx.query('SELECT key FROM api_keys WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
  for (const key of keys.rows) await tx.query('INSERT INTO auth_cache_invalidation_outbox (cache_key) VALUES ($1)', [hash(key.key)]);
  await tx.query('INSERT INTO video_adapter.cache_outbox (user_id, api_key_id) VALUES ($1,$2)', [userId, keyId]);
}

class Store {
  constructor(db, config, cache) { this.db = db; this.config = config; this.cache = cache; }

  async identity(token, ip, tx = this.db, creation = false) {
    ensure(token && token.length <= 128, 'INVALID_API_KEY', 'Invalid API key', 401);
    const result = await tx.query(`SELECT row_to_json(k)::text AS key_json,
      json_build_object('id',u.id,'status',u.status,'concurrency',u.concurrency,'rpm_limit',u.rpm_limit,'restrict_public_groups',u.restrict_public_groups)::text AS user_json,
      row_to_json(g)::text AS group_json,
      r.rate_multiplier::text AS user_rate, r.rpm_override,
      EXISTS(SELECT 1 FROM user_allowed_groups a WHERE a.user_id=u.id AND a.group_id=g.id) AS allowed
      FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=k.group_id
      LEFT JOIN user_group_rate_multipliers r ON r.user_id=u.id AND r.group_id=g.id
      WHERE k.key=$1 AND k.deleted_at IS NULL AND u.deleted_at IS NULL AND g.deleted_at IS NULL`, [token]);
    const row = result.rows[0];
    ensure(row, 'INVALID_API_KEY', 'Invalid API key', 401);
    const identity = { key:parseCoreJson(row.key_json),usr:parseCoreJson(row.user_json),grp:parseCoreJson(row.group_json),user_rate:row.user_rate,rpm_override:row.rpm_override,allowed:row.allowed };
    const { key, usr, grp } = identity;
    const readStatuses = ['active', 'expired', 'quota_exhausted'];
    ensure((creation ? key.status === 'active' : readStatuses.includes(key.status)) && usr.status === 'active' && grp.status === 'active', 'KEY_DISABLED', 'API key, user or group is disabled', 403);
    ensure(this.config.groupIds.includes(String(grp.id)), 'GROUP_NOT_ENABLED', 'This group is not enabled for the video adapter', 403);
    ensure(!grp.is_exclusive && !usr.restrict_public_groups || identity.allowed, 'GROUP_ACCESS_DENIED', 'User cannot access this group', 403);
    checkIp(key, ip);
    if (creation) {
      ensure(grp.subscription_type === 'standard', 'SUBSCRIPTION_UNSUPPORTED', 'Only balance-billed video groups are supported', 403);
      ensure(grp.platform !== 'composite', 'COMPOSITE_UNSUPPORTED', 'Use a dedicated video group without composite routing', 403);
      ensure(grp.allow_image_generation, 'MEDIA_DISABLED', 'Group media generation permission is disabled', 403);
      ensure(!key.expires_at || new Date(key.expires_at) > new Date(), 'KEY_EXPIRED', 'API key has expired', 403);
      const quota = await tx.query(`SELECT 1 FROM user_platform_quotas WHERE user_id=$1 AND platform=$2 AND deleted_at IS NULL
        AND (daily_limit_usd IS NOT NULL OR weekly_limit_usd IS NOT NULL OR monthly_limit_usd IS NOT NULL) LIMIT 1`,[usr.id,grp.platform]);
      ensure(!quota.rows.length,'PLATFORM_QUOTA_UNSUPPORTED','Native user-platform quotas require a separate integration; video creation is disabled for this policy',403);
    }
    return identity;
  }

  async findIdempotent(keyId, idempotencyKey, requestHash) {
    const { rows } = await this.db.query('SELECT * FROM video_adapter.jobs WHERE api_key_id=$1 AND idempotency_key=$2', [keyId, idempotencyKey]);
    if (rows[0]) ensure(rows[0].request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with different request bytes', 409);
    return rows[0];
  }

  async reserve({ token, ip, model, provider, request, rawHash, idempotencyKey, cost, supplierBody, catalogVersion }) {
    return this.db.tx(async tx => {
      // One database lock serializes budgets across all instances, not just this process.
      await tx.query('SELECT id FROM video_adapter.budget_lock WHERE id=1 FOR UPDATE');
      const who = await this.identity(token, ip, tx, true);
      const existing = await tx.query('SELECT * FROM video_adapter.jobs WHERE api_key_id=$1 AND idempotency_key=$2', [who.key.id, idempotencyKey]);
      if (existing.rows[0]) {
        ensure(existing.rows[0].request_hash === rawHash, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with different request bytes', 409);
        return existing.rows[0];
      }
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [who.usr.id]);
      await tx.query('SELECT id FROM api_keys WHERE id=$1 FOR UPDATE', [who.key.id]);
      const locked = await this.identity(token, ip, tx, true);
      ensure(!locked.grp.model_allowlist?.enabled || locked.grp.model_allowlist.models?.includes(request.model), 'MODEL_DENIED', 'Model is not in the Sub2API group allowlist', 403);
      const sale = await this.price(tx, locked, request);
      const margin = enforceMargin(sale.saleUsd, cost.capUsd, this.config, locked.grp);
      const account = await tx.query('SELECT id FROM accounts WHERE id=$1 AND deleted_at IS NULL', [this.config.usageAccountId]);
      ensure(account.rows.length, 'ATTRIBUTION_ACCOUNT_MISSING', 'Usage attribution account is missing', 503);
      const control = await tx.query('SELECT paused FROM video_adapter.provider_controls WHERE provider_id=$1', [provider.id]);
      ensure(!control.rows[0]?.paused, 'PROVIDER_PAUSED', 'Provider is paused pending review', 503);
      const count = await tx.query("SELECT count(*)::int AS active FROM video_adapter.jobs WHERE user_id=$1 AND funds_state='held'", [locked.usr.id]);
      ensure(count.rows[0].active < Math.min(this.config.maxActiveJobsPerUser, locked.usr.concurrency || 1), 'ACTIVE_JOB_LIMIT', 'Active video task limit reached', 429);
      const budget = await tx.query(`SELECT COALESCE(SUM(CASE WHEN funds_state IN ('released','refunded') THEN 0 WHEN funds_state='held' THEN cost_cap_usd ELSE supplier_cost_usd END),0)::text AS total,
        COALESCE(SUM(CASE WHEN provider_id=$1 THEN CASE WHEN funds_state IN ('released','refunded') THEN 0 WHEN funds_state='held' THEN cost_cap_usd ELSE supplier_cost_usd END ELSE 0 END),0)::text AS provider_total
        FROM video_adapter.jobs WHERE created_at>=NOW()-INTERVAL '24 hours' OR funds_state='held'`, [provider.id]);
      ensure(decimal(budget.rows[0].total).plus(cost.capUsd).lte(this.config.dailyCostBudgetUsd) && decimal(budget.rows[0].provider_total).plus(cost.capUsd).lte(provider.dailyCostBudgetUsd), 'COST_BUDGET_EXCEEDED', 'Rolling supplier cost budget is exhausted', 429);
      const amount = sale.saleUsd;
      ensure(decimal(locked.key.quota).isZero() || decimal(locked.key.quota_used).plus(amount).lte(locked.key.quota), 'KEY_QUOTA_EXCEEDED', 'API key quota cannot cover this task', 403);
      const windows = {};
      for (const spec of windowSpecs) {
        const start = locked.key[`window_${spec.label}_start`];
        const valid = start && new Date(start).getTime() + spec.hours * 3600000 > Date.now();
        const used = valid ? locked.key[`usage_${spec.label}`] : '0';
        const limit = locked.key[`rate_limit_${spec.label}`];
        ensure(decimal(limit).isZero() || decimal(used).plus(amount).lte(limit), 'KEY_WINDOW_LIMIT', `API key ${spec.label} spending limit cannot cover this task`, 429);
        const newStart = valid ? start : new Date().toISOString();
        windows[spec.label] = newStart;
        await tx.query(`UPDATE api_keys SET usage_${spec.label}=$1, window_${spec.label}_start=$2 WHERE id=$3`, [money(decimal(used).plus(amount)), newStart, locked.key.id]);
      }
      const held = await tx.query(`UPDATE users SET balance=balance-$1, frozen_balance=frozen_balance+$1, updated_at=NOW()
        WHERE id=$2 AND balance >= $1 RETURNING id`, [amount, locked.usr.id]);
      ensure(held.rows.length, 'INSUFFICIENT_BALANCE', 'Available balance cannot cover the complete video price', 402);
      ensure(this.cache,'CACHE_UNAVAILABLE','Native rate enforcement is unavailable',503);
      await this.cache.enforceRpm(locked);
      await tx.query('UPDATE api_keys SET quota_used=quota_used+$1, last_used_at=NOW(), updated_at=NOW() WHERE id=$2', [amount, locked.key.id]);
      const id = `va_${crypto.randomUUID().replaceAll('-', '')}`;
      const economics = { revenueFactor:this.config.revenueFactor,minMargin:margin.minMargin,overheadUsd:this.config.overheadUsd,
        maxJobCostUsd:this.config.maxJobCostUsd,profitSafetyBuffer:locked.grp.profit_control_enabled ? locked.grp.profit_safety_buffer : '0' };
      const pricing = { sale, cost, margin, economics, catalogVersion, windows,
        delivery:{ maxDownloads:this.config.maxDownloadsPerJob,maxBytes:512*1024*1024 } };
      const secrets = encrypt({ provider, model, supplierBody, cost, request }, this.config.encryptionKey);
      const { rows } = await tx.query(`INSERT INTO video_adapter.jobs
        (id,user_id,api_key_id,group_id,account_id,provider_id,model,idempotency_key,request_hash,request_spec,secret_snapshot,pricing_snapshot,hold_usd,cost_cap_usd)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14) RETURNING *`,
      [id, locked.usr.id, locked.key.id, locked.grp.id, this.config.usageAccountId, provider.id, request.model, idempotencyKey, rawHash,
        JSON.stringify({ model: request.model, duration: request.duration, resolution: request.resolution, aspect_ratio: request.aspect_ratio }), secrets, JSON.stringify(pricing), amount, cost.capUsd]);
      await event(tx, id, 'reserved', { holdUsd: amount, costCapUsd: cost.capUsd, saleSource: sale.source });
      await invalidate(tx, locked.usr.id, locked.key.id);
      return rows[0];
    });
  }

  async price(tx, who, request) {
    const channels = await tx.query(`SELECT p.*, c.model_mapping, c.billing_model_source,
      COALESCE((SELECT json_agg(i ORDER BY i.sort_order,i.id) FROM channel_pricing_intervals i WHERE i.pricing_id=p.id),'[]')::text AS intervals_json
      FROM channel_groups cg JOIN channels c ON c.id=cg.channel_id JOIN channel_model_pricing p ON p.channel_id=c.id
      WHERE cg.group_id=$1 AND c.status='active' AND p.platform=$2 ORDER BY p.id`, [who.grp.id, who.grp.platform]);
    const mapping = channels.rows[0]?.model_mapping?.[who.grp.platform];
    ensure(!mapping || !Object.keys(mapping).length, 'CHANNEL_MAPPING_UNSUPPORTED', 'Use public video model IDs directly; channel model remapping is not supported', 409);
    return resolveSellingPrice(who.grp, who.user_rate, channels.rows.map(row => ({ ...row,intervals:parseCoreJson(row.intervals_json) })), request, this.config);
  }

  async getOwned(id, who) {
    const { rows } = await this.db.query('SELECT * FROM video_adapter.jobs WHERE id=$1 AND user_id=$2 AND api_key_id=$3 AND group_id=$4', [id, who.usr.id, who.key.id, who.grp.id]);
    ensure(rows[0], 'TASK_NOT_FOUND', 'Video task not found', 404);
    return rows[0];
  }

  async claimDownload(job) {
    const result = await this.db.query(`UPDATE video_adapter.jobs SET download_requests=download_requests+1
      WHERE id=$1 AND state='completed' AND funds_state IN ('captured','refunded') AND download_requests<$2 RETURNING id`,
    [job.id,job.pricing_snapshot.delivery.maxDownloads]);
    ensure(result.rows.length,'DOWNLOAD_BUDGET_EXCEEDED','This task has used its download request allowance',429);
  }

  async claim(owner) {
    return this.db.tx(async tx => {
      const { rows } = await tx.query(`SELECT * FROM video_adapter.jobs WHERE
        ((funds_state='held' AND state NOT IN ('review','completed','failed')) OR (funds_state='captured' AND audit_until>NOW()))
        AND next_poll_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY next_poll_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!rows[0]) return null;
      const claimed = await tx.query("UPDATE video_adapter.jobs SET lease_owner=$1,lease_until=NOW()+($2::text||' milliseconds')::interval WHERE id=$3 RETURNING *", [owner, this.config.leaseMs, rows[0].id]);
      return claimed.rows[0];
    });
  }

  async update(job, patch, delayMs = this.config.pollIntervalMs, kind) {
    const allowed = ['state', 'upstream_id', 'upstream_status', 'progress', 'attempts', 'last_code'];
    ensure(Object.keys(patch).every(key => allowed.includes(key)), 'INVALID_PATCH', 'Unsupported task update', 500);
    return this.db.tx(async tx => {
      const values = Object.values(patch);
      const columns = Object.keys(patch).map((name, index) => `${name}=$${index + 1}`).join(',');
      values.push(delayMs, job.id, job.lease_owner);
      const n = Object.keys(patch).length;
      const { rows } = await tx.query(`UPDATE video_adapter.jobs SET ${columns ? columns+',' : ''}version=version+1,updated_at=NOW(),
        next_poll_at=NOW()+($${n + 1}::text||' milliseconds')::interval
        WHERE id=$${n + 2} AND lease_owner=$${n + 3} AND lease_until>NOW() AND funds_state IN ('held','captured') RETURNING *`, values);
      ensure(rows[0], 'LEASE_LOST', 'Task worker lease was lost', 409);
      if (kind) await event(tx, job.id, kind, patch);
      return rows[0];
    });
  }

  async unlock(job) { await this.db.query('UPDATE video_adapter.jobs SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2', [job.id, job.lease_owner]); }

  async settle(id, { charge, supplierCost, note, proof, expectedVersion, owner }) {
    return this.db.tx(async tx => {
      const found = await tx.query('SELECT * FROM video_adapter.jobs WHERE id=$1 FOR UPDATE', [id]);
      const job = found.rows[0];
      ensure(job, 'TASK_NOT_FOUND', 'Video task not found', 404);
      if (job.funds_state !== 'held') return job;
      ensure(expectedVersion == null || job.version === expectedVersion, 'VERSION_CONFLICT', 'Task changed; refresh before reconciliation', 409);
      ensure(!owner || job.lease_owner === owner && new Date(job.lease_until) > new Date(), 'LEASE_LOST', 'Task worker lease was lost', 409);
      ensure(!owner || job.state !== 'review', 'TASK_IN_REVIEW', 'Task requires administrator reconciliation', 409);
      const paid = decimal(charge);
      const cost = decimal(supplierCost);
      ensure(paid.lte(job.hold_usd), 'SETTLEMENT_EXCEEDS_HOLD', 'Settlement cannot exceed the frozen selling price', 409);
      ensure(cost.lte(job.cost_cap_usd), 'SUPPLIER_COST_OVERRUN', 'Supplier cost exceeds the reserved ceiling', 409);
      if (paid.gt(0)) enforceMargin(paid, cost.toString(), job.pricing_snapshot.economics,
        { profit_control_enabled:true,profit_min_margin:job.pricing_snapshot.economics.minMargin,profit_safety_buffer:job.pricing_snapshot.economics.profitSafetyBuffer });
      else ensure(cost.isZero(), 'LOSS_REFUND_DENIED', 'A full customer refund requires evidence that supplier cost is zero', 409);
      const refund = money(decimal(job.hold_usd).minus(paid));
      const funds = await tx.query(`UPDATE users SET balance=balance+$1, frozen_balance=frozen_balance-$2, updated_at=NOW()
        WHERE id=$3 AND frozen_balance >= $2 RETURNING id`, [refund, job.hold_usd, job.user_id]);
      ensure(funds.rows.length, 'FROZEN_BALANCE_INCONSISTENT', 'Frozen funds are inconsistent; reconciliation is required', 409);
      await tx.query('UPDATE api_keys SET quota_used=GREATEST(0,quota_used-$1), updated_at=NOW() WHERE id=$2', [refund, job.api_key_id]);
      for (const spec of windowSpecs) {
        await tx.query(`UPDATE api_keys SET usage_${spec.label}=GREATEST(0,usage_${spec.label}-$1) WHERE id=$2 AND window_${spec.label}_start=$3`,
          [refund, job.api_key_id, job.pricing_snapshot.windows[spec.label]]);
      }
      const state = paid.isZero() ? 'failed' : 'completed';
      const fundsState = paid.isZero() ? 'released' : 'captured';
      if (paid.gt(0)) {
        const sale = job.pricing_snapshot.sale;
        const spec = job.request_spec;
        await tx.query(`INSERT INTO usage_logs (user_id,api_key_id,account_id,group_id,request_id,model,requested_model,upstream_model,
          total_cost,actual_cost,account_stats_cost,rate_multiplier,account_rate_multiplier,billing_type,billing_mode,
          video_count,video_resolution,video_duration_seconds,stream,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,1,0,$12,1,$13,$14,FALSE,NOW())`,
        [job.user_id,job.api_key_id,job.account_id,job.group_id,job.id,job.model,proof?.upstreamModel || job.model,
          sale.baseUsd,money(paid),money(cost),sale.multiplier,sale.mode === 'per_second' ? 'video' : 'per_request',spec.resolution,spec.duration]);
      }
      const { rows } = await tx.query(`UPDATE video_adapter.jobs SET state=$1,funds_state=$2,charged_usd=$3,supplier_cost_usd=$4,
        reconcile_note=$5,settled_at=NOW(),updated_at=NOW(),version=version+1,lease_owner=NULL,lease_until=NULL,last_code=NULL,
        next_poll_at=NOW()+INTERVAL '30 minutes',audit_until=CASE WHEN $7 THEN NOW()+INTERVAL '7 days' ELSE NULL END
        WHERE id=$6 RETURNING *`, [state,fundsState,money(paid),money(cost),note || null,id,paid.gt(0) && proof?.source==='supplier_funds']);
      await event(tx, id, 'settled', { chargeUsd: money(paid), supplierCostUsd: money(cost), refundUsd: refund, proof, note });
      await invalidate(tx, job.user_id, job.api_key_id);
      return rows[0];
    });
  }

  async refundCaptured(id,proof,owner) {
    return this.db.tx(async tx => {
      const { rows } = await tx.query('SELECT * FROM video_adapter.jobs WHERE id=$1 FOR UPDATE',[id]);
      const job = rows[0];
      ensure(job,'TASK_NOT_FOUND','Video task not found',404);
      if (job.funds_state==='refunded') return job;
      ensure(job.funds_state==='captured','TASK_NOT_CAPTURED','Task is not captured',409);
      ensure(proof.funds==='refunded','REFUND_PROOF_REQUIRED','Captured funds require an explicit supplier refund',409);
      ensure(!owner || job.lease_owner===owner && new Date(job.lease_until)>new Date(),'LEASE_LOST','Task worker lease was lost',409);
      const amount = job.charged_usd;
      const restored = await tx.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE id=$2 RETURNING id',[amount,job.user_id]);
      ensure(restored.rows.length,'REFUND_USER_MISSING','Refund recipient no longer exists',409);
      await tx.query('UPDATE api_keys SET quota_used=GREATEST(0,quota_used-$1),updated_at=NOW() WHERE id=$2',[amount,job.api_key_id]);
      for (const spec of windowSpecs) await tx.query(`UPDATE api_keys SET usage_${spec.label}=GREATEST(0,usage_${spec.label}-$1)
        WHERE id=$2 AND window_${spec.label}_start=$3`,[amount,job.api_key_id,job.pricing_snapshot.windows[spec.label]]);
      const changed = await tx.query(`UPDATE video_adapter.jobs SET funds_state='refunded',charged_usd=0,supplier_cost_usd=0,
        version=version+1,updated_at=NOW(),audit_until=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1 RETURNING *`,[id]);
      // Preserve the native immutable charge log; the compensating refund is audited separately.
      await event(tx,id,'captured_refunded',{ amountUsd:amount,proof });
      await invalidate(tx,job.user_id,job.api_key_id);
      return changed.rows[0];
    });
  }

  async resumeProvider(providerId,note) {
    await this.db.tx(async tx => {
      await tx.query('UPDATE video_adapter.provider_controls SET paused=FALSE,reason=$2,updated_at=NOW() WHERE provider_id=$1',[providerId,note]);
      await event(tx,null,'provider_resumed',{ providerId,note });
    });
  }

  async pause(providerId, reason) {
    await this.db.tx(async tx => {
      await tx.query(`INSERT INTO video_adapter.provider_controls(provider_id,paused,reason) VALUES($1,TRUE,$2)
        ON CONFLICT(provider_id) DO UPDATE SET paused=TRUE,reason=$2,updated_at=NOW()`, [providerId,reason]);
      await event(tx, null, 'provider_paused', { providerId, reason });
    });
  }

  async list(state, limit = 100) {
    return (await this.db.query('SELECT * FROM video_adapter.jobs WHERE ($1::text IS NULL OR state=$1) ORDER BY created_at DESC LIMIT $2', [state || null,limit])).rows;
  }

  async overview() {
    const summary = await this.db.query(`SELECT state,funds_state,count(*)::int AS count,SUM(CASE WHEN funds_state='held' THEN hold_usd ELSE 0 END)::text AS held_usd,
      COALESCE(SUM(charged_usd),0)::text AS charged_usd,COALESCE(SUM(supplier_cost_usd),0)::text AS supplier_cost_usd
      FROM video_adapter.jobs GROUP BY state,funds_state ORDER BY state`);
    const controls = await this.db.query('SELECT * FROM video_adapter.provider_controls ORDER BY provider_id');
    const backlog = await this.db.query('SELECT count(*)::int AS count FROM video_adapter.cache_outbox');
    return { jobs: summary.rows, providers: controls.rows, cacheInvalidationBacklog: backlog.rows[0].count };
  }
}

module.exports = { Store, windowSpecs, event };
