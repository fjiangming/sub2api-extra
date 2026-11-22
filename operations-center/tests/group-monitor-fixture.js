'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { loadConfig } = require('../src/config');
const { GroupMonitorStore } = require('../src/group-monitor-store');
const { GroupMonitorSource } = require('../src/services/group-monitor-source');
const { GroupMonitorService } = require('../src/services/group-monitor-service');

async function groupMonitorFixture({ configured = true, seed = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-group-monitor-'));
  const database = new PGlite();
  await database.exec(`CREATE TABLE groups(id BIGINT PRIMARY KEY,name TEXT,platform TEXT,rate_multiplier NUMERIC,status TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE accounts(id BIGINT PRIMARY KEY,name TEXT,platform TEXT,rate_multiplier NUMERIC,status TEXT,schedulable BOOLEAN,deleted_at TIMESTAMPTZ);
    CREATE TABLE account_groups(group_id BIGINT,account_id BIGINT,PRIMARY KEY(group_id,account_id));
    CREATE TABLE users(id BIGINT PRIMARY KEY,status TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE api_keys(id BIGINT PRIMARY KEY,key TEXT,user_id BIGINT,group_id BIGINT,status TEXT,expires_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);
    INSERT INTO users VALUES(2,'active',NULL);`);
  const keys = new Map(), requests = [], failGroups = new Map([['8',503],['9',401]]), malformed = new Set(), empty = new Set();
  let delayMs = 0, gatewayActive = 0, maxActive = 0, now = Date.now(), locked = Promise.resolve(), readAvailable = true;
  const gateway = http.createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const key = req.headers['x-api-key'] || req.headers['x-goog-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /,'');
    const groupId = [...keys].find(([,v]) => v === key)?.[0];
    const body = JSON.parse(text || '{}');
    requests.push({ groupId, path:req.url, method:req.method, body });
    gatewayActive++;maxActive=Math.max(maxActive,gatewayActive);
    try {
      if(delayMs)await new Promise(resolve=>{const timer=setTimeout(resolve,delayMs);res.once('close',()=>{clearTimeout(timer);resolve();});});
      if(res.destroyed)return;
      res.setHeader('content-type','application/json');res.setHeader('x-request-id',`monitor-fixture-${requests.length}`);
      if(failGroups.has(groupId)){res.statusCode=failGroups.get(groupId);res.end(JSON.stringify({error:{message:'fictional upstream failure'}}));return;}
      if(malformed.has(groupId)){res.end('<html>login</html>');return;}
      const output=empty.has(groupId)?'':'OK';
      const payload = req.url==='/v1/messages'?{type:'message',content:[{type:'text',text:output}],usage:{input_tokens:4,output_tokens:1}}:
        req.url==='/v1/responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:output}]}]}:
        req.url.startsWith('/v1beta/models/')?{candidates:[{content:{parts:[{text:output}]}}]}:{choices:[{message:{content:output}}]};
      res.end(JSON.stringify(payload));
    } finally {gatewayActive--;}
  });
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${gateway.address().port}`;
  const config=loadConfig({ NODE_ENV:'test',OPERATIONS_CENTER_ADMIN_PASSWORD:'group-monitor-preview-password',
    SUB2API_BASE_URL:origin,SUB2API_DATABASE_URL:'postgresql://fixture@localhost/group-monitor',OPERATIONS_CENTER_DATA_DIR:directory });
  const queries=[];
  const pool={ configured:()=>readAvailable, connect:async()=>{
    const previous=locked;let unlock;locked=new Promise(resolve=>{unlock=resolve;});await previous;
    return {query:async(sql,args)=>{queries.push(sql);return database.query(sql,args);},release:()=>unlock()};
  }};
  const key=crypto.randomBytes(32),store=new GroupMonitorStore(directory,{key,now:()=>now}).initialize();
  const source=new GroupMonitorSource({pool,config});
  const service=new GroupMonitorService({store,source,config,now:()=>now});
  if(seed){
    const groupData=[['Claude 标准','anthropic',.8],['Claude 高优','anthropic',1.2],['Claude 特价','anthropic',.4],['OpenAI 标准','openai',.8],['OpenAI 高优','openai',1],['Gemini 标准','gemini',.6],['Gemini Flash','gemini',.3],['Claude 备用','anthropic',.7],['OpenAI 测试','openai',1],['Gemini 新分组','gemini',.5],['OpenAI 空闲','openai',.5],['Claude 历史','anthropic',.4]];
    for(let i=0;i<groupData.length;i++){
      const [name,platform,rate]=groupData[i],id=i+1;
      await database.query('INSERT INTO groups VALUES($1,$2,$3,$4,$5,NULL)',[id,name,platform,rate,id===12?'disabled':'active']);
      const key=`sk-fictional-monitor-key-${id}`;keys.set(String(id),key);
      await database.query("INSERT INTO api_keys VALUES($1,$2,2,$1,'active',NULL,NULL)",[id,key]);
    }
    const accountData=[[101,'claude-primary-01',.65],[102,'claude-shared-02',1.2],[103,'claude-premium-03',1.5],[104,'claude-budget-04',.3],[105,'claude-budget-05',.4],[106,'claude-retired-06',1.8,'disabled'],[201,'openai-primary-01',.6],[202,'openai-shared-02',1],[203,'openai-premium-03',.9],[301,'gemini-primary-01',.5],[302,'gemini-backup-02',.8],[303,'gemini-flash-03',.2],[305,'gemini-imported-05',null],[107,'claude-backup-07',.65],[108,'claude-backup-08',.7],[204,'openai-test-04',.85],[304,'gemini-new-04',.4],[205,'openai-retired-05',1.7,'disabled'],[109,'claude-legacy-09',.9]];
    for(const [id,name,rate,status='active']of accountData)await database.query('INSERT INTO accounts VALUES($1,$2,$3,$4,$5,true,NULL)',[id,name,id>=300?'gemini':id>=200?'openai':'anthropic',rate,status]);
    const membership=[[101,102],[102,103],[104,105,106],[201,202],[202,203],[301,302],[303,305],[107,108],[204],[304],[205],[109]];
    for(let i=0;i<membership.length;i++)for(const id of membership[i])await database.query('INSERT INTO account_groups VALUES($1,$2)',[i+1,id]);
    await service.scan();
    if(configured)for(let id=1;id<=9;id++)await service.configureGroup(String(id),{revision:0,model:id<=3||id===8?'claude-haiku-4-5':id<=5||id===9?'gpt-5-mini':'gemini-2.5-flash',protocol:'auto',apiKey:keys.get(String(id))});
  }
  return {directory,database,config,pool,source,service,store,key,keys,requests,queries,failGroups,malformed,empty,gateway,origin,
    advance(ms){now+=ms;},setDelay(ms){delayMs=ms;},readAvailable(value){readAvailable=value;},get maxActive(){return maxActive;},
    async finish(){if(service.job)await service.job.promise;},
    async close(){await service.stop();store.close();await database.close();gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
  };
}

module.exports={groupMonitorFixture};
