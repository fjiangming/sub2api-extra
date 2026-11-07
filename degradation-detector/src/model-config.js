'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { z } = require('zod');
const { publicAddress } = require('./review-http');

const channels = ['bazaarlink', 'cctest'];
const channelNames = { bazaarlink: 'Bazaarlink Probe', cctest: 'CCTest' };
const defaultSchedule = { enabled: false, mode: 'daily', times: ['09:30', '21:30'], interval_minutes: 360 };

function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && (!url.port || url.port === '443') && host.includes('.')
      && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)
      && (!net.isIP(host) || publicAddress(host));
  } catch { return false; }
}

const urlSchema = z.string().trim().max(2048).refine(value => !value || publicHttpsUrl(value), '必须填写公网 HTTPS 地址，不支持内网、查询参数或非标准端口');
const modelSchema = z.string().trim().max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), '模型名称不能包含控制字符');
const secretSchema = z.string().max(8192).optional();
const channelSchema = z.object({
  enabled: z.boolean(),
  api_url: urlSchema,
  model: modelSchema,
  api_key: secretSchema,
  clear_api_key: z.boolean().optional(),
  upstream_format: z.enum(['auto', 'openai', 'openai-responses', 'anthropic']).default('auto'),
  provider: z.enum(['auto', 'codex', 'claude']).default('auto'),
  attribution_only: z.boolean().default(false),
  check_token_usage: z.boolean().default(false)
}).strict();

const modelPlatformSchema = z.object({
  enabled: z.boolean(),
  target_url: urlSchema,
  timeout_seconds: z.number().int().min(30).max(1800).default(1800),
  channels: z.object({ bazaarlink: channelSchema, cctest: channelSchema }).strict()
}).strict().superRefine((value, context) => {
  if (!value.enabled) return;
  if (!value.target_url) context.addIssue({ code: 'custom', path: ['target_url'], message: '启用模型检测必须配置目标 API 公网地址' });
  if (!channels.some(key => value.channels[key].enabled)) context.addIssue({ code: 'custom', path: ['channels'], message: '至少选择一个检测渠道' });
  for (const key of channels) {
    const channel = value.channels[key];
    if (channel.enabled && (!channel.api_url || !channel.model)) context.addIssue({ code: 'custom', path: ['channels', key], message: '已选渠道必须配置 API 地址和目标模型' });
  }
});

const modelGroupSchema = z.object({
  enabled: z.boolean(),
  key: secretSchema,
  models: z.object({ bazaarlink: modelSchema.optional(), cctest: modelSchema.optional() }).strict().optional()
}).strict();

const modelScheduleSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['daily', 'interval']),
  times: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24),
  interval_minutes: z.number().int().min(1).max(43200)
}).strict().refine(value => new Set(value.times).size === value.times.length, '模型检测每日时间不能重复');

function defaultModelPlatform(platform, model = '') {
  return {
    enabled: false,
    target_url: '',
    timeout_seconds: 1800,
    channels: {
      bazaarlink: { enabled: false, api_url: 'https://bazaarlink.ai/api/probe/run', model, upstream_format: 'auto', provider: 'auto', attribution_only: false, check_token_usage: false },
      cctest: { enabled: false, api_url: 'https://cctest.ai/api/v1/check', model, upstream_format: 'auto', provider: 'auto', attribution_only: false, check_token_usage: false }
    }
  };
}

function publicModelPlatform(config) {
  return {
    ...config,
    channels: Object.fromEntries(channels.map(key => {
      const { key_cipher, key_context, key_fingerprint, api_key, clear_api_key, ...channel } = config.channels[key];
      return [key, { ...channel, key_configured: Boolean(key_cipher) }];
    }))
  };
}

const modelGroupContext = id => `model-group:${crypto.createHash('sha256').update(String(id)).digest('hex')}`;

module.exports = { channelNames, channels, defaultModelPlatform, defaultSchedule, modelGroupContext, modelGroupSchema, modelPlatformSchema, modelScheduleSchema, publicHttpsUrl, publicModelPlatform };
