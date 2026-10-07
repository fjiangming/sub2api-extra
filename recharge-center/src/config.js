'use strict';

const path = require('path');
const { z } = require('zod');

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}, z.boolean());

const optionalString = z.preprocess(
  (value) => value == null || String(value).trim() === '' ? undefined : String(value).trim(),
  z.string().optional()
);

const optionalUrl = z.preprocess(
  (value) => value == null || String(value).trim() === '' ? undefined : String(value).trim(),
  z.string().url().optional()
);

const AUTO_PAYMENT_MODE = 'personal_transfer_auto';
const AUTO_ORDER_TTL_MINUTES = 3;
const QR_SOURCE_TEMPLATE = 'template';
const QR_SOURCE_COLLECTOR = 'collector';
const ALERT_CHANNEL_NAMES = new Set(['email', 'webhook']);

function parseList(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function isEmailAddress(value) {
  return /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(String(value || ''));
}

function isObviousPlaceholder(value) {
  const normalized = String(value || '').trim();
  return !normalized || /^(?:replace[-_]|change[-_]|your[-_]|example[-_]|<|替换)/i.test(normalized) ||
    normalized.includes('REPLACE_FROM_OWN_LINK');
}

function isAlipayHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'alipay.com' || normalized.endsWith('.alipay.com');
}

function hasUnsafeNestedTarget(url) {
  for (const rawValue of url.searchParams.values()) {
    let value = rawValue;
    for (let depth = 0; depth < 3; depth += 1) {
      if (/^https?:\/\//i.test(value)) {
        try {
          const nested = new URL(value);
          if (nested.protocol !== 'https:' || nested.username || nested.password || !isAlipayHostname(nested.hostname)) {
            return true;
          }
        } catch {
          return true;
        }
        break;
      }
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        break;
      }
    }
  }
  return false;
}

function validateTransferTemplate(value) {
  const template = String(value || '');
  if ((template.match(/\{amount\}/g) || []).length !== 1 || (template.match(/\{memo\}/g) || []).length !== 1) {
    return false;
  }
  if (template.length > 4096 || /[\r\n\0]/.test(template) || template.includes('...') ||
      isObviousPlaceholder(template)) return false;
  try {
    const rendered = template
      .replace('{amount}', '12.34')
      .replace('{memo}', 'S2-0123456789abcdef');
    const url = new URL(rendered);
    if (url.username || url.password || url.hash || hasUnsafeNestedTarget(url)) return false;
    if (url.protocol === 'alipays:') {
      return url.hostname === 'platformapi' && url.pathname === '/startapp';
    }
    return url.protocol === 'https:' && isAlipayHostname(url.hostname);
  } catch {
    return false;
  }
}

