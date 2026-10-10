'use strict';

const { ensure } = require('./errors');
const { decimal, money } = require('./money');

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function getPath(object, path) {
  return path.split('.').reduce((value, key) => forbidden.has(key) ? undefined : value?.[key], object);
}
function firstPath(object, paths) {
  for (const path of paths) { const value = getPath(object,path); if (value !== undefined && value !== null && value !== '') return value; }
  return undefined;
}
function setPath(object, path, value) {
  const parts = path.split('.');
  ensure(parts.every(p => !forbidden.has(p)), 'INVALID_FIELD_MAP', 'Forbidden field mapping');
  let current = object;
  for (const key of parts.slice(0,-1)) current = current[key] ??= {};
  current[parts.at(-1)] = value;
}

function buildBody(model, request) {
  const fields = { model: 'model', prompt: 'prompt', duration: 'duration', resolution: 'resolution', aspect_ratio: 'aspect_ratio', references: 'references', ...model.fields };
  const body = {};
  const value = { ...request, model: model.upstreamModel };
  if (model.requestStyle === 'lingsu-references') fields.duration = 'seconds';
  if (['lingsu-special','xcm-mixed'].includes(model.requestStyle)) fields.aspect_ratio = 'ratio';
  for (const key of ['model','prompt','duration','resolution','aspect_ratio']) setPath(body, fields[key], value[key]);
  if (model.requestStyle === 'lingsu-special') {
    ensure(request.references.every(ref => ref.type === 'image' && ref.source.startsWith('data:image/')), 'REFERENCE_FORMAT_UNSUPPORTED', 'This supplier model requires image data URIs');
    body.images = request.references.map(ref => ref.source.slice(ref.source.indexOf(',')+1));
    body.face_direct = false;
  } else if (model.requestStyle === 'xcm-h3') {
    const first = request.references.find(ref => ref.type === 'image' && ref.role === 'first_frame');
    const last = request.references.find(ref => ref.type === 'image' && ref.role === 'last_frame');
    if (first) body.image = { url: first.source };
    if (last) body.last_frame = { url: last.source };
    const images = request.references.filter(ref => ref.type === 'image' && ref.role === 'reference');
    if (images.length) body.reference_images = images.map(ref => ({ url: ref.source }));
    ensure(!request.references.some(ref => ref.type !== 'image'), 'REFERENCE_FORMAT_UNSUPPORTED', 'H3 voice references require a separate verified model contract');
  } else if (request.references.length) {
    // Provider-specific reference shapes can be supplied by a registered driver.
    setPath(body, fields.references, request.references);
  }
  return JSON.stringify(body);
}

const defaultResponse = {
  idPaths: ['request_id','id','task_id','data.request_id','data.id','data.task_id'],
  statusPaths: ['status','data.status'], urlPaths: ['content_url','download_url','video.url','video_url','url','data.video.url','data.video_url'],
  fundsPaths: ['funds_status','data.funds_status'], amountPaths: ['quoted_price','data.quoted_price'],
  reviewPaths: ['task_status','data.task_status'],
  success: ['done','completed','succeeded','success'], failure: ['failed','error','expired','cancelled','canceled']
};

