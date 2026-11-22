'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { groupMonitorFixture } = require('./group-monitor-fixture');
const { GroupMonitorStore } = require('../src/group-monitor-store');
const { GroupMonitorService, audit } = require('../src/services/group-monitor-service');
const { requestFor, hasText } = require('../src/services/group-monitor-probe');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

async function fixture(t,options){const f=await groupMonitorFixture(options);t.after(()=>f.close());return f;}
const profile=(f,id,extra={})=>({revision:f.store.profile(f.source.scope(),String(id)).revision,model:'gpt-5-mini',protocol:'auto',...extra});

test('real PostgreSQL inventory audits every enabled account and keeps cross-group comparisons separate',async t=>{
  const f=await fixture(t),r=await f.service.report();
  assert.equal(r.summary.groups,12);assert.equal(r.summary.anomalies,5);assert.equal(r.summary.unknown,1);
  const findings=f.service.findings();assert.equal(findings.enabledAccounts,17);assert.equal(findings.enabledMemberships,19);
  assert(findings.items.some(v=>v.groupId==='12'&&v.accountId==='109'));
  assert(!findings.items.some(v=>v.accountId==='106'||v.groupId==='2'&&v.accountId==='102'));
  assert.equal(f.service.detail('3').accounts.find(a=>a.id==='106').comparison,'excluded');
  assert.equal(f.service.detail('7').accounts.find(a=>a.id==='305').comparison,'unknown');
  assert(f.queries.every(sql=>/^(SELECT|BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)));
  assert.equal(f.requests.length,0);
});
test('strict decimal comparisons include zero, exclude equal rates, and retain missing or invalid rates',()=>{
  const groups=[{id:'1',name:'zero',status:'active',rate:'0',accounts:[{id:'1',status:'active',rate:'0'},{id:'2',status:'active',rate:'0.0001'},{id:'3',status:'active',rate:null},{id:'4',status:'disabled',rate:'99'}]}];
  const records=audit(groups);assert.equal(records.length,2);assert.equal(records[0].excessPercent,null);assert.equal(records[0].difference,'0.0001');assert.equal(records[1].kind,'unknown');
  groups[0].rate='0.3000';groups[0].accounts=[{id:'5',status:'active',rate:'0.3001'},{id:'6',status:'active',rate:'0.3000'},{id:'7',status:'active',rate:'-1'}];
  assert.deepEqual(audit(groups).map(r=>[r.accountId,r.kind]),[['5','higher'],['7','unknown']]);
});
test('complete snapshots resolve findings once, recur as new episodes, and exclude removed records',async t=>{
  const f=await fixture(t),old=f.service.findings().items.find(v=>v.accountId==='102');
  f.advance(60000);await f.service.scan();assert.equal(f.service.findings().items.find(v=>v.accountId==='102').id,old.id);
  await f.database.exec('UPDATE accounts SET rate_multiplier=0.8 WHERE id=102');f.advance(60000);await f.service.scan();
  assert.equal(f.service.findings({scope:'history'}).items.filter(v=>v.accountId==='102').length,1);
  await f.database.exec('UPDATE accounts SET rate_multiplier=1.2 WHERE id=102');await f.service.scan();
  assert.notEqual(f.service.findings().items.find(v=>v.accountId==='102').id,old.id);
  await f.database.exec('UPDATE accounts SET deleted_at=now() WHERE id=102');await f.service.scan();
  assert(!f.service.findings().items.some(v=>v.accountId==='102'));
});
test('source failure preserves open anomalies and marks cached rows stale without falsely recovering',async t=>{
  const f=await fixture(t);f.readAvailable(false);
  await assert.rejects(f.service.scan(),{code:'GROUP_MONITOR_SOURCE_UNAVAILABLE'});
  const report=await f.service.report();assert.equal(report.source.stale,true);assert.equal(report.source.ready,false);assert.equal(report.summary.anomalies,5);assert.equal(f.service.findings({scope:'history'}).total,0);
  f.readAvailable(true);await f.service.scan();assert.equal((await f.service.report()).source.ready,true);
});
test('keys are bound to groups before saving, encrypted at rest, and omitted from every public result',async t=>{
  const f=await fixture(t,{configured:false});
  await assert.rejects(f.service.configureGroup('1',profile(f,1,{apiKey:f.keys.get('2')})),{code:'GROUP_MONITOR_KEY_GROUP_MISMATCH'});
  await f.service.configureGroup('1',profile(f,1,{apiKey:f.keys.get('1')}));
  const scope=f.source.scope(),raw=f.store.db.prepare('SELECT secret FROM gm_profiles WHERE scope=? AND group_id=?').get(scope,'1');
  assert(!raw.secret.includes(f.keys.get('1')));assert.equal(f.store.profile(scope,'1',true).key,f.keys.get('1'));
  assert(!JSON.stringify([await f.service.report(),f.service.detail('1'),f.service.findings()]).includes(f.keys.get('1')));
  const wrong=new GroupMonitorStore(f.directory,{key:Buffer.alloc(32)}).initialize();
  try { assert.throws(()=>wrong.profile(scope,'1',true)); } finally { wrong.close(); }
  await f.service.configureGroup('1',profile(f,1,{clearKey:true}));assert.equal(f.service.detail('1').profile.keyConfigured,false);
});
test('a target switch during inventory collection cannot overwrite the previous scope or recover its anomalies',async t=>{
  const f=await fixture(t),scope=f.source.scope(),snapshot=f.source.snapshot.bind(f.source),before=f.store.inventory(scope);
  f.source.snapshot=async()=>{const groups=await snapshot();f.config.sub2apiBaseUrl='http://127.0.0.1:1';return groups;};
  await assert.rejects(f.service.scan(),{code:'GROUP_MONITOR_SOURCE_CHANGED'});
  assert.deepEqual(f.store.inventory(scope),before);assert.equal(f.store.findings(scope,'resolved').length,0);
  f.pool.connectionString='postgresql://new-target/database';assert.notEqual(f.source.scope(),scope);
});
test('key reassignment, expiry and owner disablement block generation without making a gateway request',async t=>{
  const f=await fixture(t);
  for(const change of ["UPDATE api_keys SET group_id=2 WHERE id=1","UPDATE api_keys SET group_id=1,expires_at=now()-interval '1 hour' WHERE id=1","UPDATE api_keys SET expires_at=NULL WHERE id=1;UPDATE users SET status='disabled' WHERE id=2"]){
    await f.database.exec(change);await f.service.startRun({groupIds:['1']});await f.finish();assert.equal(f.service.detail('1').result.code,'KEY_GROUP_MISMATCH');
  }
  assert.equal(f.requests.length,0);
});
test('real loopback requests exercise all protocols, skip unconfigured/empty/disabled groups, and retain HTTP failures',async t=>{
  const f=await fixture(t),run=await f.service.startRun();assert.equal(run.total,9);assert.equal(run.skipped,3);await f.finish();
  const report=await f.service.report();assert.equal(report.summary.ok,7);assert.equal(report.summary.failed,2);assert.equal(report.summary.anomalies,5);
  assert(f.requests.some(r=>r.path==='/v1/messages'));assert(f.requests.some(r=>r.path==='/v1/responses'));assert(f.requests.some(r=>r.path.startsWith('/v1beta/models/')));
  assert.equal(f.maxActive<=2,true);assert.equal(f.service.detail('9').result.httpStatus,401);
  f.failGroups.delete('8');await f.service.startRun({groupIds:['8']});await f.finish();assert.equal(f.service.detail('8').status,'ok');assert.equal(f.service.detail('8').history.length,2);
  assert.equal(f.service.findings().total,5);
  await f.service.configureGroup('4',profile(f,4,{protocol:'chat'}));await f.service.startRun({groupIds:['4']});await f.finish();assert(f.requests.some(r=>r.path==='/v1/chat/completions'));
});
test('HTTP 200 login pages and empty text never count as generation success',async t=>{
  const f=await fixture(t);f.malformed.add('1');f.empty.add('2');await f.service.startRun({groupIds:['1','2']});await f.finish();
  assert.equal(f.service.detail('1').result.code,'INVALID_GENERATION');assert.equal(f.service.detail('2').result.code,'INVALID_GENERATION');
});
test('parameter revisions invalidate prior success, reject stale updates and survive store reopen',async t=>{
  const f=await fixture(t);await f.service.startRun({groupIds:['1']});await f.finish();const old=f.service.detail('1');assert.equal(old.status,'ok');
  await f.service.configureGroup('1',profile(f,1,{model:'claude-sonnet-4-5'}));assert.equal(f.service.detail('1').status,'waiting');assert.equal(f.service.detail('1').previousResult.status,'ok');
  await assert.rejects(f.service.configureGroup('1',{...profile(f,1),revision:old.profile.revision}),{code:'GROUP_MONITOR_CONFLICT'});
  const reopened=new GroupMonitorStore(f.directory,{key:f.key}).initialize();
  try { assert.equal(reopened.profile(f.source.scope(),'1',true).key,f.keys.get('1'));assert.equal(reopened.history(f.source.scope(),'1').length,1); } finally { reopened.close(); }
});
test('timeout and cancellation abort in-flight requests, preserve unstarted groups, and allow the next run',async t=>{
  const f=await fixture(t);f.service.configurePolicy({...f.store.policy(f.source.scope()),timeoutSeconds:1,concurrency:1});f.setDelay(2000);
  await f.service.startRun({groupIds:['1']});await f.finish();assert.equal(f.service.detail('1').result.code,'TIMEOUT');
  const run=await f.service.startRun({groupIds:['1','2']});await new Promise(resolve=>setTimeout(resolve,100));
  assert.throws(()=>f.service.configurePolicy({...f.store.policy(f.source.scope())}),{code:'GROUP_MONITOR_BUSY'});
  await assert.rejects(f.service.startRun(),{code:'GROUP_MONITOR_BUSY'});f.service.cancel(run.id);await f.finish();
  assert.equal(f.service.detail('1').result.code,'CANCELLED');assert.equal(f.service.detail('2').history.length,0);assert.equal((await f.service.report()).run.state,'cancelled');
  f.setDelay(0);await f.service.startRun({groupIds:['2']});await f.finish();assert.equal(f.service.detail('2').status,'ok');
});
test('a corrupt encrypted key blocks only that group and waits for concurrent workers to finish',async t=>{
  const f=await fixture(t);f.setDelay(100);
  f.store.db.prepare("UPDATE gm_profiles SET secret='corrupt' WHERE scope=? AND group_id='1'").run(f.source.scope());
  await f.service.startRun({groupIds:['1','2','3']});await f.finish();
  const report=await f.service.report();assert.equal(report.run.state,'completed');assert.equal(report.run.done,3);
  assert.equal(f.service.detail('1').result.code,'KEY_UNAVAILABLE');assert.equal(f.service.detail('2').status,'ok');assert.equal(f.service.detail('3').status,'ok');
  assert.deepEqual(f.requests.map(r=>r.groupId).sort(),['2','3']);
});
test('result storage failures interrupt workers without leaving a running task or unhandled rejection',async t=>{
  const f=await fixture(t);f.setDelay(100);const result=f.store.result,run=f.store.run;
  f.store.result=()=>{throw new Error('fixture disk failure');};
  await f.service.startRun({groupIds:['1','2','3']});
  f.store.run=()=>{throw new Error('fixture disk failure');};await f.finish();
  f.store.result=result;f.store.run=run;
  const report=await f.service.report();assert.equal(report.run.state,'interrupted');assert.equal(report.run.error,'MONITOR_STORE_UNAVAILABLE');assert.equal(f.service.job,null);
  const completed=f.requests.length;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(f.requests.length,completed);assert(completed<=2);
  await f.service.startRun({groupIds:['3']});await f.finish();assert.equal(f.service.detail('3').status,'ok');
});
test('automatic requests are opt-in while rate audits run independently and respect the next due time',async t=>{
  const f=await fixture(t);await f.service.tick();assert.equal(f.requests.length,0);
  f.service.configurePolicy({...f.store.policy(f.source.scope()),automatic:true,intervalMinutes:1});await f.service.tick();assert.equal(f.requests.length,0);
  f.advance(60001);await f.service.tick();await f.finish();assert.equal(f.requests.length,9);
  await f.service.tick();assert.equal(f.requests.length,9);
  f.service.configurePolicy({...f.store.policy(f.source.scope()),automatic:false});f.advance(60001);
  await f.database.exec('UPDATE accounts SET rate_multiplier=0.8 WHERE id=102');await f.service.tick();assert.equal(f.service.findings().total,4);assert.equal(f.requests.length,9);
});
test('site/database switches isolate keys, inventories, history, and findings by scope',async t=>{
  const f=await fixture(t);const scope=f.source.scope();f.config.sub2apiBaseUrl='http://127.0.0.1:1';assert.notEqual(f.source.scope(),scope);
  const report=await f.service.report();assert(report.items.every(g=>!g.profile.keyConfigured));assert.equal(f.store.history(f.source.scope(),'1').length,0);
  assert.equal(f.store.profile(f.source.scope(),'1',true).key,null);
});
test('strict input validation rejects arbitrary targets and invalid settings before network writes',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.configureGroup('1',profile(f,1,{url:'http://example.com'})),{code:'GROUP_MONITOR_INVALID_REQUEST'});
  await assert.rejects(f.service.configureGroup('1',profile(f,1,{model:'bad?api_key=secret'})),{code:'GROUP_MONITOR_INVALID_REQUEST'});
  assert.throws(()=>f.service.configurePolicy({...f.store.policy(f.source.scope()),concurrency:6}),{code:'GROUP_MONITOR_INVALID_REQUEST'});
  await assert.rejects(f.service.startRun({groupIds:['1','1']}),{code:'GROUP_MONITOR_NOT_FOUND'});assert.equal(f.requests.length,0);
  await assert.rejects(f.service.report({pageSize:101}),{code:'GROUP_MONITOR_INVALID_REQUEST'});
  for(const id of ['invalid','-1','0','1.2','9223372036854775808'])assert.throws(()=>f.service.detail(id),{code:'GROUP_MONITOR_INVALID_REQUEST'});
});
test('protocol payloads are bounded generation requests with no privileged headers or query credentials',()=>{
  for(const [platform,protocol]of [['anthropic','messages'],['openai','responses'],['gemini','gemini'],['grok','chat']]){
    const request=requestFor({platform},{protocol:'auto',model:'test-model',key:'fictional-key'},128);
    assert.equal(request.protocol,protocol);assert(!request.path.includes('fictional-key'));assert.equal(request.body.stream??false,false);
    assert(!Object.keys(request.headers).includes('x-admin-api-key'));
  }
  assert.equal(hasText({status:'failed',output:[]},'responses'),false);
  assert.equal(hasText({error:{message:'error'}},'messages'),false);
  for(const protocol of ['messages','responses','gemini','chat']) {
    assert.equal(hasText({type:'message',status:'completed',content:{},output:{},candidates:{},choices:{}},protocol),false);
    assert.equal(hasText({type:'message',status:'completed',content:[null],output:[null,{type:'message',content:{}}],candidates:[null,{content:{parts:{}}}],choices:[null]},protocol),false);
  }
});
test('HTTP routes require an admin session and CSRF, persist settings, and return no secrets',async t=>{
  const f=await fixture(t),auth=new AuthService(f.config);t.after(()=>auth.close());
  const app=createApp({config:f.config,auth,database:{},groupMonitor:f.service});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/group-monitor`)).status,401);
  const login=await fetch(`${url}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.config.adminUser,password:f.config.adminPassword})});
  const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,'content-type':'application/json'};
  for(const [method,pathname]of [['POST','/scan'],['POST','/runs'],['POST','/runs/missing/cancel'],['PUT','/policy'],['PUT','/groups/1']])assert.equal((await fetch(`${url}/api/group-monitor${pathname}`,{method,headers,body:'{}'})).status,403);
  headers['x-csrf-token']=session.csrfToken;
  const response=await fetch(`${url}/api/group-monitor`,{headers});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).summary.groups,12);
  assert.equal((await fetch(`${url}/api/group-monitor/groups/invalid`,{headers})).status,400);
  const body=JSON.stringify(profile(f,1,{apiKey:f.keys.get('1')}));const saved=await fetch(`${url}/api/group-monitor/groups/1`,{method:'PUT',headers,body});assert.equal(saved.status,200);assert(!(await saved.text()).includes(f.keys.get('1')));
  const run=await fetch(`${url}/api/group-monitor/runs`,{method:'POST',headers,body:JSON.stringify({groupIds:['1']})});assert.equal(run.status,202);await f.finish();
  assert.equal((await fetch(`${url}/api/group-monitor/groups/1`,{headers}).then(r=>r.json())).status,'ok');
  const files=await fs.readdir(f.directory);assert(files.includes('group-monitor.sqlite'));
  const bytes=await fs.readFile(path.join(f.directory,'group-monitor.sqlite'));assert(!bytes.includes(Buffer.from(f.keys.get('1'))));
});
