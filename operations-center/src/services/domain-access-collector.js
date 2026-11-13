'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DateTime } = require('luxon');
const { parseLine } = require('./domain-access-format');

const READ_BUDGET = 4 * 1024 * 1024;
const GZIP_LIMIT = 128 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

class DomainAccessCollector {
  constructor({ directory, store, settings, timezone = 'Asia/Shanghai', now = () => Date.now() }) {
    this.directory = directory; this.store = store; this.settings = settings; this.timezone = timezone; this.now = now;
    this.running = null;
  }

  status() {
    const value = this.store.meta('collector') || {};
    const latest = this.store.db.prepare('SELECT MAX(at) AS at FROM da_requests').get().at;
    return { ...value, configured: Boolean(this.directory), running: Boolean(this.running), latestRequestAt: latest,
      files: this.store.files(), collisionAt: this.store.meta('collisionAt'), startedAt: this.store.meta('startedAt') };
  }

  run() {
    if (!this.running) this.running = this.collect().finally(() => { this.running = null; });
    return this.running;
  }

  async collect() {
    if (!this.directory) return;
    const state = this.store.meta('collector') || { invalid: 0, ignored: 0, rotations: 0, gaps: [] };
    state.lastAttemptAt = this.now(); state.error = null; state.backlog = false;
    try {
      const root = await fsp.lstat(this.directory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw Object.assign(new Error(), { code: 'UNSAFE_LOG_DIRECTORY' });
      const entries = await fsp.readdir(this.directory, { withFileTypes: true });
      const live = entries.filter(entry => entry.isFile() && /^domain-access\.jsonl(?:\.[0-9-]+)?(?:\.gz)?$/.test(entry.name));
      const historyDir = path.join(this.directory, 'history');
      let historical = [];
      try {
        const stat = await fsp.lstat(historyDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error(), { code: 'UNSAFE_HISTORY_DIRECTORY' });
        historical = (await fsp.readdir(historyDir, { withFileTypes: true }))
          .filter(entry => entry.isFile() && /^[a-zA-Z0-9_.-]+\.log(?:\.\d+)?(?:\.gz)?$/.test(entry.name))
          .map(entry => ({ name: `history/${entry.name}`, history: true }));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const files = [...live.map(entry => ({ name: entry.name, history: false })), ...historical];
      if (files.length > 64) { state.backlog = true; state.error = 'FILE_COUNT_LIMIT'; }
      // Least recently processed files go first so an active file cannot starve rotations.
      const seen = new Map(this.store.files().map(file => [file.name, file.checkedAt]));
      files.sort((a, b) => (seen.get(a.name) || 0) - (seen.get(b.name) || 0) || a.name.localeCompare(b.name));
      let budget = READ_BUDGET;
      for (const file of files.slice(0, 64)) {
        if (budget <= 0) { state.backlog = true; break; }
        try { budget -= await this.readFile(file, budget, state); }
        catch (error) {
          state.error = ['EACCES', 'EPERM', 'ELOOP', 'UNSAFE_LOG_FILE', 'GZIP_SIZE_LIMIT', 'Z_DATA_ERROR'].includes(error.code)
            ? error.code : 'LOG_READ_FAILED';
          this.gap(state, state.error, file.name);
        }
      }
      if (!live.length) state.error ||= 'NO_GATEWAY_FILES';
      state.lastSuccessAt = this.now();
    } catch (error) {
      state.error = ['ENOENT', 'EACCES', 'EPERM', 'UNSAFE_LOG_DIRECTORY', 'UNSAFE_HISTORY_DIRECTORY'].includes(error.code)
        ? error.code : 'LOG_DIRECTORY_UNAVAILABLE';
      this.gap(state, state.error);
    }
    this.store.meta('collector', state);
  }

  gap(state, reason, name = '') {
    const last = state.gaps.at(-1);
    if (last?.reason === reason && last?.file === name) { last.lastAt = this.now(); return; }
    state.gaps.push({ reason, file: name, at: this.now(), lastAt: this.now() });
    state.gaps = state.gaps.slice(-100);
  }

  async readFile(file, budget, state) {
    const absolute = path.join(this.directory, file.name);
    const stat = await fsp.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error(), { code: 'UNSAFE_LOG_FILE' });
    const handle = await fsp.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let stream, input;
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw Object.assign(new Error(), { code: 'UNSAFE_LOG_FILE' });
      const gzip = file.name.endsWith('.gz');
      if (gzip && stat.size > 32 * 1024 * 1024) throw Object.assign(new Error(), { code: 'GZIP_SIZE_LIMIT' });
      const id = `${file.history ? 'h' : 'a'}:${stat.dev}:${stat.ino}${gzip ? `:${stat.size}:${stat.mtimeMs}` : ''}`;
      let checkpoint = this.store.file(id) || { id, offset: 0, generation: 0, discarded: false };
      const anchorSize = Math.min(64, checkpoint.offset);
      const anchor = Buffer.alloc(anchorSize);
      if (!gzip && anchorSize) await handle.read(anchor, 0, anchorSize, checkpoint.offset - anchorSize);
      const head = Buffer.alloc(checkpoint.headLength || 0);
      if (!gzip && head.length) await handle.read(head, 0, head.length, 0);
      if (!gzip && (stat.size < checkpoint.offset || checkpoint.anchor && checkpoint.anchor !== hash(anchor) ||
          checkpoint.headHash && checkpoint.headHash !== hash(head))) {
        checkpoint = { id, offset: 0, generation: checkpoint.generation + 1, discarded: false };
        state.rotations++; this.gap(state, 'copytruncate_or_rewrite', file.name);
      }
      if (gzip && checkpoint.done || !gzip && checkpoint.offset === stat.size) {
        this.store.ingest([], { ...checkpoint, name: file.name, checkedAt: this.now() }); return 0;
      }
      const oldOffset = checkpoint.offset;
      let offset = gzip ? 0 : oldOffset, lineStart = offset, pending = Buffer.alloc(0), consumed = 0, lines = [];
      let discarded = checkpoint.discarded, completed = true;
      const settings = this.settings(), allowed = new Set([...settings.domains, settings.target]);
      const today = DateTime.fromMillis(this.now(), { zone: this.timezone }).startOf('day');
      const rawSince = [today.minus({ days: settings.rawDays - 1 }).toISODate(), this.store.meta('rawFloor') || ''].sort().at(-1);
      const summarySince = today.minus({ days: settings.summaryDays - 1 }).toISODate();
      const flush = async () => {
        if (!gzip) {
          const bytes = Buffer.alloc(Math.min(64, checkpoint.offset));
          if (bytes.length) await handle.read(bytes, 0, bytes.length, checkpoint.offset - bytes.length);
          checkpoint.anchor = hash(bytes);
          const prefix = Buffer.alloc(Math.min(256, checkpoint.offset));
          if (prefix.length) await handle.read(prefix, 0, prefix.length, 0);
          checkpoint.headLength = prefix.length; checkpoint.headHash = hash(prefix);
        }
        this.store.ingest(lines, { ...checkpoint, name: file.name, checkedAt: this.now() }); lines = [];
      };
      input = handle.createReadStream({ start: gzip ? 0 : oldOffset, autoClose: false, highWaterMark: 64 * 1024 });
      if (gzip) {
        stream = zlib.createGunzip(); input.on('error', error => stream.destroy(error)); input.pipe(stream);
      } else stream = input;
      for await (const chunk of stream) {
        if (gzip && offset + chunk.length > GZIP_LIMIT) throw Object.assign(new Error(), { code: 'GZIP_SIZE_LIMIT' });
        let position = 0;
        while (position < chunk.length) {
          const newline = chunk.indexOf(10, position);
          const end = newline < 0 ? chunk.length : newline + 1;
          const part = chunk.subarray(position, end);
          offset += part.length; position = end;
          if (offset <= oldOffset) { lineStart = offset; continue; }
          consumed += part.length;
          if (!discarded && pending.length + part.length <= 16384) pending = Buffer.concat([pending, part]);
          else { discarded = true; pending = Buffer.alloc(0); }
          if (newline >= 0) {
            if (!discarded) {
              const row = parseLine(pending.toString('utf8').trimEnd(), { timezone: this.timezone, now: this.now(), history: file.history });
              if (!row) state.invalid++;
              else if (!allowed.has(row.domain) || row.day < (row.kind === 'history' ? summarySince : rawSince)) state.ignored++;
              else lines.push(row);
            } else state.invalid++;
            pending = Buffer.alloc(0); discarded = false; lineStart = offset;
            checkpoint.offset = offset; checkpoint.discarded = false;
          } else if (discarded) { checkpoint.offset = offset; checkpoint.discarded = true; }
          if (lines.length >= 500) await flush();
        }
        if (consumed >= budget) { completed = false; state.backlog = true; break; }
      }
      if (gzip && completed && pending.length && !discarded) {
        const row = parseLine(pending.toString('utf8').trimEnd(), { timezone: this.timezone, now: this.now(), history: file.history });
        if (!row) state.invalid++;
        else if (!allowed.has(row.domain) || row.day < (row.kind === 'history' ? summarySince : rawSince)) state.ignored++;
        else lines.push(row);
        pending = Buffer.alloc(0); lineStart = offset;
      }
      // Keep incomplete trailing lines on disk; resume from their first byte.
      checkpoint.offset = discarded ? offset : lineStart;
      checkpoint.discarded = discarded;
      checkpoint.done = gzip && completed && !pending.length;
      await flush();
      return Math.max(consumed, 0);
    } finally {
      stream?.destroy(); if (input !== stream) input?.destroy(); await handle.close();
    }
  }
}

module.exports = { DomainAccessCollector };
