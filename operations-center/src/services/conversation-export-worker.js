'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {setTimeout:delay} = require('node:timers/promises');
const {performance} = require('node:perf_hooks');
const express = require('express');
const {ConversationLogStore} = require('../conversation-log-store');
const {AppError} = require('../errors');
const {ConversationExportData,failure} = require('./conversation-export-data');
const {jsonlChunks} = require('./conversation-jsonl-format');

process.once('message',async settings => {
  if (settings?.type!=='initialize' || !settings.secret) return process.exit(1);
  let store,server,permit=false,permitAt=0;
  process.on('message',message => { if (message?.type==='export-permit') {permit=message.allowed===true;permitAt=Date.now();} });
  try {
    store=new ConversationLogStore(settings.directory,{timezone:settings.timezone}).openReader();
    store.db.pragma('query_only = ON');
    const data=new ConversationExportData(store,{memoryBudgetBytes:settings.memoryBudgetBytes});
    const app=express();app.disable('x-powered-by');
    app.use((req,res,next) => {
      const supplied=crypto.createHash('sha256').update(req.get('authorization') || '').digest();
      const expected=crypto.createHash('sha256').update('Bearer '+settings.secret).digest();
      if (!crypto.timingSafeEqual(supplied,expected)) return res.sendStatus(401);
      next();
    });
    app.get('/export',async (req,res) => {
      const controller=new AbortController(),signal=controller.signal;
      res.once('close',() => controller.abort());res.once('error',() => controller.abort());
      let stats={selected:0,exported:0,skipped:{},fallbacks:0,fallbackReasons:{},bytes:0,pauseReason:''},selection,row,lastReport=0;
      const progress=(force=false) => {
        if (force || Date.now()-lastReport>250) {
          lastReport=Date.now();process.send?.({type:'export-progress',...stats},() => {});
        }
      };
      try {
        const {spec,bytesPerSecond,maxPauseMs}=JSON.parse(req.get('x-conversation-export'));
        let nextSend=performance.now();
        const checkpoint=async () => {
          signal.throwIfAborted();
          if (selection) data.guard(selection,row);
          const began=Date.now();
          while (!permit || Date.now()-permitAt>1500) {
            if (Date.now()-began>maxPauseMs) throw failure('BUSY','采集持续繁忙，本次下载已中止，请稍后重试',503);
            stats.pauseReason='archive_busy';progress();
            await delay(50,undefined,{signal});
            if (selection) data.guard(selection,row);
          }
          if (stats.pauseReason) {stats.pauseReason='';progress(true);}
        };
        await checkpoint();
        selection=data.select(spec);
        stats={...stats,selected:selection.selected,skipped:selection.skipped};progress(true);
        if (!selection.rows.length) throw failure('EMPTY',selection.selected ? '最近所选日志没有可导出的副本，请查看跳过原因' : '当前筛选下没有可导出的日志');
        const stamp=new Date().toISOString().replace(/[-:.]/g,''),copyName=spec.source==='masked'?'masked-or-original':'original';
        res.set({'content-type':'application/x-ndjson; charset=utf-8',
          'content-disposition':`attachment; filename="conversation-latest-${spec.limit}-${copyName}-${stamp}.jsonl"`,
          'cache-control':'no-store','x-content-type-options':'nosniff','x-accel-buffering':'no',
          trailer:'x-conversation-export-result'});
        const hash=crypto.createHash('sha256');let sinceCheck=0;
        const write=async buffer => {
          signal.throwIfAborted();
          if (sinceCheck>=262144) {await checkpoint();sinceCheck=0;}
          const at=Math.max(nextSend,performance.now());
          if (at>performance.now()) await delay(at-performance.now(),undefined,{signal});
          nextSend=at+buffer.length*1000/bytesPerSecond;
          if (!res.write(buffer)) await once(res,'drain',{signal});
          hash.update(buffer);stats.bytes+=buffer.length;sinceCheck+=buffer.length;progress();
        };
        for (const selected of selection.rows) {
          row=selected;await checkpoint();
          const envelope=data.envelope(selection,row);
          let pieces=[],size=0;
          for (const chunk of jsonlChunks(envelope)) {
            const bytes=Buffer.from(chunk);
            if (size && size+bytes.length>65536) {await write(Buffer.concat(pieces,size));pieces=[];size=0;}
            pieces.push(bytes);size+=bytes.length;
          }
          if (size) await write(Buffer.concat(pieces,size));
          data.guard(selection,row);stats.exported++;
          if (envelope.fallback_reason) {stats.fallbacks++;stats.fallbackReasons[envelope.fallback_reason]=(stats.fallbackReasons[envelope.fallback_reason] || 0)+1;}
          progress();
          // Release this record before admitting the next, and let IPC priority updates run.
          await new Promise(resolve => setImmediate(resolve));
        }
        row=null;await checkpoint();
        stats.sha256=hash.digest('hex');progress(true);
        res.addTrailers({'x-conversation-export-result':JSON.stringify(stats)});res.end();
      } catch(error) {
        progress(true);
        const safe=error instanceof AppError;
        const value={code:safe ? error.code : 'CONVERSATION_EXPORT_UNAVAILABLE',
          message:safe ? error.message : '导出中断，文件可能不完整，请重新导出',status:safe ? error.status : 503};
        process.send?.({type:'export-error',...value},() => {});
        if (res.headersSent || res.destroyed) {
          const timer=setTimeout(() => res.destroy(),100);timer.unref();
        }
        else {res.removeHeader('trailer');res.removeHeader('content-disposition');res.status(value.status).json({error:value});}
      }
    });
    server=http.createServer(app);server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=1;
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    process.send?.({type:'ready',port:server.address().port});
    const stop=() => {server.close();store.close();process.exit(0);};
    process.once('disconnect',stop);process.once('SIGTERM',stop);
  } catch {store?.close();process.exit(1);}
});
