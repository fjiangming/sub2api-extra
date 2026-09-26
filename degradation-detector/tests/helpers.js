'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, validateTestConfig } = require('../src/config');

const defaultTests = {
  openai: {
    label: 'OpenAI',
    model: 'gpt-test',
    api: 'responses',
    prompt: 'Return a complete HTML document.',
    output_type: 'html',
    validation: {
      min_bytes: 20,
      required_patterns: ['<html(?:\\s|>)']
    }
  },
  anthropic: {
    label: 'Anthropic',
    model: 'claude-test',
    api: 'anthropic_messages',
    prompt: 'Return 1161.',
    output_type: 'text',
    validation: { required_patterns: ['^1161$'] }
  }
};

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-detector-'));
  t?.after(() => {
    const remove = (attempts = 20) => {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        if (error.code === 'EPERM' && attempts > 0) {
          setTimeout(() => remove(attempts - 1), 25);
          return;
        }
        throw error;
      }
    };
    remove();
  });
  return directory;
}

function testConfig(t, overrides = {}) {
  const dataDir = overrides.dataDir || temporaryDirectory(t);
  return loadConfig({
    NODE_ENV: 'test',
    DEGRADATION_DETECTOR_DATA_DIR: dataDir,
    SUB2API_BASE_URL: 'https://sub2api.example.test',
    DEGRADATION_DETECTOR_SCHEDULER_POLL_SECONDS: '5',
    ...overrides.env
  });
}

function seedRuntime(runtime, groups, tests = defaultTests) {
  const platforms = [...new Set(groups.map((group) => group.platform))];
  runtime.store.saveAdminConfiguration({
    scheduleMode: 'daily',
    scheduleTimes: ['09:30'],
    scheduleIntervalMinutes: 60,
    scheduleTimezone: runtime.config.scheduleTimezone,
    updatedBy: 'test-admin',
    serviceOwnerId: runtime.config.serviceOwnerId,
    platforms: platforms.map((platform) => ({
      id: platform,
      enabled: true,
      test: validateTestConfig(platform, tests[platform]),
      groups: []
    })),
    groups: groups.map((group, index) => {
      const key = group.key || `sk-test-dedicated-${group.id}-${index}-1234567890`;
      return {
        id: String(group.id),
        name: group.name,
        platform: group.platform,
        keyCipher: runtime.vault.encrypt(group.id, key),
        keyFingerprint: runtime.vault.fingerprint(key)
      };
    })
  });
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }
  };
}

module.exports = { defaultTests, listen, seedRuntime, temporaryDirectory, testConfig };
