'use strict';

const { ConversationLogStore } = require('../conversation-log-store');
const { ConversationPushStore } = require('../conversation-push-store');
const { ConversationPushService } = require('./conversation-push-service');
const { processingBudget } = require('./conversation-memory');

process.once('message', settings => {
  if (settings?.type !== 'initialize') return process.exit(1);
  let archive, service, timer, stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); await service?.stop(); archive?.close(); process.exit(0); };
  try {
    archive = new ConversationLogStore(settings.directory, { timezone: settings.timezone }).initialize();
    archive.db.pragma('busy_timeout = 250');
    const budget = () => processingBudget(settings.memoryBudgetBytes);
    let priorityUntil = 0;
    service = new ConversationPushService(new ConversationPushStore(archive).initialize(), { jsonlOptions: { memoryBudget: budget },
      canWork: () => Date.now() < priorityUntil && !archive.hasPending() });
    const report = () => { if (process.connected) process.send({ type: 'status', lastError: service.lastError, lastRun: service.lastRun,
      jsonlError: service.jsonl.lastError, jsonlRun: service.jsonl.lastRun }, () => {}); };
    process.on('message', async message => {
      if (message?.type === 'priority') priorityUntil = message.allowed === true ? Date.now() + 1000 : 0;
      if (message?.type === 'wake') service.wake();
      if (message?.type === 'invalidate') { service.invalidate(); service.wake(); }
      if (message?.type === 'stop') await stop();
      if (message?.type === 'test') {
        let result;
        try { result = await service.test(message.destination); } catch { result = { status: 'failed', errorCode: 'CONVERSATION_PUSH_BUSY' }; }
        if (process.connected) process.send({ type: 'test-result', id: message.id, result }, () => {});
      }
    });
    process.once('disconnect', stop); process.once('SIGTERM', stop);
    service.start(); timer = setInterval(report, 1000); timer.unref(); process.send?.({ type: 'ready' });
  } catch { archive?.close(); process.exit(1); }
});
