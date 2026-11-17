'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { ConversationLogStore } = require('../conversation-log-store');
const { AppError } = require('../errors');
const { processingBudget } = require('./conversation-memory');
const { sendPayload } = require('./conversation-read-response');

process.once('message', async settings => {
  if (settings?.type !== 'initialize' || !settings.secret) return process.exit(1);
  let store,server;
  try {
    store = new ConversationLogStore(settings.directory,{timezone:settings.timezone,
      processingLimits:() => ({maxOutputBytes:Math.min(256*1024**2,Math.floor(processingBudget(settings.memoryBudgetBytes)/8))})}).openReader();
    const app = express();app.disable('x-powered-by');
    app.use((req,res,next) => {
      const supplied = crypto.createHash('sha256').update(req.get('authorization') || '').digest();
      const expected = crypto.createHash('sha256').update('Bearer ' + settings.secret).digest();
      if (!crypto.timingSafeEqual(supplied,expected)) return res.sendStatus(401);
      next();
    });
    function admit(id) {
      const row = store.db.prepare('SELECT bytes FROM cl_record_metadata WHERE id=?').get(id)
        || store.db.prepare('SELECT bytes FROM cl_records WHERE id=?').get(id);
      if (row && row.bytes * 8 + 1048576 > processingBudget(settings.memoryBudgetBytes)) {
        throw new AppError('CONVERSATION_READ_MEMORY','当前读取内存不足，原文保留，请稍后重试',{status:409});
      }
    }
    app.post('/index-next', (_req,res) => res.json(store.backfillMetadata()));
    app.get('/status', (req,res) => {
      const live = JSON.parse(req.get('x-conversation-live') || '{}');
      const value = store.status();
      res.set('x-conversation-metadata-ready',String(value.metadataIndex.ready)).json({...value,...live});
    });
    app.get('/records', (req,res) => {
      const value = store.list(req.query);
      res.set('x-conversation-metadata-ready',String(value.metadataIndex.ready)).json(value);
    });
    app.get('/sessions', (req,res) => res.json(store.sessions(req.query)));
    app.get('/index', (req,res) => res.json(store.exportIndex(req.query)));
    app.get('/records/:id', (req,res) => {
      const row = store.db.prepare('SELECT protocol FROM cl_record_metadata WHERE id=?').get(req.params.id);
      if (!row || row.protocol === 'WebSocket') admit(req.params.id);
      res.json(store.detail(req.params.id));
    });
    app.get('/records/:id/payload/:side', (req,res) => {
      admit(req.params.id);
      const value = store.payload(req.params.id,req.query.source || 'masked',req.params.side,{decodeText:req.query.download !== '1'});
      if (value.textLimited && ['preview','text'].includes(req.query.view)) throw new AppError('CONVERSATION_READ_MEMORY','当前文本解码内存不足，可下载原始字节或稍后重试',{status:409});
      sendPayload(req,res,value);
    });
    app.use((_req,res) => res.sendStatus(404));
    app.use((error,_req,res,_next) => {
      const safe = error instanceof AppError;
      res.status(safe ? error.status : 503).json({error:{code:safe ? error.code : 'CONVERSATION_READ_UNAVAILABLE',
        message:safe ? error.message : '日志读取暂不可用，请稍后重试'}});
    });
    server = http.createServer(app);server.requestTimeout = 15000;server.headersTimeout = 10000;server.maxConnections = 2;
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    process.send?.({type:'ready',port:server.address().port});
    const stop = () => {server.close();store.close();process.exit(0);};
    process.once('disconnect',stop);process.once('SIGTERM',stop);
  } catch {store?.close();process.exit(1);}
});
