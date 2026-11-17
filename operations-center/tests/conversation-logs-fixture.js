'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { loadConfig } = require('../src/config');
const id = seed => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0,32);
const rawRequest = '{\n  "model":"example-model", "messages":[{"role":"user","content":"联系 alice@example.com，电话 +1-202-555-0148，编号 ORION-42"}], "big":9007199254740993,"decimal":1.2300,"unknown":{"keep":true}\n}';
const rawResponse = '{"id":"resp_demo","output":[{"type":"function_call","call_id":"call_demo","name":"lookup","arguments":"{\\"email\\":\\"alice@example.com\\"}"}],"extra":9007199254740993}';
function event(seed = 'one', extra = {}) {
  return { schema:1,id:id(seed),request_id:id('request-' + seed),user_id:2,key_id:20,account_id:3,session_id:id('session').repeat(2),at:Date.now(),duration_ms:620,
    host:'upstream.example.com',path:'/v1/responses',method:'POST',protocol:'JSON',model:'example-model',status:200,complete:true,reason:'',policy_version:2,encoding:'',
    request:Buffer.from(rawRequest).toString('base64'),response:Buffer.from(rawResponse).toString('base64'),frames:[],...extra };
}
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-conversation-'));
  const store = new ConversationLogStore(directory, options).initialize();
  store.configure({...store.policy(),enabled:true,reserve:0,modelFilterEnabled:false});
  const token = crypto.randomBytes(32).toString('hex');
  const config = loadConfig({ NODE_ENV:'test', OPERATIONS_CENTER_ADMIN_PASSWORD:'conversation-local-preview', CONVERSATION_LOGS_TOKEN:token });
  const users = Array.from({length:25},(_,index) => ({id:index+1,username:'示例用户 ' + (index+1),email:`user${index+1}@example.com`}));
  const messages = { searchUsers: async ({search}) => ({items:users.filter(user => [user.username,user.email,String(user.id)].some(value => value.includes(search))).slice(0,20)}) };
  return { directory,store,token,config,messages, close() { store.close(); fs.rmSync(directory,{recursive:true,force:true}); } };
}
function removeMetadata(store) {
  store.db.exec('DROP TRIGGER cl_metadata_insert; DROP TRIGGER cl_metadata_update; DROP TRIGGER cl_metadata_delete; DROP TABLE cl_record_metadata');
}
module.exports = {fixture,event,id,rawRequest,rawResponse,removeMetadata};
