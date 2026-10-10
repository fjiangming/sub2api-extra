'use strict';

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError, ensure } = require('./errors');
const { hash, secretEqual, decrypt } = require('./security');
const { normalizeRequest } = require('./request');
const { costCap, enforceMargin, decimal, money } = require('./money');
const { buildBody } = require('./providers');
const { event } = require('./store');

function publicJob(job) {
  return {
    id:job.id,object:'video',model:job.model,status:job.state === 'completed' ? 'done' : ['review','unknown','submitting'].includes(job.state) ? 'in_progress' : job.state,
    task_status:job.state,progress:job.progress,
    created_at:Math.floor(new Date(job.created_at).getTime()/1000),
    completed_at:job.settled_at ? Math.floor(new Date(job.settled_at).getTime()/1000) : null,
    duration:job.request_spec.duration,resolution:job.request_spec.resolution,
    funds_status:job.funds_state,quoted_price_usd:job.hold_usd,charged_price_usd:job.charged_usd,
    video:job.state === 'completed' && ['captured','refunded'].includes(job.funds_state) ? { url:`/v1/videos/${job.id}/content`,duration:job.request_spec.duration } : null,
    error:job.funds_state==='held' && job.last_code ? { code:job.last_code,message:job.state === 'review' ? 'Task is awaiting financial reconciliation' : 'Supplier task status is being recovered' } : null
  };
}

function publicModel(model) {
  return { id:model.id,object:'model',owned_by:'video-adapter',min_duration:model.minDuration,max_duration:model.maxDuration,
    durations:model.durations || null,default_duration:model.defaultDuration,resolutions:model.resolutions,aspect_ratios:model.aspectRatios,max_references:model.maxReferences };
}

