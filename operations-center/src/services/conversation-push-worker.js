'use strict';

const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');
const { ConversationLogStore } = require('../conversation-log-store');
const { ConversationPushStore } = require('../conversation-push-store');
const { ConversationPushService } = require('./conversation-push-service');

function availableMemory(override) {
  if (Number.isSafeInteger(override) && override >= 0) return override;
  let available = os.freemem();
  for (const [maximum, used] of [['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/memory/memory.usage_in_bytes']]) {
    try { const limit = fs.readFileSync(maximum, 'utf8').trim(); if (limit !== 'max') available = Math.min(available, Number(limit) - Number(fs.readFileSync(used, 'utf8'))); }
    catch { /* Other hosts use free system memory. */ }
  }
  return Math.max(0, available);
}

process.once('message', settings => {
  if (settings?.type !== 'initialize') return process.exit(1);
  let archive, service, timer, stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); await service?.stop(); archive?.close(); process.exit(0); };
  try {
    archive = new ConversationLogStore(settings.directory, { timezone: settings.timezone }).initialize();
    archive.db.pragma('busy_timeout = 250');
    const budget = () => Math.max(0, Math.min(availableMemory(settings.memoryBudgetBytes) - 33554432,
      v8.getHeapStatistics().heap_size_limit - v8.getHeapStatistics().used_heap_size - 33554432));
    service = new ConversationPushService(new ConversationPushStore(archive).initialize(), { jsonlOptions: { memoryBudget: budget } });
    const report = () => { if (process.connected) process.send({ type: 'status', lastError: service.lastError, lastRun: service.lastRun,
      jsonlError: service.jsonl.lastError, jsonlRun: service.jsonl.lastRun }, () => {}); };
    process.on('message', async message => {
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