function parseConfiguredMoney(value) {
  const raw = String(value ?? '').trim();
  const match = /^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(9874),
  RECHARGE_CENTER_BIND_HOST: z.string().default('127.0.0.1'),
  RECHARGE_CENTER_DATA_DIR: z.string().trim().min(1).default('./data'),
  RECHARGE_CENTER_DATABASE: optionalString,
  RECHARGE_CENTER_SECRET: z.string().min(32).max(1024),
  RECHARGE_CENTER_PUBLIC_URL: optionalUrl,
  RECHARGE_CENTER_TRUST_PROXY: boolFromEnv.default(false),
  RECHARGE_CENTER_COOKIE_SECURE: boolFromEnv.optional(),
  RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED: boolFromEnv.optional(),
  RECHARGE_CENTER_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(60),
  RECHARGE_CENTER_ORDER_TTL_MINUTES: z.coerce.number().int().min(3).max(60).default(20),
  RECHARGE_CENTER_REVIEW_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  RECHARGE_CENTER_FULFILLMENT_LEASE_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  RECHARGE_CENTER_PAYMENT_MODE: z.enum(['personal_manual', AUTO_PAYMENT_MODE, 'sub2api_official']),
  RECHARGE_CENTER_QUICK_AMOUNTS: optionalString,
  RECHARGE_CENTER_ALLOWED_AMOUNTS: z.string().default('10,20,50,100,200,500,1000,2000,5000'),
  RECHARGE_CENTER_MIN_AMOUNT: z.union([z.string(), z.number()]).default('1'),
  RECHARGE_CENTER_MAX_AMOUNT: z.union([z.string(), z.number()]).default('1000000'),
  RECHARGE_CENTER_OFFICIAL_POLL_SECONDS: z.coerce.number().int().min(3).max(60).default(5),
  RECHARGE_CENTER_OFFICIAL_POLL_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS: optionalString,
  RECHARGE_CENTER_CREDIT_MULTIPLIER: z.coerce.number().finite().refine(
    (value) => value === 1,
    '为保证运营收入与支付宝实收一致，只允许设置为 1'
  ).optional(),
  RECHARGE_CENTER_MAX_ACTIVE_ORDERS: z.coerce.number().int().min(1).max(5).default(1),
  ALIPAY_QR_IMAGE_PATH: optionalString,
  ALIPAY_QR_MAX_BYTES: z.coerce.number().int().min(1024).max(5 * 1024 * 1024).default(2 * 1024 * 1024),
  RECHARGE_CENTER_TRANSFER_QR_SOURCE: z.enum([QR_SOURCE_TEMPLATE, QR_SOURCE_COLLECTOR]).default(QR_SOURCE_TEMPLATE),
  RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: optionalString,
  RECHARGE_CENTER_QR_JOB_LEASE_SECONDS: z.coerce.number().int().min(15).max(120).default(45),
  RECHARGE_CENTER_QR_PROVISIONER_SECRET: optionalString,
  RECHARGE_CENTER_LISTENER_SECRET: optionalString,
  RECHARGE_CENTER_LISTENER_COLLECTOR_ID: optionalString,
  RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  RECHARGE_CENTER_LISTENER_SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS: z.coerce.number().int().min(180).max(3600).default(600),
  RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: optionalString,
  RECHARGE_CENTER_AUTO_MODE_VERIFIED: boolFromEnv.default(false),
  SUB2API_BASE_URL: z.string().url(),
  SUB2API_PUBLIC_URL: optionalUrl,
  SUB2API_ADMIN_API_KEY: optionalString,
  SUB2API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  SUB2API_FORWARD_CLIENT_FINGERPRINT: boolFromEnv.default(true),
  RECHARGE_CENTER_ALERT_CHANNELS: optionalString,
  RECHARGE_CENTER_ALERT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),
  RECHARGE_CENTER_SMTP_HOST: optionalString,
  RECHARGE_CENTER_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  RECHARGE_CENTER_SMTP_SECURE: boolFromEnv.default(false),
  RECHARGE_CENTER_SMTP_REQUIRE_TLS: boolFromEnv.default(true),
  RECHARGE_CENTER_SMTP_USER: optionalString,
  RECHARGE_CENTER_SMTP_PASSWORD: optionalString,
  RECHARGE_CENTER_SMTP_FROM: optionalString,
  RECHARGE_CENTER_ALERT_EMAIL_TO: optionalString,
  RECHARGE_CENTER_ALERT_WEBHOOK_URL: optionalUrl,
  RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN: optionalString
}).superRefine((value, context) => {
  const minMinor = parseConfiguredMoney(value.RECHARGE_CENTER_MIN_AMOUNT);
  const maxMinor = parseConfiguredMoney(value.RECHARGE_CENTER_MAX_AMOUNT);
  if (minMinor == null || minMinor < 1) {
    context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_MIN_AMOUNT'], message: '必须是大于 0 且最多两位小数的金额' });
  }
  if (maxMinor == null || (minMinor != null && maxMinor < minMinor)) {
    context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_MAX_AMOUNT'], message: '必须是大于等于最低金额且最多两位小数的金额' });
  }
  const amounts = String(value.RECHARGE_CENTER_QUICK_AMOUNTS || value.RECHARGE_CENTER_ALLOWED_AMOUNTS)
    .split(',')
    .map((entry) => parseConfiguredMoney(entry));
  if (amounts.length === 0 || amounts.length > 20 || amounts.some((entry) => entry == null || entry < minMinor || entry > maxMinor)) {
    context.addIssue({
      code: 'custom',
      path: ['RECHARGE_CENTER_QUICK_AMOUNTS'],
      message: '必须是金额范围内、最多两位小数的列表，最多 20 项'
    });
  }
  if (value.RECHARGE_CENTER_PAYMENT_MODE === 'sub2api_official') {
    const instanceIds = String(value.RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (instanceIds.length === 0 || instanceIds.length > 20 || instanceIds.some((entry) => !/^[1-9]\d{0,15}$/.test(entry))) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS'],
        message: '官方模式必须列出 1 到 20 个 Sub2API 官方支付宝通道实例 ID'
      });
    }
  }
  const alertChannels = parseList(value.RECHARGE_CENTER_ALERT_CHANNELS);
  const unknownAlertChannels = alertChannels.filter((channel) => !ALERT_CHANNEL_NAMES.has(channel));
  if (unknownAlertChannels.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['RECHARGE_CENTER_ALERT_CHANNELS'],
      message: `仅支持 email 和 webhook，未知通道: ${unknownAlertChannels.join(', ')}`
    });
  }
  if (alertChannels.includes('email')) {
    const requiredEmail = [
      ['RECHARGE_CENTER_SMTP_HOST', value.RECHARGE_CENTER_SMTP_HOST],
      ['RECHARGE_CENTER_SMTP_USER', value.RECHARGE_CENTER_SMTP_USER],
      ['RECHARGE_CENTER_SMTP_PASSWORD', value.RECHARGE_CENTER_SMTP_PASSWORD],
      ['RECHARGE_CENTER_SMTP_FROM', value.RECHARGE_CENTER_SMTP_FROM],
      ['RECHARGE_CENTER_ALERT_EMAIL_TO', value.RECHARGE_CENTER_ALERT_EMAIL_TO]
    ];
    for (const [name, configured] of requiredEmail) {
      if (!configured) context.addIssue({ code: 'custom', path: [name], message: '启用邮件告警时必须配置此项' });
    }
    if (value.RECHARGE_CENTER_SMTP_HOST &&
        (!/^[A-Za-z0-9.-]{1,253}$/.test(value.RECHARGE_CENTER_SMTP_HOST) ||
         value.RECHARGE_CENTER_SMTP_HOST.startsWith('.') || value.RECHARGE_CENTER_SMTP_HOST.endsWith('.'))) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_SMTP_HOST'], message: '必须是合法的 SMTP 主机名或 IPv4 地址' });
    }
    if (value.RECHARGE_CENTER_SMTP_FROM && !isEmailAddress(value.RECHARGE_CENTER_SMTP_FROM)) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_SMTP_FROM'], message: '必须是单个纯邮箱地址' });
    }
    const recipients = parseList(value.RECHARGE_CENTER_ALERT_EMAIL_TO);
    if (recipients.length === 0 || recipients.length > 20 || recipients.some((entry) => !isEmailAddress(entry))) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_ALERT_EMAIL_TO'], message: '必须是 1 到 20 个逗号分隔的邮箱地址' });
    }
  }
  if (alertChannels.includes('webhook')) {
    if (!value.RECHARGE_CENTER_ALERT_WEBHOOK_URL) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_ALERT_WEBHOOK_URL'], message: '启用 Webhook 告警时必须配置此项' });
    }
    if (!value.RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN || value.RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN.length < 32) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN'], message: '启用 Webhook 告警时必须配置至少 32 字符的独立 Token' });
    }
  }
  if (value.RECHARGE_CENTER_ALERT_WEBHOOK_URL) {
    const webhookUrl = new URL(value.RECHARGE_CENTER_ALERT_WEBHOOK_URL);
    if (!['http:', 'https:'].includes(webhookUrl.protocol) || webhookUrl.username || webhookUrl.password || webhookUrl.hash) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_ALERT_WEBHOOK_URL'],
        message: '必须是无 URL 凭据和片段的 HTTP(S) 地址'
      });
    }
  }
  if (value.RECHARGE_CENTER_PAYMENT_MODE === AUTO_PAYMENT_MODE) {
    const required = [
      ['RECHARGE_CENTER_LISTENER_SECRET', value.RECHARGE_CENTER_LISTENER_SECRET],
      ['RECHARGE_CENTER_LISTENER_COLLECTOR_ID', value.RECHARGE_CENTER_LISTENER_COLLECTOR_ID],
      ['RECHARGE_CENTER_ALIPAY_RECIPIENT_ID', value.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID],
      ['SUB2API_ADMIN_API_KEY', value.SUB2API_ADMIN_API_KEY],
      ['RECHARGE_CENTER_ALERT_CHANNELS', value.RECHARGE_CENTER_ALERT_CHANNELS]
    ];
    for (const [name, configured] of required) {
      if (!configured) context.addIssue({ code: 'custom', path: [name], message: '个人转账自动模式必须配置此项' });
    }
    if (value.RECHARGE_CENTER_TRANSFER_QR_SOURCE === QR_SOURCE_TEMPLATE && !value.RECHARGE_CENTER_TRANSFER_QR_TEMPLATE) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_TRANSFER_QR_TEMPLATE'],
        message: 'template 二维码来源必须配置此项'
      });
    }
    if (value.RECHARGE_CENTER_TRANSFER_QR_SOURCE === QR_SOURCE_COLLECTOR && !value.RECHARGE_CENTER_QR_PROVISIONER_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_QR_PROVISIONER_SECRET'],
        message: 'collector 二维码来源必须配置独立的二维码代理密钥'
      });
    }
    if (value.RECHARGE_CENTER_TRANSFER_QR_TEMPLATE && !validateTransferTemplate(value.RECHARGE_CENTER_TRANSFER_QR_TEMPLATE)) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_TRANSFER_QR_TEMPLATE'],
        message: '必须各包含一个 {amount} 和 {memo}，并指向支付宝协议或支付宝 HTTPS 域名'
      });
    }
    if (value.RECHARGE_CENTER_LISTENER_SECRET && value.RECHARGE_CENTER_LISTENER_SECRET.length < 32) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_LISTENER_SECRET'], message: '至少需要 32 个字符' });
    }
    if (value.RECHARGE_CENTER_QR_PROVISIONER_SECRET && value.RECHARGE_CENTER_QR_PROVISIONER_SECRET.length < 32) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_QR_PROVISIONER_SECRET'], message: '至少需要 32 个字符' });
    }
    if (value.RECHARGE_CENTER_LISTENER_COLLECTOR_ID && !/^[A-Za-z0-9_-]{3,64}$/.test(value.RECHARGE_CENTER_LISTENER_COLLECTOR_ID)) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_LISTENER_COLLECTOR_ID'], message: '只能包含字母、数字、下划线和连字符' });
    }
    if (value.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID && value.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID.length > 200) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_ALIPAY_RECIPIENT_ID'], message: '长度不能超过 200' });
    }
    if (value.SUB2API_ADMIN_API_KEY && value.SUB2API_ADMIN_API_KEY.length < 16) {
      context.addIssue({ code: 'custom', path: ['SUB2API_ADMIN_API_KEY'], message: '长度至少为 16 个字符' });
    }
    if (!alertChannels.includes('email')) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_ALERT_CHANNELS'],
        message: '个人转账自动模式必须启用 email 通道，确保异常订单发送邮件'
      });
    }
  }
  const isolatedSecrets = [
    value.RECHARGE_CENTER_SECRET,
    value.RECHARGE_CENTER_QR_PROVISIONER_SECRET,
    value.RECHARGE_CENTER_LISTENER_SECRET,
    value.SUB2API_ADMIN_API_KEY,
    value.RECHARGE_CENTER_SMTP_PASSWORD,
    value.RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN
  ].filter(Boolean);
  if (new Set(isolatedSecrets).size !== isolatedSecrets.length) {
    context.addIssue({
      code: 'custom',
      path: ['RECHARGE_CENTER_ALERT_CHANNELS'],
      message: '账本、二维码代理、到账监听、Sub2API 管理、SMTP 和 Webhook 凭据必须相互独立，不能复用'
    });
  }
  if (value.NODE_ENV === 'production') {
    const exampleSecrets = new Set([
      'replace-with-at-least-32-random-characters',
      'replace-with-at-least-48-random-characters'
    ]);
    if (value.RECHARGE_CENTER_SECRET.length < 48 || exampleSecrets.has(value.RECHARGE_CENTER_SECRET)) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_SECRET'], message: '生产环境必须使用至少 48 个字符的独立随机密钥，不能使用示例值' });
    }
    if (!value.RECHARGE_CENTER_PUBLIC_URL?.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_PUBLIC_URL'], message: '生产环境必须使用 HTTPS 公网地址' });
    }
    if (!value.SUB2API_PUBLIC_URL?.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['SUB2API_PUBLIC_URL'], message: '生产环境必须配置 Sub2API 的 HTTPS 浏览器地址' });
    }
    if (value.RECHARGE_CENTER_PAYMENT_MODE === 'personal_manual' && !value.ALIPAY_QR_IMAGE_PATH) {
      context.addIssue({ code: 'custom', path: ['ALIPAY_QR_IMAGE_PATH'], message: '生产环境必须配置收款码文件' });
    }
    if (value.RECHARGE_CENTER_PAYMENT_MODE === AUTO_PAYMENT_MODE && !value.RECHARGE_CENTER_AUTO_MODE_VERIFIED) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_AUTO_MODE_VERIFIED'],
        message: '生产启用前必须完成真实小额端到端验收并显式设置为 true'
      });
    }
    if (value.RECHARGE_CENTER_PAYMENT_MODE === AUTO_PAYMENT_MODE &&
        [
          value.RECHARGE_CENTER_LISTENER_SECRET,
          value.RECHARGE_CENTER_QR_PROVISIONER_SECRET,
          value.RECHARGE_CENTER_SMTP_PASSWORD,
          value.RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN,
          value.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID
        ].filter(Boolean).some(isObviousPlaceholder)) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_AUTO_MODE_VERIFIED'],
        message: '生产自动模式不能使用示例监听密钥、通知凭据或收款账户标识'
      });
    }
    if (alertChannels.includes('email') && !value.RECHARGE_CENTER_SMTP_SECURE && !value.RECHARGE_CENTER_SMTP_REQUIRE_TLS) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_SMTP_REQUIRE_TLS'],
        message: '生产邮件告警必须启用 SMTPS 或强制 STARTTLS'
      });
    }
    if (alertChannels.includes('webhook') && !value.RECHARGE_CENTER_ALERT_WEBHOOK_URL?.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        path: ['RECHARGE_CENTER_ALERT_WEBHOOK_URL'],
        message: '生产 Webhook 告警必须使用 HTTPS'
      });
    }
    if (value.RECHARGE_CENTER_PAYMENT_MODE === AUTO_PAYMENT_MODE &&
        !/^admin-[a-f0-9]{64}$/.test(value.SUB2API_ADMIN_API_KEY || '')) {
      context.addIssue({
        code: 'custom',
        path: ['SUB2API_ADMIN_API_KEY'],
        message: '生产自动模式必须使用当前 Sub2API 生成的 admin- 前缀 64 位十六进制管理员 API Key'
      });
    }
    if (value.RECHARGE_CENTER_COOKIE_SECURE === false) {
      context.addIssue({ code: 'custom', path: ['RECHARGE_CENTER_COOKIE_SECURE'], message: '生产环境不能关闭 Secure Cookie' });
    }
  }
});

