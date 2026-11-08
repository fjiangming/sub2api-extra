'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { z } = require('zod');
const { publicAddress } = require('./review-http');

const channels = ['bazaarlink', 'cctest', 'fingerpoint'];
const channelNames = { bazaarlink: 'Bazaarlink Probe', cctest: 'CCTest', fingerpoint: 'Fingerpoint' };
const defaultSchedule = { enabled: false, mode: 'daily', times: ['09:30', '21:30'], interval_minutes: 360 };
const defaultFingerpoint = (platform = 'openai', model = '') => ({ enabled: false, model, api: platform === 'anthropic' ? 'messages' : 'responses', effort: 'high', rounds: 3, count: 3, parallel: 1, strict: false });
const defaultFingerprintData = { automatic: true, interval_hours: 24, application: 'automatic', source: 'official' };

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
const fingerpointSchema = z.object({
  enabled: z.boolean(), model: modelSchema,
  api: z.enum(['responses', 'chat_completions', 'messages']),
  effort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  rounds: z.number().int().min(1).max(10), count: z.number().int().min(1).max(3),
  parallel: z.number().int().min(1).max(3), strict: z.boolean()
}).strict().refine(value => value.parallel <= value.count && (!value.strict || value.count === 3), '并发不能超过样本数，严格模式需要 3 个样本');
const fingerprintDataSchema = z.object({
  automatic: z.boolean(), interval_hours: z.number().int().min(1).max(168),
  application: z.enum(['automatic', 'manual']), source: z.enum(['official', 'mirror'])
}).strict();
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
  channels: z.object({ bazaarlink: channelSchema, cctest: channelSchema, fingerpoint: fingerpointSchema.optional() }).strict()
}).strict().superRefine((value, context) => {
  if (!value.enabled) return;
  if (!value.target_url) context.addIssue({ code: 'custom', path: ['target_url'], message: '启用模型检测必须配置目标 API 公网地址' });
  if (!channels.some(key => value.channels[key]?.enabled)) context.addIssue({ code: 'custom', path: ['channels'], message: '至少选择一个检测渠道' });
  for (const key of channels) {
    const channel = value.channels[key];
    if (channel?.enabled && (!channel.model || key !== 'fingerpoint' && !channel.api_url)) context.addIssue({ code: 'custom', path: ['channels', key], message: '已选渠道必须配置目标模型及所需 API 地址' });
  }
});

const modelGroupSchema = z.object({
  enabled: z.boolean(),
  key: secretSchema,
  models: z.object({ bazaarlink: modelSchema.optional(), cctest: modelSchema.optional(), fingerpoint: modelSchema.optional() }).strict().optional()
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
      cctest: { enabled: false, api_url: 'https://cctest.ai/api/v1/check', model, upstream_format: 'auto', provider: 'auto', attribution_only: false, check_token_usage: false },
      fingerpoint: defaultFingerpoint(platform, model)
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

module.exports = { channelNames, channels, defaultFingerpoint, defaultFingerprintData, fingerprintDataSchema, defaultModelPlatform, defaultSchedule, modelGroupContext, modelGroupSchema, modelPlatformSchema, modelScheduleSchema, publicHttpsUrl, publicModelPlatform };
