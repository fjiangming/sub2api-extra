'use strict';

const { ConversationLogStore } = require('../conversation-log-store');
const { ConversationRepairStore } = require('../conversation-repair-store');
const { processingBudget } = require('./conversation-memory');

process.once('message', settings => {
  if (settings?.type !== 'initialize') return process.exit(1);
  let archive, stopped = false;
  const stop = () => { if (stopped) return; stopped = true; archive?.close(); process.exit(0); };
  try {
    const budget = () => processingBudget(settings.memoryBudgetBytes);
    archive = new ConversationLogStore(settings.directory,{timezone:settings.timezone,
      processingLimits:() => ({maxOutputBytes:Math.min(256 * 1024 ** 2,Math.floor(budget() / 8))})}).initialize();
    archive.db.pragma('busy_timeout = 1'); archive.db.pragma('cache_size = -2048'); archive.db.pragma('wal_autocheckpoint = 0');
    // Only encrypted pages are freed; avoid multi-MiB ciphertext overwrites under the shared write lock.
    archive.db.pragma('secure_delete = OFF');
    const repair = new ConversationRepairStore(archive,{memoryBudget:budget}).initialize();
    process.on('message', message => {
      if (message?.type === 'stop') return stop();
      if (message?.type !== 'step' || stopped) return;
      try { process.send?.({type:'idle',...repair.step()}); }
      catch (error) {
        if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '') || error.code === 'CONVERSATION_REPAIR_CONFLICT') process.send?.({type:'idle',busy:true});
        else { process.send?.({type:'failure'}); process.exit(1); }
      }
    });
    process.once('disconnect',stop); process.once('SIGTERM',stop); process.send?.({type:'ready'});
  } catch { archive?.close(); process.exit(1); }
});
