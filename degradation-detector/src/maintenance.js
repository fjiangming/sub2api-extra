'use strict';

const fs = require('fs');
const path = require('path');
const { setImmediate: yieldToRequests } = require('node:timers/promises');

class MaintenanceService {
  constructor({ config, store, isIdle = () => true }) {
    this.config = config;
    this.store = store;
    this.isIdle = isIdle;
    this.timer = null;
    this.active = null;
    this.closed = false;
    this.nextRunAt = 0;
    this.monitorCursor = 0;
    this.roundPending = false;
    this.directory = null;
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), 60000);
    this.timer.unref?.();
    this.tick();
  }

  tick() {
    if (this.closed || this.active || Date.now() < this.nextRunAt) return;
    this.run().catch((error) => {
      console.error(JSON.stringify({ event: 'maintenance_failed', code: error.code || 'UNKNOWN' }));
    });
  }

  run(timestamp = Date.now()) {
    if (this.active) return this.active;
    if (this.closed) return Promise.resolve(null);
    this.nextRunAt = timestamp + 60000;
    this.active = this.perform(timestamp).finally(() => { this.active = null; });
    return this.active;
  }

  async removeFiles(filenames) {
    const root = path.resolve(this.config.artifactDir);
    let removed = 0;
    for (const filename of new Set(filenames)) {
      const resolved = path.resolve(filename);
      if (path.dirname(resolved) !== root || this.store.isArtifactReferenced(resolved)) continue;
      try {
        if (!(await fs.promises.lstat(resolved)).isFile()) continue;
        await fs.promises.rm(resolved, { force: true });
        removed += 1;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        console.error(JSON.stringify({ event: 'maintenance_file_cleanup_failed', code: error.code || 'UNKNOWN' }));
      }
    }
    return removed;
  }

  async sweepOrphans(timestamp) {
    try {
      if (!this.directory) this.directory = await fs.promises.opendir(this.config.artifactDir);
      let removed = 0;
      for (let scanned = 0; scanned < 500; scanned += 1) {
        const entry = await this.directory.read();
        if (!entry) {
          await this.closeDirectory();
          return { removed, pending: false };
        }
        if (!entry.isFile()) continue;
        const filename = path.join(this.config.artifactDir, entry.name);
        try {
          const stat = await fs.promises.lstat(filename);
          if (!stat.isFile() || timestamp - stat.mtimeMs < 3600000 || this.store.isArtifactReferenced(filename)) continue;
          await fs.promises.rm(filename, { force: true });
          removed += 1;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.error(JSON.stringify({ event: 'maintenance_orphan_cleanup_failed', code: error.code || 'UNKNOWN' }));
          }
        }
      }
      return { removed, pending: true };
    } catch (error) {
      await this.closeDirectory();
      throw error;
    }
  }

  async closeDirectory() {
    const directory = this.directory;
    this.directory = null;
    if (!directory) return;
    await directory.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') {
        console.error(JSON.stringify({ event: 'maintenance_directory_close_failed', code: error.code || 'UNKNOWN' }));
      }
    });
  }

  async perform(timestamp) {
    const policy = this.store.getServiceSettings().storage_policy;
    const monitors = this.store.listMaintenanceMonitors(this.monitorCursor, 20);
    let pending = this.roundPending;
    let archived = 0;
    let filesRemoved = 0;
    for (const monitor of monitors) {
      if (this.closed) return null;
      try {
        const result = this.store.archiveHistory(monitor, policy, timestamp);
        archived += result.archived;
        pending ||= result.pending;
        const stalePaths = this.store.pruneRuns(monitor.id, policy.artifact_per_group);
        filesRemoved += await this.removeFiles([...result.artifactPaths, ...stalePaths]);
        pending ||= this.store.hasExpiredPayloads(monitor.id, policy.artifact_per_group);
      } catch (error) {
        pending = true;
        console.error(JSON.stringify({ event: 'maintenance_group_failed', monitorId: monitor.id, code: error.code || 'UNKNOWN' }));
      }
      await yieldToRequests();
    }
    const lastId = monitors.at(-1)?.id || 0;
    if (monitors.length === 20 && this.store.listMaintenanceMonitors(lastId, 1).length) {
      this.monitorCursor = lastId;
      this.roundPending = pending;
      pending = true;
    } else {
      this.monitorCursor = 0;
      this.roundPending = false;
    }
    const orphans = await this.sweepOrphans(timestamp);
    filesRemoved += orphans.removed;
    pending ||= orphans.pending;
    let compacted = false;
    if (this.isIdle()) {
      try {
        compacted = this.store.compactDatabase(timestamp);
      } catch (error) {
        console.error(JSON.stringify({ event: 'maintenance_compaction_failed', code: error.code || 'UNKNOWN' }));
      }
    }
    const result = { archived, files_removed: filesRemoved, compacted, pending };
    this.store.recordMaintenance(result, timestamp);
    this.nextRunAt = timestamp + (pending ? 60000 : 3600000);
    if (archived || filesRemoved || compacted) console.log(JSON.stringify({ event: 'maintenance_completed', ...result }));
    return result;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active?.catch(() => {});
    await this.closeDirectory();
  }
}

module.exports = { MaintenanceService };
