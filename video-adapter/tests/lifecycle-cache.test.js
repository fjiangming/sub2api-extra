'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('../src/worker');
const { CacheInvalidator } = require('../src/cache');

test('shutdown waits for a pending claim and releases its lease without submitting it',async () => {
  let claimStarted,releaseClaim;
  const started = new Promise(resolve => { claimStarted=resolve; });
  const pending = new Promise(resolve => { releaseClaim=resolve; });
  const unlocked = [];
  const store = { claim:async () => { claimStarted(); return pending; },unlock:async job => { unlocked.push(job.id); } };
  const worker = new Worker(store,{}, { flush:async () => true,ping:async () => {} },{ workerConcurrency:1 });
  worker.stopped = false;
  let submitted = false; worker.process = async () => { submitted=true; };
  const tick = worker.tick();
  await started;
  let stopped = false;
  const stop = worker.stop().then(() => { stopped=true; });
  await Promise.resolve();
  assert.equal(stopped,false);
  releaseClaim({ id:'claimed-during-stop' });
  await Promise.all([tick,stop]);
  assert.equal(submitted,false);
  assert.deepEqual(unlocked,['claimed-during-stop']);
});

test('cache backlog and dependency errors prohibit worker dispatch',async () => {
  let claims = 0;
  const store = { claim:async () => { claims++; return null; } };
  const cache = { flush:async () => false,ping:async () => {} };
  const worker = new Worker(store,{},cache,{ workerConcurrency:1 });
  worker.stopped = false;
  await worker.tick();
  assert.equal(claims,0);
  cache.flush = async () => true;
  cache.ping = async () => { throw new Error('Redis unavailable'); };
  await assert.rejects(worker.tick());
  assert.equal(claims,0);
  await worker.stop();
});

test('RPM uses native Redis time, keys and counters shared with non-video traffic',async () => {
  const seconds = 1791588000;
  const minute = Math.floor(seconds/60);
  const userKey = `rpm:u:1:${minute}`;
  const counters = new Map([[userKey,1]]);
  const redis = {
    sendCommand:async args => { assert.deepEqual(args,['TIME']); return [String(seconds),'0']; },
    multi() {
      let key;
      return {
        incr(value) { key=value; return this; },
        expire(value,ttl) { assert.equal(value,key); assert.equal(ttl,120); return this; },
        async exec() { const count=(counters.get(key)||0)+1; counters.set(key,count); return [count,1]; }
      };
    }
  };
  const cache = new CacheInvalidator({},redis);
  const who = { usr:{ id:'1',rpm_limit:1 },grp:{ id:'2',rpm_limit:1 },rpm_override:0 };
  await assert.rejects(cache.enforceRpm(who),{ code:'USER_RPM_LIMIT' });
  assert.equal(counters.has(`rpm:ug:1:2:${minute}`),false);
  who.usr.rpm_limit = 0;
  who.rpm_override = 1;
  await cache.enforceRpm(who);
  await assert.rejects(cache.enforceRpm(who),{ code:'GROUP_RPM_LIMIT' });
});

test('failed cache invalidations remain durable for the next flush',async () => {
  let deleted = false;
  const db = { query:async sql => {
    if (sql.startsWith('SELECT *')) return { rows:[{ id:1,user_id:1 }] };
    if (sql.startsWith('SELECT id,key')) return { rows:[{ id:2,key:'test-key' }] };
    if (sql.startsWith('DELETE')) deleted=true;
    return { rows:[] };
  } };
  const redis = { multi() {
    return { del() { return this; },publish() { return this; },exec:async () => [new Error('Cache write denied')] };
  } };
  await assert.rejects(new CacheInvalidator(db,redis).flush(),{ code:'CACHE_INVALIDATION_FAILED' });
  assert.equal(deleted,false);
});

test('an occupied listen port exits cleanly with sanitized startup diagnostics',async t => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const child = spawn(process.execPath,[path.resolve(__dirname,'../src/server.js'),'--demo'],{
    env:{ ...process.env,VIDEO_ADAPTER_PORT:String(listener.address().port),VIDEO_ADAPTER_BIND_HOST:'127.0.0.1' },stdio:['ignore','pipe','pipe']
  });
  t.after(() => { child.kill(); listener.close(); });
  let output = '';
  child.stdout.on('data',chunk => { output+=chunk.toString(); });
  child.stderr.on('data',chunk => { output+=chunk.toString(); });
  let timer;
  const code = await Promise.race([
    new Promise((resolve,reject) => { child.once('exit',resolve); child.once('error',reject); }),
    new Promise((_resolve,reject) => { timer=setTimeout(() => reject(new Error('Startup cleanup did not exit')),15000); })
  ]).finally(() => clearTimeout(timer));
  assert.equal(code,1);
  assert.match(output,/"event":"startup_failed"/);
  assert.match(output,/"code":"STARTUP_FAILED"/);
  assert.ok(!output.includes('EADDRINUSE'));
});
