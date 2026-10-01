'use strict';

const path = require('path');
const Ajv = require('ajv');
const { load: loadHtml } = require('cheerio');
const safeRegex = require('safe-regex2');
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
const validationRuleTypes = [
  'min_bytes',
  'max_bytes',
  'exact_text',
  'contains',
  'regex',
  'not_regex',
  'html_selector',
  'svg_geometry',
  'json_schema',
  'mime_type',
  'image_dimensions'
];
const svgGeometryOperations = [
  'distance_lte',
  'above',
  'below',
  'left_of',
  'right_of',
  'aligned_x',
  'aligned_y',
  'inside_viewbox',
  'motion_gte',
  'rotation_gte',
  'loop_distance_lte'
];
const svgGeometryThresholdBases = ['absolute', 'viewbox_min', 'reference'];
const dailyTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const legacyValidationSchema = z.object({
  min_bytes: z.coerce.number().int().min(0).max(20 * 1024 * 1024).default(1),
  required_patterns: z.array(z.string().min(1).max(1000)).max(50).default([]),
  forbidden_patterns: z.array(z.string().min(1).max(1000)).max(50).default([]),
  case_sensitive: z.boolean().default(false),
  min_width: z.coerce.number().int().min(1).max(16384).optional(),
  min_height: z.coerce.number().int().min(1).max(16384).optional()
}).strict();

const validationRuleSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  type: z.enum(validationRuleTypes),
  severity: z.enum(['hard', 'soft']).default('hard'),
  weight: z.coerce.number().int().min(1).max(100).default(10),
  value: z.string().max(50000).optional(),
  threshold: z.coerce.number().int().min(0).max(20 * 1024 * 1024).optional(),
  case_sensitive: z.boolean().default(false),
  min_count: z.coerce.number().int().min(0).max(10000).optional(),
  max_count: z.coerce.number().int().min(0).max(10000).optional(),
  min_width: z.coerce.number().int().min(1).max(16384).optional(),
  min_height: z.coerce.number().int().min(1).max(16384).optional(),
  max_width: z.coerce.number().int().min(1).max(16384).optional(),
  max_height: z.coerce.number().int().min(1).max(16384).optional(),
  geometry_operation: z.enum(svgGeometryOperations).optional(),
  source_selector: z.string().trim().min(1).max(1000).optional(),
  target_selector: z.string().trim().min(1).max(1000).optional(),
  reference_selector: z.string().trim().min(1).max(1000).optional(),
  geometry_threshold_basis: z.enum(svgGeometryThresholdBases).optional(),
  geometry_threshold: z.coerce.number().min(0).max(1000000).optional()
}).strict().superRefine((rule, context) => {
  const requireValue = ['exact_text', 'contains', 'regex', 'not_regex', 'html_selector', 'json_schema', 'mime_type'];
  if (requireValue.includes(rule.type) && !String(rule.value || '').trim()) {
    context.addIssue({ code: 'custom', path: ['value'], message: '该规则必须填写匹配内容' });
  }
  if (['min_bytes', 'max_bytes'].includes(rule.type) && rule.threshold == null) {
    context.addIssue({ code: 'custom', path: ['threshold'], message: '该规则必须填写字节数' });
  }
  if (rule.type === 'html_selector') {
    try {
      loadHtml('<!doctype html><html><body></body></html>')(rule.value);
    } catch (error) {
      context.addIssue({ code: 'custom', path: ['value'], message: `CSS 选择器无效: ${error.message}` });
    }
    const minimum = rule.min_count ?? 1;
    if (rule.max_count != null && rule.max_count < minimum) {
      context.addIssue({ code: 'custom', path: ['max_count'], message: '最大数量不能小于最小数量' });
    }
  }
  if (rule.type === 'svg_geometry') {
    if (!rule.geometry_operation) {
      context.addIssue({ code: 'custom', path: ['geometry_operation'], message: '必须选择 SVG 数学关系' });
    }
    if (!rule.source_selector) {
      context.addIssue({ code: 'custom', path: ['source_selector'], message: '必须填写源元素选择器' });
    }
    const needsTarget = ['distance_lte', 'above', 'below', 'left_of', 'right_of', 'aligned_x', 'aligned_y']
      .includes(rule.geometry_operation);
    if (needsTarget && !rule.target_selector) {
      context.addIssue({ code: 'custom', path: ['target_selector'], message: '该数学关系必须填写目标元素选择器' });
    }
    if (rule.geometry_threshold == null) {
      context.addIssue({ code: 'custom', path: ['geometry_threshold'], message: '必须填写数学判定阈值' });
    }
    for (const field of ['source_selector', 'target_selector', 'reference_selector']) {
      if (!rule[field]) continue;
      try {
        loadHtml('<!doctype html><html><body><svg></svg></body></html>')(rule[field]);
      } catch (error) {
        context.addIssue({ code: 'custom', path: [field], message: `CSS 选择器无效: ${error.message}` });
      }
    }
    const thresholdBasis = rule.geometry_threshold_basis || (rule.reference_selector ? 'reference' : 'absolute');
    if (rule.geometry_operation === 'rotation_gte') {
      if (thresholdBasis !== 'absolute') {
        context.addIssue({ code: 'custom', path: ['geometry_threshold_basis'], message: '旋转角度规则只能使用绝对值阈值' });
      }
      if (rule.reference_selector) {
        context.addIssue({ code: 'custom', path: ['reference_selector'], message: '旋转角度规则不能使用尺寸参照元素' });
      }
    } else if (thresholdBasis === 'reference' && !rule.reference_selector) {
      context.addIssue({ code: 'custom', path: ['reference_selector'], message: '使用参照元素比例时必须填写尺寸参照选择器' });
    } else if (thresholdBasis !== 'reference' && rule.reference_selector) {
      context.addIssue({ code: 'custom', path: ['reference_selector'], message: '只有参照元素比例可以填写尺寸参照选择器' });
    }
  }
  if (['regex', 'not_regex'].includes(rule.type) && rule.value) {
    try {
      const expression = new RegExp(rule.value, rule.case_sensitive ? '' : 'i');
      if (!safeRegex(expression)) {
        context.addIssue({ code: 'custom', path: ['value'], message: '正则可能造成超长计算，请简化表达式' });
      }
    } catch (error) {
      context.addIssue({ code: 'custom', path: ['value'], message: `正则表达式无效: ${error.message}` });
    }
  }
  if (rule.type === 'json_schema' && rule.value) {
    try {
      const schema = JSON.parse(rule.value);
      new Ajv({ strict: false, allErrors: false, validateFormats: false }).compile(schema);
    } catch (error) {
      context.addIssue({ code: 'custom', path: ['value'], message: `JSON Schema 无效: ${error.message}` });
    }
  }
  if (rule.type === 'image_dimensions' && [
    rule.min_width, rule.min_height, rule.max_width, rule.max_height
  ].every((value) => value == null)) {
    context.addIssue({ code: 'custom', path: ['min_width'], message: '至少填写一个图片尺寸限制' });
  }
  if (rule.min_width != null && rule.max_width != null && rule.max_width < rule.min_width) {
    context.addIssue({ code: 'custom', path: ['max_width'], message: '最大宽度不能小于最小宽度' });
  }
  if (rule.min_height != null && rule.max_height != null && rule.max_height < rule.min_height) {
    context.addIssue({ code: 'custom', path: ['max_height'], message: '最大高度不能小于最小高度' });
  }
});

const confirmationSchema = z.object({
  window: z.coerce.number().int().min(1).max(10).default(3),
  required_failures: z.coerce.number().int().min(1).max(10).default(2),
  recovery_passes: z.coerce.number().int().min(1).max(10).default(2)
}).strict().superRefine((value, context) => {
  if (value.required_failures > value.window) {
    context.addIssue({ code: 'custom', path: ['required_failures'], message: '确认失败次数不能大于观察次数' });
  }
  if (value.recovery_passes > value.window) {
    context.addIssue({ code: 'custom', path: ['recovery_passes'], message: '恢复通过次数不能大于观察次数' });
  }
});

