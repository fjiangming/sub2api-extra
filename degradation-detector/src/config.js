'use strict';

const path = require('path');
const { z } = require('zod');

const apiTypes = [
  'responses',
  'chat_completions',
  'anthropic_messages',
  'gemini_generate_content',
  'images_generations'
];

const outputTypes = ['text', 'html', 'image', 'file'];
const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const dailyTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const validationSchema = z.object({
  min_bytes: z.coerce.number().int().min(0).max(20 * 1024 * 1024).default(1),
  required_patterns: z.array(z.string().min(1).max(1000)).max(50).default([]),
  forbidden_patterns: z.array(z.string().min(1).max(1000)).max(50).default([]),
  case_sensitive: z.boolean().default(false),
  min_width: z.coerce.number().int().min(1).max(16384).optional(),
  min_height: z.coerce.number().int().min(1).max(16384).optional()
}).strict().default({});

const testSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(200),
  api: z.enum(apiTypes).default('responses'),
  prompt: z.string().trim().min(1).max(100000),
  output_type: z.enum(outputTypes).default('text'),
  reasoning_effort: z.enum(reasoningEfforts).optional(),
  max_output_tokens: z.coerce.number().int().min(64).max(131072).default(16384),
  mime_type: z.string().trim().min(1).max(200).optional(),
  validation: validationSchema
}).strict().superRefine((value, context) => {
  if (value.api === 'images_generations' && value.output_type !== 'image') {
    context.addIssue({
      code: 'custom',
      path: ['output_type'],
      message: 'images_generations 只支持 image 输出'
    });
  }
  if (value.output_type === 'image' && ![
    'images_generations',
    'responses',
    'gemini_generate_content'
  ].includes(value.api)) {
    context.addIssue({
      code: 'custom',
      path: ['api'],
      message: 'image 输出只支持 images_generations、responses 或 gemini_generate_content'
    });
  }
});

const groupSelectionSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),
  enabled: z.boolean(),
  key: z.string().max(8192).optional()
}).strict();

const platformSelectionSchema = z.object({
  id: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  enabled: z.boolean(),
  test: testSchema,
  groups: z.array(groupSelectionSchema).max(2000)
}).strict();

const adminConfigurationSchema = z.object({
  schedule_mode: z.enum(['daily', 'interval']),
  schedule_times: z.array(dailyTimeSchema).min(1).max(24),
  schedule_interval_minutes: z.coerce.number().int().min(1).max(43200),
  platforms: z.array(platformSelectionSchema).max(64)
}).strict().superRefine((value, context) => {
  const platforms = new Set();
  const groups = new Set();
  const times = new Set();
  value.schedule_times.forEach((time, timeIndex) => {
    if (times.has(time)) {
      context.addIssue({
        code: 'custom',
        path: ['schedule_times', timeIndex],
        message: '每日检测时间不能重复'
      });
    }
    times.add(time);
  });
  value.platforms.forEach((platform, platformIndex) => {
    if (platforms.has(platform.id)) {
      context.addIssue({
        code: 'custom',
        path: ['platforms', platformIndex, 'id'],
        message: '平台配置不能重复'
      });
    }
    platforms.add(platform.id);
    platform.groups.forEach((group, groupIndex) => {
      if (groups.has(group.id)) {
        context.addIssue({
          code: 'custom',
          path: ['platforms', platformIndex, 'groups', groupIndex, 'id'],
          message: '分组配置不能重复'
        });
      }
      groups.add(group.id);
      if (!platform.enabled && group.enabled) {
        context.addIssue({
          code: 'custom',
          path: ['platforms', platformIndex, 'groups', groupIndex, 'enabled'],
          message: '平台未启用时不能启用分组'
        });
      }
    });
  });
});

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeUrl(value, fallback = '') {
  const raw = String(value || fallback).trim();
  if (!raw) return '';
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`不支持的 URL 协议: ${parsed.protocol}`);
  }
  return parsed.href.replace(/\/$/, '');
}

function validateTestConfig(platform, value) {
  const result = testSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`平台 ${platform} 的检测配置无效: ${detail}`);
  }
  for (const pattern of [
    ...result.data.validation.required_patterns,
    ...result.data.validation.forbidden_patterns
  ]) {
    try {
      new RegExp(pattern, result.data.validation.case_sensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`平台 ${platform} 包含无效检测正则: ${error.message}`);
    }
  }
  return { ...result.data, platform };
}

function validateAdminConfiguration(value) {
  let candidate = value;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && value.schedule_mode == null && value.schedule_time != null) {
    const { schedule_time: legacyTime, ...rest } = value;
    candidate = {
      ...rest,
      schedule_mode: 'daily',
      schedule_times: [legacyTime],
      schedule_interval_minutes: 60
    };
  }
  const result = adminConfigurationSchema.safeParse(candidate);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(detail);
  }
  return {
    ...result.data,
    schedule_times: [...result.data.schedule_times].sort(),
    platforms: result.data.platforms.map((platform) => ({
      ...platform,
      test: validateTestConfig(platform.id, platform.test)
    }))
  };
}

