'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { AppError } = require('./errors');
const { DEFAULT_RULES, calendarDate, generateSimulation, validateCandidate } = require('./simulation');

const MAX_SETTINGS_BYTES = 64 * 1024;
const publicationSchema = z.object({ source: z.enum(['real', 'simulation']), candidate: z.unknown().nullable(),
  version: z.string().max(64), publishedAt: z.iso.datetime(), actor: z.string().max(280) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  draft: z.object({ source: z.enum(['real', 'simulation']), candidate: z.unknown().nullable() }).strict().nullable(),
  published: publicationSchema.nullable(), previous: publicationSchema.nullable() }).strict();
const initial = () => ({ schemaVersion: 1, revision: 0, draft: null, published: null, previous: null });

class SettingsStore {
  constructor(config, { now = () => new Date(), writeFile = fsp.writeFile } = {}) {
    this.config = config;
    this.now = now;
    this.writeFile = writeFile;
    this.filename = config.settingsDir ? path.join(config.settingsDir, 'leaderboard-settings.json') : null;
    this.state = initial();
    this.storageError = null;
    this.busy = false;
    this.onPublish = () => {};
    this.load();
  }

  load() {
    if (!this.filename) return;
    let descriptor;
    try {
      descriptor = fs.openSync(this.filename, 'r');
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count > MAX_SETTINGS_BYTES) throw new Error();
      const state = stateSchema.parse(JSON.parse(bytes.subarray(0, count).toString('utf8')));
      for (const item of [state.draft, state.published, state.previous]) {
        if (item?.candidate != null) item.candidate = validateCandidate(item.candidate, this.config.timezone);
        if (item?.source === 'simulation' && !item.candidate) throw new Error();
      }
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageError = '设置文件无法读取或校验失败，当前使用真实数据；重新生成并保存可恢复配置';
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  expired(candidate) { return !candidate || candidate.date !== calendarDate(this.now(), this.config.timezone); }
  active() { const published = this.state.published; return published?.source === 'simulation' && !this.expired(published.candidate) ? published : null; }
  draftCandidate() { return this.checkDraft(this.state); }
  snapshot() {
    const { revision, draft, published, previous } = this.state;
    return structuredClone({ revision, draft, published, previous: previous ? { source: previous.source, publishedAt: previous.publishedAt, version: previous.version, expired: previous.source === 'simulation' && this.expired(previous.candidate) } : null,
      expired: published?.source === 'simulation' && this.expired(published.candidate),
      draftExpired: Boolean(draft?.candidate && this.expired(draft.candidate)),
      persistence: Boolean(this.filename), storageError: this.storageError, timezone: this.config.timezone, defaults: DEFAULT_RULES });
  }

  async persist(state) {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) throw new AppError('SETTINGS_TOO_LARGE', '配置超过 64 KiB 上限，未保存', 400);
    if (!this.filename) return;
    const temporary = `${this.filename}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      await this.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporary, this.filename);
    } catch {
      throw new AppError('SETTINGS_WRITE_FAILED', '设置保存失败，请检查配置目录权限或磁盘空间；已发布版本未改变', 503);
    }
  }

  async change(revision, update, { persist = true, publish = false } = {}) {
    if (this.busy) throw new AppError('SETTINGS_BUSY', '其他设置正在保存，请稍后刷新', 409);
    if (revision !== this.state.revision) throw new AppError('SETTINGS_CONFLICT', '设置已被其他操作更新，请重新加载后再操作', 409);
    this.busy = true;
    try {
      const next = structuredClone(this.state);
      await update(next);
      next.revision++;
      if (persist) await this.persist(next);
      this.state = next;
      if (persist) this.storageError = null;
      if (publish) this.onPublish();
      return this.snapshot();
    } finally { this.busy = false; }
  }

  generate({ revision, rules, keepIdentities = true }) {
    return this.change(revision, (next) => {
      const current = next.draft?.candidate || next.published?.candidate;
      next.draft = { source: 'simulation', candidate: generateSimulation(rules, { now: this.now(), timezone: this.config.timezone,
        previous: keepIdentities ? current : undefined }) };
    }, { persist: false });
  }

  checkDraft(state) {
    const candidate = state.draft?.candidate;
    if (this.expired(candidate)) throw new AppError('SIMULATION_EXPIRED', '模拟候选已跨过统计日期，请重新生成后再发布', 400);
    return validateCandidate(candidate, this.config.timezone);
  }

  saveDraft({ revision, source }) {
    return this.change(revision, (next) => {
      if (source === 'simulation') this.checkDraft(next);
      next.draft = { source, candidate: next.draft?.candidate || null };
    });
  }

  publish({ revision, source }, actor) {
    return this.change(revision, (next) => {
      const candidate = source === 'simulation' ? this.checkDraft(next) : null;
      next.previous = next.published || { source: 'real', candidate: null, publishedAt: this.now().toISOString(), actor, version: 'default' };
      next.published = { source, candidate, publishedAt: this.now().toISOString(), actor, version: crypto.randomUUID() };
    }, { publish: true });
  }

  rollback({ revision }, actor) {
    return this.change(revision, (next) => {
      if (!next.previous) throw new AppError('NO_PREVIOUS_VERSION', '暂无上一发布版本', 400);
      if (next.previous.source === 'simulation' && this.expired(next.previous.candidate)) throw new AppError('SIMULATION_EXPIRED', '上一版本已经跨天，请生成新的模拟数据', 400);
      const previous = next.previous;
      next.previous = next.published;
      next.published = { ...previous, version: crypto.randomUUID(), publishedAt: this.now().toISOString(), actor };
    }, { publish: true });
  }
}

module.exports = { SettingsStore, MAX_SETTINGS_BYTES };
