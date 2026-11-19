'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { publicHttpsUrl, modelScheduleSchema, defaultSchedule } = require('./model-config');

const channels = ['candy', 'pelican', 'testllm'];
const names = { candy: '糖果检测', pelican: '鹈鹕检测', testllm: 'TestLLM 推理检测' };
const providerFor = channel => channel === 'testllm' ? 'testllm' : 'manxue';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyContext = (channel, id) => `degradation:${channel}:${digest(String(id))}`;
const url = z.string().trim().max(2048).refine(value => !value || publicHttpsUrl(value), '必须填写无凭据、查询参数的公网 HTTPS 地址');
const model = z.string().trim().max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), '模型名称无效');
const paramsSchema = z.object({
  target_url: url, model, model_source: z.enum(['default', 'group']),
  protocol: z.enum(['auto', 'gpt', 'claude']),
  reasoning_effort: z.string().trim().min(1, '请填写推理程度').max(64, '推理程度最多 64 个字符')
    .refine(value => !/[\x00-\x1f\x7f]/.test(value), '推理程度不能包含控制字符'),
  service_tier: z.enum(['', 'priority', 'ultrafast']),
  cache_test: z.boolean(), thinking_test: z.boolean()
}).strict();
const channelSchema = z.object({
  enabled: z.boolean(), defaults: paramsSchema, schedule: modelScheduleSchema,
  timeout_seconds: z.number().int().min(30).max(1800),
  concurrency: z.number().int().min(1).max(4)
}).strict();
const groupSchema = z.object({
  id: z.string().min(1).max(100), channel: z.enum(channels), enabled: z.boolean(),
  override: paramsSchema.nullable(), key: z.string().max(8192).optional(), clear_key: z.boolean().optional()
}).strict();
const platformParamsSchema = paramsSchema.extend({ model_source: z.literal('default') });
const platformSchema = z.object({
  id: z.string().min(1).max(100),
  params: platformParamsSchema
}).strict();
const configurationSchema = z.object({
  revision: z.number().int().nonnegative(),
  providers: z.object({
    manxue: z.object({ enabled: z.boolean(), api_url: url }).strict(),
    testllm: z.object({ enabled: z.boolean(), api_url: url }).strict()
  }).strict(),
  channels: z.object({ candy: channelSchema, pelican: channelSchema, testllm: channelSchema }).strict(),
  platforms: z.array(platformSchema).max(100).optional(),
  groups: z.array(groupSchema).max(6000)
}).strict();

function defaultConfiguration() {
  return {
    providers: {
      manxue: { enabled: false, api_url: 'https://manxue.ai/api/v1/tests' },
      testllm: { enabled: false, api_url: 'https://testllm.ai' }
    },
    platforms: [],
    channels: Object.fromEntries(channels.map(channel => [channel, {
      enabled: false, timeout_seconds: 900, concurrency: 2,
      defaults: { target_url: '', model: 'gpt-6-astra', model_source: channel === 'testllm' ? 'group' : 'default', protocol: 'auto', reasoning_effort: 'low', service_tier: '', cache_test: true, thinking_test: true },
      schedule: structuredClone(defaultSchedule)
    }]))
  };
}

function validateEffective(channel, params) {
  if (!params.target_url || !params.model) return '启用的分组必须有上游地址和模型';
  if (channel === 'testllm' && !['gpt', 'claude'].includes(params.protocol)) return 'TestLLM 目前只支持 GPT / Claude 协议';
  return '';
}

module.exports = { channels, names, providerFor, digest, keyContext, configurationSchema, defaultConfiguration, validateEffective };
