'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, event } = require('./conversation-logs-fixture');
const { defaults } = require('../src/conversation-log-store');
const { modelAllowed, normalizeModel, recommendedModels } = require('../src/services/conversation-models');

test('model whitelist matches named versions and aliases while keeping unselected versions out', () => {
  for (const model of [...recommendedModels,'GPT-6.1-SOL','Fable5','Fable5.1','Claude Fable 5.1','Opus5','Opus5.5','claude-opus-5.5','Gemini carbon','Kimik3','kimi-k3.1','kimi-k3-0905-preview','kimi-k4-thinking','kimi-k10']) {
    assert.equal(modelAllowed(defaults,model),true,model);
  }
  for (const model of ['',null,{},'claude-fable-5-2','claude-opus-5-50','gpt-6.1-terra','gpt-6-sol-extra','deepseek-v4.1','kimi-k2.9','kimi-k3fake','not-kimi-k4','Gemini carbon-image']) {
    assert.equal(modelAllowed(defaults,model),false,String(model));
  }
  assert.equal(modelAllowed({...defaults,kimiK3Plus:false},'kimi-k3'),false);
  assert.equal(modelAllowed({...defaults,kimiK3Plus:false,allowedModels:['Kimik3']},'kimi-k3'),true);
  assert.equal(normalizeModel(' Opus5.5 '),'claude-opus-5-5');
});

test('unlisted and unknown models create no archive data, including queued older policy events', t => {
  const f=fixture();t.after(()=>f.close());
  const historical=event('historical-filter');f.store.ingest(historical);
  const before=f.store.status();
  const policy=f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['gpt-6.1-sol'],kimiK3Plus:true});
  for (const row of [event('denied',{model:'deepseek-v4',policy_version:policy.version}),event('unknown',{model:'',policy_version:policy.version}),event('queued-before-filter',{model:'example-model',policy_version:2}),{model:'other',user_id:2,request:'invalid'}]) {
    assert.deepEqual(f.store.ingest(row),{accepted:false});
  }
  assert.equal(f.store.status().records,before.records);assert.equal(f.store.status().gaps,before.gaps);
  assert.equal(f.store.status().bytes,before.bytes);assert.equal(f.store.exportIndex().count,1);assert.equal(f.store.sessions().items[0].attempts,1);
  assert(f.store.payload(historical.id,'original','request').body.length);
  for (const model of ['gpt-6.1-sol','Kimi K3.1','kimi-k4']) assert(f.store.ingest(event(model,{model,policy_version:policy.version})).accepted);
  const excluded=f.store.configure({...policy,excludedUserIds:[2]});
  assert.deepEqual(f.store.ingest(event('excluded-selected',{model:'gpt-6.1-sol',policy_version:excluded.version})),{accepted:false});
});

test('empty whitelist means no models, while disabling the filter restores normal collection', t => {
  const f=fixture();t.after(()=>f.close());
  const policy=f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:[],kimiK3Plus:false});
  assert.deepEqual(f.store.ingest(event('empty',{model:'gpt-6.1-sol',policy_version:policy.version})),{accepted:false});
  const resumed=f.store.configure({...policy,modelFilterEnabled:false});
  assert(f.store.ingest(event('resumed-filter',{policy_version:resumed.version})).accepted);
});

test('legacy clients preserve active model filters, encrypted old policies stay compatible and collector gets the contract', t => {
  const f=fixture();t.after(()=>f.close());
  const p=f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['Fable5.1','claude-fable-5-1','GPT-6.1-SOL'],kimiK3Plus:true});
  assert.deepEqual(p.allowedModels,['claude-fable-5-1','gpt-6.1-sol']);
  const {modelFilterEnabled,allowedModels,kimiK3Plus,...legacy}=p;
  const saved=f.store.configure({...legacy,retention:14});
  assert(saved.modelFilterEnabled);assert(saved.kimiK3Plus);assert.deepEqual(saved.allowedModels,p.allowedModels);
  f.store.db.prepare('INSERT INTO cl_policies VALUES(?,?,?)').run(100,f.store.seal({...legacy,version:100},'policy:100'),Date.now());
  const old=f.store.policy();assert.equal(old.modelFilterEnabled,false);assert.deepEqual(old.allowedModels,[]);assert.equal(old.kimiK3Plus,false);
  const contract=f.store.collectorPolicy();assert.equal(contract.model_filter_version,1);assert.equal(contract.model_filter_enabled,false);
  assert.throws(()=>f.store.configure({...old,allowedModels:['bad\nmodel']}));
  assert.throws(()=>f.store.configure({...old,allowedModels:Array(101).fill('test')}));
});

test('filtered historical models cannot write new processing copies; current selection remains authoritative', t => {
  const f=fixture();t.after(()=>f.close());
  const p=f.store.configure({...f.store.policy(),mode:'masked',custom:[{from:'call_demo',to:'broken'}]});
  const row=event('retry-model',{policy_version:p.version});f.store.ingest(row);
  const selected=f.store.configure({...p,modelFilterEnabled:true,allowedModels:['gpt-6.1-sol'],kimiK3Plus:false});
  const before=f.store.detail(row.id);assert(before.original);assert.equal(before.retry_blocked,'model_excluded');assert(!before.retry_available);
  assert.throws(()=>f.store.retry(row.id,{policy_version:selected.version,processed_at:before.processed_at}),{code:'CONVERSATION_MODEL_EXCLUDED'});
  assert.deepEqual(f.store.detail(row.id),before);
});
