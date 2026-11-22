'use strict';

const express = require('express');
const { groupMonitorFixture } = require('../tests/group-monitor-fixture');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

async function startPreview({ port = Number(process.env.GROUP_MONITOR_PREVIEW_PORT || 19922) } = {}) {
  const fixture = await groupMonitorFixture();
  await fixture.service.startRun(); await fixture.finish(); fixture.service.start();
  const auth = new AuthService(fixture.config), outer = express();
  outer.get('/preview', async (req,res,next) => {
    try { await auth.login(req,res,{ username:fixture.config.adminUser,password:fixture.config.adminPassword }); res.redirect('/#group-monitor'); }
    catch(error){next(error);}
  });
  const metrics = {
    getOverview: () => ({ activity:{dau:0,mau:0},usage:{requests_today:0,spend_month:0},users:{available_users:0,new_month:0},
      timezones:{usage:'Asia/Shanghai',finance:'Asia/Shanghai'},payments:[],coverage:{daily_from:'2026-11-22'},generatedAt:new Date().toISOString() }),
    getUsage: () => ({ timezone:'Asia/Shanghai',range:{start:'2026-11-22',end:'2026-11-22'},trend:[],summary:{} })
  };
  outer.use(createApp({ config:fixture.config,auth,database:{},metrics,groupMonitor:fixture.service,settings:{getStatus:()=>({setupRequired:false})} }));
  let server;
  try {
    while(!server) {
      try { server=await new Promise((resolve,reject)=>{const value=outer.listen({host:'127.0.0.1',port,exclusive:true},()=>resolve(value));value.once('error',reject);}); }
      catch(error){if(error.code!=='EADDRINUSE')throw error;port++;}
    }
  } catch(error){auth.close();await fixture.close();throw error;}
  let stopped=false;
  return {port:server.address().port,fixture,async stop(){if(stopped)return;stopped=true;auth.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fixture.close();}};
}
if(require.main===module)startPreview().then(preview=>{
  console.log(`Group monitor formal-page preview (fictional local data): http://127.0.0.1:${preview.port}/preview`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>preview.stop().then(()=>process.exit(0)));
}).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={startPreview};
