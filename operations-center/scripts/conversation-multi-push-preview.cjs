'use strict';

const crypto = require('node:crypto');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { s3Receiver } = require('../tests/conversation-s3-fixture');
const { event } = require('../tests/conversation-logs-fixture');
const { defaultStorageRates } = require('../src/services/conversation-push-policy');

async function startMultiPreview({ port = Number(process.env.CONVERSATION_PREVIEW_PORT || 20023) } = {}) {
  const primary = await s3Receiver(), replica = await s3Receiver();
  let preview, closed = false;
  const stop = async () => {
    if (closed) return; closed = true;
    await preview?.stop(); await primary.close(); await replica.close();
  };
  try {
    preview = await startPreview({ port });
    const policy = preview.push.store.policy(), billing = { enabled: true, rates: defaultStorageRates };
    const s3 = { ...policy.s3, enabled: true, name: 'S3 主存储', endpoint: primary.url, bucket: 'preview-primary',
      accessKeyId: 'fictional-preview-key', secretAccessKey: 'fictional-preview-secret', billing,
      jsonl: { ...policy.s3.jsonl, uploadMiBPerSecond: 64 } };
    preview.push.configure({ ...policy, enabled: true, automatic: false, allowPrivateNetwork: true, s3,
      webhook: { ...policy.webhook, enabled: true, name: 'Webhook 接收端', url: primary.url + '/logs', billing },
      platforms: [{ ...s3, id: 'preview-replica', type: 's3', name: 'S3 备份存储', endpoint: replica.url, bucket: 'preview-replica',
        billing: { enabled: true, rates: defaultStorageRates.map(row => ({ ...row, price: row.model === 'gpt-6.2-sol' ? '60000' : row.price })) } }] });
    for (const [index, model] of ['gpt-6.2-sol', 'claude-opus-5-5', 'fable-5-2'].entries()) {
      const row = event('multi-preview-' + index, { model,
        request: Buffer.from(JSON.stringify({ model, input: 'Fictional local preview. '.repeat(4000) })).toString('base64') });
      preview.fixture.store.ingest(row);
      const input = { filter: { search: row.id }, destinations: ['s3', 'webhook', 'preview-replica'] };
      const plan = preview.push.preview(input);
      preview.push.enqueue({ ...input, batchId: crypto.randomUUID(), previewToken: plan.previewToken });
    }
    const deadline = Date.now() + 20000;
    while (preview.push.store.billing.report().summary.files < 9) {
      if (Date.now() >= deadline) throw new Error('Preview delivery did not complete');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ...preview, stop };
  } catch (error) { await stop(); throw error; }
}

if (require.main === module) startMultiPreview().then(preview => {
  console.log(`Multi-platform formal-page preview (fictional local data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.stop().then(() => process.exit(0)));
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { startMultiPreview };