function normalizeBaseUrl(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`recharge-center 配置无效: ${name}: 必须是不含账号、查询参数和片段的 HTTP(S) 地址`);
  }
  return url.toString().replace(/\/$/, '');
}

function loadConfig(env = process.env, options = {}) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`recharge-center 配置无效: ${message}`);
  }
  const value = parsed.data;
  const dataDir = path.resolve(options.projectRoot || process.cwd(), value.RECHARGE_CENTER_DATA_DIR);
  const minAmountMinor = parseConfiguredMoney(value.RECHARGE_CENTER_MIN_AMOUNT);
  const maxAmountMinor = parseConfiguredMoney(value.RECHARGE_CENTER_MAX_AMOUNT);
  const quickAmounts = [...new Set(String(value.RECHARGE_CENTER_QUICK_AMOUNTS || value.RECHARGE_CENTER_ALLOWED_AMOUNTS)
    .split(',')
    .map((entry) => parseConfiguredMoney(entry)))]
    .sort((a, b) => a - b);
  const publicUrl = value.RECHARGE_CENTER_PUBLIC_URL
    ? normalizeBaseUrl(value.RECHARGE_CENTER_PUBLIC_URL, 'RECHARGE_CENTER_PUBLIC_URL')
    : null;
  const sub2apiBaseUrl = normalizeBaseUrl(value.SUB2API_BASE_URL, 'SUB2API_BASE_URL');
  const sub2apiPublicUrl = value.SUB2API_PUBLIC_URL
    ? normalizeBaseUrl(value.SUB2API_PUBLIC_URL, 'SUB2API_PUBLIC_URL')
    : sub2apiBaseUrl;
  const automaticPersonalMode = value.RECHARGE_CENTER_PAYMENT_MODE === AUTO_PAYMENT_MODE;
  const alertChannels = parseList(value.RECHARGE_CENTER_ALERT_CHANNELS);
  return {
    env: value.NODE_ENV,
    port: value.PORT,
    bindHost: value.RECHARGE_CENTER_BIND_HOST,
    projectRoot: path.resolve(options.projectRoot || path.join(__dirname, '..')),
    dataDir,
    databasePath: path.resolve(value.RECHARGE_CENTER_DATABASE || path.join(dataDir, 'recharge-center.db')),
    secret: value.RECHARGE_CENTER_SECRET,
    publicUrl,
    publicOrigin: publicUrl ? new URL(publicUrl).origin : null,
    trustProxy: value.RECHARGE_CENTER_TRUST_PROXY,
    cookieSecure: value.RECHARGE_CENTER_COOKIE_SECURE ?? value.NODE_ENV === 'production',
    passwordLoginEnabled: value.RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED ?? value.NODE_ENV !== 'production',
    sessionTtlMinutes: value.RECHARGE_CENTER_SESSION_TTL_MINUTES,
    orderTtlMinutes: automaticPersonalMode ? AUTO_ORDER_TTL_MINUTES : value.RECHARGE_CENTER_ORDER_TTL_MINUTES,
    reviewTtlHours: value.RECHARGE_CENTER_REVIEW_TTL_HOURS,
    fulfillmentLeaseMinutes: value.RECHARGE_CENTER_FULFILLMENT_LEASE_MINUTES,
    paymentMode: value.RECHARGE_CENTER_PAYMENT_MODE,
    automaticPersonalMode,
    quickAmounts: quickAmounts.map((minor) => minor / 100),
    allowedAmounts: quickAmounts.map((minor) => minor / 100),
    minAmount: minAmountMinor / 100,
    maxAmount: maxAmountMinor / 100,
    officialPollSeconds: value.RECHARGE_CENTER_OFFICIAL_POLL_SECONDS,
    officialPollConcurrency: value.RECHARGE_CENTER_OFFICIAL_POLL_CONCURRENCY,
    officialAlipayInstanceIds: String(value.RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    maxActiveOrders: value.RECHARGE_CENTER_MAX_ACTIVE_ORDERS,
    qrImagePath: value.ALIPAY_QR_IMAGE_PATH ? path.resolve(value.ALIPAY_QR_IMAGE_PATH) : null,
    qrMaxBytes: value.ALIPAY_QR_MAX_BYTES,
    transferQrSource: value.RECHARGE_CENTER_TRANSFER_QR_SOURCE,
    collectorQrProvisioning: automaticPersonalMode && value.RECHARGE_CENTER_TRANSFER_QR_SOURCE === QR_SOURCE_COLLECTOR,
    transferQrTemplate: value.RECHARGE_CENTER_TRANSFER_QR_TEMPLATE || null,
    qrJobLeaseSeconds: value.RECHARGE_CENTER_QR_JOB_LEASE_SECONDS,
    qrProvisionerSecret: value.RECHARGE_CENTER_QR_PROVISIONER_SECRET || null,
    listenerSecret: value.RECHARGE_CENTER_LISTENER_SECRET || null,
    listenerCollectorId: value.RECHARGE_CENTER_LISTENER_COLLECTOR_ID || null,
    listenerMaxStaleSeconds: value.RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS,
    listenerSignatureToleranceSeconds: value.RECHARGE_CENTER_LISTENER_SIGNATURE_TOLERANCE_SECONDS,
    listenerMaxEventAgeSeconds: value.RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS,
    alipayRecipientId: value.RECHARGE_CENTER_ALIPAY_RECIPIENT_ID || null,
    autoModeVerified: value.RECHARGE_CENTER_AUTO_MODE_VERIFIED,
    autoReservationLimit: 100,
    sub2apiBaseUrl,
    sub2apiPublicUrl,
    sub2apiOrigin: new URL(sub2apiPublicUrl).origin,
    sub2apiRequestTimeoutMs: value.SUB2API_REQUEST_TIMEOUT_MS,
    sub2apiAdminApiKey: value.SUB2API_ADMIN_API_KEY || null,
    forwardClientFingerprint: value.SUB2API_FORWARD_CLIENT_FINGERPRINT,
    alertChannels,
    alertTimeoutMs: value.RECHARGE_CENTER_ALERT_TIMEOUT_MS,
    smtpHost: value.RECHARGE_CENTER_SMTP_HOST || null,
    smtpPort: value.RECHARGE_CENTER_SMTP_PORT,
    smtpSecure: value.RECHARGE_CENTER_SMTP_SECURE,
    smtpRequireTls: value.RECHARGE_CENTER_SMTP_REQUIRE_TLS,
    smtpUser: value.RECHARGE_CENTER_SMTP_USER || null,
    smtpPassword: value.RECHARGE_CENTER_SMTP_PASSWORD || null,
    smtpFrom: value.RECHARGE_CENTER_SMTP_FROM || null,
    alertEmailTo: parseList(value.RECHARGE_CENTER_ALERT_EMAIL_TO),
    alertWebhookUrl: value.RECHARGE_CENTER_ALERT_WEBHOOK_URL || null,
    alertWebhookBearerToken: value.RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN || null
  };
}

module.exports = {
  AUTO_ORDER_TTL_MINUTES,
  AUTO_PAYMENT_MODE,
  QR_SOURCE_COLLECTOR,
  QR_SOURCE_TEMPLATE,
  loadConfig,
  validateTransferTemplate
};
