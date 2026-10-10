'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyCoreSchema } = require('./db');
const { parseCatalog } = require('./config');

async function createDemoDatabase() {
  const { PGlite } = require('@electric-sql/pglite');
  const database = new PGlite();
  const db = { query:(...args) => database.query(...args),tx:action => database.transaction(tx => action({ query:(...args) => tx.query(...args) })),close:() => database.close() };
  await database.exec(fs.readFileSync(path.join(__dirname,'../tests/fixtures/core.sql'),'utf8'));
  await verifyCoreSchema(db);
  // PGlite's extended-query API accepts one statement at a time.
  await database.exec(fs.readFileSync(path.join(__dirname,'../sql/001_adapter.sql'),'utf8'));
  await db.query("INSERT INTO users(id,balance,frozen_balance,status) VALUES(1,100,0,'active'),(2,100,0,'active')");
  await db.query(`INSERT INTO groups(id,platform,subscription_type,status,allow_image_generation,video_rate_independent,video_rate_multiplier,rate_multiplier,video_model_prices)
    VALUES(1,'grok','standard','active',TRUE,TRUE,1,1,'{"demo-video":{"480p":0.1}}')`);
  await db.query("INSERT INTO api_keys(id,key,user_id,group_id,status) VALUES(1,'sk-demo-video-local-only',1,1,'active'),(2,'sk-demo-other-local-only',2,1,'active')");
  await db.query('INSERT INTO accounts(id) VALUES(1)');
  return db;
}

function demoCatalog() {
  return parseCatalog({ version:'demo-1',providers:[{ id:'demo',type:'mock',baseUrl:'https://example.invalid',enabled:true,idempotentCreate:true,idempotencyRetentionSeconds:86400,financialMode:'funds_status',dailyCostBudgetUsd:'50' }],
    models:[{ id:'demo-video',upstreamModel:'demo-video',provider:'demo',enabled:true,minDuration:1,maxDuration:30,defaultDuration:5,resolutions:['480p'],aspectRatios:['16:9','9:16'],
      maxReferences:{ image:0,video:0,audio:0,total:0 },cost:{ mode:'per_request',currency:'USD',prices:{ default:'0.10' },verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),evidence:'Local deterministic mock; no supplier calls' } }] },{},false);
}

module.exports = { createDemoDatabase, demoCatalog };
