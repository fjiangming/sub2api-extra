'use strict';

const express = require('express');
const { fixture,event } = require('../tests/conversation-logs-fixture');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushSupervisor } = require('../src/services/conversation-push-supervisor');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { ConversationCleanupService } = require('../src/services/conversation-cleanup-service');

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
  f.store.ingest(event('privacy-case',{at:at-2000,user_id:3,request:Buffer.from(JSON.stringify({model:'example-model',messages:[{role:'user',content:'张三，请查询示例账户'}],customer:{name:'张三',id_card:'11010519491231002X',card_number:'4111111111111111',passport_no:'E12345678',address:'测试路 12 号'},otp:246810})).toString('base64')}));
  f.store.ingest(event('signature-case',{at:at-500,request:Buffer.from(JSON.stringify({model:'example-model',messages:[
    {role:'assistant',content:[{type:'thinking',thinking:'联系 alice@example.com',signature:'ZmljdGlvbmFsLXByb3RvY29sLXNpZ25hdHVyZQ=='}]},
    {role:'user',content:'继续处理链接',url:'https://service.example/contact?email=alice%40example.com&keep=ok'}
  ]})).toString('base64')}));
  f.store.collectorPolicy(0,'2');
  const auth = new AuthService(f.config);
  const pushStore = new ConversationPushStore(f.store).initialize();
  const push = pushTransport ? new ConversationPushService(pushStore,{transport:pushTransport}) : new ConversationPushSupervisor(pushStore);
  const archive = new ConversationArchiveService(f.store);
  const cleanup = new ConversationCleanupService(f.store);
  await archive.start();
  const app = createApp({config:f.config,auth,database:{},conversations:f.store,conversationArchive:archive,conversationPush:push,conversationCleanup:cleanup,messages:f.messages,settings:{getStatus:() => ({setupRequired:false})}});
  const outer = express();
  outer.get('/preview',async (req,res,next) => { try { await auth.login(req,res,{username:f.config.adminUser,password:f.config.adminPassword}); res.redirect('/#conversations'); } catch(error) { next(error); } });
  outer.use(app);
  let server;
  while (!server) {
    try { server = await new Promise((resolve,reject) => { const value = outer.listen({host:'127.0.0.1',port,exclusive:true},() => resolve(value)); value.once('error',reject); }); }
    catch(error) { if (error.code !== 'EADDRINUSE') { await archive.stop(); auth.close(); f.close(); throw error; } port++; }
  }
  push.start();
  cleanup.start();
  let stopped = false;
  return {port:server.address().port,fixture:f,push,cleanup,raw,async stop() { if (stopped) return; stopped = true; await cleanup.stop(); await push.stop(); await archive.stop(); auth.close(); await new Promise(resolve => server.close(resolve)); f.close(); }};
}
if (require.main === module) startPreview().then(preview => {
  console.log(`Conversation archive formal-page preview (fictional local data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => preview.stop().then(() => process.exit(0)));
}).catch(() => { console.error('Conversation preview failed'); process.exitCode = 1; });
module.exports = {startPreview};
