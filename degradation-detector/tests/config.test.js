'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  defaultPlatformTest,
  loadConfig,
  validateAdminConfiguration,
  validateTestConfig
} = require('../src/config');
const { defaultTests, temporaryDirectory } = require('./helpers');

function env(t, overrides = {}) {
  return {
    NODE_ENV: 'test',
    DEGRADATION_DETECTOR_DATA_DIR: temporaryDirectory(t),
    SUB2API_BASE_URL: 'https://sub2api.example.test/',
    ...overrides
  };
}

test('runtime configuration only requires the Sub2API connection', (t) => {
  const config = loadConfig(env(t, {
    DEGRADATION_DETECTOR_TESTS_JSON: '{this-is-ignored',
    DEGRADATION_DETECTOR_GROUP_KEYS_JSON: '{also-ignored'
  }));
  assert.equal(config.sub2apiBaseUrl, 'https://sub2api.example.test');
  assert.equal(config.scheduleTimezone, 'Asia/Shanghai');
  assert.equal(config.concurrency, 2);
  assert.equal(config.requestTimeoutMs, 30 * 60 * 1000);
  assert.equal(config.tests, undefined);
  assert.equal(config.groupKeys, undefined);
});

test('production requires a valid Sub2API URL and rejects demo mode', (t) => {
  assert.throws(() => loadConfig(env(t, {
    NODE_ENV: 'production',
    SUB2API_BASE_URL: ''
  })), /必须配置 SUB2API_BASE_URL/);
  assert.throws(() => loadConfig(env(t, {
    NODE_ENV: 'production',
    DEGRADATION_DETECTOR_DEMO_MODE: 'true'
  })), /生产环境禁止/);
  assert.throws(() => loadConfig(env(t, {
    SUB2API_BASE_URL: 'file:///etc/passwd'
  })), /不支持的 URL 协议/);
});

test('platform test validation covers regex and protocol-output combinations', () => {
  const parsed = validateTestConfig('openai', defaultTests.openai);
  assert.equal(parsed.output_type, 'html');
  assert.equal(parsed.max_output_tokens, 16384);
  assert.equal(validateTestConfig('openai', {
    ...defaultTests.openai,
    reasoning_effort: 'max'
  }).reasoning_effort, 'max');

  const invalidRegex = structuredClone(defaultTests.openai);
  invalidRegex.validation.required_patterns = ['['];
  assert.throws(() => validateTestConfig('openai', invalidRegex), /无效检测正则/);

  const invalidImage = structuredClone(defaultTests.openai);
  invalidImage.api = 'anthropic_messages';
  invalidImage.output_type = 'image';
  assert.throws(() => validateTestConfig('openai', invalidImage), /image 输出只支持/);
});

test('administrator configuration rejects duplicates and disabled-platform groups', () => {
  const openai = defaultPlatformTest('openai');
  assert.throws(() => validateAdminConfiguration({
    schedule_time: '25:00',
    platforms: []
  }), /schedule_time/);
  assert.throws(() => validateAdminConfiguration({
    schedule_time: '09:30',
    platforms: [
      { id: 'openai', enabled: true, test: openai, groups: [{ id: '1', enabled: true, key: 'sk-test-dedicated-123456' }] },
      { id: 'openai', enabled: true, test: openai, groups: [] }
    ]
  }), /平台配置不能重复/);
  assert.throws(() => validateAdminConfiguration({
    schedule_time: '09:30',
    platforms: [
      { id: 'openai', enabled: false, test: openai, groups: [{ id: '1', enabled: true }] }
    ]
  }), /平台未启用/);

  const interval = validateAdminConfiguration({
    schedule_mode: 'interval',
    schedule_times: ['18:30', '08:15'],
    schedule_interval_minutes: 90,
    platforms: []
  });
  assert.equal(interval.schedule_mode, 'interval');
  assert.deepEqual(interval.schedule_times, ['08:15', '18:30']);
  assert.equal(interval.schedule_interval_minutes, 90);

  assert.throws(() => validateAdminConfiguration({
    schedule_mode: 'daily',
    schedule_times: ['09:00', '09:00'],
    schedule_interval_minutes: 60,
    platforms: []
  }), /不能重复/);
  assert.throws(() => validateAdminConfiguration({
    schedule_mode: 'interval',
    schedule_times: ['09:00'],
    schedule_interval_minutes: 0,
    platforms: []
  }), /schedule_interval_minutes/);
});

test('default platform templates cover known and generic platforms', () => {
  assert.equal(defaultPlatformTest('openai').api, 'responses');
  assert.equal(defaultPlatformTest('anthropic').api, 'anthropic_messages');
  assert.equal(defaultPlatformTest('gemini').api, 'gemini_generate_content');
  assert.equal(defaultPlatformTest('custom').api, 'chat_completions');
});

test('.env.example contains only the Sub2API connection variable', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const variables = content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')));
  assert.deepEqual(variables, ['SUB2API_BASE_URL']);
  assert.doesNotMatch(content, /GROUP_KEYS|SUPPORTED_PLATFORMS|TESTS_JSON|INTERVAL_SECONDS/);
});