const svgMathSchema = z.object({
  enabled: z.boolean().default(false),
  samples: z.coerce.number().int().min(2).max(24).default(12),
  pass_ratio: z.coerce.number().min(0.5).max(1).default(0.9)
}).strict();

const validationPolicySchema = z.object({
  version: z.literal(2).default(2),
  normal_threshold: z.coerce.number().int().min(1).max(100).default(80),
  degraded_threshold: z.coerce.number().int().min(0).max(99).default(50),
  svg_math: svgMathSchema.optional(),
  rules: z.array(validationRuleSchema).max(50).default([]),
  confirmation: confirmationSchema.default({ window: 3, required_failures: 2, recovery_passes: 2 })
}).strict().superRefine((value, context) => {
  if (value.degraded_threshold >= value.normal_threshold) {
    context.addIssue({
      code: 'custom',
      path: ['degraded_threshold'],
      message: '降智阈值必须小于正常阈值'
    });
  }
  const ids = new Set();
  value.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) {
      context.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: '规则 ID 不能重复' });
    }
    ids.add(rule.id);
  });
});

function migrateLegacyValidation(value) {
  const legacy = legacyValidationSchema.parse(value || {});
  const rules = [];
  if (legacy.min_bytes > 0) {
    rules.push({
      id: 'legacy_min_bytes', label: `输出不少于 ${legacy.min_bytes} 字节`, type: 'min_bytes',
      severity: 'hard', weight: 10, threshold: legacy.min_bytes, case_sensitive: false
    });
  }
  legacy.required_patterns.forEach((pattern, index) => rules.push({
    id: `legacy_required_${index + 1}`, label: `必须匹配正则 ${index + 1}`, type: 'regex',
    severity: 'hard', weight: 10, value: pattern, case_sensitive: legacy.case_sensitive
  }));
  legacy.forbidden_patterns.forEach((pattern, index) => rules.push({
    id: `legacy_forbidden_${index + 1}`, label: `禁止匹配正则 ${index + 1}`, type: 'not_regex',
    severity: 'hard', weight: 10, value: pattern, case_sensitive: legacy.case_sensitive
  }));
  if (legacy.min_width != null || legacy.min_height != null) {
    rules.push({
      id: 'legacy_image_dimensions', label: '图片尺寸达到要求', type: 'image_dimensions',
      severity: 'hard', weight: 10, case_sensitive: false,
      ...(legacy.min_width == null ? {} : { min_width: legacy.min_width }),
      ...(legacy.min_height == null ? {} : { min_height: legacy.min_height })
    });
  }
  return {
    version: 2,
    normal_threshold: 80,
    degraded_threshold: 50,
    rules,
    confirmation: { window: 3, required_failures: 2, recovery_passes: 2 }
  };
}

const validationSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      ('version' in value || 'rules' in value)) {
    return value;
  }
  const legacy = legacyValidationSchema.safeParse(value || {});
  return legacy.success ? migrateLegacyValidation(legacy.data) : value;
}, validationPolicySchema);

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
  value.validation.rules.forEach((rule, index) => {
    if (['html_selector', 'svg_geometry'].includes(rule.type) && value.output_type !== 'html') {
      context.addIssue({
        code: 'custom',
        path: ['validation', 'rules', index, 'type'],
        message: `${rule.type === 'svg_geometry' ? 'SVG 数学关系' : 'HTML 选择器'}只能用于 HTML 输出`
      });
    }
    if (rule.type === 'image_dimensions' && value.output_type !== 'image') {
      context.addIssue({
        code: 'custom',
        path: ['validation', 'rules', index, 'type'],
        message: '图片尺寸只能用于图片输出'
      });
    }
  });
  if (value.validation.svg_math?.enabled && value.output_type !== 'html') {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'svg_math', 'enabled'],
      message: 'SVG 数学检测只能用于 HTML 输出'
    });
  }
});

const groupSelectionSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),
  enabled: z.boolean(),
  key: z.string().max(8192).optional(),
  test: testSchema.optional()
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
      test: validateTestConfig(platform.id, platform.test),
      groups: platform.groups.map((group) => ({
        ...group,
        ...(group.test ? { test: validateTestConfig(`${platform.id} / 分组 ${group.id}`, group.test) } : {})
      }))
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
      prompt: [
        '创建一个完整、可直接在浏览器打开的 HTML 文件，使用内联 SVG 绘制一只鹈鹕骑自行车的二维循环动画。',
        '只输出 HTML 源码，不要使用 Markdown 代码块，不要解释。',
        'SVG 必须设置 viewBox；鹈鹕主体使用 id="pelican"，自行车主体使用 id="bicycle"，两个车轮使用 class="wheel"。',
        '至少使用一组 CSS @keyframes，让鹈鹕、自行车或车轮产生持续循环动画。',
        '所有 HTML、CSS 和 SVG 必须内联，不得引用任何外部脚本、图片、字体或网络资源。'
      ].join('\n'),
      output_type: 'html',
      reasoning_effort: 'medium',
      max_output_tokens: 16384,
      validation: {
        version: 2,
        normal_threshold: 90,
        degraded_threshold: 60,
        confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
        rules: [
          { id: 'html_size', label: 'HTML 内容完整度', type: 'min_bytes', severity: 'soft', weight: 10, threshold: 4000, case_sensitive: false },
          { id: 'html_document', label: '完整 HTML 文档', type: 'html_selector', severity: 'hard', weight: 10, value: 'html', min_count: 1, case_sensitive: false },
          { id: 'svg_scene', label: '带 viewBox 的 SVG 场景', type: 'html_selector', severity: 'hard', weight: 15, value: 'svg[viewBox]', min_count: 1, case_sensitive: false },
          { id: 'pelican', label: '鹈鹕主体', type: 'html_selector', severity: 'hard', weight: 20, value: '#pelican', min_count: 1, case_sensitive: false },
          { id: 'bicycle', label: '自行车主体', type: 'html_selector', severity: 'hard', weight: 20, value: '#bicycle', min_count: 1, case_sensitive: false },
          { id: 'wheels', label: '两个自行车车轮', type: 'html_selector', severity: 'hard', weight: 10, value: '.wheel', min_count: 2, case_sensitive: false },
          { id: 'keyframes', label: '定义 CSS 关键帧', type: 'contains', severity: 'hard', weight: 7, value: '@keyframes', case_sensitive: false },
          { id: 'animation', label: '应用 CSS 动画', type: 'regex', severity: 'hard', weight: 8, value: 'animation(?:-name)?\\s*:', case_sensitive: false },
          { id: 'offline', label: '不引用外部资源', type: 'html_selector', severity: 'hard', weight: 10, value: '[src^="http"], [href^="http"], [src^="//"], [href^="//"]', min_count: 0, max_count: 0, case_sensitive: false }
        ]
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
        version: 2,
        normal_threshold: 90,
        degraded_threshold: 50,
        confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
        rules: [
          { id: 'exact_answer', label: '答案等于 1161', type: 'exact_text', severity: 'hard', weight: 100, value: '1161', case_sensitive: false }
        ]
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
        version: 2,
        normal_threshold: 90,
        degraded_threshold: 50,
        confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
        rules: [
          { id: 'exact_answer', label: '答案等于 1161', type: 'exact_text', severity: 'hard', weight: 100, value: '1161', case_sensitive: false }
        ]
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
      version: 2,
      normal_threshold: 90,
      degraded_threshold: 50,
      confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
      rules: [
        { id: 'exact_answer', label: '答案等于 1161', type: 'exact_text', severity: 'hard', weight: 100, value: '1161', case_sensitive: false }
      ]
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
    requestTimeoutMs: 30 * 60 * 1000,
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
  validationRuleSchema,
  validationRuleTypes,
  validateAdminConfiguration,
  validateTestConfig,
  validationSchema
};