function defaultPlatformTest(platformName) {
  const platform = String(platformName || '').trim().toLowerCase();
  const defaults = {
    openai: {
      label: 'OpenAI',
      model: 'gpt-6-astra',
      api: 'responses',
      prompt: '请只输出一个完整 HTML 文件，制作一只鹈鹕骑自行车的二维循环动画。不要使用外部资源。',
      output_type: 'html',
      reasoning_effort: 'medium',
      max_output_tokens: 16384,
      validation: {
        min_bytes: 4000,
        required_patterns: ['<!doctype html', '<style', '<svg|<canvas|<script'],
        forbidden_patterns: ['```'],
        case_sensitive: false
      }
    },
    anthropic: {
      label: 'Anthropic',
      model: 'claude-sonnet-4-5',
      api: 'anthropic_messages',
      prompt: '直接回答：27 * 43 等于多少？只输出数字。',
      output_type: 'text',
      max_output_tokens: 256,
      validation: {
        min_bytes: 4,
        required_patterns: ['^1161$'],
        forbidden_patterns: [],
        case_sensitive: false
      }
    },
    gemini: {
      label: 'Gemini',
      model: 'gemini-2.5-pro',
      api: 'gemini_generate_content',
      prompt: '直接回答：27 * 43 等于多少？只输出数字。',
      output_type: 'text',
      max_output_tokens: 256,
      validation: {
        min_bytes: 4,
        required_patterns: ['^1161$'],
        forbidden_patterns: [],
        case_sensitive: false
      }
    }
  };
  return structuredClone(defaults[platform] || {
    label: platform || '未命名平台',
    model: 'default',
    api: 'chat_completions',
    prompt: '直接回答：27 * 43 等于多少？只输出数字。',
    output_type: 'text',
    max_output_tokens: 256,
    validation: {
      min_bytes: 4,
      required_patterns: ['^1161$'],
      forbidden_patterns: [],
      case_sensitive: false
    }
  });
}

function loadConfig(env = process.env) {
  const projectRoot = path.resolve(__dirname, '..');
  const environment = String(env.NODE_ENV || 'development');
  const demoMode = parseBoolean(env.DEGRADATION_DETECTOR_DEMO_MODE, false);
  if (demoMode && environment === 'production') {
    throw new Error('生产环境禁止启用 DEGRADATION_DETECTOR_DEMO_MODE');
  }
  const dataDirRaw = String(env.DEGRADATION_DETECTOR_DATA_DIR || './data');
  const dataDir = path.isAbsolute(dataDirRaw)
    ? path.normalize(dataDirRaw)
    : path.resolve(projectRoot, dataDirRaw);
  const databaseRaw = String(env.DEGRADATION_DETECTOR_DATABASE || '').trim();
  const databasePath = databaseRaw
    ? (path.isAbsolute(databaseRaw) ? path.normalize(databaseRaw) : path.resolve(projectRoot, databaseRaw))
    : path.join(dataDir, 'degradation-detector.db');
  const sub2apiBaseUrl = normalizeUrl(
    env.SUB2API_BASE_URL,
    demoMode || environment === 'test' ? 'http://127.0.0.1:8080' : ''
  );
  if (!sub2apiBaseUrl) throw new Error('必须配置 SUB2API_BASE_URL');

  return {
    env: environment,
    demoMode,
    projectRoot,
    dataDir,
    artifactDir: path.join(dataDir, 'artifacts'),
    databasePath,
    credentialKeyPath: path.join(dataDir, '.credential-key'),
    serviceOwnerId: '__degradation_detector_service__',
    bindHost: String(env.DEGRADATION_DETECTOR_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: parseInteger(env.PORT, 9873, 1, 65535),
    trustProxy: parseBoolean(env.DEGRADATION_DETECTOR_TRUST_PROXY, environment === 'production'),
    cookieSecure: parseBoolean(env.DEGRADATION_DETECTOR_COOKIE_SECURE, environment === 'production'),
    sessionTtlMinutes: 480,
    sub2apiBaseUrl,
    requestTimeoutMs: 600000,
    maxResponseBytes: 20 * 1024 * 1024,
    schedulerPollSeconds: parseInteger(env.DEGRADATION_DETECTOR_SCHEDULER_POLL_SECONDS, 15, 5, 300),
    concurrency: 2,
    historyLimit: 60,
    listHistoryLimit: 10,
    scheduleTimezone: 'Asia/Shanghai'
  };
}

module.exports = {
  adminConfigurationSchema,
  apiTypes,
  defaultPlatformTest,
  loadConfig,
  normalizeUrl,
  outputTypes,
  parseBoolean,
  parseInteger,
  reasoningEfforts,
  testSchema,
  validateAdminConfiguration,
  validateTestConfig,
  validationSchema
};
