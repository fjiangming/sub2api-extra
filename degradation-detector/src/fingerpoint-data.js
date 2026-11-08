'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { zstdDecompress } = require('node:zlib');
const { AppError } = require('./errors');
const { defaultFingerprintData, fingerprintDataSchema } = require('./model-config');
const { downloadReference } = require('./fingerpoint-http');

const sdkVersion = require('../package.json').dependencies['lmfpd-sdk'];
const sources = ['https://lm.ikale.io/data/', 'https://cdn.jsdmirror.com/npm/lmfpd-data@latest/'];
const hashPattern = /^[a-f0-9]{64}$/;
const metadata = value => value ? { built_at: value.built_at, hash: value.hash, models: value.models } : null;
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const failure = () => new AppError('FINGERPOINT_DATA_UNAVAILABLE', '参考数据下载或校验失败，已保留可用版本；请检查网络或切换数据来源', { status: 502 });

function validateBundle(bundle) {
  const file = bundle?.files?.['shared_detector.bin'];
  if (bundle?.schema !== 'lmfpd-data-v1' || bundle.detector_schema !== 'shared-detector-v2') throw new AppError('FINGERPOINT_SDK_UPGRADE_REQUIRED', '参考数据格式需要新版 SDK，请升级服务镜像；当前可用版本继续保留', { status: 409 });
  if (typeof bundle.built_at !== 'string' || !Number.isFinite(Date.parse(bundle.built_at)) || !Array.isArray(bundle.models) || !bundle.models.length || bundle.models.length > 2048
    || bundle.models.some(item => !item || typeof item.id !== 'string' || item.id.length > 200) || new Set(bundle.models.map(item => item.id)).size !== bundle.models.length
    || !file || !hashPattern.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 16 * 1024 * 1024
    || !Array.isArray(file.parts) || !file.parts.length || file.parts.length > 8 || file.parts.some(part => typeof part !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,179}\.zst$/.test(part))) throw failure();
  return file;
}