function parseResponse(provider, response) {
  const map = { ...defaultResponse, ...provider.response };
  const status = String(firstPath(response,map.statusPaths) || '').toLowerCase();
  const rawId = firstPath(response,map.idPaths);
  const rawAmount = firstPath(response,map.amountPaths);
  const rawProgress = firstPath(response,['progress','data.progress']);
  const id = rawId == null ? null : String(rawId);
  ensure(!id || (id.length <= 200 && !/[\x00-\x20/\\?#]/.test(id) && !['.','..'].includes(id)), 'UPSTREAM_ID_INVALID', 'Supplier task ID is invalid', 502);
  const url = firstPath(response,map.urlPaths);
  ensure(url == null || typeof url === 'string', 'UPSTREAM_URL_INVALID', 'Supplier video URL is invalid', 502);
  const funds = String(firstPath(response,map.fundsPaths) || '').toLowerCase();
  ensure(!funds || ['reserved','captured','released','refunded'].includes(funds), 'UPSTREAM_FUNDS_INVALID', 'Supplier financial status is unknown', 502);
  return { id, status, url, funds, amount: rawAmount == null ? null : money(rawAmount),
    completed: map.success.includes(status), failed: map.failure.includes(status),
    review: String(firstPath(response,map.reviewPaths) || '').toLowerCase() === 'review',
    progress: rawProgress == null || !Number.isFinite(Number(rawProgress)) ? null : Math.max(0,Math.min(100,Math.trunc(Number(rawProgress)))) };
}

function route(provider, operation, id) {
  const defaults = { create: provider.type === 'openai' ? '/v1/videos' : '/v1/videos', status: '/v1/videos/{id}', content: provider.type === 'lingsu' ? '/v1/videos/{id}/download' : '/v1/videos/{id}/content' };
  return (provider[`${operation}Path`] || defaults[operation]).replace('{id}',encodeURIComponent(id || ''));
}

class ProviderRegistry {
  constructor(http) { this.http = http; this.drivers = new Map(); }
  register(type, driver) { this.drivers.set(type,driver); }
  async quote(provider, model, request, body, cost) {
    if (!provider.quote) return cost;
    const path = provider.quote.path.replace('{model}', encodeURIComponent(model.upstreamModel));
    const result = await this.http.json(provider,path,{ method: provider.quote.method, body: provider.quote.method === 'POST' ? body : undefined });
    const quoted = firstPath(result,[provider.quote.amountPath]);
    ensure(quoted != null, 'SUPPLIER_QUOTE_MISSING', 'Supplier quote amount is missing', 503);
    ensure(provider.quote.currency === cost.currency, 'SUPPLIER_QUOTE_CURRENCY', 'Supplier quote currency does not match the verified cost card', 503);
    const total = decimal(quoted).mul(provider.quote.mode === 'per_second' ? request.duration : 1);
    ensure(total.lte(cost.quotedAmountBound), 'SUPPLIER_QUOTE_INCREASED', 'Live supplier quote exceeds the verified cost bound', 409);
    return cost;
  }
  async create(provider, body, idempotencyKey) {
    const driver = this.drivers.get(provider.type);
    if (driver) return driver.create(provider,body,idempotencyKey);
    const headers = provider.idempotentCreate ? { 'Idempotency-Key': idempotencyKey } : {};
    return parseResponse(provider,await this.http.json(provider,route(provider,'create'),{ method: 'POST',body,headers }));
  }
  async status(provider, id) {
    const driver = this.drivers.get(provider.type);
    if (driver) return driver.status(provider,id);
    return parseResponse(provider,await this.http.json(provider,route(provider,'status',id)));
  }
  async content(provider,id,{ range, method = 'GET' } = {}) {
    const driver = this.drivers.get(provider.type);
    if (driver) return driver.content(provider,id,{ range,method });
    const headers = range ? { Range: range } : {};
    if (provider.downloadMode==='status_url') {
      const status = await this.status(provider,id);
      ensure(status.completed && status.url,'VIDEO_URL_MISSING','Supplier did not return a completed video URL',502);
      return this.http.request(provider,status.url,{ headers,method,download:true });
    }
    return this.http.request(provider,route(provider,'content',id),{ headers, method, download: true });
  }
}

class MockProvider {
  async create(_provider,body,key) { return { id: `mock_${key}`, status: 'queued', funds: 'reserved', amount: '0.10000000', progress: 0 }; }
  async status(_provider,id) { return { id,status:'completed',completed:true,funds:'captured',amount:'0.10000000',progress:100,url:`/v1/videos/${id}/content` }; }
  async content() { return new Response(Buffer.from('mock-video-fixture'), { headers: { 'Content-Type': 'video/mp4' } }); }
}

module.exports = { ProviderRegistry, MockProvider, buildBody, parseResponse, firstPath, getPath, route };
