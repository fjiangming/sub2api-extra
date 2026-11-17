'use strict';

const { ConversationLogStore } = require('../conversation-log-store');
const { ConversationCleanupStore } = require('../conversation-cleanup-store');

process.once('message', settings => {
  if (settings?.type !== 'initialize') return process.exit(1);
  let archive, stopped = false;
  const stop = () => { if (stopped) return; stopped = true; archive?.close(); process.exit(0); };
  try {
    archive = new ConversationLogStore(settings.directory, { timezone: settings.timezone }).initialize();
    archive.db.pragma('foreign_keys = ON');
    archive.db.pragma('busy_timeout = 1');
    archive.db.pragma('cache_size = -2048');
    archive.db.pragma('wal_autocheckpoint = 0');
    // Body values are already AES-GCM ciphertext. Avoid overwriting multi-MiB freed BLOBs under a write lock.
    archive.db.pragma('secure_delete = OFF');
    const cleanup = new ConversationCleanupStore(archive).initialize();
    process.on('message', message => {
      if (message?.type === 'stop') return stop();
      if (message?.type !== 'step' || stopped) return;
      try {
        process.send?.({ type: 'idle', ...cleanup.step() });
      } catch (error) {
        if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) process.send?.({ type: 'idle', busy: true });
        else { process.send?.({ type: 'failure', code: 'CLEANUP_STORAGE_UNAVAILABLE' }); process.exit(1); }
      }
    });
    process.once('disconnect', stop); process.once('SIGTERM', stop);
    process.send?.({ type: 'ready' });
  } catch { archive?.close(); process.exit(1); }
});