class FingerpointData {
  constructor({ config, store, modelStore, download = downloadReference, loadDetector, unpack = promisify(zstdDecompress) }) {
    Object.assign(this, { config, store, modelStore, download, unpack });
    this.loadDetector = loadDetector || (async directory => (await import('lmfpd-sdk')).loadDetector({ source: directory }));
    this.root = path.join(config.dataDir, 'fingerpoint');
    this.db = store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS fingerpoint_data (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, state_json TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO fingerpoint_data VALUES (1,?,?)').run(JSON.stringify(defaultFingerprintData), '{}');
    this.state = parse(this.db.prepare('SELECT state_json FROM fingerpoint_data WHERE id=1').get().state_json);
    this.leases = new Map(); this.pending = null; this.controller = null; this.timer = null; this.closed = false; this.phase = '';
  }
  settings() { return { ...defaultFingerprintData, ...parse(this.db.prepare('SELECT settings_json FROM fingerpoint_data WHERE id=1').get().settings_json) }; }
  saveSettings(input) { this.db.prepare('UPDATE fingerpoint_data SET settings_json=? WHERE id=1').run(JSON.stringify(fingerprintDataSchema.parse(input))); }
  persist() { this.db.prepare('UPDATE fingerpoint_data SET state_json=? WHERE id=1').run(JSON.stringify(this.state)); }
  directory(hash) { if (!hashPattern.test(hash)) throw failure(); return path.join(this.root, hash); }
  status() {
    const settings = this.settings();
    return { ...settings, sdk_version: sdkVersion, sdk_status: this.state.sdk_status || 'unchecked', sdk_available_version: this.state.sdk_available_version || null,
      active: metadata(this.state.active), available: metadata(this.state.available), can_rollback: Boolean(this.state.previous),
      last_checked: this.state.last_checked || null, next_check: settings.automatic && this.state.last_checked ? this.state.last_checked + settings.interval_hours * 3600000 : null,
      history: this.state.history || [], busy: Boolean(this.pending), phase: this.phase, last_error: this.state.last_error || '' };
  }
  remember(action, version, status = '已应用') {
    this.state.history = [{ action, at: Date.now(), version: version?.built_at?.slice(0, 10) || '', status }, ...(this.state.history || [])].slice(0, 30);
  }
  async task(phase, operation, signal) {
    if (this.closed) throw new AppError('FINGERPOINT_CLOSED', '参考数据服务正在关闭', { status: 503 });
    if (this.pending) throw new AppError('FINGERPOINT_UPDATE_BUSY', '已有参考数据操作正在执行，请稍后刷新', { status: 409 });
    this.controller = new AbortController(); this.phase = phase;
    const combined = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
    this.pending = Promise.resolve().then(() => operation(combined));
    try { await this.pending; this.state.last_error = ''; return this.status(); }
    catch (error) {
      this.state.last_error = error instanceof AppError ? error.message : failure().message;
      if (error.code === 'FINGERPOINT_SDK_UPGRADE_REQUIRED') this.state.sdk_status = 'upgrade_required';
      throw error instanceof AppError ? error : failure();
    } finally { this.pending = null; this.controller = null; this.phase = ''; this.persist(); }
  }
  async check(signal) {
    await this.task('check', async jobSignal => {
      this.state.last_checked = Date.now();
      let lastError;
      const choices = this.settings().source === 'mirror' ? [...sources].reverse() : sources;
      for (const source of choices) {
        try {
          const raw = await this.download(source + 'bundle.json', { signal: AbortSignal.any([jobSignal, AbortSignal.timeout(15000)]), maxBytes: 256 * 1024 });
          const bundle = JSON.parse(raw.toString('utf8')); const file = validateBundle(bundle);
          const newest = Math.max(Date.parse(this.state.active?.built_at) || 0, Date.parse(this.state.available?.built_at) || 0);
          if (Date.parse(bundle.built_at) < newest) throw new AppError('FINGERPOINT_REFERENCE_STALE', '数据源版本早于当前已知版本，已保留现有参考数据；请稍后检查', { status: 409 });
          this.state.available = file.sha256 === this.state.active?.hash ? null : { built_at: bundle.built_at, hash: file.sha256, models: bundle.models.length, source, bundle };
          lastError = null; break;
        } catch (error) { lastError = error; if (jobSignal.aborted) break; }
      }
      if (lastError) throw lastError;
      try {
        const raw = await this.download('https://registry.npmjs.org/lmfpd-sdk/latest', { signal: AbortSignal.any([jobSignal, AbortSignal.timeout(10000)]), maxBytes: 64 * 1024 });
        const version = JSON.parse(raw.toString('utf8')).version;
        if (/^\d+\.\d+\.\d+$/.test(version)) {
          this.state.sdk_available_version = version;
          const offered = version.split('.').map(Number); const installed = sdkVersion.split('.').map(Number);
          const difference = offered.map((value, index) => value - installed[index]).find(value => value !== 0) || 0;
          this.state.sdk_status = difference > 0 ? 'update_available' : 'current';
        }
      } catch { this.state.sdk_status = 'unchecked'; }
    }, signal);
    return this.status();
  }
  async validateDirectory(directory, candidate) {
    const info = await fs.stat(path.join(directory, 'shared_detector.bin'));
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw failure();
    const raw = await fs.readFile(path.join(directory, 'shared_detector.bin'));
    if (raw.length > 32 * 1024 * 1024 || crypto.createHash('sha256').update(raw).digest('hex') !== candidate.hash) throw failure();
    const detector = await this.loadDetector(directory);
    if (detector.builtAt !== candidate.built_at) throw failure();
  }
  async install(candidate, signal) {
    const target = this.directory(candidate.hash);
    try { await this.validateDirectory(target, candidate); return; } catch {}
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(this.root, '.staging-'));
    try {
      const file = validateBundle(candidate.bundle); const parts = []; let bytes = 0;
      const choices = sources.includes(candidate.source) ? [candidate.source, ...sources.filter(source => source !== candidate.source)] : sources;
      let detectorBytes;
      for (const source of choices) {
        try {
          parts.length = 0; bytes = 0;
          for (const part of file.parts) {
            const raw = await this.download(`${source}chunks/${part}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), maxBytes: file.bytes - bytes });
            bytes += raw.length;
            if (bytes > file.bytes) throw failure();
            parts.push(raw);
          }
          if (bytes !== file.bytes) throw failure();
          const unpacked = await this.unpack(Buffer.concat(parts, bytes), { maxOutputLength: 32 * 1024 * 1024 });
          if (unpacked.length > 32 * 1024 * 1024 || crypto.createHash('sha256').update(unpacked).digest('hex') !== candidate.hash) throw failure();
          detectorBytes = unpacked; break;
        } catch (error) { if (signal.aborted) throw error; }
      }
      if (!detectorBytes) throw failure();
      await fs.writeFile(path.join(staging, 'unified_bank.json'), JSON.stringify(candidate.bundle), { mode: 0o600 });
      await fs.writeFile(path.join(staging, 'shared_detector.bin'), detectorBytes, { mode: 0o600 });
      await this.validateDirectory(staging, candidate);
      signal.throwIfAborted();
      try { await fs.rename(staging, target); }
      catch (error) { await this.validateDirectory(target, candidate); }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  async apply(signal) {
    await this.task('apply', async jobSignal => {
      const candidate = this.state.available;
      if (!candidate) throw new AppError('FINGERPOINT_NO_UPDATE', '没有待应用的参考数据，请先检查更新', { status: 409 });
      await this.install(candidate, jobSignal);
      this.state.previous = this.state.active || null;
      this.state.active = metadata(candidate); this.state.available = null;
      this.remember('下载、校验并应用', candidate);
      this.persist(); await this.prune();
    }, signal);
    return this.status();
  }
  async rollback(signal) {
    await this.task('rollback', async jobSignal => {
      const previous = this.state.previous;
      if (!previous) throw new AppError('FINGERPOINT_NO_ROLLBACK', '没有可恢复的上一版参考数据', { status: 409 });
      await this.validateDirectory(this.directory(previous.hash), previous);
      jobSignal.throwIfAborted();
      const current = this.state.active;
      const bundle = JSON.parse(await fs.readFile(path.join(this.directory(current.hash), 'unified_bank.json'), 'utf8'));
      this.state.available = { ...metadata(current), bundle, source: sources[0] };
      this.state.active = previous; this.state.previous = null; this.state.last_checked = Date.now();
      this.remember('恢复上一版本', previous);
      this.persist(); await this.prune();
    }, signal);
    return this.status();
  }
  async acquire(signal) {
    signal.throwIfAborted();
    while (!this.state.active) {
      signal.throwIfAborted();
      if (this.pending) {
        let abort;
        try { await Promise.race([this.pending.catch(() => {}), new Promise((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
        finally { signal.removeEventListener('abort', abort); }
      } else if (this.state.available) await this.apply(signal);
      else await this.check(signal);
    }
    signal.throwIfAborted();
    const version = metadata(this.state.active);
    this.leases.set(version.hash, (this.leases.get(version.hash) || 0) + 1);
    let released = false;
    return { ...version, directory: this.directory(version.hash), sdk_version: sdkVersion, release: async () => {
      if (released) return; released = true;
      this.leases.set(version.hash, this.leases.get(version.hash) - 1);
      if (!this.leases.get(version.hash)) this.leases.delete(version.hash);
      await this.prune();
    } };
  }
  async prune() {
    const keep = new Set([this.state.active?.hash, this.state.previous?.hash, this.state.available?.hash, ...this.leases.keys()]);
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory() && hashPattern.test(entry.name) && !keep.has(entry.name)) await fs.rm(this.directory(entry.name), { recursive: true, force: true }).catch(() => {});
    for (const entry of entries) if (entry.isDirectory() && /^\.staging-[a-zA-Z0-9]{6}$/.test(entry.name)) {
      const directory = path.join(this.root, entry.name);
      const info = await fs.stat(directory).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 3600000) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  start() {
    if (this.timer || this.closed || this.config.demoMode) return;
    const tick = async () => {
      const settings = this.settings();
      if (!settings.automatic || this.pending || !this.state.active && !this.modelStore.enabledGroups().some(group => this.modelStore.effective(group, 'fingerpoint').enabled)) return;
      if (this.state.last_checked && Date.now() < this.state.last_checked + settings.interval_hours * 3600000) return;
      try { await this.check(); if (settings.application === 'automatic' && this.state.available) await this.apply(); } catch {}
    };
    this.timer = setInterval(() => tick(), 60000); this.timer.unref?.();
  }
  async close() { this.closed = true; clearInterval(this.timer); this.timer = null; this.controller?.abort(); await this.pending?.catch(() => {}); }
}

module.exports = { FingerpointData, sdkVersion, sources, validateBundle };
