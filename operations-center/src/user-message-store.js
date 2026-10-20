'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { z } = require('zod');
const { AppError } = require('./errors');

const MAX_MESSAGES = 10000;
const timestamp = z.string().datetime();
const itemSchema = z.object({
  id: z.number().int().safe().negative(),
  userId: z.number().int().safe().positive(),
  recipient: z.object({ id: z.number().int().safe().positive(), email: z.string(), username: z.string() }),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(16000),
  status: z.enum(['draft', 'active', 'archived']),
  notifyMode: z.enum(['silent', 'popup']),
  startsAt: timestamp.nullable(),
  endsAt: timestamp.nullable(),
  readAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: z.string(),
  updatedBy: z.string(),
  requestKey: z.string().uuid()
}).refine((item) => item.recipient.id === item.userId &&
  (!item.startsAt || !item.endsAt || Date.parse(item.startsAt) < Date.parse(item.endsAt)));
const stateSchema = z.object({
  version: z.literal(1),
  nextId: z.number().int().safe().negative(),
  items: z.array(itemSchema).max(MAX_MESSAGES)
}).refine((state) => new Set(state.items.map((item) => item.id)).size === state.items.length &&
  new Set(state.items.map((item) => item.requestKey)).size === state.items.length &&
  state.items.every((item) => item.id > state.nextId));

function messageNotFound() {
  return new AppError('USER_MESSAGE_NOT_FOUND', '消息不存在', { status: 404 });
}

function visibleTo(item, userId, now = Date.now()) {
  return item.userId === userId && item.status === 'active' &&
    (!item.startsAt || Date.parse(item.startsAt) <= now) &&
    (!item.endsAt || Date.parse(item.endsAt) > now);
}

class UserMessageStore {
  constructor(dataDir) {
    this.filePath = path.join(path.resolve(dataDir), 'user-messages.json');
    this.state = { version: 1, nextId: -1, items: [] };
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      this.state = stateSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new AppError('USER_MESSAGES_INVALID', '用户消息文件损坏或版本不受支持', { expose: false });
      }
      await this.#write(this.state);
    }
  }

  items() {
    return structuredClone(this.state.items);
  }

  count() {
    return this.state.items.length;
  }

  get(id) {
    const item = this.state.items.find((item) => item.id === id);
    if (!item) throw messageNotFound();
    return structuredClone(item);
  }

  async create(input) {
    return this.#update((state) => {
      const existing = state.items.find((item) => item.requestKey === input.requestKey);
      if (existing) {
        const same = ['userId', 'title', 'content', 'status', 'notifyMode', 'startsAt', 'endsAt', 'createdBy']
          .every((key) => existing[key] === input[key]);
        if (!same) throw new AppError('MESSAGE_REQUEST_CONFLICT', '该发送请求已保存，请刷新后检查消息记录', { status: 409 });
        return existing;
      }
      if (state.items.length >= MAX_MESSAGES || state.nextId <= Number.MIN_SAFE_INTEGER) {
        throw new AppError('USER_MESSAGES_FULL', '用户消息数量已达到上限，请先删除旧记录', { status: 409 });
      }
      const now = new Date().toISOString();
      const item = { ...input, id: state.nextId--, readAt: null, createdAt: now, updatedAt: now };
      state.items.unshift(item);
      return item;
    });
  }

  async update(id, input) {
    return this.#update((state) => {
      const item = state.items.find((item) => item.id === id);
      if (!item) throw messageNotFound();
      Object.assign(item, input, { updatedAt: new Date().toISOString() });
      return item;
    });
  }

  async remove(id) {
    return this.#update((state) => {
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) throw messageNotFound();
      state.items.splice(index, 1);
    });
  }

  forUser(userId, unreadOnly = false) {
    const now = Date.now();
    return structuredClone(this.state.items.filter((item) => visibleTo(item, userId, now) && (!unreadOnly || !item.readAt)));
  }

  async markRead(id, userId) {
    return this.#update((state) => {
      const item = state.items.find((item) => item.id === id && visibleTo(item, userId));
      if (!item) throw messageNotFound();
      item.readAt ||= new Date().toISOString();
      return item;
    });
  }

  async #update(mutator) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = mutator(next);
      stateSchema.parse(next);
      await this.#write(next);
      this.state = next;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #write(state) {
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

module.exports = { UserMessageStore, visibleTo };
