'use strict';

const { loadConfig } = require('../src/config');
const { createDemoDatabase,demoCatalog } = require('../src/demo');
const { Store } = require('../src/store');
const { CacheInvalidator } = require('../src/cache');
const { ProviderRegistry,MockProvider,buildBody } = require('../src/providers');
const { costCap } = require('../src/money');
const { hash } = require('../src/security');
const { createApp } = require('../src/app');
const { Worker } = require('../src/worker');

async function fixture(t, overrides = {}) {
  const config = { ...loadConfig({},true),pollIntervalMs:100,...overrides };
  const db = await createDemoDatabase();
  const catalog = demoCatalog();
  const cache = new CacheInvalidator(db,null);
  const store = new Store(db,config,cache);
  const registry = new ProviderRegistry({ json:async () => { throw new Error('Unexpected external call in test'); } });
  registry.register('mock',new MockProvider());
  const worker = new Worker(store,registry,cache,config,catalog);
  const app = createApp({ store,registry,cache,catalog,config });
  const server = await new Promise(resolve => { const candidate = app.listen(0,'127.0.0.1',() => resolve(candidate)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await worker.stop(); await new Promise(resolve => server.close(resolve)); await db.close(); });
  async function api(route,{ body,rawBody,token = 'sk-demo-video-local-only',idempotencyKey,method } = {}) {
    const headers = { Authorization:`Bearer ${token}` };
    if (body || rawBody) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(baseUrl+route,{ method:method || (body || rawBody ? 'POST' : 'GET'),headers,body:rawBody || (body && JSON.stringify(body)) });
    const contentType = response.headers.get('content-type') || '';
    return { status:response.status,headers:response.headers,body:contentType.includes('application/json') ? await response.json() : await response.text() };
  }
  async function reserve(idempotencyKey = 'test-operation-1',requestOverrides = {}) {
    const model = catalog.models[0];
    const provider = catalog.providers[0];
    const request = { model:model.id,prompt:'Test video',duration:5,resolution:'480p',aspect_ratio:'16:9',references:[],...requestOverrides };
    return store.reserve({ token:'sk-demo-video-local-only',ip:'127.0.0.1',model,provider,request,rawHash:hash(JSON.stringify(request)),
      idempotencyKey,cost:costCap(model.cost,request,config),supplierBody:buildBody(model,request),catalogVersion:catalog.version });
  }
  async function processOne() {
    const job = await store.claim('test-worker');
    if (job) await worker.process(job);
    return job;
  }
  return { config,db,catalog,store,cache,registry,worker,api,reserve,processOne,baseUrl };
}

module.exports = { fixture };