function createApp({ store,registry,cache,catalog,config,worker }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy',config.trustProxy);
  app.use(helmet());
  app.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  app.get('/healthz',(_req,res) => res.json({ status:'ok',service:'video-adapter',version:'1.0.0',mode:config.production ? 'production' : 'demo' }));
  app.get('/readyz',async (_req,res,next) => {
    try { await store.db.query('SELECT 1'); await cache.ping(); res.json({ status:'ready' }); } catch { next(new AppError('DEPENDENCY_UNAVAILABLE','Database or cache is unavailable',503)); }
  });
  app.use(rateLimit({ windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,validate:{ trustProxy:false } }));
  app.use(express.json({ limit:'20mb',strict:true,verify:(req,_res,bytes) => { req.rawBody = bytes; } }));
  const auth = async (req,_res,next) => {
    try {
      ensure(!req.query.key && !req.query.api_key, 'QUERY_KEY_DENIED','API credentials must be passed in headers',400);
      const authHeader = req.get('Authorization') || '';
      req.apiToken = /^Bearer /i.test(authHeader) ? authHeader.slice(7).trim() : req.get('x-api-key');
      req.identity = await store.identity(req.apiToken,req.ip);
      next();
    } catch (error) { next(error); }
  };
  const admin = (req,_res,next) => {
    const token = (req.get('Authorization') || '').replace(/^Bearer /i,'');
    if (!secretEqual(token,config.adminToken)) return next(new AppError('ADMIN_AUTH_REQUIRED','Administrator authentication required',401));
    next();
  };
  function modelFor(id) {
    const model = catalog.models.find(item => item.id === id && item.enabled);
    const provider = model && catalog.providers.find(item => item.id === model.provider && item.enabled);
    ensure(model && provider,'MODEL_NOT_AVAILABLE','This video model is not enabled',404);
    return { model,provider };
  }
  function modelAllowed(who,id) { return !who.grp.model_allowlist?.enabled || who.grp.model_allowlist.models?.includes(id); }
  async function quote(req) {
    const { model,provider } = modelFor(req.body.model);
    ensure(modelAllowed(req.identity,model.id),'MODEL_DENIED','Model is not in the Sub2API group allowlist',403);
    const request = normalizeRequest(req.body,model);
    const body = buildBody(model,request);
    const cost = costCap(model.cost,request,config);
    await registry.quote(provider,model,request,body,cost);
    const sale = await store.price(store.db,req.identity,request);
    const margin = enforceMargin(sale.saleUsd,cost.capUsd,config,req.identity.grp);
    return { model,provider,request,body,cost,sale,margin };
  }
  app.get('/v1/models',auth,(req,res) => {
    const now = Date.now();
    const models = catalog.models.filter(m => m.enabled && modelAllowed(req.identity,m.id) && new Date(m.cost.expiresAt).getTime()>now && catalog.providers.some(p => p.id===m.provider && p.enabled));
    res.json({ object:'list',data:models.map(publicModel) });
  });
  app.post('/v1/videos/quote',auth,async (req,res) => {
    await store.identity(req.apiToken,req.ip,store.db,true);
    const result = await quote(req);
    res.json({ object:'video.quote',model:result.model.id,price_usd:result.sale.saleUsd,currency:'USD',billing_mode:result.sale.mode,
      duration:result.request.duration,resolution:result.request.resolution,requires_idempotency_key:true,expires_at:result.model.cost.expiresAt });
  });
  const create = async (req,res) => {
    const idempotencyKey = req.get('Idempotency-Key') || '';
    ensure(/^[\x21-\x7e]{8,128}$/.test(idempotencyKey),'IDEMPOTENCY_KEY_REQUIRED','An Idempotency-Key of 8-128 printable ASCII characters is required');
    const rawHash = hash(req.rawBody || Buffer.from(JSON.stringify(req.body)));
    const existing = await store.findIdempotent(req.identity.key.id,idempotencyKey,rawHash);
    if (existing) { ensure(String(existing.group_id)===String(req.identity.grp.id),'TASK_NOT_FOUND','Task is not available to this group',404); res.status(200).json(publicJob(existing)); return; }
    await cache.ping();
    await store.identity(req.apiToken,req.ip,store.db,true);
    const result = await quote(req);
    const job = await store.reserve({ token:req.apiToken,ip:req.ip,model:result.model,provider:result.provider,request:result.request,
      rawHash,idempotencyKey,cost:result.cost,supplierBody:result.body,catalogVersion:catalog.version });
    await cache.flush().catch(() => {});
    res.status(202).json(publicJob(job));
    if (worker) void worker.tick().catch(() => {});
  };
  app.post(['/v1/videos','/v1/videos/generations'],auth,create);
  app.get(['/v1/videos/:id','/v1/videos/generations/:id'],auth,async (req,res) => res.json(publicJob(await store.getOwned(req.params.id,req.identity))));
  const content = async (req,res) => {
    const job = await store.getOwned(req.params.id,req.identity);
    ensure(job.state==='completed' && ['captured','refunded'].includes(job.funds_state),'VIDEO_NOT_READY','Video is not available for download',409);
    const range = req.get('Range');
    ensure(!range || /^bytes=(?:\d+-\d*|-\d+)$/.test(range),'INVALID_RANGE','Only a single byte range is supported',416);
    if (req.method!=='HEAD') await store.claimDownload(job);
    const snapshot = decrypt(job.secret_snapshot,config.encryptionKey);
    const upstream = await registry.content(snapshot.provider,job.upstream_id,{ range,method:req.method });
    try {
      ensure([200,206,416].includes(upstream.status),'DOWNLOAD_FAILED','Supplier download failed',502);
      const contentType = upstream.headers.get('content-type') || '';
      ensure(upstream.status===416 || /^(video\/|application\/octet-stream(?:;|$))/i.test(contentType),'INVALID_VIDEO_CONTENT','Supplier did not return video content',502);
      const length = Number(upstream.headers.get('content-length'));
      if (upstream.headers.has('content-length')) ensure(Number.isSafeInteger(length) && length>=0 && length<=job.pricing_snapshot.delivery.maxBytes,'DOWNLOAD_SIZE_LIMIT','Video exceeds the download limit',502);
    } catch (error) { await upstream.body?.cancel().catch(() => {}); throw error; }
    res.status(upstream.status);
    for (const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
      const value = upstream.headers.get(name); if (value) res.set(name,value);
    }
    res.set('Content-Disposition',`attachment; filename="${job.id}.mp4"`);
    if (req.method==='HEAD' || upstream.status===416) { await upstream.body?.cancel(); res.end(); return; }
    let bytes = 0;
    const source = Readable.fromWeb(upstream.body);
    source.on('data',chunk => { bytes+=chunk.length; if (bytes>job.pricing_snapshot.delivery.maxBytes) source.destroy(new Error('Download size limit exceeded')); });
    try { await pipeline(source,res); } catch { if (!res.destroyed) res.destroy(); }
  };
  app.get(['/v1/videos/:id/content','/v1/videos/:id/download','/v1/videos/generations/:id/content'],auth,content);
  app.head(['/v1/videos/:id/content','/v1/videos/:id/download','/v1/videos/generations/:id/content'],auth,content);
  app.use('/admin',admin);
  app.get('/admin/overview',async (_req,res) => res.json(await store.overview()));
  app.get('/admin/jobs',async (req,res) => {
    const rows = await store.list(req.query.state,Math.min(100,Math.max(1,Number(req.query.limit)||50)));
    res.json({ data:rows.map(job => ({ ...publicJob(job),version:job.version,provider:job.provider_id,upstream_id:job.upstream_id,
      supplier_cost_usd:job.supplier_cost_usd,cost_cap_usd:job.cost_cap_usd,pricing:job.pricing_snapshot })) });
  });
  app.get('/admin/jobs/:id/events',async (req,res) => {
    const result = await store.db.query('SELECT id,kind,payload,created_at FROM video_adapter.events WHERE job_id=$1 ORDER BY id',[req.params.id]);
    res.json({ data:result.rows });
  });
  app.post('/admin/jobs/:id/reconcile',async (req,res) => {
    const input = z.object({ version:z.number().int().positive(),outcome:z.enum(['released','captured','resume']),
      note:z.string().min(12).max(2000),evidence:z.string().min(8).max(2000),supplierCostUsd:z.string().optional(),upstreamId:z.string().max(200).optional() }).strict().parse(req.body);
    const { rows } = await store.db.query('SELECT * FROM video_adapter.jobs WHERE id=$1',[req.params.id]);
    const job = rows[0];
    ensure(job && job.state==='review' && job.funds_state==='held','TASK_NOT_IN_REVIEW','Only held tasks in review can be reconciled',409);
    if (input.outcome==='resume') {
      ensure(input.upstreamId || job.upstream_id,'UPSTREAM_ID_REQUIRED','A recovered supplier task ID is required',400);
      ensure(!/[\x00-\x20/\\?#]/.test(input.upstreamId || job.upstream_id),'INVALID_UPSTREAM_ID','Invalid supplier task ID',400);
      await store.db.tx(async tx => {
        const result = await tx.query(`UPDATE video_adapter.jobs SET upstream_id=$1,state='running',last_code=NULL,version=version+1,
          next_poll_at=NOW(),lease_owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$2 AND version=$3 AND state='review' RETURNING id`,[input.upstreamId || job.upstream_id,job.id,input.version]);
        ensure(result.rows.length,'VERSION_CONFLICT','Task changed; refresh before reconciliation',409);
        await event(tx,job.id,'manual_resume',{ note:input.note,evidence:input.evidence });
      });
      res.json({ id:job.id,status:'running' }); return;
    }
    if (input.outcome==='captured') ensure(job.upstream_id,'UPSTREAM_ID_REQUIRED','Recover the supplier task ID before capturing funds',409);
    const cost = input.outcome==='released' ? '0' : money(input.supplierCostUsd);
    const snapshot = decrypt(job.secret_snapshot,config.encryptionKey);
    const settled = await store.settle(job.id,{ charge:input.outcome==='released' ? '0' : job.hold_usd,supplierCost:cost,
      note:input.note,expectedVersion:input.version,proof:{ source:'administrator_reconciliation',evidence:input.evidence,upstreamModel:snapshot.model.upstreamModel } });
    res.json(publicJob(settled));
  });
  app.post('/admin/providers/:id/pause',async (req,res) => {
    ensure(catalog.providers.some(p => p.id===req.params.id),'PROVIDER_NOT_FOUND','Provider not found',404);
    const input = z.object({ reason:z.string().min(8).max(2000) }).strict().parse(req.body);
    await store.pause(req.params.id,input.reason); res.json({ provider:req.params.id,paused:true });
  });
  app.post('/admin/providers/:id/resume',async (req,res) => {
    const provider = catalog.providers.find(p => p.id===req.params.id && p.enabled);
    ensure(provider,'PROVIDER_NOT_FOUND','Enabled provider not found',404);
    const input = z.object({ note:z.string().min(12).max(2000) }).strict().parse(req.body);
    const models = catalog.models.filter(m => m.provider===provider.id && m.enabled);
    ensure(models.length && models.every(m => new Date(m.cost.expiresAt)>new Date()),'COST_CARD_EXPIRED','Reverify cost cards before resuming',409);
    await store.resumeProvider(provider.id,input.note); res.json({ provider:provider.id,paused:false });
  });
  app.use((_req,_res,next) => next(new AppError('NOT_FOUND','Endpoint not found',404)));
  app.use((error,_req,res,_next) => {
    if (res.headersSent) { res.destroy(); return; }
    const validation = error instanceof z.ZodError;
    const status = error instanceof AppError ? error.status : validation || error.type==='entity.parse.failed' ? 400 : error.type==='entity.too.large' ? 413 : 500;
    const code = error instanceof AppError ? error.code : validation ? 'INVALID_REQUEST' : status===400 ? 'INVALID_JSON' : status===413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR';
    if (status>=500) console.error(JSON.stringify({ event:'request_failed',code }));
    res.status(status).json({ error:{ type:'video_adapter_error',code,message:error instanceof AppError ? error.message : validation ? 'Request or configuration validation failed' : 'Request could not be processed' } });
  });
  return app;
}

module.exports = { createApp, publicJob, publicModel };
