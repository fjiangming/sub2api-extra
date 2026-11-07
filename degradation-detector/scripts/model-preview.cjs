'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { loadConfig } = require('../src/config');
const { defaultModelPlatform, modelGroupContext } = require('../src/model-config');
const { demoModelResponse } = require('../src/model-detection');

async function createPreview(port = 19895) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-model-preview-'));
  const config = loadConfig({ NODE_ENV: 'development', DEGRADATION_DETECTOR_DEMO_MODE: 'true', DEGRADATION_DETECTOR_DATA_DIR: directory });
  let outboundCalls = 0;
  const rejectNetwork = async () => { outboundCalls++; throw new Error('Preview cannot access upstream services'); };
  const { app, runtime } = createApp(config, {
    startScheduler: false, fetchImpl: rejectNetwork,
    modelDependencies: { request: rejectNetwork, resolve: rejectNetwork, pollMs: 20 }
  });
  runtime.modelStore.save({
    schedule: { enabled: false, mode: 'daily', times: ['09:30', '21:30'], interval_minutes: 360 },
    platforms: [['openai', '8', 'GPT｜不降智｜官Key', 'gpt-5'], ['anthropic', '2', 'Claude｜企业', 'claude-sonnet-4-5']].map(([id, groupId, name, model]) => {
      const settings = defaultModelPlatform(id, model);
      settings.enabled = true;
      settings.target_url = 'https://relay.example.com';
      for (const channel of ['bazaarlink', 'cctest']) {
        const item = settings.channels[channel];
        item.enabled = true;
        item.check_token_usage = channel === 'cctest';
        item.key_context = `model-site:${id}:${channel}`;
        item.key_cipher = runtime.vault.encrypt(item.key_context, `cct-demo-site-${id}-${channel}`);
        item.key_fingerprint = runtime.vault.fingerprint(`cct-demo-site-${id}-${channel}`);
      }
      const key = `sk-demo-model-only-${groupId}-1234567890`;
      return { id, config: settings, groups: [{ id: groupId, name, enabled: true, keyCipher: runtime.vault.encrypt(modelGroupContext(groupId), key), keyFingerprint: runtime.vault.fingerprint(key), models: {} }] };
    })
  });
  for (const group of runtime.modelStore.enabledGroups()) {
    for (let i = 0; i < 3; i++) {
      for (const channel of ['bazaarlink', 'cctest']) {
        const run = runtime.modelStore.create(group, channel, i ? 'manual' : 'scheduled');
        runtime.modelStore.markRunning(run.id);
        runtime.modelStore.updateResponse(run.id, demoModelResponse(channel, run.model, group.platform), 'completed');
        runtime.modelStore.finish(run.id, 'completed');
      }
    }
  }
  runtime.scheduler.start();
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return {
    runtime, baseUrl: `http://127.0.0.1:${server.address().port}`, get outboundCalls() { return outboundCalls; },
    async close() {
      server.close(); server.closeAllConnections?.();
      await runtime.scheduler.close(); runtime.auth.close(); await runtime.groupMetrics.close(); runtime.store.close();
      const target = path.resolve(directory);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('sub2api-model-preview-')) throw new Error('Unexpected preview directory');
      fs.rmSync(target, { recursive: true, force: true });
    }
  };
}

if (require.main === module) {
  createPreview(Number(process.env.PORT || 19895)).then(preview => {
    console.log(`管理员配置：${preview.baseUrl}/admin/config?demo=1`);
    console.log(`只读检测结果：${preview.baseUrl}/results?demo=readonly#model`);
    console.log('独立临时数据，所有上游请求已禁用。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createPreview };
