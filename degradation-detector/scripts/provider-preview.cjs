'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPreview: createModelPreview } = require('./model-preview.cjs');
const { defaultConfiguration, channels } = require('../src/provider-config');
const { demoResponse } = require('../src/provider-detection');

async function createPreview(port = 19961) {
  const preview = await createModelPreview(port);
  const runtime = preview.runtime;
  let providerCalls = 0;
  const deny = async () => { providerCalls++; throw new Error('Provider preview cannot access the network'); };
  runtime.providerDetection.request = deny;
  runtime.providerDetection.events = deny;
  runtime.providerDetection.resolve = deny;
  const groups = [{ id: '8', name: 'GPT｜不降智｜官Key', platform: 'openai' }, { id: '2', name: 'Claude｜企业', platform: 'anthropic' }, { id: '40', name: 'Gemini｜专属定制', platform: 'gemini' }];
  const input = { revision: 0, ...defaultConfiguration(), groups: [] };
  for (const provider of Object.values(input.providers)) provider.enabled = true;
  for (const channel of channels) {
    const settings = input.channels[channel];
    settings.enabled = true;
    settings.defaults.target_url = 'https://relay.example.com/v1';
    settings.schedule = { enabled: true, mode: 'daily', times: ['09:30', '21:30'], interval_minutes: 360 };
    for (const group of groups.filter(group => channel !== 'testllm' || group.platform !== 'gemini')) input.groups.push({ id: group.id, channel, enabled: true, override: null, key: `sk-preview-provider-${channel}-${group.id}-123456` });
  }
  const prepared = runtime.providerDetection.prepareConfiguration(input, groups);
  runtime.providerStore.save(prepared.input, prepared.groups);
  const artwork = fs.readFileSync(path.join(__dirname, 'provider-preview-artwork.html'), 'utf8');
  for (const group of runtime.providerStore.groups()) {
    for (let i = 0; i < 28; i++) {
      const run = runtime.providerStore.create(group, 'demo');
      const value = demoResponse(group.channel);
      if (group.channel === 'pelican') { value.result.html = artwork; if (i % 7 === 0) value.assessment.quality = 'degraded'; }
      if (group.channel === 'candy' && i % 6 === 0) { value.candy.status = 'incorrect'; value.candy.answer = '8'; }
      if (group.channel === 'testllm') { value.iq.level = group.platform === 'anthropic' ? 'high' : 'excellent'; value.iq.duration = 8 + i / 10; }
      const timestamp = Date.now() - (27 - i) * 3600000;
      runtime.providerStore.response(run.id, value);
      runtime.providerStore.finish(run.id, i % 11 === 0 ? 'error' : 'completed', '演示记录，未调用真实检测网站');
      runtime.store.db.prepare('UPDATE degradation_provider_runs SET created_at=?,started_at=?,finished_at=?,duration_ms=42000 WHERE id=?').run(timestamp, timestamp, timestamp + 42000, run.id);
    }
  }
  return { ...preview, get outboundCalls() { return preview.outboundCalls; }, get providerCalls() { return providerCalls; } };
}

if (require.main === module) createPreview(Number(process.env.PORT || 19961)).then(preview => {
  console.log(`降智检测：${preview.baseUrl}/results?demo=readonly`);
  console.log(`独立管理：${preview.baseUrl}/admin/config?demo=1`);
  console.log('正式页面、临时 SQLite、虚构检测记录、禁用真实外部请求。');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { createPreview };
