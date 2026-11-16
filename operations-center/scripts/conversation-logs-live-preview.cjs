'use strict';

const express = require('express');
const { fixture,event } = require('../tests/conversation-logs-fixture');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');

async function startPreview({port = Number(process.env.CONVERSATION_PREVIEW_PORT || 19907),pushTransport} = {}) {
  const f = fixture();
  const at = Date.now();
  for (let index = 0; index < 35; index++) f.store.ingest(event('sample-' + index,{at:at - 60000 - index * 1000,user_id:index % 3 + 2,key_id:(index % 3 + 2) * 10,...(index === 3 ? {complete:false,reason:'closed_early'} : {})}));
  const raw = event('raw-case',{at,request:Buffer.from('{\n"model":"example-model","messages":[{"role":"user","content":"alice@example.com <img src=x onerror=alert(1)>"}],"big":9007199254740993,"decimal":1.2300,"unknown":true\n}').toString('base64')});
  f.store.ingest(raw);
  f.store.ingest(event('ws-case',{at:at-1000,method:'WS',protocol:'WebSocket',status:101,frames:[
    {direction:'out',at:0,binary:false,body:Buffer.from('{"type":"response.create","input":"alice@example.com"}').toString('base64')},
    ...['alice@','example.com'].map((delta,index) => ({direction:'in',at:100 + index,binary:false,body:Buffer.from(JSON.stringify({type:'response.output_text.delta',item_id:'item_safe',delta})).toString('base64')})),
    {direction:'in',at:500,binary:false,body:Buffer.from('{"type":"response.completed"}').toString('base64')}
  ]}));
  f.store.collectorPolicy();
  const auth = new AuthService(f.config);
  const push = new ConversationPushService(new ConversationPushStore(f.store).initialize(),pushTransport?{transport:pushTransport}:{});
  const app = createApp({config:f.config,auth,database:{},conversations:f.store,conversationPush:push,messages:f.messages,settings:{getStatus:() => ({setupRequired:false})}});
  const outer = express();
  outer.get('/preview',async (req,res,next) => { try { await auth.login(req,res,{username:f.config.adminUser,password:f.config.adminPassword}); res.redirect('/#conversations'); } catch(error) { next(error); } });
  outer.use(app);
  let server;
  while (!server) {
    try { server = await new Promise((resolve,reject) => { const value = outer.listen({host:'127.0.0.1',port,exclusive:true},() => resolve(value)); value.once('error',reject); }); }
    catch(error) { if (error.code !== 'EADDRINUSE') { auth.close(); f.close(); throw error; } port++; }
  }
  push.start();
  let stopped = false;
  return {port:server.address().port,fixture:f,push,raw,async stop() { if (stopped) return; stopped = true; await push.stop();auth.close(); await new Promise(resolve => server.close(resolve)); f.close(); }};
}
if (require.main === module) startPreview().then(preview => {
  console.log(`Conversation archive formal-page preview (fictional local data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => preview.stop().then(() => process.exit(0)));
}).catch(() => { console.error('Conversation preview failed'); process.exitCode = 1; });
module.exports = {startPreview};
