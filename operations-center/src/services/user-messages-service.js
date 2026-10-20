'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { unwrap } = require('../sub2api-client');

const positiveId = z.coerce.number().int().safe().positive();
const messageId = z.coerce.number().int().safe().negative();
const messageInputSchema = z.object({
  userId: z.number().int().safe().positive(),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(16000),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  notifyMode: z.enum(['silent', 'popup']).default('silent'),
  startsAt: z.string().datetime().nullable().default(null),
  endsAt: z.string().datetime().nullable().default(null)
}).strict().refine((value) => !value.startsAt || !value.endsAt || Date.parse(value.startsAt) < Date.parse(value.endsAt), {
  message: '结束时间必须晚于开始时间', path: ['endsAt']
});
const listSchema = z.object({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', 'draft', 'active', 'archived']).default('all'),
  userId: positiveId.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

function validated(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0].message, { status: 400 });
  return result.data;
}

function recipient(user) {
  const id = validated(positiveId, user?.id);
  return { id, email: String(user.email || ''), username: String(user.username || '') };
}

class UserMessagesService {
  constructor({ config, store, sub2api, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.store = store;
    this.sub2api = sub2api;
    this.fetch = fetchImpl;
  }

  status() {
    return { deliveryEnabled: Boolean(this.config.userMessagesEnabled), total: this.store.count() };
  }

  async adminRequest(path, accessToken) {
    return unwrap(await this.sub2api.raw(path, accessToken ? {
      headers: { authorization: `Bearer ${accessToken}` }
    } : {}, !accessToken));
  }

  async searchUsers(query = {}, accessToken) {
    const search = validated(z.string().trim().min(1).max(200), query.search);
    if (/^[1-9]\d*$/.test(search)) {
      const id = validated(positiveId, search);
      try {
        const user = await this.adminRequest(`/api/v1/admin/users/${id}`, accessToken);
        return { items: [recipient(user)] };
      } catch (error) {
        if (error.details?.upstreamStatus === 404) return { items: [] };
        throw error;
      }
    }
    const data = await this.adminRequest(`/api/v1/admin/users?${new URLSearchParams({ search, page: '1', page_size: '20' })}`, accessToken);
    if (!Array.isArray(data?.items)) throw new AppError('SUB2API_INVALID_RESPONSE', '用户搜索响应无效', { status: 502 });
    return { items: data.items.map(recipient) };
  }

  list(query) {
    const filter = validated(listSchema, query);
    const search = filter.search.toLowerCase();
    const items = this.store.items().filter((item) =>
      (filter.status === 'all' || item.status === filter.status) &&
      (!filter.userId || item.userId === filter.userId) &&
      (!search || [item.title, item.recipient.email, item.recipient.username, String(item.userId)]
        .some((value) => value.toLowerCase().includes(search))));
    const start = (filter.page - 1) * filter.pageSize;
    return { items: items.slice(start, start + filter.pageSize), total: items.length, page: filter.page, pageSize: filter.pageSize };
  }

  ensureDelivery(input) {
    if (input.status === 'active' && !this.config.userMessagesEnabled) {
      throw new AppError('USER_MESSAGE_DELIVERY_DISABLED', '消息投递尚未启用，当前可以保存草稿', { status: 409 });
    }
    if (input.status === 'active' && input.endsAt && Date.parse(input.endsAt) <= Date.now()) {
      throw new AppError('USER_MESSAGE_EXPIRED', '发送消息的结束时间必须晚于当前时间', { status: 400 });
    }
  }

  async create(input, { actor, accessToken, requestKey }) {
    const value = validated(messageInputSchema, input);
    validated(z.string().uuid(), requestKey);
    this.ensureDelivery(value);
    const user = recipient(await this.adminRequest(`/api/v1/admin/users/${value.userId}`, accessToken));
    if (user.id !== value.userId) throw new AppError('RECIPIENT_MISMATCH', '收件人校验失败', { status: 502 });
    return this.store.create({ ...value, recipient: user, createdBy: actor, updatedBy: actor, requestKey });
  }

  async update(id, input, { actor, accessToken }) {
    id = validated(messageId, id);
    const value = validated(messageInputSchema, input);
    const existing = this.store.get(id);
    if (existing.userId !== value.userId) {
      throw new AppError('MESSAGE_RECIPIENT_LOCKED', '已有消息不能更换收件人，请新建消息', { status: 409 });
    }
    this.ensureDelivery(value);
    if (value.status === 'active') {
      const user = recipient(await this.adminRequest(`/api/v1/admin/users/${value.userId}`, accessToken));
      if (user.id !== value.userId) throw new AppError('RECIPIENT_MISMATCH', '收件人校验失败', { status: 502 });
    }
    return this.store.update(id, { ...value, updatedBy: actor });
  }

  async remove(id) {
    return this.store.remove(validated(messageId, id));
  }

  async archive(id, actor) {
    return this.store.update(validated(messageId, id), { status: 'archived', updatedBy: actor });
  }

  // Use a direct upstream only: the public announcement URL routes back to this gateway.
  async userRequest(path, token, method = 'GET') {
    const baseUrl = this.config.sub2apiAnnouncementsUpstreamUrl || this.config.sub2apiBaseUrl;
    if (!this.config.userMessagesEnabled || !baseUrl) {
      throw new AppError('USER_MESSAGE_DELIVERY_DISABLED', '消息投递尚未启用', { status: 503 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.sub2apiRequestTimeoutMs);
    try {
      const response = await this.fetch(`${baseUrl}${path}`, {
        method, headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-operations-announcements-hop': '1' },
        signal: controller.signal, redirect: 'error'
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new AppError('SUB2API_USER_REQUEST_FAILED', payload?.message || payload?.error?.message || 'Sub2API 请求失败', {
          status: response.status, details: { upstreamCode: payload?.code || null }
        });
      }
      return unwrap(payload);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SUB2API_USER_UNAVAILABLE', '暂时无法读取用户公告', { status: error.name === 'AbortError' ? 504 : 502 });
    } finally {
      clearTimeout(timeout);
    }
  }

  async authenticateUser(token) {
    if (!token || token.length > 16384) throw new AppError('AUTH_REQUIRED', '请先登录', { status: 401 });
    const user = await this.userRequest('/api/v1/auth/me', token);
    const parsed = positiveId.safeParse(user?.id);
    if (!parsed.success) throw new AppError('SUB2API_INVALID_USER', '用户认证响应无效', { status: 502 });
    return parsed.data;
  }

  async listForUser(token, unreadOnly) {
    const userId = await this.authenticateUser(token);
    const native = await this.userRequest(`/api/v1/announcements${unreadOnly ? '?unread_only=1' : ''}`, token);
    if (!Array.isArray(native) || native.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0)) {
      throw new AppError('SUB2API_INVALID_ANNOUNCEMENTS', '原生公告响应无效', { status: 502 });
    }
    const messages = this.store.forUser(userId, unreadOnly).map((item) => ({
      id: item.id, title: item.title, content: item.content, notify_mode: item.notifyMode,
      starts_at: item.startsAt, ends_at: item.endsAt, read_at: item.readAt,
      created_at: item.createdAt, updated_at: item.updatedAt
    }));
    return [...native, ...messages].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  }

  async markReadForUser(token, rawId) {
    const id = validated(z.coerce.number().int().safe().refine((value) => value !== 0), rawId);
    const userId = await this.authenticateUser(token);
    if (id > 0) return this.userRequest(`/api/v1/announcements/${id}/read`, token, 'POST');
    await this.store.markRead(id, userId);
    return { message: 'ok' };
  }
}

module.exports = { UserMessagesService };
